import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate, schemas } from '../utils/validation.js';
import { formatObjectToMarkdown } from '../utils/formatters.js';

export const promptRefinementToolDefinitions = [
    {
        name: 'refine_user_prompt',
        description: 'Analyzes a raw user prompt using an LLM and returns a structured, refined version for AI agent processing, including suggestions for context analysis. This tool strictly requires the agent_id parameter.',
        inputSchema: schemas.refineUserPrompt
    },
    {
        name: 'get_refined_prompt',
        description: 'Retrieves a previously stored refined prompt by its ID. This tool strictly requires the agent_id parameter.',
        inputSchema: {
            type: 'object',
            properties: {
                refined_prompt_id: { type: 'string', description: 'The unique ID of the refined prompt to retrieve.' },
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' }
            },
            required: ['refined_prompt_id', 'agent_id'],
            additionalProperties: false
        }
    }

];

export function getPromptRefinementToolHandlers(memoryManager: MemoryManager) {
    return {
        'refine_user_prompt': async (args: any, agent_id: string) => {
            const validationResult = validate('refineUserPrompt', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool refine_user_prompt: ${JSON.stringify(validationResult.errors)}`
                );
            }
            const refinedPromptObject = await memoryManager.processAndRefinePrompt(
                args.agent_id as string,
                args.raw_user_prompt as string,
                args.target_ai_persona as string | undefined,
                args.conversation_context_ids as string[] | undefined
            );
            return { content: [{ type: 'text', text: formatObjectToMarkdown(refinedPromptObject) }] };
        },
        'get_refined_prompt': async (args: any, agent_id: string) => { // agent_id is now required for this tool
            const refinedPrompt = await memoryManager.getRefinedPrompt(
                agent_id, // Pass agent_id to the manager
                args.refined_prompt_id as string
            );
            if (!refinedPrompt) {
                return { content: [{ type: 'text', text: `Refined prompt with ID ${args.refined_prompt_id} not found for agent ${agent_id}.` }] };
            }
            return { content: [{ type: 'text', text: formatObjectToMarkdown(refinedPrompt) }] };
        },
    };
}
