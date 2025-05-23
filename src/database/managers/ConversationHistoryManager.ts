import { randomUUID } from 'crypto';
import { DatabaseService } from '../services/DatabaseService.js';

export class ConversationHistoryManager {
    private dbService: DatabaseService;

    constructor(dbService: DatabaseService) {
        this.dbService = dbService;
    }

    async storeConversationMessage(
        agent_id: string,
        user_id: string | null,
        sender: string,
        message_content: string,
        message_type: string = 'text',
        tool_info: string | null = null,
        context_snapshot_id: string | null = null,
        source_attribution_id: string | null = null
    ) {
        const db = this.dbService.getDb();
        const conversation_id = randomUUID();
        const timestamp = Date.now();
        await db.run(
            `INSERT INTO conversation_history (
                conversation_id, agent_id, user_id, timestamp, sender, message_content,
                message_type, tool_info, context_snapshot_id, source_attribution_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            conversation_id, agent_id, user_id, timestamp, sender, message_content,
            message_type, tool_info, context_snapshot_id, source_attribution_id
        );
        return conversation_id;
    }

    async getConversationHistory(
        agent_id: string,
        conversation_id: string | null = null,
        limit: number = 100,
        offset: number = 0
    ) {
        const db = this.dbService.getDb();
        let query = `SELECT * FROM conversation_history WHERE agent_id = ?`;
        const params: (string | number)[] = [agent_id];

        if (conversation_id) {
            query += ` AND conversation_id = ?`;
            params.push(conversation_id);
        }

        query += ` ORDER BY timestamp ASC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        return db.all(query, ...params as any[]);
    }
}
