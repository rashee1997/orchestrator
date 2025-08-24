// src/database/services/GeminiPlannerService.ts
import { GeminiIntegrationService, GeminiApiNotInitializedError } from './GeminiIntegrationService.js';
import { MemoryManager } from '../memory_manager.js';
import { randomUUID } from 'crypto';
import { KnowledgeGraphManager } from '../managers/KnowledgeGraphManager.js';
import { GeminiPlannerResponseSchema } from './gemini-integration-modules/GeminiSchema.js';
import { parseGeminiJsonResponse } from './gemini-integration-modules/GeminiResponseParsers.js';
import {
    PLANNER_SYSTEM_INSTRUCTION_REFINED_PROMPT,
    PLANNER_USER_QUERY_REFINED_PROMPT,
    PLANNER_SYSTEM_INSTRUCTION_GOAL_PROMPT,
    PLANNER_USER_QUERY_GOAL_PROMPT
} from './gemini-integration-modules/GeminiPromptTemplates.js';

// Interface for the expected structure from Gemini for detailed plan generation
interface GeminiDetailedPlanGenerationResponse {
    plan_title?: string; // Optional for backward compatibility
    estimated_duration_days: number;
    target_start_date: string;
    target_end_date: string;
    kpis?: string[];
    dependency_analysis?: string;
    plan_risks_and_mitigations: Array<{
        risk_description: string;
        mitigation_strategy: string;
    }>;
    tasks: Array<{ // Made tasks required
        task_number: number;
        title: string;
        description: string;
        purpose: string;
        estimated_duration_days?: number;
        estimated_effort_hours?: number;
        task_risks?: string[];
        micro_steps?: string[];
        suggested_files_involved?: string[];
        task_dependencies?: string[];
        roles_required?: string[];
        completion_criteria?: string;
        code_content?: string;
        risks?: string[];
        required_skills?: string[];
        assigned_to?: string; // ADDED: Assigned to field
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
            kpis?: string[];
            dependency_analysis?: string;
            [key: string]: any; // Allow other metadata
        };
    };
    tasksData: Array<{
        task_number: number;
        title: string;
        description: string;
        purpose: string;
        status: string; // e.g., 'PLANNED'
        estimated_duration_days?: number;
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
        code_content?: string | null; // NEW: For code diffs or full code
    }>;
    suggested_next_steps_for_agent?: string; // Add this for suggested next steps
    refinedPromptDetails?: any; // Add this property
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
     * @param liveFilesContent Optional: A map of file paths to their string content for live analysis.
     * @returns A Promise resolving to an InitialDetailedPlanAndTasks object.
     * @throws Error if Gemini API call fails or response parsing fails.
     */
    public async generateInitialDetailedPlanAndTasks(
        agentId: string,
        identifier: string,
        isRefinedPromptId: boolean,
        directRefinedPromptDetails?: any,
        codebaseContextSummary?: string,
        liveFilesContent?: Map<string, string>
    ): Promise<InitialDetailedPlanAndTasks> {
        // -----------------------------------------------------------------
        // 1️⃣ Resolve refined prompt (if needed) and build the prompt payload
        // -----------------------------------------------------------------
        const { systemInstruction, userQuery, refinedPromptIdForPlan, refinedPromptDetails } =
            await this.buildPromptPayload(agentId, identifier, isRefinedPromptId, directRefinedPromptDetails, codebaseContextSummary, liveFilesContent);

        // -----------------------------------------------------------------
        // 2️⃣ Call Gemini
        // -----------------------------------------------------------------
        const geminiResponseText = await this.callGemini(systemInstruction, userQuery);

        // -----------------------------------------------------------------
        // 3️⃣ Parse Gemini JSON response
        // -----------------------------------------------------------------
        const parsedResponse = parseGeminiJsonResponse(geminiResponseText);

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
        liveFilesContent?: Map<string, string>
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
            systemInstruction = PLANNER_SYSTEM_INSTRUCTION_REFINED_PROMPT;
            const planGenerationRefinedPromptDetails = this.extractPlanGenerationPayload(refinedPromptDetails);

            userQuery = this.buildUserQueryForRefinedPrompt(planGenerationRefinedPromptDetails, refinedPromptDetails, liveFilesContent);
        } else {
            // ---- High-level Goal Path -------------------------------------------------
            const codebaseContext = await this.resolveCodebaseContext(agentId, codebaseContextSummary);
            systemInstruction = PLANNER_SYSTEM_INSTRUCTION_GOAL_PROMPT;
            userQuery = this.buildUserQueryForGoal(identifier, codebaseContext, liveFilesContent);
        }

        return {
            systemInstruction,
            userQuery,
            refinedPromptIdForPlan,
            refinedPromptDetails,
            originalGoalText: isRefinedPromptId ? null : identifier, // Conditionally add originalGoalText
        };
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
        liveFilesContent?: Map<string, string>
    ): string {
        const today = new Date().toISOString().split('T')[0];
        let liveFilesString = 'No live files provided for review.';
        if (liveFilesContent && liveFilesContent.size > 0) {
            liveFilesString = Array.from(liveFilesContent.entries()).map(([path, content]) => {
                return `--- FILE: ${path} ---\n\`\`\`\n${content}\n\`\`\``;
            }).join('\n\n');
        }

        return PLANNER_USER_QUERY_REFINED_PROMPT
            .replace('{today}', today)
            .replace('{payloadJson}', JSON.stringify(payload, null, 2))
            .replace('{contextSummary}', refined.codebase_context_summary_by_ai || 'No specific codebase context provided.')
            .replace('{liveFilesString}', liveFilesString);
    }

    private async resolveCodebaseContext(agentId: string, fallback?: string): Promise<string | undefined> {
        if (fallback) return fallback;
        const ctx = await this.memoryManager.getContext(agentId, 'codebase_summary');
        return ctx?.context_data?.summary;
    }

    private buildUserQueryForGoal(goal: string, codebaseContext?: string, liveFilesContent?: Map<string, string>): string {
        const today = new Date().toISOString().split('T')[0];
        let liveFilesString = 'No live files provided for review.';
        if (liveFilesContent && liveFilesContent.size > 0) {
            liveFilesString = Array.from(liveFilesContent.entries()).map(([path, content]) => {
                return `--- FILE: ${path} ---\n\`\`\`\n${content}\n\`\`\``;
            }).join('\n\n');
        }

        return PLANNER_USER_QUERY_GOAL_PROMPT
            .replace(/{today}/g, today)
            .replace('{goal}', goal)
            .replace('{codebaseContext}', codebaseContext || 'No specific codebase context provided.')
            .replace('{liveFilesString}', liveFilesString);
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
                kpis: resp.kpis,
                dependency_analysis: resp.dependency_analysis,
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

            // Handle new risk and skill fields
            const allRisks = t.task_risks || t.risks || [];
            const allSkills = t.roles_required || t.required_skills || [];

            // Add new fields to notes if they exist
            if (t.risks !== undefined && t.risks.length > 0) {
                notes.task_risks = [...(notes.task_risks || []), ...t.risks];
            }
            if (t.required_skills !== undefined && t.required_skills.length > 0) {
                notes.required_skills = t.required_skills;
            }

            return {
                task_number: taskNumber,
                title: safeTitle,
                description: safeDescription,
                purpose: safePurpose,
                status: TASK_STATUS_PLANNED,
                estimated_duration_days: t.estimated_duration_days,
                estimated_effort_hours: t.estimated_effort_hours,
                task_risks: allRisks.length > 0 ? allRisks : t.task_risks,
                micro_steps: t.micro_steps,
                suggested_files_involved: t.suggested_files_involved ?? [],
                dependencies_task_ids_json: t.task_dependencies ? JSON.stringify(t.task_dependencies) : null,
                tools_required_list_json: allSkills.length > 0 ? JSON.stringify(allSkills) : (t.roles_required ? JSON.stringify(t.roles_required) : null),
                assigned_to: t.roles_required ? JSON.stringify(t.roles_required) : null,
                success_criteria_text: t.completion_criteria ?? null,
                code_content: t.code_content ?? null,
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