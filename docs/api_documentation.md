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

### `add_reference_key`

*   **Description:** Adds a reference key to an external knowledge source or internal memory entry.
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "agent_id": { "type": "string", "description": "Identifier of the AI agent." },
        "key_type": { "type": "string", "description": "Type of reference (e.g., document_id, memory_entry_id, external_api_id)." },
        "key_value": { "type": "string", "description": "The actual key/identifier." },
        "description": { "type": "string", "description": "Human-readable description of what the key references.", "nullable": true },
        "associated_conversation_id": { "type": "string", "description": "Optional, link to conversation.", "nullable": true }
      },
      "required": ["agent_id", "key_type", "key_value"]
    }
    ```
*   **Output:** Returns a text message with the generated `reference_id`.

---

### `get_reference_keys`

*   **Description:** Retrieves reference keys for a given agent, optionally filtered by key type.
*   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "agent_id": { "type": "string", "description": "Identifier of the AI agent." },
        "key_type": { "type": "string", "description": "Optional type of reference to filter by.", "nullable": true },
        "limit": { "type": "number", "description": "Maximum number of keys to retrieve.", "default": 100 },
        "offset": { "type": "number", "description": "Offset for pagination.", "default": 0 }
      },
      "required": ["agent_id"]
    }
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
