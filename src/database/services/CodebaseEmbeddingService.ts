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
        // This method now wraps the more efficient multi-file method for a single file.
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

    // This is the new core "bulk" processing function
    private async _processBatchOfFiles(
        agentId: string,
        filesToProcess: Array<{ absolutePath: string, relativePath: string }>,
        projectRootPath: string,
        strategy: ChunkingStrategy,
        storeEntitySummaries: boolean,
        existingFileHashes: Map<string, string>
    ): Promise<Omit<EmbeddingIngestionResult, 'totalTimeMs' | 'deletedEmbeddingsCount'>> {

        const chunksToEmbed: Array<{ chunk: any, fileInfo: any }> = [];
        const embeddingIdsToDelete = new Set<string>();
        const report = {
            newEmbeddingsCount: 0,
            reusedEmbeddingsCount: 0,
            newEmbeddings: [] as Array<{ file_path_relative: string; chunk_text: string }>,
            reusedEmbeddings: [] as Array<{ file_path_relative: string; chunk_text: string }>,
            deletedEmbeddings: [] as Array<{ file_path_relative: string; chunk_text: string }>,
            embeddingRequestCount: 0,
            embeddingRetryCount: 0,
            totalTokensProcessed: 0,
            namingApiCallCount: 0,
            summarizationApiCallCount: 0,
            dbCallCount: 0,
            dbCallLatencyMs: 0
        };

        // --- Step 1: Concurrently process files to determine which chunks are new, reused, or stale ---
        await Promise.all(filesToProcess.map(async (fileInfo) => {
            try {
                const fileContent = await fs.readFile(fileInfo.absolutePath, 'utf-8');
                if (!fileContent.trim()) return;

                const currentFileHash = this.generateFileHash(fileContent);
                if (existingFileHashes.get(fileInfo.relativePath) === currentFileHash) {
                    console.log(`[Idempotency Skip] File has not changed: ${fileInfo.relativePath}`);
                    return;
                }

                const language = await this.introspectionService.detectLanguage(agentId, fileInfo.absolutePath, path.basename(fileInfo.absolutePath));
                const existingEmbeddingsForFile = await this.repository.getEmbeddingsForFile(fileInfo.relativePath);
                const { hashes: existingHashesInDb } = await this.repository.getChunkHashesForFile(fileInfo.relativePath);

                const { chunks: chunksData, namingApiCallCount, summarizationApiCallCount } = await this.chunkingService.chunkFileContent(agentId, fileInfo.absolutePath, fileContent, fileInfo.relativePath, language, strategy, storeEntitySummaries);
                report.namingApiCallCount += namingApiCallCount;
                report.summarizationApiCallCount += summarizationApiCallCount;

                const currentChunkHashes = new Set<string>();

                for (const chunk of chunksData) {
                    const chunkHash = this.generateChunkHash(chunk.chunk_text);
                    currentChunkHashes.add(chunkHash);

                    if (existingHashesInDb.has(chunkHash)) {
                        report.reusedEmbeddingsCount++;
                        report.reusedEmbeddings.push({ file_path_relative: fileInfo.relativePath, chunk_text: chunk.chunk_text });
                    } else {
                        chunksToEmbed.push({ chunk, fileInfo: { ...fileInfo, fileHash: currentFileHash } });
                    }
                }

                existingEmbeddingsForFile.forEach(existing => {
                    if (existing.chunk_hash && !currentChunkHashes.has(existing.chunk_hash)) {
                        embeddingIdsToDelete.add(existing.embedding_id);
                        report.deletedEmbeddings.push({ file_path_relative: fileInfo.relativePath, chunk_text: existing.chunk_text });
                    }
                });

            } catch (err) {
                console.error(`Error processing file ${fileInfo.absolutePath}:`, err);
            }
        }));

        // --- Step 2: Batch generate embeddings for all new chunks from all files ---
        if (chunksToEmbed.length > 0) {
            const textsToEmbed = chunksToEmbed.map(item => item.chunk.chunk_text);
            const { embeddings, requestCount, retryCount, totalTokensProcessed } = await this.aiProvider.getEmbeddingsForChunks(textsToEmbed);
            report.embeddingRequestCount = requestCount;
            report.embeddingRetryCount = retryCount;
            report.totalTokensProcessed = totalTokensProcessed;

            const newEmbeddingsToStore: CodebaseEmbeddingRecord[] = [];
            embeddings.forEach((embeddingResult, index) => {
                if (embeddingResult) {
                    const { chunk, fileInfo } = chunksToEmbed[index];
                    const chunkHash = this.generateChunkHash(chunk.chunk_text);
                    const vectorBuffer = Buffer.alloc(embeddingResult.vector.length * VECTOR_FLOAT_SIZE);
                    embeddingResult.vector.forEach((val, i) => vectorBuffer.writeFloatLE(val, i * VECTOR_FLOAT_SIZE));

                    newEmbeddingsToStore.push({
                        embedding_id: crypto.randomUUID(),
                        agent_id: agentId,
                        chunk_text: chunk.chunk_text,
                        entity_name: chunk.entity_name || null,
                        vector_blob: vectorBuffer,
                        vector_dimensions: embeddingResult.dimensions,
                        model_name: DEFAULT_EMBEDDING_MODEL,
                        chunk_hash: chunkHash,
                        file_hash: fileInfo.fileHash,
                        metadata_json: JSON.stringify({ ...chunk.metadata, type: chunk.metadata?.type, ai_summary_text: chunk.ai_summary_text || undefined }),
                        created_timestamp_unix: Math.floor(Date.now() / 1000),
                        file_path_relative: fileInfo.relativePath,
                        full_file_path: fileInfo.absolutePath,
                        ai_summary_text: chunk.ai_summary_text || undefined
                    });
                    report.newEmbeddings.push({ file_path_relative: fileInfo.relativePath, chunk_text: chunk.chunk_text });
                }
            });
            report.newEmbeddingsCount = newEmbeddingsToStore.length;

            // --- Step 3: Perform bulk database operations ---
            if (newEmbeddingsToStore.length > 0) {
                await this.repository.bulkInsertEmbeddings(newEmbeddingsToStore);
            }
        }

        if (embeddingIdsToDelete.size > 0) {
            await this.repository.bulkDeleteEmbeddings(Array.from(embeddingIdsToDelete));
        }

        // Note: deletedEmbeddingsCount will be set by the caller
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
            aiSummary: '', // Summary logic can be added if needed
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

        // Identify and delete embeddings for files that no longer exist
        const processedFilePaths = new Set(filesToProcess.map(f => f.relativePath));
        const deletedFilePaths: string[] = [];
        allDbFilePaths.forEach(dbPath => {
            // Check if the file from DB is within the directory being processed
            const isUnderDirectory = path.resolve(absoluteProjectRootPath, dbPath).startsWith(absoluteDirectoryPath);
            if (isUnderDirectory && !processedFilePaths.has(dbPath)) {
                deletedFilePaths.push(dbPath);
            }
        });

        let deletedEmbeddingsCount = result.deletedEmbeddings.length;
        if (deletedFilePaths.length > 0) {
            console.log(`[CodebaseEmbeddingService] Deleting embeddings for ${deletedFilePaths.length} stale files.`);
            const cleanupResult = await this.cleanUpEmbeddingsByFilePaths(agentId, deletedFilePaths, absoluteProjectRootPath, true);
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

        const initialTopK = topK * 5;

        const rawResults = await this.repository.findSimilarEmbeddingsWithMetadata(
            queryEmbedding.vector,
            queryText,
            initialTopK,
            agentId,
            targetFilePaths,
            exclude_chunk_types
        );

        const mappedResults = rawResults.map(meta => {
            if (!meta) return null;

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
                score: meta.similarity,
                metadata: parsedMetadata
            };
        }).filter((item): item is NonNullable<typeof item> => item !== null);

        return mappedResults.slice(0, topK);
    }
}