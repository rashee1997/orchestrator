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

// Helper to indent multi-line block content
function indentBlockContent(content: string, indentString: string = '    '): string {
    return content.split('\n').map(line => `${indentString}${line}`).join('\n');
}

// Helper to parse and normalize array fields from various sources (parsed, json string, or raw array)
function getParsedArrayField<T = string>(input: any): T[] {
    let items: T[] = [];
    if (typeof input === 'string') {
        try {
            items = JSON.parse(input);
            if (!Array.isArray(items)) { // Ensure parsed result is an array
                items = [items];
            }
        } catch {
            items = [input as T]; // Treat as single item if not JSON
        }
    } else if (Array.isArray(input)) {
        items = input;
    } else if (input !== null && typeof input !== 'undefined') {
        // Handle cases where it might be a single non-string item
        items = [input];
    }
    return items;
}

// Function to present a value:
// - isCodeOrId: if true, wraps in single backticks (for IDs, paths, etc.)
// - isBlockContent: if true, wraps in triple backticks (for messages, stack traces)
// - otherwise, applies minimal escaping for general text.
export function formatValue(value: any, options: { isCodeOrId?: boolean, isBlockContent?: boolean, lang?: string } = {}): string {
    if (value === null || typeof value === 'undefined') {
        return '*N/A*';
    }

    if (typeof value === 'boolean') {
        return `*${value ? 'Yes' : 'No'}*`;
    }

    if (value instanceof Date) {
        return `*${value.toLocaleString()}*`;
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
        return `${indent}- ${formatValue(obj)}\n`;
    }

    if (Array.isArray(obj)) {
        if (obj.length === 0) {
            return `${indent}- *Empty array*\n`;
        }
        obj.forEach((item) => {
            if (typeof item === 'object' && item !== null && !(item instanceof Date)) {
                // For nested objects/arrays within an array, directly indent them
                md += formatObjectToMarkdown(item, indentLevel + 1);
            } else {
                // Array items are formatted as simple values
                md += `${indent}- ${formatValue(item)}\n`;
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
                md += `${formatValue(value)}\n`;
            }
        });
    }
    return md;
}

export function formatJsonToMarkdownCodeBlock(data: any, lang: string = 'json', indentLevel: number = 0): string {
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
    const indent = ' '.repeat(indentLevel);
    return `${indent}\`\`\`${lang}\n${indentBlockContent(jsonDataString, indent)}\n${indent}\`\`\``;
}


// Specific formatters for complex objects like plans, tasks, logs

export function formatTaskToMarkdown(task: any): string {
    if (!task) return "*No task details provided.*\n";
    // Each task detail as a sub-list item for clarity
    let md = `- **Task:** ${formatValue(task.title || 'N/A')} (ID: ${formatValue(task.task_id, { isCodeOrId: true })})\n`;
    md += `  - **Plan ID:** ${formatValue(task.plan_id, { isCodeOrId: true })}\n`;
    md += `  - **Task Number:** ${formatValue(task.task_number)}\n`;
    md += `  - **Status:** ${formatValue(task.status || 'N/A')}\n`;
    if (task.description) md += `  - **Description:** ${formatValue(task.description)}\n`;
    if (task.purpose) md += `  - **Purpose:** ${formatValue(task.purpose)}\n`;
    if (task.action_description) md += `  - **Action:** ${formatValue(task.action_description)}\n`;

    const filesInvolved = getParsedArrayField(task.files_involved_parsed || task.files_involved_json || task.files_involved);
    if (filesInvolved.length > 0) md += `  - **Files Involved:** ${filesInvolved.map(i => formatValue(i, { isCodeOrId: true })).join(', ')}\n`;
    const dependencies = getParsedArrayField(task.dependencies_task_ids_parsed || task.dependencies_task_ids_json || task.dependencies_task_ids);
    if (dependencies.length > 0) md += `  - **Dependencies:** ${dependencies.map(i => formatValue(i, { isCodeOrId: true })).join(', ')}\n`;
    const toolsRequired = getParsedArrayField(task.tools_required_list_parsed || task.tools_required_list_json || task.tools_required_list);
    if (toolsRequired.length > 0) md += `  - **Tools Required:** ${toolsRequired.map(i => formatValue(i, { isCodeOrId: true })).join(', ')}\n`;

    if (task.inputs_summary) md += `  - **Inputs:** ${formatValue(task.inputs_summary)}\n`;
    if (task.outputs_summary) md += `  - **Outputs:** ${formatValue(task.outputs_summary)}\n`;
    if (task.success_criteria_text) md += `  - **Success Criteria:** ${formatValue(task.success_criteria_text)}\n`;
    if (task.estimated_effort_hours) md += `  - **Estimated Effort:** ${formatValue(task.estimated_effort_hours)} hours\n`;
    if (task.assigned_to) md += `  - **Assigned To:** ${formatValue(task.assigned_to)}\n`;
    if (task.verification_method) md += `  - **Verification:** ${formatValue(task.verification_method)}\n`;
    if (task.creation_timestamp_iso) md += `  - **Created:** ${formatValue(task.creation_timestamp_iso ? new Date(task.creation_timestamp_iso) : null)}\n`;
    if (task.last_updated_timestamp_iso) md += `  - **Last Updated:** ${formatValue(task.last_updated_timestamp_iso ? new Date(task.last_updated_timestamp_iso) : null)}\n`;
    if (task.completion_timestamp_iso) md += `  - **Completed:** ${formatValue(task.completion_timestamp_iso ? new Date(task.completion_timestamp_iso) : null)}\n`;

    if (task.code_content) {
        const files = getParsedArrayField(task.files_involved_parsed || task.files_involved_json || task.files_involved);
        const language = files.length > 0 ? (files[0].split('.').pop() || 'text') : 'text';
        const codeType = task.code_content.startsWith('--- a/') ? 'diff' : language;

        md += `  - **Proposed Code Changes:**\n`;
        md += `${formatJsonToMarkdownCodeBlock(task.code_content, codeType, 4)}\n`;
    }

    const notes = task.notes_parsed || task.notes_json || task.notes;
    if (notes) {
        // Notes are often structured JSON, so a code block is appropriate.
        md += `  - **Notes:**\n${formatJsonToMarkdownCodeBlock(notes, 'json', 4)}\n`;
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
        md += `| ${formatValue(subtask.subtask_id || 'N/A', { isCodeOrId: true })} `
            + `| ${formatValue(subtask.title || 'N/A')} `
            + `| ${formatValue(subtask.status || 'N/A')} `
            + `| ${subtask.parent_task_id ? formatValue(subtask.parent_task_id, { isCodeOrId: true }) : '*N/A*'} |\n`;
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
        const dependencies = getParsedArrayField(task.dependencies_task_ids_parsed || task.dependencies_task_ids_json || task.dependencies_task_ids);

        md += `| ${formatValue(task.task_number || 'N/A')} `
            + `| ${formatValue(task.title || 'N/A')} `
            + `| ${formatValue(task.status || 'N/A')} `
            + `| ${(dependencies.length > 0) ? dependencies.map((d: string) => formatValue(d, { isCodeOrId: true })).join(', ') : '*None*'} `
            + `| ${formatValue(task.assigned_to || 'N/A')} `
            + `| ${formatValue(task.task_id || 'N/A', { isCodeOrId: true })} |\n`;

        if (includeSubtasks && task.subtasks && Array.isArray(task.subtasks) && task.subtasks.length > 0) {
            md += `\n**Subtasks for Task ${formatValue(task.task_number, { isCodeOrId: true })} - ${formatValue(task.title)}:**\n`;
            task.subtasks.forEach((subtask: any) => {
                md += `- Subtask ID: ${formatValue(subtask.subtask_id || 'N/A', { isCodeOrId: true })}\n`;
                md += `  - Title: ${formatValue(subtask.title || 'N/A')}\n`;
                md += `  - Status: ${formatValue(subtask.status || 'N/A')}\n`;
                if (subtask.parent_task_id) {
                    md += `  - Parent Task ID: ${formatValue(subtask.parent_task_id, { isCodeOrId: true })}\n`;
                }
            });
        }
    });
    return md;
}

// *** MODIFIED FUNCTION TO DISPLAY FULL TASK DETAILS WITH SUBTASKS ***
export function formatPlanToMarkdown(plan: any, tasks: any[] = [], planSubtasks: any[] = [], taskMap: Map<string, any> = new Map()): string {
    if (!plan) return "*No plan details provided.*\n";

    let md = `## Plan: ${formatValue(plan.title || 'N/A')} (ID: ${formatValue(plan.plan_id, { isCodeOrId: true })})\n\n`;
    md += `- __Agent ID:__ ${formatValue(plan.agent_id, { isCodeOrId: true })}\n`;
    md += `- __Status:__ ${formatValue(plan.status || 'N/A')}\n`;
    if (plan.overall_goal) md += `- __Overall Goal:__ ${formatValue(plan.overall_goal)}\n`;
    md += `- __Version:__ ${formatValue(plan.version || 1)}\n`;
    if (plan.creation_timestamp_iso) md += `- __Created:__ ${formatValue(plan.creation_timestamp_iso ? new Date(plan.creation_timestamp_iso) : null)}\n`;
    if (plan.last_updated_timestamp_iso) md += `- __Last Updated:__ ${formatValue(plan.last_updated_timestamp_iso ? new Date(plan.last_updated_timestamp_iso) : null)}\n`;
    if (plan.refined_prompt_id_associated) md += `- __Refined Prompt ID:__ ${formatValue(plan.refined_prompt_id_associated, { isCodeOrId: true })}\n`;

    const metadata = plan.metadata_parsed || plan.metadata;
    if (metadata) {
        md += `- __Metadata:__\n${formatJsonToMarkdownCodeBlock(metadata, 'json', 2)}\n`;
    }

    md += "\n### Tasks for this Plan:\n";

    if (!tasks || tasks.length === 0) {
        md += "\n*No tasks associated with this plan currently.*\n";
    } else {
        // Ensure tasks are sorted by task_number
        tasks.sort((a, b) => (a.task_number || 0) - (b.task_number || 0)).forEach(task => {
            md += `\n---\n`;
            md += `#### Task ${task.task_number}: ${formatValue(task.title)} [\`${task.status}\`]\n`;
            md += `*ID: ${formatValue(task.task_id, { isCodeOrId: true })}*\n`;

            if (task.purpose) md += `\n- **Purpose:** ${formatValue(task.purpose)}\n`;
            if (task.description) md += `- **Description:** ${formatValue(task.description)}\n`;
            if (task.success_criteria_text) md += `- **Success Criteria:** ${formatValue(task.success_criteria_text)}\n`;

            const dependencies = getParsedArrayField(task.dependencies_task_ids)
                .map((depId: string) => {
                    const depTask = taskMap.get(depId);
                    return depTask ? `Task ${depTask.task_number} ('${formatValue(depTask.title)}')` : formatValue(depId, { isCodeOrId: true });
                })
                .join(', ');

            if (dependencies) md += `- **Dependencies:** ${dependencies}\n`;

            const filesInvolved = getParsedArrayField(task.files_involved);
            if (filesInvolved.length > 0) {
                md += `- **Files Involved:** ${filesInvolved.map(f => formatValue(f, { isCodeOrId: true })).join(', ')}\n`;
            }

            const toolsRequired = getParsedArrayField(task.tools_required_list);
            if (toolsRequired.length > 0) {
                md += `- **Tools Required:** ${toolsRequired.map(t => formatValue(t, { isCodeOrId: true })).join(', ')}\n`;
            }

            if (task.code_content) {
                const language = filesInvolved.length > 0 ? (filesInvolved[0].split('.').pop() || 'text') : 'text';
                const codeType = task.code_content.startsWith('--- a/') ? 'diff' : language;

                md += `- **Proposed Code Changes:**\n`;
                md += `${formatJsonToMarkdownCodeBlock(task.code_content, codeType, 2)}\n`;
            }

            // Display subtasks for this specific task
            if (task.subtasks && Array.isArray(task.subtasks) && task.subtasks.length > 0) {
                md += `\n#### Subtasks for Task ${task.task_number}:\n`;
                task.subtasks.forEach((subtask: any) => {
                    md += `\n- **Subtask ID:** ${formatValue(subtask.subtask_id, { isCodeOrId: true })}\n`;
                    md += `  - **Title:** ${formatValue(subtask.title || 'N/A')}\n`;
                    md += `  - **Status:** ${formatValue(subtask.status || 'N/A')}\n`;
                    md += `  - **Description:** ${formatValue(subtask.description || 'N/A')}\n`;
                    if (subtask.parent_task_id) {
                        md += `  - **Parent Task ID:** ${formatValue(subtask.parent_task_id, { isCodeOrId: true })}\n`;
                    }
                    if (subtask.creation_timestamp_iso) {
                        md += `  - **Created:** ${formatValue(subtask.creation_timestamp_iso ? new Date(subtask.creation_timestamp_iso) : null)}\n`;
                    }
                    if (subtask.last_updated_timestamp_iso) {
                        md += `  - **Last Updated:** ${formatValue(subtask.last_updated_timestamp_iso ? new Date(subtask.last_updated_timestamp_iso) : null)}\n`;
                    }
                    if (subtask.completion_timestamp_iso) {
                        md += `  - **Completed:** ${formatValue(subtask.completion_timestamp_iso ? new Date(subtask.completion_timestamp_iso) : null)}\n`;
                    }
                });
                md += `\n`;
            }
        });
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
        md += `| ${formatValue(plan.plan_id, { isCodeOrId: true })} `
            + `| ${formatValue(plan.title || 'N/A')} `
            + `| ${formatValue(plan.status || 'N/A')} `
            + `| ${formatValue(goalSummary)} ` // Goal summary is plain text
            + `| ${formatValue(plan.version || 1)} `
            + `| ${formatValue(plan.creation_timestamp_iso ? new Date(plan.creation_timestamp_iso) : null)} |\n`;
    });
    return md;
}

export function formatPlanGenerationResponseToMarkdown(response: any): string {
    if (!response) {
        return "*No plan generation response provided.*\n";
    }

    let md = `## Refined Prompt & Plan Generation Summary\n\n`;

    const metadata = response.generation_metadata_parsed || response.generation_metadata;
    if (metadata) {
        md += `### Generation & Context Analysis:\n`;
        if (metadata.rag_metrics) {
            md += `- **RAG Metrics:** Total Iterations: ${metadata.rag_metrics.totalIterations}, Context Items Added: ${metadata.rag_metrics.contextItemsAdded}, Web Searches: ${metadata.rag_metrics.webSearchesPerformed}\n`;
        }
        if (metadata.context_summary && metadata.context_summary.length > 0) {
            md += `- **Context Sources Used:** ${metadata.context_summary.length} items (e.g., \`${metadata.context_summary[0].source}\`)\n`;
        } else {
            md += `- **Context Sources Used:** 0 items\n`;
        }
        if (metadata.web_sources && metadata.web_sources.length > 0) {
            md += `- **Web Sources Found:** ${metadata.web_sources.length} sources\n`;
        }
        md += `\n`;
    }

    md += `### Generated Plan Details:\n`;
    md += `- **Plan Title:** ${formatValue(response.plan_title || response.overall_goal || 'N/A')}\n`;
    md += `- **Estimated Duration:** ${formatValue(response.estimated_duration_days)} days\n`;
    md += `- **Target Dates:** ${formatValue(response.target_start_date)} to ${formatValue(response.target_end_date)}\n`;
    if (response.refinement_engine_model) {
        md += `- **Refinement Model:** ${formatValue(response.refinement_engine_model)}\n`;
    }
    if (response.refinement_timestamp) {
        md += `- **Generated At:** ${formatValue(new Date(response.refinement_timestamp))}\n`;
    }
    if (response.original_prompt_text) {
        md += `- **Original Query:** ${formatValue(response.original_prompt_text)}\n`;
    }
    if (response.target_ai_persona) {
        md += `- **Target AI Persona:** ${formatValue(response.target_ai_persona)}\n`;
    }
    if (response.refined_prompt_id) {
        md += `- **Refined Prompt ID:** ${formatValue(response.refined_prompt_id, { isCodeOrId: true })}\n`;
    }

    const risks = response.plan_risks_and_mitigations || [];
    if (risks.length > 0) {
        md += `\n### Identified Risks and Mitigations:\n`;
        risks.forEach((risk: any, index: number) => {
            md += `\n**Risk ${index + 1}:**\n`;
            md += `- **Description:** ${formatValue(risk.risk_description)}\n`;
            md += `- **Mitigation Strategy:** ${formatValue(risk.mitigation_strategy)}\n`;
        });
    }

    // CORRECTED LOGIC: Check for the correct task properties from RefinedPrompt object
    const tasks = response.decomposed_tasks_parsed || response.decomposed_tasks || [];
    if (tasks.length > 0) {
        md += `\n### Proposed Tasks:\n`;
        tasks.forEach((task: any, index: number) => {
            const taskNumber = task.task_number || (index + 1);
            md += `\n--- Task ${formatValue(taskNumber)} ---\n`;
            md += `- **Title:** ${formatValue(task.title)}\n`;
            md += `- **Description:** ${formatValue(task.description)}\n`;
            md += `- **Purpose:** ${formatValue(task.purpose)}\n`;

            const filesInvolved = getParsedArrayField(task.files_involved_json);
            if (filesInvolved.length > 0) {
                md += `- **Suggested Files Involved:** ${filesInvolved.map((f: string) => formatValue(f, { isCodeOrId: true })).join(', ')}\n`;
            }

            const dependencies = getParsedArrayField(task.dependencies_task_ids_json);
            if (dependencies.length > 0) {
                // This field from the prompt contains task titles, not IDs. We format them as is.
                md += `- **Dependencies:** ${dependencies.map((d: string) => `"${formatValue(d)}"`).join(', ')}\n`;
            }

            if (task.success_criteria_text) {
                md += `- **Completion Criteria:** ${formatValue(task.success_criteria_text)}\n`;
            }

            if (task.code_content) {
                const language = filesInvolved.length > 0 ? (filesInvolved[0].split('.').pop() || 'text') : 'text';
                const codeType = task.code_content.startsWith('--- a/') ? 'diff' : language;
                md += `- **Proposed Code Content:**\n${formatJsonToMarkdownCodeBlock(task.code_content, codeType, 2)}\n`;
            }
        });
    } else {
        md += "\n*No specific tasks proposed in this plan.*\n";
    }

    return md;
}
