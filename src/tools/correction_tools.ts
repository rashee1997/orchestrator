import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate, schemas } from '../utils/validation.js';
import { formatObjectToMarkdown } from '../utils/formatters.js';

export const correctionToolDefinitions = [
    {
        name: 'log_correction',
        description: 'Records instances where the AI agent\'s output or internal state was corrected.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                correction_type: { type: 'string', description: 'Type of correction (e.g., user_feedback, self_correction, system_override).' },
                original_entry_id: { type: 'string', description: 'ID of the memory entry that was corrected (e.g., conversation_id, context_id).', nullable: true },
                original_value: { type: 'object', description: 'JSON object of the original data before correction.', nullable: true },
                corrected_value: { type: 'object', description: 'JSON object of the corrected data.', nullable: true },
                reason: { type: 'string', description: 'Explanation for the correction.', nullable: true },
                applied_automatically: { type: 'boolean', description: 'True if applied by system, false if manual.' },
            },
            required: ['agent_id', 'correction_type', 'applied_automatically'],
        },
    },
    {
        name: 'get_correction_logs',
        description: 'Retrieves correction logs for a given agent, optionally filtered by correction type.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                correction_type: { type: 'string', description: 'Optional type of correction to filter by.', nullable: true },
                limit: { type: 'number', description: 'Maximum number of logs to retrieve.', default: 100 },
                offset: { type: 'number', description: 'Offset for pagination.', default: 0 },
            },
            required: ['agent_id'],
        },
    },
];

export function getCorrectionToolHandlers(memoryManager: MemoryManager) {
    return {
        'log_correction': async (args: any, agent_id: string) => {
            const validationResult = validate('correctionLog', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool log_correction: ${JSON.stringify(validationResult.errors)}`
                );
            }
            const corrId = await memoryManager.logCorrection(
                agent_id,
                args.correction_type as string,
                args.original_entry_id as string | null,
                args.original_value,
                args.corrected_value,
                args.reason as string | null,
                args.applied_automatically as boolean
            );
            return { content: [{ type: 'text', text: `Correction logged with ID: ${corrId}` }] };
        },
        'get_correction_logs': async (args: any, agent_id: string) => {
            const corrections = await memoryManager.getCorrectionLogs(
                agent_id,
                args.correction_type as string | null,
                args.limit as number,
                args.offset as number
            );
            return { content: [{ type: 'text', text: formatObjectToMarkdown(corrections) }] };
        },
    };
}
