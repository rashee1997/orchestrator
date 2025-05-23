#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { MemoryManager } from './database/memory_manager.js';
import { callTavilyApi } from './integrations/tavily.js';
import { validate, schemas } from './utils/validation.js';

class MemoryMcpServer {
    private server!: Server;
    private memoryManager!: MemoryManager;

    private constructor() {
        // Private constructor to enforce async factory
    }

    public static async create(): Promise<MemoryMcpServer> {
        const instance = new MemoryMcpServer();
        instance.memoryManager = await MemoryManager.create(); // Initialize asynchronously
        instance.server = new Server(
            {
                name: 'memory-mcp-server',
                version: '0.1.0',
                description: 'A Model Context Protocol server for persistent memory management in AI agents using SQLite.'
            },
            {
                capabilities: {
                    tools: {
                        // Add knowledge graph memory tool
                        'knowledge_graph_memory': {
                            name: 'knowledge_graph_memory',
                            description: 'A tool for interacting with the knowledge graph memory.',
                            inputSchema: {
                                type: 'object',
                                properties: {
                                    agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                                    operation: { type: 'string', description: 'Operation to perform (e.g., "get", "set", "delete").' },
                                    key: { type: 'string', description: 'Key for the memory entry.' },
                                    value: { type: 'string', description: 'Value for the memory entry (for "set" operations).' },
                                },
                                required: ['agent_id', 'operation', 'key'],
                            },
                        },
                    },
                },
            }
        );

        instance.setupToolHandlers();

        // Error handling
        instance.server.onerror = (error) => console.error('[MCP Error]', error);
        process.on('SIGINT', async () => {
            await instance.server.close();
            process.exit(0);
        });

        return instance;
    }

    private setupToolHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                // Conversation History Tools
                {
                    name: 'store_conversation_message',
                    description: 'Stores a message in the conversation history.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                            user_id: { type: 'string', description: 'Identifier of the user (optional).' },
                            sender: { type: 'string', description: 'Role of the sender (e.g., user, agent, system).' },
                            message_content: { type: 'string', description: 'The actual text of the message.' },
                            message_type: { type: 'string', description: 'Type of message (e.g., text, image, tool_call, tool_output).', default: 'text' },
                            tool_info: { type: 'string', description: 'JSON string for tool calls/outputs (tool_name, args, result).', nullable: true },
                            context_snapshot_id: { type: 'string', description: 'Foreign key to context_information table.', nullable: true },
                            source_attribution_id: { type: 'string', description: 'Foreign key to source_attribution table.', nullable: true },
                        },
                        required: ['agent_id', 'sender', 'message_content'],
                    },
                },
                {
                    name: 'get_conversation_history',
                    description: 'Retrieves conversation history for a given agent and optional conversation ID.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                            conversation_id: { type: 'string', description: 'Optional unique identifier for a specific conversation.', nullable: true },
                            limit: { type: 'number', description: 'Maximum number of messages to retrieve.', default: 100 },
                            offset: { type: 'number', description: 'Offset for pagination.', default: 0 },
                        },
                        required: ['agent_id'],
                    },
                },
                // Context Information Tools
                {
                    name: 'store_context',
                    description: 'Stores dynamic contextual data for an AI agent.',
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
                    description: 'Retrieves contextual data for a given agent and context type, optionally by version or a specific snippet index.',
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
                    description: 'Retrieves all contextual data for a given agent.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                        },
                        required: ['agent_id'],
                    },
                },
                // Reference Keys Tools
                {
                    name: 'add_reference_key',
                    description: 'Adds a reference key to an external knowledge source or internal memory entry.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                            key_type: { type: 'string', description: 'Type of reference (e.g., document_id, memory_entry_id, external_api_id).' },
                            key_value: { type: 'string', description: 'The actual key/identifier.' },
                            description: { type: 'string', description: 'Human-readable description of what the key references.', nullable: true },
                            associated_conversation_id: { type: 'string', description: 'Optional, link to conversation.', nullable: true },
                        },
                        required: ['agent_id', 'key_type', 'key_value'],
                    },
                },
                {
                    name: 'get_reference_keys',
                    description: 'Retrieves reference keys for a given agent, optionally filtered by key type.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                            key_type: { type: 'string', description: 'Optional type of reference to filter by.', nullable: true },
                            limit: { type: 'number', description: 'Maximum number of keys to retrieve.', default: 100 },
                            offset: { type: 'number', description: 'Offset for pagination.', default: 0 },
                        },
                        required: ['agent_id'],
                    },
                },
                // Source Attribution Tools
                {
                    name: 'log_source_attribution',
                    description: 'Logs the origin of information used or generated by the AI agent.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                            source_type: { type: 'string', description: 'Type of source (e.g., user_input, tavily_search, internal_reasoning).' },
                            source_uri: { type: 'string', description: 'URI or identifier of the source (e.g., URL for web, query for Tavily).', nullable: true },
                            retrieval_timestamp: { type: 'number', description: 'Unix timestamp of when the information was retrieved.' },
                            content_summary: { type: 'string', description: 'Brief summary of the attributed content.', nullable: true },
                            full_content_hash: { type: 'string', description: 'Optional, hash of the full content for integrity checking.', nullable: true },
                        },
                        required: ['agent_id', 'source_type', 'retrieval_timestamp'],
                    },
                },
                {
                    name: 'get_source_attributions',
                    description: 'Retrieves source attributions for a given agent, optionally filtered by source type.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                            source_type: { type: 'string', description: 'Optional type of source to filter by.', nullable: true },
                            limit: { type: 'number', description: 'Maximum number of attributions to retrieve.', default: 100 },
                            offset: { type: 'number', description: 'Offset for pagination.', default: 0 },
                        },
                        required: ['agent_id'],
                    },
                },
                // Correction Logs Tools
                {
                    name: 'log_correction',
                    description: 'Records instances where the AI agent\'s output or internal state was corrected.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                            correction_type: { type: 'string', description: 'Type of correction (e.g., user_feedback, self_correction, system_override).' },
                            original_entry_id: { type: 'string', description: 'ID of the memory entry that was corrected (e.g., conversation_id, context_id).', nullable: true },
                            original_value: { type: 'object', description: 'JSON object of the original data before correction.', nullable: true },
                            corrected_value: { type: 'object', description: 'JSON object of the corrected data.', nullable: true },
                            reason: { type: 'string', description: 'Explanation for the correction.', nullable: true },
                            applied_automatically: { type: 'boolean', description: 'True if applied by system, false if manual.' },
                        },
                        required: ['agent_id', 'correction_type', 'applied_automatically'],
                    },
                },
                {
                    name: 'get_correction_logs',
                    description: 'Retrieves correction logs for a given agent, optionally filtered by correction type.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                            correction_type: { type: 'string', description: 'Optional type of correction to filter by.', nullable: true },
                            limit: { type: 'number', description: 'Maximum number of logs to retrieve.', default: 100 },
                            offset: { type: 'number', description: 'Offset for pagination.', default: 0 },
                        },
                        required: ['agent_id'],
                    },
                },
                // Success Metrics Tools
                {
                    name: 'log_success_metric',
                    description: 'Logs quantitative and qualitative metrics related to the AI agent\'s performance.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                            metric_name: { type: 'string', description: 'Name of the metric (e.g., task_completion_rate, response_latency_ms).' },
                            metric_value: { type: 'number', description: 'The numerical value of the metric.' },
                            unit: { type: 'string', description: 'Unit of the metric (e.g., percent, ms, score).', nullable: true },
                            associated_task_id: { type: 'string', description: 'Optional, link to a specific task.', nullable: true },
                            metadata: { type: 'object', description: 'JSON object for additional metric-specific data.', nullable: true },
                        },
                        required: ['agent_id', 'metric_name', 'metric_value'],
                    },
                },
                {
                    name: 'get_success_metrics',
                    description: 'Retrieves success metrics for a given agent, optionally filtered by metric name.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                            metric_name: { type: 'string', description: 'Optional name of the metric to filter by.', nullable: true },
                            limit: { type: 'number', description: 'Maximum number of metrics to retrieve.', default: 100 },
                            offset: { type: 'number', description: 'Offset for pagination.', default: 0 },
                        },
                        required: ['agent_id'],
                    },
                },
                // Tavily Web Search Tool
                {
                    name: 'tavily_web_search',
                    description: 'Performs a Tavily web search and returns results. Source attribution should be logged separately by the calling agent using the log_search_attribution tool.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            query: { type: 'string', description: 'The search query.' },
                            search_depth: { type: 'string', enum: ['basic', 'advanced'], default: 'basic', description: 'Depth of the search.' },
                            max_results: { type: 'number', default: 5, description: 'Maximum number of search results to return.' },
                        },
                        required: ['query'],
                    },
                },
                // Log Search Attribution Tool
                {
                    name: 'log_search_attribution',
                    description: 'Logs the attribution details for a completed web search.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent_id: { type: 'string', description: 'Identifier of the AI agent that performed the search.' },
                            query: { type: 'string', description: 'The original search query.' },
                            search_results_summary: { type: 'string', description: 'A summary of the search results.', nullable: true },
                            retrieval_timestamp: { type: 'number', description: 'Unix timestamp of when the search was performed.' },
                            source_uri: { type: 'string', description: 'The URI of the search (e.g., the query string itself).', nullable: true },
                            full_content_hash: { type: 'string', description: 'Optional hash of the full content for integrity checking.', nullable: true }
                        },
                        required: ['agent_id', 'query', 'retrieval_timestamp'],
                    },
                },
                // New: Search Context by Keywords Tool
                {
                    name: 'search_context_by_keywords',
                    description: 'Searches stored contextual data (specifically documentation snippets) by keywords.',
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
                // New: Context Pruning/Archiving Tool
                {
                    name: 'prune_old_context',
                    description: 'Deletes old context entries based on a specified age (in milliseconds).',
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
                // New: Summarization Tool (Placeholder)
                {
                    name: 'summarize_context',
                    description: 'Generates a summary of stored contextual data. (Placeholder: Requires external NLP integration for full functionality).',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                            context_type: { type: 'string', description: 'Category of context to summarize.' },
                            version: { type: 'number', description: 'Optional specific version of the context to summarize. If not provided, the latest version is summarized.', nullable: true }
                        },
                        required: ['agent_id', 'context_type'],
                    },
                },
                // New: Entity and Keyword Extraction Tool (Placeholder)
                {
                    name: 'extract_entities',
                    description: 'Extracts key entities and keywords from stored contextual data. (Placeholder: Requires external NLP integration for full functionality).',
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
                // New: Semantic Search / Vector Embedding Tool (Placeholder)
                {
                    name: 'semantic_search_context',
                    description: 'Performs a semantic search on stored contextual data using vector embeddings. (Placeholder: Requires external embedding model integration for full functionality).',
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
                // New: Export Data to CSV Tool
                {
                    name: 'export_data_to_csv',
                    description: 'Exports data from a specified database table to a CSV file.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            tableName: { type: 'string', description: 'The name of the database table to export.' },
                            filePath: { type: 'string', description: 'The path where the CSV file will be saved.' }
                        },
                        required: ['tableName', 'filePath'],
                    },
                },
                // New: Backup Database Tool
                {
                    name: 'backup_database',
                    description: 'Creates a backup copy of the SQLite database file.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            backupFilePath: { type: 'string', description: 'The path where the database backup file will be saved.' }
                        },
                        required: ['backupFilePath'],
                    },
                },
                // New: Restore Database Tool
                {
                    name: 'restore_database',
                    description: 'Restores the SQLite database from a specified backup file. WARNING: This will overwrite the current database.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            backupFilePath: { type: 'string', description: 'The path to the database backup file to restore from.' }
                        },
                        required: ['backupFilePath'],
                    },
                },
                // New: Plan and Task Management Tools
                {
                    name: 'create_task_plan',
                    description: 'Creates a new task plan with its initial set of tasks.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
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
                },
                {
                    name: 'get_task_plan_details',
                    description: 'Retrieves details for a specific task plan.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                            plan_id: { type: 'string', description: 'Unique ID of the plan.' }
                        },
                        required: ['agent_id', 'plan_id'],
                        additionalProperties: false,
                    },
                },
                {
                    name: 'list_task_plans',
                    description: 'Lists task plans for an agent, optionally filtered by status.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                            status_filter: { type: ['string', 'null'], description: 'Optional: Filter plans by status (e.g., "DRAFT", "IN_PROGRESS").' },
                            limit: { type: 'number', description: 'Maximum number of plans to retrieve.', default: 100 },
                            offset: { type: 'number', description: 'Offset for pagination.', default: 0 }
                        },
                        required: ['agent_id'],
                        additionalProperties: false,
                    },
                },
                {
                    name: 'get_plan_tasks',
                    description: 'Retrieves tasks for a specific plan, optionally filtered by status.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                            plan_id: { type: 'string', description: 'Unique ID of the plan.' },
                            status_filter: { type: ['string', 'null'], description: 'Optional: Filter tasks by status (e.g., "PLANNED", "COMPLETED").' },
                            limit: { type: 'number', description: 'Maximum number of tasks to retrieve.', default: 100 },
                            offset: { type: 'number', description: 'Offset for pagination.', default: 0 }
                        },
                        required: ['agent_id', 'plan_id'],
                        additionalProperties: false,
                    },
                },
                {
                    name: 'update_task_plan_status',
                    description: 'Updates the status of a specified task plan.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                            plan_id: { type: 'string', description: 'Unique ID of the plan to update.' },
                            new_status: { type: 'string', description: 'The new status for the plan.' }
                        },
                        required: ['agent_id', 'plan_id', 'new_status'],
                        additionalProperties: false,
                    },
                },
                {
                    name: 'update_plan_task_status',
                    description: 'Updates the status of a specific task within a plan.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                            task_id: { type: 'string', description: 'Unique ID of the task to update.' },
                            new_status: { type: 'string', description: 'The new status for the task.' },
                            completion_timestamp: { type: ['number', 'null'], description: 'Optional: Unix timestamp when the task was completed/failed.' }
                        },
                        required: ['agent_id', 'task_id', 'new_status'],
                        additionalProperties: false,
                    },
                },
                {
                    name: 'delete_task_plan',
                    description: 'Deletes a task plan and all its associated tasks.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                            plan_id: { type: 'string', description: 'Unique ID of the plan to delete.' }
                        },
                        required: ['agent_id', 'plan_id'],
                        additionalProperties: false,
                    },
                },
            ],
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            try {
                const { name, arguments: args } = request.params;

                if (!args) {
                    throw new McpError(
                        ErrorCode.InvalidParams,
                        `Missing arguments for tool: ${name}`
                    );
                }

                // Note: agent_id is required for most memory operations, but not for tavily_web_search or list_tools itself.
                // We'll handle it conditionally.
                let agent_id: string | undefined;
                if (name !== 'tavily_web_search' && name !== 'list_tools' && name !== 'export_data_to_csv' && name !== 'backup_database' && name !== 'restore_database') {
                    agent_id = args.agent_id as string;
                    if (!agent_id) {
                        throw new McpError(
                            ErrorCode.InvalidParams,
                            `Tool ${name} requires 'agent_id'.`
                        );
                    }
                }

                // Perform input validation based on tool name
                let validationResult;
                switch (name) {
                    case 'store_conversation_message':
                        validationResult = validate('conversationMessage', args);
                        break;
                    case 'store_context':
                        validationResult = validate('contextInformation', args);
                        break;
                    case 'add_reference_key':
                        validationResult = validate('referenceKey', args);
                        break;
                    case 'log_source_attribution':
                        validationResult = validate('sourceAttribution', args);
                        break;
                    case 'log_correction':
                        validationResult = validate('correctionLog', args);
                        break;
                    case 'log_success_metric':
                        validationResult = validate('successMetric', args);
                        break;
                    case 'tavily_web_search': // New tool name
                        validationResult = validate('tavilySearch', args); // Reuse existing schema
                        break;
                    case 'log_search_attribution': // New tool
                        validationResult = validate('sourceAttribution', { // Reuse sourceAttribution schema
                            agent_id: args.agent_id,
                            source_type: 'tavily_search', // Fixed type
                            source_uri: args.query, // Use query as URI
                            retrieval_timestamp: args.retrieval_timestamp,
                            content_summary: args.search_results_summary,
                            full_content_hash: args.full_content_hash
                        });
                        break;
                    case 'search_context_by_keywords': // New tool
                        validationResult = validate('searchContextByKeywords', args); // New schema for this tool
                        break;
                    case 'prune_old_context': // New tool
                        validationResult = validate('pruneOldContext', args); // New schema for this tool
                        break;
                    case 'summarize_context': // New tool
                        validationResult = validate('summarizeContext', args); // New schema for this tool
                        break;
                    case 'extract_entities': // New tool
                        validationResult = validate('extractEntities', args); // New schema for this tool
                        break;
                    case 'semantic_search_context': // New tool
                        validationResult = validate('semanticSearchContext', args); // New schema for this tool
                        break;
                    case 'analyze_image_content': // New tool
                        validationResult = validate('analyzeImageContent', args); // New schema for this tool
                        break;
                    case 'export_data_to_csv': // New tool
                        validationResult = validate('exportDataToCsv', args);
                        break;
                    case 'backup_database': // New tool
                        validationResult = validate('backupDatabase', args);
                        break;
                    case 'restore_database': // New tool
                        validationResult = validate('restoreDatabase', args);
                        break;
                    case 'create_task_plan': // New tool
                        validationResult = validate('createTaskPlan', args);
                        break;
                    case 'get_task_plan_details': // New tool
                        validationResult = validate('getTaskPlanDetails', args);
                        break;
                    case 'list_task_plans': // New tool
                        validationResult = validate('listTaskPlans', args);
                        break;
                    case 'get_plan_tasks': // New tool
                        validationResult = validate('getPlanTasks', args);
                        break;
                    case 'update_task_plan_status': // New tool
                        validationResult = validate('updateTaskPlanStatus', args);
                        break;
                    case 'update_plan_task_status': // New tool
                        validationResult = validate('updatePlanTaskStatus', args);
                        break;
                    case 'delete_task_plan': // New tool
                        validationResult = validate('deleteTaskPlan', args);
                        break;
                    // For 'get' operations, validation is often simpler and handled by optional parameters
                    default:
                        validationResult = { valid: true, errors: null }; // No specific schema for get operations
                }

                if (!validationResult.valid) {
                    throw new McpError(
                        ErrorCode.InvalidParams,
                        `Validation failed for tool ${name}: ${JSON.stringify(validationResult.errors)}`
                    );
                }

                switch (name) {
                    case 'knowledge_graph_memory':
                        const operation = args.operation as string;
                        const key = args.key as string;
                        const value = args.value; // Can be any type, including null for 'delete'

                        let kgResult;
                        switch (operation) {
                            case 'create_entities':
                                kgResult = await this.memoryManager.createEntities(agent_id!, args.entities as Array<{ name: string; entityType: string; observations: string[] }>);
                                break;
                            case 'create_relations':
                                kgResult = await this.memoryManager.createRelations(agent_id!, args.relations as Array<{ from: string; to: string; relationType: string }>);
                                break;
                            case 'add_observations':
                                kgResult = await this.memoryManager.addObservations(agent_id!, args.observations as Array<{ entityName: string; contents: string[] }>);
                                break;
                            case 'delete_entities':
                                kgResult = await this.memoryManager.deleteEntities(agent_id!, args.entityNames as string[]);
                                break;
                            case 'delete_observations':
                                kgResult = await this.memoryManager.deleteObservations(agent_id!, args.deletions as Array<{ entityName: string; observations: string[] }>);
                                break;
                            case 'delete_relations':
                                kgResult = await this.memoryManager.deleteRelations(agent_id!, args.relations as Array<{ from: string; to: string; relationType: string }>);
                                break;
                            case 'read_graph':
                                kgResult = await this.memoryManager.readGraph(agent_id!);
                                break;
                            case 'search_nodes':
                                kgResult = await this.memoryManager.searchNodes(agent_id!, args.query as string);
                                break;
                            case 'open_nodes':
                                kgResult = await this.memoryManager.openNodes(agent_id!, args.names as string[]);
                                break;
                            default:
                                throw new McpError(
                                    ErrorCode.InvalidParams,
                                    `Unknown knowledge_graph_memory operation: ${operation}`
                                );
                        }
                        return { content: [{ type: 'text', text: JSON.stringify(kgResult, null, 2) }] };

                    case 'store_conversation_message':
                        const convId = await this.memoryManager.storeConversationMessage(
                            agent_id!,
                            args.user_id as string | null,
                            args.sender as string,
                            args.message_content as string,
                            args.message_type as string,
                            args.tool_info as string | null,
                            args.context_snapshot_id as string | null,
                            args.source_attribution_id as string | null
                        );
                        return { content: [{ type: 'text', text: `Conversation message stored with ID: ${convId}` }] };

                    case 'get_conversation_history':
                        const history = await this.memoryManager.getConversationHistory(
                            agent_id!,
                            args.conversation_id as string | null,
                            args.limit as number,
                            args.offset as number
                        );
                        return { content: [{ type: 'text', text: JSON.stringify(history, null, 2) }] };

                    case 'store_context':
                        const contextId = await this.memoryManager.storeContext(
                            agent_id!,
                            args.context_type as string,
                            args.context_data,
                            args.parent_context_id as string | null
                        );
                        return { content: [{ type: 'text', text: `Context stored with ID: ${contextId}` }] };

                    case 'get_context':
                        const context = await this.memoryManager.getContext(
                            agent_id!,
                            args.context_type as string,
                            args.version as number | null,
                            args.snippet_index as number | null // Pass the new parameter
                        );
                        // Modified logic to return rich text if content is markdown
                        if (context && typeof context.content === 'string') {
                            return { content: [{ type: 'markdown', markdown: context.content }] };
                        }
                        return { content: [{ type: 'text', text: JSON.stringify(context, null, 2) }] };

                    case 'get_all_contexts':
                        const allContexts = await this.memoryManager.getAllContexts(agent_id!);
                        return { content: [{ type: 'text', text: JSON.stringify(allContexts, null, 2) }] };

                    case 'add_reference_key':
                        const refId = await this.memoryManager.addReferenceKey(
                            agent_id!,
                            args.key_type as string,
                            args.key_value as string,
                            args.description as string | null,
                            args.associated_conversation_id as string | null
                        );
                        return { content: [{ type: 'text', text: `Reference key added with ID: ${refId}` }] };

                    case 'get_reference_keys':
                        const refKeys = await this.memoryManager.getReferenceKeys(
                            agent_id!,
                            args.key_type as string | null,
                            args.limit as number,
                            args.offset as number
                        );
                        return { content: [{ type: 'text', text: JSON.stringify(refKeys, null, 2) }] };

                    case 'log_source_attribution':
                        const attrId = await this.memoryManager.logSourceAttribution(
                            agent_id!,
                            args.source_type as string,
                            args.source_uri as string | null,
                            args.retrieval_timestamp as number,
                            args.content_summary as string | null,
                            args.full_content_hash as string | null
                        );
                        return { content: [{ type: 'text', text: `Source attribution logged with ID: ${attrId}` }] };

                    case 'get_source_attributions':
                        const attributions = await this.memoryManager.getSourceAttributions(
                            agent_id!,
                            args.source_type as string | null,
                            args.limit as number,
                            args.offset as number
                        );
                        return { content: [{ type: 'text', text: JSON.stringify(attributions, null, 2) }] };

                    case 'log_correction':
                        const corrId = await this.memoryManager.logCorrection(
                            agent_id!,
                            args.correction_type as string,
                            args.original_entry_id as string | null,
                            args.original_value,
                            args.corrected_value,
                            args.reason as string | null,
                            args.applied_automatically as boolean
                        );
                        return { content: [{ type: 'text', text: `Correction logged with ID: ${corrId}` }] };

                    case 'get_correction_logs':
                        const corrections = await this.memoryManager.getCorrectionLogs(
                            agent_id!,
                            args.correction_type as string | null,
                            args.limit as number,
                            args.offset as number
                        );
                        return { content: [{ type: 'text', text: JSON.stringify(corrections, null, 2) }] };

                    case 'log_success_metric':
                        const metricId = await this.memoryManager.logSuccessMetric(
                            agent_id!,
                            args.metric_name as string,
                            args.metric_value as number,
                            args.unit as string | null,
                            args.associated_task_id as string | null,
                            args.metadata
                        );
                        return { content: [{ type: 'text', text: `Success metric logged with ID: ${metricId}` }] };

                    case 'get_success_metrics':
                        const metrics = await this.memoryManager.getSuccessMetrics(
                            agent_id!,
                            args.metric_name as string | null,
                            args.limit as number,
                            args.offset as number
                        );
                        return { content: [{ type: 'text', text: JSON.stringify(metrics, null, 2) }] };

                    case 'tavily_web_search': // New tool name
                        const queryForTavily = args.query as string;
                        const searchDepthForTavily = args.search_depth as 'basic' | 'advanced';
                        const maxResultsForTavily = args.max_results as number;

                        console.log(`[DEBUG] Calling callTavilyApi with: query='${queryForTavily}', search_depth='${searchDepthForTavily}', max_results=${maxResultsForTavily}`);

                        const tavilySearchResults = await callTavilyApi( // Renamed variable
                            queryForTavily,
                            searchDepthForTavily,
                            maxResultsForTavily
                        );
                        // The calling agent is now responsible for logging source attribution
                        return { content: [{ type: 'text', text: JSON.stringify(tavilySearchResults, null, 2) }] };

                    case 'log_search_attribution': // New tool
                        const attributionSummary = args.search_results_summary as string | null;
                        const retrievalTimestamp = args.retrieval_timestamp as number;
                        const sourceUri = args.query as string; // Using query as source_uri
                        const fullContentHash = args.full_content_hash as string | null;
                        const fullContentJson = args.full_content_json as string | null; // New parameter

                        const newAttrId = await this.memoryManager.logSourceAttribution(
                            agent_id!,
                            'tavily_search', // Fixed source_type
                            sourceUri,
                            retrievalTimestamp,
                            attributionSummary,
                            fullContentHash,
                            fullContentJson // Pass the new parameter
                        );
                        return { content: [{ type: 'text', text: `Search attribution logged with ID: ${newAttrId}` }] };

                    case 'search_context_by_keywords': // New tool handler
                        const searchResults = await this.memoryManager.searchContextByKeywords(
                            agent_id!,
                            args.context_type as string,
                            args.keywords as string
                        );
                        return { content: [{ type: 'text', text: JSON.stringify(searchResults, null, 2) }] };

                    case 'prune_old_context': // New tool handler
                        const deletedCount = await this.memoryManager.pruneOldContext(
                            agent_id!,
                            args.max_age_ms as number,
                            args.context_type as string | null
                        );
                        return { content: [{ type: 'text', text: `Deleted ${deletedCount} old context entries.` }] };

                    case 'summarize_context': // New tool handler
                        const summary = await this.memoryManager.summarizeContext(
                            agent_id!,
                            args.context_type as string,
                            args.version as number | null
                        );
                        return { content: [{ type: 'text', text: summary }] };

                    case 'extract_entities': // New tool handler
                        const extractedData = await this.memoryManager.extractEntities(
                            agent_id!,
                            args.context_type as string,
                            args.version as number | null
                        );
                        return { content: [{ type: 'text', text: JSON.stringify(extractedData, null, 2) }] };

                    case 'semantic_search_context': // New tool handler
                        const semanticResults = await this.memoryManager.semanticSearchContext(
                            agent_id!,
                            args.context_type as string,
                            args.query_text as string,
                            args.top_k as number
                        );
                        return { content: [{ type: 'text', text: JSON.stringify(semanticResults, null, 2) }] };

                    case 'export_data_to_csv': // New tool handler
                        const exportResult = await this.memoryManager.exportDataToCsv(
                            args.tableName as string,
                            args.filePath as string
                        );
                        return { content: [{ type: 'text', text: exportResult }] };

                    case 'backup_database': // New tool handler
                        const backupResult = await this.memoryManager.backupDatabase(
                            args.backupFilePath as string
                        );
                        return { content: [{ type: 'text', text: backupResult }] };

                    case 'restore_database': // New tool handler
                        const restoreResult = await this.memoryManager.restoreDatabase(
                            args.backupFilePath as string
                        );
                        return { content: [{ type: 'text', text: restoreResult }] };

                    default:
                        throw new McpError(
                            ErrorCode.MethodNotFound,
                            `Unknown tool: ${name}`
                        );
                }
            } catch (error: any) {
                console.error(`Error handling tool call ${request.params.name}:`, error);
                throw new McpError(
                    ErrorCode.InternalError,
                    `Failed to execute tool ${request.params.name}: ${error.message}`
                );
            }
        });
    }

    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error('Memory MCP server running on stdio');
    }
}

const server = await MemoryMcpServer.create();
server.run().catch(console.error);
