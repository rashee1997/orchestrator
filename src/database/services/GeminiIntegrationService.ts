import { DatabaseService } from '../services/DatabaseService.js';
import { ContextInformationManager } from '../managers/ContextInformationManager.js';
import { MemoryManager } from "../memory_manager.js";
import { CodebaseContextRetrieverService, RetrievedCodeContext, ContextRetrievalOptions } from "./CodebaseContextRetrieverService.js";
// Import refactored modules
import { GeminiApiClient, GeminiApiNotInitializedError } from './gemini-integration-modules/GeminiApiClient.js';
import { SUMMARIZE_CODE_CHUNK_PROMPT, SUMMARIZE_CONTEXT_PROMPT, EXTRACT_ENTITIES_PROMPT, META_PROMPT, SUMMARIZE_CONVERSATION_PROMPT } from './gemini-integration-modules/GeminiPromptTemplates.js';
import { parseGeminiJsonResponse } from './gemini-integration-modules/GeminiResponseParsers.js';
import { formatRetrievedContextForPrompt } from './gemini-integration-modules/GeminiContextFormatter.js';
import { cosineSimilarity } from './gemini-integration-modules/GeminiUtilityFunctions.js';
import { GeminiDbUtils } from './gemini-integration-modules/GeminiDbUtils.js';
import { SUMMARIZATION_MODEL_NAME, ENTITY_EXTRACTION_MODEL_NAME, EMBEDDING_MODEL_NAME, DEFAULT_ASK_MODEL_NAME, REFINEMENT_MODEL_NAME } from './gemini-integration-modules/GeminiConfig.js';
import { GoogleGenAI, Part } from "@google/genai";
export { GeminiApiNotInitializedError } from './gemini-integration-modules/GeminiApiClient.js';
export class GeminiIntegrationService {
    private dbService: DatabaseService;
    private contextManager: ContextInformationManager;
    private memoryManager: MemoryManager;
    private _codebaseContextRetrieverService?: CodebaseContextRetrieverService;
    private geminiApiClient: GeminiApiClient;
    private geminiDbUtils: GeminiDbUtils;
    // Model names are now imported from GeminiConfig.ts, but re-exposed via getters for backward compatibility
    public get summarizationModelName(): string { return SUMMARIZATION_MODEL_NAME; }
    public get entityExtractionModelName(): string { return ENTITY_EXTRACTION_MODEL_NAME; }
    public get embeddingModelName(): string { return EMBEDDING_MODEL_NAME; }
    public get defaultAskModelName(): string { return DEFAULT_ASK_MODEL_NAME; }
    public get refinementModelName(): string { return REFINEMENT_MODEL_NAME; }
    constructor(
        dbService: DatabaseService,
        contextManager: ContextInformationManager,
        memoryManager: MemoryManager,
        genAIInstance?: GoogleGenAI
    ) {
        this.dbService = dbService;
        this.contextManager = contextManager;
        this.memoryManager = memoryManager;
        this.geminiApiClient = new GeminiApiClient(genAIInstance);
        this.geminiDbUtils = new GeminiDbUtils(this.dbService, this.geminiApiClient, this.summarizationModelName);
    }
    private get codebaseContextRetrieverService(): CodebaseContextRetrieverService {
        if (!this._codebaseContextRetrieverService) {
            this._codebaseContextRetrieverService = this.memoryManager.getCodebaseContextRetrieverService();
        }
        return this._codebaseContextRetrieverService;
    }
    // Generate a structured query from natural language input
    async generateStructuredQueryFromNaturalLanguage(naturalLanguageQuery: string): Promise<any> {
        // Use NLPQueryProcessor internally to generate structured query
        const nlpProcessor = new (await import('../ai/NLPQueryProcessor.js')).NLPQueryProcessor();
        return nlpProcessor.generateStructuredQuery(naturalLanguageQuery);
    }
    public getGenAIInstance(): GoogleGenAI | undefined {
        return this.geminiApiClient.getGenAIInstance();
    }
    // Ask a single question to Gemini
    async askGemini(query: string, modelName?: string, systemInstruction?: string, contextResults?: RetrievedCodeContext[], thinkingConfig?: { thinkingBudget?: number; thinkingMode?: 'AUTO' | 'MODE_THINK' }): Promise<{ content: Part[], confidenceScore?: number }> {
        const contextContentParts = formatRetrievedContextForPrompt(contextResults || []);
        const results = await this.geminiApiClient.batchAskGemini([query], modelName || this.defaultAskModelName, systemInstruction, contextContentParts, thinkingConfig);
        if (results.length > 0) {
            return results[0];
        }
        throw new Error("Failed to get response from Gemini.");
    }
    // Ask multiple questions to Gemini in batch
    public async batchAskGemini(queries: string[], modelName?: string, systemInstruction?: string, contextResults?: RetrievedCodeContext[], thinkingConfig?: { thinkingBudget?: number; thinkingMode?: 'AUTO' | 'MODE_THINK' }): Promise<Array<{ content: Part[], confidenceScore?: number }>> {
        const contextContentParts = formatRetrievedContextForPrompt(contextResults || []);
        const results = await this.geminiApiClient.batchAskGemini(queries, modelName || this.defaultAskModelName, systemInstruction, contextContentParts, thinkingConfig);
        return results.map(result => {
            let confidenceScore: number | undefined;
            if (contextResults && contextResults.length > 0) {
                const totalScore = contextResults.reduce((sum, ctx) => sum + (ctx.relevanceScore || 0), 0);
                confidenceScore = totalScore / contextResults.length;
            }
            return { ...result, confidenceScore };
        });
    }
    // Helper method to extract text from context data
    private extractTextFromContextData(dataToUse: any): string {
        const MAX_CONTEXT_STRING_LENGTH = 1000; // Define a reasonable maximum length

        if (dataToUse === null || dataToUse === undefined) {
            return '';
        }

        let resultString: string;

        if (dataToUse && dataToUse.documentation_snippets && Array.isArray(dataToUse.documentation_snippets)) {
            resultString = dataToUse.documentation_snippets.map((s: any) =>
                `${s.TITLE || ''}: ${s.DESCRIPTION || ''} ${s.CODE || ''}`
            ).join('\n\n');
        } else if (typeof dataToUse === 'object') {
            const cache = new Set(); // For circular reference detection
            resultString = JSON.stringify(dataToUse, (key, value) => {
                if (typeof value === 'object' && value !== null) {
                    if (cache.has(value)) {
                        // Circular reference found, discard key
                        return '[Circular]';
                    }
                    // Store value in our collection
                    cache.add(value);
                }
                return value;
            });
        } else if (typeof dataToUse === 'string') {
            resultString = dataToUse;
        } else {
            resultString = String(dataToUse); // Handle numbers, booleans, etc.
        }

        // Limit the length of the output string
        if (resultString.length > MAX_CONTEXT_STRING_LENGTH) {
            return resultString.substring(0, MAX_CONTEXT_STRING_LENGTH) + '... (truncated)';
        }

        return resultString;
    }
    // Summarize a code chunk
    async summarizeCodeChunk(codeChunk: string, entityType: string, language: string): Promise<string> {
        const modelToUse = this.summarizationModelName;
        const prompt = SUMMARIZE_CODE_CHUNK_PROMPT
            .replace('{language}', language)
            .replace('{entityType}', entityType)
            .replace('{codeChunk}', codeChunk);
        try {
            const result = await this.askGemini(prompt, modelToUse);
            let summary = result.content[0].text ?? 'Could not generate summary.';
            summary = summary.replace(/[\r\n]+/g, ' ').replace(/`/g, '').trim();
            return summary;
        } catch (error: any) {
            console.error(`Error calling Gemini API for code chunk summarization:`, error);
            throw error;
        }
    }
    // Summarize context for a specific agent and context type
    async summarizeContext(
        agent_id: string,
        context_type: string,
        version: number | null = null
    ): Promise<string> {
        const modelToUse = this.summarizationModelName;
        const contextResult = await this.contextManager.getContext(agent_id, context_type, version);
        if (!contextResult || (!contextResult.context_data && !contextResult.context_data_parsed)) {
            return `No context data found for agent_id: ${agent_id}, context_type: ${context_type}, version: ${version}`;
        }
        const dataToUse = contextResult.context_data_parsed || contextResult.context_data;
        const textToSummarize = this.extractTextFromContextData(dataToUse);
        if (textToSummarize.trim().length === 0) {
            return `No content to summarize for agent_id: ${agent_id}, context_type: ${context_type}`;
        }
        try {
            const prompt = SUMMARIZE_CONTEXT_PROMPT.replace('{textToSummarize}', textToSummarize);
            const result = await this.askGemini(prompt, modelToUse);
            return result.content[0].text ?? 'Could not generate summary.';
        } catch (error: any) {
            console.error(`Error calling Gemini API for summarization (context: ${context_type}, agent: ${agent_id}):`, error);
            throw new Error(`Failed to summarize context using Gemini API: ${error.message}`);
        }
    }
    // Extract entities and keywords from context
    async extractEntities(
        agent_id: string,
        context_type: string,
        version: number | null = null
    ): Promise<{ entities: string[]; keywords: string[]; message: string }> {
        const modelToUse = this.entityExtractionModelName;
        const contextResult = await this.contextManager.getContext(agent_id, context_type, version);
        if (!contextResult || (!contextResult.context_data && !contextResult.context_data_parsed)) {
            return { entities: [], keywords: [], message: `No context data found for agent_id: ${agent_id}, context_type: ${context_type}` };
        }
        const dataToUse = contextResult.context_data_parsed || contextResult.context_data;
        const textToExtractFrom = this.extractTextFromContextData(dataToUse);
        if (textToExtractFrom.trim().length === 0) {
            return { entities: [], keywords: [], message: `No content to extract entities from for agent_id: ${agent_id}, context_type: ${context_type}` };
        }
        try {
            const prompt = EXTRACT_ENTITIES_PROMPT.replace('{textToExtractFrom}', textToExtractFrom);
            const result = await this.askGemini(prompt, modelToUse);
            const textResponse = result.content[0].text ?? '';
            const parsedResponse = parseGeminiJsonResponse(textResponse);
            return {
                entities: parsedResponse.entities || [],
                keywords: parsedResponse.keywords || [],
                message: `Successfully extracted entities and keywords using Gemini API.`
            };
        } catch (error: any) {
            console.error(`Error calling Gemini API for entity extraction (context: ${context_type}, agent: ${agent_id}):`, error);
            throw new Error(`Failed to extract entities using Gemini API: ${error.message}`);
        }
    }
    // Get embedding for a text using Gemini API
    private async getEmbedding(text: string): Promise<number[]> {
        const genAIInstance = this.geminiApiClient.getGenAIInstance();
        if (!genAIInstance) {
            throw new GeminiApiNotInitializedError("Gemini API not initialized for embedding. Ensure GEMINI_API_KEY is set.");
        }
        const response = await genAIInstance.models.embedContent({ model: this.embeddingModelName, contents: [{ role: "user", parts: [{ text }] }] });
        const embeddingValues = response.embeddings?.[0]?.values;
        if (!embeddingValues) {
            console.warn(`Failed to get embedding values for text: ${text.substring(0, 50)}...`);
            return [];
        }
        return embeddingValues;
    }
    // Perform semantic search on context
    async semanticSearchContext(
        agent_id: string,
        context_type: string,
        query_text: string,
        top_k: number = 5
    ): Promise<{ results: Array<{ score: number; snippet: any }>; message: string }> {
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
                const similarity = cosineSimilarity(queryEmbedding, item.embedding);
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
    // Store a refined prompt in the database
    async storeRefinedPrompt(refinedPrompt: any): Promise<string> {
        return this.geminiDbUtils.storeRefinedPrompt(refinedPrompt);
    }
    // Retrieve a refined prompt from the database
    async getRefinedPrompt(agent_id: string, refined_prompt_id: string): Promise<any | null> {
        return this.geminiDbUtils.getRefinedPrompt(agent_id, refined_prompt_id);
    }
    // Summarize correction logs for an agent
    async summarizeCorrectionLogs(agent_id: string, maxLogs: number = 10): Promise<string> {
        return this.geminiDbUtils.summarizeCorrectionLogs(agent_id, maxLogs);
    }
    // Summarize a conversation
    async summarizeConversation(
        agent_id: string,
        conversationMessages: string,
        modelName?: string
    ): Promise<string> {
        return this.geminiDbUtils.summarizeConversation(agent_id, conversationMessages, modelName);
    }
}