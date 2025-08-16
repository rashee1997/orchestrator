import { Database } from 'better-sqlite3';
import { CodebaseEmbeddingRecord } from '../../types/codebase_embeddings.js';
import { storeVecEmbedding, findSimilarVecEmbeddings } from '../vector_db.js';

export class CodebaseEmbeddingRepository {
    private db: Database;
    private vectorTable: string = 'codebase_embeddings_vec_idx';
    private metadataTable: string = 'codebase_embeddings';

    constructor(db: Database) {
        this.db = db;
    }

    public async insertEmbedding(metadata: CodebaseEmbeddingRecord): Promise<void> {
        console.log(`[CodebaseEmbeddingRepository] Attempting to insert embedding with ID: ${metadata.embedding_id}`);
        try {
            const insertTransaction = this.db.transaction(() => {
                const columns = Object.keys(metadata).filter(k => k !== 'vector_blob');
                const placeholders = columns.map(() => '?').join(',');
                const sql = `INSERT OR REPLACE INTO ${this.metadataTable} (${columns.join(',')}) VALUES (${placeholders})`;
                console.log(`[CodebaseEmbeddingRepository] Inserting metadata into ${this.metadataTable} for ID: ${metadata.embedding_id}`);
                this.db.prepare(sql).run(...columns.map(k => (metadata as any)[k]));
                console.log(`[CodebaseEmbeddingRepository] Successfully inserted metadata for ID: ${metadata.embedding_id}`);
                const vector: number[] = [];
                for (let i = 0; i < metadata.vector_blob.length; i += 4) {
                    vector.push(metadata.vector_blob.readFloatLE(i));
                }
                console.log(`[CodebaseEmbeddingRepository] Preparing to store vector for ID: ${metadata.embedding_id}`);
                storeVecEmbedding(metadata.embedding_id, vector, this.vectorTable);
                console.log(`[CodebaseEmbeddingRepository] Successfully stored vector for ID: ${metadata.embedding_id}`);
                console.log(`[CodebaseEmbeddingRepository] Embedding insertion complete for ID: ${metadata.embedding_id}`);
            });
            insertTransaction();
        } catch (error) {
            console.error(`[CodebaseEmbeddingRepository] Error inserting embedding with ID ${metadata.embedding_id}:`, error);
            throw error; // Re-throw the error so EmbeddingCache can catch it
        }
    }

    public async bulkInsertEmbeddings(embeddings: CodebaseEmbeddingRecord[]): Promise<void> {
        if (embeddings.length === 0) return;
        const insertMetadataSql = `INSERT OR REPLACE INTO ${this.metadataTable} (
            embedding_id, agent_id, chunk_text, entity_name, model_name, chunk_hash, file_hash, metadata_json, created_timestamp_unix, file_path_relative, full_file_path, ai_summary_text, vector_dimensions
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`; // MODIFICATION: Added file_hash and vector_dimensions
        const insertVectorSql = `INSERT OR REPLACE INTO ${this.vectorTable} (embedding_id, embedding) VALUES (?, ?);`;
        const insertTransaction = this.db.transaction((records: CodebaseEmbeddingRecord[]) => {
            const stmtMetadata = this.db.prepare(insertMetadataSql);
            const stmtVector = this.db.prepare(insertVectorSql);
            for (const metadata of records) {
                stmtMetadata.run(
                    metadata.embedding_id,
                    metadata.agent_id,
                    metadata.chunk_text,
                    metadata.entity_name,
                    metadata.model_name,
                    metadata.chunk_hash,
                    metadata.file_hash, // MODIFICATION: Bind file_hash
                    metadata.metadata_json,
                    metadata.created_timestamp_unix,
                    metadata.file_path_relative,
                    metadata.full_file_path,
                    metadata.ai_summary_text,
                    metadata.vector_dimensions // MODIFICATION: Bind vector_dimensions
                );
                const vector: number[] = [];
                for (let i = 0; i < metadata.vector_blob.length; i += 4) {
                    vector.push(metadata.vector_blob.readFloatLE(i));
                }
                // Convert the vector array to a string representation for sqlite-vec
                const vectorString = `[${vector.join(',')}]`;
                stmtVector.run(metadata.embedding_id, vectorString);
            }
        });
        try {
            insertTransaction(embeddings);
            console.log(`[CodebaseEmbeddingRepository] Successfully bulk inserted ${embeddings.length} embeddings.`);
            this.db.pragma('wal_checkpoint(FULL)'); // Force a checkpoint to ensure data is written to disk
            console.log(`[CodebaseEmbeddingRepository] WAL checkpoint performed after bulk insert.`);
        } catch (error) {
            console.error(`[CodebaseEmbeddingRepository] Error bulk inserting embeddings:`, error);
            throw error;
        }
    }

    public async fetchMetadataByIds(embeddingIds: string[]): Promise<CodebaseEmbeddingRecord[]> {
        if (embeddingIds.length === 0) return [];
        const placeholders = embeddingIds.map(() => '?').join(',');
        const sql = `SELECT * FROM ${this.metadataTable} WHERE embedding_id IN (${placeholders})`;
        return this.db.prepare(sql).all(...embeddingIds) as CodebaseEmbeddingRecord[];
    }

    public async getEmbeddingsForFile(filePathRelative: string, agentId?: string): Promise<CodebaseEmbeddingRecord[]> {
        // Use exact matching instead of LIKE for more precise file path matching
        let sql = `SELECT * FROM ${this.metadataTable} WHERE file_path_relative = ?`;
        const params: (string | undefined)[] = [filePathRelative];
        if (agentId) {
            sql += ` AND agent_id = ?`;
            params.push(agentId);
        }
        return this.db.prepare(sql).all(...params) as CodebaseEmbeddingRecord[];
    }

    public async getChunkHashesForFile(filePathRelative: string): Promise<{ hashes: Set<string>; latencyMs: number; callCount: number }> {
        const startTime = Date.now();
        const sql = `SELECT chunk_hash FROM ${this.metadataTable} WHERE file_path_relative = ? AND chunk_hash IS NOT NULL`;
        const rows = this.db.prepare(sql).all(filePathRelative) as { chunk_hash: string }[];
        const endTime = Date.now();
        return { hashes: new Set(rows.map(row => row.chunk_hash)), latencyMs: endTime - startTime, callCount: 1 };
    }

    public async deleteEmbedding(embeddingId: string): Promise<void> {
        this.db.prepare(`DELETE FROM ${this.vectorTable} WHERE embedding_id = ?`).run(embeddingId);
        this.db.prepare(`DELETE FROM ${this.metadataTable} WHERE embedding_id = ?`).run(embeddingId);
    }

    public async bulkDeleteEmbeddings(embeddingIds: string[]): Promise<void> {
        if (embeddingIds.length === 0) return;
        const deleteTransaction = this.db.transaction((ids: string[]) => {
            const placeholders = ids.map(() => '?').join(',');
            this.db.prepare(`DELETE FROM ${this.vectorTable} WHERE embedding_id IN (${placeholders})`).run(...ids);
            this.db.prepare(`DELETE FROM ${this.metadataTable} WHERE embedding_id IN (${placeholders})`).run(...ids);
        });
        try {
            deleteTransaction(embeddingIds);
            console.log(`[CodebaseEmbeddingRepository] Successfully bulk deleted ${embeddingIds.length} embeddings.`);
            this.db.pragma('wal_checkpoint(FULL)'); // Force a checkpoint to ensure data is written to disk
            console.log(`[CodebaseEmbeddingRepository] WAL checkpoint performed.`);
        } catch (error) {
            console.error(`[CodebaseEmbeddingRepository] Error bulk deleting embeddings:`, error);
            throw error;
        }
    }

    public async getExistingEmbeddingByHash(chunkHash: string): Promise<CodebaseEmbeddingRecord | null> {
        const sql = `SELECT * FROM ${this.metadataTable} WHERE chunk_hash = ?`;
        return (this.db.prepare(sql).get(chunkHash) as CodebaseEmbeddingRecord) || null;
    }

    public async getExistingSummaryByHash(originalCodeHash: string): Promise<{ summary: string | null; latencyMs: number; callCount: number }> {
        const startTime = Date.now();
        const sql = `SELECT ai_summary_text FROM ${this.metadataTable} WHERE json_extract(metadata_json, '$.original_code_hash') = ? AND ai_summary_text IS NOT NULL`;
        const result: any = this.db.prepare(sql).get(originalCodeHash);
        const endTime = Date.now();
        return { summary: result ? result.ai_summary_text : null, latencyMs: endTime - startTime, callCount: 1 };
    }

    public async getAllFilePathsForAgent(agentId: string): Promise<string[]> {
        const sql = `SELECT DISTINCT file_path_relative FROM ${this.metadataTable} WHERE agent_id = ?`;
        const rows = this.db.prepare(sql).all(agentId) as { file_path_relative: string }[];
        return rows.map(row => row.file_path_relative);
    }

    /**
     * MODIFICATION: New method to get the latest file hash for each file for an agent.
     * This is the cornerstone of the file-level idempotency check.
     * It efficiently retrieves the most recent hash for every file path stored in the database.
     */
    public async getLatestFileHashes(agentId: string): Promise<Map<string, string>> {
        const sql = `
            SELECT file_path_relative, file_hash
            FROM codebase_embeddings
            WHERE (file_path_relative, created_timestamp_unix) IN (
                SELECT file_path_relative, MAX(created_timestamp_unix)
                FROM codebase_embeddings
                WHERE agent_id = ?
                GROUP BY file_path_relative
            )
            AND agent_id = ?;
        `;
        try {
            const rows = this.db.prepare(sql).all(agentId, agentId) as { file_path_relative: string, file_hash: string }[];
            return new Map(rows.map(row => [row.file_path_relative, row.file_hash]));
        } catch (error) {
            console.error(`[CodebaseEmbeddingRepository] Error getting latest file hashes for agent ${agentId}:`, error);
            return new Map();
        }
    }



    /**
     * Finds semantically similar embeddings, re-ranks them based on heuristics,
     * and directly fetches their metadata, applying optional filters.
     * @param queryEmbedding The vector to find similar embeddings for.
     * @param queryText The original user query text for keyword boosting.
     * @param topK The number of similar embeddings to return.
     * @param agentId Optional: The ID of the agent to filter by.
     * @param targetFilePaths Optional: Array of relative file paths to boost in ranking.
     * @param excludeChunkTypes Optional: Array of chunk types to exclude from results.
     * @returns A promise that resolves to an array of similar embeddings with full metadata and similarity scores.
     */
    public async findSimilarEmbeddingsWithMetadata(
        queryEmbedding: number[],
        queryText: string,
        topK: number,
        agentId?: string,
        targetFilePaths?: string[],
        excludeChunkTypes?: string[]
    ): Promise<Array<CodebaseEmbeddingRecord & { similarity: number }>> {
        // Step 1: Find similar embeddings using the vector DB function
        // Fetch a larger pool of candidates to allow for effective re-ranking and filtering.
        const initialFetchK = topK * 10;
        const vecResults = await findSimilarVecEmbeddings(queryEmbedding, initialFetchK, this.vectorTable);
        if (vecResults.length === 0) {
            return [];
        }

        const embeddingIds = vecResults.map(r => r.embedding_id);
        const similarityMap = new Map<string, number>();
        vecResults.forEach(r => similarityMap.set(r.embedding_id, r.similarity));

        // Step 2: Fetch metadata for these embedding IDs with efficient SQL filtering
        const placeholders = embeddingIds.map(() => '?').join(',');
        const params: (string)[] = [...embeddingIds];
        let sql = `SELECT * FROM ${this.metadataTable} WHERE embedding_id IN (${placeholders})`;

        if (agentId) {
            sql += ` AND agent_id = ?`;
            params.push(agentId);
        }

        // MODIFICATION: Filter by chunk type directly in the database query
        if (excludeChunkTypes && excludeChunkTypes.length > 0) {
            const typePlaceholders = excludeChunkTypes.map(() => '?').join(',');
            sql += ` AND json_extract(metadata_json, '$.type') NOT IN (${typePlaceholders})`;
            params.push(...excludeChunkTypes);
        }

        const metadataRows = this.db.prepare(sql).all(...params) as CodebaseEmbeddingRecord[];

        // Step 3: Combine metadata with scores, apply re-ranking, and sort
        const combinedResults: Array<CodebaseEmbeddingRecord & { similarity: number; finalScore: number }> = [];
        const now_unix = Math.floor(Date.now() / 1000);
        const TIME_DECAY_LAMBDA = 0.005; // Smaller value = slower decay

        for (const meta of metadataRows) {
            const similarity = similarityMap.get(meta.embedding_id);
            if (similarity === undefined) continue;

            // --- Re-ranking Logic ---
            let finalScore = similarity;

            // 1. Boost for being in a target file path
            const FILE_PATH_BOOST = 1.25; // 25% score boost
            if (targetFilePaths && targetFilePaths.length > 0) {
                const normalizedMetaPath = meta.file_path_relative.replace(/\\/g, '/');
                const normalizedTargetPaths = targetFilePaths.map(p => p.replace(/\\/g, '/'));
                if (normalizedTargetPaths.some(p => normalizedMetaPath === p || normalizedMetaPath.endsWith('/' + p))) {
                    finalScore *= FILE_PATH_BOOST;
                }
            }

            // 2. Time-based decay (boost for recency)
            if (meta.created_timestamp_unix) {
                const age_in_days = Math.max(0, (now_unix - meta.created_timestamp_unix) / (60 * 60 * 24));
                // Recency boost gives up to 10% bonus, decaying over time
                const recencyBoost = 0.1 * Math.exp(-TIME_DECAY_LAMBDA * age_in_days);
                finalScore *= (1 + recencyBoost);
            }

            // 3. MODIFICATION: Keyword Matching Boost for Entity Names
            const KEYWORD_BOOST = 1.15; // 15% score boost
            if (meta.entity_name && queryText) {
                // Extract meaningful words from query (longer than 3 chars) to avoid common noise
                const queryWords = new Set(queryText.toLowerCase().split(/[\s_-]+/).filter(w => w.length > 3));
                if (queryWords.size > 0) {
                    const entityWords = meta.entity_name.toLowerCase().replace(/_/g, ' ').split(/\s+/);
                    if (entityWords.some(ew => queryWords.has(ew))) {
                        finalScore *= KEYWORD_BOOST;
                    }
                }
            }

            combinedResults.push({ ...meta, similarity, finalScore });
        }

        // Sort by the new finalScore in descending order
        combinedResults.sort((a, b) => b.finalScore - a.finalScore);

        // Return topK results, removing the temporary finalScore from the output object
        return combinedResults.slice(0, topK).map(({ finalScore, ...rest }) => rest);
    }

    public async findSimilarEmbeddings(queryEmbedding: number[], topK: number): Promise<Array<{ embedding_id: string; similarity: number }>> {
        return findSimilarVecEmbeddings(queryEmbedding, topK, this.vectorTable);
    }
}