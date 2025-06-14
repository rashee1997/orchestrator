// src/utils/validation.ts
import Ajv from 'ajv';

const ajv = new Ajv.default({ allErrors: true, useDefaults: true });

export const schemas = {
    aiSuggestTaskDetails: { // New schema for ai_suggest_task_details
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
            plan_id: { type: 'string', description: 'ID of the plan the task belongs to.' },
            task_id: { type: 'string', description: 'The ID of the task for which details are being suggested.' },
            task_title: { type: 'string', description: 'Optional: Current title of the task (provides more context to AI). If not provided, it will be fetched.', nullable: true },
            task_description: { type: 'string', description: 'Optional: Current description of the task. If not provided, it will be fetched.', nullable: true },
            codebase_context_summary: { type: 'string', description: 'Optional: A summary string of relevant codebase context (e.g., related file names, function signatures, class definitions).', nullable: true },
        },
        required: ['agent_id', 'plan_id', 'task_id'],
        additionalProperties: false,
    },
    aiSuggestSubtasks: { 
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
            plan_id: { type: 'string', description: 'ID of the plan the parent task belongs to.' },
            parent_task_id: { type: 'string', description: 'The ID of the parent task for which subtasks are being suggested.' },
            parent_task_title: { type: 'string', description: 'Optional: Title of the parent task (provides more context to AI). If not provided, it will be fetched.', nullable: true},
            parent_task_description: { type: 'string', description: 'Optional: Description of the parent task. If not provided, it will be fetched.', nullable: true },
            max_suggestions: { type: 'number', default: 5, minimum: 1, maximum: 10, description: 'Maximum number of subtasks to suggest.' },
            codebase_context_summary: { type: 'string', description: 'Optional: A summary string of relevant codebase context (e.g., related file names, function signatures).', nullable: true },
        },
        required: ['agent_id', 'plan_id', 'parent_task_id'],
        additionalProperties: false,
    },
    aiAnalyzePlan: {
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
            plan_id: { type: 'string', description: 'The ID of the plan to analyze.' },
            analysis_focus_areas: { 
                type: 'array', 
                items: { type: 'string' }, 
                nullable: true,
                description: 'Optional: Specific areas to focus the analysis on (e.g., "risk_assessment", "task_dependencies", "resource_allocation", "goal_alignment").' 
            },
            codebase_context_summary: { type: 'string', description: 'Optional: A summary string of relevant codebase context to consider during plan analysis.', nullable: true },
        },
        required: ['agent_id', 'plan_id'],
        additionalProperties: false,
    },
    aiSummarizeTaskProgress: {
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
            plan_id: { type: 'string', description: 'The ID of the plan for which progress is being summarized.' },
            task_id: { type: 'string', description: 'Optional: The ID of a specific task within the plan to focus the summary on. If omitted, summarizes progress for all tasks in the plan.', nullable: true },
            max_logs_to_consider: { type: 'number', default: 50, minimum: 1, maximum: 200, description: 'Maximum number of recent progress logs to consider for the summary.' },
        },
        required: ['agent_id', 'plan_id'],
        additionalProperties: false,
    },
    queryCodebaseEmbeddings: { 
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
                }
            },
            required: ['agent_id', 'query_text'],
            additionalProperties: false,
        },
    cleanUpEmbeddings: {
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
            }
        },
        required: ['agent_id', 'file_paths', 'project_root_path'],
        additionalProperties: false,
    },
    ingestCodebaseEmbeddings: {
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: "Agent ID to associate the embeddings with." },
            path_to_embed: { type: 'string', description: "The absolute path to the file or directory to embed." },
            project_root_path: {type: 'string', description: "The absolute root path of the project. Used to calculate relative paths for storing and linking embeddings."},
            is_directory: {type: 'boolean', default: false, description: "Set to true if 'path_to_embed' is a directory, false if it's a single file."},
            chunking_strategy: {
                type: 'string',
                enum: ['file', 'function', 'class', 'auto'],
                default: 'auto',
                description: "Strategy for chunking code before embedding ('file', 'function', 'class', or 'auto')."
            },
            disable_ai_output_summary: { type: 'boolean', default: false, description: "If true, disables the AI-generated summary of the embedding process results." },
            include_summary_patterns: {
                type: 'array',
                items: { type: 'string' },
                nullable: true,
                description: "Optional: Array of glob patterns to include specific files for AI summary generation. If provided, only files matching these patterns will have summaries generated."
            },
            exclude_summary_patterns: {
                type: 'array',
                items: { type: 'string' },
                nullable: true,
                description: "Optional: Array of glob patterns to exclude specific files from AI summary generation. Files matching these patterns will not have summaries generated."
            },
            storeEntitySummaries: { type: 'boolean', default: true, description: "Whether to store AI-generated summaries for code entities (classes, functions, methods) as embeddings." }
        },
        required: ['agent_id', 'path_to_embed', 'project_root_path'],
        additionalProperties: false,
    },
    ingestFileCodeEntities: {
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: "Agent ID to associate the KG data with." },
            file_path: { type: 'string', description: "The absolute path to the code file to parse." },
            project_root_path: {type: 'string', nullable: true, description: "Optional: The explicit root path of the project, used to make KG node names (like file paths for entities) relative and canonical. If not provided, file_path's directory might be used or behavior might be less predictable for relative naming."},
            language: { type: 'string', nullable: true, description: "Optional: Programming language of the file (e.g., 'typescript', 'python'). Helps select the correct parser and can be auto-detected if not provided." }
        },
        required: ['agent_id', 'file_path'],
        additionalProperties: false,
    },
    ingestCodebaseStructure: {
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: "Agent ID to associate the KG data with." },
            directory_path: { type: 'string', description: "The root path of the codebase directory to scan." },
            project_root_path: {type: 'string', nullable: true, description: "Optional: The explicit root path of the project, used to make KG node names (like file paths) relative and canonical. If not provided, directory_path might be used as the base for relative naming."},
            parse_imports: { type: 'boolean', default: true, description: "Whether to attempt to parse import statements from supported files." }
        },
        required: ['agent_id', 'directory_path'],
        additionalProperties: false,
    },
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
            source_attribution_id: { type: ['string', 'null'] },
        },
        required: ['agent_id', 'sender', 'message_content'],
        additionalProperties: false,
    },
    modeInstruction: {
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
            mode_name: { type: 'string', description: 'The name of the operational mode.' },
            instruction_content: { type: 'string', description: 'The detailed instruction content for the specified mode.' },
            instruction_version: { type: ['number', 'null'], description: 'Optional: Version of the instruction.' },
        },
        required: ['agent_id', 'mode_name', 'instruction_content'],
        additionalProperties: false,
    },
    contextInformation: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            context_type: { type: 'string' },
            context_data: { type: 'object' }, 
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
            full_content_json: { type: ['string', 'object', 'null'] },
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
            correction_summary: { type: ['string', 'null'] },
            applied_automatically: { type: 'boolean' },
            status: { type: 'string', default: 'LOGGED' },
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
            search_depth: { type: 'string', enum: ['basic', 'advanced'], default: 'basic' },
            max_results: { type: 'number', default: 5 },
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
            top_k: { type: 'number', default: 5, minimum: 1 }
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
            goal_description: { type: ['string', 'null'], description: "A natural language description of the overall goal for AI plan generation." },
            refined_prompt_id: { type: ['string', 'null'], description: "The ID of a pre-existing refined prompt to use for AI plan generation." },
            planData: {
                type: ['object', 'null'],
                properties: {
                    title: { type: 'string' },
                    overall_goal: { type: ['string', 'null'] },
                    status: { type: 'string', default: 'DRAFT' },
                    version: { type: 'number', default: 1 },
                    refined_prompt_id_associated: { type: ['string', 'null'] },
                    analysis_report_id_referenced: { type: ['string', 'null'] },
                    metadata: { type: ['object', 'null'] }
                },
                additionalProperties: true,
            },
            tasksData: {
                type: ['array', 'null'],
                items: {
                    type: 'object',
                    properties: {
                        task_number: { type: 'number' },
                        title: { type: 'string' },
                        description: { type: ['string', 'null'] },
                        status: { type: 'string', default: 'PLANNED' },
                        purpose: { type: ['string', 'null'] },
                        action_description: { type: ['string', 'null'] },
                        files_involved_json: { type: ['string', 'null'] }, 
                        dependencies_task_ids_json: { type: ['string', 'null'] }, 
                        tools_required_list_json: { type: ['string', 'null'] }, 
                        inputs_summary: { type: ['string', 'null'] },
                        outputs_summary: { type: ['string', 'null'] },
                        success_criteria_text: { type: ['string', 'null'] },
                        estimated_effort_hours: { type: ['number', 'null'] },
                        assigned_to: { type: ['string', 'null'] },
                        verification_method: { type: ['string', 'null'] },
                        notes_json: { type: ['string', 'null'] } 
                    },
                    additionalProperties: true, 
                },
            }
        },
        required: ['agent_id'],
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
            limit: { type: 'number', default: 100 },
            offset: { type: 'number', default: 0 }
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
            limit: { type: 'number', default: 100 },
            offset: { type: 'number', default: 0 }
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
    updateTaskDetails: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            task_id: { type: 'string' },
            title: { type: ['string', 'null'] },
            description: { type: ['string', 'null'] },
            status: { type: ['string', 'null'] }, // Renamed from new_status and made nullable
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
            notes: { type: ['object', 'null'] },
            completion_timestamp: { type: ['number', 'null'] }
        },
        required: ['agent_id', 'task_id'],
        additionalProperties: false,
    },
    deleteTaskPlans: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            plan_ids: { type: 'array', items: { type: 'string' } }
        },
        required: ['agent_id', 'plan_ids'],
        additionalProperties: false,
    },
    deleteTasks: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            task_ids: { type: 'array', items: { type: 'string' } }
        },
        required: ['agent_id', 'task_ids'],
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
                    status: { type: 'string', default: 'PLANNED' },
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
                additionalProperties: true, 
            }
        },
        required: ['agent_id', 'plan_id', 'taskData'],
        additionalProperties: false,
    },
    refineUserPrompt: {
        type: 'object',
        properties: {
            agent_id: { type: 'string', description: "Identifier of the AI agent (e.g., 'cline')." },
            raw_user_prompt: { type: 'string', description: "The raw text prompt received from the user." },
            target_ai_persona: {
              type: ['string', 'null'],
              description: "Optional: A suggested persona for the AI agent to adopt for the task (e.g., 'expert Python developer', 'technical writer').",
              default: null
            },
            conversation_context_ids: {
              type: ['array', 'null'],
              items: { type: 'string' },
              description: "Optional: Array of recent conversation_ids or context_ids that might provide immediate context for the refinement, if available to the agent.",
              default: null
            },
            context_options: {
                type: 'object',
                properties: {
                    topKEmbeddings: { type: 'number', default: 3 },
                    topKKgResults: { type: 'number', default: 3 },
                    embeddingScoreThreshold: { type: 'number', default: 0.5 },
                    kgQueryDepth: { type: 'number', description: "Optional: Depth for Knowledge Graph queries.", nullable: true },
                    includeFileContent: { type: 'boolean', description: "Optional: Whether to include full file content for retrieved files.", nullable: true },
                    targetFilePaths: {
                        type: 'array',
                        items: { type: 'string' },
                        description: "Optional: Array of relative file paths to restrict context retrieval to.",
                        nullable: true
                    }
                },
                additionalProperties: false,
                nullable: true
            }
        },
        required: ['agent_id', 'raw_user_prompt'],
        additionalProperties: false,
    },
    addSubtaskToPlan: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            plan_id: { type: 'string' },
            parent_task_id: { type: ['string', 'null'] },
            subtaskData: {
                anyOf: [
                    {
                        type: 'object',
                        properties: {
                            title: { type: 'string' },
                            description: { type: ['string', 'null'] },
                            status: { type: 'string' },
                            notes: { type: ['object', 'null'] }
                        },
                        required: ['title'],
                        additionalProperties: false
                    },
                    {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                title: { type: 'string' },
                                description: { type: ['string', 'null'] },
                                status: { type: 'string' },
                                notes: { type: ['object', 'null'] }
                            },
                            required: ['title'],
                            additionalProperties: false
                        }
                    }
                ]
            }
        },
        required: ['agent_id', 'plan_id', 'subtaskData'],
        additionalProperties: false
    },
    getSubtasks: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            plan_id: { type: ['string', 'null'] },
            parent_task_id: { type: ['string', 'null'] },
            status_filter: { type: ['string', 'null'] },
            limit: { type: 'number', default: 100 },
            offset: { type: 'number', default: 0 }
        },
        required: ['agent_id'],
        additionalProperties: false
    },
    updateSubtaskDetails: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            subtask_id: { type: 'string' },
            title: { type: ['string', 'null'] },
            description: { type: ['string', 'null'] },
            status: { type: ['string', 'null'] }, // Renamed from new_status and made nullable
            notes: { type: ['object', 'null'] },
            completion_timestamp: { type: ['number', 'null'] }
        },
        required: ['agent_id', 'subtask_id'],
        additionalProperties: false
    },
    deleteSubtasks: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            subtask_ids: { type: 'array', items: { type: 'string' } }
        },
        required: ['agent_id', 'subtask_ids'],
        additionalProperties: false
    },
    create_task_review_log: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            plan_id: { type: 'string' },
            task_id: { type: 'string' },
            reviewer: { type: ['string', 'null'] },
            review_status: { type: 'string' }, 
            review_notes_md: { type: ['string', 'null'] },
            issues_found_json: { type: ['string', 'null'] }, 
            resolution_notes_md: { type: ['string', 'null'] }
        },
        required: ['agent_id', 'plan_id', 'task_id', 'review_status'],
        additionalProperties: false
    },
    get_task_review_logs: {
        type: 'object',
        properties: {
            agent_id: { type: ['string', 'null'] },
            plan_id: { type: ['string', 'null'] },
            task_id: { type: ['string', 'null'] },
            review_status: { type: ['string', 'null'] }
        },
        additionalProperties: false 
    },
    update_task_review_log: {
        type: 'object',
        properties: {
            review_log_id: { type: 'string' },
            updates: { 
                type: 'object',
                additionalProperties: true 
            }
        },
        required: ['review_log_id', 'updates'],
        additionalProperties: false
    },
    delete_task_review_log: {
        type: 'object',
        properties: {
            review_log_id: { type: 'string' }
        },
        required: ['review_log_id'],
        additionalProperties: false
    },
    create_final_plan_review_log: {
        type: 'object',
        properties: {
            agent_id: { type: 'string' },
            plan_id: { type: 'string' },
            reviewer: { type: ['string', 'null'] },
            review_status: { type: 'string' },
            review_notes_md: { type: ['string', 'null'] },
            issues_found_json: { type: ['string', 'null'] },
            resolution_notes_md: { type: ['string', 'null'] }
        },
        required: ['agent_id', 'plan_id', 'review_status'],
        additionalProperties: false
    },
    get_final_plan_review_logs: {
        type: 'object',
        properties: {
            agent_id: { type: ['string', 'null'] },
            plan_id: { type: ['string', 'null'] },
            review_status: { type: ['string', 'null'] }
        },
        additionalProperties: false
    },
    update_final_plan_review_log: {
        type: 'object',
        properties: {
            final_review_log_id: { type: 'string' },
            updates: { 
                type: 'object',
                additionalProperties: true 
            }
        },
        required: ['final_review_log_id', 'updates'],
        additionalProperties: false
    },
    delete_final_plan_review_log: {
        type: 'object',
        properties: {
            final_review_log_id: { type: 'string' }
        },
        required: ['final_review_log_id'],
        additionalProperties: false
    },
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
        console.error(`Schema "${schemaName}" not found during validation lookup. Available schemas:`, Object.keys(ajv.schemas));
        throw new Error(`Schema "${schemaName}" not found.`);
    }
    const valid = validateFn(data);
    if (!valid) {
        return { valid: false, errors: validateFn.errors };
    }
    return { valid: true, errors: null };
}
