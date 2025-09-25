import { Database } from 'better-sqlite3';

export class CodebaseEmbeddingStatsRepository {
  private db: Database;
  private metadataTable = 'codebase_embeddings';

  constructor(db: Database) {
    this.db = db;
  }

  public getEmbeddingStatistics(agentId: string): {
    totalEmbeddings: number;
    embeddingsByType: Record<string, number>;
    embeddingsByFile: Record<string, number>;
    averageChunkSize: number;
    totalFiles: number;
  } {
    const totalQuery = `SELECT COUNT(*) as count FROM ${this.metadataTable} WHERE agent_id = ?`;
    const totalResult = this.db.prepare(totalQuery).get(agentId) as { count: number };

    const typeQuery = `SELECT embedding_type, COUNT(*) as count FROM ${this.metadataTable} WHERE agent_id = ? GROUP BY embedding_type`;
    const typeResults = this.db.prepare(typeQuery).all(agentId) as { embedding_type: string; count: number }[];
    const embeddingsByType = typeResults.reduce((acc, { embedding_type, count }) => {
      acc[embedding_type] = count;
      return acc;
    }, {} as Record<string, number>);

    const fileQuery = `SELECT file_path_relative, COUNT(*) as count FROM ${this.metadataTable} WHERE agent_id = ? GROUP BY file_path_relative`;
    const fileResults = this.db.prepare(fileQuery).all(agentId) as { file_path_relative: string; count: number }[];
    const embeddingsByFile = fileResults.reduce((acc, { file_path_relative, count }) => {
      acc[file_path_relative] = count;
      return acc;
    }, {} as Record<string, number>);

    const sizeQuery = `SELECT AVG(LENGTH(chunk_text)) as avg_size FROM ${this.metadataTable} WHERE agent_id = ?`;
    const sizeResult = this.db.prepare(sizeQuery).get(agentId) as { avg_size: number };

    const fileCountQuery = `SELECT COUNT(DISTINCT file_path_relative) as count FROM ${this.metadataTable} WHERE agent_id = ?`;
    const fileCountResult = this.db.prepare(fileCountQuery).get(agentId) as { count: number };

    return {
      totalEmbeddings: totalResult.count,
      embeddingsByType,
      embeddingsByFile,
      averageChunkSize: Math.round(sizeResult.avg_size || 0),
      totalFiles: fileCountResult.count,
    };
  }
}