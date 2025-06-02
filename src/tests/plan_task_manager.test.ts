
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { MemoryManager } from '../database/memory_manager.js';
import { getDatabase, initializeDatabase } from '../database/db.js';
import { randomUUID } from 'crypto';
import { Database } from 'sqlite';

describe('MemoryManager Plan and Task Management', () => {
    let memoryManager: MemoryManager;
    let db: Database;

    beforeAll(async () => {
        const dbPath = join(__dirname, '../../memory.db');
        if (existsSync(dbPath) && process.env.NODE_ENV === 'test_full_reset') { // Only delete if flag is set
            try {
                unlinkSync(dbPath);
                console.log('Deleted existing memory.db file for clean test setup.');
            } catch (err) {
                console.error('Error deleting memory.db file:', err);
                // Not throwing error to allow tests to proceed if deletion fails but DB can still be initialized
            }
        }

        db = await initializeDatabase(); // Initialize or re-initialize DB
        memoryManager = await MemoryManager.create();

        // Ensure default agents are created by initializeDatabase
        // For specific test agents, ensure they are created here if not handled by initializeDatabase
        await db.run(
            `INSERT OR IGNORE INTO agents (agent_id, name, description, creation_timestamp_unix, creation_timestamp_iso, status) VALUES (?, ?, ?, ?, ?, ?)`,
            'test-agent-1', 'Test Agent 1', 'Agent for plan tests', Math.floor(Date.now() / 1000), new Date().toISOString(), 'ACTIVE'
        );
        // Add other test agents as needed
    });

    afterEach(async () => {
        await db.run(`DELETE FROM subtasks`); // Assuming subtasks might be created implicitly by some plan/task operations
        await db.run(`DELETE FROM plan_tasks`);
        await db.run(`DELETE FROM plans`);
    });

    afterAll(async () => {
        await db.close();
    });

    it('should create a plan with multiple tasks atomically', async () => {
        const agentId = 'test-agent-1'; // Ensure this agent exists
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

        const retrievedPlan: any = await db.get(`SELECT * FROM plans WHERE plan_id = ?`, plan_id);
        expect(retrievedPlan).toBeDefined();
        expect(retrievedPlan.title).toBe('Project Alpha');
        expect(retrievedPlan.status).toBe('IN_PROGRESS');
        expect(JSON.parse(retrievedPlan.metadata)).toEqual({ client: 'XYZ' }); // Use toEqual for objects

        const retrievedTasks: any[] = await db.all(`SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY task_number ASC`, plan_id);
        expect(retrievedTasks).toHaveLength(2);
        expect(retrievedTasks[0].title).toBe('Task A');
        // files_involved is stored as files_involved_json
        expect(JSON.parse(retrievedTasks[1].files_involved_json)).toEqual(['file1.ts', 'file2.ts']);
    });

    it('should rollback if task insertion fails during plan creation', async () => {
        const agentId = 'test-agent-1';
        const planData = { title: 'Faulty Plan' };
        const tasksData = [
            { task_number: 1, title: 'Valid Task' },
            { task_number: 2, title: null } // Invalid: title is NOT NULL
        ];

        // Check schema for plan_tasks.title
        // Assuming 'title' in tasksData maps to 'title' in plan_tasks which is NOT NULL
        await expect(memoryManager.createPlanWithTasks(agentId, planData, tasksData as any)).rejects.toThrow();

        const plans = await db.all(`SELECT * FROM plans WHERE agent_id = ? AND title = 'Faulty Plan'`, agentId);
        expect(plans).toHaveLength(0);
    });

    it('should retrieve a specific plan by ID', async () => {
        const agentId = 'test-agent-1';
        const planId = randomUUID();
        const timestamp = Date.now();
        await db.run(
            `INSERT INTO plans (plan_id, agent_id, title, creation_timestamp_unix, creation_timestamp_iso, last_updated_timestamp_unix, last_updated_timestamp_iso, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            planId, agentId, 'My Test Plan', timestamp, new Date(timestamp).toISOString(), timestamp, new Date(timestamp).toISOString(), 'DRAFT'
        );

        const retrievedPlan = await memoryManager.getPlan(agentId, planId);
        expect(retrievedPlan).toBeDefined();
        expect((retrievedPlan as any).plan_id).toBe(planId);
        expect((retrievedPlan as any).title).toBe('My Test Plan');
    });

    it('should list plans for an agent, optionally filtered by status', async () => {
        const agentId = 'test-agent-1';
        const ts = Date.now();
        const planId1 = randomUUID();
        const planId2 = randomUUID();
        const planId3 = randomUUID();

        await db.run(`INSERT INTO plans (plan_id, agent_id, title, status, creation_timestamp_unix, creation_timestamp_iso, last_updated_timestamp_unix, last_updated_timestamp_iso) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, planId1, agentId, 'Plan 1', 'COMPLETED', ts, new Date(ts).toISOString(), ts, new Date(ts).toISOString());
        await db.run(`INSERT INTO plans (plan_id, agent_id, title, status, creation_timestamp_unix, creation_timestamp_iso, last_updated_timestamp_unix, last_updated_timestamp_iso) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, planId2, agentId, 'Plan 2', 'IN_PROGRESS', ts + 1, new Date(ts+1).toISOString(), ts + 1, new Date(ts+1).toISOString());
        await db.run(`INSERT INTO plans (plan_id, agent_id, title, status, creation_timestamp_unix, creation_timestamp_iso, last_updated_timestamp_unix, last_updated_timestamp_iso) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, planId3, agentId, 'Plan 3', 'COMPLETED', ts + 2, new Date(ts+2).toISOString(), ts + 2, new Date(ts+2).toISOString());

        const allPlans = await memoryManager.getPlans(agentId);
        expect(allPlans).toHaveLength(3);

        const completedPlans = await memoryManager.getPlans(agentId, 'COMPLETED');
        expect(completedPlans).toHaveLength(2);
        completedPlans.forEach(plan => expect((plan as any).status).toBe('COMPLETED'));
    });


    it('should update plan status', async () => {
        const agentId = 'test-agent-1';
        const planId = randomUUID();
        const ts = Date.now();
        await db.run(`INSERT INTO plans (plan_id, agent_id, title, status, creation_timestamp_unix, creation_timestamp_iso, last_updated_timestamp_unix, last_updated_timestamp_iso) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, planId, agentId, 'Updatable Plan', 'DRAFT', ts, new Date(ts).toISOString(), ts, new Date(ts).toISOString());

        const success = await memoryManager.updatePlanStatus(agentId, planId, 'APPROVED');
        expect(success).toBe(true);

        const updatedPlan: any = await db.get(`SELECT status, last_updated_timestamp_unix FROM plans WHERE plan_id = ?`, planId);
        expect(updatedPlan.status).toBe('APPROVED');
        expect(updatedPlan.last_updated_timestamp_unix).toBeGreaterThanOrEqual(ts); // Timestamps are tricky; allow greater or equal
    });

    it('should update task status and completion timestamp', async () => {
        const agentId = 'test-agent-1';
        const planId = randomUUID();
        const taskId = randomUUID();
        const ts = Date.now();
        // Create a plan first
        await db.run(`INSERT INTO plans (plan_id, agent_id, title, creation_timestamp_unix, creation_timestamp_iso, last_updated_timestamp_unix, last_updated_timestamp_iso, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            planId, agentId, 'Plan for Task Update', ts, new Date(ts).toISOString(), ts, new Date(ts).toISOString(), 'DRAFT');
        // Then create the task linked to the plan
        await db.run(`INSERT INTO plan_tasks (task_id, plan_id, agent_id, task_number, title, status, creation_timestamp_unix, creation_timestamp_iso, last_updated_timestamp_unix, last_updated_timestamp_iso) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            taskId, planId, agentId, 1, 'Task to Update', 'PLANNED', ts, new Date(ts).toISOString(), ts, new Date(ts).toISOString());

        const completionTs = Date.now() + 1000; // Ensure this is later
        const success = await memoryManager.updateTaskDetails(agentId, taskId, { status: 'COMPLETED' }, completionTs);
        expect(success).toBe(true);

        const updatedTask: any = await db.get(`SELECT status, last_updated_timestamp_unix, completion_timestamp_unix FROM plan_tasks WHERE task_id = ?`, taskId);
        expect(updatedTask.status).toBe('COMPLETED');
        expect(updatedTask.last_updated_timestamp_unix).toBeGreaterThanOrEqual(ts);
        expect(updatedTask.completion_timestamp_unix).toBe(completionTs);
    });

    it('should retrieve a specific task by ID and parse JSON fields', async () => {
        const agentId = 'test-agent-1';
        const planId = randomUUID();
        const taskId = randomUUID();
        const ts = Date.now();
        const notesData = { important: 'note', version: 2 };
        // Create plan
        await db.run(`INSERT INTO plans (plan_id, agent_id, title, creation_timestamp_unix, creation_timestamp_iso, last_updated_timestamp_unix, last_updated_timestamp_iso, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            planId, agentId, 'Plan for Single Task', ts, new Date(ts).toISOString(), ts, new Date(ts).toISOString(), 'DRAFT');
        // Create task with notes_json
        await db.run(`INSERT INTO plan_tasks (task_id, plan_id, agent_id, task_number, title, creation_timestamp_unix, creation_timestamp_iso, last_updated_timestamp_unix, last_updated_timestamp_iso, notes_json, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            taskId, planId, agentId, 1, 'Single Task', ts, new Date(ts).toISOString(), ts, new Date(ts).toISOString(), JSON.stringify(notesData), 'PLANNED');

        const retrievedTask = await memoryManager.getTask(agentId, taskId) as any; // Cast to any to access dynamic properties
        expect(retrievedTask).toBeDefined();
        expect(retrievedTask.task_id).toBe(taskId);
        expect(retrievedTask.title).toBe('Single Task');
        expect(retrievedTask.notes).toEqual(notesData); // getTask should parse notes_json
    });

    it('should add a new task to an existing plan', async () => {
        const agentId = 'test-agent-1';
        const planId = randomUUID();
        const ts = Date.now();
        await db.run(`INSERT INTO plans (plan_id, agent_id, title, creation_timestamp_unix, creation_timestamp_iso, last_updated_timestamp_unix, last_updated_timestamp_iso, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            planId, agentId, 'Plan for Adding Task', ts, new Date(ts).toISOString(), ts, new Date(ts).toISOString(), 'DRAFT');

        const newTaskData = { task_number: 1, title: 'New Task for Existing Plan', description: 'This task is added later.' };
        const newTaskId = await memoryManager.addTaskToPlan(agentId, planId, newTaskData);
        expect(newTaskId).toBeDefined();

        const retrievedTask: any = await db.get(`SELECT * FROM plan_tasks WHERE task_id = ?`, newTaskId);
        expect(retrievedTask).toBeDefined();
        expect(retrievedTask.title).toBe('New Task for Existing Plan');
        expect(retrievedTask.plan_id).toBe(planId);
    });
});
