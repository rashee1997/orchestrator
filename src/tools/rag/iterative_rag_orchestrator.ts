import { MemoryManager } from '../../database/memory_manager.js';
import { GeminiIntegrationService } from '../../database/services/GeminiIntegrationService.js';
import { RetrievedCodeContext } from '../../database/services/CodebaseContextRetrieverService.js';
import { ContextRetrievalOptions } from '../../database/services/CodebaseContextRetrieverService.js';
import { RagPromptTemplates } from './rag_prompt_templates.js';
import { RagAnalysisResponse, RagResponseParser } from './rag_response_parser.js';
import { callTavilyApi } from '../../integrations/tavily.js';

/**
 * Interface for the result of the iterative RAG search.
 */
export interface IterativeRagResult {
    accumulatedContext: RetrievedCodeContext[];
    webSearchSources: { title: string; url: string }[];
    finalAnswer?: string;
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
        const { agent_id, query, model, systemInstruction, max_iterations = 3, context_options, focus_area, analysis_focus_points, enable_web_search } = args;
        const contextRetriever = this.memoryManagerInstance.getCodebaseContextRetrieverService();

        let accumulatedContext: RetrievedCodeContext[] = [];
        const processedEntities = new Set<string>();
        let currentSearchQuery = query;
        const webSearchSources: { title: string; url: string }[] = [];
        let finalAnswer: string | undefined = undefined;

        console.log(`[Iterative RAG] Starting iterative search for query: "${query}"`);

        for (let i = 0; i < max_iterations; i++) {
            console.log(`[Iterative RAG] Turn ${i + 1}/${max_iterations}: Searching for "${currentSearchQuery.substring(0, 100)}..."`);

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
                break;
            }

            accumulatedContext.push(...newContext);
            console.log(`[Iterative RAG] Turn ${i + 1}: Added ${newContext.length} new context items. Total context items: ${accumulatedContext.length}.`);

            const contextString = this.formatRetrievedContextForPrompt(accumulatedContext);

            const focusString = RagPromptTemplates.generateFocusString(focus_area, analysis_focus_points);

            const analysisPrompt = RagPromptTemplates.generateAnalysisPrompt({
                originalQuery: query,
                currentTurn: i + 1,
                maxIterations: max_iterations,
                accumulatedContext: contextString,
                focusString,
                enableWebSearch: !!enable_web_search
            });

            const geminiSystemInstruction = RagPromptTemplates.generateAnalysisSystemInstruction();
            const analysisResult = await this.geminiService.askGemini(analysisPrompt, model, geminiSystemInstruction);
            const rawResponseText = analysisResult.content[0].text ?? "";

            const parsedResponse = RagResponseParser.parseAnalysisResponse(rawResponseText);

            if (!parsedResponse || !RagResponseParser.validateResponse(parsedResponse)) {
                console.warn(`[Iterative RAG] Turn ${i + 1}: Failed to parse or validate Gemini response. Concluding search.`);
                break;
            }

            let { decision, nextCodebaseQuery, nextWebQuery } = parsedResponse;
            let shouldContinueSearching = false;

            // Implement hallucination check mechanism
            if (decision === "ANSWER") {
                console.log(`[Iterative RAG] Turn ${i + 1}: Decision is to ANSWER. Performing hallucination check.`);

                // Generate answer first
                const answerPrompt = `Based on the following context, please provide a comprehensive answer to the original query: "${query}"
                
Context:
${contextString}

Original Query: "${query}"

Please provide your answer:`;

                const answerResult = await this.geminiService.askGemini(answerPrompt, model, "You are a helpful AI assistant providing accurate answers based on the given context.");
                const generatedAnswer = answerResult.content[0].text ?? "";

                // Check for hallucinations by asking Gemini to verify the answer against context
                const verificationPrompt = RagPromptTemplates.generateVerificationPrompt({
                    originalQuery: query,
                    contextString: contextString,
                    generatedAnswer: generatedAnswer
                });

                const verificationResult = await this.geminiService.askGemini(verificationPrompt, model, "You are a precise fact-checker. Respond only with VERIFIED or HALLUCINATION_DETECTED followed by issues.");
                const verificationText = verificationResult.content[0].text ?? "";

                if (verificationText.includes("HALLUCINATION_DETECTED")) {
                    console.warn(`[Iterative RAG] Turn ${i + 1}: Hallucination detected. ${verificationText}`);
                    // Continue searching for more context instead of answering
                    shouldContinueSearching = true;
                } else {
                    console.log(`[Iterative RAG] Turn ${i + 1}: Answer verified. Concluding search.`);
                    finalAnswer = generatedAnswer;
                    break;
                }
            }

            // If we should continue searching or reached max iterations, handle accordingly
            if ((!shouldContinueSearching && decision === "ANSWER") || i === max_iterations - 1) {
                console.log(`[Iterative RAG] Turn ${i + 1}: Decision is to ANSWER. Concluding search.`);
                break;
            }

            // If we're continuing the search due to hallucination detection
            if (shouldContinueSearching) {
                decision = "SEARCH_AGAIN";
                nextCodebaseQuery = `Find more context to support answering: "${query}"`;
            }

            // Handle web search
            if (enable_web_search && decision === "SEARCH_WEB" && nextWebQuery) {
                console.log(`[Iterative RAG] Turn ${i + 1}: Decision is to SEARCH_WEB. Query: "${nextWebQuery}"`);
                try {
                    const webResults = await callTavilyApi(nextWebQuery);
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
                } catch (webError: any) {
                    console.error(`[Iterative RAG] Tavily web search failed: ${webError.message}`);
                    accumulatedContext.push({
                        type: 'documentation',
                        sourcePath: 'Tavily Error',
                        content: `Web search for "${nextWebQuery}" failed: ${webError.message}`,
                    });
                }
            } else if (decision === "SEARCH_AGAIN" && nextCodebaseQuery) {
                currentSearchQuery = nextCodebaseQuery;
                console.log(`[Iterative RAG] Turn ${i + 1}: Decision is to SEARCH_AGAIN. New query: "${currentSearchQuery}"`);
            } else {
                console.log(`[Iterative RAG] Turn ${i + 1}: No valid next action. Concluding search.`);
                break;
            }
        }

        return { accumulatedContext, webSearchSources, finalAnswer };
    }

    /**
     * Formats retrieved context for the prompt with dynamic summarization.
     * Implements context window optimization strategies.
     * @param contexts The retrieved contexts to format
     * @returns The formatted context string
     */
    private formatRetrievedContextForPrompt(contexts: RetrievedCodeContext[]): string {
        const MAX_TOTAL_LENGTH = 8000; // Adjust based on model context window
        const MAX_CONTEXTS = 20; // Limit number of contexts
        let totalLength = 0;
        const formattedContexts: string[] = [];

        // Limit number of contexts
        const limitedContexts = contexts.slice(0, MAX_CONTEXTS);

        for (const ctx of limitedContexts) {
            const sourceInfo = ctx.entityName ? `${ctx.sourcePath} (${ctx.entityName})` : ctx.sourcePath;

            // Dynamic content length based on context type and relevance
            const maxLength = ctx.type === 'documentation' ? 300 : 200; // Longer for web docs
            let contentPreview = ctx.content.substring(0, maxLength);
            let truncated = ctx.content.length > maxLength ? '...' : '';

            // Simple summarization for very long content
            if (ctx.content.length > maxLength * 2) {
                contentPreview = `${ctx.content.substring(0, maxLength)}... [Content truncated for brevity. Full content available for detailed analysis.]`;
                truncated = '';
            }

            const formattedContext = `[Context] Source: ${sourceInfo}\nContent: ${contentPreview}${truncated}`;
            const contextLength = formattedContext.length;

            // Check if adding this context would exceed limits
            if (totalLength + contextLength > MAX_TOTAL_LENGTH && formattedContexts.length > 0) {
                // Add a summary context instead of truncating
                formattedContexts.push(`[Summary] ${formattedContexts.length} additional contexts were found but omitted due to context window limits.`);
                break;
            }

            formattedContexts.push(formattedContext);
            totalLength += contextLength;
        }

        return formattedContexts.join('\n\n---\n\n');
    }
}