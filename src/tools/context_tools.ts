import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate, schemas } from '../utils/validation.js';
import { formatPlanToMarkdown, formatObjectToMarkdown } from '../utils/formatters.js'; // Assuming formatPlanToMarkdown is needed for get_task_plan_details output

export const contextToolDefinitions = [
    {
        name: 'store_context',
        description: 'Stores dynamic contextual data for an AI agent. This tool strictly requires the agent_id parameter.',
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
        description: 'Retrieves contextual data for a given agent and context type, optionally by version or a specific snippet index. This tool strictly requires the agent_id parameter.',
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
        description: 'Retrieves all contextual data for a given agent. This tool strictly requires the agent_id parameter.',
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
        description: 'Searches stored contextual data (specifically documentation snippets) by keywords. This tool strictly requires the agent_id parameter.',
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
        description: 'Deletes old context entries based on a specified age (in milliseconds). This tool strictly requires the agent_id parameter.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                context_type: { type: 'string', description: 'Optional: Category of context to prune. If not provided, prunes all context types for the agent.' },
                max_age_ms: { type: 'number', description: 'Context entries older than this age (in milliseconds) will be deleted.' }
            },
            required: ['agent_id', 'max_age_ms'],
        },

    },
    {
        name: 'summarize_context',
        description: 'Generates a summary of stored contextual data. (Placeholder: Requires external NLP integration for full functionality). This tool strictly requires the agent_id parameter.',
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
        description: 'Extracts key entities and keywords from stored contextual data. (Placeholder: Requires external NLP integration for full functionality). This tool strictly requires the agent_id parameter.',
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
        description: 'Performs a semantic search on stored contextual data using vector embeddings. (Placeholder: Requires external embedding model integration for full functionality). This tool strictly requires the agent_id parameter.',
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

function createMissingContextResponse(agent_id: string, context_type: string) {
    return { content: [{ type: 'text', text: `Context not found for agent_id: ${agent_id}, context_type: ${context_type}` }] };
}

export function getContextToolHandlers(memoryManager: MemoryManager) {
    return {
        'store_context': async (args: any, agent_id: string) => {
            const validationResult = validate('contextInformation', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool store_context: ${JSON.stringify(validationResult.errors)}`
                );
            }
            const contextId = await memoryManager.storeContext(
                agent_id,
                args.context_type as string,
                args.context_data,
                args.parent_context_id as string | null
            );
            return { content: [{ type: 'text', text: `Context stored with ID: ${contextId}` }] };
        },
        'get_context': async (args: any, agent_id: string) => {
            const context = await memoryManager.getContext(
                agent_id,
                args.context_type as string,
                args.version as number | null,
                args.snippet_index as number | null
            );
            if (!context) {
                return createMissingContextResponse(agent_id, args.context_type);
            }
            if (context && typeof context.content === 'string') {
                // Always return type 'text', even if content is markdown.
                // The client will render markdown if the text content is markdown.
                return { content: [{ type: 'text', text: context.content }] };
            } else if (context) {
                // If context is an object but content is not a string, format the entire object as Markdown
                return { content: [{ type: 'text', text: formatObjectToMarkdown(context) }] };
            }
            return { content: [{ type: 'text', text: `Context not found for agent_id: ${agent_id}, context_type: ${args.context_type}` }] };
        },
        'get_all_contexts': async (args: any, agent_id: string) => {
            const allContexts = await memoryManager.getAllContexts(agent_id);
            if (!allContexts || allContexts.length === 0) {
                return { content: [{ type: 'text', text: `No contexts found for agent_id: ${agent_id}` }] };
            }
            const formattedContexts = allContexts.map(context => {
                let md = `## Context ID: ${context.context_id}\n`;
                md += `- **Agent ID:** ${context.agent_id}\n`;
                md += `- **Timestamp:** ${new Date(context.timestamp).toLocaleString()}\n`;
                md += `- **Context Type:** ${context.context_type}\n`;
                md += `- **Version:** ${context.version}\n`;
                if (context.parent_context_id) md += `- **Parent Context ID:** ${context.parent_context_id}\n`;
                md += `### Context Data:\n`;
                md += formatObjectToMarkdown(context.context_data, 1); // Indent context_data
                return md;
            }).join('\n---\n\n'); // Separate each context with a horizontal rule

            return { content: [{ type: 'text', text: formattedContexts }] };
        },
        'search_context_by_keywords': async (args: any, agent_id: string) => {
            const validationResult = validate('searchContextByKeywords', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool search_context_by_keywords: ${JSON.stringify(validationResult.errors)}`
                );
            }
            const searchResults = await memoryManager.searchContextByKeywords(
                agent_id,
                args.context_type as string,
                args.keywords as string
            );
            if (!searchResults || searchResults.length === 0) {
                return { content: [{ type: 'text', text: `No results found for keywords: ${args.keywords} in context type: ${args.context_type}` }] };
            }
            const formattedResults = searchResults.map((result: { context_id: string; context_type: string; timestamp: number; content_snippet: any; }) => {
                let md = `### Search Result ID: ${result.context_id}\n`;
                md += `- **Context Type:** ${result.context_type}\n`;
                md += `- **Timestamp:** ${new Date(result.timestamp).toLocaleString()}\n`;
                md += `#### Content Snippet:\n`;
                md += formatObjectToMarkdown(result.content_snippet, 1);
                return md;
            }).join('\n---\n\n');
            return { content: [{ type: 'text', text: formattedResults }] };
        },
        'prune_old_context': async (args: any, agent_id: string) => {
            const validationResult = validate('pruneOldContext', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool prune_old_context: ${JSON.stringify(validationResult.errors)}`
                );
            }
            const deletedCount = await memoryManager.pruneOldContext(
                agent_id,
                args.max_age_ms as number,
                args.context_type as string | null
            );
            return { content: [{ type: 'text', text: `Deleted ${deletedCount} old context entries.` }] };
        },
        'summarize_context': async (args: any, agent_id: string) => {
            const validationResult = validate('summarizeContext', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool summarize_context: ${JSON.stringify(validationResult.errors)}`
                );
            }
            const summary = await memoryManager.summarizeContext(
                agent_id,
                args.context_type as string,
                args.version as number | null
            );
            return { content: [{ type: 'text', text: summary }] };
        },
        'extract_entities': async (args: any, agent_id: string) => {
            const validationResult = validate('extractEntities', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool extract_entities: ${JSON.stringify(validationResult.errors)}`
                );
            }
            const extractedData = await memoryManager.extractEntities(
                agent_id,
                args.context_type as string,
                args.version as number | null
            );
            if (!extractedData) {
                return { content: [{ type: 'text', text: `No entities found for context type: ${args.context_type}` }] };
            }
            let md = `### Extracted Entities for Context Type: ${args.context_type}\n`;
            if (args.version) md += `- **Version:** ${args.version}\n`;
            md += formatObjectToMarkdown(extractedData, 1);
            return { content: [{ type: 'text', text: md }] };
        },
        'semantic_search_context': async (args: any, agent_id: string) => {
            const validationResult = validate('semanticSearchContext', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool semantic_search_context: ${JSON.stringify(validationResult.errors)}`
                );
            }
            const semanticResults = await memoryManager.semanticSearchContext(
                agent_id,
                args.context_type as string,
                args.query_text as string,
                args.top_k as number
            );
            if (!semanticResults || !semanticResults.results || semanticResults.results.length === 0) {
                return { content: [{ type: 'text', text: `No semantic search results found for query: "${args.query_text}" in context type: ${args.context_type}` }] };
            }
            const formattedResults = semanticResults.results.map((result: { score: number; snippet: any; }) => {
                let md = `### Semantic Search Result (Score: ${result.score})\n`;
                md += `#### Content Snippet:\n`;
                md += formatObjectToMarkdown(result.snippet, 1);
                return md;
            }).join('\n---\n\n');
            return { content: [{ type: 'text', text: formattedResults }] };
        },
    };
}
