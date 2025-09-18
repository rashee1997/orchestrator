import { MemoryManager } from '../../database/memory_manager.js';
import { GeminiIntegrationService } from '../../database/services/GeminiIntegrationService.js';
import { getCurrentModel } from '../../database/services/gemini-integration-modules/GeminiConfig.js';
import { GeminiApiClient } from '../../database/services/gemini-integration-modules/GeminiApiClient.js';
import { ClaudeCodeIntegrationService } from '../../database/services/claude-code-integration/ClaudeCodeIntegrationService.js';
import { Mistral } from '@mistralai/mistralai';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

/**
 * Task types that can be distributed across models
 */
export type RagTaskType = 
    | 'query_rewriting'          // Simple - Mistral
    | 'context_summarization'    // Simple - Mistral  
    | 'simple_analysis'          // Simple - Mistral
    | 'complex_analysis'         // Complex - Gemini
    | 'decision_making'          // Complex - Gemini
    | 'final_answer_generation'  // Complex - Gemini
    | 'reflection'               // Medium - Mistral/Gemini
    | 'planning'                 // Complex - Gemini
    | 'json_extraction';         // Simple - Mistral

/**
 * Model capability levels
 */
export type ModelCapability = 'simple' | 'medium' | 'complex';

/**
 * Available models and their capabilities
 */
export interface ModelInfo {
    name: string;
    provider: 'gemini' | 'mistral' | 'claude_code';
    capability: ModelCapability;
    costTier: 'free' | 'paid' | 'subscription';
    rateLimit: number; // requests per minute
    available: boolean;
    authMethod?: 'oauth' | 'api_key' | 'subscription'; // Track authentication method
    tier?: 'free_oauth' | 'free_api' | 'paid' | 'subscription'; // More specific tier info
}

/**
 * Task distribution rules
 */
export interface TaskDistributionRule {
    taskType: RagTaskType;
    preferredModel: string;
    fallbackModels: string[];
    maxContextLength: number;
    complexity: ModelCapability;
}

/**
 * Multi-model orchestrator for distributing RAG tasks efficiently
 */
export class MultiModelOrchestrator {
    private memoryManager: MemoryManager;
    private geminiService: GeminiIntegrationService;
    private mistralClient?: Mistral;
    private claudeCodeService?: ClaudeCodeIntegrationService;
    private availableModels: Map<string, ModelInfo> = new Map();
    private taskRules: Map<RagTaskType, TaskDistributionRule> = new Map();
    private taskCompletionStats: Map<string, { success: number; failure: number; avgTime: number }> = new Map();
    private geminiApiClient?: GeminiApiClient;
    private hasOAuthCredentials: boolean = false;
    private claudeCodeAvailable: boolean = false;
    private mistralAvailable: boolean = false;

    private initPromise?: Promise<void>;

    constructor(memoryManager: MemoryManager, geminiService: GeminiIntegrationService) {
        this.memoryManager = memoryManager;
        this.geminiService = geminiService;

        // Initialize GeminiApiClient to check OAuth availability
        this.geminiApiClient = new GeminiApiClient();

        // Initialize Claude Code service
        this.claudeCodeService = new ClaudeCodeIntegrationService();

        // Initialize models and rules (will be called async)
        this.initPromise = this.initialize();
    }

    /**
     * Static factory method to create a fully initialized MultiModelOrchestrator
     */
    static async create(memoryManager?: MemoryManager, geminiService?: GeminiIntegrationService): Promise<MultiModelOrchestrator> {
        // Create default dependencies if not provided
        const defaultMemoryManager = memoryManager || await MemoryManager.create();

        let defaultGeminiService = geminiService;
        if (!defaultGeminiService) {
            // Create GeminiIntegrationService with required dependencies
            const { DatabaseService } = await import('../../database/services/DatabaseService.js');
            const { ContextInformationManager } = await import('../../database/managers/ContextInformationManager.js');

            const dbService = new DatabaseService();
            const contextManager = new ContextInformationManager(dbService);
            defaultGeminiService = new GeminiIntegrationService(dbService, contextManager, defaultMemoryManager);
        }

        const orchestrator = new MultiModelOrchestrator(defaultMemoryManager, defaultGeminiService);
        await orchestrator.waitForInitialization();

        return orchestrator;
    }

    /**
     * Wait for initialization to complete
     */
    async waitForInitialization(): Promise<void> {
        if (this.initPromise) {
            await this.initPromise;
        }

        // Also wait for Claude Code service initialization
        if (this.claudeCodeService) {
            await this.claudeCodeService.waitForInitialization();
        }
    }

    /**
     * Async initialization method
     */
    private async initialize(): Promise<void> {
        await this.initializeModels();
        this.setupTaskDistributionRules();
    }

    /**
     * Check if OAuth credentials are available
     */
    private async checkOAuthAvailability(): Promise<boolean> {
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
     * Initialize available models based on environment configuration
     */
    private async initializeModels(): Promise<void> {
        // Check OAuth availability first
        this.hasOAuthCredentials = await this.checkOAuthAvailability();

        // Gemini models
        const geminiApiKeyAvailable = !!process.env.GEMINI_API_KEY || !!process.env.GOOGLE_API_KEY;
        const geminiAvailable = geminiApiKeyAvailable || this.hasOAuthCredentials;

        console.log(`[Multi-Model Orchestrator] Gemini availability: API Keys=${geminiApiKeyAvailable}, OAuth=${this.hasOAuthCredentials}`);
        this.availableModels.set('gemini-2.5-flash', {
            name: 'gemini-2.5-flash',
            provider: 'gemini',
            capability: 'complex',
            costTier: 'free',
            rateLimit: this.hasOAuthCredentials ? 60 : 10, // OAuth: 60 RPM, API Key: 10 RPM
            available: geminiAvailable,
            authMethod: this.hasOAuthCredentials ? 'oauth' : 'api_key',
            tier: this.hasOAuthCredentials ? 'free_oauth' : 'free_api'
        });

        this.availableModels.set('gemini-2.5-pro', {
            name: 'gemini-2.5-pro',
            provider: 'gemini',
            capability: 'complex',
            costTier: 'free',
            rateLimit: this.hasOAuthCredentials ? 60 : 5, // OAuth: 60 RPM, API Key: 5 RPM
            available: geminiAvailable,
            authMethod: this.hasOAuthCredentials ? 'oauth' : 'api_key',
            tier: this.hasOAuthCredentials ? 'free_oauth' : 'free_api'
        });

        // Older models - only available with API keys
        this.availableModels.set('gemini-2.5-flash-lite', {
            name: 'gemini-2.5-flash-lite',
            provider: 'gemini',
            capability: 'simple',
            costTier: 'free',
            rateLimit: 15, // Higher rate for low-latency simple tasks
            available: geminiApiKeyAvailable,
            authMethod: 'api_key',
            tier: 'free_api'
        });

        this.availableModels.set('gemini-2.0-flash-lite', {
            name: 'gemini-2.0-flash-lite',
            provider: 'gemini',
            capability: 'simple',
            costTier: 'free',
            rateLimit: 25, // Higher quota than 2.5-flash-lite
            available: geminiApiKeyAvailable,
            authMethod: 'api_key',
            tier: 'free_api'
        });

        // Add embedding models (always use API keys)
        this.availableModels.set('models/gemini-embedding-001', {
            name: 'models/gemini-embedding-001',
            provider: 'gemini',
            capability: 'simple',
            costTier: 'free',
            rateLimit: 10,
            available: geminiApiKeyAvailable,
            authMethod: 'api_key',
            tier: 'free_api'
        });

        // Mistral models
        this.mistralAvailable = !!process.env.MISTRAL_API_KEY;
        const mistralAvailable = this.mistralAvailable;
        if (mistralAvailable) {
            try {
                this.mistralClient = new Mistral({ apiKey: process.env.MISTRAL_API_KEY! });

                this.availableModels.set('mistral-medium-latest', {
                    name: 'mistral-medium-latest',
                    provider: 'mistral',
                    capability: 'complex',
                    costTier: 'paid',
                    rateLimit: 100, // Latest frontier-class multimodal model
                    available: true,
                    authMethod: 'api_key',
                    tier: 'paid'
                });

                console.log('[Multi-Model Orchestrator] Mistral integration enabled with 1 model');
            } catch (error) {
                console.warn('[Multi-Model Orchestrator] Failed to initialize Mistral client:', error);
            }
        } else {
            console.log('[Multi-Model Orchestrator] Mistral API key not found - Mistral models unavailable');
        }

        // Claude Code models
        this.claudeCodeAvailable = this.claudeCodeService?.isClaudeCodeAvailable() || false;
        const claudeCodeAvailable = this.claudeCodeAvailable;
        if (claudeCodeAvailable) {
            // Add Claude Code models
            this.availableModels.set('claude-sonnet-4-20250514', {
                name: 'claude-sonnet-4-20250514',
                provider: 'claude_code',
                capability: 'complex',
                costTier: 'subscription', // Free with subscription, paid with API
                rateLimit: 30, // Conservative estimate
                available: true,
                authMethod: 'subscription',
                tier: 'subscription'
            });

            this.availableModels.set('claude-opus-4-1-20250805', {
                name: 'claude-opus-4-1-20250805',
                provider: 'claude_code',
                capability: 'complex',
                costTier: 'subscription',
                rateLimit: 20, // More conservative for most powerful model
                available: true,
                authMethod: 'subscription',
                tier: 'subscription'
            });

            this.availableModels.set('claude-3-5-haiku-20241022', {
                name: 'claude-3-5-haiku-20241022',
                provider: 'claude_code',
                capability: 'simple',
                costTier: 'subscription',
                rateLimit: 60, // Faster model, higher rate limit
                available: true,
                authMethod: 'subscription',
                tier: 'subscription'
            });

            console.log('[Multi-Model Orchestrator] Claude Code integration enabled with 3 models');
        } else {
            console.log('[Multi-Model Orchestrator] Claude Code CLI not available - Claude models unavailable');
        }

        // Report authentication status
        console.log(`[Multi-Model Orchestrator] Authentication Status:`);
        console.log(`  📦 Mistral: ${mistralAvailable ? '✅ API Key' : '❌ No API Key'} (always requires API key)`);
        console.log(`  🤖 Gemini: ${geminiApiKeyAvailable ? '✅ API Key' : '❌ No API Key'} | ${this.hasOAuthCredentials ? '✅ OAuth' : '❌ No OAuth'}`);
        console.log(`  🎭 Claude Code: ${claudeCodeAvailable ? '✅ Available' : '❌ Not Available'} (subscription or API)`);

        if (this.hasOAuthCredentials) {
            console.log(`  🚀 OAuth Benefits: Gemini 2.5 models get 60 RPM (vs 10 RPM with API keys)`);
        } else if (geminiApiKeyAvailable) {
            console.log(`  💡 Tip: Enable OAuth for 6x higher Gemini rate limits (60 vs 10 RPM)`);
        }

        if (claudeCodeAvailable) {
            const claudeStatus = this.claudeCodeService!.getStatus();
            console.log(`  🎭 Claude Code: Version ${claudeStatus.version}, ${claudeStatus.availableModels} models available`);
        }

        console.log(`[Multi-Model Orchestrator] Available Models:`);
        Array.from(this.availableModels.entries())
            .filter(([_, model]) => model.available)
            .forEach(([name, model]) => {
                const authInfo = model.provider === 'mistral'
                    ? 'API Key Required'
                    : `${model.authMethod === 'oauth' ? 'OAuth' : 'API Key'} (can use both)`;
                console.log(`  ${name}: ${authInfo}, ${model.rateLimit} RPM`);
            });
    }

    /**
     * Setup task distribution rules based on complexity and model capabilities
     */
    private setupTaskDistributionRules(): void {
        // Simple tasks - prefer Claude Code Haiku for speed, then Mistral, then Gemini
        const simpleModelOrder = [];
        if (this.claudeCodeAvailable) simpleModelOrder.push('claude-3-5-haiku-20241022');
        if (this.mistralAvailable) simpleModelOrder.push('mistral-medium-latest');
        if (this.hasOAuthCredentials) {
            simpleModelOrder.push('gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash-lite');
        } else {
            simpleModelOrder.push('gemini-2.5-flash-lite', 'gemini-2.0-flash-lite', 'gemini-2.5-flash');
        }

        this.taskRules.set('query_rewriting', {
            taskType: 'query_rewriting',
            preferredModel: simpleModelOrder[0] || 'gemini-2.5-flash',
            fallbackModels: simpleModelOrder.slice(1),
            maxContextLength: 2000,
            complexity: 'simple'
        });

        this.taskRules.set('context_summarization', {
            taskType: 'context_summarization',
            preferredModel: simpleModelOrder[0] || 'gemini-2.5-flash',
            fallbackModels: simpleModelOrder.slice(1),
            maxContextLength: 4000,
            complexity: 'simple'
        });

        this.taskRules.set('simple_analysis', {
            taskType: 'simple_analysis',
            preferredModel: simpleModelOrder[0] || 'gemini-2.5-flash',
            fallbackModels: simpleModelOrder.slice(1),
            maxContextLength: 3000,
            complexity: 'simple'
        });

        this.taskRules.set('json_extraction', {
            taskType: 'json_extraction',
            preferredModel: simpleModelOrder[0] || 'gemini-2.5-flash',
            fallbackModels: simpleModelOrder.slice(1),
            maxContextLength: 2000,
            complexity: 'simple'
        });

        // Medium tasks - use Claude Code Sonnet or best available
        const mediumModelOrder = [];
        if (this.claudeCodeAvailable) mediumModelOrder.push('claude-sonnet-4-20250514');
        if (this.mistralAvailable) mediumModelOrder.push('mistral-medium-latest');
        if (this.hasOAuthCredentials) {
            mediumModelOrder.push('gemini-2.5-flash', 'gemini-2.5-pro');
        } else {
            mediumModelOrder.push('gemini-2.5-pro', 'gemini-2.5-flash');
        }

        this.taskRules.set('reflection', {
            taskType: 'reflection',
            preferredModel: mediumModelOrder[0] || 'gemini-2.5-flash',
            fallbackModels: mediumModelOrder.slice(1),
            maxContextLength: 6000,
            complexity: 'medium'
        });

        // Complex tasks - prefer Claude Code Opus/Sonnet for advanced reasoning
        const complexModelOrder = [];
        if (this.claudeCodeAvailable) {
            complexModelOrder.push('claude-opus-4-1-20250805', 'claude-sonnet-4-20250514');
        }
        if (this.hasOAuthCredentials) {
            complexModelOrder.push('gemini-2.5-flash', 'gemini-2.5-pro');
        } else {
            complexModelOrder.push('gemini-2.5-pro', 'gemini-2.5-flash');
        }
        if (this.mistralAvailable) complexModelOrder.push('mistral-medium-latest');

        this.taskRules.set('complex_analysis', {
            taskType: 'complex_analysis',
            preferredModel: complexModelOrder[0] || 'gemini-2.5-flash',
            fallbackModels: complexModelOrder.slice(1),
            maxContextLength: 8000,
            complexity: 'complex'
        });

        this.taskRules.set('decision_making', {
            taskType: 'decision_making',
            preferredModel: complexModelOrder[0] || 'gemini-2.5-flash',
            fallbackModels: complexModelOrder.slice(1),
            maxContextLength: 10000,
            complexity: 'complex'
        });

        this.taskRules.set('final_answer_generation', {
            taskType: 'final_answer_generation',
            preferredModel: complexModelOrder[0] || 'gemini-2.5-flash',
            fallbackModels: complexModelOrder.slice(1),
            maxContextLength: 15000,
            complexity: 'complex'
        });

        this.taskRules.set('planning', {
            taskType: 'planning',
            preferredModel: complexModelOrder[0] || 'gemini-2.5-flash',
            fallbackModels: complexModelOrder.slice(1),
            maxContextLength: 8000,
            complexity: 'complex'
        });

        console.log(`[Multi-Model Orchestrator] Configured ${this.taskRules.size} task distribution rules`);
    }

    /**
     * Select the best available model for a given task
     */
    private selectModelForTask(taskType: RagTaskType, contextLength: number = 0): string | null {
        const rule = this.taskRules.get(taskType);
        if (!rule) {
            console.warn(`[Multi-Model Orchestrator] No rule found for task type: ${taskType}`);
            return getCurrentModel(); // Fallback to default Gemini model
        }

        // Check if context exceeds maximum length
        if (contextLength > rule.maxContextLength) {
            console.log(`[Multi-Model Orchestrator] Context length ${contextLength} exceeds limit ${rule.maxContextLength} for ${taskType}, selecting high-capacity model`);
            // For large contexts, prefer models with higher capacity
            const highCapacityModels = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash-lite', 'mistral-medium-latest'];
            for (const modelName of highCapacityModels) {
                const model = this.availableModels.get(modelName);
                if (model?.available) {
                    return modelName;
                }
            }
        }

        // Try preferred model first
        const preferredModel = this.availableModels.get(rule.preferredModel);
        if (preferredModel?.available) {
            return rule.preferredModel;
        }

        // Try fallback models
        for (const fallbackModel of rule.fallbackModels) {
            const model = this.availableModels.get(fallbackModel);
            if (model?.available) {
                console.log(`[Multi-Model Orchestrator] Using fallback model ${fallbackModel} for ${taskType}`);
                return fallbackModel;
            }
        }

        console.warn(`[Multi-Model Orchestrator] No available models for task ${taskType}, using default`);
        return getCurrentModel(); // Ultimate fallback
    }

    /**
     * Execute a task using the appropriate model with intelligent fallback
     */
    async executeTask(
        taskType: RagTaskType,
        prompt: string,
        systemInstruction?: string,
        options: {
            maxRetries?: number;
            timeout?: number;
            contextLength?: number;
            tryAllModels?: boolean; // New option to try all available models
        } = {}
    ): Promise<{ content: string; model: string; executionTime: number }> {
        const startTime = Date.now();
        const { maxRetries = 3, timeout = 30000, contextLength = prompt.length, tryAllModels = false } = options;
        
        const rule = this.taskRules.get(taskType);
        if (!rule) {
            throw new Error(`No rule found for task type: ${taskType}`);
        }

        // Get ordered list of models to try (preferred + fallbacks)
        const modelsToTry = [rule.preferredModel, ...rule.fallbackModels]
            .filter(modelName => this.availableModels.get(modelName)?.available);

        if (modelsToTry.length === 0) {
            throw new Error(`No available models for task type: ${taskType}`);
        }

        console.log(`[Multi-Model Orchestrator] Executing ${taskType} task, models to try: [${modelsToTry.join(', ')}]`);

        let lastError: any;
        
        // Try each model in order
        for (const modelName of modelsToTry) {
            const modelInfo = this.availableModels.get(modelName);
            if (!modelInfo?.available) {
                console.log(`[Multi-Model Orchestrator] Skipping unavailable model: ${modelName}`);
                continue;
            }

            console.log(`[Multi-Model Orchestrator] Trying ${taskType} task using model: ${modelName}`);

            // For each model, try up to maxRetries times
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    let content: string;
                    
                    if (modelInfo.provider === 'mistral' && this.mistralClient) {
                        content = await this.executeMistralTask(modelName, prompt, systemInstruction, timeout);
                        console.log(`[Multi-Model Orchestrator] ✅ Success with Mistral model: ${modelName}`);
                    } else if (modelInfo.provider === 'gemini') {
                        content = await this.executeGeminiTask(modelName, prompt, systemInstruction, timeout);
                        console.log(`[Multi-Model Orchestrator] ✅ Success with Gemini model: ${modelName}`);
                    } else if (modelInfo.provider === 'claude_code' && this.claudeCodeService) {
                        content = await this.executeClaudeCodeTask(modelName, prompt, systemInstruction, timeout);
                        console.log(`[Multi-Model Orchestrator] ✅ Success with Claude Code model: ${modelName}`);
                    } else {
                        throw new Error(`Unsupported model provider: ${modelInfo.provider}`);
                    }

                    const executionTime = Date.now() - startTime;
                    
                    // Update success statistics
                    this.updateTaskStats(modelName, true, executionTime);
                    
                    return {
                        content,
                        model: modelName,
                        executionTime
                    };

                } catch (error: any) {
                    lastError = error;
                    console.warn(`[Multi-Model Orchestrator] Attempt ${attempt}/${maxRetries} failed for ${taskType} on ${modelName}:`, error.message);
                    
                    // Update failure statistics
                    this.updateTaskStats(modelName, false, Date.now() - startTime);
                    
                    // If this isn't the last attempt for this model, wait before retry
                    if (attempt < maxRetries) {
                        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                    }
                }
            }
            
            // If we failed all attempts with this model but have more models to try, continue
            console.warn(`[Multi-Model Orchestrator] Model ${modelName} failed after ${maxRetries} attempts, trying next model...`);
        }

        throw new Error(`Task ${taskType} failed on all available models. Last error: ${lastError?.message}`);
    }

    /**
     * Execute task using Mistral
     */
    private async executeMistralTask(
        model: string,
        prompt: string,
        systemInstruction?: string,
        timeout: number = 30000
    ): Promise<string> {
        if (!this.mistralClient) {
            throw new Error('Mistral client not initialized');
        }

        const messages: any[] = [];

        if (systemInstruction) {
            messages.push({ role: 'system', content: systemInstruction });
        }

        messages.push({ role: 'user', content: prompt });

        // Optimized timeout based on task complexity
        const optimizedTimeout = Math.min(timeout, 45000); // Max 45 seconds for Mistral
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), optimizedTimeout);

        try {
            const startTime = Date.now();
            const response = await this.mistralClient.chat.complete({
                model: model,
                messages: messages,
                maxTokens: 6000, // Increased for more comprehensive responses
                temperature: 0.2, // Slightly higher for better creativity while maintaining consistency
                topP: 0.9 // Add top-p for better response quality
            });

            const executionTime = Date.now() - startTime;
            console.log(`[Multi-Model Orchestrator] Mistral ${model} completed in ${executionTime}ms`);

            const content = response.choices?.[0]?.message?.content;
            return typeof content === 'string' ? content : JSON.stringify(content) || 'No response generated';
        } catch (error: any) {
            // Enhanced error handling for common Mistral issues
            if (error.name === 'AbortError') {
                throw new Error(`Mistral task timed out after ${optimizedTimeout}ms`);
            } else if (error.message?.includes('rate_limit')) {
                throw new Error(`Mistral rate limit exceeded: ${error.message}`);
            } else {
                throw new Error(`Mistral execution failed: ${error.message || error}`);
            }
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * Execute task using Gemini
     */
    private async executeGeminiTask(
        model: string,
        prompt: string,
        systemInstruction?: string,
        timeout: number = 30000
    ): Promise<string> {
        const response = await this.geminiService.askGemini(prompt, model, systemInstruction);
        return response.content[0]?.text || 'No response generated';
    }

    /**
     * Execute task using Claude Code
     */
    private async executeClaudeCodeTask(
        model: string,
        prompt: string,
        systemInstruction?: string,
        timeout: number = 30000
    ): Promise<string> {
        if (!this.claudeCodeService) {
            throw new Error('Claude Code service not initialized');
        }

        const taskComplexity = model.includes('haiku') ? 'simple' :
                              model.includes('sonnet') ? 'medium' : 'complex';

        const result = await this.claudeCodeService.executeTask(
            prompt,
            systemInstruction,
            {
                taskType: taskComplexity,
                modelId: model as any, // Type assertion for now
                timeout
            }
        );

        return result.content || 'No response generated';
    }

    /**
     * Update task execution statistics
     */
    private updateTaskStats(model: string, success: boolean, executionTime: number): void {
        const stats = this.taskCompletionStats.get(model) || { success: 0, failure: 0, avgTime: 0 };
        
        if (success) {
            stats.success++;
        } else {
            stats.failure++;
        }
        
        // Update average execution time
        const totalTasks = stats.success + stats.failure;
        stats.avgTime = ((stats.avgTime * (totalTasks - 1)) + executionTime) / totalTasks;
        
        this.taskCompletionStats.set(model, stats);
    }

    /**
     * Get model performance statistics
     */
    getModelStats(): { [model: string]: { success: number; failure: number; avgTime: number; successRate: number } } {
        const stats: any = {};
        
        for (const [model, data] of this.taskCompletionStats) {
            const total = data.success + data.failure;
            stats[model] = {
                ...data,
                successRate: total > 0 ? (data.success / total) : 0
            };
        }
        
        return stats;
    }

    /**
     * Check if any models are available
     */
    hasAvailableModels(): boolean {
        return Array.from(this.availableModels.values()).some(model => model.available);
    }

    /**
     * Get list of available models
     */
    getAvailableModels(): ModelInfo[] {
        return Array.from(this.availableModels.values()).filter(model => model.available);
    }

    /**
     * Get OAuth status and setup instructions
     */
    getOAuthStatus(): { hasOAuth: boolean; instructions?: string; benefits: string } {
        const benefits = this.hasOAuthCredentials
            ? "✅ OAuth enabled: 60 RPM for Gemini 2.5 models"
            : "⚡ Enable OAuth for 6x higher rate limits (60 vs 10 RPM)";

        return {
            hasOAuth: this.hasOAuthCredentials,
            instructions: this.hasOAuthCredentials ? undefined : GeminiApiClient.getOAuthSetupInstructions(),
            benefits
        };
    }

    /**
     * Get model information with authentication details
     */
    getModelDetails(): { [key: string]: ModelInfo & { isPreferred: boolean } } {
        const details: any = {};
        const preferredModels = new Set(Array.from(this.taskRules.values()).map(rule => rule.preferredModel));

        for (const [name, info] of this.availableModels) {
            if (info.available) {
                details[name] = {
                    ...info,
                    isPreferred: preferredModels.has(name)
                };
            }
        }

        return details;
    }

    /**
     * Test if a model supports OAuth (for debugging)
     */
    modelSupportsOAuth(modelName: string): boolean {
        return modelName.includes('2.5');
    }
}