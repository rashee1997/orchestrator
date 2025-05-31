// src/tools/knowledge_graph_tools.ts
import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate, schemas } from '../utils/validation.js';
import { formatSimpleMessage, formatJsonToMarkdownCodeBlock, formatObjectToMarkdown } from '../utils/formatters.js';
import { CodebaseIntrospectionService, ScannedItem, ExtractedImport, ExtractedCodeEntity } from '../database/services/CodebaseIntrospectionService.js';
import path from 'path';
import fs from 'fs/promises';

// Helper function to compare observation arrays (ignoring order for simple string arrays)
function haveObservationsChanged(oldObs: string[] | undefined, newObs: string[]): boolean {
    if (!oldObs) return true; // If old observations don't exist, they've changed
    if (oldObs.length !== newObs.length) return true;
    const oldSet = new Set(oldObs);
    for (const obs of newObs) {
        if (!oldSet.has(obs)) return true;
    }
    return false;
}


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
                model: { type: 'string', description: 'Optional: The Gemini model to use (e.g., "gemini-pro", "gemini-1.5-flash-latest"). Defaults to "gemini-1.5-flash-latest".', nullable: true },
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
                }
            },
            required: ['agent_id'],
        },
    },
];

export function getKnowledgeGraphToolHandlers(memoryManager: MemoryManager) {
    const codebaseIntrospectionService = new CodebaseIntrospectionService(memoryManager, memoryManager.getGeminiIntegrationService(), memoryManager.projectRootPath);

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
            const effectiveRootPath = path.resolve(project_root_path || directory_path); 
            const absoluteDirectoryPath = path.resolve(directory_path);

            if (!absoluteDirectoryPath.startsWith(effectiveRootPath)) {
                 throw new McpError(ErrorCode.InvalidParams, `Directory path (${absoluteDirectoryPath}) must be within the project root path (${effectiveRootPath}).`);
            }

            let nodesCreatedCount = 0;
            let nodesUpdatedCount = 0; // For observation updates
            let relationsCreatedCount = 0;
            
            const createdOrExistingNodeNamesByAbsolutePath: { [key: string]: string } = {}; 
            const entitiesToCreateBatch: Array<{ name: string; entityType: string; observations: string[] }> = [];
            const observationsToUpdateBatch: Array<{ entityName: string; contents: string[] }> = [];
            const relationsToCreateSet = new Set<string>(); // To store unique relation strings: "from-to-type"
            const moduleEntitiesToCreateBatch: Array<{ name: string; entityType: string; observations: string[] }> = [];
            const moduleNamesToProcessOrCreate = new Set<string>(); // To ensure a module is processed (checked/created) only once per run


            try {
                console.log(`[ingest_codebase_structure] Scanning directory: ${absoluteDirectoryPath} relative to root: ${effectiveRootPath}`);
                const scannedItems: ScannedItem[] = await codebaseIntrospectionService.scanDirectoryRecursive(agent_id, absoluteDirectoryPath, effectiveRootPath);
                console.log(`[ingest_codebase_structure] Scanned ${scannedItems.length} items.`);

                // Process the root directory itself if it's the target of ingestion
                if (absoluteDirectoryPath === effectiveRootPath) {
                    const rootNodeName = "."; 
                    try {
                        const rootStats = await fs.stat(effectiveRootPath);
                        const rootObservations = [
                            `absolute_path: ${effectiveRootPath}`,
                            `type: directory`,
                            `size_bytes: ${rootStats.size.toString()}`,
                            `created_at: ${rootStats.birthtime.toISOString()}`,
                            `modified_at: ${rootStats.mtime.toISOString()}`,
                        ];
                        const existingRootNodes = await memoryManager.knowledgeGraphManager.openNodes(agent_id, [rootNodeName]);
                        const existingRootNode = existingRootNodes.find((n: any) => n.name === rootNodeName && n.entityType === 'directory');

                        if (existingRootNode) {
                            createdOrExistingNodeNamesByAbsolutePath[effectiveRootPath] = rootNodeName;
                            if (haveObservationsChanged(existingRootNode.observations, rootObservations)) {
                                observationsToUpdateBatch.push({ entityName: rootNodeName, contents: rootObservations });
                            }
                        } else {
                            entitiesToCreateBatch.push({ name: rootNodeName, entityType: 'directory', observations: rootObservations });
                            createdOrExistingNodeNamesByAbsolutePath[effectiveRootPath] = rootNodeName;
                        }
                    } catch (statError: any) {
                        console.warn(`[ingest_codebase_structure] Could not stat project root path ${effectiveRootPath}: ${statError.message}`);
                    }
                }

                // Process scanned files and directories
                for (const item of scannedItems) {
                    const entityName = item.name === "" ? "." : item.name; // item.name is already relative
                    const currentObservations = [
                        `absolute_path: ${item.path}`,
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
                        createdOrExistingNodeNamesByAbsolutePath[item.path] = existingNode.name; // Use existing name
                        if (haveObservationsChanged(existingNode.observations, currentObservations)) {
                            // Collect only the new/changed observations to append
                            const newObsToAdd = currentObservations.filter(obs => !(existingNode.observations || []).includes(obs));
                            if (newObsToAdd.length > 0) {
                                observationsToUpdateBatch.push({ entityName: existingNode.name, contents: newObsToAdd });
                            }
                        }
                    } else {
                        entitiesToCreateBatch.push({ name: entityName, entityType: item.type, observations: currentObservations });
                        createdOrExistingNodeNamesByAbsolutePath[item.path] = entityName;
                    }

                    // Create 'contains_item' relation
                    const parentDirAbsolutePath = path.dirname(item.path);
                    if (parentDirAbsolutePath !== item.path && parentDirAbsolutePath.startsWith(effectiveRootPath)) { 
                        let parentDirNodeName = createdOrExistingNodeNamesByAbsolutePath[parentDirAbsolutePath];
                        if (!parentDirNodeName) {
                             parentDirNodeName = path.relative(effectiveRootPath, parentDirAbsolutePath).replace(/\\/g, '/');
                             if (parentDirNodeName === "") parentDirNodeName = ".";
                             // Assume parent directory node will be created or already exists from the scan order
                             if (!createdOrExistingNodeNamesByAbsolutePath[parentDirAbsolutePath] && !entitiesToCreateBatch.find(e=>e.name === parentDirNodeName && e.entityType === 'directory')) {
                                // This case implies the parent wasn't in scannedItems yet (e.g. if scan wasn't perfectly top-down or root was special)
                                // Or it was already processed. We rely on createdOrExistingNodeNamesByAbsolutePath for already processed ones.
                                console.warn(`[ingest_codebase_structure] Parent directory ${parentDirNodeName} for ${entityName} not yet processed or found. Relation might be incomplete if parent is not created.`);
                             }
                        }
                        const relationString = `${parentDirNodeName}-${entityName}-contains_item`;
                        if (!relationsToCreateSet.has(relationString)) {
                            relationsToCreateSet.add(relationString);
                        }
                    }
                }
                
                // Batch create new entities
                if (entitiesToCreateBatch.length > 0) {
                    console.log(`[ingest_codebase_structure] Batch creating ${entitiesToCreateBatch.length} file/directory nodes.`);
                    const creationResult = await memoryManager.knowledgeGraphManager.createEntities(agent_id, entitiesToCreateBatch);
                    nodesCreatedCount += Array.isArray(creationResult) ? creationResult.length : 0;
                }

                // Batch update observations for existing entities
                if (observationsToUpdateBatch.length > 0) {
                    console.log(`[ingest_codebase_structure] Batch updating observations for ${observationsToUpdateBatch.length} nodes.`);
                    const updateResult = await memoryManager.knowledgeGraphManager.addObservations(agent_id, observationsToUpdateBatch);
                    nodesUpdatedCount += Array.isArray(updateResult) ? updateResult.length : 0;
                }

                // Process imports
                if (parse_imports) {
                    console.log(`[ingest_codebase_structure] Parsing imports...`);
                    for (const item of scannedItems) {
                        if (item.type === 'file' && item.language && ['typescript', 'javascript', 'python', 'php'].includes(item.language)) {
                            const fileNodeName = createdOrExistingNodeNamesByAbsolutePath[item.path]; 
                            if (!fileNodeName) {
                                console.warn(`[ingest_codebase_structure] Could not find KG node name for file path: ${item.path} during import parsing.`);
                                continue;
                            }
                            const extractedImports: ExtractedImport[] = await codebaseIntrospectionService.parseFileForImports(agent_id, item.path, item.language);
                            for (const imp of extractedImports) {
                                let toNodeName = imp.targetPath;
                                let toNodeType = imp.type; 

                                if (imp.type === 'file') {
                                    let resolvedAbsoluteImportPath = path.isAbsolute(imp.targetPath) ? imp.targetPath : path.resolve(path.dirname(item.path), imp.targetPath);
                                    resolvedAbsoluteImportPath = resolvedAbsoluteImportPath.replace(/\\/g, '/');

                                    if (createdOrExistingNodeNamesByAbsolutePath[resolvedAbsoluteImportPath]) {
                                        toNodeName = createdOrExistingNodeNamesByAbsolutePath[resolvedAbsoluteImportPath];
                                    } else if (resolvedAbsoluteImportPath.startsWith(effectiveRootPath + path.sep)) {
                                         toNodeName = path.relative(effectiveRootPath, resolvedAbsoluteImportPath).replace(/\\/g, '/');
                                    } else {
                                        console.warn(`[ingest_codebase_structure] Import target ${imp.targetPath} from ${fileNodeName} (resolved to ${resolvedAbsoluteImportPath}) is outside project or not found in scan. Treating as external module: ${imp.targetPath}`);
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
                                const relationString = `${fileNodeName}-${toNodeName}-${imp.type === 'file' ? 'imports_file' : 'imports_module'}`;
                                if (!relationsToCreateSet.has(relationString)) {
                                    relationsToCreateSet.add(relationString);
                                }
                            }
                        }
                    }
                    if (moduleEntitiesToCreateBatch.length > 0) {
                        console.log(`[ingest_codebase_structure] Batch creating ${moduleEntitiesToCreateBatch.length} module nodes.`);
                        const moduleCreationResult = await memoryManager.knowledgeGraphManager.createEntities(agent_id, moduleEntitiesToCreateBatch);
                        nodesCreatedCount += Array.isArray(moduleCreationResult) ? moduleCreationResult.length : 0;
                    }
                }
                
                // Prepare and create relations
                const finalRelationsToCreate: Array<{ from: string; to: string; relationType: string, observations?: string[] }> = [];
                for (const relStr of relationsToCreateSet) {
                    const [from, to, type] = relStr.split('-'); // This is a simplification, observations are lost
                    // A more robust way would be to store the relation objects and deduplicate based on a composite key
                    // For now, this simplified split assumes observations are not part of uniqueness for this set
                    finalRelationsToCreate.push({ from, to, relationType: type });
                }


                if (finalRelationsToCreate.length > 0) {
                    console.log(`[ingest_codebase_structure] Batch creating ${finalRelationsToCreate.length} relations.`);
                    // It's important that createRelations can handle cases where relations might already exist
                    // or that the KG manager itself handles idempotency for relations if possible.
                    // KnowledgeGraphManagerV2.createRelations creates new UUIDs for each relation, so it doesn't deduplicate by content.
                    // A pre-check for existing relations would be needed here for true idempotency of relations.
                    // For now, we proceed, which might create duplicate relation entries if run multiple times without graph compaction/cleanup.
                    const relationResult = await memoryManager.knowledgeGraphManager.createRelations(agent_id, finalRelationsToCreate);
                    relationsCreatedCount += Array.isArray(relationResult) ? relationResult.length : 0;
                }

                return {
                    content: [{
                        type: 'text', text: formatSimpleMessage(
                            `Codebase structure ingestion for directory "${directory_path}" complete.\n- Nodes Newly Created: ${nodesCreatedCount}\n- Nodes Updated (Observations): ${nodesUpdatedCount}\n- Relations Created: ${relationsCreatedCount}`,
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
            const effectiveRootPath = path.resolve(project_root_path || path.dirname(file_path));
            const absoluteFilePath = path.resolve(file_path);

            if (!absoluteFilePath.startsWith(effectiveRootPath)) {
                 throw new McpError(ErrorCode.InvalidParams, `File path (${absoluteFilePath}) must be within the project root path (${effectiveRootPath}).`);
            }

            let entitiesCreatedCount = 0;
            let entitiesUpdatedCount = 0;
            let relationsCreatedCount = 0;

            try {
                const fileNodeRelativeName = path.relative(effectiveRootPath, absoluteFilePath).replace(/\\/g, '/');
                let fileNodeInKG: any;
                
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
                            `absolute_path: ${absoluteFilePath}`,
                            `type: file`,
                            `language: ${detectedLang || 'unknown'}`,
                            `size_bytes: ${stats.size.toString()}`,
                            `created_at: ${stats.birthtime.toISOString()}`,
                            `modified_at: ${stats.mtime.toISOString()}`,
                        ]
                    };
                    const creationResult = await memoryManager.knowledgeGraphManager.createEntities(agent_id, [fileEntityToCreate]);
                    entitiesCreatedCount += Array.isArray(creationResult) ? creationResult.length : 0;
                    // Re-fetch after creation to get the ID
                    const newNodes = await memoryManager.knowledgeGraphManager.openNodes(agent_id, [fileNodeRelativeName]);
                    fileNodeInKG = newNodes.find((n: any) => n.name === fileNodeRelativeName && n.entityType === 'file');
                }
                if (!fileNodeInKG) {
                     throw new McpError(ErrorCode.InternalError, `Failed to create or find file node for ${fileNodeRelativeName}.`);
                }

                const langForParsing = lang_arg || fileNodeInKG.observations?.find((o:string) => o.startsWith("language:"))?.split(": ")[1] || await codebaseIntrospectionService.detectLanguage(agent_id, absoluteFilePath, path.basename(absoluteFilePath));
                
const extractedEntities: ExtractedCodeEntity[] = await codebaseIntrospectionService.parseFileForCodeEntities(agent_id, absoluteFilePath, langForParsing);

                if (extractedEntities.length === 0) {
                    return { content: [{ type: 'text', text: formatSimpleMessage(`No code entities found or extracted from file: ${file_path}`, "Code Entity Ingestion") }] };
                }

                const entitiesToCreateBatch: Array<{ name: string; entityType: string; observations: string[] }> = [];
                const observationsToUpdateBatchKG: Array<{ entityName: string; contents: string[] }> = [];
                const relationsToCreateSetKG = new Set<string>();

                for (const entity of extractedEntities) {
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

                    const existingEntities = await memoryManager.knowledgeGraphManager.openNodes(agent_id, [entity.fullName]);
                    const existingEntityNode = existingEntities.find((n:any) => n.name === entity.fullName && n.entityType === entity.type);

                    if (existingEntityNode) {
                        if (haveObservationsChanged(existingEntityNode.observations, currentObservations)) {
                             const newObsToAdd = currentObservations.filter(obs => !(existingEntityNode.observations || []).includes(obs));
                             if (newObsToAdd.length > 0) {
                                observationsToUpdateBatchKG.push({ entityName: existingEntityNode.name, contents: newObsToAdd });
                             }
                        }
                    } else {
                        entitiesToCreateBatch.push({
                            name: entity.fullName, 
                            entityType: entity.type,
                            observations: currentObservations,
                        });
                    }
                    
                    const defRel = `${entity.fullName}-${fileNodeRelativeName}-defined_in_file`;
                    if(!relationsToCreateSetKG.has(defRel)) relationsToCreateSetKG.add(defRel);

                    if (entity.type === 'method' && entity.className && entity.filePath) {
                        const classFullName = `${entity.filePath}::${entity.className}`; 
                        const methodRel = `${classFullName}-${entity.fullName}-has_method`;
                        if(!relationsToCreateSetKG.has(methodRel)) relationsToCreateSetKG.add(methodRel);
                    }
                }

                if (entitiesToCreateBatch.length > 0) {
                   const creationResult = await memoryManager.knowledgeGraphManager.createEntities(agent_id, entitiesToCreateBatch);
                   entitiesCreatedCount += Array.isArray(creationResult) ? creationResult.length : 0;
                }
                if (observationsToUpdateBatchKG.length > 0) {
                    const updateResult = await memoryManager.knowledgeGraphManager.addObservations(agent_id, observationsToUpdateBatchKG);
                    entitiesUpdatedCount += Array.isArray(updateResult) ? updateResult.length : 0;
                }
                
                const finalRelationsToCreateKG: Array<{ from: string; to: string; relationType: string }> = [];
                for (const relStr of relationsToCreateSetKG) {
                    const parts = relStr.split('-');
                    finalRelationsToCreateKG.push({ from: parts[0], to: parts[1], relationType: parts[2]});
                }

                if (finalRelationsToCreateKG.length > 0) {
                    const relationResult = await memoryManager.knowledgeGraphManager.createRelations(agent_id, finalRelationsToCreateKG);
                    relationsCreatedCount += Array.isArray(relationResult) ? relationResult.length : 0;
                }

                return {
                    content: [{
                        type: 'text', text: formatSimpleMessage(
                            `Code entity ingestion for file "${file_path}" complete.\n- Code Entities Newly Created: ${entitiesCreatedCount}\n- Code Entities Updated (Observations): ${entitiesUpdatedCount}\n- Relations Created: ${relationsCreatedCount}`,
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
            let kgResultText: string; // Changed from kgResult to kgResultText
            let title = `Knowledge Graph Operation: ${operation} for Agent: ${agent_id}`;
            let resultData: any;

            try {
                switch (operation) {
                    case 'create_entities':
                        if (!args.entities || !Array.isArray(args.entities) || args.entities.length === 0) throw new McpError(ErrorCode.InvalidParams, "Missing or empty 'entities' array for 'create_entities' operation.");
                        const entitiesToCreateOp: any[] = [];
                        const observationsToUpdateOp: any[] = [];
                        let createdOpCount = 0;
                        let updatedOpCount = 0;

                        for (const entity of args.entities) {
                            if (!entity.name || !entity.entityType) throw new McpError(ErrorCode.InvalidParams, "Each entity must have a 'name' and 'entityType'.");
                            const existingNodes = await memoryManager.knowledgeGraphManager.openNodes(agent_id, [entity.name]);
                            const existingNode = existingNodes.find((n: any) => n.name === entity.name && n.entityType === entity.entityType);
                            if (existingNode) {
                                if (entity.observations && entity.observations.length > 0 && haveObservationsChanged(existingNode.observations, entity.observations)) {
                                     const newObsToAdd = entity.observations.filter((obs:string) => !(existingNode.observations || []).includes(obs));
                                     if(newObsToAdd.length > 0) {
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
                        resultData = { message: `Create entities operation: ${createdOpCount} created, ${updatedOpCount} updated.`, details: { created: entitiesToCreateOp, updated_observations_for: observationsToUpdateOp.map(o=>o.entityName) } };
                        break;
                    case 'create_relations':
                        if (!args.relations || !Array.isArray(args.relations) || args.relations.length === 0) throw new McpError(ErrorCode.InvalidParams, "Missing or empty 'relations' array for 'create_relations' operation.");
                         args.relations.forEach((relation: any) => {
                            if (!relation.from || !relation.to || !relation.relationType) throw new McpError(ErrorCode.InvalidParams, "Each relation must have 'from', 'to', and 'relationType'.");
                        });
                        // Add pre-check for existing relations to avoid duplicates if desired
                        // For now, KnowledgeGraphManagerV2.createRelations creates new UUIDs, so it doesn't deduplicate by content.
                        resultData = await memoryManager.knowledgeGraphManager.createRelations(agent_id, args.relations);
                        break;
                    case 'add_observations':
                        if (!args.observations || !Array.isArray(args.observations) || args.observations.length === 0) throw new McpError(ErrorCode.InvalidParams, "Missing or empty 'observations' array for 'add_observations' operation.");
                        resultData = await memoryManager.knowledgeGraphManager.addObservations(agent_id, args.observations);
                        break;
                    case 'delete_entities':
                        if (!args.entityNames || !Array.isArray(args.entityNames) || args.entityNames.length === 0) throw new McpError(ErrorCode.InvalidParams, "Missing or empty 'entityNames' array for 'delete_entities' operation.");
                        await memoryManager.knowledgeGraphManager.deleteEntities(agent_id, args.entityNames); // Returns void
                        resultData = { message: `Delete entities operation completed for names: ${args.entityNames.join(', ')}.`};
                        break;
                    case 'delete_observations':
                        if (!args.deletions || !Array.isArray(args.deletions) || args.deletions.length === 0) throw new McpError(ErrorCode.InvalidParams, "Missing or empty 'deletions' array for 'delete_observations' operation.");
                        resultData = await memoryManager.knowledgeGraphManager.deleteObservations(agent_id, args.deletions);
                        break;
                    case 'delete_relations':
                        if (!args.relations || !Array.isArray(args.relations) || args.relations.length === 0) throw new McpError(ErrorCode.InvalidParams, "Missing or empty 'relations' array for 'delete_relations' operation.");
                        await memoryManager.knowledgeGraphManager.deleteRelations(agent_id, args.relations); // Returns void
                        resultData = { message: `Delete relations operation completed.`};
                        break;
                    case 'read_graph':
                        resultData = await memoryManager.knowledgeGraphManager.readGraph(agent_id);
                        title = `Full Knowledge Graph for Agent: ${agent_id}`;
                        break;
                    case 'search_nodes':
                        if (!args.query) throw new McpError(ErrorCode.InvalidParams, "Missing 'query' argument for 'search_nodes' operation.");
                        resultData = await memoryManager.knowledgeGraphManager.searchNodes(agent_id, args.query as string);
                        title = `Knowledge Graph Node Search (Query: "${args.query}") for Agent: ${agent_id}`;
                        break;
                    case 'open_nodes':
                        if (!args.names || !Array.isArray(args.names) || args.names.length === 0) throw new McpError(ErrorCode.InvalidParams, "Missing or empty 'names' array for 'open_nodes' operation.");
                        resultData = await memoryManager.knowledgeGraphManager.openNodes(agent_id, args.names as string[]);
                        title = `Knowledge Graph Nodes (Names: ${args.names.join(', ')}) for Agent: ${agent_id}`;
                        break;
                    default:
                        throw new McpError(
                            ErrorCode.MethodNotFound,
                            `Unknown knowledge_graph_memory operation: ${operation}.`
                        );
                }

                // Standardize response format
                if (operation === 'read_graph' || operation === 'search_nodes' || operation === 'open_nodes') {
                     kgResultText = `## ${title}\n\n`;
                     if ((Array.isArray(resultData) && resultData.length === 0) || 
                         (typeof resultData === 'object' && resultData !== null && resultData.nodes && Array.isArray(resultData.nodes) && resultData.nodes.length === 0 && (!resultData.relations || resultData.relations.length === 0) ) ){
                        kgResultText += `*No results found or graph is empty.*\n`;
                     } else {
                        kgResultText += formatJsonToMarkdownCodeBlock(resultData);
                     }
                } else if (resultData && typeof resultData.message === 'string') { // For operations that return a status message and details
                     kgResultText = `## ${title}\n\n**Status:** ${resultData.message}\n`;
                     if(resultData.details) kgResultText += `\n**Details:**\n${formatJsonToMarkdownCodeBlock(resultData.details)}\n`;
                } else { // Generic fallback for other results (e.g. array of updated nodes)
                    kgResultText = `## ${title}\n\nOperation completed. Result:\n${formatJsonToMarkdownCodeBlock(resultData)}\n`;
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
            // model arg is optional, GeminiIntegrationService has a default
            try {
                const resultJsonString = await memoryManager.knowledgeGraphManager.queryNaturalLanguage(agent_id, args.query);
                const result = JSON.parse(resultJsonString); // Result from queryNaturalLanguage is already a JSON string.

                let md = `## Natural Language Query Result for Agent: \`${agent_id}\`\n\n`;
                md += `**Query:** "${args.query}"\n\n`;

                if (result.metadata) {
                    md += `### Query Translation\n`;
                    md += `- **Operation:** \`${result.metadata.translatedOperation}\`\n`;
                    md += `- **Arguments:**\n${formatJsonToMarkdownCodeBlock(result.metadata.translatedArgs)}\n`;
                    if (result.metadata.assumptions) md += `- **Assumptions:** ${result.metadata.assumptions}\n`;
                    md += `- **Used Gemini for Translation:** ${result.metadata.usedGemini ? 'Yes' : 'No'}\n\n`;
                } else {
                    md += `*Query translation metadata not available.*\n\n`;
                }
                
                md += `### Results\n`;
                if (result.results) {
                    if (result.results.error) {
                         md += `**Error from Query Execution:** ${result.results.error}\n`;
                    } else if ((Array.isArray(result.results) && result.results.length === 0) || 
                               (typeof result.results === 'object' && result.results.nodes && Array.isArray(result.results.nodes) && result.results.nodes.length === 0 && (!result.results.relations || result.results.relations.length === 0))) {
                        md += `*No results found matching the query.*\n`;
                    } else {
                        md += formatJsonToMarkdownCodeBlock(result.results);
                    }
                } else {
                     md += `*No results data in the response.*\n`;
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
                let md = `## Relation Inference Result for Agent: \`${agent_id}\`\n\n`;
                if(args.entity_names && args.entity_names.length > 0) md += `**Focused Entities:** ${args.entity_names.map((e:string) => `\`${e}\``).join(', ')}\n`;
                if(args.context) md += `**Additional Context:** ${args.context}\n`;
                md += `\n**Status:** ${result.message}\n\n`;
                
                if(result.details && result.details.length > 0){
                    md += `### Proposed/Added Relations:\n\n`;
                    md += `| From | To | Relation Type | Confidence | Evidence | Status |\n`;
                    md += `|------|----|---------------|------------|----------|--------|\n`;
                    
                    result.details.forEach((rel: any) => {
                        const confidence = rel.confidence ? `${(rel.confidence * 100).toFixed(0)}%` : 'N/A';
                        const evidence = rel.evidence || 'No specific evidence provided';
                        const status = rel.status || 'proposed_by_ai'; // Default if not set
                        const statusEmoji = status.startsWith('added') ? '✅' : status.startsWith('failed') ? '❌' : '🔍';
                        
                        md += `| \`${rel.from}\` | \`${rel.to}\` | \`${rel.relationType}\` | ${confidence} | ${evidence.substring(0, 50)}${evidence.length > 50 ? '...' : ''} | ${statusEmoji} ${status} |\n`;
                    });
                    
                    md += `\n### Legend:\n`;
                    md += `- ✅ **added_by_ai**: High-confidence relation automatically added.\n`;
                    md += `- 🔍 **proposed_by_ai**: Relation proposed by AI, requires review.\n`;
                    md += `- ❌ **failed**: Relation could not be added.\n`;
                } else {
                    md += `*No new relations were inferred or added.*\n`;
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
                let md = `## Knowledge Graph Visualization for Agent: \`${agent_id}\`\n`;

                if (args.natural_language_query) {
                    md += `**Based on Natural Language Query:** "${args.natural_language_query}"\n`;
                    // The generateMermaidGraph in KGManagerV2 now handles NLQ internally if needed
                    // For this tool, we'll pass the NLQ to the options for generateMermaidGraph
                    const visualizationOptions = {
                        query: args.query, // Can be null if only NLQ is used
                        natural_language_query: args.natural_language_query,
                        layoutDirection: args.layout_direction || 'TD',
                        depth: args.depth || 2,
                        includeLegend: args.include_legend !== false,
                        groupByDirectory: args.group_by_directory || false
                    };
                     mermaidGraph = await memoryManager.knowledgeGraphManager.generateMermaidGraph(
                        agent_id,
                        visualizationOptions
                    );
                } else {
                    if (args.query) md += `**Based on Direct Query:** "${args.query}"\n`;
                    const visualizationOptions = {
                        query: args.query,
                        layoutDirection: args.layout_direction || 'TD',
                        depth: args.depth || 2,
                        includeLegend: args.include_legend !== false,
                        groupByDirectory: args.group_by_directory || false
                    };
                    mermaidGraph = await memoryManager.knowledgeGraphManager.generateMermaidGraph(
                        agent_id,
                        visualizationOptions
                    );
                }

                if (args.layout_direction && args.layout_direction !== 'TD') md += `**Layout:** ${args.layout_direction}\n`;
                if (args.group_by_directory) md += `**Grouping:** By directory\n`;
                md += `\n\`\`\`mermaid\n${mermaidGraph}\n\`\`\`\n`;
                return { content: [{ type: 'text', text: md }] };
            } catch (error: any) {
                console.error(`Error in kg_visualize tool (agent: ${agent_id}):`, error);
                if (error instanceof McpError) throw error;
                throw new McpError(ErrorCode.InternalError, `Knowledge graph visualization failed: ${error.message}`);
            }
        },
    };
}
