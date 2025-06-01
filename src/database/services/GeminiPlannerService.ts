// src/database/services/GeminiPlannerService.ts
import { GeminiIntegrationService, GeminiApiNotInitializedError } from './GeminiIntegrationService.js';
import { MemoryManager } from '../memory_manager.js';
import { randomUUID } from 'crypto';
import { KnowledgeGraphManager } from '../managers/KnowledgeGraphManager.js'; // Corrected import path

// Interface for the expected structure from Gemini for detailed plan generation
interface GeminiDetailedPlanGenerationResponse {
    plan_title?: string; // Optional for backward compatibility
    estimated_duration_days: number;
    target_start_date: string;
    target_end_date: string;
    plan_risks_and_mitigations: Array<{
        risk_description: string;
        mitigation_strategy: string;
    }>;
    tasks?: Array<{ // Added tasks to the response interface
        task_number: number;
        title: string;
        description: string;
        purpose: string;
        estimated_effort_hours?: number;
        task_risks?: string[];
        micro_steps?: string[];
        suggested_files_involved?: string[]; // Added suggested_files_involved here
        task_dependencies?: string[]; // Added for explicit dependencies
        roles_required?: string[]; // Added for roles/skills
        completion_criteria?: string; // Added for clear completion criteria
    }>;
}

// Interface for additional task details that might be stored in notes_json
interface TaskNotes {
    task_risks?: string[];
    micro_steps?: string[];
    [key: string]: any; // Allow other metadata
}

// Interface for the output structure of generateInitialPlanAndTasks, updated for detailed fields
export interface InitialDetailedPlanAndTasks {
    planData: {
        title: string;
        overall_goal: string;
        status: string; // e.g., 'DRAFT'
        version: number; // e.g., 1
        refined_prompt_id_associated?: string | null;
        metadata?: { // For storing additional plan details
            estimated_duration_days?: number;
            target_start_date?: string;
            target_end_date?: string;
            plan_risks_and_mitigations?: Array<{ risk_description: string; mitigation_strategy: string; }>;
            [key: string]: any; // Allow other metadata
        };
    };
    tasksData: Array<{
        task_number: number;
        title: string;
        description: string;
        purpose: string;
        status: string; // e.g., 'PLANNED'
        estimated_effort_hours?: number; // This field exists in plan_tasks schema
        task_risks?: string[]; // Add this
        micro_steps?: string[]; // Add this
        notes_json?: string | null; // For storing additional task details as a JSON string
        suggested_files_involved?: string[]; // Added suggested_files_involved here
        dependencies_task_ids_json?: string | null; // Added for explicit dependencies
        tools_required_list_json?: string | null; // Added for tools required
        inputs_summary?: string | null; // Added for inputs summary
        outputs_summary?: string | null; // Added for outputs summary
        success_criteria_text?: string | null; // Added for success criteria
        assigned_to?: string | null; // Added for assigned to
        verification_method?: string | null; // Added for verification method
    }>;
    suggested_next_steps_for_agent?: string; // Add this for suggested next steps
}

// Constants for status and model names
const PLAN_STATUS_DRAFT = 'DRAFT';
const TASK_STATUS_PLANNED = 'PLANNED';
const GEMINI_MODEL_PLANNER = "gemini-2.5-flash-preview-05-20";

export class GeminiPlannerService {
    private geminiIntegrationService: GeminiIntegrationService;
    private memoryManager: MemoryManager;
    private readonly geminiModel = GEMINI_MODEL_PLANNER;

    constructor(geminiIntegrationService: GeminiIntegrationService, memoryManager: MemoryManager) {
        this.geminiIntegrationService = geminiIntegrationService;
        this.memoryManager = memoryManager;
    }

    /**
     * Generates an initial detailed plan and a list of tasks using Gemini based on a goal or refined prompt.
     * @param agentId The ID of the agent for whom the plan is being generated.
     * @param identifier The goal description (string) or refined_prompt_id (string).
     * @param isRefinedPromptId Boolean indicating if the identifier is a refined_prompt_id.
     * @param directRefinedPromptDetails Optional: Pre-fetched refined prompt details.
     * @returns A Promise resolving to an InitialDetailedPlanAndTasks object.
     * @throws Error if Gemini API call fails or response parsing fails.
     */
    public async generateInitialDetailedPlanAndTasks(
        agentId: string,
        identifier: string,
        isRefinedPromptId: boolean,
        directRefinedPromptDetails?: any,
        codebaseContextSummary?: string // Added optional codebaseContextSummary parameter
    ): Promise<InitialDetailedPlanAndTasks> {
        let systemInstruction: string;
        let userQuery: string;
        let refinedPromptIdForPlan: string | null = null;
        let refinedPromptDetails: any; // Declare it here

        // Referencing prompts from gemini_plan_generation_prompts_v2
        if (isRefinedPromptId) {
            refinedPromptDetails = directRefinedPromptDetails; // Assign here
            if (!refinedPromptDetails) {
                refinedPromptDetails = await this.memoryManager.getRefinedPrompt(agentId, identifier);
                if (!refinedPromptDetails) {
                    throw new Error(`Refined prompt with ID '${identifier}' not found for agent '${agentId}'.`);
                }
            }
            refinedPromptIdForPlan = identifier;

            systemInstruction = "You are an expert project planning assistant. You will be given a structured 'Refined Prompt Object' that details a user's request. Your task is to generate a complete project plan including a concise title, estimated duration, placeholder start/end dates, and potential risks and their mitigations for the overall plan. The output MUST be a valid JSON object adhering to the specified schema. Do not include any explanatory text outside the JSON object.\n\nWhen generating tasks, pay close attention to the following:\n- **Consolidate Redundancy:** Identify and merge overlapping tasks, especially those related to entity extraction, into single, comprehensive tasks with clear sub-components.\n- **Explicit Dependencies:** Define clear dependencies between tasks to ensure logical flow. For example, foundational analysis tasks should precede implementation, and testing should follow implementation.\n- **Missing Critical Phases:** Include dedicated tasks for integration testing, performance benchmarking/optimization, formal code reviews, documentation updates (both internal and external), and a deployment/release plan.\n- **Refined Task Descriptions:** Ensure each task has a clear purpose, specific completion criteria, and suggested roles/skills required for execution.\n- **Comprehensive Details:** For each task, provide estimated effort, potential risks, micro-steps, and suggested files involved.";
            // Create a copy of refinedPromptDetails and remove context_options before sending to Gemini
            // context_options are for retrieval during refinement, not for plan generation content.
            // Only send the essential fields to Gemini to avoid confusion
            const planGenerationRefinedPromptDetails = {
                original_prompt_text: refinedPromptDetails.original_prompt_text,
                overall_goal: refinedPromptDetails.overall_goal,
                decomposed_tasks: refinedPromptDetails.decomposed_tasks_parsed || refinedPromptDetails.decomposed_tasks,
                key_entities_identified: refinedPromptDetails.key_entities_identified_parsed || refinedPromptDetails.key_entities_identified,
                implicit_assumptions_made_by_refiner: refinedPromptDetails.implicit_assumptions_made_by_refiner_parsed || refinedPromptDetails.implicit_assumptions_made_by_refiner,
                explicit_constraints_from_prompt: refinedPromptDetails.explicit_constraints_from_prompt_parsed || refinedPromptDetails.explicit_constraints_from_prompt,
                suggested_ai_role_for_agent: refinedPromptDetails.suggested_ai_role_for_agent,
                suggested_reasoning_strategy_for_agent: refinedPromptDetails.suggested_reasoning_strategy_for_agent,
                desired_output_characteristics_inferred: refinedPromptDetails.desired_output_characteristics_inferred_parsed || refinedPromptDetails.desired_output_characteristics_inferred,
                codebase_context_summary_by_ai: refinedPromptDetails.codebase_context_summary_by_ai // Include codebase context
            };

            // Debug logging
            console.log('[DEBUG] Sending to Gemini for plan generation:', JSON.stringify(planGenerationRefinedPromptDetails, null, 2));
            
            userQuery = `Analyze the following 'Refined Prompt Object' and generate a complete project plan.

Refined Prompt Object:
\`\`\`json
${JSON.stringify(planGenerationRefinedPromptDetails, null, 2)}
\`\`\`

Consider the following codebase context when generating the plan and tasks:
\`\`\`
${refinedPromptDetails.codebase_context_summary_by_ai || 'No specific codebase context provided.'}
\`\`\`

Based on this refined prompt, provide:
1.  A concise \`plan_title\` that accurately describes the project (max 10 words).
2.  An \`estimated_duration_days\` for the entire plan (integer).
3.  A \`target_start_date\` (string, "YYYY-MM-DD" format, use today's date: ${new Date().toISOString().split('T')[0]}).
4.  A \`target_end_date\` (string, "YYYY-MM-DD" format, calculate based on start date + estimated_duration_days).
5.  A list of \`plan_risks_and_mitigations\` (array of objects, each with \`risk_description\` and \`mitigation_strategy\`).
6.  A list of high-level \`tasks\`. Each task should have:
    * \`task_number\`: A unique number for the task (integer).
    * \`title\`: A short, descriptive title (max 10 words).
    * \`description\`: A brief explanation of what the task involves (1-2 sentences).
    * \`purpose\`: The reason this task is necessary for the overall plan goal (1 sentence).
    * \`estimated_effort_hours\`: Estimated effort for the task in hours (integer).
    * \`task_risks\`: A list of potential risks specific to this task (array of strings).
    * \`micro_steps\`: A list of 3-5 granular sub-actions or steps for completing the task (array of strings).
    * \`suggested_files_involved\`: An array of strings listing suggested file paths relevant to this task.
    * \`task_dependencies\`: Explicitly list task dependencies by task number or title (array of strings).
    * \`roles_required\`: Specify the roles or skills required to complete the task (array of strings).
    * \`completion_criteria\`: Define clear criteria for task completion (string).

Output the result as a single JSON object with the following structure:
{
  "plan_title": "string",
  "estimated_duration_days": "integer",
  "target_start_date": "string",
  "target_end_date": "string",
  "plan_risks_and_mitigations": [ { "risk_description": "string", "mitigation_strategy": "string" } ],
  "tasks": [ { "task_number": "integer", "title": "string", "description": "string", "purpose": "string", "estimated_effort_hours": "integer", "task_risks": ["string"], "micro_steps": ["string"], "suggested_files_involved": ["string"], "task_dependencies": ["string"], "roles_required": ["string"], "completion_criteria": "string" } ]
}`;
        } else { // Identifier is a high-level goal description
            let currentCodebaseContext = codebaseContextSummary;
            if (!currentCodebaseContext) {
                // Attempt to retrieve a general codebase context summary if not provided
                // This assumes a context type 'codebase_summary' might exist or can be generated
                const generalContext = await this.memoryManager.getContext(agentId, 'codebase_summary');
                if (generalContext && generalContext.context_data && generalContext.context_data.summary) {
                    currentCodebaseContext = generalContext.context_data.summary;
                }
            }

            systemInstruction = "You are an expert project planning assistant. Your task is to take a user's high-level goal and break it down into a structured and detailed project plan. The plan should include an overall goal, estimated duration, start/end dates (use placeholder dates like YYYY-MM-DD if specific dates are not inferable from the goal, but indicate they are placeholders), potential risks and their mitigations for the overall plan. Also, generate a list of actionable high-level tasks. Each task should include a title, description, purpose, estimated effort in hours, potential risks specific to the task, and a few micro-steps (sub-actions). The output MUST be a valid JSON object adhering to the specified schema. Do not include any explanatory text outside the JSON object.\n\nAdditionally, ensure the following enhancements to improve plan quality and execution:\n- **Consolidate Redundancy:** Identify and merge overlapping tasks into single, comprehensive tasks with clear sub-components.\n- **Explicit Dependencies:** Define clear dependencies between tasks to ensure logical sequencing and prevent workflow blockages. Foundational analysis tasks should precede implementation, and testing should follow implementation.\n- **Missing Critical Phases:** Include dedicated tasks for:\n    - Code review and pull request submission after implementation and unit testing.\n    - Integration or end-to-end testing to validate the tool's behavior within the larger system context.\n    - Performance profiling or benchmarking to proactively identify bottlenecks.\n    - Documentation updates (both internal and external/user-facing).\n    - A deployment/release plan.\n- **Refined Task Descriptions:** Clearly state completion criteria (e.g., test coverage targets, documentation approval) and specify roles or skill requirements for each task.\n- **Comprehensive Details:** For each task, provide estimated effort, potential risks, micro-steps, and suggested files involved.\n\nAim for a plan that would score 10 out of 10 for overall coherence, clarity of goal, actionability of tasks, and completeness, addressing all the identified issues from the analysis report.";
            userQuery = `Analyze the following user goal and generate a detailed project plan structure.

User Goal:
"${identifier}"

Consider the following codebase context when generating the plan and tasks:
\`\`\`
${currentCodebaseContext || 'No specific codebase context provided.'}
\`\`\`

Based on this goal, provide:
1.  A concise \`plan_title\` (max 10 words).
2.  An \`overall_plan_goal\` that rephrases or clarifies the user's goal for the project plan (1-2 sentences).
3.  An \`estimated_duration_days\` for the entire plan (integer).
4.  A \`target_start_date\` (string, "YYYY-MM-DD" format, use today's date: ${new Date().toISOString().split('T')[0]}).
5.  A \`target_end_date\` (string, "YYYY-MM-DD" format, calculate based on start date + estimated_duration_days).
6.  A list of \`plan_risks_and_mitigations\` (array of objects, each with \`risk_description\` and \`mitigation_strategy\`).
7.  A list of high-level \`tasks\`. Each task should have:
    * \`task_number\`: A unique number for the task (integer).
    * \`title\`: A short, descriptive title (max 10 words).
    * \`description\`: A brief explanation of what the task involves (1-2 sentences).
    * \`purpose\`: The reason this task is necessary for the overall plan goal (1 sentence).
    * \`estimated_effort_hours\`: Estimated effort for the task in hours (integer).
    * \`task_risks\`: A list of potential risks specific to this task (array of strings).
    * \`micro_steps\`: A list of 3-5 granular sub-actions or steps for completing the task (array of strings).
    * \`suggested_files_involved\`: An array of strings listing suggested file paths relevant to this task.
    * \`task_dependencies\`: Explicitly list task dependencies by task number or title (array of strings).
    * \`roles_required\`: Specify the roles or skills required to complete the task (array of strings).
    * \`completion_criteria\`: Define clear criteria for task completion (string).

Output the result as a single JSON object with the following structure:
{
  "plan_title": "string",
  "overall_plan_goal": "string",
  "estimated_duration_days": "integer",
  "target_start_date": "string",
  "target_end_date": "string",
  "plan_risks_and_mitigations": [ { "risk_description": "string", "mitigation_strategy": "string" } ],
  "tasks": [ { "task_number": "integer", "title": "string", "description": "string", "purpose": "string", "estimated_effort_hours": "integer", "task_risks": ["string"], "micro_steps": ["string"], "suggested_files_involved": ["string"], "task_dependencies": ["string"], "roles_required": ["string"], "completion_criteria": "string" } ]
}`;
        }

        let geminiResponseText: string;
        try {
            console.log('[DEBUG] Calling Gemini with system instruction:', systemInstruction);
            console.log('[DEBUG] User query length:', userQuery.length);
            // Include systemInstruction as part of the prompt text instead of separate parameter
            const promptWithInstruction = systemInstruction + "\n\n" + userQuery;
            const geminiResult = await this.geminiIntegrationService.askGemini(promptWithInstruction, this.geminiModel);
            if (!geminiResult || !geminiResult.content || geminiResult.content.length === 0 || !geminiResult.content[0]?.text) {
                throw new Error("Gemini returned no content or an unexpected format for plan generation.");
            }
            geminiResponseText = geminiResult.content[0].text;
            console.log('[DEBUG] Gemini response:', geminiResponseText);
        } catch (error) {
            if (error instanceof GeminiApiNotInitializedError) {
                throw error;
            }
            console.error("Error calling Gemini for detailed plan generation:", error);
            throw new Error(`Failed to generate detailed plan structure via Gemini: ${error instanceof Error ? error.message : String(error)}`);
        }

        let parsedResponse: GeminiDetailedPlanGenerationResponse;
        try {
            let jsonToParse = geminiResponseText;
            // More robust JSON extraction: find the first '{' and the last '}'
            const firstBrace = jsonToParse.indexOf('{');
            const lastBrace = jsonToParse.lastIndexOf('}');

            if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                jsonToParse = jsonToParse.substring(firstBrace, lastBrace + 1);
            } else {
                // Fallback to original logic if braces not found or malformed
                const jsonMatch = geminiResponseText.match(/```json\n([\s\S]*?)\n```/);
                if (jsonMatch && jsonMatch[1]) {
                    jsonToParse = jsonMatch[1].trim();
                } else {
                    jsonToParse = geminiResponseText.trim();
                }
            }

            // Remove trailing commas before parsing
            jsonToParse = jsonToParse.replace(/,(\s*[\]}])/g, '$1');
            // Remove comments (single line // and multi-line /* */)
            jsonToParse = jsonToParse.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '');

            parsedResponse = JSON.parse(jsonToParse);
        } catch (error) {
            console.error("Error parsing Gemini's JSON response for detailed plan generation. Raw response:", geminiResponseText);
            throw new Error(`Failed to parse detailed plan structure from Gemini response: ${error instanceof Error ? error.message : String(error)}. Raw response: ${geminiResponseText}`);
        }

        // Transform Gemini response to InitialDetailedPlanAndTasks structure
        const planData: InitialDetailedPlanAndTasks['planData'] = {
            title: parsedResponse.plan_title || refinedPromptDetails.overall_goal, // Use Gemini's title or fallback to overall_goal
            overall_goal: refinedPromptDetails.overall_goal, // Keep overall_goal from refined prompt
            status: PLAN_STATUS_DRAFT,
            version: 1,
            refined_prompt_id_associated: refinedPromptIdForPlan,
            metadata: {
                estimated_duration_days: parsedResponse.estimated_duration_days,
                target_start_date: parsedResponse.target_start_date,
                target_end_date: parsedResponse.target_end_date,
                plan_risks_and_mitigations: parsedResponse.plan_risks_and_mitigations,
            }
        };

        const tasksData: InitialDetailedPlanAndTasks['tasksData'] = parsedResponse.tasks?.map((task, index) => {
            // Ensure task_number is present, use index + 1 as fallback
            const taskNumber = task.task_number || (index + 1);

            // Handle task_dependencies, roles_required, and completion_criteria
            const dependencies_task_ids_json = task.task_dependencies ? JSON.stringify(task.task_dependencies) : null;
            const assigned_to = task.roles_required ? JSON.stringify(task.roles_required) : null; // Store as JSON string
            const success_criteria_text = task.completion_criteria || null;

            const notes: TaskNotes = {
                task_risks: task.task_risks,
                micro_steps: task.micro_steps,
            };

            return {
                task_number: taskNumber,
                title: task.title,
                description: task.description,
                purpose: task.purpose,
                status: TASK_STATUS_PLANNED,
                estimated_effort_hours: task.estimated_effort_hours,
                task_risks: task.task_risks,
                micro_steps: task.micro_steps,
                suggested_files_involved: task.suggested_files_involved || [],
                dependencies_task_ids_json: dependencies_task_ids_json,
                assigned_to: assigned_to,
                success_criteria_text: success_criteria_text,
                ...(Object.keys(notes).length > 0 && { notes_json: JSON.stringify(notes) }),
            };
        }) || []; // Ensure tasksData is an array even if parsedResponse.tasks is undefined

        const taskIds = tasksData.map(task => task.task_number);
        const suggestedNextSteps = `### Next Suggested Steps for Agent:

The plan has been generated with explicit dependencies and comprehensive task details.

For each task ID in the plan (e.g., ${taskIds.map(id => `\`[task_id_${id}]\``).join(', ')}):
1.  **Review Task Details:** Examine the \`description\`, \`purpose\`, \`estimated_effort_hours\`, \`task_risks\`, \`micro_steps\`, \`suggested_files_involved\`, \`dependencies_task_ids_json\`, \`assigned_to\`, and \`success_criteria_text\` for accuracy and completeness.
2.  **Break Down into Subtasks (if necessary):** If a task is still too broad, consider using the \`ai_suggest_subtasks\` tool to get a more granular breakdown. To avoid redundancies and ensure context-awareness, when calling \`ai_suggest_subtasks\`, ensure you provide:
    *   \`agent_id\`: Your agent ID (\`[agent_id]\`) - **Replace \`[agent_id]\` with the actual agent ID.**
    *   \`plan_id\`: The Plan ID created above (\`[plan_id]\`) - **Replace \`[plan_id]\` with the actual Plan ID.**
    *   \`parent_task_id\`: The specific Task ID you are breaking down.
    *   \`parent_task_title\` (optional): The title of the parent task.
    *   \`parent_task_description\` (optional): The description of the parent task.
    *   \`codebase_context_summary\` (optional but highly recommended): Provide a summary of relevant codebase context (e.g., related file names, function signatures, class definitions) to make the subtask suggestions code-aware. This could be from the refined prompt's \`codebase_context_summary_by_ai\` or by retrieving fresh context relevant to the parent task using tools like \`query_codebase_embeddings\` or \`kg_nl_query\`.
    *   **Crucially, also provide a summary of *existing tasks and subtasks* within the current plan.** This helps Gemini understand what has already been planned and avoid suggesting redundant subtasks. You can achieve this by:
        *   First, using \`get_plan_tasks\` and \`get_subtasks\` to retrieve all existing tasks and subtasks for the current plan.
        *   Then, summarizing this information (e.g., "Existing tasks include: Task 1: 'Analyze AST', Task 2: 'Implement X', Subtask 2.1: 'Refactor Y'"). This summary should be included in the \`codebase_context_summary\` parameter or a new dedicated parameter if \`ai_suggest_subtasks\` is updated to accept it.
3.  **Add Subtasks to Plan:** For each appropriate suggestion from \`ai_suggest_subtasks\`, use the \`add_subtask_to_plan\` tool to add it to the plan under the corresponding parent task.
    *   **Input for \`add_subtask_to_plan\`**:
        *   \`agent_id\`: Your agent ID (\`[agent_id]\`) - **Replace \`[agent_id]\` with the actual agent ID.**
        *   \`plan_id\`: The Plan ID (\`[plan_id]\`) - **Replace \`[plan_id]\` with the actual Plan ID.**
        *   \`parent_task_id\`: The specific Task ID.
        *   \`subtaskData\`: { "title": "Suggested Subtask Title", "description": "Suggested Subtask Description", ... }
4.  **Update Task Status:** As tasks are completed, use \`update_plan_task_status\` to reflect their progress.
5.  **Log Progress:** Use \`log_task_progress\` after significant steps or tool executions.
6.  **Review and Refine:** Periodically use \`ai_analyze_plan\` to review the overall plan's coherence and make adjustments as needed.
`

        return { planData, tasksData, suggested_next_steps_for_agent: suggestedNextSteps };
    }
}
