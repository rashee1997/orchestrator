# Memory MCP Server

This is a Model Context Protocol (MCP) server designed for persistent memory management in AI agents using SQLite. It provides a robust set of tools for storing and retrieving various types of agent memory, including conversation history, context information, reference keys, source attribution, correction logs, and success metrics. It also integrates with Tavily for external knowledge retrieval.

## Features

*   **Persistent Memory:** All data is stored in a SQLite database, ensuring persistence across sessions.
*   **Comprehensive Memory Types:** Manages conversation history, contextual information, external references, source attributions, correction logs, performance metrics, and refined prompts.
*   **Plan and Task Management:** Dedicated tables and tools for creating, retrieving, updating, and deleting structured task plans and their individual steps, ensuring clear organization and optimized access.
*   **Knowledge Graph Management:** Create, update, and query a structured knowledge graph of entities and their relationships.
*   **Efficient Retrieval:** Optimized for fast and targeted retrieval with appropriate indexing.
*   **Context-Aware Storage:** Links memory entries to their relevant operational context.
*   **Version Tracking:** Tracks versions of critical context information for historical analysis.
*   **Data Validation:** Ensures data integrity and consistency using JSON schema validation.
*   **External Integrations:**
    *   **Tavily AI:** Perform advanced web searches.
    *   **Google Gemini:** Leverage powerful LLM capabilities for prompt refinement, context summarization, entity & keyword extraction, and semantic search.
*   **Database Utilities:** Includes tools for exporting data to CSV, backing up, and restoring the database.
*   **Robust Error Handling:** Implements centralized logging and appropriate MCP error responses.

## Installation

1.  **Clone the repository (or navigate to the created directory):**
    ```bash
    cd C:\Users\user\Dropbox\PC\Documents\Cline\MCP\memory-mcp-server
    ```

2.  **Install Dependencies:**
    ```bash
    npm install
    ```

3.  **Build the Server:**
    ```bash
    npm run build
    ```

4.  **Configure Environment Variables:**
    The server requires API keys for some of its integrated services. Create a `.env` file in the root of the `memory-mcp-server` directory (e.g., `C:\Users\user\Dropbox\PC\Documents\Cline\MCP\memory-mcp-server\.env`) with the following content:

    ```env
    TAVILY_API_KEY="your_tavily_api_key"
    GEMINI_API_KEY="your_google_gemini_api_key"
    # TAVILY_MOCK_MODE=true # Uncomment to use mock Tavily results without an API key
    ```
    Replace `"your_tavily_api_key"` and `"your_google_gemini_api_key"` with your actual API keys.
    * Get a Tavily API key from [Tavily AI](https://tavily.com/).
    * Get a Google Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey).

5.  **MCP Client Configuration (Example for VS Code Claude Dev Extension):**
    Add or update the server configuration in your MCP client's settings file. For the VS Code Claude Dev Extension, this is typically located at:
    * Windows: `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`
    * macOS: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
    * Linux: `~/.config/Code/User/globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`

    Add the following entry:
    ```json
    {
      "memory-mcp-server": {
        "disabled": false,
        "autoApprove": [], 
        "timeout": 120,    
        "transportType": "stdio",
        "command": "node",
        "args": [
          "C:/Users/user/Dropbox/PC/Documents/Cline/MCP/memory-mcp-server/build/index.js"
        ],
        "env": {
          "TAVILY_API_KEY": "your_tavily_api_key",
          "GEMINI_API_KEY": "your_google_gemini_api_key"
        }
      }
    }
    ```
    **Note:** Ensure the path in `args` is the correct absolute path to the `build/index.js` file on your system. Also, ensure that `TAVILY_API_KEY` and `GEMINI_API_KEY` are correctly set in the `env` section if you are not using a global `.env` file for the MCP server.

## Usage

Once installed, the `memory-mcp-server` will expose various tools for memory management. You can interact with these tools using the `use_mcp_tool` command.

### Example Tool Calls:

**1. Refine a User Prompt:**
```xml
<use_mcp_tool>
  <server_name>memory-mcp-server</server_name>
  <arguments>
    {
      "agent_id": "my-ai-agent-001",
      "raw_user_prompt": "I need to implement a new user registration flow with email verification.",
      "target_ai_persona": "Senior Backend Developer"
    }
  </arguments>
</use_mcp_tool>
```

**2. Get a Refined Prompt by ID:**
```xml
<use_mcp_tool>
  <server_name>memory-mcp-server</server_name>
  <tool_name>get_refined_prompt</tool_name>
  <arguments>
    {
      "refined_prompt_id": "server_generated_uuid_for_this_refinement_instance"
    }
  </arguments>
</use_mcp_tool>
```

**3. Store a Conversation Message:**
```xml
<use_mcp_tool>
<server_name>memory-mcp-server</server_name>
<tool_name>store_conversation_message</tool_name>
<arguments>
{
  "agent_id": "my-ai-agent-001",
  "sender": "user",
  "message_content": "Hello, how are you today?",
  "user_id": "user-123"
}
</arguments>
</use_mcp_tool>
```

**4. Get Conversation History:**
```xml
<use_mcp_tool>
<server_name>memory-mcp-server</server_name>
<tool_name>get_conversation_history</tool_name>
<arguments>
{
  "agent_id": "my-ai-agent-001"
}
</arguments>
</use_mcp_tool>
```

**5. Store Context Information:**
```xml
<use_mcp_tool>
<server_name>memory-mcp-server</server_name>
<tool_name>store_context</tool_name>
<arguments>
{
  "agent_id": "my-ai-agent-001",
  "context_type": "current_task",
  "context_data": {
    "task_id": "task-abc",
    "status": "in_progress",
    "priority": "high"
  }
}
</arguments>
</use_mcp_tool>
```

**6. Create a Task Plan:**
```xml
<use_mcp_tool>
<server_name>memory-mcp-server</server_name>
<tool_name>create_task_plan</tool_name>
<arguments>
{
  "agent_id": "my-ai-agent-001",
  "planData": {
    "title": "Implement New Feature X",
    "overall_goal": "Develop and deploy feature X to production.",
    "status": "DRAFT"
  },
  "tasksData": [
    {
      "task_number": 1,
      "title": "Design Database Schema",
      "description": "Create ERD and SQL migration scripts.",
      "status": "PLANNED"
    },
    {
      "task_number": 2,
      "title": "Implement Backend API",
      "description": "Develop REST endpoints for feature X.",
      "status": "PLANNED",
      "dependencies_task_ids": ["task-1-uuid"]
    }
  ]
}
</arguments>
</use_mcp_tool>
```

**7. Perform Tavily Web Search:**
```xml
<use_mcp_tool>
<server_name>memory-mcp-server</server_name>
<tool_name>tavily_web_search</tool_name>
<arguments>
{
  "query": "latest advancements in large language models",
  "search_depth": "advanced"
}
</arguments>
</use_mcp_tool>
```

**8. Summarize Context:**
```xml
<use_mcp_tool>
  <server_name>memory-mcp-server</server_name>
  <tool_name>summarize_context</tool_name>
  <arguments>
    {
      "agent_id": "my-ai-agent-001",
      "context_type": "project_documentation_v1",
      "version": 1
    }
  </arguments>
</use_mcp_tool>
```

**9. Extract Entities from Context:**
```xml
<use_mcp_tool>
  <server_name>memory-mcp-server</server_name>
  <tool_name>extract_entities</tool_name>
  <arguments>
    {
      "agent_id": "my-ai-agent-001",
      "context_type": "meeting_notes_v1"
    }
  </arguments>
</use_mcp_tool>
```

**10. Perform Semantic Search on Context:**
```xml
<use_mcp_tool>
  <server_name>memory-mcp-server</server_name>
  <tool_name>semantic_search_context</tool_name>
  <arguments>
    {
      "agent_id": "my-ai-agent-001",
      "context_type": "technical_specifications_v1",
      "query_text": "how to integrate with external APIs",
      "top_k": 3
    }
  </arguments>
</use_mcp_tool>
```

**11. Export Data to CSV:**
```xml
<use_mcp_tool>
  <server_name>memory-mcp-server</server_name>
  <tool_name>export_data_to_csv</tool_name>
  <arguments>
    {
      "tableName": "conversation_history",
      "filePath": "C:/Users/user/Desktop/conversation_history.csv"
    }
  </arguments>
</use_mcp_tool>
```

**12. Backup Database:**
```xml
<use_mcp_tool>
  <server_name>memory-mcp-server</server_name>
  <tool_name>backup_database</tool_name>
  <arguments>
    {
      "backupFilePath": "C:/Users/user/Desktop/memory_backup_20250523.db"
    }
  </arguments>
</use_mcp_tool>
```

**13. Restore Database:**
```xml
<use_mcp_tool>
  <server_name>memory-mcp-server</server_name>
  <tool_name>restore_database</tool_name>
  <arguments>
    {
      "backupFilePath": "C:/Users/user/Desktop/memory_backup_20250523.db"
    }
  </arguments>
</use_mcp_tool>
```

**14. Search Context by Keywords:**
```xml
<use_mcp_tool>
  <server_name>memory-mcp-server</server_name>
  <tool_name>search_context_by_keywords</tool_name>
  <arguments>
    {
      "agent_id": "my-ai-agent-001",
      "context_type": "project_documentation_v1",
      "keywords": "installation steps"
    }
  </arguments>
</use_mcp_tool>
```

**15. Prune Old Context:**
```xml
<use_mcp_tool>
  <server_name>memory-mcp-server</server_name>
  <tool_name>prune_old_context</tool_name>
  <arguments>
    {
      "agent_id": "my-ai-agent-001",
      "max_age_ms": 2592000000,
      "context_type": "temporary_logs"
    }
  </arguments>
</use_mcp_tool>
```

Refer to the API documentation for a full list of available tools and their parameters.

## Development

### Project Structure

```
memory-mcp-server/
├── src/
│   ├── database/
│   │   ├── db.ts             # Database initialization and connection
│   │   ├── memory_manager.ts # Core CRUD operations for all memory types
│   │   └── schema.sql        # SQLite database schema definition
│   ├── integrations/
│   │   └── tavily.ts         # Tavily search integration and attribution logging
│   ├── utils/
│   │   └── validation.ts     # JSON schema validation utility
│   └── index.ts              # Main MCP server implementation, tool exposure
├── build/                    # Compiled JavaScript output
├── docs/                     # Documentation files
├── memory.db                 # SQLite database file (generated at runtime, contains conversation_history, context_information, reference_keys, source_attribution, correction_logs, success_metrics, plans, plan_tasks, knowledge_graph_nodes, knowledge_graph_relations, and refined_prompts tables)
├── knowledge_graph.jsonl     # Stores knowledge graph data in JSONL format
├── package.json
├── tsconfig.json
└── ...
```

### Running Locally (for development)

1.  Navigate to the server directory: `cd C:\Users\user\Dropbox\PC\Documents\Cline\MCP\memory-mcp-server`
2.  Start the server: `npm run start` (You might need to add a `start` script to `package.json` if not already present, e.g., `"start": "node build/index.js"`).

## License

This project is licensed under the MIT License. See the [LICENSE](../../LICENSE.md) file for details.
