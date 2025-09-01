import { GeminiIntegrationService } from '../GeminiIntegrationService.js';
import { MistralEmbeddingService } from '../gemini-integration-modules/MistralEmbeddingService.js';
import { DEFAULT_EMBEDDING_MODEL } from '../../../constants/embedding_constants.js';
import { GENERATE_MEANINGFUL_ENTITY_NAME_PROMPT, BATCH_SUMMARIZE_CODE_CHUNKS_PROMPT } from '../gemini-integration-modules/GeminiPromptTemplates.js';
import { ApiKeyManager } from './ApiKeyManager.js';
import { RateLimiter } from './RateLimiter.js';
import { BatchProcessor } from './BatchProcessor.js';

export type EmbeddingProviderType = 'gemini' | 'mistral';

/**
 * AI Embedding Provider handles generating embeddings for text chunks using various AI providers.
 * Supports batch processing, rate limiting, API key rotation, and fallback providers.
 */
export class AIEmbeddingProvider {
    // Public services
    public geminiService: GeminiIntegrationService;

    // Private services and configuration
    private mistralService?: MistralEmbeddingService;
    private providerType: EmbeddingProviderType;
    private maxRetries: number;
    private baseDelay: number;
    private requestTimeout: number;

    // Injected services for better separation of concerns
    private apiKeyManager: ApiKeyManager;
    private rateLimiter: RateLimiter;
    private batchProcessor: BatchProcessor;

    /**
     * Creates an instance of AIEmbeddingProvider.
     * @param geminiService The Gemini integration service
     * @param providerType The embedding provider type ('gemini' or 'mistral')
     * @param maxRetries Maximum number of retry attempts for failed requests
     * @param baseDelay Base delay in milliseconds for exponential backoff
     * @param maxBatchSize Maximum number of texts per batch
     * @param maxTokensPerBatch Maximum tokens per batch
     * @param requestTimeout Request timeout in milliseconds
     */
    constructor(
        geminiService: GeminiIntegrationService,
        providerType: EmbeddingProviderType = 'gemini',
        maxRetries: number = 3,
        baseDelay: number = 1000,
        maxBatchSize: number = 100,
        maxTokensPerBatch: number = 20000,
        requestTimeout: number = 30000
    ) {
        this.geminiService = geminiService;
        this.providerType = providerType;
        this.maxRetries = maxRetries;
        this.baseDelay = baseDelay;
        this.requestTimeout = requestTimeout;

        // Initialize supporting services
        this.apiKeyManager = new ApiKeyManager();
        this.rateLimiter = new RateLimiter();
        this.batchProcessor = new BatchProcessor(maxBatchSize, maxTokensPerBatch);

        // Initialize Mistral service if needed
        if (providerType === 'mistral') {
            try {
                this.mistralService = new MistralEmbeddingService();
            } catch (error) {
                console.warn('Failed to initialize Mistral embedding service:', error);
                console.warn('Falling back to Gemini provider');
                this.providerType = 'gemini';
            }
        }
    }



    public setProvider(providerType: EmbeddingProviderType, modelName?: string): void {
        this.providerType = providerType;
        if (providerType === 'mistral') {
            try {
                this.mistralService = new MistralEmbeddingService(modelName);
            } catch (error) {
                console.warn('Failed to initialize Mistral embedding service during setProvider:', error);
                console.warn('Falling back to Gemini provider');
                this.providerType = 'gemini';
            }
        }
    }


    private _rotateApiKey(): void {
        this.apiKeyManager.rotateKey();
    }

    private _getCurrentApiKey(): string {
        return this.apiKeyManager.getCurrentKey();
    }

    private async _checkRateLimit(identifier: string): Promise<void> {
        await this.rateLimiter.checkRateLimit(identifier);
    }

    public async generateMeaningfulEntityName(codeChunk: string, language: string | undefined): Promise<string> {
        try {
            const results = await this.batchGenerateMeaningfulEntityNames([{ codeChunk, language }]);
            return results[0] || 'anonymous_chunk';
        } catch (error) {
            console.error('Error generating entity name:', error);
            return 'anonymous_chunk';
        }
    }

    public async batchGenerateMeaningfulEntityNames(
        chunks: Array<{ codeChunk: string; language: string | undefined }>
    ): Promise<string[]> {
        if (chunks.length === 0) return [];

        const prompts = chunks.map(chunk =>
            GENERATE_MEANINGFUL_ENTITY_NAME_PROMPT
                .replace(/{language}/g, chunk.language || 'unknown')
                .replace('{codeChunk}', chunk.codeChunk)
        );

        try {
            const nameResults = await this._executeWithRetry(() =>
                this.geminiService.batchAskGemini(prompts, this.geminiService.summarizationModelName)
            );

            return nameResults.map(result => {
                let extractedName = result.content[0]?.text ?? '';
                extractedName = extractedName.replace(/[^a-zA-Z0-9\s_]/g, '').trim();
                extractedName = extractedName.replace(/\s+/g, '_');
                extractedName = extractedName.replace(/^_+|_+$/g, '');
                return extractedName.length > 0 ? extractedName : 'anonymous_chunk';
            });
        } catch (error) {
            console.warn('Failed to generate meaningful entity names:', error);
            return new Array(chunks.length).fill('anonymous_chunk');
        }
    }

    public async getEmbeddingsForChunks(texts: string[], modelName: string = DEFAULT_EMBEDDING_MODEL): Promise<{
        embeddings: Array<{ vector: number[], dimensions: number } | null>;
        requestCount: number;
        retryCount: number;
        totalTokensProcessed: number;
        failedRequests: number;
    }> {
        if (texts.length === 0) {
            return { embeddings: [], requestCount: 0, retryCount: 0, totalTokensProcessed: 0, failedRequests: 0 };
        }

        if (!this.apiKeyManager.hasKeys()) {
            throw new Error('No API keys available for embedding generation');
        }

        const batches = this.batchProcessor.createOptimizedBatches(texts);
        const finalResults: Array<{ vector: number[], dimensions: number } | null> = new Array(texts.length).fill(null);
        let totalRequests = 0;
        let totalRetries = 0;
        let totalTokensProcessed = 0;
        let failedRequests = 0;

        for (const batch of batches) {
            try {
                const batchResult = await this._processBatchWithRetry(batch, modelName);
                totalRequests += batchResult.requestCount;
                totalRetries += batchResult.retryCount;
                totalTokensProcessed += batchResult.totalTokensProcessed;
                failedRequests += batchResult.failedRequests;

                // Map results back to original positions
                batchResult.results.forEach((result, idx) => {
                    const originalIdx = batch.originalIndices[idx];
                    finalResults[originalIdx] = result;
                });
            } catch (error) {
                console.error('Failed to process batch after retries:', error);
                // Mark all items in this batch as failed
                batch.originalIndices.forEach(idx => {
                    finalResults[idx] = null;
                });
                failedRequests += batch.originalIndices.length;
            }
        }

        return {
            embeddings: finalResults,
            requestCount: totalRequests,
            retryCount: totalRetries,
            totalTokensProcessed,
            failedRequests
        };
    }

    private async _processBatchWithRetry(
        batch: { texts: string[], originalIndices: number[] },
        modelName: string
    ): Promise<{
        results: Array<{ vector: number[], dimensions: number } | null>;
        requestCount: number;
        retryCount: number;
        totalTokensProcessed: number;
        failedRequests: number;
    }> {
        let attempt = 0;
        let lastError: any = null;
        let failedRequests = 0;

        while (attempt < this.maxRetries) {
            try {
                await this._checkRateLimit('embedding_generation');

                const result = await this._executeWithTimeout(() =>
                    this._callEmbeddingApi(batch.texts, modelName),
                    this.requestTimeout
                );

                return {
                    results: result.embeddings,
                    requestCount: 1,
                    retryCount: attempt,
                    totalTokensProcessed: result.totalTokensProcessed,
                    failedRequests: 0
                };
            } catch (error: any) {
                lastError = error;
                attempt++;
                failedRequests = batch.texts.length;

                if (attempt < this.maxRetries) {
                    const isRateLimitError = this._isRateLimitError(error);
                    if (isRateLimitError) {
                        this._rotateApiKey();
                    }

                    const delay = this.baseDelay * Math.pow(2, attempt - 1) + Math.random() * 1000;
                    console.warn(`Retry ${attempt}/${this.maxRetries} after error: ${error.message}. Waiting ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        console.error(`Max retries reached for batch. Last error: ${lastError?.message}`);
        return {
            results: new Array(batch.texts.length).fill(null),
            requestCount: attempt,
            retryCount: attempt - 1,
            totalTokensProcessed: 0,
            failedRequests
        };
    }

    private async _executeWithTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
        return Promise.race([
            operation(),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs)
            )
        ]);
    }

    private async _callEmbeddingApi(texts: string[], modelName: string): Promise<{
        embeddings: Array<{ vector: number[], dimensions: number } | null>;
        totalTokensProcessed: number;
    }> {
        if (this.providerType === 'mistral' && this.mistralService) {
            try {
                const result = await this.mistralService.getEmbeddings(texts);
                return result;
            } catch (error) {
                console.error('Mistral embedding failed:', error);
                throw error;
            }
        }

        const genAIInstance = this.geminiService.getGenAIInstance();
        if (!genAIInstance) {
            throw new Error('Gemini API not initialized');
        }

        const contents = texts.map(text => ({ role: "user", parts: [{ text }] }));
        const result = await genAIInstance.models.embedContent({
            model: modelName,
            contents
        });

        const embeddings = result.embeddings?.map(embedding => {
            if (!embedding.values) return null;
            return {
                vector: embedding.values,
                dimensions: embedding.values.length
            };
        }) || [];

        // Estimate tokens processed (rough approximation)
        const totalTokens = texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);

        return { embeddings, totalTokensProcessed: totalTokens };
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



    public async summarizeCodeChunk(codeChunk: string, entityType: string, language: string): Promise<string> {
        try {
            const results = await this.batchSummarizeCodeChunks([{ codeChunk, entityType, language }]);
            return results[0] || 'Could not generate summary.';
        } catch (error) {
            console.error('Error summarizing code chunk:', error);
            return 'Could not generate summary.';
        }
    }

    public async batchSummarizeCodeChunks(
        chunks: Array<{ codeChunk: string; entityType: string; language: string }>
    ): Promise<string[]> {
        if (chunks.length === 0) return [];

        const prompts = chunks.map(chunk =>
            BATCH_SUMMARIZE_CODE_CHUNKS_PROMPT
                .replace(/{language}/g, chunk.language)
                .replace('{entityType}', chunk.entityType)
                .replace('{codeChunk}', chunk.codeChunk)
        );

        try {
            const summaryResults = await this._executeWithRetry(() =>
                this.geminiService.batchAskGemini(prompts, this.geminiService.summarizationModelName)
            );

            return summaryResults.map(result => {
                let summary = result.content[0].text ?? 'Could not generate summary.';
                summary = summary.replace(/[\r\n]+/g, ' ').replace(/`/g, '').trim();
                summary = summary.replace(/\s+/g, ' ');
                return summary;
            });
        } catch (error) {
            console.warn('Failed to generate code chunk summaries:', error);
            return new Array(chunks.length).fill('Could not generate summary.');
        }
    }

    private async _executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
        return operation();
    }
}
