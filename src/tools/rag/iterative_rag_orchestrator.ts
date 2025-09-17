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
                    type: 'initial' | 'iterative' | 'self-correction' | 'agentic-plan' | 'reflection' | 'early_termination' | 'stability_termination' | 'hybrid_intervention' | 'hybrid_override';
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
            // Progressive DMQR: Generate diverse queries for iterative use
            let dmqrQueries: string[] = [];
            let dmqrKgQueries: any[] = [];
            let dmqrUsedCount = 0;

            if (enable_dmqr) {
                console.log('[Enhanced RAG] DMQR enabled – generating diverse queries for progressive iteration use...');
                try {
                    const dmqrResult = await this.diverseQueryRewriterService.rewriteAndRetrieve(query, {
                        queryCount: dmqr_query_count,
                        kgQueryCount: Math.max(3, Math.floor((dmqr_query_count || 4) * 0.7)),
                    });
                    dmqrQueries = dmqrResult.generatedQueries || [];
                    dmqrKgQueries = dmqrResult.knowledgeGraphQueries || [];
                    searchMetrics.dmqr.generatedQueries = dmqrQueries;
                    searchMetrics.dmqr.success = true;
                    console.log(`[Enhanced RAG] DMQR generated ${dmqrQueries.length} embedding queries and ${dmqrKgQueries.length} KG queries for progressive use across iterations.`);
                } catch (e: any) {
                    searchMetrics.dmqr.success = false;
                    searchMetrics.dmqr.error = e.message ?? 'unknown';
                    console.warn('[Enhanced RAG] DMQR generation failed:', e.message);
                }
            }
            // Start with original query, DMQR queries will be used progressively
            let currentQueries = [query];
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
                // Let AI make decisions naturally - quality validation happens at final answer stage
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
                // Enhanced context stability detection (but let AI decide when to stop)
                if (addedNow === 0 && !isInitialTurn && enable_corrective_rag) {
                    stabilityCounter++;
                    noNewContextCounter++;

                    // Only apply corrective search, let AI decide when to terminate
                    if (stabilityCounter >= 2) {
                        searchMetrics.terminationReason = "Context stable, no new information found.";
                        console.log(`[Enhanced RAG] Context has been stable for ${stabilityCounter} turns. Terminating search.`);
                        break;
                    }
                }

                // Safety termination: Force answer after iteration 5 if we have decent context (but not if recent override occurred)
                const currentBaseQuality = calculateContextQuality(accumulatedContext, query);
                const recentOverride = searchMetrics.turnLog.length > 0 &&
                    searchMetrics.turnLog[searchMetrics.turnLog.length - 1]?.type === 'hybrid_override';

                if (turn >= 5 && accumulatedContext.length >= 5 && currentBaseQuality >= 0.6 && !recentOverride) {
                    searchMetrics.terminationReason = "Safety termination: sufficient context after 5 iterations";
                    console.log(`[Enhanced RAG] Safety termination: iteration ${turn} with ${accumulatedContext.length} sources and quality ${currentBaseQuality.toFixed(3)}. Forcing answer generation.`);
                    break;
                } else if (recentOverride && turn >= 5) {
                    console.log(`[Enhanced RAG] Recent hybrid override detected - allowing extended search beyond iteration 5 for quality improvement.`);
                }

                if (addedNow === 0 && !isInitialTurn && enable_corrective_rag) {
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
                // Enhanced process awareness context building
                const currentStrategy = agenticPlan?.strategy || 'vector_search';
                const previousQuality = reflectionResults.length > 0
                    ? reflectionResults[reflectionResults.length - 1].qualityScore
                    : calculateContextQuality(accumulatedContext, query);
                const currentCitationCoverage = Math.min(accumulatedContext.length / 8, 1.0);
                // DMQR-aware quality calculation
                const baseQuality = calculateContextQuality(accumulatedContext, query);
                const dmqrQualityBonus = enable_dmqr && searchMetrics.dmqr.success ?
                    Math.min(0.15, (dmqrQueries.length / 10) * 0.05) : 0; // Up to 15% bonus for DMQR multi-angle approach
                const currentQuality = Math.min(baseQuality + dmqrQualityBonus, 1.0);
                const remainingIterations = max_iterations - turn;
                const searchProgress = `${Math.round((turn / max_iterations) * 100)}% complete`;

                // Build iteration history
                const iterationHistory = searchMetrics.turnLog.map((turnEntry, idx) => {
                    const iterationNum = idx + 1;
                    const outcome = turnEntry.decision === 'SEARCH_AGAIN' ? 'Continued search' : 'Generated answer';
                    const qualityChange = idx > 0 ?
                        (turnEntry.quality - searchMetrics.turnLog[idx - 1].quality >= 0 ? '📈' : '📉') : '🔄';
                    return `  Iteration ${iterationNum}: ${turnEntry.decision} (${qualityChange} quality: ${turnEntry.quality.toFixed(2)}) - ${outcome}`;
                }).join('\n');

                // Build search history
                const searchHistory = searchMetrics.turnLog.map((turnEntry, idx) => {
                    return `  • "${turnEntry.query}" → ${turnEntry.newContextCount} new sources (${turnEntry.strategy})`;
                }).join('\n');

                // Enhanced quality progression tracking with actionable insights
                const qualityTrend = searchMetrics.turnLog.length > 1 ?
                    (() => {
                        const qualities = searchMetrics.turnLog.map(t => t.quality);
                        const firstQuality = qualities[0];
                        const lastQuality = qualities[qualities.length - 1];
                        const change = lastQuality - firstQuality;
                        const trend = change > 0.1 ? 'improving' : change < -0.1 ? 'declining' : 'stable';

                        // Detect stagnation (quality not improving for 2+ iterations)
                        const isStagnant = qualities.length >= 3 &&
                            Math.abs(qualities[qualities.length - 1] - qualities[qualities.length - 2]) < 0.05 &&
                            Math.abs(qualities[qualities.length - 2] - qualities[qualities.length - 3]) < 0.05;

                        if (trend === 'improving') return `📈 Improving (+'+(change*100).toFixed(1)+'%) - Search strategy is working`;
                        if (trend === 'declining') return `📉 Declining ('+(change*100).toFixed(1)+'%) - ⚠️ Consider strategy change`;
                        if (isStagnant) return `⚠️ Stagnant quality for 2+ iterations - NEED different search approach`;
                        return `➡️ Stable (±'+(Math.abs(change)*100).toFixed(1)+'%) - Consistent but may need refinement`;
                    })()
                    : '🔄 Initial iteration - establishing baseline quality';

                // Strategy evolution
                const strategies = searchMetrics.turnLog.map(t => t.strategy);
                const strategyEvolution = [...new Set(strategies)].join(' → ');

                // Quality progression
                const qualities = searchMetrics.turnLog.map(t => t.quality.toFixed(2));
                const qualityProgression = qualities.join(' → ');

                // Intelligent gap analysis based on query type and current context
                const identifiedGaps = (() => {
                    if (turn === 1) return 'Initial search - gap analysis will be performed after first iteration';

                    const contextEntities = accumulatedContext.map(c => c.entityName || '').filter(Boolean);
                    const uniqueFiles = [...new Set(accumulatedContext.map(c => c.sourcePath))];
                    const gaps = [];

                    // Query-specific gap analysis
                    if (query.toLowerCase().includes('function') || query.toLowerCase().includes('method')) {
                        const hasImplementations = accumulatedContext.some(c => c.content?.includes('function ') || c.content?.includes('method '));
                        if (!hasImplementations) gaps.push('Missing method/function implementations');
                    }

                    if (query.toLowerCase().includes('class') || query.toLowerCase().includes('component')) {
                        const hasClassDefinitions = accumulatedContext.some(c => c.content?.includes('class ') || c.content?.includes('export class'));
                        if (!hasClassDefinitions) gaps.push('Missing class definitions/constructors');
                    }

                    if (query.toLowerCase().includes('how') || query.toLowerCase().includes('usage')) {
                        const hasUsageExamples = accumulatedContext.some(c => c.content?.includes('example') || c.content?.includes('usage'));
                        if (!hasUsageExamples) gaps.push('Missing usage examples/documentation');
                    }

                    // Context quality gaps
                    if (accumulatedContext.length < 5) gaps.push('Insufficient context volume (need more sources)');
                    if (uniqueFiles.length < 3) gaps.push('Limited file diversity (need broader codebase coverage)');
                    if (contextEntities.length < 3) gaps.push('Few identified entities (need more specific implementations)');

                    return gaps.length > 0 ?
                        `Critical gaps identified after ${turn - 1} iteration(s):
  • ${gaps.join('\n  • ')}` :
                        `Good coverage after ${turn - 1} iteration(s) - context appears comprehensive`;
                })();

                // Smart priority areas based on gaps and remaining iterations
                const priorityAreas = (() => {
                    if (remainingIterations === 0) return 'FINAL ITERATION - Must provide comprehensive answer with current context';
                    if (remainingIterations === 1) return 'LAST CHANCE - Focus on the most critical missing piece for a complete answer';

                    const baseContextQuality = calculateContextQuality(accumulatedContext, query);
                    const dmqrBonus = enable_dmqr && searchMetrics.dmqr.success ? Math.min(0.15, (dmqrQueries.length / 10) * 0.05) : 0;
                    const contextQuality = Math.min(baseContextQuality + dmqrBonus, 1.0);
                    if (contextQuality < 0.4) return `LOW QUALITY (${(contextQuality*100).toFixed(0)}%) - Priority: Find core implementations and definitions`;
                    if (contextQuality < 0.7) return `MODERATE QUALITY (${(contextQuality*100).toFixed(0)}%) - Priority: Add usage examples and architectural context`;
                    return `GOOD QUALITY (${(contextQuality*100).toFixed(0)}%) - Priority: Enhance with edge cases and advanced features`;
                })();

                // Generate intelligent recommendation
                const intelligentRecommendation = (() => {
                    if (currentQuality >= 0.8) return "🎯 ANSWER NOW - High quality context";
                    if (currentQuality >= 0.7 && turn >= 3) return "✅ ANSWER NOW - Good enough context";
                    if (turn >= 4) return "⏰ ANSWER NOW - Time limit reached";
                    if (accumulatedContext.length >= 10) return "📚 ANSWER NOW - Sufficient volume";
                    if (recentOverride) return "🔄 Continue searching - Recent override requires improvement";
                    return "🔍 Continue searching - Gaps remain";
                })();

                const analysisPrompt = RAG_ANALYSIS_PROMPT
                    .replace('{originalQuery}', query)
                    .replace('{currentTurn}', String(turn))
                    .replace('{maxIterations}', String(max_iterations))
                    .replace('{remainingIterations}', String(remainingIterations))
                    .replace('{searchProgress}', searchProgress)
                    .replace('{iterationHistory}', iterationHistory)
                    .replace('{accumulatedContext}', formattedContext)
                    .replace('{focusString}', focusString)
                    .replace('{currentStrategy}', currentStrategy)
                    .replace('{previousQuality}', previousQuality.toString())
                    .replace('{currentQuality}', currentQuality.toString())
                    .replace('{contextCount}', String(accumulatedContext.length))
                    .replace('{citationCoverage}', currentCitationCoverage.toString())
                    .replace('{qualityTrend}', qualityTrend)
                    .replace('{searchHistory}', searchHistory)
                    .replace('{identifiedGaps}', identifiedGaps)
                    .replace('{strategyEvolution}', strategyEvolution)
                    .replace('{qualityProgression}', qualityProgression)
                    .replace('{priorityAreas}', priorityAreas)
                    .replace('{contextQuality >= 0.8 ? "🎯 ANSWER NOW - High quality context" : contextQuality >= 0.6 && currentTurn >= 2 ? "✅ ANSWER NOW - Good enough context" : currentTurn >= 3 ? "⏰ ANSWER NOW - Time limit reached" : "🔍 Continue searching - Gaps remain"}', intelligentRecommendation);

                // Enhanced search effectiveness + DMQR strategy guidance
                const searchEffectivenessInsight = turn > 1 ?
                    `\n\n🎯 **SEARCH EFFECTIVENESS ANALYSIS:**
• **Last Search:** "${searchMetrics.turnLog[turn-2]?.query}" yielded ${searchMetrics.turnLog[turn-2]?.newContextCount || 0} sources
• **Quality Impact:** ${searchMetrics.turnLog[turn-2]?.quality > (searchMetrics.turnLog[turn-3]?.quality || 0) ? 'Positive ✅' : 'Minimal ⚠️'}
• **Strategy Used:** ${searchMetrics.turnLog[turn-2]?.strategy}
• **Lesson:** ${searchMetrics.turnLog[turn-2]?.newContextCount > 2 ? 'Effective query - similar precision recommended' : 'Low yield - try more specific or different approach'}
• **Next Focus:** ${currentQuality < 0.6 ? 'CRITICAL - Need foundational implementations' : currentQuality < 0.8 ? 'Build on existing context with examples' : 'Add advanced details and edge cases'}` :
                    '';

                // DMQR Strategy Guidance for AI
                const dmqrGuidance = enable_dmqr && dmqrQueries.length > 0 ?
                    `\n\n🎆 **DMQR MULTI-ANGLE STRATEGIES AVAILABLE:**
DMQR generated ${dmqrQueries.length} strategic search angles (quality bonus: +${(dmqrQualityBonus * 100).toFixed(1)}%). Choose the most relevant strategy:
${dmqrQueries.map((query, idx) => `  ${idx + 1}. "${query.substring(0, 80)}..."`).join('\n')}

🧠 **INTELLIGENT QUERY GENERATION:**
- **Don't copy DMQR queries directly** - use them as strategic inspiration
- **Combine DMQR angle + your gap analysis** = targeted query
- **Example:** If DMQR suggests "architecture patterns" and you need "class constructors" → "ClassName constructor and initialization patterns"
- **Strategy Selection:** Pick the DMQR angle that best addresses your #1 critical gap
- **Quality Impact:** Using DMQR strategies boosts context quality due to multi-angle coverage` :
                    '';

                const finalPrompt = analysisPrompt + searchEffectivenessInsight + dmqrGuidance;

                console.log(`[Enhanced RAG] Iteration ${turn}/${max_iterations} - Process-aware analysis with ${accumulatedContext.length} sources, quality: ${currentQuality.toFixed(2)}${enable_dmqr ? ` (base: ${baseQuality.toFixed(2)}, DMQR bonus: +${(dmqrQualityBonus * 100).toFixed(1)}%)` : ''}`);
                let analysisResult;
                try {
                    analysisResult = await this.multiModelOrchestrator.executeTask(
                        'decision_making',
                        finalPrompt,
                        RAG_ANALYSIS_SYSTEM_INSTRUCTION,
                        { contextLength: finalPrompt.length }
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
                        finalPrompt.substring(0, 200) + '...',
                        this.memoryManagerInstance,
                        this.geminiService
                    );
                } catch (enhancedParseError) {
                    console.warn('[Enhanced RAG] Enhanced parsing failed, falling back to sync parser:', enhancedParseError);
                    parsed = RagResponseParser.parseAnalysisResponseSync(
                        analysisResult.content ?? '',
                        formattedContext.substring(0, 500) + '...',
                        finalPrompt.substring(0, 200) + '...'
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
                    // Hybrid Validation: AI decided ANSWER, now our logic validates the quality
                    const isCodeExplanationQuery = focus_area === 'code_explanation' || query.toLowerCase().includes('function') || query.toLowerCase().includes('explain');
                    const hasMinimalContext = accumulatedContext.length < 6; // Slightly stricter
                    const lowConfidence = (parsed.confidenceScore || 1.0) < 0.6; // Slightly stricter
                    const poorQuality = estimatedQuality < 0.55; // Slightly stricter but not too strict
                    const hasAcceptableQuality = estimatedQuality >= 0.65;
                    const hasGoodContext = accumulatedContext.length >= 8;

                    let answerResult: { content?: string } | null = null;

                    // Pre-calculate citation quality for hybrid validation
                    const preliminaryCitationMatches: string[] = (analysisResult?.content ?? '').match(/\[cite_\d+\]/g) ?? [];
                    const preliminaryCitationNumbers = preliminaryCitationMatches
                        .map((match: string): number | null => {
                            const digits = match.match(/\d+/)?.[0];
                            return digits ? parseInt(digits, 10) : null;
                        })
                        .filter((citationNumber): citationNumber is number => citationNumber !== null);
                    const preliminaryValidCitations = preliminaryCitationNumbers.filter(
                        (citationNumber: number) => citationNumber >= 1 && citationNumber <= citations.length
                    );
                    const preliminaryValidUniqueCitations = new Set<number>(preliminaryValidCitations);
                    const preliminaryCitationAccuracy = preliminaryCitationMatches.length > 0
                        ? preliminaryValidUniqueCitations.size / preliminaryCitationMatches.length
                        : 1.0;
                    const preliminaryCitationCoverage = citations.length > 0
                        ? preliminaryValidUniqueCitations.size / citations.length
                        : 1.0;
                    const preliminaryCitationQuality = (preliminaryCitationAccuracy * 0.6) + (preliminaryCitationCoverage * 0.4);

                    // Enhanced hybrid validation including citation quality
                    const citationQualityPoor = preliminaryCitationQuality < citation_accuracy_threshold;
                    const qualityValidationFailed = poorQuality || (hasMinimalContext && lowConfidence) || citationQualityPoor;
                    const shouldOverrideAnswer = turn < max_iterations && qualityValidationFailed;

                    if (citationQualityPoor) {
                        console.warn(`[Citation Quality Check] Poor citation quality detected: ${(preliminaryCitationQuality * 100).toFixed(1)}% (threshold: ${(citation_accuracy_threshold * 100).toFixed(1)}%) - accuracy: ${(preliminaryCitationAccuracy * 100).toFixed(1)}%, coverage: ${(preliminaryCitationCoverage * 100).toFixed(1)}%`);
                    }

                    if (shouldOverrideAnswer) {
                        const overrideReasons = [];
                        if (poorQuality) overrideReasons.push(`low quality (${estimatedQuality.toFixed(2)})`);
                        if (hasMinimalContext && lowConfidence) overrideReasons.push(`insufficient context (${accumulatedContext.length}) + low confidence (${parsed.confidenceScore})`);
                        if (citationQualityPoor) overrideReasons.push(`poor citations (${(preliminaryCitationQuality * 100).toFixed(1)}%)`);

                        console.log(`[Hybrid Validation] Overriding AI ANSWER decision due to: ${overrideReasons.join(', ')}. Triggering additional search.`);

                        // Create override decision for the turn log
                        searchMetrics.turnLog[searchMetrics.turnLog.length - 1] = {
                            ...searchMetrics.turnLog[searchMetrics.turnLog.length - 1],
                            decision: 'SEARCH_AGAIN',
                            reasoning: `Original AI decision: ANSWER. Hybrid validation override: ${overrideReasons.join(', ')}. Triggering additional search for better coverage.`,
                            type: 'hybrid_override' as const,
                        };

                        const correctiveQuery = `Find additional comprehensive information about: ${query}. Focus on areas not yet covered in detail to improve answer quality.`;
                        currentQueries.push(correctiveQuery);
                        searchMetrics.selfCorrectionLoops++;

                        decisionLog.push({
                            decision: 'SEARCH_AGAIN',
                            reasoning: `Hybrid validation override: AI chose ANSWER but validation failed due to: ${overrideReasons.join(', ')}. Continuing search for better quality.`,
                            nextCodebaseQuery: correctiveQuery,
                            qualityScore: estimatedQuality,
                            confidenceScore: parsed.confidenceScore || 0.5,
                            contextUsed: formattedContext.substring(0, 500) + '...',
                            promptSent: analysisPrompt.substring(0, 200) + '...',
                            rawGeminiResponse: analysisResult.content?.substring(0, 300) + '...',
                        });
                        continue;
                    } else {
                        console.log(`[Hybrid Validation] AI ANSWER decision validated: quality=${estimatedQuality.toFixed(2)}, context=${accumulatedContext.length}, confidence=${parsed.confidenceScore}, citations=${(preliminaryCitationQuality * 100).toFixed(1)}%. Proceeding with answer generation.`);
                    }
                    searchMetrics.terminationReason = turn >= max_iterations
                        ? "Max iterations reached with forced answer"
                        : "ANSWER decision reached with quality gates passed";
                    console.log('[Enhanced RAG] Decision: ANSWER – generating final answer with citations.');
                    const totalSources = analyzedContextFlow.length;
                    const minSourcesRequired = Math.max(1, Math.ceil(totalSources * 0.5)); // 50% minimum
                    const optimalSourcesRequired = Math.max(1, Math.ceil(totalSources * 0.7)); // 70% optimal

                    const enhancedAnswerPrompt = RAG_ANSWER_PROMPT
                        .replace('{originalQuery}', query)
                        .replace('{contextString}', formattedContext)
                        .replace('{focusString}', focusString)
                        .replace(/{totalSources}/g, totalSources.toString())
                        .replace(/{minSourcesRequired}/g, minSourcesRequired.toString())
                        .replace(/{optimalSourcesRequired}/g, optimalSourcesRequired.toString())
                        .replace(/{invalidNumber}/g, (totalSources + 1).toString())
                        .replace('{searchStrategy}', 'enhanced_hybrid_search')
                        .replace('{contextQuality}', '0.85')
                        .replace('{web_search_flags}', `Web Search: ${(google_search || enable_web_search) ? 'ENABLED' : 'DISABLED'}`)
                        .replace('{continuation_mode}', `Continuation Mode: ${continue_session ? 'ACTIVE - Building on conversation history' : 'DISABLED'}`)
                        + `\n\n🎯 **ENHANCED CITATION REQUIREMENTS:**\n- Available sources: ${totalSources} (use [cite_1] through [cite_${totalSources}] ONLY)\n- Minimum required: ${minSourcesRequired} sources (${Math.round((minSourcesRequired/totalSources)*100)}% coverage)\n- Optimal target: ${optimalSourcesRequired} sources (${Math.round((optimalSourcesRequired/totalSources)*100)}% coverage)\n- ⚠️ CRITICAL: Never use [cite_0] or [cite_${totalSources + 1}+] - these are INVALID\n- Each technical claim needs immediate citation [cite_N]\n- Avoid duplicate citations in same paragraph\n- Quality over quantity: Use accurate, relevant citations`;
                    answerResult = await this.multiModelOrchestrator.executeTask(
                        'final_answer_generation',
                        enhancedAnswerPrompt,
                        'You are a helpful AI assistant providing accurate answers with proper citations based on the given context.',
                        { contextLength: enhancedAnswerPrompt.length }
                    );
                    const finalAnswer = answerResult?.content ?? '';
                    // Enhanced citation validation with validity checking
                    const citationMatches = finalAnswer.match(/\[cite_\d+\]/g) || [];
                    const citationNumbers = citationMatches.map(match => {
                        const num = match.match(/\d+/)?.[0];
                        return num ? parseInt(num) : null;
                    }).filter(num => num !== null);

                    const uniqueCitationNumbers = new Set(citationNumbers);

                    // Check citation validity - citations must be within available range
                    const validCitations = citationNumbers.filter(num => num >= 1 && num <= citations.length);
                    const invalidCitations = citationNumbers.filter(num => num < 1 || num > citations.length);

                    // Enhanced accuracy: (valid unique citations) / (total citations used)
                    const validUniqueCitations = new Set(validCitations);
                    searchMetrics.citationAccuracy = citationMatches.length > 0
                        ? validUniqueCitations.size / citationMatches.length
                        : (citations.length > 0 ? 0.0 : 1.0);

                    // Log citation validation details
                    if (invalidCitations.length > 0) {
                        console.warn(`[Citation Validation] Invalid citations found: [${invalidCitations.map(n => `cite_${n}`).join(', ')}] - only ${citations.length} sources available`);
                    }
                    if (citationNumbers.length !== validUniqueCitations.size) {
                        console.info(`[Citation Validation] Duplicate/invalid citations: ${citationNumbers.length - validUniqueCitations.size} out of ${citationNumbers.length}`);
                    }
                    // Enhanced coverage calculation using valid citations only
                    const citationCoverage = citations.length > 0
                        ? validUniqueCitations.size / citations.length
                        : 1.0;
                    searchMetrics.citationCoverage = citationCoverage;
                    searchMetrics.totalCitationsGenerated = citations.length;
                    searchMetrics.totalCitationsUsed = validUniqueCitations.size;

                    // Calculate citation quality score combining accuracy and coverage
                    const citationQualityScore = (searchMetrics.citationAccuracy * 0.6) + (citationCoverage * 0.4);

                    // Enhanced citation quality feedback
                    if (citationQualityScore < 0.5) {
                        console.warn(`[Citation Quality] Low citation quality: ${(citationQualityScore * 100).toFixed(1)}% (accuracy: ${(searchMetrics.citationAccuracy * 100).toFixed(1)}%, coverage: ${(citationCoverage * 100).toFixed(1)}%)`);
                    }
                    console.log(`[Enhanced RAG] Citation metrics: accuracy=${(searchMetrics.citationAccuracy * 100).toFixed(1)}%, coverage=${(citationCoverage * 100).toFixed(1)}%, used=${validUniqueCitations.size}/${citations.length}`);
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
            const fallbackTotalSources = finalContextFlow.length;
            const fallbackMinSourcesRequired = Math.max(1, Math.ceil(fallbackTotalSources * 0.5));
            const fallbackOptimalSourcesRequired = Math.max(1, Math.ceil(fallbackTotalSources * 0.7));

            const fallbackPrompt = RAG_ANSWER_PROMPT
                .replace('{originalQuery}', query)
                .replace('{contextString}', fallbackContext)
                .replace('{focusString}', focusString)
                .replace(/{totalSources}/g, fallbackTotalSources.toString())
                .replace(/{minSourcesRequired}/g, fallbackMinSourcesRequired.toString())
                .replace(/{optimalSourcesRequired}/g, fallbackOptimalSourcesRequired.toString())
                .replace(/{invalidNumber}/g, (fallbackTotalSources + 1).toString())
                .replace('{searchStrategy}', 'fallback_search')
                .replace('{contextQuality}', '0.70')
                .replace('{web_search_flags}', `Web Search: ${(google_search || enable_web_search) ? 'ENABLED' : 'DISABLED'}`)
                .replace('{continuation_mode}', `Continuation Mode: ${continue_session ? 'ACTIVE - Building on conversation history' : 'DISABLED'}`)
                + `\n\n🎯 **FALLBACK CITATION REQUIREMENTS:**\n- Available sources: ${fallbackTotalSources} (use [cite_1] through [cite_${fallbackTotalSources}] ONLY)\n- Minimum required: ${fallbackMinSourcesRequired} sources (${Math.round((fallbackMinSourcesRequired/fallbackTotalSources)*100)}% coverage)\n- ⚠️ CRITICAL: Never use [cite_0] or [cite_${fallbackTotalSources + 1}+] - these are INVALID\n- Each technical claim needs citation [cite_N]\n- Focus on accuracy over quantity`;
            const fallbackResult = await this.multiModelOrchestrator.executeTask(
                'final_answer_generation',
                fallbackPrompt,
                'You are a helpful AI assistant providing accurate answers with citations based on the given context.',
                { contextLength: fallbackPrompt.length }
            );
            const finalAnswer = fallbackResult.content ?? 'Unable to formulate an answer.';
            // Enhanced fallback citation validation
            const citationMatches = finalAnswer.match(/\[cite_\d+\]/g) || [];
            const citationNumbers = citationMatches.map(match => {
                const num = match.match(/\d+/)?.[0];
                return num ? parseInt(num) : null;
            }).filter(num => num !== null);

            const validCitations = citationNumbers.filter(num => num >= 1 && num <= citations.length);
            const validUniqueCitations = new Set(validCitations);

            searchMetrics.citationAccuracy = citationMatches.length > 0
                ? validUniqueCitations.size / citationMatches.length
                : (citations.length > 0 ? 0.0 : 1.0);
            searchMetrics.citationCoverage = citations.length > 0
                ? validUniqueCitations.size / citations.length
                : 1.0;
            searchMetrics.totalCitationsGenerated = citations.length;
            searchMetrics.totalCitationsUsed = validUniqueCitations.size;
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
