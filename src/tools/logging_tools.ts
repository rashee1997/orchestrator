import { MemoryManager } from '../database/memory_manager.js';
import { ToolExecutionLog, TaskProgressLog, ErrorLog, CorrectionLog } from '../types/index.js';
import {
    formatSimpleMessage,
    formatJsonToMarkdownCodeBlock,
    formatToolExecutionLogToMarkdown,
    formatTaskProgressLogToMarkdown,
    formatErrorLogToMarkdown,
    formatCorrectionLogToMarkdown
} from '../utils/formatters.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// Interface for the tools this module defines, primarily for internal consistency.
interface LoggingTool {
    name: string;
    description: string;
    inputSchema: object;
    call: (args: any) => Promise<any>; // 'call' matches the structure in MemoryManager
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
        arguments_json: { type: ['object', 'string'], description: 'JSON object or string of arguments passed to the tool.' }, // Allow object or string
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

      // Ensure arguments_json is a string for database storage
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
      const { agent_id } = args;
      const limit = args.limit ?? 100; // Use schema default if not provided
      const offset = args.offset ?? 0; // Use schema default if not provided

      const logs: ToolExecutionLog[] = await memory.toolExecutionLogManager.getToolExecutionLogsByAgentId(agent_id, limit, offset);
      if (logs.length === 0) {
        return { content: [{ type: 'text', text: formatSimpleMessage(`No tool execution logs found for agent ID: \`${agent_id}\``, "Tool Execution Logs") }] };
      }

      let titleParts = [];
      if (args.limit !== undefined && args.limit !== 100) titleParts.push(`Limit: ${args.limit}`);
      if (args.offset !== undefined && args.offset !== 0) titleParts.push(`Offset: ${args.offset}`);
      const titleSuffix = titleParts.length > 0 ? ` (${titleParts.join(', ')})` : '';
      let md = `## Tool Execution Logs for Agent: \`${agent_id}\`${titleSuffix}\n\nEach log entry is presented as a list item:\n\n`;

      logs.forEach(log => {
        md += formatToolExecutionLogToMarkdown(log) + "\n---\n";
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
        execution_end_timestamp_unix: { type: ['number', 'null'], description: 'Optional: Unix timestamp of when the execution ended.' },
        // execution_end_timestamp_iso will be derived in the manager
        duration_ms: { type: ['number', 'null'], description: 'Optional: Calculated duration in milliseconds.' }
      },
      required: ['log_id', 'new_status'],
    },
    async call(args: any) {
      const { log_id, new_status, output_summary, execution_end_timestamp_unix, duration_ms } = args;
      await memory.toolExecutionLogManager.updateToolExecutionLogStatus(
          log_id,
          new_status,
          output_summary || undefined, // Pass undefined if null/empty
          execution_end_timestamp_unix || undefined,
          undefined, // ISO timestamp is derived in manager
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
        throw error; // Re-throw other errors
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
      const { agent_id } = args;
      const limit = args.limit ?? 100;
      const offset = args.offset ?? 0;

      const logs: TaskProgressLog[] = await memory.taskProgressLogManager.getTaskProgressLogsByAgentId(agent_id, limit, offset);
      if (logs.length === 0) {
        return { content: [{ type: 'text', text: formatSimpleMessage(`No task progress logs found for agent ID: \`${agent_id}\``, "Task Progress Logs") }] };
      }

      let titleParts = [];
      if (args.limit !== undefined && args.limit !== 100) titleParts.push(`Limit: ${args.limit}`);
      if (args.offset !== undefined && args.offset !== 0) titleParts.push(`Offset: ${args.offset}`);
      const titleSuffix = titleParts.length > 0 ? ` (${titleParts.join(', ')})` : '';
      let md = `## Task Progress Logs for Agent: \`${agent_id}\`${titleSuffix}\n\nEach log entry is presented as a list item:\n\n`;

      logs.forEach(log => {
        md += formatTaskProgressLogToMarkdown(log) + "\n---\n";
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
        associated_plan_id: { type: ['string', 'null'], description: 'Optional: ID of the plan associated with this error.' },
        associated_task_id: { type: ['string', 'null'], description: 'Optional: ID of the task associated with this error.' },
        associated_subtask_id: { type: ['string', 'null'], description: 'Optional: ID of the subtask associated with this error.' },
        associated_tool_execution_log_id: { type: ['string', 'null'], description: 'Optional: ID of the tool execution log associated with this error.' },
        error_type: { type: 'string', description: 'e.g., TypeScript Compilation Error, Runtime Exception, API Error, Tool Execution Failure.' },
        error_message: { type: 'string', description: 'The error message.' },
        stack_trace: { type: ['string', 'null'], description: 'The stack trace, if available.' },
        source_file: { type: ['string', 'null'], description: 'The source file where the error originated, if applicable.' },
        source_line: { type: ['number', 'null'], description: 'The line number in the source file, if applicable.' },
        severity: { type: 'string', default: 'MEDIUM', description: 'e.g., LOW, MEDIUM, HIGH, CRITICAL.' },
        status: { type: 'string', default: 'NEW', description: 'Updatable: e.g., NEW, ACKNOWLEDGED, INVESTIGATING, RESOLVED, IGNORED.' },
        resolution_details: { type: ['string', 'null'], description: 'Details on how the error was resolved, if applicable.' },
        // error_timestamp_unix and error_timestamp_iso are generated by the manager
      },
      required: ['agent_id', 'error_type', 'error_message'],
    },
    async call(args: any) {
      const {
        agent_id, associated_plan_id, associated_task_id, associated_subtask_id,
        associated_tool_execution_log_id, error_type, error_message, stack_trace,
        source_file, source_line, severity, status, resolution_details
      } = args;

      const error_timestamp_unix = Date.now(); // Manager will set this
      const error_timestamp_iso = new Date(error_timestamp_unix).toISOString(); // Manager will set this

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
        error_timestamp_unix, // Pass it, manager uses it
        error_timestamp_iso   // Pass it, manager uses it
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
      const { agent_id } = args;
      const limit = args.limit ?? 100;
      const offset = args.offset ?? 0;

      const logs: ErrorLog[] = await memory.errorLogManager.getErrorLogsByAgentId(agent_id, limit, offset);
      if (logs.length === 0) {
        return { content: [{ type: 'text', text: formatSimpleMessage(`No error logs found for agent ID: \`${agent_id}\``, "Error Logs") }] };
      }

      let titleParts = [];
      if (args.limit !== undefined && args.limit !== 100) titleParts.push(`Limit: ${args.limit}`);
      if (args.offset !== undefined && args.offset !== 0) titleParts.push(`Offset: ${args.offset}`);
      const titleSuffix = titleParts.length > 0 ? ` (${titleParts.join(', ')})` : '';
      let md = `## Error Logs for Agent: \`${agent_id}\`${titleSuffix}\n\nEach log entry is presented as a list item:\n\n`;

      logs.forEach(log => {
        md += formatErrorLogToMarkdown(log) + "\n---\n";
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
      // Timestamps are handled by the manager
      await memory.errorLogManager.updateErrorLogStatus(
          error_log_id,
          new_status,
          resolution_details || undefined
      );
      return { content: [{ type: 'text', text: formatSimpleMessage(`Error log \`${error_log_id}\` status updated to \`${new_status}\`.`, "Error Log Status Updated") }] };
    }
  };
}

// Correction Log specific tools
export function log_correction(memory: MemoryManager): LoggingTool {
    return {
        name: 'log_correction',
        description: 'Records instances where the AI agent\'s output or internal state was corrected. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                correction_type: { type: 'string', description: 'Type of correction (e.g., user_feedback, self_correction, system_override).' },
                original_entry_id: { type: ['string', 'null'], description: 'ID of the memory entry that was corrected (e.g., conversation_id, context_id).', nullable: true },
                original_value: { type: ['object', 'null'], description: 'JSON object of the original data before correction.', nullable: true }, // Expects object
                corrected_value: { type: ['object', 'null'], description: 'JSON object of the corrected data.', nullable: true }, // Expects object
                reason: { type: ['string', 'null'], description: 'Explanation for the correction.', nullable: true },
                correction_summary: { type: ['string', 'null'], description: 'AI-generated summary of the correction.', nullable: true },
                applied_automatically: { type: 'boolean', description: 'True if applied by system, false if manual.' },
                status: { type: 'string', description: 'Status of the correction log (e.g., LOGGED, REVIEWED, ACTION_TAKEN).', default: 'LOGGED'},
            },
            required: ['agent_id', 'correction_type', 'applied_automatically'],
        },
        async call(args: any) {
            const {
                agent_id, correction_type, original_entry_id, original_value,
                corrected_value, reason, correction_summary, applied_automatically, status
            } = args;
            // original_value and corrected_value are passed as objects to the manager
            const corrId = await memory.correctionLogManager.logCorrection(
                agent_id,
                correction_type,
                original_entry_id || null,
                original_value || null,
                corrected_value || null,
                reason || null,
                correction_summary || null,
                applied_automatically,
                status || 'LOGGED'
            );
            return { content: [{ type: 'text', text: formatSimpleMessage(`Correction logged with ID: \`${corrId}\``, "Correction Logged") }] };
        }
    };
}

export function get_correction_logs(memory: MemoryManager): LoggingTool {
    return {
        name: 'get_correction_logs',
        description: 'Retrieves correction logs for a given agent, optionally filtered by correction type. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
                correction_type: { type: ['string', 'null'], description: 'Optional type of correction to filter by.', nullable: true },
                limit: { type: 'number', description: 'Maximum number of logs to retrieve.', default: 100 },
                offset: { type: 'number', description: 'Offset for pagination.', default: 0 },
            },
            required: ['agent_id'],
        },
        async call(args: any) {
            const { agent_id } = args;
            const limit = args.limit ?? 100;
            const offset = args.offset ?? 0;
            const correction_type = args.correction_type || null;

            const logs: CorrectionLog[] = await memory.correctionLogManager.getCorrectionLogs(
                agent_id,
                correction_type,
                limit,
                offset
            );
            if (logs.length === 0) {
                return { content: [{ type: 'text', text: formatSimpleMessage(`No correction logs found for agent ID: \`${agent_id}\``, "Correction Logs") }] };
            }

            let titleParts = [];
            if (correction_type) titleParts.push(`Type: ${correction_type}`);
            if (args.limit !== undefined && args.limit !== 100) titleParts.push(`Limit: ${args.limit}`);
            if (args.offset !== undefined && args.offset !== 0) titleParts.push(`Offset: ${args.offset}`);
            const titleSuffix = titleParts.length > 0 ? ` (${titleParts.join(', ')})` : '';
            let md = `## Correction Logs for Agent: \`${agent_id}\`${titleSuffix}\n\nEach log entry is presented as a list item:\n\n`;

            logs.forEach((log: any) => { // Cast to any because parseJsonFields adds properties
                md += formatCorrectionLogToMarkdown(log) + "\n---\n";
            });
            return { content: [{ type: 'text', text: md }] };
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
      // Timestamps are handled by the manager
      await memory.correctionLogManager.updateCorrectionLogStatus(
        correction_id,
        new_status
      );
      return { content: [{ type: 'text', text: formatSimpleMessage(`Correction log \`${correction_id}\` status updated to \`${new_status}\`.`, "Correction Log Status Updated") }] };
    }
  };
}

// This function is used by the main tool index to get all definitions for MCP server listing.
export function getLoggingToolDefinitions(memoryManager: MemoryManager) {
  // We return the schema part of the tool, not the 'call' function itself for definitions.
  return [
    { name: log_tool_execution(memoryManager).name, description: log_tool_execution(memoryManager).description, inputSchema: log_tool_execution(memoryManager).inputSchema },
    { name: get_tool_execution_logs(memoryManager).name, description: get_tool_execution_logs(memoryManager).description, inputSchema: get_tool_execution_logs(memoryManager).inputSchema },
    { name: update_tool_execution_log_status(memoryManager).name, description: update_tool_execution_log_status(memoryManager).description, inputSchema: update_tool_execution_log_status(memoryManager).inputSchema },
    { name: log_task_progress(memoryManager).name, description: log_task_progress(memoryManager).description, inputSchema: log_task_progress(memoryManager).inputSchema },
    { name: get_task_progress_logs(memoryManager).name, description: get_task_progress_logs(memoryManager).description, inputSchema: get_task_progress_logs(memoryManager).inputSchema },
    { name: update_task_progress_log_status(memoryManager).name, description: update_task_progress_log_status(memoryManager).description, inputSchema: update_task_progress_log_status(memoryManager).inputSchema },
    { name: log_error(memoryManager).name, description: log_error(memoryManager).description, inputSchema: log_error(memoryManager).inputSchema },
    { name: get_error_logs(memoryManager).name, description: get_error_logs(memoryManager).description, inputSchema: get_error_logs(memoryManager).inputSchema },
    { name: update_error_log_status(memoryManager).name, description: update_error_log_status(memoryManager).description, inputSchema: update_error_log_status(memoryManager).inputSchema },
    { name: log_correction(memoryManager).name, description: log_correction(memoryManager).description, inputSchema: log_correction(memoryManager).inputSchema },
    { name: get_correction_logs(memoryManager).name, description: get_correction_logs(memoryManager).description, inputSchema: get_correction_logs(memoryManager).inputSchema },
    { name: update_correction_log_status(memoryManager).name, description: update_correction_log_status(memoryManager).description, inputSchema: update_correction_log_status(memoryManager).inputSchema },
  ];
}
