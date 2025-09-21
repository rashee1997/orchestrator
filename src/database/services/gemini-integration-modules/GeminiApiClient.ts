import { GoogleGenAI, HarmCategory, HarmBlockThreshold, GenerationConfig, Content, Part } from "@google/genai";
import { OAuth2Client } from "google-auth-library";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { CrossPlatformOAuth, OAuthCredentials } from "../../../utils/CrossPlatformOAuth.js";

// Custom error for when Gemini API is not initialized
export class GeminiApiNotInitializedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "GeminiApiNotInitializedError";
    }
}

// Custom error for non-retryable API errors
export class GeminiApiError extends Error {
    public allKeysExhausted?: boolean;
    constructor(message: string, public status?: number) {
        super(message);
        this.name = "GeminiApiError";
    }
}

// OAuth2 Configuration (from kilocode implementation)
const OAUTH_CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const OAUTH_CLIENT_SECRET = "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";
const OAUTH_REDIRECT_URI = "http://localhost:45289";

// Code Assist API Configuration
const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const CODE_ASSIST_API_VERSION = "v1internal";

// OAuth credentials interface moved to CrossPlatformOAuth

export class GeminiApiClient {
    private genAI?: GoogleGenAI;
    private _apiKeys: string[] | null = null;
    private currentApiKeyIndex: number = 0;
    private readonly requestTimeout = 90000; // 90 seconds timeout for API calls
    private lastApiCallTime = 0;
    private readonly minApiCallInterval = 6000; // 6 seconds between calls for 10 RPM free tier
    private readonly maxRequestsPerMinute = 10; // Free tier limit
    private requestTimestamps: number[] = []; // Track request timestamps for rate limiting
    private keyRateLimits: Map<number, number[]> = new Map(); // Per-key rate limit tracking

    // OAuth authentication properties
    private authClient?: OAuth2Client;
    private credentials?: OAuthCredentials;
    private projectId?: string;
    private useOAuth: boolean = false;
    private oauthPath?: string;
    private crossPlatformOAuth: CrossPlatformOAuth;
    private readonly oauthMaxRequestsPerMinute = 60; // OAuth free tier limit
    private readonly oauthMinApiCallInterval = 1000; // 1 second between calls for 60 RPM

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
        maxOutputTokens: 65535,
    };
    constructor(genAIInstance?: GoogleGenAI, options?: { oauthPath?: string }) {
        console.log('[GeminiApiClient] Constructor called with genAIInstance:', !!genAIInstance);

        // Always initialize OAuth for 2.5 models regardless of genAI instance
        this.oauthPath = options?.oauthPath;
        this.crossPlatformOAuth = CrossPlatformOAuth.getInstance();
        this.initializeOAuth();

        if (genAIInstance) {
            this.genAI = genAIInstance;
            console.log('[GeminiApiClient] Using provided genAI instance + OAuth for 2.5 models');
        } else {
            console.log('[GeminiApiClient] No genAI instance provided, will use OAuth/API keys');
            // Keep API key support for embeddings and fallback
            if (this.apiKeys.length > 0) {
                this.genAI = new GoogleGenAI({ apiKey: this.apiKeys[this.currentApiKeyIndex] });
            }
        }

        // Try to load OAuth credentials immediately for all instances
        this.loadOAuthCredentials().then(() => {
            if (this.credentials) {
                this.useOAuth = true;
                console.log('[GeminiApiClient] OAuth credentials loaded successfully');
            }
        }).catch(() => {
            console.log('[GeminiApiClient] OAuth credentials not available, using API keys');
        });
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
                console.warn('[GeminiApiClient] Gemini API key(s) not found. OAuth will be used for supported models.');
            } else {
                console.log(`[GeminiApiClient] Loaded ${this._apiKeys.length} API key(s) for embeddings and fallback.`);
            }
        }
        return this._apiKeys;
    }

    public getGenAIInstance(): GoogleGenAI | undefined {
        return this.genAI;
    }

    public getOAuthStatus(): { available: boolean, credentialsPath: string, hasCredentials: boolean, platformInfo?: any } {
        const paths = this.crossPlatformOAuth.getCredentialPaths(this.oauthPath);
        const primaryPath = paths[0];

        return {
            available: !!this.authClient,
            credentialsPath: primaryPath,
            hasCredentials: !!this.credentials,
            platformInfo: this.crossPlatformOAuth.getDebugInfo()
        };
    }

    public static getOAuthSetupInstructions(): string {
        const crossPlatformOAuth = CrossPlatformOAuth.getInstance();
        return crossPlatformOAuth.getSetupInstructions();
    }

    /**
     * Check if a specific API key has available quota for requests
     */
    private canMakeRequestWithKey(keyIndex: number): boolean {
        const now = Date.now();
        const oneMinuteAgo = now - 60000;
        
        if (!this.keyRateLimits.has(keyIndex)) {
            this.keyRateLimits.set(keyIndex, []);
        }
        
        const keyTimestamps = this.keyRateLimits.get(keyIndex)!;
        
        // Remove timestamps older than 1 minute
        const recentTimestamps = keyTimestamps.filter(timestamp => timestamp > oneMinuteAgo);
        this.keyRateLimits.set(keyIndex, recentTimestamps);
        
        return recentTimestamps.length < this.maxRequestsPerMinute;
    }
    
    /**
     * Record a request for rate limiting tracking
     */
    private recordRequest(keyIndex: number): void {
        const now = Date.now();
        if (!this.keyRateLimits.has(keyIndex)) {
            this.keyRateLimits.set(keyIndex, []);
        }
        this.keyRateLimits.get(keyIndex)!.push(now);
        this.lastApiCallTime = now;
    }
    
    /**
     * Calculate wait time until next request can be made
     */
    private calculateWaitTime(keyIndex: number): number {
        if (!this.keyRateLimits.has(keyIndex)) {
            return 0;
        }
        
        const keyTimestamps = this.keyRateLimits.get(keyIndex)!;
        const now = Date.now();
        const oneMinuteAgo = now - 60000;
        
        // Remove old timestamps
        const recentTimestamps = keyTimestamps.filter(timestamp => timestamp > oneMinuteAgo);
        
        if (recentTimestamps.length < this.maxRequestsPerMinute) {
            // Check minimum interval since last call
            const timeSinceLastCall = now - this.lastApiCallTime;
            return Math.max(0, this.minApiCallInterval - timeSinceLastCall);
        }
        
        // If at limit, wait until oldest timestamp is > 1 minute old
        const oldestTimestamp = Math.min(...recentTimestamps);
        return Math.max(this.minApiCallInterval, (oldestTimestamp + 60000) - now);
    }

    async askGemini(query: string, modelName: string, systemInstruction?: string, contextContent?: Part[], thinkingConfig?: { thinkingBudget?: number; thinkingMode?: 'AUTO' | 'MODE_THINK' }, toolConfig?: { tools?: any[] }): Promise<{ content: Part[], confidenceScore?: number, groundingMetadata?: any }> {
        // Always use API keys for embedding models
        if (this.isEmbeddingModel(modelName)) {
            console.log(`[GeminiApiClient] Using API key for embedding model: ${modelName}`);
            const results = await this.batchAskGemini([query], modelName, systemInstruction, contextContent, thinkingConfig, toolConfig);
            if (results.length > 0) {
                return results[0];
            }
            throw new Error("Failed to get response from Gemini embedding model.");
        }

        // Use OAuth for Flash 2.5 and Pro 2.5 models if OAuth is available
        else if (this.supportsOAuth(modelName) && this.authClient) {
            try {
                console.log(`[GeminiApiClient] Using OAuth for model: ${modelName}`);
                const result = await this.askGeminiWithOAuth(query, modelName, systemInstruction, contextContent, thinkingConfig, toolConfig);
                return result;
            } catch (error) {
                console.warn(`[GeminiApiClient] OAuth failed for ${modelName}, falling back to API key:`, error);
                // Fall through to API key method
            }
        }

        // Fallback to API key method for embeddings and other models
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
        const maxRetries = availableApiKeys.length * 3; // Allow more retries for free tier
        let lastError: any = null;
        let allKeysExhausted = false;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            // Find the best available key
            let selectedKeyIndex = -1;
            let minWaitTime = Infinity;
            
            // Check all keys to find one that can make requests
            for (let i = 0; i < availableApiKeys.length; i++) {
                const waitTime = this.calculateWaitTime(i);
                if (waitTime === 0) {
                    selectedKeyIndex = i;
                    break;
                } else if (waitTime < minWaitTime) {
                    minWaitTime = waitTime;
                    selectedKeyIndex = i;
                }
            }
            
            if (selectedKeyIndex === -1) {
                allKeysExhausted = true;
                break;
            }
            
            this.currentApiKeyIndex = selectedKeyIndex;
            const apiKey = availableApiKeys[this.currentApiKeyIndex];
            
            // Wait if necessary
            const waitTime = this.calculateWaitTime(this.currentApiKeyIndex);
            if (waitTime > 0) {
                console.log(`[GeminiApiClient] Rate limit: waiting ${waitTime}ms for key index ${this.currentApiKeyIndex}`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
            
            try {
                this.genAI = new GoogleGenAI({ apiKey });
                const batchContents: Content[] = this.buildBatchContents(batchQueries, systemInstruction, contextContent);

                const response = await this.performApiCall(batchContents, modelName, thinkingConfig, toolConfig);
                
                // Record successful request
                this.recordRequest(this.currentApiKeyIndex);
                
                return response;
            } catch (error: any) {
                lastError = error;
                const { shouldRetry, isRateLimit } = this.analyzeError(error);

                if (!shouldRetry) {
                    console.error(`[GeminiApiClient] Non-retryable error encountered on key index ${this.currentApiKeyIndex}. Error: ${error.message}`);
                    throw new GeminiApiError(error.message, error.status);
                }

                if (isRateLimit) {
                    // For rate limits, mark this key as temporarily exhausted
                    console.warn(`[GeminiApiClient] ⏱️ Rate limit hit on key index ${this.currentApiKeyIndex}. Error: ${error.message}`);
                    
                    // Add a penalty timestamp to this key
                    const now = Date.now();
                    if (!this.keyRateLimits.has(this.currentApiKeyIndex)) {
                        this.keyRateLimits.set(this.currentApiKeyIndex, []);
                    }
                    // Add several timestamps to effectively block this key for a while
                    const penalties = Array(this.maxRequestsPerMinute).fill(now);
                    this.keyRateLimits.get(this.currentApiKeyIndex)!.push(...penalties);
                }
                
                console.warn(`[GeminiApiClient] ❌ API call failed (Attempt ${attempt + 1}/${maxRetries}) on key ${this.currentApiKeyIndex}. Error: ${error.message}`);
            }
        }
        
        // Handle exhausted keys scenario
        if (allKeysExhausted) {
            console.error(`[GeminiApiClient] 🚫 All API keys exhausted due to rate limits. Consider adding more keys or implementing fallback model.`);
            
            // Try fallback model if available (could be a different provider)
            const fallbackError = new GeminiApiError(
                "All Gemini API keys exhausted. Rate limit exceeded on free tier. Consider upgrading to paid tier or adding more API keys.",
                429
            );
            fallbackError.allKeysExhausted = true;
            throw fallbackError;
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

        // Check for daily quota exhaustion - this should NOT retry and should trigger model fallback
        if (status === 429 && (message.includes('generativelanguage.googleapis.com/generate_content_free_tier_requests') ||
                               message.includes('quota exceeded for metric') ||
                               message.includes('free_tier'))) {
            console.log(`[GeminiApiClient] 🚫 Daily quota exhausted detected, should trigger model fallback`);
            return { shouldRetry: false, isRateLimit: false }; // Don't retry, let orchestrator handle model fallback
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

    // ===== OAuth Authentication Methods =====

    private initializeOAuth(): void {
        try {
            this.authClient = new OAuth2Client(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_REDIRECT_URI);
            console.log('[GeminiApiClient] OAuth2Client initialized successfully');
        } catch (error) {
            console.error('[GeminiApiClient] Failed to initialize OAuth2Client:', error);
        }
    }

    private async loadOAuthCredentials(): Promise<void> {
        try {
            const result = await this.crossPlatformOAuth.loadCredentials(this.oauthPath);

            if (result) {
                this.credentials = result.credentials;
                console.log(`[GeminiApiClient] OAuth credentials loaded from: ${result.path}`);

                if (this.credentials && this.authClient) {
                    this.authClient.setCredentials({
                        access_token: this.credentials.access_token,
                        refresh_token: this.credentials.refresh_token,
                        expiry_date: this.credentials.expiry_date,
                    });
                }
            } else {
                console.warn('[GeminiApiClient] No OAuth credentials found in any platform-specific path, will use API keys for all models');
                this.useOAuth = false;
            }
        } catch (error) {
            console.warn('[GeminiApiClient] OAuth credential loading failed, will use API keys for all models:', error);
            this.useOAuth = false;
        }
    }

    private async ensureOAuthAuthenticated(): Promise<void> {
        if (!this.authClient) {
            throw new Error('OAuth client not initialized. Please ensure OAuth setup is correct.');
        }

        if (!this.credentials) {
            await this.loadOAuthCredentials();
        }

        // Check if token needs refresh
        if (this.credentials && this.credentials.expiry_date < Date.now()) {
            try {
                const { credentials } = await this.authClient.refreshAccessToken();
                if (credentials.access_token) {
                    this.credentials = {
                        access_token: credentials.access_token!,
                        refresh_token: credentials.refresh_token || this.credentials.refresh_token,
                        token_type: credentials.token_type || "Bearer",
                        expiry_date: credentials.expiry_date || Date.now() + 3600 * 1000,
                    };
                    // Save refreshed credentials using cross-platform path
                    await this.crossPlatformOAuth.saveCredentials(this.credentials, this.oauthPath);
                }
            } catch (error) {
                console.error('[GeminiApiClient] OAuth token refresh failed:', error);
                this.useOAuth = false;
                throw new GeminiApiError('OAuth token refresh failed, falling back to API keys');
            }
        }
    }

    private async discoverProjectId(): Promise<string> {
        if (this.projectId) {
            return this.projectId;
        }

        // Try to get from environment
        this.projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GEMINI_PROJECT_ID;
        if (this.projectId) {
            return this.projectId;
        }

        try {
            // Call loadCodeAssist to discover project ID (simplified version)
            const loadRequest = {
                cloudaicompanionProject: "default",
                metadata: {
                    ideType: "IDE_UNSPECIFIED",
                    platform: "PLATFORM_UNSPECIFIED",
                    pluginType: "GEMINI",
                    duetProject: "default",
                },
            };

            const response = await this.authClient!.request({
                url: `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:loadCodeAssist`,
                method: "POST",
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify(loadRequest),
            });

            const responseData = response.data as any;
            this.projectId = responseData?.cloudaicompanionProject || "default";
            return this.projectId!;
        } catch (error) {
            console.warn('[GeminiApiClient] Project discovery failed, using default:', error);
            this.projectId = "default";
            return this.projectId;
        }
    }

    // Check if model supports OAuth (Flash 2.5 and Pro 2.5)
    private supportsOAuth(modelName: string): boolean {
        return modelName.includes('2.5') ||
               modelName.includes('gemini-2.5-flash') ||
               modelName.includes('gemini-2.5-pro');
    }

    // Check if this is an embedding model (always use API keys)
    private isEmbeddingModel(modelName: string): boolean {
        return modelName.includes('embedding') ||
               modelName.includes('embed') ||
               modelName.includes('text-embedding');
    }

    // OAuth-based API call using Code Assist API (following Kilocode pattern exactly)
    private async askGeminiWithOAuth(
        query: string,
        modelName: string,
        systemInstruction?: string,
        contextContent?: Part[],
        thinkingConfig?: { thinkingBudget?: number; thinkingMode?: 'AUTO' | 'MODE_THINK' },
        toolConfig?: { tools?: any[] }
    ): Promise<{ content: Part[], confidenceScore?: number, groundingMetadata?: any }> {
        // Always ensure authentication like Kilocode
        await this.ensureOAuthAuthenticated();
        const projectId = await this.discoverProjectId();

        // Build content like Kilocode - system instruction first, then content, then query
        const contents: any[] = [];

        if (systemInstruction) {
            contents.push({
                role: "user",
                parts: [{ text: systemInstruction }]
            });
        }

        // Add context content if provided
        if (contextContent?.length) {
            contextContent.forEach(content => {
                if (typeof content === 'object' && 'text' in content) {
                    contents.push({
                        role: "user",
                        parts: [{ text: content.text }]
                    });
                }
            });
        }

        // Add main query
        contents.push({
            role: "user",
            parts: [{ text: query }]
        });

        // Build request body exactly like Kilocode
        const requestBody: any = {
            model: modelName,
            project: projectId,
            request: {
                contents: contents,
                generationConfig: {
                    temperature: this.generationConfig.temperature ?? 0.7,
                    maxOutputTokens: this.generationConfig.maxOutputTokens ?? 8192,
                },
            },
        };

        // Add thinking config if provided (Kilocode pattern)
        if (thinkingConfig) {
            requestBody.request.generationConfig.thinkingConfig = thinkingConfig;
        }

        // Add tools if provided
        if (toolConfig?.tools) {
            requestBody.request.tools = toolConfig.tools;
        }

        try {
            // Debug authClient state
            if (!this.authClient) {
                throw new Error('OAuth2Client not initialized - this.authClient is undefined');
            }
            console.log('[GeminiApiClient] OAuth2Client state check passed, making API request');

            // Use authClient.request exactly like Kilocode
            const response = await this.authClient.request({
                url: `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:generateContent`,
                method: "POST",
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify(requestBody),
            });

            // Parse response like Kilocode
            const rawData = response.data as any;
            const responseData = rawData.response || rawData;

            if (responseData.candidates && responseData.candidates.length > 0) {
                const candidate = responseData.candidates[0];
                if (candidate.content && candidate.content.parts) {
                    const textParts = candidate.content.parts
                        .filter((part: any) => part.text && !part.thought)
                        .map((part: any) => ({ text: part.text }));

                    if (textParts.length > 0) {
                        return {
                            content: textParts,
                            confidenceScore: undefined,
                            groundingMetadata: candidate.groundingMetadata
                        };
                    }
                }
            }

            // Enhanced error handling for empty responses
            console.error('[GeminiApiClient] OAuth response structure:', {
                hasRawData: !!rawData,
                hasResponse: !!responseData,
                candidatesCount: responseData?.candidates?.length || 0,
                responseDataKeys: responseData ? Object.keys(responseData) : 'no responseData'
            });

            throw new GeminiApiError(`OAuth API returned empty or invalid response structure. Response data: ${JSON.stringify(rawData, null, 2)}`);
        } catch (error: any) {
            console.error('[GeminiApiClient] OAuth Code Assist API call failed:', error);

            // Handle different error types
            if (error.response) {
                console.error('[GeminiApiClient] Error Response Status:', error.response.status);
                console.error('[GeminiApiClient] Error Response Data:', error.response.data);

                if (error.response.status === 429) {
                    throw new GeminiApiError(`OAuth rate limit exceeded: ${error.message}`, 429);
                }
                if (error.response.status === 400) {
                    throw new GeminiApiError(`OAuth bad request: ${JSON.stringify(error.response.data) || error.message}`, 400);
                }
                throw new GeminiApiError(`OAuth API error: ${error.message}`, error.response.status);
            } else {
                // Network error or other non-HTTP error
                console.error('[GeminiApiClient] Non-HTTP error:', error.message || error);
                throw new GeminiApiError(`OAuth connection error: ${error.message || 'Unknown error'}`, 0);
            }
        }
    }

    // Public method to check if OAuth is working
    /**
     * Generate embeddings using Gemini embedding models
     * Always uses API key authentication for embedding models
     */
    public async generateEmbeddings(
        inputs: string[],
        modelName: string = 'models/gemini-embedding-001'
    ): Promise<{
        embeddings: Array<{ vector: number[], dimensions: number } | null>;
        model: string;
        totalTokensProcessed: number;
    }> {
        if (!this.genAI) {
            throw new GeminiApiNotInitializedError('GeminiApiClient must be initialized before generating embeddings');
        }

        if (!this.isEmbeddingModel(modelName)) {
            throw new GeminiApiError(`${modelName} is not an embedding model`);
        }

        console.log(`[GeminiApiClient] Generating embeddings for ${inputs.length} texts using ${modelName}`);

        try {
            // Always use API key for embedding models - extracted working logic from AIEmbeddingProvider.ts
            const genAIInstance = this.genAI;
            if (!genAIInstance) {
                throw new Error('Gemini API not initialized');
            }

            const contents = inputs.map(text => ({ role: "user", parts: [{ text }] }));
            const result = await genAIInstance.models.embedContent({
                model: modelName,
                contents
            });

            const embeddings = result.embeddings?.map(embedding => {
                if (!embedding.values) return null;
                return {
                    vector: embedding.values,
                    dimensions: embedding.values.length
                };
            }) || [];

            // Estimate tokens processed (rough approximation)
            const totalTokens = inputs.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);

            return {
                embeddings,
                model: modelName,
                totalTokensProcessed: totalTokens
            };

        } catch (error) {
            console.error('[GeminiApiClient] Embedding generation failed:', error);
            throw new GeminiApiError(`Failed to generate embeddings: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    public async testOAuthConnection(): Promise<boolean> {
        try {
            await this.ensureOAuthAuthenticated();
            await this.discoverProjectId();
            return true;
        } catch (error) {
            console.error('[GeminiApiClient] OAuth test failed:', error);
            return false;
        }
    }
}
