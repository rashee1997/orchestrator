import { MemoryManager } from '../../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { formatJsonToMarkdownCodeBlock } from '../../utils/formatters.js';
import { isValidEntity, haveObservationsChanged, countSuccessfulOperations } from './utils.js';

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
        createdOpCount = countSuccessfulOperations(creationRes);
    }

    if (observationsToUpdateOp.length > 0) {
        const updateRes = await memoryManager.knowledgeGraphManager.addObservations(agent_id, observationsToUpdateOp);
        updatedOpCount = countSuccessfulOperations(updateRes);
    }

    return {
        message: `Create entities operation: ${createdOpCount} created, ${updatedOpCount} updated.`,
        details: {
            created: entitiesToCreateOp,
            updated_observations_for: observationsToUpdateOp.map(o => o.entityName)
        }
    };
}

export function getMemoryHandler(memoryManager: MemoryManager) {
    return {
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
        }
    };
}