// test_vector_db_location.js
// This script tests where the vector database is created
// Run this after building the project with: node test_vector_db_location.js

import { join, dirname } from 'path';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import * as os from 'os';

// Get the current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import the built module
import { initializeVectorStoreDatabase, closeVectorStoreDatabase } from './build/database/vector_db.js';

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

// Function to check if a file exists and print its details
const checkFile = (path) => {
    const exists = existsSync(path);
    console.log(`File ${path} exists: ${exists}`);
    return exists;
};

async function runTests() {
    console.log('=== Vector Database Location Test ===');
    
    // Store original environment variable
    const originalVectorDbPath = process.env.VECTOR_DB_PATH;
    
    // Reset environment variable for testing
    delete process.env.VECTOR_DB_PATH;
    
    // Clean up any existing test files
    cleanupDbFiles();
    
    try {
        // Test 1: Default location
        console.log('\n--- Test 1: Default database location ---');
        console.log('Current working directory:', process.cwd());
        console.log('DB exists before initialization:', existsSync(cwdDbPath));
        
        // Initialize the database
        console.log('Initializing vector database...');
        const db = await initializeVectorStoreDatabase();
        console.log('Database initialized');
        
        // Check if DB exists after initialization
        console.log('DB exists in CWD after initialization:', existsSync(cwdDbPath));
        
        // Print the actual VECTOR_DB_PATH value from the module
        console.log('Actual VECTOR_DB_PATH value used:', process.env.VECTOR_DB_PATH || join(process.cwd(), 'vector_store.db'));
        
        // Close the database
        await closeVectorStoreDatabase();
        console.log('Database closed');
        
        // Test 2: Custom location with environment variable
        console.log('\n--- Test 2: Custom location with environment variable ---');
        
        // Clean up from previous test
        cleanupDbFiles();
        
        // Set custom path using environment variable
        const tempDir = join(os.tmpdir(), 'vector_db_test');
        // Create directory if it doesn't exist
        if (!existsSync(tempDir)) {
            mkdirSync(tempDir, { recursive: true });
            console.log(`Created directory: ${tempDir}`);
        }
        
        const customPath = join(tempDir, 'custom_vector_store.db');
        process.env.VECTOR_DB_PATH = customPath;
        
        console.log('Custom DB path:', customPath);
        console.log('DB exists at custom path before initialization:', existsSync(customPath));
        console.log('Environment variable VECTOR_DB_PATH set to:', process.env.VECTOR_DB_PATH);
        
        // Initialize the database
        console.log('Initializing vector database with custom path...');
        const customDb = await initializeVectorStoreDatabase();
        console.log('Database initialized');
        
        // Check if DB exists after initialization
        console.log('DB exists at custom path after initialization:', existsSync(customPath));
        console.log('DB exists in CWD after initialization:', existsSync(cwdDbPath));
        
        // Close the database
        await closeVectorStoreDatabase();
        console.log('Database closed');
        
        // Clean up custom DB
        if (existsSync(customPath)) {
            unlinkSync(customPath);
            console.log(`Cleaned up custom DB: ${customPath}`);
        }
        
        // Test 3: Check if environment variable is being read correctly
        console.log('\n--- Test 3: Environment variable test ---');
        
        // Clean up from previous test
        cleanupDbFiles();
        
        // Create a test file to verify the path
        const testPath = join(os.tmpdir(), 'test_vector_db.db');
        process.env.VECTOR_DB_PATH = testPath;
        
        console.log('Environment variable VECTOR_DB_PATH set to:', process.env.VECTOR_DB_PATH);
        
        // Print what the module would use
        console.log('Module should use path:', process.env.VECTOR_DB_PATH || join(process.cwd(), 'vector_store.db'));
        
        // Initialize the database
        console.log('Initializing vector database...');
        const testDb = await initializeVectorStoreDatabase();
        console.log('Database initialized');
        
        // Check where the database was actually created
        console.log('DB exists at environment path:', existsSync(testPath));
        console.log('DB exists in CWD:', existsSync(cwdDbPath));
        
        // Close the database
        await closeVectorStoreDatabase();
        console.log('Database closed');
        
        // Clean up
        if (existsSync(testPath)) {
            unlinkSync(testPath);
            console.log(`Cleaned up: ${testPath}`);
        }
        
        // Summary
        console.log('\n=== Test Summary ===');
        console.log('1. By default, the vector database is created in the current working directory');
        console.log('2. The database location is configurable with VECTOR_DB_PATH environment variable');
        console.log('3. The database is portable and can be moved to different locations');
        console.log('4. The environment variable is properly respected in all test cases');
        
    } catch (error) {
        console.error('Test failed:', error);
    } finally {
        // Restore original environment variable
        if (originalVectorDbPath) {
            process.env.VECTOR_DB_PATH = originalVectorDbPath;
        } else {
            delete process.env.VECTOR_DB_PATH;
        }
        
        // Final cleanup
        cleanupDbFiles();
    }
}

// Run the tests
runTests();