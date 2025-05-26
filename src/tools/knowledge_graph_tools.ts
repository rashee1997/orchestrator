import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export const knowledgeGraphToolDefinitions = [
    {
        name: 'knowledge_graph_memory',
        description: `A tool for interacting with the knowledge graph memory. Supported operations: 
- "create_entities": Adds new entities (nodes) to the graph. Requires 'entities' array in arguments.
- "create_relations": Adds new relationships between existing entities. Requires 'relations' array in arguments.
- "add_observations": Adds observations to existing entities. Requires 'observations' array in arguments.
- "delete_entities": Removes entities and their associated relations. Requires 'entityNames' array in arguments.
- "delete_observations": Removes specific observations from entities. Requires 'deletions' array in arguments.
- "delete_relations": Removes specific relations between entities. Requires 'relations' array in arguments.
- "read_graph": Retrieves the entire knowledge graph for the agent.
- "search_nodes": Searches for nodes based on a query string (name, type, or observations). Requires 'query' in arguments.
- "open_nodes": Retrieves specific nodes by their names. Requires 'names' array in arguments.`,
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
                // Arguments for specific operations (optional depending on the operation)
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
            // Note: Specific argument requirements depend on the 'operation' value.
            // This could be further refined with 'if/then/else' or 'oneOf' in JSON schema if needed,
            // but for now, the description clarifies the conditional requirements.
        },
    },
];

export function getKnowledgeGraphToolHandlers(memoryManager: MemoryManager) {
    return {
        'knowledge_graph_memory': async (args: any, agent_id: string) => {
            const operation = args.operation as string;
            // 'key' and 'value' are not directly used by the KG manager methods in this way.
            // The specific arguments like 'entities', 'relations', 'query' are used.

            let kgResult;
            switch (operation) {
                case 'create_entities':
                    if (!args.entities) throw new McpError(ErrorCode.InvalidParams, "Missing 'entities' argument for 'create_entities' operation.");
                    kgResult = await memoryManager.knowledgeGraphManager.createEntities(agent_id, args.entities as Array<{ name: string; entityType: string; observations: string[] }>);
                    break;
                case 'create_relations':
                    if (!args.relations) throw new McpError(ErrorCode.InvalidParams, "Missing 'relations' argument for 'create_relations' operation.");
                    kgResult = await memoryManager.knowledgeGraphManager.createRelations(agent_id, args.relations as Array<{ from: string; to: string; relationType: string }>);
                    break;
                case 'add_observations':
                    if (!args.observations) throw new McpError(ErrorCode.InvalidParams, "Missing 'observations' argument for 'add_observations' operation.");
                    kgResult = await memoryManager.knowledgeGraphManager.addObservations(agent_id, args.observations as Array<{ entityName: string; contents: string[] }>);
                    break;
                case 'delete_entities':
                    if (!args.entityNames) throw new McpError(ErrorCode.InvalidParams, "Missing 'entityNames' argument for 'delete_entities' operation.");
                    kgResult = await memoryManager.knowledgeGraphManager.deleteEntities(agent_id, args.entityNames as string[]);
                    break;
                case 'delete_observations':
                    if (!args.deletions) throw new McpError(ErrorCode.InvalidParams, "Missing 'deletions' argument for 'delete_observations' operation.");
                    kgResult = await memoryManager.knowledgeGraphManager.deleteObservations(agent_id, args.deletions as Array<{ entityName: string; observations: string[] }>);
                    break;
                case 'delete_relations':
                    if (!args.relations) throw new McpError(ErrorCode.InvalidParams, "Missing 'relations' argument for 'delete_relations' operation.");
                    kgResult = await memoryManager.knowledgeGraphManager.deleteRelations(agent_id, args.relations as Array<{ from: string; to: string; relationType: string }>);
                    break;
                case 'read_graph':
                    kgResult = await memoryManager.knowledgeGraphManager.readGraph(agent_id);
                    break;
                case 'search_nodes':
                    if (!args.query) throw new McpError(ErrorCode.InvalidParams, "Missing 'query' argument for 'search_nodes' operation.");
                    kgResult = await memoryManager.knowledgeGraphManager.searchNodes(agent_id, args.query as string);
                    break;
                case 'open_nodes':
                    if (!args.names) throw new McpError(ErrorCode.InvalidParams, "Missing 'names' argument for 'open_nodes' operation.");
                    kgResult = await memoryManager.knowledgeGraphManager.openNodes(agent_id, args.names as string[]);
                    break;
                default:
                    throw new McpError(
                        ErrorCode.MethodNotFound, // Changed from InvalidParams for better semantics
                        `Unknown knowledge_graph_memory operation: ${operation}. Supported operations are: create_entities, create_relations, add_observations, delete_entities, delete_observations, delete_relations, read_graph, search_nodes, open_nodes.`
                    );
            }
            return { content: [{ type: 'text', text: JSON.stringify(kgResult, null, 2) }] };
        },
    };
}
