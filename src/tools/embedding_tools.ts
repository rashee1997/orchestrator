import fs from 'fs/promises';
import path from 'path';

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { MemoryManager } from '../database/memory_manager.js';
import { EmbeddingIngestionResult, ChunkingStrategy } from '../types/codebase_embeddings.js';
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
 * Generates a single, holistic AI summary of all changes in the ingestion process.
 * This version programmatically detects refactors before asking the AI to summarize.
 * @param memoryManager The memory manager instance.
 * @param resultCounts The full result object from the ingestion service.
 * @returns A formatted markdown string with the unified summary, or an empty string.
 */
async function _generateUnifiedAiSummary(
    memoryManager: MemoryManager,
    resultCounts: EmbeddingIngestionResult
): Promise<string> {
    const { newEmbeddings, reusedEmbeddings, deletedEmbeddings } = resultCounts;

    if (newEmbeddings.length === 0 && reusedEmbeddings.length === 0 && deletedEmbeddings.length === 0) {
        return '';
    }

    // --- Programmatic Refactor Detection ---
    const fileChanges = new Map<string, { added: Set<string>, removed: Set<string> }>();

    // Collate added and removed entities by file
    newEmbeddings.forEach(e => {
        if (!e.entity_name) return;
        const file = fileChanges.get(e.file_path_relative) || { added: new Set(), removed: new Set() };
        file.added.add(e.entity_name);
        fileChanges.set(e.file_path_relative, file);
    });
    deletedEmbeddings.forEach(e => {
        if (!e.entity_name) return;
        const file = fileChanges.get(e.file_path_relative) || { added: new Set(), removed: new Set() };
        file.removed.add(e.entity_name);
        fileChanges.set(e.file_path_relative, file);
    });

    const refactoredEntities = new Set<string>(); // Stores unique identifier 'filePath::entityName'
    for (const [filePath, changes] of fileChanges.entries()) {
        const intersection = new Set([...changes.added].filter(entity => changes.removed.has(entity)));
        intersection.forEach(entityName => refactoredEntities.add(`${filePath}::${entityName}`));
    }

    // Filter the original lists to create the final categories
    const trulyNew = newEmbeddings.filter(e => !refactoredEntities.has(`${e.file_path_relative}::${e.entity_name}`));
    const trulyDeleted = deletedEmbeddings.filter(e => !refactoredEntities.has(`${e.file_path_relative}::${e.entity_name}`));
    const refactored = newEmbeddings.filter(e => refactoredEntities.has(`${e.file_path_relative}::${e.entity_name}`));


    // Helper to format a list of changes for the prompt
    const formatChangeList = (chunks: typeof newEmbeddings) => {
        if (!chunks || chunks.length === 0) return "  - None\n";
        const MAX_ITEMS_PER_SECTION = 50;

        const groupedByFile = chunks.slice(0, MAX_ITEMS_PER_SECTION).reduce((acc, chunk) => {
            const key = chunk.file_path_relative;
            if (!acc[key]) acc[key] = [];
            if (chunk.entity_name) acc[key].push(chunk.entity_name);
            return acc;
        }, {} as Record<string, string[]>);

        let list = Object.entries(groupedByFile).map(([filePath, entities]) => {
            let fileEntry = `  - File: \`${filePath}\``;
            if (entities.length > 0) {
                fileEntry += ` (Entities: ${entities.map(e => `\`${e}\``).join(', ')})`;
            }
            return fileEntry;
        }).join('\n');

        if (chunks.length > MAX_ITEMS_PER_SECTION) {
            list += `\n  - ...and ${chunks.length - MAX_ITEMS_PER_SECTION} more items.`;
        }
        return list;
    };

    // Create the final, structured changelog for the AI
    const changelog = `
**Refactored Entities (Modified or Replaced):**
${formatChangeList(refactored)}

**Newly Added Entities:**
${formatChangeList(trulyNew)}

**Removed Entities:**
${formatChangeList(trulyDeleted)}

**Reused Unchanged Entities:**
${formatChangeList(reusedEmbeddings)}
`;

    const prompt = `You are a Senior Technical Lead writing a concise, high-level summary for a pull request. Your task is to analyze the following structured changelog which details changes to a codebase's semantic index.

Synthesize all sections to understand the full picture. Pay close attention to the 'Refactored' section, which indicates code that was modified. Your summary should be brief, written in markdown, and focus on the overall impact of the changes.

**Changelog:**
${changelog}
`;

    let summaryText = `(AI summary could not be generated.)`;
    try {
        const geminiService = memoryManager.getGeminiIntegrationService();
        if (geminiService) {
            const response = await geminiService.askGemini(prompt, 'gemini-2.5-flash');
            if (response?.content?.[0]?.text) {
                summaryText = response.content[0].text.trim();
            }
        }
    } catch (e) {
        console.warn(`Unified AI summarizer failed:`, e);
    }

    return `\n### AI Change Summary:\n${summaryText}\n`;
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

            const { path_to_embed, paths_to_embed, project_root_path, is_directory, chunking_strategy, disable_ai_output_summary, include_summary_patterns, exclude_summary_patterns, storeEntitySummaries } = args;
            const embeddingService = memoryManager.getCodebaseEmbeddingService();
            const absoluteProjectRootPath = path.resolve(project_root_path);
            let resultCounts: EmbeddingIngestionResult;
            let outputMessage: string;

            if (paths_to_embed && paths_to_embed.length > 0) {
                const normalizedPaths = paths_to_embed.map((fp: string) => {
                    const absoluteFilePath = path.isAbsolute(fp)
                        ? fp
                        : path.resolve(absoluteProjectRootPath, fp);
                    if (!absoluteFilePath.startsWith(absoluteProjectRootPath)) {
                        console.warn(`Skipped path outside project root: ${fp}`);
                        return null;
                    }
                    const relativePath = path.relative(absoluteProjectRootPath, absoluteFilePath).replace(/\\/g, '/');
                    return relativePath;
                }).filter(Boolean) as string[];
                if (normalizedPaths.length === 0) {
                    throw new McpError(ErrorCode.InvalidParams, `No valid file paths to embed within project root (${absoluteProjectRootPath}).`);
                }
                resultCounts = await embeddingService.generateAndStoreEmbeddingsForMultipleFiles(
                    agent_id,
                    normalizedPaths,
                    absoluteProjectRootPath,
                    chunking_strategy as ChunkingStrategy,
                    include_summary_patterns,
                    exclude_summary_patterns,
                    storeEntitySummaries
                );
                outputMessage = `Codebase embedding ingestion for ${normalizedPaths.length} specified files complete.`;

            } else if (path_to_embed) {
                const absolutePathToEmbed = path.resolve(absoluteProjectRootPath, path_to_embed);

                if (!absolutePathToEmbed.startsWith(absoluteProjectRootPath)) {
                    throw new McpError(ErrorCode.InvalidParams, `Path to embed (${absolutePathToEmbed}) must be within the project root path (${absoluteProjectRootPath}).`);
                }
                try {
                    await fs.access(absolutePathToEmbed);
                } catch (e) {
                    throw new McpError(ErrorCode.InvalidParams, `Path not found or inaccessible: ${absolutePathToEmbed}`);
                }

                if (is_directory) {
                    resultCounts = await embeddingService.generateAndStoreEmbeddingsForDirectory(agent_id, absolutePathToEmbed, absoluteProjectRootPath, chunking_strategy as ChunkingStrategy, include_summary_patterns, exclude_summary_patterns, storeEntitySummaries);
                } else {
                    resultCounts = await embeddingService.generateAndStoreEmbeddingsForFile(agent_id, absolutePathToEmbed, absoluteProjectRootPath, chunking_strategy as ChunkingStrategy, include_summary_patterns, exclude_summary_patterns, storeEntitySummaries);
                }
                const relativePathToEmbed = path.relative(absoluteProjectRootPath, absolutePathToEmbed).replace(/\\/g, '/');
                outputMessage = `Codebase embedding ingestion for "${path_to_embed}" (relative to project root: "${relativePathToEmbed}") complete.`;
            } else {
                throw new McpError(ErrorCode.InvalidParams, "Either 'path_to_embed' or 'paths_to_embed' must be provided.");
            }


            let detailedOutput = `## Ingestion Summary\n${outputMessage}\n\n### Overall Statistics:\n`
                + `- **New Embeddings Created:** ${resultCounts.newEmbeddingsCount}\n`
                + `- **Reused Existing Embeddings:** ${resultCounts.reusedEmbeddingsCount}\n`
                + `- **Deleted Stale Embeddings:** ${resultCounts.deletedEmbeddingsCount}\n`;

            const fileStats = new Map<string, { new: number; reused: number; deleted: number }>();
            const aggregate = (list: typeof resultCounts.newEmbeddings, type: 'new' | 'reused' | 'deleted') => {
                if (!list) return;
                for (const item of list) {
                    const stats = fileStats.get(item.file_path_relative) || { new: 0, reused: 0, deleted: 0 };
                    stats[type]++;
                    fileStats.set(item.file_path_relative, stats);
                }
            };

            aggregate(resultCounts.newEmbeddings, 'new');
            aggregate(resultCounts.reusedEmbeddings, 'reused');
            aggregate(resultCounts.deletedEmbeddings, 'deleted');

            if (fileStats.size > 0) {
                detailedOutput += `\n### File-by-File Ingestion Report (${fileStats.size} files processed):\n`;
                const sortedFiles = Array.from(fileStats.keys()).sort();

                sortedFiles.forEach(filePath => {
                    const counts = fileStats.get(filePath)!;
                    detailedOutput += `- \`${filePath}\` (New: ${counts.new}, Reused: ${counts.reused}, Deleted: ${counts.deleted})\n`;
                });
            }

            detailedOutput += `\n### Performance Metrics:\n`;
            if (resultCounts.embeddingRequestCount !== undefined) detailedOutput += `- **Embedding API Requests:** ${resultCounts.embeddingRequestCount}\n`;
            if (resultCounts.embeddingRetryCount !== undefined) detailedOutput += `- **Embedding API Retries:** ${resultCounts.embeddingRetryCount}\n`;
            if (resultCounts.namingApiCallCount !== undefined) detailedOutput += `- **Naming API Calls:** ${resultCounts.namingApiCallCount}\n`;
            if (resultCounts.summarizationApiCallCount !== undefined) detailedOutput += `- **Summarization API Calls:** ${resultCounts.summarizationApiCallCount}\n`;
            if (resultCounts.dbCallCount !== undefined) detailedOutput += `- **Database Call Count:** ${resultCounts.dbCallCount}\n`;
            if (resultCounts.dbCallLatencyMs !== undefined) {
                const dbCallLatencySeconds = (resultCounts.dbCallLatencyMs / 1000).toFixed(2);
                detailedOutput += `- **Database Call Latency:** ${dbCallLatencySeconds} seconds\n`;
            }
            if (resultCounts.totalTokensProcessed !== undefined) {
                detailedOutput += `- **Tokens Processed (est.):** ${resultCounts.totalTokensProcessed}\n`;
            }
            if (resultCounts.totalTimeMs !== undefined) {
                const totalTimeSeconds = (resultCounts.totalTimeMs / 1000).toFixed(2);
                detailedOutput += `- **Total Time Taken:** ${totalTimeSeconds} seconds\n`;
            }

            if (!disable_ai_output_summary) {
                const unifiedSummary = await _generateUnifiedAiSummary(memoryManager, resultCounts);
                detailedOutput += unifiedSummary;
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

            const normalizedFilePaths = file_paths.map((fp: string) => {
                const absoluteFilePath = path.isAbsolute(fp)
                    ? fp
                    : path.resolve(absoluteProjectRootPath, fp);
                if (!absoluteFilePath.startsWith(absoluteProjectRootPath)) {
                    throw new McpError(ErrorCode.InvalidParams, `File path to clean up (${fp}) must be within the project root path (${project_root_path}).`);
                }
                const relativePath = path.relative(absoluteProjectRootPath, absoluteFilePath);
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