import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate, schemas } from '../utils/validation.js';
import { formatObjectToMarkdown } from '../utils/formatters.js';

export const successMetricsToolDefinitions = [
    {
        name: 'log_success_metric',
        description: 'Logs quantitative and qualitative metrics related to the AI agent\'s performance.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                metric_name: { type: 'string', description: 'Name of the metric (e.g., task_completion_rate, response_latency_ms).' },
                metric_value: { type: 'number', description: 'The numerical value of the metric.' },
                unit: { type: 'string', description: 'Unit of the metric (e.g., percent, ms, score).', nullable: true },
                associated_task_id: { type: 'string', description: 'Optional, link to a specific task.', nullable: true },
                metadata: { type: 'object', description: 'JSON object for additional metric-specific data.', nullable: true },
            },
            required: ['agent_id', 'metric_name', 'metric_value'],
        },
    },
    {
        name: 'get_success_metrics',
        description: 'Retrieves success metrics for a given agent, optionally filtered by metric name.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                metric_name: { type: 'string', description: 'Optional name of the metric to filter by.', nullable: true },
                limit: { type: 'number', description: 'Maximum number of metrics to retrieve.', default: 100 },
                offset: { type: 'number', description: 'Offset for pagination.', default: 0 },
            },
            required: ['agent_id'],
        },
    },
];

export function getSuccessMetricsToolHandlers(memoryManager: MemoryManager) {
    return {
        'log_success_metric': async (args: any, agent_id: string) => {
            const validationResult = validate('successMetric', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool log_success_metric: ${JSON.stringify(validationResult.errors)}`
                );
            }
            const metricId = await memoryManager.logSuccessMetric(
                agent_id,
                args.metric_name as string,
                args.metric_value as number,
                args.unit as string | null,
                args.associated_task_id as string | null,
                args.metadata
            );
            return { content: [{ type: 'text', text: `Success metric logged with ID: ${metricId}` }] };
        },
        'get_success_metrics': async (args: any, agent_id: string) => {
            const metrics = await memoryManager.getSuccessMetrics(
                agent_id,
                args.metric_name as string | null,
                args.limit as number,
                args.offset as number
            );
            return { content: [{ type: 'text', text: formatObjectToMarkdown(metrics) }] };
        },
    };
}
