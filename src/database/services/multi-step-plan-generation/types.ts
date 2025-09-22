export type BatchFileType = 'module' | 'component' | 'service' | 'utility' | 'config' | 'test';

export interface BatchInstruction {
    batchNumber: number;
    taskRange: string;
    specificInstruction: string;
    relevantFiles: string[];
    expectedTaskCount: number;
    buildUponTasks?: string[];
    estimatedBatchDays: number;
    batchStartDate: string;
    batchEndDate: string;
    taskTimingGuidelines: string;
    requiredNewFiles?: Array<{
        path: string;
        purpose: string;
        fileType: BatchFileType;
    }>;
    codeComplexity: 'simple' | 'moderate' | 'complex';
    primaryGoal: string;
    qualityGates: string[];
    dependsOnFiles?: string[];
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
        adaptivePlan?: any; // Store adaptive plan for reference
        singleTask?: boolean; // Flag for single task mode
    };
}

export interface TaskGenerationContext {
    existingTasks: any[];
    completedTaskNumbers: number[];
    nextTaskNumber: number;
    totalExpectedTasks: number;
    planContext: string;
}

export interface NormalizedPlanHeader {
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

// Simplified from GeminiPlannerService to keep module self-contained
export interface InitialDetailedPlanAndTasks {
    planData: {
        title: string;
        overall_goal: string;
        status: string;
        version: number;
        refined_prompt_id_associated: string | null;
        metadata: Record<string, unknown>;
    };
    tasksData: any[];
}