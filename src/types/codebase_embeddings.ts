export type ChunkingStrategy = 'auto' | 'function' | 'class' | 'sliding_window';

export interface CodebaseEmbeddingRecord {
    embedding_id: string;
    agent_id: string;
    chunk_text: string;
    entity_name: string | null;
    vector_blob: Buffer;
    vector_dimensions: number;
    model_name: string;
    chunk_hash: string;
    file_hash: string; // Hash of the entire file content
    metadata_json: string | null;
    created_timestamp_unix: number;
    file_path_relative: string;
    full_file_path: string;
    ai_summary_text?: string | null;
    similarity?: number; // Added for retrieval results
    finalScore?: number; // Added for retrieval results
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
    totalTokensProcessed?: number; // MODIFICATION: Added for cost/performance tracking
}

export interface CachedChunk {
    embedding_id: string;
    agent_id: string;
    chunk_text: string;
    entity_name: string | null;
    vector: number[];
    vector_dimensions: number;
    model_name: string;
    chunk_hash: string;
    metadata: any;
    created_timestamp_unix: number;
    file_path_relative: string;
    full_file_path: string;
}