import { MemoryManager } from '../database/memory_manager.js';
import { CodebaseIntrospectionService } from '../database/services/CodebaseIntrospectionService.js';
import { knowledgeGraphToolDefinitions as definitions } from './kg_tool_modules/definitions.js';
import { getIngestionHandlers } from './kg_tool_modules/ingestion.js';
import { getMemoryHandler } from './kg_tool_modules/memory.js';
import { getQueryHandlers } from './kg_tool_modules/query.js';

export const knowledgeGraphToolDefinitions = definitions;

export function getKnowledgeGraphToolHandlers(memoryManager: MemoryManager) {
    const codebaseIntrospectionService = new CodebaseIntrospectionService(
        memoryManager,
        memoryManager.getGeminiIntegrationService(),
        memoryManager.projectRootPath
    );

    const ingestionHandlers = getIngestionHandlers(memoryManager, codebaseIntrospectionService);
    const memoryHandler = getMemoryHandler(memoryManager);
    const queryHandlers = getQueryHandlers(memoryManager);

    return {
        ...ingestionHandlers,
        ...memoryHandler,
        ...queryHandlers,
    };
}
