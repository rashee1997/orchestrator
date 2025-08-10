// src/database/services/GeminiPlannerService.ts
import { GeminiIntegrationService, GeminiApiNotInitializedError } from './GeminiIntegrationService.js';
import { MemoryManager } from '../memory_manager.js';
import { randomUUID } from 'crypto';
import { KnowledgeGraphManager } from '../managers/KnowledgeGraphManager.js';

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

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------
const PLAN_STATUS_DRAFT = 'DRAFT';
const TASK_STATUS_PLANNED = 'PLANNED';
const GEMINI_MODEL_PLANNER = 'gemini-2.5-flash-preview-05-20';

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
     * @param codebaseContextSummary Optional: Summary of codebase context.
     * @returns A Promise resolving to an InitialDetailedPlanAndTasks object.
     * @throws Error if Gemini API call fails or response parsing fails.
     */
    public async generateInitialDetailedPlanAndTasks(
        agentId: string,
        identifier: string,
        isRefinedPromptId: boolean,
        directRefinedPromptDetails?: any,
        codebaseContextSummary?: string,
    ): Promise<InitialDetailedPlanAndTasks> {
        // -----------------------------------------------------------------
        // 1️⃣ Resolve refined prompt (if needed) and build the prompt payload
        // -----------------------------------------------------------------
        const { systemInstruction, userQuery, refinedPromptIdForPlan, refinedPromptDetails } =
            await this.buildPromptPayload(agentId, identifier, isRefinedPromptId, directRefinedPromptDetails, codebaseContextSummary);

        // -----------------------------------------------------------------
        // 2️⃣ Call Gemini
        // -----------------------------------------------------------------
        const geminiResponseText = await this.callGemini(systemInstruction, userQuery);

        // -----------------------------------------------------------------
        // 3️⃣ Parse Gemini JSON response
        // -----------------------------------------------------------------
        const parsedResponse = this.parseGeminiResponse(geminiResponseText);

        // -----------------------------------------------------------------
        // 4️⃣ Transform to domain objects
        // -----------------------------------------------------------------
        const planData = this.buildPlanData(parsedResponse, refinedPromptDetails, refinedPromptIdForPlan);
        const tasksData = this.buildTasksData(parsedResponse);
        const suggestedNextSteps = this.buildSuggestedNextSteps(tasksData);

        return { planData, tasksData, suggested_next_steps_for_agent: suggestedNextSteps };
    }

    // -----------------------------------------------------------------
    // Helper: Build system instruction & user query
    // -----------------------------------------------------------------
    private async buildPromptPayload(
        agentId: string,
        identifier: string,
        isRefinedPromptId: boolean,
        directRefinedPromptDetails?: any,
        codebaseContextSummary?: string,
    ): Promise<{
        systemInstruction: string;
        userQuery: string;
        refinedPromptIdForPlan: string | null;
        refinedPromptDetails: any;
        originalGoalText: string | null; // Added to return type
    }> {
        let refinedPromptIdForPlan: string | null = null;
        let refinedPromptDetails: any = null;
        let systemInstruction: string;
        let userQuery: string;

        if (isRefinedPromptId) {
            // ---- Refined Prompt Path -------------------------------------------------
            refinedPromptDetails = directRefinedPromptDetails ??
                (await this.memoryManager.getRefinedPrompt(agentId, identifier));

            if (!refinedPromptDetails) {
                throw new Error(`Refined prompt with ID '${identifier}' not found for agent '${agentId}'.`);
            }

            refinedPromptIdForPlan = identifier;
            systemInstruction = this.getSystemInstructionForRefinedPrompt();
            const planGenerationRefinedPromptDetails = this.extractPlanGenerationPayload(refinedPromptDetails);

            userQuery = this.buildUserQueryForRefinedPrompt(planGenerationRefinedPromptDetails, refinedPromptDetails);
        } else {
            // ---- High-level Goal Path -------------------------------------------------
            const codebaseContext = await this.resolveCodebaseContext(agentId, codebaseContextSummary);
            systemInstruction = this.getSystemInstructionForGoal();
            userQuery = this.buildUserQueryForGoal(identifier, codebaseContext);
        }

        return {
            systemInstruction,
            userQuery,
            refinedPromptIdForPlan,
            refinedPromptDetails,
            originalGoalText: isRefinedPromptId ? null : identifier, // Conditionally add originalGoalText
        };
    }

    private getSystemInstructionForRefinedPrompt(): string {
        return `You are an expert project planning assistant. You will be given a structured 'Refined Prompt Object' that details a user's request. Your task is to generate a complete project plan including a concise title, estimated duration, placeholder start/end dates, and potential risks and their mitigations for the overall plan. The output MUST be a valid JSON object adhering to the specified schema. Do **not** include any explanatory text outside the JSON object.

When generating tasks, obey the following rules:
• **Each task MUST include a non‑empty \`title\` (≤ 10 words) and a non‑empty \`description\`.** Do not return empty strings or placeholders such as “Untitled”.  
• Consolidate redundancy – merge overlapping tasks.  
• Explicit dependencies – define clear ordering.  
• Add missing critical phases – integration testing, performance benchmarking, code reviews, documentation updates, and a deployment plan.  
• Refined task descriptions – include purpose, completion criteria, and suggested roles/skills.  
• Comprehensive details – estimated effort, risks, micro‑steps, and suggested files involved.`;
    }

    private getSystemInstructionForGoal(): string {
        return `You are an expert project planning assistant. Your task is to take a user's high‑level goal and break it down into a structured and detailed project plan. The plan should include an overall goal, estimated duration, start/end dates (use placeholder dates like YYYY‑MM‑DD if specific dates are not inferable), potential risks and mitigations, and a list of actionable high‑level tasks.

Each task **must** contain a non‑empty \`title\` (≤ 10 words) and a non‑empty \`description\`. Do not emit placeholders such as “Untitled Task”.

Enhancements:
• Consolidate redundancy.  
• Explicit dependencies.  
• Add missing critical phases (code review, integration testing, performance profiling, documentation, deployment).  
• Refined task descriptions with completion criteria and required roles/skills.  
• Comprehensive details for each task (estimated effort, risks, micro‑steps, suggested files).`;
    }

    private extractPlanGenerationPayload(refined: any): Record<string, unknown> {
        return {
            original_prompt_text: refined.original_prompt_text,
            overall_goal: refined.overall_goal,
            decomposed_tasks: refined.decomposed_tasks_parsed ?? refined.decomposed_tasks,
            key_entities_identified: refined.key_entities_identified_parsed ?? refined.key_entities_identified,
            implicit_assumptions_made_by_refiner:
                refined.implicit_assumptions_made_by_refiner_parsed ?? refined.implicit_assumptions_made_by_refiner,
            explicit_constraints_from_prompt:
                refined.explicit_constraints_from_prompt_parsed ?? refined.explicit_constraints_from_prompt,
            suggested_ai_role_for_agent: refined.suggested_ai_role_for_agent,
            suggested_reasoning_strategy_for_agent: refined.suggested_reasoning_strategy_for_agent,
            desired_output_characteristics_inferred:
                refined.desired_output_characteristics_inferred_parsed ??
                refined.desired_output_characteristics_inferred,
            codebase_context_summary_by_ai: refined.codebase_context_summary_by_ai,
        };
    }

    private buildUserQueryForRefinedPrompt(
        payload: Record<string, unknown>,
        refined: any,
    ): string {
        const today = new Date().toISOString().split('T')[0];
        return `Analyze the following 'Refined Prompt Object' and generate a complete project plan.

Refined Prompt Object:
\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`

Consider the following codebase context when generating the plan and tasks:
\`\`\`
${refined.codebase_context_summary_by_ai || 'No specific codebase context provided.'}
\`\`\`

Provide a JSON object with:
1. plan_title (max 10 words)
2. estimated_duration_days (integer)
3. target_start_date ("YYYY-MM-DD", today = ${today})
4. target_end_date (calculated)
5. plan_risks_and_mitigations
6. tasks (see detailed schema in the original implementation)

Return ONLY the JSON object.`;
    }

    private async resolveCodebaseContext(agentId: string, fallback?: string): Promise<string | undefined> {
        if (fallback) return fallback;
        const ctx = await this.memoryManager.getContext(agentId, 'codebase_summary');
        return ctx?.context_data?.summary;
    }

    private buildUserQueryForGoal(goal: string, codebaseContext?: string): string {
        const today = new Date().toISOString().split('T')[0];
        return `Analyze the following user goal and generate a detailed project plan.

User Goal:
"${goal}"

Codebase context:
\`\`\`
${codebaseContext || 'No specific codebase context provided.'}
\`\`\`

Provide a JSON object with:
1. plan_title (max 10 words)
2. overall_plan_goal (re-phrased)
3. estimated_duration_days (integer)
4. target_start_date ("YYYY-MM-DD", today = ${today})
5. target_end_date (calculated)
6. plan_risks_and_mitigations
7. tasks (see detailed schema in the original implementation)

Return ONLY the JSON object.`;
    }

    // -----------------------------------------------------------------
    // Helper: Gemini call
    // -----------------------------------------------------------------
    private async callGemini(systemInstruction: string, userQuery: string): Promise<string> {
        try {
            const prompt = `${systemInstruction}\n\n${userQuery}`;
            const result = await this.geminiIntegrationService.askGemini(prompt, this.geminiModel);
            const text = result?.content?.[0]?.text;
            if (!text) {
                throw new Error('Gemini returned empty content.');
            }
            return text;
        } catch (err) {
            if (err instanceof GeminiApiNotInitializedError) throw err;
            throw new Error(`Failed to generate plan via Gemini: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // -----------------------------------------------------------------
    // Helper: Robust JSON extraction & parsing
    // -----------------------------------------------------------------
    private parseGeminiResponse(raw: string): GeminiDetailedPlanGenerationResponse {
        // 1️⃣ Find the outermost JSON object
        const first = raw.indexOf('{');
        const last = raw.lastIndexOf('}');
        let jsonStr = first !== -1 && last !== -1 && last > first ? raw.slice(first, last + 1) : raw;

        // 2️⃣ Strip markdown fences if present
        const fenced = jsonStr.match(/```json\n([\s\S]*?)\n```/);
        if (fenced) jsonStr = fenced[1];

        // 3️⃣ Clean trailing commas & comments
        jsonStr = jsonStr.replace(/,(\s*[}\]])/g, '$1'); // trailing commas
        jsonStr = jsonStr.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ''); // comments

        try {
            return JSON.parse(jsonStr) as GeminiDetailedPlanGenerationResponse;
        } catch (e) {
            throw new Error(`Unable to parse Gemini JSON response. Raw: ${raw}`);
        }
    }

    // -----------------------------------------------------------------
    // Helper: Build domain objects
    // -----------------------------------------------------------------
    private buildPlanData(
        resp: GeminiDetailedPlanGenerationResponse,
        refinedDetails: any,
        refinedPromptId: string | null,
    ): InitialDetailedPlanAndTasks['planData'] {
        return {
            title: resp.plan_title ?? refinedDetails?.overall_goal ?? 'Untitled Plan',
            overall_goal: refinedPromptId === null
                ? refinedDetails?.originalGoalText ?? ''
                : refinedDetails?.overall_goal ?? '',
            status: PLAN_STATUS_DRAFT,
            version: 1,
            refined_prompt_id_associated: refinedPromptId,
            metadata: {
                estimated_duration_days: resp.estimated_duration_days,
                target_start_date: resp.target_start_date,
                target_end_date: resp.target_end_date,
                plan_risks_and_mitigations: resp.plan_risks_and_mitigations,
            },
        };
    }

    private buildTasksData(
        resp: GeminiDetailedPlanGenerationResponse,
    ): InitialDetailedPlanAndTasks['tasksData'] {
        if (!resp.tasks?.length) return [];
        return resp.tasks.map((t, idx) => {
            // -----------------------------------------------------------------
            // 1️⃣ Normalise / fallback title, description and purpose
            // -----------------------------------------------------------------
            const taskNumber = t.task_number ?? idx + 1;

            const rawTitle = (t.title || '').trim();
            const rawDesc = (t.description || '').trim();
            const rawPurpose = (t.purpose || '').trim();

            // If the model omitted the title, synthesize one from the description
            const safeTitle = rawTitle ||
                `Task ${taskNumber}: ${rawDesc ? rawDesc.split(/\s+/).slice(0, 6).join(' ') : 'Contextual refactor step'}`;

            // If the description is missing, fall back to a generic sentence
            const safeDescription = rawDesc ||
                `Auto‑generated description for ${safeTitle.toLowerCase()}.`;

            // If purpose is missing, provide a generic purpose
            const safePurpose = rawPurpose ||
                'Clarify intent and improve maintainability as part of the overall plan.';

            const notes: TaskNotes = {}; // Initialize as empty object

            if (t.task_risks !== undefined) {
                notes.task_risks = t.task_risks;
            }
            if (t.micro_steps !== undefined) {
                notes.micro_steps = t.micro_steps;
            }

            return {
                task_number: taskNumber,
                title: safeTitle,
                description: safeDescription,
                purpose: safePurpose,
                status: TASK_STATUS_PLANNED,
                estimated_effort_hours: t.estimated_effort_hours,
                task_risks: t.task_risks,
                micro_steps: t.micro_steps,
                suggested_files_involved: t.suggested_files_involved ?? [],
                dependencies_task_ids_json: t.task_dependencies ? JSON.stringify(t.task_dependencies) : null,
                assigned_to: t.roles_required ? JSON.stringify(t.roles_required) : null,
                success_criteria_text: t.completion_criteria ?? null,
                ...(Object.keys(notes).length && { notes_json: JSON.stringify(notes) }),
            };
        });
    }

    // -----------------------------------------------------------------
    // Helper: Suggested next-steps markdown generation
    // -----------------------------------------------------------------
    private buildSuggestedNextSteps(tasks: InitialDetailedPlanAndTasks['tasksData']): string {
        const ids = tasks.map(t => t.task_number);
        const idsList = ids.map(id => `\`[task_id_${id}]\``).join(', ');
        return `### Next Suggested Steps for Agent

The plan has been generated with explicit dependencies and comprehensive task details.

For each task ID in the plan (e.g., ${idsList}):
1️⃣ **Review Task Details** – verify description, purpose, effort, risks, micro-steps, suggested files, dependencies, assigned role, and success criteria.
2️⃣ **Break Down into Sub-tasks** (if needed) – use the \`ai_suggest_subtasks\` tool, providing:
   - \`agent_id\`, \`plan_id\`, \`parent_task_id\`
   - Optional: \`parent_task_title\`, \`parent_task_description\`
   - \`codebase_context_summary\` (include existing tasks summary to avoid duplication)
3️⃣ **Add Sub-tasks** – call \`add_subtask_to_plan\` with the suggested sub-task data.
4️⃣ **Update Status** – mark tasks as completed via \`update_plan_task_status\`.
5️⃣ **Log Progress** – use \`log_task_progress\` after major actions.
6️⃣ **Iterate** – periodically run \`ai_analyze_plan\` to refine the overall plan.`;
    }
}