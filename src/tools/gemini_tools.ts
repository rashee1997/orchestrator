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


export const askGeminiToolDefinition: InternalToolDefinition = {
    name: 'ask_gemini',
    description: 'Asks a query to the Gemini external AI and returns the response, formatted as Markdown. Supports optional focus areas like "code_review", "code_explanation", "enhancement_suggestions", "bug_fixing", "refactoring", "testing", and "documentation" for tailored responses.',
    inputSchema: {
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: 'The agent ID to use for context retrieval.' },
            query: { type: 'string', description: 'The query string to send to Gemini.' },
            model: { type: 'string', description: 'Optional: The Gemini model to use (e.g., "gemini-pro", "gemini-1.5-flash-latest"). Defaults to "gemini-2.5-flash-preview-05-20".', default: 'gemini-2.5-flash-preview-05-20' },
            systemInstruction: { type: 'string', description: 'Optional: A system instruction to guide the AI behavior.', nullable: true },
            enable_rag: { type: 'boolean', description: 'Optional: Enable retrieval-augmented generation (RAG) with codebase context.', default: false, nullable: true },
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

        const { agent_id, query, model, systemInstruction, enable_rag, focus_area, analysis_focus_points, context_options, context_snippet_length, live_review_file_paths } = args;
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
        let augmentedQuery = query;

        // New "Live Review" Path
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
                
                // Use the existing focusString logic for reviews
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
        // Existing RAG and no-RAG logic
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

        // Common final execution path for all scenarios
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
