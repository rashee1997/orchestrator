import { randomUUID } from 'crypto';
import { DatabaseService } from '../services/DatabaseService.js';
import { GeminiIntegrationService } from '../services/GeminiIntegrationService.js';

export interface ConversationSession {
    session_id: string;
    agent_id: string;
    user_id: string | null;
    title: string | null;
    start_timestamp: number;
    end_timestamp: number | null;
    metadata: any;
}

export interface ConversationMessage {
    message_id: string;
    session_id: string;
    parent_message_id: string | null;
    timestamp: number;
    sender: string;
    message_content: string;
    message_type: string;
    tool_info: any | null;
    context_snapshot_id: string | null;
    source_attribution_id: string | null;
    metadata: any;
    embedding: number[] | null;
}

export class ConversationHistoryManager {
    private dbService: DatabaseService;
    private geminiService: GeminiIntegrationService;

    constructor(dbService: DatabaseService, geminiService: GeminiIntegrationService) {
        this.dbService = dbService;
        this.geminiService = geminiService;
    }

    async initializeTables(): Promise<void> {
        const db = this.dbService.getDb();

        // Create conversation_sessions table
        await db.exec(`
            CREATE TABLE IF NOT EXISTS conversation_sessions (
                session_id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                user_id TEXT,
                title TEXT,
                start_timestamp INTEGER NOT NULL,
                end_timestamp INTEGER,
                metadata TEXT,
                FOREIGN KEY (agent_id) REFERENCES agents (agent_id)
            )
        `);

        // Create conversation_messages table
        await db.exec(`
            CREATE TABLE IF NOT EXISTS conversation_messages (
                message_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                parent_message_id TEXT,
                timestamp INTEGER NOT NULL,
                sender TEXT NOT NULL,
                message_content TEXT NOT NULL,
                message_type TEXT NOT NULL,
                tool_info TEXT,
                context_snapshot_id TEXT,
                source_attribution_id TEXT,
                metadata TEXT,
                embedding BLOB,
                FOREIGN KEY (session_id) REFERENCES conversation_sessions (session_id),
                FOREIGN KEY (parent_message_id) REFERENCES conversation_messages (message_id)
            )
        `);

        // Create indexes for better performance
        await db.exec(`
            CREATE INDEX IF NOT EXISTS idx_messages_session_id ON conversation_messages (session_id);
            CREATE INDEX IF NOT EXISTS idx_messages_parent_id ON conversation_messages (parent_message_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_agent_id ON conversation_sessions (agent_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON conversation_sessions (user_id);
        `);
    }

    async createConversationSession(
        agent_id: string,
        user_id: string | null = null,
        title: string | null = null,
        metadata: any = null
    ): Promise<string> {
        const db = this.dbService.getDb();
        const session_id = randomUUID();
        const start_timestamp = Date.now();

        await db.run(
            `INSERT INTO conversation_sessions (
                session_id, agent_id, user_id, title, start_timestamp, metadata
            ) VALUES (?, ?, ?, ?, ?, ?)`,
            session_id, agent_id, user_id, title, start_timestamp, JSON.stringify(metadata)
        );

        return session_id;
    }

    async endConversationSession(session_id: string): Promise<void> {
        const db = this.dbService.getDb();
        const end_timestamp = Date.now();

        await db.run(
            `UPDATE conversation_sessions SET end_timestamp = ? WHERE session_id = ?`,
            end_timestamp, session_id
        );
    }

    async storeConversationMessage(
        session_id: string,
        sender: string,
        message_content: string,
        message_type: string = 'text',
        tool_info: any = null,
        context_snapshot_id: string | null = null,
        source_attribution_id: string | null = null,
        parent_message_id: string | null = null,
        metadata: any = null,
        generateEmbedding: boolean = false
    ): Promise<string> {
        const db = this.dbService.getDb();
        const message_id = randomUUID();
        const timestamp = Date.now();

        let embedding: number[] | null = null;
        if (generateEmbedding && this.geminiService) {
            try {
                embedding = await this.generateMessageEmbedding(message_content);
            } catch (error) {
                console.error('Failed to generate message embedding:', error);
            }
        }

        const embeddingBlob = embedding ? Buffer.from(new Float32Array(embedding).buffer) : null;

        await db.run(
            `INSERT INTO conversation_messages (
                message_id, session_id, parent_message_id, timestamp, sender, message_content,
                message_type, tool_info, context_snapshot_id, source_attribution_id, metadata, embedding
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            message_id, session_id, parent_message_id, timestamp, sender, message_content,
            message_type, JSON.stringify(tool_info), context_snapshot_id, source_attribution_id,
            JSON.stringify(metadata), embeddingBlob
        );

        return message_id;
    }

    private async generateMessageEmbedding(content: string): Promise<number[]> {
        // This would use the Gemini service to generate embeddings
        // For now, we'll return a placeholder
        return new Array(768).fill(0).map(() => Math.random());
    }

    async getConversationSession(session_id: string): Promise<ConversationSession | null> {
        const db = this.dbService.getDb();
        const result = await db.get(
            `SELECT * FROM conversation_sessions WHERE session_id = ?`,
            session_id
        );

        if (!result) return null;

        return {
            session_id: result.session_id,
            agent_id: result.agent_id,
            user_id: result.user_id,
            title: result.title,
            start_timestamp: result.start_timestamp,
            end_timestamp: result.end_timestamp,
            metadata: result.metadata ? JSON.parse(result.metadata) : null
        };
    }

    async getConversationMessages(
        session_id: string,
        limit: number = 100,
        offset: number = 0,
        includeEmbeddings: boolean = false
    ): Promise<ConversationMessage[]> {
        const db = this.dbService.getDb();
        const results = await db.all(
            `SELECT * FROM conversation_messages 
             WHERE session_id = ? 
             ORDER BY timestamp ASC 
             LIMIT ? OFFSET ?`,
            session_id, limit, offset
        );

        return results.map(row => this.parseMessageRow(row, includeEmbeddings));
    }

    private parseMessageRow(row: any, includeEmbeddings: boolean): ConversationMessage {
        return {
            message_id: row.message_id,
            session_id: row.session_id,
            parent_message_id: row.parent_message_id,
            timestamp: row.timestamp,
            sender: row.sender,
            message_content: row.message_content,
            message_type: row.message_type,
            tool_info: row.tool_info ? JSON.parse(row.tool_info) : null,
            context_snapshot_id: row.context_snapshot_id,
            source_attribution_id: row.source_attribution_id,
            metadata: row.metadata ? JSON.parse(row.metadata) : null,
            embedding: includeEmbeddings && row.embedding ?
                Array.from(new Float32Array(row.embedding.buffer)) : null
        };
    }

    async getConversationSessions(
        agent_id: string,
        user_id: string | null = null,
        limit: number = 50,
        offset: number = 0
    ): Promise<ConversationSession[]> {
        const db = this.dbService.getDb();
        let query = `SELECT * FROM conversation_sessions WHERE agent_id = ?`;
        const params: any[] = [agent_id];

        if (user_id !== null) {
            query += ` AND user_id = ?`;
            params.push(user_id);
        }

        query += ` ORDER BY start_timestamp DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const results = await db.all(query, ...params);

        return results.map(row => ({
            session_id: row.session_id,
            agent_id: row.agent_id,
            user_id: row.user_id,
            title: row.title,
            start_timestamp: row.start_timestamp,
            end_timestamp: row.end_timestamp,
            metadata: row.metadata ? JSON.parse(row.metadata) : null
        }));
    }

    async searchConversations(
        agent_id: string,
        query: string,
        limit: number = 20,
        offset: number = 0,
        searchType: 'keyword' | 'semantic' = 'keyword'
    ): Promise<{ sessions: ConversationSession[], messages: ConversationMessage[] }> {
        if (searchType === 'semantic') {
            return this.semanticSearchConversations(agent_id, query, limit, offset);
        } else {
            return this.keywordSearchConversations(agent_id, query, limit, offset);
        }
    }

    private async keywordSearchConversations(
        agent_id: string,
        keywords: string,
        limit: number,
        offset: number
    ): Promise<{ sessions: ConversationSession[], messages: ConversationMessage[] }> {
        const db = this.dbService.getDb();
        const searchKeywords = keywords.toLowerCase().split(/\s+/).filter(k => k.length > 0);

        if (searchKeywords.length === 0) {
            return { sessions: [], messages: [] };
        }

        let query = `
            SELECT cm.*, 
                   cs.session_id AS cs_session_id, 
                   cs.agent_id AS cs_agent_id, 
                   cs.user_id AS cs_user_id, 
                   cs.title AS cs_title, 
                   cs.start_timestamp AS cs_start_timestamp, 
                   cs.end_timestamp AS cs_end_timestamp, 
                   cs.metadata AS cs_metadata
            FROM conversation_messages cm
            JOIN conversation_sessions cs ON cm.session_id = cs.session_id
            WHERE cs.agent_id = ?
        `;

        const params: any[] = [agent_id];

        searchKeywords.forEach((keyword, index) => {
            query += ` AND LOWER(cm.message_content) LIKE ?`;
            params.push(`%${keyword}%`);
        });

        query += ` ORDER BY cm.timestamp DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const results = await db.all(query, ...params);

        const sessionsMap = new Map<string, ConversationSession>();
        const messages: ConversationMessage[] = [];

        results.forEach(row => {
            if (!sessionsMap.has(row.cs_session_id)) {
                sessionsMap.set(row.cs_session_id, {
                    session_id: row.cs_session_id,
                    agent_id: row.cs_agent_id,
                    user_id: row.cs_user_id,
                    title: row.cs_title,
                    start_timestamp: row.cs_start_timestamp,
                    end_timestamp: row.cs_end_timestamp,
                    metadata: row.cs_metadata ? JSON.parse(row.cs_metadata) : null
                });
            }

            messages.push(this.parseMessageRow(row, false));
        });

        return {
            sessions: Array.from(sessionsMap.values()),
            messages
        };
    }

    private async semanticSearchConversations(
        agent_id: string,
        query: string,
        limit: number,
        offset: number
    ): Promise<{ sessions: ConversationSession[], messages: ConversationMessage[] }> {
        // This would use vector similarity search on message embeddings
        // For now, we'll fall back to keyword search
        console.warn("Semantic search is not fully implemented. Falling back to keyword search.");
        return this.keywordSearchConversations(agent_id, query, limit, offset);
    }

    async getMessageThread(message_id: string): Promise<ConversationMessage[]> {
        const db = this.dbService.getDb();

        // Use a recursive CTE to get the message and all its replies (descendants)
        const results = await db.all(
            `WITH RECURSIVE thread_messages AS (
                SELECT * FROM conversation_messages WHERE message_id = ?
                UNION ALL
                SELECT cm.* FROM conversation_messages cm
                JOIN thread_messages tm ON cm.parent_message_id = tm.message_id
            )
            SELECT * FROM thread_messages ORDER BY timestamp ASC`,
            message_id
        );

        return results.map(row => this.parseMessageRow(row, false));
    }

    async updateMessageMetadata(message_id: string, metadata: any): Promise<void> {
        const db = this.dbService.getDb();

        await db.run(
            `UPDATE conversation_messages SET metadata = ? WHERE message_id = ?`,
            JSON.stringify(metadata), message_id
        );
    }

    async deleteConversationSession(session_id: string): Promise<void> {
        const db = this.dbService.getDb();

        await db.run(`DELETE FROM conversation_messages WHERE session_id = ?`, session_id);
        await db.run(`DELETE FROM conversation_sessions WHERE session_id = ?`, session_id);
    }

    async summarizeConversation(session_id: string): Promise<string> {
        const messages = await this.getConversationMessages(session_id, 100, 0);

        if (!messages || messages.length === 0) {
            return "No conversation found to summarize.";
        }

        const formattedMessages = messages.map(msg => `${msg.sender}: ${msg.message_content}`).join('\n');

        return this.geminiService.summarizeConversation(
            messages[0].session_id,
            formattedMessages
        );
    }
}