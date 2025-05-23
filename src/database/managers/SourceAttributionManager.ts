import { randomUUID } from 'crypto';
import { DatabaseService } from '../services/DatabaseService.js';

export class SourceAttributionManager {
    private dbService: DatabaseService;

    constructor(dbService: DatabaseService) {
        this.dbService = dbService;
    }

    async logSourceAttribution(
        agent_id: string,
        source_type: string,
        source_uri: string | null = null,
        retrieval_timestamp: number,
        content_summary: string | null = null,
        full_content_hash: string | null = null,
        full_content_json: string | null = null // New parameter
    ) {
        const db = this.dbService.getDb();
        const attribution_id = randomUUID();
        await db.run(
            `INSERT INTO source_attribution (
                attribution_id, agent_id, source_type, source_uri, retrieval_timestamp, content_summary, full_content_hash, full_content_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            attribution_id, agent_id, source_type, source_uri, retrieval_timestamp, content_summary, full_content_hash, full_content_json
        );
        return attribution_id;
    }

    async getSourceAttributions(
        agent_id: string,
        source_type: string | null = null,
        limit: number = 100,
        offset: number = 0
    ) {
        const db = this.dbService.getDb();
        let query = `SELECT * FROM source_attribution WHERE agent_id = ?`;
        const params: (string | number)[] = [agent_id];

        if (source_type) {
            query += ` AND source_type = ?`;
            params.push(source_type);
        }

        query += ` ORDER BY retrieval_timestamp DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        return db.all(query, ...params as any[]);
    }
}
