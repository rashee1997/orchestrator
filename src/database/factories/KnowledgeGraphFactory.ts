import { KnowledgeGraphManagerKuzu } from '../managers/KnowledgeGraphManagerKuzu.js';
import { getKnowledgeGraphConfig } from '../../config/knowledge_graph_config.js';
import path from 'path';
import { fileURLToPath } from 'url';

export interface IKnowledgeGraphManager {
    createEntities(agentId: string, entities: { name: string; entityType: string; observations?: string[] }[]): Promise<{ node_id: string; name: string; entityType: string; success: boolean }[]>;
    createRelations(agentId: string, relations: { from: string; to: string; relationType: string }[]): Promise<{ success: boolean; relation_id?: string; from: string; to: string; type: string; error?: string }[]>;
    addObservations(agentId: string, observations: { entityName: string; contents: string[] }[]): Promise<{ success: boolean; entityName: string; addedCount?: number; error?: string }[]>;
    deleteEntities(agentId: string, entityNames: string[]): Promise<{ success: boolean; entityName: string; deleted?: boolean; error?: string }[]>;
    deleteObservations(agentId: string, deletions: { entityName: string; observations: string[] }[]): Promise<{ success: boolean; entityName: string; deletedCount?: number; error?: string }[]>;
    deleteRelations(agentId: string, relationsToDelete: { from: string; to: string; relationType: string }[]): Promise<{ success: boolean; from: string; to: string; type: string; deleted?: boolean; error?: string }[]>;
    readGraph(agentId: string): Promise<{ nodes: { node_id: string; name: string; entityType: string; observations?: string[] }[]; relations: { relation_id: string; from: string; to: string; relationType: string }[] }>;
    searchNodes(agentId: string, query: string): Promise<{ node_id: string; name: string; entityType: string; observations?: string[] }[]>;
    openNodes(agentId: string, names: string[]): Promise<{ node_id: string; name: string; entityType: string; observations?: string[] }[]>;
    queryNaturalLanguage(agentId: string, naturalLanguageQuery: string): Promise<string>;
    inferRelations(agentId: string, entityNames?: string[], context?: string): Promise<{ message: string; details: { from: string; to: string; relationType: string; confidence?: number; evidence?: string; status?: string }[] }>;
    generateMermaidGraph(agentId: string, options: { query?: string; natural_language_query?: string; layoutDirection?: string; depth?: number; includeLegend?: boolean; groupByDirectory?: boolean; maxNodes?: number; maxEdges?: number; excludeImports?: string[]; excludeRelationTypes?: string[] }): Promise<string>;
    getExistingRelation(agentId: string, fromNodeName: string, toNodeName: string, relationType: string): Promise<{ relation_id?: string; fromNodeId?: string; toNodeId?: string; relationType: string; timestamp?: number; version?: number } | null>;
}

export class KnowledgeGraphFactory {
    private static instance: IKnowledgeGraphManager | null = null;

    static async create(
        memoryManager: import("../memory_manager.js").MemoryManager
    ): Promise<IKnowledgeGraphManager> {
        // If already created, return the existing instance
        if (this.instance) {
            return this.instance;
        }

        const config = getKnowledgeGraphConfig();
        console.log('Using KuzuDB-based Knowledge Graph Manager');

        // Get the project root directory
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const projectRoot = path.resolve(__dirname, '..', '..', '..');

        // Create the KuzuDB manager
        const kuzuDbPath = path.join(projectRoot, config.kuzuDbPath || 'knowledge_graphs_kuzu');
        const kuzuManager = new KnowledgeGraphManagerKuzu(
            kuzuDbPath,
            memoryManager.getGeminiIntegrationService(),
            undefined, // embedding service - can be added later
            memoryManager
        );

        this.instance = kuzuManager;
        return this.instance;
    }

    static reset(): void {
        this.instance = null;
    }
}