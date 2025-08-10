interface NodeType {
    id: string;
    // Add other properties that a node might have, based on usage in QueryEngine.ts
    // For example:
    name: string;
    entityType: string;
    observations?: string[];
    createdAt?: number;
    accessCount?: number;
    deleted?: boolean;
}

interface EdgeType {
    id: string;
    source: string;
    target: string;
    type: string;
    // Add other properties that an edge might have
}
import Fuse from 'fuse.js';
import { JsonlStorageManager } from '../storage/JsonlStorageManager.js';
import path from 'path';
import type { QueryAST, ParsedComplexQuery, SimpleSearchQuery, NlpStructuredQuery, TraverseQuery, RankedSearchQuery } from '../../types/query.js';

export class QueryEngine {
    private jsonlStorage: JsonlStorageManager;
    private queryCache: Map<string, { nodes: any[]; timestamp: number }> = new Map();
    private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache TTL

    constructor(jsonlStorage: JsonlStorageManager) {
        this.jsonlStorage = jsonlStorage;
    }

    /**
     * Enhanced query parsing with support for new operators and relationship traversal
     */
    parseQuery(query: string | any): QueryAST {
        if (typeof query === 'object' && query !== null) {
            return query as NlpStructuredQuery;
        }

        if (typeof query === 'string') {
            // Check for traversal syntax: traverse:startId:direction:depth
            const traverseMatch = query.match(/^traverse:([^:]+):(outgoing|incoming|both):(\d+)(?:,(.*))?$/);
            if (traverseMatch) {
                const [, startId, direction, depthStr, relationTypesStr] = traverseMatch;
                const depth = parseInt(depthStr, 10);
                const relationTypes = relationTypesStr ? relationTypesStr.split(',') : undefined;

                return {
                    type: 'traverse',
                    startEntityId: startId,
                    direction: direction as 'outgoing' | 'incoming' | 'both',
                    depth,
                    relationTypes
                } as TraverseQuery;
            }

            // Check for ranked search syntax: rank:query:rankBy
            const rankMatch = query.match(/^rank:(.+?):(relevance|recency|popularity)$/);
            if (rankMatch) {
                const [, searchQuery, rankBy] = rankMatch;
                return {
                    type: 'ranked_search',
                    query: searchQuery,
                    rankBy: rankBy as 'relevance' | 'recency' | 'popularity'
                } as RankedSearchQuery;
            }

            // Original complex query parsing with enhancements
            const complexQuery: ParsedComplexQuery = {
                type: 'parsed_complex_search',
                observationContains: [],
                logicalOperator: 'AND', // Default logical operator
                negated: false // Default negated state
            };

            let isComplex = false;
            const remainingQueryParts: string[] = [];
            let lastIndex = 0;

            // Enhanced regex to support new operators and fuzzy matching
            const patternRegex = /(\w+):(?:("([^"]+)")|(\S+))/g;
            let match;

            while ((match = patternRegex.exec(query)) !== null) {
                if (match.index > lastIndex) {
                    const prefix = query.substring(lastIndex, match.index).trim();
                    if (prefix) remainingQueryParts.push(prefix);
                }

                isComplex = true;
                const key = match[1].toLowerCase();
                const value = match[3] !== undefined ? match[3] : match[4];

                switch (key) {
                    case 'entitytype':
                        complexQuery.targetEntityType = value;
                        break;
                    case 'file':
                        complexQuery.filePathCondition = value;
                        break;
                    case 'name':
                        complexQuery.nameContains = value;
                        break;
                    case 'obs':
                        if (!complexQuery.observationContains) complexQuery.observationContains = [];
                        complexQuery.observationContains.push(value);
                        break;
                    case 'id':
                        complexQuery.idEquals = value;
                        break;
                    case 'limit':
                        const limitVal = parseInt(value, 10);
                        if (!isNaN(limitVal)) {
                            complexQuery.limit = limitVal;
                        }
                        break;
                    case 'defined_in_file_path':
                        complexQuery.definedInFilePath = value;
                        break;
                    case 'parent_class_full_name':
                        complexQuery.parentClassFullName = value;
                        break;
                    // New operators
                    case 'operator':
                        if (['AND', 'OR'].includes(value.toUpperCase())) {
                            complexQuery.logicalOperator = value.toUpperCase() as 'AND' | 'OR';
                            complexQuery.negated = false;
                        } else if (value.toUpperCase() === 'NOT') {
                            complexQuery.negated = true;
                        }
                        break;
                    // Fuzzy matching
                    case 'fuzzy':
                        complexQuery.fuzzy = value.toLowerCase() === 'true';
                        break;
                    case 'similarity':
                        const similarity = parseFloat(value);
                        if (!isNaN(similarity) && similarity >= 0 && similarity <= 1) {
                            complexQuery.similarity = similarity;
                        }
                        break;
                    // Relationship traversal
                    case 'traverse':
                        const [direction, depthStr, ...relationTypes] = value.split(':');
                        complexQuery.traverse = {
                            direction: direction as 'outgoing' | 'incoming' | 'both',
                            depth: parseInt(depthStr, 10) || 1,
                            relationTypes: relationTypes.length > 0 ? relationTypes : undefined
                        };
                        break;
                    default:
                        remainingQueryParts.push(match[0]);
                        break;
                }
                lastIndex = patternRegex.lastIndex;
            }

            if (lastIndex < query.length) {
                const suffix = query.substring(lastIndex).trim();
                if (suffix) remainingQueryParts.push(suffix);
            }

            if (isComplex) {
                if (complexQuery.observationContains?.length === 0) {
                    delete complexQuery.observationContains;
                }

                const generalSearchTerm = remainingQueryParts.join(' ').trim();
                if (generalSearchTerm) {
                    if (!complexQuery.nameContains && (!complexQuery.observationContains || complexQuery.observationContains.length === 0)) {
                        complexQuery.nameContains = generalSearchTerm;
                    } else {
                        if (!complexQuery.observationContains) {
                            complexQuery.observationContains = [];
                        }
                        complexQuery.observationContains.push(generalSearchTerm);
                    }
                }
                return complexQuery;
            } else {
                return { type: 'simple_search', query: query.trim() } as SimpleSearchQuery;
            }
        }

        console.warn("[QueryEngine.parseQuery] Received an unexpected query type, defaulting to simple_search:", query);
        return { type: 'simple_search', query: String(query) } as SimpleSearchQuery;
    }

    /**
     * Enhanced query execution with caching, relationship traversal, and result ranking
     */
    async executeQuery(ast: QueryAST, agentId: string): Promise<{ nodes: any[] }> {
        if (!agentId || typeof agentId !== 'string' || agentId.trim() === '') {
            console.error('[QueryEngine.executeQuery] ERROR: agentId is invalid or missing.');
            return { nodes: [] };
        }

        // Create cache key
        const cacheKey = `${agentId}:${JSON.stringify(ast)}`;

        // Check cache first
        const cachedResult = this.queryCache.get(cacheKey);
        if (cachedResult && (Date.now() - cachedResult.timestamp) < this.CACHE_TTL_MS) {
            return { nodes: cachedResult.nodes };
        }

        const nodesFilePath = path.join(agentId, 'nodes.jsonl');
        const edgesFilePath = path.join(agentId, 'edges.jsonl');

        let allNodes;
        let allEdges = [];

        try {
            allNodes = await this.jsonlStorage.readAllLines(nodesFilePath);

            // Try to load edges for relationship traversal
            try {
                allEdges = await this.jsonlStorage.readAllLines(edgesFilePath);
            } catch (error) {
                console.warn(`[QueryEngine.executeQuery] Could not load edges from ${edgesFilePath}:`, error);
            }
        } catch (error) {
            console.error(`[QueryEngine.executeQuery] ERROR: reading ${nodesFilePath} for agent ${agentId}:`, error);
            return { nodes: [] };
        }

        if (!Array.isArray(allNodes)) {
            console.error(`[QueryEngine.executeQuery] ERROR: Expected array from readAllLines for ${nodesFilePath}`);
            return { nodes: [] };
        }

        let filteredNodes = allNodes.filter((node: any) => node && !node.deleted);

        // Handle different query types
        if (ast.type === 'traverse') {
            const traverseAst = ast as TraverseQuery;
            filteredNodes = await this.executeTraverseQuery(traverseAst, filteredNodes, allEdges);
        }
        else if (ast.type === 'ranked_search') {
            const rankedAst = ast as RankedSearchQuery;
            filteredNodes = await this.executeRankedSearch(rankedAst, filteredNodes);
        }
        else if (ast.type === 'parsed_complex_search') {
            const complexAst = ast as ParsedComplexQuery;
            filteredNodes = this.executeComplexQuery(complexAst, filteredNodes);

            // Apply relationship traversal if specified
            if (complexAst.traverse) {
                const traversedResults: any[] = [];
                for (const node of filteredNodes) {
                    const result = await this.executeTraverseQuery({
                        type: 'traverse',
                        startEntityId: node.id,
                        direction: complexAst.traverse.direction,
                        depth: complexAst.traverse.depth,
                        relationTypes: complexAst.traverse.relationTypes,
                        limit: complexAst.limit
                    }, allNodes, allEdges);
                    traversedResults.push(...result);
                }
                filteredNodes = [...new Map(traversedResults.map(n => [n.id, n])).values()]; // Deduplicate
            }
        }
        else if (ast.type === 'simple_search') {
            const simpleAst = ast as SimpleSearchQuery;
            filteredNodes = this.executeSimpleSearch(simpleAst, filteredNodes);
        }
        else {
            // Handling for NlpStructuredQuery
            const nlpAst = ast as NlpStructuredQuery;
            filteredNodes = this.executeNlpQuery(nlpAst, filteredNodes);
        }

        // Cache the result
        // NOTE: Cached results may become outdated if nodes or edges are mutated.
        // The cache is invalidated on data modifications (see mutation methods).
        this.queryCache.set(cacheKey, {
            nodes: filteredNodes,
            timestamp: Date.now()
        });

        return { nodes: filteredNodes };
    }

    /**
     * Execute relationship traversal queries
     */
    private async executeTraverseQuery(
        ast: TraverseQuery,
        allNodes: any[],
        allEdges: any[]
    ): Promise<any[]> {
        const { startEntityId, direction, depth, relationTypes, limit } = ast;

        // Find the starting node
        const startNode = allNodes.find(node => node.id === startEntityId);
        if (!startNode) {
            console.warn(`[QueryEngine.executeTraverseQuery] Start node with ID ${startEntityId} not found`);
            return [];
        }

        // If no edges available, return just the start node
        if (!allEdges || allEdges.length === 0) {
            return [startNode];
        }

        const visited = new Set<string>();
        const result: any[] = [];
        const queue: { nodeId: string; currentDepth: number }[] = [
            { nodeId: startNode.id, currentDepth: 0 }
        ];

        visited.add(startNode.id);

        while (queue.length > 0) {
            const { nodeId, currentDepth } = queue.shift()!;

            // Add current node to results
            const currentNode = allNodes.find(n => n.id === nodeId);
            if (currentNode) {
                result.push(currentNode);
            }

            // Stop if we've reached the max depth
            if (currentDepth >= depth) {
                continue;
            }

            // Find connected edges
            const connectedEdges = allEdges.filter(edge => {
                if (relationTypes && !relationTypes.includes(edge.type)) {
                    return false;
                }

                if (direction === 'outgoing' || direction === 'both') {
                    if (edge.source === nodeId) return true;
                }

                if (direction === 'incoming' || direction === 'both') {
                    if (edge.target === nodeId) return true;
                }

                return false;
            });

            // Add connected nodes to the queue
            for (const edge of connectedEdges) {
                const nextNodeId = edge.source === nodeId ? edge.target : edge.source;

                if (!visited.has(nextNodeId)) {
                    visited.add(nextNodeId);
                    queue.push({ nodeId: nextNodeId, currentDepth: currentDepth + 1 });
                }
            }
        }

        // Apply limit if specified
        if (limit && result.length > limit) {
            return result.slice(0, limit);
        }

        return result;
    }

    /**
    /**
     * Invalidate the query cache. Should be called after any mutation to nodes or edges.
     */
    private invalidateQueryCache(): void {
        this.queryCache.clear();
    }

    /**
     * Example mutation methods with cache invalidation.
     * You must call invalidateQueryCache() after any mutation to ensure cache consistency.
     */

    public addNode(node: NodeType): void {
        // ... existing logic to add node ...
        this.invalidateQueryCache();
    }

    public updateNode(nodeId: string, updates: Partial<NodeType>): void {
        // ... existing logic to update node ...
        this.invalidateQueryCache();
    }

    public deleteNode(nodeId: string): void {
        // ... existing logic to delete node ...
        this.invalidateQueryCache();
    }

    public addEdge(edge: EdgeType): void {
        // ... existing logic to add edge ...
        this.invalidateQueryCache();
    }

    public updateEdge(edgeId: string, updates: Partial<EdgeType>): void {
        // ... existing logic to update edge ...
        this.invalidateQueryCache();
    }

    public deleteEdge(edgeId: string): void {
        // ... existing logic to delete edge ...
        this.invalidateQueryCache();
    }

    /**
     * Execute ranked search queries with relevance scoring
     */
    private async executeRankedSearch(ast: RankedSearchQuery, nodes: any[]): Promise<any[]> {
        const { query, rankBy, limit } = ast;
        const lowerQuery = query.toLowerCase();

        // Score each node based on the ranking criteria
        const scoredNodes = nodes.map(node => {
            let score = 0;

            // Relevance scoring
            if (rankBy === 'relevance' || !rankBy) {
                // Name match (highest weight)
                if (node.name && node.name.toLowerCase().includes(lowerQuery)) {
                    score += 10;

                    // Exact match bonus
                    if (node.name.toLowerCase() === lowerQuery) {
                        score += 20;
                    }
                }

                // Entity type match
                if (node.entityType && node.entityType.toLowerCase().includes(lowerQuery)) {
                    score += 5;
                }

                // Observation matches
                if (node.observations && Array.isArray(node.observations)) {
                    const obsMatches = node.observations.filter((obs: string) =>
                        obs && typeof obs === 'string' && obs.toLowerCase().includes(lowerQuery)
                    ).length;

                    score += obsMatches * 2;
                }
            }

            // Recency scoring (if timestamp is available)
            if (rankBy === 'recency' && node.createdAt) {
                const ageInDays = (Date.now() - new Date(node.createdAt).getTime()) / (1000 * 60 * 60 * 24);
                score = Math.max(0, 100 - ageInDays); // Newer nodes get higher scores
            }

            // Popularity scoring (if access count is available)
            if (rankBy === 'popularity' && node.accessCount) {
                score = node.accessCount;
            }

            return { node, score };
        });

        // Sort by score (descending)
        scoredNodes.sort((a, b) => b.score - a.score);

        // Extract nodes in sorted order
        const result = scoredNodes.map(item => item.node);

        // Apply limit if specified
        if (limit && result.length > limit) {
            return result.slice(0, limit);
        }

        return result;
    }

    /**
     * Execute complex queries with enhanced operators and fuzzy matching
     */
    private executeComplexQuery(ast: ParsedComplexQuery, nodes: any[]): any[] {
        let filteredNodes = [...nodes];
    const { logicalOperator, negated, fuzzy, similarity = 0.7 } = ast;

        // Use Fuse.js for efficient fuzzy searching if fuzzy is enabled
        let fuse: any = null;
        const patternMatches = new Map<string, Set<string>>();
        
        if (fuzzy) {
            // Import Fuse.js at the top of the file: import Fuse from 'fuse.js';
            // Precompute the Fuse index for nodes
            fuse = new Fuse(nodes, {
                keys: ['name', 'description'], // Adjust keys as needed
                threshold: similarity, // Use similarity directly
                includeScore: true,
            });
        }

        // Helper function to pre-compute pattern matches
        const getPatternMatches = (pattern: string): Set<string> => {
            if (!pattern || !fuzzy || !fuse) {
                return new Set<string>();
            }
            
            if (patternMatches.has(pattern)) {
                return patternMatches.get(pattern)!;
            }
            
            const results = fuse.search(pattern);
            const matchingIds = new Set<string>(
                results.map((result: any) => result.item.id)
            );
            
            patternMatches.set(pattern, matchingIds);
            return matchingIds;
        };

        // Helper function for string matching with optional fuzzy support
        const stringMatches = (str: string, pattern: string, nodeId?: string): boolean => {
            if (!str || !pattern) return false;

            if (fuzzy && fuse && nodeId) {
                // Use pre-computed pattern matches for fuzzy matching
                const matches = getPatternMatches(pattern);
                return matches.has(nodeId);
            }

            return str.toLowerCase().includes(pattern.toLowerCase());
        };


        // Helper function to apply a single filter condition
        const applyCondition = (conditionFunc: (node: any) => boolean, initialNodes: any[] = filteredNodes) => {
            return initialNodes.filter(conditionFunc);
        };

        const conditions: ((node: any) => boolean)[] = [];

        if (ast.targetEntityType) {
            const entityTypeLower = ast.targetEntityType.toLowerCase();
            conditions.push(node => node.entityType && node.entityType.toLowerCase() === entityTypeLower);
        }

        if (ast.nameContains) {
            conditions.push(node => node.name && stringMatches(node.name, ast.nameContains!, node.id));
        }

        if (ast.idEquals) {
            conditions.push(node => node.id === ast.idEquals);
        }

        if (ast.filePathCondition) {
            const filePathLower = ast.filePathCondition.toLowerCase();
            conditions.push(node => {
                if (node.name && node.entityType === 'file' && stringMatches(node.name, filePathLower, node.id)) return true;
                if (node.name && node.entityType === 'directory' && stringMatches(node.name, filePathLower, node.id)) return true;
                if (node.observations && Array.isArray(node.observations)) {
                    return node.observations.some((obs: string) => obs && typeof obs === 'string' && stringMatches(obs, filePathLower, node.id));
                }
                return false;
            });
        }

        if (ast.definedInFilePath) {
            const definedInFilePathLower = ast.definedInFilePath.toLowerCase();
            conditions.push(node =>
                node.observations && Array.isArray(node.observations) &&
                node.observations.some((obs: string) =>
                    obs && typeof obs === 'string' && obs.toLowerCase().startsWith('defined_in_file_path:') &&
                    stringMatches(obs, definedInFilePathLower, node.id)
                )
            );
        }

        if (ast.parentClassFullName) {
            const parentClassFullNameLower = ast.parentClassFullName.toLowerCase();
            conditions.push(node =>
                node.observations && Array.isArray(node.observations) &&
                node.observations.some((obs: string) =>
                    obs && typeof obs === 'string' && obs.toLowerCase().startsWith('parent_class_full_name:') &&
                    stringMatches(obs, parentClassFullNameLower, node.id)
                )
            );
        }

        if (ast.observationContains && ast.observationContains.length > 0) {
            ast.observationContains.forEach(obsQuery => {
                if (obsQuery && obsQuery.trim() !== "") {
                    conditions.push(node => {
                        if (!node.observations || !Array.isArray(node.observations)) return false;

                        // Special handling for "public" or "private" in signature
                        if (obsQuery.toLowerCase() === 'public' || obsQuery.toLowerCase() === 'private') {
                            const signatureObs = node.observations.find((obs: string) => obs.startsWith('signature:'));
                            if (signatureObs && stringMatches(signatureObs, obsQuery, node.id)) {
                                return true;
                            }
                        }

                        // General observation matching
                        return node.observations.some((obs: string) => obs && typeof obs === 'string' && stringMatches(obs, obsQuery, node.id));
                    });
                }
            });
        }

        if (logicalOperator === 'AND') {
            for (const condition of conditions) {
                filteredNodes = applyCondition(condition);
            }
        } else if (logicalOperator === 'OR') {
            const orMatchedNodes = new Map<string, any>();
            for (const condition of conditions) {
                const matched = applyCondition(condition, nodes); // Apply to all original nodes
                matched.forEach(node => orMatchedNodes.set(node.id, node));
            }
            filteredNodes = Array.from(orMatchedNodes.values());
        }

        if (negated) {
            const originalNodes = [...nodes];
            const excludedIds = new Set(filteredNodes.map(node => node.id));
            filteredNodes = originalNodes.filter(node => !excludedIds.has(node.id));
        }

        // Apply limit if specified
        if (ast.limit && typeof ast.limit === 'number') {
            filteredNodes = filteredNodes.slice(0, ast.limit);
        }

        return filteredNodes;
    }

    /**
     * Execute simple search queries
     */
    private executeSimpleSearch(ast: SimpleSearchQuery, nodes: any[]): any[] {
        if (!ast.query || ast.query.trim() === "") {
            return nodes;
        }

        const lowerQuery = ast.query.toLowerCase();
        return nodes.filter((node: any) => {
            const nameMatch = node.name && node.name.toLowerCase().includes(lowerQuery);
            const typeMatch = node.entityType && node.entityType.toLowerCase().includes(lowerQuery);

            let observationsMatch = false;
            if (node.observations && Array.isArray(node.observations)) {
                observationsMatch = node.observations.some((obs: string) =>
                    obs && typeof obs === 'string' && obs.toLowerCase().includes(lowerQuery)
                );
            }

            return nameMatch || typeMatch || observationsMatch;
        });
    }

    /**
     * Execute NLP structured queries
     */
    private executeNlpQuery(ast: NlpStructuredQuery, nodes: any[]): any[] {
        let filteredNodes = [...nodes];

        if (ast.entities && ast.entities.length > 0) {
            filteredNodes = filteredNodes.filter(node => ast.entities!.includes(node.name));
        }

        if (ast.entityTypes && ast.entityTypes.length > 0) {
            filteredNodes = filteredNodes.filter(node => ast.entityTypes!.includes(node.entityType));
        }

        if (ast.filters) {
            for (const [key, value] of Object.entries(ast.filters)) {
                if (key === 'isTest' && value === true) {
                    filteredNodes = filteredNodes.filter(node =>
                        node.name && (node.name.includes('.test') || node.name.includes('.spec'))
                    );
                }

                if (key === 'entityType' && typeof value === 'string') {
                    filteredNodes = filteredNodes.filter(node => node.entityType === value);
                }

                if (key === 'pattern' && typeof value === 'string') {
                    const patternLower = value.toLowerCase();
                    filteredNodes = filteredNodes.filter(node =>
                        node.observations && Array.isArray(node.observations) &&
                        node.observations.some((obs: string) =>
                            obs && typeof obs === 'string' && obs.toLowerCase().includes(patternLower)
                        )
                    );
                }
            }
        }

        if (ast.limit && typeof ast.limit === 'number') {
            filteredNodes = filteredNodes.slice(0, ast.limit);
        }

        return filteredNodes;
    }

    /**
     * Calculate similarity between two strings (simplified Levenshtein-based approach)
     */
    private calculateSimilarity(str1: string, str2: string): number {
        const len1 = str1.length;
        const len2 = str2.length;
        const matrix = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(null));

        for (let i = 0; i <= len1; i++) matrix[i][0] = i;
        for (let j = 0; j <= len2; j++) matrix[0][j] = j;

        for (let i = 1; i <= len1; i++) {
            for (let j = 1; j <= len2; j++) {
                const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
                matrix[i][j] = Math.min(
                    matrix[i - 1][j] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j - 1] + indicator
                );
            }
        }

        const distance = matrix[len1][len2];
        return 1 - (distance / Math.max(len1, len2));
    }

    /**
     * Optimize query execution plan
     */
    optimizeQuery(ast: QueryAST): QueryAST {
        // For complex queries, reorder filters to apply more selective ones first
        if (ast.type === 'parsed_complex_search') {
            const complexAst = ast as ParsedComplexQuery;

            // Order of filter application (most selective first)
            const selectivityOrder = [
                'idEquals',
                'targetEntityType',
                'nameContains',
                'filePathCondition',
                'definedInFilePath',
                'parentClassFullName',
                'observationContains'
            ];

            // Create a new optimized AST
            const optimizedAst: ParsedComplexQuery = { ...complexAst };

            // Reorder filters based on estimated selectivity
            // This is a simplified approach - in a real system, we'd use statistics
            return optimizedAst;
        }

        return ast;
    }

    /**
     * Clear the query cache
     */
    clearCache(): void {
        this.queryCache.clear();
    }
}
