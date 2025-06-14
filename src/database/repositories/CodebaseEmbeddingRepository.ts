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
            embedding_id, agent_id, chunk_text, entity_name, model_name, chunk_hash, metadata_json, created_timestamp_unix, file_path_relative, full_file_path, ai_summary_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        const insertVectorSql = `INSERT OR REPLACE INTO ${this.vectorTable} (embedding_id, vector_blob, dimensions) VALUES (?, ?, ?)`;

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
                    metadata.metadata_json,
                    metadata.created_timestamp_unix,
                    metadata.file_path_relative,
                    metadata.full_file_path,
                    metadata.ai_summary_text
                );

                const vector: number[] = [];
                for (let i = 0; i < metadata.vector_blob.length; i += 4) {
                    vector.push(metadata.vector_blob.readFloatLE(i));
                }
                stmtVector.run(metadata.embedding_id, metadata.vector_blob, vector.length);
            }
        });

        try {
            insertTransaction(embeddings);
            console.log(`[CodebaseEmbeddingRepository] Successfully bulk inserted ${embeddings.length} embeddings.`);
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

    public async getEmbeddingsForFile(filePathRelative: string): Promise<CodebaseEmbeddingRecord[]> {
        const sql = `SELECT * FROM ${this.metadataTable} WHERE file_path_relative = ?`;
        return this.db.prepare(sql).all(filePathRelative) as CodebaseEmbeddingRecord[];
    }

    public async getChunkHashesForFile(filePathRelative: string): Promise<Set<string>> {
        const sql = `SELECT chunk_hash FROM ${this.metadataTable} WHERE file_path_relative = ? AND chunk_hash IS NOT NULL`;
        const rows = this.db.prepare(sql).all(filePathRelative) as { chunk_hash: string }[];
        return new Set(rows.map(row => row.chunk_hash));
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
        } catch (error) {
            console.error(`[CodebaseEmbeddingRepository] Error bulk deleting embeddings:`, error);
            throw error;
        }
    }

    public async getExistingEmbeddingByHash(chunkHash: string): Promise<CodebaseEmbeddingRecord | null> {
        const sql = `SELECT * FROM ${this.metadataTable} WHERE chunk_hash = ?`;
        return (this.db.prepare(sql).get(chunkHash) as CodebaseEmbeddingRecord) || null;
    }

    public async getExistingSummaryByHash(originalCodeHash: string): Promise<string | null> {
        const sql = `SELECT ai_summary_text FROM ${this.metadataTable} WHERE json_extract(metadata_json, '$.original_code_hash') = ? AND ai_summary_text IS NOT NULL`;
        const result: any = this.db.prepare(sql).get(originalCodeHash);
        return result ? result.ai_summary_text : null;
    }


    /**
     * Finds semantically similar embeddings to a given query vector.
     * @param queryEmbedding The vector to find similar embeddings for.
     * @param topK The number of similar embeddings to return.
     * @returns A promise that resolves to an array of similar embeddings with their IDs and similarity scores.
     */
    public async findSimilarEmbeddings(queryEmbedding: number[], topK: number): Promise<Array<{ embedding_id: string; similarity: number }>> {

        return findSimilarVecEmbeddings(queryEmbedding, topK, this.vectorTable);
    }
}
