import { GeminiIntegrationService } from '../GeminiIntegrationService.js';
import { DEFAULT_EMBEDDING_MODEL } from '../../../constants/embedding_constants.js';

export class AIEmbeddingProvider {
    public geminiService: GeminiIntegrationService;
    private lastAiCallTimestamp: number = 0;

    constructor(geminiService: GeminiIntegrationService) {
        this.geminiService = geminiService;
    }

    private async waitForRateLimit(): Promise<void> {
        const now = Date.now();
        const timeSinceLastCall = now - this.lastAiCallTimestamp;
        const minimumDelay = 6000; // 6 seconds for 10 calls/minute

        if (timeSinceLastCall < minimumDelay) {
            const timeToWait = minimumDelay - timeSinceLastCall;
            console.log(`[AIEmbeddingProvider] Waiting ${timeToWait}ms to respect AI call rate limit.`);
            await new Promise(resolve => setTimeout(resolve, timeToWait));
        }
        this.lastAiCallTimestamp = Date.now();
    }

    public async generateMeaningfulEntityName(codeChunk: string, language: string | undefined): Promise<string> {
        if (!this.geminiService) {
            return 'anonymous_chunk';
        }
        await this.waitForRateLimit();
        try {
            const prompt = `You are an expert software engineer. Analyze the following code snippet and provide a very concise (2-5 words) and meaningful name that describes its primary purpose or functionality. The name should be suitable for an entity identifier and should not include any punctuation or special characters, only alphanumeric and underscores.
Code snippet (language: ${language || 'unknown'}):
\`\`\`${language || ''}
${codeChunk}
\`\`\`
Concise Name:`;

            const nameResult = await this.geminiService.askGemini(prompt, this.geminiService.summarizationModelName);
            let extractedName = nameResult.content[0].text ?? '';
            extractedName = extractedName.replace(/[^a-zA-Z0-9\s]/g, '').trim();
            extractedName = extractedName.replace(/\s+/g, '_');

            if (extractedName.length > 0) {
                return extractedName;
            }
            return 'anonymous_chunk';
        } catch (error) {
            console.warn('Failed to generate meaningful entity name for anonymous chunk:', error);
            return 'anonymous_chunk';
        }
    }

    /**
     * Generates embeddings for an array of text chunks.
     * @param texts An array of strings to embed.
     * @param modelName The name of the embedding model to use.
     * @returns A promise that resolves to an object containing the embeddings, request count, and retry count.
     */
    public async getEmbeddingsForChunks(texts: string[], modelName: string = DEFAULT_EMBEDDING_MODEL): Promise<{ embeddings: Array<{ vector: number[], dimensions: number } | null>, requestCount: number, retryCount: number }> {

        if (texts.length === 0) return { embeddings: [], requestCount: 0, retryCount: 0 };

        if (!this.geminiService) {
            throw new Error(`GeminiIntegrationService not available in AIEmbeddingProvider.`);
        }

        let totalRequests = 0;
        let totalRetries = 0;

        const genAIInstance = this.geminiService.getGenAIInstance();
        if (!genAIInstance) {
            throw new Error(`Gemini API not initialized in GeminiIntegrationService.`);
        }

        const results: Array<{ vector: number[], dimensions: number } | null> = [];
        const batchSize = 100;
        const maxRetries = 2;
        const delayBetweenBatches = 7000;


        for (let i = 0; i < texts.length; i += batchSize) {
            const batchTexts = texts.slice(i, i + batchSize);
            const contents = batchTexts.map(text => ({ role: "user", parts: [{ text }] }));
            const totalTokens = batchTexts.reduce((acc, text) => acc + text.length, 0);
            console.log(`[AIEmbeddingProvider] Processing batch with ${batchTexts.length} texts and ${totalTokens} tokens.`);

            let attempt = 0;
            let success = false;
            totalRequests++;
            while (attempt <= maxRetries && !success) {
                try {
                    const result = await genAIInstance.models.embedContent({ model: modelName, contents });
                    const embeddings = result.embeddings;

                    if (embeddings && embeddings.length === batchTexts.length) {
                        for (const embedding of embeddings) {
                            if (embedding.values) {
                                results.push({ vector: embedding.values, dimensions: embedding.values.length });
                            } else {
                                results.push(null);
                            }
                        }
                        success = true;
                    } else {
                        for (let j = 0; j < batchTexts.length; j++) {
                            results.push(null);
                        }
                        success = true;
                    }
                } catch (error: any) {
                    if (error?.message?.includes('429') || error?.message?.includes('Too Many Requests') || (error?.cause && error.cause.message && error.cause.message.includes('429'))) {
                        attempt++;
                        totalRetries++;
                        if (attempt <= maxRetries) {
                            const backoffTime = 6000 * attempt;
                            console.warn(`Received 429 Too Many Requests. Retry attempt ${attempt} after ${backoffTime}ms.`);
                            await new Promise(resolve => setTimeout(resolve, backoffTime));
                        } else {
                            console.error(`Max retries (${maxRetries}) reached for batch starting at index ${i}. Skipping batch.`);
                            for (let j = 0; j < batchTexts.length; j++) {
                                results.push(null);
                            }
                            success = true;
                        }
                    } else {
                        console.error(`Error embedding batch starting at index ${i}:`, error);
                        for (let j = 0; j < batchTexts.length; j++) {
                            results.push(null);
                        }
                        success = true;
                    }
                }
            }
            if (i + batchSize < texts.length) {
                 await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
            }
        }
        return { embeddings: results, requestCount: totalRequests, retryCount: totalRetries };
    }
}
