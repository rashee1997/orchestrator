import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { MemoryManager } from '../database/memory_manager.js';
import { CodebaseContextRetrieverService } from '../database/services/CodebaseContextRetrieverService.js';
import { GeminiIntegrationService } from '../database/services/GeminiIntegrationService.js';
import { PlanTaskManager } from '../database/managers/PlanTaskManager.js';
import { SubtaskManager } from '../database/managers/SubtaskManager.js';
import { TaskProgressLogManager } from '../database/managers/TaskProgressLogManager.js';
import { TaskProgressLog } from '../types/index.js';
import { formatJsonToMarkdownCodeBlock, formatPlanToMarkdown, formatSimpleMessage } from '../utils/formatters.js';
import { schemas, validate } from '../utils/validation.js';

// #region Type Definitions
interface AiSuggestedSubtask {
    suggested_title: string;
    suggested_description?: string;
    rationale?: string;
    estimated_effort_hours?: number;
    potential_tools?: string[];
    suggested_dependencies_subtask_titles?: string[];
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
    overall_coherence_score?: number;
    clarity_of_goal_score?: number;
    actionability_of_tasks_score?: number;
    completeness_score?: number;
    identified_strengths?: string[];
    potential_risks_or_issues?: Array<{ risk: string; mitigation_suggestion?: string; related_tasks?: string[] }>;
    missing_tasks_or_steps?: string[];
    dependency_concerns?: string[];
    resource_allocation_comments?: string;
    suggestions_for_improvement?: string[];
    codebase_context_impact?: string;
    overall_summary: string;
}

interface AiTaskProgressSummary {
    plan_id: string;
    task_id?: string;
    overall_status_assessment: string;
    key_accomplishments: string[];
    identified_blockers_or_issues: string[];
    next_steps_or_outlook: string;
    estimated_completion_percentage?: number;
    confidence_in_current_timeline?: string;
    detailed_summary_text: string;
}
// #endregion

// #region Helper Functions
/**
 * A helper function to call the Gemini API and parse the expected JSON response.
 * It handles responses that are either raw JSON or a JSON object wrapped in a markdown code block.
 * @param geminiService The Gemini integration service instance.
 * @param prompt The prompt to send to the AI.
 * @param model The model to use for the request.
 * @returns A promise that resolves to the parsed JSON object.
 * @throws {Error} if the AI response is not valid JSON.
 */
async function callGeminiAndParseJson<T>(
    geminiService: GeminiIntegrationService,
    prompt: string,
    model: string = "gemini-2.5-flash-preview-05-20"
): Promise<T> {
    const geminiResponse = await geminiService.askGemini(prompt, model);
    const responseText = geminiResponse.content[0]?.text?.trim() || "";

    // Attempt to extract JSON from a markdown code block first
    const jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/);
    let jsonToParse = jsonMatch ? jsonMatch[1].trim() : responseText;

    // If it's not a valid JSON string, try to find the start and end of a JSON object/array
    if (!(jsonToParse.startsWith('{') && jsonToParse.endsWith('}')) && !(jsonToParse.startsWith('[') && jsonToParse.endsWith(']'))) {
        const startIndex = jsonToParse.startsWith('[') ? jsonToParse.indexOf('[') : jsonToParse.indexOf('{');
        const endIndex = jsonToParse.endsWith(']') ? jsonToParse.lastIndexOf(']') : jsonToParse.lastIndexOf('}');

        if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
            jsonToParse = jsonToParse.substring(startIndex, endIndex + 1);
        } else {
            throw new Error("AI response was not in the expected JSON format or wrapped in a markdown block.");
        }
    }

    try {
        return JSON.parse(jsonToParse) as T;
    } catch (e: any) {
        console.error("Failed to parse JSON response from AI:", jsonToParse);
        throw new Error(`Failed to parse AI response as JSON: ${e.message}`);
    }
}
// #endregion

// #region Tool Definitions
const aiSuggestSubtasksToolDefinition = {
    name: 'ai_suggest_subtasks',
    description: 'Given a parent task\'s ID and details, uses an AI model (Gemini) to suggest a list of actionable subtasks. Considers existing codebase context if available and relevant. Output is a list of suggested subtask titles and descriptions in Markdown format. Note: The recommended limit for max_suggestions is 2-3 to reduce redundancy.',
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
// #endregion

// #region Tool Handlers

async function aiSuggestSubtasksHandler(args: any, memoryManager: MemoryManager): Promise<{ content: { type: string; text: string }[] }> {
    const validationResult = validate('aiSuggestSubtasks', args);
    if (!validationResult.valid) {
        throw new McpError(ErrorCode.InvalidParams, `Validation failed for ai_suggest_subtasks: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
    }

    const { agent_id, plan_id, parent_task_id, max_suggestions = 5, codebase_context_summary } = args;
    let { parent_task_title, parent_task_description } = args;

    // 1. Get services
    const subtaskManager = memoryManager.subtaskManager;
    const planTaskManager = memoryManager.planTaskManager;
    const geminiService = memoryManager.getGeminiIntegrationService();
    const codebaseContextRetriever = memoryManager.getCodebaseContextRetrieverService();

    // 2. Check for existing subtasks
    const existingSubtasks = await subtaskManager.getSubtasksByParentTask(agent_id, parent_task_id);
    if (existingSubtasks && existingSubtasks.length > 0) {
        return { content: [{ type: 'text', text: formatSimpleMessage(`Subtasks have already been created for this parent task (Task ID: \`${parent_task_id}\`).`, "AI Subtask Suggestions") }] };
    }

    // 3. Fetch parent task details if not provided
    const parentTask = await planTaskManager.getTask(agent_id, parent_task_id);
    if (!parentTask) {
        throw new McpError(ErrorCode.InternalError, `Parent task with ID '${parent_task_id}' not found for agent '${agent_id}'.`);
    }
    parent_task_title = parent_task_title || (parentTask as any).title;
    parent_task_description = parent_task_description || (parentTask as any).description;
    if (!parent_task_title) {
        throw new McpError(ErrorCode.InvalidParams, `Parent task title for task ID '${parent_task_id}' could not be determined.`);
    }

    // 4. Gather codebase context
    let codebaseContext = "";
    if (codebase_context_summary) {
        codebaseContext += `General Codebase Context:\n${codebase_context_summary}\n\n`;
    }
    try {
        const semanticSearchQuery = `${parent_task_title} ${parent_task_description || ''}`;
        const searchResults = await codebaseContextRetriever.retrieveContextForPrompt(agent_id, semanticSearchQuery, { topKEmbeddings: 5, embeddingScoreThreshold: 0.6 });
        if (searchResults && searchResults.length > 0) {
            codebaseContext += "Relevant Codebase Context (Semantic Search):\n";
            searchResults.forEach(result => {
                codebaseContext += `File: \`${result.sourcePath}\` (Score: ${result.relevanceScore?.toFixed(4)})\n`;
                if (result.entityName) codebaseContext += `Entity: ${result.entityName} (${result.type})\n`;
                if (result.metadata?.startLine && result.metadata?.endLine) codebaseContext += `Lines: ${result.metadata.startLine}-${result.metadata.endLine}\n`;
                codebaseContext += `Content:\n\`\`\`${result.metadata?.language || 'text'}\n${result.content}\n\`\`\`\n---\n`;
            });
        }
    } catch (e) {
        console.warn(`Could not perform semantic search for subtask suggestion: ${e}`);
    }

    // 5. Build prompt
    const prompt = `You are an expert project manager AI. Your task is to break down a given parent task into a list of smaller, actionable, and modular subtasks.
Focus on creating subtasks that represent distinct, logical steps. Consider potential dependencies between the subtasks you suggest.
For each subtask, provide a concise title, a brief description, an estimated effort in hours, and optionally, a rationale, potential tools, and dependency titles.

Parent Task Title: "${parent_task_title}"
Parent Task Description: "${parent_task_description || 'No detailed description provided.'}"
Number of subtasks to suggest: ${max_suggestions}
${codebaseContext ? `\nConsider the following codebase context:\n${codebaseContext}` : ''}
Please format your response as a JSON array of objects. Each object must have the following fields:
- "suggested_title": string (concise and actionable)
- "suggested_description": string (optional, 1-2 sentences explaining the subtask)
- "rationale": string (optional, brief reason for this subtask)
- "estimated_effort_hours": number (integer, e.g., 1, 2, 4)
- "potential_tools": array of strings (optional, e.g., ["file_editor", "git_commit"])
- "suggested_dependencies_subtask_titles": array of strings (optional, titles of other suggested subtasks that this one depends on)

Example JSON output:
[
  {
    "suggested_title": "Define data structures for X",
    "suggested_description": "Create TypeScript interfaces for the primary data entities.",
    "rationale": "Ensures type safety and clear data contracts before implementation.",
    "estimated_effort_hours": 2,
    "potential_tools": ["file_editor"]
  },
  {
    "suggested_title": "Implement core logic for Y",
    "suggested_description": "Write the main function that performs the Y operation.",
    "estimated_effort_hours": 4,
    "suggested_dependencies_subtask_titles": ["Define data structures for X"]
  }
]

Provide only the JSON array.`;

    // 6. Get suggestions from AI
    let suggestedSubtasks: AiSuggestedSubtask[];
    try {
        suggestedSubtasks = await callGeminiAndParseJson<AiSuggestedSubtask[]>(geminiService, prompt);
    } catch (error: any) {
        console.error(`Error suggesting subtasks for task ${parent_task_id} (agent: ${agent_id}):`, error);
        throw new McpError(ErrorCode.InternalError, `Failed to get subtask suggestions from AI: ${error.message}`);
    }

    if (!Array.isArray(suggestedSubtasks) || suggestedSubtasks.length === 0) {
        return { content: [{ type: 'text', text: formatSimpleMessage(`No subtasks were suggested by the AI for task: "${parent_task_title}".`, "AI Subtask Suggestions") }] };
    }

    // 7. Format output
    let markdownOutput = `## AI Suggested Subtasks for: "${parent_task_title}" (Task ID: \`${parent_task_id}\`)\n\n`;
    suggestedSubtasks.forEach((subtask, index) => {
        markdownOutput += `### Suggestion ${index + 1}: ${subtask.suggested_title}\n`;
        if (subtask.suggested_description) markdownOutput += `- **Description:** ${subtask.suggested_description}\n`;
        if (subtask.rationale) markdownOutput += `- **Rationale:** ${subtask.rationale}\n`;
        if (subtask.estimated_effort_hours !== undefined) markdownOutput += `- **Est. Effort:** ${subtask.estimated_effort_hours} hours\n`;
        if (subtask.potential_tools?.length) markdownOutput += `- **Potential Tools:** ${subtask.potential_tools.map(t => `\`${t}\``).join(', ')}\n`;
        if (subtask.suggested_dependencies_subtask_titles?.length) markdownOutput += `- **Suggested Dependencies:** ${subtask.suggested_dependencies_subtask_titles.map(t => `"${t}"`).join(', ')}\n`;
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

    const { agent_id, plan_id, task_id, codebase_context_summary } = args;
    let { task_title, task_description } = args;

    // 1. Get services and fetch task details
    const planTaskManager = memoryManager.planTaskManager;
    const geminiService = memoryManager.getGeminiIntegrationService();
    if (!task_title) {
        const task = await planTaskManager.getTask(agent_id, task_id);
        if (!task) {
            throw new McpError(ErrorCode.InternalError, `Task with ID '${task_id}' not found for agent '${agent_id}' in plan '${plan_id}'.`);
        }
        task_title = (task as any).title;
        task_description = (task as any).description;
    }
    if (!task_title) {
        throw new McpError(ErrorCode.InvalidParams, `Task title for task ID '${task_id}' could not be determined.`);
    }

    // 2. Build prompt
    const prompt = `You are an expert project planner AI. Your task is to flesh out the details for a given task.
The goal is to provide comprehensive information that would be useful for someone picking up this task.

Task Title: "${task_title}"
Current Task Description: "${task_description || 'No detailed description currently provided.'}"
${codebase_context_summary ? `\nConsider the following relevant codebase context:\n${codebase_context_summary}\n` : ''}
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

Provide only the JSON object.`;

    // 3. Get suggestions from AI
    let suggestedDetails: AiSuggestedTaskDetails;
    try {
        suggestedDetails = await callGeminiAndParseJson<AiSuggestedTaskDetails>(geminiService, prompt);
    } catch (error: any) {
        console.error(`Error suggesting details for task ${task_id} (agent: ${agent_id}):`, error);
        throw new McpError(ErrorCode.InternalError, `Failed to get task detail suggestions from AI: ${error.message}`);
    }

    // 4. Format output
    let markdownOutput = `## AI Suggested Details for Task: "${task_title}" (ID: \`${task_id}\`)\n\n`;
    markdownOutput += `**Plan ID:** \`${plan_id}\`\n\n`;
    if (suggestedDetails.suggested_description) markdownOutput += `### Suggested Description:\n${suggestedDetails.suggested_description}\n\n`;
    if (suggestedDetails.suggested_purpose) markdownOutput += `### Suggested Purpose:\n${suggestedDetails.suggested_purpose}\n\n`;
    if (suggestedDetails.suggested_action_description) markdownOutput += `### Suggested Action Description:\n${suggestedDetails.suggested_action_description}\n\n`;
    if (suggestedDetails.suggested_files_involved?.length) markdownOutput += `**Suggested Files Involved:** ${suggestedDetails.suggested_files_involved.map(f => `\`${f}\``).join(', ')}\n`;
    if (suggestedDetails.suggested_dependencies_task_ids?.length) markdownOutput += `**Suggested Dependencies (Task IDs):** ${suggestedDetails.suggested_dependencies_task_ids.map(d => `\`${d}\``).join(', ')}\n`;
    if (suggestedDetails.suggested_tools_required_list?.length) markdownOutput += `**Suggested Tools Required:** ${suggestedDetails.suggested_tools_required_list.map(t => `\`${t}\``).join(', ')}\n`;
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
    const validationResult = validate('aiAnalyzePlan', args);
    if (!validationResult.valid) {
        throw new McpError(ErrorCode.InvalidParams, `Validation failed for ai_analyze_plan: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
    }

    const { agent_id, plan_id, analysis_focus_areas, codebase_context_summary } = args;

    // 1. Get services and fetch plan data
    const planTaskManager = memoryManager.planTaskManager;
    const subtaskManager = memoryManager.subtaskManager;
    const geminiService = memoryManager.getGeminiIntegrationService();
    const contextRetriever = memoryManager.getCodebaseContextRetrieverService();

    const plan = await planTaskManager.getPlan(agent_id, plan_id);
    if (!plan) {
        throw new McpError(ErrorCode.InternalError, `Plan with ID '${plan_id}' not found for agent '${agent_id}'.`);
    }
    const tasks = await planTaskManager.getPlanTasks(agent_id, plan_id);
    for (const task of tasks as any[]) {
        task.subtasks = await subtaskManager.getSubtasksByParentTask(agent_id, task.task_id);
    }
    const planLevelSubtasks = (await subtaskManager.getSubtasksByPlan(agent_id, plan_id)).filter(st => !(st as any).parent_task_id);
    const planStringRepresentation = formatPlanToMarkdown(plan, tasks as any[], planLevelSubtasks as any[]);

    // 2. Build prompt
    const focusAreas = analysis_focus_areas?.length
        ? analysis_focus_areas.map((area: string) => `- ${area}`).join('\n')
        : `- Overall Coherence and Goal Alignment\n- Clarity and Actionability of Tasks\n- Completeness (Missing Steps/Tasks)\n- Potential Risks and Issues\n- Task Dependencies and Sequencing`;

    const prompt = `You are an expert AI project analyst. Your task is to critically analyze the provided project plan.
The plan includes an overall goal, a list of tasks, and potentially subtasks.

Focus on the following areas during your analysis:
${focusAreas}

Plan Details:
---
${planStringRepresentation}
---
${codebase_context_summary ? `\nConsider the following relevant codebase context:\n${codebase_context_summary}\n---` : ''}
Please provide your analysis as a single JSON object with the following fields. Be thorough and provide actionable insights.

JSON Output Schema:
{
  "plan_id": "${plan_id}",
  "overall_coherence_score": "number (1-10, 10 being best)",
  "clarity_of_goal_score": "number (1-10)",
  "actionability_of_tasks_score": "number (1-10)",
  "completeness_score": "number (1-10, considering if crucial steps are missing)",
  "identified_strengths": ["string"],
  "potential_risks_or_issues": [{"risk": "string", "mitigation_suggestion": "string", "related_tasks": ["string"]}],
  "missing_tasks_or_steps": ["string"],
  "dependency_concerns": ["string"],
  "resource_allocation_comments": "string",
  "suggestions_for_improvement": ["string"],
  "codebase_context_impact": "string (How codebase context influenced this analysis)",
  "overall_summary": "string (A concise overall summary of your analysis)"
}

Provide only the JSON object.`;

    // 3. Get analysis from AI
    let analysisResult: AiPlanAnalysis;
    try {
        analysisResult = await callGeminiAndParseJson<AiPlanAnalysis>(geminiService, prompt);
    } catch (error: any) {
        console.error(`Error analyzing plan ${plan_id} (agent: ${agent_id}):`, error);
        throw new McpError(ErrorCode.InternalError, `Failed to get plan analysis from AI: ${error.message}`);
    }

    // 4. Format output
    let markdownOutput = `## AI Plan Analysis Report for Plan ID: \`${plan_id}\` (Agent: \`${agent_id}\`)\n\n`;
    markdownOutput += `### Overall Summary:\n${analysisResult.overall_summary || 'No overall summary provided.'}\n\n`;
    markdownOutput += "### Scores (out of 10):\n";
    if (analysisResult.overall_coherence_score !== undefined) markdownOutput += `- **Overall Coherence:** ${analysisResult.overall_coherence_score}\n`;
    if (analysisResult.clarity_of_goal_score !== undefined) markdownOutput += `- **Clarity of Goal:** ${analysisResult.clarity_of_goal_score}\n`;
    if (analysisResult.actionability_of_tasks_score !== undefined) markdownOutput += `- **Actionability of Tasks:** ${analysisResult.actionability_of_tasks_score}\n`;
    if (analysisResult.completeness_score !== undefined) markdownOutput += `- **Completeness:** ${analysisResult.completeness_score}\n\n`;

    if (analysisResult.identified_strengths?.length) {
        markdownOutput += "### Identified Strengths:\n" + analysisResult.identified_strengths.map(s => `- ${s}`).join('\n') + "\n\n";
    }
    if (analysisResult.potential_risks_or_issues?.length) {
        markdownOutput += "### Potential Risks or Issues:\n";
        analysisResult.potential_risks_or_issues.forEach(r => {
            markdownOutput += `- **Risk:** ${r.risk}\n`;
            if (r.mitigation_suggestion) markdownOutput += `  - *Mitigation:* ${r.mitigation_suggestion}\n`;
            if (r.related_tasks?.length) markdownOutput += `  - *Related Tasks:* ${r.related_tasks.map(t => `\`${t}\``).join(', ')}\n`;
        });
        markdownOutput += "\n";
    }
    if (analysisResult.missing_tasks_or_steps?.length) {
        markdownOutput += "### Missing Tasks or Steps:\n" + analysisResult.missing_tasks_or_steps.map(m => `- ${m}`).join('\n') + "\n\n";
    }
    if (analysisResult.dependency_concerns?.length) {
        markdownOutput += "### Dependency Concerns:\n" + analysisResult.dependency_concerns.map(d => `- ${d}`).join('\n') + "\n\n";
    }
    if (analysisResult.resource_allocation_comments) markdownOutput += `### Resource Allocation Comments:\n${analysisResult.resource_allocation_comments}\n\n`;
    if (analysisResult.codebase_context_impact) markdownOutput += `### Codebase Context Impact:\n${analysisResult.codebase_context_impact}\n\n`;
    if (analysisResult.suggestions_for_improvement?.length) {
        markdownOutput += "### Suggestions for Improvement:\n" + analysisResult.suggestions_for_improvement.map(s => `- ${s}`).join('\n') + "\n\n";
    }

    return { content: [{ type: 'text', text: markdownOutput }] };
}

async function aiSummarizeTaskProgressHandler(args: any, memoryManager: MemoryManager): Promise<{ content: { type: string; text: string }[] }> {
    const validationResult = validate('aiSummarizeTaskProgress', args);
    if (!validationResult.valid) {
        throw new McpError(ErrorCode.InvalidParams, `Validation failed for ai_summarize_task_progress: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
    }

    const { agent_id, plan_id, task_id, max_logs_to_consider = 50 } = args;

    // 1. Get services and fetch progress logs
    const taskProgressLogManager = memoryManager.taskProgressLogManager;
    const planTaskManager = memoryManager.planTaskManager;
    const geminiService = memoryManager.getGeminiIntegrationService();

    const allAgentLogs = await taskProgressLogManager.getTaskProgressLogsByAgentId(agent_id, max_logs_to_consider * 5);
    const progressLogs = allAgentLogs
        .filter(log => log.associated_plan_id === plan_id && (!task_id || log.associated_task_id === task_id))
        .sort((a, b) => a.execution_timestamp_unix - b.execution_timestamp_unix)
        .slice(-max_logs_to_consider);

    if (progressLogs.length === 0) {
        return { content: [{ type: 'text', text: formatSimpleMessage(`No task progress logs found for Plan ID: \`${plan_id}\`${task_id ? ` (Task ID: \`${task_id}\`)` : ''}.`, "Task Progress Summary") }] };
    }

    let taskTitle = "Overall Plan";
    if (task_id) {
        const task = await planTaskManager.getTask(agent_id, task_id);
        taskTitle = task ? (task as any).title : `Task ID ${task_id}`;
    }

    const formattedLogs = progressLogs.map(log =>
        `Log ID: ${log.progress_log_id}\n` +
        `Task ID: ${log.associated_task_id}\n` +
        `Status: ${log.status_of_step_execution}\n` +
        `Summary/Error: ${log.output_summary_or_error || 'N/A'}\n` +
        `Timestamp: ${new Date(log.execution_timestamp_iso).toLocaleString()}`
    ).join('\n---\n');

    // 2. Build prompt
    const prompt = `You are an expert AI project reporter. Analyze the provided task progress logs and generate a concise summary.
Focus on overall status, key accomplishments, blockers, next steps, and estimated completion.

Target: Summarize progress for ${task_id ? `Task "${taskTitle}" (ID: ${task_id})` : `Plan ID: ${plan_id}`}.

Progress Logs:
---
${formattedLogs}
---

Please provide your summary as a single JSON object.

JSON Output Schema:
{
  "plan_id": "${plan_id}",
  "task_id": ${task_id ? `"${task_id}"` : null},
  "overall_status_assessment": "string",
  "key_accomplishments": ["string"],
  "identified_blockers_or_issues": ["string"],
  "next_steps_or_outlook": "string",
  "estimated_completion_percentage": "number (0-100, optional)",
  "confidence_in_current_timeline": "string ('High', 'Medium', 'Low', optional)",
  "detailed_summary_text": "string (A narrative summary of the progress.)"
}

Provide only the JSON object.`;

    // 3. Get summary from AI
    let progressSummary: AiTaskProgressSummary;
    try {
        progressSummary = await callGeminiAndParseJson<AiTaskProgressSummary>(geminiService, prompt);
    } catch (error: any) {
        console.error(`Error summarizing task progress for plan ${plan_id} (agent: ${agent_id}):`, error);
        throw new McpError(ErrorCode.InternalError, `Failed to get task progress summary from AI: ${error.message}`);
    }

    // 4. Format output
    let markdownOutput = `## AI Task Progress Summary\n\n`;
    markdownOutput += `**Plan ID:** \`${progressSummary.plan_id}\`\n`;
    if (progressSummary.task_id) markdownOutput += `**Task ID:** \`${progressSummary.task_id}\` (Task: "${taskTitle}")\n`;
    markdownOutput += `**Overall Status Assessment:** ${progressSummary.overall_status_assessment || 'Not Assessed'}\n`;
    if (progressSummary.estimated_completion_percentage !== undefined) markdownOutput += `**Estimated Completion:** ${progressSummary.estimated_completion_percentage}%\n`;
    if (progressSummary.confidence_in_current_timeline) markdownOutput += `**Timeline Confidence:** ${progressSummary.confidence_in_current_timeline}\n\n`;

    if (progressSummary.key_accomplishments?.length) {
        markdownOutput += "### Key Accomplishments:\n" + progressSummary.key_accomplishments.map(s => `- ${s}`).join('\n') + "\n\n";
    }
    if (progressSummary.identified_blockers_or_issues?.length) {
        markdownOutput += "### Identified Blockers/Issues:\n" + progressSummary.identified_blockers_or_issues.map(s => `- ${s}`).join('\n') + "\n\n";
    }
    if (progressSummary.next_steps_or_outlook) markdownOutput += `### Next Steps/Outlook:\n${progressSummary.next_steps_or_outlook}\n\n`;
    if (progressSummary.detailed_summary_text) markdownOutput += `### Detailed Summary:\n${progressSummary.detailed_summary_text}\n\n`;


    return { content: [{ type: 'text', text: markdownOutput }] };
}
// #endregion

// #region Exports
export const aiTaskEnhancementToolDefinitions = [
    aiSuggestSubtasksToolDefinition,
    aiSuggestTaskDetailsToolDefinition,
    aiAnalyzePlanToolDefinition,
    aiSummarizeTaskProgressToolDefinition,
];

export function getAiTaskEnhancementToolHandlers(memoryManager: MemoryManager) {
    return {
        'ai_suggest_subtasks': (args: any) => aiSuggestSubtasksHandler(args, memoryManager),
        'ai_suggest_task_details': (args: any) => aiSuggestTaskDetailsHandler(args, memoryManager),
        'ai_analyze_plan': (args: any) => aiAnalyzePlanHandler(args, memoryManager),
        'ai_summarize_task_progress': (args: any) => aiSummarizeTaskProgressHandler(args, memoryManager),
    };
}
// #endregion