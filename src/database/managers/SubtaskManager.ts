import { randomUUID } from 'crypto';
import { DatabaseService } from '../services/DatabaseService.js';
import { validate, schemas } from '../../utils/validation.js'; // Assuming validation might be added later

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

        try {
            await db.run('BEGIN TRANSACTION'); 

            const plan = await db.get(`SELECT plan_id FROM plans WHERE plan_id = ? AND agent_id = ?`, plan_id, agent_id);
            if (!plan) {
                throw new Error(`Plan with ID ${plan_id} not found for agent ${agent_id}.`);
            }

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
                    creation_timestamp_unix, creation_timestamp_iso, last_updated_timestamp_unix, last_updated_timestamp_iso, completion_timestamp_unix, completion_timestamp_iso, notes_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                subtask_id,
                plan_id,
                (subtaskData.parent_task_id === undefined || subtaskData.parent_task_id === '') ? null : subtaskData.parent_task_id,
                agent_id,
                subtaskData.title,
                subtaskData.description || null,
                subtaskData.status || 'PLANNED',
                timestamp,
                new Date(timestamp).toISOString(),
                timestamp,
                new Date(timestamp).toISOString(),
                subtaskData.status === 'COMPLETED' || subtaskData.status === 'FAILED' ? timestamp : null,
                subtaskData.status === 'COMPLETED' || subtaskData.status === 'FAILED' ? new Date(timestamp).toISOString() : null,
                subtaskData.notes ? JSON.stringify(subtaskData.notes) : null
            );

            await db.run('COMMIT'); 
            return subtask_id;
        } catch (error) {
            await db.run('ROLLBACK'); 
            console.error('Error creating subtask, transaction rolled back:', error);
            throw error;
        }
    }

    async getSubtask(agent_id: string, subtask_id: string): Promise<object | null> {
        const db = this.dbService.getDb();
        const subtask = await db.get(
            `SELECT * FROM subtasks WHERE agent_id = ? AND subtask_id = ?`,
            agent_id, subtask_id
        );
        if (subtask && subtask.notes_json) {
            try {
                subtask.notes = JSON.parse(subtask.notes_json);
            } catch (e) {
                console.error(`Failed to parse notes_json for subtask ${subtask_id}:`, e);
                subtask.notes = null; 
                subtask.notes_json_parsing_error = true;
                subtask.raw_notes_json = subtask.notes_json;
            }
        } else if (subtask) {
            subtask.notes = null;
        }
        return subtask;
    }

    private parseNotes(row: any): any {
        if (row.notes_json) {
            try {
                row.notes = JSON.parse(row.notes_json);
            } catch (e) {
                console.error(`Failed to parse notes_json for subtask ${row.subtask_id}:`, e);
                row.notes = null;
                row.notes_json_parsing_error = true;
                row.raw_notes_json = row.notes_json;
            }
        } else {
            row.notes = null;
        }
        return row;
    }

    async getSubtasksByPlan(agent_id: string, plan_id: string, status_filter?: string, limit: number = 100, offset: number = 0): Promise<object[]> {
        const db = this.dbService.getDb();
        let query = `SELECT * FROM subtasks WHERE agent_id = ? AND plan_id = ?`;
        const params: (string | number)[] = [agent_id, plan_id];

        if (status_filter) {
            query += ` AND status = ?`;
            params.push(status_filter);
        }

        query += ` ORDER BY creation_timestamp_unix ASC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const results = await db.all(query, ...params as any[]);
        return results.map(row => this.parseNotes(row));
    }

    async getSubtasksByParentTask(agent_id: string, parent_task_id: string, status_filter?: string, limit: number = 100, offset: number = 0): Promise<object[]> {
        const db = this.dbService.getDb();
        let query = `SELECT * FROM subtasks WHERE agent_id = ? AND parent_task_id = ?`;
        const params: (string | number)[] = [agent_id, parent_task_id];

        if (status_filter) {
            query += ` AND status = ?`;
            params.push(status_filter);
        }

        query += ` ORDER BY creation_timestamp_unix ASC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const results = await db.all(query, ...params as any[]);
        return results.map(row => this.parseNotes(row));
    }

    async getSubtasksByPlanAndParentTask(agent_id: string, plan_id: string, parent_task_id: string, status_filter?: string, limit: number = 100, offset: number = 0): Promise<object[]> {
        const db = this.dbService.getDb();
        let query = `SELECT * FROM subtasks WHERE agent_id = ? AND plan_id = ? AND parent_task_id = ?`;
        const params: (string | number)[] = [agent_id, plan_id, parent_task_id];

        if (status_filter) {
            query += ` AND status = ?`;
            params.push(status_filter);
        }

        query += ` ORDER BY creation_timestamp_unix ASC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const results = await db.all(query, ...params as any[]);
        return results.map(row => this.parseNotes(row));
    }

    async updateSubtaskStatus(agent_id: string, subtask_id: string, new_status: string, completion_timestamp?: number): Promise<boolean> {
        const db = this.dbService.getDb();
        const timestamp = Date.now();
        const result = await db.run(
            `UPDATE subtasks SET status = ?, last_updated_timestamp_unix = ?, last_updated_timestamp_iso = ?, completion_timestamp_unix = ?, completion_timestamp_iso = ? WHERE agent_id = ? AND subtask_id = ?`,
            new_status, timestamp, new Date(timestamp).toISOString(), completion_timestamp || null, completion_timestamp ? new Date(completion_timestamp).toISOString() : null, agent_id, subtask_id
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
