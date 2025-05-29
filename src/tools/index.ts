import { conversationToolDefinitions, getConversationToolHandlers } from './conversation_tools.js';
import { contextToolDefinitions, getContextToolHandlers } from './context_tools.js';
import { referenceToolDefinitions, getReferenceToolHandlers } from './reference_tools.js';
import { sourceAttributionToolDefinitions, getSourceAttributionToolHandlers } from './source_attribution_tools.js';
import { correctionToolDefinitions, getCorrectionToolHandlers } from './correction_tools.js';
import { successMetricsToolDefinitions, getSuccessMetricsToolHandlers } from './success_metrics_tools.js';
import { databaseManagementToolDefinitions, getDatabaseManagementToolHandlers } from './database_management_tools.js';
import { planManagementToolDefinitions, getPlanManagementToolHandlers } from './plan_management_tools.js';
import { promptRefinementToolDefinitions, getPromptRefinementToolHandlers } from './prompt_refinement_tools.js';
import { knowledgeGraphToolDefinitions, getKnowledgeGraphToolHandlers } from './knowledge_graph_tools.js';
import { getModeInstructionToolHandlers, modeInstructionToolDefinitions } from './mode_instruction_tools.js';
import { askGeminiToolDefinition, geminiToolDefinitions, getGeminiToolHandlers } from './gemini_tools.js';
import { reviewLogToolDefinitions, getReviewLogToolHandlers } from './review_log_tools.js';
import { gitToolDefinitions, getGitToolHandlers } from './git_tools.js';

import { 
    getLoggingToolDefinitions 
} from './logging_tools.js'; // Only need definitions, handlers are separate

import { MemoryManager } from '../database/memory_manager.js';
import { GeminiIntegrationService } from '../database/services/GeminiIntegrationService.js';
import { DatabaseService } from '../database/services/DatabaseService.js'; 
import { ContextInformationManager } from '../database/managers/ContextInformationManager.js'; 
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { formatSimpleMessage } from '../utils/formatters.js';


export interface Tool {
    name: string;
    description: string;
    inputSchema: object; 
}

export interface InternalToolDefinition extends Tool {
    func?: (args: any, memoryManagerInstance?: MemoryManager, agent_id?: string) => Promise<any>;
}

// Summarize Correction Logs tool (specific Gemini usage)
export const geminiCorrectionSummarizerToolDefinition: InternalToolDefinition = {
    name: 'summarize_correction_logs',
    description: 'Summarizes recent correction logs for an agent using Gemini, returning a concise list of past mistakes and strict instructions. Output is Markdown formatted.',
    inputSchema: {
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
            maxLogs: { type: 'number', description: 'Maximum number of logs to summarize.', default: 10 }
        },
        required: ['agent_id']
    },
    func: async (args: any, memoryManagerInstance?: MemoryManager) => {
        if (!memoryManagerInstance) throw new McpError(ErrorCode.InternalError, "MemoryManager instance is required for summarize_correction_logs");

        const dbService = (memoryManagerInstance as any).dbService as DatabaseService | undefined;
        const contextManager = (memoryManagerInstance as any).contextInformationManager as ContextInformationManager | undefined;

        if (!dbService || !contextManager) {
            throw new McpError(ErrorCode.InternalError, "dbService or contextInformationManager not available via MemoryManager for GeminiIntegrationService");
        }
        
        if (!process.env.GEMINI_API_KEY) {
            throw new McpError(ErrorCode.InternalError, "Gemini API key (GEMINI_API_KEY) is not set.");
        }

        const geminiService = new GeminiIntegrationService(dbService, contextManager);
        try {
            const summary = await geminiService.summarizeCorrectionLogs(args.agent_id, args.maxLogs || 10);
            // The summary from Gemini is expected to be a string, potentially already Markdown.
            // We'll wrap it for clarity.
            let md = `## Correction Log Summary for Agent: \`${args.agent_id}\`\n\n`;
            md += `${summary}\n`; // Assuming summary is the direct textual output
            return { content: [{ type: 'text', text: md }] };
        } catch (error: any) {
             throw new McpError(ErrorCode.InternalError, `Failed to summarize correction logs via Gemini: ${error.message}`);
        }
    }
};

export async function getAllToolDefinitions(): Promise<Tool[]> {
    const memoryManager = await MemoryManager.create();

    // Helper: strip only .name, .description, .inputSchema
    function stripToolFields(defArray: any[]): Tool[] {
        return defArray.map(d => ({
            name: d.name,
            description: d.description,
            inputSchema: d.inputSchema,
        }));
    }

    const allDefs: Tool[] = [
        ...stripToolFields(conversationToolDefinitions),
        ...stripToolFields(contextToolDefinitions),
        ...stripToolFields(referenceToolDefinitions),
        ...stripToolFields(sourceAttributionToolDefinitions),
        ...stripToolFields(correctionToolDefinitions),
        ...stripToolFields([geminiCorrectionSummarizerToolDefinition]),
        ...stripToolFields(successMetricsToolDefinitions),
        ...stripToolFields(databaseManagementToolDefinitions),
        ...stripToolFields(planManagementToolDefinitions),
        ...stripToolFields(promptRefinementToolDefinitions),
        ...stripToolFields(knowledgeGraphToolDefinitions),
        ...stripToolFields(modeInstructionToolDefinitions),
        ...stripToolFields(reviewLogToolDefinitions),
        ...stripToolFields(getLoggingToolDefinitions(memoryManager) as InternalToolDefinition[]),
        ...stripToolFields(geminiToolDefinitions),
        ...stripToolFields(gitToolDefinitions)
    ];

    console.log('DEBUG: allDefs count:', allDefs.length);
    console.log('DEBUG: allDefs names:', allDefs.map(d => d.name));

    return allDefs;
}


export async function getAllToolHandlers(memoryManager: MemoryManager) {
    // Dynamically get logging tool handlers
    const loggingToolModules = await import('./logging_tools.js');
    const loggingHandlers: { [key: string]: Function } = {};
    Object.values(loggingToolModules).forEach((toolFactory: any) => {
        if (typeof toolFactory === 'function' && toolFactory.name && toolFactory.name !== 'getLoggingToolDefinitions') {
            const tool = toolFactory(memoryManager);
            if (tool && tool.name && typeof tool.call === 'function') {
                loggingHandlers[tool.name] = tool.call;
            }
        }
    });
    
    return {
        ...getConversationToolHandlers(memoryManager),
        ...getContextToolHandlers(memoryManager),
        ...getReferenceToolHandlers(memoryManager),
        ...getSourceAttributionToolHandlers(memoryManager),
        ...getCorrectionToolHandlers(memoryManager),
        'summarize_correction_logs': (args: any, agent_id?: string) => { // agent_id from server if available
            if (!geminiCorrectionSummarizerToolDefinition.func) {
                throw new McpError(ErrorCode.InternalError, 'summarize_correction_logs handler not implemented');
            }
            return geminiCorrectionSummarizerToolDefinition.func(args, memoryManager, agent_id);
        },
        ...getSuccessMetricsToolHandlers(memoryManager),
        ...getDatabaseManagementToolHandlers(memoryManager),
        ...getPlanManagementToolHandlers(memoryManager),
        ...getPromptRefinementToolHandlers(memoryManager),
        ...getKnowledgeGraphToolHandlers(memoryManager),
        ...getModeInstructionToolHandlers(memoryManager), // These now correctly take memoryManager
        ...getReviewLogToolHandlers(memoryManager), // These now correctly take memoryManager
        ...getGeminiToolHandlers(memoryManager), // This now correctly takes memoryManager
        ...getGitToolHandlers(),
        ...loggingHandlers, // Add dynamically generated logging handlers
    };
}
