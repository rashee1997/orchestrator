import path from 'path';
import { fileURLToPath } from 'url';
import { JsonlStorageManager } from '../storage/JsonlStorageManager.js';
import { EventStore, KnowledgeGraphEvent } from '../storage/EventStore.js';
import { IndexManager } from '../storage/IndexManager.js';
import { LRUCache } from 'lru-cache';
import { randomUUID } from 'crypto';
import { QueryEngine } from '../query/QueryEngine.js';
import { FuzzySearchEngine } from '../search/FuzzySearchEngine.js';
import { KnowledgeGraphCache } from '../cache/KnowledgeGraphCache.js';
import { EntityResolver } from '../ai/EntityResolver.js';
import { NLPQueryProcessor } from '../ai/NLPQueryProcessor.js';
import { GeminiIntegrationService } from '../services/GeminiIntegrationService.js';

/**
 * KnowledgeGraphManagerV2 implements the new JSONL-based storage for the knowledge graph.
 *
 * For dual-mode operation during transition (Phase 2.2 of the plan), a higher-level
 * factory or configuration mechanism would be needed to switch between
 * KnowledgeGraphManager (SQLite) and KnowledgeGraphManagerV2 (JSONL).
 * This could involve:
 * - A global configuration flag (e.g., `USE_JSONL_KG = true/false`).
 * - A factory function that returns the appropriate manager instance based on the flag.
 * - Gradual rollout using feature flags in the application's entry point.
 */
export class KnowledgeGraphManagerV2 {
    private jsonlStorage: JsonlStorageManager;
    private eventStore: EventStore;
    private indexManager: IndexManager;
    private cache: KnowledgeGraphCache; // Use the dedicated cache
    private queryEngine: QueryEngine;
    private fuzzySearchEngine: FuzzySearchEngine;
    private entityResolver: EntityResolver;
    private nlpQueryProcessor: NLPQueryProcessor;
    private geminiService?: GeminiIntegrationService;

    constructor(rootPath?: string, geminiService?: GeminiIntegrationService) {
        // If no rootPath provided, calculate it relative to the project root
        if (!rootPath) {
            const __filename = fileURLToPath(import.meta.url);
            const __dirname = path.dirname(__filename);
            const projectRoot = path.resolve(__dirname, '..', '..', '..');
            rootPath = path.join(projectRoot, 'knowledge_graphs');
        }
        this.jsonlStorage = new JsonlStorageManager(rootPath);
        this.eventStore = new EventStore(this.jsonlStorage);
        this.indexManager = new IndexManager(this.jsonlStorage);
        this.cache = new KnowledgeGraphCache(); // Instantiate dedicated cache
        this.queryEngine = new QueryEngine(this.jsonlStorage);
        this.fuzzySearchEngine = new FuzzySearchEngine();
        this.entityResolver = new EntityResolver();
        this.nlpQueryProcessor = new NLPQueryProcessor();
        this.geminiService = geminiService;
    }

    private getAgentNodesPath(agentId: string): string {
        return path.join(agentId, 'nodes.jsonl');
    }

    private getAgentRelationsPath(agentId: string): string {
        return path.join(agentId, 'relations.jsonl');
    }

    async createEntities(agentId: string, entities: Array<{ name: string; entityType: string; observations?: string[] }>): Promise<any[]> {
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
            this.cache.invalidateAgent(agentId); // Invalidate cache using dedicated method
            createdEntities.push(newNode);
        }
        // Rebuild indexes after creating entities
        await this.indexManager.rebuildAllIndexes(agentId);
        return createdEntities;
    }

    async createRelations(agentId: string, relations: Array<{ from: string; to: string; relationType: string }>): Promise<any[]> {
        const createdRelations = [];
        const nodes = await this.jsonlStorage.readAllLines(this.getAgentNodesPath(agentId));
        const nameToIdMap = new Map(nodes.map((node: any) => [node.name, node.id]));

        for (const relation of relations) {
            const fromNodeId = nameToIdMap.get(relation.from);
            const toNodeId = nameToIdMap.get(relation.to);

            if (!fromNodeId || !toNodeId) {
                console.warn(`Skipping relation creation: One or both nodes not found for relation ${relation.from} -- ${relation.relationType} --> ${relation.to}`);
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
            this.cache.invalidateAgent(agentId); // Invalidate cache using dedicated method
            createdRelations.push(newRelation);
        }
        // Rebuild indexes after creating relations
        await this.indexManager.rebuildAllIndexes(agentId);
        return createdRelations;
    }

    async addObservations(agentId: string, observations: Array<{ entityName: string; contents: string[] }>): Promise<any> {
        const nodes = await this.jsonlStorage.readAllLines(this.getAgentNodesPath(agentId));
        const updatedNodes = [];

        for (const obs of observations) {
            const targetNode = nodes.find((node: any) => node.name === obs.entityName && !node.deleted);

            if (!targetNode) {
                throw new Error(`Node with name ${obs.entityName} not found.`);
            }

            const updatedObservations = [...(targetNode.observations || []), ...obs.contents];
            const updatedNode = {
                ...targetNode,
                observations: updatedObservations,
                timestamp: Date.now(),
                version: targetNode.version + 1
            };

            // Mark old entry as deleted and append new version
            targetNode.deleted = true;
            await this.jsonlStorage.appendLine(this.getAgentNodesPath(agentId), targetNode);
            await this.jsonlStorage.appendLine(this.getAgentNodesPath(agentId), updatedNode);
            await this.eventStore.appendEvent(agentId, 'OBSERVATIONS_ADDED', { nodeId: targetNode.id, observations: obs.contents });
            this.cache.invalidateAgent(agentId); // Invalidate cache using dedicated method
            updatedNodes.push(updatedNode);
        }

        await this.indexManager.rebuildAllIndexes(agentId); // Rebuild indexes
        return updatedNodes;
    }

    async deleteEntities(agentId: string, entityNames: string[]): Promise<void> {
        const nodes = await this.jsonlStorage.readAllLines(this.getAgentNodesPath(agentId));
        for (const name of entityNames) {
            const targetNode = nodes.find((node: any) => node.name === name && !node.deleted);
            if (targetNode) {
                targetNode.deleted = true;
                await this.jsonlStorage.appendLine(this.getAgentNodesPath(agentId), targetNode);
                await this.eventStore.appendEvent(agentId, 'NODE_DELETED', { nodeId: targetNode.id, name: targetNode.name });
                this.cache.invalidateAgent(agentId); // Invalidate cache using dedicated method
                await this.indexManager.rebuildAllIndexes(agentId); // Rebuild indexes
            }
        }
    }

    async deleteObservations(agentId: string, deletions: Array<{ entityName: string; observations: string[] }>): Promise<any> {
        const nodes = await this.jsonlStorage.readAllLines(this.getAgentNodesPath(agentId));
        const updatedNodes = [];

        for (const deletion of deletions) {
            const targetNode = nodes.find((node: any) => node.name === deletion.entityName && !node.deleted);

            if (!targetNode) {
                throw new Error(`Node with name ${deletion.entityName} not found.`);
            }

            const updatedObservations = (targetNode.observations || []).filter((obs: string) => !deletion.observations.includes(obs));
            const updatedNode = {
                ...targetNode,
                observations: updatedObservations,
                timestamp: Date.now(),
                version: targetNode.version + 1
            };

            targetNode.deleted = true;
            await this.jsonlStorage.appendLine(this.getAgentNodesPath(agentId), targetNode);
            await this.jsonlStorage.appendLine(this.getAgentNodesPath(agentId), updatedNode);
            await this.eventStore.appendEvent(agentId, 'OBSERVATIONS_REMOVED', { nodeId: targetNode.id, observations: deletion.observations });
            this.cache.invalidateAgent(agentId); // Invalidate cache using dedicated method
            updatedNodes.push(updatedNode);
        }

        await this.indexManager.rebuildAllIndexes(agentId); // Rebuild indexes
        return updatedNodes;
    }

    async deleteRelations(agentId: string, relationsToDelete: Array<{ from: string; to: string; relationType: string }>): Promise<void> {
        const relations = await this.jsonlStorage.readAllLines(this.getAgentRelationsPath(agentId));
        const nodes = await this.jsonlStorage.readAllLines(this.getAgentNodesPath(agentId));
        const nameToIdMap = new Map(nodes.map((node: any) => [node.name, node.id]));

        for (const rel of relationsToDelete) {
            const fromNodeId = nameToIdMap.get(rel.from);
            const toNodeId = nameToIdMap.get(rel.to);

            if (!fromNodeId || !toNodeId) {
                console.warn(`Skipping relation deletion: One or both nodes not found for relation ${rel.from} -- ${rel.relationType} --> ${rel.to}`);
                continue;
            }

            const targetRelation = relations.find((relation: any) =>
                relation.fromNodeId === fromNodeId &&
                relation.toNodeId === toNodeId &&
                relation.relationType === rel.relationType &&
                !relation.deleted
            );

            if (targetRelation) {
                targetRelation.deleted = true;
                await this.jsonlStorage.appendLine(this.getAgentRelationsPath(agentId), targetRelation);
                await this.eventStore.appendEvent(agentId, 'RELATION_DELETED', { relationId: targetRelation.id, from: rel.from, to: rel.to, type: rel.relationType });
                this.cache.invalidateAgent(agentId); // Invalidate cache using dedicated method
                await this.indexManager.rebuildAllIndexes(agentId); // Rebuild indexes
            }
        }
    }

    async readGraph(agentId: string): Promise<{ nodes: any[]; relations: any[] }> {
        const cached = this.cache.getCachedQuery(`graph:${agentId}`);
        if (cached) {
            return cached;
        }

        const nodes = (await this.jsonlStorage.readAllLines(this.getAgentNodesPath(agentId))).filter((n: any) => !n.deleted);
        const relations = (await this.jsonlStorage.readAllLines(this.getAgentRelationsPath(agentId))).filter((r: any) => !r.deleted);
        const result = { nodes, relations };
        this.cache.cacheQuery(`graph:${agentId}`, result);
        return result;
    }

    async searchNodes(agentId: string, query: string): Promise<any[]> {
        const cacheKey = `searchNodes:${agentId}:${query}`;
        const cached = this.cache.getCachedQuery(cacheKey);
        if (cached) {
            return cached;
        }

        const ast = this.queryEngine.parseQuery(query);
        const result = await this.queryEngine.executeQuery(ast, agentId);
        
        // Apply fuzzy search if needed (example integration)
        const allNodes = await this.jsonlStorage.readAllLines(this.getAgentNodesPath(agentId));
        this.fuzzySearchEngine.indexForFuzzySearch(allNodes);
        const fuzzyResults = this.fuzzySearchEngine.search(query);
        
        // Combine results (simple union for now)
        const combinedNodeIds = new Set([...result.nodes.map((n:any) => n.id), ...fuzzyResults]);
        const finalNodes = allNodes.filter((node:any) => combinedNodeIds.has(node.id) && !node.deleted);

        const mappedResult = finalNodes.map((node: any) => {
            let observations = [];
            try {
                observations = node.observations || [];
            } catch {
                observations = [];
            }
            return {
                node_id: node.id,
                name: node.name,
                entityType: node.entityType,
                observations: observations
            };
        });
        this.cache.cacheQuery(cacheKey, mappedResult);
        return mappedResult;
    }

    async openNodes(agentId: string, names: string[]): Promise<any[]> {
        const allNodes = await this.jsonlStorage.readAllLines(this.getAgentNodesPath(agentId));
        const foundNodes = allNodes.filter((node: any) => names.includes(node.name) && !node.deleted);
        return foundNodes.map((node: any) => {
            let observations = [];
            try {
                observations = node.observations || [];
            } catch {
                observations = [];
            }
            return {
                node_id: node.id,
                name: node.name,
                entityType: node.entityType,
                observations: observations
            };
        });
    }

    // Natural language query (delegating to Gemini if available, else NLPQueryProcessor)
    async queryNaturalLanguage(agentId: string, naturalLanguageQuery: string): Promise<string> {
        let structuredQuery: any;
        let usedGemini = false;
        if (this.geminiService) {
            try {
                // Use Gemini to generate a structured query
                structuredQuery = await this.geminiService.generateStructuredQueryFromNaturalLanguage(naturalLanguageQuery);
                usedGemini = true;
            } catch (e) {
                // Fallback to local NLP if Gemini fails
                structuredQuery = this.nlpQueryProcessor.generateStructuredQuery(naturalLanguageQuery);
            }
        } else {
            structuredQuery = this.nlpQueryProcessor.generateStructuredQuery(naturalLanguageQuery);
        }
        // For simplicity, if structuredQuery is just a passthrough, use searchNodes
        if (structuredQuery.type === 'unstructured') {
            const results = await this.searchNodes(agentId, naturalLanguageQuery);
            return JSON.stringify({
                metadata: {
                    originalQuery: naturalLanguageQuery,
                    translatedOperation: 'search_nodes',
                    translatedArgs: { query: naturalLanguageQuery },
                    usedGemini
                },
                results
            }, null, 2);
        }
        // Execute the structured query via QueryEngine
        const queryResult = await this.queryEngine.executeQuery(structuredQuery, agentId);
        return JSON.stringify({
            metadata: {
                originalQuery: naturalLanguageQuery,
                translatedOperation: structuredQuery.type,
                translatedArgs: structuredQuery,
                usedGemini
            },
            results: queryResult.nodes // Assuming queryResult has a nodes property
        }, null, 2);
    }

    // Relation inference with AI-powered analysis
    async inferRelations(agentId: string, entityNames?: string[], context?: string): Promise<{ message: string; details: any[] }> {
        const nodes = (await this.jsonlStorage.readAllLines(this.getAgentNodesPath(agentId))).filter((n: any) => !n.deleted);
        const existingRelations = (await this.jsonlStorage.readAllLines(this.getAgentRelationsPath(agentId))).filter((r: any) => !r.deleted);
        
        // Filter nodes if specific entities are requested
        let targetNodes = nodes;
        if (entityNames && entityNames.length > 0) {
            targetNodes = nodes.filter((n: any) => entityNames.includes(n.name));
        }
        
        const inferredRelations: any[] = [];
        
        // Basic rule-based inference for code relationships
        for (const node of targetNodes) {
            // Infer file-to-file relationships based on naming patterns
            if (node.entityType === 'file') {
                const baseName = node.name.replace(/\.(ts|js|tsx|jsx)$/, '');
                
                // Look for test files
                if (baseName.includes('.test') || baseName.includes('.spec')) {
                    const targetFile = baseName.replace(/\.(test|spec)/, '');
                    const targetNode = nodes.find((n: any) => n.name.includes(targetFile) && n.entityType === 'file' && !n.name.includes('.test') && !n.name.includes('.spec'));
                    if (targetNode) {
                        inferredRelations.push({
                            from: node.name,
                            to: targetNode.name,
                            relationType: 'tests_file',
                            confidence: 0.9,
                            evidence: 'Test file naming convention',
                            status: 'proposed'
                        });
                    }
                }
                
                // Look for interface/implementation patterns
                if (baseName.includes('interface') || baseName.startsWith('I')) {
                    const implName = baseName.replace(/^I/, '').replace('interface', '');
                    const implNode = nodes.find((n: any) => n.name.includes(implName) && n.entityType === 'file' && n.name !== node.name);
                    if (implNode) {
                        inferredRelations.push({
                            from: implNode.name,
                            to: node.name,
                            relationType: 'implements_interface',
                            confidence: 0.7,
                            evidence: 'Interface/implementation naming pattern',
                            status: 'proposed'
                        });
                    }
                }
            }
            
            // Infer class relationships
            if (node.entityType === 'class') {
                // Look for factory pattern
                if (node.name.includes('Factory')) {
                    const targetClassName = node.name.replace('Factory', '');
                    const targetClass = nodes.find((n: any) => n.name === targetClassName && n.entityType === 'class');
                    if (targetClass) {
                        inferredRelations.push({
                            from: node.name,
                            to: targetClass.name,
                            relationType: 'creates_instances_of',
                            confidence: 0.85,
                            evidence: 'Factory pattern naming',
                            status: 'proposed'
                        });
                    }
                }
                
                // Look for manager/service relationships
                if (node.name.includes('Manager') || node.name.includes('Service')) {
                    const relatedNodes = nodes.filter((n: any) => 
                        n.entityType === 'class' && 
                        n.name !== node.name &&
                        (node.name.includes(n.name.replace('Manager', '').replace('Service', '')) ||
                         n.name.includes(node.name.replace('Manager', '').replace('Service', '')))
                    );
                    
                    for (const related of relatedNodes) {
                        inferredRelations.push({
                            from: node.name,
                            to: related.name,
                            relationType: 'manages',
                            confidence: 0.6,
                            evidence: 'Manager/Service naming pattern',
                            status: 'proposed'
                        });
                    }
                }
            }
            
            // Infer function relationships based on naming
            if (node.entityType === 'function') {
                // Handler functions
                if (node.name.includes('Handler') || node.name.startsWith('handle')) {
                    const eventName = node.name.replace('Handler', '').replace('handle', '');
                    const relatedNodes = nodes.filter((n: any) => 
                        n.name.includes(eventName) && 
                        n.name !== node.name &&
                        (n.entityType === 'function' || n.entityType === 'class')
                    );
                    
                    for (const related of relatedNodes) {
                        inferredRelations.push({
                            from: node.name,
                            to: related.name,
                            relationType: 'handles_events_from',
                            confidence: 0.65,
                            evidence: 'Handler function naming pattern',
                            status: 'proposed'
                        });
                    }
                }
            }
        }
        
        // Check for duplicates with existing relations
        const finalRelations = inferredRelations.filter(inferred => {
            return !existingRelations.some((existing: any) => {
                const fromNode = nodes.find((n: any) => n.name === inferred.from);
                const toNode = nodes.find((n: any) => n.name === inferred.to);
                return fromNode && toNode &&
                       existing.fromNodeId === fromNode.id &&
                       existing.toNodeId === toNode.id &&
                       existing.relationType === inferred.relationType;
            });
        });
        
        // Auto-add high confidence relations
        const highConfidenceRelations = finalRelations.filter(r => r.confidence >= 0.8);
        if (highConfidenceRelations.length > 0) {
            try {
                await this.createRelations(agentId, highConfidenceRelations.map(r => ({
                    from: r.from,
                    to: r.to,
                    relationType: r.relationType
                })));
                highConfidenceRelations.forEach(r => r.status = 'added');
            } catch (e) {
                console.error('Failed to auto-add high confidence relations:', e);
                highConfidenceRelations.forEach(r => r.status = 'failed');
            }
        }
        
        return {
            message: `Inferred ${finalRelations.length} potential relations (${highConfidenceRelations.length} auto-added)`,
            details: finalRelations
        };
    }

    // Graph traversal (BFS by relation type and depth) - no change needed, already uses jsonlStorage
    async traverseGraph(agentId: string, startNodeName: string, relationTypes: string[], depth: number): Promise<any> {
        const nodes = (await this.jsonlStorage.readAllLines(this.getAgentNodesPath(agentId))).filter((n: any) => !n.deleted);
        const rels = (await this.jsonlStorage.readAllLines(this.getAgentRelationsPath(agentId))).filter((r: any) => !r.deleted);
        const nameToNode = Object.fromEntries(nodes.map((n: any) => [n.name, n]));
        const idToNode = Object.fromEntries(nodes.map((n: any) => [n.id, n]));
        const startNode = nameToNode[startNodeName];
        if (!startNode) return { nodes: [], relations: [] };
        const visited = new Set<string>();
        const queue: Array<{ id: string; d: number }> = [{ id: startNode.id, d: 0 }];
        const resultNodes: any[] = [];
        const resultRels: any[] = [];
        while (queue.length > 0) {
            const { id, d } = queue.shift()!;
            if (visited.has(id) || d > depth) continue;
            visited.add(id);
            resultNodes.push(idToNode[id]);
            for (const rel of rels) {
                if (rel.fromNodeId === id && relationTypes.includes(rel.relationType)) {
                    resultRels.push(rel);
                    if (!visited.has(rel.toNodeId)) {
                        queue.push({ id: rel.toNodeId, d: d + 1 });
                    }
                }
            }
        }
        return { nodes: resultNodes, relations: resultRels };
    }

    // Visualization (Mermaid) - no change needed, already uses jsonlStorage
    async generateMermaidGraph(agentId: string, options: { query?: string; layoutDirection?: string; depth?: number; includeLegend?: boolean; groupByDirectory?: boolean }): Promise<string> {
        const { query, layoutDirection = 'TD', depth = 2, includeLegend = true } = options;
        let nodes = (await this.jsonlStorage.readAllLines(this.getAgentNodesPath(agentId))).filter((n: any) => !n.deleted);
        let relations = (await this.jsonlStorage.readAllLines(this.getAgentRelationsPath(agentId))).filter((r: any) => !r.deleted);
        if (query) {
            nodes = nodes.filter((n: any) => n.name.includes(query) || n.entityType.includes(query));
            const nodeIds = new Set(nodes.map((n: any) => n.id));
            relations = relations.filter((r: any) => nodeIds.has(r.fromNodeId) && nodeIds.has(r.toNodeId));
        }
        if (nodes.length === 0) return `graph ${layoutDirection}\n    A[No nodes found]`;
        let mermaid = `graph ${layoutDirection}\n`;
        const idToLabel: Record<string, string> = {};
        for (const n of nodes) {
            const label = n.name.replace(/[^a-zA-Z0-9_]/g, '_');
            idToLabel[n.id] = label;
            mermaid += `    ${label}["${n.name} (${n.entityType})"]\n`;
        }
        for (const r of relations) {
            const from = idToLabel[r.fromNodeId];
            const to = idToLabel[r.toNodeId];
            if (from && to) {
                mermaid += `    ${from} --|${r.relationType}|--> ${to}\n`;
            }
        }
        if (includeLegend) {
            mermaid += '\n%% Node: [name (type)]\n%% Edge: --|relationType|-->';
        }
        return mermaid;
    }
}
