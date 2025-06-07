// src/database/services/GeminiIntegrationService.ts
import { GoogleGenAI, HarmCategory, HarmBlockThreshold, GenerationConfig, Content, Part } from "@google/genai";
import { randomUUID } from 'crypto';
import { DatabaseService } from '../services/DatabaseService.js';
import { ContextInformationManager } from '../managers/ContextInformationManager.js';
import { MemoryManager } from "../memory_manager.js";
import { CodebaseContextRetrieverService, RetrievedCodeContext, ContextRetrievalOptions } from "./CodebaseContextRetrieverService.js";

// Custom error for when Gemini API is not initialized
export class GeminiApiNotInitializedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "GeminiApiNotInitializedError";
    }
}

export class GeminiIntegrationService {
    private genAI?: GoogleGenAI;
    private dbService: DatabaseService;
    private contextManager: ContextInformationManager;
    private memoryManager: MemoryManager;
    private _codebaseContextRetrieverService?: CodebaseContextRetrieverService;

    // Model names based on user's provided code
    private readonly summarizationModelName = "gemini-2.5-flash-preview-05-20";
    private readonly entityExtractionModelName = "gemini-1.5-flash-latest";
    private readonly embeddingModelName = "models/text-embedding-004";
    private readonly defaultAskModelName = "gemini-2.5-flash-preview-05-20";
    private readonly refinementModelName = "gemini-2.5-flash-preview-05-20";


    private safetySettings = [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    ];
    private generationConfig: GenerationConfig = { 
        temperature: 0.7,
        topK: 1,
        topP: 1,
        maxOutputTokens: 8192,
    };


    constructor(
        dbService: DatabaseService,
        contextManager: ContextInformationManager,
        memoryManager: MemoryManager, 
        genAIInstance?: GoogleGenAI
    ) {
        this.dbService = dbService;
        this.contextManager = contextManager;
        this.memoryManager = memoryManager; 

        if (genAIInstance) {
            this.genAI = genAIInstance;
        } else {
            const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
            if (!GEMINI_API_KEY) {
                this.genAI = undefined;
                console.warn('Gemini API key not found. GeminiIntegrationService will not be functional for direct API calls.');
            } else {
                this.genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY }); 
            }
        }
    }
    
    private get codebaseContextRetrieverService(): CodebaseContextRetrieverService {
        if (!this._codebaseContextRetrieverService) {
            this._codebaseContextRetrieverService = this.memoryManager.getCodebaseContextRetrieverService();
        }
        return this._codebaseContextRetrieverService;
    }

    async generateStructuredQueryFromNaturalLanguage(naturalLanguageQuery: string): Promise<any> {
        // Use NLPQueryProcessor internally to generate structured query
        const nlpProcessor = new (await import('../ai/NLPQueryProcessor.js')).NLPQueryProcessor();
        return nlpProcessor.generateStructuredQuery(naturalLanguageQuery);
    }

    private checkApiInitialized() {
        if (!this.genAI) {
            throw new GeminiApiNotInitializedError("Gemini API not initialized. Ensure GEMINI_API_KEY is set.");
        }
    }
    
    public getGenAIInstance(): GoogleGenAI | undefined {
        return this.genAI;
    }

    async askGemini(query: string, modelName?: string, systemInstruction?: string): Promise<{ content: Part[] }> {
        this.checkApiInitialized();
        const modelToUse = modelName || this.defaultAskModelName;
        try {
            const request: any = { // Use 'any' to dynamically add systemInstruction
                model: modelToUse,
                contents: [{ role: "user", parts: [{ text: query }] }],
                safetySettings: this.safetySettings, 
                generationConfig: this.generationConfig, 
            };
            
            if (systemInstruction) {
                // The correct way to add a system instruction
                request.systemInstruction = {
                    role: "system",
                    parts: [{ text: systemInstruction }]
                };
            }

            const result = await this.genAI!.models.generateContent(request);
            // The response structure is different when using system instructions
            // The type GenerateContentResponse does not have 'content' property, so cast to any
            const responseText = (result as any).content?.[0]?.text ?? 'No response from Gemini.';
            return { content: [{ text: responseText }] };

        } catch (error: any) {
            console.error(`Error calling Gemini API (${modelToUse}) for query:`, error);
            throw new Error(`Failed to get response from Gemini (${modelToUse}): ${error.message}`);
        }
    }
    
    /**
     * MODIFICATION: New method to summarize a raw code chunk.
     * @param codeChunk The string of code to summarize.
     * @param entityType The type of the entity (e.g., 'function', 'class').
     * @param language The programming language.
     * @returns A promise resolving to a plain-English summary.
     */
    async summarizeCodeChunk(codeChunk: string, entityType: string, language: string): Promise<string> {
        this.checkApiInitialized();
        const modelToUse = this.summarizationModelName;
        const prompt = `
You are an expert code analyst. Your task is to provide a concise, one-sentence summary in plain English explaining the purpose of the following code snippet.
Do not describe the code line-by-line. Focus on the high-level goal and functionality.

Language: ${language}
Entity Type: ${entityType}
Code Snippet:
\`\`\`${language}
${codeChunk}
\`\`\`

One-sentence summary:
`;
        try {
            const result = await this.askGemini(prompt, modelToUse);
            // Clean up the response to ensure it's a single, clean sentence.
            let summary = result.content[0].text ?? 'Could not generate summary.';
            summary = summary.replace(/[\r\n]+/g, ' ').replace(/`/g, '').trim();
            return summary;
        } catch (error: any) {
            console.error(`Error calling Gemini API for code chunk summarization:`, error);
            // Return a default message on error to avoid breaking the embedding process
            return `Failed to generate summary: ${error.message}`;
        }
    }

    async summarizeContext(
        agent_id: string,
        context_type: string,
        version: number | null = null
    ): Promise<string> {
        this.checkApiInitialized();
        const modelToUse = this.summarizationModelName; 
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
            const result = await this.askGemini(prompt, modelToUse);
            return result.content[0].text ?? 'Could not generate summary.';
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
        const modelToUse = this.entityExtractionModelName; 
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
            const result = await this.askGemini(prompt, modelToUse);
            const textResponse = result.content[0].text ?? '';

            try {
                let jsonString = textResponse;
                const jsonMatch = textResponse.match(/```json\n([\s\S]*?)\n```/);
                if (jsonMatch && jsonMatch[1]) {
                    jsonString = jsonMatch[1];
                } else if (!(jsonString.startsWith("{") && jsonString.endsWith("}"))) { 
                    const firstBrace = jsonString.indexOf('{');
                    const lastBrace = jsonString.lastIndexOf('}');
                    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                        jsonString = jsonString.substring(firstBrace, lastBrace + 1);
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
    
    private async getEmbedding(text: string): Promise<number[]> {
        this.checkApiInitialized();
        // This is a simplified call; the actual API might require a different structure
        const response = await this.genAI!.models.embedContent({ model: this.embeddingModelName, contents: [{ role: "user", parts: [{ text }] }] });
        const embeddingValues = response.embeddings?.[0]?.values;
        if (!embeddingValues) {
            console.warn(`Failed to get embedding values for text: ${text.substring(0,50)}...`);
            return [];
        }
        return embeddingValues;
    }

    async semanticSearchContext(
        agent_id: string,
        context_type: string,
        query_text: string,
        top_k: number = 5
    ): Promise<{ results: Array<{ score: number; snippet: any }>; message: string }> {
        this.checkApiInitialized();
        const contextResult = await this.contextManager.getContext(agent_id, context_type);
        const dataToSearch = contextResult?.context_data_parsed || contextResult?.context_data;

        if (!dataToSearch || !dataToSearch.documentation_snippets || !Array.isArray(dataToSearch.documentation_snippets) || dataToSearch.documentation_snippets.length === 0) {
            return { results: [], message: `No context or documentation snippets found for agent_id: ${agent_id}, context_type: ${context_type}` };
        }

        try {
            const queryEmbedding = await this.getEmbedding(query_text);
            if (!queryEmbedding || queryEmbedding.length === 0) {
                 throw new Error("Failed to generate embedding for the query text.");
            }

            const snippetsWithEmbeddings: { snippet: any; embedding: number[] }[] = [];
            for (const snippet of dataToSearch.documentation_snippets) {
                const snippetText = `${snippet.TITLE || ''}: ${snippet.DESCRIPTION || ''} ${snippet.CODE || ''}`;
                if (!snippetText.trim()) continue;
                
                const snippetEmbedding = await this.getEmbedding(snippetText);
                if (snippetEmbedding && snippetEmbedding.length > 0) {
                    snippetsWithEmbeddings.push({ snippet, embedding: snippetEmbedding });
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

    private formatRetrievedContextForPrompt(contexts: RetrievedCodeContext[]): string {
        if (!contexts || contexts.length === 0) {
            return "No specific codebase context was retrieved for this prompt.";
        }
        let formatted = "Relevant Codebase Context:\n";
        contexts.forEach((ctx, index) => {
            formatted += `\n--- Context Item ${index + 1} ---\n`;
            formatted += `Type: ${ctx.type}\n`;
            formatted += `Source Path: ${ctx.sourcePath}\n`;
            if (ctx.entityName) {
                formatted += `Entity Name: ${ctx.entityName}\n`;
            }
            if (ctx.relevanceScore) {
                formatted += `Relevance Score: ${ctx.relevanceScore.toFixed(4)}\n`;
            }
            if (ctx.metadata) {
                if (ctx.metadata.startLine && ctx.metadata.endLine) {
                    formatted += `Lines: ${ctx.metadata.startLine}-${ctx.metadata.endLine}\n`;
                }
                if (ctx.metadata.language) {
                    formatted += `Language: ${ctx.metadata.language}\n`;
                }
                if (ctx.metadata.kgNodeType) {
                    formatted += `KG Node Type: ${ctx.metadata.kgNodeType}\n`;
                }
            }
            formatted += `Content:\n\`\`\`${ctx.metadata?.language || 'text'}\n${ctx.content}\n\`\`\`\n`;
        });
        return formatted;
    }

    async processAndRefinePrompt(
        agent_id: string,
        raw_user_prompt: string,
        target_ai_persona: string | null = null,
        conversation_context_ids: string[] | null = null,
        context_options?: ContextRetrievalOptions
    ): Promise<any> {
        this.checkApiInitialized();
        const modelToUse = this.refinementModelName;

        let retrievedCodeContextString = "No codebase context was actively retrieved for this refinement iteration.";
        try {
            const retrievalOptions: ContextRetrievalOptions = context_options || {
                topKEmbeddings: 5, 
                topKKgResults: 5,    
                embeddingScoreThreshold: 0.6 
            };
            console.log('[DEBUG] processAndRefinePrompt retrievalOptions:', retrievalOptions);
            const codeContexts = await this.codebaseContextRetrieverService.retrieveContextForPrompt(
                agent_id,
                raw_user_prompt,
                retrievalOptions
            );
            retrievedCodeContextString = this.formatRetrievedContextForPrompt(codeContexts);
        } catch (contextError: any) {
            console.error(`Error retrieving codebase context for prompt refinement (agent: ${agent_id}):`, contextError);
            retrievedCodeContextString = `Error retrieving codebase context: ${contextError.message}`;
        }
        
        const metaPrompt = `
You are an expert AI prompt engineer and senior software architect. Your task is to take a raw user prompt, perform a deep and mandatory analysis of the provided codebase context, and transform the prompt into a highly structured, detailed, and actionable "Refined Prompt for AI". This refined prompt will be used by another AI agent to execute the user's request with precision.

**CRITICAL INSTRUCTION: Your primary function is to analyze the "Retrieved Codebase Context". Do not ignore it. Your entire output must be based on how the user's request interacts with this existing code.**

**Analysis Steps:**
1.  **Interpret Goal:** Define the user's \`overall_goal\` by interpreting their prompt in light of the provided code context.
2.  **Analyze Context:** In the \`codebase_context_summary_by_ai\` field, summarize how the existing code influences the plan. Is this a new feature, a modification, or a refactor? Which files are most relevant?
3.  **Identify Key Entities:** In the \`relevant_code_elements_analyzed\` field, list the specific functions, classes, and files from the context that will be directly impacted or are crucial for implementation.
4.  **Decompose Tasks:** Break down the goal into a sequence of actionable development tasks. Each task in \`decomposed_tasks\` must be concrete and grounded in the codebase (e.g., "Modify the 'processPayment' function in 'payment_service.ts' to handle gift cards.").
5.  **Suggest Dependencies:** For each decomposed task, list any prerequisite tasks in the \`suggested_dependencies\` field. This is crucial for creating a valid execution plan.
6.  **Suggest Validation:** Propose a \`suggested_validation_steps\` for the agent to perform after completing the plan, such as running specific tests or querying the knowledge graph to confirm changes.

**Output Schema:**
You MUST output the refined prompt strictly as a JSON object, adhering exactly to the following schema. Do not include any text or markdown outside the JSON block.

\`\`\`json
{
  "refined_prompt_id": "server_generated_uuid",
  "original_prompt_text": "The exact raw user prompt text.",
  "refinement_engine_model": "${modelToUse}",
  "refinement_timestamp": "YYYY-MM-DDTHH:MM:SS.sssZ",
  "overall_goal": "A clear, concise statement of the user's primary objective, informed by the codebase context.",
  "decomposed_tasks": [
    {
      "task_description": "A specific, actionable development task.",
      "suggested_dependencies": ["Description of a prerequisite task from this list."]
    }
  ],
  "key_entities_identified": [ 
    {"type": "filename | function | class", "value": "path/to/file.ts | functionName | ClassName", "relevance_to_prompt": "Identified as highly relevant from codebase context."}
  ],
  "codebase_context_summary_by_ai": "Your mandatory, brief analysis of how the retrieved codebase context influences the interpretation and plan.",
  "relevant_code_elements_analyzed": [
    {
      "element_path": "src/services/payment_service.ts",
      "element_type": "function",
      "entity_name": "processPayment",
      "relevance_notes": "This function currently handles credit card payments and will need to be modified to include the new payment logic."
    }
  ],
  "suggested_validation_steps": [
      "Run all unit tests in 'tests/payment_service.test.ts'.",
      "Query the knowledge graph to ensure the new 'GiftCardService' node is correctly linked to the 'PaymentService'."
  ],
  "confidence_in_refinement_score": "High | Medium | Low",
  "refinement_error_message": "Null if successful, or an error message if refinement failed."
}
\`\`\`

---
Raw User Prompt:
\`\`\`
${raw_user_prompt}
\`\`\`

---
Retrieved Codebase Context (MANDATORY ANALYSIS):
\`\`\`text
${retrievedCodeContextString}
\`\`\`
---

Now, provide the JSON object only.
`;
        try {
            const result = await this.askGemini(metaPrompt, modelToUse);
            const textResponse = result.content[0].text ?? '';

            try {
                let jsonString = textResponse;
                const jsonMatch = textResponse.match(/```json\n([\s\S]*?)\n```/);
                if (jsonMatch && jsonMatch[1]) {
                    jsonString = jsonMatch[1];
                } else if (!(jsonString.startsWith("{") && jsonString.endsWith("}"))) {
                    const firstBrace = jsonString.indexOf('{');
                    const lastBrace = jsonString.lastIndexOf('}');
                    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                        jsonString = jsonString.substring(firstBrace, lastBrace + 1);
                    } else {
                        throw new Error("Response from Gemini was not in a recognizable JSON format.");
                    }
                }
                const refinedPrompt = JSON.parse(jsonString);
                
                // Add server-side generated fields
                refinedPrompt.refined_prompt_id = randomUUID();
                refinedPrompt.refinement_timestamp = new Date().toISOString();
                refinedPrompt.original_prompt_text = raw_user_prompt;
                refinedPrompt.agent_id = agent_id;


                return refinedPrompt;

            } catch (parseError: any) {
                console.error(`Error parsing Gemini API JSON response for prompt refinement. Raw response: "${textResponse}". Parse error:`, parseError);
                throw new Error(`Failed to parse Gemini API response for prompt refinement. Raw response: "${textResponse.substring(0,200)}...". Error: ${parseError.message}`);
            }
        } catch (error: any) {
            console.error(`Error calling Gemini API for prompt refinement (agent: ${agent_id}):`, error);
            throw new Error(`Failed to refine prompt using Gemini API: ${error.message}`);
        }
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
                confidence_in_refinement_score, refinement_error_message
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
                'desired_output_characteristics_inferred', 'suggested_context_analysis_for_agent',
                'relevant_code_elements_analyzed' // Ensure this new field is parsed if stored as JSON string
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
            // codebase_context_summary_by_ai is likely a direct string field, no parsing needed unless it's stored as JSON.
            // For now, assuming it's a direct text field in the DB or part of the main JSON.
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

        const prompt = `You are an expert AI assistant specialized in analyzing correction logs to identify patterns of mistakes and provide clear, actionable instructions to prevent recurrence. Carefully review the following correction logs and produce a concise, prioritized list of past mistakes along with strict guidelines the agent must follow to avoid repeating these errors. Emphasize clarity, specificity, and practical advice.\n\nCorrection Logs:\n${textToSummarize}`;
        
        try {
            const result = await this.askGemini(prompt, this.summarizationModelName);
            return result.content[0].text ?? 'Could not generate summary.';
        } catch (error: any) {
            console.error(`Error calling Gemini API for correction log summarization (agent: ${agent_id}):`, error);
            if (! (error instanceof GeminiApiNotInitializedError)) {
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
        this.checkApiInitialized();
        const modelToUse = modelName || this.summarizationModelName;

        const prompt = `
Summarize the following conversation involving agent_id "${agent_id}".
Focus on:
- Key topics discussed
- Main actions taken
- Important decisions made
- Next steps identified
- Any unresolved issues
        
Conversation Messages:
${conversationMessages}

Provide a concise yet comprehensive summary structured as:
1. Overview
2. Key Points
3. Action Items
4. Open Questions`;

        try {
            const result = await this.askGemini(prompt, modelToUse);
            return result.content[0].text ?? 'Conversation summary could not be generated.';
        } catch (error: any) {
            console.error(`Error summarizing conversation for agent ${agent_id}:`, error);
            throw new Error(`Failed to summarize conversation: ${error.message}`);
        }
    }
}
