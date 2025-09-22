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

// Safe JSON parsing helper with fallback
function safelyParseJson<T = any>(value: string | null | undefined, fallback: T): T {
    if (!value) {
        return fallback;
    }
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
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

const statusEmojis: Record<string, string> = {
    'pending': '⚪️',
    'in_progress': '⏳',
    'completed': '✅',
    'blocked': '🚫',
    'skipped': '⏭️',
    'not_started': '⚪️',
    'done': '✅',
    'to_do': '⚪️'
};

function getStatusEmoji(status: string | undefined | null): string {
    if (!status) return '❓';
    const normalizedStatus = status.toLowerCase().replace(/[\s-]/g, '_');
    return statusEmojis[normalizedStatus] || '🔹';
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
        return value ? '`true`' : '`false`';
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
        md += `### ✨ ${escapeMinimalMarkdown(title)}\n\n`;
    }
    md += `${messageBody}\n`; // Assumes messageBody is already valid Markdown
    return md;
}

// Formats a plain text message into a Markdown paragraph.
// Both title and the message itself are treated as plain text and will be escaped.
export function formatPlainTextAsMarkdownParagraph(plainTextMessage: string, title?: string): string {
    let md = "";
    if (title) {
        md += `### ✨ ${escapeMinimalMarkdown(title)}\n\n`;
    }
    md += `${escapeMinimalMarkdown(plainTextMessage)}\n`;
    return md;
}

export function formatSimpleMessage(messageBody: string, title?: string): string {
    let md = "\n---\n";
    if (title) {
        md += `### ✨ ${escapeMinimalMarkdown(title)}\n\n`;
    }
    md += `> ${messageBody.replace(/\n/g, '\n> ')}\n`;
    md += "\n---\n";
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
            return `${indent}- *Empty list*\n`;
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
            const formattedKey = key.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
            md += `${indent}- **${escapeMinimalMarkdown(formattedKey)}:** `;
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
    if (!task) return "> ❓ *No task details provided.*\n";
    
    const statusEmoji = getStatusEmoji(task.status);
    let md = `### ${statusEmoji} Task ${task.task_number || ''}: ${formatValue(task.title || 'N/A')}\n`;
    md += `*ID: ${formatValue(task.task_id, { isCodeOrId: true })} | Plan ID: ${formatValue(task.plan_id, { isCodeOrId: true })}*\n\n`;

    if (task.purpose) md += `**🎯 Purpose:** ${formatValue(task.purpose)}\n`;
    if (task.description) md += `**📖 Description:** ${formatValue(task.description)}\n`;
    if (task.action_description) md += `**⚡ Action:** ${formatValue(task.action_description)}\n`;

    md += '\n--- \n\n#### Details\n';

    const filesInvolved = getParsedArrayField(task.files_involved_parsed || task.files_involved_json || task.files_involved);
    if (filesInvolved.length > 0) md += `- **Affected Files:** ${filesInvolved.map(i => formatValue(i, { isCodeOrId: true })).join(', ')}\n`;
    const toolsRequired = getParsedArrayField(task.tools_required_list_parsed || task.tools_required_list_json || task.tools_required_list);
    if (toolsRequired.length > 0) md += `- **Suggested Tools:** ${toolsRequired.map(i => formatValue(i, { isCodeOrId: true })).join(', ')}\n`;
    if (task.estimated_effort_hours) md += `- **Estimated Effort:** ${formatValue(task.estimated_effort_hours)} hours\n`;
    if (task.assigned_to) md += `- **Assigned To:** ${formatValue(task.assigned_to)}\n`;

    md += '\n#### Execution & Verification\n'
    if (task.inputs_summary) md += `- **Inputs:** ${formatValue(task.inputs_summary)}\n`;
    if (task.outputs_summary) md += `- **Outputs:** ${formatValue(task.outputs_summary)}\n`;
    if (task.success_criteria_text) md += `- **✅ Success Criteria:** ${formatValue(task.success_criteria_text)}\n`;
    if (task.verification_method) md += `- **🔍 Verification:** ${formatValue(task.verification_method)}\n`;

    const dependencies = getParsedArrayField(task.dependencies_task_ids_parsed || task.dependencies_task_ids_json || task.dependencies_task_ids);
    if (dependencies.length > 0) md += `- **🔗 Dependencies:** ${dependencies.map(i => formatValue(i, { isCodeOrId: true })).join(', ')}\n`;

    if (task.code_content) {
        const files = getParsedArrayField(task.files_involved_parsed || task.files_involved_json || task.files_involved);
        const language = files.length > 0 ? (files[0].split('.').pop() || 'text') : 'text';
        const codeType = task.code_content.startsWith('--- a/') ? 'diff' : language;

        md += `\n#### 💻 Proposed Code Changes\n`;
        md += `${formatJsonToMarkdownCodeBlock(task.code_content, codeType, 0)}\n`;
    }

    const notes = task.notes_parsed || task.notes_json || task.notes;
    if (notes) {
        md += `\n#### 📝 Notes\n${formatJsonToMarkdownCodeBlock(notes, 'json', 0)}\n`;
    }

    md += '\n#### Timestamps\n'
    if (task.creation_timestamp_iso) md += `- **Created:** ${formatValue(task.creation_timestamp_iso ? new Date(task.creation_timestamp_iso) : null)}\n`;
    if (task.last_updated_timestamp_iso) md += `- **Updated:** ${formatValue(task.last_updated_timestamp_iso ? new Date(task.last_updated_timestamp_iso) : null)}\n`;
    if (task.completion_timestamp_iso) md += `- **Completed:** ${formatValue(task.completion_timestamp_iso ? new Date(task.completion_timestamp_iso) : null)}\n`;

    return md;
}

export function formatSubtasksListToMarkdownTable(subtasks: any[]): string {
    if (!subtasks || subtasks.length === 0) {
        return "✔️ *No subtasks for this item.*";
    }
    let md = "| Status | Title | Subtask ID |\n";
    md += "|:------:|-------|------------|\n";
    subtasks.forEach(subtask => {
        const statusEmoji = getStatusEmoji(subtask.status);
        md += `| ${statusEmoji} `
            + `| ${formatValue(subtask.title || 'N/A')} `
            + `| ${formatValue(subtask.subtask_id || 'N/A', { isCodeOrId: true })} |\n`;
    });
    return md;
}

export function formatTasksListToMarkdownTable(tasks: any[], includeSubtasks: boolean = false): string {
    if (!tasks || tasks.length === 0) {
        return "> ✨ *All tasks complete or no tasks found!*";
    }
    let md = "| Status | # | Title | Dependencies | Task ID |\n";
    md += "|:------:|:-:|-------|--------------|---------|\n";
    tasks.forEach(task => {
        const dependencies = getParsedArrayField(task.dependencies_task_ids_parsed || task.dependencies_task_ids_json || task.dependencies_task_ids);
        const statusEmoji = getStatusEmoji(task.status);
        md += `| ${statusEmoji} `
            + `| ${formatValue(task.task_number || 'N/A')} `
            + `| ${formatValue(task.title || 'N/A')} `
            + `| ${(dependencies.length > 0) ? dependencies.map((d: string) => formatValue(d, { isCodeOrId: true })).join(', ') : '*None*'} `
            + `| ${formatValue(task.task_id || 'N/A', { isCodeOrId: true })} |\n`;

        if (includeSubtasks && task.subtasks && Array.isArray(task.subtasks) && task.subtasks.length > 0) {
            md += `|||||\n||||<details><summary>View ${task.subtasks.length} Subtasks</summary>\n\n`
            md += `| Status | Title | Subtask ID |\n`;
            md += `|:------:|-------|------------|\n`;
            task.subtasks.forEach((subtask: any) => {
                 const subtaskStatusEmoji = getStatusEmoji(subtask.status);
                 md += `| ${subtaskStatusEmoji} | ${formatValue(subtask.title)} | ${formatValue(subtask.subtask_id, { isCodeOrId: true})} |\n`
            });
            md += `\n</details>|\n`;
        }
    });
    return md;
}

export function formatPlanToMarkdown(plan: any, tasks: any[] = [], planSubtasks: any[] = [], taskMap: Map<string, any> = new Map()): string {
    if (!plan) return "> ❓ *No plan details provided.*\n";

    const statusText = formatValue(plan.status || 'N/A');
    const statusEmoji = getStatusEmoji(plan.status);
    const planId = formatValue(plan.plan_id, { isCodeOrId: true });

    let md = `# Plan: ${formatValue(plan.title || 'N/A')}\n\n`;
    md += `__Status:__ ${statusEmoji} ${statusText} | __ID:__ ${planId}\n\n`;

    if (plan.overall_goal) {
        md += `> ### 🎯 __Overall Goal__\n>\n> ${plan.overall_goal.replace(/\n/g, '\n> ')}\n\n`;
    }

    md += `---\n\n`;

    md += `### 📝 Plan Details\n\n`;
    md += `- __Agent ID:__ ${formatValue(plan.agent_id, { isCodeOrId: true })}\n`;
    if (plan.refined_prompt_id_associated) {
        md += `- __Refined Prompt:__ ${formatValue(plan.refined_prompt_id_associated, { isCodeOrId: true })}\n`;
    }
    md += `- __Version:__ ${formatValue(plan.version || 1)}\n`;
    if (plan.creation_timestamp_iso) {
        md += `- __Created:__ ${formatValue(plan.creation_timestamp_iso ? new Date(plan.creation_timestamp_iso) : null)}\n`;
    }
    if (plan.last_updated_timestamp_iso) {
        md += `- __Last Updated:__ ${formatValue(plan.last_updated_timestamp_iso ? new Date(plan.last_updated_timestamp_iso) : null)}\n`;
    }

    const metadata = plan.metadata_parsed || plan.metadata;
    if (metadata) {
        const meta = typeof metadata === 'string' ? safelyParseJson(metadata, {}) : metadata;
        const kpis: string[] = meta?.kpis || [];
        if (meta?.estimated_duration_days || meta?.target_start_date || meta?.target_end_date) {
            md += `- __Duration:__ ${meta.estimated_duration_days ?? 'N/A'} days (Start: ${meta.target_start_date ?? 'TBD'}, End: ${meta.target_end_date ?? 'TBD'})\n`;
        }
        if (kpis.length > 0) {
            md += `- __KPIs:__ ${kpis.map(kpi => formatValue(kpi)).join(', ')}\n`;
        }
    }

    md += `\n### 🚀 Tasks\n\n`;
    if (!tasks || tasks.length === 0) {
        md += `> ✨ *All tasks are complete or no tasks have been created yet.*\n`;
    } else {
        const sortedTasks = [...tasks].sort((a, b) => (a.task_number || 0) - (b.task_number || 0));

        // Group tasks by phase
        const tasksByPhase = new Map<string, any[]>();
        sortedTasks.forEach(task => {
            const phase = task.phase || 'Unassigned';
            if (!tasksByPhase.has(phase)) {
                tasksByPhase.set(phase, []);
            }
            tasksByPhase.get(phase)!.push(task);
        });

        // Display tasks grouped by phase
        const phaseOrder = ['Phase 1: Analysis & Design', 'Phase 2: Core Implementation', 'Phase 3: Documentation & Quality'];
        const sortedPhases = Array.from(tasksByPhase.keys()).sort((a, b) => {
            const aIndex = phaseOrder.indexOf(a);
            const bIndex = phaseOrder.indexOf(b);
            if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
            if (aIndex !== -1) return -1;
            if (bIndex !== -1) return 1;
            return a.localeCompare(b);
        });

        sortedPhases.forEach(phase => {
            const phaseTasks = tasksByPhase.get(phase)!;
            md += `#### 📋 ${phase} (${phaseTasks.length} tasks)\n\n`;
            phaseTasks.forEach(task => {
                md += `${formatTaskToMarkdown(task)}\n`;
            });
        });
    }

    if (planSubtasks && planSubtasks.length > 0) {
        md += `\n### 📌 Plan-Level Subtasks (Unassigned)\n`;
        md += formatSubtasksListToMarkdownTable(planSubtasks);
    }

    return md;
}


export function formatPlansListToMarkdownTable(plans: any[]): string {
    if (!plans || plans.length === 0) {
        return "> ✨ *No plans found.*";
    }
    let md = "| Status | Title | Goal (Summary) | Plan ID |\n";
    md += "|:------:|-------|----------------|---------|\n";
    plans.forEach(plan => {
        const goalSummary = (String(plan.overall_goal || 'N/A')).substring(0, 40) + ((plan.overall_goal && plan.overall_goal.length > 40) ? '...' : '');
        const statusEmoji = getStatusEmoji(plan.status);
        md += `| ${statusEmoji} `
            + `| ${formatValue(plan.title || 'N/A')} `
            + `| ${formatValue(goalSummary)} `
            + `| ${formatValue(plan.plan_id, { isCodeOrId: true })} |\n`;
    });
    return md;
}

export function formatPlanGenerationResponseToMarkdown(response: any): string {
    if (!response) {
        return "> ❓ *No plan generation response provided.*\n";
    }

    let md = `# 📋 ${formatValue(response.plan_title || response.overall_goal || 'Generated Plan')}\n\n`;
    
    // Executive Summary
    if (response.executive_summary) {
        md += `## 📊 Executive Summary\n\n${formatValue(response.executive_summary)}\n\n`;
    }

    // Overall Goal
    md += `> ### 🎯 **Overall Goal**\n> ${formatValue(response.overall_goal || response.plan_title || 'Not specified')}\n\n`;
    
    // Current Architecture Analysis
    if (response.current_architecture_analysis) {
        md += `## 🏗️ Current Architecture Analysis\n\n${formatValue(response.current_architecture_analysis)}\n\n`;
    }
    
    // Performance Issues Identified
    if (response.performance_issues_identified && response.performance_issues_identified.length > 0) {
        md += `## ⚡ Performance Issues Identified\n\n`;
        response.performance_issues_identified.forEach((issue: any) => {
            md += `### ${formatValue(issue.issue_name)}\n`;
            md += `**Impact Level:** ${formatValue(issue.impact)}\n\n`;
            md += `**Current Metrics:** ${formatValue(issue.current_metrics)}\n\n`;
            md += `**Description:** ${formatValue(issue.description)}\n\n`;
        });
    }
    
    // Refactoring Strategy Overview
    if (response.refactoring_strategy_overview) {
        md += `## 🔧 Refactoring Strategy Overview\n\n${formatValue(response.refactoring_strategy_overview)}\n\n`;
    }
    
    // Success Metrics & KPIs
    if (response.success_metrics && response.success_metrics.length > 0) {
        md += `## 📈 Success Metrics & KPIs\n\n`;
        response.success_metrics.forEach((metric: any) => {
            md += `### ${formatValue(metric.metric_name)}\n`;
            md += `- **Current Value:** ${formatValue(metric.current_value)}\n`;
            md += `- **Target Value:** ${formatValue(metric.target_value)}\n`;
            md += `- **Measurement Method:** ${formatValue(metric.measurement_method)}\n\n`;
        });
    }
    
    // Timeline Phases
    if (response.timeline_phases && response.timeline_phases.length > 0) {
        md += `## 📅 Timeline & Implementation Phases\n\n`;
        response.timeline_phases.forEach((phase: any) => {
            md += `### Phase ${phase.phase_number}: ${formatValue(phase.phase_name)}\n`;
            md += `- **Duration:** ${formatValue(phase.duration_days)} days\n`;
            md += `- **Start Date:** ${formatValue(phase.start_date)}\n`;
            md += `- **End Date:** ${formatValue(phase.end_date)}\n`;
            md += `- **Description:** ${formatValue(phase.description)}\n\n`;
            
            if (phase.key_deliverables && phase.key_deliverables.length > 0) {
                md += `**Key Deliverables:**\n`;
                phase.key_deliverables.forEach((deliverable: string) => {
                    md += `- ${formatValue(deliverable)}\n`;
                });
                md += '\n';
            }
            
            if (phase.success_criteria && phase.success_criteria.length > 0) {
                md += `**Success Criteria:**\n`;
                phase.success_criteria.forEach((criteria: string) => {
                    md += `- ${formatValue(criteria)}\n`;
                });
                md += '\n';
            }
        });
    }

    const metadata = response.generation_metadata_parsed || response.generation_metadata;
    if (metadata) {
        md += `### 🔍 Context & Generation Details\n`;
        if (metadata.rag_metrics) {
            md += `- **RAG Analysis:** ${metadata.rag_metrics.totalIterations} iterations, ${metadata.rag_metrics.contextItemsAdded} context items found, ${metadata.rag_metrics.webSearchesPerformed} web searches.\n`;
        }
        if (metadata.context_summary && metadata.context_summary.length > 0) {
            md += `- **Context Sources:** ${metadata.context_summary.length} items (e.g., \`${metadata.context_summary[0].source}\`).\n`;
        } else {
            md += `- **Context Sources:** None found.\n`;
        }
        if (metadata.web_sources && metadata.web_sources.length > 0) {
            md += `- **Web Sources:** ${metadata.web_sources.length} sources found.\n`;
        }
        md += `\n`;
    }

    md += `### 📋 Generated Plan\n`;
    md += `- **Title:** ${formatValue(response.plan_title || response.overall_goal || 'N/A')}\n`;
    if (response.target_ai_persona) {
        md += `- **AI Persona:** ${formatValue(response.target_ai_persona)}\n`;
    }
    if (response.refined_prompt_id) {
        md += `- **Refined Prompt ID:** ${formatValue(response.refined_prompt_id, { isCodeOrId: true })}\n`;
    }
    
    // Risk Assessment
    const risks = response.plan_risks_and_mitigations || [];
    if (risks.length > 0) {
        md += `\n## ⚠️ Risk Assessment & Mitigations\n\n`;
        risks.forEach((risk: any) => {
            md += `### ${formatValue(risk.risk_name || risk.risk_description)}\n`;
            md += `**Probability:** ${formatValue(risk.probability)} | **Impact:** ${formatValue(risk.impact)}\n\n`;
            md += `**Description:** ${formatValue(risk.description || risk.risk_description)}\n\n`;
            md += `**Mitigation Strategy:** ${formatValue(risk.mitigation_strategy)}\n\n`;
            if (risk.contingency_plan) {
                md += `**Contingency Plan:** ${formatValue(risk.contingency_plan)}\n\n`;
            }
        });
    }

    const tasks = response.decomposed_tasks_parsed || response.decomposed_tasks || [];
    if (tasks.length > 0) {
        md += `\n### 🚀 Detailed Implementation Tasks\n`;
        tasks.forEach((task: any, index: number) => {
            const taskNumber = task.task_number || (index + 1);
            const priorityEmoji = task.priority === 'HIGH' ? '🔴' : task.priority === 'MEDIUM' ? '🟡' : '🟢';
            md += `\n<details>\n<summary><strong>${priorityEmoji} Task ${taskNumber}: ${formatValue(task.title)}</strong></summary>\n\n`;
            
            md += `- **Description:** ${formatValue(task.description)}\n`;
            md += `- **Purpose:** ${formatValue(task.purpose)}\n`;
            
            if (task.phase) md += `- **Phase:** ${formatValue(task.phase)}\n`;
            if (task.priority) md += `- **Priority:** ${formatValue(task.priority)}\n`;
            if (task.estimated_effort_hours) md += `- **Estimated Effort:** ${formatValue(task.estimated_effort_hours)} hours\n`;

            const filesInvolved = getParsedArrayField(task.files_involved_json);
            if (filesInvolved.length > 0) md += `- **Files:** ${filesInvolved.map((f: string) => formatValue(f, { isCodeOrId: true })).join(', ')}\n`;

            const dependencies = getParsedArrayField(task.dependencies_task_ids_json);
            if (dependencies.length > 0) md += `- **Dependencies:** ${dependencies.map((d: string) => `"${formatValue(d)}"`).join(', ')}\n`;

            if (task.success_criteria_text) md += `- **Completion Criteria:** ${formatValue(task.success_criteria_text)}\n`;
            
            if (task.validation_steps && task.validation_steps.length > 0) {
                md += `- **Validation Steps:**\n`;
                task.validation_steps.forEach((step: string) => {
                    md += `  - ${formatValue(step)}\n`;
                });
            }
            
            if (task.acceptance_criteria && task.acceptance_criteria.length > 0) {
                md += `- **Acceptance Criteria:**\n`;
                task.acceptance_criteria.forEach((criteria: string) => {
                    md += `  - ${formatValue(criteria)}\n`;
                });
            }

            if (task.code_content) {
                const lang = filesInvolved.length > 0 ? (filesInvolved[0].split('.').pop() || 'text') : 'text';
                const codeType = task.code_content.startsWith('--- a/') ? 'diff' : lang;
                md += `\n**Code:**\n${formatJsonToMarkdownCodeBlock(task.code_content, codeType, 0)}\n`;
            }
            md += `\n</details>\n`;
        });
    }

    return md;
}
