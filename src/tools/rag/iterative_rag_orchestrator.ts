import { MemoryManager } from '../../database/memory_manager.js';
import { GeminiIntegrationService } from '../../database/services/GeminiIntegrationService.js';
import { RetrievedCodeContext } from '../../database/services/CodebaseContextRetrieverService.js';
import { ContextRetrievalOptions } from '../../database/services/CodebaseContextRetrieverService.js';
import { RagPromptTemplates } from './rag_prompt_templates.js';
import { RagAnalysisResponse } from './rag_response_parser.js';
import { RagResponseParser } from './rag_response_parser.js';
import { callTavilyApi } from '../../integrations/tavily.js';
import { formatRetrievedContextForPrompt as formatContextForGemini } from '../../database/services/gemini-integration-modules/GeminiContextFormatter.js';
import { GeminiApiNotInitializedError } from '../../database/services/gemini-integration-modules/GeminiApiClient.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export interface IterativeRagResult {
    accumulatedContext: RetrievedCodeContext[];
    webSearchSources: { title: string; url: string }[];
    finalAnswer?: string;
    decisionLog: RagAnalysisResponse[];
    searchMetrics: {
        totalIterations: number;
        contextItemsAdded: number;
        webSearchesPerformed: number;
        hallucinationChecksPassed: number;
        earlyTerminationReason?: string;
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
}

export class IterativeRagOrchestrator {
    private memoryManagerInstance: MemoryManager;
    private geminiService: GeminiIntegrationService;

    constructor(memoryManagerInstance: MemoryManager, geminiService: GeminiIntegrationService) {
        this.memoryManagerInstance = memoryManagerInstance;
        this.geminiService = geminiService;
    }

    async performIterativeSearch(args: IterativeRagArgs): Promise<IterativeRagResult> {
        const {
            agent_id,
            query,
            model,
            max_iterations = 3,
            context_options,
            focus_area,
            analysis_focus_points,
            enable_web_search,
            hallucination_check_threshold = 0.8,
            tavily_search_depth = 'basic',
            tavily_max_results = 5,
            tavily_include_raw_content = false,
            tavily_include_images = false,
            tavily_include_image_descriptions = false,
            tavily_time_period,
            tavily_topic,
            thinkingConfig
        } = args;

        const contextRetriever = this.memoryManagerInstance.getCodebaseContextRetrieverService();
        let accumulatedContext: RetrievedCodeContext[] = [];
        const processedEntities = new Set<string>();
        let currentSearchQuery = query;
        const webSearchSources: { title: string; url: string }[] = [];
        let finalAnswer: string | undefined = undefined;
        const decisionLog: RagAnalysisResponse[] = [];

        const searchMetrics = {
            totalIterations: 0,
            contextItemsAdded: 0,
            webSearchesPerformed: 0,
            hallucinationChecksPassed: 0,
            earlyTerminationReason: undefined as string | undefined
        };

        const queryHistory: string[] = [];
        const focusString = RagPromptTemplates.generateFocusString(focus_area, analysis_focus_points);

        console.log(`[Iterative RAG] Starting iterative search for query: "${query}"`);

        for (let i = 0; i < max_iterations; i++) {
            searchMetrics.totalIterations = i + 1;
            console.log(`[Iterative RAG] Turn ${i + 1}/${max_iterations}: Searching for "${currentSearchQuery.substring(0, 100)}"...`);

            queryHistory.push(currentSearchQuery.toLowerCase().trim());

            if (i > 0 && this.isQueryRepetitive(queryHistory)) {
                console.log(`[Iterative RAG] Turn ${i + 1}: Detected repetitive query pattern. Concluding search.`);
                searchMetrics.earlyTerminationReason = "Repetitive query pattern detected";
                break;
            }

            const contextResults = await contextRetriever.retrieveContextForPrompt(agent_id, currentSearchQuery, context_options || {});
            const newContext = contextResults.filter(ctx => {
                const entityKey = `${ctx.sourcePath}::${ctx.entityName || ''}`;
                if (!processedEntities.has(entityKey)) {
                    processedEntities.add(entityKey);
                    return true;
                }
                return false;
            });

            if (newContext.length === 0 && i > 0) {
                console.log(`[Iterative RAG] Turn ${i + 1}: No new context found. Concluding search.`);
                searchMetrics.earlyTerminationReason = "No new context found";
                break;
            }

            accumulatedContext.push(...newContext);
            searchMetrics.contextItemsAdded += newContext.length;
            console.log(`[Iterative RAG] Turn ${i + 1}: Added ${newContext.length} new context items. Total context items: ${accumulatedContext.length}.`);

            const formattedContextParts = formatContextForGemini(accumulatedContext);
            const contextString = formattedContextParts[0].text || '';

            const analysisPrompt = RagPromptTemplates.generateAnalysisPrompt({
                originalQuery: query,
                currentTurn: i + 1,
                maxIterations: max_iterations.toString(),
                accumulatedContext: contextString,
                focusString,
                enableWebSearch: !!enable_web_search
            });

            let analysisResult;
            try {
                analysisResult = await this.geminiService.askGemini(
                    analysisPrompt,
                    model,
                    RagPromptTemplates.generateAnalysisSystemInstruction(),
                    thinkingConfig
                );
            } catch (error: any) {
                console.error(`[Iterative RAG] Turn ${i + 1}: Error during Gemini analysis:`, error);
                if (error instanceof GeminiApiNotInitializedError || (error && typeof error === 'object' && 'message' in error && (error.message as string).includes('429') || (error.message as string).includes('Quota exceeded'))) {
                    searchMetrics.earlyTerminationReason = "Gemini API quota exhausted or not initialized.";
                } else {
                    searchMetrics.earlyTerminationReason = `Gemini analysis failed: ${error.message}`;
                }
                break;
            }

            const rawResponseText = analysisResult.content[0].text ?? "";
            const parsedResponse = RagResponseParser.parseAnalysisResponse(rawResponseText, contextString, analysisPrompt);

            if (parsedResponse) {
                decisionLog.push(parsedResponse);
            }

            if (!parsedResponse || !RagResponseParser.validateResponse(parsedResponse)) {
                console.warn(`[Iterative RAG] Turn ${i + 1}: Failed to parse or validate Gemini response. Concluding search.`);
                searchMetrics.earlyTerminationReason = "Failed to parse Gemini response";
                break;
            }

            let { decision, nextCodebaseQuery, nextWebQuery } = parsedResponse;
            let shouldContinueSearching = false;

            if (decision === "ANSWER") {
                console.log(`[Iterative RAG] Turn ${i + 1}: Decision is to ANSWER. Performing enhanced hallucination check.`);

                const answerPrompt = RagPromptTemplates.generateAnswerPrompt({
                    originalQuery: query,
                    contextString: contextString,
                    focusString
                });

                let answerResult;
                try {
                    answerResult = await this.geminiService.askGemini(
                        answerPrompt,
                        model,
                        "You are a helpful AI assistant providing accurate answers based on the given context.",
                        thinkingConfig
                    );
                } catch (error: any) {
                    console.error(`[Iterative RAG] Turn ${i + 1}: Error during Gemini answer generation:`, error);
                    if (error instanceof GeminiApiNotInitializedError || (error && typeof error === 'object' && 'message' in error && (error.message as string).includes('429') || (error.message as string).includes('Quota exceeded'))) {
                        searchMetrics.earlyTerminationReason = "Gemini API quota exhausted or not initialized.";
                    } else {
                        searchMetrics.earlyTerminationReason = `Gemini answer generation failed: ${error.message}`;
                    }
                    break;
                }

                const generatedAnswer = answerResult.content[0].text ?? "";
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
                    shouldContinueSearching = true;
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

            if ((!shouldContinueSearching && decision === "ANSWER") || i === max_iterations - 1) {
                console.log(`[Iterative RAG] Turn ${i + 1}: Decision is to ANSWER. Concluding search.`);
                searchMetrics.earlyTerminationReason = "Max iterations reached or decided to answer";
                break;
            }

            if (shouldContinueSearching) {
                decision = "SEARCH_AGAIN";
                if (!nextCodebaseQuery) {
                    nextCodebaseQuery = `Find more context to support answering: "${query}"`;
                }
            }

            if (enable_web_search && decision === "SEARCH_WEB" && nextWebQuery) {
                console.log(`[Iterative RAG] Turn ${i + 1}: Decision is to SEARCH_WEB. Query: "${nextWebQuery}"`);
                searchMetrics.webSearchesPerformed++;

                try {
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

                        const newContextString = formatContextForGemini(accumulatedContext)[0].text || '';
                        const reanalysisResponse = await this._reanalyzeContextAndDecide(
                            newContextString,
                            query,
                            focusString,
                            model,
                            thinkingConfig,
                            newContextString,
                            analysisPrompt
                        );

                        if (reanalysisResponse && RagResponseParser.validateResponse(reanalysisResponse)) {
                            decisionLog.push(reanalysisResponse);
                            decision = reanalysisResponse.decision;
                            console.log(`[Iterative RAG] Post-web search re-analysis decision: ${decision}`);
                        } else {
                            decision = "SEARCH_AGAIN";
                            nextCodebaseQuery = `Find codebase information for: "${query}"`;
                        }
                    }
                } catch (webError: any) {
                    console.error(`[Iterative RAG] Tavily web search failed: ${webError.message}`);
                    accumulatedContext.push({
                        type: 'documentation',
                        sourcePath: 'Tavily Error',
                        content: `Web search for "${nextWebQuery}" failed: ${webError.message}`,
                    });
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
            decisionLog,
            searchMetrics
        };
    }

    private async _reanalyzeContextAndDecide(
        contextString: string,
        originalQuery: string,
        focusString: string,
        model: string | undefined,
        thinkingConfig: any,
        contextUsed?: string,
        promptSent?: string
    ): Promise<RagAnalysisResponse | null> {
        console.log('[Iterative RAG] Re-analyzing context after web search.');
        const analysisPrompt = RagPromptTemplates.generateAnalysisPrompt({
            originalQuery: originalQuery,
            currentTurn: -1,
            maxIterations: '-1',
            accumulatedContext: contextString,
            focusString: focusString,
            enableWebSearch: false
        });

        let analysisResult;
        try {
            analysisResult = await this.geminiService.askGemini(
                analysisPrompt,
                model,
                RagPromptTemplates.generateAnalysisSystemInstruction(),
                thinkingConfig
            );
        } catch (error: any) {
            console.error(`[Iterative RAG] Re-analysis: Error during Gemini analysis:`, error);
            return null;
        }

        const rawResponseText = analysisResult.content[0].text ?? '';
        return RagResponseParser.parseAnalysisResponse(rawResponseText, contextUsed, promptSent);
    }

    private async performEnhancedHallucinationCheck(params: {
        originalQuery: string;
        contextString: string;
        generatedAnswer: string;
        model?: string;
        threshold: number;
        thinkingConfig?: { thinkingBudget?: number; thinkingMode?: 'AUTO' | 'MODE_THINK' };
    }): Promise<{ isHallucination: boolean; confidence: number; issues: string }> {
        const { originalQuery, contextString, generatedAnswer, model, threshold, thinkingConfig } = params;

        const verificationPrompt = RagPromptTemplates.generateVerificationPrompt({
            originalQuery,
            contextString,
            generatedAnswer
        });

        let verificationResult;
        try {
            verificationResult = await this.geminiService.askGemini(
                verificationPrompt,
                model,
                "You are a precise fact-checker. Respond only with VERIFIED or HALLUCINATION_DETECTED followed by issues.",
                thinkingConfig
            );
        } catch (error: any) {
            console.error(`[Iterative RAG] Hallucination check: Error during Gemini verification:`, error);
            return { isHallucination: false, confidence: 0, issues: `Verification failed: ${error.message}` };
        }

        const verificationText = verificationResult.content[0].text ?? "";
        const isHallucinationDirect = verificationText.includes("HALLUCINATION_DETECTED");

        return {
            isHallucination: isHallucinationDirect,
            confidence: isHallucinationDirect ? 0.9 : 0.1,
            issues: isHallucinationDirect ? verificationText.replace("HALLUCINATION_DETECTED", "").trim() : "No significant hallucination detected"
        };
    }

    private isQueryRepetitive(queryHistory: string[]): boolean {
        if (queryHistory.length < 3) {
            return false;
        }
        const lastQuery = queryHistory[queryHistory.length - 1];
        for (let i = 0; i < queryHistory.length - 2; i++) {
            if (this.calculateSimilarity(lastQuery, queryHistory[i]) > 0.8) {
                return true;
            }
        }
        return false;
    }

    private calculateSimilarity(str1: string, str2: string): number {
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