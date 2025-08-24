import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate, schemas } from '../utils/validation.js';
import { formatObjectToMarkdown, formatSimpleMessage, formatJsonToMarkdownCodeBlock, formatValue } from '../utils/formatters.js';

export const promptRefinementToolDefinitions = [
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

    let md = `## Refined Prompt Details (ID: ${formatValue(prompt.refined_prompt_id, { isCodeOrId: true })})\n\n`;
    md += `- **Agent ID:** ${formatValue(agent_id, { isCodeOrId: true })}\n`;
    md += `- **Original Prompt:** ${formatValue(prompt.original_prompt_text)}\n`;
    md += `- **Refinement Engine:** ${formatValue(prompt.refinement_engine_model)}\n`;
    md += `- **Timestamp:** ${formatValue(new Date(prompt.refinement_timestamp))}\n`;
    md += `- **Overall Goal:** ${formatValue(prompt.overall_goal || '*Not specified*')}\n`;
    md += `\n> Next step is feed the refined prompt id to create_task_plan tool to create plan\n`;

    if (prompt.decomposed_tasks_parsed && prompt.decomposed_tasks_parsed.length > 0) {
        md += "\n### Decomposed Tasks:\n";
        prompt.decomposed_tasks_parsed.forEach((task: any, index: number) => {
            md += `\n**Task ${index + 1}: ${formatValue(task.title || 'Untitled Task')}**\n`;
            md += `- **Description:** ${formatValue(task.description || '*Not specified*')}\n`;
            if (task.purpose) {
                md += `- **Purpose:** ${formatValue(task.purpose)}\n`;
            }
            if (task.files_involved_json && task.files_involved_json.length > 0) {
                md += `- **Files to Modify:** ${task.files_involved_json.map((f: string) => formatValue(f, { isCodeOrId: true })).join(', ')}\n`;
            }
            if (task.tools_required_list_json && task.tools_required_list_json.length > 0) {
                md += `- **Suggested Tools:** ${task.tools_required_list_json.map((t: string) => formatValue(t, { isCodeOrId: true })).join(', ')}\n`;
            }
            if (task.success_criteria_text) {
                md += `- **Success Criteria:** ${formatValue(task.success_criteria_text)}\n`;
            }
            if (task.dependencies_task_ids_json && task.dependencies_task_ids_json.length > 0) {
                md += `- **Dependencies:** ${task.dependencies_task_ids_json.map((d: string) => formatValue(d, { isCodeOrId: true })).join(', ')}\n`;
            }
        });
    }

    if (prompt.key_entities_identified_parsed && prompt.key_entities_identified_parsed.length > 0) {
        md += "\n### Key Entities Identified:\n";
        md += formatJsonToMarkdownCodeBlock(prompt.key_entities_identified_parsed) + "\n";
    }

    if (prompt.implicit_assumptions_made_by_refiner_parsed && prompt.implicit_assumptions_made_by_refiner_parsed.length > 0) {
        md += "\n### Implicit Assumptions by Refiner:\n";
        prompt.implicit_assumptions_made_by_refiner_parsed.forEach((assumption: string) => md += `- ${formatValue(assumption)}\n`);
    }

    if (prompt.explicit_constraints_from_prompt_parsed && prompt.explicit_constraints_from_prompt_parsed.length > 0) {
        md += "\n### Explicit Constraints from Prompt:\n";
        prompt.explicit_constraints_from_prompt_parsed.forEach((constraint: string) => md += `- ${formatValue(constraint)}\n`);
    }

    if (prompt.suggested_ai_role_for_agent) {
        md += `\n### Suggested AI Role:\n${formatValue(prompt.suggested_ai_role_for_agent)}\n`;
    }
    if (prompt.suggested_reasoning_strategy_for_agent) {
        md += `\n### Suggested Reasoning Strategy:\n${formatValue(prompt.suggested_reasoning_strategy_for_agent)}\n`;
    }

    if (prompt.desired_output_characteristics_inferred_parsed) {
        md += "\n### Desired Output Characteristics:\n";
        md += formatObjectToMarkdown(prompt.desired_output_characteristics_inferred_parsed, 0) + "\n"; // No extra indent for top level
    }

    if (prompt.suggested_context_analysis_for_agent_parsed && prompt.suggested_context_analysis_for_agent_parsed.length > 0) {
        md += "\n### Suggested Context Analysis:\n";
        md += formatJsonToMarkdownCodeBlock(prompt.suggested_context_analysis_for_agent_parsed) + "\n";
    }

    if (prompt.codebase_context_summary_by_ai) {
        md += `\n### Codebase Context Summary by AI:\n`;
        md += `${formatValue(prompt.codebase_context_summary_by_ai, { isBlockContent: true, lang: 'text' })}\n`;
    }

    if (prompt.relevant_code_elements_analyzed_parsed && prompt.relevant_code_elements_analyzed_parsed.length > 0) {
        md += `\n### Relevant Code Elements Analyzed:\n`;
        prompt.relevant_code_elements_analyzed_parsed.forEach((element: any) => {
            md += `- **${formatValue(element.element_type.charAt(0).toUpperCase() + element.element_type.slice(1))}:** ${formatValue(element.element_path, { isCodeOrId: true })} (Entity: ${formatValue(element.entity_name, { isCodeOrId: true })})\n`;
            if (element.relevance_notes) {
                md += `  - **Notes:** ${formatValue(element.relevance_notes)}\n`;
            }
        });
        md += "\n";
    }

    if (prompt.suggested_code_diffs_parsed && prompt.suggested_code_diffs_parsed.length > 0) {
        md += `\n### Suggested Code Diffs:\n`;
        prompt.suggested_code_diffs_parsed.forEach((diff: string) => {
            md += `${formatJsonToMarkdownCodeBlock(diff, 'diff', 0)}\n`;
        });
        md += "\n";
    }

    if (prompt.confidence_in_refinement_score) {
        md += `\n**Confidence Score:** ${formatValue(prompt.confidence_in_refinement_score)}\n`;
    }
    if (prompt.refinement_error_message) {
        md += `\n**Refinement Error:** ${formatValue(prompt.refinement_error_message)}\n`;
    }
    return md;
}


export function getPromptRefinementToolHandlers(memoryManager: MemoryManager) {
    return {
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