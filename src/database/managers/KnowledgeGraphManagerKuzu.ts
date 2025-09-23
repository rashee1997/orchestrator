import { randomUUID } from 'crypto';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { KuzuStorageManager, KuzuNode, KuzuRelation } from '../storage/KuzuStorageManager.js';
import { GeminiIntegrationService } from '../services/GeminiIntegrationService.js';
import { CodebaseEmbeddingService } from '../services/CodebaseEmbeddingService.js';
import { parseGeminiJsonResponseSync, parseGeminiJsonResponse } from '../services/gemini-integration-modules/GeminiResponseParsers.js';
import { getCurrentModel } from '../services/gemini-integration-modules/GeminiConfig.js';
import { ENHANCED_KG_NL_TRANSLATION_PROMPT, KG_STRUCTURE_UNDERSTANDING_PROMPT } from '../services/gemini-integration-modules/GeminiPromptTemplates.js';
import { MemoryManager } from '../memory_manager.js';

interface GraphTraversalNode {
    node_id: string;
    name: string;
    entityType: string;
    observations?: string[];
    [key: string]: unknown;
}

interface GraphTraversalRelation {
    relation_id?: string;
    relationType: string;
    fromNodeId?: string;
    toNodeId?: string;
    from?: string;
    to?: string;
    [key: string]: unknown;
}

export class KnowledgeGraphManagerKuzu {
    private kuzuStorage: KuzuStorageManager;
    private geminiService?: GeminiIntegrationService;
    private embeddingService?: CodebaseEmbeddingService;
    private memoryManager?: MemoryManager;

    private readonly nodeTableName = 'KGNode';
    private readonly relationTableName = 'KGRelation';

    private readonly MAX_PROMPT_GRAPH_LENGTH = 150000;

    constructor(
        rootPath?: string,
        geminiService?: GeminiIntegrationService,
        embeddingService?: CodebaseEmbeddingService,
        memoryManager?: MemoryManager
    ) {
        this.kuzuStorage = new KuzuStorageManager(rootPath);
        this.geminiService = geminiService;
        this.embeddingService = embeddingService;
        this.memoryManager = memoryManager;
        console.log('[KnowledgeGraphManagerKuzu] Initialized');
    }

    private getNodeTableName(): string {
        return this.nodeTableName;
    }

    private getRelationTableName(): string {
        return this.relationTableName;
    }

    /**
     * Creates entities in the knowledge graph
     */
    async createEntities(
        agentId: string,
        entities: Array<{ name: string; entityType: string; observations?: string[] }>
    ): Promise<any[]> {
        console.log(`[KnowledgeGraphManagerKuzu.createEntities] Agent: ${agentId}, Entities count: ${entities.length}`);

        const nodes: KuzuNode[] = entities.map(entity => ({
            id: randomUUID(),
            agentId,
            name: entity.name,
            entityType: entity.entityType,
            observations: entity.observations || [],
            timestamp: Date.now(),
            version: 1
        }));

        try {
            await this.kuzuStorage.insertNodes(agentId, nodes);
            console.log(`[KnowledgeGraphManagerKuzu.createEntities] Created ${nodes.length} entities for agent ${agentId}`);

            return nodes.map(node => ({
                node_id: node.id,
                name: node.name,
                entityType: node.entityType,
                success: true
            }));
        } catch (error: any) {
            console.error('[KnowledgeGraphManagerKuzu.createEntities] Error:', error);
            throw new McpError(ErrorCode.InternalError, `Failed to create entities: ${error.message}`);
        }
    }

    /**
     * Creates relations between entities
     */
    async createRelations(
        agentId: string,
        relations: Array<{ from: string; to: string; relationType: string }>
    ): Promise<any[]> {
        console.log(`[KnowledgeGraphManagerKuzu.createRelations] Agent: ${agentId}, Relations count: ${relations.length}`);

        const results: any[] = [];

        try {
            for (const relation of relations) {
                // Find the nodes by name
                const fromNodes = await this.kuzuStorage.getNodesByName(agentId, [relation.from]);
                const toNodes = await this.kuzuStorage.getNodesByName(agentId, [relation.to]);

                if (fromNodes.length === 0) {
                    results.push({
                        success: false,
                        from: relation.from,
                        to: relation.to,
                        type: relation.relationType,
                        error: `From entity '${relation.from}' not found`
                    });
                    continue;
                }

                if (toNodes.length === 0) {
                    results.push({
                        success: false,
                        from: relation.from,
                        to: relation.to,
                        type: relation.relationType,
                        error: `To entity '${relation.to}' not found`
                    });
                    continue;
                }

                const kuzuRelation: KuzuRelation = {
                    id: randomUUID(),
                    fromNodeId: fromNodes[0].id,
                    toNodeId: toNodes[0].id,
                    relationType: relation.relationType,
                    timestamp: Date.now(),
                    version: 1
                };

                await this.kuzuStorage.insertRelations(agentId, [kuzuRelation]);

                results.push({
                    success: true,
                    relation_id: kuzuRelation.id,
                    from: relation.from,
                    to: relation.to,
                    type: relation.relationType
                });
            }

            console.log(`[KnowledgeGraphManagerKuzu.createRelations] Created ${results.filter(r => r.success).length}/${results.length} relations`);
            return results;
        } catch (error: any) {
            console.error('[KnowledgeGraphManagerKuzu.createRelations] Error:', error);
            throw new McpError(ErrorCode.InternalError, `Failed to create relations: ${error.message}`);
        }
    }

    /**
     * Adds observations to existing entities
     */
    async addObservations(
        agentId: string,
        observations: Array<{ entityName: string; contents: string[] }>
    ): Promise<any[]> {
        console.log(`[KnowledgeGraphManagerKuzu.addObservations] Agent: ${agentId}, Observations count: ${observations.length}`);

        const results: any[] = [];

        try {
            for (const obs of observations) {
                const nodes = await this.kuzuStorage.getNodesByName(agentId, [obs.entityName]);

                if (nodes.length === 0) {
                    results.push({
                        success: false,
                        entityName: obs.entityName,
                        error: `Entity '${obs.entityName}' not found`
                    });
                    continue;
                }

                const node = nodes[0];
                const updatedObservations = [...node.observations, ...obs.contents];

                const success = await this.kuzuStorage.updateNode(agentId, node.id, {
                    observations: updatedObservations,
                    version: node.version + 1
                });

                results.push({
                    success,
                    entityName: obs.entityName,
                    addedCount: success ? obs.contents.length : 0
                });
            }

            return results;
        } catch (error: any) {
            console.error('[KnowledgeGraphManagerKuzu.addObservations] Error:', error);
            throw new McpError(ErrorCode.InternalError, `Failed to add observations: ${error.message}`);
        }
    }

    /**
     * Deletes entities from the knowledge graph
     */
    async deleteEntities(agentId: string, entityNames: string[]): Promise<any[]> {
        console.log(`[KnowledgeGraphManagerKuzu.deleteEntities] Agent: ${agentId}, Entities: ${entityNames.join(', ')}`);

        const results: any[] = [];

        try {
            for (const name of entityNames) {
                const nodes = await this.kuzuStorage.getNodesByName(agentId, [name]);

                if (nodes.length === 0) {
                    results.push({
                        success: false,
                        entityName: name,
                        error: `Entity '${name}' not found`
                    });
                    continue;
                }

                const success = await this.kuzuStorage.deleteNode(agentId, nodes[0].id);
                results.push({
                    success,
                    entityName: name,
                    deleted: success
                });
            }

            return results;
        } catch (error: any) {
            console.error('[KnowledgeGraphManagerKuzu.deleteEntities] Error:', error);
            throw new McpError(ErrorCode.InternalError, `Failed to delete entities: ${error.message}`);
        }
    }

    /**
     * Deletes specific observations from entities
     */
    async deleteObservations(
        agentId: string,
        deletions: Array<{ entityName: string; observations: string[] }>
    ): Promise<any[]> {
        console.log(`[KnowledgeGraphManagerKuzu.deleteObservations] Agent: ${agentId}, Deletions count: ${deletions.length}`);

        const results: any[] = [];

        try {
            for (const deletion of deletions) {
                const nodes = await this.kuzuStorage.getNodesByName(agentId, [deletion.entityName]);

                if (nodes.length === 0) {
                    results.push({
                        success: false,
                        entityName: deletion.entityName,
                        error: `Entity '${deletion.entityName}' not found`
                    });
                    continue;
                }

                const node = nodes[0];
                const obsToRemove = new Set(deletion.observations.map(obs => obs.toLowerCase()));
                const filteredObservations = node.observations.filter(obs =>
                    !obsToRemove.has(obs.toLowerCase())
                );

                const success = await this.kuzuStorage.updateNode(agentId, node.id, {
                    observations: filteredObservations,
                    version: node.version + 1
                });

                results.push({
                    success,
                    entityName: deletion.entityName,
                    deletedCount: success ? (node.observations.length - filteredObservations.length) : 0
                });
            }

            return results;
        } catch (error: any) {
            console.error('[KnowledgeGraphManagerKuzu.deleteObservations] Error:', error);
            throw new McpError(ErrorCode.InternalError, `Failed to delete observations: ${error.message}`);
        }
    }

    /**
     * Deletes relations from the knowledge graph
     */
    async deleteRelations(
        agentId: string,
        relations: Array<{ from: string; to: string; relationType: string }>
    ): Promise<any[]> {
        console.log(`[KnowledgeGraphManagerKuzu.deleteRelations] Agent: ${agentId}, Relations count: ${relations.length}`);

        const results: any[] = [];

        try {
            for (const relation of relations) {
                const fromNodes = await this.kuzuStorage.getNodesByName(agentId, [relation.from]);
                const toNodes = await this.kuzuStorage.getNodesByName(agentId, [relation.to]);

                if (fromNodes.length === 0 || toNodes.length === 0) {
                    results.push({
                        success: false,
                        from: relation.from,
                        to: relation.to,
                        type: relation.relationType,
                        error: `One or both entities not found`
                    });
                    continue;
                }

                // Find the specific relation
                const allRelations = await this.kuzuStorage.getAllRelations(agentId);
                const targetRelation = allRelations.find(r =>
                    r.fromNodeId === fromNodes[0].id &&
                    r.toNodeId === toNodes[0].id &&
                    r.relationType === relation.relationType
                );

                if (!targetRelation) {
                    results.push({
                        success: false,
                        from: relation.from,
                        to: relation.to,
                        type: relation.relationType,
                        error: `Relation not found`
                    });
                    continue;
                }

                const success = await this.kuzuStorage.deleteRelation(agentId, targetRelation.id);
                results.push({
                    success,
                    from: relation.from,
                    to: relation.to,
                    type: relation.relationType,
                    deleted: success
                });
            }

            return results;
        } catch (error: any) {
            console.error('[KnowledgeGraphManagerKuzu.deleteRelations] Error:', error);
            throw new McpError(ErrorCode.InternalError, `Failed to delete relations: ${error.message}`);
        }
    }

    /**
     * Reads the complete knowledge graph for an agent
     */
    async readGraph(agentId: string): Promise<{ nodes: any[]; relations: any[] }> {
        console.log(`[KnowledgeGraphManagerKuzu.readGraph] Agent: ${agentId}`);

        try {
            const nodes = await this.kuzuStorage.getAllNodes(agentId);
            const relations = await this.kuzuStorage.getAllRelations(agentId);

            return {
                nodes: nodes.map(node => ({
                    node_id: node.id,
                    name: node.name,
                    entityType: node.entityType,
                    observations: node.observations
                })),
                relations: relations.map(rel => ({
                    relation_id: rel.id,
                    from: nodes.find(n => n.id === rel.fromNodeId)?.name || rel.fromNodeId,
                    to: nodes.find(n => n.id === rel.toNodeId)?.name || rel.toNodeId,
                    relationType: rel.relationType
                }))
            };
        } catch (error: any) {
            console.error('[KnowledgeGraphManagerKuzu.readGraph] Error:', error);
            throw new McpError(ErrorCode.InternalError, `Failed to read graph: ${error.message}`);
        }
    }

    /**
     * Searches for nodes in the knowledge graph
     */
    async searchNodes(agentId: string, query: string): Promise<GraphTraversalNode[]> {
        console.log(`[KnowledgeGraphManagerKuzu.searchNodes] Agent: ${agentId}, Query: "${query}"`);

        try {
            // Parse query for entity type and search terms
            let entityType: string | undefined;
            let searchTerm = query;

            // Check for entityType: prefix
            const entityTypeMatch = query.match(/entityType:(\w+)/);
            if (entityTypeMatch) {
                entityType = entityTypeMatch[1];
                searchTerm = query.replace(/entityType:\w+/g, '').trim();
            }

            // Check for obs: prefix (observations search)
            const obsMatch = query.match(/obs:(.+)/);
            if (obsMatch) {
                searchTerm = obsMatch[1].trim();
            }

            if (!searchTerm && !entityType) {
                // Return all nodes if no specific search criteria
                const allNodes = await this.kuzuStorage.getAllNodes(agentId);
                return allNodes.map(node => ({
                    node_id: node.id,
                    name: node.name,
                    entityType: node.entityType,
                    observations: node.observations
                }));
            }

            const nodes = await this.kuzuStorage.searchNodes(agentId, searchTerm, entityType);

            return nodes.map(node => ({
                node_id: node.id,
                name: node.name,
                entityType: node.entityType,
                observations: node.observations
            }));
        } catch (error: any) {
            console.error('[KnowledgeGraphManagerKuzu.searchNodes] Error:', error);
            return [];
        }
    }

    /**
     * Opens specific nodes by name
     */
    async openNodes(agentId: string, names: string[]): Promise<GraphTraversalNode[]> {
        console.log(`[KnowledgeGraphManagerKuzu.openNodes] Agent: ${agentId}, Names: ${names.join(', ')}`);

        try {
            const nodes = await this.kuzuStorage.getNodesByName(agentId, names);

            return nodes.map(node => ({
                node_id: node.id,
                name: node.name,
                entityType: node.entityType,
                observations: node.observations
            }));
        } catch (error: any) {
            console.error('[KnowledgeGraphManagerKuzu.openNodes] Error:', error);
            return [];
        }
    }

    /**
     * Traverses the graph from a starting node
     */
    async traverseGraph(
        agentId: string,
        startNodeName: string,
        relationTypes: string[],
        depth: number
    ): Promise<{ nodes: GraphTraversalNode[]; relations: GraphTraversalRelation[] }> {
        console.log(`[KnowledgeGraphManagerKuzu.traverseGraph] Agent: ${agentId}, Start: ${startNodeName}, Depth: ${depth}`);

        try {
            // Find the starting node
            const startNodes = await this.kuzuStorage.getNodesByName(agentId, [startNodeName]);
            if (startNodes.length === 0) {
                return { nodes: [], relations: [] };
            }

            const result = await this.kuzuStorage.traverseGraph(agentId, startNodes[0].id, relationTypes, depth);

            return {
                nodes: result.nodes.map(node => ({
                    node_id: node.id,
                    name: node.name,
                    entityType: node.entityType,
                    observations: node.observations
                })),
                relations: result.relations.map(rel => ({
                    relation_id: rel.id,
                    from: result.nodes.find(n => n.id === rel.fromNodeId)?.name || rel.fromNodeId,
                    to: result.nodes.find(n => n.id === rel.toNodeId)?.name || rel.toNodeId,
                    relationType: rel.relationType
                }))
            };
        } catch (error: any) {
            console.error('[KnowledgeGraphManagerKuzu.traverseGraph] Error:', error);
            return { nodes: [], relations: [] };
        }
    }

    /**
     * Processes natural language queries using AI
     */
    async queryNaturalLanguage(agentId: string, naturalLanguageQuery: string): Promise<string> {
        console.log(`[KnowledgeGraphManagerKuzu.queryNaturalLanguage] Agent: ${agentId}, Query: "${naturalLanguageQuery}"`);

        if (!this.geminiService) {
            console.warn('[KnowledgeGraphManagerKuzu] No Gemini service available, using simple search');
            const searchResults = await this.searchNodes(agentId, naturalLanguageQuery);
            return JSON.stringify({
                metadata: {
                    originalQuery: naturalLanguageQuery,
                    translatedOperations: [{ operation: 'search_nodes', args: { query: naturalLanguageQuery } }],
                    usedGemini: false
                },
                results: searchResults
            }, null, 2);
        }

        try {
            // Get current graph context for AI
            const graphContext = await this._prepareGraphContextForPrompt(agentId);

            // Use enhanced KG NL translation prompt
            const enhancedPrompt = ENHANCED_KG_NL_TRANSLATION_PROMPT
                .replace('{naturalLanguageQuery}', naturalLanguageQuery)
                .replace('{graphContext}', graphContext);

            const geminiResponse = await this.geminiService.askGemini(enhancedPrompt, getCurrentModel());
            const responseText = geminiResponse.content[0]?.text?.trim() || '{}';

            const enhancedAnalysis = await parseGeminiJsonResponse(responseText, {
                expectedStructure: 'enhanced_query, query_intent, search_strategy, primary_entity_types',
                contextDescription: 'Enhanced knowledge graph analysis',
                memoryManager: this.memoryManager,
                geminiService: this.geminiService
            });

            // Convert analysis to operations
            const operations = this._convertAnalysisToOperations(enhancedAnalysis, naturalLanguageQuery);

            // Execute operations
            const allResults: any[] = [];
            for (const operation of operations) {
                const result = await this._executeOperation(agentId, operation);
                if (Array.isArray(result)) {
                    allResults.push(...result);
                } else if (result) {
                    allResults.push(result);
                }
            }

            // Remove duplicates
            const uniqueResults = Array.from(
                new Map(allResults.map(item => [item.node_id || JSON.stringify(item), item])).values()
            );

            return JSON.stringify({
                metadata: {
                    originalQuery: naturalLanguageQuery,
                    translatedOperations: operations,
                    usedGemini: true,
                    enhancedAnalysis: {
                        queryIntent: enhancedAnalysis.query_intent,
                        searchStrategy: enhancedAnalysis.search_strategy
                    }
                },
                results: uniqueResults
            }, null, 2);

        } catch (error: any) {
            console.error('[KnowledgeGraphManagerKuzu.queryNaturalLanguage] Error:', error);

            // Fallback to simple search
            const searchResults = await this.searchNodes(agentId, naturalLanguageQuery);
            return JSON.stringify({
                metadata: {
                    originalQuery: naturalLanguageQuery,
                    translatedOperations: [{ operation: 'search_nodes', args: { query: naturalLanguageQuery } }],
                    usedGemini: false,
                    error: error.message
                },
                results: searchResults
            }, null, 2);
        }
    }

    /**
     * Infers potential relations between entities using AI
     */
    async inferRelations(
        agentId: string,
        entityNames?: string[],
        context?: string
    ): Promise<{ message: string; details: any[] }> {
        console.log(`[KnowledgeGraphManagerKuzu.inferRelations] Agent: ${agentId}, Entities: ${entityNames?.join(', ')}`);

        if (!this.geminiService) {
            return { message: "AI service not available for relation inference", details: [] };
        }

        try {
            const { nodes: allNodes, relations: existingRelations } = await this.readGraph(agentId);

            let targetNodes = allNodes;
            if (entityNames && entityNames.length > 0) {
                const entitySet = new Set(entityNames);
                targetNodes = allNodes.filter(n => entitySet.has(n.name));
            }

            if (targetNodes.length === 0) {
                return { message: "No target nodes found for relation inference", details: [] };
            }

            // Prepare context for AI
            let contextForAI = `Target Nodes for Relation Inference:\n`;
            targetNodes.slice(0, 20).forEach(n => {
                contextForAI += `- Name: ${n.name}, Type: ${n.entityType}, Observations: ${(n.observations || []).join(', ').substring(0, 100)}\n`;
            });

            if (existingRelations.length > 0) {
                contextForAI += "\nExisting Relations:\n";
                existingRelations.slice(0, 10).forEach(r => {
                    contextForAI += `- ${r.from} --(${r.relationType})--> ${r.to}\n`;
                });
            }

            if (context) {
                contextForAI += `\nUser Context: ${context}\n`;
            }

            const prompt = `
Analyze the provided nodes and infer NEW relationships between them.
Focus on software relationships: 'calls', 'uses', 'imports', 'extends', 'implements', 'defined_in', 'related_to_feature', 'tests'.
Each proposed relation must NOT already exist and should have confidence 0.6-1.0.

Context:
${contextForAI}

Return JSON array of proposed relations:
[{"from": "NodeA", "to": "NodeB", "relationType": "calls", "confidence": 0.8, "evidence": "reason"}]

If no relations can be inferred, return [].`;

            const geminiResponse = await this.geminiService.askGemini(prompt, getCurrentModel());
            const proposedRelations = parseGeminiJsonResponseSync(geminiResponse.content[0]?.text?.trim() || '[]');

            if (!Array.isArray(proposedRelations)) {
                return { message: "Invalid AI response format", details: [] };
            }

            // Filter valid proposals
            const validProposals = proposedRelations.filter(prop => {
                const fromNode = allNodes.find(n => n.name === prop.from);
                const toNode = allNodes.find(n => n.name === prop.to);
                return fromNode && toNode && !existingRelations.some(existing =>
                    existing.from === prop.from && existing.to === prop.to && existing.relationType === prop.relationType
                );
            });

            // Auto-create high confidence relations
            const highConfidenceRelations = validProposals.filter(r => r.confidence >= 0.8);
            let addedCount = 0;

            if (highConfidenceRelations.length > 0) {
                const relationsToCreate = highConfidenceRelations.map(r => ({
                    from: r.from,
                    to: r.to,
                    relationType: r.relationType
                }));

                const results = await this.createRelations(agentId, relationsToCreate);
                addedCount = results.filter(r => r.success).length;

                validProposals.forEach(prop => {
                    if (prop.confidence >= 0.8) {
                        const wasAdded = results.some(r =>
                            r.success && r.from === prop.from && r.to === prop.to && r.type === prop.relationType
                        );
                        prop.status = wasAdded ? 'added' : 'failed';
                    } else {
                        prop.status = 'proposed';
                    }
                });
            }

            const message = `Inferred ${validProposals.length} relations. Added ${addedCount} high-confidence relations automatically.`;
            return { message, details: validProposals };

        } catch (error: any) {
            console.error('[KnowledgeGraphManagerKuzu.inferRelations] Error:', error);
            return { message: `Error inferring relations: ${error.message}`, details: [] };
        }
    }

    /**
     * Generates a smart, focused Mermaid graph visualization leveraging KuzuDB's graph capabilities
     */
    async generateMermaidGraph(
        agentId: string,
        options: {
            query?: string;
            natural_language_query?: string;
            layoutDirection?: string;
            depth?: number;
            includeLegend?: boolean;
            groupByDirectory?: boolean;
            maxNodes?: number;
            maxEdges?: number;
            excludeImports?: string[];
            excludeRelationTypes?: string[];
        }
    ): Promise<string> {
        console.log(`[KnowledgeGraphManagerKuzu.generateMermaidGraph] Agent: ${agentId}, Options:`, options);

        const {
            layoutDirection = 'TD',
            includeLegend = true,
            groupByDirectory = false,
            maxNodes = 50,
            maxEdges = 100,
            depth = 2
        } = options;

        try {
            let nodes: GraphTraversalNode[] = [];
            let relations: GraphTraversalRelation[] = [];

            // Smart query processing
            if (options.natural_language_query) {
                // Use AI-powered query for intelligent filtering
                const nlResult = await this.queryNaturalLanguage(agentId, options.natural_language_query);
                const parsed = JSON.parse(nlResult);
                nodes = parsed.results || [];

                if (nodes.length > 0) {
                    // Get relations between AI-found nodes
                    const nodeIds = new Set(nodes.map(n => n.node_id));
                    const allRelations = await this.kuzuStorage.getAllRelations(agentId);
                    relations = allRelations.filter(r =>
                        nodeIds.has(r.fromNodeId) && nodeIds.has(r.toNodeId)
                    );
                }
            } else if (options.query) {
                // Use focused search with smart expansion
                const searchResults = await this.searchNodes(agentId, options.query);

                if (searchResults.length === 0) {
                    return this._generateEmptyGraph(layoutDirection, `No nodes found for query: '${options.query}'`);
                }

                // Smart expansion: find related nodes using graph traversal
                const expandedNodes = new Map<string, GraphTraversalNode>();
                const expandedRelations: GraphTraversalRelation[] = [];

                // Add initial search results
                searchResults.slice(0, Math.floor(maxNodes / 2)).forEach((node: GraphTraversalNode) => {
                    expandedNodes.set(node.node_id, node);
                });

                // Expand using KuzuDB graph traversal for each found node
                for (const seedNode of Array.from(expandedNodes.values()).slice(0, 5)) {
                    try {
                        const traversalResult = await this.traverseGraph(
                            agentId,
                            seedNode.name,
                            [], // All relation types
                            Math.min(depth, 2)
                        );

                        traversalResult.nodes.forEach((node: GraphTraversalNode) => {
                            if (expandedNodes.size < maxNodes) {
                                expandedNodes.set(node.node_id, node);
                            }
                        });

                        traversalResult.relations.forEach((rel: GraphTraversalRelation) => {
                            if (rel.from && rel.to && expandedNodes.has(rel.from) && expandedNodes.has(rel.to)) {
                                expandedRelations.push(rel);
                            }
                        });
                    } catch (error) {
                        console.warn(`[generateMermaidGraph] Traversal failed for ${seedNode.name}:`, error);
                    }
                }

                nodes = Array.from(expandedNodes.values());
                relations = expandedRelations;
            } else {
                // No query - show high-value overview
                return await this._generateOverviewGraph(agentId, layoutDirection, maxNodes, maxEdges);
            }

            // Apply filters
            if (options.excludeRelationTypes?.length) {
                const excludeSet = new Set(options.excludeRelationTypes);
                relations = relations.filter(r => !excludeSet.has(r.relationType));
            }

            if (options.excludeImports?.length) {
                const excludeSet = new Set(options.excludeImports);
                relations = relations.filter(r => {
                    if (r.relationType.includes('import')) {
                        const targetNode = nodes.find(n => n.node_id === r.to);
                        return targetNode ? !excludeSet.has(targetNode.name) : true;
                    }
                    return true;
                });
            }

            // Final size limits
            nodes = nodes.slice(0, maxNodes);
            relations = relations.slice(0, maxEdges);

            if (nodes.length === 0) {
                return this._generateEmptyGraph(layoutDirection, 'No nodes found matching criteria');
            }

            console.log(`[KnowledgeGraphManagerKuzu] Generating focused graph: ${nodes.length} nodes, ${relations.length} relations`);

            return this._generateFocusedMermaidGraph(nodes, relations, {
                layoutDirection,
                includeLegend,
                groupByDirectory,
                query: options.query || options.natural_language_query
            });

        } catch (error: any) {
            console.error('[KnowledgeGraphManagerKuzu.generateMermaidGraph] Error:', error);
            return this._generateEmptyGraph(layoutDirection, `Error: ${error.message}`);
        }
    }

    /**
     * Generates an intelligent overview when no specific query is provided
     */
    private async _generateOverviewGraph(agentId: string, layoutDirection: string, maxNodes: number, maxEdges: number): Promise<string> {
        try {
            // Get high-value nodes: files with most connections, central classes/functions
            const nodeTable = this.getNodeTableName();
            const relationTable = this.getRelationTableName();

            // Find most connected nodes (hub nodes)
            const hubQuery = `
                MATCH (n:${nodeTable})-[r:${relationTable}]-()
                RETURN n, count(r) as connections
                ORDER BY connections DESC
                LIMIT ${Math.floor(maxNodes * 0.7)}
            `;

            const hubRows = await this.kuzuStorage.cypherQuery(agentId, hubQuery);

            const hubNodes = hubRows.map((row: any) => ({
                node_id: row.n.id,
                name: row.n.name,
                entityType: row.n.entityType,
                observations: row.n.observations,
                connections: row.connections
            }));

            // Add some entry point files
            const entryQuery = `
                MATCH (n:${nodeTable})
                WHERE n.entityType IN ['file', 'module']
                AND (n.name CONTAINS 'index' OR n.name CONTAINS 'main' OR n.name CONTAINS 'app')
                RETURN n
                LIMIT ${Math.floor(maxNodes * 0.3)}
            `;

            const entryRows = await this.kuzuStorage.cypherQuery(agentId, entryQuery);

            const entryNodes = entryRows.map((row: any) => ({
                node_id: row.n.id,
                name: row.n.name,
                entityType: row.n.entityType,
                observations: row.n.observations
            }));

            // Combine and deduplicate
            const nodeMap = new Map();
            [...hubNodes, ...entryNodes].forEach(node => {
                nodeMap.set(node.node_id, node);
            });

            const nodes = Array.from(nodeMap.values()).slice(0, maxNodes);

            // Get relations between these nodes
            const nodeIds = new Set(nodes.map(n => n.node_id));
            const allRelations = await this.kuzuStorage.getAllRelations(agentId);
            const relations = allRelations
                .filter(r => nodeIds.has(r.fromNodeId) && nodeIds.has(r.toNodeId))
                .slice(0, maxEdges);

            return this._generateFocusedMermaidGraph(nodes, relations, {
                layoutDirection,
                includeLegend: true,
                groupByDirectory: false,
                query: 'Overview: High-connectivity nodes and entry points'
            });

        } catch (error: any) {
            console.error('[_generateOverviewGraph] Error:', error);
            return this._generateEmptyGraph(layoutDirection, 'Failed to generate overview');
        }
    }

    /**
     * Generates a focused, well-structured Mermaid graph
     */
    private _generateFocusedMermaidGraph(
        nodes: any[],
        relations: any[],
        options: { layoutDirection: string; includeLegend: boolean; groupByDirectory: boolean; query?: string }
    ): string {
        const { layoutDirection, includeLegend, groupByDirectory, query } = options;

        let mermaid = `graph ${layoutDirection}\n`;

        if (query) {
            mermaid += `    %% Query: ${query}\n`;
        }

        // Enhanced node styling with better colors and shapes
        const nodeStyles = {
            file: 'fill:#e1f5fe,stroke:#0277bd,stroke-width:2px,color:#000',
            directory: 'fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px,color:#000',
            function: 'fill:#e8f5e8,stroke:#2e7d32,stroke-width:2px,color:#000',
            class: 'fill:#fff3e0,stroke:#ef6c00,stroke-width:2px,color:#000',
            interface: 'fill:#fce4ec,stroke:#c2185b,stroke-width:2px,color:#000',
            module: 'fill:#e0f2f1,stroke:#00695c,stroke-width:2px,color:#000',
            variable: 'fill:#f1f8e9,stroke:#558b2f,stroke-width:2px,color:#000',
            default: 'fill:#f5f5f5,stroke:#424242,stroke-width:2px,color:#000'
        };

        // Create node ID mappings
        const nodeIdMap = new Map<string, string>();
        nodes.forEach((node, index) => {
            const cleanName = this._sanitizeNodeName(node.name);
            const uniqueId = `n${index}_${cleanName}`;
            nodeIdMap.set(node.node_id, uniqueId);
        });

        // Group nodes by directory if requested
        if (groupByDirectory) {
            const dirGroups = this._groupNodesByDirectory(nodes);

            for (const [dir, dirNodes] of dirGroups.entries()) {
                const dirId = this._sanitizeNodeName(dir);
                const displayDir = dir === '.' ? 'Root' : dir;

                mermaid += `    subgraph ${dirId}["📁 ${displayDir}"]\n`;

                dirNodes.forEach(node => {
                    const nodeId = nodeIdMap.get(node.node_id)!;
                    const displayName = this._getDisplayName(node.name);
                    const shape = this._getNodeShape(node.entityType);

                    mermaid += `        ${nodeId}${shape}"${this._getNodeIcon(node.entityType)} ${displayName}"]\n`;
                });

                mermaid += `    end\n`;
            }
        } else {
            // Add individual nodes
            nodes.forEach(node => {
                const nodeId = nodeIdMap.get(node.node_id)!;
                const displayName = this._getDisplayName(node.name);
                const shape = this._getNodeShape(node.entityType);

                mermaid += `    ${nodeId}${shape}"${this._getNodeIcon(node.entityType)} ${displayName}"]\n`;
            });
        }

        // Add node styles
        nodes.forEach(node => {
            const nodeId = nodeIdMap.get(node.node_id)!;
            const style = (nodeStyles as any)[node.entityType] || nodeStyles.default;
            mermaid += `    style ${nodeId} ${style}\n`;
        });

        // Add relations with enhanced styling
        const relationStyles = new Map([
            ['imports', '-.->'],
            ['calls', '-->'],
            ['extends', '==>'],
            ['implements', '==>'],
            ['uses', '-->'],
            ['defines', '-->'],
            ['contains', '-->']
        ]);

        relations.forEach(relation => {
            const fromId = nodeIdMap.get(relation.fromNodeId);
            const toId = nodeIdMap.get(relation.toNodeId);

            if (fromId && toId) {
                const arrow = relationStyles.get(relation.relationType) || '-->';
                const label = this._simplifyRelationType(relation.relationType);
                mermaid += `    ${fromId} ${arrow} ${toId}\n`;
                mermaid += `    ${fromId} ${arrow}|"${label}"| ${toId}\n`;
            }
        });

        // Add legend if requested
        if (includeLegend) {
            mermaid += this._generateCompactLegend();
        }

        // Add summary comment
        mermaid += `\n    %% Generated: ${nodes.length} nodes, ${relations.length} relations\n`;

        return mermaid;
    }

    private _generateEmptyGraph(layoutDirection: string, message: string): string {
        return `graph ${layoutDirection}\n    empty["${message}"]\n    style empty fill:#ffebee,stroke:#c62828,stroke-width:2px`;
    }

    private _sanitizeNodeName(name: string): string {
        return name.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 50);
    }

    private _getDisplayName(fullName: string): string {
        // Shorten long file paths
        if (fullName.includes('/')) {
            const parts = fullName.split('/');
            if (parts.length > 2) {
                return `.../${parts.slice(-2).join('/')}`;
            }
        }
        return fullName.length > 30 ? fullName.substring(0, 27) + '...' : fullName;
    }

    private _getNodeIcon(entityType: string): string {
        const icons = {
            file: '📄',
            directory: '📁',
            function: '⚡',
            class: '🏗️',
            interface: '📋',
            module: '📦',
            variable: '💾',
            default: '⭕'
        };
        return (icons as any)[entityType] || icons.default;
    }

    private _getNodeShape(entityType: string): string {
        const shapes = {
            file: '[',
            directory: '(',
            function: '(',
            class: '[',
            interface: '{',
            module: '[',
            variable: '((',
            default: '['
        };
        return (shapes as any)[entityType] || shapes.default;
    }

    private _simplifyRelationType(relationType: string): string {
        const simplifications = {
            'imports_file': 'imports',
            'imports_module': 'imports',
            'calls_function': 'calls',
            'calls_method': 'calls',
            'extends_class': 'extends',
            'implements_interface': 'implements',
            'uses_class': 'uses',
            'defines_function': 'defines',
            'contains_file': 'contains'
        };
        return (simplifications as any)[relationType] || relationType;
    }

    private _groupNodesByDirectory(nodes: any[]): Map<string, any[]> {
        const groups = new Map<string, any[]>();

        nodes.forEach(node => {
            const dir = node.name.includes('/') ?
                node.name.substring(0, node.name.lastIndexOf('/')) : '.';

            if (!groups.has(dir)) {
                groups.set(dir, []);
            }
            groups.get(dir)!.push(node);
        });

        return groups;
    }

    private _generateCompactLegend(): string {
        return `
    subgraph Legend["🗂️ Legend"]
        direction LR
        L1["📄 File"]
        L2["⚡ Function"]
        L3["🏗️ Class"]
        L4["📦 Module"]

        style L1 fill:#e1f5fe,stroke:#0277bd
        style L2 fill:#e8f5e8,stroke:#2e7d32
        style L3 fill:#fff3e0,stroke:#ef6c00
        style L4 fill:#e0f2f1,stroke:#00695c
    end
`;
    }

    /**
     * Checks if a specific relation exists
     */
    async getExistingRelation(
        agentId: string,
        fromNodeName: string,
        toNodeName: string,
        relationType: string
    ): Promise<any | null> {
        try {
            const fromNodes = await this.kuzuStorage.getNodesByName(agentId, [fromNodeName]);
            const toNodes = await this.kuzuStorage.getNodesByName(agentId, [toNodeName]);

            if (fromNodes.length === 0 || toNodes.length === 0) {
                return null;
            }

            const allRelations = await this.kuzuStorage.getAllRelations(agentId);
            return allRelations.find(r =>
                r.fromNodeId === fromNodes[0].id &&
                r.toNodeId === toNodes[0].id &&
                r.relationType === relationType
            ) || null;
        } catch (error: any) {
            console.error('[KnowledgeGraphManagerKuzu.getExistingRelation] Error:', error);
            return null;
        }
    }

    private async _prepareGraphContextForPrompt(agentId: string): Promise<string> {
        try {
            const graph = await this.readGraph(agentId);
            if (!graph || (graph.nodes.length === 0 && graph.relations.length === 0)) {
                return "Graph is empty";
            }

            const nodesForPrompt = graph.nodes.slice(0, 50).map(n => ({
                name: n.name,
                entityType: n.entityType,
                observations: n.observations?.slice(0, 2).map((o: any) => o.substring(0, 50))
            }));

            const relationsForPrompt = graph.relations.slice(0, 50);
            const graphRepresentation = JSON.stringify({ nodes: nodesForPrompt, relations: relationsForPrompt }, null, 2);

            if (graphRepresentation.length > this.MAX_PROMPT_GRAPH_LENGTH) {
                return `Graph too large. Nodes: ${graph.nodes.length}, Relations: ${graph.relations.length}`;
            }

            return graphRepresentation;
        } catch (error: any) {
            console.error('[KnowledgeGraphManagerKuzu._prepareGraphContextForPrompt] Error:', error);
            return "Error reading graph context";
        }
    }

    private _convertAnalysisToOperations(analysis: any, originalQuery: string): any[] {
        try {
            const operations: any[] = [];
            const searchStrategy = analysis.search_strategy || 'hybrid';
            const primaryEntityTypes = analysis.primary_entity_types || [];
            const semanticKeywords = analysis.semantic_keywords || [];
            const keyRelationTypes = analysis.key_relation_types || [];
            const traversalRules = analysis.graph_traversal_rules || {};
            const focusNodes = analysis.search_optimization?.focus_nodes || [];

            console.log(`[KnowledgeGraphManagerKuzu] Converting analysis - Strategy: ${searchStrategy}`);

            // Strategy 1: Graph traversal operations for structural queries
            if (searchStrategy === 'traversal' || searchStrategy === 'structural') {
                if (traversalRules.start_nodes && keyRelationTypes.length > 0) {
                    const startNodes = Array.isArray(traversalRules.start_nodes)
                        ? traversalRules.start_nodes
                        : [traversalRules.start_nodes];

                    for (const startNode of startNodes.slice(0, 2)) {
                        operations.push({
                            operation: 'graph_traversal',
                            args: {
                                start_node: startNode,
                                relation_types: keyRelationTypes,
                                depth: analysis.traversal_depth || 2
                            }
                        });
                    }
                }
            }

            // Strategy 2: Enhanced semantic search with entity type filtering
            if (searchStrategy === 'semantic' || searchStrategy === 'hybrid') {
                if (semanticKeywords.length > 0) {
                    // Create targeted searches for each entity type
                    for (const entityType of primaryEntityTypes.slice(0, 2)) {
                        const searchTerms = semanticKeywords.slice(0, 3).join(' ');
                        operations.push({
                            operation: 'search_nodes',
                            args: {
                                query: `entityType:${entityType} ${searchTerms}`,
                                strategy: 'semantic_filtered'
                            }
                        });
                    }

                    // Add general semantic search
                    operations.push({
                        operation: 'search_nodes',
                        args: {
                            query: semanticKeywords.join(' '),
                            strategy: 'semantic_general'
                        }
                    });
                }
            }

            // Strategy 3: Focus node expansion using graph capabilities
            if (focusNodes.length > 0) {
                for (const focusNode of focusNodes.slice(0, 2)) {
                    operations.push({
                        operation: 'graph_traversal',
                        args: {
                            start_node: focusNode,
                            relation_types: keyRelationTypes.length > 0 ? keyRelationTypes : [],
                            depth: Math.min(analysis.traversal_depth || 2, 3)
                        }
                    });
                }
            }

            // Strategy 4: Aggregation for connectivity analysis
            if (searchStrategy === 'aggregation') {
                operations.push({
                    operation: 'read_graph',
                    args: {
                        analysis_type: 'connectivity',
                        filter_entity_types: primaryEntityTypes
                    }
                });
            }

            // Ensure we have at least one operation
            if (operations.length === 0) {
                console.warn('[KnowledgeGraphManagerKuzu] No specific operations generated, using enhanced fallback');

                // Try to extract meaningful search terms from the original query
                const queryTerms = originalQuery.toLowerCase()
                    .split(/[^a-zA-Z0-9_]/)
                    .filter(term => term.length > 2)
                    .slice(0, 3);

                if (queryTerms.length > 0) {
                    operations.push({
                        operation: 'search_nodes',
                        args: {
                            query: queryTerms.join(' '),
                            strategy: 'enhanced_fallback'
                        }
                    });
                } else {
                    operations.push({
                        operation: 'search_nodes',
                        args: {
                            query: originalQuery,
                            strategy: 'basic_fallback'
                        }
                    });
                }
            }

            // Limit operations to prevent overwhelming results
            const limitedOps = operations.slice(0, 4);
            console.log(`[KnowledgeGraphManagerKuzu] Generated ${limitedOps.length} KuzuDB operations:`,
                limitedOps.map(op => `${op.operation}(${op.args.strategy || 'default'})`));

            return limitedOps;

        } catch (error: any) {
            console.warn('[KnowledgeGraphManagerKuzu._convertAnalysisToOperations] Error:', error);
            return [{
                operation: 'search_nodes',
                args: { query: originalQuery, strategy: 'error_fallback' }
            }];
        }
    }

    private async _executeOperation(agentId: string, operation: any): Promise<any> {
        console.log(`[KnowledgeGraphManagerKuzu] Executing operation: ${operation.operation} with strategy: ${operation.args?.strategy || 'default'}`);

        switch (operation.operation) {
            case 'search_nodes':
                return this.searchNodes(agentId, operation.args.query);

            case 'open_nodes':
                return this.openNodes(agentId, operation.args.names);

            case 'graph_traversal':
                return this.traverseGraph(
                    agentId,
                    operation.args.start_node,
                    operation.args.relation_types || [],
                    operation.args.depth || 2
                );

            case 'read_graph':
                const graph = await this.readGraph(agentId);
                // Apply filters if specified
                if (operation.args?.filter_entity_types?.length > 0) {
                    const allowedTypes = new Set(operation.args.filter_entity_types);
                    graph.nodes = graph.nodes.filter(node => allowedTypes.has(node.entityType));
                }
                return graph;

            case 'cypher_query':
                return this._executeCypherOperation(agentId, operation.args);

            case 'focus_expansion':
                return this._executeFocusExpansion(agentId, operation.args);

            case 'connectivity_analysis':
                return this._executeConnectivityAnalysis(agentId, operation.args);

            default:
                console.warn(`[KnowledgeGraphManagerKuzu._executeOperation] Unknown operation: ${operation.operation}`);
                return [];
        }
    }

    /**
     * Executes direct Cypher-style operations for advanced graph queries
     */
    private async _executeCypherOperation(agentId: string, args: any): Promise<any> {
        try {
            const { pattern } = args;

            // Translate common patterns to KuzuDB operations
            if (pattern.includes('MATCH') && pattern.includes('RETURN')) {
                // Direct Cypher-style query
                const result = await this.kuzuStorage.cypherQuery(agentId, pattern);
                return this._formatCypherResults(result);
            }

            // Pattern-based query generation
            if (pattern.includes('path')) {
                // Path finding query
                return this._executePathQuery(agentId, pattern);
            }

            return [];
        } catch (error: any) {
            console.error('[KnowledgeGraphManagerKuzu._executeCypherOperation] Error:', error);
            return [];
        }
    }

    /**
     * Executes focus node expansion with intelligent relation following
     */
    private async _executeFocusExpansion(agentId: string, args: any): Promise<any> {
        try {
            const { focus_node, expansion_depth = 2, relation_types = [] } = args;

            // Find the focus node first
            const focusNodes = await this.searchNodes(agentId, focus_node);
            if (focusNodes.length === 0) {
                return { nodes: [], relations: [] };
            }

            // Expand from the most relevant focus node
            const startNode = focusNodes[0];
            const result = await this.traverseGraph(
                agentId,
                startNode.name,
                relation_types,
                expansion_depth
            );

            // Add the original focus node to results
            if (!result.nodes.some((n: GraphTraversalNode) => n.node_id === startNode.node_id)) {
                result.nodes.unshift(startNode);
            }

            return result;
        } catch (error: any) {
            console.error('[KnowledgeGraphManagerKuzu._executeFocusExpansion] Error:', error);
            return { nodes: [], relations: [] };
        }
    }

    /**
     * Analyzes connectivity patterns in the graph
     */
    private async _executeConnectivityAnalysis(agentId: string, args: any): Promise<any> {
        try {
            const nodeTable = this.getNodeTableName();
            const relationTable = this.getRelationTableName();

            // Find most connected nodes
            const connectivityQuery = `
                MATCH (n:${nodeTable})-[r:${relationTable}]-()
                RETURN n, count(r) as connections
                ORDER BY connections DESC
                LIMIT 20
            `;

            const rows = await this.kuzuStorage.cypherQuery(agentId, connectivityQuery);

            const connectivityData = rows.map((row: any) => ({
                node: {
                    node_id: row.n.id,
                    name: row.n.name,
                    entityType: row.n.entityType,
                    observations: row.n.observations
                },
                connections: row.connections
            }));

            return {
                analysis_type: 'connectivity',
                top_connected_nodes: connectivityData,
                summary: `Found ${connectivityData.length} highly connected nodes`
            };
        } catch (error: any) {
            console.error('[KnowledgeGraphManagerKuzu._executeConnectivityAnalysis] Error:', error);
            return { analysis_type: 'connectivity', error: error.message };
        }
    }

    /**
     * Executes path-finding queries between nodes
     */
    private async _executePathQuery(agentId: string, pattern: string): Promise<any> {
        try {
            // Extract start and end nodes from pattern
            const pathMatch = pattern.match(/path.*?from\s+(\w+).*?to\s+(\w+)/i);
            if (!pathMatch) {
                return [];
            }

            const [, startNodeName, endNodeName] = pathMatch;

            // Find paths using graph traversal
            const startNodes = await this.searchNodes(agentId, startNodeName);
            const endNodes = await this.searchNodes(agentId, endNodeName);

            if (startNodes.length === 0 || endNodes.length === 0) {
                return { paths: [], message: 'Start or end node not found' };
            }

            // Use traversal to find connecting paths
            const pathResult = await this.traverseGraph(
                agentId,
                startNodes[0].name,
                [], // All relation types
                5   // Max depth for path finding
            );

            // Filter results to only include paths that reach the target
            const targetId = endNodes[0].node_id;
            const reachesTarget = pathResult.nodes.some((n: GraphTraversalNode) => n.node_id === targetId);

            return {
                paths: reachesTarget ? [pathResult] : [],
                start_node: startNodes[0],
                end_node: endNodes[0],
                path_found: reachesTarget
            };
        } catch (error: any) {
            console.error('[KnowledgeGraphManagerKuzu._executePathQuery] Error:', error);
            return { paths: [], error: error.message };
        }
    }

    /**
     * Formats Cypher query results into standard format
     */
    private _formatCypherResults(rawResults: any[]): any[] {
        return rawResults.map(row => {
            const formatted: any = {};
            Object.entries(row).forEach(([key, value]) => {
                if (value && typeof value === 'object' && 'id' in value) {
                    // This looks like a node
                    formatted[key] = {
                        node_id: value.id,
                        name: (value as any).name,
                        entityType: (value as any).entityType,
                        observations: (value as any).observations || []
                    };
                } else {
                    formatted[key] = value;
                }
            });
            return formatted;
        });
    }
}
