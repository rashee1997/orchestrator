import { DatabaseService } from '../database/services/DatabaseService.js';
import { SubtaskManager } from '../database/managers/SubtaskManager.js';
import { Database } from 'sqlite';

describe('SubtaskManager', () => {
    let dbService: DatabaseService;
    let subtaskManager: SubtaskManager;
    let db: Database;

    beforeAll(async () => {
        dbService = await DatabaseService.create();
        db = dbService.getDb();
        subtaskManager = new SubtaskManager(dbService);

        // Ensure tables are created for testing
        await db.exec(`
            CREATE TABLE IF NOT EXISTS plans (
                plan_id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                title TEXT NOT NULL,
                overall_goal TEXT,
                status TEXT NOT NULL DEFAULT 'DRAFT',
                version INTEGER NOT NULL DEFAULT 1,
                creation_timestamp_unix INTEGER NOT NULL,
                creation_timestamp_iso TEXT NOT NULL,
                last_updated_timestamp_unix INTEGER NOT NULL,
                last_updated_timestamp_iso TEXT NOT NULL,
                refined_prompt_id_associated TEXT,
                analysis_report_id_referenced TEXT,
                metadata TEXT
            );

            CREATE TABLE IF NOT EXISTS plan_tasks (
                task_id TEXT PRIMARY KEY,
                plan_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                task_number INTEGER NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                status TEXT NOT NULL DEFAULT 'PLANNED',
                purpose TEXT,
                action_description TEXT,
                files_involved TEXT,
                dependencies_task_ids TEXT,
                tools_required_list TEXT,
                inputs_summary TEXT,
                outputs_summary TEXT,
                success_criteria_text TEXT,
                estimated_effort_hours REAL,
                assigned_to TEXT,
                verification_method TEXT,
                creation_timestamp_unix INTEGER NOT NULL,
                creation_timestamp_iso TEXT NOT NULL,
                last_updated_timestamp_unix INTEGER NOT NULL,
                last_updated_timestamp_iso TEXT NOT NULL,
                completion_timestamp_unix INTEGER,
                completion_timestamp_iso TEXT,

                notes TEXT,
                FOREIGN KEY (plan_id) REFERENCES plans(plan_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS subtasks (
                subtask_id TEXT PRIMARY KEY,
                plan_id TEXT NOT NULL,
                parent_task_id TEXT,
                agent_id TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                status TEXT NOT NULL DEFAULT 'PLANNED',
                creation_timestamp_unix INTEGER NOT NULL,
                creation_timestamp_iso TEXT NOT NULL,
                last_updated_timestamp_unix INTEGER NOT NULL,
                last_updated_timestamp_iso TEXT NOT NULL,
                completion_timestamp_unix INTEGER,
                completion_timestamp_iso TEXT,
                notes TEXT,
                FOREIGN KEY (plan_id) REFERENCES plans(plan_id) ON DELETE CASCADE,
                FOREIGN KEY (parent_task_id) REFERENCES plan_tasks(task_id) ON DELETE CASCADE
            );
        `);
    });

    afterEach(async () => {
        // Clear tables after each test
        await db.run('DELETE FROM subtasks');
        await db.run('DELETE FROM plan_tasks');
        await db.run('DELETE FROM plans');
    });

    afterAll(async () => {
        await db.close();
    });

    const agentId = 'test-agent';
    let planId: string;
    let taskId: string;

    beforeEach(async () => {
        // Create a plan and a task for testing subtasks
        const planResult = await db.run(
            `INSERT INTO plans (plan_id, agent_id, title, creation_timestamp_unix, creation_timestamp_iso, last_updated_timestamp_unix, last_updated_timestamp_iso) VALUES (?, ?, ?, ?, ?, ?, ?)`, 
            'plan-123', agentId, 'Test Plan', Math.floor(Date.now() / 1000), new Date().toISOString(), Math.floor(Date.now() / 1000), new Date().toISOString()
        );
        planId = 'plan-123';

        const taskResult = await db.run(
            `INSERT INTO plan_tasks (task_id, plan_id, agent_id, task_number, title, creation_timestamp_unix, creation_timestamp_iso, last_updated_timestamp_unix, last_updated_timestamp_iso) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
            'task-456', planId, agentId, 1, 'Test Task', Math.floor(Date.now() / 1000), new Date().toISOString(), Math.floor(Date.now() / 1000), new Date().toISOString()
        );
        taskId = 'task-456';
    });

    it('should create a subtask linked to a plan', async () => {
        const subtaskData = { title: 'Subtask 1', description: 'Description for subtask 1' };
        const subtaskId = await subtaskManager.createSubtask(agentId, planId, subtaskData);
        expect(subtaskId).toBeDefined();

        const retrievedSubtask: any = await subtaskManager.getSubtask(agentId, subtaskId);
        expect(retrievedSubtask).toMatchObject({
            subtask_id: subtaskId,
            plan_id: planId,
            parent_task_id: null,
            agent_id: agentId,
            title: 'Subtask 1',
            description: 'Description for subtask 1',
            status: 'PLANNED'
        });
    });

    it('should create a subtask linked to a parent task', async () => {
        const subtaskData = { title: 'Subtask 2', parent_task_id: taskId, status: 'IN_PROGRESS' };
        const subtaskId = await subtaskManager.createSubtask(agentId, planId, subtaskData);
        expect(subtaskId).toBeDefined();

        const retrievedSubtask: any = await subtaskManager.getSubtask(agentId, subtaskId);
        expect(retrievedSubtask).toMatchObject({
            subtask_id: subtaskId,
            plan_id: planId,
            parent_task_id: taskId,
            agent_id: agentId,
            title: 'Subtask 2',
            status: 'IN_PROGRESS'
        });
    });

    it('should retrieve subtasks by plan ID', async () => {
        await subtaskManager.createSubtask(agentId, planId, { title: 'Subtask A' });
        await subtaskManager.createSubtask(agentId, planId, { title: 'Subtask B', parent_task_id: taskId });

        const subtasks: any[] = await subtaskManager.getSubtasksByPlan(agentId, planId);
        expect(subtasks.length).toBe(2);
        expect(subtasks.some((s: any) => s.title === 'Subtask A')).toBe(true);
        expect(subtasks.some((s: any) => s.title === 'Subtask B')).toBe(true);
    });

    it('should retrieve subtasks by parent task ID', async () => {
        await subtaskManager.createSubtask(agentId, planId, { title: 'Subtask X', parent_task_id: taskId });
        await subtaskManager.createSubtask(agentId, planId, { title: 'Subtask Y', parent_task_id: taskId });
        await subtaskManager.createSubtask(agentId, planId, { title: 'Subtask Z' }); // Not linked to task

        const subtasks: any[] = await subtaskManager.getSubtasksByParentTask(agentId, taskId);
        expect(subtasks.length).toBe(2);
        expect(subtasks.some((s: any) => s.title === 'Subtask X')).toBe(true);
        expect(subtasks.some((s: any) => s.title === 'Subtask Y')).toBe(true);
        expect(subtasks.some((s: any) => s.title === 'Subtask Z')).toBe(false);
    });

    it('should update subtask status', async () => {
        const subtaskId = await subtaskManager.createSubtask(agentId, planId, { title: 'Subtask to Update' });
        const success = await subtaskManager.updateSubtaskDetails(agentId, subtaskId, { status: 'COMPLETED' });
        expect(success).toBe(true);

        const updatedSubtask: any = await subtaskManager.getSubtask(agentId, subtaskId);
        expect(updatedSubtask).toMatchObject({ status: 'COMPLETED' });
        expect(updatedSubtask?.completion_timestamp).toBeDefined();
    });

    it('should delete a subtask', async () => {
        const subtaskId = await subtaskManager.createSubtask(agentId, planId, { title: 'Subtask to Delete' });
        const success = await subtaskManager.deleteSubtask(agentId, subtaskId);
        expect(success).toBe(true);

        const deletedSubtask = await subtaskManager.getSubtask(agentId, subtaskId);
        expect(deletedSubtask).toBeNull();
    });

    it('should filter subtasks by status', async () => {
        await subtaskManager.createSubtask(agentId, planId, { title: 'Subtask P', status: 'PLANNED' });
        await subtaskManager.createSubtask(agentId, planId, { title: 'Subtask I', status: 'IN_PROGRESS' });
        await subtaskManager.createSubtask(agentId, planId, { title: 'Subtask C', status: 'COMPLETED' });

        const plannedSubtasks: any[] = await subtaskManager.getSubtasksByPlan(agentId, planId, 'PLANNED');
        expect(plannedSubtasks.length).toBe(1);
        expect(plannedSubtasks[0].title).toBe('Subtask P');

        const inProgressSubtasks: any[] = await subtaskManager.getSubtasksByPlan(agentId, planId, 'IN_PROGRESS');
        expect(inProgressSubtasks.length).toBe(1);
        expect(inProgressSubtasks[0].title).toBe('Subtask I');
    });

    it('should handle non-existent plan when creating subtask', async () => {
        const subtaskData = { title: 'Invalid Subtask' };
        await expect(subtaskManager.createSubtask(agentId, 'non-existent-plan', subtaskData)).rejects.toThrow('Plan with ID non-existent-plan not found for agent test-agent.');
    });

    it('should handle non-existent parent task when creating subtask', async () => {
        const subtaskData = { title: 'Invalid Subtask', parent_task_id: 'non-existent-task' };
        await expect(subtaskManager.createSubtask(agentId, planId, subtaskData)).rejects.toThrow(`Parent task with ID non-existent-task not found in plan ${planId} for agent ${agentId}.`);
    });
});
