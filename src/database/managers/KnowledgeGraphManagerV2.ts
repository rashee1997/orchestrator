import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

import { JsonlStorageManager } from '../storage/JsonlStorageManager.js';
import { EventStore } from '../storage/EventStore.js';
import { IndexManager } from '../storage/IndexManager.js';
import { QueryEngine } from '../query/QueryEngine.js';
import { FuzzySearchEngine } from '../search/FuzzySearchEngine.js';
import { KnowledgeGraphCache } from '../cache/KnowledgeGraphCache.js';
import { EntityResolver } from '../ai/EntityResolver.js';
import { NLPQueryProcessor } from '../ai/NLPQueryProcessor.js';
import { GeminiIntegrationService } from '../services/GeminiIntegrationService.js';
import type { QueryAST, NlpStructuredQuery, ParsedComplexQuery } from '../../types/query.js';
import { createCanonicalAbsPathKey } from '../../tools/knowledge_graph_tools.js';
import { parseGeminiJsonResponse as centralParseGeminiJsonResponse } from '../services/gemini-integration-modules/GeminiResponseParsers.js';

/**
 * Prompt template for translating natural language queries into structured graph queries using an AI model.
 */
const NLP_QUERY_PROMPT_TEMPLATE = `You are an expert in translating natural language questions about software codebases into a structured query for a knowledge graph.
The knowledge graph contains nodes representing files, directories, functions, classes, interfaces, modules, and variables.
Node observations often include 'absolute_path', 'language', 'signature', 'lines', 'defined_in_file'.
Key relation types include: 'contains_item', 'imports_file', 'imports_module', 'defined_in_file', 'has_method', 'calls_function', 'uses_class'.

Given a natural language query, translate it into a JSON array of operation objects. Each object must have an "operation" and "args" field.

Supported operations and their 'args' structure:
1. 'search_nodes': args = { "query": "key:value key2:value2 ..." }
   - The "query" string uses key:value pairs. Supported keys: 'entityType', 'name', 'file', 'obs', 'id', 'limit', 'defined_in_file_path', 'parent_class_full_name'.
   - This is for finding nodes based on their properties.
   - Example NLQ: "Find all functions in 'src/utils.ts' that mention 'format'"
   - Translation: [{ "operation": "search_nodes", "args": { "query": "entityType:function file:src/utils.ts obs:format" } }]

2. 'open_nodes': args = { "names": ["exact_node_name1", "exact_node_name2"] }
   - Use for fetching specific nodes by their exact names.

3. 'graph_traversal': args = { "start_node": "node_name", "relation_types": ["relation1"], "depth": number }
   - Use for FORWARD (OUTGOING) traversal from a starting node.
   - Answers questions like "What does X call?", "What does Y import?".
   - Example NLQ: "What functions does 'AuthService' call?"
   - Translation: [{ "operation": "graph_traversal", "args": { "start_node": "AuthService", "relation_types": ["calls_function"], "depth": 1 } }]

4. 'find_inbound_relations': args = { "target_node_name": "node_name", "relation_type": "relation_name" }
   - Use for INVERSE (INCOMING) traversal to find source nodes.
   - Answers questions like "Who calls X?", "Which files import Y?", "Where is Z used?".
   - Example NLQ: "Who calls the 'processAndRefinePrompt' function?"
   - Translation: [{ "operation": "find_inbound_relations", "args": { "target_node_name": "processAndRefinePrompt", "relation_type": "calls_function" } }]
   - Example NLQ: "Which files import 'CodebaseContextRetrieverService'?"
   - Translation: [{ "operation": "find_inbound_relations", "args": { "target_node_name": "CodebaseContextRetrieverService", "relation_type": "imports_file" } }]

5. 'read_graph': args = {}
   - Use only if the query is very general like "show me the graph".

Knowledge Graph Structure (or summary):
---
\${graphRepresentation}
---

Natural Language Query: "\${naturalLanguageQuery}"

---
Instructions for translation:
1. Analyze the NLQ and choose the most appropriate "operation(s)".
2. If the query asks about what a node DOES (e.g., calls, contains, imports), use 'graph_traversal'.
3. If the query asks about WHO acts upon a node (e.g., callers of, importers of, users of), use 'find_inbound_relations'.
4. If a query asks for multiple distinct items (e.g., "Find class A and function B"), break it down into multiple separate operations in the array.
   - Example NLQ: "Show me the GeminiApiClient class and the batchAskGemini method"
   - Translation: [{ "operation": "open_nodes", "args": { "names": ["GeminiApiClient"] } }, { "operation": "open_nodes", "args": { "names": ["batchAskGemini"] } }]
5. If the query asks for a process description, implementation details, or "how" something works (e.g., "how are API keys managed?"), it requires code analysis beyond simple graph lookups. In this case, return a single error operation.
   - Example NLQ: "how are API keys managed in GeminiApiClient?"
   - Translation: [{ "operation": "error", "args": { "message": "Could not translate query: This query requires code analysis of implementation details. Consider using a RAG tool like 'ask_gemini' with codebase context." } }]
6. If the query cannot be reasonably translated for other reasons, return a single error operation:
   [{ "operation": "error", "args": { "message": "Could not translate query: [brief explanation]" } }]

Translate the above Natural Language Query into the structured JSON array format. Provide ONLY the JSON array.
`;

export class KnowledgeGraphManagerV2 {
    private jsonlStorage: JsonlStorageManager;
    private eventStore: EventStore;
    private indexManager: IndexManager;
    private cache: KnowledgeGraphCache;
    private queryEngine: QueryEngine;
    private fuzzySearchEngine: FuzzySearchEngine;
    private entityResolver: EntityResolver;
    private nlpQueryProcessor: NLPQueryProcessor;
    private geminiService?: GeminiIntegrationService;

    private readonly MAX_PROMPT_GRAPH_LENGTH = 150000; // Max chars for graph representation in prompt

    private static readonly MERMAID_STYLES: Record<string, string> = {
        file: 'fill:#f9f,stroke:#333,stroke-width:2px',
        directory: 'fill:#bbf,stroke:#333,stroke-width:2px',
        function: 'fill:#bfb,stroke:#333,stroke-width:2px',
        class: 'fill:#ffb,stroke:#333,stroke-width:2px',
        interface: 'fill:#bff,stroke:#333,stroke-width:2px',
        module: 'fill:#fbf,stroke:#333,stroke-width:2px',
        variable: 'fill:#eee,stroke:#333,stroke-width:2px',
        default: 'fill:#fff,stroke:#333,stroke-width:2px'
    };
    private static readonly MERMAID_SHAPES: Record<string, [string, string]> = {
        file: ['[', ']'],
        directory: ['([', '])'],
        function: ['(', ')'],
        class: ['{{', '}}'],
        interface: ['[', ']'],
        module: ['{{', '}}'],
        variable: ['(', ')'],
        default: ['[', ']']
    };

    constructor(rootPath?: string, geminiService?: GeminiIntegrationService) {
        if (!rootPath) {
            const __filename = fileURLToPath(import.meta.url);
            const __dirname = path.dirname(__filename);
            const projectRoot = path.resolve(__dirname, '..', '..', '..'); // Adjust based on actual file location
            rootPath = path.join(projectRoot, 'knowledge_graphs');
        }
        this.jsonlStorage = new JsonlStorageManager(rootPath);
        this.eventStore = new EventStore(this.jsonlStorage);
        this.indexManager = new IndexManager(this.jsonlStorage);
        this.cache = new KnowledgeGraphCache();
        this.queryEngine = new QueryEngine(this.jsonlStorage);
        this.fuzzySearchEngine = new FuzzySearchEngine();
        this.entityResolver = new EntityResolver();
        this.nlpQueryProcessor = new NLPQueryProcessor();
        this.geminiService = geminiService;
        console.log(`[KGManagerV2] Initialized. Root path: ${rootPath}`);
    }

    private getAgentNodesPath(agentId: string): string {
        return path.join(agentId, 'nodes.jsonl');
    }

    private getAgentRelationsPath(agentId: string): string {
        return path.join(agentId, 'relations.jsonl');
    }

    async createEntities(agentId: string, entities: Array<{ name: string; entityType: string; observations?: string[] }>): Promise<any[]> {
        console.log(`[KGManagerV2.createEntities] Agent: ${agentId}, Entities count: ${entities.length}`);
        const createdEntities = [];
        for (const entity of entities) {
            const newNode = {
                id: randomUUID(),
                agentId,
                name: entity.name,
                entityType: entity.entityType,
                observations: entity.observations || [],
                timestamp: Date.now(),
                version: 1
            };
            await this.jsonlStorage.appendLine(this.getAgentNodesPath(agentId), newNode);
            await this.eventStore.appendEvent(agentId, 'NODE_CREATED', { nodeId: newNode.id, name: newNode.name, entityType: newNode.entityType });
            createdEntities.push(newNode);
        }

        this.cache.invalidateAgent(agentId);
        await this.indexManager.rebuildAllIndexes(agentId);
        console.log(`[KGManagerV2.createEntities] Created ${createdEntities.length} entities for agent ${agentId}.`);
        return createdEntities;
    }

    /**
     * Helper to strip a file path prefix from a symbol name.
     * e.g., "path/to/file.php::MyClass" -> "MyClass"
     */
    private _stripFilePrefix(s: string): string {
        const idx = s.indexOf('::');
        if (idx === -1) return s;
        const before = s.substring(0, idx);
        // if "before" looks like a path (contains '/' or '\') then treat as file prefix
        if (before.includes('/') || before.includes('\\')) {
            return s.substring(idx + 2);
        }
        return s;
    }

    /**
     * Helper to normalize namespace separators and leading slashes.
     * e.g., " \My\\Class " -> "My\Class"
     */
    private _normalizeNamespace(s: string): string {
        let t = s.trim();
        if (t.startsWith('\\')) t = t.slice(1);
        // unify double backslashes to single for matching purposes
        t = t.replace(/\\\\/g, '\\');
        return t;
    };

    /**
     * Tries to resolve a raw string name to an existing node ID using robust heuristics.
     * This is crucial for linking relations correctly when names might be ambiguous (e.g., short class names).
     * @param rawName The raw name string to resolve.
     * @param nameToIdMap A map of existing node names to their IDs.
     * @param allNodeNames An array of all existing node names.
     * @returns The resolved node ID or undefined.
     */
    private _resolveEndpoint(rawName: string, nameToIdMap: Map<string, string>, allNodeNames: string[]): string | undefined {
        if (!rawName) return undefined;
        const original = rawName;

        // 1. Exact match first
        let id = nameToIdMap.get(original);
        if (id) return id;

        // 2. Strip file prefix like "path::Name" and retry
        const noFilePrefix = this._stripFilePrefix(original);
        if (noFilePrefix !== original) {
            id = nameToIdMap.get(noFilePrefix);
            if (id) return id;
        }

        // 3. Normalize namespace slashes/leading slash and retry
        const nsNorm = this._normalizeNamespace(original);
        if (nsNorm !== original) {
            id = nameToIdMap.get(nsNorm);
            if (id) return id;
        }

        // 4. If it looks like "Class::member", try to resolve the class part.
        const memberMatch = noFilePrefix.match(/^([^:]+)::(.+)$/);
        if (memberMatch) {
            const shortClass = this._normalizeNamespace(memberMatch[1]);
            const member = memberMatch[2];
            // Prefer exact FQCN::member names
            const candidates = allNodeNames.filter(n =>
                n.endsWith(`\\${shortClass}::${member}`) || n === `${shortClass}::${member}`
            );
            if (candidates.length === 1) return nameToIdMap.get(candidates[0]);

            // Fallback: try exact member name if unique (rare but possible)
            const memberOnly = allNodeNames.filter(n => n.endsWith(`::${member}`));
            if (memberOnly.length === 1) return nameToIdMap.get(memberOnly[0]);
        }

        // 5. If it's a short class/function name, try unique suffix match on FQCN
        const short = this._normalizeNamespace(noFilePrefix);
        const suffixCandidates = allNodeNames.filter(n =>
            n.endsWith(`\\${short}`) || n === short
        );
        if (suffixCandidates.length === 1) return nameToIdMap.get(suffixCandidates[0]);

        // 6. Last attempt: re-assemble FQCN::member from a uniquely resolved class FQCN
        if (memberMatch) {
            const shortClass = this._normalizeNamespace(memberMatch[1]);
            const member = memberMatch[2];
            // Find class entities (not members) that end with \ShortClass
            const classCandidates = allNodeNames.filter(n =>
                (n.endsWith(`\\${shortClass}`) || n === shortClass) && !n.includes('::')
            );
            if (classCandidates.length === 1) {
                const attempt = `${classCandidates[0]}::${member}`;
                id = nameToIdMap.get(attempt);
                if (id) return id;
            }
        }

        return undefined;
    }

    async createRelations(agentId: string, relations: Array<{ from: string; to: string; relationType: string }>): Promise<any[]> {
        console.log(`[KGManagerV2.createRelations] Agent: ${agentId}, Relations count: ${relations.length}`);
        const createdRelations: any[] = [];
        const nodes = await this.jsonlStorage.readAllLines(this.getAgentNodesPath(agentId));
        const activeNodes = nodes.filter((n: any) => n && !n.deleted);

        const nameToIdMap = new Map<string, string>(activeNodes.map((node: any) => [String(node.name), String(node.id)]));
        const allNames: string[] = activeNodes.map((n: any) => String(n.name));

        for (const relation of relations) {
            const fromNodeId = this._resolveEndpoint(relation.from, nameToIdMap, allNames);
            const toNodeId = this._resolveEndpoint(relation.to, nameToIdMap, allNames);

            if (!fromNodeId || !toNodeId) {
                console.warn(`[KGManagerV2.createRelations] Skipping relation: One or both nodes not found for ${relation.from} --${relation.relationType}--> ${relation.to}`);
                continue;
            }

            const newRelation = {
                id: randomUUID(),
                agentId,
                fromNodeId,
                toNodeId,
                relationType: relation.relationType,
                timestamp: Date.now(),
                version: 1
            };
            await this.jsonlStorage.appendLine(this.getAgentRelationsPath(agentId), newRelation);
            await this.eventStore.appendEvent(agentId, 'RELATION_CREATED', { relationId: newRelation.id, from: relation.from, to: relation.to, type: relation.relationType });
            createdRelations.push(newRelation);
        }

        if (createdRelations.length > 0) {
            this.cache.invalidateAgent(agentId);
            await this.indexManager.rebuildAllIndexes(agentId);
        }

        console.log(`[KGManagerV2.createRelations] Created ${createdRelations.length} relations for agent ${agentId}.`);
        return createdRelations;
    }

    /**
     * Performs an update on a node using an append-only, versioned strategy.
     * It marks the old version as 'deleted' and appends a new, updated version.
     * @param agentId The agent's ID.
     * @param nodeName The name of the node to update.
     * @param updateFunction A function that takes the old node and returns a payload of fields to update. If it returns null, the node is deleted.
     * @returns An object indicating success, the newly written node, and the lines appended to storage.
     */
    private async _updateNodeByName(agentId: string, nodeName: string, updateFunction: (node: any) => Partial<any> | null): Promise<{ success: boolean, writtenNode: any | null }> {
        const nodesPath = this.getAgentNodesPath(agentId);
        const nodes = await this.jsonlStorage.readAllLines(nodesPath);
        const linesToWrite: any[] = [];

        let targetNodeIndex = -1;
        for (let i = nodes.length - 1; i >= 0; i--) {
            if (nodes[i] && nodes[i].name === nodeName && !nodes[i].deleted) {
                targetNodeIndex = i;
                break;
            }
        }

        if (targetNodeIndex === -1) {
            console.warn(`[KGManagerV2._updateNodeByName] Node with name "${nodeName}" not found or already deleted for agent ${agentId}.`);
            return { success: false, writtenNode: null };
        }

        const targetNode = { ...nodes[targetNodeIndex] };
        const marker = { ...targetNode, deleted: true, timestamp: Date.now(), version: targetNode.version + 1 };
        linesToWrite.push(marker);

        const updatePayload = updateFunction(targetNode);
        let finalNode = null;

        if (updatePayload !== null) { // if null, it's a pure deletion
            finalNode = {
                ...targetNode,
                ...updatePayload, // apply updates
                timestamp: Date.now(),
                version: targetNode.version + 2,
                deleted: false
            };
            linesToWrite.push(finalNode);
        }

        for (const line of linesToWrite) {
            await this.jsonlStorage.appendLine(nodesPath, line);
        }

        this.cache.invalidateAgent(agentId);
        return { success: true, writtenNode: finalNode };
    }

    async addObservations(agentId: string, observations: Array<{ entityName: string; contents: string[] }>): Promise<any[]> {
        const updatedNodesResult: any[] = [];
        let changed = false;

        for (const obs of observations) {
            const result = await this._updateNodeByName(agentId, obs.entityName, (targetNode) => ({
                observations: [...(targetNode.observations || []), ...obs.contents]
            }));

            if (result.success && result.writtenNode) {
                await this.eventStore.appendEvent(agentId, 'OBSERVATIONS_ADDED', { nodeId: result.writtenNode.id, entityName: obs.entityName, observationsAdded: obs.contents });
                updatedNodesResult.push(result.writtenNode);
                changed = true;
            }
        }

        if (changed) {
            await this.indexManager.rebuildAllIndexes(agentId);
        }
        return updatedNodesResult;
    }

    async deleteEntities(agentId: string, entityNames: string[]): Promise<void> {
        let changed = false;
        for (const name of entityNames) {
            // Passing a function that returns null signifies deletion.
            const result = await this._updateNodeByName(agentId, name, (node) => {
                // Before deleting, fire event with the node's ID
                this.eventStore.appendEvent(agentId, 'NODE_DELETED', { nodeId: node.id, name: node.name });
                return null;
            });
            if (result.success) {
                changed = true;
            }
        }
        if (changed) {
            await this.indexManager.rebuildAllIndexes(agentId);
        }
    }

    async deleteObservations(agentId: string, deletions: Array<{ entityName: string; observations: string[] }>): Promise<any[]> {
        const updatedNodesResult: any[] = [];
        let changed = false;

        for (const deletion of deletions) {
            const observationsToRemoveSet = new Set(deletion.observations.map(obs => obs.toLowerCase()));

            const result = await this._updateNodeByName(agentId, deletion.entityName, (targetNode) => {
                const currentObservations = targetNode.observations || [];
                const updatedObservations = currentObservations.filter((obs: string) => obs && !observationsToRemoveSet.has(obs.toLowerCase()));
                return { observations: updatedObservations };
            });

            if (result.success && result.writtenNode) {
                await this.eventStore.appendEvent(agentId, 'OBSERVATIONS_REMOVED', { nodeId: result.writtenNode.id, entityName: deletion.entityName, observationsRemoved: deletion.observations });
                updatedNodesResult.push(result.writtenNode);
                changed = true;
            }
        }

        if (changed) {
            await this.indexManager.rebuildAllIndexes(agentId);
        }
        return updatedNodesResult;
    }

    /**
     * Performs a deletion on a relation using an append-only, versioned strategy.
     */
    private async _deleteRelationByDetails(agentId: string, fromNodeId: string, toNodeId: string, relationType: string): Promise<boolean> {
        const relationsPath = this.getAgentRelationsPath(agentId);
        const relations = await this.jsonlStorage.readAllLines(relationsPath);

        let targetRelationIndex = -1;
        for (let i = relations.length - 1; i >= 0; i--) {
            const r = relations[i];
            if (r && r.fromNodeId === fromNodeId && r.toNodeId === toNodeId && r.relationType === relationType && !r.deleted) {
                targetRelationIndex = i;
                break;
            }
        }

        if (targetRelationIndex === -1) {
            return false;
        }

        const targetRelation = { ...relations[targetRelationIndex] };
        const deletionMarker = {
            ...targetRelation,
            deleted: true,
            timestamp: Date.now(),
            version: targetRelation.version + 1
        };

        await this.jsonlStorage.appendLine(relationsPath, deletionMarker);
        this.cache.invalidateAgent(agentId);

        await this.eventStore.appendEvent(agentId, 'RELATION_DELETED', {
            relationId: targetRelation.id,
            fromNodeId: fromNodeId,
            toNodeId: toNodeId,
            type: relationType
        });

        return true;
    }

    async deleteRelations(agentId: string, relationsToDelete: Array<{ from: string; to: string; relationType: string }>): Promise<void> {
        const nodes = await this.jsonlStorage.readAllLines(this.getAgentNodesPath(agentId));
        const activeNodes = nodes.filter((n: any) => n && !n.deleted);
        const nameToIdMap = new Map(activeNodes.map((node: any) => [node.name, node.id]));
        let changed = false;

        for (const rel of relationsToDelete) {
            const fromNodeId = nameToIdMap.get(rel.from);
            const toNodeId = nameToIdMap.get(rel.to);

            if (!fromNodeId || !toNodeId) {
                console.warn(`[KGManagerV2.deleteRelations] Skipping deletion: Nodes not found for ${rel.from} or ${rel.to}`);
                continue;
            }

            const success = await this._deleteRelationByDetails(agentId, fromNodeId, toNodeId, rel.relationType);
            if (success) {
                changed = true;
            } else {
                console.warn(`[KGManagerV2.deleteRelations] Relation not found or already deleted: ${rel.from} -> ${rel.to} (${rel.relationType})`);
            }
        }

        if (changed) {
            await this.indexManager.rebuildAllIndexes(agentId);
        }
    }

    async readGraph(agentId: string): Promise<{ nodes: any[]; relations: any[] }> {
        const cacheKey = `graph:${agentId}`;
        const cached = this.cache.getCachedQuery(cacheKey);
        if (cached) return cached;

        const nodes = (await this.jsonlStorage.readAllLines(this.getAgentNodesPath(agentId))).filter((n: any) => n && !n.deleted);
        const relations = (await this.jsonlStorage.readAllLines(this.getAgentRelationsPath(agentId))).filter((r: any) => r && !r.deleted);
        const result = { nodes, relations };

        this.cache.cacheQuery(cacheKey, result);
        return result;
    }

    async searchNodes(agentId: string, query: string): Promise<any[]> {
        console.log(`[KGManagerV2.searchNodes] Agent: ${agentId}, Query: "${query}"`);
        const cacheKey = `searchNodes:${agentId}:${query}`;
        const cached = this.cache.getCachedQuery(cacheKey);
        if (cached) return cached;

        const ast: QueryAST = this.queryEngine.parseQuery(query);
        const queryEngineResult = await this.queryEngine.executeQuery(ast, agentId);
        let finalNodes = queryEngineResult.nodes;

        // Apply fuzzy search for simple queries to broaden results
        if (ast.type === 'simple_search' && query && query.trim() !== "") {
            const allGraphNodesRaw = await this.jsonlStorage.readAllLines(this.getAgentNodesPath(agentId));
            const activeGraphNodes = allGraphNodesRaw.filter((n: any) => n && !n.deleted);

            this.fuzzySearchEngine.indexForFuzzySearch(activeGraphNodes);
            const fuzzyResultsIds = this.fuzzySearchEngine.search(query);

            const fuzzyNodes = activeGraphNodes.filter((node: any) => node && node.id && fuzzyResultsIds.includes(node.id));

            // Combine results, ensuring no duplicates
            const combinedNodeIds = new Set<string>(finalNodes.map((n: any) => n.id));
            fuzzyNodes.forEach((n: any) => combinedNodeIds.add(n.id));

            finalNodes = activeGraphNodes.filter((node: any) => node && node.id && combinedNodeIds.has(node.id));
        }

        console.log(`[KGManagerV2.searchNodes] Final node count: ${finalNodes.length}`);
        const mappedResult = finalNodes.map((node: any) => ({
            node_id: node.id,
            name: node.name,
            entityType: node.entityType,
            observations: node.observations || []
        }));

        this.cache.cacheQuery(cacheKey, mappedResult);
        return mappedResult;
    }

    async openNodes(agentId: string, names: string[]): Promise<any[]> {
        console.log(`[KGManagerV2.openNodes] Agent: ${agentId}, Names:`, names);
        const allNodes = await this.jsonlStorage.readAllLines(this.getAgentNodesPath(agentId));
        const nameSet = new Set(names);
        const foundNodes = allNodes.filter((node: any) => node && nameSet.has(node.name) && !node.deleted);

        console.log(`[KGManagerV2.openNodes] Found ${foundNodes.length} nodes.`);
        return foundNodes.map((node: any) => ({
            node_id: node.id,
            name: node.name,
            entityType: node.entityType,
            observations: node.observations || []
        }));
    }

    /**
     * Prepares a string representation of the graph for use in an AI prompt.
     * Summarizes the graph if it exceeds a maximum length.
     */
    private async _prepareGraphContextForPrompt(agentId: string): Promise<string> {
        let graphRepresentation = "{}";
        try {
            const graphData = await this.readGraph(agentId);
            if (graphData && (graphData.nodes.length > 0 || graphData.relations.length > 0)) {
                const nodesForPrompt = graphData.nodes.map(n => ({
                    id: n.id, name: n.name, entityType: n.entityType,
                    observations: n.observations?.slice(0, 3).map((o: string) => o.substring(0, 70) + (o.length > 70 ? '...' : ''))
                })).slice(0, 200);
                const relationsForPrompt = graphData.relations.slice(0, 200);
                graphRepresentation = JSON.stringify({ nodes: nodesForPrompt, relations: relationsForPrompt }, null, 2);
            }

            if (graphRepresentation.length > this.MAX_PROMPT_GRAPH_LENGTH) {
                console.warn(`[KGManagerV2] Graph representation is too large (${graphRepresentation.length} chars). Summarizing for prompt.`);
                const nodeSchemaExample = graphData?.nodes[0] ? `Example Node: ${JSON.stringify(Object.keys(graphData.nodes[0]))}` : "Nodes have id, name, entityType, observations.";
                const relationSchemaExample = graphData?.relations[0] ? `Example Relation: ${JSON.stringify(Object.keys(graphData.relations[0]))}` : "Relations have id, fromNodeId, toNodeId, relationType.";
                graphRepresentation = `Graph is too large to display fully. 
Node Schema: ${nodeSchemaExample}
Relation Schema: ${relationSchemaExample}
Total Nodes: ${graphData?.nodes.length || 0}, Total Relations: ${graphData?.relations.length || 0}`;
            }
        } catch (e) {
            console.error(`[KGManagerV2] Error reading graph for prompt context:`, e);
            graphRepresentation = `{"error": "Could not read graph data."}`;
        }
        return graphRepresentation;
    }

    /**
     * Parses a JSON object or array from a string, which may be wrapped in markdown code fences.
     * Ensures the final return value is always an array of operations.
     */
    private _parseGeminiJsonResponse(responseText: string): any[] {
        const parsed = centralParseGeminiJsonResponse(responseText);
        // Ensure the final return is always an array of operations
        return Array.isArray(parsed) ? parsed : [parsed];
    }

    /**
     * Executes a structured query object against the knowledge graph.
     */
    private async _executeAiQuery(agentId: string, query: { operation?: string, type?: string, args?: any }): Promise<any> {
        const operation = query.operation || query.type;
        const args = query.args || query;
        console.log(`[KGManagerV2] Executing operation: "${operation}" with args:`, JSON.stringify(args));

        switch (operation) {
            case 'search_nodes':
                if (args && typeof args.query === 'string') {
                    return this.searchNodes(agentId, args.query);
                }
                return { error: "Invalid args for 'search_nodes': 'query' string missing." };
            case 'open_nodes':
                if (args && Array.isArray(args.names)) {
                    return this.openNodes(agentId, args.names);
                }
                return { error: "Invalid args for 'open_nodes': 'names' array missing." };
            case 'graph_traversal':
                if (args && args.start_node && Array.isArray(args.relation_types) && typeof args.depth === 'number') {
                    return this.traverseGraph(agentId, args.start_node, args.relation_types, args.depth);
                }
                return { error: "Invalid args for 'graph_traversal'." };
            case 'find_inbound_relations':
                if (args && args.target_node_name && args.relation_type) {
                    const ast: ParsedComplexQuery = {
                        type: 'parsed_complex_search',
                        findSourcesOf: {
                            targetNodeName: args.target_node_name,
                            relationType: args.relation_type,
                        },
                    };
                    const queryResult = await this.queryEngine.executeQuery(ast, agentId);
                    return queryResult.nodes;
                }
                return { error: "Invalid args for 'find_inbound_relations'." };
            case 'read_graph':
                return this.readGraph(agentId);
            default:
                // Fallback for NLP-style structured queries
                if (typeof args === 'object' && args.type) {
                    console.log("[KGManagerV2] Attempting direct QueryEngine execution for NLP-style query.");
                    const directResult = await this.queryEngine.executeQuery(args as QueryAST, agentId);
                    return directResult.nodes;
                }
                console.error("[KGManagerV2] Unhandled structured query operation:", JSON.stringify(query));
                throw new McpError(ErrorCode.InvalidParams, `Unhandled structured query operation: ${operation}`);
        }
    }

    async queryNaturalLanguage(agentId: string, naturalLanguageQuery: string): Promise<string> {
        console.log(`[KGManagerV2.queryNaturalLanguage] AgentID: ${agentId}, NLQ: "${naturalLanguageQuery}"`);

        if (!this.geminiService) {
            console.warn("[KGManagerV2] GeminiService not available. Using NLPQueryProcessor fallback.");
            const structuredQuery = this.nlpQueryProcessor.generateStructuredQuery(naturalLanguageQuery);
            const queryResult = await this.queryEngine.executeQuery(structuredQuery as QueryAST, agentId);
            return JSON.stringify({
                metadata: {
                    originalQuery: naturalLanguageQuery,
                    translatedOperations: [{
                        operation: structuredQuery.type,
                        args: structuredQuery
                    }],
                    usedGemini: false
                },
                results: queryResult.nodes
            }, null, 2);
        }

        let structuredQueriesFromAI: any[];
        let usedGemini = false;
        try {
            const graphContext = await this._prepareGraphContextForPrompt(agentId);
            const prompt = NLP_QUERY_PROMPT_TEMPLATE
                .replace('${graphRepresentation}', graphContext)
                .replace('${naturalLanguageQuery}', naturalLanguageQuery);

            const geminiResponse = await this.geminiService.askGemini(prompt, "gemini-2.5-flash");
            usedGemini = true;
            const geminiResponseText = geminiResponse.content[0]?.text?.trim() || "[]";
            structuredQueriesFromAI = this._parseGeminiJsonResponse(geminiResponseText);
            console.log("[KGManagerV2] Gemini Parsed Structured Queries:", JSON.stringify(structuredQueriesFromAI));

        } catch (e: any) {
            console.error(`[KGManagerV2] Gemini call or parsing failed:`, e);
            console.warn("[KGManagerV2] Falling back to local NLP due to Gemini error.");
            const singleQuery = this.nlpQueryProcessor.generateStructuredQuery(naturalLanguageQuery);
            structuredQueriesFromAI = [singleQuery]; // Wrap in array to match expected format
            usedGemini = false;
        }

        const allResults: any[] = [];
        const allTranslatedOps: any[] = [];
        let hasError = false;
        let errorMessage = '';

        for (const query of structuredQueriesFromAI) {
            // Check for error operation first
            if (query.operation === 'error') {
                hasError = true;
                errorMessage = query.args?.message || "Gemini could not translate the query.";
                allTranslatedOps.push({ operation: 'error', args: query.args });
                console.warn(`[KGManagerV2] Gemini reported translation error: ${errorMessage}`);
                break; // Stop processing if one part of the query is an error
            }

            try {
                const queryResultData = await this._executeAiQuery(agentId, query);
                // Ensure results are always pushed as an array of items
                if (Array.isArray(queryResultData)) {
                    allResults.push(...queryResultData);
                } else if (queryResultData) {
                    allResults.push(queryResultData);
                }
                allTranslatedOps.push({ operation: query.operation || query.type, args: query.args || query });
            } catch (execError: any) {
                hasError = true;
                errorMessage = `Failed to execute operation '${query.operation}': ${execError.message}`;
                allTranslatedOps.push({ operation: query.operation || query.type, args: query.args });
                console.error(`[KGManagerV2] Error executing AI query:`, execError);
                break;
            }
        }

        if (hasError) {
            return JSON.stringify({
                metadata: { originalQuery: naturalLanguageQuery, translatedOperations: allTranslatedOps, usedGemini },
                results: { error: errorMessage }
            }, null, 2);
        }

        // De-duplicate results based on a unique key, like node_id.
        const uniqueResults = Array.from(new Map(allResults.map(item => [item.node_id || JSON.stringify(item), item])).values());

        console.log(`[KGManagerV2.queryNaturalLanguage] Final unique query result count: ${uniqueResults.length}`);

        return JSON.stringify({
            metadata: {
                originalQuery: naturalLanguageQuery,
                translatedOperations: allTranslatedOps,
                usedGemini
            },
            results: uniqueResults
        }, null, 2);
    }

    async inferRelations(agentId: string, entityNames?: string[], context?: string): Promise<{ message: string; details: any[] }> {
        console.log(`[KGManagerV2.inferRelations] Agent: ${agentId}, Entities: ${entityNames?.join(', ')}`);
        const { nodes: allNodes, relations: existingRelations } = await this.readGraph(agentId);

        let targetNodes = allNodes;
        if (entityNames && entityNames.length > 0) {
            const entityNamesSet = new Set(entityNames);
            targetNodes = allNodes.filter((n: any) => n && entityNamesSet.has(n.name));
        }

        if (targetNodes.length === 0) {
            return { message: "No target nodes found for relation inference.", details: [] };
        }

        let contextForGemini = `Target Nodes for Relation Inference (Agent: ${agentId}):\n`;
        targetNodes.slice(0, 20).forEach(n => {
            contextForGemini += `- Name: ${n.name}, Type: ${n.entityType}, Observations: ${(n.observations || []).join(', ').substring(0, 100)}\n`;
        });
        if (existingRelations.length > 0) {
            contextForGemini += "\nSome Existing Relations (for context):\n";
            existingRelations.slice(0, 10).forEach(r => {
                const fromNode = allNodes.find(n => n.id === r.fromNodeId);
                const toNode = allNodes.find(n => n.id === r.toNodeId);
                if (fromNode && toNode) contextForGemini += `- ${fromNode.name} --(${r.relationType})--> ${toNode.name}\n`;
            });
        }
        if (context) contextForGemini += `\nUser Provided Context: ${context}\n`;

        const prompt = `
Analyze the provided node information and existing relations. Your goal is to infer NEW, meaningful relationships between the TARGET NODES.
Focus on common software relationships: 'calls', 'uses', 'imports', 'exports', 'extends', 'implements', 'defined_in', 'related_to_feature', 'tests_file'.
For each proposed new relation:
- It must be between two of the TARGET NODES, or between a TARGET NODE and an EXISTING node if relevant.
- It must NOT already exist in the 'Existing Relations' list.
- Provide 'from' (source name), 'to' (target name), 'relationType', 'confidence' (0.0-1.0), and 'evidence' (max 20 words).
Context:
---
${contextForGemini}
---
Output ONLY a JSON array of proposed new relations. Example:
[
  { "from": "Service.ts", "to": "Util.ts", "relationType": "imports_file", "confidence": 0.9, "evidence": "Service.ts observation includes 'import { ... } from ./Util.ts'." }
]
If no new relations can be confidently inferred, return an empty array [].`;

        let proposedByAI: Array<{ from: string; to: string; relationType: string; confidence: number; evidence: string }> = [];
        if (this.geminiService) {
            try {
                const geminiResponse = await this.geminiService.askGemini(prompt, "gemini-2.5-flash");
                const parsedResponse = this._parseGeminiJsonResponse(geminiResponse.content[0]?.text?.trim() || "[]");
                proposedByAI = Array.isArray(parsedResponse) ? parsedResponse : [];
                console.log(`[KGManagerV2.inferRelations] Gemini proposed ${proposedByAI.length} relations.`);
            } catch (e: any) {
                console.error(`[KGManagerV2.inferRelations] Gemini call or parsing failed: ${e.message}`);
            }
        }

        const validAIProposals = proposedByAI.filter(prop => {
            const fromNode = allNodes.find(n => n.name === prop.from);
            const toNode = allNodes.find(n => n.name === prop.to);
            if (!fromNode || !toNode) return false;
            return !existingRelations.some(exRel =>
                exRel.fromNodeId === fromNode.id && exRel.toNodeId === toNode.id && exRel.relationType === prop.relationType
            );
        }).map(p => ({ ...p, status: 'proposed_by_ai' }));

        let message = `Relation inference complete. Found ${validAIProposals.length} potential new relations.`;
        const relationsToCreate = validAIProposals
            .filter(r => r.confidence >= 0.8)
            .map(r => ({ from: r.from, to: r.to, relationType: r.relationType }));

        if (relationsToCreate.length > 0) {
            const created = await this.createRelations(agentId, relationsToCreate);
            message += ` Automatically added ${created.length} high-confidence relations.`;
            validAIProposals.forEach(fp => {
                if (fp.confidence >= 0.8 && created.some(c => c.from === fp.from && c.to === fp.to && c.relationType === fp.relationType)) {
                    fp.status = 'added_by_ai';
                }
            });
        }

        return { message, details: validAIProposals };
    }

    async traverseGraph(agentId: string, startNodeName: string, relationTypes: string[], depth: number): Promise<any> {
        console.log(`[KGManagerV2.traverseGraph] Agent: ${agentId}, Start: ${startNodeName}, Types: ${relationTypes.join(',')}, Depth: ${depth}`);
        const { nodes: allNodes, relations: allRelations } = await this.readGraph(agentId);

        const nameToNodeMap = new Map(allNodes.map((n: any) => [n.name, n]));
        const idToNodeMap = new Map(allNodes.map((n: any) => [n.id, n]));

        const startNode = nameToNodeMap.get(startNodeName);
        if (!startNode) {
            console.warn(`[KGManagerV2.traverseGraph] Start node "${startNodeName}" not found.`);
            return { nodes: [], relations: [] };
        }

        const visitedNodeIds = new Set<string>();
        const resultNodes = new Map<string, any>();
        const resultRelations: any[] = [];
        const queue: Array<{ nodeId: string; currentDepth: number }> = [{ nodeId: startNode.id, currentDepth: 0 }];
        visitedNodeIds.add(startNode.id);
        resultNodes.set(startNode.id, startNode);

        while (queue.length > 0) {
            const { nodeId, currentDepth } = queue.shift()!;

            if (currentDepth >= depth) continue;

            for (const rel of allRelations) {
                if (rel.fromNodeId === nodeId && (!relationTypes || relationTypes.length === 0 || relationTypes.includes(rel.relationType))) {
                    resultRelations.push(rel);
                    if (!visitedNodeIds.has(rel.toNodeId)) {
                        const toNodeObject = idToNodeMap.get(rel.toNodeId);
                        if (toNodeObject) {
                            visitedNodeIds.add(rel.toNodeId);
                            resultNodes.set(rel.toNodeId, toNodeObject);
                            queue.push({ nodeId: rel.toNodeId, currentDepth: currentDepth + 1 });
                        }
                    }
                }
            }
        }
        console.log(`[KGManagerV2.traverseGraph] Traversal found ${resultNodes.size} nodes and ${resultRelations.length} relations.`);
        return { nodes: Array.from(resultNodes.values()), relations: resultRelations };
    }

    private _generateMermaidNodes(nodes: any[], groupByDirectory: boolean): { mermaid: string, idToLabel: Record<string, string> } {
        let mermaid = '';
        const idToLabel: Record<string, string> = {};

        const addNodeToMermaid = (n: any) => {
            const nodeId = n.id || n.node_id;
            const nodeName = n.name || nodeId;
            const nodeLabel = nodeName.replace(/[^a-zA-Z0-9_./-]/g, '_');
            idToLabel[nodeId] = nodeLabel;
            const entityType = n.entityType || 'unknown';
            const [openS, closeS] = KnowledgeGraphManagerV2.MERMAID_SHAPES[entityType] || KnowledgeGraphManagerV2.MERMAID_SHAPES.default;
            const style = KnowledgeGraphManagerV2.MERMAID_STYLES[entityType] || KnowledgeGraphManagerV2.MERMAID_STYLES.default;
            return `        ${nodeLabel}${openS}"${nodeName} (${entityType})"${closeS}\n        style ${nodeLabel} ${style}\n`;
        };

        if (groupByDirectory) {
            const nodesByDir: Record<string, any[]> = {};
            for (const n of nodes) {
                const dir = n.name && n.name.includes('/') ? path.dirname(n.name) : '.';
                if (!nodesByDir[dir]) nodesByDir[dir] = [];
                nodesByDir[dir].push(n);
            }
            for (const dir in nodesByDir) {
                const subgraphId = dir.replace(/[^a-zA-Z0-9_]/g, '_') || 'root';
                mermaid += `    subgraph ${subgraphId} ["${dir}"]\n`;
                for (const n of nodesByDir[dir]) {
                    mermaid += addNodeToMermaid(n);
                }
                mermaid += `    end\n`;
            }
        } else {
            for (const n of nodes) {
                mermaid += addNodeToMermaid(n);
            }
        }
        return { mermaid, idToLabel };
    }

    private _generateMermaidRelations(relations: any[], idToLabel: Record<string, string>): string {
        let mermaid = '';
        for (const r of relations) {
            const fromLabel = idToLabel[r.fromNodeId];
            const toLabel = idToLabel[r.toNodeId];
            if (fromLabel && toLabel) {
                mermaid += `    ${fromLabel} -- "${r.relationType}" --> ${toLabel}\n`;
            }
        }
        return mermaid;
    }

    private _generateMermaidLegend(): string {
        let mermaid = '\n    subgraph LEGEND\n        direction LR\n';
        Object.entries(KnowledgeGraphManagerV2.MERMAID_SHAPES).forEach(([type, [openS, closeS]], i) => {
            if (type === 'default') return;
            const style = KnowledgeGraphManagerV2.MERMAID_STYLES[type];
            mermaid += `        L${i}${openS}"${type.toUpperCase()}"${closeS}\n`;
            mermaid += `        style L${i} ${style}\n`;
        });
        mermaid += '    end\n';
        return mermaid;
    }

    async getExistingRelation(agentId: string, fromNodeName: string, toNodeName: string, relationType: string): Promise<any | null> {
        console.log(`[KGManagerV2.getExistingRelation] Agent: ${agentId}, From: ${fromNodeName}, To: ${toNodeName}, Type: ${relationType}`);

        const nodes = await this.jsonlStorage.readAllLines(this.getAgentNodesPath(agentId));
        const activeNodes = nodes.filter((n: any) => n && !n.deleted);

        const nameToIdMap = new Map<string, string>(activeNodes.map((node: any) => [String(node.name), String(node.id)]));
        const allNames: string[] = activeNodes.map((n: any) => String(n.name));

        const fromNodeId = this._resolveEndpoint(fromNodeName, nameToIdMap, allNames);
        const toNodeId = this._resolveEndpoint(toNodeName, nameToIdMap, allNames);

        if (!fromNodeId || !toNodeId) {
            return null;
        }

        const relations = await this.jsonlStorage.readAllLines(this.getAgentRelationsPath(agentId));
        const activeRelations = relations.filter((r: any) => r && !r.deleted);

        const existingRelation = activeRelations.find((rel: any) =>
            rel.fromNodeId === fromNodeId &&
            rel.toNodeId === toNodeId &&
            rel.relationType === relationType
        );

        return existingRelation || null;
    }

    async generateMermaidGraph(agentId: string, options: { query?: string; layoutDirection?: string; depth?: number; includeLegend?: boolean; groupByDirectory?: boolean, maxNodes?: number, maxEdges?: number, excludeImports?: string[], excludeRelationTypes?: string[] }): Promise<string> {
        console.log(`[KGManagerV2.generateMermaidGraph] Agent: ${agentId}, Options:`, options);
        const { layoutDirection = 'TD', includeLegend = true, groupByDirectory = false, maxNodes = 100, maxEdges = 200, excludeImports, excludeRelationTypes } = options;

        let graphNodes: any[] = [];
        let graphRelations: any[] = [];

        if (options.query) {
            const searchResults = await this.searchNodes(agentId, options.query);
            if (!searchResults || searchResults.length === 0) return `graph ${layoutDirection}\n    message["No nodes found for query: '${options.query}'"]`;
            graphNodes = searchResults.map(n => ({ ...n, id: n.node_id })).slice(0, maxNodes);
            const nodeIds = new Set(graphNodes.map(n => n.id));
            const allRels = (await this.jsonlStorage.readAllLines(this.getAgentRelationsPath(agentId))).filter(r => r && !r.deleted);
            graphRelations = allRels.filter(r => nodeIds.has(r.fromNodeId) && nodeIds.has(r.toNodeId));
        } else {
            const fullGraph = await this.readGraph(agentId);
            if (fullGraph.nodes.length === 0) return `graph ${layoutDirection}\n    A["Graph is empty for agent ${agentId}"]`;
            graphNodes = fullGraph.nodes;
            graphRelations = fullGraph.relations;
        }

        // Apply filters
        if (excludeImports?.length) {
            const excludeSet = new Set(excludeImports.map(imp => createCanonicalAbsPathKey(imp)));
            graphRelations = graphRelations.filter(rel => {
                if (rel.relationType.startsWith('imports_')) {
                    const toNode = graphNodes.find(n => n.id === rel.toNodeId);
                    return toNode ? !excludeSet.has(createCanonicalAbsPathKey(toNode.name)) : true;
                }
                return true;
            });
        }
        if (excludeRelationTypes?.length) {
            const excludeSet = new Set(excludeRelationTypes);
            graphRelations = graphRelations.filter(rel => !excludeSet.has(rel.relationType));
        }

        // Truncate after filtering
        graphNodes = graphNodes.slice(0, maxNodes);
        graphRelations = graphRelations.slice(0, maxEdges);
        console.log(`[KGManagerV2.generateMermaidGraph] Visualizing ${graphNodes.length} nodes and ${graphRelations.length} relations.`);

        let mermaid = `graph ${layoutDirection}\n`;
        const { mermaid: nodesMermaid, idToLabel } = this._generateMermaidNodes(graphNodes, groupByDirectory);
        mermaid += nodesMermaid;
        mermaid += this._generateMermaidRelations(graphRelations, idToLabel);

        if (includeLegend) {
            mermaid += this._generateMermaidLegend();
        }

        if (graphNodes.length >= maxNodes || graphRelations.length >= maxEdges) {
            mermaid += `\n    %% Diagram may be truncated due to node/edge limits.\n`;
        }
        return mermaid;
    }
}