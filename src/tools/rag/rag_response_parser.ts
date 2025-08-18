/**
 * Interface for the parsed response from the iterative RAG analysis.
 */
export interface RagAnalysisResponse {
    decision: 'ANSWER' | 'SEARCH_AGAIN' | 'SEARCH_WEB';
    reasoning: string;
    nextCodebaseQuery?: string;
    nextWebQuery?: string;
    confidenceScore?: number;
    // New fields for comprehensive logging
    contextUsed?: string; // The context string provided to Gemini for this analysis
    promptSent?: string; // The full prompt sent to Gemini for this analysis
    rawGeminiResponse?: string; // The raw text response received from Gemini for this analysis
}

/**
 * Robust parser for the iterative RAG analysis response from Gemini.
 * This replaces the brittle regex-based parsing with structured extraction.
 */
export class RagResponseParser {
    /**
     * Parses the raw text response from Gemini's analysis prompt.
     * @param rawResponseText The raw text response from Gemini
     * @param rawResponseText The raw text response from Gemini
     * @param contextUsed The context string used for the Gemini analysis
     * @param promptSent The full prompt sent to Gemini for the analysis
     * @returns Parsed response object or null if parsing fails
     */
    static parseAnalysisResponse(rawResponseText: string, contextUsed?: string, promptSent?: string): RagAnalysisResponse | null {
        try {
            // Normalize line endings and trim whitespace
            const normalizedText = rawResponseText.replace(/\r\n/g, '\n').trim();

            // More flexible regex for decision
            const decisionMatch = normalizedText.match(/Decision:\s*(ANSWER|SEARCH_AGAIN|SEARCH_WEB)/i);
            if (!decisionMatch) {
                console.warn(`[RagResponseParser] Decision not found in response. Raw text: "${normalizedText}"`);
                return null;
            }
            const decision = decisionMatch[1].toUpperCase() as 'ANSWER' | 'SEARCH_AGAIN' | 'SEARCH_WEB';

            // Function to extract content between a start key and a set of end keys
            const extractContent = (startKey: string, endKeys: string[]): string => {
                const startRegex = new RegExp(`${startKey}:\\s*`, 'i');
                const startIndexMatch = normalizedText.match(startRegex);
                if (!startIndexMatch || startIndexMatch.index === undefined) {
                    return '';
                }
                const contentStartIndex = startIndexMatch.index + startIndexMatch[0].length;
                let endIndex = normalizedText.length;

                for (const endKey of endKeys) {
                    const endRegex = new RegExp(`\\n${endKey}:`, 'i');
                    const endIndexMatch = normalizedText.substring(contentStartIndex).match(endRegex);
                    if (endIndexMatch && endIndexMatch.index !== undefined) {
                        const potentialEndIndex = contentStartIndex + endIndexMatch.index;
                        if (potentialEndIndex < endIndex) {
                            endIndex = potentialEndIndex;
                        }
                    }
                }
                return normalizedText.substring(contentStartIndex, endIndex).trim();
            };

            const allEndKeys = ['Next Codebase Search Query', 'Next Web Search Query', 'Confidence', '---'];
            const reasoning = extractContent('Reasoning', allEndKeys);
            const nextCodebaseQuery = decision === 'SEARCH_AGAIN' ? extractContent('Next Codebase Search Query', allEndKeys.filter(k => k !== 'Next Codebase Search Query')) : undefined;
            const nextWebQuery = decision === 'SEARCH_WEB' ? extractContent('Next Web Search Query', allEndKeys.filter(k => k !== 'Next Web Search Query')) : undefined;

            // Extract confidence score with a more flexible regex
            let confidenceScore: number | undefined;
            const confidenceMatch = normalizedText.match(/Confidence:\s*(\d*\.?\d+)/i);
            if (confidenceMatch) {
                confidenceScore = parseFloat(confidenceMatch[1]);
            }

            return {
                decision,
                reasoning,
                nextCodebaseQuery,
                nextWebQuery,
                confidenceScore,
                contextUsed,
                promptSent,
                rawGeminiResponse: rawResponseText // Store the raw response as well
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
