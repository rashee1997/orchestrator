import { Database } from 'better-sqlite3';
import { CodebaseEmbeddingRecord } from '../../types/codebase_embeddings.js';
import { executeWithRetry } from './CodebaseEmbeddingRepository.helpers.retry.js';
import { processEmbeddingRecord } from './CodebaseEmbeddingRepository.helpers.vector.js';

export class CodebaseEmbeddingWriteRepository {
  private db: Database;
  private metadataTable = 'codebase_embeddings';
  private vectorTable = 'codebase_embeddings_vec_idx';
  private maxRetries = 3;
  private retryDelay = 1000;

  constructor(db: Database) {
    this.db = db;
  }

  public async bulkInsertEmbeddings(embeddings: CodebaseEmbeddingRecord[]): Promise<void> {
    if (embeddings.length === 0) return;

    const insertMetadataSql = `INSERT OR REPLACE INTO ${this.metadataTable} (
      embedding_id, agent_id, chunk_text, entity_name, entity_name_vector_blob, entity_name_vector_dimensions,
      model_name, chunk_hash, file_hash, metadata_json, created_timestamp_unix, file_path_relative,
      full_file_path, ai_summary_text, vector_dimensions, embedding_type, parent_embedding_id,
      embedding_provider, embedding_model_full_name, embedding_generation_method,
      embedding_request_id, embedding_quality_score, embedding_generation_timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    const insertVecSql = `INSERT OR REPLACE INTO ${this.vectorTable} (embedding_id, embedding) VALUES (?, ?);`;

    await executeWithRetry(
      async () => {
        const stmtMetadata = this.db.prepare(insertMetadataSql);
        const stmtVec = this.db.prepare(insertVecSql);

        const transaction = this.db.transaction((records: CodebaseEmbeddingRecord[]) => {
          for (const metadata of records) {
            processEmbeddingRecord(metadata, stmtMetadata, stmtVec);
          }
        });
        transaction(embeddings);
      },
      { opName: 'bulkInsertEmbeddings', maxRetries: this.maxRetries, retryDelay: this.retryDelay }
    );
  }

  public async updateFileHashForEmbedding(embeddingId: string, newFileHash: string): Promise<void> {
    await executeWithRetry(
      () => {
        const sql = `UPDATE ${this.metadataTable} SET file_hash = ? WHERE embedding_id = ?`;
        this.db.prepare(sql).run(newFileHash, embeddingId);
      },
      { opName: 'updateFileHashForEmbedding', maxRetries: this.maxRetries, retryDelay: this.retryDelay }
    );
  }

  public async bulkDeleteEmbeddings(embeddingIds: string[]): Promise<void> {
    if (embeddingIds.length === 0) return;

    await executeWithRetry(
      async () => {
        const transaction = this.db.transaction((ids: string[]) => {
          const placeholders = ids.map(() => '?').join(',');
          this.db.prepare(`DELETE FROM ${this.vectorTable} WHERE embedding_id IN (${placeholders})`).run(...ids);
          this.db.prepare(`DELETE FROM ${this.metadataTable} WHERE embedding_id IN (${placeholders})`).run(...ids);
        });
        transaction(embeddingIds);
      },
      { opName: 'bulkDeleteEmbeddings', maxRetries: this.maxRetries, retryDelay: this.retryDelay }
    );
  }
}