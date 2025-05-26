import { MemoryManager } from '../database/memory_manager.js';
import { initializeDatabase, getDatabase } from '../database/db.js';
import { Database } from 'sqlite';
import {
    ToolExecutionLog,
    TaskProgressLog,
    ErrorLog,
    CorrectionLog // This type defines original_value_json and corrected_value_json
} from '../types/index.js';

describe('Logging System Integration Tests', () => {
    let memoryManager: MemoryManager;
    let db: Database;
    const agentId = 'test-agent'; // Default agent for most tests
    const anotherAgentId = 'another-test-agent'; // For specific test cases if needed

    beforeAll(async () => {
        db = await initializeDatabase();
        memoryManager = await MemoryManager.create();

        await db.run(
            `INSERT OR IGNORE INTO agents (agent_id, name, description, creation_timestamp_unix, creation_timestamp_iso, status) VALUES (?, ?, ?, ?, ?, ?)`,
            agentId, 'Test Agent for Logging', 'Agent specifically for logging tests', Math.floor(Date.now() / 1000), new Date().toISOString(), 'ACTIVE'
        );
        await db.run(
            `INSERT OR IGNORE INTO agents (agent_id, name, description, creation_timestamp_unix, creation_timestamp_iso, status) VALUES (?, ?, ?, ?, ?, ?)`,
            anotherAgentId, 'Another Test Agent', 'Another agent for specific logging test scenarios', Math.floor(Date.now() / 1000), new Date().toISOString(), 'ACTIVE'
        );
        console.log(`Ensured agents '${agentId}' and '${anotherAgentId}' exist for logging tests.`);
    });

    afterAll(async () => {
        await db.close();
    });

    beforeEach(async () => {
        await db.run(`DELETE FROM tool_execution_logs`);
        await db.run(`DELETE FROM task_progress_logs`);
        await db.run(`DELETE FROM error_logs`);
        await db.run(`DELETE FROM correction_logs`);
    });

    describe('ToolExecutionLogManager', () => {
        it('should log a tool execution and retrieve it', async () => {
            const logData: Omit<ToolExecutionLog, 'log_id' | 'log_creation_timestamp_unix' | 'log_creation_timestamp_iso' | 'last_updated_timestamp_unix' | 'last_updated_timestamp_iso'> = {
                agent_id: agentId,
                tool_name: 'test_tool',
                arguments_json: JSON.stringify({ param1: 'value1' }),
                status: 'SUCCESS',
                output_summary: 'Tool executed successfully',
                execution_start_timestamp_unix: Date.now(),
                execution_start_timestamp_iso: new Date().toISOString(),
                execution_end_timestamp_unix: Date.now() + 100,
                execution_end_timestamp_iso: new Date(Date.now() + 100).toISOString(),
                duration_ms: 100,
                step_number_executed: '1',
                plan_step_title: 'Test Plan Step',
                plan_id: null,
                task_id: null,
                subtask_id: null
            };

            const logId = await memoryManager.toolExecutionLogManager.createToolExecutionLog(logData);
            expect(logId).toBeDefined();

            const retrievedLog = await memoryManager.toolExecutionLogManager.getToolExecutionLogById(logId);
            expect(retrievedLog).toBeDefined();
            expect(retrievedLog?.agent_id).toBe(agentId);
            expect(retrievedLog?.tool_name).toBe('test_tool');
            expect(retrievedLog?.arguments_json).toBe(JSON.stringify({ param1: 'value1' }));
        });

        it('should retrieve multiple tool execution logs for a specific agent', async () => {
            const logData1: Omit<ToolExecutionLog, 'log_id' | 'log_creation_timestamp_unix' | 'log_creation_timestamp_iso' | 'last_updated_timestamp_unix' | 'last_updated_timestamp_iso'> = {
                agent_id: agentId, tool_name: 'tool1', arguments_json: "{}", status: 'SUCCESS', output_summary: '1', execution_start_timestamp_unix: Date.now(), execution_start_timestamp_iso: new Date().toISOString(), execution_end_timestamp_unix: null, execution_end_timestamp_iso: null, duration_ms: null, step_number_executed: null, plan_step_title: null, plan_id: null, task_id: null, subtask_id: null
            };
            const logData2: Omit<ToolExecutionLog, 'log_id' | 'log_creation_timestamp_unix' | 'log_creation_timestamp_iso' | 'last_updated_timestamp_unix' | 'last_updated_timestamp_iso'> = {
                agent_id: agentId, tool_name: 'tool2', arguments_json: "{}", status: 'FAILURE', output_summary: '2', execution_start_timestamp_unix: Date.now() + 1, execution_start_timestamp_iso: new Date(Date.now() + 1).toISOString(), execution_end_timestamp_unix: null, execution_end_timestamp_iso: null, duration_ms: null, step_number_executed: null, plan_step_title: null, plan_id: null, task_id: null, subtask_id: null
            };
            const logData3: Omit<ToolExecutionLog, 'log_id' | 'log_creation_timestamp_unix' | 'log_creation_timestamp_iso' | 'last_updated_timestamp_unix' | 'last_updated_timestamp_iso'> = {
                agent_id: anotherAgentId, tool_name: 'tool3', arguments_json: "{}", status: 'SUCCESS', output_summary: '3', execution_start_timestamp_unix: Date.now() + 2, execution_start_timestamp_iso: new Date(Date.now() + 2).toISOString(), execution_end_timestamp_unix: null, execution_end_timestamp_iso: null, duration_ms: null, step_number_executed: null, plan_step_title: null, plan_id: null, task_id: null, subtask_id: null
            };

            await memoryManager.toolExecutionLogManager.createToolExecutionLog(logData1);
            await memoryManager.toolExecutionLogManager.createToolExecutionLog(logData2);
            await memoryManager.toolExecutionLogManager.createToolExecutionLog(logData3);

            const logs = await memoryManager.toolExecutionLogManager.getToolExecutionLogsByAgentId(agentId);
            expect(logs.length).toBe(2);
            expect(logs.find(log => log.tool_name === 'tool1')).toBeDefined();
            expect(logs.find(log => log.tool_name === 'tool2')).toBeDefined();
            expect(logs.find(log => log.tool_name === 'tool3')).toBeUndefined();
        });
    });

    describe('TaskProgressLogManager', () => {
        it('should log task progress and retrieve it', async () => {
            const logData: Omit<TaskProgressLog, 'progress_log_id' | 'execution_timestamp_unix' | 'execution_timestamp_iso' | 'log_creation_timestamp_unix' | 'log_creation_timestamp_iso' | 'last_updated_timestamp_unix' | 'last_updated_timestamp_iso'> = {
                agent_id: agentId,
                associated_plan_id: 'plan-123',
                associated_task_id: 'task-456',
                associated_subtask_id: null,
                step_number_executed: '1',
                plan_step_title: 'Initial Setup',
                action_tool_used: 'create_file',
                tool_parameters_summary_json: JSON.stringify({ path: 'test.txt' }),
                files_modified_list_json: JSON.stringify(['test.txt']),
                change_summary_text: 'Created test file',
                status_of_step_execution: 'INTERNAL_SUCCESS',
                output_summary_or_error: 'File created.'
            };

            const logId = await memoryManager.taskProgressLogManager.createTaskProgressLog(logData);
            expect(logId).toBeDefined();

            const retrievedLog = await memoryManager.taskProgressLogManager.getTaskProgressLogById(logId);
            expect(retrievedLog).toBeDefined();
            expect(retrievedLog?.agent_id).toBe(agentId);
            expect(retrievedLog?.associated_plan_id).toBe('plan-123');
            expect(retrievedLog?.tool_parameters_summary_json).toBe(JSON.stringify({ path: 'test.txt' }));
            expect(retrievedLog?.files_modified_list_json).toBe(JSON.stringify(['test.txt']));
        });
    });

    describe('ErrorLogManager', () => {
        it('should log an error and retrieve it', async () => {
            const logData: Omit<ErrorLog, 'error_log_id' | 'log_creation_timestamp_unix' | 'log_creation_timestamp_iso' | 'last_updated_timestamp_unix' | 'last_updated_timestamp_iso'> = {
                agent_id: agentId,
                error_type: 'VALIDATION_ERROR',
                error_message: 'Invalid input provided',
                stack_trace: null,
                source_file: 'test.ts',
                source_line: 10,
                severity: 'MEDIUM',
                status: 'NEW',
                resolution_details: null,
                error_timestamp_unix: Date.now(),
                error_timestamp_iso: new Date().toISOString(),
                associated_plan_id: 'plan-abc',
                associated_task_id: 'task-xyz',
                associated_subtask_id: null,
                associated_tool_execution_log_id: null
            };

            const logId = await memoryManager.errorLogManager.createErrorLog(logData);
            expect(logId).toBeDefined();

            const retrievedLog = await memoryManager.errorLogManager.getErrorLogById(logId);
            expect(retrievedLog).toBeDefined();
            expect(retrievedLog?.agent_id).toBe(agentId);
            expect(retrievedLog?.error_type).toBe('VALIDATION_ERROR');
        });
    });

    describe('CorrectionLogManager', () => {
        it('should log a correction and retrieve it', async () => {
            // Define input data matching the parameters of `logCorrection` method
            const logInputData = {
                agent_id: agentId,
                correction_type: 'user_feedback',
                original_entry_id: 'conv-123',
                original_value: { old: 'value' }, // Object, as expected by logCorrection method
                corrected_value: { new: 'value' }, // Object, as expected by logCorrection method
                reason: 'User corrected input',
                correction_summary: 'Summary of user correction',
                applied_automatically: false,
                status: 'LOGGED'
            };

            const logId = await memoryManager.correctionLogManager.logCorrection(
                logInputData.agent_id,
                logInputData.correction_type,
                logInputData.original_entry_id,
                logInputData.original_value,
                logInputData.corrected_value,
                logInputData.reason,
                logInputData.correction_summary,
                logInputData.applied_automatically,
                logInputData.status
            );
            expect(logId).toBeDefined();

            const retrievedLogs = await memoryManager.correctionLogManager.getCorrectionLogs(agentId);
            expect(retrievedLogs).toBeDefined();
            expect(retrievedLogs.length).toBeGreaterThan(0);
            
            // Assert the type of retrievedLog to include the dynamically added properties
            const retrievedLog = retrievedLogs.find(log => log.correction_id === logId) as (CorrectionLog & { original_value?: any; corrected_value?: any; }) | undefined;

            expect(retrievedLog).toBeDefined();
            expect(retrievedLog?.agent_id).toBe(agentId);
            expect(retrievedLog?.correction_type).toBe('user_feedback');
            // Assert against the parsed object properties added by getCorrectionLogs
            expect(retrievedLog?.original_value).toEqual({ old: 'value' });
            expect(retrievedLog?.corrected_value).toEqual({ new: 'value' });
            expect(retrievedLog?.applied_automatically).toBe(0); 
        });

        it('should throw an error if logging a correction for a non-existent agent', async () => {
            const nonExistentAgentId = 'non-existent-agent-for-correction';
            const logInputData = { // Renamed from logData to logInputData for clarity
                agent_id: nonExistentAgentId,
                correction_type: 'test_type',
                original_entry_id: null,
                original_value: null,
                corrected_value: null,
                reason: null,
                correction_summary: null,
                applied_automatically: false,
                status: 'LOGGED'
            };
            await expect(memoryManager.correctionLogManager.logCorrection(
                logInputData.agent_id,
                logInputData.correction_type,
                logInputData.original_entry_id,
                logInputData.original_value,
                logInputData.corrected_value,
                logInputData.reason,
                logInputData.correction_summary,
                logInputData.applied_automatically,
                logInputData.status
            )).rejects.toThrow(`Agent with ID '${nonExistentAgentId}' not found. Cannot log correction.`);
        });
    });
});
