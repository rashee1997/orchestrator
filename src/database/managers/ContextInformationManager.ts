import { randomUUID } from 'crypto';
import { DatabaseService } from '../services/DatabaseService.js';

export class ContextInformationManager {
    private dbService: DatabaseService;

    constructor(dbService: DatabaseService) {
        this.dbService = dbService;
    }

    async storeContext(
        agent_id: string,
        context_type: string,
        context_data: any, // Will be JSON stringified
        parent_context_id: string | null = null
    ) {
        const db = this.dbService.getDb();
        const context_id = randomUUID();
        const timestamp = Date.now();
        const context_data_json = JSON.stringify(context_data);

        // Check for existing context of the same type for the agent to handle versioning
        const existingContext = await db.get(
            `SELECT context_id, version FROM context_information
             WHERE agent_id = ? AND context_type = ? ORDER BY version DESC LIMIT 1`,
            agent_id, context_type
        );

        let newVersion = 1;
        if (existingContext) {
            newVersion = existingContext.version + 1;
        }

        await db.run(
            `INSERT INTO context_information (
                context_id, agent_id, timestamp, context_type, context_data, version, parent_context_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            context_id, agent_id, timestamp, context_type, context_data_json, newVersion, parent_context_id
        );
        return context_id;
    }

    async getContext(
        agent_id: string,
        context_type: string,
        version: number | null = null,
        snippet_index: number | null = null // New parameter
    ) {
        const db = this.dbService.getDb();
        let query = `SELECT * FROM context_information WHERE agent_id = ? AND context_type = ?`;
        const params: (string | number)[] = [agent_id, context_type];

        if (version !== null) {
            query += ` AND version = ?`;
            params.push(version);
        } else {
            query += ` ORDER BY version DESC LIMIT 1`; // Get latest version
        }

        const result = await db.get(query, ...params as any[]);
        if (result && result.context_data) {
            result.context_data = JSON.parse(result.context_data);

            // If snippet_index is provided, try to return only that snippet
            if (snippet_index !== null && typeof snippet_index === 'number' && snippet_index >= 0) {
                if (result.context_data.documentation_snippets && Array.isArray(result.context_data.documentation_snippets)) {
                    if (snippet_index < result.context_data.documentation_snippets.length) {
                        return result.context_data.documentation_snippets[snippet_index];
                    } else {
                        // Index out of bounds
                        return null; // Or throw an error, depending on desired behavior
                    }
                } else {
                    // documentation_snippets array not found
                    return null; // Or throw an error
                }
            }
        }
        return result; // Return full context or null if not found/parsed
    }

    async getAllContexts(agent_id: string) {
        const db = this.dbService.getDb();
        const results = await db.all(`SELECT * FROM context_information WHERE agent_id = ? ORDER BY timestamp DESC`, agent_id);
        return results.map((row: any) => {
            if (row.context_data) {
                row.context_data = JSON.parse(row.context_data);
            }
            return row;
        });
    }

    async searchContextByKeywords(
        agent_id: string,
        context_type: string,
        keywords: string
    ) {
        const db = this.dbService.getDb();
        // Retrieve the latest version of the context for the given agent and context_type
        const contextResult = await this.getContext(agent_id, context_type);

        if (!contextResult || !contextResult.context_data || !contextResult.context_data.documentation_snippets || !Array.isArray(contextResult.context_data.documentation_snippets)) {
            return []; // Return empty array if context or snippets not found
        }

        const searchKeywords = keywords.toLowerCase().split(/\s+/).filter(k => k.length > 0);
        const filteredSnippets = contextResult.context_data.documentation_snippets.filter((snippet: any) => {
            const title = (snippet.TITLE || '').toLowerCase();
            const description = (snippet.DESCRIPTION || '').toLowerCase();
            const code = (snippet.CODE || '').toLowerCase(); // Also search in code

            return searchKeywords.some(keyword =>
                title.includes(keyword) ||
                description.includes(keyword) ||
                code.includes(keyword)
            );
        });

        return filteredSnippets;
    }

    async pruneOldContext(
        agent_id: string,
        max_age_ms: number,
        context_type: string | null = null
    ) {
        const db = this.dbService.getDb();
        const cutoffTimestamp = Date.now() - max_age_ms;

        let query = `DELETE FROM context_information WHERE agent_id = ? AND timestamp < ?`;
        const params: (string | number)[] = [agent_id, cutoffTimestamp];

        if (context_type) {
            query += ` AND context_type = ?`;
            params.push(context_type);
        }

        const result = await db.run(query, ...params as any[]);
        return result.changes; // Number of rows deleted
    }
}
