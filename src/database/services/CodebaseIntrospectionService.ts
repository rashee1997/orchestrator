// src/services/CodebaseIntrospectionService.ts
import fs from 'fs/promises';
import { Stats } from 'fs';
import path from 'path';
import { MemoryManager } from '../memory_manager.js';
import { parse } from '@typescript-eslint/typescript-estree';
import { TSESTree, AST_NODE_TYPES } from '@typescript-eslint/types';
import { GeminiIntegrationService } from './GeminiIntegrationService.js';

// Interface for items found during directory scan
export interface ScannedItem {
    path: string; // Full absolute path
    name: string; // Path relative to the initial scan root, used as KG node name
    type: 'file' | 'directory';
    language?: string; // Detected language for files
    stats: Stats; // fs.Stats object
}

// Interface for extracted import information
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

// Interface for extracted code entities
export interface ExtractedCodeEntity {
    type: 'class' | 'function' | 'interface' | 'method' | 'property' | 'variable' | 'enum' | 'type_alias';
    name: string;
    fullName: string;
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
    className?: string;
}


export class CodebaseIntrospectionService {
    private memoryManager: MemoryManager;
    private geminiService: GeminiIntegrationService | null = null;
    private projectRootPath: string;

    constructor(memoryManager: MemoryManager, geminiService?: GeminiIntegrationService, projectRootPath?: string) {
        this.memoryManager = memoryManager;
        this.geminiService = geminiService || null;
        this.projectRootPath = projectRootPath || process.cwd();
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
                    if (['node_modules', '.git', '.vscode', 'dist', 'build', '.DS_Store', 'coverage', 'target', 'out'].includes(item.name) || item.name.startsWith('.')) {
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
                    const language = await this.detectLanguage(agentId, fullPath, item.name); // Now async
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

    /**
     * Detects the programming language of a file, first by extension, then optionally using AI.
     * @param agentId The agent ID for AI calls.
     * @param filePath The full path to the file.
     * @param fileName The name of the file.
     * @param useAIForUncertain If true, uses AI if extension-based detection is inconclusive.
     * @returns The detected language string or undefined.
     */
    public async detectLanguage(
        agentId: string,
        filePath: string,
        fileName: string,
        useAIForUncertain: boolean = true // Default to using AI for uncertain cases
    ): Promise<string | undefined> {
        const extension = path.extname(fileName).toLowerCase();
        let lang: string | undefined;

        switch (extension) {
            case '.ts':
            case '.tsx':
                lang = 'typescript';
                break;
            case '.js':
            case '.jsx':
            case '.mjs':
                lang = 'javascript';
                break;
            case '.py':
                lang = 'python';
                break;
            // Add other common languages
            case '.java': lang = 'java'; break;
            case '.cs': lang = 'csharp'; break;
            case '.go': lang = 'go'; break;
            case '.rb': lang = 'ruby'; break;
            case '.php': lang = 'php'; break;
            case '.rs': lang = 'rust'; break;
            case '.kt': lang = 'kotlin'; break;
            case '.swift': lang = 'swift'; break;
            case '.c': case '.h': lang = 'c'; break;
            case '.cpp': case '.hpp': lang = 'cpp'; break;
            case '.md': lang = 'markdown'; break;
            case '.json': lang = 'json'; break;
            case '.sql': lang = 'sql'; break;
            case '.html': lang = 'html'; break;
            case '.css': lang = 'css'; break;
            case '.scss': lang = 'scss'; break;
            case '.less': lang = 'less'; break;
            case '.xml': lang = 'xml'; break;
            case '.yaml': case '.yml': lang = 'yaml'; break;
            case '.sh': lang = 'shell'; break;
            case '.bat': lang = 'batch'; break;
            case '.ps1': lang = 'powershell'; break;
        }

        if (lang) {
            return lang;
        }

        if (useAIForUncertain) {
            try {
                const aiDetectedLang = await this.detectLanguageWithAI(agentId, filePath);
                if (aiDetectedLang && aiDetectedLang !== 'unknown') {
                    return aiDetectedLang;
                }
            } catch (aiError) {
                console.warn(`AI language detection failed for ${filePath}:`, aiError);
                // Fall through to returning undefined if AI fails
            }
        }
        return undefined; // No language detected
    }

    /**
     * Uses Gemini to detect the programming language of a file snippet.
     * @param agentId The agent ID.
     * @param filePath The path to the file.
     * @returns A promise resolving to the detected language string (lowercase) or 'unknown'.
     */
    private async detectLanguageWithAI(agentId: string, filePath: string): Promise<string | undefined> {
        if (!this.geminiService) {
            console.warn('GeminiIntegrationService not available for AI language detection');
            return undefined;
        }
        let fileContentSnippet: string;
        try {
            const buffer = Buffer.alloc(2048); // Read first 2KB
            const fd = await fs.open(filePath, 'r');
            const { bytesRead } = await fd.read(buffer, 0, 2048, 0);
            await fd.close();
            fileContentSnippet = buffer.toString('utf-8', 0, bytesRead);
        } catch (readError) {
            console.error(`Could not read snippet from ${filePath} for AI language detection:`, readError);
            return undefined;
        }

        if (!fileContentSnippet.trim()) {
            return undefined; // Empty file
        }

        const prompt = `Analyze the following code snippet and identify its primary programming language.
Respond with only the lowercase name of the language (e.g., "python", "javascript", "java", "csharp", "html", "css", "unknown" if not identifiable or not code).

Snippet:
\`\`\`
${fileContentSnippet}
\`\`\`

Language:`;

        try {
            const response = await this.geminiService.askGemini(prompt, "gemini-2.5-flash-preview-05-20"); // Using the latest model
            if (response.content && response.content.length > 0 && response.content[0].text) {
                const detectedLang = response.content[0].text.trim().toLowerCase();
                // Basic validation of common language names, or return as is
                if (detectedLang && detectedLang !== "unknown" && detectedLang.length < 20 && /^[a-z0-9#+]+$/.test(detectedLang)) { // Simple check for plausible lang name
                    return detectedLang;
                }
                return undefined; // If Gemini returns "unknown" or something unexpected
            }
        } catch (error) {
            console.error(`Error using Gemini for language detection on ${filePath}:`, error);
            // Fall through to returning undefined
        }
        return undefined;
    }


    public async parseFileForImports(
        agentId: string,
        filePath: string,
        fileLanguage?: string
    ): Promise<ExtractedImport[]> {
        const lang = fileLanguage || await this.detectLanguage(agentId, filePath, path.basename(filePath));
        if (lang !== 'typescript' && lang !== 'javascript') {
            console.warn(`Import parsing for language '${lang}' in ${filePath} is not yet supported by this implementation. Skipping.`);
            return [];
        }

        const imports: ExtractedImport[] = [];
        let code: string;
        try {
            code = await fs.readFile(filePath, 'utf-8');
        } catch (readError) {
            console.error(`Error reading file ${filePath} for import parsing:`, readError);
            return [];
        }

        try {
            const ast = parse(code, {
                ecmaVersion: 2022,
                sourceType: 'module',
                jsx: filePath.endsWith('.tsx') || filePath.endsWith('.jsx'),
                loc: true,
                range: true,
                comment: true,
                attachComment: true,
            });

            const astBody = Array.isArray(ast.body) ? ast.body : [];
            for (const node of astBody) {
                if (node.type === AST_NODE_TYPES.ImportDeclaration) {
                    const source = node.source.value;
                    const extractedImport: ExtractedImport = {
                        type: this.determineImportType(source, filePath, ast),
                        targetPath: this.resolveImportPath(source, filePath, agentId, ast),
                        originalImportString: code.substring(node.range![0], node.range![1]),
                        importedSymbols: node.specifiers.map((spec: any) => {
                            if (spec.type === AST_NODE_TYPES.ImportSpecifier) return spec.imported.name;
                            if (spec.type === AST_NODE_TYPES.ImportDefaultSpecifier) return spec.local.name + " (default)";
                            if (spec.type === AST_NODE_TYPES.ImportNamespaceSpecifier) return "* as " + spec.local.name;
                            return '';
                        }).filter(Boolean),
                        isDynamicImport: false,
                        isTypeOnlyImport: node.importKind === 'type',
                        startLine: node.loc!.start.line,
                        endLine: node.loc!.end.line,
                    };
                    imports.push(extractedImport);
                } else if (node.type === AST_NODE_TYPES.ExportNamedDeclaration && node.source) {
                    const source = node.source.value;
                     imports.push({
                        type: this.determineImportType(source, filePath, ast),
                        targetPath: this.resolveImportPath(source, filePath, agentId, ast),
                        originalImportString: code.substring(node.range![0], node.range![1]),
                        importedSymbols: node.specifiers.map((spec: any) => spec.local.name),
                        isDynamicImport: false,
                        isTypeOnlyImport: node.exportKind === 'type',
                        startLine: node.loc!.start.line,
                        endLine: node.loc!.end.line,
                    });
                } else if (node.type === AST_NODE_TYPES.ExportAllDeclaration && node.source) {
                     const source = node.source.value;
                     imports.push({
                        type: this.determineImportType(source, filePath, ast),
                        targetPath: this.resolveImportPath(source, filePath, agentId, ast),
                        originalImportString: code.substring(node.range![0], node.range![1]),
                        importedSymbols: ['*'],
                        isDynamicImport: false,
                        isTypeOnlyImport: node.exportKind === 'type',
                        startLine: node.loc!.start.line,
                        endLine: node.loc!.end.line,
                    });
                }
            }
            // Traverse AST for dynamic imports and require calls
            const traverseNode = (node: any): void => {
                if (node.type === AST_NODE_TYPES.ImportExpression) {
                    if (node.source.type === AST_NODE_TYPES.Literal && typeof node.source.value === 'string') {
                        const source = node.source.value;
                        imports.push({
                            type: this.determineImportType(source, filePath, ast),
                            targetPath: this.resolveImportPath(source, filePath, agentId, ast),
                            originalImportString: code.substring(node.range![0], node.range![1]),
                            isDynamicImport: true,
                            isTypeOnlyImport: false,
                            startLine: node.loc!.start.line,
                            endLine: node.loc!.end.line,
                        });
                    }
                } else if (node.type === AST_NODE_TYPES.CallExpression && node.callee.type === AST_NODE_TYPES.Identifier && node.callee.name === 'require') {
                    if (node.arguments.length > 0 && node.arguments[0].type === AST_NODE_TYPES.Literal && typeof node.arguments[0].value === 'string') {
                        const source = node.arguments[0].value;
                        imports.push({
                            type: this.determineImportType(source, filePath, ast),
                            targetPath: this.resolveImportPath(source, filePath, agentId, ast),
                            originalImportString: code.substring(node.range![0], node.range![1]),
                            isDynamicImport: false,
                            isTypeOnlyImport: false,
                            startLine: node.loc!.start.line,
                            endLine: node.loc!.end.line,
                        });
                    }
                }

                // Recursively traverse child nodes
                for (const key in node) {
                    if (node[key] && typeof node[key] === 'object') {
                        if (Array.isArray(node[key])) {
                            node[key].forEach((child: any) => {
                                if (child && typeof child === 'object' && child.type) {
                                    traverseNode(child);
                                }
                            });
                        } else if (node[key].type) {
                            traverseNode(node[key]);
                        }
                    }
                }
            };

            traverseNode(ast);
        } catch (error) {
            console.error(`Error parsing imports in ${filePath} (agent: ${agentId}):`, error);
        }
        return imports;
    }

    private resolveImportPath(importSpecifier: string, currentFilePath: string, agentId: string, ast?: any): string {
        if (importSpecifier.startsWith('.') || path.isAbsolute(importSpecifier)) {
            let resolved = path.resolve(path.dirname(currentFilePath), importSpecifier);
            return resolved.replace(/\\/g, '/');
        }
        return importSpecifier;
    }

    private determineImportType(importSpecifier: string, currentFilePath: string, ast?: any): ExtractedImport['type'] {
        if (importSpecifier.startsWith('.') || path.isAbsolute(importSpecifier)) {
            return 'file';
        }
        return 'external_library';
    }

    public async parseFileForCodeEntities(
        agentId: string,
        filePath: string,
        fileLanguage?: string
    ): Promise<ExtractedCodeEntity[]> {
        const lang = fileLanguage || await this.detectLanguage(agentId, filePath, path.basename(filePath));
        if (lang !== 'typescript' && lang !== 'javascript') {
            console.warn(`Code entity parsing for language '${lang}' in ${filePath} is not yet supported by this advanced implementation. Skipping.`);
            return [];
        }

        const entities: ExtractedCodeEntity[] = [];
        let code: string;
        try {
            code = await fs.readFile(filePath, 'utf-8');
        } catch (readError) {
            console.error(`Error reading file ${filePath} for entity parsing:`, readError);
            return [];
        }
        
        const relativeFilePath = path.relative(this.projectRootPath, filePath).replace(/\\/g, '/');


        try {
            const ast = parse(code, {
                ecmaVersion: 2022,
                sourceType: 'module',
                jsx: filePath.endsWith('.tsx') || filePath.endsWith('.jsx'),
                loc: true,
                range: true,
                comment: true,
                attachComment: true,
            });

            const getLeadingDocstring = (node: TSESTree.Node): string | null => {
                const comments = (ast.comments || []).filter(
                    (comment: TSESTree.Comment) => comment.range[1] < node.range![0]
                );
                if (comments.length > 0) {
                    const lastComment = comments[comments.length - 1];
                    const interveningText = code.substring(lastComment.range[1], node.range![0]);
                    if (interveningText.trim() === '') {
                        if (lastComment.type === 'Block' && lastComment.value.startsWith('*')) {
                            return '/**\n' + lastComment.value.split('\n').map((l: any) => ' * ' + l.trim()).join('\n').replace(/\s*\*\s*$/, "") + '\n */';
                        }
                        return lastComment.value.trim();
                    }
                }
                return null;
            };
            
            const formatParams = (params: TSESTree.Parameter[]): ExtractedCodeEntity['parameters'] => {
                return params.map((p: any) => {
                    let name = '';
                    let typeAnnotation: string | undefined = undefined;
                    let optional: boolean | undefined = undefined;
                    let rest: boolean | undefined = undefined;
                    let defaultValue: string | null = null;

                    if (p.type === AST_NODE_TYPES.Identifier) {
                        name = p.name;
                        optional = (p as TSESTree.Identifier & { optional?: boolean }).optional;
                        if (p.typeAnnotation) typeAnnotation = code.substring(p.typeAnnotation.typeAnnotation.range![0], p.typeAnnotation.typeAnnotation.range![1]);
                    } else if (p.type === AST_NODE_TYPES.AssignmentPattern && p.left.type === AST_NODE_TYPES.Identifier) {
                        name = p.left.name;
                        optional = true;
                        defaultValue = code.substring(p.right.range![0], p.right.range![1]);
                        if (p.left.typeAnnotation) typeAnnotation = code.substring(p.left.typeAnnotation.typeAnnotation.range![0], p.left.typeAnnotation.typeAnnotation.range![1]);
                    } else if (p.type === AST_NODE_TYPES.RestElement && p.argument.type === AST_NODE_TYPES.Identifier) {
                        name = p.argument.name;
                        rest = true;
                        if (p.typeAnnotation) typeAnnotation = code.substring(p.typeAnnotation.typeAnnotation.range![0], p.typeAnnotation.typeAnnotation.range![1]);
                    } else if (p.type === AST_NODE_TYPES.TSParameterProperty && p.parameter) {
                        if (p.parameter.type === AST_NODE_TYPES.Identifier) {
                            name = p.parameter.name;
                        } else if (p.parameter.type === AST_NODE_TYPES.AssignmentPattern && p.parameter.left.type === AST_NODE_TYPES.Identifier) {
                            name = p.parameter.left.name;
                        }
                         if ((p.parameter as any).typeAnnotation) typeAnnotation = code.substring((p.parameter as any).typeAnnotation.typeAnnotation.range![0], (p.parameter as any).typeAnnotation.typeAnnotation.range![1]);
                    }
                    return { name, type: typeAnnotation, optional, rest, defaultValue };
                });
            };

            const formatSignature = (node: TSESTree.FunctionDeclaration | TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression | TSESTree.FunctionDeclaration | TSESTree.TSEmptyBodyFunctionExpression, nodeName?: string): string => {
                const name = nodeName || (node.id?.name || '');
                const paramsString = (node.params || []).map((p: any) => code.substring(p.range![0], p.range![1])).join(', ');
                let returnTypeString = '';
                if (node.returnType) {
                    returnTypeString = `: ${code.substring(node.returnType.typeAnnotation.range![0], node.returnType.typeAnnotation.range![1])}`;
                }
                const asyncPrefix = node.async ? 'async ' : '';
                return `${asyncPrefix}function ${name}(${paramsString})${returnTypeString}`;
            };

            // Track parent nodes during traversal
            const parentMap = new WeakMap<TSESTree.Node, TSESTree.Node | null>();
            
            const isExported = (node: TSESTree.Node): boolean => {
                let current: TSESTree.Node | null = node;
                while (current) {
                    const parent = parentMap.get(current);
                    if (parent && (parent.type === AST_NODE_TYPES.ExportNamedDeclaration || parent.type === AST_NODE_TYPES.ExportDefaultDeclaration)) {
                        return true;
                    }
                    if (!parent || parent.type === AST_NODE_TYPES.FunctionDeclaration || parent.type === AST_NODE_TYPES.ClassDeclaration || parent.type === AST_NODE_TYPES.Program) {
                        break;
                    }
                    current = parent;
                }
                return false;
            };

            const traverseNode = (node: any, parent: TSESTree.Node | null = null): void => {
                if (!node || typeof node !== 'object' || !node.type) return;
                
                parentMap.set(node, parent);
                    let entity: Partial<ExtractedCodeEntity> = { 
                    filePath: relativeFilePath, 
                    startLine: node.loc!.start.line, 
                    endLine: node.loc!.end.line, 
                    docstring: getLeadingDocstring(node),
                    isExported: isExported(node) || (parent?.type === AST_NODE_TYPES.ExportNamedDeclaration || parent?.type === AST_NODE_TYPES.ExportDefaultDeclaration)
                };
                    if (node.type === AST_NODE_TYPES.FunctionDeclaration && node.id) {
                        entity.type = 'function';
                        entity.name = node.id.name;
                        entity.fullName = `${relativeFilePath}::${node.id.name}`;
                        entity.signature = formatSignature(node);
                        entity.parameters = formatParams(node.params as any[]);
                        if (node.returnType) entity.returnType = code.substring(node.returnType.typeAnnotation.range![0], node.returnType.typeAnnotation.range![1]);
                        entity.isAsync = node.async;
                        entities.push(entity as ExtractedCodeEntity);
                    } else if (node.type === AST_NODE_TYPES.ClassDeclaration && node.id) {
                        entity.type = 'class';
                        entity.name = node.id.name;
                        entity.fullName = `${relativeFilePath}::${node.id.name}`;
                        if (node.superClass && node.superClass.type === AST_NODE_TYPES.Identifier) {
                            entity.parentClass = node.superClass.name;
                        }
                        entity.implementedInterfaces = node.implements?.map((imp: any) => {
                           if (imp.expression.type === AST_NODE_TYPES.Identifier) return imp.expression.name;
                           if (imp.expression.type === AST_NODE_TYPES.TSQualifiedName && imp.expression.right.type === AST_NODE_TYPES.Identifier) return code.substring(imp.expression.range![0], imp.expression.range![1]);
                           return 'unknown_interface_type';
                        }).filter(Boolean) as string[];
                        entities.push(entity as ExtractedCodeEntity);

                        node.body.body.forEach((member: any) => {
                            if (member.type === AST_NODE_TYPES.MethodDefinition && member.key.type === AST_NODE_TYPES.Identifier) {
                                const methodEntity: Partial<ExtractedCodeEntity> = {
                                    type: 'method', name: member.key.name, fullName: `${entity.fullName}::${member.key.name}`,
                                    filePath: relativeFilePath, className: entity.name,
                                    startLine: member.loc!.start.line, endLine: member.loc!.end.line,
                                    docstring: getLeadingDocstring(member), isExported: false,
                                };
                                if (member.value.type === AST_NODE_TYPES.FunctionExpression || member.value.type === AST_NODE_TYPES.TSEmptyBodyFunctionExpression) {
                                    methodEntity.signature = formatSignature(member.value, member.key.name);
                                    methodEntity.parameters = formatParams(member.value.params as any[]);
                                    if (member.value.returnType) methodEntity.returnType = code.substring(member.value.returnType.typeAnnotation.range![0], member.value.returnType.typeAnnotation.range![1]);
                                    methodEntity.isAsync = member.value.async;
                                }
                                entities.push(methodEntity as ExtractedCodeEntity);
                            } else if (member.type === AST_NODE_TYPES.PropertyDefinition && member.key.type === AST_NODE_TYPES.Identifier) {
                                const propEntity: Partial<ExtractedCodeEntity> = {
                                    type: 'property', name: member.key.name, fullName: `${entity.fullName}::${member.key.name}`,
                                    filePath: relativeFilePath, className: entity.name,
                                    startLine: member.loc!.start.line, endLine: member.loc!.end.line,
                                    docstring: getLeadingDocstring(member), isExported: false,
                                };
                                if (member.typeAnnotation) propEntity.signature = `${member.key.name}: ${code.substring(member.typeAnnotation.typeAnnotation.range![0], member.typeAnnotation.typeAnnotation.range![1])}`;
                                else propEntity.signature = `${member.key.name}: any`;
                                entities.push(propEntity as ExtractedCodeEntity);
                            }
                        });

                    } else if (node.type === AST_NODE_TYPES.TSInterfaceDeclaration && node.id) {
                        entity.type = 'interface';
                        entity.name = node.id.name;
                        entity.fullName = `${relativeFilePath}::${node.id.name}`;
                        entities.push(entity as ExtractedCodeEntity);
                    } else if (node.type === AST_NODE_TYPES.VariableDeclaration) {
                        for (const declarator of node.declarations) {
                            if (declarator.id.type === AST_NODE_TYPES.Identifier) {
                                const varEntity: Partial<ExtractedCodeEntity> = {
                                    type: 'variable', name: declarator.id.name, fullName: `${relativeFilePath}::${declarator.id.name}`,
                                    filePath: relativeFilePath, startLine: declarator.loc!.start.line, endLine: declarator.loc!.end.line,
                                    docstring: getLeadingDocstring(node), 
                                    isExported: isExported(node) || (parent?.type === AST_NODE_TYPES.ExportNamedDeclaration)
                                };
                                if (declarator.id.typeAnnotation) varEntity.signature = `${declarator.id.name}: ${code.substring(declarator.id.typeAnnotation.typeAnnotation.range![0], declarator.id.typeAnnotation.typeAnnotation.range![1])}`;
                                else varEntity.signature = `${declarator.id.name}: any`;
                                
                                if (declarator.init && (declarator.init.type === AST_NODE_TYPES.ArrowFunctionExpression || declarator.init.type === AST_NODE_TYPES.FunctionExpression)) {
                                    varEntity.type = 'function';
                                    varEntity.signature = formatSignature(declarator.init, declarator.id.name);
                                    varEntity.parameters = formatParams(declarator.init.params as any[]);
                                    if (declarator.init.returnType) varEntity.returnType = code.substring(declarator.init.returnType.typeAnnotation.range![0], declarator.init.returnType.typeAnnotation.range![1]);
                                    varEntity.isAsync = declarator.init.async;
                                }
                                entities.push(varEntity as ExtractedCodeEntity);
                            }
                        }
                    } else if (node.type === AST_NODE_TYPES.TSEnumDeclaration && node.id) {
                        entity.type = 'enum';
                        entity.name = node.id.name;
                        entity.fullName = `${relativeFilePath}::${node.id.name}`;
                        entities.push(entity as ExtractedCodeEntity);
                    } else if (node.type === AST_NODE_TYPES.TSTypeAliasDeclaration && node.id) {
                        entity.type = 'type_alias';
                        entity.name = node.id.name;
                        entity.fullName = `${relativeFilePath}::${node.id.name}`;
                        entity.signature = `type ${node.id.name} = ${code.substring(node.typeAnnotation.range![0], node.typeAnnotation.range![1])}`;
                        entities.push(entity as ExtractedCodeEntity);
                    }

                // Recursively traverse child nodes
                for (const key in node) {
                    if (node[key] && typeof node[key] === 'object') {
                        if (Array.isArray(node[key])) {
                            node[key].forEach((child: any) => {
                                if (child && typeof child === 'object' && child.type) {
                                    traverseNode(child, node);
                                }
                            });
                        } else if (node[key].type) {
                            traverseNode(node[key], node);
                        }
                    }
                }
            };

            traverseNode(ast);

        } catch (error) {
            console.error(`Error parsing code entities in ${filePath} (agent: ${agentId}):`, error);
        }
        return entities;
    }
}
