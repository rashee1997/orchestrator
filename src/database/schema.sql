-- Database Schema for Advanced Conversation Storage System

-- Enable foreign key support
PRAGMA foreign_keys = ON;

-- Agents table
CREATE TABLE IF NOT EXISTS agents (
    agent_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    creation_timestamp_unix INTEGER NOT NULL,
    creation_timestamp_iso TEXT NOT NULL,
    last_updated_timestamp_unix INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    last_updated_timestamp_iso TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    configuration_json TEXT,
    status TEXT DEFAULT 'ACTIVE'
);
CREATE INDEX IF NOT EXISTS idx_agents_name ON agents (name);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents (status);

-- Conversation Sessions table (MODIFIED)
CREATE TABLE IF NOT EXISTS conversation_sessions (
    session_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL, -- The agent that created the session
    title TEXT,
    start_timestamp INTEGER NOT NULL,
    end_timestamp INTEGER,
    metadata TEXT,
    FOREIGN KEY (agent_id) REFERENCES agents (agent_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_agent_id ON conversation_sessions (agent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_start_time ON conversation_sessions (start_timestamp);

-- Session Participants table (NEW)
CREATE TABLE IF NOT EXISTS session_participants (
    participant_id TEXT NOT NULL, -- Can be an agent_id or a user_id
    session_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member', -- e.g., 'owner', 'member', 'observer'
    join_timestamp INTEGER NOT NULL,
    PRIMARY KEY (participant_id, session_id),
    FOREIGN KEY (session_id) REFERENCES conversation_sessions (session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_session_participants_session_id ON session_participants (session_id);
CREATE INDEX IF NOT EXISTS idx_session_participants_participant_id ON session_participants (participant_id);


-- Conversation Messages table (NEW - replaces conversation_history)
CREATE TABLE IF NOT EXISTS conversation_messages (
    message_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    parent_message_id TEXT,
    timestamp INTEGER NOT NULL,
    sender TEXT NOT NULL,
    message_content TEXT NOT NULL,
    message_type TEXT NOT NULL,
    tool_info TEXT,
    context_snapshot_id TEXT,
    source_attribution_id TEXT,
    metadata TEXT,
    embedding BLOB,
    FOREIGN KEY (session_id) REFERENCES conversation_sessions (session_id) ON DELETE CASCADE,
    FOREIGN KEY (parent_message_id) REFERENCES conversation_messages (message_id) ON DELETE SET NULL,
    FOREIGN KEY (context_snapshot_id) REFERENCES context_information (context_id),
    FOREIGN KEY (source_attribution_id) REFERENCES source_attribution (attribution_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON conversation_messages (session_id);
CREATE INDEX IF NOT EXISTS idx_messages_parent_id ON conversation_messages (parent_message_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON conversation_messages (timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON conversation_messages (sender);
CREATE INDEX IF NOT EXISTS idx_messages_session_timestamp ON conversation_messages (session_id, timestamp);

-- Context Information table
CREATE TABLE IF NOT EXISTS context_information (
    context_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    context_type TEXT NOT NULL,
    context_data TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    parent_context_id TEXT,
    FOREIGN KEY (parent_context_id) REFERENCES context_information (context_id)
);
CREATE INDEX IF NOT EXISTS idx_context_information_agent_ts ON context_information (agent_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_context_information_context_type ON context_information (context_type);
CREATE INDEX IF NOT EXISTS idx_context_information_version ON context_information (version);

-- Reference Keys table
CREATE TABLE IF NOT EXISTS reference_keys (
    reference_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    key_type TEXT NOT NULL,
    key_value TEXT NOT NULL,
    description TEXT,
    timestamp INTEGER NOT NULL,
    associated_conversation_id TEXT,
    FOREIGN KEY (agent_id) REFERENCES agents (agent_id) ON DELETE CASCADE,
    FOREIGN KEY (associated_conversation_id) REFERENCES conversation_messages (message_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_reference_keys_agent_type_value ON reference_keys (agent_id, key_type, key_value);
CREATE INDEX IF NOT EXISTS idx_reference_keys_timestamp ON reference_keys (timestamp);

-- Source Attribution table
CREATE TABLE IF NOT EXISTS source_attribution (
    attribution_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_uri TEXT,
    retrieval_timestamp INTEGER NOT NULL,
    content_summary TEXT,
    full_content_hash TEXT,
    full_content_json TEXT,
    FOREIGN KEY (agent_id) REFERENCES agents (agent_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_source_attribution_agent_type_ts ON source_attribution (agent_id, source_type, retrieval_timestamp);
CREATE INDEX IF NOT EXISTS idx_source_attribution_content_hash ON source_attribution (full_content_hash);

-- Correction Logs table
CREATE TABLE IF NOT EXISTS correction_logs (
    correction_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    correction_type TEXT NOT NULL,
    original_entry_id TEXT,
    original_value_json TEXT,
    corrected_value_json TEXT,
    reason TEXT,
    correction_summary TEXT,
    applied_automatically BOOLEAN NOT NULL,
    creation_timestamp_unix INTEGER NOT NULL,
    creation_timestamp_iso TEXT NOT NULL,
    last_updated_timestamp_unix INTEGER NOT NULL,
    last_updated_timestamp_iso TEXT NOT NULL,
    status TEXT DEFAULT 'LOGGED',
    FOREIGN KEY (agent_id) REFERENCES agents (agent_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_correction_logs_agent_id_type ON correction_logs (agent_id, correction_type);
CREATE INDEX IF NOT EXISTS idx_correction_logs_status ON correction_logs (status);
CREATE INDEX IF NOT EXISTS idx_correction_logs_creation_ts ON correction_logs (creation_timestamp_unix);

-- Success Metrics table
CREATE TABLE IF NOT EXISTS success_metrics (
    metric_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    metric_name TEXT NOT NULL,
    metric_value REAL NOT NULL,
    unit TEXT,
    associated_task_id TEXT,
    metadata TEXT,
    FOREIGN KEY (agent_id) REFERENCES agents (agent_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_success_metrics_agent_name_ts ON success_metrics (agent_id, metric_name, timestamp);
CREATE INDEX IF NOT EXISTS idx_success_metrics_timestamp ON success_metrics (timestamp);

-- Plans table
CREATE TABLE IF NOT EXISTS plans (
    plan_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL,
    overall_goal TEXT,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    version INTEGER NOT NULL DEFAULT 1,
    creation_timestamp_unix INTEGER NOT NULL,
    creation_timestamp_iso TEXT NOT NULL,
    last_updated_timestamp_unix INTEGER NOT NULL,
    last_updated_timestamp_iso TEXT NOT NULL,
    refined_prompt_id_associated TEXT,
    analysis_report_id_referenced TEXT,
    metadata TEXT,
    FOREIGN KEY (agent_id) REFERENCES agents (agent_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_plans_agent_id_status ON plans (agent_id, status);
CREATE INDEX IF NOT EXISTS idx_plans_creation_ts ON plans (creation_timestamp_unix);
CREATE INDEX IF NOT EXISTS idx_plans_version ON plans (version);

-- Plan Tasks table (MODIFIED TO ADD NEW DETAIL COLUMNS)
CREATE TABLE IF NOT EXISTS plan_tasks (
    task_id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    task_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'PLANNED',
    purpose TEXT, -- NEW: Why this task is necessary
    action_description TEXT,
    files_involved_json TEXT,
    dependencies_task_ids_json TEXT,
    tools_required_list_json TEXT,
    inputs_summary TEXT,
    outputs_summary TEXT,
    success_criteria_text TEXT, -- NEW: How to verify this task is done
    estimated_effort_hours REAL,
    assigned_to TEXT,
    verification_method TEXT,
    code_content TEXT, -- NEW: For storing full code for new files or diffs for existing files
    creation_timestamp_unix INTEGER NOT NULL,
    creation_timestamp_iso TEXT NOT NULL,
    last_updated_timestamp_unix INTEGER NOT NULL,
    last_updated_timestamp_iso TEXT NOT NULL,
    completion_timestamp_unix INTEGER,
    completion_timestamp_iso TEXT,
    notes_json TEXT,
    FOREIGN KEY (plan_id) REFERENCES plans (plan_id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id) REFERENCES agents (agent_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_plan_tasks_plan_id_status ON plan_tasks (plan_id, status);
CREATE INDEX IF NOT EXISTS idx_plan_tasks_agent_id_status ON plan_tasks (agent_id, status);
CREATE INDEX IF NOT EXISTS idx_plan_tasks_task_number ON plan_tasks (task_number);
CREATE INDEX IF NOT EXISTS idx_plan_tasks_creation_ts ON plan_tasks (creation_timestamp_unix);

-- Subtasks table
CREATE TABLE IF NOT EXISTS subtasks (
    subtask_id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    parent_task_id TEXT,
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'PLANNED',
    creation_timestamp_unix INTEGER NOT NULL,
    creation_timestamp_iso TEXT NOT NULL,
    last_updated_timestamp_unix INTEGER NOT NULL,
    last_updated_timestamp_iso TEXT NOT NULL,
    completion_timestamp_unix INTEGER,
    completion_timestamp_iso TEXT,
    notes_json TEXT,
    FOREIGN KEY (plan_id) REFERENCES plans (plan_id) ON DELETE CASCADE,
    FOREIGN KEY (parent_task_id) REFERENCES plan_tasks (task_id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id) REFERENCES agents (agent_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_subtasks_parent_task_id ON subtasks (parent_task_id);
CREATE INDEX IF NOT EXISTS idx_subtasks_agent_id_status ON subtasks (agent_id, status);
CREATE INDEX IF NOT EXISTS idx_subtasks_plan_id ON subtasks (plan_id);
CREATE INDEX IF NOT EXISTS idx_subtasks_creation_ts ON subtasks (creation_timestamp_unix);

-- Refined Prompts table
CREATE TABLE IF NOT EXISTS refined_prompts (
    refined_prompt_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    original_prompt_text TEXT NOT NULL,
    refinement_engine_model TEXT,
    refinement_timestamp INTEGER NOT NULL,
    overall_goal TEXT,
    decomposed_tasks TEXT,
    key_entities_identified TEXT,
    implicit_assumptions_made_by_refiner TEXT,
    explicit_constraints_from_prompt TEXT,
    suggested_ai_role_for_agent TEXT,
    suggested_reasoning_strategy_for_agent TEXT,
    desired_output_characteristics_inferred TEXT,
    suggested_context_analysis_for_agent TEXT,
    codebase_context_summary_by_ai TEXT,
    relevant_code_elements_analyzed TEXT,
    confidence_in_refinement_score TEXT,
    refinement_error_message TEXT,
    FOREIGN KEY (agent_id) REFERENCES agents (agent_id)
);
CREATE INDEX IF NOT EXISTS idx_refined_prompts_agent_id ON refined_prompts (agent_id);
CREATE INDEX IF NOT EXISTS idx_refined_prompts_timestamp ON refined_prompts (refinement_timestamp);

-- Tool Execution Logs table
CREATE TABLE IF NOT EXISTS tool_execution_logs (
    log_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    plan_id TEXT,
    task_id TEXT,
    subtask_id TEXT,
    tool_name TEXT NOT NULL,
    arguments_json TEXT,
    status TEXT NOT NULL,
    output_summary TEXT,
    execution_start_timestamp_unix INTEGER NOT NULL,
    execution_start_timestamp_iso TEXT NOT NULL,
    execution_end_timestamp_unix INTEGER,
    execution_end_timestamp_iso TEXT,
    duration_ms INTEGER,
    step_number_executed TEXT,
    plan_step_title TEXT,
    log_creation_timestamp_unix INTEGER NOT NULL,
    log_creation_timestamp_iso TEXT NOT NULL,
    last_updated_timestamp_unix INTEGER NOT NULL,
    last_updated_timestamp_iso TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents (agent_id) ON DELETE CASCADE,
    FOREIGN KEY (plan_id) REFERENCES plans (plan_id) ON DELETE SET NULL,
    FOREIGN KEY (task_id) REFERENCES plan_tasks (task_id) ON DELETE SET NULL,
    FOREIGN KEY (subtask_id) REFERENCES subtasks (subtask_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_exec_logs_agent_start_ts ON tool_execution_logs (agent_id, execution_start_timestamp_unix);
CREATE INDEX IF NOT EXISTS idx_tool_exec_logs_plan_id ON tool_execution_logs (plan_id);
CREATE INDEX IF NOT EXISTS idx_tool_exec_logs_task_id ON tool_execution_logs (task_id);
CREATE INDEX IF NOT EXISTS idx_tool_exec_logs_subtask_id ON tool_execution_logs (subtask_id);
CREATE INDEX IF NOT EXISTS idx_tool_exec_logs_tool_name ON tool_execution_logs (tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_exec_logs_status ON tool_execution_logs (status);
CREATE INDEX IF NOT EXISTS idx_tool_exec_logs_creation_ts ON tool_execution_logs (log_creation_timestamp_unix);

-- Task Progress Logs table
CREATE TABLE IF NOT EXISTS task_progress_logs (
    progress_log_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    associated_plan_id TEXT NOT NULL,
    associated_task_id TEXT NOT NULL,
    associated_subtask_id TEXT,
    step_number_executed TEXT,
    plan_step_title TEXT,
    action_tool_used TEXT,
    tool_parameters_summary_json TEXT,
    files_modified_list_json TEXT,
    change_summary_text TEXT,
    execution_timestamp_unix INTEGER NOT NULL,
    execution_timestamp_iso TEXT NOT NULL,
    status_of_step_execution TEXT NOT NULL,
    output_summary_or_error TEXT,
    log_creation_timestamp_unix INTEGER NOT NULL,
    log_creation_timestamp_iso TEXT NOT NULL,
    last_updated_timestamp_unix INTEGER NOT NULL,
    last_updated_timestamp_iso TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents (agent_id) ON DELETE CASCADE,
    FOREIGN KEY (associated_plan_id) REFERENCES plans (plan_id) ON DELETE CASCADE,
    FOREIGN KEY (associated_task_id) REFERENCES plan_tasks (task_id) ON DELETE CASCADE,
    FOREIGN KEY (associated_subtask_id) REFERENCES subtasks (subtask_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_prog_logs_agent_exec_ts ON task_progress_logs (agent_id, execution_timestamp_unix);
CREATE INDEX IF NOT EXISTS idx_task_prog_logs_plan_id ON task_progress_logs (associated_plan_id);
CREATE INDEX IF NOT EXISTS idx_task_prog_logs_task_id ON task_progress_logs (associated_task_id);
CREATE INDEX IF NOT EXISTS idx_task_prog_logs_subtask_id ON task_progress_logs (associated_subtask_id);
CREATE INDEX IF NOT EXISTS idx_task_prog_logs_status ON task_progress_logs (status_of_step_execution);
CREATE INDEX IF NOT EXISTS idx_task_prog_logs_creation_ts ON task_progress_logs (log_creation_timestamp_unix);

-- Error Logs table
CREATE TABLE IF NOT EXISTS error_logs (
    error_log_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    associated_plan_id TEXT,
    associated_task_id TEXT,
    associated_subtask_id TEXT,
    associated_tool_execution_log_id TEXT,
    error_type TEXT NOT NULL,
    error_message TEXT NOT NULL,
    stack_trace TEXT,
    source_file TEXT,
    source_line INTEGER,
    severity TEXT DEFAULT 'MEDIUM',
    status TEXT NOT NULL DEFAULT 'NEW',
    resolution_details TEXT,
    error_timestamp_unix INTEGER NOT NULL,
    error_timestamp_iso TEXT NOT NULL,
    log_creation_timestamp_unix INTEGER NOT NULL,
    log_creation_timestamp_iso TEXT NOT NULL,
    last_updated_timestamp_unix INTEGER NOT NULL,
    last_updated_timestamp_iso TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents (agent_id) ON DELETE CASCADE,
    FOREIGN KEY (associated_plan_id) REFERENCES plans (plan_id) ON DELETE SET NULL,
    FOREIGN KEY (associated_task_id) REFERENCES plan_tasks (task_id) ON DELETE SET NULL,
    FOREIGN KEY (associated_subtask_id) REFERENCES subtasks (subtask_id) ON DELETE SET NULL,
    FOREIGN KEY (associated_tool_execution_log_id) REFERENCES tool_execution_logs (log_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_error_logs_agent_error_ts ON error_logs (agent_id, error_timestamp_unix);
CREATE INDEX IF NOT EXISTS idx_error_logs_type ON error_logs (error_type);
CREATE INDEX IF NOT EXISTS idx_error_logs_severity ON error_logs (severity);
CREATE INDEX IF NOT EXISTS idx_error_logs_status ON error_logs (status);
CREATE INDEX IF NOT EXISTS idx_error_logs_plan_id ON error_logs (associated_plan_id);
CREATE INDEX IF NOT EXISTS idx_error_logs_task_id ON error_logs (associated_task_id);
CREATE INDEX IF NOT EXISTS idx_error_logs_creation_ts ON error_logs (log_creation_timestamp_unix);

-- Task Review Logs table
CREATE TABLE IF NOT EXISTS task_review_logs (
    review_log_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    reviewer TEXT,
    review_timestamp_unix INTEGER NOT NULL,
    review_timestamp_iso TEXT NOT NULL,
    review_status TEXT NOT NULL,
    review_notes_md TEXT,
    issues_found_json TEXT,
    resolution_notes_md TEXT,
    last_updated_timestamp_unix INTEGER NOT NULL,
    last_updated_timestamp_iso TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents (agent_id) ON DELETE CASCADE,
    FOREIGN KEY (plan_id) REFERENCES plans (plan_id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES plan_tasks (task_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_review_logs_plan_id ON task_review_logs (plan_id);
CREATE INDEX IF NOT EXISTS idx_task_review_logs_task_id ON task_review_logs (task_id);
CREATE INDEX IF NOT EXISTS idx_task_review_logs_agent_id ON task_review_logs (agent_id);
CREATE INDEX IF NOT EXISTS idx_task_review_logs_status ON task_review_logs (review_status);
CREATE INDEX IF NOT EXISTS idx_task_review_logs_timestamp ON task_review_logs (review_timestamp_unix);

-- Final Plan Review Logs table
CREATE TABLE IF NOT EXISTS final_plan_review_logs (
    final_review_log_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    reviewer TEXT,
    review_timestamp_unix INTEGER NOT NULL,
    review_timestamp_iso TEXT NOT NULL,
    review_status TEXT NOT NULL,
    review_notes_md TEXT,
    issues_found_json TEXT,
    resolution_notes_md TEXT,
    last_updated_timestamp_unix INTEGER NOT NULL,
    last_updated_timestamp_iso TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents (agent_id) ON DELETE CASCADE,
    FOREIGN KEY (plan_id) REFERENCES plans (plan_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_final_plan_review_logs_plan_id ON final_plan_review_logs (plan_id);
CREATE INDEX IF NOT EXISTS idx_final_plan_review_logs_agent_id ON final_plan_review_logs (agent_id);
CREATE INDEX IF NOT EXISTS idx_final_plan_review_logs_status ON final_plan_review_logs (review_status);
CREATE INDEX IF NOT EXISTS idx_final_plan_review_logs_timestamp ON final_plan_review_logs (review_timestamp_unix);

-- Insert default agents
INSERT OR IGNORE INTO agents (agent_id, name, description, creation_timestamp_unix, creation_timestamp_iso)
VALUES ('cline', 'Default AI Agent', 'Automatically created default agent for testing and operations.', STRFTIME('%s', 'now') * 1000, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT OR IGNORE INTO agents (agent_id, name, description, creation_timestamp_unix, creation_timestamp_iso)
VALUES ('test_agent', 'Test AI Agent', 'Agent for testing purposes.', STRFTIME('%s', 'now') * 1000, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'));