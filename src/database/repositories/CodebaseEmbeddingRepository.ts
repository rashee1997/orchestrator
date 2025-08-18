// src/database/repositories/CodebaseEmbeddingRepository.ts
import { Database } from 'better-sqlite3';
import { CodebaseEmbeddingRecord } from '../../types/codebase_embeddings.js';
import { findSimilarVecEmbeddings } from '../vector_db.js';

export class CodebaseEmbeddingRepository {
    private db: Database;
    private vectorTable: string = 'codebase_embeddings_vec_idx';
    private metadataTable: string = 'codebase_embeddings';

    constructor(db: Database) {
        this.db = db;
    }

    public async bulkInsertEmbeddings(embeddings: CodebaseEmbeddingRecord[]): Promise<void> {
        if (embeddings.length === 0) return;
        const insertMetadataSql = `INSERT OR REPLACE INTO ${this.metadataTable} (
            embedding_id, agent_id, chunk_text, entity_name, model_name, chunk_hash, file_hash, 
            metadata_json, created_timestamp_unix, file_path_relative, full_file_path, 
            ai_summary_text, vector_dimensions, embedding_type, parent_embedding_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        const insertVecSql = `INSERT OR REPLACE INTO ${this.vectorTable} (embedding_id, embedding) VALUES (?, ?);`;

        const insertTransaction = this.db.transaction((records: CodebaseEmbeddingRecord[]) => {
            const stmtMetadata = this.db.prepare(insertMetadataSql);
            const stmtVec = this.db.prepare(insertVecSql);

            for (const metadata of records) {
                stmtMetadata.run(
                    metadata.embedding_id,
                    metadata.agent_id,
                    metadata.chunk_text,
                    metadata.entity_name,
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

                const vector: number[] = [];
                for (let i = 0; i < metadata.vector_blob.length; i += 4) {
                    vector.push(metadata.vector_blob.readFloatLE(i));
                }
                const vectorString = `[${vector.join(',')}]`;
                stmtVec.run(metadata.embedding_id, vectorString);
            }
        });
        try {
            insertTransaction(embeddings);
        } catch (error) {
            console.error(`[CodebaseEmbeddingRepository] Error bulk inserting embeddings:`, error);
            throw error;
        }
    }

    public async getEmbeddingsForFile(filePathRelative: string, agentId?: string): Promise<CodebaseEmbeddingRecord[]> {
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

    public async bulkDeleteEmbeddings(embeddingIds: string[]): Promise<void> {
        if (embeddingIds.length === 0) return;
        const deleteTransaction = this.db.transaction((ids: string[]) => {
            const placeholders = ids.map(() => '?').join(',');
            // Must delete from the virtual table using rowid
            this.db.prepare(`DELETE FROM ${this.vectorTable} WHERE rowid IN (SELECT rowid FROM ${this.vectorTable} WHERE embedding_id IN (${placeholders}))`).run(...ids);
            this.db.prepare(`DELETE FROM ${this.metadataTable} WHERE embedding_id IN (${placeholders})`).run(...ids);
        });
        try {
            deleteTransaction(embeddingIds);
        } catch (error) {
            console.error(`[CodebaseEmbeddingRepository] Error bulk deleting embeddings:`, error);
            throw error;
        }
    }

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

    public async getAllFilePathsForAgent(agentId: string): Promise<string[]> {
        const sql = `SELECT DISTINCT file_path_relative FROM ${this.metadataTable} WHERE agent_id = ?`;
        try {
            const rows = this.db.prepare(sql).all(agentId) as { file_path_relative: string }[];
            return rows.map(row => row.file_path_relative);
        } catch (error) {
            console.error(`[CodebaseEmbeddingRepository] Error getting all file paths for agent ${agentId}:`, error);
            return [];
        }
    }

    /**
     * MODIFICATION: This is the new core retrieval logic implementing Hybrid Retrieval.
     * It combines the "Parent Document" (Top-Down) strategy with a direct search (Bottom-Up).
     */
    public async findSimilarEmbeddingsWithMetadata(
        queryEmbedding: number[],
        queryText: string,
        topK: number,
        agentId?: string,
        targetFilePaths?: string[],
        excludeChunkTypes?: string[]
    ): Promise<Array<CodebaseEmbeddingRecord & { similarity: number }>> {

        // --- Step 1: Perform Vector Search, applying pre-filters if possible ---
        const vecResults = await findSimilarVecEmbeddings(queryEmbedding, topK * 5, this.vectorTable); // Fetch more initially
        const embeddingIds = vecResults.map(r => r.embedding_id);
        if (embeddingIds.length === 0) return [];
        
        const similarityMap = new Map(vecResults.map(r => [r.embedding_id, r.similarity]));
        const placeholders = embeddingIds.map(() => '?').join(',');

        // --- Step 2: Fetch Metadata and Apply Post-filters ---
        let sql = `SELECT * FROM ${this.metadataTable} WHERE embedding_id IN (${placeholders})`;
        const params: (string|number)[] = [...embeddingIds];

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

        const filteredMetaRows = this.db.prepare(sql).all(...params) as CodebaseEmbeddingRecord[];
        
        // --- Step 3: Hybrid Retrieval Logic (Parent Document Expansion) ---
        const parentIdsToFetch = new Set<string>();
        const directChunkResults = new Map<string, CodebaseEmbeddingRecord & { similarity: number }>();

        for (const meta of filteredMetaRows) {
            const similarity = similarityMap.get(meta.embedding_id)!;
            if (meta.embedding_type === 'summary') {
                parentIdsToFetch.add(meta.embedding_id);
            } else if (meta.embedding_type === 'chunk') {
                directChunkResults.set(meta.embedding_id, { ...meta, similarity });
                if (meta.parent_embedding_id) {
                    parentIdsToFetch.add(meta.parent_embedding_id);
                }
            }
        }

        let childChunksOfTopParents: (CodebaseEmbeddingRecord & { similarity: number })[] = [];
        if (parentIdsToFetch.size > 0) {
            const parentPlaceholders = Array.from(parentIdsToFetch).map(() => '?').join(',');
            let childSql = `SELECT * FROM ${this.metadataTable} WHERE parent_embedding_id IN (${parentPlaceholders}) AND embedding_type = 'chunk'`;
            const childParams = [...parentIdsToFetch];
            if (agentId) {
                childSql += ` AND agent_id = ?`;
                childParams.push(agentId);
            }
            const chunks = this.db.prepare(childSql).all(...childParams) as CodebaseEmbeddingRecord[];
            childChunksOfTopParents = chunks.map(child => ({
                ...child,
                similarity: similarityMap.get(child.parent_embedding_id!) || 0.5 // Assign parent's score or a default
            }));
        }

        // --- Step 4: Combine, De-duplicate, and Re-rank ---
        const combinedResultsMap = new Map<string, CodebaseEmbeddingRecord & { similarity: number }>();
        const allResults = [...childChunksOfTopParents, ...Array.from(directChunkResults.values())];

        for (const result of allResults) {
            const existing = combinedResultsMap.get(result.embedding_id);
            if (!existing || result.similarity > existing.similarity) {
                combinedResultsMap.set(result.embedding_id, result);
            }
        }
        
        const finalRankedResults = Array.from(combinedResultsMap.values()).map(meta => {
            let finalScore = meta.similarity;
            if (meta.entity_name && queryText) {
                const queryWords = new Set(queryText.toLowerCase().split(/[\s_-]+/).filter(w => w.length > 3));
                if (queryWords.size > 0) {
                    const entityWords = meta.entity_name.toLowerCase().replace(/_/g, ' ').split(/\s+/);
                    if (entityWords.some(ew => queryWords.has(ew))) {
                        finalScore *= 1.15; // 15% boost
                    }
                }
            }
            return { ...meta, finalScore };
        });

        finalRankedResults.sort((a, b) => b.finalScore - a.finalScore);
        return finalRankedResults.slice(0, topK);
    }

    private async findSimilarParentSummaries(
        queryEmbedding: number[],
        topK: number,
        agentId?: string
    ): Promise<Array<{ embedding_id: string; similarity: number }>> {
        const vecResults = await findSimilarVecEmbeddings(queryEmbedding, topK * 5, this.vectorTable); // Fetch more initially
        
        const embeddingIds = vecResults.map(r => r.embedding_id);
        if (embeddingIds.length === 0) return [];
        
        const placeholders = embeddingIds.map(() => '?').join(',');
        let sql = `SELECT embedding_id FROM ${this.metadataTable} WHERE embedding_id IN (${placeholders}) AND embedding_type = 'summary'`;
        const params: (string)[] = [...embeddingIds];

        if (agentId) {
            sql += ` AND agent_id = ?`;
            params.push(agentId);
        }

        const summaryRows = this.db.prepare(sql).all(...params) as { embedding_id: string }[];
        const summaryIds = new Set(summaryRows.map(r => r.embedding_id));

        return vecResults.filter(r => summaryIds.has(r.embedding_id)).slice(0, topK);
    }

    private async findSimilarChildChunksDirectly(
        queryEmbedding: number[],
        topK: number,
        agentId?: string
    ): Promise<Array<CodebaseEmbeddingRecord & { similarity: number }>> {
        const vecResults = await findSimilarVecEmbeddings(queryEmbedding, topK * 5, this.vectorTable); // Fetch more initially

        const embeddingIds = vecResults.map(r => r.embedding_id);
        if (embeddingIds.length === 0) return [];

        const similarityMap = new Map(vecResults.map(r => [r.embedding_id, r.similarity]));
        const placeholders = embeddingIds.map(() => '?').join(',');
        
        let sql = `SELECT * FROM ${this.metadataTable} WHERE embedding_id IN (${placeholders}) AND embedding_type = 'chunk'`;
        const params: (string)[] = [...embeddingIds];
        
        if (agentId) {
            sql += ` AND agent_id = ?`;
            params.push(agentId);
        }

        const chunkRows = this.db.prepare(sql).all(...params) as CodebaseEmbeddingRecord[];
        
        return chunkRows.map(row => ({
            ...row,
            similarity: similarityMap.get(row.embedding_id) || 0
        })).slice(0, topK);
    }
}
