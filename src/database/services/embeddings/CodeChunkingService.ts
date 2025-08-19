import { ExtractedCodeEntity } from '../CodebaseIntrospectionService.js';
import { MemoryManager } from '../../memory_manager.js';
import { CodebaseIntrospectionService } from '../CodebaseIntrospectionService.js';
import { AIEmbeddingProvider } from './AIEmbeddingProvider.js';
import { ChunkingStrategy } from '../../../types/codebase_embeddings.js';
import crypto from 'crypto';

export interface MultiVectorChunk {
    chunk_text: string;
    entity_name?: string;
    metadata?: any;
    ai_summary_text?: string;
    embedding_type: 'summary' | 'chunk';
    parent_embedding_id?: string;
    chunk_hash?: string;
    language?: string;
    start_line?: number;
    end_line?: number;
    importance_score?: number;
    code_type?: string;
}

export class CodeChunkingService {
    private introspectionService: CodebaseIntrospectionService;
    private aiProvider: AIEmbeddingProvider;
    private memoryManager: MemoryManager;
    private chunkSizeLimit: number;
    private overlapSize: number;
    private minChunkSize: number;
    private maxChunkSize: number;

    constructor(
        introspectionService: CodebaseIntrospectionService,
        aiProvider: AIEmbeddingProvider,
        memoryManager: MemoryManager
    ) {
        this.introspectionService = introspectionService;
        this.aiProvider = aiProvider;
        this.memoryManager = memoryManager;
        this.chunkSizeLimit = 15000;
        this.overlapSize = 200;
        this.minChunkSize = 100; // Minimum chunk size to avoid tiny chunks
        this.maxChunkSize = 8000; // Maximum chunk size for better granularity
    }

    private generateChunkHash(text: string): string {
        return crypto.createHash('sha256').update(text).digest('hex');
    }

    private slidingWindowChunk(content: string, maxChunkSize: number = this.maxChunkSize, overlap: number = this.overlapSize): string[] {
        if (content.length <= maxChunkSize) {
            return [content];
        }

        const chunks: string[] = [];
        const lines = content.split('\n');
        let currentChunkLines: string[] = [];
        let currentChunkSize = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineSize = line.length + 1; // +1 for newline

            if (currentChunkSize > 0 && currentChunkSize + lineSize > maxChunkSize) {
                // Save current chunk
                chunks.push(currentChunkLines.join('\n'));

                // Create overlap for next chunk
                let overlapCharsCount = 0;
                let overlapLineIndex = currentChunkLines.length - 1;
                const newChunkLines: string[] = [];

                while (overlapLineIndex >= 0 && overlapCharsCount < overlap) {
                    const overlapLine = currentChunkLines[overlapLineIndex];
                    newChunkLines.unshift(overlapLine);
                    overlapCharsCount += overlapLine.length + 1;
                    overlapLineIndex--;
                }

                currentChunkLines = newChunkLines;
                currentChunkSize = currentChunkLines.join('\n').length;
            }

            currentChunkLines.push(line);
            currentChunkSize += lineSize;
        }

        // Add the last chunk if it has content
        if (currentChunkLines.length > 0) {
            chunks.push(currentChunkLines.join('\n'));
        }

        return chunks;
    }

    private semanticChunking(entities: ExtractedCodeEntity[], fileContent: string): MultiVectorChunk[] {
        const chunks: MultiVectorChunk[] = [];

        // Sort entities by their start line to process in order
        entities.sort((a, b) => a.startLine - b.startLine);

        for (const entity of entities) {
            // Extract the code for this entity
            const entityCode = fileContent.split('\n').slice(entity.startLine - 1, entity.endLine).join('\n');

            if (entityCode.length < this.minChunkSize) {
                continue; // Skip very small entities
            }

            // Create a chunk for this entity
            const chunk: MultiVectorChunk = {
                chunk_text: entityCode,
                entity_name: entity.fullName || entity.name,
                metadata: {
                    type: entity.type,
                    startLine: entity.startLine,
                    endLine: entity.endLine,
                    language: entity.filePath ? this.introspectionService.detectLanguage('', entity.filePath, '') : undefined,
                    accessibility: entity.accessibility,
                    isExported: entity.isExported,
                    isAsync: entity.isAsync,
                    parameters: entity.parameters,
                    returnType: entity.returnType,
                    parentClass: entity.parentClass,
                    implementedInterfaces: entity.implementedInterfaces
                },
                embedding_type: 'chunk',
                chunk_hash: this.generateChunkHash(entityCode),
                start_line: entity.startLine,
                end_line: entity.endLine,
                code_type: entity.type,
                importance_score: this.calculateImportanceScore(entity)
            };

            chunks.push(chunk);
        }

        return chunks;
    }

    private calculateImportanceScore(entity: ExtractedCodeEntity): number {
        let score = 0;

        // Higher scores for more important entity types
        const typeScores: Record<string, number> = {
            'class': 10,
            'interface': 9,
            'function': 8,
            'method': 7,
            'enum': 6,
            'type_alias': 5,
            'variable': 4,
            'property': 3,
            'parameter_property': 2,
            'unknown': 1
        };

        score += typeScores[entity.type] || 1;

        // Bonus for exported entities
        if (entity.isExported) {
            score += 3;
        }

        // Bonus for public accessibility
        if (entity.accessibility === 'public') {
            score += 2;
        }

        // Bonus for async methods
        if (entity.isAsync) {
            score += 1;
        }

        // Bonus for entities with documentation
        if (entity.docstring) {
            score += 2;
        }

        // Normalize score to 0-1 range
        return Math.min(score / 20, 1.0);
    }

    public async chunkFileForMultiVector(
        agentId: string,
        filePath: string,
        fileContent: string,
        relativeFilePath: string,
        language: string | undefined,
    ): Promise<{ chunks: MultiVectorChunk[], summarizationApiCallCount: number }> {
        const parentId = crypto.randomUUID();
        const allChunks: MultiVectorChunk[] = [];
        let summarizationApiCallCount = 0;

        try {
            // Step 1: Create the Parent Summary Chunk
            const summaryPrompt = `You are a senior software engineer. Create a concise, high-level summary of the following code file.
Focus on the file's primary purpose, key responsibilities, and how it might interact with other parts of a larger application.
File Path: \`${relativeFilePath}\`
Language: ${language || 'unknown'}
\`\`\`${language || ''}
${fileContent.substring(0, 8000)}
\`\`\`
Concise Summary:`;

            let fileSummary;
            try {
                fileSummary = await this.aiProvider.summarizeCodeChunk(
                    summaryPrompt,
                    'file_summary',
                    language || 'unknown'
                );
                summarizationApiCallCount++;
            } catch (error) {
                console.error(`Error generating file summary for ${relativeFilePath}:`, error);
                fileSummary = `Summary for ${relativeFilePath} (generation failed)`;
            }

            allChunks.push({
                chunk_text: fileSummary,
                entity_name: `Summary for ${relativeFilePath}`,
                embedding_type: 'summary',
                metadata: {
                    type: 'file_summary',
                    language: language,
                    original_file_path: relativeFilePath
                },
            });

            // Step 2: Parse code entities for semantic chunking
            let codeEntities: ExtractedCodeEntity[];
            try {
                codeEntities = await this.introspectionService.parseFileForCodeEntities(agentId, filePath, language);
            } catch (error) {
                console.error(`Error parsing code entities for ${relativeFilePath}:`, error);
                codeEntities = [];
            }

            // Step 3: Create semantic chunks from code entities
            if (codeEntities.length > 0) {
                const semanticChunks = this.semanticChunking(codeEntities, fileContent);

                // Link chunks to parent summary
                for (const chunk of semanticChunks) {
                    chunk.parent_embedding_id = parentId;
                    allChunks.push(chunk);
                }
            }

            // Step 4: If no semantic chunks were created, use sliding window for the content
            if (allChunks.length === 1) { // Only the summary exists
                const slidingChunks = this.slidingWindowChunk(fileContent).map((chunkText, index) => ({
                    chunk_text: chunkText,
                    entity_name: `chunk_${index + 1}_of_${relativeFilePath}`,
                    embedding_type: 'chunk' as 'chunk',
                    parent_embedding_id: parentId,
                    metadata: {
                        type: 'file_chunk',
                        language: language
                    },
                    chunk_hash: this.generateChunkHash(chunkText)
                }));

                allChunks.push(...slidingChunks);
            }

            return { chunks: allChunks, summarizationApiCallCount };
        } catch (error) {
            console.error(`Error chunking file ${filePath}:`, error);
            // Return minimal chunks to ensure processing continues
            return {
                chunks: [{
                    chunk_text: fileContent,
                    entity_name: `fallback_chunk_${relativeFilePath}`,
                    embedding_type: 'chunk' as 'chunk',
                    metadata: {
                        type: 'fallback_chunk',
                        language: language,
                        error: error instanceof Error ? error.message : String(error)
                    },
                    chunk_hash: this.generateChunkHash(fileContent)
                }],
                summarizationApiCallCount: 0
            };
        }
    }
}