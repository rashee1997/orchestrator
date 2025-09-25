import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { GeminiIntegrationService } from '../database/services/GeminiIntegrationService.js';
import { CodeReviewStorage } from '../database/services/code_review/index.js';

const codeReviewHistorySchema = z.object({
  agent_id: z.string().optional().describe('Agent ID to filter reviews (default: "cline")'),
  repository_path: z.string().optional().describe('Filter reviews by repository path'),
  review_id: z.string().optional().describe('Retrieve specific review by ID'),
  limit: z.number().optional().describe('Maximum number of reviews to return (default: 10)'),
  format: z.enum(['summary', 'full', 'markdown']).optional().describe('Output format: summary (default), full, or markdown')
});

export const codeReviewHistoryTool: Tool = {
  name: 'code_review_history',
  description: '📚 Retrieve stored AI code review results - get history, specific reviews, or formatted reports',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: {
        type: 'string',
        description: 'Agent ID to filter reviews (default: "cline")',
        default: 'cline'
      },
      repository_path: {
        type: 'string',
        description: 'Filter reviews by repository path (optional)'
      },
      review_id: {
        type: 'string',
        description: 'Retrieve specific review by ID (optional)'
      },
      limit: {
        type: 'number',
        description: 'Maximum number of reviews to return (default: 10)',
        default: 10
      },
      format: {
        type: 'string',
        enum: ['summary', 'full', 'markdown'],
        description: 'Output format: summary (default), full, or markdown',
        default: 'summary'
      }
    }
  }
};

export async function handleCodeReviewHistory(
  args: z.infer<typeof codeReviewHistorySchema>,
  geminiService: GeminiIntegrationService
): Promise<string> {
  try {
    const {
      agent_id = 'cline',
      repository_path,
      review_id,
      limit = 10,
      format = 'summary'
    } = args;

    // Initialize storage service
    const geminiDbUtils = geminiService.getGeminiDbUtils();
    const storageService = new CodeReviewStorage(geminiDbUtils);

    // Handle specific review retrieval
    if (review_id) {
      if (format === 'markdown') {
        const markdown = await storageService.getReviewAsMarkdown(review_id);
        return markdown;
      } else {
        const reviewData = await storageService.getReviewData(review_id);
        if (!reviewData) {
          return `❌ **Review Not Found**\n\nNo review found with ID: \`${review_id}\``;
        }

        if (format === 'full') {
          return `# 🛡️ Code Review Details\n\n${JSON.stringify(reviewData, null, 2)}`;
        } else {
          return formatReviewSummary(reviewData);
        }
      }
    }

    // Get review history
    const history = await storageService.getReviewHistory(agent_id, repository_path, limit);

    if (history.length === 0) {
      const filters = [];
      if (repository_path) filters.push(`repository: ${repository_path}`);
      filters.push(`agent: ${agent_id}`);

      return `📋 **No Code Reviews Found**\n\nNo reviews found with filters: ${filters.join(', ')}`;
    }

    // Format history response
    let response = `# 📚 Code Review History\n\n`;
    response += `**Agent:** \`${agent_id}\`\n`;
    if (repository_path) {
      response += `**Repository:** \`${repository_path}\`\n`;
    }
    response += `**Found:** ${history.length} review(s)\n\n`;

    response += `| Review ID | Repository | Status | Risk | Issues | Reviewed |\n`;
    response += `|-----------|------------|--------|------|--------|----------|\n`;

    for (const review of history) {
      const repo = review.repository_path.split('/').pop() || 'Unknown';
      const totalIssues = (review.high_issues_count || 0) +
                         (review.medium_issues_count || 0) +
                         (review.low_issues_count || 0);
      const riskDisplay = review.risk_score ? `${review.risk_score}/10` : 'N/A';
      const statusEmoji = getStatusEmoji(review.overall_status);
      const reviewDate = new Date(review.review_timestamp_iso).toLocaleDateString();

      response += `| \`${review.review_id.substring(0, 8)}...\` | ${repo} | ${statusEmoji} ${review.overall_status} | ${riskDisplay} | ${totalIssues} | ${reviewDate} |\n`;
    }

    response += `\n💡 **Tip:** Use \`review_id\` parameter with \`format: "markdown"\` to get detailed formatted reports.\n`;

    return response;

  } catch (error) {
    console.error('Code review history error:', error);
    return `❌ **Code Review History Failed**

An error occurred while retrieving code review history:
\`\`\`
${error instanceof Error ? error.message : String(error)}
\`\`\`

Please check:
- Database connectivity
- Review ID validity (if provided)
- Agent and repository parameters
`;
  }
}

function formatReviewSummary(reviewData: any): string {
  const repo = reviewData.repository_path.split('/').pop() || 'Unknown';
  const timestamp = new Date(reviewData.review_timestamp_iso).toLocaleString();
  const totalIssues = (reviewData.high_issues_count || 0) +
                     (reviewData.medium_issues_count || 0) +
                     (reviewData.low_issues_count || 0);

  let summary = `# 🛡️ Code Review Summary\n\n`;
  summary += `**Review ID:** \`${reviewData.review_id}\`\n`;
  summary += `**Repository:** ${repo}\n`;
  summary += `**Agent:** \`${reviewData.agent_id}\`\n`;
  summary += `**Refs:** \`${reviewData.base_ref}\` → \`${reviewData.head_ref}\`\n`;
  summary += `**Analyzed:** ${timestamp}\n`;
  summary += `**Model:** \`${reviewData.analysis_model || 'Unknown'}\`\n`;

  if (reviewData.risk_score !== null) {
    summary += `**Risk Score:** ${reviewData.risk_score}/10\n`;
  }

  summary += `**Status:** ${getStatusEmoji(reviewData.overall_status)} ${reviewData.overall_status.toUpperCase()}\n\n`;

  summary += `## 📊 Issue Summary\n\n`;
  summary += `- **Total Issues:** ${totalIssues}\n`;
  summary += `  - 🔴 High: ${reviewData.high_issues_count || 0}\n`;
  summary += `  - 🟡 Medium: ${reviewData.medium_issues_count || 0}\n`;
  summary += `  - 🔵 Low: ${reviewData.low_issues_count || 0}\n`;
  summary += `- **Files Changed:** ${reviewData.total_files_changed || 0}\n\n`;

  if (reviewData.diff_context_summary) {
    summary += `## 📝 Summary\n\n${reviewData.diff_context_summary}\n\n`;
  }

  summary += `💡 **Tip:** Use \`format: "markdown"\` to get the full detailed report with findings and patches.\n`;

  return summary;
}

function getStatusEmoji(status: string): string {
  switch (status?.toLowerCase()) {
    case 'pass': return '✅';
    case 'block': return '🚫';
    case 'pass_with_fixes': return '⚠️';
    default: return '❓';
  }
}
