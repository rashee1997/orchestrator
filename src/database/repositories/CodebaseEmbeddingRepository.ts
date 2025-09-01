import { Database } from 'better-sqlite3';
import { CodebaseEmbeddingRecord } from '../../types/codebase_embeddings.js';
import { findSimilarVecEmbeddings } from '../vector_db.js';

export class CodebaseEmbeddingRepository {
    private db: Database;
    private vectorTable: string = 'codebase_embeddings_vec_idx';
    private metadataTable: string = 'codebase_embeddings';
    private maxRetries: number = 3;
    private retryDelay: number = 1000;
    private connectionTimeout: number = 30000;

    constructor(db: Database) {
        this.db = db;
        // Configure database settings for better performance
        try {
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('synchronous = NORMAL');
            this.db.pragma('cache_size = -10000'); // 10MB cache
            this.db.pragma('temp_store = MEMORY');
            this.db.pragma('mmap_size = 268435456'); // 256MB mmap
        } catch (error) {
            console.warn('Failed to set database pragmas:', error);
        }
    }

    private async _executeWithRetry<T>(operation: () => T, operationName: string): Promise<T> {
        let lastError: any = null;

        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                const result = await Promise.resolve(operation());
                return result;
            } catch (error: any) {
                lastError = error;
                console.warn(`${operationName} failed (attempt ${attempt}/${this.maxRetries}):`, error.message);

                if (attempt < this.maxRetries) {
                    const delay = this.retryDelay * Math.pow(2, attempt - 1);
                    console.log(`Retrying ${operationName} in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        console.error(`${operationName} failed after ${this.maxRetries} attempts:`, lastError?.message);
        throw lastError || new Error(`${operationName} failed after maximum retries`);
    }

    public async bulkInsertEmbeddings(embeddings: CodebaseEmbeddingRecord[]): Promise<void> {
        if (embeddings.length === 0) return;

        const insertMetadataSql = `INSERT OR REPLACE INTO ${this.metadataTable} (
            embedding_id, agent_id, chunk_text, entity_name, entity_name_vector_blob, entity_name_vector_dimensions,
            model_name, chunk_hash, file_hash, metadata_json, created_timestamp_unix, file_path_relative,
            full_file_path, ai_summary_text, vector_dimensions, embedding_type, parent_embedding_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        const insertVecSql = `INSERT OR REPLACE INTO ${this.vectorTable} (embedding_id, embedding) VALUES (?, ?);`;

        await this._executeWithRetry(async () => {
            const transaction = this.db.transaction((records: CodebaseEmbeddingRecord[]) => {
                const stmtMetadata = this.db.prepare(insertMetadataSql);
                const stmtVec = this.db.prepare(insertVecSql);

                for (const metadata of records) {
                    try {
                        stmtMetadata.run(
                            metadata.embedding_id,
                            metadata.agent_id,
                            metadata.chunk_text,
                            metadata.entity_name,
                            metadata.entity_name_vector_blob,
                            metadata.entity_name_vector_dimensions,
                            metadata.model_name,
                            metadata.chunk_hash,
                            metadata.file_hash,
                            metadata.metadata_json,
                            metadata.created_timestamp_unix,
                            metadata.file_path_relative,
                            metadata.full_file_path,
                            metadata.ai_summary_text,
                            metadata.vector_dimensions,
                            metadata.embedding_type,
                            metadata.parent_embedding_id
                        );

                        if (metadata.vector_blob && metadata.vector_blob.length > 0) {
                            const vector: number[] = [];
                            for (let i = 0; i < metadata.vector_blob.length; i += 4) {
                                vector.push(metadata.vector_blob.readFloatLE(i));
                            }
                            const vectorString = `[${vector.join(',')}]`;
                            stmtVec.run(metadata.embedding_id, vectorString);
                        }
                    } catch (error) {
                        console.error(`Error inserting embedding ${metadata.embedding_id}:`, error);
                        // Continue with other records
                    }
                }
            });

            await transaction(embeddings);
        }, 'bulkInsertEmbeddings');
    }

    public async updateFileHashForEmbedding(embeddingId: string, newFileHash: string): Promise<void> {
        await this._executeWithRetry(() => {
            const sql = `UPDATE ${this.metadataTable} SET file_hash = ? WHERE embedding_id = ?`;
            this.db.prepare(sql).run(newFileHash, embeddingId);
        }, 'updateFileHashForEmbedding');
    }

    public async getEmbeddingsForFile(filePathRelative: string, agentId?: string): Promise<CodebaseEmbeddingRecord[]> {
        return this._executeWithRetry(() => {
            let sql = `SELECT * FROM ${this.metadataTable} WHERE file_path_relative = ?`;
            const params: (string | undefined)[] = [filePathRelative];

            if (agentId) {
                sql += ` AND agent_id = ?`;
                params.push(agentId);
            }

            const stmt = this.db.prepare(sql);
            return stmt.all(...params) as CodebaseEmbeddingRecord[];
        }, 'getEmbeddingsForFile');
    }

    public async getChunkHashesForFile(filePathRelative: string): Promise<{
        hashes: Set<string>;
        latencyMs: number;
        callCount: number;
        error?: string
    }> {
        const startTime = Date.now();

        try {
            const result = await this._executeWithRetry(() => {
                const sql = `SELECT chunk_hash FROM ${this.metadataTable} WHERE file_path_relative = ? AND chunk_hash IS NOT NULL`;
                const stmt = this.db.prepare(sql);
                const rows = stmt.all(filePathRelative) as { chunk_hash: string }[];
                const hashes = new Set(rows.map(row => row.chunk_hash));

                return { hashes, latencyMs: Date.now() - startTime, callCount: 1 };
            }, 'getChunkHashesForFile');

            return result;
        } catch (error) {
            console.error(`Error getting chunk hashes for file ${filePathRelative}:`, error);
            return {
                hashes: new Set(),
                latencyMs: Date.now() - startTime,
                callCount: 1,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    public async bulkDeleteEmbeddings(embeddingIds: string[]): Promise<void> {
        if (embeddingIds.length === 0) return;

        await this._executeWithRetry(async () => {
            const transaction = this.db.transaction((ids: string[]) => {
                if (ids.length === 0) return;

                const placeholders = ids.map(() => '?').join(',');

                // Delete from vector table first (foreign key constraint)
                try {
                    const vecStmt = this.db.prepare(
                        `DELETE FROM ${this.vectorTable} WHERE embedding_id IN (${placeholders})`
                    );
                    vecStmt.run(...ids);
                } catch (error) {
                    console.error('Error deleting from vector table:', error);
                }

                // Delete from metadata table
                try {
                    const metaStmt = this.db.prepare(
                        `DELETE FROM ${this.metadataTable} WHERE embedding_id IN (${placeholders})`
                    );
                    metaStmt.run(...ids);
                } catch (error) {
                    console.error('Error deleting from metadata table:', error);
                }
            });

            await transaction(embeddingIds);
        }, 'bulkDeleteEmbeddings');
    }

    public async getLatestFileHashes(agentId: string): Promise<Map<string, string>> {
        try {
            return await this._executeWithRetry(() => {
                const sql = `
                    SELECT file_path_relative, file_hash
                    FROM ${this.metadataTable} 
                    WHERE (file_path_relative, created_timestamp_unix) IN (
                        SELECT file_path_relative, MAX(created_timestamp_unix)
                        FROM ${this.metadataTable}
                        WHERE agent_id = ?
                        GROUP BY file_path_relative
                    )
                    AND agent_id = ?;
                `;

                const stmt = this.db.prepare(sql);
                const rows = stmt.all(agentId, agentId) as { file_path_relative: string, file_hash: string }[];
                return new Map(rows.map(row => [row.file_path_relative, row.file_hash]));
            }, 'getLatestFileHashes');
        } catch (error) {
            console.error(`Error getting latest file hashes for agent ${agentId}:`, error);
            return new Map();
        }
    }

    public async getAllFilePathsForAgent(agentId: string): Promise<string[]> {
        try {
            return await this._executeWithRetry(() => {
                const sql = `SELECT DISTINCT file_path_relative FROM ${this.metadataTable} WHERE agent_id = ?`;
                const stmt = this.db.prepare(sql);
                const rows = stmt.all(agentId) as { file_path_relative: string }[];
                return rows.map(row => row.file_path_relative);
            }, 'getAllFilePathsForAgent');
        } catch (error) {
            console.error(`Error getting all file paths for agent ${agentId}:`, error);
            return [];
        }
    }

    public async getAvailableEmbeddingModels(agentId?: string): Promise<string[]> {
        return this._executeWithRetry(() => {
            let sql = `SELECT DISTINCT model_name FROM ${this.metadataTable}`;
            const params: string[] = [];
            if (agentId) {
                sql += ` WHERE agent_id = ?`;
                params.push(agentId);
            }
            const stmt = this.db.prepare(sql);
            const rows = stmt.all(...params) as { model_name: string }[];
            return rows.map(row => row.model_name);
        }, 'getAvailableEmbeddingModels');
    }

    public async findSimilarEmbeddingsWithMetadata(
        queryEmbedding: number[],
        queryText: string,
        topK: number,
        agentId?: string,
        targetFilePaths?: string[],
        excludeChunkTypes?: string[],
        model?: string // Add model parameter
    ): Promise<Array<CodebaseEmbeddingRecord & { similarity: number }>> {
        try {
            // Step 1: Perform Vector Search to find the most relevant chunks.
            // We fetch more than topK initially to ensure we have enough candidates after filtering.
            const vecResults = await this._executeWithRetry(async () => {
                return await findSimilarVecEmbeddings(queryEmbedding, topK * 5, this.vectorTable);
            }, 'findSimilarVecEmbeddings');

            if (!vecResults || vecResults.length === 0) {
                return [];
            }

            const embeddingIds = vecResults.map(r => r.embedding_id);
            const similarityMap = new Map(vecResults.map(r => [r.embedding_id, r.similarity]));

            // Step 2: Fetch full metadata for the top chunks, applying filters.
            const placeholders = embeddingIds.map(() => '?').join(',');
            let sql = `SELECT * FROM ${this.metadataTable} WHERE embedding_id IN (${placeholders})`;
            const params: (string | number)[] = [...embeddingIds];

            if (agentId) {
                sql += ` AND agent_id = ?`;
                params.push(agentId);
            }

            if (targetFilePaths && targetFilePaths.length > 0) {
                sql += ` AND file_path_relative IN (${targetFilePaths.map(() => '?').join(',')})`;
                params.push(...targetFilePaths);
            }

            if (excludeChunkTypes && excludeChunkTypes.length > 0) {
                sql += ` AND embedding_type NOT IN (${excludeChunkTypes.map(() => '?').join(',')})`;
                params.push(...excludeChunkTypes);
            }

            if (model) { // Add model filter
                sql += ` AND model_name = ?`;
                params.push(model);
            }

            const metadataRows = await this._executeWithRetry(() => {
                const stmt = this.db.prepare(sql);
                return stmt.all(...params) as CodebaseEmbeddingRecord[];
            }, 'fetchFilteredMetadata');

            // Step 3: Combine metadata with similarity scores.
            const results = metadataRows.map(meta => ({
                ...meta,
                similarity: similarityMap.get(meta.embedding_id) || 0,
            }));

            // Step 4: Re-rank results based on keyword and entity name matching.
            const queryTokens = new Set(queryText.toLowerCase().split(/\s+/).filter(t => t.length > 2));
            results.forEach(result => {
                let rerankScore = result.similarity;

                // Boost for exact entity name match in query
                if (result.entity_name && queryText.toLowerCase().includes(result.entity_name.toLowerCase())) {
                    rerankScore += 0.15;
                }

                // Boost for keyword overlap in chunk text
                if (queryTokens.size > 0 && result.chunk_text) {
                    const chunkTokens = new Set(result.chunk_text.toLowerCase().split(/\s+/));
                    const overlap = [...queryTokens].filter(token => chunkTokens.has(token));
                    const overlapBonus = (overlap.length / queryTokens.size) * 0.1; // Max 0.1 bonus
                    rerankScore += overlapBonus;
                }

                // Update similarity to be the re-ranked score
                result.similarity = Math.min(1.0, rerankScore); // Cap similarity at 1.0
            });

            // Sort by the new re-ranked similarity and return the top K results.
            results.sort((a, b) => b.similarity - a.similarity);

            return results.slice(0, topK);

        } catch (error) {
            console.error('Error in findSimilarEmbeddingsWithMetadata:', error);
            throw error;
        }
    }

    public async getEmbeddingStatistics(agentId: string): Promise<{
        totalEmbeddings: number;
        embeddingsByType: Record<string, number>;
        embeddingsByFile: Record<string, number>;
        averageChunkSize: number;
        totalFiles: number;
    }> {
        try {
            return await this._executeWithRetry(() => {
                // Total embeddings count
                const totalQuery = `SELECT COUNT(*) as count FROM ${this.metadataTable} WHERE agent_id = ?`;
                const totalResult = this.db.prepare(totalQuery).get(agentId) as { count: number };

                // Embeddings by type
                const typeQuery = `SELECT embedding_type, COUNT(*) as count FROM ${this.metadataTable} WHERE agent_id = ? GROUP BY embedding_type`;
                const typeResults = this.db.prepare(typeQuery).all(agentId) as { embedding_type: string, count: number }[];
                const embeddingsByType = typeResults.reduce((acc, { embedding_type, count }) => {
                    acc[embedding_type] = count;
                    return acc;
                }, {} as Record<string, number>);

                // Embeddings by file
                const fileQuery = `SELECT file_path_relative, COUNT(*) as count FROM ${this.metadataTable} WHERE agent_id = ? GROUP BY file_path_relative`;
                const fileResults = this.db.prepare(fileQuery).all(agentId) as { file_path_relative: string, count: number }[];
                const embeddingsByFile = fileResults.reduce((acc, { file_path_relative, count }) => {
                    acc[file_path_relative] = count;
                    return acc;
                }, {} as Record<string, number>);

                // Average chunk size
                const sizeQuery = `SELECT AVG(LENGTH(chunk_text)) as avg_size FROM ${this.metadataTable} WHERE agent_id = ?`;
                const sizeResult = this.db.prepare(sizeQuery).get(agentId) as { avg_size: number };

                // Total unique files
                const fileCountQuery = `SELECT COUNT(DISTINCT file_path_relative) as count FROM ${this.metadataTable} WHERE agent_id = ?`;
                const fileCountResult = this.db.prepare(fileCountQuery).get(agentId) as { count: number };

                return {
                    totalEmbeddings: totalResult.count,
                    embeddingsByType,
                    embeddingsByFile,
                    averageChunkSize: Math.round(sizeResult.avg_size || 0),
                    totalFiles: fileCountResult.count
                };
            }, 'getEmbeddingStatistics');
        } catch (error) {
            console.error(`Error getting embedding statistics for agent ${agentId}:`, error);
            throw error;
        }
    }

    public async getEmbeddingsByIds(embeddingIds: string[]): Promise<CodebaseEmbeddingRecord[]> {
        if (embeddingIds.length === 0) {
            return [];
        }

        return this._executeWithRetry(() => {
            const placeholders = embeddingIds.map(() => '?').join(',');
            const sql = `SELECT * FROM ${this.metadataTable} WHERE embedding_id IN (${placeholders})`;
            const stmt = this.db.prepare(sql);
            return stmt.all(...embeddingIds) as CodebaseEmbeddingRecord[];
        }, 'getEmbeddingsByIds');
    }

    public async optimizeDatabase(): Promise<void> {
        try {
            await this._executeWithRetry(async () => {
                // Run ANALYZE to update statistics
                this.db.exec('ANALYZE');

                // Rebuild indexes if needed
                this.db.exec('REINDEX');

                // Vacuum to optimize database file
                this.db.exec('VACUUM');
            }, 'optimizeDatabase');

            console.log('Database optimization completed successfully');
        } catch (error) {
            console.error('Error optimizing database:', error);
            throw error;
        }
    }
}