// src/database/services/ai-integration/utils/JSONRepairService.ts

import { jsonrepair } from 'jsonrepair';
import { LLMJSONParser } from 'ai-json-fixer';
import { JSONRepairAgent } from './JSONRepairAgent.js';
import { MemoryManager } from '../../../memory_manager.js';
import { AIIntegrationService } from '../AIIntegrationService.js';

/**
 * Universal JSON repair service for all AI providers
 * Extracted from GeminiResponseParsers.ts to be provider-agnostic
 */
export class JSONRepairService {
    private static instance: JSONRepairService;
    private jsonRepairAgent: JSONRepairAgent | null = null;
    private memoryManager: MemoryManager | null = null;
    private aiService: AIIntegrationService | null = null;

    private constructor() {}

    static getInstance(): JSONRepairService {
        if (!JSONRepairService.instance) {
            JSONRepairService.instance = new JSONRepairService();
        }
        return JSONRepairService.instance;
    }

    /**
     * Initialize with dependencies for AI-powered JSON repair
     */
    initialize(memoryManager: MemoryManager, aiService: AIIntegrationService) {
        this.memoryManager = memoryManager;
        this.aiService = aiService;
        if (this.memoryManager && this.aiService) {
            this.jsonRepairAgent = new JSONRepairAgent(this.memoryManager, this.aiService as any);
        }
    }

    /**
     * Quick jsonrepair-based recovery strategy
     */
    private attemptJsonRepair(jsonText: string): { success: boolean; data?: any; error?: string } {
        try {
            // Remove code block markers first
            let cleaned = jsonText
                .replace(/```/g, '')
                .trim();

            // Fix HTML entities (common in AI responses) - but avoid breaking valid JSON
            cleaned = cleaned
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&amp;/g, '&');
                // REMOVED .replace(/"/g, '"') - this was breaking valid JSON by converting straight quotes

            // Use jsonrepair to fix the JSON
            const repaired = jsonrepair(cleaned);
            const parsed = JSON.parse(repaired);

            console.log('[JSONRepairService] ✅ jsonrepair recovery successful');
            return { success: true, data: parsed };
        } catch (error: any) {
            console.warn('[JSONRepairService] jsonrepair recovery failed:', error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * AI JSON Fixer recovery strategy using ai-json-fixer library
     */
    private attemptAiJsonFixerRepair(jsonText: string): { success: boolean; data?: any; error?: string } {
        try {
            // Remove code block markers first
            let cleaned = jsonText
                .replace(/```/g, '')
                .trim();

            // Fix HTML entities (common in AI responses) - but avoid breaking valid JSON
            cleaned = cleaned
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&amp;/g, '&');
                // REMOVED .replace(/"/g, '"') - this was breaking valid JSON by converting straight quotes

            // Use ai-json-fixer to fix the JSON
            const parser = new LLMJSONParser();
            const result = parser.parse(cleaned);

            console.log('[JSONRepairService] ✅ ai-json-fixer recovery successful');
            return { success: true, data: result };
        } catch (error: any) {
            console.warn('[JSONRepairService] ai-json-fixer recovery failed:', error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Advanced manual JSON repair with regex patterns
     */
    private attemptAdvancedManualRepair(jsonText: string): { success: boolean; data?: any; error?: string } {
        try {
            let cleaned = jsonText;

            // Remove markdown code blocks
            cleaned = cleaned.replace(/```(?:json|javascript|js)?\n?/gi, '').replace(/```\n?/g, '');

            // Fix common AI response issues - but be careful not to break valid JSON
            cleaned = cleaned
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&amp;/g, '&');
                // REMOVED aggressive quote replacements that were breaking valid JSON
                // Only convert single quotes to double quotes in safe contexts

            // Fix trailing commas
            cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');

            // Fix missing quotes on keys
            cleaned = cleaned.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');

            // Fix newlines in strings
            cleaned = cleaned.replace(/("\s*[^"]*)\n([^"]*")/g, '$1\\n$2');

            // Remove control characters except newline, tab, and carriage return
            cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

            const parsed = JSON.parse(cleaned);
            console.log('[JSONRepairService] ✅ Advanced manual repair successful');
            return { success: true, data: parsed };
        } catch (error: any) {
            console.warn('[JSONRepairService] Advanced manual repair failed:', error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * AI-powered JSON repair using the JSONRepairAgent
     */
    private async attemptAiPoweredRepair(
        originalPrompt: string,
        brokenJson: string,
        agentId: string,
        maxRetries: number = 3
    ): Promise<{ success: boolean; data?: any; error?: string }> {
        if (!this.jsonRepairAgent) {
            return { success: false, error: 'JSONRepairAgent not initialized' };
        }

        try {
            console.log(`[JSONRepairService] Attempting AI-powered JSON repair (max ${maxRetries} retries)...`);

            const result = await this.jsonRepairAgent.repairJSON(
                brokenJson,
                originalPrompt,
                agentId
            );

            if (result.success && result.data) {
                console.log('[JSONRepairService] ✅ AI-powered repair successful');
                return { success: true, data: result.data };
            } else {
                console.warn('[JSONRepairService] AI-powered repair failed:', (result as any).error);
                return { success: false, error: (result as any).error || 'AI repair failed' };
            }
        } catch (error: any) {
            console.error('[JSONRepairService] AI-powered repair error:', error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Robustly extracts a JSON object/array from AI raw text responses.
     * Universal method that works with all AI providers (Gemini, Claude, Mistral, etc.)
     */
    async parseJsonFromAiResponse(
        jsonText: string,
        originalPrompt?: string,
        agentId: string = 'default',
        useAiRepair: boolean = false
    ): Promise<{ success: boolean; data?: any; error?: string }> {
        console.log('[JSONRepairService] Starting JSON parsing with multiple recovery strategies...');

        // Strategy 1: Direct JSON parsing
        try {
            const parsed = JSON.parse(jsonText);
            console.log('[JSONRepairService] ✅ Direct parsing successful');
            return { success: true, data: parsed };
        } catch (directError: any) {
            console.warn('[JSONRepairService] Direct parsing failed:', directError.message);
        }

        // Strategy 2: jsonrepair library
        const jsonRepairResult = this.attemptJsonRepair(jsonText);
        if (jsonRepairResult.success) {
            return jsonRepairResult;
        }

        // Strategy 3: AI JSON Fixer
        const aiFixerResult = this.attemptAiJsonFixerRepair(jsonText);
        if (aiFixerResult.success) {
            return aiFixerResult;
        }

        // Strategy 4: Advanced manual repair
        const manualResult = this.attemptAdvancedManualRepair(jsonText);
        if (manualResult.success) {
            return manualResult;
        }

        // Strategy 5: AI-powered repair (if enabled and available)
        if (useAiRepair && originalPrompt && this.jsonRepairAgent) {
            const aiResult = await this.attemptAiPoweredRepair(originalPrompt, jsonText, agentId);
            if (aiResult.success) {
                return aiResult;
            }
        }

        console.error('[JSONRepairService] ❌ All JSON repair strategies failed');
        return {
            success: false,
            error: 'All JSON parsing and repair strategies failed. Unable to extract valid JSON from response.'
        };
    }

    /**
     * Simple wrapper for quick JSON parsing without AI repair
     */
    parseJsonSimple(jsonText: string): { success: boolean; data?: any; error?: string } {
        // Try direct parsing first
        try {
            const parsed = JSON.parse(jsonText);
            return { success: true, data: parsed };
        } catch (error) {
            // Fall back to basic repair strategies
            const jsonRepairResult = this.attemptJsonRepair(jsonText);
            if (jsonRepairResult.success) return jsonRepairResult;

            const aiFixerResult = this.attemptAiJsonFixerRepair(jsonText);
            if (aiFixerResult.success) return aiFixerResult;

            const manualResult = this.attemptAdvancedManualRepair(jsonText);
            if (manualResult.success) return manualResult;

            return { success: false, error: 'All basic JSON repair strategies failed' };
        }
    }
}

// Export singleton instance
export const jsonRepairService = JSONRepairService.getInstance();