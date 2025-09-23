import { KuzuStorageManager, KuzuNode, KuzuRelation } from '../src/database/storage/KuzuStorageManager.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('KuzuStorageManager', () => {
    let storageManager: KuzuStorageManager;
    let testDbPath: string;
    const testAgentId = 'test-agent-123';

    beforeAll(async () => {
        // Create test database path
        testDbPath = path.join(__dirname, 'test-kuzu-db');
        storageManager = new KuzuStorageManager(testDbPath);
    });

    afterAll(async () => {
        // Clean up test database
        try {
            await storageManager.close();
            await fs.rmdir(testDbPath, { recursive: true });
        } catch (error) {
            console.warn('Cleanup error:', error);
        }
    });

    beforeEach(async () => {
        // Initialize schema for each test
        await storageManager.initializeSchema(testAgentId);
    });

    describe('Schema Initialization', () => {
        it('should initialize schema for agent', async () => {
            // Schema initialization is done in beforeEach
            // Just verify we can query without errors
            const nodes = await storageManager.getAllNodes(testAgentId);
            expect(Array.isArray(nodes)).toBe(true);
        });

        it('should create separate databases for different agents', async () => {
            const agent2 = 'test-agent-456';
            await storageManager.initializeSchema(agent2);

            // Both agents should have independent schemas
            const agent1Nodes = await storageManager.getAllNodes(testAgentId);
            const agent2Nodes = await storageManager.getAllNodes(agent2);

            expect(agent1Nodes).toEqual([]);
            expect(agent2Nodes).toEqual([]);
        });
    });

    describe('Node Operations', () => {
        const sampleNodes: KuzuNode[] = [
            {
                id: 'node-1',
                agentId: testAgentId,
                name: 'TestClass.ts',
                entityType: 'file',
                observations: ['TypeScript class file', 'Contains main business logic'],
                timestamp: Date.now(),
                version: 1
            },
            {
                id: 'node-2',
                agentId: testAgentId,
                name: 'processData',
                entityType: 'function',
                observations: ['Processes user input data', 'Returns validation results'],
                timestamp: Date.now(),
                version: 1
            }
        ];

        it('should insert nodes successfully', async () => {
            await storageManager.insertNodes(testAgentId, sampleNodes);

            const allNodes = await storageManager.getAllNodes(testAgentId);
            expect(allNodes).toHaveLength(2);
            expect(allNodes[0].name).toBe('TestClass.ts');
            expect(allNodes[1].name).toBe('processData');
        });

        it('should retrieve node by ID', async () => {
            await storageManager.insertNodes(testAgentId, sampleNodes);

            const retrievedNode = await storageManager.getNodeById(testAgentId, 'node-1');
            expect(retrievedNode).not.toBeNull();
            expect(retrievedNode!.name).toBe('TestClass.ts');
            expect(retrievedNode!.entityType).toBe('file');
        });

        it('should retrieve nodes by names', async () => {
            await storageManager.insertNodes(testAgentId, sampleNodes);

            const nodes = await storageManager.getNodesByName(testAgentId, ['TestClass.ts', 'processData']);
            expect(nodes).toHaveLength(2);
        });

        it('should search nodes by content', async () => {
            await storageManager.insertNodes(testAgentId, sampleNodes);

            const results = await storageManager.searchNodes(testAgentId, 'TypeScript');
            expect(results).toHaveLength(1);
            expect(results[0].name).toBe('TestClass.ts');
        });

        it('should search nodes by entity type', async () => {
            await storageManager.insertNodes(testAgentId, sampleNodes);

            const results = await storageManager.searchNodes(testAgentId, 'process', 'function');
            expect(results).toHaveLength(1);
            expect(results[0].name).toBe('processData');
        });

        it('should update node successfully', async () => {
            await storageManager.insertNodes(testAgentId, sampleNodes);

            const success = await storageManager.updateNode(testAgentId, 'node-1', {
                observations: ['Updated observation'],
                version: 2
            });

            expect(success).toBe(true);

            const updatedNode = await storageManager.getNodeById(testAgentId, 'node-1');
            expect(updatedNode!.observations).toEqual(['Updated observation']);
            expect(updatedNode!.version).toBe(2);
        });

        it('should delete node successfully', async () => {
            await storageManager.insertNodes(testAgentId, sampleNodes);

            const success = await storageManager.deleteNode(testAgentId, 'node-1');
            expect(success).toBe(true);

            const deletedNode = await storageManager.getNodeById(testAgentId, 'node-1');
            expect(deletedNode).toBeNull();
        });

        it('should overwrite existing nodes on re-ingestion instead of duplicating', async () => {
            await storageManager.insertNodes(testAgentId, sampleNodes);

            let allNodes = await storageManager.getAllNodes(testAgentId);
            expect(allNodes).toHaveLength(2);

            const refreshedNodes: KuzuNode[] = sampleNodes.map(node => ({
                ...node,
                observations: [...node.observations, 'refreshed_ingest'],
                version: node.version + 1,
                timestamp: Date.now()
            }));

            await storageManager.insertNodes(testAgentId, refreshedNodes);

            allNodes = await storageManager.getAllNodes(testAgentId);
            expect(allNodes).toHaveLength(2);
            expect(new Set(allNodes.map(node => node.id)).size).toBe(2);

            const refreshedNode = await storageManager.getNodeById(testAgentId, 'node-1');
            expect(refreshedNode).not.toBeNull();
            expect(refreshedNode!.observations).toContain('refreshed_ingest');
            expect(refreshedNode!.version).toBeGreaterThan(1);
        });
    });

    describe('Relation Operations', () => {
        const sampleRelations: KuzuRelation[] = [
            {
                id: 'rel-1',
                fromNodeId: 'node-1',
                toNodeId: 'node-2',
                relationType: 'contains',
                timestamp: Date.now(),
                version: 1
            }
        ];

        beforeEach(async () => {
            // Insert nodes first
            const sampleNodes: KuzuNode[] = [
                {
                    id: 'node-1',
                    agentId: testAgentId,
                    name: 'TestClass.ts',
                    entityType: 'file',
                    observations: [],
                    timestamp: Date.now(),
                    version: 1
                },
                {
                    id: 'node-2',
                    agentId: testAgentId,
                    name: 'processData',
                    entityType: 'function',
                    observations: [],
                    timestamp: Date.now(),
                    version: 1
                }
            ];
            await storageManager.insertNodes(testAgentId, sampleNodes);
        });

        it('should insert relations successfully', async () => {
            await storageManager.insertRelations(testAgentId, sampleRelations);

            const allRelations = await storageManager.getAllRelations(testAgentId);
            expect(allRelations).toHaveLength(1);
            expect(allRelations[0].relationType).toBe('contains');
        });

        it('should delete relation successfully', async () => {
            await storageManager.insertRelations(testAgentId, sampleRelations);

            const success = await storageManager.deleteRelation(testAgentId, 'rel-1');
            expect(success).toBe(true);

            const allRelations = await storageManager.getAllRelations(testAgentId);
            expect(allRelations).toHaveLength(0);
        });

        it('should keep a single relation record when reinserting the same relation id', async () => {
            await storageManager.insertRelations(testAgentId, sampleRelations);
            let allRelations = await storageManager.getAllRelations(testAgentId);
            expect(allRelations).toHaveLength(1);

            const updatedRelation: KuzuRelation = {
                ...sampleRelations[0],
                timestamp: Date.now(),
                version: sampleRelations[0].version + 1
            };

            await storageManager.insertRelations(testAgentId, [updatedRelation]);

            allRelations = await storageManager.getAllRelations(testAgentId);
            expect(allRelations).toHaveLength(1);
            expect(allRelations[0].version).toBe(updatedRelation.version);
            expect(allRelations[0].id).toBe(updatedRelation.id);
        });
    });

    describe('Graph Traversal', () => {
        beforeEach(async () => {
            // Create a small test graph
            const nodes: KuzuNode[] = [
                {
                    id: 'file-1',
                    agentId: testAgentId,
                    name: 'app.ts',
                    entityType: 'file',
                    observations: [],
                    timestamp: Date.now(),
                    version: 1
                },
                {
                    id: 'class-1',
                    agentId: testAgentId,
                    name: 'AppController',
                    entityType: 'class',
                    observations: [],
                    timestamp: Date.now(),
                    version: 1
                },
                {
                    id: 'func-1',
                    agentId: testAgentId,
                    name: 'handleRequest',
                    entityType: 'function',
                    observations: [],
                    timestamp: Date.now(),
                    version: 1
                }
            ];

            const relations: KuzuRelation[] = [
                {
                    id: 'rel-1',
                    fromNodeId: 'file-1',
                    toNodeId: 'class-1',
                    relationType: 'contains',
                    timestamp: Date.now(),
                    version: 1
                },
                {
                    id: 'rel-2',
                    fromNodeId: 'class-1',
                    toNodeId: 'func-1',
                    relationType: 'defines',
                    timestamp: Date.now(),
                    version: 1
                }
            ];

            await storageManager.insertNodes(testAgentId, nodes);
            await storageManager.insertRelations(testAgentId, relations);
        });

        it('should traverse graph with depth limit', async () => {
            const result = await storageManager.traverseGraph(testAgentId, 'file-1', ['contains', 'defines'], 2);

            expect(result.nodes).toHaveLength(3); // file, class, function
            expect(result.relations).toHaveLength(2);
        });

        it('should respect relation type filters', async () => {
            const result = await storageManager.traverseGraph(testAgentId, 'file-1', ['contains'], 2);

            expect(result.nodes).toHaveLength(2); // file, class (function not reached)
            expect(result.relations).toHaveLength(1);
        });
    });

    describe('Cypher Queries', () => {
        beforeEach(async () => {
            // Insert test data
            const nodes: KuzuNode[] = [
                {
                    id: 'node-1',
                    agentId: testAgentId,
                    name: 'TestService',
                    entityType: 'class',
                    observations: ['Service class'],
                    timestamp: Date.now(),
                    version: 1
                }
            ];
            await storageManager.insertNodes(testAgentId, nodes);
        });

        it('should execute basic cypher query', async () => {
            const nodeTable = 'KGNode';
            const query = `MATCH (n:${nodeTable}) WHERE n.entityType = 'class' RETURN n`;

            const results = await storageManager.cypherQuery(testAgentId, query);
            expect(Array.isArray(results)).toBe(true);
            expect(results.length).toBeGreaterThan(0);
        });
    });

    describe('Agent Isolation', () => {
        it('should maintain data isolation between agents', async () => {
            const agent1 = 'agent-1';
            const agent2 = 'agent-2';

            await storageManager.initializeSchema(agent1);
            await storageManager.initializeSchema(agent2);

            // Add data to agent1
            const agent1Nodes: KuzuNode[] = [
                {
                    id: 'agent1-node',
                    agentId: agent1,
                    name: 'Agent1Data',
                    entityType: 'file',
                    observations: [],
                    timestamp: Date.now(),
                    version: 1
                }
            ];
            await storageManager.insertNodes(agent1, agent1Nodes);

            // Add data to agent2
            const agent2Nodes: KuzuNode[] = [
                {
                    id: 'agent2-node',
                    agentId: agent2,
                    name: 'Agent2Data',
                    entityType: 'file',
                    observations: [],
                    timestamp: Date.now(),
                    version: 1
                }
            ];
            await storageManager.insertNodes(agent2, agent2Nodes);

            // Verify isolation
            const agent1Data = await storageManager.getAllNodes(agent1);
            const agent2Data = await storageManager.getAllNodes(agent2);

            expect(agent1Data).toHaveLength(1);
            expect(agent2Data).toHaveLength(1);
            expect(agent1Data[0].name).toBe('Agent1Data');
            expect(agent2Data[0].name).toBe('Agent2Data');
        });
    });

    describe('Error Handling', () => {
        it('should handle non-existent node queries gracefully', async () => {
            const result = await storageManager.getNodeById(testAgentId, 'non-existent');
            expect(result).toBeNull();
        });

        it('should handle empty search results', async () => {
            const results = await storageManager.searchNodes(testAgentId, 'non-existent-term');
            expect(results).toEqual([]);
        });

        it('should handle invalid relation insertion', async () => {
            const invalidRelations: KuzuRelation[] = [
                {
                    id: 'invalid-rel',
                    fromNodeId: 'non-existent-from',
                    toNodeId: 'non-existent-to',
                    relationType: 'invalid',
                    timestamp: Date.now(),
                    version: 1
                }
            ];

            // Should not throw, but relation won't be created
            await expect(storageManager.insertRelations(testAgentId, invalidRelations)).resolves.not.toThrow();
        });
    });
});
