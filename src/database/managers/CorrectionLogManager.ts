import { randomUUID } from 'crypto';
import { DatabaseService } from '../services/DatabaseService.js';

export class CorrectionLogManager {
    private dbService: DatabaseService;

    constructor(dbService: DatabaseService) {
        this.dbService = dbService;
    }

    async logCorrection(
        agent_id: string,
        correction_type: string,
        original_entry_id: string | null,
        original_value: any | null, // Will be JSON stringified
        corrected_value: any | null, // Will be JSON stringified
        reason: string | null,
        applied_automatically: boolean
    ) {
        const db = this.dbService.getDb();
        const correction_id = randomUUID();
        const timestamp = Date.now();
        const original_value_json = original_value ? JSON.stringify(original_value) : null;
        const corrected_value_json = corrected_value ? JSON.stringify(corrected_value) : null;

        await db.run(
            `INSERT INTO correction_logs (
                correction_id, agent_id, timestamp, correction_type, original_entry_id,
                original_value, corrected_value, reason, applied_automatically
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            correction_id, agent_id, timestamp, correction_type, original_entry_id,
            original_value_json, corrected_value_json, reason, applied_automatically
        );
        return correction_id;
    }

    async getCorrectionLogs(
        agent_id: string,
        correction_type: string | null = null,
        limit: number = 100,
        offset: number = 0
    ) {
        const db = this.dbService.getDb();
        let query = `SELECT * FROM correction_logs WHERE agent_id = ?`;
        const params: (string | number)[] = [agent_id];

        if (correction_type) {
            query += ` AND correction_type = ?`;
            params.push(correction_type);
        }

        query += ` ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const results = await db.all(query, ...params as any[]);
        return results.map((row: any) => {
            if (row.original_value) row.original_value = JSON.parse(row.original_value);
            if (row.corrected_value) row.corrected_value = JSON.parse(row.corrected_value);
            return row;
        });
    }
}
