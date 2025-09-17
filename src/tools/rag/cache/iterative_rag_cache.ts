import { MemoryManager } from '../../../database/memory_manager.js';
import { RetrievedCodeContext } from '../../../database/services/CodebaseContextRetrieverService.js';
import { ContextRetrievalOptions } from '../../../database/services/CodebaseContextRetrieverService.js';

export class IterativeRagCache {
    private sessionContextCache: Map<string, { context: RetrievedCodeContext[]; timestamp: number; query: string; options: ContextRetrievalOptions }>;
    private readonly CACHE_TTL = 10 * 60 * 1000; // 10 minutes
    private readonly MAX_SESSION_CACHE_SIZE = 50;

    constructor() {
        this.sessionContextCache = new Map();
    }

    generateSessionCacheKey(query: string, options: ContextRetrievalOptions): string {
        const optionsStr = JSON.stringify({
            topKEmbeddings: options.topKEmbeddings,
            kgQueryDepth: options.kgQueryDepth,
            topKKgResults: options.topKKgResults,
            targetFilePaths: options.targetFilePaths?.sort(),
            embeddingScoreThreshold: options.embeddingScoreThreshold,
            useHybridSearch: options.useHybridSearch,
            enableReranking: options.enableReranking,
        });
        return `${query}:${optionsStr}`;
    }

    isSessionCacheValid(timestamp: number): boolean {
        return (Date.now() - timestamp) < this.CACHE_TTL;
    }

    cleanupSessionCache(): void {
        if (this.sessionContextCache.size > this.MAX_SESSION_CACHE_SIZE) {
            const entries = Array.from(this.sessionContextCache.entries());
            entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
            const toRemove = entries.slice(0, Math.floor(this.MAX_SESSION_CACHE_SIZE * 0.3));
            toRemove.forEach(([key]) => this.sessionContextCache.delete(key));
            console.log(`[IterativeRagCache] Cleaned up ${toRemove.length} expired session cache entries`);
        }
    }

    getSessionCache(): Map<string, { context: RetrievedCodeContext[]; timestamp: number; query: string; options: ContextRetrievalOptions }> {
        return this.sessionContextCache;
    }
}