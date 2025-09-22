/**
 * AI Integration Service - Phase 2 (Simplified)
 * Basic multi-provider support with universal MultiModelOrchestrator
 * Keeps it simple while enabling AI orchestration across providers
 */

import { MultiModelOrchestrator, AITaskType } from './utils/MultiModelOrchestrator.js';
import { MemoryManager } from '../../memory_manager.js';
import { AI_API_CONFIG } from './AIApiConfig.js';
import { resolveModel, getProviderForModel } from './AIModelList.js';
import { AIResponse } from './providers/interfaces/AIProvider.js';
import { jsonRepairService } from './utils/JSONRepairService.js';

export interface SimpleAIConfig {
    defaultProvider?: 'gemini' | 'claude_code' | 'mistral' | 'qwen_code';
    defaultModel?: string;
    enableOrchestrator?: boolean;
}

/**
 * Simplified AI Integration Service for Phase 2
 * Focuses on MultiModelOrchestrator and basic provider routing
 */
export class AIIntegrationService {
    private orchestrator?: MultiModelOrchestrator;
    private memoryManager: MemoryManager;
    private config: SimpleAIConfig;
    private initialized = false;
    public providers: any = {}; // Placeholder for Phase 2

    constructor(memoryManager: MemoryManager, config: SimpleAIConfig = {}) {
        this.memoryManager = memoryManager;
        this.config = {
            defaultProvider: config.defaultProvider || AI_API_CONFIG.defaultProvider,
            defaultModel: config.defaultModel || AI_API_CONFIG.defaultModel,
            enableOrchestrator: config.enableOrchestrator ?? true
        };
    }

    /**
     * Initialize the service
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;

        console.log('[AIIntegrationService] Initializing Phase 2 service...');

        // Initialize JSON repair service
        jsonRepairService.initialize(this.memoryManager, this);
        console.log('[AIIntegrationService] JSON repair service initialized');

        // Initialize MultiModelOrchestrator if enabled
        if (this.config.enableOrchestrator) {
            this.orchestrator = new MultiModelOrchestrator(this.memoryManager, this);
            await this.orchestrator.waitForInitialization();
            console.log('[AIIntegrationService] MultiModelOrchestrator initialized');
        }

        this.initialized = true;
        console.log('[AIIntegrationService] Phase 2 initialization complete');
    }

    /**
     * Execute a task using the universal orchestrator
     */
    async executeTask(
        taskType: AITaskType,
        prompt: string,
        systemInstruction?: string,
        options?: any
    ): Promise<{ content: string; model: string; executionTime: number }> {
        if (!this.initialized) {
            throw new Error('AIIntegrationService not initialized');
        }

        if (!this.orchestrator) {
            throw new Error('MultiModelOrchestrator not enabled');
        }

        return await this.orchestrator.executeTask(taskType, prompt, systemInstruction, options);
    }

    /**
     * Basic AI query - routes to appropriate provider
     */
    async askAI(
        prompt: string,
        model?: string,
        systemInstruction?: string,
        options?: any
    ): Promise<AIResponse> {
        if (!this.initialized) {
            throw new Error('AIIntegrationService not initialized');
        }

        const selectedModel = model || this.config.defaultModel!;
        const resolvedModel = resolveModel(selectedModel);
        const provider = getProviderForModel(resolvedModel);

        if (!provider) {
            throw new Error(`No provider found for model: ${resolvedModel}`);
        }

        // Phase 2: Route to actual providers
        console.log(`[AIIntegrationService] Routing ${resolvedModel} to ${provider} provider`);

        // Check if this is an embedding task that needs special handling
        if (resolvedModel.includes('embedding') || resolvedModel.includes('text-embedding') || resolvedModel === 'codestral-embed') {
            return await this.executeEmbeddingTask(resolvedModel, prompt);
        }

        if (provider === 'gemini') {
            // Use GeminiIntegrationService directly
            const { GeminiIntegrationService } = await import('../GeminiIntegrationService.js');
            // We need a proper Gemini service instance, but for now use the orchestrator's gemini execution
            return await this.executeGeminiTask(resolvedModel, prompt, systemInstruction);
        } else if (provider === 'mistral') {
            return await this.executeMistralTask(resolvedModel, prompt, systemInstruction);
        } else if (provider === 'claude_code') {
            return await this.executeClaudeTask(resolvedModel, prompt, systemInstruction);
        } else if (provider === 'qwen_code') {
            return await this.executeQwenCodeTask(resolvedModel, prompt, systemInstruction);
        }

        throw new Error(`Provider ${provider} not implemented`);
    }

    /**
     * Get the orchestrator instance
     */
    getOrchestrator(): MultiModelOrchestrator | undefined {
        return this.orchestrator;
    }

    /**
     * Check if service is ready
     */
    isReady(): boolean {
        return this.initialized;
    }

    /**
     * Get configuration
     */
    getConfig(): SimpleAIConfig {
        return { ...this.config };
    }

    /**
     * Provider-specific methods for backward compatibility
     */
    async askGemini(
        prompt: string,
        model?: string,
        systemInstruction?: string,
        authMethod?: string
    ): Promise<AIResponse> {
        return await this.askAI(prompt, model || 'gemini-2.0-flash-exp', systemInstruction);
    }

    async askClaude(
        prompt: string,
        model?: string,
        systemInstruction?: string
    ): Promise<AIResponse> {
        return await this.askAI(prompt, model || 'claude-3.5-sonnet', systemInstruction);
    }

    async askMistral(
        prompt: string,
        model?: string,
        systemInstruction?: string
    ): Promise<AIResponse> {
        return await this.askAI(prompt, model || 'mistral-large', systemInstruction);
    }

    /**
     * Get provider for a model (for backward compatibility)
     */
    getProviderForModel(model: string): any {
        const resolvedModel = resolveModel(model);
        const provider = getProviderForModel(resolvedModel);
        return provider ? { name: provider, model: resolvedModel } : null;
    }

    /**
     * Get provider status (for backward compatibility)
     */
    getProviderStatus(provider: string): any {
        return {
            available: true,
            authenticated: true,
            error: null
        };
    }

    /**
     * Universal response processor with automatic JSON repair
     */
    private async processAIResponse(
        response: string,
        model: string,
        provider: string,
        originalPrompt?: string
    ): Promise<AIResponse> {
        let processedContent = response;

        // Detect if response contains JSON and attempt repair
        const jsonPatterns = [
            /```json\s*([\s\S]*?)\s*```/g,  // JSON code blocks
            /```\s*([\s\S]*?)\s*```/g,      // Generic code blocks that might be JSON
            /\{[\s\S]*\}/g,                 // JSON objects
            /\[[\s\S]*\]/g                  // JSON arrays
        ];

        let hasJsonContent = false;
        for (const pattern of jsonPatterns) {
            if (pattern.test(response)) {
                hasJsonContent = true;
                break;
            }
        }

        if (hasJsonContent) {
            console.log(`[AIIntegrationService] Detected JSON content in ${model} response, attempting repair...`);

            const repairResult = await jsonRepairService.parseJsonFromAiResponse(
                response,
                originalPrompt,
                `${model}-${Date.now()}`,
                true // Enable AI repair
            );

            if (repairResult.success) {
                // If JSON was successfully repaired, return it as properly formatted JSON
                processedContent = JSON.stringify(repairResult.data, null, 2);
                console.log(`[AIIntegrationService] ✅ JSON repaired successfully for ${model}`);
            } else {
                console.warn(`[AIIntegrationService] ⚠️ JSON repair failed for ${model}:`, repairResult.error);
                // Keep original response if repair fails
            }
        }

        return {
            content: [{ type: 'text', text: processedContent }],
            model,
            provider: provider as any,
            timestamp: new Date().toISOString(),
            metadata: {
                jsonRepaired: hasJsonContent,
                originalLength: response.length,
                processedLength: processedContent.length
            }
        };
    }

    /**
     * Execute embedding task using proper embedding providers
     */
    private async executeEmbeddingTask(
        model: string,
        prompt: string
    ): Promise<AIResponse> {
        try {
            if (model.includes('gemini') || model.includes('text-embedding')) {
                // Use GeminiProvider for Gemini embedding models
                const { GeminiProvider } = await import('./providers/GeminiProvider.js');
                const geminiProvider = new GeminiProvider();

                const embeddingRequest = {
                    inputs: [prompt],
                    model: model,
                    targetDimensions: 3072
                };

                const response = await geminiProvider.generateEmbeddings(embeddingRequest);

                return {
                    content: [{
                        type: 'text',
                        text: `Embedding generated successfully. Model: ${model}, Dimensions: ${response.embeddings[0]?.dimensions || 'unknown'}, Vector length: ${response.embeddings[0]?.vector?.length || 0}`
                    }],
                    model,
                    provider: 'gemini',
                    timestamp: new Date().toISOString(),
                    metadata: {
                        embeddingGenerated: true,
                        dimensions: response.embeddings[0]?.dimensions,
                        authMethod: response.metadata?.authMethod
                    }
                };
            } else if (model.includes('mistral') || model === 'codestral-embed') {
                // Use MistralProvider for Mistral embedding models
                const { MistralProvider } = await import('./providers/MistralProvider.js');
                const mistralProvider = new MistralProvider();

                const embeddingRequest = {
                    inputs: [prompt],
                    model: model,
                    targetDimensions: 3072
                };

                const response = await mistralProvider.generateEmbeddings(embeddingRequest);

                return {
                    content: [{
                        type: 'text',
                        text: `Embedding generated successfully. Model: ${model}, Dimensions: ${response.embeddings[0]?.dimensions || 'unknown'}, Vector length: ${response.embeddings[0]?.vector?.length || 0}`
                    }],
                    model,
                    provider: 'mistral',
                    timestamp: new Date().toISOString(),
                    metadata: {
                        embeddingGenerated: true,
                        dimensions: response.embeddings[0]?.dimensions,
                        authMethod: response.metadata?.authMethod
                    }
                };
            } else {
                throw new Error(`Unsupported embedding model: ${model}`);
            }
        } catch (error: any) {
            throw new Error(`Embedding task failed: ${error.message}`);
        }
    }

    /**
     * Execute Gemini task
     */
    private async executeGeminiTask(
        model: string,
        prompt: string,
        systemInstruction?: string
    ): Promise<AIResponse> {
        try {
            const { GoogleGenAI } = await import('@google/genai');
            const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

            if (!apiKey) {
                throw new Error('Gemini API key not found');
            }

            const genAI = new GoogleGenAI({ apiKey });

            // Build parts array like GeminiApiClient does
            const parts: any[] = [];
            if (systemInstruction) parts.push({ text: systemInstruction });
            parts.push({ text: prompt });

            const result = await genAI.models.generateContent({
                model,
                contents: [{ role: 'user', parts }]
            });

            const text = result.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated';
            return await this.processAIResponse(text, model, 'gemini', prompt);
        } catch (error: any) {
            throw new Error(`Gemini execution failed: ${error.message}`);
        }
    }

    /**
     * Execute Mistral task
     */
    private async executeMistralTask(
        model: string,
        prompt: string,
        systemInstruction?: string
    ): Promise<AIResponse> {
        try {
            const { Mistral } = await import('@mistralai/mistralai');
            const apiKey = process.env.MISTRAL_API_KEY;

            if (!apiKey) {
                throw new Error('Mistral API key not found');
            }

            const mistral = new Mistral({ apiKey });
            const messages: any[] = [];

            if (systemInstruction) {
                messages.push({ role: 'system', content: systemInstruction });
            }
            messages.push({ role: 'user', content: prompt });

            const result = await mistral.chat.complete({
                model,
                messages
            });

            const content = result.choices?.[0]?.message?.content;
            const text = typeof content === 'string' ? content : JSON.stringify(content) || 'No response generated';
            return await this.processAIResponse(text, model, 'mistral', prompt);
        } catch (error: any) {
            throw new Error(`Mistral execution failed: ${error.message}`);
        }
    }

    /**
     * Execute Claude Code task (following Kilocode pattern)
     */
    private async executeClaudeTask(
        model: string,
        prompt: string,
        systemInstruction?: string
    ): Promise<AIResponse> {
        try {
            const { execa } = await import('execa');

            // Build args array like Kilocode does
            const args = ['-p'];

            // Add system prompt if provided
            if (systemInstruction) {
                args.push('--system-prompt', systemInstruction);
            }

            // Add output format for better parsing
            args.push(
                '--verbose',
                '--output-format', 'stream-json',
                '--max-turns', '1'
            );

            // Add model if provided
            if (model) {
                args.push('--model', model);
            }

            console.log(`[AIIntegrationService] Executing Claude Code: ${model}`);

            // Execute with proper timeout and error handling
            const process = execa('claude', args, {
                stdin: 'pipe',
                stdout: 'pipe',
                stderr: 'pipe',
                timeout: 600000, // 10 minutes
                maxBuffer: 1024 * 1024 * 1000, // 1GB buffer
            });

            // Send the prompt via stdin
            process.stdin?.write(JSON.stringify([{ role: 'user', content: prompt }]));
            process.stdin?.end();

            const { stdout, stderr } = await process;

            if (stderr && !stderr.includes('Warning')) {
                console.warn(`[AIIntegrationService] Claude Code stderr: ${stderr}`);
            }

            // Parse the stream-json output to extract the response
            const text = this.parseClaudeCodeResponse(stdout) || 'No response generated';
            return await this.processAIResponse(text, model, 'claude_code', prompt);

        } catch (error: any) {
            console.error(`[AIIntegrationService] Claude Code execution failed:`, error.message);

            // Check for specific error types
            if (error.code === 'ENOENT' || error.message?.includes('ENOENT')) {
                console.warn('[AIIntegrationService] Claude Code CLI not found. Install from: https://docs.anthropic.com/en/docs/claude-code/setup');
            }

            if (error.message?.includes('rate limit') || error.message?.includes('quota')) {
                console.warn('[AIIntegrationService] Claude Code rate limit hit');
            }

            throw new Error(`Claude Code execution failed: ${error.message}`);
        }
    }

    /**
     * Parse Claude Code stream-json response
     */
    private parseClaudeCodeResponse(stdout: string): string {
        const lines = stdout.split('\n').filter(line => line.trim());
        let response = '';

        for (const line of lines) {
            try {
                const chunk = JSON.parse(line);

                if (chunk.type === 'assistant' && chunk.message) {
                    const content = chunk.message.content;
                    if (Array.isArray(content)) {
                        for (const part of content) {
                            if (part.type === 'text') {
                                response += part.text;
                            }
                        }
                    }
                }
            } catch (parseError) {
                // Ignore JSON parse errors, might be partial chunks
                continue;
            }
        }

        return response.trim();
    }

    /**
     * Execute QwenCode task
     */
    private async executeQwenCodeTask(
        model: string,
        prompt: string,
        systemInstruction?: string
    ): Promise<AIResponse> {
        try {
            const { QwenCodeProvider } = await import('./providers/QwenCodeProvider.js');
            const qwenProvider = new QwenCodeProvider();
            await qwenProvider.initialize();

            const response = await qwenProvider.execute({
                model,
                query: prompt,
                systemInstruction,
                maxTokens: 4000
            });

            return response;
        } catch (error: any) {
            throw new Error(`QwenCode execution failed: ${error.message}`);
        }
    }

    /**
     * Get provider instance for orchestrator
     */
    getProvider(providerName: string): any {
        // For Phase 2, return simplified provider access
        if (providerName === 'gemini') {
            return {
                execute: async (request: any) => this.executeGeminiTask(request.model, request.query, request.systemInstruction)
            };
        } else if (providerName === 'mistral') {
            return {
                execute: async (request: any) => this.executeMistralTask(request.model, request.query, request.systemInstruction)
            };
        } else if (providerName === 'claude_code') {
            return {
                execute: async (request: any) => this.executeClaudeTask(request.model, request.query, request.systemInstruction)
            };
        } else if (providerName === 'qwen_code') {
            return {
                execute: async (request: any) => this.executeQwenCodeTask(request.model, request.query, request.systemInstruction)
            };
        }
        return null;
    }

    /**
     * Cleanup resources
     */
    async cleanup(): Promise<void> {
        console.log('[AIIntegrationService] Phase 2 cleanup completed');
    }
}