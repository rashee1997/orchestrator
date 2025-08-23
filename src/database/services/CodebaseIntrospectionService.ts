import fs from 'fs/promises';
import { Stats } from 'fs';
import path from 'path';
import { MemoryManager } from '../memory_manager.js';
import { GeminiIntegrationService } from './GeminiIntegrationService.js';
import { ILanguageParser } from '../parsers/ILanguageParser.js';
import { ParserFactory } from '../parsers/ParserFactory.js';
import { DETECT_LANGUAGE_PROMPT } from './gemini-integration-modules/GeminiPromptTemplates.js';

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

export interface ExtractedCodeEntity {
    type: 'class' | 'function' | 'interface' | 'method' | 'property' | 'variable' | 'enum' | 'type_alias' | 'module' | 'call_signature' | 'construct_signature' | 'index_signature' | 'parameter_property' | 'abstract_method' | 'declare_function' | 'namespace_export' | 'control_flow' | 'code_block' | 'unknown' | 'html_element' | 'html_id_selector' | 'html_class_selector' | 'html_attribute_selector' | 'html_text_content' | 'comment' | 'tailwind_utility_class';
    name?: string;
    fullName?: string;
    signature?: string;
    startLine: number;
    endLine: number;
    docstring?: string | null;
    parentClass?: string | null;
    implementedInterfaces?: string[];
    parameters?: Array<{ name: string; type?: string; optional?: boolean; rest?: boolean; defaultValue?: string | null; }>;
    returnType?: string | null;
    isAsync?: boolean;
    isExported?: boolean;
    filePath: string;
    containingDirectory: string;
    metadata?: any;
    calls?: Array<{ name: string; type?: string; }>;
    accessibility?: 'public' | 'private' | 'protected' | null;
}

export class CodebaseIntrospectionService {
    private static readonly IGNORED_DIRECTORY_NAMES = new Set([
        'node_modules', '.git', '.vscode', 'dist', 'build', 'coverage', 'target', 'out',
        '.svn', '.hg', '.bzr', '.idea', '.next', '.nuxt', '.parcel-cache', '.webpack',
        '.cache', '.expo', '.direnv', '.terraform', '.serverless', '.aws-sam', '.nyc_output', '.cpcache',
        '.pnp', '.pnpm-store', '.npm', '.yarn', 'amplify', 'bin', 'obj', 'debug', 'release', '.vs',
        '.user', '.suo', '.venv', 'venv', 'env', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
        'log', 'logs', 'tmp', 'temp'
    ]);

    private static readonly IGNORED_FILE_EXTENSIONS = new Set([
        '.txt', '.log', '.gitignore', '.npmignore', '.editorconfig', '.gitattributes',
        '.gitmodules', '.prettierrc', '.eslintrc', '.env', '.sample', '.example',
        '.lock', '.map', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico',
        '.woff', '.woff2', '.ttf', '.eot', '.otf', '.zip', '.tar', '.gz', '.rar', '.7z',
        '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.sqlite', '.db',
        '.sql', '.csv', '.xml', '.bak', '.tmp', '.swp', '.swo', '.swn', '.exe', '.dll',
        '.obj', '.lib', '.bin', '.out', '.diff', '.patch', '.rej', '.orig'
    ]);

    private static readonly IGNORED_FILE_BASENAMES = new Set([
        '.DS_Store', 'package-lock.json', 'yarn.lock', '.npmignore',
        '.env', '.env.local', '.env.development', '.env.production', '.env.test',
        '.gitignore', '.gitattributes', '.editorconfig', '.prettierrc', '.eslintrc',
        'Thumbs.db', 'ehthumbs.db', 'desktop.ini', 'npm-debug.log', 'yarn-debug.log', 'yarn-error.log',
        '.project', '.classpath', '.settings', '.factorypath',
        'lerna.json', 'firebase.json', 'netlify.toml', 'vercel.json', 'aws-exports.js',
        'serverless.yml', 'cloudformation.yaml', 'jest.config.js', 'babel.config.js',
        'webpack.config.js', 'rollup.config.js', 'tailwind.config.js', 'postcss.config.js',
        'tsconfig.json', 'jsconfig.json', 'tslint.json', 'nodemon.json',
        'Vagrantfile', 'Makefile', 'CMakeLists.txt', 'Rakefile', 'Gemfile', 'Gemfile.lock',
        'composer.json', 'composer.lock', 'phpcs.xml', 'phpunit.xml', 'pyproject.toml',
        'Pipfile', 'Pipfile.lock', 'requirements.txt', '.python-version',
        '.terraform.lock.hcl', 'package.json'
    ]);

    private memoryManager: MemoryManager;
    private geminiService: GeminiIntegrationService | null = null;
    private projectRootPath: string;
    private languageParsers: Map<string, ILanguageParser>;
    private parserFactory: ParserFactory;
    private scanCache: Map<string, { timestamp: number; data: ScannedItem[]; }>;
    private parserCache: Map<string, { timestamp: number; data: ExtractedCodeEntity[]; }>;
    private maxCacheSize: number;
    private cacheTTL: number;

    constructor(memoryManager: MemoryManager, geminiService?: GeminiIntegrationService, projectRootPath?: string) {
        this.memoryManager = memoryManager;
        this.geminiService = geminiService || null;
        this.projectRootPath = projectRootPath || process.cwd();
        this.parserFactory = new ParserFactory(this.projectRootPath);
        this.languageParsers = new Map();
        this.scanCache = new Map<string, { timestamp: number; data: ScannedItem[]; }>();
        this.parserCache = new Map<string, { timestamp: number; data: ExtractedCodeEntity[]; }>();
        this.maxCacheSize = 1000;
        this.cacheTTL = 30 * 60 * 1000; // 30 minutes

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

    private _generateCacheKey(prefix: string, ...args: string[]): string {
        return `${prefix}:${args.join(':')}`;
    }

    private _isCacheValid(timestamp: number): boolean {
        return (Date.now() - timestamp) < this.cacheTTL;
    }

    private _cleanupCache<T>(cache: Map<string, { timestamp: number; data: T[] }>): void {
        if (cache.size > this.maxCacheSize) {
            const entries = Array.from(cache.entries());
            entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

            const toRemove = entries.slice(0, Math.floor(this.maxCacheSize * 0.3));
            toRemove.forEach(([key]) => cache.delete(key));

            console.log(`[CodebaseIntrospectionService] Cleaned up ${toRemove.length} expired cache entries`);
        }
    }

    private static shouldIgnore(itemPath: string, isDirectory: boolean): boolean {
        const basename = path.basename(itemPath);
        const extension = path.extname(basename).toLowerCase();

        if (isDirectory) {
            return CodebaseIntrospectionService.IGNORED_DIRECTORY_NAMES.has(basename) || basename.startsWith('.');
        } else {
            if (CodebaseIntrospectionService.IGNORED_FILE_BASENAMES.has(basename)) {
                return true;
            }
            if (CodebaseIntrospectionService.IGNORED_FILE_EXTENSIONS.has(extension)) {
                return true;
            }
            return false;
        }
    }

    public async scanDirectoryRecursive(
        agentId: string,
        directoryPath: string,
        rootPathToMakeRelative?: string
    ): Promise<ScannedItem[]> {
        const cacheKey = this._generateCacheKey('scan', agentId, directoryPath);
        const cached = this.scanCache.get(cacheKey);

        if (cached && this._isCacheValid(cached.timestamp)) {
            console.log(`[Cache HIT] Returning cached scan results for ${directoryPath}`);
            return cached.data;
        }

        console.log(`[Cache MISS] Scanning directory: ${directoryPath}`);
        const results: ScannedItem[] = [];
        const effectiveRootPath = rootPathToMakeRelative || directoryPath;

        try {
            const items = await fs.readdir(directoryPath, { withFileTypes: true });

            const scanPromises = items.map(async (item) => {
                try {
                    const fullPath = path.resolve(directoryPath, item.name);
                    const relativePath = path.relative(effectiveRootPath, fullPath).replace(/\\/g, '/');

                    if (CodebaseIntrospectionService.shouldIgnore(fullPath, item.isDirectory())) {
                        return null;
                    }

                    const stats = await fs.stat(fullPath);

                    if (item.isDirectory()) {
                        results.push({
                            path: fullPath,
                            name: relativePath,
                            type: 'directory',
                            stats: stats,
                        });

                        // Recursively scan subdirectories
                        try {
                            const subResults = await this.scanDirectoryRecursive(agentId, fullPath, effectiveRootPath);
                            results.push(...subResults);
                        } catch (subError) {
                            console.error(`Error scanning subdirectory ${fullPath}:`, subError);
                        }
                    } else if (item.isFile()) {
                        let language: string | undefined;
                        try {
                            language = await this.detectLanguage(agentId, fullPath, item.name);
                        } catch (langError) {
                            console.warn(`Error detecting language for ${fullPath}:`, langError);
                        }

                        results.push({
                            path: fullPath,
                            name: relativePath,
                            type: 'file',
                            language: language,
                            stats: stats,
                        });
                    }
                } catch (itemError) {
                    console.error(`Error processing item ${item.name} in ${directoryPath}:`, itemError);
                }
                return null;
            });

            await Promise.all(scanPromises);

            // Cache the results
            this.scanCache.set(cacheKey, { timestamp: Date.now(), data: results });
            this._cleanupCache(this.scanCache);

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
        if (CodebaseIntrospectionService.shouldIgnore(filePath, false)) {
            return undefined;
        }

        const extension = path.extname(fileName).toLowerCase();

        // First, check if a specific parser is registered for the extension
        if (this.languageParsers.has(extension)) {
            return this.languageParsers.get(extension)!.getLanguageName();
        }

        // If still uncertain, try AI detection
        if (useAIForUncertain && this.geminiService) {
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

        const prompt = DETECT_LANGUAGE_PROMPT.replace('{fileContentSnippet}', fileContentSnippet);

        try {
            const response = await this.geminiService.askGemini(prompt, "gemini-2.5-flash");
            if (response.content && response.content.length > 0 && response.content[0].text) {
                const detectedLang = response.content[0].text.trim().toLowerCase();
                if (detectedLang && detectedLang !== "unknown" && detectedLang.length < 20 && /^[a-z0-9#+]+$/.test(detectedLang)) {
                    return detectedLang;
                }
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

        try {
            return parseInfo.parser.parseImports(filePath, parseInfo.code);
        } catch (error) {
            console.error(`Error parsing imports for ${filePath}:`, error);
            return [];
        }
    }

    public async parseFileForCodeEntities(
        agentId: string,
        filePath: string,
        fileLanguage?: string
    ): Promise<ExtractedCodeEntity[]> {
        const cacheKey = this._generateCacheKey('parse', agentId, filePath);
        const cached = this.parserCache.get(cacheKey);

        if (cached && this._isCacheValid(cached.timestamp)) {
            console.log(`[Cache HIT] Returning cached parse results for ${filePath}`);
            return cached.data;
        }

        console.log(`[Cache MISS] Parsing code entities for ${filePath}`);

        const parseInfo = await this.getParserAndCode(agentId, filePath, fileLanguage);
        if (!parseInfo) {
            return [];
        }

        try {
            const entities = await parseInfo.parser.parseCodeEntities(filePath, parseInfo.code, this.projectRootPath);

            // Cache the results
            this.parserCache.set(cacheKey, { timestamp: Date.now(), data: entities });
            this._cleanupCache(this.parserCache);

            return entities;
        } catch (error) {
            console.error(`Error parsing code entities for ${filePath}:`, error);
            return [];
        }
    }
}