import { parseGeminiJsonResponse, parseGeminiJsonResponseSync } from '../../database/services/gemini-integration-modules/GeminiResponseParsers.js';
import { MemoryManager } from '../../database/memory_manager.js';
import { GeminiIntegrationService } from '../../database/services/GeminiIntegrationService.js';

/**
 * Interface for the parsed response from the iterative RAG analysis.
 */
export interface RagAnalysisResponse {
    decision: 'ANSWER' | 'SEARCH_AGAIN' | 'SEARCH_WEB';
    reasoning: string;
    nextCodebaseQuery?: string;
    nextWebQuery?: string;
    confidenceScore?: number;
    qualityScore?: number;
    /** Full context string that was fed to Gemini for this turn (debugging). */
    contextUsed?: string;
    /** The exact prompt sent to Gemini (debugging). */
    promptSent?: string;
    /** Raw Gemini response text (debugging). */
    rawGeminiResponse?: string;
    /** Indicates if parsing failed and fallback was used */
    _parsing_failed?: boolean;
    /** Error message if parsing failed */
    _error_message?: string;
}

/**
 * Robust parser for the iterative RAG analysis response from Gemini.
 * Uses enhanced parsing with AI-powered recovery for maximum reliability.
 */
export class RagResponseParser {
    /**
     * Parse the raw Gemini text into a structured object using enhanced parser.
     *
     * @param rawResponseText  The plain‑text response from Gemini.
     * @param contextUsed      (optional) The context string that was supplied to Gemini.
     * @param promptSent       (optional) The full prompt that was sent.
     * @param memoryManager    (optional) MemoryManager for AI-powered repair.
     * @param geminiService    (optional) GeminiService for AI-powered repair.
     * @returns                Parsed object or `null` on failure.
     */
    static async parseAnalysisResponse(
        rawResponseText: string,
        contextUsed?: string,
        promptSent?: string,
        memoryManager?: MemoryManager,
        geminiService?: GeminiIntegrationService
    ): Promise<RagAnalysisResponse | null> {
        try {
            const trimmedText = rawResponseText.trim();
            
            // Smart detection: Check if response looks like JSON or structured text
            const looksLikeJson = trimmedText.startsWith('{') || trimmedText.startsWith('[') || 
                                  trimmedText.includes('```json') || 
                                  (trimmedText.includes('"decision"') && trimmedText.includes('}'));
            
            // If response looks like JSON, try JSON parsing first
            if (looksLikeJson) {
                console.log('[RAG Parser] Response appears to be JSON format, trying JSON parsing...');
                
                let parsedData: any = null;
                
                if (memoryManager && geminiService) {
                    console.log('[RAG Parser] Attempting enhanced JSON parsing with AI repair capabilities...');
                    try {
                        parsedData = await parseGeminiJsonResponse(rawResponseText, {
                            expectedStructure: 'RAG analysis response with decision, reasoning, and optional queries',
                            contextDescription: 'RAG iterative search analysis response',
                            memoryManager,
                            geminiService,
                            enableAIRepair: true
                        });
                    } catch (enhancedError) {
                        console.warn('[RAG Parser] Enhanced parsing failed, trying sync parser:', enhancedError);
                        try {
                            parsedData = parseGeminiJsonResponseSync(rawResponseText);
                        } catch (syncError) {
                            console.warn('[RAG Parser] Sync parser also failed:', syncError);
                        }
                    }
                } else {
                    console.log('[RAG Parser] Using sync parser (AI repair not available)');
                    try {
                        parsedData = parseGeminiJsonResponseSync(rawResponseText);
                    } catch (syncError) {
                        console.warn('[RAG Parser] Sync parser failed:', syncError);
                    }
                }
                
                // If we got a response from JSON parsing, try to map it to our structure
                if (parsedData && typeof parsedData === 'object') {
                    return RagResponseParser._mapToRagResponse(parsedData, rawResponseText, contextUsed, promptSent);
                }
            } else {
                console.log('[RAG Parser] Response appears to be structured text format, using text parsing directly...');
            }
            
            // Either the response doesn't look like JSON, or JSON parsing failed - use legacy text parsing
            console.log('[RAG Parser] Using legacy text parsing as primary strategy...');
            return RagResponseParser._legacyTextParsing(rawResponseText, contextUsed, promptSent);
            
        } catch (error: any) {
            console.error('[RAG Parser] All parsing strategies failed:', error);
            return null;
        }
    }
    
    /**
     * Synchronous version for backwards compatibility
     */
    static parseAnalysisResponseSync(
        rawResponseText: string,
        contextUsed?: string,
        promptSent?: string
    ): RagAnalysisResponse | null {
        try {
            const parsedData = parseGeminiJsonResponseSync(rawResponseText);
            if (parsedData && typeof parsedData === 'object') {
                return RagResponseParser._mapToRagResponse(parsedData, rawResponseText, contextUsed, promptSent);
            }
            return RagResponseParser._legacyTextParsing(rawResponseText, contextUsed, promptSent);
        } catch (error) {
            return RagResponseParser._legacyTextParsing(rawResponseText, contextUsed, promptSent);
        }
    }
    
    /**
     * Maps parsed data to RagAnalysisResponse structure
     */
    private static _mapToRagResponse(
        parsedData: any,
        rawResponseText: string,
        contextUsed?: string,
        promptSent?: string
    ): RagAnalysisResponse | null {
        try {
            // Handle enhanced parser fallback responses
            if (parsedData._parsing_failed) {
                console.log('[RAG Parser] Enhanced parser used fallback structure');
                return {
                    decision: parsedData.decision || 'ANSWER',
                    reasoning: parsedData.reasoning || 'Parsing failed - using fallback',
                    confidenceScore: parsedData.confidenceScore || 0.3,
                    qualityScore: parsedData.qualityScore || 0.3,
                    nextCodebaseQuery: parsedData.nextCodebaseQuery,
                    nextWebQuery: parsedData.nextWebQuery,
                    contextUsed,
                    promptSent,
                    rawGeminiResponse: rawResponseText,
                    _parsing_failed: true,
                    _error_message: parsedData._error_message
                };
            }
            
            // Map standard JSON response to our structure
            let rawDecision = parsedData.decision?.toUpperCase() || 'ANSWER';
            // Map extended decision types to supported types  
            const decision = ['HYBRID_SEARCH', 'CORRECTIVE_SEARCH', 'REFLECT'].includes(rawDecision)
                ? 'SEARCH_AGAIN' as const
                : (['ANSWER', 'SEARCH_AGAIN', 'SEARCH_WEB'].includes(rawDecision) ? rawDecision as any : 'ANSWER');
                
            if (rawDecision !== decision) {
                console.log(`[RAG Parser] Mapped JSON decision '${rawDecision}' to '${decision}'`);
            }
            
            return {
                decision,
                reasoning: parsedData.reasoning || parsedData.message || 'No reasoning provided',
                nextCodebaseQuery: parsedData.nextCodebaseQuery || parsedData.next_codebase_query,
                nextWebQuery: parsedData.nextWebQuery || parsedData.next_web_query,
                confidenceScore: typeof parsedData.confidenceScore === 'number' ? parsedData.confidenceScore :
                                typeof parsedData.confidence === 'number' ? parsedData.confidence : undefined,
                qualityScore: typeof parsedData.qualityScore === 'number' ? parsedData.qualityScore :
                             typeof parsedData.quality === 'number' ? parsedData.quality : undefined,
                contextUsed,
                promptSent,
                rawGeminiResponse: rawResponseText
            };
        } catch (mappingError: any) {
            console.error('[RAG Parser] Mapping error:', mappingError);
            return null;
        }
    }
    
    /**
     * Legacy text-based parsing as final fallback
     */
    private static _legacyTextParsing(
        rawResponseText: string,
        contextUsed?: string,
        promptSent?: string
    ): RagAnalysisResponse | null {
        try {
            console.log('[RAG Parser] Using legacy text parsing as final fallback');
            
            const txt = rawResponseText.replace(/\r\n/g, '\n').trim();

            // ---------- Decision ----------
            const decisionMatch = txt.match(/Decision:\s*(ANSWER|SEARCH_AGAIN|SEARCH_WEB|HYBRID_SEARCH|CORRECTIVE_SEARCH|REFLECT)/i);
            if (!decisionMatch) {
                console.warn('[RAG Parser] Decision line missing in legacy parsing.');
                // Try to find any decision-like word in the response
                const fallbackDecisionMatch = txt.match(/\b(ANSWER|SEARCH_AGAIN|SEARCH_WEB|HYBRID_SEARCH|CORRECTIVE_SEARCH|REFLECT)\b/i);
                if (fallbackDecisionMatch) {
                    console.log(`[RAG Parser] Found fallback decision: ${fallbackDecisionMatch[1]}`);
                    const decision = fallbackDecisionMatch[1].toUpperCase();
                    // Map unsupported decision types to supported ones
                    const mappedDecision = ['HYBRID_SEARCH', 'CORRECTIVE_SEARCH', 'REFLECT'].includes(decision) 
                        ? 'SEARCH_AGAIN' 
                        : decision as 'ANSWER' | 'SEARCH_AGAIN' | 'SEARCH_WEB';
                    
                    return {
                        decision: mappedDecision,
                        reasoning: `Found decision '${decision}' without proper format - mapped to '${mappedDecision}'`,
                        contextUsed,
                        promptSent,
                        rawGeminiResponse: rawResponseText,
                        _parsing_failed: true,
                        _error_message: `Decision found but not in expected format: ${decision}`
                    };
                }
                
                return {
                    decision: 'ANSWER',
                    reasoning: 'Failed to parse decision from response - defaulting to ANSWER',
                    contextUsed,
                    promptSent,
                    rawGeminiResponse: rawResponseText,
                    _parsing_failed: true,
                    _error_message: 'Decision line not found'
                };
            }
            
            // Map extended decision types to supported types
            let rawDecision = decisionMatch[1].toUpperCase();
            const decision = ['HYBRID_SEARCH', 'CORRECTIVE_SEARCH', 'REFLECT'].includes(rawDecision)
                ? 'SEARCH_AGAIN' as const
                : rawDecision as 'ANSWER' | 'SEARCH_AGAIN' | 'SEARCH_WEB';
                
            if (rawDecision !== decision) {
                console.log(`[RAG Parser] Mapped decision '${rawDecision}' to '${decision}'`);
            }

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
                'Next Graph Query',
                'Strategy',
                'Quality Assessment',
                'Quality',
                'Missing Information',
                'Citation Targets',
                'Confidence',
                'Fallback Strategy',
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

            // ---------- Quality Score ----------
            let qualityScore: number | undefined;
            // Try multiple patterns for quality score
            const qualityMatch = txt.match(/Quality(?:\s+Assessment)?:\s*([0-9]*\.?[0-9]+)/i);
            if (qualityMatch) {
                qualityScore = parseFloat(qualityMatch[1]);
            } else {
                // Try alternative parsing for quality lines
                const altQualityMatch = txt.match(/quality.{0,10}([0-9]*\.?[0-9]+)/i);
                if (altQualityMatch) qualityScore = parseFloat(altQualityMatch[1]);
            }

            return {
                decision,
                reasoning,
                nextCodebaseQuery,
                nextWebQuery: nextWebSearchQuery,
                confidenceScore,
                qualityScore,
                contextUsed,
                promptSent,
                rawGeminiResponse: rawResponseText
            };
        } catch (e) {
            console.error('[RAG Parser] Legacy parsing failed:', e);
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