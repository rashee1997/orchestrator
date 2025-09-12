export type GeminiEmbeddingTaskType = 
    | 'RETRIEVAL_QUERY' 
    | 'RETRIEVAL_DOCUMENT' 
    | 'SEMANTIC_SIMILARITY' 
    | 'CLASSIFICATION' 
    | 'CLUSTERING'
    | 'QUESTION_ANSWERING'
    | 'FACT_VERIFICATION'
    | 'CODE_RETRIEVAL_QUERY';

export interface GeminiModelConfig {
    defaultModel: string;
    fallbackModel: string;
    embeddingModel: string;
    fallbackEmbeddingModel: string;
    embeddingDimensions: number;
    fallbackEmbeddingDimensions: number;
}

export const GEMINI_MODEL_CONFIG: GeminiModelConfig = {
    defaultModel: "gemini-2.5-flash",
    fallbackModel: "gemini-2.5-flash-lite",
    embeddingModel: "models/gemini-embedding-001",
    fallbackEmbeddingModel: "models/text-embedding-004",
    embeddingDimensions: 3072,
    fallbackEmbeddingDimensions: 768
};

export const getCurrentModel = (useFallback: boolean = false): string => {
    return useFallback ? GEMINI_MODEL_CONFIG.fallbackModel : GEMINI_MODEL_CONFIG.defaultModel;
};

export const getCurrentEmbeddingModel = (useFallback: boolean = false): string => {
    return useFallback ? GEMINI_MODEL_CONFIG.fallbackEmbeddingModel : GEMINI_MODEL_CONFIG.embeddingModel;
};

export const getCurrentEmbeddingDimensions = (useFallback: boolean = false): number => {
    return useFallback ? GEMINI_MODEL_CONFIG.fallbackEmbeddingDimensions : GEMINI_MODEL_CONFIG.embeddingDimensions;
};

export const shouldRetryWithFallback = (error: any): boolean => {
    if (!error) return false;
    const errorMessage = error.message || error.toString() || '';
    const statusCode = error.status || error.code || 0;
    
    return statusCode === 429 || 
           statusCode === 502 || 
           errorMessage.includes('quota') || 
           errorMessage.includes('overload') ||
           errorMessage.includes('rate limit');
};

export const SUMMARIZATION_MODEL_NAME = getCurrentModel();
export const ENTITY_EXTRACTION_MODEL_NAME = getCurrentModel();
export const EMBEDDING_MODEL_NAME = getCurrentEmbeddingModel();
export const DEFAULT_ASK_MODEL_NAME = getCurrentModel();
export const REFINEMENT_MODEL_NAME = getCurrentModel();
