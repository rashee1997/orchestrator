// src/database/services/MultiStepPlanGenerationService.ts

import { MemoryManager } from '../memory_manager.js';
import { GeminiIntegrationService } from './GeminiIntegrationService.js';
import { parseGeminiJsonResponse } from './gemini-integration-modules/GeminiResponseParsers.js';
import {
    PLANNER_SYSTEM_INSTRUCTION_REFINED_PROMPT,
    PLANNER_USER_QUERY_REFINED_PROMPT,
    PLANNER_SYSTEM_INSTRUCTION_GOAL_PROMPT,
    PLANNER_USER_QUERY_GOAL_PROMPT,
    MULTISTEP_TASK_SYSTEM_INSTRUCTION,
    MULTISTEP_TASK_USER_QUERY
} from './gemini-integration-modules/GeminiPlannerPrompts.js';
import { GeminiPlannerService } from './GeminiPlannerService.js';
import { CodeGenerationService, TaskWithCode } from './CodeGenerationService.js';

export interface BatchInstruction {
    batchNumber: number;
    taskRange: string; // e.g., "Tasks 1-3"
    specificInstruction: string;
    relevantFiles: string[]; // Only files relevant to this batch
    expectedTaskCount: number;
    buildUponTasks?: string[]; // Brief summary of dependency tasks
    estimatedBatchDays: number;
    batchStartDate: string;
    batchEndDate: string;
    taskTimingGuidelines: string; // Guidelines for individual task durations
    requiredNewFiles?: Array<{
        path: string;
        purpose: string;
        fileType: BatchFileType;
    }>; // New files that need to be created
    codeComplexity: 'simple' | 'moderate' | 'complex';
    primaryGoal: string; // Clear objective for this batch
    qualityGates: string[]; // Specific quality requirements
    dependsOnFiles?: string[]; // Files from previous batches this batch depends on
}

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
        timeline_breakdown: {
            phase_1_duration: number;
            phase_2_duration: number;
            phase_3_duration: number;
            buffer_days: number;
        };
        resource_requirements: string[];
    };
    tasks: any[];
    isComplete: boolean;
    createdAt: Date;
    updatedAt: Date;
    batchPlan?: {
        identifier: string;
        isRefinedPromptId: boolean;
        allLiveFiles: Map<string, string>;
        prePlannedBatches: BatchInstruction[];
        originalPromptPayload: any;
    };
}

export interface TaskGenerationContext {
    existingTasks: any[];
    completedTaskNumbers: number[];
    nextTaskNumber: number;
    totalExpectedTasks: number;
    planContext: string;
}

type BatchFileType = 'module' | 'component' | 'service' | 'utility' | 'config' | 'test';

interface NormalizedPlanHeader {
    planTitle: string;
    estimatedDurationDays: number;
    targetStartDate: string;
    targetEndDate: string;
    kpis: string[];
    dependencyAnalysis: string;
    planRisksAndMitigations: Array<{ risk_description: string; mitigation_strategy: string; [key: string]: any }>;
    timelineBreakdown: {
        phase_1_duration: number;
        phase_2_duration: number;
        phase_3_duration: number;
        buffer_days: number;
    };
    resourceRequirements: string[];
}

export class MultiStepPlanGenerationService {
    private memoryManager: MemoryManager;
    private geminiService: GeminiIntegrationService;
    private geminiPlannerService: GeminiPlannerService;
    private codeGenerationService: CodeGenerationService;

    constructor(
        memoryManager: MemoryManager, 
        geminiService: GeminiIntegrationService
    ) {
        this.memoryManager = memoryManager;
        this.geminiService = geminiService;
        this.geminiPlannerService = new GeminiPlannerService(geminiService, memoryManager);
        this.codeGenerationService = new CodeGenerationService(geminiService, memoryManager);
    }

    /**
     * Step 1: Analyze refined prompt and pre-plan all batches with specific instructions
     */
    async generatePlanStructure(
        agentId: string,
        identifier: string,
        isRefinedPromptId: boolean,
        liveFiles: Array<{ path: string; content: string }> = []
    ): Promise<PlanGenerationProgress> {
        console.log(`[Multi-Step Plan] Step 1: Analyzing refined prompt and pre-planning batches for agent ${agentId}`);
        
        try {
            // Convert live files to Map
            const liveFilesContent = new Map<string, string>();
            liveFiles.forEach(file => {
                liveFilesContent.set(file.path, file.content);
            });

            // Get original prompt payload
            const originalPromptPayload = await this.buildPromptPayload(
                agentId, identifier, isRefinedPromptId, undefined, undefined, liveFilesContent
            );

            // Step 1: Analyze refined prompt and create comprehensive plan with realistic timings
            const today = new Date().toISOString().split('T')[0];
            const startDate = new Date();
            startDate.setDate(startDate.getDate() + 1); // Start tomorrow
            const startDateStr = startDate.toISOString().split('T')[0];
            
            // Calculate realistic end dates based on current time
            const endDate = new Date(startDate);
            endDate.setDate(endDate.getDate() + 14); // 14 days from start
            const endDateStr = endDate.toISOString().split('T')[0];
            
            console.log(`[Multi-Step Plan] 📅 Using current system dates: ${today} (today), ${startDateStr} (start), ${endDateStr} (end)`);
            
            const batchPlanningPrompt = `
You are an enhanced multi-step orchestrator specializing in intelligent batch planning and live file analysis. Your task is to analyze the refined prompt/goal and live files to create an optimized execution strategy with reliable batch creation.

**ENHANCED ORCHESTRATION CAPABILITIES:**
- Intelligent live file analysis and dependency mapping
- Strategic batch sequencing with file-based dependencies
- Complete code generation planning with correct file paths
- Quality-first batch design with comprehensive validation
- Adaptive timeline planning based on code complexity analysis

TODAY'S DATE: ${today}
RECOMMENDED START DATE: ${startDateStr}

**COMPREHENSIVE ANALYSIS CONTEXT:**
REFINED PROMPT/GOAL:
Using refined prompt ${identifier} for strategic planning (content analyzed separately)

**LIVE FILES ANALYSIS (${Array.from(liveFilesContent.keys()).length} files available):**
${Array.from(liveFilesContent.entries()).map(([path, content]) =>
    `FILE: ${path}\n- Size: ${content.length} chars\n- Type: ${path.split('.').pop()}\n- Purpose: ${this.analyzeFilePurpose(path, content.substring(0, 500))}`
).join('\n\n')}

**ORCHESTRATION REQUIREMENTS:**
1. Analyze live files to understand current architecture and identify enhancement opportunities
2. Plan batch sequencing based on file dependencies and logical development flow
3. Design each batch with specific file focus and code generation requirements
4. Include new file creation with complete file paths and purposes
5. Ensure each batch builds logically upon previous work
6. Plan for comprehensive code generation (NO placeholders allowed)
7. Include quality gates and validation points

Generate a JSON response with this ENHANCED structure:
{
  "plan_header": {
    "plan_title": "Focused, actionable title based on refined prompt analysis",
    "estimated_duration_days": 14,
    "target_start_date": "${startDateStr}",
    "target_end_date": "${endDateStr}",
    "kpis": [
      "Specific, measurable KPI 1",
      "Quantifiable success metric 2",
      "Performance target 3"
    ],
    "dependency_analysis": "Detailed analysis of task dependencies, critical path, and potential blockers. Identify which tasks must be completed before others can begin.",
    "plan_risks_and_mitigations": [
      {
        "risk_description": "Specific technical risk that could impact delivery",
        "mitigation_strategy": "Concrete steps to prevent or address this risk",
        "probability": "Medium",
        "impact": "High"
      }
    ],
    "timeline_breakdown": {
      "phase_1_duration": 5,
      "phase_2_duration": 6,
      "phase_3_duration": 4,
      "buffer_days": 2
    },
    "resource_requirements": [
      "Development tools and environments",
      "Access permissions needed",
      "External dependencies"
    ]
  },
  "batch_strategy": [
    {
      "batchNumber": 1,
      "taskRange": "Tasks 1-3",
      "specificInstruction": "Comprehensive analysis of current architecture, live file assessment, and strategic planning based on available code",
      "relevantFiles": ["src/tools/rag/iterative_rag_orchestrator.ts"],
      "expectedTaskCount": 3,
      "buildUponTasks": [],
      "estimatedBatchDays": 5,
      "batchStartDate": "${startDateStr}",
      "batchEndDate": "${new Date(startDate.getTime() + 4*24*60*60*1000).toISOString().split('T')[0]}",
      "taskTimingGuidelines": "Each task should be 1-2 days duration, focus on analysis and architectural planning",
      "requiredNewFiles": [],
      "codeComplexity": "moderate",
      "primaryGoal": "Establish comprehensive understanding of current system and plan enhancements",
      "qualityGates": ["Architecture documentation completed", "Enhancement opportunities identified", "Implementation strategy defined"],
      "dependsOnFiles": []
    },
    {
      "batchNumber": 2, 
      "taskRange": "Tasks 4-6",
      "specificInstruction": "Design refactoring approach and create implementation plan",
      "relevantFiles": ["src/tools/rag/multi_model_orchestrator.ts"],
      "expectedTaskCount": 3,
      "buildUponTasks": ["Architecture analysis", "Performance bottleneck identification"],
      "estimatedBatchDays": 6,
      "batchStartDate": "${new Date(startDate.getTime() + 5*24*60*60*1000).toISOString().split('T')[0]}",
      "batchEndDate": "${new Date(startDate.getTime() + 10*24*60*60*1000).toISOString().split('T')[0]}",
      "taskTimingGuidelines": "Each task should be 2-3 days duration, focus on design and planning"
    },
    {
      "batchNumber": 3,
      "taskRange": "Tasks 7-9",
      "specificInstruction": "Implement optimizations and verify performance improvements",
      "relevantFiles": ["src/tools/rag/multi_model_orchestrator.ts"],
      "expectedTaskCount": 3,
      "buildUponTasks": ["Design refactoring approach", "Implementation plan"],
      "estimatedBatchDays": 4,
      "batchStartDate": "${new Date(startDate.getTime() + 11*24*60*60*1000).toISOString().split('T')[0]}",
      "batchEndDate": "${endDateStr}",
      "taskTimingGuidelines": "Each task should be 1-2 days duration, focus on implementation and testing"
    }
  ]
}

**CRITICAL ORCHESTRATION REQUIREMENTS:**
- **Live File Analysis**: Analyze ALL provided live files to understand current architecture, identify enhancement opportunities, and plan strategic improvements
- **Strategic Sequencing**: Design batches that build logically upon each other with clear file-based dependencies
- **Complete Code Generation**: Plan for 100% complete code generation with NO placeholders - if complete code cannot be provided, break into smaller, more specific batches
- **New File Planning**: When new files are needed, specify complete file paths, purposes, and relationships to existing files
- **Quality-First Design**: Each batch must include specific quality gates and validation criteria
- **Realistic Timeline**: Use PROVIDED current dates (Start=${startDateStr}, End=${endDateStr}) and create realistic estimates based on code complexity
- **Dependency Mapping**: Map file dependencies between batches and ensure logical development flow
- **Architecture Integration**: Ensure new code integrates properly with existing architecture patterns from live files
- **Comprehensive Validation**: Include testing, error handling, and integration verification in batch planning
- **Enhanced Batch Details**: Each batch must include:
  - Primary goal and success criteria
  - Specific files to analyze/modify from live files
  - New files to create with complete paths
  - Code complexity assessment
  - Quality gates and validation points
  - Dependency relationships with other batches
`;

            // Generate batch plan
            const batchPlanResponse = await this.callGemini(
                'You are an intelligent multi-step orchestrator that creates optimized batch execution plans.',
                batchPlanningPrompt
            );

            console.log('[Multi-Step Plan] 🔍 Batch plan raw response length:', batchPlanResponse?.length || 0);
            console.log('[Multi-Step Plan] 🔍 Batch plan raw preview:', batchPlanResponse?.substring(0, 500) || '<empty>');

            const batchPlan = await parseGeminiJsonResponse(batchPlanResponse, {
                expectedStructure: 'Batch execution plan with header and strategy',
                contextDescription: 'Multi-step batch planning',
                memoryManager: this.memoryManager,
                geminiService: this.geminiService,
                enableAIRepair: true
            });

            if (!batchPlan || typeof batchPlan !== 'object') {
                console.error('[Multi-Step Plan] ❌ Batch planning returned invalid structure:', batchPlan);
                throw new Error('Batch planning response was empty or invalid.');
            }

            console.log(`[Multi-Step Plan] 🔍 Parsed batch plan keys:`, Object.keys(batchPlan));
            
            const rawPlanHeader = this.extractField(batchPlan, ['plan_header', 'planHeader', 'header']);
            const rawBatchStrategy = this.extractField(batchPlan, ['batch_strategy', 'batchStrategy', 'strategy', 'batches', 'batchPlan']);

            const normalizedStrategy = this.normalizeBatchStrategy(rawBatchStrategy);
            if (!normalizedStrategy.length) {
                console.error('[Multi-Step Plan] ❌ Batch strategy missing or empty after normalization:', {
                    rawType: typeof rawBatchStrategy,
                    rawKeys: rawBatchStrategy && typeof rawBatchStrategy === 'object' ? Object.keys(rawBatchStrategy) : 'none'
                });
                throw new Error('Batch planning response missing batch strategy.');
            }

            const defaultTitleSource = isRefinedPromptId
                ? (originalPromptPayload?.refinedPromptDetails?.overall_goal
                    || originalPromptPayload?.refinedPromptDetails?.plan_title
                    || identifier)
                : identifier;

            const normalizedHeader = this.normalizePlanHeader(rawPlanHeader, normalizedStrategy, {
                defaultTitle: defaultTitleSource,
                startDateStr,
                endDateStr
            });

            const planId = `plan_${agentId}_${Date.now()}`;
            const totalBatches = normalizedStrategy.length;
            
            const progress: PlanGenerationProgress = {
                planId,
                agentId,
                currentStep: 1,
                totalSteps: totalBatches + 1,
                completedTasks: 0,
                planData: {
                    plan_title: normalizedHeader.planTitle,
                    estimated_duration_days: normalizedHeader.estimatedDurationDays,
                    target_start_date: normalizedHeader.targetStartDate,
                    target_end_date: normalizedHeader.targetEndDate,
                    kpis: normalizedHeader.kpis,
                    dependency_analysis: normalizedHeader.dependencyAnalysis,
                    plan_risks_and_mitigations: normalizedHeader.planRisksAndMitigations,
                    timeline_breakdown: normalizedHeader.timelineBreakdown,
                    resource_requirements: normalizedHeader.resourceRequirements
                },
                tasks: [],
                isComplete: false,
                createdAt: new Date(),
                updatedAt: new Date(),
                batchPlan: {
                    identifier,
                    isRefinedPromptId,
                    allLiveFiles: liveFilesContent,
                    prePlannedBatches: normalizedStrategy,
                    originalPromptPayload
                }
            };

            console.log(`[Multi-Step Plan] ✅ Batch plan created: "${progress.planData?.plan_title}" with ${totalBatches} strategic batches`);
            return progress;

        } catch (error) {
            console.error('[Multi-Step Plan] Failed to generate batch plan:', error);
            throw new Error(`Batch planning failed: ${error}`);
        }
    }

    /**
     * Step 2+: Execute the next batch using pre-planned strategy with targeted context
     */
    async generateNextTaskBatch(
        progress: PlanGenerationProgress,
        batchSize: number = 3
    ): Promise<PlanGenerationProgress> {
        // Fix indexing: currentStep starts at 1, first batch should be index 0
        const batchIndex = progress.currentStep - 1; // currentStep 1 = batch index 0, currentStep 2 = batch index 1, etc.
        console.log(`[Multi-Step Plan] Step ${progress.currentStep}: Executing batch ${batchIndex + 1} (index ${batchIndex})`);

        try {
            if (!progress.batchPlan) {
                throw new Error('Missing batchPlan for strategic execution');
            }

            const { prePlannedBatches, allLiveFiles, originalPromptPayload } = progress.batchPlan;
            
            if (batchIndex >= prePlannedBatches.length) {
                progress.isComplete = true;
                console.log(`[Multi-Step Plan] 🏁 All batches completed!`);
                return progress;
            }

            const currentBatch = prePlannedBatches[batchIndex];
            
            // Validate batch structure
            if (!currentBatch) {
                throw new Error(`Batch ${batchIndex} not found in pre-planned batches`);
            }
            
            console.log(`[Multi-Step Plan] Current batch structure:`, JSON.stringify(currentBatch, null, 2));
            
            // Get only the relevant files for this batch
            const relevantFilesContent = new Map<string, string>();
            const relevantFiles = currentBatch.relevantFiles || [];
            
            console.log(`[Multi-Step Plan] 🔍 Debug live files:`, {
                relevantFilesRequested: relevantFiles,
                allLiveFilesKeys: Array.from(allLiveFiles.keys()),
                allLiveFilesSize: allLiveFiles.size
            });
            
            relevantFiles.forEach(filePath => {
                // Normalize the requested file path
                const normalizedRequestedPath = filePath.replace(/\\\\\\\\/g, '/').replace(/\\\\/g, '/').toLowerCase();

                // Try exact match first
                if (allLiveFiles.has(filePath)) {
                    relevantFilesContent.set(filePath, allLiveFiles.get(filePath)!);
                    console.log(`[Multi-Step Plan] ✅ Found live file (exact): ${filePath}`);
                } else {
                    // Try to find by normalized path matching
                    let found = false;
                    for (const [fullPath, content] of allLiveFiles.entries()) {
                        // Normalize paths for comparison - handle Windows paths properly
                        const normalizedFullPath = fullPath.replace(/\\\\/g, '/').replace(/\\/g, '/').toLowerCase();

                        // Try multiple matching strategies
                        if (normalizedFullPath === normalizedRequestedPath ||
                            normalizedFullPath.endsWith(normalizedRequestedPath) ||
                            normalizedRequestedPath.endsWith(normalizedFullPath) ||
                            this.pathsMatch(normalizedFullPath, normalizedRequestedPath)) {
                            relevantFilesContent.set(filePath, content);
                            console.log(`[Multi-Step Plan] ✅ Found live file (normalized): ${filePath} -> ${fullPath}`);
                            found = true;
                            break;
                        }
                    }
                    if (!found) {
                        console.log(`[Multi-Step Plan] ❌ Missing live file: ${filePath}`);
                    }
                }
            });
            
            // Fallback: If no relevant files found, include all live files
            if (relevantFilesContent.size === 0 && allLiveFiles.size > 0) {
                console.log(`[Multi-Step Plan] ⚠️ No specific files matched, including all live files as fallback`);
                for (const [path, content] of allLiveFiles.entries()) {
                    relevantFilesContent.set(path, content);
                }
            }

            // Build context from completed tasks for continuity
            const completedTasksSummary = progress.tasks.length > 0 
                ? progress.tasks.slice(-3).map(t => `- ${t.title}: ${t.description?.substring(0, 100) || 'No description'}...`).join('\n')
                : 'No previous tasks';

            // Build upon specific tasks from previous batches
            const buildUponTasks = currentBatch.buildUponTasks || [];
            const buildUponContext = buildUponTasks.length > 0
                ? `\n\nBUILD UPON THESE COMPLETED TASKS:\n${buildUponTasks.map(task => `- ${task}`).join('\n')}\n`
                : '';

            // Calculate task timing based on batch timeline with defaults
            const batchDurationDays = currentBatch.estimatedBatchDays || 5;
            const tasksCount = currentBatch.expectedTaskCount || 3;
            const avgTaskDays = Math.ceil(batchDurationDays / tasksCount);
            const avgTaskHours = avgTaskDays * 8; // 8 hours per day
            
            // Calculate individual task dates within batch timeline
            const batchStartDate = currentBatch.batchStartDate || new Date().toISOString().split('T')[0];
            const batchStart = new Date(batchStartDate);
            const taskDates = [];
            for (let i = 0; i < tasksCount; i++) {
                const taskStartDate = new Date(batchStart);
                taskStartDate.setDate(taskStartDate.getDate() + (i * avgTaskDays));
                const taskEndDate = new Date(taskStartDate);
                taskEndDate.setDate(taskEndDate.getDate() + avgTaskDays - 1);
                
                taskDates.push({
                    startDate: taskStartDate.toISOString().split('T')[0],
                    endDate: taskEndDate.toISOString().split('T')[0],
                    estimatedHours: avgTaskHours
                });
            }


            // Use dedicated multi-step task generation prompts
            const systemInstruction = MULTISTEP_TASK_SYSTEM_INSTRUCTION;
            
            // Build comprehensive live files string with enhanced analysis
            const liveFilesString = Array.from(relevantFilesContent.entries()).map(([path, content]) => {
                const analysis = this.analyzeFileForBatch(path, content, currentBatch);
                return `--- LIVE FILE: ${path} ---
FILE ANALYSIS: ${analysis.purpose} | Complexity: ${analysis.complexity} | Dependencies: ${analysis.dependencies.join(', ') || 'None'}
RELEVANT CODE:
${content.substring(0, 3500)}...
--- END FILE ---`;
            }).join('\n\n');

            // Build enhanced task timing details with quality requirements
            const taskTimingDetails = taskDates.map((timing, index) => {
                const taskNumber = progress.tasks.length + index + 1;
                return `Task ${taskNumber}: ${timing.startDate} to ${timing.endDate} (${timing.estimatedHours} hours) - Quality Gate: Complete implementation required`;
            }).join('\n');

            // Add new file requirements if specified in batch
            const newFileRequirements = currentBatch.requiredNewFiles && currentBatch.requiredNewFiles.length > 0
                ? `\n\nNEW FILES TO CREATE:\n${currentBatch.requiredNewFiles.map(file =>
                    `- ${file.path} (${file.fileType}): ${file.purpose}`
                ).join('\n')}`
                : '';

            // Add quality gates information
            const qualityGatesInfo = currentBatch.qualityGates && currentBatch.qualityGates.length > 0
                ? `\n\nQUALITY GATES FOR THIS BATCH:\n${currentBatch.qualityGates.map(gate => `- ${gate}`).join('\n')}`
                : '';
            
            console.log(`[Multi-Step Plan] 🔍 Template variables:`, {
                originalGoalLength: originalPromptPayload.userQuery.length,
                batchFocus: currentBatch.specificInstruction || 'Strategic batch execution',
                batchDays: batchDurationDays,
                tasksCount: tasksCount,
                liveFilesCount: relevantFilesContent.size,
                taskDatesCount: taskDates.length
            });
            
            const userQuery = MULTISTEP_TASK_USER_QUERY
                .replace('{originalGoal}', 'See refined prompt context - goal already analyzed in batch planning')
                .replace('{batchFocus}', currentBatch.specificInstruction || 'Strategic batch execution')
                .replace('{batchDays}', batchDurationDays.toString())
                .replace('{batchStartDate}', batchStartDate)
                .replace('{batchEndDate}', currentBatch.batchEndDate || 'TBD')
                .replace('{timingGuidelines}', currentBatch.taskTimingGuidelines || 'Follow standard timing practices')
                .replace('{expectedTaskCount}', tasksCount.toString())
                .replace('{taskRange}', currentBatch.taskRange || `Tasks ${progress.tasks.length + 1}-${progress.tasks.length + tasksCount}`)
                .replace('{buildUponContext}', buildUponContext || 'No specific dependencies')
                .replace('{previousTasksContext}', completedTasksSummary)
                .replace('{liveFilesString}', liveFilesString + newFileRequirements + qualityGatesInfo)
                .replace('{taskTimingDetails}', taskTimingDetails);
            
            // Debug: Log the actual prompts being sent
            console.log(`[Multi-Step Plan] 🔍 System Instruction Preview:`, systemInstruction.substring(0, 200) + '...');
            console.log(`[Multi-Step Plan] 🔍 User Query Preview:`, userQuery.substring(0, 200) + '...');
            
            const batchResponse = await this.callGemini(systemInstruction, userQuery);

            const batchTasks = await parseGeminiJsonResponse(batchResponse, {
                expectedStructure: 'Array of focused batch tasks',
                contextDescription: `Strategic Batch ${currentBatch.batchNumber} execution`,
                memoryManager: this.memoryManager,
                geminiService: this.geminiService,
                enableAIRepair: true
            });

            if (!Array.isArray(batchTasks)) {
                throw new Error('Expected array of tasks from strategic batch execution');
            }

            // Validate task count matches expectation
            const expectedCount = currentBatch.expectedTaskCount || 3;
            if (batchTasks.length !== expectedCount) {
                console.warn(`[Multi-Step Plan] Expected ${expectedCount} tasks, got ${batchTasks.length}`);
            }

            // Add batch tasks to progress
            progress.tasks.push(...batchTasks);
            progress.completedTasks = progress.tasks.length;
            progress.currentStep++;
            progress.updatedAt = new Date();

            // Check if all batches are complete
            progress.isComplete = progress.currentStep > progress.totalSteps;

            const batchNumber = currentBatch.batchNumber || (batchIndex + 1);
            const batchInstruction = currentBatch.specificInstruction || 'Strategic batch execution';
            console.log(`[Multi-Step Plan] ✅ Batch ${batchNumber} complete: "${batchInstruction}" - Generated ${batchTasks.length} tasks (Total: ${progress.tasks.length})`);
            
            if (progress.isComplete) {
                console.log(`[Multi-Step Plan] 🏁 Strategic plan generation complete with ${progress.tasks.length} total tasks!`);
            }

            return progress;

        } catch (error) {
            console.error(`[Multi-Step Plan] Failed to execute strategic batch ${batchIndex + 1}:`, error);
            throw new Error(`Strategic batch ${batchIndex + 1} execution failed: ${error}`);
        }
    }

    /**
     * Complete the entire multi-step plan generation process using strategic batches
     */
    async generateCompletePlan(
        agentId: string,
        identifier: string,
        isRefinedPromptId: boolean,
        liveFiles: Array<{ path: string; content: string }> = [],
        maxSteps: number = 20
    ): Promise<PlanGenerationProgress> {
        console.log(`[Multi-Step Plan] Starting strategic plan generation for agent ${agentId}`);

        // Step 1: Analyze refined prompt and create strategic batch plan
        let progress = await this.generatePlanStructure(agentId, identifier, isRefinedPromptId, liveFiles);

        // Steps 2+: Execute each strategic batch
        let stepCount = 1;
        while (!progress.isComplete && stepCount < maxSteps) {
            stepCount++;
            console.log(`[Multi-Step Plan] Executing strategic step ${stepCount}/${progress.totalSteps}`);
            
            progress = await this.generateNextTaskBatch(progress);
            
            // Small delay to allow for processing
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        if (!progress.isComplete && stepCount >= maxSteps) {
            console.warn(`[Multi-Step Plan] Reached maximum steps (${maxSteps}), marking as complete`);
            progress.isComplete = true;
        }

        console.log(`[Multi-Step Plan] 🎉 Strategic plan generated: ${progress.tasks.length} tasks across ${progress.batchPlan?.prePlannedBatches.length || 0} strategic batches`);

        // Phase 2: Generate code for tasks with specifications
        console.log(`[Multi-Step Plan] 🔧 Starting Phase 2: Code Generation`);
        progress = await this.generateCodeForPlan(progress);
        return progress;
    }

    /**
     * Phase 2: Generate code for all tasks with code specifications
     */
    async generateCodeForPlan(progress: PlanGenerationProgress): Promise<PlanGenerationProgress> {
        if (!progress.batchPlan) {
            console.log(`[Multi-Step Plan] No batch plan found, skipping code generation`);
            return progress;
        }

        try {
            // Convert tasks to TaskWithCode format and generate code
            const tasksWithCode = progress.tasks as TaskWithCode[];
            const updatedTasks = await this.codeGenerationService.generateCodeForTasks(
                tasksWithCode,
                progress.batchPlan.allLiveFiles
            );

            // Update progress with generated code
            progress.tasks = updatedTasks;
            progress.updatedAt = new Date();

            console.log(`[Multi-Step Plan] ✅ Code generation completed for ${updatedTasks.length} tasks`);
            return progress;

        } catch (error) {
            console.error('[Multi-Step Plan] ❌ Code generation failed:', error);
            // Continue without failing the entire process
            return progress;
        }
    }

    private extractField(source: any, keys: string[]): any {
        if (!source || typeof source !== 'object') {
            return undefined;
        }
        for (const key of keys) {
            const value = this.getValue(source, key);
            if (value !== undefined) {
                return value;
            }
        }
        return undefined;
    }

    private normalizePlanHeader(rawHeader: any, strategy: BatchInstruction[], options: { defaultTitle: string; startDateStr: string; endDateStr: string }): NormalizedPlanHeader {
        const { defaultTitle, startDateStr, endDateStr } = options;
        const planTitle = this.getValue(rawHeader, 'plan_title', 'planTitle', 'title') || defaultTitle || 'Multi-Step Generated Plan';
        const estimatedDurationDays = this.ensureNumber(this.getValue(rawHeader, 'estimated_duration_days', 'estimatedDurationDays', 'durationDays', 'duration'),
            strategy.reduce((sum, batch) => sum + (batch.estimatedBatchDays || 0), 0) || 14);
        const targetStartDate = this.getValue(rawHeader, 'target_start_date', 'targetStartDate', 'startDate') || startDateStr;
        const targetEndDate = this.getValue(rawHeader, 'target_end_date', 'targetEndDate', 'endDate') || endDateStr;

        const kpis = this.ensureStringArray(this.getValue(rawHeader, 'kpis', 'KPIs', 'successMetrics', 'success_metrics'));
        const dependencyAnalysis = this.getValue(rawHeader, 'dependency_analysis', 'dependencyAnalysis', 'dependencies', 'analysis') || '';
        const risksRaw = this.ensureArray(this.getValue(rawHeader, 'plan_risks_and_mitigations', 'planRisksAndMitigations', 'risks', 'riskMitigations'));
        const planRisksAndMitigations = risksRaw.map((risk: any) => {
            if (!risk || typeof risk !== 'object') {
                return {
                    risk_description: String(risk || 'Unspecified risk'),
                    mitigation_strategy: ''
                };
            }
            return {
                risk_description: this.getValue(risk, 'risk_description', 'riskDescription', 'description') || 'Unspecified risk',
                mitigation_strategy: this.getValue(risk, 'mitigation_strategy', 'mitigationStrategy', 'mitigation') || ''
            };
        });

        const timelineRaw = this.getValue(rawHeader, 'timeline_breakdown', 'timelineBreakdown', 'timeline');
        const timelineBreakdown = this.normalizeTimelineBreakdown(timelineRaw, strategy);

        const resourcesRaw = this.ensureStringArray(this.getValue(rawHeader, 'resource_requirements', 'resourceRequirements', 'resources'));
        const resourceRequirements = resourcesRaw.length > 0
            ? resourcesRaw
            : ['Development tools and environments', 'Access to codebase and files', 'Testing infrastructure'];

        return {
            planTitle,
            estimatedDurationDays,
            targetStartDate,
            targetEndDate,
            kpis,
            dependencyAnalysis,
            planRisksAndMitigations,
            timelineBreakdown,
            resourceRequirements,
        };
    }

    private normalizeTimelineBreakdown(rawTimeline: any, strategy: BatchInstruction[]): { phase_1_duration: number; phase_2_duration: number; phase_3_duration: number; buffer_days: number; } {
        const defaultPhase1 = strategy[0]?.estimatedBatchDays ?? 5;
        const defaultPhase2 = strategy[1]?.estimatedBatchDays ?? Math.max(defaultPhase1, 6);
        const remaining = strategy.slice(2).reduce((sum, batch) => sum + (batch.estimatedBatchDays || 0), 0);
        const defaultPhase3 = remaining > 0 ? remaining : Math.max(strategy[2]?.estimatedBatchDays ?? 0, 4);
        const defaultBuffer = 2;

        if (!rawTimeline || typeof rawTimeline !== 'object') {
            return {
                phase_1_duration: defaultPhase1,
                phase_2_duration: defaultPhase2,
                phase_3_duration: defaultPhase3,
                buffer_days: defaultBuffer,
            };
        }

        return {
            phase_1_duration: this.ensureNumber(this.getValue(rawTimeline, 'phase_1_duration', 'phase1Duration', 'phaseOneDuration'), defaultPhase1),
            phase_2_duration: this.ensureNumber(this.getValue(rawTimeline, 'phase_2_duration', 'phase2Duration', 'phaseTwoDuration'), defaultPhase2),
            phase_3_duration: this.ensureNumber(this.getValue(rawTimeline, 'phase_3_duration', 'phase3Duration', 'phaseThreeDuration'), defaultPhase3),
            buffer_days: this.ensureNumber(this.getValue(rawTimeline, 'buffer_days', 'bufferDays', 'buffer'), defaultBuffer),
        };
    }

    private normalizeBatchStrategy(rawStrategy: any): BatchInstruction[] {
        const strategyArray = this.toArray(rawStrategy);
        return strategyArray
            .map((entry, index) => this.normalizeBatchInstruction(entry, index))
            .filter((entry): entry is BatchInstruction => !!entry);
    }

    private normalizeBatchInstruction(rawInstruction: any, index: number): BatchInstruction | null {
        if (!rawInstruction || typeof rawInstruction !== 'object') {
            console.warn('[Multi-Step Plan] ⚠️ Skipping malformed batch instruction:', rawInstruction);
            return null;
        }

        const batchNumber = this.ensureNumber(this.getValue(rawInstruction, 'batchNumber', 'batch_number', 'number'), index + 1);
        const specificInstruction = this.getValue(rawInstruction, 'specificInstruction', 'specific_instruction', 'instruction', 'description') || 'Strategic batch execution';
        const relevantFiles = this.ensureStringArray(this.getValue(rawInstruction, 'relevantFiles', 'relevant_files', 'files', 'fileTargets'));
        const expectedTaskCount = Math.max(1, this.ensureNumber(this.getValue(rawInstruction, 'expectedTaskCount', 'expected_task_count', 'taskCount', 'task_count'), 3));
        const buildUponTasks = this.ensureStringArray(this.getValue(rawInstruction, 'buildUponTasks', 'build_upon_tasks', 'dependencyTasks', 'dependency_tasks'));
        const estimatedBatchDays = Math.max(1, this.ensureNumber(this.getValue(rawInstruction, 'estimatedBatchDays', 'estimated_batch_days', 'batchDuration', 'duration', 'estimatedDays'), expectedTaskCount));
        const batchStartDate = this.getValue(rawInstruction, 'batchStartDate', 'batch_start_date', 'startDate') || '';
        const batchEndDate = this.getValue(rawInstruction, 'batchEndDate', 'batch_end_date', 'endDate') || '';
        const taskTimingGuidelines = this.getValue(rawInstruction, 'taskTimingGuidelines', 'task_timing_guidelines', 'timingGuidelines') || '';

        const requiredNewFilesRaw = this.ensureArray(this.getValue(rawInstruction, 'requiredNewFiles', 'required_new_files', 'newFiles', 'new_files'));
        const allowedFileTypes: BatchFileType[] = ['module', 'component', 'service', 'utility', 'config', 'test'];
        const requiredNewFiles = (
            requiredNewFilesRaw
            .map((file: any) => {
                if (!file || typeof file !== 'object') return null;
                const path = this.getValue(file, 'path') || '';
                if (!path) return null;
                const fileTypeRaw = (this.getValue(file, 'fileType', 'file_type', 'type') || 'module').toString().toLowerCase();
                const normalizedFileType = allowedFileTypes.includes(fileTypeRaw as BatchFileType) ? fileTypeRaw as BatchFileType : 'module';
                return {
                    path,
                    purpose: this.getValue(file, 'purpose', 'description', 'reason') || '',
                    fileType: normalizedFileType,
                };
            })
            .filter((file): file is Required<BatchInstruction>['requiredNewFiles'][number] => !!file)
        ) as Array<Required<BatchInstruction>['requiredNewFiles'][number]>;

        const complexity = (this.getValue(rawInstruction, 'codeComplexity', 'code_complexity', 'complexity') || 'moderate').toString().toLowerCase();
        const codeComplexity = ['simple', 'moderate', 'complex'].includes(complexity)
            ? (complexity as 'simple' | 'moderate' | 'complex')
            : 'moderate';

        const primaryGoal = this.getValue(rawInstruction, 'primaryGoal', 'primary_goal', 'goal') || specificInstruction;
        const qualityGates = this.ensureStringArray(this.getValue(rawInstruction, 'qualityGates', 'quality_gates', 'qualityChecks', 'quality_checks'));
        const dependsOnFiles = this.ensureStringArray(this.getValue(rawInstruction, 'dependsOnFiles', 'depends_on_files', 'dependencyFiles', 'dependency_files'));
        const taskRange = this.getValue(rawInstruction, 'taskRange', 'task_range', 'range') || `Tasks ${batchNumber * 3 - 2}-${batchNumber * 3}`;

        return {
            batchNumber,
            taskRange,
            specificInstruction,
            relevantFiles,
            expectedTaskCount,
            buildUponTasks,
            estimatedBatchDays,
            batchStartDate,
            batchEndDate,
            taskTimingGuidelines,
            requiredNewFiles,
            codeComplexity,
            primaryGoal,
            qualityGates,
            dependsOnFiles,
        };
    }

    private getValue(source: any, ...keys: string[]): any {
        if (!source || (typeof source !== 'object' && typeof source !== 'function')) {
            return undefined;
        }
        for (const key of keys) {
            for (const variant of this.keyVariants(key)) {
                if (source[variant] !== undefined) {
                    return source[variant];
                }
            }
        }
        return undefined;
    }

    private keyVariants(key: string): string[] {
        const variants = new Set<string>();
        variants.add(key);

        const snake = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
        variants.add(snake.startsWith('_') ? snake.substring(1) : snake);

        const camel = key.includes('_') ? key.replace(/_([a-z0-9])/gi, (_, char) => char.toUpperCase()) : key;
        variants.add(camel);
        variants.add(camel.charAt(0).toUpperCase() + camel.slice(1));

        return Array.from(variants);
    }

    private ensureArray<T = any>(value: any): T[] {
        if (Array.isArray(value)) {
            return value as T[];
        }
        if (value === null || typeof value === 'undefined') {
            return [];
        }
        return [value as T];
    }

    private ensureStringArray(value: any): string[] {
        return this.ensureArray(value)
            .map(item => item !== null && item !== undefined ? String(item).trim() : '')
            .filter(item => item.length > 0);
    }

    private ensureNumber(value: any, fallback: number): number {
        const num = Number(value);
        return Number.isFinite(num) ? num : fallback;
    }

    private toArray(value: any): any[] {
        if (Array.isArray(value)) {
            return value;
        }
        if (!value || typeof value !== 'object') {
            return [];
        }
        const entries = Object.entries(value);
        entries.sort((a, b) => {
            const numA = parseInt(a[0].replace(/\D+/g, ''), 10);
            const numB = parseInt(b[0].replace(/\D+/g, ''), 10);
            if (Number.isFinite(numA) && Number.isFinite(numB)) {
                return numA - numB;
            }
            return a[0].localeCompare(b[0]);
        });
        return entries.map(([, val]) => val);
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
        const originalGoal = progress.batchPlan?.originalPromptPayload?.originalGoalText;
        const planTitle = progress.planData?.plan_title || originalGoal || 'Multi-Step Generated Plan';
        const overallGoal = refinedPromptId
            ? `Generated via multi-step process: ${planTitle}`
            : `Generated via multi-step process: ${originalGoal || planTitle}`;

        const planData = {
            title: planTitle,
            overall_goal: overallGoal,
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

    // -----------------------------------------------------------------
    // Helper methods copied from GeminiPlannerService
    // -----------------------------------------------------------------
    private async buildPromptPayload(
        agentId: string,
        identifier: string,
        isRefinedPromptId: boolean,
        directRefinedPromptDetails?: any,
        codebaseContextSummary?: string,
        liveFilesContent?: Map<string, string>
    ): Promise<{
        systemInstruction: string;
        userQuery: string;
        refinedPromptIdForPlan: string | null;
        refinedPromptDetails: any;
        originalGoalText: string | null;
    }> {
        let refinedPromptIdForPlan: string | null = null;
        let refinedPromptDetails: any = null;
        let systemInstruction: string;
        let userQuery: string;

        if (isRefinedPromptId) {
            // ---- Refined Prompt Path -------------------------------------------------
            refinedPromptDetails = directRefinedPromptDetails ??
                (await this.memoryManager.getRefinedPrompt(agentId, identifier));

            if (!refinedPromptDetails) {
                throw new Error(`Refined prompt with ID '${identifier}' not found for agent '${agentId}'.`);
            }

            refinedPromptIdForPlan = identifier;
            systemInstruction = PLANNER_SYSTEM_INSTRUCTION_REFINED_PROMPT;
            const planGenerationRefinedPromptDetails = this.extractPlanGenerationPayload(refinedPromptDetails);

            userQuery = this.buildUserQueryForRefinedPrompt(planGenerationRefinedPromptDetails, refinedPromptDetails, liveFilesContent);
        } else {
            // ---- High-level Goal Path -------------------------------------------------
            const codebaseContext = await this.resolveCodebaseContext(agentId, codebaseContextSummary);
            systemInstruction = PLANNER_SYSTEM_INSTRUCTION_GOAL_PROMPT;
            userQuery = this.buildUserQueryForGoal(identifier, codebaseContext, liveFilesContent);
        }

        return {
            systemInstruction,
            userQuery,
            refinedPromptIdForPlan,
            refinedPromptDetails,
            originalGoalText: isRefinedPromptId ? null : identifier,
        };
    }

    private extractPlanGenerationPayload(refined: any): Record<string, unknown> {
        return {
            original_prompt_text: refined.original_prompt_text,
            overall_goal: refined.overall_goal,
            decomposed_tasks: refined.decomposed_tasks_parsed ?? refined.decomposed_tasks,
            key_entities_identified: refined.key_entities_identified_parsed ?? refined.key_entities_identified,
            implicit_assumptions_made_by_refiner:
                refined.implicit_assumptions_made_by_refiner_parsed ?? refined.implicit_assumptions_made_by_refiner,
            explicit_constraints_from_prompt:
                refined.explicit_constraints_from_prompt_parsed ?? refined.explicit_constraints_from_prompt,
            suggested_ai_role_for_agent: refined.suggested_ai_role_for_agent,
            suggested_reasoning_strategy_for_agent: refined.suggested_reasoning_strategy_for_agent,
            desired_output_characteristics_inferred:
                refined.desired_output_characteristics_inferred_parsed ??
                refined.desired_output_characteristics_inferred,
            codebase_context_summary_by_ai: refined.codebase_context_summary_by_ai,
        };
    }

    private buildUserQueryForRefinedPrompt(
        payload: Record<string, unknown>,
        refined: any,
        liveFilesContent?: Map<string, string>
    ): string {
        const today = new Date().toISOString().split('T')[0];
        let liveFilesString = 'No live files provided for review.';
        if (liveFilesContent && liveFilesContent.size > 0) {
            liveFilesString = Array.from(liveFilesContent.entries()).map(([path, content]) => {
                return `--- FILE: ${path} ---\n\`\`\`\n${content}\n\`\`\``;
            }).join('\n\n');
        }

        return PLANNER_USER_QUERY_REFINED_PROMPT
            .replace('{today}', today)
            .replace('{payloadJson}', JSON.stringify(payload, null, 2))
            .replace('{contextSummary}', refined.codebase_context_summary_by_ai || 'No specific codebase context provided.')
            .replace('{liveFilesString}', liveFilesString);
    }

    private async resolveCodebaseContext(agentId: string, fallback?: string): Promise<string | undefined> {
        if (fallback) return fallback;
        const ctx = await this.memoryManager.getContext(agentId, 'codebase_summary');
        return ctx?.context_data?.summary;
    }

    private buildUserQueryForGoal(goal: string, codebaseContext?: string, liveFilesContent?: Map<string, string>): string {
        const today = new Date().toISOString().split('T')[0];
        let liveFilesString = 'No live files provided for review.';
        if (liveFilesContent && liveFilesContent.size > 0) {
            liveFilesString = Array.from(liveFilesContent.entries()).map(([path, content]) => {
                return `--- FILE: ${path} ---\n\`\`\`\n${content}\n\`\`\``;
            }).join('\n\n');
        }

        return PLANNER_USER_QUERY_GOAL_PROMPT
            .replace(/{today}/g, today)
            .replace('{goal}', goal)
            .replace('{codebaseContext}', codebaseContext || 'No specific codebase context provided.')
            .replace('{liveFilesString}', liveFilesString);
    }

    private async callGemini(systemInstruction: string, userQuery: string): Promise<string> {
        try {
            console.log('[Multi-Step Plan] 🔍 System Instruction Length:', systemInstruction.length);
            console.log('[Multi-Step Plan] 🔍 User Query Length:', userQuery.length);
            console.log('[Multi-Step Plan] 🔍 Total Prompt Length:', systemInstruction.length + userQuery.length);

            // Use GeminiIntegrationService directly for task generation calls
            console.log('[Multi-Step Plan] 🔍 Using GeminiIntegrationService askGemini for task generation...');

            // Try multiple models in case one fails
            const models = ['gemini-2.5-flash', 'gemini-2.5-pro'];
            let lastError: Error | null = null;

            for (const model of models) {
                try {
                    console.log(`[Multi-Step Plan] 🔍 Trying model: ${model}`);

                    const result = await this.geminiService.askGemini(
                        userQuery,
                        model,
                        systemInstruction
                    );

                    if (!result) {
                        throw new Error('GeminiIntegrationService returned undefined result');
                    }

                    // Handle the response from GeminiIntegrationService
                    let content: string;

                    // Try different response formats
                    if (result.content && Array.isArray(result.content) && result.content.length > 0) {
                        // Extract text from Part[] format
                        const firstPart = result.content[0];
                        if (firstPart && typeof firstPart === 'object' && 'text' in firstPart) {
                            const textPart = firstPart as any;
                            if (typeof textPart.text === 'string') {
                                content = textPart.text;
                            } else {
                                throw new Error('GeminiIntegrationService returned content part without text property');
                            }
                        } else if (typeof firstPart === 'string') {
                            content = firstPart;
                        } else {
                            console.error('[Multi-Step Plan] ❌ Unexpected content part format:', firstPart);
                            throw new Error('GeminiIntegrationService returned unexpected content part format');
                        }
                    } else if (typeof result === 'string') {
                        // Direct string response
                        content = result;
                    } else {
                        console.error('[Multi-Step Plan] ❌ No content in result:', result);
                        throw new Error('GeminiIntegrationService returned no content');
                    }

                    if (!content || content.trim().length === 0) {
                        throw new Error('GeminiIntegrationService returned empty content');
                    }

                    // Validate that we got a JSON response
                    if (content.trim().startsWith('{') || content.trim().startsWith('[')) {
                        try {
                            JSON.parse(content);
                        } catch (parseError) {
                            console.error('[Multi-Step Plan] ❌ Invalid JSON in response:', parseError);
                            throw new Error('GeminiIntegrationService returned invalid JSON');
                        }
                    }

                    console.log('[Multi-Step Plan] ✅ GeminiIntegrationService succeeded with model:', model);
                    console.log('[Multi-Step Plan] 🔍 Response Length:', content.length);
                    console.log('[Multi-Step Plan] 🔍 Response preview:', content.substring(0, 300) + '...');

                    return content;

                } catch (modelError: any) {
                    console.warn(`[Multi-Step Plan] ⚠️ Model ${model} failed:`, modelError.message);
                    lastError = modelError;
                    continue; // Try next model
                }
            }

            // If all models failed, throw the last error
            if (lastError) {
                throw lastError;
            }

            throw new Error('All Gemini models failed to generate a response');

        } catch (err: any) {
            console.error('[Multi-Step Plan] ❌ GeminiIntegrationService failed:', err.message);

            // Provide more specific error messages
            if (err.message.includes('API key')) {
                throw new Error(`Gemini API authentication failed: ${err.message}`);
            } else if (err.message.includes('quota') || err.message.includes('rate limit')) {
                throw new Error(`Gemini API quota/rate limit exceeded: ${err.message}`);
            } else if (err.message.includes('network') || err.message.includes('timeout')) {
                throw new Error(`Network error communicating with Gemini API: ${err.message}`);
            } else {
                throw new Error(`Failed to generate response: ${err.message}`);
            }
        }
    }

    // -----------------------------------------------------------------
    // Enhanced File Analysis Methods for Live File Integration
    // -----------------------------------------------------------------

    /**
     * Analyze file purpose for orchestration planning
     */
    private analyzeFilePurpose(filePath: string, contentPreview: string): string {
        const fileName = filePath.split('/').pop()?.toLowerCase() || '';
        const extension = fileName.split('.').pop();

        // Analyze based on file name patterns
        if (fileName.includes('service')) return 'Business logic service';
        if (fileName.includes('manager')) return 'Resource management component';
        if (fileName.includes('orchestrator')) return 'Workflow orchestration system';
        if (fileName.includes('repository')) return 'Data access layer';
        if (fileName.includes('controller')) return 'Request handling controller';
        if (fileName.includes('util')) return 'Utility functions';
        if (fileName.includes('config')) return 'Configuration management';
        if (fileName.includes('test')) return 'Test suite';

        // Analyze based on content patterns
        if (contentPreview.includes('export class')) return 'Class-based component';
        if (contentPreview.includes('export function')) return 'Function library';
        if (contentPreview.includes('export interface')) return 'Type definitions';
        if (contentPreview.includes('export const')) return 'Constants and configuration';

        // Analyze based on file extension
        switch (extension) {
            case 'ts': return 'TypeScript module';
            case 'js': return 'JavaScript module';
            case 'json': return 'JSON configuration';
            case 'md': return 'Documentation';
            case 'sql': return 'Database schema';
            default: return 'Source file';
        }
    }

    /**
     * Enhanced file analysis for batch-specific context
     */
    private analyzeFileForBatch(filePath: string, content: string, batch: BatchInstruction): {
        purpose: string;
        complexity: 'simple' | 'moderate' | 'complex';
        dependencies: string[];
        enhancementOpportunities: string[];
    } {
        const purpose = this.analyzeFilePurpose(filePath, content.substring(0, 1000));

        // Analyze complexity based on content
        const lines = content.split('\n').length;
        const classCount = (content.match(/export class/g) || []).length;
        const functionCount = (content.match(/function\s+\w+|=>\s*{|\w+\s*\(/g) || []).length;
        const complexityScore = lines + (classCount * 50) + (functionCount * 10);

        let complexity: 'simple' | 'moderate' | 'complex' = 'simple';
        if (complexityScore > 500) complexity = 'complex';
        else if (complexityScore > 200) complexity = 'moderate';

        // Extract dependencies from imports
        const importMatches = content.match(/import\s+.*?from\s+['"]([^'"]+)['"]/g) || [];
        const dependencies = importMatches.map(match => {
            const pathMatch = match.match(/from\s+['"]([^'"]+)['"]/)?.[1];
            return pathMatch?.split('/').pop()?.replace('.js', '')?.replace('.ts', '') || 'unknown';
        }).filter(dep => dep !== 'unknown');

        // Identify enhancement opportunities based on batch focus
        const enhancementOpportunities: string[] = [];
        const batchFocus = batch.specificInstruction.toLowerCase();

        if (batchFocus.includes('performance') && content.includes('for (') && !content.includes('// Performance optimization')) {
            enhancementOpportunities.push('Loop optimization opportunities');
        }
        if (batchFocus.includes('refactor') && functionCount > 10) {
            enhancementOpportunities.push('Function decomposition potential');
        }
        if (batchFocus.includes('error') && !content.includes('try {') && !content.includes('catch')) {
            enhancementOpportunities.push('Error handling implementation needed');
        }
        if (batchFocus.includes('test') && !content.includes('describe(') && !content.includes('it(')) {
            enhancementOpportunities.push('Test coverage expansion required');
        }
        if (batchFocus.includes('logging') && !content.includes('console.log') && !content.includes('logger')) {
            enhancementOpportunities.push('Logging infrastructure needed');
        }

        return {
            purpose,
            complexity,
            dependencies,
            enhancementOpportunities
        };
    }

    /**
     * Generate recommended new file paths based on current architecture
     */
    private generateNewFilePaths(existingFiles: string[], batchObjective: string): Array<{
        path: string;
        purpose: string;
        fileType: 'module' | 'component' | 'service' | 'utility' | 'config' | 'test';
    }> {
        const newFiles: Array<{ path: string; purpose: string; fileType: 'module' | 'component' | 'service' | 'utility' | 'config' | 'test' }> = [];
        const objective = batchObjective.toLowerCase();

        // Determine base directory from existing files
        const basePaths = existingFiles.map(file => {
            const parts = file.split('/');
            return parts.slice(0, -1).join('/');
        });
        const commonPath = this.findCommonPath(basePaths);

        // Generate paths based on objective
        if (objective.includes('service') && !existingFiles.some(f => f.includes('NewService'))) {
            newFiles.push({
                path: `${commonPath}/services/EnhancedService.ts`,
                purpose: 'Enhanced service implementation with improved functionality',
                fileType: 'service'
            });
        }

        if (objective.includes('util') && !existingFiles.some(f => f.includes('helpers'))) {
            newFiles.push({
                path: `${commonPath}/utils/BatchHelpers.ts`,
                purpose: 'Utility functions for batch processing',
                fileType: 'utility'
            });
        }

        if (objective.includes('test') || objective.includes('spec')) {
            const testFiles = existingFiles
                .filter(f => !f.includes('.test.') && !f.includes('.spec.'))
                .map(sourceFile => ({
                    path: sourceFile.replace(/\.(ts|js)$/, '.test.ts'),
                    purpose: `Comprehensive test suite for ${sourceFile.split('/').pop()}`,
                    fileType: 'test' as const
                }));
            newFiles.push(...testFiles.slice(0, 3)); // Limit to 3 test files per batch
        }

        if (objective.includes('config') && !existingFiles.some(f => f.includes('config'))) {
            newFiles.push({
                path: `${commonPath}/config/BatchConfiguration.ts`,
                purpose: 'Configuration management for batch processing',
                fileType: 'config'
            });
        }

        return newFiles;
    }

    /**
     * Find common path among multiple file paths
     */
    private findCommonPath(paths: string[]): string {
        if (paths.length === 0) return 'src';
        if (paths.length === 1) return paths[0];

        const firstPath = paths[0].split('/');
        let commonLength = firstPath.length;

        for (let i = 1; i < paths.length; i++) {
            const currentPath = paths[i].split('/');
            let j = 0;
            while (j < Math.min(commonLength, currentPath.length) && firstPath[j] === currentPath[j]) {
                j++;
            }
            commonLength = j;
        }

        return firstPath.slice(0, commonLength).join('/') || 'src';
    }

    /**
     * Enhanced path matching for Windows and Unix paths
     */
    private pathsMatch(path1: string, path2: string): boolean {
        // Extract just the filename and directory components
        const parts1 = path1.split('/').filter(p => p.length > 0);
        const parts2 = path2.split('/').filter(p => p.length > 0);

        // If one path ends with the significant parts of another
        const minLength = Math.min(parts1.length, parts2.length);
        if (minLength < 2) return false;

        // Check if the last few significant parts match
        const tail1 = parts1.slice(-minLength);
        const tail2 = parts2.slice(-minLength);

        for (let i = 0; i < minLength; i++) {
            if (tail1[i] !== tail2[i]) return false;
        }

        return true;
    }
}
