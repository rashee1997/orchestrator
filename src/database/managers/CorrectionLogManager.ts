import { randomUUID } from 'crypto';
import { DatabaseService } from '../services/DatabaseService.js';
import { CorrectionLog } from '../../types/index.js';

// NEW: Define a type for the log after JSON fields have been parsed.
export type ParsedCorrectionLog = CorrectionLog & {
    original_value_parsed?: any;
    corrected_value_parsed?: any;
    original_value_json_parsing_error?: boolean;
    corrected_value_json_parsing_error?: boolean;
};

export class CorrectionLogManager {
    private dbService: DatabaseService;

    constructor(dbService: DatabaseService) {
        this.dbService = dbService;
    }

    async logCorrection(
        agent_id: string,
        correction_type: string,
        original_entry_id: string | null,
        original_value: any | null, // Expects an object, will be JSON stringified
        corrected_value: any | null, // Expects an object, will be JSON stringified
        reason: string | null,
        correction_summary: string | null,
        applied_automatically: boolean,
        status: string = 'LOGGED'
    ): Promise<string> {
        const db = this.dbService.getDb();
        const correction_id = randomUUID();
        const creation_timestamp_unix = Date.now();
        const creation_timestamp_iso = new Date(creation_timestamp_unix).toISOString();
        const last_updated_timestamp_unix = creation_timestamp_unix;
        const last_updated_timestamp_iso = creation_timestamp_iso;

        const original_value_json = original_value !== null ? JSON.stringify(original_value) : null;
        const corrected_value_json = corrected_value !== null ? JSON.stringify(corrected_value) : null;

        const agentExists = await db.get(`SELECT agent_id FROM agents WHERE agent_id = ?`, agent_id);
        if (!agentExists) {
            throw new Error(`Agent with ID '${agent_id}' not found. Cannot log correction.`);
        }

        try {
            await db.run(
                `INSERT INTO correction_logs (
                    correction_id, agent_id, correction_type, original_entry_id,
                    original_value_json, corrected_value_json, reason, correction_summary,
                    applied_automatically, creation_timestamp_unix, creation_timestamp_iso,
                    last_updated_timestamp_unix, last_updated_timestamp_iso, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                correction_id, agent_id, correction_type, original_entry_id,
                original_value_json, corrected_value_json, reason || null, correction_summary || null,
                applied_automatically, creation_timestamp_unix, creation_timestamp_iso,
                last_updated_timestamp_unix, last_updated_timestamp_iso, status
            );
            return correction_id;
        } catch (error) {
            console.error(`Error logging correction for agent ${agent_id}:`, error);
            if (error instanceof Error && error.message.includes('FOREIGN KEY constraint failed')) {
                throw new Error(`Failed to log correction due to a database constraint. Ensure all referenced IDs are valid. Original error: ${error.message}`);
            }
            throw error;
        }
    }

    private parseJsonFields(log: CorrectionLog): ParsedCorrectionLog {
        const parsedLog: ParsedCorrectionLog = { ...log };
        if (parsedLog) {
            // Parse original_value_json
            if (typeof parsedLog.original_value_json === 'string') {
                try {
                    parsedLog.original_value_parsed = JSON.parse(parsedLog.original_value_json);
                } catch (e) {
                    console.error(`Failed to parse original_value_json for correction_id ${parsedLog.correction_id}:`, e);
                    parsedLog.original_value_parsed = null;
                    parsedLog.original_value_json_parsing_error = true;
                }
            } else {
                parsedLog.original_value_parsed = null;
            }

            // Parse corrected_value_json
            if (typeof parsedLog.corrected_value_json === 'string') {
                try {
                    parsedLog.corrected_value_parsed = JSON.parse(parsedLog.corrected_value_json);
                } catch (e) {
                    console.error(`Failed to parse corrected_value_json for correction_id ${parsedLog.correction_id}:`, e);
                    parsedLog.corrected_value_parsed = null;
                    parsedLog.corrected_value_json_parsing_error = true;
                }
            } else {
                parsedLog.corrected_value_parsed = null;
            }
        }
        // The original _json fields (e.g., log.original_value_json) are preserved as they came from the DB.
        return parsedLog;
    }

    async getCorrectionLogs(
        agent_id: string,
        correction_type: string | null = null,
        limit: number = 100,
        offset: number = 0
    ): Promise<ParsedCorrectionLog[]> { // Use the new ParsedCorrectionLog type
        const db = this.dbService.getDb();
        let query = `SELECT * FROM correction_logs WHERE agent_id = ?`;
        const params: (string | number)[] = [agent_id];

        if (correction_type) {
            query += ` AND correction_type = ?`;
            params.push(correction_type);
        }

        query += ` ORDER BY creation_timestamp_unix DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const results: CorrectionLog[] = await db.all(query, ...params as any[]);
        return results.map(row => this.parseJsonFields(row));
    }

    async updateCorrectionLogStatus(
        correction_id: string,
        new_status: string,
        // Removed last_updated_timestamp_unix and last_updated_timestamp_iso as params,
        // as they should be set by the method itself upon update.
    ): Promise<void> {
        const db = this.dbService.getDb();
        const timestamp = Date.now();
        const isoTimestamp = new Date(timestamp).toISOString();
        await db.run(
            `UPDATE correction_logs SET status = ?, last_updated_timestamp_unix = ?, last_updated_timestamp_iso = ? WHERE correction_id = ?`,
            new_status, timestamp, isoTimestamp, correction_id
        );
    }
}
