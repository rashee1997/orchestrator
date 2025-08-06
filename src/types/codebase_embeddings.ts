export interface CodebaseEmbeddingRecord {
    embedding_id: string;
    agent_id: string;
    file_path_relative: string;
    entity_name: string | null;
    chunk_text: string;
    ai_summary_text: string | undefined;
    vector_blob: Buffer;
    vector_dimensions: number;
    model_name: string;
    chunk_hash?: string;
    created_timestamp_unix: number;
    metadata_json?: string | null;
    full_file_path?: string; // Added this property
}

export type ChunkingStrategy = 'file' | 'function' | 'class' | 'auto';

export interface CachedChunk {
    embedding_id: string;
    agent_id: string;
    chunk_text: string;
    entity_name: string | null;
    vector: number[];
    vector_dimensions: number;
    model_name: string;
    chunk_hash: string;
    metadata?: any;
    created_timestamp_unix: number;
    file_path_relative: string;
    full_file_path: string;
}

export interface EmbeddingIngestionResult {
    newEmbeddingsCount: number;
    reusedEmbeddingsCount: number;
    deletedEmbeddingsCount: number;
    newEmbeddings: Array<{ file_path_relative: string; chunk_text: string }>;
    reusedEmbeddings: Array<{ file_path_relative: string; chunk_text: string }>;
    deletedEmbeddings: Array<{ file_path_relative: string; chunk_text: string }>;
    aiSummary?: string;
    embeddingRequestCount: number;
    embeddingRetryCount: number;
    namingApiCallCount: number;
    summarizationApiCallCount: number;
    dbCallCount: number;
    dbCallLatencyMs: number;
    totalTimeMs: number;
}
