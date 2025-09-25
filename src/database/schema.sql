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
    sequence_number INTEGER, -- New: User-friendly sequence number for the agent
    start_timestamp INTEGER NOT NULL,
    end_timestamp INTEGER,
    metadata TEXT,
    FOREIGN KEY (agent_id) REFERENCES agents (agent_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_agent_id ON conversation_sessions (agent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_start_time ON conversation_sessions (start_timestamp);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_agent_sequence ON conversation_sessions (agent_id, sequence_number);

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
    metadata TEXT,
    embedding BLOB,
    FOREIGN KEY (session_id) REFERENCES conversation_sessions (session_id) ON DELETE CASCADE,
    FOREIGN KEY (parent_message_id) REFERENCES conversation_messages (message_id) ON DELETE SET NULL,
    FOREIGN KEY (context_snapshot_id) REFERENCES context_information (context_id)
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
    phase TEXT, -- NEW: Phase identifier (e.g., 'Phase 1: Analysis & Design', 'Phase 2: Core Implementation')
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
    generation_metadata_json TEXT, -- NEW: Add column for RAG metrics
    FOREIGN KEY (agent_id) REFERENCES agents (agent_id)
);
CREATE INDEX IF NOT EXISTS idx_refined_prompts_agent_id ON refined_prompts (agent_id);
CREATE INDEX IF NOT EXISTS idx_refined_prompts_timestamp ON refined_prompts (refinement_timestamp);

-- AI Code Review Results table
CREATE TABLE IF NOT EXISTS code_review_sessions (
    review_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    repository_path TEXT NOT NULL,
    base_ref TEXT NOT NULL,
    head_ref TEXT NOT NULL,
    review_timestamp INTEGER NOT NULL,
    review_timestamp_iso TEXT NOT NULL,
    analysis_model TEXT,
    risk_score INTEGER, -- 0-10 scale
    overall_status TEXT, -- 'pass', 'block', 'pass_with_fixes'
    total_files_changed INTEGER DEFAULT 0,
    total_untracked_files INTEGER DEFAULT 0,
    high_issues_count INTEGER DEFAULT 0,
    medium_issues_count INTEGER DEFAULT 0,
    low_issues_count INTEGER DEFAULT 0,
    project_config_json TEXT, -- Store project configuration
    diff_context_summary TEXT, -- Brief summary of changes
    full_ai_response TEXT, -- Complete AI analysis response
    FOREIGN KEY (agent_id) REFERENCES agents (agent_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_code_reviews_agent_id ON code_review_sessions (agent_id);
CREATE INDEX IF NOT EXISTS idx_code_reviews_timestamp ON code_review_sessions (review_timestamp);
CREATE INDEX IF NOT EXISTS idx_code_reviews_repo ON code_review_sessions (repository_path);
CREATE INDEX IF NOT EXISTS idx_code_reviews_status ON code_review_sessions (overall_status);

-- Code Review Findings table - separate concerns for detailed findings
CREATE TABLE IF NOT EXISTS code_review_findings (
    finding_id TEXT PRIMARY KEY,
    review_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    line_start INTEGER,
    line_end INTEGER,
    severity TEXT NOT NULL, -- 'high', 'medium', 'low'
    category TEXT NOT NULL, -- 'security', 'correctness', 'performance', etc.
    rule_code TEXT, -- Rule or standard identifier
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    impact TEXT,
    fix_suggestion TEXT,
    code_snippet TEXT,
    hunk_header TEXT,
    needs_verification BOOLEAN DEFAULT 0,
    creation_timestamp INTEGER NOT NULL,
    FOREIGN KEY (review_id) REFERENCES code_review_sessions (review_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_findings_review_id ON code_review_findings (review_id);
CREATE INDEX IF NOT EXISTS idx_findings_severity ON code_review_findings (severity);
CREATE INDEX IF NOT EXISTS idx_findings_category ON code_review_findings (category);
CREATE INDEX IF NOT EXISTS idx_findings_file_path ON code_review_findings (file_path);

-- Code Review Patches table - store suggested fixes
CREATE TABLE IF NOT EXISTS code_review_patches (
    patch_id TEXT PRIMARY KEY,
    review_id TEXT NOT NULL,
    finding_id TEXT, -- Optional: link to specific finding
    file_path TEXT NOT NULL,
    patch_title TEXT NOT NULL,
    unified_diff TEXT NOT NULL,
    patch_description TEXT,
    creation_timestamp INTEGER NOT NULL,
    FOREIGN KEY (review_id) REFERENCES code_review_sessions (review_id) ON DELETE CASCADE,
    FOREIGN KEY (finding_id) REFERENCES code_review_findings (finding_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_patches_review_id ON code_review_patches (review_id);
CREATE INDEX IF NOT EXISTS idx_patches_finding_id ON code_review_patches (finding_id);
CREATE INDEX IF NOT EXISTS idx_patches_file_path ON code_review_patches (file_path);

-- Insert default agents
INSERT OR IGNORE INTO agents (agent_id, name, description, creation_timestamp_unix, creation_timestamp_iso)
VALUES ('cline', 'Default AI Agent', 'Automatically created default agent for testing and operations.', STRFTIME('%s', 'now') * 1000, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT OR IGNORE INTO agents (agent_id, name, description, creation_timestamp_unix, creation_timestamp_iso)
VALUES ('test_agent', 'Test AI Agent', 'Agent for testing purposes.', STRFTIME('%s', 'now') * 1000, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'));
