// src/database/managers/KnowledgeGraphManagerV2.ts
import path from 'path';
import { fileURLToPath } from 'url';
import { JsonlStorageManager } from '../storage/JsonlStorageManager.js';
import { EventStore, KnowledgeGraphEvent } from '../storage/EventStore.js';
import { IndexManager } from '../storage/IndexManager.js';
// import { LRUCache } from 'lru-cache'; // Not used directly, but this.cache might use it
import { randomUUID } from 'crypto';
import { QueryEngine, QueryAST } from '../query/QueryEngine.js'; // Import QueryAST
import { FuzzySearchEngine } from '../search/FuzzySearchEngine.js';
import { KnowledgeGraphCache } from '../cache/KnowledgeGraphCache.js';
import { EntityResolver } from '../ai/EntityResolver.js';
import { NLPQueryProcessor } from '../ai/NLPQueryProcessor.js';
import { GeminiIntegrationService } from '../services/GeminiIntegrationService.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

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
    private readonly MAX_PROMPT_GRAPH_LENGTH = 15000; // Max chars for graph representation in prompt

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
            this.cache.invalidateAgent(agentId);
            createdEntities.push(newNode);
        }
        await this.indexManager.rebuildAllIndexes(agentId);
        console.log(`[KGManagerV2.createEntities] Created ${createdEntities.length} entities for agent ${agentId}.`);
        return createdEntities;
    }

    async createRelations(agentId: string, relations: Array<{ from: string; to: string; relationType: string }>): Promise<any[]> {
        console.log(`[KGManagerV2.createRelations] Agent: ${agentId}, Relations count: ${relations.length}`);
        const createdRelations = [];
        const nodes = await this.jsonlStorage.readAllLines(this.getAgentNodesPath(agentId));
        const nameToIdMap = new Map(nodes.filter((n:any) => n && !n.deleted).map((node: any) => [node.name, node.id]));

        for (const relation of relations) {
            const fromNodeId = nameToIdMap.get(relation.from);
            const toNodeId = nameToIdMap.get(relation.to);

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
            this.cache.invalidateAgent(agentId);
            createdRelations.push(newRelation);
        }
        await this.indexManager.rebuildAllIndexes(agentId);
        console.log(`[KGManagerV2.createRelations] Created ${createdRelations.length} relations for agent ${agentId}.`);
        return createdRelations;
    }
    
    async addObservations(agentId: string, observations: Array<{ entityName: string; contents: string[] }>): Promise<any> {
        const nodesPath = this.getAgentNodesPath(agentId);
        let nodes = await this.jsonlStorage.readAllLines(nodesPath);
        const updatedNodesResult = [];
        const linesToWrite: any[] = []; // Collect all lines to write (markers and new versions)
        let changed = false;

        for (const obs of observations) {
            let targetNodeIndex = -1;
            // Find the latest, non-deleted version of the node
            for(let i = nodes.length - 1; i >= 0; i--) {
                if (nodes[i] && nodes[i].name === obs.entityName && !nodes[i].deleted) {
                    targetNodeIndex = i;
                    break;
                }
            }

            if (targetNodeIndex === -1) {
                console.warn(`[KGManagerV2.addObservations] Node with name ${obs.entityName} not found for agent ${agentId}. Cannot add observations.`);
                continue; // Skip if node not found
            }
            
            const targetNode = { ...nodes[targetNodeIndex] }; // Create a copy to modify

            // 1. Create a "deletion marker" for the old version
            const oldNodeMarker = { 
                ...targetNode, // Spread original fields
                deleted: true, 
                timestamp: Date.now(), // New timestamp for this "deletion" event
                version: targetNode.version + 1 // Increment version for the deletion marker
            };
            linesToWrite.push(oldNodeMarker);

            // 2. Create the new node version with added observations
            const updatedObservations = [...(targetNode.observations || []), ...obs.contents];
            const updatedNode = {
                ...targetNode, // Spread original fields (like ID)
                observations: updatedObservations,
                timestamp: Date.now(), // New timestamp for this update
                version: targetNode.version + 2, // Increment version further for the new actual version
                deleted: false // Ensure it's not marked as deleted
            };
            linesToWrite.push(updatedNode);
            
            // Update in-memory nodes list for subsequent operations within this batch if any
            // This is tricky if not rewriting the whole file. For now, we assume batch append.
            // To be perfectly safe with in-memory state for a single call, one might filter out
            // the old node and add the new ones, but the primary persistence is via appendLine.

            await this.eventStore.appendEvent(agentId, 'OBSERVATIONS_ADDED', { nodeId: targetNode.id, entityName: targetNode.name, observationsAdded: obs.contents });
            updatedNodesResult.push(updatedNode);
            changed = true;
        }
        
        // Batch append all collected lines (deletion markers and new versions)
        for(const line of linesToWrite) {
            await this.jsonlStorage.appendLine(nodesPath, line);
        }

        if (changed) {
            this.cache.invalidateAgent(agentId); 
            await this.indexManager.rebuildAllIndexes(agentId); // Rebuild indexes after modifications
        }
        return updatedNodesResult;
    }

    async deleteEntities(agentId: string, entityNames: string[]): Promise<void> {
        const nodesPath = this.getAgentNodesPath(agentId);
        let nodes = await this.jsonlStorage.readAllLines(nodesPath); // Read all for in-memory processing
        const linesToWrite: any[] = [];
        let changed = false;

        for (const name of entityNames) {
            // Find the latest, non-deleted version of the node
            let targetNodeIndex = -1;
            for(let i = nodes.length - 1; i >= 0; i--) {
                 if (nodes[i] && nodes[i].name === name && !nodes[i].deleted) {
                    targetNodeIndex = i;
                    break;
                }
            }

            if (targetNodeIndex !== -1) {
                const targetNode = { ...nodes[targetNodeIndex] }; // Copy
                const deletionMarker = {
                    ...targetNode,
                    deleted: true,
                    timestamp: Date.now(),
                    version: targetNode.version + 1
                };
                linesToWrite.push(deletionMarker);
                
                // Update in-memory representation for this operation's scope
                nodes = nodes.filter(n => n.id !== targetNode.id); // Remove all old versions
                nodes.push(deletionMarker); // Add the marker

                await this.eventStore.appendEvent(agentId, 'NODE_DELETED', { nodeId: targetNode.id, name: targetNode.name });
                changed = true;
            } else {
                console.warn(`[KGManagerV2.deleteEntities] Node with name "${name}" not found or already deleted for agent ${agentId}.`);
            }
        }
        
        // Append all deletion markers
        for(const line of linesToWrite) {
            await this.jsonlStorage.appendLine(nodesPath, line);
        }

        if (changed) {
            this.cache.invalidateAgent(agentId);
            await this.indexManager.rebuildAllIndexes(agentId); // Rebuild indexes
        }
    }
    
    async deleteObservations(agentId: string, deletions: Array<{ entityName: string; observations: string[] }>): Promise<any> {
        const nodesPath = this.getAgentNodesPath(agentId);
        let nodes = await this.jsonlStorage.readAllLines(nodesPath);
        const updatedNodesResult = [];
        const linesToWrite: any[] = [];
        let changed = false;

        for (const deletion of deletions) {
            let targetNodeIndex = -1;
            for(let i = nodes.length - 1; i >=0; i--) {
                if(nodes[i] && nodes[i].name === deletion.entityName && !nodes[i].deleted) {
                    targetNodeIndex = i;
                    break;
                }
            }

            if (targetNodeIndex === -1) {
                 console.warn(`[KGManagerV2.deleteObservations] Node ${deletion.entityName} not found for agent ${agentId}.`);
                 continue;
            }
            
            const targetNode = { ...nodes[targetNodeIndex] }; // Copy
            const oldNodeMarker = { ...targetNode, deleted: true, timestamp: Date.now(), version: targetNode.version + 1 };
            linesToWrite.push(oldNodeMarker);

            const currentObservations = targetNode.observations || [];
            const observationsToRemoveSet = new Set(deletion.observations.map(obs => obs.toLowerCase()));
            const updatedObservations = currentObservations.filter((obs: string) => obs && !observationsToRemoveSet.has(obs.toLowerCase()));
            
            const updatedNode = {
                ...targetNode,
                observations: updatedObservations,
                timestamp: Date.now(),
                version: targetNode.version + 2, // New actual version
                deleted: false
            };
            linesToWrite.push(updatedNode);

            // Update in-memory list for this operation
            nodes = nodes.filter(n => n.id !== targetNode.id);
            nodes.push(oldNodeMarker, updatedNode);

            await this.eventStore.appendEvent(agentId, 'OBSERVATIONS_REMOVED', { nodeId: targetNode.id, entityName: targetNode.name, observationsRemoved: deletion.observations });
            updatedNodesResult.push(updatedNode);
            changed = true;
        }
        
        for(const line of linesToWrite) {
            await this.jsonlStorage.appendLine(nodesPath, line);
        }

        if (changed) {
            this.cache.invalidateAgent(agentId);
            await this.indexManager.rebuildAllIndexes(agentId);
        }
        return updatedNodesResult;
    }

    async deleteRelations(agentId: string, relationsToDelete: Array<{ from: string; to: string; relationType: string }>): Promise<void> {
        const relationsPath = this.getAgentRelationsPath(agentId);
        let relations = await this.jsonlStorage.readAllLines(relationsPath);
        const nodes = await this.jsonlStorage.readAllLines(this.getAgentNodesPath(agentId));
        const nameToIdMap = new Map(nodes.filter((n:any)=> n && !n.deleted).map((node: any) => [node.name, node.id]));
        const linesToWrite: any[] = [];
        let changed = false;

        for (const rel of relationsToDelete) {
            const fromNodeId = nameToIdMap.get(rel.from);
            const toNodeId = nameToIdMap.get(rel.to);

            if (!fromNodeId || !toNodeId) {
                console.warn(`[KGManagerV2.deleteRelations] Skipping relation deletion: Nodes not found for ${rel.from} or ${rel.to} for agent ${agentId}`);
                continue;
            }
            
            let targetRelationIndex = -1;
            for(let i = relations.length -1; i>=0; i--){ // Find latest non-deleted
                const r = relations[i];
                if (r && r.fromNodeId === fromNodeId && r.toNodeId === toNodeId && r.relationType === rel.relationType && !r.deleted) {
                    targetRelationIndex = i;
                    break;
                }
            }

            if (targetRelationIndex !== -1) {
                const targetRelation = { ...relations[targetRelationIndex] }; // Copy
                const deletionMarker = {
                    ...targetRelation,
                    deleted: true,
                    timestamp: Date.now(),
                    version: targetRelation.version + 1
                };
                linesToWrite.push(deletionMarker);
                
                // Update in-memory list for this operation
                relations = relations.filter(r => r.id !== targetRelation.id);
                relations.push(deletionMarker);

                await this.eventStore.appendEvent(agentId, 'RELATION_DELETED', { relationId: targetRelation.id, from: rel.from, to: rel.to, type: rel.relationType });
                changed = true;
            } else {
                 console.warn(`[KGManagerV2.deleteRelations] Relation not found or already deleted: ${rel.from} -> ${rel.to} (${rel.relationType}) for agent ${agentId}`);
            }
        }

        for(const line of linesToWrite) {
            await this.jsonlStorage.appendLine(relationsPath, line);
        }

        if (changed) {
            this.cache.invalidateAgent(agentId);
            await this.indexManager.rebuildAllIndexes(agentId);
        }
    }

    async readGraph(agentId: string): Promise<{ nodes: any[]; relations: any[] }> {
        const cacheKey = `graph:${agentId}`;
        const cached = this.cache.getCachedQuery(cacheKey);
        if (cached) {
            // console.log(`[KGManagerV2.readGraph] Cache hit for ${cacheKey}`);
            return cached;
        }
        // console.log(`[KGManagerV2.readGraph] Cache miss for ${cacheKey}, reading from storage for agent ${agentId}.`);

        const nodes = (await this.jsonlStorage.readAllLines(this.getAgentNodesPath(agentId))).filter((n: any) => n && !n.deleted);
        const relations = (await this.jsonlStorage.readAllLines(this.getAgentRelationsPath(agentId))).filter((r: any) => r && !r.deleted);
        const result = { nodes, relations };
        this.cache.cacheQuery(cacheKey, result);
        // console.log(`[KGManagerV2.readGraph] Read ${nodes.length} nodes and ${relations.length} relations for agent ${agentId}.`);
        return result;
    }

    async searchNodes(agentId: string, query: string): Promise<any[]> {
        console.log(`[KGManagerV2.searchNodes] Agent: ${agentId}, Raw Query to searchNodes: "${query}"`);
        const cacheKey = `searchNodes:${agentId}:${query}`; // Query string might be long, consider hashing for cache key if an issue.
        const cached = this.cache.getCachedQuery(cacheKey);
        if (cached) {
            console.log(`[KGManagerV2.searchNodes] Cache hit for ${cacheKey}`);
            return cached;
        }
        console.log(`[KGManagerV2.searchNodes] Cache miss for ${cacheKey}.`);

        const ast: QueryAST = this.queryEngine.parseQuery(query);
        console.log('[KGManagerV2.searchNodes] Parsed AST by QueryEngine:', JSON.stringify(ast));

        const queryEngineResult = await this.queryEngine.executeQuery(ast, agentId);
        console.log(`[KGManagerV2.searchNodes] QueryEngine result count: ${queryEngineResult.nodes.length}`);
        
        // Fuzzy search part
        const allGraphNodesRaw = await this.jsonlStorage.readAllLines(this.getAgentNodesPath(agentId));
        const activeGraphNodes = allGraphNodesRaw.filter((n:any) => n && !n.deleted);
        
        let fuzzyResultsIds: string[] = [];
        if (query && query.trim() !== "") { // Only run fuzzy search if there's a query term
            this.fuzzySearchEngine.indexForFuzzySearch(activeGraphNodes);
            fuzzyResultsIds = this.fuzzySearchEngine.search(query); // Fuzzy search uses the original raw query string
            console.log(`[KGManagerV2.searchNodes] Fuzzy search found IDs: ${fuzzyResultsIds.length}`);
        } else {
            console.log(`[KGManagerV2.searchNodes] Skipping fuzzy search due to empty or whitespace query.`);
        }
        
        const combinedNodeIds = new Set<string>();
        queryEngineResult.nodes.forEach((n: any) => { if(n && n.id) combinedNodeIds.add(n.id); });
        fuzzyResultsIds.forEach(id => combinedNodeIds.add(id));

        const finalNodes = activeGraphNodes.filter((node: any) => node && node.id && combinedNodeIds.has(node.id));
        console.log(`[KGManagerV2.searchNodes] Combined and filtered node count: ${finalNodes.length}`);

        const mappedResult = finalNodes.map((node: any) => {
            return {
                node_id: node.id,
                name: node.name,
                entityType: node.entityType,
                observations: node.observations || []
            };
        });
        this.cache.cacheQuery(cacheKey, mappedResult);
        return mappedResult;
    }

    async openNodes(agentId: string, names: string[]): Promise<any[]> {
        console.log(`[KGManagerV2.openNodes] Agent: ${agentId}, Names:`, names);
        const allNodes = await this.jsonlStorage.readAllLines(this.getAgentNodesPath(agentId));
        const foundNodes = allNodes.filter((node: any) => node && names.includes(node.name) && !node.deleted);
        console.log(`[KGManagerV2.openNodes] Found ${foundNodes.length} nodes.`);
        return foundNodes.map((node: any) => {
            return {
                node_id: node.id,
                name: node.name,
                entityType: node.entityType,
                observations: node.observations || []
            };
        });
    }

    async queryNaturalLanguage(agentId: string, naturalLanguageQuery: string): Promise<string> {
        console.log(`[KGManagerV2.queryNaturalLanguage] AgentID: ${agentId}, NLQ: "${naturalLanguageQuery}"`);

        if (!this.geminiService) {
            console.warn("[KGManagerV2.queryNaturalLanguage] GeminiService not available. Using NLPQueryProcessor as fallback.");
            const structuredQueryByNlp = this.nlpQueryProcessor.generateStructuredQuery(naturalLanguageQuery);
            console.log("[KGManagerV2.queryNaturalLanguage] NLP Fallback - Structured Query:", JSON.stringify(structuredQueryByNlp));
            const queryResult = await this.queryEngine.executeQuery(structuredQueryByNlp, agentId);
            console.log("[KGManagerV2.queryNaturalLanguage] NLP Fallback - Query Result Count:", queryResult.nodes.length);
            return JSON.stringify({
                metadata: {
                    originalQuery: naturalLanguageQuery,
                    translatedOperation: structuredQueryByNlp.type,
                    translatedArgs: structuredQueryByNlp,
                    usedGemini: false
                },
                results: queryResult.nodes
            }, null, 2);
        }

        let graphData;
        let graphRepresentation = "{}";
        try {
            graphData = await this.readGraph(agentId);
            if (graphData && (graphData.nodes.length > 0 || graphData.relations.length > 0)) {
                const nodesForPrompt = graphData.nodes.map(n => ({
                    id: n.id, name: n.name, entityType: n.entityType,
                    observations: n.observations?.slice(0, 3).map((o: string) => o.substring(0, 70) + (o.length > 70 ? '...' : '')) // Limit obs count and length
                })).slice(0, 50); // Limit number of nodes in prompt
                const relationsForPrompt = graphData.relations.slice(0,50); // Limit relations
                graphRepresentation = JSON.stringify({nodes: nodesForPrompt, relations: relationsForPrompt}, null, 2);
            }
            console.log(`[KGManagerV2.queryNaturalLanguage] Graph Representation for Gemini (length: ${graphRepresentation.length}): ${graphRepresentation.substring(0, 300)}...`);
        } catch (e) {
            console.error(`[KGManagerV2.queryNaturalLanguage] Error reading graph for agent ${agentId}:`, e);
        }
        
        if (graphRepresentation.length > this.MAX_PROMPT_GRAPH_LENGTH) {
            console.warn(`[KGManagerV2.queryNaturalLanguage] Graph representation is too large (${graphRepresentation.length} chars). Sending a summarized version.`);
            const nodeSchemaExample = graphData?.nodes[0] ? `Example Node: ${JSON.stringify(Object.keys(graphData.nodes[0]))}` : "Nodes have id, name, entityType, observations (array of strings).";
            const relationSchemaExample = graphData?.relations[0] ? `Example Relation: ${JSON.stringify(Object.keys(graphData.relations[0]))}` : "Relations have id, fromNodeId, toNodeId, relationType.";
            graphRepresentation = `Graph is too large to display fully. 
Node Schema: ${nodeSchemaExample}
Relation Schema: ${relationSchemaExample}
Total Nodes: ${graphData?.nodes.length || 0}, Total Relations: ${graphData?.relations.length || 0}`;
            console.log(`[KGManagerV2.queryNaturalLanguage] Summarized Graph Representation for Gemini: ${graphRepresentation}`);
        }

        const prompt = `You are an expert in translating natural language questions about software codebases into structured queries for a knowledge graph.
The knowledge graph contains nodes representing files, directories, functions, classes, interfaces, modules, and variables.
Node observations often include 'absolute_path', 'language', 'signature', 'lines', 'defined_in_file'.
Key relation types include: 'contains_item' (directory to file/subdir), 'imports_file' (file to file), 'imports_module' (file to module), 'defined_in_file' (code entity to file), 'has_method' (class to method), 'calls_function', 'uses_class'.

Given the following knowledge graph structure (or a summary if the graph is large) and a natural language query, translate the natural language query into a structured query JSON object.
The structured query JSON should have an "operation" field and an "args" field.

Supported operations and their 'args' structure:
1. 'search_nodes': args = { "query": "key:value key2:value2 ..." }
   - This is the PREFERRED operation for most specific searches.
   - The "query" string for 'search_nodes' should use key:value pairs.
   - Supported keys:
     - 'entityType:<type>' (e.g., entityType:function, entityType:file)
     - 'name:<text_to_contain_in_name>' (e.g., name:userService)
     - 'file:<file_path_condition>' (e.g., file:src/services/user.ts) - this will match nodes representing the file or entities observed to be related to this file.
     - 'obs:<text_to_contain_in_observations>' (e.g., obs:authenticate) - can be repeated for multiple observation conditions.
     - 'id:<exact_node_id>'
     - 'limit:<number>'
   - Combine multiple key:value pairs with spaces. Values with spaces should be double-quoted, e.g., file:"path with spaces/file.ts".
   - Example: "entityType:function file:src/utils.ts obs:format"
   - Example: "name:controller limit:5"

2. 'open_nodes': args = { "names": ["exact_node_name1", "exact_node_name2"] }
   - Use for fetching specific nodes if their exact names are known from the NLQ.

3. 'graph_traversal': args = { "start_node": "node_name", "relation_types": ["relation1", "relation2"], "depth": number }
   - Use for queries about connections or paths (e.g., "what does X import?", "functions called by Y").

4. 'read_graph': args = {}
   - Use only if the query is very general like "show me the graph" or "list everything". Avoid for specific queries.

Knowledge Graph Structure (or summary):
---
${graphRepresentation}
---

Natural Language Query: "${naturalLanguageQuery}"

---
Instructions for translation:
1. Analyze the NLQ and choose the most appropriate "operation".
2. If using 'search_nodes', formulate the "query" string using the specified key:value pairs. Be precise.
3. If the NLQ implies exact names, consider 'open_nodes'.
4. If the NLQ is about relationships or paths, use 'graph_traversal'.
5. If the query is very broad and asks for the entire graph, use 'read_graph'.
6. If the NLQ cannot be reasonably translated to one of these operations or if necessary information (like a start node for traversal) is missing and cannot be inferred, return:
   { "operation": "error", "args": { "message": "Could not translate query: [brief explanation]" } }

Translate the above Natural Language Query into the structured JSON format. Provide ONLY the JSON object.
`;

        let structuredQueryFromAI: any;
        let usedGemini = false;
        try {
            const geminiResponse = await this.geminiService.askGemini(prompt, "gemini-1.5-flash-latest");
            usedGemini = true;
            const geminiResponseText = geminiResponse.content[0]?.text?.trim() || "";
            console.log("[KGManagerV2.queryNaturalLanguage] Gemini Raw Response Text:", geminiResponseText);

            let jsonToParse = geminiResponseText;
            const jsonMatch = geminiResponseText.match(/```json\n([\s\S]*?)\n```/);
            if (jsonMatch && jsonMatch[1]) {
                jsonToParse = jsonMatch[1].trim();
            } else if (!jsonToParse.startsWith("{") || !jsonToParse.endsWith("}")) {
                const firstBrace = jsonToParse.indexOf('{');
                const lastBrace = jsonToParse.lastIndexOf('}');
                if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                    jsonToParse = jsonToParse.substring(firstBrace, lastBrace + 1);
                } else {
                    throw new Error("Response from Gemini was not in a recognizable JSON format and could not be extracted.");
                }
            }
            jsonToParse = jsonToParse.replace(/,\s*([}\]])/g, '$1');

            structuredQueryFromAI = JSON.parse(jsonToParse);
            console.log("[KGManagerV2.queryNaturalLanguage] Gemini Parsed Structured Query:", JSON.stringify(structuredQueryFromAI));

            if (structuredQueryFromAI.operation === 'error') {
                console.warn(`[KGManagerV2.queryNaturalLanguage] Gemini reported error in translation: ${structuredQueryFromAI.args?.message}`);
                return JSON.stringify({
                    metadata: { originalQuery: naturalLanguageQuery, translatedOperation: 'error', translatedArgs: structuredQueryFromAI.args, usedGemini },
                    results: { error: structuredQueryFromAI.args?.message || "Gemini could not translate the query." }
                }, null, 2);
            }
        } catch (e: any) {
            console.error(`[KGManagerV2.queryNaturalLanguage] Error processing Gemini response or Gemini call failed:`, e);
            console.warn("[KGManagerV2.queryNaturalLanguage] Falling back to local NLPQueryProcessor due to Gemini error.");
            structuredQueryFromAI = this.nlpQueryProcessor.generateStructuredQuery(naturalLanguageQuery);
            usedGemini = false;
            console.log("[KGManagerV2.queryNaturalLanguage] NLP Fallback - Structured Query:", JSON.stringify(structuredQueryFromAI));
        }

        let queryResultData: any;
        const operationToExecute = structuredQueryFromAI.operation || structuredQueryFromAI.type;
        const argsForOperation = structuredQueryFromAI.args || structuredQueryFromAI;

        console.log(`[KGManagerV2.queryNaturalLanguage] Attempting to execute operation: "${operationToExecute}" with args:`, JSON.stringify(argsForOperation));

        switch (operationToExecute) {
            case 'search_nodes':
                if (argsForOperation && typeof argsForOperation.query === 'string') {
                    console.log(`[KGManagerV2.queryNaturalLanguage] Executing 'search_nodes' with query: "${argsForOperation.query}"`);
                    queryResultData = await this.searchNodes(agentId, argsForOperation.query);
                } else {
                     console.error("[KGManagerV2.queryNaturalLanguage] Invalid args for 'search_nodes': 'query' string missing or invalid.");
                     queryResultData = { error: "Invalid arguments for search_nodes operation from AI." };
                }
                break;
            case 'open_nodes':
                if (argsForOperation && Array.isArray(argsForOperation.names)) {
                    queryResultData = await this.openNodes(agentId, argsForOperation.names);
                } else {
                    queryResultData = { error: "Invalid arguments for open_nodes operation from AI." };
                }
                break;
            case 'graph_traversal':
                 if (argsForOperation && argsForOperation.start_node && Array.isArray(argsForOperation.relation_types) && typeof argsForOperation.depth === 'number') {
                    queryResultData = await this.traverseGraph(agentId, argsForOperation.start_node, argsForOperation.relation_types, argsForOperation.depth);
                } else {
                     queryResultData = { error: "Invalid arguments for graph_traversal operation from AI." };
                }
                break;
            case 'read_graph':
                queryResultData = await this.readGraph(agentId);
                break;
            default:
                // Fallback for structured queries from NLP that might not have an "operation" field
                // but a "type" field (like the output of nlpQueryProcessor.generateStructuredQuery)
                if (typeof argsForOperation === 'object' && argsForOperation.type) {
                    console.log("[KGManagerV2.queryNaturalLanguage] Attempting direct QueryEngine execution for NLP-style structured query:", JSON.stringify(argsForOperation));
                    const directResult = await this.queryEngine.executeQuery(argsForOperation as QueryAST, agentId);
                    queryResultData = directResult.nodes; // Assuming executeQuery returns { nodes: [] }
                } else {
                    console.error("[KGManagerV2.queryNaturalLanguage] Unhandled structured query operation or format:", JSON.stringify(structuredQueryFromAI));
                    throw new McpError(ErrorCode.InvalidParams, `Unhandled structured query operation: ${operationToExecute}`);
                }
        }
        
        const finalResultCount = Array.isArray(queryResultData) ? queryResultData.length : (queryResultData?.nodes?.length !== undefined ? queryResultData.nodes.length : (queryResultData?.error ? 'Error' : 'N/A (object)'));
        console.log(`[KGManagerV2.queryNaturalLanguage] Final Query Result Count (before stringify): ${finalResultCount}`);

        return JSON.stringify({
            metadata: {
                originalQuery: naturalLanguageQuery,
                translatedOperation: operationToExecute,
                translatedArgs: argsForOperation,
                usedGemini
            },
            results: queryResultData
        }, null, 2);
    }

    async inferRelations(agentId: string, entityNames?: string[], context?: string): Promise<{ message: string; details: any[] }> {
        console.log(`[KGManagerV2.inferRelations] Agent: ${agentId}, Entities: ${entityNames?.join(', ')}, Context: ${context}`);
        const {nodes: allNodes, relations: existingRelations} = await this.readGraph(agentId);
        
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
            contextForGemini += `- Name: ${n.name}, Type: ${n.entityType}, Observations: ${(n.observations || []).join(', ').substring(0,100)}\n`;
        });

        if (existingRelations.length > 0) {
            contextForGemini += "\nSome Existing Relations (for context):\n";
             existingRelations.slice(0, 10).forEach(r => {
                const fromNode = allNodes.find(n => n.id === r.fromNodeId);
                const toNode = allNodes.find(n => n.id === r.toNodeId);
                if (fromNode && toNode) {
                    contextForGemini += `- ${fromNode.name} --(${r.relationType})--> ${toNode.name}\n`;
                }
            });
        }
        if (context) {
            contextForGemini += `\nUser Provided Context: ${context}\n`;
        }

        const prompt = `
Analyze the provided node information and existing relations.
Your goal is to infer NEW, meaningful relationships between the TARGET NODES.
Focus on common software relationships like: 'calls', 'uses', 'imports', 'exports', 'extends', 'implements', 'defined_in', 'related_to_feature', 'tests_file'.

For each proposed new relation:
- It must be between two of the TARGET NODES provided, or between a TARGET NODE and an EXISTING node if contextually relevant.
- It must NOT already exist in the 'Existing Relations' list.
- Provide 'from' (source node name), 'to' (target node name), 'relationType', 'confidence' (0.0-1.0), and brief 'evidence' (max 20 words).

Context:
---
${contextForGemini}
---

Output ONLY a JSON array of proposed new relations. Example:
[
  { "from": "NodeName1", "to": "NodeName2", "relationType": "calls", "confidence": 0.8, "evidence": "NodeName1's observation mentions calling NodeName2." }
]
If no new relations can be confidently inferred, return an empty array [].
`;
        let proposedByAI: Array<{ from: string; to: string; relationType: string; confidence: number; evidence: string }> = [];
        if (this.geminiService) {
            try {
                const geminiResponse = await this.geminiService.askGemini(prompt, "gemini-1.5-flash-latest");
                const responseText = geminiResponse.content[0]?.text?.trim() || "[]";
                let jsonToParse = responseText;
                const jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/);
                if (jsonMatch && jsonMatch[1]) {
                    jsonToParse = jsonMatch[1].trim();
                }
                if (!jsonToParse.startsWith("[")) jsonToParse = "[]"; // Ensure it's an array
                proposedByAI = JSON.parse(jsonToParse);
                if (!Array.isArray(proposedByAI)) proposedByAI = [];
                 console.log(`[KGManagerV2.inferRelations] Gemini proposed ${proposedByAI.length} relations.`);
            } catch (e: any) {
                console.error(`[KGManagerV2.inferRelations] Gemini call failed or parsing error: ${e.message}`);
            }
        }

        const validAIProposals = proposedByAI.filter(prop => {
            const fromNode = targetNodes.find(n => n.name === prop.from) || allNodes.find(n => n.name === prop.from);
            const toNode = targetNodes.find(n => n.name === prop.to) || allNodes.find(n => n.name === prop.to);
            if (!fromNode || !toNode) return false;
            return !existingRelations.some(exRel =>
                exRel.fromNodeId === fromNode.id &&
                exRel.toNodeId === toNode.id &&
                exRel.relationType === prop.relationType
            );
        }).map(p => ({...p, status: 'proposed_by_ai'}));

        const finalProposals = [...validAIProposals];
        let message = `Relation inference complete. Found ${finalProposals.length} potential new relations.`;
        
        const relationsToCreate = finalProposals
            .filter(r => r.confidence >= 0.8)
            .map(r => ({ from: r.from, to: r.to, relationType: r.relationType }));

        if (relationsToCreate.length > 0) {
            try {
                const created = await this.createRelations(agentId, relationsToCreate);
                message += ` Automatically added ${created.length} high-confidence relations.`;
                finalProposals.forEach(fp => {
                    if (fp.confidence >= 0.8 && relationsToCreate.find(rtc => rtc.from === fp.from && rtc.to === fp.to && rtc.relationType === fp.relationType)) {
                        fp.status = 'added_by_ai';
                    }
                });
            } catch (e: any) {
                console.error(`[KGManagerV2.inferRelations] Error auto-adding relations: ${e.message}`);
                message += ` Failed to auto-add ${relationsToCreate.length} high-confidence relations.`;
            }
        }
        console.log(`[KGManagerV2.inferRelations] Final message: ${message}`);
        return { message, details: finalProposals };
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
        const resultNodes: any[] = [];
        const resultRelations: any[] = [];
        const queue: Array<{ nodeId: string; currentDepth: number }> = [{ nodeId: startNode.id, currentDepth: 0 }];

        while (queue.length > 0) {
            const current = queue.shift()!;
            const { nodeId, currentDepth } = current;

            if (visitedNodeIds.has(nodeId) && currentDepth > 0) continue;
            
            const nodeObject = idToNodeMap.get(nodeId);
            if(nodeObject && !resultNodes.some(n => n.id === nodeId)) { // Add if not already in results
                resultNodes.push(nodeObject);
            }
            visitedNodeIds.add(nodeId);

            if (currentDepth >= depth) continue;

            for (const rel of allRelations) {
                if (rel.fromNodeId === nodeId && (!relationTypes || relationTypes.length === 0 || relationTypes.includes(rel.relationType))) {
                    if(!resultRelations.find(rr => rr.id === rel.id)) resultRelations.push(rel); // Add unique relations
                    const toNodeObject = idToNodeMap.get(rel.toNodeId);
                    if (toNodeObject && !visitedNodeIds.has(rel.toNodeId)) { // Only queue if not fully visited
                        queue.push({ nodeId: rel.toNodeId, currentDepth: currentDepth + 1 });
                    }
                }
            }
        }
        console.log(`[KGManagerV2.traverseGraph] Traversal found ${resultNodes.length} nodes and ${resultRelations.length} relations.`);
        return { nodes: resultNodes, relations: resultRelations };
    }

    async generateMermaidGraph(agentId: string, options: { query?: string; layoutDirection?: string; depth?: number; includeLegend?: boolean; groupByDirectory?: boolean, maxNodes?: number, maxEdges?: number }): Promise<string> {
        console.log(`[KGManagerV2.generateMermaidGraph] Agent: ${agentId}, Options:`, options);
        const { query, layoutDirection = 'TD', includeLegend = true, groupByDirectory = false, maxNodes = 100, maxEdges = 200 } = options;
        
        let graphNodes: any[] = [];
        let graphRelations: any[] = [];

        if (query) {
            console.log(`[KGManagerV2.generateMermaidGraph] Filtering graph with query: "${query}"`);
            const searchResults = await this.searchNodes(agentId, query); // Uses QueryEngine
            graphNodes = Array.isArray(searchResults) ? searchResults.map(n => ({ ...n, id: n.node_id })) : [];
            if (graphNodes.length > maxNodes) {
                graphNodes = graphNodes.slice(0, maxNodes);
            }
            const nodeIds = new Set(graphNodes.map((n: any) => n.id));
            const allAgentRelations = (await this.jsonlStorage.readAllLines(this.getAgentRelationsPath(agentId))).filter((r: any) => r && !r.deleted);
            graphRelations = Array.isArray(allAgentRelations) ? allAgentRelations.filter((r: any) => nodeIds.has(r.fromNodeId) && nodeIds.has(r.toNodeId)) : [];
            if (graphRelations.length > maxEdges) {
                graphRelations = graphRelations.slice(0, maxEdges);
            }
            if (!Array.isArray(graphNodes) || graphNodes.length === 0) return `graph ${layoutDirection}\n    message["No nodes found matching query: '${query}'"]`;
        } else {
            const fullGraph = await this.readGraph(agentId);
            graphNodes = Array.isArray(fullGraph.nodes) ? fullGraph.nodes.slice(0, maxNodes) : [];
            graphRelations = Array.isArray(fullGraph.relations) ? fullGraph.relations.slice(0, maxEdges) : [];
            if (graphNodes.length === 0) return `graph ${layoutDirection}\n    A["Knowledge graph is empty for agent ${agentId}"]`;
        }
        console.log(`[KGManagerV2.generateMermaidGraph] Visualizing ${graphNodes.length} nodes and ${graphRelations.length} relations.`);

        let mermaid = `graph ${layoutDirection}\n`;
        const idToLabel: Record<string, string> = {};
        // Defensive: always define styles and shapes with defaults
        const styles: Record<string, string> = {
            file: 'fill:#f9f,stroke:#333,stroke-width:2px',
            directory: 'fill:#bbf,stroke:#333,stroke-width:2px',
            function: 'fill:#bfb,stroke:#333,stroke-width:2px',
            class: 'fill:#ffb,stroke:#333,stroke-width:2px',
            interface: 'fill:#bff,stroke:#333,stroke-width:2px',
            module: 'fill:#fbf,stroke:#333,stroke-width:2px',
            variable: 'fill:#eee,stroke:#333,stroke-width:2px',
            default: 'fill:#fff,stroke:#333,stroke-width:2px'
        };
        const shapes: Record<string, [string, string]> = {
            file: ['[', ']'],
            directory: ['([', '])'],
            function: ['(', ')'],
            class: ['{{', '}}'],
            interface: ['<', '>'],
            module: ['{{', '}}'],
            variable: ['(', ')'],
            default: ['[', ']']
        };

        // (Rest of the Mermaid generation logic, ensure 'id' is used for idToLabel mapping)
        if (groupByDirectory) {
            const nodesByDir: Record<string, any[]> = {};
            if (Array.isArray(graphNodes)) {
                for (const n of graphNodes) {
                    const nodeName = n.name || n.id;
                    const dir = nodeName && typeof nodeName === 'string' && nodeName.includes('/') ? path.dirname(nodeName) : '.';
                    if (!nodesByDir[dir]) nodesByDir[dir] = [];
                    nodesByDir[dir].push(n);
                }
            }
            for (const dir in nodesByDir) {
                const subgraphId = dir.replace(/[^a-zA-Z0-9_]/g, '_') || 'root';
                mermaid += `    subgraph ${subgraphId} ["${dir}"]\n`;
                const dirNodes = Array.isArray(nodesByDir[dir]) ? nodesByDir[dir] : [];
                for (const n of dirNodes) {
                    const nodeId = n.id; // Use 'id'
                    const nodeName = n.name || nodeId;
                    const nodeLabel = nodeName.replace(/[^a-zA-Z0-9_./-]/g, '_');
                    idToLabel[nodeId] = nodeLabel;
                    const [openS, closeS] = (n.entityType && shapes[n.entityType]) ? shapes[n.entityType] : shapes.default;
                    mermaid += `        ${nodeLabel}${openS}"${nodeName} (${n.entityType || 'unknown'})"${closeS}\n`;
                    mermaid += `        style ${nodeLabel} ${(n.entityType && styles[n.entityType]) ? styles[n.entityType] : styles.default}\n`;
                }
                mermaid += `    end\n`;
            }
        } else {
            if (Array.isArray(graphNodes)) {
                for (const n of graphNodes) {
                    const nodeId = n.id;
                    const nodeName = n.name || nodeId;
                    const nodeLabel = nodeName.replace(/[^a-zA-Z0-9_./-]/g, '_');
                    idToLabel[nodeId] = nodeLabel;
                    const [openS, closeS] = (n.entityType && shapes[n.entityType]) ? shapes[n.entityType] : shapes.default;
                    mermaid += `    ${nodeLabel}${openS}"${nodeName} (${n.entityType || 'unknown'})"${closeS}\n`;
                    mermaid += `    style ${nodeLabel} ${(n.entityType && styles[n.entityType]) ? styles[n.entityType] : styles.default}\n`;
                }
            }
        }
        if (Array.isArray(graphRelations)) {
            for (const r of graphRelations) {
                const fromLabel = idToLabel[r.fromNodeId];
                const toLabel = idToLabel[r.toNodeId];
                if (fromLabel && toLabel) {
                    mermaid += `    ${fromLabel} -- "${r.relationType}" --> ${toLabel}\n`;
                }
            }
        }
        // ... (Legend logic) ...
        if (includeLegend) {
            mermaid += '\n    subgraph LEGEND\n';
            mermaid += '        direction LR\n';
            let i=0;
            for(const type in shapes){
                if(type === 'default') continue;
                const [openS, closeS] = shapes[type];
                const styleVal = styles[type]; // Renamed to avoid conflict
                mermaid += `        L${i}${openS}"${type.toUpperCase()}"${closeS}\n`;
                mermaid += `        style L${i} ${styleVal}\n`;
                i++;
            }
            mermaid += '    end\n';
        }
        if (graphNodes.length === maxNodes || graphRelations.length === maxEdges) {
            mermaid += `\n    %% Diagram truncated: reached node/edge limit (${maxNodes} nodes, ${maxEdges} edges)\n`;
        }
        return mermaid;
    }
}
