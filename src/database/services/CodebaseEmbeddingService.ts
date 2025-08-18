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
            const embeddings = await this.repository.getEmbeddingsForFile(normalizedFilePath, filterByAgentId ? agentId : undefined);
            for (const embedding of embeddings) {
                if (embedding.embedding_id) {
                    embeddingIdsToDelete.push(embedding.embedding_id);
                }
            }
        }

        if (embeddingIdsToDelete.length > 0) {
            await this.repository.bulkDeleteEmbeddings(embeddingIdsToDelete);
            deletedCount = embeddingIdsToDelete.length;
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
            scannedFiles: [], // Initialize new field
            embeddingRequestCount: 0,
            embeddingRetryCount: 0,
            totalTokensProcessed: 0,
            namingApiCallCount: 0,
            summarizationApiCallCount: 0,
            dbCallCount: 0,
            dbCallLatencyMs: 0
        };

        // Step 1: Concurrently process files to generate chunks and identify stale ones
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

                // First, delete all old embeddings for this file to handle updates and refactors cleanly.
                const existingEmbeddings = await this.repository.getEmbeddingsForFile(fileInfo.relativePath, agentId);
                if (existingEmbeddings.length > 0) {
                    const idsToDelete = existingEmbeddings.map(e => e.embedding_id);
                    await this.repository.bulkDeleteEmbeddings(idsToDelete);
                    existingEmbeddings.forEach(e => report.deletedEmbeddings.push({ file_path_relative: e.file_path_relative, chunk_text: e.chunk_text, entity_name: e.entity_name }));
                }

                const language = await this.introspectionService.detectLanguage(agentId, fileInfo.absolutePath, path.basename(fileInfo.absolutePath));

                // Use the new multi-vector chunking service
                const { chunks: multiVectorChunks, summarizationApiCallCount } = await this.chunkingService.chunkFileForMultiVector(agentId, fileInfo.absolutePath, fileContent, fileInfo.relativePath, language);
                report.summarizationApiCallCount += summarizationApiCallCount;

                for (const chunk of multiVectorChunks) {
                    chunksToEmbed.push({ chunk, fileInfo: { ...fileInfo, fileHash: currentFileHash } });
                }
                report.scannedFiles.push({ file_path_relative: fileInfo.relativePath, status: 'processed' });

            } catch (err) {
                console.error(`Error processing file ${fileInfo.absolutePath}:`, err);
                report.scannedFiles.push({ file_path_relative: fileInfo.relativePath, status: 'error' });
            }
        }));

        // Step 2: Batch generate embeddings for all new chunks from all files
        if (chunksToEmbed.length > 0) {
            const textsToEmbed = chunksToEmbed.map(item => item.chunk.chunk_text);
            const { embeddings, requestCount, retryCount, totalTokensProcessed } = await this.aiProvider.getEmbeddingsForChunks(textsToEmbed);
            report.embeddingRequestCount = requestCount;
            report.embeddingRetryCount = retryCount;
            report.totalTokensProcessed = totalTokensProcessed;

            const newEmbeddingsToStore: CodebaseEmbeddingRecord[] = [];
            const parentIdMap = new Map<string, string>(); // Maps temporary parent IDs to final DB IDs

            // First pass: create records and identify parent IDs
            embeddings.forEach((embeddingResult, index) => {
                if (embeddingResult) {
                    const { chunk } = chunksToEmbed[index];
                    const embeddingId = crypto.randomUUID();
                    if (chunk.embedding_type === 'summary' && chunk.parent_embedding_id) {
                        parentIdMap.set(chunk.parent_embedding_id, embeddingId);
                    }
                    chunksToEmbed[index].chunk.final_embedding_id = embeddingId; // Store final ID
                }
            });

            // Second pass: build the final records with correct parent links
            embeddings.forEach((embeddingResult, index) => {
                if (embeddingResult) {
                    const { chunk, fileInfo } = chunksToEmbed[index];
                    const vectorBuffer = Buffer.alloc(embeddingResult.vector.length * VECTOR_FLOAT_SIZE);
                    embeddingResult.vector.forEach((val, i) => vectorBuffer.writeFloatLE(val, i * VECTOR_FLOAT_SIZE));

                    newEmbeddingsToStore.push({
                        embedding_id: chunk.final_embedding_id,
                        agent_id: agentId,
                        chunk_text: chunk.chunk_text,
                        entity_name: chunk.entity_name || null,
                        vector_blob: vectorBuffer,
                        vector_dimensions: embeddingResult.dimensions,
                        model_name: DEFAULT_EMBEDDING_MODEL,
                        chunk_hash: this.generateChunkHash(chunk.chunk_text),
                        file_hash: fileInfo.fileHash,
                        metadata_json: JSON.stringify(chunk.metadata || {}),
                        created_timestamp_unix: Math.floor(Date.now() / 1000),
                        file_path_relative: fileInfo.relativePath,
                        full_file_path: fileInfo.absolutePath,
                        embedding_type: chunk.embedding_type,
                        parent_embedding_id: chunk.embedding_type === 'chunk' ? parentIdMap.get(chunk.parent_embedding_id) : chunk.final_embedding_id, // Parent links to itself
                    });
                    report.newEmbeddings.push({ file_path_relative: fileInfo.relativePath, chunk_text: chunk.chunk_text, entity_name: chunk.entity_name });
                }
            });

            report.newEmbeddingsCount = newEmbeddingsToStore.length;

            if (newEmbeddingsToStore.length > 0) {
                await this.repository.bulkInsertEmbeddings(newEmbeddingsToStore);
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

        const result = await this._processBatchOfFiles(agentId, filesToProcess, absoluteProjectRootPath, strategy, storeEntitySummaries, existingFileHashes);

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

        const scannedItems = await this.introspectionService.scanDirectoryRecursive(agentId, absoluteDirectoryPath, absoluteProjectRootPath);

        const filesToProcess = scannedItems
            .filter(item => item.type === 'file' && ((item.language && ['typescript', 'javascript', 'python', 'markdown', 'json', 'html', 'css', 'java', 'csharp', 'go', 'ruby', 'php'].includes(item.language)) || (!item.language && item.stats.size > 0 && item.stats.size < 1024 * 1024)))
            .map(item => ({ absolutePath: item.path, relativePath: item.name }));

        const result = await this._processBatchOfFiles(agentId, filesToProcess, absoluteProjectRootPath, strategy, storeEntitySummaries, existingFileHashes);

        const processedFilePaths = new Set(filesToProcess.map(f => f.relativePath));
        const staleFiles: string[] = Array.from(allDbFilePaths).filter(dbPath => {
            const isUnderDirectory = path.resolve(absoluteProjectRootPath, dbPath).startsWith(absoluteDirectoryPath);
            return isUnderDirectory && !processedFilePaths.has(dbPath);
        });

        let deletedEmbeddingsCount = result.deletedEmbeddings.length;
        if (staleFiles.length > 0) {
            const cleanupResult = await this.cleanUpEmbeddingsByFilePaths(agentId, staleFiles, absoluteProjectRootPath, true);
            deletedEmbeddingsCount += cleanupResult.deletedCount;
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
    ): Promise<Array<{ chunk_text: string; ai_summary_text?: string | null; file_path_relative: string; entity_name: string | null; score: number; metadata?: Record<string, any> | null }>> {
        const { embeddings } = await this.aiProvider.getEmbeddingsForChunks([queryText]);
        const queryEmbedding = embeddings[0];
        if (!queryEmbedding || !queryEmbedding.vector) {
            throw new Error("Failed to generate embedding for query text.");
        }

        // This method will now need to be updated to handle the two-step retrieval process
        // For now, it will only search against child chunks, but the foundation is laid.
        const rawResults = await this.repository.findSimilarEmbeddingsWithMetadata(
            queryEmbedding.vector,
            queryText,
            topK,
            agentId,
            targetFilePaths,
            exclude_chunk_types
        );

        const mappedResults = rawResults.map(meta => {
            let parsedMetadata: Record<string, any> | null = null;
            if (meta.metadata_json) {
                try {
                    parsedMetadata = JSON.parse(meta.metadata_json);
                } catch (e) {
                    console.warn(`Failed to parse metadata_json for embedding ID ${meta.embedding_id}:`, e);
                }
            }
            return {
                chunk_text: meta.chunk_text,
                ai_summary_text: meta.ai_summary_text,
                file_path_relative: meta.file_path_relative,
                entity_name: meta.entity_name,
                score: meta.similarity || 0,
                metadata: parsedMetadata
            };
        });

        return mappedResults;
    }
}
