import { randomUUID } from 'crypto';
import { DatabaseService } from '../services/DatabaseService.js';
import { GeminiIntegrationService } from '../services/GeminiIntegrationService.js';
import { CodebaseEmbeddingService } from '../services/CodebaseEmbeddingService.js'; // Import CodebaseEmbeddingService
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { parseGeminiJsonResponse } from '../services/gemini-integration-modules/GeminiResponseParsers.js';
import { getCurrentModel } from '../services/gemini-integration-modules/GeminiConfig.js';
// fs, fsp, and path are not used in this manager based on current code, can be removed if not planned for future use.
// import fs from 'fs';
// import fsp from 'fs/promises';
import path from 'path';

// const KNOWLEDGE_GRAPH_FILE_PATH = path.join(process.cwd(), 'knowledge_graph.jsonl'); // Not used

interface KnowledgeGraph { // This interface is not used locally in this manager after removing load/save
    entities: any[];
    relations: any[];
}

export class KnowledgeGraphManager {
    private dbService: DatabaseService;
    private geminiService: GeminiIntegrationService;
    private embeddingService: CodebaseEmbeddingService; // Add embeddingService

    constructor(dbService: DatabaseService, geminiService: GeminiIntegrationService, embeddingService: CodebaseEmbeddingService) {
        this.dbService = dbService;
        this.geminiService = geminiService;
        this.embeddingService = embeddingService; // Initialize embeddingService
    }

    public async getExistingRelation(agentId: string, fromNodeName: string, toNodeName: string, relationType: string): Promise<any | null> {
        // This is a stub implementation to satisfy the interface.
        // You may implement actual logic if needed.
        return null;
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
            // Step 1: For large graphs, first try to identify relevant subgraph based on query keywords
            // Step 1: Perform semantic search to get relevant code chunks
            const similarCodeChunks = await this.embeddingService.retrieveSimilarCodeChunks(agent_id, naturalLanguageQuery);
            let semanticContext = '';
            let semanticallyRelevantNodeNames: string[] = [];

            if (similarCodeChunks && similarCodeChunks.length > 0) {
                semanticContext = `\n\nSemantically Relevant Code Chunks (from embeddings):\n`;
                similarCodeChunks.forEach((chunk: any, index: number) => {
                    semanticContext += `Chunk ${index + 1} (File: ${chunk.metadata.filePath}, Type: ${chunk.metadata.entityType || 'N/A'}):\n`;
                    semanticContext += `\`\`\`${chunk.metadata.language || ''}\n${chunk.content}\n\`\`\`\n`;
                    if (chunk.metadata.entityName) {
                        semanticallyRelevantNodeNames.push(chunk.metadata.entityName);
                    }
                });
                semanticallyRelevantNodeNames = [...new Set(semanticallyRelevantNodeNames)]; // Remove duplicates
            }

            // Step 2: Identify relevant subgraph based on query keywords and semantically relevant nodes
            let graphData: any;
            let graphRepresentation: string;
            
            const keywords = this.extractKeywordsFromQuery(naturalLanguageQuery);
            const combinedRelevantNames = [...new Set([...keywords, ...semanticallyRelevantNodeNames])];

            if (combinedRelevantNames.length > 0) {
                const relevantNodes: any[] = [];
                for (const name of combinedRelevantNames) {
                    const searchResults = await this.searchNodes(agent_id, name); // Search by name/keyword
                    relevantNodes.push(...searchResults);
                }
                
                const uniqueNodes = Array.from(new Map(relevantNodes.map(n => [n.node_id, n])).values());
                
                if (uniqueNodes.length > 0 && uniqueNodes.length < 100) {
                    const nodeIds = uniqueNodes.map(n => n.node_id);
                    const db = this.dbService.getDb();
                    const placeholders = nodeIds.map(() => '?').join(',');
                    const relations = await db.all(
                        `SELECT r.relation_id, r.relation_type, n1.name AS from_name, n2.name AS to_name 
                         FROM knowledge_graph_relations r 
                         JOIN knowledge_graph_nodes n1 ON r.from_node_id = n1.node_id 
                         JOIN knowledge_graph_nodes n2 ON r.to_node_id = n2.node_id 
                         WHERE r.agent_id = ? AND (r.from_node_id IN (${placeholders}) OR r.to_node_id IN (${placeholders}))`,
                        agent_id, ...nodeIds, ...nodeIds
                    );
                    
                    graphData = {
                        nodes: uniqueNodes,
                        relations: relations.map((rel: any) => ({
                            relation_id: rel.relation_id,
                            from: rel.from_name,
                            to: rel.to_name,
                            relationType: rel.relation_type
                        }))
                    };
                    graphRepresentation = JSON.stringify(graphData, null, 2);
                } else {
                    graphData = await this.readGraph(agent_id);
                    graphRepresentation = JSON.stringify(graphData, null, 2);
                }
            } else {
                graphData = await this.readGraph(agent_id);
                graphRepresentation = JSON.stringify(graphData, null, 2);
            }

            // Step 3: Use Gemini to translate the natural language query into a structured query
            const prompt = `You are an expert in translating natural language questions about software codebases into structured queries for a knowledge graph. The knowledge graph contains nodes representing files, directories, functions, classes, interfaces, modules, and variables. Key relation types include: 'contains_item' (directory to file/subdir), 'imports_file' (file to file), 'imports_module' (file to module), 'defined_in_file' (code entity to file), 'has_method' (class to method), 'calls_function', 'uses_class', 'modifies_variable', 'implements_interface', 'extends_class', 'related_to_feature', 'depends_on', 'tested_by', 'configures'.

Node observations often include 'absolute_path', 'language', 'signature', 'lines', and 'calls' (for functions/methods).

Given the following knowledge graph structure, semantically relevant code context, and a natural language query, translate the natural language query into a structured query JSON object. The structured query should have 'operation' and 'args' properties.

Supported operations:
- 'search_nodes': args = { "query": "search term for name, type, or observations" }
- 'open_nodes': args = { "names": ["exact_node_name1", "exact_node_name2"] }
- 'graph_traversal': args = { "start_node": "node_name", "relation_types": ["relation1", "relation2"], "traversal_depth": number }
- 'read_graph': args = {} (for general graph overview, use sparingly)

Examples of Codebase NL Queries and their Structured Translation:
1. NL: "What functions are defined in 'src/utils.ts'?"
   Translation (conceptual): Might involve finding the 'src/utils.ts' node and then traversing 'defines' relations, or searching for function nodes with an observation linking them to 'src/utils.ts'. Your best bet is likely a search or traversal.
   Example Structured Output:
   { "operation": "search_nodes", "args": { "query": "entity_type:function file:src/utils.ts" } }
   OR
   { "operation": "graph_traversal", "args": { "start_node": "src/utils.ts", "relation_types": ["defines"], "traversal_depth": 1 } }
   (assuming 'defines' points from file to function)

2. NL: "Which classes import the 'PaymentService' module?"
   Translation (conceptual): Find nodes of type 'class' that have an 'imports_module' relation to a 'PaymentService' module node.
   Example Structured Output:
   { "operation": "search_nodes", "args": { "query": "entity_type:class imports:PaymentService" } }
   (You'll need to infer how to best structure this search based on the graph representation)

Knowledge Graph Structure:
${graphRepresentation}
${semanticContext}

Natural Language Query: "${naturalLanguageQuery}"

Instructions for translation:
1. If the query is ambiguous, include an "assumptions" field in your response explaining your interpretation
2. For search_nodes queries, try to be specific by combining entity type and observation filters
3. For graph_traversal, ensure the start_node exists in the provided graph
4. If the query cannot be reasonably translated, return { "error": "explanation of why" }
5. Leverage the "Semantically Relevant Code Chunks" to better understand the user's intent and identify specific entities or relationships mentioned implicitly.

Translate the above NL Query into the structured JSON format. Provide only the JSON object.`;

            const geminiResponseObject = await this.geminiService.askGemini(prompt, getCurrentModel());
            if (!geminiResponseObject || !geminiResponseObject.content || geminiResponseObject.content.length === 0 || !geminiResponseObject.content[0].text) {
                throw new McpError(ErrorCode.InternalError, "Gemini did not return a valid response structure for natural language query.");
            }
            const geminiResponse = geminiResponseObject.content[0].text;
            
            let structuredQuery: any;
            try {
                structuredQuery = parseGeminiJsonResponse(geminiResponse);
            } catch (parseError) {
                throw new McpError(ErrorCode.InternalError, `Failed to parse Gemini's structured query response: ${(parseError as Error).message}. Response: ${geminiResponse}`);
            }

            // Check for error response from Gemini
            if (structuredQuery.error) {
                return JSON.stringify({
                    error: structuredQuery.error,
                    originalQuery: naturalLanguageQuery,
                    suggestion: "Please rephrase your query or provide more specific details."
                }, null, 2);
            }

            // Extract assumptions if provided
            const assumptions = structuredQuery.assumptions;
            delete structuredQuery.assumptions; // Remove before execution

            // Step 3: Execute the structured query
            const operation = structuredQuery.operation;
            const args = structuredQuery.args;

            if (!operation) {
                throw new McpError(ErrorCode.InvalidParams, "Gemini did not provide a valid 'operation' in the structured query.");
            }

            let resultData: any;
            let executionMetadata: any = {
                originalQuery: naturalLanguageQuery,
                translatedOperation: operation,
                translatedArgs: args
            };
            
            if (assumptions) {
                executionMetadata.assumptions = assumptions;
            }
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

            // Include metadata in the response for better transparency
            const response = {
                metadata: executionMetadata,
                results: resultData
            };

            return JSON.stringify(response, null, 2);

        } catch (error: any) {
            console.error(`Error in queryNaturalLanguage:`, error);
            if (error instanceof McpError) throw error;
            throw new McpError(ErrorCode.InternalError, `Failed to process natural language query: ${error.message}`);
        }
    }

    private extractKeywordsFromQuery(query: string): string[] {
        // Extract potential entity names, file paths, and code identifiers from the query
        const keywords: string[] = [];
        
        // Extract quoted strings
        const quotedMatches = query.match(/["']([^"']+)["']/g);
        if (quotedMatches) {
            keywords.push(...quotedMatches.map(m => m.replace(/["']/g, '')));
        }
        
        // Extract file paths (containing slashes or dots with extensions)
        const pathMatches = query.match(/\b[\w\-]+(?:[\/\\][\w\-]+)*\.\w+\b/g);
        if (pathMatches) {
            keywords.push(...pathMatches);
        }
        
        // Extract PascalCase identifiers (likely class/interface names)
        const pascalCaseMatches = query.match(/\b[A-Z][a-zA-Z0-9]+(?:[A-Z][a-zA-Z0-9]+)*\b/g);
        if (pascalCaseMatches) {
            keywords.push(...pascalCaseMatches);
        }
        
        // Extract camelCase identifiers (likely function/variable names)
        const camelCaseMatches = query.match(/\b[a-z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]+)+\b/g);
        if (camelCaseMatches) {
            keywords.push(...camelCaseMatches);
        }
        
        // Remove duplicates and return
        return [...new Set(keywords)];
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

            const prompt = `You are an expert code analysis AI specializing in understanding software relationships. Given the following knowledge graph data from a codebase and additional context, identify and propose new relationships between existing entities.

Focus specifically on code-related relationships that are meaningful for understanding software architecture and dependencies:

**Target Relation Types** (use these exact relation type names):
- 'calls_function': When a function/method calls another function/method
- 'uses_class': When a function/method instantiates or uses methods of a class
- 'modifies_variable': When a function modifies a global or class variable
- 'implements_interface': When a class implements an interface
- 'extends_class': When a class extends/inherits from another class
- 'related_to_feature': When multiple entities are part of the same feature/module
- 'depends_on': General dependency relationship
- 'tested_by': When a test function/class tests another entity
- 'configures': When a configuration file or function configures another component

**Analysis Guidelines**:
1. Examine entity names, types, and observations (especially signatures, file paths, docstrings)
2. Look for patterns in naming conventions that suggest relationships
3. Consider directory structure - entities in the same directory might be related
4. Analyze function signatures for parameter types that might indicate class usage
5. Look for test files (containing 'test', 'spec') that might test other entities
6. Consider import relationships as hints for other relationships

Knowledge Graph Data:
${graphRepresentation}

Additional Context:
${context || 'No additional context provided.'}

Propose new relationships as a JSON array of objects. For each proposed relation, include:
- 'from': source entity name
- 'to': target entity name  
- 'relationType': one of the relation types listed above
- 'confidence': a score from 0.0 to 1.0 indicating confidence in this inference
- 'evidence': brief explanation of why this relation is inferred (max 100 chars)

Only include relationships that:
1. Are not already present in the graph
2. Have a confidence score of at least 0.6
3. Are between entities that actually exist in the provided graph data

If no new relations can be confidently inferred, return an empty array.

Example output:
[
  {
    "from": "src/auth/AuthService.ts::validateUser",
    "to": "src/models/User.ts::User",
    "relationType": "uses_class",
    "confidence": 0.85,
    "evidence": "validateUser likely instantiates or queries User class based on naming"
  },
  {
    "from": "src/tests/auth.test.ts::testValidateUser", 
    "to": "src/auth/AuthService.ts::validateUser",
    "relationType": "tested_by",
    "confidence": 0.95,
    "evidence": "Test function name directly references validateUser function"
  }
]`;

            const geminiResponseObject = await this.geminiService.askGemini(prompt, getCurrentModel());
            if (!geminiResponseObject || !geminiResponseObject.content || geminiResponseObject.content.length === 0 || !geminiResponseObject.content[0].text) {
                throw new McpError(ErrorCode.InternalError, "Gemini did not return a valid response structure for relation inference.");
            }
            const geminiResponse = geminiResponseObject.content[0].text;
            
            let inferredRelations: Array<{ from: string; to: string; relationType: string; confidence?: number; evidence?: string }>;
            try {
                inferredRelations = parseGeminiJsonResponse(geminiResponse);
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

            // Prepare detailed results including confidence and evidence
            const proposedRelations = newRelationsToAdd.map(rel => ({
                from: rel.from,
                to: rel.to,
                relationType: rel.relationType,
                confidence: rel.confidence || 0.7,
                evidence: rel.evidence || 'No specific evidence provided',
                status: 'proposed'
            }));

            if (proposedRelations.length > 0) {
                // For now, automatically add high-confidence relations (>= 0.8)
                // In future, could implement a review workflow
                const highConfidenceRelations = proposedRelations.filter(rel => rel.confidence >= 0.8);
                const lowConfidenceRelations = proposedRelations.filter(rel => rel.confidence < 0.8);
                
                let addedCount = 0;
                if (highConfidenceRelations.length > 0) {
                    const relationsToCreate = highConfidenceRelations.map(rel => ({
                        from: rel.from,
                        to: rel.to,
                        relationType: rel.relationType
                    }));
                    const creationResult = await this.createRelations(agent_id, relationsToCreate);
                    addedCount = creationResult.details.filter((d: any) => d.success).length;
                    
                    // Update status for added relations
                    highConfidenceRelations.forEach(rel => {
                        const created = creationResult.details.find((d: any) => 
                            d.from === rel.from && d.to === rel.to && d.type === rel.relationType
                        );
                        if (created && created.success) {
                            rel.status = 'added';
                        } else {
                            rel.status = 'failed';
                        }
                    });
                }
                
                return { 
                    message: `Inferred ${proposedRelations.length} relations. Added ${addedCount} high-confidence relations automatically. ${lowConfidenceRelations.length} low-confidence relations require review.`,
                    details: proposedRelations
                };
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

    async generateMermaidGraph(agent_id: string, options: { query?: string; layoutDirection?: string; depth?: number; includeLegend?: boolean; groupByDirectory?: boolean }): Promise<string> {
        try {
            const { query, layoutDirection = 'TD', depth = 2, includeLegend = true, groupByDirectory = false } = options;

            let nodes: any[] = [];
            let relations: any[] = [];

            if (query) {
                // If a query is provided, search for relevant nodes and their direct relations
                const queriedNodes = await this.searchNodes(agent_id, query);
                const nodeIds = queriedNodes.map(node => node.node_id);

                if (nodeIds.length === 0) {
                    return `graph ${layoutDirection}\n    A[No nodes found for the given query.]`;
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
                return `graph ${layoutDirection}\n    A[Knowledge graph is empty.]`;
            }

            let mermaidGraph = `graph ${layoutDirection}\n`;

            // Define node styles based on entityType
            const nodeStyles: { [key: string]: string } = {
                'file': 'shape:rect,fill:#ADD8E6,stroke:#333,stroke-width:2px', // Light blue rectangle
                'directory': 'shape:cylinder,fill:#90EE90,stroke:#333,stroke-width:2px', // Light green cylinder
                'function': 'shape:rounded-rectangle,fill:#FFD700,stroke:#333,stroke-width:2px', // Gold rounded rectangle
                'class': 'shape:hexagon,fill:#FFB6C1,stroke:#333,stroke-width:2px', // Light pink hexagon
                'interface': 'shape:diamond,fill:#DDA0DD,stroke:#333,stroke-width:2px', // Plum diamond
                'module': 'shape:database,fill:#87CEEB,stroke:#333,stroke-width:2px', // Sky blue database
                'variable': 'shape:circle,fill:#F0E68C,stroke:#333,stroke-width:2px', // Khaki circle
                'default': 'shape:rect,fill:#F5F5F5,stroke:#333,stroke-width:2px' // Default light gray rectangle
            };

            // Define relation styles based on relationType
            const relationStyles: { [key: string]: string } = {
                'contains_item': 'stroke:#6A5ACD,stroke-width:2px,stroke-dasharray: 5 5', // Slate blue dashed
                'imports_file': 'stroke:#4682B4,stroke-width:2px', // Steel blue solid
                'imports_module': 'stroke:#5F9EA0,stroke-width:2px,stroke-dasharray: 2 2', // Cadet blue dotted
                'defined_in_file': 'stroke:#DAA520,stroke-width:2px', // Goldenrod solid
                'has_method': 'stroke:#CD5C5C,stroke-width:2px', // Indian red solid
                'calls_function': 'stroke:#2E8B57,stroke-width:2px,stroke-dasharray: 5 1', // Sea green dashed
                'uses_class': 'stroke:#8A2BE2,stroke-width:2px', // Blue violet solid
                'modifies_variable': 'stroke:#B22222,stroke-width:2px,stroke-dasharray: 3 3', // Firebrick dotted
                'implements_interface': 'stroke:#FF4500,stroke-width:2px', // Orange red solid
                'extends_class': 'stroke:#008B8B,stroke-width:2px', // Dark cyan solid
                'related_to_feature': 'stroke:#8B4513,stroke-width:2px,stroke-dasharray: 5 5', // Saddle brown dashed
                'depends_on': 'stroke:#4B0082,stroke-width:2px', // Indigo solid
                'tested_by': 'stroke:#808000,stroke-width:2px', // Olive solid
                'configures': 'stroke:#483D8B,stroke-width:2px', // Dark slate blue solid
                'default': 'stroke:#333,stroke-width:1px' // Default black solid
            };

            // Group nodes by directory if requested
            if (groupByDirectory) {
                const nodesByDirectory: { [key: string]: any[] } = {};
                nodes.forEach(node => {
                    const observations = JSON.parse(node.observations || '[]');
                    const absolutePathObs = observations.find((obs: string) => obs.startsWith('absolute_path:'));
                    if (absolutePathObs) {
                        const absolutePath = absolutePathObs.split(': ')[1];
                        const dirName = path.dirname(absolutePath);
                        if (!nodesByDirectory[dirName]) {
                            nodesByDirectory[dirName] = [];
                        }
                        nodesByDirectory[dirName].push(node);
                    } else {
                        // Nodes without absolute_path observation go to a default group
                        if (!nodesByDirectory['(Other)']) {
                            nodesByDirectory['(Other)'] = [];
                        }
                        nodesByDirectory['(Other)'].push(node);
                    }
                });

                for (const dir in nodesByDirectory) {
                    const sanitizedDirName = dir.replace(/[^a-zA-Z0-9_]/g, '_');
                    mermaidGraph += `    subgraph ${sanitizedDirName} ["${dir === '.' ? 'Project Root' : dir}"]\n`;
                    nodesByDirectory[dir].forEach(node => {
                        const nodeLabel = node.name.replace(/[^a-zA-Z0-9_]/g, '_');
                        const style = nodeStyles[node.entityType] || nodeStyles['default'];
                        let shape = '';
                        if (node.entityType === 'file') shape = '[';
                        else if (node.entityType === 'directory') shape = '((';
                        else if (node.entityType === 'function') shape = '(';
                        else if (node.entityType === 'class') shape = '{{';
                        else if (node.entityType === 'interface') shape = '{';
                        else if (node.entityType === 'module') shape = '[/';
                        else if (node.entityType === 'variable') shape = '((';
                        
                        let endShape = '';
                        if (node.entityType === 'file') endShape = ']';
                        else if (node.entityType === 'directory') endShape = '))';
                        else if (node.entityType === 'function') endShape = ')';
                        else if (node.entityType === 'class') endShape = '}}';
                        else if (node.entityType === 'interface') endShape = '}';
                        else if (node.entityType === 'module') endShape = '/]';
                        else if (node.entityType === 'variable') endShape = '))';

                        mermaidGraph += `        ${nodeLabel}${shape}"${node.name}"${endShape}\n`;
                        mermaidGraph += `        style ${nodeLabel} ${style}\n`;
                    });
                    mermaidGraph += `    end\n`;
                }
            } else {
                // Add nodes with styling
                nodes.forEach(node => {
                    const nodeLabel = node.name.replace(/[^a-zA-Z0-9_]/g, '_');
                    const style = nodeStyles[node.entityType] || nodeStyles['default'];
                    let shape = '';
                    if (node.entityType === 'file') shape = '[';
                    else if (node.entityType === 'directory') shape = '((';
                    else if (node.entityType === 'function') shape = '(';
                    else if (node.entityType === 'class') shape = '{{';
                    else if (node.entityType === 'interface') shape = '{';
                    else if (node.entityType === 'module') shape = '[/';
                    else if (node.entityType === 'variable') shape = '((';
                    
                    let endShape = '';
                    if (node.entityType === 'file') endShape = ']';
                    else if (node.entityType === 'directory') endShape = '))';
                    else if (node.entityType === 'function') endShape = ')';
                    else if (node.entityType === 'class') endShape = '}}';
                    else if (node.entityType === 'interface') endShape = '}';
                    else if (node.entityType === 'module') endShape = '/]';
                    else if (node.entityType === 'variable') endShape = '))';

                    mermaidGraph += `    ${nodeLabel}${shape}"${node.name}"${endShape}\n`;
                    mermaidGraph += `    style ${nodeLabel} ${style}\n`;
                });
            }

            // Add relations with styling
            relations.forEach(rel => {
                const fromLabel = rel.from.replace(/[^a-zA-Z0-9_]/g, '_');
                const toLabel = rel.to.replace(/[^a-zA-Z0-9_]/g, '_');
                const style = relationStyles[rel.relationType] || relationStyles['default'];
                mermaidGraph += `    ${fromLabel} -- "${rel.relationType}" --> ${toLabel}\n`;
                mermaidGraph += `    linkStyle ${relations.indexOf(rel)} ${style}\n`; // Apply style to the link
            });

            // Add legend if requested
            if (includeLegend) {
                mermaidGraph += `\n%% Legend\n`;
                mermaidGraph += `classDef file rect;\n`;
                mermaidGraph += `classDef directory cylinder;\n`;
                mermaidGraph += `classDef function rounded-rectangle;\n`;
                mermaidGraph += `classDef class hexagon;\n`;
                mermaidGraph += `classDef interface diamond;\n`;
                mermaidGraph += `classDef module database;\n`;
                mermaidGraph += `classDef variable circle;\n`;

                mermaidGraph += `\n`;
                mermaidGraph += `%% Node Styles\n`;
                for (const type in nodeStyles) {
                    if (type !== 'default') {
                        mermaidGraph += `style ${type} ${nodeStyles[type]}\n`;
                    }
                }

                mermaidGraph += `\n%% Relation Styles\n`;
                for (const type in relationStyles) {
                    if (type !== 'default') {
                        mermaidGraph += `linkStyle ${type} ${relationStyles[type]}\n`;
                    }
                }
            }

            return mermaidGraph;

        } catch (error: any) {
            console.error(`Error in generateMermaidGraph:`, error);
            if (error instanceof McpError) throw error;
            throw new McpError(ErrorCode.InternalError, `Failed to generate Mermaid graph: ${error.message}`);
        }
    }
}
