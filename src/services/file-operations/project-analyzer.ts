import { promises as fs } from 'fs';
import path from 'path';
import { ProjectContext, ProjectMarker, FrameworkDetectionMap } from './types.js';

/**
 * Project Analysis Service
 * Analyzes project structure, technology stack, and context
 */
export class ProjectAnalyzer {
    private contextCache = new Map<string, ProjectContext>();

    private readonly PROJECT_MARKERS: ProjectMarker[] = [
        { file: 'package.json', indicates: 'node', priority: 10 },
        { file: 'tsconfig.json', indicates: 'typescript', priority: 9 },
        { file: 'pyproject.toml', indicates: 'python', priority: 8 },
        { file: 'Cargo.toml', indicates: 'rust', priority: 8 },
        { file: 'go.mod', indicates: 'go', priority: 8 },
        { file: 'composer.json', indicates: 'php', priority: 7 },
        { file: 'pom.xml', indicates: 'java-maven', priority: 7 },
        { file: 'build.gradle', indicates: 'java-gradle', priority: 7 },
        { file: '.git', indicates: 'git-repo', priority: 5 }
    ];

    private readonly FRAMEWORK_MAP: FrameworkDetectionMap = {
        'react': 'react',
        '@types/react': 'react',
        'next': 'nextjs',
        'express': 'express',
        'fastify': 'fastify',
        'vue': 'vue',
        'angular': 'angular',
        '@angular/core': 'angular',
        'svelte': 'svelte',
        'jest': 'jest',
        'mocha': 'mocha',
        'typescript': 'typescript',
        'webpack': 'webpack',
        'vite': 'vite',
        'rollup': 'rollup'
    };

    /**
     * Analyze project context from root directory
     */
    async analyzeProject(rootDir?: string): Promise<ProjectContext> {
        // Prioritize explicit root path if provided. Otherwise, attempt autonomous detection.
        const projectRoot = rootDir ? path.resolve(rootDir) : await this.findProjectRoot();

        // Check cache
        if (this.contextCache.has(projectRoot)) {
            return this.contextCache.get(projectRoot)!;
        }

        console.log(`[ProjectAnalyzer] 🔍 Analyzing project at: ${projectRoot}`);
        if (rootDir) {
            console.log(`[ProjectAnalyzer] 📝 Using explicit root path provided by user.`);
        }


        const context: ProjectContext = {
            rootDir: projectRoot,
            projectType: 'unknown',
            primaryLanguage: 'unknown',
            frameworks: [],
            folderStructure: {
                hasSource: false,
                sourceDir: '.',
                hasComponents: false,
                hasServices: false,
                hasUtils: false,
                hasTests: false
            }
        };

        try {
            // Run analysis steps
            await this.analyzePackageJson(context);
            await this.analyzeConfigFiles(context);
            await this.analyzeFolderStructure(context);
            await this.detectPrimaryLanguage(context);
            await this.detectFrameworks(context);

            console.log(`[ProjectAnalyzer] ✅ Analysis complete: ${context.projectType} (${context.primaryLanguage})`);
        } catch (error) {
            console.warn('[ProjectAnalyzer] ⚠️ Analysis incomplete:', error);
        }

        // Cache result
        this.contextCache.set(projectRoot, context);
        return context;
    }

    /**
     * Find project root by looking for markers
     */
    async findProjectRoot(startDir: string = process.cwd()): Promise<string> {
        let currentDir = startDir;
        let bestMatch = { dir: currentDir, priority: 0 };

        while (true) {
            // Check all markers in current directory
            for (const marker of this.PROJECT_MARKERS) {
                try {
                    await fs.access(path.join(currentDir, marker.file));
                    if (marker.priority > bestMatch.priority) {
                        bestMatch = { dir: currentDir, priority: marker.priority };
                    }
                    console.log(`[ProjectAnalyzer] 📍 Found ${marker.file} in ${currentDir}`);
                } catch {
                    continue;
                }
            }

            const parentDir = path.dirname(currentDir);
            if (parentDir === currentDir) break;
            currentDir = parentDir;
        }

        const rootDir = bestMatch.priority > 0 ? bestMatch.dir : process.cwd();
        console.log(`[ProjectAnalyzer] 🎯 Project root: ${rootDir}`);
        return rootDir;
    }

    /**
     * Analyze package.json for Node.js projects
     */
    private async analyzePackageJson(context: ProjectContext): Promise<void> {
        const packagePath = path.join(context.rootDir, 'package.json');

        try {
            const content = await fs.readFile(packagePath, 'utf-8');
            const packageJson = JSON.parse(content);

            context.packageInfo = {
                name: packageJson.name || 'unknown',
                version: packageJson.version || '0.0.0',
                dependencies: Object.keys(packageJson.dependencies || {}),
                devDependencies: Object.keys(packageJson.devDependencies || {})
            };

            // Determine project type
            if (packageJson.type === 'module') {
                context.projectType = 'node-esm';
            } else {
                context.projectType = 'node-cjs';
            }

            console.log(`[ProjectAnalyzer] 📦 Package: ${context.packageInfo.name} v${context.packageInfo.version}`);
        } catch {
            // Not a Node.js project
        }
    }

    /**
     * Analyze configuration files
     */
    private async analyzeConfigFiles(context: ProjectContext): Promise<void> {
        const configs = [
            { file: 'tsconfig.json', type: 'typescript', lang: 'typescript' },
            { file: 'pyproject.toml', type: 'python', lang: 'python' },
            { file: 'requirements.txt', type: 'python', lang: 'python' },
            { file: 'Cargo.toml', type: 'rust', lang: 'rust' },
            { file: 'go.mod', type: 'go', lang: 'go' },
            { file: 'composer.json', type: 'php', lang: 'php' }
        ];

        for (const config of configs) {
            if (await this.fileExists(context.rootDir, config.file)) {
                if (context.projectType === 'unknown') {
                    context.projectType = config.type;
                }
                if (context.primaryLanguage === 'unknown') {
                    context.primaryLanguage = config.lang;
                }
                console.log(`[ProjectAnalyzer] ⚙️ Found ${config.file} (${config.type})`);
            }
        }
    }

    /**
     * Analyze folder structure
     */
    private async analyzeFolderStructure(context: ProjectContext): Promise<void> {
        // Find source directory
        const sourceDirs = ['src', 'lib', 'app', 'source'];
        for (const dir of sourceDirs) {
            if (await this.directoryExists(context.rootDir, dir)) {
                context.folderStructure.hasSource = true;
                context.folderStructure.sourceDir = dir;
                console.log(`[ProjectAnalyzer] 📁 Source directory: ${dir}`);
                break;
            }
        }

        // Check for common subdirectories
        const subDirs = [
            { name: 'components', key: 'hasComponents' as const },
            { name: 'services', key: 'hasServices' as const },
            { name: 'utils', key: 'hasUtils' as const },
            { name: 'utilities', key: 'hasUtils' as const },
            { name: 'test', key: 'hasTests' as const },
            { name: 'tests', key: 'hasTests' as const },
            { name: '__tests__', key: 'hasTests' as const }
        ];

        for (const subDir of subDirs) {
            const hasInSource = await this.directoryExists(
                context.rootDir,
                path.join(context.folderStructure.sourceDir, subDir.name)
            );
            const hasInRoot = await this.directoryExists(context.rootDir, subDir.name);

            if (hasInSource || hasInRoot) {
                context.folderStructure[subDir.key] = true;
            }
        }
    }

    /**
     * Detect primary programming language
     */
    private async detectPrimaryLanguage(context: ProjectContext): Promise<void> {
        if (context.primaryLanguage !== 'unknown') {
            return;
        }

        // Language detection based on project type
        const languageMap: Record<string, string> = {
            'typescript': 'typescript',
            'node-esm': 'javascript',
            'node-cjs': 'javascript',
            'python': 'python',
            'rust': 'rust',
            'go': 'go',
            'php': 'php',
            'java-maven': 'java',
            'java-gradle': 'java'
        };

        context.primaryLanguage = languageMap[context.projectType] || 'unknown';

        // Additional checks for TypeScript
        if (context.primaryLanguage === 'javascript' &&
            (await this.fileExists(context.rootDir, 'tsconfig.json') ||
             context.packageInfo?.devDependencies.includes('typescript') ||
             context.packageInfo?.dependencies.includes('typescript'))) {
            context.primaryLanguage = 'typescript';
        }

        console.log(`[ProjectAnalyzer] 🔤 Primary language: ${context.primaryLanguage}`);
    }

    /**
     * Detect frameworks and libraries
     */
    private async detectFrameworks(context: ProjectContext): Promise<void> {
        if (!context.packageInfo) {
            return;
        }

        const allDeps = [
            ...context.packageInfo.dependencies,
            ...context.packageInfo.devDependencies
        ];

        const frameworks = new Set<string>();

        // Check against framework map
        for (const dep of allDeps) {
            if (this.FRAMEWORK_MAP[dep]) {
                frameworks.add(this.FRAMEWORK_MAP[dep]);
            }

            // Special cases
            if (dep.startsWith('@angular/')) {
                frameworks.add('angular');
            }
            if (dep.startsWith('@types/')) {
                frameworks.add('typescript');
            }
        }

        context.frameworks = Array.from(frameworks);
        console.log(`[ProjectAnalyzer] 🛠️ Frameworks: ${context.frameworks.join(', ') || 'none'}`);
    }

    /**
     * Check if file exists
     */
    private async fileExists(rootDir: string, filename: string): Promise<boolean> {
        try {
            const stats = await fs.stat(path.join(rootDir, filename));
            return stats.isFile();
        } catch {
            return false;
        }
    }

    /**
     * Check if directory exists
     */
    private async directoryExists(rootDir: string, dirname: string): Promise<boolean> {
        try {
            const stats = await fs.stat(path.join(rootDir, dirname));
            return stats.isDirectory();
        } catch {
            return false;
        }
    }

    /**
     * Get basic fallback context
     */
    getBasicContext(rootDir?: string): ProjectContext {
        return {
            rootDir: rootDir || process.cwd(),
            projectType: 'unknown',
            primaryLanguage: 'unknown',
            frameworks: [],
            folderStructure: {
                hasSource: false,
                sourceDir: '.',
                hasComponents: false,
                hasServices: false,
                hasUtils: false,
                hasTests: false
            }
        };
    }

    /**
     * Clear cache
     */
    clearCache(): void {
        this.contextCache.clear();
    }
}