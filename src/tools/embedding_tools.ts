// src/tools/embedding_tools.ts
import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate, schemas } from '../utils/validation.js';
import { formatSimpleMessage, formatJsonToMarkdownCodeBlock } from '../utils/formatters.js';
import { CodebaseEmbeddingService } from '../database/services/CodebaseEmbeddingService.js'; // Import the service
import { ChunkingStrategy } from '../types/codebase_embeddings.js'; // Correct import for ChunkingStrategy
import fs from 'fs/promises'; // For checking if path exists
import path from 'path'; // For path operations

// Define the interface for the chunk result, including the new original_code_snippet
interface CodeChunkResult {
    chunk_text: string; // Now always contains the original code
    ai_summary_text?: string | null; // New: Contains the AI-generated summary
    file_path_relative: string;
    entity_name: string | null;
    score: number;
    metadata?: Record<string, any> | null;
}

export const embeddingToolDefinitions = [
    {
        name: 'ingest_codebase_embeddings',
        description: `Scans a specified file or directory, chunks its content based on the chosen strategy,
generates vector embeddings for each chunk using Gemini, and stores them in the dedicated vector store.
Requires 'project_root_path' to correctly calculate relative paths for stored embeddings.
Output is Markdown formatted.`,
        inputSchema: schemas.ingestCodebaseEmbeddings, // Use the new schema
    },
    // Future embedding-related tools can be added here, e.g., for querying embeddings
    {
        name: 'query_codebase_embeddings',
        description: `Retrieves code chunks from the vector store that are semantically similar to a given query text.
Output is Markdown formatted.`,
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: "Agent ID associated with the embeddings." },
                query_text: { type: 'string', description: "The text to find similar code chunks for." },
                top_k: { type: 'number', default: 5, minimum: 1, description: "Number of top results to return." },
                target_file_paths: {
                    type: 'array',
                    items: { type: 'string' },
                    nullable: true,
                    description: "Optional: Array of relative file paths to restrict the search to."
                },
                exclude_chunk_types: {
                    type: 'array',
                    items: { type: 'string' },
                    nullable: true,
                    description: "Optional: Array of chunk types to exclude from the results (e.g., 'full_file', 'function_summary')."
                }
            },
            required: ['agent_id', 'query_text'],
            additionalProperties: false,
        }
    },
    {
        name: 'clean_up_embeddings',
        description: `Removes and cleans up embeddings from the vector database based on specified file paths.
Returns a summary of deleted embeddings.`,
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: "Agent ID associated with the embeddings." },
                file_paths: {
                    type: 'array',
                    items: { type: 'string' },
                    description: "Array of relative file paths to delete embeddings for."
                },
                project_root_path: {
                    type: 'string',
                    description: "The absolute root path of the project. Used to correctly resolve and normalize file paths for deletion."
                },
                filter_by_agent: {
                    type: 'boolean',
                    default: true,
                    description: "Optional: If true, only deletes embeddings associated with the calling agent_id. Defaults to true."
                }
            },
            required: ['agent_id', 'file_paths', 'project_root_path'],
            additionalProperties: false,
        }
    }
];

export function getEmbeddingToolHandlers(memoryManager: MemoryManager) {
    return {
        'ingest_codebase_embeddings': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for ingest_codebase_embeddings.");
            }

            const validationResult = validate('ingestCodebaseEmbeddings', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed for ingest_codebase_embeddings: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }

            const { path_to_embed, project_root_path, is_directory, chunking_strategy, disable_ai_output_summary, include_summary_patterns, exclude_summary_patterns, storeEntitySummaries } = args;

            const absoluteProjectRootPath = path.resolve(project_root_path);
            const absolutePathToEmbed = path.resolve(absoluteProjectRootPath, path_to_embed);

            if (!absolutePathToEmbed.startsWith(absoluteProjectRootPath)) {
                throw new McpError(ErrorCode.InvalidParams, `Path to embed (${absolutePathToEmbed}) must be within the project root path (${absoluteProjectRootPath}).`);
            }

            try {
                await fs.access(absolutePathToEmbed);
            } catch (e) {
                throw new McpError(ErrorCode.InvalidParams, `Path not found or inaccessible: ${absolutePathToEmbed}`);
            }

            const embeddingService = memoryManager.getCodebaseEmbeddingService();

            let resultCounts: {
                newEmbeddingsCount: number;
                reusedEmbeddingsCount: number;
                deletedEmbeddingsCount: number;
                newEmbeddings?: Array<{ file_path_relative: string; chunk_text: string }>;
                reusedEmbeddings?: Array<{ file_path_relative: string; chunk_text: string }>;
                deletedEmbeddings?: Array<{ file_path_relative: string; chunk_text: string }>;
                aiSummary?: string;
                embeddingRequestCount?: number;
                embeddingRetryCount?: number;
                namingApiCallCount?: number;
                summarizationApiCallCount?: number;
                dbCallCount?: number;
                dbCallLatencyMs?: number;
                totalTimeMs?: number;
            };

            if (is_directory) {
                resultCounts = await embeddingService.generateAndStoreEmbeddingsForDirectory(
                    agent_id,
                    absolutePathToEmbed,
                    absoluteProjectRootPath,
                    chunking_strategy as ChunkingStrategy,
                    include_summary_patterns,
                    exclude_summary_patterns,
                    storeEntitySummaries
                );
            } else {
                resultCounts = await embeddingService.generateAndStoreEmbeddingsForFile(
                    agent_id,
                    absolutePathToEmbed,
                    absoluteProjectRootPath,
                    chunking_strategy as ChunkingStrategy,
                    include_summary_patterns,
                    exclude_summary_patterns,
                    storeEntitySummaries
                );
                await embeddingService.embeddingCache.flushToDb(); // Ensure flush after single file ingestion
            }

            let detailedOutput = `Codebase embedding ingestion for "${path_to_embed}" (relative to project root: "${path.relative(absoluteProjectRootPath, absolutePathToEmbed).replace(/\\/g, '/')}") complete.\n` +
                `- New Embeddings Created: ${resultCounts.newEmbeddingsCount}\n` +
                `- Reused Existing Embeddings: ${resultCounts.reusedEmbeddingsCount}\n` +
                `- Deleted Stale Embeddings: ${resultCounts.deletedEmbeddingsCount}\n`;

            if (resultCounts.embeddingRequestCount !== undefined) {
                detailedOutput += `- Embedding API Requests: ${resultCounts.embeddingRequestCount}\n`;
            }
            if (resultCounts.embeddingRetryCount !== undefined) {
                detailedOutput += `- Embedding API Retries: ${resultCounts.embeddingRetryCount}\n`;
            }
            if (resultCounts.namingApiCallCount !== undefined) {
                detailedOutput += `- Naming API Calls: ${resultCounts.namingApiCallCount}\n`;
            }
            if (resultCounts.summarizationApiCallCount !== undefined) {
                detailedOutput += `- Summarization API Calls: ${resultCounts.summarizationApiCallCount}\n`;
            }
            if (resultCounts.dbCallCount !== undefined) {
                detailedOutput += `- Database Call Count (for existing hashes/summaries): ${resultCounts.dbCallCount}\n`;
            }
            if (resultCounts.dbCallLatencyMs !== undefined) {
                const dbCallLatencySeconds = (resultCounts.dbCallLatencyMs / 1000).toFixed(2);
                detailedOutput += `- Database Call Latency (for existing hashes/summaries): ${dbCallLatencySeconds} seconds\n`;
            }
            if (resultCounts.totalTimeMs !== undefined) {
                const totalTimeMinutes = (resultCounts.totalTimeMs / 60000).toFixed(2);
                detailedOutput += `- Total Time Taken: ${totalTimeMinutes} minutes\n`;
            }

            if (!disable_ai_output_summary) {
                if (resultCounts.newEmbeddings && resultCounts.newEmbeddings.length > 0) {
                    detailedOutput += `\n### New Embeddings Summary:\n`;
                    let combinedNewChunksText = resultCounts.newEmbeddings.map(chunk => chunk.chunk_text).join('\n\n');
                    let newSummary = '';
                    try {
                        const geminiService = memoryManager.getGeminiIntegrationService();
                        if (geminiService) {
                            const response = await geminiService.askGemini(
                                `You are an expert software engineer. Summarize the key changes and additions in the following newly added code chunks. Provide a concise, clear summary suitable for a development team review. Limit to 300 tokens.\n\n${combinedNewChunksText}`
                            );
                            if (response && response.content && Array.isArray(response.content)) {
                                newSummary = response.content.map(part => part.text).join('').trim();
                            }
                        }
                    } catch (e) {
                        console.warn('AI summarizer failed for new embeddings summary:', e);
                    }
                    detailedOutput += `${newSummary}\n`;
                }

                if (resultCounts.reusedEmbeddings && resultCounts.reusedEmbeddings.length > 0) {
                    detailedOutput += `\n### Reused Embeddings Summary:\n`;
                    let combinedReusedChunksText = resultCounts.reusedEmbeddings.map(chunk => chunk.chunk_text).join('\n\n');
                    let reusedSummary = '';
                    try {
                        const geminiService = memoryManager.getGeminiIntegrationService();
                        if (geminiService) {
                            const response = await geminiService.askGemini(
                                `You are an expert software engineer. Summarize the context and significance of the following reused code chunks. Provide a concise, clear summary suitable for a development team review. Limit to 300 tokens.\n\n${combinedReusedChunksText}`
                            );
                            if (response && response.content && Array.isArray(response.content)) {
                                reusedSummary = response.content.map(part => part.text).join('').trim();
                            }
                        }
                    } catch (e) {
                        console.warn('AI summarizer failed for reused embeddings summary:', e);
                    }
                    detailedOutput += `${reusedSummary}\n`;
                }

                if (resultCounts.deletedEmbeddings && resultCounts.deletedEmbeddings.length > 0) {
                    detailedOutput += `\n### Deleted Embeddings Summary:\n`;
                    let combinedDeletedChunksText = resultCounts.deletedEmbeddings.map(chunk => chunk.chunk_text).join('\n\n');
                    let deletedSummary = '';
                    try {
                        const geminiService = memoryManager.getGeminiIntegrationService();
                        if (geminiService) {
                            const response = await geminiService.askGemini(
                                `You are an expert software engineer. Summarize the impact and reasons for deletion of the following code chunks. Provide a concise, clear summary suitable for a development team review. Limit to 300 tokens.\n\n${combinedDeletedChunksText}`
                            );
                            if (response && response.content && Array.isArray(response.content)) {
                                deletedSummary = response.content.map(part => part.text).join('').trim();
                            }
                        }
                    } catch (e) {
                        console.warn('AI summarizer failed for deleted embeddings summary:', e);
                    }
                    detailedOutput += `${deletedSummary}\n`;
                }
            }

            return {
                content: [{
                    type: 'text', text: detailedOutput
                }]
            };
        },
        'query_codebase_embeddings': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for query_codebase_embeddings.");
            }
            const { query_text, top_k, target_file_paths, exclude_chunk_types } = args;
            const embeddingService = memoryManager.getCodebaseEmbeddingService();

            try {
                let results: CodeChunkResult[] = await embeddingService.retrieveSimilarCodeChunks(
                    agent_id,
                    query_text,
                    top_k || 5,
                    target_file_paths,
                    exclude_chunk_types // Pass exclusion types to service
                );

                if (results.length === 0) {
                    return { content: [{ type: 'text', text: formatSimpleMessage(`No similar code chunks found for query: "${query_text}" (after filtering).`, "Embedding Query Results") }] };
                }

                let md = `## Similar Code Chunks for Query: "${query_text}" (Top ${results.length})\n\n`;
                results.forEach((res, index) => {
                    md += `### Result ${index + 1} (Score: ${res.score.toFixed(4)})\n`;
                    md += `- **File:** \`${res.file_path_relative}\`\n`;
                    if (res.entity_name) {
                        md += `- **Entity:** \`${res.entity_name}\`\n`;
                    }
                    if (res.metadata) {
                        try {
                            const metadata = res.metadata;
                            if (metadata.full_file_path) {
                                md += `- **Full Path:** \`${metadata.full_file_path}\`\n`;
                            }
                            if (metadata.startLine && metadata.endLine) {
                                md += `- **Lines:** ${metadata.startLine}-${metadata.endLine}\n`;
                            }
                            if (metadata.type) {
                                md += `- **Chunk Type:** ${metadata.type}\n`;
                            }
                        } catch (e) { /* ignore metadata access error */ }
                    }
                    if (res.metadata && res.metadata.type && res.metadata.type.endsWith('_summary')) {
                        md += `**Original Code Snippet:**\n${formatJsonToMarkdownCodeBlock(res.chunk_text, 'typescript')}\n`;
                        if (res.ai_summary_text) {
                            md += `**AI Summary:**\n${formatJsonToMarkdownCodeBlock(res.ai_summary_text, 'text')}\n`;
                        }
                    } else {
                        md += `**Content Snippet:**\n${formatJsonToMarkdownCodeBlock(res.chunk_text, 'text')}\n`;
                    }
                    md += `---\n`;
                });
                return { content: [{ type: 'text', text: md }] };

            } catch (error: any) {
                console.error(`Error querying codebase embeddings for agent ${agent_id}:`, error);
                throw new McpError(ErrorCode.InternalError, `Embedding query failed: ${error.message}`);
            }
        },
        'clean_up_embeddings': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for clean_up_embeddings.");
            }

            const validationResult = validate('cleanUpEmbeddings', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed for clean_up_embeddings: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }

            const { file_paths, project_root_path, filter_by_agent = true } = args; // Default to true
            const embeddingService = memoryManager.getCodebaseEmbeddingService();
            const vectorDb = memoryManager.getVectorDb(); // Get the DB instance
            console.log(`[CleanUpTool] Tool is using database at: ${(vectorDb as any).name}`); // Log the DB path, casting to any to bypass TS error

            // Normalize file paths to be relative to project root and use forward slashes
            const absoluteProjectRootPath = path.resolve(project_root_path);
const normalizedFilePaths = file_paths.map((fp: string) => {
    const absoluteFilePath = path.isAbsolute(fp) ? fp : path.resolve(absoluteProjectRootPath, fp);
    return path.relative(absoluteProjectRootPath, absoluteFilePath).replace(/\\/g, '/');
});

            try {
                const result: any = await embeddingService.cleanUpEmbeddingsByFilePaths(
                    agent_id,
                    normalizedFilePaths,
                    project_root_path,
                    filter_by_agent // Pass the new argument
                );
                return {
                    content: [{
                        type: 'text',
                        text: formatSimpleMessage(`Successfully deleted ${result.deletedCount} embeddings for the specified file paths.`, "Clean Up Embeddings Result")
                    }]
                };
            } catch (error: any) {
                console.error(`Error cleaning up embeddings for agent ${agent_id}:`, error);
                throw new McpError(ErrorCode.InternalError, `Embedding cleanup failed: ${error.message}`);
            }
        }
    };
}
