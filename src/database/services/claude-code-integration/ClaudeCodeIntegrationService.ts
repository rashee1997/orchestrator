import { ClaudeCodeClient, ClaudeCodeOptions, ClaudeCodeResponse } from './ClaudeCodeClient.js';
import {
    ClaudeCodeModelId,
    claudeCodeDefaultModelId,
    getModelInfo,
    getOptimalClaudeModel,
    calculateCost,
    getClaudeCodeSetupInstructions,
    CLAUDE_CODE_CONFIG,
    isValidModel
} from './ClaudeCodeConfig.js';
import { CrossPlatformClaudeCode } from '../../../utils/CrossPlatformClaudeCode.js';

export interface ClaudeCodeTaskOptions {
    taskType?: 'simple' | 'medium' | 'complex';
    modelId?: ClaudeCodeModelId;
    maxOutputTokens?: number;
    useVertex?: boolean;
    timeout?: number;
}

export interface ClaudeCodeTaskResult extends ClaudeCodeResponse {
    modelUsed: ClaudeCodeModelId;
    costBreakdown: {
        inputCost: number;
        outputCost: number;
        totalCost: number;
        isSubscriber: boolean;
    };
    performance: {
        tokensPerSecond: number;
        executionTime: number;
    };
}

export class ClaudeCodeIntegrationService {
    private client: ClaudeCodeClient;
    private crossPlatformHelper: CrossPlatformClaudeCode;
    private isAvailable: boolean = false;
    private connectionStatus: {
        available: boolean;
        version?: string;
        error?: string;
        path?: string;
        platformInfo?: any;
    } | null = null;
    private initPromise: Promise<void>;

    constructor(claudePath?: string) {
        this.crossPlatformHelper = CrossPlatformClaudeCode.getInstance();
        this.client = new ClaudeCodeClient(claudePath);
        this.initPromise = this.initialize();
    }

    /**
     * Initialize and test Claude Code availability with cross-platform detection
     */
    private async initialize(): Promise<void> {
        try {
            this.connectionStatus = await this.client.testConnection();
            this.isAvailable = this.connectionStatus.available;

            if (this.isAvailable) {
                console.log(`[ClaudeCode] Available - Version: ${this.connectionStatus.version}`);
                console.log(`[ClaudeCode] Path: ${this.connectionStatus.path}`);
                if (this.connectionStatus.platformInfo) {
                    console.log(`[ClaudeCode] Platform: ${this.connectionStatus.platformInfo.platform}, Method: ${this.connectionStatus.platformInfo.installationMethod}`);
                }
            } else {
                console.warn(`[ClaudeCode] Not available: ${this.connectionStatus.error}`);

                // Use cross-platform setup instructions
                const setupInfo = await this.crossPlatformHelper.getSetupInfo();
                console.info('\n' + setupInfo.platformConfig.setupInstructions);
                console.info('\nRecommendations:');
                setupInfo.recommendations.forEach(rec => console.info(`  - ${rec}`));
            }
        } catch (error) {
            console.error('[ClaudeCode] Initialization failed:', error);
            this.isAvailable = false;
        }
    }

    /**
     * Wait for initialization to complete
     */
    async waitForInitialization(): Promise<void> {
        await this.initPromise;
    }

    /**
     * Check if Claude Code is available
     */
    isClaudeCodeAvailable(): boolean {
        return this.isAvailable;
    }

    /**
     * Get connection status
     */
    getConnectionStatus() {
        return this.connectionStatus;
    }

    /**
     * Execute a task using Claude Code
     */
    async executeTask(
        prompt: string,
        systemInstruction?: string,
        options: ClaudeCodeTaskOptions = {}
    ): Promise<ClaudeCodeTaskResult> {
        if (!this.isAvailable) {
            throw new Error('Claude Code CLI is not available. Please install and configure it first.');
        }

        const { taskType = 'medium', useVertex = false, timeout = CLAUDE_CODE_CONFIG.timeout } = options;

        // Select optimal model
        const modelId = options.modelId || getOptimalClaudeModel(taskType);

        if (!isValidModel(modelId)) {
            throw new Error(`Invalid Claude Code model: ${modelId}`);
        }

        const modelInfo = getModelInfo(modelId);

        // Prepare Claude Code options
        const claudeOptions: ClaudeCodeOptions = {
            systemPrompt: systemInstruction || 'You are a helpful AI assistant.',
            messages: [{ role: 'user', content: prompt }],
            modelId,
            maxOutputTokens: options.maxOutputTokens || modelInfo.maxTokens,
            useVertex
        };

        console.log(`[ClaudeCode] Executing ${taskType} task with model: ${modelId}`);

        const startTime = Date.now();
        const response = await this.client.executeRequest(claudeOptions);
        const executionTime = Date.now() - startTime;

        // Calculate performance metrics
        const totalTokens = response.usage.inputTokens + response.usage.outputTokens;
        const tokensPerSecond = totalTokens / (executionTime / 1000);

        // Calculate costs
        const costBreakdown = {
            inputCost: response.isSubscriber ? 0 : (response.usage.inputTokens / 1_000_000) * modelInfo.inputPrice,
            outputCost: response.isSubscriber ? 0 : (response.usage.outputTokens / 1_000_000) * modelInfo.outputPrice,
            totalCost: response.usage.totalCost || 0,
            isSubscriber: response.isSubscriber
        };

        console.log(
            `[ClaudeCode] Completed: ${response.usage.inputTokens} input + ${response.usage.outputTokens} output tokens, ` +
            `${tokensPerSecond.toFixed(1)} tokens/sec, ` +
            `${response.isSubscriber ? 'Free (Subscription)' : `$${costBreakdown.totalCost.toFixed(4)}`}`
        );

        return {
            ...response,
            modelUsed: modelId,
            costBreakdown,
            performance: {
                tokensPerSecond,
                executionTime
            }
        };
    }

    /**
     * Ask Claude Code a simple question (convenience method)
     */
    async askClaude(
        question: string,
        systemInstruction?: string,
        modelId?: ClaudeCodeModelId
    ): Promise<string> {
        const result = await this.executeTask(question, systemInstruction, {
            taskType: 'medium',
            modelId
        });
        return result.content;
    }

    /**
     * Get available models with their info
     */
    getAvailableModels(): Array<{ id: ClaudeCodeModelId; info: any; category: string }> {
        const models: Array<{ id: ClaudeCodeModelId; info: any; category: string }> = [];

        for (const [category, modelIds] of Object.entries(CLAUDE_CODE_CONFIG.categories)) {
            for (const modelId of modelIds) {
                models.push({
                    id: modelId,
                    info: getModelInfo(modelId),
                    category
                });
            }
        }

        return models;
    }

    /**
     * Get service status and statistics with cross-platform info
     */
    getStatus(): {
        available: boolean;
        version?: string;
        path?: string;
        platformInfo?: any;
        defaultModel: ClaudeCodeModelId;
        availableModels: number;
        authTypes: string[];
        setupInstructions?: string;
        crossPlatformInfo?: {
            platform: string;
            detectedPaths: number;
            recommendations: string[];
        };
    } {
        let crossPlatformInfo: any = undefined;

        if (!this.isAvailable) {
            const debugInfo = this.crossPlatformHelper.getDebugInfo();
            crossPlatformInfo = {
                platform: debugInfo.platform,
                detectedPaths: debugInfo.possiblePaths.length,
                recommendations: [`Primary recommendation: ${this.crossPlatformHelper.getPlatformConfig().installCommands[0]}`]
            };
        }

        return {
            available: this.isAvailable,
            version: this.connectionStatus?.version,
            path: this.connectionStatus?.path,
            platformInfo: this.connectionStatus?.platformInfo,
            defaultModel: claudeCodeDefaultModelId,
            availableModels: Object.keys(CLAUDE_CODE_CONFIG.categories).reduce(
                (total, category) => total + CLAUDE_CODE_CONFIG.categories[category as keyof typeof CLAUDE_CODE_CONFIG.categories].length,
                0
            ),
            authTypes: Object.values(CLAUDE_CODE_CONFIG.authTypes),
            setupInstructions: !this.isAvailable ? getClaudeCodeSetupInstructions() : undefined,
            crossPlatformInfo
        };
    }

    /**
     * Estimate cost for a task before execution
     */
    estimateCost(
        inputTokens: number,
        outputTokens: number,
        modelId: ClaudeCodeModelId = claudeCodeDefaultModelId,
        isSubscriber: boolean = false
    ): {
        inputCost: number;
        outputCost: number;
        totalCost: number;
        currency: string;
    } {
        const totalCost = calculateCost(modelId, inputTokens, outputTokens, isSubscriber);
        const modelInfo = getModelInfo(modelId);

        return {
            inputCost: isSubscriber ? 0 : (inputTokens / 1_000_000) * modelInfo.inputPrice,
            outputCost: isSubscriber ? 0 : (outputTokens / 1_000_000) * modelInfo.outputPrice,
            totalCost,
            currency: 'USD'
        };
    }

    /**
     * Test Claude Code with a simple query
     */
    async testClaudeCode(): Promise<{
        success: boolean;
        response?: string;
        modelUsed?: ClaudeCodeModelId;
        isSubscriber?: boolean;
        error?: string;
        executionTime?: number;
    }> {
        if (!this.isAvailable) {
            return {
                success: false,
                error: 'Claude Code CLI not available'
            };
        }

        try {
            const startTime = Date.now();
            const result = await this.executeTask(
                'Say hello and confirm you are Claude Code working correctly.',
                'You are Claude Code AI assistant. Respond briefly.',
                { taskType: 'simple' }
            );

            return {
                success: true,
                response: result.content,
                modelUsed: result.modelUsed,
                isSubscriber: result.isSubscriber,
                executionTime: Date.now() - startTime
            };
        } catch (error: any) {
            return {
                success: false,
                error: error.message
            };
        }
    }
}