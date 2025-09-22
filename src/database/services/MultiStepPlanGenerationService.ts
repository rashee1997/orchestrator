import { MemoryManager } from '../memory_manager.js';
import { GeminiIntegrationService } from './GeminiIntegrationService.js';
import { parseGeminiJsonResponse } from './gemini-integration-modules/GeminiResponseParsers.js';
import {
    PLANNER_SYSTEM_INSTRUCTION_REFINED_PROMPT,
    PLANNER_USER_QUERY_REFINED_PROMPT,
    PLANNER_SYSTEM_INSTRUCTION_GOAL_PROMPT,
    PLANNER_USER_QUERY_GOAL_PROMPT
} from './gemini-integration-modules/GeminiPlannerPrompts.js';
import { CodeGenerationService, TaskWithCode } from './multi-step-plan-generation/CodeGenerationService.js';

// Modularized imports
import { BatchInstruction, PlanGenerationProgress } from './multi-step-plan-generation/types.js';
import { callGemini } from './multi-step-plan-generation/gemini-interaction.js';
import { buildBatchPlanningPrompt, MULTISTEP_TASK_SYSTEM_INSTRUCTION, MULTISTEP_TASK_USER_QUERY } from './multi-step-plan-generation/prompts.js';
import * as PlanUtils from './multi-step-plan-generation/utils.js';
import { TaskConsolidationService } from './multi-step-plan-generation/TaskConsolidationService.js';
import { TestGenerationService } from './multi-step-plan-generation/TestGenerationService.js';

// New adaptive planning imports
import { DynamicPlanAnalyzer } from './multi-step-plan-generation/DynamicPlanAnalyzer.js';
import { AdaptiveBatchPlanner, RefinedPromptContext } from './multi-step-plan-generation/AdaptiveBatchPlanner.js';
import { AIIntentAnalyzer } from './multi-step-plan-generation/AIIntentAnalyzer.js';
import type { CodebaseIntrospectionService } from './CodebaseIntrospectionService.js';

export type { BatchInstruction, PlanGenerationProgress }; // Re-export for compatibility

export class MultiStepPlanGenerationService {
    private memoryManager: MemoryManager;
    private geminiService: GeminiIntegrationService;
    private codeGenerationService: CodeGenerationService;
    private taskConsolidationService: TaskConsolidationService;
    private testGenerationService: TestGenerationService;
    private dynamicPlanAnalyzer: DynamicPlanAnalyzer;
    private adaptiveBatchPlanner: AdaptiveBatchPlanner;
    private aiIntentAnalyzer: AIIntentAnalyzer;

    constructor(
        memoryManager: MemoryManager,
        geminiService: GeminiIntegrationService,
        projectRootPath: string = process.cwd(),
        introspectionService?: CodebaseIntrospectionService
    ) {
        this.memoryManager = memoryManager;
        this.geminiService = geminiService;
        this.codeGenerationService = new CodeGenerationService(geminiService, memoryManager);
        this.taskConsolidationService = new TaskConsolidationService(geminiService, memoryManager);
        this.testGenerationService = new TestGenerationService(geminiService);
        this.dynamicPlanAnalyzer = new DynamicPlanAnalyzer(projectRootPath, memoryManager, introspectionService);
        this.aiIntentAnalyzer = new AIIntentAnalyzer(geminiService, memoryManager);
        this.adaptiveBatchPlanner = new AdaptiveBatchPlanner(this.aiIntentAnalyzer);
    }

    async generatePlanStructure(
        agentId: string,
        identifier: string,
        isRefinedPromptId: boolean,
        liveFiles: Array<{ path: string; content: string }> = []
    ): Promise<PlanGenerationProgress> {
        console.log(`[Multi-Step Plan] Step 1: Intelligent analysis for agent ${agentId} (${isRefinedPromptId ? 'refined prompt' : 'direct goal'})`);
        
        try {
            const liveFilesContent = new Map(liveFiles.map(f => [f.path, f.content]));
            const originalPromptPayload = await this.buildPromptPayload(agentId, identifier, isRefinedPromptId, undefined, undefined, liveFilesContent);

            const today = new Date().toISOString().split('T')[0];
            const startDate = new Date();
            startDate.setDate(startDate.getDate() + 1);
            const startDateStr = startDate.toISOString().split('T')[0];
            const endDate = new Date(startDate);
            endDate.setDate(endDate.getDate() + 14);
            const endDateStr = endDate.toISOString().split('T')[0];

            // Use adaptive planning based on whether we have refined prompt or direct goal
            let adaptivePlan;
            let normalizedStrategy: BatchInstruction[];
            let normalizedHeader;

            if (isRefinedPromptId && originalPromptPayload?.refinedPromptDetails) {
                // Path 1: Use refined prompt with decomposed tasks
                console.log(`[Multi-Step Plan] Using refined prompt analysis with decomposed tasks`);

                const fileAnalyses = await Promise.all(
                    liveFiles.map(file => this.dynamicPlanAnalyzer.analyzeFile(file.path, file.content))
                );

                const refinedContext: RefinedPromptContext = {
                    overall_goal: originalPromptPayload.refinedPromptDetails.overall_goal,
                    decomposed_tasks: originalPromptPayload.refinedPromptDetails.decomposed_tasks_parsed || originalPromptPayload.refinedPromptDetails.decomposed_tasks || [],
                    key_entities_identified: originalPromptPayload.refinedPromptDetails.key_entities_identified_parsed || originalPromptPayload.refinedPromptDetails.key_entities_identified || [],
                    explicit_constraints_from_prompt: originalPromptPayload.refinedPromptDetails.explicit_constraints_from_prompt_parsed || originalPromptPayload.refinedPromptDetails.explicit_constraints_from_prompt || [],
                    implicit_assumptions_made_by_refiner: originalPromptPayload.refinedPromptDetails.implicit_assumptions_made_by_refiner_parsed || originalPromptPayload.refinedPromptDetails.implicit_assumptions_made_by_refiner || []
                };

                adaptivePlan = this.adaptiveBatchPlanner.createPlanFromRefinedPrompt(
                    refinedContext,
                    fileAnalyses,
                    startDateStr,
                    endDateStr
                );

                normalizedStrategy = adaptivePlan.adaptiveBatches;
                const defaultTitleSource = refinedContext.overall_goal || identifier;
                normalizedHeader = this.createPlanHeaderFromAdaptivePlan(adaptivePlan, defaultTitleSource, startDateStr, endDateStr);

            } else {
                // Path 2: Use enhanced AI-driven goal analysis
                console.log(`[Multi-Step Plan] Using AI-enhanced dynamic goal analysis`);

                const fileAnalyses = await Promise.all(
                    liveFiles.map(file => this.dynamicPlanAnalyzer.analyzeFile(file.path, file.content))
                );

                // Use AI intent analysis for intelligent planning
                adaptivePlan = await this.adaptiveBatchPlanner.createPlanWithAIAnalysis(
                    identifier,
                    fileAnalyses,
                    startDateStr,
                    endDateStr
                );

                // Check for legacy fallback
                if (adaptivePlan.usedLegacyFallback) {
                    console.log(`[Multi-Step Plan] 🔄 Using legacy planning for enterprise scenario: ${adaptivePlan.scenario?.name}`);
                    // Fall back to original planning logic for very complex scenarios
                    const planContext = await this.dynamicPlanAnalyzer.analyzePlanningContext(identifier, liveFiles);
                    const legacyPlan = this.adaptiveBatchPlanner.createPlanFromGoalAnalysis(planContext, startDateStr, endDateStr);
                    normalizedStrategy = legacyPlan.adaptiveBatches;
                    normalizedHeader = this.createPlanHeaderFromAdaptivePlan(legacyPlan, identifier, startDateStr, endDateStr);
                } else {
                    // If we should skip multi-step, return early with single task plan
                    if (adaptivePlan.skipMultiStep) {
                        console.log(`[Multi-Step Plan] ✅ AI detected simple change - recommending direct execution`);
                        console.log(`[AI Analysis] Scenario: ${adaptivePlan.scenario?.name}, Confidence: ${(adaptivePlan.aiAnalysis?.confidence || 0) * 100}%`);
                        return this.createSingleTaskPlan(agentId, identifier, liveFilesContent, originalPromptPayload, startDateStr, endDateStr);
                    }

                    normalizedStrategy = adaptivePlan.adaptiveBatches;
                    normalizedHeader = this.createPlanHeaderFromAdaptivePlan(adaptivePlan, identifier, startDateStr, endDateStr);
                }
            }

            const planId = `plan_${agentId}_${Date.now()}`;
            const progress: PlanGenerationProgress = {
                planId, agentId, currentStep: 1, totalSteps: normalizedStrategy.length + 1, completedTasks: 0,
                planData: {
                    plan_title: normalizedHeader.planTitle, estimated_duration_days: normalizedHeader.estimatedDurationDays,
                    target_start_date: normalizedHeader.targetStartDate, target_end_date: normalizedHeader.targetEndDate,
                    kpis: normalizedHeader.kpis, dependency_analysis: normalizedHeader.dependencyAnalysis,
                    plan_risks_and_mitigations: normalizedHeader.planRisksAndMitigations, timeline_breakdown: normalizedHeader.timelineBreakdown,
                    resource_requirements: normalizedHeader.resourceRequirements
                },
                tasks: [], isComplete: false, createdAt: new Date(), updatedAt: new Date(),
                batchPlan: {
                    identifier, isRefinedPromptId, allLiveFiles: liveFilesContent,
                    prePlannedBatches: normalizedStrategy, originalPromptPayload,
                    adaptivePlan // Store the adaptive plan for reference
                }
            };

            console.log(`[Multi-Step Plan] ✅ Adaptive plan created: "${progress.planData?.plan_title}" with ${normalizedStrategy.length} batches (${adaptivePlan.planComplexity})`);
            console.log(`[Multi-Step Plan] 📋 Planning rationale: ${adaptivePlan.planningRationale}`);
            return progress;
        } catch (error) {
            console.error('[Multi-Step Plan] Failed to generate batch plan:', error);
            throw new Error(`Batch planning failed: ${error}`);
        }
    }

    async generateNextTaskBatch(progress: PlanGenerationProgress): Promise<PlanGenerationProgress> {
        const batchIndex = progress.currentStep - 1;
        console.log(`[Multi-Step Plan] Step ${progress.currentStep}: Executing batch ${batchIndex + 1}`);
        
        try {
            if (!progress.batchPlan) throw new Error('Missing batchPlan for execution');
            const { prePlannedBatches, allLiveFiles, originalPromptPayload } = progress.batchPlan;
            if (batchIndex >= prePlannedBatches.length) {
                progress.isComplete = true;
                return progress;
            }
            const currentBatch = prePlannedBatches[batchIndex];
            if (!currentBatch) throw new Error(`Batch ${batchIndex} not found`);

            const filesToBeCreated = PlanUtils.getAllFilesToBeCreated(prePlannedBatches);
            const relevantFilesContent = new Map<string, string>();
            (currentBatch.relevantFiles || []).forEach(filePath => {
                if (filesToBeCreated.has(filePath)) return;
                if (allLiveFiles.has(filePath)) relevantFilesContent.set(filePath, allLiveFiles.get(filePath)!);
            });

            const completedTasksSummary = progress.tasks.slice(-3).map(t => `- ${t.title}: ${t.description?.substring(0, 100)}...`).join('\n') || 'No previous tasks';
            const avgTaskHours = PlanUtils.calculateRealisticEffortHours(currentBatch, currentBatch.expectedTaskCount);

            // Use intelligent file formatting with chunking for large files
            const liveFilesString = await this.formatFilesForAI(relevantFilesContent, currentBatch);

            const userQuery = MULTISTEP_TASK_USER_QUERY
                .replace('{originalGoal}', 'Context provided')
                .replace('{batchFocus}', currentBatch.specificInstruction)
                .replace('{taskRange}', currentBatch.taskRange)
                .replace('{previousTasksContext}', completedTasksSummary)
                .replace('{liveFilesString}', liveFilesString)
                .replace('{expectedTaskCount}', String(currentBatch.expectedTaskCount))
                // simplified for brevity
                .replace('{batchDays}', String(currentBatch.estimatedBatchDays))
                .replace('{batchStartDate}', currentBatch.batchStartDate)
                .replace('{batchEndDate}', currentBatch.batchEndDate)
                .replace('{timingGuidelines}', currentBatch.taskTimingGuidelines)
                .replace('{buildUponContext}', (currentBatch.buildUponTasks || []).join(', '))
                .replace('{taskTimingDetails}', `Each task estimated at ${avgTaskHours} hours.`);
                
            const batchResponse = await callGemini(this.geminiService, MULTISTEP_TASK_SYSTEM_INSTRUCTION, userQuery);
            const batchTasks = await parseGeminiJsonResponse(batchResponse, {
                contextDescription: `Strategic Batch ${currentBatch.batchNumber} execution`,
                memoryManager: this.memoryManager, geminiService: this.geminiService, enableAIRepair: true
            });

            if (!Array.isArray(batchTasks)) throw new Error('Expected array of tasks from batch execution');

            const consolidatedTasks = PlanUtils.consolidateAndValidateTasks(batchTasks, currentBatch, progress.tasks.length);
            progress.tasks.push(...consolidatedTasks);
            progress.completedTasks = progress.tasks.length;
            progress.currentStep++;
            progress.updatedAt = new Date();
            progress.isComplete = progress.currentStep > progress.totalSteps;

            console.log(`[Multi-Step Plan] ✅ Batch ${currentBatch.batchNumber} complete. Total tasks: ${progress.tasks.length}`);
            return progress;
        } catch (error) {
            console.error(`[Multi-Step Plan] Failed to execute batch ${batchIndex + 1}:`, error);
            throw new Error(`Batch ${batchIndex + 1} execution failed: ${error}`);
        }
    }

    async generateCompletePlan(
        agentId: string, identifier: string, isRefinedPromptId: boolean,
        liveFiles: Array<{ path: string; content: string }> = [], maxSteps: number = 20
    ): Promise<PlanGenerationProgress> {
        console.log(`[Multi-Step Plan] Starting strategic plan generation for agent ${agentId}`);
        let progress = await this.generatePlanStructure(agentId, identifier, isRefinedPromptId, liveFiles);
        let stepCount = 1;
        while (!progress.isComplete && stepCount < maxSteps) {
            stepCount++;
            progress = await this.generateNextTaskBatch(progress);
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        if (!progress.isComplete) progress.isComplete = true;

        progress = await this.taskConsolidationService.runIntelligentTaskConsolidation(progress, liveFiles);
        progress = await this.generateCodeForPlan(progress);
        progress = await this.testGenerationService.generateRealisticTestsForPlan(progress);

        console.log(`[Multi-Step Plan] 🎉 Final plan generated with ${progress.tasks.length} optimized tasks.`);
        return progress;
    }

    async generateCodeForPlan(progress: PlanGenerationProgress): Promise<PlanGenerationProgress> {
        if (!progress.batchPlan) return progress;
        try {
            const updatedTasks = await this.codeGenerationService.generateCodeForTasks(
                progress.tasks as TaskWithCode[], progress.batchPlan.allLiveFiles
            );
            progress.tasks = updatedTasks;
            progress.updatedAt = new Date();
            console.log(`[Multi-Step Plan] ✅ Code generation completed for ${updatedTasks.length} tasks`);
            return progress;
        } catch (error) {
            console.error('[Multi-Step Plan] ❌ Code generation failed:', error);
            return progress;
        }
    }
    
    public convertToDbFormat(progress: PlanGenerationProgress, refinedPromptId?: string) {
        return PlanUtils.convertToDbFormat(progress, refinedPromptId);
    }

    // --- Private Helper Methods (Kept for encapsulation) ---
    private async buildPromptPayload(agentId: string, identifier: string, isRefinedPromptId: boolean, directRefinedPromptDetails?: any, codebaseContextSummary?: string, liveFilesContent?: Map<string, string>) {
        let refinedPromptDetails: any = null;
        let systemInstruction: string;
        let userQuery: string;
        if (isRefinedPromptId) {
            refinedPromptDetails = directRefinedPromptDetails ?? (await this.memoryManager.getRefinedPrompt(agentId, identifier));
            if (!refinedPromptDetails) throw new Error(`Refined prompt '${identifier}' not found.`);
            systemInstruction = PLANNER_SYSTEM_INSTRUCTION_REFINED_PROMPT;
            const payload = this.extractPlanGenerationPayload(refinedPromptDetails);
            userQuery = this.buildUserQueryForRefinedPrompt(payload, refinedPromptDetails, liveFilesContent);
        } else {
            const codebaseContext = await this.resolveCodebaseContext(agentId, codebaseContextSummary);
            systemInstruction = PLANNER_SYSTEM_INSTRUCTION_GOAL_PROMPT;
            userQuery = this.buildUserQueryForGoal(identifier, codebaseContext, liveFilesContent);
        }
        return { systemInstruction, userQuery, refinedPromptIdForPlan: isRefinedPromptId ? identifier : null, refinedPromptDetails, originalGoalText: isRefinedPromptId ? null : identifier };
    }

    private extractPlanGenerationPayload(refined: any) {
        return {
            original_prompt_text: refined.original_prompt_text, overall_goal: refined.overall_goal,
            decomposed_tasks: refined.decomposed_tasks_parsed ?? refined.decomposed_tasks,
            key_entities_identified: refined.key_entities_identified_parsed ?? refined.key_entities_identified,
            implicit_assumptions_made_by_refiner: refined.implicit_assumptions_made_by_refiner_parsed ?? refined.implicit_assumptions_made_by_refiner,
            explicit_constraints_from_prompt: refined.explicit_constraints_from_prompt_parsed ?? refined.explicit_constraints_from_prompt,
        };
    }

    private buildUserQueryForRefinedPrompt(payload: Record<string, unknown>, refined: any, liveFilesContent?: Map<string, string>) {
        const liveFilesString = liveFilesContent && liveFilesContent.size > 0 ? Array.from(liveFilesContent.entries()).map(([path, content]) => `--- FILE: ${path} ---\n${content}`).join('\n\n') : 'No live files.';
        return PLANNER_USER_QUERY_REFINED_PROMPT
            .replace('{today}', new Date().toISOString().split('T')[0])
            .replace('{payloadJson}', JSON.stringify(payload, null, 2))
            .replace('{contextSummary}', refined.codebase_context_summary_by_ai || 'No context provided.')
            .replace('{liveFilesString}', liveFilesString);
    }

    private async resolveCodebaseContext(agentId: string, fallback?: string): Promise<string | undefined> {
        if (fallback) return fallback;
        const ctx = await this.memoryManager.getContext(agentId, 'codebase_summary');
        return ctx?.context_data?.summary;
    }

    private buildUserQueryForGoal(goal: string, codebaseContext?: string, liveFilesContent?: Map<string, string>): string {
        const liveFilesString = liveFilesContent && liveFilesContent.size > 0 ? Array.from(liveFilesContent.entries()).map(([path, content]) => `--- FILE: ${path} ---\n${content}`).join('\n\n') : 'No live files.';
        return PLANNER_USER_QUERY_GOAL_PROMPT
            .replace(/{today}/g, new Date().toISOString().split('T')[0])
            .replace('{goal}', goal)
            .replace('{codebaseContext}', codebaseContext || 'No context provided.')
            .replace('{liveFilesString}', liveFilesString);
    }

    /**
     * Creates a plan header from adaptive plan results
     */
    private createPlanHeaderFromAdaptivePlan(adaptivePlan: any, defaultTitle: string, startDateStr: string, endDateStr: string): any {
        return {
            planTitle: `${defaultTitle} (${adaptivePlan.planComplexity.replace('_', ' ')})`,
            estimatedDurationDays: Math.max(7, adaptivePlan.totalBatches * 3),
            targetStartDate: startDateStr,
            targetEndDate: endDateStr,
            kpis: [
                `Complete ${adaptivePlan.totalBatches} planned batches`,
                'Maintain code quality standards',
                'Ensure all tests pass'
            ],
            dependencyAnalysis: adaptivePlan.planningRationale,
            planRisksAndMitigations: [
                {
                    risk_description: 'Implementation complexity may exceed estimates',
                    mitigation_strategy: 'Break down complex tasks into smaller, manageable pieces',
                    probability: 'Medium',
                    impact: 'Medium'
                }
            ],
            timelineBreakdown: {
                phase_1_duration: Math.ceil(adaptivePlan.totalBatches / 3) * 3,
                phase_2_duration: Math.ceil(adaptivePlan.totalBatches / 3) * 3,
                phase_3_duration: Math.floor(adaptivePlan.totalBatches / 3) * 3,
                buffer_days: 2
            },
            resourceRequirements: [
                'Development environment and tools',
                'Access to codebase and files',
                'Testing infrastructure'
            ]
        };
    }

    /**
     * Creates a simple single-task plan for very basic changes
     */
    private createSingleTaskPlan(
        agentId: string,
        identifier: string,
        liveFilesContent: Map<string, string>,
        originalPromptPayload: any,
        startDateStr: string,
        endDateStr: string
    ): PlanGenerationProgress {
        const planId = `plan_${agentId}_${Date.now()}`;
        const planTitle = `Simple task: ${identifier}`;

        return {
            planId,
            agentId,
            currentStep: 1,
            totalSteps: 1,
            completedTasks: 0,
            planData: {
                plan_title: planTitle,
                estimated_duration_days: 1,
                target_start_date: startDateStr,
                target_end_date: startDateStr, // Same day completion
                kpis: ['Complete the requested change', 'Maintain code quality'],
                dependency_analysis: 'Simple change with minimal dependencies',
                plan_risks_and_mitigations: [],
                timeline_breakdown: { phase_1_duration: 1, phase_2_duration: 0, phase_3_duration: 0, buffer_days: 0 },
                resource_requirements: ['Development environment']
            },
            tasks: [],
            isComplete: false,
            createdAt: new Date(),
            updatedAt: new Date(),
            batchPlan: {
                identifier,
                isRefinedPromptId: false,
                allLiveFiles: liveFilesContent,
                prePlannedBatches: [], // No batches for single task
                originalPromptPayload,
                singleTask: true // Flag to indicate this should be handled as single task
            }
        };
    }

    /**
     * Formats files for AI consumption using intelligent chunking
     */
    private async formatFilesForAI(relevantFilesContent: Map<string, string>, currentBatch: BatchInstruction): Promise<string> {
        const formattedFiles: string[] = [];

        for (const [path, content] of relevantFilesContent.entries()) {
            try {
                const fileAnalysis = await this.dynamicPlanAnalyzer.analyzeFile(path, content);
                const formattedContent = this.dynamicPlanAnalyzer.getFormattedFileContent(fileAnalysis);
                formattedFiles.push(formattedContent);
            } catch (error) {
                console.warn(`Failed to analyze ${path}, using fallback formatting:`, error);
                // Fallback to simple formatting
                const analysis = PlanUtils.analyzeFileForBatch(path, content, currentBatch);
                formattedFiles.push(`--- LIVE FILE: ${path} ---\nFILE ANALYSIS: ${analysis.purpose}\n${content.substring(0, 3500)}...\n--- END FILE ---`);
            }
        }

        return formattedFiles.join('\n\n---\n\n');
    }
}
