import { randomUUID } from 'crypto';
import { DatabaseService } from '../services/DatabaseService.js';
import { validate, schemas } from '../../utils/validation.js';

export class SubtaskManager {
    private dbService: DatabaseService;

    constructor(dbService: DatabaseService) {
        this.dbService = dbService;
    }

    async createSubtask(
        agent_id: string,
        plan_id: string,
        subtaskData: { title: string; parent_task_id?: string; description?: string; status?: string; notes?: any }
    ): Promise<string> {
        const db = this.dbService.getDb();
        const subtask_id = randomUUID();
        const timestamp = Date.now();

        // TODO: Add validation for createSubtask schema

        await db.run('BEGIN TRANSACTION');
        try {
            // Ensure the plan exists
            const plan = await db.get(`SELECT plan_id FROM plans WHERE plan_id = ? AND agent_id = ?`, plan_id, agent_id);
            if (!plan) {
                throw new Error(`Plan with ID ${plan_id} not found for agent ${agent_id}.`);
            }

            // If parent_task_id is provided, ensure the parent task exists and belongs to the plan
            if (subtaskData.parent_task_id) {
                const parentTask = await db.get(
                    `SELECT task_id FROM plan_tasks WHERE task_id = ? AND plan_id = ? AND agent_id = ?`,
                    subtaskData.parent_task_id, plan_id, agent_id
                );
                if (!parentTask) {
                    throw new Error(`Parent task with ID ${subtaskData.parent_task_id} not found in plan ${plan_id} for agent ${agent_id}.`);
                }
            }

            await db.run(
                `INSERT INTO subtasks (
                    subtask_id, plan_id, parent_task_id, agent_id, title, description, status,
                    creation_timestamp, last_updated_timestamp, completion_timestamp, notes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                subtask_id,
                plan_id,
                (subtaskData.parent_task_id === undefined || subtaskData.parent_task_id === '') ? null : subtaskData.parent_task_id,
                agent_id,
                subtaskData.title,
                subtaskData.description || null,
                subtaskData.status || 'PLANNED',
                timestamp,
                timestamp,
                subtaskData.status === 'COMPLETED' || subtaskData.status === 'FAILED' ? timestamp : null,
                subtaskData.notes ? JSON.stringify(subtaskData.notes) : null
            );
            await db.run('COMMIT');
            return subtask_id;
        } catch (error) {
            await db.run('ROLLBACK');
            console.error('Error creating subtask:', error);
            throw error;
        }
    }

    async getSubtask(agent_id: string, subtask_id: string): Promise<object | null> {
        const db = this.dbService.getDb();
        const subtask = await db.get(
            `SELECT * FROM subtasks WHERE agent_id = ? AND subtask_id = ?`,
            agent_id, subtask_id
        );
        if (subtask && subtask.notes) {
            subtask.notes = JSON.parse(subtask.notes);
        }
        return subtask;
    }

    async getSubtasksByPlan(agent_id: string, plan_id: string, status_filter?: string, limit: number = 100, offset: number = 0): Promise<object[]> {
        const db = this.dbService.getDb();
        let query = `SELECT * FROM subtasks WHERE agent_id = ? AND plan_id = ?`;
        const params: (string | number)[] = [agent_id, plan_id];

        if (status_filter) {
            query += ` AND status = ?`;
            params.push(status_filter);
        }

        query += ` ORDER BY creation_timestamp ASC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const results = await db.all(query, ...params as any[]);
        return results.map((row: any) => {
            if (row.notes) {
                row.notes = JSON.parse(row.notes);
            }
            return row;
        });
    }

    async getSubtasksByParentTask(agent_id: string, parent_task_id: string, status_filter?: string, limit: number = 100, offset: number = 0): Promise<object[]> {
        const db = this.dbService.getDb();
        let query = `SELECT * FROM subtasks WHERE agent_id = ? AND parent_task_id = ?`;
        const params: (string | number)[] = [agent_id, parent_task_id];

        if (status_filter) {
            query += ` AND status = ?`;
            params.push(status_filter);
        }

        query += ` ORDER BY creation_timestamp ASC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const results = await db.all(query, ...params as any[]);
        return results.map((row: any) => {
            if (row.notes) {
                row.notes = JSON.parse(row.notes);
            }
            return row;
        });
    }

    async getSubtasksByPlanAndParentTask(agent_id: string, plan_id: string, parent_task_id: string, status_filter?: string, limit: number = 100, offset: number = 0): Promise<object[]> {
        const db = this.dbService.getDb();
        let query = `SELECT * FROM subtasks WHERE agent_id = ? AND plan_id = ? AND parent_task_id = ?`;
        const params: (string | number)[] = [agent_id, plan_id, parent_task_id];

        if (status_filter) {
            query += ` AND status = ?`;
            params.push(status_filter);
        }

        query += ` ORDER BY creation_timestamp ASC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const results = await db.all(query, ...params as any[]);
        return results.map((row: any) => {
            if (row.notes) {
                row.notes = JSON.parse(row.notes);
            }
            return row;
        });
    }

    async updateSubtaskStatus(agent_id: string, subtask_id: string, new_status: string, completion_timestamp?: number): Promise<boolean> {
        const db = this.dbService.getDb();
        const timestamp = Date.now();
        const result = await db.run(
            `UPDATE subtasks SET status = ?, last_updated_timestamp = ?, completion_timestamp = ? WHERE agent_id = ? AND subtask_id = ?`,
            new_status, timestamp, completion_timestamp || null, agent_id, subtask_id
        );
        return (result?.changes || 0) > 0;
    }

    async deleteSubtask(agent_id: string, subtask_id: string): Promise<boolean> {
        const db = this.dbService.getDb();
        const result = await db.run(
            `DELETE FROM subtasks WHERE agent_id = ? AND subtask_id = ?`,
            agent_id, subtask_id
        );
        return (result?.changes || 0) > 0;
    }
}
