import { MemoryManager } from '../../memory_manager.js';
import { CodebaseIntrospectionService } from '../CodebaseIntrospectionService.js';
import { AIEmbeddingProvider } from './AIEmbeddingProvider.js';
import { ChunkingStrategy } from '../../../types/codebase_embeddings.js';
import crypto from 'crypto';

export class CodeChunkingService {
    private introspectionService: CodebaseIntrospectionService;
    private aiProvider: AIEmbeddingProvider;
    private memoryManager: MemoryManager;

    constructor(
        introspectionService: CodebaseIntrospectionService,
        aiProvider: AIEmbeddingProvider,
        memoryManager: MemoryManager
    ) {
        this.introspectionService = introspectionService;
        this.aiProvider = aiProvider;
        this.memoryManager = memoryManager;
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
    ): Promise<Array<{ chunk_text: string; entity_name?: string; metadata?: any; ai_summary_text?: string }>> {
        const chunks: Array<{ chunk_text: string; entity_name?: string; metadata?: any; ai_summary_text?: string }> = [];

        let fullFileEntityName: string | null = 'full_file_chunk';
        if (!language) {
            fullFileEntityName = await this.aiProvider.generateMeaningfulEntityName(fileContent, language);
        }
        chunks.push({
            chunk_text: fileContent,
            entity_name: fullFileEntityName,
            metadata: { type: 'full_file', language }
        });

        if (!language || !['typescript', 'javascript', 'python', 'php'].includes(language)) {
            return chunks;
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

        if ((strategy === 'function' || strategy === 'class' || strategy === 'auto') && codeEntities.length > 0) {
            for (const entity of codeEntities) {
                if ((strategy === 'function' && (entity.type === 'function' || entity.type === 'method')) ||
                    (strategy === 'class' && entity.type === 'class') ||
                    (strategy === 'auto' && ['function', 'method', 'class', 'interface'].includes(entity.type))) {

                    const entityCode = fileContent.split(/\r\n|\r|\n/).slice(entity.startLine - 1, entity.endLine).join('\n');

                    if (entityCode.trim()) {
                        let graphContext = "/* Code structure context */\n";
                        try {
                            const relations = await this.memoryManager.knowledgeGraphManager.searchNodes(agentId, `name:${entity.fullName}`);
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
                            entityNameForChunk = await this.aiProvider.generateMeaningfulEntityName(entityCode, language);
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
                            let summary = await this.memoryManager.codebaseEmbeddingService.repository.getExistingSummaryByHash(originalCodeHash);

                            if (!summary) {
                                const summarizationPrompt = `You are an expert software engineer. Summarize the following ${entity.type} code snippet focusing only on the main purpose and key functionality. Provide a concise, clear, and relevant summary suitable for a development team review.\n\n${codeWithFullContext}`;
                                summary = await this.aiProvider.geminiService.summarizeCodeChunk(summarizationPrompt, entity.type, language);
                            }

                            let summaryEntityName = `${entity.name}_summary`;
                            if (entity.name.startsWith('anonymous_function_at_line_')) {
                                summaryEntityName = await this.aiProvider.generateMeaningfulEntityName(summary, 'text');
                            }

                            chunks.push({
                                chunk_text: entityCode,
                                ai_summary_text: summary,
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
            }
        }
        return chunks;
    }
}
