<div align="center">

# Memory MCP Server — Orchestrator

<img src="assets/orchestrator-logo.png" alt="Memory MCP Server Orchestrator" width="200" />

### 🚀 Your AI Agent's Persistent Brain
**Advanced memory, intelligent orchestration, and semantic codebase understanding for next-generation AI agents**

<div>

[![Memory MCP Server](https://img.shields.io/badge/Memory%20MCP%20Server-Orchestrator-6b46c1?style=for-the-badge&logo=brain&logoColor=white)](https://github.com/rashee1997/orchestrator)
[![License: MIT](https://img.shields.io/badge/License-MIT-f59e0b?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-10b981?style=for-the-badge&logo=node.js)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3%2B-3b82f6?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)

</div>

<div>

![AI Tools](https://img.shields.io/badge/AI%20Tools-54-ec4899?style=flat-square)
![Embedding Models](https://img.shields.io/badge/Models-Gemini%20%7C%20Codestral-8b5cf6?style=flat-square)
![Vector Dimensions](https://img.shields.io/badge/Vectors-3072D-06b6d4?style=flat-square)
![Languages](https://img.shields.io/badge/Languages-TS%20%7C%20JS%20%7C%20Python%20%7C%20PHP-f97316?style=flat-square)

</div>

</div>

---

## 📋 Table of Contents

- [🌟 Overview](#-overview)
- [✨ Features](#-features)
- [🚀 Installation](#-installation)
- [⚙️ Configuration](#️-configuration)
- [🛠️ Available Tools](#-available-tools)
- [⚡ Example Workflow](#-example-workflow)
- [🏗️ Architecture](#️-architecture)
- [💻 Development](#-development)
- [🤝 Contributing](#-contributing)
- [📄 License](#-license)

---

## 🌟 Overview

Memory MCP Server (Orchestrator) is a state-of-the-art backend that transforms AI agents into persistent, context-aware, and deeply code-literate collaborators. With rich, multi-turn memory, AI-powered planning, and semantic understanding of your codebase, it unlocks intelligent workflows for everything from code review to project management.

---

## ✨ Features

<div align="center">

### 🎯 **Core Capabilities**

</div>

<table>
<tr>
<td width="50%">

### 🧠 **Advanced Memory & Intelligence**
- 💬 **Persistent Conversations** - Multi-user sessions with threading
- 📋 **Intelligent Task Planning** - AI-powered project decomposition
- 🔍 **Multi-Language Analysis** - TS, JS, Python, PHP entity extraction
- 🎯 **Semantic Understanding** - 3072D vector embeddings

</td>
<td width="50%">

### 🔍 **Sophisticated Search & Retrieval**
- 🔗 **Hybrid RAG System** - Vector + keyword + graph search
- 🔄 **Iterative Search** - Multi-round quality reflection
- 🎭 **DMQR Technology** - Diverse Multi-Query Rewriting
- 🕸️ **Knowledge Graph** - Entity-relationship mapping

</td>
</tr>
<tr>
<td>

### 🤖 **Enterprise-Grade AI Integration**
- 🎼 **Multi-Model Orchestration** - Gemini, Codestral, Mistral
- 🧭 **Intelligent Routing** - Code → Codestral, Text → Gemini
- 📦 **Batch Processing** - Dynamic sizing with rate limiting
- ⚙️ **50+ AI Parameters** - Specialized execution modes

</td>
<td>

### 🛠️ **Production-Ready Operations**
- 🔄 **Incremental Updates** - File hash-based change detection
- 🗄️ **Database Management** - Backup/restore, CSV export
- 🛡️ **Error Resilience** - Comprehensive error handling
- 🌐 **Web Integration** - Tavily search with source tracking

</td>
</tr>
</table>

<div align="center">

### 📊 **At a Glance**

| Feature | Details |
|---------|---------|
| 🔧 **Total Tools** | 54 sophisticated MCP tools across 8 categories |
| 🧠 **AI Models** | Gemini (3072D) + Codestral (3072D scaled) |
| 🗃️ **Storage** | Dual SQLite: Memory + Vector databases |
| 🌍 **Languages** | TypeScript, JavaScript, Python, PHP |
| 🔍 **Search Types** | Vector similarity, keyword, knowledge graph |
| 📈 **Scaling** | Dynamic batch processing with intelligent routing |

</div>

---

## 🚀 Installation

<div align="center">

### ⚡ Quick Start

</div>

<table>
<tr>
<td width="33%">

#### 📋 **Prerequisites**
| Requirement | Version |
|-------------|---------|
| **Node.js** | 18.x+ |
| **npm** | Latest |
| **Git** | Any |

</td>
<td width="33%">

#### 🔑 **Required APIs**
| Service | Purpose |
|---------|---------|
| **Gemini** | AI orchestration & natural language |
| **Mistral** | Simple analysis & fallback support |
| **Codestral** | Code embeddings & technical analysis |
| **Tavily** | Web search & external knowledge |

</td>
<td width="33%">

#### 📊 **System Resources**
| Component | Requirement |
|-----------|-------------|
| **RAM** | 2GB+ recommended |
| **Storage** | 1GB+ for databases |
| **CPU** | Multi-core preferred |

</td>
</tr>
</table>

### 📦 **Installation Steps**

<div align="center">

```bash
# 1️⃣ Clone the repository
git clone https://github.com/rashee1997/orchestrator.git
cd orchestrator

# 2️⃣ Install dependencies
npm install

# 3️⃣ Build the project
npm run build

# 4️⃣ Verify installation
npm test
```

</div>

<div align="center">

🎉 **Ready to orchestrate!** Your Memory MCP Server is now built and ready for configuration.

</div>

---

## ⚙️ Configuration

### API Keys Setup

The server requires API keys for external services. These are best configured in your MCP client's settings file to avoid exposing them in your shell environment. For Google Gemini, you can provide multiple API keys (e.g., from different projects or for failover/load balancing) by appending an underscore and a number (e.g., `GEMINI_API_KEY_2`, `GOOGLE_API_KEY_3`). The server will automatically use these in a round-robin fashion.

| Service         | Environment Variable       | Required | Get API Key                                        |
| --------------- | -------------------------- | -------- | -------------------------------------------------- |
| Google Gemini   | `GEMINI_API_KEY`           | ✅       | [Get Key](https://makersuite.google.com/app/apikey) |
|                 | `GEMINI_API_KEY_2`, etc.   | 🔀 (Optional) |                                                    |
|                 | `GOOGLE_API_KEY`           | ➡️ (Alias) |                                                    |
|                 | `GOOGLE_API_KEY_2`, etc.   | 🔀 (Optional) |                                                    |
| Mistral AI      | `MISTRAL_API_KEY`          | ✅       | [Get Key](https://console.mistral.ai/)              |
|                 | `MISTRAL_API_KEY_2`, etc.  | 🔀 (Optional) |                                                    |
| Tavily Search   | `TAVILY_API_KEY`           | ✅       | [Get Key](https://tavily.com/)                      |

### Gemini CLI (Recommended for OAuth)

Gemini 2.5 models unlock a much higher free-tier rate limit when you authenticate with the official Gemini CLI. The orchestrator automatically searches the standard credential locations the CLI writes to on every platform.

**Install the CLI (Node.js 20+):**

- Run instantly (no install):
  ```bash
  npx https://github.com/google-gemini/gemini-cli
  ```
- Install globally with npm:
  ```bash
  npm install -g @google/gemini-cli
  ```
- Install with Homebrew (macOS/Linux):
  ```bash
  brew install gemini-cli
  ```

**Authenticate:**

```bash
gemini
```

Choose **Login with Google** in the CLI prompt to start the browser OAuth flow. The CLI writes `oauth_creds.json` under your user profile (for example `~/.gemini/`, `~/.config/gemini/`, or `%APPDATA%\gemini\`). If you're using a paid Gemini Code Assist license, export your project before starting:

```bash
export GOOGLE_CLOUD_PROJECT="YOUR_PROJECT_NAME"
gemini
```

**Alternative authentication options:**

- API key:
  ```bash
  export GEMINI_API_KEY="YOUR_API_KEY"
  gemini
  ```
- Vertex AI:
  ```bash
  export GOOGLE_API_KEY="YOUR_API_KEY"
  export GOOGLE_GENAI_USE_VERTEXAI=true
  gemini
  ```

After signing in, restart the MCP server (or your MCP client). OAuth sessions are now preferred for `gemini-2.5-*` models (≈60 RPM + 1,000 requests/day), while embedding models continue to use the API keys configured above.

> Tip: run `node build/index.js --check-oauth` (or restart your MCP client) to confirm the server picked up the new credentials. If the CLI is missing, startup logs list the paths that were checked and platform-specific install guidance.

### Claude Code CLI Setup

Claude Code models run through Anthropic's local CLI. The orchestrator bundles a cross-platform detector that checks your PATH plus the usual install directories and prints tailored instructions if it cannot find the binary.

1. Install the CLI using your preferred package manager:
   - macOS: `brew install claude-code`
   - Windows: `npm install -g @anthropic/claude-code` or `choco install claude-code`
   - Linux: `npm install -g @anthropic/claude-code`, `snap install claude-code`, or follow the [official setup guide](https://docs.anthropic.com/en/docs/claude-code/setup)
2. Authenticate:
   - Subscription users: run `claude auth` (included with Claude Pro/Team)
   - API key users: export `ANTHROPIC_API_KEY="sk-ant-..."`
3. Optional flags:
   - `CLAUDE_CODE_MAX_OUTPUT_TOKENS` limits response length from the CLI
   - `CLAUDE_CODE_USE_VERTEX=1` converts model IDs for Vertex AI deployments
4. Verify everything works:
   ```bash
   claude --version
   ```

When the provider starts it logs the detected binary, version, and install method. If it is missing, the status endpoint and startup logs echo platform-specific install commands plus the paths that were checked.

### MCP Client Configuration (VS Code Client Example)

1.  **Locate the settings file**:
    -   **Windows**: `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`
    -   **macOS**: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
    -   **Linux**: `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`

2.  **Add the server configuration**:

```json
{
  "memory-mcp-server": {
    "disabled": false,
    "autoApprove": [],
    "timeout": 120,
    "transportType": "stdio",
    "command": "node",
    "args": [
      "/absolute/path/to/memory-mcp-server/build/index.js"
    ],
    "env": {
      "GEMINI_API_KEY": "your-primary-gemini-api-key",
      "GEMINI_API_KEY_2": "your-secondary-gemini-api-key",
      "GOOGLE_API_KEY": "another-gemini-key-alias",
      "MISTRAL_API_KEY": "your-mistral-api-key-here",
      "MISTRAL_API_KEY_2": "your-secondary-mistral-key",
      "TAVILY_API_KEY": "your-tavily-api-key-here"
    }
  }
}
```

> Replace `/absolute/path/to/memory-mcp-server/` with your actual path.

---

## 🛠️ Available Tools

<div align="center">

### 🎯 **54 Sophisticated Tools Across 8 Categories**

*Transform your AI agents with comprehensive memory, intelligence, and orchestration capabilities*

</div>

<div align="center">

| Category | Tools | Purpose |
|----------|-------|---------|
| 📞 **Conversations** | 9 | Multi-user session management |
| 🎯 **Plans & Tasks** | 15 | AI-powered project planning |
| 🕸️ **Knowledge Graph** | 6 | Codebase analysis & mapping |
| 🧠 **Embeddings** | 3 | Semantic search & retrieval |
| 🤖 **AI Enhancement** | 3 | Intelligent task optimization |
| 🔍 **AI Integration** | 1 | Advanced multi-model orchestration |
| 🗄️ **Database** | 3 | Data management & backup |
| 🌐 **Web Search** | 1 | External knowledge integration |

**[→ Complete tool reference and documentation](docs/TOOLS.md)**

</div>

## 📚 Documentation

### **Detailed Guides**
- 🏗️ **[Architecture & Flow Diagrams](docs/ARCHITECTURE.md)** - System design, technical specs, and tool flow diagrams
- 🛠️ **[Tools Reference](docs/TOOLS.md)** - Complete reference for all 54 tools
- ⚙️ **[Configuration Guide](docs/CONFIGURATION.md)** - Advanced setup and environment options
- 🚀 **[Deployment Guide](docs/DEPLOYMENT.md)** - Production deployment and scaling

### 🎯 **Tool Highlights**

**🧠 Semantic Intelligence**: Multi-model AI orchestration with Gemini, Codestral, and Mistral for specialized tasks.

**🔍 Advanced Search**: Hybrid RAG system combining vector embeddings, keyword search, and knowledge graph traversal.

**📝 Persistent Memory**: Multi-user conversation sessions with threading and comprehensive project planning.

**🕸️ Code Understanding**: Multi-language analysis (TypeScript, JavaScript, Python, PHP) with entity extraction and dependency mapping.

---

## ⚡ Example Workflow

Here’s how you might orchestrate a multi-step AI workflow with these tools:

1. **Understand the Goal**: Use `ask_gemini` (with `execution_mode: plan_generation`) to turn a high-level prompt into a structured project plan.
2. **Create the Plan**: Call `create_task_plan` with the refined prompt to initialize a new plan.
3. **Analyze Codebase**: Run `ingest_codebase_structure` to map code files and entities.
4. **Enrich Tasks**: Use `ai_suggest_subtasks` to break complex tasks into actionable subtasks.
5. **Track Progress**: Store and retrieve progress via `get_task`, `update_task`, and related tools.
6. **Search & Context**: Use `query_codebase_embeddings` or `tavily_web_search` as context for tasks or code review.
7. **Audit & Export**: Regularly export data with `export_data_to_csv` or back up the database.

[See the docs/ directory or the [project wiki](https://github.com/rashee1997/orchestrator/wiki) for more workflow recipes and advanced usage.]

---

For detailed architecture, technical specifications, and colorful tool flow diagrams, see **[Architecture Documentation](docs/ARCHITECTURE.md)**.

---

## 💻 Development

<div align="center">

### 🛠️ **Development Workflow**

</div>

<table>
<tr>
<td width="50%">

#### 🚀 **Quick Commands**
```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm run watch        # Auto-rebuild on changes
npm test             # Run test suite
npm run inspector    # Web debugging UI
```

</td>
<td width="50%">

#### 🎯 **Development Tips**
- 🔍 Use **inspector** for debugging
- 🔄 **Watch mode** for continuous development
- ✅ **Tests** ensure quality and stability
- 📝 **TypeScript** provides type safety
- 🔧 **ESLint** maintains code standards

</td>
</tr>
</table>

---

<div align="center">

## 🤝 Contributing

### 🌟 **Join the Future of AI Orchestration**

We welcome contributions from developers passionate about AI and intelligent systems!

<table>
<tr>
<td width="33%" align="center">

#### 🔨 **Code**
Submit PRs for features, fixes, and optimizations

</td>
<td width="33%" align="center">

#### 📚 **Documentation**
Improve guides, examples, and API docs

</td>
<td width="33%" align="center">

#### 🐛 **Testing**
Add tests and report issues

</td>
</tr>
</table>

**Guidelines:** Ensure new features include tests and maintain compatibility

</div>

---

<div align="center">

## 📄 License

**MIT License** — Open source and free to use

See [LICENSE](LICENSE.md) for complete details

---

### 🚀 **Built for the Future**

<img src="assets/orchestrator-logo.png" alt="Orchestrator Logo" width="80" />

*Memory MCP Server — Orchestrator*
**Empowering AI agents with persistent memory, intelligent planning, and semantic understanding**

**🧠 Think • 🔍 Search • 🎼 Orchestrate • 🚀 Scale**

---

[![GitHub](https://img.shields.io/badge/GitHub-Orchestrator-6b46c1?style=flat-square&logo=github)](https://github.com/rashee1997/orchestrator)
[![Contributors](https://img.shields.io/badge/Contributors-Welcome-ec4899?style=flat-square)](https://github.com/rashee1997/orchestrator/contribute)
[![AI Powered](https://img.shields.io/badge/AI-Powered-8b5cf6?style=flat-square)](https://github.com/rashee1997/orchestrator)

*Built with creativity and care for next-generation AI agents*

</div>
