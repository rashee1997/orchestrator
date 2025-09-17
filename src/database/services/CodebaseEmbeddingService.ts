import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { MemoryManager } from '../memory_manager.js';
import { GeminiIntegrationService } from './GeminiIntegrationService.js';
import { CodebaseIntrospectionService } from './CodebaseIntrospectionService.js';
import { Database } from 'better-sqlite3';
import { EmbeddingCache } from './embeddings/EmbeddingCache.js';
import { AIEmbeddingProvider } from './embeddings/AIEmbeddingProvider.js';
import { ParallelEmbeddingManager } from './embeddings/ParallelEmbeddingManager.js';
import { CodeChunkingService } from './embeddings/CodeChunkingService.js';
import { CodebaseEmbeddingRepository } from '../repositories/CodebaseEmbeddingRepository.js';
import { ChunkingStrategy, CodebaseEmbeddingRecord, EmbeddingIngestionResult } from '../../types/codebase_embeddings.js';
import { DEFAULT_EMBEDDING_MODEL, VECTOR_FLOAT_SIZE } from '../../constants/embedding_constants.js';
import { deduplicateContexts } from '../../utils/context_utils.js';
import { PathValidator } from '../../utils/pathValidator.js';
import { RetrievedCodeContext } from './CodebaseContextRetrieverService.js';

export class CodebaseEmbeddingService {
    public repository: CodebaseEmbeddingRepository;
    private aiProvider: AIEmbeddingProvider;
    private parallelEmbeddingManager: ParallelEmbeddingManager;
    public chunkingService: CodeChunkingService;
    public embeddingCache: EmbeddingCache;
    public introspectionService: CodebaseIntrospectionService;

    constructor(
        memoryManager: MemoryManager,
        vectorDbConnection: Database,
        geminiService: GeminiIntegrationService
    ) {
        this.repository = new CodebaseEmbeddingRepository(vectorDbConnection);
        this.aiProvider = new AIEmbeddingProvider(geminiService, 'gemini', 3, 1000, 100, 20000, 30000, memoryManager);
        this.parallelEmbeddingManager = new ParallelEmbeddingManager(geminiService);
        this.introspectionService = new CodebaseIntrospectionService(memoryManager);
        this.chunkingService = new CodeChunkingService(
            this.introspectionService,
            this.aiProvider,
            memoryManager
        );
        this.embeddingCache = new EmbeddingCache(vectorDbConnection);

        // Log the shared embedding configuration
        const embeddingInfo = this.parallelEmbeddingManager.getSharedEmbeddingInfo();
        console.log(`[CodebaseEmbeddingService] ${embeddingInfo.sharedProcessDescription}`);
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

    /**
     * Get information about the current shared embedding configuration
     */
    public getSharedEmbeddingInfo() {
        return this.parallelEmbeddingManager.getSharedEmbeddingInfo();
    }

    /**
     * Clear all caches to force fresh scanning and parsing for ingestion
     */
    public clearAllCaches(): void {
        this.introspectionService.clearAllCaches();
        console.log('[CodebaseEmbeddingService] All introspection caches cleared');
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
        providerType: string = 'gemini',
        includeSummaryPatterns?: string[],
        excludeSummaryPatterns?: string[],
        storeEntitySummaries: boolean = true
    ): Promise<EmbeddingIngestionResult> {
        return this.generateAndStoreEmbeddingsForMultipleFiles(
            agentId,
            [filePath],
            projectRootPath,
            strategy,
            providerType,
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
        providerType: string,
        storeEntitySummaries: boolean,
        existingFileHashes: Map<string, string>
    ): Promise<Omit<EmbeddingIngestionResult, 'totalTimeMs' | 'deletedEmbeddingsCount'>> {
        const chunksToEmbed: Array<{ chunk: any, fileInfo: any }> = [];
        const report: Omit<EmbeddingIngestionResult, 'totalTimeMs' | 'deletedEmbeddingsCount'> = {
            newEmbeddingsCount: 0,
            reusedEmbeddingsCount: 0,
            reusedFilesCount: 0,
            newEmbeddings: [],
            reusedEmbeddings: [],
            reusedFiles: [],
            deletedEmbeddings: [],
            scannedFiles: [],
            embeddingRequestCount: 0,
            embeddingRetryCount: 0,
            totalTokensProcessed: 0,
            namingApiCallCount: 0,
            summarizationApiCallCount: 0,
            dbCallCount: 0,
            dbCallLatencyMs: 0,
            processingErrors: [],
            batchStatus: 'complete',
            resumeInfo: { failedFiles: [] }
        };

        // Process files in parallel with error isolation
        await Promise.all(filesToProcess.map(async (fileInfo) => {
            try {
                // Secure file reading with path validation
                const fileContent = await PathValidator.safeReadFile(fileInfo.absolutePath, 'utf-8');
                if (!fileContent.trim()) {
                    report.scannedFiles.push({ file_path_relative: fileInfo.relativePath, status: 'skipped' });
                    return;
                }

                const currentFileHash = this.generateFileHash(fileContent);
                if (existingFileHashes.get(fileInfo.relativePath) === currentFileHash) {
                    console.log(`[Idempotency Skip] File has not changed: ${fileInfo.relativePath}`);
                    
                    // Get existing embeddings count for this file to report reuse accurately
                    const existingEmbeddingsForUnchangedFile = await this.repository.getEmbeddingsForFile(fileInfo.relativePath, agentId);
                    const existingChunkCount = existingEmbeddingsForUnchangedFile.length;
                    
                    // Update metrics to reflect file-level reuse
                    report.reusedFilesCount++;
                    report.reusedFiles.push({
                        file_path_relative: fileInfo.relativePath,
                        reason: 'file_unchanged',
                        chunk_count: existingChunkCount
                    });
                    
                    // Add to reused embeddings count (these embeddings are effectively reused)
                    report.reusedEmbeddingsCount += existingChunkCount;
                    
                    // Add existing embeddings to reused embeddings list for reporting
                    for (const existingEmbedding of existingEmbeddingsForUnchangedFile) {
                        report.reusedEmbeddings.push({
                            file_path_relative: fileInfo.relativePath,
                            chunk_text: existingEmbedding.chunk_text.substring(0, 100) + '...', // Truncate for display
                            entity_name: existingEmbedding.entity_name
                        });
                    }
                    
                    report.scannedFiles.push({ 
                        file_path_relative: fileInfo.relativePath, 
                        status: 'skipped',
                        skipReason: 'file_unchanged' 
                    });
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
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    console.error(`Error chunking file ${fileInfo.relativePath}:`, error);
                    
                    report.processingErrors.push({
                        file_path_relative: fileInfo.relativePath,
                        error: errorMessage,
                        stage: 'chunking'
                    });
                    
                    report.resumeInfo!.failedFiles.push(fileInfo.relativePath);
                    report.batchStatus = 'partial';
                    
                    report.scannedFiles.push({ 
                        file_path_relative: fileInfo.relativePath, 
                        status: 'error',
                        skipReason: `chunking_failed: ${errorMessage}` 
                    });
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
                const errorMessage = err instanceof Error ? err.message : String(err);
                console.error(`Error processing file ${fileInfo.absolutePath}:`, err);
                
                report.processingErrors.push({
                    file_path_relative: fileInfo.relativePath,
                    error: errorMessage,
                    stage: 'file_processing'
                });
                
                report.resumeInfo!.failedFiles.push(fileInfo.relativePath);
                report.batchStatus = 'partial';
                
                report.scannedFiles.push({ 
                    file_path_relative: fileInfo.relativePath, 
                    status: 'error',
                    skipReason: `processing_failed: ${errorMessage}` 
                });
            }
        }));

        // Process embeddings in batches with error handling
        if (chunksToEmbed.length > 0) {
            const textsToEmbed = chunksToEmbed.map(item => item.chunk.chunk_text);
            let embeddings;
            try {
                console.log(`[CodebaseEmbeddingService] Using shared embedding process with both Codestral and Gemini for ${textsToEmbed.length} texts`);

                // Use the parallel embedding manager for shared embedding process
                const parallelResult = await this.parallelEmbeddingManager.generateEmbeddings(textsToEmbed);

                // Convert parallel embedding result to the format expected by the rest of the code
                embeddings = {
                    embeddings: parallelResult.embeddings.map(embedding => ({
                        vector: embedding?.vector || null,
                        dimensions: embedding?.dimensions || 3072,
                        model: embedding?.model || parallelResult.primaryModel,
                        provider: embedding?.provider || 'gemini'
                    })),
                    requestCount: 1, // One request to parallel manager
                    retryCount: 0, // Parallel manager handles retries internally
                    totalTokensProcessed: parallelResult.totalTokensProcessed,
                    model: parallelResult.primaryModel,
                    actualDimensions: parallelResult.embeddings[0]?.dimensions || 3072,
                    // Store parallel processing metadata for database insertion
                    parallelMetadata: {
                        requestId: parallelResult.requestId,
                        modelDistribution: parallelResult.modelDistribution,
                        fallbackUsed: parallelResult.fallbackUsed
                    }
                };

                report.embeddingRequestCount = embeddings.requestCount;
                report.embeddingRetryCount = embeddings.retryCount;
                report.totalTokensProcessed = embeddings.totalTokensProcessed;

                console.log(`[CodebaseEmbeddingService] Shared embedding complete: ${parallelResult.successfulRequests}/${textsToEmbed.length} successful, primary model: ${parallelResult.primaryModel}, distribution: ${JSON.stringify(parallelResult.modelDistribution)}`);
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.error(`Error generating embeddings:`, error);
                
                // Mark all files with chunks to embed as failed for this batch
                const affectedFiles = new Set(chunksToEmbed.map(item => item.fileInfo.relativePath));
                for (const filePath of affectedFiles) {
                    report.processingErrors.push({
                        file_path_relative: filePath,
                        error: errorMessage,
                        stage: 'embedding_generation'
                    });
                    
                    if (!report.resumeInfo!.failedFiles.includes(filePath)) {
                        report.resumeInfo!.failedFiles.push(filePath);
                    }
                    
                    // Update scan status for affected files
                    const scanEntry = report.scannedFiles.find(f => f.file_path_relative === filePath);
                    if (scanEntry && scanEntry.status === 'processed') {
                        scanEntry.status = 'partial';
                        scanEntry.skipReason = `embedding_failed: ${errorMessage}`;
                    }
                }
                
                report.batchStatus = 'partial';
                console.warn(`Embedding generation failed for ${affectedFiles.size} files. These files will need to be reprocessed.`);
                
                // Return partial results with detailed error information
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
            const generationTimestamp = Date.now();
            await Promise.all(embeddings.embeddings.map(async (embeddingResult, index) => {
                if (embeddingResult && embeddingResult.vector) {
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
                        model_name: embeddingResult.model || embeddings.model,
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
                        // New parallel embedding metadata
                        embedding_provider: embeddingResult.provider || 'gemini',
                        embedding_model_full_name: embeddingResult.model || embeddings.model,
                        embedding_generation_method: embeddings.parallelMetadata ? 'parallel' : 'single',
                        embedding_request_id: embeddings.parallelMetadata?.requestId || null,
                        embedding_quality_score: 1.0, // Default quality score
                        embedding_generation_timestamp: generationTimestamp
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
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    console.error(`Error bulk inserting embeddings:`, error);
                    
                    // Mark files as having database insertion failures
                    const affectedFiles = new Set(newEmbeddingsToStore.map(embedding => embedding.file_path_relative));
                    for (const filePath of affectedFiles) {
                        report.processingErrors.push({
                            file_path_relative: filePath,
                            error: errorMessage,
                            stage: 'database_insertion'
                        });
                        
                        if (!report.resumeInfo!.failedFiles.includes(filePath)) {
                            report.resumeInfo!.failedFiles.push(filePath);
                        }
                    }
                    
                    report.batchStatus = 'partial';
                    console.warn(`Database insertion failed for ${affectedFiles.size} files. Embeddings were generated but not stored.`);
                }
            }
        }

        return report;
    }

    /**
     * Process files in smaller batches to avoid API rate limiting
     */
    private async _processBatchedFiles(
        agentId: string,
        filesToProcess: Array<{ absolutePath: string, relativePath: string }>,
        projectRootPath: string,
        strategy: ChunkingStrategy,
        providerType: string,
        storeEntitySummaries: boolean,
        existingFileHashes: Map<string, string>,
        batchSize: number = 3,
        batchDelayMs: number = 2000
    ): Promise<Omit<EmbeddingIngestionResult, 'totalTimeMs' | 'deletedEmbeddingsCount'>> {

        // Initialize combined report
        const combinedReport: Omit<EmbeddingIngestionResult, 'totalTimeMs' | 'deletedEmbeddingsCount'> = {
            newEmbeddingsCount: 0,
            reusedEmbeddingsCount: 0,
            reusedFilesCount: 0,
            newEmbeddings: [],
            reusedEmbeddings: [],
            reusedFiles: [],
            deletedEmbeddings: [],
            scannedFiles: [],
            embeddingRequestCount: 0,
            embeddingRetryCount: 0,
            totalTokensProcessed: 0 as number,
            namingApiCallCount: 0,
            summarizationApiCallCount: 0,
            dbCallCount: 0,
            dbCallLatencyMs: 0,
            processingErrors: [],
            batchStatus: 'complete',
            resumeInfo: { failedFiles: [] }
        };

        // Split files into batches
        const batches: Array<Array<{ absolutePath: string, relativePath: string }>> = [];
        for (let i = 0; i < filesToProcess.length; i += batchSize) {
            batches.push(filesToProcess.slice(i, i + batchSize));
        }

        console.log(`[_processBatchedFiles] Processing ${filesToProcess.length} files in ${batches.length} batches of ${batchSize} files each`);

        // Process each batch with delays
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex];
            console.log(`[_processBatchedFiles] Processing batch ${batchIndex + 1}/${batches.length}: [${batch.map(f => f.relativePath).join(', ')}]`);

            try {
                const batchResult = await this._processBatchOfFiles(
                    agentId,
                    batch,
                    projectRootPath,
                    strategy,
                    providerType,
                    storeEntitySummaries,
                    existingFileHashes
                );

                // Merge batch results into combined report
                combinedReport.newEmbeddingsCount += batchResult.newEmbeddingsCount;
                combinedReport.reusedEmbeddingsCount += batchResult.reusedEmbeddingsCount;
                combinedReport.reusedFilesCount += batchResult.reusedFilesCount;
                combinedReport.newEmbeddings.push(...batchResult.newEmbeddings);
                combinedReport.reusedEmbeddings.push(...batchResult.reusedEmbeddings);
                combinedReport.reusedFiles.push(...batchResult.reusedFiles);
                combinedReport.deletedEmbeddings.push(...batchResult.deletedEmbeddings);
                combinedReport.scannedFiles.push(...batchResult.scannedFiles);
                combinedReport.embeddingRequestCount += batchResult.embeddingRequestCount;
                combinedReport.embeddingRetryCount += batchResult.embeddingRetryCount;
                combinedReport.totalTokensProcessed = (combinedReport.totalTokensProcessed || 0) + (batchResult.totalTokensProcessed || 0);
                combinedReport.namingApiCallCount += batchResult.namingApiCallCount;
                combinedReport.summarizationApiCallCount += batchResult.summarizationApiCallCount;
                combinedReport.dbCallCount += batchResult.dbCallCount;
                combinedReport.dbCallLatencyMs += batchResult.dbCallLatencyMs;
                combinedReport.processingErrors.push(...batchResult.processingErrors);

                // Merge failed files
                if (batchResult.resumeInfo?.failedFiles) {
                    combinedReport.resumeInfo!.failedFiles.push(...batchResult.resumeInfo.failedFiles);
                }

                // Update batch status if any batch had issues
                if (batchResult.batchStatus === 'failed') {
                    combinedReport.batchStatus = 'failed';
                } else if (batchResult.batchStatus === 'partial' && combinedReport.batchStatus === 'complete') {
                    combinedReport.batchStatus = 'partial';
                }

                console.log(`[_processBatchedFiles] Batch ${batchIndex + 1} completed: ${batchResult.newEmbeddingsCount} new, ${batchResult.reusedEmbeddingsCount} reused, ${batchResult.reusedFilesCount} files reused`);

                // Add delay between batches (except for the last batch)
                if (batchIndex < batches.length - 1) {
                    console.log(`[_processBatchedFiles] Waiting ${batchDelayMs}ms before next batch...`);
                    await new Promise(resolve => setTimeout(resolve, batchDelayMs));
                }

            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.error(`[_processBatchedFiles] Batch ${batchIndex + 1} failed:`, errorMessage);

                // Add failed files to resume info
                for (const file of batch) {
                    combinedReport.resumeInfo!.failedFiles.push(file.relativePath);
                    combinedReport.processingErrors.push({
                        file_path_relative: file.relativePath,
                        error: errorMessage,
                        stage: 'batch_processing'
                    });
                }

                combinedReport.batchStatus = 'partial';

                // Continue with next batch even if this one failed
                continue;
            }
        }

        console.log(`[_processBatchedFiles] All batches completed. Total: ${combinedReport.newEmbeddingsCount} new, ${combinedReport.reusedEmbeddingsCount} reused, ${combinedReport.reusedFilesCount} files reused`);

        // Add metadata to help AI summary understand this was a batched operation
        combinedReport.batchMetadata = {
            totalBatches: batches.length,
            batchSize: batchSize,
            totalFilesProcessed: filesToProcess.length,
            batchDelayMs: batchDelayMs
        };

        return combinedReport;
    }

    /**
     * Pre-filter files to identify only those that have changed or are new
     */
    private async _identifyChangedFiles(
        filesToProcess: Array<{ absolutePath: string, relativePath: string }>,
        existingFileHashes: Map<string, string>
    ): Promise<Array<{ absolutePath: string, relativePath: string }>> {
        const changedFiles: Array<{ absolutePath: string, relativePath: string }> = [];

        await Promise.all(filesToProcess.map(async (fileInfo) => {
            try {
                // Secure file reading with path validation
                const fileContent = await PathValidator.safeReadFile(fileInfo.absolutePath, 'utf-8');
                if (!fileContent.trim()) {
                    return; // Skip empty files
                }

                const currentFileHash = this.generateFileHash(fileContent);
                const existingHash = existingFileHashes.get(fileInfo.relativePath);

                if (existingHash !== currentFileHash) {
                    // File is new or changed
                    changedFiles.push(fileInfo);
                }
                // If hashes match, file is unchanged and will be skipped
            } catch (error) {
                // If we can't read the file, consider it changed to be safe
                console.warn(`Could not read file ${fileInfo.relativePath}, considering it changed:`, error);
                changedFiles.push(fileInfo);
            }
        }));

        return changedFiles;
    }

    /**
     * Calculate optimal batch size based on number of changed files
     */
    private _calculateOptimalBatchSize(changedFileCount: number): number {
        if (changedFileCount <= 3) return changedFileCount; // Single batch
        if (changedFileCount <= 6) return Math.ceil(changedFileCount / 2); // 2 batches
        if (changedFileCount <= 12) return 3; // 3-4 batches
        if (changedFileCount <= 20) return 4; // 5 batches max
        return 5; // Larger batches for many files
    }

    /**
     * Calculate optimal delay based on number of changed files
     */
    private _calculateOptimalDelay(changedFileCount: number): number {
        if (changedFileCount <= 3) return 0; // No delay for single batch
        if (changedFileCount <= 6) return 1000; // 1 second for 2 batches
        if (changedFileCount <= 12) return 1500; // 1.5 seconds
        return 2000; // 2 seconds for larger operations
    }

    /**
     * Create result for when no files need processing (all unchanged)
     */
    private async _createUnchangedFilesResult(
        agentId: string,
        unchangedFiles: Array<{ absolutePath: string, relativePath: string }>
    ): Promise<Omit<EmbeddingIngestionResult, 'totalTimeMs' | 'deletedEmbeddingsCount'>> {
        const result: Omit<EmbeddingIngestionResult, 'totalTimeMs' | 'deletedEmbeddingsCount'> = {
            newEmbeddingsCount: 0,
            reusedEmbeddingsCount: 0,
            reusedFilesCount: unchangedFiles.length,
            newEmbeddings: [],
            reusedEmbeddings: [],
            reusedFiles: [],
            deletedEmbeddings: [],
            scannedFiles: [],
            embeddingRequestCount: 0,
            embeddingRetryCount: 0,
            totalTokensProcessed: 0,
            namingApiCallCount: 0,
            summarizationApiCallCount: 0,
            dbCallCount: 0,
            dbCallLatencyMs: 0,
            processingErrors: [],
            batchStatus: 'complete',
            resumeInfo: { failedFiles: [] }
        };

        // Add unchanged files to the result
        for (const fileInfo of unchangedFiles) {
            const existingEmbeddingsForFile = await this.repository.getEmbeddingsForFile(fileInfo.relativePath, agentId);
            const existingChunkCount = existingEmbeddingsForFile.length;

            result.reusedFilesCount++;
            result.reusedFiles.push({
                file_path_relative: fileInfo.relativePath,
                reason: 'file_unchanged',
                chunk_count: existingChunkCount
            });

            result.reusedEmbeddingsCount += existingChunkCount;

            for (const existingEmbedding of existingEmbeddingsForFile) {
                result.reusedEmbeddings.push({
                    file_path_relative: fileInfo.relativePath,
                    chunk_text: existingEmbedding.chunk_text.substring(0, 100) + '...',
                    entity_name: existingEmbedding.entity_name
                });
            }

            result.scannedFiles.push({
                file_path_relative: fileInfo.relativePath,
                status: 'skipped',
                skipReason: 'file_unchanged'
            });
        }

        return result;
    }

    /**
     * Add unchanged files to an existing result
     */
    private async _addUnchangedFilesToResult(
        result: Omit<EmbeddingIngestionResult, 'totalTimeMs' | 'deletedEmbeddingsCount'>,
        agentId: string,
        unchangedFiles: Array<{ absolutePath: string, relativePath: string }>
    ): Promise<void> {
        for (const fileInfo of unchangedFiles) {
            const existingEmbeddingsForFile = await this.repository.getEmbeddingsForFile(fileInfo.relativePath, agentId);
            const existingChunkCount = existingEmbeddingsForFile.length;

            result.reusedFilesCount++;
            result.reusedFiles.push({
                file_path_relative: fileInfo.relativePath,
                reason: 'file_unchanged',
                chunk_count: existingChunkCount
            });

            result.reusedEmbeddingsCount += existingChunkCount;

            for (const existingEmbedding of existingEmbeddingsForFile) {
                result.reusedEmbeddings.push({
                    file_path_relative: fileInfo.relativePath,
                    chunk_text: existingEmbedding.chunk_text.substring(0, 100) + '...',
                    entity_name: existingEmbedding.entity_name
                });
            }

            result.scannedFiles.push({
                file_path_relative: fileInfo.relativePath,
                status: 'skipped',
                skipReason: 'file_unchanged'
            });
        }
    }

    public async generateAndStoreEmbeddingsForMultipleFiles(
        agentId: string,
        filePaths: string[],
        projectRootPath: string,
        strategy: ChunkingStrategy = 'auto',
        providerType: string = 'gemini',
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
            providerType,
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

    public async resumeFailedEmbeddingBatch(
        agentId: string,
        failedFiles: string[],
        projectRootPath: string,
        strategy: ChunkingStrategy = 'auto',
        providerType: string = 'gemini',
        includeSummaryPatterns?: string[],
        excludeSummaryPatterns?: string[],
        storeEntitySummaries: boolean = true
    ): Promise<EmbeddingIngestionResult> {
        console.log(`[CodebaseEmbeddingService] Resuming failed batch for ${failedFiles.length} files...`);
        
        // Filter out files that don't exist or are no longer eligible
        const validFailedFiles: string[] = [];
        for (const filePath of failedFiles) {
            try {
                const absolutePath = path.resolve(projectRootPath, filePath);
                await fs.access(absolutePath); // Check if file exists
                validFailedFiles.push(filePath);
            } catch (error) {
                console.warn(`Skipping failed file that no longer exists: ${filePath}`);
            }
        }
        
        if (validFailedFiles.length === 0) {
            console.log(`[CodebaseEmbeddingService] No valid failed files to resume.`);
            return {
                newEmbeddingsCount: 0,
                reusedEmbeddingsCount: 0,
                reusedFilesCount: 0,
                deletedEmbeddingsCount: 0,
                newEmbeddings: [],
                reusedEmbeddings: [],
                reusedFiles: [],
                deletedEmbeddings: [],
                scannedFiles: [],
                embeddingRequestCount: 0,
                embeddingRetryCount: 0,
                totalTokensProcessed: 0,
                namingApiCallCount: 0,
                summarizationApiCallCount: 0,
                dbCallCount: 0,
                dbCallLatencyMs: 0,
                processingErrors: [],
                batchStatus: 'complete',
                resumeInfo: { failedFiles: [] },
                aiSummary: 'No files to resume',
                totalTimeMs: 0
            };
        }
        
        console.log(`[CodebaseEmbeddingService] Resuming processing for ${validFailedFiles.length} failed files`);
        
        // Process only the failed files
        return this.generateAndStoreEmbeddingsForMultipleFiles(
            agentId,
            validFailedFiles,
            projectRootPath,
            strategy,
            providerType,
            includeSummaryPatterns,
            excludeSummaryPatterns,
            storeEntitySummaries
        );
    }
    
    public async generateAndStoreEmbeddingsForDirectory(
        agentId: string,
        directoryPath: string,
        projectRootPath: string,
        strategy: ChunkingStrategy = 'auto',
        providerType: string = 'gemini',
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
                    'html', 'css', 'java', 'csharp', 'go', 'ruby', 'php',
                    'sql'
                ].includes(item.language)) ||
                (!item.language && item.stats.size > 0 && item.stats.size < 1024 * 1024)
            ))
            .map(item => ({
                absolutePath: item.path,
                relativePath: item.name
            }));

        console.log(`[generateAndStoreEmbeddingsForDirectory] Filtered ${filesToProcess.length} out of ${scannedItems.filter(item => item.type === 'file').length} files for processing`);
        console.log(`[generateAndStoreEmbeddingsForDirectory] Files that would be processed:`, filesToProcess.map(f => f.relativePath));
        console.log(`[generateAndStoreEmbeddingsForDirectory] Files excluded (no language match):`, scannedItems.filter(item => item.type === 'file').filter(item => !(item.language && [
            'typescript', 'javascript', 'python', 'markdown', 'json',
            'html', 'css', 'java', 'csharp', 'go', 'ruby', 'php',
            'sql'
        ].includes(item.language)) && !(item.language && item.stats.size > 0 && item.stats.size < 1024 * 1024) && (item.language || !(item.stats.size > 0 && item.stats.size < 1024 * 1024))).map(item => ({ path: item.name, language: item.language, size: item.stats.size })));

        // Pre-filter to identify only files that actually need processing (changed or new)
        console.log(`[generateAndStoreEmbeddingsForDirectory] Pre-filtering ${filesToProcess.length} files to identify changes...`);

        const changedFiles = await this._identifyChangedFiles(filesToProcess, existingFileHashes);
        const unchangedFiles = filesToProcess.filter(file =>
            !changedFiles.find(changed => changed.relativePath === file.relativePath)
        );

        console.log(`[generateAndStoreEmbeddingsForDirectory] Found ${changedFiles.length} changed/new files, ${unchangedFiles.length} unchanged files`);

        let result: Omit<EmbeddingIngestionResult, 'totalTimeMs' | 'deletedEmbeddingsCount'>;

        if (changedFiles.length === 0) {
            // No files to process, return empty result with unchanged file stats
            console.log(`[generateAndStoreEmbeddingsForDirectory] No files need processing - all are unchanged`);
            result = await this._createUnchangedFilesResult(agentId, unchangedFiles);
        } else {
            // Dynamic batch sizing based on number of changed files
            const dynamicBatchSize = this._calculateOptimalBatchSize(changedFiles.length);
            const dynamicDelay = this._calculateOptimalDelay(changedFiles.length);

            console.log(`[generateAndStoreEmbeddingsForDirectory] Processing ${changedFiles.length} changed files with dynamic batch size: ${dynamicBatchSize}, delay: ${dynamicDelay}ms`);

            result = await this._processBatchedFiles(
                agentId,
                changedFiles,
                absoluteProjectRootPath,
                strategy,
                providerType,
                storeEntitySummaries,
                existingFileHashes,
                dynamicBatchSize,
                dynamicDelay
            );

            // Add unchanged files to the result for complete reporting
            await this._addUnchangedFilesToResult(result, agentId, unchangedFiles);
        }

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

        // Set final batch status based on overall processing
        if (result.batchStatus === 'partial' || result.processingErrors.length > 0) {
            result.batchStatus = 'partial';
        } else if (result.processingErrors.length === 0 && result.resumeInfo!.failedFiles.length === 0) {
            result.batchStatus = 'complete';
        }
        
        // Log summary of processing results
        console.log(`[CodebaseEmbeddingService] Directory processing complete:`);
        console.log(`  - Status: ${result.batchStatus}`);
        console.log(`  - Files processed: ${result.scannedFiles.filter(f => f.status === 'processed').length}`);
        console.log(`  - Files skipped: ${result.scannedFiles.filter(f => f.status === 'skipped').length}`);
        console.log(`  - Files with errors: ${result.processingErrors.length}`);
        console.log(`  - New embeddings: ${result.newEmbeddingsCount}`);
        console.log(`  - Reused embeddings: ${result.reusedEmbeddingsCount}`);
        console.log(`  - Reused files: ${result.reusedFilesCount}`);
        
        if (result.resumeInfo!.failedFiles.length > 0) {
            console.warn(`  - Files requiring retry: ${result.resumeInfo!.failedFiles.join(', ')}`);
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
        const availableModels = await this.repository.getAvailableEmbeddingModels(agentId);
        const embeddingsMap = new Map<string, any>();

        for (const model of availableModels) {
            try {
                const provider = model.includes('mistral') || model.includes('codestral') ? 'mistral' : 'gemini';
                this.aiProvider.setProvider(provider as 'gemini' | 'mistral', model);
                const { embeddings } = await this.aiProvider.getEmbeddingsForChunks([queryText], model);
                if (embeddings && embeddings[0]) {
                    embeddingsMap.set(model, embeddings[0]);
                }
            } catch (error) {
                console.error(`Error generating query embedding for model ${model}:`, error);
            }
        }

        if (embeddingsMap.size === 0) {
            throw new Error("Failed to generate embedding for query text with any available model.");
        }

        try {
            const allChunks: CodebaseEmbeddingRecord[] = [];
            for (const [model, embedding] of embeddingsMap.entries()) {
                if (embedding) {
                    const chunks = await this.repository.findSimilarEmbeddingsWithMetadata(
                        embedding.vector,
                        queryText,
                        topK * 2, // Fetch more to allow for diverse results
                        agentId,
                        targetFilePaths,
                        exclude_chunk_types,
                        model // Filter by model
                    );
                    allChunks.push(...chunks);
                }
            }

            const combinedInitialChunks = deduplicateContexts(allChunks.map(c => ({
                sourcePath: c.file_path_relative,
                entityName: c.entity_name,
                type: (c.embedding_type === 'chunk' ? 'generic_code_chunk' : 'documentation'), // Map to compatible type
                content: c.chunk_text,
                relevanceScore: c.similarity, // Use 'similarity' from CodebaseEmbeddingRecord
                metadata: c.metadata_json ? JSON.parse(c.metadata_json) : undefined
            } as RetrievedCodeContext))).map(rc => {
                const original = allChunks.find(ic => ic.file_path_relative === rc.sourcePath && ic.entity_name === rc.entityName);
                return { ...original, score: rc.relevanceScore };
            }) as CodebaseEmbeddingRecord[];


            if (combinedInitialChunks.length === 0) {
                return [];
            }

            // Step 3: Implement Parent Document Retrieval logic
            const parentIds = new Set<string>();
            combinedInitialChunks.forEach(chunk => {
                if (chunk.parent_embedding_id) {
                    parentIds.add(chunk.parent_embedding_id);
                }
            });

            let parentChunks: CodebaseEmbeddingRecord[] = [];
            if (parentIds.size > 0) {
                parentChunks = await this.repository.getEmbeddingsByIds(Array.from(parentIds));
            }

            // Step 4: Combine and deduplicate results
            // Give parent chunks a slight score boost to prioritize them
            const combinedResults = [
                ...combinedInitialChunks,
                ...parentChunks.map(p => ({ ...p, similarity: 0.9 }))
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
                score: chunk.similarity ?? 0,
                metadata: chunk.metadata_json ? JSON.parse(chunk.metadata_json) : null
            }));

        } catch (error) {
            console.error(`Error retrieving similar code chunks:`, error);
            throw new Error(`Failed to retrieve similar code chunks: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
