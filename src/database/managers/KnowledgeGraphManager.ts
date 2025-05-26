import { randomUUID } from 'crypto';
import { DatabaseService } from '../services/DatabaseService.js';
// fs, fsp, and path are not used in this manager based on current code, can be removed if not planned for future use.
// import fs from 'fs';
// import fsp from 'fs/promises';
// import path from 'path';

// const KNOWLEDGE_GRAPH_FILE_PATH = path.join(process.cwd(), 'knowledge_graph.jsonl'); // Not used

interface KnowledgeGraph { // This interface is not used locally in this manager after removing load/save
    entities: any[];
    relations: any[];
}

export class KnowledgeGraphManager {
    private dbService: DatabaseService;

    constructor(dbService: DatabaseService) {
        this.dbService = dbService;
    }

    // private async loadKnowledgeGraph(): Promise<KnowledgeGraph> { // Not used
    //     // ... (original code)
    // }

    // private async saveKnowledgeGraph(graph: KnowledgeGraph) { // Not used
    //     // ... (original code)
    // }

    async createEntities(
        agent_id: string,
        entities: Array<{ name: string; entityType: string; observations: string[] }>
    ) {
        const db = this.dbService.getDb();
        const results = [];
        let stmt; // Define stmt outside try to be available in finally

        try {
            await db.run('BEGIN TRANSACTION');
            stmt = await db.prepare(
                `INSERT INTO knowledge_graph_nodes (node_id, agent_id, name, entity_type, observations, timestamp)
                 VALUES (?, ?, ?, ?, ?, ?)`
            );
            for (const entity of entities) {
                const node_id = randomUUID();
                const timestamp = Date.now();
                const observations_json = JSON.stringify(entity.observations);
                await stmt.run(node_id, agent_id, entity.name, entity.entityType, observations_json, timestamp);
                results.push({ node_id, name: entity.name, success: true }); // Add success flag
            }
            await db.run('COMMIT');
            return { message: `Created ${results.filter(r => r.success).length} entities successfully.`, details: results };
        } catch (error) {
            await db.run('ROLLBACK');
            console.error('Error creating entities, transaction rolled back:', error);
            // For now, we report a general failure for the batch.
            throw new Error(`Failed to create entities batch due to: ${(error as Error).message}. Transaction rolled back.`);
        } finally {
            if (stmt) {
                await stmt.finalize();
            }
        }
    }

    async createRelations(
        agent_id: string,
        relations: Array<{ from: string; to: string; relationType: string }>
    ) {
        const db = this.dbService.getDb();
        const results = [];
        let stmt; // Define stmt outside try to be available in finally

        try {
            await db.run('BEGIN TRANSACTION');
            stmt = await db.prepare(
                `INSERT INTO knowledge_graph_relations (relation_id, agent_id, from_node_id, to_node_id, relation_type, timestamp)
                 VALUES (?, ?, ?, ?, ?, ?)`
            );

            for (const relation of relations) {
                const relation_id = randomUUID();
                const timestamp = Date.now();

                // Get node_ids for 'from' and 'to' entities
                // These lookups should ideally happen before the loop or be optimized if performance is critical for large batches.
                // For atomicity, if any node lookup fails, the transaction will ensure no relations are created.
                const fromNode = await db.get(`SELECT node_id FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, relation.from);
                const toNode = await db.get(`SELECT node_id FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, relation.to);

                if (!fromNode) {
                    // If a node is not found, we must throw an error to trigger rollback for the entire batch.
                    throw new Error(`Entity '${relation.from}' not found. Cannot create relation.`);
                }
                if (!toNode) {
                    // If a node is not found, we must throw an error to trigger rollback for the entire batch.
                    throw new Error(`Entity '${relation.to}' not found. Cannot create relation.`);
                }

                await stmt.run(relation_id, agent_id, fromNode.node_id, toNode.node_id, relation.relationType, timestamp);
                results.push({ success: true, relation_id, from: relation.from, to: relation.to, type: relation.relationType });
            }
            await db.run('COMMIT');
            return { message: `Created ${results.filter(r => r.success).length} relations successfully.`, details: results };
        } catch (error) {
            await db.run('ROLLBACK');
            console.error('Error creating relations, transaction rolled back:', error);
            // If an error occurs (e.g., entity not found), the entire batch is rolled back.
            throw new Error(`Failed to create relations batch due to: ${(error as Error).message}. Transaction rolled back.`);
        } finally {
            if (stmt) {
                await stmt.finalize();
            }
        }
    }

    async addObservations(
        agent_id: string,
        observations: Array<{ entityName: string; contents: string[] }>
    ) {
        const db = this.dbService.getDb();
        const results = [];
        // This operation updates existing records one by one.
        // If atomicity for the whole batch is required, a transaction wrapper would be needed here too.
        // For now, sticking to original behavior of per-item success/failure.
        for (const obs of observations) {
            const node = await db.get(`SELECT node_id, observations FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, obs.entityName);
            if (!node) {
                results.push({ success: false, message: `Entity '${obs.entityName}' not found.` });
                continue;
            }

            let existingObservations = [];
            try {
                existingObservations = JSON.parse(node.observations || '[]');
            } catch (e) {
                console.error(`Failed to parse existing observations for entity ${obs.entityName}:`, e);
                // Decide on behavior: skip, error out, or use empty array. Using empty for now.
            }
            
            existingObservations = [...existingObservations, ...obs.contents];

            try {
                await db.run(
                    `UPDATE knowledge_graph_nodes SET observations = ? WHERE node_id = ?`,
                    JSON.stringify(existingObservations), node.node_id
                );
                results.push({ success: true, entityName: obs.entityName, addedCount: obs.contents.length });
            } catch (updateError) {
                console.error(`Failed to update observations for entity ${obs.entityName}:`, updateError);
                results.push({ success: false, message: `Failed to update observations for entity '${obs.entityName}'.`, error: (updateError as Error).message });
            }
        }
        return { message: `Processed adding observations for ${observations.length} entities.`, details: results };
    }

    async deleteEntities(
        agent_id: string,
        entityNames: string[]
    ) {
        const db = this.dbService.getDb();
        const results = [];
        // This operation deletes entities one by one.
        // If atomicity for the whole batch is required, a transaction wrapper would be needed.
        // Note: Foreign key constraints should handle deleting associated relations if schema is set up with ON DELETE CASCADE.
        for (const name of entityNames) {
            const node = await db.get(`SELECT node_id FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, name);
            if (!node) {
                results.push({ success: false, message: `Entity '${name}' not found.` });
                continue;
            }
            
            try {
                 // Assuming ON DELETE CASCADE for knowledge_graph_relations is set in schema.sql
                const deleteResult = await db.run(`DELETE FROM knowledge_graph_nodes WHERE node_id = ? AND agent_id = ?`, node.node_id, agent_id);
                results.push({ success: (deleteResult?.changes || 0) > 0, entityName: name, deleted: (deleteResult?.changes || 0) > 0 });
            } catch (deleteError) {
                console.error(`Failed to delete entity ${name}:`, deleteError);
                results.push({ success: false, message: `Failed to delete entity '${name}'.`, error: (deleteError as Error).message });
            }
        }
        return { message: `Processed deleting ${entityNames.length} entities.`, details: results };
    }

    async deleteObservations(
        agent_id: string,
        deletions: Array<{ entityName: string; observations: string[] }>
    ) {
        const db = this.dbService.getDb();
        const results = [];
        for (const del of deletions) {
            const node = await db.get(`SELECT node_id, observations FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, del.entityName);
            if (!node) {
                results.push({ success: false, message: `Entity '${del.entityName}' not found.` });
                continue;
            }

            let existingObservations = [];
            try {
                existingObservations = JSON.parse(node.observations || '[]');
            } catch(e) {
                 console.error(`Failed to parse existing observations for entity ${del.entityName} during deletion:`, e);
                 results.push({ success: false, message: `Could not parse observations for entity '${del.entityName}'.`, error: (e as Error).message });
                 continue;
            }

            const initialCount = existingObservations.length;
            existingObservations = existingObservations.filter((obs: string) => !del.observations.includes(obs));
            const deletedCount = initialCount - existingObservations.length;

            try {
                await db.run(
                    `UPDATE knowledge_graph_nodes SET observations = ? WHERE node_id = ?`,
                    JSON.stringify(existingObservations), node.node_id
                );
                results.push({ success: true, entityName: del.entityName, deletedCount: deletedCount });
            } catch (updateError) {
                 console.error(`Failed to update (delete) observations for entity ${del.entityName}:`, updateError);
                results.push({ success: false, message: `Failed to update observations for entity '${del.entityName}'.`, error: (updateError as Error).message });
            }
        }
        return { message: `Processed deleting observations for ${deletions.length} entities.`, details: results };
    }

    async deleteRelations(
        agent_id: string,
        relations: Array<{ from: string; to: string; relationType: string }>
    ) {
        const db = this.dbService.getDb();
        const results = [];
        // This operation deletes relations one by one.
        // If atomicity for the whole batch is required, a transaction wrapper would be needed.
        for (const relation of relations) {
            const fromNode = await db.get(`SELECT node_id FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, relation.from);
            const toNode = await db.get(`SELECT node_id FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, relation.to);

            if (!fromNode || !toNode) {
                results.push({ success: false, message: `One or both entities for relation (FROM: ${relation.from}, TO: ${relation.to}, TYPE: ${relation.relationType}) not found.` });
                continue;
            }
            
            try {
                const deleteResult = await db.run(
                    `DELETE FROM knowledge_graph_relations WHERE agent_id = ? AND from_node_id = ? AND to_node_id = ? AND relation_type = ?`,
                    agent_id, fromNode.node_id, toNode.node_id, relation.relationType
                );
                results.push({ success: (deleteResult?.changes || 0) > 0, from: relation.from, to: relation.to, type: relation.relationType, deleted: (deleteResult?.changes || 0) > 0 });
            } catch (deleteError) {
                 console.error(`Failed to delete relation (FROM: ${relation.from}, TO: ${relation.to}, TYPE: ${relation.relationType}):`, deleteError);
                results.push({ success: false, message: `Failed to delete relation (FROM: ${relation.from}, TO: ${relation.to}, TYPE: ${relation.relationType}).`, error: (deleteError as Error).message });
            }
        }
        return { message: `Processed deleting ${relations.length} relations.`, details: results };
    }

    async readGraph(agent_id: string) {
        const db = this.dbService.getDb();
        const nodes = await db.all(`SELECT node_id, name, entity_type, observations FROM knowledge_graph_nodes WHERE agent_id = ?`, agent_id);
        const relations = await db.all(`SELECT r.relation_id, r.relation_type, n1.name AS from_name, n2.name AS to_name FROM knowledge_graph_relations r JOIN knowledge_graph_nodes n1 ON r.from_node_id = n1.node_id JOIN knowledge_graph_nodes n2 ON r.to_node_id = n2.node_id WHERE r.agent_id = ?`, agent_id);

        return {
            nodes: nodes.map((node: any) => {
                let observations = [];
                try {
                    observations = JSON.parse(node.observations || '[]');
                } catch (e) {
                    console.error(`Failed to parse observations for node ${node.node_id} during readGraph:`, e);
                }
                return {
                    node_id: node.node_id,
                    name: node.name,
                    entityType: node.entity_type,
                    observations: observations
                };
            }),
            relations: relations.map((rel: any) => ({
                relation_id: rel.relation_id,
                from: rel.from_name,
                to: rel.to_name,
                relationType: rel.relation_type
            }))
        };
    }

    async searchNodes(agent_id: string, query: string) {
        const db = this.dbService.getDb();
        const searchQuery = `%${query.toLowerCase()}%`;
        const nodes = await db.all(
            `SELECT node_id, name, entity_type, observations FROM knowledge_graph_nodes
             WHERE agent_id = ? AND (LOWER(name) LIKE ? OR LOWER(entity_type) LIKE ? OR LOWER(observations) LIKE ?)`,
            agent_id, searchQuery, searchQuery, searchQuery
        );
        return nodes.map((node: any) => {
            let observations = [];
            try {
                observations = JSON.parse(node.observations || '[]');
            } catch (e) {
                console.error(`Failed to parse observations for node ${node.node_id} during searchNodes:`, e);
            }
            return {
                node_id: node.node_id,
                name: node.name,
                entityType: node.entity_type,
                observations: observations
            };
        });
    }

    async openNodes(agent_id: string, names: string[]) {
        const db = this.dbService.getDb();
        if (!names || names.length === 0) {
            return []; // Return empty if no names provided
        }
        const placeholders = names.map(() => '?').join(',');
        const nodes = await db.all(
            `SELECT node_id, name, entity_type, observations FROM knowledge_graph_nodes
             WHERE agent_id = ? AND name IN (${placeholders})`,
            agent_id, ...names
        );
        return nodes.map((node: any) => {
            let observations = [];
            try {
                observations = JSON.parse(node.observations || '[]');
            } catch (e) {
                console.error(`Failed to parse observations for node ${node.node_id} during openNodes:`, e);
            }
            return {
                node_id: node.node_id,
                name: node.name,
                entityType: node.entity_type,
                observations: observations
            };
        });
    }
}
