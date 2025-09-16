import { MemoryManager } from '../../database/memory_manager.js';
import { GeminiIntegrationService } from '../../database/services/GeminiIntegrationService.js';
import { RetrievedCodeContext } from '../../database/services/CodebaseContextRetrieverService.js';
import { ContextRetrievalOptions } from '../../database/services/CodebaseContextRetrieverService.js';
import {
    RAG_ANALYSIS_PROMPT,
    RAG_ANALYSIS_SYSTEM_INSTRUCTION,
    RAG_ANSWER_PROMPT,
    RAG_VERIFICATION_PROMPT,
    RAG_SELF_CORRECTION_PROMPT
} from '../../database/services/gemini-integration-modules/GeminiPromptTemplates.js';
import {
    AGENTIC_RAG_PLANNING_PROMPT,
    RAG_REFLECTION_PROMPT,
    CORRECTIVE_RAG_PROMPT,
    HYBRID_RAG_COORDINATION_PROMPT,
    LONG_RAG_CHUNKING_PROMPT,
    CITATION_ATTRIBUTION_PROMPT
} from './enhanced_rag_prompts.js';
import { RagAnalysisResponse } from './rag_response_parser.js';
import { RagResponseParser } from './rag_response_parser.js';
import { DiverseQueryRewriterService } from './diverse_query_rewriter_service.js';
import { callTavilyApi, WebSearchResult } from '../../integrations/tavily.js';
import { formatRetrievedContextForPrompt as formatContextForGemini } from '../../database/services/gemini-integration-modules/GeminiContextFormatter.js';
import { GeminiApiNotInitializedError } from '../../database/services/gemini-integration-modules/GeminiApiClient.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { deduplicateContexts } from '../../utils/context_utils.js';
import { getCurrentModel } from '../../database/services/gemini-integration-modules/GeminiConfig.js';
import { globalPerformanceTracker } from '../../utils/performance_tracker.js';
import { KnowledgeGraphManager } from '../../database/managers/KnowledgeGraphManager.js';
import { MultiModelOrchestrator, RagTaskType } from './multi_model_orchestrator.js';
import { parseGeminiJsonResponse, parseGeminiJsonResponseSync } from '../../database/services/gemini-integration-modules/GeminiResponseParsers.js';
import { IterativeRagCache } from './cache/iterative_rag_cache.js';
import { IterativeRagContext } from './context/iterative_rag_context.js';
import { IterativeRagPlanning } from './planning/iterative_rag_planning.js';
import { IterativeRagBatch } from './batch/iterative_rag_batch.js';
import { calculateContextQuality, extractQueryTerms } from './utils/iterative_rag_utils.js';
import {
    Citation,
    ReflectionResult,
    AgenticRagPlan,
    IterativeRagResult,
    IterativeRagArgs
} from './types/iterative_rag_types.js';

// Re-export types for external use
export type {
    Citation,
    ReflectionResult,
    AgenticRagPlan,
    IterativeRagResult,
    IterativeRagArgs
} from './types/iterative_rag_types.js';

export class IterativeRagOrchestrator {
    private memoryManagerInstance: MemoryManager;
    private geminiService: GeminiIntegrationService;
    private diverseQueryRewriterService: DiverseQueryRewriterService;
    private knowledgeGraphManager?: KnowledgeGraphManager;
    private multiModelOrchestrator: MultiModelOrchestrator;
    private cache: IterativeRagCache;
    private context: IterativeRagContext;
    private planning: IterativeRagPlanning;
    private batch: IterativeRagBatch;
    private citationIdCounter = 0;
    private hybridSearchCache: Map<string, { results: RetrievedCodeContext[]; timestamp: number; searchStrategy: string }>;
    private readonly HYBRID_CACHE_TTL = 15 * 60 * 1000;

    constructor(
        memoryManagerInstance: MemoryManager,
        geminiService: GeminiIntegrationService,
        diverseQueryRewriterService: DiverseQueryRewriterService,
        knowledgeGraphManager?: KnowledgeGraphManager
    ) {
        this.memoryManagerInstance = memoryManagerInstance;
        this.geminiService = geminiService;
        this.diverseQueryRewriterService = diverseQueryRewriterService;
        this.knowledgeGraphManager = knowledgeGraphManager;
        this.multiModelOrchestrator = new MultiModelOrchestrator(memoryManagerInstance, geminiService);
        this.cache = new IterativeRagCache();
        this.context = new IterativeRagContext(memoryManagerInstance, geminiService, knowledgeGraphManager, this.multiModelOrchestrator, this.cache);
        this.planning = new IterativeRagPlanning(this.multiModelOrchestrator, memoryManagerInstance, geminiService);
        this.batch = new IterativeRagBatch(this.multiModelOrchestrator, memoryManagerInstance, geminiService);
        this.hybridSearchCache = new Map();
    }

    private _generateCitation(context: RetrievedCodeContext, extractedText: string, confidence: number = 0.8): Citation {
        return {
            id: `cite_${++this.citationIdCounter}`,
            source: context.sourcePath,
            sourceType: context.type as Citation['sourceType'],
            title: context.entityName || context.sourcePath,
            filePath: context.sourcePath,
            lineNumbers: context.metadata?.startLine && context.metadata?.endLine ? [context.metadata.startLine, context.metadata.endLine] : undefined,
            confidence,
            relevanceScore: context.relevanceScore || 0.7,
            extractedText: extractedText.substring(0, 200),
            context: context.content.substring(0, 500),
        };
    }

    private _generateFocusString(focusArea?: string, analysisFocusPoints?: string[]): string {
        let focusString = '';
        if (focusArea) {
            if (analysisFocusPoints && analysisFocusPoints.length) {
                focusString = 'Focus on the following aspects for your analysis and response:\n' + analysisFocusPoints.map((p, i) => `${i + 1}. **${p}**`).join('\n');
            } else {
                switch (focusArea) {
                    case 'code_review':
                        focusString = 'Focus on all aspects including:\n' + '1. **Potential Bugs & Errors**\n' + '2. **Best Practices & Conventions**\n' + '3. **Performance**\n' + '4. **Security Vulnerabilities**\n' + '5. **Readability & Maintainability**';
                        break;
                    case 'code_explanation':
                        focusString = 'Explain the code clearly and concisely.';
                        break;
                    case 'enhancement_suggestions':
                        focusString = 'Suggest improvements and enhancements.';
                        break;
                    case 'bug_fixing':
                        focusString = 'Identify and suggest fixes for bugs.';
                        break;
                    case 'refactoring':
                        focusString = 'Suggest refactoring opportunities.';
                        break;
                    case 'testing':
                        focusString = 'Provide testing strategies and test case generation.';
                        break;
                    case 'documentation':
                        focusString = 'Generate or improve documentation.';
                        break;
                    case 'code_modularization_orchestration':
                        focusString = 'Discuss modularity, architecture, and orchestration patterns.';
                        break;
                    default:
                        focusString = '';
                }
            }
            if (focusString) {
                focusString = `--- Focus Area ---${focusString}`;
            }
        }
        return focusString;
    }

    async performIterativeSearch(args: IterativeRagArgs): Promise<IterativeRagResult> {
        const operationId = globalPerformanceTracker.startOperation('performIterativeSearch', { query: args.query });
        try {
            const {
                agent_id,
                query,
                model,
                max_iterations = 5,
                context_options,
                focus_area,
                analysis_focus_points,
                enable_web_search,
                google_search,
                continue_session,
                hallucination_check_threshold = 0.8,
                tavily_search_depth = 'basic',
                tavily_max_results = 5,
                tavily_include_raw_content = false,
                thinkingConfig,
                enable_dmqr,
                dmqr_query_count,
                enable_agentic_planning = false,
                enable_reflection = true,
                enable_hybrid_search = true,
                enable_long_rag = true,
                enable_corrective_rag = true,
                citation_accuracy_threshold = 0.7,
                long_rag_chunk_size = 2000,
                reflection_frequency = 1,
            } = args;
            const contextRetriever = this.memoryManagerInstance.getCodebaseContextRetrieverService();
            let accumulatedContext: RetrievedCodeContext[] = [];
            const webSearchSources: { title: string; url: string }[] = [];
            const decisionLog: RagAnalysisResponse[] = [];
            const citations: Citation[] = [];
            const reflectionResults: ReflectionResult[] = [];
            const queryHistory = new Set<string>();
            const sourceTracker = new Map<string, number>();
            let agenticPlan: AgenticRagPlan | undefined;
            const searchMetrics = {
                totalIterations: 0,
                contextItemsAdded: 0,
                webSearchesPerformed: 0,
                hallucinationChecksPerformed: 0,
                selfCorrectionLoops: 0,
                graphTraversals: 0,
                hybridSearches: 0,
                citationAccuracy: 0,
                citationCoverage: 0,
                totalCitationsGenerated: 0,
                totalCitationsUsed: 0,
                terminationReason: "In progress",
                dmqr: {
                    enabled: !!enable_dmqr,
                    queryCount: dmqr_query_count,
                    generatedQueries: [] as string[],
                    success: false,
                    contextItemsGenerated: 0,
                    error: undefined as string | undefined,
                },
                turnLog: [] as Array<{
                    turn: number;
                    query: string;
                    strategy: string;
                    newContextCount: number;
                    decision: string;
                    reasoning: string;
                    type: 'initial' | 'iterative' | 'self-correction' | 'agentic-plan' | 'reflection';
                    quality: number;
                    citations: number;
                }>,
            };
            const focusString = this._generateFocusString(focus_area, analysis_focus_points);
            console.log(`[Enhanced RAG] Starting enhanced search for query: "${query}"`);
            let baseQueries: string[] = [query];
            const initialStrategy = await this._planInitialSearchStrategy(query, context_options, model);
            console.log(`[Enhanced RAG] Initial search strategy: ${initialStrategy.strategy}, expected sources: ${initialStrategy.expectedSources}`);
            if (!enable_dmqr && initialStrategy.additionalQueries.length > 0) {
                baseQueries = [query, ...initialStrategy.additionalQueries.slice(0, 2)];
                console.log(`[Enhanced RAG] Enhanced initial queries (${baseQueries.length}): ${baseQueries.map(q => `"${q.substring(0, 40)}..."`).join(', ')}`);
            }
            if (enable_dmqr) {
                console.log('[Enhanced RAG] DMQR enabled – generating diverse queries for both embeddings and KG...');
                try {
                    const dmqrResult = await this.diverseQueryRewriterService.rewriteAndRetrieve(query, {
                        queryCount: dmqr_query_count,
                        kgQueryCount: Math.max(3, Math.floor((dmqr_query_count || 4) * 0.7)),
                    });
                    baseQueries = dmqrResult.generatedQueries;
                    searchMetrics.dmqr.generatedQueries = baseQueries;
                    searchMetrics.dmqr.success = true;
                    console.log(`[Enhanced RAG] DMQR produced ${baseQueries.length} embedding queries and ${dmqrResult.knowledgeGraphQueries?.length || 0} KG queries.`);
                    if (baseQueries.length > 1) {
                        console.log('[Enhanced RAG] Pre-fetching context for DMQR embedding queries...');
                        try {
                            const dmqrContexts = await this.context.retrieveContextWithCache(agent_id, baseQueries, context_options || {});
                            searchMetrics.dmqr.contextItemsGenerated = dmqrContexts.length;
                            console.log(`[Enhanced RAG] DMQR embedding context pre-fetching completed. Generated ${dmqrContexts.length} context items.`);
                        } catch (error) {
                            console.warn('[Enhanced RAG] DMQR embedding context pre-fetching failed:', error);
                            searchMetrics.dmqr.contextItemsGenerated = 0;
                        }
                    }
                    if (dmqrResult.knowledgeGraphQueries && dmqrResult.knowledgeGraphQueries.length > 0 && this.knowledgeGraphManager) {
                        console.log(`[Enhanced RAG] Processing ${dmqrResult.knowledgeGraphQueries.length} DMQR KG queries...`);
                        try {
                            const kgContexts: RetrievedCodeContext[] = [];
                            for (const kgQuery of dmqrResult.knowledgeGraphQueries) {
                                try {
                                    const graphResult = await this.knowledgeGraphManager.queryNaturalLanguage(agent_id, kgQuery.query);
                                    const graphData = JSON.parse(graphResult);
                                    if (graphData.results && Array.isArray(graphData.results.nodes)) {
                                        const kgNodes = graphData.results.nodes.map((node: any) => ({
                                            type: 'kg_node_info' as const,
                                            sourcePath: `kg://${node.name}`,
                                            entityName: node.name,
                                            content: JSON.stringify(node.observations),
                                            relevanceScore: kgQuery.confidence || 0.85,
                                            metadata: {
                                                nodeType: node.entityType,
                                                kgQueryType: kgQuery.searchStrategy,
                                                focusAreas: kgQuery.focusAreas,
                                            },
                                        }));
                                        kgContexts.push(...kgNodes);
                                    }
                                } catch (kgError) {
                                    console.warn(`[Enhanced RAG] KG query failed for "${kgQuery.query}":`, kgError);
                                }
                            }
                            if (kgContexts.length > 0) {
                                accumulatedContext = deduplicateContexts([...accumulatedContext, ...kgContexts]);
                                searchMetrics.dmqr.contextItemsGenerated += kgContexts.length;
                                searchMetrics.graphTraversals += dmqrResult.knowledgeGraphQueries.length;
                                console.log(`[Enhanced RAG] DMQR KG processing completed. Generated ${kgContexts.length} additional context items.`);
                            }
                        } catch (error) {
                            console.warn('[Enhanced RAG] DMQR KG processing failed:', error);
                        }
                    }
                } catch (e: any) {
                    searchMetrics.dmqr.success = false;
                    searchMetrics.dmqr.error = e.message ?? 'unknown';
                    baseQueries = [query];
                }
            }
            let currentQueries = [...baseQueries];
            let turn = 0;
            let stabilityCounter = 0;
            let noNewContextCounter = 0;
            const maxNoNewContextIterations = 2;
            while (turn < max_iterations) {
                turn++;
                searchMetrics.totalIterations = turn;
                const turnQuery = currentQueries.shift();
                if (!turnQuery) {
                    searchMetrics.terminationReason = "Exhausted all queries.";
                    break;
                }
                if (queryHistory.has(turnQuery)) {
                    console.log(`[Enhanced RAG] Skipping duplicate query: "${turnQuery}"`);
                    noNewContextCounter++;
                    if (noNewContextCounter >= maxNoNewContextIterations) {
                        searchMetrics.terminationReason = "No new context found in recent iterations - preventing infinite loop.";
                        console.log('[Enhanced RAG] Safety termination: No new context in recent iterations.');
                        break;
                    }
                    continue;
                }
                queryHistory.add(turnQuery);
                if (turn > 1 && accumulatedContext.length >= 15) {
                    const estimatedCoverage = Math.min(accumulatedContext.length / 20, 1.0);
                    if (estimatedCoverage > 0.9 && searchMetrics.citationAccuracy > 0.9) {
                        searchMetrics.terminationReason = "Exceptional quality achieved - early termination.";
                        console.log('[Enhanced RAG] Early termination: Exceptional quality and coverage achieved.');
                        break;
                    }
                }
                const isInitialTurn = baseQueries.includes(turnQuery);
                console.log(`[Enhanced RAG] Turn ${turn} – Query: "${turnQuery}" (${isInitialTurn ? 'initial' : 'iterative'})`);
                if (enable_agentic_planning && turn > 1) {
                    agenticPlan = await this.planning.performAgenticPlanning(query, turnQuery, accumulatedContext, turn, model);
                    console.log(`[Enhanced RAG] Agentic plan: ${agenticPlan.strategy}`);
                }
                const contextBefore = accumulatedContext.length;
                let rawContext: RetrievedCodeContext[] = [];
                if (enable_hybrid_search && agenticPlan?.strategy === 'hybrid_search') {
                    rawContext = await this._performHybridSearch(agent_id, turnQuery, context_options || {}, agenticPlan);
                    searchMetrics.hybridSearches++;
                } else if (agenticPlan?.strategy === 'graph_traversal' && this.knowledgeGraphManager) {
                    try {
                        const graphResult = await this.knowledgeGraphManager.queryNaturalLanguage(agent_id, turnQuery);
                        const graphData = JSON.parse(graphResult);
                        if (graphData.results && Array.isArray(graphData.results.nodes)) {
                            rawContext = graphData.results.nodes.map((node: any) => ({
                                type: 'kg_node_info' as const,
                                sourcePath: `kg://${node.name}`,
                                entityName: node.name,
                                content: JSON.stringify(node.observations),
                                relevanceScore: 0.85,
                            }));
                        }
                        searchMetrics.graphTraversals++;
                    } catch (error) {
                        console.warn('[Enhanced RAG] Graph traversal failed, falling back to vector search');
                        rawContext = await this.context.retrieveContextWithCache(agent_id, [turnQuery], context_options || {});
                    }
                } else {
                    rawContext = await this.context.retrieveContextWithCache(agent_id, [turnQuery], context_options || {});
                }
                accumulatedContext = deduplicateContexts([...accumulatedContext, ...rawContext]);
                const addedNow = accumulatedContext.length - contextBefore;
                searchMetrics.contextItemsAdded += addedNow;
                rawContext.forEach(context => {
                    const sourceKey = context.sourcePath;
                    const currentCount = sourceTracker.get(sourceKey) || 0;
                    sourceTracker.set(sourceKey, currentCount + 1);
                    const citation = this._generateCitation(context, context.content.substring(0, 200), context.relevanceScore || 0.8);
                    citations.push(citation);
                });
                const uniqueSources = sourceTracker.size;
                const totalContextItems = accumulatedContext.length;
                const sourceCoverage = uniqueSources > 0 ? uniqueSources / Math.min(totalContextItems, 24) : 0;
                console.log(`[Source Diversification] Turn ${turn}: ${uniqueSources} unique sources, ${totalContextItems} context items, coverage: ${(sourceCoverage * 100).toFixed(1)}%`);
                if (sourceCoverage < 0.4 && turn < max_iterations - 1) {
                    console.log(`[Source Diversification] Low source coverage (${(sourceCoverage * 100).toFixed(1)}%) - applying diversification strategy`);
                    const diversificationQueries = this._generateDiversificationQueries(query, sourceTracker, turn);
                    currentQueries.unshift(...diversificationQueries);
                    console.log(`[Source Diversification] Added ${diversificationQueries.length} diversification queries: ${diversificationQueries.map(q => `"${q.substring(0, 50)}..."`).join(', ')}`);
                }
                if (continue_session && (google_search || enable_web_search) && turn === 1) {
                    console.log('[Enhanced RAG] Continuation mode with web search enabled - performing web search');
                    searchMetrics.webSearchesPerformed++;
                    try {
                        const webResults = await callTavilyApi(query, {
                            search_depth: tavily_search_depth,
                            max_results: tavily_max_results,
                            include_raw_content: tavily_include_raw_content,
                        });
                        webResults.forEach((r: WebSearchResult) => {
                            webSearchSources.push({ title: r.title, url: r.url });
                            accumulatedContext.push({
                                type: 'documentation',
                                sourcePath: r.url,
                                entityName: r.title,
                                content: r.content,
                                relevanceScore: 0.95,
                            });
                            const webCitation = this._generateCitation({
                                type: 'documentation',
                                sourcePath: r.url,
                                entityName: r.title,
                                content: r.content,
                                relevanceScore: 0.95,
                            }, r.content.substring(0, 200), 0.9);
                            webCitation.sourceType = 'web';
                            webCitation.url = r.url;
                            citations.push(webCitation);
                        });
                        console.log(`[Enhanced RAG] Web search completed: added ${webResults.length} web sources to context`);
                    } catch (e: any) {
                        console.error('[Enhanced RAG] Web search failed in continuation mode:', e);
                    }
                }
                if (addedNow === 0 && !isInitialTurn && enable_corrective_rag) {
                    stabilityCounter++;
                    noNewContextCounter++;
                    if (stabilityCounter >= 2) {
                        searchMetrics.terminationReason = "Context stable, no new information found.";
                        console.log(`[Enhanced RAG] Context has been stable for ${stabilityCounter} turns. Terminating search.`);
                        break;
                    }
                    if (stabilityCounter === 1) {
                        const correctiveQuery = `Broaden search for: ${query}. Look for related concepts, alternative implementations, or background information.`;
                        currentQueries.push(correctiveQuery);
                        searchMetrics.selfCorrectionLoops++;
                        console.log('[Enhanced RAG] Applied corrective search due to no new context.');
                    }
                } else {
                    stabilityCounter = 0;
                    noNewContextCounter = 0;
                }
                const contextFlow = this.context.createContextFlow(
                    accumulatedContext,
                    turnQuery,
                    addedNow,
                    enable_long_rag,
                    long_rag_chunk_size
                );
                let analyzedContextFlow = contextFlow;
                let batchAnalysisResults: string[] = [];
                if (contextFlow.length > 1) {
                    console.log(`[Enhanced RAG] Applying consolidated batch context analysis to ALL ${contextFlow.length} contexts to minimize API usage`);
                    try {
                        const batchResult = await this.batch.processConsolidatedBatchContextAnalysis(
                            contextFlow,
                            query,
                            model,
                            turn
                        );
                        analyzedContextFlow = batchResult.analyzedContexts;
                        batchAnalysisResults = batchResult.batchAnalysis;
                        analyzedContextFlow.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
                        console.log(`[Enhanced RAG] Consolidated batch analysis completed, reordered ${analyzedContextFlow.length} contexts by relevance`);
                    } catch (batchError: any) {
                        console.warn(`[Enhanced RAG] Batch analysis failed: ${batchError.message}. Using original context flow.`);
                        analyzedContextFlow = contextFlow;
                    }
                }
                const formattedContext = formatContextForGemini(analyzedContextFlow)[0].text || '';
                const currentStrategy = agenticPlan?.strategy || 'vector_search';
                const previousQuality = reflectionResults.length > 0
                    ? reflectionResults[reflectionResults.length - 1].qualityScore
                    : calculateContextQuality(accumulatedContext, query);
                const currentCitationCoverage = Math.min(accumulatedContext.length / 8, 1.0);
                const analysisPrompt = RAG_ANALYSIS_PROMPT
                    .replace('{originalQuery}', query)
                    .replace('{currentTurn}', String(turn))
                    .replace('{maxIterations}', String(max_iterations))
                    .replace('{accumulatedContext}', formattedContext)
                    .replace('{focusString}', focusString)
                    .replace('{currentStrategy}', currentStrategy)
                    .replace('{previousQuality}', previousQuality.toString())
                    .replace('{citationCoverage}', currentCitationCoverage.toString());
                let analysisResult;
                try {
                    analysisResult = await this.multiModelOrchestrator.executeTask(
                        'decision_making',
                        analysisPrompt,
                        RAG_ANALYSIS_SYSTEM_INSTRUCTION,
                        { contextLength: analysisPrompt.length }
                    );
                } catch (e: any) {
                    searchMetrics.terminationReason = `Gemini analysis error: ${e.message}`;
                    break;
                }
                let parsed: any;
                try {
                    parsed = await RagResponseParser.parseAnalysisResponse(
                        analysisResult.content ?? '',
                        formattedContext.substring(0, 500) + '...',
                        analysisPrompt.substring(0, 200) + '...',
                        this.memoryManagerInstance,
                        this.geminiService
                    );
                } catch (enhancedParseError) {
                    console.warn('[Enhanced RAG] Enhanced parsing failed, falling back to sync parser:', enhancedParseError);
                    parsed = RagResponseParser.parseAnalysisResponseSync(
                        analysisResult.content ?? '',
                        formattedContext.substring(0, 500) + '...',
                        analysisPrompt.substring(0, 200) + '...'
                    );
                }
                if (!parsed) {
                    console.error('[Enhanced RAG] All parsing strategies failed - terminating search');
                    searchMetrics.terminationReason = 'Complete parsing failure - enhanced and fallback parsers both failed';
                    break;
                }
                if (parsed._parsing_failed) {
                    console.warn(`[Enhanced RAG] Parser used fallback: ${parsed._error_message || 'Unknown error'}`);
                    searchMetrics.terminationReason += ' (Parser fallback used)';
                } else {
                    console.log('[Enhanced RAG] Parsing successful');
                }
                decisionLog.push(parsed);
                if (enable_reflection && turn % reflection_frequency === 0) {
                    const tempAnswer = analysisResult.content || '';
                    const reflection = await this.planning.performReflection(query, contextFlow, tempAnswer, model);
                    reflectionResults.push(reflection);
                    searchMetrics.hallucinationChecksPerformed++;
                    if (reflection.missingInfo.length > 0 || reflection.hasHallucinations) {
                        const correctiveContext = await this.planning.performCorrectiveSearch(
                            agent_id,
                            query,
                            accumulatedContext,
                            reflection,
                            context_options || {},
                            model
                        );
                        if (correctiveContext.length > 0) {
                            accumulatedContext = deduplicateContexts([...accumulatedContext, ...correctiveContext]);
                            searchMetrics.selfCorrectionLoops++;
                            searchMetrics.turnLog.push({
                                turn,
                                query: turnQuery,
                                strategy: 'corrective_search',
                                newContextCount: correctiveContext.length,
                                decision: "CORRECTIVE_SEARCH",
                                reasoning: `Applied corrective search based on reflection: ${reflection.suggestions.join(', ')}`,
                                type: 'self-correction',
                                quality: reflection.qualityScore,
                                citations: correctiveContext.length,
                            });
                        }
                    }
                }
                const strategy = agenticPlan?.strategy || 'vector_search';
                const quality = reflectionResults.length > 0
                    ? reflectionResults[reflectionResults.length - 1].qualityScore
                    : 0.7;
                searchMetrics.turnLog.push({
                    turn,
                    query: turnQuery,
                    strategy,
                    newContextCount: addedNow,
                    decision: parsed.decision,
                    reasoning: parsed.reasoning,
                    type: isInitialTurn ? 'initial' : 'iterative',
                    quality,
                    citations: addedNow,
                });
                if (parsed.decision === 'ANSWER') {
                    let estimatedQuality = parsed.qualityScore;
                    if (estimatedQuality === undefined || estimatedQuality === null || isNaN(estimatedQuality)) {
                        console.warn(`[Enhanced RAG] Quality score missing from parsed response. Calculating fallback quality estimate...`);
                        estimatedQuality = calculateContextQuality(accumulatedContext, query);
                        console.log(`[Enhanced RAG] Calculated fallback quality score: ${estimatedQuality}`);
                        parsed.qualityScore = estimatedQuality;
                    }
                    const contextSufficiency = Math.min(accumulatedContext.length / 10, 1.0);
                    const iterationProgress = turn / max_iterations;
                    console.log(`[Enhanced RAG] Quality Gate Check: quality=${estimatedQuality}, context=${contextSufficiency}, iteration=${iterationProgress}`);
                    const isCodeExplanationQuery = focus_area === 'code_explanation' || query.toLowerCase().includes('function') || query.toLowerCase().includes('explain');
                    const hasMinimalContext = accumulatedContext.length < 3;
                    const lowConfidence = (parsed.confidenceScore || 1.0) < 0.4;
                    const veryLowQuality = estimatedQuality < 0.3;
                    if (turn < max_iterations && hasMinimalContext && (lowConfidence || veryLowQuality)) {
                        console.log(`[Enhanced RAG] Minimal quality gate: context=${accumulatedContext.length}, confidence=${parsed.confidenceScore}, quality=${estimatedQuality}. Continuing search.`);
                        const correctiveQuery = `Find additional comprehensive information about: ${query}. Focus on areas not yet covered in detail.`;
                        currentQueries.push(correctiveQuery);
                        searchMetrics.selfCorrectionLoops++;
                        decisionLog.push({
                            decision: 'CORRECTIVE_SEARCH' as any,
                            reasoning: `Minimal context (${accumulatedContext.length} items) with low confidence/quality. Continuing search.`,
                            nextCodebaseQuery: correctiveQuery,
                            qualityScore: estimatedQuality,
                            confidenceScore: parsed.confidenceScore || 0.5,
                            contextUsed: formattedContext.substring(0, 500) + '...',
                            promptSent: analysisPrompt.substring(0, 200) + '...',
                            rawGeminiResponse: analysisResult.content?.substring(0, 300) + '...',
                        });
                        continue;
                    } else {
                        console.log(`[Enhanced RAG] Quality gate passed: context=${accumulatedContext.length}, confidence=${parsed.confidenceScore}, quality=${estimatedQuality}. Proceeding with ANSWER.`);
                    }
                    searchMetrics.terminationReason = turn >= max_iterations
                        ? "Max iterations reached with forced answer"
                        : "ANSWER decision reached with quality gates passed";
                    console.log('[Enhanced RAG] Decision: ANSWER – generating final answer with citations.');
                    const enhancedAnswerPrompt = RAG_ANSWER_PROMPT
                        .replace('{originalQuery}', query)
                        .replace('{contextString}', formattedContext)
                        .replace('{focusString}', focusString)
                        .replace('{totalSources}', analyzedContextFlow.length.toString())
                        .replace('{searchStrategy}', 'enhanced_hybrid_search')
                        .replace('{contextQuality}', '0.85')
                        .replace('{web_search_flags}', `Web Search: ${(google_search || enable_web_search) ? 'ENABLED' : 'DISABLED'}`)
                        .replace('{continuation_mode}', `Continuation Mode: ${continue_session ? 'ACTIVE - Building on conversation history' : 'DISABLED'}`)
                        + `\n\nIMPORTANT: You have ${analyzedContextFlow.length} context sources available. Include proper citations in your answer using the format [cite_N] where N is the citation number. Strive to utilize multiple sources and provide comprehensive coverage. Each claim should be supported by specific source references.`;
                    const answerResult = await this.multiModelOrchestrator.executeTask(
                        'final_answer_generation',
                        enhancedAnswerPrompt,
                        'You are a helpful AI assistant providing accurate answers with proper citations based on the given context.',
                        { contextLength: enhancedAnswerPrompt.length }
                    );
                    const finalAnswer = answerResult.content ?? '';
                    const citationMatches = finalAnswer.match(/\[cite_\d+\]/g) || [];
                    const uniqueCitationNumbers = new Set(
                        citationMatches.map(match => {
                            const num = match.match(/\d+/)?.[0];
                            return num ? parseInt(num) : null;
                        }).filter(num => num !== null)
                    );
                    searchMetrics.citationAccuracy = citationMatches.length > 0
                        ? uniqueCitationNumbers.size / citationMatches.length
                        : (citations.length > 0 ? 0.0 : 1.0);
                    const citationCoverage = citations.length > 0
                        ? uniqueCitationNumbers.size / citations.length
                        : 1.0;
                    searchMetrics.citationCoverage = citationCoverage;
                    searchMetrics.totalCitationsGenerated = citations.length;
                    searchMetrics.totalCitationsUsed = uniqueCitationNumbers.size;
                    console.log(`[Enhanced RAG] Citation metrics: accuracy=${(searchMetrics.citationAccuracy * 100).toFixed(1)}%, coverage=${(citationCoverage * 100).toFixed(1)}%, used=${uniqueCitationNumbers.size}/${citations.length}`);
                    if (searchMetrics.citationAccuracy < 0.7 && citationCoverage < 0.5) {
                        console.info(`[Enhanced RAG] Citation info: accuracy=${(searchMetrics.citationAccuracy * 100).toFixed(1)}%, coverage=${(citationCoverage * 100).toFixed(1)}%`);
                    }
                    return {
                        accumulatedContext,
                        webSearchSources,
                        finalAnswer,
                        decisionLog,
                        citations,
                        reflectionResults,
                        agenticPlan,
                        searchMetrics,
                    };
                } else if (parsed.decision === 'SEARCH_AGAIN' && parsed.nextCodebaseQuery) {
                    currentQueries.push(parsed.nextCodebaseQuery);
                } else if (parsed.decision === 'SEARCH_WEB' && enable_web_search && parsed.nextWebQuery) {
                    searchMetrics.webSearchesPerformed++;
                    try {
                        const webResults = await callTavilyApi(parsed.nextWebQuery, {
                            search_depth: tavily_search_depth,
                            max_results: tavily_max_results,
                            include_raw_content: tavily_include_raw_content,
                        });
                        webResults.forEach((r: WebSearchResult) => {
                            webSearchSources.push({ title: r.title, url: r.url });
                            accumulatedContext.push({
                                type: 'documentation',
                                sourcePath: r.url,
                                entityName: r.title,
                                content: r.content,
                                relevanceScore: 0.95,
                            });
                            const webCitation = this._generateCitation({
                                type: 'documentation',
                                sourcePath: r.url,
                                entityName: r.title,
                                content: r.content,
                                relevanceScore: 0.95,
                            }, r.content.substring(0, 200), 0.9);
                            webCitation.sourceType = 'web';
                            webCitation.url = r.url;
                            citations.push(webCitation);
                        });
                    } catch (e: any) {
                        console.error('[Enhanced RAG] Web search failed:', e);
                    }
                }
            }
            if (searchMetrics.terminationReason === "In progress") {
                searchMetrics.terminationReason = "Max iterations reached.";
            }
            console.log('[Enhanced RAG] Generating final answer from accumulated context with citations.');
            const finalContextFlow = this.context.createContextFlow(
                accumulatedContext,
                query,
                0,
                enable_long_rag,
                long_rag_chunk_size
            );
            const fallbackContext = formatContextForGemini(finalContextFlow)[0].text || '';
            const fallbackPrompt = RAG_ANSWER_PROMPT
                .replace('{originalQuery}', query)
                .replace('{contextString}', fallbackContext)
                .replace('{focusString}', focusString)
                .replace('{totalSources}', finalContextFlow.length.toString())
                .replace('{searchStrategy}', 'fallback_search')
                .replace('{contextQuality}', '0.70')
                .replace('{web_search_flags}', `Web Search: ${(google_search || enable_web_search) ? 'ENABLED' : 'DISABLED'}`)
                .replace('{continuation_mode}', `Continuation Mode: ${continue_session ? 'ACTIVE - Building on conversation history' : 'DISABLED'}`)
                + `\n\nIMPORTANT: You have ${finalContextFlow.length} context sources available. Include proper citations in your answer using the format [cite_N] where N is the citation number. Utilize multiple sources when possible for comprehensive coverage.`;
            const fallbackResult = await this.multiModelOrchestrator.executeTask(
                'final_answer_generation',
                fallbackPrompt,
                'You are a helpful AI assistant providing accurate answers with citations based on the given context.',
                { contextLength: fallbackPrompt.length }
            );
            const finalAnswer = fallbackResult.content ?? 'Unable to formulate an answer.';
            const citationMatches = finalAnswer.match(/\[cite_\d+\]/g) || [];
            const uniqueCitationNumbers = new Set(
                citationMatches.map(match => {
                    const num = match.match(/\d+/)?.[0];
                    return num ? parseInt(num) : null;
                }).filter(num => num !== null)
            );
            searchMetrics.citationAccuracy = citationMatches.length > 0
                ? uniqueCitationNumbers.size / citationMatches.length
                : (citations.length > 0 ? 0.0 : 1.0);
            searchMetrics.citationCoverage = citations.length > 0
                ? uniqueCitationNumbers.size / citations.length
                : 1.0;
            searchMetrics.totalCitationsGenerated = citations.length;
            searchMetrics.totalCitationsUsed = uniqueCitationNumbers.size;
            const finalSourceCoverage = sourceTracker.size > 0 ? sourceTracker.size / Math.min(accumulatedContext.length, 24) : 0;
            (searchMetrics as any).sourceCoverage = finalSourceCoverage;
            (searchMetrics as any).uniqueSourcesUsed = sourceTracker.size;
            (searchMetrics as any).totalContextSources = accumulatedContext.length;
            console.log(`[Final Metrics] Source coverage: ${(finalSourceCoverage * 100).toFixed(1)}%, unique sources: ${sourceTracker.size}, total contexts: ${accumulatedContext.length}`);
            return {
                accumulatedContext,
                webSearchSources,
                finalAnswer,
                decisionLog,
                citations,
                reflectionResults,
                agenticPlan,
                searchMetrics,
            };
        } catch (error: any) {
            globalPerformanceTracker.endOperation(operationId, false, error.message);
            throw error;
        }
    }

    getPerformanceMetrics(): any {
        return globalPerformanceTracker.getSummary();
    }

    clearPerformanceMetrics(): void {
        globalPerformanceTracker.clear();
    }

    private async _planInitialSearchStrategy(
        query: string,
        contextOptions?: ContextRetrievalOptions,
        model?: string
    ): Promise<{ strategy: string; expectedSources: number; additionalQueries: string[]; confidence: number }> {
        try {
            const queryAnalysisPrompt = `Analyze this code-related query and recommend an optimal initial search strategy:Query: "${query}"**ANALYSIS FRAMEWORK:**1. **Query Classification**: Identify the type (explanation, debugging, implementation, configuration, etc.)2. **Expected Sources**: Estimate how many different code files/components should be involved3. **Search Breadth**: Determine if query needs broad exploration or focused search4. **Additional Queries**: Suggest 1-2 strategic follow-up queries to gather comprehensive context**RESPONSE FORMAT (JSON only):**{  "queryType": "explanation|debugging|implementation|configuration|general",  "strategy": "focused|broad|hybrid",  "expectedSources": 3-15,  "searchBreadth": "narrow|moderate|wide",  "additionalQueries": ["strategic query 1", "strategic query 2"],  "reasoning": "brief explanation of strategy",  "confidence": 0.0-1.0}Provide only the JSON response:`;
            const result = await this.multiModelOrchestrator.executeTask(
                'planning',
                queryAnalysisPrompt,
                undefined,
                { contextLength: queryAnalysisPrompt.length }
            );
            const response = result.content?.trim() || '{}';
            let analysis: any;
            try {
                analysis = await parseGeminiJsonResponse(response, {
                    expectedStructure: 'Initial search strategy with queryType, strategy, expectedSources, and additionalQueries',
                    contextDescription: 'Initial RAG search strategy planning',
                    memoryManager: this.memoryManagerInstance,
                    geminiService: this.geminiService,
                    enableAIRepair: true,
                });
            } catch (parseError) {
                console.warn('[Initial Strategy Planning] Enhanced parsing failed, using fallback strategy:', parseError);
                return this._getFallbackInitialStrategy(query);
            }
            return {
                strategy: analysis.strategy || 'hybrid',
                expectedSources: Math.min(Math.max(analysis.expectedSources || 5, 3), 15),
                additionalQueries: Array.isArray(analysis.additionalQueries) ? analysis.additionalQueries.slice(0, 2) : [],
                confidence: Math.min(Math.max(analysis.confidence || 0.7, 0.1), 1.0),
            };
        } catch (error) {
            console.warn('[Initial Strategy Planning] Analysis failed, using fallback:', error);
            return this._getFallbackInitialStrategy(query);
        }
    }

    private _getFallbackInitialStrategy(query: string): { strategy: string; expectedSources: number; additionalQueries: string[]; confidence: number } {
        const queryLower = query.toLowerCase();
        const isExplanationQuery = /\b(how|explain|what|describe|tell|show)\b/.test(queryLower);
        const isImplementationQuery = /\b(implement|create|build|develop|code|write)\b/.test(queryLower);
        const isDebuggingQuery = /\b(error|bug|fix|issue|problem|fail|wrong)\b/.test(queryLower);
        const mainTerms = extractQueryTerms(query).slice(0, 2);
        const additionalQueries: string[] = [];
        if (isExplanationQuery && mainTerms.length > 0) {
            additionalQueries.push(`${mainTerms[0]} usage examples and integration patterns`);
            if (mainTerms.length > 1) {
                additionalQueries.push(`${mainTerms[1]} related components and dependencies`);
            }
        } else if (isImplementationQuery && mainTerms.length > 0) {
            additionalQueries.push(`${mainTerms[0]} interfaces and base classes`);
            additionalQueries.push(`${mainTerms[0]} configuration and setup requirements`);
        } else if (isDebuggingQuery) {
            additionalQueries.push(`Common errors and troubleshooting for ${mainTerms[0] || 'this functionality'}`);
        }
        return {
            strategy: isExplanationQuery ? 'broad' : isDebuggingQuery ? 'focused' : 'hybrid',
            expectedSources: isExplanationQuery ? 8 : isDebuggingQuery ? 4 : 6,
            additionalQueries,
            confidence: 0.6,
        };
    }

    private _generateDiversificationQueries(
        originalQuery: string,
        sourceTracker: Map<string, number>,
        currentTurn: number
    ): string[] {
        const queries: string[] = [];
        const queryTerms = extractQueryTerms(originalQuery);
        const mainTerm = queryTerms[0] || 'code';
        const sourceTypes = new Map<string, number>();
        for (const [path] of sourceTracker) {
            const ext = path.split('.').pop()?.toLowerCase() || 'unknown';
            sourceTypes.set(ext, (sourceTypes.get(ext) || 0) + 1);
        }
        const targetExtensions = ['ts', 'js', 'json', 'md', 'yaml', 'yml'];
        const underrepresentedExts = targetExtensions.filter(ext => !sourceTypes.has(ext) || (sourceTypes.get(ext) || 0) < 2);
        if (underrepresentedExts.length > 0) {
            const ext = underrepresentedExts[0];
            queries.push(`Find ${mainTerm} related code or configuration in ${ext} files`);
        }
        const architecturalLayers = [
            'services and business logic',
            'data models and schemas',
            'utilities and helpers',
            'configuration and setup',
            'tests and examples',
            'interfaces and types',
        ];
        if (currentTurn <= 3) {
            const layer = architecturalLayers[Math.min(currentTurn - 1, architecturalLayers.length - 1)];
            queries.push(`${mainTerm} implementation in ${layer}`);
        }
        const semanticVariations = {
            'orchestrator': ['coordinator', 'manager', 'handler', 'processor'],
            'parse': ['decode', 'transform', 'convert', 'process'],
            'distribution': ['allocation', 'assignment', 'routing', 'dispatch'],
            'task': ['job', 'work', 'operation', 'process'],
        };
        for (const [term, variations] of Object.entries(semanticVariations)) {
            if (originalQuery.toLowerCase().includes(term)) {
                const variation = variations[currentTurn % variations.length];
                queries.push(originalQuery.replace(new RegExp(term, 'gi'), variation));
                break;
            }
        }
        if (sourceTracker.size < 5) {
            queries.push(`Related patterns and implementations for ${mainTerm}`);
        }
        return queries.slice(0, 2);
    }

    private async _performHybridSearch(
        agentId: string,
        query: string,
        options: ContextRetrievalOptions,
        plan?: AgenticRagPlan
    ): Promise<RetrievedCodeContext[]> {
        const results: RetrievedCodeContext[] = [];
        const hybridOptions = { ...options, useHybridSearch: true };
        console.log(`[Enhanced Hybrid Search] Starting hybrid search with Gemini task types for query: "${query}"`);
        const vectorSearchPromise = this.context.retrieveContextWithCache(agentId, [query], hybridOptions);
        const keywordSearchPromise = this._performEnhancedKeywordSearch(agentId, query, hybridOptions);
        const kgSearchPromise = this.knowledgeGraphManager && plan?.strategy === 'hybrid_search'
            ? this._performKnowledgeGraphSearch(agentId, query, hybridOptions)
            : Promise.resolve([]);
        try {
            const [vectorResults, keywordResults, kgResults] = await Promise.allSettled([
                vectorSearchPromise,
                keywordSearchPromise,
                kgSearchPromise,
            ]);
            if (vectorResults.status === 'fulfilled') {
                results.push(...vectorResults.value);
                console.log(`[Hybrid Search] Vector search yielded ${vectorResults.value.length} results`);
            } else {
                console.warn('[Hybrid Search] Vector search failed:', vectorResults.reason);
            }
            if (keywordResults.status === 'fulfilled') {
                results.push(...keywordResults.value);
                console.log(`[Hybrid Search] Keyword search yielded ${keywordResults.value.length} results`);
            } else {
                console.warn('[Hybrid Search] Keyword search failed:', keywordResults.reason);
            }
            if (kgResults.status === 'fulfilled') {
                results.push(...kgResults.value);
                console.log(`[Hybrid Search] KG search yielded ${kgResults.value.length} results`);
            } else if (kgResults.status === 'rejected') {
                console.warn('[Hybrid Search] KG search failed:', kgResults.reason);
            }
            const rankedResults = this._applyHybridRanking([
                vectorResults.status === 'fulfilled' ? vectorResults.value : [],
                keywordResults.status === 'fulfilled' ? keywordResults.value : [],
                kgResults.status === 'fulfilled' ? kgResults.value : [],
            ]);
            console.log(`[Enhanced Hybrid Search] Combined and ranked ${rankedResults.length} results`);
            return deduplicateContexts(rankedResults);
        } catch (error) {
            console.error('[Hybrid Search] Error during parallel search execution:', error);
            return await this._fallbackSequentialSearch(agentId, query, hybridOptions, plan);
        }
    }

    private async _performEnhancedKeywordSearch(
        agentId: string,
        query: string,
        options: ContextRetrievalOptions
    ): Promise<RetrievedCodeContext[]> {
        try {
            console.log(`[Enhanced Keyword Search] Performing keyword-based search for: "${query}"`);
            const keywordExtractionPrompt = `Extract the most important technical keywords, function names, class names, and file patterns from this query for code search. Focus on identifiers that would appear in code.Query: "${query}"Return a JSON object with "keywords" array containing the extracted terms.Example: {"keywords": ["getUserData", "UserService", "authentication", "api"]}`;
            const keywordResult = await this.multiModelOrchestrator.executeTask(
                'json_extraction',
                keywordExtractionPrompt,
                undefined,
                { contextLength: keywordExtractionPrompt.length }
            );
            let keywords: string[] = [];
            try {
                const parsed = JSON.parse(keywordResult.content || '{}');
                keywords = parsed.keywords || [];
            } catch {
                keywords = query.split(/\s+/)
                    .filter(word => word.length > 2)
                    .filter(word => /[a-zA-Z_$][\w$]*/.test(word));
            }
            if (keywords.length === 0) {
                console.log('[Enhanced Keyword Search] No keywords extracted, falling back to vector search');
                return [];
            }
            console.log(`[Enhanced Keyword Search] Using keywords: ${keywords.join(', ')}`);
            const keywordPromises = keywords.slice(0, 10).map(async (keyword) => {
                try {
                    const [embeddingResults, kgResults] = await Promise.allSettled([
                        this.context.retrieveContextWithCache(agentId, [`"${keyword}"`], options),
                        this.knowledgeGraphManager
                            ? this.knowledgeGraphManager.searchNodes(agentId, keyword).catch(() => [])
                            : Promise.resolve([]),
                    ]);
                    const results: RetrievedCodeContext[] = [];
                    if (embeddingResults.status === 'fulfilled') {
                        results.push(...embeddingResults.value);
                    }
                    if (kgResults.status === 'fulfilled' && this.knowledgeGraphManager) {
                        const kgNodes = kgResults.value;
                        if (Array.isArray(kgNodes) && kgNodes.length > 0) {
                            const kgContexts = kgNodes.map(node => ({
                                type: 'kg_node_info' as const,
                                sourcePath: `kg://${node.name}`,
                                entityName: node.name,
                                content: JSON.stringify(node.observations || []),
                                relevanceScore: 0.7,
                                metadata: { nodeType: node.entityType },
                            }));
                            results.push(...kgContexts);
                        }
                    }
                    return results;
                } catch (error) {
                    console.warn(`[Enhanced Keyword Search] Failed to search for keyword "${keyword}":`, error);
                    return [];
                }
            });
            const allResults = await Promise.all(keywordPromises);
            const flattenedResults = allResults.flat();
            const uniqueResults = deduplicateContexts(flattenedResults);
            uniqueResults.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
            console.log(`[Enhanced Keyword Search] Found ${uniqueResults.length} results for ${keywords.length} keywords`);
            return uniqueResults.slice(0, options.topKEmbeddings || 20);
        } catch (error) {
            console.error('[Enhanced Keyword Search] Error during keyword search:', error);
            return [];
        }
    }

    private async _performKnowledgeGraphSearch(
        agentId: string,
        query: string,
        options: ContextRetrievalOptions
    ): Promise<RetrievedCodeContext[]> {
        if (!this.knowledgeGraphManager) {
            return [];
        }
        try {
            console.log(`[KG Search] Performing knowledge graph search for: "${query}"`);
            const graphQuery = await this.knowledgeGraphManager.queryNaturalLanguage(agentId, query);
            const graphData = JSON.parse(graphQuery);
            if (graphData.results && Array.isArray(graphData.results.nodes)) {
                const kgResults = graphData.results.nodes.map((node: any) => ({
                    type: 'kg_node_info' as const,
                    sourcePath: `kg://${node.name}`,
                    entityName: node.name,
                    content: JSON.stringify(node.observations),
                    relevanceScore: 0.85,
                    metadata: {
                        nodeType: node.entityType,
                        searchType: 'knowledge_graph',
                    },
                }));
                console.log(`[KG Search] Found ${kgResults.length} knowledge graph results`);
                return kgResults;
            }
        } catch (error) {
            console.warn('[KG Search] Knowledge graph query failed:', error);
        }
        return [];
    }

    private _applyHybridRanking(searchResults: RetrievedCodeContext[][]): RetrievedCodeContext[] {
        const weights = { vector: 1.0, keyword: 0.8, knowledge_graph: 0.9 };
        const scores: Map<string, { score: number; context: RetrievedCodeContext }> = new Map();
        const k = 60;
        searchResults.forEach((results, searchTypeIndex) => {
            const searchTypes = ['vector', 'keyword', 'kg_node_info'];
            const currentWeight = weights[searchTypes[searchTypeIndex] as keyof typeof weights] || 1.0;
            results.forEach((context, rank) => {
                const key = `${context.sourcePath}:${context.entityName || 'default'}:${context.content.substring(0, 100)}`;
                const rrfScore = currentWeight * (1 / (k + rank + 1));
                if (scores.has(key)) {
                    const existing = scores.get(key)!;
                    existing.score += rrfScore;
                } else {
                    scores.set(key, {
                        score: rrfScore,
                        context: {
                            ...context,
                            relevanceScore: rrfScore,
                        },
                    });
                }
            });
        });
        return Array.from(scores.values())
            .sort((a, b) => b.score - a.score)
            .map(item => item.context);
    }

    private async _fallbackSequentialSearch(
        agentId: string,
        query: string,
        options: ContextRetrievalOptions,
        plan?: AgenticRagPlan
    ): Promise<RetrievedCodeContext[]> {
        console.log('[Hybrid Search] Executing fallback sequential search');
        const results: RetrievedCodeContext[] = [];
        try {
            const vectorResults = await this.context.retrieveContextWithCache(agentId, [query], options);
            results.push(...vectorResults);
            const keywordResults = await this._performEnhancedKeywordSearch(agentId, query, options);
            results.push(...keywordResults);
            return deduplicateContexts(results);
        } catch (error) {
            console.error('[Hybrid Search] Fallback search also failed:', error);
            return [];
        }
    }
}
