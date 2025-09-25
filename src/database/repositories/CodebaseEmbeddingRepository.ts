import { Database } from 'better-sqlite3';
import { BoostConfiguration, DEFAULT_BOOST_CONFIGURATION } from '../../types/codebase_embeddings.js';
import { applyPragmas, ensureCommitCheckpointTable } from './CodebaseEmbeddingRepository.helpers.db.js';
import { CodebaseEmbeddingWriteRepository } from './CodebaseEmbeddingWriteRepository.js';
import { CodebaseEmbeddingReadRepository } from './CodebaseEmbeddingReadRepository.js';
import { CodebaseEmbeddingStatsRepository } from './CodebaseEmbeddingStatsRepository.js';
import { CodebaseEmbeddingCommitsRepository } from './CodebaseEmbeddingCommitsRepository.js';
import { CodebaseEmbeddingSearchRepository } from './CodebaseEmbeddingSearchRepository.js';

export class CodebaseEmbeddingRepository {
  private readonly writeRepo: CodebaseEmbeddingWriteRepository;
  private readonly readRepo: CodebaseEmbeddingReadRepository;
  private readonly statsRepo: CodebaseEmbeddingStatsRepository;
  private readonly commitsRepo: CodebaseEmbeddingCommitsRepository;
  private readonly searchRepo: CodebaseEmbeddingSearchRepository;

  constructor(private readonly db: Database, private readonly boostConfig: BoostConfiguration = DEFAULT_BOOST_CONFIGURATION) {
    applyPragmas(this.db);
    ensureCommitCheckpointTable(this.db);

    this.writeRepo = new CodebaseEmbeddingWriteRepository(this.db);
    this.readRepo = new CodebaseEmbeddingReadRepository(this.db);
    this.statsRepo = new CodebaseEmbeddingStatsRepository(this.db);
    this.commitsRepo = new CodebaseEmbeddingCommitsRepository(this.db);
    this.searchRepo = new CodebaseEmbeddingSearchRepository(this.db, this.boostConfig);
  }

  // ---- Delegations ----
  public bulkInsertEmbeddings(...args: Parameters<CodebaseEmbeddingWriteRepository['bulkInsertEmbeddings']>) {
    return this.writeRepo.bulkInsertEmbeddings(...args);
  }
  public updateFileHashForEmbedding(...args: Parameters<CodebaseEmbeddingWriteRepository['updateFileHashForEmbedding']>) {
    return this.writeRepo.updateFileHashForEmbedding(...args);
  }
  public bulkDeleteEmbeddings(...args: Parameters<CodebaseEmbeddingWriteRepository['bulkDeleteEmbeddings']>) {
    return this.writeRepo.bulkDeleteEmbeddings(...args);
  }

  public getEmbeddingsForFile(...args: Parameters<CodebaseEmbeddingReadRepository['getEmbeddingsForFile']>) {
    return this.readRepo.getEmbeddingsForFile(...args);
  }
  public getChunkHashesForFile(...args: Parameters<CodebaseEmbeddingReadRepository['getChunkHashesForFile']>) {
    return this.readRepo.getChunkHashesForFile(...args);
  }
  public getLatestFileHashes(...args: Parameters<CodebaseEmbeddingReadRepository['getLatestFileHashes']>) {
    return this.readRepo.getLatestFileHashes(...args);
  }
  public getAllFilePathsForAgent(...args: Parameters<CodebaseEmbeddingReadRepository['getAllFilePathsForAgent']>) {
    return this.readRepo.getAllFilePathsForAgent(...args);
  }
  public getAllEntityNames(...args: Parameters<CodebaseEmbeddingReadRepository['getAllEntityNames']>) {
    return this.readRepo.getAllEntityNames(...args);
  }
  public getAvailableEmbeddingModels(...args: Parameters<CodebaseEmbeddingReadRepository['getAvailableEmbeddingModels']>) {
    return this.readRepo.getAvailableEmbeddingModels(...args);
  }
  public getEmbeddingsByIds(...args: Parameters<CodebaseEmbeddingReadRepository['getEmbeddingsByIds']>) {
    return this.readRepo.getEmbeddingsByIds(...args);
  }

  public getEmbeddingStatistics(...args: Parameters<CodebaseEmbeddingStatsRepository['getEmbeddingStatistics']>) {
    return this.statsRepo.getEmbeddingStatistics(...args);
  }

  public getLastIngestionCommit(...args: Parameters<CodebaseEmbeddingCommitsRepository['getLastIngestionCommit']>) {
    return this.commitsRepo.getLastIngestionCommit(...args);
  }
  public recordIngestionCommit(...args: Parameters<CodebaseEmbeddingCommitsRepository['recordIngestionCommit']>) {
    return this.commitsRepo.recordIngestionCommit(...args);
  }

  public findSimilarEmbeddingsWithMetadata(...args: Parameters<CodebaseEmbeddingSearchRepository['findSimilarEmbeddingsWithMetadata']>) {
    return this.searchRepo.findSimilarEmbeddingsWithMetadata(...args);
  }

  public optimizeDatabase(...args: Parameters<CodebaseEmbeddingReadRepository['optimizeDatabase']>) {
    return this.readRepo.optimizeDatabase(...args);
  }
}
