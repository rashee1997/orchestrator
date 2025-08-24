import { MemoryManager } from '../memory_manager.js';
import { CodebaseEmbeddingService } from './CodebaseEmbeddingService.js';
import { IKnowledgeGraphManager } from '../factories/KnowledgeGraphFactory.js';
import { GeminiIntegrationService } from './GeminiIntegrationService.js';
import { PlanTaskManager } from '../managers/PlanTaskManager.js';
import { parseGeminiJsonResponse } from './gemini-integration-modules/GeminiResponseParsers.js';

export interface ContextRetrievalOptions {
    topKEmbeddings?: number;
    kgQueryDepth?: number;
    includeFileContent?: boolean;
    targetFilePaths?: string[];
    topKKgResults?: number;
    embeddingScoreThreshold?: number;
    useHybridSearch?: boolean;
    enableReranking?: boolean;
    maxContextLength?: number;
}

export interface RetrievedCodeContext {
    type: 'file_snippet' | 'function_definition' | 'class_definition' | 'interface_definition' | 'enum_definition' | 'type_alias_definition' | 'variable_definition' | 'kg_node_info' | 'directory_structure' | 'import_statement' | 'generic_code_chunk' | 'documentation' | 'task_log';
    sourcePath: string;
    entityName?: string;
    content: string;
    relevanceScore?: number;
    metadata?: {
        startLine?: number;
        endLine?: number;
        language?: string;
        kgNodeType?: string;
        importance_score?: number;
        code_type?: string;
        [key: string]: any;
    };
}

interface KGNode {
    node_id: string;
    name: string;
    entityType: string;
    observations: string[];
}

type QueryIntent = 'find_example' | 'refactor_code' | 'debug_error' | 'add_feature' | 'understand_code' | 'general_query';

export class CodebaseContextRetrieverService {
    private memoryManager: MemoryManager;
    private embeddingService: CodebaseEmbeddingService;
    private kgManager: IKnowledgeGraphManager;
    private geminiService: GeminiIntegrationService;
    private planTaskManager: PlanTaskManager;
    private contextCache: Map<string, { timestamp: number; data: RetrievedCodeContext[]; }>;
    private cacheTTL: number;
    private maxCacheSize: number;
    private retrievalTimeout: number;

    constructor(memoryManager: MemoryManager) {
        this.memoryManager = memoryManager;
        this.embeddingService = memoryManager.getCodebaseEmbeddingService();
        this.kgManager = memoryManager.knowledgeGraphManager;
        this.geminiService = memoryManager.getGeminiIntegrationService();
        this.planTaskManager = memoryManager.planTaskManager;
        this.contextCache = new Map<string, { timestamp: number; data: RetrievedCodeContext[]; }>();
        this.cacheTTL = 5 * 60 * 1000; // 5 minutes
        this.maxCacheSize = 1000;
        this.retrievalTimeout = 100000; // 100 seconds
    }

    private _generateCacheKey(agentId: string, prompt: string, options: ContextRetrievalOptions): string {
        // Enhanced cache key to include all relevant options
        const optionsStr = JSON.stringify({
            topKEmbeddings: options.topKEmbeddings,
            kgQueryDepth: options.kgQueryDepth,
            topKKgResults: options.topKKgResults,
            targetFilePaths: options.targetFilePaths?.sort(),
            embeddingScoreThreshold: options.embeddingScoreThreshold,
            useHybridSearch: options.useHybridSearch,
            enableReranking: options.enableReranking
        });
        return `${agentId}:${prompt}:${optionsStr}`;
    }

    private _isCacheValid(timestamp: number): boolean {
        return (Date.now() - timestamp) < this.cacheTTL;
    }

    private _cleanupCache(): void {
        if (this.contextCache.size > this.maxCacheSize) {
            const entries = Array.from(this.contextCache.entries());
            entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
            const toRemove = entries.slice(0, Math.floor(this.maxCacheSize * 0.3));
            toRemove.forEach(([key]) => this.contextCache.delete(key));
            console.log(`[CodebaseContextRetriever] Cleaned up ${toRemove.length} expired cache entries`);
        }
    }

    public async retrieveContextForPrompt(
        agentId: string,
        prompt: string,
        options: ContextRetrievalOptions = {}
    ): Promise<RetrievedCodeContext[]> {
        const cacheKey = this._generateCacheKey(agentId, prompt, options);

        // Check cache first
        const cached = this.contextCache.get(cacheKey);
        if (cached && this._isCacheValid(cached.timestamp)) {
            console.log(`[Cache HIT] Returning cached context for prompt: "${prompt.substring(0, 50)}..."`);
            return cached.data;
        }

        console.log(`Retrieving context for prompt (agent: ${agentId}): "${prompt.substring(0, 100)}..."`);

        try {
            // Set up timeout for the entire retrieval process
            const result = await Promise.race([
                this._performContextRetrieval(agentId, prompt, options),
                new Promise<RetrievedCodeContext[]>((_, reject) =>
                    setTimeout(() => reject(new Error('Context retrieval timeout')), this.retrievalTimeout)
                )
            ]);

            // Cache the result
            this.contextCache.set(cacheKey, { timestamp: Date.now(), data: result });
            this._cleanupCache();

            console.log(`[Context Retrieval] Retrieved ${result.length} context items`);

            if (result.length === 0) {
                return [{
                    type: 'documentation',
                    sourcePath: 'System Note',
                    entityName: 'No Context Found',
                    content: `The system could not find any relevant code snippets, knowledge graph entries, or documentation for the query: "${prompt}". This may be because the query is about a topic not present in the current codebase.`,
                    relevanceScore: 0.1
                }];
            }

            return result;
        } catch (error) {
            console.error(`[Context Retrieval] Error retrieving context:`, error);

            // Return cached result if available, even if expired
            if (cached) {
                console.log(`[Cache FALLBACK] Returning expired cached context due to retrieval error`);
                return cached.data;
            }

            // Return empty array if no cache available
            return [];
        }
    }

    private async _performContextRetrieval(
        agentId: string,
        prompt: string,
        options: ContextRetrievalOptions
    ): Promise<RetrievedCodeContext[]> {
        // Step 1: Intent Analysis & Keyword Extraction
        let queryIntent: QueryIntent = 'general_query';
        let keywords: string[] = [];

        try {
            queryIntent = await this.classifyQueryIntent(prompt);
            console.log(`Query Intent Classified as: ${queryIntent}`);
        } catch (error) {
            console.warn('Failed to classify query intent, using default:', error);
        }

        try {
            keywords = await this._extractKeywordsAndEntitiesWithGemini(prompt);
        } catch (error) {
            console.warn('Failed to extract keywords, using fallback:', error);
            keywords = prompt.split(/\s+/).filter((w: string) => w.length > 3);
        }

        // Step 1.5: Direct Entity Name Search
        let directEntityResults: RetrievedCodeContext[] = [];
        if (keywords.length > 0) {
            try {
                directEntityResults = await this.retrieveContextByEntityNames(agentId, keywords, options);
            } catch (error) {
                console.error('Error during direct entity name retrieval:', error);
            }
        }

        // Step 2: Intent-Driven Parallel Retrieval from Multiple Sources
        const retrievalPromises = this.getRetrievalPromisesByIntent(queryIntent, agentId, prompt, keywords, options);

        let semanticResults: RetrievedCodeContext[] = [];
        let kgResults: RetrievedCodeContext[] = [];
        let docResults: RetrievedCodeContext[] = [];
        let taskLogResults: RetrievedCodeContext[] = [];

        try {
            [semanticResults, kgResults, docResults, taskLogResults] = await Promise.allSettled(retrievalPromises)
                .then(results => results.map((result, index) => {
                    if (result.status === 'fulfilled') {
                        return result.value;
                    } else {
                        console.error(`Retrieval promise ${index} failed:`, result.reason);
                        return [];
                    }
                })) as [RetrievedCodeContext[], RetrievedCodeContext[], RetrievedCodeContext[], RetrievedCodeContext[]];
        } catch (error) {
            console.error('Error during parallel retrieval:', error);
        }

        // Step 3: Reciprocal Rank Fusion to combine results robustly
        console.log(`[Context Retrieval] Fusing results: ${directEntityResults.length} direct, ${semanticResults.length} semantic, ${kgResults.length} KG, ${docResults.length} docs, ${taskLogResults.length} logs.`);
        const fusedResults = this.reciprocalRankFusion([directEntityResults, semanticResults, kgResults, docResults, taskLogResults]);

        // Step 4: AI-powered Filtering for relevance
        let filteredResults: RetrievedCodeContext[] = [];
        try {
            filteredResults = await this.filterWithAI(prompt, fusedResults, options);
        } catch (error) {
            console.error('Error during AI filtering:', error);
            filteredResults = fusedResults.slice(0, (options.topKEmbeddings ?? 10) + (options.topKKgResults ?? 5));
        }

        // Step 5: Self-Correction: Identify and fill context gaps
        let gapFilledResults: RetrievedCodeContext[] = [];
        try {
            gapFilledResults = await this._identifyAndFillContextGaps(agentId, prompt, filteredResults, options);
        } catch (error) {
            console.error('Error during context gap filling:', error);
            gapFilledResults = filteredResults;
        }

        // Step 6: Proactive Context Expansion to fill gaps
        let finalContext: RetrievedCodeContext[] = [];
        try {
            finalContext = await this._proactiveExpansion(agentId, prompt, gapFilledResults, options);
        } catch (error) {
            console.error('Error during proactive expansion:', error);
            finalContext = gapFilledResults;
        }

        // Step 7: Final Deduplication and Limit
        const uniqueContexts = Array.from(new Map(
            finalContext.map(item => [`${item.sourcePath}#${item.content.substring(0, 100)}`, item])
        ).values());

        const limitedContext = uniqueContexts.slice(0, (options.topKEmbeddings ?? 10) + (options.topKKgResults ?? 5));

        console.log(`[Context Retrieval] Final context contains ${limitedContext.length} items.`);
        return limitedContext;
    }

    private reciprocalRankFusion(
        rankedLists: RetrievedCodeContext[][],
        k: number = 60
    ): RetrievedCodeContext[] {
        const scores: Map<string, number> = new Map();
        const items: Map<string, RetrievedCodeContext> = new Map();

        const getItemKey = (item: RetrievedCodeContext) => `${item.type}::${item.sourcePath}::${item.content.substring(0, 150)}`;

        for (const list of rankedLists) {
            if (!list || list.length === 0) continue;

            const uniqueList = Array.from(new Map(list.map(item => [getItemKey(item), item])).values());

            for (let i = 0; i < uniqueList.length; i++) {
                const item = uniqueList[i];
                const key = getItemKey(item);
                const rank = i + 1;
                const rrfScore = 1 / (k + rank);

                scores.set(key, (scores.get(key) || 0) + rrfScore);

                if (!items.has(key)) {
                    item.relevanceScore = item.relevanceScore || (1 / rank);
                    items.set(key, item);
                }
            }
        }

        return Array.from(scores.entries())
            .map(([key, score]) => {
                const item = items.get(key)!;
                item.relevanceScore = score;
                return item;
            })
            .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
    }

    private async classifyQueryIntent(prompt: string): Promise<QueryIntent> {
        const intentPrompt = `Classify the user's intent into one of the following categories: 'find_example', 'refactor_code', 'debug_error', 'add_feature', 'understand_code', 'general_query'. 
User prompt: "${prompt}"
Respond with only the category name.`;

        try {
            const response = await this.geminiService.askGemini(intentPrompt, 'gemini-2.5-flash');
            const classification = response.content[0].text?.trim().toLowerCase() as QueryIntent;

            if (['find_example', 'refactor_code', 'debug_error', 'add_feature', 'understand_code'].includes(classification)) {
                return classification;
            }
        } catch (e) {
            console.error("Error classifying query intent:", e);
        }

        return 'general_query';
    }

    private getRetrievalPromisesByIntent(
        intent: QueryIntent,
        agentId: string,
        prompt: string,
        keywords: string[],
        options: ContextRetrievalOptions
    ): Promise<RetrievedCodeContext[]>[] {
        const weights: Record<QueryIntent, number[]> = {
            'debug_error': [1.0, 0.6, 0.4, 1.0],
            'refactor_code': [0.9, 1.0, 0.5, 0.2],
            'add_feature': [0.8, 0.9, 0.7, 0.3],
            'understand_code': [0.7, 1.0, 0.8, 0.1],
            'find_example': [1.0, 0.5, 0.6, 0.1],
            'general_query': [1.0, 0.7, 0.9, 0.2],
        };

        const currentWeights = weights[intent];
        const semanticOptions = { ...options, topKEmbeddings: Math.round((options.topKEmbeddings ?? 15) * currentWeights[0]) };
        const kgOptions = { ...options, topKKgResults: Math.round((options.topKKgResults ?? 10) * currentWeights[1]) };

        console.log(`[Intent-Driven Retrieval] Intent: ${intent}, Weights: [Sem: ${currentWeights[0]}, KG: ${currentWeights[1]}, Doc: ${currentWeights[2]}, Log: ${currentWeights[3]}]`);

        return [
            currentWeights[0] > 0 ? this.performSemanticSearch(agentId, prompt, semanticOptions).catch(e => {
                console.error('Semantic search failed:', e);
                return [];
            }) : Promise.resolve([]),
            currentWeights[1] > 0 ? this.performKgSearch(agentId, prompt, kgOptions).catch(e => {
                console.error('KG search failed:', e);
                return [];
            }) : Promise.resolve([]),
            currentWeights[2] > 0 ? this.searchDocumentation(agentId, prompt, options).catch(e => {
                console.error('Documentation search failed:', e);
                return [];
            }) : Promise.resolve([]),
            currentWeights[3] > 0 ? this.searchTaskLogs(agentId, keywords, options).catch(e => {
                console.error('Task log search failed:', e);
                return [];
            }) : Promise.resolve([])
        ];
    }

    private async performSemanticSearch(agentId: string, prompt: string, options: ContextRetrievalOptions): Promise<RetrievedCodeContext[]> {
        const topK = options.topKEmbeddings ?? 15;
        if (topK === 0) return [];

        try {
            const embeddingResults = await this.embeddingService.retrieveSimilarCodeChunks(
                agentId,
                prompt,
                topK,
                options.targetFilePaths
            );

            return embeddingResults.map(res => ({
                type: (res.metadata?.type as any) || 'generic_code_chunk',
                sourcePath: res.file_path_relative,
                entityName: res.entity_name || undefined,
                content: res.chunk_text,
                relevanceScore: res.score,
                metadata: res.metadata || {},
            }));
        } catch (error) {
            console.error("Error during semantic search:", error);
            throw error;
        }
    }

    private async performKgSearch(agentId: string, prompt: string, options: ContextRetrievalOptions): Promise<RetrievedCodeContext[]> {
        const topK = options.topKKgResults ?? 10;
        if (topK === 0) return [];

        try {
            const rawKgResults = await this.kgManager.queryNaturalLanguage(agentId, prompt);
            const kgQueryResults = JSON.parse(rawKgResults);

            if (kgQueryResults && kgQueryResults.results && Array.isArray(kgQueryResults.results)) {
                return kgQueryResults.results.slice(0, topK).map((node: any, index: number) => ({
                    type: 'kg_node_info',
                    sourcePath: node.name,
                    entityName: node.entityType !== 'file' ? node.name : undefined,
                    content: `Entity Type: ${node.entityType}\nObservations:\n${(node.observations || []).join('\n- ')}`,
                    relevanceScore: 1.0 / (index + 1),
                    metadata: { kgNodeType: node.entityType }
                }));
            }
        } catch (error) {
            console.error("Error during KG search:", error);
        }

        return [];
    }

    private async searchDocumentation(agentId: string, prompt: string, options: ContextRetrievalOptions): Promise<RetrievedCodeContext[]> {
        console.log("Searching documentation (placeholder)...");
        return [];
    }

    private async searchTaskLogs(agentId: string, keywords: string[], options: ContextRetrievalOptions): Promise<RetrievedCodeContext[]> {
        console.warn("Task log search is disabled due to removal of TaskProgressLogManager.");
        return [];
    }

    private async filterWithAI(prompt: string, contexts: RetrievedCodeContext[], options: ContextRetrievalOptions): Promise<RetrievedCodeContext[]> {
        if (contexts.length === 0) return [];

        const targetPaths = options.targetFilePaths || [];

        let filterPrompt = `Given the user prompt "${prompt}", identify which of the following context items are most relevant.
Return a JSON object with a single key "relevant_indices" containing an array of the indices of the relevant items.
Example: {"relevant_indices": [0, 2, 5]}
ONLY respond with the JSON object, and nothing else.`;

        if (targetPaths.length > 0) {
            filterPrompt += `\n\n**Special Instruction:** Prioritize items from the following target file paths: ${targetPaths.join(', ')}. Ensure that relevant content from these paths is included if it directly addresses the prompt.`;
        }

        filterPrompt += `\n\nContext Items:\n${contexts.map((ctx, idx) => `Item ${idx}: [${ctx.type}] ${ctx.sourcePath} - ${ctx.content.substring(0, 150)}...`).join('\n')}`;

        try {
            const response = await this.geminiService.askGemini(filterPrompt, 'gemini-2.5-flash');
            const parsedResponse = parseGeminiJsonResponse(response.content[0].text ?? '');

            if (!parsedResponse || !Array.isArray(parsedResponse.relevant_indices)) {
                console.warn("[CodebaseContextRetrieverService] AI filtering returned malformed response. Returning top results instead.");
                return contexts.slice(0, (options.topKEmbeddings ?? 10));
            }

            const relevantIndices: number[] = parsedResponse.relevant_indices;
            let filtered = contexts.filter((_, idx) => relevantIndices.includes(idx));

            // Resilience check: If user specified target files and AI filtered them all out, add them back in.
            if (targetPaths.length > 0) {
                const targetedContexts = contexts.filter(ctx => targetPaths.includes(ctx.sourcePath));
                const filteredTargeted = filtered.filter(ctx => targetPaths.includes(ctx.sourcePath));

                if (targetedContexts.length > 0 && filteredTargeted.length === 0) {
                    console.warn(`[CodebaseContextRetrieverService] AI filtered out all targeted contexts. Re-including them.`);
                    filtered = [...filtered, ...targetedContexts];
                    // Re-deduplicate
                    filtered = Array.from(new Map(filtered.map(item => [`${item.sourcePath}#${item.content.substring(0, 100)}`, item])).values());
                }
            }

            return filtered;
        } catch (e) {
            console.error("Error filtering with AI:", e);
            // Fallback to returning a slice of the original contexts
            return contexts.slice(0, (options.topKEmbeddings ?? 10));
        }
    }

    private async _identifyAndFillContextGaps(agentId: string, prompt: string, currentContext: RetrievedCodeContext[], options: ContextRetrievalOptions): Promise<RetrievedCodeContext[]> {
        if (currentContext.length === 0) return currentContext;

        const contextSummaryForPrompt = currentContext.map(c => `[${c.type}] ${c.sourcePath} (Entity: ${c.entityName || 'N/A'}) - Snippet: ${c.content.substring(0, 100)}...`).join('\n');

        const gapAnalysisPrompt = `You are a code analysis expert. Based on the user's prompt and the provided context snippets, identify any critical missing information.
Are there any function calls, class instantiations, or type imports mentioned in the snippets for which the definition is not present?
List the exact names of these undefined entities.

User Prompt: "${prompt}"

Context Snippets:
${contextSummaryForPrompt}

Respond with a JSON object containing a single key "missing_entities" with an array of the identified names.
Example: {"missing_entities": ["UserService", "calculateTaxAmount", "IOrderDetails"]}
If no critical information is missing, respond with {"missing_entities": []}.
ONLY respond with the JSON object.`;

        try {
            const response = await this.geminiService.askGemini(gapAnalysisPrompt, 'gemini-2.5-flash');
            const parsedResponse = parseGeminiJsonResponse(response.content[0].text ?? '');

            if (!parsedResponse || !Array.isArray(parsedResponse.missing_entities) || parsedResponse.missing_entities.length === 0) {
                console.log("[Context Self-Correction] No context gaps identified.");
                return currentContext;
            }

            const missingEntities: string[] = parsedResponse.missing_entities;
            console.log("[Context Self-Correction] Identified context gaps, attempting to fill:", missingEntities);

            const gapFillingResults = await this.retrieveContextByEntityNames(agentId, missingEntities, options);

            if (gapFillingResults.length > 0) {
                console.log(`[Context Self-Correction] Found ${gapFillingResults.length} items to fill gaps.`);
                // Fuse the new results with the existing context
                const combined = this.reciprocalRankFusion([currentContext, gapFillingResults]);
                return combined;
            }

        } catch (e) {
            console.error("Error during context self-correction:", e);
        }

        return currentContext;
    }

    private async _proactiveExpansion(agentId: string, prompt: string, currentContext: RetrievedCodeContext[], options: ContextRetrievalOptions): Promise<RetrievedCodeContext[]> {
        if (currentContext.length === 0) return currentContext;

        const contextSummary = currentContext.map(c => c.sourcePath).join(', ');
        const expansionPrompt = `Based on the prompt "${prompt}" and the currently retrieved context from files (${contextSummary}), what other specific functions, classes, or files might be essential to understand the complete picture?
List the names of these related entities.
Respond with a JSON object with a key "suggested_entities" containing an array of strings.
Example: {"suggested_entities": ["DatabaseConnection", "OrderRepository"]}
ONLY respond with the JSON object.`;

        try {
            const response = await this.geminiService.askGemini(expansionPrompt, 'gemini-2.5-flash');
            const parsedResponse = parseGeminiJsonResponse(response.content[0].text ?? '');

            if (parsedResponse && Array.isArray(parsedResponse.suggested_entities) && parsedResponse.suggested_entities.length > 0) {
                const suggestions: string[] = parsedResponse.suggested_entities;
                console.log("Proactive expansion suggestions:", suggestions);
                const expansionResults = await this.retrieveContextByEntityNames(agentId, suggestions, options);
                // Combine and deduplicate
                const combined = [...currentContext, ...expansionResults];
                return Array.from(new Map(combined.map(item => [`${item.sourcePath}#${item.content.substring(0, 100)}`, item])).values());
            }
        } catch (e) {
            console.error("Error in proactive context expansion:", e);
        }

        return currentContext;
    }

    public async retrieveContextByEntityNames(agentId: string, entityNames: string[], options?: ContextRetrievalOptions): Promise<RetrievedCodeContext[]> {
        if (!entityNames || entityNames.length === 0) return [];

        // Deduplicate entity names to avoid redundant queries
        const uniqueEntityNames = [...new Set(entityNames)];

        try {
            console.log(`[retrieveContextByEntityNames] Fetching KG nodes for: ${uniqueEntityNames.join(', ')}`);
            const kgNodes = await this.kgManager.openNodes(agentId, uniqueEntityNames);

            return kgNodes.map((node: KGNode) => ({
                type: 'kg_node_info',
                sourcePath: node.name,
                entityName: node.entityType !== 'file' ? node.name : undefined,
                content: `Entity Type: ${node.entityType}\nObservations:\n${(node.observations || []).join('\n- ')}`,
                relevanceScore: 0.95, // High score as it's a direct match
                metadata: { kgNodeType: node.entityType, retrieved_by_name: true }
            }));
        } catch (error) {
            console.error("Error retrieving context by entity names:", error);
            return [];
        }
    }

    private async _extractKeywordsAndEntitiesWithGemini(prompt: string): Promise<string[]> {
        const extractionPrompt = `Extract key technical keywords and specific code entity names (file paths, function names, class names) from the following prompt.
Return a JSON object with a single key "entities" containing an array of strings.
Example: {"entities": ["src/services/api.ts", "getUserProfile", "UserProfile"]}
Prompt: "${prompt}"`;

        try {
            const result = await this.geminiService.askGemini(extractionPrompt, "gemini-2.5-flash");
            const parsedResponse = parseGeminiJsonResponse(result.content[0].text ?? '');

            if (parsedResponse && Array.isArray(parsedResponse.entities)) {
                return parsedResponse.entities;
            }
            // Fallback if parsing fails or structure is wrong
            console.warn("Failed to parse entities from Gemini, using fallback.");
            return prompt.split(/\s+/).filter((w: string) => w.length > 3 && /\w/.test(w));

        } catch (error) {
            console.error("Error extracting keywords with Gemini:", error);
        }

        return prompt.split(/\s+/).filter((w: string) => w.length > 3 && /\w/.test(w));
    }
}