import { DatabaseService } from '../services/DatabaseService.js';
import { v4 as uuidv4 } from 'uuid';

export class ModeInstructionManager {
    private db: DatabaseService;

    constructor(dbService: DatabaseService) {
        this.db = dbService;
    }

    async storeModeInstruction(
        agent_id: string,
        mode_name: string,
        instruction_content: string,
        version: number = 1
    ): Promise<string> {
        const instruction_id = uuidv4();
        const timestamp = Math.floor(Date.now() / 1000);

        await this.db.getDb().run(
            `INSERT INTO mode_instructions (instruction_id, agent_id, mode_name, instruction_content, version, creation_timestamp, last_updated_timestamp)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(agent_id, mode_name, version) DO UPDATE SET
             instruction_content = EXCLUDED.instruction_content,
             last_updated_timestamp = EXCLUDED.last_updated_timestamp`,
            instruction_id,
            agent_id,
            mode_name,
            instruction_content,
            version,
            timestamp,
            timestamp
        );
        return instruction_id;
    }

    async getModeInstruction(
        agent_id: string,
        mode_name: string,
        version?: number
    ): Promise<any | null> {
        let query = `SELECT instruction_id, agent_id, mode_name, instruction_content, version, creation_timestamp, last_updated_timestamp
                     FROM mode_instructions
                     WHERE agent_id = ? AND mode_name = ?`;
        const params: (string | number)[] = [agent_id, mode_name];

        if (version !== undefined) {
            query += ` AND version = ?`;
            params.push(version);
        } else {
            query += ` ORDER BY version DESC LIMIT 1`;
        }

        return this.db.getDb().get(query, params);
    }

    async deleteModeInstruction(
        agent_id: string,
        mode_name: string,
        version?: number
    ): Promise<number> {
        let query = `DELETE FROM mode_instructions WHERE agent_id = ? AND mode_name = ?`;
        const params: (string | number)[] = [agent_id, mode_name];

        if (version !== undefined) {
            query += ` AND version = ?`;
            params.push(version);
        }

        const result = await this.db.getDb().run(query, params);
        return result.changes || 0;
    }
}
