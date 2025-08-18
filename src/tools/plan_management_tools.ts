// src/tools/plan_management_tools.ts
import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate, schemas } from '../utils/validation.js';
import {
    formatPlanToMarkdown,
    formatTasksListToMarkdownTable,
    formatPlansListToMarkdownTable,
    formatSubtasksListToMarkdownTable,
    formatSimpleMessage,
    formatJsonToMarkdownCodeBlock,
    formatTaskToMarkdown
} from '../utils/formatters.js';
import { InitialDetailedPlanAndTasks } from '../database/services/GeminiPlannerService.js';
import { promises as fs } from 'fs';
import path from 'path';

// Minimal interfaces to improve type-hinting in this file.
// For a more robust solution, these could be imported from a central types/models file.
interface Task {
    task_id: string;
    subtasks?: Subtask[];
    [key: string]: any;
}

interface Subtask {
    subtask_id: string;
    parent_task_id?: string;
    [key: string]: any;
}

export const planManagementToolDefinitions = [
    {
        name: 'create_task_plan',
        description: 'Creates a new task plan. Can either accept full plan and task data, or generate them using AI based on a goal description or refined prompt ID. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: schemas.createTaskPlan,
    },
    {
        name: 'get_plan',
        description: 'Retrieves details for a specific task plan, including its tasks and subtasks. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: schemas.getTaskPlanDetails, // Re-using schema
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
        name: 'update_task_details',
        description: 'Updates details of a specific task within a plan, including its status. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: schemas.updateTaskDetails,
    },
    {
        name: 'delete_task_plans',
        description: 'Deletes one or more task plans and all their associated tasks. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: schemas.deleteTaskPlans,
    },
    {
        name: 'delete_tasks',
        description: 'Deletes one or more tasks. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: schemas.deleteTasks,
    },
    {
        name: 'add_task_to_plan',
        description: 'Adds a new task to an existing plan. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: schemas.addTaskToPlan,
    },
    {
        name: 'add_subtask_to_plan',
        description: 'Adds a new subtask to an existing plan, optionally linked to a parent task. Supports uploading batch files to add multiple subtasks at once. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: schemas.addSubtaskToPlan,
    },
    {
        name: 'get_task_details',
        description: 'Retrieve full details for a single plan task by its ID, including parsed JSON fields.',
        inputSchema: schemas.getTaskDetails
    },
    {
        name: 'update_task',
        description: 'Update one or more fields for a specific plan task by its ID. Partial updates supported.',
        inputSchema: schemas.updateTask
    },
    {
        name: 'get_subtasks',
        description: 'Retrieves subtasks for a given plan or parent task, optionally filtered by status. This tool strictly requires the agent_id parameter. Output is Markdown formatted as a table.',
        inputSchema: schemas.getSubtasks,
    },
    {
        name: 'update_subtask_details',
        description: 'Updates details of a specific subtask, including its status. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: schemas.updateSubtaskDetails,
    },
    {
        name: 'delete_subtasks',
        description: 'Deletes one or more subtasks. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: schemas.deleteSubtasks,
    },
];

export function getPlanManagementToolHandlers(memoryManager: MemoryManager) {

    const getValidatedAgentId = (args: any, agentIdFromServer: string, toolName: string): string => {
        const agent_id = args.agent_id || agentIdFromServer;
        if (!agent_id) {
            throw new McpError(ErrorCode.InvalidParams, `agent_id is required for ${toolName}.`);
        }
        return agent_id;
    };

    const validateToolArgs = (schemaName: keyof typeof schemas, args: any, toolName: string): void => {
        const validationResult = validate(schemaName, args);
        if (!validationResult.valid) {
            const errorMessage = `Validation failed for ${toolName}: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`;
            throw new McpError(ErrorCode.InvalidParams, errorMessage);
        }
    };

    const createToolResponse = (text: string) => {
        return { content: [{ type: 'text', text }] };
    };

    const createUpdateSuccessMessage = (entityType: 'Task' | 'Subtask', entityId: string, updates: Record<string, any>): string => {
        const updatedKeys = Object.keys(updates).filter(key => !['agent_id', 'task_id', 'subtask_id', 'completion_timestamp'].includes(key));

        if (updatedKeys.length === 1 && updatedKeys[0] === 'status') {
            return `${entityType} \`${entityId}\` status updated to \`${updates.status}\`.`;
        }
        if (updatedKeys.length > 0) {
            return `${entityType} \`${entityId}\` details (${updatedKeys.join(', ')}) updated.`;
        }
        return `${entityType} \`${entityId}\` updated.`;
    };

    return {
        'create_task_plan': async (args: any, agent_id_from_server: string) => {
            const toolName = 'create_task_plan';
            const agent_id = getValidatedAgentId(args, agent_id_from_server, toolName);
            validateToolArgs('createTaskPlan', args, toolName);

            let planDataToStore: any;
            let tasksDataToStore: any[];

            if (args.goal_description || args.refined_prompt_id) {
                const identifier = args.refined_prompt_id || args.goal_description;
                const isRefinedPromptId = !!args.refined_prompt_id;
                
                // Read live files content if paths are provided
                let liveFilesContent: Map<string, string> | undefined;
                if (args.live_review_file_paths && Array.isArray(args.live_review_file_paths)) {
                    liveFilesContent = new Map();
                    for (const filePath of args.live_review_file_paths) {
                        try {
                             if (path.isAbsolute(filePath) && !filePath.startsWith(memoryManager.projectRootPath)) {
                                 console.warn(`Skipping file outside of project root: ${filePath}`);
                                 continue;
                            }
                            const content = await fs.readFile(filePath, 'utf-8');
                            liveFilesContent.set(filePath, content);
                        } catch (error: any) {
                            console.warn(`Could not read live file for planning context: ${filePath}. Error: ${error.message}`);
                        }
                    }
                }
                
                try {
                    const aiGeneratedPlan = await memoryManager.getGeminiPlannerService().generateInitialDetailedPlanAndTasks(
                        agent_id, 
                        identifier, 
                        isRefinedPromptId,
                        undefined, // directRefinedPromptDetails
                        undefined, // codebaseContextSummary
                        liveFilesContent // Pass live file content to the planner
                    );
                    planDataToStore = aiGeneratedPlan.planData;
                    tasksDataToStore = aiGeneratedPlan.tasksData;

                    if (args.refined_prompt_id) {
                        planDataToStore.refined_prompt_id_associated = args.refined_prompt_id;
                    }

                } catch (error: any) {
                    console.error(`Error during AI plan generation for agent ${agent_id}:`, error);
                    throw new McpError(ErrorCode.InternalError, `AI plan generation failed: ${error.message}`);
                }
            } else if (args.planData && args.tasksData) {
                planDataToStore = args.planData;
                tasksDataToStore = args.tasksData;
            } else {
                throw new McpError(ErrorCode.InvalidParams, "Either AI generation parameters (goal_description or refined_prompt_id) or manual planData and tasksData must be provided.");
            }
            
            if (!planDataToStore.title) {
                planDataToStore.title = args.goal_description ? `Plan for: ${args.goal_description.substring(0, 50)}...` : 'Untitled AI Plan';
            }

            const planResult = await memoryManager.createPlanWithTasks(agent_id, planDataToStore, tasksDataToStore);

            // Fetch the created plan and tasks to format them for the response
            const newPlan = await memoryManager.getPlan(agent_id, planResult.plan_id);
            const newTasks = await memoryManager.getPlanTasks(agent_id, planResult.plan_id);

            if (!newPlan) {
                 throw new McpError(ErrorCode.InternalError, "Failed to retrieve the newly created plan.");
            }
            
            // Use the formatter to create a beautiful markdown output
            const markdownOutput = formatPlanToMarkdown(newPlan, newTasks as Task[]);
            
            return createToolResponse(markdownOutput);
        },

        'get_plan': async (args: any, agent_id_from_server: string) => {
            const toolName = 'get_plan';
            const agent_id = getValidatedAgentId(args, agent_id_from_server, toolName);
            validateToolArgs('getTaskPlanDetails', args, toolName);

            const planDetails = await memoryManager.getPlan(agent_id, args.plan_id);
            if (!planDetails) {
                return createToolResponse(formatSimpleMessage(`Plan with ID \`${args.plan_id}\` not found for agent \`${agent_id}\`.`, "Plan Not Found"));
            }

            const tasksFromDb = await memoryManager.getPlanTasks(agent_id, args.plan_id);
             const taskMap = new Map((tasksFromDb as Task[]).map(t => [t.task_id, t]));

            const tasks = await Promise.all(
                (tasksFromDb as Task[]).map(async (task) => ({
                    ...task,
                    subtasks: await memoryManager.subtaskManager.getSubtasksByParentTask(agent_id, task.task_id),
                }))
            );

            const planLevelSubtasks = ((await memoryManager.subtaskManager.getSubtasksByPlan(agent_id, args.plan_id)) as Subtask[])
                .filter((subtask: Subtask) => !subtask.parent_task_id);

            return createToolResponse(formatPlanToMarkdown(planDetails, tasks, planLevelSubtasks, taskMap));
        },

        'list_task_plans': async (args: any, agent_id_from_server: string) => {
            const toolName = 'list_task_plans';
            const agent_id = getValidatedAgentId(args, agent_id_from_server, toolName);
            validateToolArgs('listTaskPlans', args, toolName);

            const plans = await memoryManager.getPlans(agent_id, args.status_filter, args.limit, args.offset);
            plans.sort((a: any, b: any) => (b.creation_timestamp_unix || 0) - (a.creation_timestamp_unix || 0));

            let title = `Task Plans for Agent: \`${agent_id}\``;
            if (args.status_filter) title += ` (Status: ${args.status_filter})`;

            return createToolResponse(`## ${title}\n\n${formatPlansListToMarkdownTable(plans)}`);
        },

        'get_plan_tasks': async (args: any, agent_id_from_server: string) => {
            const toolName = 'get_plan_tasks';
            const agent_id = getValidatedAgentId(args, agent_id_from_server, toolName);
            validateToolArgs('getPlanTasks', args, toolName);

            const tasksFromDb = await memoryManager.getPlanTasks(agent_id, args.plan_id, args.status_filter, args.limit, args.offset);
            const tasksWithSubtasks = await Promise.all(
                (tasksFromDb as Task[]).map(async (task) => ({
                    ...task,
                    subtasks: await memoryManager.subtaskManager.getSubtasksByParentTask(agent_id, task.task_id, args.status_filter),
                }))
            );

            let title = `Tasks for Plan: \`${args.plan_id}\` (Agent: \`${agent_id}\`)`;
            if (args.status_filter) title += ` (Status: ${args.status_filter})`;

            return createToolResponse(`## ${title}\n\n${formatTasksListToMarkdownTable(tasksWithSubtasks, true)}`);
        },

        'update_task_plan_status': async (args: any, agent_id_from_server: string) => {
            const toolName = 'update_task_plan_status';
            const agent_id = getValidatedAgentId(args, agent_id_from_server, toolName);
            validateToolArgs('updateTaskPlanStatus', args, toolName);

            const success = await memoryManager.updatePlanStatus(agent_id, args.plan_id, args.new_status);
            const message = success
                ? `Plan \`${args.plan_id}\` status updated to \`${args.new_status}\`.`
                : `Failed to update status for plan \`${args.plan_id}\`.`;

            return createToolResponse(formatSimpleMessage(message, "Update Plan Status"));
        },

        'update_task_details': async (args: any, agent_id_from_server: string) => {
            const toolName = 'update_task_details';
            const agent_id = getValidatedAgentId(args, agent_id_from_server, toolName);
            validateToolArgs('updateTaskDetails', args, toolName);

            const { task_id, completion_timestamp, ...updates } = args;
            const success = await memoryManager.updateTaskDetails(agent_id, task_id, updates, completion_timestamp);

            const message = success
                ? createUpdateSuccessMessage('Task', task_id, args)
                : `Failed to update details for task \`${task_id}\`.`;

            return createToolResponse(formatSimpleMessage(message, "Update Task Details"));
        },

        'delete_task_plans': async (args: any, agent_id_from_server: string) => {
            const toolName = 'delete_task_plans';
            const agent_id = getValidatedAgentId(args, agent_id_from_server, toolName);
            validateToolArgs('deleteTaskPlans', args, toolName);

            const success = await memoryManager.deletePlans(agent_id, args.plan_ids);
            const message = success
                ? `Plans \`${args.plan_ids.join(', ')}\` and their associated tasks/subtasks deleted.`
                : `Failed to delete plans \`${args.plan_ids.join(', ')}\`.`;

            return createToolResponse(formatSimpleMessage(message, "Delete Plans"));
        },

        'delete_tasks': async (args: any, agent_id_from_server: string) => {
            const toolName = 'delete_tasks';
            const agent_id = getValidatedAgentId(args, agent_id_from_server, toolName);
            validateToolArgs('deleteTasks', args, toolName);

            const success = await memoryManager.deleteTasks(agent_id, args.task_ids);
            const message = success
                ? `Tasks \`${args.task_ids.join(', ')}\` and their associated subtasks deleted.`
                : `Failed to delete tasks \`${args.task_ids.join(', ')}\`.`;

            return createToolResponse(formatSimpleMessage(message, "Delete Tasks"));
        },

        'add_task_to_plan': async (args: any, agent_id_from_server: string) => {
            const toolName = 'add_task_to_plan';
            const agent_id = getValidatedAgentId(args, agent_id_from_server, toolName);
            validateToolArgs('addTaskToPlan', args, toolName);

            const task_id = await memoryManager.addTaskToPlan(agent_id, args.plan_id, args.taskData);
            const message = `Task added to plan \`${args.plan_id}\` with ID: \`${task_id}\``;

            return createToolResponse(formatSimpleMessage(message, "Task Added"));
        },

        'add_subtask_to_plan': async (args: any, agent_id_from_server: string) => {
            const toolName = 'add_subtask_to_plan';
            const agent_id = getValidatedAgentId(args, agent_id_from_server, toolName);
            validateToolArgs('addSubtaskToPlan', args, toolName);

            const { plan_id, parent_task_id, subtaskData } = args;
            let message: string;

            if (Array.isArray(subtaskData) && subtaskData.length > 0) {
                const subtasksToCreate = subtaskData.map((subtask: any) => ({
                    ...subtask,
                    parent_task_id: parent_task_id || subtask.parent_task_id,
                }));
                const subtask_ids = await memoryManager.subtaskManager.createSubtasks(agent_id, plan_id, subtasksToCreate);
                message = `Added ${subtask_ids.length} subtasks to plan \`${plan_id}\`. IDs: ${subtask_ids.map((id: string) => `\`${id}\``).join(', ')}.`;
            } else {
                const subtaskToCreate = { ...subtaskData, parent_task_id };
                const subtask_id = await memoryManager.subtaskManager.createSubtask(agent_id, plan_id, subtaskToCreate);
                message = `Subtask added to plan \`${plan_id}\` with ID: \`${subtask_id}\`.`;
            }

            if (parent_task_id) message += ` Parent task ID: \`${parent_task_id}\`.`;

            return createToolResponse(formatSimpleMessage(message, "Subtasks Added"));
        },

        'get_subtasks': async (args: any, agent_id_from_server: string) => {
            const toolName = 'get_subtasks';
            const agent_id = getValidatedAgentId(args, agent_id_from_server, toolName);
            validateToolArgs('getSubtasks', args, toolName);

            if (!args.plan_id && !args.parent_task_id) {
                throw new McpError(ErrorCode.InvalidParams, "Either plan_id or parent_task_id must be provided for get_subtasks.");
            }

            let subtasks;
            let title = `Subtasks for Agent: \`${agent_id}\``;
            const { plan_id, parent_task_id, status_filter, limit, offset } = args;

            if (plan_id && parent_task_id) {
                subtasks = await memoryManager.subtaskManager.getSubtasksByPlanAndParentTask(agent_id, plan_id, parent_task_id, status_filter, limit, offset);
                title += ` (Plan: \`${plan_id}\`, Parent Task: \`${parent_task_id}\`)`;
            } else if (plan_id) {
                subtasks = await memoryManager.subtaskManager.getSubtasksByPlan(agent_id, plan_id, status_filter, limit, offset);
                title += ` (Plan: \`${plan_id}\`)`;
            } else if (parent_task_id) {
                subtasks = await memoryManager.subtaskManager.getSubtasksByParentTask(agent_id, parent_task_id, status_filter, limit, offset);
                title += ` (Parent Task: \`${parent_task_id}\`)`;
            }

            if (status_filter) title += ` (Status: ${status_filter})`;

            return createToolResponse(`## ${title}\n\n${formatSubtasksListToMarkdownTable(subtasks as Subtask[])}`);
        },

        'update_subtask_details': async (args: any, agent_id_from_server: string) => {
            const toolName = 'update_subtask_details';
            const agent_id = getValidatedAgentId(args, agent_id_from_server, toolName);
            validateToolArgs('updateSubtaskDetails', args, toolName);

            const { subtask_id, completion_timestamp, ...updates } = args;
            const success = await memoryManager.subtaskManager.updateSubtaskDetails(agent_id, subtask_id, updates, completion_timestamp);

            const message = success
                ? createUpdateSuccessMessage('Subtask', subtask_id, args)
                : `Failed to update details for subtask \`${subtask_id}\`.`;

            return createToolResponse(formatSimpleMessage(message, "Update Subtask Details"));
        },

        'delete_subtasks': async (args: any, agent_id_from_server: string) => {
            const toolName = 'delete_subtasks';
            const agent_id = getValidatedAgentId(args, agent_id_from_server, toolName);
            validateToolArgs('deleteSubtasks', args, toolName);

            const success = await memoryManager.subtaskManager.deleteSubtasks(agent_id, args.subtask_ids);
            const message = success
                ? `Subtasks \`${args.subtask_ids.join(', ')}\` deleted.`
                : `Failed to delete subtasks \`${args.subtask_ids.join(', ')}\`.`;

            return createToolResponse(formatSimpleMessage(message, "Delete Subtasks"));
        },

        'get_task_details': async (args: any, agent_id_from_server: string) => {
            const toolName = 'get_task_details';
            const agent_id = getValidatedAgentId(args, agent_id_from_server, toolName);
            validateToolArgs('getTaskDetails', args, toolName);

            const task = await memoryManager.getTask(agent_id, args.task_id);
            if (!task) {
                return createToolResponse(formatSimpleMessage(`Task with ID \`${args.task_id}\` not found for agent \`${agent_id}\`.`, "Task Not Found"));
            }

            return createToolResponse(formatTaskToMarkdown(task));
        },

        'update_task': async (args: any, agent_id_from_server: string) => {
            const toolName = 'update_task';
            const agent_id = getValidatedAgentId(args, agent_id_from_server, toolName);
            validateToolArgs('updateTask', args, toolName);

            const { task_id, completion_timestamp, ...updates } = args;
            
            const success = await memoryManager.updateTaskDetails(agent_id, task_id, updates, completion_timestamp);

            const message = success
                ? `Task \`${task_id}\` updated successfully.`
                : `Failed to update task \`${task_id}\`.`;
            return createToolResponse(formatSimpleMessage(message, "Update Task"));
        },
    };
}