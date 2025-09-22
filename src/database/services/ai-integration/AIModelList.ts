/**
 * Centralized AI Model Registry and Router
 * Single source of truth for all AI models across providers
 * Uses AIApiConfig as the data source and provides routing logic
 */

import {
    AI_API_CONFIG,
    ModelConfig,
    ModelProvider,
    getAllModels as configGetAllModels,
    getModelsByProvider as configGetModelsByProvider,
    resolveModelName as configResolveModelName,
    getModelConfig as configGetModelConfig,
    isValidModel as configIsValidModel,
    getEmbeddingModels as configGetEmbeddingModels,
    getTextModels as configGetTextModels
} from './AIApiConfig.js';

export interface ModelInfo {
    fullName: string;
    shortName?: string;
    provider: ModelProvider;
    authMethod: 'oauth' | 'api_key' | 'cli' | 'subscription' | 'hybrid';
    capabilities: string[];
    rateLimit: number;
    contextWindow: number;
    maxTokens: number;
    costTier: 'free' | 'paid' | 'subscription';
    description: string;
    supportsOAuth?: boolean;
    requiresApiKey?: boolean;
    supportsClaudeCode?: boolean;
    supportsEmbedding?: boolean;
}

/**
 * Centralized Model Registry and Router
 */
export class AIModelList {
    private static models: Map<string, ModelInfo> = new Map();
    private static shortNameMap: Map<string, string> = new Map();
    private static providerModels: Map<ModelProvider, ModelInfo[]> = new Map();
    private static embeddingModels: ModelInfo[] = [];
    private static textModels: ModelInfo[] = [];
    private static initialized = false;

    /**
     * Initialize the model registry from AI config
     */
    static initialize() {
        if (this.initialized) return;

        console.log('[AIModelList] Initializing centralized model registry...');

        // Clear existing data
        this.models.clear();
        this.shortNameMap.clear();
        this.providerModels.clear();
        this.embeddingModels = [];
        this.textModels = [];

        // Load models from config
        this.loadModelsFromConfig();

        // Load short names
        this.loadShortNamesFromConfig();

        // Organize models by type
        this.organizeModelsByType();

        this.initialized = true;
        console.log(`[AIModelList] Loaded ${this.models.size} models across ${this.providerModels.size} providers`);
    }

    /**
     * Load all models from AI config and convert to ModelInfo
     */
    private static loadModelsFromConfig() {
        for (const [providerName, providerConfig] of Object.entries(AI_API_CONFIG.providers)) {
            const provider = providerName as ModelProvider;
            const providerModelsArray: ModelInfo[] = [];

            for (const [modelName, modelConfig] of Object.entries(providerConfig.models)) {
                const modelInfo: ModelInfo = {
                    fullName: modelConfig.name,
                    provider: modelConfig.provider,
                    authMethod: modelConfig.authMethod,
                    capabilities: modelConfig.capabilities,
                    rateLimit: modelConfig.rateLimit,
                    contextWindow: modelConfig.contextWindow,
                    maxTokens: modelConfig.maxTokens,
                    costTier: modelConfig.costTier,
                    description: modelConfig.description,
                    supportsOAuth: modelConfig.supportsOAuth,
                    requiresApiKey: modelConfig.requiresApiKey,
                    supportsClaudeCode: modelConfig.supportsClaudeCode,
                    supportsEmbedding: modelConfig.supportsEmbedding
                };

                this.models.set(modelName, modelInfo);
                providerModelsArray.push(modelInfo);
            }

            this.providerModels.set(provider, providerModelsArray);
        }
    }

    /**
     * Load short name mappings from config
     */
    private static loadShortNamesFromConfig() {
        for (const [shortName, fullName] of Object.entries(AI_API_CONFIG.shortNames)) {
            this.shortNameMap.set(shortName, fullName);

            // Add short name to model info if it exists
            const modelInfo = this.models.get(fullName);
            if (modelInfo) {
                modelInfo.shortName = shortName;
            }
        }
    }

    /**
     * Organize models by type for quick access
     */
    private static organizeModelsByType() {
        for (const modelInfo of this.models.values()) {
            if (modelInfo.capabilities.includes('embedding') ||
                modelInfo.capabilities.includes('code_embedding')) {
                this.embeddingModels.push(modelInfo);
            }

            if (modelInfo.capabilities.includes('text') &&
                !modelInfo.capabilities.includes('embedding')) {
                this.textModels.push(modelInfo);
            }
        }
    }

    /**
     * Get all models across all providers
     */
    static getAllModels(): ModelInfo[] {
        this.initialize();
        return Array.from(this.models.values());
    }

    /**
     * Get models for a specific provider
     */
    static getModelsByProvider(provider: ModelProvider): ModelInfo[] {
        this.initialize();
        return this.providerModels.get(provider) || [];
    }

    /**
     * Resolve short name to full model name
     */
    static resolveModelName(nameOrShort: string): string {
        this.initialize();
        return this.shortNameMap.get(nameOrShort) || nameOrShort;
    }

    /**
     * Get model information by name (supports short names)
     */
    static getModelInfo(modelName: string): ModelInfo | null {
        this.initialize();
        const resolvedName = this.resolveModelName(modelName);
        return this.models.get(resolvedName) || null;
    }

    /**
     * Check if a model is valid
     */
    static isValidModel(modelName: string): boolean {
        this.initialize();
        return this.getModelInfo(modelName) !== null;
    }

    /**
     * Get all embedding models
     */
    static getEmbeddingModels(): ModelInfo[] {
        this.initialize();
        return [...this.embeddingModels];
    }

    /**
     * Get all text generation models
     */
    static getTextModels(): ModelInfo[] {
        this.initialize();
        return [...this.textModels];
    }

    /**
     * Get models by capability
     */
    static getModelsByCapability(capability: string): ModelInfo[] {
        this.initialize();
        return Array.from(this.models.values()).filter(model =>
            model.capabilities.includes(capability)
        );
    }

    /**
     * Get models by auth method
     */
    static getModelsByAuthMethod(authMethod: 'oauth' | 'api_key' | 'cli'): ModelInfo[] {
        this.initialize();
        return Array.from(this.models.values()).filter(model =>
            model.authMethod === authMethod
        );
    }

    /**
     * Get default model for a provider
     */
    static getDefaultModelForProvider(provider: ModelProvider): ModelInfo | null {
        this.initialize();
        const models = this.getModelsByProvider(provider);

        // Return first model or specific defaults
        if (provider === 'gemini') {
            return this.getModelInfo('gemini-2.5-pro');
        } else if (provider === 'claude_code') {
            return this.getModelInfo('claude-sonnet-4-20250514');
        } else if (provider === 'mistral') {
            return this.getModelInfo('mistral-medium-latest');
        } else if (provider === 'qwen_code') {
            return this.getModelInfo('qwen3-coder-plus');
        }

        return models.length > 0 ? models[0] : null;
    }

    /**
     * Get all short names
     */
    static getShortNames(): Record<string, string> {
        this.initialize();
        return Object.fromEntries(this.shortNameMap);
    }

    /**
     * Get provider for a model
     */
    static getProviderForModel(modelName: string): ModelProvider | null {
        const modelInfo = this.getModelInfo(modelName);
        return modelInfo ? modelInfo.provider : null;
    }

    /**
     * Get model names for tool schema enum
     */
    static getModelNamesForEnum(): string[] {
        this.initialize();
        const allNames = new Set<string>();

        // Add all full names
        for (const modelName of this.models.keys()) {
            allNames.add(modelName);
        }

        // Add all short names
        for (const shortName of this.shortNameMap.keys()) {
            allNames.add(shortName);
        }

        return Array.from(allNames).sort();
    }
}

// 🎯 Convenient exports for easy importing across the codebase
export const ALL_MODELS = AIModelList.getAllModels;
export const CLAUDE_MODELS = () => AIModelList.getModelsByProvider('claude_code');
export const GEMINI_MODELS = () => AIModelList.getModelsByProvider('gemini');
export const MISTRAL_MODELS = () => AIModelList.getModelsByProvider('mistral');
export const QWEN_MODELS = () => AIModelList.getModelsByProvider('qwen_code');
export const EMBEDDING_MODELS = AIModelList.getEmbeddingModels;
export const TEXT_MODELS = AIModelList.getTextModels;

// 🔍 Utility functions (bound to avoid 'this' context issues)
export const resolveModel = (nameOrShort: string) => AIModelList.resolveModelName(nameOrShort);
export const isValidModel = (modelName: string) => AIModelList.isValidModel(modelName);
export const getModelInfo = (modelName: string) => AIModelList.getModelInfo(modelName);
export const getProviderForModel = (modelName: string) => AIModelList.getProviderForModel(modelName);
export const getModelsByCapability = (capability: string) => AIModelList.getModelsByCapability(capability);
export const getModelsByAuthMethod = (authMethod: 'oauth' | 'api_key' | 'cli') => AIModelList.getModelsByAuthMethod(authMethod);
export const getShortNames = () => AIModelList.getShortNames();
export const getModelNamesForEnum = () => AIModelList.getModelNamesForEnum();

// 🚀 Auto-initialize on import
AIModelList.initialize();