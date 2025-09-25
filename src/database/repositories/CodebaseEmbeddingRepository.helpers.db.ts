import { Database } from 'better-sqlite3';

export function applyPragmas(db: Database): void {
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -10000'); // 10MB cache
    db.pragma('temp_store = MEMORY');
    db.pragma('mmap_size = 268435456'); // 256MB mmap
  } catch (error) {
    console.warn('Failed to set database pragmas:', error);
  }
}

export function ensureCommitCheckpointTable(db: Database): void {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS codebase_ingestion_commits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repository_root TEXT NOT NULL,
        agent_id TEXT,
        commit_hash TEXT NOT NULL,
        parent_commit_hash TEXT,
        branch_name TEXT,
        commit_timestamp INTEGER,
        metadata_json TEXT,
        ingested_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        UNIQUE(repository_root, agent_id, commit_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_vs_ingestion_commits_repo_agent
        ON codebase_ingestion_commits (repository_root, agent_id);
    `);
  } catch (error) {
    console.warn('Failed to ensure codebase_ingestion_commits table:', error);
  }
}