// src/tests/vector_db_location.test.ts
import { initializeVectorStoreDatabase, closeVectorStoreDatabase } from '../database/vector_db.js';
import { join } from 'path';
import { existsSync, unlinkSync } from 'fs';
import * as os from 'os';

describe('Vector Database Location Tests', () => {
    // Store original environment variable
    const originalVectorDbPath = process.env.VECTOR_DB_PATH;
    
    // Paths to check
    const cwdDbPath = join(process.cwd(), 'vector_store.db');
    const cwdWalPath = join(process.cwd(), 'vector_store.db-wal');
    const cwdShmPath = join(process.cwd(), 'vector_store.db-shm');
    
    // Clean up function to remove test databases
    const cleanupDbFiles = () => {
        const filesToCleanup = [cwdDbPath, cwdWalPath, cwdShmPath];
        
        for (const file of filesToCleanup) {
            if (existsSync(file)) {
                try {
                    unlinkSync(file);
                    console.log(`Cleaned up: ${file}`);
                } catch (err) {
                    console.error(`Failed to clean up ${file}:`, err);
                }
            }
        }
    };
    
    // Clean up before and after tests
    beforeAll(() => {
        // Reset environment variable
        delete process.env.VECTOR_DB_PATH;
        cleanupDbFiles();
    });
    
    afterAll(() => {
        // Restore original environment variable
        if (originalVectorDbPath) {
            process.env.VECTOR_DB_PATH = originalVectorDbPath;
        } else {
            delete process.env.VECTOR_DB_PATH;
        }
        cleanupDbFiles();
    });
    
    test('Default database location is in current working directory', async () => {
        console.log('Current working directory:', process.cwd());
        
        // Check if DB exists before initialization
        expect(existsSync(cwdDbPath)).toBe(false);
        
        // Initialize the database
        const db = await initializeVectorStoreDatabase();
        
        // Check if DB exists after initialization
        expect(existsSync(cwdDbPath)).toBe(true);
        
        // Close the database
        await closeVectorStoreDatabase();
    });
    
    test('Database location can be changed with environment variable', async () => {
        // Set custom path using environment variable
        const customPath = join(os.tmpdir(), 'custom_vector_store.db');
        process.env.VECTOR_DB_PATH = customPath;
        
        console.log('Custom DB path:', customPath);
        
        // Check if DB exists before initialization
        expect(existsSync(customPath)).toBe(false);
        
        // Initialize the database
        const db = await initializeVectorStoreDatabase();
        
        // Check if DB exists after initialization
        expect(existsSync(customPath)).toBe(true);
        
        // Close the database
        await closeVectorStoreDatabase();
        
        // Clean up custom DB
        if (existsSync(customPath)) {
            unlinkSync(customPath);
        }
        
        // Reset environment variable
        delete process.env.VECTOR_DB_PATH;
    });
    
    test('Database is not created in script directory by default', async () => {
        // Get the script directory path
        const scriptDir = join(__dirname, '..', 'database');
        const scriptDirDbPath = join(scriptDir, 'vector_store.db');
        
        console.log('Script directory DB path:', scriptDirDbPath);
        
        // Initialize the database
        const db = await initializeVectorStoreDatabase();
        
        // Check that DB exists in CWD
        expect(existsSync(cwdDbPath)).toBe(true);
        
        // Check that DB does NOT exist in script directory
        expect(existsSync(scriptDirDbPath)).toBe(false);
        
        // Close the database
        await closeVectorStoreDatabase();
    });
});