import { Database, Connection } from 'kuzu';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

export interface KuzuNode {
    id: string;
    agentId: string;
    name: string;
    entityType: string;
    observations: string[];
    timestamp: number;
    version: number;
}

export interface KuzuRelation {
    id: string;
    fromNodeId: string;
    toNodeId: string;
    relationType: string;
    timestamp: number;
    version: number;
}

export class KuzuStorageManager {
    private dbPath: string;
    private agentDatabases = new Map<string, { db: Database; conn: Connection }>();

    private escapeString(value: string): string {
        return value
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/\r/g, '\\r')
            .replace(/\n/g, '\\n');
    }

    private formatObservations(observations: string[]): string {
        if (!observations || observations.length === 0) {
            return '';
        }
        return observations
            .map(obs => `'${this.escapeString(obs)}'`)
            .join(', ');
    }

    constructor(rootPath?: string) {
        if (!rootPath) {
            const __filename = fileURLToPath(import.meta.url);
            const __dirname = path.dirname(__filename);
            const projectRoot = path.resolve(__dirname, '..', '..', '..');
            this.dbPath = path.join(projectRoot, 'knowledge_graphs_kuzu');
        } else {
            this.dbPath = rootPath;
        }

        console.log(`[KuzuStorageManager] Initialized. Root database path: ${this.dbPath}`);
    }

    private async ensureAgentDatabase(agentId: string): Promise<{ db: Database; conn: Connection }> {
        if (this.agentDatabases.has(agentId)) {
            return this.agentDatabases.get(agentId)!;
        }

        // Create agent-specific database directory and file path
        const agentDbDir = path.join(this.dbPath, agentId);
        const agentDbFile = path.join(agentDbDir, `${agentId}.kuzu`);

        try {
            await fs.mkdir(agentDbDir, { recursive: true });
        } catch (error) {
            // Directory might already exist, ignore error
        }

        // Create separate KuzuDB database for this agent
        const db = new Database(agentDbFile);
        const conn = new Connection(db);

        this.agentDatabases.set(agentId, { db, conn });
        console.log(`[KuzuStorageManager] Created database for agent: ${agentId} at ${agentDbFile}`);

        return { db, conn };
    }

    private getNodeTableName(): string {
        return 'KGNode';
    }

    private getRelationTableName(): string {
        return 'KGRelation';
    }

    async initializeSchema(agentId: string): Promise<void> {
        const { conn } = await this.ensureAgentDatabase(agentId);

        const nodeTable = this.getNodeTableName();
        const relationTable = this.getRelationTableName();

        try {
            // Create node table
            await conn.query(`
                CREATE NODE TABLE IF NOT EXISTS ${nodeTable}(
                    id STRING,
                    agentId STRING,
                    name STRING,
                    entityType STRING,
                    observations STRING[],
                    timestamp INT64,
                    version INT64,
                    PRIMARY KEY(id)
                )
            `);

            // Create relation table
            await conn.query(`
                CREATE REL TABLE IF NOT EXISTS ${relationTable}(
                    FROM ${nodeTable} TO ${nodeTable},
                    id STRING,
                    relationType STRING,
                    timestamp INT64,
                    version INT64
                )
            `);

            console.log(`[KuzuStorageManager] Schema initialized for agent: ${agentId}`);
        } catch (error) {
            console.error(`[KuzuStorageManager] Error initializing schema for agent ${agentId}:`, error);
            throw error;
        }
    }

    async insertNodes(agentId: string, nodes: KuzuNode[]): Promise<void> {
        await this.initializeSchema(agentId);
        const { conn } = await this.ensureAgentDatabase(agentId);
        const nodeTable = this.getNodeTableName();

        try {
            for (const node of nodes) {
                const escapedId = this.escapeString(node.id);
                const escapedAgentId = this.escapeString(node.agentId);
                const escapedName = this.escapeString(node.name);
                const escapedEntityType = this.escapeString(node.entityType);
                const escapedObservations = this.formatObservations(node.observations);

                await conn.query(`
                    MATCH (existing:${nodeTable} {id: '${escapedId}'})
                    DETACH DELETE existing
                `);

                await conn.query(`
                    CREATE (:${nodeTable} {
                        id: '${escapedId}',
                        agentId: '${escapedAgentId}',
                        name: '${escapedName}',
                        entityType: '${escapedEntityType}',
                        observations: [${escapedObservations}],
                        timestamp: ${node.timestamp},
                        version: ${node.version}
                    })
                `);
            }
            console.log(`[KuzuStorageManager] Inserted ${nodes.length} nodes for agent ${agentId}`);
        } catch (error) {
            console.error(`[KuzuStorageManager] Error inserting nodes:`, error);
            throw error;
        }
    }

    async insertRelations(agentId: string, relations: KuzuRelation[]): Promise<void> {
        await this.initializeSchema(agentId);
        const { conn } = await this.ensureAgentDatabase(agentId);
        const nodeTable = this.getNodeTableName();
        const relationTable = this.getRelationTableName();

        try {
            for (const relation of relations) {
                const escapedRelationId = this.escapeString(relation.id);
                const escapedFromId = this.escapeString(relation.fromNodeId);
                const escapedToId = this.escapeString(relation.toNodeId);
                const escapedRelationType = this.escapeString(relation.relationType);

                await conn.query(`
                    MATCH ()-[existing:${relationTable} {id: '${escapedRelationId}'}]->()
                    DELETE existing
                `);

                await conn.query(`
                    MATCH (from:${nodeTable} {id: '${escapedFromId}'}), (to:${nodeTable} {id: '${escapedToId}'})
                    CREATE (from)-[:${relationTable} {
                        id: '${escapedRelationId}',
                        relationType: '${escapedRelationType}',
                        timestamp: ${relation.timestamp},
                        version: ${relation.version}
                    }]->(to)
                `);
            }
            console.log(`[KuzuStorageManager] Inserted ${relations.length} relations for agent ${agentId}`);
        } catch (error) {
            console.error(`[KuzuStorageManager] Error inserting relations:`, error);
            throw error;
        }
    }

    async getNodeById(agentId: string, nodeId: string): Promise<KuzuNode | null> {
        await this.initializeSchema(agentId);
        const { conn } = await this.ensureAgentDatabase(agentId);
        const nodeTable = this.getNodeTableName();

        try {
            const escapedNodeId = this.escapeString(nodeId);
            const result = await conn.query(`
                MATCH (n:${nodeTable} {id: '${escapedNodeId}'})
                RETURN n
            `);

            const rows = Array.isArray(result) ? result : await (result as any).getAll();
            if (rows.length === 0) {
                return null;
            }

            const node = rows[0].n;
            return {
                id: node.id,
                agentId: node.agentId,
                name: node.name,
                entityType: node.entityType,
                observations: node.observations,
                timestamp: node.timestamp,
                version: node.version
            };
        } catch (error) {
            console.error(`[KuzuStorageManager] Error getting node by id:`, error);
            return null;
        }
    }

    async getNodesByName(agentId: string, names: string[]): Promise<KuzuNode[]> {
        if (names.length === 0) return [];

        await this.initializeSchema(agentId);
        const { conn } = await this.ensureAgentDatabase(agentId);
        const nodeTable = this.getNodeTableName();

        try {
            const namesList = names.map(name => `'${this.escapeString(name)}'`).join(', ');
            const result = await conn.query(`
                MATCH (n:${nodeTable})
                WHERE n.name IN [${namesList}]
                RETURN n
            `);

            const rows = Array.isArray(result) ? result : await (result as any).getAll();
            return rows.map((row: any) => ({
                id: row.n.id,
                agentId: row.n.agentId,
                name: row.n.name,
                entityType: row.n.entityType,
                observations: row.n.observations,
                timestamp: row.n.timestamp,
                version: row.n.version
            }));
        } catch (error) {
            console.error(`[KuzuStorageManager] Error getting nodes by names:`, error);
            return [];
        }
    }

    async searchNodes(agentId: string, searchTerm: string, entityType?: string): Promise<KuzuNode[]> {
        await this.initializeSchema(agentId);
        const { conn } = await this.ensureAgentDatabase(agentId);
        const nodeTable = this.getNodeTableName();

        try {
            const escapedTerm = this.escapeString(searchTerm);
            let query = `
                MATCH (n:${nodeTable})
                WHERE (
                    n.name CONTAINS '${escapedTerm}'
                    OR ANY(obs IN n.observations WHERE obs CONTAINS '${escapedTerm}')
                )
            `;

            if (entityType) {
                query += ` AND n.entityType = '${this.escapeString(entityType)}'`;
            }

            query += ` RETURN n LIMIT 100`;

            const result = await conn.query(query);
            const rows = Array.isArray(result) ? result : await (result as any).getAll();

            return rows.map((row: any) => ({
                id: row.n.id,
                agentId: row.n.agentId,
                name: row.n.name,
                entityType: row.n.entityType,
                observations: row.n.observations,
                timestamp: row.n.timestamp,
                version: row.n.version
            }));
        } catch (error) {
            console.error(`[KuzuStorageManager] Error searching nodes:`, error);
            return [];
        }
    }

    async getAllNodes(agentId: string): Promise<KuzuNode[]> {
        await this.initializeSchema(agentId);
        const { conn } = await this.ensureAgentDatabase(agentId);
        const nodeTable = this.getNodeTableName();

        try {
            const result = await conn.query(`
                MATCH (n:${nodeTable})
                RETURN n
            `);

            const rows = Array.isArray(result) ? result : await (result as any).getAll();
            return rows.map((row: any) => ({
                id: row.n.id,
                agentId: row.n.agentId,
                name: row.n.name,
                entityType: row.n.entityType,
                observations: row.n.observations,
                timestamp: row.n.timestamp,
                version: row.n.version
            }));
        } catch (error) {
            console.error(`[KuzuStorageManager] Error getting all nodes:`, error);
            return [];
        }
    }

    async getAllRelations(agentId: string): Promise<any[]> {
        await this.initializeSchema(agentId);
        const { conn } = await this.ensureAgentDatabase(agentId);
        const nodeTable = this.getNodeTableName();
        const relationTable = this.getRelationTableName();

        try {
            const result = await conn.query(`
                MATCH (from:${nodeTable})-[r:${relationTable}]->(to:${nodeTable})
                RETURN r, from.id as fromNodeId, to.id as toNodeId
            `);

            const rows = Array.isArray(result) ? result : await (result as any).getAll();
            return rows.map((row: any) => ({
                id: row.r.id,
                fromNodeId: row.fromNodeId,
                toNodeId: row.toNodeId,
                relationType: row.r.relationType,
                timestamp: row.r.timestamp,
                version: row.r.version
            }));
        } catch (error) {
            console.error(`[KuzuStorageManager] Error getting all relations:`, error);
            return [];
        }
    }

    async traverseGraph(agentId: string, startNodeId: string, relationTypes: string[], depth: number): Promise<{ nodes: KuzuNode[], relations: any[] }> {
        await this.initializeSchema(agentId);
        const { conn } = await this.ensureAgentDatabase(agentId);
        const nodeTable = this.getNodeTableName();
        const relationTable = this.getRelationTableName();

        try {
            const escapedStartId = this.escapeString(startNodeId);

            const nodeResult = await conn.query(`
                MATCH path = (start:${nodeTable} {id: '${escapedStartId}'})-[r:${relationTable}*1..${depth}]->(connected:${nodeTable})
                UNWIND nodes(path) AS node
                RETURN DISTINCT node
            `);
            const nodeRows = Array.isArray(nodeResult) ? nodeResult : await (nodeResult as any).getAll();

            const nodeMap = new Map<string, KuzuNode>();
            for (const row of nodeRows) {
                if (row.node) {
                    nodeMap.set(row.node.id, {
                        id: row.node.id,
                        agentId: row.node.agentId,
                        name: row.node.name,
                        entityType: row.node.entityType,
                        observations: row.node.observations,
                        timestamp: row.node.timestamp,
                        version: row.node.version
                    });
                }
            }

            if (!nodeMap.has(startNodeId)) {
                const startResult = await conn.query(`
                    MATCH (n:${nodeTable} {id: '${escapedStartId}'})
                    RETURN n
                `);
                const startRows = Array.isArray(startResult) ? startResult : await (startResult as any).getAll();
                if (startRows.length > 0 && startRows[0].n) {
                    const n = startRows[0].n;
                    nodeMap.set(n.id, {
                        id: n.id,
                        agentId: n.agentId,
                        name: n.name,
                        entityType: n.entityType,
                        observations: n.observations,
                        timestamp: n.timestamp,
                        version: n.version
                    });
                }
            }

            const relationResult = await conn.query(`
                MATCH path = (start:${nodeTable} {id: '${escapedStartId}'})-[r:${relationTable}*1..${depth}]->(connected:${nodeTable})
                UNWIND relationships(path) AS relEdge
                WITH DISTINCT relEdge
                MATCH (from:${nodeTable})-[rel:${relationTable}]->(to:${nodeTable})
                WHERE rel.id = relEdge.id
                RETURN DISTINCT rel, from.id AS fromNodeId, to.id AS toNodeId
            `);
            const relationRows = Array.isArray(relationResult) ? relationResult : await (relationResult as any).getAll();

            const relationMap = new Map<string, any>();
            for (const row of relationRows) {
                if (row.rel) {
                    relationMap.set(row.rel.id, {
                        id: row.rel.id,
                        fromNodeId: row.fromNodeId,
                        toNodeId: row.toNodeId,
                        relationType: row.rel.relationType,
                        timestamp: row.rel.timestamp,
                        version: row.rel.version
                    });
                }
            }

            const allowedTypes = new Set(relationTypes);
            const relations = relationTypes.length > 0
                ? Array.from(relationMap.values()).filter(rel => allowedTypes.has(rel.relationType))
                : Array.from(relationMap.values());

            const allowedNodeIds = new Set<string>();
            allowedNodeIds.add(startNodeId);
            for (const rel of relations) {
                allowedNodeIds.add(rel.fromNodeId);
                allowedNodeIds.add(rel.toNodeId);
            }

            const nodes: KuzuNode[] = Array.from(allowedNodeIds)
                .map(id => nodeMap.get(id))
                .filter((node): node is KuzuNode => Boolean(node));

            return {
                nodes,
                relations
            };
        } catch (error) {
            console.error(`[KuzuStorageManager] Error traversing graph:`, error);
            return { nodes: [], relations: [] };
        }
    }

    async updateNode(agentId: string, nodeId: string, updates: Partial<KuzuNode>): Promise<boolean> {
        await this.initializeSchema(agentId);
        const { conn } = await this.ensureAgentDatabase(agentId);
        const nodeTable = this.getNodeTableName();

        try {
            const setParts: string[] = [];

            if (updates.name !== undefined) {
                setParts.push(`n.name = '${this.escapeString(updates.name)}'`);
            }
            if (updates.entityType !== undefined) {
                setParts.push(`n.entityType = '${this.escapeString(updates.entityType)}'`);
            }
            if (updates.observations !== undefined) {
                const obsArray = this.formatObservations(updates.observations);
                setParts.push(`n.observations = [${obsArray}]`);
            }
            if (updates.version !== undefined) {
                setParts.push(`n.version = ${updates.version}`);
            }

            if (setParts.length === 0) {
                return false;
            }

            setParts.push(`n.timestamp = ${Date.now()}`);

            const escapedNodeId = this.escapeString(nodeId);
            const result = await conn.query(`
                MATCH (n:${nodeTable} {id: '${escapedNodeId}'})
                SET ${setParts.join(', ')}
                RETURN n
            `);

            const rows = Array.isArray(result) ? result : await (result as any).getAll();
            return rows.length > 0;
        } catch (error) {
            console.error(`[KuzuStorageManager] Error updating node:`, error);
            return false;
        }
    }

    async deleteNode(agentId: string, nodeId: string): Promise<boolean> {
        await this.initializeSchema(agentId);
        const { conn } = await this.ensureAgentDatabase(agentId);
        const nodeTable = this.getNodeTableName();
        const relationTable = this.getRelationTableName();

        try {
            const escapedNodeId = this.escapeString(nodeId);
            // Delete all relations connected to this node first
            await conn.query(`
                MATCH (n:${nodeTable} {id: '${escapedNodeId}'})-[r:${relationTable}]->()
                DELETE r
            `);

            await conn.query(`
                MATCH ()-[r:${relationTable}]->(n:${nodeTable} {id: '${escapedNodeId}'})
                DELETE r
            `);

            // Delete the node
            const result = await conn.query(`
                MATCH (n:${nodeTable} {id: '${escapedNodeId}'})
                DELETE n
                RETURN count(*) as cnt
            `);

            const rows = Array.isArray(result) ? result : await (result as any).getAll();
            return rows.length > 0;
        } catch (error) {
            console.error(`[KuzuStorageManager] Error deleting node:`, error);
            return false;
        }
    }

    async deleteRelation(agentId: string, relationId: string): Promise<boolean> {
        await this.initializeSchema(agentId);
        const { conn } = await this.ensureAgentDatabase(agentId);
        const relationTable = this.getRelationTableName();

        try {
            const escapedRelationId = this.escapeString(relationId);
            const result = await conn.query(`
                MATCH ()-[r:${relationTable} {id: '${escapedRelationId}'}]->()
                DELETE r
                RETURN count(*) as cnt
            `);

            const rows = Array.isArray(result) ? result : await (result as any).getAll();
            return rows.length > 0;
        } catch (error) {
            console.error(`[KuzuStorageManager] Error deleting relation:`, error);
            return false;
        }
    }

    async cypherQuery(agentId: string, query: string, params?: any): Promise<any[]> {
        try {
            const { conn } = await this.ensureAgentDatabase(agentId);
            const result = await conn.query(query, params);
            return Array.isArray(result) ? result : await (result as any).getAll();
        } catch (error) {
            console.error(`[KuzuStorageManager] Error executing cypher query:`, error);
            throw error;
        }
    }

    async close(): Promise<void> {
        try {
            // Note: KuzuDB connections are typically closed automatically
            // when the database instance is garbage collected
            console.log('[KuzuStorageManager] Closing database connection');
        } catch (error) {
            console.error('[KuzuStorageManager] Error closing database:', error);
        }
    }
}
