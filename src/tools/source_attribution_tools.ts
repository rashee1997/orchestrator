import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate, schemas } from '../utils/validation.js';
import { callTavilyApi } from '../integrations/tavily.js';
import { formatSimpleMessage, formatJsonToMarkdownCodeBlock, formatObjectToMarkdown } from '../utils/formatters.js';

export const tavilyToolDefinition = {
    name: 'tavily_web_search',
    description: 'Performs a Tavily web search and returns results as Markdown. Source attribution should be logged separately by the calling agent using the log_source_attribution tool with source_type \'tavily_search\'.',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'The search query.' },
            search_depth: { type: 'string', enum: ['basic', 'advanced'], default: 'basic', description: 'Depth of the search.' },
            max_results: { type: 'number', default: 5, description: 'Maximum number of search results to return.' },
            include_raw_content: { type: 'boolean', default: false, description: 'Include raw content in search results.' },
            include_images: { type: 'boolean', default: false, description: 'Include images in search results.' },
            include_image_descriptions: { type: 'boolean', default: false, description: 'Include image descriptions in search results.' },
            time_period: { type: 'string', description: 'Time period for search results (e.g., "1m", "1y", "all").' },
            topic: { type: 'string', description: 'Topic category for search results (e.g., "news", "general").' },
        },
        required: ['query'],
    },
};

export function getTavilyToolHandlers(memoryManager: MemoryManager) {
    return {
        'tavily_web_search': async (args: any) => { // agent_id is not required for this tool's core logic
            const validationResult = validate('tavilySearch', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }
            // Pass all Tavily parameters to the API call
            const tavilySearchResults = await callTavilyApi(args.query, {
                search_depth: args.search_depth,
                max_results: args.max_results,
                include_raw_content: args.include_raw_content,
                include_images: args.include_images,
                include_image_descriptions: args.include_image_descriptions,
                time_period: args.time_period,
                topic: args.topic
            });

            let md = `## Tavily Web Search Results for Query: "${args.query}"\n\n`;
            if (!tavilySearchResults || tavilySearchResults.length === 0) {
                md += "*No results found.*\n";
            } else {
                tavilySearchResults.forEach((result: any, index: number) => {
                    md += `### Result ${index + 1}: ${result.title || 'N/A'}\n`;
                    md += `- **URL:** <${result.url || '#'}>\n`;
                    if (result.content) md += `- **Content Snippet:**\n  > ${result.content.replace(/\n/g, '\n  > ')}\n`;
                    if (result.score) md += `- **Score:** ${result.score}\n`;
                    md += "\n";
                });
            }
            return { content: [{ type: 'text', text: md }] };
        },
    };
}