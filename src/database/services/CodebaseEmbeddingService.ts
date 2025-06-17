import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { minimatch } from 'minimatch';
import { MemoryManager } from '../memory_manager.js';
import { GeminiIntegrationService } from './GeminiIntegrationService.js';
import { CodebaseIntrospectionService } from './CodebaseIntrospectionService.js';
import { Database } from 'better-sqlite3';
import { EmbeddingCache } from './embeddings/EmbeddingCache.js';
import { AIEmbeddingProvider } from './embeddings/AIEmbeddingProvider.js';
import { CodeChunkingService } from './embeddings/CodeChunkingService.js';
import { CodebaseEmbeddingRepository } from '../repositories/CodebaseEmbeddingRepository.js';
import { ChunkingStrategy, CodebaseEmbeddingRecord } from '../../types/codebase_embeddings.js';
import { DEFAULT_EMBEDDING_MODEL, VECTOR_FLOAT_SIZE } from '../../constants/embedding_constants.js';


export class CodebaseEmbeddingService {
    public repository: CodebaseEmbeddingRepository;
    private aiProvider: AIEmbeddingProvider;

    private chunkingService: CodeChunkingService;
    public embeddingCache: EmbeddingCache; // Made public to allow access from embedding_tools.ts
    private introspectionService: CodebaseIntrospectionService;

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

    /**
     * Deletes embeddings associated with the specified file paths.
     * @param agentId The ID of the agent (not used currently but kept for interface consistency).
     * @param filePaths Array of relative file paths whose embeddings should be deleted.
     * @param projectRootPath The absolute path to the project root.
     * @returns An object with the count of deleted embeddings.
     */
    public async cleanUpEmbeddingsByFilePaths(agentId: string, filePaths: string[], projectRootPath: string, filterByAgentId?: boolean): Promise<{ deletedCount: number }> {
        let deletedCount = 0;
        const absoluteProjectRootPath = path.resolve(projectRootPath);

        const embeddingIdsToDelete: string[] = [];
        for (const filePath of filePaths) {
            // Normalize the input filePath to match the format stored in the database (relative, forward slashes)
            const absoluteFilePath = path.resolve(filePath); // Ensure it's an absolute path first
            const normalizedFilePath = path.relative(absoluteProjectRootPath, absoluteFilePath).replace(/\\/g, '/');
            console.log(`[CleanUpEmbeddings] Processing file: ${filePath}`);
            console.log(`[CleanUpEmbeddings] Normalized path: "${normalizedFilePath}"`);
            
            const embeddings = await this.repository.getEmbeddingsForFile(normalizedFilePath, filterByAgentId ? agentId : undefined);
            console.log(`[CleanUpEmbeddings] Found ${embeddings.length} embeddings from repository for "${normalizedFilePath}"`);
            if (embeddings.length > 0) {
                console.log(`[CleanUpEmbeddings] First embedding ID found: ${embeddings[0].embedding_id}`);
            }

            for (const embedding of embeddings) {
                if (embedding.embedding_id) {
                    embeddingIdsToDelete.push(embedding.embedding_id);
                }
            }
        }
        console.log(`[CleanUpEmbeddings] Total IDs to delete: ${embeddingIdsToDelete.length}`);
        if (embeddingIdsToDelete.length > 0) {
            await this.repository.bulkDeleteEmbeddings(embeddingIdsToDelete);
            deletedCount = embeddingIdsToDelete.length;
        }
        return { deletedCount };
    }

    private generateChunkHash(text: string): string {
        return crypto.createHash('sha256').update(text).digest('hex');
    }

    /**
     * Generates and stores embeddings for a single file.
     * @param agentId The ID of the agent.
     * @param filePath The absolute path to the file.
     * @param projectRootPath The absolute path to the project root.
     * @param strategy The chunking strategy to use.
     * @param includeSummaryPatterns Glob patterns for files to include in AI summaries.
     * @param excludeSummaryPatterns Glob patterns for files to exclude from AI summaries.
     * @param storeEntitySummaries Whether to store AI-generated summaries for code entities.
     * @returns A report of the embedding generation process.
     */
    public async generateAndStoreEmbeddingsForFile(
        agentId: string,
        filePath: string,
        projectRootPath: string,
        strategy: ChunkingStrategy = 'auto',
        includeSummaryPatterns?: string[],
        excludeSummaryPatterns?: string[],
        storeEntitySummaries: boolean = true
    ): Promise<{
        newEmbeddingsCount: number;
        reusedEmbeddingsCount: number;
        deletedEmbeddingsCount: number;
        newEmbeddings: Array<{ file_path_relative: string; chunk_text: string }>;
        reusedEmbeddings: Array<{ file_path_relative: string; chunk_text: string }>;
        deletedEmbeddings: Array<{ file_path_relative: string; chunk_text: string }>;
        aiSummary?: string;
        embeddingRequestCount: number;
        embeddingRetryCount: number;
        namingApiCallCount: number;
        summarizationApiCallCount: number;
        dbCallCount: number;
        dbCallLatencyMs: number;
        totalTimeMs: number;
    }> {
        const startTime = Date.now();
        console.log(`[CodebaseEmbeddingService] Starting embedding generation for file: ${filePath}`);

        let fileContent: string;
            try {
                fileContent = await fs.readFile(filePath, 'utf-8');
                if (!fileContent.trim()) {
                    console.log(`Skipping empty file: ${filePath}`);
                    return { newEmbeddingsCount: 0, reusedEmbeddingsCount: 0, deletedEmbeddingsCount: 0, newEmbeddings: [], reusedEmbeddings: [], deletedEmbeddings: [], embeddingRequestCount: 0, embeddingRetryCount: 0, namingApiCallCount: 0, summarizationApiCallCount: 0, dbCallCount: 0, dbCallLatencyMs: 0, totalTimeMs: Date.now() - startTime };
                }
            } catch (e) {
                console.error(`Skipping embedding for unreadable file ${filePath}:`, e);
                return { newEmbeddingsCount: 0, reusedEmbeddingsCount: 0, deletedEmbeddingsCount: 0, newEmbeddings: [], reusedEmbeddings: [], deletedEmbeddings: [], embeddingRequestCount: 0, embeddingRetryCount: 0, namingApiCallCount: 0, summarizationApiCallCount: 0, dbCallCount: 0, dbCallLatencyMs: 0, totalTimeMs: Date.now() - startTime };
            }

        const relativeFilePath = path.relative(projectRootPath, filePath).replace(/\\/g, '/');
        const language = await this.introspectionService.detectLanguage(agentId, filePath, path.basename(filePath));

        const existingEmbeddingsForFile = await this.repository.getEmbeddingsForFile(relativeFilePath);
        const { hashes: existingHashesInDb, latencyMs: getChunkHashesLatency, callCount: getChunkHashesCallCount } = await this.repository.getChunkHashesForFile(relativeFilePath);
        let totalDbCallLatencyMs = getChunkHashesLatency;
        let totalDbCallCount = getChunkHashesCallCount;

        const currentHashesInFile = new Set<string>();
        const { chunks: chunksData, namingApiCallCount, summarizationApiCallCount, summaryDbCallCount, summaryDbCallLatencyMs } = await this.chunkingService.chunkFileContent(agentId, filePath, fileContent, relativeFilePath, language, strategy, storeEntitySummaries);

        totalDbCallCount += summaryDbCallCount;
        totalDbCallLatencyMs += summaryDbCallLatencyMs;

        if (chunksData.length === 0) {
            if (existingEmbeddingsForFile.length > 0) {
                for (const existingEmbedding of existingEmbeddingsForFile) {
                    if (existingEmbedding.embedding_id) {
                        await this.repository.deleteEmbedding(existingEmbedding.embedding_id);
                    }
                }
            }
            return {
                newEmbeddingsCount: 0,
                reusedEmbeddingsCount: 0,
                deletedEmbeddingsCount: existingEmbeddingsForFile.length,
                newEmbeddings: [],
                reusedEmbeddings: [],
                deletedEmbeddings: existingEmbeddingsForFile.map(e => ({ file_path_relative: relativeFilePath, chunk_text: e.chunk_text })),
                embeddingRequestCount: 0,
                embeddingRetryCount: 0,
                namingApiCallCount,
                summarizationApiCallCount,
                dbCallCount: totalDbCallCount,
                dbCallLatencyMs: totalDbCallLatencyMs,
                totalTimeMs: Date.now() - startTime
            };
        }

        const chunksToEmbed = [];
        let reusedEmbeddingsCount = 0;
        const reusedEmbeddings: Array<{ file_path_relative: string; chunk_text: string }> = [];

        for (const chunk of chunksData) {
            const chunkHash = this.generateChunkHash(chunk.chunk_text);
            currentHashesInFile.add(chunkHash);

            if (existingHashesInDb.has(chunkHash) || (await this.embeddingCache.hasChunkInCache(chunkHash))) {
                reusedEmbeddingsCount++;
                reusedEmbeddings.push({ file_path_relative: relativeFilePath, chunk_text: chunk.chunk_text });
            } else {
                chunksToEmbed.push(chunk);
            }
        }


        const textsToEmbed = chunksToEmbed.map(c => c.chunk_text);
        const { embeddings: embeddingResultsWithNulls, requestCount, retryCount } = await this.aiProvider.getEmbeddingsForChunks(textsToEmbed);

        const validResults = embeddingResultsWithNulls
            .map((result: { vector: number[]; dimensions: number } | null, index: number) => ({ result, index }))
            .filter((item: { result: { vector: number[]; dimensions: number } | null; index: number }): item is { result: { vector: number[]; dimensions: number }; index: number } => item.result !== null);

        const newEmbeddingsToStore: CodebaseEmbeddingRecord[] = [];
        const newEmbeddings: Array<{ file_path_relative: string; chunk_text: string }> = [];

        for (const { result: embedding, index } of validResults) {
            const chunk = chunksToEmbed[index];
            const chunkHash = this.generateChunkHash(chunk.chunk_text);
            const embeddingId = crypto.randomUUID(); // Generate UUID for new embeddings

            const vectorBuffer = Buffer.alloc(embedding.vector.length * VECTOR_FLOAT_SIZE);
            for (let i = 0; i < embedding.vector.length; i++) {
                vectorBuffer.writeFloatLE(embedding.vector[i], i * VECTOR_FLOAT_SIZE);
            }

            newEmbeddingsToStore.push({
                embedding_id: embeddingId,
                agent_id: agentId,
                chunk_text: chunk.chunk_text,
                entity_name: chunk.entity_name || null,
                vector_blob: vectorBuffer,
                vector_dimensions: embedding.dimensions,
                model_name: DEFAULT_EMBEDDING_MODEL,
                chunk_hash: chunkHash,
                metadata_json: JSON.stringify({ ...chunk.metadata, type: chunk.metadata?.type, full_file_path: filePath, ai_summary_text: chunk.ai_summary_text || undefined }),
                created_timestamp_unix: Math.floor(Date.now() / 1000),
                file_path_relative: relativeFilePath,
                full_file_path: filePath,
                ai_summary_text: chunk.ai_summary_text || undefined
            });
            newEmbeddings.push({ file_path_relative: relativeFilePath, chunk_text: chunk.chunk_text });
        }

        if (newEmbeddingsToStore.length > 0) {
            await this.repository.bulkInsertEmbeddings(newEmbeddingsToStore);
        }

        const newEmbeddingsCount = newEmbeddingsToStore.length;
        const deletedEmbeddings: Array<{ file_path_relative: string; chunk_text: string }> = [];
        const embeddingIdsToDelete: string[] = [];

        for (const existingEmbedding of existingEmbeddingsForFile) {
            if (existingEmbedding.chunk_hash && !currentHashesInFile.has(existingEmbedding.chunk_hash)) {
                if (existingEmbedding.embedding_id) {
                    embeddingIdsToDelete.push(existingEmbedding.embedding_id);
                    deletedEmbeddings.push({ file_path_relative: relativeFilePath, chunk_text: existingEmbedding.chunk_text });
                }
            }
        }

        let deletedEmbeddingsCount = 0;
        if (embeddingIdsToDelete.length > 0) {
            await this.repository.bulkDeleteEmbeddings(embeddingIdsToDelete);
            deletedEmbeddingsCount = embeddingIdsToDelete.length;
        }

        return {
            newEmbeddingsCount,
            reusedEmbeddingsCount,
            deletedEmbeddingsCount,
            newEmbeddings,
            reusedEmbeddings,
            deletedEmbeddings,
            aiSummary: '',
            embeddingRequestCount: requestCount,
            embeddingRetryCount: retryCount,
            namingApiCallCount,
            summarizationApiCallCount,
            dbCallCount: totalDbCallCount,
            dbCallLatencyMs: totalDbCallLatencyMs,
            totalTimeMs: Date.now() - startTime
        };
    }

    /**
     * Generates and stores embeddings for all supported files in a directory.
     * @param agentId The ID of the agent.
     * @param directoryPath The absolute path to the directory.
     * @param projectRootPath The absolute path to the project root.
     * @param strategy The chunking strategy to use.
     * @param includeSummaryPatterns Glob patterns for files to include in AI summaries.
     * @param excludeSummaryPatterns Glob patterns for files to exclude from AI summaries.
     * @param storeEntitySummaries Whether to store AI-generated summaries for code entities.
     * @returns A report of the embedding generation process for the directory.
     */
    public async generateAndStoreEmbeddingsForDirectory(
        agentId: string,
        directoryPath: string,
        projectRootPath: string,
        strategy: ChunkingStrategy = 'auto',
        includeSummaryPatterns?: string[],
        excludeSummaryPatterns?: string[],
        storeEntitySummaries: boolean = true
    ): Promise<{
        newEmbeddingsCount: number;
        reusedEmbeddingsCount: number;
        deletedEmbeddingsCount: number;
        newEmbeddings: Array<{ file_path_relative: string; chunk_text: string }>;
        reusedEmbeddings: Array<{ file_path_relative: string; chunk_text: string }>;
        deletedEmbeddings: Array<{ file_path_relative: string; chunk_text: string }>;
        aiSummary?: string;
        totalEmbeddingRequests: number;
        totalEmbeddingRetries: number;
        totalNamingApiRequests: number;
        totalSummarizationApiRequests: number;
        totalDbCallCount: number;
        totalDbCallLatencyMs: number;
        totalTimeMs: number;
    }> {
        const startTime = Date.now();
        const absoluteProjectRootPath = path.resolve(projectRootPath);
        const absoluteDirectoryPath = path.resolve(directoryPath);

        // Get all existing file paths for the agent within the project root
        const allExistingEmbeddedFilePaths = await this.repository.getAllFilePathsForAgent(agentId);
        const existingEmbeddedFilePathsInDirectory = new Set<string>();
        for (const filePath of allExistingEmbeddedFilePaths) {
            if (filePath.startsWith(path.relative(absoluteProjectRootPath, absoluteDirectoryPath).replace(/\\/g, '/') + '/')) {
                existingEmbeddedFilePathsInDirectory.add(filePath);
            }
        }
        console.log(`[CodebaseEmbeddingService] Found ${existingEmbeddedFilePathsInDirectory.size} existing embedded files in directory: ${directoryPath}`);

        const scannedItems = await this.introspectionService.scanDirectoryRecursive(agentId, absoluteDirectoryPath, absoluteProjectRootPath);
        
        await this.embeddingCache.loadCacheState(); // Load cache once for the entire directory processing

        let totalNewEmbeddings = 0;
        let totalReusedEmbeddings = 0;
        let totalDeletedEmbeddings = 0;
        let totalEmbeddingRequests = 0;
        let totalEmbeddingRetries = 0;
        let totalNamingApiRequests = 0;
        let totalSummarizationApiRequests = 0;
        let totalDbCallCount = 0;
        let totalDbCallLatencyMs = 0;
        const newEmbeddings: Array<{ file_path_relative: string; chunk_text: string }> = [];
        const reusedEmbeddings: Array<{ file_path_relative: string; chunk_text: string }> = [];
        const deletedEmbeddings: Array<{ file_path_relative: string; chunk_text: string }> = [];
        const processedFilePaths = new Set<string>(); // Keep track of files processed in this ingestion

        const concurrencyLimit = 5; // Limit concurrent file processing
        const fileProcessingPromises: Promise<void>[] = [];
        let activePromises = 0;

        const processFile = async (item: any) => {
            if (item.type === 'file') {
                const language = item.language || await this.introspectionService.detectLanguage(agentId, item.path, path.basename(item.path));
                if ((language && ['typescript', 'javascript', 'python', 'markdown', 'json', 'jsonl', 'html', 'css', 'java', 'csharp', 'go', 'ruby', 'php'].includes(language)) || (!language && item.stats.size > 0 && item.stats.size < 1024 * 1024)) {
                    try {
                        const result = await this.generateAndStoreEmbeddingsForFile(
                            agentId,
                            item.path,
                            absoluteProjectRootPath,
                            strategy,
                            includeSummaryPatterns,
                            excludeSummaryPatterns,
                            storeEntitySummaries
                        );
                        totalNewEmbeddings += result.newEmbeddingsCount;
                        totalReusedEmbeddings += result.reusedEmbeddingsCount;
                        totalDeletedEmbeddings += result.deletedEmbeddingsCount;
                        totalEmbeddingRequests += result.embeddingRequestCount;
                        totalEmbeddingRetries += result.embeddingRetryCount;
                        totalNamingApiRequests += result.namingApiCallCount;
                        totalSummarizationApiRequests += result.summarizationApiCallCount;
                        totalDbCallCount += result.dbCallCount;
                        totalDbCallLatencyMs += result.dbCallLatencyMs;
                        newEmbeddings.push(...result.newEmbeddings);
                        reusedEmbeddings.push(...result.reusedEmbeddings);
                        deletedEmbeddings.push(...result.deletedEmbeddings);
                        processedFilePaths.add(path.relative(absoluteProjectRootPath, item.path).replace(/\\/g, '/'));
                    } catch (fileError) {
                        console.error(`Error processing file ${item.path} for embeddings:`, fileError);
                    }
                }
            }
        };

        for (const item of scannedItems) {
            const promise = processFile(item);
            fileProcessingPromises.push(promise);

            if (activePromises >= concurrencyLimit) {
                await Promise.race(fileProcessingPromises.filter(p => p !== null));
            }
            activePromises++;
            promise.finally(() => activePromises--);
        }

        await Promise.all(fileProcessingPromises); // Wait for all promises to settle
        await this.embeddingCache.flushToDb(); // Flush cache once after all files in the directory are processed

        // Identify and delete embeddings for files that no longer exist in the directory
        const deletedFilePaths: string[] = [];
        for (const existingFilePath of existingEmbeddedFilePathsInDirectory) {
            if (!processedFilePaths.has(existingFilePath)) {
                deletedFilePaths.push(existingFilePath);
            }
        }

        if (deletedFilePaths.length > 0) {
            console.log(`[CodebaseEmbeddingService] Deleting embeddings for ${deletedFilePaths.length} stale files.`);
            const cleanupResult = await this.cleanUpEmbeddingsByFilePaths(agentId, deletedFilePaths, absoluteProjectRootPath, true);
            totalDeletedEmbeddings += cleanupResult.deletedCount;
        }

        const endTime = Date.now();
        const totalTimeMs = endTime - startTime;

        return {
            newEmbeddingsCount: totalNewEmbeddings,
            reusedEmbeddingsCount: totalReusedEmbeddings,
            deletedEmbeddingsCount: totalDeletedEmbeddings,
            newEmbeddings,
            reusedEmbeddings,
            deletedEmbeddings,
            aiSummary: '',
            totalEmbeddingRequests,
            totalEmbeddingRetries,
            totalNamingApiRequests,
            totalSummarizationApiRequests,
            totalDbCallCount,
            totalDbCallLatencyMs,
            totalTimeMs
        };
    }

    /**
     * Retrieves code chunks semantically similar to a given query text.
     * @param agentId The ID of the agent.
     * @param queryText The text to find similar code for.
     * @param topK The number of similar chunks to retrieve.
     * @param targetFilePaths Optional array of file paths to restrict the search to.
     * @returns An array of similar code chunks with their metadata and similarity scores.
     */
    public async retrieveSimilarCodeChunks(
        agentId: string,
        queryText: string,
        topK: number = 5,
        targetFilePaths?: string[]
    ): Promise<Array<{ chunk_text: string; ai_summary_text?: string | null; file_path_relative: string; entity_name: string | null; score: number; metadata?: Record<string, any> | null }>> {
        const { embeddings } = await this.aiProvider.getEmbeddingsForChunks([queryText]);
        const queryEmbedding = embeddings[0];
        if (!queryEmbedding || !queryEmbedding.vector) {
            throw new Error("Failed to generate embedding for query text.");
        }

        const vecResults = await this.repository.findSimilarEmbeddings(queryEmbedding.vector, topK * 2);
        const ids = vecResults.map(r => r.embedding_id);
        const metadataRows = await this.repository.fetchMetadataByIds(ids);

        const fullFileChunks: Array<any> = [];
        const summaryChunks: Array<any> = [];

        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            const meta = metadataRows.find(row => row.embedding_id === id);
            if (!meta) continue;

            let parsedMetadata: Record<string, any> | null = null;
            if (meta.metadata_json) {
                try {
                    parsedMetadata = JSON.parse(meta.metadata_json);
                } catch (e) {
                    console.warn(`Failed to parse metadata_json for embedding ID ${id}:`, e);
                }
            }

            const chunk = {
                chunk_text: meta.chunk_text || '',
                ai_summary_text: meta.ai_summary_text || null,
                file_path_relative: meta.file_path_relative || '',
                entity_name: meta.entity_name || null,
                score: vecResults[i]?.similarity ?? 0,
                metadata: parsedMetadata
            };
            if (parsedMetadata && parsedMetadata.type === 'full_file') {
                fullFileChunks.push(chunk);
            } else {
                summaryChunks.push(chunk);
            }
        }

        const combinedChunks: Array<any> = [];
        const maxLength = Math.max(fullFileChunks.length, summaryChunks.length);
        for (let i = 0; i < maxLength; i++) {
            if (i < fullFileChunks.length) combinedChunks.push(fullFileChunks[i]);
            if (i < summaryChunks.length) combinedChunks.push(summaryChunks[i]);
            if (combinedChunks.length >= topK) break;
        }

        return combinedChunks.slice(0, topK);
    }
}
