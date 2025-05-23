import { MemoryManager } from '../database/memory_manager.js';
import { getDatabase, initializeDatabase } from '../database/db.js';
import { randomUUID } from 'crypto';
import { Database } from 'sqlite';

describe('MemoryManager Plan and Task Management', () => {
    let memoryManager: MemoryManager;
    let db: Database;

    beforeAll(async () => {
        // Initialize a new in-memory database for testing
        process.env.NODE_ENV = 'test'; // Indicate test environment
        db = await initializeDatabase();
        memoryManager = await MemoryManager.create();
    });

    afterEach(async () => {
        // Clear tables after each test
        await db.run(`DELETE FROM plan_tasks`);
        await db.run(`DELETE FROM plans`);
    });

    afterAll(async () => {
        // Close the database connection after all tests
        await db.close();
    });

    it('should create a plan with multiple tasks atomically', async () => {
        const agentId = 'test-agent-1';
        const planData = {
            title: 'Project Alpha',
            overall_goal: 'Complete alpha phase',
            status: 'IN_PROGRESS',
            metadata: { client: 'XYZ' }
        };
        const tasksData = [
            { task_number: 1, title: 'Task A', description: 'Desc A', status: 'PLANNED' },
            { task_number: 2, title: 'Task B', description: 'Desc B', status: 'PLANNED', files_involved: ['file1.ts', 'file2.ts'] }
        ];

        const { plan_id, task_ids } = await memoryManager.createPlanWithTasks(agentId, planData, tasksData);

        expect(plan_id).toBeDefined();
        expect(task_ids).toHaveLength(2);
        expect(task_ids[0]).toBeDefined();
        expect(task_ids[1]).toBeDefined();

        // Verify plan exists
        const retrievedPlan: any = await db.get(`SELECT * FROM plans WHERE plan_id = ?`, plan_id);
        expect(retrievedPlan).toBeDefined();
        expect(retrievedPlan.title).toBe('Project Alpha');
        expect(retrievedPlan.status).toBe('IN_PROGRESS');
        expect(JSON.parse(retrievedPlan.metadata).client).toBe('XYZ');

        // Verify tasks exist and are linked
        const retrievedTasks: any[] = await db.all(`SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY task_number ASC`, plan_id);
        expect(retrievedTasks).toHaveLength(2);
        expect(retrievedTasks[0].title).toBe('Task A');
        expect(retrievedTasks[0].plan_id).toBe(plan_id);
        expect(retrievedTasks[1].title).toBe('Task B');
        expect(retrievedTasks[1].plan_id).toBe(plan_id);
        expect(JSON.parse(retrievedTasks[1].files_involved)).toEqual(['file1.ts', 'file2.ts']);
    });

    it('should rollback if task insertion fails during plan creation', async () => {
        const agentId = 'test-agent-2';
        const planData = { title: 'Faulty Plan' };
        const tasksData = [
            { task_number: 1, title: 'Valid Task' },
            { task_number: 2, title: null } // Invalid task data (title is NOT NULL)
        ];

        await expect(memoryManager.createPlanWithTasks(agentId, planData, tasksData as any)).rejects.toThrow();

        // Verify no plan or tasks were created
        const plans = await db.all(`SELECT * FROM plans WHERE agent_id = ?`, agentId);
        expect(plans).toHaveLength(0);
        const tasks = await db.all(`SELECT * FROM plan_tasks WHERE agent_id = ?`, agentId);
        expect(tasks).toHaveLength(0);
    });

    it('should retrieve a specific plan by ID', async () => {
        const agentId = 'test-agent-3';
        const planId = randomUUID();
        const timestamp = Date.now();
        await db.run(
            `INSERT INTO plans (plan_id, agent_id, title, creation_timestamp, last_updated_timestamp) VALUES (?, ?, ?, ?, ?)`,
            planId, agentId, 'My Test Plan', timestamp, timestamp
        );

        const retrievedPlan = await memoryManager.getPlan(agentId, planId);
        expect(retrievedPlan).toBeDefined();
        expect((retrievedPlan as any).plan_id).toBe(planId);
        expect((retrievedPlan as any).title).toBe('My Test Plan');
    });

    it('should list plans for an agent, optionally filtered by status', async () => {
        const agentId = 'test-agent-4';
        const ts = Date.now();
        await db.run(`INSERT INTO plans (plan_id, agent_id, title, status, creation_timestamp, last_updated_timestamp) VALUES (?, ?, ?, ?, ?, ?)`, randomUUID(), agentId, 'Plan 1', 'COMPLETED', ts, ts);
        await db.run(`INSERT INTO plans (plan_id, agent_id, title, status, creation_timestamp, last_updated_timestamp) VALUES (?, ?, ?, ?, ?, ?)`, randomUUID(), agentId, 'Plan 2', 'IN_PROGRESS', ts + 1, ts + 1);
        await db.run(`INSERT INTO plans (plan_id, agent_id, title, status, creation_timestamp, last_updated_timestamp) VALUES (?, ?, ?, ?, ?, ?)`, randomUUID(), agentId, 'Plan 3', 'COMPLETED', ts + 2, ts + 2);

        const allPlans = await memoryManager.getPlans(agentId);
        expect(allPlans).toHaveLength(3);

        const completedPlans = await memoryManager.getPlans(agentId, 'COMPLETED');
        expect(completedPlans).toHaveLength(2);
        expect((completedPlans[0] as any).status).toBe('COMPLETED');
    });

    it('should retrieve tasks for a specific plan, optionally filtered by status', async () => {
        const agentId = 'test-agent-5';
        const planId = randomUUID();
        const ts = Date.now();
        await db.run(`INSERT INTO plans (plan_id, agent_id, title, creation_timestamp, last_updated_timestamp) VALUES (?, ?, ?, ?, ?)`, planId, agentId, 'Plan with Tasks', ts, ts);
        await db.run(`INSERT INTO plan_tasks (task_id, plan_id, agent_id, task_number, title, status, creation_timestamp, last_updated_timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, randomUUID(), planId, agentId, 1, 'Task 1', 'PLANNED', ts, ts);
        await db.run(`INSERT INTO plan_tasks (task_id, plan_id, agent_id, task_number, title, status, creation_timestamp, last_updated_timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, randomUUID(), planId, agentId, 2, 'Task 2', 'IN_PROGRESS', ts + 1, ts + 1);
        await db.run(`INSERT INTO plan_tasks (task_id, plan_id, agent_id, task_number, title, status, creation_timestamp, last_updated_timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, randomUUID(), planId, agentId, 3, 'Task 3', 'COMPLETED', ts + 2, ts + 2);

        const allTasks = await memoryManager.getPlanTasks(agentId, planId);
        expect(allTasks).toHaveLength(3);
        expect((allTasks[0] as any).title).toBe('Task 1'); // Ordered by task_number

        const inProgressTasks = await memoryManager.getPlanTasks(agentId, planId, 'IN_PROGRESS');
        expect(inProgressTasks).toHaveLength(1);
        expect((inProgressTasks[0] as any).title).toBe('Task 2');
    });

    it('should update plan status', async () => {
        const agentId = 'test-agent-6';
        const planId = randomUUID();
        const ts = Date.now();
        await db.run(`INSERT INTO plans (plan_id, agent_id, title, status, creation_timestamp, last_updated_timestamp) VALUES (?, ?, ?, ?, ?, ?)`, planId, agentId, 'Updatable Plan', 'DRAFT', ts, ts);

        const success = await memoryManager.updatePlanStatus(agentId, planId, 'APPROVED');
        expect(success).toBe(true);

        const updatedPlan: any = await db.get(`SELECT * FROM plans WHERE plan_id = ?`, planId);
        expect(updatedPlan.status).toBe('APPROVED');
        expect(updatedPlan.last_updated_timestamp).toBeGreaterThan(ts);
    });

    it('should update task status and completion timestamp', async () => {
        const agentId = 'test-agent-7';
        const planId = randomUUID();
        const taskId = randomUUID();
        const ts = Date.now();
        await db.run(`INSERT INTO plans (plan_id, agent_id, title, creation_timestamp, last_updated_timestamp) VALUES (?, ?, ?, ?, ?)`, planId, agentId, 'Plan for Task Update', ts, ts);
        await db.run(`INSERT INTO plan_tasks (task_id, plan_id, agent_id, task_number, title, status, creation_timestamp, last_updated_timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, taskId, planId, agentId, 1, 'Task to Update', 'PLANNED', ts, ts);

        const completionTs = Date.now() + 1000;
        const success = await memoryManager.updateTaskStatus(agentId, taskId, 'COMPLETED', completionTs);
        expect(success).toBe(true);

        const updatedTask: any = await db.get(`SELECT * FROM plan_tasks WHERE task_id = ?`, taskId);
        expect(updatedTask.status).toBe('COMPLETED');
        expect(updatedTask.last_updated_timestamp).toBeGreaterThan(ts);
        expect(updatedTask.completion_timestamp).toBe(completionTs);
    });

    it('should delete a plan and cascade delete its tasks', async () => {
        const agentId = 'test-agent-8';
        const planId = randomUUID();
        const ts = Date.now();
        await db.run(`INSERT INTO plans (plan_id, agent_id, title, creation_timestamp, last_updated_timestamp) VALUES (?, ?, ?, ?, ?)`, planId, agentId, 'Plan to Delete', ts, ts);
        await db.run(`INSERT INTO plan_tasks (task_id, plan_id, agent_id, task_number, title, status, creation_timestamp, last_updated_timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, randomUUID(), planId, agentId, 1, 'Task 1 of Deleted Plan', 'PLANNED', ts, ts);
        await db.run(`INSERT INTO plan_tasks (task_id, plan_id, agent_id, task_number, title, status, creation_timestamp, last_updated_timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, randomUUID(), planId, agentId, 2, 'Task 2 of Deleted Plan', 'PLANNED', ts + 1, ts + 1);

        // Verify plan and tasks exist initially
        const initialPlan = await db.get(`SELECT * FROM plans WHERE plan_id = ?`, planId);
        const initialTasks = await db.all(`SELECT * FROM plan_tasks WHERE plan_id = ?`, planId);
        expect(initialPlan).toBeDefined();
        expect(initialTasks).toHaveLength(2);

        // Diagnostic: Check foreign_keys PRAGMA status before delete
        const fkStatusBefore: any = await db.get('PRAGMA foreign_keys;');
        console.log('Foreign Keys Status BEFORE delete:', fkStatusBefore); // Should be { foreign_keys: 1 }

        const success = await memoryManager.deletePlan(agentId, planId);
        expect(success).toBe(true);

        // Diagnostic: Check foreign_keys PRAGMA status after delete
        const fkStatusAfter: any = await db.get('PRAGMA foreign_keys;');
        console.log('Foreign Keys Status AFTER delete:', fkStatusAfter); // Should still be { foreign_keys: 1 }

        // Verify plan and tasks are deleted
        const deletedPlan = await db.get(`SELECT * FROM plans WHERE plan_id = ?`, planId);
        const deletedTasks = await db.all(`SELECT * FROM plan_tasks WHERE plan_id = ?`, planId);
        expect(deletedPlan).toBeUndefined();
        expect(deletedTasks).toHaveLength(0);
    });

    it('should retrieve a specific task by ID', async () => {
        const agentId = 'test-agent-9';
        const planId = randomUUID();
        const taskId = randomUUID();
        const ts = Date.now();
        await db.run(`INSERT INTO plans (plan_id, agent_id, title, creation_timestamp, last_updated_timestamp) VALUES (?, ?, ?, ?, ?)`, planId, agentId, 'Plan for Single Task', ts, ts);
        await db.run(`INSERT INTO plan_tasks (task_id, plan_id, agent_id, task_number, title, creation_timestamp, last_updated_timestamp, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, taskId, planId, agentId, 1, 'Single Task', ts, ts, JSON.stringify({ important: 'note' }));

        const retrievedTask = await memoryManager.getTask(agentId, taskId);
        expect(retrievedTask).toBeDefined();
        expect((retrievedTask as any).task_id).toBe(taskId);
        expect((retrievedTask as any).title).toBe('Single Task');
        expect((retrievedTask as any).notes.important).toBe('note');
    });
});
