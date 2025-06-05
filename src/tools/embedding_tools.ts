// src/tools/embedding_tools.ts
import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate, schemas } from '../utils/validation.js';
import { formatSimpleMessage, formatJsonToMarkdownCodeBlock } from '../utils/formatters.js';
import { CodebaseEmbeddingService, ChunkingStrategy } from '../database/services/CodebaseEmbeddingService.js'; // Import the service
import fs from 'fs/promises'; // For checking if path exists
import path from 'path'; // For path operations

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
                }
            },
            required: ['agent_id', 'query_text'],
            additionalProperties: false,
        }
    }
];

export function getEmbeddingToolHandlers(memoryManager: MemoryManager) {
    // CodebaseEmbeddingService is already instantiated in MemoryManager and accessible via a getter
    // const codebaseEmbeddingService = memoryManager.getCodebaseEmbeddingService();

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

            const { path_to_embed, project_root_path, is_directory, chunking_strategy } = args;

            // Ensure project_root_path is absolute for reliable relative path calculation
            const absoluteProjectRootPath = path.resolve(project_root_path);
            const absolutePathToEmbed = path.resolve(path_to_embed);


            if (!absolutePathToEmbed.startsWith(absoluteProjectRootPath)) {
                throw new McpError(ErrorCode.InvalidParams, `Path to embed (${absolutePathToEmbed}) must be within the project root path (${absoluteProjectRootPath}).`);
            }


            try {
                await fs.access(absolutePathToEmbed); // Check if path exists
            } catch (e) {
                throw new McpError(ErrorCode.InvalidParams, `Path not found or inaccessible: ${absolutePathToEmbed}`);
            }

            const embeddingService = memoryManager.getCodebaseEmbeddingService();

            let resultCounts: { newEmbeddingsCount: number; reusedEmbeddingsCount: number; deletedEmbeddingsCount: number; };

            if (is_directory) {
                resultCounts = await embeddingService.generateAndStoreEmbeddingsForDirectory(
                    agent_id,
                    absolutePathToEmbed,
                    absoluteProjectRootPath, // Pass the validated absolute project root
                    chunking_strategy as ChunkingStrategy
                );
            } else {
                resultCounts = await embeddingService.generateAndStoreEmbeddingsForFile(
                    agent_id,
                    absolutePathToEmbed,
                    absoluteProjectRootPath, // Pass the validated absolute project root
                    chunking_strategy as ChunkingStrategy
                );
            }

            return {
                content: [{
                    type: 'text', text: formatSimpleMessage(
                        `Codebase embedding ingestion for "${path_to_embed}" (relative to project root: "${path.relative(absoluteProjectRootPath, absolutePathToEmbed).replace(/\\/g, '/')}") complete.\n- New Embeddings Created: ${resultCounts.newEmbeddingsCount}\n- Reused Existing Embeddings: ${resultCounts.reusedEmbeddingsCount}\n- Deleted Stale Embeddings: ${resultCounts.deletedEmbeddingsCount}`,
                        "Codebase Embedding Ingestion Report"
                    )
                }]
            };
        },
        'query_codebase_embeddings': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for query_codebase_embeddings.");
            }
            // No specific schema in `schemas` object yet for this, so inline or add to `schemas`
            // For now, assuming basic validation or direct use of args.

            const { query_text, top_k, target_file_paths } = args;
            const embeddingService = memoryManager.getCodebaseEmbeddingService();

            try {
                const results = await embeddingService.retrieveSimilarCodeChunks(
                    agent_id,
                    query_text,
                    top_k || 5,
                    target_file_paths
                );

                if (results.length === 0) {
                    return { content: [{ type: 'text', text: formatSimpleMessage(`No similar code chunks found for query: "${query_text}"`, "Embedding Query Results") }] };
                }

                let md = `## Similar Code Chunks for Query: "${query_text}" (Top ${results.length})\n\n`;
                results.forEach((res, index) => {
                    md += `### Result ${index + 1} (Score: ${res.score.toFixed(4)})\n`;
                    md += `- **File:** \`${res.file_path_relative}\`\n`;
                    if (res.entity_name) {
                        md += `- **Entity:** \`${res.entity_name}\`\n`;
                    }
                    if (res.metadata_json) {
                        try {
                            const metadata = JSON.parse(res.metadata_json);
                            if (metadata.startLine && metadata.endLine) {
                                md += `- **Lines:** ${metadata.startLine}-${metadata.endLine}\n`;
                            }
                            if (metadata.type) {
                                md += `- **Chunk Type:** ${metadata.type}\n`;
                            }
                        } catch (e) { /* ignore metadata parsing error */ }
                    }
                    md += `**Content Snippet:**\n${formatJsonToMarkdownCodeBlock(res.chunk_text, 'text')}\n---\n`;
                });
                return { content: [{ type: 'text', text: md }] };

            } catch (error: any) {
                console.error(`Error querying codebase embeddings for agent ${agent_id}:`, error);
                throw new McpError(ErrorCode.InternalError, `Embedding query failed: ${error.message}`);
            }
        }
    };
}
