# 🧠 Orchestrator: Your Agent's Persistent Brain 🧠

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
The **Orchestrator** is a robust Model Context Protocol (MCP) server designed to provide AI agents with a powerful and persistent memory system. Built with TypeScript and leveraging SQLite, it offers a comprehensive suite of tools for managing various forms of agent knowledge, from conversation histories and contextual data to complex task plans and a structured knowledge graph.

This server empowers your AI agents to learn, remember, and operate with greater intelligence and consistency across sessions.

## Contents
*   [✨ Key Features](#-key-features)
*   [🚀 Installation & Setup](#-installation--setup)
*   [🧭 Core Concepts](#-core-concepts)
*   [🛠️ Available Tools](#%EF%B8%8F-available-tools)
*   [📂 Project Structure](#-project-structure)
*   [📄 Rules and Protocols](#-rules-and-protocols)
*   [💻 Development](#-development)
*   [📜 License](#-license)

## ✨ Key Features

* 💾 **Persistent SQLite Backend:** All agent memory is reliably stored, ensuring data integrity and availability.
* 📚 **Comprehensive Memory Types:**
    * **Conversation History:** Track multi-turn dialogues.
    * **Contextual Information:** Store dynamic data like agent state, user preferences, and task parameters with versioning.
    * **Reference Keys:** Link to external documents or internal memory entries.
    * **Source Attribution:** Log the origin of information for transparency and traceability.
    * **Correction Logs:** Record instances of corrections for learning and auditing.
    * **Success Metrics:** Track quantitative and qualitative performance indicators.
    * **Refined Prompts:** Store structured versions of user prompts for consistent AI processing.
* 🕸️ **Knowledge Graph Management:** Create, update, and query a structured knowledge graph of entities and their relationships.
* 📝 **Advanced Plan & Task Management:**
    * Define complex plans with overall goals and statuses.
    * Break down plans into individual, manageable tasks with dependencies, descriptions, and assigned tools.
    * Track progress and update statuses for both plans and tasks.
* 🌐 **External Integrations:**
    * **Tavily AI:** Perform advanced web searches.
    * **Google Gemini:** Leverage powerful LLM capabilities for:
        * Prompt Refinement
        * Context Summarization
        * Entity & Keyword Extraction
        * Semantic Search (Vector Embeddings)
        * Code Analysis (`analyze_code_file_with_gemini`)
* 🛠️ **Data Utilities:**
    * Backup and restore the entire memory database.
    * Export table data to CSV.
    * Prune old context entries based on age.
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
    git clone https://github.com/rashee1997/orchestrator orchestrator
    cd orchestrator
    ```
    (If you've already downloaded it, navigate to the `orchestrator` directory)

2.  **Install Dependencies:**
    ```bash
    npm install
    ```

3.  **Build the Server:**
    This command compiles the TypeScript code and copies necessary files (like `schema.sql`) to the `build` directory.
    ```bash
    npm run build
    ```

4.  **Configure API Keys:**
    The server requires API keys for some of its integrated services. These should be configured directly within your MCP client's settings, as shown in the next step.

5.  **MCP Client Configuration (Example for VS Code cline Dev Extension):**
    Add or update the server configuration in your MCP client's settings file. For the VS code cline extension Claude Dev Extension, this is typically located at:
    *   **Windows:** `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`
    *   **macOS:** `~/Library/Application Support/Code/User/globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`
    *   **Linux:** `~/.config/Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`

    Add the following entry:
    ```json
    {
      "orchestrator": {
        "disabled": false,
        "autoApprove": [], 
        "timeout": 120,    
        "transportType": "stdio",
        "command": "node",
        "args": [
          "path/to/your/orchestrator/build/index.js"
        ],
        "env": {
          "TAVILY_API_KEY": "your_tavily_api_key",
          "GEMINI_API_KEY": "your_google_gemini_api_key"
        }
      }
    }
    ```
    **Note:** Ensure the path in `args` is the correct absolute path to the `build/index.js` file on your system. Replace `path/to/your/orchestrator/` with the actual absolute path where you cloned the repository. Ensure that `TAVILY_API_KEY` and `GEMINI_API_KEY` are correctly set in the `env` section within this configuration.

## 🧭 Core Concepts

The Orchestrator is designed around the concept of the concept of providing a persistent, structured memory for AI agents. Key ideas include:

* **Agent-Centric Storage:** Most memory entries are associated with an `agent_id`, allowing multiple agents to use the same server without interference.
* **Typed Memory:** Different types of information (conversations, context, plans) are stored in dedicated, appropriately indexed SQLite tables for efficient querying.
* **Contextual Awareness:** Memory entries can be linked to specific contexts or other entries, enabling rich relationships between pieces of information.
* **Actionable Memory:** The server doesn't just store data; it provides tools to actively use and manage this memory, including planning, task execution tracking, and knowledge retrieval.

## 🛠️ Available Tools

The Orchestrator provides a comprehensive set of tools for AI agents to manage memory, interact with external services, and facilitate complex workflows. For detailed schemas and parameters of each tool, please refer to `docs/api_documentation.md`.

### Core Memory Management
*   **Conversation & Context:** Tools for storing and retrieving conversation history, dynamic contextual data (with versioning), and performing keyword/semantic searches on context. Includes tools for pruning old context and summarizing/extracting entities from context using Gemini.
*   **Knowledge & Attribution:** Tools for managing reference keys to external sources, logging the origin of information, and attributing web search results.
*   **Learning & Performance:** Tools for logging and retrieving correction instances, summarizing past corrections, and tracking quantitative/qualitative success metrics.
*   **Knowledge Graph:** A powerful tool (`knowledge_graph_memory`) for creating, updating, querying, and deleting entities, relationships, and observations within a structured knowledge graph.

### Workflow & Task Management
*   **Plan & Task Management:** Comprehensive tools for creating, retrieving, listing, updating, and deleting multi-step task plans, individual tasks, and subtasks.
*   **Review & Logging:** Detailed logging for task reviews, tool executions, task progress, and errors. Includes tools for creating, retrieving, updating, and deleting review logs, as well as managing tool execution, task progress, and error logs.

### External Integrations & LLM Capabilities
*   **Web Search:** Integrates with Tavily for advanced web searches.
*   **Gemini AI:** Leverages Google Gemini for direct queries (`ask_gemini`), refining user prompts, and advanced context analysis (summarization, entity extraction, semantic search).
*   **Code Analysis:** Provides the `analyze_code_file_with_gemini` tool for detailed line-by-line code analysis using Gemini, focusing on specified aspects.

### System & Utility
*   **Mode Management:** Tools for defining, retrieving, updating, and deleting mode-specific instructions for AI agents.
*   **Database Utilities:** Tools for exporting database tables to CSV, backing up the entire SQLite database, and restoring from a backup.
*   **Git Operations:** A comprehensive suite of tools for interacting with Git repositories, including cloning, pulling, pushing, committing, checking status, adding files, managing branches, viewing logs, diffing changes, stashing changes (`git_stash_save`, `git_stash_pop`), remote management (`git_remote_add`, `git_remote_remove`), and soft resetting (`git_reset_soft`).

## 📂 Project Structure

```
memory-mcp-server/
├── build/                    # Compiled JavaScript output
├── docs/                     # Project documentation
├── src/                      # TypeScript source code
│   ├── database/             # Database management and schema
│   ├── integrations/         # External service integrations (e.g., Tavily)
│   ├── tests/                # Unit and integration tests
│   ├── tools/                # MCP tool implementations
│   ├── types/                # TypeScript type definitions
│   └── utils/                # Utility functions
├── .gitignore                # Git ignore file
├── jest.config.js            # Jest test configuration
├── LICENSE.md                # Project license
├── package.json              # Node.js project metadata
├── README.md                 # This README file
├── tsconfig.json             # TypeScript configuration
└── ...                       # Other configuration and generated files
```

## 📄 Rules and Protocols

The Orchestrator adheres to **strict operational rules and protocols** defined in **`workflow.md`**. This file **critically outlines** the agent's roles, goals, and mandatory modes of operation, ensuring accurate, safe, and high-quality task execution.

***IMPORTANT: These rules are static and directly influence the AI agent's behavior for every task. While designed to be followed, please be aware that AI agents may not always adhere to them fully. These rules can be added to AI agents' rule files.***

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

## 📜 License

This project is licensed under the MIT License. See the [LICENSE](LICENSE.md) file for details.
