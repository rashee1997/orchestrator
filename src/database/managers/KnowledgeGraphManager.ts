import { randomUUID } from 'crypto';
import { DatabaseService } from '../services/DatabaseService.js';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

const KNOWLEDGE_GRAPH_FILE_PATH = path.join(process.cwd(), 'knowledge_graph.jsonl');

interface KnowledgeGraph {
    entities: any[];
    relations: any[];
}

export class KnowledgeGraphManager {
    private dbService: DatabaseService;

    constructor(dbService: DatabaseService) {
        this.dbService = dbService;
    }

    private async loadKnowledgeGraph(): Promise<KnowledgeGraph> {
        try {
            const data = await fs.promises.readFile(KNOWLEDGE_GRAPH_FILE_PATH, 'utf-8');
            const lines = data.split('\n').filter((line: string) => line.trim() !== '');
            return lines.reduce((graph: KnowledgeGraph, line: string) => {
                const item = JSON.parse(line);
                if (item.type === 'entity') {
                    graph.entities.push(item.data);
                } else if (item.type === 'relation') {
                    graph.relations.push(item.data);
                }
                return graph;
            }, { entities: [], relations: [] });
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                return { entities: [], relations: [] };
            }
            throw error;
        }
    }

    private async saveKnowledgeGraph(graph: KnowledgeGraph) {
        const lines = [
            ...graph.entities.map(e => JSON.stringify({ type: 'entity', data: e })),
            ...graph.relations.map(r => JSON.stringify({ type: 'relation', data: r })),
        ];
        await fsp.writeFile(KNOWLEDGE_GRAPH_FILE_PATH, lines.join('\n'));
    }

    async createEntities(
        agent_id: string,
        entities: Array<{ name: string; entityType: string; observations: string[] }>
    ) {
        const db = this.dbService.getDb();
        const stmt = await db.prepare(
            `INSERT INTO knowledge_graph_nodes (node_id, agent_id, name, entity_type, observations, timestamp)
             VALUES (?, ?, ?, ?, ?, ?)`
        );
        const results = [];
        for (const entity of entities) {
            const node_id = randomUUID();
            const timestamp = Date.now();
            const observations_json = JSON.stringify(entity.observations);
            await stmt.run(node_id, agent_id, entity.name, entity.entityType, observations_json, timestamp);
            results.push({ node_id, name: entity.name });
        }
        await stmt.finalize();
        return { message: `Created ${results.length} entities.`, details: results };
    }

    async createRelations(
        agent_id: string,
        relations: Array<{ from: string; to: string; relationType: string }>
    ) {
        const db = this.dbService.getDb();
        const stmt = await db.prepare(
            `INSERT INTO knowledge_graph_relations (relation_id, agent_id, from_node_id, to_node_id, relation_type, timestamp)
             VALUES (?, ?, ?, ?, ?, ?)`
        );
        const results = [];
        for (const relation of relations) {
            const relation_id = randomUUID();
            const timestamp = Date.now();

            // Get node_ids for 'from' and 'to' entities
            const fromNode = await db.get(`SELECT node_id FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, relation.from);
            const toNode = await db.get(`SELECT node_id FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, relation.to);

            if (!fromNode) {
                results.push({ success: false, message: `Entity '${relation.from}' not found.` });
                continue;
            }
            if (!toNode) {
                results.push({ success: false, message: `Entity '${relation.to}' not found.` });
                continue;
            }

            await stmt.run(relation_id, agent_id, fromNode.node_id, toNode.node_id, relation.relationType, timestamp);
            results.push({ success: true, relation_id, from: relation.from, to: relation.to, type: relation.relationType });
        }
        await stmt.finalize();
        return { message: `Created ${results.filter(r => r.success).length} relations.`, details: results };
    }

    async addObservations(
        agent_id: string,
        observations: Array<{ entityName: string; contents: string[] }>
    ) {
        const db = this.dbService.getDb();
        const results = [];
        for (const obs of observations) {
            const node = await db.get(`SELECT node_id, observations FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, obs.entityName);
            if (!node) {
                results.push({ success: false, message: `Entity '${obs.entityName}' not found.` });
                continue;
            }

            let existingObservations = JSON.parse(node.observations || '[]');
            existingObservations = [...existingObservations, ...obs.contents];

            await db.run(
                `UPDATE knowledge_graph_nodes SET observations = ? WHERE node_id = ?`,
                JSON.stringify(existingObservations), node.node_id
            );
            results.push({ success: true, entityName: obs.entityName, addedCount: obs.contents.length });
        }
        return { message: `Added observations to ${results.filter(r => r.success).length} entities.`, details: results };
    }

    async deleteEntities(
        agent_id: string,
        entityNames: string[]
    ) {
        const db = this.dbService.getDb();
        const results = [];
        for (const name of entityNames) {
            const node = await db.get(`SELECT node_id FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, name);
            if (!node) {
                results.push({ success: false, message: `Entity '${name}' not found.` });
                continue;
            }

            // Delete associated relations first
            await db.run(`DELETE FROM knowledge_graph_relations WHERE agent_id = ? AND (from_node_id = ? OR to_node_id = ?)`, agent_id, node.node_id, node.node_id);
            // Delete the node
            const deleteResult = await db.run(`DELETE FROM knowledge_graph_nodes WHERE node_id = ?`, node.node_id);
            results.push({ success: (deleteResult?.changes || 0) > 0, entityName: name, deleted: (deleteResult?.changes || 0) > 0 });
        }
        return { message: `Deleted ${results.filter(r => r.deleted).length} entities.`, details: results };
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

            let existingObservations = JSON.parse(node.observations || '[]');
            const initialCount = existingObservations.length;
            existingObservations = existingObservations.filter((obs: string) => !del.observations.includes(obs));
            const deletedCount = initialCount - existingObservations.length;

            await db.run(
                `UPDATE knowledge_graph_nodes SET observations = ? WHERE node_id = ?`,
                JSON.stringify(existingObservations), node.node_id
            );
            results.push({ success: true, entityName: del.entityName, deletedCount: deletedCount });
        }
        return { message: `Deleted observations from ${results.filter(r => r.success).length} entities.`, details: results };
    }

    async deleteRelations(
        agent_id: string,
        relations: Array<{ from: string; to: string; relationType: string }>
    ) {
        const db = this.dbService.getDb();
        const results = [];
        for (const relation of relations) {
            const fromNode = await db.get(`SELECT node_id FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, relation.from);
            const toNode = await db.get(`SELECT node_id FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, relation.to);

            if (!fromNode || !toNode) {
                results.push({ success: false, message: `One or both entities for relation (${relation.from}, ${relation.to}) not found.` });
                continue;
            }

            const deleteResult = await db.run(
                `DELETE FROM knowledge_graph_relations WHERE agent_id = ? AND from_node_id = ? AND to_node_id = ? AND relation_type = ?`,
                agent_id, fromNode.node_id, toNode.node_id, relation.relationType
            );
            results.push({ success: (deleteResult?.changes || 0) > 0, from: relation.from, to: relation.to, type: relation.relationType, deleted: (deleteResult?.changes || 0) > 0 });
        }
        return { message: `Deleted ${results.filter(r => r.deleted).length} relations.`, details: results };
    }

    async readGraph(agent_id: string) {
        const db = this.dbService.getDb();
        const nodes = await db.all(`SELECT node_id, name, entity_type, observations FROM knowledge_graph_nodes WHERE agent_id = ?`, agent_id);
        const relations = await db.all(`SELECT r.relation_id, r.relation_type, n1.name AS from_name, n2.name AS to_name FROM knowledge_graph_relations r JOIN knowledge_graph_nodes n1 ON r.from_node_id = n1.node_id JOIN knowledge_graph_nodes n2 ON r.to_node_id = n2.node_id WHERE r.agent_id = ?`, agent_id);

        return {
            nodes: nodes.map((node: any) => ({
                node_id: node.node_id,
                name: node.name,
                entityType: node.entity_type,
                observations: JSON.parse(node.observations || '[]')
            })),
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
        return nodes.map((node: any) => ({
            node_id: node.node_id,
            name: node.name,
            entityType: node.entity_type,
            observations: JSON.parse(node.observations || '[]')
        }));
    }

    async openNodes(agent_id: string, names: string[]) {
        const db = this.dbService.getDb();
        const placeholders = names.map(() => '?').join(',');
        const nodes = await db.all(
            `SELECT node_id, name, entity_type, observations FROM knowledge_graph_nodes
             WHERE agent_id = ? AND name IN (${placeholders})`,
            agent_id, ...names
        );
        return nodes.map((node: any) => ({
            node_id: node.node_id,
            name: node.name,
            entityType: node.entity_type,
            observations: JSON.parse(node.observations || '[]')
        }));
    }
}
