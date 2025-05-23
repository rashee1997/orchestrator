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

CREATE TABLE IF NOT EXISTS correction_logs (
    correction_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    correction_type TEXT NOT NULL,
    original_entry_id TEXT,
    original_value TEXT,
    corrected_value TEXT,
    reason TEXT,
    applied_automatically BOOLEAN NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_correction_logs_agent_ts ON correction_logs (agent_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_correction_logs_type ON correction_logs (correction_type);

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
