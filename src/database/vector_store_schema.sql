PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = OFF;

-- Metadata for code embeddings, now with support for parent-document structure
CREATE TABLE IF NOT EXISTS codebase_embeddings (
    embedding_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    file_path_relative TEXT NOT NULL,
    entity_name TEXT,
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
    parent_embedding_id TEXT -- This will be the embedding_id of the parent 'summary'
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_agent_id ON codebase_embeddings (agent_id);
CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_file_path ON codebase_embeddings (file_path_relative);
CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_chunk_hash ON codebase_embeddings (chunk_hash);
CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_file_hash ON codebase_embeddings (file_hash);

-- MODIFICATION: Added indexes for the new structural columns
CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_embedding_type ON codebase_embeddings (embedding_type);
CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_parent_id ON codebase_embeddings (parent_embedding_id);