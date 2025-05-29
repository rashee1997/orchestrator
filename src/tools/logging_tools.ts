import { MemoryManager } from '../database/memory_manager.js';
import { ToolExecutionLog, TaskProgressLog, ErrorLog, CorrectionLog } from '../types/index.js';
import { 
    formatSimpleMessage, 
    formatJsonToMarkdownCodeBlock,
    formatToolExecutionLogToMarkdown,
    formatTaskProgressLogToMarkdown,
    formatErrorLogToMarkdown,
    formatCorrectionLogToMarkdown // Assuming you might add a get_correction_log_by_id
} from '../utils/formatters.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

interface LoggingTool {
    name: string;
    description: string;
    inputSchema: object; // Changed from 'schema' to 'inputSchema'
    call: (args: any) => Promise<any>; 
}

export function log_tool_execution(memory: MemoryManager): LoggingTool {
  return {
    name: 'log_tool_execution',
    description: 'Logs the initiation or completion details of a specific tool execution attempt by the agent. Called before and after a tool runs. Output is Markdown formatted.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
        plan_id: { type: ['string', 'null'], description: 'Optional: Link to the plan if applicable.' },
        task_id: { type: ['string', 'null'], description: 'Optional: Link to the specific task if applicable.' },
        subtask_id: { type: ['string', 'null'], description: 'Optional: Link to the specific subtask if applicable.' },
        tool_name: { type: 'string', description: 'Name of the tool being logged.' },
        arguments_json: { type: ['object', 'string'], description: 'JSON object or string of arguments passed to the tool.' },
        status: { type: 'string', description: 'Updatable: e.g., ATTEMPTING_EXECUTION, EXECUTION_SUCCESS, EXECUTION_FAILURE, RETRYING.' },
        output_summary: { type: ['string', 'null'], description: 'Summary of the tool\'s output or error message.' },
        execution_start_timestamp_unix: { type: 'number', description: 'Unix timestamp of when the execution started.' },
        execution_start_timestamp_iso: { type: 'string', description: 'ISO8601 format of when the execution started.' },
        execution_end_timestamp_unix: { type: ['number', 'null'], description: 'Unix timestamp of when the execution ended.' },
        execution_end_timestamp_iso: { type: ['string', 'null'], description: 'ISO8601 format of when the execution ended.' },
        duration_ms: { type: ['number', 'null'], description: 'Calculated duration in milliseconds.' },
        step_number_executed: { type: ['string', 'null'], description: 'The plan step number being executed (e.g., "2.1").' },
        plan_step_title: { type: ['string', 'null'], description: 'The title of the plan step.' }
      },
      required: ['agent_id', 'tool_name', 'status', 'execution_start_timestamp_unix', 'execution_start_timestamp_iso'],
    },
    async call(args: any) {
      const {
        agent_id, plan_id, task_id, subtask_id, tool_name, arguments_json,
        status, output_summary, execution_start_timestamp_unix, execution_start_timestamp_iso,
        execution_end_timestamp_unix, execution_end_timestamp_iso, duration_ms,
        step_number_executed, plan_step_title
      } = args;

      const final_arguments_json = typeof arguments_json === 'string' ? arguments_json : JSON.stringify(arguments_json);

      const logData: Omit<ToolExecutionLog, 'log_id' | 'log_creation_timestamp_unix' | 'log_creation_timestamp_iso' | 'last_updated_timestamp_unix' | 'last_updated_timestamp_iso'> = {
        agent_id,
        plan_id: plan_id || null,
        task_id: task_id || null,
        subtask_id: subtask_id || null,
        tool_name,
        arguments_json: final_arguments_json,
        status,
        output_summary: output_summary || null,
        execution_start_timestamp_unix,
        execution_start_timestamp_iso,
        execution_end_timestamp_unix: execution_end_timestamp_unix || null,
        execution_end_timestamp_iso: execution_end_timestamp_iso || null,
        duration_ms: duration_ms || null,
        step_number_executed: step_number_executed || null,
        plan_step_title: plan_step_title || null
      };
      const logId = await memory.toolExecutionLogManager.createToolExecutionLog(logData);
      return { content: [{ type: 'text', text: formatSimpleMessage(`Tool execution logged with ID: \`${logId}\``, "Tool Execution Logged") }] };
    }
  };
}

export function get_tool_execution_logs(memory: MemoryManager): LoggingTool {
  return {
    name: 'get_tool_execution_logs',
    description: 'Retrieves historical tool execution logs based on specified filters. Output is Markdown formatted.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
        limit: { type: 'number', default: 100, description: "Maximum number of logs to retrieve." },
        offset: { type: 'number', default: 0, description: "Offset for pagination." },
      },
      required: ['agent_id'],
    },
    async call(args: any) {
      const { agent_id, limit, offset } = args;
      const logs: ToolExecutionLog[] = await memory.toolExecutionLogManager.getToolExecutionLogsByAgentId(agent_id, limit, offset);
      if (logs.length === 0) {
        return { content: [{ type: 'text', text: formatSimpleMessage(`No tool execution logs found for agent ID: \`${agent_id}\``, "Tool Execution Logs") }] };
      }
      let md = `## Tool Execution Logs for Agent: \`${agent_id}\` (Limit: ${limit}, Offset: ${offset})\n\n`;
      logs.forEach(log => {
        md += formatToolExecutionLogToMarkdown(log) + "\n---\n\n";
      });
      return { content: [{ type: 'text', text: md }] };
    }
  };
}

export function update_tool_execution_log_status(memory: MemoryManager): LoggingTool {
  return {
    name: 'update_tool_execution_log_status',
    description: 'Updates the status or outcome of a previously logged tool execution entry. Output is Markdown formatted.',
    inputSchema: {
      type: 'object',
      properties: {
        log_id: { type: 'string', description: 'Unique ID of the tool execution log to update.' },
        new_status: { type: 'string', description: 'The new status for the log entry.' },
        output_summary: { type: ['string', 'null'], description: 'Optional: Updated summary of the tool\'s output or error message.' },
        execution_end_timestamp_unix: { type: ['number', 'null'], description: 'Unix timestamp of when the execution ended.' },
        duration_ms: { type: ['number', 'null'], description: 'Calculated duration in milliseconds.' }
      },
      required: ['log_id', 'new_status'],
    },
    async call(args: any) {
      const { log_id, new_status, output_summary, execution_end_timestamp_unix, duration_ms } = args;
      await memory.toolExecutionLogManager.updateToolExecutionLogStatus(
          log_id, 
          new_status, 
          output_summary || undefined,
          execution_end_timestamp_unix || undefined, 
          undefined, 
          duration_ms || undefined
      );
      return { content: [{ type: 'text', text: formatSimpleMessage(`Tool execution log \`${log_id}\` status updated to \`${new_status}\`.`, "Tool Log Status Updated") }] };
    }
  };
}

export function log_task_progress(memory: MemoryManager): LoggingTool {
  return {
    name: 'log_task_progress',
    description: 'Records a summary of the agent\'s progress after completing a significant step or action within a planned task or subtask. Output is Markdown formatted.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
        associated_plan_id: { type: 'string', description: 'ID of the plan this progress log is associated with.' },
        associated_task_id: { type: 'string', description: 'ID of the task this progress log is associated with.' },
        associated_subtask_id: { type: ['string', 'null'], description: 'Optional: ID of the subtask if applicable.' },
        step_number_executed: { type: ['string', 'null'], description: 'The plan step number that was executed.' },
        plan_step_title: { type: ['string', 'null'], description: 'The title of the plan step.' },
        action_tool_used: { type: ['string', 'null'], description: 'Name of the primary tool used for this step\'s action.' },
        tool_parameters_summary_json: { type: ['object','string', 'null'], description: 'JSON object/string summarizing tool parameters.' },
        files_modified_list_json: { type: ['array','string', 'null'], items: { type: 'string' }, description: 'JSON array/string of paths of modified files.' },
        change_summary_text: { type: ['string', 'null'], description: 'Human-readable summary of changes or actions.' },
        status_of_step_execution: { type: 'string', description: 'Updatable: e.g., SUCCESS, FAILURE, PARTIAL_SUCCESS.' },
        output_summary_or_error: { type: ['string', 'null'], description: 'Summary of the outcome or error details for this step.' }
      },
      required: ['agent_id', 'associated_plan_id', 'associated_task_id', 'status_of_step_execution'],
    },
    async call(args: any) {
      const {
        agent_id, associated_plan_id, associated_task_id, associated_subtask_id,
        step_number_executed, plan_step_title, action_tool_used,
        tool_parameters_summary_json, files_modified_list_json, change_summary_text,
        status_of_step_execution, output_summary_or_error
      } = args;

      const final_tool_params_json = typeof tool_parameters_summary_json === 'string' 
                                        ? tool_parameters_summary_json 
                                        : (tool_parameters_summary_json ? JSON.stringify(tool_parameters_summary_json) : null);
      const final_files_modified_json = typeof files_modified_list_json === 'string'
                                        ? files_modified_list_json
                                        : (files_modified_list_json ? JSON.stringify(files_modified_list_json) : null);

      const logData: Omit<TaskProgressLog, 'progress_log_id' | 'execution_timestamp_unix' | 'execution_timestamp_iso' | 'log_creation_timestamp_unix' | 'log_creation_timestamp_iso' | 'last_updated_timestamp_unix' | 'last_updated_timestamp_iso'> = {
        agent_id,
        associated_plan_id,
        associated_task_id,
        associated_subtask_id: associated_subtask_id || null,
        step_number_executed: step_number_executed || null,
        plan_step_title: plan_step_title || null,
        action_tool_used: action_tool_used || null,
        tool_parameters_summary_json: final_tool_params_json,
        files_modified_list_json: final_files_modified_json,
        change_summary_text: change_summary_text || null,
        status_of_step_execution,
        output_summary_or_error: output_summary_or_error || null
      };
      try {
        const logId = await memory.taskProgressLogManager.createTaskProgressLog(logData);
        return { content: [{ type: 'text', text: formatSimpleMessage(`Task progress logged with ID: \`${logId}\``,"Task Progress Logged") }] };
      } catch (error: any) {
        if (error.message && error.message.includes('FOREIGN KEY constraint failed')) {
          throw new McpError(ErrorCode.InvalidParams, 'Error: The specified task or plan ID is invalid. Task progress not logged.');
        }
        throw error;
      }
    }
  };
}

export function get_task_progress_logs(memory: MemoryManager): LoggingTool {
  return {
    name: 'get_task_progress_logs',
    description: 'Retrieves historical task progress logs. Output is Markdown formatted.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
        limit: { type: 'number', default: 100 },
        offset: { type: 'number', default: 0 },
      },
      required: ['agent_id'],
    },
    async call(args: any) {
      const { agent_id, limit, offset } = args;
      const logs: TaskProgressLog[] = await memory.taskProgressLogManager.getTaskProgressLogsByAgentId(agent_id, limit, offset);
      if (logs.length === 0) {
        return { content: [{ type: 'text', text: formatSimpleMessage(`No task progress logs found for agent ID: \`${agent_id}\``, "Task Progress Logs") }] };
      }
      let md = `## Task Progress Logs for Agent: \`${agent_id}\` (Limit: ${limit}, Offset: ${offset})\n\n`;
      logs.forEach(log => {
        md += formatTaskProgressLogToMarkdown(log) + "\n---\n\n";
      });
      return { content: [{ type: 'text', text: md }] };
    }
  };
}

export function update_task_progress_log_status(memory: MemoryManager): LoggingTool {
  return {
    name: 'update_task_progress_log_status',
    description: 'Updates the status or outcome of a previously logged task progress entry. Output is Markdown formatted.',
    inputSchema: {
      type: 'object',
      properties: {
        progress_log_id: { type: 'string', description: 'Unique ID of the task progress log to update.' },
        new_status_of_step_execution: { type: 'string', description: 'The new status for the log entry.' },
        output_summary_or_error: { type: ['string', 'null'], description: 'Optional: Updated summary of the outcome or error details.' },
      },
      required: ['progress_log_id', 'new_status_of_step_execution'],
    },
    async call(args: any) {
      const { progress_log_id, new_status_of_step_execution, output_summary_or_error } = args;
      await memory.taskProgressLogManager.updateTaskProgressLogStatus(
          progress_log_id, 
          new_status_of_step_execution, 
          output_summary_or_error || undefined
      );
      return { content: [{ type: 'text', text: formatSimpleMessage(`Task progress log \`${progress_log_id}\` status updated.`, "Task Progress Log Updated") }] };
    }
  };
}

export function log_error(memory: MemoryManager): LoggingTool {
  return {
    name: 'log_error',
    description: 'Logs an error encountered by the agent during its operation. Output is Markdown formatted.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
        associated_plan_id: { type: ['string', 'null'] },
        associated_task_id: { type: ['string', 'null'] },
        associated_subtask_id: { type: ['string', 'null'] },
        associated_tool_execution_log_id: { type: ['string', 'null'] },
        error_type: { type: 'string', description: 'e.g., TypeScript Compilation Error, Runtime Exception, API Error, Tool Execution Failure.' },
        error_message: { type: 'string', description: 'The error message.' },
        stack_trace: { type: ['string', 'null'] },
        source_file: { type: ['string', 'null'] },
        source_line: { type: ['number', 'null'] },
        severity: { type: 'string', default: 'MEDIUM', description: 'e.g., LOW, MEDIUM, HIGH, CRITICAL.' },
        status: { type: 'string', default: 'NEW', description: 'Updatable: e.g., NEW, ACKNOWLEDGED, INVESTIGATING, RESOLVED, IGNORED.' },
        resolution_details: { type: ['string', 'null'] },
      },
      required: ['agent_id', 'error_type', 'error_message'],
    },
    async call(args: any) {
      const {
        agent_id, associated_plan_id, associated_task_id, associated_subtask_id,
        associated_tool_execution_log_id, error_type, error_message, stack_trace,
        source_file, source_line, severity, status, resolution_details
      } = args;

      const error_timestamp_unix = Date.now();
      const error_timestamp_iso = new Date(error_timestamp_unix).toISOString();

      const logData: Omit<ErrorLog, 'error_log_id' | 'log_creation_timestamp_unix' | 'log_creation_timestamp_iso' | 'last_updated_timestamp_unix' | 'last_updated_timestamp_iso'> = {
        agent_id,
        associated_plan_id: associated_plan_id || null,
        associated_task_id: associated_task_id || null,
        associated_subtask_id: associated_subtask_id || null,
        associated_tool_execution_log_id: associated_tool_execution_log_id || null,
        error_type,
        error_message,
        stack_trace: stack_trace || null,
        source_file: source_file || null,
        source_line: source_line || null,
        severity: severity || 'MEDIUM',
        status: status || 'NEW',
        resolution_details: resolution_details || null,
        error_timestamp_unix,
        error_timestamp_iso
      };
      const logId = await memory.errorLogManager.createErrorLog(logData);
      return { content: [{ type: 'text', text: formatSimpleMessage(`Error logged with ID: \`${logId}\``, "Error Logged") }] };
    }
  };
}

export function get_error_logs(memory: MemoryManager): LoggingTool {
  return {
    name: 'get_error_logs',
    description: 'Retrieves historical error logs. Output is Markdown formatted.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
        limit: { type: 'number', default: 100 },
        offset: { type: 'number', default: 0 },
      },
      required: ['agent_id'],
    },
    async call(args: any) {
      const { agent_id, limit, offset } = args;
      const logs: ErrorLog[] = await memory.errorLogManager.getErrorLogsByAgentId(agent_id, limit, offset);
      if (logs.length === 0) {
        return { content: [{ type: 'text', text: formatSimpleMessage(`No error logs found for agent ID: \`${agent_id}\``, "Error Logs") }] };
      }
      let md = `## Error Logs for Agent: \`${agent_id}\` (Limit: ${limit}, Offset: ${offset})\n\n`;
      logs.forEach(log => {
        md += formatErrorLogToMarkdown(log) + "\n---\n\n";
      });
      return { content: [{ type: 'text', text: md }] };
    }
  };
}

export function update_error_log_status(memory: MemoryManager): LoggingTool {
  return {
    name: 'update_error_log_status',
    description: 'Updates the status of a previously logged error. Output is Markdown formatted.',
    inputSchema: {
      type: 'object',
      properties: {
        error_log_id: { type: 'string', description: 'Unique ID of the error log to update.' },
        new_status: { type: 'string', description: 'The new status for the error log.' },
        resolution_details: { type: ['string', 'null'], description: 'Optional: Details on how the error was resolved.' },
      },
      required: ['error_log_id', 'new_status'],
    },
    async call(args: any) {
      const { error_log_id, new_status, resolution_details } = args;
      await memory.errorLogManager.updateErrorLogStatus(
          error_log_id, 
          new_status, 
          resolution_details || undefined
      );
      return { content: [{ type: 'text', text: formatSimpleMessage(`Error log \`${error_log_id}\` status updated to \`${new_status}\`.`, "Error Log Status Updated") }] };
    }
  };
}

export function update_correction_log_status(memory: MemoryManager): LoggingTool {
  return {
    name: 'update_correction_log_status',
    description: 'Updates the status of a previously logged correction entry. Output is Markdown formatted.',
    inputSchema: {
      type: 'object',
      properties: {
        correction_id: { type: 'string', description: 'Unique ID of the correction log to update.' },
        new_status: { type: 'string', description: 'The new status for the correction log.' },
      },
      required: ['correction_id', 'new_status'],
    },
    async call(args: any) {
      const { correction_id, new_status } = args;
      await memory.correctionLogManager.updateCorrectionLogStatus(
        correction_id,
        new_status
      );
      return { content: [{ type: 'text', text: formatSimpleMessage(`Correction log \`${correction_id}\` status updated to \`${new_status}\`.`, "Correction Log Status Updated") }] };
    }
  };
}

export function getLoggingToolDefinitions(memoryManager: MemoryManager) {
  return [
    { name: 'log_tool_execution', description: log_tool_execution(memoryManager).description, inputSchema: log_tool_execution(memoryManager).inputSchema },
    { name: 'get_tool_execution_logs', description: get_tool_execution_logs(memoryManager).description, inputSchema: get_tool_execution_logs(memoryManager).inputSchema },
    { name: 'update_tool_execution_log_status', description: update_tool_execution_log_status(memoryManager).description, inputSchema: update_tool_execution_log_status(memoryManager).inputSchema },
    { name: 'log_task_progress', description: log_task_progress(memoryManager).description, inputSchema: log_task_progress(memoryManager).inputSchema },
    { name: 'get_task_progress_logs', description: get_task_progress_logs(memoryManager).description, inputSchema: get_task_progress_logs(memoryManager).inputSchema },
    { name: 'update_task_progress_log_status', description: update_task_progress_log_status(memoryManager).description, inputSchema: update_task_progress_log_status(memoryManager).inputSchema },
    { name: 'log_error', description: log_error(memoryManager).description, inputSchema: log_error(memoryManager).inputSchema },
    { name: 'get_error_logs', description: get_error_logs(memoryManager).description, inputSchema: get_error_logs(memoryManager).inputSchema },
    { name: 'update_error_log_status', description: update_error_log_status(memoryManager).description, inputSchema: update_error_log_status(memoryManager).inputSchema },
    { name: 'update_correction_log_status', description: update_correction_log_status(memoryManager).description, inputSchema: update_correction_log_status(memoryManager).inputSchema },
  ];
}
