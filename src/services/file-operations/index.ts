import { ProjectAnalyzer } from './project-analyzer.js';
import { PatternGenerator } from './pattern-generator.js';
import { FileReader } from './file-reader.js';
import {
    FileReadOptions,
    FileReadResult,
    FileReadServiceResult,
    ProjectContext,
    PatternGenerationOptions
} from './types.js';

/**
 * Main File Operations Service
 * Orchestrates project analysis, pattern generation, and file reading
 */
export class FileOperationsService {
    private projectAnalyzer: ProjectAnalyzer;
    private patternGenerator: PatternGenerator;
    private fileReader: FileReader;

    constructor(geminiService?: any) {
        this.projectAnalyzer = new ProjectAnalyzer();
        this.patternGenerator = new PatternGenerator(geminiService);
        this.fileReader = new FileReader(geminiService);
    }

    /**
     * Extract explicit file mentions from the query
     */
    private extractExplicitFiles(query: string): string[] {
        const filePattern = /[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|rb|go|java|cs|rs|php|sh|yaml|yml|toml|ini|cfg|conf)/gi;
        const explicitFiles = new Set<string>();
        let match: RegExpExecArray | null;

        while ((match = filePattern.exec(query)) !== null) {
            const cleaned = match[0].replace(/["'`]/g, '');
            if (cleaned) {
                explicitFiles.add(cleaned);
            }
        }

        return Array.from(explicitFiles);
    }

    /**
     * Check if explicitly requested files were found in the results
     */
    private validateExplicitFiles(
        explicitFiles: string[],
        foundFiles: any[],
        query: string
    ): { found: string[]; missing: string[]; warnings: string[] } {
        if (explicitFiles.length === 0) {
            return { found: [], missing: [], warnings: [] };
        }

        const found: string[] = [];
        const missing: string[] = [];
        const warnings: string[] = [];

        console.log(`[FileOperationsService] 🔍 Validating ${explicitFiles.length} explicit files against ${foundFiles.length} found files`);
        explicitFiles.forEach(requestedFile => {
            console.log(`[FileOperationsService]   Looking for: "${requestedFile}"`);

            const matchingFile = foundFiles.find(file => {
                const exactMatch = file.relativePath === requestedFile;
                const endsWithMatch = file.relativePath.endsWith(`/${requestedFile}`);
                const includesMatch = file.relativePath.includes(requestedFile);

                console.log(`[FileOperationsService]     Checking "${file.relativePath}": exact=${exactMatch}, endsWith=${endsWithMatch}, includes=${includesMatch}`);

                return exactMatch || endsWithMatch || includesMatch;
            });

            if (matchingFile) {
                console.log(`[FileOperationsService]   ✅ Found match: ${matchingFile.relativePath}`);
                found.push(requestedFile);
            } else {
                console.log(`[FileOperationsService]   ❌ No match found for: ${requestedFile}`);
                missing.push(requestedFile);
                warnings.push(`❌ Requested file "${requestedFile}" not found in project`);
            }
        });

        if (missing.length > 0 && found.length === 0) {
            warnings.push(`🔍 Consider checking: file paths, spelling, or if files exist in the current project`);
        }

        console.log(`[FileOperationsService] 📊 Validation result: ${found.length} found, ${missing.length} missing`);
        return { found, missing, warnings };
    }

    /**
     * Main entry point - intelligent file discovery and reading
     */
    async discoverAndReadFiles(options: FileReadOptions): Promise<FileReadServiceResult> {
        const startTime = Date.now();
        console.log('[FileOperationsService] 🚀 Starting intelligent file discovery...');

        try {
            // 1. Extract explicit file mentions from query
            const explicitFiles = this.extractExplicitFiles(options.query);
            if (explicitFiles.length > 0) {
                console.log(`[FileOperationsService] 🎯 Explicit files requested: ${explicitFiles.join(', ')}`);
            }

            // 2. Analyze project context
            const projectContext = await this.projectAnalyzer.analyzeProject(options.rootDir);
            console.log(`[FileOperationsService] 📊 Project: ${projectContext.projectType} (${projectContext.primaryLanguage})`);

            // --- STAGE 1: Read Explicitly Requested Files Directly (Guaranteed Read) ---
            let explicitReadResults: FileReadResult[] = [];
            let explicitFilesReadCount = 0;
            let explicitErrors: string[] = [];

            if (explicitFiles.length > 0) {
                // Use a non-limiting options object for reading specific files
                const specificReadOptions = { ...options, maxFiles: undefined }; 
                explicitReadResults = await this.fileReader.readSpecificFiles(explicitFiles, specificReadOptions, projectContext);
                
                explicitFilesReadCount = explicitReadResults.filter(r => !r.error).length;
                explicitErrors = explicitReadResults.filter(r => r.error).map(r => r.error!);

                console.log(`[FileOperationsService] 📖 STAGE 1 Complete: Read ${explicitFilesReadCount}/${explicitFiles.length} explicit files directly.`);
            }

            // --- STAGE 2: Autonomous Context Search (Supplementary Files) ---
            const maxFilesBudget = options.maxFiles || 20;
            const maxFilesForAutonomousSearch = Math.max(0, maxFilesBudget - explicitFilesReadCount);
            
            // Initializing containers for autonomous search results
            let fileResults: {
                files: FileReadResult[];
                totalFilesFound: number;
                totalFilesRead: number;
                errors: string[];
            } = {
                files: [],
                totalFilesFound: 0,
                totalFilesRead: 0,
                errors: []
            };

            let patterns: string[] = [];
            let source: 'user_provided' | 'ai_generated' | 'rule_based' | 'explicit_priority' = 'rule_based';

            if (maxFilesForAutonomousSearch > 0 || (options.patterns && options.patterns.length > 0)) {
                
                // 3. Generate smart search patterns
                const patternOptions: PatternGenerationOptions = {
                    useAI: true,
                    maxPatterns: 12,
                    includeTests: options.query?.toLowerCase().includes('test') || false,
                    includeConfigs: options.query?.toLowerCase().includes('config') || false
                };

                ({ patterns, source } = await this.patternGenerator.generateSmartPatterns(
                    options.query,
                    projectContext,
                    options.patterns,
                    patternOptions
                ));

                console.log(`[FileOperationsService] 🎯 Generated ${patterns.length} patterns (${source}) for supplementary search (Budget: ${maxFilesForAutonomousSearch}).`);

                // 4. Search and read supplementary files
                const searchOptions = { 
                    ...options, 
                    patterns, 
                    maxFiles: maxFilesForAutonomousSearch 
                };

                fileResults = await this.fileReader.searchAndReadFiles(searchOptions, projectContext);
            } else {
                console.log('[FileOperationsService] 🚫 STAGE 2 Skipped: Max files budget exhausted by explicit requests or no patterns provided.');
            }

            // --- STAGE 3: Combine and Validate Results ---
            
            // Combine files, filtering out any potential duplicates if the autonomous search also found an explicit file
            const explicitFilePaths = new Set(explicitReadResults.filter(r => !r.error).map(r => r.path));
            const supplementaryFiles = fileResults.files.filter(f => !explicitFilePaths.has(f.path));
            
            const combinedFiles = [...explicitReadResults.filter(r => !r.error), ...supplementaryFiles];
            const totalFilesRead = combinedFiles.length;
            const combinedErrors = [...explicitErrors, ...fileResults.errors];
            
            // 5. Validate that explicit files were successfully read
            const validation = this.validateExplicitFiles(explicitFiles, combinedFiles, options.query);

            if (validation.warnings.length > 0) {
                console.warn('[FileOperationsService] ⚠️ Explicit file validation warnings:');
                validation.warnings.forEach(warning => console.warn(`  ${warning}`));
            }

            if (validation.found.length > 0) {
                console.log(`[FileOperationsService] ✅ Found ${validation.found.length}/${explicitFiles.length} explicitly requested files`);
            }

            const result: FileReadServiceResult = {
                files: combinedFiles,
                totalFilesFound: fileResults.totalFilesFound, // Tracks files found by the autonomous glob search
                totalFilesRead: totalFilesRead,
                searchTimeMs: Date.now() - startTime,
                errors: combinedErrors,
                projectContext,
                searchPatterns: patterns, // Patterns used for supplementary search
                patternSource: source,
                // Add explicit file validation info
                explicitFilesRequested: explicitFiles,
                explicitFilesFound: validation.found,
                explicitFilesMissing: validation.missing,
                explicitFileWarnings: validation.warnings
            };

            console.log(`[FileOperationsService] ✅ Discovery complete: ${result.totalFilesRead} files read in ${result.searchTimeMs}ms`);
            return result;

        } catch (error: any) {
            console.error('[FileOperationsService] ❌ Discovery failed:', error);

            return {
                files: [],
                totalFilesFound: 0,
                totalFilesRead: 0,
                searchTimeMs: Date.now() - startTime,
                errors: [error.message || 'Unknown error occurred'],
                projectContext: this.projectAnalyzer.getBasicContext(options.rootDir),
                searchPatterns: [],
                patternSource: 'rule_based',
                // Explicit file validation for failure case
                explicitFilesRequested: this.extractExplicitFiles(options.query),
                explicitFilesFound: [],
                explicitFilesMissing: this.extractExplicitFiles(options.query),
                explicitFileWarnings: [`❌ Discovery failed before files could be validated: ${error.message}`]
            };
        }
    }

    /**
     * Format results for display
     */
    formatResultsForDisplay(result: FileReadServiceResult, maxContentLength = 3000): string {
        let output = `## 📁 Intelligent File Discovery Results\n\n`;

        // Summary section
        output += `**🔍 Discovery Summary:**\n`;
        output += `- **Project:** ${result.projectContext.projectType} (${result.projectContext.primaryLanguage})\n`;
        output += `- **Root:** \`${result.projectContext.rootDir}\`\n`;
        output += `- **Pattern Source:** ${result.patternSource.replace('_', ' ')}\n`;
        output += `- **Patterns Used:** ${result.searchPatterns.length}\n`;
        output += `- **Files Found:** ${result.totalFilesFound}\n`;
        output += `- **Files Read:** ${result.totalFilesRead}\n`;
        output += `- **Search Time:** ${result.searchTimeMs}ms\n\n`;

        if (result.errors.length > 0) {
            output += `- **⚠️ Errors:** ${result.errors.length} encountered\n\n`;
        }

        // Project context
        if (result.projectContext.frameworks.length > 0) {
            output += `**🛠️ Detected Frameworks:** ${result.projectContext.frameworks.join(', ')}\n`;
        }

        if (result.projectContext.folderStructure.sourceDir !== '.') {
            output += `**📁 Source Directory:** ${result.projectContext.folderStructure.sourceDir}\n`;
        }

        output += `\n`;

        // Language and file type distribution
        if (result.files.length > 0) {
            const languageStats = new Map<string, number>();
            const extensionStats = new Map<string, number>();

            result.files.forEach(file => {
                const ext = file.extension || 'no extension';
                extensionStats.set(ext, (extensionStats.get(ext) || 0) + 1);

                if (file.detectedLanguages) {
                    file.detectedLanguages.forEach(lang => {
                        languageStats.set(lang, (languageStats.get(lang) || 0) + 1);
                    });
                }
            });

            if (languageStats.size > 0) {
                output += `**🎯 Language Distribution:**\n`;
                Array.from(languageStats.entries())
                    .sort(([,a], [,b]) => b - a)
                    .slice(0, 6)
                    .forEach(([lang, count]) => {
                        const percentage = ((count / result.files.length) * 100).toFixed(0);
                        output += `- **${lang}:** ${count} files (${percentage}%)\n`;
                    });
                output += `\n`;
            }

            output += `**📄 File Contents:**\n\n`;

            result.files.forEach((file, index) => {
                output += `### ${index + 1}. \`${file.relativePath}\`\n\n`;

                // File metadata
                output += `| Property | Value |\n`;
                output += `|----------|-------|\n`;
                output += `| **Size** | ${this.formatFileSize(file.size)} |\n`;
                output += `| **Lines** | ${file.lines.toLocaleString()} |\n`;
                output += `| **Extension** | ${file.extension || 'none'} |\n`;
                output += `| **Encoding** | ${file.encoding} |\n`;

                if (file.detectedLanguages && file.detectedLanguages.length > 0) {
                    output += `| **Languages** | ${file.detectedLanguages.join(', ')} |\n`;
                }

                output += `| **Modified** | ${file.lastModified.toISOString().split('T')[0]} |\n`;

                if (file.matchedKeywords && file.matchedKeywords.length > 0) {
                    output += `| **Keywords** | ${file.matchedKeywords.map(k => `\`${k}\``).join(', ')} |\n`;
                }

                output += `\n`;

                // File content
                if (file.encoding === 'utf-8' && file.content && file.content.trim()) {
                    const truncatedContent = file.content.length > maxContentLength
                        ? file.content.substring(0, maxContentLength) + '\n... [Content truncated for display]'
                        : file.content;

                    // Determine syntax highlighting
                    let syntaxLang = 'text';
                    if (file.detectedLanguages && file.detectedLanguages.length > 0) {
                        const langMap: Record<string, string> = {
                            'typescript': 'typescript',
                            'javascript': 'javascript',
                            'python': 'python',
                            'java': 'java',
                            'go': 'go',
                            'rust': 'rust',
                            'html': 'html',
                            'css': 'css',
                            'json': 'json',
                            'yaml': 'yaml',
                            'xml': 'xml',
                            'sql': 'sql',
                            'markdown': 'markdown',
                            'docker': 'dockerfile'
                        };
                        syntaxLang = langMap[file.detectedLanguages[0]] || file.detectedLanguages[0];
                    } else if (file.extension) {
                        syntaxLang = file.extension.slice(1);
                    }

                    output += `\`\`\`${syntaxLang}\n${truncatedContent}\n\`\`\`\n\n`;

                } else if (file.encoding === 'binary') {
                    output += `*📦 Binary file - content not displayed*\n\n`;
                } else if (file.error) {
                    output += `*❌ Error: ${file.error}*\n\n`;
                } else {
                    output += `*📭 Empty file*\n\n`;
                }

                output += `---\n\n`;
            });

        } else {
            output += `**📄 No files found matching the search criteria.**\n\n`;
            output += `**💡 Suggestions:**\n`;
            output += `- Verify the query terms are correct\n`;
            output += `- Check if files might be excluded by .gitignore\n`;
            output += `- Try broader search patterns\n`;
            output += `- Ensure the project structure matches expectations\n\n`;
        }

        return output;
    }

    /**
     * Format file size in human-readable format
     */
    private formatFileSize(bytes: number): string {
        if (bytes === 0) return '0 B';

        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));

        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    /**
     * Clear all caches
     */
    clearCache(): void {
        this.projectAnalyzer.clearCache();
        this.fileReader.clearCache();
    }
}

// Export types
export * from './types.js';

// Export services
export { ProjectAnalyzer } from './project-analyzer.js';
export { PatternGenerator } from './pattern-generator.js';
export { FileReader } from './file-reader.js';

// Export singleton
export const fileOperationsService = new FileOperationsService();
