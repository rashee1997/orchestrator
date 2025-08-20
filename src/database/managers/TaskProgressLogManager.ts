import { randomUUID } from 'crypto';
import { DatabaseService } from '../services/DatabaseService.js';
import { TaskProgressLog } from '../../types/index.js';

// NEW: Define a type for the log after JSON fields have been parsed.
export type ParsedTaskProgressLog = TaskProgressLog & {
  tool_parameters_summary_parsed?: any;
  files_modified_list_parsed?: any;
  tool_parameters_summary_json_parsing_error?: boolean;
  files_modified_list_json_parsing_error?: boolean;
};

export class TaskProgressLogManager {
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  public async createTaskProgressLog(log: Omit<TaskProgressLog, 'progress_log_id' | 'execution_timestamp_unix' | 'execution_timestamp_iso' | 'log_creation_timestamp_unix' | 'log_creation_timestamp_iso' | 'last_updated_timestamp_unix' | 'last_updated_timestamp_iso'>): Promise<string> {
    const progress_log_id = randomUUID();
    const now = Date.now();
    const isoNow = new Date(now).toISOString();

    const query = `INSERT INTO task_progress_logs (
      progress_log_id,
      agent_id,
      associated_plan_id,
      associated_task_id,
      associated_subtask_id,
      step_number_executed,
      plan_step_title,
      action_tool_used,
      tool_parameters_summary_json,
      files_modified_list_json,
      change_summary_text,
      execution_timestamp_unix,
      execution_timestamp_iso,
      status_of_step_execution,
      output_summary_or_error,
      log_creation_timestamp_unix,
      log_creation_timestamp_iso,
      last_updated_timestamp_unix,
      last_updated_timestamp_iso
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const params = [
      progress_log_id,
      log.agent_id,
      log.associated_plan_id,
      log.associated_task_id,
      log.associated_subtask_id,
      log.step_number_executed,
      log.plan_step_title,
      log.action_tool_used,
      // Ensure JSON fields are stringified if passed as objects
      typeof log.tool_parameters_summary_json === 'string' ? log.tool_parameters_summary_json : JSON.stringify(log.tool_parameters_summary_json),
      typeof log.files_modified_list_json === 'string' ? log.files_modified_list_json : JSON.stringify(log.files_modified_list_json),
      log.change_summary_text,
      now,
      isoNow,
      log.status_of_step_execution,
      log.output_summary_or_error,
      now,
      isoNow,
      now,
      isoNow
    ];
    await this.db.getDb().run(query, params);
    return progress_log_id;
  }

  private parseJsonFields(log: TaskProgressLog): ParsedTaskProgressLog {
    const parsedLog: ParsedTaskProgressLog = { ...log };
    if (parsedLog) {
      // Parse tool_parameters_summary_json
      if (typeof parsedLog.tool_parameters_summary_json === 'string') {
        try {
          parsedLog.tool_parameters_summary_parsed = JSON.parse(parsedLog.tool_parameters_summary_json);
        } catch (e) {
          console.error(`Failed to parse tool_parameters_summary_json for progress_log_id ${parsedLog.progress_log_id}:`, e);
          parsedLog.tool_parameters_summary_parsed = null; // Or {}
          parsedLog.tool_parameters_summary_json_parsing_error = true;
        }
      } else {
        parsedLog.tool_parameters_summary_parsed = null; // Or {}
      }

      // Parse files_modified_list_json
      if (typeof parsedLog.files_modified_list_json === 'string') {
        try {
          parsedLog.files_modified_list_parsed = JSON.parse(parsedLog.files_modified_list_json);
        } catch (e) {
          console.error(`Failed to parse files_modified_list_json for progress_log_id ${parsedLog.progress_log_id}:`, e);
          parsedLog.files_modified_list_parsed = null; // Or []
          parsedLog.files_modified_list_json_parsing_error = true;
        }
      } else {
        parsedLog.files_modified_list_parsed = null; // Or []
      }
    }
    return parsedLog;
  }

  public async getTaskProgressLogById(logId: string): Promise<ParsedTaskProgressLog | null> {
    const query = `SELECT * FROM task_progress_logs WHERE progress_log_id = ?`;
    const row: TaskProgressLog | undefined = await this.db.getDb().get(query, [logId]);
    if (row) {
      return this.parseJsonFields(row);
    }
    return null;
  }

  public async getTaskProgressLogsByAgentId(agentId: string, limit: number = 100, offset: number = 0): Promise<ParsedTaskProgressLog[]> {
    const query = `SELECT * FROM task_progress_logs WHERE agent_id = ? ORDER BY log_creation_timestamp_unix DESC LIMIT ? OFFSET ?`;
    const rows: TaskProgressLog[] = await this.db.getDb().all(query, [agentId, limit, offset]);
    return rows.map(row => this.parseJsonFields(row));
  }

  public async updateTaskProgressLogStatus(logId: string, newStatus: string, outputSummaryOrError?: string): Promise<void> {
    const now = Date.now();
    const isoNow = new Date(now).toISOString();

    let query = `UPDATE task_progress_logs SET status_of_step_execution = ?, last_updated_timestamp_unix = ?, last_updated_timestamp_iso = ?`;
    const params: (string | number)[] = [newStatus, now, isoNow];

    if (outputSummaryOrError !== undefined) {
      query += `, output_summary_or_error = ?`;
      params.push(outputSummaryOrError);
    }

    query += ` WHERE progress_log_id = ?`;
    params.push(logId);

    await this.db.getDb().run(query, params);
  }

  public async deleteTaskProgressLog(logId: string): Promise<void> {
    const query = `DELETE FROM task_progress_logs WHERE progress_log_id = ?`;
    await this.db.getDb().run(query, [logId]);
  }
}
