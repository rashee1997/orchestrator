import { GoogleGenAI, HarmCategory, HarmBlockThreshold, GenerationConfig, Content, Part } from "@google/genai";

// Custom error for when Gemini API is not initialized
export class GeminiApiNotInitializedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "GeminiApiNotInitializedError";
    }
}

export class GeminiApiClient {
    private genAI?: GoogleGenAI;
    private _apiKeys: string[] | null = null;
    private currentApiKeyIndex: number = 0;

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
        maxOutputTokens: 8192,
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
                const geminiKeyName = `GEMINI_API_KEY${i > 1 ? i : ''}`;
                const googleKeyName = `GOOGLE_API_KEY${i > 1 ? i : ''}`;

                const geminiKey = process.env[geminiKeyName];
                const googleKey = process.env[googleKeyName];

                if (geminiKey) {
                    this._apiKeys.push(geminiKey as string);
                }
                if (googleKey) {
                    this._apiKeys.push(googleKey as string);
                }

                if (!geminiKey && !googleKey) {
                    break;
                }
                i++;
            }
            if (this._apiKeys.length === 0) {
                console.warn('Gemini API key(s) not found. GeminiApiClient will not be functional for direct API calls.');
            }
        }
        return this._apiKeys;
    }
    
    private checkApiInitialized() {
        if (!this.genAI) {
            throw new GeminiApiNotInitializedError("Gemini API not initialized. Ensure GEMINI_API_KEY is set.");
        }
    }
    
    public getGenAIInstance(): GoogleGenAI | undefined {
        return this.genAI;
    }

    async askGemini(query: string, modelName: string, systemInstruction?: string, contextContent?: Part[]): Promise<{ content: Part[], confidenceScore?: number }> {
        const results = await this.batchAskGemini([query], modelName, systemInstruction, contextContent);
        if (results.length > 0) {
            return results[0];
        }
        throw new Error("Failed to get response from Gemini.");
    }

    public async batchAskGemini(queries: string[], modelName: string, systemInstruction?: string, contextContent?: Part[]): Promise<Array<{ content: Part[], confidenceScore?: number }>> {
        if (queries.length === 0) return [];

        const availableApiKeys = this.apiKeys;
        if (availableApiKeys.length === 0) {
            throw new GeminiApiNotInitializedError("Gemini API key(s) not configured. Please set GEMINI_API_KEY environment variable(s).");
        }

        const batchSize = 10;
        const delayBetweenBatches = 7000;

        const allResults: Array<{ content: Part[], confidenceScore?: number }> = [];

        for (let i = 0; i < queries.length; i += batchSize) {
            const batchQueries = queries.slice(i, i + batchSize);
            let attempt = 0;
            const maxRetries = availableApiKeys.length;
            let success = false;
            let lastError: any = null;

            while (attempt < maxRetries && !success) {
                try {
                    this.genAI = new GoogleGenAI({ apiKey: availableApiKeys[this.currentApiKeyIndex] });
                    const genAIInstance = this.genAI;

                    const batchContents: Content[] = batchQueries.map(query => {
                        const parts: Part[] = [];
                        if (systemInstruction) {
                            parts.push({ text: systemInstruction });
                        }
                        if (contextContent && contextContent.length > 0) {
                            parts.push(...contextContent);
                        }
                        parts.push({ text: query });
                        return { role: "user", parts };
                    });

                    const batchResponses: Array<{ content: Part[], confidenceScore?: number }> = [];
                    for (const content of batchContents) {
                        const request: any = {
                            model: modelName,
                            contents: [content],
                            safetySettings: this.safetySettings,
                            generationConfig: this.generationConfig,
                        };
                        const result = await genAIInstance.models.generateContent(request);
                        let responseText = result.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
                        if (!responseText && typeof result.text === "string") {
                            responseText = result.text;
                        }
                        batchResponses.push({ content: [{ text: responseText }] });
                    }
                    allResults.push(...batchResponses);
                    success = true;

                } catch (error: any) {
                    lastError = error;
                    console.error(`Error calling Gemini API (${modelName}) for batch (API Key Index: ${this.currentApiKeyIndex}, batch start: ${i}):`, error);

                    if (error.response && error.response.status === 429 || (typeof error.message === 'string' && (error.message.includes('quota') || error.message.includes('rate limit')))) {
                        attempt++;
                        if (attempt < maxRetries) {
                            this.currentApiKeyIndex = (this.currentApiKeyIndex + 1) % availableApiKeys.length;
                            console.warn(`Received 429 Too Many Requests. Switching to next Gemini API key (index: ${this.currentApiKeyIndex}). Retrying batch...`);
                            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                        } else {
                            console.error(`Max retries (${maxRetries}) reached for batch starting at index ${i}. Skipping batch.`);
                            for (let j = 0; j < batchQueries.length; j++) {
                                allResults.push({ content: [{ text: "Error: Max retries reached for this query." }] });
                            }
                            success = true;
                        }
                    } else {
                        console.error(`Non-retryable error for batch starting at index ${i}:`, error);
                        for (let j = 0; j < batchQueries.length; j++) {
                            allResults.push({ content: [{ text: `Error: ${error.message}` }] });
                        }
                        success = true;
                    }
                }
            }
            if (!success) {
                for (let j = 0; j < batchQueries.length; j++) {
                    allResults.push({ content: [{ text: `Error: Failed after all retries. Last error: ${lastError ? lastError.message : 'Unknown'}` }] });
                }
            }

            if (i + batchSize < queries.length) {
                await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
            }
        }
        return allResults;
    }
}
