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

        // Validate input against the createTaskPlan schema
        const validationResult = validate('createTaskPlan', { agent_id, planData, tasksData });
        if (!validationResult.valid) {
            console.error('Validation errors for createPlanWithTasks:', validationResult.errors);
            throw new Error(`Invalid input for createPlanWithTasks: ${JSON.stringify(validationResult.errors)}`);
        }

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
        const db = this.dbService.getDb();
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
        const db = this.dbService.getDb();
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
            if (row.files_involved) row.files_involved = JSON.parse(row.files_involved);
            if (row.dependencies_task_ids) row.dependencies_task_ids = JSON.parse(row.dependencies_task_ids);
            if (row.tools_required_list) row.tools_required_list = JSON.parse(row.tools_required_list);
            if (row.notes) row.notes = JSON.parse(row.notes);
            return row;
        });
    }

    async updatePlanStatus(agent_id: string, plan_id: string, new_status: string): Promise<boolean> {
        const db = this.dbService.getDb();
        const timestamp = Date.now();
        const result = await db.run(
            `UPDATE plans SET status = ?, last_updated_timestamp = ? WHERE agent_id = ? AND plan_id = ?`,
            new_status, timestamp, agent_id, plan_id
        );
        return (result?.changes || 0) > 0;
    }

    async updateTaskStatus(agent_id: string, task_id: string, new_status: string, completion_timestamp?: number): Promise<boolean> {
        const db = this.dbService.getDb();
        const timestamp = Date.now();

        // First, retrieve the task to ensure it exists and get its plan_id
        const task = await this.getTask(agent_id, task_id);
        if (!task) {
            console.warn(`Attempted to update non-existent task: ${task_id} for agent: ${agent_id}`);
            return false; // Task not found
        }

        // Ensure the task's plan still exists
        const plan = await this.getPlan(agent_id, (task as any).plan_id);
        if (!plan) {
            console.warn(`Attempted to update task ${task_id} whose associated plan ${((task as any).plan_id)} does not exist for agent: ${agent_id}`);
            return false; // Associated plan not found
        }

        const result = await db.run(
            `UPDATE plan_tasks SET status = ?, last_updated_timestamp = ?, completion_timestamp = ? WHERE agent_id = ? AND task_id = ?`,
            new_status, timestamp, completion_timestamp || null, agent_id, task_id
        );
        return (result?.changes || 0) > 0;
    }

    async deletePlan(agent_id: string, plan_id: string): Promise<boolean> {
        const db = this.dbService.getDb();
        const result = await db.run(
            `DELETE FROM plans WHERE agent_id = ? AND plan_id = ?`,
            agent_id, plan_id
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
            if (task.files_involved) task.files_involved = JSON.parse(task.files_involved);
            if (task.dependencies_task_ids) task.dependencies_task_ids = JSON.parse(task.dependencies_task_ids);
            if (task.tools_required_list) task.tools_required_list = JSON.parse(task.tools_required_list);
            if (task.notes) task.notes = JSON.parse(task.notes);
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

        // Validate input against the addTaskToPlan schema
        const validationResult = validate('addTaskToPlan', { agent_id, plan_id, taskData });
        if (!validationResult.valid) {
            console.error('Validation errors for addTaskToPlan:', validationResult.errors);
            throw new Error(`Invalid input for addTaskToPlan: ${JSON.stringify(validationResult.errors)}`);
        }

        // Ensure the plan exists
        const plan = await this.getPlan(agent_id, plan_id);
        if (!plan) {
            throw new Error(`Plan with ID ${plan_id} not found for agent ${agent_id}.`);
        }

        const task_id = randomUUID();

        await db.run(
            `INSERT INTO plan_tasks (
                task_id, plan_id, agent_id, task_number, title, description, status,
                purpose, action_description, files_involved, dependencies_task_ids,
                tools_required_list, inputs_summary, outputs_summary, success_criteria_text,
                estimated_effort_hours, assigned_to, verification_method,
                creation_timestamp, last_updated_timestamp, completion_timestamp, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            timestamp,
            taskData.status === 'COMPLETED' || taskData.status === 'FAILED' ? timestamp : null,
            taskData.notes ? JSON.stringify(taskData.notes) : null
        );

        return task_id;
    }
}
