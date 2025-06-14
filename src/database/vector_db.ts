// src/database/vector_db.ts
import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as os from 'os';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MCP_ROOT_PATH = path.resolve(__dirname, '../../');
console.log(`[vector_db] Determined MCP_ROOT_PATH: ${MCP_ROOT_PATH}`);

const VECTOR_DB_PATH = process.env.VECTOR_DB_PATH || path.join(MCP_ROOT_PATH, 'vector_store.db');
console.log(`[vector_db] Using VECTOR_DB_PATH: ${VECTOR_DB_PATH}`);

const VECTOR_SCHEMA_PATH = join(__dirname, 'vector_store_schema.sql');
console.log(`[vector_db] Using VECTOR_SCHEMA_PATH: ${VECTOR_SCHEMA_PATH}`);

function getSqliteVecExtensionPath(): string {
    console.log('[vector_db] Determining sqlite-vec extension path...');
    const platform = os.platform();
    const arch = os.arch();
    console.log(`[vector_db] Platform: ${platform}, Architecture: ${arch}`);

    let platformArchFolder = '';
    let extensionFile = '';

    if (platform === 'win32') {
        platformArchFolder = `sqlite-vec-windows-${arch}`;
        extensionFile = 'vec0.dll';
    } else if (platform === 'linux') {
        platformArchFolder = `sqlite-vec-linux-${arch}`;
        extensionFile = 'vec0.so';
    } else if (platform === 'darwin') {
        platformArchFolder = `sqlite-vec-darwin-${arch}`;
        extensionFile = 'vec0.dylib';
    } else {
        console.error(`[vector_db] Unsupported platform for sqlite-vec: ${platform}`);
        throw new Error(`Unsupported platform for sqlite-vec: ${platform}`);
    }
    console.log(`[vector_db] Expected extension folder: ${platformArchFolder}, Expected file: ${extensionFile}`);

    const primaryExtensionPath = path.join(MCP_ROOT_PATH, 'node_modules', platformArchFolder, extensionFile);
    console.log(`[vector_db] Checking primary extension path: ${primaryExtensionPath}`);

    if (existsSync(primaryExtensionPath)) {
        console.log(`[vector_db] Found sqlite-vec extension at primary path: ${primaryExtensionPath}`);
        return primaryExtensionPath;
    }
    console.warn(`[vector_db] sqlite-vec extension not found at primary path: ${primaryExtensionPath}.`);

    const fallbackPaths = [
        path.join(MCP_ROOT_PATH, 'node_modules', 'sqlite-vec', 'build', 'Release', extensionFile),
        path.join(MCP_ROOT_PATH, 'node_modules', '.bin', extensionFile),
    ];

    if (platform === 'win32' && arch === 'x64') {
        fallbackPaths.push(path.join(MCP_ROOT_PATH, 'node_modules/sqlite-vec-windows-x64/vec0.dll'));
    }

    for (const fallbackPath of fallbackPaths) {
        console.log(`[vector_db] Checking fallback extension path: ${fallbackPath}`);
        if (existsSync(fallbackPath)) {
            console.warn(`[vector_db] Found sqlite-vec extension at fallback path: ${fallbackPath}`);
            return fallbackPath;
        }
    }

    console.error(`[vector_db] sqlite-vec extension binary not found at primary path or any fallback paths. Please check your sqlite-vec installation and node_modules structure.`);
    throw new Error(`sqlite-vec extension binary not found. Primary path attempted: ${primaryExtensionPath}`);
}

const SQLITE_VEC_EXTENSION_PATH = getSqliteVecExtensionPath();
console.log(`[vector_db] Final SQLITE_VEC_EXTENSION_PATH: ${SQLITE_VEC_EXTENSION_PATH}`);

let vectorDbInstance: Database | null = null;

export async function initializeVectorStoreDatabase(): Promise<Database> {
    console.log('[vector_db] Initializing vector store database...');
    if (vectorDbInstance) {
        console.log('[vector_db] Vector store database instance already exists. Returning existing instance.');
        return vectorDbInstance;
    }

    let db: Database | undefined;
    try {
        db = new Database(VECTOR_DB_PATH, { fileMustExist: false });
        console.log(`[vector_db] Vector store database opened successfully at: ${VECTOR_DB_PATH}`);

        console.log('[vector_db] Attempting to load vec extension...');
        db.loadExtension(SQLITE_VEC_EXTENSION_PATH);
        console.log(`[vector_db] Successfully loaded vec extension from ${SQLITE_VEC_EXTENSION_PATH}`);
    } catch (extSetupError) {
        console.error(`[vector_db] CRITICAL: Error during extension setup: `, extSetupError);
        if (db) {
            try {
                db.close();
            } catch (closeError) {
                console.error('[vector_db] Error closing DB after extension setup failure:', closeError);
            }
        }
        throw extSetupError;
    }

    try {
        db.pragma('journal_mode = WAL');
        console.log('[vector_db] WAL mode enabled.');
    } catch (walError) {
        console.error('[vector_db] Failed to enable WAL mode:', walError);
    }

    try {
        console.log(`[vector_db] Reading vector store schema from: ${VECTOR_SCHEMA_PATH}`);
        const schema = readFileSync(VECTOR_SCHEMA_PATH, 'utf-8');
        console.log('[vector_db] Applying vector store database schema...');
        db.exec(schema);
        console.log('[vector_db] Vector store database schema applied successfully.');

        // Create vec virtual table if not exists
        console.log('[vector_db] Creating vec virtual table if not exists...');
        db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS codebase_embeddings_vec_idx USING vec0(
                embedding_id TEXT,
                embedding float[768]
            );
        `);
        console.log('[vector_db] vec virtual table created or already exists.');
    } catch (error) {
        console.error('[vector_db] CRITICAL: Failed to read or apply vector store schema or create vec virtual table:', error);
        try {
            db.close();
        } catch (closeError) {
            console.error('[vector_db] Error closing DB after schema or VSS failure:', closeError);
        }
        throw error;
    }

    vectorDbInstance = db;
    console.log('[vector_db] Vector store database initialization complete.');
    return db;
}

export function getVectorStoreDb(): Database {
    console.log('[vector_db] getVectorStoreDb called.');
    if (!vectorDbInstance) {
        console.error('[vector_db] FATAL: Vector store database has not been initialized. Call initializeVectorStoreDatabase() first.');
        throw new Error('Vector store database has not been initialized. Call initializeVectorStoreDatabase() first.');
    }
    console.log('[vector_db] Returning existing vectorDbInstance.');
    return vectorDbInstance;
}

export async function closeVectorStoreDatabase(): Promise<void> {
    console.log('[vector_db] closeVectorStoreDatabase called.');
    if (vectorDbInstance) {
        try {
            vectorDbInstance.close();
            vectorDbInstance = null;
            console.log('[vector_db] Vector store database connection closed successfully.');
        } catch (error) {
            console.error('[vector_db] Error closing vector store database connection:', error);
        }
    } else {
        console.log('[vector_db] Vector store database connection already closed or not initialized.');
    }
}

export function storeVecEmbedding(embedding_id: string, vector: number[], tableName: string = 'codebase_embeddings_vec_idx'): void {
    console.log(`[vector_db] Storing vector embedding with ID: ${embedding_id} in table: ${tableName}`);
    const db = getVectorStoreDb();
    const vectorString = `[${vector.join(',')}]`;
    try {
        db.prepare(
            `INSERT OR REPLACE INTO ${tableName} (embedding_id, embedding) VALUES (?, ?);`
        ).run(embedding_id, vectorString);
        console.log(`[vector_db] Successfully stored vector for ID: ${embedding_id}`);

        // Add a read-back check immediately after insertion
        const checkStmt = db.prepare(`SELECT embedding_id FROM ${tableName} WHERE embedding_id = ?;`);
        const checkResult = checkStmt.get(embedding_id);
        if (checkResult) {
            console.log(`[vector_db] Read-back successful: Embedding with ID ${checkResult.embedding_id} found immediately after insertion.`);
        } else {
            console.error(`[vector_db] Read-back FAILED: Embedding with ID ${embedding_id} NOT found immediately after insertion.`);
        }

    } catch (error) {
        console.error(`[vector_db] Error storing vector for ID ${embedding_id} in table ${tableName}:`, error);
        throw error;
    }
}

export async function findSimilarVecEmbeddings(queryVector: number[], topK: number = 5, tableName: string = 'codebase_embeddings_vec_idx'): Promise<Array<{ embedding_id: string, similarity: number }>> {
    console.log(`[vector_db] Finding similar vector embeddings using vec virtual table in table: ${tableName}, topK: ${topK}`);
    const db = getVectorStoreDb();
    const vectorString = `[${queryVector.join(',')}]`;

    try {
        // Use the vec virtual table for similarity search
        const stmt = db.prepare(
            `SELECT embedding_id, distance FROM ${tableName} WHERE embedding MATCH ? ORDER BY distance LIMIT ?;`
        );
        const results = stmt.all(vectorString, topK);

        // Convert distance to similarity (1 - distance for cosine similarity, assuming normalized vectors)
        return results.map(row => ({
            embedding_id: row.embedding_id,
            similarity: 1 - row.distance,
        }));
    } catch (error) {
        console.error(`[vector_db] Error finding similar vector embeddings using vec virtual table in table ${tableName}:`, error);
        throw error;
    }
}
