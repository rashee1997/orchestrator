import { MultiModelOrchestrator } from '../multi_model_orchestrator.js';
import { RetrievedCodeContext } from '../../../database/services/CodebaseContextRetrieverService.js';
import { parseGeminiJsonResponse } from '../../../database/services/gemini-integration-modules/GeminiResponseParsers.js';
import { MemoryManager } from '../../../database/memory_manager.js';
import { GeminiIntegrationService } from '../../../database/services/GeminiIntegrationService.js';
import { JSONRepairAgent } from '../../../database/services/JSONRepairAgent.js';

export class IterativeRagBatch {
    private jsonRepairAgent: JSONRepairAgent;

    constructor(
        private multiModelOrchestrator: MultiModelOrchestrator,
        private memoryManager: MemoryManager,
        private geminiService: GeminiIntegrationService
    ) {
        this.jsonRepairAgent = new JSONRepairAgent(memoryManager, geminiService);
    }

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
        const consolidatedPrompt = `Analyze ALL ${contexts.length} code contexts for relevance to query: "${query}"${turn ? ` (Search turn ${turn})` : ''}

For EACH context, provide:
1. Relevance score (0.0-1.0) - how well it matches the query
2. Key insights - what important information it contains
3. Query relationship - how it specifically relates to the query
4. Confidence level - how confident you are in this assessment

Contexts to analyze:
${contextSummaries}

IMPORTANT: Return ONLY valid JSON in exactly this format (no markdown, no extra text):
{
  "overallAnalysis": "Brief summary of all contexts and their collective relevance",
  "contextAnalyses": [
    {
      "contextIndex": 0,
      "relevanceScore": 0.85,
      "insights": "Key insights about this context",
      "queryRelationship": "How this relates to the query",
      "confidence": 0.9
    }
  ]
}`;
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
                // First try the standard parser
                analysisData = await parseGeminiJsonResponse(responseText, {
                    expectedStructure: 'Batch analysis response with contextAnalyses array and overallAnalysis',
                    contextDescription: 'Consolidated batch context analysis',
                    memoryManager: this.memoryManager,
                    geminiService: this.geminiService,
                    enableAIRepair: true,
                });

                // Validate the result and provide fallback if invalid
                if (!analysisData || analysisData === null || typeof analysisData !== 'object') {
                    console.warn('[Consolidated Batch Analysis] JSON parser returned null or invalid object, creating fallback');
                    analysisData = {
                        contextAnalyses: contexts.map((ctx, index) => ({
                            contextId: `${ctx.sourcePath}:${ctx.entityName || 'unknown'}`,
                            entities: [],
                            relationships: [],
                            relevanceScore: 0.5,
                            summary: `Analysis failed for context ${index + 1}`,
                            _fallback: true
                        })),
                        overallAnalysis: {
                            primaryThemes: ['JSON parsing failed'],
                            keyInsights: ['Unable to parse response'],
                            confidenceScore: 0.3,
                            _fallback: true
                        },
                        _parsing_failed: true
                    };
                }

                if (!analysisData.contextAnalyses || !Array.isArray(analysisData.contextAnalyses)) {
                    console.warn('[Consolidated Batch Analysis] Missing or invalid contextAnalyses array, creating fallback array');
                    analysisData.contextAnalyses = contexts.map((ctx, index) => ({
                        contextId: `${ctx.sourcePath}:${ctx.entityName || 'unknown'}`,
                        entities: [],
                        relationships: [],
                        relevanceScore: 0.5,
                        summary: `Fallback analysis for context ${index + 1}`,
                        _fallback: true
                    }));
                }

            } catch (parseError) {
                console.warn('[Consolidated Batch Analysis] Standard parsing failed, using AI JSON repair:', parseError);

                // Use our sophisticated AI JSON repair agent
                const repairResult = await this.jsonRepairAgent.repairJSON(
                    responseText,
                    'JSON object with "overallAnalysis" string and "contextAnalyses" array containing objects with contextIndex, relevanceScore, insights, queryRelationship, and confidence fields',
                    `Consolidated batch context analysis for query: "${query}"`
                );

                if (repairResult.success && repairResult.data) {
                    console.log(`[Consolidated Batch Analysis] ✅ AI JSON repair successful (confidence: ${repairResult.confidence.toFixed(2)}, strategy: ${repairResult.repairStrategy})`);
                    analysisData = repairResult.data;

                    // Final validation after repair
                    if (!analysisData.contextAnalyses || !Array.isArray(analysisData.contextAnalyses)) {
                        console.warn('[Consolidated Batch Analysis] AI repair incomplete, creating minimal structure');
                        analysisData = {
                            contextAnalyses: [],
                            overallAnalysis: analysisData.overallAnalysis || 'AI repair provided partial results'
                        };
                    }
                } else {
                    console.error('[Consolidated Batch Analysis] ❌ AI JSON repair failed, using safe fallback');
                    analysisData = {
                        contextAnalyses: [],
                        overallAnalysis: 'AI JSON repair failed - using minimal analysis'
                    };
                }
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