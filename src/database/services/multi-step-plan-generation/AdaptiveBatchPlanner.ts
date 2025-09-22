import { DynamicPlanContext, ChangeTypeAnalysis, FileAnalysis } from './DynamicPlanAnalyzer.js';
import { BatchInstruction } from './types.js';
import { AIIntentAnalyzer, AIIntentAnalysis, EnhancedScenario } from './AIIntentAnalyzer.js';

export interface RefinedPromptContext {
    overall_goal: string;
    decomposed_tasks: any[];
    key_entities_identified: any[];
    explicit_constraints_from_prompt: any[];
    implicit_assumptions_made_by_refiner: any[];
}

export interface AdaptivePlanStructure {
    planComplexity: 'single_task' | 'simple_plan' | 'moderate_plan' | 'complex_plan' | 'enterprise_plan';
    totalBatches: number;
    adaptiveBatches: BatchInstruction[];
    planningRationale: string;
    skipMultiStep: boolean;
    usedRefinedPrompt: boolean;
    aiAnalysis?: AIIntentAnalysis; // Store AI analysis for reference
    scenario?: EnhancedScenario; // Store detected scenario
    usedLegacyFallback?: boolean; // Flag for backward compatibility
}

export class AdaptiveBatchPlanner {
    private aiIntentAnalyzer?: AIIntentAnalyzer;

    constructor(aiIntentAnalyzer?: AIIntentAnalyzer) {
        this.aiIntentAnalyzer = aiIntentAnalyzer;
    }

    /**
     * Enhanced planning with AI intent analysis
     */
    async createPlanWithAIAnalysis(
        goal: string,
        fileAnalyses: FileAnalysis[],
        startDateStr: string,
        endDateStr: string,
        refinedContext?: RefinedPromptContext
    ): Promise<AdaptivePlanStructure> {
        if (!this.aiIntentAnalyzer) {
            // Fall back to basic analysis if AI analyzer not available
            return this.createBasicPlan(goal, fileAnalyses, startDateStr, endDateStr);
        }

        try {
            // Get AI intent analysis
            const aiAnalysis = await this.aiIntentAnalyzer.analyzeUserIntent(goal, fileAnalyses, refinedContext);

            // Get enhanced scenario detection
            const scenario = await this.aiIntentAnalyzer.detectScenarioWithAI(goal, fileAnalyses);

            // Get planning configuration
            const planConfig = this.aiIntentAnalyzer.getPlanningConfiguration(aiAnalysis);

            // Check for legacy fallback
            if (planConfig.useLegacyFallback) {
                console.log('[AI Intent] Using legacy planning approach for complex enterprise scenario');
                return this.createLegacyCompatiblePlan(aiAnalysis, scenario, startDateStr, endDateStr);
            }

            // Create AI-driven plan
            return this.createAIDrivenPlan(aiAnalysis, scenario, fileAnalyses, startDateStr, endDateStr, planConfig);

        } catch (error) {
            console.warn('[AI Intent] AI analysis failed, falling back to basic planning:', error);
            return this.createBasicPlan(goal, fileAnalyses, startDateStr, endDateStr);
        }
    }

    /**
     * Creates AI-driven plan based on intent analysis
     */
    private async createAIDrivenPlan(
        aiAnalysis: AIIntentAnalysis,
        scenario: EnhancedScenario,
        fileAnalyses: FileAnalysis[],
        startDateStr: string,
        endDateStr: string,
        planConfig: any
    ): Promise<AdaptivePlanStructure> {
        const relevantFiles = fileAnalyses.map(f => f.filePath);

        // Determine plan complexity from AI analysis
        const planComplexity = this.mapComplexityToPlanType(aiAnalysis.taskComplexity);

        // Check if we should skip multi-step entirely
        if (aiAnalysis.recommendedSteps === 0 || aiAnalysis.planningStrategy === 'direct_execution') {
            return {
                planComplexity: 'single_task',
                totalBatches: 0,
                adaptiveBatches: [],
                planningRationale: `AI Analysis: ${aiAnalysis.reasoning} (Direct execution recommended)`,
                skipMultiStep: true,
                usedRefinedPrompt: false,
                aiAnalysis,
                scenario,
                usedLegacyFallback: false
            };
        }

        // Generate batches based on AI recommendations
        const adaptiveBatches = this.generateAIGuidedBatches(
            aiAnalysis,
            scenario,
            relevantFiles,
            startDateStr,
            endDateStr
        );

        return {
            planComplexity,
            totalBatches: adaptiveBatches.length,
            adaptiveBatches,
            planningRationale: this.buildAIRationale(aiAnalysis, scenario),
            skipMultiStep: false,
            usedRefinedPrompt: false,
            aiAnalysis,
            scenario,
            usedLegacyFallback: false
        };
    }

    /**
     * Maps AI complexity to plan type
     */
    private mapComplexityToPlanType(complexity: AIIntentAnalysis['taskComplexity']): AdaptivePlanStructure['planComplexity'] {
        switch (complexity) {
            case 'trivial': return 'single_task';
            case 'simple': return 'simple_plan';
            case 'moderate': return 'moderate_plan';
            case 'complex': return 'complex_plan';
            case 'enterprise': return 'enterprise_plan';
            default: return 'simple_plan';
        }
    }

    /**
     * Generates batches based on AI guidance
     */
    private generateAIGuidedBatches(
        aiAnalysis: AIIntentAnalysis,
        scenario: EnhancedScenario,
        relevantFiles: string[],
        startDateStr: string,
        endDateStr: string
    ): BatchInstruction[] {
        const batches: BatchInstruction[] = [];
        const startDate = new Date(startDateStr);
        const totalSteps = aiAnalysis.recommendedSteps;
        const daysPerBatch = Math.ceil(aiAnalysis.estimatedEffortHours / (totalSteps * 8)); // 8 hours per day

        // Generate batches based on the planning strategy
        switch (aiAnalysis.planningStrategy) {
            case 'simple_planning':
                return this.generateSimpleBatches(aiAnalysis, relevantFiles, startDate, daysPerBatch);
            case 'structured_planning':
                return this.generateStructuredBatches(aiAnalysis, relevantFiles, startDate, daysPerBatch);
            case 'comprehensive_planning':
                return this.generateComprehensiveBatches(aiAnalysis, relevantFiles, startDate, daysPerBatch);
            case 'enterprise_planning':
                return this.generateEnterpriseBatches(aiAnalysis, relevantFiles, startDate, daysPerBatch);
            default:
                return this.generateSimpleBatches(aiAnalysis, relevantFiles, startDate, daysPerBatch);
        }
    }

    /**
     * Generate simple batches (1-2 steps)
     */
    private generateSimpleBatches(
        aiAnalysis: AIIntentAnalysis,
        relevantFiles: string[],
        startDate: Date,
        daysPerBatch: number
    ): BatchInstruction[] {
        const batches: BatchInstruction[] = [];

        if (aiAnalysis.recommendedSteps === 1) {
            batches.push({
                batchNumber: 1,
                taskRange: "Task 1",
                specificInstruction: `Execute ${aiAnalysis.changeType} with focus on ${aiAnalysis.keyFactors.join(', ')}`,
                relevantFiles,
                expectedTaskCount: 1,
                buildUponTasks: [],
                estimatedBatchDays: Math.max(1, daysPerBatch),
                batchStartDate: startDate.toISOString().split('T')[0],
                batchEndDate: new Date(startDate.getTime() + Math.max(1, daysPerBatch) * 24*60*60*1000).toISOString().split('T')[0],
                taskTimingGuidelines: aiAnalysis.suggestedApproach,
                requiredNewFiles: [],
                codeComplexity: 'simple',
                primaryGoal: `Complete ${aiAnalysis.changeType}`,
                qualityGates: ["Implementation complete", "Quality verified"],
                dependsOnFiles: []
            });
        } else {
            // 2-step approach: analyze + implement
            batches.push({
                batchNumber: 1,
                taskRange: "Task 1",
                specificInstruction: `Analyze current state and plan ${aiAnalysis.changeType} approach`,
                relevantFiles,
                expectedTaskCount: 1,
                buildUponTasks: [],
                estimatedBatchDays: 1,
                batchStartDate: startDate.toISOString().split('T')[0],
                batchEndDate: new Date(startDate.getTime() + 24*60*60*1000).toISOString().split('T')[0],
                taskTimingGuidelines: "Focus on understanding and planning",
                requiredNewFiles: [],
                codeComplexity: 'simple',
                primaryGoal: "Analysis and planning",
                qualityGates: ["Analysis complete", "Plan validated"],
                dependsOnFiles: []
            });

            batches.push({
                batchNumber: 2,
                taskRange: "Task 2",
                specificInstruction: `Implement ${aiAnalysis.changeType} based on analysis`,
                relevantFiles,
                expectedTaskCount: 1,
                buildUponTasks: ["Analysis and planning"],
                estimatedBatchDays: Math.max(1, daysPerBatch - 1),
                batchStartDate: new Date(startDate.getTime() + 24*60*60*1000).toISOString().split('T')[0],
                batchEndDate: new Date(startDate.getTime() + Math.max(2, daysPerBatch) * 24*60*60*1000).toISOString().split('T')[0],
                taskTimingGuidelines: aiAnalysis.suggestedApproach,
                requiredNewFiles: this.determineNewFiles(aiAnalysis),
                codeComplexity: aiAnalysis.taskComplexity === 'simple' ? 'simple' : 'moderate',
                primaryGoal: `Execute ${aiAnalysis.changeType}`,
                qualityGates: ["Implementation complete", "Tests passing"],
                dependsOnFiles: []
            });
        }

        return batches;
    }

    /**
     * Generate structured batches (3-4 steps)
     */
    private generateStructuredBatches(
        aiAnalysis: AIIntentAnalysis,
        relevantFiles: string[],
        startDate: Date,
        daysPerBatch: number
    ): BatchInstruction[] {
        // Dynamic enterprise-grade planning based on complexity and scale
        return this.generateDynamicEnterpriseBatches(aiAnalysis, relevantFiles, startDate, daysPerBatch);
    }

    /**
     * Generate dynamic enterprise batches based on AI analysis
     */
    private generateDynamicEnterpriseBatches(
        aiAnalysis: AIIntentAnalysis,
        relevantFiles: string[],
        startDate: Date,
        daysPerBatch: number
    ): BatchInstruction[] {
        const totalTasks = aiAnalysis.recommendedSteps;
        const complexity = aiAnalysis.taskComplexity;
        const changeScope = aiAnalysis.changeScope;

        // Dynamic batch structure based on complexity and scope
        const batchStructure = this.determineBatchStructure(complexity, changeScope, totalTasks);
        console.log(`[Enterprise Planning] ${complexity} complexity with ${totalTasks} tasks → ${batchStructure.phases.length} phases`);

        // Calculate end date based on total days
        const totalDays = Math.ceil(aiAnalysis.estimatedEffortHours / 8); // 8 hours per day
        const endDate = new Date(startDate.getTime() + totalDays * 24 * 60 * 60 * 1000);

        return this.createBatchesFromStructure(batchStructure, aiAnalysis, relevantFiles, startDate, endDate, totalTasks);
    }

    /**
     * Determine optimal batch structure for enterprise planning
     */
    private determineBatchStructure(
        complexity: AIIntentAnalysis['taskComplexity'],
        scope: AIIntentAnalysis['changeScope'],
        totalTasks: number
    ): { phases: { name: string; taskCount: number; focus: string; critical: boolean }[]; totalBatches: number } {

        // Enterprise batch structures based on complexity
        switch (complexity) {
            case 'trivial':
                return {
                    phases: [{ name: 'Direct Execution', taskCount: Math.max(1, totalTasks), focus: 'immediate implementation', critical: false }],
                    totalBatches: 1
                };

            case 'simple':
                return {
                    phases: [
                        { name: 'Implementation', taskCount: Math.ceil(totalTasks * 0.8), focus: 'core changes', critical: true },
                        { name: 'Validation', taskCount: Math.ceil(totalTasks * 0.2), focus: 'testing and review', critical: true }
                    ],
                    totalBatches: 2
                };

            case 'moderate':
                return {
                    phases: [
                        { name: 'Analysis & Design', taskCount: Math.ceil(totalTasks * 0.25), focus: 'planning and architecture', critical: true },
                        { name: 'Core Implementation', taskCount: Math.ceil(totalTasks * 0.5), focus: 'primary development', critical: true },
                        { name: 'Testing & Quality', taskCount: Math.ceil(totalTasks * 0.25), focus: 'validation and quality assurance', critical: true }
                    ],
                    totalBatches: 3
                };

            case 'complex':
                return {
                    phases: [
                        { name: 'Discovery & Architecture', taskCount: Math.ceil(totalTasks * 0.2), focus: 'requirements and design', critical: true },
                        { name: 'Foundation Development', taskCount: Math.ceil(totalTasks * 0.3), focus: 'core infrastructure', critical: true },
                        { name: 'Feature Implementation', taskCount: Math.ceil(totalTasks * 0.3), focus: 'business logic and features', critical: true },
                        { name: 'Integration & Testing', taskCount: Math.ceil(totalTasks * 0.15), focus: 'system integration', critical: true },
                        { name: 'Quality & Deployment', taskCount: Math.ceil(totalTasks * 0.05), focus: 'final validation and release', critical: false }
                    ],
                    totalBatches: scope === 'system_wide' || scope === 'architectural' ? 5 : 4
                };

            case 'enterprise':
                return {
                    phases: [
                        { name: 'Strategic Planning', taskCount: Math.ceil(totalTasks * 0.15), focus: 'business alignment and architecture', critical: true },
                        { name: 'Foundation & Infrastructure', taskCount: Math.ceil(totalTasks * 0.25), focus: 'platform and shared services', critical: true },
                        { name: 'Core Development Phase 1', taskCount: Math.ceil(totalTasks * 0.2), focus: 'critical path implementation', critical: true },
                        { name: 'Core Development Phase 2', taskCount: Math.ceil(totalTasks * 0.2), focus: 'secondary implementation', critical: true },
                        { name: 'Integration & System Testing', taskCount: Math.ceil(totalTasks * 0.1), focus: 'end-to-end validation', critical: true },
                        { name: 'Performance & Security', taskCount: Math.ceil(totalTasks * 0.05), focus: 'non-functional requirements', critical: true },
                        { name: 'Deployment & Monitoring', taskCount: Math.ceil(totalTasks * 0.05), focus: 'production readiness', critical: false }
                    ],
                    totalBatches: 7
                };

            default:
                return this.determineBatchStructure('moderate', scope, totalTasks);
        }
    }

    /**
     * Creates batches from the dynamic batch structure for enterprise-grade planning
     */
    private createBatchesFromStructure(
        structure: any,
        aiAnalysis: any,
        relevantFiles: string[],
        startDate: Date,
        endDate: Date,
        totalTasks: number
    ): BatchInstruction[] {
        const batches: BatchInstruction[] = [];
        const totalDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
        const daysPerBatch = totalDays / structure.totalBatches;

        let currentTaskStart = 1;
        let currentDate = new Date(startDate);

        // Generate batches from phase structure
        structure.phases.forEach((phase: any, index: number) => {
            const phaseEndDate = new Date(currentDate.getTime() + Math.ceil(daysPerBatch) * 24 * 60 * 60 * 1000);
            const taskEnd = currentTaskStart + phase.taskCount - 1;

            batches.push({
                batchNumber: index + 1,
                taskRange: `Tasks ${currentTaskStart}-${taskEnd}`,
                specificInstruction: `${phase.name}: ${phase.focus}`,
                relevantFiles,
                expectedTaskCount: phase.taskCount,
                buildUponTasks: index > 0 ? [structure.phases[index - 1].name] : [],
                estimatedBatchDays: Math.ceil(daysPerBatch),
                batchStartDate: currentDate.toISOString().split('T')[0],
                batchEndDate: phaseEndDate.toISOString().split('T')[0],
                taskTimingGuidelines: this.getPhaseGuidelines(phase.name, aiAnalysis),
                requiredNewFiles: index === 0 ? [] : this.determineNewFiles(aiAnalysis),
                codeComplexity: this.determinePhaseComplexity(phase.name),
                primaryGoal: phase.name,
                qualityGates: this.getPhaseQualityGates(phase.name),
                dependsOnFiles: relevantFiles
            });

            currentTaskStart = taskEnd + 1;
            currentDate = phaseEndDate;
        });

        return batches;
    }

    /**
     * Get phase-specific guidelines
     */
    private getPhaseGuidelines(phaseName: string, aiAnalysis: any): string {
        const guidelines: { [key: string]: string } = {
            'Strategic Planning': 'Define business requirements and technical architecture',
            'Foundation & Infrastructure': 'Set up core infrastructure and shared services',
            'Core Development Phase 1': 'Implement critical path features',
            'Core Development Phase 2': 'Complete secondary features and integrations',
            'Integration & System Testing': 'End-to-end testing and validation',
            'Performance & Security': 'Optimize performance and security hardening',
            'Deployment & Monitoring': 'Production deployment and monitoring setup',
            'Direct Execution': 'Complete the task efficiently in single execution',
            'Implementation': aiAnalysis?.suggestedApproach || 'Focus on core implementation',
            'Validation': 'Test and validate all implementations',
            'Analysis & Design': 'Thorough analysis and architectural design',
            'Testing & Quality': 'Comprehensive testing and quality assurance'
        };

        return guidelines[phaseName] || 'Execute phase tasks systematically';
    }

    /**
     * Determine complexity level for each phase
     */
    private determinePhaseComplexity(phaseName: string): 'simple' | 'moderate' | 'complex' {
        const complexityMap: { [key: string]: 'simple' | 'moderate' | 'complex' } = {
            'Strategic Planning': 'complex',
            'Foundation & Infrastructure': 'complex',
            'Core Development Phase 1': 'complex',
            'Core Development Phase 2': 'moderate',
            'Integration & System Testing': 'moderate',
            'Performance & Security': 'complex',
            'Deployment & Monitoring': 'moderate',
            'Direct Execution': 'simple',
            'Implementation': 'moderate',
            'Validation': 'simple',
            'Analysis & Design': 'moderate',
            'Testing & Quality': 'moderate'
        };

        return complexityMap[phaseName] || 'moderate';
    }

    /**
     * Get quality gates for each phase
     */
    private getPhaseQualityGates(phaseName: string): string[] {
        const qualityGates: { [key: string]: string[] } = {
            'Strategic Planning': ['Requirements documented', 'Architecture approved', 'Risk assessment complete'],
            'Foundation & Infrastructure': ['Infrastructure provisioned', 'Base services deployed', 'Security configured'],
            'Core Development Phase 1': ['Critical features implemented', 'Unit tests passing', 'Code reviewed'],
            'Core Development Phase 2': ['All features implemented', 'Integration tests passing', 'Documentation updated'],
            'Integration & System Testing': ['End-to-end tests passing', 'Performance benchmarks met', 'User acceptance complete'],
            'Performance & Security': ['Performance optimized', 'Security audit passed', 'Load testing complete'],
            'Deployment & Monitoring': ['Production deployed', 'Monitoring active', 'Rollback plan tested'],
            'Direct Execution': ['Task completed', 'Basic validation passed'],
            'Implementation': ['Core functionality working', 'Basic tests passing'],
            'Validation': ['All tests passing', 'Quality standards met'],
            'Analysis & Design': ['Requirements clear', 'Design approved'],
            'Testing & Quality': ['All tests passing', 'Quality metrics met']
        };

        return qualityGates[phaseName] || ['Phase objectives met', 'Quality standards achieved'];
    }

    /**
     * Generate comprehensive batches (5-8 steps)
     */
    private generateComprehensiveBatches(
        aiAnalysis: AIIntentAnalysis,
        relevantFiles: string[],
        startDate: Date,
        daysPerBatch: number
    ): BatchInstruction[] {
        // Implementation for comprehensive planning
        return this.generateStructuredBatches(aiAnalysis, relevantFiles, startDate, daysPerBatch);
    }

    /**
     * Generate enterprise batches (8+ steps)
     */
    private generateEnterpriseBatches(
        aiAnalysis: AIIntentAnalysis,
        relevantFiles: string[],
        startDate: Date,
        daysPerBatch: number
    ): BatchInstruction[] {
        // Implementation for enterprise-level planning
        return this.generateStructuredBatches(aiAnalysis, relevantFiles, startDate, daysPerBatch);
    }

    /**
     * Determines if new files are needed based on AI analysis
     */
    private determineNewFiles(aiAnalysis: AIIntentAnalysis): Array<{path: string; purpose: string; fileType: 'module' | 'component' | 'service' | 'utility' | 'config' | 'test'}> {
        const files: Array<{path: string; purpose: string; fileType: 'module' | 'component' | 'service' | 'utility' | 'config' | 'test'}> = [];

        if (aiAnalysis.changeType === 'modularization') {
            files.push({
                path: "src/modules/extracted/index.ts",
                purpose: "Main module export file",
                fileType: "module"
            });
        }

        if (aiAnalysis.changeType === 'testing') {
            files.push({
                path: "tests/generated.test.ts",
                purpose: "Generated test file",
                fileType: "test"
            });
        }

        return files;
    }

    /**
     * Builds rationale based on AI analysis
     */
    private buildAIRationale(aiAnalysis: AIIntentAnalysis, scenario: EnhancedScenario): string {
        return [
            `AI Intent Analysis Results:`,
            `- Detected Scenario: ${scenario.name}`,
            `- Complexity: ${aiAnalysis.taskComplexity} (${aiAnalysis.confidence * 100}% confidence)`,
            `- Scope: ${aiAnalysis.changeScope}`,
            `- Type: ${aiAnalysis.changeType}`,
            `- Risk Level: ${aiAnalysis.riskLevel}`,
            `- Estimated Effort: ${aiAnalysis.estimatedEffortHours} hours`,
            `- Strategy: ${aiAnalysis.planningStrategy}`,
            ``,
            `Reasoning: ${aiAnalysis.reasoning}`,
            ``,
            `Key Factors: ${aiAnalysis.keyFactors.join(', ')}`,
            aiAnalysis.prerequisites.length > 0 ? `Prerequisites: ${aiAnalysis.prerequisites.join(', ')}` : '',
            aiAnalysis.potentialChallenges.length > 0 ? `Challenges: ${aiAnalysis.potentialChallenges.join(', ')}` : ''
        ].filter(Boolean).join('\n');
    }

    /**
     * Creates legacy-compatible plan for backward compatibility
     */
    private createLegacyCompatiblePlan(
        aiAnalysis: AIIntentAnalysis,
        scenario: EnhancedScenario,
        startDateStr: string,
        endDateStr: string
    ): AdaptivePlanStructure {
        return {
            planComplexity: 'enterprise_plan',
            totalBatches: 0, // Will be filled by legacy system
            adaptiveBatches: [], // Will be filled by legacy system
            planningRationale: `Legacy planning mode activated for enterprise scenario: ${scenario.name}`,
            skipMultiStep: false,
            usedRefinedPrompt: false,
            aiAnalysis,
            scenario,
            usedLegacyFallback: true
        };
    }

    /**
     * Creates basic plan when AI analysis is not available
     */
    private createBasicPlan(
        goal: string,
        fileAnalyses: FileAnalysis[],
        startDateStr: string,
        endDateStr: string
    ): AdaptivePlanStructure {
        // Fall back to the original logic
        const goalLower = goal.toLowerCase();
        const isSimple = goalLower.includes('refactor') || goalLower.includes('fix') || goalLower.includes('improve');

        return {
            planComplexity: isSimple ? 'simple_plan' : 'moderate_plan',
            totalBatches: isSimple ? 2 : 3,
            adaptiveBatches: [], // Would be filled by original logic
            planningRationale: 'Basic planning (AI analysis unavailable)',
            skipMultiStep: false,
            usedRefinedPrompt: false,
            usedLegacyFallback: false
        };
    }

    /**
     * Creates adaptive plan for refined prompts using decomposed tasks
     */
    createPlanFromRefinedPrompt(
        refinedContext: RefinedPromptContext,
        fileAnalyses: FileAnalysis[],
        startDateStr: string,
        endDateStr: string
    ): AdaptivePlanStructure {

        const taskCount = refinedContext.decomposed_tasks.length;
        const complexity = this.analyzeRefinedPromptComplexity(refinedContext, fileAnalyses);

        // Determine batching strategy based on decomposed tasks
        const batchStrategy = this.determineBatchingFromTasks(refinedContext.decomposed_tasks, complexity);

        const adaptiveBatches = this.createBatchesFromDecomposedTasks(
            refinedContext,
            fileAnalyses,
            batchStrategy,
            startDateStr,
            endDateStr
        );

        return {
            planComplexity: complexity,
            totalBatches: adaptiveBatches.length,
            adaptiveBatches,
            planningRationale: this.generateRefinedPromptRationale(refinedContext, batchStrategy),
            skipMultiStep: false,
            usedRefinedPrompt: true
        };
    }

    /**
     * Creates adaptive plan for direct goals using dynamic analysis
     */
    createPlanFromGoalAnalysis(
        context: DynamicPlanContext,
        startDateStr: string,
        endDateStr: string
    ): AdaptivePlanStructure {

        const { goalAnalysis, fileAnalyses, totalComplexity, recommendedStrategy } = context;

        // Check if we should skip multi-step planning entirely
        if (this.shouldSkipMultiStep(goalAnalysis, fileAnalyses, recommendedStrategy)) {
            return {
                planComplexity: 'single_task',
                totalBatches: 0,
                adaptiveBatches: [],
                planningRationale: 'Simple change detected - single task execution recommended',
                skipMultiStep: true,
                usedRefinedPrompt: false
            };
        }

        const adaptiveBatches = this.generateAdaptiveBatches(context, startDateStr, endDateStr);

        return {
            planComplexity: recommendedStrategy,
            totalBatches: adaptiveBatches.length,
            adaptiveBatches,
            planningRationale: this.generateGoalAnalysisRationale(context),
            skipMultiStep: false,
            usedRefinedPrompt: false
        };
    }

    /**
     * Analyzes complexity from refined prompt structure
     */
    private analyzeRefinedPromptComplexity(
        refinedContext: RefinedPromptContext,
        fileAnalyses: FileAnalysis[]
    ): 'simple_plan' | 'moderate_plan' | 'complex_plan' {

        const taskCount = refinedContext.decomposed_tasks.length;
        const entityCount = refinedContext.key_entities_identified.length;
        const constraintCount = refinedContext.explicit_constraints_from_prompt.length;
        const fileComplexityScore = fileAnalyses.reduce((sum, f) =>
            sum + (f.complexity === 'simple' ? 1 : f.complexity === 'moderate' ? 2 : 3), 0
        );

        // Calculate complexity score
        const complexityScore = taskCount + (entityCount * 0.5) + constraintCount + (fileComplexityScore * 0.3);

        if (complexityScore <= 4) return 'simple_plan';
        if (complexityScore <= 8) return 'moderate_plan';
        return 'complex_plan';
    }

    /**
     * Determines batching strategy from decomposed tasks
     */
    private determineBatchingFromTasks(
        decomposedTasks: any[],
        complexity: 'simple_plan' | 'moderate_plan' | 'complex_plan'
    ): { batchCount: number; tasksPerBatch: number[] } {

        const taskCount = decomposedTasks.length;

        switch (complexity) {
            case 'simple_plan':
                if (taskCount <= 3) {
                    return { batchCount: 1, tasksPerBatch: [taskCount] };
                } else {
                    return { batchCount: 2, tasksPerBatch: [Math.ceil(taskCount/2), Math.floor(taskCount/2)] };
                }

            case 'moderate_plan':
                if (taskCount <= 4) {
                    return { batchCount: 2, tasksPerBatch: [Math.ceil(taskCount/2), Math.floor(taskCount/2)] };
                } else {
                    return { batchCount: 3, tasksPerBatch: this.distributeTasks(taskCount, 3) };
                }

            case 'complex_plan':
                if (taskCount <= 6) {
                    return { batchCount: 3, tasksPerBatch: this.distributeTasks(taskCount, 3) };
                } else {
                    return { batchCount: Math.min(4, Math.ceil(taskCount / 3)), tasksPerBatch: this.distributeTasks(taskCount, Math.min(4, Math.ceil(taskCount / 3))) };
                }
        }
    }

    /**
     * Distributes tasks evenly across batches
     */
    private distributeTasks(totalTasks: number, batchCount: number): number[] {
        const tasksPerBatch: number[] = [];
        const baseTasksPerBatch = Math.floor(totalTasks / batchCount);
        const remainder = totalTasks % batchCount;

        for (let i = 0; i < batchCount; i++) {
            tasksPerBatch.push(baseTasksPerBatch + (i < remainder ? 1 : 0));
        }

        return tasksPerBatch;
    }

    /**
     * Creates batches from decomposed tasks
     */
    private createBatchesFromDecomposedTasks(
        refinedContext: RefinedPromptContext,
        fileAnalyses: FileAnalysis[],
        batchStrategy: { batchCount: number; tasksPerBatch: number[] },
        startDateStr: string,
        endDateStr: string
    ): BatchInstruction[] {

        const batches: BatchInstruction[] = [];
        const startDate = new Date(startDateStr);
        const relevantFiles = fileAnalyses.map(f => f.filePath);
        let taskIndex = 0;

        for (let batchNum = 0; batchNum < batchStrategy.batchCount; batchNum++) {
            const tasksInBatch = batchStrategy.tasksPerBatch[batchNum];
            const batchTasks = refinedContext.decomposed_tasks.slice(taskIndex, taskIndex + tasksInBatch);
            taskIndex += tasksInBatch;

            const batchStartDate = new Date(startDate.getTime() + (batchNum * 3 * 24 * 60 * 60 * 1000));
            const batchEndDate = new Date(batchStartDate.getTime() + (3 * 24 * 60 * 60 * 1000));

            // Create batch instruction based on the tasks
            const batchInstruction = this.createBatchFromTasks(
                batchNum + 1,
                batchTasks,
                relevantFiles,
                batchStartDate,
                batchEndDate,
                taskIndex - tasksInBatch + 1,
                taskIndex
            );

            batches.push(batchInstruction);
        }

        return batches;
    }

    /**
     * Creates a single batch instruction from a group of tasks
     */
    private createBatchFromTasks(
        batchNumber: number,
        tasks: any[],
        relevantFiles: string[],
        startDate: Date,
        endDate: Date,
        startTaskNumber: number,
        endTaskNumber: number
    ): BatchInstruction {

        const taskTitles = tasks.map(t => t.title || t.task_title || `Task ${startTaskNumber + tasks.indexOf(t)}`);
        const taskDescriptions = tasks.map(t => t.description || t.task_description || '');

        // Create comprehensive instruction from task descriptions
        const specificInstruction = `Execute refined prompt tasks: ${taskTitles.join(', ')}. ${taskDescriptions.join(' ')}`.substring(0, 200);

        // Determine if new files are needed based on task content
        const requiresNewFiles = tasks.some(t => {
            const content = `${t.title} ${t.description}`.toLowerCase();
            return content.includes('create') || content.includes('new file') || content.includes('extract') || content.includes('separate');
        });

        return {
            batchNumber,
            taskRange: `Tasks ${startTaskNumber}-${endTaskNumber}`,
            specificInstruction,
            relevantFiles,
            expectedTaskCount: tasks.length,
            buildUponTasks: batchNumber > 1 ? [`Batch ${batchNumber - 1} completion`] : [],
            estimatedBatchDays: Math.max(2, Math.min(5, tasks.length * 1.5)),
            batchStartDate: startDate.toISOString().split('T')[0],
            batchEndDate: endDate.toISOString().split('T')[0],
            taskTimingGuidelines: `Focus on completing ${tasks.length} refined prompt tasks`,
            requiredNewFiles: requiresNewFiles ? this.generateNewFilesFromTasks(tasks) : [],
            codeComplexity: tasks.length > 3 ? 'complex' : tasks.length > 1 ? 'moderate' : 'simple',
            primaryGoal: taskTitles[0] || `Complete batch ${batchNumber} tasks`,
            qualityGates: [`Batch ${batchNumber} tasks completed`, "Quality verification passed"],
            dependsOnFiles: []
        };
    }

    /**
     * Generates new files based on task content analysis
     */
    private generateNewFilesFromTasks(tasks: any[]): Array<{path: string; purpose: string; fileType: 'module' | 'component' | 'service' | 'utility' | 'config' | 'test'}> {
        const files: Array<{path: string; purpose: string; fileType: 'module' | 'component' | 'service' | 'utility' | 'config' | 'test'}> = [];

        tasks.forEach((task, index) => {
            const content = `${task.title} ${task.description}`.toLowerCase();

            if (content.includes('extract') || content.includes('separate')) {
                files.push({
                    path: `src/extracted/module-${index + 1}.ts`,
                    purpose: `Extracted module from ${task.title}`,
                    fileType: 'module'
                });
            }

            if (content.includes('service') || content.includes('api')) {
                files.push({
                    path: `src/services/new-service-${index + 1}.ts`,
                    purpose: `Service implementation for ${task.title}`,
                    fileType: 'service'
                });
            }
        });

        return files;
    }

    /**
     * Generates rationale for refined prompt planning
     */
    private generateRefinedPromptRationale(
        refinedContext: RefinedPromptContext,
        batchStrategy: { batchCount: number; tasksPerBatch: number[] }
    ): string {
        return [
            `Used refined prompt with ${refinedContext.decomposed_tasks.length} pre-analyzed tasks`,
            `Goal: ${refinedContext.overall_goal}`,
            `Entities: ${refinedContext.key_entities_identified.length} identified`,
            `Batching: ${batchStrategy.batchCount} batches with ${batchStrategy.tasksPerBatch.join(', ')} tasks each`,
            `Constraints: ${refinedContext.explicit_constraints_from_prompt.length} explicit constraints considered`
        ].join('\n');
    }

    // Keep existing methods for goal analysis...
    private shouldSkipMultiStep(goalAnalysis: ChangeTypeAnalysis, fileAnalyses: FileAnalysis[], strategy: DynamicPlanContext['recommendedStrategy']): boolean {
        return strategy === 'single_task' ||
               (goalAnalysis.changeType === 'bug_fix' && fileAnalyses.every(f => f.complexity === 'simple'));
    }

    private generateAdaptiveBatches(context: DynamicPlanContext, startDateStr: string, endDateStr: string): BatchInstruction[] {
        // Implementation for goal-based planning (existing logic)
        return [];
    }

    private generateGoalAnalysisRationale(context: DynamicPlanContext): string {
        const { goalAnalysis, fileAnalyses, totalComplexity } = context;
        return [
            `Direct goal analysis: ${goalAnalysis.changeType.replace('_', ' ')}`,
            `Files: ${fileAnalyses.length} with ${totalComplexity} complexity`,
            `Confidence: ${(goalAnalysis.confidence * 100).toFixed(0)}%`,
            `Reasoning: ${goalAnalysis.reason}`
        ].join('\n');
    }
}