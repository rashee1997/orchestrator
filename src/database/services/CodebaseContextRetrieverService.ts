import { MemoryManager } from '../memory_manager.js';
import { CodebaseEmbeddingService } from './CodebaseEmbeddingService.js';
import { IKnowledgeGraphManager } from '../factories/KnowledgeGraphFactory.js';
import { GeminiIntegrationService } from './GeminiIntegrationService.js';
import { PlanTaskManager } from '../managers/PlanTaskManager.js';
import { parseGeminiJsonResponse, parseGeminiJsonResponseSync } from './gemini-integration-modules/GeminiResponseParsers.js';
import { getCurrentModel } from './gemini-integration-modules/GeminiConfig.js';

export interface ContextRetrievalOptions {
    topKEmbeddings?: number;
    kgQueryDepth?: number;
    includeFileContent?: boolean;
    targetFilePaths?: string[];
    targetEntityNames?: string[];
    topKKgResults?: number;
    embeddingScoreThreshold?: number;
    useHybridSearch?: boolean;
    enableReranking?: boolean;
    maxContextLength?: number;
    // taskType?: 'RETRIEVAL_QUERY' | 'RETRIEVAL_DOCUMENT' | 'CODE_RETRIEVAL_QUERY' | 'SEMANTIC_SIMILARITY' | 'CLASSIFICATION'; // COMMENTED OUT
    // enableKeywordSearch?: boolean; // COMMENTED OUT
    // keywordWeight?: number; // COMMENTED OUT
    // enableBatchProcessing?: boolean; // COMMENTED OUT
}

export interface RetrievedCodeContext {
    type: 'file_snippet' | 'function_definition' | 'class_definition' | 'interface_definition' | 'enum_definition' | 'type_alias_definition' | 'variable_definition' | 'kg_node_info' | 'directory_structure' | 'import_statement' | 'generic_code_chunk' | 'documentation' | 'task_log';
    sourcePath: string;
    entityName: string | undefined;
    content: string;
    relevanceScore: number | undefined;
    metadata?: {
        startLine?: number;
        endLine?: number;
        language?: string;
        kgNodeType?: string;
        importance_score?: number;
        code_type?: string;
        [key: string]: any;
    };
}

interface KGNode {
    node_id: string;
    name: string;
    entityType: string;
    observations: string[];
}

type QueryIntent = 'find_example' | 'refactor_code' | 'debug_error' | 'add_feature' | 'understand_code' | 'general_query';

export class CodebaseContextRetrieverService {
    private memoryManager: MemoryManager;
    private embeddingService: CodebaseEmbeddingService;
    private kgManager: IKnowledgeGraphManager;
    private geminiService: GeminiIntegrationService;
    private planTaskManager: PlanTaskManager;
    private contextCache: Map<string, { timestamp: number; data: RetrievedCodeContext[]; }>;
    private cacheTTL: number;
    private maxCacheSize: number;
    private retrievalTimeout: number;

    constructor(memoryManager: MemoryManager) {
        this.memoryManager = memoryManager;
        this.embeddingService = memoryManager.getCodebaseEmbeddingService();
        this.kgManager = memoryManager.knowledgeGraphManager;
        this.geminiService = memoryManager.getGeminiIntegrationService();
        this.planTaskManager = memoryManager.planTaskManager;
        this.contextCache = new Map<string, { timestamp: number; data: RetrievedCodeContext[]; }>();
        this.cacheTTL = 5 * 60 * 1000; // 5 minutes
        this.maxCacheSize = 1000;
        this.retrievalTimeout = 120000; // 120 seconds - increased from 100s
    }

    private _generateCacheKey(agentId: string, prompt: string, options: ContextRetrievalOptions): string {
        // Enhanced cache key to include all relevant options
        const optionsStr = JSON.stringify({
            topKEmbeddings: options.topKEmbeddings,
            kgQueryDepth: options.kgQueryDepth,
            topKKgResults: options.topKKgResults,
            targetFilePaths: options.targetFilePaths?.sort(),
            embeddingScoreThreshold: options.embeddingScoreThreshold,
            useHybridSearch: options.useHybridSearch,
            enableReranking: options.enableReranking
        });
        return `${agentId}:${prompt}:${optionsStr}`;
    }

    private _isCacheValid(timestamp: number): boolean {
        return (Date.now() - timestamp) < this.cacheTTL;
    }

    private _cleanupCache(): void {
        if (this.contextCache.size > this.maxCacheSize) {
            const entries = Array.from(this.contextCache.entries());
            entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
            const toRemove = entries.slice(0, Math.floor(this.maxCacheSize * 0.3));
            toRemove.forEach(([key]) => this.contextCache.delete(key));
            console.log(`[CodebaseContextRetriever] Cleaned up ${toRemove.length} expired cache entries`);
        }
    }

    /**
     * Calculate adaptive timeout based on request complexity
     */
    private _calculateAdaptiveTimeout(options: ContextRetrievalOptions): number {
        const baseTimeout = 120000; // 120 seconds base (2 minutes for DMQR processing)
        const perApiCallTime = 15000; // 15 seconds per API call (account for DMQR complexity)

        let estimatedCalls = 10; // Increased for DMQR + full processing pipeline

        if (options.useHybridSearch) estimatedCalls += 4;
        if (options.topKKgResults && options.topKKgResults > 0) estimatedCalls += 3;
        if (options.enableReranking) estimatedCalls += 3;

        // For DMQR-enabled operations, add substantial time allowance
        const adaptiveTimeout = Math.min(baseTimeout + (estimatedCalls * perApiCallTime), 600000); // Max 10 minutes for DMQR + comprehensive processing
        console.log(`[Context Retrieval] Adaptive timeout: ${adaptiveTimeout}ms (estimated ${estimatedCalls} API calls)`);
        return adaptiveTimeout;
    }

    public async retrieveContextForPrompt(
        agentId: string,
        prompt: string,
        options: ContextRetrievalOptions = {}
    ): Promise<RetrievedCodeContext[]> {
        const cacheKey = this._generateCacheKey(agentId, prompt, options);

        // Check cache first
        const cached = this.contextCache.get(cacheKey);
        if (cached && this._isCacheValid(cached.timestamp)) {
            console.log(`[Cache HIT] Returning cached context for prompt: "${prompt.substring(0, 50)}..."`);
            return cached.data;
        }

        console.log(`Retrieving context for prompt (agent: ${agentId}): "${prompt.substring(0, 100)}..."`);

        try {
            // Use adaptive timeout based on request complexity
            const adaptiveTimeout = this._calculateAdaptiveTimeout(options);
            
            // Set up timeout for the entire retrieval process
            const result = await Promise.race([
                this._performContextRetrieval(agentId, prompt, options),
                new Promise<RetrievedCodeContext[]>((_, reject) =>
                    setTimeout(() => reject(new Error(`Context retrieval timeout after ${adaptiveTimeout}ms`)), adaptiveTimeout)
                )
            ]);

            // Cache the result
            this.contextCache.set(cacheKey, { timestamp: Date.now(), data: result });
            this._cleanupCache();

            console.log(`[Context Retrieval] Retrieved ${result.length} context items`);

            if (result.length === 0) {
                return [{
                    type: 'documentation',
                    sourcePath: 'System Note',
                    entityName: 'No Context Found',
                    content: `The system performed a comprehensive search for relevant code snippets, knowledge graph entries, and documentation related to the query: "${prompt}", but found no matching content in the current codebase. This could indicate that the query references functionality not present in the indexed codebase, or uses terminology not found in the code.`,
                    relevanceScore: 0.1,
                    metadata: { 
                        search_attempted: true,
                        search_comprehensive: true,
                        timeout_used: adaptiveTimeout
                    }
                }];
            }

            return result;
        } catch (error) {
            console.error(`[Context Retrieval] Error retrieving context:`, error);

            // Return cached result if available, even if expired
            if (cached) {
                console.log(`[Cache FALLBACK] Returning expired cached context due to retrieval error`);
                return cached.data;
            }

            // Return structured failure info instead of empty array
            const errorMessage = error instanceof Error ? error.message : String(error);
            const errorName = error instanceof Error ? error.name : 'Unknown';
            
            return [{
                type: 'documentation',
                sourcePath: 'System Note',
                entityName: 'Context Retrieval Failed',
                content: `Context retrieval failed: ${errorMessage}. The system attempted to find relevant code snippets and documentation but encountered an error. This may be due to rate limiting, network issues, or database problems.`,
                relevanceScore: 0.0,
                metadata: { 
                    error_type: errorName,
                    error_message: errorMessage,
                    retrieval_failure: true,
                    attempted_timeout: this._calculateAdaptiveTimeout(options)
                }
            }];
        }
    }

    private async _performContextRetrieval(
        agentId: string,
        prompt: string,
        options: ContextRetrievalOptions
    ): Promise<RetrievedCodeContext[]> {
        const startTime = Date.now();
        const adaptiveTimeout = this._calculateAdaptiveTimeout(options);
        const remainingTime = () => adaptiveTimeout - (Date.now() - startTime);
        
        // Step 1: Fast Mode Detection & Parallel Analysis (Performance Optimization)
        let queryIntent: QueryIntent = 'general_query';
        let keywords: string[] = [];
        
        // Always perform full AI analysis (removed fast mode logic)
        console.log(`[Context Retrieval] Starting parallel analysis phase...`);
        try {
            // Parallelize independent API calls to save ~6 seconds
            const [intentResult, keywordResult] = await Promise.allSettled([
                this.classifyQueryIntent(prompt),
                this._extractKeywordsAndEntitiesWithGemini(prompt)
            ]);

            if (intentResult.status === 'fulfilled') {
                queryIntent = intentResult.value;
                console.log(`Query Intent Classified as: ${queryIntent}`);
            } else {
                console.warn('Failed to classify query intent, using default:', intentResult.reason);
            }

            if (keywordResult.status === 'fulfilled') {
                keywords = keywordResult.value;
            } else {
                console.warn('Failed to extract keywords, using fallback:', keywordResult.reason);
                keywords = prompt.split(/\s+/).filter((w: string) => w.length > 3);
            }
        } catch (error) {
            console.warn('Parallel analysis failed, proceeding with defaults:', error);
            keywords = prompt.split(/\s+/).filter((w: string) => w.length > 3);
        }

        // Step 1.5: Direct Entity Name Search
        let directEntityResults: RetrievedCodeContext[] = [];
        if (keywords.length > 0) {
            try {
                directEntityResults = await this.retrieveContextByEntityNames(agentId, keywords, options);
            } catch (error) {
                console.error('Error during direct entity name retrieval:', error);
            }
        }

        // Step 2: Intent-Driven Parallel Retrieval from Multiple Sources
        const retrievalPromises = this.getRetrievalPromisesByIntent(queryIntent, agentId, prompt, keywords, options);

        let semanticResults: RetrievedCodeContext[] = [];
        let kgResults: RetrievedCodeContext[] = [];
        let docResults: RetrievedCodeContext[] = [];
        let taskLogResults: RetrievedCodeContext[] = [];

        try {
            [semanticResults, kgResults, docResults, taskLogResults] = await Promise.allSettled(retrievalPromises)
                .then(results => results.map((result, index) => {
                    if (result.status === 'fulfilled') {
                        return result.value;
                    } else {
                        console.error(`Retrieval promise ${index} failed:`, result.reason);
                        return [];
                    }
                })) as [RetrievedCodeContext[], RetrievedCodeContext[], RetrievedCodeContext[], RetrievedCodeContext[]];
        } catch (error) {
            console.error('Error during parallel retrieval:', error);
        }

        // Step 3: Reciprocal Rank Fusion to combine results robustly
        console.log(`[Context Retrieval] Fusing results: ${directEntityResults.length} direct, ${semanticResults.length} semantic, ${kgResults.length} KG, ${docResults.length} docs, ${taskLogResults.length} logs.`);
        const fusedResults = this.reciprocalRankFusion([directEntityResults, semanticResults, kgResults, docResults, taskLogResults]);
        
        // Continue with all processing steps (removed early termination logic)
        const targetResultCount = (options.topKEmbeddings ?? 10) + (options.topKKgResults ?? 5);

        // Step 4: AI-powered Filtering for relevance (always perform)
        let filteredResults: RetrievedCodeContext[] = [];
        try {
            filteredResults = await this.filterWithAI(prompt, fusedResults, options);
        } catch (error) {
            console.error('Error during AI filtering:', error);
            filteredResults = fusedResults
                .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
                .slice(0, targetResultCount);
        }

        // Step 5: Self-Correction: Identify and fill context gaps (always perform)
        let gapFilledResults: RetrievedCodeContext[] = [];
        try {
            gapFilledResults = await this._identifyAndFillContextGaps(agentId, prompt, filteredResults, options);
        } catch (error) {
            console.error('Error during context gap filling:', error);
            gapFilledResults = filteredResults;
        }

        // Step 6: Proactive Context Expansion (always perform)
        let finalContext: RetrievedCodeContext[] = [];
        try {
            finalContext = await this._proactiveExpansion(agentId, prompt, gapFilledResults, options);
        } catch (error) {
            console.error('Error during proactive expansion:', error);
            finalContext = gapFilledResults;
        }

        // Step 7: Final Deduplication and Limit
        const uniqueContexts = Array.from(new Map(
            finalContext.map(item => [`${item.sourcePath}#${item.content.substring(0, 100)}`, item])
        ).values());

        const limitedContext = uniqueContexts.slice(0, (options.topKEmbeddings ?? 10) + (options.topKKgResults ?? 5));

        console.log(`[Context Retrieval] Final context contains ${limitedContext.length} items.`);
        return limitedContext;
    }

    private reciprocalRankFusion(
        rankedLists: RetrievedCodeContext[][],
        k: number = 60
    ): RetrievedCodeContext[] {
        const scores: Map<string, number> = new Map();
        const items: Map<string, RetrievedCodeContext> = new Map();

        const getItemKey = (item: RetrievedCodeContext) => `${item.type}::${item.sourcePath}::${item.content.substring(0, 150)}`;

        for (const list of rankedLists) {
            if (!list || list.length === 0) continue;

            const uniqueList = Array.from(new Map(list.map(item => [getItemKey(item), item])).values());

            for (let i = 0; i < uniqueList.length; i++) {
                const item = uniqueList[i];
                const key = getItemKey(item);
                const rank = i + 1;
                const rrfScore = 1 / (k + rank);

                scores.set(key, (scores.get(key) || 0) + rrfScore);

                if (!items.has(key)) {
                    item.relevanceScore = item.relevanceScore || (1 / rank);
                    items.set(key, item);
                }
            }
        }

        return Array.from(scores.entries())
            .map(([key, score]) => {
                const item = items.get(key)!;
                item.relevanceScore = score;
                return item;
            })
            .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
    }

    private async classifyQueryIntent(prompt: string): Promise<QueryIntent> {
        const intentPrompt = `Classify the user's intent into one of the following categories: 'find_example', 'refactor_code', 'debug_error', 'add_feature', 'understand_code', 'general_query'. 
User prompt: "${prompt}"
Respond with only the category name.`;

        try {
            const response = await this.geminiService.askGemini(intentPrompt, getCurrentModel());
            const classification = response.content[0].text?.trim().toLowerCase() as QueryIntent;

            if (['find_example', 'refactor_code', 'debug_error', 'add_feature', 'understand_code'].includes(classification)) {
                return classification;
            }
        } catch (e) {
            console.error("Error classifying query intent:", e);
        }

        return 'general_query';
    }

    private getRetrievalPromisesByIntent(
        intent: QueryIntent,
        agentId: string,
        prompt: string,
        keywords: string[],
        options: ContextRetrievalOptions
    ): Promise<RetrievedCodeContext[]>[] {
        const weights: Record<QueryIntent, number[]> = {
            'debug_error': [1.0, 0.6, 0.4, 1.0],
            'refactor_code': [0.9, 1.0, 0.5, 0.2],
            'add_feature': [0.8, 0.9, 0.7, 0.3],
            'understand_code': [0.7, 1.0, 0.8, 0.1],
            'find_example': [1.0, 0.5, 0.6, 0.1],
            'general_query': [1.0, 0.7, 0.9, 0.2],
        };

        const currentWeights = weights[intent];
        const semanticOptions = { ...options, topKEmbeddings: Math.round((options.topKEmbeddings ?? 15) * currentWeights[0]) };
        const kgOptions = { ...options, topKKgResults: Math.round((options.topKKgResults ?? 10) * currentWeights[1]) };

        console.log(`[Intent-Driven Retrieval] Intent: ${intent}, Weights: [Sem: ${currentWeights[0]}, KG: ${currentWeights[1]}, Doc: ${currentWeights[2]}, Log: ${currentWeights[3]}]`);

        return [
            currentWeights[0] > 0 ? this.performSemanticSearch(agentId, prompt, semanticOptions).catch(e => {
                console.error('Semantic search failed:', e);
                return [];
            }) : Promise.resolve([]),
            currentWeights[1] > 0 ? this.performKgSearch(agentId, prompt, kgOptions).catch(e => {
                console.error('KG search failed:', e);
                return [];
            }) : Promise.resolve([]),
            currentWeights[2] > 0 ? this.searchDocumentation(agentId, prompt, options).catch(e => {
                console.error('Documentation search failed:', e);
                return [];
            }) : Promise.resolve([]),
            currentWeights[3] > 0 ? this.searchTaskLogs(agentId, keywords, options).catch(e => {
                console.error('Task log search failed:', e);
                return [];
            }) : Promise.resolve([])
        ];
    }

    private async performSemanticSearch(agentId: string, prompt: string, options: ContextRetrievalOptions): Promise<RetrievedCodeContext[]> {
        const topK = options.topKEmbeddings ?? 15;
        if (topK === 0) return [];

        try {
            console.log(`[Semantic Search] Performing direct semantic search`);

            // // Apply task-specific query enhancement - COMMENTED OUT FOR PERFORMANCE
            // let enhancedPrompt = prompt;
            // if (options.taskType === 'CODE_RETRIEVAL_QUERY') {
            //     enhancedPrompt = `Find code implementations and definitions related to: ${prompt}`;
            // } else if (options.taskType === 'SEMANTIC_SIMILARITY') {
            //     enhancedPrompt = `Find semantically similar code patterns and concepts for: ${prompt}`;
            // }

            const embeddingResults = await this.embeddingService.retrieveSimilarCodeChunks(
                agentId,
                prompt, // Use original prompt directly
                topK,
                options.targetFilePaths
            );

            const results: RetrievedCodeContext[] = embeddingResults.map(res => ({
                type: (res.metadata?.type as any) || 'generic_code_chunk',
                sourcePath: res.file_path_relative,
                entityName: res.entity_name || undefined,
                content: res.chunk_text,
                relevanceScore: res.score || 0.0,
                metadata: res.metadata || {}
            }));

            // // Apply hybrid search if enabled - COMMENTED OUT FOR SIMPLICITY
            // if (options.useHybridSearch && options.enableKeywordSearch) {
            //     console.log('[Enhanced Semantic Search] Applying hybrid keyword enhancement');
            //     const keywordResults = await this.performEnhancedKeywordSearch(agentId, prompt, options);
            //
            //     // Combine and apply hybrid ranking
            //     results = this.applyHybridRanking([results, keywordResults], options.keywordWeight || 0.7);
            // }

            console.log(`[Semantic Search] Found ${results.length} results using direct search`);
            return results;
        } catch (error) {
            console.error("Error during semantic search:", error);
            throw error;
        }
    }

    private async performEnhancedKeywordSearch(agentId: string, prompt: string, options: ContextRetrievalOptions): Promise<RetrievedCodeContext[]> {
        try {
            // Extract keywords using Gemini for better precision
            const keywordPrompt = `Extract the most important technical keywords, function names, class names, and code identifiers from: "${prompt}". Focus on terms that would appear in code. Return JSON: {"keywords": ["term1", "term2", ...]}`;
            
            const keywordResult = await this.geminiService.askGemini(
                keywordPrompt,
                getCurrentModel(),
                'You are a code search expert. Extract precise technical keywords for code retrieval.'
            );

            let keywords: string[] = [];
            try {
                const parsed = JSON.parse(keywordResult.content[0].text || '{}');
                keywords = parsed.keywords || [];
            } catch {
                // Fallback keyword extraction
                keywords = prompt.match(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g) || [];
            }

            if (keywords.length === 0) return [];

            console.log(`[Enhanced Keyword Search] Using keywords: ${keywords.slice(0, 5).join(', ')}`);

            // Search for each keyword and combine results
            const keywordSearches = keywords.slice(0, 5).map(keyword => 
                this.embeddingService.retrieveSimilarCodeChunks(
                    agentId,
                    `Code containing ${keyword}`,
                    Math.max(3, Math.floor((options.topKEmbeddings || 10) / keywords.length)),
                    options.targetFilePaths
                )
            );

            const keywordResults = await Promise.allSettled(keywordSearches);
            const allKeywordContexts: RetrievedCodeContext[] = [];

            keywordResults.forEach((result, index) => {
                if (result.status === 'fulfilled') {
                    const contexts = result.value.map(res => ({
                        type: (res.metadata?.type as any) || 'generic_code_chunk',
                        sourcePath: res.file_path_relative,
                        entityName: res.entity_name || undefined,
                        content: res.chunk_text,
                        relevanceScore: (res.score || 0.0) * 0.7, // Fixed weight since keywordWeight was commented out
                        metadata: {
                            ...res.metadata,
                            searchType: 'keyword',
                            searchKeyword: keywords[index],
                            // taskType removed for simplification
                        }
                    }));
                    allKeywordContexts.push(...contexts);
                }
            });

            return allKeywordContexts;
        } catch (error) {
            console.error('[Enhanced Keyword Search] Error:', error);
            return [];
        }
    }

    private applyHybridRanking(resultSets: RetrievedCodeContext[][], keywordWeight: number = 0.7): RetrievedCodeContext[] {
        const combinedScores = new Map<string, { context: RetrievedCodeContext; score: number }>();
        const k = 60; // RRF constant

        resultSets.forEach((results, setIndex) => {
            const weight = setIndex === 0 ? 1.0 : keywordWeight; // First set (semantic) gets full weight
            
            results.forEach((context, rank) => {
                const key = `${context.sourcePath}:${context.entityName || 'default'}`;
                const rrfScore = weight * (1 / (k + rank + 1));
                
                if (combinedScores.has(key)) {
                    const existing = combinedScores.get(key)!;
                    existing.score += rrfScore;
                } else {
                    combinedScores.set(key, {
                        context: { ...context, relevanceScore: context.relevanceScore || rrfScore },
                        score: rrfScore
                    });
                }
            });
        });

        return Array.from(combinedScores.values())
            .sort((a, b) => b.score - a.score)
            .map(item => item.context);
    }

    private async performKgSearch(agentId: string, prompt: string, options: ContextRetrievalOptions): Promise<RetrievedCodeContext[]> {
        const topK = options.topKKgResults ?? 10;
        if (topK === 0) return [];

        try {
            const rawKgResults = await this.kgManager.queryNaturalLanguage(agentId, prompt);
            const kgQueryResults = JSON.parse(rawKgResults);

            if (kgQueryResults && kgQueryResults.results && Array.isArray(kgQueryResults.results)) {
                return kgQueryResults.results.slice(0, topK).map((node: any, index: number) => ({
                    type: 'kg_node_info',
                    sourcePath: node.name,
                    entityName: node.entityType !== 'file' ? node.name : undefined,
                    content: `Entity Type: ${node.entityType}\nObservations:\n${(node.observations || []).join('\n- ')}`,
                    relevanceScore: 1.0 / (index + 1),
                    metadata: { kgNodeType: node.entityType }
                }));
            }
        } catch (error) {
            console.error("Error during KG search:", error);
        }

        return [];
    }

    private async searchDocumentation(agentId: string, prompt: string, options: ContextRetrievalOptions): Promise<RetrievedCodeContext[]> {
        console.log("Searching documentation (placeholder)...");
        return [];
    }

    private async searchTaskLogs(agentId: string, keywords: string[], options: ContextRetrievalOptions): Promise<RetrievedCodeContext[]> {
        console.warn("Task log search is disabled due to removal of TaskProgressLogManager.");
        return [];
    }

    /**
     * Validates the relevance of retrieved context to the user's query
     * Implements multiple validation strategies to improve accuracy
     */
    private validateContextRelevance(prompt: string, contexts: RetrievedCodeContext[]): { 
        isRelevant: boolean; 
        score: number; 
        validContexts: RetrievedCodeContext[];
        issues: string[];
    } {
        if (contexts.length === 0) {
            return { isRelevant: false, score: 0, validContexts: [], issues: ['No contexts provided'] };
        }

        const issues: string[] = [];
        const validContexts: RetrievedCodeContext[] = [];
        
        // Extract key technical terms from the query
        const queryTerms = this.extractTechnicalTerms(prompt);
        const lowercasePrompt = prompt.toLowerCase();
        
        // Relevance scoring
        let totalRelevanceScore = 0;
        let relevantContextCount = 0;
        
        for (const context of contexts) {
            const contentLower = context.content.toLowerCase();
            let contextRelevanceScore = 0;
            
            // 1. Direct term matching (high weight)
            const directMatches = queryTerms.filter(term => 
                contentLower.includes(term.toLowerCase()) ||
                context.sourcePath.toLowerCase().includes(term.toLowerCase())
            );
            contextRelevanceScore += directMatches.length * 0.4;
            
            // 2. Semantic relevance through path analysis
            if (context.sourcePath && this.isPathRelevantToQuery(context.sourcePath, prompt)) {
                contextRelevanceScore += 0.3;
            }
            
            // 3. Entity name relevance
            if (context.entityName && queryTerms.some(term => 
                context.entityName!.toLowerCase().includes(term.toLowerCase())
            )) {
                contextRelevanceScore += 0.3;
            }
            
            // 4. Content depth and quality
            if (context.content.length > 100 && context.content.includes('function') || 
                context.content.includes('class') || context.content.includes('interface')) {
                contextRelevanceScore += 0.2;
            }
            
            // Consider context relevant if it meets minimum threshold
            if (contextRelevanceScore >= 0.5) {
                validContexts.push(context);
                totalRelevanceScore += contextRelevanceScore;
                relevantContextCount++;
            }
        }
        
        // Calculate overall relevance
        const averageRelevance = relevantContextCount > 0 ? totalRelevanceScore / relevantContextCount : 0;
        const coverageRatio = relevantContextCount / contexts.length;
        const finalScore = (averageRelevance * 0.7) + (coverageRatio * 0.3);
        
        // Validation checks
        if (validContexts.length === 0) {
            issues.push('No contextually relevant content found for the query');
        }
        
        if (finalScore < 0.4) {
            issues.push('Retrieved context has low relevance to the query');
        }
        
        if (coverageRatio < 0.3) {
            issues.push('Most retrieved contexts are not relevant to the query');
        }
        
        return {
            isRelevant: finalScore >= 0.4 && validContexts.length > 0,
            score: finalScore,
            validContexts,
            issues
        };
    }
    
    private extractTechnicalTerms(prompt: string): string[] {
        // Enhanced technical term extraction
        const terms: string[] = [];
        
        // Class/interface names (PascalCase)
        const classNames = prompt.match(/\b[A-Z][a-zA-Z0-9]*(?:Service|Manager|Controller|Orchestrator|Provider|Handler|Client|Factory|Builder|Config|Utils|Helper)?\b/g);
        if (classNames) terms.push(...classNames);
        
        // Function/method names (camelCase)
        const functionNames = prompt.match(/\b[a-z][a-zA-Z0-9]*(?:Method|Function|Handler|Process|Execute|Calculate|Generate|Parse|Create|Update|Delete|Get|Set|Handle|Manage)?\b/g);
        if (functionNames) terms.push(...functionNames);
        
        // Technical keywords
        const techKeywords = prompt.match(/\b(?:JSON|API|HTTP|REST|GraphQL|SQL|database|cache|config|auth|token|session|middleware|router|validation|serialization|async|await|Promise|Stream|Buffer|Event|Listener|Observer|Strategy|Factory|Singleton|Interface|Abstract|Generic|Template|Exception|Error|Log|Debug|Test|Mock|Stub|Service|Component|Module|Package|Library|Framework|Protocol|Algorithm|Data|Structure|Array|Object|Map|Set|List|Queue|Stack|Tree|Graph|Node|Edge|Link|Path|Route|Endpoint|Resource|Entity|Model|Schema|Migration|Seed|Query|Transaction|Connection|Pool|Session|Context|State|Store|Repository|DAO|DTO|VO|POJO|Bean|Annotation|Decorator|Attribute|Property|Field|Parameter|Argument|Variable|Constant|Enum|Flag|Option|Setting|Configuration|Environment|Profile|Build|Deploy|Test|Unit|Integration|End2End|Performance|Load|Stress|Security|Vulnerability|Authentication|Authorization|Permission|Role|User|Admin|Guest|Client|Server|Frontend|Backend|Fullstack|Mobile|Web|Desktop|Cloud|Container|Docker|Kubernetes|Microservice|Monolith|Distributed|Scalable|Resilient|Fault|Tolerant|High|Availability|Load|Balancer|Proxy|Gateway|Firewall|VPN|SSL|TLS|Certificate|Key|Hash|Encryption|Decryption|Signature|Verification|Validation|Sanitization|Normalization|Transformation|Mapping|Binding|Injection|Dependency|Inversion|Control|Aspect|Oriented|Programming|Functional|Reactive|Event|Driven|Message|Queue|Broker|Publisher|Subscriber|Producer|Consumer|Topic|Channel|Stream|Pipeline|Batch|Workflow|Job|Task|Scheduler|Timer|Timeout|Retry|Circuit|Breaker|Bulkhead|Rate|Limit|Throttle|Backoff|Exponential|Linear|Fibonacci|Random|Jitter|Health|Check|Monitor|Metric|Alert|Notification|Email|SMS|Push|Webhook|Callback|Trigger|Event|Handler|Listener|Observer|Watcher|Guard|Interceptor|Filter|Middleware|Plugin|Extension|Module|Component|Service|Provider|Factory|Builder|Adapter|Facade|Proxy|Decorator|Command|Query|Strategy|Template|Visitor|Iterator|Composite|Bridge|Flyweight|Prototype|Singleton|Multiton|Object|Pool|Registry|Locator|Broker|Mediator|Chain|Responsibility|State|Machine|Workflow|Engine|Rule|Engine|Decision|Tree|Neural|Network|Machine|Learning|Artificial|Intelligence|Data|Mining|Analytics|Business|Intelligence|Reporting|Dashboard|Visualization|Chart|Graph|Table|Grid|List|Form|Input|Output|Display|Render|Paint|Draw|Canvas|SVG|Image|Video|Audio|Media|File|Upload|Download|Import|Export|Backup|Restore|Sync|Async|Parallel|Concurrent|Thread|Process|Worker|Pool|Queue|Lock|Mutex|Semaphore|Barrier|Latch|Atomic|Volatile|Synchronized|Immutable|Mutable|Persistent|Transient|Serializable|Cloneable|Comparable|Iterable|Observable|Disposable|Resource|Leak|Memory|CPU|Disk|Network|Bandwidth|Latency|Throughput|Performance|Profiling|Debugging|Logging|Tracing|Monitoring|Alerting|Dashboard|Reporting|Analytics)?\b/gi);
        if (techKeywords) terms.push(...techKeywords);
        
        // Remove duplicates and return unique terms
        return [...new Set(terms)];
    }
    
    private isPathRelevantToQuery(path: string, prompt: string): boolean {
        const pathLower = path.toLowerCase();
        const promptLower = prompt.toLowerCase();
        
        // Extract meaningful parts from path
        const pathParts = path.split(/[\/\\.]/).filter(part => part.length > 2);
        
        // Check if any path part is mentioned in the query
        return pathParts.some(part => promptLower.includes(part.toLowerCase()));
    }

    private async filterWithAI(prompt: string, contexts: RetrievedCodeContext[], options: ContextRetrievalOptions): Promise<RetrievedCodeContext[]> {
        if (contexts.length === 0) return [];

        // First, validate context relevance
        const relevanceValidation = this.validateContextRelevance(prompt, contexts);
        
        if (!relevanceValidation.isRelevant) {
            console.warn(`[CodebaseContextRetrieverService] Context relevance validation failed: ${relevanceValidation.issues.join(', ')}`); 
            console.warn(`[CodebaseContextRetrieverService] Relevance score: ${relevanceValidation.score.toFixed(3)}, Valid contexts: ${relevanceValidation.validContexts.length}/${contexts.length}`);
            
            // Return only the valid contexts if any, otherwise use a fallback
            if (relevanceValidation.validContexts.length > 0) {
                contexts = relevanceValidation.validContexts;
            } else {
                // Fallback: return top contexts based on relevance scores
                return contexts.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0)).slice(0, 3);
            }
        } else {
            console.log(`[CodebaseContextRetrieverService] Context relevance validation passed: score=${relevanceValidation.score.toFixed(3)}, valid=${relevanceValidation.validContexts.length}/${contexts.length}`);
        }

        const targetPaths = options.targetFilePaths || [];

        // Detect if this is a code explanation/understanding query
        const isCodeExplanationQuery = /\b(how does|how is|explain|understand|work|implement|integrate)\b/i.test(prompt);
        const expectedRetentionRate = isCodeExplanationQuery ? "80-95%" : "60-80%";

        let filterPrompt = `You are an expert code analyst specializing in context relevance assessment for RAG systems. Your task is to identify the most relevant code contexts for a given query with high precision.

**QUERY:** "${prompt}"

**QUERY TYPE:** ${isCodeExplanationQuery ? 'CODE EXPLANATION - Be inclusive of related code' : 'GENERAL QUERY - Be selective'}

**ANALYSIS INSTRUCTIONS:**
1. **Primary Relevance**: Look for contexts that directly contain, implement, or define what the user is asking about
2. **Secondary Relevance**: Include contexts that show how the primary entities are used, imported, or integrated
3. **Supporting Context**: Include related patterns, interfaces, or dependencies that help understand the complete picture
4. **Quality Focus**: Prioritize contexts with actual code implementations over documentation or comments alone

**SCORING CRITERIA:**
- Direct match (class/function name appears): High relevance
- Implementation details of requested functionality: High relevance
- Usage examples or integrations: Medium-high relevance
- Related but not directly applicable: ${isCodeExplanationQuery ? 'Medium relevance (include for context)' : 'Low relevance'}
- Unrelated or generic code: Exclude

${isCodeExplanationQuery ?
'**SPECIAL INSTRUCTION FOR CODE EXPLANATION:** When explaining how code works, include ALL relevant code chunks that show different aspects, methods, properties, and usage patterns. Be inclusive rather than selective.' :
'**STANDARD FILTERING:** Focus on the most directly relevant contexts.'}

Return a JSON object with a single key "relevant_indices" containing an array of the indices of the most relevant items (typically ${expectedRetentionRate} of provided contexts).
Example: {"relevant_indices": [0, 2, 5, 7, 9]}
ONLY respond with the JSON object, nothing else.`;

        if (targetPaths.length > 0) {
            filterPrompt += `\n\n**Special Instruction:** Prioritize items from the following target file paths: ${targetPaths.join(', ')}. Ensure that relevant content from these paths is included if it directly addresses the prompt.`;
        }

        filterPrompt += `\n\nContext Items:\n${contexts.map((ctx, idx) => `Item ${idx}: [${ctx.type}] ${ctx.sourcePath} - ${ctx.content.substring(0, 150)}...`).join('\n')}`;

        try {
            const response = await this.geminiService.askGemini(filterPrompt, getCurrentModel());
            const parsedResponse = parseGeminiJsonResponseSync(response.content[0].text ?? '');

            if (!parsedResponse || !Array.isArray(parsedResponse.relevant_indices)) {
                console.warn("[CodebaseContextRetrieverService] AI filtering returned malformed response. Returning top results instead.");
                return contexts.slice(0, (options.topKEmbeddings ?? 10));
            }

            const relevantIndices: number[] = parsedResponse.relevant_indices;
            let filtered = contexts.filter((_, idx) => relevantIndices.includes(idx));

            // Safeguard: For code explanation queries, ensure we don't filter too aggressively
            const minExpectedItems = isCodeExplanationQuery ? Math.ceil(contexts.length * 0.7) : Math.ceil(contexts.length * 0.5);
            if (filtered.length < minExpectedItems) {
                console.warn(`[CodebaseContextRetrieverService] AI filtering returned only ${filtered.length}/${contexts.length} items (expected at least ${minExpectedItems}). Adding more relevant contexts.`);
                // Add the top-scored contexts that weren't included
                const remainingContexts = contexts.filter((_, idx) => !relevantIndices.includes(idx));
                const additionalNeeded = minExpectedItems - filtered.length;
                filtered = [...filtered, ...remainingContexts.slice(0, additionalNeeded)];
            }

            // Resilience check: If user specified target files and AI filtered them all out, add them back in.
            if (targetPaths.length > 0) {
                const targetedContexts = contexts.filter(ctx => targetPaths.includes(ctx.sourcePath));
                const filteredTargeted = filtered.filter(ctx => targetPaths.includes(ctx.sourcePath));

                if (targetedContexts.length > 0 && filteredTargeted.length === 0) {
                    console.warn(`[CodebaseContextRetrieverService] AI filtered out all targeted contexts. Re-including them.`);
                    filtered = [...filtered, ...targetedContexts];
                    // Re-deduplicate
                    filtered = Array.from(new Map(filtered.map(item => [`${item.sourcePath}#${item.content.substring(0, 100)}`, item])).values());
                }
            }

            return filtered;
        } catch (e) {
            console.error("Error filtering with AI:", e);
            // Fallback to returning a slice of the original contexts
            return contexts.slice(0, (options.topKEmbeddings ?? 10));
        }
    }

    private async _identifyAndFillContextGaps(agentId: string, prompt: string, currentContext: RetrievedCodeContext[], options: ContextRetrievalOptions): Promise<RetrievedCodeContext[]> {
        if (currentContext.length === 0) return currentContext;

        const contextSummaryForPrompt = currentContext.map(c => `[${c.type}] ${c.sourcePath} (Entity: ${c.entityName || 'N/A'}) - Snippet: ${c.content.substring(0, 100)}...`).join('\n');

        const gapAnalysisPrompt = `You are a code analysis expert. Based on the user's prompt and the provided context snippets, identify any critical missing information.
Are there any function calls, class instantiations, or type imports mentioned in the snippets for which the definition is not present?
List the exact names of these undefined entities.

User Prompt: "${prompt}"

Context Snippets:
${contextSummaryForPrompt}

Respond with a JSON object containing a single key "missing_entities" with an array of the identified names.
Example: {"missing_entities": ["UserService", "calculateTaxAmount", "IOrderDetails"]}
If no critical information is missing, respond with {"missing_entities": []}.
ONLY respond with the JSON object.`;

        try {
            const response = await this.geminiService.askGemini(gapAnalysisPrompt, getCurrentModel());
            const parsedResponse = parseGeminiJsonResponseSync(response.content[0].text ?? '');

            if (!parsedResponse || !Array.isArray(parsedResponse.missing_entities) || parsedResponse.missing_entities.length === 0) {
                console.log("[Context Self-Correction] No context gaps identified.");
                return currentContext;
            }

            const missingEntities: string[] = parsedResponse.missing_entities;
            console.log("[Context Self-Correction] Identified context gaps, attempting to fill:", missingEntities);

            const gapFillingResults = await this.retrieveContextByEntityNames(agentId, missingEntities, options);

            if (gapFillingResults.length > 0) {
                console.log(`[Context Self-Correction] Found ${gapFillingResults.length} items to fill gaps.`);
                // Fuse the new results with the existing context
                const combined = this.reciprocalRankFusion([currentContext, gapFillingResults]);
                return combined;
            }

        } catch (e) {
            console.error("Error during context self-correction:", e);
        }

        return currentContext;
    }

    private async _proactiveExpansion(agentId: string, prompt: string, currentContext: RetrievedCodeContext[], options: ContextRetrievalOptions): Promise<RetrievedCodeContext[]> {
        if (currentContext.length === 0) return currentContext;

        const contextSummary = currentContext.map(c => c.sourcePath).join(', ');
        const expansionPrompt = `Based on the prompt "${prompt}" and the currently retrieved context from files (${contextSummary}), what other specific functions, classes, or files might be essential to understand the complete picture?
List the names of these related entities.
Respond with a JSON object with a key "suggested_entities" containing an array of strings.
Example: {"suggested_entities": ["DatabaseConnection", "OrderRepository"]}
ONLY respond with the JSON object.`;

        try {
            const response = await this.geminiService.askGemini(expansionPrompt, getCurrentModel());
            const parsedResponse = parseGeminiJsonResponseSync(response.content[0].text ?? '');

            if (parsedResponse && Array.isArray(parsedResponse.suggested_entities) && parsedResponse.suggested_entities.length > 0) {
                const suggestions: string[] = parsedResponse.suggested_entities;
                console.log("Proactive expansion suggestions:", suggestions);
                const expansionResults = await this.retrieveContextByEntityNames(agentId, suggestions, options);
                // Combine and deduplicate
                const combined = [...currentContext, ...expansionResults];
                return Array.from(new Map(combined.map(item => [`${item.sourcePath}#${item.content.substring(0, 100)}`, item])).values());
            }
        } catch (e) {
            console.error("Error in proactive context expansion:", e);
        }

        return currentContext;
    }

    public async retrieveContextByEntityNames(agentId: string, entityNames: string[], options?: ContextRetrievalOptions): Promise<RetrievedCodeContext[]> {
        if (!entityNames || entityNames.length === 0) return [];

        // Deduplicate entity names to avoid redundant queries
        const uniqueEntityNames = [...new Set(entityNames)];

        try {
            console.log(`[retrieveContextByEntityNames] Fetching KG nodes for: ${uniqueEntityNames.join(', ')}`);
            const kgNodes = await this.kgManager.openNodes(agentId, uniqueEntityNames);

            return kgNodes.map((node: KGNode) => ({
                type: 'kg_node_info',
                sourcePath: node.name,
                entityName: node.entityType !== 'file' ? node.name : undefined,
                content: `Entity Type: ${node.entityType}\nObservations:\n${(node.observations || []).join('\n- ')}`,
                relevanceScore: 0.95, // High score as it's a direct match
                metadata: { kgNodeType: node.entityType, retrieved_by_name: true }
            }));
        } catch (error) {
            console.error("Error retrieving context by entity names:", error);
            return [];
        }
    }

    private async _extractKeywordsAndEntitiesWithGemini(prompt: string): Promise<string[]> {
        const extractionPrompt = `Extract key technical keywords and specific code entity names (file paths, function names, class names) from the following prompt.
Return a JSON object with a single key "entities" containing an array of strings.
Example: {"entities": ["src/services/api.ts", "getUserProfile", "UserProfile"]}
Prompt: "${prompt}"`;

        try {
            const result = await this.geminiService.askGemini(extractionPrompt, getCurrentModel());
            const parsedResponse = parseGeminiJsonResponseSync(result.content[0].text ?? '');

            if (parsedResponse && Array.isArray(parsedResponse.entities)) {
                return parsedResponse.entities;
            }
            // Fallback if parsing fails or structure is wrong
            console.warn("Failed to parse entities from Gemini, using fallback.");
            return prompt.split(/\s+/).filter((w: string) => w.length > 3 && /\w/.test(w));

        } catch (error) {
            console.error("Error extracting keywords with Gemini:", error);
        }

        return prompt.split(/\s+/).filter((w: string) => w.length > 3 && /\w/.test(w));
    }
}