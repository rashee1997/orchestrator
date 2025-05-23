import { randomUUID } from 'crypto';
import { DatabaseService } from '../services/DatabaseService.js';

export class SuccessMetricsManager {
    private dbService: DatabaseService;

    constructor(dbService: DatabaseService) {
        this.dbService = dbService;
    }

    async logSuccessMetric(
        agent_id: string,
        metric_name: string,
        metric_value: number,
        unit: string | null = null,
        associated_task_id: string | null = null,
        metadata: any | null = null // Will be JSON stringified
    ) {
        const db = this.dbService.getDb();
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
        const db = this.dbService.getDb();
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
}
