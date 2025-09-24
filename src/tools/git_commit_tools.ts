// src/tools/git_commit_tools.ts
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { MemoryManager } from '../database/memory_manager.js';
import { GitService, GitContext, GitChange } from '../utils/GitService.js';
import { CommitMessageAI, CommitMessageOptions } from '../utils/CommitMessageAI.js';
import { InternalToolDefinition } from './index.js';
import * as path from 'path';

type ContextLabel = 'Staged' | 'Unstaged';

interface ContextSection {
    label: ContextLabel;
    context: GitContext;
}

function bucketChanges(sections: ContextSection[]): { staged: GitChange[]; unstaged: GitChange[] } {
    const deduped = new Map<string, GitChange>();

    for (const section of sections) {
        for (const change of section.context.changes) {
            const key = `${change.changeType}:${change.filePath}`;
            if (!deduped.has(key)) {
                deduped.set(key, change);
            }
        }
    }

    const all = Array.from(deduped.values());
    return {
        staged: all.filter(change => change.changeType === 'staged'),
        unstaged: all.filter(change => change.changeType === 'unstaged')
    };
}

async function collectContextSections(gitService: GitService, includeStaged: boolean, includeUnstaged: boolean): Promise<ContextSection[]> {
    const sections: ContextSection[] = [];

    if (includeStaged) {
        const stagedContext = await gitService.getCommitContext(true);
        if (stagedContext.changes.length > 0) {
            const hasStaged = stagedContext.changes.some(change => change.changeType === 'staged');
            sections.push({
                label: hasStaged ? 'Staged' : 'Unstaged',
                context: stagedContext
            });
        }
    }

    if (includeUnstaged) {
        const unstagedContext = await gitService.getCommitContext(false);
        const hasUnstaged = unstagedContext.changes.some(change => change.changeType === 'unstaged');
        const alreadyIncludedUnstaged = sections.some(section => section.label === 'Unstaged');

        if (hasUnstaged && !alreadyIncludedUnstaged) {
            sections.push({
                label: 'Unstaged',
                context: unstagedContext
            });
        }
    }

    return sections;
}

function buildCombinedContextForAI(gitService: GitService, sections: ContextSection[]): string {
    const header = '## Git Context for Commit Message Generation';

    return sections.map(section => {
        const formatted = gitService.formatContextForAI(section.context);

        if (sections.length > 1 && formatted.includes(header)) {
            return formatted.replace(header, `## ${section.label} Changes`);
        }

        return formatted;
    }).join('\n\n');
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
