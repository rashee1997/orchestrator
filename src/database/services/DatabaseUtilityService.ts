import { DatabaseService } from '../services/DatabaseService.js';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Helper to get __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define the database path relative to this file's location
// Assuming this file is in src/database/services/ and memory.db is at the root of the project.
const DB_PATH = path.join(__dirname, '../../../memory.db');


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
                await fsp.writeFile(filePath, ''); 
                return `No data found in table '${tableName}'. Created empty CSV file at ${filePath}`;
            }

            const headers = Object.keys(rows[0]);
            const csvRows = [
                headers.join(','), 
                ...rows.map((row: any) =>
                    headers.map(header => {
                        let value = row[header];
                        if (typeof value === 'string') {
                            value = value.replace(/"/g, '""');
                            if (value.includes(',') || value.includes('\n') || value.includes('"')) { // Added check for double quote
                                value = `"${value}"`;
                            }
                        } else if (value === null || value === undefined) {
                            value = '';
                        } else if (typeof value === 'object') {
                            // Stringify the object, then escape quotes and wrap
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
        // Use the DB_PATH defined at the top of the file
        try {
            if (!fs.existsSync(DB_PATH)) {
                throw new Error(`Source database file not found at ${DB_PATH}`);
            }
            await fsp.copyFile(DB_PATH, backupFilePath);
            return `Database backed up successfully from ${DB_PATH} to ${backupFilePath}`;
        } catch (error: any) {
            console.error(`Error backing up database to ${backupFilePath}:`, error);
            throw new Error(`Failed to backup database: ${error.message}`);
        }
    }

    async restoreDatabase(backupFilePath: string) {
        // Use the DB_PATH defined at the top of the file
        try {
            if (!fs.existsSync(backupFilePath)) {
                throw new Error(`Backup file not found at ${backupFilePath}`);
            }

            const currentDb = this.dbService.getDb();
            if (currentDb && typeof (currentDb as any).close === 'function') {
                 await (currentDb as any).close();
                 console.log('Database connection closed before restore.');
            }

            await fsp.copyFile(backupFilePath, DB_PATH);
            
            console.log(`Database restored successfully from ${backupFilePath} to ${DB_PATH}. Application may need to re-initialize database connections.`);
            
            // Placeholder for re-initialization logic.
            // Example: if (this.dbService.reinitialize) { await this.dbService.reinitialize(); }
            // This depends on the structure of DatabaseService and how the main application handles DB connections.

            return `Database restored successfully from ${backupFilePath} to ${DB_PATH}. Please ensure database connections are re-initialized.`;
        } catch (error: any) { // Completed catch block
            console.error(`Error restoring database from ${backupFilePath}:`, error);
            throw new Error(`Failed to restore database: ${error.message}`);
        }
    }
}
