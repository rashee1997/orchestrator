import { CodebaseEmbeddingRecord, BoostConfiguration } from '../../types/codebase_embeddings.js';

export function enforceImplementationDiversification(
  queryText: string,
  results: Array<CodebaseEmbeddingRecord & { similarity: number }>,
  topK: number,
  boostConfig: BoostConfiguration
): Array<CodebaseEmbeddingRecord & { similarity: number }> {
  const queryTerms = queryText.toLowerCase().split(/\s+/);
  const targetEntity = queryTerms.find((term) => term.length > 3) || queryText.toLowerCase();

  const isConstantEntity = (name: string | null | undefined): boolean => {
    if (!name) return false;
    const trimmed = name.trim();
    if (!trimmed) return false;
    const isAllCaps = trimmed === trimmed.toUpperCase();
    const hasUnderscore = trimmed.includes('_');
    const looksPrompt = trimmed.toLowerCase().includes('prompt');
    return (isAllCaps && hasUnderscore) || looksPrompt;
  };

  const implementationSignaturePatterns = boostConfig.implementationSignaturePatterns.map(
    (rule) => rule.pattern
  );

  const implementationChunks = results.filter((result) => {
    if (isConstantEntity(result.entity_name)) return false;
    const content = result.chunk_text?.toLowerCase() ?? '';
    const entityName = result.entity_name?.toLowerCase() ?? '';
    return (
      (entityName.includes(targetEntity) || content.includes(targetEntity)) &&
      (implementationSignaturePatterns.some((p) => p.test(content)) ||
        /\b(?:class|struct|interface|enum|trait|type)\s+\w+/.test(content) ||
        /\b(?:function|def|func|fn|method|proc)\s+\w+/.test(content) ||
        /\b(?:public|private|protected|static|async|export)\s+\w+\s*\(/.test(content))
    );
  });

  if (implementationChunks.length < Math.floor(topK * boostConfig.implementationDiversificationThreshold)) {
    implementationChunks.forEach((chunk) => {
      const content = chunk.chunk_text?.toLowerCase() || '';
      for (const rule of boostConfig.implementationSignaturePatterns) {
        if (rule.pattern.test(content)) {
          chunk.similarity = Math.min(1.0, chunk.similarity + rule.boost);
          break;
        }
      }
      if (chunk.chunk_text && chunk.chunk_text.length > 800) {
        chunk.similarity = Math.min(1.0, chunk.similarity + 0.2);
      }
    });
  }

  const hasImplementationPatterns = implementationSignaturePatterns.some((pattern) =>
    results.some((r) => pattern.test(r.chunk_text?.toLowerCase() || ''))
  );

  if (!hasImplementationPatterns && results.length > 0) {
    const entityChunks = results.filter((r) => {
      if (isConstantEntity(r.entity_name)) return false;
      const entityName = r.entity_name?.toLowerCase() || '';
      const content = r.chunk_text?.toLowerCase() || '';
      return entityName.includes(targetEntity) || content.includes(targetEntity);
    });

    entityChunks.forEach((chunk) => {
      const content = chunk.chunk_text?.toLowerCase() || '';
      if (
        /\b(?:async|public|private|protected|static)\s+\w+\s*\(/.test(content) ||
        /\b(?:this|self|@)\.\w+/.test(content) ||
        /\b(?:return|yield|throw)\s+/.test(content) ||
        /\b(?:function|def|func|fn|method|proc)\s+\w+/.test(content)
      ) {
        chunk.similarity = Math.min(1.0, chunk.similarity + boostConfig.entityBoostMultiplier);
      }
    });
  }

  return results;
}