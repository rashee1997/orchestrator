import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

export type GeminiEmbeddingTaskType =
    | 'RETRIEVAL_QUERY'
    | 'RETRIEVAL_DOCUMENT'
    | 'SEMANTIC_SIMILARITY'
    | 'CLASSIFICATION'
    | 'CLUSTERING'
    | 'QUESTION_ANSWERING'
    | 'FACT_VERIFICATION'
    | 'CODE_RETRIEVAL_QUERY';

export type AuthMethod = 'api_key' | 'oauth' | 'subscription' | 'hybrid';
export type ModelProvider = 'gemini' | 'claude_code';

export interface AuthStatus {
    hasApiKeys: boolean;
    hasOAuth: boolean;
    hasClaudeCode: boolean;
    preferredAuth: AuthMethod;
    oauthRateLimit: number;
    apiKeyRateLimit: number;
    claudeCodeRateLimit: number;
}

export interface ModelConfig {
    name: string;
    provider: ModelProvider;
    authMethod: AuthMethod;
    rateLimit: number;
    maxTokens: number;
    contextWindow: number;
    costTier: 'free' | 'paid' | 'subscription';
    supportsOAuth?: boolean;
    requiresApiKey?: boolean;
    supportsClaudeCode?: boolean;
    description: string;
}

export interface EmbeddingModelConfig {
    model: string;
    provider: 'gemini' | 'mistral';
    enabled: boolean;
    priority: number;
    dimensions: number;
}

export interface ParallelEmbeddingConfig {
    enabled: boolean;
    targetDimension: number;
    loadBalancing: 'concurrent' | 'round_robin' | 'failover' | 'intelligent';
    maxConcurrentRequests: number;
    models: EmbeddingModelConfig[];
}

export interface GeminiModelConfig {
    defaultModel: string;
    fallbackModel: string;
    embeddingModel: string;
    fallbackEmbeddingModel: string;
    embeddingDimensions: number;
    fallbackEmbeddingDimensions: number;
    parallelEmbedding: ParallelEmbeddingConfig;
    authStatus?: AuthStatus;
    oauthModels: string[]; // Models that support OAuth
    apiKeyOnlyModels: string[]; // Models that require API keys
    claudeCodeModels: string[]; // Claude Code models
    allModels: Record<string, ModelConfig>; // All available models
    modelShortNames: Record<string, string>; // Short name to full model ID mapping
}

export const GEMINI_MODEL_CONFIG: GeminiModelConfig = {
    defaultModel: "gemini-2.5-pro",
    fallbackModel: "gemini-2.5-flash-lite",
    embeddingModel: "models/gemini-embedding-001",
    fallbackEmbeddingModel: "models/text-embedding-004",
    embeddingDimensions: 3072,
    fallbackEmbeddingDimensions: 768,
    oauthModels: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"], // OAuth supported models
    apiKeyOnlyModels: [
        "models/gemini-embedding-001",
        "models/text-embedding-004",
        "gemini-2.0-flash-lite",
        "gemini-1.5-flash",
        "gemini-1.5-pro"
    ], // API key required models
    claudeCodeModels: [
        "claude-sonnet-4-20250514",
        "claude-opus-4-1-20250805",
        "claude-opus-4-20250514",
        "claude-3-7-sonnet-20250219",
        "claude-3-5-sonnet-20241022",
        "claude-3-5-haiku-20241022"
    ], // Claude Code models
    allModels: {
        // Gemini OAuth Models
        "gemini-2.5-flash": {
            name: "gemini-2.5-flash",
            provider: "gemini",
            authMethod: "oauth",
            rateLimit: 60,
            maxTokens: 8192,
            contextWindow: 1000000,
            costTier: "free",
            supportsOAuth: true,
            description: "Gemini 2.5 Flash - Fast and efficient with OAuth (60 RPM)"
        },
        "gemini-2.5-pro": {
            name: "gemini-2.5-pro",
            provider: "gemini",
            authMethod: "oauth",
            rateLimit: 60,
            maxTokens: 8192,
            contextWindow: 1000000,
            costTier: "free",
            supportsOAuth: true,
            description: "Gemini 2.5 Pro - Advanced reasoning with OAuth (60 RPM)"
        },
        // Gemini API Key Models
        "gemini-2.5-flash-lite": {
            name: "gemini-2.5-flash-lite",
            provider: "gemini",
            authMethod: "api_key",
            rateLimit: 15,
            maxTokens: 8192,
            contextWindow: 1000000,
            costTier: "free",
            requiresApiKey: true,
            description: "Gemini 2.5 Flash Lite - Lightweight version (15 RPM)"
        },
        "gemini-2.0-flash-lite": {
            name: "gemini-2.0-flash-lite",
            provider: "gemini",
            authMethod: "api_key",
            rateLimit: 25,
            maxTokens: 8192,
            contextWindow: 1000000,
            costTier: "free",
            requiresApiKey: true,
            description: "Gemini 2.0 Flash Lite - Previous generation (25 RPM)"
        },
        "models/gemini-embedding-001": {
            name: "models/gemini-embedding-001",
            provider: "gemini",
            authMethod: "api_key",
            rateLimit: 10,
            maxTokens: 0, // Embedding model
            contextWindow: 2048,
            costTier: "free",
            requiresApiKey: true,
            description: "Gemini Embedding Model - Text embeddings (API key only)"
        },
        // Claude Code Models
        "claude-sonnet-4-20250514": {
            name: "claude-sonnet-4-20250514",
            provider: "claude_code",
            authMethod: "subscription",
            rateLimit: 30,
            maxTokens: 8192,
            contextWindow: 200000,
            costTier: "subscription",
            supportsClaudeCode: true,
            description: "Claude Sonnet 4 - Balanced intelligence and speed (Claude Code)"
        },
        "claude-opus-4-1-20250805": {
            name: "claude-opus-4-1-20250805",
            provider: "claude_code",
            authMethod: "subscription",
            rateLimit: 20,
            maxTokens: 8192,
            contextWindow: 200000,
            costTier: "subscription",
            supportsClaudeCode: true,
            description: "Claude Opus 4.1 - Most capable for complex reasoning (Claude Code)"
        },
        "claude-opus-4-20250514": {
            name: "claude-opus-4-20250514",
            provider: "claude_code",
            authMethod: "subscription",
            rateLimit: 20,
            maxTokens: 8192,
            contextWindow: 200000,
            costTier: "subscription",
            supportsClaudeCode: true,
            description: "Claude Opus 4 - Maximum intelligence (Claude Code)"
        },
        "claude-3-7-sonnet-20250219": {
            name: "claude-3-7-sonnet-20250219",
            provider: "claude_code",
            authMethod: "subscription",
            rateLimit: 30,
            maxTokens: 8192,
            contextWindow: 200000,
            costTier: "subscription",
            supportsClaudeCode: true,
            description: "Claude 3.7 Sonnet - Enhanced reasoning (Claude Code)"
        },
        "claude-3-5-sonnet-20241022": {
            name: "claude-3-5-sonnet-20241022",
            provider: "claude_code",
            authMethod: "subscription",
            rateLimit: 30,
            maxTokens: 8192,
            contextWindow: 200000,
            costTier: "subscription",
            supportsClaudeCode: true,
            description: "Claude 3.5 Sonnet - Versatile model (Claude Code)"
        },
        "claude-3-5-haiku-20241022": {
            name: "claude-3-5-haiku-20241022",
            provider: "claude_code",
            authMethod: "subscription",
            rateLimit: 60,
            maxTokens: 8192,
            contextWindow: 200000,
            costTier: "subscription",
            supportsClaudeCode: true,
            description: "Claude 3.5 Haiku - Fast and efficient (Claude Code)"
        }
    },
    parallelEmbedding: {
        enabled: true,
        targetDimension: 3072,
        loadBalancing: 'intelligent',
        maxConcurrentRequests: 2,
        models: [
            {
                model: "models/gemini-embedding-001",
                provider: 'gemini',
                enabled: true,
                priority: 1,
                dimensions: 3072
            },
            {
                model: "codestral-embed",
                provider: 'mistral',
                enabled: true,
                priority: 2,
                dimensions: 3072
            }
        ]
    },
    modelShortNames: {
        // Claude Code short names
        "claude-sonnet-4": "claude-sonnet-4-20250514",
        "claude-opus-4.1": "claude-opus-4-1-20250805",
        "claude-opus-4": "claude-opus-4-20250514",
        "claude-sonnet-3.7": "claude-3-7-sonnet-20250219",
        "claude-sonnet-3.5": "claude-3-5-sonnet-20241022",
        "claude-haiku": "claude-3-5-haiku-20241022",

        // Gemini short names for consistency
        "gemini-flash": "gemini-2.5-flash",
        "gemini-pro": "gemini-2.5-pro",
        "gemini-flash-lite": "gemini-2.5-flash-lite",
        "gemini-embed": "models/gemini-embedding-001"
    }
};

// Global auth status cache
let cachedAuthStatus: AuthStatus | null = null;
let lastAuthCheck = 0;
const AUTH_CACHE_DURATION = 30000; // 30 seconds

/**
 * Check OAuth credentials availability
 */
export async function checkOAuthAvailability(): Promise<boolean> {
    try {
        const credPath = path.join(os.homedir(), ".gemini", "oauth_creds.json");
        await fs.access(credPath);
        const credData = await fs.readFile(credPath, "utf-8");
        const credentials = JSON.parse(credData);
        return !!(credentials.access_token && credentials.refresh_token);
    } catch {
        return false;
    }
}

/**
 * Check Claude Code CLI availability
 */
export async function checkClaudeCodeAvailability(): Promise<boolean> {
    try {
        const { execa } = await import('execa');
        await execa('claude', ['--version'], { timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

/**
 * Get current authentication status
 */
export async function getAuthStatus(): Promise<AuthStatus> {
    const now = Date.now();
    if (cachedAuthStatus && (now - lastAuthCheck) < AUTH_CACHE_DURATION) {
        return cachedAuthStatus;
    }

    const hasApiKeys = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
    const hasOAuth = await checkOAuthAvailability();
    const hasClaudeCode = await checkClaudeCodeAvailability();

    let preferredAuth: AuthMethod = 'api_key';
    if (hasClaudeCode) preferredAuth = 'subscription';
    else if (hasOAuth) preferredAuth = 'oauth';
    else if (hasApiKeys) preferredAuth = 'api_key';
    else preferredAuth = 'hybrid';

    const authStatus: AuthStatus = {
        hasApiKeys,
        hasOAuth,
        hasClaudeCode,
        preferredAuth,
        oauthRateLimit: 60, // 60 RPM with OAuth
        apiKeyRateLimit: 10, // 10 RPM with API keys
        claudeCodeRateLimit: 30 // 30 RPM with Claude Code (conservative)
    };

    cachedAuthStatus = authStatus;
    lastAuthCheck = now;
    GEMINI_MODEL_CONFIG.authStatus = authStatus;

    return authStatus;
}

/**
 * Check if a model supports OAuth
 */
export function supportsOAuth(modelName: string): boolean {
    return GEMINI_MODEL_CONFIG.oauthModels.includes(modelName) || modelName.includes('2.5');
}

/**
 * Check if a model requires API keys only
 */
export function requiresApiKey(modelName: string): boolean {
    return GEMINI_MODEL_CONFIG.apiKeyOnlyModels.includes(modelName) ||
           modelName.includes('embedding') ||
           modelName.includes('embed');
}

/**
 * Check if a model is a Claude Code model
 */
export function isClaudeCodeModel(modelName: string): boolean {
    return GEMINI_MODEL_CONFIG.claudeCodeModels.includes(modelName) || modelName.includes('claude');
}

/**
 * Get model configuration
 */
export function getModelConfig(modelName: string): ModelConfig | undefined {
    return GEMINI_MODEL_CONFIG.allModels[modelName];
}

/**
 * Get all available models
 */
export function getAllAvailableModels(): ModelConfig[] {
    return Object.values(GEMINI_MODEL_CONFIG.allModels);
}

/**
 * Get models by provider
 */
export function getModelsByProvider(provider: ModelProvider): ModelConfig[] {
    return Object.values(GEMINI_MODEL_CONFIG.allModels).filter(model => model.provider === provider);
}

/**
 * Get models by authentication method
 */
export function getModelsByAuth(authMethod: AuthMethod): ModelConfig[] {
    return Object.values(GEMINI_MODEL_CONFIG.allModels).filter(model => model.authMethod === authMethod);
}

/**
 * Resolve a short model name to its full model ID
 * @param modelName - Short name or full model ID
 * @returns Full model ID
 */
export function resolveModelName(modelName: string): string {
    // Check if it's a short name
    if (GEMINI_MODEL_CONFIG.modelShortNames[modelName]) {
        return GEMINI_MODEL_CONFIG.modelShortNames[modelName];
    }
    // Return as-is if it's already a full model ID
    return modelName;
}

/**
 * Get all available short names for models
 * @returns Array of short names
 */
export function getAvailableShortNames(): string[] {
    return Object.keys(GEMINI_MODEL_CONFIG.modelShortNames);
}

/**
 * Get all Claude model short names
 * @returns Array of Claude short names
 */
export function getClaudeShortNames(): string[] {
    return Object.keys(GEMINI_MODEL_CONFIG.modelShortNames).filter(name => name.startsWith('claude-'));
}

/**
 * Check if a model name is a valid short name
 * @param modelName - Model name to check
 * @returns True if it's a valid short name
 */
export function isValidShortName(modelName: string): boolean {
    return modelName in GEMINI_MODEL_CONFIG.modelShortNames;
}

/**
 * Get current model synchronously (for backward compatibility)
 */
export function getCurrentModel(useFallback: boolean = false): string {
    // Check OAuth availability synchronously by looking for credentials file
    try {
        const credPath = require('path').join(require('os').homedir(), ".gemini", "oauth_creds.json");
        require('fs').accessSync(credPath);
        // If OAuth is available, always prefer OAuth models
        if (!useFallback) {
            return GEMINI_MODEL_CONFIG.defaultModel; // gemini-2.5-pro (supports OAuth)
        } else {
            return "gemini-2.5-flash"; // OAuth fallback instead of API key fallback
        }
    } catch {
        // No OAuth available, use regular logic
        return useFallback ? GEMINI_MODEL_CONFIG.fallbackModel : GEMINI_MODEL_CONFIG.defaultModel;
    }
}

/**
 * Get current model with OAuth awareness (async version)
 */
export async function getCurrentModelAsync(useFallback: boolean = false): Promise<string> {
    const authStatus = await getAuthStatus();

    if (!useFallback && authStatus.hasOAuth && supportsOAuth(GEMINI_MODEL_CONFIG.defaultModel)) {
        return GEMINI_MODEL_CONFIG.defaultModel; // Use OAuth model
    }

    return useFallback ? GEMINI_MODEL_CONFIG.fallbackModel : GEMINI_MODEL_CONFIG.defaultModel;
}

export const getCurrentEmbeddingModel = (useFallback: boolean = false): string => {
    return useFallback ? GEMINI_MODEL_CONFIG.fallbackEmbeddingModel : GEMINI_MODEL_CONFIG.embeddingModel;
};

export const getCurrentEmbeddingDimensions = (useFallback: boolean = false): number => {
    return useFallback ? GEMINI_MODEL_CONFIG.fallbackEmbeddingDimensions : GEMINI_MODEL_CONFIG.embeddingDimensions;
};

export const shouldRetryWithFallback = (error: any): boolean => {
    if (!error) return false;
    const errorMessage = error.message || error.toString() || '';
    const statusCode = error.status || error.code || 0;

    return statusCode === 429 ||
           statusCode === 503 ||
           errorMessage.includes('quota') ||
           errorMessage.includes('overload') ||
           errorMessage.includes('rate limit');
};

/**
 * Should retry with OAuth if API key fails
 */
export async function shouldRetryWithOAuth(error: any, modelName: string): Promise<boolean> {
    if (!shouldRetryWithFallback(error)) return false;

    const authStatus = await getAuthStatus();
    return authStatus.hasOAuth && supportsOAuth(modelName);
}

/**
 * Get optimal model for specific tasks based on auth status
 */
export async function getOptimalModel(taskType: 'generation' | 'embedding' | 'analysis' | 'complex_reasoning'): Promise<string> {
    const authStatus = await getAuthStatus();

    switch (taskType) {
        case 'embedding':
            return getCurrentEmbeddingModel(); // Always use API key for embeddings
        case 'complex_reasoning':
            if (authStatus.hasClaudeCode) {
                return 'claude-opus-4-1-20250805'; // Best reasoning model
            }
            if (authStatus.hasOAuth) {
                return 'gemini-2.5-pro';
            }
            return getCurrentModel();
        case 'generation':
            if (authStatus.hasClaudeCode) {
                return 'claude-sonnet-4-20250514'; // Balanced Claude model
            }
            if (authStatus.hasOAuth) {
                return GEMINI_MODEL_CONFIG.defaultModel; // Use OAuth for better rate limits
            }
            return getCurrentModel();
        case 'analysis':
            if (authStatus.hasClaudeCode) {
                return 'claude-3-5-sonnet-20241022'; // Good for analysis
            }
            if (authStatus.hasOAuth) {
                return GEMINI_MODEL_CONFIG.defaultModel;
            }
            return getCurrentModel();
        default:
            return getCurrentModel();
    }
}

/**
 * Get authentication method info for a model
 */
export async function getModelAuthInfo(modelName: string): Promise<{
    method: AuthMethod;
    rateLimit: number;
    available: boolean;
    provider: ModelProvider;
    description?: string;
}> {
    const authStatus = await getAuthStatus();
    const modelConfig = getModelConfig(modelName);

    if (modelConfig) {
        let available = false;
        let rateLimit = modelConfig.rateLimit;

        switch (modelConfig.authMethod) {
            case 'subscription':
                available = authStatus.hasClaudeCode;
                break;
            case 'oauth':
                available = authStatus.hasOAuth;
                break;
            case 'api_key':
                available = authStatus.hasApiKeys;
                break;
            default:
                available = authStatus.hasApiKeys || authStatus.hasOAuth || authStatus.hasClaudeCode;
        }

        return {
            method: modelConfig.authMethod,
            rateLimit,
            available,
            provider: modelConfig.provider,
            description: modelConfig.description
        };
    }

    // Fallback for unknown models
    if (requiresApiKey(modelName)) {
        return {
            method: 'api_key',
            rateLimit: authStatus.apiKeyRateLimit,
            available: authStatus.hasApiKeys,
            provider: 'gemini'
        };
    }

    if (supportsOAuth(modelName) && authStatus.hasOAuth) {
        return {
            method: 'oauth',
            rateLimit: authStatus.oauthRateLimit,
            available: true,
            provider: 'gemini'
        };
    }

    return {
        method: 'api_key',
        rateLimit: authStatus.apiKeyRateLimit,
        available: authStatus.hasApiKeys,
        provider: 'gemini'
    };
}

// Backward compatibility exports (sync versions)
export const SUMMARIZATION_MODEL_NAME = getCurrentModel();
export const ENTITY_EXTRACTION_MODEL_NAME = getCurrentModel();
export const EMBEDDING_MODEL_NAME = getCurrentEmbeddingModel();
export const DEFAULT_ASK_MODEL_NAME = getCurrentModel();
export const REFINEMENT_MODEL_NAME = getCurrentModel();

// Setup instructions
export function getOAuthSetupInstructions(): string {
    return `
🚀 Enable OAuth for 6x Higher Rate Limits!

1. Install Gemini CLI:
   npm install -g @google/generative-ai

2. Authenticate:
   gemini auth

3. Benefits:
   • Gemini 2.5 models: 60 RPM (vs 10 RPM with API keys)
   • 1,000 requests/day limit
   • Free tier access

Note: Embedding models still require API keys.
`;
}

export function getClaudeCodeSetupInstructions(): string {
    return `
🤖 Enable Claude Code for Advanced Reasoning!

1. Install Claude Code CLI:
   Visit: https://docs.anthropic.com/en/docs/claude-code/setup

2. Authentication Options:
   • Subscription: claude auth (free with Claude Pro/Team)
   • API Key: export ANTHROPIC_API_KEY="your-key"

3. Benefits:
   • Claude Opus 4: Most capable reasoning
   • Claude Sonnet 4: Balanced performance
   • Claude Haiku 3.5: Fast responses
   • Advanced tool integration
   • Both free (subscription) and paid (API) options

4. Verify: claude --version
`;
}

export function getAllSetupInstructions(): string {
    return `
🔧 Complete AI Model Setup Guide

${getOAuthSetupInstructions()}
${getClaudeCodeSetupInstructions()}

💡 Recommendation:
1. Set up Claude Code for complex reasoning tasks
2. Set up Gemini OAuth for fast, frequent queries
3. Keep API keys as fallback

This gives you access to the best models for every use case!
`;
}
