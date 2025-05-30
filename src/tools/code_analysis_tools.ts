import fs from 'fs/promises'; // For reading file content
import { MemoryManager } from '../database/memory_manager.js';
import { GeminiIntegrationService } from '../database/services/GeminiIntegrationService.js';
import { DatabaseService } from '../database/services/DatabaseService.js';
import { ContextInformationManager } from '../database/managers/ContextInformationManager.js';
import { InternalToolDefinition } from './index.js'; // Assuming InternalToolDefinition is exported from tools/index.ts
import { formatSimpleMessage, formatMarkdownMessage } from '../utils/formatters.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-preview-05-20";

interface AnalyzeCodeFileArgs {
    agent_id: string;
    filepath: string;
    language: string | null;
    analysis_focus_points: string[];
    gemini_model_name?: string;
}

export const analyzeCodeFileToolDefinition: InternalToolDefinition = {
    name: 'analyze_code_file_with_gemini',
    description: 'Reads a file and performs a detailed line-by-line code analysis using Gemini, focusing on specified aspects. Output is Markdown formatted.',
    inputSchema: {
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: 'Identifier of the AI agent performing the analysis.' },
            filepath: { type: 'string', description: 'The path to the code file to be analyzed.' },
            language: { type: 'string', description: 'Optional: The programming language of the code (e.g., "typescript", "python"). Helps improve analysis accuracy.' , nullable: true},
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
            },
            gemini_model_name: {
                type: 'string',
                description: 'Optional: The specific Gemini model to use for the analysis. Defaults to "gemini-2.5-flash-preview-05-20".',
                default: 'gemini-1.5-pro-latest'
            }
        },
        required: ['agent_id', 'filepath']
    },
    /**
     * Analyzes a code file using Gemini and returns a detailed report.
     * @param args The arguments for the tool.
     * @param memoryManagerInstance The memory manager instance.
     * @returns A promise that resolves to an object containing the analysis report.
     */
    func: async (args: AnalyzeCodeFileArgs, memoryManagerInstance?: MemoryManager) => {
        if (!memoryManagerInstance) {
             throw new McpError(ErrorCode.InternalError, "MemoryManager instance is required for analyze_code_file_with_gemini");
        }

        const { agent_id, filepath, language, analysis_focus_points, gemini_model_name } = args;

        const CHUNK_SIZE = 10000; // Adjust as needed
        let analysisResult = "";
        let fileContent = "";
        let focusString = "all aspects including:\n1.  **Potential Bugs & Errors**: Identify any logical errors, runtime exceptions, or edge cases that might not be handled.\n2.  **Best Practices & Conventions**: Check for adherence to common coding standards and language-specific best practices.\n3.  **Performance**: Suggest optimizations for speed or resource usage, if applicable.\n4.  **Security Vulnerabilities**: Point out any potential security risks (e.g., XSS, SQL injection, insecure handling of secrets).\n5.  **Readability & Maintainability**: Comment on code clarity, naming conventions, and overall structure. Suggest improvements for easier understanding and future maintenance.";
        
        if (analysis_focus_points && analysis_focus_points.length > 0) {
            focusString = "the following aspects:\n" + analysis_focus_points.map((point: string, index: number) => `${index + 1}.  **${point}**`).join('\n');
        }

        const embeddingModelName = "gemini-embedding-exp";
        const modelToUse = gemini_model_name || analyzeCodeFileToolDefinition.inputSchema.properties.gemini_model_name.default as string;

        const dbService = (memoryManagerInstance as any).dbService as DatabaseService | undefined;
        const contextManager = (memoryManagerInstance as any).contextInformationManager as ContextInformationManager | undefined;

        if (!dbService || !contextManager) {
            throw new McpError(ErrorCode.InternalError, "dbService or contextInformationManager not available through MemoryManager for GeminiIntegrationService.");
        }

        if (!process.env.GEMINI_API_KEY) {
            throw new McpError(ErrorCode.InternalError, "Gemini API key (GEMINI_API_KEY) is not set in environment variables.");
        }

        const geminiService = new GeminiIntegrationService(dbService, contextManager, memoryManagerInstance);

        try {
            fileContent = await fs.readFile(filepath, 'utf-8');
        } catch (error: any) {
            console.error(`Error reading file ${filepath}:`, error);
            throw new McpError(ErrorCode.InvalidParams, `Failed to read file at path: ${filepath}. Error: ${error.message}`);
        }

        if (!fileContent.trim()) {
            return { content: [{ type: 'text', text: formatSimpleMessage(`File at \`${filepath}\` is empty. No code to analyze.`, "Code Analysis") }] };
        }

        for (let i = 0; i < fileContent.length; i += CHUNK_SIZE) {
            const chunk = fileContent.substring(i, i + CHUNK_SIZE);
            const chunkSystemPrompt = `You are an expert AI code reviewer. Your task is to analyze the provided code snippet and offer constructive feedback.
Focus on ${focusString}
Provide clear, concise, and actionable feedback. Structure your review logically, addressing specific lines or code blocks where applicable. Use Markdown for formatting, including code blocks for suggestions.
Begin your analysis with a brief overview of the code's purpose if discernible, then proceed to the detailed review.
If the language is not specified, try to infer it.`;

            const chunkUserQuery = `Please review the following ${language ? language + ' ' : ''}code from the file \`${filepath}\` (Chunk ${i / CHUNK_SIZE + 1}):\n\n\`\`\`${language || ''}\n${chunk}\n\`\`\`\n\nProvide a detailed analysis.`;

            try {
                const response = await geminiService.askGemini(chunkUserQuery, gemini_model_name || DEFAULT_GEMINI_MODEL, chunkSystemPrompt);
                const chunkAnalysisResult = response.content && response.content[0] && response.content[0].text
                    ? response.content[0].text
                    : "Gemini did not provide a specific analysis for this code chunk.";
                analysisResult += `\n\n--- Chunk ${i / CHUNK_SIZE + 1} Analysis: ---\n${chunkAnalysisResult}`;
            } catch (error: any) {
                console.error(`Error during Gemini code analysis for chunk ${i / CHUNK_SIZE + 1} of ${filepath} (agent_id: ${agent_id}):`, error);
                if (error instanceof McpError) throw error;
                throw new McpError(ErrorCode.InternalError, `Gemini code analysis failed for chunk ${i / CHUNK_SIZE + 1} of file ${filepath} (agent_id: ${agent_id}): ${error.message}`);
            }
        }

        // Format the output
        let markdownOutput = `## Code Analysis Report for \`${filepath}\`\n\n`;
        if(language) markdownOutput += `**Language:** ${language}\n`;
        markdownOutput += `**Focus Areas:** ${analysis_focus_points ? analysis_focus_points.join(', ') : 'General Comprehensive Review'}\n\n`;
        markdownOutput += "### Gemini's Analysis:\n\n";
        markdownOutput += analysisResult; // Assuming Gemini's response is already well-formatted or plain text.

        return { content: [{ type: 'text', text: markdownOutput }] };

    }
};

// Export handlers for this tool
/**
 * Returns the tool handlers for the code analysis tool.
 * @param memoryManager The memory manager instance.
 * @returns An object containing the tool handlers.
 */
export function getCodeAnalysisToolHandlers(memoryManager: MemoryManager) {
    return {
        [analyzeCodeFileToolDefinition.name]: (args: any, agent_id_from_server?: string) => {
            // Extract relevant information, e.g., the agent ID for logging
            const effective_agent_id = args.agent_id || agent_id_from_server || 'unknown';

            if (!analyzeCodeFileToolDefinition.func) {
                throw new McpError(ErrorCode.InternalError, `${analyzeCodeFileToolDefinition.name} handler not implemented`);
            }
            return analyzeCodeFileToolDefinition.func(args, memoryManager);
        }
    };
}

// Export definitions for MCP server listing
export const codeAnalysisToolDefinitions: InternalToolDefinition[] = [
    {
        name: analyzeCodeFileToolDefinition.name,
        description: analyzeCodeFileToolDefinition.description,
        inputSchema: analyzeCodeFileToolDefinition.inputSchema
        // func is not part of the public definition for MCP server
    }
];
