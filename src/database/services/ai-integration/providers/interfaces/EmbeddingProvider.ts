/**
 * Embedding Provider Interface
 * Defines the contract for embedding generation providers
 */

import type { ModelProvider, AuthMethod } from '../../AIApiConfig.js';

export interface EmbeddingRequest {
    inputs: string[];
    model: string;
    taskType?: 'RETRIEVAL_QUERY' | 'RETRIEVAL_DOCUMENT' | 'SEMANTIC_SIMILARITY' | 'CLASSIFICATION' | 'CLUSTERING' | 'QUESTION_ANSWERING' | 'FACT_VERIFICATION' | 'CODE_RETRIEVAL_QUERY';
    targetDimensions?: number;
    authMethod?: AuthMethod;
    metadata?: Record<string, any>;
}

export interface EmbeddingVector {
    vector: number[];
    dimensions: number;
    model: string;
    provider: ModelProvider;
    index?: number;
}

export interface EmbeddingResponse {
    embeddings: Array<EmbeddingVector | null>;
    model: string;
    provider: ModelProvider;
    totalTokensProcessed: number;
    actualDimensions: number;
    usage?: {
        totalTokens: number;
        requestCount: number;
    };
    metadata?: Record<string, any>;
    timestamp: string;
}

export interface EmbeddingCapabilities {
    maxInputs: number;
    maxTokensPerInput: number;
    supportedDimensions: number[];
    nativeDimensions: number;
    supportsDimensionReduction: boolean;
    supportsDimensionExpansion: boolean;
    supportsTaskTypes: boolean;
    supportedTaskTypes: string[];
    supportsBatching: boolean;
}

/**
 * Base Embedding Provider Interface
 */
export abstract class EmbeddingProvider {
    protected readonly name: ModelProvider;
    protected readonly capabilities: EmbeddingCapabilities;

    constructor(name: ModelProvider, capabilities: EmbeddingCapabilities) {
        this.name = name;
        this.capabilities = capabilities;
    }

    /**
     * Generate embeddings for the given inputs
     */
    abstract generateEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse>;

    /**
     * Get supported embedding models
     */
    abstract getSupportedModels(): string[];

    /**
     * Check if a model is supported for embeddings
     */
    abstract isModelSupported(modelName: string): boolean;

    /**
     * Scale vector dimensions (implementation may vary by provider)
     */
    abstract scaleVectorDimensions(vector: number[], targetDim: number): number[];

    /**
     * Initialize the embedding provider
     */
    abstract initialize(): Promise<void>;

    /**
     * Clean up resources
     */
    abstract cleanup(): Promise<void>;

    // Getters
    get providerName(): ModelProvider {
        return this.name;
    }

    get embeddingCapabilities(): EmbeddingCapabilities {
        return { ...this.capabilities };
    }

    /**
     * Validate embedding request
     */
    protected validateRequest(request: EmbeddingRequest): void {
        if (!request.inputs || request.inputs.length === 0) {
            throw new Error('No inputs provided for embedding generation');
        }

        if (request.inputs.length > this.capabilities.maxInputs) {
            throw new Error(`Too many inputs. Maximum allowed: ${this.capabilities.maxInputs}`);
        }

        // Validate each input length
        for (const input of request.inputs) {
            if (input.length > this.capabilities.maxTokensPerInput * 4) { // Rough token estimation
                console.warn(`Input may exceed token limit: ${input.length} characters`);
            }
        }

        // Validate target dimensions if specified
        if (request.targetDimensions) {
            if (!this.capabilities.supportedDimensions.includes(request.targetDimensions)) {
                if (!this.capabilities.supportsDimensionReduction && !this.capabilities.supportsDimensionExpansion) {
                    throw new Error(`Unsupported target dimensions: ${request.targetDimensions}`);
                }
            }
        }

        // Validate task type if specified
        if (request.taskType && this.capabilities.supportsTaskTypes) {
            if (!this.capabilities.supportedTaskTypes.includes(request.taskType)) {
                throw new Error(`Unsupported task type: ${request.taskType}`);
            }
        }
    }
}

/**
 * Factory interface for creating embedding providers
 */
export interface EmbeddingProviderFactory {
    createProvider(providerName: ModelProvider): EmbeddingProvider;
    getAvailableProviders(): ModelProvider[];
    isProviderAvailable(providerName: ModelProvider): Promise<boolean>;
}