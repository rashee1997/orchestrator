import { MultiModelOrchestrator } from '../multi_model_orchestrator.js';
import { parseGeminiJsonResponse } from '../../../database/services/gemini-integration-modules/GeminiResponseParsers.js';
import { MemoryManager } from '../../../database/memory_manager.js';
import { GeminiIntegrationService } from '../../../database/services/GeminiIntegrationService.js';
import { RetrievedCodeContext } from '../../../database/services/CodebaseContextRetrieverService.js';
import { AGENTIC_RAG_PLANNING_PROMPT, RAG_REFLECTION_PROMPT, CORRECTIVE_RAG_PROMPT } from '../enhanced_rag_prompts.js';
import { AgenticRagPlan, ReflectionResult } from '../types/iterative_rag_types.js';

export class IterativeRagPlanning {
    constructor(
        private multiModelOrchestrator: MultiModelOrchestrator,
        private memoryManager: MemoryManager,
        private geminiService: GeminiIntegrationService
    ) {}

    private _attemptInlineJsonParse(raw: string | undefined | null): unknown | null {
        if (!raw) {
            return null;
        }
        const trimmed = raw.trim();
        const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
        const candidate = (fencedMatch ? fencedMatch[1] : trimmed).trim();
        const tryParse = (value: string): unknown | null => {
            try {
                return JSON.parse(value);
            } catch {
                return null;
            }
        };
        let parsed = tryParse(candidate);
        if (parsed && typeof parsed === 'object') {
            return parsed;
        }
        const firstBrace = candidate.indexOf('{');
        const lastBrace = candidate.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            const sliceCandidate = candidate.slice(firstBrace, lastBrace + 1);
            parsed = tryParse(sliceCandidate.trim());
            if (parsed && typeof parsed === 'object') {
                return parsed;
            }
        }
        return null;
    }

    private _mapReflectionResponse(parsed: any): ReflectionResult {
        return {
            hasHallucinations: parsed?.hallucination_analysis?.detected_hallucinations?.length > 0 || false,
            missingInfo: parsed?.completeness_analysis?.missing_aspects || [],
            qualityScore: parsed?.overall_assessment?.quality_score || 0.5,
            suggestions: parsed?.improvement_recommendations?.enhancement_suggestions || [],
            corrections: parsed?.improvement_recommendations?.immediate_fixes || [],
            confidence: parsed?.overall_assessment?.overall_confidence || 0.5,
        };
    }

    async performAgenticPlanning(
        originalQuery: string,
        currentQuery: string,
        currentContext: RetrievedCodeContext[],
        iteration: number
    ): Promise<AgenticRagPlan> {
        const contextSummary = currentContext.slice(-3).map(c =>
            `- ${c.type}: ${c.entityName || 'Unknown'} (${c.sourcePath})`
        ).join('\n');
        const previousStrategy = iteration > 1 ? 'vector_search' : 'initial';
        const contextQuality = currentContext.length > 0 ? 0.7 : 0.3;
        const informationGaps = currentContext.length < 3 ? ['implementation details', 'usage examples'] : ['edge cases'];
        const planningPrompt = AGENTIC_RAG_PLANNING_PROMPT
            .replace('{originalQuery}', originalQuery)
            .replace('{currentQuery}', currentQuery)
            .replace('{currentIteration}', iteration.toString())
            .replace('{previousStrategy}', previousStrategy)
            .replace('{contextQuality}', contextQuality.toString())
            .replace('{informationGaps}', informationGaps.join(', '))
            .replace('{contextSummary}', contextSummary);
        const result = await this.multiModelOrchestrator.executeTask(
            'planning',
            planningPrompt,
            undefined,
            { contextLength: planningPrompt.length }
        );
        try {
            const parsed = await parseGeminiJsonResponse(result.content?.trim() || '{}', {
                expectedStructure: 'Agentic planning response with strategy and execution plan',
                contextDescription: 'RAG agentic planning analysis',
                memoryManager: this.memoryManager,
                geminiService: this.geminiService,
                enableAIRepair: true,
            });
            return {
                strategy: parsed.recommended_strategy?.primary_modality || 'vector_search',
                steps: parsed.execution_plan?.immediate_actions?.map((action: string, idx: number) => ({
                    action,
                    target: currentQuery,
                    priority: idx + 1,
                    reasoning: `Step ${idx + 1} of agentic plan`,
                })) || [{ action: 'search', target: currentQuery, priority: 1, reasoning: 'default action' }],
                expectedOutcome: parsed.execution_plan?.query_formulation || 'relevant context',
                fallbackStrategy: parsed.contingency_planning?.fallback_strategy || 'hybrid_search',
            };
        } catch (error) {
            console.warn('[Agentic Planning] Enhanced parsing failed, using fallback:', error);
            return {
                strategy: 'vector_search',
                steps: [{ action: 'search', target: currentQuery, priority: 3, reasoning: 'fallback plan' }],
                expectedOutcome: 'relevant context',
                fallbackStrategy: 'hybrid_search',
            };
        }
    }

    async performReflection(
        originalQuery: string,
        context: RetrievedCodeContext[],
        currentAnswer: string
    ): Promise<ReflectionResult> {
        const sourceContext = context.map(c =>
            `Source: ${c.sourcePath} | Entity: ${c.entityName || 'Unknown'} | Type: ${c.type}`
        ).join('\n');
        const searchStrategy = 'hybrid_search';
        const iterationCount = 1;
        const reflectionPrompt = RAG_REFLECTION_PROMPT
            .replace('{originalQuery}', originalQuery)
            .replace('{generatedResponse}', currentAnswer)
            .replace('{sourceContext}', sourceContext)
            .replace('{searchStrategy}', searchStrategy)
            .replace('{iterationCount}', iterationCount.toString());
        const result = await this.multiModelOrchestrator.executeTask(
            'reflection',
            reflectionPrompt,
            undefined,
            { contextLength: reflectionPrompt.length }
        );
        try {
            let parsed = await parseGeminiJsonResponse(result.content?.trim() || '{}', {
                expectedStructure: 'Reflection analysis with hallucination detection and quality assessment',
                contextDescription: 'RAG reflection and quality control analysis',
                memoryManager: this.memoryManager,
                geminiService: this.geminiService,
                enableAIRepair: true,
            });
            if (!parsed || typeof parsed !== 'object') {
                parsed = this._attemptInlineJsonParse(result.content);
            }
            // Check if parsing succeeded and return structured data
            if (parsed && typeof parsed === 'object') {
                return this._mapReflectionResponse(parsed);
            } else {
                throw new Error('Parsed result is null or not an object');
            }
        } catch (error) {
            const inlineParsed = this._attemptInlineJsonParse(result.content);
            if (inlineParsed && typeof inlineParsed === 'object') {
                console.warn('[Reflection] Using inline JSON recovery after enhanced parser failure.');
                return this._mapReflectionResponse(inlineParsed);
            }
            console.warn('[Reflection] Enhanced parsing failed, using fallback:', error);
            return {
                hasHallucinations: false,
                missingInfo: [],
                qualityScore: 0.5,
                suggestions: [],
                corrections: [],
                confidence: 0.5,
            };
        }
    }

    async performCorrectiveSearch(
        agentId: string,
        originalQuery: string,
        previousContext: RetrievedCodeContext[],
        reflectionResult: ReflectionResult,
        options: any,
        model?: string
    ): Promise<RetrievedCodeContext[]> {
        if (!reflectionResult.hasHallucinations && reflectionResult.missingInfo.length === 0) {
            return [];
        }
        const currentContext = previousContext.slice(-3).map(c =>
            `${c.sourcePath}: ${c.entityName || 'Unknown'}`
        ).join(', ');
        const correctionPrompt = CORRECTIVE_RAG_PROMPT
            .replace('{currentQuery}', originalQuery)
            .replace('{reflectionResults}', JSON.stringify(reflectionResult))
            .replace('{currentContext}', currentContext)
            .replace('{hasHallucinations}', reflectionResult.hasHallucinations.toString())
            .replace('{missingInfo}', reflectionResult.missingInfo.join(', '))
            .replace('{qualityScore}', reflectionResult.qualityScore.toString());
        try {
            const result = await this.multiModelOrchestrator.executeTask(
                'simple_analysis',
                correctionPrompt,
                undefined,
                { contextLength: correctionPrompt.length }
            );
            const parsed = JSON.parse(result.content?.trim() || '{}');
            const firstImprovedQuery = parsed.improved_queries?.[0];
            let correctedQueries: string[] = [];
            if (firstImprovedQuery && firstImprovedQuery.query) {
                correctedQueries = [firstImprovedQuery.query];
            } else {
                correctedQueries = [`${originalQuery} focusing on: ${reflectionResult.corrections.join(', ')} ${reflectionResult.missingInfo.join(', ')}`.trim()];
            }
            return [];
        } catch (error) {
            console.warn('[Corrective Search] Failed to use enhanced prompt or parse response, using fallback:', error);
            const fallbackQuery = `${originalQuery} focusing on: ${reflectionResult.corrections.join(', ')} ${reflectionResult.missingInfo.join(', ')}`.trim();
            return [];
        }
    }
}
