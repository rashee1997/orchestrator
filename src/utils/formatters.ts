// src/utils/formatters.ts

// Helper function to escape Markdown special characters
function escapeMarkdown(text: string | number | boolean | null | undefined): string {
    if (text === null || typeof text === 'undefined') {
        return '';
    }
    const stringText = String(text);
    return stringText.replace(/([\\`*_{}[\]()#+-.!])/g, '\\$1');
}

// Helper function to format a generic object into a Markdown string
export function formatObjectToMarkdown(obj: any, indentLevel: number = 0, isListItem: boolean = false): string {
    let md = '';
    const indent = '  '.repeat(indentLevel); // Two spaces for indentation

    if (obj === null || typeof obj === 'undefined') {
        return `${indent}${isListItem ? '' : '- '}*N/A*\n`;
    }

    if (typeof obj !== 'object' || obj instanceof Date) {
        const prefix = isListItem ? '' : (indentLevel > 0 ? '' : '- ');
        if (obj instanceof Date) {
            return `${indent}${prefix}**${escapeMarkdown(obj.toLocaleString())}**\n`;
        }
        return `${indent}${prefix}${escapeMarkdown(obj)}\n`;
    }

    if (Array.isArray(obj)) {
        if (obj.length === 0) {
            return `${indent}${isListItem ? '' : '- '}*Empty array*\n`;
        }
        obj.forEach((item, index) => {
            const itemPrefix = `${indent}- `;
            if (typeof item === 'object' && item !== null) {
                md += `${itemPrefix}Item ${index + 1}:\n`;
                md += formatObjectToMarkdown(item, indentLevel + 1, false);
            } else {
                md += `${itemPrefix}${escapeMarkdown(item)}\n`;
            }
        });
    } else {
        const keys = Object.keys(obj);
        if (keys.length === 0) {
            return `${indent}${isListItem ? '' : '- '}*Empty object*\n`;
        }
        keys.forEach(key => {
            const value = obj[key];
            const keyPrefix = `${indent}${isListItem && indentLevel > 0 ? '' : '- '}`;
            md += `${keyPrefix}**${escapeMarkdown(key)}:** `;
            if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
                md += `\n`;
                md += formatObjectToMarkdown(value, indentLevel + 1, false);
            } else {
                md += `${escapeMarkdown(value instanceof Date ? value.toLocaleString() : value)}\n`;
            }
        });
    }
    return md;
}

export function formatJsonToMarkdownCodeBlock(jsonObj: any, lang: string = 'json'): string {
    if (typeof jsonObj === 'string') {
        try {
            // Try to parse if it's a JSON string, then stringify for consistent formatting
            jsonObj = JSON.parse(jsonObj);
        } catch (e) {
            // If it's not a valid JSON string, just use it as is (might be an error message or simple string)
            return `\`\`\`${lang}\n${jsonObj}\n\`\`\``;
        }
    }
    return `\`\`\`${lang}\n${JSON.stringify(jsonObj, null, 2)}\n\`\`\``;
}

// Helper function to format a single task into a Markdown string
export function formatTaskToMarkdown(task: any): string {
    if (!task) return "*No task details provided.*\n";
    let md = `### Task: ${escapeMarkdown(task.title || 'N/A')} (ID: \`${escapeMarkdown(task.task_id)}\`)\n`;
    md += `- **Plan ID:** \`${escapeMarkdown(task.plan_id)}\`\n`;
    md += `- **Task Number:** ${escapeMarkdown(task.task_number)}\n`;
    md += `- **Status:** ${escapeMarkdown(task.status || 'N/A')}\n`;
    if (task.description) md += `- **Description:** ${escapeMarkdown(task.description)}\n`;
    if (task.purpose) md += `- **Purpose:** ${escapeMarkdown(task.purpose)}\n`;
    if (task.action_description) md += `- **Action:** ${escapeMarkdown(task.action_description)}\n`;
    
    const formatJsonArrayField = (fieldName: string, arr: any[] | string | null | undefined) => {
        let items: string[] = [];
        if (typeof arr === 'string') {
            try { items = JSON.parse(arr); } catch { items = [arr]; }
        } else if (Array.isArray(arr)) {
            items = arr;
        }
        if (items.length > 0) md += `- **${fieldName}:** ${items.map(escapeMarkdown).join(', ')}\n`;
    };

    formatJsonArrayField('Files Involved', task.files_involved_parsed || task.files_involved_json || task.files_involved);
    formatJsonArrayField('Dependencies', task.dependencies_task_ids_parsed || task.dependencies_task_ids_json || task.dependencies_task_ids);
    formatJsonArrayField('Tools Required', task.tools_required_list_parsed || task.tools_required_list_json || task.tools_required_list);

    if (task.inputs_summary) md += `- **Inputs:** ${escapeMarkdown(task.inputs_summary)}\n`;
    if (task.outputs_summary) md += `- **Outputs:** ${escapeMarkdown(task.outputs_summary)}\n`;
    if (task.success_criteria_text) md += `- **Success Criteria:** ${escapeMarkdown(task.success_criteria_text)}\n`;
    if (task.estimated_effort_hours) md += `- **Estimated Effort:** ${escapeMarkdown(task.estimated_effort_hours)} hours\n`;
    if (task.assigned_to) md += `- **Assigned To:** ${escapeMarkdown(task.assigned_to)}\n`;
    if (task.verification_method) md += `- **Verification:** ${escapeMarkdown(task.verification_method)}\n`;
    if (task.creation_timestamp_iso) md += `- **Created:** ${escapeMarkdown(new Date(task.creation_timestamp_iso).toLocaleString())}\n`;
    if (task.last_updated_timestamp_iso) md += `- **Last Updated:** ${escapeMarkdown(new Date(task.last_updated_timestamp_iso).toLocaleString())}\n`;
    if (task.completion_timestamp_iso) md += `- **Completed:** ${escapeMarkdown(new Date(task.completion_timestamp_iso).toLocaleString())}\n`;
    
    const notes = task.notes_parsed || task.notes_json || task.notes;
    if (notes) {
        md += `- **Notes:**\n${formatJsonToMarkdownCodeBlock(notes)}\n`;
    }
    return md;
}

// Helper function to format a list of subtasks into a Markdown table
export function formatSubtasksListToMarkdownTable(subtasks: any[]): string {
    if (!subtasks || subtasks.length === 0) {
        return "*No subtasks found.*\n";
    }
    let md = "| Subtask ID | Title | Status | Parent Task ID |\n";
    md += "|------------|-------|--------|----------------|\n";
    subtasks.forEach(subtask => {
        md += `| \`${escapeMarkdown(subtask.subtask_id || 'N/A')}\` `
            + `| ${escapeMarkdown(subtask.title || 'N/A')} `
            + `| ${escapeMarkdown(subtask.status || 'N/A')} `
            + `| ${subtask.parent_task_id ? `\`${escapeMarkdown(subtask.parent_task_id)}\`` : '*N/A*'} |\n`;
    });
    return md;
}

// Helper function to format a list of tasks into a Markdown table
export function formatTasksListToMarkdownTable(tasks: any[], includeSubtasks: boolean = false): string {
    if (!tasks || tasks.length === 0) {
        return "*No tasks found.*\n";
    }
    let md = "| Task No. | Title | Status | Dependencies | Assigned To | Task ID |\n";
    md += "|----------|-------|--------|--------------|-------------|---------|\n";
    tasks.forEach(task => {
        const dependencies = task.dependencies_task_ids_parsed || (typeof task.dependencies_task_ids_json === 'string' ? JSON.parse(task.dependencies_task_ids_json) : task.dependencies_task_ids) || [];
        md += `| ${escapeMarkdown(task.task_number || 'N/A')} `
            + `| ${escapeMarkdown(task.title || 'N/A')} `
            + `| ${escapeMarkdown(task.status || 'N/A')} `
            + `| ${(dependencies.length > 0) ? dependencies.map((d:string) => `\`${escapeMarkdown(d)}\``).join(', ') : '*None*'} `
            + `| ${escapeMarkdown(task.assigned_to || 'N/A')} `
            + `| \`${escapeMarkdown(task.task_id || 'N/A')}\` |\n`;

        if (includeSubtasks && task.subtasks && Array.isArray(task.subtasks) && task.subtasks.length > 0) {
            md += `| | **Subtasks:** | | | | |\n`; // Placeholder for subtask section
            task.subtasks.forEach((subtask: any, index: number) => {
                 md += `| | ${index === 0 ? '' : '  '}└ \`${escapeMarkdown(subtask.subtask_id)}\`: ${escapeMarkdown(subtask.title)} (${escapeMarkdown(subtask.status)}) | | | | |\n`;
            });
        }
    });
    return md;
}

// Helper function to format a single plan into a Markdown string
export function formatPlanToMarkdown(plan: any, tasks: any[] = [], planSubtasks: any[] = []): string {
    if (!plan) return "*No plan details provided.*\n";
    let md = `## Plan: ${escapeMarkdown(plan.title || 'N/A')} (ID: \`${escapeMarkdown(plan.plan_id)}\`)\n`;
    md += `- **Agent ID:** \`${escapeMarkdown(plan.agent_id)}\`\n`;
    md += `- **Status:** ${escapeMarkdown(plan.status || 'N/A')}\n`;
    if (plan.overall_goal) md += `- **Overall Goal:** ${escapeMarkdown(plan.overall_goal)}\n`;
    md += `- **Version:** ${escapeMarkdown(plan.version || 1)}\n`;
    if (plan.creation_timestamp_iso) md += `- **Created:** ${escapeMarkdown(new Date(plan.creation_timestamp_iso).toLocaleString())}\n`;
    if (plan.last_updated_timestamp_iso) md += `- **Last Updated:** ${escapeMarkdown(new Date(plan.last_updated_timestamp_iso).toLocaleString())}\n`;
    if (plan.refined_prompt_id_associated) md += `- **Refined Prompt ID:** \`${escapeMarkdown(plan.refined_prompt_id_associated)}\`\n`;
    if (plan.analysis_report_id_referenced) md += `- **Analysis Report ID:** \`${escapeMarkdown(plan.analysis_report_id_referenced)}\`\n`;
    
    const metadata = plan.metadata_parsed || plan.metadata;
    if (metadata) {
        md += `- **Metadata:**\n${formatJsonToMarkdownCodeBlock(metadata)}\n`;
    }

    if (tasks && tasks.length > 0) {
        md += "\n### Tasks for this Plan:\n";
        md += formatTasksListToMarkdownTable(tasks, true); // Pass true to include subtasks in the table
    } else {
        md += "\n*No tasks associated with this plan currently.*\n";
    }

    if (planSubtasks && planSubtasks.length > 0) {
        md += "\n### Subtasks for this Plan (not linked to specific parent tasks):\n";
        md += formatSubtasksListToMarkdownTable(planSubtasks);
    }
    return md;
}

// Helper function to format a list of plans into a Markdown table
export function formatPlansListToMarkdownTable(plans: any[]): string {
    if (!plans || plans.length === 0) {
        return "*No plans found.*\n";
    }
    let md = "| Plan ID | Title | Status | Goal (Summary) | Version | Created |\n";
    md += "|---------|-------|--------|----------------|---------|---------|\n";
    plans.forEach(plan => {
        const goalSummary = (plan.overall_goal || 'N/A').substring(0, 30) + ((plan.overall_goal && plan.overall_goal.length > 30) ? '...' : '');
        md += `| \`${escapeMarkdown(plan.plan_id)}\` `
            + `| ${escapeMarkdown(plan.title || 'N/A')} `
            + `| ${escapeMarkdown(plan.status || 'N/A')} `
            + `| ${escapeMarkdown(goalSummary)} `
            + `| ${escapeMarkdown(plan.version || 1)} `
            + `| ${plan.creation_timestamp_iso ? escapeMarkdown(new Date(plan.creation_timestamp_iso).toLocaleDateString()) : '*N/A*'} |\n`;
    });
    return md;
}

export function formatCorrectionLogToMarkdown(log: any): string {
    if (!log) return "*No correction log details provided.*\n";
    let md = `### Correction Log (ID: \`${escapeMarkdown(log.correction_id)}\`)\n`;
    md += `- **Agent ID:** \`${escapeMarkdown(log.agent_id)}\`\n`;
    md += `- **Type:** ${escapeMarkdown(log.correction_type)}\n`;
    if (log.original_entry_id) md += `- **Original Entry ID:** \`${escapeMarkdown(log.original_entry_id)}\`\n`;
    if (log.original_value_parsed || log.original_value_json) {
        md += `- **Original Value:**\n${formatJsonToMarkdownCodeBlock(log.original_value_parsed || log.original_value_json)}\n`;
    }
    if (log.corrected_value_parsed || log.corrected_value_json) {
        md += `- **Corrected Value:**\n${formatJsonToMarkdownCodeBlock(log.corrected_value_parsed || log.corrected_value_json)}\n`;
    }
    if (log.reason) md += `- **Reason:** ${escapeMarkdown(log.reason)}\n`;
    if (log.correction_summary) md += `- **Summary:** ${escapeMarkdown(log.correction_summary)}\n`;
    md += `- **Applied Automatically:** ${log.applied_automatically ? 'Yes' : 'No'}\n`;
    md += `- **Status:** ${escapeMarkdown(log.status)}\n`;
    if (log.creation_timestamp_iso) md += `- **Created:** ${escapeMarkdown(new Date(log.creation_timestamp_iso).toLocaleString())}\n`;
    if (log.last_updated_timestamp_iso) md += `- **Last Updated:** ${escapeMarkdown(new Date(log.last_updated_timestamp_iso).toLocaleString())}\n`;
    return md;
}

export function formatToolExecutionLogToMarkdown(log: any): string {
    if (!log) return "*No tool execution log details provided.*\n";
    let md = `### Tool Execution Log (ID: \`${escapeMarkdown(log.log_id)}\`)\n`;
    md += `- **Agent ID:** \`${escapeMarkdown(log.agent_id)}\`\n`;
    md += `- **Tool Name:** ${escapeMarkdown(log.tool_name)}\n`;
    md += `- **Status:** ${escapeMarkdown(log.status)}\n`;
    if (log.plan_id) md += `- **Plan ID:** \`${escapeMarkdown(log.plan_id)}\`\n`;
    if (log.task_id) md += `- **Task ID:** \`${escapeMarkdown(log.task_id)}\`\n`;
    if (log.subtask_id) md += `- **Subtask ID:** \`${escapeMarkdown(log.subtask_id)}\`\n`;
    if (log.arguments_parsed || log.arguments_json) {
        md += `- **Arguments:**\n${formatJsonToMarkdownCodeBlock(log.arguments_parsed || log.arguments_json)}\n`;
    }
    if (log.output_summary) md += `- **Output Summary:** ${escapeMarkdown(log.output_summary)}\n`;
    if (log.execution_start_timestamp_iso) md += `- **Started:** ${escapeMarkdown(new Date(log.execution_start_timestamp_iso).toLocaleString())}\n`;
    if (log.execution_end_timestamp_iso) md += `- **Ended:** ${escapeMarkdown(new Date(log.execution_end_timestamp_iso).toLocaleString())}\n`;
    if (typeof log.duration_ms === 'number') md += `- **Duration:** ${escapeMarkdown(log.duration_ms)} ms\n`;
    if (log.step_number_executed) md += `- **Step Executed:** ${escapeMarkdown(log.step_number_executed)}\n`;
    if (log.plan_step_title) md += `- **Plan Step Title:** ${escapeMarkdown(log.plan_step_title)}\n`;
    return md;
}

export function formatTaskProgressLogToMarkdown(log: any): string {
    if (!log) return "*No task progress log details provided.*\n";
    let md = `### Task Progress Log (ID: \`${escapeMarkdown(log.progress_log_id)}\`)\n`;
    md += `- **Agent ID:** \`${escapeMarkdown(log.agent_id)}\`\n`;
    md += `- **Plan ID:** \`${escapeMarkdown(log.associated_plan_id)}\`\n`;
    md += `- **Task ID:** \`${escapeMarkdown(log.associated_task_id)}\`\n`;
    if (log.associated_subtask_id) md += `- **Subtask ID:** \`${escapeMarkdown(log.associated_subtask_id)}\`\n`;
    if (log.step_number_executed) md += `- **Step Executed:** ${escapeMarkdown(log.step_number_executed)}\n`;
    if (log.plan_step_title) md += `- **Plan Step Title:** ${escapeMarkdown(log.plan_step_title)}\n`;
    if (log.action_tool_used) md += `- **Tool Used:** ${escapeMarkdown(log.action_tool_used)}\n`;
    if (log.tool_parameters_summary_parsed || log.tool_parameters_summary_json) {
        md += `- **Tool Parameters:**\n${formatJsonToMarkdownCodeBlock(log.tool_parameters_summary_parsed || log.tool_parameters_summary_json)}\n`;
    }
    if (log.files_modified_list_parsed || log.files_modified_list_json) {
        const files = log.files_modified_list_parsed || (typeof log.files_modified_list_json === 'string' ? JSON.parse(log.files_modified_list_json) : []);
        if (files.length > 0) md += `- **Files Modified:** ${files.map((f:string) => `\`${escapeMarkdown(f)}\``).join(', ')}\n`;
    }
    if (log.change_summary_text) md += `- **Change Summary:** ${escapeMarkdown(log.change_summary_text)}\n`;
    md += `- **Execution Status:** ${escapeMarkdown(log.status_of_step_execution)}\n`;
    if (log.output_summary_or_error) md += `- **Output/Error:** ${escapeMarkdown(log.output_summary_or_error)}\n`;
    if (log.execution_timestamp_iso) md += `- **Executed At:** ${escapeMarkdown(new Date(log.execution_timestamp_iso).toLocaleString())}\n`;
    return md;
}

export function formatErrorLogToMarkdown(log: any): string {
    if (!log) return "*No error log details provided.*\n";
    let md = `### Error Log (ID: \`${escapeMarkdown(log.error_log_id)}\`)\n`;
    md += `- **Agent ID:** \`${escapeMarkdown(log.agent_id)}\`\n`;
    md += `- **Type:** ${escapeMarkdown(log.error_type)}\n`;
    md += `- **Message:** ${escapeMarkdown(log.error_message)}\n`;
    md += `- **Severity:** ${escapeMarkdown(log.severity)}\n`;
    md += `- **Status:** ${escapeMarkdown(log.status)}\n`;
    if (log.associated_plan_id) md += `- **Plan ID:** \`${escapeMarkdown(log.associated_plan_id)}\`\n`;
    if (log.associated_task_id) md += `- **Task ID:** \`${escapeMarkdown(log.associated_task_id)}\`\n`;
    if (log.associated_subtask_id) md += `- **Subtask ID:** \`${escapeMarkdown(log.associated_subtask_id)}\`\n`;
    if (log.associated_tool_execution_log_id) md += `- **Tool Execution Log ID:** \`${escapeMarkdown(log.associated_tool_execution_log_id)}\`\n`;
    if (log.source_file) md += `- **Source File:** \`${escapeMarkdown(log.source_file)}\`${log.source_line ? ` (Line: ${escapeMarkdown(log.source_line)})` : ''}\n`;
    if (log.stack_trace) md += `- **Stack Trace:**\n\`\`\`\n${log.stack_trace}\n\`\`\`\n`;
    if (log.resolution_details) md += `- **Resolution:** ${escapeMarkdown(log.resolution_details)}\n`;
    if (log.error_timestamp_iso) md += `- **Occurred At:** ${escapeMarkdown(new Date(log.error_timestamp_iso).toLocaleString())}\n`;
    return md;
}

export function formatSimpleMessage(message: string, title?: string): string {
    let md = "";
    if (title) {
        md += `### ${escapeMarkdown(title)}\n\n`;
    }
    md += `${escapeMarkdown(message)}\n`;
    return md;
}
