import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { MemoryManager } from '../database/memory_manager.js';
import {
    GitService,
    GitContext,
    GitChange,
    GitCommitSummary
} from '../utils/GitService.js';
import { CommitMessageAI, CommitMessageOptions } from '../utils/CommitMessageAI.js';
import { InternalToolDefinition } from './index.js';
import * as path from 'path';

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

/** Simple label for a context block – used only for UI rendering */
type ContextLabel = 'Staged' | 'Unstaged';

/** Internal representation of a context section returned by `collectContextSections` */
interface ContextSection {
    label: ContextLabel;
    context: GitContext;
}

/** Result of bucketising changes across all sections */
interface ChangeBuckets {
    staged: GitChange[];
    unstaged: GitChange[];
}

/** Helper: deduplicate changes across sections and bucket them */
function bucketChanges(sections: ContextSection[]): ChangeBuckets {
    const deduped = new Map<string, GitChange>();

    for (const { context } of sections) {
        for (const change of context.changes) {
            const key = `${change.changeType}:${change.filePath}`;
            if (!deduped.has(key)) {
                deduped.set(key, change);
            }
        }
    }

    const all = Array.from(deduped.values());
    return {
        staged: all.filter(c => c.changeType === 'staged'),
        unstaged: all.filter(c => c.changeType === 'unstaged')
    };
}

/** Collect staged/unstaged contexts with sane labeling */
async function collectContextSections(
    gitService: GitService,
    includeStaged: boolean,
    includeUnstaged: boolean
): Promise<ContextSection[]> {
    const sections: ContextSection[] = [];

    if (includeStaged) {
        const staged = await gitService.getCommitContext(true);
        if (staged.changes.length) {
            sections.push({ label: 'Staged', context: staged });
        }
    }

    if (includeUnstaged) {
        const unstaged = await gitService.getCommitContext(false);
        if (unstaged.changes.length) {
            // Avoid duplicate “Unstaged” block when staged already contains unstaged changes
            const already = sections.some(s => s.label === 'Unstaged');
            if (!already) sections.push({ label: 'Unstaged', context: unstaged });
        }
    }

    return sections;
}

/** Build a combined AI‑ready context string. Handles duplicate headers and optional diff‑size limiting. */
function buildCombinedContextForAI(
    gitService: GitService,
    sections: ContextSection[],
    maxDiffSize: number = 200_000 // 200 KB – safe for most LLM prompts
): string {
    const header = '## Git Context for Commit Message Generation';

    const parts = sections.map(section => {
        const formatted = gitService.formatContextForAI(section.context);

        // Replace the generic header with a specific one when multiple sections exist
        if (sections.length > 1 && formatted.includes(header)) {
            return formatted.replace(header, `## ${section.label} Changes`);
        }
        return formatted;
    });

    const combined = parts.join('\n\n');

    // Truncate extremely large diffs – keep the beginning & end for context
    if (combined.length > maxDiffSize) {
        const start = combined.slice(0, maxDiffSize / 2);
        const end = combined.slice(-maxDiffSize / 2);
        return `${start}\n... [TRUNCATED DUE TO SIZE] ...\n${end}`;
    }
    return combined;
}

function buildChangedFilesSection(sections: ContextSection[]): string {
    const { staged, unstaged } = bucketChanges(sections);

    if (staged.length === 0 && unstaged.length === 0) {
        return '';
    }

    const workingDirectory = sections[0]?.context.workingDirectory ?? process.cwd();
    let sectionText = '## 📝 Changed Files\n\n';

    if (staged.length > 0) {
        sectionText += '**Staged**\n';
        for (const change of staged) {
            const fileName = path.basename(change.filePath);
            const relativePath = path.relative(workingDirectory, change.filePath);
            sectionText += `- **${change.status}:** \`${fileName}\` (\`${relativePath}\`)\n`;
        }
        sectionText += '\n';
    }

    if (unstaged.length > 0) {
        sectionText += '**Unstaged**\n';
        for (const change of unstaged) {
            const fileName = path.basename(change.filePath);
            const relativePath = path.relative(workingDirectory, change.filePath);
            sectionText += `- **${change.status}:** \`${fileName}\` (\`${relativePath}\`)\n`;
        }
        sectionText += '\n';
    }

    return sectionText;
}

function parseFileArguments(files?: string | string[]): string[] {
    if (!files) {
        return [];
    }

    const values = Array.isArray(files)
        ? files
        : files.split(/\r?\n|,/);

    return values
        .map(value => value.trim())
        .filter(value => value.length > 0);
}

export const gitCommitToolDefinitions: InternalToolDefinition[] = [
    {
        name: 'generate_commit_message',
        description: 'Analyze repository changes and generate AI-powered commit messages. Supports staged-only analysis by default, or combined staged and unstaged changes when requested.',
        inputSchema: {
            type: 'object',
            properties: {
                working_directory: {
                    type: 'string',
                    description: 'Absolute path to the git repository. If not provided, searches for git repo starting from current directory.'
                },
                staged: {
                    type: 'boolean',
                    description: 'When true (default) analyze staged changes with fallback to unstaged if none are staged. When false, analyze both staged and unstaged changes together.'
                },
                conventional_commits: {
                    type: 'boolean',
                    description: 'Use Conventional Commits format (default: true)'
                },
                max_length: {
                    type: 'number',
                    description: 'Maximum length of commit message (default: 1500)'
                },
                custom_instructions: {
                    type: 'string',
                    description: 'Additional custom instructions for commit message generation'
                },
                different_from_previous: {
                    type: 'string',
                    description: 'Previous commit message to generate a different alternative from'
                },
                verbose: {
                    type: 'boolean',
                    description: 'Generate detailed multi-line commit messages with body explanations (default: false)'
                }
            },
            additionalProperties: false
        },
        func: async (args: any, memoryManager?: MemoryManager) => {
            if (!memoryManager) {
                throw new McpError(ErrorCode.InternalError, 'MemoryManager instance is required');
            }

            const {
                working_directory,
                staged = true,
                conventional_commits = true,
                max_length = 1500,
                custom_instructions,
                different_from_previous,
                verbose = false
            } = args;

            try {
                const gitService = new GitService(working_directory);
                const geminiService = memoryManager.getGeminiIntegrationService();
                const commitAI = new CommitMessageAI(geminiService);

                if (!gitService.hasUncommittedChanges()) {
                    return {
                        content: [{
                            type: 'text',
                            text: '⚠️ **No uncommitted changes found**\n\nThere are no staged or unstaged changes in the repository to generate a commit message for.'
                        }]
                    };
                }

                const includeUnstaged = staged === false;
                const contextSections = await collectContextSections(gitService, true, includeUnstaged);

                if (contextSections.length === 0) {
                    return {
                        content: [{
                            type: 'text',
                            text: '⚠️ **No matching changes found**\n\nThe requested change set is empty. Stage files or modify files before generating a commit message.'
                        }]
                    };
                }

                const formattedContext = buildCombinedContextForAI(gitService, contextSections);
                const options: CommitMessageOptions = {
                    conventionalCommits: conventional_commits,
                    maxLength: max_length,
                    customInstructions: custom_instructions,
                    differentFromPrevious: different_from_previous,
                    verbose: verbose
                };

                const commitMessage = await commitAI.generateCommitMessage(formattedContext, options);
                const validation = commitAI.validateCommitMessage(commitMessage, options);

                const changeBuckets = bucketChanges(contextSections);
                const primaryContext = contextSections[0].context;
                const analyzedScope = includeUnstaged ? 'staged and unstaged changes' : 'staged changes (fallback to unstaged if none are staged)';

                let response = `# 🔄 Generated Commit Message\n\n`;
                response += `\`\`\`\n${commitMessage}\n\`\`\`\n\n`;
                response += `## 📊 Context Summary\n\n`;
                response += `- **Repository:** \`${primaryContext.workingDirectory}\`\n`;
                response += `- **Branch:** \`${primaryContext.currentBranch}\`\n`;
                response += `- **Changes:** ${changeBuckets.staged.length} staged / ${changeBuckets.unstaged.length} unstaged files\n`;
                response += `- **Analyzed Scope:** ${analyzedScope}\n`;
                response += `- **Format:** ${conventional_commits ? 'Conventional Commits' : 'Standard'}\n\n`;

                if (!validation.isValid) {
                    response += `## ⚠️ Validation Issues\n\n`;
                    for (const issue of validation.issues) {
                        response += `- ${issue}\n`;
                    }
                    response += `\n`;
                }

                const changedFilesSection = buildChangedFilesSection(contextSections);
                if (changedFilesSection) {
                    response += changedFilesSection;
                }

                return {
                    content: [{
                        type: 'text',
                        text: response
                    }]
                };

            } catch (error: any) {
                throw new McpError(
                    ErrorCode.InternalError,
                    `Failed to generate commit message: ${error.message}`
                );
            }
        }
    },
    {
        name: 'git_commit',
        description: 'Generate an AI-powered commit message for staged changes and create the git commit automatically. Unstaged changes are left untouched.',
        inputSchema: {
            type: 'object',
            properties: {
                working_directory: {
                    type: 'string',
                    description: 'Absolute path to the git repository. If not provided, searches for git repo starting from current directory.'
                },
                conventional_commits: {
                    type: 'boolean',
                    description: 'Use Conventional Commits format (default: true)'
                },
                max_length: {
                    type: 'number',
                    description: 'Maximum length of commit message (default: 1500)'
                },
                custom_instructions: {
                    type: 'string',
                    description: 'Additional custom instructions for commit message generation'
                },
                different_from_previous: {
                    type: 'string',
                    description: 'Previous commit message to generate a different alternative from'
                },
                verbose: {
                    type: 'boolean',
                    description: 'Generate detailed multi-line commit messages with body explanations (default: false)'
                },
                dry_run: {
                    type: 'boolean',
                    description: 'Generate the commit message and show the plan without running git commit (default: false)'
                }
            },
            additionalProperties: false
        },
        func: async (args: any, memoryManager?: MemoryManager) => {
            if (!memoryManager) {
                throw new McpError(ErrorCode.InternalError, 'MemoryManager instance is required');
            }

            const {
                working_directory,
                conventional_commits = true,
                max_length = 1500,
                custom_instructions,
                different_from_previous,
                verbose = false,
                dry_run = false
            } = args;

            try {
                const gitService = new GitService(working_directory);
                const stagedChanges = await gitService.gatherStagedChanges();

                if (stagedChanges.length === 0) {
                    return {
                        content: [{
                            type: 'text',
                            text: '⚠️ **No staged changes detected**\n\nStage files before running `git_commit`, or use `generate_commit_message` if you only need a draft message.'
                        }]
                    };
                }

                const unstagedChanges = await gitService.gatherUnstagedChanges();
                
                const contextSections = await collectContextSections(gitService, true, false);
                if (contextSections.length === 0) {
                    return {
                        content: [{
                            type: 'text',
                            text: '⚠️ **Unable to build commit context**\n\nStaged changes were detected but no analyzable context could be generated. Ensure files are correctly staged and try again.'
                        }]
                    };
                }

                const geminiService = memoryManager.getGeminiIntegrationService();
                const commitAI = new CommitMessageAI(geminiService);

                const formattedContext = buildCombinedContextForAI(gitService, contextSections);
                const options: CommitMessageOptions = {
                    conventionalCommits: conventional_commits,
                    maxLength: max_length,
                    customInstructions: custom_instructions,
                    differentFromPrevious: different_from_previous,
                    verbose: verbose
                };

                const commitMessage = await commitAI.generateCommitMessage(formattedContext, options);
                const validation = commitAI.validateCommitMessage(commitMessage, options);

                if (!validation.isValid) {
                    let response = '# ⚠️ Commit Aborted Due to Validation Issues\n\n';
                    response += 'The generated commit message did not meet validation requirements. No commit was made.\n\n';
                    response += '## Generated Message\n\n';
                    response += `\`\`\`\n${commitMessage}\n\`\`\`\n\n`;
                    response += '## Validation Issues\n\n';
                    for (const issue of validation.issues) {
                        response += `- ${issue}\n`;
                    }
                    return {
                        content: [{ type: 'text', text: response }]
                    };
                }

                const changeBuckets = bucketChanges(contextSections);
                const primaryContext = contextSections[0].context;
                const changedFilesSection = buildChangedFilesSection(contextSections);
                const analyzedScope = changeBuckets.unstaged.length > 0 || unstagedChanges.length > 0
                    ? 'staged changes (unstaged files not committed)'
                    : 'staged changes';

                if (dry_run) {
                    let response = '# 🧪 Dry Run: Generated Commit Message\n\n';
                    response += `\`\`\`\n${commitMessage}\n\`\`\`\n\n`;
                    response += '## 📊 Context Summary\n\n';
                    response += `- **Repository:** \`${primaryContext.workingDirectory}\`\n`;
                    response += `- **Branch:** \`${primaryContext.currentBranch}\`\n`;
                    response += `- **Changes:** ${changeBuckets.staged.length} staged / ${unstagedChanges.length} unstaged files\n`;
                    response += `- **Analyzed Scope:** ${analyzedScope}\n`;
                    response += `- **Format:** ${conventional_commits ? 'Conventional Commits' : 'Standard'}\n`;

                    if (changedFilesSection) {
                        response += '\n' + changedFilesSection;
                    }

                    response += '\nRun again without `dry_run` to create the commit.';

                    return {
                        content: [{ type: 'text', text: response }]
                    };
                }

                const commitOutput = gitService.commitStagedChanges(commitMessage);
                const remainingUnstaged = unstagedChanges.length;
                const hasRemainingChanges = remainingUnstaged > 0;

                let response = '# ✅ Commit Created with AI-Generated Message\n\n';
                response += '## ✉️ Commit Message\n\n';
                response += `\`\`\`\n${commitMessage}\n\`\`\`\n\n`;
                response += '## 📊 Context Summary\n\n';
                response += `- **Repository:** \`${primaryContext.workingDirectory}\`\n`;
                response += `- **Branch:** \`${primaryContext.currentBranch}\`\n`;
                response += `- **Changes:** ${changeBuckets.staged.length} staged / ${remainingUnstaged} unstaged files\n`;
                response += `- **Analyzed Scope:** ${analyzedScope}\n`;
                response += `- **Format:** ${conventional_commits ? 'Conventional Commits' : 'Standard'}\n`;

                if (changedFilesSection) {
                    response += '\n' + changedFilesSection;
                }

                response += '## 📦 Git Commit Output\n\n';
                response += `\`\`\`\n${commitOutput.trim() || 'Commit completed.'}\n\`\`\`\n`;

                if (hasRemainingChanges) {
                    response += '\n⚠️ Unstaged changes remain in the working directory. Stage and commit them separately if needed.';
                }

                return {
                    content: [{ type: 'text', text: response }]
                };

            } catch (error: any) {
                throw new McpError(
                    ErrorCode.InternalError,
                    `Failed to commit with generated message: ${error.message}`
                );
            }
        }
    },
    {
        name: 'git_status',
        description: 'Display the current git status, including staged and unstaged files, with an optional verbose summary.',
        inputSchema: {
            type: 'object',
            properties: {
                working_directory: {
                    type: 'string',
                    description: 'Absolute path to the git repository. If not provided, searches for git repo starting from current directory.'
                },
                verbose: {
                    type: 'boolean',
                    description: 'Show full git status output instead of concise summary (default: false)'
                }
            },
            additionalProperties: false
        },
        func: async (args: any) => {
            const { working_directory, verbose = false } = args;

            try {
                const gitService = new GitService(working_directory);
                const statusOutput = gitService.getStatus(verbose);
                const stagedChanges = await gitService.gatherStagedChanges();
                const unstagedChanges = await gitService.gatherUnstagedChanges();

                const sections = await collectContextSections(gitService, true, true);
                const changedFilesSection = buildChangedFilesSection(sections);
                const summaryScope = unstagedChanges.length > 0 ? 'staged and unstaged changes' : 'staged changes';

                let response = '# 📋 Git Status\n\n';
                response += `- **Repository:** \`${gitService.getWorkingDirectory()}\`\n`;
                response += `- **Branch:** \`${gitService.getCurrentBranchName()}\`\n`;
                response += `- **Staged Files:** ${stagedChanges.length}\n`;
                response += `- **Unstaged Files:** ${unstagedChanges.length}\n`;
                response += `- **Analyzed Scope:** ${summaryScope}\n\n`;

                response += `## git status ${verbose ? '' : '--short --branch'}\n\n`;
                response += `\`\`\`\n${statusOutput.trim() || '(no output)'}\n\`\`\`\n\n`;

                if (changedFilesSection) {
                    response += changedFilesSection;
                }

                return {
                    content: [{ type: 'text', text: response }]
                };

            } catch (error: any) {
                throw new McpError(
                    ErrorCode.InternalError,
                    `Failed to retrieve git status: ${error.message}`
                );
            }
        }
    },
    {
        name: 'git_stage',
        description: 'Stage specific files or all changes in the repository. Supports dry-run previews.',
        inputSchema: {
            type: 'object',
            properties: {
                working_directory: {
                    type: 'string',
                    description: 'Absolute path to the git repository. If not provided, searches for git repo starting from current directory.'
                },
                files: {
                    oneOf: [
                        { type: 'string', description: 'Single file path or newline/comma separated list of files to stage' },
                        {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Array of file paths to stage'
                        }
                    ]
                },
                dry_run: {
                    type: 'boolean',
                    description: 'Show the files that would be staged without executing git add (default: false)'
                }
            },
            additionalProperties: false
        },
        func: async (args: any) => {
            const { working_directory, files, dry_run = false } = args;

            try {
                const gitService = new GitService(working_directory);
                const fileList = parseFileArguments(files);

                if (dry_run) {
                    const targetDescription = fileList.length > 0 ? fileList.map(file => `- \`${file}\``).join('\n') : '- Entire working tree (equivalent to `git add --all`)';

                    let response = '# 🧪 Dry Run: git add\n\n';
                    response += 'The following items would be staged:\n\n';
                    response += `${targetDescription}\n\n`;
                    response += 'Run again without `dry_run` to stage the changes.';

                    return {
                        content: [{ type: 'text', text: response }]
                    };
                }

                const result = gitService.stageFiles(fileList);
                const stagedAfter = await gitService.gatherStagedChanges();

                let response = '# ✅ git add completed\n\n';
                response += `- **Repository:** \`${gitService.getWorkingDirectory()}\`\n`;
                response += `- **Files staged:** ${stagedAfter.length}\n\n`;
                response += '## git output\n\n';
                response += `\`\`\`\n${result.trim() || 'Changes staged successfully.'}\n\`\`\`\n`;

                return {
                    content: [{ type: 'text', text: response }]
                };

            } catch (error: any) {
                throw new McpError(
                    ErrorCode.InternalError,
                    `Failed to stage files: ${error.message}`
                );
            }
        }
    },
    {
        name: 'git_unstage',
        description: 'Unstage specific files or all staged changes. Supports dry-run previews.',
        inputSchema: {
            type: 'object',
            properties: {
                working_directory: {
                    type: 'string',
                    description: 'Absolute path to the git repository. If not provided, searches for git repo starting from current directory.'
                },
                files: {
                    oneOf: [
                        { type: 'string', description: 'Single file path or newline/comma separated list of files to unstage' },
                        {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Array of file paths to unstage'
                        }
                    ]
                },
                dry_run: {
                    type: 'boolean',
                    description: 'Show the files that would be unstaged without executing git reset (default: false)'
                }
            },
            additionalProperties: false
        },
        func: async (args: any) => {
            const { working_directory, files, dry_run = false } = args;

            try {
                const gitService = new GitService(working_directory);
                const fileList = parseFileArguments(files);

                if (dry_run) {
                    const targetDescription = fileList.length > 0 ? fileList.map(file => `- \`${file}\``).join('\n') : '- All staged files (equivalent to `git reset HEAD -- .`)';

                    let response = '# 🧪 Dry Run: git reset (unstage)\n\n';
                    response += 'The following items would be unstaged:\n\n';
                    response += `${targetDescription}\n\n`;
                    response += 'Run again without `dry_run` to unstage the changes.';

                    return {
                        content: [{ type: 'text', text: response }]
                    };
                }

                const beforeCount = (await gitService.gatherStagedChanges()).length;
                const result = gitService.unstageFiles(fileList);
                const afterCount = (await gitService.gatherStagedChanges()).length;

                let response = '# ✅ git reset completed\n\n';
                response += `- **Repository:** \`${gitService.getWorkingDirectory()}\`\n`;
                response += `- **Staged files before:** ${beforeCount}\n`;
                response += `- **Staged files after:** ${afterCount}\n\n`;
                response += '## git output\n\n';
                response += `\`\`\`\n${result.trim() || 'Changes unstaged successfully.'}\n\`\`\`\n`;

                return {
                    content: [{ type: 'text', text: response }]
                };

            } catch (error: any) {
                throw new McpError(
                    ErrorCode.InternalError,
                    `Failed to unstage files: ${error.message}`
                );
            }
        }
    },
    {
        name: 'git_diff',
        description: 'Show git diffs for staged, unstaged, or all changes with optional file filtering and diff statistics.',
        inputSchema: {
            type: 'object',
            properties: {
                working_directory: {
                    type: 'string',
                    description: 'Absolute path to the git repository. If not provided, searches for git repo starting from current directory.'
                },
                scope: {
                    type: 'string',
                    enum: ['staged', 'unstaged', 'all'],
                    description: 'Which changes to include in the diff (default: staged)'
                },
                files: {
                    oneOf: [
                        { type: 'string', description: 'Single file or newline/comma separated list of files to diff' },
                        {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Array of file paths to diff'
                        }
                    ]
                },
                stat_only: {
                    type: 'boolean',
                    description: 'Show summary statistics instead of full patch (default: false)'
                },
                context_lines: {
                    type: 'number',
                    description: 'Number of context lines to include in the diff (default: git default)'
                }
            },
            additionalProperties: false
        },
        func: async (args: any) => {
            const {
                working_directory,
                scope = 'staged',
                files,
                stat_only = false,
                context_lines
            } = args;

            try {
                const gitService = new GitService(working_directory);
                const fileList = parseFileArguments(files);

                const includeStaged = scope === 'staged' || scope === 'all';
                const includeUnstaged = scope === 'unstaged' || scope === 'all';

                const stagedChanges = await gitService.gatherStagedChanges();
                const unstagedChanges = await gitService.gatherUnstagedChanges();

                const sections = await collectContextSections(gitService, includeStaged, includeUnstaged);
                const changedFilesSection = buildChangedFilesSection(sections);

                const diffOptions = {
                    files: fileList,
                    stat: stat_only,
                    unified: typeof context_lines === 'number' ? context_lines : undefined
                };

                const diffs: Array<{ label: string; output: string }> = [];

                if (includeStaged) {
                    const stagedDiff = gitService.getDiffOutput({ ...diffOptions, staged: true });
                    diffs.push({ label: 'Staged Changes', output: stagedDiff });
                }

                if (includeUnstaged) {
                    const unstagedDiff = gitService.getDiffOutput({ ...diffOptions, staged: false });
                    diffs.push({ label: 'Unstaged Changes', output: unstagedDiff });
                }

                const repository = gitService.getWorkingDirectory();
                const branch = gitService.getCurrentBranchName();

                let response = '# 🔍 Git Diff\n\n';
                response += `- **Repository:** \`${repository}\`\n`;
                response += `- **Branch:** \`${branch}\`\n`;
                response += `- **Scope:** ${scope}\n`;
                response += `- **Staged Files:** ${stagedChanges.length}\n`;
                response += `- **Unstaged Files:** ${unstagedChanges.length}\n`;
                response += `- **Diff Mode:** ${stat_only ? 'Summary (--stat)' : 'Full patch'}\n`;
                if (fileList.length > 0) {
                    response += `- **Filtered Files:** ${fileList.map(file => `\`${file}\``).join(', ')}\n`;
                }
                if (typeof context_lines === 'number') {
                    response += `- **Context Lines:** ${context_lines}\n`;
                }
                response += '\n';

                if (changedFilesSection) {
                    response += changedFilesSection;
                }

                diffs.forEach(diffEntry => {
                    const content = diffEntry.output.trim();
                    response += `## ${diffEntry.label}\n\n`;
                    if (!content) {
                        response += '_No changes to display._\n\n';
                    } else {
                        const language = stat_only ? '' : 'diff';
                        response += `\`\`\`${language}\n${content}\n\`\`\`\n\n`;
                    }
                });

                if (diffs.every(entry => !entry.output.trim())) {
                    response += '_No differences found for the selected scope._\n';
                }

                return {
                    content: [{ type: 'text', text: response }]
                };

            } catch (error: any) {
                throw new McpError(
                    ErrorCode.InternalError,
                    `Failed to generate git diff: ${error.message}`
                );
            }
        }
    },
    {
        name: 'git_list_branches',
        description: 'List local branches (and optionally remote branches) with the current branch highlighted.',
        inputSchema: {
            type: 'object',
            properties: {
                working_directory: {
                    type: 'string',
                    description: 'Absolute path to the git repository. If not provided, searches for git repo starting from current directory.'
                },
                include_remote: {
                    type: 'boolean',
                    description: 'Include remote branches in the listing (default: false)'
                }
            },
            additionalProperties: false
        },
        func: async (args: any) => {
            const { working_directory, include_remote = false } = args;

            try {
                const gitService = new GitService(working_directory);
                const { current, branches } = gitService.listBranches(include_remote);

                let response = '# 🌿 Git Branches\n\n';
                response += `- **Repository:** \`${gitService.getWorkingDirectory()}\`\n`;
                response += `- **Current Branch:** \`${current ?? 'unknown'}\`\n`;
                response += `- **Total Branches:** ${branches.length}\n`;
                response += `- **Scope:** ${include_remote ? 'Local + Remote' : 'Local only'}\n\n`;

                if (branches.length > 0) {
                    response += '## Branches\n\n';
                    branches.forEach(branch => {
                        const prefix = branch.isCurrent ? '⭐' : branch.isRemote ? '🌐' : '  ';
                        response += `${prefix} \`${branch.name}\`\n`;
                    });
                }

                return {
                    content: [{ type: 'text', text: response }]
                };

            } catch (error: any) {
                throw new McpError(
                    ErrorCode.InternalError,
                    `Failed to list branches: ${error.message}`
                );
            }
        }
    },
    {
        name: 'git_checkout_branch',
        description: 'Checkout an existing branch or create a new branch and switch to it. Supports dry-run previews.',
        inputSchema: {
            type: 'object',
            properties: {
                working_directory: {
                    type: 'string',
                    description: 'Absolute path to the git repository. If not provided, searches for git repo starting from current directory.'
                },
                branch: {
                    type: 'string',
                    description: 'Branch name to checkout (required)'
                },
                create: {
                    type: 'boolean',
                    description: 'Create the branch if it does not exist (default: false)'
                },
                start_point: {
                    type: 'string',
                    description: 'Optional starting point when creating a new branch'
                },
                dry_run: {
                    type: 'boolean',
                    description: 'Show the action without running git checkout (default: false)'
                }
            },
            required: ['branch'],
            additionalProperties: false
        },
        func: async (args: any) => {
            const { working_directory, branch, create = false, start_point, dry_run = false } = args;

            try {
                const gitService = new GitService(working_directory);
                const trimmedBranch = (branch as string).trim();
                if (!trimmedBranch) {
                    throw new Error('Branch name cannot be empty');
                }

                if (dry_run) {
                    let response = '# 🧪 Dry Run: git checkout\n\n';
                    response += `- **Target Branch:** \`${trimmedBranch}\`\n`;
                    response += `- **Create if missing:** ${create ? 'yes' : 'no'}\n`;
                    if (create && start_point) {
                        response += `- **Start Point:** \`${start_point}\`\n`;
                    }
                    response += '\nRun again without `dry_run` to execute the checkout.';

                    return {
                        content: [{ type: 'text', text: response }]
                    };
                }

                const result = gitService.checkoutBranch(trimmedBranch, { create, startPoint: start_point });
                const currentBranch = gitService.getCurrentBranchName() || trimmedBranch;

                let response = '# ✅ git checkout completed\n\n';
                response += `- **Repository:** \`${gitService.getWorkingDirectory()}\`\n`;
                response += `- **Current Branch:** \`${currentBranch}\`\n`;
                response += `- **Created New Branch:** ${create ? 'yes' : 'no'}\n\n`;
                response += '## git output\n\n';
                response += `\`\`\`\n${result.trim() || `Switched to branch '${currentBranch}'.`}\n\`\`\`\n`;

                return {
                    content: [{ type: 'text', text: response }]
                };

            } catch (error: any) {
                throw new McpError(
                    ErrorCode.InternalError,
                    `Failed to checkout branch: ${error.message}`
                );
            }
        }
    },
    {
        name: 'git_create_branch',
        description: 'Create a new branch (optionally from a specific starting point) and optionally check it out.',
        inputSchema: {
            type: 'object',
            properties: {
                working_directory: {
                    type: 'string',
                    description: 'Absolute path to the git repository. If not provided, searches for git repo starting from current directory.'
                },
                branch: {
                    type: 'string',
                    description: 'Name of the branch to create (required)'
                },
                start_point: {
                    type: 'string',
                    description: 'Optional starting point (commit hash or branch) for the new branch'
                },
                checkout: {
                    type: 'boolean',
                    description: 'Switch to the new branch after creation (default: false)'
                },
                dry_run: {
                    type: 'boolean',
                    description: 'Show the action without running git branch (default: false)'
                }
            },
            required: ['branch'],
            additionalProperties: false
        },
        func: async (args: any) => {
            const { working_directory, branch, start_point, checkout = false, dry_run = false } = args;

            try {
                const gitService = new GitService(working_directory);
                const trimmedBranch = (branch as string).trim();
                if (!trimmedBranch) {
                    throw new Error('Branch name cannot be empty');
                }

                if (dry_run) {
                    let response = '# 🧪 Dry Run: git branch\n\n';
                    response += `- **Branch to create:** \`${trimmedBranch}\`\n`;
                    if (start_point) {
                        response += `- **Start Point:** \`${start_point}\`\n`;
                    }
                    response += `- **Checkout after creation:** ${checkout ? 'yes' : 'no'}\n`;
                    response += '\nRun again without `dry_run` to create the branch.';

                    return {
                        content: [{ type: 'text', text: response }]
                    };
                }

                const branchResult = gitService.createBranch(trimmedBranch, start_point);
                let checkoutOutput = '';
                let currentBranch = gitService.getCurrentBranchName() || 'unknown';

                if (checkout) {
                    checkoutOutput = gitService.checkoutBranch(trimmedBranch);
                    currentBranch = trimmedBranch;
                }

                let response = '# ✅ Branch created\n\n';
                response += `- **Repository:** \`${gitService.getWorkingDirectory()}\`\n`;
                response += `- **Branch created:** \`${trimmedBranch}\`\n`;
                response += `- **Start point:** \`${start_point ?? 'HEAD'}\`\n`;
                response += `- **Checked out:** ${checkout ? 'yes' : 'no'}\n`;
                response += `- **Current branch:** \`${currentBranch}\`\n\n`;
                response += '## git branch output\n\n';
                response += `\`\`\`\n${branchResult.trim() || 'Branch created successfully.'}\n\`\`\`\n`;

                if (checkout) {
                    response += '\n## git checkout output\n\n';
                    response += `\`\`\`\n${checkoutOutput.trim() || `Switched to branch '${trimmedBranch}'.`}\n\`\`\`\n`;
                }

                return {
                    content: [{ type: 'text', text: response }]
                };

            } catch (error: any) {
                throw new McpError(
                    ErrorCode.InternalError,
                    `Failed to create branch: ${error.message}`
                );
            }
        }
    },
    {
        name: 'git_log',
        description: 'Show commit history with customizable formatting and filtering options.',
        inputSchema: {
            type: 'object',
            properties: {
                working_directory: {
                    type: 'string',
                    description: 'Absolute path to the git repository. If not provided, searches for git repo starting from current directory.'
                },
                max_count: {
                    type: 'number',
                    description: 'Maximum number of commits to display (default: 10)'
                },
                format: {
                    type: 'string',
                    description: 'Custom format string for commit display (default: "%h - %s (%an, %ar)")'
                },
                branch: {
                    type: 'string',
                    description: 'Show commits only from this branch'
                },
                file: {
                    type: 'string',
                    description: 'Show only commits that affected this file'
                },
                author: {
                    type: 'string',
                    description: 'Show only commits by this author'
                },
                since: {
                    type: 'string',
                    description: 'Show commits more recent than a specific date (e.g., "2023-01-01")'
                },
                until: {
                    type: 'string',
                    description: 'Show commits older than a specific date (e.g., "2023-01-01")'
                },
                grep: {
                    type: 'string',
                    description: 'Show commits with messages matching the pattern'
                }
            },
            additionalProperties: false
        },
        func: async (args: any) => {
            const {
                working_directory,
                max_count = 10,
                format = '%h - %s (%an, %ar)',
                branch,
                file,
                author,
                since,
                until,
                grep
            } = args;

            try {
                const gitService = new GitService(working_directory);
                const logOutput = gitService.getLog({
                    maxCount: max_count,
                    format,
                    branch,
                    file,
                    author,
                    since,
                    until,
                    grep
                });

                let response = '# 📜 Git Log\n\n';
                response += `- **Repository:** \`${gitService.getWorkingDirectory()}\`\n`;
                response += `- **Branch:** \`${branch || gitService.getCurrentBranchName()}\`\n`;
                response += `- **Max Commits:** ${max_count}\n\n`;
                response += '## Commit History\n\n';
                response += `\`\`\`\n${logOutput.trim() || 'No commits found.'}\n\`\`\`\n`;

                return {
                    content: [{ type: 'text', text: response }]
                };

            } catch (error: any) {
                throw new McpError(
                    ErrorCode.InternalError,
                    `Failed to retrieve git log: ${error.message}`
                );
            }
        }
    },
    {
        name: 'git_pull',
        description: 'Pull changes from a remote repository with options for rebase and pruning.',
        inputSchema: {
            type: 'object',
            properties: {
                working_directory: {
                    type: 'string',
                    description: 'Absolute path to the git repository. If not provided, searches for git repo starting from current directory.'
                },
                remote: {
                    type: 'string',
                    description: 'Remote repository to pull from (default: "origin")'
                },
                branch: {
                    type: 'string',
                    description: 'Remote branch to pull (default: current branch\'s upstream)'
                },
                rebase: {
                    type: 'boolean',
                    description: 'Use rebase instead of merge (default: false)'
                },
                prune: {
                    type: 'boolean',
                    description: 'Remove remote-tracking references that no longer exist (default: false)'
                },
                dry_run: {
                    type: 'boolean',
                    description: 'Show what would be pulled without actually pulling (default: false)'
                }
            },
            additionalProperties: false
        },
        func: async (args: any) => {
            const {
                working_directory,
                remote = 'origin',
                branch,
                rebase = false,
                prune = false,
                dry_run = false
            } = args;

            try {
                const gitService = new GitService(working_directory);
                const currentBranch = gitService.getCurrentBranchName();

                if (dry_run) {
                    let response = '# 🧪 Dry Run: git pull\n\n';
                    response += `- **Repository:** \`${gitService.getWorkingDirectory()}\`\n`;
                    response += `- **Current Branch:** \`${currentBranch}\`\n`;
                    response += `- **Remote:** \`${remote}\`\n`;
                    if (branch) {
                        response += `- **Branch:** \`${branch}\`\n`;
                    }
                    response += `- **Mode:** ${rebase ? 'rebase' : 'merge'}\n`;
                    response += `- **Prune:** ${prune ? 'yes' : 'no'}\n\n`;
                    response += 'Run again without `dry_run` to pull changes.';

                    return {
                        content: [{ type: 'text', text: response }]
                    };
                }

                const pullOutput = gitService.pull({
                    remote,
                    branch,
                    rebase,
                    prune
                });

                let response = '# ✅ Git Pull Completed\n\n';
                response += `- **Repository:** \`${gitService.getWorkingDirectory()}\`\n`;
                response += `- **Current Branch:** \`${currentBranch}\`\n`;
                response += `- **Remote:** \`${remote}\`\n`;
                if (branch) {
                    response += `- **Branch:** \`${branch}\`\n`;
                }
                response += `- **Mode:** ${rebase ? 'rebase' : 'merge'}\n`;
                response += `- **Prune:** ${prune ? 'yes' : 'no'}\n\n`;
                response += '## git pull output\n\n';
                response += `\`\`\`\n${pullOutput.trim() || 'Pull completed successfully.'}\n\`\`\`\n`;

                return {
                    content: [{ type: 'text', text: response }]
                };

            } catch (error: any) {
                throw new McpError(
                    ErrorCode.InternalError,
                    `Failed to pull changes: ${error.message}`
                );
            }
        }
    },
    {
        name: 'git_push',
        description: 'Push changes to a remote repository with options for force pushing and setting upstream.',
        inputSchema: {
            type: 'object',
            properties: {
                working_directory: {
                    type: 'string',
                    description: 'Absolute path to the git repository. If not provided, searches for git repo starting from current directory.'
                },
                remote: {
                    type: 'string',
                    description: 'Remote repository to push to (default: "origin")'
                },
                branch: {
                    type: 'string',
                    description: 'Branch to push (default: current branch)'
                },
                force: {
                    type: 'boolean',
                    description: 'Force push (default: false)'
                },
                force_with_lease: {
                    type: 'boolean',
                    description: 'Force push with lease (safer than force) (default: false)'
                },
                set_upstream: {
                    type: 'boolean',
                    description: 'Set upstream for the branch (default: false)'
                },
                dry_run: {
                    type: 'boolean',
                    description: 'Show what would be pushed without actually pushing (default: false)'
                }
            },
            additionalProperties: false
        },
        func: async (args: any) => {
            const {
                working_directory,
                remote = 'origin',
                branch,
                force = false,
                force_with_lease = false,
                set_upstream = false,
                dry_run = false
            } = args;

            try {
                const gitService = new GitService(working_directory);
                const currentBranch = gitService.getCurrentBranchName();

                if (dry_run) {
                    let response = '# 🧪 Dry Run: git push\n\n';
                    response += `- **Repository:** \`${gitService.getWorkingDirectory()}\`\n`;
                    response += `- **Current Branch:** \`${currentBranch}\`\n`;
                    response += `- **Remote:** \`${remote}\`\n`;
                    if (branch) {
                        response += `- **Branch:** \`${branch}\`\n`;
                    }
                    response += `- **Force:** ${force ? 'yes' : 'no'}\n`;
                    response += `- **Force with lease:** ${force_with_lease ? 'yes' : 'no'}\n`;
                    response += `- **Set upstream:** ${set_upstream ? 'yes' : 'no'}\n\n`;
                    response += 'Run again without `dry_run` to push changes.';

                    return {
                        content: [{ type: 'text', text: response }]
                    };
                }

                const pushOutput = gitService.push({
                    remote,
                    branch,
                    force,
                    forceWithLease: force_with_lease,
                    setUpstream: set_upstream
                });

                let response = '# ✅ Git Push Completed\n\n';
                response += `- **Repository:** \`${gitService.getWorkingDirectory()}\`\n`;
                response += `- **Current Branch:** \`${currentBranch}\`\n`;
                response += `- **Remote:** \`${remote}\`\n`;
                if (branch) {
                    response += `- **Branch:** \`${branch}\`\n`;
                }
                response += `- **Force:** ${force ? 'yes' : 'no'}\n`;
                response += `- **Force with lease:** ${force_with_lease ? 'yes' : 'no'}\n`;
                response += `- **Set upstream:** ${set_upstream ? 'yes' : 'no'}\n\n`;
                response += '## git push output\n\n';
                response += `\`\`\`\n${pushOutput.trim() || 'Push completed successfully.'}\n\`\`\`\n`;

                return {
                    content: [{ type: 'text', text: response }]
                };

            } catch (error: any) {
                throw new McpError(
                    ErrorCode.InternalError,
                    `Failed to push changes: ${error.message}`
                );
            }
        }
    },
    {
        name: 'git_merge',
        description: 'Merge changes from another branch into the current branch.',
        inputSchema: {
            type: 'object',
            properties: {
                working_directory: {
                    type: 'string',
                    description: 'Absolute path to the git repository. If not provided, searches for git repo starting from current directory.'
                },
                branch: {
                    type: 'string',
                    description: 'Branch to merge into the current branch (required)'
                },
                message: {
                    type: 'string',
                    description: 'Custom merge commit message'
                },
                no_commit: {
                    type: 'boolean',
                    description: 'Prepare the merge but do not actually commit (default: false)'
                },
                no_ff: {
                    type: 'boolean',
                    description: 'Create a merge commit even if the merge is a fast-forward (default: false)'
                },
                squash: {
                    type: 'boolean',
                    description: 'Squash all changes from the other branch into a single commit (default: false)'
                },
                dry_run: {
                    type: 'boolean',
                    description: 'Show what would be merged without actually merging (default: false)'
                }
            },
            required: ['branch'],
            additionalProperties: false
        },
        func: async (args: any) => {
            const {
                working_directory,
                branch,
                message,
                no_commit = false,
                no_ff = false,
                squash = false,
                dry_run = false
            } = args;

            try {
                const gitService = new GitService(working_directory);
                const currentBranch = gitService.getCurrentBranchName();

                if (dry_run) {
                    let response = '# 🧪 Dry Run: git merge\n\n';
                    response += `- **Repository:** \`${gitService.getWorkingDirectory()}\`\n`;
                    response += `- **Current Branch:** \`${currentBranch}\`\n`;
                    response += `- **Source Branch:** \`${branch}\`\n`;
                    if (message) {
                        response += `- **Message:** \`${message}\`\n`;
                    }
                    response += `- **No commit:** ${no_commit ? 'yes' : 'no'}\n`;
                    response += `- **No fast-forward:** ${no_ff ? 'yes' : 'no'}\n`;
                    response += `- **Squash:** ${squash ? 'yes' : 'no'}\n\n`;
                    response += 'Run again without `dry_run` to merge changes.';

                    return {
                        content: [{ type: 'text', text: response }]
                    };
                }

                const mergeOutput = gitService.merge({
                    branch,
                    message,
                    noCommit: no_commit,
                    noFf: no_ff,
                    squash
                });

                let response = '# ✅ Git Merge Completed\n\n';
                response += `- **Repository:** \`${gitService.getWorkingDirectory()}\`\n`;
                response += `- **Current Branch:** \`${currentBranch}\`\n`;
                response += `- **Source Branch:** \`${branch}\`\n`;
                if (message) {
                    response += `- **Message:** \`${message}\`\n`;
                }
                response += `- **No commit:** ${no_commit ? 'yes' : 'no'}\n`;
                response += `- **No fast-forward:** ${no_ff ? 'yes' : 'no'}\n`;
                response += `- **Squash:** ${squash ? 'yes' : 'no'}\n\n`;
                response += '## git merge output\n\n';
                response += `\`\`\`\n${mergeOutput.trim() || 'Merge completed successfully.'}\n\`\`\`\n`;

                return {
                    content: [{ type: 'text', text: response }]
                };

            } catch (error: any) {
                throw new McpError(
                    ErrorCode.InternalError,
                    `Failed to merge changes: ${error.message}`
                );
            }
        }
    },
    {
        name: 'git_rebase',
        description: 'Rebase the current branch onto another branch or commit.',
        inputSchema: {
            type: 'object',
            properties: {
                working_directory: {
                    type: 'string',
                    description: 'Absolute path to the git repository. If not provided, searches for git repo starting from current directory.'
                },
                onto: {
                    type: 'string',
                    description: 'Branch or commit to rebase onto (required)'
                },
                interactive: {
                    type: 'boolean',
                    description: 'Start an interactive rebase (default: false)'
                },
                autosquash: {
                    type: 'boolean',
                    description: 'Automatically squash commits with "fixup!" or "squash!" messages (default: false)'
                },
                continue: {
                    type: 'boolean',
                    description: 'Continue a rebase after resolving conflicts (default: false)'
                },
                abort: {
                    type: 'boolean',
                    description: 'Abort a rebase in progress (default: false)'
                },
                skip: {
                    type: 'boolean',
                    description: 'Skip the current commit during a rebase (default: false)'
                },
                dry_run: {
                    type: 'boolean',
                    description: 'Show what would be rebased without actually rebasing (default: false)'
                }
            },
            required: ['onto'],
            additionalProperties: false
        },
        func: async (args: any) => {
            const {
                working_directory,
                onto,
                interactive = false,
                autosquash = false,
                continue: continueRebase = false,
                abort = false,
                skip = false,
                dry_run = false
            } = args;

            try {
                const gitService = new GitService(working_directory);
                const currentBranch = gitService.getCurrentBranchName();

                if (dry_run) {
                    let response = '# 🧪 Dry Run: git rebase\n\n';
                    response += `- **Repository:** \`${gitService.getWorkingDirectory()}\`\n`;
                    response += `- **Current Branch:** \`${currentBranch}\`\n`;
                    response += `- **Target:** \`${onto}\`\n`;
                    response += `- **Interactive:** ${interactive ? 'yes' : 'no'}\n`;
                    response += `- **Autosquash:** ${autosquash ? 'yes' : 'no'}\n`;
                    response += `- **Continue:** ${continueRebase ? 'yes' : 'no'}\n`;
                    response += `- **Abort:** ${abort ? 'yes' : 'no'}\n`;
                    response += `- **Skip:** ${skip ? 'yes' : 'no'}\n\n`;
                    response += 'Run again without `dry_run` to rebase changes.';

                    return {
                        content: [{ type: 'text', text: response }]
                    };
                }

                const rebaseOutput = gitService.rebase({
                    onto,
                    interactive,
                    autosquash,
                    continue: continueRebase,
                    abort,
                    skip
                });

                let response = '# ✅ Git Rebase Completed\n\n';
                response += `- **Repository:** \`${gitService.getWorkingDirectory()}\`\n`;
                response += `- **Current Branch:** \`${currentBranch}\`\n`;
                response += `- **Target:** \`${onto}\`\n`;
                response += `- **Interactive:** ${interactive ? 'yes' : 'no'}\n`;
                response += `- **Autosquash:** ${autosquash ? 'yes' : 'no'}\n`;
                response += `- **Continue:** ${continueRebase ? 'yes' : 'no'}\n`;
                response += `- **Abort:** ${abort ? 'yes' : 'no'}\n`;
                response += `- **Skip:** ${skip ? 'yes' : 'no'}\n\n`;
                response += '## git rebase output\n\n';
                response += `\`\`\`\n${rebaseOutput.trim() || 'Rebase completed successfully.'}\n\`\`\`\n`;

                return {
                    content: [{ type: 'text', text: response }]
                };

            } catch (error: any) {
                throw new McpError(
                    ErrorCode.InternalError,
                    `Failed to rebase changes: ${error.message}`
                );
            }
        }
    },
    {
        name: 'git_reset',
        description: 'Reset current HEAD to the specified state with options for different reset modes.',
        inputSchema: {
            type: 'object',
            properties: {
                working_directory: {
                    type: 'string',
                    description: 'Absolute path to the git repository. If not provided, searches for git repo starting from current directory.'
                },
                commit: {
                    type: 'string',
                    description: 'Commit to reset to (default: HEAD)'
                },
                mode: {
                    type: 'string',
                    enum: ['soft', 'mixed', 'hard', 'merge', 'keep'],
                    description: 'Reset mode (default: "mixed")'
                },
                paths: {
                    oneOf: [
                        { type: 'string', description: 'Single file path or newline/comma separated list of files to reset' },
                        {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Array of file paths to reset'
                        }
                    ]
                },
                dry_run: {
                    type: 'boolean',
                    description: 'Show what would be reset without actually resetting (default: false)'
                }
            },
            additionalProperties: false
        },
        func: async (args: any) => {
            const {
                working_directory,
                commit = 'HEAD',
                mode = 'mixed',
                paths,
                dry_run = false
            } = args;

            try {
                const gitService = new GitService(working_directory);
                const currentBranch = gitService.getCurrentBranchName();
                const fileList = parseFileArguments(paths);

                if (dry_run) {
                    let response = '# 🧪 Dry Run: git reset\n\n';
                    response += `- **Repository:** \`${gitService.getWorkingDirectory()}\`\n`;
                    response += `- **Current Branch:** \`${currentBranch}\`\n`;
                    response += `- **Target Commit:** \`${commit}\`\n`;
                    response += `- **Mode:** \`${mode}\`\n`;
                    if (fileList.length > 0) {
                        response += `- **Paths:** ${fileList.map(file => `\`${file}\``).join(', ')}\n`;
                    }
                    response += '\nRun again without `dry_run` to reset changes.';

                    return {
                        content: [{ type: 'text', text: response }]
                    };
                }

                const resetOutput = gitService.reset({
                    commit,
                    mode,
                    paths: fileList
                });

                let response = '# ✅ Git Reset Completed\n\n';
                response += `- **Repository:** \`${gitService.getWorkingDirectory()}\`\n`;
                response += `- **Current Branch:** \`${currentBranch}\`\n`;
                response += `- **Target Commit:** \`${commit}\`\n`;
                response += `- **Mode:** \`${mode}\`\n`;
                if (fileList.length > 0) {
                    response += `- **Paths:** ${fileList.map(file => `\`${file}\``).join(', ')}\n`;
                }
                response += '\n## git reset output\n\n';
                response += `\`\`\`\n${resetOutput.trim() || 'Reset completed successfully.'}\n\`\`\`\n`;

                return {
                    content: [{ type: 'text', text: response }]
                };

            } catch (error: any) {
                throw new McpError(
                    ErrorCode.InternalError,
                    `Failed to reset changes: ${error.message}`
                );
            }
        }
    },
    {
        name: 'git_revert',
        description: 'Revert commits by creating new commits that undo the changes from previous commits.',
        inputSchema: {
            type: 'object',
            properties: {
                working_directory: {
                    type: 'string',
                    description: 'Absolute path to the git repository. If not provided, searches for git repo starting from current directory.'
                },
                commits: {
                    oneOf: [
                        { type: 'string', description: 'Single commit hash or newline/comma separated list of commits to revert' },
                        {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Array of commit hashes to revert'
                        }
                    ]
                },
                no_commit: {
                    type: 'boolean',
                    description: 'Prepare the revert but do not actually commit (default: false)'
                },
                edit: {
                    type: 'boolean',
                    description: 'Edit the commit message before committing (default: false)'
                },
                dry_run: {
                    type: 'boolean',
                    description: 'Show what would be reverted without actually reverting (default: false)'
                }
            },
            required: ['commits'],
            additionalProperties: false
        },
        func: async (args: any) => {
            const {
                working_directory,
                commits,
                no_commit = false,
                edit = false,
                dry_run = false
            } = args;

            try {
                const gitService = new GitService(working_directory);
                const currentBranch = gitService.getCurrentBranchName();
                const commitList = parseFileArguments(commits);

                if (dry_run) {
                    let response = '# 🧪 Dry Run: git revert\n\n';
                    response += `- **Repository:** \`${gitService.getWorkingDirectory()}\`\n`;
                    response += `- **Current Branch:** \`${currentBranch}\`\n`;
                    response += `- **Commits to revert:** ${commitList.map(commit => `\`${commit}\``).join(', ')}\n`;
                    response += `- **No commit:** ${no_commit ? 'yes' : 'no'}\n`;
                    response += `- **Edit message:** ${edit ? 'yes' : 'no'}\n\n`;
                    response += 'Run again without `dry_run` to revert changes.';

                    return {
                        content: [{ type: 'text', text: response }]
                    };
                }

                const revertOutput = gitService.revert({
                    commits: commitList,
                    noCommit: no_commit,
                    edit
                });

                let response = '# ✅ Git Revert Completed\n\n';
                response += `- **Repository:** \`${gitService.getWorkingDirectory()}\`\n`;
                response += `- **Current Branch:** \`${currentBranch}\`\n`;
                response += `- **Commits reverted:** ${commitList.map(commit => `\`${commit}\``).join(', ')}\n`;
                response += `- **No commit:** ${no_commit ? 'yes' : 'no'}\n`;
                response += `- **Edit message:** ${edit ? 'yes' : 'no'}\n\n`;
                response += '## git revert output\n\n';
                response += `\`\`\`\n${revertOutput.trim() || 'Revert completed successfully.'}\n\`\`\`\n`;

                return {
                    content: [{ type: 'text', text: response }]
                };

            } catch (error: any) {
                throw new McpError(
                    ErrorCode.InternalError,
                    `Failed to revert changes: ${error.message}`
                );
            }
        }
    },
    {
        name: 'git_stash',
        description: 'Stash changes, list stashes, or apply stashed changes.',
        inputSchema: {
            type: 'object',
            properties: {
                working_directory: {
                    type: 'string',
                    description: 'Absolute path to the git repository. If not provided, searches for git repo starting from current directory.'
                },
                action: {
                    type: 'string',
                    enum: ['push', 'pop', 'apply', 'list', 'drop', 'clear'],
                    description: 'Stash action to perform (default: "push")'
                },
                message: {
                    type: 'string',
                    description: 'Description for the stash (only for "push" action)'
                },
                index: {
                    type: 'number',
                    description: 'Stash index to apply, pop, or drop (only for "pop", "apply", and "drop" actions)'
                },
                include_untracked: {
                    type: 'boolean',
                    description: 'Include untracked files in the stash (only for "push" action) (default: false)'
                },
                keep_index: {
                    type: 'boolean',
                    description: 'Keep the index intact when stashing (only for "push" action) (default: false)'
                },
                dry_run: {
                    type: 'boolean',
                    description: 'Show what would be stashed without actually stashing (default: false)'
                }
            },
            additionalProperties: false
        },
        func: async (args: any) => {
            const {
                working_directory,
                action = 'push',
                message,
                index,
                include_untracked = false,
                keep_index = false,
                dry_run = false
            } = args;

            try {
                const gitService = new GitService(working_directory);
                const currentBranch = gitService.getCurrentBranchName();

                if (dry_run) {
                    let response = '# 🧪 Dry Run: git stash\n\n';
                    response += `- **Repository:** \`${gitService.getWorkingDirectory()}\`\n`;
                    response += `- **Current Branch:** \`${currentBranch}\`\n`;
                    response += `- **Action:** \`${action}\`\n`;
                    if (message) {
                        response += `- **Message:** \`${message}\`\n`;
                    }
                    if (index !== undefined) {
                        response += `- **Index:** \`${index}\`\n`;
                    }
                    response += `- **Include untracked:** ${include_untracked ? 'yes' : 'no'}\n`;
                    response += `- **Keep index:** ${keep_index ? 'yes' : 'no'}\n\n`;
                    response += 'Run again without `dry_run` to perform stash action.';

                    return {
                        content: [{ type: 'text', text: response }]
                    };
                }

                const stashOutput = gitService.stash({
                    action,
                    message,
                    index,
                    includeUntracked: include_untracked,
                    keepIndex: keep_index
                });

                let response = '# ✅ Git Stash Action Completed\n\n';
                response += `- **Repository:** \`${gitService.getWorkingDirectory()}\`\n`;
                response += `- **Current Branch:** \`${currentBranch}\`\n`;
                response += `- **Action:** \`${action}\`\n`;
                if (message) {
                    response += `- **Message:** \`${message}\`\n`;
                }
                if (index !== undefined) {
                    response += `- **Index:** \`${index}\`\n`;
                }
                response += `- **Include untracked:** ${include_untracked ? 'yes' : 'no'}\n`;
                response += `- **Keep index:** ${keep_index ? 'yes' : 'no'}\n\n`;
                response += '## git stash output\n\n';
                response += `\`\`\`\n${stashOutput.trim() || 'Stash action completed successfully.'}\n\`\`\`\n`;

                return {
                    content: [{ type: 'text', text: response }]
                };

            } catch (error: any) {
                throw new McpError(
                    ErrorCode.InternalError,
                    `Failed to perform stash action: ${error.message}`
                );
            }
        }
    },
    {
        name: 'git_tag',
        description: 'Create, list, or delete tags.',
        inputSchema: {
            type: 'object',
            properties: {
                working_directory: {
                    type: 'string',
                    description: 'Absolute path to the git repository. If not provided, searches for git repo starting from current directory.'
                },
                action: {
                    type: 'string',
                    enum: ['create', 'list', 'delete'],
                    description: 'Tag action to perform (default: "list")'
                },
                name: {
                    type: 'string',
                    description: 'Tag name (required for "create" and "delete" actions)'
                },
                commit: {
                    type: 'string',
                    description: 'Commit to tag (only for "create" action, default: HEAD)'
                },
                message: {
                    type: 'string',
                    description: 'Tag message (only for "create" action, creates an annotated tag)'
                },
                force: {
                    type: 'boolean',
                    description: 'Force tag creation or deletion (only for "create" and "delete" actions) (default: false)'
                },
                pattern: {
                    type: 'string',
                    description: 'Pattern to filter tags (only for "list" action)'
                },
                dry_run: {
                    type: 'boolean',
                    description: 'Show what would be done without actually doing it (default: false)'
                }
            },
            additionalProperties: false
        },
        func: async (args: any) => {
            const {
                working_directory,
                action = 'list',
                name,
                commit,
                message,
                force = false,
                pattern,
                dry_run = false
            } = args;

            try {
                const gitService = new GitService(working_directory);
                const currentBranch = gitService.getCurrentBranchName();

                if (dry_run) {
                    let response = '# 🧪 Dry Run: git tag\n\n';
                    response += `- **Repository:** \`${gitService.getWorkingDirectory()}\`\n`;
                    response += `- **Current Branch:** \`${currentBranch}\`\n`;
                    response += `- **Action:** \`${action}\`\n`;
                    if (name) {
                        response += `- **Tag name:** \`${name}\`\n`;
                    }
                    if (commit) {
                        response += `- **Commit:** \`${commit}\`\n`;
                    }
                    if (message) {
                        response += `- **Message:** \`${message}\`\n`;
                    }
                    response += `- **Force:** ${force ? 'yes' : 'no'}\n`;
                    if (pattern) {
                        response += `- **Pattern:** \`${pattern}\`\n`;
                    }
                    response += '\nRun again without `dry_run` to perform tag action.';

                    return {
                        content: [{ type: 'text', text: response }]
                    };
                }

                const tagOutput = gitService.tag({
                    action,
                    name,
                    commit,
                    message,
                    force,
                    pattern
                });

                let response = '# ✅ Git Tag Action Completed\n\n';
                response += `- **Repository:** \`${gitService.getWorkingDirectory()}\`\n`;
                response += `- **Current Branch:** \`${currentBranch}\`\n`;
                response += `- **Action:** \`${action}\`\n`;
                if (name) {
                    response += `- **Tag name:** \`${name}\`\n`;
                }
                if (commit) {
                    response += `- **Commit:** \`${commit}\`\n`;
                }
                if (message) {
                    response += `- **Message:** \`${message}\`\n`;
                }
                response += `- **Force:** ${force ? 'yes' : 'no'}\n`;
                if (pattern) {
                    response += `- **Pattern:** \`${pattern}\`\n`;
                }
                response += '\n## git tag output\n\n';
                response += `\`\`\`\n${tagOutput.trim() || 'Tag action completed successfully.'}\n\`\`\`\n`;

                return {
                    content: [{ type: 'text', text: response }]
                };

            } catch (error: any) {
                throw new McpError(
                    ErrorCode.InternalError,
                    `Failed to perform tag action: ${error.message}`
                );
            }
        }
    },
    {
        name: 'git_remote',
        description: 'Manage remote repositories.',
        inputSchema: {
            type: 'object',
            properties: {
                working_directory: {
                    type: 'string',
                    description: 'Absolute path to the git repository. If not provided, searches for git repo starting from current directory.'
                },
                action: {
                    type: 'string',
                    enum: ['add', 'rename', 'remove', 'list', 'set_url', 'prune'],
                    description: 'Remote action to perform (default: "list")'
                },
                name: {
                    type: 'string',
                    description: 'Remote name (required for "add", "rename", "remove", "set_url", and "prune" actions)'
                },
                url: {
                    type: 'string',
                    description: 'Remote URL (required for "add" and "set_url" actions)'
                },
                new_name: {
                    type: 'string',
                    description: 'New remote name (only for "rename" action)'
                },
                dry_run: {
                    type: 'boolean',
                    description: 'Show what would be done without actually doing it (default: false)'
                }
            },
            additionalProperties: false
        },
        func: async (args: any) => {
            const {
                working_directory,
                action = 'list',
                name,
                url,
                new_name,
                dry_run = false
            } = args;

            try {
                const gitService = new GitService(working_directory);
                const currentBranch = gitService.getCurrentBranchName();

                if (dry_run) {
                    let response = '# 🧪 Dry Run: git remote\n\n';
                    response += `- **Repository:** \`${gitService.getWorkingDirectory()}\`\n`;
                    response += `- **Current Branch:** \`${currentBranch}\`\n`;
                    response += `- **Action:** \`${action}\`\n`;
                    if (name) {
                        response += `- **Remote name:** \`${name}\`\n`;
                    }
                    if (url) {
                        response += `- **URL:** \`${url}\`\n`;
                    }
                    if (new_name) {
                        response += `- **New name:** \`${new_name}\`\n`;
                    }
                    response += '\nRun again without `dry_run` to perform remote action.';

                    return {
                        content: [{ type: 'text', text: response }]
                    };
                }

                const remoteOutput = gitService.remote({
                    action,
                    name,
                    url,
                    newName: new_name
                });

                let response = '# ✅ Git Remote Action Completed\n\n';
                response += `- **Repository:** \`${gitService.getWorkingDirectory()}\`\n`;
                response += `- **Current Branch:** \`${currentBranch}\`\n`;
                response += `- **Action:** \`${action}\`\n`;
                if (name) {
                    response += `- **Remote name:** \`${name}\`\n`;
                }
                if (url) {
                    response += `- **URL:** \`${url}\`\n`;
                }
                if (new_name) {
                    response += `- **New name:** \`${new_name}\`\n`;
                }
                response += '\n## git remote output\n\n';
                response += `\`\`\`\n${remoteOutput.trim() || 'Remote action completed successfully.'}\n\`\`\`\n`;

                return {
                    content: [{ type: 'text', text: response }]
                };

            } catch (error: any) {
                throw new McpError(
                    ErrorCode.InternalError,
                    `Failed to perform remote action: ${error.message}`
                );
            }
        }
    }
];

export function getGitCommitToolHandlers(memoryManager: MemoryManager) {
    const handlers: { [key: string]: Function } = {};

    for (const toolDef of gitCommitToolDefinitions) {
        if (toolDef.func) {
            handlers[toolDef.name] = async (args: any) => {
                return toolDef.func!(args, memoryManager);
            };
        }
    }

    return handlers;
}
