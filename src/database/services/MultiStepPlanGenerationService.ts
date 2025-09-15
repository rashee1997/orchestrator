// src/database/services/MultiStepPlanGenerationService.ts

import { MemoryManager } from '../memory_manager.js';
import { GeminiIntegrationService } from './GeminiIntegrationService.js';
import { MultiModelOrchestrator, RagTaskType } from '../../tools/rag/multi_model_orchestrator.js';
import { parseGeminiJsonResponse } from './gemini-integration-modules/GeminiResponseParsers.js';

export interface PlanGenerationProgress {
    planId: string;
    agentId: string;
    currentStep: number;
    totalSteps: number;
    completedTasks: number;
    planData?: {
        plan_title: string;
        estimated_duration_days: number;
        target_start_date: string;
        target_end_date: string;
        kpis: string[];
        dependency_analysis: string;
        plan_risks_and_mitigations: any[];
    };
    tasks: any[];
    isComplete: boolean;
    createdAt: Date;
    updatedAt: Date;
}

export interface TaskGenerationContext {
    existingTasks: any[];
    completedTaskNumbers: number[];
    nextTaskNumber: number;
    totalExpectedTasks: number;
    planContext: string;
}

export class MultiStepPlanGenerationService {
    private memoryManager: MemoryManager;
    private multiModelOrchestrator: MultiModelOrchestrator;
    private geminiService: GeminiIntegrationService;

    constructor(
        memoryManager: MemoryManager, 
        geminiService: GeminiIntegrationService,
        multiModelOrchestrator: MultiModelOrchestrator
    ) {
        this.memoryManager = memoryManager;
        this.geminiService = geminiService;
        this.multiModelOrchestrator = multiModelOrchestrator;
    }

    /**
     * Step 1: Generate the initial plan structure (metadata only, no tasks)
     */
    async generatePlanStructure(
        agentId: string,
        goalDescription: string,
        liveFiles: Array<{ path: string; content: string }> = []
    ): Promise<PlanGenerationProgress> {
        console.log(`[Multi-Step Plan] Step 1: Generating plan structure for agent ${agentId}`);
        
        const liveFileContext = liveFiles.map(file => 
            `File: ${file.path}\n${file.content.substring(0, 2000)}${file.content.length > 2000 ? '...[truncated]' : ''}`
        ).join('\n\n');

        const planStructurePrompt = `
You are an expert project planning assistant. Generate ONLY the plan metadata (no tasks) for the following goal.

GOAL: ${goalDescription}

${liveFileContext ? `CODEBASE CONTEXT:\n${liveFileContext}` : ''}

Generate a JSON response with ONLY the following structure (DO NOT include tasks array):

{
  "plan_title": "Clear, descriptive title for the plan",
  "estimated_duration_days": 25,
  "target_start_date": "2025-09-15",
  "target_end_date": "2025-10-15",
  "estimated_total_tasks": 12,
  "kpis": [
    "Specific KPI 1",
    "Specific KPI 2",
    "Specific KPI 3"
  ],
  "dependency_analysis": "Detailed analysis of dependencies and critical path",
  "plan_risks_and_mitigations": [
    {
      "risk_description": "Specific risk description",
      "mitigation_strategy": "Detailed mitigation approach"
    }
  ]
}

IMPORTANT: 
- Do NOT include a "tasks" array - this will be generated separately
- Estimate realistic duration and task count
- Be specific and actionable in all fields
- Focus on quality over quantity
`;

        try {
            const response = await this.multiModelOrchestrator.executeTask(
                'planning' as RagTaskType,
                planStructurePrompt,
                'You are an expert project planning assistant focused on creating detailed, actionable project plans.',
                { contextLength: planStructurePrompt.length }
            );

            const planData = await parseGeminiJsonResponse(response.content || '', {
                expectedStructure: 'Plan structure without tasks',
                contextDescription: 'Plan metadata generation',
                memoryManager: this.memoryManager,
                geminiService: this.geminiService
            });

            const planId = `plan_${agentId}_${Date.now()}`;
            const progress: PlanGenerationProgress = {
                planId,
                agentId,
                currentStep: 1,
                totalSteps: Math.ceil((planData.estimated_total_tasks || 10) / 2) + 1, // +1 for structure step
                completedTasks: 0,
                planData: {
                    plan_title: planData.plan_title || 'Generated Plan',
                    estimated_duration_days: planData.estimated_duration_days || 30,
                    target_start_date: planData.target_start_date || '2025-09-15',
                    target_end_date: planData.target_end_date || '2025-10-15',
                    kpis: planData.kpis || [],
                    dependency_analysis: planData.dependency_analysis || '',
                    plan_risks_and_mitigations: planData.plan_risks_and_mitigations || []
                },
                tasks: [],
                isComplete: false,
                createdAt: new Date(),
                updatedAt: new Date()
            };

            console.log(`[Multi-Step Plan] ✅ Plan structure created: "${progress.planData?.plan_title}", estimated ${planData.estimated_total_tasks} tasks`);
            return progress;

        } catch (error) {
            console.error('[Multi-Step Plan] Failed to generate plan structure:', error);
            throw new Error(`Plan structure generation failed: ${error}`);
        }
    }

    /**
     * Step 2+: Generate tasks in batches of 1-2 tasks per step
     */
    async generateNextTaskBatch(
        progress: PlanGenerationProgress,
        goalDescription: string,
        liveFiles: Array<{ path: string; content: string }> = [],
        batchSize: number = 2
    ): Promise<PlanGenerationProgress> {
        const stepNumber = progress.currentStep + 1;
        console.log(`[Multi-Step Plan] Step ${stepNumber}: Generating next batch of ${batchSize} tasks`);

        if (progress.isComplete) {
            console.log(`[Multi-Step Plan] Plan already complete`);
            return progress;
        }

        const context = this.buildTaskGenerationContext(progress);
        const liveFileContext = liveFiles.map(file => 
            `File: ${file.path}\n${file.content.substring(0, 1000)}${file.content.length > 1000 ? '...[truncated]' : ''}`
        ).join('\n\n');

        const taskGenerationPrompt = `
You are an expert project planning assistant continuing a plan generation process.

ORIGINAL GOAL: ${goalDescription}

PLAN CONTEXT:
- Title: ${progress.planData?.plan_title}
- Duration: ${progress.planData?.estimated_duration_days} days
- KPIs: ${progress.planData?.kpis?.join(', ')}

EXISTING TASKS SUMMARY:
${context.existingTasks.length > 0 ? 
    context.existingTasks.map(task => `Task ${task.task_number}: ${task.title}`).join('\n') : 
    'No tasks created yet - this is the first batch'}

TASK GENERATION CONTEXT:
- Next task number to generate: ${context.nextTaskNumber}
- Tasks to generate in this batch: ${batchSize}
- Total tasks planned: ~${context.totalExpectedTasks}
- Completed tasks: ${context.completedTaskNumbers.join(', ') || 'None'}

${liveFileContext ? `CODEBASE CONTEXT:\n${liveFileContext}` : ''}

Generate exactly ${batchSize} tasks continuing from task number ${context.nextTaskNumber}. 

IMPORTANT REQUIREMENTS:
1. Tasks must be sequential and build upon previous tasks
2. Each task must have unique task_number starting from ${context.nextTaskNumber}
3. Consider dependencies on previously generated tasks
4. Avoid duplicating any existing task functionality
5. Tasks should be detailed and actionable

Generate a JSON response with this structure:

{
  "tasks": [
    {
      "task_number": ${context.nextTaskNumber},
      "title": "Specific, actionable task title",
      "description": "Detailed description of what needs to be done",
      "purpose": "Why this task is important in the overall plan",
      "estimated_duration_days": 2,
      "estimated_effort_hours": 16,
      "assigned_to": "AI Agent",
      "status": "PLANNED",
      "dependencies_task_ids": [${context.completedTaskNumbers.slice(-3).join(', ')}],
      "suggested_files_involved": ["file/path1.ts", "file/path2.ts"],
      "completion_criteria": "Clear criteria for when this task is complete",
      "code_content": "// Sample code or diff if applicable"
    }
  ],
  "batch_summary": "Brief summary of what these tasks accomplish",
  "progress_assessment": "Assessment of overall plan progress after this batch"
}

CRITICAL: Ensure task_number starts at ${context.nextTaskNumber} and increments sequentially. Do not duplicate any existing task numbers: ${context.completedTaskNumbers.join(', ')}
`;

        try {
            const response = await this.multiModelOrchestrator.executeTask(
                'planning' as RagTaskType,
                taskGenerationPrompt,
                'You are an expert project planning assistant generating detailed, sequential tasks.',
                { contextLength: taskGenerationPrompt.length }
            );

            const taskBatchData = await parseGeminiJsonResponse(response.content || '', {
                expectedStructure: 'Task batch with tasks array',
                contextDescription: `Task batch generation for step ${stepNumber}`,
                memoryManager: this.memoryManager,
                geminiService: this.geminiService
            });

            if (!taskBatchData.tasks || !Array.isArray(taskBatchData.tasks)) {
                throw new Error('Generated response does not contain valid tasks array');
            }

            // Validate and clean task numbers to prevent duplicates
            const newTasks = taskBatchData.tasks.map((task, index) => ({
                ...task,
                task_number: context.nextTaskNumber + index,
                dependencies_task_ids_json: JSON.stringify(task.dependencies_task_ids || []),
                suggested_files_involved_json: JSON.stringify(task.suggested_files_involved || []),
                tools_required_list_json: JSON.stringify(task.tools_required_list || []),
            }));

            // Update progress
            progress.tasks.push(...newTasks);
            progress.currentStep = stepNumber;
            progress.completedTasks += newTasks.length;
            progress.updatedAt = new Date();

            // Check if we should continue or complete
            const estimatedTotal = context.totalExpectedTasks;
            const shouldComplete = progress.completedTasks >= estimatedTotal || 
                                 progress.currentStep >= progress.totalSteps ||
                                 stepNumber > 20; // Safety limit

            if (shouldComplete) {
                progress.isComplete = true;
                console.log(`[Multi-Step Plan] ✅ Plan generation complete: ${progress.completedTasks} tasks generated`);
            } else {
                console.log(`[Multi-Step Plan] ✅ Batch ${stepNumber} complete: ${newTasks.length} tasks added (${progress.completedTasks}/${estimatedTotal} total)`);
            }

            return progress;

        } catch (error) {
            console.error(`[Multi-Step Plan] Failed to generate task batch for step ${stepNumber}:`, error);
            throw new Error(`Task batch generation failed: ${error}`);
        }
    }

    /**
     * Complete the entire multi-step plan generation process
     */
    async generateCompletePlan(
        agentId: string,
        goalDescription: string,
        liveFiles: Array<{ path: string; content: string }> = [],
        maxSteps: number = 20
    ): Promise<PlanGenerationProgress> {
        console.log(`[Multi-Step Plan] Starting complete plan generation for agent ${agentId}`);

        // Step 1: Generate plan structure
        let progress = await this.generatePlanStructure(agentId, goalDescription, liveFiles);

        // Steps 2+: Generate tasks in batches
        let stepCount = 1;
        while (!progress.isComplete && stepCount < maxSteps) {
            stepCount++;
            console.log(`[Multi-Step Plan] Executing step ${stepCount}/${maxSteps}`);
            
            progress = await this.generateNextTaskBatch(progress, goalDescription, liveFiles, 2);
            
            // Small delay to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        if (!progress.isComplete && stepCount >= maxSteps) {
            console.warn(`[Multi-Step Plan] Reached maximum steps (${maxSteps}), marking as complete`);
            progress.isComplete = true;
        }

        console.log(`[Multi-Step Plan] 🎉 Complete plan generated: ${progress.tasks.length} tasks in ${stepCount} steps`);
        return progress;
    }

    /**
     * Build context for task generation based on current progress
     */
    private buildTaskGenerationContext(progress: PlanGenerationProgress): TaskGenerationContext {
        const existingTasks = progress.tasks || [];
        const completedTaskNumbers = existingTasks.map(task => task.task_number);
        const nextTaskNumber = existingTasks.length > 0 ? Math.max(...completedTaskNumbers) + 1 : 1;
        
        // Estimate total tasks based on plan data or use reasonable default
        const estimatedFromDuration = Math.ceil((progress.planData?.estimated_duration_days || 30) / 2.5);
        const totalExpectedTasks = estimatedFromDuration;

        return {
            existingTasks,
            completedTaskNumbers,
            nextTaskNumber,
            totalExpectedTasks,
            planContext: `${progress.planData?.plan_title} - ${progress.planData?.dependency_analysis?.substring(0, 200)}...`
        };
    }

    /**
     * Convert progress to database-ready format
     */
    convertToDbFormat(progress: PlanGenerationProgress, refinedPromptId?: string) {
        const planData = {
            title: progress.planData?.plan_title || 'Multi-Step Generated Plan',
            overall_goal: `Generated via multi-step process: ${progress.planData?.plan_title}`,
            status: 'DRAFT',
            version: 1,
            refined_prompt_id_associated: refinedPromptId || null,
            metadata: {
                estimated_duration_days: progress.planData?.estimated_duration_days,
                target_start_date: progress.planData?.target_start_date,
                target_end_date: progress.planData?.target_end_date,
                kpis: progress.planData?.kpis,
                dependency_analysis: progress.planData?.dependency_analysis,
                plan_risks_and_mitigations: progress.planData?.plan_risks_and_mitigations,
                generation_method: 'multi-step',
                total_steps: progress.currentStep,
                generation_completed: progress.isComplete
            }
        };

        return {
            planData,
            tasks: progress.tasks
        };
    }
}