// Test script for SqliteVecClientManager
import { SqliteVecClientManager } from './build/database/vector/SqliteVecClientManager.js';

async function testClientManager() {
    try {
        console.log('🧪 Testing SqliteVecClientManager...');
        
        const client = SqliteVecClientManager.getInstance();
        
        // Test connection
        await client.connect();
        console.log('✅ Connected to database');
        
        // Test health check
        const health = await client.performHealthCheck();
        console.log('🩺 Health check:', health.status, `- ${health.total_vectors} vectors`);
        
        // Test entity upsert with proper 3072 dimensions for Gemini
        await client.upsertEntity({
            id: 'test-entity-1',
            agent_id: 'test-agent',
            name: 'TestFunction',
            entity_type: 'function',
            observations: ['A test function that does something'],
            embedding: Array(3072).fill(0.1), // 3072-dimensional vector matching Gemini
            metadata: { test: true },
            confidence: 0.95
        });
        console.log('✅ Entity upserted');
        
        // Test vector search with matching 3072 dimensions
        const results = await client.searchSimilarEntities(
            'test-agent',
            Array(3072).fill(0.1), // Same 3072-dimensional query vector
            5
        );
        console.log('🔍 Search results:', results.length, 'entities found');
        
        // Test cleanup
        await client.deleteEntity('test-entity-1');
        console.log('🗑️ Test entity cleaned up');
        
        console.log('✅ All SqliteVecClientManager tests passed!');
        
        await client.disconnect();
        
    } catch (error) {
        console.error('❌ SqliteVecClientManager test failed:', error.message);
        process.exit(1);
    }
}

testClientManager();