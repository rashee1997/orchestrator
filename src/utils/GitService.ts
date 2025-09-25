import { execSync, execFileSync } from 'child_process';
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

export interface GitCommitSummary {
    hash: string;
    author: string;
    date: string;
    message: string;
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

    private runGitCommand(args: string[], input?: string): string {
        try {
            return execFileSync('git', args, {
                cwd: this.workingDirectory,
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe'],
                input
            });
        } catch (error: any) {
            const stderr = error?.stderr?.toString?.() ?? '';
            const stdout = error?.stdout?.toString?.() ?? '';
            const message = stderr || stdout || error.message || 'Unknown git error';
            throw new Error(`Git command failed: git ${args.join(' ')}\n${message}`);
        }
    }

    private normalizePathForGit(filePath: string): string {
        const trimmed = filePath.trim();
        if (!trimmed) {
            return trimmed;
        }

        if (path.isAbsolute(trimmed)) {
            return path.relative(this.workingDirectory, trimmed);
        }

        return trimmed;
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
                // Use --untracked-files=all so directories aren't collapsed into a single entry
                const statusOutput = this.executeGitCommand([
                    'status',
                    '--porcelain=1',
                    '--untracked-files=all'
                ]);

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

    public getHeadCommit(): string {
        return this.executeGitCommand(['rev-parse', 'HEAD']).trim();
    }

    public getCommitTimestamp(commitRef: string = 'HEAD'): number {
        try {
            const output = this.executeGitCommand(['show', commitRef, '--no-patch', "--format=%ct"]).trim();
            return Number.parseInt(output, 10);
        } catch (error) {
            return Date.now() / 1000;
        }
    }

    public getCommitsBetween(baseRef?: string | null, headRef: string = 'HEAD', maxCount: number = 20): GitCommitSummary[] {
        const format = '%H%x1f%an%x1f%ad%x1f%s%x1e';
        const rangeArg = baseRef ? `${baseRef}..${headRef}` : headRef;
        const args = ['log', '--date=iso-strict', `--max-count=${maxCount}`, `--format=${format}`];
        if (baseRef) {
            args.push(rangeArg);
        } else {
            args.push(headRef);
        }

        try {
            const output = this.executeGitCommand(args).trim();
            if (!output) {
                return [];
            }

            return output.split('\u001e').filter(Boolean).map(line => {
                const [hash, author, date, message] = line.split('\u001f');
                return {
                    hash,
                    author,
                    date,
                    message
                };
            });
        } catch (error) {
            console.warn('Failed to retrieve git commits between refs:', error);
            return [];
        }
    }

    public getDiffBetweenRefs(baseRef: string | null, headRef: string = 'HEAD', files?: string[], unified: number = 3): string {
        const args: string[] = ['diff', `-U${unified}`];
        if (baseRef) {
            args.push(`${baseRef}..${headRef}`);
        } else {
            // Compare commit against its parent when no base provided
            args.push(`${headRef}^..${headRef}`);
        }

        if (files && files.length > 0) {
            args.push('--', ...files.map(file => this.normalizePathForGit(file)));
        }

        try {
            return this.executeGitCommand(args);
        } catch (error) {
            console.warn(`Failed to diff refs ${baseRef ?? headRef + '^'}..${headRef}:`, error);
            return '';
        }
    }

    public getWorkingDirectory(): string {
        return this.workingDirectory;
    }

    public getCurrentBranchName(): string {
        return this.getCurrentBranch();
    }

    public getStatus(verbose: boolean = false): string {
        const args = verbose ? ['status'] : ['status', '--short', '--branch'];
        return this.runGitCommand(args);
    }

    public stageFiles(filePaths?: string[]): string {
        if (!filePaths || filePaths.length === 0) {
            return this.runGitCommand(['add', '--all']);
        }

        const normalized = filePaths
            .map(pathSegment => this.normalizePathForGit(pathSegment))
            .filter(segment => segment.length > 0);

        if (normalized.length === 0) {
            throw new Error('No valid file paths provided to stage.');
        }

        return this.runGitCommand(['add', '--', ...normalized]);
    }

    public unstageFiles(filePaths?: string[]): string {
        if (!filePaths || filePaths.length === 0) {
            return this.runGitCommand(['reset', 'HEAD', '--', '.']);
        }

        const normalized = filePaths
            .map(pathSegment => this.normalizePathForGit(pathSegment))
            .filter(segment => segment.length > 0);

        if (normalized.length === 0) {
            throw new Error('No valid file paths provided to unstage.');
        }

        return this.runGitCommand(['reset', 'HEAD', '--', ...normalized]);
    }

    public listBranches(includeRemote: boolean = false): { current: string | null; branches: Array<{ name: string; isCurrent: boolean; isRemote: boolean }> } {
        const args = ['branch', '--no-color'];
        if (includeRemote) {
            args.push('-a');
        }

        const output = this.runGitCommand(args);
        const lines = output.split('\n').map(line => line.trim()).filter(Boolean);

        const branches = lines.map(line => {
            const isCurrent = line.startsWith('*');
            const name = line.replace(/^\*\s*/, '').replace(/^\s*/, '');
            return {
                name,
                isCurrent,
                isRemote: name.startsWith('remotes/')
            };
        });

        const currentBranch = branches.find(branch => branch.isCurrent)?.name || null;

        return {
            current: currentBranch,
            branches
        };
    }

    public checkoutBranch(branchName: string, options: { create?: boolean; startPoint?: string } = {}): string {
        const trimmedName = branchName.trim();
        if (!trimmedName) {
            throw new Error('Branch name cannot be empty');
        }

        if (options.create) {
            const args = ['checkout', '-b', trimmedName];
            if (options.startPoint) {
                args.push(options.startPoint);
            }
            return this.runGitCommand(args);
        }

        return this.runGitCommand(['checkout', trimmedName]);
    }

    public createBranch(branchName: string, startPoint?: string): string {
        const trimmedName = branchName.trim();
        if (!trimmedName) {
            throw new Error('Branch name cannot be empty');
        }

        const args = ['branch', trimmedName];
        if (startPoint) {
            args.push(startPoint);
        }

        return this.runGitCommand(args);
    }

    public getDiffOutput(options: { staged?: boolean; files?: string[]; stat?: boolean; unified?: number } = {}): string {
        const args: string[] = ['diff'];

        if (options.stat) {
            args.push('--stat');
        }

        if (typeof options.unified === 'number' && !Number.isNaN(options.unified)) {
            args.push(`-U${options.unified}`);
        }

        if (options.staged) {
            args.push('--cached');
        }

        if (options.files && options.files.length > 0) {
            const normalized = options.files
                .map(file => this.normalizePathForGit(file))
                .filter(file => file.length > 0);

            if (normalized.length > 0) {
                args.push('--', ...normalized);
            }
        }

        return this.runGitCommand(args);
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
            const normalizedPath = relativePath.split(path.sep).join('/');
            const segments = normalizedPath.split('/').filter(Boolean);

            let category = this.detectSpecialCategory(segments, fileName, fileExtension);

            if (!category) {
                // Build category dynamically from path segments
                const significantSegments = this.getSignificantSegments(segments);
                category = this.formatCategoryLabel(significantSegments);
            }

            if (!analysis[category]) {
                analysis[category] = [];
            }
            analysis[category].push(change);
        }

        return analysis;
    }

    private detectSpecialCategory(segments: string[], fileName: string, fileExtension: string): string | null {
        const lowerFileName = fileName.toLowerCase();

        const isTest =
            segments.some(segment => /test|spec/i.test(segment)) ||
            lowerFileName.includes('.test.') ||
            lowerFileName.includes('.spec.') ||
            lowerFileName.endsWith('.test') ||
            lowerFileName.endsWith('.spec');
        if (isTest) {
            return 'Test Files';
        }

        if (['.md', '.markdown', '.txt', '.rst', '.doc', '.docx'].includes(fileExtension)) {
            return 'Documentation Files';
        }

        if (['.json', '.yml', '.yaml', '.toml', '.ini', '.env', '.rc'].includes(fileExtension) ||
            segments.some(segment => segment.startsWith('.github') || segment === '.vscode' || segment === 'config')) {
            return 'Configuration Files';
        }

        if (fileExtension === '.d.ts') {
            return 'Type Definition Files';
        }

        if (lowerFileName.startsWith('.')) {
            return 'Dotfiles';
        }

        return null;
    }

    private getSignificantSegments(segments: string[]): string[] {
        if (segments.length === 0) {
            return ['Repository Root'];
        }

        if (segments[0] === 'src') {
            if (segments.length === 1) {
                return ['src'];
            }
            return ['src', segments[1]];
        }

        return segments.slice(0, Math.min(2, segments.length));
    }

    private formatCategoryLabel(segments: string[]): string {
        const formatted = segments
            .map(segment => segment.replace(/[-_]/g, ' '))
            .map(segment => segment.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' '))
            .join(' / ');

        return `${formatted} Files`.trim();
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

    public commitStagedChanges(message: string): string {
        const trimmedMessage = message.trim();
        if (trimmedMessage.length === 0) {
            throw new Error('Commit message cannot be empty');
        }

        try {
            return execFileSync('git', ['commit', '-F', '-'], {
                cwd: this.workingDirectory,
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe'],
                input: trimmedMessage
            });
        } catch (error: any) {
            throw new Error(`Git commit failed: ${error.message || error}`);
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

    public getLog(options: {
        maxCount?: number;
        format?: string;
        branch?: string;
        file?: string;
        author?: string;
        since?: string;
        until?: string;
        grep?: string;
    } = {}): string {
        const args: string[] = ['log'];

        if (options.maxCount) {
            args.push(`-${options.maxCount}`);
        }

        if (options.format) {
            args.push(`--format=${options.format}`);
        }

        if (options.branch) {
            args.push(options.branch);
        }

        if (options.file) {
            args.push('--follow', options.file);
        }

        if (options.author) {
            args.push(`--author=${options.author}`);
        }

        if (options.since) {
            args.push(`--since=${options.since}`);
        }

        if (options.until) {
            args.push(`--until=${options.until}`);
        }

        if (options.grep) {
            args.push(`--grep=${options.grep}`);
        }

        return this.runGitCommand(args);
    }

    public pull(options: {
        remote?: string;
        branch?: string;
        rebase?: boolean;
        prune?: boolean;
    } = {}): string {
        const args: string[] = ['pull'];

        if (options.rebase) {
            args.push('--rebase');
        }

        if (options.prune) {
            args.push('--prune');
        }

        if (options.remote) {
            args.push(options.remote);
        }

        if (options.branch) {
            args.push(options.branch);
        }

        return this.runGitCommand(args);
    }

    public push(options: {
        remote?: string;
        branch?: string;
        force?: boolean;
        forceWithLease?: boolean;
        setUpstream?: boolean;
    } = {}): string {
        const args: string[] = ['push'];

        if (options.force) {
            args.push('--force');
        }

        if (options.forceWithLease) {
            args.push('--force-with-lease');
        }

        if (options.setUpstream) {
            args.push('--set-upstream');
        }

        if (options.remote) {
            args.push(options.remote);
        }

        if (options.branch) {
            args.push(options.branch);
        }

        return this.runGitCommand(args);
    }

    public merge(options: {
        branch: string;
        message?: string;
        noCommit?: boolean;
        noFf?: boolean;
        squash?: boolean;
    }): string {
        const args: string[] = ['merge'];

        if (options.message) {
            args.push('-m', options.message);
        }

        if (options.noCommit) {
            args.push('--no-commit');
        }

        if (options.noFf) {
            args.push('--no-ff');
        }

        if (options.squash) {
            args.push('--squash');
        }

        args.push(options.branch);

        return this.runGitCommand(args);
    }

    public rebase(options: {
        onto: string;
        interactive?: boolean;
        autosquash?: boolean;
        continue?: boolean;
        abort?: boolean;
        skip?: boolean;
    }): string {
        const args: string[] = ['rebase'];

        if (options.interactive) {
            args.push('--interactive');
        }

        if (options.autosquash) {
            args.push('--autosquash');
        }

        if (options.continue) {
            args.push('--continue');
        }

        if (options.abort) {
            args.push('--abort');
        }

        if (options.skip) {
            args.push('--skip');
        }

        args.push(options.onto);

        return this.runGitCommand(args);
    }

    public reset(options: {
        commit?: string;
        mode?: 'soft' | 'mixed' | 'hard' | 'merge' | 'keep';
        paths?: string[];
    } = {}): string {
        const args: string[] = ['reset'];

        if (options.mode) {
            args.push(`--${options.mode}`);
        }

        if (options.commit) {
            args.push(options.commit);
        }

        if (options.paths && options.paths.length > 0) {
            args.push('--');
            args.push(...options.paths);
        }

        return this.runGitCommand(args);
    }

    public revert(options: {
        commits: string[];
        noCommit?: boolean;
        edit?: boolean;
    }): string {
        const args: string[] = ['revert'];

        if (options.noCommit) {
            args.push('--no-commit');
        }

        if (options.edit) {
            args.push('--edit');
        }

        args.push(...options.commits);

        return this.runGitCommand(args);
    }

    public stash(options: {
        action: 'push' | 'pop' | 'apply' | 'list' | 'drop' | 'clear';
        message?: string;
        index?: number;
        includeUntracked?: boolean;
        keepIndex?: boolean;
    }): string {
        const args: string[] = ['stash'];

        if (options.action !== 'list') {
            args.push(options.action);
        }

        if (options.message && options.action === 'push') {
            args.push('-m', options.message);
        }

        if (options.includeUntracked && options.action === 'push') {
            args.push('--include-untracked');
        }

        if (options.keepIndex && options.action === 'push') {
            args.push('--keep-index');
        }

        if (options.index !== undefined && ['pop', 'apply', 'drop'].includes(options.action)) {
            args.push(`stash@{${options.index}}`);
        }

        return this.runGitCommand(args);
    }

    public tag(options: {
        action: 'create' | 'list' | 'delete';
        name?: string;
        commit?: string;
        message?: string;
        force?: boolean;
        pattern?: string;
    }): string {
        const args: string[] = ['tag'];

        if (options.force && ['create', 'delete'].includes(options.action)) {
            args.push('--force');
        }

        if (options.message && options.action === 'create') {
            args.push('-a', '-m', options.message);
        }

        if (options.action === 'list' && options.pattern) {
            args.push('-l', options.pattern);
        }

        if (options.action === 'delete' && options.name) {
            args.push('-d', options.name);
        }

        if (options.action === 'create' && options.name) {
            args.push(options.name);
        }

        if (options.commit && options.action === 'create' && options.name) {
            args.push(options.commit);
        }

        return this.runGitCommand(args);
    }

    public remote(options: {
        action: 'add' | 'rename' | 'remove' | 'list' | 'set_url' | 'prune';
        name?: string;
        url?: string;
        newName?: string;
    }): string {
        const args: string[] = ['remote'];

        args.push(options.action);

        if (options.name && ['add', 'rename', 'remove', 'set_url', 'prune'].includes(options.action)) {
            args.push(options.name);
        }

        if (options.url && ['add', 'set_url'].includes(options.action)) {
            args.push(options.url);
        }

        if (options.newName && options.action === 'rename') {
            args.push(options.newName);
        }

        if (options.action === 'prune' && options.name) {
            args.push('--dry-run');
        }

        return this.runGitCommand(args);
    }
}
