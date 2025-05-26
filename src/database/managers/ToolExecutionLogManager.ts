import { randomUUID } from 'crypto';
import { DatabaseService } from '../services/DatabaseService.js';
import { ToolExecutionLog } from '../../types/index.js';

export class ToolExecutionLogManager {
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  public async createToolExecutionLog(log: Omit<ToolExecutionLog, 'log_id' | 'log_creation_timestamp_unix' | 'log_creation_timestamp_iso' | 'last_updated_timestamp_unix' | 'last_updated_timestamp_iso'>): Promise<string> {
    const log_id = randomUUID(); 
    const creation_timestamp_unix = Date.now(); // Single timestamp for creation
    const creation_timestamp_iso = new Date(creation_timestamp_unix).toISOString();
    // For a new log, last_updated is the same as creation
    const last_updated_timestamp_unix = creation_timestamp_unix;
    const last_updated_timestamp_iso = creation_timestamp_iso;

    const query = `INSERT INTO tool_execution_logs (
      log_id,
      agent_id,
      plan_id,
      task_id,
      subtask_id,
      tool_name,
      arguments_json,
      status,
      output_summary,
      execution_start_timestamp_unix,
      execution_start_timestamp_iso,
      execution_end_timestamp_unix,
      execution_end_timestamp_iso,
      duration_ms,
      step_number_executed,
      plan_step_title,
      log_creation_timestamp_unix,
      log_creation_timestamp_iso,
      last_updated_timestamp_unix,
      last_updated_timestamp_iso
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const params = [
      log_id, 
      log.agent_id,
      log.plan_id,
      log.task_id,
      log.subtask_id,
      log.tool_name,
      typeof log.arguments_json === 'string' ? log.arguments_json : JSON.stringify(log.arguments_json),
      log.status,
      log.output_summary,
      log.execution_start_timestamp_unix,
      log.execution_start_timestamp_iso,
      log.execution_end_timestamp_unix,
      log.execution_end_timestamp_iso,
      log.duration_ms,
      log.step_number_executed,
      log.plan_step_title,
      creation_timestamp_unix, // Use single creation timestamp
      creation_timestamp_iso,  // Use single creation timestamp
      last_updated_timestamp_unix,
      last_updated_timestamp_iso
    ];
    await this.db.getDb().run(query, params);
    return log_id;
  }

  private parseArgumentsJson(log: any): any {
    if (log && typeof log.arguments_json === 'string') {
        try {
            log.arguments_parsed = JSON.parse(log.arguments_json);
        } catch (e) {
            console.error(`Failed to parse arguments_json for log_id ${log.log_id}:`, e);
            log.arguments_parsed = null; 
            log.arguments_json_parsing_error = true;
        }
    } else if (log) {
        log.arguments_parsed = null; 
    }
    return log;
  }

  public async getToolExecutionLogById(logId: string): Promise<ToolExecutionLog | null> {
    const query = `SELECT * FROM tool_execution_logs WHERE log_id = ?`;
    const row: ToolExecutionLog | undefined = await this.db.getDb().get(query, [logId]);
    if (row) {
      return this.parseArgumentsJson(row);
    }
    return null;
  }

  public async getToolExecutionLogsByAgentId(agentId: string, limit: number = 100, offset: number = 0): Promise<ToolExecutionLog[]> {
    const query = `SELECT * FROM tool_execution_logs WHERE agent_id = ? ORDER BY log_creation_timestamp_unix DESC LIMIT ? OFFSET ?`;
    const rows: ToolExecutionLog[] = await this.db.getDb().all(query, [agentId, limit, offset]);
    return rows.map(row => this.parseArgumentsJson(row));
  }

  public async updateToolExecutionLogStatus(
    logId: string,
    newStatus: string,
    outputSummary?: string,
    execution_end_timestamp_unix?: number,
    execution_end_timestamp_iso?: string, // This should ideally be derived from execution_end_timestamp_unix
    duration_ms?: number
  ): Promise<void> {
    // Standardize last_updated timestamp generation
    const current_timestamp_unix = Date.now();
    const current_timestamp_iso = new Date(current_timestamp_unix).toISOString();
    
    let query = `UPDATE tool_execution_logs SET status = ?, last_updated_timestamp_unix = ?, last_updated_timestamp_iso = ?`;
    const params: (string | number | null)[] = [
      newStatus,
      current_timestamp_unix,
      current_timestamp_iso
    ];

    if (outputSummary !== undefined) {
      query += `, output_summary = ?`;
      params.push(outputSummary);
    }

    // If execution_end_timestamp_unix is provided, derive execution_end_timestamp_iso from it
    // to ensure consistency, rather than accepting a separate ISO string.
    if (execution_end_timestamp_unix !== undefined) {
      query += `, execution_end_timestamp_unix = ?`;
      params.push(execution_end_timestamp_unix);
      // Derive ISO from the provided Unix timestamp
      query += `, execution_end_timestamp_iso = ?`;
      params.push(new Date(execution_end_timestamp_unix).toISOString());
    } else if (execution_end_timestamp_iso !== undefined && execution_end_timestamp_unix === undefined) {
        // Parse ISO to unix timestamp
        const parsedUnix = new Date(execution_end_timestamp_iso).getTime();
        if (!isNaN(parsedUnix)) {
            query += `, execution_end_timestamp_unix = ?, execution_end_timestamp_iso = ?`;
            params.push(parsedUnix, execution_end_timestamp_iso);
        }
     }


    if (duration_ms !== undefined) {
      query += `, duration_ms = ?`;
      params.push(duration_ms);
    }

    query += ` WHERE log_id = ?`;
    params.push(logId);

    await this.db.getDb().run(query, params);
  }

  public async deleteToolExecutionLog(logId: string): Promise<void> {
    const query = `DELETE FROM tool_execution_logs WHERE log_id = ?`;
    await this.db.getDb().run(query, [logId]);
  }
}
