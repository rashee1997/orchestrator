import fs from 'fs/promises';
import path from 'path';

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { MemoryManager } from '../database/memory_manager.js';
import { CodebaseEmbeddingService } from '../database/services/CodebaseEmbeddingService.js';
import { ChunkingStrategy } from '../types/codebase_embeddings.js';
import { formatJsonToMarkdownCodeBlock, formatSimpleMessage } from '../utils/formatters.js';
import { schemas, validate } from '../utils/validation.js';

// Define the interface for the chunk result, including the new original_code_snippet
interface CodeChunkResult {
    chunk_text: string; // Now always contains the original code
    ai_summary_text?: string | null; // New: Contains the AI-generated summary
    file_path_relative: string;
    entity_name: string | null;
    score: number;
    metadata?: Record<string, any> | null;
}

const queryCodebaseEmbeddingsSchema = {
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
};

const cleanUpEmbeddingsSchema = {
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
};

export const embeddingToolDefinitions = [
    {
        name: 'ingest_codebase_embeddings',
        description: `Scans a specified file or directory, chunks its content based on the chosen strategy, generates vector embeddings for each chunk using Gemini, and stores them in the dedicated vector store. Requires 'project_root_path' to correctly calculate relative paths for stored embeddings. Output is Markdown formatted.`,
        inputSchema: schemas.ingestCodebaseEmbeddings,
    },
    {
        name: 'query_codebase_embeddings',
        description: `Retrieves code chunks from the vector store that are semantically similar to a given query text. Output is Markdown formatted.`,
        inputSchema: queryCodebaseEmbeddingsSchema,
    },
    {
        name: 'clean_up_embeddings',
        description: `Removes and cleans up embeddings from the vector database based on specified file paths. Returns a summary of deleted embeddings.`,
        inputSchema: cleanUpEmbeddingsSchema
    }
];

/**
 * Generates a concise AI summary for a list of code chunks.
 * @param memoryManager - The memory manager instance to get the Gemini service.
 * @param chunks - The array of code chunks to summarize.
 * @param summaryType - The type of summary ('new', 'reused', 'deleted'), which determines the prompt.
 * @returns A formatted markdown string with the summary, or an empty string if no chunks are provided.
 */
async function _generateAiSummary(
    memoryManager: MemoryManager,
    chunks: Array<{ file_path_relative: string; chunk_text: string }> | undefined,
    summaryType: 'new' | 'reused' | 'deleted'
): Promise<string> {
    if (!chunks || chunks.length === 0) {
        return '';
    }

    const promptTemplates = {
        new: `You are an expert software engineer. Summarize the key changes and additions in the following newly added code chunks. Provide a concise, clear summary suitable for a development team review. Limit to 300 tokens.`,
        reused: `You are an expert software engineer. Summarize the context and significance of the following reused code chunks. Provide a concise, clear summary suitable for a development team review. Limit to 300 tokens.`,
        deleted: `You are an expert software engineer. Summarize the impact and reasons for deletion of the following code chunks. Provide a concise, clear summary suitable for a development team review. Limit to 300 tokens.`
    };

    const titles = {
        new: 'New Embeddings Summary',
        reused: 'Reused Embeddings Summary',
        deleted: 'Deleted Embeddings Summary'
    };

    const combinedChunksText = chunks.map(chunk => chunk.chunk_text).join('\n\n');
    let summaryText = `(AI summary could not be generated for ${summaryType} chunks.)`;

    try {
        const geminiService = memoryManager.getGeminiIntegrationService();
        if (geminiService) {
            const prompt = `${promptTemplates[summaryType]}\n\n${combinedChunksText}`;
            const response = await geminiService.askGemini(prompt);
            if (response?.content && Array.isArray(response.content)) {
                summaryText = response.content.map(part => part.text).join('').trim();
            }
        }
    } catch (e) {
        console.warn(`AI summarizer failed for ${summaryType} embeddings summary:`, e);
    }

    return `\n### ${titles[summaryType]}:\n${summaryText}\n`;
}

export function getEmbeddingToolHandlers(memoryManager: MemoryManager) {
    return {
        'ingest_codebase_embeddings': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for ingest_codebase_embeddings.");
            }

            const validationResult = validate('ingestCodebaseEmbeddings', args);
            if (!validationResult.valid) {
                const errorDetails = formatJsonToMarkdownCodeBlock(validationResult.errors);
                throw new McpError(ErrorCode.InvalidParams, `Validation failed for ingest_codebase_embeddings: ${errorDetails}`);
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

            const resultCounts = is_directory
                ? await embeddingService.generateAndStoreEmbeddingsForDirectory(agent_id, absolutePathToEmbed, absoluteProjectRootPath, chunking_strategy as ChunkingStrategy, include_summary_patterns, exclude_summary_patterns, storeEntitySummaries)
                : await embeddingService.generateAndStoreEmbeddingsForFile(agent_id, absolutePathToEmbed, absoluteProjectRootPath, chunking_strategy as ChunkingStrategy, include_summary_patterns, exclude_summary_patterns, storeEntitySummaries);

            if (!is_directory) {
                await embeddingService.embeddingCache.flushToDb(); // Ensure flush after single file ingestion
            }

            const relativePathToEmbed = path.relative(absoluteProjectRootPath, absolutePathToEmbed).replace(/\\/g, '/');
            const outputLines = [
                `Codebase embedding ingestion for "${path_to_embed}" (relative to project root: "${relativePathToEmbed}") complete.`,
                `- New Embeddings Created: ${resultCounts.newEmbeddingsCount}`,
                `- Reused Existing Embeddings: ${resultCounts.reusedEmbeddingsCount}`,
                `- Deleted Stale Embeddings: ${resultCounts.deletedEmbeddingsCount}`,
            ];

            if (resultCounts.embeddingRequestCount !== undefined) outputLines.push(`- Embedding API Requests: ${resultCounts.embeddingRequestCount}`);
            if (resultCounts.embeddingRetryCount !== undefined) outputLines.push(`- Embedding API Retries: ${resultCounts.embeddingRetryCount}`);
            if (resultCounts.namingApiCallCount !== undefined) outputLines.push(`- Naming API Calls: ${resultCounts.namingApiCallCount}`);
            if (resultCounts.summarizationApiCallCount !== undefined) outputLines.push(`- Summarization API Calls: ${resultCounts.summarizationApiCallCount}`);
            if (resultCounts.dbCallCount !== undefined) outputLines.push(`- Database Call Count (for existing hashes/summaries): ${resultCounts.dbCallCount}`);
            if (resultCounts.dbCallLatencyMs !== undefined) {
                const dbCallLatencySeconds = (resultCounts.dbCallLatencyMs / 1000).toFixed(2);
                outputLines.push(`- Database Call Latency (for existing hashes/summaries): ${dbCallLatencySeconds} seconds`);
            }
            if (resultCounts.totalTimeMs !== undefined) {
                const totalTimeMinutes = (resultCounts.totalTimeMs / 60000).toFixed(2);
                outputLines.push(`- Total Time Taken: ${totalTimeMinutes} minutes`);
            }

            let detailedOutput = outputLines.join('\n');

            if (!disable_ai_output_summary) {
                detailedOutput += await _generateAiSummary(memoryManager, resultCounts.newEmbeddings, 'new');
                detailedOutput += await _generateAiSummary(memoryManager, resultCounts.reusedEmbeddings, 'reused');
                detailedOutput += await _generateAiSummary(memoryManager, resultCounts.deletedEmbeddings, 'deleted');
            }

            return { content: [{ type: 'text', text: detailedOutput }] };
        },

        'query_codebase_embeddings': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for query_codebase_embeddings.");
            }
            const { query_text, top_k, target_file_paths, exclude_chunk_types } = args;
            const embeddingService = memoryManager.getCodebaseEmbeddingService();

            try {
                const results: CodeChunkResult[] = await embeddingService.retrieveSimilarCodeChunks(
                    agent_id,
                    query_text,
                    top_k || 5,
                    target_file_paths,
                    exclude_chunk_types
                );

                if (results.length === 0) {
                    const message = formatSimpleMessage(`No similar code chunks found for query: "${query_text}" (after filtering).`, "Embedding Query Results");
                    return { content: [{ type: 'text', text: message }] };
                }

                const resultMarkdown = results.map((res, index) => {
                    const metadataLines = [
                        `- **File:** \`${res.file_path_relative}\``,
                        res.entity_name && `- **Entity:** \`${res.entity_name}\``,
                        res.metadata?.full_file_path && `- **Full Path:** \`${res.metadata.full_file_path}\``,
                        (res.metadata?.startLine && res.metadata?.endLine) && `- **Lines:** ${res.metadata.startLine}-${res.metadata.endLine}`,
                        res.metadata?.type && `- **Chunk Type:** ${res.metadata.type}`
                    ].filter(Boolean).join('\n');

                    let contentBlock;
                    if (res.metadata?.type?.endsWith('_summary')) {
                        const originalCode = `**Original Code Snippet:**\n${formatJsonToMarkdownCodeBlock(res.chunk_text, 'typescript')}`;
                        const aiSummary = res.ai_summary_text ? `\n**AI Summary:**\n${formatJsonToMarkdownCodeBlock(res.ai_summary_text, 'text')}` : '';
                        contentBlock = `${originalCode}${aiSummary}\n`;
                    } else {
                        contentBlock = `**Content Snippet:**\n${formatJsonToMarkdownCodeBlock(res.chunk_text, 'text')}\n`;
                    }

                    return `### Result ${index + 1} (Score: ${res.score.toFixed(4)})\n${metadataLines}\n${contentBlock}`;
                }).join('---\n');

                const finalMarkdown = `## Similar Code Chunks for Query: "${query_text}" (Top ${results.length})\n\n${resultMarkdown}`;
                return { content: [{ type: 'text', text: finalMarkdown }] };

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
                const errorDetails = formatJsonToMarkdownCodeBlock(validationResult.errors);
                throw new McpError(ErrorCode.InvalidParams, `Validation failed for clean_up_embeddings: ${errorDetails}`);
            }

            const { file_paths, project_root_path, filter_by_agent = true } = args;
            const embeddingService = memoryManager.getCodebaseEmbeddingService();

            const absoluteProjectRootPath = path.resolve(project_root_path);

            // Normalize all provided file paths to be relative to the project root and use forward slashes.
            // This ensures consistency when querying the database.
            const normalizedFilePaths = file_paths.map((fp: string) => {
                // Resolve the full, absolute path of the file.
                const absoluteFilePath = path.isAbsolute(fp)
                    ? fp
                    : path.resolve(absoluteProjectRootPath, fp);
                // Get the path relative to the project root.
                const relativePath = path.relative(absoluteProjectRootPath, absoluteFilePath);
                // Convert backslashes to forward slashes for OS-independent consistency.
                return relativePath.replace(/\\/g, '/');
            });

            try {
                const result = await embeddingService.cleanUpEmbeddingsByFilePaths(
                    agent_id,
                    normalizedFilePaths,
                    project_root_path,
                    filter_by_agent
                );
                const message = formatSimpleMessage(`Successfully deleted ${result.deletedCount} embeddings for the specified file paths.`, "Clean Up Embeddings Result");
                return { content: [{ type: 'text', text: message }] };
            } catch (error: any) {
                console.error(`Error cleaning up embeddings for agent ${agent_id}:`, error);
                throw new McpError(ErrorCode.InternalError, `Embedding cleanup failed: ${error.message}`);
            }
        }
    };
}