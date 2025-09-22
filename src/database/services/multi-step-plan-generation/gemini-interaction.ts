import { GeminiIntegrationService } from '../GeminiIntegrationService.js';

export async function callGemini(
    geminiService: GeminiIntegrationService,
    systemInstruction: string,
    userQuery: string,
    taskType: string = 'intent_analysis'
): Promise<string> {
    try {
        console.log(`[Gemini Call] Total Prompt Length: ${systemInstruction.length + userQuery.length}`);

        // For intent analysis, try to use MultiModelOrchestrator with the specific task type
        if (taskType === 'intent_analysis') {
            try {
                const { MultiModelOrchestrator } = await import('../../../tools/rag/multi_model_orchestrator.js');
                const orchestrator = await MultiModelOrchestrator.create();

                const result = await orchestrator.executeTask(
                    'intent_analysis' as any,
                    userQuery,
                    systemInstruction,
                    {
                        maxRetries: 2,
                        contextLength: userQuery.length + systemInstruction.length
                    }
                );

                console.log(`[Gemini Call] ✅ Succeeded with model: ${result.model}`);
                return result.content;
            } catch (orchestratorError) {
                console.warn(`[Gemini Call] MultiModelOrchestrator failed, falling back to direct service:`, orchestratorError);
            }
        }

        // Fallback to direct GeminiIntegrationService
        const result = await geminiService.askGemini(userQuery, undefined, systemInstruction);
        if (!result) throw new Error('GeminiIntegrationService returned undefined result');

        let content: string;
        if (result.content && Array.isArray(result.content) && result.content.length > 0) {
            const firstPart = result.content[0];
            if (firstPart && typeof firstPart === 'object' && 'text' in firstPart) {
                content = (firstPart as any).text;
            } else if (typeof firstPart === 'string') {
                content = firstPart;
            } else {
                throw new Error('Unexpected content part format');
            }
        } else if (typeof result === 'string') {
            content = result;
        } else {
            throw new Error('No content in result');
        }

        if (!content || content.trim().length === 0) throw new Error('Returned empty content');

        console.log(`[Gemini Call] ✅ Succeeded with model: ${geminiService.defaultAskModelName}`);
        return content;
    } catch (err: any) {
        console.error('[Gemini Call] ❌ GeminiInteractionService failed:', err.message);
        throw new Error(`Failed to generate response: ${err.message}`);
    }
}