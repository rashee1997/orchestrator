// src/tools/index.ts
import { conversationToolDefinitions, getConversationToolHandlers } from './conversation_tools.js';
import { aiTaskEnhancementToolDefinitions, getAiTaskEnhancementToolHandlers } from './ai_task_enhancement_tools.js';
import { tavilyToolDefinition, getTavilyToolHandlers } from './source_attribution_tools.js';
import { databaseManagementToolDefinitions, getDatabaseManagementToolHandlers } from './database_management_tools.js';
import { planManagementToolDefinitions, getPlanManagementToolHandlers } from './plan_management_tools.js';

import { knowledgeGraphToolDefinitions, getKnowledgeGraphToolHandlers } from './knowledge_graph_tools.js';
import { geminiToolDefinitions, getGeminiToolHandlers } from './gemini_tools.js';
import { embeddingToolDefinitions, getEmbeddingToolHandlers } from './embedding_tools.js';
import { promptRefinementToolDefinitions, getPromptRefinementToolHandlers } from './prompt_refinement_tools.js';
import { gitCommitToolDefinitions, getGitCommitToolHandlers } from './git_commit_tools.js';

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

function formatUsage(inputSchema: any): string {
    if (!inputSchema || !inputSchema.properties) return '';
    const props = inputSchema.properties;
    const required = inputSchema.required || [];
    let usage = '';
    for (const key of Object.keys(props)) {
        const prop = props[key];
        const isRequired = required.includes(key);
        usage += `- **\`${key}\`** (*${prop.type}*): ${prop.description || ''} ${isRequired ? '**[Required]**' : ''}\n`;
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
        let md = '# 🛠️ Available Tools\n\n';
        for (const tool of allDefs) {
            md += `## \`${tool.name}\`\n\n`;
            md += `> ${tool.description}\n\n`;
            if (tool.inputSchema && Object.keys(tool.inputSchema.properties || {}).length > 0) {
                md += `### Parameters\n`;
                md += formatUsage(tool.inputSchema);
            } else {
                md += `*This tool takes no parameters.*\n`
            }
            md += '\n---\n';
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
        ...stripFuncFromDefs(aiTaskEnhancementToolDefinitions),
        ...stripFuncFromDefs([tavilyToolDefinition]),
        ...stripFuncFromDefs(databaseManagementToolDefinitions),
        ...stripFuncFromDefs(planManagementToolDefinitions),
        ...stripFuncFromDefs(knowledgeGraphToolDefinitions),
        ...stripFuncFromDefs(promptRefinementToolDefinitions),
        ...stripFuncFromDefs(geminiToolDefinitions),
        ...stripFuncFromDefs(embeddingToolDefinitions),
        ...stripFuncFromDefs(gitCommitToolDefinitions),
        stripFuncFromDefs([listToolsToolDefinition])[0]
    ];

    return allDefs;
}


export async function getAllToolHandlers(memoryManager: MemoryManager) {

    const listToolsHandler = async (args: any) => {
        if (!listToolsToolDefinition.func) {
            throw new McpError(ErrorCode.InternalError, 'list_tools handler not implemented');
        }
        return listToolsToolDefinition.func(args, memoryManager);
    };


    return {
        ...getConversationToolHandlers(memoryManager),
        ...getAiTaskEnhancementToolHandlers(memoryManager),
        'list_tools': listToolsHandler,
        ...getDatabaseManagementToolHandlers(memoryManager),
        ...getPlanManagementToolHandlers(memoryManager),
        ...getKnowledgeGraphToolHandlers(memoryManager),
        ...getPromptRefinementToolHandlers(memoryManager),
        ...getGeminiToolHandlers(memoryManager),
        ...getEmbeddingToolHandlers(memoryManager),
        ...getTavilyToolHandlers(memoryManager),
        ...getGitCommitToolHandlers(memoryManager),
    };
}
