// src/services/CodebaseEmbeddingService.ts
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { MemoryManager } from '../memory_manager.js';
import { GeminiIntegrationService } from './GeminiIntegrationService.js';
import { CodebaseIntrospectionService, ExtractedCodeEntity, ScannedItem, ExtractedImport } from './CodebaseIntrospectionService.js';
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

// Helper to fetch all embeddings for a given file path
async function getEmbeddingsForFile(
    db: Database,
    filePathRelative: string,
    metadataTable: string
): Promise<CodebaseEmbeddingRecord[]> {
    const sql = `SELECT * FROM ${metadataTable} WHERE file_path_relative = ?`;
    return db.all<CodebaseEmbeddingRecord[]>(sql, filePathRelative);
}

// Helper to delete an embedding by its ID from both vector and metadata tables
async function deleteEmbedding(
    db: Database,
    embeddingId: string,
    vectorTable: string,
    metadataTable: string
): Promise<void> {
    await db.run(`DELETE FROM ${vectorTable} WHERE embedding_id = ?`, embeddingId);
    await db.run(`DELETE FROM ${metadataTable} WHERE embedding_id = ?`, embeddingId);
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

    /**
     * Checks if an embedding with the given chunk hash already exists in the metadata table.
     */
    private async getExistingEmbeddingByHash(chunkHash: string, metadataTable: string): Promise<CodebaseEmbeddingRecord | null> {
        const sql = `SELECT * FROM ${metadataTable} WHERE chunk_hash = ?`;
        return (await this.vectorDb.get<CodebaseEmbeddingRecord>(sql, chunkHash)) || null;
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
            try {
                const result = await genAIInstance.models.embedContent({ model: modelName, contents: [{ role: "user", parts: [{ text }] }] });
                const embeddingValues = result.embeddings?.[0]?.values;
                if (!embeddingValues) {
                    console.warn(`Failed to get embedding values for text: ${text.substring(0,50)}...`);
                    continue; // Skip this chunk if embedding failed
                }
                results.push({ vector: embeddingValues, dimensions: embeddingValues.length });
            } catch (error) {
                console.error(`Error embedding chunk: "${text.substring(0, 50)}..."`, error);
            }
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
        strategy: ChunkingStrategy
    ): Promise<Array<{ chunk_text: string; entity_name?: string; metadata?: any }>> {
        const chunks: Array<{ chunk_text: string; entity_name?: string; metadata?: any }> = [];

        // Always create a chunk for the full file content for general retrieval
        chunks.push({ 
            chunk_text: fileContent, 
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
                 const entityCode = fileContent.split(/\r\n|\r|\n/).slice(entity.startLine - 1, entity.endLine).join('\n');
                 functionCodeMap.set(entity.name, entityCode);
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
                             if(entity.parentClass) {
                                graphContext += `/* This method is part of class: ${entity.parentClass} */\n`;
                             }
                        } catch(e) {
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
                        
                        // Create a chunk for the raw code with all its context
                        chunks.push({
                            chunk_text: codeWithFullContext,
                            entity_name: entity.name,
                            metadata: {
                                type: entity.type,
                                startLine: entity.startLine,
                                endLine: entity.endLine,
                                signature: entity.signature,
                                fullName: entity.fullName,
                                language: language
                            }
                        });

                        // Create a separate chunk for the AI-generated summary
                        const summary = await this.geminiService.summarizeCodeChunk(codeWithFullContext, entity.type, language);
                        chunks.push({
                            chunk_text: summary,
                            entity_name: entity.name,
                            metadata: {
                                type: `${entity.type}_summary`,
                                original_code_hash: this.generateChunkHash(entityCode),
                                startLine: entity.startLine,
                                endLine: entity.endLine,
                                fullName: entity.fullName,
                                language: 'en' // Summary is in English
                            }
                        });
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
        vectorTable: string = 'codebase_embeddings_vec',
        metadataTable: string = 'codebase_embeddings'
    ): Promise<{ newEmbeddingsCount: number; reusedEmbeddingsCount: number; deletedEmbeddingsCount: number; }> {
        let fileContent: string;
        try {
            fileContent = await fs.readFile(filePath, 'utf-8');
            if (!fileContent.trim()) {
                console.log(`Skipping empty file: ${filePath}`);
                return { newEmbeddingsCount: 0, reusedEmbeddingsCount: 0, deletedEmbeddingsCount: 0 };
            }
        } catch (e) {
            console.error(`Skipping embedding for unreadable file ${filePath}:`, e);
            return { newEmbeddingsCount: 0, reusedEmbeddingsCount: 0, deletedEmbeddingsCount: 0 };
        }

        const relativeFilePath = path.relative(projectRootPath, filePath).replace(/\\/g, '/');
        const language = await this.introspectionService.detectLanguage(agentId, filePath, path.basename(filePath));

        const existingEmbeddingsForFile = await getEmbeddingsForFile(this.vectorDb, relativeFilePath, metadataTable);
        const currentHashesInFile = new Set<string>();
        const chunksData = await this.chunkFileContent(agentId, filePath, fileContent, relativeFilePath, language, strategy);
        
        if (chunksData.length === 0) {
            if (existingEmbeddingsForFile.length > 0) {
                for (const existingEmbedding of existingEmbeddingsForFile) {
                    if (existingEmbedding.embedding_id) {
                        await deleteEmbedding(this.vectorDb, existingEmbedding.embedding_id, vectorTable, metadataTable);
                    }
                }
            }
            return { newEmbeddingsCount: 0, reusedEmbeddingsCount: 0, deletedEmbeddingsCount: existingEmbeddingsForFile.length };
        }

        const textsToEmbed = chunksData.map(c => c.chunk_text);
        const embeddingResults = await this.getEmbeddingsForChunks(textsToEmbed);

        if (embeddingResults.length !== chunksData.length) {
            console.error(`Mismatch between chunks and generated vectors for ${filePath}. Skipping.`);
            return { newEmbeddingsCount: 0, reusedEmbeddingsCount: 0, deletedEmbeddingsCount: 0 };
        }

        let newEmbeddingsCount = 0;
        let reusedEmbeddingsCount = 0;

        for (let i = 0; i < chunksData.length; i++) {
            const chunk = chunksData[i];
            const chunkHash = this.generateChunkHash(chunk.chunk_text);
            currentHashesInFile.add(chunkHash);

            const existingEmbedding = await this.getExistingEmbeddingByHash(chunkHash, metadataTable);

            if (existingEmbedding) {
                reusedEmbeddingsCount++;
            } else {
                const { vector } = embeddingResults[i];
                if (!vector || vector.length === 0) continue;
                const embedding_id = uuidv4();

                try {
                    await storeVecEmbedding(embedding_id, vector, vectorTable);
                    await insertEmbeddingMetadata(this.vectorDb, metadataTable, {
                        embedding_id,
                        agent_id: agentId,
                        file_path_relative: relativeFilePath,
                        entity_name: chunk.entity_name || null,
                        chunk_text: chunk.chunk_text,
                        model_name: DEFAULT_EMBEDDING_MODEL,
                        chunk_hash: chunkHash,
                        created_timestamp_unix: Math.floor(Date.now() / 1000),
                        metadata_json: chunk.metadata ? JSON.stringify(chunk.metadata) : null
                    });
                    newEmbeddingsCount++;
                } catch (insertError: any) {
                    console.error(`Failed to insert embedding for ${relativeFilePath}:`, insertError);
                }
            }
        }

        let deletedEmbeddingsCount = 0;
        for (const existingEmbedding of existingEmbeddingsForFile) {
            if (existingEmbedding.chunk_hash && !currentHashesInFile.has(existingEmbedding.chunk_hash)) {
                try {
                    if (existingEmbedding.embedding_id) {
                        await deleteEmbedding(this.vectorDb, existingEmbedding.embedding_id, vectorTable, metadataTable);
                        deletedEmbeddingsCount++;
                    }
                } catch (deleteError: any) {
                    console.error(`Failed to delete stale embedding ${existingEmbedding.embedding_id}:`, deleteError);
                }
            }
        }

        if (newEmbeddingsCount > 0) console.log(`Created ${newEmbeddingsCount} new embeddings for file ${relativeFilePath}`);
        if (reusedEmbeddingsCount > 0) console.log(`Reused ${reusedEmbeddingsCount} existing embeddings for file ${relativeFilePath}`);
        if (deletedEmbeddingsCount > 0) console.log(`Deleted ${deletedEmbeddingsCount} stale embeddings for file ${relativeFilePath}`);
        
        return { newEmbeddingsCount, reusedEmbeddingsCount, deletedEmbeddingsCount };
    }

    public async generateAndStoreEmbeddingsForDirectory(
        agentId: string,
        directoryPath: string,
        projectRootPath: string,
        strategy: ChunkingStrategy = 'auto'
    ): Promise<{ newEmbeddingsCount: number; reusedEmbeddingsCount: number; deletedEmbeddingsCount: number; }> {
        const absoluteProjectRootPath = path.resolve(projectRootPath);
        const absoluteDirectoryPath = path.resolve(directoryPath);

        const scannedItems = await this.introspectionService.scanDirectoryRecursive(agentId, absoluteDirectoryPath, absoluteProjectRootPath);
        
        let totalNewEmbeddings = 0;
        let totalReusedEmbeddings = 0;
        let totalDeletedEmbeddings = 0;

        for (const item of scannedItems) {
            if (item.type === 'file') {
                const language = item.language || await this.introspectionService.detectLanguage(agentId, item.path, path.basename(item.path));
                if ((language && ['typescript', 'javascript', 'python', 'markdown', 'json', 'jsonl', 'html', 'css', 'java', 'csharp', 'go', 'ruby', 'php'].includes(language)) || (!language && item.stats.size > 0 && item.stats.size < 1024 * 1024)) {
                     try {
                        const result = await this.generateAndStoreEmbeddingsForFile(agentId, item.path, absoluteProjectRootPath, strategy);
                        totalNewEmbeddings += result.newEmbeddingsCount;
                        totalReusedEmbeddings += result.reusedEmbeddingsCount;
                        totalDeletedEmbeddings += result.deletedEmbeddingsCount;
                    } catch (fileError) {
                        console.error(`Error processing file ${item.path} for embeddings:`, fileError);
                    }
                }
            }
        }
        console.log(`Total new embeddings created for directory ${directoryPath}: ${totalNewEmbeddings}`);
        console.log(`Total reused embeddings for directory ${directoryPath}: ${totalReusedEmbeddings}`);
        console.log(`Total deleted embeddings for directory ${directoryPath}: ${totalDeletedEmbeddings}`);

        return {
            newEmbeddingsCount: totalNewEmbeddings,
            reusedEmbeddingsCount: totalReusedEmbeddings,
            deletedEmbeddingsCount: totalDeletedEmbeddings
        };
    }

    public async retrieveSimilarCodeChunks(
        agentId: string,
        queryText: string,
        topK: number = 5,
        targetFilePaths?: string[],
        vectorTable: string = 'codebase_embeddings_vec',
        metadataTable: string = 'codebase_embeddings'
    ): Promise<Array<{ chunk_text: string; file_path_relative: string; entity_name: string | null; score: number; metadata?: Record<string, any> | null }>> {
        const embeddingResult = (await this.getEmbeddingsForChunks([queryText]))[0];
        if (!embeddingResult || !embeddingResult.vector) {
            throw new Error("Failed to generate embedding for query text.");
        }
        const queryEmbedding = embeddingResult.vector;

        const vecResults = await findSimilarVecEmbeddings(queryEmbedding, topK, vectorTable);
        const ids = vecResults.map(r => r.embedding_id);
        const metadataRows = await fetchMetadataByIds(this.vectorDb, metadataTable, ids);
        
        return ids.map((id, i) => {
            const meta = metadataRows.find(row => row.embedding_id === id) || {};
            let parsedMetadata: Record<string, any> | null = null;
            if (meta.metadata_json) {
                try {
                    parsedMetadata = JSON.parse(meta.metadata_json);
                } catch (e) {
                    console.warn(`Failed to parse metadata_json for embedding ID ${id}:`, e);
                }
            }
            return {
                chunk_text: meta.chunk_text || '',
                file_path_relative: meta.file_path_relative || '',
                entity_name: meta.entity_name || null,
                score: vecResults[i]?.similarity ?? 0,
                metadata: parsedMetadata
            };
        });
    }
}
