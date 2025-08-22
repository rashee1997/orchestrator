import { MemoryManager } from '../../database/memory_manager.js';
import { GeminiIntegrationService } from '../../database/services/GeminiIntegrationService.js';
import { RetrievedCodeContext } from '../../database/services/CodebaseContextRetrieverService.js';
import { ContextRetrievalOptions } from '../../database/services/CodebaseContextRetrieverService.js';
import { RagPromptTemplates } from './rag_prompt_templates.js';
import { RagAnalysisResponse } from './rag_response_parser.js';
import { RagResponseParser } from './rag_response_parser.js';
import { DiverseQueryRewriterService } from './diverse_query_rewriter_service.js';
import { callTavilyApi } from '../../integrations/tavily.js';
import { formatRetrievedContextForPrompt as formatContextForGemini } from '../../database/services/gemini-integration-modules/GeminiContextFormatter.js';
import { GeminiApiNotInitializedError } from '../../database/services/gemini-integration-modules/GeminiApiClient.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export interface IterativeRagResult {
    accumulatedContext: RetrievedCodeContext[];
    webSearchSources: { title: string; url: string }[];
    finalAnswer?: string;
    decisionLog: RagAnalysisResponse[];
    searchMetrics: {
        totalIterations: number;
        contextItemsAdded: number;
        webSearchesPerformed: number;
        hallucinationChecksPerformed: number;
        earlyTerminationReason?: string;
        dmqr: {
            enabled: boolean;
            queryCount?: number;
            generatedQueries?: string[];
            success: boolean;
            contextItemsGenerated: number;
            error?: string;
        };
    };
}

export interface IterativeRagArgs {
    agent_id: string;
    query: string;
    model?: string;
    systemInstruction?: string;

    context_options?: ContextRetrievalOptions;
    focus_area?: string;
    analysis_focus_points?: string[];
    enable_web_search?: boolean;
    max_iterations?: number;
    hallucination_check_threshold?: number;
    tavily_search_depth?: 'basic' | 'advanced';
    tavily_max_results?: number;
    tavily_include_raw_content?: boolean;
    tavily_include_images?: boolean;
    tavily_include_image_descriptions?: boolean;
    tavily_time_period?: string;
    tavily_topic?: string;
    thinkingConfig?: { thinkingBudget?: number; thinkingMode?: 'AUTO' | 'MODE_THINK' };
    enable_dmqr?: boolean;
    dmqr_query_count?: number;
}

export class IterativeRagOrchestrator {
    private memoryManagerInstance: MemoryManager;
    private geminiService: GeminiIntegrationService;
    private diverseQueryRewriterService: DiverseQueryRewriterService;

    constructor(memoryManagerInstance: MemoryManager, geminiService: GeminiIntegrationService, diverseQueryRewriterService: DiverseQueryRewriterService) {
        this.memoryManagerInstance = memoryManagerInstance;
        this.geminiService = geminiService;
        this.diverseQueryRewriterService = diverseQueryRewriterService;
    }

    async performIterativeSearch(args: IterativeRagArgs): Promise<IterativeRagResult> {
        const {
            agent_id,
            query,
            model,
            max_iterations = 3,
            context_options,
            focus_area,
            analysis_focus_points,
            enable_web_search,
            hallucination_check_threshold = 0.8,
            tavily_search_depth = 'basic',
            tavily_max_results = 5,
            tavily_include_raw_content = false,
            tavily_include_images = false,
            tavily_include_image_descriptions = false,
            tavily_time_period,
            tavily_topic,
            thinkingConfig,
            enable_dmqr,
            dmqr_query_count
        } = args;

        const contextRetriever = this.memoryManagerInstance.getCodebaseContextRetrieverService();
        let accumulatedContext: RetrievedCodeContext[] = [];
        const processedEntities = new Set<string>();
        const webSearchSources: { title: string; url: string }[] = [];
        let finalAnswer: string | undefined = undefined;
        const decisionLog: RagAnalysisResponse[] = [];

        const searchMetrics: IterativeRagResult['searchMetrics'] = {
            totalIterations: 0,
            contextItemsAdded: 0,
            webSearchesPerformed: 0,
            hallucinationChecksPerformed: 0,
            earlyTerminationReason: undefined,
            dmqr: {
                enabled: !!enable_dmqr,
                queryCount: dmqr_query_count,
                generatedQueries: [],
                success: false,
                contextItemsGenerated: 0,
                error: undefined
            }
        };

        const focusString = RagPromptTemplates.generateFocusString(focus_area, analysis_focus_points);
        console.log(`[Iterative RAG] Starting iterative search for query: "${query}"`);

        let baseQueries: string[] = [query];

        if (enable_dmqr) {
            console.log(`[Iterative RAG] DMQR enabled: Generating diverse queries...`);
            try {
                const dmqrResult = await this.diverseQueryRewriterService.rewriteAndRetrieve(query, {
                    queryCount: dmqr_query_count,
                });
                baseQueries = dmqrResult.generatedQueries;
                searchMetrics.dmqr.generatedQueries = baseQueries;
                searchMetrics.dmqr.success = true;
                console.log(`[Iterative RAG] DMQR generated ${baseQueries.length} queries: ${baseQueries.map(q => `"${q}"`).join(', ')}`);
            } catch (error: any) {
                console.error(`[Iterative RAG] DMQR failed, falling back to original query:`, error);
                searchMetrics.dmqr.success = false;
                searchMetrics.dmqr.error = error.message || 'Unknown DMQR error';
            }
        }

        const totalMaxIterations = baseQueries.length * max_iterations;
        let totalIterationCount = 0;

        outerLoop: for (const baseQuery of baseQueries) {
            let currentSearchQuery = baseQuery;
            const queryHistoryForThisCycle: string[] = [baseQuery.toLowerCase().trim()];

            for (let i = 0; i < max_iterations; i++) {
                totalIterationCount++;
                searchMetrics.totalIterations = totalIterationCount;
                console.log(`[Iterative RAG] Main Turn ${totalIterationCount}/${totalMaxIterations} (Query Cycle for: "${baseQuery.substring(0, 50)}...", Turn ${i + 1}/${max_iterations})`);

                if (i > 0 && this.isQueryRepetitive(queryHistoryForThisCycle)) {
                    console.log(`[Iterative RAG] Detected repetitive query pattern in this cycle. Moving to next diverse query.`);
                    break; // Break inner loop, move to next diverse query
                }

                const contextResults = await contextRetriever.retrieveContextForPrompt(agent_id, currentSearchQuery, context_options || {});
                const newContext = contextResults.filter(ctx => {
                    const entityKey = `${ctx.sourcePath}::${ctx.entityName || ''}`;
                    if (!processedEntities.has(entityKey)) {
                        processedEntities.add(entityKey);
                        return true;
                    }
                    return false;
                });

                if (newContext.length > 0) {
                    accumulatedContext.push(...newContext);
                    searchMetrics.contextItemsAdded += newContext.length;
                    console.log(`[Iterative RAG] Added ${newContext.length} new context items. Total unique context items: ${accumulatedContext.length}.`);
                } else {
                    console.log(`[Iterative RAG] No new unique context found for this query.`);
                }

                const formattedContextParts = formatContextForGemini(accumulatedContext);
                const contextString = formattedContextParts[0].text || '';

                const analysisPrompt = RagPromptTemplates.generateAnalysisPrompt({
                    originalQuery: query, // Always use the original query for the top-level goal
                    currentTurn: totalIterationCount,
                    maxIterations: totalMaxIterations.toString(),
                    accumulatedContext: contextString,
                    focusString,
                    enableWebSearch: !!enable_web_search
                });

                let analysisResult;
                try {
                    analysisResult = await this.geminiService.askGemini(
                        analysisPrompt, model, RagPromptTemplates.generateAnalysisSystemInstruction(), thinkingConfig
                    );
                } catch (error: any) {
                    console.error(`[Iterative RAG] Error during Gemini analysis:`, error);
                    searchMetrics.earlyTerminationReason = `Gemini analysis failed: ${error.message}`;
                    break outerLoop;
                }

                const rawResponseText = analysisResult.content[0].text ?? "";
                const parsedResponse = RagResponseParser.parseAnalysisResponse(rawResponseText, contextString, analysisPrompt);
                if (parsedResponse) decisionLog.push(parsedResponse);

                if (!parsedResponse || !RagResponseParser.validateResponse(parsedResponse)) {
                    console.warn(`[Iterative RAG] Failed to parse or validate Gemini response. Concluding search.`);
                    searchMetrics.earlyTerminationReason = "Failed to parse Gemini response";
                    break outerLoop;
                }

                if (parsedResponse.decision === "ANSWER") {
                    console.log(`[Iterative RAG] Decision is to ANSWER. Generating final response and concluding search.`);
                    const answerPrompt = RagPromptTemplates.generateAnswerPrompt({ originalQuery: query, contextString, focusString });
                    const answerResult = await this.geminiService.askGemini(answerPrompt, model, "You are a helpful AI assistant providing accurate answers based on the given context.", thinkingConfig);
                    finalAnswer = answerResult.content[0].text ?? "";
                    break outerLoop;
                }

                if (enable_web_search && parsedResponse.decision === "SEARCH_WEB" && parsedResponse.nextWebQuery) {
                    console.log(`[Iterative RAG] Decision is to SEARCH_WEB. Query: "${parsedResponse.nextWebQuery}"`);
                    searchMetrics.webSearchesPerformed++;
                    try {
                        const webResults = await callTavilyApi(parsedResponse.nextWebQuery, { search_depth: tavily_search_depth, max_results: tavily_max_results });
                        if (webResults.length > 0) {
                            webResults.forEach((res: any) => {
                                webSearchSources.push({ title: res.title, url: res.url });
                                accumulatedContext.push({ type: 'documentation', sourcePath: res.url, entityName: res.title, content: res.content, relevanceScore: 0.95 });
                            });
                        }
                    } catch (webError: any) {
                        console.error(`[Iterative RAG] Tavily web search failed: ${webError.message}`);
                    }
                } else if (parsedResponse.decision === "SEARCH_AGAIN" && parsedResponse.nextCodebaseQuery) {
                    currentSearchQuery = parsedResponse.nextCodebaseQuery;
                    queryHistoryForThisCycle.push(currentSearchQuery.toLowerCase().trim());
                    console.log(`[Iterative RAG] Decision is to SEARCH_AGAIN. New query: "${currentSearchQuery}"`);
                } else {
                    // If decision is not ANSWER but no valid next step, move to next diverse query
                    console.log(`[Iterative RAG] No valid next action for this query cycle. Moving to next diverse query.`);
                    break; // Break inner loop
                }
            } // End of inner loop
        } // End of outer loop

        if (!finalAnswer && accumulatedContext.length > 0) {
            console.log("[Iterative RAG] Search concluded without a direct ANSWER decision. Generating a final answer from all accumulated context.");
            const contextString = formatContextForGemini(accumulatedContext)[0].text || '';
            const answerPrompt = RagPromptTemplates.generateAnswerPrompt({ originalQuery: query, contextString, focusString });
            const answerResult = await this.geminiService.askGemini(answerPrompt, model, "You are a helpful AI assistant providing accurate answers based on the given context.", thinkingConfig);
            finalAnswer = answerResult.content[0].text ?? "Could not formulate a final answer based on the context.";
        }

        if (!searchMetrics.earlyTerminationReason && totalIterationCount >= totalMaxIterations) {
            searchMetrics.earlyTerminationReason = "Max iterations reached";
        }

        return { accumulatedContext, webSearchSources, finalAnswer, decisionLog, searchMetrics };
    }

    private async _reanalyzeContextAndDecide(
        contextString: string,
        originalQuery: string,
        focusString: string,
        model: string | undefined,
        thinkingConfig: any,
        contextUsed?: string,
        promptSent?: string
    ): Promise<RagAnalysisResponse | null> {
        console.log('[Iterative RAG] Re-analyzing context after web search.');
        const analysisPrompt = RagPromptTemplates.generateAnalysisPrompt({
            originalQuery: originalQuery,
            currentTurn: -1,
            maxIterations: '-1',
            accumulatedContext: contextString,
            focusString: focusString,
            enableWebSearch: false
        });

        let analysisResult;
        try {
            analysisResult = await this.geminiService.askGemini(
                analysisPrompt,
                model,
                RagPromptTemplates.generateAnalysisSystemInstruction(),
                thinkingConfig
            );
        } catch (error: any) {
            console.error(`[Iterative RAG] Re-analysis: Error during Gemini analysis:`, error);
            return null;
        }

        const rawResponseText = analysisResult.content[0].text ?? '';
        return RagResponseParser.parseAnalysisResponse(rawResponseText, contextUsed, promptSent);
    }

    private async performEnhancedHallucinationCheck(params: {
        originalQuery: string;
        contextString: string;
        generatedAnswer: string;
        model?: string;
        threshold: number;
        thinkingConfig?: { thinkingBudget?: number; thinkingMode?: 'AUTO' | 'MODE_THINK' };
    }): Promise<{ isHallucination: boolean; confidence: number; issues: string }> {
        const { originalQuery, contextString, generatedAnswer, model, threshold, thinkingConfig } = params;

        const verificationPrompt = RagPromptTemplates.generateVerificationPrompt({
            originalQuery,
            contextString,
            generatedAnswer
        });

        let verificationResult;
        try {
            verificationResult = await this.geminiService.askGemini(
                verificationPrompt,
                model,
                "You are a precise fact-checker. Respond only with VERIFIED or HALLUCINATION_DETECTED followed by issues.",
                thinkingConfig
            );
        } catch (error: any) {
            console.error(`[Iterative RAG] Hallucination check: Error during Gemini verification:`, error);
            return { isHallucination: false, confidence: 0, issues: `Verification failed: ${error.message}` };
        }

        const verificationText = verificationResult.content[0].text ?? "";
        const isHallucinationDirect = verificationText.includes("HALLUCINATION_DETECTED");

        return {
            isHallucination: isHallucinationDirect,
            confidence: isHallucinationDirect ? 0.9 : 0.1,
            issues: isHallucinationDirect ? verificationText.replace("HALLUCINATION_DETECTED", "").trim() : "No significant hallucination detected"
        };
    }

    private isQueryRepetitive(queryHistory: string[]): boolean {
        if (queryHistory.length < 2) {
            return false;
        }
        const lastQuery = queryHistory[queryHistory.length - 1];
        for (let i = 0; i < queryHistory.length - 1; i++) {
            if (this.calculateSimilarity(lastQuery, queryHistory[i]) > 0.9) {
                return true;
            }
        }
        return false;
    }

    private async expandQuery(originalQuery: string, accumulatedContext: RetrievedCodeContext[], model?: string, thinkingConfig?: any): Promise<string> {
        if (accumulatedContext.length === 0) {
            return originalQuery;
        }

        const contextSummary = accumulatedContext.slice(0, 5).map(ctx =>
            `${ctx.type}: ${ctx.entityName || 'Unknown'} - ${ctx.content?.substring(0, 100)}...`
        ).join('\n');

        const expansionPrompt = `Based on the following context from a codebase search, expand or reformulate the original query to find more relevant information:

Original Query: "${originalQuery}"

Available Context:
${contextSummary}

Instructions:
- If the context suggests there are related topics or deeper aspects not covered by the original query, expand it
- If the context shows the query is too narrow, broaden it appropriately
- If the context reveals better terminology or concepts to use, incorporate them
- Keep the expanded query focused and relevant
- If no meaningful expansion is possible, return the original query unchanged

Return only the expanded query, no explanation.`;

        try {
            const expansionResult = await this.geminiService.askGemini(
                expansionPrompt,
                model,
                "You are a query expansion specialist. Return only the expanded query text.",
                thinkingConfig
            );

            const expandedQuery = expansionResult.content[0].text?.trim();
            return expandedQuery && expandedQuery !== originalQuery ? expandedQuery : originalQuery;
        } catch (error: any) {
            console.error(`[Iterative RAG] Query expansion failed:`, error);
            return originalQuery;
        }
    }

    private async extractDeeperInsights(query: string, accumulatedContext: RetrievedCodeContext[], model?: string, thinkingConfig?: any): Promise<string | null> {
        if (accumulatedContext.length < 5) {
            return null;
        }

        const contextString = formatContextForGemini(accumulatedContext)[0].text || '';

        const insightPrompt = `Analyze the following context deeply to extract insights that directly answer: "${query}"

Context:
${contextString}

Instructions:
- Look for patterns, relationships, and connections in the code
- Extract specific technical details that answer the query
- Focus on factual information from the provided context
- If you can form a coherent answer using only the context, provide it
- If the context is insufficient, return "INSUFFICIENT_CONTEXT"

Provide a direct answer based only on the context provided.`;

        try {
            const insightResult = await this.geminiService.askGemini(
                insightPrompt,
                model,
                "You are a technical analyst. Extract insights directly from the provided context.",
                thinkingConfig
            );

            const insights = insightResult.content[0].text?.trim();

            if (insights && insights !== "INSUFFICIENT_CONTEXT") {
                return insights;
            }
            return null;
        } catch (error: any) {
            console.error(`[Iterative RAG] Deep insight extraction failed:`, error);
            return null;
        }
    }

    private calculateSimilarity(str1: string, str2: string): number {
        const words1 = str1.split(/\s+/).filter(w => w.length > 0);
        const words2 = str2.split(/\s+/).filter(w => w.length > 0);
        if (words1.length === 0 || words2.length === 0) {
            return 0;
        }
        const intersection = words1.filter(word => words2.includes(word));
        const union = [...new Set([...words1, ...words2])];
        return intersection.length / union.length;
    }
}