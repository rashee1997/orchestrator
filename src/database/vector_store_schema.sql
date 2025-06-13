-- src/database/vector_store_schema.sql

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = OFF; -- Typically OFF for a separate utility DB unless linking to internal tables not present here.

-- Registry of all vector tables in this DB
CREATE TABLE IF NOT EXISTS vector_tables_registry (
    table_name TEXT PRIMARY KEY,
    dimension INTEGER NOT NULL,
    model_name TEXT NOT NULL,
    description TEXT
);

-- Example: Metadata for code embeddings
CREATE TABLE IF NOT EXISTS codebase_embeddings (
    embedding_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    file_path_relative TEXT NOT NULL,
    entity_name TEXT, -- Optional: e.g., function name, class name if chunking by entity
    chunk_text TEXT NOT NULL, -- The actual code/text chunk that was embedded (will now always be original code)
    ai_summary_text TEXT, -- New: Stores the AI-generated summary for code entities
    vector_dimensions INTEGER NOT NULL, -- Added vector_dimensions column
    model_name TEXT NOT NULL, -- e.g., "models/text-embedding-004"
    chunk_hash TEXT UNIQUE, -- SHA256 hash of chunk_text to detect changes and avoid re-embedding
    created_timestamp_unix INTEGER NOT NULL,
    metadata_json TEXT -- Optional: for start/end lines of chunk, or other info
);

-- Example: Metadata for doc embeddings (if needed)
CREATE TABLE IF NOT EXISTS doc_embeddings (
    embedding_id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    section TEXT,
    chunk_text TEXT NOT NULL,
    model_name TEXT NOT NULL,
    chunk_hash TEXT UNIQUE,
    created_timestamp_unix INTEGER NOT NULL,
    metadata_json TEXT
);

-- Create multiple sqlite-vec vector tables for different domains
CREATE TABLE IF NOT EXISTS doc_embeddings_vec (
    embedding_id TEXT PRIMARY KEY,
    vector BLOB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_agent_id ON codebase_embeddings (agent_id);
CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_file_path ON codebase_embeddings (file_path_relative);
CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_entity_name ON codebase_embeddings (entity_name);
CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_model_name ON codebase_embeddings (model_name);
CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_chunk_hash ON codebase_embeddings (chunk_hash);
CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_ai_summary ON codebase_embeddings (ai_summary_text);

-- Note: The VSS virtual table and triggers will be created programmatically
-- in the vector_db.ts file after checking if the VSS module is available
