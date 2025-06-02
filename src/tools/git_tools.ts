import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import simpleGit, { SimpleGit, StatusResult, LogResult } from 'simple-git';
import { formatSimpleMessage, formatJsonToMarkdownCodeBlock } from '../utils/formatters.js';

// Helper to initialize simple-git for a directory
const gitP = (dir: string): SimpleGit => (simpleGit as any)({ baseDir: dir });

export const gitToolDefinitions = [
    {
        name: 'git_clone',
        description: 'Clones a repository into a new directory. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                dir: { type: 'string', description: 'The local directory path to clone into.' },
                url: { type: 'string', description: 'The URL of the repository to clone.' },
            },
            required: ['dir', 'url'],
        },
    },
    {
        name: 'git_pull',
        description: 'Fetches from and integrates with another repository or a local branch. Assumes Git is configured with user details for commits if a merge commit is needed. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                dir: { type: 'string', description: 'The repository directory.' },
                remote: { type: 'string', description: 'Optional: The remote to pull from (e.g., "origin"). Defaults to origin.', default: 'origin' },
                branch: { type: ['string', 'null'], description: 'Optional: The branch to pull. Defaults to the current branch.' },
            },
            required: ['dir'],
        },
    },
    {
        name: 'git_push',
        description: 'Updates remote refs along with associated objects. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                dir: { type: 'string', description: 'The repository directory.' },
                remote: { type: 'string', description: 'Optional: The remote to push to (e.g., "origin"). Defaults to origin.', default: 'origin' },
                branch: { type: ['string', 'null'], description: 'Optional: The branch to push. Defaults to the current branch.' },
            },
            required: ['dir'],
        },
    },
    {
        name: 'git_commit',
        description: 'Records changes to the repository. Ensure files are staged using git_add first. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                dir: { type: 'string', description: 'The repository directory.' },
                message: { type: 'string', description: 'The commit message.' },
                authorName: { type: ['string', 'null'], description: 'Optional: The name of the commit author. Uses Git config if not provided.' },
                authorEmail: { type: ['string', 'null'], description: 'Optional: The email of the commit author. Uses Git config if not provided.' },
            },
            required: ['dir', 'message'],
        },
    },
    {
        name: 'git_status',
        description: 'Shows the working tree status. Returns a summary of changes as Markdown.',
        inputSchema: {
            type: 'object',
            properties: {
                dir: { type: 'string', description: 'The repository directory.' },
            },
            required: ['dir'],
        },
    },
    {
        name: 'git_add',
        description: 'Add file contents to the index (staging area). Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                dir: { type: 'string', description: 'The repository directory.' },
                filepath: { type: 'string', description: 'The file path(s) to add (e.g., "src/file.ts" or "." for all changes).' },
            },
            required: ['dir', 'filepath'],
        },
    },
    {
        name: 'git_branch_create',
        description: 'Create a new branch. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                dir: { type: 'string', description: 'The repository directory.' },
                branchName: { type: 'string', description: 'The name of the new branch.' },
                checkout: { type: 'boolean', description: 'Optional: Checkout the new branch after creation. Defaults to false.', default: false },
            },
            required: ['dir', 'branchName'],
        },
    },
    {
        name: 'git_branch_list',
        description: 'Lists all local and remote branches. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                dir: { type: 'string', description: 'The repository directory.' },
            },
            required: ['dir'],
        },
    },
    {
        name: 'git_checkout',
        description: 'Switch branches or restore working tree files. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                dir: { type: 'string', description: 'The repository directory.' },
                ref: { type: 'string', description: 'The branch name or commit hash to checkout.' },
            },
            required: ['dir', 'ref'],
        },
    },
    {
        name: 'git_log',
        description: 'Show commit logs. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                dir: { type: 'string', description: 'The repository directory.' },
                maxCount: { type: ['number', 'null'], description: 'Optional: Limit the number of commits to show.' },
            },
            required: ['dir'],
        },
    },
    {
        name: 'git_diff',
        description: 'Show changes between commits, commit and working tree, etc. Output is in Markdown diff format.',
        inputSchema: {
            type: 'object',
            properties: {
                dir: { type: 'string', description: 'The repository directory.' },
                ref1: { type: ['string', 'null'], description: 'Optional: The first commit or branch for comparison.' },
                ref2: { type: ['string', 'null'], description: 'Optional: The second commit or branch for comparison. If only ref1 is provided, compares ref1 with the working tree.' },
                filepath: { type: ['string', 'null'], description: 'Optional: A specific file path to diff. If omitted, shows all changes.' },
            },
            required: ['dir'],
        },
    },
    {
        name: 'git_stash_save',
        description: 'Stashes changes in a dirty working directory. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                dir: { type: 'string', description: 'The repository directory.' },
                message: { type: ['string', 'null'], description: 'Optional: The message to use when stashing.' },
            },
            required: ['dir'],
        },
    },
    {
        name: 'git_stash_pop',
        description: 'Pops the most recently created stash. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                dir: { type: 'string', description: 'The repository directory.' },
            },
            required: ['dir'],
        },
    },
    {
        name: 'git_remote_add',
        description: 'Adds a new remote. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                dir: { type: 'string', description: 'The repository directory.' },
                name: { type: 'string', description: 'The name of the remote.' },
                url: { type: 'string', description: 'The URL of the remote.' },
            },
            required: ['dir', 'name', 'url'],
        },
    },
    {
        name: 'git_remote_remove',
        description: 'Removes a remote. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                dir: { type: 'string', description: 'The repository directory.' },
                name: { type: 'string', description: 'The name of the remote to remove.' },
            },
            required: ['dir', 'name'],
        },
    },
    {
        name: 'git_reset_soft',
        description: 'Resets the current HEAD to the specified state, keeping changes in the working directory and staging area. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                dir: { type: 'string', description: 'The repository directory.' },
                ref: { type: 'string', description: 'The commit hash or reference to reset to (e.g., "HEAD~1" for the previous commit).' },
            },
            required: ['dir', 'ref'],
        },
    },
    {
        name: 'git_revert',
        description: 'Reverts existing commits by creating new commits that undo the changes. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                dir: { type: 'string', description: 'The repository directory.' },
                commit: { type: 'string', description: 'The commit hash to revert.' },
                noCommit: { type: 'boolean', description: 'Optional: Do not automatically commit. Defaults to false.', default: false },
            },
            required: ['dir', 'commit'],
        },
    },
    {
        name: 'git_tag',
        description: 'Creates, lists, deletes or verifies a tag object signed with GPG. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                dir: { type: 'string', description: 'The repository directory.' },
                name: { type: 'string', description: 'The name of the tag to create or delete.' },
                commit: { type: ['string', 'null'], description: 'Optional: The commit hash to tag. Defaults to HEAD.' },
                delete: { type: 'boolean', description: 'Optional: Delete the tag. Defaults to false.', default: false },
                list: { type: 'boolean', description: 'Optional: List tags. Defaults to false.', default: false },
            },
            required: ['dir'],
        },
    },
    {
        name: 'git_merge',
        description: 'Joins two or more development histories together. Output is Markdown formatted.',
        inputSchema: {
            type: 'object',
            properties: {
                dir: { type: 'string', description: 'The repository directory.' },
                branch: { type: 'string', description: 'The name of the branch to merge into the current branch.' },
                noFf: { type: 'boolean', description: 'Optional: Do not create a fast-forward merge. Defaults to false.', default: false },
                squash: { type: 'boolean', description: 'Optional: Produce the working tree file and index state as if a real merge happened, but do not actually make a commit. Defaults to false.', default: false },
            },
            required: ['dir', 'branch'],
        },
    },
];

export function getGitToolHandlers() {
    return {
        git_clone: async (args: { dir: string; url: string }) => {
            try {
                await (simpleGit as any)().clone(args.url, args.dir);
                return { content: [{ type: 'text', text: formatSimpleMessage(`Repository cloned from \`${args.url}\` to \`${args.dir}\``, "Git Clone") }] };
            } catch (error: any) {
                throw new McpError(ErrorCode.InternalError, `Git clone failed: ${error.message}`);
            }
        },
        git_pull: async (args: { dir: string; remote?: string; branch?: string }) => {
            try {
                const git = gitP(args.dir);
                const pullSummary = await git.pull(args.remote, args.branch);
                let md = `## Git Pull Summary for \`${args.dir}\`\n`;
                md += `- **Remote:** ${args.remote || 'origin'}\n`;
                if (args.branch) md += `- **Branch:** ${args.branch}\n`;
                md += `- **Files Changed:** ${pullSummary.files.length}\n`;
                if (pullSummary.summary.changes) md += `- **Changes:** ${pullSummary.summary.changes}\n`;
                if (pullSummary.summary.insertions) md += `- **Insertions:** ${pullSummary.summary.insertions}\n`;
                if (pullSummary.summary.deletions) md += `- **Deletions:** ${pullSummary.summary.deletions}\n`;
                if (pullSummary.files.length > 0) {
                    md += `**Changed Files:**\n${formatJsonToMarkdownCodeBlock(pullSummary.files)}\n`;
                }
                return { content: [{ type: 'text', text: md }] };
            } catch (error: any) {
                throw new McpError(ErrorCode.InternalError, `Git pull failed: ${error.message}`);
            }
        },
        git_push: async (args: { dir: string; remote?: string; branch?: string }) => {
            try {
                const git = gitP(args.dir);
                // simple-git push doesn't return a detailed summary directly, it's more for chaining.
                // We'll report success or failure.
                await git.push(args.remote || 'origin', args.branch);
                return { content: [{ type: 'text', text: formatSimpleMessage(`Push successful to \`${args.remote || 'origin'}\`${args.branch ? '/' + args.branch : ''}`, "Git Push") }] };
            } catch (error: any) {
                throw new McpError(ErrorCode.InternalError, `Git push failed: ${error.message}`);
            }
        },
        git_commit: async (args: { dir: string; message: string; authorName?: string; authorEmail?: string }) => {
            try {
                const git = gitP(args.dir);
                const options: { [key: string]: string } = {};
                if (args.authorName && args.authorEmail) {
                    options['--author'] = `"${args.authorName} <${args.authorEmail}>"`;
                }
                const commitSummary = await git.commit(args.message, undefined, options);
                let md = `## Git Commit Successful in \`${args.dir}\`\n`;
                md += `- **Commit SHA:** \`${commitSummary.commit}\`\n`;
                md += `- **Branch:** ${commitSummary.branch}\n`;
                md += `- **Author:** ${commitSummary.author ? `${commitSummary.author.name} <${commitSummary.author.email}>` : 'N/A'}\n`;
                md += `- **Summary:** ${commitSummary.summary.changes} changes, ${commitSummary.summary.insertions} insertions, ${commitSummary.summary.deletions} deletions\n`;
                return { content: [{ type: 'text', text: md }] };
            } catch (error: any) {
                throw new McpError(ErrorCode.InternalError, `Git commit failed: ${error.message}`);
            }
        },
        git_status: async (args: { dir: string }) => {
            try {
                const statusSummary: StatusResult = await gitP(args.dir).status();
                let md = `## Git Status for \`${args.dir}\`\n`;
                md += `- **Current Branch:** ${statusSummary.current || 'Detached HEAD'}\n`;
                md += `- **Tracking Branch:** ${statusSummary.tracking || 'N/A'}\n`;
                md += `- **Ahead:** ${statusSummary.ahead}\n`;
                md += `- **Behind:** ${statusSummary.behind}\n`;
                if (statusSummary.files.length === 0) {
                    md += "\n*Working tree clean.*\n";
                } else {
                    md += "\n**File Changes:**\n";
                    md += "| Path | Index Status | Working Dir Status |\n";
                    md += "|------|--------------|--------------------|\n";
                    statusSummary.files.forEach(file => {
                        md += `| \`${file.path}\` | ${file.index} | ${file.working_dir} |\n`;
                    });
                }
                if (statusSummary.conflicted.length > 0) {
                    md += `\n**Conflicted Files:**\n${statusSummary.conflicted.map(f => `- \`${f}\``).join('\n')}\n`;
                }
                return { content: [{ type: 'text', text: md }] };
            } catch (error: any) {
                throw new McpError(ErrorCode.InternalError, `Git status failed: ${error.message}`);
            }
        },
        git_add: async (args: { dir: string; filepath: string }) => {
            try {
                await gitP(args.dir).add(args.filepath);
                return { content: [{ type: 'text', text: formatSimpleMessage(`File(s) \`${args.filepath}\` added to staging area in \`${args.dir}\``, "Git Add") }] };
            } catch (error: any) {
                throw new McpError(ErrorCode.InternalError, `Git add failed: ${error.message}`);
            }
        },
        git_branch_create: async (args: { dir: string; branchName: string, checkout?: boolean }) => {
            try {
                const git = gitP(args.dir);
                if (args.checkout) {
                    await git.checkoutLocalBranch(args.branchName);
                } else {
                    await git.branch([args.branchName]); // Create branch without checkout
                }
                return { content: [{ type: 'text', text: formatSimpleMessage(`Branch \`${args.branchName}\` created ${args.checkout ? 'and checked out' : ''} in \`${args.dir}\``, "Git Branch Create") }] };
            } catch (error: any) {
                throw new McpError(ErrorCode.InternalError, `Git branch creation failed: ${error.message}`);
            }
        },
        git_branch_list: async (args: { dir: string }) => {
            try {
                const branchSummary = await gitP(args.dir).branch();
                let md = `## Git Branches in \`${args.dir}\`\n`;
                md += `- **Current Branch:** \`${branchSummary.current}\`\n`;
                md += "**All Branches:**\n";
                Object.entries(branchSummary.branches).forEach(([name, details]) => {
                    md += `- \`${name}\` (Commit: \`${details.commit}\`, Label: ${details.label})\n`;
                });
                return { content: [{ type: 'text', text: md }] };
            } catch (error: any) {
                throw new McpError(ErrorCode.InternalError, `Git branch list failed: ${error.message}`);
            }
        },
        git_checkout: async (args: { dir: string; ref: string }) => {
            try {
                await gitP(args.dir).checkout(args.ref);
                return { content: [{ type: 'text', text: formatSimpleMessage(`Checked out to \`${args.ref}\` in \`${args.dir}\``, "Git Checkout") }] };
            } catch (error: any) {
                throw new McpError(ErrorCode.InternalError, `Git checkout failed: ${error.message}`);
            }
        },
        git_log: async (args: { dir: string; maxCount?: number }) => {
            try {
                const options: { [key: string]: any } = {};
                if (args.maxCount) {
                    options['--max-count'] = args.maxCount;
                }
                const log: LogResult = await gitP(args.dir).log(options);
                let md = `## Git Log for \`${args.dir}\`\n`;
                if (log.latest) {
                     md += `**Latest Commit:** \`${log.latest.hash}\` - ${log.latest.message}\n\n`;
                }
                md += `**Total Commits (in selection):** ${log.total}\n\n`;
                log.all.forEach(commit => {
                    md += `### Commit: \`${commit.hash.substring(0, 7)}\`\n`;
                    md += `- **Author:** ${commit.author_name} <${commit.author_email}>\n`;
                    md += `- **Date:** ${commit.date}\n`;
                    md += `- **Message:** ${commit.message}\n`;
                    if (commit.refs) md += `- **Refs:** ${commit.refs}\n`;
                    md += "\n---\n";
                });
                return { content: [{ type: 'text', text: md }] };
            } catch (error: any) {
                throw new McpError(ErrorCode.InternalError, `Git log failed: ${error.message}`);
            }
        },
        git_diff: async (args: { dir: string; ref1?: string; ref2?: string; filepath?: string }) => {
            try {
                const git = gitP(args.dir);
                const diffOptions: string[] = [];
                if (args.ref1) diffOptions.push(args.ref1);
                if (args.ref2) diffOptions.push(args.ref2);
                if (args.filepath) {
                    diffOptions.push('--'); // Separator for filepath
                    diffOptions.push(args.filepath);
                }
                const diffSummary = await git.diff(diffOptions);
                const markdownDiff = `## Git Diff for \`${args.dir}\`\n`;
                const title = `Diff ${args.ref1 ? `from \`${args.ref1}\`` : ''} ${args.ref2 ? `to \`${args.ref2}\`` : ''} ${args.filepath ? `for file \`${args.filepath}\`` : ''}`;
                return { content: [{ type: 'text', text: `${title}\n\n${formatJsonToMarkdownCodeBlock(diffSummary, 'diff')}` }] };
            } catch (error: any) {
                throw new McpError(ErrorCode.InternalError, `Git diff failed: ${error.message}`);
            }
        },
        git_stash_save: async (args: { dir: string; message?: string }) => {
            try {
                const git = gitP(args.dir);
                await git.stash(['save', args.message || '']);
                return { content: [{ type: 'text', text: formatSimpleMessage(`Stashed changes in \`${args.dir}\`${args.message ? ` with message: ${args.message}` : ''}`, "Git Stash Save") }] };
            } catch (error: any) {
                throw new McpError(ErrorCode.InternalError, `Git stash save failed: ${error.message}`);
            }
        },
        git_stash_pop: async (args: { dir: string }) => {
            try {
                const git = gitP(args.dir);
                await git.stash(['pop']);
                return { content: [{ type: 'text', text: formatSimpleMessage(`Popped the most recent stash in \`${args.dir}\``, "Git Stash Pop") }] };
            } catch (error: any) {
                throw new McpError(ErrorCode.InternalError, `Git stash pop failed: ${error.message}`);
            }
        },
        git_remote_add: async (args: { dir: string; name: string; url: string }) => {
            try {
                const git = gitP(args.dir);
                await git.remote(['add', args.name, args.url]);
                return { content: [{ type: 'text', text: formatSimpleMessage(`Added remote \`${args.name}\` with URL \`${args.url}\` in \`${args.dir}\``, "Git Remote Add") }] };
            } catch (error: any) {
                throw new McpError(ErrorCode.InternalError, `Git remote add failed: ${error.message}`);
            }
        },
        git_remote_remove: async (args: { dir: string; name: string }) => {
            try {
                const git = gitP(args.dir);
                await git.remote(['remove', args.name]);
                return { content: [{ type: 'text', text: formatSimpleMessage(`Removed remote \`${args.name}\` in \`${args.dir}\``, "Git Remote Remove") }] };
            } catch (error: any) {
                throw new McpError(ErrorCode.InternalError, `Git remote remove failed: ${error.message}`);
            }
        },
        git_reset_soft: async (args: { dir: string; ref: string }) => {
            try {
                const git = gitP(args.dir);
                await git.reset(['--soft', args.ref]);
                return { content: [{ type: 'text', text: formatSimpleMessage(`Successfully reset HEAD to \`${args.ref}\` (soft reset) in \`${args.dir}\``, "Git Reset Soft") }] };
            } catch (error: any) {
                throw new McpError(ErrorCode.InternalError, `Git soft reset failed: ${error.message}`);
            }
        },
        git_revert: async (args: { dir: string; commit: string; noCommit?: boolean }) => {
            try {
                const git = gitP(args.dir);
                const options = args.noCommit ? ['--no-commit'] : [];
                await git.revert(args.commit, options);
                return { content: [{ type: 'text', text: formatSimpleMessage(`Successfully reverted commit \`${args.commit}\` in \`${args.dir}\``, "Git Revert") }] };
            } catch (error: any) {
                throw new McpError(ErrorCode.InternalError, `Git revert failed: ${error.message}`);
            }
        },
        git_tag: async (args: { dir: string; name: string; commit?: string; delete?: boolean; list?: boolean }) => {
            try {
                const git = gitP(args.dir);
                if (args.list) {
                    const tags = await git.tags();
                    let md = `## Git Tags in \`${args.dir}\`\n`;
                    if (tags.all.length === 0) {
                        md += "*No tags found.*\n";
                    } else {
                        md += "**All Tags:**\n";
                        tags.all.forEach(tag => {
                            md += `- \`${tag}\`\n`;
                        });
                    }
                    return { content: [{ type: 'text', text: md }] };
                } else if (args.delete) {
                    await git.tag(['-d', args.name]);
                    return { content: [{ type: 'text', text: formatSimpleMessage(`Successfully deleted tag \`${args.name}\` in \`${args.dir}\``, "Git Tag Delete") }] };
                } else {
                    const tagArgs = [args.name];
                    if (args.commit) {
                        tagArgs.push(args.commit);
                    }
                    await git.tag(tagArgs);
                    return { content: [{ type: 'text', text: formatSimpleMessage(`Successfully created tag \`${args.name}\` in \`${args.dir}\``, "Git Tag Create") }] };
                }
            } catch (error: any) {
                throw new McpError(ErrorCode.InternalError, `Git tag failed: ${error.message}`);
            }
        },
        git_merge: async (args: { dir: string; branch: string; noFf?: boolean; squash?: boolean }) => {
            try {
                const git = gitP(args.dir);
                const options: string[] = [];
                if (args.noFf) options.push('--no-ff');
                if (args.squash) options.push('--squash');

                const mergeSummary = await git.merge([args.branch, ...options]);
                let md = `## Git Merge Summary for \`${args.dir}\`\n`;
                md += `- **Merged Branch:** ${args.branch}\n`;
                md += `- **Result:** ${mergeSummary.result}\n`;
                if (mergeSummary.summary.changes) md += `- **Changes:** ${mergeSummary.summary.changes}\n`;
                if (mergeSummary.summary.insertions) md += `- **Insertions:** ${mergeSummary.summary.insertions}\n`;
                if (mergeSummary.summary.deletions) md += `- **Deletions:** ${mergeSummary.summary.deletions}\n`;
                if (mergeSummary.files.length > 0) {
                    md += `**Changed Files:**\n${formatJsonToMarkdownCodeBlock(mergeSummary.files)}\n`;
                }
                return { content: [{ type: 'text', text: md }] };
            } catch (error: any) {
                throw new McpError(ErrorCode.InternalError, `Git merge failed: ${error.message}`);
            }
        },
    };
}
