import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate, schemas } from '../utils/validation.js';
import { formatObjectToMarkdown } from '../utils/formatters.js';

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
                tool_info: { type: 'string', description: 'JSON string for tool calls/outputs (tool_name, args, result).', nullable: true },
                context_snapshot_id: { type: 'string', description: 'Foreign key to context_information table.', nullable: true },
                source_attribution_id: { type: 'string', description: 'Foreign key to source_attribution table.', nullable: true },
            },
            required: ['agent_id', 'sender', 'message_content'],
        },
    },
    {
        name: 'get_conversation_history',
        description: 'Retrieves conversation history for a given agent and optional conversation ID.',
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
];

export function getConversationToolHandlers(memoryManager: MemoryManager) {
    return {
        'store_conversation_message': async (args: any, agent_id: string) => {
            const validationResult = validate('conversationMessage', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool store_conversation_message: ${JSON.stringify(validationResult.errors)}`
                );
            }
            const convId = await memoryManager.storeConversationMessage(
                agent_id,
                args.user_id as string | null,
                args.sender as string,
                args.message_content as string,
                args.message_type as string,
                args.tool_info as string | null,
                args.context_snapshot_id as string | null,
                args.source_attribution_id as string | null
            );
            return { content: [{ type: 'text', text: `Conversation message stored with ID: ${convId}` }] };
        },
        'get_conversation_history': async (args: any, agent_id: string) => {
            const history = await memoryManager.getConversationHistory(
                agent_id,
                args.conversation_id as string | null,
                args.limit as number,
                args.offset as number
            );
            return { content: [{ type: 'text', text: formatObjectToMarkdown(history) }] };
        },
    };
}
