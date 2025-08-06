import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate } from '../utils/validation.js';
import { formatSimpleMessage, formatJsonToMarkdownCodeBlock } from '../utils/formatters.js';

export const conversationToolDefinitions = [
    {
        name: 'store_conversation_message',
        description: 'Stores a message in the conversation history.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                user_id: { type: 'string', description: 'Identifier of the user (optional).' },
                sender: { type: 'string', description: 'Role of the sender (e.g., user, agent, system).' },
                message_content: { type: 'string', description: 'The actual text of the message.' },
                message_type: { type: 'string', description: 'Type of message (e.g., text, image, tool_call, tool_output).', default: 'text' },
                tool_info: { type: ['object', 'string'], description: 'JSON object or string for tool calls/outputs (tool_name, args, result).', nullable: true },
                context_snapshot_id: { type: 'string', description: 'Foreign key to context_information table.', nullable: true },
                source_attribution_id: { type: 'string', description: 'Foreign key to source_attribution table.', nullable: true },
            },
            required: ['agent_id', 'sender', 'message_content'],
        },
    },
    {
        name: 'get_conversation_history',
        description: 'Retrieves conversation history for a given agent and optional conversation ID. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                conversation_id: { type: 'string', description: 'Optional unique identifier for a specific conversation.', nullable: true },
                limit: { type: 'number', description: 'Maximum number of messages to retrieve.', default: 100 },
                offset: { type: 'number', description: 'Offset for pagination.', default: 0 },
            },
            required: ['agent_id'],
        },
    },
    {
        name: 'search_conversation_by_keywords',
        description: 'Searches conversation history for specific keywords. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                keywords: { type: 'string', description: 'Keywords to search for within conversation messages (case-insensitive).' },
                limit: { type: 'number', description: 'Maximum number of messages to retrieve.', default: 100 },
                offset: { type: 'number', description: 'Offset for pagination.', default: 0 },
            },
            required: ['agent_id', 'keywords'],
        },
    },
    {
        name: 'summarize_conversation',
        description: 'Generates a summary of conversation history using Gemini. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                conversation_id: { type: 'string', description: 'Optional unique identifier for a specific conversation to summarize.', nullable: true },
                limit: { type: 'number', description: 'Maximum number of messages to retrieve for summarization.', default: 100 },
            },
            required: ['agent_id'],
        },
    },
];

// --- Type definitions for tool arguments ---

interface StoreMessageArgs {
    agent_id: string;
    user_id?: string | null;
    sender: string;
    message_content: string;
    message_type?: string;
    tool_info?: object | string | null;
    context_snapshot_id?: string | null;
    source_attribution_id?: string | null;
}

interface GetHistoryArgs {
    agent_id: string;
    conversation_id?: string | null;
    limit?: number;
    offset?: number;
}

interface SearchArgs {
    agent_id: string;
    keywords: string;
    limit?: number;
    offset?: number;
}

interface SummarizeArgs {
    agent_id: string;
    conversation_id?: string | null;
    limit?: number;
}

// Interface for a message object retrieved from the database
interface ConversationMessageFromDB {
    timestamp: string | Date;
    sender: string;
    message_content: string;
    message_type: string;
    tool_info?: string | object | null;
    context_snapshot_id?: string | null;
    source_attribution_id?: string | null;
}

// --- Helper Functions ---

/**
 * Formats a single conversation message into a Markdown string.
 * @param msg The conversation message object.
 * @param isSearchResult If true, formats with less detail for search results.
 * @returns A formatted Markdown string.
 */
function formatMessageToMarkdown(msg: ConversationMessageFromDB, isSearchResult: boolean = false): string {
    let md = `**[${new Date(msg.timestamp).toLocaleString()}] ${msg.sender}:**\n`;
    md += `> ${msg.message_content.replace(/\n/g, '\n> ')}\n`;

    if (msg.message_type !== 'text') {
        md += `  - *Type:* ${msg.message_type}\n`;
    }

    if (!isSearchResult) {
        if (msg.tool_info) {
            const toolInfoObject = typeof msg.tool_info === 'string'
                ? JSON.parse(msg.tool_info)
                : msg.tool_info;
            md += `  - *Tool Info:*\n${formatJsonToMarkdownCodeBlock(toolInfoObject)}\n`;
        }
        if (msg.context_snapshot_id) {
            md += `  - *Context Snapshot ID:* \`${msg.context_snapshot_id}\`\n`;
        }
        if (msg.source_attribution_id) {
            md += `  - *Source Attribution ID:* \`${msg.source_attribution_id}\`\n`;
        }
    }

    md += "\n---\n\n";
    return md;
}


// --- Tool Handlers ---

export function getConversationToolHandlers(memoryManager: MemoryManager) {
    return {
        /**
         * Stores a message in the conversation history.
         */
        'store_conversation_message': async (args: StoreMessageArgs) => {
            const validationResult = validate('conversationMessage', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool store_conversation_message: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`
                );
            }

            const {
                agent_id,
                user_id,
                sender,
                message_content,
                message_type,
                tool_info,
                context_snapshot_id,
                source_attribution_id
            } = args;

            const toolInfoString = (tool_info && typeof tool_info === 'object')
                ? JSON.stringify(tool_info)
                : tool_info as string | null;

            const convId = await memoryManager.storeConversationMessage(
                agent_id,
                user_id ?? null,
                sender,
                message_content,
                message_type ?? 'text', // Apply default if not provided
                toolInfoString,
                context_snapshot_id ?? null,
                source_attribution_id ?? null
            );
            return { content: [{ type: 'text', text: formatSimpleMessage(`Conversation message stored with ID: \`${convId}\``, "Message Stored") }] };
        },

        /**
         * Retrieves and formats conversation history.
         */
        'get_conversation_history': async (args: GetHistoryArgs) => {
            const { agent_id, conversation_id, limit = 100, offset = 0 } = args;

            const history: ConversationMessageFromDB[] = await memoryManager.getConversationHistory(
                agent_id,
                conversation_id ?? null,
                limit,
                offset
            );

            if (!history || history.length === 0) {
                return { content: [{ type: 'text', text: formatSimpleMessage("No conversation history found for the given criteria.", "Conversation History") }] };
            }

            let md = `## Conversation History for Agent: \`${agent_id}\`\n`;
            if (conversation_id) {
                md += `### Conversation ID: \`${conversation_id}\`\n\n`;
            }

            md += history.map(msg => formatMessageToMarkdown(msg, false)).join('');

            return { content: [{ type: 'text', text: md }] };
        },

        /**
         * Searches conversation history and formats the results.
         */
        'search_conversation_by_keywords': async (args: SearchArgs) => {
            const { agent_id, keywords, limit = 100, offset = 0 } = args;

            const results: ConversationMessageFromDB[] = await memoryManager.searchConversationByKeywords(
                agent_id,
                keywords,
                limit,
                offset
            );

            if (!results || results.length === 0) {
                return { content: [{ type: 'text', text: formatSimpleMessage("No conversations found matching the keywords.", "Search Results") }] };
            }

            let md = `## Conversation Search Results for Agent: \`${agent_id}\`\n`;
            md += `### Search Keywords: \`${keywords}\`\n\n`;

            md += results.map(msg => formatMessageToMarkdown(msg, true)).join('');

            return { content: [{ type: 'text', text: md }] };
        },

        /**
         * Generates a summary of a conversation.
         */
        'summarize_conversation': async (args: SummarizeArgs) => {
            const { agent_id, conversation_id, limit = 100 } = args;

            const summary = await memoryManager.summarizeConversation(
                agent_id,
                conversation_id ?? null,
                limit
            );
            return { content: [{ type: 'text', text: `## Conversation Summary\n\n${summary}` }] };
        },
    };
}