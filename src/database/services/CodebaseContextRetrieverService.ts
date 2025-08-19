import { MemoryManager } from '../memory_manager.js';
import { CodebaseEmbeddingService } from './CodebaseEmbeddingService.js';
import { IKnowledgeGraphManager } from '../factories/KnowledgeGraphFactory.js';
import { GeminiIntegrationService } from './GeminiIntegrationService.js';
import { PlanTaskManager } from '../managers/PlanTaskManager.js';
import { TaskProgressLogManager } from '../managers/TaskProgressLogManager.js';

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
    private taskProgressLogManager: TaskProgressLogManager;
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
        this.taskProgressLogManager = memoryManager.taskProgressLogManager;
        this.contextCache = new Map<string, { timestamp: number; data: RetrievedCodeContext[]; }>();
        this.cacheTTL = 5 * 60 * 1000; // 5 minutes
        this.maxCacheSize = 1000;
        this.retrievalTimeout = 100000; // 30 seconds
    }

    private _generateCacheKey(agentId: string, prompt: string, options: ContextRetrievalOptions): string {
        const optionsStr = JSON.stringify({
            topKEmbeddings: options.topKEmbeddings,
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
        console.log(`[Context Retrieval] Fusing results: ${semanticResults.length} semantic, ${kgResults.length} KG, ${docResults.length} docs, ${taskLogResults.length} logs.`);
        const fusedResults = this.reciprocalRankFusion([directEntityResults, semanticResults, kgResults, docResults, taskLogResults]);

        // Step 4: Cross-Referencing to enrich the context
        let enrichedResults: RetrievedCodeContext[] = [];
        try {
            enrichedResults = await this.performCrossReferencing(agentId, fusedResults);
        } catch (error) {
            console.error('Error during cross-referencing:', error);
            enrichedResults = fusedResults;
        }

        // Step 5: AI-powered Filtering for relevance
        let filteredResults: RetrievedCodeContext[] = [];
        try {
            filteredResults = await this.filterWithAI(prompt, enrichedResults, options);
        } catch (error) {
            console.error('Error during AI filtering:', error);
            filteredResults = enrichedResults.slice(0, options.topKEmbeddings ?? 10);
        }

        // Step 6: Proactive Context Expansion to fill gaps
        let finalContext: RetrievedCodeContext[] = [];
        try {
            finalContext = await this.proactiveExpansion(agentId, prompt, filteredResults, options);
        } catch (error) {
            console.error('Error during proactive expansion:', error);
            finalContext = filteredResults;
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
        try {
            const allLogs = await this.taskProgressLogManager.getTaskProgressLogsByAgentId(agentId, 1000);
            const relevantLogs = allLogs.filter(log =>
                keywords.some(kw => (log.change_summary_text || '').includes(kw) || (log.output_summary_or_error || '').includes(kw))
            );

            return relevantLogs.slice(0, 5).map((log, index: number) => ({
                type: 'task_log',
                sourcePath: `log_id:${log.progress_log_id}`,
                entityName: `Task: ${log.associated_task_id}`,
                content: `Log: ${log.change_summary_text}\nStatus: ${log.status_of_step_execution}\nOutput: ${log.output_summary_or_error}`,
                relevanceScore: 0.8 / (index + 1),
                metadata: { timestamp: log.execution_timestamp_iso }
            }));
        } catch (error) {
            console.error("Error searching task logs:", error);
        }

        return [];
    }

    private async performCrossReferencing(agentId: string, results: RetrievedCodeContext[]): Promise<RetrievedCodeContext[]> {
        const newResults: RetrievedCodeContext[] = [];
        const functionCallRegex = /(\w+)\s*\(/g;

        for (const res of results) {
            if (res.type === 'function_definition') {
                let match;
                const promises: Promise<RetrievedCodeContext | null>[] = [];

                while ((match = functionCallRegex.exec(res.content)) !== null) {
                    const calledFuncName = match[1];
                    promises.push(this._findFunctionDefinition(agentId, calledFuncName));
                }

                try {
                    const functionDefs = await Promise.all(promises);
                    functionDefs.forEach(def => {
                        if (def) newResults.push(def);
                    });
                } catch (error) {
                    console.error('Error during cross-referencing:', error);
                }
            }
        }

        return [...results, ...newResults];
    }

    private async _findFunctionDefinition(agentId: string, functionName: string): Promise<RetrievedCodeContext | null> {
        try {
            const kgNodes = await this.kgManager.searchNodes(agentId, `entityType:function name:${functionName}`);

            if (kgNodes.length > 0) {
                const calledFuncNode = kgNodes[0];
                return {
                    type: 'function_definition',
                    sourcePath: calledFuncNode.name,
                    entityName: calledFuncNode.name.split('::').pop(),
                    content: (calledFuncNode.observations || []).find((obs: string) => obs.startsWith('signature:')) || 'No signature found',
                    relevanceScore: 0.7,
                    metadata: { kgNodeType: 'function', crossReferenced: true }
                };
            }
        } catch (error) {
            console.error(`Error finding function definition for ${functionName}:`, error);
        }

        return null;
    }

    private async filterWithAI(prompt: string, contexts: RetrievedCodeContext[], options: ContextRetrievalOptions): Promise<RetrievedCodeContext[]> {
        if (contexts.length === 0) return [];

        const targetPaths = options.targetFilePaths || [];
        const targetedContexts = contexts.filter(ctx => targetPaths.includes(ctx.sourcePath));
        const nonTargetedContexts = contexts.filter(ctx => !targetPaths.includes(ctx.sourcePath));

        let filterPrompt = `Given the user prompt "${prompt}", identify which of the following context items are most relevant.
Return a JSON array of the indices of the relevant items. ONLY respond with the JSON array, and nothing else.`;

        if (targetPaths.length > 0) {
            filterPrompt += `\n\n**Special Instruction:** Prioritize items from the following target file paths: ${targetPaths.join(', ')}. Ensure that relevant content from these paths is included if it directly addresses the prompt.`;
        }

        filterPrompt += `\n\n${contexts.map((ctx, idx) => `Item ${idx}: [${ctx.type}] ${ctx.sourcePath} - ${ctx.content.substring(0, 100)}...`).join('\n')}`;

        try {
            const response = await this.geminiService.askGemini(filterPrompt, 'gemini-2.5-flash');
            const textResponse = response.content[0].text;
            const relevantIndices: number[] = JSON.parse(textResponse!.match(/\[(.*?)\]/s)![0]);

            let filtered = contexts.filter((_, idx) => relevantIndices.includes(idx));

            if (targetPaths.length > 0 && targetedContexts.length > 0) {
                const filteredTargeted = filtered.filter(ctx => targetPaths.includes(ctx.sourcePath));

                if (filteredTargeted.length === 0) {
                    console.warn(`[CodebaseContextRetrieverService] AI filtered out all targeted contexts. Re-including them.`);
                    filtered = [...filtered, ...targetedContexts];
                    filtered = Array.from(new Map(filtered.map(item => [`${item.sourcePath}#${item.content.substring(0, 100)}`, item])).values());
                }
            }

            return filtered;
        } catch (e) {
            console.error("Error filtering with AI:", e);
            return contexts;
        }
    }

    private async proactiveExpansion(agentId: string, prompt: string, currentContext: RetrievedCodeContext[], options: ContextRetrievalOptions): Promise<RetrievedCodeContext[]> {
        if (currentContext.length === 0) return currentContext;

        const contextSummary = currentContext.map(c => c.sourcePath).join(', ');
        const expansionPrompt = `Based on the prompt "${prompt}" and the currently retrieved context (${contextSummary}), what other specific functions, classes, or files might be essential to understand? Answer with a short list of names.`;

        try {
            const response = await this.geminiService.askGemini(expansionPrompt, 'gemini-2.5-flash');
            const suggestions = response.content[0].text?.split(',').map(s => s.trim()).filter(Boolean);

            if (suggestions && suggestions.length > 0) {
                console.log("Proactive expansion suggestions:", suggestions);
                const expansionResults = await this.retrieveContextByEntityNames(agentId, suggestions, options);
                return [...currentContext, ...expansionResults];
            }
        } catch (e) {
            console.error("Error in proactive context expansion:", e);
        }

        return currentContext;
    }

    public async retrieveContextByEntityNames(agentId: string, entityNames: string[], options?: ContextRetrievalOptions): Promise<RetrievedCodeContext[]> {
        if (!entityNames || entityNames.length === 0) return [];

        try {
            const kgNodes = await this.kgManager.openNodes(agentId, entityNames);

            return kgNodes.map((node: KGNode) => ({
                type: 'kg_node_info',
                sourcePath: node.name,
                entityName: node.entityType !== 'file' ? node.name : undefined,
                content: `Entity Type: ${node.entityType}\nObservations:\n${(node.observations || []).join('\n- ')}`,
                relevanceScore: 0.9,
                metadata: { kgNodeType: node.entityType }
            }));
        } catch (error) {
            console.error("Error retrieving context by entity names:", error);
            return [];
        }
    }

    private async _extractKeywordsAndEntitiesWithGemini(prompt: string): Promise<string[]> {
        const extractionPrompt = `Extract key technical keywords and specific code entity names (file paths, function names, class names) from the following prompt. Return a JSON array of strings. Prompt: "${prompt}"`;

        try {
            const result = await this.geminiService.askGemini(extractionPrompt, "gemini-2.5-flash");
            const textResponse = result.content[0].text ?? '';
            const jsonMatch = textResponse.match(/\[.*?\]/s);

            if (jsonMatch) {
                let jsonString = jsonMatch[0];
                jsonString = jsonString.replace(/\/\/.*$/gm, '');
                jsonString = jsonString.replace(/,(\s*[\]\}])/g, '$1');

                try {
                    return JSON.parse(jsonString);
                } catch (parseError) {
                    console.error("JSON parse error in _extractKeywordsAndEntitiesWithGemini:", parseError);
                    return prompt.split(/\s+/).filter((w: string) => w.length > 3);
                }
            }
        } catch (error) {
            console.error("Error extracting keywords with Gemini:", error);
        }

        return prompt.split(/\s+/).filter((w: string) => w.length > 3);
    }
}