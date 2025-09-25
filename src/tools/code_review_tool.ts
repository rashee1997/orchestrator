import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { GitService } from '../utils/GitService.js';
import { GeminiIntegrationService } from '../database/services/GeminiIntegrationService.js';
import { CodeReviewService, CodeReviewStorage, CodeReviewOptions } from '../database/services/code_review/index.js';
import { MultiModelOrchestrator } from './rag/multi_model_orchestrator.js';

const codeReviewSchema = z.object({
  working_directory: z.string().optional().describe('Absolute path to the git repository. If not provided, searches for git repo starting from current directory.'),
  agent_id: z.string().optional().describe('Agent ID for context (default: "cline")'),
  base_ref: z.string().optional().describe('Base reference for comparison (optional - when not provided, analyzes current uncommitted changes)'),
  head_ref: z.string().optional().describe('Head reference for comparison (optional - when not provided, analyzes current uncommitted changes)'),
  include_staged: z.boolean().optional().describe('Include staged changes in review (default: true for uncommitted changes analysis)'),
  include_untracked: z.boolean().optional().describe('Include untracked files in review (default: true for uncommitted changes, false for ref comparisons)'),
  enterprise: z.boolean().optional().describe('Enable enterprise multi-engine analysis with comprehensive security, performance, maintainability, and reliability checks (default: false)'),
  project_config: z.object({
    language_primary: z.string().optional(),
    build_tooling: z.array(z.string()).optional(),
    pkg_managers: z.array(z.string()).optional(),
    linters_formatters: z.array(z.string()).optional(),
    test_frameworks: z.array(z.string()).optional(),
    frameworks: z.array(z.string()).optional(),
    runtime_targets: z.array(z.string()).optional(),
    org_policies: z.object({
      license_header_required: z.boolean().optional(),
      commit_msg_convention: z.string().optional(),
      security_baseline: z.string().optional(),
      style_guide: z.string().optional()
    }).optional()
  }).optional()
});

export const codeReviewTool: Tool = {
  name: 'ai_code_sentinel',
  description: '🛡️ AI-powered comprehensive code review - by default analyzes current uncommitted changes (staged + unstaged + untracked files). Can also compare specific refs when provided. Use enterprise=true for multi-engine analysis.',
  inputSchema: {
    type: 'object',
    properties: {
      working_directory: {
        type: 'string',
        description: 'Absolute path to the git repository. If not provided, searches for git repo starting from current directory.'
      },
      agent_id: {
        type: 'string',
        description: 'Agent ID for context (default: "cline")',
        default: 'cline'
      },
      base_ref: {
        type: 'string',
        description: 'Base reference for comparison (optional - when not provided, analyzes current uncommitted changes)'
      },
      head_ref: {
        type: 'string',
        description: 'Head reference for comparison (optional - when not provided, analyzes current uncommitted changes)'
      },
      include_staged: {
        type: 'boolean',
        description: 'Include staged changes in review (default: true for uncommitted changes analysis)'
      },
      include_untracked: {
        type: 'boolean',
        description: 'Include untracked files in the review (default: true for uncommitted changes, false for ref comparisons)'
      },
      enterprise: {
        type: 'boolean',
        description: 'Enable enterprise multi-engine analysis with comprehensive security, performance, maintainability, and reliability checks (default: false)',
        default: false
      },
      project_config: {
        type: 'object',
        description: 'Project configuration for context-aware analysis',
        properties: {
          language_primary: {
            type: 'string',
            description: 'Primary programming language'
          },
          build_tooling: {
            type: 'array',
            items: { type: 'string' },
            description: 'Build tools used in the project'
          },
          pkg_managers: {
            type: 'array',
            items: { type: 'string' },
            description: 'Package managers used'
          },
          linters_formatters: {
            type: 'array',
            items: { type: 'string' },
            description: 'Linters and formatters configured'
          },
          test_frameworks: {
            type: 'array',
            items: { type: 'string' },
            description: 'Testing frameworks used'
          },
          frameworks: {
            type: 'array',
            items: { type: 'string' },
            description: 'Application frameworks used'
          },
          runtime_targets: {
            type: 'array',
            items: { type: 'string' },
            description: 'Runtime versions targeted'
          },
          org_policies: {
            type: 'object',
            properties: {
              license_header_required: {
                type: 'boolean',
                description: 'Whether license headers are required'
              },
              commit_msg_convention: {
                type: 'string',
                description: 'Commit message convention used'
              },
              security_baseline: {
                type: 'string',
                description: 'Security baseline standard'
              },
              style_guide: {
                type: 'string',
                description: 'Code style guide followed'
              }
            }
          }
        }
      }
    }
  }
};

export async function handleCodeReview(
  args: z.infer<typeof codeReviewSchema>,
  gitService: GitService,
  geminiService: GeminiIntegrationService
): Promise<string> {
  try {
    const { working_directory, agent_id = 'cline' } = args;

    // Use proper GitService initialization like other tools
    const actualGitService = working_directory ? new GitService(working_directory) : gitService;
    const codeReviewService = new CodeReviewService(actualGitService);

    // Initialize storage service
    const geminiDbUtils = geminiService.getGeminiDbUtils();
    const storageService = new CodeReviewStorage(geminiDbUtils);

    // Initialize multi-model orchestrator
    const orchestrator = await MultiModelOrchestrator.create(undefined, geminiService);

    const options: CodeReviewOptions = {
      baseRef: args.base_ref,
      headRef: args.head_ref,
      includeStagedChanges: args.include_staged,
      includeUntrackedFiles: args.include_untracked,
      projectConfig: args.project_config,
      enterprise: args.enterprise || false
    };

    // Prepare review context
    const context = await codeReviewService.prepareReviewContext(options);

    // Check if there are any changes to review
    if (!context.diff_unified.trim() && context.untracked_files.length === 0) {
      return `📋 **Code Review Result**

**Repository:** ${context.repo_root.split('/').pop() || 'Unknown'}
**Agent:** \`${agent_id}\`

ℹ️ No changes detected to review. The working directory appears to be clean with no diffs or untracked files.`;
    }

    // Run analysis with the selected mode (basic vs enterprise)
    const { analysis, modelUsed, mode } = await codeReviewService.analyzeWithMode(
      context,
      options,
      orchestrator
    );

    // Store the review result in the database
    let reviewId: string | null = null;
    try {
      reviewId = await storageService.storeReviewResult(
        agent_id,
        context,
        analysis,
        mode // Store mode ("basic" | "enterprise") in analysis_model
      );
    } catch (error) {
      console.warn('Failed to store review result in database:', error);
    }

    // Add header with context information
    const header = `# 🛡️ AI Code Sentinel Review

**Repository:** ${context.repo_root.split('/').pop() || 'Unknown'}
**Agent:** \`${agent_id}\`
**Base:** \`${context.base_ref}\` → **Head:** \`${context.head_ref}\`
**Files Changed:** ${context.file_snapshots.length} | **Untracked:** ${context.untracked_files.length}
**Model Used:** \`${modelUsed}\` | **Mode:** ${mode === 'enterprise' ? '🏢 Enterprise Multi-Engine' : '⚡ Basic AI Analysis'}
**Analyzed:** ${new Date().toISOString()}
${reviewId ? `**Review ID:** \`${reviewId}\`` : ''}

---

`;

    return header + analysis;

  } catch (error) {
    console.error('Code review error:', error);
    return `❌ **Code Review Failed**

An error occurred during the code review process:
\`\`\`
${error instanceof Error ? error.message : String(error)}
\`\`\`

Please check:
- Git repository status
- File permissions
- Network connectivity for AI analysis
`;
  }
}
