import path from 'path';
import fsp from 'fs/promises';
import { fileURLToPath } from 'url';
import { DatabaseService } from '../../database/services/DatabaseService.js';
import { JsonlStorageManager } from '../../database/storage/JsonlStorageManager.js';

export class KnowledgeGraphMigrator {
    private dbService: DatabaseService;
    private jsonlStorage: JsonlStorageManager;

    constructor(dbService: DatabaseService, jsonlRoot?: string) {
        this.dbService = dbService;
        // If no jsonlRoot provided, calculate it relative to the project root
        if (!jsonlRoot) {
            const __filename = fileURLToPath(import.meta.url);
            const __dirname = path.dirname(__filename);
            const projectRoot = path.resolve(__dirname, '..', '..', '..');
            jsonlRoot = path.join(projectRoot, 'knowledge_graphs');
        }
        this.jsonlStorage = new JsonlStorageManager(jsonlRoot);
    }

    // Export all nodes and relations from SQLite to JSONL for a given agent
    async exportFromSQLite(agentId: string): Promise<void> {
        const db = this.dbService.getDb();
        // Export nodes
        const nodes = await db.all('SELECT node_id as id, agent_id, name, entity_type as entityType, observations, timestamp FROM knowledge_graph_nodes WHERE agent_id = ?', agentId);
        for (const node of nodes) {
            try {
                node.observations = JSON.parse(node.observations || '[]');
            } catch {
                node.observations = [];
            }
            node.version = 1;
            await this.jsonlStorage.appendLine(path.join(agentId, 'nodes.jsonl'), node);
        }
        // Export relations
        const relations = await db.all('SELECT relation_id as id, agent_id, from_node_id, to_node_id, relation_type as relationType, timestamp FROM knowledge_graph_relations WHERE agent_id = ?', agentId);
        for (const rel of relations) {
            rel.version = 1;
            await this.jsonlStorage.appendLine(path.join(agentId, 'relations.jsonl'), rel);
        }
    }

    // Import data from JSONL files into the JSONL storage (for consistency with plan's naming)
    async importToJSONL(agentId: string, inputFilePath: string): Promise<void> {
        // This method will leverage the JsonlStorageManager's importFromJson
        // The inputFilePath should point to a single JSON export file, as created by JsonlStorageManager.exportToJson
        await this.jsonlStorage.importFromJson(inputFilePath, agentId);
        console.log(`Successfully imported data from ${inputFilePath} for agent ${agentId}`);
    }

    // Validate migration by comparing counts
    async validateMigration(agentId: string): Promise<{ nodeCount: number; relationCount: number; jsonlNodeCount: number; jsonlRelationCount: number; }> {
        const db = this.dbService.getDb();
        const nodeCount = (await db.all('SELECT COUNT(*) as cnt FROM knowledge_graph_nodes WHERE agent_id = ?', agentId))[0].cnt;
        const relationCount = (await db.all('SELECT COUNT(*) as cnt FROM knowledge_graph_relations WHERE agent_id = ?', agentId))[0].cnt;
        const jsonlNodeCount = (await this.jsonlStorage.readAllLines(path.join(agentId, 'nodes.jsonl'))).length;
        const jsonlRelationCount = (await this.jsonlStorage.readAllLines(path.join(agentId, 'relations.jsonl'))).length;
        return { nodeCount, relationCount, jsonlNodeCount, jsonlRelationCount };
    }

    // Rollback: delete JSONL files for an agent
    async rollback(agentId: string): Promise<void> {
        const nodesPath = path.join(this.jsonlStorage['rootPath'], agentId, 'nodes.jsonl');
        const relationsPath = path.join(this.jsonlStorage['rootPath'], agentId, 'relations.jsonl');
        const eventsPath = path.join(this.jsonlStorage['rootPath'], agentId, 'events.jsonl'); // Also delete events.jsonl
        try { await fsp.unlink(nodesPath); } catch {}
        try { await fsp.unlink(relationsPath); } catch {}
        try { await fsp.unlink(eventsPath); } catch {} // Delete events.jsonl
    }
}
