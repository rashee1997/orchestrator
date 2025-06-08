import { KnowledgeGraphManager } from '../managers/KnowledgeGraphManager.js';
import { KnowledgeGraphManagerV2 } from '../managers/KnowledgeGraphManagerV2.js';
import { DatabaseService } from '../services/DatabaseService.js';
import { GeminiIntegrationService } from '../services/GeminiIntegrationService.js';
import { CodebaseEmbeddingService } from '../services/CodebaseEmbeddingService.js'; // Import CodebaseEmbeddingService
import { getKnowledgeGraphConfig } from '../../config/knowledge_graph_config.js';
import { KnowledgeGraphMigrator } from '../../tools/migration/KnowledgeGraphMigrator.js';
import path from 'path';
import { fileURLToPath } from 'url';

export interface IKnowledgeGraphManager {
    createEntities(agentId: string, entities: Array<{ name: string; entityType: string; observations?: string[] }>): Promise<any>;
    createRelations(agentId: string, relations: Array<{ from: string; to: string; relationType: string }>): Promise<any>;
    addObservations(agentId: string, observations: Array<{ entityName: string; contents: string[] }>): Promise<any>;
    deleteEntities(agentId: string, entityNames: string[]): Promise<any>;
    deleteObservations(agentId: string, deletions: Array<{ entityName: string; observations: string[] }>): Promise<any>;
    deleteRelations(agentId: string, relationsToDelete: Array<{ from: string; to: string; relationType: string }>): Promise<any>;
    readGraph(agentId: string): Promise<{ nodes: any[]; relations: any[] }>;
    searchNodes(agentId: string, query: string): Promise<any[]>;
    openNodes(agentId: string, names: string[]): Promise<any[]>;
    queryNaturalLanguage(agentId: string, naturalLanguageQuery: string): Promise<string>;
    inferRelations(agentId: string, entityNames?: string[], context?: string): Promise<{ message: string; details: any[] }>;
    generateMermaidGraph(agentId: string, options: any): Promise<string>;
    getExistingRelation(agentId: string, fromNodeName: string, toNodeName: string, relationType: string): Promise<any | null>;
}

export class KnowledgeGraphFactory {
    private static instance: IKnowledgeGraphManager = null!;
    private static config = getKnowledgeGraphConfig();

    static async create(
        memoryManager: import("../memory_manager.js").MemoryManager
    ): Promise<IKnowledgeGraphManager> {
        // If already created, return the existing instance
        if (this.instance) {
            return this.instance;
        }

        const config = this.config;

        if (config.useJsonlBackend) {
            console.log('Using JSONL-based Knowledge Graph Manager');
            
            // Get the project root directory
            const __filename = fileURLToPath(import.meta.url);
            const __dirname = path.dirname(__filename);
            const projectRoot = path.resolve(__dirname, '..', '..', '..');
            
            // Create the V2 manager with the correct path
            const jsonlRootPath = path.join(projectRoot, config.jsonlRootPath || 'knowledge_graphs');
            const managerV2 = new KnowledgeGraphManagerV2(jsonlRootPath, memoryManager.getGeminiIntegrationService());
            
            // If auto-migrate is enabled, check if migration is needed
            if (config.autoMigrate) {
                const migrator = new KnowledgeGraphMigrator(memoryManager.getDbService(), jsonlRootPath);
                // You could add logic here to check if migration is needed
                console.log('Auto-migration check completed');
            }
            
            this.instance = managerV2;
        } else {
            console.log('Using SQLite-based Knowledge Graph Manager');
            // Instantiate CodebaseEmbeddingService and pass it
            const embeddingService = new CodebaseEmbeddingService(memoryManager, memoryManager.getVectorDb() as import('better-sqlite3').Database);
            this.instance = new KnowledgeGraphManager(memoryManager.getDbService(), memoryManager.getGeminiIntegrationService(), embeddingService);
        }

        return this.instance;
    }

    static reset(): void {
        this.instance = null!;
    }
}
