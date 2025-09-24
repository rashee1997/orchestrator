import fs from 'fs/promises';
import path from 'path';

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { MemoryManager } from '../database/memory_manager.js';
import { EmbeddingIngestionResult, ChunkingStrategy } from '../types/codebase_embeddings.js';
import { formatJsonToMarkdownCodeBlock, formatSimpleMessage } from '../utils/formatters.js';
import { schemas, validate } from '../utils/validation.js';
import { DiverseQueryRewriterService } from './rag/diverse_query_rewriter_service.js';
import { getCurrentModel } from '../database/services/gemini-integration-modules/GeminiConfig.js';
import { GitService } from '../utils/GitService.js';

// Define the interface for the chunk result, including the new original_code_snippet
interface CodeChunkResult {
    chunk_text: string; // Now always contains the original code
    ai_summary_text?: string | null; // New: Contains the AI-generated summary
    file_path_relative: string;
    entity_name: string | null;
    score: number;
    metadata?: Record<string, any> | null;
}

const MAX_DIFF_LINES = 80;
const MAX_DIFF_CHARACTERS = 4000;

type DiffProvider = (relativePath: string) => string | null;

interface GitDiffProviderOptions {
    baseCommit?: string | null;
    headCommit?: string | null;
}

function createGitDiffProvider(projectRootPath?: string, options?: GitDiffProviderOptions): DiffProvider | null {
    if (!projectRootPath) {
        return null;
    }

    try {
        const gitService = new GitService(projectRootPath);
        const cache = new Map<string, string | null>();

        const fetchDiff = (relativePath: string, staged: boolean): string => {
            if (options?.baseCommit !== undefined || options?.headCommit !== undefined) {
                const baseRef = options.baseCommit ?? null;
                const headRef = options.headCommit ?? 'HEAD';
                return gitService.getDiffBetweenRefs(baseRef, headRef, [relativePath], 3).trim();
            }

            const diffOptions = staged
                ? { staged: true as const, files: [relativePath], unified: 3 }
                : { files: [relativePath], unified: 3 };

            return gitService.getDiffOutput(diffOptions).trim();
        };

        const trimDiffOutput = (diff: string): string => {
            if (!diff) {
                return diff;
            }

            const lines = diff.split('\n');
            let trimmed = diff;

            // Enhanced diff processing - preserve important context
            if (lines.length > MAX_DIFF_LINES) {
                // Keep the header and important context lines
                const headerLines = lines.slice(0, 5); // Keep diff header
                const contentLines = lines.slice(5);
                const importantLines = contentLines.filter(line =>
                    line.startsWith('+') || line.startsWith('-') ||
                    line.includes('interface') || line.includes('function') ||
                    line.includes('class') || line.includes('export')
                );

                const truncatedLines = [
                    ...headerLines,
                    ...importantLines.slice(0, MAX_DIFF_LINES - 10)
                ];
                truncatedLines.push(`... (+${lines.length - truncatedLines.length} more lines - showing key changes only)`);
                trimmed = truncatedLines.join('\n');
            }

            if (trimmed.length > MAX_DIFF_CHARACTERS) {
                // Try to cut at a logical boundary
                const cutPoint = trimmed.lastIndexOf('\n', MAX_DIFF_CHARACTERS);
                trimmed = trimmed.slice(0, cutPoint > 0 ? cutPoint : MAX_DIFF_CHARACTERS) +
                         '\n... (diff truncated - showing most important changes)';
            }

            return trimmed;
        };

        return (relativePath: string): string | null => {
            if (cache.has(relativePath)) {
                return cache.get(relativePath)!;
            }

            try {
                let combined = '';

                if (options?.baseCommit !== undefined || options?.headCommit !== undefined) {
                    const commitDiff = trimDiffOutput(fetchDiff(relativePath, false));
                    combined = commitDiff ? commitDiff : '';
                } else {
                    const stagedDiff = trimDiffOutput(fetchDiff(relativePath, true));
                    const unstagedDiff = trimDiffOutput(fetchDiff(relativePath, false));

                    const sections: string[] = [];
                    if (stagedDiff) {
                        sections.push(`--- staged\n${stagedDiff}`);
                    }
                    if (unstagedDiff && unstagedDiff !== stagedDiff) {
                        sections.push(`--- unstaged\n${unstagedDiff}`);
                    }
                    combined = sections.join('\n\n');
                }
                const result = combined || null;
                cache.set(relativePath, result);
                return result;
            } catch (error) {
                console.warn(`[Embedding Tools] Unable to retrieve git diff for ${relativePath}:`, error);
                cache.set(relativePath, null);
                return null;
            }
        };
    } catch (error) {
        console.warn('[Embedding Tools] Git diff provider unavailable:', error);
        return null;
    }
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
        },
        enable_dmqr: {
            type: 'boolean',
            description: 'Enable Diverse Multi-Query Rewriting (DMQR) for the embedding query.',
            default: false
        },
        dmqr_query_count: {
            type: 'number',
            description: 'The number of diverse queries to generate for DMQR.',
            default: 3,
            minimum: 2,
            maximum: 5
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
    resultCounts: EmbeddingIngestionResult,
    projectRootPath?: string
): Promise<string> {
    const { newEmbeddings, reusedEmbeddings, deletedEmbeddings } = resultCounts;

    // Enhanced validation: Only generate AI summary when there are ACTUAL changes
    const hasActualChanges = (
        newEmbeddings.length > 0 ||
        deletedEmbeddings.length > 0
    );

    const hasCommitChanges = resultCounts.commitMetadata &&
        resultCounts.commitMetadata.currentCommit &&
        resultCounts.commitMetadata.previousCommit &&
        resultCounts.commitMetadata.currentCommit !== resultCounts.commitMetadata.previousCommit;

    const hasUncommittedChanges = projectRootPath && (() => {
        try {
            // Use dynamic import since we're already inside the module
            const gitService = new (require('../utils/GitService.js').GitService)(projectRootPath);

            // Check for any working directory changes
            const diffOutput = gitService.getDiffOutput({ unified: 0 });
            const stagedOutput = gitService.getDiffOutput({ staged: true, unified: 0 });

            return diffOutput.trim().length > 0 || stagedOutput.trim().length > 0;
        } catch (error: any) {
            console.warn('[AI Summary] Could not check git changes:', error?.message || error);
            return false;
        }
    })();

    // Additional validation: Check if any changed files actually have git diffs
    let hasActualFileChanges = false;
    if (hasActualChanges && projectRootPath) {
        const changedFiles = new Set([
            ...newEmbeddings.map(e => e.file_path_relative),
            ...deletedEmbeddings.map(e => e.file_path_relative)
        ]);

        // Create a diff provider to check if files actually have changes
        const tempDiffProvider = createGitDiffProvider(
            projectRootPath,
            resultCounts.commitMetadata ? {
                baseCommit: resultCounts.commitMetadata.previousCommit ?? null,
                headCommit: resultCounts.commitMetadata.currentCommit ?? undefined
            } : undefined
        );

        if (tempDiffProvider) {
            for (const filePath of changedFiles) {
                const diff = tempDiffProvider(filePath);
                if (diff && diff.trim().length > 0) {
                    hasActualFileChanges = true;
                    break;
                }
            }
        } else {
            // If no diff provider, assume changes are valid (fallback)
            hasActualFileChanges = hasActualChanges;
        }
    } else {
        hasActualFileChanges = hasActualChanges;
    }

    // Only generate summary if we have actual file changes AND (commit changes OR working directory changes)
    if (!hasActualFileChanges || (!hasCommitChanges && !hasUncommittedChanges)) {
        console.log('[AI Summary] Skipping AI summary - no meaningful changes detected', {
            hasActualChanges,
            hasActualFileChanges,
            hasCommitChanges,
            hasUncommittedChanges,
            newCount: newEmbeddings.length,
            deletedCount: deletedEmbeddings.length,
            reusedCount: reusedEmbeddings.length
        });
        return '';
    }

    console.log('[AI Summary] Generating AI summary for meaningful changes', {
        newEmbeddings: newEmbeddings.length,
        deletedEmbeddings: deletedEmbeddings.length,
        hasCommitChanges,
        hasUncommittedChanges
    });

    const commitMetadata = resultCounts.commitMetadata;
    const diffProvider = createGitDiffProvider(
        projectRootPath,
        commitMetadata ? {
            baseCommit: commitMetadata.previousCommit ?? null,
            headCommit: commitMetadata.currentCommit ?? undefined
        } : undefined
    );

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
        const MAX_ITEMS_PER_SECTION = 20; // Reduced to show chunk content

        const groupedByFile = chunks.slice(0, MAX_ITEMS_PER_SECTION).reduce((acc, chunk) => {
            const key = chunk.file_path_relative;
            if (!acc[key]) acc[key] = [];
            acc[key].push({
                entity_name: chunk.entity_name || null,
                chunk_preview: chunk.chunk_text
            });
            return acc;
        }, {} as Record<string, Array<{ entity_name: string | null; chunk_preview: string }>>);

        let list = Object.entries(groupedByFile).map(([filePath, chunks]) => {
            const gitDiff = diffProvider ? diffProvider(filePath) : null;

            if (gitDiff) {
                // Enhanced git diff formatting for better AI analysis
                return `\n📄 **FILE: \`${filePath}\`**\n` +
                       `🔍 **GIT DIFF ANALYSIS:**\n` +
                       `\`\`\`diff\n${gitDiff}\n\`\`\`\n` +
                       `⚡ **KEY CHANGES:** Analyze the +/- lines above to identify new interfaces, functions, fields, and logic.\n`;
            } else {
                // Fallback to chunk analysis when no git diff available
                let fileEntry = `\n📄 **FILE: \`${filePath}\`** (no git diff available)\n`;
                const MAX_CHUNK_PREVIEW = 200; // Increased for better context
                chunks.forEach(chunk => {
                    const chunkPreview = chunk.chunk_preview.length > MAX_CHUNK_PREVIEW
                        ? chunk.chunk_preview.substring(0, MAX_CHUNK_PREVIEW) + '...'
                        : chunk.chunk_preview;
                    const entityInfo = chunk.entity_name ? `\`${chunk.entity_name}\`` : 'code block';
                    fileEntry += `   🔹 **${entityInfo}:** ${chunkPreview.replace(/\n/g, ' ').trim()}\n`;
                });
                return fileEntry;
            }
        }).join('\n');

        if (chunks.length > MAX_ITEMS_PER_SECTION) {
            list += `\n  - ...and ${chunks.length - MAX_ITEMS_PER_SECTION} more items.`;
        }
        return list;
    };

    // Create the final, structured changelog for the AI with enhanced formatting
    let contextInfo = '';
    if (resultCounts.batchMetadata) {
        contextInfo += `📦 **PROCESSING CONTEXT:**\n- Processed ${resultCounts.batchMetadata.totalFilesProcessed} files in ${resultCounts.batchMetadata.totalBatches} batches\n- Used automatic batching to prevent API rate limiting\n\n`;
    }

    if (commitMetadata?.currentCommit) {
        contextInfo += `🔗 **GIT CONTEXT:**\n- Repository: \`${commitMetadata.repositoryRoot}\`\n- Branch: \`${commitMetadata.branchName ?? 'unknown'}\`\n- Current Commit: \`${commitMetadata.currentCommit}\`\n`;
        if (commitMetadata.previousCommit) {
            contextInfo += `- Previous Commit: \`${commitMetadata.previousCommit}\`\n`;
        }
        contextInfo += '\n';
    }

    // Enhanced git diff emphasis
    const hasGitDiffs = diffProvider && (
        (trulyNew.length > 0 && diffProvider(trulyNew[0]?.file_path_relative)) ||
        (refactored.length > 0 && diffProvider(refactored[0]?.file_path_relative))
    );

    const analysisHeader = hasGitDiffs
        ? `🚨 **IMPORTANT: ANALYZE THE GIT DIFFS BELOW** 🚨\nThe code changes are shown in git diff format. Focus on the +/- lines to identify specific changes.\n\n`
        : `📋 **CODE ENTITY ANALYSIS** (no git diffs available)\nAnalyzing code entities since git diffs are not available.\n\n`;

    const changelog = `${contextInfo}${analysisHeader}🔄 **REFACTORED/MODIFIED ENTITIES:**
${formatChangeList(refactored)}

✨ **NEWLY ADDED ENTITIES:**
${formatChangeList(trulyNew)}

🗑️ **REMOVED ENTITIES:**
${formatChangeList(trulyDeleted)}

`;

    const prompt = `You are a Technical Lead analyzing SPECIFIC CODE CHANGES from git diffs. Your job is to read the git diff output and identify exactly what functionality was added, modified, or removed.

**CRITICAL: Focus on the git diff content below, not generic descriptions.**

**Analysis Instructions:**
1. **Read the git diffs carefully** - Look at the +/- lines to see what specific code was added/removed
2. **Identify new interfaces, functions, classes** - Mention specific names from the diffs
3. **Describe new features** - What new capabilities do the added lines provide?
4. **Note enhanced functionality** - What existing features were improved?
5. **Explain the technical improvements** - Better error handling, performance, validation, etc.

**Example of GOOD analysis:**
"Added retry logic with exponential backoff to TavilyApiService, enhanced WebSearchResult interface with snippet and relevance_score fields, and introduced SearchMetadata for tracking API performance metrics."

**Example of BAD analysis:**
"Enhanced error tracking for partial embedding failures and API interactions."

**CODE CHANGES TO ANALYZE:**
${changelog}

**Required Output:**
- Write 2-4 sentences maximum
- Mention specific interface names, function names, and new fields from the diffs
- Focus on what developers can now do that they couldn't before
- Be concrete and technical, not vague or generic
- If you see git diff blocks, analyze the +/- changes specifically

**Template to follow:**
"Added [specific new interfaces/functions] to [file], introduced [new capabilities like X, Y, Z], and enhanced [existing functionality] with [specific improvements]."
`;

    let summaryText = `(AI summary could not be generated.)`;
    try {
        // Try to use multi-model orchestrator first (prefers Mistral for simple analysis)
        const geminiService = memoryManager.getGeminiIntegrationService();
        if (geminiService) {
            try {
                // Import MultiModelOrchestrator dynamically to avoid circular dependencies
                const { MultiModelOrchestrator } = await import('../tools/rag/multi_model_orchestrator.js');
                const orchestrator = new MultiModelOrchestrator(memoryManager, geminiService);
                
                console.log('[Embedding Tools] Using multi-model orchestrator for AI summary generation');
                const result = await orchestrator.executeTask(
                    'simple_analysis', // Prefers Mistral for simple analysis tasks
                    prompt,
                    'You are a Senior Technical Lead analyzing code changes. Provide a concise, domain-specific summary in 2-3 sentences maximum.',
                    {
                        contextLength: prompt.length,
                        timeout: 20000
                    }
                );
                
                if (result?.content) {
                    summaryText = result.content.trim();
                    console.log(`[Embedding Tools] AI summary generated using ${result.model}`);
                }
            } catch (orchestratorError) {
                console.warn('[Embedding Tools] Multi-model orchestrator failed, falling back to Gemini:', orchestratorError);
                
                // Fallback to original Gemini method
                const response = await geminiService.askGemini(prompt, getCurrentModel());
                if (response?.content?.[0]?.text) {
                    summaryText = response.content[0].text.trim();
                }
            }
        }
    } catch (e) {
        console.warn(`Unified AI summarizer failed:`, e);
    }

    return `\n### 🤖 AI Change Summary\n> ${summaryText.replace(/\n/g, '\n> ')}\n`;
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

            const { path_to_embed, paths_to_embed, project_root_path, is_directory, chunking_strategy, provider_type, disable_ai_output_summary, include_summary_patterns, exclude_summary_patterns, storeEntitySummaries, resume_failed_files } = args;
            const embeddingService = memoryManager.getCodebaseEmbeddingService();
            const absoluteProjectRootPath = path.resolve(project_root_path);
            let resultCounts: EmbeddingIngestionResult = {
                newEmbeddingsCount: 0,
                reusedEmbeddingsCount: 0,
                reusedFilesCount: 0,
                deletedEmbeddingsCount: 0,
                newEmbeddings: [],
                reusedEmbeddings: [],
                reusedFiles: [],
                deletedEmbeddings: [],
                scannedFiles: [],
                embeddingRequestCount: 0,
                embeddingRetryCount: 0,
                totalTokensProcessed: 0,
                namingApiCallCount: 0,
                summarizationApiCallCount: 0,
                dbCallCount: 0,
                dbCallLatencyMs: 0,
                processingErrors: [],
                batchStatus: 'complete',
                resumeInfo: { failedFiles: [] },
                aiSummary: '',
                totalTimeMs: 0
            };
            let outputMessage: string = '';
            
            // Handle resume functionality
            if (resume_failed_files && Array.isArray(resume_failed_files) && resume_failed_files.length > 0) {
                console.log(`[ingest_codebase_embeddings] Resuming ${resume_failed_files.length} failed files...`);
                
                resultCounts = await embeddingService.resumeFailedEmbeddingBatch(
                    agent_id,
                    resume_failed_files,
                    absoluteProjectRootPath,
                    chunking_strategy as ChunkingStrategy || 'auto',
                    provider_type || 'gemini',
                    include_summary_patterns,
                    exclude_summary_patterns,
                    storeEntitySummaries
                );
                
                outputMessage = `🔄 Resumed processing of ${resume_failed_files.length} previously failed files.`;
            }

            // If we've already handled resume_failed_files, skip other conditions
            if (resume_failed_files && Array.isArray(resume_failed_files) && resume_failed_files.length > 0) {
                // Already processed in the section above
            } else if (paths_to_embed && paths_to_embed.length > 0) {
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
                    provider_type,
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
                    resultCounts = await embeddingService.generateAndStoreEmbeddingsForDirectory(agent_id, absolutePathToEmbed, absoluteProjectRootPath, chunking_strategy as ChunkingStrategy, provider_type, include_summary_patterns, exclude_summary_patterns, storeEntitySummaries);
                } else {
                    resultCounts = await embeddingService.generateAndStoreEmbeddingsForFile(agent_id, absolutePathToEmbed, absoluteProjectRootPath, chunking_strategy as ChunkingStrategy, provider_type, include_summary_patterns, exclude_summary_patterns, storeEntitySummaries);
                }
                const relativePathToEmbed = path.relative(absoluteProjectRootPath, absolutePathToEmbed).replace(/\\/g, '/');
                outputMessage = `Codebase embedding ingestion for "${path_to_embed}" (relative to project root: "${relativePathToEmbed}") complete.`;
            } else {
                throw new McpError(ErrorCode.InvalidParams, "Either 'path_to_embed', 'paths_to_embed', or 'resume_failed_files' must be provided.");
            }

            // Get embedding configuration info
            const embeddingInfo = embeddingService.getSharedEmbeddingInfo();

            let detailedOutput = `## 🧠 Codebase Ingestion Report\n\n> ${outputMessage}\n\n`;
            detailedOutput += `### 🔬 Embedding Configuration\n${embeddingInfo.sharedProcessDescription}\n`
                + `- **Target Dimensions:** ${embeddingInfo.targetDimension}D\n`
                + `- **Active Models:** ${embeddingInfo.enabledModels.map(m => `${m.provider}:${m.model}`).join(', ')}\n`
                + `- **Strategy:** ${embeddingInfo.loadBalancing}\n\n`;
            
            // Add batch status indicator
            const statusIcon = resultCounts.batchStatus === 'complete' ? '✅' : 
                              resultCounts.batchStatus === 'partial' ? '⚠️' : '❌';
            detailedOutput += `### ${statusIcon} Batch Status: ${resultCounts.batchStatus.toUpperCase()}\n\n`;

            detailedOutput += `### 📊 Overall Statistics\n`
                + `- **✨ New Embeddings Created:** ${resultCounts.newEmbeddingsCount}\n`
                + `- **♻️ Reused Existing Embeddings:** ${resultCounts.reusedEmbeddingsCount}\n`
                + `- **📁 Reused Files (Unchanged):** ${resultCounts.reusedFilesCount || 0}\n`
                + `- **🗑️ Deleted Stale Embeddings:** ${resultCounts.deletedEmbeddingsCount}\n`;
            
            // Add error reporting if there are issues
            if (resultCounts.processingErrors && resultCounts.processingErrors.length > 0) {
                detailedOutput += `\n### ❌ Processing Errors (${resultCounts.processingErrors.length})\n`;
                const errorsByStage = new Map<string, any[]>();
                resultCounts.processingErrors.forEach(error => {
                    if (!errorsByStage.has(error.stage)) {
                        errorsByStage.set(error.stage, []);
                    }
                    errorsByStage.get(error.stage)!.push(error);
                });
                
                for (const [stage, errors] of errorsByStage.entries()) {
                    detailedOutput += `\n**${stage.replace('_', ' ').toUpperCase()} Failures (${errors.length}):**\n`;
                    errors.forEach(error => {
                        detailedOutput += `- \`${error.file_path_relative}\`: ${error.error}\n`;
                    });
                }

                // Add resumption guidance
                if (resultCounts.resumeInfo && resultCounts.resumeInfo.failedFiles.length > 0) {
                    detailedOutput += `\n### 🔄 Resumption Available\n`;
                    detailedOutput += `**${resultCounts.resumeInfo.failedFiles.length} files** failed processing and can be resumed.\n\n`;
                    detailedOutput += `**To resume failed files, you can:**\n`;
                    detailedOutput += `1. Re-run the ingestion for the same directory (failed files will be automatically retried)\n`;
                    detailedOutput += `2. Or target specific failed files: \`${resultCounts.resumeInfo.failedFiles.slice(0, 3).join(', ')}${resultCounts.resumeInfo.failedFiles.length > 3 ? '...' : ''}\`\n\n`;
                }
            }

            if (resultCounts.resumeInfo && resultCounts.resumeInfo.failedFiles.length > 0) {
                const failedFiles = resultCounts.resumeInfo.failedFiles;
                detailedOutput += `\n### 📌 Files Awaiting Embedding (${failedFiles.length})\n`;
                detailedOutput += failedFiles.map(filePath => `- \`${filePath}\``).join('\n');
                detailedOutput += '\n\nUse `resume_failed_files` with these paths to retry without rescanning unchanged files.';
            }

            if (!disable_ai_output_summary) {
                const unifiedSummary = await _generateUnifiedAiSummary(memoryManager, resultCounts, absoluteProjectRootPath);
                detailedOutput += unifiedSummary;
            }

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
                detailedOutput += `\n### 📁 File-by-File Ingestion Report (${fileStats.size} files processed)\n`;
                const sortedFiles = Array.from(fileStats.keys()).sort();

                sortedFiles.forEach(filePath => {
                    const counts = fileStats.get(filePath)!;
                    detailedOutput += `- \`${filePath}\` (✨ ${counts.new}, ♻️ ${counts.reused}, 🗑️ ${counts.deleted})\n`;
                });
            }

            detailedOutput += `\n### ⚙️ Performance Metrics\n`;
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

            return { content: [{ type: 'text', text: detailedOutput }] };
        },

        'query_codebase_embeddings': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for query_codebase_embeddings.");
            }
            const { query_text, top_k, target_file_paths, exclude_chunk_types, enable_dmqr, dmqr_query_count } = args;
            const embeddingService = memoryManager.getCodebaseEmbeddingService();

            try {
                let allResults: CodeChunkResult[] = [];
                let generatedQueries: string[] = [query_text]; // Always include original query

                // Use DMQR if enabled
                if (enable_dmqr) {
                    console.log(`[query_codebase_embeddings] DMQR enabled. Generating ${dmqr_query_count} diverse queries for: "${query_text}"`);

                    const geminiService = memoryManager.getGeminiIntegrationService();
                    if (!geminiService) {
                        throw new McpError(ErrorCode.InternalError, "GeminiIntegrationService not available for DMQR.");
                    }

                    const diverseQueryRewriterService = new DiverseQueryRewriterService(geminiService, memoryManager);
                    const dmqrResult = await diverseQueryRewriterService.rewriteAndRetrieve(query_text, {
                        queryCount: dmqr_query_count || 3
                    });

                    generatedQueries = dmqrResult.generatedQueries;
                    console.log(`[query_codebase_embeddings] Generated ${generatedQueries.length} queries:`, generatedQueries);
                }

                // Query embeddings for each generated query
                for (const query of generatedQueries) {
                    console.log(`[query_codebase_embeddings] Querying embeddings for: "${query}"`);

                    const queryResults: CodeChunkResult[] = await embeddingService.retrieveSimilarCodeChunks(
                        agent_id,
                        query,
                        top_k || 5,
                        target_file_paths,
                        exclude_chunk_types
                    );

                    // Add query source to metadata for tracking
                    if (enable_dmqr && query !== query_text) {
                        queryResults.forEach(result => {
                            if (!result.metadata) result.metadata = {};
                            result.metadata.dmqr_source_query = query;
                        });
                    }

                    allResults.push(...queryResults);
                }

                // Remove duplicates and sort by score (highest first)
                const uniqueResults = new Map<string, CodeChunkResult>();
                allResults.forEach(result => {
                    const key = `${result.file_path_relative}::${result.entity_name || 'unknown'}::${result.chunk_text}`;
                    if (!uniqueResults.has(key) || result.score > uniqueResults.get(key)!.score) {
                        uniqueResults.set(key, result);
                    }
                });

                const finalResults = Array.from(uniqueResults.values())
                    .sort((a, b) => b.score - a.score)
                    .slice(0, top_k || 5);

                if (finalResults.length === 0) {
                    const message = formatSimpleMessage(
                        `No similar code chunks found for query: "${query_text}"${enable_dmqr ? ` (searched with ${generatedQueries.length} diverse queries)` : ''} (after filtering).`,
                        "Embedding Query Results"
                    );
                    return { content: [{ type: 'text', text: message }] };
                }

                const resultMarkdown = finalResults.map((res, index) => {
                    const metadataLines = [
                        `📁 **File:** \`${res.file_path_relative}\``,
                        res.entity_name && `🧩 **Entity:** \`${res.entity_name}\``,
                        (res.metadata?.startLine && res.metadata?.endLine) && `🔢 **Lines:** ${res.metadata.startLine}-${res.metadata.endLine}`,
                        res.metadata?.type && `🏷️ **Type:** ${res.metadata.type}`,
                        enable_dmqr && res.metadata?.dmqr_source_query && res.metadata.dmqr_source_query !== query_text && `🎯 **DMQR Source:** "${res.metadata.dmqr_source_query}"`
                    ].filter(Boolean).join(' | ');

                    let contentBlock;
                    const lang = res.file_path_relative.split('.').pop() || 'text';

                    if (res.metadata?.type?.endsWith('_summary')) {
                        const originalCode = `#### Original Code Snippet\n${formatJsonToMarkdownCodeBlock(res.chunk_text, lang)}`;
                        const aiSummary = res.ai_summary_text ? `\n#### 🤖 AI Summary\n> ${res.ai_summary_text.replace(/\n/g, '\n> ')}\n` : '';
                        contentBlock = `${originalCode}${aiSummary}\n`;
                    } else {
                        contentBlock = `#### Content Snippet\n${formatJsonToMarkdownCodeBlock(res.chunk_text, lang)}\n`;
                    }

                    return `### ✨ Result ${index + 1} (Score: ${res.score.toFixed(4)})\n${metadataLines}\n\n${contentBlock}`;
                }).join('---\n');

                const queryInfo = enable_dmqr
                    ? ` (DMQR enabled: searched with ${generatedQueries.length} queries)`
                    : '';

                const finalMarkdown = `## 🔍 Similar Code Chunks for Query\n> "${query_text}"${queryInfo}\n\n${resultMarkdown}`;
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
                const message = formatSimpleMessage(`Successfully deleted ${result.deletedCount} embeddings for the specified file paths.`, "🗑️ Clean Up Embeddings");
                return { content: [{ type: 'text', text: message }] };
            } catch (error: any) {
                console.error(`Error cleaning up embeddings for agent ${agent_id}:`, error);
                throw new McpError(ErrorCode.InternalError, `Embedding cleanup failed: ${error.message}`);
            }
        }
    };
}
