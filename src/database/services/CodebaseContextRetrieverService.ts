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
    private contextCache = new Map<string, RetrievedCodeContext[]>();

    constructor(memoryManager: MemoryManager) {
        this.memoryManager = memoryManager;
        this.embeddingService = memoryManager.getCodebaseEmbeddingService();
        this.kgManager = memoryManager.knowledgeGraphManager;
        this.geminiService = memoryManager.getGeminiIntegrationService();
        this.planTaskManager = memoryManager.planTaskManager;
        this.taskProgressLogManager = memoryManager.taskProgressLogManager;
    }

    public async retrieveContextForPrompt(
        agentId: string,
        prompt: string,
        options: ContextRetrievalOptions = {}
    ): Promise<RetrievedCodeContext[]> {
        const cacheKey = `${agentId}:${prompt}:${JSON.stringify(options)}`;
        if (this.contextCache.has(cacheKey)) {
            console.log(`[Cache HIT] Returning cached context for prompt: "${prompt.substring(0, 50)}..."`);
            return this.contextCache.get(cacheKey)!;
        }

        console.log(`Retrieving context for prompt (agent: ${agentId}): "${prompt.substring(0, 100)}..."`);

        // Step 1: Intent Analysis & Keyword Extraction
        const queryIntent = await this.classifyQueryIntent(prompt);
        console.log(`Query Intent Classified as: ${queryIntent}`);
        const keywords = await this._extractKeywordsAndEntitiesWithGemini(prompt);

        // Step 2: Parallel Retrieval from Multiple Sources
        const [semanticResults, kgResults, docResults, taskLogResults] = await Promise.all([
            this.performSemanticSearch(agentId, prompt, options, queryIntent),
            this.performKgSearch(agentId, prompt, options),
            this.searchDocumentation(agentId, prompt, options),
            this.searchTaskLogs(agentId, keywords, options)
        ]);

        // Step 3: Reciprocal Rank Fusion to combine results robustly
        console.log(`[Context Retrieval] Fusing results: ${semanticResults.length} semantic, ${kgResults.length} KG, ${docResults.length} docs, ${taskLogResults.length} logs.`);
        const fusedResults = this.reciprocalRankFusion([semanticResults, kgResults, docResults, taskLogResults]);

        // Step 4: Cross-Referencing to enrich the context
        let enrichedResults = await this.performCrossReferencing(agentId, fusedResults);

        // Step 5: AI-powered Filtering for relevance
        const filteredResults = await this.filterWithAI(prompt, enrichedResults, options);

        // Step 6: Proactive Context Expansion to fill gaps
        const finalContext = await this.proactiveExpansion(agentId, prompt, filteredResults, options);

        // Step 7: Final Deduplication and Limit
        const uniqueContexts = Array.from(new Map(finalContext.map(item => [`${item.sourcePath}#${item.content.substring(0, 100)}`, item])).values());
        const limitedContext = uniqueContexts.slice(0, (options.topKEmbeddings ?? 10) + (options.topKKgResults ?? 5));

        this.contextCache.set(cacheKey, limitedContext);
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
        const intentPrompt = `Classify the user's intent into one of the following categories: 'find_example', 'refactor_code', 'debug_error', 'add_feature', 'understand_code', 'general_query'. User prompt: "${prompt}"`;
        try {
            const response = await this.geminiService.askGemini(intentPrompt, 'gemini-1.5-flash-latest');
            const classification = response.content[0].text?.trim().toLowerCase() as QueryIntent;
            if (['find_example', 'refactor_code', 'debug_error', 'add_feature', 'understand_code'].includes(classification)) {
                return classification;
            }
        } catch (e) {
            console.error("Error classifying query intent:", e);
        }
        return 'general_query';
    }

    private async performSemanticSearch(agentId: string, prompt: string, options: ContextRetrievalOptions, intent: QueryIntent): Promise<RetrievedCodeContext[]> {
        const topK = options.topKEmbeddings ?? 15;
        try {
            const embeddingResults = await this.embeddingService.retrieveSimilarCodeChunks(agentId, prompt, topK, options.targetFilePaths);
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
            return [];
        }
    }

    private async performKgSearch(agentId: string, prompt: string, options: ContextRetrievalOptions): Promise<RetrievedCodeContext[]> {
        try {
            const rawKgResults = await this.kgManager.queryNaturalLanguage(agentId, prompt);
            const kgQueryResults = JSON.parse(rawKgResults);

            if (kgQueryResults && kgQueryResults.results && Array.isArray(kgQueryResults.results)) {
                return kgQueryResults.results.slice(0, options.topKKgResults ?? 10).map((node: any, index: number) => ({
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
                while ((match = functionCallRegex.exec(res.content)) !== null) {
                    const calledFuncName = match[1];
                    const kgNodes = await this.kgManager.searchNodes(agentId, `entityType:function name:${calledFuncName}`);
                    if (kgNodes.length > 0) {
                        const calledFuncNode = kgNodes[0];
                        newResults.push({
                            type: 'function_definition',
                            sourcePath: calledFuncNode.name,
                            entityName: calledFuncNode.name.split('::').pop(),
                            content: (calledFuncNode.observations || []).find((obs: string) => obs.startsWith('signature:')) || 'No signature found',
                            relevanceScore: (res.relevanceScore || 0) * 0.9,
                            metadata: { kgNodeType: 'function', crossReferenced: true }
                        });
                    }
                }
            }
        }
        return [...results, ...newResults];
    }

    private async filterWithAI(prompt: string, contexts: RetrievedCodeContext[], options: ContextRetrievalOptions): Promise<RetrievedCodeContext[]> {
        if (contexts.length === 0) return [];

        const targetPaths = options.targetFilePaths || [];
        const targetedContexts = contexts.filter(ctx => targetPaths.includes(ctx.sourcePath));
        const nonTargetedContexts = contexts.filter(ctx => !targetPaths.includes(ctx.sourcePath));

        let filterPrompt = `Given the user prompt "${prompt}", identify which of the following context items are most relevant.`;
        if (targetPaths.length > 0) {
            filterPrompt += `\n\n**Special Instruction:** Prioritize items from the following target file paths: ${targetPaths.join(', ')}. Ensure that relevant content from these paths is included if it directly addresses the prompt.`;
        }
        filterPrompt += `\n\nReturn a JSON array of the indices of the relevant items.\n\n`;

        const contextSummary = contexts.map((ctx, idx) => `Item ${idx}: [${ctx.type}] ${ctx.sourcePath} - ${ctx.content.substring(0, 100)}...`).join('\n');
        filterPrompt += contextSummary;

        try {
            const response = await this.geminiService.askGemini(filterPrompt, 'gemini-1.5-flash-latest');
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
        const contextSummary = currentContext.map(c => c.sourcePath).join(', ');
        const expansionPrompt = `Based on the prompt "${prompt}" and the currently retrieved context (${contextSummary}), what other specific functions, classes, or files might be essential to understand? Answer with a short list of names.`;
        try {
            const response = await this.geminiService.askGemini(expansionPrompt, 'gemini-1.5-flash-latest');
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
            const result = await this.geminiService.askGemini(extractionPrompt, "gemini-1.5-flash-latest");
            const textResponse = result.content[0].text ?? '';
            const jsonMatch = textResponse.match(/\[.*?\]/s);
            if (jsonMatch) {
                let jsonString = jsonMatch[0];
                jsonString = jsonString.replace(/\/\/.*$/gm, '');
                jsonString = jsonString.replace(/,(\s*[\]\}])/g, '$1');
                try {
                    return JSON.parse(jsonString);
                } catch (parseError) {
                    console.error("JSON parse error in _extractKeywordsAndEntitiesWithGemini. JSON string was:", jsonString);
                    throw parseError;
                }
            }
        } catch (error) {
            console.error("Error extracting keywords with Gemini:", error);
        }
        return prompt.split(/\s+/).filter((w: string) => w.length > 3);
    }
}