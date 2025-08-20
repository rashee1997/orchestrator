import { GeminiIntegrationService } from '../../database/services/GeminiIntegrationService.js';
import { MemoryManager } from '../../database/memory_manager.js';
import { RetrievedCodeContext } from '../../database/services/CodebaseContextRetrieverService.js';
import { RagPromptTemplates } from './rag_prompt_templates.js';
import { deduplicateContexts } from '../../utils/context_utils.js';

export interface DiverseQueryRewriterOptions {
    queryCount?: number;
}

export class DiverseQueryRewriterService {
    private geminiService: GeminiIntegrationService;
    private memoryManager: MemoryManager;

    constructor(geminiService: GeminiIntegrationService, memoryManager: MemoryManager) {
        this.geminiService = geminiService;
        this.memoryManager = memoryManager;
    }

    /**
     * Generates diverse queries, performs parallel retrievals, and aggregates results.
     * @param originalQuery The initial query from the user.
     * @param options Configuration for query rewriting (e.g., number of queries).
     * @returns A promise resolving to an array of unique RetrievedCodeContext objects.
     */
    async rewriteAndRetrieve(
        originalQuery: string,
        options: DiverseQueryRewriterOptions = {},
    ): Promise<RetrievedCodeContext[]> {
        const numQueries = options.queryCount || 3; // Default to 3 queries

        // 1. Generate the prompt for diverse queries
        const prompt = RagPromptTemplates.generateDiverseQueriesPrompt(originalQuery, numQueries);

        // 2. Use GeminiIntegrationService to get diverse queries from LLM
        let generatedQueries: string[] = [];
        try {
            const llmResponse = await this.geminiService.askGemini(prompt, 'gemini-2.5-flash');
            const responseText = llmResponse.content[0].text ?? '';

            // Extract JSON from markdown code block if present
            const jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/);
            const jsonString = jsonMatch ? jsonMatch[1] : responseText;
            generatedQueries = JSON.parse(jsonString);

            // Basic validation
            if (!Array.isArray(generatedQueries) || generatedQueries.some(q => typeof q !== 'string')) {
                console.warn('LLM returned malformed JSON for diverse queries. Falling back to original query.');
                generatedQueries = []; // Clear malformed queries
            }
        } catch (error) {
            console.error('Error generating diverse queries with LLM, falling back to original query:', error);
            // Fallback: Use original query if LLM call fails or parsing fails
            generatedQueries = [];
        }

        // Ensure the original query is always part of the set for retrieval
        if (!generatedQueries.includes(originalQuery)) {
            generatedQueries.unshift(originalQuery); // Add to the beginning to prioritize
        }
        if (generatedQueries.length === 0) {
            generatedQueries = [originalQuery]; // Should not happen if unshift works, but as a safeguard
        }

        console.log(`[DiverseQueryRewriter] Generated ${generatedQueries.length} queries:`, generatedQueries);

        // 3. Perform parallel retrievals for all generated queries
        const contextPromises = generatedQueries.map(query =>
            this.memoryManager.getCodebaseContextRetrieverService().retrieveContextForPrompt('dmqr-agent', query)
        );

        const allContextsArrays = await Promise.all(contextPromises);

        // 4. Aggregate and de-duplicate the RetrievedCodeContext
        const flatContexts = allContextsArrays.flat();
        const uniqueContexts = deduplicateContexts(flatContexts);

        console.log(`[DiverseQueryRewriter] Retrieved ${flatContexts.length} total contexts, ${uniqueContexts.length} unique contexts`);

        return uniqueContexts;
    }
}
