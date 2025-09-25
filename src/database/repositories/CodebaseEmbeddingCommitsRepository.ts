import { Database } from 'better-sqlite3';

export class CodebaseEmbeddingCommitsRepository {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  public getLastIngestionCommit(
    repositoryRoot: string,
    agentId?: string
  ): {
    commit_hash: string;
    parent_commit_hash: string | null;
    branch_name: string | null;
    commit_timestamp: number | null;
    ingested_at: number;
  } | null {
    let sql = `SELECT commit_hash, parent_commit_hash, branch_name, commit_timestamp, ingested_at
               FROM codebase_ingestion_commits
               WHERE repository_root = ?`;
    const params: (string | null)[] = [repositoryRoot];
    if (agentId) {
      sql += ` AND (agent_id = ? OR agent_id IS NULL)`;
      params.push(agentId);
    }
    sql += ` ORDER BY ingested_at DESC LIMIT 1`;
    const stmt = this.db.prepare(sql);
    const row = stmt.get(...params) as
      | {
          commit_hash: string;
          parent_commit_hash: string | null;
          branch_name: string | null;
          commit_timestamp: number | null;
          ingested_at: number;
        }
      | undefined;
    return row || null;
  }

  public recordIngestionCommit(entry: {
    repositoryRoot: string;
    agentId?: string;
    commitHash: string;
    parentCommitHash?: string | null;
    branchName?: string | null;
    commitTimestamp?: number | null;
    metadataJson?: string | null;
  }): void {
    const { repositoryRoot, agentId, commitHash, parentCommitHash, branchName, commitTimestamp, metadataJson } = entry;
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO codebase_ingestion_commits (
        repository_root, agent_id, commit_hash, parent_commit_hash, branch_name, commit_timestamp, metadata_json, ingested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
    `);
    stmt.run(
      repositoryRoot,
      agentId ?? null,
      commitHash,
      parentCommitHash ?? null,
      branchName ?? null,
      commitTimestamp ?? null,
      metadataJson ?? null
    );
  }
}