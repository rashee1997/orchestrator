import { CodebaseEmbeddingRecord } from '../../types/codebase_embeddings.js';

export function insertMetadataRecord(metadata: CodebaseEmbeddingRecord, stmtMetadata: any): void {
  stmtMetadata.run(
    metadata.embedding_id,
    metadata.agent_id,
    metadata.chunk_text,
    metadata.entity_name,
    metadata.entity_name_vector_blob,
    metadata.entity_name_vector_dimensions,
    metadata.model_name,
    metadata.chunk_hash,
    metadata.file_hash,
    metadata.metadata_json,
    metadata.created_timestamp_unix,
    metadata.file_path_relative,
    metadata.full_file_path,
    metadata.ai_summary_text,
    metadata.vector_dimensions,
    metadata.embedding_type,
    metadata.parent_embedding_id,
    // New parallel embedding columns
    metadata.embedding_provider ?? 'gemini',
    metadata.embedding_model_full_name ?? metadata.model_name,
    metadata.embedding_generation_method ?? 'single',
    metadata.embedding_request_id ?? null,
    metadata.embedding_quality_score ?? 1.0,
    metadata.embedding_generation_timestamp ?? Date.now()
  );
}

export function insertVectorRecord(metadata: CodebaseEmbeddingRecord, stmtVec: any): void {
  if (metadata.vector_blob && metadata.vector_blob.length > 0) {
    const vector: number[] = [];
    for (let i = 0; i < metadata.vector_blob.length; i += 4) {
      vector.push(metadata.vector_blob.readFloatLE(i));
    }
    const vectorString = `[${vector.join(',')}]`;
    stmtVec.run(metadata.embedding_id, vectorString);
  }
}

export function processEmbeddingRecord(
  metadata: CodebaseEmbeddingRecord,
  stmtMetadata: any,
  stmtVec: any
): void {
  try {
    insertMetadataRecord(metadata, stmtMetadata);
    insertVectorRecord(metadata, stmtVec);
  } catch (error) {
    console.error(`Error inserting embedding ${metadata.embedding_id}:`, error);
  }
}