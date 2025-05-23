# API Documentation

This document provides comprehensive API documentation for all tools exposed by the Memory MCP Server. It details the purpose, input schemas, and expected outputs for each tool, serving as a reference for AI agents and developers integrating with the server.

## General Tool Call Structure

All interactions with the Memory MCP Server are performed via the `use_mcp_tool` command, targeting the `memory-mcp-server` server.

```xml
<use_mcp_tool>
<server_name>memory-mcp-server</server_name>
<tool_name>[TOOL_NAME]</tool_name>
<arguments>
{
  // Tool-specific arguments as per inputSchema
}
</arguments>
</use_mcp_tool>
```

## Error Handling

The server returns `McpError` instances for various issues. Common `ErrorCode` values include:

*   `ErrorCode.InvalidParams`: When provided arguments do not match the tool's `inputSchema` or are semantically invalid.
*   `ErrorCode.MethodNotFound`: When an unknown tool name is requested.
*   `ErrorCode.InternalError`: For unexpected server-side errors during tool execution.

Errors will be returned in the `isError: true` field of the tool response, with details in the `content` field.

## Tool Reference

---

### `store_conversation_message`

*   **Description:** Stores a message in the conversation history.
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "agent_id": { "type": "string", "description": "Identifier of the AI agent." },
        "user_id": { "type": "string", "description": "Identifier of the user (optional).", "nullable": true },
        "sender": { "type": "string", "description": "Role of the sender (e.g., user, agent, system)." },
        "message_content": { "type": "string", "description": "The actual text of the message." },
        "message_type": { "type": "string", "description": "Type of message (e.g., text, image, tool_call, tool_output).", "default": "text" },
        "tool_info": { "type": "string", "description": "JSON string for tool calls/outputs (tool_name, args, result).", "nullable": true },
        "context_snapshot_id": { "type": "string", "description": "Foreign key to context_information table.", "nullable": true },
        "source_attribution_id": { "type": "string", "description": "Foreign key to source_attribution table.", "nullable": true }
      },
      "required": ["agent_id", "sender", "message_content"]
    }
    ```
*   **Output:** Returns a text message with the generated `conversation_id`.
    ```json
    { "content": [{ "type": "text", "text": "Conversation message stored with ID: [UUID]" }] }
    ```

---

### `get_conversation_history`

*   **Description:** Retrieves conversation history for a given agent and optional conversation ID.
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "agent_id": { "type": "string", "description": "Identifier of the AI agent." },
        "conversation_id": { "type": "string", "description": "Optional unique identifier for a specific conversation.", "nullable": true },
        "limit": { "type": "number", "description": "Maximum number of messages to retrieve.", "default": 100 },
        "offset": { "type": "number", "description": "Offset for pagination.", "default": 0 }
      },
      "required": ["agent_id"]
    }
    ```
*   **Output:** Returns a JSON array of conversation message objects.
    ```json
    {
      "content": [{
        "type": "json",
        "json": [
          {
            "conversation_id": "uuid-1",
            "agent_id": "agent-001",
            "user_id": "user-123",
            "timestamp": 1678886400000,
            "sender": "user",
            "message_content": "Hello!",
            "message_type": "text",
            "tool_info": null,
            "context_snapshot_id": "context-uuid-1",
            "source_attribution_id": "source-uuid-1"
          }
        ]
      }]
    }
    ```

---

### `store_context`

*   **Description:** Stores dynamic contextual data for an AI agent.
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "agent_id": { "type": "string", "description": "Identifier of the AI agent." },
        "context_type": { "type": "string", "description": "Category of context (e.g., agent_state, user_preference, task_parameters)." },
        "context_data": { "type": "object", "description": "JSON object containing the structured context data." },
        "parent_context_id": { "type": "string", "description": "Self-referencing foreign key for hierarchical context.", "nullable": true }
      },
      "required": ["agent_id", "context_type", "context_data"]
    }
    ```
*   **Output:** Returns a text message with the generated `context_id`.
    ```json
    { "content": [{ "type": "text", "text": "Context stored with ID: [UUID]" }] }
    ```

---

### `get_context`

*   **Description:** Retrieves contextual data for a given agent and context type, optionally by version.
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "agent_id": { "type": "string", "description": "Identifier of the AI agent." },
        "context_type": { "type": "string", "description": "Category of context." },
        "version": { "type": "number", "description": "Optional specific version of the context. If not provided, the latest version is returned.", "nullable": true }
      },
      "required": ["agent_id", "context_type"]
    }
    ```
*   **Output:** Returns a JSON object of the context entry.
    ```json
    {
      "content": [{
        "type": "json",
        "json": {
          "context_id": "uuid-2",
          "agent_id": "agent-001",
          "timestamp": 1678886500000,
          "context_type": "current_task",
          "context_data": { "task_id": "task-abc", "status": "in_progress" },
          "version": 1,
          "parent_context_id": null
        }
      }]
    }
    ```

---

### `get_all_contexts`

*   **Description:** Retrieves all contextual data for a given agent.
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "agent_id": { "type": "string", "description": "Identifier of the AI agent." }
      },
      "required": ["agent_id"]
    }
    ```
*   **Output:** Returns a JSON array of all context entries for the agent.

---

### `add_task_to_plan`

*   **Description:** Adds a new task to an existing plan.
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "agent_id": { "type": "string", "description": "Identifier of the AI agent." },
        "plan_id": { "type": "string", "description": "Unique ID of the plan to add the task to." },
        "taskData": {
            "type": "object",
            "properties": {
                "task_number": { "type": "number" },
                "title": { "type": "string" },
                "description": { "type": ["string", "null"] },
                "status": { "type": "string" },
                "purpose": { "type": ["string", "null"] },
                "action_description": { "type": ["string", "null"] },
                "files_involved": { "type": ["array", "null"], "items": { "type": "string" } },
                "dependencies_task_ids": { "type": ["array", "null"], "items": { "type": "string" } },
                "tools_required_list": { "type": ["array", "null"], "items": { "type": "string" } },
                "inputs_summary": { "type": ["string", "null"] },
                "outputs_summary": { "type": ["string", "null"] },
                "success_criteria_text": { "type": ["string", "null"] },
                "estimated_effort_hours": { "type": ["number", "null"] },
                "assigned_to": { "type": ["string", "null"] },
                "verification_method": { "type": ["string", "null"] },
                "notes": { "type": ["object", "null"] }
            },
            "required": ["task_number", "title"],
            "additionalProperties": false
        }
      },
      "required": ["agent_id", "plan_id", "taskData"]
    }
    ```
*   **Output:** Returns a text message with the generated `task_id`.
    ```json
    { "content": [{ "type": "text", "text": "Task added with ID: [UUID]" }] }
    ```

---

### `backup_database`

*   **Description:** Creates a backup copy of the SQLite database file.
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "backupFilePath": { "type": "string", "description": "The path where the database backup file will be saved." }
      },
      "required": ["backupFilePath"]
    }
    ```
*   **Output:** Returns a text message indicating success or failure.
    ```json
    { "content": [{ "type": "text", "text": "Database backed up successfully to /path/to/backup.db" }] }
    ```

---

### `restore_database`

*   **Description:** Restores the SQLite database from a specified backup file. WARNING: This will overwrite the current database.
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "backupFilePath": { "type": "string", "description": "The path to the database backup file to restore from." }
      },
      "required": ["backupFilePath"]
    }
    ```
*   **Output:** Returns a text message indicating success or failure.
    ```json
    { "content": [{ "type": "text", "text": "Database restored successfully from /path/to/backup.db" }] }
    ```
*   **Output:** Returns a JSON array of reference key objects.

---

### `log_source_attribution`

*   **Description:** Logs the origin of information used or generated by the AI agent.
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "agent_id": { "type": "string", "description": "Identifier of the AI agent." },
        "source_type": { "type": "string", "description": "Type of source (e.g., user_input, tavily_search, internal_reasoning)." },
        "source_uri": { "type": "string", "description": "URI or identifier of the source (e.g., URL for web, query for Tavily).", "nullable": true },
        "retrieval_timestamp": { "type": "number", "description": "Unix timestamp of when the information was retrieved." },
        "content_summary": { "type": "string", "description": "Brief summary of the attributed content.", "nullable": true },
        "full_content_hash": { "type": "string", "description": "Optional, hash of the full content for integrity checking.", "nullable": true }
      },
      "required": ["agent_id", "source_type", "retrieval_timestamp"]
    }
    ```
*   **Output:** Returns a text message with the generated `attribution_id`.

---

### `get_source_attributions`

*   **Description:** Retrieves source attributions for a given agent, optionally filtered by source type.
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "agent_id": { "type": "string", "description": "Identifier of the AI agent." },
        "source_type": { "type": "string", "description": "Optional type of source to filter by.", "nullable": true },
        "limit": { "type": "number", "description": "Maximum number of attributions to retrieve.", "default": 100 },
        "offset": { "type": "number", "description": "Offset for pagination.", "default": 0 }
      },
      "required": ["agent_id"]
    }
    ```
*   **Output:** Returns a JSON array of source attribution objects.

---

### `log_correction`

*   **Description:** Records instances where the AI agent's output or internal state was corrected.
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "agent_id": { "type": "string", "description": "Identifier of the AI agent." },
        "correction_type": { "type": "string", "description": "Type of correction (e.g., user_feedback, self_correction, system_override)." },
        "original_entry_id": { "type": "string", "description": "ID of the memory entry that was corrected (e.g., conversation_id, context_id).", "nullable": true },
        "original_value": { "type": "object", "description": "JSON object of the original data before correction.", "nullable": true },
        "corrected_value": { "type": "object", "description": "JSON object of the corrected data.", "nullable": true },
        "reason": { "type": "string", "description": "Explanation for the correction.", "nullable": true },
        "applied_automatically": { "type": "boolean", "description": "True if applied by system, false if manual." }
      },
      "required": ["agent_id", "correction_type", "applied_automatically"]
    }
    ```
*   **Output:** Returns a text message with the generated `correction_id`.

---

### `get_correction_logs`

*   **Description:** Retrieves correction logs for a given agent, optionally filtered by correction type.
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "agent_id": { "type": "string", "description": "Identifier of the AI agent." },
        "correction_type": { "type": "string", "description": "Optional type of correction to filter by.", "nullable": true },
        "limit": { "type": "number", "description": "Maximum number of logs to retrieve.", "default": 100 },
        "offset": { "type": "number", "description": "Offset for pagination.", "default": 0 }
      },
      "required": ["agent_id"]
    }
    ```
*   **Output:** Returns a JSON array of correction log objects.

---

### `log_success_metric`

*   **Description:** Logs quantitative and qualitative metrics related to the AI agent's performance.
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "agent_id": { "type": "string", "description": "Identifier of the AI agent." },
        "metric_name": { "type": "string", "description": "Name of the metric (e.g., task_completion_rate, response_latency_ms)." },
        "metric_value": { "type": "number", "description": "The numerical value of the metric." },
        "unit": { "type": "string", "description": "Unit of the metric (e.g., percent, ms, score).", "nullable": true },
        "associated_task_id": { "type": "string", "description": "Optional, link to a specific task.", "nullable": true },
        "metadata": { "type": "object", "description": "JSON object for additional metric-specific data.", "nullable": true }
      },
      "required": ["agent_id", "metric_name", "metric_value"]
    }
    ```
*   **Output:** Returns a text message with the generated `metric_id`.

---

### `get_success_metrics`

*   **Description:** Retrieves success metrics for a given agent, optionally filtered by metric name.
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "agent_id": { "type": "string", "description": "Identifier of the AI agent." },
        "metric_name": { "type": "string", "description": "Optional name of the metric to filter by.", "nullable": true },
        "limit": { "type": "number", "description": "Maximum number of metrics to retrieve.", "default": 100 },
        "offset": { "type": "number", "description": "Offset for pagination.", "default": 0 }
      },
      "required": ["agent_id"]
    }
    ```
*   **Output:** Returns a JSON array of success metric objects.

---

### `tavily_web_search`

*   **Description:** A powerful web search tool that provides comprehensive, real-time results using Tavily's AI search engine. Returns relevant web content with customizable parameters for result count, content type, and domain filtering. Ideal for gathering current information, news, and detailed web content analysis.
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "query": { "type": "string", "description": "Search query" },
        "search_depth": { "type": "string", "enum": ["basic", "advanced"], "description": "The depth of the search. It can be 'basic' or 'advanced'", "default": "basic" },
        "topic": { "type": "string", "enum": ["general", "news"], "description": "The category of the search. This will determine which of our agents will be used for the search", "default": "general" },
        "days": { "type": "number", "description": "The number of days back from the current date to include in the search results. This specifies the time frame of data to be retrieved. Please note that this feature is only available when using the 'news' search topic", "default": 3 },
        "time_range": { "type": "string", "description": "The time range back from the current date to include in the search results. This feature is available for both 'general' and 'news' search topics", "enum": ["day", "week", "month", "year", "d", "w", "m", "y"] },
        "max_results": { "type": "number", "description": "The maximum number of search results to return", "default": 10, "minimum": 5, "maximum": 20 },
        "include_images": { "type": "boolean", "description": "Include a list of query-related images in the response", "default": false },
        "include_image_descriptions": { "type": "boolean", "description": "Include a list of query-related images and their descriptions in the response", "default": false },
        "include_raw_content": { "type": "boolean", "description": "Include the cleaned and parsed HTML content of each search result", "default": false },
        "include_domains": { "type": "array", "items": { "type": "string" }, "description": "A list of domains to specifically include in the search results, if the user asks to search on specific sites set this to the domain of the site", "default": [] },
        "exclude_domains": { "type": "array", "items": { "type": "string" }, "description": "List of domains to specifically exclude, if the user asks to exclude a domain set this to the domain of the site", "default": [] }
      },
      "required": ["query"]
    }
    ```
*   **Output:** Returns a JSON array of Tavily search results.
    ```json
    {
      "content": [{
        "type": "json",
        "json": [
          {
            "title": "Example Search Result",
            "url": "https://example.com/result1",
            "content": "..."
          }
        ]
      }]
    }

---

### `refine_user_prompt`

*   **Description:** Analyzes a raw user prompt using an LLM and returns a structured, refined version for AI agent processing, including suggestions for context analysis.
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "agent_id": { "type": "string", "description": "Identifier of the AI agent (e.g., 'cline')." },
        "raw_user_prompt": { "type": "string", "description": "The raw text prompt received from the user." },
        "target_ai_persona": {
          "type": ["string", "null"],
          "description": "Optional: A suggested persona for the AI agent to adopt for the task (e.g., 'expert Python developer', 'technical writer'). This helps the refiner tailor the output.",
          "default": null
        },
        "conversation_context_ids": {
          "type": ["array", "null"],
          "items": { "type": "string" },
          "description": "Optional: Array of recent conversation_ids or context_ids that might provide immediate context for the refinement, if available to the agent.",
          "default": null
        }
      },
      "required": ["agent_id", "raw_user_prompt"]
    }
    ```
*   **Output:** Returns a structured JSON object representing the "Refined Prompt for AI".
    ```json
    {
      "content": [{
        "type": "json",
        "json": {
          "refined_prompt_id": "server_generated_uuid_for_this_refinement_instance",
          "original_prompt_text": "The exact raw user prompt text that was processed.",
          "refinement_engine_model": "gemini-2.0-flash",
          "refinement_timestamp": "YYYY-MM-DDTHH:MM:SS.sssZ",
          "overall_goal": "A clear, concise statement of the user's primary objective, as interpreted from the prompt.",
          "decomposed_tasks": [
            "Sub-task 1 identified from the prompt.",
            "Sub-task 2 identified from the prompt."
          ],
          "key_entities_identified": [
            "Entity A (e.g., filename, function name, concept)",
            "Entity B"
          ],
          "implicit_assumptions_made_by_refiner": [
            "Assuming 'the dashboard' refers to the main application dashboard."
          ],
          "explicit_constraints_from_prompt": [
            "The solution must be implemented in Python 3.9."
          ],
          "suggested_ai_role_for_agent": "Example: Act as a Senior Python Developer specializing in API security and database interactions.",
          "suggested_reasoning_strategy_for_agent": "Example: Prioritize security best practices. Analyze potential attack vectors.",
          "desired_output_characteristics_inferred": {
            "type": "Example: A fully functional Python module with accompanying unit tests.",
            "key_content_elements": [
              "Refactored Python code for user_authentication.py."
            ],
            "level_of_detail": "Example: Sufficient for another developer to understand."
          },
          "suggested_context_analysis_for_agent": [
            {
              "suggestion_type": "MEMORY_RETRIEVAL",
              "tool_to_use": "get_conversation_history",
              "parameters": {"limit": 5, "offset": 0},
              "rationale": "To understand immediate preceding dialogue for context."
            }
          ],
          "confidence_in_refinement_score": "High",
          "refinement_error_message": null
        }
      }]
    }

---

### `get_refined_prompt`

*   **Description:** Retrieves a previously stored refined prompt by its unique ID.
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "refined_prompt_id": { "type": "string", "description": "The unique ID of the refined prompt to retrieve." }
      },
      "required": ["refined_prompt_id"],
      "additionalProperties": false
    }
    ```
*   **Output:** Returns a structured JSON object representing the "Refined Prompt for AI" if found, otherwise a message indicating it was not found.
    ```json
    {
      "content": [{
        "type": "json",
        "json": {
          "refined_prompt_id": "server_generated_uuid_for_this_refinement_instance",
          "agent_id": "cline",
          "original_prompt_text": "The exact raw user prompt text that was processed.",
          "refinement_engine_model": "gemini-2.0-flash",
          "refinement_timestamp": "YYYY-MM-DDTHH:MM:SS.sssZ",
          "overall_goal": "A clear, concise statement of the user's primary objective.",
          "decomposed_tasks": [
            "Sub-task 1.",
            "Sub-task 2."
          ],
          "key_entities_identified": [
            "Entity A",
            "Entity B"
          ],
          "implicit_assumptions_made_by_refiner": [],
          "explicit_constraints_from_prompt": [],
          "suggested_ai_role_for_agent": "Example Role",
          "suggested_reasoning_strategy_for_agent": "Example Strategy",
          "desired_output_characteristics_inferred": {
            "type": "Code Solution",
            "key_content_elements": [],
            "level_of_detail": "Detailed"
          },
          "suggested_context_analysis_for_agent": [],
          "confidence_in_refinement_score": "High",
          "refinement_error_message": null
        }
      }]
    }
---

### `summarize_context`

*   **Description:** Generates a summary of stored contextual data. (Placeholder: Requires external NLP integration for full functionality).
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "agent_id": { "type": "string", "description": "Identifier of the AI agent." },
        "context_type": { "type": "string", "description": "Category of context to summarize." },
        "version": { "type": "number", "description": "Optional specific version of the context. If not provided, the latest version is summarized.", "nullable": true }
      },
      "required": ["agent_id", "context_type"]
    }
    ```
*   **Output:** Returns a text summary of the context.
    ```json
    { "content": [{ "type": "text", "text": "Summary of the context data." }] }
    ```

---

### `extract_entities`

*   **Description:** Extracts key entities and keywords from stored contextual data. (Placeholder: Requires external NLP integration for full functionality).
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "agent_id": { "type": "string", "description": "Identifier of the AI agent." },
        "context_type": { "type": "string", "description": "Category of context to extract from." },
        "version": { "type": "number", "description": "Optional specific version of the context. If not provided, the latest version is used.", "nullable": true }
      },
      "required": ["agent_id", "context_type"]
    }
    ```
*   **Output:** Returns a JSON object containing extracted entities and keywords.
    ```json
    {
      "content": [{
        "type": "json",
        "json": {
          "entities": ["entity1", "entity2"],
          "keywords": ["keyword1", "keyword2"],
          "message": "Successfully extracted entities and keywords."
        }
      }]
    }
    ```

---

### `semantic_search_context`

*   **Description:** Performs a semantic search on stored contextual data using vector embeddings. (Placeholder: Requires external embedding model integration for full functionality).
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "agent_id": { "type": "string", "description": "Identifier of the AI agent." },
        "context_type": { "type": "string", "description": "Category of context to search within." },
        "query_text": { "type": "string", "description": "The text query for semantic search." },
        "top_k": { "type": "number", "description": "Optional: Number of top similar results to return.", "default": 5, "minimum": 1 }
      },
      "required": ["agent_id", "context_type", "query_text"]
    }
    ```
*   **Output:** Returns a JSON object containing search results with similarity scores.
    ```json
    {
      "content": [{
        "type": "json",
        "json": {
          "results": [
            { "score": 0.95, "snippet": { "TITLE": "Relevant Doc", "DESCRIPTION": "...", "CODE": "..." } }
          ],
          "message": "Successfully performed semantic search."
        }
      }]
    }
    ```

---

### `refine_user_prompt`

*   **Description:** Analyzes a raw user prompt using an LLM and returns a structured, refined version for AI agent processing, including suggestions for context analysis.
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "agent_id": { "type": "string", "description": "Identifier of the AI agent (e.g., 'cline')." },
        "raw_user_prompt": { "type": "string", "description": "The raw text prompt received from the user." },
        "target_ai_persona": {
          "type": ["string", "null"],
          "description": "Optional: A suggested persona for the AI agent to adopt for the task (e.g., 'expert Python developer', 'technical writer'). This helps the refiner tailor the output.",
          "default": null
        },
        "conversation_context_ids": {
          "type": ["array", "null"],
          "items": { "type": "string" },
          "description": "Optional: Array of recent conversation_ids or context_ids that might provide immediate context for the refinement, if available to the agent.",
          "default": null
        }
      },
      "required": ["agent_id", "raw_user_prompt"]
    }
    ```
*   **Output:** Returns a structured JSON object representing the "Refined Prompt for AI".
    ```json
    {
      "content": [{
        "type": "json",
        "json": {
          "refined_prompt_id": "server_generated_uuid_for_this_refinement_instance",
          "original_prompt_text": "The exact raw user prompt text that was processed.",
          "refinement_engine_model": "gemini-2.0-flash",
          "refinement_timestamp": "YYYY-MM-DDTHH:MM:SS.sssZ",
          "overall_goal": "A clear, concise statement of the user's primary objective, as interpreted from the prompt.",
          "decomposed_tasks": [
            "Sub-task 1 identified from the prompt.",
            "Sub-task 2 identified from the prompt."
          ],
          "key_entities_identified": [
            "Entity A (e.g., filename, function name, concept)",
            "Entity B"
          ],
          "implicit_assumptions_made_by_refiner": [
            "Assuming 'the dashboard' refers to the main application dashboard."
          ],
          "explicit_constraints_from_prompt": [
            "The solution must be implemented in Python 3.9."
          ],
          "suggested_ai_role_for_agent": "Example: Act as a Senior Python Developer specializing in API security and database interactions.",
          "suggested_reasoning_strategy_for_agent": "Example: Prioritize security best practices. Analyze potential attack vectors.",
          "desired_output_characteristics_inferred": {
            "type": "Example: A fully functional Python module with accompanying unit tests.",
            "key_content_elements": [
              "Refactored Python code for user_authentication.py."
            ],
            "level_of_detail": "Example: Sufficient for another developer to understand."
          },
          "suggested_context_analysis_for_agent": [
            {
              "suggestion_type": "MEMORY_RETRIEVAL",
              "tool_to_use": "get_conversation_history",
              "parameters": {"limit": 5, "offset": 0},
              "rationale": "To understand immediate preceding dialogue for context."
            }
          ],
          "confidence_in_refinement_score": "High",
          "refinement_error_message": null
        }
      }]
    }

---

### `get_refined_prompt`

*   **Description:** Retrieves a previously stored refined prompt by its unique ID.
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "refined_prompt_id": { "type": "string", "description": "The unique ID of the refined prompt to retrieve." }
      },
      "required": ["refined_prompt_id"],
      "additionalProperties": false
    }
    ```
*   **Output:** Returns a structured JSON object representing the "Refined Prompt for AI" if found, otherwise a message indicating it was not found.
    ```json
    {
      "content": [{
        "type": "json",
        "json": {
          "refined_prompt_id": "server_generated_uuid_for_this_refinement_instance",
          "agent_id": "cline",
          "original_prompt_text": "The exact raw user prompt text that was processed.",
          "refinement_engine_model": "gemini-2.0-flash",
          "refinement_timestamp": "YYYY-MM-DDTHH:MM:SS.sssZ",
          "overall_goal": "A clear, concise statement of the user's primary objective.",
          "decomposed_tasks": [
            "Sub-task 1.",
            "Sub-task 2."
          ],
          "key_entities_identified": [
            "Entity A",
            "Entity B"
          ],
          "implicit_assumptions_made_by_refiner": [],
          "explicit_constraints_from_prompt": [],
          "suggested_ai_role_for_agent": "Example Role",
          "suggested_reasoning_strategy_for_agent": "Example Strategy",
          "desired_output_characteristics_inferred": {
            "type": "Code Solution",
            "key_content_elements": [],
            "level_of_detail": "Detailed"
          },
          "suggested_context_analysis_for_agent": [],
          "confidence_in_refinement_score": "High",
          "refinement_error_message": null
        }
      }]
    }

---

### `search_context_by_keywords`

*   **Description:** Searches stored contextual data (specifically documentation snippets) by keywords.
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "agent_id": { "type": "string", "description": "Identifier of the AI agent." },
        "context_type": { "type": "string", "description": "Category of context to search within (e.g., \"daisyui_component_creation_docs\")." },
        "keywords": { "type": "string", "description": "Keywords to search for within the documentation snippets (case-insensitive)." }
      },
      "required": ["agent_id", "context_type", "keywords"]
    }
    ```
*   **Output:** Returns a JSON array of matching documentation snippets.
    ```json
    {
      "content": [{
        "type": "json",
        "json": [
          {
            "TITLE": "Snippet Title",
            "DESCRIPTION": "Snippet description containing keywords.",
            "CODE": "console.log('example');"
          }
        ]
      }]
    }
    ```

---

### `prune_old_context`

*   **Description:** Deletes old context entries based on a specified age (in milliseconds).
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "agent_id": { "type": "string", "description": "Identifier of the AI agent." },
        "context_type": { "type": "string", "description": "Optional: Category of context to prune. If not provided, prunes all context types for the agent." },
        "max_age_ms": { "type": "number", "description": "Context entries older than this age (in milliseconds) will be deleted." }
      },
      "required": ["agent_id", "max_age_ms"]
    }
    ```
*   **Output:** Returns a text message indicating the number of deleted entries.
    ```json
    { "content": [{ "type": "text", "text": "Deleted 5 old context entries." }] }
    ```

---

### `export_data_to_csv`

*   **Description:** Exports data from a specified database table to a CSV file.
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "tableName": { "type": "string", "description": "The name of the database table to export." },
        "filePath": { "type": "string", "description": "The path where the CSV file will be saved." }
      },
      "required": ["tableName", "filePath"]
    }
    ```
*   **Output:** Returns a text message indicating success or failure.
    ```json
    { "content": [{ "type": "text", "text": "Successfully exported data from table 'conversation_history' to /path/to/file.csv" }] }
    ```

---

### `backup_database`

*   **Description:** Creates a backup copy of the SQLite database file.
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "backupFilePath": { "type": "string", "description": "The path where the database backup file will be saved." }
      },
      "required": ["backupFilePath"]
    }
    ```
*   **Output:** Returns a text message indicating success or failure.
    ```json
    { "content": [{ "type": "text", "text": "Database backed up successfully to /path/to/backup.db" }] }
    ```

---

### `restore_database`

*   **Description:** Restores the SQLite database from a specified backup file. WARNING: This will overwrite the current database.
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "backupFilePath": { "type": "string", "description": "The path to the database backup file to restore from." }
      },
      "required": ["backupFilePath"]
    }
    ```
*   **Output:** Returns a text message indicating success or failure.
    ```json
    { "content": [{ "type": "text", "text": "Database restored successfully from /path/to/backup.db" }] }
    ```
