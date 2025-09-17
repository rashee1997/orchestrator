import { GeminiIntegrationService } from '../../database/services/GeminiIntegrationService.js';
import { parseGeminiJsonResponse, parseGeminiJsonResponseSync } from '../../database/services/gemini-integration-modules/GeminiResponseParsers.js';
import { getCurrentModel } from '../../database/services/gemini-integration-modules/GeminiConfig.js';

export interface KnowledgeGraphQuery {
    query: string;
    entityTypes: string[];
    relationTypes: string[];
    searchStrategy: 'semantic' | 'structural' | 'hybrid' | 'traversal';
    searchDepth?: number;
    focusAreas: string[];
    confidence: number;
}

export interface KGQueryProducerOptions {
    queryCount?: number;
    entityTypePreference?: string[];
    relationTypePreference?: string[];
    searchDepthLimit?: number;
    enableStructuralAnalysis?: boolean;
}

export interface KGQueryResult {
    structuralQueries: KnowledgeGraphQuery[];
    semanticQueries: KnowledgeGraphQuery[];
    hybridQueries: KnowledgeGraphQuery[];
    queryAnalysis: {
        originalIntent: string;
        structuralComplexity: 'simple' | 'moderate' | 'complex';
        recommendedStrategy: string;
    };
}

export class KnowledgeGraphQueryProducer {
    private geminiService: GeminiIntegrationService;

    constructor(geminiService: GeminiIntegrationService) {
        this.geminiService = geminiService;
    }

    /**
     * Generate specialized Knowledge Graph queries optimized for graph structure understanding
     */
    async generateKGQueries(
        originalQuery: string,
        options: KGQueryProducerOptions = {}
    ): Promise<KGQueryResult> {
        const queryCount = options.queryCount || 3;
        console.log(`[KG Query Producer] Generating ${queryCount} specialized KG queries for: "${originalQuery}"`);

        // Step 1: Analyze the query for graph-specific patterns
        const queryAnalysis = await this.analyzeQueryForGraphPatterns(originalQuery);
        
        // Step 2: Generate different types of KG queries
        const [structuralQueries, semanticQueries, hybridQueries] = await Promise.all([
            this.generateStructuralQueries(originalQuery, queryAnalysis, options),
            this.generateSemanticQueries(originalQuery, queryAnalysis, options),
            this.generateHybridQueries(originalQuery, queryAnalysis, options)
        ]);

        console.log(`[KG Query Producer] Generated ${structuralQueries.length} structural, ${semanticQueries.length} semantic, ${hybridQueries.length} hybrid queries`);

        return {
            structuralQueries,
            semanticQueries,
            hybridQueries,
            queryAnalysis
        };
    }

    /**
     * Analyze the original query to understand graph-specific patterns and requirements
     */
    private async analyzeQueryForGraphPatterns(originalQuery: string): Promise<any> {
        const analysisPrompt = `
Analyze this codebase query for Knowledge Graph search patterns and requirements:

Query: "${originalQuery}"

Provide a JSON analysis with:
1. "originalIntent": What the user is trying to find/understand
2. "structuralComplexity": "simple", "moderate", or "complex" based on graph traversal needs
3. "entityTypesLikely": Array of entity types that might be relevant (files, classes, functions, modules, etc.)
4. "relationTypesLikely": Array of relationship types that might be relevant (imports, inherits, calls, contains, etc.)
5. "graphPatterns": Array of graph patterns that might help (tree_traversal, dependency_chain, hierarchical_search, etc.)
6. "searchDepthEstimate": Estimated optimal search depth (1-5)
7. "recommendedStrategy": Best search approach for this query
8. "keyTermsForMatching": Important terms for semantic matching

Example:
{
  "originalIntent": "Find all functions related to iterative RAG processing",
  "structuralComplexity": "moderate",
  "entityTypesLikely": ["function", "class", "file", "module"],
  "relationTypesLikely": ["calls", "imports", "contains", "depends_on"],
  "graphPatterns": ["dependency_chain", "functional_cluster"],
  "searchDepthEstimate": 3,
  "recommendedStrategy": "hybrid",
  "keyTermsForMatching": ["iterative", "RAG", "processing", "orchestrator"]
}`;

        try {
            const response = await this.geminiService.askGemini(analysisPrompt, getCurrentModel());
            const analysis = parseGeminiJsonResponseSync(response.content[0].text ?? '{}');
            
            return {
                originalIntent: analysis.originalIntent || 'General codebase search',
                structuralComplexity: analysis.structuralComplexity || 'simple',
                entityTypesLikely: analysis.entityTypesLikely || ['file', 'function'],
                relationTypesLikely: analysis.relationTypesLikely || ['imports', 'contains'],
                graphPatterns: analysis.graphPatterns || ['semantic_search'],
                searchDepthEstimate: analysis.searchDepthEstimate || 2,
                recommendedStrategy: analysis.recommendedStrategy || 'semantic',
                keyTermsForMatching: analysis.keyTermsForMatching || []
            };
        } catch (error) {
            console.warn('[KG Query Producer] Query analysis failed, using defaults:', error);
            return {
                originalIntent: 'General codebase search',
                structuralComplexity: 'simple',
                entityTypesLikely: ['file', 'function'],
                relationTypesLikely: ['imports', 'contains'],
                graphPatterns: ['semantic_search'],
                searchDepthEstimate: 2,
                recommendedStrategy: 'semantic',
                keyTermsForMatching: originalQuery.split(' ')
            };
        }
    }

    /**
     * Generate queries focused on graph structure and relationships
     */
    private async generateStructuralQueries(
        originalQuery: string,
        analysis: any,
        options: KGQueryProducerOptions
    ): Promise<KnowledgeGraphQuery[]> {
        const structuralPrompt = `
Generate specialized structural Knowledge Graph queries for: "${originalQuery}"

Context Analysis:
- Intent: ${analysis.originalIntent}
- Complexity: ${analysis.structuralComplexity}
- Key Entity Types: ${analysis.entityTypesLikely.join(', ')}
- Key Relations: ${analysis.relationTypesLikely.join(', ')}

Create 2-3 structural queries that focus on:
1. Graph traversal and relationship following
2. Entity hierarchy and containment structures
3. Dependency chains and call graphs

Each query should be optimized for finding structural patterns in the codebase graph.

Return JSON:
{
  "queries": [
    {
      "query": "traversal-optimized query string",
      "entityTypes": ["relevant", "entity", "types"],
      "relationTypes": ["relevant", "relation", "types"],
      "searchStrategy": "structural",
      "searchDepth": 2-4,
      "focusAreas": ["specific", "focus", "areas"],
      "confidence": 0.7-1.0
    }
  ]
}`;

        try {
            const response = await this.geminiService.askGemini(structuralPrompt, getCurrentModel());
            const result = parseGeminiJsonResponseSync(response.content[0].text ?? '{}');
            
            return (result.queries || []).map((q: any) => ({
                query: q.query || originalQuery,
                entityTypes: q.entityTypes || analysis.entityTypesLikely,
                relationTypes: q.relationTypes || analysis.relationTypesLikely,
                searchStrategy: 'structural' as const,
                searchDepth: q.searchDepth || analysis.searchDepthEstimate,
                focusAreas: q.focusAreas || ['structure'],
                confidence: q.confidence || 0.7
            }));
        } catch (error) {
            console.warn('[KG Query Producer] Structural query generation failed:', error);
            return [{
                query: `${originalQuery} structural relationships`,
                entityTypes: analysis.entityTypesLikely,
                relationTypes: analysis.relationTypesLikely,
                searchStrategy: 'structural',
                searchDepth: analysis.searchDepthEstimate,
                focusAreas: ['structure', 'relationships'],
                confidence: 0.5
            }];
        }
    }

    /**
     * Generate queries focused on semantic meaning and content
     */
    private async generateSemanticQueries(
        originalQuery: string,
        analysis: any,
        options: KGQueryProducerOptions
    ): Promise<KnowledgeGraphQuery[]> {
        const semanticPrompt = `
Generate specialized semantic Knowledge Graph queries for: "${originalQuery}"

Context Analysis:
- Intent: ${analysis.originalIntent}
- Key Terms: ${analysis.keyTermsForMatching.join(', ')}
- Entity Types: ${analysis.entityTypesLikely.join(', ')}

Create 2-3 semantic queries that focus on:
1. Content meaning and conceptual matching
2. Functional purpose and behavior understanding
3. Similar or related functionality identification

Each query should be optimized for semantic search within the knowledge graph.

Return JSON:
{
  "queries": [
    {
      "query": "semantic-optimized query string",
      "entityTypes": ["relevant", "entity", "types"],
      "relationTypes": ["relevant", "relation", "types"],
      "searchStrategy": "semantic",
      "focusAreas": ["specific", "focus", "areas"],
      "confidence": 0.7-1.0
    }
  ]
}`;

        try {
            const response = await this.geminiService.askGemini(semanticPrompt, getCurrentModel());
            const result = parseGeminiJsonResponseSync(response.content[0].text ?? '{}');
            
            return (result.queries || []).map((q: any) => ({
                query: q.query || originalQuery,
                entityTypes: q.entityTypes || analysis.entityTypesLikely,
                relationTypes: q.relationTypes || analysis.relationTypesLikely,
                searchStrategy: 'semantic' as const,
                searchDepth: 1,
                focusAreas: q.focusAreas || ['content'],
                confidence: q.confidence || 0.8
            }));
        } catch (error) {
            console.warn('[KG Query Producer] Semantic query generation failed:', error);
            return [{
                query: `${originalQuery} functionality and purpose`,
                entityTypes: analysis.entityTypesLikely,
                relationTypes: ['semantic_similarity'],
                searchStrategy: 'semantic',
                searchDepth: 1,
                focusAreas: ['content', 'functionality'],
                confidence: 0.6
            }];
        }
    }

    /**
     * Generate hybrid queries that combine structural and semantic approaches
     */
    private async generateHybridQueries(
        originalQuery: string,
        analysis: any,
        options: KGQueryProducerOptions
    ): Promise<KnowledgeGraphQuery[]> {
        const hybridPrompt = `
Generate hybrid Knowledge Graph queries that combine structural and semantic approaches for: "${originalQuery}"

Context Analysis:
- Intent: ${analysis.originalIntent}
- Recommended Strategy: ${analysis.recommendedStrategy}
- Graph Patterns: ${analysis.graphPatterns.join(', ')}

Create 1-2 hybrid queries that:
1. Use both structural traversal AND semantic matching
2. Find related entities through both relationships and content similarity
3. Balance graph exploration with meaning-based filtering

Return JSON:
{
  "queries": [
    {
      "query": "hybrid-optimized query string",
      "entityTypes": ["relevant", "entity", "types"],
      "relationTypes": ["relevant", "relation", "types"],
      "searchStrategy": "hybrid",
      "searchDepth": 2-3,
      "focusAreas": ["specific", "focus", "areas"],
      "confidence": 0.8-1.0
    }
  ]
}`;

        try {
            const response = await this.geminiService.askGemini(hybridPrompt, getCurrentModel());
            const result = parseGeminiJsonResponseSync(response.content[0].text ?? '{}');
            
            return (result.queries || []).map((q: any) => ({
                query: q.query || originalQuery,
                entityTypes: q.entityTypes || analysis.entityTypesLikely,
                relationTypes: q.relationTypes || analysis.relationTypesLikely,
                searchStrategy: 'hybrid' as const,
                searchDepth: q.searchDepth || 2,
                focusAreas: q.focusAreas || ['structure', 'content'],
                confidence: q.confidence || 0.9
            }));
        } catch (error) {
            console.warn('[KG Query Producer] Hybrid query generation failed:', error);
            return [{
                query: `${originalQuery} related components and structure`,
                entityTypes: analysis.entityTypesLikely,
                relationTypes: analysis.relationTypesLikely,
                searchStrategy: 'hybrid',
                searchDepth: 2,
                focusAreas: ['structure', 'content', 'relationships'],
                confidence: 0.7
            }];
        }
    }
}