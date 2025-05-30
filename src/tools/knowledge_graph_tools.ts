// src/tools/knowledge_graph_tools.ts
import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate, schemas } from '../utils/validation.js';
import { formatSimpleMessage, formatJsonToMarkdownCodeBlock, formatObjectToMarkdown } from '../utils/formatters.js';
import { CodebaseIntrospectionService, ScannedItem, ExtractedImport, ExtractedCodeEntity } from '../database/services/CodebaseIntrospectionService.js';
import path from 'path';
import fs from 'fs/promises';

export const knowledgeGraphToolDefinitions = [
    {
        name: 'ingest_codebase_structure',
        description: `Scans a specified directory, creating knowledge graph nodes for files and folders.
It also establishes 'contains_item' relationships between directories and their contents.
If 'parse_imports' is true, it will attempt to parse import statements from supported files (currently TypeScript/JavaScript)
and create 'imports_file' or 'imports_module' relationships.
This tool is primarily for initial KG population from a codebase. Output is Markdown formatted.`,
        inputSchema: schemas.ingestCodebaseStructure,
    },
    {
        name: 'ingest_file_code_entities',
        description: `Parses a specified code file to extract detailed code entities like functions, classes, and interfaces.
It populates these as nodes in the knowledge graph and creates 'defined_in_file' relationships
linking them to their parent file node. It may also create 'has_method' relationships for classes.
Output is Markdown formatted.`,
        inputSchema: schemas.ingestFileCodeEntities, // Use the new schema
    },
    {
        name: 'knowledge_graph_memory',
        description: `A tool for interacting with the knowledge graph memory. Output is Markdown formatted. Supported operations:
- "create_entities": Adds new entities (nodes) to the graph. Requires 'entities' array in arguments.
- "create_relations": Adds new relationships between existing entities. Requires 'relations' array in arguments.
// ... (rest of description as before) ...
- "open_nodes": Retrieves specific nodes by their names. Requires 'names' array in arguments.`,
        inputSchema: { /* ... existing schema for knowledge_graph_memory ... */
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
                            observations: { type: 'array', items: { type: 'string' } }
                        },
                        required: ['name', 'entityType', 'observations']
                    },
                    description: "Required for 'create_entities' operation."
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
                    description: "Required for 'create_relations' and 'delete_relations' operations."
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
                    description: "Required for 'add_observations' operation."
                },
                entityNames: {
                    type: 'array',
                    items: { type: 'string' },
                    description: "Required for 'delete_entities' operation."
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
                    description: "Required for 'delete_observations' operation."
                },
                query: {
                    type: 'string',
                    description: "Required for 'search_nodes' operation."
                },
                names: {
                    type: 'array',
                    items: { type: 'string' },
                    description: "Required for 'open_nodes' operation."
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
                    description: 'Optional: A list of entity names to focus the inference on. If not provided, inference may be broader.'
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
                }
            },
            required: ['agent_id'],
        },
    },
];

export function getKnowledgeGraphToolHandlers(memoryManager: MemoryManager) {
    const codebaseIntrospectionService = new CodebaseIntrospectionService(memoryManager);

    return {
        'ingest_codebase_structure': async (args: any, agent_id_from_server: string) => {
            // ... (handler logic from kg_tools_with_ingest_structure, no changes needed here for this step) ...
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for ingest_codebase_structure.");
            }

            const validationResult = validate('ingestCodebaseStructure', args);
            if (!validationResult.valid) {
                throw new McpError(ErrorCode.InvalidParams, `Validation failed for ingest_codebase_structure: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`);
            }

            const { directory_path, project_root_path, parse_imports } = args;
            const effectiveRootPath = project_root_path || directory_path; 

            let nodesCreatedCount = 0;
            let relationsCreatedCount = 0;
            const createdNodeNames: { [key: string]: string } = {}; 

            try {
                const scannedItems: ScannedItem[] = await codebaseIntrospectionService.scanDirectoryRecursive(agent_id, directory_path, effectiveRootPath);

                const entitiesToCreate: Array<{ name: string; entityType: string; observations: string[] }> = [];
                const relationsToCreate: Array<{ from: string; to: string; relationType: string, observations?: string[] }> = [];

                for (const item of scannedItems) {
                    const entityName = item.name; 
                    createdNodeNames[item.path] = entityName; 

                    const observations = [
                        `absolute_path: ${item.path}`, // Store absolute path for clarity
                        `type: ${item.type}`,
                        `size_bytes: ${item.stats.size}`,
                        `created_at: ${item.stats.birthtime.toISOString()}`,
                        `modified_at: ${item.stats.mtime.toISOString()}`,
                    ];
                    if (item.type === 'file' && item.language) {
                        observations.push(`language: ${item.language}`);
                    }

                    entitiesToCreate.push({
                        name: entityName, 
                        entityType: item.type,
                        observations: observations,
                    });

                    const parentDirAbsolutePath = path.dirname(item.path);
                    if (parentDirAbsolutePath !== item.path && parentDirAbsolutePath.startsWith(path.resolve(effectiveRootPath))) { 
                        const parentDirRelativeName = path.relative(effectiveRootPath, parentDirAbsolutePath).replace(/\\/g, '/');
                        const fromNodeName = parentDirRelativeName === '' ? "." : parentDirRelativeName; 
                        
                        if (parentDirAbsolutePath >= effectiveRootPath || parentDirRelativeName === '') { 
                             relationsToCreate.push({
                                from: fromNodeName, 
                                to: entityName,          
                                relationType: 'contains_item'
                            });
                        }
                    }
                }
                
                const rootDirNodeNameForKg = "."; // Canonical name for project root relative to itself
                const rootDirExistsInScan = scannedItems.find(item => item.path === path.resolve(effectiveRootPath) && item.name === ""); // Check if root itself was scanned (it wouldn't be if directory_path is a subfolder)
                
                if (directory_path === effectiveRootPath && !entitiesToCreate.some(e => e.name === rootDirNodeNameForKg && e.entityType === 'directory')) {
                    const rootStats = await fs.stat(effectiveRootPath);
                     const rootEntity = {
                        name: rootDirNodeNameForKg, 
                        entityType: 'directory' as 'directory',
                        observations: [
                            `absolute_path: ${path.resolve(effectiveRootPath)}`,
                            `type: directory`,
                            `size_bytes: ${rootStats.size}`,
                            `created_at: ${rootStats.birthtime.toISOString()}`,
                            `modified_at: ${rootStats.mtime.toISOString()}`,
                        ]
                    };
                    entitiesToCreate.push(rootEntity); // Add to batch
                    createdNodeNames[path.resolve(effectiveRootPath)] = rootDirNodeNameForKg;
                }


                if (entitiesToCreate.length > 0) {
                    const creationResult = await memoryManager.knowledgeGraphManager.createEntities(agent_id, entitiesToCreate);
                    nodesCreatedCount += creationResult.details.filter((d: any) => d.success).length;
                }

                if (parse_imports) {
                    for (const item of scannedItems) {
                        if (item.type === 'file' && (item.language === 'typescript' || item.language === 'javascript')) {
                            const fileNodeName = createdNodeNames[item.path]; 
                            if (!fileNodeName) {
                                console.warn(`Could not find KG node name for file path: ${item.path}. Skipping import parsing.`);
                                continue;
                            }
                            const extractedImports: ExtractedImport[] = await codebaseIntrospectionService.parseFileForImports(agent_id, item.path, item.language);
                            for (const imp of extractedImports) {
                                let toNodeName = imp.targetPath;
                                let toNodeType = imp.type; // 'file', 'module', 'external_library'

                                if (imp.type === 'file') {
                                    let resolvedAbsoluteImportPath = path.resolve(path.dirname(item.path), imp.targetPath);
                                    
                                    // Handle .js imports that correspond to .ts source files
                                    if (resolvedAbsoluteImportPath.endsWith('.js')) {
                                        const tsEquivalentPath = resolvedAbsoluteImportPath.slice(0, -3) + '.ts';
                                        try {
                                            // Check if the .ts file actually exists
                                            await fs.access(tsEquivalentPath); 
                                            resolvedAbsoluteImportPath = tsEquivalentPath; // Use the .ts path if it exists
                                        } catch (e) {
                                            // .ts equivalent does not exist, proceed with .js or reclassify
                                            // console.warn(`No .ts equivalent found for .js import: ${tsEquivalentPath}`);
                                        }
                                    }

                                    if (resolvedAbsoluteImportPath.startsWith(path.resolve(effectiveRootPath))) {
                                         toNodeName = path.relative(effectiveRootPath, resolvedAbsoluteImportPath).replace(/\\/g, '/');
                                    } else {
                                        // If it resolves outside the project root, treat it as an unresolvable local file or an error
                                        console.warn(`Import target ${imp.targetPath} from ${fileNodeName} resolves outside project root to ${resolvedAbsoluteImportPath}. Treating as external module.`);
                                        toNodeName = imp.targetPath; // Keep original specifier
                                        toNodeType = 'module'; // Reclassify
                                    }
                                }
                                
                                if (toNodeType === 'external_library' || toNodeType === 'module') {
                                    const moduleEntity = { name: toNodeName, entityType: 'module', observations: [`type: ${toNodeType}`] };
                                    try {
                                        // Check if module node already exists to avoid duplicate creation attempts or use createEntities which handles it
                                        const existingModule = await memoryManager.knowledgeGraphManager.openNodes(agent_id, [toNodeName]);
                                        if (!existingModule || existingModule.length === 0) {
                                           const creationResult = await memoryManager.knowledgeGraphManager.createEntities(agent_id, [moduleEntity]);
                                           if (creationResult.details.some((d:any) => d.success)) nodesCreatedCount++;
                                        }
                                    } catch (e) { console.warn(`Could not ensure module node ${toNodeName}: ${e}`); }
                                }
                                relationsToCreate.push({
                                    from: fileNodeName,
                                    to: toNodeName,
                                    relationType: imp.type === 'file' ? 'imports_file' : 'imports_module',
                                    observations: imp.importedSymbols ? [`symbols: ${imp.importedSymbols.join(', ')}`] : undefined
                                });
                            }
                        }
                    }
                }

                if (relationsToCreate.length > 0) {
                    const relationResult = await memoryManager.knowledgeGraphManager.createRelations(agent_id, relationsToCreate);
                    relationsCreatedCount += relationResult.details.filter((d: any) => d.success).length;
                }

                return {
                    content: [{
                        type: 'text', text: formatSimpleMessage(
                            `Codebase structure ingestion for directory "${directory_path}" complete.\n- Nodes Created/Updated: ${nodesCreatedCount}\n- Relations Created: ${relationsCreatedCount}`,
                            "Codebase Ingestion Report"
                        )
                    }]
                };

            } catch (error: any) {
                console.error(`Error during codebase structure ingestion for agent ${agent_id}, path ${directory_path}:`, error);
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

            const { file_path, project_root_path, language } = args;
            const effectiveRootPath = project_root_path || path.dirname(file_path); // Fallback for relative naming

            let entitiesCreatedCount = 0;
            let relationsCreatedCount = 0;

            try {
                // Ensure the file node itself exists or create it.
                // The name in KG should be relative to effectiveRootPath.
                const fileNodeRelativeName = path.relative(effectiveRootPath, file_path).replace(/\\/g, '/');
                let fileNodeExists = false;
                try {
                    const existingFileNode = await memoryManager.knowledgeGraphManager.openNodes(agent_id, [fileNodeRelativeName]);
                    if (existingFileNode && existingFileNode.length > 0) {
                        fileNodeExists = true;
                    }
                } catch (e) { /* Node might not exist, that's fine */ }

                if (!fileNodeExists) {
                    const stats = await fs.stat(file_path);
                    const lang = await codebaseIntrospectionService.detectLanguage(agent_id, file_path, path.basename(file_path)); // Use the service method
                    const fileEntity = {
                        name: fileNodeRelativeName,
                        entityType: 'file' as 'file',
                        observations: [
                            `absolute_path: ${file_path}`,
                            `type: file`,
                            `language: ${lang || 'unknown'}`,
                            `size_bytes: ${stats.size}`,
                            `created_at: ${stats.birthtime.toISOString()}`,
                            `modified_at: ${stats.mtime.toISOString()}`,
                        ]
                    };
                    const creationResult = await memoryManager.knowledgeGraphManager.createEntities(agent_id, [fileEntity]);
                    if (creationResult.details.some((d:any) => d.success)) entitiesCreatedCount++;
                }


                const extractedEntities: ExtractedCodeEntity[] = await codebaseIntrospectionService.parseFileForCodeEntities(agent_id, file_path, language);

                if (extractedEntities.length === 0) {
                    return { content: [{ type: 'text', text: formatSimpleMessage(`No code entities found or extracted from file: ${file_path}`, "Code Entity Ingestion") }] };
                }

                const entitiesToCreateKG: Array<{ name: string; entityType: string; observations: string[] }> = [];
                const relationsToCreateKG: Array<{ from: string; to: string; relationType: string, observations?: string[] }> = [];

                for (const entity of extractedEntities) {
                    // entity.fullName is already relative if CodebaseIntrospectionService sets it correctly
                    const observations = [
                        `type: ${entity.type}`,
                        `signature: ${entity.signature || 'N/A'}`,
                        `lines: ${entity.startLine}-${entity.endLine}`,
                        `exported: ${entity.isExported ? 'yes' : 'no'}`
                    ];
                    if (entity.docstring) observations.push(`docstring: ${entity.docstring.substring(0, 200)}...`); // Truncate long docstrings for observation
                    if (entity.parameters && entity.parameters.length > 0) observations.push(`parameters: ${JSON.stringify(entity.parameters)}`);
                    if (entity.returnType) observations.push(`return_type: ${entity.returnType}`);
                    if (entity.parentClass) observations.push(`parent_class: ${entity.parentClass}`);
                    if (entity.implementedInterfaces && entity.implementedInterfaces.length > 0) observations.push(`implements: ${entity.implementedInterfaces.join(', ')}`);


                    entitiesToCreateKG.push({
                        name: entity.fullName, // Use the pre-calculated fullName from ExtractedCodeEntity
                        entityType: entity.type,
                        observations: observations,
                    });

                    // Relation: Entity defined_in_file FileNode
                    relationsToCreateKG.push({
                        from: entity.fullName,
                        to: fileNodeRelativeName, // Relative path of the file
                        relationType: 'defined_in_file'
                    });

                    // Relation: Class has_method MethodNode
                    if (entity.type === 'method' && entity.className) {
                        const classFullName = `${entity.filePath}::${entity.className}`; // Construct class full name
                        relationsToCreateKG.push({
                            from: classFullName,
                            to: entity.fullName,
                            relationType: 'has_method'
                        });
                    }
                }

                if (entitiesToCreateKG.length > 0) {
                   const creationResult = await memoryManager.knowledgeGraphManager.createEntities(agent_id, entitiesToCreateKG);
                   entitiesCreatedCount += creationResult.details.filter((d:any) => d.success).length;
                }
                if (relationsToCreateKG.length > 0) {
                    const relationResult = await memoryManager.knowledgeGraphManager.createRelations(agent_id, relationsToCreateKG);
                    relationsCreatedCount += relationResult.details.filter((d:any) => d.success).length;
                }

                return {
                    content: [{
                        type: 'text', text: formatSimpleMessage(
                            `Code entity ingestion for file "${file_path}" complete.\n- Entities Created/Updated: ${entitiesCreatedCount}\n- Relations Created: ${relationsCreatedCount}`,
                            "Code Entity Ingestion Report"
                        )
                    }]
                };

            } catch (error: any) {
                console.error(`Error during code entity ingestion for agent ${agent_id}, file ${file_path}:`, error);
                throw new McpError(ErrorCode.InternalError, `Code entity ingestion failed for ${file_path}: ${error.message}`);
            }
        },
        // ... (rest of the knowledge_graph_memory, kg_nl_query, kg_infer_relations, kg_visualize handlers as before) ...
        'knowledge_graph_memory': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
            if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for knowledge_graph_memory operations.");
            }
            const operation = args.operation as string;
            let kgResult: any;
            let title = `Knowledge Graph Operation: ${operation} for Agent: ${agent_id}`;
            let resultData: any;

            try {
                switch (operation) {
                    case 'create_entities':
                        if (!args.entities || !Array.isArray(args.entities) || args.entities.length === 0) throw new McpError(ErrorCode.InvalidParams, "Missing or empty 'entities' array for 'create_entities' operation.");
                        args.entities.forEach((entity: any) => {
                            if (!entity.name || !entity.entityType) throw new McpError(ErrorCode.InvalidParams, "Each entity must have a 'name' and 'entityType'.");
                        });
                        resultData = await memoryManager.knowledgeGraphManager.createEntities(agent_id, args.entities);
                        break;
                    case 'create_relations':
                        if (!args.relations || !Array.isArray(args.relations) || args.relations.length === 0) throw new McpError(ErrorCode.InvalidParams, "Missing or empty 'relations' array for 'create_relations' operation.");
                         args.relations.forEach((relation: any) => {
                            if (!relation.from || !relation.to || !relation.relationType) throw new McpError(ErrorCode.InvalidParams, "Each relation must have 'from', 'to', and 'relationType'.");
                        });
                        resultData = await memoryManager.knowledgeGraphManager.createRelations(agent_id, args.relations);
                        break;
                    case 'add_observations':
                        if (!args.observations || !Array.isArray(args.observations) || args.observations.length === 0) throw new McpError(ErrorCode.InvalidParams, "Missing or empty 'observations' array for 'add_observations' operation.");
                        resultData = await memoryManager.knowledgeGraphManager.addObservations(agent_id, args.observations);
                        break;
                    case 'delete_entities':
                        if (!args.entityNames || !Array.isArray(args.entityNames) || args.entityNames.length === 0) throw new McpError(ErrorCode.InvalidParams, "Missing or empty 'entityNames' array for 'delete_entities' operation.");
                        resultData = await memoryManager.knowledgeGraphManager.deleteEntities(agent_id, args.entityNames);
                        break;
                    case 'delete_observations':
                        if (!args.deletions || !Array.isArray(args.deletions) || args.deletions.length === 0) throw new McpError(ErrorCode.InvalidParams, "Missing or empty 'deletions' array for 'delete_observations' operation.");
                        resultData = await memoryManager.knowledgeGraphManager.deleteObservations(agent_id, args.deletions);
                        break;
                    case 'delete_relations':
                        if (!args.relations || !Array.isArray(args.relations) || args.relations.length === 0) throw new McpError(ErrorCode.InvalidParams, "Missing or empty 'relations' array for 'delete_relations' operation.");
                        resultData = await memoryManager.knowledgeGraphManager.deleteRelations(agent_id, args.relations);
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

                if (resultData && typeof resultData.message === 'string' && Array.isArray(resultData.details)) {
                     kgResult = `## ${title}\n\n**Status:** ${resultData.message}\n\n**Details:**\n${formatJsonToMarkdownCodeBlock(resultData.details)}\n`;
                } else if (operation === 'read_graph' || operation === 'search_nodes' || operation === 'open_nodes') {
                     kgResult = `## ${title}\n\n${formatJsonToMarkdownCodeBlock(resultData)}\n`;
                     if ((Array.isArray(resultData) && resultData.length === 0) || (typeof resultData === 'object' && !Array.isArray(resultData) && Object.keys(resultData).length === 0) || (typeof resultData === 'object' && resultData.nodes && resultData.nodes.length === 0 && resultData.relations && resultData.relations.length === 0) ){
                        kgResult = `## ${title}\n\n*No results found or graph is empty.*\n`;
                     }
                } else { 
                    kgResult = `## ${title}\n\nOperation completed. Result:\n${formatJsonToMarkdownCodeBlock(resultData)}\n`;
                }

            } catch (error: any) {
                 console.error(`Error in knowledge_graph_memory tool (operation: ${operation}, agent: ${agent_id}):`, error);
                 if (error instanceof McpError) throw error;
                 throw new McpError(ErrorCode.InternalError, `Knowledge graph operation '${operation}' failed: ${error.message}`);
            }
            return { content: [{ type: 'text', text: kgResult }] };
        },
        'kg_nl_query': async (args: any, agent_id_from_server: string) => {
            const agent_id = args.agent_id || agent_id_from_server;
             if (!agent_id) {
                throw new McpError(ErrorCode.InvalidParams, "agent_id is required for kg_nl_query.");
            }
            try {
                const resultJson = await memoryManager.knowledgeGraphManager.queryNaturalLanguage(agent_id, args.query);
                const result = JSON.parse(resultJson);
                
                let md = `## Natural Language Query Result for Agent: \`${agent_id}\`\n\n`;
                md += `**Query:** "${args.query}"\n\n`;
                
                // Check if it's an error response
                if (result.error) {
                    md += `### ⚠️ Query Translation Error\n\n`;
                    md += `**Error:** ${result.error}\n`;
                    md += `**Suggestion:** ${result.suggestion}\n`;
                } else if (result.metadata) {
                    // Display metadata about the query translation
                    md += `### Query Translation\n\n`;
                    md += `**Operation:** \`${result.metadata.translatedOperation}\`\n`;
                    md += `**Arguments:** ${formatJsonToMarkdownCodeBlock(result.metadata.translatedArgs)}\n`;
                    
                    if (result.metadata.assumptions) {
                        md += `**Assumptions:** ${result.metadata.assumptions}\n\n`;
                    }
                    
                    md += `### Results\n\n`;
                    if (result.results) {
                        if (Array.isArray(result.results) && result.results.length === 0) {
                            md += `*No results found.*\n`;
                        } else if (typeof result.results === 'object' && result.results.nodes && result.results.nodes.length === 0) {
                            md += `*No nodes found matching the query.*\n`;
                        } else {
                            md += formatJsonToMarkdownCodeBlock(result.results);
                        }
                    }
                } else {
                    // Fallback for old format
                    md += `**Response:**\n${formatJsonToMarkdownCodeBlock(result)}\n`;
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
                if(args.entity_names) md += `**Focused Entities:** ${args.entity_names.join(', ')}\n`;
                if(args.context) md += `**Additional Context:** ${args.context}\n`;
                md += `\n**Status:** ${result.message}\n\n`;
                
                if(result.details && result.details.length > 0){
                    md += `### Proposed Relations:\n\n`;
                    md += `| From | To | Relation Type | Confidence | Evidence | Status |\n`;
                    md += `|------|-----|---------------|------------|----------|--------|\n`;
                    
                    for (const rel of result.details) {
                        const confidence = rel.confidence ? `${(rel.confidence * 100).toFixed(0)}%` : 'N/A';
                        const evidence = rel.evidence || 'No evidence provided';
                        const status = rel.status || 'proposed';
                        const statusEmoji = status === 'added' ? '✅' : status === 'failed' ? '❌' : '🔍';
                        
                        md += `| \`${rel.from}\` | \`${rel.to}\` | ${rel.relationType} | ${confidence} | ${evidence} | ${statusEmoji} ${status} |\n`;
                    }
                    
                    md += `\n### Legend:\n`;
                    md += `- ✅ **added**: High-confidence relation automatically added to the graph\n`;
                    md += `- 🔍 **proposed**: Low-confidence relation requiring manual review\n`;
                    md += `- ❌ **failed**: Relation could not be added (e.g., entity not found)\n`;
                    
                    md += `\n### Code-Specific Relation Types:\n`;
                    md += `- **calls_function**: Function/method calls another function\n`;
                    md += `- **uses_class**: Function uses or instantiates a class\n`;
                    md += `- **modifies_variable**: Function modifies a variable\n`;
                    md += `- **implements_interface**: Class implements an interface\n`;
                    md += `- **extends_class**: Class inheritance relationship\n`;
                    md += `- **related_to_feature**: Entities part of same feature/module\n`;
                    md += `- **tested_by**: Test relationship\n`;
                    md += `- **depends_on**: General dependency\n`;
                    md += `- **configures**: Configuration relationship\n`;
                } else {
                    md += `*No new relations were inferred.*\n`;
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
                const visualizationOptions = {
                    query: args.query,
                    layoutDirection: args.layout_direction || 'TD',
                    depth: args.depth || 2,
                    includeLegend: args.include_legend !== false,
                    groupByDirectory: args.group_by_directory || false
                };
                
                const mermaidGraph = await memoryManager.knowledgeGraphManager.generateMermaidGraph(
                    agent_id, 
                    visualizationOptions
                );
                
                let md = `## Knowledge Graph Visualization for Agent: \`${agent_id}\`\n`;
                if(args.query) md += `**Query:** "${args.query}"\n`;
                if(args.layout_direction && args.layout_direction !== 'TD') md += `**Layout:** ${args.layout_direction}\n`;
                if(args.group_by_directory) md += `**Grouping:** By directory\n`;
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
