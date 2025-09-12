import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { MemoryManager } from '../database/memory_manager.js';
import { CodebaseContextRetrieverService } from '../database/services/CodebaseContextRetrieverService.js';
import { GeminiIntegrationService } from '../database/services/GeminiIntegrationService.js';
import { PlanTaskManager, ParsedTask } from '../database/managers/PlanTaskManager.js';
import { SubtaskManager } from '../database/managers/SubtaskManager.js';
import { formatJsonToMarkdownCodeBlock, formatPlanToMarkdown, formatSimpleMessage } from '../utils/formatters.js';
import { schemas, validate } from '../utils/validation.js';
import {
    AI_SUGGEST_SUBTASKS_PROMPT,
    AI_TASK_COMPLEXITY_ANALYSIS_PROMPT,
    AI_SUGGEST_TASK_DETAILS_PROMPT,
    AI_ANALYZE_PLAN_PROMPT
} from '../database/services/gemini-integration-modules/GeminiPromptTemplates.js';
import { parseGeminiJsonResponse } from '../database/services/gemini-integration-modules/GeminiResponseParsers.js';
import { getCurrentModel } from '../database/services/gemini-integration-modules/GeminiConfig.js';

// #region Type Definitions
interface AiSuggestedSubtask {
    suggested_title: string;
    suggested_description?: string;
    rationale?: string;
    estimated_effort_hours?: number;
    potential_tools?: string[];
    dependencies_parent_task_ids?: string[];
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

interface TaskComplexityAnalysis {
    task_id: string;
    title: string;
    complexity_score: number; // 1-10 scale
    complexity_factors: string[];
    reasoning: string;
    recommended_action: 'HIGH_COMPLEXITY_SUBTASKS' | 'MEDIUM_COMPLEXITY_SUBTASKS' | 'LOW_COMPLEXITY_NO_SUBTASKS' | 'SKIP_COMPLETELY';
}
// #endregion

// #region Helper Functions
async function callGeminiAndParseJson<T>(
    geminiService: GeminiIntegrationService,
    prompt: string,
    model: string = getCurrentModel()
): Promise<T> {
    const geminiResponse = await geminiService.askGemini(prompt, model);
    const responseText = geminiResponse.content[0]?.text ?? "";
    try {
        return parseGeminiJsonResponse(responseText) as T;
    } catch (e: any) {
        console.error("Failed to parse JSON response from AI:", responseText);
        throw new Error(`Failed to parse AI response as JSON: ${e.message}`);
    }
}
// #endregion

// #region Tool Definitions
const aiSuggestSubtasksToolDefinition = {
    name: 'ai_suggest_subtasks',
    description: 'Given a parent task\'s ID, uses an AI model to suggest a list of actionable subtasks. It analyzes all other tasks in the plan to suggest logical dependencies. Output is a list of suggested subtasks in Markdown format.',
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
    inputSchema: {
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
// #endregion

// #region Tool Handler Core Logic

/**
 * Generates subtask suggestions for a single, specified parent task.
 * @returns An object containing the markdown report and the list of subtasks to create.
 */
async function _generateSubtasksForParent(
    agent_id: string,
    plan_id: string,
    parentTask: ParsedTask,
    allTasksInPlan: ParsedTask[],
    max_suggestions: number,
    geminiService: GeminiIntegrationService
): Promise<{ markdown: string; subtasksToCreate: any[] }> {
    const otherTasksInPlan = allTasksInPlan
        .filter(t => t.task_id !== parentTask.task_id)
        .map(t => ({ task_id: t.task_id, title: t.title }));

    const jsonOutputSchemaInstructions = `
Each subtask object in the array must have the following fields:
- "suggested_title": string (concise and actionable)
- "suggested_description": string (optional, 1-2 sentences explaining the subtask's goal)
- "dependencies_parent_task_ids": array of strings (optional, list the \`task_id\` of any tasks from the **Other Tasks** list that this subtask depends on)

Provide only the JSON array. Do not include any other text or markdown.`;

    const prompt = AI_SUGGEST_SUBTASKS_PROMPT
        .replace('{taskId}', parentTask.task_id)
        .replace('{taskTitle}', parentTask.title)
        .replace('{taskDescription}', parentTask.description || 'No detailed description provided.')
        .replace('{otherTasksContext}', otherTasksInPlan.length > 0 ? JSON.stringify(otherTasksInPlan, null, 2) : "No other tasks in the plan.")
        .replace('{maxSuggestions}', String(max_suggestions))
        .replace('{jsonOutputSchemaInstructions}', jsonOutputSchemaInstructions);

    let suggestedSubtasks: AiSuggestedSubtask[];
    try {
        suggestedSubtasks = await callGeminiAndParseJson<AiSuggestedSubtask[]>(geminiService, prompt);
    } catch (error: any) {
        throw new Error(`Failed to get subtask suggestions from AI: ${error.message}`);
    }

    if (!Array.isArray(suggestedSubtasks) || suggestedSubtasks.length === 0) {
        return { markdown: `\n### 🎯 For Task: "${parentTask.title}" (\`${parentTask.task_id}\`)\n\n> 🤖 No subtasks were suggested by the AI.\n`, subtasksToCreate: [] };
    }

    const itemsForDisplay = suggestedSubtasks.map(s => {
        let title = s.suggested_title;
        if (!title || title.trim() === '') {
            title = s.suggested_description ? s.suggested_description.substring(0, 70) : `Subtask for ${parentTask.title}`;
        }
        return { ...s, resolved_title: title };
    });

    let markdown = `\n### 🎯 For Task: "${parentTask.title}" (\`${parentTask.task_id}\`)\n`;
    itemsForDisplay.forEach((subtask, index) => {
        markdown += `\n---\n\n#### 💡 Suggestion ${index + 1}: ${subtask.resolved_title}\n`;
        if (subtask.suggested_description) markdown += `\n> ${subtask.suggested_description}\n`;
        if (subtask.dependencies_parent_task_ids?.length) {
            const deps = subtask.dependencies_parent_task_ids.map(id => {
                const parent = otherTasksInPlan.find(t => t.task_id === id);
                return parent ? `\`${id}\` ("${parent.title}")` : `\`${id}\``;
            }).join(', ');
            markdown += `\n- **🔗 Dependencies:** ${deps}\n`;
        }
    });

    const subtasksToCreate = itemsForDisplay.map(s => ({
        title: s.resolved_title,
        description: s.suggested_description,
        parent_task_id: parentTask.task_id,
        notes: {
            dependencies_on_other_tasks: s.dependencies_parent_task_ids
        }
    }));

    return { markdown, subtasksToCreate };
}

async function aiSuggestSubtasksHandler(args: any, memoryManager: MemoryManager): Promise<{ content: { type: string; text: string }[] }> {
    const validationResult = validate('aiSuggestSubtasks', args);
    if (!validationResult.valid) {
        throw new McpError(ErrorCode.InvalidParams, `Validation failed for ai_suggest_subtasks: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
    }

    const { agent_id, plan_id, parent_task_id, max_suggestions = 3 } = args;

    const subtaskManager = memoryManager.subtaskManager;
    const planTaskManager = memoryManager.planTaskManager;
    const geminiService = memoryManager.getGeminiIntegrationService();

    const allTasksInPlan = await planTaskManager.getPlanTasks(agent_id, plan_id);

    if (parent_task_id) {
        // --- Single Parent Task Mode ---
        const parentTask = allTasksInPlan.find(t => t.task_id === parent_task_id);
        if (!parentTask) {
            throw new McpError(ErrorCode.InternalError, `Parent task with ID '${parent_task_id}' not found in plan '${plan_id}'.`);
        }

        const existingSubtasks = await subtaskManager.getSubtasksByParentTask(agent_id, parent_task_id);
        if (existingSubtasks && existingSubtasks.length > 0) {
            return { content: [{ type: 'text', text: formatSimpleMessage(`Subtasks already exist for parent task (ID: \`${parent_task_id}\`). No new suggestions suggested.`, "AI Subtask Suggestions") }] };
        }

        const { markdown, subtasksToCreate } = await _generateSubtasksForParent(agent_id, plan_id, parentTask, allTasksInPlan, max_suggestions, geminiService);

        let finalMarkdown = `## ✨ AI Suggested Subtasks\n${markdown}`;

        try {
            const createdIds = await subtaskManager.createSubtasks(agent_id, plan_id, subtasksToCreate);
            finalMarkdown += `\n\n**✅ Automatic Creation:** Successfully created ${createdIds.length} subtasks in the database.`;
        } catch (dbError: any) {
            finalMarkdown += `\n\n**❌ Automatic Creation Failed:** Could not create subtasks. Error: ${dbError.message}`;
        }

        return { content: [{ type: 'text', text: finalMarkdown }] };

    } else {
        // --- Intelligent Plan-Level Mode ---
        const tasksForAnalysis = await Promise.all(allTasksInPlan.map(async (task) => {
            const subtasks = await subtaskManager.getSubtasksByParentTask(agent_id, task.task_id);
            return {
                task_id: task.task_id,
                title: task.title,
                description: task.description,
                has_subtasks: subtasks.length > 0
            };
        }));

        const tasksWithoutSubtasks = tasksForAnalysis.filter(t => !t.has_subtasks);

        if (tasksWithoutSubtasks.length === 0) {
            return { content: [{ type: 'text', text: formatSimpleMessage(`All tasks in plan \`${plan_id}\` already have subtasks. No new suggestions generated.`, "AI Subtask Suggestions") }] };
        }

        // === AGENT 1: Task Complexity Analyzer ===
        const complexityAnalysisPrompt = AI_TASK_COMPLEXITY_ANALYSIS_PROMPT
            .replace('{tasksToAnalyzeJson}', JSON.stringify(tasksWithoutSubtasks.map(({ has_subtasks, ...rest }) => rest), null, 2));

        let complexityAnalyses: TaskComplexityAnalysis[];
        try {
            complexityAnalyses = await callGeminiAndParseJson<TaskComplexityAnalysis[]>(geminiService, complexityAnalysisPrompt);
        } catch (e) {
            throw new McpError(ErrorCode.InternalError, "Task Complexity Analyzer AI failed to analyze tasks.");
        }

        // Filter for tasks that should get subtasks
        const tasksForSubtaskGeneration = complexityAnalyses.filter(analysis =>
            analysis.recommended_action === 'HIGH_COMPLEXITY_SUBTASKS' ||
            analysis.recommended_action === 'MEDIUM_COMPLEXITY_SUBTASKS'
        );

        if (tasksForSubtaskGeneration.length === 0) {
            const analysisSummary = complexityAnalyses.map(a =>
                `- **${a.title}**: Complexity ${a.complexity_score}/10 - Recommendation: *${a.recommended_action}*`
            ).join('\n');

            return {
                content: [{
                    type: 'text', text: formatSimpleMessage(
                        `Task Complexity Analysis completed. No tasks met the criteria for subtask generation.\n\n${analysisSummary}`,
                        "🤖 AI Subtask Suggestions"
                    )
                }]
            };
        }
        
        const complexTaskIds = tasksForSubtaskGeneration.map(t => t.task_id);

        if (complexTaskIds.length === 0) {
            const analysisSummary = complexityAnalyses.map(a =>
                `- **${a.title}**: Complexity ${a.complexity_score}/10 - Recommendation: *${a.recommended_action}*`
            ).join('\n');

            return {
                content: [{
                    type: 'text', text: formatSimpleMessage(
                        `Task Complexity Analysis completed. No tasks meet the criteria for subtask generation.\n\n${analysisSummary}`,
                        "🤖 AI Subtask Suggestions"
                    )
                }]
            };
        }

        let fullMarkdownReport = `## ✨ AI-Suggested Subtasks for Plan \`${plan_id}\`\n\nBased on complexity analysis, subtasks have been generated for the following tasks:\n`;
        tasksForSubtaskGeneration.forEach(a => {
            fullMarkdownReport += `- **${a.title}** (Complexity: ${a.complexity_score}/10)\n`;
        });
        
        const allSubtasksToCreate: any[] = [];

        for (const taskId of complexTaskIds) {
            const parentTask = allTasksInPlan.find(t => t.task_id === taskId);
            if (parentTask) {
                const { markdown, subtasksToCreate } = await _generateSubtasksForParent(agent_id, plan_id, parentTask, allTasksInPlan, max_suggestions, geminiService);
                fullMarkdownReport += markdown;
                allSubtasksToCreate.push(...subtasksToCreate);
            }
        }

        if (allSubtasksToCreate.length > 0) {
            try {
                const createdIds = await subtaskManager.createSubtasks(agent_id, plan_id, allSubtasksToCreate);
                fullMarkdownReport += `\n\n**✅ Automatic Creation:** Successfully created ${createdIds.length} subtasks across ${complexTaskIds.length} parent tasks.`;
            } catch (dbError: any) {
                fullMarkdownReport += `\n\n**❌ Automatic Creation Failed:** Could not create subtasks. Error: ${dbError.message}`;
            }
        } else {
            fullMarkdownReport += `\n\n> 🤖 No new subtasks were generated by the AI for the selected complex tasks.`;
        }

        return { content: [{ type: 'text', text: fullMarkdownReport }] };
    }
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
    const codebaseContext = codebase_context_summary
        ? `\nConsider the following relevant codebase context:\n${codebase_context_summary}\n`
        : '';

    const prompt = AI_SUGGEST_TASK_DETAILS_PROMPT
        .replace('{taskTitle}', task_title)
        .replace('{taskDescription}', task_description || 'No detailed description currently provided.')
        .replace('{codebaseContext}', codebaseContext)
        .replace('{taskId}', task_id);

    // 3. Get suggestions from AI
    let suggestedDetails: AiSuggestedTaskDetails;
    try {
        suggestedDetails = await callGeminiAndParseJson<AiSuggestedTaskDetails>(geminiService, prompt);
    } catch (error: any) {
        console.error(`Error suggesting details for task ${task_id} (agent: ${agent_id}):`, error);
        throw new McpError(ErrorCode.InternalError, `Failed to get task detail suggestions from AI: ${error.message}`);
    }

    // 4. Format output
    let markdownOutput = `## 💡 AI Suggested Details for Task: "${task_title}"\n`;
    markdownOutput += `*ID: \`${task_id}\` | Plan ID: \`${plan_id}\`*\n\n`;
    
    if (suggestedDetails.suggested_purpose) markdownOutput += `### 🎯 Suggested Purpose\n> ${suggestedDetails.suggested_purpose}\n\n`;
    if (suggestedDetails.suggested_description) markdownOutput += `### 📖 Suggested Description\n${suggestedDetails.suggested_description}\n\n`;
    if (suggestedDetails.suggested_action_description) markdownOutput += `### ⚡ Suggested Action\n${suggestedDetails.suggested_action_description}\n\n`;

    markdownOutput += `--- \n\n### 📋 Details\n\n`
    if (suggestedDetails.suggested_files_involved?.length) markdownOutput += `- **Affected Files:** ${suggestedDetails.suggested_files_involved.map(f => `\`${f}\``).join(', ')}\n`;
    if (suggestedDetails.suggested_dependencies_task_ids?.length) markdownOutput += `- **🔗 Dependencies (Task IDs):** ${suggestedDetails.suggested_dependencies_task_ids.map(d => `\`${d}\``).join(', ')}\n`;
    if (suggestedDetails.suggested_tools_required_list?.length) markdownOutput += `- **🛠️ Tools Required:** ${suggestedDetails.suggested_tools_required_list.map(t => `\`${t}\``).join(', ')}\n`;
    if (suggestedDetails.suggested_estimated_effort_hours !== undefined) markdownOutput += `- **⏳ Estimated Effort:** ${suggestedDetails.suggested_estimated_effort_hours} hours\n`;
    
    markdownOutput += `\n### 📈 Execution & Verification\n\n`
    if (suggestedDetails.suggested_inputs_summary) markdownOutput += `- **Inputs:** ${suggestedDetails.suggested_inputs_summary}\n`;
    if (suggestedDetails.suggested_outputs_summary) markdownOutput += `- **Outputs:** ${suggestedDetails.suggested_outputs_summary}\n`;
    if (suggestedDetails.suggested_success_criteria_text) markdownOutput += `- **✅ Success Criteria:**\n${suggestedDetails.suggested_success_criteria_text}\n`;
    if (suggestedDetails.suggested_verification_method) markdownOutput += `- **🔍 Verification Method:** ${suggestedDetails.suggested_verification_method}\n`;

    if (suggestedDetails.rationale_for_suggestions) markdownOutput += `\n---\n\n### 🤔 Rationale for Suggestions\n> ${suggestedDetails.rationale_for_suggestions}\n`;
    
    markdownOutput += `\n---\n\n*Note: These are AI suggestions. Review and use the \`update_task\` tool to apply these details if desired.*`;

    return { content: [{ type: 'text', text: markdownOutput }] };
}

async function aiAnalyzePlanHandler(args: any, memoryManager: MemoryManager): Promise<{ content: { type: 'text', text: string }[] }> {
    const validationResult = validate('aiAnalyzePlan', args);
    if (!validationResult.valid) {
        throw new McpError(ErrorCode.InvalidParams, `Validation failed for ai_analyze_plan: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
    }

    const { agent_id, plan_id, analysis_focus_areas, codebase_context_summary } = args;

    // 1. Get services and fetch plan data
    const planTaskManager = memoryManager.planTaskManager;
    const subtaskManager = memoryManager.subtaskManager;
    const geminiService = memoryManager.getGeminiIntegrationService();

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

    const codebaseContext = codebase_context_summary
        ? `\nConsider the following relevant codebase context:\n${codebase_context_summary}\n---`
        : '';

    const prompt = AI_ANALYZE_PLAN_PROMPT
        .replace('{focusAreas}', focusAreas)
        .replace('{planStringRepresentation}', planStringRepresentation)
        .replace('{codebaseContext}', codebaseContext)
        .replace('{planId}', plan_id);

    // 3. Get analysis from AI
    let analysisResult: AiPlanAnalysis;
    try {
        analysisResult = await callGeminiAndParseJson<AiPlanAnalysis>(geminiService, prompt);
    } catch (error: any) {
        console.error(`Error analyzing plan ${plan_id} (agent: ${agent_id}):`, error);
        throw new McpError(ErrorCode.InternalError, `Failed to get plan analysis from AI: ${error.message}`);
    }

    // 4. Format output
    const renderScore = (score?: number) => score !== undefined ? `${'🔵'.repeat(score)}${'⚪️'.repeat(10 - score)} (${score}/10)` : 'N/A';

    let markdownOutput = `# 📊 AI Plan Analysis Report\n*For Plan ID: \`${plan_id}\`*\n\n`;
    markdownOutput += `> ### 💬 Overall Summary\n> ${analysisResult.overall_summary || 'No overall summary provided.'}\n\n`;
    
    markdownOutput += "### 📈 Scores\n";
    markdownOutput += `- **Coherence:** ${renderScore(analysisResult.overall_coherence_score)}\n`;
    markdownOutput += `- **Clarity:** ${renderScore(analysisResult.clarity_of_goal_score)}\n`;
    markdownOutput += `- **Actionability:** ${renderScore(analysisResult.actionability_of_tasks_score)}\n`;
    markdownOutput += `- **Completeness:** ${renderScore(analysisResult.completeness_score)}\n\n`;

    if (analysisResult.identified_strengths?.length) {
        markdownOutput += "### ✅ Identified Strengths\n" + analysisResult.identified_strengths.map(s => `- ${s}`).join('\n') + "\n\n";
    }
    if (analysisResult.potential_risks_or_issues?.length) {
        markdownOutput += "### ⚠️ Potential Risks & Issues\n";
        analysisResult.potential_risks_or_issues.forEach(r => {
            markdownOutput += `- **Risk:** ${r.risk}\n`;
            if (r.mitigation_suggestion) markdownOutput += `  - **💡 Mitigation:** ${r.mitigation_suggestion}\n`;
            if (r.related_tasks?.length) markdownOutput += `  - **🔗 Related Tasks:** ${r.related_tasks.map(t => `\`${t}\``).join(', ')}\n`;
        });
        markdownOutput += "\n";
    }
    
    markdownOutput += `--- \n\n### 🛠️ Recommendations\n\n`
    if (analysisResult.suggestions_for_improvement?.length) {
        markdownOutput += "#### General Improvements\n" + analysisResult.suggestions_for_improvement.map(s => `- ${s}`).join('\n') + "\n\n";
    }
    if (analysisResult.missing_tasks_or_steps?.length) {
        markdownOutput += "#### 🧩 Missing Tasks or Steps\n" + analysisResult.missing_tasks_or_steps.map(m => `- ${m}`).join('\n') + "\n\n";
    }
    if (analysisResult.dependency_concerns?.length) {
        markdownOutput += "#### 🔗 Dependency Concerns\n" + analysisResult.dependency_concerns.map(d => `- ${d}`).join('\n') + "\n\n";
    }

    if (analysisResult.resource_allocation_comments) markdownOutput += `#### 📦 Resource Allocation Comments\n> ${analysisResult.resource_allocation_comments}\n\n`;
    if (analysisResult.codebase_context_impact) markdownOutput += `#### 💻 Codebase Context Impact\n> ${analysisResult.codebase_context_impact}\n\n`;
    
    return { content: [{ type: 'text', text: markdownOutput }] };
}
// #endregion

// #region Exports
export const aiTaskEnhancementToolDefinitions = [
    aiSuggestSubtasksToolDefinition,
    aiSuggestTaskDetailsToolDefinition,
    aiAnalyzePlanToolDefinition,
];

export function getAiTaskEnhancementToolHandlers(memoryManager: MemoryManager) {
    return {
        'ai_suggest_subtasks': (args: any) => aiSuggestSubtasksHandler(args, memoryManager),
        'ai_suggest_task_details': (args: any) => aiSuggestTaskDetailsHandler(args, memoryManager),
        'ai_analyze_plan': (args: any) => aiAnalyzePlanHandler(args, memoryManager),
    };
}
// #endregion