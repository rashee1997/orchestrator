import { MemoryManager } from '../../memory_manager.js';
import { CodebaseIntrospectionService } from '../CodebaseIntrospectionService.js';
import { AIEmbeddingProvider } from './AIEmbeddingProvider.js';
import { ChunkingStrategy } from '../../../types/codebase_embeddings.js';
import crypto from 'crypto';

export class CodeChunkingService {
    private introspectionService: CodebaseIntrospectionService;
    private aiProvider: AIEmbeddingProvider;
    private memoryManager: MemoryManager;
    private knowledgeGraphCache: Map<string, any>; // Cache for knowledge graph search results

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
     * Creates intelligent, context-aware chunks from file content.
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

        let fullFileEntityName: string | null = 'full_file_chunk';
        if (!language) {
            fullFileEntityName = await this.aiProvider.generateMeaningfulEntityName(fileContent, language);
            namingApiCallCount++; // Increment if a meaningful name is generated for the full file
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
            // Filter out entities without a fullName as they cannot be stored in the map
            if (entity.fullName === undefined) {
                return false;
            }
            const entityCode = fileContent.split(/\r\n|\r|\n/).slice(entity.startLine - 1, entity.endLine).join('\n');
            return entityCode.trim();
        });

        const namingRequests: Array<{ codeChunk: string; language: string | undefined }> = [];
        const summarizationRequests: Array<{ codeChunk: string; entityType: string; language: string }> = [];
        const entityCodeMap = new Map<string, string>(); // To store entityCode for later use

        // Batch fetch knowledge graph search results for all entities to reduce DB calls
        const fullNames = entitiesToProcess.map(e => e.fullName!).filter(name => !this.knowledgeGraphCache.has(name));
        if (fullNames.length > 0) {
            try {
                // Batch search by combining queries with OR
                const batchQuery = fullNames.map(name => `name:${name}`).join(' OR ');
                const batchResults = await this.memoryManager.knowledgeGraphManager.searchNodes(agentId, batchQuery);
                // Organize results by entity fullName
                for (const fullName of fullNames) {
                    const related = batchResults.filter((r: any) => r.name.includes(fullName));
                    this.knowledgeGraphCache.set(fullName, related);
                }
            } catch (e) {
                console.warn('Batch knowledge graph search failed:', e);
            }
        }

        for (const entity of entitiesToProcess) {
            const entityCode = fileContent.split(/\r\n|\r|\n/).slice(entity.startLine - 1, entity.endLine).join('\n');
            entityCodeMap.set(entity.fullName!, entityCode); // Store by full name for easy retrieval

            if (entity.name && entity.name.startsWith('anonymous_function_at_line_')) {
                namingRequests.push({ codeChunk: entityCode, language: language });
            }

            if (storeEntitySummaries && entity.name && ['function', 'method', 'class', 'interface'].includes(entity.type)) {
                const originalCodeHash = this.generateChunkHash(entityCode);
                const { summary: existingSummary, latencyMs: summaryLatencyMs, callCount: summaryCallCount } = await this.memoryManager.codebaseEmbeddingService.repository.getExistingSummaryByHash(originalCodeHash);
                summaryDbCallCount += summaryCallCount;
                summaryDbCallLatencyMs += summaryLatencyMs;
                
                if (!existingSummary) {
                    // Prepare prompt for summarization
                    let graphContext = "/* Code structure context */\n";
                    try {
                        let relations;
                        if (this.knowledgeGraphCache.has(entity.fullName!)) {
                            relations = this.knowledgeGraphCache.get(entity.fullName!);
                        } else {
                            relations = await this.memoryManager.knowledgeGraphManager.searchNodes(agentId, `name:${entity.fullName}`);
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
                                recursiveContext += `/* Included from internal call to ${funcName} */\n${funcCode}\n\n`;
                            }
                        }
                    }
                    const codeWithFullContext = `${recursiveContext}${graphContext}${importContext}\n\n${entityCode}`;
                    summarizationRequests.push({ codeChunk: codeWithFullContext, entityType: entity.type, language: language! });
                }
            }
        }

        const meaningfulNames = namingRequests.length > 0 ? await this.aiProvider.batchGenerateMeaningfulEntityNames(namingRequests) : [];
        if (namingRequests.length > 0) {
            namingApiCallCount++;
        }

        const summaries = summarizationRequests.length > 0 ? await this.aiProvider.batchSummarizeCodeChunks(summarizationRequests) : [];
        if (summarizationRequests.length > 0) {
            summarizationApiCallCount++;
        }

        let nameIndex = 0;
        let summaryIndex = 0;

        if (entitiesToProcess.length > 0) {
            for (const entity of entitiesToProcess) {
                // Ensure entity.fullName is defined before retrieving from the map
                const entityCode = entity.fullName !== undefined ? entityCodeMap.get(entity.fullName) : undefined;
                if (entityCode === undefined) {
                    // This should not happen if the filtering and setting logic is correct,
                    // but adding a check for safety.
                    console.warn(`Could not retrieve entity code for ${entity.fullName} from map.`);
                    continue; // Skip this entity if code is not found
                }

                let graphContext = "/* Code structure context */\n";
                try {
                    let relations;
                    if (this.knowledgeGraphCache.has(entity.fullName!)) {
                        relations = this.knowledgeGraphCache.get(entity.fullName!);
                    } else {
                        relations = await this.memoryManager.knowledgeGraphManager.searchNodes(agentId, `name:${entity.fullName}`);
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
                            recursiveContext += `/* Included from internal call to ${funcName} */\n${funcCode}\n\n`;
                        }
                    }
                }

                const codeWithFullContext = `${recursiveContext}${graphContext}${importContext}\n\n${entityCode}`;

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
                    const { summary: fetchedSummary, latencyMs: fetchedLatency, callCount: fetchedCallCount } = await this.memoryManager.codebaseEmbeddingService.repository.getExistingSummaryByHash(originalCodeHash);
                    summaryDbCallCount += fetchedCallCount;
                    summaryDbCallLatencyMs += fetchedLatency;

                    let summaryToUse = fetchedSummary;
                    if (!summaryToUse) {
                        summaryToUse = summaries[summaryIndex++] || 'Could not generate summary.';
                    }

                    let summaryEntityName = `${entity.name}_summary`;
                    if (entity.name.startsWith('anonymous_function_at_line_')) {
                        // If the original entity name was anonymous, generate a meaningful name for the summary too
                        // This would ideally be batched as well, but for simplicity, we'll use the already generated meaningful name if available
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
        }
        return { chunks, namingApiCallCount, summarizationApiCallCount, summaryDbCallCount, summaryDbCallLatencyMs };
    }
}
