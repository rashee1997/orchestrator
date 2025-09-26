import { Database } from 'better-sqlite3';
import { CodebaseEmbeddingRecord } from '../../types/codebase_embeddings.js';
import { executeWithRetry } from './CodebaseEmbeddingRepository.helpers.retry.js';

export class CodebaseEmbeddingReadRepository {
  private readonly db: Database;
  private readonly metadataTable = 'codebase_embeddings';
  private readonly maxRetries = 3;
  private readonly retryDelay = 1000;

  constructor(db: Database) {
    this.db = db;
  }

  public async getEmbeddingsForFile(filePathRelative: string, agentId?: string): Promise<CodebaseEmbeddingRecord[]> {
    return executeWithRetry(
      () => {
        let sql = `SELECT * FROM ${this.metadataTable} WHERE file_path_relative = ?`;
        const params: (string | undefined)[] = [filePathRelative];
        if (agentId) {
          sql += ` AND agent_id = ?`;
          params.push(agentId);
        }
        const stmt = this.db.prepare(sql);
        return stmt.all(...params) as CodebaseEmbeddingRecord[];
      },
      { opName: 'getEmbeddingsForFile', maxRetries: this.maxRetries, retryDelay: this.retryDelay }
    );
  }

  public async getChunkHashesForFile(filePathRelative: string): Promise<{ hashes: Set<string>; latencyMs: number; callCount: number; error?: string }> {
    const startTime = Date.now();
    try {
      const result = await executeWithRetry(
        () => {
          const sql = `SELECT chunk_hash FROM ${this.metadataTable} WHERE file_path_relative = ? AND chunk_hash IS NOT NULL`;
          const stmt = this.db.prepare(sql);
          const rows = stmt.all(filePathRelative) as { chunk_hash: string }[];
          const hashes = new Set(rows.map((row) => row.chunk_hash));
          return { hashes, latencyMs: Date.now() - startTime, callCount: 1 };
        },
        { opName: 'getChunkHashesForFile', maxRetries: this.maxRetries, retryDelay: this.retryDelay }
      );
      return result;
    } catch (error: any) {
      return { hashes: new Set(), latencyMs: Date.now() - startTime, callCount: 1, error: error?.message ?? String(error) };
    }
  }

  public async getLatestFileHashes(agentId: string): Promise<Map<string, string>> {
    try {
      return await executeWithRetry(
        () => {
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
          const rows = stmt.all(agentId, agentId) as { file_path_relative: string; file_hash: string }[];
          return new Map(rows.map((row) => [row.file_path_relative, row.file_hash]));
        },
        { opName: 'getLatestFileHashes', maxRetries: this.maxRetries, retryDelay: this.retryDelay }
      );
    } catch {
      return new Map();
    }
  }

  public async getAllFilePathsForAgent(agentId: string): Promise<string[]> {
    return executeWithRetry(
      () => {
        const sql = `SELECT DISTINCT file_path_relative FROM ${this.metadataTable} WHERE agent_id = ?`;
        const stmt = this.db.prepare(sql);
        const rows = stmt.all(agentId) as { file_path_relative: string }[];
        return rows.map((row) => row.file_path_relative);
      },
      { opName: 'getAllFilePathsForAgent', maxRetries: this.maxRetries, retryDelay: this.retryDelay }
    );
  }

  public async getAllEntityNames(agentId: string): Promise<string[]> {
    return executeWithRetry(
      () => {
        const sql = `
          SELECT DISTINCT entity_name
          FROM ${this.metadataTable}
          WHERE agent_id = ? AND entity_name IS NOT NULL AND entity_name != ''
          ORDER BY entity_name
        `;
        const stmt = this.db.prepare(sql);
        const rows = stmt.all(agentId) as { entity_name: string }[];
        return rows.map((row) => row.entity_name);
      },
      { opName: 'getAllEntityNames', maxRetries: this.maxRetries, retryDelay: this.retryDelay }
    );
  }

  public async getAvailableEmbeddingModels(agentId?: string): Promise<string[]> {
    return executeWithRetry(
      () => {
        let sql = `SELECT DISTINCT model_name FROM ${this.metadataTable}`;
        const params: string[] = [];
        if (agentId) {
          sql += ` WHERE agent_id = ?`;
          params.push(agentId);
        }
        const stmt = this.db.prepare(sql);
        const rows = stmt.all(...params) as { model_name: string }[];
        return rows.map((row) => row.model_name);
      },
      { opName: 'getAvailableEmbeddingModels', maxRetries: this.maxRetries, retryDelay: this.retryDelay }
    );
  }

  public async getEmbeddingsByIds(embeddingIds: string[]): Promise<CodebaseEmbeddingRecord[]> {
    if (embeddingIds.length === 0) return [];
    return executeWithRetry(
      () => {
        const placeholders = embeddingIds.map(() => '?').join(',');
        const sql = `SELECT * FROM ${this.metadataTable} WHERE embedding_id IN (${placeholders})`;
        const stmt = this.db.prepare(sql);
        return stmt.all(...embeddingIds) as CodebaseEmbeddingRecord[];
      },
      { opName: 'getEmbeddingsByIds', maxRetries: this.maxRetries, retryDelay: this.retryDelay }
    );
  }

  public async optimizeDatabase(): Promise<void> {
    await executeWithRetry(
      () => {
        this.db.exec('ANALYZE');
        this.db.exec('REINDEX');
        this.db.exec('VACUUM');
      },
      { opName: 'optimizeDatabase', maxRetries: this.maxRetries, retryDelay: this.retryDelay }
    );
  }
}