import { ParserFactory } from '../../parsers/ParserFactory.js';
import { MemoryManager } from '../../memory_manager.js';
import type { CodebaseIntrospectionService } from '../CodebaseIntrospectionService.js';

export interface FileAnalysis {
    filePath: string;
    fileType: string;
    complexity: 'simple' | 'moderate' | 'complex';
    lineCount: number;
    entityCount: number;
    dependencies: string[];
    chunks: FileChunk[];
    analysisReason: string;
}

export interface FileChunk {
    content: string;
    startLine: number;
    endLine: number;
    entities: string[];
    summary: string;
}

export interface ChangeTypeAnalysis {
    changeType: 'simple_refactor' | 'code_standardization' | 'modularization' | 'feature_addition' | 'bug_fix' | 'major_restructure';
    confidence: number;
    reason: string;
    suggestedBatchCount: number;
    requiresNewFiles: boolean;
}

export interface DynamicPlanContext {
    goalAnalysis: ChangeTypeAnalysis;
    fileAnalyses: FileAnalysis[];
    totalComplexity: 'simple' | 'moderate' | 'complex';
    recommendedStrategy: 'single_task' | 'simple_plan' | 'moderate_plan' | 'complex_plan';
}

export class DynamicPlanAnalyzer {
    private parserFactory: ParserFactory;
    private memoryManager: MemoryManager;
    private introspectionService?: CodebaseIntrospectionService;

    constructor(
        projectRootPath: string,
        memoryManager: MemoryManager,
        introspectionService?: CodebaseIntrospectionService
    ) {
        this.parserFactory = new ParserFactory(projectRootPath);
        this.memoryManager = memoryManager;
        this.introspectionService = introspectionService;
    }

    /**
     * Analyzes the goal and files to determine the optimal planning strategy
     */
    async analyzePlanningContext(
        goal: string,
        liveFiles: Array<{ path: string; content: string }>
    ): Promise<DynamicPlanContext> {
        // 1. Analyze the goal to determine change type
        const goalAnalysis = this.analyzeChangeType(goal, liveFiles);

        // 2. Analyze each file using appropriate parsers
        const fileAnalyses = await Promise.all(
            liveFiles.map(file => this.analyzeFile(file.path, file.content))
        );

        // 3. Determine overall complexity
        const totalComplexity = this.calculateTotalComplexity(fileAnalyses, goalAnalysis);

        // 4. Recommend strategy
        const recommendedStrategy = this.determineStrategy(goalAnalysis, totalComplexity, fileAnalyses.length);

        return {
            goalAnalysis,
            fileAnalyses,
            totalComplexity,
            recommendedStrategy
        };
    }

    /**
     * Analyzes a single file using the appropriate parser and chunks it if needed
     */
    async analyzeFile(filePath: string, content: string): Promise<FileAnalysis> {
        const fileType = this.detectFileType(filePath);
        const lineCount = content.split('\n').length;

        let entityCount = 0;
        let dependencies: string[] = [];

        try {
            // Try to get appropriate parser
            const parser = this.parserFactory.createParser(fileType, this.introspectionService);

            if (parser) {
                // Parse imports and entities
                const imports = await parser.parseImports(filePath, content);
                const entities = await parser.parseCodeEntities(filePath, content, process.cwd());

                entityCount = entities.length;
                dependencies = imports.map(imp =>
                    (imp.importedSymbols && imp.importedSymbols.length > 0 ? imp.importedSymbols.join(', ') : '') ||
                    imp.targetPath
                ).filter(Boolean);
            }
        } catch (error) {
            console.warn(`Failed to parse ${filePath} with ${fileType} parser:`, error);
        }

        // Determine complexity
        const complexity = this.calculateFileComplexity(lineCount, entityCount, dependencies.length);

        // Create chunks if file is large
        const chunks = this.createFileChunks(content, complexity, lineCount);

        return {
            filePath,
            fileType,
            complexity,
            lineCount,
            entityCount,
            dependencies,
            chunks,
            analysisReason: this.generateAnalysisReason(complexity, lineCount, entityCount)
        };
    }

    /**
     * Detects file type based on extension for parser selection
     */
    private detectFileType(filePath: string): string {
        const ext = filePath.split('.').pop()?.toLowerCase() || '';

        const typeMap: { [key: string]: string } = {
            'ts': 'enhancedtypescript',
            'tsx': 'enhancedtypescript',
            'js': 'enhancedtypescript',
            'jsx': 'enhancedtypescript',
            'py': 'python',
            'html': 'html',
            'css': 'css',
            'php': 'enhancedphp',
            'jsonl': 'jsonl',
            'md': 'markdown',
            'sql': 'sql'
        };

        return typeMap[ext] || 'enhancedtypescript'; // Default fallback
    }

    /**
     * Analyzes the goal text to determine what type of change is being requested
     */
    private analyzeChangeType(goal: string, liveFiles: Array<{ path: string; content: string }>): ChangeTypeAnalysis {
        const goalLower = goal.toLowerCase();
        const fileCount = liveFiles.length;

        // Keywords for different change types
        const keywords = {
            simple_refactor: ['refactor', 'clean', 'improve', 'optimize', 'simplify'],
            code_standardization: ['standardize', 'format', 'consistent', 'convention', 'style'],
            modularization: ['modularize', 'extract', 'separate', 'split', 'organize'],
            feature_addition: ['add', 'implement', 'create', 'build', 'new feature'],
            bug_fix: ['fix', 'bug', 'error', 'issue', 'problem'],
            major_restructure: ['restructure', 'redesign', 'architecture', 'overhaul']
        };

        let bestMatch: keyof typeof keywords = 'simple_refactor';
        let maxScore = 0;

        for (const [type, keywordList] of Object.entries(keywords)) {
            const score = keywordList.reduce((acc, keyword) => {
                return acc + (goalLower.includes(keyword) ? 1 : 0);
            }, 0);

            if (score > maxScore) {
                maxScore = score;
                bestMatch = type as keyof typeof keywords;
            }
        }

        // Determine batch count and file creation needs
        let suggestedBatchCount: number;
        let requiresNewFiles: boolean;

        switch (bestMatch) {
            case 'simple_refactor':
            case 'code_standardization':
                suggestedBatchCount = fileCount === 1 ? 1 : Math.min(2, fileCount);
                requiresNewFiles = false;
                break;
            case 'bug_fix':
                suggestedBatchCount = 1;
                requiresNewFiles = false;
                break;
            case 'modularization':
                suggestedBatchCount = Math.min(4, Math.max(2, Math.ceil(fileCount * 1.5)));
                requiresNewFiles = true;
                break;
            case 'feature_addition':
                suggestedBatchCount = Math.min(6, Math.max(3, fileCount + 2));
                requiresNewFiles = goalLower.includes('new') || goalLower.includes('create');
                break;
            case 'major_restructure':
                suggestedBatchCount = Math.min(8, Math.max(4, fileCount * 2));
                requiresNewFiles = true;
                break;
            default:
                suggestedBatchCount = 3;
                requiresNewFiles = false;
        }

        const confidence = maxScore > 0 ? Math.min(0.9, maxScore * 0.3 + 0.4) : 0.3;

        return {
            changeType: bestMatch,
            confidence,
            reason: `Detected ${bestMatch.replace('_', ' ')} based on keywords: ${keywords[bestMatch].filter(k => goalLower.includes(k)).join(', ')}`,
            suggestedBatchCount,
            requiresNewFiles
        };
    }

    /**
     * Calculates file complexity based on multiple factors
     */
    private calculateFileComplexity(lineCount: number, entityCount: number, dependencyCount: number): 'simple' | 'moderate' | 'complex' {
        const complexityScore = (lineCount / 100) + (entityCount * 2) + (dependencyCount * 1.5);

        if (complexityScore < 5) return 'simple';
        if (complexityScore < 15) return 'moderate';
        return 'complex';
    }

    /**
     * Creates intelligent chunks for large files
     */
    private createFileChunks(content: string, complexity: 'simple' | 'moderate' | 'complex', lineCount: number): FileChunk[] {
        const lines = content.split('\n');

        // Don't chunk simple files or small files
        if (complexity === 'simple' || lineCount < 200) {
            return [{
                content,
                startLine: 1,
                endLine: lineCount,
                entities: [],
                summary: `Complete file (${lineCount} lines)`
            }];
        }

        const chunks: FileChunk[] = [];
        const chunkSize = complexity === 'complex' ? 150 : 300;

        for (let i = 0; i < lines.length; i += chunkSize) {
            const chunkLines = lines.slice(i, i + chunkSize);
            const startLine = i + 1;
            const endLine = Math.min(i + chunkSize, lines.length);

            chunks.push({
                content: chunkLines.join('\n'),
                startLine,
                endLine,
                entities: this.extractEntitiesFromChunk(chunkLines.join('\n')),
                summary: `Lines ${startLine}-${endLine} (${chunkLines.length} lines)`
            });
        }

        return chunks;
    }

    /**
     * Extracts basic entities from a chunk without using parsers (fallback method)
     */
    private extractEntitiesFromChunk(content: string): string[] {
        const entities: string[] = [];

        // Basic regex patterns for common entities across languages
        const patterns = [
            /(?:class|interface|enum)\s+(\w+)/g,
            /(?:function|def|func)\s+(\w+)/g,
            /(?:const|let|var)\s+(\w+)/g,
            /(\w+)\s*[:=]\s*(?:function|\([^)]*\)\s*=>)/g
        ];

        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(content)) !== null) {
                entities.push(match[1]);
            }
        }

        return [...new Set(entities)]; // Remove duplicates
    }

    /**
     * Calculates overall complexity from all files
     */
    private calculateTotalComplexity(
        fileAnalyses: FileAnalysis[],
        goalAnalysis: ChangeTypeAnalysis
    ): 'simple' | 'moderate' | 'complex' {
        const complexityScores = { simple: 1, moderate: 2, complex: 3 };

        const avgFileComplexity = fileAnalyses.reduce((sum, file) =>
            sum + complexityScores[file.complexity], 0) / fileAnalyses.length;

        const goalComplexity = goalAnalysis.changeType === 'major_restructure' ? 3 :
                              goalAnalysis.changeType === 'modularization' ? 2.5 :
                              goalAnalysis.changeType === 'feature_addition' ? 2 : 1;

        const totalScore = (avgFileComplexity + goalComplexity) / 2;

        if (totalScore < 1.5) return 'simple';
        if (totalScore < 2.5) return 'moderate';
        return 'complex';
    }

    /**
     * Determines the recommended planning strategy
     */
    private determineStrategy(
        goalAnalysis: ChangeTypeAnalysis,
        totalComplexity: 'simple' | 'moderate' | 'complex',
        fileCount: number
    ): 'single_task' | 'simple_plan' | 'moderate_plan' | 'complex_plan' {
        // Single task for very simple changes
        if (goalAnalysis.changeType === 'bug_fix' ||
            (goalAnalysis.changeType === 'simple_refactor' && fileCount === 1 && totalComplexity === 'simple')) {
            return 'single_task';
        }

        // Simple plan for basic refactoring and standardization
        if ((goalAnalysis.changeType === 'simple_refactor' || goalAnalysis.changeType === 'code_standardization') &&
            totalComplexity !== 'complex') {
            return 'simple_plan';
        }

        // Complex plan for major changes
        if (goalAnalysis.changeType === 'major_restructure' ||
            (goalAnalysis.changeType === 'modularization' && totalComplexity === 'complex') ||
            (goalAnalysis.changeType === 'feature_addition' && fileCount > 5)) {
            return 'complex_plan';
        }

        // Default to moderate plan
        return 'moderate_plan';
    }

    /**
     * Generates human-readable analysis reason
     */
    private generateAnalysisReason(complexity: 'simple' | 'moderate' | 'complex', lineCount: number, entityCount: number): string {
        return `Classified as ${complexity} based on ${lineCount} lines, ${entityCount} entities`;
    }

    /**
     * Gets formatted file content for AI consumption (chunked if needed)
     */
    getFormattedFileContent(fileAnalysis: FileAnalysis): string {
        if (fileAnalysis.chunks.length === 1) {
            return `FILE: ${fileAnalysis.filePath} (${fileAnalysis.complexity} complexity)
${fileAnalysis.chunks[0].content}`;
        }

        return fileAnalysis.chunks.map((chunk, index) =>
            `FILE CHUNK ${index + 1}: ${fileAnalysis.filePath} (${chunk.summary})
ENTITIES: ${chunk.entities.join(', ') || 'None detected'}
${chunk.content}`
        ).join('\n\n---\n\n');
    }
}