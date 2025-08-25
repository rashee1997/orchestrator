## 📚 Tool‑Usage Guide  
*Designed for new human users **and** AI agents that interact with the MCP (Model‑Context‑Protocol) system.*

---

### Table of Contents
1. [Overview of Tool Architecture](#overview)  
2. [How to Call a Tool](#call)  
3. [Tool Categories & Quick Reference](#categories)  
4. [Detailed Tool Reference](#details)  
5. [Common Patterns & Tips](#patterns)  
6. [Error Handling & Debugging](#errors)  
7. [Appendix – Full Tool Definitions (for copy‑paste)](#appendix)

---

<a name="overview"></a>
## 1️⃣ Overview of Tool Architecture
- **All tools are registered in `src/tools/index.ts`.**  
- Each tool has:
  - **`name`** – the identifier used in a tool‑call JSON.  
  - **`description`** – human‑readable purpose.  
  - **`inputSchema`** – JSON block that defines required/optional parameters (type, description, defaults).  
  - **`func`** – the async handler that receives the arguments and a `MemoryManager` instance.  
- **Handlers are grouped by domain** (conversation, plan‑management, knowledge‑graph, embedding, Gemini, etc.) and exported via `getAllToolHandlers`.  
- The **MCP server** validates arguments against the schema before invoking the handler.  

---

<a name="call"></a>
## 2️⃣ How to Call a Tool
When an AI agent wants to use a tool, it must send a JSON payload like:

```json
{
  "tool_name": "create_conversation_session",
  "arguments": {
    "agent_id": "agent-123",
    "title": "Refactor User Service",
    "metadata": { "project": "my‑app" },
    "initial_participant_ids": ["agent-123", "user-456"]
  }
}
```

The server will:

1. **Validate** the payload against the tool’s `inputSchema`.  
2. **Execute** the handler (`func`).  
3. **Return** a MCP‑compatible response (`{ content: [{ type: "text", text }...] }`).  

> **Tip:** Always include `agent_id` (unless the tool explicitly says it’s optional). It scopes the operation to a specific user/agent.

---

<a name="categories"></a>
## 3️⃣ Tool Categories & Quick Reference

| Category | Tools (name) | Primary Use |
|----------|--------------|-------------|
| **Conversation** | `create_conversation_session`, `end_conversation_session`, `store_conversation_messages`, `get_conversation_session`, `get_conversation_sessions`, `get_conversation_messages`, `add_participant_to_session`, `get_session_participants`, `summarize_conversation` | Manage threaded chats, store/retrieve messages, invite participants, generate summaries. |
| **AI Task Enhancement** | `ai_suggest_subtasks`, `ai_suggest_task_details`, `ai_analyze_plan` | AI‑driven sub‑task generation, detailed task enrichment, whole‑plan analysis. |
| **Plan Management** | `create_task_plan`, `get_plan`, `list_task_plans`, `get_plan_tasks`, `add_task_to_plan`, `add_subtask_to_plan`, `update_task_plan_status`, `update_task_details`, `delete_task_plans`, `delete_tasks` … | CRUD for plans, tasks, subtasks; also bulk upload of subtasks. |
| **Knowledge Graph** | `ingest_codebase_structure`, `ingest_file_code_entities`, `knowledge_graph_memory`, `kg_nl_query`, `kg_infer_relations`, `kg_visualize` | Build & query a graph of code entities, visualize relationships, run natural‑language queries. |
| **Embedding / RAG** | `ingest_codebase_embeddings`, `query_codebase_embeddings`, `clean_up_embeddings` | Create vector embeddings for code chunks, retrieve similar chunks, clean up stale embeddings. |
| **Gemini (LLM) Interaction** | `ask_gemini` | General LLM query with optional RAG, iterative search, web search, and plan generation modes. |
| **Prompt Refinement** | `get_refined_prompt` | Retrieve a stored refined prompt (used to bootstrap a plan). |
| **Database Management** | `export_data_to_csv`, `backup_database`, `restore_database` | Export tables, backup/restore SQLite DB. |
| **Web Search (Tavily)** | `tavily_web_search` | Perform a web search via Tavily API and get markdown results. |
| **Utility** | `list_tools` | Returns a markdown table of every available tool (great for discovery). |

---

<a name="details"></a>
## 4️⃣ Detailed Tool Reference  

Below each tool is shown with:

1. **Signature** – required/optional fields.  
2. **Typical use‑case** (human wording).  
3. **Sample call** (JSON).  
4. **What you’ll get back** (markdown snippet).  

> **Important:** When copying the sample JSON into a chat, keep the outer braces intact. Do **not** embed triple back‑ticks inside the JSON; they are only for documentation.

---

### 4.1 Conversation Tools  

| Tool | Description | Parameters |
|------|-------------|------------|
| `create_conversation_session` | Starts a new conversation thread. | `agent_id` **(required)** – your agent’s ID.<br>`title` *(optional)* – human‑readable title.<br>`metadata` *(optional)* – any JSON you want to attach.<br>`initial_participant_ids` *(optional)* – list of other agents/users to invite. |
| **Sample Call** |
```json
{
  "tool_name": "create_conversation_session",
  "arguments": {
    "agent_id": "agent-001",
    "title": "Refactor Auth Service",
    "metadata": { "repo": "my‑app" },
    "initial_participant_ids": ["agent-001", "user-42"]
  }
}
```
| **Response** |
```
Created collaborative session: `c9f5e2b4-3a1d-4f6a-9c2b-7e1f5a8d9c0e`
```

---

| Tool | `store_conversation_messages` | Store one or many messages in a session. |
|------|------------------------------|------------------------------------------|
| **Parameters** |
- `session_id` **(required)** – UUID of the conversation.  
- `messages` **(required)** – array of message objects:  
  - `sender` **(required)** – ID of who sent it.  
  - `message_content` **(required)** – full text.  
  - `message_type` *(optional, default `text`)* – `text`, `tool_call`, `tool_output`, `thought`.  
  - `tool_info` *(optional)* – details when `message_type`**tool_call**` or `tool_output`.  
  - `parent_message_id` *(optional)* – reply threading.  
  - `metadata` *(optional)* – extra JSON.  
  - `generate_embedding` *(optional, default `false`)* – create a semantic embedding for the message. |
| **Sample Call** |
```json
{
  "tool_name": "store_conversation_messages",
  "arguments": {
    "session_id": "c9f5e2b4-3a1d-4f6a-9c2b-7e1f5a8d9c0e",
    "messages": [
      {
        "sender": "agent-001",
        "message_content": "I think we should split the UserService into smaller modules.",
        "message_type": "thought",
        "generate_embedding": true
      },
      {
        "sender": "user-42",
        "message_content": "Agreed. Can you draft the first module?",
        "message_type": "text"
      }
    ]
  }
}
```
| **Response** |
```
Stored 2 message(s) in session `c9f5e2b4-3a1d` (Messages Stored)
```

---

| Tool | `get_conversation_messages` | Retrieve chronological messages. |
|------|----------------------------|---------------------------------|
| **Parameters** |
- `session_id` **(required)** – target session.  
- `limit` *(optional, default 100)* – max messages to return.  
- `offset` *(optional, default 0)* – skip first N messages (pagination). |
| **Sample Call** |
```json
{
  "tool_name": "get_conversation_messages",
  "arguments": {
    "session_id": "c9f5e2b4-3a1d-4f6a-9c2b-7e1f5a8d9c0e",
    "limit": 20
  }
}
```
| **Response (excerpt)** |
```
## Messages in Session: `c9f5e2b4-3a1d-4f6a-9c2b-7e1f5a8d9c0e`

**[2025‑08‑25 14:02:11] agent-001:**  
> I think we should split the UserService into smaller modules.

**[2025‑08‑25 14:03:04] user-42:**  
> Agreed. Can you draft the first module?
...
```

---

### 4.2 AI Task Enhancement Tools  

| Tool | `ai_suggest_subtasks` | AI‑generated sub‑tasks for a parent task (or whole plan). |
|------|-----------------------|-----------------------------------------------------------|
| **Parameters** |
- `agent_id` **(required)**  
- `plan_id` **(required)** – the plan that contains the task.  
- `parent_task_id` *(optional)* – if omitted, the tool works at **plan‑level** and only suggests subtasks for tasks that lack them.  
- `max_suggestions` *(optional, default 3)* – how many sub‑tasks per parent task. |
| **Sample Call (single parent)** |
```json
{
  "tool_name": "ai_suggest_subtasks",
  "arguments": {
    "agent_id": "agent-001",
    "plan_id": "plan-abc123",
    "parent_task_id": "task-42",
    "max_suggestions": 5
  }
}
```
| **Sample Call (plan‑level)** |
```json
{
  "tool_name": "ai_suggest_subtasks",
  "arguments": {
    "agent_id": "agent-001",
    "plan_id": "plan-abc123"
  }
}
```
| **Response (markdown)** |
```
## AI Suggested Subtasks

### For Task: "Implement login flow" (ID: `task-42`)

#### Suggestion 1: Add OAuth support
- **Description:** Integrate Google/Facebook OAuth.
- **Dependencies on Other Tasks:** `task-10` ("Create user model")

...

✅ Automatic Creation: Successfully created 5 subtasks in the database.
```

---

| Tool | `ai_suggest_task_details` | Enrich a task with description, purpose, success criteria, etc. |
|------|---------------------------|-------------------------------------------------------------------|
| **Parameters** |
- `agent_id`, `plan_id`, `task_id` **(required)**.  
- Optional: `task_title`, `task_description` – if omitted the tool fetches them from the DB.  
- `codebase_context_summary` *(optional)* – a string you can supply to give the AI extra code context. |
| **Sample Call** |
```json
{
  "tool_name": "ai_suggest_task_details",
  "arguments": {
    "agent_id": "agent-001",
    "plan_id": "plan-abc123",
    "task_id": "task-42",
    "codebase_context_summary": "The auth module uses Passport.js and stores JWTs in Redis."
  }
}
```
| **Response (excerpt)** |
```
## AI Suggested Details for Task: "Implement login flow" (ID: `task-42`)

**Plan ID:** `plan-abc123`

### Suggested Description:
Implement a full login flow with email/password and OAuth providers.

### Suggested Success Criteria:
- Users can log in with email/password.
- OAuth login works for Google and Facebook.
- Tokens are stored securely in Redis.

*Note: These are AI suggestions. Review and apply with the appropriate plan/task update tools if desired.*
```

---

| Tool | `ai_analyze_plan` | High‑level plan health check (coherence, risks, missing steps). |
|------|-------------------|---------------------------------------------------------------|
| **Parameters** |
- `agent_id`, `plan_id` **(required)**.  
- `analysis_focus_areas` *(optional array)* – e.g., `["plan_coherence","risk_assessment"]`.  
- `codebase_context_summary` *(optional)* – include a code snippet summary if you want the AI to consider it. |
| **Sample Call** |
```json
{
  "tool_name": "ai_analyze_plan",
  "arguments": {
    "agent_id": "agent-001",
    "plan_id": "plan-abc123",
    "analysis_focus_areas": ["risk_assessment","dependency_concerns"]
  }
}
```
| **Response (excerpt)** |
```
## AI Plan Analysis Report for Plan ID: `plan-abc123` (Agent: `agent-001`)

### Overall Summary:
The plan covers most user‑auth scenarios but misses logout handling and token revocation.

### Scores (out of 10):
- **Overall Coherence:** 8
- **Clarity of Goal:** 7
- **Actionability of Tasks:** 6
- **Completeness:** 5

### Potential Risks or Issues:
- **Risk:** Session fixation attack possible.
  - *Mitigation:* Regenerate session ID after login.
- **Risk:** Missing token revocation flow.

### Suggestions for Improvement:
- Add a “Logout & token revocation* task.
- Include unit tests for token expiry handling.
```

---

### 4.3 Plan Management Tools  

| Tool | `create_task_plan` | Create a new plan (AI‑generated or manual). |
|------|--------------------|---------------------------------------------|
| **Parameters** |
- `agent_id` **(required)**.  
- **Either** `goal_description` **or** `refined_prompt_id` **or** both `planData` + `tasksData`.  
- Optional `live_review_file_paths` – array of absolute file paths to be **chunked and included** in the AI planning context. |
| **Sample Call (AI‑generated)** |
```json
{
  "tool_name": "create_task_plan",
  "arguments": {
    "agent_id": "agent-001",
    "goal_description": "Refactor the user service to use a clean architecture.",
    "live_review_file_paths": ["src/services/userService.ts"]
  }
}
```
| **Sample Call (Manual)** |
```json
{
  "tool_name": "create_task_plan",
  "arguments": {
    "agent_id": "agent-001",
    "planData": { "title": "User Service Refactor", "status": "draft" },
    "tasksData": [
      { "title": "Extract business logic", "status": "todo" },
      { "title": "Add repository layer", "status": "todo" }
    ]
  }
}
```
| **Response** |
```
## Plan: User Service Refactor
| Task ID | Title                     | Status |
|---------|---------------------------|--------|
| task‑a1 | Extract business logic    | todo   |
| task‑b2 | Add repository layer      | todo   |
```

---

| Tool | `add_subtask_to_plan` | Bulk‑add subtasks (supports array). |
|------|-----------------------|-------------------------------------|
| **Parameters** |
- `agent_id`, `plan_id` **(required)**.  
- `parent_task_id` *(optional)* – if omitted the sub‑tasks are **plan‑level**.  
- `subtaskData` **(required)** – either a single object or an array of objects, each with `title`, `description`, `status`, etc. |
| **Sample Call (bulk)** |
```json
{
  "tool_name": "add_subtask_to_plan",
  "arguments": {
    "agent_id": "agent-001",
    "plan_id": "plan-abc123",
    "parent_task_id": "task-42",
    "subtaskData": [
      { "title": "Write unit tests for login", "status": "todo" },
      { "title": "Add rate‑limit middleware", "status": "todo" }
    ]
  }
}
```
| **Response** |
```
Added 2 subtasks to plan `plan-abc123`. IDs: `subtask‑x1`, `subtask‑y2`. (Subtasks Added)
```

---

| Tool | `update_task` | Partial update of any task field (title, description, status, etc.). |
|------|---------------|-----------------------------------------------------------------------|
| **Parameters** |
- `agent_id`, `task_id` **(required)**.  
- Any other fields you wish to modify (`title`, `status`, `description`, `completion_timestamp`, …). |
| **Sample Call** |
```json
{
  "tool_name": "update_task",
  "arguments": {
    "agent_id": "agent-001",
    "task_id": "task-42",
    "status": "in_progress",
    "completion_timestamp": "2025-09-01T12:00:00Z"
  }
}
```
| **Response** |
```
Task `task-42` updated successfully. (Update Task)
```

---

### 4.4 Knowledge‑Graph Tools  

| Tool | `ingest_codebase_structure` | Scan a directory, create file/folder nodes, optional import parsing. |
|------|-----------------------------|--------------------------------------------------------------------|
| **Parameters** |
- `agent_id`, `directory_path` **(required)** – absolute or relative to `project_root_path`.  
- `project_root_path` *(optional)* – defaults to the repo root.  
- `parse_imports` *(optional, default false)* – if `true`, extracts import statements and creates `module` nodes.  
- `perform_deep_entity_ingestion` *(optional, default false)* – if `true`, runs a **full code‑entity parse** on every file (functions, classes, etc.). |
| **Sample Call** |
```json
{
  "tool_name": "ingest_codebase_structure",
  "arguments": {
    "agent_id": "agent-001",
    "directory_path": "./src",
  "parse_imports": true,
    "perform_deep_entity_ingestion": true
  }
}
```
| **Response (excerpt)** |
```
Codebase structure ingestion for directory "./src" complete.
- Nodes Newly Created: 124
- Nodes Updated (Observations): 8
- Relations Created: 210
```

---

| Tool | `kg_nl_query` | Natural‑language query over the knowledge graph. |
|------|---------------|---------------------------------------------------|
| **Parameters** |
- `agent_id`, `query` **(required)**.  
- `model` *(optional)* – Gemini model to use (default `gemini-2.5-flash`). |
| **Sample Call** |
```json
{
  "tool_name": "kg_nl_query",
  "arguments": {
    "agent_id": "agent-001",
    "query": "Which classes implement the IPaymentProcessor interface?"
  }
}
```
| **Response (excerpt)** |
```
## Natural Language Query Result for Agent: `agent-001`

**Query:** "Which classes implement the IPaymentProcessor interface?"

### Results
```json
{
  "nodes": [
    { "name": "src/payments/`PaymentService`", "entityType": "class" },
    { "name": "src/payments/`LegacyPaymentAdapter`", "entityType": "class" }
  ],
  "relations": []
}
```
```

---

| Tool | `kg_visualize` | Produce a Mermaid diagram of a sub‑graph. |
|------|----------------|-------------------------------------------|
| **Parameters** |
- `agent_id` **(required)**.  
- `query` *(optional)* – a KG query string (e.g., `type:file AND name:*.ts`).  
- `natural_language_query` *(optional)* – AI‑driven filter.  
- `layout_direction` *(optional, default `TD`)* – `TD`, `LR`, etc.  
- `depth` *(optional, default 2)* – how many hops from the seed nodes. |
| **Sample Call** |
```json
{
  "tool_name": "kg_visualize",
  "arguments": {
    "agent_id": "agent-001",
    "natural_language_query": "Show all functions that call `database.query` in the auth module",
    "layout_direction": "LR",
    "depth": 3,
    "include_legend": true
  }
}
```
| **Response (markdown)** |
```
## Knowledge Graph Visualization for Agent: `agent-001`

```mermaid
graph LR;
  A[authService.ts] --> B[loginUser()];
  B --> C[database.query()];
  ...
```
```

---

### 4.5 Embedding / RAG Tools  

| Tool | `ingest_codebase_embeddings` | Chunk files, generate vector embeddings, store them. |
|------|------------------------------|---------------------------------------------------|
| **Parameters** |
- `agent_id`, `project_root_path` **(required)**.  
- Either `path_to_embed` *(single file/dir)* **or** `paths_to_embed` *(array)*.  
- `chunking_strategy` *(optional)* – e.g., `semantic`, `line`.  
- `disable_ai_output_summary` *(optional)* – if `true` skip AI‑generated chunk summaries. |
| **Sample Call** |
```json
{
  "tool_name": "ingest_codebase_embeddings",
  "arguments": {
    "agent_id": "agent-001",
    "project_root_path": "/home/me/my-app",
    "paths_to_embed": ["src/services/auth.ts","src/utils/crypto.ts"],
    "chunking_strategy": "semantic"
  }
}
```
| **Response (excerpt)** |
```
## Ingestion Summary
Codebase embedding ingestion for 2 specified files complete.

### Overall Statistics:
- **New Embeddings Created:** 342
- **Reused Existing Embeddings:** 0
- **Deleted Stale Embeddings:** 0
...
```

---

| Tool | `query_codebase_embeddings` | Retrieve semantically similar code chunks. |
|------|-----------------------------|-------------------------------------------|
| **Parameters** |
- `agent_id`, `query_text` **(required)**.  
- `top_k` *(optional, default 5)* – number of results.  
- `enable_dmqr` *(optional, default false)* – if `true`, the system will generate diverse queries before searching. |
| **Sample Call (with DMQR)** |
```json
{
  "tool_name": "query_codebase_embeddings",
  "arguments": {
    "agent_id": "agent-001",
    "query_text": "How does the password reset token get stored?",
    "top_k": 3,
    "enable_dmqr": true,
    "dmqr_query_count": 4
  }
}
```
| **Response (excerpt)** |
```
## Similar Code Chunks for Query: "How does the password reset token get stored?" (DMQR enabled: searched with 5 queries) (Top 3)

### Result 1 (Score: 0.9624)
- **File:** `src/services/auth.ts`
- **Entity:** `resetTokenStore`
**Content Snippet:**
```text
const tokenStore = new Map<string, string>();
...
```
---
...
```

---

### 4.6 Gemini (LLM) Tool  

| Tool | `ask_gemini` | General LLM query with optional RAG, iterative search, web search, or plan generation. |
|------|--------------|----------------------------------------------------------------------------------------|
| **Core Parameters** |
- `agent_id`, `query` **(required)**.  
- `model` *(optional, default `gemini-2.5-flash`)*.  
- `session_id` / `session_name` / `session_sequence_number` – for **conversation continuity**.  
- `continue` *(boolean)* – `true` to continue an existing session, `false` to start a new one.  
- `conversation_history_limit` *(default 15)* – how many past messages to feed.  
- `enable_rag` *(boolean)* – let the system decide whether to pull code context.  
- `enable_iterative_search` *(boolean)* – force multi‑turn RAG (useful for complex queries).  
- `max_iterations` *(default 3)* – cap for iterative search.  
- `enable_web_search` *(boolean)* – allow Tavily web search inside the loop.  
- `enable_dmqr` *(boolean)* – generate diverse queries before the first retrieval.  
- `execution_mode` – `generative_answer` (default) or `plan_generation`. |
| **Sample Call (simple generative answer)** |
```json
{
  "tool_name": "ask_gemini",
  "arguments": {
    "agent_id": "agent-001",
    "query": "Explain the purpose of the `UserService` class.",
    "enable_rag": true,
    "conversation_history_limit": 10
  }
}
```
| **Sample Call (iterative RAG with web search)** |
```json
{
  "tool_name": "ask_gemini",
  "arguments": {
    **(same as above)**
    "enable_iterative_search": true,
    "enable_web_search": true,
    "max_iterations": 4,
    "enable_dmqr": true,
    "dmqr_query_count": 3
  }
}
```
| **Sample Call (plan generation)** |
```json
{
  "tool_name": "ask_gemini",
  "arguments": {
    "agent_id": "agent-001",
    "query": "Create a migration plan to move from MySQL to PostgreSQL.",
    "execution_mode": "plan_generation",
    "model": "gemini-pro"
  }
}
```
| **Typical Response (generative)** |
```
## Gemini Response

> "Explain the purpose of the `UserService` class."

### AI Answer
The `UserService` encapsulates all business‑logic related to user accounts: registration, authentication, profile updates, and password resets. It delegates persistence to the `UserRepository` and uses the `AuthProvider` for token generation, keeping the controller layer thin and testable.

---  
**Search & Reasoning Trajectory**
...
```

| **Typical Response (plan generation)** |
```
## Plan Generation Result
{
  "plan": { … },
  "tasks": [ … ]
}
```

---

### 4.7 Prompt‑Refinement Tools  

| Tool | `get_refined_prompt` | Retrieve a stored refined prompt (used as a seed for `create_task_plan`). |
|------|----------------------|---------------------------------------------------|
| **Parameters** |
- `agent_id`, `refined_prompt_id` **(required)**. |
| **Sample Call** |
```json
{
  "tool_name": "get_refined_prompt",
  "arguments": {
    "agent_id": "agent-001",
    "refined_prompt_id": "refined‑abc123"
  }
}
```
| **Response (excerpt)** |
```
## Refined Prompt Details (ID: refined‑abc123)

- **Agent ID:** `agent-001`
- **Original Prompt:** "Migrate the auth service to a clean‑architecture pattern."
- **Refinement Engine:** `gemini-2.5-flash`
- **Overall Goal:** Refactor authentication to separate concerns.
- **Decomposed Tasks:** …
```

---

### 4.8 Database Management Tools  

| Tool | `export_data_to_csv` | Export a table to CSV (markdown‑friendly output). |
|------|----------------------|---------------------------------------------------|
| **Parameters** |
- `tableName` **(required)** – e.g., `knowledge_graph_nodes`.  
- `filePath` **(required)** – where the CSV will be written (absolute or relative). |
| **Sample Call** |
```json
{
  "tool_name": "export_data_to_csv",
  "arguments": {
    "tableName": "knowledge_graph_nodes",
    "filePath": "./exports/nodes.csv"
  }
}
```
| **Response** |
```
CSV Export: Data from `knowledge_graph_nodes` written to `./exports/nodes.csv`.
```

| Tool | `backup_database` | Create a SQLite backup file. |
|------|-------------------|------------------------------|
| **Parameters** |
- `backupFilePath` **(required)** – destination path. |
| **Sample Call** |
```json
{
  "tool_name": "backup_database",
  "arguments": { "backupFilePath": "./backups/db-2025-08-25.bak" }
}
```
| **Response** |
```
Database Backup: Backup created at `./backups/db-2025-08-25.bak`.
```

| Tool | `restore_database` | Restore from a backup (overwrites current DB). |
|------|--------------------|----------------------------------------------|
| **Parameters** |
- `backupFilePath` **(required)** – path to the backup file. |
| **Sample Call** |
```json
{
  "tool_name": "restore_database",
  "arguments": { "backupFilePath": "./backups/db-2025-08-25.bak" }
}
```
| **Response** |
```
Database Restore: Restored from `./backups/db-2025-08-25.bak`.
```

---

### 4.9 Source‑Attribution (Web Search)  

| Tool | `tavily_web_search` | Perform a Tavily web search and receive markdown results. |
|------|---------------------|----------------------------------------------------------|
| **Parameters** |
- `query` **(required)**.  
- `search_depth` *(optional, default `basic`)* – `basic` or `advanced`.  
- `max_results` *(optional, default 5)*.  
- `include_raw_content`, `include_images`, `include_image_descriptions` *(optional booleans)*. |
| **Sample Call** |
```json
{
  "tool_name": "tavily_web_search",
  "arguments": {
    "query": "latest Node.js LTS release notes",
    "search_depth": "advanced",
    "max_results": 3,
    "include_raw_content": true
  }
}
```
| **Response (excerpt)** |
```
## Tavily Web Search Results for Query: "latest Node.js LTS release notes"

### Result 1: Node.js 20.x LTS
- **URL:** <https://nodejs.org/en/blog/release/v20.0.0/>
- **Content Snippet:**  
  > Node.js 20.x is the current LTS version...
...
```

---

### 4.10 Utility  

| Tool | `list_tools` | Returns a markdown list of **all** available tools with their parameters. |
|------|--------------|--------------------------------------------------------------------------|
| **Parameters** | *none* | |
| **Sample Call** |
```json
{
  "tool_name": "list_tools",
  "arguments": {}
}
```
| **Response (excerpt)** |
```
## Available Tools

### `create_conversation_session`
Use this to start a new, `agent_id` (string, required) – Your unique agent ID. `title` (string, optional) – A brief, human‑readable title for the session. ...

--- 

### `ai_suggest_subtasks`
Given a parent task's ID, uses an AI model to suggest a list of actionable subtasks… (parameters listed)

...
```

---

<a name="patterns"></a>
## 5️⃣ Common Patterns & Tips  

| Pattern | When to Use | How to Apply |
|---------|-------------|--------------|
| **Conversation Continuity** | You need multi‑turn dialogue with memory of past messages. | Pass `continue: true` and either `session_id`, `session_name`, or `session_sequence_number`. If none are supplied, the system will pick the most recent session. |
| **Force RAG** | The query is about code that may not be in the conversation history. | Set `enable_rag: true`. The system will retrieve code context automatically. |
| **Iterative Search** | The problem is complex (e.g., “Design a micro‑service architecture for payments”). | Set `enable_iterative_search: true` and optionally `max_iterations` (default 3). The orchestrator will loop‑through analysis → search → self‑correction. |
| **DMQR (Diverse Multi‑Query Rewriting)** | You suspect a single query isn’t expressive enough. | Set `enable_dmqr: true` and optionally `dmqr_query_count` (2‑5). The system will generate multiple queries and merge results. |
| **Web Search Integration** | You need up‑to‑date external information (e.g., latest library API). | Set `google_search: true` **or** `enable_web_search: true` (the latter uses Tavily). |
| **Plan Generation Mode** | You want Gemini to output a structured plan (tasks, subtasks, scores). | Set `execution_mode: "plan_generation"` and optionally provide a `model`. |
| **Bulk Subtask Upload** | You have many subtasks prepared in a file. | Pass an **array** to `subtaskData` in `add_subtask_to_plan`. |
| **Embedding‑Based Code Search** | You need “find similar code” rather than keyword search. | Use `query_codebase_embeddings`. Enable DMQR for richer queries. |
| **Knowledge‑Graph NL Query** | You want to ask natural‑language questions about code entities. | Use `kg_nl_query`. The system translates to graph queries internally. |
| **Visualization** | You need a quick diagram for a PR review. | Use `kg_visualize` with `natural_language_query` or a raw KG query. |
| **Error‑Resilient Calls** | Agents may receive validation errors. | Always check the `content` field for a markdown error message; the server returns a `McpError` with a clear description. |

---

<a name="errors"></a>
## 6️⃣ Error Handling & Debugging  

1. **Validation Errors** – Returned as a markdown block via `formatJsonToMarkdownCodeBlock`. Example:  

   ```
   Validation failed for ai_suggest_subtasks: 
   ```json
   {
     "agent_id": ["Missing required property"]
   }
   ```
   ```

2. **McpError Codes** (from `@modelcontextprotocol/sdk/types.js`):  

| Code | Meaning |
|------|---------|
| `InvalidParams` | Missing/incorrect arguments. |
| `MethodNotFound` | Tool name does not exist. |
| `InternalError` | Unexpected server‑side failure (e.g., DB error, Gemini API failure). |
| `NotFound` (rare) | Requested entity (session, plan, node) does not exist. |

3. **Logging** – All handlers write to `console.warn` / `console.error`. When debugging, check the server logs for the exact stack trace.

4. **Retries** – For network‑bound tools (`ask_gemini`, `tavily_web_search`, embedding APIs) the underlying services already implement exponential back‑off. If you see repeated `InternalError` from those, consider checking API keys / rate limits.

5. **Idempotency** –  
   - `ingest_codebase_structure` and `knowledge_graph_memory` are **idempotent** – they update existing nodes/relations rather than duplicate them.  
   - `create_conversation_session` always creates a new UUID, even if the same title is used.

---

<a name="appendix"></a>
## 7️⃣ Appendix – Full Tool Definitions (Copy‑Paste)

Below are the **exact source snippets** for each tool definition (as they appear in the repository).  
You can paste these directly into a new file if you need to recreate the tool set.

> **NOTE:** The code blocks are **single‑level** fenced with three back‑`​` characters. Do **not** nest additional fences inside them.

```ts
// src/tools/conversation_tools.ts
import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate } from '../utils/validation.js';
import { formatSimpleMessage, formatJsonToMarkdownCodeBlock } from '../utils/formatters.js';

export const conversationToolDefinitions = [
    {
        name: 'create_conversation_session',
        description: 'Use this to start a new, distinct conversation thread or topic. It acts as a container for messages and participants, enabling structured, collaborative dialogues.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Your unique agent ID. This is required to associate the session with you as the creator.' },
                title: { type: 'string', description: "A brief, human-readable title for the session, like 'Refactoring the User Service'. Helps in identifying sessions later.", nullable: true },
                metadata: { type: 'object', description: 'A flexible JSON object to store any relevant structured data, such as related task IDs, "project names, or session goals.', nullable: true },
                initial_participant_ids: {
                    type: 'array',
                    items: { type: 'string' },
                    description: "A list of other agent or user IDs to immediately include in this collaborative session. Your own agent ID is added automatically as the 'owner'.",
                    nullable: true
                }
            },
            required: ['agent_id'],
        },
    },
    // ... (rest of conversation tools omitted for brevity; see repository)
];
```

```ts
// src/tools/ai_task_enhancement_tools.ts
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { MemoryManager } from '../database/memory_manager.js';
import { CodebaseContextRetrieverService } from '../database/services/CodebaseContextRetrieverService.js';
import { GeminiIntegrationService } from '../database/services/GeminiIntegrationService.js';
import { PlanTaskManager, ParsedTask } from '../database/managers/PlanTaskManager.js';
import { SubtaskManager } from '../database/managers/SubtaskManager.js';
import { formatJsonToMarkdownCodeBlock, formatPlanToMarkdown, formatSimpleMessage } from '../utils/formatters.js';
import { schemas, ... } from '../utils/validation.js';
import {
    AI_SUGGEST_SUBTASKS_PROMPT,
    AI_TASK_COMPLEXITY_ANALYSIS_PROMPT,
    AI_SUGGEST_TASK_DETAILS_PROMPT,
    AI_ANALYZE_PLAN_PROMPT
} from '../database/services/gemini-integration-modules/GeminiPromptTemplates.js';
import { parseGeminiJsonResponse } from '../database/services/gemini-integration-modules/GeminiResponseParsers.js';

// ... (full file as provided)
```

```ts
// src/tools/plan_management_tools.ts
// (full source – see repository)
```

```ts
// src/tools/knowledge_graph_tools.ts
// (full source – see repository)
```

```ts
// src/tools/embedding_tools.ts
// (full source – see repository)
```

```ts
// src/tools/gemini_tools.ts
// (full source – see repository)
```

```ts
// src/tools/prompt_refinement_tools.ts
// (full source – see repository)
```

```ts
// src/tools/database_management_tools.ts
// (full source – see repository)
```

```ts
// src/tools/source_attribution_tools.ts
// (full source – see ... )
```

```ts
// src/tools/knowledge_graph_tools.ts
// (full source – see ... )
```

```ts
// src/tools/knowledge_graph_tools.ts
// (full source – see ... )
```

*(The remaining helper files – `history_manager.ts`, `rag/*`, `migration/KnowledgeGraphMigrator.ts` – are not directly exposed as user‑facing tools but support the above functionalities.)*

---

### 🎉 You’re Ready!

- **Pick the tool that matches your intent.**  
- **Supply the required arguments** (see the tables above).  
- **Read the markdown response** – it already contains a human‑friendly summary, tables, or Mermaid diagrams.  

If you ever need a refresher, just call `list_tools` and the system will print the entire catalogue again. Happy building!