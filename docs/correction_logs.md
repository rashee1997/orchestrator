# Correction Logs

This document describes the `correction_logs` functionality within the Memory MCP Server, which records instances where an AI agent's output or internal state was corrected. This logging is essential for debugging, auditing, and facilitating continuous learning and improvement of AI agents.

## Purpose

The `correction_logs` table and associated tools (`log_correction`, `get_correction_logs`) are designed to:

*   Track deviations from expected agent behavior or output.
*   Record manual corrections made by users or system administrators.
*   Log automatic corrections applied by the system (e.g., data validation failures).
*   Provide data for post-hoc analysis to identify patterns of errors and areas for agent training or model fine-tuning.

## Schema (`correction_logs` table)

| Column Name         | Type      | Description                                                              |
| :------------------ | :-------- | :----------------------------------------------------------------------- |
| `correction_id`     | `TEXT`    | Unique identifier for each correction entry (UUID).                      |
| `agent_id`          | `TEXT`    | Identifier of the AI agent whose state or output was corrected.          |
| `timestamp`         | `INTEGER` | Unix timestamp (milliseconds) when the correction occurred.              |
| `correction_type`   | `TEXT`    | Type of correction (e.g., `user_feedback`, `self_correction`, `system_override`, `data_validation_failure`). |
| `original_entry_id` | `TEXT`    | Optional ID of the memory entry that was corrected (e.g., `conversation_id`, `context_id`). Can be `NULL`. |
| `original_value`    | `TEXT`    | JSON string of the original data before correction. Can be `NULL`.       |
| `corrected_value`   | `TEXT`    | JSON string of the corrected data. Can be `NULL`.                        |
| `reason`            | `TEXT`    | Explanation for the correction. Can be `NULL`.                           |
| `applied_automatically` | `BOOLEAN` | `TRUE` if the correction was applied automatically by the system; `FALSE` if manual. |

## Usage

### `log_correction` Tool

This tool is used to log a correction event.

**Input Schema:**

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

**Example Call:**

```xml
<use_mcp_tool>
<server_name>memory-mcp-server</server_name>
<tool_name>log_correction</tool_name>
<arguments>
{
  "agent_id": "my-ai-agent-001",
  "correction_type": "user_feedback",
  "original_entry_id": "conv-123",
  "original_value": { "message": "Incorrect response." },
  "corrected_value": { "message": "Corrected response." },
  "reason": "User indicated the previous response was factually incorrect.",
  "applied_automatically": false
}
</arguments>
</use_mcp_tool>
```

### `get_correction_logs` Tool

This tool is used to retrieve logged correction events.

**Input Schema:**

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

**Example Call:**

```xml
<use_mcp_tool>
<server_name>memory-mcp-server</server_name>
<tool_name>get_correction_logs</tool_name>
<arguments>
{
  "agent_id": "my-ai-agent-001",
  "correction_type": "data_validation_failure",
  "limit": 20
}
</arguments>
</use_mcp_tool>
