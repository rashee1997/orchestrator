import { GeminiIntegrationService } from '../../database/services/GeminiIntegrationService.js';
import { MemoryManager } from '../../database/memory_manager.js';
import { RetrievedCodeContext } from '../../database/services/CodebaseContextRetrieverService.js';
import { RAG_DIVERSE_QUERIES_PROMPT } from '../../database/services/gemini-integration-modules/GeminiPromptTemplates.js';
import { deduplicateContexts } from '../../utils/context_utils.js';
import { parseGeminiJsonResponse } from '../../database/services/gemini-integration-modules/GeminiResponseParsers.js';
import { getCurrentModel } from '../../database/services/gemini-integration-modules/GeminiConfig.js';

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
            const llmResponse = await this.geminiService.askGemini(prompt, getCurrentModel());
            const responseText = llmResponse.content[0].text ?? '';

            // Parse the LLM response which should be a JSON object with strategic_queries array
            const parsedResponse = parseGeminiJsonResponse(responseText);

            // Extract queries from the expected structure
            if (parsedResponse && parsedResponse.strategic_queries && Array.isArray(parsedResponse.strategic_queries)) {
                generatedQueries = parsedResponse.strategic_queries
                    .filter((item: any) => item && typeof item.query === 'string')
                    .map((item: any) => item.query);
                console.log(`[DiverseQueryRewriter] Successfully extracted ${generatedQueries.length} diverse queries from LLM response`);
            } else if (Array.isArray(parsedResponse)) {
                // Fallback: if LLM returned a direct array of strings
                generatedQueries = parsedResponse.filter((q: any) => typeof q === 'string');
                console.log(`[DiverseQueryRewriter] LLM returned direct array of ${generatedQueries.length} queries`);
            } else {
                console.warn('LLM returned unexpected JSON structure for diverse queries. Expected strategic_queries array.');
                generatedQueries = [];
            }

            // Additional validation
            if (generatedQueries.length === 0) {
                console.warn('No valid queries extracted from LLM response. Falling back to original query.');
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
