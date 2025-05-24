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

import { MemoryManager } from '../database/memory_manager.js';

export interface Tool {
    name: string;
    description: string;
    inputSchema: object; // Use camelCase to match other tools
    func: (args: any) => Promise<any>;
}

export const allToolDefinitions = [
    ...conversationToolDefinitions,
    ...contextToolDefinitions,
    ...referenceToolDefinitions,
    ...sourceAttributionToolDefinitions,
    ...correctionToolDefinitions,
    ...successMetricsToolDefinitions,
    ...databaseManagementToolDefinitions,
    ...planManagementToolDefinitions,
    ...promptRefinementToolDefinitions,
    ...knowledgeGraphToolDefinitions,
    ...modeInstructionToolDefinitions,
];
console.log('allToolDefinitions initialized:', allToolDefinitions.map(t => t.name));

export function getAllToolHandlers(memoryManager: MemoryManager) {
    return {
        ...getConversationToolHandlers(memoryManager),
        ...getContextToolHandlers(memoryManager),
        ...getReferenceToolHandlers(memoryManager),
        ...getSourceAttributionToolHandlers(memoryManager),
        ...getCorrectionToolHandlers(memoryManager),
        ...getSuccessMetricsToolHandlers(memoryManager),
        ...getDatabaseManagementToolHandlers(memoryManager),
        ...getPlanManagementToolHandlers(memoryManager),
        ...getPromptRefinementToolHandlers(memoryManager),
        ...getKnowledgeGraphToolHandlers(memoryManager),
        ...getModeInstructionToolHandlers(memoryManager),
    };
}
