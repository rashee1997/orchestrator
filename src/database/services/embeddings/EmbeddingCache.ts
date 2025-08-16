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

    constructor(vectorDb: Database) {
        this.repository = new CodebaseEmbeddingRepository(vectorDb);
        this.inMemoryCache = new Map<string, CachedChunk>();
        console.log(`[EmbeddingCache] Initializing with cache file path: ${this.cacheFilePath}`);
    }

    public async loadCacheState(): Promise<Map<string, CachedChunk>> {
        if (this.cacheLoaded) {
            return this.inMemoryCache;
        }
        try {
            await fs.access(this.cacheFilePath);
            const data = await fs.readFile(this.cacheFilePath, 'utf-8');
            const parsedData = JSON.parse(data) as CachedChunk[];
            this.inMemoryCache.clear();
            parsedData.forEach(chunk => this.inMemoryCache.set(chunk.chunk_hash, chunk));
            this.cacheLoaded = true;
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
        }
    }

    public async flushToDb(): Promise<number> {
        if (!this.cacheLoaded) {
            await this.loadCacheState();
        }

        let flushedCount = 0;
        const chunksToInsert: CodebaseEmbeddingRecord[] = [];

        for (const chunk of this.inMemoryCache.values()) {
            const vectorBuffer = Buffer.alloc(chunk.vector.length * 4);
            for (let i = 0; i < chunk.vector.length; i++) {
                vectorBuffer.writeFloatLE(chunk.vector[i], i * 4);
            }

            chunksToInsert.push({
                embedding_id: crypto.randomUUID(), // Generate UUID for new embeddings from cache
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
                file_hash: chunk.chunk_hash, // Placeholder, as cache doesn't have file content
                created_timestamp_unix: chunk.created_timestamp_unix,
                metadata_json: chunk.metadata ? JSON.stringify(chunk.metadata) : null,
                full_file_path: chunk.full_file_path
            });
        }

        if (chunksToInsert.length > 0) {
            try {
                await this.repository.bulkInsertEmbeddings(chunksToInsert);
                flushedCount = chunksToInsert.length;
            } catch (error) {
                console.error(`Failed to bulk flush chunks to DB:`, error);
                // If bulk insert fails, we might want to keep them in cache or handle individually
                // For now, re-throw or log and clear cache to avoid infinite loop on bad data
            }
        }

        await fs.writeFile(this.cacheFilePath, JSON.stringify(Array.from(this.inMemoryCache.values()), null, 2), 'utf-8');
        return flushedCount;
    }

    public async clearCache(): Promise<void> {
        try {
            await fs.unlink(this.cacheFilePath);
            this.inMemoryCache.clear();
            this.cacheLoaded = false;
            await fs.writeFile(this.cacheFilePath, JSON.stringify([], null, 2), 'utf-8'); // Re-initialize empty file
        } catch (error: any) {
            if (error.code !== 'ENOENT') {
                console.error('Failed to delete embedding cache file:', error);
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
}