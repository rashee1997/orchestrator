import { randomUUID } from 'crypto';
import { DatabaseService } from '../services/DatabaseService.js';
import { validate, schemas } from '../../utils/validation.js';

export class PlanTaskManager {
    private dbService: DatabaseService;

    constructor(dbService: DatabaseService) {
        this.dbService = dbService;
    }

    async createPlanWithTasks(
        agent_id: string,
        planData: { title: string; overall_goal?: string; status?: string; version?: number; refined_prompt_id_associated?: string; analysis_report_id_referenced?: string; metadata?: any },
        tasksData: Array<{ task_number: number; title: string; description?: string; status?: string; purpose?: string; action_description?: string; files_involved?: string[]; dependencies_task_ids?: string[]; tools_required_list?: string[]; inputs_summary?: string; outputs_summary?: string; success_criteria_text?: string; estimated_effort_hours?: number; assigned_to?: string; verification_method?: string; notes?: any }>
    ): Promise<{ plan_id: string; task_ids: string[] }> {
        const db = this.dbService.getDb();
        const plan_id = randomUUID();
        const timestamp = Date.now();

        const validationResult = validate('createTaskPlan', { agent_id, planData, tasksData });
        if (!validationResult.valid) {
            console.error('Validation errors for createPlanWithTasks:', validationResult.errors);
            throw new Error(`Invalid input for createPlanWithTasks: ${JSON.stringify(validationResult.errors)}`);
        }

        try {
            await db.run('BEGIN TRANSACTION');

            await db.run(
                `INSERT INTO plans (
                    plan_id, agent_id, title, overall_goal, status, version,
                    creation_timestamp_unix, creation_timestamp_iso, last_updated_timestamp_unix, last_updated_timestamp_iso, refined_prompt_id_associated,
                    analysis_report_id_referenced, metadata
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                plan_id,
                agent_id,
                planData.title,
                planData.overall_goal || null,
                planData.status || 'DRAFT',
                planData.version || 1,
                timestamp,
                new Date(timestamp).toISOString(),
                timestamp,
                new Date(timestamp).toISOString(),
                planData.refined_prompt_id_associated || null,
                planData.analysis_report_id_referenced || null,
                planData.metadata ? JSON.stringify(planData.metadata) : null
            );

            const task_ids: string[] = [];
            const taskStmt = await db.prepare(
                `INSERT INTO plan_tasks (
                    task_id, plan_id, agent_id, task_number, title, description, status,
                    purpose, action_description, files_involved_json, dependencies_task_ids_json,
                    tools_required_list_json, inputs_summary, outputs_summary, success_criteria_text,
                    estimated_effort_hours, assigned_to, verification_method,
                    creation_timestamp_unix, creation_timestamp_iso, last_updated_timestamp_unix, last_updated_timestamp_iso, completion_timestamp_unix, completion_timestamp_iso, notes_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            );

            for (const task of tasksData) {
                const task_id = randomUUID();
                task_ids.push(task_id);
                await taskStmt.run(
                    task_id,
                    plan_id,
                    agent_id,
                    task.task_number,
                    task.title || 'Untitled Task',
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
                    new Date(timestamp).toISOString(),
                    timestamp,
                    new Date(timestamp).toISOString(),
                    task.status === 'COMPLETED' || task.status === 'FAILED' ? timestamp : null,
                    task.status === 'COMPLETED' || task.status === 'FAILED' ? new Date(timestamp).toISOString() : null,
                    task.notes ? JSON.stringify(task.notes) : null
                );
            }
            await taskStmt.finalize();
            await db.run('COMMIT');
            return { plan_id, task_ids };
        } catch (error) {
            await db.run('ROLLBACK');
            console.error('Error creating plan with tasks, transaction rolled back:', error);
            throw error;
        }
    }

    async getPlan(agent_id: string, plan_id: string): Promise<object | null> {
        const db = this.dbService.getDb();
        const plan = await db.get(
            `SELECT * FROM plans WHERE agent_id = ? AND plan_id = ?`,
            agent_id, plan_id
        );
        if (plan && plan.metadata) { // Check if metadata exists and is a string
            try {
                plan.metadata_parsed = JSON.parse(plan.metadata); // Store parsed JSON in a new key
            } catch (e) {
                console.error(`Failed to parse metadata for plan ${plan_id}:`, e);
                plan.metadata_parsed = null; // Indicate parsing failure
                plan.metadata_parsing_error = true; // Add an error flag
                // Keep plan.metadata as the original string
            }
        } else if (plan) {
            plan.metadata_parsed = null; // Ensure metadata_parsed exists even if metadata was null/undefined
        }
        return plan;
    }

    async getPlans(agent_id: string, status_filter?: string, limit: number = 100, offset: number = 0): Promise<object[]> {
        const db = this.dbService.getDb();
        let query = `SELECT * FROM plans WHERE agent_id = ?`;
        const params: (string | number)[] = [agent_id];

        if (status_filter) {
            query += ` AND status = ?`;
            params.push(status_filter);
        }

        query += ` ORDER BY creation_timestamp_unix DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const results = await db.all(query, ...params as any[]);
        return results.map((row: any) => {
            if (row.metadata) { // Check if metadata exists and is a string
                try {
                    row.metadata_parsed = JSON.parse(row.metadata);
                } catch (e) {
                    console.error(`Failed to parse metadata for plan ${row.plan_id}:`, e);
                    row.metadata_parsed = null;
                    row.metadata_parsing_error = true;
                    // Keep row.metadata as the original string
                }
            } else {
                row.metadata_parsed = null;
            }
            return row;
        });
    }


    async getPlanTasks(agent_id: string, plan_id: string, status_filter?: string, limit: number = 100, offset: number = 0): Promise<object[]> {
        const db = this.dbService.getDb();
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
            // Safely parse JSON fields, adding error flags and keeping raw data if parsing fails
            if (row.files_involved_json) {
                try { row.files_involved = JSON.parse(row.files_involved_json); } 
                catch (e) { 
                    console.error(`Failed to parse files_involved_json for task ${row.task_id}:`, e); 
                    row.files_involved = null; // Or []
                    row.files_involved_json_parsing_error = true;
                    row.raw_files_involved_json = row.files_involved_json;
                }
            } else { row.files_involved = []; }

            if (row.dependencies_task_ids_json) {
                try { row.dependencies_task_ids = JSON.parse(row.dependencies_task_ids_json); }
                catch (e) {
                    console.error(`Failed to parse dependencies_task_ids_json for task ${row.task_id}:`, e);
                    row.dependencies_task_ids = null; // Or []
                    row.dependencies_task_ids_json_parsing_error = true;
                    row.raw_dependencies_task_ids_json = row.dependencies_task_ids_json;
                }
            } else { row.dependencies_task_ids = []; }

            if (row.tools_required_list_json) {
                try { row.tools_required_list = JSON.parse(row.tools_required_list_json); }
                catch (e) {
                    console.error(`Failed to parse tools_required_list_json for task ${row.task_id}:`, e);
                    row.tools_required_list = null; // Or []
                    row.tools_required_list_json_parsing_error = true;
                    row.raw_tools_required_list_json = row.tools_required_list_json;
                }
            } else { row.tools_required_list = []; }
            
            if (row.notes_json) {
                try { row.notes = JSON.parse(row.notes_json); }
                catch (e) {
                    console.error(`Failed to parse notes_json for task ${row.task_id}:`, e);
                    row.notes = null; // Or {}
                    row.notes_json_parsing_error = true;
                    row.raw_notes_json = row.notes_json;
                }
            } else { row.notes = null; }
            return row;
        });
    }

    async updatePlanStatus(agent_id: string, plan_id: string, new_status: string): Promise<boolean> {
        const db = this.dbService.getDb();
        const timestamp = Date.now();
        const result = await db.run(
            `UPDATE plans SET status = ?, last_updated_timestamp_unix = ?, last_updated_timestamp_iso = ? WHERE agent_id = ? AND plan_id = ?`,
            new_status, timestamp, new Date(timestamp).toISOString(), agent_id, plan_id
        );
        return (result?.changes || 0) > 0;
    }

    async updateTaskDetails(
        agent_id: string,
        task_id: string,
        updates: {
            title?: string;
            description?: string;
            status?: string;
            purpose?: string;
            action_description?: string;
            files_involved?: string[];
            dependencies_task_ids?: string[];
            tools_required_list?: string[];
            inputs_summary?: string;
            outputs_summary?: string;
            success_criteria_text?: string;
            estimated_effort_hours?: number;
            assigned_to?: string;
            verification_method?: string;
            notes?: any;
        },
        completion_timestamp?: number
    ): Promise<boolean> {
        const db = this.dbService.getDb();
        const timestamp = Date.now();

        const task = await this.getTask(agent_id, task_id);
        if (!task) {
            console.warn(`Attempted to update non-existent task: ${task_id} for agent: ${agent_id}`);
            return false;
        }

        const plan = await this.getPlan(agent_id, (task as any).plan_id);
        if (!plan) {
            console.warn(`Attempted to update task ${task_id} whose associated plan ${((task as any).plan_id)} does not exist for agent: ${agent_id}`);
            return false;
        }

        let updateFields: string[] = [];
        let updateValues: any[] = [];

        if (updates.title !== undefined) { updateFields.push('title = ?'); updateValues.push(updates.title); }
        if (updates.description !== undefined) { updateFields.push('description = ?'); updateValues.push(updates.description); }
        if (updates.status !== undefined) { updateFields.push('status = ?'); updateValues.push(updates.status); }
        if (updates.purpose !== undefined) { updateFields.push('purpose = ?'); updateValues.push(updates.purpose); }
        if (updates.action_description !== undefined) { updateFields.push('action_description = ?'); updateValues.push(updates.action_description); }
        if (updates.files_involved !== undefined) { updateFields.push('files_involved_json = ?'); updateValues.push(updates.files_involved ? JSON.stringify(updates.files_involved) : null); }
        if (updates.dependencies_task_ids !== undefined) { updateFields.push('dependencies_task_ids_json = ?'); updateValues.push(updates.dependencies_task_ids ? JSON.stringify(updates.dependencies_task_ids) : null); }
        if (updates.tools_required_list !== undefined) { updateFields.push('tools_required_list_json = ?'); updateValues.push(updates.tools_required_list ? JSON.stringify(updates.tools_required_list) : null); }
        if (updates.inputs_summary !== undefined) { updateFields.push('inputs_summary = ?'); updateValues.push(updates.inputs_summary); }
        if (updates.outputs_summary !== undefined) { updateFields.push('outputs_summary = ?'); updateValues.push(updates.outputs_summary); }
        if (updates.success_criteria_text !== undefined) { updateFields.push('success_criteria_text = ?'); updateValues.push(updates.success_criteria_text); }
        if (updates.estimated_effort_hours !== undefined) { updateFields.push('estimated_effort_hours = ?'); updateValues.push(updates.estimated_effort_hours); }
        if (updates.assigned_to !== undefined) { updateFields.push('assigned_to = ?'); updateValues.push(updates.assigned_to); }
        if (updates.verification_method !== undefined) { updateFields.push('verification_method = ?'); updateValues.push(updates.verification_method); }
        if (updates.notes !== undefined) { updateFields.push('notes_json = ?'); updateValues.push(updates.notes ? JSON.stringify(updates.notes) : null); }

        updateFields.push('last_updated_timestamp_unix = ?');
        updateValues.push(timestamp);
        updateFields.push('last_updated_timestamp_iso = ?');
        updateValues.push(new Date(timestamp).toISOString());

        if (completion_timestamp !== undefined) {
            updateFields.push('completion_timestamp_unix = ?');
            updateValues.push(completion_timestamp || null);
            updateFields.push('completion_timestamp_iso = ?');
            updateValues.push(completion_timestamp ? new Date(completion_timestamp).toISOString() : null);
        } else if (updates.status === 'COMPLETED' || updates.status === 'FAILED') {
            // If status is set to completed/failed and no explicit completion_timestamp is provided, set it now
            updateFields.push('completion_timestamp_unix = ?');
            updateValues.push(timestamp);
            updateFields.push('completion_timestamp_iso = ?');
            updateValues.push(new Date(timestamp).toISOString());
        } else if (updates.status !== 'COMPLETED' && updates.status !== 'FAILED' && (task as any).completion_timestamp_unix) {
            // If status is changed from completed/failed to something else, clear completion timestamp
            updateFields.push('completion_timestamp_unix = ?');
            updateValues.push(null);
            updateFields.push('completion_timestamp_iso = ?');
            updateValues.push(null);
        }


        if (updateFields.length === 0) {
            console.warn(`No fields provided for updateTaskDetails for task: ${task_id}`);
            return false;
        }

        const query = `UPDATE plan_tasks SET ${updateFields.join(', ')} WHERE agent_id = ? AND task_id = ?`;
        updateValues.push(agent_id, task_id);

        const result = await db.run(query, ...updateValues);
        return (result?.changes || 0) > 0;
    }

    async deletePlans(agent_id: string, plan_ids: string[]): Promise<boolean> {
        const db = this.dbService.getDb();
        if (plan_ids.length === 0) {
            return false;
        }
        const placeholders = plan_ids.map(() => '?').join(',');
        const result = await db.run(
            `DELETE FROM plans WHERE agent_id = ? AND plan_id IN (${placeholders})`,
            agent_id, ...plan_ids
        );
        return (result?.changes || 0) > 0;
    }

    async deleteTasks(agent_id: string, task_ids: string[]): Promise<boolean> {
        const db = this.dbService.getDb();
        if (task_ids.length === 0) {
            return false;
        }
        const placeholders = task_ids.map(() => '?').join(',');
        const result = await db.run(
            `DELETE FROM plan_tasks WHERE agent_id = ? AND task_id IN (${placeholders})`,
            agent_id, ...task_ids
        );
        return (result?.changes || 0) > 0;
    }

    async getTask(agent_id: string, task_id: string): Promise<object | null> {
        const db = this.dbService.getDb();
        const task = await db.get(
            `SELECT * FROM plan_tasks WHERE agent_id = ? AND task_id = ?`,
            agent_id, task_id
        );
        if (task) {
            if (task.files_involved_json) {
                try { task.files_involved = JSON.parse(task.files_involved_json); }
                catch (e) {
                    console.error(`Failed to parse files_involved_json for task ${task.task_id}:`, e);
                    task.files_involved = null; // Or []
                    task.files_involved_json_parsing_error = true;
                    task.raw_files_involved_json = task.files_involved_json;
                }
            } else { task.files_involved = []; }

            if (task.dependencies_task_ids_json) {
                try { task.dependencies_task_ids = JSON.parse(task.dependencies_task_ids_json); }
                catch (e) {
                    console.error(`Failed to parse dependencies_task_ids_json for task ${task.task_id}:`, e);
                    task.dependencies_task_ids = null; // Or []
                    task.dependencies_task_ids_json_parsing_error = true;
                    task.raw_dependencies_task_ids_json = task.dependencies_task_ids_json;
                }
            } else { task.dependencies_task_ids = []; }

            if (task.tools_required_list_json) {
                try { task.tools_required_list = JSON.parse(task.tools_required_list_json); }
                catch (e) {
                    console.error(`Failed to parse tools_required_list_json for task ${task.task_id}:`, e);
                    task.tools_required_list = null; // Or []
                    task.tools_required_list_json_parsing_error = true;
                    task.raw_tools_required_list_json = task.tools_required_list_json;
                }
            } else { task.tools_required_list = []; }

            if (task.notes_json) {
                try { task.notes = JSON.parse(task.notes_json); }
                catch (e) {
                    console.error(`Failed to parse notes_json for task ${task.task_id}:`, e);
                    task.notes = null; // Or {}
                    task.notes_json_parsing_error = true;
                    task.raw_notes_json = task.notes_json;
                }
            } else { task.notes = null; }
        }
        return task;
    }

    async addTaskToPlan(
        agent_id: string,
        plan_id: string,
        taskData: { task_number: number; title: string; description?: string; status?: string; purpose?: string; action_description?: string; files_involved?: string[]; dependencies_task_ids?: string[]; tools_required_list?: string[]; inputs_summary?: string; outputs_summary?: string; success_criteria_text?: string; estimated_effort_hours?: number; assigned_to?: string; verification_method?: string; notes?: any }
    ): Promise<string> {
        const db = this.dbService.getDb();
        const timestamp = Date.now();

        const validationResult = validate('addTaskToPlan', { agent_id, plan_id, taskData });
        if (!validationResult.valid) {
            console.error('Validation errors for addTaskToPlan:', validationResult.errors);
            throw new Error(`Invalid input for addTaskToPlan: ${JSON.stringify(validationResult.errors)}`);
        }

        const plan = await this.getPlan(agent_id, plan_id);
        if (!plan) {
            throw new Error(`Plan with ID ${plan_id} not found for agent ${agent_id}.`);
        }

        const task_id = randomUUID();
        try {
            await db.run(
                `INSERT INTO plan_tasks (
                    task_id, plan_id, agent_id, task_number, title, description, status,
                    purpose, action_description, files_involved_json, dependencies_task_ids_json,
                    tools_required_list_json, inputs_summary, outputs_summary, success_criteria_text,
                    estimated_effort_hours, assigned_to, verification_method,
                    creation_timestamp_unix, creation_timestamp_iso, last_updated_timestamp_unix, last_updated_timestamp_iso, completion_timestamp_unix, completion_timestamp_iso, notes_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                task_id,
                plan_id,
                agent_id,
                taskData.task_number,
                taskData.title,
                taskData.description || null,
                taskData.status || 'PLANNED',
                taskData.purpose || null,
                taskData.action_description || null,
                taskData.files_involved ? JSON.stringify(taskData.files_involved) : null,
                taskData.dependencies_task_ids ? JSON.stringify(taskData.dependencies_task_ids) : null,
                taskData.tools_required_list ? JSON.stringify(taskData.tools_required_list) : null,
                taskData.inputs_summary || null,
                taskData.outputs_summary || null,
                taskData.success_criteria_text || null,
                taskData.estimated_effort_hours || null,
                taskData.assigned_to || null,
                taskData.verification_method || null,
                timestamp,
                new Date(timestamp).toISOString(),
                timestamp,
                new Date(timestamp).toISOString(),
                taskData.status === 'COMPLETED' || taskData.status === 'FAILED' ? timestamp : null,
                taskData.status === 'COMPLETED' || taskData.status === 'FAILED' ? new Date(timestamp).toISOString() : null,
                taskData.notes ? JSON.stringify(taskData.notes) : null
            );
            return task_id;
        } catch (error) {
            console.error(`Error adding task to plan ${plan_id}:`, error);
            throw error;
        }
    }
}
