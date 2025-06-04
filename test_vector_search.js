// test_vector_search.js
// This script tests the enhanced vector database with SQLite VSS for semantic search

import { 
    initializeVectorStoreDatabase, 
    closeVectorStoreDatabase,
    storeVectorEmbedding,
    findSimilarVectors,
    deleteVectorEmbeddingsForFile,
    getVectorEmbeddingsForAgent
} from './build/database/vector_db.js';

// Sample vector data for testing
const sampleVectors = [
    {
        embedding_id: '1',
        agent_id: 'test-agent',
        file_path_relative: 'src/test/file1.js',
        entity_name: 'function1',
        chunk_text: 'function add(a, b) { return a + b; }',
        vector: Array(1536).fill(0).map(() => Math.random()), // Random vector of 1536 dimensions
        model_name: 'test-model',
        metadata: { startLine: 1, endLine: 3 }
    },
    {
        embedding_id: '2',
        agent_id: 'test-agent',
        file_path_relative: 'src/test/file2.js',
        entity_name: 'function2',
        chunk_text: 'function subtract(a, b) { return a - b; }',
        vector: Array(1536).fill(0).map(() => Math.random()), // Random vector
        model_name: 'test-model',
        metadata: { startLine: 5, endLine: 7 }
    },
    {
        embedding_id: '3',
        agent_id: 'test-agent',
        file_path_relative: 'src/test/file3.js',
        entity_name: 'function3',
        chunk_text: 'function multiply(a, b) { return a * b; }',
        vector: Array(1536).fill(0).map(() => Math.random()), // Random vector
        model_name: 'test-model',
        metadata: { startLine: 9, endLine: 11 }
    }
];

// Create a similar vector to the first one for testing similarity search
const similarToFirst = [...sampleVectors[0].vector];
// Modify slightly to make it similar but not identical
for (let i = 0; i < 100; i++) {
    const idx = Math.floor(Math.random() * similarToFirst.length);
    similarToFirst[idx] = Math.random() * 0.1; // Small random change
}

async function runVectorSearchTest() {
    console.log('=== Vector Search Test ===');
    
    try {
        // Initialize the database
        console.log('\n1. Initializing vector database...');
        const db = await initializeVectorStoreDatabase();
        console.log('Database initialized successfully');
        
        // Store sample vectors
        console.log('\n2. Storing sample vector embeddings...');
        for (const vector of sampleVectors) {
            const id = await storeVectorEmbedding(vector);
            console.log(`Stored vector with ID: ${id}`);
        }
        
        // Get all embeddings for the test agent
        console.log('\n3. Getting all embeddings for test agent...');
        const allEmbeddings = await getVectorEmbeddingsForAgent('test-agent');
        console.log(`Found ${allEmbeddings.length} embeddings for test-agent`);
        
        // Perform similarity search
        console.log('\n4. Performing similarity search...');
        const similarResults = await findSimilarVectors(similarToFirst, 'test-agent', 3);
        console.log('Similarity search results:');
        for (const result of similarResults) {
            console.log(`- ${result.entity_name} (${result.file_path_relative}): Similarity ${result.similarity.toFixed(4)}`);
        }
        
        // Delete embeddings for a specific file
        console.log('\n5. Deleting embeddings for file2.js...');
        const deletedCount = await deleteVectorEmbeddingsForFile('src/test/file2.js', 'test-agent');
        console.log(`Deleted ${deletedCount} embeddings`);
        
        // Verify deletion
        console.log('\n6. Verifying deletion...');
        const remainingEmbeddings = await getVectorEmbeddingsForAgent('test-agent');
        console.log(`Remaining embeddings: ${remainingEmbeddings.length}`);
        
        // Clean up all test data
        console.log('\n7. Cleaning up test data...');
        await deleteVectorEmbeddingsForFile('src/test/file1.js', 'test-agent');
        await deleteVectorEmbeddingsForFile('src/test/file3.js', 'test-agent');
        
        // Close the database
        await closeVectorStoreDatabase();
        console.log('Database closed');
        
        console.log('\n=== Test completed successfully ===');
    } catch (error) {
        console.error('Test failed:', error);
    }
}

// Run the test
runVectorSearchTest();