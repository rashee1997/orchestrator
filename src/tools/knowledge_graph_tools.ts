import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export const knowledgeGraphToolDefinitions = [
    {
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
];

export function getKnowledgeGraphToolHandlers(memoryManager: MemoryManager) {
    return {
        'knowledge_graph_memory': async (args: any, agent_id: string) => {
            const operation = args.operation as string;
            const key = args.key as string;
            const value = args.value; // Can be any type, including null for 'delete'

            let kgResult;
            switch (operation) {
                case 'create_entities':
                    kgResult = await memoryManager.createEntities(agent_id, args.entities as Array<{ name: string; entityType: string; observations: string[] }>);
                    break;
                case 'create_relations':
                    kgResult = await memoryManager.createRelations(agent_id, args.relations as Array<{ from: string; to: string; relationType: string }>);
                    break;
                case 'add_observations':
                    kgResult = await memoryManager.addObservations(agent_id, args.observations as Array<{ entityName: string; contents: string[] }>);
                    break;
                case 'delete_entities':
                    kgResult = await memoryManager.deleteEntities(agent_id, args.entityNames as string[]);
                    break;
                case 'delete_observations':
                    kgResult = await memoryManager.deleteObservations(agent_id, args.deletions as Array<{ entityName: string; observations: string[] }>);
                    break;
                case 'delete_relations':
                    kgResult = await memoryManager.deleteRelations(agent_id, args.relations as Array<{ from: string; to: string; relationType: string }>);
                    break;
                case 'read_graph':
                    kgResult = await memoryManager.readGraph(agent_id);
                    break;
                case 'search_nodes':
                    kgResult = await memoryManager.searchNodes(agent_id, args.query as string);
                    break;
                case 'open_nodes':
                    kgResult = await memoryManager.openNodes(agent_id, args.names as string[]);
                    break;
                default:
                    throw new McpError(
                        ErrorCode.InvalidParams,
                        `Unknown knowledge_graph_memory operation: ${operation}`
                    );
            }
            return { content: [{ type: 'text', text: JSON.stringify(kgResult, null, 2) }] };
        },
    };
}
