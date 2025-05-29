// src/utils/formatters.ts

// Minimal escape: only for characters that most commonly break lists or emphasis if not intended.
function escapeMinimalMarkdown(text: string | number | boolean | null | undefined): string {
    if (text === null || typeof text === 'undefined') {
        return '';
    }
    const stringText = String(text);
    // Escape only * and _ when they are not part of a deliberate markdown structure (e.g. in a URL)
    // This is a simplified approach. A more robust solution might involve more context.
    return stringText.replace(/([*_])/g, '\\$1');
}

// Function to present a value:
// - isCodeOrId: if true, wraps in single backticks (for IDs, paths, etc.)
// - isBlockContent: if true, wraps in triple backticks (for messages, stack traces)
// - otherwise, applies minimal escaping for general text.
function formatValue(value: any, options: { isCodeOrId?: boolean, isBlockContent?: boolean, lang?: string } = {}): string {
    if (value === null || typeof value === 'undefined') {
        return '*N/A*';
    }
    const stringValue = String(value);

    if (options.isCodeOrId) {
        // For IDs, paths, etc., that should be literal and monospaced.
        // Escape backticks within the string itself to avoid breaking the markdown.
        return `\`${stringValue.replace(/`/g, '\\`')}\``;
    }
    if (options.isBlockContent) {
        // For multi-line text like error messages or stack traces.
        const lang = options.lang || ''; // Default to no language specified for plain text blocks
        return `\`\`\`${lang}\n${stringValue}\n\`\`\``;
    }
    // For general text content.
    return escapeMinimalMarkdown(stringValue);
}

// Formats a message where the body is already valid Markdown.
// The title is treated as plain text and will be escaped.
export function formatMarkdownMessage(messageBody: string, title?: string): string {
    let md = "";
    if (title) {
        md += `### ${escapeMinimalMarkdown(title)}\n\n`;
    }
    md += `${messageBody}\n`; // Assumes messageBody is already valid Markdown
    return md;
}

// Formats a plain text message into a Markdown paragraph.
// Both title and the message itself are treated as plain text and will be escaped.
export function formatPlainTextAsMarkdownParagraph(plainTextMessage: string, title?: string): string {
    let md = "";
    if (title) {
        md += `### ${escapeMinimalMarkdown(title)}\n\n`;
    }
    md += `${escapeMinimalMarkdown(plainTextMessage)}\n`;
    return md;
}

export function formatSimpleMessage(messageBody: string, title?: string): string {
    let md = "";
    if (title) {
        md += `### ${escapeMinimalMarkdown(title)}\n\n`;
    }
    // The messageBody for simple messages is often already Markdown or contains backticked IDs.
    // Avoid double-escaping here.
    md += `${messageBody}\n`;
    return md;
}

export function formatObjectToMarkdown(obj: any, indentLevel: number = 0): string {
    let md = '';
    const indent = '  '.repeat(indentLevel);

    if (obj === null || typeof obj === 'undefined') {
        return `${indent}- ${formatValue(null)}\n`; // Uses the N/A formatting
    }

    // Handle primitive types and Dates directly
    if (typeof obj !== 'object' || obj instanceof Date) {
        return `${indent}- ${formatValue(obj instanceof Date ? obj.toLocaleString() : obj)}\n`;
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
                // Array items are formatted as simple values
                md += `${indent}- ${formatValue(item instanceof Date ? item.toLocaleString() : item)}\n`;
            }
        });
    } else { // Is an object
        const keys = Object.keys(obj);
        if (keys.length === 0) {
            return `${indent}- *Empty object*\n`;
        }
        keys.forEach(key => {
            const value = obj[key];
            // Key is formatted as bold plain text
            md += `${indent}- **${escapeMinimalMarkdown(key)}:** `;
            if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
                md += `\n`; // Newline before nested object/array
                md += formatObjectToMarkdown(value, indentLevel + 1);
            } else {
                // Object values are formatted as simple values
                md += `${formatValue(value instanceof Date ? value.toLocaleString() : value)}\n`;
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

export function formatTaskToMarkdown(task: any): string {
    if (!task) return "*No task details provided.*\n";
    // Each task detail as a sub-list item for clarity
    let md = `- **Task:** ${formatValue(task.title || 'N/A')} (ID: ${formatValue(task.task_id, {isCodeOrId: true})})\n`;
    md += `  - **Plan ID:** ${formatValue(task.plan_id, {isCodeOrId: true})}\n`;
    md += `  - **Task Number:** ${formatValue(task.task_number)}\n`;
    md += `  - **Status:** ${formatValue(task.status || 'N/A')}\n`;
    if (task.description) md += `  - **Description:** ${formatValue(task.description)}\n`;
    if (task.purpose) md += `  - **Purpose:** ${formatValue(task.purpose)}\n`;
    if (task.action_description) md += `  - **Action:** ${formatValue(task.action_description)}\n`;

    const formatJsonArrayField = (fieldName: string, arrInput: any) => {
        let items: string[] = [];
        if (typeof arrInput === 'string') {
            try { items = JSON.parse(arrInput); } catch { items = [arrInput]; } // Treat as single item if not JSON
        } else if (Array.isArray(arrInput)) {
            items = arrInput;
        }
        if (items.length > 0) {
            md += `  - **${escapeMinimalMarkdown(fieldName)}:** ${items.map(i => formatValue(i, {isCodeOrId: true})).join(', ')}\n`;
        }
    };

    formatJsonArrayField('Files Involved', task.files_involved_parsed || task.files_involved_json || task.files_involved);
    formatJsonArrayField('Dependencies', task.dependencies_task_ids_parsed || task.dependencies_task_ids_json || task.dependencies_task_ids);
    formatJsonArrayField('Tools Required', task.tools_required_list_parsed || task.tools_required_list_json || task.tools_required_list);

    if (task.inputs_summary) md += `  - **Inputs:** ${formatValue(task.inputs_summary)}\n`;
    if (task.outputs_summary) md += `  - **Outputs:** ${formatValue(task.outputs_summary)}\n`;
    if (task.success_criteria_text) md += `  - **Success Criteria:** ${formatValue(task.success_criteria_text)}\n`;
    if (task.estimated_effort_hours) md += `  - **Estimated Effort:** ${formatValue(task.estimated_effort_hours)} hours\n`;
    if (task.assigned_to) md += `  - **Assigned To:** ${formatValue(task.assigned_to)}\n`;
    if (task.verification_method) md += `  - **Verification:** ${formatValue(task.verification_method)}\n`;
    if (task.creation_timestamp_iso) md += `  - **Created:** ${new Date(task.creation_timestamp_iso).toLocaleString()}\n`;
    if (task.last_updated_timestamp_iso) md += `  - **Last Updated:** ${new Date(task.last_updated_timestamp_iso).toLocaleString()}\n`;
    if (task.completion_timestamp_iso) md += `  - **Completed:** ${new Date(task.completion_timestamp_iso).toLocaleString()}\n`;

    const notes = task.notes_parsed || task.notes_json || task.notes;
    if (notes) {
        // Notes are often structured JSON, so a code block is appropriate.
        md += `  - **Notes:**\n${formatJsonToMarkdownCodeBlock(notes).split('\n').map(line => `    ${line}`).join('\n')}\n`;
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
        md += `| ${formatValue(subtask.subtask_id || 'N/A', {isCodeOrId: true})} `
            + `| ${formatValue(subtask.title || 'N/A')} `
            + `| ${formatValue(subtask.status || 'N/A')} `
            + `| ${subtask.parent_task_id ? formatValue(subtask.parent_task_id, {isCodeOrId: true}) : '*N/A*'} |\n`;
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

        md += `| ${formatValue(task.task_number || 'N/A')} `
            + `| ${formatValue(task.title || 'N/A')} `
            + `| ${formatValue(task.status || 'N/A')} `
            + `| ${(dependencies.length > 0) ? dependencies.map((d:string) => formatValue(d, {isCodeOrId: true})).join(', ') : '*None*'} `
            + `| ${formatValue(task.assigned_to || 'N/A')} `
            + `| ${formatValue(task.task_id || 'N/A', {isCodeOrId: true})} |\n`;

        if (includeSubtasks && task.subtasks && Array.isArray(task.subtasks) && task.subtasks.length > 0) {
            // For subtasks within a table, it's tricky. A simple list under the row might be better than trying to fit into table cells.
            // Or, if it must be in table, it needs careful cell spanning or just listing in a notes-like column.
            // For now, keeping it simple, but this might look odd in some markdown renderers.
            md += `| | **Subtasks:** | | | | |\n`;
            task.subtasks.forEach((subtask: any, index: number) => {
                 md += `| | ${index === 0 ? '' : '  '}└ ${formatValue(subtask.subtask_id, {isCodeOrId: true})}: ${formatValue(subtask.title)} (${formatValue(subtask.status)}) | | | | |\n`;
            });
        }
    });
    return md;
}

export function formatPlanToMarkdown(plan: any, tasks: any[] = [], planSubtasks: any[] = []): string {
    if (!plan) return "*No plan details provided.*\n";
    let md = `## Plan: ${formatValue(plan.title || 'N/A')} (ID: ${formatValue(plan.plan_id, {isCodeOrId: true})})\n`;
    md += `- **Agent ID:** ${formatValue(plan.agent_id, {isCodeOrId: true})}\n`;
    md += `- **Status:** ${formatValue(plan.status || 'N/A')}\n`;
    if (plan.overall_goal) md += `- **Overall Goal:** ${formatValue(plan.overall_goal)}\n`;
    md += `- **Version:** ${formatValue(plan.version || 1)}\n`;
    if (plan.creation_timestamp_iso) md += `- **Created:** ${new Date(plan.creation_timestamp_iso).toLocaleString()}\n`;
    if (plan.last_updated_timestamp_iso) md += `- **Last Updated:** ${new Date(plan.last_updated_timestamp_iso).toLocaleString()}\n`;
    if (plan.refined_prompt_id_associated) md += `- **Refined Prompt ID:** ${formatValue(plan.refined_prompt_id_associated, {isCodeOrId: true})}\n`;
    if (plan.analysis_report_id_referenced) md += `- **Analysis Report ID:** ${formatValue(plan.analysis_report_id_referenced, {isCodeOrId: true})}\n`;

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
        const goalSummary = (String(plan.overall_goal || 'N/A')).substring(0, 30) + ((plan.overall_goal && plan.overall_goal.length > 30) ? '...' : '');
        md += `| ${formatValue(plan.plan_id, {isCodeOrId: true})} `
            + `| ${formatValue(plan.title || 'N/A')} `
            + `| ${formatValue(plan.status || 'N/A')} `
            + `| ${formatValue(goalSummary)} ` // Goal summary is plain text
            + `| ${formatValue(plan.version || 1)} `
            + `| ${plan.creation_timestamp_iso ? new Date(plan.creation_timestamp_iso).toLocaleDateString() : '*N/A*'} |\n`;
    });
    return md;
}

export function formatCorrectionLogToMarkdown(log: any): string {
    if (!log) return "*No correction log details provided.*\n";
    // Each log as a list item
    let md = `- **Correction ID:** ${formatValue(log.correction_id, {isCodeOrId: true})}\n`;
    md += `  - **Agent ID:** ${formatValue(log.agent_id, {isCodeOrId: true})}\n`;
    md += `  - **Type:** ${formatValue(log.correction_type)}\n`;
    if (log.original_entry_id) md += `  - **Original Entry ID:** ${formatValue(log.original_entry_id, {isCodeOrId: true})}\n`;

    const originalValue = log.original_value_parsed || log.original_value_json;
    if (originalValue) {
        md += `  - **Original Value:**\n${formatJsonToMarkdownCodeBlock(originalValue).split('\n').map(line => `    ${line}`).join('\n')}\n`;
    }
    const correctedValue = log.corrected_value_parsed || log.corrected_value_json;
    if (correctedValue) {
        md += `  - **Corrected Value:**\n${formatJsonToMarkdownCodeBlock(correctedValue).split('\n').map(line => `    ${line}`).join('\n')}\n`;
    }
    if (log.reason) {
        md += `  - **Reason:**\n`;
        md += `${String(log.reason).split('\n').map(line => `    > ${line}`).join('\n')}\n`;
    }
    if (log.correction_summary) {
        md += `  - **Summary of Correction:**\n`; // Clarified label
        md += `${String(log.correction_summary).split('\n').map(line => `    > ${line}`).join('\n')}\n`;
    }
    md += `  - **Applied Automatically:** ${log.applied_automatically ? 'Yes' : 'No'}\n`;
    md += `  - **Status:** ${formatValue(log.status)}\n`;
    if (log.creation_timestamp_iso) md += `  - **Created:** ${new Date(log.creation_timestamp_iso).toLocaleString()}\n`;
    if (log.last_updated_timestamp_iso) md += `  - **Last Updated:** ${new Date(log.last_updated_timestamp_iso).toLocaleString()}\n`;
    return md;
}

export function formatToolExecutionLogToMarkdown(log: any): string {
    if (!log) return "*No tool execution log details provided.*\n";
    // Each log as a list item
    let md = `- **Log ID:** ${formatValue(log.log_id, {isCodeOrId: true})}\n`;
    md += `  - **Agent ID:** ${formatValue(log.agent_id, {isCodeOrId: true})}\n`;
    md += `  - **Tool Name:** ${formatValue(log.tool_name, {isCodeOrId: true})}\n`;
    md += `  - **Status:** ${formatValue(log.status)}\n`;
    if (log.plan_id) md += `  - **Plan ID:** ${formatValue(log.plan_id, {isCodeOrId: true})}\n`;
    if (log.task_id) md += `  - **Task ID:** ${formatValue(log.task_id, {isCodeOrId: true})}\n`;
    if (log.subtask_id) md += `  - **Subtask ID:** ${formatValue(log.subtask_id, {isCodeOrId: true})}\n`;

    const args = log.arguments_parsed || log.arguments_json;
    if (args) {
        md += `  - **Arguments:**\n${formatJsonToMarkdownCodeBlock(args).split('\n').map(line => `    ${line}`).join('\n')}\n`;
    }
    if (log.output_summary) {
        md += `  - **Output Summary:**\n${formatValue(log.output_summary, {isBlockContent: true, lang: 'text'}).split('\n').map(line => `    ${line}`).join('\n')}\n`;
    }
    if (log.execution_start_timestamp_iso) md += `  - **Started:** ${new Date(log.execution_start_timestamp_iso).toLocaleString()}\n`;
    if (log.execution_end_timestamp_iso) md += `  - **Ended:** ${new Date(log.execution_end_timestamp_iso).toLocaleString()}\n`;
    if (typeof log.duration_ms === 'number') md += `  - **Duration:** ${log.duration_ms} ms\n`;
    if (log.step_number_executed) md += `  - **Step Executed:** ${formatValue(log.step_number_executed)}\n`;
    if (log.plan_step_title) md += `  - **Plan Step Title:** ${formatValue(log.plan_step_title)}\n`;
    return md;
}

export function formatTaskProgressLogToMarkdown(log: any): string {
    if (!log) return "*No task progress log details provided.*\n";
    // Each log as a list item
    let md = `- **Progress Log ID:** ${formatValue(log.progress_log_id, {isCodeOrId: true})}\n`;
    md += `  - **Agent ID:** ${formatValue(log.agent_id, {isCodeOrId: true})}\n`;
    md += `  - **Plan ID:** ${formatValue(log.associated_plan_id, {isCodeOrId: true})}\n`;
    md += `  - **Task ID:** ${formatValue(log.associated_task_id, {isCodeOrId: true})}\n`;
    if (log.associated_subtask_id) md += `  - **Subtask ID:** ${formatValue(log.associated_subtask_id, {isCodeOrId: true})}\n`;
    if (log.step_number_executed) md += `  - **Step Executed:** ${formatValue(log.step_number_executed)}\n`;
    if (log.plan_step_title) md += `  - **Plan Step Title:** ${formatValue(log.plan_step_title)}\n`;
    if (log.action_tool_used) md += `  - **Tool Used:** ${formatValue(log.action_tool_used, {isCodeOrId: true})}\n`;

    const toolParams = log.tool_parameters_summary_parsed || log.tool_parameters_summary_json;
    if (toolParams) {
        md += `  - **Tool Parameters:**\n${formatJsonToMarkdownCodeBlock(toolParams).split('\n').map(line => `    ${line}`).join('\n')}\n`;
    }

    const filesModifiedInput = log.files_modified_list_parsed || log.files_modified_list_json;
    let filesModified: string[] = [];
     if (typeof filesModifiedInput === 'string') {
        try { filesModified = JSON.parse(filesModifiedInput); } catch { filesModified = [filesModifiedInput];}
    } else if (Array.isArray(filesModifiedInput)) {
        filesModified = filesModifiedInput;
    }
    if (filesModified.length > 0) md += `  - **Files Modified:** ${filesModified.map((f:string) => formatValue(f, {isCodeOrId: true})).join(', ')}\n`;

    if (log.change_summary_text) md += `  - **Change Summary:** ${formatValue(log.change_summary_text)}\n`;
    md += `  - **Execution Status:** ${formatValue(log.status_of_step_execution)}\n`;
    if (log.output_summary_or_error) {
        md += `  - **Output/Error:**\n${formatValue(log.output_summary_or_error, {isBlockContent: true, lang: 'text'}).split('\n').map(line => `    ${line}`).join('\n')}\n`;
    }
    if (log.execution_timestamp_iso) md += `  - **Executed At:** ${new Date(log.execution_timestamp_iso).toLocaleString()}\n`;
    return md;
}

export function formatErrorLogToMarkdown(log: any): string {
    if (!log) return "*No error log details provided.*\n";

    // Main entry as a list item for better structure when multiple logs are displayed.
    let md = `- **Error ID:** ${formatValue(log.error_log_id, { isCodeOrId: true })}\n`;
    md += `  - **Agent ID:** ${formatValue(log.agent_id, { isCodeOrId: true })}\n`;
    md += `  - **Type:** ${formatValue(log.error_type)}\n`;
    md += `  - **Message:**\n${formatValue(log.error_message, { isBlockContent: true, lang: 'text' }).split('\n').map(line => `    ${line}`).join('\n')}\n`; // Indent block
    md += `  - **Severity:** ${formatValue(log.severity)}\n`;
    md += `  - **Status:** ${formatValue(log.status)}\n`;
    if (log.associated_plan_id) md += `  - **Plan ID:** ${formatValue(log.associated_plan_id, { isCodeOrId: true })}\n`;
    if (log.associated_task_id) md += `  - **Task ID:** ${formatValue(log.associated_task_id, { isCodeOrId: true })}\n`;
    if (log.associated_subtask_id) md += `  - **Subtask ID:** ${formatValue(log.associated_subtask_id, { isCodeOrId: true })}\n`;
    if (log.associated_tool_execution_log_id) md += `  - **Tool Log ID:** ${formatValue(log.associated_tool_execution_log_id, { isCodeOrId: true })}\n`;
    if (log.source_file) {
        md += `  - **Source:** ${formatValue(log.source_file, { isCodeOrId: true })}${log.source_line ? ` (Line: ${log.source_line})` : ''}\n`;
    }
    if (log.stack_trace) {
        md += `  - **Stack Trace:**\n${formatValue(log.stack_trace, { isBlockContent: true }).split('\n').map(line => `    ${line}`).join('\n')}\n`; // Indent block
    }
    if (log.resolution_details) md += `  - **Resolution:** ${formatValue(log.resolution_details)}\n`;
    if (log.error_timestamp_iso) md += `  - **Occurred At:** ${new Date(log.error_timestamp_iso).toLocaleString()}\n`;
    return md;
}
