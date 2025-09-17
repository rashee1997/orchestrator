import { GeminiIntegrationService } from '../GeminiIntegrationService.js';
import { MistralEmbeddingService, MistralEmbeddingResult } from '../gemini-integration-modules/MistralEmbeddingService.js';
import { GEMINI_MODEL_CONFIG, EmbeddingModelConfig } from '../gemini-integration-modules/GeminiConfig.js';
import { IntelligentEmbeddingRouter } from './IntelligentEmbeddingRouter.js';

export interface EmbeddingRequest {
    texts: string[];
    requestId: string;
}

export interface EmbeddingResult {
    embeddings: Array<{
        vector: number[],
        dimensions: number,
        model: string,
        provider: 'gemini' | 'mistral'
    } | null>;
    totalTokensProcessed: number;
    model: string;
    provider: 'gemini' | 'mistral';
    actualDimensions: number;
    success: boolean;
    error?: string;
    requestId: string;
}

export interface ParallelEmbeddingResult {
    embeddings: Array<{
        vector: number[],
        dimensions: number,
        model: string,
        provider: 'gemini' | 'mistral'
    } | null>;
    totalTokensProcessed: number;
    successfulRequests: number;
    failedRequests: number;
    modelDistribution: Record<string, number>;
    primaryModel: string;
    fallbackUsed: boolean;
    requestId: string;
}

/**
 * Manages parallel embedding generation using multiple models with load balancing,
 * fallback mechanisms, and model tracking for database consistency.
 */
export class ParallelEmbeddingManager {
    private geminiService: GeminiIntegrationService;
    private mistralServices: Map<string, MistralEmbeddingService> = new Map();
    private config = GEMINI_MODEL_CONFIG.parallelEmbedding;
    private roundRobinIndex = 0;
    private modelStats: Record<string, { requests: number; successes: number; failures: number }> = {};
    private intelligentRouter: IntelligentEmbeddingRouter;

    constructor(geminiService: GeminiIntegrationService) {
        this.geminiService = geminiService;
        this.intelligentRouter = new IntelligentEmbeddingRouter();
        this.initializeServices();
        this.initializeStats();

        console.log(`[ParallelEmbeddingManager] Initialized with ${this.config.models.length} models`);
        console.log(`[ParallelEmbeddingManager] Load balancing: ${this.config.loadBalancing}`);
        console.log(`[ParallelEmbeddingManager] Target dimension: ${this.config.targetDimension}`);
        console.log(`[ParallelEmbeddingManager] Shared embedding process enabled for both Codestral (3072D) and Gemini (3072D)`);
        console.log(`[ParallelEmbeddingManager] Intelligent content-aware routing enabled`);
    }

    private initializeServices(): void {
        for (const modelConfig of this.config.models) {
            if (modelConfig.enabled && modelConfig.provider === 'mistral') {
                try {
                    const service = new MistralEmbeddingService(
                        modelConfig.model,
                        this.config.targetDimension // Use unified dimension
                    );
                    this.mistralServices.set(modelConfig.model, service);
                    console.log(`[ParallelEmbeddingManager] Initialized Mistral service: ${modelConfig.model}`);
                } catch (error: any) {
                    console.error(`[ParallelEmbeddingManager] Failed to initialize Mistral service ${modelConfig.model}:`, error.message);
                }
            }
        }
    }

    private initializeStats(): void {
        for (const modelConfig of this.config.models) {
            if (modelConfig.enabled) {
                this.modelStats[modelConfig.model] = {
                    requests: 0,
                    successes: 0,
                    failures: 0
                };
            }
        }
    }

    /**
     * Generate embeddings using parallel/load-balanced approach
     */
    async generateEmbeddings(texts: string[], requestId: string = this.generateRequestId()): Promise<ParallelEmbeddingResult> {
        if (texts.length === 0) {
            return this.createEmptyResult(requestId);
        }

        if (!this.config.enabled) {
            console.log('[ParallelEmbeddingManager] Parallel embedding disabled, using primary Gemini only');
            return this.generateWithSingleModel(texts, this.config.models[0], requestId);
        }

        const enabledModels = this.config.models.filter(m => m.enabled);
        if (enabledModels.length === 0) {
            throw new Error('No enabled embedding models available');
        }

        console.log(`[ParallelEmbeddingManager] Generating embeddings for ${texts.length} texts using ${this.config.loadBalancing} strategy`);

        switch (this.config.loadBalancing) {
            case 'concurrent':
                return this.generateConcurrent(texts, enabledModels, requestId);
            case 'round_robin':
                return this.generateRoundRobin(texts, enabledModels, requestId);
            case 'failover':
                return this.generateWithFailover(texts, enabledModels, requestId);
            case 'intelligent':
                return this.generateIntelligent(texts, enabledModels, requestId);
            default:
                throw new Error(`Unknown load balancing strategy: ${this.config.loadBalancing}`);
        }
    }

    /**
     * Intelligent strategy: Content-aware routing based on chunk type and characteristics
     */
    private async generateIntelligent(texts: string[], models: EmbeddingModelConfig[], requestId: string): Promise<ParallelEmbeddingResult> {
        console.log(`[ParallelEmbeddingManager] Using intelligent strategy - analyzing ${texts.length} chunks for optimal routing`);

        if (texts.length === 0) {
            return this.createEmptyResult(requestId);
        }

        // Find Gemini and Codestral models
        const geminiModel = models.find(m => m.provider === 'gemini');
        const codestralModel = models.find(m => m.provider === 'mistral');

        if (!geminiModel && !codestralModel) {
            throw new Error('Intelligent routing requires both Gemini and Codestral models');
        }

        // Prepare chunks for intelligent analysis (currently limited info available)
        const chunksForAnalysis = texts.map((text, index) => ({
            text,
            embeddingType: 'chunk' as const, // TODO: Could be enhanced with actual metadata
            entityName: null,
            language: undefined,
            index
        }));

        // Use intelligent router to distribute chunks
        const distribution = this.intelligentRouter.distributeChunksIntelligently(chunksForAnalysis);

        console.log(`[ParallelEmbeddingManager] Intelligent distribution:`);
        console.log(`   • Gemini: ${distribution.geminiChunks.length} chunks`);
        console.log(`   • Codestral: ${distribution.codestralChunks.length} chunks`);
        console.log(`   • Content breakdown:`, distribution.distributionStats.contentTypeBreakdown);

        // Process both batches in parallel
        const batchPromises: Array<Promise<{ provider: 'gemini' | 'mistral'; result: ParallelEmbeddingResult | null; chunks: any[] }>> = [];

        // Process Gemini chunks
        if (geminiModel && distribution.geminiChunks.length > 0) {
            const geminiTexts = distribution.geminiChunks.map(c => c.text);
            const promise = this.generateWithSingleModel(geminiTexts, geminiModel, `${requestId}_gemini`)
                .then(result => ({ provider: 'gemini' as const, result, chunks: distribution.geminiChunks }))
                .catch(error => {
                    console.error(`[ParallelEmbeddingManager] Gemini batch failed:`, error);
                    return { provider: 'gemini' as const, result: null, chunks: distribution.geminiChunks };
                });
            batchPromises.push(promise);
        }

        // Process Codestral chunks
        if (codestralModel && distribution.codestralChunks.length > 0) {
            const codestralTexts = distribution.codestralChunks.map(c => c.text);
            const promise = this.generateWithSingleModel(codestralTexts, codestralModel, `${requestId}_codestral`)
                .then(result => ({ provider: 'mistral' as const, result, chunks: distribution.codestralChunks }))
                .catch(error => {
                    console.error(`[ParallelEmbeddingManager] Codestral batch failed:`, error);
                    return { provider: 'mistral' as const, result: null, chunks: distribution.codestralChunks };
                });
            batchPromises.push(promise);
        }

        try {
            const batchResults = await Promise.allSettled(batchPromises);

            // Reconstruct results in original order
            const finalEmbeddings: Array<ParallelEmbeddingResult['embeddings'][0]> = new Array(texts.length).fill(null);
            let totalTokensProcessed = 0;
            let successfulRequests = 0;
            let failedRequests = 0;
            const modelDistribution: Record<string, number> = {};

            for (let i = 0; i < batchResults.length; i++) {
                const batchResult = batchResults[i];

                if (batchResult.status === 'fulfilled') {
                    const { provider, result, chunks } = batchResult.value;

                    if (result && result.successfulRequests > 0) {
                        // Map embeddings back to original positions
                        result.embeddings.forEach((embedding, embeddingIndex) => {
                            const chunkInfo = chunks[embeddingIndex];
                            if (chunkInfo) {
                                const originalIndex = chunkInfo.index;
                                finalEmbeddings[originalIndex] = embedding;

                                if (embedding) {
                                    successfulRequests++;
                                    const modelName = provider === 'gemini' ? geminiModel?.model || 'gemini' : codestralModel?.model || 'codestral';
                                    modelDistribution[modelName] = (modelDistribution[modelName] || 0) + 1;
                                } else {
                                    failedRequests++;
                                }
                            }
                        });

                        totalTokensProcessed += result.totalTokensProcessed;
                        console.log(`[ParallelEmbeddingManager] ${provider} processed ${result.successfulRequests} chunks successfully`);
                    } else {
                        // Mark all chunks for this provider as failed
                        chunks.forEach(() => failedRequests++);
                        console.error(`[ParallelEmbeddingManager] ${provider} failed to process any chunks`);
                    }
                } else {
                    console.error(`[ParallelEmbeddingManager] Batch promise failed:`, batchResult.reason);
                    failedRequests += texts.length;
                }
            }

            // Determine primary model (one that processed the most chunks)
            let primaryModel = 'none';
            let maxChunks = 0;
            for (const [model, count] of Object.entries(modelDistribution)) {
                if (count > maxChunks) {
                    maxChunks = count;
                    primaryModel = model;
                }
            }

            console.log(`[ParallelEmbeddingManager] Intelligent processing complete:`);
            console.log(`   • Successful: ${successfulRequests}/${texts.length}`);
            console.log(`   • Failed: ${failedRequests}`);
            console.log(`   • Primary model: ${primaryModel}`);
            console.log(`   • Distribution:`, modelDistribution);

            return {
                embeddings: finalEmbeddings,
                totalTokensProcessed,
                successfulRequests,
                failedRequests,
                modelDistribution,
                primaryModel,
                fallbackUsed: false, // Intelligent routing doesn't use fallback concept
                requestId
            };

        } catch (error: any) {
            console.error('[ParallelEmbeddingManager] Intelligent processing failed:', error.message);
            return this.createFailedResult(texts.length, requestId, error.message);
        }
    }

    /**
     * Concurrent strategy: race all models, winner takes all.
     */
    private async generateConcurrent(texts: string[], models: EmbeddingModelConfig[], requestId: string): Promise<ParallelEmbeddingResult> {
        console.log(`[ParallelEmbeddingManager] Using concurrent strategy - racing ${models.length} models`);

        const promises = models.map(model => this.generateWithSingleModel(texts, model, `${requestId}_${model.model}`));

        try {
            const result = await Promise.any(promises);
            console.log(`[ParallelEmbeddingManager] Concurrent race won by ${result.primaryModel}`);
            return result;
        } catch (error: any) {
            console.error('[ParallelEmbeddingManager] All models failed in concurrent race:', error);
            throw new Error('All models failed to generate embeddings.');
        }
    }

    /**
     * Round-robin strategy: Distribute chunks evenly across models
     */
    private async generateRoundRobin(texts: string[], models: EmbeddingModelConfig[], requestId: string): Promise<ParallelEmbeddingResult> {
        console.log(`[ParallelEmbeddingManager] Using round-robin strategy - distributing ${texts.length} chunks across ${models.length} models`);

        if (texts.length === 0) {
            return this.createEmptyResult(requestId);
        }

        // Split chunks between available models using round-robin
        const modelBatches: Map<EmbeddingModelConfig, { texts: string[], indices: number[] }> = new Map();

        // Initialize batches for each model
        models.slice(0, this.config.maxConcurrentRequests).forEach(model => {
            modelBatches.set(model, { texts: [], indices: [] });
        });

        const modelArray = Array.from(modelBatches.keys());

        // Distribute chunks in round-robin fashion
        texts.forEach((text, index) => {
            const targetModel = modelArray[index % modelArray.length];
            const batch = modelBatches.get(targetModel)!;
            batch.texts.push(text);
            batch.indices.push(index);
        });

        console.log(`[ParallelEmbeddingManager] Chunk distribution:`);
        modelBatches.forEach((batch, model) => {
            console.log(`   • ${model.model}: ${batch.texts.length} chunks`);
        });

        // Process all batches in parallel
        const batchPromises = Array.from(modelBatches.entries()).map(async ([model, batch]) => {
            if (batch.texts.length === 0) {
                return { model, result: null, indices: [] };
            }

            try {
                const result = await this.generateWithSingleModel(batch.texts, model, `${requestId}_${model.model}`);
                return { model, result, indices: batch.indices };
            } catch (error) {
                console.error(`[ParallelEmbeddingManager] Model ${model.model} failed:`, error);
                return { model, result: null, indices: batch.indices };
            }
        });

        try {
            const batchResults = await Promise.allSettled(batchPromises);

            // Reconstruct the results in original order
            const finalEmbeddings: Array<ParallelEmbeddingResult['embeddings'][0]> = new Array(texts.length).fill(null);
            let totalTokensProcessed = 0;
            let successfulRequests = 0;
            let failedRequests = 0;
            const modelDistribution: Record<string, number> = {};

            for (let i = 0; i < batchResults.length; i++) {
                const batchResult = batchResults[i];

                if (batchResult.status === 'fulfilled') {
                    const { model, result, indices } = batchResult.value;

                    if (result && result.successfulRequests > 0) {
                        // Map embeddings back to original positions
                        result.embeddings.forEach((embedding, embeddingIndex) => {
                            const originalIndex = indices[embeddingIndex];
                            finalEmbeddings[originalIndex] = embedding;

                            if (embedding) {
                                successfulRequests++;
                                modelDistribution[model.model] = (modelDistribution[model.model] || 0) + 1;
                            } else {
                                failedRequests++;
                            }
                        });

                        totalTokensProcessed += result.totalTokensProcessed;
                        console.log(`[ParallelEmbeddingManager] ${model.model} processed ${result.successfulRequests} chunks successfully`);
                    } else {
                        // Mark all chunks for this model as failed
                        indices.forEach(index => {
                            finalEmbeddings[index] = null;
                            failedRequests++;
                        });
                        console.error(`[ParallelEmbeddingManager] ${model.model} failed to process any chunks`);
                    }
                } else {
                    console.error(`[ParallelEmbeddingManager] Batch promise failed:`, batchResult.reason);
                    failedRequests += modelArray.length > 0 ? Math.ceil(texts.length / modelArray.length) : texts.length;
                }
            }

            // Determine primary model (one that processed the most chunks)
            let primaryModel = 'none';
            let maxChunks = 0;
            for (const [model, count] of Object.entries(modelDistribution)) {
                if (count > maxChunks) {
                    maxChunks = count;
                    primaryModel = model;
                }
            }

            console.log(`[ParallelEmbeddingManager] Round-robin processing complete:`);
            console.log(`   • Successful: ${successfulRequests}/${texts.length}`);
            console.log(`   • Failed: ${failedRequests}`);
            console.log(`   • Primary model: ${primaryModel}`);
            console.log(`   • Distribution:`, modelDistribution);

            return {
                embeddings: finalEmbeddings,
                totalTokensProcessed,
                successfulRequests,
                failedRequests,
                modelDistribution,
                primaryModel,
                fallbackUsed: false, // All models used concurrently
                requestId
            };

        } catch (error: any) {
            console.error('[ParallelEmbeddingManager] Round-robin processing failed:', error.message);
            return this.createFailedResult(texts.length, requestId, error.message);
        }
    }

    /**
     * Failover strategy: Try models in priority order until one succeeds
     */
    private async generateWithFailover(texts: string[], models: EmbeddingModelConfig[], requestId: string): Promise<ParallelEmbeddingResult> {
        const sortedModels = [...models].sort((a, b) => a.priority - b.priority);

        for (let i = 0; i < sortedModels.length; i++) {
            const model = sortedModels[i];
            try {
                console.log(`[ParallelEmbeddingManager] Trying model ${i + 1}/${sortedModels.length}: ${model.model}`);
                const result = await this.generateWithSingleModel(texts, model, requestId);

                if (result.successfulRequests > 0) {
                    result.fallbackUsed = i > 0;
                    console.log(`[ParallelEmbeddingManager] Failover succeeded with ${model.model}${result.fallbackUsed ? ' (fallback)' : ''}`);
                    return result;
                }
            } catch (error: any) {
                console.warn(`[ParallelEmbeddingManager] Model ${model.model} failed: ${error.message}`);
                if (i === sortedModels.length - 1) {
                    // Last model, re-throw the error
                    throw error;
                }
                // Continue to next model
            }
        }

        throw new Error('All failover models failed');
    }

    /**
     * Generate embeddings using a single model
     */
    private async generateWithSingleModel(texts: string[], modelConfig: EmbeddingModelConfig, requestId: string): Promise<ParallelEmbeddingResult> {
        this.modelStats[modelConfig.model].requests++;

        try {
            let result: EmbeddingResult;

            if (modelConfig.provider === 'mistral') {
                result = await this.generateWithMistral(texts, modelConfig, requestId);
            } else if (modelConfig.provider === 'gemini') {
                result = await this.generateWithGemini(texts, modelConfig, requestId);
            } else {
                throw new Error(`Unknown provider: ${modelConfig.provider}`);
            }

            if (result.success) {
                this.modelStats[modelConfig.model].successes++;
                return this.createSuccessResult(result, requestId);
            } else {
                this.modelStats[modelConfig.model].failures++;
                throw new Error(result.error || 'Unknown error');
            }
        } catch (error: any) {
            this.modelStats[modelConfig.model].failures++;
            console.error(`[ParallelEmbeddingManager] Model ${modelConfig.model} failed:`, error.message);
            throw error;
        }
    }

    /**
     * Generate embeddings using Mistral service
     */
    private async generateWithMistral(texts: string[], modelConfig: EmbeddingModelConfig, requestId: string): Promise<EmbeddingResult> {
        const service = this.mistralServices.get(modelConfig.model);
        if (!service) {
            throw new Error(`Mistral service not initialized for model: ${modelConfig.model}`);
        }

        try {
            const result = await service.getEmbeddings(texts);

            return {
                embeddings: result.embeddings.map(e => e ? {
                    ...e,
                    provider: 'mistral' as const
                } : null),
                totalTokensProcessed: result.totalTokensProcessed,
                model: result.model,
                provider: 'mistral',
                actualDimensions: result.actualDimensions,
                success: true,
                requestId
            };
        } catch (error: any) {
            return {
                embeddings: new Array(texts.length).fill(null),
                totalTokensProcessed: 0,
                model: modelConfig.model,
                provider: 'mistral',
                actualDimensions: 0,
                success: false,
                error: error.message,
                requestId
            };
        }
    }

    /**
     * Generate embeddings using Gemini service
     */
    private async generateWithGemini(texts: string[], modelConfig: EmbeddingModelConfig, requestId: string): Promise<EmbeddingResult> {
        try {
            const genAIInstance = this.geminiService.getGenAIInstance();
            if (!genAIInstance) {
                throw new Error('Gemini API not initialized');
            }

            const contents = texts.map(text => ({ role: "user", parts: [{ text }] }));
            const result = await genAIInstance.models.embedContent({
                model: modelConfig.model,
                contents
            });

            const embeddings = result.embeddings?.map(embedding => {
                if (!embedding.values) return null;
                return {
                    vector: embedding.values,
                    dimensions: embedding.values.length,
                    model: modelConfig.model,
                    provider: 'gemini' as const
                };
            }) || [];

            // Estimate tokens processed
            const totalTokens = texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);
            const actualDimensions = embeddings[0]?.dimensions || 0;

            return {
                embeddings,
                totalTokensProcessed: totalTokens,
                model: modelConfig.model,
                provider: 'gemini',
                actualDimensions,
                success: true,
                requestId
            };
        } catch (error: any) {
            return {
                embeddings: new Array(texts.length).fill(null),
                totalTokensProcessed: 0,
                model: modelConfig.model,
                provider: 'gemini',
                actualDimensions: 0,
                success: false,
                error: error.message,
                requestId
            };
        }
    }

    /**
     * Get statistics for all models
     */
    getModelStats(): Record<string, { requests: number; successes: number; failures: number; successRate: number }> {
        const stats: Record<string, any> = {};
        for (const [model, stat] of Object.entries(this.modelStats)) {
            stats[model] = {
                ...stat,
                successRate: stat.requests > 0 ? (stat.successes / stat.requests) * 100 : 0
            };
        }
        return stats;
    }

    /**
     * Check if parallel embedding is enabled and ready
     */
    isReady(): boolean {
        if (!this.config.enabled) return false;

        const enabledModels = this.config.models.filter(m => m.enabled);
        return enabledModels.length > 0;
    }

    /**
     * Get current configuration
     */
    getConfig(): typeof GEMINI_MODEL_CONFIG.parallelEmbedding {
        return this.config;
    }

    /**
     * Get detailed information about the current shared embedding setup
     */
    getSharedEmbeddingInfo(): {
        enabled: boolean;
        targetDimension: number;
        enabledModels: Array<{ provider: string; model: string; dimensions: number }>;
        loadBalancing: string;
        sharedProcessDescription: string;
    } {
        const enabledModels = this.config.models
            .filter(m => m.enabled)
            .map(m => ({
                provider: m.provider,
                model: m.model,
                dimensions: m.dimensions
            }));

        const hasGemini = enabledModels.some(m => m.provider === 'gemini');
        const hasMistral = enabledModels.some(m => m.provider === 'mistral');

        let sharedProcessDescription = '';
        if (hasGemini && hasMistral) {
            switch (this.config.loadBalancing) {
                case 'intelligent':
                    sharedProcessDescription = `🧠 Intelligent shared embedding process: Routes code chunks to Codestral-embed (3072D via scaling) and natural language/summaries to Gemini-embedding-001 (native 3072D). Includes automatic load balancing.`;
                    break;
                case 'round_robin':
                    sharedProcessDescription = `🔄 Round-robin shared embedding process using both Codestral-embed (produces 3072D vectors via scaling) and Gemini-embedding-001 (produces 3072D vectors natively).`;
                    break;
                default:
                    sharedProcessDescription = `Shared embedding process using both Codestral-embed (produces 3072D vectors via scaling) and Gemini-embedding-001 (produces 3072D vectors natively). Load balancing strategy: ${this.config.loadBalancing}`;
            }
        } else if (hasGemini) {
            sharedProcessDescription = 'Using only Gemini embedding model (3072D vectors)';
        } else if (hasMistral) {
            sharedProcessDescription = 'Using only Codestral embedding model (3072D vectors via scaling)';
        } else {
            sharedProcessDescription = 'No embedding models enabled';
        }

        return {
            enabled: this.config.enabled,
            targetDimension: this.config.targetDimension,
            enabledModels,
            loadBalancing: this.config.loadBalancing,
            sharedProcessDescription
        };
    }

    /**
     * Set the load balancing strategy dynamically.
     * @param strategy The new strategy to use.
     */
    setLoadBalancingStrategy(strategy: 'concurrent' | 'round_robin' | 'failover'): void {
        console.log(`[ParallelEmbeddingManager] Switching load balancing strategy to: ${strategy}`);
        this.config.loadBalancing = strategy;
    }

    // Helper methods
    private generateRequestId(): string {
        return `embed_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    private createEmptyResult(requestId: string): ParallelEmbeddingResult {
        return {
            embeddings: [],
            totalTokensProcessed: 0,
            successfulRequests: 0,
            failedRequests: 0,
            modelDistribution: {},
            primaryModel: 'none',
            fallbackUsed: false,
            requestId
        };
    }

    private createSuccessResult(result: EmbeddingResult, requestId: string): ParallelEmbeddingResult {
        const modelDistribution: Record<string, number> = {};
        modelDistribution[result.model] = result.embeddings.filter(e => e !== null).length;

        return {
            embeddings: result.embeddings,
            totalTokensProcessed: result.totalTokensProcessed,
            successfulRequests: result.embeddings.filter(e => e !== null).length,
            failedRequests: result.embeddings.filter(e => e === null).length,
            modelDistribution,
            primaryModel: result.model,
            fallbackUsed: false,
            requestId
        };
    }

    private createFailedResult(textCount: number, requestId: string, error: string): ParallelEmbeddingResult {
        console.error(`[ParallelEmbeddingManager] Failed result: ${error}`);
        return {
            embeddings: new Array(textCount).fill(null),
            totalTokensProcessed: 0,
            successfulRequests: 0,
            failedRequests: textCount,
            modelDistribution: {},
            primaryModel: 'none',
            fallbackUsed: false,
            requestId
        };
    }
}