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
        version: number = 1 // Default version to 1 if not provided
    ): Promise<string> {
        const potential_instruction_id = uuidv4(); // Generate a UUID, might be used for new insert
        const timestamp = Math.floor(Date.now() / 1000); // Unix timestamp in seconds

        try {
            await this.db.getDb().run(
                `INSERT INTO mode_instructions (instruction_id, agent_id, mode_name, instruction_content, version, creation_timestamp, last_updated_timestamp)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(agent_id, mode_name, version) DO UPDATE SET
                 instruction_content = EXCLUDED.instruction_content,
                 last_updated_timestamp = EXCLUDED.last_updated_timestamp`,
                potential_instruction_id, // This ID is used if it's a new row
                agent_id,
                mode_name,
                instruction_content,
                version,
                timestamp, // creation_timestamp
                timestamp  // last_updated_timestamp
            );

            // After the INSERT or UPDATE, fetch the actual instruction_id from the database
            // as the potential_instruction_id might not be the one stored if an update occurred.
            // The primary key (instruction_id) is NOT updated by ON CONFLICT DO UPDATE if it's part of the conflict target or primary key.
            // However, the unique constraint is on (agent_id, mode_name, version).
            // We need to fetch the instruction_id based on these unique fields.
            const row = await this.db.getDb().get(
                `SELECT instruction_id FROM mode_instructions WHERE agent_id = ? AND mode_name = ? AND version = ?`,
                agent_id, mode_name, version
            );

            if (row && row.instruction_id) {
                return row.instruction_id;
            } else {
                // This case should ideally not be reached if the INSERT OR UPDATE was successful.
                // It might indicate an issue or a race condition if the row was deleted immediately after.
                console.error(`Failed to retrieve instruction_id for ${agent_id}, ${mode_name}, v${version} after store operation.`);
                // Fallback to the ID generated for insert attempt, though it might be misleading if an update happened.
                // A more robust solution might involve throwing an error here.
                throw new Error(`Could not confirm instruction ID after storing for agent ${agent_id}, mode ${mode_name}, version ${version}.`);
            }

        } catch (error) {
            console.error(`Error in storeModeInstruction for agent ${agent_id}, mode ${mode_name}:`, error);
            throw error; // Re-throw the error
        }
    }

    async getModeInstruction(
        agent_id: string,
        mode_name: string,
        version?: number
    ): Promise<any | null> { // Return type 'any' is kept as original, consider defining a specific type
        let query = `SELECT instruction_id, agent_id, mode_name, instruction_content, version, creation_timestamp, last_updated_timestamp
                     FROM mode_instructions
                     WHERE agent_id = ? AND mode_name = ?`;
        const params: (string | number)[] = [agent_id, mode_name];

        if (version !== undefined) {
            query += ` AND version = ?`;
            params.push(version);
        } else {
            // If no version is specified, get the one with the highest version number (latest)
            query += ` ORDER BY version DESC LIMIT 1`;
        }

        try {
            return await this.db.getDb().get(query, params);
        } catch (error) {
            console.error(`Error in getModeInstruction for agent ${agent_id}, mode ${mode_name}:`, error);
            throw error;
        }
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
        // If version is not provided, all versions for that agent_id and mode_name will be deleted.

        try {
            const result = await this.db.getDb().run(query, params);
            return result.changes || 0; // Number of rows deleted
        } catch (error) {
            console.error(`Error in deleteModeInstruction for agent ${agent_id}, mode ${mode_name}:`, error);
            throw error;
        }
    }
}
