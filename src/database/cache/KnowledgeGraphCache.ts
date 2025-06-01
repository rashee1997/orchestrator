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

    /**
     * Preloads frequently accessed data for a specific agent into the cache.
     * In a real-world scenario, this would involve fetching data from a persistent store.
     * @param agentId The identifier of the agent for whom to preload data.
     * @param dataLoader A function that fetches the data to be preloaded. 
     *                   It should return a Promise resolving to an array of {key: string, value: any} objects.
     * @example
     * // Example of a dataLoader function
     * const myDataLoader = async (agentId: string) => {
     *   // Simulate fetching data
     *   return [
     *     { key: `${agentId}:profile`, value: { name: 'Agent Name', type: 'AI' } },
     *     { key: `${agentId}:settings`, value: { theme: 'dark', notifications: true } },
     *   ];
     * };
     * await cache.preloadAgent('agent123', myDataLoader);
     */
    async preloadAgent(agentId: string, dataLoader: (agentId: string) => Promise<Array<{key: string, value: any}>>): Promise<void> {
        console.log(`Preloading cache for agent: ${agentId}`);
        try {
            const dataToPreload = await dataLoader(agentId);
            for (const item of dataToPreload) {
                if (!item.key.startsWith(agentId)) {
                    console.warn(`Skipping preload for key "${item.key}" as it does not belong to agent "${agentId}"`);
                    continue;
                }
                this.cacheQuery(item.key, item.value);
            }
            console.log(`Successfully preloaded ${dataToPreload.length} items for agent: ${agentId}`);
        } catch (error) {
            console.error(`Error preloading cache for agent ${agentId}:`, error);
            // Optionally, rethrow the error or handle it as per application requirements
        }
    }

    /**
     * Checks if a key exists in the cache.
     * @param key The key to check.
     * @returns True if the key exists, false otherwise.
     */
    has(key: string): boolean {
        return this.cache.has(key);
    }

    /**
     * Deletes a specific key from the cache.
     * @param key The key to delete.
     * @returns True if the key was deleted, false otherwise.
     */
    delete(key: string): boolean {
        return this.cache.delete(key);
    }

    /**
     * Clears the entire cache.
     */
    clear(): void {
        this.cache.clear();
        console.log('KnowledgeGraphCache cleared.');
    }

    /**
     * Gets the current number of items in the cache.
     * @returns The number of items in the cache.
     */
    size(): number {
        return this.cache.size;
    }
}
