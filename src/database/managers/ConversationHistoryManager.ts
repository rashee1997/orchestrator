// src/database/managers/ConversationHistoryManager.ts
import { randomUUID } from 'crypto';
import { DatabaseService } from '../services/DatabaseService.js';
import { GeminiIntegrationService } from '../services/GeminiIntegrationService.js';
import { SUMMARIZE_CONVERSATION_PROMPT } from '../services/gemini-integration-modules/GeminiPromptTemplates.js';

export interface SessionParticipant {
    participant_id: string; // Can be an agent_id or user_id
    session_id: string;
    role: string;
    join_timestamp: number;
}

export interface ConversationSession {
    session_id: string;
    agent_id: string; // The creating agent
    participants: SessionParticipant[];
    title: string | null;
    sequence_number: number | null;
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
    metadata: any;
    embedding: number[] | null;
}

export interface NewMessage {
    sender: string;
    message_content: string;
    message_type?: string;
    tool_info?: any;
    context_snapshot_id?: string | null;
    parent_message_id?: string | null;
    metadata?: any;
    generateEmbedding?: boolean;
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

        // Create conversation_sessions table (without user_id)
        await db.exec(`
            CREATE TABLE IF NOT EXISTS conversation_sessions (
                session_id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                title TEXT,
                sequence_number INTEGER,
                start_timestamp INTEGER NOT NULL,
                end_timestamp INTEGER,
                metadata TEXT,
                FOREIGN KEY (agent_id) REFERENCES agents (agent_id) ON DELETE CASCADE
            )
        `);

        // Create session_participants table for collaborative sessions
        await db.exec(`
            CREATE TABLE IF NOT EXISTS session_participants (
                participant_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'member',
                join_timestamp INTEGER NOT NULL,
                PRIMARY KEY (participant_id, session_id),
                FOREIGN KEY (session_id) REFERENCES conversation_sessions (session_id) ON DELETE CASCADE
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
                metadata TEXT,
                embedding BLOB,
                FOREIGN KEY (session_id) REFERENCES conversation_sessions (session_id) ON DELETE CASCADE,
                FOREIGN KEY (parent_message_id) REFERENCES conversation_messages (message_id)
            )
        `);

        // Create indexes for better performance
        await db.exec(`
            CREATE INDEX IF NOT EXISTS idx_messages_session_id ON conversation_messages (session_id);
            CREATE INDEX IF NOT EXISTS idx_messages_parent_id ON conversation_messages (parent_message_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_agent_id ON conversation_sessions (agent_id);
            CREATE INDEX IF NOT EXISTS idx_session_participants_session_id ON session_participants (session_id);
            CREATE INDEX IF NOT EXISTS idx_session_participants_participant_id ON session_participants (participant_id);
        `);
    }

    async createConversationSession(
        agent_id: string,
        title: string | null = null,
        metadata: any = null,
        initial_participant_ids: string[] = []
    ): Promise<string> {
        const db = this.dbService.getDb();
        const session_id = randomUUID();
        const start_timestamp = Date.now();

        const nextSequenceNumber = await this.getNextSequenceNumberForAgent(agent_id);

        await db.run(
            `INSERT INTO conversation_sessions (
                session_id, agent_id, title, sequence_number, start_timestamp, metadata
            ) VALUES (?, ?, ?, ?, ?, ?)`,
            session_id, agent_id, title, nextSequenceNumber, start_timestamp, JSON.stringify(metadata)
        );

        // Add the creating agent as the owner
        await this.addParticipantToSession(session_id, agent_id, 'owner');

        // Add initial participants
        for (const participant_id of initial_participant_ids) {
            // Avoid re-adding the owner
            if (participant_id !== agent_id) {
                await this.addParticipantToSession(session_id, participant_id, 'member');
            }
        }

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
        parent_message_id: string | null = null,
        metadata: any = null,
        generateEmbedding: boolean = false
    ): Promise<string> {
        const result = await this.storeConversationMessagesBulk(session_id, [{
            sender, message_content, message_type, tool_info, context_snapshot_id,
            parent_message_id, metadata, generateEmbedding
        }]);
        return result[0];
    }

    async storeConversationMessagesBulk(
        session_id: string,
        messages: NewMessage[]
    ): Promise<string[]> {
        const db = this.dbService.getDb();
        const message_ids: string[] = [];

        const insertStatement = await db.prepare(
            `INSERT INTO conversation_messages (
                message_id, session_id, parent_message_id, timestamp, sender, message_content,
                message_type, tool_info, context_snapshot_id, metadata, embedding
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );

        try {
            await db.exec('BEGIN TRANSACTION');
            for (const message of messages) {
                const message_id = randomUUID();
                message_ids.push(message_id);
                const timestamp = Date.now();
                let embedding: number[] | null = null;
                if (message.generateEmbedding && this.geminiService) {
                    try {
                        embedding = await this.generateMessageEmbedding(message.message_content);
                    } catch (error) {
                        console.error('Failed to generate message embedding:', error);
                    }
                }
                const embeddingBlob = embedding ? Buffer.from(new Float32Array(embedding).buffer) : null;

                await insertStatement.run(
                    message_id, session_id, message.parent_message_id, timestamp, message.sender, message.message_content,
                    message.message_type ?? 'text', JSON.stringify(message.tool_info), message.context_snapshot_id,
                    JSON.stringify(message.metadata), embeddingBlob
                );
            }
            await db.exec('COMMIT');
        } catch (error) {
            await db.exec('ROLLBACK');
            console.error('Failed to bulk insert messages:', error);
            throw error;
        } finally {
            await insertStatement.finalize();
        }

        return message_ids;
    }

    private async generateMessageEmbedding(content: string): Promise<number[]> {
        return new Array(768).fill(0).map(() => Math.random());
    }

    async getConversationSession(session_id: string): Promise<ConversationSession | null> {
        const db = this.dbService.getDb();
        const result = await db.get(
            `SELECT * FROM conversation_sessions WHERE session_id = ?`,
            session_id
        );

        if (!result) return null;

        const participants = await this.getSessionParticipants(session_id);

        return {
            session_id: result.session_id,
            agent_id: result.agent_id,
            participants,
            title: result.title,
            sequence_number: result.sequence_number,
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
            metadata: row.metadata ? JSON.parse(row.metadata) : null,
            embedding: includeEmbeddings && row.embedding ?
                Array.from(new Float32Array(row.embedding.buffer)) : null
        };
    }

    async getConversationSessions(
        agent_id: string,
        participant_id: string | null = null,
        limit: number = 50,
        offset: number = 0
    ): Promise<ConversationSession[]> {
        const db = this.dbService.getDb();
        let query = `
            SELECT cs.* FROM conversation_sessions cs
            JOIN session_participants sp ON cs.session_id = sp.session_id
            WHERE cs.agent_id = ?
        `;
        const params: any[] = [agent_id];

        if (participant_id !== null) {
            query += ` AND sp.participant_id = ?`;
            params.push(participant_id);
        }

        query += ` GROUP BY cs.session_id ORDER BY cs.start_timestamp DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const results = await db.all(query, ...params);
        const sessions: ConversationSession[] = [];

        for (const row of results) {
            const participants = await this.getSessionParticipants(row.session_id);
            sessions.push({
                session_id: row.session_id,
                agent_id: row.agent_id,
                participants,
                title: row.title,
                sequence_number: row.sequence_number,
                start_timestamp: row.start_timestamp,
                end_timestamp: row.end_timestamp,
                metadata: row.metadata ? JSON.parse(row.metadata) : null
            });
        }
        return sessions;
    }

    async getConversationSessionsBySequence(agent_id: string, sequenceNumber: number): Promise<ConversationSession[]> {
        const db = this.dbService.getDb();
        const results = await db.all(
            `SELECT cs.* FROM conversation_sessions cs
             WHERE cs.agent_id = ? AND cs.sequence_number = ?
             ORDER BY cs.start_timestamp DESC`,
            agent_id, sequenceNumber
        );
        const sessions: ConversationSession[] = [];
        for (const row of results) {
            const participants = await this.getSessionParticipants(row.session_id);
            sessions.push({
                session_id: row.session_id,
                agent_id: row.agent_id,
                participants,
                title: row.title,
                sequence_number: row.sequence_number,
                start_timestamp: row.start_timestamp,
                end_timestamp: row.end_timestamp,
                metadata: row.metadata ? JSON.parse(row.metadata) : null
            });
        }
        return sessions;
    }

    private async getNextSequenceNumberForAgent(agent_id: string): Promise<number> {
        const db = this.dbService.getDb();
        const result = await db.get(
            `SELECT MAX(sequence_number) as max_sequence FROM conversation_sessions WHERE agent_id = ?`,
            agent_id
        );
        return (result?.max_sequence || 0) + 1;
    }

    async getConversationSessionsByTitle(agent_id: string, title: string): Promise<ConversationSession[]> {
        const db = this.dbService.getDb();
        const results = await db.all(
            `SELECT cs.* FROM conversation_sessions cs
             WHERE cs.agent_id = ? AND cs.title = ?
             ORDER BY cs.start_timestamp DESC`,
            agent_id, title
        );
        const sessions: ConversationSession[] = [];
        for (const row of results) {
            const participants = await this.getSessionParticipants(row.session_id);
            sessions.push({
                session_id: row.session_id,
                agent_id: row.agent_id,
                participants,
                title: row.title,
                sequence_number: row.sequence_number,
                start_timestamp: row.start_timestamp,
                end_timestamp: row.end_timestamp,
                metadata: row.metadata ? JSON.parse(row.metadata) : null
            });
        }
        return sessions;
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
                   cs.title AS cs_title,
                   cs.sequence_number AS cs_sequence_number,
                   cs.start_timestamp AS cs_start_timestamp,
                   cs.end_timestamp AS cs_end_timestamp,
                   cs.metadata AS cs_metadata
             FROM conversation_messages cm
             JOIN conversation_sessions cs ON cm.session_id = cs.session_id
             WHERE cs.agent_id = ?
        `;
        const params: any[] = [agent_id];

        searchKeywords.forEach((keyword) => {
            query += ` AND LOWER(cm.message_content) LIKE ?`;
            params.push(`%${keyword}%`);
        });

        query += ` ORDER BY cm.timestamp DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const results = await db.all(query, ...params);

        const sessionsMap = new Map<string, ConversationSession>();
        const messages: ConversationMessage[] = [];

        for (const row of results) {
            if (!sessionsMap.has(row.cs_session_id)) {
                const participants = await this.getSessionParticipants(row.cs_session_id);
                sessionsMap.set(row.cs_session_id, {
                    session_id: row.cs_session_id,
                    agent_id: row.cs_agent_id,
                    participants,
                    title: row.cs_title,
                    sequence_number: row.cs_sequence_number,
                    start_timestamp: row.cs_start_timestamp,
                    end_timestamp: row.cs_end_timestamp,
                    metadata: row.cs_metadata ? JSON.parse(row.cs_metadata) : null
                });
            }
            messages.push(this.parseMessageRow(row, false));
        }

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
        console.warn("Semantic search is not fully implemented. Falling back to keyword search.");
        return this.keywordSearchConversations(agent_id, query, limit, offset);
    }

    async getMessageThread(message_id: string): Promise<ConversationMessage[]> {
        const db = this.dbService.getDb();
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
        await db.run(`DELETE FROM session_participants WHERE session_id = ?`, session_id);
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

    // --- Participant Management ---
    async addParticipantToSession(session_id: string, participant_id: string, role: string = 'member'): Promise<void> {
        const db = this.dbService.getDb();
        const join_timestamp = Date.now();
        await db.run(
            `INSERT OR REPLACE INTO session_participants (session_id, participant_id, role, join_timestamp)
             VALUES (?, ?, ?, ?)`,
            session_id, participant_id, role, join_timestamp
        );
    }

    async removeParticipantFromSession(session_id: string, participant_id: string): Promise<void> {
        const db = this.dbService.getDb();
        await db.run(
            `DELETE FROM session_participants WHERE session_id = ? AND participant_id = ?`,
            session_id, participant_id
        );
    }

    async getSessionParticipants(session_id: string): Promise<SessionParticipant[]> {
        const db = this.dbService.getDb();
        return db.all<SessionParticipant[]>(
            `SELECT * FROM session_participants WHERE session_id = ?`,
            session_id
        );
    }
}