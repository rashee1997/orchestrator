/**
 * Unified AI API Configuration
 * Central configuration for all AI providers including Gemini OAuth, Claude Code CLI, and Mistral API
 */

export type AuthMethod = 'api_key' | 'oauth' | 'cli' | 'subscription' | 'hybrid';
export type ModelProvider = 'gemini' | 'claude_code' | 'mistral' | 'qwen_code';

export interface ModelConfig {
    name: string;
    provider: ModelProvider;
    authMethod: AuthMethod;
    rateLimit: number;
    maxTokens: number;
    contextWindow: number;
    costTier: 'free' | 'paid' | 'subscription';
    capabilities: string[];
    description: string;
    supportsOAuth?: boolean;
    requiresApiKey?: boolean;
    supportsClaudeCode?: boolean;
    supportsEmbedding?: boolean;
}

export interface ProviderConfig {
    defaultAuthMethod: AuthMethod;
    fallbackAuthMethod?: AuthMethod;
    oauthModels?: string[];
    apiKeyModels?: string[];
    embeddingModels?: string[];
    models: Record<string, ModelConfig>;
    rateLimit: {
        oauth: number;
        apiKey: number;
        cli: number;
    };
}

export interface ParallelEmbeddingConfig {
    enabled: boolean;
    targetDimension: number;
    loadBalancing: 'concurrent' | 'round_robin' | 'failover' | 'intelligent';
    maxConcurrentRequests: number;
    models: Array<{
        model: string;
        provider: 'gemini' | 'mistral';
        enabled: boolean;
        priority: number;
        dimensions: number;
    }>;
}

export interface AIApiConfig {
    providers: Record<ModelProvider, ProviderConfig>;
    shortNames: Record<string, string>;
    defaultProvider: ModelProvider;
    defaultModel: string;
    fallbackModel: string;
    parallelEmbedding: ParallelEmbeddingConfig;
}

/**
 * Unified AI Model Configuration
 * Replaces the old Gemini-centric configuration with multi-provider support
 */
export const AI_API_CONFIG: AIApiConfig = {
    defaultProvider: 'gemini',
    defaultModel: 'gemini-2.5-pro',
    fallbackModel: 'gemini-2.5-flash-lite',

    providers: {
        gemini: {
            defaultAuthMethod: 'oauth', // OAuth first for better rate limits
            fallbackAuthMethod: 'api_key',
            oauthModels: [
                'gemini-2.5-flash',
                'gemini-2.5-pro'
            ],
            apiKeyModels: [
                'models/gemini-embedding-001',
                'gemini-2.5-flash-lite',
                'gemini-2.0-flash-lite',
               
            ],
            embeddingModels: [
                'models/gemini-embedding-001'
            ],
            rateLimit: {
                oauth: 60, // 60 RPM with OAuth
                apiKey: 10, // 10 RPM with API key
                cli: 0
            },
            models: {
                'gemini-2.5-flash': {
                    name: 'gemini-2.5-flash',
                    provider: 'gemini',
                    authMethod: 'oauth',
                    rateLimit: 60,
                    maxTokens: 8192,
                    contextWindow: 1000000,
                    costTier: 'free',
                    capabilities: ['text', 'reasoning', 'coding'],
                    supportsOAuth: true,
                    description: 'Gemini 2.5 Flash - Fast and efficient (OAuth)'
                },
                'gemini-2.5-pro': {
                    name: 'gemini-2.5-pro',
                    provider: 'gemini',
                    authMethod: 'oauth',
                    rateLimit: 60,
                    maxTokens: 8192,
                    contextWindow: 2000000,
                    costTier: 'free',
                    capabilities: ['text', 'reasoning', 'coding', 'analysis'],
                    supportsOAuth: true,
                    description: 'Gemini 2.5 Pro - Advanced reasoning (OAuth)'
                },
                'gemini-2.5-flash-lite': {
                    name: 'gemini-2.5-flash-lite',
                    provider: 'gemini',
                    authMethod: 'api_key',
                    rateLimit: 10,
                    maxTokens: 8192,
                    contextWindow: 1000000,
                    costTier: 'paid',
                    capabilities: ['text', 'reasoning'],
                    requiresApiKey: true,
                    description: 'Gemini 2.5 Flash Lite - API key only'
                },
                'gemini-2.0-flash-lite': {
                    name: 'gemini-2.0-flash-lite',
                    provider: 'gemini',
                    authMethod: 'api_key',
                    rateLimit: 10,
                    maxTokens: 8192,
                    contextWindow: 1000000,
                    costTier: 'paid',
                    capabilities: ['text', 'reasoning'],
                    requiresApiKey: true,
                    description: 'Gemini 2.0 Flash Lite - API key only'
                },
                'models/gemini-embedding-001': {
                    name: 'models/gemini-embedding-001',
                    provider: 'gemini',
                    authMethod: 'api_key',
                    rateLimit: 10,
                    maxTokens: 2048,
                    contextWindow: 2048,
                    costTier: 'paid',
                    capabilities: ['embedding'],
                    supportsEmbedding: true,
                    requiresApiKey: true,
                    description: 'Gemini Embedding 001 - Text embeddings'
                }
            }
        },

        claude_code: {
            defaultAuthMethod: 'cli',
            apiKeyModels: [],
            embeddingModels: [],
            rateLimit: {
                oauth: 0,
                apiKey: 0,
                cli: 30 // Claude Code CLI rate limit
            },
            models: {
                'claude-sonnet-4-20250514': {
                    name: 'claude-sonnet-4-20250514',
                    provider: 'claude_code',
                    authMethod: 'cli',
                    rateLimit: 30,
                    maxTokens: 8192,
                    contextWindow: 200000,
                    costTier: 'subscription',
                    capabilities: ['text', 'reasoning', 'coding', 'analysis', 'code_review'],
                    supportsClaudeCode: true,
                    description: 'Claude Sonnet 4 - Most capable model (Claude Code)'
                },
                'claude-opus-4-1-20250805': {
                    name: 'claude-opus-4-1-20250805',
                    provider: 'claude_code',
                    authMethod: 'cli',
                    rateLimit: 15,
                    maxTokens: 8192,
                    contextWindow: 200000,
                    costTier: 'subscription',
                    capabilities: ['text', 'reasoning', 'coding', 'analysis', 'complex_reasoning'],
                    supportsClaudeCode: true,
                    description: 'Claude Opus 4.1 - Advanced reasoning (Claude Code)'
                },
                'claude-opus-4-20250514': {
                    name: 'claude-opus-4-20250514',
                    provider: 'claude_code',
                    authMethod: 'cli',
                    rateLimit: 15,
                    maxTokens: 8192,
                    contextWindow: 200000,
                    costTier: 'subscription',
                    capabilities: ['text', 'reasoning', 'coding', 'analysis'],
                    supportsClaudeCode: true,
                    description: 'Claude Opus 4 - Advanced reasoning (Claude Code)'
                },
                'claude-3-7-sonnet-20250219': {
                    name: 'claude-3-7-sonnet-20250219',
                    provider: 'claude_code',
                    authMethod: 'cli',
                    rateLimit: 30,
                    maxTokens: 8192,
                    contextWindow: 200000,
                    costTier: 'subscription',
                    capabilities: ['text', 'reasoning', 'coding'],
                    supportsClaudeCode: true,
                    description: 'Claude 3.7 Sonnet - Balanced model (Claude Code)'
                },
                'claude-3-5-sonnet-20241022': {
                    name: 'claude-3-5-sonnet-20241022',
                    provider: 'claude_code',
                    authMethod: 'cli',
                    rateLimit: 30,
                    maxTokens: 8192,
                    contextWindow: 200000,
                    costTier: 'subscription',
                    capabilities: ['text', 'reasoning', 'coding'],
                    supportsClaudeCode: true,
                    description: 'Claude 3.5 Sonnet - Versatile model (Claude Code)'
                },
                'claude-3-5-haiku-20241022': {
                    name: 'claude-3-5-haiku-20241022',
                    provider: 'claude_code',
                    authMethod: 'cli',
                    rateLimit: 60,
                    maxTokens: 8192,
                    contextWindow: 200000,
                    costTier: 'subscription',
                    capabilities: ['text', 'reasoning'],
                    supportsClaudeCode: true,
                    description: 'Claude 3.5 Haiku - Fast and efficient (Claude Code)'
                }
            }
        },

        mistral: {
            defaultAuthMethod: 'api_key',
            apiKeyModels: [
                'mistral-medium-latest',
                'codestral-embed'
            ],
            embeddingModels: [
                'codestral-embed'
            ],
            rateLimit: {
                oauth: 0,
                apiKey: 30, // Mistral API rate limit
                cli: 0
            },
            models: {
                'mistral-medium-latest': {
                    name: 'mistral-medium-latest',
                    provider: 'mistral',
                    authMethod: 'api_key',
                    rateLimit: 30,
                    maxTokens: 8192,
                    contextWindow: 32000,
                    costTier: 'paid',
                    capabilities: ['text', 'reasoning', 'coding'],
                    requiresApiKey: true,
                    description: 'Mistral Medium - Balanced performance'
                },
                'codestral-embed': {
                    name: 'codestral-embed',
                    provider: 'mistral',
                    authMethod: 'api_key',
                    rateLimit: 30,
                    maxTokens: 2048,
                    contextWindow: 2048,
                    costTier: 'paid',
                    capabilities: ['embedding', 'code_embedding'],
                    supportsEmbedding: true,
                    requiresApiKey: true,
                    description: 'Codestral Embed - Code-focused embeddings'
                }
            }
        },

        qwen_code: {
            defaultAuthMethod: 'oauth',
            rateLimit: {
                oauth: 100,
                apiKey: 0,
                cli: 0
            },
            models: {
                'qwen3-coder-plus': {
                    name: 'qwen3-coder-plus',
                    provider: 'qwen_code',
                    authMethod: 'oauth',
                    rateLimit: 100,
                    maxTokens: 65536,
                    contextWindow: 1000000,
                    costTier: 'free',
                    capabilities: ['text', 'code', 'analysis'],
                    description: 'Qwen3 Coder Plus - High-performance coding model with 1M context window for large codebases',
                    supportsOAuth: true
                },
                'qwen3-coder-flash': {
                    name: 'qwen3-coder-flash',
                    provider: 'qwen_code',
                    authMethod: 'oauth',
                    rateLimit: 100,
                    maxTokens: 65536,
                    contextWindow: 1000000,
                    costTier: 'free',
                    capabilities: ['text', 'code', 'analysis'],
                    description: 'Qwen3 Coder Flash - Fast coding model with 1M context window optimized for speed',
                    supportsOAuth: true
                }
            }
        }
    },

    shortNames: {
        // Claude Code short names
        'claude-sonnet-4': 'claude-sonnet-4-20250514',
        'claude-opus-4.1': 'claude-opus-4-1-20250805',
        'claude-opus-4': 'claude-opus-4-20250514',
        'claude-sonnet-3.7': 'claude-3-7-sonnet-20250219',
        'claude-sonnet-3.5': 'claude-3-5-sonnet-20241022',
        'claude-haiku': 'claude-3-5-haiku-20241022',

        // Gemini short names
        'gemini-flash': 'gemini-2.5-flash',
        'gemini-pro': 'gemini-2.5-pro',
        'gemini-flash-lite': 'gemini-2.5-flash-lite',
        'gemini-embed': 'models/gemini-embedding-001',

        // Mistral short names
        'mistral-medium': 'mistral-medium-latest',
        'mistral-embed': 'codestral-embed',

        // QwenCode short names
        'qwen-plus': 'qwen3-coder-plus',
        'qwen-flash': 'qwen3-coder-flash'
    },

    parallelEmbedding: {
        enabled: true,
        targetDimension: 3072,
        loadBalancing: 'intelligent',
        maxConcurrentRequests: 2,
        models: [
            {
                model: 'models/gemini-embedding-001',
                provider: 'gemini',
                enabled: true,
                priority: 1,
                dimensions: 3072
            },
            {
                model: 'codestral-embed',
                provider: 'mistral',
                enabled: true,
                priority: 2,
                dimensions: 3072
            }
        ]
    }
};

/**
 * Get all models across all providers
 */
export function getAllModels(): ModelConfig[] {
    const models: ModelConfig[] = [];
    for (const provider of Object.values(AI_API_CONFIG.providers)) {
        models.push(...Object.values(provider.models));
    }
    return models;
}

/**
 * Get models for a specific provider
 */
export function getModelsByProvider(providerName: ModelProvider): ModelConfig[] {
    const provider = AI_API_CONFIG.providers[providerName];
    return provider ? Object.values(provider.models) : [];
}

/**
 * Resolve short name to full model name
 */
export function resolveModelName(nameOrShort: string): string {
    return AI_API_CONFIG.shortNames[nameOrShort] || nameOrShort;
}

/**
 * Get model configuration by name
 */
export function getModelConfig(modelName: string): ModelConfig | null {
    const resolvedName = resolveModelName(modelName);

    for (const provider of Object.values(AI_API_CONFIG.providers)) {
        if (provider.models[resolvedName]) {
            return provider.models[resolvedName];
        }
    }

    return null;
}

/**
 * Check if a model is valid
 */
export function isValidModel(modelName: string): boolean {
    return getModelConfig(modelName) !== null;
}

/**
 * Get embedding models
 */
export function getEmbeddingModels(): ModelConfig[] {
    return getAllModels().filter(model =>
        model.capabilities.includes('embedding') ||
        model.capabilities.includes('code_embedding')
    );
}

/**
 * Get text generation models
 */
export function getTextModels(): ModelConfig[] {
    return getAllModels().filter(model =>
        model.capabilities.includes('text') &&
        !model.capabilities.includes('embedding')
    );
}