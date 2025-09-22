import { GeminiIntegrationService } from '../GeminiIntegrationService.js';
import { PlanGenerationProgress } from './types.js';
import { buildTestGenerationPrompt } from './prompts.js';
import { callGemini } from './gemini-interaction.js';

export class TestGenerationService {
    private geminiService: GeminiIntegrationService;

    constructor(geminiService: GeminiIntegrationService) {
        this.geminiService = geminiService;
    }

    async generateRealisticTestsForPlan(progress: PlanGenerationProgress): Promise<PlanGenerationProgress> {
        console.log(`[Realistic Test Generation] 🧪 Generating tests for ${progress.tasks.length} tasks...`);
        try {
            const implTasks = progress.tasks.filter(t => ["implementation", "refactoring", "bugfix"].includes(t.task_type));
            const testTasks = progress.tasks.filter(t => t.task_type === 'testing');
            if (testTasks.length === 0 || implTasks.length === 0) return progress;

            const updatedTasks = [...progress.tasks];
            for (const testTask of testTasks) {
                try {
                    const testCode = await this.generateTestCodeForTask(testTask, implTasks);
                    if (testCode) {
                        const taskIndex = updatedTasks.findIndex(t => t.task_number === testTask.task_number);
                        if (taskIndex >= 0) {
                            updatedTasks[taskIndex].code_content = testCode;
                            updatedTasks[taskIndex].needs_code_generation = false;
                        }
                    }
                } catch (error) {
                    console.warn(`[Test Generation] ⚠️ Failed for task ${testTask.task_number}:`, error);
                }
            }
            progress.tasks = updatedTasks;
            progress.updatedAt = new Date();
            return progress;
        } catch (error) {
            console.error('[Realistic Test Generation] ❌ Test generation failed:', error);
            return progress;
        }
    }

    private async generateTestCodeForTask(testTask: any, implementationTasks: any[]): Promise<string | null> {
        const relevantImplementations = this.findRelevantImplementationsForTest(testTask, implementationTasks);
        if (relevantImplementations.length === 0) return null;

        const prompt = buildTestGenerationPrompt(testTask, relevantImplementations);
        const response = await callGemini(this.geminiService, 'You are an expert test developer.', prompt);
        return this.extractTestCodeFromResponse(response);
    }

    private findRelevantImplementationsForTest(testTask: any, implementationTasks: any[]): any[] {
        // A simplified logic to find related implementation tasks
        return implementationTasks.filter(implTask => {
            const testTitle = testTask.title.toLowerCase();
            const implTitle = implTask.title.toLowerCase();
            return testTitle.includes(implTitle) || implTitle.includes(testTitle.replace('test for', '').trim());
        });
    }

    private extractTestCodeFromResponse(response: string): string {
        return response.replace(/```typescript\n?/g, '').replace(/```\n?/g, '').trim();
    }
}