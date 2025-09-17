import { MemoryManager } from '../database/memory_manager.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validate, schemas } from '../utils/validation.js';
import { formatSimpleMessage, formatJsonToMarkdownCodeBlock } from '../utils/formatters.js';

export const databaseManagementToolDefinitions = [
    {
        name: 'export_data_to_csv',
        description: 'Exports data from a specified database table to a CSV file. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                tableName: { type: 'string', description: 'The name of the database table to export.' },
                filePath: { type: 'string', description: 'The path where the CSV file will be saved.' }
            },
            required: ['tableName', 'filePath'],
        },
    },
    {
        name: 'backup_database',
        description: 'Creates a backup copy of the SQLite database file. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                backupFilePath: { type: 'string', description: 'The path where the database backup file will be saved.' }
            },
            required: ['backupFilePath'],
        },
    },
    {
        name: 'restore_database',
        description: 'Restores the SQLite database from a specified backup file. WARNING: This will overwrite the current database. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                backupFilePath: { type: 'string', description: 'The path to the database backup file to restore from.' }
            },
            required: ['backupFilePath'],
        },
    },
];

export function getDatabaseManagementToolHandlers(memoryManager: MemoryManager) {
    return {
        'export_data_to_csv': async (args: any) => { // agent_id is not required for this tool
            const validationResult = validate('exportDataToCsv', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool export_data_to_csv: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`
                );
            }
            const exportResult = await memoryManager.exportDataToCsv(
                args.tableName as string,
                args.filePath as string
            );
            return { content: [{ type: 'text', text: formatSimpleMessage(exportResult, "📄 CSV Export") }] };
        },
        'backup_database': async (args: any) => { // agent_id is not required for this tool
            const validationResult = validate('backupDatabase', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool backup_database: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`
                );
            }
            const backupResult = await memoryManager.backupDatabase(
                args.backupFilePath as string
            );
            return { content: [{ type: 'text', text: formatSimpleMessage(backupResult, "💽 Database Backup") }] };
        },
        'restore_database': async (args: any) => { // agent_id is not required for this tool
            const validationResult = validate('restoreDatabase', args);
            if (!validationResult.valid) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Validation failed for tool restore_database: ${formatJsonToMarkdownCodeBlock(validationResult.errors)}`
                );
            }
            const restoreResult = await memoryManager.restoreDatabase(
                args.backupFilePath as string
            );
            return { content: [{ type: 'text', text: formatSimpleMessage(restoreResult, "🔄 Database Restore") }] };
        },
    };
}
