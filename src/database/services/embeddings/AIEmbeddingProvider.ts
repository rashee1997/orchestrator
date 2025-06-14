import { GeminiIntegrationService } from '../GeminiIntegrationService.js';
import { DEFAULT_EMBEDDING_MODEL } from '../../../constants/embedding_constants.js';

export class AIEmbeddingProvider {
    public geminiService: GeminiIntegrationService;

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

        const prompts = chunks.map(chunk => `You are an expert software engineer. Analyze the following code snippet and provide a very concise (2-5 words) and meaningful name that describes its primary purpose or functionality. The name should be suitable for an entity identifier and should not include any punctuation or special characters, only alphanumeric and underscores.
Code snippet (language: ${chunk.language || 'unknown'}):
\`\`\`${chunk.language || ''}
${chunk.codeChunk}
\`\`\`
Concise Name:`);

        try {
            const nameResults = await this.geminiService.batchAskGemini(prompts, this.geminiService.summarizationModelName);
            return nameResults.map(result => {
                let extractedName = result.content[0]?.text ?? '';
                extractedName = extractedName.replace(/[^a-zA-Z0-9\s]/g, '').trim();
                extractedName = extractedName.replace(/\s+/g, '_');
                return extractedName.length > 0 ? extractedName : 'anonymous_chunk';
            });
        } catch (error) {
            console.warn('Failed to generate meaningful entity names for a batch of chunks:', error);
            return new Array(chunks.length).fill('anonymous_chunk');
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
        const batchSize = 100; // This batching is for the embedding model specifically
        const maxRetries = 2;
        const delayBetweenBatches = 7000;


        for (let i = 0; i < texts.length; i += batchSize) {
            const batchTexts = texts.slice(i, i + batchSize);
            const contents = batchTexts.map(text => ({ role: "user", parts: [{ text }] }));
            const totalTokens = batchTexts.reduce((acc, text) => acc + text.length, 0);
            console.log(`[AIEmbeddingProvider] Processing embedding batch with ${batchTexts.length} texts and ${totalTokens} tokens.`);

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
                            console.error(`Max retries (${maxRetries}) reached for embedding batch starting at index ${i}. Skipping batch.`);
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

        const prompts = chunks.map(chunk => `You are an expert code analyst. Your task is to provide a concise, one-sentence summary in plain English explaining the purpose of the following code snippet.
Do not describe the code line-by-line. Focus on the high-level goal and functionality.

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
                summary = summary.replace(/[\r\n]+/g, ' ').replace(/`/g, '').trim();
                return summary;
            });
        } catch (error) {
            console.warn('Failed to generate code chunk summaries for a batch:', error);
            return new Array(chunks.length).fill('Could not generate summary.');
        }
    }
}
