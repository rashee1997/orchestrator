import { MemoryManager } from '../database/memory_manager.js';
import { SubtaskManager } from '../database/managers/SubtaskManager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate, schemas } from '../utils/validation.js';
import { formatPlanToMarkdown, formatTasksListToMarkdownTable, formatPlansListToMarkdownTable, formatSubtasksListToMarkdownTable } from '../utils/formatters.js';

export const planManagementToolDefinitions = [
    {
        name: 'create_task_plan',
        description: 'Creates a new task plan with its initial set of tasks. This tool strictly requires the agent_id parameter.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                planData: {
                    type: 'object',
                    properties: {
                        title: { type: 'string' },
                        overall_goal: { type: ['string', 'null'] },
                        status: { type: 'string' },
                        version: { type: 'number' },
                        refined_prompt_id_associated: { type: ['string', 'null'] },
                        analysis_report_id_referenced: { type: ['string', 'null'] },
                        metadata: { type: ['object', 'null'] }
                    },
                    required: ['title'],
                    additionalProperties: false
                },
                tasksData: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            task_number: { type: 'number' },
                            title: { type: 'string' },
                            description: { type: ['string', 'null'] },
                            status: { type: 'string' },
                            purpose: { type: ['string', 'null'] },
                            action_description: { type: ['string', 'null'] },
                            files_involved: { type: ['array', 'null'], items: { type: 'string' } },
                            dependencies_task_ids: { type: ['array', 'null'], items: { type: 'string' } },
                            tools_required_list: { type: ['array', 'null'], items: { type: 'string' } },
                            inputs_summary: { type: ['string', 'null'] },
                            outputs_summary: { type: ['string', 'null'] },
                            success_criteria_text: { type: ['string', 'null'] },
                            estimated_effort_hours: { type: ['number', 'null'] },
                            assigned_to: { type: ['string', 'null'] },
                            verification_method: { type: ['string', 'null'] },
                            notes: { type: ['object', 'null'] }
                        },
                        required: ['task_number', 'title'],
                        additionalProperties: false
                    },
                    minItems: 1
                }
            },
            required: ['agent_id', 'planData', 'tasksData'],
            additionalProperties: false,
        },

    },
    {
        name: 'get_task_plan_details',
        description: 'Retrieves details for a specific task plan. This tool strictly requires the agent_id parameter.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                plan_id: { type: 'string', description: 'Unique ID of the plan.' }
            },
            required: ['agent_id', 'plan_id'],
            additionalProperties: false,
        },

    },
    {
        name: 'list_task_plans',
        description: 'Lists task plans for an agent, optionally filtered by status. This tool strictly requires the agent_id parameter.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                status_filter: { type: ['string', 'null'], description: 'Optional: Filter plans by status (e.g., "DRAFT", "IN_PROGRESS").' },
                limit: { type: 'number', description: 'Maximum number of plans to retrieve.', default: 100 },
                offset: { type: 'number', description: 'Offset for pagination.', default: 0 }
            },
            required: ['agent_id'],
            additionalProperties: false,
        },

    },
    {
        name: 'get_plan_tasks',
        description: 'Retrieves tasks for a specific plan, optionally filtered by status. This tool strictly requires the agent_id parameter.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                plan_id: { type: 'string', description: 'Unique ID of the plan.' },
                status_filter: { type: ['string', 'null'], description: 'Optional: Filter tasks by status (e.g., "PLANNED", "COMPLETED").' },
                limit: { type: 'number', description: 'Maximum number of tasks to retrieve.', default: 100 },
                offset: { type: 'number', description: 'Offset for pagination.', default: 0 }
            },
            required: ['agent_id', 'plan_id'],
            additionalProperties: false,
        },

    },
    {
        name: 'update_task_plan_status',
        description: 'Updates the status of a specified task plan. This tool strictly requires the agent_id parameter.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                plan_id: { type: 'string', description: 'Unique ID of the plan to update.' },
                new_status: { type: 'string', description: 'The new status for the plan.' }
            },
            required: ['agent_id', 'plan_id', 'new_status'],
            additionalProperties: false,
        },

    },
    {
        name: 'update_plan_task_status',
        description: 'Updates the status of a specific task within a plan. This tool strictly requires the agent_id parameter.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                task_id: { type: 'string', description: 'Unique ID of the task to update.' },
                new_status: { type: 'string', description: 'The new status for the task.' },
                completion_timestamp: { type: ['number', 'null'], description: 'Optional: Unix timestamp when the task was completed/failed.' }
            },
            required: ['agent_id', 'task_id', 'new_status'],
            additionalProperties: false,
        },

    },
    {
        name: 'delete_task_plan',
        description: 'Deletes a task plan and all its associated tasks. This tool strictly requires the agent_id parameter.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                plan_id: { type: 'string', description: 'Unique ID of the plan to delete.' }
            },
            required: ['agent_id', 'plan_id'],
            additionalProperties: false,
        },

    },
    {
        name: 'add_task_to_plan',
        description: 'Adds a new task to an existing plan. This tool strictly requires the agent_id parameter.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                plan_id: { type: 'string', description: 'Unique ID of the plan to add the task to.' },
                taskData: {
                    type: 'object',
                    properties: {
                        task_number: { type: 'number' },
                        title: { type: 'string' },
                        description: { type: ['string', 'null'] },
                        status: { type: 'string' },
                        purpose: { type: ['string', 'null'] },
                        action_description: { type: ['string', 'null'] },
                        files_involved: { type: ['array', 'null'], items: { type: 'string' } },
                        dependencies_task_ids: { type: ['array', 'null'], items: { type: 'string' } },
                        tools_required_list: { type: ['array', 'null'], items: { type: 'string' } },
                        inputs_summary: { type: ['string', 'null'] },
                        outputs_summary: { type: ['string', 'null'] },
                        success_criteria_text: { type: ['string', 'null'] },
                        estimated_effort_hours: { type: ['number', 'null'] },
                        assigned_to: { type: ['string', 'null'] },
                        verification_method: { type: ['string', 'null'] },
                        notes: { type: ['object', 'null'] }
                    },
                    required: ['task_number', 'title'],
                    additionalProperties: false
                }
            },
            required: ['agent_id', 'plan_id', 'taskData'],
            additionalProperties: false,
        },

    },
    {
        name: 'add_subtask_to_plan',
        description: 'Adds a new subtask to an existing plan, optionally linked to a parent task. This tool strictly requires the agent_id parameter.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                plan_id: { type: 'string', description: 'Unique ID of the plan the subtask belongs to.' },
                parent_task_id: { type: ['string', 'null'], description: 'Optional: Unique ID of the parent task if the subtask is nested.' },
                subtaskData: {
                    type: 'object',
                    properties: {
                        title: { type: 'string' },
                        description: { type: ['string', 'null'] },
                        status: { type: 'string' },
                        notes: { type: ['object', 'null'] }
                    },
                    required: ['title'],
                    additionalProperties: false
                }
            },
            required: ['agent_id', 'plan_id', 'subtaskData'],
            additionalProperties: false,
        },

    },
    {
        name: 'get_subtasks',
        description: 'Retrieves subtasks for a given plan or parent task, optionally filtered by status. This tool strictly requires the agent_id parameter.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                plan_id: { type: ['string', 'null'], description: 'Optional: Unique ID of the plan to retrieve subtasks for.' },
                parent_task_id: { type: ['string', 'null'], description: 'Optional: Unique ID of the parent task to retrieve subtasks for.' },
                status_filter: { type: ['string', 'null'], description: 'Optional: Filter subtasks by status (e.g., "PLANNED", "COMPLETED").' },
                limit: { type: 'number', description: 'Maximum number of subtasks to retrieve.', default: 100 },
                offset: { type: 'number', description: 'Offset for pagination.', default: 0 }
            },
            oneOf: [
                { required: ['plan_id'] },
                { required: ['parent_task_id'] }
            ],
            required: ['agent_id'],
            additionalProperties: false,
        },

    },
    {
        name: 'update_subtask_status',
        description: 'Updates the status of a specific subtask. This tool strictly requires the agent_id parameter.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                subtask_id: { type: 'string', description: 'Unique ID of the subtask to update.' },
                new_status: { type: 'string', description: 'The new status for the subtask.' },
                completion_timestamp: { type: ['number', 'null'], description: 'Optional: Unix timestamp when the subtask was completed/failed.' }
            },
            required: ['agent_id', 'subtask_id', 'new_status'],
            additionalProperties: false,
        },

    },
    {
        name: 'delete_subtask',
        description: 'Deletes a subtask. This tool strictly requires the agent_id parameter.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                subtask_id: { type: 'string', description: 'Unique ID of the subtask to delete.' }
            },
            required: ['agent_id', 'subtask_id'],
            additionalProperties: false,
        },

    },
];

export function getPlanManagementToolHandlers(memoryManager: MemoryManager) {
    return {
        'create_task_plan': async (args: any, agent_id: string) => {
            const validationResult = validate('createTaskPlan', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool create_task_plan: ${JSON.stringify(validationResult.errors)}`
                );
            }
            const planResult = await memoryManager.createPlanWithTasks(
                agent_id,
                args.planData as any,
                args.tasksData as any
            );
            return { content: [{ type: 'text', text: JSON.stringify(planResult) }] };
        },
        'get_task_plan_details': async (args: any, agent_id: string) => {
            const validationResult = validate('getTaskPlanDetails', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool get_task_plan_details: ${JSON.stringify(validationResult.errors)}`
                );
            }
            const planDetails = await memoryManager.getPlan(
                agent_id,
                args.plan_id as string
            );
            if (!planDetails) {
                return { content: [{ type: 'text', text: `Plan with ID ${args.plan_id} not found.` }] };
            }

            // Fetch tasks with nested subtasks using the logic from get_plan_tasks handler
            const tasks = await memoryManager.getPlanTasks(
                agent_id,
                args.plan_id as string
            );
            for (const task of tasks as any[]) {
                const subtasks = await memoryManager.subtaskManager.getSubtasksByParentTask(
                    agent_id,
                    task.task_id
                );
                task.subtasks = subtasks;
            }

            // Fetch plan-level subtasks
            let planLevelSubtasks = await memoryManager.subtaskManager.getSubtasksByPlan(
                agent_id,
                args.plan_id as string
            );
            // Filter to only include subtasks not linked to a parent task
            planLevelSubtasks = planLevelSubtasks.filter((subtask: any) => !subtask.parent_task_id);

            const markdownOutput = formatPlanToMarkdown(planDetails, tasks as any[], planLevelSubtasks as any[]);
            return { content: [{ type: 'text', text: markdownOutput }] };
        },
        'list_task_plans': async (args: any, agent_id: string) => {
            const validationResult = validate('listTaskPlans', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool list_task_plans: ${JSON.stringify(validationResult.errors)}`
                );
            }
            const plans = await memoryManager.getPlans(
                agent_id,
                args.status_filter as string | undefined,
                args.limit as number | undefined,
                args.offset as number | undefined
            );
            // Fix: order by creation_timestamp_unix instead of creation_timestamp
            plans.sort((a: any, b: any) => b.creation_timestamp_unix - a.creation_timestamp_unix);
            const markdownOutput = formatPlansListToMarkdownTable(plans as any[]);
            return { content: [{ type: 'text', text: markdownOutput }] };

        },
        'get_plan_tasks': async (args: any, agent_id: string) => {
            const validationResult = validate('getPlanTasks', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool get_plan_tasks: ${JSON.stringify(validationResult.errors)}`
                );
            }
            const tasks = await memoryManager.getPlanTasks(
                agent_id,
                args.plan_id as string,
                args.status_filter as string | undefined,
                args.limit as number | undefined,
                args.offset as number | undefined
            );

            // Fetch subtasks for each main task
            for (const task of tasks as any[]) {
                const subtasks = await memoryManager.subtaskManager.getSubtasksByParentTask(
                    agent_id,
                    task.task_id,
                    args.status_filter as string | undefined // Apply same status filter to subtasks
                );
                task.subtasks = subtasks; // Attach subtasks to the parent task object
            }

            const markdownOutput = formatTasksListToMarkdownTable(tasks as any[]);
            return { content: [{ type: 'text', text: markdownOutput }] };
        },
        'update_task_plan_status': async (args: any, agent_id: string) => {
            const validationResult = validate('updateTaskPlanStatus', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool update_task_plan_status: ${JSON.stringify(validationResult.errors)}`
                );
            }
            const success = await memoryManager.updatePlanStatus(
                agent_id,
                args.plan_id as string,
                args.new_status as string
            );
            return { content: [{ type: 'text', text: `Plan status update ${success ? 'succeeded' : 'failed'}` }] };
        },
        'update_plan_task_status': async (args: any, agent_id: string) => {
            const validationResult = validate('updatePlanTaskStatus', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool update_plan_task_status: ${JSON.stringify(validationResult.errors)}`
                );
            }
            const success = await memoryManager.updateTaskStatus(
                agent_id,
                args.task_id as string,
                args.new_status as string,
                args.completion_timestamp as number | undefined
            );
            return { content: [{ type: 'text', text: `Task status update ${success ? 'succeeded' : 'failed'}` }] };
        },
        'delete_task_plan': async (args: any, agent_id: string) => {
            const validationResult = validate('deleteTaskPlan', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool delete_task_plan: ${JSON.stringify(validationResult.errors)}`
                );
            }
            const success = await memoryManager.deletePlan(
                agent_id,
                args.plan_id as string
            );
            return { content: [{ type: 'text', text: `Plan deletion ${success ? 'succeeded' : 'failed'}` }] };
        },
        'add_task_to_plan': async (args: any, agent_id: string) => {
            const validationResult = validate('addTaskToPlan', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool add_task_to_plan: ${JSON.stringify(validationResult.errors)}`
                );
            }
            const task_id = await memoryManager.addTaskToPlan(
                agent_id,
                args.plan_id as string,
                args.taskData as any
            );
            return { content: [{ type: 'text', text: `Task added with ID: ${task_id}` }] };
        },
        'add_subtask_to_plan': async (args: any, agent_id: string) => {
            const validationResult = validate('addSubtaskToPlan', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool add_subtask_to_plan: ${JSON.stringify(validationResult.errors)}`
                );
            }
            const subtask_id = await memoryManager.subtaskManager.createSubtask(
                agent_id,
                args.plan_id as string,
                { ...args.subtaskData, parent_task_id: args.parent_task_id } as any
            );
            return { content: [{ type: 'text', text: `Subtask added with ID: ${subtask_id}` }] };
        },
        'get_subtasks': async (args: any, agent_id: string) => {
            const validationResult = validate('getSubtasks', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool get_subtasks: ${JSON.stringify(validationResult.errors)}`
                );
            }
            let subtasks;
            if (args.plan_id && args.parent_task_id) {
                subtasks = await memoryManager.subtaskManager.getSubtasksByPlanAndParentTask(
                    agent_id,
                    args.plan_id as string,
                    args.parent_task_id as string,
                    args.status_filter as string | undefined,
                    args.limit as number | undefined,
                    args.offset as number | undefined
                );
            } else if (args.plan_id) {
                subtasks = await memoryManager.subtaskManager.getSubtasksByPlan(
                    agent_id,
                    args.plan_id as string,
                    args.status_filter as string | undefined,
                    args.limit as number | undefined,
                    args.offset as number | undefined
                );
            } else if (args.parent_task_id) {
                subtasks = await memoryManager.subtaskManager.getSubtasksByParentTask(
                    agent_id,
                    args.parent_task_id as string,
                    args.status_filter as string | undefined,
                    args.limit as number | undefined,
                    args.offset as number | undefined
                );
            } else {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool get_subtasks: Either plan_id or parent_task_id must be provided.`
                );
            }
            const markdownOutput = formatSubtasksListToMarkdownTable(subtasks as any[]);
            return { content: [{ type: 'text', text: markdownOutput }] };
        },
        'update_subtask_status': async (args: any, agent_id: string) => {
            const validationResult = validate('updateSubtaskStatus', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool update_subtask_status: ${JSON.stringify(validationResult.errors)}`
                );
            }
            const success = await memoryManager.subtaskManager.updateSubtaskStatus(
                agent_id,
                args.subtask_id as string,
                args.new_status as string,
                args.completion_timestamp as number | undefined
            );
            return { content: [{ type: 'text', text: `Subtask status update ${success ? 'succeeded' : 'failed'}` }] };
        },
        'delete_subtask': async (args: any, agent_id: string) => {
            const validationResult = validate('deleteSubtask', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool delete_subtask: ${JSON.stringify(validationResult.errors)}`
                );
            }
            const success = await memoryManager.subtaskManager.deleteSubtask(
                agent_id,
                args.subtask_id as string
            );
            return { content: [{ type: 'text', text: `Subtask deletion ${success ? 'succeeded' : 'failed'}` }] };
        },
    };
}
