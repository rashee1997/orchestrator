import { MemoryManager } from '../database/memory_manager.js';
import { promises as fs } from 'fs';
import path from 'path';
import { GeminiIntegrationService } from '../database/services/GeminiIntegrationService.js';
import { DatabaseService } from '../database/services/DatabaseService.js';
import { ContextInformationManager } from '../database/managers/ContextInformationManager.js';
import { InternalToolDefinition } from './index.js';
import { formatSimpleMessage, formatJsonToMarkdownCodeBlock } from '../utils/formatters.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { CODE_REVIEW_META_PROMPT, CODE_EXPLANATION_META_PROMPT, ENHANCEMENT_SUGGESTIONS_META_PROMPT, BUG_FIXING_META_PROMPT, REFACTORING_META_PROMPT, TESTING_META_PROMPT, DOCUMENTATION_META_PROMPT, DEFAULT_CODEBASE_ASSISTANT_META_PROMPT, CODE_MODULARIZATION_ORCHESTRATION_META_PROMPT } from '../database/services/gemini-integration-modules/GeminiPromptTemplates.js';
import { RetrievedCodeContext } from '../database/services/CodebaseContextRetrieverService.js';
import { formatRetrievedContextForPrompt } from '../database/services/gemini-integration-modules/GeminiContextFormatter.js';
import { parseGeminiJsonResponse } from '../database/services/gemini-integration-modules/GeminiResponseParsers.js';


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
    args: any,
    memoryManagerInstance: MemoryManager,
    geminiService: GeminiIntegrationService
): Promise<string> {
    const { agent_id, query, model, systemInstruction, max_iterations = 3, context_options } = args;
    const contextRetriever = memoryManagerInstance.getCodebaseContextRetrieverService();

    let accumulatedContext: RetrievedCodeContext[] = [];
    const processedEntities = new Set<string>();
    let currentSearchQuery = query;
    let finalAnswer = "";

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

        const analysisPrompt = `
You are an intelligent search orchestrator. Your goal is to answer the user's original query by iteratively searching a codebase.
Original Query: "${query}"
Current Search Turn: ${i + 1} of ${max_iterations}

---
Accumulated Context So Far:
${contextString}
---

Based on the accumulated context, please make a decision. Respond in this exact JSON format:
\`\`\`json
{
  "decision": "ANSWER" | "SEARCH_AGAIN",
  "reasoning": "Briefly explain your decision. If searching again, explain what information is missing and why it's needed.",
  "payload": {
    "final_answer": "...",
    "next_search_query": "..."
  }
}
\`\`\`
---
Instructions:
- If the accumulated context is sufficient to fully answer the original query, set "decision" to "ANSWER" and provide the "final_answer".
- If the context is still insufficient, set "decision" to "SEARCH_AGAIN". Formulate a concise and specific "next_search_query" to find the missing information (e.g., "implementations of AuthService", "usage of processPayment function", "contents of auth.middleware.ts").
- If you've reached the last turn (${max_iterations}), you MUST provide a final answer, even if it's incomplete. Set "decision" to "ANSWER".
- ONLY respond with the JSON object, and nothing else.
`;

        const analysisResult = await geminiService.askGemini(analysisPrompt, model, systemInstruction);
        const parsedResponse = parseGeminiJsonResponse(analysisResult.content[0].text ?? "{}");

        if ((parsedResponse.decision === "ANSWER" && parsedResponse.payload?.final_answer) || i === max_iterations - 1) {
            finalAnswer = parsedResponse?.payload?.final_answer || "Could not determine a final answer, but the search has concluded.";
            console.log(`[Iterative RAG] Turn ${i + 1}: Decision is to ANSWER. Concluding search.`);
            break;
        }

        if (parsedResponse.decision === "SEARCH_AGAIN" && parsedResponse.payload?.next_search_query) {
            currentSearchQuery = parsedResponse.payload.next_search_query;
            console.log(`[Iterative RAG] Turn ${i + 1}: Decision is to SEARCH_AGAIN. New query: "${currentSearchQuery}"`);
        } else {
            console.log(`[Iterative RAG] Turn ${i + 1}: Gemini did not provide a new valid search query. Concluding search.`);
            break;
        }
    }

    if (!finalAnswer) {
        console.log(`[Iterative RAG] Loop finished. Generating final answer from all gathered context.`);
        const finalPrompt = `Based on the user's original query "${query}" and all the context gathered below, please provide a comprehensive final answer.

        --- Accumulated Context ---
        ${formatRetrievedContextForPrompt(accumulatedContext)[0].text}
        --- End Context ---

        Final Comprehensive Answer:
        `;
        const finalResponse = await geminiService.askGemini(finalPrompt, model, systemInstruction);
        finalAnswer = finalResponse.content[0].text ?? "Failed to generate a final answer from the gathered context.";
    }

    return `## Iterative Search Result\n\n**Original Query:** "${query}"\n\n**Final Answer:**\n${finalAnswer}`;
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
                    "code_modularization_orchestration" // New focus area
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

        const { agent_id, query, model, systemInstruction, enable_rag, focus_area, analysis_focus_points, context_options, context_snippet_length, live_review_file_paths, enable_iterative_search } = args;
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

        // --- Main Logic Branching ---

        // Branch 1: Iterative Search (most complex)
        if (enable_iterative_search) {
            try {
                const resultText = await _performIterativeRagSearch(args, memoryManagerInstance, geminiService);
                return { content: [{ type: 'text', text: resultText }] };
            } catch (error: any) {
                console.error(`Error during iterative search:`, error);
                throw new McpError(ErrorCode.InternalError, `Iterative Search failed: ${error.message}`);
            }
        }

        let augmentedQuery = query;

        // Branch 2: Live Review (reads files directly, bypasses RAG)
        if (live_review_file_paths && Array.isArray(live_review_file_paths) && live_review_file_paths.length > 0) {
            try {
                let fullContextText = `Here is the content of the requested files, broken into chunks for review:\n\n`;

                const embeddingService = memoryManagerInstance.getCodebaseEmbeddingService();
                const chunkingService = embeddingService.chunkingService;
                const introspectionService = embeddingService.introspectionService;

                for (const filePath of live_review_file_paths) {
                    const fileContent = await fs.readFile(filePath, 'utf-8');
                    const language = await introspectionService.detectLanguage(agent_id, filePath, path.basename(filePath));
                    const chunks = chunkingService.chunkFileContentLive(fileContent, language);

                    fullContextText += `========================================\n`;
                    fullContextText += `FILE: ${path.basename(filePath)}\n`;
                    fullContextText += `========================================\n\n`;
                    fullContextText += chunks.map((chunk: string, index: number) => `--- Chunk ${index + 1} ---\n${chunk}`).join('\n\n');
                    fullContextText += `\n\n`;
                }

                augmentedQuery = `${fullContextText}\n\nBased on the file content provided above, please respond to the following query: "${query}"`;

                let focusString = "";
                if (focus_area === 'code_review') {
                    if (analysis_focus_points && analysis_focus_points.length > 0) {
                        focusString = "Focus on the following aspects:\n" + analysis_focus_points.map((point: string, index: number) => `${index + 1}.  **${point}**`).join('\n');
                    } else {
                        focusString = "Focus on all aspects including:\n1.  **Potential Bugs & Errors**\n2.  **Best Practices & Conventions**\n3.  **Performance**\n4.  **Security Vulnerabilities**\n5.  **Readability & Maintainability**";
                    }
                    augmentedQuery = `${focusString}\n\n${augmentedQuery}`;
                }


            } catch (fileError: any) {
                console.error(`Error during live file review for paths ${live_review_file_paths.join(', ')}:`, fileError);
                throw new McpError(ErrorCode.InternalError, `Failed to read or chunk one or more live files: ${fileError.message}`);
            }
            // Branch 3: Standard RAG
        } else if (enable_rag) {
            try {
                const contextRetrieverService = memoryManagerInstance.getCodebaseContextRetrieverService();
                let metaPromptTemplate = "";
                let focusString = "";

                if (analysis_focus_points && analysis_focus_points.length > 0) {
                    focusString = "Focus on the following aspects:\n" + analysis_focus_points.map((point: string, index: number) => `${index + 1}.  **${point}**`).join('\n');
                } else {
                    focusString = "Focus on all aspects including:\n1.  **Potential Bugs & Errors**\n2.  **Best Practices & Conventions**\n3.  **Performance**\n4.  **Security Vulnerabilities**\n5.  **Readability & Maintainability**";
                }

                switch (focus_area) {
                    case "code_review": metaPromptTemplate = CODE_REVIEW_META_PROMPT; break;
                    case "code_explanation": metaPromptTemplate = CODE_EXPLANATION_META_PROMPT; break;
                    case "enhancement_suggestions": metaPromptTemplate = ENHANCEMENT_SUGGESTIONS_META_PROMPT; break;
                    case "bug_fixing": metaPromptTemplate = BUG_FIXING_META_PROMPT; break;
                    case "refactoring": metaPromptTemplate = REFACTORING_META_PROMPT; break;
                    case "testing": metaPromptTemplate = TESTING_META_PROMPT; break;
                    case "documentation": metaPromptTemplate = DOCUMENTATION_META_PROMPT; break;
                    case "code_modularization_orchestration": metaPromptTemplate = CODE_MODULARIZATION_ORCHESTRATION_META_PROMPT; break;
                    default: metaPromptTemplate = DEFAULT_CODEBASE_ASSISTANT_META_PROMPT; break;
                }

                const contextResults = await contextRetrieverService.retrieveContextForPrompt(agent_id, query, context_options || {});
                const contextText = contextResults.map(res => {
                    const filePath = res.sourcePath;
                    const entityName = res.entityName ? ` (${res.entityName})` : '';
                    const contentPreview = res.content.substring(0, snippetLength);
                    return `File: \`${filePath}\` ${entityName}\n\`\`\`${res.metadata?.language || 'text'}\n${contentPreview}...\n\`\`\``;
                }).join("\n\n");

                augmentedQuery = metaPromptTemplate
                    .replace('{context}', contextText)
                    .replace('{query}', query);

                if (focus_area && ["code_review", "enhancement_suggestions", "bug_fixing", "refactoring", "testing", "documentation", "code_modularization_orchestration"].includes(focus_area)) {
                    augmentedQuery = `${focusString}\n\n${augmentedQuery}`;
                }
            } catch (error: any) {
                console.error(`Error in RAG process:`, error);
                throw new McpError(ErrorCode.InternalError, `Error during RAG context retrieval: ${error.message}`);
            }
        }

        // Common final execution path for all non-iterative scenarios
        try {
            const response = await geminiService.askGemini(augmentedQuery, model, systemInstruction);
            const geminiText = response.content?.[0]?.text ?? '';

            let markdownOutput = `## Gemini Response for Query:\n`;
            markdownOutput += `> "${query}"\n\n`;
            markdownOutput += `### AI Answer:\n`;

            if (geminiText.includes('\n') || geminiText.match(/[{[<>()=\-/\\.+*;:'"]]/)) {
                markdownOutput += formatJsonToMarkdownCodeBlock(geminiText, 'text') + '\n';
            } else {
                markdownOutput += `> ${geminiText.replace(/\n/g, '\n> ')}\n`;
            }
            return { content: [{ type: 'text', text: markdownOutput }] };
        } catch (error: any) {
            console.error(`Error asking Gemini:`, error);
            throw new McpError(ErrorCode.InternalError, `Gemini API Error: ${error.message}`);
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
