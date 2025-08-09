import fs from 'fs/promises';
import { Database } from 'better-sqlite3';
import crypto from 'crypto';
import { CachedChunk, CodebaseEmbeddingRecord } from '../../../types/codebase_embeddings.js';
import { CodebaseEmbeddingRepository } from '../../repositories/CodebaseEmbeddingRepository.js';

export class EmbeddingCache {
    private repository: CodebaseEmbeddingRepository;
    private cacheFilePath: string = 'embedding_cache.json';
    private inMemoryCache: Map<string, CachedChunk>;
    private cacheLoaded: boolean = false;
    private maxCacheSize: number = 1000; // Maximum number of chunks to keep in memory
    private flushIntervalMs: number = 30000; // Auto-flush interval (30 seconds)
    private flushTimer: NodeJS.Timeout | null = null;

    constructor(vectorDb: Database) {
        this.repository = new CodebaseEmbeddingRepository(vectorDb);
        this.inMemoryCache = new Map<string, CachedChunk>();
        console.log(`[EmbeddingCache] Initializing with cache file path: ${this.cacheFilePath}`);

        // Set up auto-flush timer
        this.setupAutoFlush();
    }

    /**
     * Sets up automatic periodic flushing of the cache.
     */
    private setupAutoFlush(): void {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
        }

        this.flushTimer = setInterval(async () => {
            try {
                const flushedCount = await this.flushToDb();
                if (flushedCount > 0) {
                    console.log(`[EmbeddingCache] Auto-flushed ${flushedCount} chunks to database`);
                }
            } catch (error) {
                console.error('[EmbeddingCache] Error during auto-flush:', error);
            }
        }, this.flushIntervalMs);
    }

    public async loadCacheState(): Promise<Map<string, CachedChunk>> {
        if (this.cacheLoaded) {
            return this.inMemoryCache;
        }

        try {
            await fs.access(this.cacheFilePath);
            const data = await fs.readFile(this.cacheFilePath, 'utf-8');
            const parsedData = JSON.parse(data) as CachedChunk[];

            // Limit the number of chunks loaded to prevent memory issues
            const limitedData = parsedData.slice(0, this.maxCacheSize);

            this.inMemoryCache.clear();
            limitedData.forEach(chunk => this.inMemoryCache.set(chunk.chunk_hash, chunk));
            this.cacheLoaded = true;

            console.log(`[EmbeddingCache] Loaded ${limitedData.length} chunks from cache file`);
            return this.inMemoryCache;
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                await fs.writeFile(this.cacheFilePath, JSON.stringify([], null, 2), 'utf-8');
                this.inMemoryCache.clear();
                this.cacheLoaded = true;
                return this.inMemoryCache;
            } else {
                console.error('Failed to load embedding cache state:', error);
                return this.inMemoryCache;
            }
        }
    }

    public addChunk = async (
        agentId: string,
        chunk_text: string,
        entity_name: string | null,
        vector: number[],
        vector_dimensions: number,
        model_name: string,
        chunk_hash: string,
        metadata: any,
        created_timestamp_unix: number,
        file_path_relative: string,
        full_file_path: string
    ) => {
        if (!this.cacheLoaded) {
            await this.loadCacheState();
        }

        // If cache is full, remove the least recently used entry (true LRU strategy)
        if (this.inMemoryCache.size >= this.maxCacheSize) {
            const lruKey = this.inMemoryCache.keys().next().value;
            if (lruKey) {
                this.inMemoryCache.delete(lruKey);
            }
        }

        // Update usage order for LRU: if chunk_hash is already in cache, move it to the end
        if (this.inMemoryCache.has(chunk_hash)) {
            const value = this.inMemoryCache.get(chunk_hash);
            this.inMemoryCache.delete(chunk_hash);
            if (value) {
                this.inMemoryCache.set(chunk_hash, value);
            }
        } else {
            const newChunk: CachedChunk = {
                embedding_id: chunk_hash,
                agent_id: agentId,
                chunk_text: chunk_text,
                entity_name: entity_name,
                vector: vector,
                vector_dimensions: vector_dimensions,
                model_name: model_name,
                chunk_hash: chunk_hash,
                metadata: metadata,
                created_timestamp_unix: created_timestamp_unix,
                file_path_relative: file_path_relative,
                full_file_path: full_file_path
            };
            this.inMemoryCache.set(chunk_hash, newChunk);
        }
    }

    public async flushToDb(): Promise<number> {
        if (!this.cacheLoaded) {
            await this.loadCacheState();
        }

        if (this.inMemoryCache.size === 0) {
            return 0;
        }

        let flushedCount = 0;
        const chunksToInsert: CodebaseEmbeddingRecord[] = [];

        for (const chunk of this.inMemoryCache.values()) {
            if (!chunk.vector) {
                // Skip this chunk if vector is undefined
                console.warn(`[EmbeddingCache] Skipping chunk ${chunk.chunk_hash} due to undefined vector.`);
                continue;
            }
            const vectorBuffer = Buffer.alloc(chunk.vector.length * 4);
            for (let i = 0; i < chunk.vector.length; i++) {
                vectorBuffer.writeFloatLE(chunk.vector[i], i * 4);
            }

            chunksToInsert.push({
                embedding_id: crypto.randomUUID(),
                agent_id: chunk.agent_id,
                file_path_relative: chunk.file_path_relative || '',
                entity_name: chunk.entity_name ?? null,
                chunk_text: chunk.chunk_text,
                ai_summary_text: chunk.metadata?.ai_summary_text ?? null,
                vector_blob: vectorBuffer,
                vector_dimensions: chunk.vector_dimensions,
                model_name: chunk.model_name,
                chunk_hash: chunk.chunk_hash,
                created_timestamp_unix: chunk.created_timestamp_unix,
                metadata_json: chunk.metadata ? JSON.stringify(chunk.metadata) : null,
                full_file_path: chunk.full_file_path || ''
            });
        }

        if (chunksToInsert.length > 0) {
            try {
                // Process in batches to avoid overwhelming the database
                const batchSize = 100;
                for (let i = 0; i < chunksToInsert.length; i += batchSize) {
                    const batch = chunksToInsert.slice(i, i + batchSize);
                    await this.repository.bulkInsertEmbeddings(batch);
                    flushedCount += batch.length;
                }

                console.log(`[EmbeddingCache] Successfully flushed ${flushedCount} chunks to database`);

                // Save to file after successful DB flush
                await this.saveCacheToFile();
            } catch (error) {
                console.error(`Failed to bulk flush chunks to DB:`, error);
                throw error; // Re-throw to allow caller to handle
            }
        }

        return flushedCount;
    }

    /**
     * Saves the current in-memory cache to disk.
     */
    private async saveCacheToFile(): Promise<void> {
        try {
            const cacheArray = Array.from(this.inMemoryCache.values());
            await fs.writeFile(this.cacheFilePath, JSON.stringify(cacheArray, null, 2), 'utf-8');
        } catch (error) {
            console.error('Failed to save cache to file:', error);
            throw error;
        }
    }

    public async clearCache(): Promise<void> {
        try {
            // Clear in-memory cache
            this.inMemoryCache.clear();

            // Clear file cache
            await fs.unlink(this.cacheFilePath);
            await fs.writeFile(this.cacheFilePath, JSON.stringify([], null, 2), 'utf-8');

            // Reset cache loaded state
            this.cacheLoaded = false;

            console.log('[EmbeddingCache] Cache cleared successfully');
        } catch (error: any) {
            if (error.code !== 'ENOENT') {
                console.error('Failed to clear embedding cache:', error);
                throw error;
            }
        }
    }

    /**
     * Checks if a chunk exists in the in-memory cache.
     * @param chunkHash The hash of the chunk to check.
     * @returns True if the chunk is in the cache, false otherwise.
     */
    public async hasChunkInCache(chunkHash: string): Promise<boolean> {
        if (!this.cacheLoaded) {
            await this.loadCacheState();
        }
        return this.inMemoryCache.has(chunkHash);
    }

    /**
     * Gets a chunk from the in-memory cache.
     * @param chunkHash The hash of the chunk to retrieve.
     * @returns The cached chunk or undefined if not found.
     */
    public async getChunkFromCache(chunkHash: string): Promise<CachedChunk | undefined> {
        if (!this.cacheLoaded) {
            await this.loadCacheState();
        }
        return this.inMemoryCache.get(chunkHash);
    }

    /**
     * Clean up resources when the cache is no longer needed.
     */
    public dispose(): void {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
    }
}