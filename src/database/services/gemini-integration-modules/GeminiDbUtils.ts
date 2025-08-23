import { randomUUID } from 'crypto';
import { DatabaseService } from '../DatabaseService.js';
import { GeminiApiClient, GeminiApiNotInitializedError } from './GeminiApiClient.js';
import { SUMMARIZE_CONVERSATION_PROMPT, SUMMARIZE_CORRECTION_LOGS_PROMPT } from './GeminiPromptTemplates.js';
import { Part } from '@google/genai'; // Import Part for askGemini return type

export class GeminiDbUtils {
    private dbService: DatabaseService;
    private geminiApiClient: GeminiApiClient;
    private summarizationModelName: string; // Need to pass this from GeminiIntegrationService

    constructor(dbService: DatabaseService, geminiApiClient: GeminiApiClient, summarizationModelName: string) {
        this.dbService = dbService;
        this.geminiApiClient = geminiApiClient;
        this.summarizationModelName = summarizationModelName;
    }

    async storeRefinedPrompt(refinedPrompt: any): Promise<string> {
        const db = this.dbService.getDb();
        let refined_prompt_id = refinedPrompt.refined_prompt_id || randomUUID();
        const timestamp = refinedPrompt.refinement_timestamp ? new Date(refinedPrompt.refinement_timestamp).getTime() : Date.now();

        let isUnique = false;
        while (!isUnique) {
            const existing = await db.get(`SELECT refined_prompt_id FROM refined_prompts WHERE refined_prompt_id = ?`, refined_prompt_id);
            if (existing) {
                refined_prompt_id = randomUUID();
            } else {
                isUnique = true;
            }
        }
        refinedPrompt.refined_prompt_id = refined_prompt_id;

        await db.run(
            `INSERT INTO refined_prompts (
                refined_prompt_id, agent_id, original_prompt_text, refinement_engine_model,
                refinement_timestamp, overall_goal, decomposed_tasks, key_entities_identified,
                implicit_assumptions_made_by_refiner, explicit_constraints_from_prompt,
                suggested_ai_role_for_agent, suggested_reasoning_strategy_for_agent,
                desired_output_characteristics_inferred, suggested_context_analysis_for_agent,
                codebase_context_summary_by_ai, relevant_code_elements_analyzed,
                confidence_in_refinement_score, refinement_error_message, generation_metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            refinedPrompt.refined_prompt_id,
            refinedPrompt.agent_id,
            refinedPrompt.original_prompt_text,
            refinedPrompt.refinement_engine_model || null,
            timestamp,
            refinedPrompt.overall_goal || null,
            refinedPrompt.decomposed_tasks ? JSON.stringify(refinedPrompt.decomposed_tasks) : null,
            refinedPrompt.key_entities_identified ? JSON.stringify(refinedPrompt.key_entities_identified) : null,
            refinedPrompt.implicit_assumptions_made_by_refiner ? JSON.stringify(refinedPrompt.implicit_assumptions_made_by_refiner) : null,
            refinedPrompt.explicit_constraints_from_prompt ? JSON.stringify(refinedPrompt.explicit_constraints_from_prompt) : null,
            refinedPrompt.suggested_ai_role_for_agent || null,
            refinedPrompt.suggested_reasoning_strategy_for_agent || null,
            refinedPrompt.desired_output_characteristics_inferred ? JSON.stringify(refinedPrompt.desired_output_characteristics_inferred) : null,
            refinedPrompt.suggested_context_analysis_for_agent ? JSON.stringify(refinedPrompt.suggested_context_analysis_for_agent) : null,
            refinedPrompt.codebase_context_summary_by_ai || null,
            refinedPrompt.relevant_code_elements_analyzed ? JSON.stringify(refinedPrompt.relevant_code_elements_analyzed) : null,
            refinedPrompt.confidence_in_refinement_score || null,
            refinedPrompt.refinement_error_message || null,
            refinedPrompt.generation_metadata ? JSON.stringify(refinedPrompt.generation_metadata) : null // MODIFICATION: Store metadata
        );
        return refined_prompt_id;
    }

    async getRefinedPrompt(agent_id: string, refined_prompt_id: string): Promise<any | null> {
        const db = this.dbService.getDb();
        const result = await db.get(
            `SELECT * FROM refined_prompts WHERE agent_id = ? AND refined_prompt_id = ?`,
            agent_id, refined_prompt_id
        );

        if (result) {
            const fieldsToParse = [
                'decomposed_tasks', 'key_entities_identified',
                'implicit_assumptions_made_by_refiner', 'explicit_constraints_from_prompt',
                'desired_output_characteristics_inferred', 'suggested_context_analysis_for_agent',
                'relevant_code_elements_analyzed', 'generation_metadata_json' // MODIFICATION: Parse new metadata
            ];
            for (const field of fieldsToParse) {
                const jsonField = result[field];
                if (jsonField && typeof jsonField === 'string') {
                    try {
                        // MODIFICATION: Handle the new field name
                        const parsedFieldKey = field === 'generation_metadata_json' ? 'generation_metadata_parsed' : `${field}_parsed`;
                        result[parsedFieldKey] = JSON.parse(jsonField);
                    } catch (e) {
                        console.error(`Failed to parse ${field} for refined_prompt_id ${refined_prompt_id}:`, e);
                        const parsedFieldKey = field === 'generation_metadata_json' ? 'generation_metadata_parsed' : `${field}_parsed`;
                        result[parsedFieldKey] = null;
                        result[`${field}_parsing_error`] = true;
                        result[`raw_${field}`] = jsonField;
                    }
                } else {
                    const parsedFieldKey = field === 'generation_metadata_json' ? 'generation_metadata_parsed' : `${field}_parsed`;
                    result[parsedFieldKey] = jsonField === null ? null : jsonField;
                }
            }
            if (result.refinement_timestamp) {
                result.refinement_timestamp_iso = new Date(result.refinement_timestamp).toISOString();
            }
        }
        return result;
    }

    async summarizeCorrectionLogs(agent_id: string, maxLogs: number = 10): Promise<string> {
        const db = this.dbService.getDb();

        const correctionLogs = await db.all(
            `SELECT * FROM correction_logs WHERE agent_id = ? ORDER BY creation_timestamp_unix DESC LIMIT ?`,
            agent_id, maxLogs
        );

        if (!correctionLogs || correctionLogs.length === 0) {
            return 'No correction logs found to summarize.';
        }

        const textToSummarize = correctionLogs.map((log: any) => {
            let original = 'N/A';
            let corrected = 'N/A';
            try { original = log.original_value_json ? JSON.stringify(JSON.parse(log.original_value_json)) : 'N/A'; } catch { /* ignore */ }
            try { corrected = log.corrected_value_json ? JSON.stringify(JSON.parse(log.corrected_value_json)) : 'N/A'; } catch { /* ignore */ }

            return `Type: ${log.correction_type || 'N/A'}\nReason: ${log.reason || 'N/A'}\nOriginal: ${original}\nCorrected: ${corrected}\nStatus: ${log.status || 'N/A'}`;
        }).join('\n---\n');

        const prompt = SUMMARIZE_CORRECTION_LOGS_PROMPT.replace('{textToSummarize}', textToSummarize);

        try {
            const result = await this.geminiApiClient.askGemini(prompt, this.summarizationModelName);
            return result.content[0].text ?? 'Could not generate summary.';
        } catch (error: any) {
            console.error(`Error calling Gemini API for correction log summarization (agent: ${agent_id}):`, error);
            if (!(error instanceof GeminiApiNotInitializedError)) {
                return `Failed to summarize correction logs using Gemini API: ${error.message}`;
            }
            throw error;
        }
    }

    async summarizeConversation(
        agent_id: string,
        conversationMessages: string,
        modelName?: string
    ): Promise<string> {
        const modelToUse = modelName || this.summarizationModelName;

        const prompt = SUMMARIZE_CONVERSATION_PROMPT
            .replace('{agent_id}', agent_id)
            .replace('{conversationMessages}', conversationMessages);

        try {
            const result = await this.geminiApiClient.askGemini(prompt, modelToUse);
            return result.content[0].text ?? 'Conversation summary could not be generated.';
        } catch (error: any) {
            console.error(`Error summarizing conversation for agent ${agent_id}:`, error);
            throw new Error(`Failed to summarize conversation: ${error.message}`);
        }
    }
}