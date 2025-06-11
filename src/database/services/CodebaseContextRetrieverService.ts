// src/services/CodebaseContextRetrieverService.ts
import { MemoryManager } from '../memory_manager.js';
import { CodebaseEmbeddingService } from './CodebaseEmbeddingService.js';
import { IKnowledgeGraphManager } from '../factories/KnowledgeGraphFactory.js';
import { GeminiIntegrationService } from './GeminiIntegrationService.js';
import { PlanTaskManager } from '../managers/PlanTaskManager.js';
import { TaskProgressLogManager } from '../managers/TaskProgressLogManager.js';

/**
 * Options for configuring context retrieval.
 */
export interface ContextRetrievalOptions {
    topKEmbeddings?: number;
    kgQueryDepth?: number;
    includeFileContent?: boolean;
    targetFilePaths?: string[];
    topKKgResults?: number;
    embeddingScoreThreshold?: number;
}

/**
 * Represents a piece of retrieved codebase context.
 */
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

/**
 * Represents a Knowledge Graph node structure as returned by KnowledgeGraphManager.
 */
interface KGNode {
    node_id: string;
    name: string;
    entityType: string;
    observations: string[];
}

type QueryIntent = 'find_example' | 'refactor_code' | 'debug_error' | 'add_feature' | 'understand_code' | 'general_query';


/**
 * Service responsible for retrieving relevant codebase context.
 * It uses semantic search, structured KG queries, and AI-powered ranking and filtering.
 */
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

    /**
     * Retrieves relevant codebase context based on a natural language prompt.
     * This method orchestrates calls to semantic search, KG queries, and other sources.
     */
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
        
        // Phase 1: Query Intent Classification
        const queryIntent = await this.classifyQueryIntent(prompt);
        console.log(`Query Intent Classified as: ${queryIntent}`);

        const keywords = await this._extractKeywordsAndEntitiesWithGemini(prompt);
        
        // Phase 1 & 2: Perform initial retrieval from multiple sources
        const semanticResults = await this.performSemanticSearch(agentId, prompt, options, queryIntent);
        const kgResults = await this.performKgSearch(agentId, prompt, options);
        const docResults = await this.searchDocumentation(agentId, prompt, options);
        const taskLogResults = await this.searchTaskLogs(agentId, keywords, options);
        
        let combinedResults = [...semanticResults, ...kgResults, ...docResults, ...taskLogResults];

        // Phase 1 & 2: Hybrid Scoring and Cross-Referencing
        let rankedResults = this.hybridScoring(combinedResults, kgResults);
        rankedResults = await this.performCrossReferencing(agentId, rankedResults);

        // Phase 1: Negative Filtering (AI-powered)
        const filteredResults = await this.filterWithAI(prompt, rankedResults);

        // Phase 3: Proactive Context Expansion
        const finalContext = await this.proactiveExpansion(agentId, prompt, filteredResults, options);
        
        // Final deduplication and limit
        const uniqueContexts = Array.from(new Map(finalContext.map(item => [`${item.sourcePath}#${item.content.substring(0, 100)}`, item])).values());
        const limitedContext = uniqueContexts.slice(0, (options.topKEmbeddings ?? 10) + (options.topKKgResults ?? 5));
        
        this.contextCache.set(cacheKey, limitedContext); // Cache the final result
        console.log(`[Context Retrieval] Final context contains ${limitedContext.length} items.`);
        return limitedContext;
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
        const topK = intent === 'find_example' ? 3 : options.topKEmbeddings ?? 5;
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
                return kgQueryResults.results.slice(0, options.topKKgResults ?? 5).map((node: any) => ({
                    type: 'kg_node_info',
                    sourcePath: node.name,
                    entityName: node.entityType !== 'file' ? node.name : undefined,
                    content: `Entity Type: ${node.entityType}\nObservations:\n${(node.observations || []).join('\n- ')}`,
                    relevanceScore: 0.75, // Base score for KG results
                    metadata: { kgNodeType: node.entityType }
                }));
            }
        } catch (error) {
            console.error("Error during KG search:", error);
        }
        return [];
    }
    
    private async searchDocumentation(agentId: string, prompt: string, options: ContextRetrievalOptions): Promise<RetrievedCodeContext[]> {
        // This is a placeholder. A real implementation would query embeddings filtered by file type (.md).
        console.log("Searching documentation (placeholder)...");
        return [];
    }

    private async searchTaskLogs(agentId: string, keywords: string[], options: ContextRetrievalOptions): Promise<RetrievedCodeContext[]> {
        try {
            const allLogs = await this.taskProgressLogManager.getTaskProgressLogsByAgentId(agentId, 1000);
            const relevantLogs = allLogs.filter(log =>
                keywords.some(kw => (log.change_summary_text || '').includes(kw) || (log.output_summary_or_error || '').includes(kw))
            );
            return relevantLogs.slice(0, 3).map(log => ({
                type: 'task_log',
                sourcePath: `log_id:${log.progress_log_id}`,
                entityName: `Task: ${log.associated_task_id}`,
                content: `Log: ${log.change_summary_text}\nStatus: ${log.status_of_step_execution}\nOutput: ${log.output_summary_or_error}`,
                relevanceScore: 0.7,
                metadata: { timestamp: log.execution_timestamp_iso }
            }));
        } catch (error) {
            console.error("Error searching task logs:", error);
        }
        return [];
    }
    
    private hybridScoring(combinedResults: RetrievedCodeContext[], kgResults: RetrievedCodeContext[]): RetrievedCodeContext[] {
        const kgSourcePaths = new Set(kgResults.map(r => r.sourcePath));
        combinedResults.forEach(res => {
            if (kgSourcePaths.has(res.sourcePath)) {
                res.relevanceScore = (res.relevanceScore || 0.7) * 1.2; // Boost score for items in both sets
            }
        });
        return combinedResults.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
    }

    private async performCrossReferencing(agentId: string, results: RetrievedCodeContext[]): Promise<RetrievedCodeContext[]> {
        const newResults: RetrievedCodeContext[] = [];
        const functionCallRegex = /(\w+)\s*\(/g; // Simple regex for function calls

        for (const res of results) {
            if (res.type === 'function_definition') {
                let match;
                while ((match = functionCallRegex.exec(res.content)) !== null) {
                    const calledFuncName = match[1];
                    // Query KG to find the definition of the called function
                    const kgNodes = await this.kgManager.searchNodes(agentId, `entityType:function name:${calledFuncName}`);
                    if (kgNodes.length > 0) {
                        const calledFuncNode = kgNodes[0];
                        newResults.push({
                            type: 'function_definition',
                            sourcePath: calledFuncNode.name, // This is the full KG name/path
                            entityName: calledFuncNode.name.split('::').pop(),
                            content: (calledFuncNode.observations || []).find((obs: string) => obs.startsWith('signature:')) || 'No signature found',
                            relevanceScore: (res.relevanceScore || 0) * 0.9, // Slightly lower score for cross-referenced items
                            metadata: { kgNodeType: 'function', crossReferenced: true }
                        });
                    }
                }
            }
        }
        return [...results, ...newResults];
    }
    
    private async filterWithAI(prompt: string, contexts: RetrievedCodeContext[]): Promise<RetrievedCodeContext[]> {
        if (contexts.length === 0) return [];
        const contextSummary = contexts.map((ctx, idx) => `Item ${idx}: [${ctx.type}] ${ctx.sourcePath} - ${ctx.content.substring(0, 100)}...`).join('\n');
        const filterPrompt = `Given the user prompt "${prompt}", identify which of the following context items are most relevant. Return a JSON array of the indices of the relevant items. \n\n${contextSummary}`;
        try {
            const response = await this.geminiService.askGemini(filterPrompt, 'gemini-1.5-flash-latest');
            const textResponse = response.content[0].text;
            const relevantIndices: number[] = JSON.parse(textResponse!.match(/\[(.*?)\]/s)![0]);
            return contexts.filter((_, idx) => relevantIndices.includes(idx));
        } catch (e) {
            console.error("Error filtering with AI:", e);
            return contexts; // Fallback to unfiltered on error
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
                relevanceScore: 0.9, // High score as it's a direct lookup
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
                // Remove single-line comments (// ...) that might be present in the JSON string
                jsonString = jsonString.replace(/\/\/.*$/gm, '');
                // Remove trailing commas before closing brackets to fix invalid JSON
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
        // Fallback to basic extraction
        return prompt.split(/\s+/).filter((w: string) => w.length > 3);
    }
}
