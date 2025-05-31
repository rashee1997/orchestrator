// src/database/storage/IndexManager.ts
import path from 'path';
import fsp from 'fs/promises';
import { JsonlStorageManager } from './JsonlStorageManager.js';
import { KnowledgeGraphEvent } from './EventStore.js';

export class IndexManager {
    private jsonlStorage: JsonlStorageManager;
    constructor(jsonlStorage: JsonlStorageManager) {
        this.jsonlStorage = jsonlStorage;
    }

    /**
     * Builds all indexes for an agent (name, type, etc.)
     */
    async buildIndexes(agentId: string): Promise<void> {
        const nodes = await this.jsonlStorage.readAllLines(path.join(agentId, 'nodes.jsonl'));
        const nameIndex: Record<string, string> = {};
        const typeIndex: Record<string, string[]> = {};

        for (const node of nodes) {
            if (node.name) {
                nameIndex[node.name] = node.id;
            }
            if (node.entityType) {
                if (!typeIndex[node.entityType]) typeIndex[node.entityType] = [];
                typeIndex[node.entityType].push(node.id);
            }
        }

        // Write indexes
        const indexPath = path.join(this.jsonlStorage['rootPath'], agentId, 'indexes');
        await fsp.mkdir(indexPath, { recursive: true });

        await fsp.writeFile(path.join(indexPath, 'name_index.json'), JSON.stringify(nameIndex, null, 2), 'utf8');
        await fsp.writeFile(path.join(indexPath, 'type_index.json'), JSON.stringify(typeIndex, null, 2), 'utf8');
    }

    /**
     * Updates indexes for a single event (node/relation create/delete)
     */
    async updateIndex(agentId: string, event: KnowledgeGraphEvent): Promise<void> {
        // For simplicity, rebuild all indexes for now
        await this.buildIndexes(agentId);
    }

    /**
     * Searches by index (name or type)
     */
    async searchByIndex(agentId: string, indexType: 'name' | 'type', query: string): Promise<string[]> {
        const indexPath = path.join(this.jsonlStorage['rootPath'], agentId, 'indexes', `${indexType}_index.json`);
        try {
            const indexData: Record<string, unknown> = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
            if (indexType === 'name') {
                // Exact match
                if (typeof indexData[query] === 'string') return [indexData[query] as string];
                // Fuzzy: return all ids where name includes query
                return Object.entries(indexData)
                    .filter(([name]) => name.includes(query))
                    .map(([, id]) => id as string);
            } else if (indexType === 'type') {
                // Exact match for type
                if (Array.isArray(indexData[query])) return indexData[query] as string[];
                // Fuzzy: return all ids for types that include query
                return Object.entries(indexData)
                    .filter(([type]) => type.includes(query))
                    .flatMap(([, ids]) => ids as string[]);
            }
        } catch {
            return [];
        }
        return [];
    }

    /**
     * Rebuilds all indexes for an agent
     */
    async rebuildAllIndexes(agentId: string): Promise<void> {
        await this.buildIndexes(agentId);
    }
}
