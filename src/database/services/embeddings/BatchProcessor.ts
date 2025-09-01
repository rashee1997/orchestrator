/**
 * Handles batching of texts for embedding requests, optimizing batch size and token count.
 */
export class BatchProcessor {
    private maxBatchSize: number;
    private maxTokensPerBatch: number;

    constructor(maxBatchSize: number = 100, maxTokensPerBatch: number = 20000) {
        this.maxBatchSize = maxBatchSize;
        this.maxTokensPerBatch = maxTokensPerBatch;
    }

    /**
     * Creates optimized batches of texts based on max batch size and token limits.
     * @param texts Array of texts to batch
     * @returns Array of batches with texts and their original indices
     */
    public createOptimizedBatches(texts: string[]): Array<{ texts: string[]; originalIndices: number[] }> {
        const batches: Array<{ texts: string[]; originalIndices: number[] }> = [];
        let currentBatch: string[] = [];
        let currentIndices: number[] = [];
        let currentTokenCount = 0;

        texts.forEach((text, index) => {
            const tokenCount = this.estimateTokens(text);

            if (
                currentBatch.length >= this.maxBatchSize ||
                (currentTokenCount + tokenCount > this.maxTokensPerBatch && currentBatch.length > 0)
            ) {
                batches.push({ texts: [...currentBatch], originalIndices: [...currentIndices] });
                currentBatch = [];
                currentIndices = [];
                currentTokenCount = 0;
            }

            currentBatch.push(text);
            currentIndices.push(index);
            currentTokenCount += tokenCount;
        });

        if (currentBatch.length > 0) {
            batches.push({ texts: currentBatch, originalIndices: currentIndices });
        }

        return batches;
    }

    /**
     * Estimates the number of tokens in a text.
     * @param text Input text
     * @returns Estimated token count
     */
    public estimateTokens(text: string): number {
        return Math.ceil(text.length / 4);
    }
}
