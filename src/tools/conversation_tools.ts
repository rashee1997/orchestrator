import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate } from '../utils/validation.js';
import { formatSimpleMessage, formatJsonToMarkdownCodeBlock } from '../utils/formatters.js';

export const conversationToolDefinitions = [
    {
        name: 'create_conversation_session',
        description: 'Use this to start a new, distinct conversation thread or topic. It acts as a container for messages and participants, enabling structured, collaborative dialogues.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Your unique agent ID. This is required to associate the session with you as the creator.' },
                title: { type: 'string', description: "A brief, human-readable title for the session, like 'Refactoring the User Service'. Helps in identifying sessions later.", nullable: true },
                metadata: { type: 'object', description: 'A flexible JSON object to store any relevant structured data, such as related task IDs, project names, or session goals.', nullable: true },
                initial_participant_ids: {
                    type: 'array',
                    items: { type: 'string' },
                    description: "A list of other agent or user IDs to immediately include in this collaborative session. Your own agent ID is added automatically as the 'owner'.",
                    nullable: true
                }
            },
            required: ['agent_id'],
        },
    },
    {
        name: 'end_conversation_session',
        description: 'Closes an active conversation session by recording an end timestamp. This is useful for signaling that a task or topic is complete and the conversation is archived.',
        inputSchema: {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'The unique ID of the conversation session to mark as ended.' }
            },
            required: ['session_id'],
        },
    },
    {
        name: 'store_conversation_messages',
        description: 'Use this to save messages to a conversation. You can store your own thoughts, user replies, or system events. It supports saving multiple messages at once for high efficiency.',
        inputSchema: {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'The ID of the session where the messages should be stored.' },
                messages: {
                    type: 'array',
                    description: 'An array of one or more message objects to be saved.',
                    minItems: 1,
                    items: {
                        type: 'object',
                        properties: {
                            sender: { type: 'string', description: "The ID of the message sender. This should be your agent ID, a user's ID, or a system identifier like 'system'." },
                            message_content: { type: 'string', description: 'The complete text content of the message.' },
                            message_type: { type: 'string', description: "Specifies the nature of the message. Common types are 'text', 'tool_call', 'tool_output', 'thought'.", default: 'text' },
                            tool_info: { type: 'object', description: "If message_type is 'tool_call' or 'tool_output', this object should contain details like the tool name, parameters, and result.", nullable: true },
                            parent_message_id: { type: 'string', description: "Set this to the `message_id` of a previous message to create a reply thread. Essential for maintaining conversational context.", nullable: true },
                            metadata: { type: 'object', description: 'A JSON object for extra data, like message sentiment, confidence scores, or source citations.', nullable: true },
                            generate_embedding: { type: 'boolean', description: "If true, an embedding vector will be created for the message, enabling powerful semantic search capabilities later. Use for important messages.", default: false }
                        },
                        required: ['sender', 'message_content'],
                    }
                }
            },
            required: ['session_id', 'messages'],
        },
    },
    {
        name: 'get_conversation_session',
        description: "Fetches the complete details for a single conversation session, including its title, timestamps, and a full list of participants. Use this to get an overview of a specific conversation.",
        inputSchema: {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'The unique ID of the conversation session to retrieve.' }
            },
            required: ['session_id'],
        },
    },
    {
        name: 'get_conversation_sessions',
        description: 'Lists multiple conversation sessions. You can list all sessions you created or filter them to find only those that include a specific user or another agent.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Your agent ID. This scopes the search to sessions you created.' },
                participant_id: { type: 'string', description: 'If provided, the results will be limited to sessions where this user or agent is also a participant.', nullable: true },
                limit: { type: 'number', description: 'The maximum number of sessions to return. Use with `offset` for pagination.', default: 50 },
                offset: { type: 'number', description: 'The number of sessions to skip from the beginning of the list. Use with `limit` for pagination.', default: 0 }
            },
            required: ['agent_id'],
        },
    },
    {
        name: 'get_conversation_messages',
        description: 'Fetches the chronological history of messages within a specific session. This is how you read the content of a conversation. Supports pagination for long conversations.',
        inputSchema: {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'The unique ID of the session from which to retrieve messages.' },
                limit: { type: 'number', description: 'The maximum number of messages to return. Use with `offset` for pagination.', default: 100 },
                offset: { type: 'number', description: 'The number of messages to skip from the beginning of the history. Use with `limit` for pagination.', default: 0 }
            },
            required: ['session_id'],
        },
    },
    {
        name: 'add_participant_to_session',
        description: 'Use this to invite another user or agent into an existing conversation, enabling collaboration.',
        inputSchema: {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'The unique ID of the session to which the participant will be added.' },
                participant_id: { type: 'string', description: 'The unique ID of the user or agent to add as a participant.' },
                role: { type: 'string', description: "The role to assign to the new participant. Defaults to 'member'. Other roles like 'observer' could be used depending on the system's rules.", default: 'member' }
            },
            required: ['session_id', 'participant_id'],
        },
    },
    {
        name: 'get_session_participants',
        description: "Use this to check who is currently a member of a specific conversation before sending messages or sharing information.",
        inputSchema: {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'The unique ID of the session whose participants you want to list.' }
            },
            required: ['session_id'],
        },
    },
    {
        name: 'summarize_conversation',
        description: 'Generates a summary of a specific conversation session.',
        inputSchema: {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'The unique ID of the conversation session to summarize.' }
            },
            required: ['session_id'],
        },
    },
];

// --- Type definitions for tool arguments ---

interface CreateSessionArgs {
    agent_id: string;
    title?: string | null;
    metadata?: any | null;
    initial_participant_ids?: string[];
}

interface EndSessionArgs {
    session_id: string;
}

interface StoreMessagesArgs {
    session_id: string;
    messages: Array<{
        sender: string;
        message_content: string;
        message_type?: string;
        tool_info?: any | null;
        parent_message_id?: string | null;
        metadata?: any | null;
        generate_embedding?: boolean;
    }>;
}

interface GetSessionArgs {
    session_id: string;
}

interface GetSessionsArgs {
    agent_id: string;
    participant_id?: string | null;
    limit?: number;
    offset?: number;
}

interface GetMessagesArgs {
    session_id: string;
    limit?: number;
    offset?: number;
}

interface AddParticipantArgs {
    session_id: string;
    participant_id: string;
    role?: string;
}

interface GetParticipantsArgs {
    session_id: string;
}

// --- Tool Handlers ---

export function getConversationToolHandlers(memoryManager: MemoryManager) {
    return {
        'create_conversation_session': async (args: CreateSessionArgs) => {
            // NOTE: Validation call is removed as we cannot modify the validation schema file.
            // A robust implementation should add a 'createConversationSession' schema.
            const { agent_id, title, metadata, initial_participant_ids } = args;
            const sessionId = await memoryManager.createConversationSession(
                agent_id, title, metadata, initial_participant_ids
            );
            return {
                content: [{
                    type: 'text',
                    text: formatSimpleMessage(`New collaborative session created with ID: \`${sessionId}\``, "💬 Session Started")
                }]
            };
        },

        'end_conversation_session': async (args: EndSessionArgs) => {
            const { session_id } = args;
            await memoryManager.endConversationSession(session_id);
            return {
                content: [{
                    type: 'text',
                    text: formatSimpleMessage(`Session \`${session_id}\` has been successfully closed.`, "💬 Session Ended")
                }]
            };
        },

        'store_conversation_messages': async (args: StoreMessagesArgs) => {
            // NOTE: Validation for bulk messages should be implemented in a 'storeConversationMessages' schema.
            // This is a placeholder for that logic.
            const { session_id, messages } = args;
            const messageIds = await memoryManager.storeConversationMessagesBulk(session_id, messages);
            return {
                content: [{
                    type: 'text',
                    text: formatSimpleMessage(`Successfully stored ${messageIds.length} message(s) in session \`${session_id}\`.`, "📨 Messages Stored")
                }]
            };
        },

        'get_conversation_session': async (args: GetSessionArgs) => {
            const { session_id } = args;
            const session = await memoryManager.getConversationSession(session_id);

            if (!session) {
                return { content: [{ type: 'text', text: formatSimpleMessage(`Session not found: \`${session_id}\`.`, "Not Found") }] };
            }

            let md = `## 💬 Session: ${session.title || `\`${session_id}\``}\n\n`;
            md += `**ID:** \`${session.session_id}\`\n`;
            md += `**Status:** ${session.end_timestamp ? '🔴 Ended' : '🟢 Active'}\n`;
            md += `**Created by:** \`${session.agent_id}\`\n`;
            md += `**Started:** *${new Date(session.start_timestamp).toLocaleString()}*\n`;
            if (session.end_timestamp) {
                md += `**Ended:** *${new Date(session.end_timestamp).toLocaleString()}*\n`;
            }

            md += `\n### 👥 Participants (${session.participants.length})\n`;
            md += session.participants.map(p => `- **${p.participant_id}** (Role: \`${p.role}\`)`).join('\n') + `\n`;
            
            if (session.metadata) {
                md += `\n### 📦 Metadata\n`;
                md += formatJsonToMarkdownCodeBlock(session.metadata);
            }

            return { content: [{ type: 'text', text: md }] };
        },

        'get_conversation_sessions': async (args: GetSessionsArgs) => {
            const { agent_id, participant_id, limit = 50, offset = 0 } = args;
            const sessions = await memoryManager.getConversationSessions(agent_id, participant_id, limit, offset);

            if (!sessions || sessions.length === 0) {
                return { content: [{ type: 'text', text: formatSimpleMessage("No conversation sessions found.", "No Sessions") }] };
            }

            let md = `## 📋 Conversation Sessions\n\n`;
            md += "| Status | Title | Session ID | Participants | Started |\n";
            md += "|:------:|-------|------------|:------------:|---------|\n";
            sessions.forEach(session => {
                const status = session.end_timestamp ? '🔴' : '🟢';
                md += `| ${status} | ${session.title || '*Untitled*'} | \`${session.session_id}\` | ${session.participants.length} | *${new Date(session.start_timestamp).toLocaleDateString()}* |\n`;
            });

            return { content: [{ type: 'text', text: md }] };
        },

        'get_conversation_messages': async (args: GetMessagesArgs) => {
            const { session_id, limit = 100, offset = 0 } = args;
            const messages = await memoryManager.getConversationMessages(session_id, limit, offset, false);

            if (!messages || messages.length === 0) {
                return { content: [{ type: 'text', text: formatSimpleMessage("No messages found in this session.", "No Messages") }] };
            }

            let md = `## 📨 Messages in Session: \`${session_id}\`\n\n`;
            messages.forEach(msg => {
                const senderEmoji = msg.sender === 'user' ? '👤' : (msg.sender === 'ai' ? '🤖' : '⚙️');
                md += `**${senderEmoji} ${msg.sender}** (*${new Date(msg.timestamp).toLocaleString()}*):\n`;
                md += `> ${msg.message_content.replace(/\n/g, '\n> ')}\n`;
                if (msg.parent_message_id) {
                    md += `  - *Reply to: \`${msg.parent_message_id}\`*\n`;
                }
                md += "\n---\n";
            });

            return { content: [{ type: 'text', text: md }] };
        },

        'add_participant_to_session': async (args: AddParticipantArgs) => {
            const { session_id, participant_id, role } = args;
            await memoryManager.addParticipantToSession(session_id, participant_id, role);
            return {
                content: [{
                    type: 'text',
                    text: formatSimpleMessage(`Added \`${participant_id}\` to session \`${session_id}\` with role \`${role || 'member'}\`.`, "👥 Participant Added")
                }]
            };
        },

        'get_session_participants': async (args: GetParticipantsArgs) => {
            const { session_id } = args;
            const participants = await memoryManager.getSessionParticipants(session_id);

            if (!participants || participants.length === 0) {
                return { content: [{ type: 'text', text: formatSimpleMessage("No participants found in this session.", "No Participants") }] };
            }

            let md = `## 👥 Participants in Session: \`${session_id}\`\n\n`;
            participants.forEach(p => {
                md += `- **ID:** \`${p.participant_id}\`\n` +
                    `  - **Role:** \`${p.role}\`\n` +
                    `  - **Joined:** *${new Date(p.join_timestamp).toLocaleString()}*\n`;
            });
            return { content: [{ type: 'text', text: md }] };
        },
        'summarize_conversation': async (args: { session_id: string }) => {
            const { session_id } = args;
            const summary = await memoryManager.summarizeConversation(session_id);
            return {
                content: [{
                    type: 'text',
                    text: formatSimpleMessage(summary, "📜 Conversation Summary")
                }]
            };
        },
    };
}