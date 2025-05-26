export interface ToolExecutionLog {
  log_id: string;
  agent_id: string;
  plan_id: string | null;
  task_id: string | null;
  subtask_id: string | null;
  tool_name: string;
  arguments_json: string;
  status: string;
  output_summary: string | null;
  execution_start_timestamp_unix: number;
  execution_start_timestamp_iso: string;
  execution_end_timestamp_unix: number | null;
  execution_end_timestamp_iso: string | null;
  duration_ms: number | null;
  step_number_executed: string | null;
  plan_step_title: string | null;
  log_creation_timestamp_unix: number;
  log_creation_timestamp_iso: string;
  last_updated_timestamp_unix: number;
  last_updated_timestamp_iso: string;
}

export interface TaskProgressLog {
  progress_log_id: string;
  agent_id: string;
  associated_plan_id: string;
  associated_task_id: string;
  associated_subtask_id: string | null;
  step_number_executed: string | null;
  plan_step_title: string | null;
  action_tool_used: string | null;
  tool_parameters_summary_json: string | null;
  files_modified_list_json: string | null;
  change_summary_text: string | null;
  execution_timestamp_unix: number;
  execution_timestamp_iso: string;
  status_of_step_execution: string;
  output_summary_or_error: string | null;
  log_creation_timestamp_unix: number;
  log_creation_timestamp_iso: string;
  last_updated_timestamp_unix: number;
  last_updated_timestamp_iso: string;
}

export interface ErrorLog {
  error_log_id: string;
  agent_id: string;
  associated_plan_id: string | null;
  associated_task_id: string | null;
  associated_subtask_id: string | null;
  associated_tool_execution_log_id: string | null;
  error_type: string;
  error_message: string;
  stack_trace: string | null;
  source_file: string | null;
  source_line: number | null;
  severity: string;
  status: string;
  resolution_details: string | null;
  error_timestamp_unix: number;
  error_timestamp_iso: string;
  log_creation_timestamp_unix: number;
  log_creation_timestamp_iso: string;
  last_updated_timestamp_unix: number;
  last_updated_timestamp_iso: string;
}

export interface CorrectionLog {
  correction_id: string;
  agent_id: string;
  correction_type: string;
  original_entry_id: string | null;
  original_value_json: string | null;
  corrected_value_json: string | null;
  reason: string | null;
  correction_summary: string | null;
  applied_automatically: boolean;
  creation_timestamp_unix: number;
  creation_timestamp_iso: string;
  last_updated_timestamp_unix: number;
  last_updated_timestamp_iso: string;
  status: string;
}
