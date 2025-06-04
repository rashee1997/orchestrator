// src/database/vector_db.ts
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
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

// Promisify helper for sqlite3 driver's callback-based methods
function promisifyDriverMethod(driver: any, methodName: 'enableLoadExtension' | 'loadExtension', ...args: any[]): Promise<void> {
    return new Promise((resolve, reject) => {
        // Check if the method exists before calling
        if (typeof driver[methodName] !== 'function') {
            return reject(new Error(`Method ${methodName} not found on sqlite3 driver instance.`));
        }
        driver[methodName](...args, (err: Error | null) => {
            if (err) {
                console.error(`[vector_db] Error in promisified ${methodName}:`, err);
                reject(err);
            } else {
                resolve();
            }
        });
    });
}


export async function initializeVectorStoreDatabase(): Promise<Database> {
    console.log('[vector_db] Initializing vector store database...');
    if (vectorDbInstance) {
        console.log('[vector_db] Vector store database instance already exists. Returning existing instance.');
        return vectorDbInstance;
    }

    console.log(`[vector_db] Opening database at: ${VECTOR_DB_PATH}`);
    const db = await open({
        filename: VECTOR_DB_PATH,
        driver: sqlite3.Database
    });
    console.log(`[vector_db] Vector store database opened successfully at: ${VECTOR_DB_PATH}`);

    // Access the underlying sqlite3.Database instance
    const driverInstance = db.db as any; // sqlite.Database.driver is the sqlite3.Database

    if (driverInstance) {
        try {
            if (typeof driverInstance.enableLoadExtension === 'function') {
                console.log('[vector_db] Attempting to enable SQLite extension loading on db.db...');
                await promisifyDriverMethod(driverInstance, 'enableLoadExtension', true);
                console.log('[vector_db] Successfully enabled SQLite extension loading on db.db.');
            } else {
                console.warn('[vector_db] Warning: enableLoadExtension method not found on sqlite3 driver instance. Skipping enableLoadExtension.');
            }

            if (typeof driverInstance.loadExtension === 'function') {
                console.log(`[vector_db] Attempting to load vec extension on db.db from: ${SQLITE_VEC_EXTENSION_PATH}`);
                await promisifyDriverMethod(driverInstance, 'loadExtension', SQLITE_VEC_EXTENSION_PATH);
                console.log(`[vector_db] Successfully loaded vec extension on db.db from ${SQLITE_VEC_EXTENSION_PATH}`);
            } else {
                console.warn('[vector_db] Warning: loadExtension method not found on sqlite3 driver instance. Skipping loadExtension.');
            }
        } catch (extSetupError) {
            console.error(`[vector_db] CRITICAL: Error during extension setup on db.db: `, extSetupError);
            // Close DB if critical extension setup fails
            try {
                await db.close();
            } catch (closeError) {
                console.error('[vector_db] Error closing DB after extension setup failure:', closeError);
            }
            throw extSetupError; // Re-throw to prevent application from starting with a bad DB state
        }
    } else {
        const errMsg = '[vector_db] CRITICAL: Could not access the underlying sqlite3 driver instance (db.db). Extension loading failed.';
        console.error(errMsg);
        try {
            await db.close();
        } catch (closeError) {
            console.error('[vector_db] Error closing DB after driver access failure:', closeError);
        }
        throw new Error(errMsg);
    }

    try {
        await db.exec('PRAGMA journal_mode = WAL;');
        console.log('[vector_db] WAL mode enabled.');
    } catch (walError) {
        console.error('[vector_db] Failed to enable WAL mode:', walError);
    }

    try {
        console.log(`[vector_db] Reading vector store schema from: ${VECTOR_SCHEMA_PATH}`);
        const schema = readFileSync(VECTOR_SCHEMA_PATH, 'utf-8');
        console.log('[vector_db] Applying vector store database schema...');
        await db.exec(schema);
        console.log('[vector_db] Vector store database schema applied successfully.');
    } catch (error) {
        console.error('[vector_db] CRITICAL: Failed to read or apply vector store schema:', error);
        try {
            await db.close();
        } catch (closeError) {
            console.error('[vector_db] Error closing DB after schema failure:', closeError);
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
            await vectorDbInstance.close();
            vectorDbInstance = null;
            console.log('[vector_db] Vector store database connection closed successfully.');
        } catch (error) {
            console.error('[vector_db] Error closing vector store database connection:', error);
        }
    } else {
        console.log('[vector_db] Vector store database connection already closed or not initialized.');
    }
}

export async function storeVecEmbedding(embedding_id: string, vector: number[], tableName: string = 'codebase_embeddings_vec'): Promise<void> {
    console.log(`[vector_db] Storing vector embedding with ID: ${embedding_id} in table: ${tableName}`);
    const db = getVectorStoreDb();
    const floatVec = new Float32Array(vector);
    try {
        await db.run(
            `INSERT OR REPLACE INTO ${tableName} (embedding_id, vector) VALUES (?, ?);`,
            embedding_id,
            Buffer.from(floatVec.buffer)
        );
        console.log(`[vector_db] Successfully stored vector for ID: ${embedding_id}`);
    } catch (error) {
        console.error(`[vector_db] Error storing vector for ID ${embedding_id} in table ${tableName}:`, error);
        throw error;
    }
}

export async function findSimilarVecEmbeddings(queryVector: number[], topK: number = 5, tableName: string = 'codebase_embeddings_vec'): Promise<Array<{ embedding_id: string, similarity: number }>> {
    console.log(`[vector_db] Finding similar vector embeddings in table: ${tableName}, topK: ${topK}`);
    const db = getVectorStoreDb();
    const floatVec = new Float32Array(queryVector);

    function cosineSimilarity(vecA: Float32Array, vecB: Float32Array): number {
        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dot += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    try {
        const rows = await db.all(`SELECT embedding_id, vector FROM ${tableName};`);
        console.log(`[vector_db] Retrieved ${rows.length} embeddings from DB for similarity computation.`);

        const similarities = rows.map(row => {
            const storedVec = new Float32Array(row.vector.buffer);
            const similarity = cosineSimilarity(floatVec, storedVec);
            return {
                embedding_id: row.embedding_id,
                similarity,
            };
        });

        similarities.sort((a, b) => b.similarity - a.similarity);

        return similarities.slice(0, topK);
    } catch (error) {
        console.error(`[vector_db] Error finding similar vector embeddings in table ${tableName}:`, error);
        throw error;
    }
}
