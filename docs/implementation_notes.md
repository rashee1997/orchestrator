# Implementation Notes

This document provides detailed notes on the internal implementation choices, design patterns, and any non-obvious aspects of the Memory MCP Server codebase. It serves as a guide for developers maintaining or extending the server.

## Project Structure

The project follows a modular structure to separate concerns:

*   `src/database/`: Contains all database-related logic, including schema definition (`schema.sql`), database initialization and connection management (`db.ts`), and core CRUD operations for memory types (`memory_manager.ts`).
*   `src/integrations/`: Houses logic for external service integrations, such as Tavily search (`tavily.ts`).
*   `src/utils/`: Provides utility functions, currently for JSON schema validation (`validation.ts`).
*   `src/index.ts`: The main entry point for the MCP server, responsible for setting up the server, defining MCP tools, and handling tool calls.

## Database Management (`src/database/`)

### SQLite Connection

*   The `db.ts` module uses the `sqlite` package (a promise-based wrapper for `sqlite3`) for asynchronous database operations.
*   A single database file, `memory.db`, is created in the root of the `memory-mcp-server` directory.
*   **WAL (Write-Ahead Logging) Mode:** The database is configured to use `PRAGMA journal_mode = WAL;` upon initialization. This enhances concurrency by allowing readers to continue operating while a writer is active, and improves crash recovery.
*   `initializeDatabase()`: Ensures the database file exists and applies the `schema.sql`.
*   `getDatabase()`: Provides a way to get a database connection instance. It's designed to reuse the connection if already open, or open a new one if needed.

### MemoryManager Class

*   The `MemoryManager` class in `memory_manager.ts` encapsulates all CRUD (Create, Read, Update, Delete) operations for the various memory types.
*   **UUIDs for IDs:** `crypto.randomUUID()` is used to generate unique identifiers for all primary keys (`conversation_id`, `context_id`, etc.), ensuring global uniqueness.
*   **Timestamping:** `Date.now()` is used to record Unix timestamps in milliseconds for all relevant entries.
*   **JSON Stringification:** Fields designed to store structured data (e.g., `context_data`, `tool_info`, `metadata`, `original_value`, `corrected_value`) are stored as `TEXT` in SQLite and are JSON stringified before insertion and parsed after retrieval. This allows flexible schema-less storage within a structured relational database.
*   **Context Versioning:** The `storeContext` method includes logic to automatically increment the `version` for a given `agent_id` and `context_type`, allowing for historical tracking of context changes.
*   **Query Optimization:** All queries use parameterized statements (`?` placeholders) to prevent SQL injection vulnerabilities and allow SQLite to cache query plans, improving performance. Indexes are defined in `schema.sql` to speed up common lookup operations.

## Integrations (`src/integrations/`)

### Tavily Search

*   The `tavily.ts` module integrates with the Tavily API using the `@tavily/core` npm package.
*   The Tavily API key is expected via the `TAVILY_API_KEY` environment variable. If not set, a warning is logged, and search functionality is disabled.
*   `performTavilySearch()`: This function handles the actual API call to Tavily and automatically logs the search query and a summary of results into the `source_attribution` table via the `MemoryManager`.
*   Error handling for Tavily API calls is included, logging failures to `correction_logs`.

## Utilities (`src/utils/`)

### JSON Schema Validation

*   The `validation.ts` module uses the `ajv` (Another JSON Schema Validator) library to enforce data integrity.
*   `ajv` is configured with `allErrors: true` to collect all validation errors.
*   Predefined JSON schemas for each memory type's input data are exported in `schemas`.
*   The `validate(schemaName, data)` function provides a centralized way to validate incoming data against the defined schemas. This is used in `index.ts` before processing tool arguments.

## MCP Server Core (`src/index.ts`)

*   **Server Setup:** Initializes the `Server` from `@modelcontextprotocol/sdk/server` with a unique name, version, and description.
*   **Tool Exposure:** All memory management operations (CRUD for each type, plus Tavily search) are exposed as distinct MCP tools. Each tool has a clearly defined `name`, `description`, and `inputSchema` (JSON Schema) to guide client usage.
*   **Tool Handlers:** The `CallToolRequestSchema` handler uses a `switch` statement to route incoming tool calls to the appropriate `MemoryManager` or `performTavilySearch` function.
*   **Centralized Error Handling:** A `try-catch` block wraps the tool execution logic. Errors are caught, logged to `console.error`, and then re-thrown as `McpError` instances with appropriate `ErrorCode` values (`InvalidParams`, `InternalError`, `MethodNotFound`) to provide structured error feedback to the MCP client.
*   **`MemoryManager` Instance:** A single instance of `MemoryManager` is created and reused across all tool handlers to manage database connections efficiently.

## Future Considerations / Known Limitations

*   **Authentication/Authorization:** The current server does not implement any authentication or authorization mechanisms. All tool calls are assumed to be from trusted sources. For production environments, this would need to be added (e.g., API keys, token validation).
*   **Data Deletion:** While CRUD operations include delete methods, a comprehensive data retention policy or automated cleanup mechanism is not implemented.
*   **Scalability:** SQLite is excellent for embedded and single-process applications. For highly concurrent or distributed AI agent systems, a more robust database solution (e.g., PostgreSQL, MongoDB) might be considered, which would require significant changes to the `database` module.
*   **Resource Exposure:** Currently, only tools are exposed. Read-only memory views could also be exposed as MCP resources if needed for direct data access without tool calls.
*   **Migration Protocols:** Basic schema application is handled, but a robust, incremental database migration system (e.g., using a dedicated migration library) is not yet implemented.
