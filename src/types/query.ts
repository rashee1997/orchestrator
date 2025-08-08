export interface SimpleSearchQuery {
    type: 'simple_search';
    query: string;
}

export interface NlpStructuredQuery {
    type: 'nlp_structured_query';
    entities: { type: string; value: string }[];
    relationships: { source: string; target: string; type: string }[];
    entityTypes?: string[]; // Added based on error
    filters?: Record<string, any>; // Added based on error
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
    traverse?: {
        direction: 'outgoing' | 'incoming' | 'both';
        depth: number;
        relationTypes?: string[];
    };
    // New fields for advanced operators
    operator?: 'AND' | 'OR' | 'NOT';
    // New fields for fuzzy matching
    fuzzy?: boolean;
    threshold?: number; // For fuzzy matching (0-1)
}

/**
 * Enhanced structure for relationship traversal queries
 */
export interface TraverseQuery {
    type: 'traverse';
    startEntityId: string;
    direction: 'outgoing' | 'incoming' | 'both';
    depth: number;
    relationTypes?: string[];
    limit?: number;
    filters?: Record<string, any>;
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
export type QueryAST = ParsedComplexQuery | SimpleSearchQuery | NlpStructuredQuery | TraverseQuery | RankedSearchQuery | any;