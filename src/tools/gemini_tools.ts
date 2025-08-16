import { MemoryManager } from '../database/memory_manager.js';
import { promises as fs } from 'fs';
import path from 'path';
import { GeminiIntegrationService } from '../database/services/GeminiIntegrationService.js';
import { DatabaseService } from '../database/services/DatabaseService.js';
import { ContextInformationManager } from '../database/managers/ContextInformationManager.js';
import { InternalToolDefinition } from './index.js';
import { formatSimpleMessage, formatJsonToMarkdownCodeBlock } from '../utils/formatters.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { CODE_REVIEW_META_PROMPT, CODE_EXPLANATION_META_PROMPT, ENHANCEMENT_SUGGESTIONS_META_PROMPT, BUG_FIXING_META_PROMPT, REFACTORING_META_PROMPT, TESTING_META_PROMPT, DOCUMENTATION_META_PROMPT, DEFAULT_CODEBASE_ASSISTANT_META_PROMPT, CODE_MODULARIZATION_ORCHESTATION_META_PROMPT, GENERAL_WEB_ASSISTANT_META_PROMPT, CODE_ANALYSIS_META_PROMPT, INTENT_CLASSIFICATION_PROMPT } from '../database/services/gemini-integration-modules/GeminiPromptTemplates.js';
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

const VALID_FOCUS_AREAS = [
    "code_review", "code_explanation", "enhancement_suggestions", "bug_fixing",
    "refactoring", "testing", "documentation", "code_modularization_orchestration", "codebase_analysis"
];

/**
 * Uses a fast AI model to classify the user's query and determine the best focus area.
 * @param query The user's query string.
 * @param geminiService An instance of the GeminiIntegrationService.
 * @returns The selected focus area string, or null if classification fails.
 */
async function _getIntentFocusArea(query: string, geminiService: GeminiIntegrationService): Promise<string | null> {
    try {
        const classificationPrompt = INTENT_CLASSIFICATION_PROMPT.replace('{query}', query);
        // Use a fast model for classification, no context or thinking needed.
        const result = await geminiService.askGemini(classificationPrompt, 'gemini-2.5-flash');
        const intent = result.content[0].text?.trim() || '';

        // Validate that the model returned a valid focus area
        if (VALID_FOCUS_AREAS.includes(intent)) {
            return intent;
        }
        console.warn(`[ask_gemini] Intent classification returned an invalid focus area: "${intent}". Falling back to default.`);
        return null;
    } catch (error) {
        console.error(`[ask_gemini] Error during AI-powered intent classification:`, error);
        return null; // Fallback on error
    }
}

/**
 * Performs an automated, multi-turn iterative search and refinement process.
 */
async function _performIterativeRagSearch(
    args: IterativeRagArgs,
    memoryManagerInstance: MemoryManager,
    geminiService: GeminiIntegrationService
): Promise<IterativeRagResult> {
    const orchestrator = new IterativeRagOrchestrator(memoryManagerInstance, geminiService);
    return await orchestrator.performIterativeSearch(args);
}

export const askGeminiToolDefinition: InternalToolDefinition = {
    name: 'ask_gemini',
    description: 'Asks a query to the Gemini AI. Can perform RAG, iterative search, and supports advanced Gemini thinking capabilities. Autonomously selects the best analysis focus if not specified.',
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
                description: 'Enable an automated, multi-step search-and-refine process for complex queries.',
                default: false
            },
            enable_web_search: {
                type: 'boolean',
                description: 'Allow autonomous Tavily web searches during iterative RAG.',
                default: false
            },
            max_iterations: {
                type: 'number',
                description: 'Max iterations for iterative search.',
                default: 3,
                minimum: 1,
                maximum: 5
            },
            live_review_file_paths: { type: 'array', items: { type: 'string' }, description: 'Optional: Array of full file paths for live chunking and review.', nullable: true },
            focus_area: {
                type: 'string',
                description: 'Optional: Manually set a focus area to override autonomous selection (e.g., code_review, bug_fixing).',
                enum: VALID_FOCUS_AREAS,
                nullable: true
            },
            context_snippet_length: { type: 'number', description: 'Optional: Maximum length of each context snippet included in the prompt.', default: 200, nullable: true },
            analysis_focus_points: {
                type: 'array',
                items: {
                    type: 'string',
                    enum: [
                        "Potential Bugs & Errors", "Best Practices & Conventions", "Performance",
                        "Security Vulnerabilities", "Readability & Maintainability", "Duplications",
                        "Code Smells", "Testability", "Error Handling", "Modularity & Coupling",
                        "Documentation & Comments"
                    ]
                },
                description: 'Specific aspects to focus on during a review.',
                nullable: true
            },
            context_options: {
                type: 'object',
                properties: {
                    topKEmbeddings: { type: 'number', nullable: true },
                    kgQueryDepth: { type: 'number', nullable: true },
                    includeFileContent: { type: 'boolean', nullable: true },
                    targetFilePaths: { type: 'array', items: { type: 'string' }, nullable: true },
                    topKKgResults: { type: 'number', nullable: true },
                    embeddingScoreThreshold: { type: 'number', nullable: true }
                },
                additionalProperties: false,
                nullable: true
            },
            execution_mode: {
                type: 'string',
                description: 'Specifies the desired output format.',
                enum: ['generative_answer', 'plan_generation'],
                default: 'generative_answer',
                nullable: true
            },
            target_ai_persona: { type: ['string', 'null'], description: "Optional: A suggested persona for the AI agent.", default: null, nullable: true },
            conversation_context_ids: { type: ['array', 'null'], items: { type: 'string' }, description: "Optional: Array of recent conversation_ids for context.", default: null, nullable: true },
            hallucination_check_threshold: { type: 'number', description: 'Confidence threshold for hallucination detection (0-1).', default: 0.8, minimum: 0, maximum: 1 },
            enable_context_summarization: { type: 'boolean', description: 'Enable dynamic summarization of older context.', default: true },
            context_window_optimization_strategy: { type: 'string', description: 'Strategy for context window optimization.', enum: ['truncate', 'summarize', 'adaptive'], default: 'adaptive' },
            tavily_search_depth: { type: 'string', enum: ['basic', 'advanced'], default: 'basic', nullable: true },
            tavily_max_results: { type: 'number', default: 5, minimum: 1, maximum: 10, nullable: true },
            tavily_include_raw_content: { type: 'boolean', default: false, nullable: true },
            tavily_include_images: { type: 'boolean', default: false, nullable: true },
            tavily_include_image_descriptions: { type: 'boolean', default: false, nullable: true },
            tavily_time_period: { type: 'string', nullable: true },
            tavily_topic: { type: 'string', nullable: true },
            enable_thinking: { type: 'boolean', description: 'Enable Gemini thinking capabilities.', default: false, nullable: true },
            thinking_budget: { type: 'number', description: 'Token budget for thinking (-1 for dynamic).', default: 4096, minimum: -1, maximum: 32768, nullable: true },
            thinking_mode: { type: 'string', description: 'Controls how thinking is used.', enum: ['AUTO', 'MODE_THINK'], default: 'AUTO', nullable: true },
            include_thoughts: { type: 'boolean', description: 'Request thought summaries in the response.', default: false, nullable: true },
            enable_dynamic_thinking: { type: 'boolean', description: 'Shortcut for thinking_budget = -1.', default: false, nullable: true }
        },
        required: ['agent_id', 'query']
    },
    func: async (args: any, memoryManagerInstance?: MemoryManager) => {
        if (!memoryManagerInstance) {
            throw new McpError(ErrorCode.InternalError, "MemoryManager instance is required for ask_gemini");
        }

        let {
            agent_id, query, model, systemInstruction, enable_rag, focus_area, analysis_focus_points,
            context_options, live_review_file_paths, enable_iterative_search, execution_mode,
            target_ai_persona, conversation_context_ids, enable_web_search, max_iterations,
            hallucination_check_threshold, enable_context_summarization, context_window_optimization_strategy,
            tavily_search_depth, tavily_max_results, tavily_include_raw_content, tavily_include_images,
            tavily_include_image_descriptions, tavily_time_period, tavily_topic,
            enable_thinking, thinking_budget, thinking_mode, include_thoughts, enable_dynamic_thinking
        } = args;

        const dbService = (memoryManagerInstance as any).dbService as DatabaseService | undefined;
        const contextManager = (memoryManagerInstance as any).contextInformationManager as ContextInformationManager | undefined;
        if (!dbService || !contextManager) {
            throw new McpError(ErrorCode.InternalError, "dbService or contextInformationManager not available.");
        }
        if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
            throw new McpError(ErrorCode.InternalError, "Gemini/Google API key is not set.");
        }

        const geminiService = new GeminiIntegrationService(dbService, contextManager, memoryManagerInstance);

        // --- Autonomous Focus Area Selection ---
        if (!focus_area) {
            const detectedFocus = await _getIntentFocusArea(query, geminiService);
            if (detectedFocus) {
                console.log(`[ask_gemini] Autonomously selected focus area: "${detectedFocus}"`);
                focus_area = detectedFocus;
                if (focus_area === 'codebase_analysis') {
                    console.log("[ask_gemini] High-precision analysis query detected. Upgrading model to gemini-pro.");
                    model = 'gemini-2.5-pro'; // Or another high-capability model name
                }
            }
        }

        let thinkingConfig: { thinkingBudget?: number; thinkingMode?: 'AUTO' | 'MODE_THINK'; includeThoughts?: boolean } | undefined;
        if (enable_thinking || enable_dynamic_thinking || include_thoughts) {
            const budget = enable_dynamic_thinking ? -1 : (thinking_budget ?? 4096);
            thinkingConfig = {
                thinkingBudget: budget,
                thinkingMode: thinking_mode || 'AUTO',
                includeThoughts: include_thoughts || undefined
            };
        }

        let finalContext: RetrievedCodeContext[] = [];
        let webSearchSources: { title: string; url: string }[] = [];
        let finalAnswerFromIteration: string | undefined;
        let searchMetrics: any = undefined;

        try {
            if (enable_iterative_search) {
                console.log("[ask_gemini] Starting Stage 1: Iterative Search Context Acquisition");
                const iterativeResult = await _performIterativeRagSearch({
                    agent_id, query, model, systemInstruction, enable_rag, focus_area,
                    analysis_focus_points, context_options, live_review_file_paths,
                    enable_iterative_search, execution_mode, target_ai_persona,
                    conversation_context_ids, enable_web_search, max_iterations,
                    hallucination_check_threshold, enable_context_summarization,
                    context_window_optimization_strategy, tavily_search_depth,
                    tavily_max_results, tavily_include_raw_content, tavily_include_images,
                    tavily_include_image_descriptions, tavily_time_period, tavily_topic,
                    thinkingConfig
                }, memoryManagerInstance, geminiService);
                finalContext = iterativeResult.accumulatedContext;
                webSearchSources = iterativeResult.webSearchSources;
                finalAnswerFromIteration = iterativeResult.finalAnswer;
                searchMetrics = iterativeResult.searchMetrics;
            } else if (live_review_file_paths?.length) {
                console.log("[ask_gemini] Starting Stage 1: Live File Review Context Acquisition");
                const embeddingService = memoryManagerInstance.getCodebaseEmbeddingService();
                for (const filePath of live_review_file_paths) {
                    const fileContent = await fs.readFile(filePath, 'utf-8');
                    const language = await embeddingService.introspectionService.detectLanguage(agent_id, filePath, path.basename(filePath));
                    const { chunks } = await embeddingService.chunkingService.chunkFileContent(
                        agent_id, filePath, fileContent, path.relative(process.cwd(), filePath), language, 'auto', false
                    );
                    chunks.forEach((chunk: { chunk_text: string }, index: number) => {
                        finalContext.push({
                            type: 'file_snippet', sourcePath: filePath, entityName: `chunk_${index + 1}`,
                            content: chunk.chunk_text, metadata: { language }
                        });
                    });
                }
            } else if (enable_rag) {
                console.log("[ask_gemini] Starting Stage 1: Standard RAG Context Acquisition");
                const contextRetrieverService = memoryManagerInstance.getCodebaseContextRetrieverService();
                finalContext = await contextRetrieverService.retrieveContextForPrompt(agent_id, query, context_options || {});
            }
        } catch (error: any) {
            throw new McpError(ErrorCode.InternalError, `Context Acquisition failed: ${error.message}`);
        }

        console.log(`[ask_gemini] Stage 1 complete. Acquired ${finalContext.length} context items.`);

        if (execution_mode === 'plan_generation') {
            const modelToUse = model || REFINEMENT_MODEL_NAME;
            const contextString = (formatRetrievedContextForPrompt(finalContext)[0] as { text: string })?.text || 'No relevant context was found.';
            const metaPromptContent = META_PROMPT
                .replace('{modelToUse}', modelToUse)
                .replace('{raw_user_prompt}', query)
                .replace('{retrievedCodeContextString}', contextString);
            try {
                const result = await geminiService.askGemini(metaPromptContent, modelToUse, undefined, undefined, thinkingConfig);
                let parsedResponse = parseGeminiJsonResponse(result.content[0].text ?? '');
                Object.assign(parsedResponse, {
                    agent_id: agent_id,
                    refinement_engine_model: modelToUse,
                    refinement_timestamp: new Date().toISOString(),
                    original_prompt_text: query,
                    target_ai_persona: target_ai_persona,
                    conversation_context_ids: conversation_context_ids,
                    refined_prompt_id: await geminiService.storeRefinedPrompt(parsedResponse)
                });
                return { content: [{ type: 'text', text: JSON.stringify(parsedResponse, null, 2) }] };
            } catch (error: any) {
                throw new McpError(ErrorCode.InternalError, `Failed to generate plan using Gemini API: ${error.message}`);
            }
        } else {
            if (finalAnswerFromIteration) {
                let markdownOutput = `## Gemini Response for Query:\n> "${query}"\n\n### AI Answer:\n${formatJsonToMarkdownCodeBlock(finalAnswerFromIteration, 'text')}\n\n**Verification Status:** Verified against provided context.\n`;
                if (searchMetrics) {
                    markdownOutput += `\n### Search Metrics:\n- Total Iterations: ${searchMetrics.totalIterations}\n- Context Items Added: ${searchMetrics.contextItemsAdded}\n- Web Searches Performed: ${searchMetrics.webSearchesPerformed}\n- Hallucination Checks Passed: ${searchMetrics.hallucinationChecksPassed}\n`;
                    if (searchMetrics.earlyTerminationReason) {
                        markdownOutput += `- Early Termination Reason: ${searchMetrics.earlyTerminationReason}\n`;
                    }
                }
                if (webSearchSources.length > 0) {
                    markdownOutput += `\n### Web Search Sources:\n` + webSearchSources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join('\n');
                }
                return { content: [{ type: 'text', text: markdownOutput }] };
            }

            const canonicalContextPart = (formatRetrievedContextForPrompt(finalContext)[0] as { text: string })?.text || 'No context was provided.';
            let finalSystemInstruction = systemInstruction;
            let metaPromptTemplate: string;

            if (finalContext.length === 0) {
                finalSystemInstruction = "You are a helpful AI assistant. No context was provided, so answer the query to the best of your general knowledge.";
                metaPromptTemplate = `{query}`;
            } else if (webSearchSources.length > 0) {
                finalSystemInstruction = GENERAL_WEB_ASSISTANT_META_PROMPT;
                metaPromptTemplate = `Based on the following information, please answer the user's query...\n--- CONTEXT ---\n{context}\n--- END CONTEXT ---\n--- USER QUERY ---\n{query}`;
            } else {
                switch (focus_area) {
                    case "code_review": metaPromptTemplate = CODE_REVIEW_META_PROMPT; break;
                    case "code_explanation": metaPromptTemplate = CODE_EXPLANATION_META_PROMPT; break;
                    case "enhancement_suggestions": metaPromptTemplate = ENHANCEMENT_SUGGESTIONS_META_PROMPT; break;
                    case "bug_fixing": metaPromptTemplate = BUG_FIXING_META_PROMPT; break;
                    case "refactoring": metaPromptTemplate = REFACTORING_META_PROMPT; break;
                    case "testing": metaPromptTemplate = TESTING_META_PROMPT; break;
                    case "documentation": metaPromptTemplate = DOCUMENTATION_META_PROMPT; break;
                    case "code_modularization_orchestration": metaPromptTemplate = CODE_MODULARIZATION_ORCHESTATION_META_PROMPT; break;
                    case "codebase_analysis": metaPromptTemplate = CODE_ANALYSIS_META_PROMPT; break;
                    default: metaPromptTemplate = DEFAULT_CODEBASE_ASSISTANT_META_PROMPT;
                }
            }

            const focusString = analysis_focus_points?.length ? "Focus on:\n" + analysis_focus_points.map((p: string) => `- **${p}**`).join('\n') : "";
            const finalPromptContent = (focusString ? `${focusString}\n\n` : '') + metaPromptTemplate
                .replace('{context}', canonicalContextPart)
                .replace('{query}', query);

            try {
                const response = await geminiService.askGemini(finalPromptContent, model, finalSystemInstruction, undefined, thinkingConfig);
                const geminiText = response.content?.[0]?.text ?? '';

                const verificationPrompt = RagPromptTemplates.generateVerificationPrompt({
                    originalQuery: query,
                    contextString: canonicalContextPart,
                    generatedAnswer: geminiText
                });
                const verificationResult = await geminiService.askGemini(verificationPrompt, model, "You are a precise fact-checker. Respond only with VERIFIED or HALLUCINATION_DETECTED followed by issues.", undefined, thinkingConfig);
                const verificationText = verificationResult.content[0].text ?? "";

                let markdownOutput = `## Gemini Response for Query:\n> "${query}"\n\n### AI Answer:\n`;
                const aiAnswerContent = (geminiText.includes('\n') || geminiText.match(/[{[<>()=\-/\\.+*;:'"]}/))
                    ? formatJsonToMarkdownCodeBlock(geminiText, 'text')
                    : `> ${geminiText.replace(/\n/g, '\n> ')}`;
                markdownOutput += aiAnswerContent + '\n\n';

                if (verificationText.includes("HALLUCINATION_DETECTED")) {
                    markdownOutput += `**Warning:** Potential hallucinations detected:\n${formatJsonToMarkdownCodeBlock(verificationText.replace("HALLUCINATION_DETECTED", "").trim(), 'text')}\n`;
                } else {
                    markdownOutput += `**Verification Status:** Verified against provided context.\n`;
                }

                if (webSearchSources.length > 0) {
                    markdownOutput += `\n### Web Search Sources:\n` + webSearchSources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join('\n');
                }

                return { content: [{ type: 'text', text: markdownOutput }] };
            } catch (error: any) {
                throw new McpError(ErrorCode.InternalError, `Gemini API Error: ${error.message}`);
            }
        }
    }
};

export function getGeminiToolHandlers(memoryManager: MemoryManager) {
    return {
        'ask_gemini': (args: any, agent_id?: string) => {
            if (!askGeminiToolDefinition.func) {
                throw new McpError(ErrorCode.InternalError, 'ask_gemini handler not implemented');
            }
            return askGeminiToolDefinition.func(args, memoryManager);
        }
    };
}

export const geminiToolDefinitions: InternalToolDefinition[] = [
    {
        name: askGeminiToolDefinition.name,
        description: askGeminiToolDefinition.description,
        inputSchema: askGeminiToolDefinition.inputSchema
    }
];
