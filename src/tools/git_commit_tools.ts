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
