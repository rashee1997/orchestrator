# Memory MCP Server

This is a Model Context Protocol (MCP) server designed for persistent memory management in AI agents using SQLite. It provides a robust set of tools for storing and retrieving various types of agent memory, including conversation history, context information, reference keys, source attribution, correction logs, and success metrics. It also integrates with Tavily for external knowledge retrieval.

## Features

*   **Persistent Memory:** All data is stored in a SQLite database, ensuring persistence across sessions.
*   **Comprehensive Memory Types:** Manages conversation history, contextual information, external references, source attributions, correction logs, and performance metrics.
*   **Plan and Task Management:** Dedicated tables and tools for creating, retrieving, updating, and deleting structured task plans and their individual steps, ensuring clear organization and optimized access.
*   **Efficient Retrieval:** Optimized for fast and targeted retrieval with appropriate indexing.
*   **Context-Aware Storage:** Links memory entries to their relevant operational context.
*   **Version Tracking:** Tracks versions of critical context information for historical analysis.
*   **Data Validation:** Ensures data integrity and consistency using JSON schema validation.
*   **Tavily Search Integration:** Allows agents to perform web searches via Tavily and logs the source attribution.
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

4.  **Configure Tavily API Key:**
    Obtain a Tavily API key from [Tavily AI](https://tavily.com/).

5.  **Install MCP Server:**
    Add the following configuration to your MCP settings file (e.g., `c:\Users\user\AppData\Roaming\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`):

    ```json
    "memory-mcp-server": {
      "disabled": false,
      "autoApprove": [],
      "timeout": 60,
      "transportType": "stdio",
      "command": "node",
      "args": [
        "C:/Users/user/Dropbox/PC/Documents/Cline/MCP/memory-mcp-server/build/index.js"
      ],
      "env": {
        "TAVILY_API_KEY": "YOUR_TAVILY_API_KEY"
      }
    }
    ```
    Replace `"YOUR_TAVILY_API_KEY"` with your actual Tavily API key.

## Usage

Once installed, the `memory-mcp-server` will expose various tools for memory management. You can interact with these tools using the `use_mcp_tool` command.

### Example Tool Calls:

**1. Store a Conversation Message:**
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

**2. Get Conversation History:**
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

**3. Store Context Information:**
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

**4. Create a Task Plan:**
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

**5. Perform Tavily Web Search:**
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
├── memory.db                 # SQLite database file (generated at runtime)
├── package.json
├── tsconfig.json
└── ...
```

### Running Locally (for development)

1.  Navigate to the server directory: `cd C:\Users\user\Dropbox\PC\Documents\Cline\MCP\memory-mcp-server`
2.  Start the server: `npm run start` (You might need to add a `start` script to `package.json` if not already present, e.g., `"start": "node build/index.js"`).

## License

[Specify license, e.g., MIT License]
