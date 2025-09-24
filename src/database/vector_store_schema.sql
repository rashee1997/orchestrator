PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = OFF;

-- Metadata for code embeddings, now with support for parent-document structure
CREATE TABLE IF NOT EXISTS codebase_embeddings (
    embedding_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    file_path_relative TEXT NOT NULL,
    entity_name TEXT,
    entity_name_vector_blob BLOB,
    entity_name_vector_dimensions INTEGER,
    chunk_text TEXT NOT NULL,
    ai_summary_text TEXT,
    vector_dimensions INTEGER NOT NULL,
    model_name TEXT NOT NULL,
    chunk_hash TEXT UNIQUE,
    file_hash TEXT NOT NULL,
    created_timestamp_unix INTEGER NOT NULL,
    metadata_json TEXT,
    full_file_path TEXT,

    -- MODIFICATION: Added columns for the Parent Document Retriever model
    embedding_type TEXT NOT NULL CHECK(embedding_type IN ('summary', 'chunk')),
    parent_embedding_id TEXT, -- This will be the embedding_id of the parent 'summary'

    -- ENHANCEMENT: Added columns for parallel embedding model tracking
    embedding_provider TEXT DEFAULT 'gemini' CHECK(embedding_provider IN ('gemini', 'mistral')),
    embedding_model_full_name TEXT, -- Full model name (e.g., 'models/gemini-embedding-001', 'codestral-embed')
    embedding_generation_method TEXT DEFAULT 'single' CHECK(embedding_generation_method IN ('single', 'parallel', 'fallback')),
    embedding_request_id TEXT, -- Track batched/parallel requests
    embedding_quality_score REAL DEFAULT 1.0, -- For future quality tracking
    embedding_generation_timestamp INTEGER -- Track when embedding was generated (different from record creation)
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_agent_id ON codebase_embeddings (agent_id);
CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_file_path ON codebase_embeddings (file_path_relative);
CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_chunk_hash ON codebase_embeddings (chunk_hash);
CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_file_hash ON codebase_embeddings (file_hash);

-- MODIFICATION: Added indexes for the new structural columns
CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_embedding_type ON codebase_embeddings (embedding_type);
CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_parent_id ON codebase_embeddings (parent_embedding_id);

-- ENHANCEMENT: Added indexes for parallel embedding tracking
CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_provider ON codebase_embeddings (embedding_provider);
CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_model_full_name ON codebase_embeddings (embedding_model_full_name);
CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_request_id ON codebase_embeddings (embedding_request_id);
CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_generation_method ON codebase_embeddings (embedding_generation_method);
CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_generation_timestamp ON codebase_embeddings (embedding_generation_timestamp);

-- Track ingestion checkpoints tied to git commits
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

CREATE INDEX IF NOT EXISTS idx_vs_ingestion_commits_repo_agent ON codebase_ingestion_commits (repository_root, agent_id);
