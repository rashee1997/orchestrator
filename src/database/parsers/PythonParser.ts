// Enhanced Python parser module with richer and deeper parsing capabilities
import { BaseLanguageParser } from './ILanguageParser.js';
import { ExtractedImport, ExtractedCodeEntity } from '../services/CodebaseIntrospectionService.js';
import filbert from 'filbert';
import path from 'path';

// Enhanced interfaces for richer parsing
interface TypeInformation {
    inferredType: string;
    declaredType?: string;
    typeHints: string[];
    genericParameters: string[];
    returnType?: string;
    unionTypes: string[];
    optionalTypes: string[];
}

interface ComplexityMetrics {
    cyclomaticComplexity: number;
    cognitiveComplexity: number;
    nestingDepth: number;
    parameterCount: number;
    lineCount: number;
    halsteadMetrics: {
        vocabulary: number;
        length: number;
        volume: number;
        difficulty: number;
        effort: number;
    };
}

interface DecoratorInfo {
    name: string;
    arguments: any[];
    isBuiltin: boolean;
    isCustom: boolean;
    category: 'validation' | 'transformation' | 'routing' | 'testing' | 'other';
}

interface DocstringAnalysis {
    format: 'google' | 'numpy' | 'sphinx' | 'epydoc' | 'custom' | 'none';
    sections: {
        summary: string;
        description: string;
        parameters: Array<{name: string, type: string, description: string}>;
        returns: Array<{type: string, description: string}>;
        raises: Array<{exception: string, description: string}>;
        examples: string[];
        notes: string[];
        todos: string[];
    };
    completeness: number;
    qualityScore: number;
}

interface EnhancedImport extends ExtractedImport {
    resolutionStrategy: 'absolute' | 'relative' | 'namespace' | 'conditional';
    importType: 'standard' | 'third-party' | 'local' | 'builtin';
    importAlias: string;
    starImport: boolean;
    conditionalImport: boolean;
    importConditions: string[];
    circularDependencyRisk: boolean;
}

interface EnhancedExtractedCodeEntity extends ExtractedCodeEntity {
    typeInformation: TypeInformation;
    complexityMetrics: ComplexityMetrics;
    dependencies: string[];
    inheritanceChain: string[];
    mixins: string[];
    protocols: string[];
    decorators: DecoratorInfo[];
    docstringAnalysis: DocstringAnalysis;
    codeSmells: string[];
    designPatterns: string[];
}

export class PythonParser extends BaseLanguageParser {
    getSupportedExtensions(): string[] {
        return ['.py'];
    }
    
    getLanguageName(): string {
        return 'python';
    }

    async parseImports(filePath: string, fileContent: string): Promise<EnhancedImport[]> {
        const imports: EnhancedImport[] = [];
        try {
            const ast = filbert.parse(fileContent, { locations: true });

            const traverse = (node: any) => {
                if (!node) return;

                if (node.type === 'Import') {
                    node.names.forEach((alias: any) => {
                        const importInfo = this.analyzeImport(alias.name, filePath, 0);
                        imports.push({
                            ...importInfo,
                            type: 'module',
                            targetPath: alias.name,
                            originalImportString: fileContent.substring(node.start, node.end),
                            importedSymbols: [alias.asname || alias.name],
                            isDynamicImport: false,
                            isTypeOnlyImport: false,
                            startLine: node.loc.start.line,
                            endLine: node.loc.end.line,
                            starImport: false,
                        });
                    });
                } else if (node.type === 'ImportFrom') {
                    const moduleName = node.module || '';
                    const resolvedPath = this.resolveImportPath(moduleName, filePath, node.level);
                    const importedSymbols = node.names.map((alias: any) => alias.asname || alias.name);
                    const importInfo = this.analyzeImport(moduleName, filePath, node.level);
                    
                    imports.push({
                        ...importInfo,
                        type: 'module',
                        targetPath: resolvedPath,
                        originalImportString: fileContent.substring(node.start, node.end),
                        importedSymbols: importedSymbols,
                        isDynamicImport: false,
                        isTypeOnlyImport: false,
                        startLine: node.loc.start.line,
                        endLine: node.loc.end.line,
                        starImport: node.names.some((n: any) => n.name === '*'),
                    });
                }

                // Check for conditional imports
                if (node.type === 'If' || node.type === 'Try') {
                    this.extractConditionalImports(node, fileContent, imports);
                }

                // Generic traversal
                for (const key in node) {
                    if (node.hasOwnProperty(key)) {
                        const child = node[key];
                        if (child && typeof child === 'object') {
                            if (Array.isArray(child)) {
                                child.forEach(traverse);
                            } else {
                                traverse(child);
                            }
                        }
                    }
                }
            };
            traverse(ast);
        } catch (error) {
            console.error(`Error parsing Python imports in ${filePath}:`, error);
        }
        return imports;
    }

    private isStandardLibrary(moduleName: string): boolean {
        const stdLib = new Set([
            // This is not an exhaustive list.
            // Add more modules as needed.
            'os', 'sys', 'math', 'json', 're', 'datetime', 'time', 'collections',
            'itertools', 'functools', 'random', 'pickle', 'subprocess', 'multiprocessing',
            'threading', 'logging', 'argparse', 'pathlib', 'shutil', 'glob', 'tempfile',
            'unittest', 'doctest', 'typing', 'http', 'urllib', 'xml', 'csv', 'sqlite3', 'email'
        ]);
        return stdLib.has(moduleName.split('.')[0]);
    }

    private isBuiltinModule(moduleName: string): boolean {
        const builtins = new Set([
            'builtins', 'sys', 'micropython',
            // Not a real module, but often used to check for builtin functions
            // This is not exhaustive.
        ]);
        return builtins.has(moduleName);
    }

    private analyzeImport(moduleName: string, currentFilePath: string, level: number): {
        resolutionStrategy: 'absolute' | 'relative';
        importType: 'standard' | 'third-party' | 'local' | 'builtin';
        importAlias: string;
        conditionalImport: boolean;
        importConditions: string[];
        circularDependencyRisk: boolean;
    } {
        const isStandardLib = this.isStandardLibrary(moduleName);
        const isBuiltin = this.isBuiltinModule(moduleName);
        const isThirdParty = !isStandardLib && !isBuiltin;
        
        return {
            resolutionStrategy: level > 0 ? 'relative' : 'absolute',
            importType: isBuiltin ? 'builtin' : isStandardLib ? 'standard' : isThirdParty ? 'third-party' : 'local',
            importAlias: moduleName,
            conditionalImport: false,
            importConditions: [],
            circularDependencyRisk: false,
        };
    }

    private extractConditionalImports(node: any, fileContent: string, imports: EnhancedImport[]) {
        const traverse = (currentNode: any) => {
            if (currentNode.type === 'Import' || currentNode.type === 'ImportFrom') {
                const lastImport = imports[imports.length - 1];
                if (lastImport) {
                    lastImport.conditionalImport = true;
                    lastImport.importConditions.push(fileContent.substring(node.start, node.end));
                }
            }
            
            for (const key in currentNode) {
                if (currentNode.hasOwnProperty(key) && typeof currentNode[key] === 'object') {
                    if (Array.isArray(currentNode[key])) {
                        currentNode[key].forEach(traverse);
                    } else {
                        traverse(currentNode[key]);
                    }
                }
            }
        };
        
        traverse(node);
    }

    private formatSignature(node: any, fileContent: string): string {
        if (!node.start || !node.end) return node.name || '';
        
        const extractText = (start: number, end: number) => fileContent.substring(start, end).trim();

        let signatureText = '';
        let endOfSignature = node.end;

        if (node.type === 'FunctionDef' || node.type === 'AsyncFunctionDef' || node.type === 'ClassDef') {
            // Include decorators in the signature
            const startOfDecorators = node.decorator_list?.[0]?.start ?? node.start;
            endOfSignature = node.body?.[0]?.start ?? node.end;
            signatureText = extractText(startOfDecorators, endOfSignature);
        } else if (node.type === 'Assign' && node.targets && node.targets.length > 0) {
            signatureText = extractText(node.start, node.end);
        } else if (node.type === 'AnnAssign' && node.target) { // For annotated assignments
            signatureText = extractText(node.start, node.end);
        } else {
            signatureText = extractText(node.start, node.end);
        }

        if (signatureText.endsWith(':')) {
            signatureText = signatureText.slice(0, -1).trim();
        }

        return signatureText.replace(/\s+/g, ' ');
    }

    private extractCalls(node: any, fileContent: string): Array<{ name: string; type: string; }> {
        const calls: Array<{ name: string; type: string; }> = [];
        const traverse = (currentNode: any) => {
            if (!currentNode) return;

            if (currentNode.type === 'Call' && currentNode.func) {
                let callName: string | null = null;
                let callType: string = 'unknown';

                const getFullName = (expr: any): string => {
                    if (!expr) return '';
                    if (expr.type === 'Name') return expr.id;
                    if (expr.type === 'Attribute') {
                        const base = getFullName(expr.value);
                        return base ? `${base}.${expr.attr}` : expr.attr;
                    }
                    return '';
                };
                
                callName = getFullName(currentNode.func);
                if (currentNode.func.type === 'Name') {
                    callType = 'function';
                } else if (currentNode.func.type === 'Attribute') {
                    callType = 'method';
                }

                if (callName) {
                    calls.push({ name: callName, type: callType });
                }
            }

            for (const key in currentNode) {
                if (currentNode.hasOwnProperty(key) && typeof currentNode[key] === 'object') {
                    if (Array.isArray(currentNode[key])) {
                        currentNode[key].forEach(traverse);
                    } else {
                        traverse(currentNode[key]);
                    }
                }
            }
        };
        traverse(node);
        return calls;
    }

    async parseCodeEntities(filePath: string, fileContent: string, projectRootPath: string): Promise<ExtractedCodeEntity[]> {
        const entities: ExtractedCodeEntity[] = [];
        const absoluteFilePath = path.resolve(filePath).replace(/\\/g, '/');
        const relativeFilePath = this.getRelativeFilePath(filePath);
        const containingDirectory = path.dirname(relativeFilePath).replace(/\\/g, '/');

        try {
            const ast = filbert.parse(fileContent, { locations: true, ranges: true });
            
            const extractDocstringFromNode = (node: any) => {
                if (Array.isArray(node.body) && node.body.length > 0) {
                    const firstStmt = node.body[0];
                    if (firstStmt.type === 'Expr' && firstStmt.value.type === 'Str') {
                        return firstStmt.value.s;
                    }
                }
                return this.extractDocstring(fileContent, node.range[0]);
            };

            const traverse = (node: any, parentClass: any = null): void => {
                if (!node || !node.type) return;

                const baseEntity = {
                    startLine: node.loc.start.line,
                    endLine: node.loc.end.line,
                    filePath: absoluteFilePath,
                    containingDirectory: containingDirectory,
                    docstring: extractDocstringFromNode(node),
                };
                
                const getFullName = (name: string, parentName?: string) => {
                    let fullName = relativeFilePath.replace(/\//g, '.').replace(/\.py$/, '');
                    if (parentName) {
                        fullName += `.${parentName}`;
                    }
                    return `${fullName}.${name}`;
                };

                const extractText = (subNode: any) => subNode ? fileContent.substring(subNode.start, subNode.end) : null;

                switch (node.type) {
                    case 'FunctionDef':
                    case 'AsyncFunctionDef':
                        const functionName = node.name;
                        const parentName = parentClass?.name;
                        const isConstructor = functionName === '__init__';
                        const isGenerator = (node.body || []).some((n: any) => n.type === 'Yield' || n.type === 'YieldFrom');

                        entities.push({
                            ...baseEntity,
                            type: isConstructor ? 'construct_signature' : (parentClass ? 'method' : 'function'),
                            name: functionName,
                            fullName: getFullName(functionName, parentName),
                            signature: this.formatSignature(node, fileContent),
                            parentClass: parentName || null,
                            isExported: !functionName.startsWith('_') || (isConstructor && !parentName?.startsWith('_')),
                            isAsync: node.type === 'AsyncFunctionDef',
                            parameters: node.args.args.map((arg: any) => ({
                                name: arg.arg,
                                type: extractText(arg.annotation),
                                defaultValue: extractText(arg.default),
                            })),
                            returnType: extractText(node.returns),
                            calls: this.extractCalls(node.body, fileContent),
                            metadata: {
                                decorators: node.decorator_list.map((d: any) => this.formatSignature(d, fileContent)),
                                is_generator: isGenerator,
                            }
                        });
                        if (Array.isArray(node.body)) {
                            node.body.forEach((child: any) => traverse(child, parentClass));
                        }
                        break;

                    case 'ClassDef':
                        const className = node.name;
                        entities.push({
                            ...baseEntity,
                            type: 'class',
                            name: className,
                            fullName: getFullName(className),
                            signature: this.formatSignature(node, fileContent),
                            isExported: !className.startsWith('_'),
                            parentClass: null, // Top-level classes have no parent class in this context.
                            implementedInterfaces: node.bases.map((b:any) => this.formatSignature(b, fileContent)),
                            metadata: {
                                decorators: node.decorator_list.map((d: any) => this.formatSignature(d, fileContent)),
                            }
                        });
                        if (Array.isArray(node.body)) {
                            node.body.forEach((child: any) => traverse(child, node));
                        }
                        break;
                    
                    case 'Assign':
                    case 'AnnAssign': // Annotated assignment
                        if (node.targets && node.targets.length > 0 && node.targets[0].type === 'Name') {
                            const varName = node.targets[0].id;
                            entities.push({
                                ...baseEntity,
                                type: 'variable',
                                name: varName,
                                fullName: getFullName(varName, parentClass?.name),
                                signature: this.formatSignature(node, fileContent),
                                isExported: !varName.startsWith('_'),
                                returnType: node.annotation ? extractText(node.annotation) : null,
                            });
                        }
                        break;
                    
                    default:
                        // Generic traversal for other nodes
                        for (const key in node) {
                            if (node.hasOwnProperty(key)) {
                                const child = node[key];
                                if (child && typeof child === 'object') {
                                    if (Array.isArray(child)) {
                                        child.forEach(c => traverse(c, parentClass));
                                    } else {
                                        traverse(child, parentClass);
                                    }
                                }
                            }
                        }
                        break;
                }
            };
            
            traverse(ast);

        } catch (error) {
            console.error(`Error parsing Python code entities in ${filePath}:`, error);
        }
        return entities;
    }
    private resolveImportPath(moduleName: string, currentFilePath: string, level: number): string {
        if (level === 0) {
            // Absolute import
            return moduleName;
        }

        const currentDir = path.dirname(currentFilePath);
        let resolvedPath = currentDir;

        // Move up the directory tree for each level
        for (let i = 0; i < level; i++) {
            resolvedPath = path.dirname(resolvedPath);
        }

        if (moduleName) {
            resolvedPath = path.join(resolvedPath, moduleName.replace(/\./g, '/'));
        }

        // Make it relative to the project root
        return path.relative(this.projectRootPath, resolvedPath).replace(/\\/g, '/');
    }
}
