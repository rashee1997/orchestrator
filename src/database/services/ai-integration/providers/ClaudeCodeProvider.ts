/**
 * Claude Code Provider Implementation
 * Integrates with existing ClaudeCodeClient for CLI-based Claude models
 */

import { AIProvider, AIRequest, AIResponse, ProviderCapabilities, ProviderStatus } from './interfaces/AIProvider.js';
import { ModelProvider, AuthMethod } from '../AIApiConfig.js';
import { getModelInfo, isValidModel } from '../AIModelList.js';
import { ClaudeCodeClient } from '../../claude-code-integration/ClaudeCodeClient.js';

export class ClaudeCodeProvider extends AIProvider {
    private claudeCodeClient: ClaudeCodeClient;
    private isAvailable: boolean = false;

    constructor() {
        const capabilities: ProviderCapabilities = {
            supportsStreaming: true,
            supportsEmbedding: false,
            supportsCodeGeneration: true,
            supportsAnalysis: true,
            supportedAuthMethods: ['cli'],
            maxContextWindow: 200000,
            rateLimit: {
                requests: 30, // Claude Code CLI rate limit
                period: 'minute'
            }
        };

        super('claude_code', capabilities);

        // Initialize Claude Code client
        this.claudeCodeClient = new ClaudeCodeClient();
    }

    async initialize(): Promise<void> {
        console.log('[ClaudeCodeProvider] Initializing Claude Code CLI integration...');

        try {
            // Check if Claude Code CLI is available
            this.isAvailable = (await this.claudeCodeClient.testConnection()).available;

            if (this.isAvailable) {
                console.log('[ClaudeCodeProvider] Claude Code CLI detected and ready');
            } else {
                console.warn('[ClaudeCodeProvider] Claude Code CLI not available');
            }
        } catch (error) {
            console.error('[ClaudeCodeProvider] Failed to initialize:', error);
            this.isAvailable = false;
        }
    }

    async execute(request: AIRequest): Promise<AIResponse> {
        if (!this.isAvailable) {
            throw new Error('Claude Code CLI is not available. Please ensure Claude is installed and authenticated.');
        }

        const modelInfo = getModelInfo(request.model);
        if (!modelInfo || modelInfo.provider !== 'claude_code') {
            throw new Error(`Invalid Claude Code model: ${request.model}`);
        }

        console.log(`[ClaudeCodeProvider] Executing ${request.model} via Claude CLI`);

        try {
            // Use existing ClaudeCodeClient infrastructure
            const response = await this.claudeCodeClient.executeRequest({
                systemPrompt: request.systemInstruction || '',
                messages: [{
                    role: 'user',
                    content: request.query
                }],
                modelId: request.model,
                maxOutputTokens: request.maxTokens
            });

            // Convert to standardized AI response format
            return {
                content: [{ type: 'text', text: response.content ?? '' }],
                model: request.model,
                provider: 'claude_code',
                usage: response.usage ? {
                    inputTokens: response.usage.inputTokens,
                    outputTokens: response.usage.outputTokens,
                    totalTokens: response.usage.inputTokens + response.usage.outputTokens
                } : undefined,
                metadata: {
                    authMethod: 'cli',
                    rateLimit: modelInfo.rateLimit,
                    executionTime: response.executionTime,
                    subscription: response.isSubscriber
                },
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            console.error('[ClaudeCodeProvider] Request failed:', error);

            // Check for specific Claude Code errors
            if (error instanceof Error) {
                if (error.message.includes('authentication')) {
                    throw new Error('Claude Code authentication failed. Please run `claude auth` to authenticate.');
                } else if (error.message.includes('rate limit')) {
                    throw new Error('Claude Code rate limit exceeded. Please wait before retrying.');
                } else if (error.message.includes('not found')) {
                    throw new Error(`Claude Code model not found: ${request.model}. Please check model availability.`);
                }
            }

            throw error;
        }
    }

    async checkStatus(): Promise<ProviderStatus> {
        try {
            const connectionTest = await this.claudeCodeClient.testConnection();
            const isAvailable = connectionTest.available;

            return {
                available: isAvailable,
                authenticated: isAvailable, // If available, assume authenticated
                authMethod: 'cli',
                rateLimit: {
                    current: 0, // Would need rate limit tracking
                    limit: 30
                }
            };
        } catch (error) {
            return {
                available: false,
                authenticated: false,
                authMethod: 'cli',
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
            'claude-sonnet-4-20250514',
            'claude-opus-4-1-20250805',
            'claude-opus-4-20250514',
            'claude-3-7-sonnet-20250219',
            'claude-3-5-sonnet-20241022',
            'claude-3-5-haiku-20241022'
        ];
    }

    isModelSupported(modelName: string): boolean {
        const modelInfo = getModelInfo(modelName);
        return modelInfo !== null && modelInfo.provider === 'claude_code';
    }

    getPreferredAuthMethod(modelName: string): AuthMethod {
        // Claude Code always uses CLI
        return 'cli';
    }

    async cleanup(): Promise<void> {
        // Cleanup resources if needed
        console.log('[ClaudeCodeProvider] Cleanup completed');
    }

    /**
     * Get available Claude models from CLI
     */
    async getAvailableModels(): Promise<string[]> {
        if (!this.isAvailable) {
            return [];
        }

        // ClaudeCodeClient doesn't provide dynamic model listing, return static list
        return this.getSupportedModels();
    }

    /**
     * Check subscription status
     */
    async getSubscriptionStatus(): Promise<any> {
        if (!this.isAvailable) {
            throw new Error('Claude Code CLI not available');
        }

        // ClaudeCodeClient doesn't provide subscription status method, return static info
        return {
            isSubscriber: false,
            message: 'Subscription status not available via CLI'
        };
    }
}