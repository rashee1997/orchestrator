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

    class EmbeddingCache {
        private cache: Map<string, {
            chunk_text: string;
            entity_name?: string | null;
            vector: number[];
            vector_dimensions: number;
            model_name: string;
            chunk_hash: string;
            metadata?: any;
            created_timestamp_unix: number;
        }>;
        private vectorDb: Database;
        private vectorTable: string = 'codebase_embeddings_vec_idx';
        private metadataTable: string = 'codebase_embeddings';
        private cacheFilePath: string = 'embedding_cache.json';

        constructor(vectorDb: Database) {
            this.cache = new Map();
            this.vectorDb = vectorDb;
        }

        // Add a chunk and its embedding to the cache
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
            full_file_path: string // Add new parameter for full file path
        ) => {
            try {
                // Check if embedding already exists in DB
                const existing = this.vectorDb.prepare(`SELECT 1 FROM ${this.metadataTable} WHERE chunk_hash = ?`).get(chunk_hash);
                if (existing) {
                    // Already stored, skip
                    return;
                }
                // Store vector embedding
                await storeVecEmbedding(chunk_hash, vector, this.vectorTable);
                // Store metadata
                await insertEmbeddingMetadata(this.vectorDb, this.metadataTable, {
                    embedding_id: chunk_hash,
                    agent_id: agentId,
                    file_path_relative: file_path_relative,
                    entity_name: entity_name,
                    chunk_text: chunk_text,
                    ai_summary_text: metadata?.ai_summary_text || null,
                    model_name: model_name,
                    chunk_hash: chunk_hash,
                    created_timestamp_unix: created_timestamp_unix,
                    metadata_json: metadata ? JSON.stringify(metadata) : null
                });
            } catch (error) {
                console.error(`Failed to store chunk ${chunk_hash} directly to DB:`, error);
            }
        }

    // Flush cache to DB in batch
    public async flushToDb(): Promise<number> {
        if (this.cache.size === 0) {
            return 0;
        }

        let flushedCount = 0;
        const flushedHashes: string[] = []; // Track successfully flushed hashes

        for (const [chunkHash, data] of this.cache.entries()) {
            try {
                // Check if embedding already exists in DB before flushing
                const existing = this.vectorDb.prepare(`SELECT 1 FROM ${this.metadataTable} WHERE chunk_hash = ?`).get(chunkHash);
                if (existing) {
                    // Already stored, skip
                    flushedHashes.push(chunkHash); // Mark as flushed even if skipped (already in DB)
                    continue;
                }

                await storeVecEmbedding(chunkHash, data.vector, this.vectorTable);
                await insertEmbeddingMetadata(this.vectorDb, this.metadataTable, {
                    embedding_id: chunkHash,
                    agent_id: data.metadata.agent_id,
                    file_path_relative: data.metadata.file_path_relative,
                    entity_name: data.entity_name,
                    chunk_text: data.chunk_text,
                    ai_summary_text: data.metadata?.ai_summary_text || null,
                    model_name: data.model_name,
                    chunk_hash: data.chunk_hash,
                    created_timestamp_unix: data.created_timestamp_unix,
                    metadata_json: data.metadata ? JSON.stringify(data.metadata) : null
                });
                flushedCount++;
                flushedHashes.push(chunkHash); // Mark as successfully flushed
            } catch (error) {
                console.error(`Failed to flush chunk ${chunkHash} to DB:`, error);
            }
        }

        // Remove successfully flushed items from cache
        for (const hash of flushedHashes) {
            this.cache.delete(hash);
        }
        
        await this.saveCacheState(); // Save updated cache state
        return flushedCount;
    }

    // Save cache state to JSON file for resuming
    public async saveCacheState(): Promise<void> {
        try {
            const cacheArray = Array.from(this.cache.entries()).map(([key, value]) => ({ key, value }));
            await fs.writeFile(this.cacheFilePath, JSON.stringify(cacheArray, null, 2), 'utf-8');
        } catch (error) {
            console.error('Failed to save embedding cache state:', error);
        }
    }

    // Load cache state from JSON file
    public async loadCacheState(): Promise<void> {
        try {
            const data = await fs.readFile(this.cacheFilePath, 'utf-8');
            const cacheArray = JSON.parse(data);
            this.cache = new Map(cacheArray.map((item: any) => [item.key, item.value]));
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                // File not found, which is expected on first run
                this.cache = new Map();
            } else {
                console.error('Failed to load embedding cache state:', error);
                this.cache = new Map(); // Ensure cache is empty on error
            }
        }
    }

    // Clear cache and delete cache file
    public async clearCache(): Promise<void> {
        this.cache.clear();
        try {
            await fs.unlink(this.cacheFilePath);
        } catch (error: any) {
            if (error.code !== 'ENOENT') { // Ignore file not found error
                console.error('Failed to delete embedding cache file:', error);
            }
        }
    }
}

export class CodebaseEmbeddingService {
    private memoryManager: MemoryManager;
    private geminiService: GeminiIntegrationService;
    private introspectionService: CodebaseIntrospectionService;
    private vectorDb: Database; // Connection to the separate vector_store.db

    // New cache instance for live chunk caching
    private embeddingCache: EmbeddingCache;

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
     * Generates a meaningful entity name for an anonymous code chunk using AI.
     * @param codeChunk The code snippet to name.
     * @param language The programming language of the code.
     * @returns A concise, meaningful name for the code chunk.
     */
    private async generateMeaningfulEntityName(codeChunk: string, language: string | undefined): Promise<string> {
        if (!this.geminiService) {
            return 'anonymous_chunk';
        }
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

    private async getEmbeddingsForChunks(texts: string[], modelName: string = DEFAULT_EMBEDDING_MODEL): Promise<Array<{ vector: number[], dimensions: number } | null>> {
        if (texts.length === 0) return [];

        if (!this.geminiService) {
            throw new Error(`GeminiIntegrationService not available in CodebaseEmbeddingService.`);
        }

        const genAIInstance = this.geminiService.getGenAIInstance();
        if (!genAIInstance) {
            throw new Error(`Gemini API not initialized in GeminiIntegrationService.`);
        }

        const results: Array<{ vector: number[], dimensions: number } | null> = [];
        const batchSize = 150; // Increased batch size for better performance
        const maxRetries = 2; // Reduced retry attempts

        for (let i = 0; i < texts.length; i += batchSize) {
            const batchTexts = texts.slice(i, i + batchSize);
            const contents = batchTexts.map(text => ({ role: "user", parts: [{ text }] }));
            const totalTokens = batchTexts.reduce((acc, text) => acc + text.length, 0);
            console.log(`[CodebaseEmbeddingService] Processing batch with ${batchTexts.length} texts and ${totalTokens} tokens.`);

            let attempt = 0;
            let success = false;
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
                    attempt++;
                    if (error?.message?.includes('429') || error?.message?.includes('Too Many Requests') || (error?.cause && error.cause.message && error.cause.message.includes('429'))) {
                        if (attempt <= maxRetries) {
                            const backoffTime = 6000 * attempt; // Exponential backoff: 6s, 12s, 18s
                            console.warn(`Received 429 Too Many Requests. Retry attempt ${attempt} after ${backoffTime}ms.`);
                            await new Promise(resolve => setTimeout(resolve, backoffTime));
                        } else {
                            console.error(`Max retries reached for batch starting at index ${i}. Skipping batch.`);
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
            // Wait for 7 seconds before the next request to stay within the 10 requests/minute limit
            await new Promise(resolve => setTimeout(resolve, 7000));
        }
        return results;
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
        }> {
            console.log(`[CodebaseEmbeddingService] Starting embedding generation for file: ${filePath}`);
            await this.embeddingCache.loadCacheState(); // Load cache state at the beginning

            let fileContent: string;
            try {
                fileContent = await fs.readFile(filePath, 'utf-8');
                console.log(`[CodebaseEmbeddingService] File content read successfully. Length: ${fileContent.length}`);
                if (!fileContent.trim()) {
                    console.log(`Skipping empty file: ${filePath}`);
                    return {
                        newEmbeddingsCount: 0,
                        reusedEmbeddingsCount: 0,
                        deletedEmbeddingsCount: 0,
                        newEmbeddings: [],
                        reusedEmbeddings: [],
                        deletedEmbeddings: []
                    };
                }
            } catch (e) {
                console.error(`Skipping embedding for unreadable file ${filePath}:`, e);
                return {
                    newEmbeddingsCount: 0,
                    reusedEmbeddingsCount: 0,
                    deletedEmbeddingsCount: 0,
                    newEmbeddings: [],
                    reusedEmbeddings: [],
                    deletedEmbeddings: []
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
                await this.embeddingCache.saveCacheState(); // Save cache state at the end
                return {
                    newEmbeddingsCount: 0,
                    reusedEmbeddingsCount: 0,
                    deletedEmbeddingsCount: existingEmbeddingsForFile.length,
                    newEmbeddings: [],
                    reusedEmbeddings: [],
                    deletedEmbeddings: existingEmbeddingsForFile.map(e => ({
                        file_path_relative: relativeFilePath,
                        chunk_text: e.chunk_text
                    }))
                };
            }

            // Filter out chunks already in cache (for resumption)
            const chunksToEmbed = chunksData.filter(chunk => {
                const chunkHash = this.generateChunkHash(chunk.chunk_text);
                return !this.embeddingCache['cache'].has(chunkHash); // Access private cache for filtering
            });
            console.log(`[CodebaseEmbeddingService] ${chunksToEmbed.length} chunks to embed (after cache filtering).`);


        const textsToEmbed = chunksToEmbed.map(c => c.chunk_text);
        const embeddingResultsWithNulls = await this.getEmbeddingsForChunks(textsToEmbed);

        const validResults = embeddingResultsWithNulls
            .map((result, index) => ({ result, index }))
            .filter(item => item.result !== null);

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

                // Add chunk and embedding to cache
                this.embeddingCache.addChunk(
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
            await this.embeddingCache.saveCacheState(); // Save cache state at the end

            return {
                newEmbeddingsCount,
                reusedEmbeddingsCount,
                deletedEmbeddingsCount,
                newEmbeddings,
                reusedEmbeddings,
                deletedEmbeddings,
                aiSummary
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
    }> {
        const absoluteProjectRootPath = path.resolve(projectRootPath);
        const absoluteDirectoryPath = path.resolve(directoryPath);

        const scannedItems = await this.introspectionService.scanDirectoryRecursive(agentId, absoluteDirectoryPath, absoluteProjectRootPath);
        
        await this.embeddingCache.loadCacheState(); // Load cache state at the beginning

        let totalNewEmbeddings = 0;
        let totalReusedEmbeddings = 0;
        let totalDeletedEmbeddings = 0;
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
        await this.embeddingCache.saveCacheState(); // Save cache state at the end

        return {
            newEmbeddingsCount: totalNewEmbeddings,
            reusedEmbeddingsCount: totalReusedEmbeddings,
            deletedEmbeddingsCount: totalDeletedEmbeddings,
            newEmbeddings,
            reusedEmbeddings,
            deletedEmbeddings,
            aiSummary: ''
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
        const embeddingResult = (await this.getEmbeddingsForChunks([queryText]))[0];
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
