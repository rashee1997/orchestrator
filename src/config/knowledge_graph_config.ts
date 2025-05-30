// Configuration for Knowledge Graph storage backend
export interface KnowledgeGraphConfig {
    useJsonlBackend: boolean;
    jsonlRootPath?: string;
    enableDualMode?: boolean; // For gradual rollout
    autoMigrate?: boolean;
}

// Get configuration from environment variables or defaults
export function getKnowledgeGraphConfig(): KnowledgeGraphConfig {
    return {
        useJsonlBackend: process.env.USE_JSONL_KG === 'true' || true, // Default to true for JSONL
        jsonlRootPath: process.env.KG_JSONL_ROOT || 'knowledge_graphs',
        enableDualMode: process.env.KG_DUAL_MODE === 'true' || false,
        autoMigrate: process.env.KG_AUTO_MIGRATE === 'true' || false
    };
}