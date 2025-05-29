import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate, schemas } from '../utils/validation.js';
import { formatObjectToMarkdown, formatSimpleMessage, formatJsonToMarkdownCodeBlock } from '../utils/formatters.js';

export const contextToolDefinitions = [
    {
        name: 'store_context',
        description: 'Stores dynamic contextual data for an AI agent. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                context_type: { type: 'string', description: 'Category of context (e.g., agent_state, user_preference, task_parameters).' },
                context_data: { type: 'object', description: 'JSON object containing the structured context data.' },
                parent_context_id: { type: 'string', description: 'Self-referencing foreign key for hierarchical context.', nullable: true },
            },
            required: ['agent_id', 'context_type', 'context_data'],
        },

    },
    {
        name: 'get_context',
        description: 'Retrieves contextual data for a given agent and context type, optionally by version or a specific snippet index. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                context_type: { type: 'string', description: 'Category of context.' },
                version: { type: 'number', description: 'Optional specific version of the context. If not provided, the latest version is returned.', nullable: true },
                snippet_index: { type: 'number', description: 'Optional index to retrieve a specific snippet from context_data.documentation_snippets. Only applicable if context_data contains a "documentation_snippets" array.', nullable: true }
            },
            required: ['agent_id', 'context_type'],
        },

    },
    {
        name: 'get_all_contexts',
        description: 'Retrieves all contextual data for a given agent. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
            },
            required: ['agent_id'],
        },

    },
    {
        name: 'search_context_by_keywords',
        description: 'Searches stored contextual data (specifically documentation snippets) by keywords. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                context_type: { type: 'string', description: 'Category of context to search within (e.g., "daisyui_component_creation_docs").' },
                keywords: { type: 'string', description: 'Keywords to search for within the documentation snippets (case-insensitive).' }
            },
            required: ['agent_id', 'context_type', 'keywords'],
        },

    },
    {
        name: 'prune_old_context',
        description: 'Deletes old context entries based on a specified age (in milliseconds). This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                context_type: { type: ['string', 'null'], description: 'Optional: Category of context to prune. If not provided, prunes all context types for the agent.' },
                max_age_ms: { type: 'number', description: 'Context entries older than this age (in milliseconds) will be deleted.' }
            },
            required: ['agent_id', 'max_age_ms'],
        },

    },
    {
        name: 'summarize_context',
        description: 'Generates a summary of stored contextual data using Gemini. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                context_type: { type: 'string', description: 'Category of context to summarize.' },
                version: { type: 'number', description: 'Optional specific version of the context. If not provided, the latest version is summarized.', nullable: true }
            },
            required: ['agent_id', 'context_type'],
        },

    },
    {
        name: 'extract_entities',
        description: 'Extracts key entities and keywords from stored contextual data using Gemini. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                context_type: { type: 'string', description: 'Category of context to extract from.' },
                version: { type: 'number', description: 'Optional specific version of the context. If not provided, the latest version is used.', nullable: true }
            },
            required: ['agent_id', 'context_type'],
        },

    },
    {
        name: 'semantic_search_context',
        description: 'Performs a semantic search on stored contextual data using vector embeddings with Gemini. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                context_type: { type: 'string', description: 'Category of context to search within.' },
                query_text: { type: 'string', description: 'The text query for semantic search.' },
                top_k: { type: 'number', description: 'Optional: Number of top similar results to return.', default: 5, minimum: 1 }
            },
            required: ['agent_id', 'context_type', 'query_text'],
        },
    },
];

function createMissingContextResponseMd(agent_id: string, context_type: string): string {
    return formatSimpleMessage(`Context not found for agent ID: \`${agent_id}\`, context type: \`${context_type}\``, "Context Not Found");
}

export function getContextToolHandlers(memoryManager: MemoryManager) {
    return {
        'store_context': async (args: any, agent_id: string) => {
            const validationResult = validate('contextInformation', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool store_context: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`
                );
            }
            const contextId = await memoryManager.storeContext(
                agent_id,
                args.context_type as string,
                args.context_data,
                args.parent_context_id as string | null
            );
            return { content: [{ type: 'text', text: formatSimpleMessage(`Context stored with ID: \`${contextId}\``, "Context Stored") }] };
        },
        'get_context': async (args: any, agent_id: string) => {
            const context = await memoryManager.getContext(
                agent_id,
                args.context_type as string,
                args.version as number | null,
                args.snippet_index as number | null
            );
            if (!context) {
                return { content: [{ type: 'text', text: createMissingContextResponseMd(agent_id, args.context_type) }] };
            }
            // If context is a simple string (e.g. a single snippet was returned)
            if (typeof context === 'string') {
                 return { content: [{ type: 'text', text: `### Context Snippet for \`${args.context_type}\`\n\n${formatJsonToMarkdownCodeBlock(context, 'text')}`}] };
            }
            // For full context object
            let md = `## Context Details for Agent: \`${agent_id}\`\n`;
            md += `### Type: \`${args.context_type}\`\n`;
            if (args.version) md += `Version: ${args.version}\n`;
            if (args.snippet_index !== null && typeof args.snippet_index !== 'undefined') md += `Snippet Index: ${args.snippet_index}\n`;
            md += formatObjectToMarkdown(context, 1);
            return { content: [{ type: 'text', text: md }] };
        },
        'get_all_contexts': async (args: any, agent_id: string) => {
            const allContexts = await memoryManager.getAllContexts(agent_id);
            if (!allContexts || allContexts.length === 0) {
                return { content: [{ type: 'text', text: formatSimpleMessage(`No contexts found for agent ID: \`${agent_id}\``, "All Contexts") }] };
            }
            let md = `## All Contexts for Agent: \`${agent_id}\`\n\n`;
            allContexts.forEach((context: any) => {
                md += `### Context ID: \`${context.context_id}\`\n`;
                md += `- **Type:** \`${context.context_type}\`\n`;
                md += `- **Version:** ${context.version}\n`;
                md += `- **Timestamp:** ${new Date(context.timestamp).toLocaleString()}\n`;
                if (context.parent_context_id) md += `- **Parent ID:** \`${context.parent_context_id}\`\n`;
                md += `- **Data:**\n${formatJsonToMarkdownCodeBlock(context.context_data_parsed || context.context_data)}\n\n---\n\n`;
            });
            return { content: [{ type: 'text', text: md }] };
        },
        'search_context_by_keywords': async (args: any, agent_id: string) => {
            const validationResult = validate('searchContextByKeywords', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool search_context_by_keywords: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`
                );
            }
            const searchResults = await memoryManager.searchContextByKeywords(
                agent_id,
                args.context_type as string,
                args.keywords as string
            );
            if (!searchResults || searchResults.length === 0) {
                return { content: [{ type: 'text', text: formatSimpleMessage(`No results found for keywords: "${args.keywords}" in context type: \`${args.context_type}\``, "Context Search") }] };
            }
            let md = `## Context Search Results for Agent: \`${agent_id}\`\n`;
            md += `### Type: \`${args.context_type}\`, Keywords: "${args.keywords}"\n\n`;
            searchResults.forEach((result: any, index: number) => { // Assuming result is the snippet itself
                md += `### Result ${index + 1}\n`;
                md += formatObjectToMarkdown(result,1) + "\n---\n\n";
            });
            return { content: [{ type: 'text', text: md }] };
        },
        'prune_old_context': async (args: any, agent_id: string) => {
            const validationResult = validate('pruneOldContext', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool prune_old_context: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`
                );
            }
            const deletedCount = await memoryManager.pruneOldContext(
                agent_id,
                args.max_age_ms as number,
                args.context_type as string | null
            );
            return { content: [{ type: 'text', text: formatSimpleMessage(`Deleted ${deletedCount} old context entries.`, "Context Pruned") }] };
        },
        'summarize_context': async (args: any, agent_id: string) => {
            const validationResult = validate('summarizeContext', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool summarize_context: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`
                );
            }
            const summary = await memoryManager.summarizeContext(
                agent_id,
                args.context_type as string,
                args.version as number | null
            );
            // The summary from GeminiIntegrationService is already a string, potentially Markdown.
            // We ensure it's presented clearly.
            let md = `## Context Summary for Agent: \`${agent_id}\`\n`;
            md += `### Type: \`${args.context_type}\`${args.version ? `, Version: ${args.version}` : ''}\n\n`;
            md += `${summary}\n`; // Assuming summary is already well-formatted or plain text
            return { content: [{ type: 'text', text: md }] };
        },
        'extract_entities': async (args: any, agent_id: string) => {
            const validationResult = validate('extractEntities', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool extract_entities: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`
                );
            }
            const extractedData = await memoryManager.extractEntities(
                agent_id,
                args.context_type as string,
                args.version as number | null
            );
            if (!extractedData || (!extractedData.entities && !extractedData.keywords)) {
                 return { content: [{ type: 'text', text: formatSimpleMessage(`No entities or keywords found for context type: \`${args.context_type}\``, "Entity Extraction") }] };
            }
            let md = `## Extracted Entities & Keywords for Agent: \`${agent_id}\`\n`;
            md += `### Type: \`${args.context_type}\`${args.version ? `, Version: ${args.version}` : ''}\n\n`;
            if (extractedData.entities && extractedData.entities.length > 0) {
                md += `**Entities:**\n${formatJsonToMarkdownCodeBlock(extractedData.entities)}\n`;
            } else {
                md += "**Entities:** *None found.*\n";
            }
            if (extractedData.keywords && extractedData.keywords.length > 0) {
                md += `**Keywords:**\n${formatJsonToMarkdownCodeBlock(extractedData.keywords)}\n`;
            } else {
                md += "**Keywords:** *None found.*\n";
            }
            if(extractedData.message) md += `\n*${extractedData.message}*\n`;
            return { content: [{ type: 'text', text: md }] };
        },
        'semantic_search_context': async (args: any, agent_id: string) => {
            const validationResult = validate('semanticSearchContext', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool semantic_search_context: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`
                );
            }
            const semanticResults = await memoryManager.semanticSearchContext(
                agent_id,
                args.context_type as string,
                args.query_text as string,
                args.top_k as number
            );
            if (!semanticResults || !semanticResults.results || semanticResults.results.length === 0) {
                return { content: [{ type: 'text', text: formatSimpleMessage(`No semantic search results found for query: "${args.query_text}" in context type: \`${args.context_type}\``, "Semantic Search") }] };
            }
            let md = `## Semantic Search Results for Agent: \`${agent_id}\`\n`;
            md += `### Type: \`${args.context_type}\`, Query: "${args.query_text}" (Top ${args.top_k || 5})\n\n`;
            semanticResults.results.forEach((result: { score: number; snippet: any; }, index: number) => {
                md += `### Result ${index + 1} (Score: ${result.score.toFixed(4)})\n`;
                md += `${formatObjectToMarkdown(result.snippet, 1)}\n---\n\n`;
            });
             if(semanticResults.message) md += `\n*${semanticResults.message}*\n`;
            return { content: [{ type: 'text', text: md }] };
        },
    };
}
