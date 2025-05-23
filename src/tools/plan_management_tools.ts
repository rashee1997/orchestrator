import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate, schemas } from '../utils/validation.js';
import { formatPlanToMarkdown, formatTasksListToMarkdownTable, formatPlansListToMarkdownTable } from '../utils/formatters.js';

export const planManagementToolDefinitions = [
    {
        name: 'create_task_plan',
        description: 'Creates a new task plan with its initial set of tasks.',
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
        description: 'Retrieves details for a specific task plan.',
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
        description: 'Lists task plans for an agent, optionally filtered by status.',
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
        description: 'Retrieves tasks for a specific plan, optionally filtered by status.',
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
        description: 'Updates the status of a specified task plan.',
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
        description: 'Updates the status of a specific task within a plan.',
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
        description: 'Deletes a task plan and all its associated tasks.',
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
                return { content: [{ type: 'markdown', markdown: `Plan with ID ${args.plan_id} not found.` }] };
            }
            const tasks = await memoryManager.getPlanTasks(agent_id, args.plan_id as string);
            const markdownOutput = formatPlanToMarkdown(planDetails, tasks as any[]);
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
    };
}
