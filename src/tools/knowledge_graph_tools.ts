import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate, schemas } from '../utils/validation.js';
import { formatSimpleMessage, formatJsonToMarkdownCodeBlock, formatObjectToMarkdown } from '../utils/formatters.js';
import { CodebaseIntrospectionService, ScannedItem, ExtractedImport, ExtractedCodeEntity } from '../database/services/CodebaseIntrospectionService.js';
import path from 'path';
import fs from 'fs/promises';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Creates a canonical absolute path key by normalizing path separators and converting to lowercase.
 * @param absPath - The absolute path to normalize
 * @returns A canonical path key
 */
export function createCanonicalAbsPathKey(absPath: string): string {
    // Normalize to POSIX separators first, then toLowerCase.
    return absPath.replace(/\\/g, '/').toLowerCase();
}

/**
 * Finds the actual file path on disk, considering common extensions.
 * @param basePath - The base path to check
 * @returns The actual file path if found, null otherwise
 */
async function findActualFilePath(basePath: string): Promise<string | null> {
    // First, try the basePath as is (could have an explicit extension or be extensionless)
    try {
        await fs.access(basePath);
        const stats = await fs.stat(basePath);
        if (stats.isFile()) {
            return basePath.replace(/\\/g, '/');
        }
    } catch (e) {
        /* ignore if exact path doesn't exist or is not a file */
    }

    // If basePath had a common JS/TS extension, strip it to get the base for probing other extensions
    const pathWithoutKnownJsOrTsExtensions = basePath.replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i, '');
    const possibleExtensions = [
        '.ts', '.tsx', '.mts', '.cts', // Prioritize TypeScript family
        '.js', '.jsx', '.mjs', '.cjs', // Then JavaScript family
        '' // Finally, if the original path was extensionless and didn't match above
    ];

    // Probe with common extensions using the (potentially stripped) base name
    for (const ext of possibleExtensions) {
        const fullPath = pathWithoutKnownJsOrTsExtensions + ext;
        try {
            await fs.access(fullPath);
            const stats = await fs.stat(fullPath);
            if (stats.isFile()) {
                return fullPath.replace(/\\/g, '/');
            }
        } catch (e) {
            /* ignore */
        }
    }

    return null;
}

/**
 * Compares observation arrays to determine if they have changed.
 * @param oldObs - The old observations array
 * @param newObs - The new observations array
 * @returns True if observations have changed, false otherwise
 */
function haveObservationsChanged(oldObs: string[] | undefined, newObs: string[]): boolean {
    if (!oldObs && newObs.length > 0) return true;
    if (oldObs && newObs.length === 0 && oldObs.length > 0) return true;
    if (!oldObs && newObs.length === 0) return false;
    if (!oldObs) return false;
    if (oldObs.length !== newObs.length) return true;

    const oldSet = new Set(oldObs);
    const newSet = new Set(newObs);

    if (oldSet.size !== newSet.size) return true;

    for (const obs of newObs) {
        if (!oldSet.has(obs)) return true;
    }

    for (const obs of oldObs) {
        if (!newSet.has(obs)) return true;
    }

    return false;
}

/**
 * Type guard to check if an entity has required name and entityType as strings
 */
function isValidEntity(entity: any): entity is { name: string; entityType: string; observations?: string[] } {
    return entity && typeof entity.name === 'string' && typeof entity.entityType === 'string';
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const knowledgeGraphToolDefinitions = [
    {
        name: 'ingest_codebase_structure',
        description: `Scans a specified directory, creating or updating knowledge graph nodes for files and folders.
It establishes 'contains_item' relationships. If 'parse_imports' is true, it parses import statements
from supported files, creates/updates 'module' nodes, and creates 'imports_file' or 'imports_module' relationships.
This tool aims to be idempotent, avoiding duplicate nodes for the same entities by updating existing ones if changes are detected. Output is Markdown formatted.`,
        inputSchema: schemas.ingestCodebaseStructure,
    },
    {
        name: 'ingest_file_code_entities',
        description: `Parses a specified code file to extract detailed code entities like functions, classes, and interfaces.
It populates these as nodes in the knowledge graph (creating or updating them if they exist by checking name and type)
and creates 'defined_in_file' relationships linking them to their parent file node.
It may also create 'has_method' relationships for classes. Output is Markdown formatted.`,
        inputSchema: schemas.ingestFileCodeEntities,
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
        description: `An intelligent natural language interface for querying the code knowledge graph. Translates questions like "Which functions in auth_service.ts call database.query?" or "Show all classes implementing IPaymentProcessor" into structured graph queries. Features contextual scoping for large graphs, ambiguity handling, and transparent query translation. Returns both the interpreted query and results with helpful metadata.`,
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                query: { type: 'string', description: 'Natural language query about the codebase (e.g., "What modules does OrderController import?", "Find all test files for the auth module", "Which classes extend BaseService?")' },
                model: { type: 'string', description: 'Optional: The Gemini model to use (e.g., "gemini-pro", "gemini-2.5-flash"). Defaults to "gemini-2.5-flash".', nullable: true },
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

// ============================================================================
// Tool Handlers
// ============================================================================

export function getKnowledgeGraphToolHandlers(memoryManager: MemoryManager) {
    const codebaseIntrospectionService = new CodebaseIntrospectionService(
        memoryManager,
        memoryManager.getGeminiIntegrationService(),
        memoryManager.projectRootPath
    );

    return {
        'ingest_codebase_structure': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for ingest_codebase_structure.");
            }

            const validationResult = validate('ingestCodebaseStructure', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed for ingest_codebase_structure: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }

            const { directory_path, project_root_path, parse_imports } = args;

            try {
                // Resolve paths once and use consistently
                const resolvedProjectRootPath = path.resolve(project_root_path || directory_path);
                const resolvedAbsoluteDirectoryPath = path.resolve(directory_path);

                // Create canonical versions for comparison and map keys
                const canonicalEffectiveRootPath = createCanonicalAbsPathKey(resolvedProjectRootPath);
                const canonicalAbsoluteDirectoryPath = createCanonicalAbsPathKey(resolvedAbsoluteDirectoryPath);

                if (!canonicalAbsoluteDirectoryPath.startsWith(canonicalEffectiveRootPath)) {
                    throw new McpError(ErrorCode.InvalidParams, `Directory path (${resolvedAbsoluteDirectoryPath}) must be within the project root path (${resolvedProjectRootPath}).`);
                }

                // Initialize counters and collections
                let nodesCreatedCount = 0;
                let nodesUpdatedCount = 0;
                let relationsCreatedCount = 0;

                // Maps to store node names by their canonical absolute paths for efficient lookup
                const createdOrExistingNodeNamesByCanonicalAbsPath: { [canonicalAbsPathKey: string]: string } = {};

                // Maps canonical absolute paths to their *relative* KG node names
                const absolutePathToRelativeNameMap: { [canonicalAbsPathKey: string]: string } = {};

                const entitiesToCreateBatch: Array<{ name: string; entityType: string; observations: string[] }> = [];
                const observationsToUpdateBatch: Array<{ entityName: string; contents: string[] }> = [];

                // Store relation objects as JSON strings to ensure uniqueness correctly handles complex node names
                const relationsToCreateSet = new Set<string>();

                const moduleEntitiesToCreateBatch: Array<{ name: string; entityType: string; observations: string[] }> = [];
                const moduleNamesToProcessOrCreate = new Set<string>();

                console.log(`[ingest_codebase_structure] Scanning directory: ${resolvedAbsoluteDirectoryPath} relative to root: ${resolvedProjectRootPath}`);

                // Pass resolvedProjectRootPath to scanDirectoryRecursive so it calculates relative paths correctly from the true project root.
                const scannedItems: ScannedItem[] = await codebaseIntrospectionService.scanDirectoryRecursive(
                    agent_id,
                    resolvedAbsoluteDirectoryPath,
                    resolvedProjectRootPath
                );

                console.log(`[ingest_codebase_structure] Scanned ${scannedItems.length} items.`);

                // Handle the root directory itself if it's part of the scan scope
                if (resolvedAbsoluteDirectoryPath === resolvedProjectRootPath) {
                    await processRootDirectory(
                        resolvedProjectRootPath,
                        agent_id,
                        memoryManager,
                        createdOrExistingNodeNamesByCanonicalAbsPath,
                        absolutePathToRelativeNameMap,
                        entitiesToCreateBatch,
                        observationsToUpdateBatch
                    );
                }

                // Process scanned files and directories
                for (const item of scannedItems) {
                    await processScannedItem(
                        item,
                        resolvedProjectRootPath,
                        canonicalEffectiveRootPath,
                        agent_id,
                        memoryManager,
                        createdOrExistingNodeNamesByCanonicalAbsPath,
                        absolutePathToRelativeNameMap,
                        entitiesToCreateBatch,
                        observationsToUpdateBatch,
                        relationsToCreateSet
                    );
                }

                // Create entities and update observations
                if (entitiesToCreateBatch.length > 0) {
                    console.log(`[ingest_codebase_structure] Batch creating ${entitiesToCreateBatch.length} file/directory nodes.`);
                    const creationResult = await memoryManager.knowledgeGraphManager.createEntities(agent_id, entitiesToCreateBatch);
                    nodesCreatedCount += Array.isArray(creationResult) ? creationResult.length : 0;
                }

                if (observationsToUpdateBatch.length > 0) {
                    console.log(`[ingest_codebase_structure] Batch updating observations for ${observationsToUpdateBatch.length} nodes.`);
                    const updateResult = await memoryManager.knowledgeGraphManager.addObservations(agent_id, observationsToUpdateBatch);
                    nodesUpdatedCount += Array.isArray(updateResult) ? updateResult.length : 0;
                }

                // Parse imports if requested
                if (parse_imports) {
                    console.log(`[ingest_codebase_structure] Parsing imports...`);
                    for (const item of scannedItems) {
                        if (item.type === 'file' && item.language && ['typescript', 'javascript', 'python', 'php'].includes(item.language)) {
                            await processFileImports(
                                item,
                                agent_id,
                                resolvedProjectRootPath,
                                canonicalEffectiveRootPath,
                                createdOrExistingNodeNamesByCanonicalAbsPath,
                                absolutePathToRelativeNameMap,
                                relationsToCreateSet,
                                moduleNamesToProcessOrCreate,
                                moduleEntitiesToCreateBatch,
                                memoryManager,
                                codebaseIntrospectionService
                            );
                        }
                    }

                    // Create module entities
                    if (moduleEntitiesToCreateBatch.length > 0) {
                        console.log(`[ingest_codebase_structure] Batch creating ${moduleEntitiesToCreateBatch.length} module nodes.`);
                        const moduleCreationResult = await memoryManager.knowledgeGraphManager.createEntities(agent_id, moduleEntitiesToCreateBatch);
                        nodesCreatedCount += Array.isArray(moduleCreationResult) ? moduleCreationResult.length : 0;
                    }
                }

                // Create relations
                const finalRelationsToCreate: Array<{ from: string; to: string; relationType: string }> = [];
                let relationsSkippedCount = 0;

                for (const relStr of relationsToCreateSet) {
                    const relObj = JSON.parse(relStr) as { from: string; to: string; type: string };
                    const existingRelation = await memoryManager.knowledgeGraphManager.getExistingRelation(agent_id, relObj.from, relObj.to, relObj.type);
                    if (existingRelation) {
                        relationsSkippedCount++;
                    } else {
                        finalRelationsToCreate.push({ from: relObj.from, to: relObj.to, relationType: relObj.type });
                    }
                }

                if (finalRelationsToCreate.length > 0) {
                    console.log(`[ingest_codebase_structure] Batch creating ${finalRelationsToCreate.length} new relations.`);
                    const relationResult = await memoryManager.knowledgeGraphManager.createRelations(agent_id, finalRelationsToCreate);
                    relationsCreatedCount += Array.isArray(relationResult) ? relationResult.length : 0;
                }

                if (relationsSkippedCount > 0) {
                    console.log(`[ingest_codebase_structure] Skipped ${relationsSkippedCount} existing relations as duplicates.`);
                }

                return {
                    content: [{
                        type: 'text',
                        text: formatSimpleMessage(
                            `Codebase structure ingestion for directory "${directory_path}" complete.
- Nodes Newly Created: ${nodesCreatedCount}
- Nodes Updated (Observations): ${nodesUpdatedCount}
- Relations Created: ${relationsCreatedCount}`,
                            "Codebase Ingestion Report"
                        )
                    }]
                };
            } catch (error: any) {
                console.error(`[ingest_codebase_structure] Error during codebase structure ingestion for agent ${agent_id}, path ${directory_path}:`, error);
                throw new McpError(ErrorCode.InternalError, `Codebase ingestion failed: ${error.message}`);
            }
        },

        'ingest_file_code_entities': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for ingest_file_code_entities.");
            }

            const validationResult = validate('ingestFileCodeEntities', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed for ingest_file_code_entities: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }

            const { file_path, project_root_path, language: lang_arg } = args;

            try {
                const effectiveRootPath = path.resolve(project_root_path || path.dirname(file_path));
                const absoluteFilePath = path.resolve(file_path);

                if (!createCanonicalAbsPathKey(absoluteFilePath).startsWith(createCanonicalAbsPathKey(effectiveRootPath))) {
                    throw new McpError(ErrorCode.InvalidParams, `File path (${absoluteFilePath}) must be within the project root path (${effectiveRootPath}).`);
                }

                let entitiesCreatedCount = 0;
                let entitiesUpdatedCount = 0;
                let relationsCreatedCount = 0;

                const fileNodeRelativeName = path.relative(effectiveRootPath, absoluteFilePath).replace(/\\/g, '/');
                let fileNodeInKG: any;

                // Get or create file node
                const existingFileNodes = await memoryManager.knowledgeGraphManager.openNodes(agent_id, [fileNodeRelativeName]);
                fileNodeInKG = existingFileNodes.find((n: any) => n.name === fileNodeRelativeName && n.entityType === 'file');

                if (!fileNodeInKG) {
                    console.log(`[ingest_file_code_entities] File node ${fileNodeRelativeName} not found, creating it.`);
                    const stats = await fs.stat(absoluteFilePath);
                    const detectedLang = lang_arg || await codebaseIntrospectionService.detectLanguage(agent_id, absoluteFilePath, path.basename(absoluteFilePath));
                    const fileEntityToCreate = {
                        name: fileNodeRelativeName,
                        entityType: 'file' as 'file',
                        observations: [
                            `absolute_path: ${createCanonicalAbsPathKey(absoluteFilePath)}`,
                            `type: file`,
                            `language: ${detectedLang || 'unknown'}`,
                            `size_bytes: ${stats.size.toString()}`,
                            `created_at: ${stats.birthtime.toISOString()}`,
                            `modified_at: ${stats.mtime.toISOString()}`,
                        ]
                    };
                    const creationResult = await memoryManager.knowledgeGraphManager.createEntities(agent_id, [fileEntityToCreate]);
                    entitiesCreatedCount += Array.isArray(creationResult) ? creationResult.length : 0;
                    const newNodes = await memoryManager.knowledgeGraphManager.openNodes(agent_id, [fileNodeRelativeName]);
                    fileNodeInKG = newNodes.find((n: any) => n.name === fileNodeRelativeName && n.entityType === 'file');
                }

                if (!fileNodeInKG) {
                    throw new McpError(ErrorCode.InternalError, `Failed to create or find file node for ${fileNodeRelativeName}.`);
                }

                // Extract code entities
                const langForParsing = lang_arg || fileNodeInKG.observations?.find((o: string) => o.startsWith("language:"))?.split(": ")[1] ||
                    await codebaseIntrospectionService.detectLanguage(agent_id, absoluteFilePath, path.basename(absoluteFilePath));
                const extractedEntities: ExtractedCodeEntity[] = await codebaseIntrospectionService.parseFileForCodeEntities(
                    agent_id,
                    absoluteFilePath,
                    langForParsing
                );

                if (extractedEntities.length === 0) {
                    return {
                        content: [{
                            type: 'text',
                            text: formatSimpleMessage(`No code entities found or extracted from file: ${file_path}`, "Code Entity Ingestion")
                        }]
                    };
                }

                // Process extracted entities
                const entitiesToCreateBatch: Array<{ name: string; entityType: string; observations: string[] }> = [];
                const observationsToUpdateBatchKG: Array<{ entityName: string; contents: string[] }> = [];
                const relationsToCreateSetKG = new Set<string>();

                for (const entity of extractedEntities) {
                    await processExtractedEntity(
                        entity,
                        fileNodeRelativeName,
                        agent_id,
                        memoryManager,
                        entitiesToCreateBatch,
                        observationsToUpdateBatchKG,
                        relationsToCreateSetKG
                    );
                }

                // Create entities and update observations
                if (entitiesToCreateBatch.length > 0) {
                    const creationResult = await memoryManager.knowledgeGraphManager.createEntities(agent_id, entitiesToCreateBatch);
                    entitiesCreatedCount += Array.isArray(creationResult) ? creationResult.length : 0;
                }

                if (observationsToUpdateBatchKG.length > 0) {
                    const updateResult = await memoryManager.knowledgeGraphManager.addObservations(agent_id, observationsToUpdateBatchKG);
                    entitiesUpdatedCount += Array.isArray(updateResult) ? updateResult.length : 0;
                }

                // Create relations
                const finalRelationsToCreateKG: Array<{ from: string; to: string; relationType: string }> = [];
                for (const relStr of relationsToCreateSetKG) {
                    const relObj = JSON.parse(relStr) as { from: string; to: string; type: string };
                    finalRelationsToCreateKG.push({ from: relObj.from, to: relObj.to, relationType: relObj.type });
                }

                if (finalRelationsToCreateKG.length > 0) {
                    const relationResult = await memoryManager.knowledgeGraphManager.createRelations(agent_id, finalRelationsToCreateKG);
                    relationsCreatedCount += Array.isArray(relationResult) ? relationResult.length : 0;
                }

                return {
                    content: [{
                        type: 'text',
                        text: formatSimpleMessage(
                            `Code entity ingestion for file "${file_path}" complete.
- Code Entities Newly Created: ${entitiesCreatedCount}
- Code Entities Updated (Observations): ${entitiesUpdatedCount}
- Relations Created: ${relationsCreatedCount}`,
                            "Code Entity Ingestion Report"
                        )
                    }]
                };
            } catch (error: any) {
                console.error(`Error during code entity ingestion for agent ${agent_id}, file ${file_path}:`, error);
                throw new McpError(ErrorCode.InternalError, `Code entity ingestion failed for ${file_path}: ${error.message}`);
            }
        },

        'knowledge_graph_memory': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for knowledge_graph_memory operations.");
            }

            const operation = args.operation as string;
            let kgResultText: string;
            let title = `Knowledge Graph Operation: ${operation} for Agent: ${agent_id}`;
            let resultData: any;

            try {
                switch (operation) {
                    case 'create_entities':
                        if (!args.entities || !Array.isArray(args.entities) || args.entities.length === 0) {
                            throw new McpError(ErrorCode.InvalidParams, "Missing or empty 'entities' array for 'create_entities' operation.");
                        }
                        resultData = await handleCreateEntitiesOperation(args, memoryManager, agent_id);
                        break;

                    case 'create_relations':
                        if (!args.relations || !Array.isArray(args.relations) || args.relations.length === 0) {
                            throw new McpError(ErrorCode.InvalidParams, "Missing or empty 'relations' array for 'create_relations' operation.");
                        }
                        args.relations.forEach((relation: any) => {
                            if (!relation.from || !relation.to || !relation.relationType) {
                                throw new McpError(ErrorCode.InvalidParams, "Each relation must have 'from', 'to', and 'relationType'.");
                            }
                        });
                        resultData = await memoryManager.knowledgeGraphManager.createRelations(agent_id, args.relations);
                        break;

                    case 'add_observations':
                        if (!args.observations || !Array.isArray(args.observations) || args.observations.length === 0) {
                            throw new McpError(ErrorCode.InvalidParams, "Missing or empty 'observations' array for 'add_observations' operation.");
                        }
                        resultData = await memoryManager.knowledgeGraphManager.addObservations(agent_id, args.observations);
                        break;

                    case 'delete_entities':
                        if (!args.entityNames || !Array.isArray(args.entityNames) || args.entityNames.length === 0) {
                            throw new McpError(ErrorCode.InvalidParams, "Missing or empty 'entityNames' array for 'delete_entities' operation.");
                        }
                        await memoryManager.knowledgeGraphManager.deleteEntities(agent_id, args.entityNames);
                        resultData = { message: `Delete entities operation completed for names: ${args.entityNames.join(', ')}.` };
                        break;

                    case 'delete_observations':
                        if (!args.deletions || !Array.isArray(args.deletions) || args.deletions.length === 0) {
                            throw new McpError(ErrorCode.InvalidParams, "Missing or empty 'deletions' array for 'delete_observations' operation.");
                        }
                        resultData = await memoryManager.knowledgeGraphManager.deleteObservations(agent_id, args.deletions);
                        break;

                    case 'delete_relations':
                        if (!args.relations || !Array.isArray(args.relations) || args.relations.length === 0) {
                            throw new McpError(ErrorCode.InvalidParams, "Missing or empty 'relations' array for 'delete_relations' operation.");
                        }
                        await memoryManager.knowledgeGraphManager.deleteRelations(agent_id, args.relations);
                        resultData = { message: `Delete relations operation completed.` };
                        break;

                    case 'read_graph':
                        resultData = await memoryManager.knowledgeGraphManager.readGraph(agent_id);
                        title = `Full Knowledge Graph for Agent: ${agent_id}`;
                        break;

                    case 'search_nodes':
                        if (!args.query) {
                            throw new McpError(ErrorCode.InvalidParams, "Missing 'query' argument for 'search_nodes' operation.");
                        }
                        resultData = await memoryManager.knowledgeGraphManager.searchNodes(agent_id, args.query as string);
                        title = `Knowledge Graph Node Search (Query: "${args.query}") for Agent: ${agent_id}`;
                        break;

                    case 'open_nodes':
                        if (!args.names || !Array.isArray(args.names) || args.names.length === 0) {
                            throw new McpError(ErrorCode.InvalidParams, "Missing or empty 'names' array for 'open_nodes' operation.");
                        }
                        resultData = await memoryManager.knowledgeGraphManager.openNodes(agent_id, args.names as string[]);
                        title = `Knowledge Graph Nodes (Names: ${args.names.join(', ')}) for Agent: ${agent_id}`;
                        break;

                    default:
                        throw new McpError(
                            ErrorCode.MethodNotFound,
                            `Unknown knowledge_graph_memory operation: ${operation}.`
                        );
                }

                // Format the response based on the operation
                if (operation === 'read_graph' || operation === 'search_nodes' || operation === 'open_nodes') {
                    kgResultText = `## ${title}
`;
                    if ((Array.isArray(resultData) && resultData.length === 0) ||
                        (typeof resultData === 'object' && resultData !== null && resultData.nodes && Array.isArray(resultData.nodes) && resultData.nodes.length === 0 && (!resultData.relations || resultData.relations.length === 0))) {
                        kgResultText += `*No results found or graph is empty.*
`;
                    } else {
                        kgResultText += formatJsonToMarkdownCodeBlock(resultData);
                    }
                } else if (resultData && typeof resultData.message === 'string') {
                    kgResultText = `## ${title}
**Status:** ${resultData.message}
`;
                    if (resultData.details) kgResultText += `
**Details:**
${formatJsonToMarkdownCodeBlock(resultData.details)}
`;
                } else {
                    kgResultText = `## ${title}
Operation completed. Result:
${formatJsonToMarkdownCodeBlock(resultData)}
`;
                }
            } catch (error: any) {
                console.error(`Error in knowledge_graph_memory tool (operation: ${operation}, agent: ${agent_id}):`, error);
                if (error instanceof McpError) throw error;
                throw new McpError(ErrorCode.InternalError, `Knowledge graph operation '${operation}' failed: ${error.message}`);
            }

            return { content: [{ type: 'text', text: kgResultText }] };
        },

        'kg_nl_query': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for kg_nl_query.");
            }

            try {
                const resultJsonString = await memoryManager.knowledgeGraphManager.queryNaturalLanguage(agent_id, args.query);
                const result = JSON.parse(resultJsonString);

                let md = `## Natural Language Query Result for Agent: \`${agent_id}\`
`;
                md += `**Query:** "${args.query}"
`;

                if (result.metadata) {
                    md += `### Query Translation
`;
                    md += `- **Operation:** \`${result.metadata.translatedOperation}\`
`;
                    md += `- **Arguments:**
${formatJsonToMarkdownCodeBlock(result.metadata.translatedArgs)}
`;
                    if (result.metadata.assumptions) md += `- **Assumptions:** ${result.metadata.assumptions}
`;
                    md += `- **Used Gemini for Translation:** ${result.metadata.usedGemini ? 'Yes' : 'No'}
`;
                } else {
                    md += `*Query translation metadata not available.*
`;
                }

                md += `### Results
`;

                if (result.results) {
                    if (result.results.error) {
                        md += `**Error from Query Execution:** ${result.results.error}
`;
                    } else if ((Array.isArray(result.results) && result.results.length === 0) ||
                        (typeof result.results === 'object' && result.results.nodes && Array.isArray(result.results.nodes) && result.results.nodes.length === 0 && (!result.results.relations || result.results.relations.length === 0))) {
                        md += `*No results found matching the query.*
`;
                    } else {
                        md += formatJsonToMarkdownCodeBlock(result.results);
                    }
                } else {
                    md += `*No results data in the response.*
`;
                }

                return { content: [{ type: 'text', text: md }] };
            } catch (error: any) {
                console.error(`Error in kg_nl_query tool (agent: ${agent_id}):`, error);
                if (error instanceof McpError) throw error;
                throw new McpError(ErrorCode.InternalError, `Natural language query failed: ${error.message}`);
            }
        },

        'kg_infer_relations': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for kg_infer_relations.");
            }

            try {
                const result = await memoryManager.knowledgeGraphManager.inferRelations(agent_id, args.entity_names, args.context);

                let md = `## Relation Inference Result for Agent: \`${agent_id}\`
`;

                if (args.entity_names && args.entity_names.length > 0) md += `**Focused Entities:** ${args.entity_names.map((e: string) => `\`${e}\``).join(', ')}
`;
                if (args.context) md += `**Additional Context:** ${args.context}
`;

                md += `
**Status:** ${result.message}
`;

                if (result.details && result.details.length > 0) {
                    md += `### Proposed/Added Relations:
`;
                    md += `| From | To | Relation Type | Confidence | Evidence | Status |
`;
                    md += `|------|----|---------------|------------|----------|--------|
`;

                    result.details.forEach((rel: any) => {
                        const confidence = rel.confidence ? `${(rel.confidence * 100).toFixed(0)}%` : 'N/A';
                        const evidence = rel.evidence || 'No specific evidence provided';
                        const status = rel.status || 'proposed_by_ai';
                        const statusEmoji = status.startsWith('added') ? '✅' : status.startsWith('failed') ? '❌' : '🔍';

                        md += `| \`${rel.from}\` | \`${rel.to}\` | \`${rel.relationType}\` | ${confidence} | ${evidence.substring(0, 50)}${evidence.length > 50 ? '...' : ''} | ${statusEmoji} ${status} |
`;
                    });

                    md += `
### Legend:
`;
                    md += `- ✅ **added_by_ai**: High-confidence relation automatically added.
`;
                    md += `- 🔍 **proposed_by_ai**: Relation proposed by AI, requires review.
`;
                    md += `- ❌ **failed**: Relation could not be added.
`;
                } else {
                    md += `*No new relations were inferred or added.*
`;
                }

                return { content: [{ type: 'text', text: md }] };
            } catch (error: any) {
                console.error(`Error in kg_infer_relations tool (agent: ${agent_id}):`, error);
                if (error instanceof McpError) throw error;
                throw new McpError(ErrorCode.InternalError, `Relation inference failed: ${error.message}`);
            }
        },

        'kg_visualize': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for kg_visualize.");
            }

            try {
                let mermaidGraph: string;
                let md = `## Knowledge Graph Visualization for Agent: \`${agent_id}\`
`;

                if (args.natural_language_query) {
                    md += `**Based on Natural Language Query:** "${args.natural_language_query}"
`;

                    const visualizationOptions = {
                        query: args.query,
                        natural_language_query: args.natural_language_query,
                        layoutDirection: args.layout_direction || 'TD',
                        depth: args.depth || 2,
                        includeLegend: args.include_legend !== false,
                        groupByDirectory: args.group_by_directory || false,
                        maxNodes: args.max_nodes,
                        maxEdges: args.max_edges,
                        excludeImports: args.exclude_imports,
                        excludeRelationTypes: args.exclude_relation_types
                    };

                    mermaidGraph = await memoryManager.knowledgeGraphManager.generateMermaidGraph(
                        agent_id,
                        visualizationOptions
                    );
                } else {
                    if (args.query) md += `**Based on Direct Query:** "${args.query}"
`;

                    const visualizationOptions = {
                        query: args.query,
                        layoutDirection: args.layout_direction || 'TD',
                        depth: args.depth || 2,
                        includeLegend: args.include_legend !== false,
                        groupByDirectory: args.group_by_directory || false,
                        maxNodes: args.max_nodes,
                        maxEdges: args.max_edges,
                        excludeImports: args.exclude_imports,
                        excludeRelationTypes: args.exclude_relation_types
                    };

                    mermaidGraph = await memoryManager.knowledgeGraphManager.generateMermaidGraph(
                        agent_id,
                        visualizationOptions
                    );
                }

                if (args.layout_direction && args.layout_direction !== 'TD') md += `**Layout:** ${args.layout_direction}
`;
                if (args.group_by_directory) md += `**Grouping:** By directory
`;

                md += `
\`\`\`mermaid
${mermaidGraph}
\`\`\`
`;

                return { content: [{ type: 'text', text: md }] };
            } catch (error: any) {
                console.error(`Error in kg_visualize tool (agent: ${agent_id}):`, error);
                if (error instanceof McpError) throw error;
                throw new McpError(ErrorCode.InternalError, `Knowledge graph visualization failed: ${error.message}`);
            }
        },
    };
}

// ============================================================================
// Helper Functions for Codebase Structure Ingestion
// ============================================================================

/**
 * Processes the root directory for codebase structure ingestion.
 */
async function processRootDirectory(
    resolvedProjectRootPath: string,
    agent_id: string,
    memoryManager: MemoryManager,
    createdOrExistingNodeNamesByCanonicalAbsPath: { [canonicalAbsPathKey: string]: string },
    absolutePathToRelativeNameMap: { [canonicalAbsPathKey: string]: string },
    entitiesToCreateBatch: Array<{ name: string; entityType: string; observations: string[] }>,
    observationsToUpdateBatch: Array<{ entityName: string; contents: string[] }>
) {
    const rootNodeName = "."; // KG node name for the root
    const canonicalRootPathKey = createCanonicalAbsPathKey(resolvedProjectRootPath);

    try {
        const rootStats = await fs.stat(resolvedProjectRootPath);
        const rootObservations = [
            `absolute_path: ${canonicalRootPathKey}`,
            `type: directory`,
            `size_bytes: ${rootStats.size.toString()}`,
            `created_at: ${rootStats.birthtime.toISOString()}`,
            `modified_at: ${rootStats.mtime.toISOString()}`,
        ];

        const existingRootNodes = await memoryManager.knowledgeGraphManager.openNodes(agent_id, [rootNodeName]);
        const existingRootNode = existingRootNodes.find((n: any) => n.name === rootNodeName && n.entityType === 'directory');

        if (existingRootNode) {
            createdOrExistingNodeNamesByCanonicalAbsPath[canonicalRootPathKey] = rootNodeName;
            absolutePathToRelativeNameMap[canonicalRootPathKey] = rootNodeName;

            if (haveObservationsChanged(existingRootNode.observations, rootObservations)) {
                observationsToUpdateBatch.push({ entityName: rootNodeName, contents: rootObservations });
            }
        } else {
            entitiesToCreateBatch.push({ name: rootNodeName, entityType: 'directory', observations: rootObservations });
            createdOrExistingNodeNamesByCanonicalAbsPath[canonicalRootPathKey] = rootNodeName;
            absolutePathToRelativeNameMap[canonicalRootPathKey] = rootNodeName;
        }
    } catch (statError: any) {
        console.warn(`[ingest_codebase_structure] Could not stat project root path ${resolvedProjectRootPath}: ${statError.message}`);
    }
}

/**
 * Processes a scanned item (file or directory) for codebase structure ingestion.
 */
async function processScannedItem(
    item: ScannedItem,
    resolvedProjectRootPath: string,
    canonicalEffectiveRootPath: string,
    agent_id: string,
    memoryManager: MemoryManager,
    createdOrExistingNodeNamesByCanonicalAbsPath: { [canonicalAbsPathKey: string]: string },
    absolutePathToRelativeNameMap: { [canonicalAbsPathKey: string]: string },
    entitiesToCreateBatch: Array<{ name: string; entityType: string; observations: string[] }>,
    observationsToUpdateBatch: Array<{ entityName: string; contents: string[] }>,
    relationsToCreateSet: Set<string>
) {
    // item.name is already relative (to resolvedProjectRootPath) and uses forward slashes from scanDirectoryRecursive
    const entityName = item.name === "" ? "." : item.name;
    const canonicalItemAbsPathKey = createCanonicalAbsPathKey(item.path); // item.path is absolute

    const currentObservations = [
        `absolute_path: ${canonicalItemAbsPathKey}`,
        `type: ${item.type}`,
        `size_bytes: ${item.stats.size.toString()}`,
        `created_at: ${item.stats.birthtime.toISOString()}`,
        `modified_at: ${item.stats.mtime.toISOString()}`,
    ];

    if (item.type === 'file' && item.language) {
        currentObservations.push(`language: ${item.language}`);
    }

    const existingNodes = await memoryManager.knowledgeGraphManager.openNodes(agent_id, [entityName]);
    const existingNode = existingNodes.find((n: any) => n.name === entityName && n.entityType === item.type);

    if (existingNode) {
        createdOrExistingNodeNamesByCanonicalAbsPath[canonicalItemAbsPathKey] = existingNode.name;
        absolutePathToRelativeNameMap[canonicalItemAbsPathKey] = existingNode.name;

        if (item.language === 'typescript' && item.path.endsWith('.ts')) {
            const jsPathKey = createCanonicalAbsPathKey(item.path.slice(0, -3) + '.js');
            absolutePathToRelativeNameMap[jsPathKey] = existingNode.name;
        }

        if (haveObservationsChanged(existingNode.observations, currentObservations)) {
            const newObsToAdd = currentObservations.filter(obs => !(existingNode.observations || []).includes(obs));
            if (newObsToAdd.length > 0) {
                observationsToUpdateBatch.push({ entityName: existingNode.name, contents: newObsToAdd });
            }
        }
    } else {
        entitiesToCreateBatch.push({ name: entityName, entityType: item.type, observations: currentObservations });
        createdOrExistingNodeNamesByCanonicalAbsPath[canonicalItemAbsPathKey] = entityName;
        absolutePathToRelativeNameMap[canonicalItemAbsPathKey] = entityName;

        if (item.language === 'typescript' && item.path.endsWith('.ts')) {
            const jsPathKey = createCanonicalAbsPathKey(item.path.slice(0, -3) + '.js');
            absolutePathToRelativeNameMap[jsPathKey] = entityName;
        }
    }

    // Create 'contains_item' relation: ParentDir -> CurrentItem
    const parentDirAbsPath = path.dirname(item.path); // Absolute path of parent
    const canonicalParentDirAbsPathKey = createCanonicalAbsPathKey(parentDirAbsPath);

    // Ensure parent is within effective root and not the item itself
    if (canonicalParentDirAbsPathKey !== canonicalItemAbsPathKey && canonicalParentDirAbsPathKey.startsWith(canonicalEffectiveRootPath)) {
        let parentDirNodeName = createdOrExistingNodeNamesByCanonicalAbsPath[canonicalParentDirAbsPathKey];

        if (!parentDirNodeName) {
            // Calculate relative path for the parent directory from the resolvedProjectRootPath
            let relativeParentPath = path.relative(resolvedProjectRootPath, parentDirAbsPath).replace(/\\/g, '/');
            parentDirNodeName = (relativeParentPath === "" || relativeParentPath === ".") ? "." : relativeParentPath;

            // Check if this parent is already in the batch or the maps
            if (!createdOrExistingNodeNamesByCanonicalAbsPath[canonicalParentDirAbsPathKey] &&
                !entitiesToCreateBatch.find(e => e.name === parentDirNodeName && e.entityType === 'directory')) {
                console.warn(`[ingest_codebase_structure] Parent directory node for '${parentDirNodeName}' (from path '${parentDirAbsPath}') not yet processed. Creating it.`);
                const parentStats = await fs.stat(parentDirAbsPath).catch(() => null);
                const parentObservations = parentStats ? [
                    `absolute_path: ${canonicalParentDirAbsPathKey}`,
                    `type: directory`,
                    `size_bytes: ${parentStats.size.toString()}`,
                    `created_at: ${parentStats.birthtime.toISOString()}`,
                    `modified_at: ${parentStats.mtime.toISOString()}`,
                ] : [`absolute_path: ${canonicalParentDirAbsPathKey}`, `type: directory`];

                entitiesToCreateBatch.push({ name: parentDirNodeName, entityType: 'directory', observations: parentObservations });

                // Immediately update maps for subsequent lookups within this run
                createdOrExistingNodeNamesByCanonicalAbsPath[canonicalParentDirAbsPathKey] = parentDirNodeName;
                absolutePathToRelativeNameMap[canonicalParentDirAbsPathKey] = parentDirNodeName;
            } else if (!createdOrExistingNodeNamesByCanonicalAbsPath[canonicalParentDirAbsPathKey] &&
                entitiesToCreateBatch.find(e => e.name === parentDirNodeName && e.entityType === 'directory')) {
                // It's already in the batch to be created, ensure maps are updated if they weren't already
                createdOrExistingNodeNamesByCanonicalAbsPath[canonicalParentDirAbsPathKey] = parentDirNodeName;
                absolutePathToRelativeNameMap[canonicalParentDirAbsPathKey] = parentDirNodeName;
            }
        }

        // `entityName` is the relative path of the current item
        // Use JSON stringify for relation keys to handle special characters in names
        const relationKeyObject = { from: parentDirNodeName, to: entityName, type: 'contains_item' };
        const relationString = JSON.stringify(relationKeyObject);

        if (!relationsToCreateSet.has(relationString)) {
            relationsToCreateSet.add(relationString);
        }
    }
}

/**
 * Processes file imports for codebase structure ingestion.
 */
async function processFileImports(
    item: ScannedItem,
    agent_id: string,
    resolvedProjectRootPath: string,
    canonicalEffectiveRootPath: string,
    createdOrExistingNodeNamesByCanonicalAbsPath: { [canonicalAbsPathKey: string]: string },
    absolutePathToRelativeNameMap: { [canonicalAbsPathKey: string]: string },
    relationsToCreateSet: Set<string>,
    moduleNamesToProcessOrCreate: Set<string>,
    moduleEntitiesToCreateBatch: Array<{ name: string; entityType: string; observations: string[] }>,
    memoryManager: MemoryManager,
    codebaseIntrospectionService: CodebaseIntrospectionService
) {
    const canonicalItemAbsPathKey = createCanonicalAbsPathKey(item.path);
    const fileNodeName = createdOrExistingNodeNamesByCanonicalAbsPath[canonicalItemAbsPathKey]; // Use map for consistency

    if (!fileNodeName) {
        console.warn(`[ingest_codebase_structure] Could not find KG node name for file path: ${item.path} (key: ${canonicalItemAbsPathKey}) during import parsing. This might happen if the file itself was not processed into the map correctly.`);
        return;
    }

    const extractedImports: ExtractedImport[] = await codebaseIntrospectionService.parseFileForImports(agent_id, item.path, item.language);

    for (const imp of extractedImports) {
        let toNodeName = imp.targetPath;
        let toNodeType = imp.type;

        if (imp.type === 'file') {
            let resolvedAbsoluteImportPath = path.isAbsolute(imp.targetPath)
                ? imp.targetPath
                : path.resolve(path.dirname(item.path), imp.targetPath);
            resolvedAbsoluteImportPath = resolvedAbsoluteImportPath.replace(/\\/g, '/');

            let actualFilePathOnDisk = await findActualFilePath(resolvedAbsoluteImportPath);
            let canonicalActualFilePathKey = actualFilePathOnDisk ? createCanonicalAbsPathKey(actualFilePathOnDisk) : null;

            if (!actualFilePathOnDisk && resolvedAbsoluteImportPath.endsWith('.js')) {
                const tsEquivalentBasePath = resolvedAbsoluteImportPath.slice(0, -3);
                const foundTsFile = await findActualFilePath(tsEquivalentBasePath);
                if (foundTsFile) {
                    actualFilePathOnDisk = foundTsFile;
                    canonicalActualFilePathKey = createCanonicalAbsPathKey(actualFilePathOnDisk);
                }
            }

            if (canonicalActualFilePathKey && absolutePathToRelativeNameMap[canonicalActualFilePathKey]) {
                toNodeName = absolutePathToRelativeNameMap[canonicalActualFilePathKey];
            } else if (actualFilePathOnDisk && canonicalActualFilePathKey && canonicalActualFilePathKey.startsWith(canonicalEffectiveRootPath)) {
                const relativeImportPath = path.relative(resolvedProjectRootPath, actualFilePathOnDisk).replace(/\\/g, '/');
                toNodeName = (relativeImportPath === "" || relativeImportPath === ".") ? "." : relativeImportPath;

                if (canonicalActualFilePathKey && !absolutePathToRelativeNameMap[canonicalActualFilePathKey]) {
                    // console.warn(`[ingest_codebase_structure] Import target ${actualFilePathOnDisk} resolved to relative path '${toNodeName}', but was not in pre-scan maps. Using relative path as node name.`);
                }
            } else {
                console.warn(`[ingest_codebase_structure] Import target ${imp.targetPath} from ${fileNodeName} (resolved abs: ${resolvedAbsoluteImportPath}, found on disk: ${actualFilePathOnDisk || 'N/A'}) is outside project or not found in scan map. Treating as external module: ${imp.targetPath}`);
                toNodeName = imp.targetPath;
                toNodeType = 'module';
            }
        }

        if (toNodeType === 'external_library' || toNodeType === 'module') {
            if (!moduleNamesToProcessOrCreate.has(toNodeName)) {
                moduleNamesToProcessOrCreate.add(toNodeName);
                const existingModuleNodes = await memoryManager.knowledgeGraphManager.openNodes(agent_id, [toNodeName]);
                const existingModuleNode = existingModuleNodes.find((n: any) => n.name === toNodeName && n.entityType === 'module');

                if (!existingModuleNode) {
                    moduleEntitiesToCreateBatch.push({ name: toNodeName, entityType: 'module', observations: [`type: ${toNodeType}`] });
                }
            }
        }

        const relationKeyObjectImp = { from: fileNodeName, to: toNodeName, type: imp.type === 'file' ? 'imports_file' : 'imports_module' };
        const relationStringImp = JSON.stringify(relationKeyObjectImp);

        if (!relationsToCreateSet.has(relationStringImp)) {
            relationsToCreateSet.add(relationStringImp);
        }
    }
}

// ============================================================================
// Helper Functions for Knowledge Graph Operations
// ============================================================================

/**
 * Handles the create_entities operation for the knowledge graph memory tool.
 */
async function handleCreateEntitiesOperation(args: any, memoryManager: MemoryManager, agent_id: string) {
    const entitiesToCreateOp: any[] = [];
    const observationsToUpdateOp: any[] = [];
    let createdOpCount = 0;
    let updatedOpCount = 0;

    for (const entity of args.entities) {
        if (!isValidEntity(entity)) {
            throw new McpError(ErrorCode.InvalidParams, "Each entity must have a valid 'name' and 'entityType' of type string.");
        }

        const entityName: string = entity.name!;
        const entityType: string = entity.entityType!;
        const existingNodes = await memoryManager.knowledgeGraphManager.openNodes(agent_id, [entityName]);
        const existingNode = existingNodes.find((n: any) => n.name === entityName && n.entityType === entityType);

        if (existingNode) {
            if (entity.observations && entity.observations.length > 0 && haveObservationsChanged(existingNode.observations, entity.observations)) {
                const newObsToAdd = entity.observations.filter((obs: string) => !(existingNode.observations || []).includes(obs));
                if (newObsToAdd.length > 0) {
                    observationsToUpdateOp.push({ entityName: existingNode.name, contents: newObsToAdd });
                }
            }
        } else {
            entitiesToCreateOp.push(entity);
        }
    }

    if (entitiesToCreateOp.length > 0) {
        const creationRes = await memoryManager.knowledgeGraphManager.createEntities(agent_id, entitiesToCreateOp);
        createdOpCount = Array.isArray(creationRes) ? creationRes.length : 0;
    }

    if (observationsToUpdateOp.length > 0) {
        const updateRes = await memoryManager.knowledgeGraphManager.addObservations(agent_id, observationsToUpdateOp);
        updatedOpCount = Array.isArray(updateRes) ? updateRes.length : 0;
    }

    return {
        message: `Create entities operation: ${createdOpCount} created, ${updatedOpCount} updated.`,
        details: {
            created: entitiesToCreateOp,
            updated_observations_for: observationsToUpdateOp.map(o => o.entityName)
        }
    };
}

/**
 * Processes an extracted code entity for file code entity ingestion.
 */
async function processExtractedEntity(
    entity: ExtractedCodeEntity,
    fileNodeRelativeName: string,
    agent_id: string,
    memoryManager: MemoryManager,
    entitiesToCreateBatch: Array<{ name: string; entityType: string; observations: string[] }>,
    observationsToUpdateBatchKG: Array<{ entityName: string; contents: string[] }>,
    relationsToCreateSetKG: Set<string>
) {
    const currentObservations = [
        `type: ${entity.type}`,
        `signature: ${entity.signature || 'N/A'}`,
        `lines: ${entity.startLine}-${entity.endLine}`,
        `exported: ${entity.isExported ? 'yes' : 'no'}`,
        `defined_in_file_path: ${fileNodeRelativeName}`
    ];

    if (entity.docstring) currentObservations.push(`docstring: ${entity.docstring.substring(0, 200)}${entity.docstring.length > 200 ? '...' : ''}`);
    if (entity.parameters && entity.parameters.length > 0) currentObservations.push(`parameters: ${JSON.stringify(entity.parameters)}`);
    if (entity.returnType) currentObservations.push(`return_type: ${entity.returnType}`);
    if (entity.parentClass && entity.filePath) currentObservations.push(`parent_class_full_name: ${entity.filePath}::${entity.parentClass}`);
    if (entity.implementedInterfaces && entity.implementedInterfaces.length > 0) currentObservations.push(`implements: ${entity.implementedInterfaces.join(', ')}`);

    if (entity.calls && entity.calls.length > 0) {
        currentObservations.push(`calls: ${JSON.stringify(entity.calls.map(c => c.name))}`);
    }

    const existingEntities = await memoryManager.knowledgeGraphManager.openNodes(agent_id, [entity.fullName || '']);
    const existingEntityNode = existingEntities.find((n: any) => n.name === entity.fullName && n.entityType === entity.type);

    if (existingEntityNode) {
        if (haveObservationsChanged(existingEntityNode.observations, currentObservations)) {
            const newObsToAdd = currentObservations.filter(obs => !(existingEntityNode.observations || []).includes(obs));
            if (newObsToAdd.length > 0) {
                observationsToUpdateBatchKG.push({ entityName: existingEntityNode.name, contents: newObsToAdd });
            }
        }
    } else {
        entitiesToCreateBatch.push({
            name: entity.fullName || '',
            entityType: entity.type as string,
            observations: currentObservations,
        });
    }

    if (entity.fullName && fileNodeRelativeName) {
        const defRelKey = { from: entity.fullName, to: fileNodeRelativeName, type: 'defined_in_file' };
        relationsToCreateSetKG.add(JSON.stringify(defRelKey));
    }

    if (entity.type === 'method' && entity.parentClass && entity.fullName && fileNodeRelativeName) {
        const classFullName = `${fileNodeRelativeName}::${entity.parentClass}`;
        const methodRelKey = { from: classFullName, to: entity.fullName, type: 'has_method' };
        relationsToCreateSetKG.add(JSON.stringify(methodRelKey));
    }

    // Infer 'calls_function' or 'calls_method' relations
    if (entity.calls && entity.calls.length > 0 && entity.fullName && fileNodeRelativeName) {
        for (const call of entity.calls) {
            // For now, assume called entities are within the same file or are global functions/methods.
            // A more advanced approach would involve resolving the full path of the called entity.
            const calledEntityFullName = `${fileNodeRelativeName}::${call.name}`;
            const callRelKey = { from: entity.fullName, to: calledEntityFullName, type: `calls_${call.type}` };
            relationsToCreateSetKG.add(JSON.stringify(callRelKey));
        }
    }

    // Infer 'implements_interface' relations
    if (entity.type === 'class' && entity.implementedInterfaces && entity.implementedInterfaces.length > 0 && entity.fullName && fileNodeRelativeName) {
        for (const implementedInterface of entity.implementedInterfaces) {
            const interfaceFullName = `${fileNodeRelativeName}::${implementedInterface}`; // Assuming interface is in the same file
            const implementsRelKey = { from: entity.fullName, to: interfaceFullName, type: 'implements_interface' };
            relationsToCreateSetKG.add(JSON.stringify(implementsRelKey));
        }
    }
}