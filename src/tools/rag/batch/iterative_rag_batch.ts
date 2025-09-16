import { MultiModelOrchestrator } from '../multi_model_orchestrator.js';
import { RetrievedCodeContext } from '../../../database/services/CodebaseContextRetrieverService.js';
import { parseGeminiJsonResponse } from '../../../database/services/gemini-integration-modules/GeminiResponseParsers.js';
import { MemoryManager } from '../../../database/memory_manager.js';
import { GeminiIntegrationService } from '../../../database/services/GeminiIntegrationService.js';

export class IterativeRagBatch {
    constructor(
        private multiModelOrchestrator: MultiModelOrchestrator,
        private memoryManager: MemoryManager,
        private geminiService: GeminiIntegrationService
    ) {}

    async processConsolidatedBatchContextAnalysis(
        contexts: RetrievedCodeContext[],
        query: string,
        model?: string,
        turn?: number
    ): Promise<{ analyzedContexts: RetrievedCodeContext[], batchAnalysis: string[] }> {
        console.log(`[Consolidated Batch Analysis] Processing ALL ${contexts.length} contexts in single request for free tier efficiency`);
        const contextSummaries = contexts.map((ctx, idx) =>
            `Context ${idx + 1}:\n` +
            `File: ${ctx.sourcePath}\n` +
            `Entity: ${ctx.entityName || 'N/A'}\n` +
            `Type: ${ctx.type}\n` +
            `Content Preview: ${ctx.content.substring(0, 400)}...\n` +
            `Current Score: ${ctx.relevanceScore || 0.5}\n`
        ).join('\n---\n\n');
        const consolidatedPrompt = `Analyze ALL ${contexts.length} code contexts for relevance to query: "${query}"${turn ? ` (Search turn ${turn})` : ''}For EACH context, provide:1. Relevance score (0.0-1.0) - how well it matches the query2. Key insights - what important information it contains3. Query relationship - how it specifically relates to the query4. Confidence level - how confident you are in this assessmentContexts to analyze:${contextSummaries}Return JSON format:{  "overallAnalysis": "Brief summary of all contexts and their collective relevance",  "contextAnalyses": [    {      "contextIndex": 0,      "relevanceScore": 0.85,      "insights": "Key insights about this context",      "queryRelationship": "How this relates to the query",      "confidence": 0.9    },    // ... for each context  ]}`;
        try {
            const result = await this.multiModelOrchestrator.executeTask(
                'complex_analysis',
                consolidatedPrompt,
                undefined,
                { contextLength: consolidatedPrompt.length }
            );
            const responseText = result.content ?? '{}';
            console.log(`[Consolidated Batch Analysis] Received response for ${contexts.length} contexts`);
            let analysisData: any = {};
            try {
                analysisData = await parseGeminiJsonResponse(responseText, {
                    expectedStructure: 'Batch analysis response with contextAnalyses array and overallAnalysis',
                    contextDescription: 'Consolidated batch context analysis',
                    memoryManager: this.memoryManager,
                    geminiService: this.geminiService,
                    enableAIRepair: true,
                });
            } catch (parseError) {
                console.warn('[Consolidated Batch Analysis] Enhanced parsing failed, using fallback:', parseError);
                analysisData = { contextAnalyses: [], overallAnalysis: 'Parsing failed - enhanced recovery exhausted' };
            }
            const contextAnalyses = analysisData.contextAnalyses || [];
            const overallAnalysis = analysisData.overallAnalysis || 'Analysis completed';
            const analyzedContexts = contexts.map((context, idx) => {
                const analysis = contextAnalyses.find((a: any) => a.contextIndex === idx);
                if (analysis && typeof analysis.relevanceScore === 'number') {
                    return {
                        ...context,
                        relevanceScore: Math.max(
                            context.relevanceScore || 0.5,
                            Math.min(1.0, Math.max(0.0, analysis.relevanceScore))
                        ),
                        metadata: {
                            ...context.metadata,
                            consolidatedAnalysis: {
                                insights: analysis.insights || 'No insights provided',
                                queryRelationship: analysis.queryRelationship || 'Relationship unclear',
                                confidence: analysis.confidence || 0.5,
                                analyzedAt: new Date().toISOString(),
                                turn: turn || 0,
                            },
                        },
                    };
                }
                return {
                    ...context,
                    relevanceScore: Math.max(context.relevanceScore || 0.5, 0.6),
                    metadata: {
                        ...context.metadata,
                        consolidatedAnalysis: {
                            insights: 'Analysis not available for this context',
                            queryRelationship: 'Assumed relevant based on retrieval',
                            confidence: 0.4,
                            analyzedAt: new Date().toISOString(),
                            turn: turn || 0,
                        },
                    },
                };
            });
            console.log(`[Consolidated Batch Analysis] Successfully updated ${analyzedContexts.length} contexts with analysis results`);
            return {
                analyzedContexts,
                batchAnalysis: [
                    `Consolidated Analysis (${contexts.length} contexts): ${overallAnalysis}`,
                    `Successfully analyzed: ${contextAnalyses.length}/${contexts.length} contexts`,
                    `Average relevance: ${analyzedContexts.reduce((sum, ctx) => sum + (ctx.relevanceScore || 0), 0) / analyzedContexts.length}`,
                ],
            };
        } catch (error: any) {
            console.error('[Consolidated Batch Analysis] Analysis failed:', error);
            const fallbackContexts = contexts.map(ctx => ({
                ...ctx,
                relevanceScore: Math.max(ctx.relevanceScore || 0.5, 0.6),
            }));
            return {
                analyzedContexts: fallbackContexts,
                batchAnalysis: [
                    `Consolidated analysis failed: ${error.message}`,
                    `Fallback: Applied default relevance scores to ${contexts.length} contexts`,
                ],
            };
        }
    }
}