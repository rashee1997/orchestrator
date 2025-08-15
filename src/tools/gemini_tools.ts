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
import { Part } from '@google/genai'; // Assuming Part is from here
import { ContextRetrievalOptions } from '../database/services/CodebaseContextRetrieverService.js'; // Assuming ContextRetrievalOptions is from here
import { callTavilyApi } from '../integrations/tavily.js'; // <-- ADD TAVILY IMPORT


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
    args: {
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
    },
    memoryManagerInstance: MemoryManager,
    geminiService: GeminiIntegrationService
): Promise<{ accumulatedContext: RetrievedCodeContext[]; webSearchSources: { title: string; url: string }[]; }> {
    const { agent_id, query, model, systemInstruction, max_iterations = 3, context_options, focus_area, analysis_focus_points, enable_web_search } = args;
    const contextRetriever = memoryManagerInstance.getCodebaseContextRetrieverService();

    let accumulatedContext: RetrievedCodeContext[] = [];
    const processedEntities = new Set<string>();
    let currentSearchQuery = query;
    let focusString = ""; // Declare focusString here
    const webSearchSources: { title: string; url: string }[] = []; // Initialize webSearchSources

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

        const contextString = formatRetrievedContextForPrompt(accumulatedContext)[0].text;

        if (focus_area) {
            if (analysis_focus_points && analysis_focus_points.length > 0) {
                focusString = `Focus on the following aspects for your analysis and response:\n` + analysis_focus_points.map((point: string, index: number) => `${index + 1}.  **${point}**`).join('\n');
            } else {
                switch (focus_area) {
                    case "code_review": focusString = "Focus on all aspects including:\n1.  **Potential Bugs & Errors**\n2.  **Best Practices & Conventions**\n3.  **Performance**\n4.  **Security Vulnerabilities**\n5.  **Readability & Maintainability**"; break;
                    case "code_explanation": focusString = "Focus on explaining the code clearly and concisely."; break;
                    case "enhancement_suggestions": focusString = "Focus on suggesting improvements and enhancements."; break;
                    case "bug_fixing": focusString = "Focus on identifying and suggesting fixes for bugs."; break;
                    case "refactoring": focusString = "Focus on suggesting refactoring opportunities."; break;
                    case "testing": focusString = "Focus on testing strategies and test case generation."; break;
                    case "documentation": focusString = "Focus on generating or improving documentation."; break;
                    case "code_modularization_orchestration": focusString = "Focus on modularity, architecture, and orchestration patterns."; break;
                    default: focusString = ""; break;
                }
            }
            if (focusString) {
                focusString = `--- Focus Area ---\n${focusString}\n\n`;
            }
        }

        const analysisPrompt = `
You are an intelligent search orchestrator. Your goal is to answer the user's original query by iteratively searching a codebase and, if necessary, the web.
Original Query: "${query}"
Current Search Turn: ${i + 1} of ${max_iterations}

${focusString}---
Accumulated Context So Far:
${contextString}
---

Based on the accumulated context, please make a decision. Respond in this exact plain text format:
Decision: [ANSWER|SEARCH_AGAIN|SEARCH_WEB]
Reasoning: [Briefly explain your decision. If searching again, explain what is missing. If searching the web, explain why external info is needed.]
Next Codebase Search Query: [Only if decision is SEARCH_AGAIN, provide a query to find missing code info.]
Next Web Search Query: [Only if decision is SEARCH_WEB or USE_WEB_SEARCH_IF_BENEFICIAL, provide a concise query for a web search engine.]
---
Instructions:
- If the **accumulated context** (from codebase or web search) is sufficient to fully answer the original query, set "Decision" to "ANSWER".
- If more **codebase** information is needed, set "Decision" to "SEARCH_AGAIN".
- If the query requires **external, real-time, or third-party library information** not found in the code, set "Decision" to "SEARCH_WEB".
- **If \`enable_web_search\` is true and the query could benefit from external, real-time, or up-to-date information (even if codebase context is somewhat sufficient), set "Decision" to "USE_WEB_SEARCH_IF_BENEFICIAL".**
- If you've reached the last turn (${max_iterations}), you MUST set "Decision" to "ANSWER".
`;

        const geminiSystemInstruction = `You are a highly precise AI. Your ONLY output must be in the exact plain text format specified in the user's prompt. Do NOT include any conversational text, markdown, or any other characters.`;
        const analysisResult = await geminiService.askGemini(analysisPrompt, model, geminiSystemInstruction);
        const rawResponseText = analysisResult.content[0].text ?? "";

        const decisionMatch = rawResponseText.match(/Decision:\s*(ANSWER|SEARCH_AGAIN|SEARCH_WEB|USE_WEB_SEARCH_IF_BENEFICIAL)/i);
        const nextCodebaseQueryMatch = rawResponseText.match(/Next Codebase Search Query:\s*([\s\S]*?)(?=\nNext Web Search Query:|\n---|$)/i);
        const nextWebQueryMatch = rawResponseText.match(/Next Web Search Query:\s*([\s\S]*?)(?=\n---|$)/i); // <-- PARSE WEB QUERY

        const decision = decisionMatch ? decisionMatch[1].toUpperCase() : '';
        const nextCodebaseQuery = nextCodebaseQueryMatch ? nextCodebaseQueryMatch[1].trim() : '';
        const nextWebQuery = nextWebQueryMatch ? nextWebQueryMatch[1].trim() : ''; // <-- GET WEB QUERY

        if (decision === "ANSWER" || i === max_iterations - 1) {
            console.log(`[Iterative RAG] Turn ${i + 1}: Decision is to ANSWER. Concluding search.`);
            break;
        }

        // --- NEW LOGIC FOR WEB SEARCH ---
        if (enable_web_search && (decision === "SEARCH_WEB" || decision === "USE_WEB_SEARCH_IF_BENEFICIAL") && nextWebQuery) {
            console.log(`[Iterative RAG] Turn ${i + 1}: Decision is to SEARCH_WEB. Query: "${nextWebQuery}"`);
            try {
                const webResults = await callTavilyApi(nextWebQuery);
                webResults.forEach((res: any) => {
                    webSearchSources.push({ title: res.title, url: res.url }); // Populate webSearchSources

                    const webContext: RetrievedCodeContext = {
                        type: 'documentation',
                        sourcePath: res.url, // Use the actual URL as sourcePath
                        entityName: res.title, // Use the title as entityName
                        content: res.content, // Individual content
                        relevanceScore: 0.95,
                    };
                    accumulatedContext.push(webContext);
                    processedEntities.add(`${res.url}::${res.title}`); // Prevent re-searching the same web result
                });
            } catch (webError: any) {
                console.error(`[Iterative RAG] Tavily web search failed: ${webError.message}`);
                // Optionally add an error context item
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

    return { accumulatedContext, webSearchSources };
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

        const { agent_id, query, model, systemInstruction, enable_rag, focus_area, analysis_focus_points, context_options, context_snippet_length, live_review_file_paths, enable_iterative_search, execution_mode, target_ai_persona, conversation_context_ids } = args;
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

        try {
            if (enable_iterative_search) {
                console.log("[ask_gemini] Starting Stage 1: Iterative Search Context Acquisition");
                const iterativeResult = await _performIterativeRagSearch(args, memoryManagerInstance, geminiService);
                finalContext = iterativeResult.accumulatedContext;
                webSearchSources = iterativeResult.webSearchSources;
            } else if (live_review_file_paths && Array.isArray(live_review_file_paths) && live_review_file_paths.length > 0) {
                console.log("[ask_gemini] Starting Stage 1: Live File Review Context Acquisition");
                const embeddingService = memoryManagerInstance.getCodebaseEmbeddingService();
                const chunkingService = embeddingService.chunkingService;
                const introspectionService = embeddingService.introspectionService;

                for (const filePath of live_review_file_paths) {
                    const fileContent = await fs.readFile(filePath, 'utf-8');
                    const language = await introspectionService.detectLanguage(agent_id, filePath, path.basename(filePath));
                    const chunks = chunkingService.chunkFileContentLive(fileContent, language);
                    chunks.forEach((chunk, index) => {
                        finalContext.push({
                            type: 'file_snippet', // Correct the type to 'file_snippet'
                            sourcePath: filePath,
                            entityName: `chunk_${index + 1}`,
                            content: chunk,
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
            let finalPromptContent = "";
            let finalSystemInstruction = systemInstruction;

            if (finalContext.length > 0) {
                let metaPromptTemplate: string;

                if (webSearchSources.length > 0) {
                    finalSystemInstruction = GENERAL_WEB_ASSISTANT_META_PROMPT;
                    // This is a simple template to structure the data for the AI, not an instruction template.
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
                        // For web results, provide the full content and the citation info clearly.
                        return `Source: ${citation}\nContent: ${res.content}`;
                    } else {
                        // For codebase results, provide a snippet.
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

                let markdownOutput = `## Gemini Response for Query:\n`;
                markdownOutput += `> "${query}"\n\n`;
                markdownOutput += `### AI Answer:\n`;

                let aiAnswerContent = '';
                if (geminiText.includes('\n') || geminiText.match(/[{[<>()=\-/\\.+*;:'"]]/)) {
                    aiAnswerContent = formatJsonToMarkdownCodeBlock(geminiText, 'text');
                } else {
                    aiAnswerContent = `> ${geminiText.replace(/\n/g, '\n> ')}`;
                }

                markdownOutput += aiAnswerContent + '\n';

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