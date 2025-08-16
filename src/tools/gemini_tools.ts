import { MemoryManager } from '../database/memory_manager.js';
import { promises as fs } from 'fs';
import path from 'path';
import { GeminiIntegrationService } from '../database/services/GeminiIntegrationService.js';
import { DatabaseService } from '../database/services/DatabaseService.js';
import { ContextInformationManager } from '../database/managers/ContextInformationManager.js';
import { InternalToolDefinition } from './index.js';
import { formatSimpleMessage, formatJsonToMarkdownCodeBlock } from '../utils/formatters.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { CODE_REVIEW_META_PROMPT, CODE_EXPLANATION_META_PROMPT, ENHANCEMENT_SUGGESTIONS_META_PROMPT, BUG_FIXING_META_PROMPT, REFACTORING_META_PROMPT, TESTING_META_PROMPT, DOCUMENTATION_META_PROMPT, DEFAULT_CODEBASE_ASSISTANT_META_PROMPT, CODE_MODULARIZATION_ORCHESTRATION_META_PROMPT, GENERAL_WEB_ASSISTANT_META_PROMPT } from '../database/services/gemini-integration-modules/GeminiPromptTemplates.js';
import { RetrievedCodeContext } from '../database/services/CodebaseContextRetrieverService.js';
import { formatRetrievedContextForPrompt } from '../database/services/gemini-integration-modules/GeminiContextFormatter.js';
import { parseGeminiJsonResponse } from '../database/services/gemini-integration-modules/GeminiResponseParsers.js';
import { REFINEMENT_MODEL_NAME } from '../database/services/gemini-integration-modules/GeminiConfig.js';
import { META_PROMPT } from '../database/services/gemini-integration-modules/GeminiPromptTemplates.js';
import { Part } from '@google/genai';
import { ContextRetrievalOptions } from '../database/services/CodebaseContextRetrieverService.js';
import { callTavilyApi } from '../integrations/tavily.js';
import { IterativeRagOrchestrator, IterativeRagResult, IterativeRagArgs } from './rag/iterative_rag_orchestrator.js';
import { RagPromptTemplates } from './rag/rag_prompt_templates.js';

/**
 * Performs an automated, multi-turn iterative search and refinement process.
 * This function orchestrates a loop where it retrieves context, asks Gemini to analyze it,
 * and if necessary, refines the search query to gather more related information before
 * formulating a final answer.
 *
 * @param args The arguments from the tool call.
 * @param memoryManagerInstance The instance of MemoryManager.
 * @param geminiService The instance of GeminiIntegrationService.
 * @returns A promise that resolves to the final, comprehensive answer as a string.
 */
async function _performIterativeRagSearch(
    args: IterativeRagArgs,
    memoryManagerInstance: MemoryManager,
    geminiService: GeminiIntegrationService
): Promise<IterativeRagResult> {
    // Delegate to the new IterativeRagOrchestrator
    const orchestrator = new IterativeRagOrchestrator(memoryManagerInstance, geminiService);
    return await orchestrator.performIterativeSearch(args);
}

export const askGeminiToolDefinition: InternalToolDefinition = {
    name: 'ask_gemini',
    description: 'Asks a query to the Gemini AI. Can perform a simple query, use Retrieval-Augmented Generation (RAG) for context-aware answers, or perform an automated, multi-step iterative search for complex questions.',
    inputSchema: {
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: 'The agent ID to use for context retrieval.' },
            query: { type: 'string', description: 'The query string to send to Gemini.' },
            model: { type: 'string', description: 'Optional: The Gemini model to use. Defaults to a fast, recent model.', default: 'gemini-2.5-flash' },
            systemInstruction: { type: 'string', description: 'Optional: A system instruction to guide the AI behavior.', nullable: true },
            enable_rag: { type: 'boolean', description: 'Optional: Enable single-turn Retrieval-Augmented Generation (RAG) with codebase context.', default: false, nullable: true },
            enable_iterative_search: {
                type: 'boolean',
                description: 'Enable an automated, multi-step search-and-refine process for complex queries to gather more comprehensive context before answering.',
                default: false
            },
            enable_web_search: {
                type: 'boolean',
                description: 'Allow the AI to autonomously perform Tavily web searches during iterative RAG if it determines the codebase context is insufficient to answer the query. Only applies if enable_iterative_search is true.',
                default: false
            },
            max_iterations: {
                type: 'number',
                description: 'The maximum number of search-and-refine iterations. Only applies if enable_iterative_search is true.',
                default: 3,
                minimum: 1,
                maximum: 5
            },
            live_review_file_paths: { type: 'array', items: { type: 'string' }, description: 'Optional: Provide an array of full file paths for live chunking and review, bypassing RAG.', nullable: true },
            focus_area: {
                type: 'string',
                description: 'Optional: Focus area for the response (e.g., code review, code explanation, enhancement suggestions, code modularization & orchestration).',
                enum: [
                    "code_review",
                    "code_explanation",
                    "enhancement_suggestions",
                    "bug_fixing",
                    "refactoring",
                    "testing",
                    "documentation",
                    "code_modularization_orchestration"
                ],
                nullable: true
            },
            context_snippet_length: { type: 'number', description: 'Optional: Maximum length of each context snippet included in the prompt. Defaults to 200.', default: 200, nullable: true },
            analysis_focus_points: {
                type: 'array',
                items: {
                    type: 'string',
                    enum: [
                        "Potential Bugs & Errors",
                        "Best Practices & Conventions",
                        "Performance",
                        "Security Vulnerabilities",
                        "Readability & Maintainability",
                        "Duplications",
                        "Code Smells",
                        "Testability",
                        "Error Handling",
                        "Modularity & Coupling",
                        "Documentation & Comments"
                    ]
                },
                description: 'Specific aspects to focus on during the review. If empty or not provided, a general comprehensive review is performed.',
                nullable: true
            },
            context_options: {
                type: 'object',
                properties: {
                    topKEmbeddings: { type: 'number', description: 'Optional: Number of top embedding results to retrieve.', nullable: true },
                    kgQueryDepth: { type: 'number', description: 'Optional: Depth for Knowledge Graph queries.', nullable: true },
                    includeFileContent: { type: 'boolean', description: 'Optional: Whether to include full file content for retrieved files.', nullable: true },
                    targetFilePaths: { type: 'array', items: { type: 'string' }, description: 'Optional: Array of relative file paths to restrict context retrieval to.', nullable: true },
                    topKKgResults: { type: 'number', description: 'Optional: Number of top Knowledge Graph results to retrieve.', nullable: true },
                    embeddingScoreThreshold: { type: 'number', description: 'Optional: Minimum embedding similarity score to include results.', nullable: true }
                },
                additionalProperties: false,
                nullable: true
            },
            execution_mode: {
                type: 'string',
                description: 'Optional: Specifies the desired output format and underlying logic. "generative_answer" for standard AI response, "plan_generation" for a structured JSON plan.',
                enum: ['generative_answer', 'plan_generation'],
                default: 'generative_answer',
                nullable: true
            },
            target_ai_persona: {
                type: ['string', 'null'],
                description: "Optional: A suggested persona for the AI agent to adopt for the task (e.g., 'expert Python developer', 'technical writer'). Used primarily for 'plan_generation' mode.",
                default: null,
                nullable: true
            },
            conversation_context_ids: {
                type: ['array', 'null'],
                items: { type: 'string' },
                description: "Optional: Array of recent conversation_ids or context_ids that might provide immediate context for the refinement. Used primarily for 'plan_generation' mode.",
                default: null,
                nullable: true
            },
            // New configuration options for RAG enhancements
            hallucination_check_threshold: {
                type: 'number',
                description: 'Threshold for hallucination detection confidence (0-1). Lower values are more strict.',
                default: 0.8,
                minimum: 0,
                maximum: 1
            },
            enable_context_summarization: {
                type: 'boolean',
                description: 'Enable dynamic summarization of older context to optimize context window usage.',
                default: true
            },
            context_window_optimization_strategy: {
                type: 'string',
                description: 'Strategy for context window optimization.',
                enum: ['truncate', 'summarize', 'adaptive'],
                default: 'adaptive'
            }
        },
        required: ['agent_id', 'query']
    },
    func: async (args: any, memoryManagerInstance?: MemoryManager) => {
        if (!memoryManagerInstance) {
            const errorMsg = "MemoryManager instance is required for ask_gemini";
            console.error(errorMsg);
            throw new McpError(ErrorCode.InternalError, errorMsg);
        }

        const {
            agent_id,
            query,
            model,
            systemInstruction,
            enable_rag,
            focus_area,
            analysis_focus_points,
            context_options,
            context_snippet_length,
            live_review_file_paths,
            enable_iterative_search,
            execution_mode,
            target_ai_persona,
            conversation_context_ids,
            enable_web_search,
            max_iterations,
            hallucination_check_threshold,
            enable_context_summarization,
            context_window_optimization_strategy
        } = args;

        const snippetLength = context_snippet_length !== undefined ? context_snippet_length : 200;
        const dbService = (memoryManagerInstance as any).dbService as DatabaseService | undefined;
        const contextManager = (memoryManagerInstance as any).contextInformationManager as ContextInformationManager | undefined;

        if (!dbService || !contextManager) {
            const errorMsg = "dbService or contextInformationManager not available through MemoryManager for GeminiIntegrationService. Update access pattern in MemoryManager or tool.";
            console.error(errorMsg);
            throw new McpError(ErrorCode.InternalError, errorMsg);
        }

        if (!process.env.GEMINI_API_KEY) {
            const errorMsg = "Gemini API key (GEMINI_API_KEY) is not set in environment variables.";
            console.error(errorMsg);
            throw new McpError(ErrorCode.InternalError, errorMsg);
        }

        const geminiService = new GeminiIntegrationService(dbService, contextManager, memoryManagerInstance);

        // --- Stage 1: Context Acquisition ---
        let finalContext: RetrievedCodeContext[] = [];
        let webSearchSources: { title: string; url: string }[] = [];
        let finalAnswerFromIteration: string | undefined;
        let searchMetrics: any = undefined;

        try {
            if (enable_iterative_search) {
                console.log("[ask_gemini] Starting Stage 1: Iterative Search Context Acquisition");
                const iterativeResult = await _performIterativeRagSearch({
                    agent_id,
                    query,
                    model,
                    systemInstruction,
                    enable_rag,
                    focus_area,
                    analysis_focus_points,
                    context_options,
                    context_snippet_length,
                    live_review_file_paths,
                    enable_iterative_search,
                    execution_mode,
                    target_ai_persona,
                    conversation_context_ids,
                    enable_web_search,
                    max_iterations,
                    hallucination_check_threshold,
                    enable_context_summarization,
                    context_window_optimization_strategy
                }, memoryManagerInstance, geminiService);

                finalContext = iterativeResult.accumulatedContext;
                webSearchSources = iterativeResult.webSearchSources;
                finalAnswerFromIteration = iterativeResult.finalAnswer;
                searchMetrics = iterativeResult.searchMetrics;
            } else if (live_review_file_paths && Array.isArray(live_review_file_paths) && live_review_file_paths.length > 0) {
                console.log("[ask_gemini] Starting Stage 1: Live File Review Context Acquisition");
                const embeddingService = memoryManagerInstance.getCodebaseEmbeddingService();
                const chunkingService = embeddingService.chunkingService;
                const introspectionService = embeddingService.introspectionService;

                for (const filePath of live_review_file_paths) {
                    const fileContent = await fs.readFile(filePath, 'utf-8');
                    const language = await introspectionService.detectLanguage(agent_id, filePath, path.basename(filePath));
                    const { chunks } = await chunkingService.chunkFileContent(
                        agent_id,
                        filePath,
                        fileContent,
                        path.relative(process.cwd(), filePath),
                        language,
                        'auto',
                        false
                    );

                    chunks.forEach((chunk: { chunk_text: string }, index: number) => {
                        finalContext.push({
                            type: 'file_snippet',
                            sourcePath: filePath,
                            entityName: `chunk_${index + 1}`,
                            content: chunk.chunk_text,
                            metadata: { language }
                        });
                    });
                }
            } else if (enable_rag) {
                console.log("[ask_gemini] Starting Stage 1: Standard RAG Context Acquisition");
                const contextRetrieverService = memoryManagerInstance.getCodebaseContextRetrieverService();
                finalContext = await contextRetrieverService.retrieveContextForPrompt(agent_id, query, context_options || {});
            }
        } catch (error: any) {
            console.error(`Error during context acquisition stage:`, error);
            throw new McpError(ErrorCode.InternalError, `Context Acquisition failed: ${error.message}`);
        }

        console.log(`[ask_gemini] Stage 1 complete. Acquired ${finalContext.length} context items.`);

        // --- Stage 2: Output Generation ---
        console.log(`[ask_gemini] Starting Stage 2: Output Generation with mode "${execution_mode}"`);

        if (execution_mode === 'plan_generation') {
            const modelToUse = model || REFINEMENT_MODEL_NAME;
            const raw_user_prompt = query;
            const retrievedCodeContextParts = formatRetrievedContextForPrompt(finalContext);

            const metaPromptContent = META_PROMPT
                .replace('{modelToUse}', modelToUse)
                .replace('{raw_user_prompt}', raw_user_prompt)
                .replace('{retrievedCodeContextString}', retrievedCodeContextParts[0].text || 'No relevant context was found.');

            try {
                const result = await geminiService.askGemini(metaPromptContent, modelToUse);
                const textResponse = result.content[0].text ?? '';
                let parsedResponse = parseGeminiJsonResponse(textResponse);

                parsedResponse.agent_id = parsedResponse.agent_id || agent_id;
                parsedResponse.refinement_engine_model = modelToUse;
                parsedResponse.refinement_timestamp = new Date().toISOString();
                parsedResponse.original_prompt_text = raw_user_prompt;
                parsedResponse.target_ai_persona = target_ai_persona;
                parsedResponse.conversation_context_ids = conversation_context_ids;
                parsedResponse.refined_prompt_id = await geminiService.storeRefinedPrompt(parsedResponse);

                return { content: [{ type: 'text', text: JSON.stringify(parsedResponse, null, 2) }] };
            } catch (error: any) {
                console.error(`Error generating plan using Gemini API (agent: ${agent_id}):`, error);
                throw new McpError(ErrorCode.InternalError, `Failed to generate plan using Gemini API: ${error.message}`);
            }
        } else { // Default to 'generative_answer'
            if (finalAnswerFromIteration) {
                console.log("[ask_gemini] Using pre-verified answer from iterative search.");
                let markdownOutput = `## Gemini Response for Query:\n`;
                markdownOutput += `> "${query}"\n\n`;
                markdownOutput += `### AI Answer:\n`;
                markdownOutput += formatJsonToMarkdownCodeBlock(finalAnswerFromIteration, 'text') + '\n';
                markdownOutput += `\n**Verification Status:** Verified against provided context.\n`;

                // Add search metrics if available
                if (searchMetrics) {
                    markdownOutput += `\n### Search Metrics:\n`;
                    markdownOutput += `- Total Iterations: ${searchMetrics.totalIterations}\n`;
                    markdownOutput += `- Context Items Added: ${searchMetrics.contextItemsAdded}\n`;
                    markdownOutput += `- Web Searches Performed: ${searchMetrics.webSearchesPerformed}\n`;
                    markdownOutput += `- Hallucination Checks Passed: ${searchMetrics.hallucinationChecksPassed}\n`;
                    if (searchMetrics.earlyTerminationReason) {
                        markdownOutput += `- Early Termination Reason: ${searchMetrics.earlyTerminationReason}\n`;
                    }
                }

                if (webSearchSources.length > 0) {
                    markdownOutput += `\n### Web Search Sources:\n`;
                    webSearchSources.forEach((source, index) => {
                        markdownOutput += `${index + 1}. [${source.title}](${source.url})\n`;
                    });
                }

                return { content: [{ type: 'text', text: markdownOutput }] };
            }

            let finalPromptContent = "";
            let finalSystemInstruction = systemInstruction;

            if (finalContext.length > 0) {
                let metaPromptTemplate: string;
                if (webSearchSources.length > 0) {
                    finalSystemInstruction = GENERAL_WEB_ASSISTANT_META_PROMPT;
                    metaPromptTemplate = `Based on the following information, please answer the user's query. Remember to cite your sources as instructed.
--- CONTEXT ---
{context}
--- END CONTEXT ---
--- USER QUERY ---
{query}`;
                } else {
                    metaPromptTemplate = DEFAULT_CODEBASE_ASSISTANT_META_PROMPT;
                    if (focus_area) {
                        switch (focus_area) {
                            case "code_review": metaPromptTemplate = CODE_REVIEW_META_PROMPT; break;
                            case "code_explanation": metaPromptTemplate = CODE_EXPLANATION_META_PROMPT; break;
                            case "enhancement_suggestions": metaPromptTemplate = ENHANCEMENT_SUGGESTIONS_META_PROMPT; break;
                            case "bug_fixing": metaPromptTemplate = BUG_FIXING_META_PROMPT; break;
                            case "refactoring": metaPromptTemplate = REFACTORING_META_PROMPT; break;
                            case "testing": metaPromptTemplate = TESTING_META_PROMPT; break;
                            case "documentation": metaPromptTemplate = DOCUMENTATION_META_PROMPT; break;
                            case "code_modularization_orchestration": metaPromptTemplate = CODE_MODULARIZATION_ORCHESTRATION_META_PROMPT; break;
                        }
                    }
                }

                let focusString = "";
                if (analysis_focus_points && analysis_focus_points.length > 0) {
                    focusString = "Focus on the following aspects:\n" + analysis_focus_points.map((point: string, index: number) => `${index + 1}.  **${point}**`).join('\n');
                }

                const contextText = finalContext.map(res => {
                    const isWebResult = res.type === 'documentation' && webSearchSources.some(s => s.url === res.sourcePath);
                    if (isWebResult) {
                        const sourceInfo = webSearchSources.find(s => s.url === res.sourcePath);
                        const citation = sourceInfo ? `[Source Title: ${sourceInfo.title}](${sourceInfo.url})` : `[Source URL: ${res.sourcePath}]`;
                        return `Source: ${citation}\nContent: ${res.content}`;
                    } else {
                        const sourceCitation = `\`${res.sourcePath}\``;
                        const entityName = res.entityName ? ` (Entity: \`${res.entityName}\`)` : '';
                        const contentPreview = res.content.substring(0, snippetLength);
                        const truncated = res.content.length > snippetLength ? '...' : '';
                        return `File: ${sourceCitation}${entityName}\n\`\`\`${res.metadata?.language || 'text'}\n${contentPreview}${truncated}\n\`\`\``;
                    }
                }).join("\n\n---\n\n");

                finalPromptContent = metaPromptTemplate
                    .replace('{context}', contextText)
                    .replace('{query}', query);

                if (focusString) {
                    finalPromptContent = `${focusString}\n\n${finalPromptContent}`;
                }
            } else {
                // If no context at all, just use the original query
                finalPromptContent = query;
                finalSystemInstruction = "You are a helpful AI assistant. No specific context was provided, so answer the query to the best of your general knowledge.";
            }

            try {
                const response = await geminiService.askGemini(finalPromptContent, model, finalSystemInstruction);
                const geminiText = response.content?.[0]?.text ?? '';

                const contextStringForCheck = formatRetrievedContextForPrompt(finalContext)[0]?.text || 'No context was provided.';
                const verificationPrompt = RagPromptTemplates.generateVerificationPrompt({
                    originalQuery: query,
                    contextString: contextStringForCheck,
                    generatedAnswer: geminiText
                });

                const verificationResult = await geminiService.askGemini(verificationPrompt, model, "You are a precise fact-checker. Respond only with VERIFIED or HALLUCINATION_DETECTED followed by issues.");
                const verificationText = verificationResult.content[0].text ?? "";

                let markdownOutput = `## Gemini Response for Query:\n`;
                markdownOutput += `> "${query}"\n\n`;
                markdownOutput += `### AI Answer:\n`;

                let aiAnswerContent = '';
                if (geminiText.includes('\n') || geminiText.match(/[{[<>()=\-/\\.+*;:'"]}/)) {
                    aiAnswerContent = formatJsonToMarkdownCodeBlock(geminiText, 'text');
                } else {
                    aiAnswerContent = `> ${geminiText.replace(/\n/g, '\n> ')}`;
                }

                markdownOutput += aiAnswerContent + '\n';
                markdownOutput += `\n`;

                if (verificationText.includes("HALLUCINATION_DETECTED")) {
                    markdownOutput += `**Warning:** The following potential hallucinations were detected based on the provided context:\n${formatJsonToMarkdownCodeBlock(verificationText.replace("HALLUCINATION_DETECTED", "").trim(), 'text')}\n`;
                } else {
                    markdownOutput += `**Verification Status:** Verified against provided context.\n`;
                }

                if (webSearchSources.length > 0) {
                    markdownOutput += `\n### Web Search Sources:\n`;
                    webSearchSources.forEach((source, index) => {
                        markdownOutput += `${index + 1}. [${source.title}](${source.url})\n`;
                    });
                }

                return { content: [{ type: 'text', text: markdownOutput }] };
            } catch (error: any) {
                console.error(`Error asking Gemini:`, error);
                throw new McpError(ErrorCode.InternalError, `Gemini API Error: ${error.message}`);
            }
        }
    }
};

export function getGeminiToolHandlers(memoryManager: MemoryManager) {
    return {
        'ask_gemini': (args: any, agent_id?: string) => { // agent_id is not directly used by ask_gemini but passed by MCP server
            if (!askGeminiToolDefinition.func) {
                throw new McpError(ErrorCode.InternalError, 'ask_gemini handler not implemented');
            }
            // Pass memoryManager to the func, agent_id is implicitly handled or not needed by this specific tool's core logic
            return askGeminiToolDefinition.func(args, memoryManager);
        }
    };
}

// This is for MCP server listing, func is stripped.
export const geminiToolDefinitions: InternalToolDefinition[] = [
    {
        name: askGeminiToolDefinition.name,
        description: askGeminiToolDefinition.description,
        inputSchema: askGeminiToolDefinition.inputSchema
    }
];