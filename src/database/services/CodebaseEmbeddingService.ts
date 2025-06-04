// src/services/CodebaseEmbeddingService.ts
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { MemoryManager } from '../memory_manager.js';
import { GeminiIntegrationService } from './GeminiIntegrationService.js';
import { CodebaseIntrospectionService, ExtractedCodeEntity, ScannedItem } from './CodebaseIntrospectionService.js';
import { Database } from 'sqlite';
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
    await db.run(sql, ...columns.map(k => metadata[k]));
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
    return db.all(sql, ...embeddingIds);
}

// Define the structure for storing embeddings if not already defined elsewhere
interface CodebaseEmbeddingRecord {
    embedding_id: string;
    agent_id: string;
    file_path_relative: string;
    entity_name?: string | null;
    chunk_text: string;
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

export class CodebaseEmbeddingService {
    private memoryManager: MemoryManager;
    private geminiService: GeminiIntegrationService;
    private introspectionService: CodebaseIntrospectionService;
    private vectorDb: Database; // Connection to the separate vector_store.db

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


    private async getEmbeddingsForChunks(texts: string[], modelName: string = DEFAULT_EMBEDDING_MODEL): Promise<Array<{ vector: number[], dimensions: number }>> {
        if (texts.length === 0) return [];
        
        if (!this.geminiService) {
            throw new Error(`GeminiIntegrationService not available in CodebaseEmbeddingService.`);
        }
        
        const genAIInstance = this.geminiService.getGenAIInstance();
        if (!genAIInstance) {
            throw new Error(`Gemini API not initialized in GeminiIntegrationService.`);
        }

        const results: Array<{ vector: number[], dimensions: number }> = [];

        // Use individual embedContent calls as batchEmbedContents might not be available or typed correctly
        for (const text of texts) {
            const result = await genAIInstance.models.embedContent({ 
                model: modelName,
                contents: [{ role: "user", parts: [{ text }] }] 
            });
            const embeddingValues = result.embeddings?.[0]?.values; // Safely access embeddings
            if (!embeddingValues) {
                console.warn(`Failed to get embedding values for text: ${text.substring(0,50)}...`);
                continue; // Skip this chunk if embedding failed
            }
            results.push({ vector: embeddingValues, dimensions: embeddingValues.length });
        }
        return results;
    }

    private async chunkFileContent(
        agentId: string,
        filePath: string,
        fileContent: string,
        relativeFilePath: string,
        language: string | undefined,
        strategy: ChunkingStrategy
    ): Promise<Array<{ chunk_text: string; entity_name?: string; metadata?: any }>> {
        const chunks: Array<{ chunk_text: string; entity_name?: string; metadata?: any }> = [];

        if (strategy === 'file' || !language || !['typescript', 'javascript', 'python'].includes(language) ) { // Only attempt entity chunking for supported languages
            chunks.push({ chunk_text: fileContent, metadata: { type: 'full_file' } });
            return chunks;
        }

        const codeEntities = await this.introspectionService.parseFileForCodeEntities(agentId, filePath, language);

        if ((strategy === 'function' || strategy === 'class' || strategy === 'auto') && codeEntities.length > 0) {
            for (const entity of codeEntities) {
                if ((strategy === 'function' && (entity.type === 'function' || entity.type === 'method')) ||
                    (strategy === 'class' && entity.type === 'class') ||
                    (strategy === 'auto' && ['function', 'method', 'class', 'interface', 'enum', 'type_alias'].includes(entity.type))) {
                    
                    const entityCodeLines = fileContent.split(/\r\n|\r|\n/).slice(entity.startLine - 1, entity.endLine);
                    const entityCode = entityCodeLines.join('\n');
                    
                    if (entityCode.trim()) { // Only add non-empty chunks
                        chunks.push({
                            chunk_text: entityCode,
                            entity_name: entity.name,
                            metadata: {
                                type: entity.type,
                                startLine: entity.startLine,
                                endLine: entity.endLine,
                                signature: entity.signature,
                                fullName: entity.fullName
                            }
                        });
                    }
                }
            }
        }

        if (chunks.length === 0 && fileContent.trim()) { // If no entity chunks were made, or strategy forced file, and file is not empty
            chunks.push({ chunk_text: fileContent, metadata: { type: 'full_file_fallback' } });
        }
        return chunks;
    }

    /**
     * Store embeddings in the specified vector and metadata tables.
     */
    public async generateAndStoreEmbeddingsForFile(
        agentId: string,
        filePath: string,
        projectRootPath: string,
        strategy: ChunkingStrategy = 'auto',
        vectorTable: string = 'codebase_embeddings_vec',
        metadataTable: string = 'codebase_embeddings'
    ): Promise<number> {
        let fileContent: string;
        try {
            fileContent = await fs.readFile(filePath, 'utf-8');
            if (!fileContent.trim()) {
                console.log(`Skipping empty file: ${filePath}`);
                return 0;
            }
        } catch (e) {
            console.error(`Skipping embedding for unreadable file ${filePath}:`, e);
            return 0;
        }

        const relativeFilePath = path.relative(projectRootPath, filePath).replace(/\\/g, '/');
        const language = await (this.introspectionService as any).detectLanguage(agentId, filePath, path.basename(filePath));

        const chunksData = await this.chunkFileContent(agentId, filePath, fileContent, relativeFilePath, language, strategy);
        if (chunksData.length === 0) {
            console.log(`No chunks generated for ${filePath}. Skipping embedding.`);
            return 0;
        }

        const textsToEmbed = chunksData.map(c => c.chunk_text);
        const embeddingResults = await this.getEmbeddingsForChunks(textsToEmbed);

        if (embeddingResults.length !== chunksData.length) {
            console.error(`Mismatch between chunks and generated vectors for ${filePath}. Chunks: ${chunksData.length}, Vectors: ${embeddingResults.length}. Skipping.`);
            return 0;
        }

        let newEmbeddingsCount = 0;
        for (let i = 0; i < chunksData.length; i++) {
            const chunk = chunksData[i];
            const { vector } = embeddingResults[i];
            const embedding_id = uuidv4();
            try {
                await storeVecEmbedding(embedding_id, vector, vectorTable);
                // Insert metadata
                await insertEmbeddingMetadata(this.vectorDb, metadataTable, {
                    embedding_id,
                    agent_id: agentId,
                    file_path_relative: relativeFilePath,
                    entity_name: chunk.entity_name || null,
                    chunk_text: chunk.chunk_text,
                    model_name: DEFAULT_EMBEDDING_MODEL,
                    chunk_hash: this.generateChunkHash(chunk.chunk_text),
                    created_timestamp_unix: Math.floor(Date.now() / 1000),
                    metadata_json: chunk.metadata ? JSON.stringify(chunk.metadata) : null
                });
                newEmbeddingsCount++;
            } catch (insertError: any) {
                console.error(`Failed to insert embedding for ${relativeFilePath}:`, insertError);
            }
        }
        if (newEmbeddingsCount > 0) {
            console.log(`Created ${newEmbeddingsCount} new embeddings for file ${relativeFilePath}`);
        }
        return newEmbeddingsCount;
    }

    public async generateAndStoreEmbeddingsForDirectory(
        agentId: string,
        directoryPath: string,
        projectRootPath: string, // Crucial for consistent relative paths
        strategy: ChunkingStrategy = 'auto'
    ): Promise<number> {
        // Ensure projectRootPath is absolute for reliable relative path calculation
        const absoluteProjectRootPath = path.resolve(projectRootPath);
        const absoluteDirectoryPath = path.resolve(directoryPath);


        const scannedItems = await this.introspectionService.scanDirectoryRecursive(agentId, absoluteDirectoryPath, absoluteProjectRootPath);
        let totalEmbeddingsCreated = 0;

        for (const item of scannedItems) {
            if (item.type === 'file') {
                const language = item.language || await (this.introspectionService as any).detectLanguage(agentId, item.path, path.basename(item.path));
                if (language && ['typescript', 'javascript', 'python', 'markdown', 'json', 'jsonl', 'html', 'css', 'java', 'csharp', 'go', 'ruby', 'php'].includes(language)) { // Expand supported types
                     try {
                        totalEmbeddingsCreated += await this.generateAndStoreEmbeddingsForFile(agentId, item.path, absoluteProjectRootPath, strategy);
                    } catch (fileError) {
                        console.error(`Error processing file ${item.path} for embeddings:`, fileError);
                    }
                } else if (!language && item.stats.size > 0 && item.stats.size < 1024 * 1024) { // Embed small unknown files as plain text
                    console.log(`Attempting to embed file with unknown language (as plain text): ${item.path}`);
                     try {
                        totalEmbeddingsCreated += await this.generateAndStoreEmbeddingsForFile(agentId, item.path, absoluteProjectRootPath, 'file');
                    } catch (fileError) {
                         console.error(`Error processing plain text file ${item.path} for embeddings:`, fileError);
                    }
                }
            }
        }
        console.log(`Total new embeddings created for directory ${directoryPath}: ${totalEmbeddingsCreated}`);
        return totalEmbeddingsCreated;
    }

    /**
     * Retrieve similar code chunks from the specified vector and metadata tables.
     */
    public async retrieveSimilarCodeChunks(
        agentId: string,
        queryText: string,
        topK: number = 5,
        targetFilePaths?: string[],
        vectorTable: string = 'codebase_embeddings_vec',
        metadataTable: string = 'codebase_embeddings'
    ): Promise<Array<{ chunk_text: string; file_path_relative: string; entity_name: string | null; score: number; metadata_json: string | null }>> {
        const embeddingResult = (await this.getEmbeddingsForChunks([queryText]))[0];
        if (!embeddingResult || !embeddingResult.vector) {
            throw new Error("Failed to generate embedding for query text.");
        }
        const queryEmbedding = embeddingResult.vector;

        // Use sqlite-vec for similarity search
        const vecResults = await findSimilarVecEmbeddings(queryEmbedding, topK, vectorTable);
        const ids = vecResults.map(r => r.embedding_id);
        const metadataRows = await fetchMetadataByIds(this.vectorDb, metadataTable, ids);
        // Join similarity scores with metadata
        return ids.map((id, i) => {
            const meta = metadataRows.find(row => row.embedding_id === id) || {};
            return {
                chunk_text: meta.chunk_text || '',
                file_path_relative: meta.file_path_relative || '',
                entity_name: meta.entity_name || null,
                score: vecResults[i]?.similarity ?? 0,
                metadata_json: meta.metadata_json || null
            };
        });
    }

    // cosineSimilarity and bufferToVector/vectorToBuffer are no longer needed (handled by vector_db)
}
