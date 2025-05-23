# 🧠 Memory MCP Server: Your Agent's Persistent Brain 🧠

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
The **Memory MCP Server** is a robust Model Context Protocol (MCP) server designed to provide AI agents with a powerful and persistent memory system. Built with TypeScript and leveraging SQLite, it offers a comprehensive suite of tools for managing various forms of agent knowledge, from conversation histories and contextual data to complex task plans and a structured knowledge graph.

This server empowers your AI agents to learn, remember, and operate with greater intelligence and consistency across sessions.

## ✨ Key Features

* 💾 **Persistent SQLite Backend:** All agent memory is reliably stored, ensuring data integrity and availability.
* 📚 **Comprehensive Memory Types:**
    * **Conversation History:** Track multi-turn dialogues.
    * **Contextual Information:** Store dynamic data like agent state, user preferences, and task parameters with versioning.
    * **Reference Keys:** Link to external documents or internal memory entries.
    * **Source Attribution:** Log the origin of information for transparency and traceability.
    * **Correction Logs:** Record instances of corrections for learning and auditing.
    * **Success Metrics:** Track quantitative and qualitative performance indicators.
* 🕸️ **Knowledge Graph Management:** Create, update, and query a structured knowledge graph of entities and their relationships.
* 📝 **Advanced Plan & Task Management:**
    * Define complex plans with overall goals and statuses.
    * Break down plans into individual, manageable tasks with dependencies, descriptions, and assigned tools.
    * Track progress and update statuses for both plans and tasks.
* 🌐 **External Integrations:**
    * **Tavily AI:** Perform advanced web searches.
    * **Google Gemini:** Leverage powerful LLM capabilities for:
        * Context Summarization
        * Entity & Keyword Extraction
        * Semantic Search (Vector Embeddings)
* 🛠️ **Data Utilities:**
    * Backup and restore the entire memory database.
    * Export table data to CSV.
* 🛡️ **Data Validation:** Ensures integrity of incoming data using JSON schemas.
* ⚙️ **MCP Compliant:** Seamlessly integrates with MCP-compatible clients.
* 📄 **Structured Output:** Provides human-readable Markdown for plan and task details.

## 🚀 Installation & Setup

### Prerequisites

* [Node.js](https://nodejs.org/) (version 18.x or higher recommended)
* [npm](https://www.npmjs.com/) (usually comes with Node.js)

### Steps

1.  **Clone the Repository:**
    ```bash
    git clone <your-repository-url> memory-mcp-server
    cd memory-mcp-server
    ```
    (If you've already downloaded it, navigate to the `C:\Users\user\Dropbox\PC\Documents\Cline\MCP\memory-mcp-server` directory)

2.  **Install Dependencies:**
    ```bash
    npm install
    ```

3.  **Build the Server:**
    This command compiles the TypeScript code and copies necessary files (like `schema.sql`) to the `build` directory.
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
    * Linux: `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`

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
        }
      }
    }
    ```
    **Note:** Ensure the path in `args` is the correct absolute path to the `build/index.js` file on your system.

## 🧭 Core Concepts

The Memory MCP Server is designed around the concept of providing a persistent, structured memory for AI agents. Key ideas include:

* **Agent-Centric Storage:** Most memory entries are associated with an `agent_id`, allowing multiple agents to use the same server without interference.
* **Typed Memory:** Different types of information (conversations, context, plans) are stored in dedicated, appropriately indexed SQLite tables for efficient querying.
* **Contextual Awareness:** Memory entries can be linked to specific contexts or other entries, enabling rich relationships between pieces of information.
* **Actionable Memory:** The server doesn't just store data; it provides tools to actively use and manage this memory, including planning, task execution tracking, and knowledge retrieval.

## 🛠️ Available Tools

The server exposes a rich set of tools for memory management and external service interaction. Here's a high-level overview (refer to `docs/api_documentation.md` for detailed schemas and parameters):

### 💬 Conversation & Context
* `store_conversation_message`, `get_conversation_history`
* `store_context`, `get_context`, `get_all_contexts`
* `search_context_by_keywords`
* `prune_old_context`

### 🧠 Knowledge & Attribution
* `add_reference_key`, `get_reference_keys`
* `log_source_attribution`, `get_source_attributions`
* `log_search_attribution` (specifically for Tavily search results)

### 📊 Learning & Performance
* `log_correction`, `get_correction_logs`
* `log_success_metric`, `get_success_metrics`

### 🕸️ Knowledge Graph
* `knowledge_graph_memory` (with operations like `create_entities`, `create_relations`, `add_observations`, `read_graph`, `search_nodes`, `delete_entities`, etc.)

### 🗺️ Plan & Task Management
* `create_task_plan`
* `get_task_plan_details` (Outputs Markdown)
* `list_task_plans` (Outputs Markdown table)
* `get_plan_tasks` (Outputs Markdown table)
* `update_task_plan_status`
* `update_plan_task_status`
* `delete_task_plan`

### 🌐 External Integrations & LLM Tools
* `tavily_web_search`
* `summarize_context` (Uses Gemini)
* `extract_entities` (Uses Gemini)
* `semantic_search_context` (Uses Gemini for embeddings)

### 🗄️ Database Utilities
* `export_data_to_csv`
* `backup_database`
* `restore_database`

## 💡 Example Usage

Here are a few examples of how an AI agent might use the Memory MCP Server:

**1. Store Current Task Context:**
```xml
<use_mcp_tool>
  <server_name>memory-mcp-server</server_name>
  <tool_name>store_context</tool_name>
  <arguments>
    {
      "agent_id": "coder-agent-007",
      "context_type": "current_coding_task",
      "context_data": {
        "task_id": "feat-123",
        "description": "Implement user authentication module",
        "status": "in_progress",
        "files_involved": ["auth.service.ts", "user.model.ts"],
        "blockers": null
      }
    }
  </arguments>
</use_mcp_tool>
```

**2. Create a Development Plan:**
```xml
<use_mcp_tool>
  <server_name>memory-mcp-server</server_name>
  <tool_name>create_task_plan</tool_name>
  <arguments>
    {
      "agent_id": "project-manager-agent",
      "planData": {
        "title": "Alpha Release Feature Set",
        "overall_goal": "Complete all features required for the alpha release of Project Phoenix.",
        "status": "DRAFT",
        "metadata": { "project_code": "PHX-ALPHA" }
      },
      "tasksData": [
        {
          "task_number": 1,
          "title": "Setup Database Schema",
          "description": "Define and implement the initial database schema for core entities.",
          "status": "PLANNED",
          "estimated_effort_hours": 8
        },
        {
          "task_number": 2,
          "title": "Develop User Authentication API",
          "description": "Create endpoints for user registration, login, and session management.",
          "status": "PLANNED",
          "dependencies_task_ids": ["<ID_OF_TASK_1_ONCE_CREATED>"],
          "tools_required_list": ["code_editor", "api_tester"]
        }
      ]
    }
  </arguments>
</use_mcp_tool>
```
*(The MCP client would receive `{ "plan_id": "...", "task_ids": ["...", "..."] }`)*

**3. Perform a Web Search with Tavily and Log Attribution:**
```xml
<use_mcp_tool>
  <server_name>memory-mcp-server</server_name>
  <tool_name>tavily_web_search</tool_name>
  <arguments>
    {
      "query": "latest advancements in quantum computing for AI",
      "search_depth": "advanced",
      "max_results": 3
    }
  </arguments>
</use_mcp_tool>
<use_mcp_tool>
  <server_name>memory-mcp-server</server_name>
  <tool_name>log_search_attribution</tool_name>
  <arguments>
    {
      "agent_id": "research-assistant-01",
      "query": "latest advancements in quantum computing for AI",
      "search_results_summary": "Found three relevant papers on recent breakthroughs in quantum machine learning algorithms.",
      "retrieval_timestamp": 1748004848354,
      "full_content_json": "[... full JSON of Tavily results ...]"
    }
  </arguments>
</use_mcp_tool>
```

**4. Read the Knowledge Graph:**
```xml
<use_mcp_tool>
  <server_name>memory-mcp-server</server_name>
  <tool_name>knowledge_graph_memory</tool_name>
  <arguments>
    {
      "agent_id": "knowledge-explorer-agent",
      "operation": "read_graph"
    }
  </arguments>
</use_mcp_tool>
```

**5. Get Plan Details (receives Markdown):**
```xml
<use_mcp_tool>
  <server_name>memory-mcp-server</server_name>
  <tool_name>get_task_plan_details</tool_name>
  <arguments>
    {
      "agent_id": "project-manager-agent",
      "plan_id": "c6c5a4e9-6258-48a6-a751-a521caf806ce"
    }
  </arguments>
</use_mcp_tool>
```

## 📂 Project Structure

```
memory-mcp-server/
├── build/                    # Compiled JavaScript output from src/
│   ├── database/
│   │   └── schema.sql        # Copied database schema
│   └── index.js              # Main server entry point (compiled)
│   └── ...                   # Other compiled files
├── docs/                     # Detailed documentation for various aspects
│   ├── api_documentation.md
│   ├── correction_logs.md
│   ├── implementation_notes.md
│   ├── README.md             # (This file, or a more detailed version)
│   ├── source_attribution.md
│   └── success_metrics.md
├── src/                      # TypeScript source code
│   ├── database/
│   │   ├── db.ts             # Database initialization & connection
│   │   ├── memory_manager.ts # Core CRUD & logic for memory types
│   │   └── schema.sql        # SQLite database schema definition
│   ├── integrations/
│   │   └── tavily.ts         # Tavily search integration
│   ├── utils/
│   │   └── validation.ts     # JSON schema validation utility
│   └── index.ts              # Main MCP server implementation, tool exposure
├── .env                      # (Create this for API keys)
├── memory.db                 # SQLite database file (generated at runtime)
├── package.json
├── tsconfig.json
├── jest.config.js
└── ...                       # Other configuration files
```

## 💻 Development

* **Run Locally (for development, after `npm install` and `npm run build`):**
    ```bash
    npm run start
    ```
    Or, for auto-rebuild on changes:
    ```bash
    npm run watch
    ```
    (This will typically start `tsc --watch`. You'll need to run `npm run start` in another terminal to execute the compiled code.)

* **Testing:**
    The project uses Jest for testing.
    ```bash
    npm run test
    ```
    Tests for plan and task management are in `src/tests/plan_task_manager.test.ts`.

* **Building:**
    To compile TypeScript to JavaScript:
    ```bash
    npm run build
    ```

### Debugging MCP Communication
Since MCP servers communicate over stdio, direct debugging can be tricky. Consider using the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):
```bash
npm run inspector
```
This will provide a URL to access debugging tools in your browser.

## 🔭 Future Considerations

* **Advanced Authentication/Authorization:** Implement robust security for production environments.
* **Data Retention Policies:** Introduce automated cleanup or archival mechanisms.
* **Scalability Enhancements:** For very high-load scenarios, explore alternative database backends.
* **MCP Resource Exposure:** Consider exposing read-only memory views as MCP resources.
* **Database Migration System:** Implement a more formal system for schema migrations.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit pull requests or open issues for bugs, feature requests, or improvements.
(Add more specific contribution guidelines if desired).

## 📜 License

This project is licensed under the MIT License. See the [LICENSE](LICENSE.md) file for details (assuming you add one).
    