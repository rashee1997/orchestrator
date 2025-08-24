import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { MemoryManager } from '../memory_manager.js';
import { GeminiIntegrationService } from './GeminiIntegrationService.js';
import { CodebaseIntrospectionService } from './CodebaseIntrospectionService.js';
import { Database } from 'better-sqlite3';
import { EmbeddingCache } from './embeddings/EmbeddingCache.js';
import { AIEmbeddingProvider } from './embeddings/AIEmbeddingProvider.js';
import { CodeChunkingService } from './embeddings/CodeChunkingService.js';
import { CodebaseEmbeddingRepository } from '../repositories/CodebaseEmbeddingRepository.js';
import { ChunkingStrategy, CodebaseEmbeddingRecord, EmbeddingIngestionResult } from '../../types/codebase_embeddings.js';
import { DEFAULT_EMBEDDING_MODEL, VECTOR_FLOAT_SIZE } from '../../constants/embedding_constants.js';
import { deduplicateContexts } from '../../utils/context_utils.js';
import { RetrievedCodeContext } from './CodebaseContextRetrieverService.js';

export class CodebaseEmbeddingService {
    public repository: CodebaseEmbeddingRepository;
    private aiProvider: AIEmbeddingProvider;
    public chunkingService: CodeChunkingService;
    public embeddingCache: EmbeddingCache;
    public introspectionService: CodebaseIntrospectionService;

    constructor(
        memoryManager: MemoryManager,
        vectorDbConnection: Database,
        geminiService: GeminiIntegrationService
    ) {
        this.repository = new CodebaseEmbeddingRepository(vectorDbConnection);
        this.aiProvider = new AIEmbeddingProvider(geminiService);
        this.introspectionService = new CodebaseIntrospectionService(memoryManager);
        this.chunkingService = new CodeChunkingService(
            this.introspectionService,
            this.aiProvider,
            memoryManager
        );
        this.embeddingCache = new EmbeddingCache(vectorDbConnection);
    }

    public async cleanUpEmbeddingsByFilePaths(agentId: string, filePaths: string[], projectRootPath: string, filterByAgentId?: boolean): Promise<{ deletedCount: number }> {
        let deletedCount = 0;
        const embeddingIdsToDelete: string[] = [];

        for (const normalizedFilePath of filePaths) {
            try {
                const embeddings = await this.repository.getEmbeddingsForFile(normalizedFilePath, filterByAgentId ? agentId : undefined);
                for (const embedding of embeddings) {
                    if (embedding.embedding_id) {
                        embeddingIdsToDelete.push(embedding.embedding_id);
                    }
                }
            } catch (error) {
                console.error(`Error getting embeddings for file ${normalizedFilePath}:`, error);
                // Continue with other files even if one fails
            }
        }

        if (embeddingIdsToDelete.length > 0) {
            try {
                await this.repository.bulkDeleteEmbeddings(embeddingIdsToDelete);
                deletedCount = embeddingIdsToDelete.length;
                console.log(`[CodebaseEmbeddingService] Cleaned up ${deletedCount} embeddings for ${filePaths.length} files.`);
            } catch (error) {
                console.error(`Error bulk deleting embeddings:`, error);
                // Return partial success (0 deleted due to error)
                deletedCount = 0;
            }
        }

        return { deletedCount };
    }

    private generateChunkHash(text: string): string {
        return crypto.createHash('sha256').update(text).digest('hex');
    }

    private generateFileHash(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    public async generateAndStoreEmbeddingsForFile(
        agentId: string,
        filePath: string,
        projectRootPath: string,
        strategy: ChunkingStrategy = 'auto',
        includeSummaryPatterns?: string[],
        excludeSummaryPatterns?: string[],
        storeEntitySummaries: boolean = true
    ): Promise<EmbeddingIngestionResult> {
        return this.generateAndStoreEmbeddingsForMultipleFiles(
            agentId,
            [filePath],
            projectRootPath,
            strategy,
            includeSummaryPatterns,
            excludeSummaryPatterns,
            storeEntitySummaries
        );
    }

    private async _processBatchOfFiles(
        agentId: string,
        filesToProcess: Array<{ absolutePath: string, relativePath: string }>,
        projectRootPath: string,
        strategy: ChunkingStrategy,
        storeEntitySummaries: boolean,
        existingFileHashes: Map<string, string>
    ): Promise<Omit<EmbeddingIngestionResult, 'totalTimeMs' | 'deletedEmbeddingsCount'>> {
        const chunksToEmbed: Array<{ chunk: any, fileInfo: any }> = [];
        const report: Omit<EmbeddingIngestionResult, 'totalTimeMs' | 'deletedEmbeddingsCount'> = {
            newEmbeddingsCount: 0,
            reusedEmbeddingsCount: 0,
            newEmbeddings: [],
            reusedEmbeddings: [],
            deletedEmbeddings: [],
            scannedFiles: [],
            embeddingRequestCount: 0,
            embeddingRetryCount: 0,
            totalTokensProcessed: 0,
            namingApiCallCount: 0,
            summarizationApiCallCount: 0,
            dbCallCount: 0,
            dbCallLatencyMs: 0
        };

        // Process files in parallel with error isolation
        await Promise.all(filesToProcess.map(async (fileInfo) => {
            try {
                const fileContent = await fs.readFile(fileInfo.absolutePath, 'utf-8');
                if (!fileContent.trim()) {
                    report.scannedFiles.push({ file_path_relative: fileInfo.relativePath, status: 'skipped' });
                    return;
                }

                const currentFileHash = this.generateFileHash(fileContent);
                if (existingFileHashes.get(fileInfo.relativePath) === currentFileHash) {
                    console.log(`[Idempotency Skip] File has not changed: ${fileInfo.relativePath}`);
                    report.scannedFiles.push({ file_path_relative: fileInfo.relativePath, status: 'skipped' });
                    return;
                }

                const existingEmbeddingsForFile = await this.repository.getEmbeddingsForFile(fileInfo.relativePath, agentId);
                const existingChunkHashesMap = new Map<string, CodebaseEmbeddingRecord>();
                existingEmbeddingsForFile.forEach(e => existingChunkHashesMap.set(e.chunk_hash, e));

                const language = await this.introspectionService.detectLanguage(agentId, fileInfo.absolutePath, path.basename(fileInfo.absolutePath));

                let multiVectorChunks;
                let summarizationApiCallCount = 0;
                try {
                    const result = await this.chunkingService.chunkFileForMultiVector(
                        agentId,
                        fileInfo.absolutePath,
                        fileContent,
                        fileInfo.relativePath,
                        language
                    );
                    multiVectorChunks = result.chunks;
                    summarizationApiCallCount = result.summarizationApiCallCount;
                } catch (error) {
                    console.error(`Error chunking file ${fileInfo.relativePath}:`, error);
                    report.scannedFiles.push({ file_path_relative: fileInfo.relativePath, status: 'error' });
                    return;
                }

                report.summarizationApiCallCount += summarizationApiCallCount;

                const currentFileChunksToEmbed: Array<{ chunk: any, fileInfo: any }> = [];
                const idsToDelete: string[] = [];
                const retainedEmbeddingIds = new Set<string>();

                for (const newChunk of multiVectorChunks) {
                    const newChunkHash = this.generateChunkHash(newChunk.chunk_text);
                    newChunk.chunk_hash = newChunkHash; // Ensure chunk has hash for comparison

                    const existingEmbedding = existingChunkHashesMap.get(newChunkHash);

                    if (existingEmbedding) {
                        // Chunk exists and is unchanged, reuse it
                        report.reusedEmbeddings.push({
                            file_path_relative: fileInfo.relativePath,
                            chunk_text: newChunk.chunk_text,
                            entity_name: newChunk.entity_name
                        });
                        report.reusedEmbeddingsCount++;
                        retainedEmbeddingIds.add(existingEmbedding.embedding_id);
                        // Update file hash if necessary for the reused embedding record
                        if (existingEmbedding.file_hash !== currentFileHash) {
                            await this.repository.updateFileHashForEmbedding(existingEmbedding.embedding_id, currentFileHash);
                        }
                    } else {
                        // New or modified chunk, needs new embedding
                        currentFileChunksToEmbed.push({
                            chunk: newChunk,
                            fileInfo: { ...fileInfo, fileHash: currentFileHash }
                        });
                    }
                }

                // Identify chunks to be deleted (those that existed but are no longer present or modified)
                for (const existingEmbedding of existingEmbeddingsForFile) {
                    if (!retainedEmbeddingIds.has(existingEmbedding.embedding_id)) {
                        idsToDelete.push(existingEmbedding.embedding_id);
                        report.deletedEmbeddings.push({
                            file_path_relative: existingEmbedding.file_path_relative,
                            chunk_text: existingEmbedding.chunk_text,
                            entity_name: existingEmbedding.entity_name
                        });
                    }
                }

                // Perform deletions before new insertions
                if (idsToDelete.length > 0) {
                    try {
                        const deletedCount = await this.repository.bulkDeleteEmbeddings(idsToDelete);
                        console.log(`[CodebaseEmbeddingService] Deleted ${deletedCount} stale chunks from ${fileInfo.relativePath}`);
                    } catch (error) {
                        console.error(`Error deleting stale embeddings for ${fileInfo.relativePath}:`, error);
                    }
                }

                // Add new/modified chunks to the global list for embedding generation
                chunksToEmbed.push(...currentFileChunksToEmbed);

                report.scannedFiles.push({ file_path_relative: fileInfo.relativePath, status: 'processed' });
            } catch (err) {
                console.error(`Error processing file ${fileInfo.absolutePath}:`, err);
                report.scannedFiles.push({ file_path_relative: fileInfo.relativePath, status: 'error' });
            }
        }));

        // Process embeddings in batches with error handling
        if (chunksToEmbed.length > 0) {
            const textsToEmbed = chunksToEmbed.map(item => item.chunk.chunk_text);
            let embeddings;
            try {
                embeddings = await this.aiProvider.getEmbeddingsForChunks(textsToEmbed);
                report.embeddingRequestCount = embeddings.requestCount;
                report.embeddingRetryCount = embeddings.retryCount;
                report.totalTokensProcessed = embeddings.totalTokensProcessed;
            } catch (error) {
                console.error(`Error generating embeddings:`, error);
                // Return partial results
                return report;
            }

            const newEmbeddingsToStore: CodebaseEmbeddingRecord[] = [];
            const parentIdMap = new Map<string, string>();

            // First pass: create records and identify parent IDs
            embeddings.embeddings.forEach((embeddingResult, index) => {
                if (embeddingResult) {
                    const { chunk } = chunksToEmbed[index];
                    const embeddingId = crypto.randomUUID();
                    if (chunk.embedding_type === 'summary' && chunk.parent_embedding_id) {
                        parentIdMap.set(chunk.parent_embedding_id, embeddingId);
                    }
                    chunksToEmbed[index].chunk.final_embedding_id = embeddingId;
                }
            });

            // Second pass: build the final records with correct parent links
            await Promise.all(embeddings.embeddings.map(async (embeddingResult, index) => {
                if (embeddingResult) {
                    const { chunk, fileInfo } = chunksToEmbed[index];
                    const vectorBuffer = Buffer.alloc(embeddingResult.vector.length * VECTOR_FLOAT_SIZE);
                    embeddingResult.vector.forEach((val, i) => vectorBuffer.writeFloatLE(val, i * VECTOR_FLOAT_SIZE));

                    let entityNameVectorBlob: Buffer | null = null;
                    let entityNameVectorDimensions: number | null = null;

                    if (chunk.entity_name) {
                        try {
                            const { embeddings: entityNameEmbeddings } = await this.aiProvider.getEmbeddingsForChunks([chunk.entity_name]);
                            if (entityNameEmbeddings && entityNameEmbeddings[0] && entityNameEmbeddings[0].vector) {
                                entityNameVectorBlob = Buffer.alloc(entityNameEmbeddings[0].vector.length * VECTOR_FLOAT_SIZE);
                                entityNameEmbeddings[0].vector.forEach((val, i) => entityNameVectorBlob!.writeFloatLE(val, i * VECTOR_FLOAT_SIZE));
                                entityNameVectorDimensions = entityNameEmbeddings[0].dimensions;
                            }
                            report.namingApiCallCount++; // Increment count for entity name embedding API call
                        } catch (error) {
                            console.warn(`Error generating embedding for entity name "${chunk.entity_name}":`, error);
                        }
                    }

                    newEmbeddingsToStore.push({
                        embedding_id: chunk.final_embedding_id,
                        agent_id: agentId,
                        chunk_text: chunk.chunk_text,
                        entity_name: chunk.entity_name || null,
                        entity_name_vector_blob: entityNameVectorBlob,
                        entity_name_vector_dimensions: entityNameVectorDimensions,
                        vector_blob: vectorBuffer,
                        vector_dimensions: embeddingResult.dimensions,
                        model_name: DEFAULT_EMBEDDING_MODEL,
                        chunk_hash: chunk.chunk_hash || this.generateChunkHash(chunk.chunk_text),
                        file_hash: fileInfo.fileHash,
                        metadata_json: JSON.stringify(chunk.metadata || {}),
                        created_timestamp_unix: Math.floor(Date.now() / 1000),
                        file_path_relative: fileInfo.relativePath,
                        full_file_path: fileInfo.absolutePath,
                        embedding_type: chunk.embedding_type,
                        parent_embedding_id: chunk.embedding_type === 'chunk' ?
                            parentIdMap.get(chunk.parent_embedding_id) :
                            chunk.final_embedding_id,
                    });

                    report.newEmbeddings.push({
                        file_path_relative: fileInfo.relativePath,
                        chunk_text: chunk.chunk_text,
                        entity_name: chunk.entity_name
                    });
                }
            }));

            report.newEmbeddingsCount = newEmbeddingsToStore.length;

            // Store embeddings with error handling
            if (newEmbeddingsToStore.length > 0) {
                try {
                    await this.repository.bulkInsertEmbeddings(newEmbeddingsToStore);
                } catch (error) {
                    console.error(`Error bulk inserting embeddings:`, error);
                    // Return partial results
                }
            }
        }

        return report;
    }

    public async generateAndStoreEmbeddingsForMultipleFiles(
        agentId: string,
        filePaths: string[],
        projectRootPath: string,
        strategy: ChunkingStrategy = 'auto',
        includeSummaryPatterns?: string[],
        excludeSummaryPatterns?: string[],
        storeEntitySummaries: boolean = true
    ): Promise<EmbeddingIngestionResult> {
        const startTime = Date.now();
        const absoluteProjectRootPath = path.resolve(projectRootPath);
        const existingFileHashes = await this.repository.getLatestFileHashes(agentId);

        const filesToProcess = filePaths.map(fp => {
            const absolutePath = path.resolve(absoluteProjectRootPath, fp);
            const relativePath = path.relative(absoluteProjectRootPath, absolutePath).replace(/\\/g, '/');
            return { absolutePath, relativePath };
        });

        const result = await this._processBatchOfFiles(
            agentId,
            filesToProcess,
            absoluteProjectRootPath,
            strategy,
            storeEntitySummaries,
            existingFileHashes
        );

        return {
            ...result,
            deletedEmbeddingsCount: result.deletedEmbeddings.length,
            aiSummary: '',
            totalTimeMs: Date.now() - startTime
        };
    }

    public async generateAndStoreEmbeddingsForDirectory(
        agentId: string,
        directoryPath: string,
        projectRootPath: string,
        strategy: ChunkingStrategy = 'auto',
        includeSummaryPatterns?: string[],
        excludeSummaryPatterns?: string[],
        storeEntitySummaries: boolean = true
    ): Promise<EmbeddingIngestionResult> {
        const startTime = Date.now();
        const absoluteProjectRootPath = path.resolve(projectRootPath);
        const absoluteDirectoryPath = path.resolve(directoryPath);
        const existingFileHashes = await this.repository.getLatestFileHashes(agentId);
        const allDbFilePaths = new Set(await this.repository.getAllFilePathsForAgent(agentId));

        const scannedItems = await this.introspectionService.scanDirectoryRecursive(
            agentId,
            absoluteDirectoryPath,
            absoluteProjectRootPath
        );

        const filesToProcess = scannedItems
            .filter(item => item.type === 'file' && (
                (item.language && [
                    'typescript', 'javascript', 'python', 'markdown', 'json',
                    'html', 'css', 'java', 'csharp', 'go', 'ruby', 'php'
                ].includes(item.language)) ||
                (!item.language && item.stats.size > 0 && item.stats.size < 1024 * 1024)
            ))
            .map(item => ({
                absolutePath: item.path,
                relativePath: item.name
            }));

        const result = await this._processBatchOfFiles(
            agentId,
            filesToProcess,
            absoluteProjectRootPath,
            strategy,
            storeEntitySummaries,
            existingFileHashes
        );

        const processedFilePaths = new Set(filesToProcess.map(f => f.relativePath));
        const staleFiles: string[] = Array.from(allDbFilePaths).filter(dbPath => {
            const isUnderDirectory = path.resolve(absoluteProjectRootPath, dbPath).startsWith(absoluteDirectoryPath);
            return isUnderDirectory && !processedFilePaths.has(dbPath);
        });

        let deletedEmbeddingsCount = result.deletedEmbeddings.length;
        if (staleFiles.length > 0) {
            console.log(`[CodebaseEmbeddingService] Found ${staleFiles.length} stale files in DB to clean up...`);
            try {
                const cleanupResult = await this.cleanUpEmbeddingsByFilePaths(
                    agentId,
                    staleFiles,
                    absoluteProjectRootPath,
                    true
                );
                deletedEmbeddingsCount += cleanupResult.deletedCount;
            } catch (error) {
                console.error(`Error cleaning up stale embeddings:`, error);
            }
        }

        return {
            ...result,
            deletedEmbeddingsCount,
            aiSummary: '',
            totalTimeMs: Date.now() - startTime
        };
    }

    public async retrieveSimilarCodeChunks(
        agentId: string,
        queryText: string,
        topK: number = 5,
        targetFilePaths?: string[],
        exclude_chunk_types?: string[]
    ): Promise<Array<{
        chunk_text: string;
        ai_summary_text?: string | null;
        file_path_relative: string;
        entity_name: string | null;
        score: number;
        metadata?: Record<string, any> | null
    }>> {
        let queryEmbedding;
        try {
            const { embeddings } = await this.aiProvider.getEmbeddingsForChunks([queryText]);
            queryEmbedding = embeddings[0];
        } catch (error) {
            console.error(`Error generating query embedding:`, error);
            throw new Error(`Failed to generate embedding for query text: ${error instanceof Error ? error.message : String(error)}`);
        }

        if (!queryEmbedding || !queryEmbedding.vector) {
            throw new Error("Failed to generate embedding for query text.");
        }

        try {
            // Step 1: Retrieve initial set of relevant chunks
            const initialChunks = await this.repository.findSimilarEmbeddingsWithMetadata(
                queryEmbedding.vector,
                queryText, // Pass query text for potential hybrid search in repo
                topK * 2, // Retrieve more initial chunks to find unique parents
                agentId,
                targetFilePaths,
                exclude_chunk_types
            );

            if (initialChunks.length === 0) {
                return [];
            }

            // Step 2: Implement Parent Document Retrieval logic
            const parentIds = new Set<string>();
            initialChunks.forEach(chunk => {
                if (chunk.parent_embedding_id) {
                    parentIds.add(chunk.parent_embedding_id);
                }
            });

            let parentChunks: CodebaseEmbeddingRecord[] = [];
            if (parentIds.size > 0) {
                parentChunks = await this.repository.getEmbeddingsByIds(Array.from(parentIds));
            }

            // Step 3: Combine and deduplicate results
            // Give parent chunks a slight score boost to prioritize them
            const combinedResults = [
                ...initialChunks,
                ...parentChunks.map(p => ({ ...p, similarity: 0.9 })) // Assign high similarity
            ];

            const uniqueResults = Array.from(new Map(combinedResults.map(item => [item.embedding_id, item])).values());

            // Re-rank based on similarity score
            uniqueResults.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));

            const finalResults = uniqueResults.slice(0, topK);

            return finalResults.map(chunk => ({
                chunk_text: chunk.chunk_text,
                ai_summary_text: chunk.ai_summary_text,
                file_path_relative: chunk.file_path_relative,
                entity_name: chunk.entity_name,
                score: chunk.similarity,
                metadata: chunk.metadata_json ? JSON.parse(chunk.metadata_json) : null
            }));

        } catch (error) {
            console.error(`Error retrieving similar code chunks:`, error);
            throw new Error(`Failed to retrieve similar code chunks: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}