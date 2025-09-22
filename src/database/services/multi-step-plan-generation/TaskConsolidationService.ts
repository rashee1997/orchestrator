import { MemoryManager } from '../../memory_manager.js';
import { GeminiIntegrationService } from '../GeminiIntegrationService.js';
import { parseGeminiJsonResponse } from '../gemini-integration-modules/GeminiResponseParsers.js';
import { PlanGenerationProgress } from './types.js';
import { buildTaskConsolidationPrompt } from './prompts.js';
import { callGemini } from './gemini-interaction.js';

export class TaskConsolidationService {
    private geminiService: GeminiIntegrationService;
    private memoryManager: MemoryManager;

    constructor(geminiService: GeminiIntegrationService, memoryManager: MemoryManager) {
        this.geminiService = geminiService;
        this.memoryManager = memoryManager;
    }

    async runIntelligentTaskConsolidation(
        progress: PlanGenerationProgress,
        liveFiles: Array<{ path: string; content: string }> = []
    ): Promise<PlanGenerationProgress> {
        console.log(`[Intelligent Consolidation] 🧠 Analyzing ${progress.tasks.length} tasks...`);
        try {
            const liveFilesContent = new Map(liveFiles.map(f => [f.path, f.content]));
            const taskAnalysisPrompt = buildTaskConsolidationPrompt(progress, liveFilesContent);

            const consolidationResponse = await callGemini(
                this.geminiService,
                'You are an expert task consolidation AI.',
                taskAnalysisPrompt
            );

            const consolidatedTasks = await parseGeminiJsonResponse(consolidationResponse, {
                contextDescription: 'Intelligent task consolidation',
                memoryManager: this.memoryManager,
                geminiService: this.geminiService,
                enableAIRepair: true
            });

            if (!Array.isArray(consolidatedTasks)) {
                console.warn('[Intelligent Consolidation] ⚠️ AI consolidation failed, using original tasks');
                return progress;
            }

            const validatedTasks = this.validateConsolidatedTasks(consolidatedTasks);
            progress.tasks = validatedTasks;
            progress.updatedAt = new Date();
            console.log(`[Intelligent Consolidation] ✅ Consolidated into ${validatedTasks.length} optimized tasks`);
            return progress;
        } catch (error) {
            console.error('[Intelligent Consolidation] ❌ Consolidation failed:', error);
            return progress;
        }
    }

    private validateConsolidatedTasks(consolidatedTasks: any[]): any[] {
        const validatedTasks: any[] = [];
        const seenTitles = new Set<string>();

        for (let i = 0; i < consolidatedTasks.length; i++) {
            const task = consolidatedTasks[i];
            task.task_number = i + 1;
            const titleKey = task.title?.toLowerCase().trim() || '';
            if (seenTitles.has(titleKey)) continue;
            seenTitles.add(titleKey);
            if (!task.title || !task.description) continue;
            if (task.code_content) task.code_content = this.cleanCodeSnippet(task.code_content);
            validatedTasks.push(task);
        }
        console.log(`[Task Validation] ✅ Validated ${validatedTasks.length} tasks`);
        return validatedTasks;
    }

    private cleanCodeSnippet(code: string): string {
        return code.replace(/\bvar\s+/g, 'const ');
    }
}