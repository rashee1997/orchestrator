// src/database/services/GeminiPlannerService.ts
import { GeminiIntegrationService, GeminiApiNotInitializedError } from './GeminiIntegrationService.js';
import { MemoryManager } from '../memory_manager.js';
import { randomUUID } from 'crypto';

// Interface for the expected structure from Gemini for detailed plan generation
interface GeminiDetailedPlanGenerationResponse {
    plan_title: string;
    overall_plan_goal: string;
    estimated_duration_days: number;
    target_start_date: string;
    target_end_date: string;
    plan_risks_and_mitigations: Array<{
        risk_description: string;
        mitigation_strategy: string;
    }>;
    tasks: Array<{
        task_title: string;
        task_description: string;
        task_purpose: string;
        estimated_effort_hours: number;
        task_risks: string[];
        micro_steps: string[];
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
    }>;
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
        directRefinedPromptDetails?: any
    ): Promise<InitialDetailedPlanAndTasks> {
        let systemInstruction: string;
        let userQuery: string;
        let refinedPromptIdForPlan: string | null = null;

        // Referencing prompts from gemini_plan_generation_prompts_v2
        if (isRefinedPromptId) {
            let refinedPromptDetails = directRefinedPromptDetails;
            if (!refinedPromptDetails) {
                refinedPromptDetails = await this.memoryManager.getRefinedPrompt(agentId, identifier);
                if (!refinedPromptDetails) {
                    throw new Error(`Refined prompt with ID '${identifier}' not found for agent '${agentId}'.`);
                }
            }
            refinedPromptIdForPlan = identifier;

            systemInstruction = "You are an expert project planning assistant. You will be given a structured 'Refined Prompt Object' that details a user's request. Your task is to transform this into a detailed project plan. The plan should include an overall goal (from the refined prompt), estimated duration, placeholder start/end dates, potential risks and their mitigations for the overall plan. Also, generate a list of 3-5 actionable high-level tasks. Derive the plan title from the refined prompt's overall goal. Each task should have a title (based on refined prompt's decomposed tasks/entities), description, purpose, estimated effort in hours, potential risks specific to the task, and a few micro-steps. The output MUST be a valid JSON object adhering to the specified schema. Do not include any explanatory text outside the JSON object.";
            userQuery = `Analyze the following 'Refined Prompt Object' and generate a detailed project plan structure.

Refined Prompt Object:
\`\`\`json
${JSON.stringify(refinedPromptDetails, null, 2)}
\`\`\`

Based on this refined prompt, provide:
1.  A concise \`plan_title\` derived from the \`overall_goal\` in the refined prompt (max 10 words).
2.  The \`overall_plan_goal\` directly from the refined prompt's \`overall_goal\` field.
3.  An \`estimated_duration_days\` for the entire plan (integer).
4.  A \`target_start_date\` (string, "YYYY-MM-DD", use "YYYY-MM-DD (placeholder)" if not inferable).
5.  A \`target_end_date\` (string, "YYYY-MM-DD", use "YYYY-MM-DD (placeholder)" if not inferable).
6.  A list of \`plan_risks_and_mitigations\` (array of objects, each with \`risk_description\` and \`mitigation_strategy\`).
7.  A list of 3-5 high-level \`tasks\`. Each task should have:
    * \`task_title\`: A short, descriptive title, ideally based on or combining elements from \`decomposed_tasks\` or \`key_entities_identified\` from the refined prompt.
    * \`task_description\`: A brief explanation of what the task involves, expanding on the \`task_title\` using context from the refined prompt.
    * \`task_purpose\`: The reason this task is necessary, linking back to the \`overall_plan_goal\`.
    * \`estimated_effort_hours\`: Estimated effort for the task in hours (integer).
    * \`task_risks\`: A list of potential risks specific to this task (array of strings).
    * \`micro_steps\`: A list of 3-5 granular sub-actions or steps for completing the task (array of strings).

Output the result as a single JSON object with the following structure:
{
  "plan_title": "string",
  "overall_plan_goal": "string",
  "estimated_duration_days": "integer",
  "target_start_date": "string",
  "target_end_date": "string",
  "plan_risks_and_mitigations": [ { "risk_description": "string", "mitigation_strategy": "string" } ],
  "tasks": [ { "task_title": "string", "task_description": "string", "task_purpose": "string", "estimated_effort_hours": "integer", "task_risks": ["string"], "micro_steps": ["string"] } ]
}`;
        } else { // Identifier is a high-level goal description
            systemInstruction = "You are an expert project planning assistant. Your task is to take a user's high-level goal and break it down into a structured and detailed project plan. The plan should include an overall goal, estimated duration, start/end dates (use placeholder dates like YYYY-MM-DD if specific dates are not inferable from the goal, but indicate they are placeholders), potential risks and their mitigations for the overall plan. Also, generate a list of 3-5 actionable high-level tasks. Each task should include a title, description, purpose, estimated effort in hours, potential risks specific to the task, and a few micro-steps (sub-actions). The output MUST be a valid JSON object adhering to the specified schema. Do not include any explanatory text outside the JSON object.";
            userQuery = `Analyze the following user goal and generate a detailed project plan structure.

User Goal:
"${identifier}"

Based on this goal, provide:
1.  A concise \`plan_title\` (max 10 words).
2.  An \`overall_plan_goal\` that rephrases or clarifies the user's goal for the project plan (1-2 sentences).
3.  An \`estimated_duration_days\` for the entire plan (integer).
4.  A \`target_start_date\` (string, "YYYY-MM-DD", use "YYYY-MM-DD (placeholder)" if not inferable).
5.  A \`target_end_date\` (string, "YYYY-MM-DD", use "YYYY-MM-DD (placeholder)" if not inferable).
6.  A list of \`plan_risks_and_mitigations\` (array of objects, each with \`risk_description\` and \`mitigation_strategy\`).
7.  A list of 3-5 high-level \`tasks\`. Each task should have:
    * \`task_title\`: A short, descriptive title (max 10 words).
    * \`task_description\`: A brief explanation of what the task involves (1-2 sentences).
    * \`task_purpose\`: The reason this task is necessary for the overall plan goal (1 sentence).
    * \`estimated_effort_hours\`: Estimated effort for the task in hours (integer).
    * \`task_risks\`: A list of potential risks specific to this task (array of strings).
    * \`micro_steps\`: A list of 3-5 granular sub-actions or steps for completing the task (array of strings).

Output the result as a single JSON object with the following structure:
{
  "plan_title": "string",
  "overall_plan_goal": "string",
  "estimated_duration_days": "integer",
  "target_start_date": "string",
  "target_end_date": "string",
  "plan_risks_and_mitigations": [ { "risk_description": "string", "mitigation_strategy": "string" } ],
  "tasks": [ { "task_title": "string", "task_description": "string", "task_purpose": "string", "estimated_effort_hours": "integer", "task_risks": ["string"], "micro_steps": ["string"] } ]
}`;
        }

        let geminiResponseText: string;
        try {
            const geminiResult = await this.geminiIntegrationService.askGemini(userQuery, this.geminiModel, systemInstruction);
            if (!geminiResult || !geminiResult.content || geminiResult.content.length === 0 || !geminiResult.content[0]?.text) {
                throw new Error("Gemini returned no content or an unexpected format for plan generation.");
            }
            geminiResponseText = geminiResult.content[0].text;
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
            const jsonMatch = geminiResponseText.match(/```json\n([\s\S]*?)\n```/);
            if (jsonMatch && jsonMatch[1]) {
                jsonToParse = jsonMatch[1].trim();
            } else {
                // If no markdown block, assume the entire trimmed response is JSON
                jsonToParse = geminiResponseText.trim();
            }

            // Remove trailing commas before parsing
            jsonToParse = jsonToParse.replace(/,(\s*[\]}])/g, '$1');

            parsedResponse = JSON.parse(jsonToParse);
        } catch (error) {
            console.error("Error parsing Gemini's JSON response for detailed plan generation. Raw response:", geminiResponseText);
            throw new Error(`Failed to parse detailed plan structure from Gemini response: ${error instanceof Error ? error.message : String(error)}. Raw response: ${geminiResponseText}`);
        }

        // Transform Gemini response to InitialDetailedPlanAndTasks structure
        const planData: InitialDetailedPlanAndTasks['planData'] = {
            title: parsedResponse.plan_title,
            overall_goal: parsedResponse.overall_plan_goal,
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

        const tasksData: InitialDetailedPlanAndTasks['tasksData'] = parsedResponse.tasks.map((task, index) => {
            const notes: TaskNotes = {}; // Use the specific TaskNotes interface
            if (task.task_risks && task.task_risks.length > 0) {
                notes.task_risks = task.task_risks;
            }
            if (task.micro_steps && task.micro_steps.length > 0) {
                notes.micro_steps = task.micro_steps;
            }

            return {
                task_number: index + 1,
                title: task.task_title,
                description: task.task_description,
                purpose: task.task_purpose,
                status: TASK_STATUS_PLANNED,
                estimated_effort_hours: task.estimated_effort_hours,
                task_risks: task.task_risks, // Directly assign task_risks
                micro_steps: task.micro_steps, // Directly assign micro_steps
                ...(Object.keys(notes).length > 0 && { notes_json: JSON.stringify(notes) }),
            };
        });

        return { planData, tasksData };
    }
}
