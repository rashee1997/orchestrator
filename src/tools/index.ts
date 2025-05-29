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
import { geminiToolDefinitions, getGeminiToolHandlers } from './gemini_tools.js';
import { reviewLogToolDefinitions, getReviewLogToolHandlers } from './review_log_tools.js';

import { 
    log_tool_execution, get_tool_execution_logs, update_tool_execution_log_status, 
    log_task_progress, get_task_progress_logs, update_task_progress_log_status, 
    log_error, get_error_logs, update_error_log_status, 
    update_correction_log_status, 
    getLoggingToolDefinitions 
} from './logging_tools.js';

import { MemoryManager } from '../database/memory_manager.js';
import { GeminiIntegrationService } from '../database/services/GeminiIntegrationService.js';
import { DatabaseService } from '../database/services/DatabaseService.js'; 
import { ContextInformationManager } from '../database/managers/ContextInformationManager.js'; 

export interface Tool { // This is the definition for MCP server capabilities
    name: string;
    description: string;
    inputSchema: object; 
}

/**
 * Internal type that can hold the 'func' property for handler association
 * Exported for use in other tools modules.
 */
export interface InternalToolDefinition extends Tool {
    func?: (args: any, memoryManagerInstance?: MemoryManager, agent_id?: string) => Promise<any>;
}


// Summarize Correction Logs tool
export const geminiCorrectionSummarizerToolDefinition: InternalToolDefinition = { // Conforms to InternalToolDefinition
    name: 'summarize_correction_logs',
    description: 'Summarizes recent correction logs for an agent using Gemini, returning a concise list of past mistakes and strict instructions.',
    inputSchema: {
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
            maxLogs: { type: 'number', description: 'Maximum number of logs to summarize.', default: 10 }
        },
        required: ['agent_id']
    },
    func: async (args: any, memoryManagerInstance?: MemoryManager) => {
        if (!memoryManagerInstance) throw new Error("MemoryManager instance is required for summarize_correction_logs");

        const dbService = (memoryManagerInstance as any).dbService as DatabaseService;
        const contextManager = (memoryManagerInstance as any).contextInformationManager as ContextInformationManager;

        if (!dbService || !contextManager) {
            // This check is important. Ensure dbService and contextManager are correctly accessed.
            // If MemoryManager doesn't expose them, this instantiation needs to be re-thought.
            // For example, MemoryManager could have a method: getGeminiService()
            console.error("MemoryManager does not expose dbService or contextInformationManager directly. Update access pattern.");
            throw new Error("dbService or contextInformationManager not available through MemoryManager for GeminiIntegrationService");
        }

        const geminiService = new GeminiIntegrationService(dbService, contextManager);
        const summary = await geminiService.summarizeCorrectionLogs(args.agent_id, args.maxLogs || 10);
        return { content: [{ type: 'text', text: summary }] };
    }
};

export async function getAllToolDefinitions(): Promise<Tool[]> {
    const memoryManager = await MemoryManager.create(); 
    
    // Array of definitions, some of which might have a 'func' property internally
    const definitionsWithFunc: Array<InternalToolDefinition> = [
        ...conversationToolDefinitions, // These are Tool[], compatible with InternalToolDefinition[]
        ...contextToolDefinitions,
        ...referenceToolDefinitions,
        ...sourceAttributionToolDefinitions,
        ...correctionToolDefinitions,
        geminiCorrectionSummarizerToolDefinition, // This one has func
        ...successMetricsToolDefinitions,
        ...databaseManagementToolDefinitions,
        ...planManagementToolDefinitions,
        ...promptRefinementToolDefinitions,
        ...knowledgeGraphToolDefinitions,
        ...modeInstructionToolDefinitions,
        ...reviewLogToolDefinitions,
        // getLoggingToolDefinitions returns Tool[] (name, desc, schema), compatible
        ...(getLoggingToolDefinitions(memoryManager) as InternalToolDefinition[]),
        ...geminiToolDefinitions,
    ];
    
    // Map to the MCP-expected Tool interface (stripping func)
    return definitionsWithFunc.map(def => {
        const { func, ...mcpSafeDef } = def; // 'func' might be undefined, which is fine for destructuring
        return mcpSafeDef; // mcpSafeDef will be of type Tool
    });
}


export function getAllToolHandlers(memoryManager: MemoryManager) {
    return {
        ...getConversationToolHandlers(memoryManager),
        ...getContextToolHandlers(memoryManager),
        ...getReferenceToolHandlers(memoryManager),
        ...getSourceAttributionToolHandlers(memoryManager),
        ...getCorrectionToolHandlers(memoryManager),
'summarize_correction_logs': (args: any, agent_id?: string) => {
    if (!geminiCorrectionSummarizerToolDefinition.func) {
        throw new Error('summarize_correction_logs handler not implemented');
    }
    return geminiCorrectionSummarizerToolDefinition.func(args, memoryManager, agent_id);
},
        ...getSuccessMetricsToolHandlers(memoryManager),
        ...getDatabaseManagementToolHandlers(memoryManager),
        ...getPlanManagementToolHandlers(memoryManager),
        ...getPromptRefinementToolHandlers(memoryManager),
        ...getKnowledgeGraphToolHandlers(memoryManager),
        ...getModeInstructionToolHandlers(memoryManager),
        ...getReviewLogToolHandlers(memoryManager),
        ...getGeminiToolHandlers(memoryManager),

        log_tool_execution: log_tool_execution(memoryManager).call,
        get_tool_execution_logs: get_tool_execution_logs(memoryManager).call,
        update_tool_execution_log_status: update_tool_execution_log_status(memoryManager).call,
        log_task_progress: log_task_progress(memoryManager).call,
        get_task_progress_logs: get_task_progress_logs(memoryManager).call,
        update_task_progress_log_status: update_task_progress_log_status(memoryManager).call,
        log_error: log_error(memoryManager).call,
        get_error_logs: get_error_logs(memoryManager).call,
        update_error_log_status: update_error_log_status(memoryManager).call,
        update_correction_log_status: update_correction_log_status(memoryManager).call,
    };
}

// Register tool validation schemas if needed
import { schemas } from '../utils/validation.js';
