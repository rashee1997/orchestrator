/**
 * Interface for the parsed response from the iterative RAG analysis.
 */
export interface RagAnalysisResponse {
    decision: 'ANSWER' | 'SEARCH_AGAIN' | 'SEARCH_WEB';
    reasoning: string;
    nextCodebaseQuery?: string;
    nextWebQuery?: string;
    confidenceScore?: number;
    /** Full context string that was fed to Gemini for this turn (debugging). */
    contextUsed?: string;
    /** The exact prompt sent to Gemini (debugging). */
    promptSent?: string;
    /** Raw Gemini response text (debugging). */
    rawGeminiResponse?: string;
}

/**
 * Robust parser for the iterative RAG analysis response from Gemini.
 * Handles flexible whitespace, optional sections, and keeps the raw text for debugging.
 */
export class RagResponseParser {
    /**
     * Parse the raw Gemini text into a structured object.
     *
     * @param rawResponseText  The plain‑text response from Gemini.
     * @param contextUsed      (optional) The context string that was supplied to Gemini.
     * @param promptSent       (optional) The full prompt that was sent.
     * @returns                Parsed object or `null` on failure.
     */
    static parseAnalysisResponse(
        rawResponseText: string,
        contextUsed?: string,
        promptSent?: string
    ): RagAnalysisResponse | null {
        try {
            const txt = rawResponseText.replace(/\r\n/g, '\n').trim();

            // ---------- Decision ----------
            const decisionMatch = txt.match(/Decision:\s*(ANSWER|SEARCH_AGAIN|SEARCH_WEB)/i);
            if (!decisionMatch) {
                console.warn('[RagResponseParser] Decision line missing.');
                return null;
            }
            const decision = decisionMatch[1].toUpperCase() as 'ANSWER' | 'SEARCH_AGAIN' | 'SEARCH_WEB';

            // Helper to extract a block that starts with a label and stops before any of the given end‑labels.
            const extractBlock = (label: string, endLabels: string[]): string => {
                const start = new RegExp(`${label}:\\s*`, 'i');
                const startIdx = txt.search(start);
                if (startIdx === -1) return '';
                const afterStart = txt.slice(startIdx + label.length + 1);
                let endIdx = afterStart.length;
                for (const end of endLabels) {
                    const re = new RegExp(`\\n${end}:`, 'i');
                    const m = afterStart.search(re);
                    if (m !== -1 && m < endIdx) endIdx = m;
                }
                return afterStart.slice(0, endIdx).trim();
            };

            const allEndLabels = [
                'Next Codebase Search Query',
                'Next Web Search Query',
                'Confidence',
                '---'
            ];

            const reasoning = extractBlock('Reasoning', allEndLabels);
            const nextCodebaseQuery =
                decision === 'SEARCH_AGAIN'
                    ? extractBlock('Next Codebase Search Query', allEndLabels.filter(l => l !== 'Next Codebase Search Query'))
                    : undefined;
            const nextWebSearchQuery =
                decision === 'SEARCH_WEB'
                    ? extractBlock('Next Web Search Query', allEndLabels.filter(l => l !== 'Next Web Search Query'))
                    : undefined;

            // ---------- Confidence ----------
            let confidenceScore: number | undefined;
            const confidenceMatch = txt.match(/Confidence:\s*([0-9]*\.?[0-9]+)/i);
            if (confidenceMatch) confidenceScore = parseFloat(confidenceMatch[1]);

            return {
                decision,
                reasoning,
                nextCodebaseQuery,
                nextWebQuery: nextWebSearchQuery,
                confidenceScore,
                contextUsed,
                promptSent,
                rawGeminiResponse: rawResponseText
            };
        } catch (e) {
            console.error('[RagResponseParser] Unexpected error while parsing.', e);
            return null;
        }
    }

    /**
     * Validate that the parsed object contains the fields required for the decision.
     */
    static validateResponse(response: RagAnalysisResponse): boolean {
        if (!response.decision) {
            console.warn('[RagResponseParser] Missing decision.');
            return false;
        }
        if (response.decision === 'SEARCH_AGAIN' && !response.nextCodebaseQuery) {
            console.warn('[RagResponseParser] SEARCH_AGAIN without nextCodebaseQuery.');
            return false;
        }
        if (response.decision === 'SEARCH_WEB' && !response.nextWebQuery) {
            console.warn('[RagResponseParser] SEARCH_WEB without nextWebQuery.');
            return false;
        }
        return true;
    }
}