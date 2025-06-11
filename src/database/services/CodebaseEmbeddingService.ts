// src/services/CodebaseEmbeddingService.ts
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { minimatch } from 'minimatch'; // Import minimatch for glob pattern matching
import { MemoryManager } from '../memory_manager.js';
import { GeminiIntegrationService } from './GeminiIntegrationService.js';
import { CodebaseIntrospectionService, ExtractedCodeEntity, ScannedItem, ExtractedImport } from './CodebaseIntrospectionService.js';
import { Database } from 'better-sqlite3';
import {
    storeVecEmbedding,
    findSimilarVecEmbeddings
} from '../vector_db.js';

// Helper to insert metadata into any table
async function insertEmbeddingMetadata(
    db: Database,
    table: string,
    metadata: Record<string, any>
) {
    const columns = Object.keys(metadata);
    const placeholders = columns.map(() => '?').join(',');
    const sql = `INSERT OR REPLACE INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`;
    db.prepare(sql).run(...columns.map(k => metadata[k]));
}

// Helper to fetch metadata for a set of embedding_ids
async function fetchMetadataByIds(
    db: Database,
    table: string,
    embeddingIds: string[]
) {
    if (embeddingIds.length === 0) return [];
    const placeholders = embeddingIds.map(() => '?').join(',');
    const sql = `SELECT * FROM ${table} WHERE embedding_id IN (${placeholders})`;
    return db.prepare(sql).all(...embeddingIds);
}

// Helper to fetch all embeddings for a given file path
async function getEmbeddingsForFile(
    db: Database,
    filePathRelative: string,
    metadataTable: string
): Promise<CodebaseEmbeddingRecord[]> {
    const sql = `SELECT * FROM ${metadataTable} WHERE file_path_relative = ?`;
    return db.prepare(sql).all(filePathRelative) as CodebaseEmbeddingRecord[];
}

// Helper to delete an embedding by its ID from both vector and metadata tables
async function deleteEmbedding(
    db: Database,
    embeddingId: string,
    vectorTable: string,
    metadataTable: string
): Promise<void> {
    db.prepare(`DELETE FROM ${vectorTable} WHERE embedding_id = ?`).run(embeddingId);
    db.prepare(`DELETE FROM ${metadataTable} WHERE embedding_id = ?`).run(embeddingId);
}

// Define the structure for storing embeddings if not already defined elsewhere
interface CodebaseEmbeddingRecord {
    embedding_id: string;
    agent_id: string;
    file_path_relative: string;
    entity_name?: string | null;
    chunk_text: string; // Now always stores the original code snippet
    ai_summary_text?: string | null; // New: Stores the AI-generated summary
    vector_blob: Buffer; // Storing as Buffer for BLOB
    vector_dimensions: number;
    model_name: string;
    chunk_hash?: string;
    created_timestamp_unix: number;
    metadata_json?: string;
}

export type ChunkingStrategy = 'file' | 'function' | 'class' | 'auto';

const DEFAULT_EMBEDDING_MODEL = "models/text-embedding-004";
const VECTOR_FLOAT_SIZE = 4; // Bytes per float32

interface CachedChunk {
    embedding_id: string; // This will be the chunk_hash
    agent_id: string;
    chunk_text: string;
    entity_name?: string | null;
    vector: number[];
    vector_dimensions: number;
    model_name: string;
    chunk_hash: string;
    metadata?: any;
    created_timestamp_unix: number;
    file_path_relative: string;
    full_file_path: string;
}

class EmbeddingCache {
    private vectorDb: Database;
    private vectorTable: string = 'codebase_embeddings_vec_idx';
    private metadataTable: string = 'codebase_embeddings';
    private cacheFilePath: string = 'embedding_cache.json';

    constructor(vectorDb: Database) {
        this.vectorDb = vectorDb;
        // Ensure the cache file exists on initialization
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

    // Add a chunk and its embedding to the cache file
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
            // Check if embedding already exists in DB
            const existingInDb = this.vectorDb.prepare(`SELECT 1 FROM ${this.metadataTable} WHERE chunk_hash = ?`).get(chunk_hash);
            if (existingInDb) {
                // Already stored in DB, skip adding to cache file
                return;
            }

            // Read existing cache, add new chunk, and write back
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

            // Check if the chunk already exists in the cache file to prevent duplicates
            const existingInCache = currentCache.some(c => c.chunk_hash === chunk_hash);
            if (!existingInCache) {
                currentCache.push(newChunk);
                await fs.writeFile(this.cacheFilePath, JSON.stringify(currentCache, null, 2), 'utf-8');
            }
        } catch (error) {
            console.error(`Failed to add chunk ${chunk_hash} to cache file:`, error);
        }
    }

    // Flush cache from JSON file to DB in batch
    public async flushToDb(): Promise<number> {
        const chunksToFlush: CachedChunk[] = await this.loadCacheState();
        if (chunksToFlush.length === 0) {
            return 0;
        }

        let flushedCount = 0;
        const remainingChunks: CachedChunk[] = []; // Chunks that failed to flush or were already in DB

        for (const data of chunksToFlush) {
            try {
                // Check if embedding already exists in DB before flushing
                const existing = this.vectorDb.prepare(`SELECT 1 FROM ${this.metadataTable} WHERE chunk_hash = ?`).get(data.chunk_hash);
                if (existing) {
                    // Already stored, skip and don't add to remainingChunks
                    continue;
                }

                await storeVecEmbedding(data.chunk_hash, data.vector, this.vectorTable);
                await insertEmbeddingMetadata(this.vectorDb, this.metadataTable, {
                    embedding_id: data.chunk_hash,
                    agent_id: data.agent_id,
                    file_path_relative: data.file_path_relative,
                    entity_name: data.entity_name,
                    chunk_text: data.chunk_text,
                    ai_summary_text: data.metadata?.ai_summary_text || null,
                    model_name: data.model_name,
                    chunk_hash: data.chunk_hash,
                    created_timestamp_unix: data.created_timestamp_unix,
                    metadata_json: data.metadata ? JSON.stringify(data.metadata) : null
                });
                flushedCount++;
            } catch (error) {
                console.error(`Failed to flush chunk ${data.chunk_hash} to DB:`, error);
                remainingChunks.push(data); // Keep failed chunks in cache
            }
        }

        // Overwrite cache file with remaining (unflushed) chunks
        await fs.writeFile(this.cacheFilePath, JSON.stringify(remainingChunks, null, 2), 'utf-8');
        return flushedCount;
    }

    // Load cache state from JSON file
    public async loadCacheState(): Promise<CachedChunk[]> {
        try {
            const data = await fs.readFile(this.cacheFilePath, 'utf-8');
            return JSON.parse(data) as CachedChunk[];
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                // File not found, return empty array (will be created on first add)
                return [];
            } else {
                console.error('Failed to load embedding cache state:', error);
                return []; // Ensure empty array on error
            }
        }
    }

    // Clear cache and delete cache file
    public async clearCache(): Promise<void> {
        try {
            await fs.unlink(this.cacheFilePath);
            await this.initializeCacheFile(); // Re-initialize to create an empty file
        } catch (error: any) {
            if (error.code !== 'ENOENT') { // Ignore file not found error
                console.error('Failed to delete embedding cache file:', error);
            }
        }
    }

    // Check if a chunk exists in the cache file (not in DB)
    public async hasChunkInCache(chunkHash: string): Promise<boolean> {
        const currentCache: CachedChunk[] = await this.loadCacheState();
        return currentCache.some(c => c.chunk_hash === chunkHash);
    }
}

export class CodebaseEmbeddingService {
    private memoryManager: MemoryManager;
    private geminiService: GeminiIntegrationService;
    private introspectionService: CodebaseIntrospectionService;
    private vectorDb: Database; // Connection to the separate vector_store.db

    // New cache instance for live chunk caching
    private embeddingCache: EmbeddingCache;
    private lastAiCallTimestamp: number = 0; // Timestamp of the last AI call for rate limiting

    constructor(memoryManager: MemoryManager, vectorDbConnection: Database) {
        this.memoryManager = memoryManager;
        try {
            this.geminiService = memoryManager.getGeminiIntegrationService();
        } catch (error) {
            console.warn("CodebaseEmbeddingService: GeminiIntegrationService not available, embedding features will be disabled.");
            this.geminiService = null as any;
        }
        // Pass memoryManager to CodebaseIntrospectionService as it might need projectRootPath or other MM facilities
        this.introspectionService = new CodebaseIntrospectionService(memoryManager);
        this.vectorDb = vectorDbConnection;

        // Initialize the embedding cache
        this.embeddingCache = new EmbeddingCache(this.vectorDb);
    }

    /**
     * Waits to ensure the rate limit for AI calls (10/minute) is not exceeded.
     * This translates to a minimum of 6 seconds between calls.
     */
    private async waitForRateLimit(): Promise<void> {
        const now = Date.now();
        const timeSinceLastCall = now - this.lastAiCallTimestamp;
        const minimumDelay = 6000; // 6 seconds for 10 calls/minute

        if (timeSinceLastCall < minimumDelay) {
            const timeToWait = minimumDelay - timeSinceLastCall;
            console.log(`[CodebaseEmbeddingService] Waiting ${timeToWait}ms to respect AI call rate limit.`);
            await new Promise(resolve => setTimeout(resolve, timeToWait));
        }
        this.lastAiCallTimestamp = Date.now(); // Update timestamp after waiting (or immediately if no wait)
    }

    /**
     * Generates a meaningful entity name for an anonymous code chunk using AI.
     * @param codeChunk The code snippet to name.
     * @param language The programming language of the code.
     * @returns A concise, meaningful name for the code chunk.
     */
    private async generateMeaningfulEntityName(codeChunk: string, language: string | undefined): Promise<string> {
        if (!this.geminiService) {
            return 'anonymous_chunk';
        }
        await this.waitForRateLimit(); // Wait before making the AI call
        try {
            const prompt = `You are an expert software engineer. Analyze the following code snippet and provide a very concise (2-5 words) and meaningful name that describes its primary purpose or functionality. The name should be suitable for an entity identifier and should not include any punctuation or special characters, only alphanumeric and underscores.
Code snippet (language: ${language || 'unknown'}):
\`\`\`${language || ''}
${codeChunk}
\`\`\`
Concise Name:`;

            const nameResult = await this.geminiService.askGemini(prompt, this.geminiService.summarizationModelName);
            let extractedName = nameResult.content[0].text ?? '';
            extractedName = extractedName.replace(/[^a-zA-Z0-9\s]/g, '').trim();
            extractedName = extractedName.replace(/\s+/g, '_');

            if (extractedName.length > 0) {
                return extractedName;
            }
            return 'anonymous_chunk';
        } catch (error) {
            console.warn('Failed to generate meaningful entity name for anonymous chunk:', error);
            return 'anonymous_chunk';
        }
    }


    /**
     * Deletes embeddings related to specified file paths from vector and metadata tables.
     * @param filePaths Array of relative file paths to delete embeddings for.
     * @param vectorTable Name of the vector table.
     * @param metadataTable Name of the metadata table.
     * @returns Number of deleted embeddings.
     */
    public async cleanUpEmbeddingsByFilePaths(
        agentId: string, // Add agentId as a parameter
        filePaths: string[],
        vectorTable: string = 'codebase_embeddings_vec_idx',
        metadataTable: string = 'codebase_embeddings'
    ): Promise<{ deletedCount: number; deletedEmbeddings: Array<{ file_path_relative: string; chunk_text: string }> }> { // Change return type to object with deletedCount and deletedEmbeddings
        if (!agentId) {
            throw new Error("Agent ID is required for cleanup.");
        }
        if (!filePaths || filePaths.length === 0) {
            throw new Error("No file paths provided for cleanup.");
        }

        const placeholders = filePaths.map(() => '?').join(',');
        const selectSql = `SELECT embedding_id, file_path_relative, chunk_text FROM ${metadataTable} WHERE file_path_relative IN (${placeholders})`;
        const embeddingsToDelete = this.vectorDb.prepare(selectSql).all(...filePaths) as Array<{ embedding_id: string; file_path_relative: string; chunk_text: string }>;

        let deletedCount = 0;
        const deletedEmbeddings: Array<{ file_path_relative: string; chunk_text: string }> = [];

        for (const embedding of embeddingsToDelete) {
            try {
                this.vectorDb.prepare(`DELETE FROM ${vectorTable} WHERE embedding_id = ?`).run(embedding.embedding_id);
                this.vectorDb.prepare(`DELETE FROM ${metadataTable} WHERE embedding_id = ?`).run(embedding.embedding_id);
                deletedCount++;
                deletedEmbeddings.push({
                    file_path_relative: embedding.file_path_relative,
                    chunk_text: embedding.chunk_text
                });
            } catch (error) {
                console.error(`Failed to delete embedding ${embedding.embedding_id}:`, error);
            }
        }

        return { deletedCount, deletedEmbeddings };
    }

    private generateChunkHash(text: string): string {
        return crypto.createHash('sha256').update(text).digest('hex');
    }

    /**
     * Converts an array of numbers (vector) to a Buffer for BLOB storage.
     * Assumes float32, which is common for embeddings.
     */
    private vectorToBuffer(vector: number[]): Buffer {
        const buffer = Buffer.alloc(vector.length * VECTOR_FLOAT_SIZE);
        for (let i = 0; i < vector.length; i++) {
            buffer.writeFloatLE(vector[i], i * VECTOR_FLOAT_SIZE);
        }
        return buffer;
    }

    /**
     * Converts a Buffer (from BLOB storage) back to an array of numbers (vector).
     * Assumes float32.
     */
    private bufferToVector(buffer: Buffer): number[] {
        const vector: number[] = [];
        for (let i = 0; i < buffer.length; i += VECTOR_FLOAT_SIZE) {
            vector.push(buffer.readFloatLE(i));
        }
        return vector;
    }

    /**
     * Checks if an embedding with the given chunk hash already exists in the metadata table.
     */
    private async getExistingEmbeddingByHash(chunkHash: string, metadataTable: string): Promise<CodebaseEmbeddingRecord | null> {
        const sql = `SELECT * FROM ${metadataTable} WHERE chunk_hash = ?`;
        return (this.vectorDb.prepare(sql).get(chunkHash) as CodebaseEmbeddingRecord) || null;
    }

    private async getExistingSummaryByHash(originalCodeHash: string, metadataTable: string): Promise<string | null> {
        const sql = `SELECT chunk_text FROM ${metadataTable} WHERE json_extract(metadata_json, '$.original_code_hash') = ?`;
        const result = this.vectorDb.prepare(sql).get(originalCodeHash);
        return result ? result.chunk_text : null;
    }

    private async getEmbeddingsForChunks(texts: string[], modelName: string = DEFAULT_EMBEDDING_MODEL): Promise<{ embeddings: Array<{ vector: number[], dimensions: number } | null>, requestCount: number, retryCount: number }> {
        if (texts.length === 0) return { embeddings: [], requestCount: 0, retryCount: 0 };

        if (!this.geminiService) {
            throw new Error(`GeminiIntegrationService not available in CodebaseEmbeddingService.`);
        }

        let totalRequests = 0;
        let totalRetries = 0;

        const genAIInstance = this.geminiService.getGenAIInstance();
        if (!genAIInstance) {
            throw new Error(`Gemini API not initialized in GeminiIntegrationService.`);
        }

        const results: Array<{ vector: number[], dimensions: number } | null> = [];
        const batchSize = 100; // Increased batch size for better performance
        const maxRetries = 2; // Reduced retry attempts
        const delayBetweenBatches = 7000; // 7 seconds delay between batches


        for (let i = 0; i < texts.length; i += batchSize) {
            const batchTexts = texts.slice(i, i + batchSize);
            const contents = batchTexts.map(text => ({ role: "user", parts: [{ text }] }));
            const totalTokens = batchTexts.reduce((acc, text) => acc + text.length, 0);
            console.log(`[CodebaseEmbeddingService] Processing batch with ${batchTexts.length} texts and ${totalTokens} tokens.`);

            let attempt = 0;
            let success = false;
            totalRequests++; // Count initial request
            while (attempt <= maxRetries && !success) {
                try {
                    const result = await genAIInstance.models.embedContent({ model: modelName, contents });
                    const embeddings = result.embeddings;

                    if (embeddings && embeddings.length === batchTexts.length) {
                        for (const embedding of embeddings) {
                            if (embedding.values) {
                                results.push({ vector: embedding.values, dimensions: embedding.values.length });
                            } else {
                                results.push(null);
                            }
                        }
                        success = true;
                    } else {
                        // If the batch fails, push null for each text in the batch
                        for (let j = 0; j < batchTexts.length; j++) {
                            results.push(null);
                        }
                        success = true; // Consider as success to break retry loop
                    }
                } catch (error: any) {
                    if (error?.message?.includes('429') || error?.message?.includes('Too Many Requests') || (error?.cause && error.cause.message && error.cause.message.includes('429'))) {
                        attempt++;
                        totalRetries++; // Count retry
                        if (attempt <= maxRetries) {
                            const backoffTime = 6000 * attempt; // Exponential backoff: 6s, 12s, 18s
                            console.warn(`Received 429 Too Many Requests. Retry attempt ${attempt} after ${backoffTime}ms.`);
                            await new Promise(resolve => setTimeout(resolve, backoffTime));
                        } else {
                            console.error(`Max retries (${maxRetries}) reached for batch starting at index ${i}. Skipping batch.`);
                            for (let j = 0; j < batchTexts.length; j++) {
                                results.push(null);
                            }
                            success = true; // Break retry loop
                        }
                    } else {
                        console.error(`Error embedding batch starting at index ${i}:`, error);
                        for (let j = 0; j < batchTexts.length; j++) {
                            results.push(null);
                        }
                        success = true; // Break retry loop on other errors
                    }
                }
            }
            // Wait for the specified delay before the next batch request
            if (i + batchSize < texts.length) { // Only wait if there are more batches
                 await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
            }
        }
        return { embeddings: results, requestCount: totalRequests, retryCount: totalRetries };
    }
    
    /**
     * Creates intelligent, context-aware chunks from file content.
     */
    private async chunkFileContent(
        agentId: string,
        filePath: string,
        fileContent: string,
        relativeFilePath: string,
        language: string | undefined,
        strategy: ChunkingStrategy,
        storeEntitySummaries: boolean // New parameter
    ): Promise<Array<{ chunk_text: string; entity_name?: string; metadata?: any; ai_summary_text?: string }>> {
        const chunks: Array<{ chunk_text: string; entity_name?: string; metadata?: any; ai_summary_text?: string }> = [];

        // Always create a chunk for the full file content for general retrieval
        let fullFileEntityName: string | null = 'full_file_chunk'; // Default name
        if (!language) { // Only generate a meaningful name if language is not detected (truly anonymous)
            fullFileEntityName = await this.generateMeaningfulEntityName(fileContent, language);
        }
        chunks.push({ 
            chunk_text: fileContent, 
            entity_name: fullFileEntityName,
            metadata: { type: 'full_file', language } 
        });

        // Only perform advanced chunking for supported languages
        if (!language || !['typescript', 'javascript', 'python', 'php'].includes(language) ) {
            return chunks;
        }
        
        // Get file-level context (imports) to prepend to entity chunks
        const imports = await this.introspectionService.parseFileForImports(agentId, filePath, language);
        const importContext = "/* Imports for context */\n" + imports.map(imp => imp.originalImportString).join('\n');

        const codeEntities = await this.introspectionService.parseFileForCodeEntities(agentId, filePath, language);
        
        // Create a map of function names to their code for recursive lookups within the same file
        const functionCodeMap = new Map<string, string>();
        codeEntities.forEach(entity => {
            if (entity.type === 'function' || entity.type === 'method') {
                if (typeof entity.name === 'string' && entity.name.length > 0) {
                    const entityCode = fileContent.split(/\r\n|\r|\n/).slice(entity.startLine - 1, entity.endLine).join('\n');
                    functionCodeMap.set(entity.name, entityCode);
                }
            }
        });

        if ((strategy === 'function' || strategy === 'class' || strategy === 'auto') && codeEntities.length > 0) {
            for (const entity of codeEntities) {
                // Process only the entity types relevant to the strategy
                if ((strategy === 'function' && (entity.type === 'function' || entity.type === 'method')) ||
                    (strategy === 'class' && entity.type === 'class') ||
                    (strategy === 'auto' && ['function', 'method', 'class', 'interface'].includes(entity.type))) {

                    const entityCode = fileContent.split(/\r\n|\r|\n/).slice(entity.startLine - 1, entity.endLine).join('\n');

                    if (entityCode.trim()) { // Only add non-empty chunks

                        // Get graph context (entity relationships)
                        let graphContext = "/* Code structure context */\n";
                        try {
                            const relations = await this.memoryManager.knowledgeGraphManager.searchNodes(agentId, `name:${entity.fullName}`);
                            if (relations && relations.length > 0) {
                                const relatedNodes = relations.map((r: any) => r.name);
                                graphContext += `/* This entity is related to: ${relatedNodes.join(', ')} */\n`;
                            }
                            if (entity.parentClass) {
                                graphContext += `/* This method is part of class: ${entity.parentClass} */\n`;
                            }
                        } catch (e) {
                            console.warn(`Could not retrieve graph context for ${entity.fullName}: `, e);
                        }

                        // Implement Recursive Chunking by finding internal function calls
                        let recursiveContext = '/* Recursively included function calls */\n';
                        if (entity.type === 'function' || entity.type === 'method') {
                            for (const [funcName, funcCode] of functionCodeMap.entries()) {
                                if (funcName !== entity.name && entityCode.includes(funcName)) {
                                    recursiveContext += `/* Included from internal call to ${funcName} */\n${funcCode}\n\n`;
                                }
                            }
                        }

                        // Combine all context with the actual code
                        const codeWithFullContext = `${recursiveContext}${graphContext}${importContext}\n\n${entityCode}`;

                        // Determine the entity name: use AI for anonymous functions, otherwise use the extracted name
                        let entityNameForChunk = entity.name;
                        if (entity.name && entity.name.startsWith('anonymous_function_at_line_')) {
                            entityNameForChunk = await this.generateMeaningfulEntityName(entityCode, language);
                        }

                        // Create a chunk for the raw code with all its context
                        chunks.push({
                            chunk_text: codeWithFullContext,
                            entity_name: entityNameForChunk,
                            metadata: {
                                type: entity.type,
                                startLine: entity.startLine,
                                endLine: entity.endLine,
                                signature: entity.signature,
                                fullName: entity.fullName,
                                language: language
                            }
                        });

                        if (storeEntitySummaries && entity.name && ['function', 'method', 'class', 'interface'].includes(entity.type)) {
                            // Check if a summary for this code chunk already exists
                            const originalCodeHash = this.generateChunkHash(entityCode);
                            let summary = await this.getExistingSummaryByHash(originalCodeHash, 'codebase_embeddings');

                            if (!summary) {
                                // If no summary exists, generate a new one
                                await this.waitForRateLimit(); // Wait before making the AI call
                                const summarizationPrompt = `You are an expert software engineer. Summarize the following ${entity.type} code snippet focusing only on the main purpose and key functionality. Provide a concise, clear, and relevant summary suitable for a development team review.\n\n${codeWithFullContext}`;
                                summary = await this.geminiService.summarizeCodeChunk(summarizationPrompt, entity.type, language);
                            }

                            // Determine the entity name for the summary chunk
                            let summaryEntityName = `${entity.name}_summary`;
                            if (entity.name.startsWith('anonymous_function_at_line_')) {
                                summaryEntityName = await this.generateMeaningfulEntityName(summary, 'text'); // AI-generate name for anonymous summary
                            }

                            chunks.push({
                                chunk_text: entityCode, // Store original code in chunk_text
                                ai_summary_text: summary, // Store AI summary in new column
                                entity_name: summaryEntityName, // Use the determined summary entity name
                                metadata: {
                                    type: `${entity.type}_summary`,
                                    original_code_hash: originalCodeHash,
                                    startLine: entity.startLine,
                                    endLine: entity.endLine,
                                    fullName: entity.fullName,
                                    language: language // Use original language for code chunk
                                }
                            });
                        }
                    }
                }
            }
        }
        return chunks;
    }

    /**
     * Generates and stores embeddings for a single file, handling chunking, hashing, and stale data cleanup.
     */
        public async generateAndStoreEmbeddingsForFile(
            agentId: string,
            filePath: string,
            projectRootPath: string,
            strategy: ChunkingStrategy = 'auto',
            includeSummaryPatterns?: string[],
            excludeSummaryPatterns?: string[],
            storeEntitySummaries: boolean = true, // New argument
            vectorTable: string = 'codebase_embeddings_vec_idx',
            metadataTable: string = 'codebase_embeddings'
        ): Promise<{
            newEmbeddingsCount: number;
            reusedEmbeddingsCount: number;
            deletedEmbeddingsCount: number;
            newEmbeddings: Array<{ file_path_relative: string; chunk_text: string }>;
            reusedEmbeddings: Array<{ file_path_relative: string; chunk_text: string }>;
            deletedEmbeddings: Array<{ file_path_relative: string; chunk_text: string }>;
            aiSummary?: string;
            embeddingRequestCount: number; // New field
            embeddingRetryCount: number; // New field
            totalTimeMs: number; // New field
        }> {
            const startTime = Date.now(); // Record start time
            console.log(`[CodebaseEmbeddingService] Starting embedding generation for file: ${filePath}`);
            await this.embeddingCache.loadCacheState(); // Load cache state at the beginning

            let fileContent: string;
            try {
                fileContent = await fs.readFile(filePath, 'utf-8');
                console.log(`[CodebaseEmbeddingService] File content read successfully. Length: ${fileContent.length}`);
                if (!fileContent.trim()) {
                    console.log(`Skipping empty file: ${filePath}`);
                    const endTime = Date.now();
                    const totalTimeMs = endTime - startTime;
                    return {
                        newEmbeddingsCount: 0,
                        reusedEmbeddingsCount: 0,
                        deletedEmbeddingsCount: 0,
                        newEmbeddings: [],
                        reusedEmbeddings: [],
                        deletedEmbeddings: [],
                        embeddingRequestCount: 0,
                        embeddingRetryCount: 0,
                        totalTimeMs
                    };
                }
            } catch (e) {
                const endTime = Date.now();
                const totalTimeMs = endTime - startTime;
                console.error(`Skipping embedding for unreadable file ${filePath}:`, e);
                return {
                    newEmbeddingsCount: 0,
                    reusedEmbeddingsCount: 0,
                    deletedEmbeddingsCount: 0,
                    newEmbeddings: [],
                    reusedEmbeddings: [],
                    deletedEmbeddings: [],
                    embeddingRequestCount: 0,
                    embeddingRetryCount: 0,
                    totalTimeMs
                };
            }

            const relativeFilePath = path.relative(projectRootPath, filePath).replace(/\\/g, '/');
            const language = await this.introspectionService.detectLanguage(agentId, filePath, path.basename(filePath));
            console.log(`[CodebaseEmbeddingService] Detected language: ${language}`);

            const existingEmbeddingsForFile = await getEmbeddingsForFile(this.vectorDb, relativeFilePath, metadataTable);
            const currentHashesInFile = new Set<string>();
            let chunksData = await this.chunkFileContent(agentId, filePath, fileContent, relativeFilePath, language, strategy, storeEntitySummaries);
            console.log(`[CodebaseEmbeddingService] Created ${chunksData.length} chunks.`);
            
            if (chunksData.length === 0) {
                if (existingEmbeddingsForFile.length > 0) {
                    for (const existingEmbedding of existingEmbeddingsForFile) {
                        if (existingEmbedding.embedding_id) {
                            await deleteEmbedding(this.vectorDb, existingEmbedding.embedding_id, vectorTable, metadataTable);
                        }
                    }
                }
                const endTime = Date.now();
                const totalTimeMs = endTime - startTime;
                return {
                    newEmbeddingsCount: 0,
                    reusedEmbeddingsCount: 0,
                    deletedEmbeddingsCount: existingEmbeddingsForFile.length,
                    newEmbeddings: [],
                    reusedEmbeddings: [],
                    deletedEmbeddings: existingEmbeddingsForFile.map(e => ({
                        file_path_relative: relativeFilePath,
                        chunk_text: e.chunk_text
                    })),
                    embeddingRequestCount: 0,
                    embeddingRetryCount: 0,
                    totalTimeMs
                };
            }

            // Filter out chunks already in cache (for resumption)
            const chunksToEmbed: Array<{ chunk_text: string; entity_name?: string; metadata?: any; ai_summary_text?: string }> = [];
            for (const chunk of chunksData) {
                const chunkHash = this.generateChunkHash(chunk.chunk_text);
                if (!(await this.embeddingCache.hasChunkInCache(chunkHash))) {
                    chunksToEmbed.push(chunk);
                }
            }
            console.log(`[CodebaseEmbeddingService] ${chunksToEmbed.length} chunks to embed (after cache filtering).`);


        const textsToEmbed = chunksToEmbed.map(c => c.chunk_text);
        let embeddingResultsWithNulls = [];
        let embeddingRequestCount = 0;
        let embeddingRetryCount = 0;
        try {
            const result = await this.getEmbeddingsForChunks(textsToEmbed);
            embeddingResultsWithNulls = result.embeddings;
            embeddingRequestCount = result.requestCount;
            embeddingRetryCount = result.retryCount;
        } catch (e: unknown) {
            // If the embedding API fails mid-batch, process all successful results up to the point of failure
            if (
                typeof e === 'object' &&
                e !== null &&
                'embeddings' in e &&
                Array.isArray((e as any).embeddings)
            ) {
                const err = e as { embeddings: any[]; requestCount?: number; retryCount?: number };
                embeddingResultsWithNulls = err.embeddings;
                embeddingRequestCount = err.requestCount || 0;
                embeddingRetryCount = err.retryCount || 0;
            } else {
                throw e;
            }
        }

        const validResults = embeddingResultsWithNulls
            .map((result, index) => ({ result, index }))
            .filter((item): item is { result: { vector: number[]; dimensions: number }; index: number } => item.result !== null);

        const embeddingResults = validResults.map(item => item.result);
        const originalIndices = validResults.map(item => item.index); // These indices refer to chunksToEmbed

        let newEmbeddingsCount = 0;
        let reusedEmbeddingsCount = 0;
        const newEmbeddings: Array<{ file_path_relative: string; chunk_text: string }> = [];
        const reusedEmbeddings: Array<{ file_path_relative: string; chunk_text: string }> = [];

        // Determine if summary should be generated for this file based on patterns
        const shouldGenerateSummaryForFile = (
            (includeSummaryPatterns && includeSummaryPatterns.length > 0)
                ? includeSummaryPatterns.some(pattern => minimatch(relativeFilePath, pattern))
                : true
        ) && (
            (excludeSummaryPatterns && excludeSummaryPatterns.length > 0)
                ? !excludeSummaryPatterns.some(pattern => minimatch(relativeFilePath, pattern))
                : true
        );

        for (let i = 0; i < embeddingResults.length; i++) {
            const originalIndexInChunksToEmbed = originalIndices[i];
            const chunk = chunksToEmbed[originalIndexInChunksToEmbed]; // Get chunk from filtered list
            const chunkHash = this.generateChunkHash(chunk.chunk_text);
            currentHashesInFile.add(chunkHash);

            const existingEmbedding = await this.getExistingEmbeddingByHash(chunkHash, metadataTable);

            if (existingEmbedding) {
                reusedEmbeddingsCount++;
                reusedEmbeddings.push({
                    file_path_relative: relativeFilePath,
                    chunk_text: chunk.chunk_text
                });
            } else {
                const embedding = embeddingResults[i];
                if (!embedding) continue;
                const { vector } = embedding;
                if (!vector || vector.length === 0) continue;

                // Add chunk and embedding to cache immediately after embedding
                await this.embeddingCache.addChunk(
                    agentId,
                    chunk.chunk_text,
                    chunk.entity_name || null,
                    vector,
                    vector.length,
                    DEFAULT_EMBEDDING_MODEL,
                    chunkHash,
                    {
                        ...chunk.metadata,
                        full_file_path: filePath, // Use the absolute file path directly
                        ai_summary_text: chunk.ai_summary_text || null
                    },
                    Math.floor(Date.now() / 1000),
                    relativeFilePath,
                    filePath // Pass the absolute file path
                );

                newEmbeddingsCount++;
                newEmbeddings.push({
                    file_path_relative: relativeFilePath,
                    chunk_text: chunk.chunk_text
                });
            }
        }
        // If there were fewer results than requested, throw to simulate batch failure
        if (embeddingResultsWithNulls.length < textsToEmbed.length) {
            throw new Error('Embedding batch failed partway through.');
        }

            // Flush the cache after processing all chunks for the file
            await this.embeddingCache.flushToDb();

            let deletedEmbeddingsCount = 0;
            const deletedEmbeddings: Array<{ file_path_relative: string; chunk_text: string }> = [];
            for (const existingEmbedding of existingEmbeddingsForFile) {
                if (existingEmbedding.chunk_hash && !currentHashesInFile.has(existingEmbedding.chunk_hash)) {
                    try {
                        if (existingEmbedding.embedding_id) {
                            await deleteEmbedding(this.vectorDb, existingEmbedding.embedding_id, vectorTable, metadataTable);
                            deletedEmbeddingsCount++;
                            deletedEmbeddings.push({
                                file_path_relative: relativeFilePath,
                                chunk_text: existingEmbedding.chunk_text
                            });
                        }
                    } catch (deleteError: any) {
                        console.error(`Failed to delete stale embedding ${existingEmbedding.embedding_id}:`, deleteError);
                    }
                }
            }

            if (newEmbeddingsCount > 0) console.log(`Created ${newEmbeddingsCount} new embeddings for file ${relativeFilePath}`);
            if (reusedEmbeddingsCount > 0) console.log(`Reused ${reusedEmbeddingsCount} existing embeddings for file ${relativeFilePath}`);
            if (deletedEmbeddingsCount > 0) console.log(`Deleted ${deletedEmbeddingsCount} stale embeddings for file ${relativeFilePath}`);

            let aiSummary = '';
            try {
                if (this.geminiService && shouldGenerateSummaryForFile) { // Only generate summary if allowed by patterns
                    await this.waitForRateLimit(); // Wait before making the AI call
                    const response = await this.geminiService.askGemini(
                        `You are an expert software engineer. Provide a sophisticated, detailed, and insightful summary of the embedding ingestion operation for the file "${relativeFilePath}". Include counts of new, reused, and deleted embeddings. Highlight the significance of the changes, potential impacts on the codebase, and any notable patterns or observations. Use clear technical language suitable for a development team review.`
                    );
                    if (response && response.content && Array.isArray(response.content)) {
                        aiSummary = response.content.map(part => part.text).join('').trim();
                    }
                }
            } catch (e) {
                console.warn('AI summarizer failed:', e);
            }

            const endTime = Date.now();
            const totalTimeMs = endTime - startTime;

            console.log(`[CodebaseEmbeddingService] Finished embedding generation for file: ${relativeFilePath}. Time taken: ${totalTimeMs}ms. Embedding requests: ${embeddingRequestCount}, retries: ${embeddingRetryCount}`);

             return {
                 newEmbeddingsCount,
                 reusedEmbeddingsCount,
                 deletedEmbeddingsCount,
                 newEmbeddings,
                 reusedEmbeddings,
                 deletedEmbeddings,
                 aiSummary,
                 embeddingRequestCount,
                 embeddingRetryCount,
                 totalTimeMs
             };
         }

    public async generateAndStoreEmbeddingsForDirectory(
        agentId: string,
        directoryPath: string,
        projectRootPath: string,
        strategy: ChunkingStrategy = 'auto',
        includeSummaryPatterns?: string[],
        excludeSummaryPatterns?: string[],
        storeEntitySummaries: boolean = true // New argument
    ): Promise<{
        newEmbeddingsCount: number;
        reusedEmbeddingsCount: number;
        deletedEmbeddingsCount: number;
        newEmbeddings: Array<{ file_path_relative: string; chunk_text: string }>;
        reusedEmbeddings: Array<{ file_path_relative: string; chunk_text: string }>;
        deletedEmbeddings: Array<{ file_path_relative: string; chunk_text: string }>;
        aiSummary?: string;
        totalEmbeddingRequests: number; // New field
        totalEmbeddingRetries: number; // New field
        totalTimeMs: number; // New field
    }> {
   const startTime = Date.now(); // Record start time
    const absoluteProjectRootPath = path.resolve(projectRootPath);
    const absoluteDirectoryPath = path.resolve(directoryPath);

        const scannedItems = await this.introspectionService.scanDirectoryRecursive(agentId, absoluteDirectoryPath, absoluteProjectRootPath);
        
        await this.embeddingCache.loadCacheState(); // Load cache state at the beginning

        let totalNewEmbeddings = 0;
        let totalReusedEmbeddings = 0;
        let totalDeletedEmbeddings = 0;
        let totalEmbeddingRequests = 0; // New counter
        let totalEmbeddingRetries = 0; // New counter
        const newEmbeddings: Array<{ file_path_relative: string; chunk_text: string }> = [];
        const reusedEmbeddings: Array<{ file_path_relative: string; chunk_text: string }> = [];
        const deletedEmbeddings: Array<{ file_path_relative: string; chunk_text: string }> = [];

        for (const item of scannedItems) {
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
                            storeEntitySummaries // Pass new argument
                        );
                        totalNewEmbeddings += result.newEmbeddingsCount;
                        totalReusedEmbeddings += result.reusedEmbeddingsCount;
                        totalDeletedEmbeddings += result.deletedEmbeddingsCount;
                        totalEmbeddingRequests += result.embeddingRequestCount; // Accumulate counts
                        totalEmbeddingRetries += result.embeddingRetryCount; // Accumulate counts
                        newEmbeddings.push(...result.newEmbeddings);
                        reusedEmbeddings.push(...result.reusedEmbeddings);
                        deletedEmbeddings.push(...result.deletedEmbeddings);
                    } catch (fileError) {
                        console.error(`Error processing file ${item.path} for embeddings:`, fileError);
                    }
                }
            }
        }
        // Flush the cache after processing all files in the directory
        await this.embeddingCache.flushToDb();

        console.log(`Total new embeddings created for directory ${directoryPath}: ${totalNewEmbeddings}`);
        console.log(`Total reused embeddings for directory ${directoryPath}: ${totalReusedEmbeddings}`);
        console.log(`Total deleted embeddings for directory ${directoryPath}: ${totalDeletedEmbeddings}`);
        console.log(`Total embedding requests made for directory ${directoryPath}: ${totalEmbeddingRequests}`); // Log total requests
        console.log(`Total embedding retries attempted for directory ${directoryPath}: ${totalEmbeddingRetries}`); // Log total retries

        const endTime = Date.now();
        const totalTimeMs = endTime - startTime;
        console.log(`[CodebaseEmbeddingService] Finished embedding generation for directory: ${directoryPath}. Total time taken: ${totalTimeMs}ms.`);

        return {
            newEmbeddingsCount: totalNewEmbeddings,
            reusedEmbeddingsCount: totalReusedEmbeddings,
            deletedEmbeddingsCount: totalDeletedEmbeddings,
            newEmbeddings,
            reusedEmbeddings,
            deletedEmbeddings,
            aiSummary: '',
            totalEmbeddingRequests: totalEmbeddingRequests, // Include in return
            totalEmbeddingRetries: totalEmbeddingRetries, // Include in return
            totalTimeMs: totalTimeMs // Include in return
        };
    }

    public async retrieveSimilarCodeChunks(
        agentId: string,
        queryText: string,
        topK: number = 5,
        targetFilePaths?: string[],
        vectorTable: string = 'codebase_embeddings_vec_idx',
        metadataTable: string = 'codebase_embeddings'
    ): Promise<Array<{ chunk_text: string; ai_summary_text?: string | null; file_path_relative: string; entity_name: string | null; score: number; metadata?: Record<string, any> | null }>> {
        const embeddingResult = (await this.getEmbeddingsForChunks([queryText])).embeddings[0];
        if (!embeddingResult || !embeddingResult.vector) {
            throw new Error("Failed to generate embedding for query text.");
        }
        const queryEmbedding = embeddingResult.vector;

        // Retrieve topK * 2 results to have enough for both full_file and summary chunks
        const vecResults = await findSimilarVecEmbeddings(queryEmbedding, topK * 2, vectorTable);
        const ids = vecResults.map(r => r.embedding_id);
        // Fetch all columns, including the new ai_summary_text
        const metadataRows = await this.vectorDb.prepare(`SELECT * FROM ${metadataTable} WHERE embedding_id IN (${ids.map(() => '?').join(',')})`).all(...ids);

        // Separate full_file chunks and summary chunks
        const fullFileChunks: Array<any> = [];
        const summaryChunks: Array<any> = [];

        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            const meta = metadataRows.find(row => row.embedding_id === id) || {};
            let parsedMetadata: Record<string, any> | null = null;
            if (meta.metadata_json) {
                try {
                    parsedMetadata = JSON.parse(meta.metadata_json);
                } catch (e) {
                    console.warn(`Failed to parse metadata_json for embedding ID ${id}:`, e);
                }
            }

            const chunk = {
                chunk_text: meta.chunk_text || '', // This will now always be the original code
                ai_summary_text: meta.ai_summary_text || null, // Retrieve the AI summary
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

        // Interleave full_file and summary chunks to mix detailed code and summaries
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
