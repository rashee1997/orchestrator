// src/database/services/CodeGenerationService.ts

import { GeminiIntegrationService } from './GeminiIntegrationService.js';
import { parseGeminiJsonResponse } from './gemini-integration-modules/GeminiResponseParsers.js';
import { MemoryManager } from '../memory_manager.js';
import { MultiModelOrchestrator } from '../../tools/rag/multi_model_orchestrator.js';

export interface CodeSpecification {
    file_path: string;
    file_type: 'new_file' | 'modify_existing' | 'interface' | 'service' | 'utility' | 'test' | 'config';
    implementation_details: string;
    required_methods: string[];
    required_imports: string[];
    error_handling_requirements: string;
    logging_requirements: string;
    testing_requirements: string;
    integration_points: string[];
    performance_considerations: string;
}

export interface TestSpecification {
    test_files_to_create: string[];
    components_to_test: string[];
    test_cases_required: string[];
    mock_requirements: string[];
    coverage_targets: string;
}

export interface TaskWithCode {
    task_number: number;
    title: string;
    description: string;
    task_type: 'implementation' | 'refactoring' | 'bugfix' | 'analysis' | 'testing' | 'planning' | 'review';
    needs_code_generation: boolean;
    code_specification?: CodeSpecification;
    test_specification?: TestSpecification;
    analysis_deliverables?: string[];
    code_content: string | null;
    [key: string]: any;
}

export class CodeGenerationService {
    private geminiService: GeminiIntegrationService;
    private memoryManager: MemoryManager;
    private multiModelOrchestrator: MultiModelOrchestrator;

    constructor(geminiService: GeminiIntegrationService, memoryManager: MemoryManager) {
        this.geminiService = geminiService;
        this.memoryManager = memoryManager;
        this.multiModelOrchestrator = new MultiModelOrchestrator(memoryManager, geminiService);
    }

    /**
     * Generate code for all tasks based on their classification and specifications
     */
    async generateCodeForTasks(
        tasks: TaskWithCode[],
        liveFiles: Map<string, string> = new Map()
    ): Promise<TaskWithCode[]> {
        console.log(`[Code Generation] Starting processing for ${tasks.length} tasks with intelligent classification`);

        const updatedTasks: TaskWithCode[] = [];

        for (let i = 0; i < tasks.length; i++) {
            const task = tasks[i];
            const processedTask = await this.processTaskByType(task, liveFiles);
            updatedTasks.push(processedTask);
        }

        console.log(`[Code Generation] ✅ Task processing completed for all tasks`);
        return updatedTasks;
    }

    /**
     * Process a task based on its type and classification
     */
    private async processTaskByType(task: TaskWithCode, liveFiles: Map<string, string>): Promise<TaskWithCode> {
        console.log(`[Code Generation] Processing task ${task.task_number}: ${task.title} (Type: ${task.task_type})`);

        try {
            switch (task.task_type) {
                case 'implementation':
                case 'refactoring':
                case 'bugfix':
                    return await this.handleImplementationTask(task, liveFiles);

                case 'testing':
                    return await this.handleTestingTask(task);

                case 'analysis':
                case 'planning':
                case 'review':
                    return await this.handleAnalysisTask(task);

                default:
                    console.log(`[Code Generation] Unknown task type: ${task.task_type}, treating as analysis task`);
                    return await this.handleAnalysisTask(task);
            }
        } catch (error) {
            console.error(`[Code Generation] ❌ Failed to process task ${task.task_number}:`, error);
            return {
                ...task,
                code_content: `// TASK_PROCESSING_FAILED: ${error}`
            };
        }
    }

    /**
     * Handle implementation, refactoring, and bugfix tasks (generate actual code)
     */
    private async handleImplementationTask(task: TaskWithCode, liveFiles: Map<string, string>): Promise<TaskWithCode> {
        if (!task.needs_code_generation || task.code_content !== 'PENDING_CODE_GENERATION' || !task.code_specification) {
            console.log(`[Code Generation] Skipping code generation for task ${task.task_number} (not needed or already processed)`);
            return task;
        }

        console.log(`[Code Generation] 🔧 Generating code for implementation task ${task.task_number}`);

        try {
            const generatedCode = await this.generateCodeForTask(task, liveFiles);
            const updatedTask = {
                ...task,
                code_content: generatedCode
            };

            console.log(`[Code Generation] ✅ Generated ${generatedCode.length} characters of code for task ${task.task_number}`);
            return updatedTask;
        } catch (error) {
            console.error(`[Code Generation] ❌ Failed to generate code for task ${task.task_number}:`, error);
            return {
                ...task,
                code_content: `// CODE_GENERATION_FAILED: ${error}`
            };
        }
    }

    /**
     * Handle testing tasks (generate test specifications, not code)
     */
    private async handleTestingTask(task: TaskWithCode): Promise<TaskWithCode> {
        console.log(`[Code Generation] 📋 Processing testing task ${task.task_number} - generating test specifications`);

        if (task.test_specification) {
            const testSummary = this.generateTestSummary(task.test_specification);
            console.log(`[Code Generation] ✅ Test specifications ready for task ${task.task_number}`);

            return {
                ...task,
                code_content: testSummary
            };
        } else {
            console.log(`[Code Generation] ⚠️ Testing task ${task.task_number} has no test specification`);
            return {
                ...task,
                code_content: `// TESTING_TASK: Specifications for ${task.title}\n// Manual testing or separate test generation tools required`
            };
        }
    }

    /**
     * Handle analysis, planning, and review tasks (generate documentation/reports)
     */
    private async handleAnalysisTask(task: TaskWithCode): Promise<TaskWithCode> {
        console.log(`[Code Generation] 📊 Processing analysis task ${task.task_number} - generating deliverables summary`);

        if (task.analysis_deliverables && task.analysis_deliverables.length > 0) {
            const analysisSummary = this.generateAnalysisSummary(task.analysis_deliverables);
            console.log(`[Code Generation] ✅ Analysis deliverables ready for task ${task.task_number}`);

            return {
                ...task,
                code_content: analysisSummary
            };
        } else {
            console.log(`[Code Generation] ⚠️ Analysis task ${task.task_number} has no specific deliverables`);
            return {
                ...task,
                code_content: `// ANALYSIS_TASK: ${task.title}\n// Manual analysis and documentation required\n// See task description for specific requirements`
            };
        }
    }

    /**
     * Generate a test summary for testing tasks
     */
    private generateTestSummary(testSpec: TestSpecification): string {
        return `// TEST_SPECIFICATIONS: Generated Test Plan

// Test Files to Create:
${testSpec.test_files_to_create.map(file => `// - ${file}`).join('\n')}

// Components to Test:
${testSpec.components_to_test.map(component => `// - ${component}`).join('\n')}

// Required Test Cases:
${testSpec.test_cases_required.map(testCase => `// - ${testCase}`).join('\n')}

// Mock Requirements:
${testSpec.mock_requirements.map(mock => `// - Mock: ${mock}`).join('\n')}

// Coverage Targets:
// ${testSpec.coverage_targets}

// IMPLEMENTATION APPROACH:
// 1. Create test files listed above
// 2. Implement test cases for each component
// 3. Set up required mocks and fixtures
// 4. Ensure coverage targets are met
// 5. Integrate with existing test suite

// NOTE: Use your preferred testing framework (Jest, Mocha, etc.) or specialized AI testing tools`;
    }

    /**
     * Generate an analysis summary for analysis tasks
     */
    private generateAnalysisSummary(deliverables: string[]): string {
        return `// ANALYSIS_TASK: Deliverables Summary

// Required Deliverables:
${deliverables.map(deliverable => `// - ${deliverable}`).join('\n')}

// IMPLEMENTATION APPROACH:
// 1. Conduct thorough analysis as specified in task description
// 2. Document findings and recommendations
// 3. Create deliverables listed above
// 4. Review and validate analysis results
// 5. Present findings to stakeholders

// NOTE: This task requires manual analysis, research, and documentation
// Use appropriate analysis tools and methodologies for your domain`;
    }

    /**
     * Generate code for a single task based on its specification
     */
    private async generateCodeForTask(
        task: TaskWithCode,
        liveFiles: Map<string, string>
    ): Promise<string> {
        const spec = task.code_specification!;

        // Build context from live files
        const liveFilesContext = Array.from(liveFiles.entries())
            .map(([path, content]) => `--- LIVE FILE: ${path} ---\n${content.substring(0, 1000)}...\n--- END ---`)
            .join('\n\n');

        // Create code generation prompt
        const systemInstruction = `You are an expert code generator specializing in creating complete, production-ready code based on detailed specifications.

Your task is to generate COMPLETE, FULLY-FUNCTIONAL, PRODUCTION-READY code based on the provided specification.

CRITICAL REQUIREMENTS:
- Generate 100% complete, working code with NO placeholders, NO TODO comments, NO skeleton code
- Include comprehensive error handling, input validation, and logging as specified
- Follow existing code patterns and architecture from the live files provided
- Include all necessary imports, exports, and type definitions
- Add comprehensive JSDoc comments for all public methods and classes
- Implement performance optimizations as specified
- Include integration points with existing code as specified

OUTPUT REQUIREMENTS:
- Output ONLY the complete code content
- Do NOT include explanations, markdown formatting, or additional text
- Start directly with the code (imports, then implementation)
- Ensure the code is syntactically correct and follows TypeScript best practices`;

        const userQuery = `Generate complete code based on this specification:

TASK: ${task.title}
DESCRIPTION: ${task.description}

DETAILED SPECIFICATION:
- File Path: ${spec.file_path}
- File Type: ${spec.file_type}
- Implementation Details: ${spec.implementation_details}
- Required Methods: ${spec.required_methods.join(', ')}
- Required Imports: ${spec.required_imports.join(', ')}
- Error Handling: ${spec.error_handling_requirements}
- Logging: ${spec.logging_requirements}
- Testing: ${spec.testing_requirements}
- Integration Points: ${Array.isArray(spec.integration_points) ? spec.integration_points.join(', ') : spec.integration_points || 'None specified'}
- Performance: ${spec.performance_considerations}

LIVE FILES FOR CONTEXT:
${liveFilesContext}

Generate the complete, production-ready code now:`;

        // Use MultiModelOrchestrator for intelligent model selection for code generation
        const response = await this.multiModelOrchestrator.executeTask(
            'code_generation',
            userQuery,
            systemInstruction,
            {
                maxRetries: 2,
                timeout: 60000, // Longer timeout for code generation
                contextLength: userQuery.length + systemInstruction.length
            }
        );

        if (!response || !response.content) {
            throw new Error('Empty response from code generation service');
        }

        // MultiModelOrchestrator returns a simple string content
        let generatedCode = response.content;

        // Clean up the generated code
        generatedCode = this.cleanupGeneratedCode(generatedCode);

        if (!generatedCode || generatedCode.trim().length === 0) {
            throw new Error('Generated code is empty after cleanup');
        }

        return generatedCode;
    }

    /**
     * Clean up generated code by removing markdown formatting and extra whitespace
     */
    private cleanupGeneratedCode(code: string): string {
        // Remove markdown code blocks
        code = code.replace(/```(?:typescript|ts|javascript|js)?\n?/g, '');
        code = code.replace(/```\n?/g, '');

        // Remove leading/trailing whitespace but preserve internal formatting
        code = code.trim();

        // Ensure proper line endings
        code = code.replace(/\r\n/g, '\n');

        return code;
    }
}