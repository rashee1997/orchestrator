// src/tools/index.ts
import { conversationToolDefinitions, getConversationToolHandlers } from './conversation_tools.js';
import { referenceToolDefinitions, getReferenceToolHandlers } from './reference_tools.js';
import { sourceAttributionToolDefinitions, getSourceAttributionToolHandlers } from './source_attribution_tools.js';
import { successMetricsToolDefinitions, getSuccessMetricsToolHandlers } from './success_metrics_tools.js';
import { databaseManagementToolDefinitions, getDatabaseManagementToolHandlers } from './database_management_tools.js';
import { planManagementToolDefinitions, getPlanManagementToolHandlers } from './plan_management_tools.js';
import { promptRefinementToolDefinitions, getPromptRefinementToolHandlers } from './prompt_refinement_tools.js';
import { knowledgeGraphToolDefinitions, getKnowledgeGraphToolHandlers } from './knowledge_graph_tools.js';
import { getModeInstructionToolHandlers, modeInstructionToolDefinitions } from './mode_instruction_tools.js';
import { geminiToolDefinitions, getGeminiToolHandlers } from './gemini_tools.js';
import { reviewLogToolDefinitions, getReviewLogToolHandlers } from './review_log_tools.js';
import { embeddingToolDefinitions, getEmbeddingToolHandlers } from './embedding_tools.js';
import { aiTaskEnhancementToolDefinitions, getAiTaskEnhancementToolHandlers } from './ai_task_enhancement_tools.js';

import {
    getLoggingToolDefinitions,
    getLoggingToolHandlers
} from './logging_tools.js';

import { MemoryManager } from '../database/memory_manager.js';
import { GeminiIntegrationService } from '../database/services/GeminiIntegrationService.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

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

        const geminiService = memoryManagerInstance.getGeminiIntegrationService();
        if (!geminiService) {
             throw new McpError(ErrorCode.InternalError, "GeminiIntegrationService not available via MemoryManager.");
        }

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

function formatUsage(inputSchema: any): string {
    if (!inputSchema || !inputSchema.properties) return '';
    const props = inputSchema.properties;
    const required = inputSchema.required || [];
    let usage = '';
    for (const key of Object.keys(props)) {
        const prop = props[key];
        const isRequired = required.includes(key);
        usage += `- \`${key}\` (${prop.type}${isRequired ? ', required' : prop.default !== undefined ? `, optional (default: ${prop.default})` : ', optional'})${prop.description ? `: ${prop.description}` : ''}\n`;
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
            if (tool.inputSchema && Object.keys(tool.inputSchema.properties || {}).length > 0) {
                md += `**Parameters:**\n`;
                md += formatUsage(tool.inputSchema);
            } else {
                md += `*This tool takes no parameters.*\n`
            }
            md += '\n---\n\n';
        }
        return { content: [{ type: 'text', text: md }] };
    }
};

export async function getAllToolDefinitions(memoryManager: MemoryManager): Promise<Tool[]> {
    function stripFuncFromDefs(defArray: InternalToolDefinition[]): Tool[] {
        return defArray.map(({ func, ...tool }) => tool);
    }

    const allDefs: Tool[] = [
        ...stripFuncFromDefs(conversationToolDefinitions),
        ...stripFuncFromDefs(referenceToolDefinitions),
        ...stripFuncFromDefs(sourceAttributionToolDefinitions),
        ...stripFuncFromDefs([geminiCorrectionSummarizerToolDefinition]),
        ...stripFuncFromDefs(successMetricsToolDefinitions),
        ...stripFuncFromDefs(databaseManagementToolDefinitions),
        ...stripFuncFromDefs(planManagementToolDefinitions),
        ...stripFuncFromDefs(promptRefinementToolDefinitions),
        ...stripFuncFromDefs(knowledgeGraphToolDefinitions),
        ...stripFuncFromDefs(modeInstructionToolDefinitions),
        ...stripFuncFromDefs(reviewLogToolDefinitions),
        ...stripFuncFromDefs(getLoggingToolDefinitions(memoryManager) as InternalToolDefinition[]),
        ...stripFuncFromDefs(geminiToolDefinitions),
        ...stripFuncFromDefs(embeddingToolDefinitions), 
        ...stripFuncFromDefs(aiTaskEnhancementToolDefinitions), 
        stripFuncFromDefs([listToolsToolDefinition])[0] 
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

    const summarizeCorrectionLogsHandler = async (args: any) => {
        if (!geminiCorrectionSummarizerToolDefinition.func) {
            throw new McpError(ErrorCode.InternalError, 'summarize_correction_logs handler not implemented');
        }
        return geminiCorrectionSummarizerToolDefinition.func(args, memoryManager);
    };


    return {
        ...getConversationToolHandlers(memoryManager),
        ...getReferenceToolHandlers(memoryManager),
        ...getSourceAttributionToolHandlers(memoryManager),
        'summarize_correction_logs': summarizeCorrectionLogsHandler,
        'list_tools': listToolsHandler,
        ...getSuccessMetricsToolHandlers(memoryManager),
        ...getDatabaseManagementToolHandlers(memoryManager),
        ...getPlanManagementToolHandlers(memoryManager),
        ...getPromptRefinementToolHandlers(memoryManager),
        ...getKnowledgeGraphToolHandlers(memoryManager),
        ...getModeInstructionToolHandlers(memoryManager),
        ...getReviewLogToolHandlers(memoryManager),
        ...getGeminiToolHandlers(memoryManager),
        ...getEmbeddingToolHandlers(memoryManager), 
        ...getAiTaskEnhancementToolHandlers(memoryManager), 
        ...loggingHandlers,
    };
}
