import { getCurrentEmbeddingModel, getCurrentEmbeddingDimensions } from '../database/services/gemini-integration-modules/GeminiConfig.js';

export const DEFAULT_EMBEDDING_MODEL = getCurrentEmbeddingModel();
export const EMBEDDING_DIMENSIONS = getCurrentEmbeddingDimensions();
export const VECTOR_FLOAT_SIZE = 4; // Bytes per float32
