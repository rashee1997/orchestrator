export interface SimpleSearchQuery {
    type: 'simple_search';
    query: string;
}

export interface NlpStructuredQuery {
    type: 'nlp_structured_query';
    entities: readonly { entityType: string; value: string }[];
    relationships: readonly { source: string; target: string; relationType: string }[];
    entityTypes?: readonly string[]; // Added based on error
    filters?: Record<string, unknown>; // Added based on error
    limit?: number; // Added based on error
    intent?: string;
    sentiment?: 'positive' | 'negative' | 'neutral';
    confidence?: number; // Added to resolve error in NLPQueryProcessor.ts
}

/**
 * Enhanced structure for a parsed complex query string with relationship support
 */
export interface ParsedComplexQuery {
    type: 'parsed_complex_search';
    targetEntityType?: string;
    nameContains?: string;
    filePathCondition?: string;
    observationContains?: string[];
    idEquals?: string;
    limit?: number;
    definedInFilePath?: string;
    parentClassFullName?: string;
    // New fields for relationship traversal
    traverse?: TraverseSpec;
    // New fields for advanced operators
    logicalOperator?: 'AND' | 'OR';
    negated?: boolean;
    // New fields for fuzzy matching
    fuzzy?: boolean;
    similarity?: number; // For fuzzy matching (0-1)
}

export interface TraverseSpec {
    direction: 'outgoing' | 'incoming' | 'both';
    depth: number; // Must be non-negative
    relationTypes?: string[];
    limit?: number; // Must be non-negative
}

/**
 * Enhanced structure for relationship traversal queries
 */
export interface TraverseQuery extends TraverseSpec {
    type: 'traverse';
    startEntityId: string;
    filters?: Record<string, unknown>;
}

/**
 * Enhanced structure for queries with ranking parameters
 */
export interface RankedSearchQuery {
    type: 'ranked_search';
    query: string;
    rankBy?: 'relevance' | 'recency' | 'popularity';
    limit?: number;
}

/**
 * Union type for all possible query AST structures
 */
export type QueryAST = ParsedComplexQuery | SimpleSearchQuery | NlpStructuredQuery | TraverseQuery | RankedSearchQuery;

export type QueryType = QueryAST["type"];