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
import { gitToolDefinitions, getGitToolHandlers } from './git_tools.js';
import { codeAnalysisToolDefinitions, getCodeAnalysisToolHandlers } from './code_analysis_tools.js';

import {
    getLoggingToolDefinitions,
    getLoggingToolHandlers
} from './logging_tools.js';

import { MemoryManager } from '../database/memory_manager.js';
import { GeminiIntegrationService } from '../database/services/GeminiIntegrationService.js';
import { DatabaseService } from '../database/services/DatabaseService.js';
import { ContextInformationManager } from '../database/managers/ContextInformationManager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { formatSimpleMessage } from '../utils/formatters.js';


export interface Tool {
    name: string;
    description: string;
    inputSchema: any;
}

export interface InternalToolDefinition extends Tool {
    func?: (args: any, memoryManagerInstance?: MemoryManager) => Promise<any>;
}

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

        const dbService = memoryManagerInstance.getDbService();
        const contextManager = memoryManagerInstance.getContextInformationManager();

        if (!dbService || !contextManager) {
            throw new McpError(ErrorCode.InternalError, "dbService or contextInformationManager not available via MemoryManager for GeminiIntegrationService");
        }

        if (!process.env.GEMINI_API_KEY) {
            throw new McpError(ErrorCode.InternalError, "Gemini API key (GEMINI_API_KEY) is not set.");
        }

        const geminiService = new GeminiIntegrationService(dbService, contextManager);
        try {
            const summary = await geminiService.summarizeCorrectionLogs(args.agent_id, args.maxLogs || 10);
            let md = `## Correction Log Summary for Agent: \`${args.agent_id}\`\n\n`;
            md += `${summary}\n`;
            return { content: [{ type: 'text', text: md }] };
        } catch (error: any) {
             throw new McpError(ErrorCode.InternalError, `Failed to summarize correction logs via Gemini: ${error.message}`);
        }
    }
};

// Helper: format usage from inputSchema
function formatUsage(inputSchema: any): string {
    if (!inputSchema || !inputSchema.properties) return '';
    const props = inputSchema.properties;
    const required = inputSchema.required || [];
    let usage = '';
    for (const key of Object.keys(props)) {
        const prop = props[key];
        const isRequired = required.includes(key);
        usage += `- \`${key}\` (${prop.type}${isRequired ? ', required' : ', optional'})\n`;
    }
    return usage;
}

export const listToolsToolDefinition: InternalToolDefinition = {
    name: 'list_tools',
    description: 'Lists all available tools with their descriptions and usage information in markdown format.',
    inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
    },
    func: async (args: any, memoryManagerInstance?: MemoryManager) => {
        if (!memoryManagerInstance) throw new McpError(ErrorCode.InternalError, "MemoryManager instance is required for list_tools");
        const allDefs = await getAllToolDefinitions(memoryManagerInstance);
        let md = '## Available Tools\n\n';
        for (const tool of allDefs) {
            md += `### \`${tool.name}\`\n`;
            md += `${tool.description}\n\n`;
            md += `**Usage:**\n`;
            md += formatUsage(tool.inputSchema);
            md += '\n---\n\n';
        }
        return { content: [{ type: 'text', text: md }] };
    }
};

export async function getAllToolDefinitions(memoryManager: MemoryManager): Promise<Tool[]> {
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
        ...stripToolFields(gitToolDefinitions),
        ...stripToolFields(codeAnalysisToolDefinitions),
        listToolsToolDefinition
    ];

    return allDefs;
}


export async function getAllToolHandlers(memoryManager: MemoryManager) {
    const loggingHandlers = getLoggingToolHandlers(memoryManager);

    const listToolsHandler = async (args: any) => {
        if (!listToolsToolDefinition.func) {
            throw new McpError(ErrorCode.InternalError, 'list_tools handler not implemented');
        }
        return listToolsToolDefinition.func(args, memoryManager);
    };

    return {
        ...getConversationToolHandlers(memoryManager),
        ...getContextToolHandlers(memoryManager),
        ...getReferenceToolHandlers(memoryManager),
        ...getSourceAttributionToolHandlers(memoryManager),
        ...getCorrectionToolHandlers(memoryManager),
        'summarize_correction_logs': (args: any) => {
            if (!geminiCorrectionSummarizerToolDefinition.func) {
                throw new McpError(ErrorCode.InternalError, 'summarize_correction_logs handler not implemented');
            }
            return geminiCorrectionSummarizerToolDefinition.func(args, memoryManager);
        },
        'list_tools': listToolsHandler,
        ...getSuccessMetricsToolHandlers(memoryManager),
        ...getDatabaseManagementToolHandlers(memoryManager),
        ...getPlanManagementToolHandlers(memoryManager),
        ...getPromptRefinementToolHandlers(memoryManager),
        ...getKnowledgeGraphToolHandlers(memoryManager),
        ...getModeInstructionToolHandlers(memoryManager),
        ...getReviewLogToolHandlers(memoryManager),
        ...getGeminiToolHandlers(memoryManager),
        ...getGitToolHandlers(),
        ...getCodeAnalysisToolHandlers(memoryManager),
        ...loggingHandlers,
    };
}
