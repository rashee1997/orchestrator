// Helper function to format a single task into a Markdown string
export function formatTaskToMarkdown(task: any): string {
    let md = `### Task: ${task.title || 'N/A'} (ID: ${task.task_id})\n`;
    md += `- **Plan ID:** ${task.plan_id}\n`;
    md += `- **Task Number:** ${task.task_number}\n`;
    md += `- **Status:** ${task.status || 'N/A'}\n`;
    if (task.description) md += `- **Description:** ${task.description}\n`;
    if (task.purpose) md += `- **Purpose:** ${task.purpose}\n`;
    if (task.action_description) md += `- **Action:** ${task.action_description}\n`;
    if (task.files_involved && task.files_involved.length > 0) md += `- **Files Involved:** ${task.files_involved.join(', ')}\n`;
    if (task.dependencies_task_ids && task.dependencies_task_ids.length > 0) md += `- **Dependencies:** ${task.dependencies_task_ids.join(', ')}\n`;
    if (task.tools_required_list && task.tools_required_list.length > 0) md += `- **Tools Required:** ${task.tools_required_list.join(', ')}\n`;
    if (task.inputs_summary) md += `- **Inputs:** ${task.inputs_summary}\n`;
    if (task.outputs_summary) md += `- **Outputs:** ${task.outputs_summary}\n`;
    if (task.success_criteria_text) md += `- **Success Criteria:** ${task.success_criteria_text}\n`;
    if (task.estimated_effort_hours) md += `- **Estimated Effort:** ${task.estimated_effort_hours} hours\n`;
    if (task.assigned_to) md += `- **Assigned To:** ${task.assigned_to}\n`;
    if (task.verification_method) md += `- **Verification:** ${task.verification_method}\n`;
    if (task.creation_timestamp) md += `- **Created:** ${new Date(task.creation_timestamp).toLocaleString()}\n`;
    if (task.last_updated_timestamp) md += `- **Last Updated:** ${new Date(task.last_updated_timestamp).toLocaleString()}\n`;
    if (task.completion_timestamp) md += `- **Completed:** ${new Date(task.completion_timestamp).toLocaleString()}\n`;
    if (task.notes) md += `- **Notes:** ${JSON.stringify(task.notes)}\n`;
    return md;
}

// Helper function to format a list of subtasks into a Markdown table
export function formatSubtasksListToMarkdownTable(subtasks: any[]): string {
    if (!subtasks || subtasks.length === 0) {
        return "No subtasks found.\n";
    }
    let md = "| Subtask ID | Title | Status | Parent Task ID |\n";
    md += "|------------|-------|--------|----------------|\n";
    subtasks.forEach(subtask => {
        md += `| ${subtask.subtask_id || 'N/A'} `
            + `| ${subtask.title || 'N/A'} `
            + `| ${subtask.status || 'N/A'} `
            + `| ${subtask.parent_task_id || 'N/A'} |\n`;
    });
    return md;
}

// Helper function to format a list of tasks into a Markdown table
export function formatTasksListToMarkdownTable(tasks: any[]): string {
    if (!tasks || tasks.length === 0) {
        return "No tasks found.\n";
    }
    let md = "| Task No. | Title | Status | Dependencies | Assigned To | Task ID |\n";
    md += "|----------|-------|--------|--------------|-------------|---------|\n";
    tasks.forEach(task => {
        md += `| ${task.task_number || 'N/A'} `
            + `| ${task.title || 'N/A'} `
            + `| ${task.status || 'N/A'} `
            + `| ${(task.dependencies_task_ids && task.dependencies_task_ids.length > 0) ? task.dependencies_task_ids.join(', ') : 'None'} `
            + `| ${task.assigned_to || 'N/A'} `
            + `| ${task.task_id || 'N/A'} |\n`;

        if (task.subtasks && task.subtasks.length > 0) {
            md += `| | **Subtasks:** | | | | |\n`;
            md += `| | --- | --- | --- | --- | --- |\n`;
            task.subtasks.forEach((subtask: any) => {
                md += `| | - ${subtask.title || 'N/A'} `
                    + `| ${subtask.status || 'N/A'} `
                    + `| | | ${subtask.subtask_id || 'N/A'} |\n`;
            });
        }
    });
    return md;
}

// Helper function to format a single plan into a Markdown string
export function formatPlanToMarkdown(plan: any, tasks: any[] = [], planSubtasks: any[] = []): string {
    let md = `## Plan: ${plan.title || 'N/A'} (ID: ${plan.plan_id})\n`;
    md += `- **Agent ID:** ${plan.agent_id}\n`;
    md += `- **Status:** ${plan.status || 'N/A'}\n`;
    if (plan.overall_goal) md += `- **Overall Goal:** ${plan.overall_goal}\n`;
    md += `- **Version:** ${plan.version || 1}\n`;
    if (plan.creation_timestamp) md += `- **Created:** ${new Date(plan.creation_timestamp).toLocaleString()}\n`;
    if (plan.last_updated_timestamp) md += `- **Last Updated:** ${new Date(plan.last_updated_timestamp).toLocaleString()}\n`;
    if (plan.refined_prompt_id_associated) md += `- **Refined Prompt ID:** ${plan.refined_prompt_id_associated}\n`;
    if (plan.analysis_report_id_referenced) md += `- **Analysis Report ID:** ${plan.analysis_report_id_referenced}\n`;
    if (plan.metadata) md += `- **Metadata:** ${JSON.stringify(plan.metadata)}\n`;

    if (tasks && tasks.length > 0) {
        md += "\n### Tasks for this Plan:\n";
        md += formatTasksListToMarkdownTable(tasks);
    } else {
        md += "\nNo tasks associated with this plan currently.\n"
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
        return "No plans found.\n";
    }
    let md = "| Plan ID | Title | Status | Goal | Version | Created |\n";
    md += "|---------|-------|--------|------|---------|---------|\n";
    plans.forEach(plan => {
        md += `| ${plan.plan_id} `
            + `| ${plan.title || 'N/A'} `
            + `| ${plan.status || 'N/A'} `
            + `| ${(plan.overall_goal || 'N/A').substring(0, 30)}${(plan.overall_goal && plan.overall_goal.length > 30) ? '...' : ''} `
            + `| ${plan.version || 1} `
            + `| ${plan.creation_timestamp ? new Date(plan.creation_timestamp).toLocaleDateString() : 'N/A'} |\n`;
    });
    return md;
}
