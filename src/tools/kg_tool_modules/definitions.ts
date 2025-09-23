import { schemas } from '../../utils/validation.js';

export const knowledgeGraphToolDefinitions = [
    {
        name: 'ingest_codebase_structure',
        description: `Scans a specified directory, creating or updating knowledge graph nodes for files and folders.
It establishes 'contains_item' relationships. If 'parse_imports' is true, it parses import statements
from supported files, creates/updates 'module' nodes, and creates 'imports_file' or 'imports_module' relationships.
This tool aims to be idempotent, avoiding duplicate nodes for the same entities by updating existing ones if changes are detected. Output is Markdown formatted.`,
        inputSchema: {
            ...schemas.ingestCodebaseStructure,
            properties: {
                ...schemas.ingestCodebaseStructure.properties,
                perform_deep_entity_ingestion: { type: 'boolean', default: false, description: "If true, performs a full code entity parse on every valid file found in the scan." }
            }
        },
    },
    {
        name: 'ingest_file_code_entities',
        description: `Parses a specified code file to extract detailed code entities like functions, classes, and interfaces.
It populates these as nodes in the knowledge graph (creating or updating them if they exist by checking name and type)
and creates 'defined_in_file' relationships linking them to their parent file node.
It may also create 'has_method' relationships for classes. Output is Markdown formatted.`,
        inputSchema: {
            ...schemas.ingestFileCodeEntities,
            properties: {
                ...schemas.ingestFileCodeEntities.properties,
                paths: {
                    oneOf: [
                        { type: 'string', description: "A single absolute path to a code file to parse." },
                        { type: 'array', items: { type: 'string' }, description: "An array of absolute paths to code files to parse." }
                    ],
                    description: "A single file path or an array of file paths to parse for code entities."
                }
            },
            required: ['agent_id', 'paths']
        },
    },
    {
        name: 'knowledge_graph_memory',
        description: `A tool for interacting with the knowledge graph memory. Output is Markdown formatted. Supported operations:
- "create_entities": Adds new entities (nodes) to the graph. If an entity with the same name and type already exists, it will attempt to update its observations instead of creating a duplicate.
- "create_relations": Adds new relationships between existing entities. Avoids creating exact duplicate relations.
- "add_observations": Adds observations to existing entities. This effectively updates the node by creating a new version.
- "delete_entities": Deletes entities by name (marks them as deleted).
- "delete_observations": Deletes specific observations from entities (creates a new version).
- "delete_relations": Deletes relationships (marks them as deleted).
- "read_graph": Retrieves the entire graph for the agent (active nodes/relations).
- "search_nodes": Searches for nodes based on a query string (supports key:value and simple text).
- "open_nodes": Retrieves specific nodes by their names.`,
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                operation: {
                    type: 'string',
                    description: 'The operation to perform on the knowledge graph.',
                    enum: [
                        "create_entities",
                        "create_relations",
                        "add_observations",
                        "delete_entities",
                        "delete_observations",
                        "delete_relations",
                        "read_graph",
                        "search_nodes",
                        "open_nodes"
                    ]
                },
                entities: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string' },
                            entityType: { type: 'string' },
                            observations: { type: 'array', items: { type: 'string' }, default: [] }
                        },
                        required: ['name', 'entityType']
                    },
                    description: "For 'create_entities'. Observations are optional."
                },
                relations: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            from: { type: 'string' },
                            to: { type: 'string' },
                            relationType: { type: 'string' }
                        },
                        required: ['from', 'to', 'relationType']
                    },
                    description: "For 'create_relations' and 'delete_relations'."
                },
                observations: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            entityName: { type: 'string' },
                            contents: { type: 'array', items: { type: 'string' } }
                        },
                        required: ['entityName', 'contents']
                    },
                    description: "For 'add_observations'."
                },
                entityNames: {
                    type: 'array',
                    items: { type: 'string' },
                    description: "For 'delete_entities'."
                },
                deletions: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            entityName: { type: 'string' },
                            observations: { type: 'array', items: { type: 'string' } }
                        },
                        required: ['entityName', 'observations']
                    },
                    description: "For 'delete_observations'."
                },
                query: {
                    type: 'string',
                    description: "For 'search_nodes'."
                },
                names: {
                    type: 'array',
                    items: { type: 'string' },
                    description: "For 'open_nodes'."
                }
            },
            required: ['agent_id', 'operation'],
        },
    },
    {
        name: 'kg_nl_query',
        description: `An intelligent natural language interface for querying the code knowledge graph. Translates questions like "Which functions in auth_service.ts call database.query?" or "Show all classes implementing IPaymentProcessor" into structured graph queries. Features contextual scoping for large graphs, ambiguity handling, and transparent query translation. Supports DMQR (Diverse Multi-Query Rewriting) for enhanced context discovery through multiple specialized KG queries. Returns both the interpreted query and results with helpful metadata.`,
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                query: { type: 'string', description: 'Natural language query about the codebase (e.g., "What modules does OrderController import?", "Find all test files for the auth module", "Which classes extend BaseService?")' },
                model: { type: 'string', description: 'Optional: The Gemini model to use (e.g., "gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"). Defaults to current model.', nullable: true },
                enable_dmqr: {
                    type: 'boolean',
                    description: 'Enable Diverse Multi-Query Rewriting (DMQR) for enhanced KG retrieval. Automatically generates multiple specialized graph queries (structural, semantic, hybrid) for comprehensive context discovery.',
                    default: false
                },
                dmqr_query_count: {
                    type: 'number',
                    description: 'The number of diverse KG queries to generate when DMQR is enabled. Generates different types of specialized graph queries for comprehensive results.',
                    default: 3,
                    minimum: 2,
                    maximum: 5
                },
            },
            required: ['agent_id', 'query'],
        },
    },
    {
        name: 'kg_infer_relations',
        description: `An AI-powered tool that analyzes the knowledge graph to infer new code-specific relationships between entities. It focuses on meaningful software relationships like function calls, class usage, testing relationships, and feature groupings. The tool provides confidence scores and evidence for each inferred relation. High-confidence relations (≥80%) are automatically added, while lower-confidence ones are proposed for review.`,
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                entity_names: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional: A list of entity names to focus the inference on. If not provided, inference may be broader.',
                    nullable: true
                },
                context: { type: 'string', description: 'Optional: Additional context to aid in relation inference (e.g., "focus on authentication-related components" or "analyze test coverage").', nullable: true },
            },
            required: ['agent_id'],
        },
    },
    {
        name: 'kg_visualize',
        description: `A tool that generates a Mermaid diagram for visualizing the knowledge graph with codebase-optimized styling. Supports complex queries, custom layouts, and automatic legends. Features include:
- Different shapes/colors for entity types (files, functions, classes, modules)
- Distinct line styles for relation types (imports, defines, calls)
- Subgraphs for grouping related entities (directories, modules)
- Configurable layout direction
- Query examples: "functions in utils.ts", "inheritance for BaseController", "import graph for api/auth"`,
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                query: { type: 'string', description: 'Optional: A query to filter the knowledge graph. Examples: "functions in utils.ts", "calls from AuthService", "imports to database module", "class hierarchy for BaseController".', nullable: true },
                format: { type: 'string', enum: ['mermaid'], default: 'mermaid', description: 'The desired output format for the visualization.' },
                layout_direction: {
                    type: 'string',
                    enum: ['TD', 'TB', 'LR', 'RL', 'BT'],
                    default: 'TD',
                    description: 'Layout direction: TD/TB (top-down), LR (left-right), RL (right-left), BT (bottom-top).'
                },
                depth: {
                    type: 'number',
                    default: 2,
                    minimum: 1,
                    maximum: 5,
                    description: 'For traversal queries, the depth of relationships to include.'
                },
                include_legend: {
                    type: 'boolean',
                    default: true,
                    description: 'Whether to include a legend explaining shapes, colors, and line styles.'
                },
                group_by_directory: {
                    type: 'boolean',
                    default: false,
                    description: 'Whether to group nodes by their parent directory using subgraphs.'
                },
                natural_language_query: {
                    type: 'string',
                    description: 'Optional: A natural language query to filter the knowledge graph using AI.',
                    nullable: true
                },
                max_nodes: {
                    type: 'number',
                    default: 100,
                    minimum: 1,
                    description: 'Maximum number of nodes to include in the visualization.'
                },
                max_edges: {
                    type: 'number',
                    default: 200,
                    minimum: 1,
                    description: 'Maximum number of edges to include in the visualization.'
                },
                exclude_imports: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional: A list of import paths or module names to exclude from the visualization.',
                    nullable: true
                },
                exclude_relation_types: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional: A list of relation types to exclude from the visualization (e.g., "imports_file", "contains_item").',
                    nullable: true
                }
            },
            required: ['agent_id'],
        },
    },
];