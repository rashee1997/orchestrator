/**
 * Unified Mistral Provider Implementation
 * Handles both text generation and embeddings for Mistral models
 */

import { AIProvider, AIRequest, AIResponse, ProviderCapabilities, ProviderStatus } from './interfaces/AIProvider.js';
import { EmbeddingProvider, EmbeddingRequest, EmbeddingResponse, EmbeddingCapabilities } from './interfaces/EmbeddingProvider.js';
import { ModelProvider, AuthMethod } from '../AIApiConfig.js';
import { getModelInfo, isValidModel } from '../AIModelList.js';
import { Mistral } from '@mistralai/mistralai';

export class MistralProvider extends AIProvider {
    private client: Mistral;
    private embeddingCapabilities: EmbeddingCapabilities;
    private defaultModel: string;
    private embeddingModel: string;
    private targetDimensions: number;

    constructor(model: string = "mistral-medium-latest", embeddingModel: string = "codestral-embed", targetDimensions: number = 3072) {
        const capabilities: ProviderCapabilities = {
            supportsStreaming: false,
            supportsEmbedding: true,
            supportsCodeGeneration: true,
            supportsAnalysis: true,
            supportedAuthMethods: ['api_key'],
            maxContextWindow: 32000,
            rateLimit: {
                requests: 30, // Mistral API rate limit
                period: 'minute'
            }
        };

        super('mistral', capabilities);

        this.defaultModel = model;
        this.embeddingModel = embeddingModel;
        this.targetDimensions = targetDimensions;

        // Embedding capabilities
        this.embeddingCapabilities = {
            maxInputs: 100,
            maxTokensPerInput: 2048,
            supportedDimensions: [1024, 3072],
            nativeDimensions: 1024,
            supportsDimensionReduction: true,
            supportsDimensionExpansion: true,
            supportsTaskTypes: false,
            supportedTaskTypes: [],
            supportsBatching: true
        };

        const apiKey = process.env.MISTRAL_API_KEY;
        if (!apiKey) {
            throw new Error('MISTRAL_API_KEY environment variable is required');
        }

        this.client = new Mistral({ apiKey });
    }

    async initialize(): Promise<void> {
        console.log(`[MistralProvider] Initialized with text model: ${this.defaultModel}, embedding model: ${this.embeddingModel}`);
    }

    async execute(request: AIRequest): Promise<AIResponse> {
        const modelInfo = getModelInfo(request.model);
        if (!modelInfo || modelInfo.provider !== 'mistral') {
            throw new Error(`Invalid Mistral model: ${request.model}`);
        }

        console.log(`[MistralProvider] Executing ${request.model} with Mistral API`);

        try {
            // Use the Mistral chat API for text generation
            const response = await this.client.chat.complete({
                model: request.model,
                messages: [{
                    role: 'user',
                    content: request.systemInstruction
                        ? `${request.systemInstruction}\n\n${request.query}`
                        : request.query
                }],
                maxTokens: request.maxTokens || 4096,
                temperature: 0.7
            });

            // Extract content from response - cast to string as per Mistral SDK
            const content = (response.choices?.[0]?.message?.content as string) || '';

            return {
                content: [{ type: 'text', text: content }],
                model: request.model,
                provider: 'mistral',
                usage: response.usage ? {
                    inputTokens: response.usage.promptTokens || 0,
                    outputTokens: response.usage.completionTokens || 0,
                    totalTokens: response.usage.totalTokens || 0
                } : undefined,
                metadata: {
                    authMethod: 'api_key',
                    rateLimit: 30,
                    finishReason: response.choices?.[0]?.finishReason
                },
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            console.error('[MistralProvider] Request failed:', error);

            if (error instanceof Error) {
                if (error.message.includes('authentication')) {
                    throw new Error('Mistral API authentication failed. Please check MISTRAL_API_KEY.');
                } else if (error.message.includes('rate limit')) {
                    throw new Error('Mistral API rate limit exceeded. Please wait before retrying.');
                } else if (error.message.includes('not found')) {
                    throw new Error(`Mistral model not found: ${request.model}. Please check model availability.`);
                }
            }

            throw error;
        }
    }

    async generateEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
        this.validateEmbeddingRequest(request);

        const model = request.model || this.embeddingModel;
        const targetDim = request.targetDimensions || this.targetDimensions;

        console.log(`[MistralProvider] Generating embeddings for ${request.inputs.length} texts using ${model} (target: ${targetDim}D)`);

        try {
            const embeddingsBatchResponse = await this.client.embeddings.create({
                model: model,
                inputs: request.inputs,
            });

            const embeddings = embeddingsBatchResponse.data?.map((item: any, index: number) => {
                if (!item.embedding) return null;

                let vector = item.embedding;
                const originalDimensions = vector.length;

                // Handle dimension scaling if needed
                if (originalDimensions < targetDim) {
                    console.log(`[MistralProvider] Scaling vector from ${originalDimensions}D to ${targetDim}D`);
                    vector = this.scaleVectorDimensions(vector, targetDim);
                } else if (originalDimensions > targetDim) {
                    console.log(`[MistralProvider] Truncating vector from ${originalDimensions}D to ${targetDim}D`);
                    vector = vector.slice(0, targetDim);
                }

                return {
                    vector: vector,
                    dimensions: vector.length,
                    model: model,
                    provider: 'mistral' as const,
                    index: index
                };
            }) || [];

            // Estimate tokens processed (rough approximation)
            const totalTokens = request.inputs.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);
            const actualDimensions = embeddings[0]?.dimensions || 0;

            console.log(`[MistralProvider] Generated ${embeddings.length} embeddings with ${actualDimensions}D vectors`);

            return {
                embeddings,
                model: model,
                provider: 'mistral',
                totalTokensProcessed: totalTokens,
                actualDimensions,
                usage: {
                    totalTokens,
                    requestCount: 1
                },
                metadata: {
                    originalDimensions: embeddingsBatchResponse.data?.[0]?.embedding?.length || 0,
                    scaledDimensions: targetDim,
                    scalingMethod: 'interpolation'
                },
                timestamp: new Date().toISOString()
            };

        } catch (error) {
            console.error('[MistralProvider] Failed to generate embeddings:', error);
            throw error;
        }
    }

    async checkStatus(): Promise<ProviderStatus> {
        try {
            // Test connection with a simple request
            await this.client.models.list();
            return {
                available: true,
                authenticated: true,
                authMethod: 'api_key',
                rateLimit: {
                    current: 0,
                    limit: 30
                }
            };
        } catch (error) {
            return {
                available: false,
                authenticated: false,
                authMethod: 'api_key',
                rateLimit: {
                    current: 0,
                    limit: 0
                },
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    getSupportedModels(): string[] {
        return [
            'mistral-medium-latest',
            'codestral-embed'
        ];
    }

    isModelSupported(modelName: string): boolean {
        const modelInfo = getModelInfo(modelName);
        return modelInfo !== null && modelInfo.provider === 'mistral';
    }

    getPreferredAuthMethod(modelName: string): AuthMethod {
        return 'api_key';
    }

    getEmbeddingCapabilities(): EmbeddingCapabilities {
        return this.embeddingCapabilities;
    }

    getSupportedEmbeddingModels(): string[] {
        return ['codestral-embed'];
    }

    isEmbeddingModelSupported(modelName: string): boolean {
        return this.getSupportedEmbeddingModels().includes(modelName);
    }

    private validateEmbeddingRequest(request: EmbeddingRequest): void {
        if (!request.inputs || request.inputs.length === 0) {
            throw new Error('At least one input text is required');
        }

        if (request.inputs.length > this.embeddingCapabilities.maxInputs) {
            throw new Error(`Too many inputs. Maximum allowed: ${this.embeddingCapabilities.maxInputs}`);
        }

        for (const input of request.inputs) {
            if (typeof input !== 'string') {
                throw new Error('All inputs must be strings');
            }
            if (input.length === 0) {
                throw new Error('Input texts cannot be empty');
            }
            const estimatedTokens = Math.ceil(input.length / 4);
            if (estimatedTokens > this.embeddingCapabilities.maxTokensPerInput) {
                throw new Error(`Input too long. Maximum tokens per input: ${this.embeddingCapabilities.maxTokensPerInput}`);
            }
        }
    }

    /**
     * Scale vector dimensions by repeating and interpolating values to reach target dimension
     */
    private scaleVectorDimensions(vector: number[], targetDim: number): number[] {
        if (vector.length === targetDim) return vector;
        if (vector.length > targetDim) return vector.slice(0, targetDim);

        const scaleFactor = targetDim / vector.length;
        const result = new Array(targetDim);

        for (let i = 0; i < targetDim; i++) {
            const sourceIndex = i / scaleFactor;
            const lowerIndex = Math.floor(sourceIndex);
            const upperIndex = Math.min(Math.ceil(sourceIndex), vector.length - 1);
            const weight = sourceIndex - lowerIndex;

            if (lowerIndex === upperIndex) {
                result[i] = vector[lowerIndex];
            } else {
                // Linear interpolation between adjacent values
                result[i] = vector[lowerIndex] * (1 - weight) + vector[upperIndex] * weight;
            }
        }

        // Normalize the scaled vector to maintain unit length if needed
        const magnitude = Math.sqrt(result.reduce((sum, val) => sum + val * val, 0));
        if (magnitude > 0) {
            for (let i = 0; i < result.length; i++) {
                result[i] = result[i] / magnitude;
            }
        }

        return result;
    }

    async cleanup(): Promise<void> {
        console.log('[MistralProvider] Cleanup completed');
    }
}

// Backward compatibility exports
export interface MistralEmbeddingResult {
    embeddings: Array<{
        vector: number[],
        dimensions: number,
        model: string,
        provider: 'mistral'
    } | null>;
    totalTokensProcessed: number;
    model: string;
    actualDimensions: number;
}

/**
 * Legacy compatibility function for existing MistralEmbeddingService usage
 */
export async function generateMistralEmbeddings(
    inputs: string[],
    model: string = "codestral-embed",
    targetDimensions: number = 3072
): Promise<MistralEmbeddingResult> {
    const provider = new MistralProvider(undefined, model, targetDimensions);
    await provider.initialize();

    const request: EmbeddingRequest = {
        inputs,
        model,
        targetDimensions
    };

    const response = await provider.generateEmbeddings(request);

    // Convert to legacy format
    return {
        embeddings: response.embeddings.map(emb => emb ? {
            vector: emb.vector,
            dimensions: emb.dimensions,
            model: emb.model,
            provider: 'mistral' as const
        } : null),
        totalTokensProcessed: response.totalTokensProcessed,
        model: response.model,
        actualDimensions: response.actualDimensions
    };
}
