import { ProjectContext, PatternGenerationOptions, LanguageExtensionMap } from './types.js';
import fg from 'fast-glob';
import path from 'path';

/**
 * Smart Pattern Generation Service
 * Generates intelligent file search patterns based on query and project context
 */
export class PatternGenerator {
    private readonly LANGUAGE_EXTENSIONS: LanguageExtensionMap = {
        'typescript': ['.ts', '.tsx', '.d.ts'],
        'javascript': ['.js', '.jsx', '.mjs', '.cjs'],
        'python': ['.py', '.pyx', '.pyi', '.pyw'],
        'java': ['.java'],
        'go': ['.go'],
        'rust': ['.rs'],
        'php': ['.php', '.phtml'],
        'ruby': ['.rb', '.rake'],
        'cpp': ['.cpp', '.hpp', '.cc', '.h', '.cxx'],
        'csharp': ['.cs', '.cshtml', '.razor'],
        'swift': ['.swift'],
        'kotlin': ['.kt', '.kts'],
        'dart': ['.dart'],
        'scala': ['.scala', '.sc'],
        'html': ['.html', '.htm', '.xhtml'],
        'css': ['.css', '.scss', '.sass', '.less'],
        'json': ['.json', '.jsonl'],
        'yaml': ['.yaml', '.yml'],
        'xml': ['.xml', '.xsd'],
        'markdown': ['.md', '.markdown'],
        'unknown': ['.ts', '.js', '.py', '.java', '.go', '.rs']
    };

    constructor(private geminiService?: any) {}

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
     * Generate smart patterns using AI if available, fallback to rule-based
     */
    async generateSmartPatterns(
        query: string,
        projectContext: ProjectContext,
        userPatterns?: string[],
        options: PatternGenerationOptions = {}
    ): Promise<{ patterns: string[]; source: 'user_provided' | 'ai_generated' | 'rule_based' | 'explicit_priority' }> {

        // Extract explicit file mentions from query first
        const explicitFiles = this.extractExplicitFiles(query);

        if (explicitFiles.length > 0) {
            console.log(`[PatternGenerator] 🎯 Found ${explicitFiles.length} explicit file mentions: ${explicitFiles.join(', ')}`);
        }

        // Use user patterns if provided, but ALWAYS prioritize explicit files
        if (userPatterns && userPatterns.length > 0) {
            const combinedPatterns = [...userPatterns];

            // Add explicit file patterns at the beginning (highest priority)
            explicitFiles.forEach(file => {
                combinedPatterns.unshift(file); // Direct relative path
                combinedPatterns.unshift(`**/${file}`); // Anywhere in project
                combinedPatterns.unshift(`**/src/**/${file}`); // Common src location
            });

            if (explicitFiles.length > 0) {
                console.log(`[PatternGenerator] 📝 Using ${userPatterns.length} user patterns + ${explicitFiles.length} explicit files (prioritized)`);
                return { patterns: combinedPatterns, source: 'explicit_priority' };
            } else {
                console.log(`[PatternGenerator] 📝 Using ${userPatterns.length} user-provided patterns`);
                return { patterns: userPatterns, source: 'user_provided' };
            }
        }

        // Generate patterns with explicit files having highest priority
        let finalPatterns: string[] = [];
        let source: 'user_provided' | 'ai_generated' | 'rule_based' | 'explicit_priority' = 'rule_based';

        // Always start with explicit file patterns if found
        if (explicitFiles.length > 0) {
            explicitFiles.forEach(file => {
                finalPatterns.push(file); // Direct relative path
                finalPatterns.push(`**/${file}`); // Anywhere in project
                finalPatterns.push(`**/src/**/${file}`); // Common src location
                finalPatterns.push(`**/*/${file}`); // Any subdirectory
            });
            source = 'explicit_priority';
        }

        // Try AI generation if available and enabled
        if (this.geminiService && options.useAI !== false) {
            try {
                const aiPatterns = await this.generateAIPatterns(query, projectContext, options);
                if (aiPatterns.length > 0) {
                    finalPatterns.push(...aiPatterns);
                    if (explicitFiles.length === 0) {
                        source = 'ai_generated';
                    }
                }
            } catch (error) {
                console.warn('[PatternGenerator] ⚠️ AI generation failed:', error);
            }
        }

        // Add rule-based patterns as fallback
        const rulePatterns = this.generateRuleBasedPatterns(query, projectContext, options);
        finalPatterns.push(...rulePatterns);

        // Remove duplicates while preserving order (explicit files first)
        const uniquePatterns = Array.from(new Set(finalPatterns));

        console.log(`[PatternGenerator] 🔍 Generated ${uniquePatterns.length} patterns (source: ${source}), explicit files: ${explicitFiles.length}`);

        return { patterns: uniquePatterns, source };
    }

    /**
     * Generate patterns using AI with actual file scanning
     */
    private async generateAIPatterns(
        query: string,
        projectContext: ProjectContext,
        options: PatternGenerationOptions
    ): Promise<string[]> {
        console.log('[PatternGenerator] 🤖 Using AI to generate search patterns based on project analysis');

        // First, perform quick file discovery to understand actual project structure
        const actualFiles = await this.scanProjectForRelevantFiles(projectContext, query);

        const prompt = this.buildLocationAwareAIPrompt(query, projectContext, actualFiles, options);

        try {
            const response = await this.geminiService.askGemini(prompt);
            const content = response.content?.[0]?.text?.trim();

            if (content) {
                const patterns = this.parseAIResponse(content);
                console.log('[PatternGenerator] 🤖 AI generated patterns based on actual file locations');
                return patterns;
            }
        } catch (error) {
            console.warn('[PatternGenerator] AI request failed:', error);
        }

        return [];
    }

    /**
     * Build location-aware AI prompt for pattern generation
     */
    private buildLocationAwareAIPrompt(
        query: string,
        projectContext: ProjectContext,
        actualFiles: string[],
        options: PatternGenerationOptions
    ): string {
        const contextInfo = this.formatProjectContextForAI(projectContext);
        const maxPatterns = options.maxPatterns || 8;

        // Show actual file locations found in project
        const fileLocationInfo = actualFiles.length > 0
            ? `\nACTUAL FILES FOUND IN PROJECT:\n${actualFiles.slice(0, 20).map(f => `- ${f}`).join('\n')}${actualFiles.length > 20 ? `\n... and ${actualFiles.length - 20} more files` : ''}`
            : '\nNO SPECIFIC TARGET FILES FOUND IN INITIAL SCAN';

        return `You are an expert code search assistant. Generate optimal file search patterns based on ACTUAL files found in this specific project.

PROJECT CONTEXT:
${contextInfo}${fileLocationInfo}

QUERY: "${query}"

TASK:
Generate ${maxPatterns} specific glob patterns that will find the ACTUAL files shown above that are most relevant to the query. Base patterns on the real file paths found, not assumptions.

REQUIREMENTS:
- Use the ACTUAL file paths found above to create targeted patterns
- If specific target files were found (like iterative_rag_orchestrator.ts), create patterns that will find them
- Include related files in the same directories as the target files
- Focus on files that match the query intent
${options.includeTests ? '- Include test files if relevant' : '- Exclude test files unless query specifically asks for them'}
${options.includeConfigs ? '- Include configuration files if relevant' : '- Focus on source code files'}

IMPORTANT: Base patterns on the actual files shown above, not generic assumptions about project structure.

OUTPUT FORMAT:
Return ONLY a JSON array of glob patterns, nothing else.

Examples based on actual found files:
- Target specific files and their directories
- Include related files in same folders as target files
- Use actual folder names from the file paths shown above

Patterns:`;
    }

    /**
     * Format project context for AI
     */
    private formatProjectContextForAI(projectContext: ProjectContext): string {
        const info = [
            `- Root: ${projectContext.rootDir}`,
            `- Type: ${projectContext.projectType}`,
            `- Language: ${projectContext.primaryLanguage}`,
            `- Source Dir: ${projectContext.folderStructure.sourceDir}`,
        ];

        if (projectContext.frameworks.length > 0) {
            info.push(`- Frameworks: ${projectContext.frameworks.join(', ')}`);
        }

        if (projectContext.packageInfo) {
            info.push(`- Package: ${projectContext.packageInfo.name}`);
        }

        const structure = [];
        if (projectContext.folderStructure.hasComponents) structure.push('components');
        if (projectContext.folderStructure.hasServices) structure.push('services');
        if (projectContext.folderStructure.hasUtils) structure.push('utils');
        if (projectContext.folderStructure.hasTests) structure.push('tests');

        if (structure.length > 0) {
            info.push(`- Structure: ${structure.join(', ')}`);
        }

        return info.join('\n');
    }

    /**
     * Scan project to find actual relevant files before AI pattern generation
     */
    private async scanProjectForRelevantFiles(projectContext: ProjectContext, query: string): Promise<string[]> {
        console.log('[PatternGenerator] 🔍 Scanning project for relevant files...');

        try {
            const rootDir = projectContext.rootDir;

            // Extract meaningful terms from query for file searching
            const terms = query.match(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g) || [];
            const significantTerms = terms.filter(term =>
                term.length > 2 &&
                !['this', 'that', 'with', 'from', 'into', 'over', 'when', 'what', 'where', 'which', 'them', 'they', 'the', 'and', 'for'].includes(term.toLowerCase())
            );

            // Create broad search patterns to find relevant files
            const searchPatterns: string[] = [];

            // Language-specific patterns
            const extensions = this.LANGUAGE_EXTENSIONS[projectContext.primaryLanguage] || this.LANGUAGE_EXTENSIONS['unknown'];
            extensions.forEach(ext => {
                searchPatterns.push(`**/*${ext}`);
            });

            // Query-specific patterns
            significantTerms.forEach(term => {
                const lowerTerm = term.toLowerCase();
                searchPatterns.push(`**/*${lowerTerm}*`);
                searchPatterns.push(`**/${lowerTerm}/**/*`);

                // Add common variations
                extensions.forEach(ext => {
                    searchPatterns.push(`**/*${lowerTerm}*${ext}`);
                });
            });

            // Structural patterns based on actual project structure
            const sourceDir = projectContext.folderStructure.sourceDir;
            if (sourceDir && sourceDir !== '.') {
                extensions.forEach(ext => {
                    searchPatterns.push(`${sourceDir}/**/*${ext}`);
                });
            }

            // Add patterns based on detected folder structure
            const dynamicFolders: string[] = [];
            if (projectContext.folderStructure.hasComponents) dynamicFolders.push('components');
            if (projectContext.folderStructure.hasServices) dynamicFolders.push('services');
            if (projectContext.folderStructure.hasUtils) dynamicFolders.push('utils');

            dynamicFolders.forEach(folder => {
                extensions.forEach(ext => {
                    searchPatterns.push(`**/${folder}/**/*${ext}`);
                });
            });

            // Find files using fast-glob with .gitignore respect
            const foundFiles = await fg(searchPatterns, {
                cwd: rootDir,
                ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.vscode/**'],
                onlyFiles: true,
                absolute: false,
                followSymbolicLinks: false,
                unique: true
            });

            // Filter to most relevant files based on query terms
            let relevantFiles = foundFiles;

            if (significantTerms.length > 0) {
                // Rank files by relevance to query terms
                const rankedFiles = foundFiles.map(file => {
                    const fileName = path.basename(file).toLowerCase();
                    const filePath = file.toLowerCase();

                    let score = 0;
                    significantTerms.forEach(term => {
                        const lowerTerm = term.toLowerCase();
                        if (fileName.includes(lowerTerm)) score += 10;
                        if (filePath.includes(lowerTerm)) score += 5;
                        if (filePath.includes(`/${lowerTerm}/`)) score += 3;
                    });

                    return { file, score };
                }).filter(item => item.score > 0)
                  .sort((a, b) => b.score - a.score)
                  .map(item => item.file);

                if (rankedFiles.length > 0) {
                    relevantFiles = rankedFiles.slice(0, 50); // Top 50 most relevant
                } else {
                    // If no direct matches, take a sample of all files
                    relevantFiles = foundFiles.slice(0, 30);
                }
            } else {
                // No specific terms, take a representative sample
                relevantFiles = foundFiles.slice(0, 30);
            }

            console.log(`[PatternGenerator] 📁 Found ${foundFiles.length} total files, ${relevantFiles.length} relevant for AI analysis`);

            return relevantFiles;

        } catch (error) {
            console.warn('[PatternGenerator] ⚠️ File scanning failed:', error);
            return [];
        }
    }

    /**
     * Parse AI response to extract patterns
     */
    private parseAIResponse(content: string): string[] {
        try {
            // Look for JSON array in response
            const jsonMatch = content.match(/\[[\s\S]*?\]/);
            if (!jsonMatch) {
                console.warn('[PatternGenerator] No JSON array found in AI response');
                return [];
            }

            const patterns = JSON.parse(jsonMatch[0]);
            if (!Array.isArray(patterns)) {
                console.warn('[PatternGenerator] AI response is not an array');
                return [];
            }

            // Validate patterns
            const validPatterns = patterns
                .filter(p => typeof p === 'string' && p.length > 0 && p.length < 200)
                .slice(0, 10); // Limit to 10 patterns max

            console.log(`[PatternGenerator] ✅ AI generated ${validPatterns.length} valid patterns`);
            return validPatterns;

        } catch (error) {
            console.warn('[PatternGenerator] Failed to parse AI response:', error);
            return [];
        }
    }

    /**
     * Generate patterns using rule-based logic
     */
    private generateRuleBasedPatterns(
        query: string,
        projectContext: ProjectContext,
        options: PatternGenerationOptions = {}
    ): string[] {
        console.log('[PatternGenerator] 🔧 Generating rule-based patterns...');

        const patterns = new Set<string>();
        const lowerQuery = query.toLowerCase();
        const sourceDir = projectContext.folderStructure.sourceDir;

        // 1. Add language-specific patterns
        this.addLanguagePatterns(patterns, projectContext, sourceDir);

        // 2. Add query-specific patterns
        this.addQuerySpecificPatterns(patterns, query, sourceDir);

        // 3. Add framework-specific patterns
        this.addFrameworkPatterns(patterns, projectContext, sourceDir);

        // 4. Add intent-based patterns
        this.addIntentBasedPatterns(patterns, lowerQuery, sourceDir);

        // 5. Add structural patterns
        this.addStructuralPatterns(patterns, projectContext, sourceDir);

        // 6. Add test patterns if requested
        if (options.includeTests || lowerQuery.includes('test')) {
            this.addTestPatterns(patterns, projectContext, sourceDir);
        }

        // 7. Add config patterns if requested
        if (options.includeConfigs || lowerQuery.includes('config')) {
            this.addConfigPatterns(patterns, sourceDir);
        }

        const result = Array.from(patterns).slice(0, options.maxPatterns || 12);
        console.log(`[PatternGenerator] 📋 Generated ${result.length} rule-based patterns`);
        return result;
    }

    /**
     * Add language-specific patterns
     */
    private addLanguagePatterns(patterns: Set<string>, projectContext: ProjectContext, sourceDir: string): void {
        const extensions = this.LANGUAGE_EXTENSIONS[projectContext.primaryLanguage] ||
                          this.LANGUAGE_EXTENSIONS['unknown'];

        extensions.forEach(ext => {
            patterns.add(`**/*${ext}`);
            if (sourceDir !== '.') {
                patterns.add(`${sourceDir}/**/*${ext}`);
            }
        });
    }

    /**
     * Add query-specific patterns
     */
    private addQuerySpecificPatterns(patterns: Set<string>, query: string, sourceDir: string): void {
        // Extract meaningful terms from query
        const terms = query.match(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g) || [];
        const significantTerms = terms.filter(term =>
            term.length > 3 &&
            !['this', 'that', 'with', 'from', 'into', 'over', 'when', 'what', 'where', 'which', 'them', 'they'].includes(term.toLowerCase())
        );

        significantTerms.forEach(term => {
            const lowerTerm = term.toLowerCase();
            patterns.add(`**/*${lowerTerm}*`);
            patterns.add(`**/${lowerTerm}/**/*`);

            if (sourceDir !== '.') {
                patterns.add(`${sourceDir}/**/*${lowerTerm}*`);
            }

            // Add common variations
            patterns.add(`**/*${lowerTerm}*service*`);
            patterns.add(`**/*${lowerTerm}*component*`);
            patterns.add(`**/*${lowerTerm}*util*`);
        });
    }

    /**
     * Add framework-specific patterns
     */
    private addFrameworkPatterns(patterns: Set<string>, projectContext: ProjectContext, sourceDir: string): void {
        projectContext.frameworks.forEach(framework => {
            switch (framework) {
                case 'react':
                    patterns.add('**/*.jsx');
                    patterns.add('**/*.tsx');
                    patterns.add('**/components/**/*');
                    patterns.add('**/hooks/**/*');
                    break;

                case 'angular':
                    patterns.add('**/*.component.ts');
                    patterns.add('**/*.service.ts');
                    patterns.add('**/*.module.ts');
                    patterns.add('**/*.directive.ts');
                    break;

                case 'vue':
                    patterns.add('**/*.vue');
                    patterns.add('**/components/**/*.vue');
                    break;

                case 'express':
                    patterns.add('**/routes/**/*');
                    patterns.add('**/middleware/**/*');
                    patterns.add('**/controllers/**/*');
                    break;

                case 'nextjs':
                    patterns.add('**/pages/**/*');
                    patterns.add('**/app/**/*');
                    patterns.add('**/components/**/*');
                    break;
            }
        });
    }

    /**
     * Add intent-based patterns
     */
    private addIntentBasedPatterns(patterns: Set<string>, lowerQuery: string, sourceDir: string): void {
        const intentMap: Record<string, string[]> = {
            'refactor': ['**/*service*', '**/*util*', '**/*helper*', '**/*manager*'],
            'modular': ['**/*service*', '**/*component*', '**/*module*'],
            'component': ['**/components/**/*', '**/*component*', '**/ui/**/*'],
            'service': ['**/services/**/*', '**/*service*', '**/api/**/*'],
            'util': ['**/utils/**/*', '**/*util*', '**/*helper*'],
            'config': ['**/*config*', '**/config/**/*', '**/*.env*'],
            'auth': ['**/auth/**/*', '**/*auth*', '**/security/**/*'],
            'api': ['**/api/**/*', '**/routes/**/*', '**/endpoints/**/*'],
            'database': ['**/db/**/*', '**/models/**/*', '**/schema/**/*'],
            'test': ['**/*.test.*', '**/*.spec.*', '**/tests/**/*'],
        };

        Object.entries(intentMap).forEach(([intent, intentPatterns]) => {
            if (lowerQuery.includes(intent)) {
                intentPatterns.forEach(pattern => patterns.add(pattern));
            }
        });
    }

    /**
     * Add structural patterns based on project structure
     */
    private addStructuralPatterns(patterns: Set<string>, projectContext: ProjectContext, sourceDir: string): void {
        const structure = projectContext.folderStructure;

        if (structure.hasComponents) {
            patterns.add('**/components/**/*');
            if (sourceDir !== '.') {
                patterns.add(`${sourceDir}/components/**/*`);
            }
        }

        if (structure.hasServices) {
            patterns.add('**/services/**/*');
            if (sourceDir !== '.') {
                patterns.add(`${sourceDir}/services/**/*`);
            }
        }

        if (structure.hasUtils) {
            patterns.add('**/utils/**/*');
            patterns.add('**/utilities/**/*');
        }
    }

    /**
     * Add test patterns
     */
    private addTestPatterns(patterns: Set<string>, projectContext: ProjectContext, sourceDir: string): void {
        const testPatterns = [
            '**/*.test.*',
            '**/*.spec.*',
            '**/tests/**/*',
            '**/test/**/*',
            '**/__tests__/**/*',
            '**/__test__/**/*'
        ];

        testPatterns.forEach(pattern => patterns.add(pattern));
    }

    /**
     * Add configuration patterns
     */
    private addConfigPatterns(patterns: Set<string>, sourceDir: string): void {
        const configPatterns = [
            '**/*config*',
            '**/config/**/*',
            '**/*.env*',
            '**/*.json',
            '**/*.yaml',
            '**/*.yml',
            '**/*.toml',
            '**/.*rc*'
        ];

        configPatterns.forEach(pattern => patterns.add(pattern));
    }
}