import Fuse from 'fuse.js';
import { JsonlStorageManager } from '../storage/JsonlStorageManager.js';
import path from 'path';
import type { QueryAST, ParsedComplexQuery, SimpleSearchQuery, NlpStructuredQuery, TraverseQuery, RankedSearchQuery, FindSourcesSpec } from '../../types/query.js';

/**
 * Represents a node in the knowledge graph.
 */
interface NodeType {
    id: string;
    name: string;
    entityType: string;
    observations?: string[];
    timestamp?: number; // For recency ranking
    accessCount?: number; // For popularity ranking
    deleted?: boolean;
}

/**
 * Represents a relation (edge) between two nodes in the knowledge graph.
 */
interface RelationType {
    id: string;
    fromNodeId: string;
    toNodeId: string;
    relationType: string;
    deleted?: boolean;
}

export class QueryEngine {
    private jsonlStorage: JsonlStorageManager;
    private queryCache: Map<string, { nodes: any[]; timestamp: number }> = new Map();
    private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache TTL

    constructor(jsonlStorage: JsonlStorageManager) {
        this.jsonlStorage = jsonlStorage;
    }

    /**
     * Parses a query string into a structured QueryAST object.
     * Supports simple, complex, traversal, and ranked search syntaxes.
     */
    public parseQuery(query: string | any): QueryAST {
        if (typeof query === 'object' && query !== null) {
            return query as NlpStructuredQuery; // Assume it's already a structured query
        }

        if (typeof query !== 'string') {
            console.warn("[QueryEngine.parseQuery] Received an unexpected query type, defaulting to simple_search:", query);
            return { type: 'simple_search', query: String(query) } as SimpleSearchQuery;
        }

        // Traversal query: traverse:startNodeName:direction:depth:relation1,relation2
        const traverseMatch = query.match(/^traverse:([^:]+):(outgoing|incoming|both):(\d+)(?::(.*))?$/);
        if (traverseMatch) {
            const [, startNodeName, direction, depthStr, relationTypesStr] = traverseMatch;
            return {
                type: 'traverse',
                startEntityId: startNodeName,
                direction: direction as 'outgoing' | 'incoming' | 'both',
                depth: parseInt(depthStr, 10),
                relationTypes: relationTypesStr ? relationTypesStr.split(',') : undefined,
            } as TraverseQuery;
        }

        // Ranked search query: rank:query:rankBy
        const rankMatch = query.match(/^rank:(.+?):(relevance|recency|popularity)$/);
        if (rankMatch) {
            const [, searchQuery, rankBy] = rankMatch;
            return {
                type: 'ranked_search',
                query: searchQuery,
                rankBy: rankBy as 'relevance' | 'recency' | 'popularity',
            } as RankedSearchQuery;
        }

        // Complex query parsing
        const complexQuery: ParsedComplexQuery = {
            type: 'parsed_complex_search',
            observationContains: [],
            logicalOperator: 'AND',
            negated: false,
        };

        const patternRegex = /(\w+):(?:("([^"]+)")|(\S+))/g;
        let match;
        let isComplex = false;
        const remainingParts: string[] = [];
        let lastIndex = 0;

        while ((match = patternRegex.exec(query)) !== null) {
            isComplex = true;
            const prefix = query.substring(lastIndex, match.index).trim();
            if (prefix) remainingParts.push(prefix);

            const key = match[1].toLowerCase();
            const value = match[3] !== undefined ? match[3] : match[4];

            switch (key) {
                case 'entitytype': complexQuery.targetEntityType = value; break;
                case 'file': complexQuery.filePathCondition = value; break;
                case 'name': complexQuery.nameContains = value; break;
                case 'obs':
                    if (complexQuery.observationContains) {
                        complexQuery.observationContains.push(value);
                    }
                    break;
                case 'id': complexQuery.idEquals = value; break;
                case 'limit': complexQuery.limit = parseInt(value, 10) || undefined; break;
                case 'defined_in_file_path': complexQuery.definedInFilePath = value; break;
                case 'parent_class_full_name': complexQuery.parentClassFullName = value; break;
                case 'operator':
                    if (['AND', 'OR'].includes(value.toUpperCase())) {
                        complexQuery.logicalOperator = value.toUpperCase() as 'AND' | 'OR';
                    } else if (value.toUpperCase() === 'NOT') {
                        complexQuery.negated = true;
                    }
                    break;
                case 'fuzzy': complexQuery.fuzzy = value.toLowerCase() === 'true'; break;
                case 'similarity': complexQuery.similarity = parseFloat(value) || 0.7; break;
                default: remainingParts.push(match[0]); break;
            }
            lastIndex = patternRegex.lastIndex;
        }

        const suffix = query.substring(lastIndex).trim();
        if (suffix) remainingParts.push(suffix);

        if (isComplex) {
            const generalSearchTerm = remainingParts.join(' ').trim();
            if (generalSearchTerm && complexQuery.observationContains) {
                complexQuery.observationContains.push(generalSearchTerm);
            }
            return complexQuery;
        }

        return { type: 'simple_search', query: query.trim() } as SimpleSearchQuery;
    }

    /**
     * Executes a parsed QueryAST against the knowledge graph for a specific agent.
     */
    public async executeQuery(ast: QueryAST, agentId: string): Promise<{ nodes: NodeType[] }> {
        if (!agentId || typeof agentId !== 'string' || agentId.trim() === '') {
            console.error('[QueryEngine.executeQuery] ERROR: agentId is invalid or missing.');
            return { nodes: [] };
        }

        const cacheKey = `${agentId}:${JSON.stringify(ast)}`;
        const cachedResult = this.queryCache.get(cacheKey);
        if (cachedResult && Date.now() - cachedResult.timestamp < this.CACHE_TTL_MS) {
            return { nodes: cachedResult.nodes };
        }

        const nodesFilePath = path.join(agentId, 'nodes.jsonl');
        const relationsFilePath = path.join(agentId, 'relations.jsonl');

        let allNodes: NodeType[];
        let allRelations: RelationType[] = [];

        try {
            allNodes = (await this.jsonlStorage.readAllLines(nodesFilePath)).filter((node: any) => node && !node.deleted);
            allRelations = (await this.jsonlStorage.readAllLines(relationsFilePath)).filter((rel: any) => rel && !rel.deleted);
        } catch (error) {
            console.error(`[QueryEngine.executeQuery] ERROR: reading data for agent ${agentId}:`, error);
            return { nodes: [] };
        }

        let resultNodes: NodeType[] = [];

        switch (ast.type) {
            case 'traverse':
                resultNodes = await this.executeTraverseQuery(ast as TraverseQuery, allNodes, allRelations);
                break;
            case 'ranked_search':
                resultNodes = await this.executeRankedSearch(ast as RankedSearchQuery, allNodes);
                break;
            case 'parsed_complex_search':
                const complexAst = ast as ParsedComplexQuery;
                if (complexAst.findSourcesOf) {
                    resultNodes = await this.executeFindSourcesQuery(complexAst.findSourcesOf, allNodes, allRelations);
                } else {
                    resultNodes = this.executeComplexQuery(complexAst, allNodes);
                }
                break;
            case 'simple_search':
                resultNodes = this.executeSimpleSearch(ast as SimpleSearchQuery, allNodes);
                break;
            default: // Handles NlpStructuredQuery and others
                resultNodes = this.executeNlpQuery(ast as NlpStructuredQuery, allNodes);
                break;
        }

        this.queryCache.set(cacheKey, { nodes: resultNodes, timestamp: Date.now() });
        return { nodes: resultNodes };
    }

    /**
     * Executes an inverse traversal to find source nodes of a relationship.
     */
    private async executeFindSourcesQuery(spec: FindSourcesSpec, allNodes: NodeType[], allRelations: RelationType[]): Promise<NodeType[]> {
        console.log(`[QueryEngine] Executing findSourcesOf query for target: "${spec.targetNodeName}"`);
        // 1. Find the target node to get its ID.
        const targetNode = allNodes.find(node => node.name === spec.targetNodeName);
        if (!targetNode) {
            console.warn(`[QueryEngine] Target node "${spec.targetNodeName}" not found for inverse traversal.`);
            return [];
        }
        const targetNodeId = targetNode.id;

        // 2. Find all relations pointing to the target node with the correct type.
        const incomingRelations = allRelations.filter(rel =>
            rel.toNodeId === targetNodeId && rel.relationType === spec.relationType
        );

        if (incomingRelations.length === 0) {
            return [];
        }

        // 3. Collect all unique source node IDs.
        const sourceNodeIds = new Set(incomingRelations.map(rel => rel.fromNodeId));

        // 4. Efficiently look up the source nodes by their IDs.
        const idToNodeMap = new Map(allNodes.map(node => [node.id, node]));
        const resultNodes: NodeType[] = [];
        for (const sourceId of sourceNodeIds) {
            const sourceNode = idToNodeMap.get(sourceId);
            if (sourceNode) {
                resultNodes.push(sourceNode);
            }
        }

        console.log(`[QueryEngine] Found ${resultNodes.length} source nodes for target "${spec.targetNodeName}".`);
        return resultNodes;
    }

    /**
     * Executes a graph traversal query.
     */
    private async executeTraverseQuery(ast: TraverseQuery, allNodes: NodeType[], allRelations: RelationType[]): Promise<NodeType[]> {
        const { startEntityId, direction, depth, relationTypes } = ast;

        let startNode: NodeType | undefined = allNodes.find(node => node.name === startEntityId);

        if (!startNode) {
            console.warn(`[QueryEngine] Target node "${startEntityId}" not found for traversal. Attempting fallback search.`);
            const fallbackResults = this.executeSimpleSearch({ type: 'simple_search', query: startEntityId }, allNodes);

            if (fallbackResults.length > 0) {
                startNode = fallbackResults[0];
                console.log(`[QueryEngine] Fallback successful. Using node "${startNode.name}" as traversal start.`);
            } else {
                console.error(`[QueryEngine] Fallback failed. Start node "${startEntityId}" not found.`);
                return [];
            }
        }

        const idToNodeMap = new Map(allNodes.map(n => [n.id, n]));
        const visited = new Set<string>();
        const result: NodeType[] = [];
        const queue: { nodeId: string; currentDepth: number }[] = [{ nodeId: startNode.id, currentDepth: 0 }];
        visited.add(startNode.id);

        while (queue.length > 0) {
            const { nodeId, currentDepth } = queue.shift()!;
            const currentNode = idToNodeMap.get(nodeId);
            if (currentNode) result.push(currentNode);

            if (currentDepth >= depth) continue;

            for (const rel of allRelations) {
                if (relationTypes && !relationTypes.includes(rel.relationType)) continue;

                let nextNodeId: string | null = null;
                if ((direction === 'outgoing' || direction === 'both') && rel.fromNodeId === nodeId) {
                    nextNodeId = rel.toNodeId;
                } else if ((direction === 'incoming' || direction === 'both') && rel.toNodeId === nodeId) {
                    nextNodeId = rel.fromNodeId;
                }

                if (nextNodeId && !visited.has(nextNodeId)) {
                    visited.add(nextNodeId);
                    queue.push({ nodeId: nextNodeId, currentDepth: currentDepth + 1 });
                }
            }
        }
        return result;
    }

    /**
     * Executes a ranked search query, scoring nodes based on relevance, recency, or popularity.
     */
    private async executeRankedSearch(ast: RankedSearchQuery, nodes: NodeType[]): Promise<NodeType[]> {
        const { query, rankBy } = ast;
        const lowerQuery = query.toLowerCase();

        const scoredNodes = nodes.map(node => {
            let score = 0;
            switch (rankBy) {
                case 'recency':
                    if (node.timestamp) {
                        const ageInDays = (Date.now() - node.timestamp) / (1000 * 60 * 60 * 24);
                        score = Math.max(0, 100 - ageInDays);
                    }
                    break;
                case 'popularity':
                    score = node.accessCount || 0;
                    break;
                case 'relevance':
                default:
                    if (node.name?.toLowerCase().includes(lowerQuery)) score += 10;
                    if (node.name?.toLowerCase() === lowerQuery) score += 20; // Exact match bonus
                    if (node.entityType?.toLowerCase().includes(lowerQuery)) score += 5;
                    score += (node.observations?.filter(obs => obs?.toLowerCase().includes(lowerQuery)).length || 0) * 2;
                    break;
            }
            return { node, score };
        });

        scoredNodes.sort((a, b) => b.score - a.score);
        return scoredNodes.map(item => item.node).slice(0, ast.limit || 50);
    }

    /**
     * Executes a complex query with multiple conditions and logical operators.
     */
    private executeComplexQuery(ast: ParsedComplexQuery, nodes: NodeType[]): NodeType[] {
        const { logicalOperator, negated } = ast;

        const conditions: ((node: NodeType) => boolean)[] = [];
        const fuse = ast.fuzzy ? new Fuse(nodes, { keys: ['name', 'observations'], threshold: 1 - (ast.similarity || 0.7), includeScore: false }) : null;

        const stringMatches = (text: string, pattern: string): boolean => {
            return text.toLowerCase().includes(pattern.toLowerCase());
        };

        if (ast.targetEntityType) conditions.push(node => stringMatches(node.entityType, ast.targetEntityType!));
        if (ast.idEquals) conditions.push(node => node.id === ast.idEquals);

        if (ast.nameContains) {
            if (fuse) {
                const results = new Set(fuse.search({ name: ast.nameContains }).map((r: any) => r.item.id));
                conditions.push(node => results.has(node.id));
            } else {
                conditions.push(node => stringMatches(node.name, ast.nameContains!));
            }
        }

        if (ast.filePathCondition) conditions.push(node => (node.entityType === 'file' || node.observations?.some(obs => obs.includes(ast.filePathCondition!)))!);
        if (ast.definedInFilePath) conditions.push(node => (node.observations?.some(obs => obs.startsWith('defined_in_file_path:') && obs.includes(ast.definedInFilePath!)))!);
        if (ast.parentClassFullName) conditions.push(node => (node.observations?.some(obs => obs.startsWith('parent_class_full_name:') && obs.includes(ast.parentClassFullName!)))!);

        if (ast.observationContains) {
            ast.observationContains.forEach(obsQuery => {
                if (fuse) {
                    const results = new Set(fuse.search({ observations: obsQuery }).map((r: any) => r.item.id));
                    conditions.push(node => results.has(node.id));
                } else {
                    conditions.push(node => node.observations?.some(obs => stringMatches(obs, obsQuery)) || false);
                }
            });
        }

        let filteredNodes: NodeType[];
        if (logicalOperator === 'OR') {
            const matchedNodes = new Map<string, NodeType>();
            for (const condition of conditions) {
                nodes.filter(condition).forEach(node => matchedNodes.set(node.id, node));
            }
            filteredNodes = Array.from(matchedNodes.values());
        } else { // AND logic
            filteredNodes = nodes;
            for (const condition of conditions) {
                filteredNodes = filteredNodes.filter(condition);
            }
        }

        if (negated) {
            const excludedIds = new Set(filteredNodes.map(node => node.id));
            filteredNodes = nodes.filter(node => !excludedIds.has(node.id));
        }

        return ast.limit ? filteredNodes.slice(0, ast.limit) : filteredNodes;
    }

    /**
     * Executes a simple, keyword-based search.
     */
    private executeSimpleSearch(ast: SimpleSearchQuery, nodes: NodeType[]): NodeType[] {
        if (!ast.query) return nodes;
        const lowerQuery = ast.query.toLowerCase();
        return nodes.filter(node =>
            node.name?.toLowerCase().includes(lowerQuery) ||
            node.entityType?.toLowerCase().includes(lowerQuery) ||
            node.observations?.some(obs => obs?.toLowerCase().includes(lowerQuery))
        );
    }

    /**
     * Executes a query generated by the NLP processor.
     */
    private executeNlpQuery(ast: NlpStructuredQuery, nodes: NodeType[]): NodeType[] {
        let filteredNodes = nodes;
        if (ast.entities?.length) {
            filteredNodes = filteredNodes.filter(node =>
                ast.entities!.some(entity => {
                    if (typeof entity === 'string') {
                        return node.name === entity;
                    } else {
                        // Handle the case where entity is { entityType: string; value: string }
                        return node.name === entity.value;
                    }
                })
            );
        }
        if (ast.entityTypes?.length) filteredNodes = filteredNodes.filter(node => ast.entityTypes!.includes(node.entityType as any));
        if (ast.filters) {
            for (const [key, value] of Object.entries(ast.filters)) {
                if (key === 'isTest' && value) filteredNodes = filteredNodes.filter(node => node.name?.includes('.test') || node.name?.includes('.spec'));
                else if (key === 'entityType' && typeof value === 'string') filteredNodes = filteredNodes.filter(node => node.entityType === value);
            }
        }
        return ast.limit ? filteredNodes.slice(0, ast.limit) : filteredNodes;
    }

    /**
     * Invalidates the entire query cache. Call this after any data mutation.
     */
    public clearCache(): void {
        this.queryCache.clear();
        console.log("QueryEngine cache cleared.");
    }
}