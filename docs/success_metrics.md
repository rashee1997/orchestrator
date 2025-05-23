# Success Metrics

This document outlines the structure and purpose of success metrics logged by the Memory MCP Server. These metrics are vital for evaluating AI agent performance, understanding task completion rates, and assessing overall system effectiveness.

## Purpose

The `success_metrics` table and associated tools (`log_success_metric`, `get_success_metrics`) are designed to:

*   Collect quantitative and qualitative data on agent performance.
*   Track key performance indicators (KPIs) related to agent tasks and interactions.
*   Enable analysis of agent efficiency, accuracy, and user satisfaction.
*   Support continuous improvement and optimization of AI agents.

## Schema (`success_metrics` table)

| Column Name        | Type      | Description                                                              |
| :----------------- | :-------- | :----------------------------------------------------------------------- |
| `metric_id`        | `TEXT`    | Unique identifier for each metric entry (UUID).                          |
| `agent_id`         | `TEXT`    | Identifier of the AI agent to which the metric applies.                  |
| `timestamp`        | `INTEGER` | Unix timestamp (milliseconds) when the metric was recorded.              |
| `metric_name`      | `TEXT`    | Name of the metric (e.g., `task_completion_rate`, `response_latency_ms`, `user_satisfaction_score`, `tool_use_success_rate`). |
| `metric_value`     | `REAL`    | The numerical value of the metric.                                       |
| `unit`             | `TEXT`    | Unit of the metric (e.g., `percent`, `ms`, `score`). Can be `NULL`.    |
| `associated_task_id` | `TEXT`    | Optional identifier for a specific task or conversation this metric relates to. Can be `NULL`. |
| `metadata`         | `TEXT`    | JSON string for additional metric-specific data (e.g., `{"model_version": "v2.1"}`). Can be `NULL`. |

## Usage

### `log_success_metric` Tool

This tool is used by AI agents or system components to log performance and success metrics.

**Input Schema:**

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

**Example Call:**

```xml
<use_mcp_tool>
<server_name>memory-mcp-server</server_name>
<tool_name>log_success_metric</tool_name>
<arguments>
{
  "agent_id": "my-ai-agent-001",
  "metric_name": "task_completion_rate",
  "metric_value": 0.95,
  "unit": "percent",
  "associated_task_id": "task-abc",
  "metadata": {
    "model_version": "v1.0",
    "environment": "production"
  }
}
</arguments>
</use_mcp_tool>
```

### `get_success_metrics` Tool

This tool is used to retrieve logged success metrics.

**Input Schema:**

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

**Example Call:**

```xml
<use_mcp_tool>
<server_name>memory-mcp-server</server_name>
<tool_name>get_success_metrics</tool_name>
<arguments>
{
  "agent_id": "my-ai-agent-001",
  "metric_name": "response_latency_ms",
  "limit": 50
}
</arguments>
</use_mcp_tool>
