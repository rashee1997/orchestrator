-- src/database/vector_store_schema.sql

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = OFF; -- Typically OFF for a separate utility DB unless linking to internal tables not present here.

CREATE TABLE IF NOT EXISTS codebase_embeddings (
    embedding_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    -- We use file_path_relative to link back to the main KG's file nodes.
    -- No direct FOREIGN KEY here as it's a separate database file.
    -- The 'link' is conceptual and managed at the application layer.
    file_path_relative TEXT NOT NULL, 
    entity_name TEXT, -- Optional: e.g., function name, class name if chunking by entity
    chunk_text TEXT NOT NULL, -- The actual code/text chunk that was embedded
    vector_blob BLOB NOT NULL, -- Storing vector as BLOB for potential direct use with extensions like sqlite-vss
                               -- For sqlite-vss, this would be a vector<float> type.
                               -- If not using vss, could be TEXT storing JSON.stringify(number[]).
                               -- BLOB is generally more efficient for raw numerical data.
    vector_dimensions INTEGER NOT NULL, -- Store the dimensionality of the vector
    model_name TEXT NOT NULL, -- e.g., "models/text-embedding-004"
    chunk_hash TEXT UNIQUE, -- SHA256 hash of chunk_text to detect changes and avoid re-embedding
    created_timestamp_unix INTEGER NOT NULL,
    metadata_json TEXT -- Optional: for start/end lines of chunk, or other info
);

CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_agent_id ON codebase_embeddings (agent_id);
CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_file_path ON codebase_embeddings (file_path_relative);
CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_entity_name ON codebase_embeddings (entity_name);
CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_model_name ON codebase_embeddings (model_name);
CREATE INDEX IF NOT EXISTS idx_vs_codebase_embeddings_chunk_hash ON codebase_embeddings (chunk_hash);

-- If using sqlite-vss extension, you would create a virtual table for vector search:
-- Example (actual syntax might vary slightly based on the specific sqlite-vss build/API):
-- CREATE VIRTUAL TABLE IF NOT EXISTS vss_codebase_embeddings USING vss0(
--     vector(vector_dimensions) -- Assumes vector_blob contains the raw vector data
-- );
-- And then populate it from codebase_embeddings or manage it via triggers.
-- For now, we'll assume the application layer handles similarity search if vss is not integrated at DB init.
