import { BaseLanguageParser } from './ILanguageParser.js';
import { ExtractedImport, ExtractedCodeEntity } from '../services/CodebaseIntrospectionService.js';
import * as babelParser from '@babel/parser'; // Babel can parse modern Python via plug-ins
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import path from 'path';
import fs from 'fs/promises';

// ---------- Enhanced Type System ----------
interface EnhancedTypeInfo {
    name: string;
    nullable: boolean;
    isOptional: boolean;
    isUnion: boolean;
    unionTypes?: string[];
    raw: string;
}

interface ParameterInfo {
    name: string;
    typeInfo?: EnhancedTypeInfo;
    isOptional: boolean;
    isRest: boolean;
    defaultValue?: string;
}

interface DecoratorInfo {
    name: string;
    arguments: string[];
}

interface EnhancedCodeEntity extends ExtractedCodeEntity {
    decorators?: DecoratorInfo[];
    parameters?: ParameterInfo[];
    returnTypeInfo?: EnhancedTypeInfo;
    complexityScore?: number;
    dependencies?: string[];
    isAsync?: boolean;
    isGenerator?: boolean;
    docBlock?: {
        summary: string;
        description: string;
        params: Array<{ name: string; type?: string; description: string }>;
        returns?: { type?: string; description: string };
    };
}

// ---------- Main Parser ----------
export class PythonParser extends BaseLanguageParser {
    getSupportedExtensions(): string[] {
        return ['.py', '.pyi'];
    }
    getLanguageName(): string {
        return 'python';
    }

    async parseImports(filePath: string, fileContent: string): Promise<ExtractedImport[]> {
        const imports: ExtractedImport[] = [];
        const lines = fileContent.split('\n');
        const importRegex = /^\s*(import|from)\s+([^\s]+)(?:\s+import\s+(.*))?/;

        lines.forEach((line, idx) => {
            const match = importRegex.exec(line.trim());
            if (!match) return;

            const [, keyword, module, symbols] = match;
            const targetPath = keyword === 'import' ? module : module;
            const importedSymbols = symbols
                ? symbols.split(',').map(s => s.trim().split(/\s+as\s+/)[0])
                : [];

            imports.push({
                type: targetPath.startsWith('.') ? 'file' : 'module',
                targetPath,
                originalImportString: line.trim(),
                importedSymbols,
                isDynamicImport: false,
                isTypeOnlyImport: false,
                startLine: idx + 1,
                endLine: idx + 1,
            });
        });

        return imports;
    }

    async parseCodeEntities(
        filePath: string,
        fileContent: string,
        projectRootPath: string
    ): Promise<EnhancedCodeEntity[]> {
        const entities: EnhancedCodeEntity[] = [];
        const absoluteFilePath = path.resolve(filePath).replace(/\\/g, '/');
        const relativeFilePath = path.relative(projectRootPath, absoluteFilePath).replace(/\\/g, '/');
        const containingDirectory = path.dirname(relativeFilePath);

        // Use Python AST via built-in ast module (requires Node >= 20 w/ --experimental-modules)
        // Fallback: regex-based extraction if ast is unavailable
        let ast: any;
        try {
            // Attempt to use native Python AST via spawn if Python is installed
            const { execSync } = await import('child_process');
            const astJson = execSync(
                `python3 -c "import ast, json, sys; print(json.dumps(ast.dump(ast.parse(open('${filePath}').read(), filename='${filePath}'), indent=2)))"`,
                { encoding: 'utf-8', timeout: 5000 }
            );
            ast = JSON.parse(astJson);
        } catch (e) {
            console.warn('Falling back to regex-based Python parsing:', e);
            return this._regexBasedParse(fileContent, relativeFilePath, containingDirectory);
        }

        const walk = (node: any, parentClass?: string) => {
            if (!node || typeof node !== 'object') return;

            // FunctionDef / AsyncFunctionDef
            if (node._type === 'FunctionDef' || node._type === 'AsyncFunctionDef') {
                const name = node.name;
                const params = (node.args?.args || []).map((arg: any) => ({
                    name: arg.arg,
                    typeInfo: arg.annotation ? { name: arg.annotation, nullable: false, isOptional: false, isUnion: false, raw: arg.annotation } : undefined,
                    isOptional: false,
                    isRest: false,
                    defaultValue: undefined,
                }));
                const isAsync = node._type === 'AsyncFunctionDef';
                const isGenerator = !!(node.body || []).find((n: any) => n._type === 'Yield' || n._type === 'YieldFrom');

                entities.push({
                    type: parentClass ? 'method' : 'function',
                    name,
                    fullName: `${relativeFilePath}::${parentClass ? `${parentClass}.` : ''}${name}`,
                    signature: `${isAsync ? 'async ' : ''}def ${name}(${params.map((p: any) => p.name).join(', ')})`,
                    startLine: node.lineno || 1,
                    endLine: node.end_lineno || 1,
                    filePath: absoluteFilePath,
                    containingDirectory: containingDirectory,
                    isExported: !name.startsWith('_'),
                    parentClass,
                    parameters: params,
                    isAsync,
                    isGenerator,
                    docBlock: this._extractDocBlock(node),
                    metadata: { decorators: node.decorator_list || [] },
                });
            }

            // ClassDef
            if (node._type === 'ClassDef') {
                const name = node.name;
                entities.push({
                    type: 'class',
                    name,
                    fullName: `${relativeFilePath}::${name}`,
                    signature: `class ${name}(${node.bases?.join(', ') || ''})`,
                    startLine: node.lineno || 1,
                    endLine: node.end_lineno || 1,
                    filePath: absoluteFilePath,
                    containingDirectory: containingDirectory,
                    isExported: !name.startsWith('_'),
                    implementedInterfaces: node.bases || [],
                    metadata: { decorators: node.decorator_list || [] },
                });

                // Recurse into class body
                (node.body || []).forEach((child: any) => walk(child, name));
                return;
            }

            // Assign / AnnAssign (variables)
            if (node._type === 'Assign' || node._type === 'AnnAssign') {
                const targets = node.targets || [node.target];
                targets.forEach((tgt: any) => {
                    if (tgt._type === 'Name') {
                        entities.push({
                            type: 'variable',
                            name: tgt.id,
                            fullName: `${relativeFilePath}::${parentClass ? `${parentClass}.` : ''}${tgt.id}`,
                            signature: `${tgt.id} = ...`,
                            startLine: node.lineno || 1,
                            endLine: node.end_lineno || 1,
                            filePath: absoluteFilePath,
                            containingDirectory: containingDirectory,
                            isExported: !tgt.id.startsWith('_'),
                            parentClass,
                            returnTypeInfo: tgt.annotation ? { name: tgt.annotation, nullable: false, isOptional: false, isUnion: false, raw: tgt.annotation } : undefined,
                        });
                    }
                });
            }

            // Recurse children
            Object.values(node).forEach((child: any) => {
                if (Array.isArray(child)) child.forEach((item: any) => walk(item));
                else walk(child);
            });
        };

        walk(ast);
        return entities;
    }

    // ---------- Fallback Regex Parser ----------
    private _regexBasedParse(
        fileContent: string,
        relativePath: string,
        containingDir: string
    ): EnhancedCodeEntity[] {
        const entities: EnhancedCodeEntity[] = [];
        const lines = fileContent.split('\n');

        // Regex patterns for Python constructs
        const patterns = {
            class: /^\s*class\s+([A-Za-z_]\w*)\s*(?:\((.*?)\))?\s*:/,
            def: /^\s*(async\s+)?def\s+([A-Za-z_]\w*)\s*\((.*?)\)(?:\s*->\s*([^\s:]+))?\s*:/,
            assign: /^\s*([A-Za-z_]\w*)\s*=\s*(.+)/,
        };

        lines.forEach((line, idx) => {
            let match;

            // Classes
            if ((match = patterns.class.exec(line))) {
                const [, name, bases] = match;
                entities.push({
                    type: 'class',
                    name,
                    fullName: `${relativePath}::${name}`,
                    signature: `class ${name}${bases ? `(${bases})` : ''}`,
                    startLine: idx + 1,
                    endLine: idx + 1,
                    filePath: relativePath,
                    containingDirectory: containingDir,
                    isExported: !name.startsWith('_'),
                    implementedInterfaces: bases ? bases.split(',').map(b => b.trim()) : [],
                });
            }

            // Functions / Methods
            if ((match = patterns.def.exec(line))) {
                const [, asyncKeyword, name, params, ret] = match;
                const paramsList = params
                    ? params.split(',').map((p: string) => ({
                        name: p.trim().split('=')[0],
                        isOptional: p.includes('='),
                        isRest: false,
                    }))
                    : [];
                entities.push({
                    type: 'function',
                    name,
                    fullName: `${relativePath}::${name}`,
                    signature: `${asyncKeyword || ''}def ${name}(${params || ''})${ret ? ` -> ${ret}` : ''}`,
                    startLine: idx + 1,
                    endLine: idx + 1,
                    filePath: relativePath,
                    containingDirectory: containingDir,
                    isExported: !name.startsWith('_'),
                    parameters: paramsList,
                    isAsync: !!asyncKeyword,
                    returnTypeInfo: ret ? { name: ret, nullable: false, isOptional: false, isUnion: false, raw: ret } : undefined,
                });
            }

            // Variables
            if ((match = patterns.assign.exec(line))) {
                const [, name, value] = match;
                if (!name.startsWith('_')) {
                    entities.push({
                        type: 'variable',
                        name,
                        fullName: `${relativePath}::${name}`,
                        signature: `${name} = ${value}`,
                        startLine: idx + 1,
                        endLine: idx + 1,
                        filePath: relativePath,
                        containingDirectory: containingDir,
                        isExported: true,
                    });
                }
            }
        });

        return entities;
    }

    private _extractDocBlock(node: any) {
        if (!node.body || !Array.isArray(node.body)) return undefined;
        const first = node.body[0];
        if (first && first._type === 'Expr' && first.value && first.value._type === 'Str') {
            const raw = first.value.s || '';
            const lines = raw.split('\n').map((l: string) => l.trim());
            const summary = lines[0] || '';
            const description = lines.slice(1).join(' ').trim();
            return { summary, description, params: [], returns: undefined };
        }
        return undefined;
    }
}