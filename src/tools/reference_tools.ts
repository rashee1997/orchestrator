import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate, schemas } from '../utils/validation.js';
import { formatObjectToMarkdown } from '../utils/formatters.js';

export const referenceToolDefinitions = [
    {
        name: 'add_reference_key',
        description: 'Adds a reference key to an external knowledge source or internal memory entry.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                key_type: { type: 'string', description: 'Type of reference (e.g., document_id, memory_entry_id, external_api_id).' },
                key_value: { type: 'string', description: 'The actual key/identifier.' },
                description: { type: 'string', description: 'Human-readable description of what the key references.', nullable: true },
                associated_conversation_id: { type: 'string', description: 'Optional, link to conversation.', nullable: true },
            },
            required: ['agent_id', 'key_type', 'key_value'],
        },
    },
    {
        name: 'get_reference_keys',
        description: 'Retrieves reference keys for a given agent, optionally filtered by key type.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                key_type: { type: 'string', description: 'Optional type of reference to filter by.', nullable: true },
                limit: { type: 'number', description: 'Maximum number of keys to retrieve.', default: 100 },
                offset: { type: 'number', description: 'Offset for pagination.', default: 0 },
            },
            required: ['agent_id'],
        },
    },
];

export function getReferenceToolHandlers(memoryManager: MemoryManager) {
    return {
        'add_reference_key': async (args: any, agent_id: string) => {
            const validationResult = validate('referenceKey', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool add_reference_key: ${JSON.stringify(validationResult.errors)}`
                );
            }
            const refId = await memoryManager.addReferenceKey(
                agent_id,
                args.key_type as string,
                args.key_value as string,
                args.description as string | null,
                args.associated_conversation_id as string | null
            );
            return { content: [{ type: 'text', text: `Reference key added with ID: ${refId}` }] };
        },
        'get_reference_keys': async (args: any, agent_id: string) => {
            const refKeys = await memoryManager.getReferenceKeys(
                agent_id,
                args.key_type as string | null,
                args.limit as number,
                args.offset as number
            );
            return { content: [{ type: 'text', text: formatObjectToMarkdown(refKeys) }] };
        },
    };
}
