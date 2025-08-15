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
import { ChunkingStrategy, CodebaseEmbeddingRecord, EmbeddingIngestionResult } from '../../types/codebase_embeddings.js';
import { DEFAULT_EMBEDDING_MODEL, VECTOR_FLOAT_SIZE } from '../../constants/embedding_constants.js';

export class CodebaseEmbeddingService {
    public repository: CodebaseEmbeddingRepository;
    private aiProvider: AIEmbeddingProvider;
    public chunkingService: CodeChunkingService;
    public embeddingCache: EmbeddingCache; // Made public to allow access from embedding_tools.ts
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
        const absoluteProjectRootPath = path.resolve(projectRootPath);
        const embeddingIdsToDelete: string[] = [];
        for (const normalizedFilePath of filePaths) {
            console.log(`[CleanUpEmbeddings] Processing file: ${normalizedFilePath}`);
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

    public async generateAndStoreEmbeddingsForFile(
        agentId: string,
        filePath: string,
        projectRootPath: string,
        strategy: ChunkingStrategy = 'auto',
        includeSummaryPatterns?: string[],
        excludeSummaryPatterns?: string[],
        storeEntitySummaries: boolean = true
    ): Promise<EmbeddingIngestionResult> {
        const startTime = Date.now();
        console.log(`[CodebaseEmbeddingService] Starting embedding generation for file: ${filePath}`);
        let fileContent: string;
        try {
            fileContent = await fs.readFile(filePath, 'utf-8');
            if (!fileContent.trim()) {
                console.log(`Skipping empty file: ${filePath}`);
                return { newEmbeddingsCount: 0, reusedEmbeddingsCount: 0, deletedEmbeddingsCount: 0, newEmbeddings: [], reusedEmbeddings: [], deletedEmbeddings: [], embeddingRequestCount: 0, embeddingRetryCount: 0, namingApiCallCount: 0, summarizationApiCallCount: 0, dbCallCount: 0, dbCallLatencyMs: 0, totalTimeMs: Date.now() - startTime, totalTokensProcessed: 0 };
            }
        } catch (e) {
            console.error(`Skipping embedding for unreadable file ${filePath}:`, e);
            return { newEmbeddingsCount: 0, reusedEmbeddingsCount: 0, deletedEmbeddingsCount: 0, newEmbeddings: [], reusedEmbeddings: [], deletedEmbeddings: [], embeddingRequestCount: 0, embeddingRetryCount: 0, namingApiCallCount: 0, summarizationApiCallCount: 0, dbCallCount: 0, dbCallLatencyMs: 0, totalTimeMs: Date.now() - startTime, totalTokensProcessed: 0 };
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
                totalTimeMs: Date.now() - startTime,
                totalTokensProcessed: 0
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
        const { embeddings: embeddingResultsWithNulls, requestCount, retryCount, totalTokensProcessed } = await this.aiProvider.getEmbeddingsForChunks(textsToEmbed);
        const validResults = embeddingResultsWithNulls
            .map((result: { vector: number[]; dimensions: number } | null, index: number) => ({ result, index }))
            .filter((item: { result: { vector: number[]; dimensions: number } | null; index: number }): item is { result: { vector: number[]; dimensions: number }; index: number } => item.result !== null);
        const newEmbeddingsToStore: CodebaseEmbeddingRecord[] = [];
        const newEmbeddings: Array<{ file_path_relative: string; chunk_text: string }> = [];
        for (const { result: embedding, index } of validResults) {
            const chunk = chunksToEmbed[index];
            const chunkHash = this.generateChunkHash(chunk.chunk_text);
            const embeddingId = crypto.randomUUID();
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
            totalTimeMs: Date.now() - startTime,
            totalTokensProcessed
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
        const allExistingEmbeddedFilePaths = await this.repository.getAllFilePathsForAgent(agentId);
        const relativeDirPath = path.relative(absoluteProjectRootPath, absoluteDirectoryPath).replace(/\\/g, '/');
        const prefix = relativeDirPath === '.' || relativeDirPath === '' ? '' : relativeDirPath + '/';
        const existingEmbeddedFilePathsInDirectory = new Set<string>();
        for (const filePath of allExistingEmbeddedFilePaths) {
            if (filePath.startsWith(prefix)) {
                existingEmbeddedFilePathsInDirectory.add(filePath);
            }
        }
        console.log(`[CodebaseEmbeddingService] Found ${existingEmbeddedFilePathsInDirectory.size} existing embedded files in directory: ${directoryPath} (prefix: ${prefix})`);
        const scannedItems = await this.introspectionService.scanDirectoryRecursive(agentId, absoluteDirectoryPath, absoluteProjectRootPath);

        await this.embeddingCache.loadCacheState();
        let totalNewEmbeddings = 0;
        let totalReusedEmbeddings = 0;
        let totalDeletedEmbeddings = 0;
        let totalTokensProcessed = 0;
        let embeddingRequestCount = 0;
        let embeddingRetryCount = 0;
        let namingApiCallCount = 0;
        let summarizationApiCallCount = 0;
        let dbCallCount = 0;
        let dbCallLatencyMs = 0;
        const newEmbeddings: Array<{ file_path_relative: string; chunk_text: string }> = [];
        const reusedEmbeddings: Array<{ file_path_relative: string; chunk_text: string }> = [];
        const deletedEmbeddings: Array<{ file_path_relative: string; chunk_text: string }> = [];
        const processedFilePaths = new Set<string>();
        const concurrencyLimit = 5;
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
                        totalTokensProcessed += result.totalTokensProcessed || 0;
                        embeddingRequestCount += result.embeddingRequestCount;
                        embeddingRetryCount += result.embeddingRetryCount;
                        namingApiCallCount += result.namingApiCallCount;
                        summarizationApiCallCount += result.summarizationApiCallCount;
                        dbCallCount += result.dbCallCount;
                        dbCallLatencyMs += result.dbCallLatencyMs;
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
            activePromises++;
            if (activePromises > concurrencyLimit) {
                await Promise.race(fileProcessingPromises);
            }
            promise.finally(() => activePromises--);
        }
        await Promise.all(fileProcessingPromises);
        await this.embeddingCache.flushToDb();

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
            embeddingRequestCount,
            embeddingRetryCount,
            namingApiCallCount,
            summarizationApiCallCount,
            dbCallCount,
            dbCallLatencyMs,
            totalTimeMs,
            totalTokensProcessed
        };
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
        await this.embeddingCache.loadCacheState();
        let totalNewEmbeddings = 0;
        let totalReusedEmbeddings = 0;
        let totalDeletedEmbeddings = 0;
        let totalTokensProcessed = 0;
        let embeddingRequestCount = 0;
        let embeddingRetryCount = 0;
        let namingApiCallCount = 0;
        let summarizationApiCallCount = 0;
        let dbCallCount = 0;
        let dbCallLatencyMs = 0;
        const newEmbeddings: Array<{ file_path_relative: string; chunk_text: string }> = [];
        const reusedEmbeddings: Array<{ file_path_relative: string; chunk_text: string }> = [];
        const deletedEmbeddings: Array<{ file_path_relative: string; chunk_text: string }> = [];
        const concurrencyLimit = 5;
        const fileProcessingPromises: Promise<void>[] = [];
        let activePromises = 0;
        const processFile = async (filePath: string) => {
            try {
                const result = await this.generateAndStoreEmbeddingsForFile(
                    agentId,
                    filePath,
                    absoluteProjectRootPath,
                    strategy,
                    includeSummaryPatterns,
                    excludeSummaryPatterns,
                    storeEntitySummaries
                );
                totalNewEmbeddings += result.newEmbeddingsCount;
                totalReusedEmbeddings += result.reusedEmbeddingsCount;
                totalDeletedEmbeddings += result.deletedEmbeddingsCount;
                totalTokensProcessed += result.totalTokensProcessed || 0;
                embeddingRequestCount += result.embeddingRequestCount;
                embeddingRetryCount += result.embeddingRetryCount;
                namingApiCallCount += result.namingApiCallCount;
                summarizationApiCallCount += result.summarizationApiCallCount;
                dbCallCount += result.dbCallCount;
                dbCallLatencyMs += result.dbCallLatencyMs;
                newEmbeddings.push(...result.newEmbeddings);
                reusedEmbeddings.push(...result.reusedEmbeddings);
                deletedEmbeddings.push(...result.deletedEmbeddings);
            } catch (fileError) {
                console.error(`Error processing file ${filePath} for embeddings:`, fileError);
            }
        };
        for (const filePath of filePaths) {
            const absoluteFilePath = path.resolve(absoluteProjectRootPath, filePath);
            const promise = processFile(absoluteFilePath);
            fileProcessingPromises.push(promise);
            activePromises++;
            if (activePromises > concurrencyLimit) {
                await Promise.race(fileProcessingPromises);
            }
            promise.finally(() => activePromises--);
        }
        await Promise.all(fileProcessingPromises);
        await this.embeddingCache.flushToDb();
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
            embeddingRequestCount,
            embeddingRetryCount,
            namingApiCallCount,
            summarizationApiCallCount,
            dbCallCount,
            dbCallLatencyMs,
            totalTimeMs,
            totalTokensProcessed
        };
    }

    private async _generateQueryVariations(queryText: string): Promise<string[]> {
        const prompt = `Given the user's query about a codebase, generate 2 additional, diverse queries that rephrase the intent or focus on different technical aspects. The queries should be distinct but semantically related. Return a JSON array of strings containing only the new queries.

User Query: "${queryText}"

Example:
User Query: "how does the authentication middleware work"
Response:
["validate user token pipeline", "handle unauthorized access in express routes"]`;
        try {
            const result = await this.aiProvider.geminiService.askGemini(prompt, "gemini-2.5-flash");
            const textResponse = result.content[0].text ?? '';
            const jsonMatch = textResponse.match(/\[.*?\]/s);
            if (jsonMatch) {
                const queries = JSON.parse(jsonMatch[0]);
                return Array.from(new Set([queryText, ...queries]));
            }
        } catch (error) {
            console.warn("Failed to generate query variations, using original query only.", error);
        }
        return [queryText];
    }

    private _reciprocalRankFusion(
        rankedLists: Array<Array<CodebaseEmbeddingRecord & { similarity: number }>>,
        k: number = 60
    ): Array<CodebaseEmbeddingRecord & { similarity: number }> {
        const scores: Map<string, number> = new Map();
        const items: Map<string, CodebaseEmbeddingRecord & { similarity: number }> = new Map();

        for (const list of rankedLists) {
            for (let i = 0; i < list.length; i++) {
                const item = list[i];
                const key = item.embedding_id;
                const rank = i + 1;
                const rrfScore = 1 / (k + rank);

                scores.set(key, (scores.get(key) || 0) + rrfScore);
                if (!items.has(key) || item.similarity > items.get(key)!.similarity) {
                    items.set(key, item);
                }
            }
        }

        const fusedResults = Array.from(scores.entries())
            .map(([key, score]) => {
                const item = items.get(key)!;
                return { ...item, rrfScore: score };
            })
            .sort((a, b) => b.rrfScore - a.rrfScore)
            .map(({ rrfScore, ...rest }) => rest as CodebaseEmbeddingRecord & { similarity: number });

        return fusedResults;
    }

    public async retrieveSimilarCodeChunks(
        agentId: string,
        queryText: string,
        topK: number = 5,
        targetFilePaths?: string[],
        exclude_chunk_types?: string[]
    ): Promise<Array<{ chunk_text: string; ai_summary_text?: string | null; file_path_relative: string; entity_name: string | null; score: number; metadata?: Record<string, any> | null }>> {
        const queryVariations = await this._generateQueryVariations(queryText);
        console.log(`[CodebaseEmbeddingService] Using query variations:`, queryVariations);

        const searchPromises = queryVariations.map(async (query) => {
            const { embeddings } = await this.aiProvider.getEmbeddingsForChunks([query]);
            const queryEmbedding = embeddings[0];
            if (!queryEmbedding || !queryEmbedding.vector) {
                return [];
            }
            return this.repository.findSimilarEmbeddingsWithMetadata(
                queryEmbedding.vector,
                topK * 5,
                agentId,
                targetFilePaths
            );
        });

        const searchResultsLists = await Promise.all(searchPromises);
        if (searchResultsLists.every(list => list.length === 0)) {
            return [];
        }

        const fusedResults = this._reciprocalRankFusion(searchResultsLists);

        const finalResults: Array<{ chunk_text: string; ai_summary_text?: string | null; file_path_relative: string; entity_name: string | null; score: number; metadata?: Record<string, any> | null }> = [];
        for (const meta of fusedResults) {
            if (!meta) continue;
            let parsedMetadata: Record<string, any> | null = null;
            if (meta.metadata_json) {
                try {
                    parsedMetadata = JSON.parse(meta.metadata_json);
                } catch (e) {
                    console.warn(`Failed to parse metadata_json for embedding ID ${meta.embedding_id}:`, e);
                }
            }
            const chunk = {
                chunk_text: meta.chunk_text,
                ai_summary_text: meta.ai_summary_text,
                file_path_relative: meta.file_path_relative,
                entity_name: meta.entity_name,
                score: meta.similarity,
                metadata: parsedMetadata
            };

            if (exclude_chunk_types && Array.isArray(exclude_chunk_types) && exclude_chunk_types.length > 0) {
                const chunkType = chunk.metadata?.type;
                if (chunkType && exclude_chunk_types.includes(chunkType)) {
                    continue;
                }
            }
            finalResults.push(chunk);
        }

        return finalResults.slice(0, topK);
    }
}