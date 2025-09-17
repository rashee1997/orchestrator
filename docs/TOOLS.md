# 🛠️ Tool Reference Documentation

Complete reference for all 54 sophisticated tools provided by Memory MCP Server - Orchestrator.

## Tool Categories Overview

| Category | Count | Description |
|----------|-------|-------------|
| [Conversation Management](#conversation-management) | 9 | Session and message handling |
| [Plan & Task Management](#plan--task-management) | 15 | Project planning and tracking |
| [Knowledge Graph](#knowledge-graph) | 6 | Code structure analysis |
| [Embedding & Search](#embedding--search) | 3 | Semantic code search |
| [AI Enhancement](#ai-enhancement) | 3 | Intelligent task optimization |
| [Advanced AI Integration](#advanced-ai-integration) | 1 | Multi-model orchestration |
| [Database Management](#database-management) | 3 | Data operations |
| [Web Search](#web-search) | 1 | External knowledge integration |

---

## Conversation Management

### `create_conversation_session`
Creates a new conversation session for persistent multi-turn dialogue.

**Parameters:**
- `agent_id` (string, required): Unique identifier for the agent
- `title` (string, optional): Session title
- `reference_key` (string, optional): Custom reference identifier

**Returns:**
```json
{
  "session_id": "uuid",
  "title": "Session Title",
  "reference_key": "custom-ref",
  "created_at": "2024-01-01T00:00:00Z"
}
```

### `delete_conversation_session`
Removes a conversation session and all associated messages.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `session_id` (string, required): Session to delete

### `get_conversation_messages`
Retrieves messages from a conversation session with pagination.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `session_id` (string, required): Session identifier
- `limit` (number, optional): Maximum messages to return (default: 50)
- `offset` (number, optional): Number of messages to skip (default: 0)

### `add_conversation_message`
Adds a new message to an existing conversation session.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `session_id` (string, required): Session identifier
- `role` (string, required): Message role ('user', 'assistant', 'system')
- `content` (string, required): Message content

### `update_conversation_message`
Modifies an existing conversation message.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `message_id` (string, required): Message to update
- `content` (string, required): New message content

### `delete_conversation_message`
Removes a specific message from a conversation.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `message_id` (string, required): Message to delete

### `get_conversation_session_by_reference_key`
Finds a conversation session using a custom reference key.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `reference_key` (string, required): Custom reference to search for

### `update_conversation_session`
Updates metadata for an existing conversation session.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `session_id` (string, required): Session to update
- `title` (string, optional): New session title
- `reference_key` (string, optional): New reference key

### `list_conversation_sessions`
Lists all conversation sessions for an agent with optional filtering.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `limit` (number, optional): Maximum sessions to return
- `offset` (number, optional): Number of sessions to skip

---

## Plan & Task Management

### `create_task_plan`
Initializes a new project plan with metadata and structure.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `title` (string, required): Plan title
- `description` (string, optional): Plan description
- `metadata` (object, optional): Additional plan metadata

### `get_task_plan`
Retrieves detailed information about a specific plan.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `plan_id` (string, required): Plan identifier

### `update_task_plan`
Modifies an existing task plan's metadata.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `plan_id` (string, required): Plan to update
- `title` (string, optional): New plan title
- `description` (string, optional): New plan description
- `status` (string, optional): New plan status

### `delete_task_plan`
Removes a plan and all associated tasks and subtasks.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `plan_id` (string, required): Plan to delete

### `list_task_plans`
Lists all plans for an agent with optional filtering.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `status` (string, optional): Filter by plan status
- `limit` (number, optional): Maximum plans to return

### `create_task`
Adds a new task to an existing plan.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `plan_id` (string, required): Parent plan
- `title` (string, required): Task title
- `description` (string, optional): Task description
- `priority` (string, optional): Task priority ('low', 'medium', 'high')
- `assigned_to` (string, optional): Assignee identifier

### `get_task`
Retrieves detailed information about a specific task.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `task_id` (string, required): Task identifier

### `update_task`
Modifies an existing task's properties.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `task_id` (string, required): Task to update
- `title` (string, optional): New task title
- `description` (string, optional): New task description
- `status` (string, optional): New task status
- `priority` (string, optional): New task priority

### `delete_task`
Removes a task and all associated subtasks.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `task_id` (string, required): Task to delete

### `list_tasks`
Lists tasks with advanced filtering and sorting options.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `plan_id` (string, optional): Filter by plan
- `status` (string, optional): Filter by status
- `priority` (string, optional): Filter by priority
- `assigned_to` (string, optional): Filter by assignee

### `assign_task`
Assigns a task to a specific team member or agent.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `task_id` (string, required): Task to assign
- `assigned_to` (string, required): Assignee identifier

### `create_subtask`
Creates a subtask under an existing task.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `task_id` (string, required): Parent task
- `title` (string, required): Subtask title
- `description` (string, optional): Subtask description

### `get_subtask`
Retrieves information about a specific subtask.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `subtask_id` (string, required): Subtask identifier

### `update_subtask`
Modifies an existing subtask's properties.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `subtask_id` (string, required): Subtask to update
- `title` (string, optional): New subtask title
- `description` (string, optional): New subtask description
- `status` (string, optional): New subtask status

### `list_subtasks`
Lists subtasks for a task with filtering options.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `task_id` (string, required): Parent task
- `status` (string, optional): Filter by status

---

## Knowledge Graph

### `ingest_codebase_structure`
Analyzes and ingests codebase structure into the knowledge graph.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `directory_path` (string, required): Path to analyze
- `file_extensions` (array, optional): File types to include
- `ignore_patterns` (array, optional): Patterns to ignore

**Supported Languages:**
- TypeScript (.ts, .tsx)
- JavaScript (.js, .jsx)
- Python (.py)
- PHP (.php)

### `query_knowledge_graph`
Searches the knowledge graph for entities and relationships.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `query` (string, required): Search query
- `entity_types` (array, optional): Filter by entity types
- `file_paths` (array, optional): Filter by file paths

### `get_knowledge_graph_entity`
Retrieves detailed information about a specific entity.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `entity_id` (string, required): Entity identifier

### `update_knowledge_graph_entity`
Modifies metadata for a knowledge graph entity.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `entity_id` (string, required): Entity to update
- `metadata` (object, required): New metadata

### `delete_knowledge_graph_entity`
Removes an entity from the knowledge graph.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `entity_id` (string, required): Entity to delete

### `export_knowledge_graph`
Exports the knowledge graph in various formats.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `format` (string, optional): Export format ('jsonl', 'json', 'csv')
- `file_path` (string, optional): Output file path

---

## Embedding & Search

### `ingest_codebase_embeddings`
Generates vector embeddings for code with intelligent batching.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `directory_path` (string, required): Path to process
- `chunking_strategy` (string, optional): 'auto', 'function', 'class', 'sliding_window'
- `batch_size` (number, optional): Files per batch
- `disable_ai_output_summary` (boolean, optional): Skip AI summary generation

**Features:**
- **Multi-Model Support**: Gemini (3072D) + Codestral (3072D scaled)
- **Intelligent Routing**: Code → Codestral, Natural Language → Gemini
- **Batch Processing**: Dynamic sizing with API rate limiting protection
- **Change Detection**: File hash-based incremental updates

### `query_codebase_embeddings`
Performs semantic search across code embeddings with RAG capabilities.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `query` (string, required): Search query
- `limit` (number, optional): Maximum results (default: 10)
- `similarity_threshold` (number, optional): Minimum similarity score
- `file_extensions` (array, optional): Filter by file types
- `include_metadata` (boolean, optional): Include embedding metadata

**Advanced Features:**
- **Hybrid Search**: Vector + keyword + knowledge graph integration
- **DMQR**: Diverse Multi-Query Rewriting for comprehensive results
- **Iterative RAG**: Multi-round search with quality reflection
- **Score Fusion**: Weighted combination of multiple search methods

### `delete_embeddings`
Removes embeddings for specific files or the entire agent.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `file_paths` (array, optional): Specific files to remove
- `delete_all` (boolean, optional): Remove all embeddings for agent

---

## AI Enhancement

### `ai_suggest_subtasks`
Uses AI to decompose tasks into actionable subtasks.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `task_id` (string, required): Task to decompose
- `context` (string, optional): Additional context for AI
- `max_subtasks` (number, optional): Maximum subtasks to generate

### `ai_analyze_plan`
Analyzes plans for coherence, completeness, and potential issues.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `plan_id` (string, required): Plan to analyze
- `analysis_type` (string, optional): 'coherence', 'completeness', 'risks', 'all'

### `ai_suggest_task_details`
Enhances tasks with AI-generated details and recommendations.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `task_id` (string, required): Task to enhance
- `enhancement_type` (string, optional): 'description', 'requirements', 'timeline', 'all'

---

## Advanced AI Integration

### `ask_gemini`
Comprehensive AI integration with 50+ parameters and specialized execution modes.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `prompt` (string, required): Query or instruction
- `execution_mode` (string, optional): Specialized mode
- `temperature` (number, optional): Response creativity (0.0-1.0)
- `max_tokens` (number, optional): Maximum response length
- `context_sources` (array, optional): Additional context sources

**Execution Modes:**
- `plan_generation`: Structured project planning
- `code_analysis`: Deep code understanding
- `simple_question`: Direct Q&A
- `research_analysis`: Multi-source research
- `rag_search`: Retrieval-augmented generation

**Advanced Features:**
- **Multi-Model Orchestration**: Automatic model selection based on task type
- **Iterative RAG**: Multi-round search with quality reflection
- **DMQR Technology**: Diverse Multi-Query Rewriting
- **Hybrid Search**: Vector + keyword + knowledge graph integration

---

## Database Management

### `export_data_to_csv`
Exports all data to CSV format for analysis or backup.

**Parameters:**
- `agent_id` (string, required): Agent identifier
- `output_directory` (string, required): Export destination
- `include_embeddings` (boolean, optional): Include embedding data
- `include_knowledge_graph` (boolean, optional): Include KG data

### `backup_database`
Creates a complete database backup with optional compression.

**Parameters:**
- `backup_path` (string, required): Backup file location
- `compress` (boolean, optional): Compress backup file
- `include_vector_db` (boolean, optional): Include vector database

### `restore_database`
Restores database from a backup file.

**Parameters:**
- `backup_path` (string, required): Backup file to restore
- `agent_id` (string, optional): Restore specific agent data only
- `force` (boolean, optional): Overwrite existing data

---

## Web Search

### `tavily_web_search`
Integrates external knowledge through web search with result summarization.

**Parameters:**
- `query` (string, required): Search query
- `max_results` (number, optional): Maximum results to return (default: 5)
- `search_depth` (string, optional): 'basic' or 'advanced'
- `include_domains` (array, optional): Domains to prioritize
- `exclude_domains` (array, optional): Domains to exclude

**Features:**
- **Source Tracking**: Maintains attribution for all results
- **Result Summarization**: AI-powered summary of findings
- **Relevance Scoring**: Ranked results by relevance to query
- **Content Filtering**: Removes low-quality or irrelevant content

---

## Error Handling

All tools follow consistent error handling patterns:

### Common Error Codes
- `INVALID_PARAMS`: Missing or invalid parameters
- `NOT_FOUND`: Requested resource doesn't exist
- `PERMISSION_DENIED`: Access not allowed
- `INTERNAL_ERROR`: Server-side processing error
- `RATE_LIMITED`: Too many requests

### Error Response Format
```json
{
  "error": {
    "code": "INVALID_PARAMS",
    "message": "Human-readable error description",
    "details": {
      "parameter": "agent_id",
      "expected": "non-empty string"
    }
  }
}
```

## Performance Guidelines

### Rate Limiting
- **Embedding Operations**: Automatic batching with delays
- **AI Queries**: Intelligent model selection and caching
- **Database Operations**: Connection pooling and transaction optimization

### Best Practices
1. **Use appropriate batch sizes** for embedding operations
2. **Enable caching** for frequently accessed data
3. **Set reasonable limits** for list operations
4. **Use specific filters** to reduce result sets
5. **Monitor performance** through built-in metrics