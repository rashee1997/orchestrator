// src/services/CodebaseIntrospectionService.ts
import fs from 'fs/promises';
import { Stats } from 'fs';
import path from 'path';
import { MemoryManager } from '../memory_manager.js';
import { GeminiIntegrationService } from './GeminiIntegrationService.js';
// Import all language parsers
import type { ILanguageParser } from '../parsers/ILanguageParser.js';
import { ParserFactory } from '../parsers/ParserFactory.js';

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
    // Directories that should always be ignored during recursive scans.
    private static readonly IGNORED_DIRECTORY_NAMES = new Set([
        'node_modules', '.git', '.vscode', 'dist', 'build', 'coverage', 'target', 'out',
        '.svn', '.hg', '.bzr', '.idea', '.next', '.nuxt', '.parcel-cache', '.rollup.cache', '.webpack',
        '.cache', '.expo', '.direnv', '.terraform', '.serverless', '.aws-sam', '.nyc_output', '.cpcache',
        '.pnp', '.pnpm-store', '.npm', '.yarn', 'amplify', 'bin', 'obj', 'debug', 'release', '.vs',
        '.user', '.suo', '.venv', 'venv', 'env', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
        'log', 'logs', 'tmp', 'temp' // These can be directories or files, safer to ignore as directories too.
    ]);

    // File extensions that typically do not contain source code or are build artifacts/temporary files.
    private static readonly IGNORED_FILE_EXTENSIONS = new Set([
        '.txt', '.log', '.gitignore', '.npmignore', '.editorconfig', '.gitattributes',
        '.gitmodules', '.prettierrc', '.eslintrc', '.env', '.sample', '.example',
        '.lock', '.map', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico',
        '.woff', '.woff2', '.ttf', '.eot', '.otf', '.zip', '.tar', '.gz', '.rar', '.7z',
        '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.sqlite', '.db',
        '.sql', '.csv', '.xml',
        // Add extensions from the old DENY_LIST_BASENAMES that were wildcards
        '.bak', '.tmp', '.swp', '.swo', '.swn', '.exe', '.dll', '.obj', '.lib', '.bin', '.out',
        '.diff', '.patch', '.rej', '.orig'
    ]);

    // Specific file basenames (e.g., package.json, .env files) that should be ignored.
    private static readonly IGNORED_FILE_BASENAMES = new Set([
        '.DS_Store', // Moved from IGNORED_DIRECTORIES
        'package-lock.json', 'yarn.lock', '.npmignore',
        '.env', '.env.local', '.env.development', '.env.production', '.env.test',
        '.gitignore', '.gitattributes', '.editorconfig', '.prettierrc', '.eslintrc',
        'Thumbs.db', 'ehthumbs.db', 'desktop.ini', 'npm-debug.log', 'yarn-debug.log', 'yarn-error.log',
        '.project', '.classpath', '.settings', '.factorypath',
        'lerna.json', 'firebase.json', 'netlify.toml', 'vercel.json', 'aws-exports.js',
        'serverless.yml', 'cloudformation.yaml', 'jest.config.js', 'babel.config.js',
        'webpack.config.js', 'rollup.config.js', 'tailwind.config.js', 'postcss.config.js',
        'tsconfig.json', 'jsconfig.json', 'tslint.json', 'nodemon.json',
        '.prettierignore', '.eslintignore', '.dockerignore', 'docker-compose.yml', 'Dockerfile',
        'Vagrantfile', 'Makefile', 'CMakeLists.txt', 'Rakefile', 'Gemfile', 'Gemfile.lock',
        'composer.json', 'composer.lock', 'phpcs.xml', 'phpunit.xml', 'pyproject.toml',
        'Pipfile', 'Pipfile.lock', 'requirements.txt', '.python-version',
        '.terraform.lock.hcl',
        'package.json' // Keep this as it was in the original DENY_LIST_BASENAMES
    ]);

    private memoryManager: MemoryManager;
    private geminiService: GeminiIntegrationService | null = null;
    private projectRootPath: string;
    private languageParsers: Map<string, ILanguageParser>;
    private parserFactory: ParserFactory;

    constructor(memoryManager: MemoryManager, geminiService?: GeminiIntegrationService, projectRootPath?: string) {
        this.memoryManager = memoryManager;
        this.geminiService = geminiService || null;
        this.projectRootPath = projectRootPath || process.cwd();

        this.parserFactory = new ParserFactory(this.projectRootPath);

        this.languageParsers = new Map();
        this.parserFactory.getAllParsers(this)
            .forEach(parser => this.registerParser(parser));
    }

    private registerParser(parser: ILanguageParser): void {
        parser.getSupportedExtensions().forEach(ext => {
            if (this.languageParsers.has(ext)) {
                console.warn(`Warning: Duplicate parser registration for extension '${ext}'. Overwriting.`);
            }
            this.languageParsers.set(ext, parser);
        });
    }

    public setGeminiService(geminiService: GeminiIntegrationService): void {
        this.geminiService = geminiService;
    }

    /**
     * Determines if a given path (file or directory) should be ignored based on predefined rules.
     * @param itemPath The full path of the item.
     * @param isDirectory True if the item is a directory, false if it's a file.
     * @returns True if the item should be ignored, false otherwise.
     */
    private static shouldIgnore(itemPath: string, isDirectory: boolean): boolean {
        const basename = path.basename(itemPath);
        const extension = path.extname(basename).toLowerCase();

        if (isDirectory) {
            // Ignore explicitly listed directory names or any hidden directory (starts with '.')
            return CodebaseIntrospectionService.IGNORED_DIRECTORY_NAMES.has(basename) || basename.startsWith('.');
        } else { // It's a file
            // Ignore explicitly listed file basenames
            if (CodebaseIntrospectionService.IGNORED_FILE_BASENAMES.has(basename)) {
                return true;
            }
            // Ignore files with certain extensions
            if (CodebaseIntrospectionService.IGNORED_FILE_EXTENSIONS.has(extension)) {
                return true;
            }
            // No general ignore for dot-files here, as specific ones are in IGNORED_FILE_BASENAMES.
            return false;
        }
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
                    if (CodebaseIntrospectionService.shouldIgnore(fullPath, true)) {
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
                    if (CodebaseIntrospectionService.shouldIgnore(fullPath, false)) {
                        continue;
                    }
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
        // First, check if the file itself should be ignored based on its name or extension.
        if (CodebaseIntrospectionService.shouldIgnore(filePath, false)) {
            return undefined; // Do not attempt to detect language for these
        }

        const extension = path.extname(fileName).toLowerCase();

        // Then, check if a specific parser is registered for the extension
        if (this.languageParsers.has(extension)) {
            return this.languageParsers.get(extension)!.getLanguageName();
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