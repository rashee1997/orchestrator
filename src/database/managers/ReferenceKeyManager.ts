import { randomUUID } from 'crypto';
import { DatabaseService } from '../services/DatabaseService.js';

export class ReferenceKeyManager {
    private dbService: DatabaseService;

    constructor(dbService: DatabaseService) {
        this.dbService = dbService;
    }

    async addReferenceKey(
        agent_id: string,
        key_type: string,
        key_value: string,
        description: string | null = null,
        associated_conversation_id: string | null = null
    ) {
        const db = this.dbService.getDb();
        const reference_id = randomUUID();
        const timestamp = Date.now();
        await db.run(
            `INSERT INTO reference_keys (
                reference_id, agent_id, key_type, key_value, description, timestamp, associated_conversation_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            reference_id, agent_id, key_type, key_value, description, timestamp, associated_conversation_id
        );
        return reference_id;
    }

    async getReferenceKeys(
        agent_id: string,
        key_type: string | null = null,
        limit: number = 100,
        offset: number = 0
    ) {
        const db = this.dbService.getDb();
        let query = `SELECT * FROM reference_keys WHERE agent_id = ?`;
        const params: (string | number)[] = [agent_id];

        if (key_type) {
            query += ` AND key_type = ?`;
            params.push(key_type);
        }

        query += ` ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        return db.all(query, ...params as any[]);
    }
}
