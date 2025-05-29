// src/utils/formatters.ts

// Helper function to escape Markdown special characters from PLAIN TEXT
function escapePlainTextForMarkdown(text: string | number | boolean | null | undefined): string {
    if (text === null || typeof text === 'undefined') {
        return '';
    }
    const stringText = String(text);
    // Escape: \, *, _, {, }, [, ], (, ), #, +, -, ., !
    // Backticks (`) are intentionally NOT escaped here, as they are often used for inline code.
    // If a string is intended to be raw text within Markdown, it should be passed through this.
    return stringText.replace(/([\\*_{}[\]()#+-.!])/g, '\\$1');
}

// Formats a message where the body is already valid Markdown.
// The title is treated as plain text and will be escaped.
export function formatMarkdownMessage(messageBody: string, title?: string): string {
    let md = "";
    if (title) {
        md += `### ${escapePlainTextForMarkdown(title)}\n\n`;
    }
    md += `${messageBody}\n`; // Assumes messageBody is already valid Markdown
    return md;
}

// Formats a plain text message into a Markdown paragraph.
// Both title and the message itself are treated as plain text and will be escaped.
export function formatPlainTextAsMarkdownParagraph(plainTextMessage: string, title?: string): string {
    let md = "";
    if (title) {
        md += `### ${escapePlainTextForMarkdown(title)}\n\n`;
    }
    md += `${escapePlainTextForMarkdown(plainTextMessage)}\n`;
    return md;
}

// Formats a simple message where the body is already a Markdown string.
// The title is treated as plain text and will be escaped.
// This is used for messages where the content is already formatted with Markdown,
// and we don't want to double-escape it.
export function formatSimpleMessage(messageBody: string, title?: string): string {
    let md = "";
    if (title) {
        md += `### ${escapePlainTextForMarkdown(title)}\n\n`;
    }
    md += `${messageBody}\n`;
    return md;
}


// Helper function to format a generic object into a Markdown string
// Values within the object will be escaped if they are simple types.
// Nested objects/arrays will be recursively formatted.
export function formatObjectToMarkdown(obj: any, indentLevel: number = 0): string {
    let md = '';
    const indent = '  '.repeat(indentLevel);

    if (obj === null || typeof obj === 'undefined') {
        return `${indent}- *N/A*\n`;
    }

    if (typeof obj !== 'object' || obj instanceof Date) {
        return `${indent}- ${escapePlainTextForMarkdown(obj instanceof Date ? obj.toLocaleString() : obj)}\n`;
    }

    if (Array.isArray(obj)) {
        if (obj.length === 0) {
            return `${indent}- *Empty array*\n`;
        }
        obj.forEach((item) => {
            if (typeof item === 'object' && item !== null && !(item instanceof Date)) {
                md += `${indent}- Array Item:\n`; // Indicate it's an item in an array
                md += formatObjectToMarkdown(item, indentLevel + 1);
            } else {
                md += `${indent}- ${escapePlainTextForMarkdown(item instanceof Date ? item.toLocaleString() : item)}\n`;
            }
        });
    } else { // Is an object
        const keys = Object.keys(obj);
        if (keys.length === 0) {
            return `${indent}- *Empty object*\n`;
        }
        keys.forEach(key => {
            const value = obj[key];
            md += `${indent}- **${escapePlainTextForMarkdown(key)}:** `;
            if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
                md += `\n`; // Newline before nested object/array
                md += formatObjectToMarkdown(value, indentLevel + 1);
            } else {
                md += `${escapePlainTextForMarkdown(value instanceof Date ? value.toLocaleString() : value)}\n`;
            }
        });
    }
    return md;
}

export function formatJsonToMarkdownCodeBlock(data: any, lang: string = 'json'): string {
    let jsonDataString: string;
    if (typeof data === 'string') {
        try {
            // If it's a string that is valid JSON, parse and re-stringify for pretty printing
            const parsed = JSON.parse(data);
            jsonDataString = JSON.stringify(parsed, null, 2);
        } catch (e) {
            // If it's a string but not valid JSON (e.g. a plain text message or diff output)
            jsonDataString = data;
            if (lang === 'json') lang = 'text'; // Adjust language if it's not really JSON
        }
    } else {
        // If it's already an object/array
        jsonDataString = JSON.stringify(data, null, 2);
    }
    return `\`\`\`${lang}\n${jsonDataString}\n\`\`\``;
}


// Specific formatters for complex objects like plans, tasks, logs
// These will use formatJsonToMarkdownCodeBlock for JSON parts and escapePlainTextForMarkdown for simple fields.

export function formatTaskToMarkdown(task: any): string {
    if (!task) return "*No task details provided.*\n";
    let md = `### Task: ${escapePlainTextForMarkdown(task.title || 'N/A')} (ID: \`${escapePlainTextForMarkdown(task.task_id)}\`)\n`;
    md += `- **Plan ID:** \`${escapePlainTextForMarkdown(task.plan_id)}\`\n`;
    md += `- **Task Number:** ${escapePlainTextForMarkdown(task.task_number)}\n`;
    md += `- **Status:** ${escapePlainTextForMarkdown(task.status || 'N/A')}\n`;
    if (task.description) md += `- **Description:** ${escapePlainTextForMarkdown(task.description)}\n`;
    if (task.purpose) md += `- **Purpose:** ${escapePlainTextForMarkdown(task.purpose)}\n`;
    if (task.action_description) md += `- **Action:** ${escapePlainTextForMarkdown(task.action_description)}\n`;
    
    const formatJsonArrayField = (fieldName: string, arrInput: any) => {
        let items: string[] = [];
        if (typeof arrInput === 'string') {
            try { items = JSON.parse(arrInput); } catch { items = [arrInput]; }
        } else if (Array.isArray(arrInput)) {
            items = arrInput;
        }
        if (items.length > 0) md += `- **${escapePlainTextForMarkdown(fieldName)}:** ${items.map(i => `\`${escapePlainTextForMarkdown(i)}\``).join(', ')}\n`;
    };

    formatJsonArrayField('Files Involved', task.files_involved_parsed || task.files_involved_json || task.files_involved);
    formatJsonArrayField('Dependencies', task.dependencies_task_ids_parsed || task.dependencies_task_ids_json || task.dependencies_task_ids);
    formatJsonArrayField('Tools Required', task.tools_required_list_parsed || task.tools_required_list_json || task.tools_required_list);

    if (task.inputs_summary) md += `- **Inputs:** ${escapePlainTextForMarkdown(task.inputs_summary)}\n`;
    if (task.outputs_summary) md += `- **Outputs:** ${escapePlainTextForMarkdown(task.outputs_summary)}\n`;
    if (task.success_criteria_text) md += `- **Success Criteria:** ${escapePlainTextForMarkdown(task.success_criteria_text)}\n`;
    if (task.estimated_effort_hours) md += `- **Estimated Effort:** ${escapePlainTextForMarkdown(task.estimated_effort_hours)} hours\n`;
    if (task.assigned_to) md += `- **Assigned To:** ${escapePlainTextForMarkdown(task.assigned_to)}\n`;
    if (task.verification_method) md += `- **Verification:** ${escapePlainTextForMarkdown(task.verification_method)}\n`;
    if (task.creation_timestamp_iso) md += `- **Created:** ${escapePlainTextForMarkdown(new Date(task.creation_timestamp_iso).toLocaleString())}\n`;
    if (task.last_updated_timestamp_iso) md += `- **Last Updated:** ${escapePlainTextForMarkdown(new Date(task.last_updated_timestamp_iso).toLocaleString())}\n`;
    if (task.completion_timestamp_iso) md += `- **Completed:** ${escapePlainTextForMarkdown(new Date(task.completion_timestamp_iso).toLocaleString())}\n`;
    
    const notes = task.notes_parsed || task.notes_json || task.notes;
    if (notes) {
        md += `- **Notes:**\n${formatJsonToMarkdownCodeBlock(notes)}\n`;
    }
    return md;
}

export function formatSubtasksListToMarkdownTable(subtasks: any[]): string {
    if (!subtasks || subtasks.length === 0) {
        return "*No subtasks found.*\n";
    }
    let md = "| Subtask ID | Title | Status | Parent Task ID |\n";
    md += "|------------|-------|--------|----------------|\n";
    subtasks.forEach(subtask => {
        md += `| \`${escapePlainTextForMarkdown(subtask.subtask_id || 'N/A')}\` `
            + `| ${escapePlainTextForMarkdown(subtask.title || 'N/A')} `
            + `| ${escapePlainTextForMarkdown(subtask.status || 'N/A')} `
            + `| ${subtask.parent_task_id ? `\`${escapePlainTextForMarkdown(subtask.parent_task_id)}\`` : '*N/A*'} |\n`;
    });
    return md;
}

export function formatTasksListToMarkdownTable(tasks: any[], includeSubtasks: boolean = false): string {
    if (!tasks || tasks.length === 0) {
        return "*No tasks found.*\n";
    }
    let md = "| Task No. | Title | Status | Dependencies | Assigned To | Task ID |\n";
    md += "|----------|-------|--------|--------------|-------------|---------|\n";
    tasks.forEach(task => {
        const dependenciesInput = task.dependencies_task_ids_parsed || task.dependencies_task_ids_json || task.dependencies_task_ids;
        let dependencies: string[] = [];
        if (typeof dependenciesInput === 'string') {
            try { dependencies = JSON.parse(dependenciesInput); } catch { dependencies = [dependenciesInput];}
        } else if (Array.isArray(dependenciesInput)) {
            dependencies = dependenciesInput;
        }

        md += `| ${escapePlainTextForMarkdown(task.task_number || 'N/A')} `
            + `| ${escapePlainTextForMarkdown(task.title || 'N/A')} `
            + `| ${escapePlainTextForMarkdown(task.status || 'N/A')} `
            + `| ${(dependencies.length > 0) ? dependencies.map((d:string) => `\`${escapePlainTextForMarkdown(d)}\``).join(', ') : '*None*'} `
            + `| ${escapePlainTextForMarkdown(task.assigned_to || 'N/A')} `
            + `| \`${escapePlainTextForMarkdown(task.task_id || 'N/A')}\` |\n`;

        if (includeSubtasks && task.subtasks && Array.isArray(task.subtasks) && task.subtasks.length > 0) {
            md += `| | **Subtasks:** | | | | |\n`;
            task.subtasks.forEach((subtask: any, index: number) => {
                 md += `| | ${index === 0 ? '' : '  '}└ \`${escapePlainTextForMarkdown(subtask.subtask_id)}\`: ${escapePlainTextForMarkdown(subtask.title)} (${escapePlainTextForMarkdown(subtask.status)}) | | | | |\n`;
            });
        }
    });
    return md;
}

export function formatPlanToMarkdown(plan: any, tasks: any[] = [], planSubtasks: any[] = []): string {
    if (!plan) return "*No plan details provided.*\n";
    let md = `## Plan: ${escapePlainTextForMarkdown(plan.title || 'N/A')} (ID: \`${escapePlainTextForMarkdown(plan.plan_id)}\`)\n`;
    md += `- **Agent ID:** \`${escapePlainTextForMarkdown(plan.agent_id)}\`\n`;
    md += `- **Status:** ${escapePlainTextForMarkdown(plan.status || 'N/A')}\n`;
    if (plan.overall_goal) md += `- **Overall Goal:** ${escapePlainTextForMarkdown(plan.overall_goal)}\n`;
    md += `- **Version:** ${escapePlainTextForMarkdown(plan.version || 1)}\n`;
    if (plan.creation_timestamp_iso) md += `- **Created:** ${escapePlainTextForMarkdown(new Date(plan.creation_timestamp_iso).toLocaleString())}\n`;
    if (plan.last_updated_timestamp_iso) md += `- **Last Updated:** ${escapePlainTextForMarkdown(new Date(plan.last_updated_timestamp_iso).toLocaleString())}\n`;
    if (plan.refined_prompt_id_associated) md += `- **Refined Prompt ID:** \`${escapePlainTextForMarkdown(plan.refined_prompt_id_associated)}\`\n`;
    if (plan.analysis_report_id_referenced) md += `- **Analysis Report ID:** \`${escapePlainTextForMarkdown(plan.analysis_report_id_referenced)}\`\n`;
    
    const metadata = plan.metadata_parsed || plan.metadata;
    if (metadata) {
        md += `- **Metadata:**\n${formatJsonToMarkdownCodeBlock(metadata)}\n`;
    }

    if (tasks && tasks.length > 0) {
        md += "\n### Tasks for this Plan:\n";
        md += formatTasksListToMarkdownTable(tasks, true);
    } else {
        md += "\n*No tasks associated with this plan currently.*\n";
    }

    if (planSubtasks && planSubtasks.length > 0) {
        md += "\n### Subtasks for this Plan (not linked to specific parent tasks):\n";
        md += formatSubtasksListToMarkdownTable(planSubtasks);
    }
    return md;
}

export function formatPlansListToMarkdownTable(plans: any[]): string {
    if (!plans || plans.length === 0) {
        return "*No plans found.*\n";
    }
    let md = "| Plan ID | Title | Status | Goal (Summary) | Version | Created |\n";
    md += "|---------|-------|--------|----------------|---------|---------|\n";
    plans.forEach(plan => {
        const goalSummary = (plan.overall_goal || 'N/A').substring(0, 30) + ((plan.overall_goal && plan.overall_goal.length > 30) ? '...' : '');
        md += `| \`${escapePlainTextForMarkdown(plan.plan_id)}\` `
            + `| ${escapePlainTextForMarkdown(plan.title || 'N/A')} `
            + `| ${escapePlainTextForMarkdown(plan.status || 'N/A')} `
            + `| ${escapePlainTextForMarkdown(goalSummary)} `
            + `| ${escapePlainTextForMarkdown(plan.version || 1)} `
            + `| ${plan.creation_timestamp_iso ? escapePlainTextForMarkdown(new Date(plan.creation_timestamp_iso).toLocaleDateString()) : '*N/A*'} |\n`;
    });
    return md;
}

export function formatCorrectionLogToMarkdown(log: any): string {
    if (!log) return "*No correction log details provided.*\n";
    let md = `### Correction Log (ID: \`${escapePlainTextForMarkdown(log.correction_id)}\`)\n`;
    md += `- **Agent ID:** \`${escapePlainTextForMarkdown(log.agent_id)}\`\n`;
    md += `- **Type:** ${escapePlainTextForMarkdown(log.correction_type)}\n`;
    if (log.original_entry_id) md += `- **Original Entry ID:** \`${escapePlainTextForMarkdown(log.original_entry_id)}\`\n`;
    
    const originalValue = log.original_value_parsed || log.original_value_json;
    if (originalValue) {
        md += `- **Original Value:**\n${formatJsonToMarkdownCodeBlock(originalValue)}\n`;
    }
    const correctedValue = log.corrected_value_parsed || log.corrected_value_json;
    if (correctedValue) {
        md += `- **Corrected Value:**\n${formatJsonToMarkdownCodeBlock(correctedValue)}\n`;
    }
    if (log.reason) md += `- **Reason:** ${escapePlainTextForMarkdown(log.reason)}\n`;
    if (log.correction_summary) md += `- **Summary:** ${escapePlainTextForMarkdown(log.correction_summary)}\n`;
    md += `- **Applied Automatically:** ${log.applied_automatically ? 'Yes' : 'No'}\n`; // Boolean to Yes/No
    md += `- **Status:** ${escapePlainTextForMarkdown(log.status)}\n`;
    if (log.creation_timestamp_iso) md += `- **Created:** ${escapePlainTextForMarkdown(new Date(log.creation_timestamp_iso).toLocaleString())}\n`;
    if (log.last_updated_timestamp_iso) md += `- **Last Updated:** ${escapePlainTextForMarkdown(new Date(log.last_updated_timestamp_iso).toLocaleString())}\n`;
    return md;
}

export function formatToolExecutionLogToMarkdown(log: any): string {
    if (!log) return "*No tool execution log details provided.*\n";
    let md = `### Tool Execution Log (ID: \`${escapePlainTextForMarkdown(log.log_id)}\`)\n`;
    md += `- **Agent ID:** \`${escapePlainTextForMarkdown(log.agent_id)}\`\n`;
    md += `- **Tool Name:** \`${escapePlainTextForMarkdown(log.tool_name)}\`\n`;
    md += `- **Status:** ${escapePlainTextForMarkdown(log.status)}\n`;
    if (log.plan_id) md += `- **Plan ID:** \`${escapePlainTextForMarkdown(log.plan_id)}\`\n`;
    if (log.task_id) md += `- **Task ID:** \`${escapePlainTextForMarkdown(log.task_id)}\`\n`;
    if (log.subtask_id) md += `- **Subtask ID:** \`${escapePlainTextForMarkdown(log.subtask_id)}\`\n`;
    
    const args = log.arguments_parsed || log.arguments_json;
    if (args) {
        md += `- **Arguments:**\n${formatJsonToMarkdownCodeBlock(args)}\n`;
    }
    if (log.output_summary) md += `- **Output Summary:**\n\`\`\`text\n${log.output_summary}\n\`\`\`\n`;
    if (log.execution_start_timestamp_iso) md += `- **Started:** ${escapePlainTextForMarkdown(new Date(log.execution_start_timestamp_iso).toLocaleString())}\n`;
    if (log.execution_end_timestamp_iso) md += `- **Ended:** ${escapePlainTextForMarkdown(new Date(log.execution_end_timestamp_iso).toLocaleString())}\n`;
    if (typeof log.duration_ms === 'number') md += `- **Duration:** ${escapePlainTextForMarkdown(log.duration_ms)} ms\n`;
    if (log.step_number_executed) md += `- **Step Executed:** ${escapePlainTextForMarkdown(log.step_number_executed)}\n`;
    if (log.plan_step_title) md += `- **Plan Step Title:** ${escapePlainTextForMarkdown(log.plan_step_title)}\n`;
    return md;
}

export function formatTaskProgressLogToMarkdown(log: any): string {
    if (!log) return "*No task progress log details provided.*\n";
    let md = `### Task Progress Log (ID: \`${escapePlainTextForMarkdown(log.progress_log_id)}\`)\n`;
    md += `- **Agent ID:** \`${escapePlainTextForMarkdown(log.agent_id)}\`\n`;
    md += `- **Plan ID:** \`${escapePlainTextForMarkdown(log.associated_plan_id)}\`\n`;
    md += `- **Task ID:** \`${escapePlainTextForMarkdown(log.associated_task_id)}\`\n`;
    if (log.associated_subtask_id) md += `- **Subtask ID:** \`${escapePlainTextForMarkdown(log.associated_subtask_id)}\`\n`;
    if (log.step_number_executed) md += `- **Step Executed:** ${escapePlainTextForMarkdown(log.step_number_executed)}\n`;
    if (log.plan_step_title) md += `- **Plan Step Title:** ${escapePlainTextForMarkdown(log.plan_step_title)}\n`;
    if (log.action_tool_used) md += `- **Tool Used:** \`${escapePlainTextForMarkdown(log.action_tool_used)}\`\n`;
    
    const toolParams = log.tool_parameters_summary_parsed || log.tool_parameters_summary_json;
    if (toolParams) {
        md += `- **Tool Parameters:**\n${formatJsonToMarkdownCodeBlock(toolParams)}\n`;
    }
    
    const filesModifiedInput = log.files_modified_list_parsed || log.files_modified_list_json;
    let filesModified: string[] = [];
     if (typeof filesModifiedInput === 'string') {
        try { filesModified = JSON.parse(filesModifiedInput); } catch { filesModified = [filesModifiedInput];}
    } else if (Array.isArray(filesModifiedInput)) {
        filesModified = filesModifiedInput;
    }
    if (filesModified.length > 0) md += `- **Files Modified:** ${filesModified.map((f:string) => `\`${escapePlainTextForMarkdown(f)}\``).join(', ')}\n`;

    if (log.change_summary_text) md += `- **Change Summary:** ${escapePlainTextForMarkdown(log.change_summary_text)}\n`;
    md += `- **Execution Status:** ${escapePlainTextForMarkdown(log.status_of_step_execution)}\n`;
    if (log.output_summary_or_error) md += `- **Output/Error:**\n\`\`\`text\n${log.output_summary_or_error}\n\`\`\`\n`;
    if (log.execution_timestamp_iso) md += `- **Executed At:** ${escapePlainTextForMarkdown(new Date(log.execution_timestamp_iso).toLocaleString())}\n`;
    return md;
}

export function formatErrorLogToMarkdown(log: any): string {
    if (!log) return "*No error log details provided.*\n";
    let md = `### Error Log (ID: \`${escapePlainTextForMarkdown(log.error_log_id)}\`)\n`;
    md += `- **Agent ID:** \`${escapePlainTextForMarkdown(log.agent_id)}\`\n`;
    md += `- **Type:** ${escapePlainTextForMarkdown(log.error_type)}\n`;
    md += `- **Message:** ${escapePlainTextForMarkdown(log.error_message)}\n`;
    md += `- **Severity:** ${escapePlainTextForMarkdown(log.severity)}\n`;
    md += `- **Status:** ${escapePlainTextForMarkdown(log.status)}\n`;
    if (log.associated_plan_id) md += `- **Plan ID:** \`${escapePlainTextForMarkdown(log.associated_plan_id)}\`\n`;
    if (log.associated_task_id) md += `- **Task ID:** \`${escapePlainTextForMarkdown(log.associated_task_id)}\`\n`;
    if (log.associated_subtask_id) md += `- **Subtask ID:** \`${escapePlainTextForMarkdown(log.associated_subtask_id)}\`\n`;
    if (log.associated_tool_execution_log_id) md += `- **Tool Execution Log ID:** \`${escapePlainTextForMarkdown(log.associated_tool_execution_log_id)}\`\n`;
    if (log.source_file) md += `- **Source File:** \`${escapePlainTextForMarkdown(log.source_file)}\`${log.source_line ? ` (Line: ${escapePlainTextForMarkdown(log.source_line)})` : ''}\n`;
    if (log.stack_trace) md += `- **Stack Trace:**\n\`\`\`\n${log.stack_trace}\n\`\`\`\n`;
    if (log.resolution_details) md += `- **Resolution:** ${escapePlainTextForMarkdown(log.resolution_details)}\n`;
    if (log.error_timestamp_iso) md += `- **Occurred At:** ${escapePlainTextForMarkdown(new Date(log.error_timestamp_iso).toLocaleString())}\n`;
    return md;
}
