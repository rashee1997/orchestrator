import { GoogleGenAI, HarmCategory, HarmBlockThreshold, GenerationConfig, Content } from "@google/genai"; // Using GoogleGenAI as per user's old code
import { randomUUID } from 'crypto';
import { DatabaseService } from '../services/DatabaseService.js';
import { ContextInformationManager } from '../managers/ContextInformationManager.js';

// Custom error for when Gemini API is not initialized
export class GeminiApiNotInitializedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "GeminiApiNotInitializedError";
    }
}

export class GeminiIntegrationService {
    private genAI?: GoogleGenAI; // Using GoogleGenAI
    private dbService: DatabaseService;
    private contextManager: ContextInformationManager;
    private safetySettings = [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    ];
    private generationConfig: GenerationConfig = { // This might need to be part of the generateContent call argument directly
        temperature: 0.7,
        topK: 1,
        topP: 1,
        maxOutputTokens: 2048,
    };


    constructor(dbService: DatabaseService, contextManager: ContextInformationManager, genAIInstance?: GoogleGenAI) {
        this.dbService = dbService;
        this.contextManager = contextManager;
        if (genAIInstance) {
            this.genAI = genAIInstance;
        } else {
            const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
            if (!GEMINI_API_KEY) {
                this.genAI = undefined;
                console.warn('Gemini API key not found. GeminiIntegrationService will not be functional.');
            } else {
                this.genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY }); // User's constructor pattern
            }
        }
    }

    private checkApiInitialized() {
        if (!this.genAI) {
            throw new GeminiApiNotInitializedError("Gemini API not initialized. Ensure GEMINI_API_KEY is set.");
        }
    }

    async summarizeContext(
        agent_id: string,
        context_type: string,
        version: number | null = null
    ): Promise<string> {
        this.checkApiInitialized();

        const modelName = "gemini-2.5-flash-preview-05-20"; // Or "gemini-2.0-flash" from user's old code if preferred
        const contextResult = await this.contextManager.getContext(agent_id, context_type, version);

        if (!contextResult || (!contextResult.context_data && !contextResult.context_data_parsed)) {
            return `No context data found for agent_id: ${agent_id}, context_type: ${context_type}, version: ${version}`;
        }

        let textToSummarize = '';
        const dataToUse = contextResult.context_data_parsed || contextResult.context_data;

        if (dataToUse && dataToUse.documentation_snippets && Array.isArray(dataToUse.documentation_snippets)) {
            textToSummarize = dataToUse.documentation_snippets.map((s: any) => `${s.TITLE || ''}: ${s.DESCRIPTION || ''} ${s.CODE || ''}`).join('\n\n');
        } else if (typeof dataToUse === 'object') {
            textToSummarize = JSON.stringify(dataToUse);
        } else if (typeof dataToUse === 'string') {
             textToSummarize = dataToUse;
        }

        if (textToSummarize.trim().length === 0) {
            return `No content to summarize for agent_id: ${agent_id}, context_type: ${context_type}`;
        }

        try {
            const prompt = `Summarize the following text concisely:\n\n${textToSummarize}`;
            const contents: Content[] = [{ role: "user", parts: [{ text: prompt }] }];
            const result = await this.genAI!.models.generateContent({ 
                model: modelName, 
                contents: contents
            });
            // Assuming result.text is the way to get text from the response in this SDK version
            return result.text ?? 'Could not generate summary.'; 
        } catch (error: any) {
            console.error(`Error calling Gemini API for summarization (context: ${context_type}, agent: ${agent_id}):`, error);
            throw new Error(`Failed to summarize context using Gemini API: ${error.message}`);
        }
    }

    async extractEntities(
        agent_id: string,
        context_type: string,
        version: number | null = null
    ): Promise<{ entities: string[]; keywords: string[]; message: string }> {
        this.checkApiInitialized();

        const modelName = "gemini-1.5-flash-latest"; // Or "gemini-2.0-flash"
        const contextResult = await this.contextManager.getContext(agent_id, context_type, version);

        if (!contextResult || (!contextResult.context_data && !contextResult.context_data_parsed)) {
            return { entities: [], keywords: [], message: `No context data found for agent_id: ${agent_id}, context_type: ${context_type}` };
        }
        
        const dataToUse = contextResult.context_data_parsed || contextResult.context_data;
        let textToExtractFrom = '';

        if (dataToUse && dataToUse.documentation_snippets && Array.isArray(dataToUse.documentation_snippets)) {
            textToExtractFrom = dataToUse.documentation_snippets.map((s: any) => `${s.TITLE || ''}: ${s.DESCRIPTION || ''} ${s.CODE || ''}`).join('\n\n');
        } else if (typeof dataToUse === 'object') {
            textToExtractFrom = JSON.stringify(dataToUse);
        } else if (typeof dataToUse === 'string') {
            textToExtractFrom = dataToUse;
        }

        if (textToExtractFrom.trim().length === 0) {
            return { entities: [], keywords: [], message: `No content to extract entities from for agent_id: ${agent_id}, context_type: ${context_type}` };
        }

        try {
            const prompt = `Extract key entities and keywords from the following text. Provide the output as a JSON object with two arrays: "entities" and "keywords".\n\nText:\n${textToExtractFrom}`;
            const contents: Content[] = [{ role: "user", parts: [{ text: prompt }] }];
            const result = await this.genAI!.models.generateContent({
                model: modelName,
                contents: contents
            });
            const textResponse = result.text ?? '';

            try {
                let jsonString = textResponse;
                const jsonMatch = textResponse.match(/```json\n([\s\S]*?)\n```/);
                if (jsonMatch && jsonMatch[1]) {
                    jsonString = jsonMatch[1];
                } else if (!(textResponse.startsWith("{") && textResponse.endsWith("}"))) {
                    const firstBrace = textResponse.indexOf('{');
                    const lastBrace = textResponse.lastIndexOf('}');
                    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                        jsonString = textResponse.substring(firstBrace, lastBrace + 1);
                    } else {
                        throw new Error("Response from Gemini was not in a recognizable JSON format.");
                    }
                }
                const parsedResponse = JSON.parse(jsonString);
                return {
                    entities: parsedResponse.entities || [],
                    keywords: parsedResponse.keywords || [],
                    message: `Successfully extracted entities and keywords using Gemini API.`
                };
            } catch (parseError: any) {
                console.error(`Error parsing Gemini API JSON response for entity extraction. Raw response: "${textResponse}". Parse error:`, parseError);
                throw new Error(`Failed to parse Gemini API response for entity extraction. Raw response: "${textResponse.substring(0,200)}...". Error: ${parseError.message}`);
            }
        } catch (error: any) {
            console.error(`Error calling Gemini API for entity extraction (context: ${context_type}, agent: ${agent_id}):`, error);
            throw new Error(`Failed to extract entities using Gemini API: ${error.message}`);
        }
    }

    async semanticSearchContext(
        agent_id: string,
        context_type: string,
        query_text: string,
        top_k: number = 5
    ): Promise<{ results: Array<{ score: number; snippet: any }>; message: string }> {
        this.checkApiInitialized();

        const embeddingModelName = "models/text-embedding-004"; 

        const contextResult = await this.contextManager.getContext(agent_id, context_type);
        const dataToSearch = contextResult?.context_data_parsed || contextResult?.context_data;

        if (!dataToSearch || !dataToSearch.documentation_snippets || !Array.isArray(dataToSearch.documentation_snippets) || dataToSearch.documentation_snippets.length === 0) {
            return { results: [], message: `No context or documentation snippets found for agent_id: ${agent_id}, context_type: ${context_type}` };
        }

        try {
            // Embed the query text
            const queryContents: Content[] = [{ role: "user", parts: [{ text: query_text }] }];
            const queryEmbeddingResponse = await this.genAI!.models.embedContent({ model: embeddingModelName, contents: queryContents });
            // Assuming response structure { embeddings: [{ values: number[] }] } based on user's old code for individual embeddings
            const queryEmbedding = queryEmbeddingResponse.embeddings?.[0]?.values;


            if (!queryEmbedding || queryEmbedding.length === 0) {
                 throw new Error("Failed to generate embedding for the query text.");
            }

            const snippetsWithEmbeddings: { snippet: any; embedding: number[] }[] = [];

            for (const snippet of dataToSearch.documentation_snippets) {
                const snippetText = `${snippet.TITLE || ''}: ${snippet.DESCRIPTION || ''} ${snippet.CODE || ''}`;
                if (!snippetText.trim()) continue;
                
                const snippetContents: Content[] = [{ role: "user", parts: [{ text: snippetText }] }];
                const snippetEmbeddingResponse = await this.genAI!.models.embedContent({ model: embeddingModelName, contents: snippetContents });
                const snippetEmbedding = snippetEmbeddingResponse.embeddings?.[0]?.values;

                if (snippetEmbedding && snippetEmbedding.length > 0) {
                    snippetsWithEmbeddings.push({
                        snippet: snippet,
                        embedding: snippetEmbedding
                    });
                }
            }
            
            if (snippetsWithEmbeddings.length === 0) {
                 return { results: [], message: "Failed to generate embeddings for any snippet." };
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
            console.error(`Error calling Gemini API for semantic search (context: ${context_type}, agent: ${agent_id}):`, error);
            throw new Error(`Failed to perform semantic search using Gemini API: ${error.message}`);
        }
    }

    private cosineSimilarity(vecA: number[], vecB: number[]): number {
        if (!vecA || !vecB || vecA.length !== vecB.length || vecA.length === 0) {
            console.warn("Cosine similarity: Invalid input vectors.", {vecALength: vecA?.length, vecBLength: vecB?.length});
            return 0; 
        }
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
        this.checkApiInitialized();

        const modelName = "gemini-1.5-flash-latest"; // Or "gemini-2.0-flash"
        
        const metaPrompt = `
You are an expert AI prompt engineer. Your task is to take a raw user prompt, analyze it, and transform it into a highly structured and actionable "Refined Prompt for AI". This refined prompt will be used by another AI agent to understand and execute the user's request.

You MUST output the refined prompt as a JSON object, strictly adhering to the following schema. Do not include any other text or markdown outside of the JSON block.

JSON Schema for Refined Prompt:
\`\`\`json
{
  "refined_prompt_id": "server_generated_uuid_for_this_refinement_instance",
  "original_prompt_text": "The exact raw user prompt text that was processed.",
  "refinement_engine_model": "${modelName}",
  "refinement_timestamp": "YYYY-MM-DDTHH:MM:SS.sssZ",
  "overall_goal": "A clear, concise statement of the user's primary objective, as interpreted from the prompt.",
  "decomposed_tasks": [ 
    "Sub-task 1 identified from the prompt.",
    "Sub-task 2 identified from the prompt."
  ],
  "key_entities_identified": [ 
    {"type": "filename", "value": "user_authentication.py"}, {"type": "concept", "value": "Argon2 Hashing"}
  ],
  "implicit_assumptions_made_by_refiner": [ 
    "Assuming 'the dashboard' refers to the main application dashboard.",
    "Assuming standard Python library availability unless specified otherwise."
  ],
  "explicit_constraints_from_prompt": [ 
    "The solution must be implemented in Python 3.9.",
    "The UI must remain consistent with the existing design language."
  ],
  "suggested_ai_role_for_agent": "Example: Act as a Senior Python Developer specializing in API security and database interactions.",
  "suggested_reasoning_strategy_for_agent": "Example: Prioritize security best practices. Analyze potential attack vectors. Ensure input validation. Plan for data migration if schema changes are needed.",
  "desired_output_characteristics_inferred": {
    "type": "Example: A fully functional Python module with accompanying unit tests.", 
    "key_content_elements": [ 
      "Refactored Python code for user_authentication.py.",
      "Detailed explanation of Argon2 parameter choices.",
      "Unit tests covering new hashing and verification logic."
    ],
    "level_of_detail": "Example: Sufficient for another developer to understand, integrate, and maintain the changes." 
  },
  "suggested_context_analysis_for_agent": [ 
    {
      "suggestion_type": "MEMORY_RETRIEVAL",
      "tool_to_use": "get_conversation_history",
      "parameters": {"limit": 5, "offset": 0},
      "rationale": "To understand immediate preceding dialogue for context."
    }
  ],
  "confidence_in_refinement_score": "High", 
  "refinement_error_message": null 
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
            const contents: Content[] = [{ role: "user", parts: [{ text: metaPrompt }] }];
            const result = await this.genAI!.models.generateContent({
                model: modelName,
                contents: contents
            });
            const textResponse = result.text ?? ''; // Assuming result.text exists
            let parsedResponse: any;

            try {
                let jsonString = textResponse;
                const jsonMatch = textResponse.match(/```json\n([\s\S]*?)\n```/);
                if (jsonMatch && jsonMatch[1]) {
                    jsonString = jsonMatch[1];
                } else if (textResponse.startsWith("{") && textResponse.endsWith("}")) {
                    jsonString = textResponse;
                } else {
                    throw new Error("Response from Gemini was not in the expected JSON format or markdown JSON block.");
                }
                parsedResponse = JSON.parse(jsonString);
            } catch (parseError: any) {
                console.error(`Error parsing Gemini API response for prompt refinement. Raw response: "${textResponse}". Parse error:`, parseError);
                throw new Error(`Failed to parse Gemini API response for prompt refinement. Raw response: "${textResponse.substring(0,200)}...". Error: ${parseError.message}`);
            }

            parsedResponse.refined_prompt_id = parsedResponse.refined_prompt_id && parsedResponse.refined_prompt_id !== "server_generated_uuid_for_this_refinement_instance" 
                ? parsedResponse.refined_prompt_id 
                : randomUUID();
            parsedResponse.original_prompt_text = raw_user_prompt; 
            parsedResponse.refinement_engine_model = modelName;
            parsedResponse.refinement_timestamp = new Date().toISOString();
            parsedResponse.agent_id = agent_id; 

            if (!parsedResponse.overall_goal) {
                console.warn("Refined prompt from Gemini is missing 'overall_goal'. Using raw prompt as fallback.");
                parsedResponse.overall_goal = raw_user_prompt; 
            }

            await this.storeRefinedPrompt(parsedResponse);
            return parsedResponse;

} catch (error: any) {
             console.error(`Error in processAndRefinePrompt (agent: ${agent_id}):`, error);
             if (error instanceof GeminiApiNotInitializedError) throw error;
            // Return fallback response structure if API call fails
            return {
                     refined_prompt_id: randomUUID(),
                     original_prompt_text: raw_user_prompt,
                     refinement_engine_model: modelName,
                     refinement_timestamp: new Date().toISOString(),
                     overall_goal: "Error: Gemini API call failed during prompt refinement.",
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
                'desired_output_characteristics_inferred', 'suggested_context_analysis_for_agent'
            ];
            for (const field of fieldsToParse) {
                const jsonField = result[field]; 
                if (jsonField && typeof jsonField === 'string') {
                    try {
                        result[`${field}_parsed`] = JSON.parse(jsonField);
                    } catch (e) {
                        console.error(`Failed to parse ${field} for refined_prompt_id ${refined_prompt_id}:`, e);
                        result[`${field}_parsed`] = null;
                        result[`${field}_parsing_error`] = true;
                        result[`raw_${field}`] = jsonField; 
                    }
                } else {
                     result[`${field}_parsed`] = jsonField === null ? null : jsonField; 
                }
            }
            if (result.refinement_timestamp) {
                result.refinement_timestamp_iso = new Date(result.refinement_timestamp).toISOString();
            }
        }
        return result;
    }

    async summarizeCorrectionLogs(agent_id: string, maxLogs: number = 10): Promise<string> {
        this.checkApiInitialized();
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

        const prompt = `Summarize the following correction logs into a concise list of past mistakes and strict instructions for the agent to follow to avoid repeating them. Focus on actionable advice.\n\nLogs:\n${textToSummarize}`;
        
        try {
            const contents: Content[] = [{ role: "user", parts: [{ text: prompt }] }];
            // Assuming result.text exists for this SDK pattern
            const result = await this.genAI!.models.generateContent({ 
                model: "gemini-1.5-flash-latest", // or "gemini-2.0-flash"
                contents: contents
            });
            return result.text ?? 'Could not generate summary.';
        } catch (error: any) {
            console.error(`Error calling Gemini API for correction log summarization (agent: ${agent_id}):`, error);
            // Revert to returning a string on error to match user's old code structure for this specific method's error handling
            if (! (error instanceof GeminiApiNotInitializedError)) {
                return `Failed to summarize correction logs using Gemini API: ${error.message}`;
            }
            throw error; // Re-throw GeminiApiNotInitializedError
        }
    }
}
