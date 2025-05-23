import { DatabaseService } from '../services/DatabaseService.js';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

export class DatabaseUtilityService {
    private dbService: DatabaseService;

    constructor(dbService: DatabaseService) {
        this.dbService = dbService;
    }

    async exportDataToCsv(tableName: string, filePath: string) {
        const db = this.dbService.getDb();
        try {
            const rows = await db.all(`SELECT * FROM ${tableName}`);
            if (rows.length === 0) {
                await fsp.writeFile(filePath, ''); // Create empty file if no data
                return `No data found in table '${tableName}'. Created empty CSV file at ${filePath}`;
            }

            const headers = Object.keys(rows[0]);
            const csvRows = [
                headers.join(','), // Header row
                ...rows.map((row: any) =>
                    headers.map(header => {
                        let value = row[header];
                        if (typeof value === 'string') {
                            // Escape double quotes and wrap in double quotes if it contains comma or double quote
                            value = value.replace(/"/g, '""');
                            if (value.includes(',') || value.includes('\n')) {
                                value = `"${value}"`;
                            }
                        } else if (value === null || value === undefined) {
                            value = '';
                        } else if (typeof value === 'object') {
                            value = JSON.stringify(value).replace(/"/g, '""');
                            value = `"${value}"`;
                        }
                        return value;
                    }).join(',')
                )
            ];

            await fsp.writeFile(filePath, csvRows.join('\n'));
            return `Successfully exported data from table '${tableName}' to ${filePath}`;
        } catch (error: any) {
            console.error(`Error exporting data to CSV from table ${tableName}:`, error);
            throw new Error(`Failed to export data to CSV: ${error.message}`);
        }
    }

    async backupDatabase(backupFilePath: string) {
        const dbPath = 'c:/Users/user/Dropbox/PC/Documents/Cline/MCP/memory-mcp-server/memory.db'; // Use hardcoded absolute path
        try {
            await fsp.copyFile(dbPath, backupFilePath);
            return `Database backed up successfully to ${backupFilePath}`;
        } catch (error: any) {
            console.error(`Error backing up database to ${backupFilePath}:`, error);
            throw new Error(`Failed to backup database: ${error.message}`);
        }
    }

    async restoreDatabase(backupFilePath: string) {
        const dbPath = 'c:/Users/user/Dropbox/PC/Documents/Cline/MCP/memory-mcp-server/memory.db'; // Use hardcoded absolute path
        try {
            if (!fs.existsSync(backupFilePath)) {
                throw new Error(`Backup file not found at ${backupFilePath}`);
            }

            await fsp.copyFile(backupFilePath, dbPath);
            // Re-initialize the database connection after restoring
            // This assumes initializeDatabase can handle re-opening an existing DB.
            // This part will need to be handled by the MemoryManager orchestrator
            return `Database restored successfully from ${backupFilePath}`;
        } catch (error: any) {
            console.error(`Error restoring database from ${backupFilePath}:`, error);
            throw new Error(`Failed to restore database: ${error.message}`);
        }
    }
}
