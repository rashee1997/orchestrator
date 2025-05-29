import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate, schemas } from '../utils/validation.js';
import { formatSimpleMessage, formatJsonToMarkdownCodeBlock, formatObjectToMarkdown } from '../utils/formatters.js';

export const successMetricsToolDefinitions = [
    {
        name: 'log_success_metric',
        description: 'Logs quantitative and qualitative metrics related to the AI agent\'s performance. Output is Markdown formatted.',
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
        description: 'Retrieves success metrics for a given agent, optionally filtered by metric name. Output is Markdown formatted.',
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
                    `Validation failed for tool log_success_metric: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`
                );
            }
            const metricId = await memoryManager.logSuccessMetric(
                agent_id,
                args.metric_name as string,
                args.metric_value as number,
                args.unit as string | null,
                args.associated_task_id as string | null,
                args.metadata // Pass as object
            );
            return { content: [{ type: 'text', text: formatSimpleMessage(`Success metric \`${args.metric_name}\` logged with ID: \`${metricId}\``, "Success Metric Logged") }] };
        },
        'get_success_metrics': async (args: any, agent_id: string) => {
            const metrics = await memoryManager.getSuccessMetrics(
                agent_id,
                args.metric_name as string | null,
                args.limit as number,
                args.offset as number
            );
            if (!metrics || metrics.length === 0) {
                return { content: [{ type: 'text', text: formatSimpleMessage("No success metrics found.", "Success Metrics") }] };
            }
            let md = `## Success Metrics for Agent: \`${agent_id}\`\n`;
            if (args.metric_name) md += `### Filtered by Metric Name: \`${args.metric_name}\`\n`;
            
            md += "| Metric ID | Timestamp | Name | Value | Unit | Task ID | Metadata |\n";
            md += "|-----------|-----------|------|-------|------|---------|----------|\n";
            metrics.forEach((metric: any) => {
                md += `| \`${metric.metric_id}\` `
                    + `| ${new Date(metric.timestamp).toLocaleString()} `
                    + `| ${metric.metric_name} `
                    + `| ${metric.metric_value} `
                    + `| ${metric.unit || '*N/A*'} `
                    + `| ${metric.associated_task_id ? `\`${metric.associated_task_id}\`` : '*N/A*'} `
                    + `| ${metric.metadata ? `\`\`\`json\n${JSON.stringify(metric.metadata, null, 2)}\n\`\`\`` : '*N/A*'} |\n`;
            });
            return { content: [{ type: 'text', text: md }] };
        },
    };
}
