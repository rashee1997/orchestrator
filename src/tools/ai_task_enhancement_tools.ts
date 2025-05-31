// src/tools/ai_task_enhancement_tools.ts
import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate, schemas } from '../utils/validation.js';
import { formatSimpleMessage, formatJsonToMarkdownCodeBlock, formatObjectToMarkdown, formatPlanToMarkdown } from '../utils/formatters.js';
import { GeminiIntegrationService } from '../database/services/GeminiIntegrationService.js';
import { PlanTaskManager } from '../database/managers/PlanTaskManager.js';
import { SubtaskManager } from '../database/managers/SubtaskManager.js'; // For fetching subtasks
import { CodebaseContextRetrieverService, RetrievedCodeContext } from '../database/services/CodebaseContextRetrieverService.js';
import { TaskProgressLogManager } from '../database/managers/TaskProgressLogManager.js';
import { TaskProgressLog } from '../types/index.js';

interface AiSuggestedSubtask {
    suggested_title: string;
    suggested_description?: string;
    rationale?: string;
    estimated_effort_hours?: number;
    potential_tools?: string[];
    suggested_dependencies_subtask_titles?: string[]; // Added suggested dependencies
}

interface AiSuggestedTaskDetails {
    task_id: string; 
    suggested_description?: string;
    suggested_purpose?: string;
    suggested_action_description?: string;
    suggested_files_involved?: string[];
    suggested_dependencies_task_ids?: string[];
    suggested_tools_required_list?: string[];
    suggested_inputs_summary?: string;
    suggested_outputs_summary?: string;
    suggested_success_criteria_text?: string;
    suggested_estimated_effort_hours?: number;
    suggested_verification_method?: string;
    rationale_for_suggestions?: string; 
}

interface AiPlanAnalysis {
    plan_id: string;
    overall_coherence_score?: number; // e.g., 1-10
    clarity_of_goal_score?: number;   // e.g., 1-10
    actionability_of_tasks_score?: number; // e.g., 1-10
    completeness_score?: number;      // e.g., 1-10
    identified_strengths?: string[];
    potential_risks_or_issues?: Array<{risk: string; mitigation_suggestion?: string; related_tasks?: string[]}>;
    missing_tasks_or_steps?: string[];
    dependency_concerns?: string[];
    resource_allocation_comments?: string;
    suggestions_for_improvement?: string[];
    codebase_context_impact?: string; // How codebase context influenced the analysis
    overall_summary: string;
}

interface AiTaskProgressSummary {
    plan_id: string;
    task_id?: string; // Optional if summarizing whole plan
    overall_status_assessment: string; // e.g., "On Track", "Slightly Delayed", "Blocked", "Significant Issues"
    key_accomplishments: string[];
    identified_blockers_or_issues: string[];
    next_steps_or_outlook: string;
    estimated_completion_percentage?: number; // 0-100
    confidence_in_current_timeline?: string; // e.g., High, Medium, Low
    detailed_summary_text: string;
}


const aiSuggestSubtasksToolDefinition = {
    name: 'ai_suggest_subtasks',
    description: 'Given a parent task\'s ID and details, uses an AI model (Gemini) to suggest a list of actionable subtasks. Considers existing codebase context if available and relevant. Output is a list of suggested subtask titles and descriptions in Markdown format.',
    inputSchema: schemas.aiSuggestSubtasks,
};

const aiSuggestTaskDetailsToolDefinition = {
    name: 'ai_suggest_task_details',
    description: 'Given a task ID (and optionally its current title/description), uses an AI model (Gemini) to suggest comprehensive details for that task (e.g., detailed description, purpose, success criteria, files involved, tools required). Considers existing codebase context if available. Output is a structured suggestion in Markdown format.',
    inputSchema: schemas.aiSuggestTaskDetails, 
};

const aiAnalyzePlanToolDefinition = {
    name: 'ai_analyze_plan',
    description: 'Analyzes a given task plan (specified by plan_id) for coherence, completeness, potential risks, and areas for improvement using an AI model (Gemini). Can incorporate codebase context. Output is a structured analysis in Markdown format.',
    inputSchema: { // This schema will be added to validation.ts as 'aiAnalyzePlan'
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
            plan_id: { type: 'string', description: 'The ID of the plan to analyze.' },
            analysis_focus_areas: { 
                type: 'array', 
                items: { type: 'string' }, 
                nullable: true,
                description: 'Optional: Specific areas to focus the analysis on (e.g., "risk_assessment", "task_dependencies", "resource_allocation", "goal_alignment").' 
            },
            codebase_context_summary: { type: 'string', description: 'Optional: A summary string of relevant codebase context to consider during plan analysis.', nullable: true },
        },
        required: ['agent_id', 'plan_id'],
        additionalProperties: false,
    },
};

const aiSummarizeTaskProgressToolDefinition = {
    name: 'ai_summarize_task_progress',
    description: 'Retrieves task progress logs for a given plan (and optionally a specific task) and uses an AI model (Gemini) to generate a concise summary of progress, blockers, and overall status. Output is a structured summary in Markdown format.',
    inputSchema: { // This schema will be added to validation.ts as 'aiSummarizeTaskProgress'
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
            plan_id: { type: 'string', description: 'The ID of the plan for which progress is being summarized.' },
            task_id: { type: 'string', description: 'Optional: The ID of a specific task within the plan to focus the summary on. If omitted, summarizes progress for all tasks in the plan.', nullable: true },
            max_logs_to_consider: { type: 'number', default: 50, minimum: 1, maximum: 200, description: 'Maximum number of recent progress logs to consider for the summary.' },
        },
        required: ['agent_id', 'plan_id'],
        additionalProperties: false,
    },
};


async function aiSuggestSubtasksHandler(args: any, memoryManager: MemoryManager): Promise<{ content: { type: string; text: string }[] }> {
    const validationResult = validate('aiSuggestSubtasks', args);
    if (!validationResult.valid) {
        throw new McpError(ErrorCode.InvalidParams, `Validation failed for ai_suggest_subtasks: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
    }

    const {
        agent_id,
        plan_id,
        parent_task_id,
        max_suggestions = 5,
        codebase_context_summary,
    } = args;

    const subtaskManager: SubtaskManager = memoryManager.subtaskManager;

    // Check if subtasks already exist for this parent task
    const existingSubtasksCheck = await subtaskManager.getSubtasksByParentTask(agent_id, parent_task_id);
    if (existingSubtasksCheck && existingSubtasksCheck.length > 0) {
        return { content: [{ type: 'text', text: formatSimpleMessage(`Subtasks have already been created for this parent task (Task ID: \`${parent_task_id}\`).`, "AI Subtask Suggestions") }] };
    }

    let { parent_task_title, parent_task_description } = args;

    const planTaskManager: PlanTaskManager = memoryManager.planTaskManager;
    const geminiService: GeminiIntegrationService = memoryManager.getGeminiIntegrationService();
    const codebaseContextRetriever: CodebaseContextRetrieverService = memoryManager.getCodebaseContextRetrieverService();

    if (!parent_task_title || !parent_task_description) {
        const parentTask = await planTaskManager.getTask(agent_id, parent_task_id);
        if (!parentTask) {
            throw new McpError(ErrorCode.InternalError, `Parent task with ID '${parent_task_id}' not found for agent '${agent_id}'.`);
        }
        parent_task_title = parent_task_title || (parentTask as any).title;
        parent_task_description = parent_task_description || (parentTask as any).description;
    }
    if (!parent_task_title) {
        throw new McpError(ErrorCode.InvalidParams, `Parent task title for task ID '${parent_task_id}' could not be determined and is required for subtask suggestion.`);
    }

    // Fetch existing subtasks for this parent task
    const existingSubtasks = await memoryManager.subtaskManager.getSubtasksByParentTask(agent_id, parent_task_id);
    let existingSubtasksContext = "";
    if (existingSubtasks && existingSubtasks.length > 0) {
        existingSubtasksContext = "Existing Subtasks for this Parent Task:\n";
        existingSubtasks.forEach((subtask: any, index: number) => {
            existingSubtasksContext += `- ${subtask.title}${subtask.description ? ': ' + subtask.description : ''}\n`;
        });
        existingSubtasksContext += "\nAvoid suggesting subtasks that are already listed above.\n\n";
    }


    // Retrieve live code chunks for all files associated with the parent task (if any)
    let liveCodeContext = '';
    let filesToQuery: string[] = [];
    // Try to get files from parent task metadata, or fallback to plan-level context
    const parentTask = await planTaskManager.getTask(agent_id, parent_task_id);
    if (parentTask && (parentTask as any).suggested_files_involved && Array.isArray((parentTask as any).suggested_files_involved)) {
        filesToQuery = (parentTask as any).suggested_files_involved;
    } else if (plan_id) {
        // Optionally, get all files from all tasks in the plan
        const planTasks = await planTaskManager.getPlanTasks(agent_id, plan_id);
        planTasks.forEach((task: any) => {
            if ((task as any).suggested_files_involved && Array.isArray((task as any).suggested_files_involved)) {
                filesToQuery.push(...(task as any).suggested_files_involved);
            }
        });
        filesToQuery = Array.from(new Set(filesToQuery));
    }

    // Perform semantic search on codebase embeddings using task title/description
    let semanticSearchContext = '';
    const semanticSearchQuery = `${parent_task_title} ${parent_task_description || ''}`;
    try {
        const searchResults = await codebaseContextRetriever.retrieveContextForPrompt(agent_id, semanticSearchQuery, { topKEmbeddings: 5, embeddingScoreThreshold: 0.6 }); // Adjust topK and threshold as needed
        if (searchResults && searchResults.length > 0) {
            semanticSearchContext = "Relevant Codebase Context (Semantic Search):\n";
            searchResults.forEach(result => {
                 semanticSearchContext += `File: \`${result.sourcePath}\` (Score: ${result.relevanceScore?.toFixed(4)})\n`;
                 if (result.entityName) semanticSearchContext += `Entity: ${result.entityName} (${result.type})\n`;
                 if (result.metadata?.startLine && result.metadata?.endLine) semanticSearchContext += `Lines: ${result.metadata.startLine}-${result.metadata.endLine}\n`;
                 semanticSearchContext += `Content:\n\`\`\`${result.metadata?.language || 'text'}\n${result.content}\n\`\`\`\n---\n`;
            });
        }
    } catch (e) {
        console.warn(`Could not perform semantic search for subtask suggestion: ${e}`);
    }


    // If files found, retrieve code chunks for those files
    if (filesToQuery.length > 0) {
        const codeChunks: string[] = [];
        for (const filePath of filesToQuery) {
            try {
                const retrievedChunks = await codebaseContextRetriever.retrieveContextForPrompt(agent_id, `Relevant code for subtask suggestion: ${parent_task_title}`, { targetFilePaths: [filePath], topKEmbeddings: 3 });
                retrievedChunks.forEach(chunk => {
                    codeChunks.push(`File: \`${filePath}\`
---
${chunk.content || ''}
---`);
                });
            } catch (e) {
                // Ignore errors for missing files
            }
        }
        if (codeChunks.length > 0) {
            liveCodeContext = "Relevant Code Context (Associated Files):\n" + codeChunks.join('\n\n');
        }
    }


    let prompt = `You are an expert project manager AI. Your task is to break down a given parent task into a list of smaller, actionable, and *modular* subtasks.\n` +
        `Focus on creating subtasks that represent distinct, logical steps and avoid suggesting redundant foundational work if it should be part of a shared service (e.g., a single file extraction service).\n` +
        `Consider potential dependencies between the subtasks you suggest.\n\n` +
        `For each subtask, provide a concise title, a brief description, an estimated effort in hours (integer), and optionally, a short rationale for why it's needed and potential tools to use.\n\n` +
        `Parent Task Title: "${parent_task_title}"\n` +
        `Parent Task Description: "${parent_task_description || 'No detailed description provided.'}"\n` +
        `Number of subtasks to suggest: ${max_suggestions}\n`;

    if (existingSubtasksContext) {
        prompt += `\n${existingSubtasksContext}`;
    }

    if (liveCodeContext) {
        prompt += `\nConsider the following code context from associated files when suggesting subtasks:\n${liveCodeContext}\n`;
    }

    if (semanticSearchContext) {
         prompt += `\nConsider the following relevant codebase context from semantic search when suggesting subtasks:\n${semanticSearchContext}\n`;
    } else if (codebase_context_summary) {
        prompt += `\nConsider the following general codebase context when suggesting subtasks:\n${codebase_context_summary}\n`;
    }


    prompt += `\nPlease format your response as a JSON array of objects. Each object should represent a subtask and have the following fields:\n` +
        `- "suggested_title": string (concise and actionable)\n` +
        `- "suggested_description": string (optional, 1-2 sentences explaining the subtask)\n` +
        `- "rationale": string (optional, brief reason for this subtask)\n` +
        `- "estimated_effort_hours": number (integer, e.g., 1, 2, 4)\n` +
        `- "potential_tools": array of strings (optional, e.g., ["file_editor", "git_commit"])\n` +
        `- "suggested_dependencies_subtask_titles": array of strings (optional, titles of other suggested subtasks that this one depends on)\n\n` + // Added suggested dependencies
        `Example JSON output:\n` +
        `[` +
        `  {` +
        `    "suggested_title": "Define data structures for X",` +
        `    "suggested_description": "Create TypeScript interfaces or classes for the primary data entities involved.",` +
        `    "rationale": "Ensures type safety and clear data contracts before implementation.",` +
        `    "estimated_effort_hours": 2,` +
        `    "potential_tools": ["file_editor"]` +
        `  },` +
        `  {` +
        `    "suggested_title": "Implement core logic for Y",` +
        `    "suggested_description": "Write the main function/method that performs the Y operation.",` +
        `    "estimated_effort_hours": 4,` +
        `    "suggested_dependencies_subtask_titles": ["Define data structures for X"]` + // Example dependency
        `  }` +
        `]\n\n` +
        `Provide only the JSON array.\n`;

    let suggestedSubtasks: AiSuggestedSubtask[] = [];
    try {
        const geminiResponse = await geminiService.askGemini(prompt, "gemini-2.5-flash-preview-05-20");
        const responseText = geminiResponse.content[0]?.text?.trim() || "";
        
        let jsonToParse = responseText;
        const jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/);
        if (jsonMatch && jsonMatch[1]) {
            jsonToParse = jsonMatch[1].trim();
        } else if (!jsonToParse.startsWith("[") || !jsonToParse.endsWith("]")) {
            const startIndex = jsonToParse.indexOf('[');
            const endIndex = jsonToParse.lastIndexOf(']');
            if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
                jsonToParse = jsonToParse.substring(startIndex, endIndex + 1);
            } else {
                console.error("AI Subtask Suggestion: Gemini response was not a JSON array or markdown JSON block.", responseText);
                throw new Error("AI response for subtask suggestions was not in the expected JSON array format.");
            }
        }
        suggestedSubtasks = JSON.parse(jsonToParse);
        if (!Array.isArray(suggestedSubtasks)) {
            console.error("AI Subtask Suggestion: Parsed response is not an array.", suggestedSubtasks);
            throw new Error("AI response for subtask suggestions was not a valid array.");
        }
    } catch (error: any) {
        console.error(`Error suggesting subtasks for task ${parent_task_id} (agent: ${agent_id}):`, error);
        throw new McpError(ErrorCode.InternalError, `Failed to get subtask suggestions from AI: ${error.message}`);
    }

    if (suggestedSubtasks.length === 0) {
        return { content: [{ type: 'text', text: formatSimpleMessage(`No subtasks were suggested by the AI for task: "${parent_task_title}".`, "AI Subtask Suggestions") }] };
    }

    let markdownOutput = `## AI Suggested Subtasks for: "${parent_task_title}" (Task ID: \`${parent_task_id}\`)\n\n`;
    suggestedSubtasks.forEach((subtask, index) => {
        markdownOutput += `### Suggestion ${index + 1}: ${subtask.suggested_title}\n`;
        if (subtask.suggested_description) {
            markdownOutput += `- **Description:** ${subtask.suggested_description}\n`;
        }
        if (subtask.rationale) {
            markdownOutput += `- **Rationale:** ${subtask.rationale}\n`;
        }
        if (subtask.estimated_effort_hours !== undefined) {
            markdownOutput += `- **Est. Effort:** ${subtask.estimated_effort_hours} hours\n`;
        }
        if (subtask.potential_tools && subtask.potential_tools.length > 0) {
            markdownOutput += `- **Potential Tools:** ${subtask.potential_tools.map(t => `\`${t}\``).join(', ')}\n`;
        }
        if ((subtask as any).suggested_dependencies_subtask_titles && (subtask as any).suggested_dependencies_subtask_titles.length > 0) {
             markdownOutput += `- **Suggested Dependencies (Subtask Titles):** ${(subtask as any).suggested_dependencies_subtask_titles.map((t: string) => `"${t}"`).join(', ')}\n`;
        }
        markdownOutput += "\n";
    });
    markdownOutput += `*Note: These are AI suggestions. Review and use the \`add_subtask_to_plan\` tool to create them if appropriate.*`;

    return { content: [{ type: 'text', text: markdownOutput }] };
}

async function aiSuggestTaskDetailsHandler(args: any, memoryManager: MemoryManager): Promise<{ content: { type: string; text: string }[] }> {
    const validationResult = validate('aiSuggestTaskDetails', args);
    if (!validationResult.valid) {
        throw new McpError(ErrorCode.InvalidParams, `Validation failed for ai_suggest_task_details: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
    }

    const {
        agent_id,
        plan_id,
        task_id,
        codebase_context_summary,
    } = args;
    let { task_title, task_description } = args;

    const planTaskManager: PlanTaskManager = memoryManager.planTaskManager;
    const geminiService: GeminiIntegrationService = memoryManager.getGeminiIntegrationService();

    if (!task_title) { 
        const task = await planTaskManager.getTask(agent_id, task_id);
        if (!task) {
            throw new McpError(ErrorCode.InternalError, `Task with ID '${task_id}' not found for agent '${agent_id}' in plan '${plan_id}'.`);
        }
        task_title = task_title || (task as any).title;
        task_description = task_description || (task as any).description; 
    }
    
    if (!task_title) { 
        throw new McpError(ErrorCode.InvalidParams, `Task title for task ID '${task_id}' could not be determined and is required for detail suggestion.`);
    }

    let prompt = `You are an expert project planner AI. Your task is to flesh out the details for a given task.
The goal is to provide comprehensive information that would be useful for someone picking up this task.

Task Title: "${task_title}"
Current Task Description: "${task_description || 'No detailed description currently provided.'}"
`;

    if (codebase_context_summary) {
        prompt += `\nConsider the following relevant codebase context when suggesting details:\n${codebase_context_summary}\n`;
    }

    prompt += `
Please suggest the following details for this task. Format your response as a single JSON object.
If a detail is not applicable or cannot be reasonably inferred, use null or an empty array.

JSON Output Schema:
{
  "task_id": "${task_id}", 
  "suggested_description": "string (A more detailed explanation of what the task involves, expanding on the title and current description. 2-4 sentences.)",
  "suggested_purpose": "string (The reason this task is necessary for the overall plan/goal. 1-2 sentences.)",
  "suggested_action_description": "string (A high-level summary of the primary action(s) to be performed. 1-2 sentences.)",
  "suggested_files_involved": ["string"],
  "suggested_dependencies_task_ids": ["string"],
  "suggested_tools_required_list": ["string"],
  "suggested_inputs_summary": "string (What information or resources are needed to start this task?)",
  "suggested_outputs_summary": "string (What are the expected deliverables or outcomes of this task?)",
  "suggested_success_criteria_text": "string (How will we know this task is completed successfully? Be specific and measurable if possible.)",
  "suggested_estimated_effort_hours": "number (integer, e.g., 1, 2, 4, 8)",
  "suggested_verification_method": "string (How will the completion and correctness of this task be verified?)",
  "rationale_for_suggestions": "string (Briefly explain your reasoning for these suggestions, especially if codebase context was used.)"
}

Provide only the JSON object.
`;

    let suggestedDetails: AiSuggestedTaskDetails;
    try {
        const geminiResponse = await geminiService.askGemini(prompt, "gemini-2.5-flash-preview-05-20");
        const responseText = geminiResponse.content[0]?.text?.trim() || "";
        
        let jsonToParse = responseText;
        const jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/);
        if (jsonMatch && jsonMatch[1]) {
            jsonToParse = jsonMatch[1].trim();
        } else if (!jsonToParse.startsWith("{") || !jsonToParse.endsWith("}")) {
            const startIndex = jsonToParse.indexOf('{');
            const endIndex = jsonToParse.lastIndexOf('}');
            if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
                jsonToParse = jsonToParse.substring(startIndex, endIndex + 1);
            } else {
                console.error("AI Task Detail Suggestion: Gemini response was not a JSON object or markdown JSON block.", responseText);
                throw new Error("AI response for task detail suggestions was not in the expected JSON object format.");
            }
        }
        suggestedDetails = JSON.parse(jsonToParse);
    } catch (error: any) {
        console.error(`Error suggesting details for task ${task_id} (agent: ${agent_id}):`, error);
        throw new McpError(ErrorCode.InternalError, `Failed to get task detail suggestions from AI: ${error.message}`);
    }

    let markdownOutput = `## AI Suggested Details for Task: "${task_title}" (ID: \`${task_id}\`)\n\n`;
    markdownOutput += `**Plan ID:** \`${plan_id}\`\n\n`;

    if (suggestedDetails.suggested_description) markdownOutput += `### Suggested Description:\n${suggestedDetails.suggested_description}\n\n`;
    if (suggestedDetails.suggested_purpose) markdownOutput += `### Suggested Purpose:\n${suggestedDetails.suggested_purpose}\n\n`;
    if (suggestedDetails.suggested_action_description) markdownOutput += `### Suggested Action Description:\n${suggestedDetails.suggested_action_description}\n\n`;
    if (suggestedDetails.suggested_files_involved && suggestedDetails.suggested_files_involved.length > 0) markdownOutput += `**Suggested Files Involved:** ${suggestedDetails.suggested_files_involved.map(f => `\`${f}\``).join(', ')}\n`;
    if (suggestedDetails.suggested_dependencies_task_ids && suggestedDetails.suggested_dependencies_task_ids.length > 0) markdownOutput += `**Suggested Dependencies (Task IDs):** ${suggestedDetails.suggested_dependencies_task_ids.map(d => `\`${d}\``).join(', ')}\n`;
    if (suggestedDetails.suggested_tools_required_list && suggestedDetails.suggested_tools_required_list.length > 0) markdownOutput += `**Suggested Tools Required:** ${suggestedDetails.suggested_tools_required_list.map(t => `\`${t}\``).join(', ')}\n`;
    if (suggestedDetails.suggested_inputs_summary) markdownOutput += `**Suggested Inputs Summary:** ${suggestedDetails.suggested_inputs_summary}\n`;
    if (suggestedDetails.suggested_outputs_summary) markdownOutput += `**Suggested Outputs Summary:** ${suggestedDetails.suggested_outputs_summary}\n`;
    if (suggestedDetails.suggested_success_criteria_text) markdownOutput += `**Suggested Success Criteria:**\n${suggestedDetails.suggested_success_criteria_text}\n\n`;
    if (suggestedDetails.suggested_estimated_effort_hours !== undefined) markdownOutput += `**Suggested Estimated Effort:** ${suggestedDetails.suggested_estimated_effort_hours} hours\n`;
    if (suggestedDetails.suggested_verification_method) markdownOutput += `**Suggested Verification Method:** ${suggestedDetails.suggested_verification_method}\n`;
    if (suggestedDetails.rationale_for_suggestions) markdownOutput += `\n### Rationale for Suggestions:\n${suggestedDetails.rationale_for_suggestions}\n`;
    
    markdownOutput += `\n*Note: These are AI suggestions. Review and use the appropriate plan/task update tools to apply these details if desired.*`;

    return { content: [{ type: 'text', text: markdownOutput }] };
}

async function aiAnalyzePlanHandler(args: any, memoryManager: MemoryManager): Promise<{ content: { type: string; text: string }[] }> {
    const validationResult = validate('aiAnalyzePlan', args); // Schema to be added to validation.ts
    if (!validationResult.valid) {
        throw new McpError(ErrorCode.InvalidParams, `Validation failed for ai_analyze_plan: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
    }

    const {
        agent_id,
        plan_id,
        analysis_focus_areas,
        codebase_context_summary,
    } = args;

    const planTaskManager: PlanTaskManager = memoryManager.planTaskManager;
    const subtaskManager: SubtaskManager = memoryManager.subtaskManager;
    const geminiService: GeminiIntegrationService = memoryManager.getGeminiIntegrationService();
    const contextRetriever: CodebaseContextRetrieverService = memoryManager.getCodebaseContextRetrieverService();

    const plan = await planTaskManager.getPlan(agent_id, plan_id);
    if (!plan) {
        throw new McpError(ErrorCode.InternalError, `Plan with ID '${plan_id}' not found for agent '${agent_id}'.`);
    }
    const tasks = await planTaskManager.getPlanTasks(agent_id, plan_id);
    const allSubtasks: any[] = [];
    for (const task of tasks as any[]) {
        const subtasksForTask = await subtaskManager.getSubtasksByParentTask(agent_id, task.task_id);
        task.subtasks = subtasksForTask; // Attach to task object
        allSubtasks.push(...subtasksForTask);
    }
     const planLevelSubtasks = (await subtaskManager.getSubtasksByPlan(agent_id, plan_id)).filter(st => !(st as any).parent_task_id);


    // Serialize plan and tasks to a string format for the AI
    // Using the existing Markdown formatter for a rich representation
    const planStringRepresentation = formatPlanToMarkdown(plan, tasks as any[], planLevelSubtasks as any[]);


    let effectiveCodebaseContext = codebase_context_summary || "";
    if (!codebase_context_summary) { // If no summary provided, try to derive some context
        const planGoal = (plan as any).overall_goal || (plan as any).title || "";
        if (planGoal) {
            try {
                const retrievedContextItems = await contextRetriever.retrieveContextForPrompt(agent_id, `Context for analyzing plan: ${planGoal}`, { topKEmbeddings: 2, topKKgResults: 1 });
                if (retrievedContextItems.length > 0) {
                    effectiveCodebaseContext = "Automatically Retrieved Codebase Context Hints:\n";
                    retrievedContextItems.forEach(item => {
                        effectiveCodebaseContext += `- ${item.sourcePath}${item.entityName ? '::' + item.entityName : ''} (${item.type})\n`;
                    });
                }
            } catch (e) {
                console.warn(`Could not auto-retrieve codebase context for plan analysis: ${e}`);
            }
        }
    }


    let prompt = `You are an expert AI project analyst. Your task is to critically analyze the provided project plan.
The plan includes an overall goal, a list of tasks, and potentially subtasks.

Focus on the following areas during your analysis:
${analysis_focus_areas && analysis_focus_areas.length > 0 ? analysis_focus_areas.map((area: string) => `- ${area}`).join('\n') :
`- Overall Coherence and Goal Alignment
- Clarity and Actionability of Tasks
- Completeness (Missing Steps/Tasks)
- Potential Risks and Issues
- Task Dependencies and Sequencing
- Resource Allocation (if inferable)
- Suggestions for Improvement`}

Plan Details:
---
${planStringRepresentation}
---
`;

    if (effectiveCodebaseContext) {
        prompt += `\nConsider the following relevant codebase context during your analysis:\n${effectiveCodebaseContext}\n---`;
    }

    prompt += `
Please provide your analysis as a single JSON object with the following fields.
Be thorough and provide actionable insights.

JSON Output Schema:
{
  "plan_id": "${plan_id}", // Echo back the plan_id
  "overall_coherence_score": "number (1-10, 10 being best)",
  "clarity_of_goal_score": "number (1-10)",
  "actionability_of_tasks_score": "number (1-10)",
  "completeness_score": "number (1-10, considering if crucial steps are missing)",
  "identified_strengths": ["string (e.g., 'Clear task descriptions', 'Well-defined goal')"],
  "potential_risks_or_issues": [
    {
      "risk": "string (Description of a potential risk or issue)",
      "mitigation_suggestion": "string (Optional: How to mitigate this risk)",
      "related_tasks": ["string (Optional: Task IDs related to this risk)"]
    }
  ],
  "missing_tasks_or_steps": ["string (Suggestions for tasks or steps that seem to be missing)"],
  "dependency_concerns": ["string (e.g., 'Task 3 seems to depend on Task 5, but is scheduled earlier')"],
  "resource_allocation_comments": "string (General comments on resource needs if inferable, e.g., 'Task X might require specialized knowledge in Y')",
  "suggestions_for_improvement": ["string (Specific, actionable suggestions to improve the plan)"],
  "codebase_context_impact": "string (How the provided codebase context (if any) influenced this analysis, or if more context would be beneficial for certain tasks)",
  "overall_summary": "string (A concise overall summary of your analysis and key recommendations)"
}

Provide only the JSON object.
`;

    let analysisResult: AiPlanAnalysis;
    try {
        const geminiResponse = await geminiService.askGemini(prompt, "gemini-2.5-flash-preview-05-20"); // Using a capable model
        const responseText = geminiResponse.content[0]?.text?.trim() || "";
        
        let jsonToParse = responseText;
        const jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/);
        if (jsonMatch && jsonMatch[1]) {
            jsonToParse = jsonMatch[1].trim();
        } else if (!jsonToParse.startsWith("{") || !jsonToParse.endsWith("}")) {
             const startIndex = jsonToParse.indexOf('{');
            const endIndex = jsonToParse.lastIndexOf('}');
            if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
                jsonToParse = jsonToParse.substring(startIndex, endIndex + 1);
            } else {
                console.error("AI Plan Analysis: Gemini response was not a JSON object or markdown JSON block.", responseText);
                throw new Error("AI response for plan analysis was not in the expected JSON object format.");
            }
        }
        analysisResult = JSON.parse(jsonToParse);
    } catch (error: any) {
        console.error(`Error analyzing plan ${plan_id} (agent: ${agent_id}):`, error);
        throw new McpError(ErrorCode.InternalError, `Failed to get plan analysis from AI: ${error.message}`);
    }

    let markdownOutput = `## AI Plan Analysis Report for Plan ID: \`${plan_id}\` (Agent: \`${agent_id}\`)\n\n`;
    markdownOutput += `### Overall Summary:\n${analysisResult.overall_summary || 'No overall summary provided.'}\n\n`;

    markdownOutput += "### Scores (out of 10):\n";
    if (analysisResult.overall_coherence_score !== undefined) markdownOutput += `- **Overall Coherence:** ${analysisResult.overall_coherence_score}\n`;
    if (analysisResult.clarity_of_goal_score !== undefined) markdownOutput += `- **Clarity of Goal:** ${analysisResult.clarity_of_goal_score}\n`;
    if (analysisResult.actionability_of_tasks_score !== undefined) markdownOutput += `- **Actionability of Tasks:** ${analysisResult.actionability_of_tasks_score}\n`;
    if (analysisResult.completeness_score !== undefined) markdownOutput += `- **Completeness:** ${analysisResult.completeness_score}\n\n`;

    if (analysisResult.identified_strengths && analysisResult.identified_strengths.length > 0) {
        markdownOutput += "### Identified Strengths:\n";
        analysisResult.identified_strengths.forEach(s => markdownOutput += `- ${s}\n`);
        markdownOutput += "\n";
    }

    if (analysisResult.potential_risks_or_issues && analysisResult.potential_risks_or_issues.length > 0) {
        markdownOutput += "### Potential Risks or Issues:\n";
        analysisResult.potential_risks_or_issues.forEach(r => {
            markdownOutput += `- **Risk:** ${r.risk}\n`;
            if (r.mitigation_suggestion) markdownOutput += `  - *Mitigation:* ${r.mitigation_suggestion}\n`;
            if (r.related_tasks && r.related_tasks.length > 0) markdownOutput += `  - *Related Tasks:* ${r.related_tasks.map(t => `\`${t}\``).join(', ')}\n`;
        });
        markdownOutput += "\n";
    }
    
    if (analysisResult.missing_tasks_or_steps && analysisResult.missing_tasks_or_steps.length > 0) {
        markdownOutput += "### Missing Tasks or Steps:\n";
        analysisResult.missing_tasks_or_steps.forEach(m => markdownOutput += `- ${m}\n`);
        markdownOutput += "\n";
    }

    if (analysisResult.dependency_concerns && analysisResult.dependency_concerns.length > 0) {
        markdownOutput += "### Dependency Concerns:\n";
        analysisResult.dependency_concerns.forEach(d => markdownOutput += `- ${d}\n`);
        markdownOutput += "\n";
    }
    
    if (analysisResult.resource_allocation_comments) markdownOutput += `### Resource Allocation Comments:\n${analysisResult.resource_allocation_comments}\n\n`;
    if (analysisResult.codebase_context_impact) markdownOutput += `### Codebase Context Impact:\n${analysisResult.codebase_context_impact}\n\n`;

    if (analysisResult.suggestions_for_improvement && analysisResult.suggestions_for_improvement.length > 0) {
        markdownOutput += "### Suggestions for Improvement:\n";
        analysisResult.suggestions_for_improvement.forEach(s => markdownOutput += `- ${s}\n`);
        markdownOutput += "\n";
    }
    
    return { content: [{ type: 'text', text: markdownOutput }] };
}

async function aiSummarizeTaskProgressHandler(args: any, memoryManager: MemoryManager): Promise<{ content: { type: string; text: string }[] }> {
    const validationResult = validate('aiSummarizeTaskProgress', args); // Schema to be added
    if (!validationResult.valid) {
        throw new McpError(ErrorCode.InvalidParams, `Validation failed for ai_summarize_task_progress: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
    }

    const {
        agent_id,
        plan_id,
        task_id, // Optional
        max_logs_to_consider = 50,
    } = args;

    const taskProgressLogManager: TaskProgressLogManager = memoryManager.taskProgressLogManager;
    const planTaskManager: PlanTaskManager = memoryManager.planTaskManager;
    const geminiService: GeminiIntegrationService = memoryManager.getGeminiIntegrationService();

    let progressLogs: TaskProgressLog[] = [];
    let taskTitle = "Overall Plan";

    const allAgentLogs = await taskProgressLogManager.getTaskProgressLogsByAgentId(agent_id, max_logs_to_consider * 5);

    if (task_id) {
        progressLogs = allAgentLogs
            .filter(log => log.associated_plan_id === plan_id && log.associated_task_id === task_id)
            .slice(0, max_logs_to_consider);
        
        const task = await planTaskManager.getTask(agent_id, task_id);
        taskTitle = task ? (task as any).title : `Task ID ${task_id}`;
    } else {
        progressLogs = allAgentLogs
            .filter(log => log.associated_plan_id === plan_id)
            .slice(0, max_logs_to_consider);
    }

    progressLogs.sort((a, b) => a.execution_timestamp_unix - b.execution_timestamp_unix);

    if (progressLogs.length === 0) {
        return { content: [{ type: 'text', text: formatSimpleMessage(`No task progress logs found for Plan ID: \`${plan_id}\`${task_id ? ` (Task ID: \`${task_id}\`)` : ''}.`, "Task Progress Summary") }] };
    }

    const formattedLogs = progressLogs.map(log => {
        return `Log ID: ${log.progress_log_id}
Task ID: ${log.associated_task_id}
Subtask ID: ${log.associated_subtask_id || 'N/A'}
Step: ${log.plan_step_title || log.step_number_executed || 'N/A'}
Tool: ${log.action_tool_used || 'N/A'}
Status: ${log.status_of_step_execution}
Summary/Error: ${log.output_summary_or_error || 'N/A'}
Change: ${log.change_summary_text || 'N/A'}
Timestamp: ${new Date(log.execution_timestamp_iso).toLocaleString()}`;
    }).join('\n---\n');

    let prompt = `You are an expert AI project reporter. Your task is to analyze the provided task progress logs and generate a concise summary.

Focus on the following when creating your summary:
- Overall status assessment (e.g., On Track, Delayed, Blocked).
- Key accomplishments or milestones reached.
- Any identified blockers, issues, or significant errors.
- Suggested next steps or outlook based on the progress.
- An estimated completion percentage (if inferable).
- Confidence in the current timeline (High, Medium, Low).

Target: Summarize progress for ${task_id ? `Task "${taskTitle}" (ID: ${task_id})` : `Plan ID: ${plan_id}`}.

Progress Logs:
---
${formattedLogs}
---

Please provide your summary as a single JSON object with the following fields:
{
  "plan_id": "${plan_id}",
  "task_id": ${task_id ? `"${task_id}"` : null},
  "overall_status_assessment": "string",
  "key_accomplishments": ["string"],
  "identified_blockers_or_issues": ["string"],
  "next_steps_or_outlook": "string",
  "estimated_completion_percentage": "number (0-100, optional)",
  "confidence_in_current_timeline": "string ('High', 'Medium', 'Low', optional)",
  "detailed_summary_text": "string (A narrative summary of the progress, including key events, successes, and challenges.)"
}

Provide only the JSON object.
`;

    let progressSummary: AiTaskProgressSummary;
    try {
        const geminiResponse = await geminiService.askGemini(prompt, "gemini-2.5-flash-preview-05-20");
        const responseText = geminiResponse.content[0]?.text?.trim() || "";
        
        let jsonToParse = responseText;
        const jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/);
        if (jsonMatch && jsonMatch[1]) {
            jsonToParse = jsonMatch[1].trim();
        } else if (!jsonToParse.startsWith("{") || !jsonToParse.endsWith("}")) {
            const startIndex = jsonToParse.indexOf('{');
            const endIndex = jsonToParse.lastIndexOf('}');
            if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
                jsonToParse = jsonToParse.substring(startIndex, endIndex + 1);
            } else {
                console.error("AI Task Progress Summary: Gemini response was not a JSON object or markdown JSON block.", responseText);
                throw new Error("AI response for task progress summary was not in the expected JSON object format.");
            }
        }
        progressSummary = JSON.parse(jsonToParse);
    } catch (error: any) {
        console.error(`Error summarizing task progress for plan ${plan_id} (agent: ${agent_id}):`, error);
        throw new McpError(ErrorCode.InternalError, `Failed to get task progress summary from AI: ${error.message}`);
    }

    let markdownOutput = `## AI Task Progress Summary\n\n`;
    markdownOutput += `**Plan ID:** \`${progressSummary.plan_id}\`\n`;
    if (progressSummary.task_id) markdownOutput += `**Task ID:** \`${progressSummary.task_id}\` (Task: "${taskTitle}")\n`;
    markdownOutput += `**Overall Status Assessment:** ${progressSummary.overall_status_assessment || 'Not Assessed'}\n`;
    if (progressSummary.estimated_completion_percentage !== undefined) markdownOutput += `**Estimated Completion:** ${progressSummary.estimated_completion_percentage}%\n`;
    if (progressSummary.confidence_in_current_timeline) markdownOutput += `**Timeline Confidence:** ${progressSummary.confidence_in_current_timeline}\n\n`;

    if (progressSummary.key_accomplishments && progressSummary.key_accomplishments.length > 0) {
        markdownOutput += "### Key Accomplishments:\n";
        progressSummary.key_accomplishments.forEach(s => markdownOutput += `- ${s}\n`);
        markdownOutput += "\n";
    }

    if (progressSummary.identified_blockers_or_issues && progressSummary.identified_blockers_or_issues.length > 0) {
        markdownOutput += "### Identified Blockers/Issues:\n";
        progressSummary.identified_blockers_or_issues.forEach(s => markdownOutput += `- ${s}\n`);
        markdownOutput += "\n";
    }

    if (progressSummary.next_steps_or_outlook) markdownOutput += `### Next Steps/Outlook:\n${progressSummary.next_steps_or_outlook}\n\n`;

    return { content: [{ type: 'text', text: markdownOutput }] };
}


export const aiTaskEnhancementToolDefinitions = [
    aiSuggestSubtasksToolDefinition,
    aiSuggestTaskDetailsToolDefinition,
    aiAnalyzePlanToolDefinition,
    aiSummarizeTaskProgressToolDefinition, // Added
];

export function getAiTaskEnhancementToolHandlers(memoryManager: MemoryManager) {
    return {
        'ai_suggest_subtasks': (args: any) => aiSuggestSubtasksHandler(args, memoryManager),
        'ai_suggest_task_details': (args: any) => aiSuggestTaskDetailsHandler(args, memoryManager),
        'ai_analyze_plan': (args: any) => aiAnalyzePlanHandler(args, memoryManager),
        'ai_summarize_task_progress': (args: any) => aiSummarizeTaskProgressHandler(args, memoryManager), // Added
    };
}

