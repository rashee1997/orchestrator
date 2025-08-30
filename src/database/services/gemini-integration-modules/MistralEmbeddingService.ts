import { Mistral } from '@mistralai/mistralai';
export class MistralEmbeddingService {
    private client: Mistral;
    private model: string = "codestral-embed";

    constructor() {
        const apiKey = process.env.MISTRAL_API_KEY;
        if (!apiKey) {
            throw new Error('MISTRAL_API_KEY environment variable is required');
        }
        this.client = new Mistral({ apiKey: apiKey });
    }

    async getEmbeddings(inputs: string[]): Promise<{
        embeddings: Array<{ vector: number[], dimensions: number } | null>;
        totalTokensProcessed: number;
    }> {
        const embeddingsBatchResponse = await this.client.embeddings.create({
            model: this.model,
            outputDimension: 768,
            inputs: inputs,
        });

        const embeddings = embeddingsBatchResponse.data?.map((item: any) => {
            if (!item.embedding) return null;
            return {
                vector: item.embedding,
                dimensions: item.embedding.length
            };
        }) || [];

        // Estimate tokens processed (rough approximation)
        const totalTokens = inputs.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);

        return { embeddings, totalTokensProcessed: totalTokens };
    }
}
