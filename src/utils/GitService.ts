// src/utils/GitService.ts
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export interface GitChange {
    filePath: string;
    status: string;
    changeType: 'staged' | 'unstaged';
}

export interface GitContext {
    changes: GitChange[];
    diff: string;
    summary: string;
    currentBranch: string;
    recentCommits: string;
    workingDirectory: string;
}

export class GitService {
    private workingDirectory: string;

    constructor(workingDirectory?: string) {
        this.workingDirectory = this.resolveWorkingDirectory(workingDirectory);
        this.validateGitRepository();
    }

    private resolveWorkingDirectory(providedPath?: string): string {
        if (providedPath) {
            // If an absolute path is provided, use it directly
            if (path.isAbsolute(providedPath)) {
                return providedPath;
            }
            // If a relative path is provided, resolve it from cwd
            return path.resolve(process.cwd(), providedPath);
        }

        // If no path provided, try to find the git repository
        // Start from current directory and walk up to find .git folder
        let currentDir = process.cwd();

        while (currentDir !== path.dirname(currentDir)) { // Not at filesystem root
            try {
                const gitDir = path.join(currentDir, '.git');
                if (fs.existsSync(gitDir)) {
                    return currentDir;
                }
            } catch (error) {
                // Continue searching
            }
            currentDir = path.dirname(currentDir);
        }

        // Fallback to current working directory if no git repo found
        return process.cwd();
    }

    private validateGitRepository(): void {
        try {
            execSync('git rev-parse --git-dir', {
                cwd: this.workingDirectory,
                stdio: 'pipe'
            });
        } catch (error) {
            throw new Error(`Not a git repository: ${this.workingDirectory}`);
        }
    }

    private executeGitCommand(args: string[]): string {
        try {
            return execSync(`git ${args.join(' ')}`, {
                cwd: this.workingDirectory,
                encoding: 'utf8',
                stdio: 'pipe'
            });
        } catch (error: any) {
            throw new Error(`Git command failed: git ${args.join(' ')}\n${error.message}`);
        }
    }

    public async gatherStagedChanges(): Promise<GitChange[]> {
        return this.gatherChanges(true);
    }

    public async gatherUnstagedChanges(): Promise<GitChange[]> {
        return this.gatherChanges(false);
    }

    private gatherChanges(staged: boolean): GitChange[] {
        try {
            const changes: GitChange[] = [];

            if (staged) {
                // For staged changes, use diff --cached
                const args = ['diff', '--name-status', '--cached'];
                const statusOutput = this.executeGitCommand(args);

                if (statusOutput.trim()) {
                    const lines = statusOutput.split('\n').filter(line => line.trim());
                    for (const line of lines) {
                        if (line.length < 2) continue;
                        const statusCode = line.substring(0, 1).trim();
                        const filePath = line.substring(1).trim();

                        changes.push({
                            filePath: path.join(this.workingDirectory, filePath),
                            status: this.getChangeStatusFromCode(statusCode),
                            changeType: 'staged'
                        });
                    }
                }
            } else {
                // For unstaged changes, use git status --porcelain to get both modified and untracked files
                const statusOutput = this.executeGitCommand(['status', '--porcelain']);

                if (statusOutput.trim()) {
                    const lines = statusOutput.split('\n').filter(line => line.trim());
                    for (const line of lines) {
                        if (line.length < 3) continue;

                        // git status --porcelain format: XY filename
                        // X = staged status, Y = unstaged status
                        const stagedStatus = line[0];
                        const unstagedStatus = line[1];
                        const filePath = line.substring(3).trim();

                        // Only include unstaged changes (Y column not empty and not space)
                        if (unstagedStatus !== ' ' && unstagedStatus !== '') {
                            changes.push({
                                filePath: path.join(this.workingDirectory, filePath),
                                status: this.getChangeStatusFromCode(unstagedStatus),
                                changeType: 'unstaged'
                            });
                        }
                    }
                }
            }

            return changes;
        } catch (error) {
            const changeType = staged ? 'staged' : 'unstaged';
            console.error(`Error gathering ${changeType} changes:`, error);
            return [];
        }
    }

    private getChangeStatusFromCode(code: string): string {
        switch (code) {
            case 'M': return 'Modified';
            case 'A': return 'Added';
            case 'D': return 'Deleted';
            case 'R': return 'Renamed';
            case 'C': return 'Copied';
            case 'U': return 'Updated';
            case '?': return 'Untracked';
            default: return 'Unknown';
        }
    }

    private getDiff(staged: boolean): string {
        try {
            let diff = '';

            if (staged) {
                // For staged changes, use standard git diff --cached
                const args = ['diff', '--cached'];
                diff = this.executeGitCommand(args);
            } else {
                // For unstaged changes, combine regular diff with untracked file content
                const regularDiff = this.executeGitCommand(['diff']);
                const untrackedDiff = this.getUntrackedFilesDiff();

                if (regularDiff && untrackedDiff) {
                    diff = regularDiff + '\n' + untrackedDiff;
                } else if (regularDiff) {
                    diff = regularDiff;
                } else if (untrackedDiff) {
                    diff = untrackedDiff;
                }
            }

            return diff;
        } catch (error) {
            console.error(`Error generating diff:`, error);
            return '';
        }
    }

    private getUntrackedFilesDiff(): string {
        try {
            // Get untracked files
            const untrackedFiles = this.executeGitCommand(['ls-files', '--others', '--exclude-standard'])
                .split('\n')
                .filter(line => line.trim().length > 0);

            if (untrackedFiles.length === 0) {
                return '';
            }

            const diffs: string[] = [];

            for (const file of untrackedFiles) {
                try {
                    // Generate a pseudo-diff for untracked files showing their content as all additions
                    const content = fs.readFileSync(path.join(this.workingDirectory, file), 'utf-8');
                    const lines = content.split('\n');

                    let pseudoDiff = `diff --git a/${file} b/${file}\n`;
                    pseudoDiff += `new file mode 100644\n`;
                    pseudoDiff += `index 0000000..${this.generatePseudoHash(content)}\n`;
                    pseudoDiff += `--- /dev/null\n`;
                    pseudoDiff += `+++ b/${file}\n`;
                    pseudoDiff += `@@ -0,0 +1,${lines.length} @@\n`;

                    for (const line of lines) {
                        pseudoDiff += `+${line}\n`;
                    }

                    diffs.push(pseudoDiff);
                } catch (fileError) {
                    // Skip files that can't be read (binary files, permission issues, etc.)
                    console.warn(`Could not read untracked file ${file}:`, fileError);
                }
            }

            return diffs.join('\n');
        } catch (error) {
            console.error('Error generating untracked files diff:', error);
            return '';
        }
    }

    private generatePseudoHash(content: string): string {
        // Generate a simple pseudo-hash for the diff display (not cryptographically secure)
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash).toString(16).padStart(7, '0').substring(0, 7);
    }

    private getSummary(staged: boolean): string {
        try {
            const args = staged ? ['diff', '--cached', '--stat'] : ['diff', '--stat'];
            return this.executeGitCommand(args);
        } catch (error) {
            console.error(`Error generating summary:`, error);
            return '';
        }
    }

    private getCurrentBranch(): string {
        try {
            return this.executeGitCommand(['branch', '--show-current']).trim();
        } catch (error) {
            return 'unknown';
        }
    }

    private getRecentCommits(count: number = 5): string {
        try {
            return this.executeGitCommand(['log', '--oneline', `-${count}`]);
        } catch (error) {
            return '';
        }
    }

    public async getCommitContext(preferStaged: boolean = true): Promise<GitContext> {
        let changes: GitChange[] = [];
        let staged = preferStaged;

        // Try to get staged changes first
        if (preferStaged) {
            changes = this.gatherChanges(true);
            if (changes.length === 0) {
                // Fallback to unstaged changes
                changes = this.gatherChanges(false);
                staged = false;
            }
        } else {
            changes = this.gatherChanges(false);
            staged = false;
        }

        const diff = this.getDiff(staged);
        const summary = this.getSummary(staged);
        const currentBranch = this.getCurrentBranch();
        const recentCommits = this.getRecentCommits();

        return {
            changes,
            diff,
            summary,
            currentBranch,
            recentCommits,
            workingDirectory: this.workingDirectory
        };
    }

    public formatContextForAI(context: GitContext): string {
        const changeType = context.changes.length > 0 ? context.changes[0].changeType : 'staged';

        let formattedContext = "## Git Context for Commit Message Generation\n\n";

        // Add change summary with file analysis
        formattedContext += `### Change Summary\n`;
        formattedContext += `- **Repository:** ${path.basename(context.workingDirectory)}\n`;
        formattedContext += `- **Branch:** ${context.currentBranch}\n`;
        formattedContext += `- **Change Type:** ${changeType}\n`;
        formattedContext += `- **Total Files:** ${context.changes.length}\n\n`;

        // Analyze files by type and purpose
        const fileAnalysis = this.analyzeFileChanges(context.changes);
        if (Object.keys(fileAnalysis).length > 0) {
            formattedContext += `### File Analysis\n`;
            for (const [category, files] of Object.entries(fileAnalysis)) {
                formattedContext += `**${category}:**\n`;
                for (const file of files) {
                    formattedContext += `- \`${path.basename(file.filePath)}\` (${file.status})\n`;
                }
                formattedContext += `\n`;
            }
        }

        // Add full diff - essential for understanding what changed
        if (context.diff) {
            formattedContext += `### Full Diff of ${changeType === 'staged' ? 'Staged' : 'Unstaged'} Changes\n\`\`\`diff\n${context.diff}\n\`\`\`\n\n`;
        } else {
            formattedContext += `### Full Diff of ${changeType === 'staged' ? 'Staged' : 'Unstaged'} Changes\n\`\`\`diff\n(No diff available)\n\`\`\`\n\n`;
        }

        // Add statistical summary
        if (context.summary) {
            formattedContext += "### Statistical Summary\n```\n" + context.summary + "\n```\n\n";
        } else {
            formattedContext += "### Statistical Summary\n```\n(No summary available)\n```\n\n";
        }

        // Add recent commits for context and pattern recognition
        if (context.recentCommits) {
            formattedContext += "### Recent Commit History (for pattern context)\n```\n" + context.recentCommits + "\n```\n\n";
        }

        // Add guidance for commit message generation
        formattedContext += `### Additional Context for Commit Message Generation\n`;
        formattedContext += `Analyze the above changes and consider:\n`;
        formattedContext += `1. **Primary Purpose**: What is the main goal of these changes?\n`;
        formattedContext += `2. **Functional Impact**: How do these changes affect the application?\n`;
        formattedContext += `3. **File Categories**: Are these infrastructure, features, fixes, or tools?\n`;
        formattedContext += `4. **Scope**: What module/component is primarily affected?\n`;
        formattedContext += `5. **Breaking Changes**: Do any changes break existing functionality?\n\n`;

        return formattedContext;
    }

    private analyzeFileChanges(changes: GitChange[]): Record<string, GitChange[]> {
        const analysis: Record<string, GitChange[]> = {};

        for (const change of changes) {
            const filePath = change.filePath;
            const fileName = path.basename(filePath);
            const fileExtension = path.extname(fileName).toLowerCase();
            const relativePath = path.relative(this.workingDirectory, filePath);

            let category = 'Other Files';

            // Categorize by path patterns and file types
            if (relativePath.includes('src/tools/')) {
                category = 'Tool/Service Files';
            } else if (relativePath.includes('src/utils/')) {
                category = 'Utility/Helper Files';
            } else if (relativePath.includes('src/database/') || relativePath.includes('src/services/')) {
                category = 'Database/Service Files';
            } else if (relativePath.includes('src/types/') || fileExtension === '.d.ts') {
                category = 'Type Definition Files';
            } else if (relativePath.includes('test') || relativePath.includes('spec') || fileName.includes('.test.') || fileName.includes('.spec.')) {
                category = 'Test Files';
            } else if (relativePath.startsWith('.github/') || fileName.startsWith('.')) {
                category = 'Configuration/CI Files';
            } else if (['.md', '.txt', '.doc'].includes(fileExtension)) {
                category = 'Documentation Files';
            } else if (['.json', '.yml', '.yaml', '.toml', '.ini'].includes(fileExtension)) {
                category = 'Configuration Files';
            } else if (['.ts', '.js', '.tsx', '.jsx'].includes(fileExtension)) {
                category = 'Source Code Files';
            }

            if (!analysis[category]) {
                analysis[category] = [];
            }
            analysis[category].push(change);
        }

        return analysis;
    }

    public hasUncommittedChanges(): boolean {
        try {
            const stagedChanges = this.gatherChanges(true);
            const unstagedChanges = this.gatherChanges(false);
            return stagedChanges.length > 0 || unstagedChanges.length > 0;
        } catch (error) {
            return false;
        }
    }

    /**
     * Find git repositories in a given directory and its subdirectories
     */
    public static findGitRepositories(searchPath: string = process.cwd(), maxDepth: number = 3): string[] {
        const repositories: string[] = [];

        const searchRecursive = (currentPath: string, depth: number) => {
            if (depth > maxDepth) return;

            try {
                const gitDir = path.join(currentPath, '.git');
                if (fs.existsSync(gitDir)) {
                    repositories.push(currentPath);
                    return; // Don't search nested repos
                }

                // Search subdirectories
                const entries = fs.readdirSync(currentPath, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory() && !entry.name.startsWith('.')) {
                        searchRecursive(path.join(currentPath, entry.name), depth + 1);
                    }
                }
            } catch (error) {
                // Skip directories we can't read
            }
        };

        searchRecursive(searchPath, 0);
        return repositories;
    }

    /**
     * Get the closest git repository from a given path by walking up the directory tree
     */
    public static findClosestGitRepository(startPath: string = process.cwd()): string | null {
        let currentDir = path.resolve(startPath);

        while (currentDir !== path.dirname(currentDir)) { // Not at filesystem root
            try {
                const gitDir = path.join(currentDir, '.git');
                if (fs.existsSync(gitDir)) {
                    return currentDir;
                }
            } catch (error) {
                // Continue searching
            }
            currentDir = path.dirname(currentDir);
        }

        return null;
    }
}