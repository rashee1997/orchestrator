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

    async createSubtasks(
        agent_id: string,
        plan_id: string,
        subtasksData: { title: string; parent_task_id?: string; description?: string; status?: string; notes?: any }[]
    ): Promise<string[]> {
        const db = this.dbService.getDb();
        const timestamp = Date.now();
        const createdSubtaskIds: string[] = [];

        try {
            await db.run('BEGIN TRANSACTION');

            const plan = await db.get(`SELECT plan_id FROM plans WHERE plan_id = ? AND agent_id = ?`, plan_id, agent_id);
            if (!plan) {
                throw new Error(`Plan with ID ${plan_id} not found for agent ${agent_id}.`);
            }

            for (const subtaskData of subtasksData) {
                if (subtaskData.parent_task_id) {
                    const parentTask = await db.get(
                        `SELECT task_id FROM plan_tasks WHERE task_id = ? AND plan_id = ? AND agent_id = ?`,
                        subtaskData.parent_task_id, plan_id, agent_id
                    );
                    if (!parentTask) {
                        throw new Error(`Parent task with ID ${subtaskData.parent_task_id} not found in plan ${plan_id} for agent ${agent_id}.`);
                    }
                }

                const subtask_id = randomUUID();

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

                createdSubtaskIds.push(subtask_id);
            }

            await db.run('COMMIT');
            return createdSubtaskIds;
        } catch (error) {
            await db.run('ROLLBACK');
            console.error('Error creating subtasks, transaction rolled back:', error);
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

    async updateSubtaskDetails(
        agent_id: string,
        subtask_id: string,
        updates: {
            title?: string;
            description?: string;
            status?: string;
            notes?: any;
        },
        completion_timestamp?: number
    ): Promise<boolean> {
        const db = this.dbService.getDb();
        const timestamp = Date.now();

        const subtask = await this.getSubtask(agent_id, subtask_id);
        if (!subtask) {
            console.warn(`Attempted to update non-existent subtask: ${subtask_id} for agent: ${agent_id}`);
            return false;
        }

        let updateFields: string[] = [];
        let updateValues: any[] = [];

        if (updates.title !== undefined) { updateFields.push('title = ?'); updateValues.push(updates.title); }
        if (updates.description !== undefined) { updateFields.push('description = ?'); updateValues.push(updates.description); }
        if (updates.status !== undefined) { updateFields.push('status = ?'); updateValues.push(updates.status); }
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
        } else if (updates.status !== 'COMPLETED' && updates.status !== 'FAILED' && (subtask as any).completion_timestamp_unix) {
            // If status is changed from completed/failed to something else, clear completion timestamp
            updateFields.push('completion_timestamp_unix = ?');
            updateValues.push(null);
            updateFields.push('completion_timestamp_iso = ?');
            updateValues.push(null);
        }

        if (updateFields.length === 0) {
            console.warn(`No fields provided for updateSubtaskDetails for subtask: ${subtask_id}`);
            return false;
        }

        const query = `UPDATE subtasks SET ${updateFields.join(', ')} WHERE agent_id = ? AND subtask_id = ?`;
        updateValues.push(agent_id, subtask_id);

        const result = await db.run(query, ...updateValues);
        return (result?.changes || 0) > 0;
    }

    async deleteSubtasks(agent_id: string, subtask_ids: string[]): Promise<boolean> {
        const db = this.dbService.getDb();
        if (subtask_ids.length === 0) {
            return false;
        }
        const placeholders = subtask_ids.map(() => '?').join(',');
        const result = await db.run(
            `DELETE FROM subtasks WHERE agent_id = ? AND subtask_id IN (${placeholders})`,
            agent_id, ...subtask_ids
        );
        return (result?.changes || 0) > 0;
    }
}
