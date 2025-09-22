import { randomUUID } from 'crypto';
import { DatabaseService } from '../services/DatabaseService.js';
import { validate, schemas } from '../../utils/validation.js';

// NEW: Define types for parsed plan and task objects to improve type safety.
export interface ParsedPlan {
    plan_id: string;
    agent_id: string;
    title: string;
    overall_goal?: string;
    status: string;
    version: number;
    creation_timestamp_unix: number;
    creation_timestamp_iso: string;
    last_updated_timestamp_unix: number;
    last_updated_timestamp_iso: string;
    refined_prompt_id_associated?: string;
    analysis_report_id_referenced?: string;
    metadata?: string;
    metadata_parsed?: any;
    metadata_parsing_error?: boolean;
}

export interface ParsedTask {
    task_id: string;
    plan_id: string;
    agent_id: string;
    task_number: number;
    title: string;
    description?: string;
    status: string;
    purpose?: string;
    action_description?: string;
    files_involved_json?: string;
    dependencies_task_ids_json?: string;
    tools_required_list_json?: string;
    inputs_summary?: string;
    outputs_summary?: string;
    success_criteria_text?: string;
    estimated_effort_hours?: number;
    assigned_to?: string;
    verification_method?: string;
    code_content?: string;
    phase?: string;
    creation_timestamp_unix: number;
    creation_timestamp_iso: string;
    last_updated_timestamp_unix: number;
    last_updated_timestamp_iso: string;
    notes_json?: string;
    files_involved?: any[];
    dependencies_task_ids?: any[];
    tools_required_list?: any[];
    notes?: any;
    [key: string]: any; // for other dynamic properties
}


export class PlanTaskManager {
    private dbService: DatabaseService;

    constructor(dbService: DatabaseService) {
        this.dbService = dbService;
    }

    async createPlanWithTasks(
        agent_id: string,
        planData: { title: string; overall_goal?: string; status?: string; version?: number; refined_prompt_id_associated?: string; analysis_report_id_referenced?: string; metadata?: any },
        tasksData: Array<{
            task_number: number;
            title: string;
            description?: string;
            status?: string;
            purpose?: string;
            action_description?: string;
            files_involved_json?: string[] | string;
            dependencies_task_ids_json?: string[] | string;
            tools_required_list_json?: string[] | string;
            inputs_summary?: string;
            outputs_summary?: string;
            success_criteria_text?: string;
            estimated_effort_hours?: number;
            assigned_to?: string;
            verification_method?: string;
            code_content?: string;
            phase?: string;
            notes?: any;
            [key: string]: any;
        }>
    ): Promise<{ plan_id: string; task_ids: string[] }> {
        const db = this.dbService.getDb();
        const plan_id = randomUUID();
        const timestamp = Date.now();

        // The validation schema name should match what's in schemas object. Let's assume it's 'createTaskPlan'.
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
            const taskTitleToIdMap = new Map<string, string>();
            const processedTasksData = [];

            // First pass: Generate UUIDs and create a title-to-ID map
            for (const task of tasksData) {
                const task_id = randomUUID();
                task_ids.push(task_id);
                if (task.title) {
                    taskTitleToIdMap.set(task.title, task_id);
                }
                processedTasksData.push({ ...task, task_id });
            }

            const taskStmt = await db.prepare(
                `INSERT INTO plan_tasks (
                    task_id, plan_id, agent_id, task_number, title, description, status,
                    purpose, action_description, files_involved_json, dependencies_task_ids_json,
                    tools_required_list_json, inputs_summary, outputs_summary, success_criteria_text,
                    estimated_effort_hours, assigned_to, verification_method, code_content, phase,
                    creation_timestamp_unix, creation_timestamp_iso, last_updated_timestamp_unix, last_updated_timestamp_iso, notes_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            );

            // Second pass: Insert tasks with resolved dependency IDs
            for (const task of processedTasksData) {
                let resolvedDependencyIds: string[] = [];
                if (task.dependencies_task_ids_json && Array.isArray(task.dependencies_task_ids_json)) {
                    resolvedDependencyIds = task.dependencies_task_ids_json
                        .map((title: string) => taskTitleToIdMap.get(title))
                        .filter((id): id is string => !!id);
                }

                await taskStmt.run(
                    task.task_id,
                    plan_id,
                    agent_id,
                    task.task_number,
                    task.title || 'Untitled Task',
                    task.description || null,
                    task.status || 'PLANNED',
                    task.purpose || null,
                    task.action_description || null,
                    task.files_involved_json ? JSON.stringify(task.files_involved_json) : null,
                    resolvedDependencyIds.length > 0 ? JSON.stringify(resolvedDependencyIds) : null,
                    task.tools_required_list_json ? JSON.stringify(task.tools_required_list_json) : null,
                    task.inputs_summary || null,
                    task.outputs_summary || null,
                    task.success_criteria_text || null,
                    task.estimated_effort_hours || null,
                    task.assigned_to || null,
                    task.verification_method || null,
                    task.code_content || null,
                    task.phase || null,
                    timestamp,
                    new Date(timestamp).toISOString(),
                    timestamp,
                    new Date(timestamp).toISOString(),
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

    async getPlan(agent_id: string, plan_id: string): Promise<ParsedPlan | null> {
        const db = this.dbService.getDb();
        const plan: ParsedPlan | undefined = await db.get(
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
        return plan || null;
    }

    async getPlans(agent_id: string, status_filter?: string, limit: number = 100, offset: number = 0): Promise<ParsedPlan[]> {
        const db = this.dbService.getDb();
        let query = `SELECT * FROM plans WHERE agent_id = ?`;
        const params: (string | number)[] = [agent_id];

        if (status_filter) {
            query += ` AND status = ?`;
            params.push(status_filter);
        }

        query += ` ORDER BY creation_timestamp_unix DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const results: ParsedPlan[] = await db.all(query, ...params as any[]);
        return results.map((row) => {
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


    async getPlanTasks(agent_id: string, plan_id: string, status_filter?: string, limit: number = 100, offset: number = 0): Promise<ParsedTask[]> {
        const db = this.dbService.getDb();
        let query = `SELECT * FROM plan_tasks WHERE agent_id = ? AND plan_id = ?`;
        const params: (string | number)[] = [agent_id, plan_id];

        if (status_filter) {
            query += ` AND status = ?`;
            params.push(status_filter);
        }

        query += ` ORDER BY task_number ASC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const results: ParsedTask[] = await db.all(query, ...params as any[]);
        return results.map((row) => {
            const parseJsonSafe = (jsonString: string | null | undefined, fieldName: string, defaultValue: any) => {
                if (jsonString) {
                    try {
                        return JSON.parse(jsonString);
                    } catch (e) {
                        console.error(`Failed to parse ${fieldName} for task ${row.task_id}:`, e);
                        (row as any)[`${fieldName}_parsing_error`] = true;
                        (row as any)[`raw_${fieldName}`] = jsonString;
                        return defaultValue;
                    }
                }
                return defaultValue;
            };

            const files = parseJsonSafe(row.files_involved_json, 'files_involved_json', []);
            const dependencies = parseJsonSafe(row.dependencies_task_ids_json, 'dependencies_task_ids_json', []);
            const tools = parseJsonSafe(row.tools_required_list_json, 'tools_required_list_json', []);
            const notes = parseJsonSafe(row.notes_json, 'notes_json', {});

            (row as any).files_involved_parsed = files;
            (row as any).dependencies_task_ids_parsed = dependencies;
            (row as any).tools_required_list_parsed = tools;
            (row as any).notes_parsed = notes;

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
            files_involved_json?: string[];
            dependencies_task_ids_json?: string[];
            tools_required_list_json?: string[];
            inputs_summary?: string;
            outputs_summary?: string;
            success_criteria_text?: string;
            estimated_effort_hours?: number;
            assigned_to?: string;
            verification_method?: string;
            code_content?: string;
            phase?: string;
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

        Object.entries(updates).forEach(([key, value]) => {
            if (value !== undefined) {
                if (['files_involved_json', 'dependencies_task_ids_json', 'tools_required_list_json', 'notes_json'].includes(key)) {
                    updateFields.push(`${key} = ?`);
                    updateValues.push(value ? JSON.stringify(value) : null);
                } else if (key === 'notes') {
                    // Handle notes object - convert to JSON string for notes_json column
                    updateFields.push('notes_json = ?');
                    updateValues.push(value ? JSON.stringify(value) : null);
                } else {
                    const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase(); // convert camelCase to snake_case for db
                    updateFields.push(`${dbKey} = ?`);
                    updateValues.push(value);
                }
            }
        });

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
            updateFields.push('completion_timestamp_unix = ?');
            updateValues.push(timestamp);
            updateFields.push('completion_timestamp_iso = ?');
            updateValues.push(new Date(timestamp).toISOString());
        } else if (updates.status && !['COMPLETED', 'FAILED'].includes(updates.status) && (task as any).completion_timestamp_unix) {
            updateFields.push('completion_timestamp_unix = ?', 'completion_timestamp_iso = ?');
            updateValues.push(null, null);
        }

        if (updateFields.length <= 2) { // Only timestamp fields added
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

    async getTask(agent_id: string, task_id: string): Promise<ParsedTask | null> {
        const db = this.dbService.getDb();
        const task: ParsedTask | undefined = await db.get(
            `SELECT * FROM plan_tasks WHERE agent_id = ? AND task_id = ?`,
            agent_id, task_id
        );
        if (task) {
            const parseJsonSafe = (jsonString: string, fieldName: string) => {
                if (jsonString) {
                    try {
                        return JSON.parse(jsonString);
                    } catch (e) {
                        console.error(`Failed to parse ${fieldName} for task ${task.task_id}:`, e);
                        (task as any)[`${fieldName}_parsing_error`] = true;
                        (task as any)[`raw_${fieldName}`] = jsonString;
                        return null;
                    }
                }
                return []; // Return empty array for consistency if field is null
            };

            task.files_involved = parseJsonSafe(task.files_involved_json!, 'files_involved_json');
            task.dependencies_task_ids = parseJsonSafe(task.dependencies_task_ids_json!, 'dependencies_task_ids_json');
            task.tools_required_list = parseJsonSafe(task.tools_required_list_json!, 'tools_required_list_json');
            task.notes = parseJsonSafe(task.notes_json!, 'notes_json');
        }
        return task || null;
    }

    async addTaskToPlan(
        agent_id: string,
        plan_id: string,
        taskData: { task_number: number; title: string; description?: string; status?: string; purpose?: string; action_description?: string; files_involved_json?: string[]; dependencies_task_ids_json?: string[]; tools_required_list_json?: string[]; inputs_summary?: string; outputs_summary?: string; success_criteria_text?: string; estimated_effort_hours?: number; assigned_to?: string; verification_method?: string; code_content?: string; phase?: string; notes?: any }
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
                    estimated_effort_hours, assigned_to, verification_method, code_content, phase,
                    creation_timestamp_unix, creation_timestamp_iso, last_updated_timestamp_unix, last_updated_timestamp_iso, notes_json
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
                taskData.files_involved_json ? JSON.stringify(taskData.files_involved_json) : null,
                taskData.dependencies_task_ids_json ? JSON.stringify(taskData.dependencies_task_ids_json) : null,
                taskData.tools_required_list_json ? JSON.stringify(taskData.tools_required_list_json) : null,
                taskData.inputs_summary || null,
                taskData.outputs_summary || null,
                taskData.success_criteria_text || null,
                taskData.estimated_effort_hours || null,
                taskData.assigned_to || null,
                taskData.verification_method || null,
                taskData.code_content || null,
                taskData.phase || null,
                timestamp,
                new Date(timestamp).toISOString(),
                timestamp,
                new Date(timestamp).toISOString(),
                taskData.notes ? JSON.stringify(taskData.notes) : null
            );
            return task_id;
        } catch (error) {
            console.error(`Error adding task to plan ${plan_id}:`, error);
            throw error;
        }
    }
}
