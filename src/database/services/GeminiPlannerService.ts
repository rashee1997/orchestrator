// src/database/services/GeminiPlannerService.ts
import { GeminiIntegrationService, GeminiApiNotInitializedError } from './GeminiIntegrationService.js';
import { MemoryManager } from '../memory_manager.js';
import { randomUUID } from 'crypto';
import { KnowledgeGraphManager } from '../managers/KnowledgeGraphManager.js';
import { GeminiPlannerResponseSchema } from './gemini-integration-modules/GeminiSchema.js';
import { parseGeminiJsonResponse } from './gemini-integration-modules/GeminiResponseParsers.js'; // Added this import

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
            systemInstruction = this.getSystemInstructionForRefinedPrompt();
            const planGenerationRefinedPromptDetails = this.extractPlanGenerationPayload(refinedPromptDetails);

            userQuery = this.buildUserQueryForRefinedPrompt(planGenerationRefinedPromptDetails, refinedPromptDetails, liveFilesContent);
        } else {
            // ---- High-level Goal Path -------------------------------------------------
            const codebaseContext = await this.resolveCodebaseContext(agentId, codebaseContextSummary);
            systemInstruction = this.getSystemInstructionForGoal();
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

    private getSystemInstructionForRefinedPrompt(): string {
        return `You are an expert project planning assistant and senior software engineer with expertise in risk mitigation and realistic project planning.

You will be given a structured input object and your task is to generate a **comprehensive, risk-mitigated project plan** in JSON format.

⚠️ CRITICAL OUTPUT RULES
- You MUST output ONLY a valid JSON object with NO additional text, markdown, or explanations.
- Start your response directly with \`{\` and end with \`}\`.
- Do NOT include \`\`\`json\` markers or any other formatting.
- The JSON must strictly follow the exact schema below with no extra fields.

Required JSON Schema:
{
  "plan_title": "string (max 10 words)",
  "estimated_duration_days": number,
  "target_start_date": "YYYY-MM-DD",
  "target_end_date": "YYYY-MM-DD",
  "kpis": ["string (e.g., 'Reduce response time by 30%', 'Improve accuracy by 25%', 'Reduce error rate to <5%')"],
  "dependency_analysis": "string (Comprehensive explanation of task interdependencies, critical paths, and potential blockers, explicitly noting whether tasks incrementally modify shared resources (like memory_manager.ts) or if a consolidated change is expected at a later stage.)",
  "plan_risks_and_mitigations": [
    {
      "risk_description": "string (specific technical, timeline, or resource risk)",
      "mitigation_strategy": "string (concrete, actionable mitigation with responsible party and timeline, including clear rollback procedures and verification steps)"
    }
  ],
  "tasks": [
    {
      "task_number": number,
      "title": "string (≤ 10 words, non-empty)",
      "description": "string (detailed explanation with technical considerations)",
      "purpose": "string (why this task is necessary and its value proposition)",
      "estimated_duration_days": "number (realistic, not optimistic)",
      "estimated_effort_hours": "number (realistic estimate in hours)", // ADDED
      "assigned_to": "string (e.g., 'Team A', 'Frontend Dev', 'AI Agent')", // ADDED
      "suggested_files_involved": ["array", "of", "file", "paths"],
      "code_content": "string (PRODUCTION-READY code with error handling, logging, and tests)",
      "completion_criteria": "string (specific, measurable, testable criteria)",
      "dependencies_task_ids_json": ["array", "of", "task", "title", "strings"],
      "risks": ["array", "of", "specific", "task-level", "risks"],
      "required_skills": ["array", "of", "skills", "or", "expertise", "needed"]
    }
  ]
}

Task Generation Rules:
1. **Realistic Timeline**: Use conservative time estimates. Complex tasks should be 3-7 days minimum. Total project should be 2-4 weeks for typical implementations.
2. **No Placeholders**: For ALL coding tasks, provide COMPLETE, PRODUCTION-READY code with proper error handling, logging, input validation, and performance considerations.
3. **Risk-First Approach**: Identify risks early and build mitigation strategies into the plan structure.
4. **Measurable Success**: Every task must have specific, quantitative completion criteria and KPIs.
5. **Comprehensive Dependencies**: Map out ALL interdependencies, including external systems, APIs, and resource constraints. Explicitly clarify if tasks involve incremental modifications to shared resources (like memory_manager.ts) or if a consolidated change is expected at a later stage.
6. **Quality Gates**: Include explicit quality assurance tasks, code reviews, testing phases, and validation steps. Always include a dedicated task for refactoring or updating existing unit tests affected by the changes.
7. **Resource Planning**: Specify required skills, tools, and infrastructure for each task. Provide realistic estimated_effort_hours and assigned_to values for each task.
8. **Contingency Planning**: Include buffer time and alternative approaches for critical path tasks. Always define clear, step-by-step rollback procedures and verification steps.

Code Content Rules:
- **NEW Files**: Complete, documented source code with error handling, logging, and unit tests
- **EXISTING Files**: Valid unified diffs that maintain system integrity and include proper error handling
- **NEVER Use**: "// TODO", "placeholder", "implement later", or empty implementations
- **ALWAYS Include**: Input validation, error handling, logging, performance considerations

Quality Requirements:
- Include unit tests and integration tests for all code
- Add performance monitoring and alerting
- Implement proper error handling and graceful degradation
- Include comprehensive documentation and code comments
- Plan for scalability and maintainability

FINAL REMINDER: Output ONLY the JSON object. No explanations, no markdown, no additional text.`;
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
        liveFilesContent?: Map<string, string>
    ): string {
        const today = new Date().toISOString().split('T')[0];
        let liveFilesString = 'No live files provided for review.';
        if (liveFilesContent && liveFilesContent.size > 0) {
            liveFilesString = Array.from(liveFilesContent.entries()).map(([path, content]) => {
                return `--- FILE: ${path} ---\n\`\`\`\n${content}\n\`\`\``;
            }).join('\n\n');
        }

        return `Analyze the following 'Refined Prompt Object' and generate a complete project plan. Today's date is ${today}. Use this for start and end dates.

Refined Prompt Object:
${JSON.stringify(payload, null, 2)}

Consider the following codebase context and live file content when generating the plan and tasks:
Refined Prompt Context Summary:
${refined.codebase_context_summary_by_ai || 'No specific codebase context provided.'}

Live File Content:
${liveFilesString}

Generate a JSON object with this EXACT structure:
{
  "plan_title": "string (max 10 words)",
  "estimated_duration_days": number,
  "target_start_date": "YYYY-MM-DD",
  "target_end_date": "YYYY-MM-DD",
  "plan_risks_and_mitigations": [
    {
      "risk_description": "string",
      "mitigation_strategy": "string"
    }
  ],
  "tasks": [
    {
      "task_number": number,
      "title": "string (≤ 10 words, non-empty)",
      "description": "string (detailed explanation)",
      "purpose": "string (why this task is necessary)",
      "suggested_files_involved": ["array", "of", "file", "paths"],
      "code_content": "string (full code for new files OR unified diff for existing files)",
      "completion_criteria": "string (measurable criteria)",
      "dependencies_task_ids_json": ["array", "of", "task", "title", "strings"]
    }
  ]
}

IMPORTANT: Output ONLY the JSON object. Do NOT include any explanations, markdown, or additional text. Start with { and end with }.`;
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

        return `Analyze the following user goal and generate a detailed project plan. Today's date is ${today}. Use this for start and end dates.

User Goal:
"${goal}"

Codebase context:
\`\`\`
${codebaseContext || 'No specific codebase context provided.'}
\`\`\`
Live File Content for analysis:
\`\`\`
${liveFilesString}
\`\`\`

Provide a JSON object with:
1. plan_title (max 10 words)
2. overall_plan_goal (re-phrased)
3. estimated_duration_days (integer)
4. target_start_date ("YYYY-MM-DD", today = ${today})
5. target_end_date (calculated)
6. plan_risks_and_mitigations: an array of objects, each with "risk_description" and "mitigation_strategy" string properties.
7. tasks: an array of task objects, each containing:
   - task_number (integer)
   - title (string)
   - description (string)
   - purpose (string)
   - suggested_files_involved (array of strings)
   - code_content (string, either full code for new files or a diff for existing files, mandatory for coding tasks)
   - completion_criteria (string)
   - dependencies_task_ids_json (array of strings, referencing other task titles)

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
