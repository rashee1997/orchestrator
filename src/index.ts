#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { MemoryManager } from './database/memory_manager.js';
import { validate, schemas } from './utils/validation.js';
import {
    formatTaskToMarkdown,
    formatTasksListToMarkdownTable,
    formatPlanToMarkdown,
    formatPlansListToMarkdownTable
} from './utils/formatters.js';
import { configureLoggerForEnvironment, logger } from './utils/Logger.js';

import { getAllToolDefinitions, getAllToolHandlers } from './tools/index.js';

// Configure logging based on environment
configureLoggerForEnvironment();

class MemoryMcpServer {
    private server!: Server;
    private memoryManager!: MemoryManager;
    private toolHandlers: { [key: string]: Function } = {};
    private log = logger.component('MemoryMcpServer');

    private constructor() {
        // Private constructor to enforce async factory
    }

    public static async create(): Promise<MemoryMcpServer> {
        const instance = new MemoryMcpServer();
        instance.memoryManager = await MemoryManager.create(); // Initialize asynchronously
        const toolDefinitions = await getAllToolDefinitions(instance.memoryManager);
        instance.server = new Server(
            {
                name: 'memory-mcp-server',
                version: '0.1.0',
                description: 'A Model Context Protocol server for persistent memory management in AI agents using SQLite.'
            },
            {
                capabilities: {
                    tools: toolDefinitions.reduce((acc, tool) => {
                        acc[tool.name] = tool;
                        return acc;
                    }, {} as { [key: string]: any }),
                },
            }
        );

        instance.setupToolHandlers(toolDefinitions);

        // Error handling
        instance.server.onerror = (error) => instance.log.error('MCP Server Error', {}, error);
        process.on('SIGINT', async () => {
            await instance.server.close();
            process.exit(0);
        });

        return instance;
    }

    private async setupToolHandlers(toolDefinitions: any[]) {
        this.toolHandlers = await getAllToolHandlers(this.memoryManager);

        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: toolDefinitions,
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            try {
                const { name, arguments: args } = request.params;
                const toolName = name.trim();

                if (!args) {
                    throw new McpError(
                        ErrorCode.InvalidParams,
                        `Missing arguments for tool: ${toolName}`
                    );
                }

                // Note: agent_id is required for most memory operations, but not for tavily_web_search or list_tools itself.
                // We'll handle it conditionally.
                let agent_id: string | undefined;
                if (toolName !== 'tavily_web_search' && toolName !== 'list_tools' && toolName !== 'export_data_to_csv' && toolName !== 'backup_database' && toolName !== 'restore_database') {
                    agent_id = args.agent_id as string;
                    if (!agent_id) {
                        throw new McpError(
                            ErrorCode.InvalidParams,
                            `Tool ${toolName} requires 'agent_id'.`
                        );
                    }
                }

                const handler = this.toolHandlers[toolName];
                if (!handler) {
                    throw new McpError(
                        ErrorCode.MethodNotFound,
                        `Unknown tool: ${toolName}`
                    );
                }

                // Execute the handler
                const result = await handler(args, agent_id);
                return result;

            } catch (error: any) {
                this.log.error('Tool execution failed', {
                    toolName: request.params.name,
                    errorMessage: error.message
                }, error);
                throw new McpError(
                    ErrorCode.InternalError,
                    `Failed to execute tool ${request.params.name}: ${error.message}`
                );
            }
        });
    }

    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        this.log.info('Memory MCP server running on stdio');
    }
}

const server = await MemoryMcpServer.create();
server.run().catch(error => {
    logger.component('Main').error('Failed to start server', {}, error);
    process.exit(1);
});
