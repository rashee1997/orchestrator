import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate } from '../utils/validation.js';
import { formatSimpleMessage, formatJsonToMarkdownCodeBlock } from '../utils/formatters.js';

export const conversationToolDefinitions = [
    {
        name: 'create_conversation_session',
        description: 'Creates a new conversation session with optional title and metadata.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                user_id: { type: 'string', description: 'Identifier of the user (optional).' },
                title: { type: 'string', description: 'Optional title for the conversation session.' },
                metadata: { type: 'object', description: 'Optional metadata for the session.' }
            },
            required: ['agent_id'],
        },
    },
    {
        name: 'end_conversation_session',
        description: 'Marks a conversation session as ended by setting its end timestamp.',
        inputSchema: {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'ID of the conversation session to end.' }
            },
            required: ['session_id'],
        },
    },
    {
        name: 'store_conversation_message',
        description: 'Stores a message in an existing conversation session with threading support.',
        inputSchema: {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'ID of the conversation session.' },
                sender: { type: 'string', description: 'Role of the sender (e.g., user, agent, system).' },
                message_content: { type: 'string', description: 'The actual text of the message.' },
                message_type: { type: 'string', description: 'Type of message (e.g., text, image, tool_call, tool_output).', default: 'text' },
                tool_info: { type: 'object', description: 'JSON object for tool calls/outputs.', nullable: true },
                context_snapshot_id: { type: 'string', description: 'Foreign key to context_information table.', nullable: true },
                source_attribution_id: { type: 'string', description: 'Foreign key to source_attribution table.', nullable: true },
                parent_message_id: { type: 'string', description: 'ID of the parent message for threading.', nullable: true },
                metadata: { type: 'object', description: 'Additional metadata for the message.', nullable: true },
                generate_embedding: { type: 'boolean', description: 'Generate embedding for semantic search.', default: false }
            },
            required: ['session_id', 'sender', 'message_content'],
        },
    },
    {
        name: 'get_conversation_session',
        description: 'Retrieves details of a specific conversation session.',
        inputSchema: {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'ID of the conversation session.' }
            },
            required: ['session_id'],
        },
    },
    {
        name: 'get_conversation_sessions',
        description: 'Retrieves conversation sessions for an agent with optional user filtering.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                user_id: { type: 'string', description: 'Optional filter for specific user.' },
                limit: { type: 'number', description: 'Maximum number of sessions to retrieve.', default: 50 },
                offset: { type: 'number', description: 'Offset for pagination.', default: 0 }
            },
            required: ['agent_id'],
        },
    },
    {
        name: 'get_conversation_messages',
        description: 'Retrieves messages from a conversation session with pagination.',
        inputSchema: {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'ID of the conversation session.' },
                limit: { type: 'number', description: 'Maximum number of messages to retrieve.', default: 100 },
                offset: { type: 'number', description: 'Offset for pagination.', default: 0 },
                include_embeddings: { type: 'boolean', description: 'Include message embeddings.', default: false }
            },
            required: ['session_id'],
        },
    },
    {
        name: 'get_message_thread',
        description: 'Retrieves a threaded conversation starting from a specific message.',
        inputSchema: {
            type: 'object',
            properties: {
                message_id: { type: 'string', description: 'ID of the message to start the thread from.' }
            },
            required: ['message_id'],
        },
    },
    {
        name: 'search_conversations',
        description: 'Searches conversations using keyword or semantic search.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                query: { type: 'string', description: 'Search query string.' },
                search_type: { type: 'string', enum: ['keyword', 'semantic'], description: 'Type of search to perform.', default: 'keyword' },
                limit: { type: 'number', description: 'Maximum number of results.', default: 20 },
                offset: { type: 'number', description: 'Offset for pagination.', default: 0 }
            },
            required: ['agent_id', 'query'],
        },
    },
    {
        name: 'summarize_conversation',
        description: 'Generates a summary of a conversation session using Gemini.',
        inputSchema: {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'ID of the conversation session to summarize.' }
            },
            required: ['session_id'],
        },
    }
];

// --- Type definitions for tool arguments ---

interface CreateSessionArgs {
    agent_id: string;
    user_id?: string | null;
    title?: string | null;
    metadata?: any | null;
}

interface EndSessionArgs {
    session_id: string;
}

interface StoreMessageArgs {
    session_id: string;
    sender: string;
    message_content: string;
    message_type?: string;
    tool_info?: any | null;
    context_snapshot_id?: string | null;
    source_attribution_id?: string | null;
    parent_message_id?: string | null;
    metadata?: any | null;
    generate_embedding?: boolean;
}

interface GetSessionArgs {
    session_id: string;
}

interface GetSessionsArgs {
    agent_id: string;
    user_id?: string | null;
    limit?: number;
    offset?: number;
}

interface GetMessagesArgs {
    session_id: string;
    limit?: number;
    offset?: number;
    include_embeddings?: boolean;
}

interface GetMessageThreadArgs {
    message_id: string;
}

interface SearchConversationsArgs {
    agent_id: string;
    query: string;
    search_type?: 'keyword' | 'semantic';
    limit?: number;
    offset?: number;
}

interface SummarizeConversationArgs {
    session_id: string;
}

// --- Tool Handlers ---

export function getConversationToolHandlers(memoryManager: MemoryManager) {
    return {
        /**
         * Creates a new conversation session.
         */
        'create_conversation_session': async (args: CreateSessionArgs) => {
            const validationResult = validate('conversationSession', args); // Assuming a schema for session creation
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`
                );
            }

            const { agent_id, user_id, title, metadata } = args;
            const sessionId = await memoryManager.createConversationSession(
                agent_id, user_id, title, metadata
            );

            return {
                content: [{
                    type: 'text',
                    text: formatSimpleMessage(`Created conversation session with ID: \`${sessionId}\``, "Session Created")
                }]
            };
        },

        /**
         * Marks a conversation session as ended.
         */
        'end_conversation_session': async (args: EndSessionArgs) => {
            const { session_id } = args;
            await memoryManager.endConversationSession(session_id);

            return {
                content: [{
                    type: 'text',
                    text: formatSimpleMessage(`Conversation session \`${session_id}\` has been ended.`, "Session Ended")
                }]
            };
        },

        /**
         * Stores a message in the conversation history within a session.
         */
        'store_conversation_message': async (args: StoreMessageArgs) => {
            const validationResult = validate('conversationMessage', args); // Assuming a schema for message storage
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`
                );
            }

            const {
                session_id, sender, message_content, message_type, tool_info,
                context_snapshot_id, source_attribution_id, parent_message_id,
                metadata, generate_embedding
            } = args;

            const messageId = await memoryManager.storeConversationMessage(
                session_id, sender, message_content, message_type ?? 'text',
                tool_info, context_snapshot_id, source_attribution_id,
                parent_message_id, metadata, generate_embedding ?? false
            );

            return {
                content: [{
                    type: 'text',
                    text: formatSimpleMessage(`Message stored with ID: \`${messageId}\``, "Message Stored")
                }]
            };
        },

        /**
         * Retrieves details of a specific conversation session.
         */
        'get_conversation_session': async (args: GetSessionArgs) => {
            const { session_id } = args;
            const session = await memoryManager.getConversationSession(session_id);

            if (!session) {
                return {
                    content: [{
                        type: 'text',
                        text: formatSimpleMessage(`No conversation session found with ID: \`${session_id}\`.`, "Session Not Found")
                    }]
                };
            }

            const formattedSession = `## Conversation Session: \`${session_id}\`\n\n` +
                `**Agent ID:** \`${session.agent_id}\`\n` +
                `**User ID:** ${session.user_id ? `\`${session.user_id}\`` : 'N/A'}\n` +
                `**Title:** ${session.title || 'N/A'}\n` +
                `**Start Time:** ${new Date(session.start_timestamp).toLocaleString()}\n` +
                `**End Time:** ${session.end_timestamp ? new Date(session.end_timestamp).toLocaleString() : 'Ongoing'}\n` +
                `**Metadata:** ${session.metadata ? formatJsonToMarkdownCodeBlock(session.metadata) : 'N/A'}`;

            return { content: [{ type: 'text', text: formattedSession }] };
        },

        /**
         * Retrieves conversation sessions for an agent.
         */
        'get_conversation_sessions': async (args: GetSessionsArgs) => {
            const { agent_id, user_id, limit = 50, offset = 0 } = args;
            const sessions = await memoryManager.getConversationSessions(agent_id, user_id, limit, offset);

            if (!sessions || sessions.length === 0) {
                return {
                    content: [{
                        type: 'text',
                        text: formatSimpleMessage("No conversation sessions found for the given criteria.", "No Sessions")
                    }]
                };
            }

            let md = `## Conversation Sessions for Agent: \`${agent_id}\`\n\n`;
            if (user_id) {
                md += `**User ID Filter:** \`${user_id}\`\n\n`;
            }

            sessions.forEach(session => {
                md += `### Session: \`${session.session_id}\`\n` +
                    `**Title:** ${session.title || 'N/A'}\n` +
                    `**Start Time:** ${new Date(session.start_timestamp).toLocaleString()}\n` +
                    `**End Time:** ${session.end_timestamp ? new Date(session.end_timestamp).toLocaleString() : 'Ongoing'}\n` +
                    `**User ID:** ${session.user_id ? `\`${session.user_id}\`` : 'N/A'}\n\n`;
            });

            return { content: [{ type: 'text', text: md }] };
        },

        /**
         * Retrieves messages from a conversation session.
         */
        'get_conversation_messages': async (args: GetMessagesArgs) => {
            const { session_id, limit = 100, offset = 0, include_embeddings = false } = args;
            const messages = await memoryManager.getConversationMessages(session_id, limit, offset, include_embeddings);

            if (!messages || messages.length === 0) {
                return {
                    content: [{
                        type: 'text',
                        text: formatSimpleMessage("No messages found in this session.", "No Messages")
                    }]
                };
            }

            let md = `## Messages in Session: \`${session_id}\`\n\n`;

            messages.forEach(msg => {
                md += `**[${new Date(msg.timestamp).toLocaleString()}] ${msg.sender}:**\n`;
                md += `> ${msg.message_content.replace(/\n/g, '\n> ')}\n`;

                if (msg.parent_message_id) {
                    md += `  - *Reply to:* \`${msg.parent_message_id}\`\n`;
                }

                if (msg.message_type && msg.message_type !== 'text') {
                    md += `  - *Type:* ${msg.message_type}\n`;
                }

                if (msg.tool_info) {
                    md += `  - *Tool Info:*\n${formatJsonToMarkdownCodeBlock(msg.tool_info)}\n`;
                }

                if (msg.metadata) {
                    md += `  - *Metadata:*\n${formatJsonToMarkdownCodeBlock(msg.metadata)}\n`;
                }

                if (include_embeddings && msg.embedding) {
                    md += `  - *Embedding:* [${msg.embedding.length} dimensions]\n`;
                }

                md += "\n---\n\n";
            });

            return { content: [{ type: 'text', text: md }] };
        },

        /**
         * Retrieves a threaded conversation starting from a specific message.
         */
        'get_message_thread': async (args: GetMessageThreadArgs) => {
            const { message_id } = args;
            const messages = await memoryManager.getMessageThread(message_id);

            if (!messages || messages.length === 0) {
                return {
                    content: [{
                        type: 'text',
                        text: formatSimpleMessage("No messages found for this thread.", "No Thread")
                    }]
                };
            }

            let md = `## Message Thread Starting from \`${message_id}\`\n\n`;

            messages.forEach(msg => {
                md += `**[${new Date(msg.timestamp).toLocaleString()}] ${msg.sender}:**\n`;
                md += `> ${msg.message_content.replace(/\n/g, '\n> ')}\n`;

                if (msg.parent_message_id) {
                    md += `  - *Reply to:* \`${msg.parent_message_id}\`\n`;
                }

                if (msg.message_type && msg.message_type !== 'text') {
                    md += `  - *Type:* ${msg.message_type}\n`;
                }

                if (msg.tool_info) {
                    md += `  - *Tool Info:*\n${formatJsonToMarkdownCodeBlock(msg.tool_info)}\n`;
                }

                if (msg.metadata) {
                    md += `  - *Metadata:*\n${formatJsonToMarkdownCodeBlock(msg.metadata)}\n`;
                }

                md += "\n---\n\n";
            });

            return { content: [{ type: 'text', text: md }] };
        },

        /**
         * Searches conversations using keyword or semantic search.
         */
        'search_conversations': async (args: SearchConversationsArgs) => {
            const { agent_id, query, search_type = 'keyword', limit = 20, offset = 0 } = args;
            const { sessions, messages } = await memoryManager.searchConversations(
                agent_id, query, limit, offset, search_type
            );

            if ((!sessions || sessions.length === 0) && (!messages || messages.length === 0)) {
                return {
                    content: [{
                        type: 'text',
                        text: formatSimpleMessage("No conversations found matching the query.", "No Results")
                    }]
                };
            }

            let md = `## Search Results for "${query}" (${search_type} search)\n\n`;

            if (sessions.length > 0) {
                md += "### Matching Sessions:\n\n";
                sessions.forEach(session => {
                    md += `- **Session:** \`${session.session_id}\` (${session.title || 'No title'})\n`;
                    md += `  - **Agent:** \`${session.agent_id}\`\n`;
                    md += `  - **User:** ${session.user_id ? `\`${session.user_id}\`` : 'N/A'}\n`;
                    md += `  - **Started:** ${new Date(session.start_timestamp).toLocaleString()}\n\n`;
                });
            }

            if (messages.length > 0) {
                md += "### Matching Messages:\n\n";
                messages.forEach(msg => {
                    md += `- **Message:** \`${msg.message_id}\` in session \`${msg.session_id}\`\n`;
                    md += `  - **Sender:** ${msg.sender}\n`;
                    md += `  - **Time:** ${new Date(msg.timestamp).toLocaleString()}\n`;
                    md += `  - **Content:** ${msg.message_content.substring(0, 100)}${msg.message_content.length > 100 ? '...' : ''}\n\n`;
                });
            }

            return { content: [{ type: 'text', text: md }] };
        },

        /**
         * Generates a summary of a conversation session.
         */
        'summarize_conversation': async (args: SummarizeConversationArgs) => {
            const { session_id } = args;
            const summary = await memoryManager.conversationHistoryManager.summarizeConversation(session_id);

            return {
                content: [{
                    type: 'text',
                    text: `## Conversation Summary for Session: \`${session_id}\`\n\n${summary}`
                }]
            };
        }
    };
}
