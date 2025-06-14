// src/tools/plan_management_tools.ts
import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate, schemas } from '../utils/validation.js'; // Ensure schemas is correctly imported
import {
    formatPlanToMarkdown,
    formatTasksListToMarkdownTable,
    formatPlansListToMarkdownTable,
    formatSubtasksListToMarkdownTable,
    formatSimpleMessage,
    formatJsonToMarkdownCodeBlock
} from '../utils/formatters.js';
import { InitialDetailedPlanAndTasks } from '../database/services/GeminiPlannerService.js'; // Import the interface

export const planManagementToolDefinitions = [
    {
        name: 'create_task_plan',
        description: 'Creates a new task plan. Can either accept full plan and task data, or generate them using AI based on a goal description or refined prompt ID. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: schemas.createTaskPlan, // Use the updated schema from validation.ts
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
    return {
        'create_task_plan': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for create_task_plan.");
            }

            const validationResult = validate('createTaskPlan', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed for create_task_plan: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }

            let planDataToStore: any;
            let tasksDataToStore: any[];
            let refinedPromptIdForAssociation: string | null = null;
            let aiGeneratedPlan: InitialDetailedPlanAndTasks | undefined = undefined; // Declare aiGeneratedPlan here


            if (args.goal_description || args.refined_prompt_id) {
                // AI-assisted plan generation
                const identifier = args.refined_prompt_id || args.goal_description;
                const isRefinedPromptId = !!args.refined_prompt_id;
                if (args.refined_prompt_id) {
                    refinedPromptIdForAssociation = args.refined_prompt_id;
                }


                try {
                    aiGeneratedPlan = await memoryManager.getGeminiPlannerService().generateInitialDetailedPlanAndTasks(
                        agent_id,
                        identifier,
                        isRefinedPromptId
                    );
                    planDataToStore = aiGeneratedPlan.planData;
                    tasksDataToStore = aiGeneratedPlan.tasksData;

                    // Ensure refined_prompt_id_associated is correctly set from either direct input or AI flow
                    if (refinedPromptIdForAssociation && planDataToStore) {
                        planDataToStore.refined_prompt_id_associated = refinedPromptIdForAssociation;
                    }


                } catch (error: any) {
                    console.error(`Error during AI plan generation for agent ${agent_id}:`, error);
                    throw new McpError(ErrorCode.InternalError, `AI plan generation failed: ${error.message}`);
                }
            } else if (args.planData && args.tasksData) {
                // Manual plan creation
                planDataToStore = args.planData;
                tasksDataToStore = args.tasksData;
                if (args.planData.refined_prompt_id_associated) {
                     refinedPromptIdForAssociation = args.planData.refined_prompt_id_associated;
                }
            } else {
                throw new McpError(ErrorCode.InvalidParams, "Either AI generation parameters (goal_description or refined_prompt_id) or manual planData and tasksData must be provided.");
            }
            
             // Ensure refined_prompt_id_associated is correctly set from planData if provided manually
            if (args.planData && args.planData.refined_prompt_id_associated && planDataToStore) {
                planDataToStore.refined_prompt_id_associated = args.planData.refined_prompt_id_associated;
            }

            // Ensure suggested_files_involved is present for each task, add if missing
            if (tasksDataToStore) {
                tasksDataToStore = tasksDataToStore.map(task => {
                    if (task.files_involved_json) {
                         try {
                            task.suggested_files_involved = JSON.parse(task.files_involved_json);
                            delete task.files_involved_json; // Remove old field if exists
                         } catch (e) {
                            console.warn(`Failed to parse files_involved_json for task ${task.task_number}: ${e}`);
                            task.suggested_files_involved = task.suggested_files_involved || [];
                         }
                    } else {
                        task.suggested_files_involved = task.suggested_files_involved || [];
                    }
                    return task;
                });
            }


            // Final check and default for title if AI generated and somehow missed
            if (!planDataToStore.title) {
                planDataToStore.title = args.goal_description ? `Plan for: ${args.goal_description.substring(0,50)}...` : 'Untitled AI Plan';
            }


            const planResult = await memoryManager.createPlanWithTasks(agent_id, planDataToStore, tasksDataToStore);
            let md = `## Task Plan Created for Agent: \`${agent_id}\`\n`;
            md += `- **Plan ID:** \`${planResult.plan_id}\`\n`;
            md += `- **Title:** ${planDataToStore.title}\n`;
            if (planDataToStore.overall_goal) md += `- **Overall Goal:** ${planDataToStore.overall_goal}\n`;
            if (planDataToStore.metadata?.estimated_duration_days) md += `- **Est. Duration:** ${planDataToStore.metadata.estimated_duration_days} days\n`;
            if (refinedPromptIdForAssociation) md += `- **Based on Refined Prompt ID:** \`${refinedPromptIdForAssociation}\`\n`;
            md += `- **Task IDs Created:** ${planResult.task_ids.map(id => `\`${id}\``).join(', ')}\n`;
            if (aiGeneratedPlan?.suggested_next_steps_for_agent) {
                md += `\n${aiGeneratedPlan.suggested_next_steps_for_agent.replace(/\[agent_id\]/g, agent_id).replace(/\[plan_id\]/g, planResult.plan_id)}\n`;
            }
            return { content: [{ type: 'text', text: md }] };
        },
        'get_task_plan_details': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for get_task_plan_details.");
            }
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
        'list_task_plans': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for list_task_plans.");
            }
            const validationResult = validate('listTaskPlans', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }
            const plans = await memoryManager.getPlans(agent_id, args.status_filter, args.limit, args.offset);
            plans.sort((a: any, b: any) => (b.creation_timestamp_unix || 0) - (a.creation_timestamp_unix || 0));
            let title = `Task Plans for Agent: \`${agent_id}\``;
            if (args.status_filter) title += ` (Status: ${args.status_filter})`;
            return { content: [{ type: 'text', text: `## ${title}\n\n${formatPlansListToMarkdownTable(plans as any[])}` }] };
        },
        'get_plan_tasks': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for get_plan_tasks.");
            }
            const validationResult = validate('getPlanTasks', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }
            const tasks = await memoryManager.getPlanTasks(agent_id, args.plan_id, args.status_filter, args.limit, args.offset);
            for (const task of tasks as any[]) {
                task.subtasks = await memoryManager.subtaskManager.getSubtasksByParentTask(agent_id, task.task_id, args.status_filter);
            }
            let title = `Tasks for Plan: \`${args.plan_id}\` (Agent: \`${agent_id}\`)`;
            if (args.status_filter) title += ` (Status: ${args.status_filter})`;
            return { content: [{ type: 'text', text: `## ${title}\n\n${formatTasksListToMarkdownTable(tasks as any[], true)}` }] };
        },
        'update_task_plan_status': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for update_task_plan_status.");
            }
            const validationResult = validate('updateTaskPlanStatus', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }
            const success = await memoryManager.updatePlanStatus(agent_id, args.plan_id, args.new_status);
            const message = success ? `Plan \`${args.plan_id}\` status updated to \`${args.new_status}\`.` : `Failed to update status for plan \`${args.plan_id}\`.`;
            return { content: [{ type: 'text', text: formatSimpleMessage(message, "Update Plan Status") }] };
        },
        'update_task_details': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for update_task_details.");
            }
            const validationResult = validate('updateTaskDetails', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }
            const { task_id, completion_timestamp, ...updates } = args;
            const success = await memoryManager.updateTaskDetails(agent_id, task_id, updates, completion_timestamp);
            let message;
            if (success) {
                const updatedKeys = Object.keys(updates).filter(key => key !== 'completion_timestamp' && key !== 'task_id' && key !== 'agent_id');
                if (updatedKeys.length === 1 && updatedKeys[0] === 'status') {
                    message = `Task \`${task_id}\` status updated to \`${updates.status}\`.`;
                } else if (updatedKeys.length > 0) {
                    message = `Task \`${task_id}\` details (${updatedKeys.join(', ')}) updated.`;
                } else {
                    message = `Task \`${task_id}\` updated.`;
                }
            } else {
                message = `Failed to update details for task \`${task_id}\`.`;
            }
            return { content: [{ type: 'text', text: formatSimpleMessage(message, "Update Task Details") }] };
        },
        'delete_task_plans': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for delete_task_plans.");
            }
            const validationResult = validate('deleteTaskPlans', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }
            const success = await memoryManager.deletePlans(agent_id, args.plan_ids);
            const message = success ? `Plans \`${args.plan_ids.join(', ')}\` and their associated tasks/subtasks deleted.` : `Failed to delete plans \`${args.plan_ids.join(', ')}\`.`;
            return { content: [{ type: 'text', text: formatSimpleMessage(message, "Delete Plans") }] };
        },
        'delete_tasks': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for delete_tasks.");
            }
            const validationResult = validate('deleteTasks', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }
            const success = await memoryManager.deleteTasks(agent_id, args.task_ids);
            const message = success ? `Tasks \`${args.task_ids.join(', ')}\` and their associated subtasks deleted.` : `Failed to delete tasks \`${args.task_ids.join(', ')}\`.`;
            return { content: [{ type: 'text', text: formatSimpleMessage(message, "Delete Tasks") }] };
        },
        'add_task_to_plan': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for add_task_to_plan.");
            }
            const validationResult = validate('addTaskToPlan', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }
            const task_id = await memoryManager.addTaskToPlan(agent_id, args.plan_id, args.taskData);
            return { content: [{ type: 'text', text: formatSimpleMessage(`Task added to plan \`${args.plan_id}\` with ID: \`${task_id}\``, "Task Added") }] };
        },
        'add_subtask_to_plan': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for add_subtask_to_plan.");
            }
            const validationResult = validate('addSubtaskToPlan', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }
            if (Array.isArray(args.subtaskData) && args.subtaskData.length > 0) { // Check for singular subtaskData being an array
                // Batch add multiple subtasks
                const subtasksWithParent = args.subtaskData.map((subtask: any) => ({
                    ...subtask,
                    parent_task_id: args.parent_task_id || subtask.parent_task_id
                }));
                const subtask_ids = await memoryManager.subtaskManager.createSubtasks(agent_id, args.plan_id, subtasksWithParent);
                let message = `Added ${subtask_ids.length} subtasks to plan \`${args.plan_id}\`. IDs: ${subtask_ids.map((id: string) => `\`${id}\``).join(', ')}.`;
                if (args.parent_task_id) message += ` Parent task ID: \`${args.parent_task_id}\`.`;
                return { content: [{ type: 'text', text: formatSimpleMessage(message, "Subtasks Added") }] };
            } else {
                // Single subtask fallback
                const subtask_id = await memoryManager.subtaskManager.createSubtask(agent_id, args.plan_id, { ...args.subtaskData, parent_task_id: args.parent_task_id });
                let message = `Subtask added to plan \`${args.plan_id}\` with ID: \`${subtask_id}\`.`;
                if (args.parent_task_id) message += ` Parent task ID: \`${args.parent_task_id}\`.`;
                return { content: [{ type: 'text', text: formatSimpleMessage(message, "Subtask Added") }] };
            }
        },
        'get_subtasks': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for get_subtasks.");
            }
            const validationResult = validate('getSubtasks', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }
            if (!args.plan_id && !args.parent_task_id) {
                throw new McpError(ErrorCode.InvalidParams, "Either plan_id or parent_task_id must be provided for get_subtasks.");
            }

            let subtasks;
            let title = `Subtasks for Agent: \`${agent_id}\``;

            if (args.plan_id && args.parent_task_id) {
                subtasks = await memoryManager.subtaskManager.getSubtasksByPlanAndParentTask(agent_id, args.plan_id, args.parent_task_id, args.status_filter, args.limit, args.offset);
                title += ` (Plan: \`${args.plan_id}\`, Parent Task: \`${args.parent_task_id}\`)`;
            } else if (args.plan_id) {
                subtasks = await memoryManager.subtaskManager.getSubtasksByPlan(agent_id, args.plan_id, args.status_filter, args.limit, args.offset);
                title += ` (Plan: \`${args.plan_id}\`)`;
            } else if (args.parent_task_id) { // Ensured by earlier check that at least one is present
                subtasks = await memoryManager.subtaskManager.getSubtasksByParentTask(agent_id, args.parent_task_id, args.status_filter, args.limit, args.offset);
                title += ` (Parent Task: \`${args.parent_task_id}\`)`;
            }
            if (args.status_filter) title += ` (Status: ${args.status_filter})`;
            return { content: [{ type: 'text', text: `## ${title}\n\n${formatSubtasksListToMarkdownTable(subtasks as any[])}` }] };
        },
        'update_subtask_details': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for update_subtask_details.");
            }
            const validationResult = validate('updateSubtaskDetails', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }
            const { subtask_id, completion_timestamp, ...updates } = args;
            const success = await memoryManager.subtaskManager.updateSubtaskDetails(agent_id, subtask_id, updates, completion_timestamp);
            let message;
            if (success) {
                const updatedKeys = Object.keys(updates).filter(key => key !== 'completion_timestamp' && key !== 'subtask_id' && key !== 'agent_id');
                if (updatedKeys.length === 1 && updatedKeys[0] === 'status') {
                    message = `Subtask \`${subtask_id}\` status updated to \`${updates.status}\`.`;
                } else if (updatedKeys.length > 0) {
                    message = `Subtask \`${subtask_id}\` details (${updatedKeys.join(', ')}) updated.`;
                } else {
                    message = `Subtask \`${subtask_id}\` updated.`;
                }
            } else {
                message = `Failed to update details for subtask \`${subtask_id}\`.`;
            }
            return { content: [{ type: 'text', text: formatSimpleMessage(message, "Update Subtask Details") }] };
        },
        'delete_subtasks': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for delete_subtasks.");
            }
            const validationResult = validate('deleteSubtasks', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }
            const success = await memoryManager.subtaskManager.deleteSubtasks(agent_id, args.subtask_ids);
            const message = success ? `Subtasks \`${args.subtask_ids.join(', ')}\` deleted.` : `Failed to delete subtasks \`${args.subtask_ids.join(', ')}\`.`;
            return { content: [{ type: 'text', text: formatSimpleMessage(message, "Delete Subtasks") }] };
        },
    };
}
