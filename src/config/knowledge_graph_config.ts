// Configuration for Knowledge Graph storage backend
export interface KnowledgeGraphConfig {
    jsonlRootPath?: string;
}

// Get configuration from environment variables or defaults
export function getKnowledgeGraphConfig(): KnowledgeGraphConfig {
    return {
        jsonlRootPath: process.env.KG_JSONL_ROOT || 'knowledge_graphs',
    };
}