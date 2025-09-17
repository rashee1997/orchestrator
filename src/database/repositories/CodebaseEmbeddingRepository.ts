import { Database } from 'better-sqlite3';
import { CodebaseEmbeddingRecord } from '../../types/codebase_embeddings.js';
import { findSimilarVecEmbeddings } from '../vector_db.js';

export class CodebaseEmbeddingRepository {
    private db: Database;
    private vectorTable: string = 'codebase_embeddings_vec_idx';
    private metadataTable: string = 'codebase_embeddings';
    private maxRetries: number = 3;
    private retryDelay: number = 1000;
    private connectionTimeout: number = 30000;

    constructor(db: Database) {
        this.db = db;
        // Configure database settings for better performance
        try {
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('synchronous = NORMAL');
            this.db.pragma('cache_size = -10000'); // 10MB cache
            this.db.pragma('temp_store = MEMORY');
            this.db.pragma('mmap_size = 268435456'); // 256MB mmap
        } catch (error) {
            console.warn('Failed to set database pragmas:', error);
        }
    }

    private async _executeWithRetry<T>(operation: () => T, operationName: string): Promise<T> {
        let lastError: any = null;

        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                const result = await Promise.resolve(operation());
                return result;
            } catch (error: any) {
                lastError = error;
                console.warn(`${operationName} failed (attempt ${attempt}/${this.maxRetries}):`, error.message);

                if (attempt < this.maxRetries) {
                    const delay = this.retryDelay * Math.pow(2, attempt - 1);
                    console.log(`Retrying ${operationName} in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        console.error(`${operationName} failed after ${this.maxRetries} attempts:`, lastError?.message);
        throw lastError || new Error(`${operationName} failed after maximum retries`);
    }

    public async bulkInsertEmbeddings(embeddings: CodebaseEmbeddingRecord[]): Promise<void> {
        if (embeddings.length === 0) return;

        const insertMetadataSql = `INSERT OR REPLACE INTO ${this.metadataTable} (
            embedding_id, agent_id, chunk_text, entity_name, entity_name_vector_blob, entity_name_vector_dimensions,
            model_name, chunk_hash, file_hash, metadata_json, created_timestamp_unix, file_path_relative,
            full_file_path, ai_summary_text, vector_dimensions, embedding_type, parent_embedding_id,
            embedding_provider, embedding_model_full_name, embedding_generation_method,
            embedding_request_id, embedding_quality_score, embedding_generation_timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        const insertVecSql = `INSERT OR REPLACE INTO ${this.vectorTable} (embedding_id, embedding) VALUES (?, ?);`;

        await this._executeWithRetry(async () => {
            const transaction = this.db.transaction((records: CodebaseEmbeddingRecord[]) => {
                const stmtMetadata = this.db.prepare(insertMetadataSql);
                const stmtVec = this.db.prepare(insertVecSql);

                for (const metadata of records) {
                    try {
                        stmtMetadata.run(
                            metadata.embedding_id,
                            metadata.agent_id,
                            metadata.chunk_text,
                            metadata.entity_name,
                            metadata.entity_name_vector_blob,
                            metadata.entity_name_vector_dimensions,
                            metadata.model_name,
                            metadata.chunk_hash,
                            metadata.file_hash,
                            metadata.metadata_json,
                            metadata.created_timestamp_unix,
                            metadata.file_path_relative,
                            metadata.full_file_path,
                            metadata.ai_summary_text,
                            metadata.vector_dimensions,
                            metadata.embedding_type,
                            metadata.parent_embedding_id,
                            // New parallel embedding columns
                            metadata.embedding_provider || 'gemini',
                            metadata.embedding_model_full_name || metadata.model_name,
                            metadata.embedding_generation_method || 'single',
                            metadata.embedding_request_id || null,
                            metadata.embedding_quality_score || 1.0,
                            metadata.embedding_generation_timestamp || Date.now()
                        );

                        if (metadata.vector_blob && metadata.vector_blob.length > 0) {
                            const vector: number[] = [];
                            for (let i = 0; i < metadata.vector_blob.length; i += 4) {
                                vector.push(metadata.vector_blob.readFloatLE(i));
                            }
                            const vectorString = `[${vector.join(',')}]`;
                            stmtVec.run(metadata.embedding_id, vectorString);
                        }
                    } catch (error) {
                        console.error(`Error inserting embedding ${metadata.embedding_id}:`, error);
                        // Continue with other records
                    }
                }
            });

            await transaction(embeddings);
        }, 'bulkInsertEmbeddings');
    }

    public async updateFileHashForEmbedding(embeddingId: string, newFileHash: string): Promise<void> {
        await this._executeWithRetry(() => {
            const sql = `UPDATE ${this.metadataTable} SET file_hash = ? WHERE embedding_id = ?`;
            this.db.prepare(sql).run(newFileHash, embeddingId);
        }, 'updateFileHashForEmbedding');
    }

    public async getEmbeddingsForFile(filePathRelative: string, agentId?: string): Promise<CodebaseEmbeddingRecord[]> {
        return this._executeWithRetry(() => {
            let sql = `SELECT * FROM ${this.metadataTable} WHERE file_path_relative = ?`;
            const params: (string | undefined)[] = [filePathRelative];

            if (agentId) {
                sql += ` AND agent_id = ?`;
                params.push(agentId);
            }

            const stmt = this.db.prepare(sql);
            return stmt.all(...params) as CodebaseEmbeddingRecord[];
        }, 'getEmbeddingsForFile');
    }

    public async getChunkHashesForFile(filePathRelative: string): Promise<{
        hashes: Set<string>;
        latencyMs: number;
        callCount: number;
        error?: string
    }> {
        const startTime = Date.now();

        try {
            const result = await this._executeWithRetry(() => {
                const sql = `SELECT chunk_hash FROM ${this.metadataTable} WHERE file_path_relative = ? AND chunk_hash IS NOT NULL`;
                const stmt = this.db.prepare(sql);
                const rows = stmt.all(filePathRelative) as { chunk_hash: string }[];
                const hashes = new Set(rows.map(row => row.chunk_hash));

                return { hashes, latencyMs: Date.now() - startTime, callCount: 1 };
            }, 'getChunkHashesForFile');

            return result;
        } catch (error) {
            console.error(`Error getting chunk hashes for file ${filePathRelative}:`, error);
            return {
                hashes: new Set(),
                latencyMs: Date.now() - startTime,
                callCount: 1,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    public async bulkDeleteEmbeddings(embeddingIds: string[]): Promise<void> {
        if (embeddingIds.length === 0) return;

        await this._executeWithRetry(async () => {
            const transaction = this.db.transaction((ids: string[]) => {
                if (ids.length === 0) return;

                const placeholders = ids.map(() => '?').join(',');

                // Delete from vector table first (foreign key constraint)
                try {
                    const vecStmt = this.db.prepare(
                        `DELETE FROM ${this.vectorTable} WHERE embedding_id IN (${placeholders})`
                    );
                    vecStmt.run(...ids);
                } catch (error) {
                    console.error('Error deleting from vector table:', error);
                }

                // Delete from metadata table
                try {
                    const metaStmt = this.db.prepare(
                        `DELETE FROM ${this.metadataTable} WHERE embedding_id IN (${placeholders})`
                    );
                    metaStmt.run(...ids);
                } catch (error) {
                    console.error('Error deleting from metadata table:', error);
                }
            });

            await transaction(embeddingIds);
        }, 'bulkDeleteEmbeddings');
    }

    public async getLatestFileHashes(agentId: string): Promise<Map<string, string>> {
        try {
            return await this._executeWithRetry(() => {
                const sql = `
                    SELECT file_path_relative, file_hash
                    FROM ${this.metadataTable} 
                    WHERE (file_path_relative, created_timestamp_unix) IN (
                        SELECT file_path_relative, MAX(created_timestamp_unix)
                        FROM ${this.metadataTable}
                        WHERE agent_id = ?
                        GROUP BY file_path_relative
                    )
                    AND agent_id = ?;
                `;

                const stmt = this.db.prepare(sql);
                const rows = stmt.all(agentId, agentId) as { file_path_relative: string, file_hash: string }[];
                return new Map(rows.map(row => [row.file_path_relative, row.file_hash]));
            }, 'getLatestFileHashes');
        } catch (error) {
            console.error(`Error getting latest file hashes for agent ${agentId}:`, error);
            return new Map();
        }
    }

    public async getAllFilePathsForAgent(agentId: string): Promise<string[]> {
        try {
            return await this._executeWithRetry(() => {
                const sql = `SELECT DISTINCT file_path_relative FROM ${this.metadataTable} WHERE agent_id = ?`;
                const stmt = this.db.prepare(sql);
                const rows = stmt.all(agentId) as { file_path_relative: string }[];
                return rows.map(row => row.file_path_relative);
            }, 'getAllFilePathsForAgent');
        } catch (error) {
            console.error(`Error getting all file paths for agent ${agentId}:`, error);
            return [];
        }
    }

    public async getAvailableEmbeddingModels(agentId?: string): Promise<string[]> {
        return this._executeWithRetry(() => {
            let sql = `SELECT DISTINCT model_name FROM ${this.metadataTable}`;
            const params: string[] = [];
            if (agentId) {
                sql += ` WHERE agent_id = ?`;
                params.push(agentId);
            }
            const stmt = this.db.prepare(sql);
            const rows = stmt.all(...params) as { model_name: string }[];
            return rows.map(row => row.model_name);
        }, 'getAvailableEmbeddingModels');
    }

    public async findSimilarEmbeddingsWithMetadata(
        queryEmbedding: number[],
        queryText: string,
        topK: number,
        agentId?: string,
        targetFilePaths?: string[],
        excludeChunkTypes?: string[],
        model?: string // Add model parameter
    ): Promise<Array<CodebaseEmbeddingRecord & { similarity: number }>> {
        try {
            // Step 1: Perform Vector Search to find the most relevant chunks.
            // We fetch more than topK initially to ensure we have enough candidates after filtering.
            const vecResults = await this._executeWithRetry(async () => {
                return await findSimilarVecEmbeddings(queryEmbedding, topK * 5, this.vectorTable);
            }, 'findSimilarVecEmbeddings');

            if (!vecResults || vecResults.length === 0) {
                return [];
            }

            const embeddingIds = vecResults.map(r => r.embedding_id);
            const similarityMap = new Map(vecResults.map(r => [r.embedding_id, r.similarity]));

            // Step 2: Fetch full metadata for the top chunks, applying filters.
            const placeholders = embeddingIds.map(() => '?').join(',');
            let sql = `SELECT * FROM ${this.metadataTable} WHERE embedding_id IN (${placeholders})`;
            const params: (string | number)[] = [...embeddingIds];

            if (agentId) {
                sql += ` AND agent_id = ?`;
                params.push(agentId);
            }

            if (targetFilePaths && targetFilePaths.length > 0) {
                sql += ` AND file_path_relative IN (${targetFilePaths.map(() => '?').join(',')})`;
                params.push(...targetFilePaths);
            }

            if (excludeChunkTypes && excludeChunkTypes.length > 0) {
                sql += ` AND embedding_type NOT IN (${excludeChunkTypes.map(() => '?').join(',')})`;
                params.push(...excludeChunkTypes);
            }

            if (model) { // Add model filter
                sql += ` AND model_name = ?`;
                params.push(model);
            }

            const metadataRows = await this._executeWithRetry(() => {
                const stmt = this.db.prepare(sql);
                return stmt.all(...params) as CodebaseEmbeddingRecord[];
            }, 'fetchFilteredMetadata');

            // Step 3: Combine metadata with similarity scores and apply entity name boosting.
            const results = metadataRows.map(meta => {
                let similarity = similarityMap.get(meta.embedding_id) || 0;

                // Apply entity name relevance boosting
                const nameRelevanceBoost = this.calculateEntityNameRelevanceBoost(queryText, meta);
                similarity = Math.min(1.0, similarity + nameRelevanceBoost);

                return {
                    ...meta,
                    similarity,
                };
            });

            // Step 3.5: CRITICAL - Force inclusion of core implementation chunks
            const enhancedResults = this.enforceImplementationDiversification(queryText, results, topK);

            // Step 4: Re-rank results based on keyword and entity name matching, with enhanced support for code snippets alongside summaries
            const queryTokens = new Set(queryText.toLowerCase().split(/\s+/).filter(t => t.length > 2));
            enhancedResults.forEach(result => {
                let rerankScore = result.similarity;

                // Parse metadata to determine chunk type
                let metadata: any = {};
                try {
                    metadata = result.metadata_json ? JSON.parse(result.metadata_json) : {};
                } catch (e) {
                    // Ignore parsing errors
                }

                const isSummary = result.embedding_type === 'summary' || metadata.type === 'file_summary';
                const isCodeSnippet = result.embedding_type === 'chunk' && !isSummary;

                // Boost for exact entity name match in query
                if (result.entity_name && queryText.toLowerCase().includes(result.entity_name.toLowerCase())) {
                    rerankScore += 0.15;
                }

                // Boost for keyword overlap in chunk text
                if (queryTokens.size > 0 && result.chunk_text) {
                    const chunkTokens = new Set(result.chunk_text.toLowerCase().split(/\s+/));
                    const overlap = [...queryTokens].filter(token => chunkTokens.has(token));
                    const overlapBonus = (overlap.length / queryTokens.size) * 0.1; // Max 0.1 bonus
                    rerankScore += overlapBonus;
                }

                // Enhanced prioritization for code explanation queries
                const codeExplanationKeywords = ['how does', 'how is', 'explain', 'understand', 'work', 'implement', 'integrate'];
                const isCodeExplanationQuery = codeExplanationKeywords.some(keyword => queryText.toLowerCase().includes(keyword));

                // Strong boost for code chunks in code explanation queries
                if (isCodeSnippet) {
                    if (isCodeExplanationQuery) {
                        rerankScore += 0.20; // Strong boost for code explanation queries
                    } else {
                        rerankScore += 0.05; // Smaller boost for other queries
                    }
                }

                // Boost for specific code-related keywords in the query
                const codeKeywords = ['function', 'class', 'method', 'variable', 'interface', 'type', 'const', 'let', 'var'];
                const hasCodeKeywords = codeKeywords.some(keyword => queryText.toLowerCase().includes(keyword));
                if (hasCodeKeywords && isCodeSnippet) {
                    rerankScore += 0.08; // Additional boost when query contains code-related terms
                }

                // Modified summary boosting - avoid boosting summaries for code explanation queries
                const overviewKeywords = ['overview', 'summary', 'architecture', 'structure', 'design'];
                const hasOverviewKeywords = overviewKeywords.some(keyword => queryText.toLowerCase().includes(keyword));
                if (hasOverviewKeywords && isSummary && !isCodeExplanationQuery) {
                    rerankScore += 0.08; // Only boost summaries for pure overview queries, not code explanations
                }

                // Update similarity to be the re-ranked score
                result.similarity = Math.min(1.0, rerankScore); // Cap similarity at 1.0
            });

            // Sort by the new re-ranked similarity and return the top K results.
            enhancedResults.sort((a, b) => b.similarity - a.similarity);

            return enhancedResults.slice(0, topK);

        } catch (error) {
            console.error('Error in findSimilarEmbeddingsWithMetadata:', error);
            throw error;
        }
    }

    public async getEmbeddingStatistics(agentId: string): Promise<{
        totalEmbeddings: number;
        embeddingsByType: Record<string, number>;
        embeddingsByFile: Record<string, number>;
        averageChunkSize: number;
        totalFiles: number;
    }> {
        try {
            return await this._executeWithRetry(() => {
                // Total embeddings count
                const totalQuery = `SELECT COUNT(*) as count FROM ${this.metadataTable} WHERE agent_id = ?`;
                const totalResult = this.db.prepare(totalQuery).get(agentId) as { count: number };

                // Embeddings by type
                const typeQuery = `SELECT embedding_type, COUNT(*) as count FROM ${this.metadataTable} WHERE agent_id = ? GROUP BY embedding_type`;
                const typeResults = this.db.prepare(typeQuery).all(agentId) as { embedding_type: string, count: number }[];
                const embeddingsByType = typeResults.reduce((acc, { embedding_type, count }) => {
                    acc[embedding_type] = count;
                    return acc;
                }, {} as Record<string, number>);

                // Embeddings by file
                const fileQuery = `SELECT file_path_relative, COUNT(*) as count FROM ${this.metadataTable} WHERE agent_id = ? GROUP BY file_path_relative`;
                const fileResults = this.db.prepare(fileQuery).all(agentId) as { file_path_relative: string, count: number }[];
                const embeddingsByFile = fileResults.reduce((acc, { file_path_relative, count }) => {
                    acc[file_path_relative] = count;
                    return acc;
                }, {} as Record<string, number>);

                // Average chunk size
                const sizeQuery = `SELECT AVG(LENGTH(chunk_text)) as avg_size FROM ${this.metadataTable} WHERE agent_id = ?`;
                const sizeResult = this.db.prepare(sizeQuery).get(agentId) as { avg_size: number };

                // Total unique files
                const fileCountQuery = `SELECT COUNT(DISTINCT file_path_relative) as count FROM ${this.metadataTable} WHERE agent_id = ?`;
                const fileCountResult = this.db.prepare(fileCountQuery).get(agentId) as { count: number };

                return {
                    totalEmbeddings: totalResult.count,
                    embeddingsByType,
                    embeddingsByFile,
                    averageChunkSize: Math.round(sizeResult.avg_size || 0),
                    totalFiles: fileCountResult.count
                };
            }, 'getEmbeddingStatistics');
        } catch (error) {
            console.error(`Error getting embedding statistics for agent ${agentId}:`, error);
            throw error;
        }
    }

    public async getEmbeddingsByIds(embeddingIds: string[]): Promise<CodebaseEmbeddingRecord[]> {
        if (embeddingIds.length === 0) {
            return [];
        }

        return this._executeWithRetry(() => {
            const placeholders = embeddingIds.map(() => '?').join(',');
            const sql = `SELECT * FROM ${this.metadataTable} WHERE embedding_id IN (${placeholders})`;
            const stmt = this.db.prepare(sql);
            return stmt.all(...embeddingIds) as CodebaseEmbeddingRecord[];
        }, 'getEmbeddingsByIds');
    }

    /**
     * Get all unique entity names for an agent (for dynamic query expansion)
     */
    public async getAllEntityNames(agentId: string): Promise<string[]> {
        try {
            return await this._executeWithRetry(() => {
                const sql = `
                    SELECT DISTINCT entity_name
                    FROM ${this.metadataTable}
                    WHERE agent_id = ? AND entity_name IS NOT NULL AND entity_name != ''
                    ORDER BY entity_name
                `;
                const stmt = this.db.prepare(sql);
                const rows = stmt.all(agentId) as { entity_name: string }[];
                return rows.map(row => row.entity_name);
            }, 'getAllEntityNames');
        } catch (error) {
            console.error(`Error getting entity names for agent ${agentId}:`, error);
            return [];
        }
    }

    /**
     * CRITICAL FIX: Calculate entity name relevance boost for better ranking
     * Enhanced to prioritize core implementation chunks
     */
    private calculateEntityNameRelevanceBoost(queryText: string, embedding: CodebaseEmbeddingRecord): number {
        let boost = 0;
        const queryLower = queryText.toLowerCase();
        const contentLower = embedding.chunk_text?.toLowerCase() || '';

        // Extract meaningful query terms
        const queryTerms = queryText.split(/\s+/)
            .filter(term => term.length > 2)
            .map(term => term.toLowerCase().replace(/[^\w]/g, ''));

        // 1. Entity name exact match boost
        if (embedding.entity_name) {
            const entityNameLower = embedding.entity_name.toLowerCase();

            // Exact entity name match gets highest boost
            if (queryTerms.some(term => term === entityNameLower)) {
                boost += 0.4; // Increased from 0.3
            }

            // Partial entity name match
            if (queryTerms.some(term => entityNameLower.includes(term) || term.includes(entityNameLower))) {
                boost += 0.25; // Increased from 0.2
            }

            // Fuzzy similarity for entity names
            const maxSimilarity = Math.max(...queryTerms.map(term =>
                this.calculateStringSimilarity(term, entityNameLower)
            ));
            if (maxSimilarity > 0.7) {
                boost += 0.2 * maxSimilarity; // Increased from 0.15
            }
        }

        // 2. CRITICAL: Core method implementation boost
        const coreMethodPatterns = [
            /\bexecuteTask\s*\(/,
            /\bselectModelForTask\s*\(/,
            /\bupdateTaskStats\s*\(/,
            /\bprocessTask\s*\(/,
            /\binitializeModels\s*\(/,
            /\bconstructor\s*\(/,
            /\basync\s+\w+\s*\(/,
            /\bpublic\s+\w+\s*\(/,
            /\bprivate\s+\w+\s*\(/,
            /\bstatic\s+\w+\s*\(/
        ];

        let methodImplementationBoost = 0;
        for (const pattern of coreMethodPatterns) {
            if (pattern.test(contentLower)) {
                methodImplementationBoost += 0.15;
            }
        }

        // Extra boost for methods that match query entity
        if (embedding.entity_name && queryTerms.some(term =>
            embedding.entity_name?.toLowerCase().includes(term)
        )) {
            methodImplementationBoost *= 1.5; // Amplify method boost for matching entities
        }

        boost += Math.min(0.3, methodImplementationBoost);

        // 3. Implementation content patterns boost
        const implementationPatterns = [
            /\b(?:class|interface|enum)\s+\w+/,
            /\bfunction\s+\w+/,
            /\b(?:public|private|protected)\s+(?:async\s+)?\w+/,
            /\breturn\s+(?:new\s+\w+|this\.\w+|\w+\()/,
            /\bthis\.\w+\s*=/,
            /\b(?:if|for|while|switch)\s*\(/,
            /\btry\s*\{[\s\S]*catch/,
            /\b(?:await|Promise\.)/
        ];

        let implementationScore = 0;
        for (const pattern of implementationPatterns) {
            if (pattern.test(contentLower)) {
                implementationScore += 0.05;
            }
        }

        boost += Math.min(0.2, implementationScore);

        // 4. File path relevance boost
        if (embedding.file_path_relative) {
            const fileName = embedding.file_path_relative.split('/').pop()?.replace(/\.[^.]*$/, '') || '';
            const fileNameLower = fileName.toLowerCase();

            // Check if query terms match file name
            if (queryTerms.some(term => fileNameLower.includes(term))) {
                boost += 0.15; // Increased from 0.1
            }

            // Check directory structure relevance
            const pathParts = embedding.file_path_relative.toLowerCase().split('/');
            if (queryTerms.some(term => pathParts.some(part => part.includes(term)))) {
                boost += 0.08; // Increased from 0.05
            }
        }

        // 5. Content type and chunk quality boost
        if (embedding.embedding_type === 'chunk') {
            // Prioritize larger, more complete chunks
            const chunkLength = embedding.chunk_text?.length || 0;
            if (chunkLength > 500) {
                boost += 0.1; // Substantial content
            }
            if (chunkLength > 1000) {
                boost += 0.1; // Very substantial content
            }

            // Boost chunks that contain the query entity name in content
            if (embedding.entity_name && contentLower.includes(embedding.entity_name.toLowerCase())) {
                boost += 0.1; // Entity defined/implemented in this chunk
            }
        }

        // 6. Metadata boost (if available)
        if (embedding.metadata_json) {
            try {
                const metadata = JSON.parse(embedding.metadata_json);

                // Language match boost
                if (metadata.language && queryLower.includes(metadata.language.toLowerCase())) {
                    boost += 0.05;
                }

                // Code type match boost
                if (metadata.code_type && queryTerms.some(term =>
                    metadata.code_type.toLowerCase().includes(term)
                )) {
                    boost += 0.1;
                }

                // Boost for implementation vs declaration
                if (metadata.isImplementation) {
                    boost += 0.1;
                }
            } catch (error) {
                // Ignore JSON parsing errors
            }
        }

        return Math.min(0.6, boost); // Increased cap from 0.4 to 0.6 for better core method prioritization
    }

    /**
     * CRITICAL: Force inclusion of core implementation chunks
     */
    private enforceImplementationDiversification(
        queryText: string,
        results: Array<CodebaseEmbeddingRecord & { similarity: number }>,
        topK: number
    ): Array<CodebaseEmbeddingRecord & { similarity: number }> {
        const queryTerms = queryText.toLowerCase().split(/\s+/);
        const targetEntity = queryTerms.find(term => term.length > 3) || queryText.toLowerCase();

        // Identify critical implementation chunks that might be missing
        const coreMethodSignatures = [
            'executetask',
            'selectmodelfortask',
            'updatetaskstats',
            'processtask',
            'initializemodels',
            'constructor',
            'configuremodel',
            'distributionrules',
            'taskexecution'
        ];

        // Find existing implementation chunks
        const implementationChunks = results.filter(result => {
            const content = result.chunk_text?.toLowerCase() || '';
            const entityName = result.entity_name?.toLowerCase() || '';

            return (
                // Contains target entity name
                (entityName.includes(targetEntity) || content.includes(targetEntity)) &&
                // Contains implementation patterns
                (
                    coreMethodSignatures.some(method => content.includes(method)) ||
                    /\b(?:public|private|async)\s+\w+\s*\(/.test(content) ||
                    /\bfunction\s+\w+/.test(content) ||
                    /\bclass\s+\w+/.test(content)
                )
            );
        });

        // If we have few implementation chunks, boost their scores dramatically
        if (implementationChunks.length < Math.floor(topK * 0.4)) {
            console.log(`[Implementation Diversification] Found only ${implementationChunks.length} implementation chunks, boosting scores`);

            implementationChunks.forEach(chunk => {
                const content = chunk.chunk_text?.toLowerCase() || '';

                // Massive boost for core methods
                for (const method of coreMethodSignatures) {
                    if (content.includes(method)) {
                        chunk.similarity = Math.min(1.0, chunk.similarity + 0.4);
                        console.log(`[Implementation Boost] Boosted ${chunk.entity_name} for containing ${method}`);
                        break;
                    }
                }

                // Extra boost for large implementation chunks
                if (chunk.chunk_text && chunk.chunk_text.length > 800) {
                    chunk.similarity = Math.min(1.0, chunk.similarity + 0.2);
                }
            });
        }

        // Force inclusion strategy: if core implementations are missing, search for them
        const missingCoreMethod = coreMethodSignatures.find(method =>
            !results.some(r => r.chunk_text?.toLowerCase().includes(method))
        );

        if (missingCoreMethod && results.length > 0) {
            console.log(`[Implementation Diversification] Core method '${missingCoreMethod}' missing, checking for alternatives`);

            // Find chunks that contain the entity but might have been ranked lower
            const entityChunks = results.filter(r => {
                const entityName = r.entity_name?.toLowerCase() || '';
                const content = r.chunk_text?.toLowerCase() || '';
                return entityName.includes(targetEntity) || content.includes(targetEntity);
            });

            // Boost scores for entity-related chunks that contain implementation patterns
            entityChunks.forEach(chunk => {
                const content = chunk.chunk_text?.toLowerCase() || '';
                if (
                    /\basync\s+\w+\s*\(/.test(content) ||
                    /\bpublic\s+\w+\s*\(/.test(content) ||
                    /\bthis\.\w+/.test(content) ||
                    /\breturn\s+/.test(content)
                ) {
                    chunk.similarity = Math.min(1.0, chunk.similarity + 0.25);
                    console.log(`[Implementation Diversification] Boosted entity chunk: ${chunk.entity_name}`);
                }
            });
        }

        return results;
    }

    /**
     * Calculate string similarity using simple character overlap
     */
    private calculateStringSimilarity(str1: string, str2: string): number {
        if (str1.length === 0 || str2.length === 0) return 0;

        const len1 = str1.length;
        const len2 = str2.length;
        const maxLen = Math.max(len1, len2);

        // Simple character overlap similarity
        const set1 = new Set(str1.split(''));
        const set2 = new Set(str2.split(''));
        const intersection = new Set([...set1].filter(x => set2.has(x)));

        return intersection.size / maxLen;
    }

    public async optimizeDatabase(): Promise<void> {
        try {
            await this._executeWithRetry(async () => {
                // Run ANALYZE to update statistics
                this.db.exec('ANALYZE');

                // Rebuild indexes if needed
                this.db.exec('REINDEX');

                // Vacuum to optimize database file
                this.db.exec('VACUUM');
            }, 'optimizeDatabase');

            console.log('Database optimization completed successfully');
        } catch (error) {
            console.error('Error optimizing database:', error);
            throw error;
        }
    }
}
