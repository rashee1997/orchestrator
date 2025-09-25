import { CodebaseEmbeddingRecord, BoostConfiguration } from '../../types/codebase_embeddings.js';

export function parseResultMetadata(result: any): {
  metadata: any;
  isSummary: boolean;
  isCodeSnippet: boolean;
} {
  let metadata: any = {};
  try {
    metadata = result.metadata_json ? JSON.parse(result.metadata_json) : {};
  } catch {
    // ignore
  }
  const isSummary = result.embedding_type === 'summary' || metadata.type === 'file_summary';
  const isCodeSnippet = result.embedding_type === 'chunk' && !isSummary;
  return { metadata, isSummary, isCodeSnippet };
}

function calculateEntityNameBoost(result: any, queryText: string): number {
  if (result.entity_name && queryText.toLowerCase().includes(result.entity_name.toLowerCase())) {
    return 0.15;
  }
  return 0;
}

function calculateKeywordOverlapBoost(result: any, queryTokens: Set<string>): number {
  if (queryTokens.size > 0 && result.chunk_text) {
    const chunkTokens = new Set(result.chunk_text.toLowerCase().split(/\s+/));
    const overlap = [...queryTokens].filter((t) => chunkTokens.has(t));
    return (overlap.length / queryTokens.size) * 0.1;
  }
  return 0;
}

function calculateCodeSnippetBoost(isCodeSnippet: boolean, queryText: string): number {
  if (!isCodeSnippet) return 0;
  const codeExplanationKeywords = ['how does', 'how is', 'explain', 'understand', 'work', 'implement', 'integrate'];
  const isCodeExplanationQuery = codeExplanationKeywords.some((k) =>
    queryText.toLowerCase().includes(k)
  );
  const codeKeywords = ['function', 'class', 'method', 'variable', 'interface', 'type', 'const', 'let', 'var'];
  const hasCodeKeywords = codeKeywords.some((k) => queryText.toLowerCase().includes(k));
  let boost = 0;
  boost += isCodeExplanationQuery ? 0.2 : 0.05;
  if (hasCodeKeywords) boost += 0.08;
  return boost;
}

function calculateSummaryBoost(isSummary: boolean, queryText: string): number {
  if (!isSummary) return 0;
  const overviewKeywords = ['overview', 'summary', 'architecture', 'structure', 'design'];
  const hasOverviewKeywords = overviewKeywords.some((k) => queryText.toLowerCase().includes(k));
  if (hasOverviewKeywords) return 0.08;
  return 0;
}

export function calculateRerankedScore(
  result: any,
  queryText: string,
  queryTokens: Set<string>
): number {
  let rerankScore = result.similarity;
  const { isSummary, isCodeSnippet } = parseResultMetadata(result);
  rerankScore += calculateEntityNameBoost(result, queryText);
  rerankScore += calculateKeywordOverlapBoost(result, queryTokens);
  rerankScore += calculateCodeSnippetBoost(isCodeSnippet, queryText);
  rerankScore += calculateSummaryBoost(isSummary, queryText);
  return Math.min(1.0, rerankScore);
}

export function calculateStringSimilarity(str1: string, str2: string): number {
  if (str1.length === 0 || str2.length === 0) return 0;
  const maxLen = Math.max(str1.length, str2.length);
  const set1 = new Set(str1.split(''));
  const set2 = new Set(str2.split(''));
  const intersection = new Set([...set1].filter((x) => set2.has(x)));
  return intersection.size / maxLen;
}

export function calculateEntityNameRelevanceBoost(
  queryText: string,
  embedding: CodebaseEmbeddingRecord,
  boostConfig: BoostConfiguration
): number {
  let boost = 0;
  const queryLower = queryText.toLowerCase();
  const contentLower = embedding.chunk_text?.toLowerCase() || '';

  const queryTerms = queryText
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .map((t) => t.toLowerCase().replace(/[^\w]/g, ''));

  if (embedding.entity_name) {
    const entityNameLower = embedding.entity_name.toLowerCase();

    if (queryTerms.some((t) => t === entityNameLower)) {
      boost += boostConfig.entityNameExactMatchBoost;
    }
    if (queryTerms.some((t) => entityNameLower.includes(t) || t.includes(entityNameLower))) {
      boost += boostConfig.entityNamePartialMatchBoost;
    }
    const maxSimilarity = Math.max(
      ...queryTerms.map((t) => calculateStringSimilarity(t, entityNameLower))
    );
    if (maxSimilarity > boostConfig.entityNameFuzzyMatchThreshold) {
      boost += boostConfig.entityNameFuzzyMatchBoost * maxSimilarity;
    }
  }

  let methodImplementationBoost = 0;
  for (const rule of boostConfig.methodImplementationPatterns) {
    if (rule.pattern.test(contentLower)) methodImplementationBoost += rule.boost;
  }
  if (
    embedding.entity_name &&
    queryTerms.some((t) => embedding.entity_name!.toLowerCase().includes(t))
  ) {
    methodImplementationBoost *= boostConfig.implementationBoostMultiplier;
  }
  boost += Math.min(0.3, methodImplementationBoost);

  let implementationScore = 0;
  for (const rule of boostConfig.implementationContentPatterns) {
    if (rule.pattern.test(contentLower)) implementationScore += rule.boost;
  }
  boost += Math.min(0.2, implementationScore);

  if (embedding.file_path_relative) {
    const fileName = embedding.file_path_relative.split('/').pop()?.replace(/\.[^.]*$/, '') || '';
    const fileNameLower = fileName.toLowerCase();
    if (queryTerms.some((t) => fileNameLower.includes(t))) {
      boost += boostConfig.fileNameMatchBoost;
    }
    const pathParts = embedding.file_path_relative.toLowerCase().split('/');
    if (queryTerms.some((t) => pathParts.some((p) => p.includes(t)))) {
      boost += boostConfig.directoryMatchBoost;
    }
  }

  if (embedding.embedding_type === 'chunk') {
    const chunkLength = embedding.chunk_text?.length || 0;
    if (chunkLength > boostConfig.substantialContentThreshold) {
      boost += boostConfig.substantialContentBoost;
    }
    if (chunkLength > boostConfig.largeContentThreshold) {
      boost += boostConfig.largeContentBoost;
    }
    if (embedding.entity_name && contentLower.includes(embedding.entity_name.toLowerCase())) {
      boost += 0.1;
    }
  }

  if (embedding.metadata_json) {
    try {
      const metadata = JSON.parse(embedding.metadata_json);
      if (metadata.language && queryLower.includes(metadata.language.toLowerCase())) {
        boost += boostConfig.languageMatchBoost;
      }
      if (
        metadata.code_type &&
        queryTerms.some((t) => metadata.code_type.toLowerCase().includes(t))
      ) {
        boost += boostConfig.codeTypeMatchBoost;
      }
      if (metadata.isImplementation) {
        boost += boostConfig.implementationVsDeclarationBoost;
      }
    } catch {
      // ignore
    }
  }

  return Math.min(boostConfig.maxTotalBoost, boost);
}