import { randomUUID } from 'crypto';
import { DatabaseService } from '../services/DatabaseService.js';
import { GeminiIntegrationService } from '../services/GeminiIntegrationService.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
// fs, fsp, and path are not used in this manager based on current code, can be removed if not planned for future use.
// import fs from 'fs';
// import fsp from 'fs/promises';
// import path from 'path';

// const KNOWLEDGE_GRAPH_FILE_PATH = path.join(process.cwd(), 'knowledge_graph.jsonl'); // Not used

interface KnowledgeGraph { // This interface is not used locally in this manager after removing load/save
    entities: any[];
    relations: any[];
}

export class KnowledgeGraphManager {
    private dbService: DatabaseService;
    private geminiService: GeminiIntegrationService;

    constructor(dbService: DatabaseService, geminiService: GeminiIntegrationService) {
        this.dbService = dbService;
        this.geminiService = geminiService;
    }

    // private async loadKnowledgeGraph(): Promise<KnowledgeGraph> { // Not used
    //     // ... (original code)
    // }

    // private async saveKnowledgeGraph(graph: KnowledgeGraph) { // Not used
    //     // ... (original code)
    // }

    async createEntities(
        agent_id: string,
        entities: Array<{ name: string; entityType: string; observations: string[] }>
    ) {
        const db = this.dbService.getDb();
        const results = [];
        let stmt; // Define stmt outside try to be available in finally

        try {
            await db.run('BEGIN TRANSACTION');
            stmt = await db.prepare(
                `INSERT INTO knowledge_graph_nodes (node_id, agent_id, name, entity_type, observations, timestamp)
                 VALUES (?, ?, ?, ?, ?, ?)`
            );
            for (const entity of entities) {
                const node_id = randomUUID();
                const timestamp = Date.now();
                const observations_json = JSON.stringify(entity.observations);
                await stmt.run(node_id, agent_id, entity.name, entity.entityType, observations_json, timestamp);
                results.push({ node_id, name: entity.name, success: true }); // Add success flag
            }
            await db.run('COMMIT');
            return { message: `Created ${results.filter(r => r.success).length} entities successfully.`, details: results };
        } catch (error) {
            await db.run('ROLLBACK');
            console.error('Error creating entities, transaction rolled back:', error);
            // For now, we report a general failure for the batch.
            throw new Error(`Failed to create entities batch due to: ${(error as Error).message}. Transaction rolled back.`);
        } finally {
            if (stmt) {
                await stmt.finalize();
            }
        }
    }

    async createRelations(
        agent_id: string,
        relations: Array<{ from: string; to: string; relationType: string }>
    ) {
        const db = this.dbService.getDb();
        const results = [];
        let stmt; // Define stmt outside try to be available in finally

        try {
            await db.run('BEGIN TRANSACTION');
            stmt = await db.prepare(
                `INSERT INTO knowledge_graph_relations (relation_id, agent_id, from_node_id, to_node_id, relation_type, timestamp)
                 VALUES (?, ?, ?, ?, ?, ?)`
            );

            for (const relation of relations) {
                const relation_id = randomUUID();
                const timestamp = Date.now();

                // Get node_ids for 'from' and 'to' entities
                // These lookups should ideally happen before the loop or be optimized if performance is critical for large batches.
                // For atomicity, if any node lookup fails, the transaction will ensure no relations are created.
                const fromNode = await db.get(`SELECT node_id FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, relation.from);
                const toNode = await db.get(`SELECT node_id FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, relation.to);

                if (!fromNode) {
                    // If a node is not found, we must throw an error to trigger rollback for the entire batch.
                    throw new Error(`Entity '${relation.from}' not found. Cannot create relation.`);
                }
                if (!toNode) {
                    // If a node is not found, we must throw an error to trigger rollback for the entire batch.
                    throw new Error(`Entity '${relation.to}' not found. Cannot create relation.`);
                }

                await stmt.run(relation_id, agent_id, fromNode.node_id, toNode.node_id, relation.relationType, timestamp);
                results.push({ success: true, relation_id, from: relation.from, to: relation.to, type: relation.relationType });
            }
            await db.run('COMMIT');
            return { message: `Created ${results.filter(r => r.success).length} relations successfully.`, details: results };
        } catch (error) {
            await db.run('ROLLBACK');
            console.error('Error creating relations, transaction rolled back:', error);
            // If an error occurs (e.g., entity not found), the entire batch is rolled back.
            throw new Error(`Failed to create relations batch due to: ${(error as Error).message}. Transaction rolled back.`);
        } finally {
            if (stmt) {
                await stmt.finalize();
            }
        }
    }

    async addObservations(
        agent_id: string,
        observations: Array<{ entityName: string; contents: string[] }>
    ) {
        const db = this.dbService.getDb();
        const results = [];
        // This operation updates existing records one by one.
        // If atomicity for the whole batch is required, a transaction wrapper would be needed here too.
        // For now, sticking to original behavior of per-item success/failure.
        for (const obs of observations) {
            const node = await db.get(`SELECT node_id, observations FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, obs.entityName);
            if (!node) {
                results.push({ success: false, message: `Entity '${obs.entityName}' not found.` });
                continue;
            }

            let existingObservations = [];
            try {
                existingObservations = JSON.parse(node.observations || '[]');
            } catch (e) {
                console.error(`Failed to parse existing observations for entity ${obs.entityName}:`, e);
                // Decide on behavior: skip, error out, or use empty array. Using empty for now.
            }
            
            existingObservations = [...existingObservations, ...obs.contents];

            try {
                await db.run(
                    `UPDATE knowledge_graph_nodes SET observations = ? WHERE node_id = ?`,
                    JSON.stringify(existingObservations), node.node_id
                );
                results.push({ success: true, entityName: obs.entityName, addedCount: obs.contents.length });
            } catch (updateError) {
                console.error(`Failed to update observations for entity ${obs.entityName}:`, updateError);
                results.push({ success: false, message: `Failed to update observations for entity '${obs.entityName}'.`, error: (updateError as Error).message });
            }
        }
        return { message: `Processed adding observations for ${observations.length} entities.`, details: results };
    }

    async deleteEntities(
        agent_id: string,
        entityNames: string[]
    ) {
        const db = this.dbService.getDb();
        const results = [];
        // This operation deletes entities one by one.
        // If atomicity for the whole batch is required, a transaction wrapper would be needed.
        // Note: Foreign key constraints should handle deleting associated relations if schema is set up with ON DELETE CASCADE.
        for (const name of entityNames) {
            const node = await db.get(`SELECT node_id FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, name);
            if (!node) {
                results.push({ success: false, message: `Entity '${name}' not found.` });
                continue;
            }
            
            try {
                 // Assuming ON DELETE CASCADE for knowledge_graph_relations is set in schema.sql
                const deleteResult = await db.run(`DELETE FROM knowledge_graph_nodes WHERE node_id = ? AND agent_id = ?`, node.node_id, agent_id);
                results.push({ success: (deleteResult?.changes || 0) > 0, entityName: name, deleted: (deleteResult?.changes || 0) > 0 });
            } catch (deleteError) {
                console.error(`Failed to delete entity ${name}:`, deleteError);
                results.push({ success: false, message: `Failed to delete entity '${name}'.`, error: (deleteError as Error).message });
            }
        }
        return { message: `Processed deleting ${entityNames.length} entities.`, details: results };
    }

    async deleteObservations(
        agent_id: string,
        deletions: Array<{ entityName: string; observations: string[] }>
    ) {
        const db = this.dbService.getDb();
        const results = [];
        for (const del of deletions) {
            const node = await db.get(`SELECT node_id, observations FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, del.entityName);
            if (!node) {
                results.push({ success: false, message: `Entity '${del.entityName}' not found.` });
                continue;
            }

            let existingObservations = [];
            try {
                existingObservations = JSON.parse(node.observations || '[]');
            } catch(e) {
                 console.error(`Failed to parse existing observations for entity ${del.entityName} during deletion:`, e);
                 results.push({ success: false, message: `Could not parse observations for entity '${del.entityName}'.`, error: (e as Error).message });
                 continue;
            }

            const initialCount = existingObservations.length;
            existingObservations = existingObservations.filter((obs: string) => !del.observations.includes(obs));
            const deletedCount = initialCount - existingObservations.length;

            try {
                await db.run(
                    `UPDATE knowledge_graph_nodes SET observations = ? WHERE node_id = ?`,
                    JSON.stringify(existingObservations), node.node_id
                );
                results.push({ success: true, entityName: del.entityName, deletedCount: deletedCount });
            } catch (updateError) {
                 console.error(`Failed to update (delete) observations for entity ${del.entityName}:`, updateError);
                results.push({ success: false, message: `Failed to update observations for entity '${del.entityName}'.`, error: (updateError as Error).message });
            }
        }
        return { message: `Processed deleting observations for ${deletions.length} entities.`, details: results };
    }

    async deleteRelations(
        agent_id: string,
        relations: Array<{ from: string; to: string; relationType: string }>
    ) {
        const db = this.dbService.getDb();
        const results = [];
        // This operation deletes relations one by one.
        // If atomicity for the whole batch is required, a transaction wrapper would be needed.
        for (const relation of relations) {
            const fromNode = await db.get(`SELECT node_id FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, relation.from);
            const toNode = await db.get(`SELECT node_id FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, relation.to);

            if (!fromNode || !toNode) {
                results.push({ success: false, message: `One or both entities for relation (FROM: ${relation.from}, TO: ${relation.to}, TYPE: ${relation.relationType}) not found.` });
                continue;
            }
            
            try {
                const deleteResult = await db.run(
                    `DELETE FROM knowledge_graph_relations WHERE agent_id = ? AND from_node_id = ? AND to_node_id = ? AND relation_type = ?`,
                    agent_id, fromNode.node_id, toNode.node_id, relation.relationType
                );
                results.push({ success: (deleteResult?.changes || 0) > 0, from: relation.from, to: relation.to, type: relation.relationType, deleted: (deleteResult?.changes || 0) > 0 });
            } catch (deleteError) {
                 console.error(`Failed to delete relation (FROM: ${relation.from}, TO: ${relation.to}, TYPE: ${relation.relationType}):`, deleteError);
                results.push({ success: false, message: `Failed to delete relation (FROM: ${relation.from}, TO: ${relation.to}, TYPE: ${relation.relationType}).`, error: (deleteError as Error).message });
            }
        }
        return { message: `Processed deleting ${relations.length} relations.`, details: results };
    }

    async readGraph(agent_id: string) {
        const db = this.dbService.getDb();
        const nodes = await db.all(`SELECT node_id, name, entity_type, observations FROM knowledge_graph_nodes WHERE agent_id = ?`, agent_id);
        const relations = await db.all(`SELECT r.relation_id, r.relation_type, n1.name AS from_name, n2.name AS to_name FROM knowledge_graph_relations r JOIN knowledge_graph_nodes n1 ON r.from_node_id = n1.node_id JOIN knowledge_graph_nodes n2 ON r.to_node_id = n2.node_id WHERE r.agent_id = ?`, agent_id);

        return {
            nodes: nodes.map((node: any) => {
                let observations = [];
                try {
                    observations = JSON.parse(node.observations || '[]');
                } catch (e) {
                    console.error(`Failed to parse observations for node ${node.node_id} during readGraph:`, e);
                }
                return {
                    node_id: node.node_id,
                    name: node.name,
                    entityType: node.entity_type,
                    observations: observations
                };
            }),
            relations: relations.map((rel: any) => ({
                relation_id: rel.relation_id,
                from: rel.from_name,
                to: rel.to_name,
                relationType: rel.relation_type
            }))
        };
    }

    async searchNodes(agent_id: string, query: string) {
        const db = this.dbService.getDb();
        const searchQuery = `%${query.toLowerCase()}%`;
        const nodes = await db.all(
            `SELECT node_id, name, entity_type, observations FROM knowledge_graph_nodes
             WHERE agent_id = ? AND (LOWER(name) LIKE ? OR LOWER(entity_type) LIKE ? OR LOWER(observations) LIKE ?)`,
            agent_id, searchQuery, searchQuery, searchQuery
        );
        return nodes.map((node: any) => {
            let observations = [];
            try {
                observations = JSON.parse(node.observations || '[]');
            } catch (e) {
                console.error(`Failed to parse observations for node ${node.node_id} during searchNodes:`, e);
            }
            return {
                node_id: node.node_id,
                name: node.name,
                entityType: node.entity_type,
                observations: observations
            };
        });
    }

    async openNodes(agent_id: string, names: string[]) {
        const db = this.dbService.getDb();
        if (!names || names.length === 0) {
            return []; // Return empty if no names provided
        }
        const placeholders = names.map(() => '?').join(',');
        const nodes = await db.all(
            `SELECT node_id, name, entity_type, observations FROM knowledge_graph_nodes
             WHERE agent_id = ? AND name IN (${placeholders})`,
            agent_id, ...names
        );
        return nodes.map((node: any) => {
            let observations = [];
            try {
                observations = JSON.parse(node.observations || '[]');
            } catch (e) {
                console.error(`Failed to parse observations for node ${node.node_id} during openNodes:`, e);
            }
            return {
                node_id: node.node_id,
                name: node.name,
                entityType: node.entity_type,
                observations: observations
            };
        });
    }

    async queryNaturalLanguage(agent_id: string, naturalLanguageQuery: string): Promise<string> {
        try {
            // Step 1: Get the current knowledge graph for context
            const currentGraph = await this.readGraph(agent_id);
            const graphRepresentation = JSON.stringify(currentGraph, null, 2);

            // Step 2: Use Gemini to translate the natural language query into a structured query
            const prompt = `Given the following knowledge graph structure and a natural language query, translate the natural language query into a structured query that can be executed against this graph. The structured query should be a JSON object with 'operation' and 'args' properties, mirroring the 'knowledge_graph_memory' tool's input schema.

Knowledge Graph Structure:
${graphRepresentation}

Natural Language Query: "${naturalLanguageQuery}"

If the query implies traversing the graph, use the 'graph_traversal' operation with 'start_node' (the name of the starting entity), 'relation_types' (an array of relation types to follow), and 'traversal_depth' (a number indicating how many levels deep to traverse).

Provide only the JSON object for the structured query.`;

            const geminiResponseObject = await this.geminiService.askGemini(prompt, 'gemini-1.5-flash-latest');
            const geminiResponse = geminiResponseObject.content[0].text;
            
            let structuredQuery;
            try {
                const cleanedResponse = geminiResponse.replace(/```json\n|```/g, '').trim();
                structuredQuery = JSON.parse(cleanedResponse);
            } catch (parseError) {
                throw new McpError(ErrorCode.InternalError, `Failed to parse Gemini's structured query response: ${(parseError as Error).message}. Response: ${geminiResponse}`);
            }

            // Step 3: Execute the structured query using the existing knowledge_graph_memory logic
            // This part would ideally call the internal logic of knowledge_graph_memory handler
            // For now, we'll simulate by directly calling the manager's methods based on the parsed structuredQuery
            const operation = structuredQuery.operation;
            const args = structuredQuery.args;

            if (!operation) {
                throw new McpError(ErrorCode.InvalidParams, "Gemini did not provide a valid 'operation' in the structured query.");
            }

            let resultData: any;
            switch (operation) {
                case 'read_graph':
                    resultData = await this.readGraph(agent_id);
                    break;
                case 'search_nodes':
                    if (!args || !args.query) throw new McpError(ErrorCode.InvalidParams, "Missing 'query' argument in structured query for 'search_nodes'.");
                    resultData = await this.searchNodes(agent_id, args.query);
                    break;
                case 'open_nodes':
                    if (!args || !args.names) throw new McpError(ErrorCode.InvalidParams, "Missing 'names' argument in structured query for 'open_nodes'.");
                    resultData = await this.openNodes(agent_id, args.names);
                    break;
                case 'graph_traversal':
                    if (!args || !args.start_node || !args.relation_types || typeof args.traversal_depth === 'undefined') {
                        throw new McpError(ErrorCode.InvalidParams, "Missing required arguments for 'graph_traversal'.");
                    }
                    resultData = await this.traverseGraph(agent_id, args.start_node, args.relation_types, args.traversal_depth);
                    break;
                default:
                    throw new McpError(ErrorCode.MethodNotFound, `Unsupported operation inferred by Gemini: ${operation}`);
            }

            return JSON.stringify(resultData, null, 2);

        } catch (error: any) {
            console.error(`Error in queryNaturalLanguage:`, error);
            if (error instanceof McpError) throw error;
            throw new McpError(ErrorCode.InternalError, `Failed to process natural language query: ${error.message}`);
        }
    }

    async inferRelations(agent_id: string, entityNames?: string[], context?: string): Promise<{ message: string; details: any[] }> {
        try {
            let relevantGraphData: any;
            if (entityNames && entityNames.length > 0) {
                relevantGraphData = await this.openNodes(agent_id, entityNames);
            } else {
                relevantGraphData = await this.readGraph(agent_id);
            }

            const graphRepresentation = JSON.stringify(relevantGraphData, null, 2);

            const prompt = `Given the following knowledge graph data and additional context, identify and propose new relationships between existing entities. Focus on relationships that are not explicitly stated but can be logically inferred.

Knowledge Graph Data:
${graphRepresentation}

Additional Context:
${context || 'No additional context provided.'}

Propose new relationships as a JSON array of objects, where each object has 'from', 'to', and 'relationType' properties. Only include relationships that are highly probable and not already present. If no new relations can be inferred, return an empty array.

Example:
[
  { "from": "EntityA", "to": "EntityB", "relationType": "is_related_to" }
]`;

            const geminiResponseObject = await this.geminiService.askGemini(prompt, 'gemini-1.5-flash-latest');
            const geminiResponse = geminiResponseObject.content[0].text;
            
            let inferredRelations: Array<{ from: string; to: string; relationType: string }>;
            try {
                const cleanedResponse = geminiResponse.replace(/```json\n|```/g, '').trim();
                inferredRelations = JSON.parse(cleanedResponse);
                if (!Array.isArray(inferredRelations)) {
                    throw new Error("Gemini response is not a JSON array.");
                }
            } catch (parseError) {
                throw new McpError(ErrorCode.InternalError, `Failed to parse Gemini's inferred relations response: ${(parseError as Error).message}. Response: ${geminiResponse}`);
            }

            // Filter out relations that already exist to avoid duplicates
            const existingRelations = (await this.readGraph(agent_id)).relations;
            const newRelationsToAdd = inferredRelations.filter(newRel => 
                !existingRelations.some(existingRel => 
                    existingRel.from === newRel.from && 
                    existingRel.to === newRel.to && 
                    existingRel.relationType === newRel.relationType
                )
            );

            if (newRelationsToAdd.length > 0) {
                const creationResult = await this.createRelations(agent_id, newRelationsToAdd);
                return { message: `Inferred and added ${creationResult.details.length} new relations.`, details: creationResult.details };
            } else {
                return { message: "No new relations inferred or all inferred relations already exist.", details: [] };
            }

        } catch (error: any) {
            console.error(`Error in inferRelations:`, error);
            if (error instanceof McpError) throw error;
            throw new McpError(ErrorCode.InternalError, `Failed to infer relations: ${error.message}`);
        }
    }

    async traverseGraph(agent_id: string, startNodeName: string, relationTypes: string[], depth: number): Promise<any> {
        const db = this.dbService.getDb();
        const visitedNodes = new Set<string>();
        const resultNodes: any[] = [];
        const resultRelations: any[] = [];
        const queue: { nodeId: string; currentDepth: number }[] = [];

        const startNode = await db.get(`SELECT node_id, name, entity_type, observations FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, startNodeName);

        if (!startNode) {
            throw new McpError(ErrorCode.InternalError, `Start node '${startNodeName}' not found.`);
        }

        queue.push({ nodeId: startNode.node_id, currentDepth: 0 });
        visitedNodes.add(startNode.node_id);
        resultNodes.push({
            node_id: startNode.node_id,
            name: startNode.name,
            entityType: startNode.entity_type,
            observations: JSON.parse(startNode.observations || '[]')
        });

        while (queue.length > 0) {
            const { nodeId, currentDepth } = queue.shift()!;

            if (currentDepth >= depth) {
                continue;
            }

            const placeholders = relationTypes.map(() => '?').join(',');
            const outgoingRelations = await db.all(
                `SELECT r.relation_id, r.relation_type, n1.name AS from_name, n2.name AS to_name, n2.node_id AS to_node_id
                 FROM knowledge_graph_relations r 
                 JOIN knowledge_graph_nodes n1 ON r.from_node_id = n1.node_id 
                 JOIN knowledge_graph_nodes n2 ON r.to_node_id = n2.node_id 
                 WHERE r.agent_id = ? AND r.from_node_id = ? AND r.relation_type IN (${placeholders})`,
                agent_id, nodeId, ...relationTypes
            );

            for (const rel of outgoingRelations) {
                resultRelations.push({
                    relation_id: rel.relation_id,
                    from: rel.from_name,
                    to: rel.to_name,
                    relationType: rel.relation_type
                });

                if (!visitedNodes.has(rel.to_node_id)) {
                    visitedNodes.add(rel.to_node_id);
                    const targetNode = await db.get(`SELECT node_id, name, entity_type, observations FROM knowledge_graph_nodes WHERE node_id = ?`, rel.to_node_id);
                    if (targetNode) {
                        resultNodes.push({
                            node_id: targetNode.node_id,
                            name: targetNode.name,
                            entityType: targetNode.entity_type,
                            observations: JSON.parse(targetNode.observations || '[]')
                        });
                        queue.push({ nodeId: targetNode.node_id, currentDepth: currentDepth + 1 });
                    }
                }
            }
        }

        return { nodes: resultNodes, relations: resultRelations };
    }

    async generateMermaidGraph(agent_id: string, query?: string): Promise<string> {
        try {
            let nodes: any[] = [];
            let relations: any[] = [];

            if (query) {
                // If a query is provided, search for relevant nodes and their direct relations
                const queriedNodes = await this.searchNodes(agent_id, query);
                const nodeIds = queriedNodes.map(node => node.node_id);

                if (nodeIds.length === 0) {
                    return "graph TD\n    A[No nodes found for the given query.]";
                }

                nodes = queriedNodes;

                // Fetch relations involving these nodes
                const directRelations = await this.dbService.getDb().all(
                    `SELECT r.relation_id, r.relation_type, n1.name AS from_name, n2.name AS to_name 
                     FROM knowledge_graph_relations r 
                     JOIN knowledge_graph_nodes n1 ON r.from_node_id = n1.node_id 
                     JOIN knowledge_graph_nodes n2 ON r.to_node_id = n2.node_id 
                     WHERE r.agent_id = ? AND (r.from_node_id IN (${nodeIds.map(() => '?').join(',')}) OR r.to_node_id IN (${nodeIds.map(() => '?').join(',')}))`,
                    agent_id, ...nodeIds, ...nodeIds
                );
                relations = directRelations.map((rel: any) => ({
                    relation_id: rel.relation_id,
                    from: rel.from_name,
                    to: rel.to_name,
                    relationType: rel.relation_type
                }));

                // Ensure all nodes involved in these relations are included, even if not directly matched by searchNodes
                const allRelatedNodeNames = new Set<string>();
                relations.forEach(rel => {
                    allRelatedNodeNames.add(rel.from);
                    allRelatedNodeNames.add(rel.to);
                });

                const additionalNodes = await this.openNodes(agent_id, Array.from(allRelatedNodeNames).filter(name => !nodes.some(n => n.name === name)));
                nodes = [...nodes, ...additionalNodes];

            } else {
                // If no query, visualize the entire graph
                const fullGraph = await this.readGraph(agent_id);
                nodes = fullGraph.nodes;
                relations = fullGraph.relations;
            }

            if (nodes.length === 0) {
                return "graph TD\n    A[Knowledge graph is empty.]";
            }

            let mermaidGraph = "graph TD\n";

            // Add nodes
            nodes.forEach(node => {
                const nodeLabel = node.name.replace(/[^a-zA-Z0-9_]/g, '_'); // Sanitize for Mermaid ID
                mermaidGraph += `    ${nodeLabel}["${node.name} (${node.entityType})"]\n`; // Enclose label in double quotes
            });

            // Add relations
            relations.forEach(rel => {
                const fromLabel = rel.from.replace(/[^a-zA-Z0-9_]/g, '_');
                const toLabel = rel.to.replace(/[^a-zA-Z0-9_]/g, '_');
                mermaidGraph += `    ${fromLabel} -- "${rel.relationType}" --> ${toLabel}\n`;
            });

            return mermaidGraph;

        } catch (error: any) {
            console.error(`Error in generateMermaidGraph:`, error);
            if (error instanceof McpError) throw error;
            throw new McpError(ErrorCode.InternalError, `Failed to generate Mermaid graph: ${error.message}`);
        }
    }
}
