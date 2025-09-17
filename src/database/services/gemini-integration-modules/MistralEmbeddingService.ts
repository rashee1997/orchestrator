import { Mistral } from '@mistralai/mistralai';

export interface MistralEmbeddingResult {
    embeddings: Array<{
        vector: number[],
        dimensions: number,
        model: string,
        provider: 'mistral'
    } | null>;
    totalTokensProcessed: number;
    model: string;
    actualDimensions: number;
}

export class MistralEmbeddingService {
    private client: Mistral;
    private model: string;
    private targetDimensions: number;

    constructor(model: string = "codestral-embed", targetDimensions: number = 3072) {
        const apiKey = process.env.MISTRAL_API_KEY;
        if (!apiKey) {
            throw new Error('MISTRAL_API_KEY environment variable is required');
        }
        this.client = new Mistral({ apiKey: apiKey });
        this.model = model;
        this.targetDimensions = targetDimensions;
    }

    async getEmbeddings(inputs: string[]): Promise<MistralEmbeddingResult> {
        console.log(`[MistralEmbeddingService] Generating embeddings for ${inputs.length} texts using ${this.model} (target: ${this.targetDimensions}D)`);

        const embeddingsBatchResponse = await this.client.embeddings.create({
            model: this.model,
            // Note: Codestral-embed naturally produces 1024D vectors.
            // We'll handle dimension scaling if needed to reach target 3072D
            inputs: inputs,
        });

        const embeddings = embeddingsBatchResponse.data?.map((item: any) => {
            if (!item.embedding) return null;

            let vector = item.embedding;
            const originalDimensions = vector.length;

            // If we need to scale up to target dimensions (e.g., from 1024 to 3072)
            if (originalDimensions < this.targetDimensions) {
                console.log(`[MistralEmbeddingService] Scaling vector from ${originalDimensions}D to ${this.targetDimensions}D`);
                vector = this.scaleVectorDimensions(vector, this.targetDimensions);
            } else if (originalDimensions > this.targetDimensions) {
                console.log(`[MistralEmbeddingService] Truncating vector from ${originalDimensions}D to ${this.targetDimensions}D`);
                vector = vector.slice(0, this.targetDimensions);
            }

            return {
                vector: vector,
                dimensions: vector.length,
                model: this.model,
                provider: 'mistral' as const
            };
        }) || [];

        // Estimate tokens processed (rough approximation)
        const totalTokens = inputs.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);

        const actualDimensions = embeddings[0]?.dimensions || 0;
        console.log(`[MistralEmbeddingService] Generated ${embeddings.length} embeddings with ${actualDimensions}D vectors`);

        return {
            embeddings,
            totalTokensProcessed: totalTokens,
            model: this.model,
            actualDimensions
        };
    }

    /**
     * Scale vector dimensions by repeating and interpolating values to reach target dimension
     */
    private scaleVectorDimensions(vector: number[], targetDim: number): number[] {
        if (vector.length === targetDim) return vector;
        if (vector.length > targetDim) return vector.slice(0, targetDim);

        const scaleFactor = targetDim / vector.length;
        const result = new Array(targetDim);

        for (let i = 0; i < targetDim; i++) {
            const sourceIndex = i / scaleFactor;
            const lowerIndex = Math.floor(sourceIndex);
            const upperIndex = Math.min(Math.ceil(sourceIndex), vector.length - 1);
            const weight = sourceIndex - lowerIndex;

            if (lowerIndex === upperIndex) {
                result[i] = vector[lowerIndex];
            } else {
                // Linear interpolation between adjacent values
                result[i] = vector[lowerIndex] * (1 - weight) + vector[upperIndex] * weight;
            }
        }

        // Normalize the scaled vector to maintain unit length if needed
        const magnitude = Math.sqrt(result.reduce((sum, val) => sum + val * val, 0));
        if (magnitude > 0) {
            for (let i = 0; i < result.length; i++) {
                result[i] = result[i] / magnitude;
            }
        }

        return result;
    }
}
