import * as fs from 'fs';

// src/database/vector_db.ts
import Database from 'better-sqlite3';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import * as os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MCP_ROOT_PATH = resolve(__dirname, '../../');
console.log(`[vector_db] Determined MCP_ROOT_PATH: ${MCP_ROOT_PATH}`);

const VECTOR_DB_PATH = process.env.VECTOR_DB_PATH || join(MCP_ROOT_PATH, 'vector_store.db');
console.log(`[vector_db] Using VECTOR_DB_PATH: ${VECTOR_DB_PATH}`);

const VECTOR_SCHEMA_PATH = join(__dirname, 'vector_store_schema.sql');
console.log(`[vector_db] Using VECTOR_SCHEMA_PATH: ${VECTOR_SCHEMA_PATH}`);

const BACKUP_DIR = join(MCP_ROOT_PATH, 'backups');
const MAX_BACKUPS = 5;

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

    const possiblePaths = [
        join(MCP_ROOT_PATH, 'node_modules', platformArchFolder, extensionFile),
        join(MCP_ROOT_PATH, 'node_modules', 'sqlite-vec', 'build', 'Release', extensionFile),
        join(MCP_ROOT_PATH, 'node_modules', '.bin', extensionFile),
    ];

    // Add platform-specific fallback paths
    if (platform === 'win32' && arch === 'x64') {
        possiblePaths.push(join(MCP_ROOT_PATH, 'node_modules/sqlite-vec-windows-x64/vec0.dll'));
    }

    for (const path of possiblePaths) {
        console.log(`[vector_db] Checking extension path: ${path}`);
        if (existsSync(path)) {
            console.log(`[vector_db] Found sqlite-vec extension at: ${path}`);
            return path;
        }
    }

    console.error(`[vector_db] sqlite-vec extension binary not found. Attempted paths:`, possiblePaths);
    throw new Error(`sqlite-vec extension binary not found. Please ensure sqlite-vec is properly installed.`);
}

const SQLITE_VEC_EXTENSION_PATH = getSqliteVecExtensionPath();
console.log(`[vector_db] Final SQLITE_VEC_EXTENSION_PATH: ${SQLITE_VEC_EXTENSION_PATH}`);

let vectorDbInstance: Database | null = null;
let initializationPromise: Promise<Database> | null = null;

export async function initializeVectorStoreDatabase(): Promise<Database> {
    if (vectorDbInstance) {
        console.log('[vector_db] Vector store database instance already exists. Returning existing instance.');
        return vectorDbInstance;
    }

    if (initializationPromise) {
        console.log('[vector_db] Vector store database initialization in progress. Waiting...');
        return initializationPromise;
    }

    initializationPromise = (async () => {
        let db: Database | undefined;
        let needsInitialization = false;

        try {
            // Check if database file exists
            const dbExists = existsSync(VECTOR_DB_PATH);

            db = new Database(VECTOR_DB_PATH, {
                fileMustExist: false,
                timeout: 30000,
                verbose: process.env.NODE_ENV === 'development' ? console.log : undefined
            });

            console.log(`[vector_db] Vector store database ${dbExists ? 'opened' : 'created'} successfully at: ${VECTOR_DB_PATH}`);

            // Enable WAL mode for better concurrency
            try {
                db.pragma('journal_mode = WAL');
                console.log('[vector_db] WAL mode enabled.');
            } catch (walError) {
                console.error('[vector_db] Failed to enable WAL mode:', walError);
            }

            // Set other performance pragmas
            try {
                db.pragma('synchronous = NORMAL');
                db.pragma('cache_size = -10000'); // 10MB cache
                db.pragma('temp_store = MEMORY');
                db.pragma('mmap_size = 268435456'); // 256MB mmap
                console.log('[vector_db] Performance pragmas set.');
            } catch (pragmaError) {
                console.error('[vector_db] Failed to set performance pragmas:', pragmaError);
            }

            // Load extension with retry logic
            let extensionLoaded = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    console.log(`[vector_db] Attempt ${attempt} to load vec extension...`);
                    db.loadExtension(SQLITE_VEC_EXTENSION_PATH);
                    extensionLoaded = true;
                    console.log(`[vector_db] Successfully loaded vec extension from ${SQLITE_VEC_EXTENSION_PATH}`);
                    break;
                } catch (extError: any) {
                    console.error(`[vector_db] Attempt ${attempt} failed to load vec extension:`, extError.message);
                    if (attempt < 3) {
                        console.log(`[vector_db] Waiting 1 second before retry...`);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
            }

            if (!extensionLoaded) {
                throw new Error('Failed to load sqlite-vec extension after 3 attempts');
            }

            // Check if tables exist
            try {
                const tableInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='codebase_embeddings'").get();
                if (!tableInfo) {
                    needsInitialization = true;
                }
            } catch (error) {
                console.error('[vector_db] Error checking table existence:', error);
                needsInitialization = true;
            }

            if (needsInitialization) {
                console.log(`[vector_db] Reading vector store schema from: ${VECTOR_SCHEMA_PATH}`);
                const schema = readFileSync(VECTOR_SCHEMA_PATH, 'utf-8');

                // Create backup before schema changes
                if (dbExists) {
                    await createBackup(db);
                }

                console.log('[vector_db] Applying vector store database schema...');
                db.exec(schema);
                console.log('[vector_db] Vector store database schema applied successfully.');
            }

            // Create vec virtual table if not exists
            try {
                db.exec(`
                    CREATE VIRTUAL TABLE IF NOT EXISTS codebase_embeddings_vec_idx USING vec0(
                        embedding_id TEXT,
                        embedding float[768]
                    );
                `);
                console.log('[vector_db] vec virtual table created or already exists.');
            } catch (vssError) {
                console.error('[vector_db] Error creating vec virtual table:', vssError);
                throw vssError;
            }

            // Verify database integrity
            try {
                const integrityCheck = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
                if (integrityCheck.integrity_check !== 'ok') {
                    console.warn('[vector_db] Database integrity check failed:', integrityCheck.integrity_check);
                    // Attempt to recover
                    await recoverDatabase(db);
                }
            } catch (integrityError) {
                console.error('[vector_db] Error during integrity check:', integrityError);
            }

            vectorDbInstance = db;
            console.log('[vector_db] Vector store database initialization complete.');
            return db;

        } catch (error) {
            console.error('[vector_db] CRITICAL: Error during initialization:', error);

            if (db) {
                try {
                    db.close();
                } catch (closeError) {
                    console.error('[vector_db] Error closing DB after initialization failure:', closeError);
                }
            }

            // Attempt to restore from backup
            await restoreFromBackup();

            throw error;
        }
    })();

    try {
        return await initializationPromise;
    } catch (error) {
        initializationPromise = null;
        throw error;
    }
}

async function createBackup(db: Database): Promise<void> {
    try {
        ensureDirectoryExists(BACKUP_DIR);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = join(BACKUP_DIR, `vector_store_${timestamp}.db`);

        // Create backup using VACUUM INTO
        db.exec(`VACUUM INTO '${backupPath}'`);

        console.log(`[vector_db] Created backup at: ${backupPath}`);

        // Clean up old backups
        const backups = getBackupFiles();
        if (backups.length > MAX_BACKUPS) {
            const toDelete = backups.slice(0, backups.length - MAX_BACKUPS);
            for (const file of toDelete) {
                try {
                    await fs.promises.unlink(file);
                    console.log(`[vector_db] Deleted old backup: ${file}`);
                } catch (error) {
                    console.error(`[vector_db] Error deleting backup ${file}:`, error);
                }
            }
        }
    } catch (error) {
        console.error('[vector_db] Error creating backup:', error);
    }
}

async function restoreFromBackup(): Promise<void> {
    try {
        const backups = getBackupFiles();
        if (backups.length === 0) {
            console.log('[vector_db] No backups found to restore from');
            return;
        }

        const latestBackup = backups[backups.length - 1];
        console.log(`[vector_db] Attempting to restore from backup: ${latestBackup}`);

        // Copy backup to main database location
        await fs.promises.copyFile(latestBackup, VECTOR_DB_PATH);

        console.log(`[vector_db] Successfully restored from backup: ${latestBackup}`);
    } catch (error) {
        console.error('[vector_db] Error restoring from backup:', error);
    }
}

function getBackupFiles(): string[] {
    try {
        ensureDirectoryExists(BACKUP_DIR);
        const files = fs.readdirSync(BACKUP_DIR);
        return files
            .filter((f: string) => f.startsWith('vector_store_') && f.endsWith('.db'))
            .sort()
            .map((f: string) => join(BACKUP_DIR, f));
    } catch {
        return [];
    }
}

async function recoverDatabase(db: Database): Promise<void> {
    try {
        console.log('[vector_db] Attempting database recovery...');

        // Create backup before recovery
        await createBackup(db);

        // Try to recover using REINDEX
        try {
            db.exec('REINDEX');
            console.log('[vector_db] Database reindexed successfully');
        } catch (reindexError) {
            console.error('[vector_db] Reindex failed:', reindexError);
        }

        // Try VACUUM
        try {
            db.exec('VACUUM');
            console.log('[vector_db] Database vacuumed successfully');
        } catch (vacuumError) {
            console.error('[vector_db] Vacuum failed:', vacuumError);
        }
    } catch (error) {
        console.error('[vector_db] Database recovery failed:', error);
    }
}

function ensureDirectoryExists(dirPath: string): void {
    if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true });
    }
}

export function getVectorStoreDb(): Database {
    if (!vectorDbInstance) {
        console.error('[vector_db] FATAL: Vector store database has not been initialized. Call initializeVectorStoreDatabase() first.');
        throw new Error('Vector store database has not been initialized. Call initializeVectorStoreDatabase() first.');
    }
    return vectorDbInstance;
}

export async function closeVectorStoreDatabase(): Promise<void> {
    if (vectorDbInstance) {
        try {
            // Create final backup before closing
            await createBackup(vectorDbInstance);

            vectorDbInstance.close();
            vectorDbInstance = null;
            initializationPromise = null;
            console.log('[vector_db] Vector store database connection closed successfully.');
        } catch (error) {
            console.error('[vector_db] Error closing vector store database connection:', error);
            throw error;
        }
    }
}

export function storeVecEmbedding(embedding_id: string, vector: number[], tableName: string = 'codebase_embeddings_vec_idx'): void {
    const db = getVectorStoreDb();
    const vectorString = `[${vector.join(',')}]`;

    try {
        const stmt = db.prepare(
            `INSERT OR REPLACE INTO ${tableName} (embedding_id, embedding) VALUES (?, ?);`
        );
        stmt.run(embedding_id, vectorString);
    } catch (error) {
        console.error(`[vector_db] Error storing vector for ID ${embedding_id} in table ${tableName}:`, error);
        throw error;
    }
}

export async function findSimilarVecEmbeddings(queryVector: number[], topK: number = 5, tableName: string = 'codebase_embeddings_vec_idx'): Promise<Array<{ embedding_id: string, similarity: number }>> {
    const db = getVectorStoreDb();
    const vectorString = `[${queryVector.join(',')}]`;

    try {
        // Validate query vector
        if (!queryVector || queryVector.length === 0) {
            throw new Error('Query vector is empty or invalid');
        }

        const stmt = db.prepare(
            `SELECT embedding_id, distance FROM ${tableName} WHERE embedding MATCH ? ORDER BY distance LIMIT ?;`
        );

        const results = stmt.all(vectorString, topK) as Array<{ embedding_id: string, distance: number }>;

        // Convert distance to similarity and validate results
        return results.map((row) => {
            if (typeof row.distance !== 'number' || isNaN(row.distance)) {
                console.warn(`[vector_db] Invalid distance value for embedding ${row.embedding_id}:`, row.distance);
                return { embedding_id: row.embedding_id, similarity: 0 };
            }
            return {
                embedding_id: row.embedding_id,
                similarity: Math.max(0, Math.min(1, 1 - row.distance)) // Clamp similarity to [0,1]
            };
        }).filter(result => result.similarity > 0);
    } catch (error) {
        console.error(`[vector_db] Error finding similar vector embeddings using vec virtual table in table ${tableName}:`, error);
        throw error;
    }
}

// Export health check function
export async function checkVectorDbHealth(): Promise<{
    healthy: boolean;
    message: string;
    details?: any
}> {
    try {
        const db = getVectorStoreDb();

        // Check basic connectivity
        const result = db.prepare("SELECT 1 as test").get() as { test: number };
        if (!result || result.test !== 1) {
            throw new Error('Basic connectivity test failed');
        }

        // Check vec extension
        const vecCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='codebase_embeddings_vec_idx'").get();
        if (!vecCheck) {
            throw new Error('Vector virtual table not found');
        }

        // Check row counts
        const metadataCount = db.prepare("SELECT COUNT(*) as count FROM codebase_embeddings").get() as { count: number };
        const vectorCount = db.prepare("SELECT COUNT(*) as count FROM codebase_embeddings_vec_idx").get() as { count: number };

        return {
            healthy: true,
            message: 'Vector database is healthy',
            details: {
                metadataRows: metadataCount.count,
                vectorRows: vectorCount.count,
                extensionLoaded: true
            }
        };
    } catch (error) {
        return {
            healthy: false,
            message: `Vector database health check failed: ${error instanceof Error ? error.message : String(error)}`,
            details: error
        };
    }
}