import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate, schemas } from '../utils/validation.js';
import { formatObjectToMarkdown, formatSimpleMessage, formatJsonToMarkdownCodeBlock } from '../utils/formatters.js';

export const promptRefinementToolDefinitions = [
    {
        name: 'refine_user_prompt',
        description: 'Analyzes a raw user prompt using an LLM and returns a structured, refined version for AI agent processing, including suggestions for context analysis. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
        inputSchema: schemas.refineUserPrompt
    },
    {
        name: 'get_refined_prompt',
        description: 'Retrieves a previously stored refined prompt by its ID. This tool strictly requires the agent_id parameter. Output is Markdown formatted.',
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

function formatRefinedPromptToMarkdown(prompt: any, agent_id: string): string {
    if (!prompt) return formatSimpleMessage(`Refined prompt not found.`, "Refined Prompt");

    let md = `## Refined Prompt Details (ID: \`${prompt.refined_prompt_id}\`)\n`;
    md += `- **Agent ID:** \`${agent_id}\`\n`;
    md += `- **Original Prompt:**\n`;
    md += `  > ${prompt.original_prompt_text.replace(/\n/g, '\n  > ')}\n\n`;
    md += `- **Refinement Engine:** \`${prompt.refinement_engine_model}\`\n`;
    md += `- **Timestamp:** ${new Date(prompt.refinement_timestamp).toLocaleString()}\n`;
    md += `- **Overall Goal:** ${prompt.overall_goal || '*Not specified*'}\n`;

    if (prompt.decomposed_tasks_parsed && prompt.decomposed_tasks_parsed.length > 0) {
        md += "\n**Decomposed Tasks:**\n";
        prompt.decomposed_tasks_parsed.forEach((task: string) => md += `- ${task}\n`);
    }
    
    if (prompt.key_entities_identified_parsed && prompt.key_entities_identified_parsed.length > 0) {
        md += "\n**Key Entities Identified:**\n";
        md += formatJsonToMarkdownCodeBlock(prompt.key_entities_identified_parsed) + "\n";
    }

    if (prompt.implicit_assumptions_made_by_refiner_parsed && prompt.implicit_assumptions_made_by_refiner_parsed.length > 0) {
        md += "\n**Implicit Assumptions by Refiner:**\n";
        prompt.implicit_assumptions_made_by_refiner_parsed.forEach((assumption: string) => md += `- ${assumption}\n`);
    }

    if (prompt.explicit_constraints_from_prompt_parsed && prompt.explicit_constraints_from_prompt_parsed.length > 0) {
        md += "\n**Explicit Constraints from Prompt:**\n";
        prompt.explicit_constraints_from_prompt_parsed.forEach((constraint: string) => md += `- ${constraint}\n`);
    }

    if (prompt.suggested_ai_role_for_agent) {
        md += `\n**Suggested AI Role:** ${prompt.suggested_ai_role_for_agent}\n`;
    }
    if (prompt.suggested_reasoning_strategy_for_agent) {
        md += `**Suggested Reasoning Strategy:** ${prompt.suggested_reasoning_strategy_for_agent}\n`;
    }

    if (prompt.desired_output_characteristics_inferred_parsed) {
        md += "\n**Desired Output Characteristics:**\n";
        md += formatObjectToMarkdown(prompt.desired_output_characteristics_inferred_parsed, 1) + "\n";
    }
    
    if (prompt.suggested_context_analysis_for_agent_parsed && prompt.suggested_context_analysis_for_agent_parsed.length > 0) {
        md += "\n**Suggested Context Analysis:**\n";
        md += formatJsonToMarkdownCodeBlock(prompt.suggested_context_analysis_for_agent_parsed) + "\n";
    }
    
    if (prompt.confidence_in_refinement_score) {
        md += `\n**Confidence Score:** ${prompt.confidence_in_refinement_score}\n`;
    }
    if (prompt.refinement_error_message) {
        md += `\n**Refinement Error:** ${prompt.refinement_error_message}\n`;
    }
    return md;
}


export function getPromptRefinementToolHandlers(memoryManager: MemoryManager) {
    return {
        'refine_user_prompt': async (args: any, agent_id: string) => {
            const validationResult = validate('refineUserPrompt', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool refine_user_prompt: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`
                );
            }
            // Agent ID from args takes precedence for this specific tool as it's part of its core logic.
            const effective_agent_id = args.agent_id || agent_id; 
            if (!effective_agent_id) {
                 throw new McpError(ErrorCode.InvalidParams, `agent_id is strictly required for refine_user_prompt.`);
            }

            console.log('[DEBUG] refine_user_prompt args:', JSON.stringify(args, null, 2));
            // Enhance context options for richer context if not provided
            const enhancedContextOptions = {
                topKEmbeddings: args.context_options?.topKEmbeddings || 20,
                topKKgResults: args.context_options?.topKKgResults || 10,
                embeddingScoreThreshold: args.context_options?.embeddingScoreThreshold || 0.2,
                ...(args.context_options || {})
            };
            const refinedPromptObject = await memoryManager.processAndRefinePrompt(
                effective_agent_id,
                args.raw_user_prompt as string,
                args.target_ai_persona as string | undefined,
                args.conversation_context_ids as string[] | undefined,
                enhancedContextOptions
            );
            // The refinedPromptObject itself is the full structured data.
            return { content: [{ type: 'text', text: formatRefinedPromptToMarkdown(refinedPromptObject, effective_agent_id) }] };
        },
        'get_refined_prompt': async (args: any, agent_id_from_server: string) => { // agent_id_from_server is passed by MCP server
            const agent_id_to_use = args.agent_id || agent_id_from_server;
             if (!agent_id_to_use) {
                 throw new McpError(ErrorCode.InvalidParams, `agent_id is strictly required for get_refined_prompt.`);
            }
            const refinedPrompt = await memoryManager.getRefinedPrompt(
                agent_id_to_use, 
                args.refined_prompt_id as string
            );
            if (!refinedPrompt) {
                return { content: [{ type: 'text', text: formatSimpleMessage(`Refined prompt with ID \`${args.refined_prompt_id}\` not found for agent \`${agent_id_to_use}\`.`, "Refined Prompt Not Found") }] };
            }
            return { content: [{ type: 'text', text: formatRefinedPromptToMarkdown(refinedPrompt, agent_id_to_use) }] };
        },
    };
}
