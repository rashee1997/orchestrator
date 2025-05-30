import { MemoryManager } from '../database/memory_manager.js';
import { GeminiIntegrationService } from '../database/services/GeminiIntegrationService.js';
import { DatabaseService } from '../database/services/DatabaseService.js';
import { ContextInformationManager } from '../database/managers/ContextInformationManager.js';
import { InternalToolDefinition } from './index.js';
import { formatSimpleMessage, formatJsonToMarkdownCodeBlock } from '../utils/formatters.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';


export const askGeminiToolDefinition: InternalToolDefinition = {
    name: 'ask_gemini',
    description: 'Asks a query to the Gemini external AI and returns the response, formatted as Markdown.',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'The query string to send to Gemini.' },
            model: { type: 'string', description: 'Optional: The Gemini model to use (e.g., "gemini-pro", "gemini-1.5-flash-latest"). Defaults to "gemini-1.5-flash-latest".', default: 'gemini-1.5-flash-latest' },
            systemInstruction: { type: 'string', description: 'Optional: A system instruction to guide the AI behavior.', nullable: true }
        },
        required: ['query']
    },
    func: async (args: any, memoryManagerInstance?: MemoryManager) => {
        if (!memoryManagerInstance) {
             const errorMsg = "MemoryManager instance is required for ask_gemini";
             console.error(errorMsg);
             throw new McpError(ErrorCode.InternalError, errorMsg);
        }

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
        
        // It's good practice to ensure Gemini API key is available before proceeding
        if (!process.env.GEMINI_API_KEY) {
            const errorMsg = "Gemini API key (GEMINI_API_KEY) is not set in environment variables.";
            console.error(errorMsg);
            throw new McpError(ErrorCode.InternalError, errorMsg); // Or InternalError if preferred
        }

        const geminiService = new GeminiIntegrationService(dbService, contextManager, memoryManagerInstance); // genAIInstance will be created internally if API key exists
        try {
            const response = await geminiService.askGemini(args.query, args.model, args.systemInstruction);
            const geminiText = response.content?.[0]?.text ?? ''; // Safely access text, default to empty string
            
            let markdownOutput = `## Gemini Response for Query:\n`;
            markdownOutput += `> "${args.query}"\n\n`;
            markdownOutput += `### AI Answer:\n`;
            
            if (geminiText.includes('\n') || geminiText.match(/[{[<>()=\-/\\.+*;:'"]]/)) {
                 markdownOutput += formatJsonToMarkdownCodeBlock(geminiText, 'text') + '\n';
            } else {
                 markdownOutput += `> ${geminiText.replace(/\n/g, '\n> ')}\n`;
            }
            return { content: [{ type: 'text', text: markdownOutput }] };
        } catch (error: any) {
            console.error(`Error asking Gemini:`, error);
            // Return a Markdown formatted error
            const errorMd = formatSimpleMessage(`Failed to get response from Gemini: ${error.message}`, "Gemini API Error");
            // For MCP, it's often better to throw an McpError so client knows it's a tool execution failure
            // However, if the goal is to return the error *as content*, then the below is fine.
            // For now, let's throw McpError as it's more standard for tool failures.
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
