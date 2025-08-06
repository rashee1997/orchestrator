import { MemoryManager } from '../database/memory_manager.js';
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
import { InitialDetailedPlanAndTasks } from '../database/services/GeminiPlannerService.js';

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

    /**
     * Retrieves the agent_id from arguments or the server context and throws if it's missing.
     */
    const getValidatedAgentId = (args: any, agentIdFromServer: string, toolName: string): string => {
        const agent_id = args.agent_id || agentIdFromServer;
        if (!agent_id) {
            throw new McpError(ErrorCode.InvalidParams, `agent_id is required for ${toolName}.`);
        }
        return agent_id;
    };

    /**
     * Validates tool arguments against a predefined schema and throws a formatted error on failure.
     */
    const validateToolArgs = (schemaName: keyof typeof schemas, args: any, toolName: string): void => {
        const validationResult = validate(schemaName, args);
        if (!validationResult.valid) {
            const errorMessage = `Validation failed for ${toolName}: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`;
            throw new McpError(ErrorCode.InvalidParams, errorMessage);
        }
    };

    /**
     * Creates the standard tool response structure.
     */
    const createToolResponse = (text: string) => {
        return { content: [{ type: 'text', text }] };
    };

    /**
     * Creates a consistent success message for entity update operations.
     */
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
            let aiGeneratedPlan: InitialDetailedPlanAndTasks | undefined;

            if (args.goal_description || args.refined_prompt_id) {
                const identifier = args.refined_prompt_id || args.goal_description;
                const isRefinedPromptId = !!args.refined_prompt_id;
                try {
                    aiGeneratedPlan = await memoryManager.getGeminiPlannerService().generateInitialDetailedPlanAndTasks(agent_id, identifier, isRefinedPromptId);
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

            if (tasksDataToStore) {
                tasksDataToStore = tasksDataToStore.map(task => {
                    const newTask = { ...task };
                    newTask.suggested_files_involved = newTask.suggested_files_involved || [];
                    if (newTask.files_involved_json) {
                        try {
                            const parsedFiles = JSON.parse(newTask.files_involved_json);
                            if (Array.isArray(parsedFiles)) {
                                newTask.suggested_files_involved = parsedFiles;
                            }
                        } catch (e) {
                            console.warn(`Failed to parse files_involved_json for a task: ${e}`);
                        }
                        delete newTask.files_involved_json;
                    }
                    return newTask;
                });
            }

            if (!planDataToStore.title) {
                planDataToStore.title = args.goal_description ? `Plan for: ${args.goal_description.substring(0, 50)}...` : 'Untitled AI Plan';
            }

            const planResult = await memoryManager.createPlanWithTasks(agent_id, planDataToStore, tasksDataToStore);

            let md = `## Task Plan Created for Agent: \`${agent_id}\`\n`;
            md += `- **Plan ID:** \`${planResult.plan_id}\`\n`;
            md += `- **Title:** ${planDataToStore.title}\n`;
            if (planDataToStore.overall_goal) md += `- **Overall Goal:** ${planDataToStore.overall_goal}\n`;
            if (planDataToStore.metadata?.estimated_duration_days) md += `- **Est. Duration:** ${planDataToStore.metadata.estimated_duration_days} days\n`;
            if (planDataToStore.refined_prompt_id_associated) md += `- **Based on Refined Prompt ID:** \`${planDataToStore.refined_prompt_id_associated}\`\n`;
            md += `- **Task IDs Created:** ${planResult.task_ids.map(id => `\`${id}\``).join(', ')}\n`;
            if (aiGeneratedPlan?.suggested_next_steps_for_agent) {
                md += `\n${aiGeneratedPlan.suggested_next_steps_for_agent.replace(/\[agent_id\]/g, agent_id).replace(/\[plan_id\]/g, planResult.plan_id)}\n`;
            }
            return createToolResponse(md);
        },

        'get_task_plan_details': async (args: any, agent_id_from_server: string) => {
            const toolName = 'get_task_plan_details';
            const agent_id = getValidatedAgentId(args, agent_id_from_server, toolName);
            validateToolArgs('getTaskPlanDetails', args, toolName);

            const planDetails = await memoryManager.getPlan(agent_id, args.plan_id);
            if (!planDetails) {
                return createToolResponse(formatSimpleMessage(`Plan with ID \`${args.plan_id}\` not found for agent \`${agent_id}\`.`, "Plan Not Found"));
            }

            const tasksFromDb = await memoryManager.getPlanTasks(agent_id, args.plan_id);
            const tasks = await Promise.all(
                (tasksFromDb as Task[]).map(async (task) => ({
                    ...task,
                    subtasks: await memoryManager.subtaskManager.getSubtasksByParentTask(agent_id, task.task_id),
                }))
            );

            const planLevelSubtasks = ((await memoryManager.subtaskManager.getSubtasksByPlan(agent_id, args.plan_id)) as Subtask[])
                .filter((subtask: Subtask) => !subtask.parent_task_id);

            return createToolResponse(formatPlanToMarkdown(planDetails, tasks, planLevelSubtasks));
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

        // Retrieve a single task's full details by ID
        'get_task_details': async (args: any, agent_id_from_server: string) => {
            const toolName = 'get_task_details';
            const agent_id = getValidatedAgentId(args, agent_id_from_server, toolName);
            validateToolArgs('getTaskDetails', args, toolName);

            const task = await (memoryManager as any).planTaskManager.getTaskById?.(agent_id, args.task_id)
                ?? await memoryManager.getPlanTaskById?.(agent_id, args.task_id);
            if (!task) {
                return { content: [{ type: 'text', text: formatSimpleMessage(`Task with ID \`${args.task_id}\` not found for agent \`${agent_id}\`.`, "Task Not Found") }] };
            }

            // Safely parse JSON fields if present
            const parseJsonSafe = (val: any) => {
                if (val == null) return null;
                if (typeof val !== 'string') return val;
                try { return JSON.parse(val); } catch { return val; }
            };

            const detailed = {
                ...task,
                files_involved: parseJsonSafe(task.files_involved_json),
                dependencies_task_ids: parseJsonSafe(task.dependencies_task_ids_json),
                tools_required_list: parseJsonSafe(task.tools_required_list_json),
                notes: parseJsonSafe(task.notes_json),
            };

            // Build a detailed markdown
            let md = `## Task Details\n`;
            md += `- **Task ID:** \`${detailed.task_id}\`\n`;
            if (detailed.plan_id) md += `- **Plan ID:** \`${detailed.plan_id}\`\n`;
            md += `- **Agent ID:** \`${agent_id}\`\n`;
            md += `- **Title:** ${detailed.title || '*N/A*'}\n`;
            md += `- **Status:** ${detailed.status || '*N/A*'}\n`;
            if (typeof detailed.task_number !== 'undefined') md += `- **Task Number:** ${detailed.task_number}\n`;
            if (detailed.purpose) md += `- **Purpose:** ${detailed.purpose}\n`;
            if (detailed.description) md += `\n**Description:**\n${detailed.description}\n`;
            if (detailed.inputs_summary) md += `\n**Inputs Summary:**\n${detailed.inputs_summary}\n`;
            if (detailed.outputs_summary) md += `\n**Outputs Summary:**\n${detailed.outputs_summary}\n`;
            if (detailed.success_criteria_text) md += `\n**Success Criteria:**\n${detailed.success_criteria_text}\n`;
            if (typeof detailed.estimated_effort_hours !== 'undefined' && detailed.estimated_effort_hours !== null) {
                md += `\n**Estimated Effort (hours):** ${detailed.estimated_effort_hours}\n`;
            }
            if (detailed.assigned_to) md += `\n**Assigned To:** ${detailed.assigned_to}\n`;
            if (detailed.verification_method) md += `\n**Verification Method:** ${detailed.verification_method}\n`;

            if (detailed.files_involved) md += `\n**Files Involved:**\n${formatJsonToMarkdownCodeBlock(detailed.files_involved)}\n`;
            if (detailed.dependencies_task_ids) md += `\n**Dependencies (Task IDs):**\n${formatJsonToMarkdownCodeBlock(detailed.dependencies_task_ids)}\n`;
            if (detailed.tools_required_list) md += `\n**Tools Required:**\n${formatJsonToMarkdownCodeBlock(detailed.tools_required_list)}\n`;
            if (detailed.notes) md += `\n**Notes:**\n${formatJsonToMarkdownCodeBlock(detailed.notes)}\n`;

            return { content: [{ type: 'text', text: md }] };
        },

        // Update a single task by ID (partial update)
        'update_task': async (args: any, agent_id_from_server: string) => {
            const toolName = 'update_task';
            const agent_id = getValidatedAgentId(args, agent_id_from_server, toolName);
            validateToolArgs('updateTask', args, toolName);

            const { task_id, completion_timestamp, files_involved, dependencies_task_ids, tools_required_list, notes, ...rest } = args;

            // Serialize JSON/list fields if provided
            const updates: Record<string, any> = { ...rest };
            if (typeof files_involved !== 'undefined') updates.files_involved = files_involved;
            if (typeof dependencies_task_ids !== 'undefined') updates.dependencies_task_ids = dependencies_task_ids;
            if (typeof tools_required_list !== 'undefined') updates.tools_required_list = tools_required_list;
            if (typeof notes !== 'undefined') updates.notes = notes;

            const success = await memoryManager.updateTaskDetails(agent_id, task_id, updates, completion_timestamp);

            const message = success
                ? `Task \`${task_id}\` updated successfully.`
                : `Failed to update task \`${task_id}\`.`;
            return { content: [{ type: 'text', text: formatSimpleMessage(message, "Update Task") }] };
        },
    };
}
