import { KuzuStorageManager } from '../storage/KuzuStorageManager.js';

export interface CypherQueryResult {
    nodes: any[];
    relations: any[];
    metadata: {
        executionTime: number;
        totalResults: number;
        query: string;
    };
}

export class CypherQueryEngine {
    private kuzuStorage: KuzuStorageManager;

    constructor(kuzuStorage: KuzuStorageManager) {
        this.kuzuStorage = kuzuStorage;
    }

    /**
     * Translates natural language to Cypher queries
     */
    translateNaturalLanguageToCypher(agentId: string, nlQuery: string): string {
        const nodeTable = this.getNodeTableName(agentId);
        const relationTable = this.getRelationTableName(agentId);

        const lowerQuery = nlQuery.toLowerCase();

        // Pattern matching for common queries
        if (lowerQuery.includes('all functions') || lowerQuery.includes('list functions')) {
            return `MATCH (n:${nodeTable}) WHERE n.entityType = 'function' RETURN n LIMIT 50`;
        }

        if (lowerQuery.includes('all classes') || lowerQuery.includes('list classes')) {
            return `MATCH (n:${nodeTable}) WHERE n.entityType = 'class' RETURN n LIMIT 50`;
        }

        if (lowerQuery.includes('all files') || lowerQuery.includes('list files')) {
            return `MATCH (n:${nodeTable}) WHERE n.entityType = 'file' RETURN n LIMIT 50`;
        }

        // Pattern: "functions that call X"
        const callsMatch = lowerQuery.match(/functions?\s+that\s+call\s+([a-zA-Z_]\w*)/);
        if (callsMatch) {
            const targetFunction = callsMatch[1];
            return `
                MATCH (caller:${nodeTable})-[r:${relationTable}]->(target:${nodeTable})
                WHERE caller.entityType = 'function'
                AND r.relationType = 'calls_function'
                AND target.name CONTAINS '${targetFunction}'
                RETURN caller, r, target
            `;
        }

        // Pattern: "classes that extend X"
        const extendsMatch = lowerQuery.match(/classes?\s+that\s+extend\s+([a-zA-Z_]\w*)/);
        if (extendsMatch) {
            const baseClass = extendsMatch[1];
            return `
                MATCH (child:${nodeTable})-[r:${relationTable}]->(parent:${nodeTable})
                WHERE child.entityType = 'class'
                AND r.relationType = 'extends_class'
                AND parent.name CONTAINS '${baseClass}'
                RETURN child, r, parent
            `;
        }

        // Pattern: "files that import X"
        const importMatch = lowerQuery.match(/files?\s+that\s+import\s+([a-zA-Z_./]\w*)/);
        if (importMatch) {
            const importTarget = importMatch[1];
            return `
                MATCH (file:${nodeTable})-[r:${relationTable}]->(imported:${nodeTable})
                WHERE file.entityType = 'file'
                AND r.relationType IN ['imports_file', 'imports_module']
                AND imported.name CONTAINS '${importTarget}'
                RETURN file, r, imported
            `;
        }

        // Pattern: "dependencies of X"
        const depsMatch = lowerQuery.match(/dependencies\s+of\s+([a-zA-Z_./]\w*)/);
        if (depsMatch) {
            const entityName = depsMatch[1];
            return `
                MATCH (source:${nodeTable})-[r:${relationTable}]->(dependency:${nodeTable})
                WHERE source.name CONTAINS '${entityName}'
                AND r.relationType IN ['depends_on', 'imports_file', 'imports_module', 'uses_class']
                RETURN source, r, dependency
            `;
        }

        // Pattern: "what uses X"
        const usesMatch = lowerQuery.match(/what\s+uses\s+([a-zA-Z_./]\w*)/);
        if (usesMatch) {
            const entityName = usesMatch[1];
            return `
                MATCH (user:${nodeTable})-[r:${relationTable}]->(used:${nodeTable})
                WHERE used.name CONTAINS '${entityName}'
                AND r.relationType IN ['uses_class', 'calls_function', 'imports_file', 'imports_module']
                RETURN user, r, used
            `;
        }

        // Pattern: "path from X to Y"
        const pathMatch = lowerQuery.match(/path\s+from\s+([a-zA-Z_./]\w*)\s+to\s+([a-zA-Z_./]\w*)/);
        if (pathMatch) {
            const source = pathMatch[1];
            const target = pathMatch[2];
            return `
                MATCH path = (start:${nodeTable})-[r:${relationTable}*1..5]->(end:${nodeTable})
                WHERE start.name CONTAINS '${source}' AND end.name CONTAINS '${target}'
                RETURN path LIMIT 10
            `;
        }

        // Pattern: "related to X"
        const relatedMatch = lowerQuery.match(/related\s+to\s+([a-zA-Z_./]\w*)/);
        if (relatedMatch) {
            const entityName = relatedMatch[1];
            return `
                MATCH (center:${nodeTable})-[r:${relationTable}]-(related:${nodeTable})
                WHERE center.name CONTAINS '${entityName}'
                RETURN center, r, related LIMIT 20
            `;
        }

        // Fallback: search by name or observations
        const searchTerms = nlQuery.split(/\s+/).filter(term => term.length > 2);
        if (searchTerms.length > 0) {
            const searchConditions = searchTerms.map(term =>
                `n.name CONTAINS '${term}' OR list_contains(n.observations, '${term}')`
            ).join(' OR ');

            return `
                MATCH (n:${nodeTable})
                WHERE ${searchConditions}
                RETURN n LIMIT 30
            `;
        }

        // Ultimate fallback
        return `MATCH (n:${nodeTable}) RETURN n LIMIT 20`;
    }

    /**
     * Executes a Cypher query and returns structured results
     */
    async executeCypher(agentId: string, cypherQuery: string, params?: any): Promise<CypherQueryResult> {
        const startTime = Date.now();
        console.log(`[CypherQueryEngine] Executing query for agent ${agentId}:\n${cypherQuery}`);

        try {
            const rawResults = await this.kuzuStorage.cypherQuery(agentId, cypherQuery, params);
            const executionTime = Date.now() - startTime;

            const nodes: any[] = [];
            const relations: any[] = [];
            const nodeIds = new Set<string>();
            const relationIds = new Set<string>();

            // Process results and extract nodes and relations
            for (const row of rawResults) {
                for (const [key, value] of Object.entries(row)) {
                    const typedValue = value as any;
                    if (this.isNodeResult(typedValue)) {
                        if (!nodeIds.has(typedValue.id)) {
                            nodes.push({
                                node_id: typedValue.id,
                                name: typedValue.name,
                                entityType: typedValue.entityType,
                                observations: typedValue.observations || []
                            });
                            nodeIds.add(typedValue.id);
                        }
                    } else if (this.isRelationResult(typedValue)) {
                        if (!relationIds.has(typedValue.id)) {
                            relations.push({
                                relation_id: typedValue.id,
                                fromNodeId: typedValue.fromNodeId,
                                toNodeId: typedValue.toNodeId,
                                relationType: typedValue.relationType
                            });
                            relationIds.add(typedValue.id);
                        }
                    } else if (this.isPathResult(typedValue)) {
                        // Extract nodes and relations from path
                        const pathNodes = this.extractNodesFromPath(typedValue);
                        const pathRelations = this.extractRelationsFromPath(typedValue);

                        pathNodes.forEach(node => {
                            if (!nodeIds.has(node.node_id)) {
                                nodes.push(node);
                                nodeIds.add(node.node_id);
                            }
                        });

                        pathRelations.forEach(rel => {
                            if (!relationIds.has(rel.relation_id)) {
                                relations.push(rel);
                                relationIds.add(rel.relation_id);
                            }
                        });
                    }
                }
            }

            console.log(`[CypherQueryEngine] Query completed in ${executionTime}ms. Found ${nodes.length} nodes, ${relations.length} relations`);

            return {
                nodes,
                relations,
                metadata: {
                    executionTime,
                    totalResults: rawResults.length,
                    query: cypherQuery
                }
            };
        } catch (error: any) {
            console.error('[CypherQueryEngine] Query execution failed:', error);
            return {
                nodes: [],
                relations: [],
                metadata: {
                    executionTime: Date.now() - startTime,
                    totalResults: 0,
                    query: cypherQuery
                }
            };
        }
    }

    /**
     * Finds all paths between two nodes
     */
    async findPaths(agentId: string, fromNodeName: string, toNodeName: string, maxDepth: number = 5): Promise<CypherQueryResult> {
        const nodeTable = this.getNodeTableName(agentId);
        const relationTable = this.getRelationTableName(agentId);

        const cypherQuery = `
            MATCH path = (start:${nodeTable})-[r:${relationTable}*1..${maxDepth}]->(end:${nodeTable})
            WHERE start.name = $fromName AND end.name = $toName
            RETURN path
            ORDER BY length(path)
            LIMIT 10
        `;

        return this.executeCypher(agentId, cypherQuery, {
            fromName: fromNodeName,
            toName: toNodeName
        });
    }

    /**
     * Finds nodes with specific relationship patterns
     */
    async findNodesWithPattern(
        agentId: string,
        sourcePattern: { entityType?: string; nameContains?: string },
        relationTypes: string[],
        targetPattern: { entityType?: string; nameContains?: string },
        direction: 'outgoing' | 'incoming' | 'both' = 'outgoing'
    ): Promise<CypherQueryResult> {
        const nodeTable = this.getNodeTableName(agentId);
        const relationTable = this.getRelationTableName(agentId);

        let matchClause = '';
        let whereConditions: string[] = [];
        const params: any = {};

        // Build match clause based on direction
        if (direction === 'outgoing') {
            matchClause = `MATCH (source:${nodeTable})-[r:${relationTable}]->(target:${nodeTable})`;
        } else if (direction === 'incoming') {
            matchClause = `MATCH (source:${nodeTable})<-[r:${relationTable}]-(target:${nodeTable})`;
        } else {
            matchClause = `MATCH (source:${nodeTable})-[r:${relationTable}]-(target:${nodeTable})`;
        }

        // Build WHERE conditions
        if (sourcePattern.entityType) {
            whereConditions.push('source.entityType = $sourceEntityType');
            params.sourceEntityType = sourcePattern.entityType;
        }

        if (sourcePattern.nameContains) {
            whereConditions.push('source.name CONTAINS $sourceNameContains');
            params.sourceNameContains = sourcePattern.nameContains;
        }

        if (targetPattern.entityType) {
            whereConditions.push('target.entityType = $targetEntityType');
            params.targetEntityType = targetPattern.entityType;
        }

        if (targetPattern.nameContains) {
            whereConditions.push('target.name CONTAINS $targetNameContains');
            params.targetNameContains = targetPattern.nameContains;
        }

        if (relationTypes.length > 0) {
            whereConditions.push('r.relationType IN $relationTypes');
            params.relationTypes = relationTypes;
        }

        const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
        const cypherQuery = `${matchClause} ${whereClause} RETURN source, r, target LIMIT 100`;

        return this.executeCypher(agentId, cypherQuery, params);
    }

    /**
     * Finds the neighborhood around a specific node
     */
    async findNeighborhood(agentId: string, centerNodeName: string, depth: number = 2): Promise<CypherQueryResult> {
        const nodeTable = this.getNodeTableName(agentId);
        const relationTable = this.getRelationTableName(agentId);

        const cypherQuery = `
            MATCH (center:${nodeTable} {name: $centerName})
            OPTIONAL MATCH (center)-[r:${relationTable}*1..${depth}]-(neighbor:${nodeTable})
            RETURN center, r, neighbor
            LIMIT 200
        `;

        return this.executeCypher(agentId, cypherQuery, { centerName: centerNodeName });
    }

    /**
     * Analyzes the graph structure
     */
    async analyzeGraphStructure(agentId: string): Promise<any> {
        const nodeTable = this.getNodeTableName(agentId);
        const relationTable = this.getRelationTableName(agentId);

        const queries = {
            nodeCount: `MATCH (n:${nodeTable}) RETURN count(n) as count`,
            relationCount: `MATCH ()-[r:${relationTable}]->() RETURN count(r) as count`,
            entityTypes: `MATCH (n:${nodeTable}) RETURN n.entityType as entityType, count(n) as count ORDER BY count DESC`,
            relationTypes: `MATCH ()-[r:${relationTable}]->() RETURN r.relationType as relationType, count(r) as count ORDER BY count DESC`,
            mostConnectedNodes: `
                MATCH (n:${nodeTable})-[r:${relationTable}]-()
                RETURN n.name as name, n.entityType as entityType, count(r) as connections
                ORDER BY connections DESC
                LIMIT 10
            `,
            isolatedNodes: `
                MATCH (n:${nodeTable})
                WHERE NOT (n)-[:${relationTable}]-()
                RETURN n.name as name, n.entityType as entityType
                LIMIT 10
            `
        };

        const results: any = {};

        for (const [key, query] of Object.entries(queries)) {
            try {
                const result = await this.kuzuStorage.cypherQuery(agentId, query);
                results[key] = result;
            } catch (error) {
                console.error(`[CypherQueryEngine] Error executing ${key} query:`, error);
                results[key] = [];
            }
        }

        return results;
    }

    /**
     * Executes a custom Cypher query with safety checks
     */
    async executeCustomQuery(agentId: string, cypherQuery: string, params?: any): Promise<CypherQueryResult> {
        // Basic safety checks
        const lowerQuery = cypherQuery.toLowerCase();

        // Prevent destructive operations
        if (lowerQuery.includes('delete') || lowerQuery.includes('drop') || lowerQuery.includes('create')) {
            throw new Error('Destructive operations are not allowed in custom queries');
        }

        // Ensure query is limited to prevent overwhelming results
        if (!lowerQuery.includes('limit')) {
            cypherQuery += ' LIMIT 100';
        }

        return this.executeCypher(agentId, cypherQuery, params);
    }

    private getNodeTableName(agentId: string): string {
        return `Agent_${agentId.replace(/[^a-zA-Z0-9_]/g, '_')}_Node`;
    }

    private getRelationTableName(agentId: string): string {
        return `Agent_${agentId.replace(/[^a-zA-Z0-9_]/g, '_')}_Relation`;
    }

    private isNodeResult(value: any): boolean {
        return value &&
               typeof value === 'object' &&
               'id' in value &&
               'name' in value &&
               'entityType' in value;
    }

    private isRelationResult(value: any): boolean {
        return value &&
               typeof value === 'object' &&
               'id' in value &&
               'relationType' in value &&
               ('fromNodeId' in value || 'toNodeId' in value);
    }

    private isPathResult(value: any): boolean {
        return value &&
               typeof value === 'object' &&
               ('nodes' in value || 'relationships' in value);
    }

    private extractNodesFromPath(path: any): any[] {
        const nodes: any[] = [];

        if (path.nodes && Array.isArray(path.nodes)) {
            path.nodes.forEach((node: any) => {
                if (this.isNodeResult(node)) {
                    nodes.push({
                        node_id: node.id,
                        name: node.name,
                        entityType: node.entityType,
                        observations: node.observations || []
                    });
                }
            });
        }

        return nodes;
    }

    private extractRelationsFromPath(path: any): any[] {
        const relations: any[] = [];

        if (path.relationships && Array.isArray(path.relationships)) {
            path.relationships.forEach((rel: any) => {
                if (this.isRelationResult(rel)) {
                    relations.push({
                        relation_id: rel.id,
                        fromNodeId: rel.fromNodeId,
                        toNodeId: rel.toNodeId,
                        relationType: rel.relationType
                    });
                }
            });
        }

        return relations;
    }
}