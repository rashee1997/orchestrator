// src/database/vector_db.ts
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Define the path for the separate vector store database
// Place it alongside the main memory.db in the project root
const VECTOR_DB_PATH = process.env.VECTOR_DB_PATH || join(process.cwd(), 'vector_store.db');
const VECTOR_SCHEMA_PATH = join(__dirname, 'vector_store_schema.sql');

let vectorDbInstance: Database | null = null;

/**
 * Initializes and returns a connection to the separate vector store SQLite database.
 * Ensures the schema is applied.
 * @returns A Promise resolving to the SQLite Database object for the vector store.
 */
export async function initializeVectorStoreDatabase(): Promise<Database> {
    if (vectorDbInstance) {
        return vectorDbInstance;
    }

    const db = await open({
        filename: VECTOR_DB_PATH,
        driver: sqlite3.Database
    });

    console.log(`Vector store database opened at: ${VECTOR_DB_PATH}`);

    // Enable WAL mode for better concurrency
    await db.exec('PRAGMA journal_mode = WAL;');

    // Apply the schema
    try {
        const schema = readFileSync(VECTOR_SCHEMA_PATH, 'utf-8');
        await db.exec(schema);
        console.log('Vector store database schema applied successfully.');
    } catch (error) {
        console.error('Failed to read or apply vector store schema:', error);
        throw error; // Re-throw to prevent application from starting with a bad DB state
    }

    // Placeholder for loading sqlite-vss extension if you choose to use it:
    // try {
    //     // The method to load an extension can vary based on the sqlite3 Node.js driver version
    //     // and how sqlite-vss is compiled/distributed.
    //     // Example: (await db.getDbInstance()).loadExtension('path/to/vss0.so');
    //     // Or it might be a PRAGMA command if the extension is auto-loadable.
    //     console.log('Attempting to load sqlite-vss extension (placeholder)...');
    //     // await db.run("SELECT load_extension('path/to/your/vss0.so');"); // This path needs to be correct
    //     console.log('sqlite-vss extension loading attempted (actual loading depends on setup).');
    // } catch (extError) {
    //     console.warn('Failed to load sqlite-vss extension. Vector search might be slower or unavailable directly via SQL:', extError);
    // }

    vectorDbInstance = db;
    return db;
}

/**
 * Gets the initialized vector store database instance.
 * Throws an error if the database has not been initialized.
 * @returns The SQLite Database object for the vector store.
 */
export function getVectorStoreDb(): Database {
    if (!vectorDbInstance) {
        throw new Error('Vector store database has not been initialized. Call initializeVectorStoreDatabase() first.');
    }
    return vectorDbInstance;
}

/**
 * Closes the vector store database connection if it's open.
 */
export async function closeVectorStoreDatabase(): Promise<void> {
    if (vectorDbInstance) {
        await vectorDbInstance.close();
        vectorDbInstance = null;
        console.log('Vector store database connection closed.');
    }
}
