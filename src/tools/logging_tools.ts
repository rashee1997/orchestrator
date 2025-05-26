import { MemoryManager } from '../database/memory_manager.js';
import { ToolExecutionLog, TaskProgressLog, ErrorLog } from '../types/index.js'; // CorrectionLog might be needed if its schema is used here

// Helper function to define a tool structure, can be expanded
interface LoggingTool {
    name: string;
    description: string;
    schema: object; // JSON schema for input
    call: (args: any) => Promise<any>; // The function to execute the tool
}


export function log_tool_execution(memory: MemoryManager): LoggingTool {
  return {
    name: 'log_tool_execution',
    description: 'Logs the initiation or completion details of a specific tool execution attempt by the agent. Called before and after a tool runs.',
    schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
        plan_id: { type: ['string', 'null'], description: 'Optional: Link to the plan if applicable.' },
        task_id: { type: ['string', 'null'], description: 'Optional: Link to the specific task if applicable.' },
        subtask_id: { type: ['string', 'null'], description: 'Optional: Link to the specific subtask if applicable.' },
        tool_name: { type: 'string', description: 'Name of the tool being logged.' },
        arguments_json: { type: ['object', 'string'], description: 'JSON object or string of arguments passed to the tool.' }, // Allow object for easier use
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
      // additionalProperties: false // Consider if strict adherence is needed or if extra args should be ignored/logged
    },
    async call(args: any) {
      const {
        agent_id, plan_id, task_id, subtask_id, tool_name, arguments_json,
        status, output_summary, execution_start_timestamp_unix, execution_start_timestamp_iso,
        execution_end_timestamp_unix, execution_end_timestamp_iso, duration_ms,
        step_number_executed, plan_step_title
      } = args;

      // Ensure arguments_json is a string for storage
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
      return { content: [{ type: 'text', text: `Tool execution logged with ID: ${logId}` }] };
    }
  };
}

export function get_tool_execution_logs(memory: MemoryManager): LoggingTool {
  return {
    name: 'get_tool_execution_logs',
    description: 'Retrieves historical tool execution logs based on specified filters to aid in review, debugging, or agent learning.',
    schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
        limit: { type: 'number', default: 100, description: "Maximum number of logs to retrieve." },
        offset: { type: 'number', default: 0, description: "Offset for pagination." },
        // Add other filters as needed, e.g., plan_id, task_id, tool_name, status, date_range
      },
      required: ['agent_id'],
    },
    async call(args: any) {
      const { agent_id, limit, offset /*, other filters */ } = args;
      // Pass filters to the manager method if it supports them
      const logs = await memory.toolExecutionLogManager.getToolExecutionLogsByAgentId(agent_id, limit, offset);
      if (logs.length === 0) {
        return { content: [{ type: 'text', text: `No tool execution logs found for agent_id: ${agent_id}` }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
    }
  };
}

export function update_tool_execution_log_status(memory: MemoryManager): LoggingTool {
  return {
    name: 'update_tool_execution_log_status',
    description: 'Updates the status or outcome of a previously logged tool execution entry.',
    schema: {
      type: 'object',
      properties: {
        // agent_id is not strictly needed if log_id is globally unique, but good for namespacing/auth
        // agent_id: { type: 'string', description: 'Identifier of the AI agent.' }, 
        log_id: { type: 'string', description: 'Unique ID of the tool execution log to update.' },
        new_status: { type: 'string', description: 'The new status for the log entry.' },
        output_summary: { type: ['string', 'null'], description: 'Optional: Updated summary of the tool\'s output or error message.' },
        execution_end_timestamp_unix: { type: ['number', 'null'], description: 'Unix timestamp of when the execution ended.' },
        // execution_end_timestamp_iso is derived in manager
        duration_ms: { type: ['number', 'null'], description: 'Calculated duration in milliseconds.' }
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
          undefined, // execution_end_timestamp_iso is derived in manager
          duration_ms || undefined
      );
      return { content: [{ type: 'text', text: `Tool execution log ${log_id} status updated to ${new_status}.` }] };
    }
  };
}

export function log_task_progress(memory: MemoryManager): LoggingTool {
  return {
    name: 'log_task_progress',
    description: 'Records a summary of the agent\'s progress after completing a significant step or action within a planned task or subtask.',
    schema: {
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
        // execution_timestamp_unix and _iso are generated by the manager
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
        return { content: [{ type: 'text', text: `Task progress logged with ID: ${logId}` }] };
      } catch (error: any) {
        if (error.message && error.message.includes('FOREIGN KEY constraint failed')) {
          return { content: [{ type: 'text', text: 'Error: The specified task is not part of the plan. Task progress not updated.' }] };
        }
        throw error;
      }
    }

  };
}

export function get_task_progress_logs(memory: MemoryManager): LoggingTool {
  return {
    name: 'get_task_progress_logs',
    description: 'Retrieves historical task progress logs, allowing for review of how tasks and plans were executed over time.',
    schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
        limit: { type: 'number', default: 100 },
        offset: { type: 'number', default: 0 },
        // Add other filters as needed
      },
      required: ['agent_id'],
    },
    async call(args: any) {
      const { agent_id, limit, offset } = args;
      const logs = await memory.taskProgressLogManager.getTaskProgressLogsByAgentId(agent_id, limit, offset);
      if (logs.length === 0) {
        return { content: [{ type: 'text', text: `No task progress logs found for agent_id: ${agent_id}` }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
    }
  };
}

export function update_task_progress_log_status(memory: MemoryManager): LoggingTool {
  return {
    name: 'update_task_progress_log_status',
    description: 'Updates the status or outcome of a previously logged task progress entry.',
    schema: {
      type: 'object',
      properties: {
        // agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
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
      return { content: [{ type: 'text', text: `Task progress log ${progress_log_id} status updated.` }] };
    }
  };
}

export function log_error(memory: MemoryManager): LoggingTool {
  return {
    name: 'log_error',
    description: 'Logs an error encountered by the agent during its operation.',
    schema: {
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
        // error_timestamp_unix and _iso are generated by the manager
      },
      required: ['agent_id', 'error_type', 'error_message'],
    },
    async call(args: any) {
      const {
        agent_id, associated_plan_id, associated_task_id, associated_subtask_id,
        associated_tool_execution_log_id, error_type, error_message, stack_trace,
        source_file, source_line, severity, status, resolution_details
      } = args;

      // Timestamps are generated by the manager
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
        error_timestamp_unix, // Generated here for the log entry
        error_timestamp_iso   // Generated here for the log entry
      };
      const logId = await memory.errorLogManager.createErrorLog(logData);
      return { content: [{ type: 'text', text: `Error logged with ID: ${logId}` }] };
    }
  };
}

export function get_error_logs(memory: MemoryManager): LoggingTool {
  return {
    name: 'get_error_logs',
    description: 'Retrieves historical error logs for debugging, analysis, and identifying patterns in agent failures.',
    schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
        limit: { type: 'number', default: 100 },
        offset: { type: 'number', default: 0 },
        // Add other filters
      },
      required: ['agent_id'],
    },
    async call(args: any) {
      const { agent_id, limit, offset } = args;
      const logs = await memory.errorLogManager.getErrorLogsByAgentId(agent_id, limit, offset);
      if (logs.length === 0) {
        return { content: [{ type: 'text', text: `No error logs found for agent_id: ${agent_id}` }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
    }
  };
}

export function update_error_log_status(memory: MemoryManager): LoggingTool {
  return {
    name: 'update_error_log_status',
    description: 'Updates the status of a previously logged error, typically as part of a debugging or resolution workflow.',
    schema: {
      type: 'object',
      properties: {
        // agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
        error_log_id: { type: 'string', description: 'Unique ID of the error log to update.' },
        new_status: { type: 'string', description: 'The new status for the error log.' },
        resolution_details: { type: ['string', 'null'], description: 'Optional: Details on how the error was resolved.' },
        // Timestamps are handled by the manager
      },
      required: ['error_log_id', 'new_status'],
    },
    async call(args: any) {
      const { error_log_id, new_status, resolution_details } = args;
      await memory.errorLogManager.updateErrorLogStatus(
          error_log_id, 
          new_status, 
          resolution_details || undefined
          // Timestamps are handled by manager
      );
      return { content: [{ type: 'text', text: `Error log ${error_log_id} status updated.` }] };
    }
  };
}

export function update_correction_log_status(memory: MemoryManager): LoggingTool {
  return {
    name: 'update_correction_log_status',
    description: 'Updates the status of a previously logged correction entry.',
    schema: {
      type: 'object',
      properties: {
        // agent_id is not strictly needed by manager if correction_id is unique
        // agent_id: { type: 'string', description: 'Identifier of the AI agent.' }, 
        correction_id: { type: 'string', description: 'Unique ID of the correction log to update.' },
        new_status: { type: 'string', description: 'The new status for the correction log.' },
        // Timestamps are handled by the manager
      },
      required: ['correction_id', 'new_status'],
    },
    async call(args: any) {
      const { correction_id, new_status } = args; // agent_id removed from destructuring
      // Call manager method with only the required arguments
      await memory.correctionLogManager.updateCorrectionLogStatus(
        correction_id,
        new_status
        // Timestamps are handled by manager
      );
      return { content: [{ type: 'text', text: `Correction log ${correction_id} status updated.` }] };
    }
  };
}

// This structure is for MCP server listing, not direct execution.
// The actual handlers are generated by getLoggingToolDefinitions.
export const loggingToolDefinitionsForMcp = [
  // Definitions will be populated by getLoggingToolDefinitions
];

// Factory function to generate logging tool definitions with a bound MemoryManager
// These are the definitions the MCP server will use.
export function getLoggingToolDefinitions(memoryManager: MemoryManager) {
  return [
    {
      name: 'log_tool_execution',
      description: log_tool_execution(memoryManager).description,
      inputSchema: log_tool_execution(memoryManager).schema,
      // func is not part of MCP definition, it's for internal use by the server handler
    },
    {
      name: 'get_tool_execution_logs',
      description: get_tool_execution_logs(memoryManager).description,
      inputSchema: get_tool_execution_logs(memoryManager).schema,
    },
    {
      name: 'update_tool_execution_log_status',
      description: update_tool_execution_log_status(memoryManager).description,
      inputSchema: update_tool_execution_log_status(memoryManager).schema,
    },
    {
      name: 'log_task_progress',
      description: log_task_progress(memoryManager).description,
      inputSchema: log_task_progress(memoryManager).schema,
    },
    {
      name: 'get_task_progress_logs',
      description: get_task_progress_logs(memoryManager).description,
      inputSchema: get_task_progress_logs(memoryManager).schema,
    },
    {
      name: 'update_task_progress_log_status',
      description: update_task_progress_log_status(memoryManager).description,
      inputSchema: update_task_progress_log_status(memoryManager).schema,
    },
    {
      name: 'log_error',
      description: log_error(memoryManager).description,
      inputSchema: log_error(memoryManager).schema,
    },
    {
      name: 'get_error_logs',
      description: get_error_logs(memoryManager).description,
      inputSchema: get_error_logs(memoryManager).schema,
    },
    {
      name: 'update_error_log_status',
      description: update_error_log_status(memoryManager).description,
      inputSchema: update_error_log_status(memoryManager).schema,
    },
    {
      name: 'update_correction_log_status',
      description: update_correction_log_status(memoryManager).description,
      inputSchema: update_correction_log_status(memoryManager).schema,
    },
  ];
}
