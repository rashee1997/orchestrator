import { MemoryManager } from '../../database/memory_manager.js';
import { GeminiIntegrationService } from '../../database/services/GeminiIntegrationService.js';
import { RetrievedCodeContext } from '../../database/services/CodebaseContextRetrieverService.js';
import { ContextRetrievalOptions } from '../../database/services/CodebaseContextRetrieverService.js';
import { RagPromptTemplates } from './rag_prompt_templates.js';
import { RagAnalysisResponse, RagResponseParser } from './rag_response_parser.js';
import { callTavilyApi } from '../../integrations/tavily.js';
import { formatRetrievedContextForPrompt as formatContextForGemini } from '../../database/services/gemini-integration-modules/GeminiContextFormatter.js';
/**
 * Interface for the result of the iterative RAG search.
 */
export interface IterativeRagResult {
    accumulatedContext: RetrievedCodeContext[];
    webSearchSources: { title: string; url: string }[];
    finalAnswer?: string;
    searchMetrics?: {
        totalIterations: number;
        contextItemsAdded: number;
        webSearchesPerformed: number;
        hallucinationChecksPassed: number;
        earlyTerminationReason?: string;
    };
}
/**
 * Interface for the arguments passed to the iterative RAG orchestrator.
 */
export interface IterativeRagArgs {
    agent_id: string;
    query: string;
    model?: string;
    systemInstruction?: string;
    enable_rag?: boolean;
    focus_area?: string;
    analysis_focus_points?: string[];
    context_options?: ContextRetrievalOptions;
    context_snippet_length?: number;
    live_review_file_paths?: string[];
    enable_iterative_search?: boolean;
    execution_mode?: string;
    target_ai_persona?: string | null;
    conversation_context_ids?: string[] | null;
    enable_web_search?: boolean;
    max_iterations?: number;
    hallucination_check_threshold?: number;
    enable_context_summarization?: boolean;
    context_window_optimization_strategy?: 'truncate' | 'summarize' | 'adaptive';
    // Tavily parameters
    tavily_search_depth?: 'basic' | 'advanced';
    tavily_max_results?: number;
    tavily_include_raw_content?: boolean;
    tavily_include_images?: boolean;
    tavily_include_image_descriptions?: boolean;
    tavily_time_period?: string;
    tavily_topic?: string;
    // New thinking parameters
    thinkingConfig?: { thinkingBudget?: number; thinkingMode?: 'AUTO' | 'MODE_THINK' };
}
/**
 * Orchestrator for the iterative RAG search process.
 * This class encapsulates the logic for performing iterative search and refinement.
 */
export class IterativeRagOrchestrator {
    private memoryManagerInstance: MemoryManager;
    private geminiService: GeminiIntegrationService;
    constructor(memoryManagerInstance: MemoryManager, geminiService: GeminiIntegrationService) {
        this.memoryManagerInstance = memoryManagerInstance;
        this.geminiService = geminiService;
    }
    /**
     * Performs an automated, multi-turn iterative search and refinement process.
     * This method orchestrates a loop where it retrieves context, asks Gemini to analyze it,
     * and if necessary, refines the search query to gather more related information before
     * formulating a final answer.
     *
     * @param args The arguments for the iterative RAG search
     * @returns A promise that resolves to the final context and web search sources
     */
    async performIterativeSearch(args: IterativeRagArgs): Promise<IterativeRagResult> {
        const {
            agent_id,
            query,
            model,
            systemInstruction,
            max_iterations = 3,
            context_options,
            focus_area,
            analysis_focus_points,
            enable_web_search,
            hallucination_check_threshold = 0.8,
            enable_context_summarization = true,
            context_window_optimization_strategy = 'adaptive',
            // Tavily parameters
            tavily_search_depth = 'basic',
            tavily_max_results = 5,
            tavily_include_raw_content = false,
            tavily_include_images = false,
            tavily_include_image_descriptions = false,
            tavily_time_period,
            tavily_topic,
            // New thinking parameters
            thinkingConfig
        } = args;
        const contextRetriever = this.memoryManagerInstance.getCodebaseContextRetrieverService();
        let accumulatedContext: RetrievedCodeContext[] = [];
        const processedEntities = new Set<string>();
        let currentSearchQuery = query;
        const webSearchSources: { title: string; url: string }[] = [];
        let finalAnswer: string | undefined = undefined;
        // Search metrics tracking
        const searchMetrics = {
            totalIterations: 0,
            contextItemsAdded: 0,
            webSearchesPerformed: 0,
            hallucinationChecksPassed: 0,
            earlyTerminationReason: undefined as string | undefined
        };
        // Track query history to detect repetitive patterns
        const queryHistory: string[] = [];
        console.log(`[Iterative RAG] Starting iterative search for query: "${query}"`);
        for (let i = 0; i < max_iterations; i++) {
            searchMetrics.totalIterations = i + 1;
            console.log(`[Iterative RAG] Turn ${i + 1}/${max_iterations}: Searching for "${currentSearchQuery.substring(0, 100)}..."`);
            // Add current query to history
            queryHistory.push(currentSearchQuery.toLowerCase().trim());
            // Check for repetitive queries (potential infinite loop)
            if (i > 0 && this.isQueryRepetitive(queryHistory)) {
                console.log(`[Iterative RAG] Turn ${i + 1}: Detected repetitive query pattern. Concluding search.`);
                searchMetrics.earlyTerminationReason = "Repetitive query pattern detected";
                break;
            }
            // Retrieve context based on current query
            const contextResults = await contextRetriever.retrieveContextForPrompt(agent_id, currentSearchQuery, context_options || {});
            // Filter out already processed entities
            const newContext = contextResults.filter(ctx => {
                const entityKey = `${ctx.sourcePath}::${ctx.entityName || ''}`;
                if (!processedEntities.has(entityKey)) {
                    processedEntities.add(entityKey);
                    return true;
                }
                return false;
            });
            // If no new context found after first iteration, break early
            if (newContext.length === 0 && i > 0) {
                console.log(`[Iterative RAG] Turn ${i + 1}: No new context found. Concluding search.`);
                searchMetrics.earlyTerminationReason = "No new context found";
                break;
            }
            accumulatedContext.push(...newContext);
            searchMetrics.contextItemsAdded += newContext.length;
            console.log(`[Iterative RAG] Turn ${i + 1}: Added ${newContext.length} new context items. Total context items: ${accumulatedContext.length}.`);
            // Format context using the robust formatter
            const formattedContextParts = formatContextForGemini(accumulatedContext);
            const contextString = formattedContextParts[0].text || ''; // Assuming it returns a single text part
            // Generate focus string
            const focusString = RagPromptTemplates.generateFocusString(focus_area, analysis_focus_points);
            // Generate analysis prompt
            const analysisPrompt = RagPromptTemplates.generateAnalysisPrompt({
                originalQuery: query,
                currentTurn: i + 1,
                maxIterations: max_iterations.toString(),
                accumulatedContext: contextString,
                focusString,
                enableWebSearch: !!enable_web_search
            });
            // Get analysis from Gemini
            const geminiSystemInstruction = RagPromptTemplates.generateAnalysisSystemInstruction();
            const analysisResult = await this.geminiService.askGemini(analysisPrompt, model, geminiSystemInstruction, undefined, thinkingConfig);
            const rawResponseText = analysisResult.content[0].text ?? "";
            // Parse the response
            const parsedResponse = RagResponseParser.parseAnalysisResponse(rawResponseText);
            if (!parsedResponse || !RagResponseParser.validateResponse(parsedResponse)) {
                console.warn(`[Iterative RAG] Turn ${i + 1}: Failed to parse or validate Gemini response. Concluding search.`);
                searchMetrics.earlyTerminationReason = "Failed to parse Gemini response";
                break;
            }
            let { decision, nextCodebaseQuery, nextWebQuery } = parsedResponse;
            let shouldContinueSearching = false;
            // Implement enhanced hallucination check mechanism
            if (decision === "ANSWER") {
                console.log(`[Iterative RAG] Turn ${i + 1}: Decision is to ANSWER. Performing enhanced hallucination check.`);
                // Generate answer first
                const answerPrompt = RagPromptTemplates.generateAnswerPrompt({
                    originalQuery: query,
                    contextString: contextString,
                    focusString
                });
                const answerResult = await this.geminiService.askGemini(answerPrompt, model, "You are a helpful AI assistant providing accurate answers based on the given context.", undefined, thinkingConfig);
                const generatedAnswer = answerResult.content[0].text ?? "";
                // Enhanced hallucination check with multiple verification strategies
                const verificationResult = await this.performEnhancedHallucinationCheck({
                    originalQuery: query,
                    contextString: contextString,
                    generatedAnswer: generatedAnswer,
                    model,
                    threshold: hallucination_check_threshold,
                    thinkingConfig
                });
                if (verificationResult.isHallucination) {
                    console.warn(`[Iterative RAG] Turn ${i + 1}: Hallucination detected with confidence ${verificationResult.confidence}. ${verificationResult.issues}`);
                    // Continue searching for more context instead of answering
                    shouldContinueSearching = true;
                    // If hallucination confidence is very high, adjust the next query to be more specific
                    if (verificationResult.confidence > 0.9) {
                        nextCodebaseQuery = `Find specific information to verify: "${query}". Focus on factual details.`;
                    }
                } else {
                    console.log(`[Iterative RAG] Turn ${i + 1}: Answer verified with confidence ${verificationResult.confidence}. Concluding search.`);
                    searchMetrics.hallucinationChecksPassed++;
                    finalAnswer = generatedAnswer;
                    break;
                }
            }
            // If we should continue searching or reached max iterations, handle accordingly
            if ((!shouldContinueSearching && decision === "ANSWER") || i === max_iterations - 1) {
                console.log(`[Iterative RAG] Turn ${i + 1}: Decision is to ANSWER. Concluding search.`);
                searchMetrics.earlyTerminationReason = "Max iterations reached or decided to answer";
                break;
            }
            // If we're continuing the search due to hallucination detection
            if (shouldContinueSearching) {
                decision = "SEARCH_AGAIN";
                if (!nextCodebaseQuery) {
                    nextCodebaseQuery = `Find more context to support answering: "${query}"`;
                }
            }
            // Handle web search
            if (enable_web_search && decision === "SEARCH_WEB" && nextWebQuery) {
                console.log(`[Iterative RAG] Turn ${i + 1}: Decision is to SEARCH_WEB. Query: "${nextWebQuery}"`);
                searchMetrics.webSearchesPerformed++;
                try {
                    // Pass Tavily parameters to the API call
                    const webResults = await callTavilyApi(nextWebQuery, {
                        search_depth: tavily_search_depth,
                        max_results: tavily_max_results,
                        include_raw_content: tavily_include_raw_content,
                        include_images: tavily_include_images,
                        include_image_descriptions: tavily_include_image_descriptions,
                        time_period: tavily_time_period,
                        topic: tavily_topic
                    });
                    if (webResults.length === 0) {
                        console.warn(`[Iterative RAG] Turn ${i + 1}: No web results found for query: "${nextWebQuery}"`);
                        // If no web results, continue with codebase search
                        decision = "SEARCH_AGAIN";
                        nextCodebaseQuery = `Find codebase information for: "${query}"`;
                    } else {
                        webResults.forEach((res: any) => {
                            webSearchSources.push({ title: res.title, url: res.url });
                            const webContext: RetrievedCodeContext = {
                                type: 'documentation',
                                sourcePath: res.url,
                                entityName: res.title,
                                content: res.content,
                                relevanceScore: 0.95,
                            };
                            accumulatedContext.push(webContext);
                            processedEntities.add(`${res.url}::${res.title}`);
                        });
                    }
                } catch (webError: any) {
                    console.error(`[Iterative RAG] Tavily web search failed: ${webError.message}`);
                    accumulatedContext.push({
                        type: 'documentation',
                        sourcePath: 'Tavily Error',
                        content: `Web search for "${nextWebQuery}" failed: ${webError.message}`,
                    });
                    // If web search fails, continue with codebase search
                    decision = "SEARCH_AGAIN";
                    nextCodebaseQuery = `Find codebase information for: "${query}"`;
                }
            } else if (decision === "SEARCH_AGAIN" && nextCodebaseQuery) {
                currentSearchQuery = nextCodebaseQuery;
                console.log(`[Iterative RAG] Turn ${i + 1}: Decision is to SEARCH_AGAIN. New query: "${currentSearchQuery}"`);
            } else {
                console.log(`[Iterative RAG] Turn ${i + 1}: No valid next action. Concluding search.`);
                searchMetrics.earlyTerminationReason = "No valid next action";
                break;
            }
        }
        return {
            accumulatedContext,
            webSearchSources,
            finalAnswer,
            searchMetrics
        };
    }
    /**
     * Performs an enhanced hallucination check using multiple strategies.
     * @param params Parameters for the hallucination check
     * @returns Result of the hallucination check
     */
    private async performEnhancedHallucinationCheck(params: {
        originalQuery: string;
        contextString: string;
        generatedAnswer: string;
        model?: string;
        threshold: number;
        thinkingConfig?: { thinkingBudget?: number; thinkingMode?: 'AUTO' | 'MODE_THINK' };
    }): Promise<{ isHallucination: boolean; confidence: number; issues: string }> {
        const { originalQuery, contextString, generatedAnswer, model, threshold, thinkingConfig } = params;
        // Strategy 1: Direct verification prompt
        const verificationPrompt = RagPromptTemplates.generateVerificationPrompt({
            originalQuery,
            contextString,
            generatedAnswer
        });
        const verificationResult = await this.geminiService.askGemini(
            verificationPrompt,
            model,
            "You are a precise fact-checker. Respond only with VERIFIED or HALLUCINATION_DETECTED followed by issues.",
            undefined,
            thinkingConfig
        );
        const verificationText = verificationResult.content[0].text ?? "";
        // Strategy 2: Fact extraction and comparison
        const factExtractionPrompt = `
Extract key facts and claims from the following answer. For each fact, indicate if it is supported by the provided context.
Answer: ${generatedAnswer}
Context: ${contextString}
Respond with a JSON object containing:
1. facts: array of { claim: string, supported: boolean, evidence: string }
2. hallucinationScore: number between 0 and 1 (0 = no hallucination, 1 = complete hallucination)
Example Response:
{
  "facts": [
    {
      "claim": "The sky is blue.",
      "supported": true,
      "evidence": "The context states that the sky is blue on a clear day."
    }
  ],
  "hallucinationScore": 0.1
}
`;
        const factExtractionResult = await this.geminiService.askGemini(
            factExtractionPrompt,
            model,
            "You are a fact extraction expert. Respond only with a valid JSON object, without any conversational text or markdown.",
            undefined,
            thinkingConfig
        );
        let factExtractionData: any;
        try {
            const rawText = factExtractionResult.content[0].text ?? "{}";
            // Attempt to extract JSON from within markdown or conversational text
            const jsonMatch = rawText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                factExtractionData = JSON.parse(jsonMatch[0]);
            } else {
                throw new Error("No JSON object found in the response.");
            }
        } catch (e) {
            console.warn(`[IterativeRagOrchestrator] Failed to parse fact extraction JSON. Error: ${e instanceof Error ? e.message : String(e)}`);
            factExtractionData = { facts: [], hallucinationScore: 0.5 };
        }
        // Combine results from both strategies
        const isHallucinationDirect = verificationText.includes("HALLUCINATION_DETECTED");
        const factBasedScore = factExtractionData.hallucinationScore || 0.5;
        // Calculate overall confidence
        let confidence = 0.5; // Default uncertainty
        let issues = "";
        if (isHallucinationDirect) {
            confidence = 0.9; // High confidence in hallucination
            issues = verificationText.replace("HALLUCINATION_DETECTED", "").trim();
        } else if (factBasedScore > threshold) {
            confidence = factBasedScore;
            issues = `Fact-based hallucination detected with score ${factBasedScore}`;
            // Add specific unsupported facts
            if (factExtractionData.facts && Array.isArray(factExtractionData.facts)) {
                const unsupportedFacts = factExtractionData.facts
                    .filter((f: any) => !f.supported)
                    .map((f: any) => `- ${f.claim}`)
                    .join("\n");
                if (unsupportedFacts) {
                    issues += `\nUnsupported claims:\n${unsupportedFacts}`;
                }
            }
        } else {
            confidence = 0.1; // Low confidence in hallucination (likely verified)
            issues = "No significant hallucination detected";
        }
        return {
            isHallucination: confidence > threshold,
            confidence,
            issues
        };
    }
    /**
     * Checks if the query history shows a repetitive pattern.
     * @param queryHistory The history of queries
     * @returns True if a repetitive pattern is detected
     */
    private isQueryRepetitive(queryHistory: string[]): boolean {
        if (queryHistory.length < 3) {
            return false;
        }
        // Check if the last query is similar to any of the previous queries
        const lastQuery = queryHistory[queryHistory.length - 1];
        // Simple similarity check - in a real implementation, you might use embedding similarity
        for (let i = 0; i < queryHistory.length - 2; i++) {
            if (this.calculateSimilarity(lastQuery, queryHistory[i]) > 0.8) {
                return true;
            }
        }
        return false;
    }
    /**
     * Calculates a simple similarity score between two strings.
     * @param str1 First string
     * @param str2 Second string
     * @returns Similarity score between 0 and 1
     */
    private calculateSimilarity(str1: string, str2: string): number {
        // Simple word-based similarity for demonstration
        const words1 = str1.split(/\s+/).filter(w => w.length > 0);
        const words2 = str2.split(/\s+/).filter(w => w.length > 0);
        if (words1.length === 0 || words2.length === 0) {
            return 0;
        }
        const intersection = words1.filter(word => words2.includes(word));
        const union = [...new Set([...words1, ...words2])];
        return intersection.length / union.length;
    }
}