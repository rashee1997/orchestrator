/**
 * Type definitions for file operations services
 */

export interface FileReadOptions {
    query: string;
    patterns?: string[];
    maxFiles?: number;
    maxFileSize?: number;
    searchContent?: boolean;
    contentKeywords?: string[];
    caseSensitive?: boolean;
    rootDir?: string;
    excludeDirs?: string[];
    excludeExtensions?: string[];
}

export interface FileReadResult {
    path: string;
    relativePath: string;
    content: string;
    size: number;
    extension: string;
    lastModified: Date;
    lines: number;
    encoding: 'utf-8' | 'binary' | 'unsupported';
    detectedLanguages?: string[];
    matchedKeywords?: string[];
    error?: string;
}

export interface ProjectContext {
    rootDir: string;
    projectType: string;
    primaryLanguage: string;
    frameworks: string[];
    folderStructure: {
        hasSource: boolean;
        sourceDir: string;
        hasComponents: boolean;
        hasServices: boolean;
        hasUtils: boolean;
        hasTests: boolean;
    };
    packageInfo?: {
        name: string;
        version: string;
        dependencies: string[];
        devDependencies: string[];
    };
}

export interface FileReadServiceResult {
    files: FileReadResult[];
    totalFilesFound: number;
    totalFilesRead: number;
    searchTimeMs: number;
    errors: string[];
    projectContext: ProjectContext;
    searchPatterns: string[];
    patternSource: 'user_provided' | 'ai_generated' | 'rule_based' | 'project_analysis';
}

export interface PatternGenerationOptions {
    useAI?: boolean;
    maxPatterns?: number;
    includeTests?: boolean;
    includeConfigs?: boolean;
}

export interface ProjectMarker {
    file: string;
    indicates: string;
    priority: number;
}

export interface LanguageExtensionMap {
    [language: string]: string[];
}

export interface FrameworkDetectionMap {
    [dependency: string]: string;
}