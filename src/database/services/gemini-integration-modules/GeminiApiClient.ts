import { GoogleGenAI, HarmCategory, HarmBlockThreshold, GenerationConfig, Content, Part } from "@google/genai";

// Custom error for when Gemini API is not initialized
export class GeminiApiNotInitializedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "GeminiApiNotInitializedError";
    }
}

// Custom error for non-retryable API errors
export class GeminiApiError extends Error {
    constructor(message: string, public status?: number) {
        super(message);
        this.name = "GeminiApiError";
    }
}

export class GeminiApiClient {
    private genAI?: GoogleGenAI;
    private _apiKeys: string[] | null = null;
    private currentApiKeyIndex: number = 0;
    private readonly requestTimeout = 90000; // 90 seconds timeout for API calls

    private safetySettings = [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    ];
    private generationConfig: GenerationConfig = {
        temperature: 0.7,
        topK: 1,
        topP: 1,
        maxOutputTokens: 32768,
    };
    constructor(genAIInstance?: GoogleGenAI) {
        if (genAIInstance) {
            this.genAI = genAIInstance;
        } else {
            this.genAI = undefined;
        }
    }
    private get apiKeys(): string[] {
        if (this._apiKeys === null) {
            this._apiKeys = [];
            let i = 1;
            while (true) {
                const geminiKeyName = `GEMINI_API_KEY${i > 1 ? `_${i}` : ''}`;
                const googleKeyName = `GOOGLE_API_KEY${i > 1 ? `_${i}` : ''}`;
                const geminiKey = process.env[geminiKeyName];
                const googleKey = process.env[googleKeyName];
                if (geminiKey) {
                    this._apiKeys.push(geminiKey as string);
                }
                if (googleKey && geminiKey !== googleKey) { // Avoid duplicates if both are set to the same key
                    this._apiKeys.push(googleKey as string);
                }
                if (!geminiKey && !googleKey && i > 1) { // Stop if we checked for _2 and found nothing
                    break;
                }
                if (i > 20) break; // Safety break
                i++;
            }
            if (this._apiKeys.length === 0) {
                console.warn('Gemini API key(s) not found. GeminiApiClient will not be functional for direct API calls.');
            } else {
                console.log(`[GeminiApiClient] Loaded ${this._apiKeys.length} API key(s).`);
            }
        }
        return this._apiKeys;
    }

    public getGenAIInstance(): GoogleGenAI | undefined {
        return this.genAI;
    }

    async askGemini(query: string, modelName: string, systemInstruction?: string, contextContent?: Part[], thinkingConfig?: { thinkingBudget?: number; thinkingMode?: 'AUTO' | 'MODE_THINK' }, toolConfig?: { tools?: any[] }): Promise<{ content: Part[], confidenceScore?: number, groundingMetadata?: any }> {
        const results = await this.batchAskGemini([query], modelName, systemInstruction, contextContent, thinkingConfig, toolConfig);
        if (results.length > 0) {
            return results[0];
        }
        throw new Error("Failed to get response from Gemini.");
    }

    public async batchAskGemini(queries: string[], modelName: string, systemInstruction?: string, contextContent?: Part[], thinkingConfig?: { thinkingBudget?: number; thinkingMode?: 'AUTO' | 'MODE_THINK' }, toolConfig?: { tools?: any[] }): Promise<Array<{ content: Part[], confidenceScore?: number, groundingMetadata?: any }>> {
        if (queries.length === 0) return [];

        const availableApiKeys = this.apiKeys;
        if (availableApiKeys.length === 0) {
            throw new GeminiApiNotInitializedError("Gemini API key(s) not configured. Please set GEMINI_API_KEY or GOOGLE_API_KEY environment variable(s).");
        }

        const batchSize = 10;
        const allResults: Array<{ content: Part[], confidenceScore?: number, groundingMetadata?: any }> = [];

        for (let i = 0; i < queries.length; i += batchSize) {
            const batchQueries = queries.slice(i, i + batchSize);
            const batchResult = await this.executeBatchWithRetries(batchQueries, modelName, systemInstruction, contextContent, thinkingConfig, toolConfig);
            allResults.push(...batchResult);

            if (i + batchSize < queries.length) {
                await new Promise(resolve => setTimeout(resolve, 1000)); // 1s delay between batches
            }
        }
        return allResults;
    }

    private async executeBatchWithRetries(
        batchQueries: string[],
        modelName: string,
        systemInstruction?: string,
        contextContent?: Part[],
        thinkingConfig?: any,
        toolConfig?: any
    ): Promise<Array<{ content: Part[], confidenceScore?: number, groundingMetadata?: any }>> {
        const availableApiKeys = this.apiKeys;
        const maxRetries = availableApiKeys.length * 2; // Allow retrying on each key once
        let lastError: any = null;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            const apiKey = availableApiKeys[this.currentApiKeyIndex];
            try {
                this.genAI = new GoogleGenAI({ apiKey });
                const batchContents: Content[] = this.buildBatchContents(batchQueries, systemInstruction, contextContent);

                const response = await this.performApiCall(batchContents, modelName, thinkingConfig, toolConfig);
                return response;
            } catch (error: any) {
                lastError = error;
                const { shouldRetry, isRateLimit } = this.analyzeError(error);

                if (!shouldRetry) {
                    console.error(`[GeminiApiClient] Non-retryable error encountered on key index ${this.currentApiKeyIndex}. Error: ${error.message}`);
                    throw new GeminiApiError(error.message, error.status);
                }

                // On error, switch key and wait
                this.currentApiKeyIndex = (this.currentApiKeyIndex + 1) % availableApiKeys.length;
                const backoffTime = isRateLimit ? 5000 : 1000 * Math.pow(2, Math.floor(attempt / availableApiKeys.length));

                console.warn(`[GeminiApiClient] API call failed (Attempt ${attempt + 1}/${maxRetries}). Error: ${error.message}. Switching to key index ${this.currentApiKeyIndex}. Retrying in ${backoffTime}ms...`);
                await new Promise(resolve => setTimeout(resolve, backoffTime));
            }
        }

        throw lastError || new Error("Unknown error occurred during batch processing after all retries.");
    }

    private async performApiCall(
        batchContents: Content[],
        modelName: string,
        thinkingConfig: any,
        toolConfig: any
    ): Promise<Array<{ content: Part[], confidenceScore?: number, groundingMetadata?: any }>> {
        const genAIInstance = this.genAI;
        if (!genAIInstance) throw new GeminiApiNotInitializedError("genAI instance is not available.");

        const batchResponses: Array<{ content: Part[], confidenceScore?: number, groundingMetadata?: any }> = [];

        for (const content of batchContents) {
            const abortController = new AbortController();
            const timeoutId = setTimeout(() => abortController.abort(), this.requestTimeout);

            try {
                // Extract the actual query from the content parts
                const queryText = (content.parts || [])
                    .filter((part: Part) => typeof part === 'object' && 'text' in part && part.text)
                    .map((part: Part) => (part as { text: string }).text)
                    .join(' ')
                    .split('\n')
                    .pop() || 'Unknown query';

                const request: any = {
                    model: modelName,
                    contents: [content],
                    safetySettings: this.safetySettings,
                    generationConfig: this.generationConfig,
                    config: {},
                };

                if (thinkingConfig) request.config.thinkingConfig = thinkingConfig;
                if (toolConfig) request.config.tools = toolConfig.tools;
                if (Object.keys(request.config).length === 0) delete request.config;

                const result = await genAIInstance.models.generateContent({
                  ...request,
                  signal: abortController.signal
                });

                const responseText = result.candidates?.[0]?.content?.parts?.[0]?.text ?? (typeof result.text === "string" ? result.text : "");

                // Enhanced logging for search process
                const candidate = result.candidates?.[0];
                if (candidate) {
                    // Log if Google search was performed
                    if (toolConfig?.tools?.some((tool: any) => tool.googleSearch)) {
                        console.log(`[GeminiApiClient] 🔍 Google Search performed for query: "${queryText.substring(0, 100)}${queryText.length > 100 ? '...' : ''}"`);

                        // Log grounding metadata details
                        const groundingMetadata = candidate.groundingMetadata;
                        if (groundingMetadata) {
                            const chunks = groundingMetadata.groundingChunks || [];
                            console.log(`[GeminiApiClient] 📊 Search Results: ${chunks.length} grounding chunks found`);

                            // Log search sources
                            chunks.forEach((chunk: any, index: number) => {
                                if (chunk.web?.uri && chunk.web?.title) {
                                    console.log(`[GeminiApiClient]   ${index + 1}. ${chunk.web.title} (${chunk.web.uri})`);
                                }
                            });

                            // Log search metadata
                            if (groundingMetadata.searchEntryPoint) {
                                console.log(`[GeminiApiClient] 🔗 Search Entry Point: ${JSON.stringify(groundingMetadata.searchEntryPoint)}`);
                            }

                            if (groundingMetadata.webSearchQueries) {
                                console.log(`[GeminiApiClient] 🔍 Web Search Queries: ${JSON.stringify(groundingMetadata.webSearchQueries)}`);
                            }
                        } else {
                            console.log(`[GeminiApiClient] ⚠️  No grounding metadata found in response`);
                        }
                    }

                    // Log thinking process if available
                    const thinkingParts = candidate.content?.parts?.filter((part: any) => part.thought);
                    if (thinkingParts?.length) {
                        console.log(`[GeminiApiClient] 🤔 Thinking process captured (${thinkingParts.length} thinking parts)`);
                        thinkingParts.forEach((part: any, index: number) => {
                            console.log(`[GeminiApiClient]   Thought ${index + 1}: ${part.thought.substring(0, 200)}${part.thought.length > 200 ? '...' : ''}`);
                        });
                    }

                    // Log finish reason
                    if (candidate.finishReason) {
                        console.log(`[GeminiApiClient] 🏁 Response finished with reason: ${candidate.finishReason}`);
                    }

                    // Log usage metadata if available
                    if (result.usageMetadata) {
                        console.log(`[GeminiApiClient] 📈 Usage: ${result.usageMetadata.promptTokenCount || 0} prompt tokens, ${result.usageMetadata.candidatesTokenCount || 0} response tokens, ${result.usageMetadata.totalTokenCount || 0} total tokens`);
                    }
                }

                batchResponses.push({
                    content: [{ text: responseText }],
                    groundingMetadata: result.candidates?.[0]?.groundingMetadata
                });
            } finally {
                clearTimeout(timeoutId);
            }
        }
        return batchResponses;
    }

    private buildBatchContents(queries: string[], systemInstruction?: string, contextContent?: Part[]): Content[] {
        return queries.map(query => {
            const parts: Part[] = [];
            if (systemInstruction) parts.push({ text: systemInstruction });
            if (contextContent?.length) parts.push(...contextContent);
            parts.push({ text: query });
            return { role: "user", parts };
        });
    }

    private analyzeError(error: any): { shouldRetry: boolean, isRateLimit: boolean } {
        const message = (error.message || '').toLowerCase();
        const status = error.status || (error.cause as any)?.status;

        // Non-retryable client errors (4xx except 429)
        if (status && status >= 400 && status < 500 && status !== 429) {
            return { shouldRetry: false, isRateLimit: false };
        }

        const isRateLimit = status === 429 || message.includes('quota') || message.includes('rate limit');
        if (isRateLimit) {
            return { shouldRetry: true, isRateLimit: true };
        }

        // Retryable server errors (5xx) or network errors
        if (status && status >= 500) {
            return { shouldRetry: true, isRateLimit: false };
        }
        if (message.includes('fetch failed') || message.includes('timeout') || error.name === 'AbortError') {
            return { shouldRetry: true, isRateLimit: false };
        }

        // Default to not retrying for unknown errors
        return { shouldRetry: false, isRateLimit: false };
    }
}
