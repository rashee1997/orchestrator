import { MemoryManager } from '../database/memory_manager.js';
import { schemas } from '../utils/validation.js';

export const reviewLogToolDefinitions = [
  {
    name: 'create_task_review_log',
    description: 'Creates a detailed review log entry for a specific task. Links to both plan_id and task_id. Use this to record task-specific review notes, feedback, or status updates. Required parameters: plan_id (string), task_id (string), review_content (string).',
    inputSchema: {
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
            plan_id: { type: 'string', description: 'Unique ID of the plan.' },
            task_id: { type: 'string', description: 'Unique ID of the task.' },
            reviewer: { type: 'string', description: 'Name or identifier of the reviewer.' },
            review_status: { type: 'string', description: 'Status of the review (e.g., "PENDING", "APPROVED", "REJECTED").' },
            review_notes_md: { type: 'string', description: 'Review notes in Markdown format.' },
            issues_found_json: { type: 'string', description: 'JSON string detailing issues found.' },
            resolution_notes_md: { type: 'string', description: 'Notes on how issues were resolved in Markdown format.' }
        },
        required: ['agent_id', 'plan_id', 'task_id', 'review_status'],
        additionalProperties: false
    },
    handler: async (input: any) => {
      const mm = await MemoryManager.create();
      const result = await mm.createTaskReviewLog(input);
      return { content: [{ type: "text", text: `Task review log created with ID: ${result.review_log_id}` }] };
    }
  },
  {
    name: 'get_task_review_logs',
    description: 'Retrieves all review logs for specified tasks. Returns formatted Markdown output. Can filter by plan_id, task_id, or date ranges. Useful for generating reports or reviewing task history.',
    inputSchema: {
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
            plan_id: { type: 'string', description: 'Unique ID of the plan.' },
            task_id: { type: 'string', description: 'Unique ID of the task.' },
            review_status: { type: 'string', description: 'Status of the review to filter by.' }
        },
        additionalProperties: false
    },
    handler: async (input: any) => {
      const mm = await MemoryManager.create();
      const result = await mm.getTaskReviewLogs(input);
      return { content: [{ type: "text", text: String(result) }] };
    }
  },
  {
    name: 'update_task_review_log',
    description: 'Modifies an existing task review log entry. Requires review_log_id and can update any field including review_content, status, or metadata. Returns the updated log entry.',
    inputSchema: {
        type: 'object',
        properties: {
            review_log_id: { type: 'string', description: 'Unique ID of the task review log to update.' },
            updates: { type: 'object', description: 'JSON object containing the fields to update.' }
        },
        required: ['review_log_id', 'updates'],
        additionalProperties: false
    },
    handler: async (input: any) => {
      const mm = await MemoryManager.create();
      const result = await mm.updateTaskReviewLog(input.review_log_id, input.updates);
      return { content: [{ type: "text", text: `Task review log ${result.review_log_id} updated successfully.` }] };
    }
  },
  {
    name: 'delete_task_review_log',
    description: 'Permanently removes a task review log entry. Requires review_log_id. Use with caution as this operation cannot be undone. Returns confirmation of deletion.',
    inputSchema: {
        type: 'object',
        properties: {
            review_log_id: { type: 'string', description: 'Unique ID of the task review log to delete.' }
        },
        required: ['review_log_id'],
        additionalProperties: false
    },
    handler: async (input: any) => {
      const mm = await MemoryManager.create();
      const result = await mm.deleteTaskReviewLog(input.review_log_id);
      return { content: [{ type: "text", text: `Task review log with ID ${result.review_log_id} deleted successfully.` }] };
    }
  },
  // Final plan review log tools
  {
    name: 'create_final_plan_review_log',
    description: 'Creates a high-level review log for an entire plan (not task-specific). Links to plan_id only. Use for overall plan reviews, approvals, or final assessments. Required parameters: plan_id (string), review_content (string).',
    inputSchema: {
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
            plan_id: { type: 'string', description: 'Unique ID of the plan.' },
            reviewer: { type: 'string', description: 'Name or identifier of the reviewer.' },
            review_status: { type: 'string', description: 'Status of the review (e.g., "PENDING", "APPROVED", "REJECTED").' },
            review_notes_md: { type: 'string', description: 'Review notes in Markdown format.' },
            issues_found_json: { type: 'string', description: 'JSON string detailing issues found.' },
            resolution_notes_md: { type: 'string', description: 'Notes on how issues were resolved in Markdown format.' }
        },
        required: ['agent_id', 'plan_id', 'review_status'],
        additionalProperties: false
    },
    handler: async (input: any) => {
      const mm = await MemoryManager.create();
      const result = await mm.createFinalPlanReviewLog(input);
      return { content: [{ type: "text", text: `Final plan review log created with ID: ${result.final_review_log_id}` }] };
    }
  },
  {
    name: 'get_final_plan_review_logs',
    description: 'Retrieves all final plan review logs. Returns formatted Markdown output. Can filter by plan_id or date ranges. Useful for auditing or reviewing overall plan assessments.',
    inputSchema: {
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
            plan_id: { type: 'string', description: 'Unique ID of the plan.' },
            review_status: { type: 'string', description: 'Status of the review to filter by.' }
        },
        additionalProperties: false
    },
    handler: async (input: any) => {
      const mm = await MemoryManager.create();
      const result = await mm.getFinalPlanReviewLogs(input);
      return { content: [{ type: "text", text: String(result) }] };
    }
  },
  {
    name: 'update_final_plan_review_log',
    description: 'Modifies an existing final plan review log entry. Requires final_review_log_id and can update review_content, status, or approval fields. Returns the updated log entry.',
    inputSchema: {
        type: 'object',
        properties: {
            final_review_log_id: { type: 'string', description: 'Unique ID of the final plan review log to update.' },
            updates: { type: 'object', description: 'JSON object containing the fields to update.' }
        },
        required: ['final_review_log_id', 'updates'],
        additionalProperties: false
    },
    handler: async (input: any) => {
      const mm = await MemoryManager.create();
      const result = await mm.updateFinalPlanReviewLog(input.final_review_log_id, input.updates);
      return { content: [{ type: "text", text: `Final plan review log ${result.final_review_log_id} updated successfully.` }] };
    }
  },
  {
    name: 'delete_final_plan_review_log',
    description: 'Permanently removes a final plan review log entry. Requires final_review_log_id. Use with caution as this operation cannot be undone. Returns confirmation of deletion.',
    inputSchema: {
        type: 'object',
        properties: {
            final_review_log_id: { type: 'string', description: 'Unique ID of the final plan review log to delete.' }
        },
        required: ['final_review_log_id'],
        additionalProperties: false
    },
    handler: async (input: any) => {
      const mm = await MemoryManager.create();
      const result = await mm.deleteFinalPlanReviewLog(input.final_review_log_id);
      return { content: [{ type: "text", text: `Final plan review log with ID ${result.final_review_log_id} deleted successfully.` }] };
    }
  }
];

export function getReviewLogToolHandlers(memoryManager: MemoryManager) {
  return {
    create_task_review_log: reviewLogToolDefinitions[0].handler,
    get_task_review_logs: reviewLogToolDefinitions[1].handler,
    update_task_review_log: reviewLogToolDefinitions[2].handler,
    delete_task_review_log: reviewLogToolDefinitions[3].handler,
    create_final_plan_review_log: reviewLogToolDefinitions[4].handler,
    get_final_plan_review_logs: reviewLogToolDefinitions[5].handler,
    update_final_plan_review_log: reviewLogToolDefinitions[6].handler,
    delete_final_plan_review_log: reviewLogToolDefinitions[7].handler,
  };
}
