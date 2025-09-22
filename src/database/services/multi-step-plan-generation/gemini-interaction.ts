import { GeminiIntegrationService } from '../GeminiIntegrationService.js';

export async function callGemini(
    geminiService: GeminiIntegrationService,
    systemInstruction: string,
    userQuery: string
): Promise<string> {
    try {
        console.log(`[Gemini Call] Total Prompt Length: ${systemInstruction.length + userQuery.length}`);

        const models = ['gemini-1.5-flash', 'gemini-1.5-pro'];
        let lastError: Error | null = null;

        for (const model of models) {
            try {
                const result = await geminiService.askGemini(userQuery, model, systemInstruction);
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
                
                console.log(`[Gemini Call] ✅ Succeeded with model: ${model}`);
                return content;
            } catch (modelError: any) {
                console.warn(`[Gemini Call] ⚠️ Model ${model} failed:`, modelError.message);
                lastError = modelError;
            }
        }
        if (lastError) throw lastError;
        throw new Error('All Gemini models failed to generate a response');
    } catch (err: any) {
        console.error('[Gemini Call] ❌ GeminiInteractionService failed:', err.message);
        throw new Error(`Failed to generate response: ${err.message}`);
    }
}