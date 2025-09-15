// src/database/services/JSONRepairAgent.ts
import { MultiModelOrchestrator } from '../../tools/rag/multi_model_orchestrator.js';
import { MemoryManager } from '../memory_manager.js';
import { GeminiIntegrationService } from './GeminiIntegrationService.js';

/**
 * JSON Repair Agent that uses multi-model orchestrator to fix malformed JSON responses
 */
export class JSONRepairAgent {
    private orchestrator: MultiModelOrchestrator;
    private maxRepairAttempts: number = 2;

    constructor(memoryManager: MemoryManager, geminiService: GeminiIntegrationService) {
        this.orchestrator = new MultiModelOrchestrator(memoryManager, geminiService);
    }

    /**
     * Attempts to repair malformed JSON using AI models
     */
    async repairJSON(
        malformedJSON: string, 
        expectedStructure?: string, 
        context?: string
    ): Promise<{ success: boolean; data: any; attempts: number; model: string }> {
        
        console.log('[JSON Repair Agent] Attempting to repair malformed JSON...');
        
        // Single attempt using the multi-model orchestrator with automatic fallback
        try {
            const prompt = this.buildRepairPrompt(malformedJSON, expectedStructure, context, 1);
            
            // Use json_extraction task type which prefers Mistral, falls back to Gemini
            // The orchestrator will automatically try all available models
            const result = await this.orchestrator.executeTask(
                'json_extraction',
                prompt,
                this.getSystemInstruction(),
                {
                    contextLength: prompt.length,
                    timeout: 15000,
                    maxRetries: 2, // Retries per model
                    tryAllModels: true // Enable trying all fallback models
                }
            );

            console.log(`[JSON Repair Agent] Repair successful using ${result.model}`);

            // Try to parse the repaired JSON
            const repairedJSON = this.extractJSONFromResponse(result.content);
            const parsed = JSON.parse(repairedJSON);

            console.log(`[JSON Repair Agent] ✅ Successfully repaired JSON using ${result.model}`);
            return {
                success: true,
                data: parsed,
                attempts: 1,
                model: result.model
            };

        } catch (error: any) {
            console.error('[JSON Repair Agent] ❌ JSON repair failed on all models:', error.message);
            return {
                success: false,
                data: null,
                attempts: 1,
                model: 'none'
            };
        }
    }

    /**
     * Builds the repair prompt for the AI model
     */
    private buildRepairPrompt(
        malformedJSON: string, 
        expectedStructure: string | undefined, 
        context: string | undefined,
        attempt: number
    ): string {
        let prompt = `You are a JSON repair specialist. Your task is to fix malformed JSON and return only valid JSON.

**CRITICAL REQUIREMENTS:**
1. Return ONLY valid JSON - no explanations, no markdown, no additional text
2. Preserve all original data and meaning
3. Fix syntax errors: missing quotes, brackets, commas, escaping issues
4. Remove any non-JSON content like comments or markdown
5. **SPECIAL FOCUS**: Fix code content fields that contain markdown blocks or unescaped content:
   - Convert markdown code blocks (\`\`\`diff\n...\`\`\`) to properly escaped JSON strings
   - Escape all newlines as \\n
   - Escape all quotes as \\"
   - Escape all backslashes as \\\\
   - Remove any \`\`\` markdown markers

**Malformed JSON to repair:**
\`\`\`
${malformedJSON}
\`\`\``;

        if (expectedStructure) {
            prompt += `\n\n**Expected structure should include these fields:**
${expectedStructure}`;
        }

        if (context) {
            prompt += `\n\n**Context for this JSON:**
${context}`;
        }

        if (attempt > 1) {
            prompt += `\n\n**This is attempt ${attempt}. Previous attempts failed. Please be extra careful with:**
- Proper quote escaping
- Matching brackets and braces
- No trailing commas
- Valid string values (no unescaped newlines)
- Code content fields with markdown blocks (the most common issue)`;
        }

        prompt += `\n\n**EXAMPLE OF CODE CONTENT REPAIR:**
BROKEN: "code_content": "\`\`\`diff\n--- a/file.ts\n+++ b/file.ts\nconst x = \"test\";\n\`\`\`"
FIXED:  "code_content": "--- a/file.ts\\n+++ b/file.ts\\nconst x = \\\"test\\\";\\n"

Remove \`\`\`, escape quotes, escape newlines!`;

        prompt += `\n\n**Return the repaired JSON now (JSON only):**`;

        return prompt;
    }

    /**
     * System instruction for JSON repair
     */
    private getSystemInstruction(): string {
        return `You are an expert JSON repair assistant. You MUST:

1. Output ONLY valid JSON - never include explanations, markdown, or extra text
2. Fix all syntax errors while preserving semantic meaning
3. Handle common issues:
   - Missing or extra quotes
   - Unescaped characters (especially in file paths)
   - Unescaped newlines in strings
   - Missing or extra commas
   - Unmatched brackets/braces
   - Invalid escape sequences

4. **CRITICAL FOR CODE CONTENT**: When you see "code_content" fields containing markdown blocks:
   - Remove all \`\`\` markers
   - Escape ALL newlines as \\n
   - Escape ALL quotes as \\"
   - Escape ALL backslashes as \\\\
   - Example: "\`\`\`diff\nconst x = \"hello\";\n\`\`\`" becomes "const x = \\\"hello\\\";\\n"

5. If the JSON is fundamentally incomplete, make reasonable assumptions to complete it
6. Always validate your output is parseable JSON before responding

RESPOND WITH VALID JSON ONLY.`;
    }

    /**
     * Extracts JSON from AI model response
     */
    private extractJSONFromResponse(response: string): string {
        // Remove markdown code blocks
        let cleaned = response.trim();
        
        // Remove markdown JSON blocks
        const markdownMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (markdownMatch) {
            cleaned = markdownMatch[1].trim();
        }

        // Find JSON boundaries
        const openBrace = cleaned.indexOf('{');
        const openBracket = cleaned.indexOf('[');
        
        if (openBrace === -1 && openBracket === -1) {
            throw new Error('No JSON structure found in response');
        }

        let startIdx: number;
        let endChar: string;

        if (openBrace !== -1 && (openBracket === -1 || openBrace < openBracket)) {
            startIdx = openBrace;
            endChar = '}';
        } else {
            startIdx = openBracket;
            endChar = ']';
        }

        // Extract JSON with proper bracket matching
        let bracketCount = 0;
        let inString = false;
        let escaped = false;
        let result = '';

        for (let i = startIdx; i < cleaned.length; i++) {
            const char = cleaned[i];
            result += char;

            if (escaped) {
                escaped = false;
                continue;
            }

            if (char === '\\') {
                escaped = true;
                continue;
            }

            if (char === '"' && !escaped) {
                inString = !inString;
                continue;
            }

            if (!inString) {
                if (char === '{' || char === '[') {
                    bracketCount++;
                } else if (char === '}' || char === ']') {
                    bracketCount--;
                    if (bracketCount === 0) {
                        break;
                    }
                }
            }
        }

        return result;
    }

    /**
     * Validates if a string is valid JSON
     */
    static isValidJSON(str: string): boolean {
        try {
            JSON.parse(str);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Quick repair attempt for common JSON issues without AI
     */
    static quickRepair(malformedJSON: string): { success: boolean; data: any } {
        try {
            let repaired = malformedJSON.trim();

            // Remove markdown code blocks
            const markdownMatch = repaired.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (markdownMatch) {
                repaired = markdownMatch[1].trim();
            }

            // Fix common issues
            repaired = repaired
                // Remove control characters
                .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
                // Fix unescaped backslashes (except valid escapes)
                .replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
                // Remove trailing commas
                .replace(/,\s*([}\]])/g, '$1')
                // Fix newlines in strings
                .replace(/\n/g, '\\n')
                .replace(/\r/g, '\\r');

            const parsed = JSON.parse(repaired);
            return { success: true, data: parsed };
        } catch {
            return { success: false, data: null };
        }
    }
}