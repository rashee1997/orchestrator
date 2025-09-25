import { promises as fs } from 'fs';
import path from 'path';
import fg from 'fast-glob';
import { isBinaryFile } from 'isbinaryfile';
import ignore from 'ignore';
import { FileReadOptions, FileReadResult, ProjectContext } from './types.js';
import { AIFileFilter } from './ai-file-filter.js';

/**
 * File Reading and Discovery Service
 * Handles file searching, reading, and content processing
 */
export class FileReader {
    private aiFileFilter?: AIFileFilter;
    private gitignoreCache = new Map<string, any>();

    constructor(geminiService?: any) {
        if (geminiService) {
            this.aiFileFilter = new AIFileFilter(geminiService);
        }
    }

    private readonly BINARY_TEXT_FORMATS = [
        // Data formats that might be detected as binary but are text
        '.json', '.jsonl', '.ndjson',
        '.yaml', '.yml',
        '.xml', '.xsd', '.xsl', '.xslt',
        '.toml', '.ini', '.cfg', '.conf',
        '.csv', '.tsv', '.sql',
        '.md', '.markdown', '.txt', '.rst',
        '.html', '.htm', '.css', '.scss',
        '.svg', '.gitignore', '.editorconfig'
    ];

    private readonly SPECIAL_FILES = [
        'Dockerfile', 'Makefile', 'makefile', 'GNUmakefile',
        'Vagrantfile', 'Jenkinsfile', 'Procfile'
    ];

    /**
     * Search and read files based on patterns and options
     */
    async searchAndReadFiles(
        options: FileReadOptions & { patterns: string[] },
        projectContext: ProjectContext
    ): Promise<{
        files: FileReadResult[];
        totalFilesFound: number;
        totalFilesRead: number;
        errors: string[];
    }> {
        const errors: string[] = [];

        try {
            console.log(`[FileReader] 🔍 Searching with ${options.patterns.length} patterns...`);

            // Load gitignore rules
            const gitignore = await this.loadGitignore(projectContext.rootDir);

            // Search for files
            const foundFiles = await this.searchFiles(options, projectContext.rootDir);
            console.log(`[FileReader] 📄 Found ${foundFiles.length} files before filtering`);

            // Filter by gitignore and other rules
            const filteredFiles = await this.filterFiles(foundFiles, projectContext.rootDir, gitignore, options);
            console.log(`[FileReader] ✅ ${filteredFiles.length} files after filtering`);

            // Read files
            const readResults = await this.readFiles(filteredFiles, projectContext.rootDir, options);

            const successfulFiles = readResults
                .filter(result => !result.error)
                .slice(0, options.maxFiles || 20);

            const failedFiles = readResults.filter(result => result.error);
            errors.push(...failedFiles.map(f => f.error!));

            return {
                files: successfulFiles,
                totalFilesFound: foundFiles.length,
                totalFilesRead: successfulFiles.length,
                errors
            };

        } catch (error: any) {
            errors.push(`Search error: ${error.message}`);
            return {
                files: [],
                totalFilesFound: 0,
                totalFilesRead: 0,
                errors
            };
        }
    }


    /**
     * Search for files using glob patterns
     */
    private async searchFiles(options: FileReadOptions & { patterns: string[] }, rootDir: string): Promise<string[]> {
        const excludeDirs = [
            'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
            '__pycache__', '.pytest_cache', 'target', 'out',
            ...(options.excludeDirs || [])
        ];

        try {
            const files = await fg(options.patterns, {
                cwd: rootDir,
                absolute: true,
                onlyFiles: true,
                deep: 15,
                dot: false,
                ignore: excludeDirs.map(dir => `${dir}/**`)
            });

            return files;
        } catch (error) {
            console.warn('[FileReader] Glob search error:', error);
            return [];
        }
    }

    /**
     * Filter files by gitignore, size, and other criteria
     */
    private async filterFiles(
        files: string[],
        rootDir: string,
        gitignore: any,
        options: FileReadOptions
    ): Promise<string[]> {

        const filteredFiles = [];

        for (const file of files) {
            try {
                // Check gitignore
                const relativePath = path.relative(rootDir, file);
                if (gitignore.ignores(relativePath)) {
                    continue;
                }

                // Check file size
                const stats = await fs.stat(file);
                if (options.maxFileSize && stats.size > options.maxFileSize) {
                    console.log(`[FileReader] 📏 File too large: ${relativePath} (${stats.size} bytes)`);
                    continue;
                }

                // Check exclude extensions
                if (options.excludeExtensions) {
                    const ext = path.extname(file).toLowerCase();
                    if (options.excludeExtensions.includes(ext)) {
                        continue;
                    }
                }

                filteredFiles.push(file);

            } catch (error) {
                console.warn(`[FileReader] Error checking file ${file}:`, error);
            }
        }

        // Use AI agent to intelligently filter and prioritize files
        if (options.query && this.aiFileFilter) {
            console.log(`[FileReader] 🤖 Using AI agent to prioritize ${filteredFiles.length} files for query analysis...`);

            const prioritizedFiles = await this.aiFileFilter.filterAndPrioritizeFiles(filteredFiles, rootDir, options);
            return prioritizedFiles;
        }

        // Fallback to simple sorting if no AI service or few files
        const filesWithStats = await Promise.allSettled(
            filteredFiles.map(async file => {
                try {
                    const stats = await fs.stat(file);
                    return { file, mtime: stats.mtime, size: stats.size };
                } catch {
                    return null;
                }
            })
        );

        return filesWithStats
            .map(result => result.status === 'fulfilled' ? result.value : null)
            .filter(Boolean)
            .sort((a, b) => {
                // Sort by modification time (newest first), then by size (smaller first)
                const timeDiff = b!.mtime.getTime() - a!.mtime.getTime();
                return timeDiff !== 0 ? timeDiff : a!.size - b!.size;
            })
            .map(item => item!.file);
    }

    /**
     * Read multiple files concurrently
     */
    private async readFiles(
        filePaths: string[],
        rootDir: string,
        options: FileReadOptions
    ): Promise<FileReadResult[]> {

        const readPromises = filePaths.map(filePath =>
            this.readSingleFile(filePath, rootDir, options)
        );

        const results = await Promise.allSettled(readPromises);

        return results.map((result, index) =>
            result.status === 'fulfilled'
                ? result.value
                : this.createErrorResult(filePaths[index], rootDir, result.reason)
        );
    }

    /**
     * Read and process a single file
     */
    private async readSingleFile(
        filePath: string,
        rootDir: string,
        options: FileReadOptions
    ): Promise<FileReadResult> {

        const relativePath = path.relative(rootDir, filePath);
        const extension = path.extname(filePath);
        const basename = path.basename(filePath);

        try {
            const stats = await fs.stat(filePath);

            const result: FileReadResult = {
                path: filePath,
                relativePath,
                content: '',
                size: stats.size,
                extension,
                lastModified: stats.mtime,
                lines: 0,
                encoding: 'utf-8',
                detectedLanguages: this.detectLanguages(filePath)
            };

            // Check if file is binary
            const isBinary = await isBinaryFile(filePath);

            if (isBinary && !this.isTextFormat(extension, basename)) {
                result.encoding = 'binary';
                result.content = `[Binary file: ${extension || 'no extension'} - ${stats.size} bytes]`;
                return result;
            }

            // Read text content
            try {
                const content = await fs.readFile(filePath, 'utf-8');

                // Truncate very large files
                if (content.length > 500000) {
                    result.content = content.substring(0, 500000) + '\n... [File truncated - content too large]';
                    console.log(`[FileReader] ✂️ Truncated large file: ${relativePath}`);
                } else {
                    result.content = content;
                }

                result.lines = content.split('\n').length;

                // Search for keywords if specified
                if (options.searchContent && options.contentKeywords) {
                    result.matchedKeywords = this.findMatchingKeywords(
                        content,
                        options.contentKeywords,
                        options.caseSensitive
                    );
                }

            } catch (error) {
                result.encoding = 'unsupported';
                result.error = `Failed to read as text: ${error}`;
                result.content = '[Error reading file content]';
            }

            return result;

        } catch (error: any) {
            return this.createErrorResult(filePath, rootDir, error);
        }
    }

    /**
     * Check if a file should be treated as text despite being detected as binary
     */
    private isTextFormat(extension: string, basename: string): boolean {
        return this.BINARY_TEXT_FORMATS.includes(extension.toLowerCase()) ||
               this.SPECIAL_FILES.includes(basename);
    }

    /**
     * Detect programming languages from file path
     */
    private detectLanguages(filePath: string): string[] {
        const ext = path.extname(filePath).toLowerCase();
        const basename = path.basename(filePath);

        // Language mapping
        const languageMap: Record<string, string[]> = {
            '.ts': ['typescript'],
            '.tsx': ['typescript', 'react'],
            '.d.ts': ['typescript'],
            '.js': ['javascript'],
            '.jsx': ['javascript', 'react'],
            '.mjs': ['javascript', 'esm'],
            '.cjs': ['javascript', 'commonjs'],
            '.py': ['python'],
            '.pyi': ['python', 'types'],
            '.java': ['java'],
            '.go': ['go'],
            '.rs': ['rust'],
            '.php': ['php'],
            '.rb': ['ruby'],
            '.cpp': ['cpp'],
            '.hpp': ['cpp'],
            '.c': ['c'],
            '.h': ['c'],
            '.cs': ['csharp'],
            '.swift': ['swift'],
            '.kt': ['kotlin'],
            '.scala': ['scala'],
            '.dart': ['dart'],
            '.html': ['html'],
            '.htm': ['html'],
            '.css': ['css'],
            '.scss': ['sass'],
            '.sass': ['sass'],
            '.less': ['less'],
            '.vue': ['vue'],
            '.svelte': ['svelte'],
            '.json': ['json'],
            '.yaml': ['yaml'],
            '.yml': ['yaml'],
            '.toml': ['toml'],
            '.xml': ['xml'],
            '.md': ['markdown'],
            '.rst': ['rst'],
            '.sql': ['sql']
        };

        // Check special files
        const specialFiles: Record<string, string[]> = {
            'Dockerfile': ['docker'],
            'Makefile': ['makefile'],
            'makefile': ['makefile'],
            'GNUmakefile': ['makefile'],
            'Vagrantfile': ['ruby', 'vagrant'],
            'Jenkinsfile': ['groovy', 'jenkins'],
            'package.json': ['json', 'npm'],
            'tsconfig.json': ['json', 'typescript'],
            'pyproject.toml': ['toml', 'python']
        };

        // Check special files first
        if (specialFiles[basename]) {
            return specialFiles[basename];
        }

        // Check by extension
        return languageMap[ext] || [];
    }

    /**
     * Find matching keywords in content
     */
    private findMatchingKeywords(
        content: string,
        keywords: string[],
        caseSensitive = false
    ): string[] {
        const searchContent = caseSensitive ? content : content.toLowerCase();
        const searchKeywords = caseSensitive ? keywords : keywords.map(k => k.toLowerCase());

        return keywords.filter((keyword, index) =>
            searchContent.includes(searchKeywords[index])
        );
    }

    /**
     * Load gitignore rules
     */
    private async loadGitignore(rootDir: string): Promise<any> {
        if (this.gitignoreCache.has(rootDir)) {
            return this.gitignoreCache.get(rootDir);
        }

        const ig = ignore();

        // Add default ignore patterns
        ig.add([
            '.git/', 'node_modules/', '.DS_Store', 'Thumbs.db',
            '*.log', '*.tmp', '*.temp', '.env*',
            '__pycache__/', '*.pyc', '*.pyo', '*.pyd',
            'dist/', 'build/', 'out/', '.cache/',
            '.pytest_cache/', '.coverage', '.nyc_output',
            '*.pid', '*.seed', '*.lock',
            '.next/', '.nuxt/', '.vuepress/dist/'
        ]);

        // Load .gitignore file
        try {
            const gitignorePath = path.join(rootDir, '.gitignore');
            const content = await fs.readFile(gitignorePath, 'utf-8');
            const lines = content.split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'));

            if (lines.length > 0) {
                ig.add(lines);
                console.log(`[FileReader] 📋 Loaded ${lines.length} .gitignore patterns`);
            }
        } catch {
            // No .gitignore file or read error
        }

        this.gitignoreCache.set(rootDir, ig);
        return ig;
    }

    /**
     * Create error result for failed file reads
     */
    private createErrorResult(filePath: string, rootDir: string, error: any): FileReadResult {
        return {
            path: filePath,
            relativePath: path.relative(rootDir, filePath),
            content: '',
            size: 0,
            extension: path.extname(filePath),
            lastModified: new Date(),
            lines: 0,
            encoding: 'unsupported',
            error: `Failed to read file: ${error?.message || error}`
        };
    }

    /**
     * Clear caches
     */
    clearCache(): void {
        this.gitignoreCache.clear();
    }
}