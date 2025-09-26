import { ReviewResult, ReviewFinding, ReviewPatch } from './types.js';
import { CodeReviewContext } from './CodeReviewService.js';
import { GeminiDbUtils } from '../gemini-integration-modules/GeminiDbUtils.js';
import { parseGeminiJsonResponseSync } from '../gemini-integration-modules/GeminiResponseParsers.js';

export class CodeReviewStorage {
  constructor(private geminiDbUtils: GeminiDbUtils) {}

  /**
   * Parse AI response and extract structured review data
  */
  parseAiResponse(aiResponse: string, context?: CodeReviewContext): ReviewResult {
    const tryParseReviewResult = (rawJson: string): ReviewResult | null => {
      try {
        const parsedResult = parseGeminiJsonResponseSync(rawJson);
        if (this.isValidReviewResult(parsedResult)) {
          return parsedResult;
        }
        console.warn('[CodeReviewStorage] Parsed JSON does not match ReviewResult schema.');
      } catch (error) {
        console.warn('[CodeReviewStorage] Failed to parse JSON using Gemini parsers:', error instanceof Error ? error.message : error);
      }
      return null;
    };

    // Try to extract JSON from AI response
    const jsonMatch = aiResponse.match(/```json\s*([\s\S]*?)\s*```/);

    if (jsonMatch) {
      const parsed = tryParseReviewResult(jsonMatch[1]);
      if (parsed) {
        return parsed;
      }
    }

    // Attempt to parse the whole response as a fallback (covers responses without fences
    // or cases where the fenced block failed to repair)
    const parsedFull = tryParseReviewResult(aiResponse);
    if (parsedFull) {
      return parsedFull;
    }

    // Fallback: parse markdown-style response
    return this.parseMarkdownResponse(aiResponse, context);
  }

  /**
   * Store code review result in database
   */
  async storeReviewResult(
    agentId: string,
    context: CodeReviewContext,
    aiResponse: string,
    analysisModel: string = 'gemini-2.5-pro'
  ): Promise<string> {
    const reviewResult = this.parseAiResponse(aiResponse, context);

    return await this.geminiDbUtils.storeCodeReviewResult(
      agentId,
      context.repo_root,
      context.base_ref,
      context.head_ref,
      reviewResult,
      aiResponse,
      analysisModel,
      context.project_config,
      {
        totalAnalyzedFiles: context.file_snapshots?.length ?? reviewResult.files.length,
        totalUntrackedFiles: context.untracked_files?.length ?? 0,
      }
    );
  }

  /**
   * Retrieve stored code review as markdown
   */
  async getReviewAsMarkdown(reviewId: string): Promise<string> {
    return await this.geminiDbUtils.formatCodeReviewAsMarkdown(reviewId);
  }

  /**
   * Get code review history for an agent
   */
  async getReviewHistory(
    agentId: string,
    repositoryPath?: string,
    limit: number = 10
  ): Promise<any[]> {
    return await this.geminiDbUtils.getCodeReviewHistory(agentId, repositoryPath, limit);
  }

  /**
   * Get full review data
   */
  async getReviewData(reviewId: string): Promise<any> {
    return await this.geminiDbUtils.getCodeReviewResult(reviewId);
  }

  private isValidReviewResult(obj: any): obj is ReviewResult {
    return obj &&
           typeof obj === 'object' &&
           obj.summary &&
           Array.isArray(obj.files) &&
           Array.isArray(obj.patches) &&
           obj.meta;
  }

  private parseMarkdownResponse(response: string, context?: CodeReviewContext): ReviewResult {
    // Extract risk score
    const riskMatch = response.match(/Risk score[:\s]*(\d+)/i);
    const riskScore = riskMatch ? parseInt(riskMatch[1]) : 5;

    // Determine status based on content
    let status: 'pass' | 'block' | 'pass_with_fixes' = 'pass';
    if (response.toLowerCase().includes('block') || riskScore >= 8) {
      status = 'block';
    } else if (response.toLowerCase().includes('fix') || riskScore >= 5) {
      status = 'pass_with_fixes';
    }

    // Count issues by severity (rough parsing)
    const highMatches = response.match(/🔴|high|critical|blocker/gi) || [];
    const mediumMatches = response.match(/🟡|medium|major/gi) || [];
    const lowMatches = response.match(/🔵|low|minor|info/gi) || [];

    // Parse findings from markdown sections
    const files = this.parseMarkdownFindings(response);

    // Parse patches from diff blocks
    const patches = this.parseMarkdownPatches(response);

    const result: ReviewResult = {
      summary: {
        overall_status: status,
        high_issues: Math.min(highMatches.length, 10),
        medium_issues: Math.min(mediumMatches.length, 20),
        low_issues: Math.min(lowMatches.length, 30)
      },
      files,
      patches,
      meta: {
        base_ref: context?.base_ref || 'HEAD',
        head_ref: context?.head_ref || 'working-tree',
        analyzed_at: new Date().toISOString(),
        tools: ['ai-code-sentinel']
      }
    };

    return result;
  }

  private parseMarkdownFindings(response: string): Array<{path: string, findings: ReviewFinding[]}> {
    const files: Array<{path: string, findings: ReviewFinding[]}> = [];

    // Look for patterns like "🔴 🔐 Title" or "#### 🟡 ⚡ Performance issue"
    const findingPattern = /(?:🔴|🟡|🔵)\s*(?:🔐|🎯|⚡|🔧|🧪|⚙️|👁️|⚖️|📋)?\s*([^\n]+)/g;
    const findings = [...response.matchAll(findingPattern)];

    console.warn('[CodeReviewStorage] Fallback markdown parsing is active. All findings will be attributed to an "unknown" file path, as file context cannot be reliably determined from the markdown.');

    // Group findings by file (this is a simplified approach)
    const currentFile = { path: 'unknown', findings: [] as ReviewFinding[] };

    findings.forEach((match, index) => {
      const title = match[1].trim();
      const severity = match[0].includes('🔴') ? 'high' : match[0].includes('🟡') ? 'medium' : 'low';

      // Determine category from emoji
      let category = 'correctness';
      if (match[0].includes('🔐')) category = 'security';
      else if (match[0].includes('⚡')) category = 'performance';
      else if (match[0].includes('🔧')) category = 'maintainability';
      else if (match[0].includes('🧪')) category = 'testing';
      else if (match[0].includes('⚙️')) category = 'config';
      else if (match[0].includes('👁️')) category = 'observability';
      else if (match[0].includes('⚖️')) category = 'legal';

      const finding: ReviewFinding = {
        id: `finding-${index}`,
        severity: severity as any,
        category: category as any,
        title,
        evidence: {
          lines: 'N/A',
          snippet: '',
          hunk_header: ''
        },
        impact: `${severity} severity ${category} issue`,
        fix: 'See detailed analysis above',
        needs_verification: severity === 'high'
      };

      currentFile.findings.push(finding);
    });

    if (currentFile.findings.length > 0) {
      files.push(currentFile);
    }

    return files;
  }

  private parseMarkdownPatches(response: string): ReviewPatch[] {
    const patches: ReviewPatch[] = [];

    // Look for diff blocks in the response
    const diffPattern = /```diff\n([\s\S]*?)\n```/g;
    const diffMatches = [...response.matchAll(diffPattern)];

    diffMatches.forEach((match, index) => {
      const diffContent = match[1];

      // Try to extract file path from the diff
      const fileMatch = diffContent.match(/(?:---|\+\+\+)\s+[ab]\/(.+)/);
      const filePath = fileMatch ? fileMatch[1] : `file-${index}`;

      patches.push({
        path: filePath,
        title: `Auto-generated patch for ${filePath}`,
        unified_diff: diffContent
      });
    });

    return patches;
  }
}
