import { GeminiIntegrationService } from '../../database/services/GeminiIntegrationService.js';
import { MemoryManager } from '../../database/memory_manager.js';
import { RetrievedCodeContext } from '../../database/services/CodebaseContextRetrieverService.js';
import { RAG_DIVERSE_QUERIES_PROMPT } from '../../database/services/gemini-integration-modules/GeminiPromptTemplates.js';
import { deduplicateContexts } from '../../utils/context_utils.js';

export interface DiverseQueryRewriterOptions {
    queryCount?: number;
}

export interface DiverseQueryResult {
    generatedQueries: string[];
    contexts: RetrievedCodeContext[];
}

export class DiverseQueryRewriterService {
    private geminiService: GeminiIntegrationService;
    private memoryManager: MemoryManager;

    constructor(geminiService: GeminiIntegrationService, memoryManager: MemoryManager) {
        this.geminiService = geminiService;
        this.memoryManager = memoryManager;
    }

    /**
     * Generates diverse queries. The retrieval step is now handled by the iterative orchestrator
     * to allow for deep searches on each generated query.
     * @param originalQuery The initial query from the user.
     * @param options Configuration for query rewriting (e.g., number of queries).
     * @returns A promise resolving to a DiverseQueryResult with generated queries and an empty contexts array.
     */
    async rewriteAndRetrieve(
        originalQuery: string,
        options: DiverseQueryRewriterOptions = {},
    ): Promise<DiverseQueryResult> {
        const numQueries = options.queryCount || 3; // Default to 3 queries

        // 1. Generate the prompt for diverse queries
        const prompt = RAG_DIVERSE_QUERIES_PROMPT
            .replace('{originalQuery}', originalQuery)
            .replace(/{numQueries}/g, String(numQueries));

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

        // Retrieval is now handled by the orchestrator in a deep-search loop.
        // This method now focuses solely on rewriting queries.
        return {
            generatedQueries,
            contexts: [] // Return empty context array, as per new architecture
        };
    }
}