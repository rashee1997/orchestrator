import { GoogleGenAI, createUserContent, createPartFromUri } from '@google/genai';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../services/DatabaseService.js';
import { ContextInformationManager } from '../managers/ContextInformationManager.js';

export class GeminiIntegrationService {
    private genAI?: GoogleGenAI;
    private dbService: DatabaseService;
    private contextManager: ContextInformationManager;

    constructor(dbService: DatabaseService, contextManager: ContextInformationManager, genAIInstance?: GoogleGenAI) {
        this.dbService = dbService;
        this.contextManager = contextManager;
        if (genAIInstance) {
            this.genAI = genAIInstance;
        } else {
            const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
            if (!GEMINI_API_KEY) {
                this.genAI = undefined;
            } else {
                this.genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
            }
        }
    }

    async summarizeContext(
        agent_id: string,
        context_type: string,
        version: number | null = null
    ) {
        if (!this.genAI) {
            return `Gemini API not initialized. Cannot perform summarization.`;
        }

        const modelName = "gemini-2.0-flash";

        const db = this.dbService.getDb();
        const contextResult = await this.contextManager.getContext(agent_id, context_type, version);

        if (!contextResult || !contextResult.context_data) {
            return `No context found for agent_id: ${agent_id}, context_type: ${context_type}`;
        }

        let textToSummarize = '';
        if (contextResult.context_data.documentation_snippets && Array.isArray(contextResult.context_data.documentation_snippets)) {
            textToSummarize = contextResult.context_data.documentation_snippets.map((s: any) => `${s.TITLE}: ${s.DESCRIPTION} ${s.CODE}`).join('\n\n');
        } else {
            textToSummarize = JSON.stringify(contextResult.context_data);
        }

        if (textToSummarize.length === 0) {
            return `No content to summarize for agent_id: ${agent_id}, context_type: ${context_type}`;
        }

        try {
            const prompt = `Summarize the following text:\n\n${textToSummarize}`;
            const result = await this.genAI.models.generateContent({ model: modelName, contents: [{ role: "user", parts: [{ text: prompt }] }] });
            const summary = result.text;
            return summary;
        } catch (error: any) {
            console.error(`Error calling Gemini API for summarization:`, error);
            return `Failed to summarize context using Gemini API: ${error.message}`;
        }
    }

    async extractEntities(
        agent_id: string,
        context_type: string,
        version: number | null = null
    ) {
        if (!this.genAI) {
            return { entities: [], keywords: [], message: `Gemini API not initialized. Cannot perform entity extraction.` };
        }

        const modelName = "gemini-2.0-flash";

        const db = this.dbService.getDb();
        const contextResult = await this.contextManager.getContext(agent_id, context_type, version);

        if (!contextResult || !contextResult.context_data) {
            return { entities: [], keywords: [], message: `No context found for agent_id: ${agent_id}, context_type: ${context_type}` };
        }

        let textToExtractFrom = '';
        if (contextResult.context_data.documentation_snippets && Array.isArray(contextResult.context_data.documentation_snippets)) {
            textToExtractFrom = contextResult.context_data.documentation_snippets.map((s: any) => `${s.TITLE}: ${s.DESCRIPTION} ${s.CODE}`).join('\n\n');
        } else {
            textToExtractFrom = JSON.stringify(contextResult.context_data);
        }

        if (textToExtractFrom.length === 0) {
            return { entities: [], keywords: [], message: `No content to extract entities from for agent_id: ${agent_id}, context_type: ${context_type}` };
        }

        try {
            const prompt = `Extract key entities and keywords from the following text. Provide the output as a JSON object with two arrays: 'entities' and 'keywords'.\n\n${textToExtractFrom}`;
            const result = await this.genAI.models.generateContent({ model: modelName, contents: [{ role: "user", parts: [{ text: prompt }] }] });
            const textResponse = result.text ?? '';

            try {
                let jsonString = textResponse;
                const jsonMatch = textResponse.match(/```json\n([\s\S]*?)\n```/);
                if (jsonMatch && jsonMatch[1]) {
                    jsonString = jsonMatch[1];
                }
                const parsedResponse = JSON.parse(jsonString);
                return {
                    entities: parsedResponse.entities || [],
                    keywords: parsedResponse.keywords || [],
                    message: `Successfully extracted entities and keywords using Gemini API.`
                };
            } catch (parseError) {
                console.error(`Error parsing Gemini API response for entity extraction:`, parseError);
                return { entities: [], keywords: [], message: `Failed to parse Gemini API response: ${textResponse}` };
            }
        } catch (error: any) {
            console.error(`Error calling Gemini API for entity extraction:`, error);
            return { entities: [], keywords: [], message: `Failed to extract entities using Gemini API: ${error.message}` };
        }
    }

    async semanticSearchContext(
        agent_id: string,
        context_type: string,
        query_text: string,
        top_k: number = 5
    ) {
        if (!this.genAI) {
            return { results: [], message: `Gemini API not initialized. Cannot perform semantic search.` };
        }

        const modelName = "models/text-embedding-004";

        const db = this.dbService.getDb();
        const contextResult = await this.contextManager.getContext(agent_id, context_type);

        if (!contextResult || !contextResult.context_data || !contextResult.context_data.documentation_snippets || !Array.isArray(contextResult.context_data.documentation_snippets)) {
            return { results: [], message: `No context or documentation snippets found for agent_id: ${agent_id}, context_type: ${context_type}` };
        }

        try {
            const queryEmbeddingResponse = await this.genAI.models.embedContent({ model: modelName, contents: [{ text: query_text }] });
            const queryEmbedding = queryEmbeddingResponse.embeddings?.[0]?.values || [];

            const snippetsWithEmbeddings: { snippet: any; embedding: number[] }[] = [];

            for (const snippet of contextResult.context_data.documentation_snippets) {
                const snippetText = `${snippet.TITLE}: ${snippet.DESCRIPTION} ${snippet.CODE}`;
                const snippetEmbeddingResponse = await this.genAI.models.embedContent({ model: modelName, contents: [{ text: snippetText }] });
                snippetsWithEmbeddings.push({
                    snippet: snippet,
                    embedding: snippetEmbeddingResponse.embeddings?.[0]?.values || []
                });
            }

            const searchResults = snippetsWithEmbeddings.map(item => {
                const similarity = this.cosineSimilarity(queryEmbedding, item.embedding);
                return { score: similarity, snippet: item.snippet };
            }).sort((a, b) => b.score - a.score);

            return {
                results: searchResults.slice(0, top_k),
                message: `Successfully performed semantic search using Gemini API.`
            };
        } catch (error: any) {
            console.error(`Error calling Gemini API for semantic search:`, error);
            return { results: [], message: `Failed to perform semantic search using Gemini API: ${error.message}` };
        }
    }

    private cosineSimilarity(vecA: number[], vecB: number[]): number {
        let dotProduct = 0;
        let magnitudeA = 0;
        let magnitudeB = 0;

        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            magnitudeA += vecA[i] * vecA[i];
            magnitudeB += vecB[i] * vecB[i];
        }

        magnitudeA = Math.sqrt(magnitudeA);
        magnitudeB = Math.sqrt(magnitudeB);

        if (magnitudeA === 0 || magnitudeB === 0) {
            return 0;
        }

        return dotProduct / (magnitudeA * magnitudeB);
    }

    async processAndRefinePrompt(
        agent_id: string,
        raw_user_prompt: string,
        target_ai_persona: string | null = null,
        conversation_context_ids: string[] | null = null
    ): Promise<any> {
        if (!this.genAI) {
            return {
                refined_prompt_id: randomUUID(),
                original_prompt_text: raw_user_prompt,
                refinement_engine_model: "gemini-2.0-flash",
                refinement_timestamp: new Date().toISOString(),
                overall_goal: "Error: Gemini API not initialized.",
                decomposed_tasks: [],
                key_entities_identified: [],
                implicit_assumptions_made_by_refiner: [],
                explicit_constraints_from_prompt: [],
                suggested_ai_role_for_agent: null,
                suggested_reasoning_strategy_for_agent: null,
                desired_output_characteristics_inferred: {},
                suggested_context_analysis_for_agent: [],
                confidence_in_refinement_score: "Low",
                refinement_error_message: "Gemini API not initialized. Ensure GEMINI_API_KEY is set."
            };
        }

        const modelName = "gemini-2.0-flash";

        const metaPrompt = `
You are an expert AI prompt engineer. Your task is to take a raw user prompt, analyze it, and transform it into a highly structured and actionable "Refined Prompt for AI". This refined prompt will be used by another AI agent to understand and execute the user's request.

You MUST output the refined prompt as a JSON object, strictly adhering to the following schema. Do not include any other text or markdown outside of the JSON block.

JSON Schema for Refined Prompt:
\`\`\`json
{
  "refined_prompt_id": "server_generated_uuid_for_this_refinement_instance",
  "original_prompt_text": "The exact raw user prompt text that was processed.",
  "refinement_engine_model": "gemini-2.0-flash",
  "refinement_timestamp": "YYYY-MM-DDTHH:MM:SS.sssZ",
  "overall_goal": "A clear, concise statement of the user's primary objective, as interpreted from the prompt.",
  "decomposed_tasks": [ // Array of strings, each a specific, actionable sub-task
    "Sub-task 1 identified from the prompt.",
    "Sub-task 2 identified from the prompt."
  ],
  "key_entities_identified": [ // Array of strings or objects detailing key entities
    // Example: "Filename: user_authentication.py", "Concept: Argon2 Hashing"
    // Or structured: {"type": "filename", "value": "user_authentication.py"}, {"type": "concept", "value": "Argon2 Hashing"}
    "Entity A (e.g., filename, function name, concept)",
    "Entity B"
  ],
  "implicit_assumptions_made_by_refiner": [ // Assumptions the refinement LLM made
    "Assuming 'the dashboard' refers to the main application dashboard.",
    "Assuming standard Python library availability unless specified otherwise."
  ],
  "explicit_constraints_from_prompt": [ // Constraints directly stated by the user
    "The solution must be implemented in Python 3.9.",
    "The UI must remain consistent with the existing design language."
  ],
  "suggested_ai_role_for_agent": "Example: Act as a Senior Python Developer specializing in API security and database interactions.",
  "suggested_reasoning_strategy_for_agent": "Example: Prioritize security best practices. Analyze potential attack vectors. Ensure input validation. Plan for data migration if schema changes are needed.",
  "desired_output_characteristics_inferred": {
    "type": "Example: A fully functional Python module with accompanying unit tests.", // e.g., Code Solution, Explanatory text, Plan, Diagram
    "key_content_elements": [ // Specific items the final output from the agent should contain
      "Refactored Python code for user_authentication.py.",
      "Detailed explanation of Argon2 parameter choices.",
      "Unit tests covering new hashing and verification logic."
    ],
    "level_of_detail": "Example: Sufficient for another developer to understand, integrate, and maintain the changes." // e.g., High-level overview, Detailed step-by-step
  },
  "suggested_context_analysis_for_agent": [ // Actionable suggestions for the AI agent
    // Can be simple strings or more structured objects. Prioritize memory retrieval tools.
    {
      "suggestion_type": "MEMORY_RETRIEVAL",
      "tool_to_use": "get_conversation_history",
      "parameters": {"limit": 5, "offset": 0},
      "rationale": "To understand immediate preceding dialogue for context."
    },
    {
      "suggestion_type": "MEMORY_RETRIEVAL",
      "tool_to_use": "search_context_by_keywords",
      "parameters": {"context_type": "project_documentation_v1", "keywords": "authentication security policy"},
      "rationale": "Prompt mentions security and authentication; check for existing policies."
    },
    {
      "suggestion_type": "KNOWLEDGE_GRAPH_QUERY",
      "tool_to_use": "knowledge_graph_memory",
      "parameters": {"operation": "search_nodes", "query": "Argon2 implementation details"},
      "rationale": "To find any existing internal knowledge about Argon2."
    },
    {
      "suggestion_type": "FILE_ANALYSIS_SUGGESTION",
      "tool_to_use": "read_file",
      "parameters": {"path": "src/config/app_settings.json"},
      "rationale": "If the prompt implies configuration, check common config files."
    }
  ],
  "confidence_in_refinement_score": "High", // e.g., High, Medium, Low
  "refinement_error_message": null // String message if refinement process itself had an issue, otherwise null
}
\`\`\`

Raw User Prompt:
\`\`\`
${raw_user_prompt}
\`\`\`

${target_ai_persona ? `Suggested AI Persona: ${target_ai_persona}\n` : ''}
${conversation_context_ids && conversation_context_ids.length > 0 ? `Recent Conversation Context IDs: ${conversation_context_ids.join(', ')}\n` : ''}

Please provide the JSON object only.
`;

        try {
            const result = await this.genAI.models.generateContent({
                model: modelName,
                contents: [{ role: "user", parts: [{ text: metaPrompt }] }]
            });
            const textResponse = result.text ?? '';

            let parsedResponse: any;
            try {
                // Attempt to parse the JSON response, handling markdown code blocks
                let jsonString = textResponse;
                const jsonMatch = textResponse.match(/```json\n([\s\S]*?)\n```/);
                if (jsonMatch && jsonMatch[1]) {
                    jsonString = jsonMatch[1];
                }
                parsedResponse = JSON.parse(jsonString);
            } catch (parseError) {
                console.error(`Error parsing Gemini API response for prompt refinement:`, parseError);
                return {
                    refined_prompt_id: randomUUID(),
                    original_prompt_text: raw_user_prompt,
                    refinement_engine_model: modelName,
                    refinement_timestamp: new Date().toISOString(),
                    overall_goal: "Error: Failed to parse Gemini API response.",
                    decomposed_tasks: [],
                    key_entities_identified: [],
                    implicit_assumptions_made_by_refiner: [],
                    explicit_constraints_from_prompt: [],
                    suggested_ai_role_for_agent: null,
                    suggested_reasoning_strategy_for_agent: null,
                    desired_output_characteristics_inferred: {},
                    suggested_context_analysis_for_agent: [],
                    confidence_in_refinement_score: "Low",
                    refinement_error_message: `Failed to parse Gemini API response: ${textResponse.substring(0, 200)}...`
                };
            }

            // Ensure server-generated fields are correct
            parsedResponse.refined_prompt_id = randomUUID();
            parsedResponse.original_prompt_text = raw_user_prompt;
            parsedResponse.refinement_engine_model = modelName;
            parsedResponse.refinement_timestamp = new Date().toISOString();
            parsedResponse.agent_id = agent_id; // Add agent_id to the refined prompt object

            // Store the refined prompt in the database
            await this.storeRefinedPrompt(parsedResponse);

            return parsedResponse;

        } catch (error: any) {
            console.error(`Error calling Gemini API for prompt refinement:`, error);
            return {
                refined_prompt_id: randomUUID(),
                original_prompt_text: raw_user_prompt,
                refinement_engine_model: modelName,
                refinement_timestamp: new Date().toISOString(),
                overall_goal: "Error: Gemini API call failed.",
                decomposed_tasks: [],
                key_entities_identified: [],
                implicit_assumptions_made_by_refiner: [],
                explicit_constraints_from_prompt: [],
                suggested_ai_role_for_agent: null,
                suggested_reasoning_strategy_for_agent: null,
                desired_output_characteristics_inferred: {},
                suggested_context_analysis_for_agent: [],
                confidence_in_refinement_score: "Low",
                refinement_error_message: `Gemini API call failed: ${error.message}`
            };
        }
    }

    // --- New: Store Refined Prompt Tool ---
    async storeRefinedPrompt(refinedPrompt: any): Promise<string> {
        const db = this.dbService.getDb();
        const refined_prompt_id = refinedPrompt.refined_prompt_id || randomUUID();
        const timestamp = refinedPrompt.refinement_timestamp ? new Date(refinedPrompt.refinement_timestamp).getTime() : Date.now();

        await db.run(
            `INSERT INTO refined_prompts (
                refined_prompt_id, agent_id, original_prompt_text, refinement_engine_model,
                refinement_timestamp, overall_goal, decomposed_tasks, key_entities_identified,
                implicit_assumptions_made_by_refiner, explicit_constraints_from_prompt,
                suggested_ai_role_for_agent, suggested_reasoning_strategy_for_agent,
                desired_output_characteristics_inferred, suggested_context_analysis_for_agent,
                confidence_in_refinement_score, refinement_error_message
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            refined_prompt_id,
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
            refinedPrompt.confidence_in_refinement_score || null,
            refinedPrompt.refinement_error_message || null
        );
        return refined_prompt_id;
    }

    async getRefinedPrompt(refined_prompt_id: string): Promise<any | null> {
        const db = this.dbService.getDb();
        const result = await db.get(
            `SELECT * FROM refined_prompts WHERE refined_prompt_id = ?`,
            refined_prompt_id
        );

        if (result) {
            if (result.decomposed_tasks) result.decomposed_tasks = JSON.parse(result.decomposed_tasks);
            if (result.key_entities_identified) result.key_entities_identified = JSON.parse(result.key_entities_identified);
            if (result.implicit_assumptions_made_by_refiner) result.implicit_assumptions_made_by_refiner = JSON.parse(result.implicit_assumptions_made_by_refiner);
            if (result.explicit_constraints_from_prompt) result.explicit_constraints_from_prompt = JSON.parse(result.explicit_constraints_from_prompt);
            if (result.desired_output_characteristics_inferred) result.desired_output_characteristics_inferred = JSON.parse(result.desired_output_characteristics_inferred);
            if (result.suggested_context_analysis_for_agent) result.suggested_context_analysis_for_agent = JSON.parse(result.suggested_context_analysis_for_agent);
        }
        return result;
    }
}
