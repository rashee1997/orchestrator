// src/services/CodebaseIntrospectionService.ts
import fs from 'fs/promises';
import { Stats } from 'fs';
import path from 'path';
import { MemoryManager } from '../memory_manager.js';
import { GeminiIntegrationService } from './GeminiIntegrationService.js';
// Import all language parsers
import { TypeScriptParser } from '../parsers/TypeScriptParser.js';
import { PythonParser } from '../parsers/PythonParser.js';
import { HTMLParser } from '../parsers/HTMLParser.js';
import { CSSParser } from '../parsers/CSSParser.js';
import { PHPParser } from '../parsers/PHPParser.js';
import { JSONLParser } from '../parsers/JSONLParser.js';
import type { ILanguageParser, BaseLanguageParser } from '../parsers/ILanguageParser.js';

// ... (ScannedItem, ExtractedImport interfaces remain unchanged)
export interface ScannedItem {
    path: string;
    name: string;
    type: 'file' | 'directory';
    language?: string;
    stats: Stats;
}
export interface ExtractedImport {
    type: 'file' | 'module' | 'external_library';
    targetPath: string;
    originalImportString: string;
    importedSymbols?: string[];
    isDynamicImport?: boolean;
    isTypeOnlyImport?: boolean;
    startLine: number;
    endLine: number;
}

// MODIFICATION: Enhanced ExtractedCodeEntity to include richer metadata for embeddings.
export interface ExtractedCodeEntity {
    type: 'class' | 'function' | 'interface' | 'method' | 'property' | 'variable' | 'enum' | 'type_alias' | 'module' | 'call_signature' | 'construct_signature' | 'index_signature' | 'parameter_property' | 'abstract_method' | 'declare_function' | 'namespace_export' | 'control_flow' | 'unknown';
    name?: string; // Made optional
    fullName?: string; // Made optional
    signature?: string; // e.g., "function process(data: string): number"
    startLine: number;
    endLine: number;
    docstring?: string | null;
    parentClass?: string | null; // For methods, the name of the containing class
    implementedInterfaces?: string[]; // For classes
    parameters?: Array<{ name: string; type?: string; optional?: boolean; rest?: boolean; defaultValue?: string | null; }>;
    returnType?: string | null;
    isAsync?: boolean;
    isExported?: boolean;
    filePath: string; // Absolute path to the file
    containingDirectory: string; // NEW: Relative path of the containing directory
    className?: string; // Redundant? parentClass is better. Keep for now for compatibility.
    metadata?: any;
    calls?: Array<{ name: string; type: 'function' | 'method' | 'unknown'; }>; // New property
    accessibility?: 'public' | 'private' | 'protected' | null; // New property for method/property accessibility
}


export class CodebaseIntrospectionService {
    private memoryManager: MemoryManager;
    private geminiService: GeminiIntegrationService | null = null;
    private projectRootPath: string;
    private languageParsers: Map<string, ILanguageParser>;

    constructor(memoryManager: MemoryManager, geminiService?: GeminiIntegrationService, projectRootPath?: string) {
        this.memoryManager = memoryManager;
        this.geminiService = geminiService || null;
        this.projectRootPath = projectRootPath || process.cwd();
        // Register all language parsers
        this.languageParsers = new Map();
        const parsers: Array<ILanguageParser | BaseLanguageParser> = [
            new TypeScriptParser(this.projectRootPath),
            new PythonParser(this.projectRootPath),
            new HTMLParser(this.projectRootPath),
            new CSSParser(this.projectRootPath),
            new PHPParser(this.projectRootPath),
            new JSONLParser(this)
        ];
        for (const parser of parsers) {
            // Handle both BaseLanguageParser and ILanguageParser
            const extensions = parser.getSupportedExtensions();
            for (const ext of extensions) {
                this.languageParsers.set(ext, parser);
            }
            const langName = parser.getLanguageName();
            this.languageParsers.set(langName, parser);
        }
    }

    public setGeminiService(geminiService: GeminiIntegrationService): void {
        this.geminiService = geminiService;
    }

    public async scanDirectoryRecursive(
        agentId: string,
        directoryPath: string,
        rootPathToMakeRelative?: string
    ): Promise<ScannedItem[]> {
        const results: ScannedItem[] = [];
        const effectiveRootPath = rootPathToMakeRelative || directoryPath;
        try {
            const items = await fs.readdir(directoryPath, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.resolve(directoryPath, item.name);
                const relativePath = path.relative(effectiveRootPath, fullPath).replace(/\\/g, '/');
                if (item.isDirectory()) {
                    if ([
                        'node_modules', '.git', '.vscode', 'dist', 'build', '.DS_Store', 'coverage', 'target', 'out'
                    ].includes(item.name) || item.name.startsWith('.')) {
                        continue;
                    }
                    const stats = await fs.stat(fullPath);
                    results.push({
                        path: fullPath,
                        name: relativePath,
                        type: 'directory',
                        stats: stats,
                    });
                    results.push(...await this.scanDirectoryRecursive(agentId, fullPath, effectiveRootPath));
                } else if (item.isFile()) {
                    const stats = await fs.stat(fullPath);
                    const language = await this.detectLanguage(agentId, fullPath, item.name);
                    results.push({
                        path: fullPath,
                        name: relativePath,
                        type: 'file',
                        language: language,
                        stats: stats,
                    });
                }
            }
        } catch (error) {
            console.error(`Error scanning directory ${directoryPath}:`, error);
            throw new Error(`Failed to scan directory ${directoryPath}: ${(error as Error).message}`);
        }
        return results;
    }

    public async detectLanguage(
        agentId: string,
        filePath: string,
        fileName: string,
        useAIForUncertain: boolean = true
    ): Promise<string | undefined> {
        const extension = path.extname(fileName).toLowerCase();

        // Explicitly skip known non-code files or files that are handled by specific parsers
        // but should not be passed to generic code parsers like TypeScriptParser if misidentified.
        const nonCodeOrNonParsableExtensions = new Set([
            '.md', '.txt', '.log', '.gitignore', '.npmignore', '.editorconfig', '.gitattributes',
            '.gitmodules', '.prettierrc', '.eslintrc', '.vscode', '.idea', '.env', '.sample',
            '.example', '.lock', '.map', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico',
            '.woff', '.woff2', '.ttf', '.eot', '.otf', '.zip', '.tar', '.gz', '.rar', '.7z',
            '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.sqlite', '.db',
            '.sql', '.csv', '.xml'
        ]);

        // First, check if a specific parser is registered for the extension
        if (this.languageParsers.has(extension)) {
            return this.languageParsers.get(extension)!.getLanguageName();
        }

        // If no specific parser, check if it's a known non-code file
        if (nonCodeOrNonParsableExtensions.has(extension) || fileName.startsWith('.')) {
            return undefined; // Do not attempt to detect language for these
        }

        // If still uncertain, try AI detection
        if (useAIForUncertain) {
            try {
                const aiDetectedLang = await this.detectLanguageWithAI(agentId, filePath);
                if (aiDetectedLang && aiDetectedLang !== 'unknown') {
                    return aiDetectedLang;
                }
            } catch (aiError) {
                console.warn(`AI language detection failed for ${filePath}:`, aiError);
            }
        }
        return undefined;
    }

    private async detectLanguageWithAI(agentId: string, filePath: string): Promise<string | undefined> {
        if (!this.geminiService) {
            console.warn('GeminiIntegrationService not available for AI language detection');
            return undefined;
        }
        let fileContentSnippet: string;
        try {
            const buffer = Buffer.alloc(2048);
            const fd = await fs.open(filePath, 'r');
            const { bytesRead } = await fd.read(buffer, 0, 2048, 0);
            await fd.close();
            fileContentSnippet = buffer.toString('utf-8', 0, bytesRead);
        } catch (readError) {
            console.error(`Could not read snippet from ${filePath} for AI language detection:`, readError);
            return undefined;
        }
        if (!fileContentSnippet.trim()) {
            return undefined;
        }
        const prompt = `Analyze the following code snippet and identify its primary programming language.\nRespond with only the lowercase name of the language (e.g., "python", "javascript", "java", "csharp", "html", "css", "unknown" if not identifiable or not code).\n\nSnippet:\n\
${fileContentSnippet}\n\
Language:`;
        try {
            const response = await this.geminiService.askGemini(prompt, "gemini-2.5-flash-preview-05-20");
            if (response.content && response.content.length > 0 && response.content[0].text) {
                const detectedLang = response.content[0].text.trim().toLowerCase();
                if (detectedLang && detectedLang !== "unknown" && detectedLang.length < 20 && /^[a-z0-9#+]+$/.test(detectedLang)) {
                    return detectedLang;
                }
                return undefined;
            }
        } catch (error) {
            console.error(`Error using Gemini for language detection on ${filePath}:`, error);
        }
        return undefined;
    }

    public async parseFileForImports(
        agentId: string,
        filePath: string,
        fileLanguage?: string
    ): Promise<ExtractedImport[]> {
        const lang = fileLanguage || await this.detectLanguage(agentId, filePath, path.basename(filePath));
        const ext = path.extname(filePath).toLowerCase();
        const parser = this.languageParsers.get(ext) || (lang ? this.languageParsers.get(lang) : undefined);
        if (!parser) {
            console.warn(`Import parsing for language '${lang}' in ${filePath} is not supported by any registered parser. Skipping.`);
            return [];
        }
        let code: string;
        try {
            code = await fs.readFile(filePath, 'utf-8');
        } catch (readError) {
            console.error(`Error reading file ${filePath} for import parsing:`, readError);
            return [];
        }
        return parser.parseImports(filePath, code);
    }

    public async parseFileForCodeEntities(
        agentId: string,
        filePath: string,
        fileLanguage?: string
    ): Promise<ExtractedCodeEntity[]> {
        const lang = fileLanguage || await this.detectLanguage(agentId, filePath, path.basename(filePath));
        const ext = path.extname(filePath).toLowerCase();
        const parser = this.languageParsers.get(ext) || (lang ? this.languageParsers.get(lang) : undefined);
        if (!parser) {
            console.warn(`Code entity parsing for language '${lang}' in ${filePath} is not supported by any registered parser. Skipping.`);
            return [];
        }
        let code: string;
        try {
            code = await fs.readFile(filePath, 'utf-8');
        } catch (readError) {
            console.error(`Error reading file ${filePath} for entity parsing:`, readError);
            return [];
        }
        return parser.parseCodeEntities(filePath, code, this.projectRootPath);
    }
}
