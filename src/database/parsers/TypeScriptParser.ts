// TypeScript/JavaScript parser module
import { parse } from '@typescript-eslint/typescript-estree';
import { AST_NODE_TYPES, TSESTree } from '@typescript-eslint/types';
import { BaseLanguageParser } from './ILanguageParser.js';
import { ExtractedImport, ExtractedCodeEntity } from '../services/CodebaseIntrospectionService.js';
import path from 'path';

export class TypeScriptParser extends BaseLanguageParser {
    getSupportedExtensions(): string[] {
        return ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
    }
    getLanguageName(): string {
        return 'typescript';
    }

    async parseImports(filePath: string, fileContent: string): Promise<ExtractedImport[]> {
        const imports: ExtractedImport[] = [];
        try {
            const ast = parse(fileContent, {
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
                        type: this.determineImportType(source, filePath),
                        targetPath: this.resolveImportPath(source, filePath),
                        originalImportString: fileContent.substring(node.range![0], node.range![1]),
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
                        type: this.determineImportType(source, filePath),
                        targetPath: this.resolveImportPath(source, filePath),
                        originalImportString: fileContent.substring(node.range![0], node.range![1]),
                        importedSymbols: node.specifiers.map((spec: any) => spec.local.name),
                        isDynamicImport: false,
                        isTypeOnlyImport: node.exportKind === 'type',
                        startLine: node.loc!.start.line,
                        endLine: node.loc!.end.line,
                    });
                } else if (node.type === AST_NODE_TYPES.ExportAllDeclaration && node.source) {
                    const source = node.source.value;
                    imports.push({
                        type: this.determineImportType(source, filePath),
                        targetPath: this.resolveImportPath(source, filePath),
                        originalImportString: fileContent.substring(node.range![0], node.range![1]),
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
                            type: this.determineImportType(source, filePath),
                            targetPath: this.resolveImportPath(source, filePath),
                            originalImportString: fileContent.substring(node.range![0], node.range![1]),
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
                            type: this.determineImportType(source, filePath),
                            targetPath: this.resolveImportPath(source, filePath),
                            originalImportString: fileContent.substring(node.range![0], node.range![1]),
                            isDynamicImport: false,
                            isTypeOnlyImport: false,
                            startLine: node.loc!.start.line,
                            endLine: node.loc!.end.line,
                        });
                    }
                }
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
            console.error(`Error parsing imports in ${filePath}:`, error);
        }
        return imports;
    }

    private resolveImportPath(importSpecifier: string, currentFilePath: string): string {
        if (importSpecifier.startsWith('.') || path.isAbsolute(importSpecifier)) {
            let resolved = path.resolve(path.dirname(currentFilePath), importSpecifier);
            return resolved.replace(/\\/g, '/');
        }
        return importSpecifier;
    }

    private determineImportType(importSpecifier: string, currentFilePath: string): ExtractedImport['type'] {
        if (importSpecifier.startsWith('.') || path.isAbsolute(importSpecifier)) {
            return 'file';
        }
        return 'external_library';
    }

    async parseCodeEntities(filePath: string, fileContent: string, projectRootPath: string): Promise<ExtractedCodeEntity[]> {
        const entities: ExtractedCodeEntity[] = [];
        const relativeFilePath = path.relative(projectRootPath, filePath).replace(/\\/g, '/');
        try {
            const ast = parse(fileContent, {
                ecmaVersion: 2022,
                sourceType: 'module',
                jsx: filePath.endsWith('.tsx') || filePath.endsWith('.jsx'),
                loc: true,
                range: true,
                comment: true,
                attachComment: true,
            });
            const traverseNode = (node: any, parent?: any): void => {
                switch (node.type) {
                    case AST_NODE_TYPES.ClassDeclaration:
                        entities.push({
                            type: 'class',
                            name: node.id.name,
                            fullName: relativeFilePath + '::' + node.id.name,
                            startLine: node.loc!.start.line,
                            endLine: node.loc!.end.line,
                            filePath: filePath,
                            isExported: node.exported,
                        });
                        break;
                    case AST_NODE_TYPES.FunctionDeclaration:
                        entities.push({
                            type: 'function',
                            name: node.id.name,
                            fullName: relativeFilePath + '::' + node.id.name,
                            startLine: node.loc!.start.line,
                            endLine: node.loc!.end.line,
                            filePath: filePath,
                            isExported: node.exported,
                        });
                        break;
                    case AST_NODE_TYPES.TSInterfaceDeclaration:
                        entities.push({
                            type: 'interface',
                            name: node.id.name,
                            fullName: relativeFilePath + '::' + node.id.name,
                            startLine: node.loc!.start.line,
                            endLine: node.loc!.end.line,
                            filePath: filePath,
                            isExported: node.exported,
                        });
                        break;
                    case AST_NODE_TYPES.MethodDefinition:
                        entities.push({
                            type: 'method',
                            name: node.key.name,
                            fullName: relativeFilePath + '::' + node.key.name,
                            startLine: node.loc!.start.line,
                            endLine: node.loc!.end.line,
                            filePath: filePath,
                            isExported: node.exported,
                        });
                        break;
                    case AST_NODE_TYPES.VariableDeclaration:
                        node.declarations.forEach((declaration: any) => {
                            if (declaration.id.type === AST_NODE_TYPES.Identifier) {
                                entities.push({
                                    type: 'variable',
                                    name: declaration.id.name,
                                    fullName: relativeFilePath + '::' + declaration.id.name,
                                    startLine: node.loc!.start.line,
                                    endLine: node.loc!.end.line,
                                    filePath: filePath,
                                    isExported: node.exported, // Assuming variable declarations are not directly exported
                                });
                            }
                        });
                        break;
                    case AST_NODE_TYPES.TSPropertySignature:
                        entities.push({
                            type: 'property',
                            name: node.key.name,
                            fullName: relativeFilePath + '::' + node.key.name,
                            startLine: node.loc!.start.line,
                            endLine: node.loc!.end.line,
                            filePath: filePath,
                            isExported: node.exported, // Assuming property signatures are not directly exported
                        });
                        break;
                    case AST_NODE_TYPES.TSMethodSignature:
                        entities.push({
                            type: 'method',
                            name: node.key.name,
                            fullName: relativeFilePath + '::' + node.key.name,
                            startLine: node.loc!.start.line,
                            endLine: node.loc!.end.line,
                            filePath: filePath,
                            isExported: node.exported, // Assuming method signatures are not directly exported
                        });
                        break;
                    case 'TSPropertyDeclaration':
                        entities.push({
                            type: 'property',
                            name: node.key.name,
                            fullName: relativeFilePath + '::' + node.key.name,
                            startLine: node.loc!.start.line,
                            endLine: node.loc!.end.line,
                            filePath: filePath,
                            isExported: node.exported, // Assuming property declarations are not directly exported
                        });
                        break;
                    // Add more cases for other code entity types (e.g., methods, variables, etc.)
                    case AST_NODE_TYPES.TSEnumDeclaration:
                        entities.push({
                            type: 'enum',
                            name: node.id.name,
                            fullName: relativeFilePath + '::' + node.id.name,
                            startLine: node.loc!.start.line,
                            endLine: node.loc!.end.line,
                            filePath: filePath,
                            isExported: node.exported,
                        });
                        break;
                    case AST_NODE_TYPES.TSTypeAliasDeclaration:
                        entities.push({
                            type: 'type_alias',
                            name: node.id.name,
                            fullName: relativeFilePath + '::' + node.id.name,
                            startLine: node.loc!.start.line,
                            endLine: node.loc!.end.line,
                            filePath: filePath,
                            isExported: node.exported,
                        });
                        break;
                    case AST_NODE_TYPES.TSModuleDeclaration:
                        entities.push({
                            type: 'module',
                            name: node.id.name,
                            fullName: relativeFilePath + '::' + node.id.name,
                            startLine: node.loc!.start.line,
                            endLine: node.loc!.end.line,
                            filePath: filePath,
                            isExported: node.exported,
                        });
                        break;
                    case AST_NODE_TYPES.TSCallSignatureDeclaration:
                        entities.push({
                            type: 'call_signature',
                            name: '', // call signatures may not have a name
                            fullName: relativeFilePath + '::call_signature',
                            startLine: node.loc!.start.line,
                            endLine: node.loc!.end.line,
                            filePath: filePath,
                            isExported: false,
                        });
                        break;
                    case AST_NODE_TYPES.TSConstructSignatureDeclaration:
                        entities.push({
                            type: 'construct_signature',
                            name: '', // construct signatures may not have a name
                            fullName: relativeFilePath + '::construct_signature',
                            startLine: node.loc!.start.line,
                            endLine: node.loc!.end.line,
                            filePath: filePath,
                            isExported: false,
                        });
                        break;
                    case AST_NODE_TYPES.TSIndexSignature:
                        entities.push({
                            type: 'index_signature',
                            name: '', // index signatures may not have a name
                            fullName: relativeFilePath + '::index_signature',
                            startLine: node.loc!.start.line,
                            endLine: node.loc!.end.line,
                            filePath: filePath,
                            isExported: false,
                        });
                        break;
                    case AST_NODE_TYPES.TSParameterProperty:
                        entities.push({
                            type: 'parameter_property',
                            name: node.parameter.name || '',
                            fullName: relativeFilePath + '::' + (node.parameter.name || ''),
                            startLine: node.loc!.start.line,
                            endLine: node.loc!.end.line,
                            filePath: filePath,
                            isExported: false,
                        });
                        break;
                    case AST_NODE_TYPES.TSAbstractMethodDefinition:
                        entities.push({
                            type: 'abstract_method',
                            name: node.key.name,
                            fullName: relativeFilePath + '::' + node.key.name,
                            startLine: node.loc!.start.line,
                            endLine: node.loc!.end.line,
                            filePath: filePath,
                            isExported: node.exported,
                        });
                        break;
                    case AST_NODE_TYPES.TSDeclareFunction:
                        entities.push({
                            type: 'declare_function',
                            name: node.id.name,
                            fullName: relativeFilePath + '::' + node.id.name,
                            startLine: node.loc!.start.line,
                            endLine: node.loc!.end.line,
                            filePath: filePath,
                            isExported: node.exported,
                        });
                        break;
                    case AST_NODE_TYPES.TSNamespaceExportDeclaration:
                        entities.push({
                            type: 'namespace_export',
                            name: node.id.name,
                            fullName: relativeFilePath + '::' + node.id.name,
                            startLine: node.loc!.start.line,
                            endLine: node.loc!.end.line,
                            filePath: filePath,
                            isExported: node.exported,
                        });
                        break;
                }
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
            console.error(`Error parsing code entities in ${filePath}:`, error);
        }
        return entities;
    }
}
