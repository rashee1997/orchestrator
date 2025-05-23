import { getDatabase, initializeDatabase } from './db.js';
import { randomUUID } from 'crypto';
import { GoogleGenAI, createUserContent, createPartFromUri } from '@google/genai';
import fs from 'fs';
import fsp from 'fs/promises';

import path from 'path';
import { Database } from 'sqlite';

const KNOWLEDGE_GRAPH_FILE_PATH = path.join(process.cwd(), 'knowledge_graph.jsonl');

interface KnowledgeGraph {
    entities: any[];
    relations: any[];
}

export class MemoryManager {
    private db!: Database;
    private genAI?: GoogleGenAI; // Make genAI optional

    private constructor(genAIInstance?: GoogleGenAI) {
        // Private constructor to enforce async factory
        if (genAIInstance) {
            this.genAI = genAIInstance;
        } else {
            const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
            if (!GEMINI_API_KEY) {
                this.genAI = undefined; // Explicitly set to undefined if API key is missing
            } else {
                this.genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
            }
        }
    }

    public static async create(genAIInstance?: GoogleGenAI): Promise<MemoryManager> {
        const instance = new MemoryManager(genAIInstance);
        await instance.init(); // Await initialization here
        return instance;
    }

    private async init() {
        this.db = await initializeDatabase();
        // Ensure the knowledge graph file exists
        try {
            await fsp.access(KNOWLEDGE_GRAPH_FILE_PATH);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                await fsp.writeFile(KNOWLEDGE_GRAPH_FILE_PATH, ''); // Create empty file
            } else {
                console.error('Error accessing knowledge graph file:', error);
            }
        }
    }


    private async loadKnowledgeGraph(): Promise<KnowledgeGraph> {
        try {
            const data = await fs.promises.readFile(KNOWLEDGE_GRAPH_FILE_PATH, 'utf-8');
            const lines = data.split('\n').filter((line: string) => line.trim() !== '');
            return lines.reduce((graph: KnowledgeGraph, line: string) => {
                const item = JSON.parse(line);
                if (item.type === 'entity') {
                    graph.entities.push(item.data);
                } else if (item.type === 'relation') {
                    graph.relations.push(item.data);
                }
                return graph;
            }, { entities: [], relations: [] });
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                return { entities: [], relations: [] };
            }
            throw error;
        }
    }
    private async saveKnowledgeGraph(graph: KnowledgeGraph) {
        const lines = [
            ...graph.entities.map(e => JSON.stringify({ type: 'entity', data: e })),
            ...graph.relations.map(r => JSON.stringify({ type: 'relation', data: r })),
        ];
        await fsp.writeFile(KNOWLEDGE_GRAPH_FILE_PATH, lines.join('\n'));
    }


    // --- Conversation History ---
    async storeConversationMessage(
        agent_id: string,
        user_id: string | null,
        sender: string,
        message_content: string,
        message_type: string = 'text',
        tool_info: string | null = null,
        context_snapshot_id: string | null = null,
        source_attribution_id: string | null = null
    ) {
        const db = this.db;
        const conversation_id = randomUUID();
        const timestamp = Date.now();
        await db.run(
            `INSERT INTO conversation_history (
                conversation_id, agent_id, user_id, timestamp, sender, message_content,
                message_type, tool_info, context_snapshot_id, source_attribution_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            conversation_id, agent_id, user_id, timestamp, sender, message_content,
            message_type, tool_info, context_snapshot_id, source_attribution_id
        );
        return conversation_id;
    }

    async getConversationHistory(
        agent_id: string,
        conversation_id: string | null = null,
        limit: number = 100,
        offset: number = 0
    ) {
        const db = this.db;
        let query = `SELECT * FROM conversation_history WHERE agent_id = ?`;
        const params: (string | number)[] = [agent_id];

        if (conversation_id) {
            query += ` AND conversation_id = ?`;
            params.push(conversation_id);
        }

        query += ` ORDER BY timestamp ASC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        return db.all(query, ...params as any[]);
    }

    // --- Context Information ---
    async storeContext(
        agent_id: string,
        context_type: string,
        context_data: any, // Will be JSON stringified
        parent_context_id: string | null = null
    ) {
        const db = this.db;
        const context_id = randomUUID();
        const timestamp = Date.now();
        const context_data_json = JSON.stringify(context_data);

        // Check for existing context of the same type for the agent to handle versioning
        const existingContext = await db.get(
            `SELECT context_id, version FROM context_information
             WHERE agent_id = ? AND context_type = ? ORDER BY version DESC LIMIT 1`,
            agent_id, context_type
        );

        let newVersion = 1;
        if (existingContext) {
            newVersion = existingContext.version + 1;
        }

        await db.run(
            `INSERT INTO context_information (
                context_id, agent_id, timestamp, context_type, context_data, version, parent_context_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            context_id, agent_id, timestamp, context_type, context_data_json, newVersion, parent_context_id
        );
        return context_id;
    }

    async getContext(
        agent_id: string,
        context_type: string,
        version: number | null = null,
        snippet_index: number | null = null // New parameter
    ) {
        const db = this.db;
        let query = `SELECT * FROM context_information WHERE agent_id = ? AND context_type = ?`;
        const params: (string | number)[] = [agent_id, context_type];

        if (version !== null) {
            query += ` AND version = ?`;
            params.push(version);
        } else {
            query += ` ORDER BY version DESC LIMIT 1`; // Get latest version
        }

        const result = await db.get(query, ...params as any[]);
        if (result && result.context_data) {
            result.context_data = JSON.parse(result.context_data);

            // If snippet_index is provided, try to return only that snippet
            if (snippet_index !== null && typeof snippet_index === 'number' && snippet_index >= 0) {
                if (result.context_data.documentation_snippets && Array.isArray(result.context_data.documentation_snippets)) {
                    if (snippet_index < result.context_data.documentation_snippets.length) {
                        return result.context_data.documentation_snippets[snippet_index];
                    } else {
                        // Index out of bounds
                        return null; // Or throw an error, depending on desired behavior
                    }
                } else {
                    // documentation_snippets array not found
                    return null; // Or throw an error
                }
            }
        }
        return result; // Return full context or null if not found/parsed
    }

    async getAllContexts(agent_id: string) {
        const db = this.db;
        const results = await db.all(`SELECT * FROM context_information WHERE agent_id = ? ORDER BY timestamp DESC`, agent_id);
        return results.map((row: any) => {
            if (row.context_data) {
                row.context_data = JSON.parse(row.context_data);
            }
            return row;
        });
    }

    // Note on Query Optimization:
    // All queries use parameterized statements to prevent SQL injection and leverage SQLite's query plan caching.
    // Indexes are defined in schema.sql to optimize common lookup patterns.
    // Further optimization would involve profiling and specific query rewrites if bottlenecks are identified.

    // --- Reference Keys ---
    async addReferenceKey(
        agent_id: string,
        key_type: string,
        key_value: string,
        description: string | null = null,
        associated_conversation_id: string | null = null
    ) {
        const db = this.db;
        const reference_id = randomUUID();
        const timestamp = Date.now();
        await db.run(
            `INSERT INTO reference_keys (
                reference_id, agent_id, key_type, key_value, description, timestamp, associated_conversation_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            reference_id, agent_id, key_type, key_value, description, timestamp, associated_conversation_id
        );
        return reference_id;
    }

    async getReferenceKeys(
        agent_id: string,
        key_type: string | null = null,
        limit: number = 100,
        offset: number = 0
    ) {
        const db = this.db;
        let query = `SELECT * FROM reference_keys WHERE agent_id = ?`;
        const params: (string | number)[] = [agent_id];

        if (key_type) {
            query += ` AND key_type = ?`;
            params.push(key_type);
        }

        query += ` ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        return db.all(query, ...params as any[]);
    }

    // --- Source Attribution ---
    async logSourceAttribution(
        agent_id: string,
        source_type: string,
        source_uri: string | null = null,
        retrieval_timestamp: number,
        content_summary: string | null = null,
        full_content_hash: string | null = null,
        full_content_json: string | null = null // New parameter
    ) {
        const db = this.db;
        const attribution_id = randomUUID();
        await db.run(
            `INSERT INTO source_attribution (
                attribution_id, agent_id, source_type, source_uri, retrieval_timestamp, content_summary, full_content_hash, full_content_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            attribution_id, agent_id, source_type, source_uri, retrieval_timestamp, content_summary, full_content_hash, full_content_json
        );
        return attribution_id;
    }

    async getSourceAttributions(
        agent_id: string,
        source_type: string | null = null,
        limit: number = 100,
        offset: number = 0
    ) {
        const db = this.db;
        let query = `SELECT * FROM source_attribution WHERE agent_id = ?`;
        const params: (string | number)[] = [agent_id];

        if (source_type) {
            query += ` AND source_type = ?`;
            params.push(source_type);
        }

        query += ` ORDER BY retrieval_timestamp DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        return db.all(query, ...params as any[]);
    }

    // --- Correction Logs ---
    async logCorrection(
        agent_id: string,
        correction_type: string,
        original_entry_id: string | null,
        original_value: any | null, // Will be JSON stringified
        corrected_value: any | null, // Will be JSON stringified
        reason: string | null,
        applied_automatically: boolean
    ) {
        const db = this.db;
        const correction_id = randomUUID();
        const timestamp = Date.now();
        const original_value_json = original_value ? JSON.stringify(original_value) : null;
        const corrected_value_json = corrected_value ? JSON.stringify(corrected_value) : null;

        await db.run(
            `INSERT INTO correction_logs (
                correction_id, agent_id, timestamp, correction_type, original_entry_id,
                original_value, corrected_value, reason, applied_automatically
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            correction_id, agent_id, timestamp, correction_type, original_entry_id,
            original_value_json, corrected_value_json, reason, applied_automatically
        );
        return correction_id;
    }

    async getCorrectionLogs(
        agent_id: string,
        correction_type: string | null = null,
        limit: number = 100,
        offset: number = 0
    ) {
        const db = this.db;
        let query = `SELECT * FROM correction_logs WHERE agent_id = ?`;
        const params: (string | number)[] = [agent_id];

        if (correction_type) {
            query += ` AND correction_type = ?`;
            params.push(correction_type);
        }

        query += ` ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const results = await db.all(query, ...params as any[]);
        return results.map((row: any) => {
            if (row.original_value) row.original_value = JSON.parse(row.original_value);
            if (row.corrected_value) row.corrected_value = JSON.parse(row.corrected_value);
            return row;
        });
    }

    // --- Success Metrics ---
    async logSuccessMetric(
        agent_id: string,
        metric_name: string,
        metric_value: number,
        unit: string | null = null,
        associated_task_id: string | null = null,
        metadata: any | null = null // Will be JSON stringified
    ) {
        const db = this.db;
        const metric_id = randomUUID();
        const timestamp = Date.now();
        const metadata_json = metadata ? JSON.stringify(metadata) : null;

        await db.run(
            `INSERT INTO success_metrics (
                metric_id, agent_id, timestamp, metric_name, metric_value, unit, associated_task_id, metadata
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            metric_id, agent_id, timestamp, metric_name, metric_value, unit, associated_task_id, metadata_json
        );
        return metric_id;
    }

    async getSuccessMetrics(
        agent_id: string,
        metric_name: string | null = null,
        limit: number = 100,
        offset: number = 0
    ) {
        const db = this.db;
        let query = `SELECT * FROM success_metrics WHERE agent_id = ?`;
        const params: (string | number)[] = [agent_id];

        if (metric_name) {
            query += ` AND metric_name = ?`;
            params.push(metric_name);
        }

        query += ` ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const results = await db.all(query, ...params as any[]);
        return results.map((row: any) => {
            if (row.metadata) row.metadata = JSON.parse(row.metadata);
            return row;
        });
    }

    // --- Plan and Task Management ---

    async createPlanWithTasks(
        agent_id: string,
        planData: { title: string; overall_goal?: string; status?: string; version?: number; refined_prompt_id_associated?: string; analysis_report_id_referenced?: string; metadata?: any },
        tasksData: Array<{ task_number: number; title: string; description?: string; status?: string; purpose?: string; action_description?: string; files_involved?: string[]; dependencies_task_ids?: string[]; tools_required_list?: string[]; inputs_summary?: string; outputs_summary?: string; success_criteria_text?: string; estimated_effort_hours?: number; assigned_to?: string; verification_method?: string; notes?: any }>
    ): Promise<{ plan_id: string; task_ids: string[] }> {
        const db = this.db;
        const plan_id = randomUUID();
        const timestamp = Date.now();

        await db.run('BEGIN TRANSACTION');
        try {
            await db.run(
                `INSERT INTO plans (
                    plan_id, agent_id, title, overall_goal, status, version,
                    creation_timestamp, last_updated_timestamp, refined_prompt_id_associated,
                    analysis_report_id_referenced, metadata
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                plan_id,
                agent_id,
                planData.title,
                planData.overall_goal || null,
                planData.status || 'DRAFT',
                planData.version || 1,
                timestamp,
                timestamp,
                planData.refined_prompt_id_associated || null,
                planData.analysis_report_id_referenced || null,
                planData.metadata ? JSON.stringify(planData.metadata) : null
            );

            const task_ids: string[] = [];
            const taskStmt = await db.prepare(
                `INSERT INTO plan_tasks (
                    task_id, plan_id, agent_id, task_number, title, description, status,
                    purpose, action_description, files_involved, dependencies_task_ids,
                    tools_required_list, inputs_summary, outputs_summary, success_criteria_text,
                    estimated_effort_hours, assigned_to, verification_method,
                    creation_timestamp, last_updated_timestamp, completion_timestamp, notes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            );

            for (const task of tasksData) {
                const task_id = randomUUID();
                task_ids.push(task_id);
                await taskStmt.run(
                    task_id,
                    plan_id,
                    agent_id,
                    task.task_number,
                    task.title || 'Untitled Task', // Ensure title is never null
                    task.description || null,
                    task.status || 'PLANNED',
                    task.purpose || null,
                    task.action_description || null,
                    task.files_involved ? JSON.stringify(task.files_involved) : null,
                    task.dependencies_task_ids ? JSON.stringify(task.dependencies_task_ids) : null,
                    task.tools_required_list ? JSON.stringify(task.tools_required_list) : null,
                    task.inputs_summary || null,
                    task.outputs_summary || null,
                    task.success_criteria_text || null,
                    task.estimated_effort_hours || null,
                    task.assigned_to || null,
                    task.verification_method || null,
                    timestamp,
                    timestamp,
                    task.status === 'COMPLETED' || task.status === 'FAILED' ? timestamp : null,
                    task.notes ? JSON.stringify(task.notes) : null
                );
            }
            await taskStmt.finalize();
            await db.run('COMMIT');
            return { plan_id, task_ids };
        } catch (error) {
            await db.run('ROLLBACK');
            console.error('Error creating plan with tasks:', error);
            throw error;
        }
    }

    async getPlan(agent_id: string, plan_id: string): Promise<object | null> {
        const db = this.db;
        const plan = await db.get(
            `SELECT * FROM plans WHERE agent_id = ? AND plan_id = ?`,
            agent_id, plan_id
        );
        if (plan && plan.metadata) {
            plan.metadata = JSON.parse(plan.metadata);
        }
        return plan;
    }

    async getPlans(agent_id: string, status_filter?: string, limit: number = 100, offset: number = 0): Promise<object[]> {
        const db = this.db;
        let query = `SELECT * FROM plans WHERE agent_id = ?`;
        const params: (string | number)[] = [agent_id];

        if (status_filter) {
            query += ` AND status = ?`;
            params.push(status_filter);
        }

        query += ` ORDER BY creation_timestamp DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const results = await db.all(query, ...params as any[]);
        return results.map((row: any) => {
            if (row.metadata) {
                row.metadata = JSON.parse(row.metadata);
            }
            return row;
        });
    }

    async getPlanTasks(agent_id: string, plan_id: string, status_filter?: string, limit: number = 100, offset: number = 0): Promise<object[]> {
        const db = this.db;
        let query = `SELECT * FROM plan_tasks WHERE agent_id = ? AND plan_id = ?`;
        const params: (string | number)[] = [agent_id, plan_id];

        if (status_filter) {
            query += ` AND status = ?`;
            params.push(status_filter);
        }

        query += ` ORDER BY task_number ASC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const results = await db.all(query, ...params as any[]);
        return results.map((row: any) => {
            if (row.files_involved) row.files_involved = JSON.parse(row.files_involved);
            if (row.dependencies_task_ids) row.dependencies_task_ids = JSON.parse(row.dependencies_task_ids);
            if (row.tools_required_list) row.tools_required_list = JSON.parse(row.tools_required_list);
            if (row.notes) row.notes = JSON.parse(row.notes);
            return row;
        });
    }

    async updatePlanStatus(agent_id: string, plan_id: string, new_status: string): Promise<boolean> {
        const db = this.db;
        const timestamp = Date.now();
        const result = await db.run(
            `UPDATE plans SET status = ?, last_updated_timestamp = ? WHERE agent_id = ? AND plan_id = ?`,
            new_status, timestamp, agent_id, plan_id
        );
        return (result?.changes || 0) > 0;
    }

    async updateTaskStatus(agent_id: string, task_id: string, new_status: string, completion_timestamp?: number): Promise<boolean> {
        const db = this.db;
        const timestamp = Date.now();
        const result = await db.run(
            `UPDATE plan_tasks SET status = ?, last_updated_timestamp = ?, completion_timestamp = ? WHERE agent_id = ? AND task_id = ?`,
            new_status, timestamp, completion_timestamp || null, agent_id, task_id
        );
        return (result?.changes || 0) > 0;
    }

    async deletePlan(agent_id: string, plan_id: string): Promise<boolean> {
        const db = this.db;
        const result = await db.run(
            `DELETE FROM plans WHERE agent_id = ? AND plan_id = ?`,
            agent_id, plan_id
        );
        return (result?.changes || 0) > 0;
    }

    async getTask(agent_id: string, task_id: string): Promise<object | null> {
        const db = this.db;
        const task = await db.get(
            `SELECT * FROM plan_tasks WHERE agent_id = ? AND task_id = ?`,
            agent_id, task_id
        );
        if (task) {
            if (task.files_involved) task.files_involved = JSON.parse(task.files_involved);
            if (task.dependencies_task_ids) task.dependencies_task_ids = JSON.parse(task.dependencies_task_ids);
            if (task.tools_required_list) task.tools_required_list = JSON.parse(task.tools_required_list);
            if (task.notes) task.notes = JSON.parse(task.notes);
        }
        return task;
    }

    // --- Knowledge Graph Memory Tools ---

    async createEntities(
        agent_id: string,
        entities: Array<{ name: string; entityType: string; observations: string[] }>
    ) {
        const db = this.db;
        const stmt = await db.prepare(
            `INSERT INTO knowledge_graph_nodes (node_id, agent_id, name, entity_type, observations, timestamp)
             VALUES (?, ?, ?, ?, ?, ?)`
        );
        const results = [];
        for (const entity of entities) {
            const node_id = randomUUID();
            const timestamp = Date.now();
            const observations_json = JSON.stringify(entity.observations);
            await stmt.run(node_id, agent_id, entity.name, entity.entityType, observations_json, timestamp);
            results.push({ node_id, name: entity.name });
        }
        await stmt.finalize();
        return { message: `Created ${results.length} entities.`, details: results };
    }

    async createRelations(
        agent_id: string,
        relations: Array<{ from: string; to: string; relationType: string }>
    ) {
        const db = this.db;
        const stmt = await db.prepare(
            `INSERT INTO knowledge_graph_relations (relation_id, agent_id, from_node_id, to_node_id, relation_type, timestamp)
             VALUES (?, ?, ?, ?, ?, ?)`
        );
        const results = [];
        for (const relation of relations) {
            const relation_id = randomUUID();
            const timestamp = Date.now();

            // Get node_ids for 'from' and 'to' entities
            const fromNode = await db.get(`SELECT node_id FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, relation.from);
            const toNode = await db.get(`SELECT node_id FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, relation.to);

            if (!fromNode) {
                results.push({ success: false, message: `Entity '${relation.from}' not found.` });
                continue;
            }
            if (!toNode) {
                results.push({ success: false, message: `Entity '${relation.to}' not found.` });
                continue;
            }

            await stmt.run(relation_id, agent_id, fromNode.node_id, toNode.node_id, relation.relationType, timestamp);
            results.push({ success: true, relation_id, from: relation.from, to: relation.to, type: relation.relationType });
        }
        await stmt.finalize();
        return { message: `Created ${results.filter(r => r.success).length} relations.`, details: results };
    }

    async addObservations(
        agent_id: string,
        observations: Array<{ entityName: string; contents: string[] }>
    ) {
        const db = this.db;
        const results = [];
        for (const obs of observations) {
            const node = await db.get(`SELECT node_id, observations FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, obs.entityName);
            if (!node) {
                results.push({ success: false, message: `Entity '${obs.entityName}' not found.` });
                continue;
            }

            let existingObservations = JSON.parse(node.observations || '[]');
            existingObservations = [...existingObservations, ...obs.contents];

            await db.run(
                `UPDATE knowledge_graph_nodes SET observations = ? WHERE node_id = ?`,
                JSON.stringify(existingObservations), node.node_id
            );
            results.push({ success: true, entityName: obs.entityName, addedCount: obs.contents.length });
        }
        return { message: `Added observations to ${results.filter(r => r.success).length} entities.`, details: results };
    }

    async deleteEntities(
        agent_id: string,
        entityNames: string[]
    ) {
        const db = this.db;
        const results = [];
        for (const name of entityNames) {
            const node = await db.get(`SELECT node_id FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, name);
            if (!node) {
                results.push({ success: false, message: `Entity '${name}' not found.` });
                continue;
            }

            // Delete associated relations first
            await db.run(`DELETE FROM knowledge_graph_relations WHERE agent_id = ? AND (from_node_id = ? OR to_node_id = ?)`, agent_id, node.node_id, node.node_id);
            // Delete the node
            const deleteResult = await db.run(`DELETE FROM knowledge_graph_nodes WHERE node_id = ?`, node.node_id);
            results.push({ success: (deleteResult?.changes || 0) > 0, entityName: name, deleted: (deleteResult?.changes || 0) > 0 });
        }
        return { message: `Deleted ${results.filter(r => r.deleted).length} entities.`, details: results };
    }

    async deleteObservations(
        agent_id: string,
        deletions: Array<{ entityName: string; observations: string[] }>
    ) {
        const db = this.db;
        const results = [];
        for (const del of deletions) {
            const node = await db.get(`SELECT node_id, observations FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, del.entityName);
            if (!node) {
                results.push({ success: false, message: `Entity '${del.entityName}' not found.` });
                continue;
            }

            let existingObservations = JSON.parse(node.observations || '[]');
            const initialCount = existingObservations.length;
            existingObservations = existingObservations.filter((obs: string) => !del.observations.includes(obs));
            const deletedCount = initialCount - existingObservations.length;

            await db.run(
                `UPDATE knowledge_graph_nodes SET observations = ? WHERE node_id = ?`,
                JSON.stringify(existingObservations), node.node_id
            );
            results.push({ success: true, entityName: del.entityName, deletedCount: deletedCount });
        }
        return { message: `Deleted observations from ${results.filter(r => r.success).length} entities.`, details: results };
    }

    async deleteRelations(
        agent_id: string,
        relations: Array<{ from: string; to: string; relationType: string }>
    ) {
        const db = this.db;
        const results = [];
        for (const relation of relations) {
            const fromNode = await db.get(`SELECT node_id FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, relation.from);
            const toNode = await db.get(`SELECT node_id FROM knowledge_graph_nodes WHERE agent_id = ? AND name = ?`, agent_id, relation.to);

            if (!fromNode || !toNode) {
                results.push({ success: false, message: `One or both entities for relation (${relation.from}, ${relation.to}) not found.` });
                continue;
            }

            const deleteResult = await db.run(
                `DELETE FROM knowledge_graph_relations WHERE agent_id = ? AND from_node_id = ? AND to_node_id = ? AND relation_type = ?`,
                agent_id, fromNode.node_id, toNode.node_id, relation.relationType
            );
            results.push({ success: (deleteResult?.changes || 0) > 0, from: relation.from, to: relation.to, type: relation.relationType, deleted: (deleteResult?.changes || 0) > 0 });
        }
        return { message: `Deleted ${results.filter(r => r.deleted).length} relations.`, details: results };
    }

    async readGraph(agent_id: string) {
        const db = this.db;
        const nodes = await db.all(`SELECT node_id, name, entity_type, observations FROM knowledge_graph_nodes WHERE agent_id = ?`, agent_id);
        const relations = await db.all(`SELECT r.relation_id, r.relation_type, n1.name AS from_name, n2.name AS to_name FROM knowledge_graph_relations r JOIN knowledge_graph_nodes n1 ON r.from_node_id = n1.node_id JOIN knowledge_graph_nodes n2 ON r.to_node_id = n2.node_id WHERE r.agent_id = ?`, agent_id);

        return {
            nodes: nodes.map((node: any) => ({
                node_id: node.node_id,
                name: node.name,
                entityType: node.entity_type,
                observations: JSON.parse(node.observations || '[]')
            })),
            relations: relations.map((rel: any) => ({
                relation_id: rel.relation_id,
                from: rel.from_name,
                to: rel.to_name,
                relationType: rel.relation_type
            }))
        };
    }

    async searchNodes(agent_id: string, query: string) {
        const db = this.db;
        const searchQuery = `%${query.toLowerCase()}%`;
        const nodes = await db.all(
            `SELECT node_id, name, entity_type, observations FROM knowledge_graph_nodes
             WHERE agent_id = ? AND (LOWER(name) LIKE ? OR LOWER(entity_type) LIKE ? OR LOWER(observations) LIKE ?)`,
            agent_id, searchQuery, searchQuery, searchQuery
        );
        return nodes.map((node: any) => ({
            node_id: node.node_id,
            name: node.name,
            entityType: node.entity_type,
            observations: JSON.parse(node.observations || '[]')
        }));
    }

    async openNodes(agent_id: string, names: string[]) {
        const db = this.db;
        const placeholders = names.map(() => '?').join(',');
        const nodes = await db.all(
            `SELECT node_id, name, entity_type, observations FROM knowledge_graph_nodes
             WHERE agent_id = ? AND name IN (${placeholders})`,
            agent_id, ...names
        );
        return nodes.map((node: any) => ({
            node_id: node.node_id,
            name: node.name,
            entityType: node.entity_type,
            observations: JSON.parse(node.observations || '[]')
        }));
    }

    // --- New: Search Context by Keywords ---
    async searchContextByKeywords(
        agent_id: string,
        context_type: string,
        keywords: string
    ) {
        const db = this.db;
        // Retrieve the latest version of the context for the given agent and context_type
        const contextResult = await this.getContext(agent_id, context_type);

        if (!contextResult || !contextResult.context_data || !contextResult.context_data.documentation_snippets || !Array.isArray(contextResult.context_data.documentation_snippets)) {
            return []; // Return empty array if context or snippets not found
        }

        const searchKeywords = keywords.toLowerCase().split(/\s+/).filter(k => k.length > 0);
        const filteredSnippets = contextResult.context_data.documentation_snippets.filter((snippet: any) => {
            const title = (snippet.TITLE || '').toLowerCase();
            const description = (snippet.DESCRIPTION || '').toLowerCase();
            const code = (snippet.CODE || '').toLowerCase(); // Also search in code

            return searchKeywords.some(keyword =>
                title.includes(keyword) ||
                description.includes(keyword) ||
                code.includes(keyword)
            );
        });

        return filteredSnippets;
    }

    // --- New: Context Pruning/Archiving Tool ---
    async pruneOldContext(
        agent_id: string,
        max_age_ms: number,
        context_type: string | null = null
    ) {
        const db = this.db;
        const cutoffTimestamp = Date.now() - max_age_ms;

        let query = `DELETE FROM context_information WHERE agent_id = ? AND timestamp < ?`;
        const params: (string | number)[] = [agent_id, cutoffTimestamp];

        if (context_type) {
            query += ` AND context_type = ?`;
            params.push(context_type);
        }

        const result = await db.run(query, ...params as any[]);
        return result.changes; // Number of rows deleted
    }

    // --- New: Summarization Tool ---
    async summarizeContext(
        agent_id: string,
        context_type: string,
        version: number | null = null
    ) {
        if (!this.genAI) {
            return `Gemini API not initialized. Cannot perform summarization.`;
        }

        const modelName = "gemini-2.0-flash"; // Using gemini-2.0-flash for text tasks

        const db = this.db;
        const contextResult = await this.getContext(agent_id, context_type, version);

        if (!contextResult || !contextResult.context_data) {
            return `No context found for agent_id: ${agent_id}, context_type: ${context_type}`;
        }

        let textToSummarize = '';
        if (contextResult.context_data.documentation_snippets && Array.isArray(contextResult.context_data.documentation_snippets)) {
            textToSummarize = contextResult.context_data.documentation_snippets.map((s: any) => `${s.TITLE}: ${s.DESCRIPTION} ${s.CODE}`).join('\n\n');
        } else {
            textToSummarize = JSON.stringify(contextResult.context_data);
        }

        if (textToSummarize.length === 0) {
            return `No content to summarize for agent_id: ${agent_id}, context_type: ${context_type}`;
        }

        try {
            const prompt = `Summarize the following text:\n\n${textToSummarize}`;
            const result = await this.genAI.models.generateContent({ model: modelName, contents: [{ role: "user", parts: [{ text: prompt }] }] });
            const summary = result.text; // Directly access text property
            return summary;
        } catch (error: any) {
            console.error(`Error calling Gemini API for summarization:`, error);
            return `Failed to summarize context using Gemini API: ${error.message}`;
        }
    }

    // --- New: Entity and Keyword Extraction Tool ---
    async extractEntities(
        agent_id: string,
        context_type: string,
        version: number | null = null
    ) {
        if (!this.genAI) {
            return { entities: [], keywords: [], message: `Gemini API not initialized. Cannot perform entity extraction.` };
        }

        const modelName = "gemini-2.0-flash";

        const db = this.db;
        const contextResult = await this.getContext(agent_id, context_type, version);

        if (!contextResult || !contextResult.context_data) {
            return { entities: [], keywords: [], message: `No context found for agent_id: ${agent_id}, context_type: ${context_type}` };
        }

        let textToExtractFrom = '';
        if (contextResult.context_data.documentation_snippets && Array.isArray(contextResult.context_data.documentation_snippets)) {
            textToExtractFrom = contextResult.context_data.documentation_snippets.map((s: any) => `${s.TITLE}: ${s.DESCRIPTION} ${s.CODE}`).join('\n\n');
        } else {
            textToExtractFrom = JSON.stringify(contextResult.context_data);
        }

        if (textToExtractFrom.length === 0) {
            return { entities: [], keywords: [], message: `No content to extract entities from for agent_id: ${agent_id}, context_type: ${context_type}` };
        }

        try {
            const prompt = `Extract key entities and keywords from the following text. Provide the output as a JSON object with two arrays: 'entities' and 'keywords'.\n\n${textToExtractFrom}`;
            const result = await this.genAI.models.generateContent({ model: modelName, contents: [{ role: "user", parts: [{ text: prompt }] }] });
            const textResponse = result.text ?? ''; // Directly access text property, provide empty string if undefined

            // Attempt to parse the JSON response, handling markdown code blocks
            try {
                let jsonString = textResponse;
                const jsonMatch = textResponse.match(/```json\n([\s\S]*?)\n```/);
                if (jsonMatch && jsonMatch[1]) {
                    jsonString = jsonMatch[1];
                }
                const parsedResponse = JSON.parse(jsonString);
                return {
                    entities: parsedResponse.entities || [],
                    keywords: parsedResponse.keywords || [],
                    message: `Successfully extracted entities and keywords using Gemini API.`
                };
            } catch (parseError) {
                console.error(`Error parsing Gemini API response for entity extraction:`, parseError);
                return { entities: [], keywords: [], message: `Failed to parse Gemini API response: ${textResponse}` };
            }
        } catch (error: any) {
            console.error(`Error calling Gemini API for entity extraction:`, error);
            return { entities: [], keywords: [], message: `Failed to extract entities using Gemini API: ${error.message}` };
        }
    }

    // --- New: Semantic Search / Vector Embedding Tool ---
    async semanticSearchContext(
        agent_id: string,
        context_type: string,
        query_text: string,
        top_k: number = 5
    ) {
        const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
        if (!GEMINI_API_KEY) {
            return { results: [], message: `Gemini API key is not configured. Cannot perform semantic search.` };
        }

        const genAI = new GoogleGenAI({apiKey: GEMINI_API_KEY});
        const modelName = "models/text-embedding-004";

        const db = this.db;
        const contextResult = await this.getContext(agent_id, context_type);

        if (!contextResult || !contextResult.context_data || !contextResult.context_data.documentation_snippets || !Array.isArray(contextResult.context_data.documentation_snippets)) {
            return { results: [], message: `No context or documentation snippets found for agent_id: ${agent_id}, context_type: ${context_type}` };
        }

        try {
            // Generate embedding for the query
            const queryEmbeddingResponse = await genAI.models.embedContent({ model: modelName, contents: [{ text: query_text }] });
            const queryEmbedding = queryEmbeddingResponse.embeddings?.[0]?.values || [];

            const snippetsWithEmbeddings: { snippet: any; embedding: number[] }[] = [];

            // Generate embeddings for each snippet and store them
            for (const snippet of contextResult.context_data.documentation_snippets) {
                const snippetText = `${snippet.TITLE}: ${snippet.DESCRIPTION} ${snippet.CODE}`;
                const snippetEmbeddingResponse = await genAI.models.embedContent({ model: modelName, contents: [{ text: snippetText }] });
                snippetsWithEmbeddings.push({
                    snippet: snippet,
                    embedding: snippetEmbeddingResponse.embeddings?.[0]?.values || []
                });
            }

            // Calculate similarity and sort
            const searchResults = snippetsWithEmbeddings.map(item => {
                const similarity = this.cosineSimilarity(queryEmbedding, item.embedding);
                return { score: similarity, snippet: item.snippet };
            }).sort((a, b) => b.score - a.score); // Sort in descending order of similarity

            return {
                results: searchResults.slice(0, top_k),
                message: `Successfully performed semantic search using Gemini API.`
            };
        } catch (error: any) {
            console.error(`Error calling Gemini API for semantic search:`, error);
            return { results: [], message: `Failed to perform semantic search using Gemini API: ${error.message}` };
        }
    }

    // Helper function for cosine similarity
    private cosineSimilarity(vecA: number[], vecB: number[]): number {
        let dotProduct = 0;
        let magnitudeA = 0;
        let magnitudeB = 0;

        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            magnitudeA += vecA[i] * vecA[i];
            magnitudeB += vecB[i] * vecB[i];
        }

        magnitudeA = Math.sqrt(magnitudeA);
        magnitudeB = Math.sqrt(magnitudeB);

        if (magnitudeA === 0 || magnitudeB === 0) {
            return 0; // Avoid division by zero
        }

        return dotProduct / (magnitudeA * magnitudeB);
    }

    // --- New: Export Data to CSV Tool ---
    async exportDataToCsv(tableName: string, filePath: string) {
        const db = this.db;
        try {
            const rows = await db.all(`SELECT * FROM ${tableName}`);
            if (rows.length === 0) {
                await fsp.writeFile(filePath, ''); // Create empty file if no data
                return `No data found in table '${tableName}'. Created empty CSV file at ${filePath}`;
            }

            const headers = Object.keys(rows[0]);
            const csvRows = [
                headers.join(','), // Header row
                ...rows.map((row: any) =>
                    headers.map(header => {
                        let value = row[header];
                        if (typeof value === 'string') {
                            // Escape double quotes and wrap in double quotes if it contains comma or double quote
                            value = value.replace(/"/g, '""');
                            if (value.includes(',') || value.includes('\n')) {
                                value = `"${value}"`;
                            }
                        } else if (value === null || value === undefined) {
                            value = '';
                        } else if (typeof value === 'object') {
                            value = JSON.stringify(value).replace(/"/g, '""');
                            value = `"${value}"`;
                        }
                        return value;
                    }).join(',')
                )
            ];

            await fsp.writeFile(filePath, csvRows.join('\n'));
            return `Successfully exported data from table '${tableName}' to ${filePath}`;
        } catch (error: any) {
            console.error(`Error exporting data to CSV from table ${tableName}:`, error);
            throw new Error(`Failed to export data to CSV: ${error.message}`);
        }
    }


    // --- New: Backup Database Tool ---
    async backupDatabase(backupFilePath: string) {
        const dbPath = 'c:/Users/user/Dropbox/PC/Documents/Cline/MCP/memory-mcp-server/memory.db'; // Use hardcoded absolute path
        try {
            // Ensure the database is not actively writing during backup
            // For SQLite, a simple file copy is often sufficient if the database is not heavily contended.
            // For robust solutions, consider SQLite's backup API or stopping the server.
            await fsp.copyFile(dbPath, backupFilePath);
            return `Database backed up successfully to ${backupFilePath}`;
        } catch (error: any) {
            console.error(`Error backing up database to ${backupFilePath}:`, error);
            throw new Error(`Failed to backup database: ${error.message}`);
        }
    }


    // --- New: Restore Database Tool ---
    async restoreDatabase(backupFilePath: string) {
        const dbPath = 'c:/Users/user/Dropbox/PC/Documents/Cline/MCP/memory-mcp-server/memory.db'; // Use hardcoded absolute path
        try {
            // IMPORTANT: For a robust restore, the database connection should ideally be closed
            // before replacing the file, and then re-opened.
            // This simple implementation assumes the server might be restarted or handles reconnections.
            // If the database is actively in use, this operation might fail or corrupt the database.
            if (!fs.existsSync(backupFilePath)) {
                throw new Error(`Backup file not found at ${backupFilePath}`);
            }

            // Close the current database connection before replacing the file
            // This is a simplified approach; a proper MCP server might need a more graceful shutdown/reconnect.
            // await this.db.close(); // This might not be directly accessible or safe here

            await fsp.copyFile(backupFilePath, dbPath);
            // Re-initialize the database connection after restoring
            // This assumes initializeDatabase can handle re-opening an existing DB.
            this.db = await initializeDatabase();
            return `Database restored successfully from ${backupFilePath}`;
        } catch (error: any) {
            console.error(`Error restoring database from ${backupFilePath}:`, error);
            throw new Error(`Failed to restore database: ${error.message}`);
        }
    }

    // --- New: Prompt Refinement Tool ---
    async processAndRefinePrompt(
        agent_id: string,
        raw_user_prompt: string,
        target_ai_persona: string | null = null,
        conversation_context_ids: string[] | null = null
    ): Promise<any> {
        if (!this.genAI) {
            return {
                refined_prompt_id: randomUUID(),
                original_prompt_text: raw_user_prompt,
                refinement_engine_model: "gemini-2.0-flash",
                refinement_timestamp: new Date().toISOString(),
                overall_goal: "Error: Gemini API not initialized.",
                decomposed_tasks: [],
                key_entities_identified: [],
                implicit_assumptions_made_by_refiner: [],
                explicit_constraints_from_prompt: [],
                suggested_ai_role_for_agent: null,
                suggested_reasoning_strategy_for_agent: null,
                desired_output_characteristics_inferred: {},
                suggested_context_analysis_for_agent: [],
                confidence_in_refinement_score: "Low",
                refinement_error_message: "Gemini API not initialized. Ensure GEMINI_API_KEY is set."
            };
        }

        const modelName = "gemini-2.0-flash";

        const metaPrompt = `
You are an expert AI prompt engineer. Your task is to take a raw user prompt, analyze it, and transform it into a highly structured and actionable "Refined Prompt for AI". This refined prompt will be used by another AI agent to understand and execute the user's request.

You MUST output the refined prompt as a JSON object, strictly adhering to the following schema. Do not include any other text or markdown outside of the JSON block.

JSON Schema for Refined Prompt:
\`\`\`json
{
  "refined_prompt_id": "server_generated_uuid_for_this_refinement_instance",
  "original_prompt_text": "The exact raw user prompt text that was processed.",
  "refinement_engine_model": "gemini-2.0-flash",
  "refinement_timestamp": "YYYY-MM-DDTHH:MM:SS.sssZ",
  "overall_goal": "A clear, concise statement of the user's primary objective, as interpreted from the prompt.",
  "decomposed_tasks": [ // Array of strings, each a specific, actionable sub-task
    "Sub-task 1 identified from the prompt.",
    "Sub-task 2 identified from the prompt."
  ],
  "key_entities_identified": [ // Array of strings or objects detailing key entities
    // Example: "Filename: user_authentication.py", "Concept: Argon2 Hashing"
    // Or structured: {"type": "filename", "value": "user_authentication.py"}, {"type": "concept", "value": "Argon2 Hashing"}
    "Entity A (e.g., filename, function name, concept)",
    "Entity B"
  ],
  "implicit_assumptions_made_by_refiner": [ // Assumptions the refinement LLM made
    "Assuming 'the dashboard' refers to the main application dashboard.",
    "Assuming standard Python library availability unless specified otherwise."
  ],
  "explicit_constraints_from_prompt": [ // Constraints directly stated by the user
    "The solution must be implemented in Python 3.9.",
    "The UI must remain consistent with the existing design language."
  ],
  "suggested_ai_role_for_agent": "Example: Act as a Senior Python Developer specializing in API security and database interactions.",
  "suggested_reasoning_strategy_for_agent": "Example: Prioritize security best practices. Analyze potential attack vectors. Ensure input validation. Plan for data migration if schema changes are needed.",
  "desired_output_characteristics_inferred": {
    "type": "Example: A fully functional Python module with accompanying unit tests.", // e.g., Code Solution, Explanatory text, Plan, Diagram
    "key_content_elements": [ // Specific items the final output from the agent should contain
      "Refactored Python code for user_authentication.py.",
      "Detailed explanation of Argon2 parameter choices.",
      "Unit tests covering new hashing and verification logic."
    ],
    "level_of_detail": "Example: Sufficient for another developer to understand, integrate, and maintain the changes." // e.g., High-level overview, Detailed step-by-step
  },
  "suggested_context_analysis_for_agent": [ // Actionable suggestions for the AI agent
    // Can be simple strings or more structured objects. Prioritize memory retrieval tools.
    {
      "suggestion_type": "MEMORY_RETRIEVAL",
      "tool_to_use": "get_conversation_history",
      "parameters": {"limit": 5, "offset": 0},
      "rationale": "To understand immediate preceding dialogue for context."
    },
    {
      "suggestion_type": "MEMORY_RETRIEVAL",
      "tool_to_use": "search_context_by_keywords",
      "parameters": {"context_type": "project_documentation_v1", "keywords": "authentication security policy"},
      "rationale": "Prompt mentions security and authentication; check for existing policies."
    },
    {
      "suggestion_type": "KNOWLEDGE_GRAPH_QUERY",
      "tool_to_use": "knowledge_graph_memory",
      "parameters": {"operation": "search_nodes", "query": "Argon2 implementation details"},
      "rationale": "To find any existing internal knowledge about Argon2."
    },
    {
      "suggestion_type": "FILE_ANALYSIS_SUGGESTION",
      "tool_to_use": "read_file",
      "parameters": {"path": "src/config/app_settings.json"},
      "rationale": "If the prompt implies configuration, check common config files."
    }
  ],
  "confidence_in_refinement_score": "High", // e.g., High, Medium, Low
  "refinement_error_message": null // String message if refinement process itself had an issue, otherwise null
}
\`\`\`

Raw User Prompt:
\`\`\`
${raw_user_prompt}
\`\`\`

${target_ai_persona ? `Suggested AI Persona: ${target_ai_persona}\n` : ''}
${conversation_context_ids && conversation_context_ids.length > 0 ? `Recent Conversation Context IDs: ${conversation_context_ids.join(', ')}\n` : ''}

Please provide the JSON object only.
`;

        try {
            const result = await this.genAI.models.generateContent({
                model: modelName,
                contents: [{ role: "user", parts: [{ text: metaPrompt }] }]
            });
            const textResponse = result.text ?? '';

            let parsedResponse: any;
            try {
                // Attempt to parse the JSON response, handling markdown code blocks
                let jsonString = textResponse;
                const jsonMatch = textResponse.match(/```json\n([\s\S]*?)\n```/);
                if (jsonMatch && jsonMatch[1]) {
                    jsonString = jsonMatch[1];
                }
                parsedResponse = JSON.parse(jsonString);
            } catch (parseError) {
                console.error(`Error parsing Gemini API response for prompt refinement:`, parseError);
                return {
                    refined_prompt_id: randomUUID(),
                    original_prompt_text: raw_user_prompt,
                    refinement_engine_model: modelName,
                    refinement_timestamp: new Date().toISOString(),
                    overall_goal: "Error: Failed to parse Gemini API response.",
                    decomposed_tasks: [],
                    key_entities_identified: [],
                    implicit_assumptions_made_by_refiner: [],
                    explicit_constraints_from_prompt: [],
                    suggested_ai_role_for_agent: null,
                    suggested_reasoning_strategy_for_agent: null,
                    desired_output_characteristics_inferred: {},
                    suggested_context_analysis_for_agent: [],
                    confidence_in_refinement_score: "Low",
                    refinement_error_message: `Failed to parse Gemini API response: ${textResponse.substring(0, 200)}...`
                };
            }

            // Ensure server-generated fields are correct
            parsedResponse.refined_prompt_id = randomUUID();
            parsedResponse.original_prompt_text = raw_user_prompt;
            parsedResponse.refinement_engine_model = modelName;
            parsedResponse.refinement_timestamp = new Date().toISOString();
            parsedResponse.agent_id = agent_id; // Add agent_id to the refined prompt object

            // Store the refined prompt in the database
            await this.storeRefinedPrompt(parsedResponse);

            return parsedResponse;

        } catch (error: any) {
            console.error(`Error calling Gemini API for prompt refinement:`, error);
            return {
                refined_prompt_id: randomUUID(),
                original_prompt_text: raw_user_prompt,
                refinement_engine_model: modelName,
                refinement_timestamp: new Date().toISOString(),
                overall_goal: "Error: Gemini API call failed.",
                decomposed_tasks: [],
                key_entities_identified: [],
                implicit_assumptions_made_by_refiner: [],
                explicit_constraints_from_prompt: [],
                suggested_ai_role_for_agent: null,
                suggested_reasoning_strategy_for_agent: null,
                desired_output_characteristics_inferred: {},
                suggested_context_analysis_for_agent: [],
                confidence_in_refinement_score: "Low",
                refinement_error_message: `Gemini API call failed: ${error.message}`
            };
        }
    }

    // --- New: Store Refined Prompt Tool ---
    async storeRefinedPrompt(refinedPrompt: any): Promise<string> {
        const db = this.db;
        const refined_prompt_id = refinedPrompt.refined_prompt_id || randomUUID();
        const timestamp = refinedPrompt.refinement_timestamp ? new Date(refinedPrompt.refinement_timestamp).getTime() : Date.now();

        await db.run(
            `INSERT INTO refined_prompts (
                refined_prompt_id, agent_id, original_prompt_text, refinement_engine_model,
                refinement_timestamp, overall_goal, decomposed_tasks, key_entities_identified,
                implicit_assumptions_made_by_refiner, explicit_constraints_from_prompt,
                suggested_ai_role_for_agent, suggested_reasoning_strategy_for_agent,
                desired_output_characteristics_inferred, suggested_context_analysis_for_agent,
                confidence_in_refinement_score, refinement_error_message
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            refined_prompt_id,
            refinedPrompt.agent_id,
            refinedPrompt.original_prompt_text,
            refinedPrompt.refinement_engine_model || null,
            timestamp,
            refinedPrompt.overall_goal || null,
            refinedPrompt.decomposed_tasks ? JSON.stringify(refinedPrompt.decomposed_tasks) : null,
            refinedPrompt.key_entities_identified ? JSON.stringify(refinedPrompt.key_entities_identified) : null,
            refinedPrompt.implicit_assumptions_made_by_refiner ? JSON.stringify(refinedPrompt.implicit_assumptions_made_by_refiner) : null,
            refinedPrompt.explicit_constraints_from_prompt ? JSON.stringify(refinedPrompt.explicit_constraints_from_prompt) : null,
            refinedPrompt.suggested_ai_role_for_agent || null,
            refinedPrompt.suggested_reasoning_strategy_for_agent || null,
            refinedPrompt.desired_output_characteristics_inferred ? JSON.stringify(refinedPrompt.desired_output_characteristics_inferred) : null,
            refinedPrompt.suggested_context_analysis_for_agent ? JSON.stringify(refinedPrompt.suggested_context_analysis_for_agent) : null,
            refinedPrompt.confidence_in_refinement_score || null,
            refinedPrompt.refinement_error_message || null
        );
        return refined_prompt_id;
    }

    // --- New: Get Refined Prompt Tool ---
    async getRefinedPrompt(refined_prompt_id: string): Promise<any | null> {
        const db = this.db;
        const result = await db.get(
            `SELECT * FROM refined_prompts WHERE refined_prompt_id = ?`,
            refined_prompt_id
        );

        if (result) {
            // Parse JSON stringified fields back into objects/arrays
            if (result.decomposed_tasks) result.decomposed_tasks = JSON.parse(result.decomposed_tasks);
            if (result.key_entities_identified) result.key_entities_identified = JSON.parse(result.key_entities_identified);
            if (result.implicit_assumptions_made_by_refiner) result.implicit_assumptions_made_by_refiner = JSON.parse(result.implicit_assumptions_made_by_refiner);
            if (result.explicit_constraints_from_prompt) result.explicit_constraints_from_prompt = JSON.parse(result.explicit_constraints_from_prompt);
            if (result.desired_output_characteristics_inferred) result.desired_output_characteristics_inferred = JSON.parse(result.desired_output_characteristics_inferred);
            if (result.suggested_context_analysis_for_agent) result.suggested_context_analysis_for_agent = JSON.parse(result.suggested_context_analysis_for_agent);
        }
        return result;
    }

}
