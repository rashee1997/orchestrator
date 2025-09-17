/**
 * Enhanced intelligent routing strategy for parallel embedding generation.
 * Routes content to optimal models based on content characteristics.
 */

export interface ContentAnalysis {
    contentType: 'code' | 'summary' | 'documentation' | 'comment';
    complexity: 'simple' | 'medium' | 'complex';
    language?: string;
    chunkSize: number;
    hasNaturalLanguage: boolean;
    hasCode: boolean;
}

export interface RoutingStrategy {
    preferredModel: 'gemini' | 'codestral';
    confidence: number;
    reasoning: string;
}

export class IntelligentEmbeddingRouter {

    /**
     * Analyze content characteristics to determine optimal routing
     */
    analyzeContent(chunkText: string, embeddingType: 'summary' | 'chunk', entityName?: string | null, language?: string): ContentAnalysis {
        const chunkSize = chunkText.length;

        // Detect content patterns
        const codePatterns = /\b(function|class|const|let|var|if|for|while|return|import|export)\b/gi;
        const naturalLanguagePatterns = /\b(the|and|or|but|in|on|at|to|for|of|with|by)\b/gi;

        const codeMatches = (chunkText.match(codePatterns) || []).length;
        const nlMatches = (chunkText.match(naturalLanguagePatterns) || []).length;

        const hasCode = codeMatches > 2;
        const hasNaturalLanguage = nlMatches > 3;

        // Determine content type
        let contentType: ContentAnalysis['contentType'];
        if (embeddingType === 'summary') {
            contentType = 'summary';
        } else if (chunkText.trim().startsWith('//') || chunkText.trim().startsWith('/*') || chunkText.trim().startsWith('*')) {
            contentType = 'comment';
        } else if (hasCode && !hasNaturalLanguage) {
            contentType = 'code';
        } else {
            contentType = 'documentation';
        }

        // Determine complexity
        let complexity: ContentAnalysis['complexity'];
        if (chunkSize < 200) complexity = 'simple';
        else if (chunkSize < 800) complexity = 'medium';
        else complexity = 'complex';

        return {
            contentType,
            complexity,
            language,
            chunkSize,
            hasNaturalLanguage,
            hasCode
        };
    }

    /**
     * Determine optimal model routing based on content analysis
     */
    routeToOptimalModel(analysis: ContentAnalysis): RoutingStrategy {
        // Codestral strengths: Pure code, programming constructs, technical content
        // Gemini strengths: Natural language, summaries, documentation, mixed content

        switch (analysis.contentType) {
            case 'code':
                return {
                    preferredModel: 'codestral',
                    confidence: 0.9,
                    reasoning: 'Pure code content - Codestral specializes in code understanding'
                };

            case 'summary':
                return {
                    preferredModel: 'gemini',
                    confidence: 0.85,
                    reasoning: 'Summary content - Gemini excels at natural language understanding'
                };

            case 'documentation':
                return {
                    preferredModel: 'gemini',
                    confidence: 0.8,
                    reasoning: 'Documentation content - Gemini better for natural language'
                };

            case 'comment':
                if (analysis.hasCode && !analysis.hasNaturalLanguage) {
                    return {
                        preferredModel: 'codestral',
                        confidence: 0.7,
                        reasoning: 'Technical comment with code - Codestral for code context'
                    };
                } else {
                    return {
                        preferredModel: 'gemini',
                        confidence: 0.75,
                        reasoning: 'Natural language comment - Gemini for language understanding'
                    };
                }

            default:
                return {
                    preferredModel: 'gemini',
                    confidence: 0.5,
                    reasoning: 'Mixed/unknown content - Gemini as general-purpose fallback'
                };
        }
    }

    /**
     * Intelligently distribute chunks between models based on content analysis
     */
    distributeChunksIntelligently(chunks: Array<{
        text: string;
        embeddingType: 'summary' | 'chunk';
        entityName?: string | null;
        language?: string;
        index: number;
    }>): {
        geminiChunks: Array<{ text: string; index: number; reasoning: string }>;
        codestralChunks: Array<{ text: string; index: number; reasoning: string }>;
        distributionStats: {
            totalChunks: number;
            geminiCount: number;
            codestralCount: number;
            contentTypeBreakdown: Record<string, { gemini: number; codestral: number }>;
        };
    } {
        const geminiChunks: Array<{ text: string; index: number; reasoning: string }> = [];
        const codestralChunks: Array<{ text: string; index: number; reasoning: string }> = [];
        const contentTypeBreakdown: Record<string, { gemini: number; codestral: number }> = {};

        for (const chunk of chunks) {
            const analysis = this.analyzeContent(
                chunk.text,
                chunk.embeddingType,
                chunk.entityName,
                chunk.language
            );

            const routing = this.routeToOptimalModel(analysis);

            // Track content type statistics
            if (!contentTypeBreakdown[analysis.contentType]) {
                contentTypeBreakdown[analysis.contentType] = { gemini: 0, codestral: 0 };
            }

            if (routing.preferredModel === 'gemini') {
                geminiChunks.push({
                    text: chunk.text,
                    index: chunk.index,
                    reasoning: routing.reasoning
                });
                contentTypeBreakdown[analysis.contentType].gemini++;
            } else {
                codestralChunks.push({
                    text: chunk.text,
                    index: chunk.index,
                    reasoning: routing.reasoning
                });
                contentTypeBreakdown[analysis.contentType].codestral++;
            }
        }

        // Apply load balancing if one model is severely overloaded
        this.balanceWorkload(geminiChunks, codestralChunks);

        return {
            geminiChunks,
            codestralChunks,
            distributionStats: {
                totalChunks: chunks.length,
                geminiCount: geminiChunks.length,
                codestralCount: codestralChunks.length,
                contentTypeBreakdown
            }
        };
    }

    /**
     * Balance workload if one model is severely overloaded (>80% of chunks)
     */
    private balanceWorkload(
        geminiChunks: Array<{ text: string; index: number; reasoning: string }>,
        codestralChunks: Array<{ text: string; index: number; reasoning: string }>
    ): void {
        const total = geminiChunks.length + codestralChunks.length;
        const geminiRatio = geminiChunks.length / total;
        const codestralRatio = codestralChunks.length / total;

        // If Gemini has >80% of work, move some to Codestral
        if (geminiRatio > 0.8 && geminiChunks.length > 4) {
            const toMove = Math.floor((geminiChunks.length - total * 0.7));
            for (let i = 0; i < toMove; i++) {
                const chunk = geminiChunks.pop()!;
                chunk.reasoning += ' (load balanced to Codestral)';
                codestralChunks.push(chunk);
            }
        }

        // If Codestral has >80% of work, move some to Gemini
        if (codestralRatio > 0.8 && codestralChunks.length > 4) {
            const toMove = Math.floor((codestralChunks.length - total * 0.7));
            for (let i = 0; i < toMove; i++) {
                const chunk = codestralChunks.pop()!;
                chunk.reasoning += ' (load balanced to Gemini)';
                geminiChunks.push(chunk);
            }
        }
    }
}