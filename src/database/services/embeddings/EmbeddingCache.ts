// src/database/services/embeddings/EmbeddingCache.ts
import fs from 'fs/promises';
import { Database } from 'better-sqlite3';
import crypto from 'crypto';
import { CachedChunk, CodebaseEmbeddingRecord } from '../../../types/codebase_embeddings.js';
import { CodebaseEmbeddingRepository } from '../../repositories/CodebaseEmbeddingRepository.js';

export class EmbeddingCache {
    private repository: CodebaseEmbeddingRepository;
    private cacheFilePath: string;
    private inMemoryCache: Map<string, CachedChunk>;
    private cacheLoaded: boolean;
    private maxCacheSize: number;
    private cacheTTL: number; // Time to live in milliseconds
    private writeQueue: Array<{ operation: () => Promise<void>, resolve: Function, reject: Function }>;
    private processingQueue: boolean;
    private cacheStats: {
        hits: number;
        misses: number;
        evictions: number;
        writes: number;
    };

    constructor(vectorDb: Database, cacheFilePath: string = 'embedding_cache.json', maxCacheSize: number = 10000, cacheTTL: number = 24 * 60 * 60 * 1000) {
        this.repository = new CodebaseEmbeddingRepository(vectorDb);
        this.cacheFilePath = cacheFilePath;
        this.inMemoryCache = new Map<string, CachedChunk>();
        this.cacheLoaded = false;
        this.maxCacheSize = maxCacheSize;
        this.cacheTTL = cacheTTL;
        this.writeQueue = [];
        this.processingQueue = false;
        this.cacheStats = {
            hits: 0,
            misses: 0,
            evictions: 0,
            writes: 0
        };
        console.log(`[EmbeddingCache] Initializing with cache file path: ${this.cacheFilePath}`);
    }

    private async _processWriteQueue(): Promise<void> {
        if (this.processingQueue || this.writeQueue.length === 0) return;

        this.processingQueue = true;

        while (this.writeQueue.length > 0) {
            const { operation, resolve, reject } = this.writeQueue.shift()!;

            try {
                await operation();
                resolve();
            } catch (error) {
                reject(error);
            }
        }

        this.processingQueue = false;
    }

    private _queueWriteOperation(operation: () => Promise<void>): Promise<void> {
        return new Promise((resolve, reject) => {
            this.writeQueue.push({ operation, resolve, reject });
            this._processWriteQueue().catch(console.error);
        });
    }

    public async loadCacheState(): Promise<Map<string, CachedChunk>> {
        if (this.cacheLoaded) {
            return this.inMemoryCache;
        }

        try {
            await fs.access(this.cacheFilePath);
            const data = await fs.readFile(this.cacheFilePath, 'utf-8');
            const parsedData = JSON.parse(data) as CachedChunk[];

            // Filter out expired entries and enforce size limit
            const now = Date.now();
            const validEntries = parsedData
                .filter(entry => (entry.created_timestamp_unix * 1000) + this.cacheTTL > now)
                .slice(0, this.maxCacheSize);

            this.inMemoryCache.clear();
            validEntries.forEach(chunk => {
                this.inMemoryCache.set(chunk.chunk_hash, chunk);
            });

            this.cacheLoaded = true;
            console.log(`[EmbeddingCache] Loaded ${validEntries.length} valid entries from cache`);
            return this.inMemoryCache;
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                await fs.writeFile(this.cacheFilePath, JSON.stringify([], null, 2), 'utf-8');
                this.inMemoryCache.clear();
                this.cacheLoaded = true;
                return this.inMemoryCache;
            }
            console.error('Failed to load embedding cache state:', error);
            return this.inMemoryCache;
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
    ): Promise<void> => {
        if (!this.cacheLoaded) {
            await this.loadCacheState();
        }

        // Check if cache is full
        if (this.inMemoryCache.size >= this.maxCacheSize) {
            console.warn('[EmbeddingCache] Cache is full, skipping new entry');
            return;
        }

        if (!this.inMemoryCache.has(chunk_hash)) {
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

            // Queue the write to disk
            await this._queueWriteOperation(async () => {
                try {
                    const currentData = await fs.readFile(this.cacheFilePath, 'utf-8').catch(() => '[]');
                    const cacheData = JSON.parse(currentData) as CachedChunk[];
                    cacheData.push(newChunk);

                    // Keep only the most recent entries within size limit
                    const trimmedData = cacheData
                        .sort((a, b) => b.created_timestamp_unix - a.created_timestamp_unix)
                        .slice(0, this.maxCacheSize);

                    await fs.writeFile(this.cacheFilePath, JSON.stringify(trimmedData, null, 2), 'utf-8');
                    this.cacheStats.writes++;
                } catch (error) {
                    console.error('Error writing to cache file:', error);
                    throw error;
                }
            });
        }
    }

    public async flushToDb(): Promise<number> {
        if (!this.cacheLoaded) {
            await this.loadCacheState();
        }

        let flushedCount = 0;
        const chunksToInsert: CodebaseEmbeddingRecord[] = [];
        const now = Date.now();

        // Filter valid entries
        for (const chunk of this.inMemoryCache.values()) {
            if ((chunk.created_timestamp_unix * 1000) + this.cacheTTL > now) {
                const vectorBuffer = Buffer.alloc(chunk.vector.length * 4);
                for (let i = 0; i < chunk.vector.length; i++) {
                    vectorBuffer.writeFloatLE(chunk.vector[i], i * 4);
                }

                chunksToInsert.push({
                    embedding_id: crypto.randomUUID(),
                    agent_id: chunk.agent_id,
                    file_path_relative: chunk.file_path_relative,
                    entity_name: chunk.entity_name ?? null,
                    chunk_text: chunk.chunk_text,
                    embedding_type: 'chunk',
                    ai_summary_text: chunk.metadata?.ai_summary_text ?? null,
                    vector_blob: vectorBuffer,
                    vector_dimensions: chunk.vector_dimensions,
                    model_name: chunk.model_name,
                    chunk_hash: chunk.chunk_hash,
                    file_hash: chunk.chunk_hash,
                    created_timestamp_unix: chunk.created_timestamp_unix,
                    metadata_json: chunk.metadata ? JSON.stringify(chunk.metadata) : null,
                    full_file_path: chunk.full_file_path
                });
            }
        }

        if (chunksToInsert.length > 0) {
            try {
                await this.repository.bulkInsertEmbeddings(chunksToInsert);
                flushedCount = chunksToInsert.length;

                // Remove flushed entries from cache
                for (const chunk of chunksToInsert) {
                    this.inMemoryCache.delete(chunk.chunk_hash);
                }

                // Update cache file
                await this._queueWriteOperation(async () => {
                    const remainingEntries = Array.from(this.inMemoryCache.values());
                    await fs.writeFile(this.cacheFilePath, JSON.stringify(remainingEntries, null, 2), 'utf-8');
                });
            } catch (error) {
                console.error('Error flushing cache to DB:', error);
                throw error;
            }
        }

        return flushedCount;
    }

    public async clearCache(): Promise<void> {
        try {
            await fs.unlink(this.cacheFilePath);
            this.inMemoryCache.clear();
            this.cacheLoaded = false;
            await fs.writeFile(this.cacheFilePath, JSON.stringify([], null, 2), 'utf-8');
            console.log('[EmbeddingCache] Cache cleared successfully');
        } catch (error: any) {
            if (error.code !== 'ENOENT') {
                console.error('Error deleting embedding cache file:', error);
                throw error;
            }
        }
    }

    public async hasChunkInCache(chunkHash: string): Promise<boolean> {
        if (!this.cacheLoaded) {
            await this.loadCacheState();
        }

        const cached = this.inMemoryCache.get(chunkHash);
        if (!cached) {
            this.cacheStats.misses++;
            return false;
        }

        // Check if entry is expired
        const now = Date.now();
        const isExpired = (cached.created_timestamp_unix * 1000) + this.cacheTTL < now;

        if (isExpired) {
            this.inMemoryCache.delete(chunkHash);
            this.cacheStats.misses++;
            return false;
        }

        this.cacheStats.hits++;
        return true;
    }

    public getCacheStats(): {
        memorySize: number;
        fileSize: number;
        hitRate: number;
        expiredEntries: number;
        writes: number;
        hits: number;
        misses: number;
        evictions: number;
    } {
        const now = Date.now();
        let expiredEntries = 0;

        for (const chunk of this.inMemoryCache.values()) {
            if ((chunk.created_timestamp_unix * 1000) + this.cacheTTL < now) {
                expiredEntries++;
            }
        }

        const totalRequests = this.cacheStats.hits + this.cacheStats.misses;
        const hitRate = totalRequests > 0 ? (this.cacheStats.hits / totalRequests) * 100 : 0;

        return {
            memorySize: this.inMemoryCache.size,
            fileSize: this.inMemoryCache.size,
            hitRate: parseFloat(hitRate.toFixed(2)),
            expiredEntries,
            writes: this.cacheStats.writes,
            hits: this.cacheStats.hits,
            misses: this.cacheStats.misses,
            evictions: this.cacheStats.evictions
        };
    }

    public async getCacheEntry(chunkHash: string): Promise<CachedChunk | null> {
        if (!this.cacheLoaded) {
            await this.loadCacheState();
        }

        const cached = this.inMemoryCache.get(chunkHash);
        if (!cached) {
            this.cacheStats.misses++;
            return null;
        }

        // Check if entry is expired
        const now = Date.now();
        const isExpired = (cached.created_timestamp_unix * 1000) + this.cacheTTL < now;

        if (isExpired) {
            this.inMemoryCache.delete(chunkHash);
            this.cacheStats.misses++;
            this.cacheStats.evictions++;
            return null;
        }

        this.cacheStats.hits++;
        return cached;
    }

    public async evictExpiredEntries(): Promise<number> {
        if (!this.cacheLoaded) {
            await this.loadCacheState();
        }

        const now = Date.now();
        const expiredHashes: string[] = [];

        for (const [hash, chunk] of this.inMemoryCache.entries()) {
            if ((chunk.created_timestamp_unix * 1000) + this.cacheTTL < now) {
                expiredHashes.push(hash);
            }
        }

        for (const hash of expiredHashes) {
            this.inMemoryCache.delete(hash);
        }

        this.cacheStats.evictions += expiredHashes.length;

        // Update cache file if there were evictions
        if (expiredHashes.length > 0) {
            await this._queueWriteOperation(async () => {
                const remainingEntries = Array.from(this.inMemoryCache.values());
                await fs.writeFile(this.cacheFilePath, JSON.stringify(remainingEntries, null, 2), 'utf-8');
            });
        }

        return expiredHashes.length;
    }

    public async preloadCache(agentId: string, limit: number = 1000): Promise<number> {
        try {
            // Get recent embeddings from the database
            const recentEmbeddings = await this.repository.getEmbeddingsForFile('', agentId);
            const limitedEmbeddings = recentEmbeddings.slice(0, limit);

            let loadedCount = 0;

            for (const embedding of limitedEmbeddings) {
                if (this.inMemoryCache.size >= this.maxCacheSize) {
                    break;
                }

                if (!this.inMemoryCache.has(embedding.chunk_hash)) {
                    const vector: number[] = [];
                    for (let i = 0; i < embedding.vector_blob.length; i += 4) {
                        vector.push(embedding.vector_blob.readFloatLE(i));
                    }

                    const cachedChunk: CachedChunk = {
                        embedding_id: embedding.embedding_id,
                        agent_id: embedding.agent_id,
                        chunk_text: embedding.chunk_text,
                        entity_name: embedding.entity_name,
                        vector: vector,
                        vector_dimensions: embedding.vector_dimensions,
                        model_name: embedding.model_name,
                        chunk_hash: embedding.chunk_hash,
                        metadata: embedding.metadata_json ? JSON.parse(embedding.metadata_json) : {},
                        created_timestamp_unix: embedding.created_timestamp_unix,
                        file_path_relative: embedding.file_path_relative,
                        full_file_path: embedding.full_file_path
                    };

                    this.inMemoryCache.set(embedding.chunk_hash, cachedChunk);
                    loadedCount++;
                }
            }

            console.log(`[EmbeddingCache] Preloaded ${loadedCount} entries for agent ${agentId}`);
            return loadedCount;
        } catch (error) {
            console.error('Error preloading cache:', error);
            return 0;
        }
    }
}