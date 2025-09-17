import { MemoryManager } from '../../database/memory_manager.js';
import { GeminiIntegrationService } from '../../database/services/GeminiIntegrationService.js';
import { getCurrentModel } from '../../database/services/gemini-integration-modules/GeminiConfig.js';
import { Mistral } from '@mistralai/mistralai';

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
    provider: 'gemini' | 'mistral';
    capability: ModelCapability;
    costTier: 'free' | 'paid';
    rateLimit: number; // requests per minute
    available: boolean;
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
    private availableModels: Map<string, ModelInfo> = new Map();
    private taskRules: Map<RagTaskType, TaskDistributionRule> = new Map();
    private taskCompletionStats: Map<string, { success: number; failure: number; avgTime: number }> = new Map();

    constructor(memoryManager: MemoryManager, geminiService: GeminiIntegrationService) {
        this.memoryManager = memoryManager;
        this.geminiService = geminiService;
        
        this.initializeModels();
        this.setupTaskDistributionRules();
    }

    /**
     * Initialize available models based on environment configuration
     */
    private initializeModels(): void {
        // Gemini models
        const geminiAvailable = !!process.env.GEMINI_API_KEY || !!process.env.GOOGLE_API_KEY;
        this.availableModels.set('gemini-2.5-flash', {
            name: 'gemini-2.5-flash',
            provider: 'gemini',
            capability: 'complex',
            costTier: 'free',
            rateLimit: 10, // Higher quota in free tier
            available: geminiAvailable
        });

        this.availableModels.set('gemini-2.5-pro', {
            name: 'gemini-2.5-pro',
            provider: 'gemini',
            capability: 'complex',
            costTier: 'free',
            rateLimit: 5, // Lower quota than flash in free tier
            available: geminiAvailable
        });

        this.availableModels.set('gemini-2.5-flash-lite', {
            name: 'gemini-2.5-flash-lite',
            provider: 'gemini',
            capability: 'simple',
            costTier: 'free',
            rateLimit: 15, // Higher rate for low-latency simple tasks
            available: geminiAvailable
        });

        this.availableModels.set('gemini-2.0-flash-lite', {
            name: 'gemini-2.0-flash-lite',
            provider: 'gemini',
            capability: 'simple',
            costTier: 'free',
            rateLimit: 25, // Higher quota than 2.5-flash-lite
            available: geminiAvailable
        });

        // Mistral models
        const mistralAvailable = !!process.env.MISTRAL_API_KEY;
        if (mistralAvailable) {
            try {
                this.mistralClient = new Mistral({ apiKey: process.env.MISTRAL_API_KEY! });
                
                this.availableModels.set('mistral-medium-latest', {
                    name: 'mistral-medium-latest',
                    provider: 'mistral',
                    capability: 'complex',
                    costTier: 'paid',
                    rateLimit: 100, // Latest frontier-class multimodal model
                    available: true
                });

                console.log('[Multi-Model Orchestrator] Mistral integration enabled with 2 models');
            } catch (error) {
                console.warn('[Multi-Model Orchestrator] Failed to initialize Mistral client:', error);
            }
        } else {
            console.log('[Multi-Model Orchestrator] Mistral API key not found - Mistral models unavailable');
        }

        console.log(`[Multi-Model Orchestrator] Initialized with ${this.availableModels.size} models:`, 
            Array.from(this.availableModels.keys()));
    }

    /**
     * Setup task distribution rules based on complexity and model capabilities
     */
    private setupTaskDistributionRules(): void {
        // Simple tasks - use mistral-medium-latest (latest frontier-class model)
        this.taskRules.set('query_rewriting', {
            taskType: 'query_rewriting',
            preferredModel: 'mistral-medium-latest',
            fallbackModels: ['gemini-2.5-flash-lite', 'gemini-2.0-flash-lite', 'gemini-2.5-flash'],
            maxContextLength: 2000,
            complexity: 'simple'
        });

        this.taskRules.set('context_summarization', {
            taskType: 'context_summarization',
            preferredModel: 'mistral-medium-latest',
            fallbackModels: ['gemini-2.5-flash-lite', 'gemini-2.0-flash-lite', 'gemini-2.5-flash'],
            maxContextLength: 4000,
            complexity: 'simple'
        });

        this.taskRules.set('simple_analysis', {
            taskType: 'simple_analysis',
            preferredModel: 'mistral-medium-latest',
            fallbackModels: ['gemini-2.5-flash-lite', 'gemini-2.0-flash-lite', 'gemini-2.5-flash'],
            maxContextLength: 3000,
            complexity: 'simple'
        });

        this.taskRules.set('json_extraction', {
            taskType: 'json_extraction',
            preferredModel: 'mistral-medium-latest', // Latest frontier-class model excellent for structured output
            fallbackModels: ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash-lite'],
            maxContextLength: 2000,
            complexity: 'simple'
        });

        // Medium tasks - use mistral-medium-latest for quality analysis
        this.taskRules.set('reflection', {
            taskType: 'reflection',
            preferredModel: 'mistral-medium-latest',
            fallbackModels: ['gemini-2.5-flash', 'gemini-2.5-pro'],
            maxContextLength: 6000,
            complexity: 'medium'
        });

        // Complex tasks - prefer most capable models
        this.taskRules.set('complex_analysis', {
            taskType: 'complex_analysis',
            preferredModel: 'gemini-2.5-flash', // Best balance of performance and quota
            fallbackModels: ['gemini-2.5-pro', 'mistral-medium-latest'],
            maxContextLength: 8000,
            complexity: 'complex'
        });

        this.taskRules.set('decision_making', {
            taskType: 'decision_making',
            preferredModel: 'gemini-2.5-flash', // Use pro for critical decisions
            fallbackModels: ['gemini-2.5-pro', 'mistral-medium-latest'],
            maxContextLength: 10000,
            complexity: 'complex'
        });

        this.taskRules.set('final_answer_generation', {
            taskType: 'final_answer_generation',
            preferredModel: 'gemini-2.5-flash', // Flash has higher quota for final generation
            fallbackModels: ['gemini-2.5-pro', 'mistral-medium-latest'],
            maxContextLength: 15000,
            complexity: 'complex'
        });

        this.taskRules.set('planning', {
            taskType: 'planning',
            preferredModel: 'gemini-2.5-flash', // Use pro for complex planning
            fallbackModels: ['gemini-2.5-pro', 'mistral-medium-latest'],
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
}