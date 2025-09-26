/**
 * Gemini Provider Implementation
 * Handles OAuth-first routing with API key fallback for Gemini models
 */

import { AIProvider, AIRequest, AIResponse, ProviderCapabilities, ProviderStatus } from './interfaces/AIProvider.js';
import { EmbeddingProvider, EmbeddingRequest, EmbeddingResponse, EmbeddingCapabilities } from './interfaces/EmbeddingProvider.js';
import { ModelProvider, AuthMethod } from '../AIApiConfig.js';
import { getModelInfo, isValidModel } from '../AIModelList.js';
import { ApiKeyManager } from '../utils/ApiKeyManager.js';

// Import existing Gemini infrastructure
import { GeminiApiClient } from '../../gemini-integration-modules/GeminiApiClient.js';
import { checkOAuthAvailability, getAuthStatus } from '../../gemini-integration-modules/GeminiConfig.js';

export class GeminiProvider extends AIProvider {
    private geminiApiClient: GeminiApiClient;
    private apiKeyManager: ApiKeyManager;
    private authStatus: { hasOAuth: boolean; hasApiKeys: boolean; preferredAuth: string; oauthRateLimit: number; apiKeyRateLimit: number; claudeCodeRateLimit: number } | null = null;
    private embeddingCapabilities: EmbeddingCapabilities;

    constructor() {
        const capabilities: ProviderCapabilities = {
            supportsStreaming: false,
            supportsEmbedding: true,
            supportsCodeGeneration: true,
            supportsAnalysis: true,
            supportedAuthMethods: ['oauth', 'api_key'],
            maxContextWindow: 2000000,
            rateLimit: {
                requests: 60, // OAuth default
                period: 'minute'
            }
        };

        super('gemini', capabilities);

        // Initialize embedding capabilities
        this.embeddingCapabilities = {
            maxInputs: 100, // Gemini can handle multiple inputs
            maxTokensPerInput: 2048, // Approximate token limit
            supportedDimensions: [3072], // Gemini embedding dimensions are 3072
            nativeDimensions: 3072,
            supportsDimensionReduction: true,
            supportsDimensionExpansion: false, // No need to expand from 3072
            supportsTaskTypes: false, // Gemini doesn't support task type hints
            supportedTaskTypes: [],
            supportsBatching: true // We handle batching by processing multiple inputs
        };

        // Initialize API key manager for fallback
        this.apiKeyManager = new ApiKeyManager();

        // Initialize Gemini API client (will handle OAuth/API key routing)
        this.geminiApiClient = new GeminiApiClient();
    }

    async initialize(): Promise<void> {
        console.log('[GeminiProvider] Initializing with OAuth-first routing...');

        try {
            // Check authentication status
            this.authStatus = await getAuthStatus();

            if (this.authStatus.hasOAuth) {
                console.log('[GeminiProvider] OAuth available - using OAuth for supported models');
            } else if (this.authStatus.hasApiKeys) {
                console.log('[GeminiProvider] No OAuth - falling back to API keys');
            } else {
                console.warn('[GeminiProvider] No authentication available');
            }
        } catch (error) {
            console.error('[GeminiProvider] Failed to initialize:', error);
            throw error;
        }
    }

    async execute(request: AIRequest): Promise<AIResponse> {
        const modelInfo = getModelInfo(request.model);
        if (!modelInfo || modelInfo.provider !== 'gemini') {
            throw new Error(`Invalid Gemini model: ${request.model}`);
        }

        // Determine auth method based on model and availability
        const authMethod = this.determineAuthMethod(request.model, request.authMethod);

        console.log(`[GeminiProvider] Executing ${request.model} with ${authMethod} auth`);

        try {
            // Use GeminiApiClient.askGemini to unify API calls and authentication routing.
            // This method internally decides whether to use OAuth or API key based on availability and model support.
            // Purpose: Simplify provider code and ensure correct, efficient API usage with fallback handling.
            const response = await this.geminiApiClient.askGemini(
                request.query,
                request.model,
                request.systemInstruction
            );

            // Convert Part[] to expected AIResponse content format
            const content = response.content?.map(part => ({
                type: 'text' as const,
                text: (part as any).text || ''
            })) || [{ type: 'text' as const, text: '' }];

            // Convert to standardized AI response format
            return {
                content,
                model: request.model,
                provider: 'gemini',
                usage: {}, // GeminiApiClient doesn't return usage info in askGemini
                metadata: {
                    authMethod: 'auto', // GeminiApiClient handles this internally
                    rateLimit: 60, // Will be determined by auth method used
                    confidenceScore: response.confidenceScore,
                    groundingMetadata: response.groundingMetadata
                },
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            console.error(`[GeminiProvider] Execution failed:`, error);
            throw error;
        }
    }

    private async executeWithApiKey(request: AIRequest): Promise<AIResponse> {
        try {
            const response = await this.geminiApiClient.askGemini(
                request.query,
                request.model,
                request.systemInstruction
            );

            // Convert Part[] to expected AIResponse content format
            const content = response.content?.map(part => ({
                type: 'text' as const,
                text: (part as any).text || ''
            })) || [{ type: 'text' as const, text: '' }];

            return {
                content,
                model: request.model,
                provider: 'gemini',
                usage: {}, // GeminiApiClient doesn't return usage info in askGemini
                metadata: {
                    authMethod: 'api_key',
                    rateLimit: 10,
                    fallback: true
                },
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            // Try rotating API key if available
            if (this.apiKeyManager.hasKeys()) {
                this.apiKeyManager.rotateKey();
                console.log('[GeminiProvider] Rotated API key, retrying...');

                const response = await this.geminiApiClient.askGemini(
                    request.query,
                    request.model,
                    request.systemInstruction
                );

                // Convert Part[] to expected AIResponse content format
                const content = response.content?.map(part => ({
                    type: 'text' as const,
                    text: (part as any).text || ''
                })) || [{ type: 'text' as const, text: '' }];

                return {
                    content,
                    model: request.model,
                    provider: 'gemini',
                    usage: {},
                    metadata: {
                        authMethod: 'api_key',
                        rateLimit: 10,
                        fallback: true,
                        keyRotated: true
                    },
                    timestamp: new Date().toISOString()
                };
            }
            throw error;
        }
    }

    async checkStatus(): Promise<ProviderStatus> {
        try {
            const authStatus = await getAuthStatus();

            return {
                available: authStatus.hasOAuth || authStatus.hasApiKeys,
                authenticated: authStatus.hasOAuth || authStatus.hasApiKeys,
                authMethod: authStatus.preferredAuth,
                rateLimit: {
                    current: 0, // Would need rate limit tracking
                    limit: authStatus.hasOAuth ? 60 : 10
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
            'gemini-2.5-flash',
            'gemini-2.5-pro',
            'gemini-2.5-flash-lite',
            'gemini-2.0-flash',
            'models/gemini-embedding-001',
            'models/text-embedding-004'
        ];
    }

    isModelSupported(modelName: string): boolean {
        const modelInfo = getModelInfo(modelName);
        return modelInfo !== null && modelInfo.provider === 'gemini';
    }

    getPreferredAuthMethod(modelName: string): AuthMethod {
        const modelInfo = getModelInfo(modelName);
        if (!modelInfo) return 'api_key';

        // OAuth first for supported models
        if (modelInfo.supportsOAuth && this.authStatus?.hasOAuth) {
            return 'oauth';
        }

        // Embedding models always use API key
        if (modelInfo.capabilities.includes('embedding')) {
            return 'api_key';
        }

        // Fallback to API key
        return 'api_key';
    }

    private determineAuthMethod(modelName: string, requestedAuth?: AuthMethod): AuthMethod {
        const modelInfo = getModelInfo(modelName);
        if (!modelInfo) return 'api_key';

        // Honor specific request if valid
        if (requestedAuth) {
            if (requestedAuth === 'oauth' && modelInfo.supportsOAuth && this.authStatus?.hasOAuth) {
                return 'oauth';
            }
            if (requestedAuth === 'api_key' && this.authStatus?.hasApiKeys) {
                return 'api_key';
            }
        }

        // Use preferred auth method
        return this.getPreferredAuthMethod(modelName);
    }

    /**
     * Generate embeddings using Gemini embedding models
     */
    async generateEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
        this.validateEmbeddingRequest(request);

        const model = request.model || 'models/gemini-embedding-001';
        const targetDim = request.targetDimensions || this.embeddingCapabilities.nativeDimensions;

        console.log(`[GeminiProvider] Generating embeddings for ${request.inputs.length} texts using ${model} (target: ${targetDim}D)`);

        try {
            const response = await this.geminiApiClient.generateEmbeddings(request.inputs, model);

            const embeddings = response.embeddings.map((item, index) => {
                if (!item) return null;

                let vector = item.vector;
                const originalDimensions = vector.length;

                // Handle dimension scaling if needed
                if (originalDimensions !== targetDim) {
                    if (originalDimensions > targetDim) {
                        console.log(`[GeminiProvider] Truncating vector from ${originalDimensions}D to ${targetDim}D`);
                        vector = vector.slice(0, targetDim);
                    } else if (originalDimensions < targetDim) {
                        console.log(`[GeminiProvider] Scaling vector from ${originalDimensions}D to ${targetDim}D`);
                        vector = this.scaleVectorDimensions(vector, targetDim);
                    }
                }

                return {
                    vector: vector,
                    dimensions: vector.length,
                    model: model,
                    provider: 'gemini' as const,
                    index: index
                };
            });

            const actualDimensions = embeddings[0]?.dimensions || 0;
            console.log(`[GeminiProvider] Generated ${embeddings.filter(e => e !== null).length} embeddings with ${actualDimensions}D vectors`);

            return {
                embeddings,
                model: model,
                provider: 'gemini',
                totalTokensProcessed: response.totalTokensProcessed,
                actualDimensions,
                usage: {
                    totalTokens: response.totalTokensProcessed,
                    requestCount: 1
                },
                metadata: {
                    originalDimensions: response.embeddings[0]?.dimensions || 0,
                    scaledDimensions: targetDim,
                    authMethod: 'api_key' // Gemini embeddings always use API key
                },
                timestamp: new Date().toISOString()
            };

        } catch (error) {
            console.error('[GeminiProvider] Failed to generate embeddings:', error);
            throw error;
        }
    }

    /**
     * Get supported embedding models
     */
    getSupportedEmbeddingModels(): string[] {
        return [
            'models/gemini-embedding-001',
            'models/text-embedding-004'
        ];
    }

    /**
     * Check if a model is supported for embeddings
     */
    isEmbeddingModelSupported(modelName: string): boolean {
        return this.getSupportedEmbeddingModels().includes(modelName);
    }

    /**
     * Get embedding capabilities
     */
    getEmbeddingCapabilities(): EmbeddingCapabilities {
        return this.embeddingCapabilities;
    }

    /**
     * Scale vector dimensions using interpolation
     */
    scaleVectorDimensions(vector: number[], targetDim: number): number[] {
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

        // Normalize the scaled vector to maintain unit length
        const magnitude = Math.sqrt(result.reduce((sum, val) => sum + val * val, 0));
        if (magnitude > 0) {
            for (let i = 0; i < result.length; i++) {
                result[i] = result[i] / magnitude;
            }
        }

        return result;
    }

    /**
     * Validate embedding request
     */
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

    async cleanup(): Promise<void> {
        // Cleanup resources if needed
        console.log('[GeminiProvider] Cleanup completed');
    }
}