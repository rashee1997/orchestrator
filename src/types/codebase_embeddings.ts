export interface CodebaseEmbeddingRecord {
    embedding_id: string;
    agent_id: string;
    file_path_relative: string;
    entity_name?: string | null;
    chunk_text: string;
    ai_summary_text?: string | null;
    vector_blob: Buffer;
    vector_dimensions: number;
    model_name: string;
    chunk_hash?: string;
    created_timestamp_unix: number;
    metadata_json?: string;
}

export type ChunkingStrategy = 'file' | 'function' | 'class' | 'auto';

export interface CachedChunk {
    embedding_id: string;
    agent_id: string;
    chunk_text: string;
    entity_name?: string | null;
    vector: number[];
    vector_dimensions: number;
    model_name: string;
    chunk_hash: string;
    metadata?: any;
    created_timestamp_unix: number;
    file_path_relative: string;
    full_file_path: string;
}
