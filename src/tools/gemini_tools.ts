import { MemoryManager } from '../database/memory_manager.js';
import { GeminiIntegrationService } from '../database/services/GeminiIntegrationService.js';
import { DatabaseService } from '../database/services/DatabaseService.js';
import { ContextInformationManager } from '../database/managers/ContextInformationManager.js';
import { InternalToolDefinition } from './index.js';

export const askGeminiToolDefinition: InternalToolDefinition = {
    name: 'ask_gemini',
    description: 'Asks a query to the Gemini external AI and returns the response.',
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
        if (!memoryManagerInstance) throw new Error("MemoryManager instance is required for ask_gemini");

        const dbService = (memoryManagerInstance as any).dbService as DatabaseService;
        const contextManager = (memoryManagerInstance as any).contextInformationManager as ContextInformationManager;

        if (!dbService || !contextManager) {
            console.error("MemoryManager does not expose dbService or contextInformationManager directly. Update access pattern.");
            throw new Error("dbService or contextInformationManager not available through MemoryManager for GeminiIntegrationService");
        }

        const geminiService = new GeminiIntegrationService(dbService, contextManager);
        try {
            const response = await geminiService.askGemini(args.query, args.model, args.systemInstruction);
            return { content: [{ type: 'text', text: response.content[0].text }] };
        } catch (error: any) {
            console.error(`Error asking Gemini:`, error);
            return { error: `Failed to get response from Gemini: ${error.message}` };
        }
    }
};

export function getGeminiToolHandlers(memoryManager: MemoryManager) {
    return {
        'ask_gemini': (args: any, agent_id?: string) => {
            if (!askGeminiToolDefinition.func) {
                throw new Error('ask_gemini handler not implemented');
            }
            return askGeminiToolDefinition.func(args, memoryManager, agent_id);
        }
    };
}

export const geminiToolDefinitions: InternalToolDefinition[] = [
    askGeminiToolDefinition
];
