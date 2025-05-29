import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { formatSimpleMessage, formatJsonToMarkdownCodeBlock, formatObjectToMarkdown } from '../utils/formatters.js';

export const knowledgeGraphToolDefinitions = [
    {
        name: 'knowledge_graph_memory',
        description: `A tool for interacting with the knowledge graph memory. Output is Markdown formatted. Supported operations: 
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
        description: `A tool that allows agents to query the knowledge graph using natural language (e.g., "Who is the author of the 'Orchestrator' project?"), which would then be translated into structured graph queries internally (possibly using Gemini).`,
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                query: { type: 'string', description: 'The natural language query for the knowledge graph.' },
            },
            required: ['agent_id', 'query'],
        },
    },
    {
        name: 'kg_infer_relations',
        description: `A tool that uses an LLM (like Gemini) to infer new relationships between existing entities based on their observations or other stored context, and then proposes these new relations to be added to the graph.`,
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                entity_names: { 
                    type: 'array', 
                    items: { type: 'string' }, 
                    description: 'Optional: A list of entity names to focus the inference on. If not provided, inference may be broader.' 
                },
                context: { type: 'string', description: 'Optional: Additional context to aid in relation inference.' },
            },
            required: ['agent_id'],
        },
    },
    {
        name: 'kg_visualize',
        description: `A tool that generates a Mermaid diagram or other visual representation of a subset of the knowledge graph based on a query, to help agents (or users) understand complex relationships.`,
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                query: { type: 'string', description: 'Optional: A query to filter the knowledge graph for visualization (e.g., entity name, relation type).' },
                format: { type: 'string', enum: ['mermaid'], default: 'mermaid', description: 'The desired output format for the visualization.' },
            },
            required: ['agent_id'],
        },
    },
];

export function getKnowledgeGraphToolHandlers(memoryManager: MemoryManager) {
    return {
        'knowledge_graph_memory': async (args: any, agent_id: string) => {
            const operation = args.operation as string;
            let kgResult: any;
            let title = `Knowledge Graph Operation: ${operation}`;
            let resultData: any;

            try {
                switch (operation) {
                    case 'create_entities':
                        if (!args.entities) throw new McpError(ErrorCode.InvalidParams, "Missing 'entities' argument for 'create_entities' operation.");
                        resultData = await memoryManager.knowledgeGraphManager.createEntities(agent_id, args.entities as Array<{ name: string; entityType: string; observations: string[] }>);
                        break;
                    case 'create_relations':
                        if (!args.relations) throw new McpError(ErrorCode.InvalidParams, "Missing 'relations' argument for 'create_relations' operation.");
                        resultData = await memoryManager.knowledgeGraphManager.createRelations(agent_id, args.relations as Array<{ from: string; to: string; relationType: string }>);
                        break;
                    case 'add_observations':
                        if (!args.observations) throw new McpError(ErrorCode.InvalidParams, "Missing 'observations' argument for 'add_observations' operation.");
                        resultData = await memoryManager.knowledgeGraphManager.addObservations(agent_id, args.observations as Array<{ entityName: string; contents: string[] }>);
                        break;
                    case 'delete_entities':
                        if (!args.entityNames) throw new McpError(ErrorCode.InvalidParams, "Missing 'entityNames' argument for 'delete_entities' operation.");
                        resultData = await memoryManager.knowledgeGraphManager.deleteEntities(agent_id, args.entityNames as string[]);
                        break;
                    case 'delete_observations':
                        if (!args.deletions) throw new McpError(ErrorCode.InvalidParams, "Missing 'deletions' argument for 'delete_observations' operation.");
                        resultData = await memoryManager.knowledgeGraphManager.deleteObservations(agent_id, args.deletions as Array<{ entityName: string; observations: string[] }>);
                        break;
                    case 'delete_relations':
                        if (!args.relations) throw new McpError(ErrorCode.InvalidParams, "Missing 'relations' argument for 'delete_relations' operation.");
                        resultData = await memoryManager.knowledgeGraphManager.deleteRelations(agent_id, args.relations as Array<{ from: string; to: string; relationType: string }>);
                        break;
                    case 'read_graph':
                        resultData = await memoryManager.knowledgeGraphManager.readGraph(agent_id);
                        title = `Knowledge Graph for Agent: ${agent_id}`;
                        break;
                    case 'search_nodes':
                        if (!args.query) throw new McpError(ErrorCode.InvalidParams, "Missing 'query' argument for 'search_nodes' operation.");
                        resultData = await memoryManager.knowledgeGraphManager.searchNodes(agent_id, args.query as string);
                        title = `Knowledge Graph Node Search (Query: "${args.query}")`;
                        break;
                    case 'open_nodes':
                        if (!args.names) throw new McpError(ErrorCode.InvalidParams, "Missing 'names' argument for 'open_nodes' operation.");
                        resultData = await memoryManager.knowledgeGraphManager.openNodes(agent_id, args.names as string[]);
                        title = `Knowledge Graph Nodes (Names: ${args.names.join(', ')})`;
                        break;
                    default:
                        throw new McpError(
                            ErrorCode.MethodNotFound,
                            `Unknown knowledge_graph_memory operation: ${operation}.`
                        );
                }
                // For operations that return a message and details structure
                if (resultData && typeof resultData.message === 'string' && resultData.details) {
                     kgResult = `## ${title}\n\n**Status:** ${resultData.message}\n\n**Details:**\n${formatJsonToMarkdownCodeBlock(resultData.details)}\n`;
                } else { // For read_graph, search_nodes, open_nodes
                     kgResult = `## ${title}\n\n${formatJsonToMarkdownCodeBlock(resultData)}\n`;
                }

            } catch (error: any) {
                 console.error(`Error in knowledge_graph_memory tool (operation: ${operation}):`, error);
                 if (error instanceof McpError) throw error; // Re-throw McpError
                 throw new McpError(ErrorCode.InternalError, `Knowledge graph operation '${operation}' failed: ${error.message}`);
            }
            return { content: [{ type: 'text', text: kgResult }] };
        },
        'kg_nl_query': async (args: any, agent_id: string) => {
            try {
                const result = await memoryManager.knowledgeGraphManager.queryNaturalLanguage(agent_id, args.query);
                return { content: [{ type: 'text', text: `Natural Language Query Result:\n${result}` }] };
            } catch (error: any) {
                console.error(`Error in kg_nl_query tool:`, error);
                if (error instanceof McpError) throw error;
                throw new McpError(ErrorCode.InternalError, `Natural language query failed: ${error.message}`);
            }
        },
        'kg_infer_relations': async (args: any, agent_id: string) => {
            try {
                const result = await memoryManager.knowledgeGraphManager.inferRelations(agent_id, args.entity_names, args.context);
                return { content: [{ type: 'text', text: formatSimpleMessage(`Inferred Relations:\n${JSON.stringify(result, null, 2)}`) }] };
            } catch (error: any) {
                console.error(`Error in kg_infer_relations tool:`, error);
                if (error instanceof McpError) throw error;
                throw new McpError(ErrorCode.InternalError, `Relation inference failed: ${error.message}`);
            }
        },
        'kg_visualize': async (args: any, agent_id: string) => {
            try {
                const mermaidGraph = await memoryManager.knowledgeGraphManager.generateMermaidGraph(agent_id, args.query);
                return { content: [{ type: 'text', text: `Mermaid Graph Visualization:\n\`\`\`mermaid\n${mermaidGraph}\n\`\`\`` }] };
            } catch (error: any) {
                console.error(`Error in kg_visualize tool:`, error);
                if (error instanceof McpError) throw error;
                throw new McpError(ErrorCode.InternalError, `Knowledge graph visualization failed: ${error.message}`);
            }
        },
    };
}
