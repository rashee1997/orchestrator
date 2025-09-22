/**
 * AI Provider Interface
 * Defines the contract that all AI providers must implement
 */

import type { ModelProvider, AuthMethod } from '../../AIApiConfig.js';

export interface AIRequest {
    query: string;
    model: string;
    systemInstruction?: string;
    maxTokens?: number;
    temperature?: number;
    authMethod?: AuthMethod;
    rateLimit?: number;
    metadata?: Record<string, any>;
}

export interface AIResponse {
    content: Array<{
        type: 'text';
        text: string;
    }>;
    model: string;
    provider: ModelProvider;
    usage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
    };
    metadata?: Record<string, any>;
    timestamp: string;
}

export interface ProviderCapabilities {
    supportsStreaming: boolean;
    supportsEmbedding: boolean;
    supportsCodeGeneration: boolean;
    supportsAnalysis: boolean;
    supportedAuthMethods: AuthMethod[];
    maxContextWindow: number;
    rateLimit: {
        requests: number;
        period: 'minute' | 'hour' | 'day';
    };
}

export interface ProviderStatus {
    available: boolean;
    authenticated: boolean;
    authMethod: AuthMethod;
    rateLimit: {
        current: number;
        limit: number;
        resetTime?: number;
    };
    error?: string;
}

/**
 * Base AI Provider Interface
 * All AI providers (Gemini, Claude Code, Mistral) must implement this interface
 */
export abstract class AIProvider {
    protected readonly name: ModelProvider;
    protected readonly capabilities: ProviderCapabilities;

    constructor(name: ModelProvider, capabilities: ProviderCapabilities) {
        this.name = name;
        this.capabilities = capabilities;
    }

    /**
     * Execute an AI request
     */
    abstract execute(request: AIRequest): Promise<AIResponse>;

    /**
     * Check if the provider is available and authenticated
     */
    abstract checkStatus(): Promise<ProviderStatus>;

    /**
     * Get supported models for this provider
     */
    abstract getSupportedModels(): string[];

    /**
     * Validate if a model is supported by this provider
     */
    abstract isModelSupported(modelName: string): boolean;

    /**
     * Get the preferred auth method for a model
     */
    abstract getPreferredAuthMethod(modelName: string): AuthMethod;

    /**
     * Initialize the provider (setup auth, validate configuration, etc.)
     */
    abstract initialize(): Promise<void>;

    /**
     * Clean up resources
     */
    abstract cleanup(): Promise<void>;

    // Getters for provider information
    get providerName(): ModelProvider {
        return this.name;
    }

    get providerCapabilities(): ProviderCapabilities {
        return { ...this.capabilities };
    }
}

/**
 * Factory interface for creating AI providers
 */
export interface AIProviderFactory {
    createProvider(providerName: ModelProvider): AIProvider;
    getAvailableProviders(): ModelProvider[];
    isProviderAvailable(providerName: ModelProvider): Promise<boolean>;
}