import { randomUUID } from 'crypto';
import { DatabaseService } from '../services/DatabaseService.js';
import { ErrorLog } from '../../types/index.js';

export class ErrorLogManager {
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  public async createErrorLog(log: Omit<ErrorLog, 'error_log_id' | 'log_creation_timestamp_unix' | 'log_creation_timestamp_iso' | 'last_updated_timestamp_unix' | 'last_updated_timestamp_iso'>): Promise<string> {
    const error_log_id = randomUUID(); // Generate UUID for error_log_id
    const log_creation_timestamp_unix = Date.now();
    const log_creation_timestamp_iso = new Date(log_creation_timestamp_unix).toISOString();
    const last_updated_timestamp_unix = log_creation_timestamp_unix;
    const last_updated_timestamp_iso = log_creation_timestamp_iso;

    const query = `INSERT INTO error_logs (
      error_log_id,
      agent_id,
      associated_plan_id,
      associated_task_id,
      associated_subtask_id,
      associated_tool_execution_log_id,
      error_type,
      error_message,
      stack_trace,
      source_file,
      source_line,
      severity,
      status,
      resolution_details,
      error_timestamp_unix,
      error_timestamp_iso,
      log_creation_timestamp_unix,
      log_creation_timestamp_iso,
      last_updated_timestamp_unix,
      last_updated_timestamp_iso
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const params = [
      error_log_id, // Use the generated UUID
      log.agent_id,
      log.associated_plan_id,
      log.associated_task_id,
      log.associated_subtask_id,
      log.associated_tool_execution_log_id,
      log.error_type,
      log.error_message,
      log.stack_trace,
      log.source_file,
      log.source_line,
      log.severity,
      log.status,
      log.resolution_details,
      log.error_timestamp_unix,
      log.error_timestamp_iso,
      log_creation_timestamp_unix,
      log_creation_timestamp_iso,
      last_updated_timestamp_unix,
      last_updated_timestamp_iso
    ];
    await this.db.getDb().run(query, params);
    return error_log_id; // Return the generated UUID
  }

  public async getErrorLogById(logId: string): Promise<ErrorLog | null> {
    const query = `SELECT * FROM error_logs WHERE error_log_id = ?`;
    const row: ErrorLog | undefined = await this.db.getDb().get(query, [logId]);
    if (row) {
      return row;
    }
    return null;
  }

  public async getErrorLogsByAgentId(agentId: string, limit: number = 100, offset: number = 0): Promise<ErrorLog[]> {
    const query = `SELECT * FROM error_logs WHERE agent_id = ? LIMIT ? OFFSET ?`;
    const rows: ErrorLog[] = await this.db.getDb().all(query, [agentId, limit, offset]);
    return rows;
  }

  public async updateErrorLogStatus(
    errorLogId: string,
    newStatus: string,
    resolutionDetails?: string,
    lastUpdatedTimestampUnix?: number,
    lastUpdatedTimestampIso?: string
  ): Promise<void> {
    let query = `UPDATE error_logs SET status = ?, last_updated_timestamp_unix = ?, last_updated_timestamp_iso = ?`;
    const params: (string | number | null)[] = [
      newStatus,
      lastUpdatedTimestampUnix || Date.now(),
      lastUpdatedTimestampIso || new Date(Date.now()).toISOString()
    ];

    if (resolutionDetails !== undefined) {
      query += `, resolution_details = ?`;
      params.push(resolutionDetails);
    }

    query += ` WHERE error_log_id = ?`;
    params.push(errorLogId);

    await this.db.getDb().run(query, params);
  }

  public async deleteErrorLog(logId: string): Promise<void> {
    const query = `DELETE FROM error_logs WHERE error_log_id = ?`;
    await this.db.getDb().run(query, [logId]);
  }
}
