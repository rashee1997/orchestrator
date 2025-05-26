import { DatabaseService } from '../services/DatabaseService.js';
import { v4 as uuidv4 } from 'uuid';

export class TaskReviewLogManager {
    constructor(private dbService: DatabaseService) {}

    async createTaskReviewLog(data: any) {
        const db = this.dbService.getDb();
        const review_log_id = data.review_log_id || uuidv4();
        const now = Date.now();
        const nowIso = new Date(now).toISOString();
        await db.run(
            `INSERT INTO task_review_logs (
                review_log_id, agent_id, plan_id, task_id, reviewer, review_timestamp_unix, review_timestamp_iso, review_status, review_notes_md, issues_found_json, resolution_notes_md, last_updated_timestamp_unix, last_updated_timestamp_iso
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            review_log_id,
            data.agent_id,
            data.plan_id,
            data.task_id,
            data.reviewer || null,
            data.review_timestamp_unix || now,
            data.review_timestamp_iso || nowIso,
            data.review_status,
            data.review_notes_md || '',
            data.issues_found_json || '[]',
            data.resolution_notes_md || '',
            now,
            nowIso
        );
        return { review_log_id };
    }

    async getTaskReviewLogs(query: { plan_id?: string; task_id?: string; agent_id?: string; review_status?: string }) {
        const db = this.dbService.getDb();
        let sql = 'SELECT * FROM task_review_logs WHERE 1=1';
        const params: any[] = [];
        if (query.plan_id) { sql += ' AND plan_id = ?'; params.push(query.plan_id); }
        if (query.task_id) { sql += ' AND task_id = ?'; params.push(query.task_id); }
        if (query.agent_id) { sql += ' AND agent_id = ?'; params.push(query.agent_id); }
        if (query.review_status) { sql += ' AND review_status = ?'; params.push(query.review_status); }
        sql += ' ORDER BY review_timestamp_unix DESC';
        const rows = await db.all(sql, ...params);
        // Markdown output
        return rows.map(row => `### Task Review Log\n- **Reviewer:** ${row.reviewer || 'N/A'}\n- **Timestamp:** ${row.review_timestamp_iso}\n- **Status:** ${row.review_status}\n- **Notes:**\n${row.review_notes_md}\n- **Issues Found:** ${row.issues_found_json}\n- **Resolution Notes:** ${row.resolution_notes_md}\n`).join('\n---\n');
    }

    async updateTaskReviewLog(review_log_id: string, updates: any) {
        const db = this.dbService.getDb();
        const fields = [];
        const params: any[] = [];
        for (const key of Object.keys(updates)) {
            fields.push(`${key} = ?`);
            params.push(updates[key]);
        }
        params.push(Date.now());
        params.push(new Date().toISOString());
        params.push(review_log_id);
        await db.run(
            `UPDATE task_review_logs SET ${fields.join(', ')}, last_updated_timestamp_unix = ?, last_updated_timestamp_iso = ? WHERE review_log_id = ?`,
            ...params
        );
        return { review_log_id };
    }

    async deleteTaskReviewLog(review_log_id: string) {
        const db = this.dbService.getDb();
        await db.run('DELETE FROM task_review_logs WHERE review_log_id = ?', review_log_id);
        return { review_log_id };
    }
}

export class FinalPlanReviewLogManager {
    constructor(private dbService: DatabaseService) {}

    async createFinalPlanReviewLog(data: any) {
        const db = this.dbService.getDb();
        const final_review_log_id = data.final_review_log_id || uuidv4();
        const now = Date.now();
        const nowIso = new Date(now).toISOString();
        await db.run(
            `INSERT INTO final_plan_review_logs (
                final_review_log_id, agent_id, plan_id, reviewer, review_timestamp_unix, review_timestamp_iso, review_status, review_notes_md, issues_found_json, resolution_notes_md, last_updated_timestamp_unix, last_updated_timestamp_iso
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            final_review_log_id,
            data.agent_id,
            data.plan_id,
            data.reviewer || null,
            data.review_timestamp_unix || now,
            data.review_timestamp_iso || nowIso,
            data.review_status,
            data.review_notes_md || '',
            data.issues_found_json || '[]',
            data.resolution_notes_md || '',
            now,
            nowIso
        );
        return { final_review_log_id };
    }

    async getFinalPlanReviewLogs(query: { plan_id?: string; agent_id?: string; review_status?: string }) {
        const db = this.dbService.getDb();
        let sql = 'SELECT * FROM final_plan_review_logs WHERE 1=1';
        const params: any[] = [];
        if (query.plan_id) { sql += ' AND plan_id = ?'; params.push(query.plan_id); }
        if (query.agent_id) { sql += ' AND agent_id = ?'; params.push(query.agent_id); }
        if (query.review_status) { sql += ' AND review_status = ?'; params.push(query.review_status); }
        sql += ' ORDER BY review_timestamp_unix DESC';
        const rows = await db.all(sql, ...params);
        // Markdown output
        return rows.map(row => `### Final Plan Review Log\n- **Reviewer:** ${row.reviewer || 'N/A'}\n- **Timestamp:** ${row.review_timestamp_iso}\n- **Status:** ${row.review_status}\n- **Notes:**\n${row.review_notes_md}\n- **Issues Found:** ${row.issues_found_json}\n- **Resolution Notes:** ${row.resolution_notes_md}\n`).join('\n---\n');
    }

    async updateFinalPlanReviewLog(final_review_log_id: string, updates: any) {
        const db = this.dbService.getDb();
        const fields = [];
        const params: any[] = [];
        for (const key of Object.keys(updates)) {
            fields.push(`${key} = ?`);
            params.push(updates[key]);
        }
        params.push(Date.now());
        params.push(new Date().toISOString());
        params.push(final_review_log_id);
        await db.run(
            `UPDATE final_plan_review_logs SET ${fields.join(', ')}, last_updated_timestamp_unix = ?, last_updated_timestamp_iso = ? WHERE final_review_log_id = ?`,
            ...params
        );
        return { final_review_log_id };
    }

    async deleteFinalPlanReviewLog(final_review_log_id: string) {
        const db = this.dbService.getDb();
        await db.run('DELETE FROM final_plan_review_logs WHERE final_review_log_id = ?', final_review_log_id);
        return { final_review_log_id };
    }
}
