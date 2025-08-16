/**
 * Interface for the parsed response from the iterative RAG analysis.
 */
export interface RagAnalysisResponse {
    decision: 'ANSWER' | 'SEARCH_AGAIN' | 'SEARCH_WEB';
    reasoning: string;
    nextCodebaseQuery?: string;
    nextWebQuery?: string;
    confidenceScore?: number; // New field for confidence in decision
}

/**
 * Robust parser for the iterative RAG analysis response from Gemini.
 * This replaces the brittle regex-based parsing with structured extraction.
 */
export class RagResponseParser {
    /**
     * Parses the raw text response from Gemini's analysis prompt.
     * @param rawResponseText The raw text response from Gemini
     * @returns Parsed response object or null if parsing fails
     */
    static parseAnalysisResponse(rawResponseText: string): RagAnalysisResponse | null {
        try {
            // Extract decision
            const decisionMatch = rawResponseText.match(/Decision:\s*(ANSWER|SEARCH_AGAIN|SEARCH_WEB)/i);
            if (!decisionMatch) {
                console.warn('[RagResponseParser] Decision not found in response');
                return null;
            }
            const decision = decisionMatch[1].toUpperCase() as 'ANSWER' | 'SEARCH_AGAIN' | 'SEARCH_WEB';

            // Extract reasoning
            const reasoningMatch = rawResponseText.match(/Reasoning:\s*([\s\S]*?)(?=\nNext Codebase Search Query:|\nNext Web Search Query:|\n---|$)/i);
            const reasoning = reasoningMatch ? reasoningMatch[1].trim() : '';

            // Extract confidence score if present
            let confidenceScore: number | undefined;
            const confidenceMatch = rawResponseText.match(/Confidence:\s*(\d+(\.\d+)?)/i);
            if (confidenceMatch) {
                confidenceScore = parseFloat(confidenceMatch[1]);
            }

            // Extract next codebase query (only if decision is SEARCH_AGAIN)
            let nextCodebaseQuery: string | undefined;
            if (decision === 'SEARCH_AGAIN') {
                const codebaseQueryMatch = rawResponseText.match(/Next Codebase Search Query:\s*([\s\S]*?)(?=\nNext Web Search Query:|\n---|$)/i);
                nextCodebaseQuery = codebaseQueryMatch ? codebaseQueryMatch[1].trim() : undefined;
            }

            // Extract next web query (only if decision is SEARCH_WEB)
            let nextWebQuery: string | undefined;
            if (decision === 'SEARCH_WEB') {
                const webQueryMatch = rawResponseText.match(/Next Web Search Query:\s*([\s\S]*?)(?=\n---|$)/i);
                nextWebQuery = webQueryMatch ? webQueryMatch[1].trim() : undefined;
            }

            return {
                decision,
                reasoning,
                nextCodebaseQuery,
                nextWebQuery,
                confidenceScore
            };
        } catch (error) {
            console.error('[RagResponseParser] Error parsing response:', error);
            return null;
        }
    }

    /**
     * Validates the parsed response to ensure it meets the required criteria.
     * @param response The parsed response to validate
     * @returns True if valid, false otherwise
     */
    static validateResponse(response: RagAnalysisResponse): boolean {
        if (!response.decision) {
            console.warn('[RagResponseParser] Missing decision in response');
            return false;
        }

        if (response.decision === 'SEARCH_AGAIN' && !response.nextCodebaseQuery) {
            console.warn('[RagResponseParser] Missing next codebase query for SEARCH_AGAIN decision');
            return false;
        }

        if (response.decision === 'SEARCH_WEB' && !response.nextWebQuery) {
            console.warn('[RagResponseParser] Missing next web query for SEARCH_WEB decision');
            return false;
        }

        return true;
    }
}