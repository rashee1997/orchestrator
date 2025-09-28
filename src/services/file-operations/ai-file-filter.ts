import path from 'path';
import { FileReadOptions } from './types.js';

/**
 * AI-powered File Filtering Utility
 * Uses AI to intelligently prioritize and filter files based on query relevance
 */
export class AIFileFilter {
    constructor(private geminiService: any) {}

    /**
     * Use AI to filter and prioritize files based on query relevance
     */
    async filterAndPrioritizeFiles(
        files: string[],
        rootDir: string,
        options: FileReadOptions
    ): Promise<string[]> {
        if (!options.query || files.length <= (options.maxFiles || 20)) {
            return files;
        }

        console.log(`[AIFileFilter] 🤖 AI filtering ${files.length} files for query: "${options.query.substring(0, 100)}..."`);

        // First, check for exact file name matches in the query
        const exactMatches = this.findExactFileMatches(files, rootDir, options.query);
        if (exactMatches.length > 0) {
            console.log(`[AIFileFilter] 🎯 EXACT MATCH PRIORITY: Found ${exactMatches.length} exact file matches for query "${options.query}"`);
            exactMatches.forEach(match => {
                console.log(`[AIFileFilter]   ✅ ${path.relative(rootDir, match)}`);
            });
            const remainingFiles = files.filter(f => !exactMatches.includes(f));
            const maxFiles = options.maxFiles || 20;
            const additionalFiles = await this.filterAndPrioritizeFiles(remainingFiles, rootDir, {
                ...options,
                maxFiles: maxFiles - exactMatches.length
            });
            return [...exactMatches, ...additionalFiles.slice(0, maxFiles - exactMatches.length)];
        }

        try {
            const filesList = this.prepareFilesList(files, rootDir);
            const prompt = this.buildFileFilterPrompt(options.query, filesList, options.maxFiles || 20);

            const response = await this.geminiService.askGemini(prompt, 'gemini-2.5-flash');
            const aiResponse = response.content?.[0]?.text?.trim();

            if (aiResponse) {
                const selectedFiles = this.parseAIResponse(aiResponse, files, rootDir);
                console.log(`[AIFileFilter] ✅ AI selected ${selectedFiles.length} most relevant files`);
                return selectedFiles;
            }
        } catch (error) {
            console.warn('[AIFileFilter] ⚠️ AI filtering failed, using fallback:', error);
        }

        // Fallback to simple relevance-based sorting
        return this.fallbackFiltering(files, rootDir, options);
    }

    /**
     * Prepare files list for AI analysis
     */
    private prepareFilesList(files: string[], rootDir: string): string {
        const relativePaths = files.map(file => path.relative(rootDir, file));

        // Group files by directory for better organization
        const filesByDir = new Map<string, string[]>();

        relativePaths.forEach(filePath => {
            const dir = path.dirname(filePath);
            if (!filesByDir.has(dir)) {
                filesByDir.set(dir, []);
            }
            filesByDir.get(dir)!.push(path.basename(filePath));
        });

        // Format for AI analysis
        let filesList = '';
        for (const [dir, fileNames] of filesByDir.entries()) {
            filesList += `📁 ${dir}/\n`;
            fileNames.forEach(fileName => {
                filesList += `  - ${fileName}\n`;
            });
            filesList += '\n';
        }

        return filesList;
    }

    /**
     * Build AI prompt for file filtering
     */
    private buildFileFilterPrompt(query: string, filesList: string, maxFiles: number): string {
        // Extract potential file names from the query
        const potentialFileNames = this.extractPotentialFileNames(query);

        let filePriorityInstruction = '';
        if (potentialFileNames.length > 0) {
            filePriorityInstruction = `\n\n**URGENT FILE PRIORITY:** The query mentions these specific files: ${potentialFileNames.join(', ')}\n- These files MUST be included in your selection if they exist in the available files\n- Prioritize them above ALL other files\n- They are the PRIMARY target of the user's request`;
        }

        return `You are an expert code analyst specializing in intelligent file selection for code analysis tasks.

**TASK:** Analyze the user's query and the available files, then select the ${maxFiles} MOST RELEVANT files that should be read to fulfill the user's request.

**USER'S QUERY:**
"${query}"${filePriorityInstruction}

**AVAILABLE FILES:**
${filesList}

**SELECTION CRITERIA:**
1. **PRIMARY PRIORITY:** Files directly mentioned in the query (HIGHEST priority)
2. **Secondary Relevance:** Files directly implied by the query
3. **Supporting Files:** Related files that provide necessary context
4. **Dependency Priority:** Files that the main target files depend on
5. **Avoid Redundancy:** Don't select files with similar/duplicate functionality

**CRITICAL INSTRUCTIONS:**
- If the query mentions ANY specific file names, those files MUST be selected first
- Focus on files that are ESSENTIAL to answer the user's query
- Include supporting files that provide context for the main files
- Prefer implementation files (.ts, .js) over test files unless tests are specifically requested
- Consider file names, paths, and likely content relevance

**OUTPUT FORMAT:**
Return ONLY a JSON array of relative file paths, nothing else.

Example: ["src/tools/rag/iterative_rag_orchestrator.ts", "src/tools/rag/types.ts", "src/tools/rag/utils.ts"]

Selected files:`;
    }

    /**
     * Parse AI response to extract selected file paths
     */
    private parseAIResponse(response: string, originalFiles: string[], rootDir: string): string[] {
        try {
            // Look for JSON array in response
            const jsonMatch = response.match(/\[[\s\S]*?\]/);
            if (!jsonMatch) {
                console.warn('[AIFileFilter] No JSON array found in AI response');
                return this.fallbackFiltering(originalFiles, rootDir, { query: '' });
            }

            const selectedPaths = JSON.parse(jsonMatch[0]);
            if (!Array.isArray(selectedPaths)) {
                console.warn('[AIFileFilter] AI response is not an array');
                return this.fallbackFiltering(originalFiles, rootDir, { query: '' });
            }

            // Convert relative paths back to absolute paths
            const selectedFiles: string[] = [];

            for (const relativePath of selectedPaths) {
                if (typeof relativePath === 'string') {
                    const absolutePath = path.resolve(rootDir, relativePath);

                    // Find the matching file in the original list (case-insensitive)
                    const matchingFile = originalFiles.find(file => {
                        const fileRelative = path.relative(rootDir, file);
                        return fileRelative.toLowerCase() === relativePath.toLowerCase();
                    });

                    if (matchingFile) {
                        selectedFiles.push(matchingFile);
                    } else {
                        // Try to find by filename if relative path doesn't match exactly
                        const fileName = path.basename(relativePath);
                        const fileNameMatch = originalFiles.find(file =>
                            path.basename(file).toLowerCase() === fileName.toLowerCase()
                        );
                        if (fileNameMatch) {
                            selectedFiles.push(fileNameMatch);
                        }
                    }
                }
            }

            const relativePaths = selectedFiles.map(f => path.relative(rootDir, f));
            console.log(`[AIFileFilter] 🎯 AI selected ${selectedFiles.length} files:`);
            relativePaths.forEach(path => console.log(`[AIFileFilter]   - ${path}`));

            return selectedFiles.length > 0 ? selectedFiles : this.fallbackFiltering(originalFiles, rootDir, { query: '' });

        } catch (error) {
            console.warn('[AIFileFilter] Failed to parse AI response:', error);
            return this.fallbackFiltering(originalFiles, rootDir, { query: '' });
        }
    }

    /**
     * Fallback filtering when AI fails
     */
    private fallbackFiltering(files: string[], rootDir: string, options: FileReadOptions): string[] {
        if (!options.query) {
            return files.slice(0, options.maxFiles || 20);
        }

        const query = options.query.toLowerCase();
        const queryTerms = query.match(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g) || [];

        return files
            .map(file => ({
                file,
                score: this.calculateRelevanceScore(file, rootDir, query, queryTerms)
            }))
            .sort((a, b) => b.score - a.score)
            .map(item => item.file)
            .slice(0, options.maxFiles || 20);
    }

    /**
     * Extract potential file names from the query
     */
    private extractPotentialFileNames(query: string): string[] {
        const potentialFiles: string[] = [];

        // Look for quoted strings that might be file names
        const quotedMatches = query.match(/"([^"]+)"/g) || [];
        const singleQuotedMatches = query.match(/'([^']+)'/g) || [];
        const backtickMatches = query.match(/`([^`]+)`/g) || [];

        potentialFiles.push(...quotedMatches.map(m => m.slice(1, -1)));
        potentialFiles.push(...singleQuotedMatches.map(m => m.slice(1, -1)));
        potentialFiles.push(...backtickMatches.map(m => m.slice(1, -1)));

        // Look for file extensions in the query
        const fileExtensionPattern = /\b[\w\-]+\.[a-zA-Z0-9]+\b/g;
        const extensionMatches = query.match(fileExtensionPattern) || [];
        potentialFiles.push(...extensionMatches);

        // Look for camelCase/PascalCase patterns that might be file names
        const camelCasePattern = /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g;
        const camelCaseMatches = query.match(camelCasePattern) || [];
        potentialFiles.push(...camelCaseMatches);

        // Remove duplicates and filter out very short matches
        return [...new Set(potentialFiles)].filter(name => name.length > 3);
    }

    /**
     * Find exact file name matches in the query
     */
    private findExactFileMatches(files: string[], rootDir: string, query: string): string[] {
        const queryLower = query.toLowerCase();
        const exactMatches: string[] = [];

        for (const file of files) {
            const fileName = path.basename(file).toLowerCase();
            const relativePath = path.relative(rootDir, file).toLowerCase();

            // Check for exact file name matches (with or without extension)
            if (queryLower.includes(fileName)) {
                exactMatches.push(file);
                continue;
            }

            // Check for file name without extension
            const fileNameNoExt = fileName.replace(/\.[^.]*$/, '');
            if (queryLower.includes(fileNameNoExt)) {
                exactMatches.push(file);
                continue;
            }

            // Check for relative path matches
            if (queryLower.includes(relativePath)) {
                exactMatches.push(file);
                continue;
            }
        }

        return exactMatches;
    }

    /**
     * Calculate basic relevance score for fallback
     */
    private calculateRelevanceScore(filePath: string, rootDir: string, query: string, queryTerms: string[]): number {
        const relativePath = path.relative(rootDir, filePath);
        const fileName = path.basename(filePath).toLowerCase();
        const relativePathLower = relativePath.toLowerCase();

        let score = 0;

        // High priority: exact file name mentions
        if (query.includes(fileName)) {
            score += 200;
        }

        // Medium priority: query terms in file name or path
        for (const term of queryTerms) {
            const termLower = term.toLowerCase();
            if (fileName.includes(termLower)) {
                score += 50;
            }
            if (relativePathLower.includes(termLower)) {
                score += 25;
            }
        }

        // Slight preference for implementation files
        const ext = path.extname(filePath).toLowerCase();
        if (['.ts', '.js', '.py', '.java'].includes(ext)) {
            score += 5;
        }

        return score;
    }
}
