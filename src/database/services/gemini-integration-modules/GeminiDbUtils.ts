import { randomUUID } from 'crypto';
import { DatabaseService } from '../DatabaseService.js';
import { GeminiApiClient, GeminiApiNotInitializedError } from './GeminiApiClient.js';
import { SUMMARIZE_CONVERSATION_PROMPT, SUMMARIZE_CORRECTION_LOGS_PROMPT } from './GeminiPromptTemplates.js';
import { Part } from '@google/genai'; // Import Part for askGemini return type
import { ReviewResult, ReviewFinding, ReviewPatch, ReviewSummary } from '../code_review/types.js';

export class GeminiDbUtils {
    private dbService: DatabaseService;
    private geminiApiClient: GeminiApiClient;
    private summarizationModelName: string; // Need to pass this from GeminiIntegrationService

    constructor(dbService: DatabaseService, geminiApiClient: GeminiApiClient, summarizationModelName: string) {
        this.dbService = dbService;
        this.geminiApiClient = geminiApiClient;
        this.summarizationModelName = summarizationModelName;
    }

    async storeRefinedPrompt(refinedPrompt: any): Promise<string> {
        const db = this.dbService.getDb();
        let refined_prompt_id = refinedPrompt.refined_prompt_id || randomUUID();
        const timestamp = refinedPrompt.refinement_timestamp ? new Date(refinedPrompt.refinement_timestamp).getTime() : Date.now();

        let isUnique = false;
        while (!isUnique) {
            const existing = await db.get(`SELECT refined_prompt_id FROM refined_prompts WHERE refined_prompt_id = ?`, refined_prompt_id);
            if (existing) {
                refined_prompt_id = randomUUID();
            } else {
                isUnique = true;
            }
        }
        refinedPrompt.refined_prompt_id = refined_prompt_id;

        await db.run(
            `INSERT INTO refined_prompts (
                refined_prompt_id, agent_id, original_prompt_text, refinement_engine_model,
                refinement_timestamp, overall_goal, decomposed_tasks, key_entities_identified,
                implicit_assumptions_made_by_refiner, explicit_constraints_from_prompt,
                suggested_ai_role_for_agent, suggested_reasoning_strategy_for_agent,
                desired_output_characteristics_inferred, suggested_context_analysis_for_agent,
                codebase_context_summary_by_ai, relevant_code_elements_analyzed,
                confidence_in_refinement_score, refinement_error_message, generation_metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            refinedPrompt.refined_prompt_id,
            refinedPrompt.agent_id,
            refinedPrompt.original_prompt_text,
            refinedPrompt.refinement_engine_model || null,
            timestamp,
            refinedPrompt.overall_goal || null,
            refinedPrompt.decomposed_tasks ? JSON.stringify(refinedPrompt.decomposed_tasks) : null,
            refinedPrompt.key_entities_identified ? JSON.stringify(refinedPrompt.key_entities_identified) : null,
            refinedPrompt.implicit_assumptions_made_by_refiner ? JSON.stringify(refinedPrompt.implicit_assumptions_made_by_refiner) : null,
            refinedPrompt.explicit_constraints_from_prompt ? JSON.stringify(refinedPrompt.explicit_constraints_from_prompt) : null,
            refinedPrompt.suggested_ai_role_for_agent || null,
            refinedPrompt.suggested_reasoning_strategy_for_agent || null,
            refinedPrompt.desired_output_characteristics_inferred ? JSON.stringify(refinedPrompt.desired_output_characteristics_inferred) : null,
            refinedPrompt.suggested_context_analysis_for_agent ? JSON.stringify(refinedPrompt.suggested_context_analysis_for_agent) : null,
            refinedPrompt.codebase_context_summary_by_ai || null,
            refinedPrompt.relevant_code_elements_analyzed ? JSON.stringify(refinedPrompt.relevant_code_elements_analyzed) : null,
            refinedPrompt.confidence_in_refinement_score || null,
            refinedPrompt.refinement_error_message || null,
            refinedPrompt.generation_metadata ? JSON.stringify(refinedPrompt.generation_metadata) : null // MODIFICATION: Store metadata
        );
        return refined_prompt_id;
    }

    async getRefinedPrompt(agent_id: string, refined_prompt_id: string): Promise<any | null> {
        const db = this.dbService.getDb();
        const result = await db.get(
            `SELECT * FROM refined_prompts WHERE agent_id = ? AND refined_prompt_id = ?`,
            agent_id, refined_prompt_id
        );

        if (result) {
            const fieldsToParse = [
                'decomposed_tasks', 'key_entities_identified',
                'implicit_assumptions_made_by_refiner', 'explicit_constraints_from_prompt',
                'desired_output_characteristics_inferred', 'suggested_context_analysis_for_agent',
                'relevant_code_elements_analyzed', 'generation_metadata_json' // MODIFICATION: Parse new metadata
            ];
            for (const field of fieldsToParse) {
                const jsonField = result[field];
                if (jsonField && typeof jsonField === 'string') {
                    try {
                        // MODIFICATION: Handle the new field name
                        const parsedFieldKey = field === 'generation_metadata_json' ? 'generation_metadata_parsed' : `${field}_parsed`;
                        result[parsedFieldKey] = JSON.parse(jsonField);
                    } catch (e) {
                        console.error(`Failed to parse ${field} for refined_prompt_id ${refined_prompt_id}:`, e);
                        const parsedFieldKey = field === 'generation_metadata_json' ? 'generation_metadata_parsed' : `${field}_parsed`;
                        result[parsedFieldKey] = null;
                        result[`${field}_parsing_error`] = true;
                        result[`raw_${field}`] = jsonField;
                    }
                } else {
                    const parsedFieldKey = field === 'generation_metadata_json' ? 'generation_metadata_parsed' : `${field}_parsed`;
                    result[parsedFieldKey] = jsonField === null ? null : jsonField;
                }
            }
            if (result.refinement_timestamp) {
                result.refinement_timestamp_iso = new Date(result.refinement_timestamp).toISOString();
            }
        }
        return result;
    }

    async summarizeCorrectionLogs(agent_id: string, maxLogs: number = 10): Promise<string> {
        const db = this.dbService.getDb();

        const correctionLogs = await db.all(
            `SELECT * FROM correction_logs WHERE agent_id = ? ORDER BY creation_timestamp_unix DESC LIMIT ?`,
            agent_id, maxLogs
        );

        if (!correctionLogs || correctionLogs.length === 0) {
            return 'No correction logs found to summarize.';
        }

        const textToSummarize = correctionLogs.map((log: any) => {
            let original = 'N/A';
            let corrected = 'N/A';
            try { original = log.original_value_json ? JSON.stringify(JSON.parse(log.original_value_json)) : 'N/A'; } catch { /* ignore */ }
            try { corrected = log.corrected_value_json ? JSON.stringify(JSON.parse(log.corrected_value_json)) : 'N/A'; } catch { /* ignore */ }

            return `Type: ${log.correction_type || 'N/A'}\nReason: ${log.reason || 'N/A'}\nOriginal: ${original}\nCorrected: ${corrected}\nStatus: ${log.status || 'N/A'}`;
        }).join('\n---\n');

        const prompt = SUMMARIZE_CORRECTION_LOGS_PROMPT.replace('{textToSummarize}', textToSummarize);

        try {
            const result = await this.geminiApiClient.askGemini(prompt, this.summarizationModelName);
            return result.content[0].text ?? 'Could not generate summary.';
        } catch (error: any) {
            console.error(`Error calling Gemini API for correction log summarization (agent: ${agent_id}):`, error);
            if (!(error instanceof GeminiApiNotInitializedError)) {
                return `Failed to summarize correction logs using Gemini API: ${error.message}`;
            }
            throw error;
        }
    }

    async summarizeConversation(
        agent_id: string,
        conversationMessages: string,
        modelName?: string
    ): Promise<string> {
        const modelToUse = modelName || this.summarizationModelName;

        const prompt = SUMMARIZE_CONVERSATION_PROMPT
            .replace('{agent_id}', agent_id)
            .replace('{conversationMessages}', conversationMessages);

        try {
            const result = await this.geminiApiClient.askGemini(prompt, modelToUse);
            return result.content[0].text ?? 'Conversation summary could not be generated.';
        } catch (error: any) {
            console.error(`Error summarizing conversation for agent ${agent_id}:`, error);
            throw new Error(`Failed to summarize conversation: ${error.message}`);
        }
    }

    // Code Review Database Operations

    async storeCodeReviewResult(
        agentId: string,
        repositoryPath: string,
        baseRef: string,
        headRef: string,
        reviewResult: ReviewResult,
        fullAiResponse: string,
        analysisModel: string,
        projectConfig?: any,
        options?: { totalAnalyzedFiles?: number; totalUntrackedFiles?: number }
    ): Promise<string> {
        const db = this.dbService.getDb();
        const reviewId = randomUUID();
        const timestamp = Date.now();
        const timestampIso = new Date().toISOString();

        // Extract risk score from AI response (assuming it's in the summary)
        let riskScore = null;
        if (fullAiResponse.includes('Risk score')) {
            const riskMatch = fullAiResponse.match(/Risk score[:\s]*(\d+)/i);
            if (riskMatch) {
                riskScore = parseInt(riskMatch[1]);
            }
        }

        // Store main review session
        await db.run(`
            INSERT INTO code_review_sessions (
                review_id, agent_id, repository_path, base_ref, head_ref,
                review_timestamp, review_timestamp_iso, analysis_model,
                risk_score, overall_status, total_files_changed, total_untracked_files,
                high_issues_count, medium_issues_count, low_issues_count,
                project_config_json, diff_context_summary, full_ai_response
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            reviewId, agentId, repositoryPath, baseRef, headRef,
            timestamp, timestampIso, analysisModel,
            riskScore, reviewResult.summary.overall_status,
            options?.totalAnalyzedFiles ?? reviewResult.files.length,
            options?.totalUntrackedFiles ?? 0,
            reviewResult.summary.high_issues, reviewResult.summary.medium_issues, reviewResult.summary.low_issues,
            projectConfig ? JSON.stringify(projectConfig) : null,
            `Analyzed ${reviewResult.files.length} files with ${reviewResult.summary.high_issues + reviewResult.summary.medium_issues + reviewResult.summary.low_issues} total issues`,
            fullAiResponse
        ]);

        // Store findings
        for (const file of reviewResult.files) {
            for (const finding of file.findings) {
                const findingId = randomUUID();
                await db.run(`
                    INSERT INTO code_review_findings (
                        finding_id, review_id, file_path, line_start, line_end,
                        severity, category, rule_code, title, description,
                        impact, fix_suggestion, code_snippet, hunk_header,
                        needs_verification, creation_timestamp
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    findingId, reviewId, file.path,
                    this.parseLineNumber(finding.evidence.lines, 'start'),
                    this.parseLineNumber(finding.evidence.lines, 'end'),
                    finding.severity, finding.category, finding.code || null,
                    // Map AI fields: use impact text as description when no explicit description is present
                    finding.title,
                    finding.impact,                 // description (fallback)
                    finding.impact || null,         // impact (store same text if available)
                    finding.fix,                    // fix_suggestion
                    finding.evidence.snippet, finding.evidence.hunk_header,
                    finding.needs_verification ? 1 : 0, timestamp
                ]);
            }
        }

        // Store patches
        for (const patch of reviewResult.patches) {
            const patchId = randomUUID();
            await db.run(`
                INSERT INTO code_review_patches (
                    patch_id, review_id, file_path, patch_title,
                    unified_diff, patch_description, creation_timestamp
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [
                patchId, reviewId, patch.path, patch.title,
                patch.unified_diff, `Auto-generated patch for ${patch.path}`, timestamp
            ]);
        }

        return reviewId;
    }

    async getCodeReviewResult(reviewId: string): Promise<any> {
        const db = this.dbService.getDb();

        // Get main review session
        const review = await db.get(`
            SELECT * FROM code_review_sessions WHERE review_id = ?
        `, reviewId);

        if (!review) {
            return null;
        }

        // Get findings
        const findings = await db.all(`
            SELECT * FROM code_review_findings
            WHERE review_id = ?
            ORDER BY severity DESC, file_path, line_start
        `, reviewId);

        // Get patches
        const patches = await db.all(`
            SELECT * FROM code_review_patches
            WHERE review_id = ?
            ORDER BY file_path
        `, reviewId);

        return {
            ...review,
            project_config_parsed: review.project_config_json ? JSON.parse(review.project_config_json) : null,
            findings,
            patches
        };
    }

    async getCodeReviewHistory(
        agentId: string,
        repositoryPath?: string,
        limit: number = 10
    ): Promise<any[]> {
        const db = this.dbService.getDb();

        let query = `
            SELECT review_id, repository_path, base_ref, head_ref,
                   review_timestamp_iso, overall_status, risk_score,
                   high_issues_count, medium_issues_count, low_issues_count,
                   total_files_changed
            FROM code_review_sessions
            WHERE agent_id = ?
        `;
        const params: any[] = [agentId];

        if (repositoryPath) {
            query += ' AND repository_path = ?';
            params.push(repositoryPath);
        }

        query += ' ORDER BY review_timestamp DESC LIMIT ?';
        params.push(limit);

        return await db.all(query, params);
    }

    async formatCodeReviewAsMarkdown(reviewId: string): Promise<string> {
        const reviewData = await this.getCodeReviewResult(reviewId);

        if (!reviewData) {
            return '# Code Review Not Found\n\nThe requested code review could not be found.';
        }

        const repo = reviewData.repository_path.split('/').pop() || 'Unknown';
        const timestamp = new Date(reviewData.review_timestamp_iso).toLocaleString();

        let markdown = `# 🛡️ AI Code Sentinel Review\n\n`;
        markdown += `**Repository:** ${repo}\n`;
        markdown += `**Agent:** \`${reviewData.agent_id}\`\n`;
        markdown += `**Base:** \`${reviewData.base_ref}\` → **Head:** \`${reviewData.head_ref}\`\n`;
        markdown += `**Reviewed:** ${timestamp}\n`;
        markdown += `**Status:** ${reviewData.overall_status.toUpperCase()}\n`;

        if (reviewData.risk_score !== null) {
            markdown += `**Risk Score:** ${reviewData.risk_score}/10\n`;
        }

        markdown += `\n---\n\n`;

        // Summary
        markdown += `## 📊 Summary\n\n`;
        markdown += `- **Files Changed:** ${reviewData.total_files_changed}\n`;
        markdown += `- **Issues Found:** ${reviewData.high_issues_count + reviewData.medium_issues_count + reviewData.low_issues_count}\n`;
        markdown += `  - 🔴 High: ${reviewData.high_issues_count}\n`;
        markdown += `  - 🟡 Medium: ${reviewData.medium_issues_count}\n`;
        markdown += `  - 🔵 Low: ${reviewData.low_issues_count}\n`;

        // Findings by file
        if (reviewData.findings.length > 0) {
            markdown += `\n## 🔍 Findings\n\n`;

            const findingsByFile = reviewData.findings.reduce((acc: any, finding: any) => {
                if (!acc[finding.file_path]) {
                    acc[finding.file_path] = [];
                }
                acc[finding.file_path].push(finding);
                return acc;
            }, {});

            for (const [filePath, fileFindings] of Object.entries(findingsByFile)) {
                markdown += `### 📄 \`${filePath}\`\n\n`;

                for (const finding of fileFindings as any[]) {
                    const severityEmoji = finding.severity === 'high' ? '🔴' : finding.severity === 'medium' ? '🟡' : '🔵';
                    const categoryEmoji = this.getCategoryEmoji(finding.category);

                    markdown += `#### ${severityEmoji} ${categoryEmoji} ${finding.title}\n\n`;
                    markdown += `**Lines:** ${finding.line_start || 'N/A'}${finding.line_end && finding.line_end !== finding.line_start ? `-${finding.line_end}` : ''}\n`;
                    markdown += `**Severity:** ${finding.severity} | **Category:** ${finding.category}\n`;
                    if (finding.rule_code) {
                        markdown += `**Rule:** ${finding.rule_code}\n`;
                    }
                    markdown += `\n${finding.description}\n`;

                    if (finding.code_snippet) {
                        markdown += `\n**Code:**\n\`\`\`\n${finding.code_snippet}\n\`\`\`\n`;
                    }

                    if (finding.fix_suggestion) {
                        markdown += `\n**Fix:** ${finding.fix_suggestion}\n`;
                    }

                    markdown += `\n---\n\n`;
                }
            }
        }

        // Patches
        if (reviewData.patches.length > 0) {
            markdown += `## 🛠️ Suggested Patches\n\n`;

            for (const patch of reviewData.patches) {
                markdown += `### ${patch.patch_title}\n\n`;
                markdown += `**File:** \`${patch.file_path}\`\n\n`;
                markdown += `\`\`\`diff\n${patch.unified_diff}\n\`\`\`\n\n`;
            }
        }

        return markdown;
    }

    private parseLineNumber(lines: string, type: 'start' | 'end'): number | null {
        if (!lines) return null;
        const match = lines.match(/(\d+)(?:-(\d+))?/);
        if (!match) return null;
        return type === 'start' ? parseInt(match[1]) : parseInt(match[2] || match[1]);
    }

    private getCategoryEmoji(category: string): string {
        const emojiMap: Record<string, string> = {
            'security': '🔐',
            'correctness': '🎯',
            'performance': '⚡',
            'maintainability': '🔧',
            'testing': '🧪',
            'config': '⚙️',
            'observability': '👁️',
            'legal': '⚖️'
        };
        return emojiMap[category] || '📋';
    }
}
