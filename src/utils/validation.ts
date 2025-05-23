import Ajv from 'ajv';

const ajv = new Ajv.default({ allErrors: true });

// Define common schemas for data validation
const jsonSchema = {
    type: 'object',
    properties: {},
    additionalProperties: true, // Allow additional properties by default
};

export const schemas = {
    conversationMessage: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            user_id: { type: ['string', 'null'] },
            sender: { type: 'string' },
            message_content: { type: 'string' },
            message_type: { type: 'string', default: 'text' },
            tool_info: { type: ['string', 'null'] },
            context_snapshot_id: { type: ['string', 'null'] },
            source_attribution_id: { type: ['string', 'null'] },
        },
        required: ['agent_id', 'sender', 'message_content'],
        additionalProperties: false,
    },
    contextInformation: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            context_type: { type: 'string' },
            context_data: { type: 'object' }, // Assuming context_data is always a JSON object
            parent_context_id: { type: ['string', 'null'] },
        },
        required: ['agent_id', 'context_type', 'context_data'],
        additionalProperties: false,
    },
    referenceKey: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            key_type: { type: 'string' },
            key_value: { type: 'string' },
            description: { type: ['string', 'null'] },
            associated_conversation_id: { type: ['string', 'null'] },
        },
        required: ['agent_id', 'key_type', 'key_value'],
        additionalProperties: false,
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
            full_content_json: { type: ['string', 'null'] }, // New property
        },
        required: ['agent_id', 'source_type', 'retrieval_timestamp'],
        additionalProperties: false,
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
            applied_automatically: { type: 'boolean' },
        },
        required: ['agent_id', 'correction_type', 'applied_automatically'],
        additionalProperties: false,
    },
    successMetric: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            metric_name: { type: 'string' },
            metric_value: { type: 'number' },
            unit: { type: ['string', 'null'] },
            associated_task_id: { type: ['string', 'null'] },
            metadata: { type: ['object', 'null'] },
        },
        required: ['agent_id', 'metric_name', 'metric_value'],
        additionalProperties: false,
    },
    tavilySearch: {
        type: 'object',
        properties: {
            query: { type: 'string' },
            search_depth: { type: 'string', enum: ['basic', 'advanced'] },
            max_results: { type: 'number' },
        },
        required: ['query'],
        additionalProperties: false,
    },
    searchContextByKeywords: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            context_type: { type: 'string' },
            keywords: { type: 'string' }
        },
        required: ['agent_id', 'context_type', 'keywords'],
        additionalProperties: false,
    },
    pruneOldContext: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            context_type: { type: ['string', 'null'] },
            max_age_ms: { type: 'number' }
        },
        required: ['agent_id', 'max_age_ms'],
        additionalProperties: false,
    },
    summarizeContext: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            context_type: { type: 'string' },
            version: { type: ['number', 'null'] }
        },
        required: ['agent_id', 'context_type'],
        additionalProperties: false,
    },
    extractEntities: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            context_type: { type: 'string' },
            version: { type: ['number', 'null'] }
        },
        required: ['agent_id', 'context_type'],
        additionalProperties: false,
    },
    semanticSearchContext: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            context_type: { type: 'string' },
            query_text: { type: 'string' },
            top_k: { type: 'number', minimum: 1 }
        },
        required: ['agent_id', 'context_type', 'query_text'],
        additionalProperties: false,
    },
    analyzeImageContent: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            image_path: { type: 'string' },
            mime_type: { type: 'string' },
            prompt: { type: 'string' }
        },
        required: ['agent_id', 'image_path', 'mime_type', 'prompt'],
        additionalProperties: false,
    },
    exportDataToCsv: {
        type: 'object',
        properties: {
            tableName: { type: 'string' },
            filePath: { type: 'string' }
        },
        required: ['tableName', 'filePath'],
        additionalProperties: false,
    },
    backupDatabase: {
        type: 'object',
        properties: {
            backupFilePath: { type: 'string' }
        },
        required: ['backupFilePath'],
        additionalProperties: false,
    },
    restoreDatabase: {
        type: 'object',
        properties: {
            backupFilePath: { type: 'string' }
        },
        required: ['backupFilePath'],
        additionalProperties: false,
    },
    createTaskPlan: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            planData: {
                type: 'object',
                properties: {
                    title: { type: 'string' },
                    overall_goal: { type: ['string', 'null'] },
                    status: { type: 'string' },
                    version: { type: 'number' },
                    refined_prompt_id_associated: { type: ['string', 'null'] },
                    analysis_report_id_referenced: { type: ['string', 'null'] },
                    metadata: { type: ['object', 'null'] }
                },
                required: ['title'],
                additionalProperties: false
            },
            tasksData: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        task_number: { type: 'number' },
                        title: { type: 'string' },
                        description: { type: ['string', 'null'] },
                        status: { type: 'string' },
                        purpose: { type: ['string', 'null'] },
                        action_description: { type: ['string', 'null'] },
                        files_involved: { type: ['array', 'null'], items: { type: 'string' } },
                        dependencies_task_ids: { type: ['array', 'null'], items: { type: 'string' } },
                        tools_required_list: { type: ['array', 'null'], items: { type: 'string' } },
                        inputs_summary: { type: ['string', 'null'] },
                        outputs_summary: { type: ['string', 'null'] },
                        success_criteria_text: { type: ['string', 'null'] },
                        estimated_effort_hours: { type: ['number', 'null'] },
                        assigned_to: { type: ['string', 'null'] },
                        verification_method: { type: ['string', 'null'] },
                        notes: { type: ['object', 'null'] }
                    },
                    required: ['task_number', 'title'],
                    additionalProperties: false
                },
                minItems: 1
            }
        },
        required: ['agent_id', 'planData', 'tasksData'],
        additionalProperties: false,
    },
    getTaskPlanDetails: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            plan_id: { type: 'string' }
        },
        required: ['agent_id', 'plan_id'],
        additionalProperties: false,
    },
    listTaskPlans: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            status_filter: { type: ['string', 'null'] },
            limit: { type: 'number' },
            offset: { type: 'number' }
        },
        required: ['agent_id'],
        additionalProperties: false,
    },
    getPlanTasks: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            plan_id: { type: 'string' },
            status_filter: { type: ['string', 'null'] },
            limit: { type: 'number' },
            offset: { type: 'number' }
        },
        required: ['agent_id', 'plan_id'],
        additionalProperties: false,
    },
    updateTaskPlanStatus: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            plan_id: { type: 'string' },
            new_status: { type: 'string' }
        },
        required: ['agent_id', 'plan_id', 'new_status'],
        additionalProperties: false,
    },
    updatePlanTaskStatus: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            task_id: { type: 'string' },
            new_status: { type: 'string' },
            completion_timestamp: { type: ['number', 'null'] }
        },
        required: ['agent_id', 'task_id', 'new_status'],
        additionalProperties: false,
    },
    deleteTaskPlan: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            plan_id: { type: 'string' }
        },
        required: ['agent_id', 'plan_id'],
        additionalProperties: false,
    },
    addTaskToPlan: {
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
            plan_id: { type: 'string', description: 'Unique ID of the plan to add the task to.' },
            taskData: {
                type: 'object',
                properties: {
                    task_number: { type: 'number' },
                    title: { type: 'string' },
                    description: { type: ['string', 'null'] },
                    status: { type: 'string' },
                    purpose: { type: ['string', 'null'] },
                    action_description: { type: ['string', 'null'] },
                    files_involved: { type: ['array', 'null'], items: { type: 'string' } },
                    dependencies_task_ids: { type: ['array', 'null'], items: { type: 'string' } },
                    tools_required_list: { type: ['array', 'null'], items: { type: 'string' } },
                    inputs_summary: { type: ['string', 'null'] },
                    outputs_summary: { type: ['string', 'null'] },
                    success_criteria_text: { type: ['string', 'null'] },
                    estimated_effort_hours: { type: ['number', 'null'] },
                    assigned_to: { type: ['string', 'null'] },
                    verification_method: { type: ['string', 'null'] },
                    notes: { type: ['object', 'null'] }
                },
                required: ['task_number', 'title'],
                additionalProperties: false
            }
        },
        required: ['agent_id', 'plan_id', 'taskData'],
        additionalProperties: false,
    },
    refineUserPrompt: { // New schema name
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: "Identifier of the AI agent (e.g., 'cline')." },
            raw_user_prompt: { type: 'string', description: "The raw text prompt received from the user." },
            target_ai_persona: {
              type: ['string', 'null'],
              description: "Optional: A suggested persona for the AI agent to adopt for the task (e.g., 'expert Python developer', 'technical writer'). This helps the refiner tailor the output.",
              default: null
            },
            conversation_context_ids: {
              type: ['array', 'null'],
              items: { type: 'string' },
              description: "Optional: Array of recent conversation_ids or context_ids that might provide immediate context for the refinement, if available to the agent.",
              default: null
            }
          },
          required: ['agent_id', 'raw_user_prompt']
    },
};

// Compile schemas
for (const key in schemas) {
    if (Object.prototype.hasOwnProperty.call(schemas, key)) {
        ajv.addSchema((schemas as any)[key], key);
    }
}

export function validate(schemaName: string, data: any) {
    const validateFn = ajv.getSchema(schemaName);
    if (!validateFn) {
        throw new Error(`Schema "${schemaName}" not found.`);
    }
    const valid = validateFn(data);
    if (!valid) {
        return { valid: false, errors: validateFn.errors };
    }
    return { valid: true, errors: null };
}
