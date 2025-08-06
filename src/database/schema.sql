CREATE TABLE IF NOT EXISTS conversation_history (
    conversation_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    user_id TEXT,
    timestamp INTEGER NOT NULL,
    sender TEXT NOT NULL,
    message_content TEXT NOT NULL,
    message_type TEXT,
    tool_info TEXT,
    context_snapshot_id TEXT,
    source_attribution_id TEXT,
    FOREIGN KEY (context_snapshot_id) REFERENCES context_information(context_id),
    FOREIGN KEY (source_attribution_id) REFERENCES source_attribution(attribution_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_history_conv_ts ON conversation_history (conversation_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_conversation_history_agent_id ON conversation_history (agent_id);
CREATE INDEX IF NOT EXISTS idx_conversation_history_user_id ON conversation_history (user_id);

CREATE TABLE IF NOT EXISTS context_information (
    context_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    context_type TEXT NOT NULL,
    context_data TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    parent_context_id TEXT,
    FOREIGN KEY (parent_context_id) REFERENCES context_information(context_id)
);

CREATE INDEX IF NOT EXISTS idx_context_information_agent_ts ON context_information (agent_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_context_information_context_type ON context_information (context_type);

CREATE TABLE IF NOT EXISTS reference_keys (
    reference_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    key_type TEXT NOT NULL,
    key_value TEXT NOT NULL,
    description TEXT,
    timestamp INTEGER NOT NULL,
    associated_conversation_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_reference_keys_agent_type_value ON reference_keys (agent_id, key_type, key_value);

CREATE TABLE IF NOT EXISTS source_attribution (
    attribution_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_uri TEXT,
    retrieval_timestamp INTEGER NOT NULL,
    content_summary TEXT,
    full_content_hash TEXT,
    full_content_json TEXT -- New column for full content
);

CREATE INDEX IF NOT EXISTS idx_source_attribution_agent_type_ts ON source_attribution (agent_id, source_type, retrieval_timestamp);

CREATE TABLE IF NOT EXISTS agents (
    agent_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    creation_timestamp_unix INTEGER NOT NULL,
    creation_timestamp_iso TEXT NOT NULL,
    last_updated_timestamp_unix INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    last_updated_timestamp_iso TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    configuration_json TEXT, -- JSON blob for agent-specific settings
    status TEXT DEFAULT 'ACTIVE' -- e.g., ACTIVE, INACTIVE, DELETED
);
CREATE INDEX IF NOT EXISTS idx_agents_name ON agents (name);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents (status);


-- Ensure correction_logs table exists and is updated
CREATE TABLE IF NOT EXISTS correction_logs (
    correction_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    correction_type TEXT NOT NULL, -- e.g., user_feedback, self_correction
    original_entry_id TEXT,      -- ID of the entity that was corrected (e.g., plan_id, task_id, log_id)
    original_value_json TEXT,    -- JSON of the original data
    corrected_value_json TEXT,   -- JSON of the corrected data
    reason TEXT,
    correction_summary TEXT,     -- AI-generated summary of the correction
    applied_automatically BOOLEAN NOT NULL,
    creation_timestamp_unix INTEGER NOT NULL,
    creation_timestamp_iso TEXT NOT NULL,
    last_updated_timestamp_unix INTEGER NOT NULL,
    last_updated_timestamp_iso TEXT NOT NULL,
    status TEXT DEFAULT 'LOGGED', -- e.g., LOGGED, REVIEWED, ACTION_TAKEN
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_correction_logs_agent_id_type ON correction_logs (agent_id, correction_type);
CREATE INDEX IF NOT EXISTS idx_correction_logs_status ON correction_logs (status);

CREATE TABLE IF NOT EXISTS success_metrics (
    metric_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    metric_name TEXT NOT NULL,
    metric_value REAL NOT NULL,
    unit TEXT,
    associated_task_id TEXT,
    metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_success_metrics_agent_name_ts ON success_metrics (agent_id, metric_name, timestamp);

-- Knowledge Graph Tables
CREATE TABLE IF NOT EXISTS knowledge_graph_nodes (
    node_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    observations TEXT, -- JSON string of observations
    timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kg_nodes_agent_id ON knowledge_graph_nodes (agent_id);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_name ON knowledge_graph_nodes (name);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_entity_type ON knowledge_graph_nodes (entity_type);

CREATE TABLE IF NOT EXISTS knowledge_graph_relations (
    relation_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    from_node_id TEXT NOT NULL,
    to_node_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    FOREIGN KEY (from_node_id) REFERENCES knowledge_graph_nodes(node_id) ON DELETE CASCADE,
    FOREIGN KEY (to_node_id) REFERENCES knowledge_graph_nodes(node_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_kg_relations_agent_id ON knowledge_graph_relations (agent_id);
CREATE INDEX IF NOT EXISTS idx_kg_relations_from_to ON knowledge_graph_relations (from_node_id, to_node_id);
CREATE INDEX IF NOT EXISTS idx_kg_relations_type ON knowledge_graph_relations (relation_type);

-- Ensure plans table exists (from previous schema parts)
CREATE TABLE IF NOT EXISTS plans (
    plan_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL,
    overall_goal TEXT,
    status TEXT NOT NULL DEFAULT 'DRAFT',       -- e.g., DRAFT, APPROVED, IN_PROGRESS, COMPLETED, HALTED, FAILED
    version INTEGER NOT NULL DEFAULT 1,
    creation_timestamp_unix INTEGER NOT NULL,
    creation_timestamp_iso TEXT NOT NULL,
    last_updated_timestamp_unix INTEGER NOT NULL,
    last_updated_timestamp_iso TEXT NOT NULL,
    refined_prompt_id_associated TEXT,
    analysis_report_id_referenced TEXT,
    metadata TEXT,
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_plans_agent_id_status ON plans (agent_id, status);

-- Ensure plan_tasks table exists (from previous schema parts)
CREATE TABLE IF NOT EXISTS plan_tasks (
    task_id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    task_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'PLANNED',     -- e.g., PLANNED, IN_PROGRESS, COMPLETED, FAILED, BLOCKED, SKIPPED
    purpose TEXT,
    action_description TEXT,
    files_involved_json TEXT,                   -- JSON array of strings
    dependencies_task_ids_json TEXT,            -- JSON array of task_ids
    tools_required_list_json TEXT,              -- JSON array of strings
    inputs_summary TEXT,
    outputs_summary TEXT,
    success_criteria_text TEXT,
    estimated_effort_hours REAL,
    assigned_to TEXT,
    verification_method TEXT,
    creation_timestamp_unix INTEGER NOT NULL,
    creation_timestamp_iso TEXT NOT NULL,
    last_updated_timestamp_unix INTEGER NOT NULL,
    last_updated_timestamp_iso TEXT NOT NULL,
    completion_timestamp_unix INTEGER,
    completion_timestamp_iso TEXT,
    notes_json TEXT,                            -- JSON blob
    FOREIGN KEY (plan_id) REFERENCES plans(plan_id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_plan_tasks_plan_id_status ON plan_tasks (plan_id, status);
CREATE INDEX IF NOT EXISTS idx_plan_tasks_agent_id_status ON plan_tasks (agent_id, status);

-- Ensure subtasks table exists (from previous schema parts)
CREATE TABLE IF NOT EXISTS subtasks (
    subtask_id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    parent_task_id TEXT,                        -- FK to plan_tasks.task_id (nullable)
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'PLANNED',     -- e.g., PLANNED, IN_PROGRESS, COMPLETED, FAILED, BLOCKED, SKIPPED
    creation_timestamp_unix INTEGER NOT NULL,
    creation_timestamp_iso TEXT NOT NULL,
    last_updated_timestamp_unix INTEGER NOT NULL,
    last_updated_timestamp_iso TEXT NOT NULL,
    completion_timestamp_unix INTEGER,
    completion_timestamp_iso TEXT,
    notes_json TEXT,                             -- JSON blob
    FOREIGN KEY (plan_id) REFERENCES plans(plan_id) ON DELETE CASCADE,
    FOREIGN KEY (parent_task_id) REFERENCES plan_tasks(task_id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_subtasks_parent_task_id ON subtasks (parent_task_id);
CREATE INDEX IF NOT EXISTS idx_subtasks_agent_id_status ON subtasks (agent_id, status);

-- New table for Refined Prompts
CREATE TABLE IF NOT EXISTS refined_prompts (
    refined_prompt_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    original_prompt_text TEXT NOT NULL,
    refinement_engine_model TEXT,
    refinement_timestamp INTEGER NOT NULL,
    overall_goal TEXT,
    decomposed_tasks TEXT, -- JSON array of strings
    key_entities_identified TEXT, -- JSON array of strings/objects
    implicit_assumptions_made_by_refiner TEXT, -- JSON array of strings
    explicit_constraints_from_prompt TEXT, -- JSON array of strings
    suggested_ai_role_for_agent TEXT,
    suggested_reasoning_strategy_for_agent TEXT,
    desired_output_characteristics_inferred TEXT, -- JSON object
    suggested_context_analysis_for_agent TEXT, -- JSON array of objects
    codebase_context_summary_by_ai TEXT, -- New field for AI-generated codebase context summary
    relevant_code_elements_analyzed TEXT, -- New field for relevant code elements analyzed
    confidence_in_refinement_score TEXT,
    refinement_error_message TEXT,
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id) -- Assuming an 'agents' table exists or will exist
);

CREATE INDEX IF NOT EXISTS idx_refined_prompts_agent_id ON refined_prompts (agent_id);
CREATE INDEX IF NOT EXISTS idx_refined_prompts_timestamp ON refined_prompts (refinement_timestamp);

-- Ensure agents table exists (from previous schema parts)
CREATE TABLE IF NOT EXISTS agents (
    agent_id TEXT PRIMARY KEY,
    name TEXT,
    description TEXT,
    creation_timestamp_unix INTEGER NOT NULL,
    creation_timestamp_iso TEXT NOT NULL -- ISO8601 format (e.g., YYYY-MM-DDTHH:MM:SS.sssZ)
);

-- New table for Mode Instructions
-- New Dedicated Table for Tool Execution Logs
CREATE TABLE IF NOT EXISTS tool_execution_logs (
    log_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    plan_id TEXT,                       -- Optional: Link to the plan if applicable
    task_id TEXT,                       -- Optional: Link to the specific task if applicable
    subtask_id TEXT,                    -- Optional: Link to the specific subtask if applicable
    tool_name TEXT NOT NULL,
    arguments_json TEXT,                -- JSON object of arguments passed to the tool
    status TEXT NOT NULL,               -- Updatable: e.g., 'ATTEMPTING_EXECUTION', 'EXECUTION_SUCCESS', 'EXECUTION_FAILURE', 'RETRYING'
    output_summary TEXT,                -- Summary of the tool's output or error message
    execution_start_timestamp_unix INTEGER NOT NULL,
    execution_start_timestamp_iso TEXT NOT NULL,
    execution_end_timestamp_unix INTEGER, -- Nullable if still attempting or failed before completion
    execution_end_timestamp_iso TEXT,   -- Nullable
    duration_ms INTEGER,                -- Calculated: end - start
    step_number_executed TEXT,          -- The plan step number being executed (e.g., "2.1")
    plan_step_title TEXT,               -- The title of the plan step
    log_creation_timestamp_unix INTEGER NOT NULL, -- When this log record was created
    log_creation_timestamp_iso TEXT NOT NULL,
    last_updated_timestamp_unix INTEGER NOT NULL, -- When this log record was last updated (e.g., status change)
    last_updated_timestamp_iso TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
    FOREIGN KEY (plan_id) REFERENCES plans(plan_id) ON DELETE SET NULL, -- Keep log even if plan is deleted, but unlink
    FOREIGN KEY (task_id) REFERENCES plan_tasks(task_id) ON DELETE SET NULL,
    FOREIGN KEY (subtask_id) REFERENCES subtasks(subtask_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_exec_logs_agent_start_ts ON tool_execution_logs (agent_id, execution_start_timestamp_unix);
CREATE INDEX IF NOT EXISTS idx_tool_exec_logs_plan_id ON tool_execution_logs (plan_id);
CREATE INDEX IF NOT EXISTS idx_tool_exec_logs_task_id ON tool_execution_logs (task_id);
CREATE INDEX IF NOT EXISTS idx_tool_exec_logs_subtask_id ON tool_execution_logs (subtask_id);
CREATE INDEX IF NOT EXISTS idx_tool_exec_logs_tool_name ON tool_execution_logs (tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_exec_logs_status ON tool_execution_logs (status);

-- New Dedicated Table for Task Progress Logs
CREATE TABLE IF NOT EXISTS task_progress_logs (
    progress_log_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    associated_plan_id TEXT NOT NULL,
    associated_task_id TEXT NOT NULL,   -- This would be the plan_tasks.task_id
    associated_subtask_id TEXT,         -- Optional: if progress is for a subtask, store subtasks.subtask_id here
    step_number_executed TEXT,          -- The plan step number that was executed
    plan_step_title TEXT,               -- The title of the plan step
    action_tool_used TEXT,              -- Name of the primary tool used for this step's action
    tool_parameters_summary_json TEXT,  -- JSON object summarizing tool parameters
    files_modified_list_json TEXT,      -- JSON array of strings (paths of modified files)
    change_summary_text TEXT,           -- Human-readable summary of changes or actions
    execution_timestamp_unix INTEGER NOT NULL, -- Timestamp of when the step/action *completed*
    execution_timestamp_iso TEXT NOT NULL,
    status_of_step_execution TEXT NOT NULL, -- Updatable: e.g., 'SUCCESS', 'FAILURE', 'PARTIAL_SUCCESS'
    output_summary_or_error TEXT,       -- Summary of the outcome or error details for this step
    log_creation_timestamp_unix INTEGER NOT NULL,
    log_creation_timestamp_iso TEXT NOT NULL,
    last_updated_timestamp_unix INTEGER NOT NULL,
    last_updated_timestamp_iso TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
    FOREIGN KEY (associated_plan_id) REFERENCES plans(plan_id) ON DELETE CASCADE,
    FOREIGN KEY (associated_task_id) REFERENCES plan_tasks(task_id) ON DELETE CASCADE,
    FOREIGN KEY (associated_subtask_id) REFERENCES subtasks(subtask_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_prog_logs_agent_exec_ts ON task_progress_logs (agent_id, execution_timestamp_unix);
CREATE INDEX IF NOT EXISTS idx_task_prog_logs_plan_id ON task_progress_logs (associated_plan_id);
CREATE INDEX IF NOT EXISTS idx_task_prog_logs_task_id ON task_progress_logs (associated_task_id);
CREATE INDEX IF NOT EXISTS idx_task_prog_logs_subtask_id ON task_progress_logs (associated_subtask_id);
CREATE INDEX IF NOT EXISTS idx_task_prog_logs_status ON task_progress_logs (status_of_step_execution);

-- New Dedicated Table for Error Logs
CREATE TABLE IF NOT EXISTS error_logs (
    error_log_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    associated_plan_id TEXT,
    associated_task_id TEXT,
    associated_subtask_id TEXT,
    associated_tool_execution_log_id TEXT, -- Link to a specific tool call that errored
    error_type TEXT NOT NULL,             -- e.g., 'TypeScript Compilation Error', 'Runtime Exception', 'API Error', 'Tool Execution Failure'
    error_message TEXT NOT NULL,
    stack_trace TEXT,
    source_file TEXT,                     -- File where the error originated, if applicable
    source_line INTEGER,                  -- Line number, if applicable
    severity TEXT DEFAULT 'MEDIUM',       -- e.g., 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'
    status TEXT NOT NULL DEFAULT 'NEW',   -- Updatable: e.g., 'NEW', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED', 'IGNORED'
    resolution_details TEXT,              -- How the error was resolved, if applicable
    error_timestamp_unix INTEGER NOT NULL,  -- When the error occurred
    error_timestamp_iso TEXT NOT NULL,
    log_creation_timestamp_unix INTEGER NOT NULL,
    log_creation_timestamp_iso TEXT NOT NULL,
    last_updated_timestamp_unix INTEGER NOT NULL,
    last_updated_timestamp_iso TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
    FOREIGN KEY (associated_plan_id) REFERENCES plans(plan_id) ON DELETE SET NULL,
    FOREIGN KEY (associated_task_id) REFERENCES plan_tasks(task_id) ON DELETE SET NULL,
    FOREIGN KEY (associated_subtask_id) REFERENCES subtasks(subtask_id) ON DELETE SET NULL,
    FOREIGN KEY (associated_tool_execution_log_id) REFERENCES tool_execution_logs(log_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_error_logs_agent_error_ts ON error_logs (agent_id, error_timestamp_unix);
CREATE INDEX IF NOT EXISTS idx_error_logs_type ON error_logs (error_type);
CREATE INDEX IF NOT EXISTS idx_error_logs_severity ON error_logs (severity);
CREATE INDEX IF NOT EXISTS idx_error_logs_status ON error_logs (status);
CREATE INDEX IF NOT EXISTS idx_error_logs_plan_id ON error_logs (associated_plan_id);
CREATE INDEX IF NOT EXISTS idx_error_logs_task_id ON error_logs (associated_task_id);

-- Table for Task Review Logs (per task step, linked to plan_id and task_id)
CREATE TABLE IF NOT EXISTS task_review_logs (
    review_log_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    reviewer TEXT,
    review_timestamp_unix INTEGER NOT NULL,
    review_timestamp_iso TEXT NOT NULL,
    review_status TEXT NOT NULL, -- e.g., PASSED, FAILED, NEEDS_CHANGES
    review_notes_md TEXT,
    issues_found_json TEXT,
    resolution_notes_md TEXT,
    last_updated_timestamp_unix INTEGER NOT NULL,
    last_updated_timestamp_iso TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
    FOREIGN KEY (plan_id) REFERENCES plans(plan_id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES plan_tasks(task_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_review_logs_plan_id ON task_review_logs (plan_id);
CREATE INDEX IF NOT EXISTS idx_task_review_logs_task_id ON task_review_logs (task_id);
CREATE INDEX IF NOT EXISTS idx_task_review_logs_agent_id ON task_review_logs (agent_id);
CREATE INDEX IF NOT EXISTS idx_task_review_logs_status ON task_review_logs (review_status);

-- Table for Final Plan Review Logs (one per plan, after all tasks, linked to plan_id only)
CREATE TABLE IF NOT EXISTS final_plan_review_logs (
    final_review_log_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    reviewer TEXT,
    review_timestamp_unix INTEGER NOT NULL,
    review_timestamp_iso TEXT NOT NULL,
    review_status TEXT NOT NULL, -- e.g., PASSED, FAILED, NEEDS_CHANGES
    review_notes_md TEXT,
    issues_found_json TEXT,
    resolution_notes_md TEXT,
    last_updated_timestamp_unix INTEGER NOT NULL,
    last_updated_timestamp_iso TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
    FOREIGN KEY (plan_id) REFERENCES plans(plan_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_final_plan_review_logs_plan_id ON final_plan_review_logs (plan_id);
CREATE INDEX IF NOT EXISTS idx_final_plan_review_logs_agent_id ON final_plan_review_logs (agent_id);
CREATE INDEX IF NOT EXISTS idx_final_plan_review_logs_status ON final_plan_review_logs (review_status);

-- Ensure a default agent exists for foreign key constraints
INSERT OR IGNORE INTO agents (agent_id, name, description, creation_timestamp_unix, creation_timestamp_iso)
VALUES ('cline', 'Default AI Agent', 'Automatically created default agent for testing and operations.', STRFTIME('%s', 'now') * 1000, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'));
INSERT OR IGNORE INTO agents (agent_id, name, description, creation_timestamp_unix, creation_timestamp_iso)
VALUES ('test_agent', 'Test AI Agent', 'Agent for testing purposes.', STRFTIME('%s', 'now') * 1000, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'));


