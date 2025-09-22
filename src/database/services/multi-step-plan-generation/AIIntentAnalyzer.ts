import { GeminiIntegrationService } from '../GeminiIntegrationService.js';
import { parseGeminiJsonResponse } from '../gemini-integration-modules/GeminiResponseParsers.js';
import { MemoryManager } from '../../memory_manager.js';
import { FileAnalysis } from './DynamicPlanAnalyzer.js';
import { callGemini } from './gemini-interaction.js';

export interface AIIntentAnalysis {
    taskComplexity: 'trivial' | 'simple' | 'moderate' | 'complex' | 'enterprise';
    changeScope: 'single_file' | 'few_files' | 'module_level' | 'system_wide' | 'architectural';
    changeType: 'bug_fix' | 'refactoring' | 'feature_addition' | 'optimization' | 'standardization' | 'modularization' | 'infrastructure' | 'migration' | 'testing' | 'documentation';
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    estimatedEffortHours: number;
    recommendedSteps: number;
    planningStrategy: 'direct_execution' | 'simple_planning' | 'structured_planning' | 'comprehensive_planning' | 'enterprise_planning';
    confidence: number;
    reasoning: string;
    keyFactors: string[];
    prerequisites: string[];
    potentialChallenges: string[];
    suggestedApproach: string;
}

export interface EnhancedScenario {
    name: string;
    indicators: string[];
    complexity: AIIntentAnalysis['taskComplexity'];
    steps: number;
    strategy: AIIntentAnalysis['planningStrategy'];
    description: string;
}

export class AIIntentAnalyzer {
    private geminiService: GeminiIntegrationService;
    private memoryManager: MemoryManager;

    constructor(geminiService: GeminiIntegrationService, memoryManager: MemoryManager) {
        this.geminiService = geminiService;
        this.memoryManager = memoryManager;
    }

    /**
     * Uses AI to analyze the user's intent and determine optimal planning approach
     */
    async analyzeUserIntent(
        goal: string,
        fileAnalyses: FileAnalysis[],
        refinedContext?: any
    ): Promise<AIIntentAnalysis> {
        const analysisPrompt = this.buildIntentAnalysisPrompt(goal, fileAnalyses, refinedContext);
        const systemInstruction = 'You are an expert software engineering intent analyzer and project planning specialist.';

        // Use the existing gemini-interaction.ts which handles MultiModelOrchestrator properly
        const responseContent = await callGemini(
            this.geminiService,
            systemInstruction,
            analysisPrompt
        );

        const analysis = await parseGeminiJsonResponse(responseContent, {
            contextDescription: 'AI Intent Analysis',
            memoryManager: this.memoryManager,
            geminiService: this.geminiService,
            enableAIRepair: true
        });

        return this.validateAndNormalizeAnalysis(analysis);
    }

    /**
     * Enhanced scenario detection with AI assistance
     */
    async detectScenarioWithAI(
        goal: string,
        fileAnalyses: FileAnalysis[]
    ): Promise<EnhancedScenario> {
        const predefinedScenarios = this.getPredefinedScenarios();

        // First try rule-based matching
        const ruleBasedMatch = this.matchPredefinedScenarios(goal, fileAnalyses, predefinedScenarios);

        if (ruleBasedMatch.confidence > 0.8) {
            return ruleBasedMatch.scenario;
        }

        // Fall back to AI analysis for complex or unclear cases
        const aiAnalysis = await this.analyzeUserIntent(goal, fileAnalyses);

        return {
            name: `AI_Detected_${aiAnalysis.changeType}_${aiAnalysis.changeScope}`,
            indicators: aiAnalysis.keyFactors,
            complexity: aiAnalysis.taskComplexity,
            steps: aiAnalysis.recommendedSteps,
            strategy: aiAnalysis.planningStrategy,
            description: aiAnalysis.suggestedApproach
        };
    }

    /**
     * Builds comprehensive prompt for AI intent analysis
     */
    private buildIntentAnalysisPrompt(
        goal: string,
        fileAnalyses: FileAnalysis[],
        refinedContext?: any
    ): string {
        const filesSummary = fileAnalyses.map(f =>
            `- ${f.filePath}: ${f.lineCount} lines, ${f.entityCount} entities, ${f.complexity} complexity`
        ).join('\n');

        const refinedInfo = refinedContext ? `
**REFINED CONTEXT AVAILABLE:**
- Decomposed Tasks: ${refinedContext.decomposed_tasks?.length || 0}
- Key Entities: ${refinedContext.key_entities_identified?.length || 0}
- Constraints: ${refinedContext.explicit_constraints_from_prompt?.length || 0}
- Overall Goal: ${refinedContext.overall_goal || 'Not specified'}
` : '';

        return `You are an expert software engineering intent analyzer. Analyze the following request to determine the optimal planning approach.

**USER GOAL:**
${goal}

**FILES TO BE MODIFIED:**
${filesSummary || 'No files specified'}

${refinedInfo}

**ANALYSIS FRAMEWORK:**

**1. TASK COMPLEXITY LEVELS:**
- **trivial**: Single line changes, typo fixes, simple variable renames (1-2 hours)
- **simple**: Single file refactoring, basic bug fixes, style improvements (2-8 hours)
- **moderate**: Multi-file changes, feature enhancements, module restructuring (1-3 days)
- **complex**: System integration, architectural changes, major refactoring (3-7 days)
- **enterprise**: Large-scale migrations, complete system overhauls (1+ weeks)

**2. CHANGE SCOPE:**
- **single_file**: Changes limited to one file
- **few_files**: 2-5 related files
- **module_level**: Entire module or component
- **system_wide**: Multiple modules/systems
- **architectural**: Core system architecture

**3. CHANGE TYPES:**
- **bug_fix**: Fixing errors or issues
- **refactoring**: Improving code structure without changing behavior
- **feature_addition**: Adding new functionality
- **optimization**: Performance or efficiency improvements
- **standardization**: Code style, formatting, conventions
- **modularization**: Breaking down monolithic code
- **infrastructure**: Build, deployment, tooling changes
- **migration**: Moving between technologies/frameworks
- **testing**: Adding or improving tests
- **documentation**: Adding or improving documentation

**4. PLANNING STRATEGIES:**
- **direct_execution**: No planning needed, immediate execution (0 steps)
- **simple_planning**: Basic task breakdown (1-2 steps)
- **structured_planning**: Moderate planning with dependencies (3-4 steps)
- **comprehensive_planning**: Detailed planning with phases (5-8 steps)
- **enterprise_planning**: Full project management approach (8+ steps)

**5. RISK ASSESSMENT:**
Consider breaking changes, dependencies, complexity, and potential for issues.

**ENHANCED SCENARIO DETECTION:**
Analyze for these specific patterns:

**TRIVIAL SCENARIOS (0-1 steps):**
- Typo fixes, comment updates, single variable renames
- Simple configuration changes
- Minor text adjustments

**SIMPLE SCENARIOS (1-2 steps):**
- Single file code cleanup (style, formatting, variable naming)
- Basic bug fixes in isolated functions
- Error handling improvements within existing structure
- Performance optimizations without architectural changes
- Simple feature toggles

**MODERATE SCENARIOS (3-4 steps):**
- Single file refactoring with structural changes (encapsulation, design patterns)
- Multi-file refactoring with maintained interfaces
- Feature additions to existing modules
- API endpoint additions
- Test suite additions

**COMPLEX SCENARIOS (5-6 steps):**
- Module extractions and reorganization
- Database schema changes
- API versioning and migration
- Cross-cutting concerns (logging, security)
- Framework upgrades

**ENTERPRISE SCENARIOS (7+ steps):**
- Complete system redesigns
- Technology stack migrations
- Microservices decomposition
- Legacy system modernization
- Multi-team coordination requirements

**SPECIAL CONSIDERATIONS:**
- **Backwards Compatibility**: Assess impact on existing functionality
- **Testing Requirements**: Determine if new tests are needed
- **Documentation Needs**: Identify documentation updates required
- **Deployment Complexity**: Consider rollout and rollback strategies
- **Team Coordination**: Assess if multiple developers are involved

Provide your analysis in this JSON format:

{
  "taskComplexity": "trivial|simple|moderate|complex|enterprise",
  "changeScope": "single_file|few_files|module_level|system_wide|architectural",
  "changeType": "bug_fix|refactoring|feature_addition|optimization|standardization|modularization|infrastructure|migration|testing|documentation",
  "riskLevel": "low|medium|high|critical",
  "estimatedEffortHours": <number>,
  "recommendedSteps": <number>,
  "planningStrategy": "direct_execution|simple_planning|structured_planning|comprehensive_planning|enterprise_planning",
  "confidence": <0.0-1.0>,
  "reasoning": "Detailed explanation of the analysis",
  "keyFactors": ["factor1", "factor2", "factor3"],
  "prerequisites": ["prereq1", "prereq2"],
  "potentialChallenges": ["challenge1", "challenge2"],
  "suggestedApproach": "High-level approach recommendation"
}

**CRITICAL**: Be conservative with step counts. Prefer fewer steps unless complexity truly justifies more.`;
    }

    /**
     * Predefined scenarios for rule-based matching
     */
    private getPredefinedScenarios(): EnhancedScenario[] {
        return [
            // TRIVIAL SCENARIOS (0-1 steps)
            {
                name: 'typo_fix',
                indicators: ['typo', 'spelling', 'comment fix', 'text correction'],
                complexity: 'trivial',
                steps: 0,
                strategy: 'direct_execution',
                description: 'Simple text corrections requiring no planning'
            },
            {
                name: 'variable_rename',
                indicators: ['rename variable', 'rename function', 'single rename'],
                complexity: 'trivial',
                steps: 1,
                strategy: 'direct_execution',
                description: 'Single variable or function rename'
            },

            // SIMPLE SCENARIOS (1-2 steps)
            {
                name: 'single_file_refactor',
                indicators: ['refactor', 'clean up', 'improve', 'single file'],
                complexity: 'simple',
                steps: 2,
                strategy: 'simple_planning',
                description: 'Refactoring within a single file'
            },
            {
                name: 'basic_bug_fix',
                indicators: ['fix bug', 'fix error', 'fix issue', 'quick fix'],
                complexity: 'simple',
                steps: 1,
                strategy: 'simple_planning',
                description: 'Straightforward bug fix in isolated code'
            },
            {
                name: 'code_standardization',
                indicators: ['standardize', 'format', 'lint', 'style', 'convention'],
                complexity: 'simple',
                steps: 2,
                strategy: 'simple_planning',
                description: 'Apply coding standards and formatting'
            },

            // MODERATE SCENARIOS (3-4 steps)
            {
                name: 'multi_file_refactor',
                indicators: ['refactor multiple', 'improve structure', 'reorganize'],
                complexity: 'moderate',
                steps: 3,
                strategy: 'structured_planning',
                description: 'Refactoring across multiple related files'
            },
            {
                name: 'feature_enhancement',
                indicators: ['add feature', 'enhance', 'extend functionality'],
                complexity: 'moderate',
                steps: 4,
                strategy: 'structured_planning',
                description: 'Adding new features to existing systems'
            },
            {
                name: 'performance_optimization',
                indicators: ['optimize', 'performance', 'efficiency', 'speed up'],
                complexity: 'moderate',
                steps: 3,
                strategy: 'structured_planning',
                description: 'Performance improvements with measurement'
            },
            {
                name: 'api_addition',
                indicators: ['add api', 'new endpoint', 'add route'],
                complexity: 'moderate',
                steps: 4,
                strategy: 'structured_planning',
                description: 'Adding new API endpoints with tests'
            },

            // COMPLEX SCENARIOS (5-6 steps)
            {
                name: 'module_extraction',
                indicators: ['extract module', 'modularize', 'separate concerns'],
                complexity: 'complex',
                steps: 5,
                strategy: 'comprehensive_planning',
                description: 'Extracting code into separate modules'
            },
            {
                name: 'database_schema_change',
                indicators: ['database', 'schema', 'migration', 'alter table'],
                complexity: 'complex',
                steps: 6,
                strategy: 'comprehensive_planning',
                description: 'Database changes with migration strategy'
            },
            {
                name: 'framework_integration',
                indicators: ['integrate framework', 'add library', 'framework'],
                complexity: 'complex',
                steps: 5,
                strategy: 'comprehensive_planning',
                description: 'Integrating new frameworks or major libraries'
            },
            {
                name: 'security_implementation',
                indicators: ['security', 'authentication', 'authorization', 'encrypt'],
                complexity: 'complex',
                steps: 6,
                strategy: 'comprehensive_planning',
                description: 'Security features requiring careful implementation'
            },

            // ENTERPRISE SCENARIOS (7+ steps)
            {
                name: 'system_redesign',
                indicators: ['redesign', 'rewrite', 'complete overhaul'],
                complexity: 'enterprise',
                steps: 8,
                strategy: 'enterprise_planning',
                description: 'Major system redesign or rewrite'
            },
            {
                name: 'technology_migration',
                indicators: ['migrate', 'upgrade framework', 'technology stack'],
                complexity: 'enterprise',
                steps: 10,
                strategy: 'enterprise_planning',
                description: 'Migrating to new technology stack'
            },
            {
                name: 'microservices_decomposition',
                indicators: ['microservices', 'decompose', 'split system'],
                complexity: 'enterprise',
                steps: 12,
                strategy: 'enterprise_planning',
                description: 'Breaking monolith into microservices'
            },
            {
                name: 'legacy_modernization',
                indicators: ['modernize', 'legacy', 'update old code'],
                complexity: 'enterprise',
                steps: 15,
                strategy: 'enterprise_planning',
                description: 'Modernizing legacy systems'
            }
        ];
    }

    /**
     * Rule-based scenario matching with confidence scoring
     */
    private matchPredefinedScenarios(
        goal: string,
        fileAnalyses: FileAnalysis[],
        scenarios: EnhancedScenario[]
    ): { scenario: EnhancedScenario; confidence: number } {
        const goalLower = goal.toLowerCase();
        const fileCount = fileAnalyses.length;
        const avgComplexity = this.calculateAverageComplexity(fileAnalyses);

        let bestMatch: EnhancedScenario | null = null;
        let bestScore = 0;

        for (const scenario of scenarios) {
            let score = 0;
            let matches = 0;

            // Check indicator matches
            for (const indicator of scenario.indicators) {
                if (goalLower.includes(indicator.toLowerCase())) {
                    matches++;
                    score += 1;
                }
            }

            // File count consideration
            if (scenario.name.includes('single_file') && fileCount === 1) score += 0.5;
            if (scenario.name.includes('multi_file') && fileCount > 1) score += 0.5;

            // Complexity alignment
            if (scenario.complexity === avgComplexity) score += 0.3;

            // Normalize score
            const normalizedScore = matches > 0 ? score / scenario.indicators.length : 0;

            if (normalizedScore > bestScore) {
                bestScore = normalizedScore;
                bestMatch = scenario;
            }
        }

        return {
            scenario: bestMatch || scenarios[0], // Default to first scenario
            confidence: bestScore
        };
    }

    /**
     * Calculate average complexity from file analyses
     */
    private calculateAverageComplexity(fileAnalyses: FileAnalysis[]): 'trivial' | 'simple' | 'moderate' | 'complex' | 'enterprise' {
        if (fileAnalyses.length === 0) return 'simple';

        const complexityScores = { simple: 1, moderate: 2, complex: 3 };
        const avgScore = fileAnalyses.reduce((sum, file) =>
            sum + complexityScores[file.complexity], 0) / fileAnalyses.length;

        if (avgScore <= 1.2) return 'simple';
        if (avgScore <= 1.8) return 'moderate';
        if (avgScore <= 2.5) return 'complex';
        return 'enterprise';
    }

    /**
     * Validates and normalizes AI analysis response
     */
    private validateAndNormalizeAnalysis(analysis: any): AIIntentAnalysis {
        let taskComplexity = analysis.taskComplexity || 'simple';
        let recommendedSteps = Math.max(0, Math.min(15, analysis.recommendedSteps || 2));
        let planningStrategy = analysis.planningStrategy || 'simple_planning';

        // Cap recommended steps to prevent over-planning
        if (taskComplexity === 'moderate' && recommendedSteps > 4) {
            console.log(`[AI Intent Analyzer] Capping moderate complexity steps from ${recommendedSteps} to 4`);
            recommendedSteps = 4;
        } else if (taskComplexity === 'simple' && recommendedSteps > 3) {
            console.log(`[AI Intent Analyzer] Capping simple complexity steps from ${recommendedSteps} to 3`);
            recommendedSteps = 3;
        }

        return {
            taskComplexity: taskComplexity as any,
            changeScope: analysis.changeScope || 'single_file',
            changeType: analysis.changeType || 'refactoring',
            riskLevel: analysis.riskLevel || 'low',
            estimatedEffortHours: Math.max(1, analysis.estimatedEffortHours || 4),
            recommendedSteps,
            planningStrategy: planningStrategy as any,
            confidence: Math.max(0.1, Math.min(1.0, analysis.confidence || 0.7)),
            reasoning: analysis.reasoning || 'Standard analysis applied',
            keyFactors: Array.isArray(analysis.keyFactors) ? analysis.keyFactors : ['Analysis factors'],
            prerequisites: Array.isArray(analysis.prerequisites) ? analysis.prerequisites : [],
            potentialChallenges: Array.isArray(analysis.potentialChallenges) ? analysis.potentialChallenges : [],
            suggestedApproach: analysis.suggestedApproach || 'Standard approach recommended'
        };
    }

    /**
     * Backward compatibility check - determines if we should use legacy planning
     */
    shouldUseLegacyPlanning(analysis: AIIntentAnalysis): boolean {
        // Use legacy planning for very complex scenarios that might need the old approach
        return analysis.taskComplexity === 'enterprise' &&
               analysis.changeScope === 'architectural' &&
               analysis.recommendedSteps > 10;
    }

    /**
     * Gets planning configuration based on AI analysis
     */
    getPlanningConfiguration(analysis: AIIntentAnalysis): {
        useMultiStep: boolean;
        maxSteps: number;
        batchSize: number;
        requiresValidation: boolean;
        useLegacyFallback: boolean;
    } {
        const useLegacyFallback = this.shouldUseLegacyPlanning(analysis);

        return {
            useMultiStep: analysis.recommendedSteps > 0,
            maxSteps: analysis.recommendedSteps,
            batchSize: this.calculateOptimalBatchSize(analysis),
            requiresValidation: analysis.riskLevel === 'high' || analysis.riskLevel === 'critical',
            useLegacyFallback
        };
    }

    /**
     * Calculates optimal batch size for task generation
     */
    private calculateOptimalBatchSize(analysis: AIIntentAnalysis): number {
        switch (analysis.planningStrategy) {
            case 'direct_execution': return 1;
            case 'simple_planning': return 2;
            case 'structured_planning': return 3;
            case 'comprehensive_planning': return 4;
            case 'enterprise_planning': return 5;
            default: return 3;
        }
    }
}