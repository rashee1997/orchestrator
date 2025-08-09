import { MemoryManager } from '../../memory_manager.js';
import { CodebaseIntrospectionService } from '../CodebaseIntrospectionService.js';
import { AIEmbeddingProvider } from './AIEmbeddingProvider.js';
import { ChunkingStrategy } from '../../../types/codebase_embeddings.js';
import crypto from 'crypto';

export class CodeChunkingService {
    private introspectionService: CodebaseIntrospectionService;
    private aiProvider: AIEmbeddingProvider;
    private memoryManager: MemoryManager;
    private knowledgeGraphCache: Map<string, any>;
    private maxChunkSize: number = 2000; // Maximum characters per chunk
    private contextWindow: number = 500; // Context characters to include before/after chunks

    constructor(
        introspectionService: CodebaseIntrospectionService,
        aiProvider: AIEmbeddingProvider,
        memoryManager: MemoryManager
    ) {
        this.introspectionService = introspectionService;
        this.aiProvider = aiProvider;
        this.memoryManager = memoryManager;
        this.knowledgeGraphCache = new Map<string, any>();
    }

    private generateChunkHash(text: string): string {
        return crypto.createHash('sha256').update(text).digest('hex');
    }

    /**
     * Creates intelligent, context-aware chunks from file content with enhanced strategies.
     * @param agentId The ID of the agent.
     * @param filePath The absolute path to the file.
     * @param fileContent The content of the file.
     * @param relativeFilePath The relative path to the file from the project root.
     * @param language The programming language of the file.
     * @param strategy The chunking strategy to use.
     * @param storeEntitySummaries Whether to store AI-generated summaries for code entities.
     * @returns A promise that resolves to an array of chunks.
     */
    public async chunkFileContent(
        agentId: string,
        filePath: string,
        fileContent: string,
        relativeFilePath: string,
        language: string | undefined,
        strategy: ChunkingStrategy,
        storeEntitySummaries: boolean
    ): Promise<{
        chunks: Array<{ chunk_text: string; entity_name?: string; metadata?: any; ai_summary_text?: string }>;
        namingApiCallCount: number;
        summarizationApiCallCount: number;
        summaryDbCallCount: number;
        summaryDbCallLatencyMs: number;
    }> {
        const chunks: Array<{ chunk_text: string; entity_name?: string; metadata?: any; ai_summary_text?: string }> = [];
        let namingApiCallCount = 0;
        let summarizationApiCallCount = 0;
        let summaryDbCallCount = 0;
        let summaryDbCallLatencyMs = 0;

        // Handle very large files by splitting them into manageable chunks
        if (fileContent.length > 50000) { // 50KB threshold
            return this.handleLargeFile(agentId, filePath, fileContent, relativeFilePath, language, strategy, storeEntitySummaries);
        }

        let fullFileEntityName: string | null = 'full_file_chunk';
        if (!language) {
            fullFileEntityName = await this.aiProvider.generateMeaningfulEntityName(fileContent, language);
            namingApiCallCount++;
        }

        chunks.push({
            chunk_text: fileContent,
            entity_name: fullFileEntityName,
            metadata: { type: 'full_file', language }
        });

        if (!language || !['typescript', 'javascript', 'python', 'php'].includes(language)) {
            return { chunks, namingApiCallCount, summarizationApiCallCount, summaryDbCallCount: 0, summaryDbCallLatencyMs: 0 };
        }

        const imports = await this.introspectionService.parseFileForImports(agentId, filePath, language);
        const importContext = "/* Imports for context */\n" + imports.map(imp => imp.originalImportString).join('\n');

        const codeEntities = await this.introspectionService.parseFileForCodeEntities(agentId, filePath, language);
        const functionCodeMap = new Map<string, string>();

        codeEntities.forEach(entity => {
            if (entity.type === 'function' || entity.type === 'method') {
                if (typeof entity.name === 'string' && entity.name.length > 0) {
                    const entityCode = fileContent.split(/\r\n|\r|\n/).slice(entity.startLine - 1, entity.endLine).join('\n');
                    functionCodeMap.set(entity.name, entityCode);
                }
            }
        });

        const entitiesToProcess = codeEntities.filter(entity => {
            return (strategy === 'function' && (entity.type === 'function' || entity.type === 'method')) ||
                (strategy === 'class' && entity.type === 'class') ||
                (strategy === 'auto' && ['function', 'method', 'class', 'interface'].includes(entity.type));
        }).filter(entity => {
            if (entity.fullName === undefined) {
                return false;
            }
            const entityCode = fileContent.split(/\r\n|\r|\n/).slice(entity.startLine - 1, entity.endLine).join('\n');
            return entityCode.trim();
        });

        // Batch fetch knowledge graph search results
        await this.batchFetchKnowledgeGraphResults(agentId, entitiesToProcess);

        const namingRequests: Array<{ codeChunk: string; language: string | undefined }> = [];
        const summarizationRequests: Array<{ codeChunk: string; entityType: string; language: string }> = [];
        const entityCodeMap = new Map<string, string>();

        for (const entity of entitiesToProcess) {
            const entityCode = fileContent.split(/\r\n|\r|\n/).slice(entity.startLine - 1, entity.endLine).join('\n');
            entityCodeMap.set(entity.fullName!, entityCode);

            if (entity.name && entity.name.startsWith('anonymous_function_at_line_')) {
                namingRequests.push({ codeChunk: entityCode, language: language });
            }

            if (storeEntitySummaries && entity.name && ['function', 'method', 'class', 'interface'].includes(entity.type)) {
                const originalCodeHash = this.generateChunkHash(entityCode);
                const { summary: existingSummary, latencyMs: summaryLatencyMs, callCount: summaryCallCount } =
                    await this.memoryManager.codebaseEmbeddingService.repository.getExistingSummaryByHash(originalCodeHash);

                summaryDbCallCount += summaryCallCount;
                summaryDbCallLatencyMs += summaryLatencyMs;

                if (!existingSummary) {
            const codeWithFullContext = await this.enhanceCodeWithContext(
                entityCode, entity, language, importContext, functionCodeMap, agentId
            );
                    summarizationRequests.push({
                        codeChunk: codeWithFullContext,
                        entityType: entity.type,
                        language: language!
                    });
                }
            }
        }

        const meaningfulNames = namingRequests.length > 0 ?
            await this.aiProvider.batchGenerateMeaningfulEntityNames(namingRequests) : [];

        if (namingRequests.length > 0) {
            namingApiCallCount++;
        }

        const summaries = summarizationRequests.length > 0 ?
            await this.aiProvider.batchSummarizeCodeChunks(summarizationRequests) : [];

        if (summarizationRequests.length > 0) {
            summarizationApiCallCount++;
        }

        let nameIndex = 0;
        let summaryIndex = 0;

        for (const entity of entitiesToProcess) {
            const entityCode = entity.fullName !== undefined ? entityCodeMap.get(entity.fullName) : undefined;
            if (entityCode === undefined) {
                console.warn(`Could not retrieve entity code for ${entity.fullName} from map.`);
                continue;
            }

            const codeWithFullContext = await this.enhanceCodeWithContext(
                entityCode, entity, language, importContext, functionCodeMap, agentId
            );

            let entityNameForChunk = entity.name;
            if (entity.name && entity.name.startsWith('anonymous_function_at_line_')) {
                entityNameForChunk = meaningfulNames[nameIndex++] || entity.name;
            }

            chunks.push({
                chunk_text: codeWithFullContext,
                entity_name: entityNameForChunk,
                metadata: {
                    type: entity.type,
                    startLine: entity.startLine,
                    endLine: entity.endLine,
                    signature: entity.signature,
                    fullName: entity.fullName,
                    language: language
                }
            });

            if (storeEntitySummaries && entity.name && ['function', 'method', 'class', 'interface'].includes(entity.type)) {
                const originalCodeHash = this.generateChunkHash(entityCode);
                const { summary: fetchedSummary, latencyMs: fetchedLatency, callCount: fetchedCallCount } =
                    await this.memoryManager.codebaseEmbeddingService.repository.getExistingSummaryByHash(originalCodeHash);

                summaryDbCallCount += fetchedCallCount;
                summaryDbCallLatencyMs += fetchedLatency;

                let summaryToUse = fetchedSummary;
                if (!summaryToUse) {
                    summaryToUse = summaries[summaryIndex++] || 'Could not generate summary.';
                }

                let summaryEntityName = `${entity.name}_summary`;
                if (entity.name.startsWith('anonymous_function_at_line_')) {
                    summaryEntityName = `${entityNameForChunk}_summary`;
                }

                chunks.push({
                    chunk_text: entityCode,
                    ai_summary_text: summaryToUse,
                    entity_name: summaryEntityName,
                    metadata: {
                        type: `${entity.type}_summary`,
                        original_code_hash: originalCodeHash,
                        startLine: entity.startLine,
                        endLine: entity.endLine,
                        fullName: entity.fullName,
                        language: language
                    }
                });
            }
        }

        return { chunks, namingApiCallCount, summarizationApiCallCount, summaryDbCallCount, summaryDbCallLatencyMs };
    }

    /**
     * Handles very large files by splitting them into smaller chunks with context.
     */
    private async handleLargeFile(
        agentId: string,
        filePath: string,
        fileContent: string,
        relativeFilePath: string,
        language: string | undefined,
        strategy: ChunkingStrategy,
        storeEntitySummaries: boolean
    ): Promise<{
        chunks: Array<{ chunk_text: string; entity_name?: string; metadata?: any; ai_summary_text?: string }>;
        namingApiCallCount: number;
        summarizationApiCallCount: number;
        summaryDbCallCount: number;
        summaryDbCallLatencyMs: number;
    }> {
        console.log(`[CodeChunkingService] Handling large file: ${filePath} (${fileContent.length} characters)`);

        const chunks: Array<{ chunk_text: string; entity_name?: string; metadata?: any; ai_summary_text?: string }> = [];
        const lines = fileContent.split(/\r\n|\r|\n/);
        let currentChunk: string[] = [];
        let currentLineCount = 0;
        let chunkIndex = 0;

        // Simple line-based chunking for very large files
        for (const line of lines) {
            currentChunk.push(line);
            currentLineCount++;

            if (currentLineCount >= 500) { // Create chunks of ~500 lines
                const chunkText = currentChunk.join('\n');
                chunks.push({
                    chunk_text: chunkText,
                    entity_name: `large_file_chunk_${chunkIndex}`,
                    metadata: {
                        type: 'large_file_chunk',
                        startLine: currentLineCount - 500,
                        endLine: currentLineCount,
                        language: language
                    }
                });

                currentChunk = [];
                currentLineCount = 0;
                chunkIndex++;
            }
        }

        // Add the last chunk if it has content
        if (currentChunk.length > 0) {
            const chunkText = currentChunk.join('\n');
            chunks.push({
                chunk_text: chunkText,
                entity_name: `large_file_chunk_${chunkIndex}`,
                metadata: {
                    type: 'large_file_chunk',
                    startLine: currentLineCount - currentChunk.length,
                    endLine: currentLineCount,
                    language: language
                }
            });
        }

        return {
            chunks,
            namingApiCallCount: 0,
            summarizationApiCallCount: 0,
            summaryDbCallCount: 0,
            summaryDbCallLatencyMs: 0
        };
    }

    /**
     * Batch fetches knowledge graph results to reduce database calls.
     */
    private async batchFetchKnowledgeGraphResults(agentId: string, entitiesToProcess: any[]): Promise<void> {
        const fullNames = entitiesToProcess.map(e => e.fullName!).filter(name => !this.knowledgeGraphCache.has(name));

        if (fullNames.length > 0) {
            try {
                // Process in batches to avoid overly large queries
                const batchSize = 50;
                for (let i = 0; i < fullNames.length; i += batchSize) {
                    const batch = fullNames.slice(i, i + batchSize);
                    const batchQuery = batch.map(name => `name:${name}`).join(' OR ');
                    const batchResults = await this.memoryManager.knowledgeGraphManager.searchNodes(agentId, batchQuery);

                    // Organize results by entity fullName
                    for (const fullName of batch) {
                        const related = batchResults.filter((r: any) => r.name.includes(fullName));
                        this.knowledgeGraphCache.set(fullName, related);
                    }
                }
            } catch (e) {
                console.warn('Batch knowledge graph search failed:', e);
            }
        }
    }

    /**
     * Enhances code with additional context for better embeddings.
     */
    private async enhanceCodeWithContext(
        entityCode: string,
        entity: any,
        language: string | undefined,
        importContext: string,
        functionCodeMap: Map<string, string>,
        agentId: string
    ): Promise<string> {
        let graphContext = "/* Code structure context */\n";

        try {
            let relations;
            if (this.knowledgeGraphCache.has(entity.fullName!)) {
                relations = this.knowledgeGraphCache.get(entity.fullName!);
            } else {
                relations = await this.memoryManager.knowledgeGraphManager.searchNodes(
                    agentId,
                    `name:${entity.fullName}`
                );
                this.knowledgeGraphCache.set(entity.fullName!, relations);
            }

            if (relations && relations.length > 0) {
                const relatedNodes = relations.map((r: any) => r.name);
                graphContext += `/* This entity is related to: ${relatedNodes.join(', ')} */\n`;
            }

            if (entity.parentClass) {
                graphContext += `/* This method is part of class: ${entity.parentClass} */\n`;
            }
        } catch (e) {
            console.warn(`Could not retrieve graph context for ${entity.fullName}: `, e);
        }

        let recursiveContext = '/* Recursively included function calls */\n';
        if (entity.type === 'function' || entity.type === 'method') {
            for (const [funcName, funcCode] of functionCodeMap.entries()) {
                if (funcName !== entity.name && entityCode.includes(funcName)) {
                    // Include a truncated version of the function to avoid overly large chunks
                    const truncatedFuncCode = funcCode.length > 500
                        ? funcCode.substring(0, 500) + "\n// ... (truncated)"
                        : funcCode;
                    recursiveContext += `/* Included from internal call to ${funcName} */\n${truncatedFuncCode}\n\n`;
                }
            }
        }

        return `${recursiveContext}${graphContext}${importContext}\n\n${entityCode}`;
    }
}