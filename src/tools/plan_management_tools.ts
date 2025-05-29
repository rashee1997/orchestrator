import { MemoryManager } from '../database/memory_manager.js';
// SubtaskManager is accessed via memoryManager.subtaskManager
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate, schemas } from '../utils/validation.js';
import { 
    formatPlanToMarkdown, 
    formatTasksListToMarkdownTable, 
    formatPlansListToMarkdownTable, 
    formatSubtasksListToMarkdownTable,
    formatSimpleMessage,
    formatJsonToMarkdownCodeBlock
} from '../utils/formatters.js';

export const planManagementToolDefinitions = [
    {
        name: 'create_task_plan',
        description: 'Creates a new task plan with its initial set of tasks. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: schemas.createTaskPlan, // Using schema from validation.ts
    },
    {
        name: 'get_task_plan_details',
        description: 'Retrieves details for a specific task plan, including its tasks and subtasks. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: schemas.getTaskPlanDetails,
    },
    {
        name: 'list_task_plans',
        description: 'Lists task plans for an agent, optionally filtered by status. This tool strictly requires the agent_id parameter. Output is Markdown formatted as a table.',
        inputSchema: schemas.listTaskPlans,
    },
    {
        name: 'get_plan_tasks',
        description: 'Retrieves tasks for a specific plan, optionally filtered by status, including their subtasks. This tool strictly requires the agent_id parameter. Output is Markdown formatted as a table.',
        inputSchema: schemas.getPlanTasks,
    },
    {
        name: 'update_task_plan_status',
        description: 'Updates the status of a specified task plan. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: schemas.updateTaskPlanStatus,
    },
    {
        name: 'update_plan_task_status',
        description: 'Updates the status of a specific task within a plan. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: schemas.updatePlanTaskStatus,
    },
    {
        name: 'delete_task_plan',
        description: 'Deletes a task plan and all its associated tasks. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: schemas.deleteTaskPlan,
    },
    {
        name: 'add_task_to_plan',
        description: 'Adds a new task to an existing plan. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: schemas.addTaskToPlan,
    },
    {
        name: 'add_subtask_to_plan',
        description: 'Adds a new subtask to an existing plan, optionally linked to a parent task. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: schemas.addSubtaskToPlan,
    },
    {
        name: 'get_subtasks',
        description: 'Retrieves subtasks for a given plan or parent task, optionally filtered by status. This tool strictly requires the agent_id parameter. Output is Markdown formatted as a table.',
        inputSchema: schemas.getSubtasks,
    },
    {
        name: 'update_subtask_status',
        description: 'Updates the status of a specific subtask. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: schemas.updateSubtaskStatus,
    },
    {
        name: 'delete_subtask',
        description: 'Deletes a subtask. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: schemas.deleteSubtask,
    },
];

export function getPlanManagementToolHandlers(memoryManager: MemoryManager) {
    return {
        'create_task_plan': async (args: any, agent_id: string) => {
            const validationResult = validate('createTaskPlan', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }
            const planResult = await memoryManager.createPlanWithTasks(agent_id, args.planData, args.tasksData);
            let md = `## Task Plan Created for Agent: \`${agent_id}\`\n`;
            md += `- **Plan ID:** \`${planResult.plan_id}\`\n`;
            md += `- **Task IDs Created:** ${planResult.task_ids.map(id => `\`${id}\``).join(', ')}\n`;
            return { content: [{ type: 'text', text: md }] };
        },
        'get_task_plan_details': async (args: any, agent_id: string) => {
            const validationResult = validate('getTaskPlanDetails', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }
            const planDetails = await memoryManager.getPlan(agent_id, args.plan_id);
            if (!planDetails) {
                return { content: [{ type: 'text', text: formatSimpleMessage(`Plan with ID \`${args.plan_id}\` not found for agent \`${agent_id}\`.`, "Plan Not Found") }] };
            }
            const tasks = await memoryManager.getPlanTasks(agent_id, args.plan_id);
            for (const task of tasks as any[]) {
                task.subtasks = await memoryManager.subtaskManager.getSubtasksByParentTask(agent_id, task.task_id);
            }
            let planLevelSubtasks = await memoryManager.subtaskManager.getSubtasksByPlan(agent_id, args.plan_id);
            planLevelSubtasks = planLevelSubtasks.filter((subtask: any) => !subtask.parent_task_id);
            
            return { content: [{ type: 'text', text: formatPlanToMarkdown(planDetails, tasks as any[], planLevelSubtasks as any[]) }] };
        },
        'list_task_plans': async (args: any, agent_id: string) => {
            const validationResult = validate('listTaskPlans', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }
            const plans = await memoryManager.getPlans(agent_id, args.status_filter, args.limit, args.offset);
            plans.sort((a: any, b: any) => (b.creation_timestamp_unix || 0) - (a.creation_timestamp_unix || 0) );
            let title = `Task Plans for Agent: \`${agent_id}\``;
            if(args.status_filter) title += ` (Status: ${args.status_filter})`;
            return { content: [{ type: 'text', text: `## ${title}\n\n${formatPlansListToMarkdownTable(plans as any[])}` }] };
        },
        'get_plan_tasks': async (args: any, agent_id: string) => {
            const validationResult = validate('getPlanTasks', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }
            const tasks = await memoryManager.getPlanTasks(agent_id, args.plan_id, args.status_filter, args.limit, args.offset);
            for (const task of tasks as any[]) {
                task.subtasks = await memoryManager.subtaskManager.getSubtasksByParentTask(agent_id, task.task_id, args.status_filter);
            }
            let title = `Tasks for Plan: \`${args.plan_id}\` (Agent: \`${agent_id}\`)`;
            if(args.status_filter) title += ` (Status: ${args.status_filter})`;
            return { content: [{ type: 'text', text: `## ${title}\n\n${formatTasksListToMarkdownTable(tasks as any[], true)}` }] };
        },
        'update_task_plan_status': async (args: any, agent_id: string) => {
            const validationResult = validate('updateTaskPlanStatus', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }
            const success = await memoryManager.updatePlanStatus(agent_id, args.plan_id, args.new_status);
            const message = success ? `Plan \`${args.plan_id}\` status updated to \`${args.new_status}\`.` : `Failed to update status for plan \`${args.plan_id}\`.`;
            return { content: [{ type: 'text', text: formatSimpleMessage(message, "Update Plan Status") }] };
        },
        'update_plan_task_status': async (args: any, agent_id: string) => {
            const validationResult = validate('updatePlanTaskStatus', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }
            const success = await memoryManager.updateTaskStatus(agent_id, args.task_id, args.new_status, args.completion_timestamp);
            const message = success ? `Task \`${args.task_id}\` status updated to \`${args.new_status}\`.` : `Failed to update status for task \`${args.task_id}\`.`;
            return { content: [{ type: 'text', text: formatSimpleMessage(message, "Update Task Status") }] };
        },
        'delete_task_plan': async (args: any, agent_id: string) => {
            const validationResult = validate('deleteTaskPlan', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }
            const success = await memoryManager.deletePlan(agent_id, args.plan_id);
            const message = success ? `Plan \`${args.plan_id}\` and its tasks/subtasks deleted.` : `Failed to delete plan \`${args.plan_id}\`.`;
            return { content: [{ type: 'text', text: formatSimpleMessage(message, "Delete Plan") }] };
        },
        'add_task_to_plan': async (args: any, agent_id: string) => {
            const validationResult = validate('addTaskToPlan', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }
            const task_id = await memoryManager.addTaskToPlan(agent_id, args.plan_id, args.taskData);
            return { content: [{ type: 'text', text: formatSimpleMessage(`Task added to plan \`${args.plan_id}\` with ID: \`${task_id}\``, "Task Added") }] };
        },
        'add_subtask_to_plan': async (args: any, agent_id: string) => {
            const validationResult = validate('addSubtaskToPlan', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }
            const subtask_id = await memoryManager.subtaskManager.createSubtask(agent_id, args.plan_id, { ...args.subtaskData, parent_task_id: args.parent_task_id });
            let message = `Subtask added to plan \`${args.plan_id}\` with ID: \`${subtask_id}\`.`;
            if(args.parent_task_id) message += ` Parent task ID: \`${args.parent_task_id}\`.`;
            return { content: [{ type: 'text', text: formatSimpleMessage(message, "Subtask Added") }] };
        },
        'get_subtasks': async (args: any, agent_id: string) => {
            const validationResult = validate('getSubtasks', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }
            let subtasks;
            let title = `Subtasks for Agent: \`${agent_id}\``;

            if (args.plan_id && args.parent_task_id) {
                subtasks = await memoryManager.subtaskManager.getSubtasksByPlanAndParentTask(agent_id, args.plan_id, args.parent_task_id, args.status_filter, args.limit, args.offset);
                title += ` (Plan: \`${args.plan_id}\`, Parent Task: \`${args.parent_task_id}\`)`;
            } else if (args.plan_id) {
                subtasks = await memoryManager.subtaskManager.getSubtasksByPlan(agent_id, args.plan_id, args.status_filter, args.limit, args.offset);
                title += ` (Plan: \`${args.plan_id}\`)`;
            } else if (args.parent_task_id) {
                subtasks = await memoryManager.subtaskManager.getSubtasksByParentTask(agent_id, args.parent_task_id, args.status_filter, args.limit, args.offset);
                 title += ` (Parent Task: \`${args.parent_task_id}\`)`;
            } else {
                throw new McpError(ErrorCode.InvalidParams, "Either plan_id or parent_task_id must be provided for get_subtasks.");
            }
            if(args.status_filter) title += ` (Status: ${args.status_filter})`;
            return { content: [{ type: 'text', text: `## ${title}\n\n${formatSubtasksListToMarkdownTable(subtasks as any[])}` }] };
        },
        'update_subtask_status': async (args: any, agent_id: string) => {
            const validationResult = validate('updateSubtaskStatus', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }
            const success = await memoryManager.subtaskManager.updateSubtaskStatus(agent_id, args.subtask_id, args.new_status, args.completion_timestamp);
            const message = success ? `Subtask \`${args.subtask_id}\` status updated to \`${args.new_status}\`.` : `Failed to update status for subtask \`${args.subtask_id}\`.`;
            return { content: [{ type: 'text', text: formatSimpleMessage(message, "Update Subtask Status") }] };
        },
        'delete_subtask': async (args: any, agent_id: string) => {
            const validationResult = validate('deleteSubtask', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }
            const success = await memoryManager.subtaskManager.deleteSubtask(agent_id, args.subtask_id);
            const message = success ? `Subtask \`${args.subtask_id}\` deleted.` : `Failed to delete subtask \`${args.subtask_id}\`.`;
            return { content: [{ type: 'text', text: formatSimpleMessage(message, "Delete Subtask") }] };
        },
    };
}
