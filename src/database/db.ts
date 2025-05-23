import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = join(__dirname, '../../memory.db');
const SCHEMA_PATH = join(__dirname, 'database', 'schema.sql');

export async function initializeDatabase() {
    const db = await open({
        filename: DB_PATH,
        driver: sqlite3.Database
    });

    // Enable WAL mode for better concurrency and crash recovery
    await db.exec('PRAGMA journal_mode = WAL;');

    const schema = readFileSync(SCHEMA_PATH, 'utf-8');
    await db.exec(schema);
    console.log('Database initialized and schema applied.');
    return db;
}

export async function getDatabase() {
    return open({
        filename: DB_PATH,
        driver: sqlite3.Database
    });
}
