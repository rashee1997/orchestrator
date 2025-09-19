/**
 * QwenCode Provider Implementation
 * Based on kilocode's QwenCode integration with OAuth authentication
 */

import { AIProvider, AIRequest, AIResponse, ProviderCapabilities, ProviderStatus } from './interfaces/AIProvider.js';
import { ModelProvider, AuthMethod } from '../AIApiConfig.js';
import { getModelInfo } from '../AIModelList.js';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

// QwenCode model configuration
export type QwenCodeModelId = "qwen3-coder-plus" | "qwen3-coder-flash";

export const qwenCodeDefaultModelId: QwenCodeModelId = "qwen3-coder-plus";

export const qwenCodeModels = {
    "qwen3-coder-plus": {
        maxTokens: 65536,
        contextWindow: 1000000,
        supportsImages: false,
        supportsPromptCache: false,
        inputPrice: 0,
        outputPrice: 0,
        description: "Qwen3 Coder Plus - High-performance coding model with 1M context window for large codebases",
    },
    "qwen3-coder-flash": {
        maxTokens: 65536,
        contextWindow: 1000000,
        supportsImages: false,
        supportsPromptCache: false,
        inputPrice: 0,
        outputPrice: 0,
        description: "Qwen3 Coder Flash - Fast coding model with 1M context window optimized for speed",
    },
} as const;

interface QwenCredentials {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expiry_date: number;
    resource_url?: string;
}

interface QwenMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

interface QwenChatRequest {
    model: string;
    messages: QwenMessage[];
    max_tokens?: number;
    temperature?: number;
    stream?: boolean;
}

interface QwenChatResponse {
    choices: Array<{
        message: {
            content: string;
            role: string;
        };
        finish_reason: string;
    }>;
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

export class QwenCodeProvider extends AIProvider {
    private credentials: QwenCredentials | null = null;
    private readonly oauthBaseUrl = 'https://chat.qwen.ai';
    private readonly oauthTokenEndpoint = 'https://chat.qwen.ai/api/v1/oauth2/token';
    private readonly oauthClientId = 'f0304373b74a44d2b584a3fb70ca9e56';
    private isAvailable: boolean = false;

    constructor() {
        const capabilities: ProviderCapabilities = {
            supportsStreaming: true,
            supportsEmbedding: false,
            supportsCodeGeneration: true,
            supportsAnalysis: true,
            supportedAuthMethods: ['oauth'],
            maxContextWindow: 1000000,
            rateLimit: {
                requests: 100,
                period: 'minute'
            }
        };

        super('qwen_code', capabilities);
    }

    async initialize(): Promise<void> {
        console.log('[QwenCodeProvider] Initializing QwenCode OAuth integration...');

        try {
            this.credentials = await this.loadCachedQwenCredentials();
            if (this.credentials && this.isTokenValid(this.credentials)) {
                this.isAvailable = true;
                console.log('[QwenCodeProvider] QwenCode OAuth ready');
            } else {
                console.warn('[QwenCodeProvider] QwenCode OAuth credentials not valid, authentication required');
                this.isAvailable = false;
            }
        } catch (error) {
            console.error('[QwenCodeProvider] Failed to initialize:', error);
            this.isAvailable = false;
        }
    }

    async execute(request: AIRequest): Promise<AIResponse> {
        if (!this.isAvailable) {
            throw new Error('QwenCode OAuth is not available. Please authenticate first.');
        }

        await this.ensureAuthenticated();

        const modelInfo = getModelInfo(request.model);
        if (!modelInfo || modelInfo.provider !== 'qwen_code') {
            throw new Error(`Invalid QwenCode model: ${request.model}`);
        }

        console.log(`[QwenCodeProvider] Executing ${request.model} via QwenCode API`);

        try {
            const messages: QwenMessage[] = [];

            if (request.systemInstruction) {
                messages.push({
                    role: 'system',
                    content: request.systemInstruction
                });
            }

            messages.push({
                role: 'user',
                content: request.query
            });

            const requestBody: QwenChatRequest = {
                model: request.model,
                messages,
                max_tokens: request.maxTokens || qwenCodeModels[request.model as QwenCodeModelId].maxTokens,
                temperature: 0.7,
                stream: false
            };

            const baseUrl = this.getBaseUrl(this.credentials!);
            const response = await fetch(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.credentials!.access_token}`,
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                if (response.status === 401) {
                    // Token expired, try to refresh
                    await this.refreshAccessToken();
                    return this.execute(request); // Retry once
                }
                throw new Error(`QwenCode API error: ${response.status} ${response.statusText}`);
            }

            const data: QwenChatResponse = await response.json();

            return {
                content: [{ type: 'text', text: data.choices[0]?.message?.content || '' }],
                model: request.model,
                provider: 'qwen_code',
                usage: {
                    inputTokens: data.usage.prompt_tokens,
                    outputTokens: data.usage.completion_tokens,
                    totalTokens: data.usage.total_tokens
                },
                metadata: {
                    authMethod: 'oauth',
                    rateLimit: modelInfo.rateLimit,
                    finishReason: data.choices[0]?.finish_reason
                },
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            console.error('[QwenCodeProvider] Request failed:', error);
            throw error;
        }
    }

    async checkStatus(): Promise<ProviderStatus> {
        try {
            await this.ensureAuthenticated();

            return {
                available: this.isAvailable,
                authenticated: this.isAvailable,
                authMethod: 'oauth',
                rateLimit: {
                    current: 0,
                    limit: 100
                }
            };
        } catch (error) {
            return {
                available: false,
                authenticated: false,
                authMethod: 'oauth',
                rateLimit: {
                    current: 0,
                    limit: 0
                },
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    getSupportedModels(): string[] {
        return Object.keys(qwenCodeModels);
    }

    isModelSupported(modelName: string): boolean {
        return modelName in qwenCodeModels;
    }

    getPreferredAuthMethod(modelName: string): AuthMethod {
        return 'oauth';
    }

    async cleanup(): Promise<void> {
        console.log('[QwenCodeProvider] Cleanup completed');
    }

    // OAuth Authentication Methods

    private async ensureAuthenticated(): Promise<void> {
        if (!this.credentials) {
            this.credentials = await this.loadCachedQwenCredentials();
        }

        if (!this.isTokenValid(this.credentials)) {
            this.credentials = await this.refreshAccessToken();
        }
    }

    private isTokenValid(credentials: QwenCredentials | null): boolean {
        if (!credentials) return false;
        if (!credentials.expiry_date) return false;
        const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes buffer like kilocode
        return Date.now() < credentials.expiry_date - TOKEN_REFRESH_BUFFER_MS;
    }

    private async loadCachedQwenCredentials(): Promise<QwenCredentials | null> {
        try {
            const credentialsPath = this.getCredentialsPath();
            const data = await fs.readFile(credentialsPath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            return null;
        }
    }

    private async saveCachedQwenCredentials(credentials: QwenCredentials): Promise<void> {
        const credentialsPath = this.getCredentialsPath();
        const credentialsDir = path.dirname(credentialsPath);

        await fs.mkdir(credentialsDir, { recursive: true });
        await fs.writeFile(credentialsPath, JSON.stringify(credentials, null, 2));
    }

    private getCredentialsPath(): string {
        // Use same path as kilocode: ~/.qwen/oauth_creds.json
        return path.join(os.homedir(), '.qwen', 'oauth_creds.json');
    }

    private async refreshAccessToken(): Promise<QwenCredentials> {
        if (!this.credentials?.refresh_token) {
            throw new Error('No refresh token available. Please re-authenticate.');
        }

        try {
            // Use exact same implementation as kilocode
            const bodyData = {
                grant_type: 'refresh_token',
                refresh_token: this.credentials.refresh_token,
                client_id: this.oauthClientId,
            };

            const response = await fetch(this.oauthTokenEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json',
                },
                body: this.objectToUrlEncoded(bodyData)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Token refresh failed: ${response.status} ${response.statusText}. Response: ${errorText}`);
            }

            const tokenData = await response.json();

            if (tokenData.error) {
                throw new Error(`Token refresh failed: ${tokenData.error} - ${tokenData.error_description}`);
            }

            const newCredentials: QwenCredentials = {
                ...this.credentials,
                access_token: tokenData.access_token,
                token_type: tokenData.token_type,
                refresh_token: tokenData.refresh_token || this.credentials.refresh_token,
                expiry_date: Date.now() + tokenData.expires_in * 1000,
            };

            await this.saveCachedQwenCredentials(newCredentials);
            this.isAvailable = true;

            return newCredentials;
        } catch (error) {
            console.error('[QwenCodeProvider] Token refresh failed:', error);
            throw error;
        }
    }

    private objectToUrlEncoded(data: Record<string, string>): string {
        return Object.keys(data)
            .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(data[key])}`)
            .join('&');
    }

    private getBaseUrl(creds: QwenCredentials): string {
        let baseUrl = creds.resource_url || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
        if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
            baseUrl = `https://${baseUrl}`;
        }
        return baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`;
    }

    /**
     * Get OAuth setup instructions
     */
    getOAuthSetupInstructions(): string {
        return `
🔧 QwenCode OAuth Setup Instructions:

1. Register Application:
   Visit: https://dashscope.console.aliyun.com/

2. Get OAuth Credentials:
   - Create new application
   - Note client_id and client_secret

3. Set Environment Variables:
   export QWEN_CLIENT_ID="your-client-id"
   export QWEN_CLIENT_SECRET="your-client-secret"

4. Authenticate:
   Run OAuth flow to get tokens

Benefits:
• 1M context window for large codebases
• High-performance coding capabilities
• Free usage for registered users
• Fast inference speeds
        `.trim();
    }
}