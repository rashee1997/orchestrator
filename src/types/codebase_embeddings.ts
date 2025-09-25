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
    // New parallel embedding tracking columns
    embedding_provider?: 'gemini' | 'mistral';
    embedding_model_full_name?: string; // Full model name (e.g., 'models/gemini-embedding-001', 'codestral-embed')
    embedding_generation_method?: 'single' | 'parallel' | 'fallback';
    embedding_request_id?: string | null; // Track batched/parallel requests
    embedding_quality_score?: number; // For quality tracking (default 1.0)
    embedding_generation_timestamp?: number; // When embedding was generated
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
    batchMetadata?: { // New: Batch processing metadata for AI summary context
        totalBatches: number;
        batchSize: number;
        totalFilesProcessed: number;
        batchDelayMs: number;
    };
    commitMetadata?: EmbeddingCommitMetadata;
}

export interface EmbeddingCommitMetadata {
    repositoryRoot: string;
    branchName?: string | null;
    currentCommit?: string | null;
    previousCommit?: string | null;
    commits?: Array<{
        hash: string;
        author: string;
        date: string;
        message: string;
    }>;
    commitTimestamp?: number | null;
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

export interface BoostRule {
    name: string;
    pattern: RegExp;
    boost: number;
    description: string;
}

export interface BoostConfiguration {
    // Language-specific patterns
    methodImplementationPatterns: BoostRule[];
    implementationContentPatterns: BoostRule[];
    implementationSignaturePatterns: BoostRule[];

    // Boost multipliers
    entityNameExactMatchBoost: number;
    entityNamePartialMatchBoost: number;
    entityNameFuzzyMatchThreshold: number;
    entityNameFuzzyMatchBoost: number;

    fileNameMatchBoost: number;
    directoryMatchBoost: number;

    substantialContentThreshold: number;
    substantialContentBoost: number;
    largeContentThreshold: number;
    largeContentBoost: number;

    languageMatchBoost: number;
    codeTypeMatchBoost: number;
    implementationVsDeclarationBoost: number;

    maxTotalBoost: number;
    implementationDiversificationThreshold: number;
    implementationBoostMultiplier: number;
    entityBoostMultiplier: number;
}

export const DEFAULT_BOOST_CONFIGURATION: BoostConfiguration = {
    methodImplementationPatterns: [
        { name: 'function_definitions', pattern: /\b(?:function|def|func|fn)\s+\w+\s*[\(\{]/, boost: 0.15, description: 'Function definitions' },
        { name: 'method_signatures', pattern: /\b(?:public|private|protected|static|async|override)\s+(?:\w+\s+)?\w+\s*\(/, boost: 0.15, description: 'Method signatures' },
        { name: 'constructors', pattern: /\b(?:constructor|__init__|new)\s*\(/, boost: 0.15, description: 'Constructor patterns' },
        { name: 'arrow_functions', pattern: /\w+\s*[=:]\s*(?:\([^)]*\)\s*)?=>/, boost: 0.15, description: 'Arrow functions' },
        { name: 'method_calls', pattern: /\b(?:this|self)\.\w+\s*\(/, boost: 0.15, description: 'Method calls with this/self' },
        { name: 'class_definitions', pattern: /\b(?:class|struct|interface|enum|trait)\s+\w+/, boost: 0.15, description: 'Class definitions' }
    ],

    implementationContentPatterns: [
        { name: 'type_definitions', pattern: /\b(?:class|interface|enum|struct|trait|type|union|record)\s+\w+/, boost: 0.05, description: 'Type/class definitions' },
        { name: 'function_keywords', pattern: /\b(?:function|def|func|fn|method|proc)\s+\w+/, boost: 0.05, description: 'Function definitions' },
        { name: 'access_modifiers', pattern: /\b(?:public|private|protected|static|final|abstract|virtual|override|async|const|let|var)\s+\w+/, boost: 0.05, description: 'Access modifiers' },
        { name: 'return_statements', pattern: /\b(?:return|yield|throw)\s+/, boost: 0.05, description: 'Return statements' },
        { name: 'assignments', pattern: /\b(?:this|self|@)\.[\w$]+\s*[=:]/, boost: 0.05, description: 'Assignment patterns' },
        { name: 'control_flow', pattern: /\b(?:if|for|while|switch|match|case|when|loop|do)\s*[\(\{]/, boost: 0.05, description: 'Control flow' },
        { name: 'exception_handling', pattern: /\b(?:try|catch|except|finally|rescue|ensure)\b/, boost: 0.05, description: 'Exception handling' },
        { name: 'async_patterns', pattern: /\b(?:await|async|Promise|Future|Task|Deferred|Observable)\b/, boost: 0.05, description: 'Async patterns' },
        { name: 'memory_management', pattern: /\b(?:new|delete|malloc|free|alloc)\b/, boost: 0.05, description: 'Memory management' },
        { name: 'imports', pattern: /\b(?:import|from|include|require|use|using)\s+/, boost: 0.05, description: 'Import/include statements' }
    ],

    implementationSignaturePatterns: [
        { name: 'constructors', pattern: /\b(?:constructor|__init__|new|init)\s*\(/, boost: 0.4, description: 'Constructor patterns' },
        { name: 'main_methods', pattern: /\b(?:main|run|execute|start|begin|init|setup|configure)\w*\s*\(/, boost: 0.4, description: 'Main/entry methods' },
        { name: 'process_methods', pattern: /\b(?:process|handle|manage|operate|perform|apply)\w*\s*\(/, boost: 0.4, description: 'Process/handle methods' },
        { name: 'update_methods', pattern: /\b(?:update|modify|change|set|assign|alter)\w*\s*\(/, boost: 0.4, description: 'Update/modify methods' },
        { name: 'get_methods', pattern: /\b(?:get|fetch|retrieve|find|search|query|select)\w*\s*\(/, boost: 0.4, description: 'Get/fetch/retrieve methods' },
        { name: 'create_methods', pattern: /\b(?:create|build|make|generate|construct|produce)\w*\s*\(/, boost: 0.4, description: 'Create/build/make methods' },
        { name: 'async_methods', pattern: /\basync\s+\w+\s*\(/, boost: 0.4, description: 'Async method patterns' },
        { name: 'public_methods', pattern: /\b(?:public|export|def)\s+\w+\s*\(/, boost: 0.4, description: 'Public method patterns' }
    ],

    entityNameExactMatchBoost: 0.4,
    entityNamePartialMatchBoost: 0.25,
    entityNameFuzzyMatchThreshold: 0.7,
    entityNameFuzzyMatchBoost: 0.2,

    fileNameMatchBoost: 0.15,
    directoryMatchBoost: 0.08,

    substantialContentThreshold: 500,
    substantialContentBoost: 0.1,
    largeContentThreshold: 1000,
    largeContentBoost: 0.1,

    languageMatchBoost: 0.05,
    codeTypeMatchBoost: 0.1,
    implementationVsDeclarationBoost: 0.1,

    maxTotalBoost: 0.6,
    implementationDiversificationThreshold: 0.4,
    implementationBoostMultiplier: 1.5,
    entityBoostMultiplier: 0.25
};
