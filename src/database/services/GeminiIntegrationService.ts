import { DatabaseService } from './DatabaseService.js';
import { ContextInformationManager } from '../managers/ContextInformationManager.js';
import { MemoryManager } from "../memory_manager.js";
import { CodebaseContextRetrieverService, RetrievedCodeContext, ContextRetrievalOptions } from "./CodebaseContextRetrieverService.js";
import { GeminiApiClient, GeminiApiNotInitializedError } from './gemini-integration-modules/GeminiApiClient.js';
import {
    SUMMARIZE_CODE_CHUNK_PROMPT,
    SUMMARIZE_CONTEXT_PROMPT,
    EXTRACT_ENTITIES_PROMPT,
    META_PROMPT,
    SUMMARIZE_CONVERSATION_PROMPT,
    GENERATE_CONVERSATION_TITLE_PROMPT
} from './gemini-integration-modules/GeminiPromptTemplates.js';
import { parseGeminiJsonResponse, parseGeminiJsonResponseSync } from './gemini-integration-modules/GeminiResponseParsers.js';
import { formatRetrievedContextForPrompt } from './gemini-integration-modules/GeminiContextFormatter.js';
import { cosineSimilarity } from './gemini-integration-modules/GeminiUtilityFunctions.js';
import { GeminiDbUtils } from './gemini-integration-modules/GeminiDbUtils.js';
import { SUMMARIZATION_MODEL_NAME, ENTITY_EXTRACTION_MODEL_NAME, EMBEDDING_MODEL_NAME, DEFAULT_ASK_MODEL_NAME, REFINEMENT_MODEL_NAME, resolveModelName, getCurrentModelAsync } from './gemini-integration-modules/GeminiConfig.js';
import { GoogleGenAI, Part } from "@google/genai";
import { AIIntegrationService } from './ai-integration/AIIntegrationService.js';

export { GeminiApiNotInitializedError } from './gemini-integration-modules/GeminiApiClient.js';

/**
 * Unified Gemini Integration Service - Wrapper around AIIntegrationService
 * Provides backward compatibility while leveraging the unified AI orchestration
 */
export class GeminiIntegrationService {
    private dbService: DatabaseService;
    private contextManager: ContextInformationManager;
    private memoryManager: MemoryManager;
    private _codebaseContextRetrieverService?: CodebaseContextRetrieverService;
    private geminiApiClient: GeminiApiClient;
    private geminiDbUtils: GeminiDbUtils;
    private requestCache: Map<string, { data: any, timestamp: number }>;
    private cacheTTL: number;
    private maxCacheSize: number;
    private rateLimiter: Map<string, { count: number; resetTime: number }>;
    private maxRequestsPerMinute: number;

    // Unified AI Integration Service as the primary orchestrator
    private unifiedAIService: AIIntegrationService;

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
        this.requestCache = new Map();
        this.cacheTTL = 5 * 60 * 1000; // 5 minutes
        this.maxCacheSize = 1000;
        this.rateLimiter = new Map();
        this.maxRequestsPerMinute = 60;

        // Initialize unified AI Integration Service as the primary orchestrator
        this.unifiedAIService = new AIIntegrationService(memoryManager, {
            defaultProvider: 'gemini',
            defaultModel: DEFAULT_ASK_MODEL_NAME,
            enableOrchestrator: true
        });

        this.initializeUnifiedService();
    }

    private async initializeUnifiedService(): Promise<void> {
        try {
            await this.unifiedAIService.initialize();
            console.log('[GeminiIntegrationService] Unified AI Integration Service initialized successfully');
        } catch (error) {
            console.warn('[GeminiIntegrationService] Failed to initialize unified AI service:', error);
        }
    }

    private get codebaseContextRetrieverService(): CodebaseContextRetrieverService {
        if (!this._codebaseContextRetrieverService) {
            this._codebaseContextRetrieverService = this.memoryManager.getCodebaseContextRetrieverService();
        }
        return this._codebaseContextRetrieverService;
    }

    public get summarizationModelName(): string { return SUMMARIZATION_MODEL_NAME; }
    public get entityExtractionModelName(): string { return ENTITY_EXTRACTION_MODEL_NAME; }
    public get embeddingModelName(): string { return EMBEDDING_MODEL_NAME; }
    public get defaultAskModelName(): string { return DEFAULT_ASK_MODEL_NAME; }
    public get refinementModelName(): string { return REFINEMENT_MODEL_NAME; }

    private _generateCacheKey(service: string, ...args: any[]): string {
        return `${service}:${JSON.stringify(args)}`;
    }

    private _isCacheValid(timestamp: number): boolean {
        return (Date.now() - timestamp) < this.cacheTTL;
    }

    private _cleanupCache(): void {
        if (this.requestCache.size > this.maxCacheSize) {
            const entries = Array.from(this.requestCache.entries());
            entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

            const toRemove = entries.slice(0, Math.floor(this.maxCacheSize * 0.3));
            toRemove.forEach(([key]) => this.requestCache.delete(key));

            console.log(`[GeminiIntegrationService] Cleaned up ${toRemove.length} expired cache entries`);
        }
    }

    private async _checkRateLimit(identifier: string): Promise<void> {
        const now = Date.now();
        const limit = this.rateLimiter.get(identifier);

        if (!limit || now > limit.resetTime) {
            this.rateLimiter.set(identifier, { count: 1, resetTime: now + 60 * 1000 });
            return;
        }

        if (limit.count >= this.maxRequestsPerMinute) {
            const waitTime = limit.resetTime - now;
            throw new Error(`Rate limit exceeded for ${identifier}. Please wait ${Math.ceil(waitTime / 1000)} seconds.`);
        }

        limit.count++;
    }

    private async _executeWithRetry<T>(
        operation: () => Promise<T>,
        operationName: string,
        maxRetries: number = 3,
        baseDelay: number = 1000
    ): Promise<T> {
        let lastError: any = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error: any) {
                lastError = error;

                if (attempt < maxRetries) {
                    const isRateLimitError = this._isRateLimitError(error);
                    const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 1000;

                    console.warn(`${operationName} failed (attempt ${attempt}/${maxRetries}): ${error.message}. Retrying in ${delay}ms...`);

                    if (isRateLimitError) {
                        await new Promise(resolve => setTimeout(resolve, Math.max(delay, 5000)));
                    } else {
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                }
            }
        }

        console.error(`${operationName} failed after ${maxRetries} attempts:`, lastError?.message);
        throw lastError || new Error(`${operationName} failed after maximum retries`);
    }

    private _isRateLimitError(error: any): boolean {
        return error?.message?.includes('429') ||
            error?.message?.includes('Too Many Requests') ||
            error?.message?.includes('quota') ||
            error?.message?.includes('rate limit') ||
            (error?.cause && error.cause.message && (
                error.cause.message.includes('429') ||
                error.cause.message.includes('Too Many Requests') ||
                error.cause.message.includes('quota') ||
                error.cause.message.includes('rate limit')
            ));
    }

    private _isApiOverloadError(error: any): boolean {
        return error?.message?.includes('503') ||
            error?.message?.includes('The model is overloaded') ||
            error?.message?.includes('UNAVAILABLE') ||
            error?.status === 503 ||
            (error?.cause && error.cause.message && (
                error.cause.message.includes('503') ||
                error.cause.message.includes('The model is overloaded') ||
                error.cause.message.includes('UNAVAILABLE')
            ));
    }

    public async generateStructuredQueryFromNaturalLanguage(naturalLanguageQuery: string): Promise<any> {
        const cacheKey = this._generateCacheKey('structuredQuery', naturalLanguageQuery);
        const cached = this.requestCache.get(cacheKey);

        if (cached && this._isCacheValid(cached.timestamp)) {
            return cached.data;
        }

        try {
            const nlpProcessor = new (await import('../ai/NLPQueryProcessor.js')).NLPQueryProcessor();
            const result = nlpProcessor.generateStructuredQuery(naturalLanguageQuery);

            this.requestCache.set(cacheKey, { data: result, timestamp: Date.now() });
            this._cleanupCache();

            return result;
        } catch (error) {
            console.error('Error generating structured query:', error);
            throw error;
        }
    }

    public getGenAIInstance(): GoogleGenAI | undefined {
        return this.geminiApiClient.getGenAIInstance();
    }

    /**
     * Unified askGemini method - delegates to AIIntegrationService
     */
    public async askGemini(
        query: string,
        modelName?: string,
        systemInstruction?: string,
        thinkingConfig?: { thinkingBudget?: number; thinkingMode?: 'AUTO' | 'MODE_THINK' },
        toolConfig?: { tools?: any[] }
    ): Promise<{ content: Part[], confidenceScore?: number, groundingMetadata?: any }> {
        const cacheKey = this._generateCacheKey('askGemini', query, modelName, systemInstruction);
        const cached = this.requestCache.get(cacheKey);

        if (cached && this._isCacheValid(cached.timestamp)) {
            return cached.data;
        }

        await this._checkRateLimit('askGemini');

        try {
            // Delegate to unified AI service
            const aiResponse = await this.unifiedAIService.askAI(query, modelName, systemInstruction);

            // Convert AIResponse to Gemini format
            const result = {
                content: aiResponse.content as Part[],
                confidenceScore: undefined,
                groundingMetadata: aiResponse.metadata?.groundingMetadata
            };

            this.requestCache.set(cacheKey, { data: result, timestamp: Date.now() });
            this._cleanupCache();

            return result;
        } catch (error) {
            console.error("Error in unified askGemini:", error);

            // Fallback to direct Gemini API if unified service fails
            console.warn('[GeminiIntegrationService] Unified service failed, falling back to direct Gemini API...');

            try {
                const actualModelName = resolveModelName(modelName || this.defaultAskModelName);
                const results = await this.geminiApiClient.batchAskGemini([query], actualModelName, systemInstruction, undefined, thinkingConfig, toolConfig);

                if (results.length > 0) {
                    const result = results[0];
                    const finalResult = { ...result, confidenceScore: undefined, groundingMetadata: result.groundingMetadata };

                    this.requestCache.set(cacheKey, { data: finalResult, timestamp: Date.now() });
                    this._cleanupCache();

                    return finalResult;
                }

                throw new Error("Failed to get response from Gemini fallback.");
            } catch (fallbackError) {
                console.error('[GeminiIntegrationService] Fallback to direct Gemini API also failed:', fallbackError);
                throw error; // Throw the original error
            }
        }
    }

    /**
     * Unified batchAskGemini method - delegates to AIIntegrationService
     */
    public async batchAskGemini(
        queries: string[],
        modelName?: string,
        systemInstruction?: string,
        thinkingConfig?: { thinkingBudget?: number; thinkingMode?: 'AUTO' | 'MODE_THINK' },
        toolConfig?: { tools?: any[] }
    ): Promise<Array<{ content: Part[], confidenceScore?: number, groundingMetadata?: any }>> {
        const cacheKey = this._generateCacheKey('batchAskGemini', queries, modelName, systemInstruction);
        const cached = this.requestCache.get(cacheKey);

        if (cached && this._isCacheValid(cached.timestamp)) {
            return cached.data;
        }

        await this._checkRateLimit('batchAskGemini');

        try {
            // Process queries through unified service
            const results = await Promise.all(
                queries.map(query => this.unifiedAIService.askAI(query, modelName, systemInstruction))
            );

            // Convert to Gemini format
            const finalResults = results.map(result => ({
                content: result.content as Part[],
                confidenceScore: undefined,
                groundingMetadata: result.metadata?.groundingMetadata
            }));

            this.requestCache.set(cacheKey, { data: finalResults, timestamp: Date.now() });
            this._cleanupCache();

            return finalResults;
        } catch (error) {
            console.error("Error in unified batchAskGemini:", error);
            throw error;
        }
    }

    private extractTextFromContextData(dataToUse: any): string {
        const MAX_CONTEXT_STRING_LENGTH = 1000;
        if (dataToUse === null || dataToUse === undefined) {
            return '';
        }

        let resultString: string;
        if (dataToUse && dataToUse.documentation_snippets && Array.isArray(dataToUse.documentation_snippets)) {
            resultString = dataToUse.documentation_snippets.map((s: any) =>
                `${s.TITLE || ''}: ${s.DESCRIPTION || ''} ${s.CODE || ''}`
            ).join('\n\n');
        } else if (typeof dataToUse === 'object') {
            const cache = new Set();
            resultString = JSON.stringify(dataToUse, (key, value) => {
                if (typeof value === 'object' && value !== null) {
                    if (cache.has(value)) {
                        return '[Circular]';
                    }
                    cache.add(value);
                }
                return value;
            });
        } else if (typeof dataToUse === 'string') {
            resultString = dataToUse;
        } else {
            resultString = String(dataToUse);
        }

        if (resultString.length > MAX_CONTEXT_STRING_LENGTH) {
            return resultString.substring(0, MAX_CONTEXT_STRING_LENGTH) + '... (truncated)';
        }
        return resultString;
    }

    /**
     * Unified summarizeCodeChunk - delegates to AIIntegrationService
     */
    public async summarizeCodeChunk(codeChunk: string, entityType: string, language: string): Promise<string> {
        const cacheKey = this._generateCacheKey('summarizeCodeChunk', codeChunk, entityType, language);
        const cached = this.requestCache.get(cacheKey);

        if (cached && this._isCacheValid(cached.timestamp)) {
            return cached.data;
        }

        try {
            const prompt = SUMMARIZE_CODE_CHUNK_PROMPT
                .replace('{language}', language)
                .replace('{entityType}', entityType)
                .replace('{codeChunk}', codeChunk);

            // Use unified service for summarization task
            const result = await this.unifiedAIService.executeTask(
                'code_explanation', // Map to appropriate task type
                prompt,
                undefined,
                { maxRetries: 2 }
            );

            let summary = result.content;
            summary = summary.replace(/[\r\n]+/g, ' ').replace(/`/g, '').trim();

            this.requestCache.set(cacheKey, { data: summary, timestamp: Date.now() });
            this._cleanupCache();

            return summary;
        } catch (error: any) {
            console.error(`Error in unified summarizeCodeChunk:`, error);
            throw error;
        }
    }

    /**
     * Unified summarizeContext - delegates to AIIntegrationService
     */
    public async summarizeContext(
        agent_id: string,
        context_type: string,
        version: number | null = null
    ): Promise<string> {
        const cacheKey = this._generateCacheKey('summarizeContext', agent_id, context_type, version);
        const cached = this.requestCache.get(cacheKey);

        if (cached && this._isCacheValid(cached.timestamp)) {
            return cached.data;
        }

        try {
            const contextResult = await this.contextManager.getContext(agent_id, context_type, version);

            if (!contextResult || (!contextResult.context_data && !contextResult.context_data_parsed)) {
                return `No context data found for agent_id: ${agent_id}, context_type: ${context_type}, version: ${version}`;
            }

            const dataToUse = contextResult.context_data_parsed || contextResult.context_data;
            const textToSummarize = this.extractTextFromContextData(dataToUse);

            if (textToSummarize.trim().length === 0) {
                return `No content to summarize for agent_id: ${agent_id}, context_type: ${context_type}`;
            }

            const prompt = SUMMARIZE_CONTEXT_PROMPT.replace('{textToSummarize}', textToSummarize);

            // Use unified service for summarization
            const result = await this.unifiedAIService.executeTask(
                'text_summarization',
                prompt,
                undefined,
                { maxRetries: 2 }
            );

            const summary = result.content;

            this.requestCache.set(cacheKey, { data: summary, timestamp: Date.now() });
            this._cleanupCache();

            return summary;
        } catch (error: any) {
            console.error(`Error in unified summarizeContext (context: ${context_type}, agent: ${agent_id}):`, error);
            throw new Error(`Failed to summarize context using unified AI service: ${error.message}`);
        }
    }

    /**
     * Unified extractEntities - delegates to AIIntegrationService
     */
    public async extractEntities(
        agent_id: string,
        context_type: string,
        version: number | null = null
    ): Promise<{ entities: string[]; keywords: string[]; message: string }> {
        const cacheKey = this._generateCacheKey('extractEntities', agent_id, context_type, version);
        const cached = this.requestCache.get(cacheKey);

        if (cached && this._isCacheValid(cached.timestamp)) {
            return cached.data;
        }

        try {
            const contextResult = await this.contextManager.getContext(agent_id, context_type, version);

            if (!contextResult || (!contextResult.context_data && !contextResult.context_data_parsed)) {
                return { entities: [], keywords: [], message: `No context data found for agent_id: ${agent_id}, context_type: ${context_type}` };
            }

            const dataToUse = contextResult.context_data_parsed || contextResult.context_data;
            const textToExtractFrom = this.extractTextFromContextData(dataToUse);

            if (textToExtractFrom.trim().length === 0) {
                return { entities: [], keywords: [], message: `No content to extract entities from for agent_id: ${agent_id}, context_type: ${context_type}` };
            }

            const prompt = EXTRACT_ENTITIES_PROMPT.replace('{textToExtractFrom}', textToExtractFrom);

            // Use unified service for entity extraction
            const result = await this.unifiedAIService.executeTask(
                'entity_extraction',
                prompt,
                undefined,
                { maxRetries: 2 }
            );

            const textResponse = result.content;
            const parsedResponse = parseGeminiJsonResponseSync(textResponse);

            const finalResult = {
                entities: parsedResponse.entities || [],
                keywords: parsedResponse.keywords || [],
                message: `Successfully extracted entities and keywords using unified AI service.`
            };

            this.requestCache.set(cacheKey, { data: finalResult, timestamp: Date.now() });
            this._cleanupCache();

            return finalResult;
        } catch (error: any) {
            console.error(`Error in unified extractEntities (context: ${context_type}, agent: ${agent_id}):`, error);
            throw new Error(`Failed to extract entities using unified AI service: ${error.message}`);
        }
    }



    public async storeRefinedPrompt(refinedPrompt: any): Promise<string> {
        try {
            return await this._executeWithRetry(
                () => this.geminiDbUtils.storeRefinedPrompt(refinedPrompt),
                'storeRefinedPrompt'
            );
        } catch (error) {
            console.error('Error storing refined prompt:', error);
            throw error;
        }
    }

    /**
     * Unified generateConversationTitle - delegates to AIIntegrationService
     */
    public async generateConversationTitle(initialQuery: string): Promise<string> {
        const cacheKey = this._generateCacheKey('generateConversationTitle', initialQuery);
        const cached = this.requestCache.get(cacheKey);

        if (cached && this._isCacheValid(cached.timestamp)) {
            return cached.data;
        }

        try {
            const prompt = GENERATE_CONVERSATION_TITLE_PROMPT.replace('{initial_query}', initialQuery);

            // Use unified service for title generation
            const result = await this.unifiedAIService.executeTask(
                'content_creation',
                prompt,
                undefined,
                { maxRetries: 2 }
            );

            let title = result.content;
            // Clean up any extraneous characters like quotes or newlines from the AI response
            title = title.replace(/^["'\s]+|["'\s]+$/g, '').trim();

            this.requestCache.set(cacheKey, { data: title, timestamp: Date.now() });
            this._cleanupCache();

            return title;
        } catch (error: any) {
            console.error(`Error in unified generateConversationTitle for query "${initialQuery}":`, error);
            // Fallback to a generic title if AI generation fails
            return initialQuery.substring(0, 50) + (initialQuery.length > 50 ? "..." : "");
        }
    }

    public async getRefinedPrompt(agent_id: string, refined_prompt_id: string): Promise<any | null> {
        try {
            return await this._executeWithRetry(
                () => this.geminiDbUtils.getRefinedPrompt(agent_id, refined_prompt_id),
                'getRefinedPrompt'
            );
        } catch (error) {
            console.error('Error getting refined prompt:', error);
            throw error;
        }
    }

    public async summarizeCorrectionLogs(agent_id: string, maxLogs: number = 10): Promise<string> {
        try {
            return await this._executeWithRetry(
                () => this.geminiDbUtils.summarizeCorrectionLogs(agent_id, maxLogs),
                'summarizeCorrectionLogs'
            );
        } catch (error) {
            console.error('Error summarizing correction logs:', error);
            throw error;
        }
    }

    /**
     * Unified summarizeConversation - delegates to AIIntegrationService
     */
    public async summarizeConversation(
        agent_id: string,
        conversationMessages: string,
        modelName?: string
    ): Promise<string> {
        try {
            const prompt = SUMMARIZE_CONVERSATION_PROMPT.replace('{conversation_messages}', conversationMessages);

            // Use unified service for conversation summarization
            const result = await this.unifiedAIService.executeTask(
                'text_summarization',
                prompt,
                undefined,
                { maxRetries: 2 }
            );

            return result.content;
        } catch (error) {
            console.error('Error in unified summarizeConversation:', error);
            throw error;
        }
    }

    /**
     * Get access to the unified AI service for advanced usage
     */
    public getUnifiedAIService(): AIIntegrationService {
        return this.unifiedAIService;
    }

    /**
     * Check if unified service is ready
     */
    public isUnifiedServiceReady(): boolean {
        return this.unifiedAIService.isReady();
    }
}
