import { BatchFileType, BatchInstruction, NormalizedPlanHeader, PlanGenerationProgress, InitialDetailedPlanAndTasks } from './types.js';

export function extractField(source: any, keys: string[]): any {
    if (!source || typeof source !== 'object') {
        return undefined;
    }
    for (const key of keys) {
        const value = getValue(source, key);
        if (value !== undefined) {
            return value;
        }
    }
    return undefined;
}

export function normalizePlanHeader(rawHeader: any, strategy: BatchInstruction[], options: { defaultTitle: string; startDateStr: string; endDateStr: string }): NormalizedPlanHeader {
    const { defaultTitle, startDateStr, endDateStr } = options;
    const planTitle = getValue(rawHeader, 'plan_title', 'planTitle', 'title') || defaultTitle || 'Multi-Step Generated Plan';
    const estimatedDurationDays = ensureNumber(getValue(rawHeader, 'estimated_duration_days', 'estimatedDurationDays', 'durationDays', 'duration'),
        strategy.reduce((sum, batch) => sum + (batch.estimatedBatchDays || 0), 0) || 14);
    const targetStartDate = getValue(rawHeader, 'target_start_date', 'targetStartDate', 'startDate') || startDateStr;
    const targetEndDate = getValue(rawHeader, 'target_end_date', 'targetEndDate', 'endDate') || endDateStr;

    const kpis = ensureStringArray(getValue(rawHeader, 'kpis', 'KPIs', 'successMetrics', 'success_metrics'));
    const dependencyAnalysis = getValue(rawHeader, 'dependency_analysis', 'dependencyAnalysis', 'dependencies', 'analysis') || '';
    const risksRaw = ensureArray(getValue(rawHeader, 'plan_risks_and_mitigations', 'planRisksAndMitigations', 'risks', 'riskMitigations'));
    const planRisksAndMitigations = risksRaw.map((risk: any) => {
        if (!risk || typeof risk !== 'object') return { risk_description: String(risk || 'Unspecified risk'), mitigation_strategy: '' };
        return {
            risk_description: getValue(risk, 'risk_description', 'riskDescription', 'description') || 'Unspecified risk',
            mitigation_strategy: getValue(risk, 'mitigation_strategy', 'mitigationStrategy', 'mitigation') || ''
        };
    });

    const timelineRaw = getValue(rawHeader, 'timeline_breakdown', 'timelineBreakdown', 'timeline');
    const timelineBreakdown = normalizeTimelineBreakdown(timelineRaw, strategy);

    const resourcesRaw = ensureStringArray(getValue(rawHeader, 'resource_requirements', 'resourceRequirements', 'resources'));
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

function normalizeTimelineBreakdown(rawTimeline: any, strategy: BatchInstruction[]): { phase_1_duration: number; phase_2_duration: number; phase_3_duration: number; buffer_days: number; } {
    const defaultPhase1 = strategy[0]?.estimatedBatchDays ?? 5;
    const defaultPhase2 = strategy[1]?.estimatedBatchDays ?? Math.max(defaultPhase1, 6);
    const remaining = strategy.slice(2).reduce((sum, batch) => sum + (batch.estimatedBatchDays || 0), 0);
    const defaultPhase3 = remaining > 0 ? remaining : Math.max(strategy[2]?.estimatedBatchDays ?? 0, 4);
    const defaultBuffer = 2;

    if (!rawTimeline || typeof rawTimeline !== 'object') {
        return { phase_1_duration: defaultPhase1, phase_2_duration: defaultPhase2, phase_3_duration: defaultPhase3, buffer_days: defaultBuffer };
    }

    return {
        phase_1_duration: ensureNumber(getValue(rawTimeline, 'phase_1_duration', 'phase1Duration', 'phaseOneDuration'), defaultPhase1),
        phase_2_duration: ensureNumber(getValue(rawTimeline, 'phase_2_duration', 'phase2Duration', 'phaseTwoDuration'), defaultPhase2),
        phase_3_duration: ensureNumber(getValue(rawTimeline, 'phase_3_duration', 'phase3Duration', 'phaseThreeDuration'), defaultPhase3),
        buffer_days: ensureNumber(getValue(rawTimeline, 'buffer_days', 'bufferDays', 'buffer'), defaultBuffer),
    };
}

export function normalizeBatchStrategy(rawStrategy: any): BatchInstruction[] {
    const strategyArray = toArray(rawStrategy);
    return strategyArray
        .map((entry, index) => normalizeBatchInstruction(entry, index))
        .filter((entry): entry is BatchInstruction => !!entry);
}

function normalizeBatchInstruction(rawInstruction: any, index: number): BatchInstruction | null {
    if (!rawInstruction || typeof rawInstruction !== 'object') {
        console.warn('[Multi-Step Plan] ⚠️ Skipping malformed batch instruction:', rawInstruction);
        return null;
    }

    const batchNumber = ensureNumber(getValue(rawInstruction, 'batchNumber', 'batch_number', 'number'), index + 1);
    const specificInstruction = getValue(rawInstruction, 'specificInstruction', 'specific_instruction', 'instruction', 'description') || 'Strategic batch execution';
    const relevantFiles = ensureStringArray(getValue(rawInstruction, 'relevantFiles', 'relevant_files', 'files', 'fileTargets'));
    const expectedTaskCount = Math.max(1, ensureNumber(getValue(rawInstruction, 'expectedTaskCount', 'expected_task_count', 'taskCount', 'task_count'), 3));
    const buildUponTasks = ensureStringArray(getValue(rawInstruction, 'buildUponTasks', 'build_upon_tasks', 'dependencyTasks', 'dependency_tasks'));
    const estimatedBatchDays = Math.max(1, ensureNumber(getValue(rawInstruction, 'estimatedBatchDays', 'estimated_batch_days', 'batchDuration', 'duration', 'estimatedDays'), expectedTaskCount));
    const batchStartDate = getValue(rawInstruction, 'batchStartDate', 'batch_start_date', 'startDate') || '';
    const batchEndDate = getValue(rawInstruction, 'batchEndDate', 'batch_end_date', 'endDate') || '';
    const taskTimingGuidelines = getValue(rawInstruction, 'taskTimingGuidelines', 'task_timing_guidelines', 'timingGuidelines') || '';

    const requiredNewFilesRaw = ensureArray(getValue(rawInstruction, 'requiredNewFiles', 'required_new_files', 'newFiles', 'new_files'));
    const allowedFileTypes: BatchFileType[] = ['module', 'component', 'service', 'utility', 'config', 'test'];
    const requiredNewFiles = (
        requiredNewFilesRaw
        .map((file: any) => {
            if (!file || typeof file !== 'object') return null;
            const path = getValue(file, 'path') || '';
            if (!path) return null;
            const fileTypeRaw = (getValue(file, 'fileType', 'file_type', 'type') || 'module').toString().toLowerCase();
            const normalizedFileType = allowedFileTypes.includes(fileTypeRaw as BatchFileType) ? fileTypeRaw as BatchFileType : 'module';
            return { path, purpose: getValue(file, 'purpose', 'description', 'reason') || '', fileType: normalizedFileType };
        })
        .filter((file): file is Required<BatchInstruction>['requiredNewFiles'][number] => !!file)
    ) as Array<Required<BatchInstruction>['requiredNewFiles'][number]>;

    const complexity = (getValue(rawInstruction, 'codeComplexity', 'code_complexity', 'complexity') || 'moderate').toString().toLowerCase();
    const codeComplexity = ['simple', 'moderate', 'complex'].includes(complexity) ? (complexity as 'simple' | 'moderate' | 'complex') : 'moderate';

    const primaryGoal = getValue(rawInstruction, 'primaryGoal', 'primary_goal', 'goal') || specificInstruction;
    const qualityGates = ensureStringArray(getValue(rawInstruction, 'qualityGates', 'quality_gates', 'qualityChecks', 'quality_checks'));
    const dependsOnFiles = ensureStringArray(getValue(rawInstruction, 'dependsOnFiles', 'depends_on_files', 'dependencyFiles', 'dependency_files'));
    const taskRange = getValue(rawInstruction, 'taskRange', 'task_range', 'range') || `Tasks ${batchNumber * 3 - 2}-${batchNumber * 3}`;

    return {
        batchNumber, taskRange, specificInstruction, relevantFiles, expectedTaskCount, buildUponTasks,
        estimatedBatchDays, batchStartDate, batchEndDate, taskTimingGuidelines, requiredNewFiles,
        codeComplexity, primaryGoal, qualityGates, dependsOnFiles,
    };
}

export function getValue(source: any, ...keys: string[]): any {
    if (!source || (typeof source !== 'object' && typeof source !== 'function')) return undefined;
    for (const key of keys) {
        for (const variant of keyVariants(key)) {
            if (source[variant] !== undefined) return source[variant];
        }
    }
    return undefined;
}

function keyVariants(key: string): string[] {
    const variants = new Set<string>();
    variants.add(key);
    const snake = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
    variants.add(snake.startsWith('_') ? snake.substring(1) : snake);
    const camel = key.includes('_') ? key.replace(/_([a-z0-9])/gi, (_, char) => char.toUpperCase()) : key;
    variants.add(camel);
    variants.add(camel.charAt(0).toUpperCase() + camel.slice(1));
    return Array.from(variants);
}

export function ensureArray<T = any>(value: any): T[] {
    if (Array.isArray(value)) return value as T[];
    if (value === null || typeof value === 'undefined') return [];
    return [value as T];
}

export function ensureStringArray(value: any): string[] {
    return ensureArray(value)
        .map(item => item !== null && item !== undefined ? String(item).trim() : '')
        .filter(item => item.length > 0);
}

export function ensureNumber(value: any, fallback: number): number {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

export function toArray(value: any): any[] {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object') return [];
    const entries = Object.entries(value);
    entries.sort((a, b) => {
        const numA = parseInt(a[0].replace(/\D+/g, ''), 10);
        const numB = parseInt(b[0].replace(/\D+/g, ''), 10);
        if (Number.isFinite(numA) && Number.isFinite(numB)) return numA - numB;
        return a[0].localeCompare(b[0]);
    });
    return entries.map(([, val]) => val);
}

export function analyzeFilePurpose(filePath: string, contentPreview: string): string {
    const fileName = filePath.split('/').pop()?.toLowerCase() || '';
    if (fileName.includes('service')) return 'Business logic service';
    if (fileName.includes('manager')) return 'Resource management component';
    if (fileName.includes('orchestrator')) return 'Workflow orchestration system';
    if (contentPreview.includes('export class')) return 'Class-based component';
    if (contentPreview.includes('export function')) return 'Function library';
    return 'Source file';
}

export function analyzeFileForBatch(filePath: string, content: string, batch: BatchInstruction): {
    purpose: string;
    complexity: 'simple' | 'moderate' | 'complex';
    dependencies: string[];
} {
    const purpose = analyzeFilePurpose(filePath, content.substring(0, 1000));
    const lines = content.split('\n').length;
    let complexity: 'simple' | 'moderate' | 'complex' = 'simple';
    if (lines > 500) complexity = 'complex';
    else if (lines > 200) complexity = 'moderate';
    const importMatches = content.match(/import\s+.*?from\s+['"]([^'"]+)['"]/g) || [];
    const dependencies = importMatches.map(match => match.match(/from\s+['"]([^'"]+)['"]/)?.[1] || 'unknown');
    return { purpose, complexity, dependencies };
}

export function calculateRealisticEffortHours(batch: BatchInstruction, taskCount: number): number {
    const batchDurationDays = batch.estimatedBatchDays || 5;
    const baseHoursPerTask = (batchDurationDays * 8) / taskCount;
    const batchFocus = batch.specificInstruction.toLowerCase();
    const complexity = batch.codeComplexity || 'moderate';
    let multiplier = 1.0;
    if (batchFocus.includes('analysis')) multiplier = 0.6;
    else if (batchFocus.includes('refactor') && complexity === 'complex') multiplier = 1.6;
    const realisticHours = Math.max(1, Math.round(baseHoursPerTask * multiplier));
    return Math.min(realisticHours, 16);
}

export function getAllFilesToBeCreated(batches: BatchInstruction[]): Set<string> {
    const filesToBeCreated = new Set<string>();
    for (const batch of batches) {
        if (batch.requiredNewFiles) {
            for (const newFile of batch.requiredNewFiles) {
                filesToBeCreated.add(newFile.path);
            }
        }
    }
    console.log(`[File Filtering] 📁 Found ${filesToBeCreated.size} files that will be created:`, Array.from(filesToBeCreated));
    return filesToBeCreated;
}

export function pathsMatch(path1: string, path2: string): boolean {
    const parts1 = path1.split('/').filter(p => p.length > 0);
    const parts2 = path2.split('/').filter(p => p.length > 0);
    const minLength = Math.min(parts1.length, parts2.length);
    if (minLength < 2) return false;
    const tail1 = parts1.slice(-minLength);
    const tail2 = parts2.slice(-minLength);
    for (let i = 0; i < minLength; i++) {
        if (tail1[i] !== tail2[i]) return false;
    }
    return true;
}

export function consolidateAndValidateTasks(rawTasks: any[], batch: BatchInstruction, existingTaskCount: number): any[] {
    const consolidatedTasks: any[] = [];
    const actionMap = new Map<string, any>();
    for (const task of rawTasks) {
        const actions = extractTaskActions(task);
        let consolidatedTask = { ...task };
        const overlappingActions = actions.filter(action => actionMap.has(action));
        if (overlappingActions.length > 0) {
            const existingTask = actionMap.get(overlappingActions[0]);
            consolidatedTask.title = mergeTitles(existingTask.title, task.title);
            consolidatedTask.description = mergeDescriptions(existingTask.description, task.description);
            const existingIndex = consolidatedTasks.findIndex(t => t.task_number === existingTask.task_number);
            if (existingIndex >= 0) consolidatedTasks.splice(existingIndex, 1);
        }
        actions.forEach(action => actionMap.set(action, consolidatedTask));
        consolidatedTasks.push(consolidatedTask);
    }
    const requiredTasks = ensureRequiredTaskTypes(consolidatedTasks, batch);
    return requiredTasks.map((task, index) => ({ ...task, task_number: existingTaskCount + index + 1 }));
}

function extractTaskActions(task: any): string[] {
    const actions: string[] = [];
    const title = task.title?.toLowerCase() || '';
    const actionPatterns = ['refactor', 'implement', 'add', 'remove', 'update', 'create'];
    for (const pattern of actionPatterns) {
        if (title.includes(pattern)) {
            const words = title.split(/\s+/);
            const patternIndex = words.findIndex((word: string) => word.includes(pattern));
            if (patternIndex >= 0) actions.push(words.slice(patternIndex, patternIndex + 4).join(' '));
        }
    }
    return actions;
}

function mergeTitles(title1: string, title2: string): string {
    return title1.length > title2.length ? title1 : title2;
}

function mergeDescriptions(desc1: string, desc2: string): string {
    return `${desc1}\n\nAdditionally: ${desc2}`;
}

function ensureRequiredTaskTypes(tasks: any[], batch: BatchInstruction): any[] {
    const requiredTasks = [...tasks];
    const batchFocus = batch.specificInstruction.toLowerCase();
    const hasTestSetup = requiredTasks.some(t => t.title?.toLowerCase().includes('test setup'));
    if (!hasTestSetup && (batchFocus.includes('implement') || batchFocus.includes('refactor'))) {
        requiredTasks.push({ title: 'Set up Testing Framework', description: 'Configure Jest/Vitest testing framework.', task_type: 'testing' });
    }
    return requiredTasks;
}

export function convertToDbFormat(progress: PlanGenerationProgress, refinedPromptId?: string) {
    const originalGoal = progress.batchPlan?.originalPromptPayload?.originalGoalText;
    const planTitle = progress.planData?.plan_title || originalGoal || 'Multi-Step Generated Plan';
    const overallGoal = refinedPromptId ? `Generated via multi-step process: ${planTitle}` : `Generated via multi-step process: ${originalGoal || planTitle}`;
    const planData = {
        title: planTitle, overall_goal: overallGoal, status: 'DRAFT', version: 1, refined_prompt_id_associated: refinedPromptId || null,
        metadata: {
            estimated_duration_days: progress.planData?.estimated_duration_days, target_start_date: progress.planData?.target_start_date,
            target_end_date: progress.planData?.target_end_date, kpis: progress.planData?.kpis,
            dependency_analysis: progress.planData?.dependency_analysis, plan_risks_and_mitigations: progress.planData?.plan_risks_and_mitigations,
            generation_method: 'multi-step', total_steps: progress.currentStep, generation_completed: progress.isComplete
        }
    };
    const transformedTasks = transformTasksForDatabase(progress.tasks);
    return { planData, tasks: transformedTasks };
}

function transformTasksForDatabase(rawTasks: any[]): InitialDetailedPlanAndTasks['tasksData'] {
    return rawTasks.map((t, idx) => {
        const taskNumber = t.task_number ?? idx + 1;
        const safeTitle = (t.title || '').trim() || `Task ${taskNumber}: Contextual refactor step`;
        const safeDescription = (t.description || '').trim() || `Auto-generated description for ${safeTitle.toLowerCase()}.`;
        const safePurpose = (t.purpose || '').trim() || 'Clarify intent and improve maintainability.';
        return {
            task_number: taskNumber, title: safeTitle, description: safeDescription, purpose: safePurpose,
            status: 'PLANNED', estimated_duration_days: t.estimated_duration_days, estimated_effort_hours: t.estimated_effort_hours,
            task_risks: t.task_risks, micro_steps: t.micro_steps,
            files_involved_json: t.files_involved, dependencies_task_ids_json: t.dependencies_task_ids,
            tools_required_list_json: t.required_skills, assigned_to: t.assigned_to, success_criteria_text: t.success_criteria,
            code_content: t.code_content, needs_code_generation: !!t.needs_code_generation,
            code_specification: t.code_specification, test_specification: t.test_specification,
            analysis_deliverables: t.analysis_deliverables, task_type: t.task_type,
            notes: { summary: safeDescription, rationale: safePurpose, ...t.notes },
        };
    });
}