import { GeminiIntegrationService } from '../GeminiIntegrationService.js';
import { DEFAULT_EMBEDDING_MODEL } from '../../../constants/embedding_constants.js';

export class AIEmbeddingProvider {
    public geminiService: GeminiIntegrationService;
    private maxRetries: number = 3;
    private baseDelay: number = 1000; // 1 second base delay for retries
    private maxBatchSize: number = 100;
    private maxTokensPerBatch: number = 20000; // Conservative token limit per batch

    constructor(geminiService: GeminiIntegrationService) {
        this.geminiService = geminiService;
    }

    /**
     * Generates a meaningful entity name for a single code chunk using Gemini.
     * @param codeChunk The code snippet.
     * @param language The programming language.
     * @returns A promise that resolves to a meaningful name.
     */
    public async generateMeaningfulEntityName(codeChunk: string, language: string | undefined): Promise<string> {
        const results = await this.batchGenerateMeaningfulEntityNames([{ codeChunk, language }]);
        return results[0] || 'anonymous_chunk';
    }

    /**
     * Generates meaningful entity names for multiple code chunks in a batch.
     * @param chunks An array of objects, each with a codeChunk and language.
     * @returns A promise that resolves to an array of meaningful names.
     */
    public async batchGenerateMeaningfulEntityNames(
        chunks: Array<{ codeChunk: string; language: string | undefined }>
    ): Promise<string[]> {
        if (chunks.length === 0) return [];

        // Enhanced prompt with more specific instructions
        const prompts = chunks.map(chunk => `You are an expert software engineer. Analyze the following code snippet and provide a very concise (2-5 words) and meaningful name that describes its primary purpose or functionality. 
The name should be suitable for an entity identifier and should not include any punctuation or special characters, only alphanumeric and underscores.
Focus on the core functionality rather than implementation details.
Code snippet (language: ${chunk.language || 'unknown'}):
\`\`\`${chunk.language || ''}
${chunk.codeChunk}
\`\`\`
Concise Name:`);

        try {
            const nameResults = await this.geminiService.batchAskGemini(prompts, this.geminiService.summarizationModelName);
            return nameResults.map(result => {
                let extractedName = result.content[0]?.text ?? '';
                // Enhanced cleaning to ensure valid entity names
                extractedName = extractedName.replace(/[^a-zA-Z0-9\s_]/g, '').trim();
                extractedName = extractedName.replace(/\s+/g, '_');
                extractedName = extractedName.replace(/^_+|_+$/g, ''); // Remove leading/trailing underscores
                return extractedName.length > 0 ? extractedName : 'anonymous_chunk';
            });
        } catch (error) {
            console.warn('Failed to generate meaningful entity names for a batch of chunks:', error);
            return new Array(chunks.length).fill('anonymous_chunk');
        }
    }

    /**
     * Generates embeddings for an array of text chunks with enhanced error handling and batching.
     * @param texts An array of strings to embed.
     * @param modelName The name of the embedding model to use.
     * @returns A promise that resolves to an object containing the embeddings, request count, and retry count.
     */
    public async getEmbeddingsForChunks(texts: string[], modelName: string = DEFAULT_EMBEDDING_MODEL): Promise<{ embeddings: Array<{ vector: number[], dimensions: number } | null>, requestCount: number, retryCount: number, totalTokensProcessed: number }> {
        if (texts.length === 0) return { embeddings: [], requestCount: 0, retryCount: 0, totalTokensProcessed: 0 };
        if (!this.geminiService) {
            throw new Error(`GeminiIntegrationService not available in AIEmbeddingProvider.`);
        }

        let totalRequests = 0;
        let totalRetries = 0;
        let totalTokensProcessed = 0;
        const genAIInstance = this.geminiService.getGenAIInstance();
        if (!genAIInstance) {
            throw new Error(`Gemini API not initialized in GeminiIntegrationService.`);
        }

        const results: Array<{ vector: number[], dimensions: number } | null> = [];

        // Dynamic batching based on content length
        const batches = this.createOptimizedBatches(texts);

        for (const batch of batches) {
            const contents = batch.map(text => ({ role: "user", parts: [{ text }] }));
            const totalTokens = batch.reduce((acc, text) => acc + Math.round(text.length / 4), 0);
            totalTokensProcessed += totalTokens;
            console.log(`[AIEmbeddingProvider] Processing embedding batch with ${batch.length} texts and an estimated ${totalTokens} tokens.`);

            let attempt = 0;
            let success = false;
            totalRequests++;

            while (attempt <= this.maxRetries && !success) {
                try {
                    const result = await genAIInstance.models.embedContent({ model: modelName, contents });
                    const embeddings = result.embeddings;

                    if (embeddings && embeddings.length === batch.length) {
                        for (const embedding of embeddings) {
                            if (embedding.values) {
                                results.push({ vector: embedding.values, dimensions: embedding.values.length });
                            } else {
                                results.push(null);
                            }
                        }
                        success = true;
                    } else {
                        for (let j = 0; j < batch.length; j++) {
                            results.push(null);
                        }
                        success = true;
                    }
                } catch (error: any) {
                    attempt++;

                    if (attempt <= this.maxRetries) {
                        const isRateLimitError = error?.message?.includes('429') ||
                            error?.message?.includes('Too Many Requests') ||
                            (error?.cause && error.cause.message && error.cause.message.includes('429'));

                        if (isRateLimitError) {
                            totalRetries++;
                            const backoffTime = this.baseDelay * Math.pow(2, attempt - 1); // Exponential backoff
                            console.warn(`Rate limit hit. Retry attempt ${attempt} after ${backoffTime}ms.`);
                            await new Promise(resolve => setTimeout(resolve, backoffTime));
                        } else {
                            console.error(`Error embedding batch:`, error);
                            // For non-rate limit errors, wait a bit before retrying
                            await new Promise(resolve => setTimeout(resolve, this.baseDelay));
                        }
                    } else {
                        console.error(`Max retries (${this.maxRetries}) reached for embedding batch. Skipping batch.`);
                        for (let j = 0; j < batch.length; j++) {
                            results.push(null);
                        }
                        success = true;
                    }
                }
            }

            // Add delay between batches to avoid rate limiting
            if (batches.indexOf(batch) < batches.length - 1) {
                await new Promise(resolve => setTimeout(resolve, this.baseDelay));
            }
        }

        return { embeddings: results, requestCount: totalRequests, retryCount: totalRetries, totalTokensProcessed };
    }

    /**
     * Creates optimized batches based on token count to maximize efficiency.
     * @param texts Array of texts to batch
     * @returns Array of batches
     */
    private createOptimizedBatches(texts: string[]): string[][] {
        const batches: string[][] = [];
        let currentBatch: string[] = [];
        let currentTokenCount = 0;

        for (const text of texts) {
            const tokenCount = text.length; // Simple approximation of tokens

            if (currentBatch.length >= this.maxBatchSize ||
                (currentTokenCount + tokenCount > this.maxTokensPerBatch && currentBatch.length > 0)) {
                batches.push(currentBatch);
                currentBatch = [];
                currentTokenCount = 0;
            }

            currentBatch.push(text);
            currentTokenCount += tokenCount;
        }

        if (currentBatch.length > 0) {
            batches.push(currentBatch);
        }

        return batches;
    }

    /**
     * Generates a concise, one-sentence summary for a single code chunk using Gemini.
     * @param codeChunk The string of code to summarize.
     * @param entityType The type of the entity (e.g., 'function', 'class').
     * @param language The programming language.
     * @returns A promise resolving to a plain-English summary.
     */
    public async summarizeCodeChunk(codeChunk: string, entityType: string, language: string): Promise<string> {
        const results = await this.batchSummarizeCodeChunks([{ codeChunk, entityType, language }]);
        return results[0] || 'Could not generate summary.';
    }

    /**
     * Generates concise, one-sentence summaries for multiple code chunks in a batch.
     * @param chunks An array of objects, each with codeChunk, entityType, and language.
     * @returns A promise resolving to an array of plain-English summaries.
     */
    public async batchSummarizeCodeChunks(
        chunks: Array<{ codeChunk: string; entityType: string; language: string }>
    ): Promise<string[]> {
        if (chunks.length === 0) return [];

        // Enhanced prompt with more specific instructions
        const prompts = chunks.map(chunk => `You are an expert code analyst. Your task is to provide a concise, one-sentence summary in plain English explaining the purpose of the following code snippet.
Focus on the high-level goal and functionality, not implementation details.
Language: ${chunk.language}
Entity Type: ${chunk.entityType}
Code Snippet:
\`\`\`${chunk.language}
${chunk.codeChunk}
\`\`\`
One-sentence summary:
`);

        try {
            const summaryResults = await this.geminiService.batchAskGemini(prompts, this.geminiService.summarizationModelName);
            return summaryResults.map(result => {
                let summary = result.content[0]?.text ?? 'Could not generate summary.';
                // Enhanced cleaning to ensure clean summaries
                summary = summary.replace(/[\r\n]+/g, ' ').replace(/`/g, '').trim();
                summary = summary.replace(/\s+/g, ' '); // Normalize whitespace
                return summary;
            });
        } catch (error) {
            console.warn('Failed to generate code chunk summaries for a batch:', error);
            return new Array(chunks.length).fill('Could not generate summary.');
        }
    }
}