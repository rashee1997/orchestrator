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

            // Ensure code_content is always a string or null
            if (task.code_content !== null && task.code_content !== undefined) {
                task.code_content = this.cleanCodeSnippet(task.code_content);
            } else {
                task.code_content = null;
            }

            validatedTasks.push(task);
        }
        console.log(`[Task Validation] ✅ Validated ${validatedTasks.length} tasks`);
        return validatedTasks;
    }

    private cleanCodeSnippet(code: any): string {
        // Handle different types of code content
        if (typeof code === 'string') {
            return code.replace(/\bvar\s+/g, 'const ');
        } else if (code && typeof code === 'object') {
            // If it's an object or array, convert to string first
            return JSON.stringify(code);
        } else if (code === null || code === undefined) {
            return '';
        } else {
            // Convert any other type to string
            return String(code);
        }
    }
}