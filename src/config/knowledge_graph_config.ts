// Configuration for Knowledge Graph storage backend
export interface KnowledgeGraphConfig {
    backend: 'kuzu' | 'jsonl';
    kuzuDbPath?: string;
    jsonlRootPath?: string;
    autoMigrate?: boolean;
}

// Get configuration from environment variables or defaults
export function getKnowledgeGraphConfig(): KnowledgeGraphConfig {
    return {
        backend: (process.env.KG_BACKEND as 'kuzu' | 'jsonl') || 'kuzu',
        kuzuDbPath: process.env.KG_KUZU_PATH || 'knowledge_graphs_kuzu',
        jsonlRootPath: process.env.KG_JSONL_ROOT || 'knowledge_graphs',
        autoMigrate: process.env.KG_AUTO_MIGRATE === 'true',
    };
}