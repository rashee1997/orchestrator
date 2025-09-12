export type ChunkingStrategy = 'auto' | 'function' | 'class' | 'sliding_window';

// MODIFICATION: Added embedding_type and parent_embedding_id for structural awareness
export interface CodebaseEmbeddingRecord {
    embedding_id: string;
    agent_id: string;
    chunk_text: string;
    entity_name: string | null;
    entity_name_vector_blob?: Buffer | null;
    entity_name_vector_dimensions?: number | null;
    vector_blob: Buffer;
    vector_dimensions: number;
    model_name: string;
    chunk_hash: string;
    file_hash: string;
    metadata_json: string | null;
    created_timestamp_unix: number;
    file_path_relative: string;
    full_file_path: string;
    ai_summary_text?: string | null;
    embedding_type: 'summary' | 'chunk'; // 'summary' for parent, 'chunk' for child
    parent_embedding_id?: string | null; // Link chunks to their parent summary
    similarity?: number;
    finalScore?: number;
}

export interface EmbeddingIngestionResult {
    newEmbeddingsCount: number;
    reusedEmbeddingsCount: number;
    reusedFilesCount: number; // New: Count of files skipped due to unchanged file hash
    deletedEmbeddingsCount: number;
    newEmbeddings: Array<{ file_path_relative: string; chunk_text: string; entity_name?: string | null; }>;
    reusedEmbeddings: Array<{ file_path_relative: string; chunk_text: string; entity_name?: string | null; }>;
    reusedFiles: Array<{ file_path_relative: string; reason: string; chunk_count?: number; }>; // New: Track reused files
    deletedEmbeddings: Array<{ file_path_relative: string; chunk_text: string; entity_name?: string | null; }>;
    scannedFiles: Array<{ file_path_relative: string; status: 'processed' | 'skipped' | 'error' | 'partial'; skipReason?: string; }>; // Enhanced with skip reason
    aiSummary?: string;
    embeddingRequestCount: number;
    embeddingRetryCount: number;
    namingApiCallCount: number;
    summarizationApiCallCount: number;
    dbCallCount: number;
    dbCallLatencyMs: number;
    totalTimeMs: number;
    totalTokensProcessed?: number;
    processingErrors: Array<{ file_path_relative: string; error: string; stage: string; }>; // New: Track processing errors
    batchStatus: 'complete' | 'partial' | 'failed'; // New: Overall batch status
    resumeInfo?: { failedFiles: string[]; lastSuccessfulFile?: string; }; // New: Resume information
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