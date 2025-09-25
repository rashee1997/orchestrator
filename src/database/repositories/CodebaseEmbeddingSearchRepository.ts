import { Database } from 'better-sqlite3';
import { CodebaseEmbeddingRecord, BoostConfiguration } from '../../types/codebase_embeddings.js';
import { findSimilarVecEmbeddings } from '../vector_db.js';
import { executeWithRetry } from './CodebaseEmbeddingRepository.helpers.retry.js';
import { calculateEntityNameRelevanceBoost, calculateRerankedScore } from './CodebaseEmbeddingRepository.helpers.boosting.js';
import { enforceImplementationDiversification } from './CodebaseEmbeddingRepository.helpers.impl.js';

export class CodebaseEmbeddingSearchRepository {
  private db: Database;
  private vectorTable = 'codebase_embeddings_vec_idx';
  private metadataTable = 'codebase_embeddings';
  private boostConfig: BoostConfiguration;
  private maxRetries = 3;
  private retryDelay = 1000;

  constructor(db: Database, boostConfig: BoostConfiguration) {
    this.db = db;
    this.boostConfig = boostConfig;
  }

  public async findSimilarEmbeddingsWithMetadata(
    queryEmbedding: number[],
    queryText: string,
    topK: number,
    agentId?: string,
    targetFilePaths?: string[],
    excludeChunkTypes?: string[],
    model?: string
  ): Promise<Array<CodebaseEmbeddingRecord & { similarity: number }>> {
    const vecResults = await executeWithRetry(
      async () => await findSimilarVecEmbeddings(queryEmbedding, topK * 5, this.vectorTable),
      { opName: 'findSimilarVecEmbeddings', maxRetries: this.maxRetries, retryDelay: this.retryDelay }
    );

    if (!vecResults || vecResults.length === 0) return [];

    const embeddingIds = vecResults.map((r) => r.embedding_id);
    const similarityMap = new Map(vecResults.map((r) => [r.embedding_id, r.similarity]));

    const placeholders = embeddingIds.map(() => '?').join(',');
    let sql = `SELECT * FROM ${this.metadataTable} WHERE embedding_id IN (${placeholders})`;
    const params: (string | number)[] = [...embeddingIds];

    if (agentId) {
      sql += ` AND agent_id = ?`;
      params.push(agentId);
    }
    if (targetFilePaths?.length) {
      sql += ` AND file_path_relative IN (${targetFilePaths.map(() => '?').join(',')})`;
      params.push(...targetFilePaths);
    }
    if (excludeChunkTypes?.length) {
      sql += ` AND embedding_type NOT IN (${excludeChunkTypes.map(() => '?').join(',')})`;
      params.push(...excludeChunkTypes);
    }
    if (model) {
      sql += ` AND model_name = ?`;
      params.push(model);
    }

    const metadataRows = await executeWithRetry(
      () => {
        const stmt = this.db.prepare(sql);
        return stmt.all(...params) as CodebaseEmbeddingRecord[];
      },
      { opName: 'fetchFilteredMetadata', maxRetries: this.maxRetries, retryDelay: this.retryDelay }
    );

    const results = metadataRows.map((meta) => {
      let similarity = similarityMap.get(meta.embedding_id) ?? 0;
      const nameBoost = calculateEntityNameRelevanceBoost(queryText, meta, this.boostConfig);
      similarity = Math.min(1.0, similarity + nameBoost);
      return { ...meta, similarity };
    });

    const enhancedResults = enforceImplementationDiversification(queryText, results, topK, this.boostConfig);

    const queryTokens = new Set(queryText.toLowerCase().split(/\s+/).filter((t) => t.length > 2));
    enhancedResults.forEach((r) => {
      r.similarity = calculateRerankedScore(r, queryText, queryTokens);
    });

    enhancedResults.sort((a, b) => b.similarity - a.similarity);
    return enhancedResults.slice(0, topK);
  }
}