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

export type AuthMethod = 'api_key' | 'oauth' | 'hybrid';

export interface AuthStatus {
    hasApiKeys: boolean;
    hasOAuth: boolean;
    preferredAuth: AuthMethod;
    oauthRateLimit: number;
    apiKeyRateLimit: number;
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
}

export const GEMINI_MODEL_CONFIG: GeminiModelConfig = {
    defaultModel: "gemini-2.5-flash",
    fallbackModel: "gemini-2.5-flash-lite",
    embeddingModel: "models/gemini-embedding-001",
    fallbackEmbeddingModel: "models/text-embedding-004",
    embeddingDimensions: 3072,
    fallbackEmbeddingDimensions: 768,
    oauthModels: ["gemini-2.5-flash", "gemini-2.5-pro"], // OAuth supported models
    apiKeyOnlyModels: [
        "models/gemini-embedding-001",
        "models/text-embedding-004",
        "gemini-2.5-flash-lite",
        "gemini-2.0-flash-lite",
        "gemini-1.5-flash",
        "gemini-1.5-pro"
    ], // API key required models
    parallelEmbedding: {
        enabled: true,
        targetDimension: 3072,
        loadBalancing: 'intelligent', // Intelligent content-aware routing (was: 'round_robin')
        maxConcurrentRequests: 2, // Both Gemini and Mistral
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
 * Get current authentication status
 */
export async function getAuthStatus(): Promise<AuthStatus> {
    const now = Date.now();
    if (cachedAuthStatus && (now - lastAuthCheck) < AUTH_CACHE_DURATION) {
        return cachedAuthStatus;
    }

    const hasApiKeys = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
    const hasOAuth = await checkOAuthAvailability();

    const authStatus: AuthStatus = {
        hasApiKeys,
        hasOAuth,
        preferredAuth: hasOAuth ? 'oauth' : (hasApiKeys ? 'api_key' : 'hybrid'),
        oauthRateLimit: 60, // 60 RPM with OAuth
        apiKeyRateLimit: 10 // 10 RPM with API keys
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
 * Get current model synchronously (for backward compatibility)
 */
export function getCurrentModel(useFallback: boolean = false): string {
    return useFallback ? GEMINI_MODEL_CONFIG.fallbackModel : GEMINI_MODEL_CONFIG.defaultModel;
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
export async function getOptimalModel(taskType: 'generation' | 'embedding' | 'analysis'): Promise<string> {
    const authStatus = await getAuthStatus();

    switch (taskType) {
        case 'embedding':
            return getCurrentEmbeddingModel(); // Always use API key for embeddings
        case 'generation':
        case 'analysis':
            if (authStatus.hasOAuth) {
                return GEMINI_MODEL_CONFIG.defaultModel; // Use OAuth for better rate limits
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
}> {
    const authStatus = await getAuthStatus();

    if (requiresApiKey(modelName)) {
        return {
            method: 'api_key',
            rateLimit: authStatus.apiKeyRateLimit,
            available: authStatus.hasApiKeys
        };
    }

    if (supportsOAuth(modelName) && authStatus.hasOAuth) {
        return {
            method: 'oauth',
            rateLimit: authStatus.oauthRateLimit,
            available: true
        };
    }

    return {
        method: 'api_key',
        rateLimit: authStatus.apiKeyRateLimit,
        available: authStatus.hasApiKeys
    };
}

// Backward compatibility exports (sync versions)
export const SUMMARIZATION_MODEL_NAME = getCurrentModel();
export const ENTITY_EXTRACTION_MODEL_NAME = getCurrentModel();
export const EMBEDDING_MODEL_NAME = getCurrentEmbeddingModel();
export const DEFAULT_ASK_MODEL_NAME = getCurrentModel();
export const REFINEMENT_MODEL_NAME = getCurrentModel();

// OAuth setup instructions
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
