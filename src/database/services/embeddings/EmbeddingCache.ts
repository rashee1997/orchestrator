import fs from 'fs/promises';
import { Database } from 'better-sqlite3';
import { CachedChunk, CodebaseEmbeddingRecord } from '../../../types/codebase_embeddings.js';
import { CodebaseEmbeddingRepository } from '../../repositories/CodebaseEmbeddingRepository.js';

export class EmbeddingCache {
    private repository: CodebaseEmbeddingRepository;
    private cacheFilePath: string = 'embedding_cache.json';

    constructor(vectorDb: Database) {
        this.repository = new CodebaseEmbeddingRepository(vectorDb);
        this.initializeCacheFile();
    }

    private async initializeCacheFile(): Promise<void> {
        try {
            await fs.access(this.cacheFilePath);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                await fs.writeFile(this.cacheFilePath, JSON.stringify([], null, 2), 'utf-8');
            } else {
                console.error('Failed to access or initialize embedding cache file:', error);
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
        try {
            const existingInDb = await this.repository.getExistingEmbeddingByHash(chunk_hash);
            if (existingInDb) {
                return;
            }

            const currentCache: CachedChunk[] = await this.loadCacheState();
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

            const existingInCache = currentCache.some(c => c.chunk_hash === chunk_hash);
            if (!existingInCache) {
                currentCache.push(newChunk);
                await fs.writeFile(this.cacheFilePath, JSON.stringify(currentCache, null, 2), 'utf-8');
            }
        } catch (error) {
            console.error(`Failed to add chunk ${chunk_hash} to cache file:`, error);
        }
    }

    public async flushToDb(): Promise<number> {
        const chunksToFlush: CachedChunk[] = await this.loadCacheState();
        if (chunksToFlush.length === 0) {
            return 0;
        }

        let flushedCount = 0;
        const remainingChunks: CachedChunk[] = [];

        for (const data of chunksToFlush) {
            try {
                const existing = await this.repository.getExistingEmbeddingByHash(data.chunk_hash);
                if (existing) {
                    continue;
                }

                const vectorBuffer = Buffer.alloc(data.vector.length * 4);
                for (let i = 0; i < data.vector.length; i++) {
                    vectorBuffer.writeFloatLE(data.vector[i], i * 4);
                }

                const record: CodebaseEmbeddingRecord = {
                    embedding_id: data.chunk_hash,
                    agent_id: data.agent_id,
                    file_path_relative: data.file_path_relative,
                    entity_name: data.entity_name ?? undefined,
                    chunk_text: data.chunk_text,
                    ai_summary_text: data.metadata?.ai_summary_text ?? undefined,
                    vector_blob: vectorBuffer,
                    vector_dimensions: data.vector_dimensions,
                    model_name: data.model_name,
                    chunk_hash: data.chunk_hash,
                    created_timestamp_unix: data.created_timestamp_unix,
                    metadata_json: data.metadata ? JSON.stringify(data.metadata) : undefined
                };

                await this.repository.insertEmbedding(record);
                flushedCount++;
            } catch (error) {
                console.error(`Failed to flush chunk ${data.chunk_hash} to DB:`, error);
                remainingChunks.push(data);
            }
        }

        await fs.writeFile(this.cacheFilePath, JSON.stringify(remainingChunks, null, 2), 'utf-8');
        return flushedCount;
    }

    public async loadCacheState(): Promise<CachedChunk[]> {
        try {
            const data = await fs.readFile(this.cacheFilePath, 'utf-8');
            return JSON.parse(data) as CachedChunk[];
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                return [];
            } else {
                console.error('Failed to load embedding cache state:', error);
                return [];
            }
        }
    }

    public async clearCache(): Promise<void> {
        try {
            await fs.unlink(this.cacheFilePath);
            await this.initializeCacheFile();
        } catch (error: any) {
            if (error.code !== 'ENOENT') {
                console.error('Failed to delete embedding cache file:', error);
            }
        }
    }

    /**
     * Checks if a chunk exists in the cache file.
     * @param chunkHash The hash of the chunk to check.
     * @returns A promise that resolves to true if the chunk is in the cache, false otherwise.
     */
    public async hasChunkInCache(chunkHash: string): Promise<boolean> {

        const currentCache: CachedChunk[] = await this.loadCacheState();
        return currentCache.some(c => c.chunk_hash === chunkHash);
    }
}
