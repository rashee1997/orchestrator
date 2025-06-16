import { MemoryManager } from '../database/memory_manager.js';
import { GeminiIntegrationService } from '../database/services/GeminiIntegrationService.js';
import { DatabaseService } from '../database/services/DatabaseService.js';
import { ContextInformationManager } from '../database/managers/ContextInformationManager.js';
import { InternalToolDefinition } from './index.js';
import { formatSimpleMessage, formatJsonToMarkdownCodeBlock } from '../utils/formatters.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { CODE_REVIEW_META_PROMPT, CODE_EXPLANATION_META_PROMPT, ENHANCEMENT_SUGGESTIONS_META_PROMPT, BUG_FIXING_META_PROMPT, REFACTORING_META_PROMPT, TESTING_META_PROMPT, DOCUMENTATION_META_PROMPT, DEFAULT_CODEBASE_ASSISTANT_META_PROMPT } from '../database/services/gemini-integration-modules/GeminiPromptTemplates.js';


export const askGeminiToolDefinition: InternalToolDefinition = {
    name: 'ask_gemini',
    description: 'Asks a query to the Gemini external AI and returns the response, formatted as Markdown. Supports optional focus areas like "code_review", "code_explanation", "enhancement_suggestions", "bug_fixing", "refactoring", "testing", and "documentation" for tailored responses.',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'The query string to send to Gemini.' },
            model: { type: 'string', description: 'Optional: The Gemini model to use (e.g., "gemini-pro", "gemini-1.5-flash-latest"). Defaults to "gemini-2.5-flash-preview-05-20".', default: 'gemini-2.5-flash-preview-05-20' },
            systemInstruction: { type: 'string', description: 'Optional: A system instruction to guide the AI behavior.', nullable: true },
            enable_rag: { type: 'boolean', description: 'Optional: Enable retrieval-augmented generation (RAG) with codebase context.', default: false, nullable: true },
            focus_area: { type: 'string', description: 'Optional: Focus area for the response (e.g., code review, code explanation, enhancement suggestions).', nullable: true },
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
        required: ['query']
    },
    func: async (args: any, memoryManagerInstance?: MemoryManager) => {
        if (!memoryManagerInstance) {
            const errorMsg = "MemoryManager instance is required for ask_gemini";
            console.error(errorMsg);
            throw new McpError(ErrorCode.InternalError, errorMsg);
        }

        const { query, model, systemInstruction, enable_rag, focus_area, analysis_focus_points, context_options, context_snippet_length } = args;
        const snippetLength = context_snippet_length !== undefined ? context_snippet_length : 200;

        // Access dbService and contextManager via memoryManagerInstance's public getters or properties
        // This assumes MemoryManager exposes these, or provides a method to get GeminiIntegrationService
        const dbService = (memoryManagerInstance as any).dbService as DatabaseService | undefined;
        const contextManager = (memoryManagerInstance as any).contextInformationManager as ContextInformationManager | undefined;

        if (!dbService || !contextManager) {
            const errorMsg = "dbService or contextInformationManager not available through MemoryManager for GeminiIntegrationService. Update access pattern in MemoryManager or tool.";
            console.error(errorMsg);
            // It's better to throw an McpError for the MCP server to handle
            throw new McpError(ErrorCode.InternalError, errorMsg);
        }

        const contextRetrieverService = memoryManagerInstance.getCodebaseContextRetrieverService();

        let augmentedQuery = query;
        if (enable_rag) {
            try {
                let metaPromptTemplate = "";
                let focusString = "";

                if (analysis_focus_points && analysis_focus_points.length > 0) {
                    focusString = "Focus on the following aspects:\n" + analysis_focus_points.map((point: string, index: number) => `${index + 1}.  **${point}**`).join('\n');
                } else {
                    focusString = "Focus on all aspects including:\n1.  **Potential Bugs & Errors**: Identify any logical errors, runtime exceptions, or edge cases that might not be handled.\n2.  **Best Practices & Conventions**: Check for adherence to common coding standards and language-specific best practices.\n3.  **Performance**: Suggest optimizations for speed or resource usage, if applicable.\n4.  **Security Vulnerabilities**: Point out any potential security risks (e.g., XSS, SQL injection, insecure handling of secrets).\n5.  **Readability & Maintainability**: Comment on code clarity, naming conventions, and overall structure. Suggest improvements for easier understanding and future maintenance.";
                }

                switch (focus_area) {
                    case "code_review":
                        metaPromptTemplate = CODE_REVIEW_META_PROMPT;
                        break;
                    case "code_explanation":
                        metaPromptTemplate = CODE_EXPLANATION_META_PROMPT;
                        break;
                    case "enhancement_suggestions":
                        metaPromptTemplate = ENHANCEMENT_SUGGESTIONS_META_PROMPT;
                        break;
                    case "bug_fixing":
                        metaPromptTemplate = BUG_FIXING_META_PROMPT;
                        break;
                    case "refactoring":
                        metaPromptTemplate = REFACTORING_META_PROMPT;
                        break;
                    case "testing":
                        metaPromptTemplate = TESTING_META_PROMPT;
                        break;
                    case "documentation":
                        metaPromptTemplate = DOCUMENTATION_META_PROMPT;
                        break;
                    default:
                        metaPromptTemplate = DEFAULT_CODEBASE_ASSISTANT_META_PROMPT;
                        break;
                }

                const contextResults = await contextRetrieverService.retrieveContextForPrompt("cline", query, context_options || {});
                const contextText = contextResults.map(res => {
                    const filePath = res.sourcePath;
                    const entityName = res.entityName ? ` (${res.entityName})` : '';
                    const contentPreview = res.content.substring(0, snippetLength);
                    return `File: \`${filePath}\` ${entityName}\n\`\`\`${res.metadata?.language || 'text'}\n${contentPreview}...\n\`\`\``;
                }).join("\n\n");

                augmentedQuery = metaPromptTemplate
                    .replace('{context}', contextText)
                    .replace('{query}', query);
                
                if (focus_area && ["code_review", "enhancement_suggestions", "bug_fixing", "refactoring", "testing", "documentation"].includes(focus_area)) {
                    augmentedQuery = `${focusString}\n\n${augmentedQuery}`;
                }

                // It's good practice to ensure Gemini API key is available before proceeding
                if (!process.env.GEMINI_API_KEY) {
                    const errorMsg = "Gemini API key (GEMINI_API_KEY) is not set in environment variables.";
                    console.error(errorMsg);
                    throw new McpError(ErrorCode.InternalError, errorMsg);
                }

                const geminiService = new GeminiIntegrationService(dbService, contextManager, memoryManagerInstance);
                const response = await geminiService.askGemini(augmentedQuery, model, systemInstruction, contextResults);
                const geminiText = response.content?.[0]?.text ?? '';
                const confidenceScore = response.confidenceScore;

                let markdownOutput = `## Gemini Response for Query:\n`;
                markdownOutput += `> "${query}"\n\n`;
                if (confidenceScore !== undefined) {
                    markdownOutput += `**Confidence Score:** ${confidenceScore.toFixed(4)}\n\n`;
                }
                markdownOutput += `### AI Answer:\n`;

                if (geminiText.includes('\n') || geminiText.match(/[{[<>()=\-/\\.+*;:'"]]/)) {
                    markdownOutput += formatJsonToMarkdownCodeBlock(geminiText, 'text') + '\n';
                } else {
                    markdownOutput += `> ${geminiText.replace(/\n/g, '\n> ')}\n`;
                }
                return { content: [{ type: 'text', text: markdownOutput }] };

            } catch (error: any) {
                console.error(`Error asking Gemini:`, error);
                const errorMd = formatSimpleMessage(`Failed to get response from Gemini: ${error.message}`, "Gemini API Error");
                throw new McpError(ErrorCode.InternalError, `Gemini API Error: ${error.message}`);
            }
        } else {
             // It's good practice to ensure Gemini API key is available before proceeding
            if (!process.env.GEMINI_API_KEY) {
                const errorMsg = "Gemini API key (GEMINI_API_KEY) is not set in environment variables.";
                console.error(errorMsg);
                throw new McpError(ErrorCode.InternalError, errorMsg);
            }

            const geminiService = new GeminiIntegrationService(dbService, contextManager, memoryManagerInstance);
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
                const errorMd = formatSimpleMessage(`Failed to get response from Gemini: ${error.message}`, "Gemini API Error");
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
