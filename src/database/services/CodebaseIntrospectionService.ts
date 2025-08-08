// src/services/CodebaseIntrospectionService.ts
import fs from 'fs/promises';
import { Stats } from 'fs';
import path from 'path';
import { MemoryManager } from '../memory_manager.js';
import { GeminiIntegrationService } from './GeminiIntegrationService.js';
// Import all language parsers
import { EnhancedTypeScriptParser } from '../parsers/EnhancedTypeScriptParser.js';
import { PythonParser } from '../parsers/PythonParser.js';
import { HTMLParser } from '../parsers/HTMLParser.js';
import { CSSParser } from '../parsers/CSSParser.js';
import { EnhancedPHPParser } from '../parsers/EnhancedPHPParser.js';
import { JSONLParser } from '../parsers/JSONLParser.js';
import { MarkdownParser } from '../parsers/MarkdownParser.js';
import { TailwindCSSParser } from '../parsers/TailwindCSSParser.js';
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
    type: 'class' | 'function' | 'interface' | 'method' | 'property' | 'variable' | 'enum' | 'type_alias' | 'module' | 'call_signature' | 'construct_signature' | 'index_signature' | 'parameter_property' | 'abstract_method' | 'declare_function' | 'namespace_export' | 'control_flow' | 'code_block' | 'unknown' | 'html_element' | 'html_id_selector' | 'html_class_selector' | 'html_attribute_selector' | 'html_text_content' | 'comment' | 'tailwind_utility_class';
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
    // The `className` property is redundant, as `parentClass` provides the same information with better context.
    metadata?: any;
    calls?: Array<{ name: string; type?: string; }>; // Updated to be more flexible
    accessibility?: 'public' | 'private' | 'protected' | null; // New property for method/property accessibility
}


export class CodebaseIntrospectionService {
    private static readonly IGNORED_DIRECTORIES = new Set([
        'node_modules', '.git', '.vscode', 'dist', 'build', '.DS_Store', 'coverage', 'target', 'out'
    ]);

    private static readonly NON_CODE_EXTENSIONS = new Set([
        '.txt', '.log', '.gitignore', '.npmignore', '.editorconfig', '.gitattributes',
        '.gitmodules', '.prettierrc', '.eslintrc', '.vscode', '.idea', '.env', '.sample',
        '.example', '.lock', '.map', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico',
        '.woff', '.woff2', '.ttf', '.eot', '.otf', '.zip', '.tar', '.gz', '.rar', '.7z',
        '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.sqlite', '.db',
        '.sql', '.csv', '.xml'
    ]);

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
        [
            new EnhancedTypeScriptParser(this.projectRootPath),
            new PythonParser(this.projectRootPath),
            new HTMLParser(this.projectRootPath),
            new CSSParser(this.projectRootPath),
            new EnhancedPHPParser(this.projectRootPath),
            new JSONLParser(this),
            new MarkdownParser(this.projectRootPath),
            new TailwindCSSParser(this.projectRootPath)
        ].forEach(parser => this.registerParser(parser));
    }

    private registerParser(parser: ILanguageParser | BaseLanguageParser): void {
        parser.getSupportedExtensions().forEach(ext => this.languageParsers.set(ext, parser));
        this.languageParsers.set(parser.getLanguageName(), parser);
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
                    if (CodebaseIntrospectionService.IGNORED_DIRECTORIES.has(item.name) || item.name.startsWith('.')) {
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

        // First, check if a specific parser is registered for the extension
        if (this.languageParsers.has(extension)) {
            return this.languageParsers.get(extension)!.getLanguageName();
        }

        // If no specific parser, check our denylist of non-code extensions
        if (CodebaseIntrospectionService.NON_CODE_EXTENSIONS.has(extension) || fileName.startsWith('.')) {
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

    private async getParserAndCode(
        agentId: string,
        filePath: string,
        fileLanguage?: string
    ): Promise<{ parser: ILanguageParser, code: string } | null> {
        const lang = fileLanguage || await this.detectLanguage(agentId, filePath, path.basename(filePath));
        const ext = path.extname(filePath).toLowerCase();
        const parser = this.languageParsers.get(ext) || (lang ? this.languageParsers.get(lang) : undefined);

        if (!parser) {
            // Only warn if a language was detected but no parser was found.
            if (lang) {
                console.warn(`Parsing for language '${lang}' in ${filePath} is not supported by any registered parser. Skipping.`);
            }
            return null;
        }

        try {
            const code = await fs.readFile(filePath, 'utf-8');
            return { parser, code };
        } catch (readError) {
            console.error(`Error reading file ${filePath} for parsing:`, readError);
            return null;
        }
    }

    public async parseFileForImports(
        agentId: string,
        filePath: string,
        fileLanguage?: string
    ): Promise<ExtractedImport[]> {
        const parseInfo = await this.getParserAndCode(agentId, filePath, fileLanguage);
        if (!parseInfo) {
            return [];
        }
        const { parser, code } = parseInfo;
        return parser.parseImports(filePath, code);
    }

    public async parseFileForCodeEntities(
        agentId: string,
        filePath: string,
        fileLanguage?: string
    ): Promise<ExtractedCodeEntity[]> {
        const parseInfo = await this.getParserAndCode(agentId, filePath, fileLanguage);
        if (!parseInfo) {
            return [];
        }
        const { parser, code } = parseInfo;
        return parser.parseCodeEntities(filePath, code, this.projectRootPath);
    }
}
