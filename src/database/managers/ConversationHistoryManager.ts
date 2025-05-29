import { randomUUID } from 'crypto';
import { DatabaseService } from '../services/DatabaseService.js';
import { GeminiIntegrationService } from '../services/GeminiIntegrationService.js'; // Import GeminiIntegrationService

export class ConversationHistoryManager {
    private dbService: DatabaseService;
    private geminiService: GeminiIntegrationService; // Add geminiService property

    constructor(dbService: DatabaseService, geminiService: GeminiIntegrationService) {
        this.dbService = dbService;
        this.geminiService = geminiService; // Initialize geminiService
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

    async searchConversationByKeywords(
        agent_id: string,
        keywords: string,
        limit: number = 100,
        offset: number = 0
    ) {
        const db = this.dbService.getDb();
        const searchKeywords = keywords.toLowerCase().split(/\s+/).filter(k => k.length > 0);

        if (searchKeywords.length === 0) {
            return [];
        }

        let query = `SELECT * FROM conversation_history WHERE agent_id = ?`;
        const params: (string | number)[] = [agent_id];

        // Add LIKE clauses for each keyword
        searchKeywords.forEach((keyword, index) => {
            query += ` AND LOWER(message_content) LIKE ?`;
            params.push(`%${keyword}%`);
        });

        query += ` ORDER BY timestamp ASC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        return db.all(query, ...params as any[]);
    }

    async summarizeConversation(
        agent_id: string,
        conversation_id: string | null = null,
        limit: number = 100
    ): Promise<string> {
        const history = await this.getConversationHistory(agent_id, conversation_id, limit);
        if (!history || history.length === 0) {
            return "No conversation history found to summarize.";
        }

        // Format messages for Gemini
        const formattedMessages = history.map(msg => `${msg.sender}: ${msg.message_content}`).join('\n');

        // Delegate to GeminiIntegrationService for actual summarization
        // This method will be added to GeminiIntegrationService in a later step
        return this.geminiService.summarizeConversation(agent_id, formattedMessages);
    }
}
