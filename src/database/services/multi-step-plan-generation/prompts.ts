import { analyzeFilePurpose } from './utils.js';
import { PlanGenerationProgress } from './types.js';

export function buildBatchPlanningPrompt(
    today: string,
    startDateStr: string,
    endDateStr: string,
    identifier: string,
    liveFilesContent: Map<string, string>
): string {
    const startDate = new Date(startDateStr);
    return `
You are an enhanced multi-step orchestrator specializing in intelligent batch planning, cohesive module design, and live file analysis. Your task is to analyze the refined prompt/goal and live files to create an optimized execution strategy with reliable batch creation, ZERO task overlap, and TIDY MODULE ORGANIZATION.

**ENHANCED ORCHESTRATION CAPABILITIES:**
- Intelligent live file analysis and dependency mapping
- Strategic batch sequencing with file-based dependencies
- **COHESIVE MODULE DESIGN**: Group related modules in dedicated folders
- Complete code generation planning with correct file paths
- Quality-first batch design with comprehensive validation
- Adaptive timeline planning based on code complexity analysis
- **OVERLAP PREVENTION**: Each action item appears in ONLY ONE task
- **LOGICAL GROUPING**: Related refactoring actions are consolidated into single tasks
- **SEQUENTIAL NUMBERING**: Tasks are numbered consecutively without gaps
- **TIDY ARCHITECTURE**: Extracted modules organized in logical folder structures

TODAY'S DATE: ${today}
RECOMMENDED START DATE: ${startDateStr}

**COMPREHENSIVE ANALYSIS CONTEXT:**
REFINED PROMPT/GOAL:
Using refined prompt ${identifier} for strategic planning (content analyzed separately)

**LIVE FILES ANALYSIS (${Array.from(liveFilesContent.keys()).length} files available):**
${Array.from(liveFilesContent.entries()).map(([path, content]) =>
    `FILE: ${path}\n- Size: ${content.length} chars\n- Type: ${path.split('.').pop()}\n- Purpose: ${analyzeFilePurpose(path, content.substring(0, 500))}`
).join('\n\n')}

**DYNAMIC CONTEXT-AWARENESS ANALYSIS:**

**GOAL COMPLEXITY DETECTION:**
Analyze the goal to determine appropriate plan complexity:
- **SIMPLE TASKS** (refactor, fix, standardize, improve single files): 2-3 tasks maximum
- **MODULARIZATION TASKS** (extract modules, create new files, restructure): 10-15 tasks allowed
- **COMPLEX FEATURES** (new systems, integrations, architectures): 8-12 tasks typical

**SMART KEYWORD DETECTION:**
- **Simple indicators**: "refactor", "fix", "standardize", "improve", "clean", "update"
- **Complex indicators**: "modularize", "extract", "create", "build", "implement system", "architecture"
- **File count matters**: Single file goals = simple plans, multiple files/services = complex plans

**ADAPTIVE PLANNING RULES:**
1. **Single file refactoring** → 2-3 focused tasks (analysis + implementation + optional testing)
2. **Multi-file improvements** → 4-6 tasks with coordination
3. **System restructuring** → 8-15 tasks with proper sequencing
4. **New feature development** → 6-10 tasks with testing and documentation

**ORCHESTRATION REQUIREMENTS:**
1. **DYNAMIC COMPLEXITY**: Analyze goal keywords and scope to determine appropriate task count
2. **SCOPE-AWARE PLANNING**: Single file goals get simple 2-3 task plans, complex goals get detailed plans
3. **MODULARIZATION DETECTION**: Only create new files/folders when goal explicitly requires modularization
4. Analyze live files to understand current architecture and identify enhancement opportunities
5. Plan batch sequencing based on file dependencies and logical development flow
6. Design each batch with specific file focus and code generation requirements
7. **CONDITIONAL NEW FILES**: Only include new file creation when goal scope requires it
8. Ensure each batch builds logically upon previous work
9. Plan for comprehensive code generation (NO placeholders allowed)
10. Include quality gates and validation points
11. **PREVENT OVERLAP**: Each specific action appears in ONLY ONE task
12. **CONSOLIDATE RELATED WORK**: Group related changes into single comprehensive tasks
13. **SEQUENTIAL TASK NUMBERING**: Use consecutive task numbers (1, 2, 3, 4, 5...) without gaps
14. **ADAPTIVE COMPLEXITY**: Match plan complexity to detected goal complexity

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
  "module_architecture": {
    "primary_module_folder": "src/modules/plan-generation/",
    "sub_folders": {
      "types": "src/modules/plan-generation/types/",
      "services": "src/modules/plan-generation/services/",
      "utils": "src/modules/plan-generation/utils/",
      "validators": "src/modules/plan-generation/validators/"
    },
    "module_mapping": {
      "interfaces": "src/modules/plan-generation/types/plan-interfaces.ts",
      "prompts": "src/modules/plan-generation/services/plan-prompts.ts",
      "orchestrator": "src/modules/plan-generation/services/plan-orchestrator.ts",
      "validators": "src/modules/plan-generation/validators/plan-validators.ts",
      "utilities": "src/modules/plan-generation/utils/plan-utils.ts"
    }
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
      "specificInstruction": "Design cohesive module architecture and create organized folder structure",
      "relevantFiles": ["src/database/services/MultiStepPlanGenerationService.ts"],
      "expectedTaskCount": 3,
      "buildUponTasks": ["Architecture analysis", "Performance bottleneck identification"],
      "estimatedBatchDays": 6,
      "batchStartDate": "${new Date(startDate.getTime() + 5*24*60*60*1000).toISOString().split('T')[0]}",
      "batchEndDate": "${new Date(startDate.getTime() + 10*24*60*60*1000).toISOString().split('T')[0]}",
      "taskTimingGuidelines": "Each task should be 2-3 days duration, focus on design and planning",
      "requiredNewFiles": [
        {
          "path": "src/modules/plan-generation/types/plan-interfaces.ts",
          "purpose": "Core type definitions for plan generation",
          "fileType": "module"
        },
        {
          "path": "src/modules/plan-generation/services/plan-prompts.ts",
          "purpose": "Prompt templates and constants",
          "fileType": "module"
        }
      ],
      "codeComplexity": "moderate",
      "primaryGoal": "Design and implement cohesive module folder structure",
      "qualityGates": ["Module architecture designed", "Folder structure created", "Import paths validated"],
      "dependsOnFiles": []
    },
    {
      "batchNumber": 3,
      "taskRange": "Tasks 7-9",
      "specificInstruction": "Extract and organize modules within dedicated folder structure",
      "relevantFiles": ["src/database/services/MultiStepPlanGenerationService.ts"],
      "expectedTaskCount": 3,
      "buildUponTasks": ["Design refactoring approach", "Implementation plan"],
      "estimatedBatchDays": 4,
      "batchStartDate": "${new Date(startDate.getTime() + 11*24*60*60*1000).toISOString().split('T')[0]}",
      "batchEndDate": "${endDateStr}",
      "taskTimingGuidelines": "Each task should be 1-2 days duration, focus on implementation and testing",
      "requiredNewFiles": [
        {
          "path": "src/modules/plan-generation/services/plan-orchestrator.ts",
          "purpose": "Core orchestration logic",
          "fileType": "module"
        },
        {
          "path": "src/modules/plan-generation/validators/plan-validators.ts",
          "purpose": "Input/output validation functions",
          "fileType": "module"
        }
      ],
      "codeComplexity": "complex",
      "primaryGoal": "Extract and organize all modules within cohesive folder structure",
      "qualityGates": ["All modules extracted", "Imports updated", "Compilation successful"],
      "dependsOnFiles": ["src/modules/plan-generation/types/plan-interfaces.ts"]
    }
  ]
}

**CRITICAL ORCHESTRATION REQUIREMENTS:**
- **Live File Analysis**: Analyze ALL provided live files to understand current architecture, identify enhancement opportunities, and plan strategic improvements
- **COHESIVE MODULE DESIGN**: Design a dedicated module folder structure (e.g., src/modules/plan-generation/) to keep all extracted modules organized together
- **TIDY ARCHITECTURE**: Group related modules logically within sub-folders (types/, services/, utils/, validators/)
- **Strategic Sequencing**: Design batches that build logically upon each other with clear file-based dependencies
- **Complete Code Generation**: Plan for 100% complete code generation with NO placeholders - if complete code cannot be provided, break into smaller, more specific batches
- **New File Planning**: When new files are needed, specify complete file paths within the organized module folder structure
- **Quality-First Design**: Each batch must include specific quality gates and validation criteria
- **Realistic Timeline**: Use PROVIDED current dates (Start=${startDateStr}, End=${endDateStr}) and create realistic estimates based on code complexity
- **Dependency Mapping**: Map file dependencies between batches and ensure logical development flow
- **Architecture Integration**: Ensure new code integrates properly with existing architecture patterns from live files
- **Comprehensive Validation**: Include testing, error handling, and integration verification in batch planning
- **Enhanced Batch Details**: Each batch must include:
  - Primary goal and success criteria
  - Specific files to analyze/modify from live files
  - New files to create with complete paths within module folders
  - Code complexity assessment
  - Quality gates and validation points
  - Dependency relationships with other batches
- **ZERO OVERLAP ENFORCEMENT**: Each specific action item (like "refactor string concatenation", "remove global exports", "add error handling") must appear in ONLY ONE task across the entire plan
- **CONSOLIDATED REFACTORING**: Group all related changes to the same component (like all BadClass modifications) into single comprehensive tasks
- **SEQUENTIAL TASK NUMBERING**: Tasks must be numbered consecutively (1, 2, 3, 4, 5...) without any gaps or jumps
- **PHASE ORGANIZATION**: Organize tasks into logical phases (Phase 1: Analysis & Design, Phase 2: Core Implementation, Phase 3: Documentation & Quality) with clear phase boundaries and dependencies
- **MODULE ORGANIZATION**: All extracted modules must be placed in a cohesive folder structure for easy maintenance and navigation
`;
}

export const MULTISTEP_TASK_SYSTEM_INSTRUCTION = `
You are a strategic task generation expert specializing in breaking down complex batch instructions into focused, actionable, and comprehensive tasks. Your primary goal is to generate a JSON array of tasks with NO placeholders and COMPLETE implementation details.

**CRITICAL TASK GENERATION DIRECTIVES:**
1.  **COMPLETE IMPLEMENTATION**: Each task requiring code must have a complete, production-ready \`code_content\` field. NO placeholders, comments like "// implement later", or incomplete logic. If a task is too complex, break it into smaller, fully implementable tasks.
2.  **SEQUENTIAL NUMBERING**: Assign consecutive task numbers starting from the provided base number.
3.  **ZERO OVERLAP**: Ensure each specific action is assigned to only ONE task.
4.  **LOGICAL GROUPING**: Group related changes to the same component into a single, comprehensive task.
5.  **CONTEXT-AWARE**: Leverage the provided context (previous tasks, live files, batch goals) to ensure continuity and relevance.
6.  **ADAPTIVE COMPLEXITY**: Match the detail and number of tasks to the complexity of the batch goal. Simple goals get simple tasks; complex goals get detailed, broken-down tasks.
7.  **QUALITY GATES**: Integrate the specified quality gates into the tasks as success criteria or verification methods.
8.  **NEW FILE INTEGRATION**: When new files are required, create tasks to implement their full content and integrate them with existing code (e.g., update imports).

**JSON TASK STRUCTURE REQUIREMENTS (MUST be followed precisely):**
[
  {
    "task_number": <number>,
    "title": "Clear, concise, and action-oriented title",
    "description": "Detailed explanation of what needs to be done and why it's important.",
    "purpose": "The strategic reason for this task and its contribution to the overall goal.",
    "estimated_effort_hours": <number>,
    "files_involved": ["src/path/to/file.ts"],
    "task_type": "implementation" | "refactoring" | "bugfix" | "analysis" | "testing" | "planning" | "review",
    "needs_code_generation": <boolean>,
    "code_specification": {
      "purpose_of_code": "What this code is supposed to do.",
      "implementation_details": ["Step-by-step logic", "Key algorithms", "Data structures"],
      "required_imports": [{"module": "fs", "path": "fs"}],
      "error_handling": "How errors should be handled.",
      "performance_considerations": "Any performance requirements."
    },
    "test_specification": {
      "test_files_to_create": ["src/path/to/file.test.ts"],
      "test_cases_required": ["Test case for success", "Test case for failure", "Edge case tests"],
      "mock_requirements": ["Mock 'fs' module for file system interactions"],
      "coverage_targets": "90% line and branch coverage"
    },
    "analysis_deliverables": ["Architectural Diagram", "Feasibility Report"],
    "code_content": "<COMPLETE, PRODUCTION-READY CODE>",
    "success_criteria": "Measurable conditions for task completion.",
    "verification_method": "How to verify the task is done correctly (e.g., 'Run unit tests').",
    "priority": "High" | "Medium" | "Low",
    "task_risks": ["Potential challenge or blocker"],
    "micro_steps": ["Detailed checklist of sub-actions"],
    "required_skills": ["TypeScript", "Node.js"],
    "dependencies_task_ids": [<number>]
  }
]
`;

export const MULTISTEP_TASK_USER_QUERY = `
**ORIGINAL GOAL CONTEXT:**
{originalGoal}

**CURRENT BATCH DETAILS:**
- **Batch Focus**: {batchFocus}
- **Task Range**: {taskRange}
- **Estimated Duration**: {batchDays} days ({batchStartDate} to {batchEndDate})
- **Timing Guidelines**: {timingGuidelines}
- **Expected Task Count**: {expectedTaskCount}

**CONTINUITY & DEPENDENCIES:**
- **Build Upon Previous Work**: {buildUponContext}
- **Context from Last 3 Tasks**:
{previousTasksContext}

**RELEVANT LIVE FILES & REQUIREMENTS:**
{liveFilesString}

**DETAILED TASK TIMING & QUALITY PLAN:**
{taskTimingDetails}

**INSTRUCTIONS:**
Based on all the provided context, generate a JSON array of **{expectedTaskCount}** tasks for the task range **{taskRange}**. Ensure each task is comprehensive, actionable, and adheres strictly to the system instruction format. Provide complete code for all implementation tasks.
`;


export function buildTaskConsolidationPrompt(progress: PlanGenerationProgress, liveFilesContent: Map<string, string>): string {
    const tasksJson = JSON.stringify(progress.tasks, null, 2);
    const planContext = progress.planData ? JSON.stringify(progress.planData, null, 2) : 'No plan context';
    const liveFilesSummary = Array.from(liveFilesContent.entries())
        .map(([path, content]) => `FILE: ${path}\nCONTENT PREVIEW:\n${content.substring(0, 1000)}...`)
        .join('\n\n---\n\n');

    return `
You are an expert Task Consolidation AI that analyzes generated plans, identifies issues, and produces clean, actionable consolidated plans.

**ANALYSIS OBJECTIVE:**
Analyze the provided tasks and identify:
1. **DUPLICATES**: Tasks that do the same thing (e.g., multiple "Set up Testing Framework")
2. **INCONSISTENCIES**: Code snippets that reintroduce bad practices (var, globals) after earlier tasks remove them
3. **BEHAVIOR DRIFT**: Tasks that change observable behavior when they should only refactor internals
4. **MISSING DEPENDENCIES**: Tasks that depend on others but don't declare it
5. **OVERLAPS**: Multiple tasks modifying the same component

**CRITICAL CONSOLIDATION RULES:**

**DUPLICATE MERGING:**
- Merge "Set up Testing Framework" and "Set up Vitest" → single "Set up Vitest" task
- Merge "Quality Assurance Review" duplicates → single QA review task
- Combine similar refactoring tasks into comprehensive ones

**CODE CONSISTENCY ENFORCEMENT:**
- NO reintroduction of \`var\` or global variables after Task 2 removes them
- \`fetchData\` and \`mysteryFunction\` stay in \`test_utils.js\` (NOT in test_sample.js)
- Preserve existing function signatures and return types (don't change observable behavior)
- Only refactor internals, maintain external API compatibility

**BEHAVIOR PRESERVATION:**
- \`processData\` return type/shape must remain unchanged for existing tests
- Function parameters and return values must be preserved
- Only internal implementation can be refactored

**TASK CONSOLIDATION:**
- Group related changes to same component into single comprehensive tasks
- Ensure sequential numbering (1, 2, 3, 4, 5...) with no gaps
- Remove redundant micro-steps across tasks
- Consolidate overlapping action items

**LIVE FILES CONTEXT:**
${liveFilesSummary}

**ORIGINAL PLAN CONTEXT:**
${planContext}

**TASKS TO ANALYZE AND CONSOLIDATE:**
${tasksJson}

**OUTPUT REQUIREMENTS:**
Return ONLY a JSON array of consolidated tasks with this exact structure:
[
  {
    "task_number": "number (Consecutive: 1, 2, 3, 4, 5...)",
    "title": "string (clean, specific, no duplicates)",
    "description": "string (comprehensive, no conflicts)",
    "purpose": "string",
    "estimated_effort_hours": "number",
    "files_involved": ["array of files"],
    "task_type": "implementation|refactoring|bugfix|analysis|testing|planning|review",
    "needs_code_generation": "boolean",
    "code_specification": { /* only for implementation tasks */ },
    "test_specification": { /* only for testing tasks */ },
    "analysis_deliverables": ["array" /* only for analysis tasks */],
    "code_content": "string",
    "success_criteria": "string",
    "verification_method": "string",
    "priority": "High|Medium|Low",
    "task_risks": ["array of risks"],
    "micro_steps": ["array of steps"],
    "required_skills": ["array of skills"],
    "dependencies_task_ids": ["array of task numbers"]
  }
]

**QUALITY ASSURANCE:**
- ✅ NO duplicate tasks
- ✅ NO reintroduction of bad practices
- ✅ Behavior preservation maintained
- ✅ Consecutive task numbering
- ✅ Comprehensive but non-overlapping scope
- ✅ Realistic effort estimates
- ✅ Proper dependencies declared

**FINAL OUTPUT:** Return ONLY the JSON array. No explanations, no markdown, no additional text. Start with [ and end with ].
`;
}


export function buildTestGenerationPrompt(testTask: any, relevantImplementations: any[]): string {
    const testSpec = testTask.test_specification || {};
    const testFiles = testSpec.test_files_to_create || [];
    const componentsToTest = testSpec.components_to_test || [];
    const testCasesRequired = testSpec.test_cases_required || [];
    const mockRequirements = testSpec.mock_requirements || [];
    const coverageTargets = testSpec.coverage_targets || '80% line coverage';
    const implementationContext = relevantImplementations.map(impl => `
IMPLEMENTATION TASK: ${impl.title}
DESCRIPTION: ${impl.description}
FILES: ${impl.files_involved?.join(', ') || 'None specified'}
GENERATED CODE:
\`\`\`typescript
${impl.code_content || 'No code generated yet'}
\`\`\`
`).join('\n\n---\n\n');

    return `
You are an expert test developer specializing in creating realistic, comprehensive test suites based on actual implementation code.

**TEST GENERATION REQUIREMENTS:**

**Testing Task:** ${testTask.title}
**Description:** ${testTask.description}
**Test Specification:**
- Files to create: ${testFiles.join(', ') || 'Auto-detect based on implementation'}
- Components to test: ${componentsToTest.join(', ') || 'All components in implementations'}
- Required test cases: ${testCasesRequired.join(', ') || 'Comprehensive coverage'}
- Mock requirements: ${mockRequirements.join(', ') || 'Minimal mocking'}
- Coverage target: ${coverageTargets}

**IMPLEMENTATION CODE TO TEST:**
${implementationContext}

**TEST GENERATION RULES:**

1. **Realistic Testing**: Create tests that actually test the real generated code, not hypothetical scenarios
2. **Complete Coverage**: Include unit tests, integration tests, edge cases, and error conditions
3. **Proper Mocking**: Mock external dependencies, databases, APIs, and file systems as needed
4. **Jest/Vitest Framework**: Use describe/it blocks, expect assertions, beforeEach/afterEach hooks
5. **ESM Support**: Use ES6 imports/exports, not CommonJS
6. **TypeScript Ready**: Include proper type annotations and assertions
7. **Error Testing**: Test both success and failure scenarios
8. **Performance**: Include basic performance tests if applicable

**TEST CODE STRUCTURE:**
\`\`\`typescript
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
// Import the actual implementation modules
import { functionToTest } from '../path/to/implementation';

describe('${testTask.title}', () => {
    // Setup and teardown
    beforeEach(() => {
        // Reset mocks/state
    });

    describe('Core Functionality', () => {
        it('should handle normal case', () => {
            // Test the actual generated code
        });

        it('should handle edge cases', () => {
            // Test edge cases from implementation
        });

        it('should handle error conditions', () => {
            // Test error scenarios
        });
    });

    describe('Integration Tests', () => {
        it('should integrate with other components', () => {
            // Test component interactions
        });
    });
});
\`\`\`

**OUTPUT REQUIREMENTS:**
Return ONLY the complete test code as a TypeScript string. No explanations, no markdown wrappers, no additional text. The output should be directly usable as a test file.

**QUALITY STANDARDS:**
- ✅ Tests the actual generated implementation code
- ✅ Comprehensive coverage of functionality
- ✅ Proper error handling and edge cases
- ✅ Realistic test data and scenarios
- ✅ Clean, readable test structure
- ✅ Follows testing best practices

Generate the complete test code now:
`;
}