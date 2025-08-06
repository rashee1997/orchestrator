// src/utils/validation.ts
import Ajv from 'ajv';

const ajv = new Ajv.default({ allErrors: true, useDefaults: true });

// IMPORTANT: Reconstructed schemas after removal of modeInstruction.
// This list includes only non-mode schemas referenced across tools.

export const schemas = {
    aiSuggestTaskDetails: {
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
            plan_id: { type: 'string', description: 'ID of the plan the task belongs to.' },
            task_id: { type: 'string', description: 'The ID of the task for which details are being suggested.' },
            task_title: { type: 'string', description: 'Optional: Current title of the task (provides more context to AI). If not provided, it will be fetched.', nullable: true },
            task_description: { type: 'string', description: 'Optional: Current description of the task. If not provided, it will be fetched.', nullable: true },
            codebase_context_summary: { type: 'string', description: 'Optional: A summary string of relevant codebase context (e.g., related file names, function signatures, class definitions).', nullable: true }
        },
        required: ['agent_id', 'plan_id', 'task_id'],
        additionalProperties: false
    },

    aiSuggestSubtasks: {
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
            plan_id: { type: 'string', description: 'ID of the plan the parent task belongs to.' },
            parent_task_id: { type: 'string', description: 'The ID of the parent task for which subtasks are being suggested.' },
            parent_task_title: { type: 'string', description: 'Optional: Title of the parent task (provides more context to AI). If not provided, it will be fetched.', nullable: true },
            parent_task_description: { type: 'string', description: 'Optional: Description of the parent task. If not provided, it will be fetched.', nullable: true },
            max_suggestions: { type: 'number', default: 5, minimum: 1, maximum: 10, description: 'Maximum number of subtasks to suggest.' },
            codebase_context_summary: { type: 'string', description: 'Optional: A summary string of relevant codebase context (e.g., related file names, function signatures).', nullable: true }
        },
        required: ['agent_id', 'plan_id', 'parent_task_id'],
        additionalProperties: false
    },

    aiAnalyzePlan: {
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
            plan_id: { type: 'string', description: 'The ID of the plan to analyze.' },
            analysis_focus_areas: { type: 'array', items: { type: 'string' }, nullable: true, description: 'Optional: Specific areas to focus the analysis on (e.g., "risk_assessment", "task_dependencies", "resource_allocation", "goal_alignment").' },
            codebase_context_summary: { type: 'string', description: 'Optional: A summary string of relevant codebase context to consider during plan analysis.', nullable: true }
        },
        required: ['agent_id', 'plan_id'],
        additionalProperties: false
    },

    aiSummarizeTaskProgress: {
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
            plan_id: { type: 'string', description: 'The ID of the plan for which progress is being summarized.' },
            task_id: { type: 'string', description: 'Optional: The ID of a specific task within the plan to focus the summary on. If omitted, summarizes progress for all tasks in the plan.', nullable: true },
            max_logs_to_consider: { type: 'number', default: 50, minimum: 1, maximum: 200, description: 'Maximum number of recent progress logs to consider for the summary.' }
        },
        required: ['agent_id', 'plan_id'],
        additionalProperties: false
    },

    queryCodebaseEmbeddings: {
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: 'Agent ID associated with the embeddings.' },
            query_text: { type: 'string', description: 'The text to find similar code chunks for.' },
            top_k: { type: 'number', default: 5, minimum: 1, description: 'Number of top results to return.' },
            target_file_paths: { type: 'array', items: { type: 'string' }, nullable: true, description: 'Optional: Array of relative file paths to restrict the search to.' },
            exclude_chunk_types: { type: 'array', items: { type: 'string' }, nullable: true, description: "Optional: Array of chunk types to exclude (e.g., 'full_file', 'function_summary')." }
        },
        required: ['agent_id', 'query_text'],
        additionalProperties: false
    },

    // Conversation & logging related schemas retained from project
    conversationMessage: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            user_id: { type: ['string', 'null'] },
            sender: { type: 'string' },
            message_content: { type: 'string' },
            message_type: { type: 'string', default: 'text' },
            tool_info: { type: ['string', 'object', 'null'] },
            context_snapshot_id: { type: ['string', 'null'] },
            source_attribution_id: { type: ['string', 'null'] }
        },
        required: ['agent_id', 'sender', 'message_content'],
        additionalProperties: false
    },

    contextInformation: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            context_type: { type: 'string' },
            context_data: { type: 'object' },
            parent_context_id: { type: ['string', 'null'] }
        },
        required: ['agent_id', 'context_type', 'context_data'],
        additionalProperties: false
    },

    referenceKey: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            key_type: { type: 'string' },
            key_value: { type: 'string' },
            description: { type: ['string', 'null'] },
            associated_conversation_id: { type: ['string', 'null'] }
        },
        required: ['agent_id', 'key_type', 'key_value'],
        additionalProperties: false
    },

    sourceAttribution: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            source_type: { type: 'string' },
            source_uri: { type: ['string', 'null'] },
            retrieval_timestamp: { type: 'number' },
            content_summary: { type: ['string', 'null'] },
            full_content_hash: { type: ['string', 'null'] },
            full_content_json: { type: ['string', 'object', 'null'] }
        },
        required: ['agent_id', 'source_type', 'retrieval_timestamp'],
        additionalProperties: false
    },

    correctionLog: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            correction_type: { type: 'string' },
            original_entry_id: { type: ['string', 'null'] },
            original_value: { type: ['object', 'null'] },
            corrected_value: { type: ['object', 'null'] },
            reason: { type: ['string', 'null'] },
            correction_summary: { type: ['string', 'null'] },
            applied_automatically: { type: 'boolean' },
            status: { type: 'string', default: 'LOGGED' }
        },
        required: ['agent_id', 'correction_type', 'applied_automatically'],
        additionalProperties: false
    },

    // getTaskDetails and updateTask as seen in the file tail
    getTaskDetails: {
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
            task_id: { type: 'string', description: 'The ID of the task to retrieve.' }
        },
        required: ['agent_id', 'task_id'],
        additionalProperties: false
    },

    updateTask: {
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
            task_id: { type: 'string', description: 'The ID of the task to update.' },
            title: { type: ['string', 'null'] },
            description: { type: ['string', 'null'] },
            purpose: { type: ['string', 'null'] },
            status: { type: ['string', 'null'] },
            estimated_effort_hours: { type: ['number', 'null'] },
            files_involved: { type: ['array', 'null'], items: { type: 'string' } },
            dependencies_task_ids: { type: ['array', 'null'], items: { type: 'string' } },
            tools_required_list: { type: ['array', 'null'], items: { type: 'string' } },
            inputs_summary: { type: ['string', 'null'] },
            outputs_summary: { type: ['string', 'null'] },
            success_criteria_text: { type: ['string', 'null'] },
            assigned_to: { type: ['string', 'null'] },
            verification_method: { type: ['string', 'null'] },
            notes: { type: ['object', 'null'] },
            completion_timestamp: { type: ['number', 'null'], description: 'Unix timestamp for completion (optional).' }
        },
        required: ['agent_id', 'task_id'],
        additionalProperties: false
    }
};

// Compile schemas
for (const key in schemas) {
    if (Object.prototype.hasOwnProperty.call(schemas, key)) {
        if (!ajv.getSchema(key)) {
            ajv.addSchema((schemas as any)[key], key);
        }
    }
}

export function validate(schemaName: string, data: any) {
    const validateFn = ajv.getSchema(schemaName);
    if (!validateFn) {
        console.error(Schema "" not found during validation lookup. Available schemas:, Object.keys(ajv.schemas));
        throw new Error(Schema "" not found.);
    }
    const valid = validateFn(data);
    if (!valid) {
        return { valid: false, errors: validateFn.errors };
    }
    return { valid: true, errors: null };
}

