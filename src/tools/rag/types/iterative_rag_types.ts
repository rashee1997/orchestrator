import { RetrievedCodeContext, ContextRetrievalOptions } from '../../../database/services/CodebaseContextRetrieverService.js';
import { RagAnalysisResponse } from '../rag_response_parser.js';

export interface Citation {
    id: string;
    source: string;
    sourceType: 'code' | 'documentation' | 'web' | 'knowledge_graph';
    title: string;
    url?: string;
    filePath?: string;
    lineNumbers?: [number, number];
    confidence: number;
    relevanceScore: number;
    extractedText: string;
    context?: string;
}

export interface ReflectionResult {
    hasHallucinations: boolean;
    missingInfo: string[];
    qualityScore: number;
    suggestions: string[];
    corrections: string[];
    confidence: number;
}

export interface AgenticRagPlan {
    strategy: 'vector_search' | 'graph_traversal' | 'hybrid_search' | 'web_augmented' | 'corrective_search';
    steps: Array<{
        action: string;
        target: string;
        priority: number;
        reasoning: string;
    }>;
    expectedOutcome: string;
    fallbackStrategy?: string;
}

export interface IterativeRagResult {
    accumulatedContext: RetrievedCodeContext[];
    webSearchSources: { title: string; url: string }[];
    finalAnswer?: string;
    decisionLog: RagAnalysisResponse[];
    citations: Citation[];
    reflectionResults: ReflectionResult[];
    agenticPlan?: AgenticRagPlan;
    searchMetrics: {
        totalIterations: number;
        contextItemsAdded: number;
        webSearchesPerformed: number;
        hallucinationChecksPerformed: number;
        selfCorrectionLoops: number;
        terminationReason: string;
        graphTraversals: number;
        hybridSearches: number;
        citationAccuracy: number;
        citationCoverage: number;
        totalCitationsGenerated: number;
        totalCitationsUsed: number;
        dmqr: {
            enabled: boolean;
            queryCount?: number;
            generatedQueries?: string[];
            success: boolean;
            contextItemsGenerated: number;
            error?: string;
        };
        turnLog: Array<{
            turn: number;
            query: string;
            strategy: string;
            newContextCount: number;
            decision: string;
            reasoning: string;
            type: 'initial' | 'iterative' | 'self-correction' | 'agentic-plan' | 'reflection' | 'early_termination' | 'stability_termination' | 'hybrid_intervention' | 'hybrid_override';
            quality: number;
            citations: number;
        }>;
    };
}

export interface IterativeRagArgs {
    agent_id: string;
    query: string;
    model?: string;
    systemInstruction?: string;
    context_options?: ContextRetrievalOptions;
    focus_area?: string;
    analysis_focus_points?: string[];
    enable_web_search?: boolean;
    google_search?: boolean;
    continue_session?: boolean;
    max_iterations?: number;
    hallucination_check_threshold?: number;
    tavily_search_depth?: 'basic' | 'advanced';
    tavily_max_results?: number;
    tavily_include_raw_content?: boolean;
    tavily_include_images?: boolean;
    tavily_include_image_descriptions?: boolean;
    tavily_time_period?: string;
    tavily_topic?: string;
    thinkingConfig?: { thinkingBudget?: number; thinkingMode?: 'AUTO' | 'MODE_THINK' };
    enable_dmqr?: boolean;
    dmqr_query_count?: number;
    enable_agentic_planning?: boolean;
    enable_reflection?: boolean;
    enable_hybrid_search?: boolean;
    enable_long_rag?: boolean;
    enable_corrective_rag?: boolean;
    citation_accuracy_threshold?: number;
    long_rag_chunk_size?: number;
    reflection_frequency?: number;
}