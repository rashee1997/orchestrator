import Database from 'better-sqlite3'; // Still needed for type inference if not for direct use
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Import necessary services and managers from the build directory
import { MemoryManager } from './build/database/memory_manager.js';
// CodebaseEmbeddingService, GeminiIntegrationService, initializeVectorStoreDatabase are now managed by MemoryManager
import { getEmbeddingToolHandlers } from './build/tools/embedding_tools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MCP_ROOT_PATH = path.resolve(__dirname);
// const VECTOR_DB_PATH = path.join(MCP_ROOT_PATH, 'vector_store.db'); // No longer directly used here

console.log(`Attempting to run tool cleanup script from: ${MCP_ROOT_PATH}`);

async function runToolCleanup() {
    let memoryManagerInstance;
    try {
        // Initialize the MemoryManager, which in turn initializes the vector store database
        memoryManagerInstance = await MemoryManager.create(MCP_ROOT_PATH);
        console.log('MemoryManager and Database initialized successfully.');

        // Get the tool handlers
        const toolHandlers = getEmbeddingToolHandlers(memoryManagerInstance);
        const cleanUpTool = toolHandlers['clean_up_embeddings'];

        const filePathToDelete = 'src/types/better-sqlite3.d.ts';
        const projectRootPath = MCP_ROOT_PATH; // Current working directory is the project root

        console.log(`Calling clean_up_embeddings tool handler for: ${filePathToDelete}`);
        const args = {
            agent_id: 'cline',
            file_paths: [filePathToDelete],
            project_root_path: projectRootPath
        };

        const result = await cleanUpTool(args, 'cline'); // Pass agent_id as second arg as well

        console.log(`Tool execution result:`);
        console.log(JSON.stringify(result, null, 2));

    } catch (error) {
        console.error('Error during tool execution:', error);
    } finally {
        if (memoryManagerInstance) {
            await memoryManagerInstance.closeAllDbConnections(); // Ensure all DB connections are closed
            console.log('Database operation finished.');
        }
    }
}

runToolCleanup();
