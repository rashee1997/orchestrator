// Enhanced Configuration for Knowledge Graph storage backend
export interface KnowledgeGraphConfig {
    jsonlRootPath?: string;
    maxFileSize?: number; // Enhanced: Maximum file size in bytes
    compressionEnabled?: boolean; // Enhanced: Enable compression for storage
    backupEnabled?: boolean; // Enhanced: Enable automatic backups
    backupRetentionDays?: number; // Enhanced: Number of days to retain backups
    cachingEnabled?: boolean; // Enhanced: Enable in-memory caching
    cacheSize?: number; // Enhanced: Maximum cache size in MB
    encryptionEnabled?: boolean; // Enhanced: Enable data encryption
    performanceMode?: 'memory' | 'balanced' | 'storage'; // Enhanced: Performance optimization mode
}

export interface KnowledgeGraphMetrics {
    totalNodes: number;
    totalEdges: number;
    storageUsedMB: number;
    cacheHitRate?: number;
    avgQueryTimeMs?: number;
}

// Enhanced: Validation for configuration
export function validateKnowledgeGraphConfig(config: KnowledgeGraphConfig): string[] {
    const errors: string[] = [];

    if (config.maxFileSize && config.maxFileSize <= 0) {
        errors.push('maxFileSize must be positive');
    }

    if (config.backupRetentionDays && config.backupRetentionDays <= 0) {
        errors.push('backupRetentionDays must be positive');
    }

    if (config.cacheSize && config.cacheSize <= 0) {
        errors.push('cacheSize must be positive');
    }

    return errors;
}

// Get configuration from environment variables or defaults
export function getKnowledgeGraphConfig(): KnowledgeGraphConfig {
    const config: KnowledgeGraphConfig = {
        jsonlRootPath: process.env.KG_JSONL_ROOT || 'knowledge_graphs',
        maxFileSize: process.env.KG_MAX_FILE_SIZE ? parseInt(process.env.KG_MAX_FILE_SIZE) : 50 * 1024 * 1024, // 50MB default
        compressionEnabled: process.env.KG_COMPRESSION_ENABLED === 'true',
        backupEnabled: process.env.KG_BACKUP_ENABLED === 'true',
        backupRetentionDays: process.env.KG_BACKUP_RETENTION_DAYS ? parseInt(process.env.KG_BACKUP_RETENTION_DAYS) : 7,
        cachingEnabled: process.env.KG_CACHING_ENABLED !== 'false', // Default to true
        cacheSize: process.env.KG_CACHE_SIZE_MB ? parseInt(process.env.KG_CACHE_SIZE_MB) : 100,
        encryptionEnabled: process.env.KG_ENCRYPTION_ENABLED === 'true',
        performanceMode: (process.env.KG_PERFORMANCE_MODE as any) || 'balanced'
    };

    const validationErrors = validateKnowledgeGraphConfig(config);
    if (validationErrors.length > 0) {
        console.warn('Knowledge Graph configuration warnings:', validationErrors);
    }

    return config;
}

// Enhanced: Get performance-optimized config based on environment
export function getOptimizedKnowledgeGraphConfig(): KnowledgeGraphConfig {
    const baseConfig = getKnowledgeGraphConfig();
    const nodeEnv = process.env.NODE_ENV;

    // Override defaults based on environment
    if (nodeEnv === 'production') {
        return {
            ...baseConfig,
            compressionEnabled: true,
            backupEnabled: true,
            performanceMode: 'storage',
            encryptionEnabled: true
        };
    } else if (nodeEnv === 'development') {
        return {
            ...baseConfig,
            compressionEnabled: false,
            backupEnabled: false,
            performanceMode: 'memory',
            cacheSize: 50 // Smaller cache for development
        };
    }

    return baseConfig;
}