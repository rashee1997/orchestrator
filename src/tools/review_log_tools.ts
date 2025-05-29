import { MemoryManager } from '../database/memory_manager.js';
import { schemas } from '../utils/validation.js'; // Import central schemas
import { formatSimpleMessage, formatJsonToMarkdownCodeBlock } from '../utils/formatters.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';


function formatReviewLogToMarkdown(log: any, logType: 'Task' | 'Final Plan'): string {
    if (!log) return `*No ${logType.toLowerCase()} review log details provided.*\n`;
    const idField = logType === 'Task' ? 'review_log_id' : 'final_review_log_id';

    let md = `## ${logType} Review Log (ID: \`${log[idField]}\`)\n`;
    md += `- **Agent ID:** \`${log.agent_id}\`\n`;
    md += `- **Plan ID:** \`${log.plan_id}\`\n`;
    if (logType === 'Task' && log.task_id) {
        md += `- **Task ID:** \`${log.task_id}\`\n`;
    }
    md += `- **Reviewer:** ${log.reviewer || '*N/A*'}\n`;
    md += `- **Status:** ${log.review_status}\n`;
    md += `- **Timestamp:** ${new Date(log.review_timestamp_iso).toLocaleString()}\n`;
    if (log.review_notes_md) {
        md += `### Review Notes:\n${log.review_notes_md}\n`; // Assume notes are already Markdown
    }
    if (log.issues_found_json && log.issues_found_json !== '[]') {
        md += `### Issues Found:\n${formatJsonToMarkdownCodeBlock(log.issues_found_json)}\n`;
    }
    if (log.resolution_notes_md) {
        md += `### Resolution Notes:\n${log.resolution_notes_md}\n`; // Assume notes are already Markdown
    }
    md += `- **Last Updated:** ${new Date(log.last_updated_timestamp_iso).toLocaleString()}\n`;
    return md;
}


export const reviewLogToolDefinitions = [
  {
    name: 'create_task_review_log',
    description: 'Creates a detailed review log entry for a specific task. Output is Markdown formatted.',
    inputSchema: schemas.create_task_review_log, // Use central schema
    handler: async (input: any, memoryManager: MemoryManager) => {
      const result = await memoryManager.createTaskReviewLog(input);
      return { content: [{ type: "text", text: formatSimpleMessage(`Task review log created with ID: \`${result.review_log_id}\``, "Task Review Log Created") }] };
    }
  },
  {
    name: 'get_task_review_logs',
    description: 'Retrieves all review logs for specified tasks. Returns formatted Markdown output.',
    inputSchema: schemas.get_task_review_logs, // Use central schema
    handler: async (input: any, memoryManager: MemoryManager) => {
      const logs = await memoryManager.getTaskReviewLogs(input);
      if (!logs || (typeof logs === 'string' && logs.toLowerCase().includes("no task review logs found"))) {
           return { content: [{ type: "text", text: formatSimpleMessage("No task review logs found for the given criteria.", "Task Review Logs") }] };
      }
      let mdOutput = `## Task Review Logs\n\n`;
      if (input.plan_id) mdOutput += `**Plan ID Filter:** \`${input.plan_id}\`\n`;
      if (input.task_id) mdOutput += `**Task ID Filter:** \`${input.task_id}\`\n`;
      if (input.agent_id) mdOutput += `**Agent ID Filter:** \`${input.agent_id}\`\n`;
      if (input.review_status) mdOutput += `**Status Filter:** \`${input.review_status}\`\n\n`;
      
      mdOutput += logs; 
      return { content: [{ type: "text", text: mdOutput }] };
    }
  },
  {
    name: 'update_task_review_log',
    description: 'Modifies an existing task review log entry. Output is Markdown formatted.',
    inputSchema: schemas.update_task_review_log, // Use central schema
    handler: async (input: any, memoryManager: MemoryManager) => {
      const result = await memoryManager.updateTaskReviewLog(input.review_log_id, input.updates);
      return { content: [{ type: "text", text: formatSimpleMessage(`Task review log \`${result.review_log_id}\` updated successfully.`, "Task Review Log Updated") }] };
    }
  },
  {
    name: 'delete_task_review_log',
    description: 'Permanently removes a task review log entry. Output is Markdown formatted.',
    inputSchema: schemas.delete_task_review_log, // Use central schema
    handler: async (input: any, memoryManager: MemoryManager) => {
      const result = await memoryManager.deleteTaskReviewLog(input.review_log_id);
      return { content: [{ type: "text", text: formatSimpleMessage(`Task review log with ID \`${result.review_log_id}\` deleted successfully.`, "Task Review Log Deleted") }] };
    }
  },
  // Final plan review log tools
  {
    name: 'create_final_plan_review_log',
    description: 'Creates a high-level review log for an entire plan. Output is Markdown formatted.',
    inputSchema: schemas.create_final_plan_review_log, // Use central schema
    handler: async (input: any, memoryManager: MemoryManager) => {
      const result = await memoryManager.createFinalPlanReviewLog(input);
      return { content: [{ type: "text", text: formatSimpleMessage(`Final plan review log created with ID: \`${result.final_review_log_id}\``, "Final Plan Review Log Created") }] };
    }
  },
  {
    name: 'get_final_plan_review_logs',
    description: 'Retrieves all final plan review logs. Returns formatted Markdown output.',
    inputSchema: schemas.get_final_plan_review_logs, // Use central schema
    handler: async (input: any, memoryManager: MemoryManager) => {
      const logs = await memoryManager.getFinalPlanReviewLogs(input);
      if (!logs || (typeof logs === 'string' && logs.toLowerCase().includes("no final plan review logs found"))) {
           return { content: [{ type: "text", text: formatSimpleMessage("No final plan review logs found for the given criteria.", "Final Plan Review Logs") }] };
      }
      let mdOutput = `## Final Plan Review Logs\n\n`;
      if (input.plan_id) mdOutput += `**Plan ID Filter:** \`${input.plan_id}\`\n`;
      if (input.agent_id) mdOutput += `**Agent ID Filter:** \`${input.agent_id}\`\n`;
      if (input.review_status) mdOutput += `**Status Filter:** \`${input.review_status}\`\n\n`;
      mdOutput += logs; 
      return { content: [{ type: "text", text: mdOutput }] };
    }
  },
  {
    name: 'update_final_plan_review_log',
    description: 'Modifies an existing final plan review log entry. Output is Markdown formatted.',
    inputSchema: schemas.update_final_plan_review_log, // Use central schema
    handler: async (input: any, memoryManager: MemoryManager) => {
      const result = await memoryManager.updateFinalPlanReviewLog(input.final_review_log_id, input.updates);
      return { content: [{ type: "text", text: formatSimpleMessage(`Final plan review log \`${result.final_review_log_id}\` updated successfully.`, "Final Plan Review Log Updated") }] };
    }
  },
  {
    name: 'delete_final_plan_review_log',
    description: 'Permanently removes a final plan review log entry. Output is Markdown formatted.',
    inputSchema: schemas.delete_final_plan_review_log, // Use central schema
    handler: async (input: any, memoryManager: MemoryManager) => {
      const result = await memoryManager.deleteFinalPlanReviewLog(input.final_review_log_id);
      return { content: [{ type: "text", text: formatSimpleMessage(`Final plan review log with ID \`${result.final_review_log_id}\` deleted successfully.`, "Final Plan Review Log Deleted") }] };
    }
  }
];

export function getReviewLogToolHandlers(memoryManager: MemoryManager) {
  const handlers: { [key: string]: Function } = {};
  reviewLogToolDefinitions.forEach(def => {
    handlers[def.name] = (args: any, agent_id_from_server?: string) => {
        // The agent_id is part of the inputSchema for create operations,
        // and for get operations, it's also part of the schema.
        // The handler itself will use args.agent_id.
        // agent_id_from_server is a fallback if not provided in args, but schema should enforce it.
        if (!args.agent_id && !agent_id_from_server && (def.name.startsWith('create_') || def.name.startsWith('get_'))) {
            // This check might be redundant if schema validation catches it.
            // throw new McpError(ErrorCode.InvalidParams, `agent_id is required for ${def.name}`);
        }
        return def.handler(args, memoryManager);
    };
  });
  return handlers;
}
