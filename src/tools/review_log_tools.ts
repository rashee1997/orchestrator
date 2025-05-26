import { MemoryManager } from '../database/memory_manager.js';
import { schemas } from '../utils/validation.js';

export const reviewLogToolDefinitions = [
  {
    name: 'create_task_review_log',
    description: 'Create a new task review log entry (linked to plan_id and task_id).',
    inputSchema: schemas.create_task_review_log,
    handler: async (input: any) => {
      const mm = await MemoryManager.create();
      const result = await mm.createTaskReviewLog(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  },
  {
    name: 'get_task_review_logs',
    description: 'Get task review logs (Markdown output).',
    inputSchema: schemas.get_task_review_logs,
    handler: async (input: any) => {
      const mm = await MemoryManager.create();
      const result = await mm.getTaskReviewLogs(input);
      return { content: [{ type: "text", text: String(result) }] };
    }
  },
  {
    name: 'update_task_review_log',
    description: 'Update a task review log entry.',
    inputSchema: schemas.update_task_review_log,
    handler: async (input: any) => {
      const mm = await MemoryManager.create();
      const result = await mm.updateTaskReviewLog(input.review_log_id, input.updates);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  },
  {
    name: 'delete_task_review_log',
    description: 'Delete a task review log entry.',
    inputSchema: schemas.delete_task_review_log,
    handler: async (input: any) => {
      const mm = await MemoryManager.create();
      const result = await mm.deleteTaskReviewLog(input.review_log_id);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  },
  // Final plan review log tools
  {
    name: 'create_final_plan_review_log',
    description: 'Create a new final plan review log entry (linked to plan_id only).',
    inputSchema: schemas.create_final_plan_review_log,
    handler: async (input: any) => {
      const mm = await MemoryManager.create();
      const result = await mm.createFinalPlanReviewLog(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  },
  {
    name: 'get_final_plan_review_logs',
    description: 'Get final plan review logs (Markdown output).',
    inputSchema: schemas.get_final_plan_review_logs,
    handler: async (input: any) => {
      const mm = await MemoryManager.create();
      const result = await mm.getFinalPlanReviewLogs(input);
      return { content: [{ type: "text", text: String(result) }] };
    }
  },
  {
    name: 'update_final_plan_review_log',
    description: 'Update a final plan review log entry.',
    inputSchema: schemas.update_final_plan_review_log,
    handler: async (input: any) => {
      const mm = await MemoryManager.create();
      const result = await mm.updateFinalPlanReviewLog(input.final_review_log_id, input.updates);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  },
  {
    name: 'delete_final_plan_review_log',
    description: 'Delete a final plan review log entry.',
    inputSchema: schemas.delete_final_plan_review_log,
    handler: async (input: any) => {
      const mm = await MemoryManager.create();
      const result = await mm.deleteFinalPlanReviewLog(input.final_review_log_id);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
