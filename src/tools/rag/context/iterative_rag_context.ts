import { MemoryManager } from '../../../database/memory_manager.js';
import { GeminiIntegrationService } from '../../../database/services/GeminiIntegrationService.js';
import { RetrievedCodeContext } from '../../../database/services/CodebaseContextRetrieverService.js';
import { ContextRetrievalOptions } from '../../../database/services/CodebaseContextRetrieverService.js';
import { KnowledgeGraphManager } from '../../../database/managers/KnowledgeGraphManager.js';
import { MultiModelOrchestrator } from '../multi_model_orchestrator.js';
import { IterativeRagCache } from '../cache/iterative_rag_cache.js';
import { deduplicateContexts } from '../../../utils/context_utils.js';

export class IterativeRagContext {
    constructor(
        private memoryManagerInstance: MemoryManager,
        private geminiService: GeminiIntegrationService,
        private knowledgeGraphManager: KnowledgeGraphManager | undefined,
        private multiModelOrchestrator: MultiModelOrchestrator,
        private cache: IterativeRagCache = new IterativeRagCache()
    ) {}

    async retrieveContextViaEmbeddingTool(
        agentId: string,
        query: string,
        options: ContextRetrievalOptions
    ): Promise<RetrievedCodeContext[]> {
        console.log(`[Iterative RAG] Using direct embedding tool for query: "${query}"`);
        try {
            const { getEmbeddingToolHandlers } = await import('../../embedding_tools.js');
            const embeddingHandlers = getEmbeddingToolHandlers(this.memoryManagerInstance);
            const queryArgs = {
                agent_id: agentId,
                query_text: query,
                top_k: options.topKEmbeddings || 8,
                target_file_paths: options.targetFilePaths,
                exclude_chunk_types: ['summary'],
                enable_dmqr: false,
                dmqr_query_count: 3,
            };
            const result = await embeddingHandlers['query_codebase_embeddings'](queryArgs, agentId);
            const embeddingService = this.memoryManagerInstance.getCodebaseEmbeddingService();
            const codeChunks = await embeddingService.retrieveSimilarCodeChunks(
                agentId,
                query,
                options.topKEmbeddings || 8,
                options.targetFilePaths,
                ['summary']
            );
            const contexts: RetrievedCodeContext[] = codeChunks.map((chunk, index) => ({
                type: 'generic_code_chunk',
                sourcePath: chunk.file_path_relative,
                entityName: chunk.entity_name || undefined,
                content: chunk.chunk_text,
                relevanceScore: chunk.score,
                metadata: {
                    ...chunk.metadata,
                    searchType: 'direct_embedding',
                    rank: index + 1,
                    hasActualCode: true,
                },
            }));
            console.log(`[Iterative RAG] Retrieved ${contexts.length} code chunks via embedding tool`);
            if (contexts.length > 0) {
                const sample = contexts[0];
                console.log(`[Iterative RAG] Sample chunk: ${sample.entityName} from ${sample.sourcePath} (${sample.content.substring(0, 100)}...)`);
            }
            return contexts;
        } catch (error) {
            console.error('[Iterative RAG] Error using embedding tool, falling back to context retriever:', error);
            const contextRetriever = this.memoryManagerInstance.getCodebaseContextRetrieverService();
            return await contextRetriever.retrieveContextForPrompt(agentId, query, options);
        }
    }

    async retrieveContextWithCache(
        agentId: string,
        queries: string[],
        options: ContextRetrievalOptions
    ): Promise<RetrievedCodeContext[]> {
        const allContexts: RetrievedCodeContext[] = [];
        const uncachedQueries: string[] = [];
        const cachedContexts: RetrievedCodeContext[] = [];
        for (const query of queries) {
            const cacheKey = this.cache.generateSessionCacheKey(query, options);
            const cached = this.cache.getSessionCache().get(cacheKey);
            if (cached && this.cache.isSessionCacheValid(cached.timestamp)) {
                console.log(`[Session Cache HIT] Using cached context for query: "${query.substring(0, 50)}..."`);
                cachedContexts.push(...cached.context);
            } else {
                uncachedQueries.push(query);
            }
        }
        if (uncachedQueries.length > 0) {
            console.log(`[Parallel Retrieval] Processing ${uncachedQueries.length} uncached queries`);
            const retrievalPromises = uncachedQueries.map(async (query) => {
                try {
                    const context = await this.retrieveContextViaEmbeddingTool(agentId, query, options);
                    const cacheKey = this.cache.generateSessionCacheKey(query, options);
                    this.cache.getSessionCache().set(cacheKey, { context, timestamp: Date.now(), query, options });
                    return context;
                } catch (error) {
                    console.error(`[Parallel Retrieval] Failed to retrieve context for query "${query}":`, error);
                    return [];
                }
            });
            try {
                const retrievedContexts = await Promise.allSettled(retrievalPromises);
                retrievedContexts.forEach((result) => {
                    if (result.status === 'fulfilled') {
                        allContexts.push(...result.value);
                    }
                });
            } catch (error) {
                console.error('[Parallel Retrieval] Error in parallel context retrieval:', error);
            }
            this.cache.cleanupSessionCache();
        }
        allContexts.push(...cachedContexts);
        return allContexts;
    }

    createContextFlow(
        accumulatedContext: RetrievedCodeContext[],
        currentQuery: string,
        recentItemsCount: number,
        enableLongRag: boolean = false,
        longRagChunkSize: number = 2000
    ): RetrievedCodeContext[] {
        if (accumulatedContext.length === 0) return [];
        let processedContexts = accumulatedContext;
        if (enableLongRag) {
            processedContexts = this.processLongContexts(processedContexts, longRagChunkSize);
        }
        const recentContext = processedContexts.slice(-recentItemsCount);
        const olderContext = processedContexts.slice(0, -recentItemsCount);
        const sortByPriority = (contexts: RetrievedCodeContext[]): RetrievedCodeContext[] => {
            const typePriority = {
                'function': 5,
                'method': 4,
                'class': 3,
                'file': 2,
                'documentation': 1,
                'kg_node_info': 6,
            };
            return contexts.sort((a, b) => {
                const aScore = a.relevanceScore || 0;
                const bScore = b.relevanceScore || 0;
                if (Math.abs(bScore - aScore) > 0.1) {
                    return bScore - aScore;
                }
                const aPriority = typePriority[a.type as keyof typeof typePriority] || 0;
                const bPriority = typePriority[b.type as keyof typeof typePriority] || 0;
                return bPriority - aPriority;
            });
        };
        const prioritizedRecent = sortByPriority(recentContext);
        let processedOlder = olderContext;
        if (olderContext.length > 10) {
            processedOlder = olderContext.filter(ctx => (ctx.relevanceScore || 0) >= 0.8);
            if (processedOlder.length > 5) {
                processedOlder = processedOlder.slice(0, 5);
            }
        }
        const contextFlow = [...prioritizedRecent, ...processedOlder];
        const uniqueContexts = Array.from(
            new Map(contextFlow.map(item => [`${item.sourcePath}#${item.entityName}`, item])).values()
        );
        return uniqueContexts;
    }

    processLongContexts(contexts: RetrievedCodeContext[], maxChunkSize: number = 2000): RetrievedCodeContext[] {
        return contexts.flatMap(context => {
            if (context.content.length <= maxChunkSize) {
                return [context];
            }
            const chunks: RetrievedCodeContext[] = [];
            const content = context.content;
            let startIndex = 0;
            while (startIndex < content.length) {
                let endIndex = startIndex + maxChunkSize;
                if (endIndex < content.length) {
                    const lastPeriod = content.lastIndexOf('.', endIndex);
                    const lastNewline = content.lastIndexOf('\n', endIndex);
                    const breakPoint = Math.max(lastPeriod, lastNewline);
                    if (breakPoint > startIndex + maxChunkSize * 0.5) {
                        endIndex = breakPoint + 1;
                    }
                }
                const chunkContent = content.slice(startIndex, endIndex);
                chunks.push({
                    ...context,
                    content: chunkContent,
                    entityName: `${context.entityName || 'chunk'}_${chunks.length + 1}`,
                    metadata: {
                        ...context.metadata,
                        isChunk: true,
                        chunkIndex: chunks.length,
                        originalLength: content.length,
                    },
                });
                startIndex = endIndex;
            }
            return chunks;
        });
    }
}