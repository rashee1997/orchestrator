import { RetrievedCodeContext } from '../../../database/services/CodebaseContextRetrieverService.js';

export function calculateContextQuality(contexts: RetrievedCodeContext[], query: string): number {
    if (contexts.length === 0) return 0.1;
    let totalScore = 0;
    const queryLower = query.toLowerCase();
    const queryTerms = extractQueryTerms(query);
    for (const context of contexts) {
        let contextScore = 0;
        const contentLower = context.content.toLowerCase();
        const relevanceScore = context.relevanceScore || 0.5;
        contextScore += relevanceScore * 0.4;
        const matchingTerms = queryTerms.filter(term =>
            contentLower.includes(term.toLowerCase()) ||
            context.sourcePath.toLowerCase().includes(term.toLowerCase())
        );
        const termMatchScore = Math.min(matchingTerms.length / Math.max(queryTerms.length, 1), 1.0);
        contextScore += termMatchScore * 0.3;
        let qualityIndicators = 0;
        if (context.content.length > 200) qualityIndicators += 0.3;
        if (context.content.includes('function') || context.content.includes('class')) qualityIndicators += 0.3;
        if (context.content.includes('export') || context.content.includes('import')) qualityIndicators += 0.2;
        if (context.entityName && context.entityName.length > 0) qualityIndicators += 0.2;
        contextScore += Math.min(qualityIndicators, 1.0) * 0.2;
        const sourceTypeBonus = context.type !== 'generic_code_chunk' ? 0.1 : 0.0;
        contextScore += sourceTypeBonus;
        totalScore += Math.min(contextScore, 1.0);
    }
    const averageScore = totalScore / contexts.length;
    const diversityBonus = Math.min(contexts.length / 10, 0.2);
    const finalScore = Math.min(averageScore + diversityBonus, 1.0);
    return Math.max(finalScore, 0.1);
}

export function extractQueryTerms(query: string): string[] {
    const commonWords = new Set(['how', 'what', 'when', 'where', 'why', 'who', 'which', 'does', 'do', 'is', 'are', 'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from']);
    return query.toLowerCase()
        .split(/\W+/)
        .filter(word => word.length > 2 && !commonWords.has(word))
        .slice(0, 10);
}