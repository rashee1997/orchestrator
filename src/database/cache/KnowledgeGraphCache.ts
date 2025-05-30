import { LRUCache } from 'lru-cache';

export class KnowledgeGraphCache {
    private cache: LRUCache<string, any>;

    constructor(maxItems: number = 500, ttl: number = 1000 * 60 * 5) {
        this.cache = new LRUCache({ max: maxItems, ttl: ttl });
    }

    cacheQuery(query: string, result: any): void {
        this.cache.set(query, result);
    }

    getCachedQuery(query: string): any | null {
        return this.cache.get(query) || null;
    }

    invalidateAgent(agentId: string): void {
        // Invalidate all cache entries related to an agent
        for (const key of this.cache.keys()) {
            if (key.includes(agentId)) {
                this.cache.delete(key);
            }
        }
    }

    // Placeholder for preloadAgent
    async preloadAgent(agentId: string): Promise<void> {
        // In a real scenario, this would load frequently accessed data into cache
        console.log(`Preloading cache for agent: ${agentId}`);
    }
}
