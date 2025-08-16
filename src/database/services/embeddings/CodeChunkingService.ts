import { MemoryManager } from '../../memory_manager.js';
import { CodebaseIntrospectionService } from '../CodebaseIntrospectionService.js';
import { AIEmbeddingProvider } from './AIEmbeddingProvider.js';
import { ChunkingStrategy } from '../../../types/codebase_embeddings.js';
import crypto from 'crypto';

// MODIFICATION: Define a structured output for the new chunking strategy
export interface MultiVectorChunk {
    chunk_text: string;
    entity_name?: string;
    metadata?: any;
    ai_summary_text?: string;
    embedding_type: 'summary' | 'chunk';
    parent_embedding_id?: string;
}

export class CodeChunkingService {
    private introspectionService: CodebaseIntrospectionService;
    private aiProvider: AIEmbeddingProvider;
    private memoryManager: MemoryManager;
    private chunkSizeLimit: number = 15000;
    private overlapSize: number = 200;

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

    private slidingWindowChunk(content: string, maxChunkSize: number = this.chunkSizeLimit, overlap: number = this.overlapSize): string[] {
        if (content.length <= maxChunkSize) {
            return [content];
        }
        const chunks: string[] = [];
        const lines = content.split('\n');
        let currentChunkLines: string[] = [];
        let currentChunkSize = 0;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineSize = line.length + 1;
            if (currentChunkSize > 0 && currentChunkSize + lineSize > maxChunkSize) {
                chunks.push(currentChunkLines.join('\n'));
                let overlapCharsCount = 0;
                let overlapLineIndex = currentChunkLines.length - 1;
                const newChunkLines: string[] = [];
                while (overlapLineIndex >= 0 && overlapCharsCount < overlap) {
                    const overlapLine = currentChunkLines[overlapLineIndex];
                    newChunkLines.unshift(overlapLine);
                    overlapCharsCount += overlapLine.length + 1;
                    overlapLineIndex--;
                }
                currentChunkLines = newChunkLines.length > 0 ? newChunkLines : [];
                currentChunkSize = currentChunkLines.join('\n').length;
            }
            currentChunkLines.push(line);
            currentChunkSize += lineSize;
        }
        if (currentChunkLines.length > 0) {
            chunks.push(currentChunkLines.join('\n'));
        }
        return chunks;
    }

    /**
     * MODIFICATION: New core chunking method implementing the Parent Document strategy.
     * It creates a high-level summary chunk for the entire file, then breaks down the
     * rest of the file into smaller, detailed child chunks.
     */
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

        // Step 1: Create the Parent Summary Chunk
        const summaryPrompt = `You are a senior software engineer. Create a concise, high-level summary of the following code file.
Focus on the file's primary purpose, key responsibilities, and how it might interact with other parts of a larger application.
File Path: \`${relativeFilePath}\`
Language: ${language || 'unknown'}

\`\`\`${language || ''}
${fileContent.substring(0, 8000)}
\`\`\`

Concise Summary:`;

        const fileSummary = await this.aiProvider.summarizeCodeChunk(summaryPrompt, 'file_summary', language || 'unknown');
        summarizationApiCallCount++;

        allChunks.push({
            chunk_text: fileSummary,
            entity_name: `Summary for ${relativeFilePath}`,
            embedding_type: 'summary',
            metadata: {
                type: 'file_summary',
                language: language,
                original_file_path: relativeFilePath
            },
            // The parent chunk's parent_embedding_id is its own ID, which we will set in the service layer.
        });

        // Step 2: Create Child Chunks from Code Entities
        const codeEntities = await this.introspectionService.parseFileForCodeEntities(agentId, filePath, language);
        const childChunks = codeEntities
            .filter(entity => ['function', 'method', 'class', 'interface'].includes(entity.type))
            .map(entity => {
                const entityCode = fileContent.split(/\r\n|\r|\n/).slice(entity.startLine - 1, entity.endLine).join('\n');
                return {
                    chunk_text: entityCode,
                    entity_name: entity.fullName,
                    embedding_type: 'chunk' as 'chunk',
                    parent_embedding_id: parentId, // Link to the summary chunk
                    metadata: {
                        type: entity.type,
                        startLine: entity.startLine,
                        endLine: entity.endLine,
                        language: language
                    }
                };
            });

        allChunks.push(...childChunks);

        // Step 3: If no code entities were found, use sliding window for the content
        if (childChunks.length === 0) {
            const slidingChunks = this.slidingWindowChunk(fileContent).map((chunkText, index) => ({
                chunk_text: chunkText,
                entity_name: `chunk_${index + 1}_of_${relativeFilePath}`,
                embedding_type: 'chunk' as 'chunk',
                parent_embedding_id: parentId,
                metadata: { type: 'file_chunk', language: language }
            }));
            allChunks.push(...slidingChunks);
        }

        return { chunks: allChunks, summarizationApiCallCount };
    }
}