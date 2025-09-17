// src/database/services/JSONRepairAgent.ts
import { MultiModelOrchestrator } from '../../tools/rag/multi_model_orchestrator.js';
import { MemoryManager } from '../memory_manager.js';
import { GeminiIntegrationService } from './GeminiIntegrationService.js';

interface JSONAnalysis {
    isValid: boolean;
    errorType: string[];
    severity: 'low' | 'medium' | 'high' | 'critical';
    confidence: number;
    suggestions: string[];
}

interface RepairResult {
    success: boolean;
    data: any;
    attempts: number;
    model: string;
    confidence: number;
    repairStrategy: string;
    originalErrors: string[];
    warnings?: string[];
}

/**
 * Enhanced JSON Repair Agent with progressive repair strategies and confidence scoring
 */
export class JSONRepairAgent {
    private orchestrator: MultiModelOrchestrator;
    private maxRepairAttempts: number = 3;

    constructor(memoryManager: MemoryManager, geminiService: GeminiIntegrationService) {
        this.orchestrator = new MultiModelOrchestrator(memoryManager, geminiService);
    }

    /**
     * Enhanced JSON repair with progressive strategies and validation
     */
    async repairJSON(
        malformedJSON: string,
        expectedStructure?: string,
        context?: string
    ): Promise<RepairResult> {

        console.log('[JSON Repair Agent] Starting enhanced JSON repair process...');

        // Step 1: Analyze the malformed JSON
        const analysis = this.analyzeJSON(malformedJSON);
        console.log(`[JSON Repair Agent] Analysis: severity=${analysis.severity}, errors=${analysis.errorType.join(', ')}`);

        // Step 2: Try quick repair first for simple issues
        if (analysis.severity === 'low' || analysis.severity === 'medium') {
            const quickResult = this.attemptQuickRepair(malformedJSON);
            if (quickResult.success) {
                console.log('[JSON Repair Agent] ✅ Quick repair successful');
                return {
                    success: true,
                    data: quickResult.data,
                    attempts: 1,
                    model: 'quick-repair',
                    confidence: 0.9,
                    repairStrategy: 'quick-fix',
                    originalErrors: analysis.errorType
                };
            }
        }

        // Step 3: Progressive AI repair with multiple strategies
        const strategies = this.getRepairStrategies(analysis);

        for (let attempt = 0; attempt < Math.min(strategies.length, this.maxRepairAttempts); attempt++) {
            try {
                const strategy = strategies[attempt];
                console.log(`[JSON Repair Agent] Attempt ${attempt + 1}: Using ${strategy} strategy`);

                const prompt = this.buildRepairPrompt(malformedJSON, expectedStructure, context, attempt + 1, strategy, analysis);

                const result = await this.orchestrator.executeTask(
                    'json_extraction',
                    prompt,
                    this.getSystemInstruction(strategy),
                    {
                        contextLength: prompt.length,
                        timeout: attempt === 0 ? 15000 : 25000, // More time for complex repairs
                        maxRetries: 2,
                        tryAllModels: true
                    }
                );

                // Enhanced validation of the repair
                const validationResult = this.validateRepair(result.content, malformedJSON, expectedStructure);

                if (validationResult.success && validationResult.confidence > 0.7) {
                    console.log(`[JSON Repair Agent] ✅ Repair successful using ${strategy} strategy with ${result.model}`);
                    return {
                        success: true,
                        data: validationResult.data,
                        attempts: attempt + 1,
                        model: result.model,
                        confidence: validationResult.confidence,
                        repairStrategy: strategy,
                        originalErrors: analysis.errorType,
                        warnings: validationResult.warnings
                    };
                }

            } catch (error: any) {
                console.log(`[JSON Repair Agent] Attempt ${attempt + 1} failed: ${error.message}`);
                continue;
            }
        }

        console.error('[JSON Repair Agent] ❌ All repair strategies failed');
        return {
            success: false,
            data: null,
            attempts: strategies.length,
            model: 'none',
            confidence: 0,
            repairStrategy: 'none',
            originalErrors: analysis.errorType
        };
    }

    /**
     * Analyzes JSON to determine error types and severity
     */
    private analyzeJSON(jsonString: string): JSONAnalysis {
        const errors: string[] = [];
        let severity: 'low' | 'medium' | 'high' | 'critical' = 'low';
        const suggestions: string[] = [];

        try {
            JSON.parse(jsonString);
            return {
                isValid: true,
                errorType: [],
                severity: 'low',
                confidence: 1.0,
                suggestions: []
            };
        } catch (error: any) {
            // Check for common JSON issues
            if (jsonString.includes('```')) {
                errors.push('markdown-code-blocks');
                suggestions.push('Remove markdown code block markers');
                severity = 'medium';
            }

            if (jsonString.includes('\n') && !jsonString.includes('\\n')) {
                errors.push('unescaped-newlines');
                suggestions.push('Escape newlines in string values');
                if (severity === 'low') severity = 'medium';
            }

            if ((jsonString.match(/"/g) || []).length % 2 !== 0) {
                errors.push('unmatched-quotes');
                suggestions.push('Fix quote escaping and matching');
                severity = 'high';
            }

            if (jsonString.includes(',"') && jsonString.includes(',}')) {
                errors.push('trailing-commas');
                suggestions.push('Remove trailing commas');
                severity = 'low';
            }

            const openBraces = (jsonString.match(/{/g) || []).length;
            const closeBraces = (jsonString.match(/}/g) || []).length;
            const openBrackets = (jsonString.match(/\[/g) || []).length;
            const closeBrackets = (jsonString.match(/\]/g) || []).length;

            if (openBraces !== closeBraces || openBrackets !== closeBrackets) {
                errors.push('unmatched-brackets');
                suggestions.push('Fix bracket/brace matching');
                severity = 'critical';
            }

            if (jsonString.length < 10 || !jsonString.trim().startsWith('{') && !jsonString.trim().startsWith('[')) {
                errors.push('incomplete-structure');
                suggestions.push('Complete the JSON structure');
                severity = 'critical';
            }

            return {
                isValid: false,
                errorType: errors,
                severity,
                confidence: Math.max(0.1, 1 - (errors.length * 0.2)),
                suggestions
            };
        }
    }

    /**
     * Determines repair strategies based on analysis
     */
    private getRepairStrategies(analysis: JSONAnalysis): string[] {
        const strategies: string[] = [];

        if (analysis.errorType.includes('markdown-code-blocks')) {
            strategies.push('markdown-cleanup');
        }

        if (analysis.errorType.includes('unescaped-newlines') || analysis.errorType.includes('unmatched-quotes')) {
            strategies.push('string-escaping');
        }

        if (analysis.errorType.includes('trailing-commas') || analysis.errorType.includes('unmatched-brackets')) {
            strategies.push('syntax-repair');
        }

        if (analysis.errorType.includes('incomplete-structure')) {
            strategies.push('structure-completion');
        }

        // Always add general strategy as fallback
        strategies.push('general-repair');

        return strategies;
    }

    /**
     * Enhanced repair prompt builder with strategy-specific instructions
     */
    private buildRepairPrompt(
        malformedJSON: string,
        expectedStructure: string | undefined,
        context: string | undefined,
        attempt: number,
        strategy: string,
        analysis: JSONAnalysis
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
     * Gets strategy-specific repair instructions
     */
    private getStrategyInstructions(strategy: string, analysis: JSONAnalysis): string {
        switch (strategy) {
            case 'markdown-cleanup':
                return `**MARKDOWN CLEANUP FOCUS:**
- Remove all markdown code blocks (\`\`\`json, \`\`\`diff, etc.)
- Convert code blocks to escaped JSON strings
- Remove markdown formatting but preserve content`;

            case 'string-escaping':
                return `**STRING ESCAPING FOCUS:**
- Escape all newlines as \\n
- Escape all quotes as \"
- Escape all backslashes as \\\\
- Fix unmatched quote pairs`;

            case 'syntax-repair':
                return `**SYNTAX REPAIR FOCUS:**
- Remove trailing commas before } and ]
- Match all opening/closing brackets and braces
- Fix missing commas between array/object elements
- Ensure proper JSON structure`;

            case 'structure-completion':
                return `**STRUCTURE COMPLETION FOCUS:**
- Complete incomplete JSON objects/arrays
- Add missing closing brackets/braces
- Infer and add missing required fields
- Maintain logical JSON hierarchy`;

            default:
                return `**GENERAL REPAIR FOCUS:**
- Fix all JSON syntax errors
- Escape special characters in strings
- Remove non-JSON content
- Maintain data integrity`;
        }
    }

    /**
     * Enhanced quick repair with better error detection
     */
    private attemptQuickRepair(malformedJSON: string): { success: boolean; data: any } {
        try {
            let repaired = malformedJSON.trim();

            // Remove markdown code blocks
            const markdownMatch = repaired.match(/```(?:json)?\\s*([\\s\\S]*?)\\s*```/);
            if (markdownMatch) {
                repaired = markdownMatch[1].trim();
            }

            // Enhanced cleaning
            repaired = repaired
                // Remove control characters
                .replace(/[\\u0000-\\u001F\\u007F-\\u009F]/g, '')
                // Fix unescaped backslashes (preserve valid escapes)
                .replace(/\\\\(?![\"\\\\\/bfnrtu])/g, '\\\\\\\\')
                // Remove trailing commas
                .replace(/,\\s*([}\\]])/g, '$1')
                // Fix common newline issues
                .replace(/(?<!\\\\)\\n/g, '\\\\n')
                .replace(/(?<!\\\\)\\r/g, '\\\\r')
                // Fix unescaped quotes in strings
                .replace(/"([^"]*)"([^"]*)"(?!\\s*[,}\\]])/g, '"$1\\\\"$2"');

            const parsed = JSON.parse(repaired);
            return { success: true, data: parsed };
        } catch {
            return { success: false, data: null };
        }
    }

    /**
     * Validates and scores repair results
     */
    private validateRepair(
        repairedContent: string,
        originalContent: string,
        expectedStructure?: string
    ): { success: boolean; data: any; confidence: number; warnings?: string[] } {

        const warnings: string[] = [];

        try {
            // Extract and parse JSON
            const cleanedJSON = this.extractJSONFromResponse(repairedContent);
            const parsed = JSON.parse(cleanedJSON);

            let confidence = 1.0;

            // Validate structure completeness
            if (expectedStructure) {
                const expectedFields = expectedStructure.match(/\"(\\w+)\"/g) || [];
                for (const field of expectedFields) {
                    const fieldName = field.replace(/"/g, '');
                    if (!(fieldName in parsed)) {
                        confidence -= 0.1;
                        warnings.push(`Missing expected field: ${fieldName}`);
                    }
                }
            }

            // Check for data loss (simplified heuristic)
            const originalLength = originalContent.replace(/\\s+/g, '').length;
            const repairedLength = JSON.stringify(parsed).replace(/\\s+/g, '').length;
            const lengthRatio = repairedLength / originalLength;

            if (lengthRatio < 0.5) {
                confidence -= 0.3;
                warnings.push('Significant data loss detected');
            } else if (lengthRatio < 0.8) {
                confidence -= 0.1;
                warnings.push('Moderate data loss detected');
            }

            // Check for suspicious empty values
            const jsonStr = JSON.stringify(parsed);
            const emptyValueCount = (jsonStr.match(/\"\"|(null)|(\\[\\])|(\\{\\})/g) || []).length;
            if (emptyValueCount > 3) {
                confidence -= 0.15;
                warnings.push('Many empty values detected');
            }

            // Minimum confidence threshold
            confidence = Math.max(confidence, 0.1);

            return {
                success: true,
                data: parsed,
                confidence,
                warnings: warnings.length > 0 ? warnings : undefined
            };

        } catch (error: any) {
            return {
                success: false,
                data: null,
                confidence: 0,
                warnings: [`Validation failed: ${error.message}`]
            };
        }
    }

    /**
     * System instruction for JSON repair with strategy
     */
    private getSystemInstruction(strategy?: string): string {
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
     * Strategy-specific system instructions
     */
    private getStrategySystemInstruction(strategy: string): string {
        switch (strategy) {
            case 'markdown-cleanup':
                return `4. **MARKDOWN CLEANUP PRIORITY**: Focus on removing markdown artifacts:
   - Remove all code fence markers (\`\`\`)
   - Clean up markdown formatting within strings
   - Convert code blocks to properly escaped JSON strings
   - Preserve content while removing formatting`;

            case 'string-escaping':
                return `4. **STRING ESCAPING PRIORITY**: Focus on character escaping:
   - Fix all unescaped quotes and backslashes
   - Properly escape newlines and special characters
   - Handle nested quotes correctly
   - Ensure all strings are valid JSON strings`;

            case 'syntax-repair':
                return `4. **SYNTAX REPAIR PRIORITY**: Focus on JSON structure:
   - Remove trailing commas before closing brackets/braces
   - Match all opening and closing brackets
   - Add missing commas between elements
   - Fix bracket/brace nesting issues`;

            case 'structure-completion':
                return `4. **STRUCTURE COMPLETION PRIORITY**: Focus on completing JSON:
   - Add missing closing brackets/braces
   - Complete partial objects and arrays
   - Infer missing required fields with reasonable defaults
   - Maintain logical data hierarchy`;

            default:
                return `4. **GENERAL REPAIR**: Apply comprehensive JSON repair techniques
   - Fix all syntax and structural issues
   - Handle code content and escaping problems
   - Complete incomplete structures reasonably`;
        }
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
     * Enhanced static quick repair with better error handling
     */
    static quickRepair(malformedJSON: string): { success: boolean; data: any; errors?: string[] } {
        const errors: string[] = [];

        try {
            let repaired = malformedJSON.trim();

            // Remove markdown code blocks
            const markdownMatch = repaired.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (markdownMatch) {
                repaired = markdownMatch[1].trim();
                errors.push('Removed markdown code blocks');
            }

            // Enhanced repair sequence
            repaired = repaired
                // Remove control characters
                .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
                // Fix unescaped backslashes (preserve valid escapes)
                .replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
                // Remove trailing commas
                .replace(/,\s*([}\]])/g, '$1')
                // Fix common newline issues
                .replace(/\n/g, '\\n')
                .replace(/\r/g, '\\r')
                // Remove extra whitespace
                .replace(/\s+/g, ' ')
                .trim();

            const parsed = JSON.parse(repaired);
            return {
                success: true,
                data: parsed,
                errors: errors.length > 0 ? errors : undefined
            };
        } catch (parseError: any) {
            errors.push(`Parse error: ${parseError.message}`);
            return {
                success: false,
                data: null,
                errors
            };
        }
    }

    /**
     * Advanced repair attempt with detailed error reporting
     */
    static advancedRepair(malformedJSON: string): { success: boolean; data: any; repairLog: string[] } {
        const repairLog: string[] = [];

        try {
            let repaired = malformedJSON.trim();
            repairLog.push(`Starting repair on ${repaired.length} character JSON`);

            // Step 1: Structure analysis
            const openBraces = (repaired.match(/{/g) || []).length;
            const closeBraces = (repaired.match(/}/g) || []).length;
            const openBrackets = (repaired.match(/\[/g) || []).length;
            const closeBrackets = (repaired.match(/\]/g) || []).length;

            repairLog.push(`Structure: {${openBraces}/${closeBraces}} [${openBrackets}/${closeBrackets}]`);

            // Step 2: Quote analysis
            const quotes = (repaired.match(/"/g) || []).length;
            repairLog.push(`Found ${quotes} quotes (${quotes % 2 === 0 ? 'even' : 'odd - potential issue'})`);

            // Step 3: Progressive repairs
            const originalLength = repaired.length;

            // Remove markdown
            const markdownMatch = repaired.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (markdownMatch) {
                repaired = markdownMatch[1].trim();
                repairLog.push(`Removed markdown blocks (${originalLength} -> ${repaired.length})`);
            }

            // Fix structure if needed
            if (openBraces !== closeBraces) {
                const missing = openBraces - closeBraces;
                if (missing > 0) {
                    repaired += '}'.repeat(missing);
                    repairLog.push(`Added ${missing} missing closing braces`);
                } else {
                    // Remove extra closing braces from the end
                    repaired = repaired.replace(/}+$/, '');
                    repairLog.push(`Removed ${-missing} extra closing braces`);
                }
            }

            if (openBrackets !== closeBrackets) {
                const missing = openBrackets - closeBrackets;
                if (missing > 0) {
                    repaired += ']'.repeat(missing);
                    repairLog.push(`Added ${missing} missing closing brackets`);
                }
            }

            // Apply standard fixes
            const beforeCleanup = repaired.length;
            repaired = repaired
                .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
                .replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
                .replace(/,\s*([}\]])/g, '$1')
                .replace(/\n/g, '\\n')
                .replace(/\r/g, '\\r');

            if (beforeCleanup !== repaired.length) {
                repairLog.push(`Applied standard cleanup (${beforeCleanup} -> ${repaired.length})`);
            }

            const parsed = JSON.parse(repaired);
            repairLog.push('✅ Repair successful');

            return { success: true, data: parsed, repairLog };

        } catch (error: any) {
            repairLog.push(`❌ Repair failed: ${error.message}`);
            return { success: false, data: null, repairLog };
        }
    }
}