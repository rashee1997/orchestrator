import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = join(__dirname, '../../memory.db');
const SCHEMA_PATH = join(__dirname, 'schema.sql');

export async function initializeDatabase() {
    const db = await open({
        filename: DB_PATH,
        driver: sqlite3.Database
    });

    // Enable WAL mode for better concurrency and crash recovery
    await db.exec('PRAGMA journal_mode = WAL;');
    // Enable foreign key constraints for cascade deletes
    await db.exec('PRAGMA foreign_keys = ON;');

    const schema = readFileSync(SCHEMA_PATH, 'utf-8');
    await db.exec(schema);
    console.log('Database initialized and schema applied.');

    // Insert default agent 'cline' if not exists
    await db.run(
        `INSERT OR IGNORE INTO agents (agent_id, name, description, creation_timestamp) VALUES (?, ?, ?, ?)`,
        'cline', 'Cline', 'AI coding agent', Math.floor(Date.now() / 1000)
    );
    console.log('Default agent "cline" ensured in database.');

    return db;
}

export async function getDatabase() {
    return open({
        filename: DB_PATH,
        driver: sqlite3.Database
    });
}
