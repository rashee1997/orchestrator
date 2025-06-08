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
                if (!node || typeof node !== 'object') return;

                if (node.type === AST_NODE_TYPES.ImportExpression) {
                    if (node.source && node.source.type === AST_NODE_TYPES.Literal && typeof node.source.value === 'string') {
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
                            isDynamicImport: false, // This is a CommonJS-style import, not ES module dynamic
                            isTypeOnlyImport: false,
                            startLine: node.loc!.start.line,
                            endLine: node.loc!.end.line,
                        });
                    }
                }
                for (const key in node) {
                    if (node.hasOwnProperty(key)) {
                        const child = node[key];
                        if (child && typeof child === 'object') {
                            if (Array.isArray(child)) {
                                child.forEach(traverseNode);
                            } else {
                                traverseNode(child);
                            }
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
            // Normalize to POSIX-style paths for consistency
            return resolved.replace(/\\/g, '/');
        }
        // It's an external library/module
        return importSpecifier;
    }

    private determineImportType(importSpecifier: string, currentFilePath: string): ExtractedImport['type'] {
        if (importSpecifier.startsWith('.') || path.isAbsolute(importSpecifier)) {
            return 'file';
        }
        return 'external_library';
    }

    private formatSignature(node: any, fileContent: string): string {
        if (!node.range) return node.id?.name || '';
    
        let signatureText = '';
    
        if (node.type === AST_NODE_TYPES.FunctionDeclaration || node.type === AST_NODE_TYPES.MethodDefinition || node.type === AST_NODE_TYPES.TSDeclareFunction) {
            const start = node.range[0];
            const end = node.body ? node.body.range[0] - 1 : node.range[1];
            signatureText = fileContent.substring(start, end).replace(/{\s*$/, '').trim();
        } else if (node.type === AST_NODE_TYPES.ClassDeclaration || node.type === AST_NODE_TYPES.TSInterfaceDeclaration) {
            const start = node.range[0];
            const end = node.body ? node.body.range[0] : node.range[1];
            signatureText = fileContent.substring(start, end).replace(/{\s*$/, '').trim();
        } else {
            // Fallback for other types like variables or properties
            signatureText = fileContent.substring(node.range[0], node.range[1]).trim();
        }
    
        // Clean up excessive whitespace
        return signatureText.replace(/\s+/g, ' ');
    }
    
    async parseCodeEntities(filePath: string, fileContent: string, projectRootPath: string): Promise<ExtractedCodeEntity[]> {
        const entities: ExtractedCodeEntity[] = [];
        const absoluteFilePath = path.resolve(filePath).replace(/\\/g, '/');
        const relativeFilePath = path.relative(projectRootPath, absoluteFilePath).replace(/\\/g, '/');
        const containingDirectory = path.dirname(relativeFilePath).replace(/\\/g, '/');

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

            const traverseNode = (node: any, parent?: any, currentClassFullName: string | null = null): void => {
                if (!node || !node.type) return;

                const baseEntity: ExtractedCodeEntity = {
                    type: 'unknown', // Initialize with a default type
                    startLine: node.loc!.start.line,
                    endLine: node.loc!.end.line,
                    filePath: absoluteFilePath,
                    containingDirectory: containingDirectory,
                    signature: this.formatSignature(node, fileContent),
                    calls: [], // Initialize calls array
                };

                let newCurrentClassFullName = currentClassFullName;

                switch (node.type) {
                    case AST_NODE_TYPES.ClassDeclaration:
                        newCurrentClassFullName = `${relativeFilePath}::${node.id.name}`;
                        entities.push({
                            ...baseEntity,
                            type: 'class',
                            name: node.id.name,
                            fullName: newCurrentClassFullName,
                            isExported: parent.type === AST_NODE_TYPES.ExportNamedDeclaration || parent.type === AST_NODE_TYPES.ExportDefaultDeclaration,
                            implementedInterfaces: (node.implements || []).map((impl: any) => impl.expression.name),
                        });
                        break;

                    case AST_NODE_TYPES.FunctionDeclaration:
                    case AST_NODE_TYPES.ArrowFunctionExpression:
                    case AST_NODE_TYPES.FunctionExpression:
                        // Handle function calls within functions/methods
                        const functionCalls: Array<{ name: string; type: 'function' | 'method' | 'unknown'; }> = [];
                        const collectCalls = (n: any) => {
                            if (n.type === AST_NODE_TYPES.CallExpression && n.callee) {
                                if (n.callee.type === AST_NODE_TYPES.Identifier) {
                                    functionCalls.push({ name: n.callee.name, type: 'function' });
                                } else if (n.callee.type === AST_NODE_TYPES.MemberExpression && n.callee.property.type === AST_NODE_TYPES.Identifier) {
                                    functionCalls.push({ name: n.callee.property.name, type: 'method' });
                                }
                            }
                            for (const key in n) {
                                if (n.hasOwnProperty(key) && typeof n[key] === 'object' && n[key] !== null) {
                                    if (Array.isArray(n[key])) {
                                        n[key].forEach(collectCalls);
                                    } else {
                                        collectCalls(n[key]);
                                    }
                                }
                            }
                        };
                        collectCalls(node.body); // Only traverse the body for calls

                        entities.push({
                            ...baseEntity,
                            type: 'function',
                            name: node.id?.name || `anonymous_function_at_line_${node.loc!.start.line}`, // Handle anonymous functions with line number
                            fullName: `${relativeFilePath}::${node.id?.name || `anonymous_function_at_line_${node.loc!.start.line}`}`,
                            isExported: parent.type === AST_NODE_TYPES.ExportNamedDeclaration || parent.type === AST_NODE_TYPES.ExportDefaultDeclaration,
                            isAsync: node.async,
                            parameters: node.params.map((p: any) => ({ name: p.name, type: p.typeAnnotation?.typeAnnotation?.typeName?.name })),
                            returnType: node.returnType?.typeAnnotation?.typeName?.name,
                            calls: functionCalls,
                        });
                        break;

                    case AST_NODE_TYPES.MethodDefinition:
                        const methodCalls: Array<{ name: string; type: 'function' | 'method' | 'unknown'; }> = [];
                        const collectMethodCalls = (n: any) => {
                            if (n.type === AST_NODE_TYPES.CallExpression && n.callee) {
                                if (n.callee.type === AST_NODE_TYPES.Identifier) {
                                    methodCalls.push({ name: n.callee.name, type: 'function' });
                                } else if (n.callee.type === AST_NODE_TYPES.MemberExpression && n.callee.property.type === AST_NODE_TYPES.Identifier) {
                                    methodCalls.push({ name: n.callee.property.name, type: 'method' });
                                }
                            }
                            for (const key in n) {
                                if (n.hasOwnProperty(key) && typeof n[key] === 'object' && n[key] !== null) {
                                    if (Array.isArray(n[key])) {
                                        n[key].forEach(collectMethodCalls);
                                    } else {
                                        collectMethodCalls(n[key]);
                                    }
                                }
                            }
                        };
                        collectMethodCalls(node.value.body); // Only traverse the method body for calls

                        entities.push({
                            ...baseEntity,
                            type: 'method',
                            name: (node.key as TSESTree.Identifier).name,
                            fullName: `${currentClassFullName || relativeFilePath}::${(node.key as TSESTree.Identifier).name}`,
                            parentClass: currentClassFullName ? currentClassFullName.split('::').pop() : null,
                            isExported: false, // Methods are exported via their class
                            isAsync: node.value.async,
                            parameters: node.value.params.map((p: any) => ({ name: p.name, type: p.typeAnnotation?.typeAnnotation?.typeName?.name })),
                            returnType: node.value.returnType?.typeAnnotation?.typeName?.name,
                            calls: methodCalls,
                            accessibility: node.accessibility || 'public', // Add accessibility
                        });
                        break;

                    case AST_NODE_TYPES.TSInterfaceDeclaration:
                        entities.push({
                            ...baseEntity,
                            type: 'interface',
                            name: node.id.name,
                            fullName: `${relativeFilePath}::${node.id.name}`,
                            isExported: parent.type === AST_NODE_TYPES.ExportNamedDeclaration,
                        });
                        break;

                    case AST_NODE_TYPES.VariableDeclarator:
                        if (node.id.type === AST_NODE_TYPES.Identifier) {
                            entities.push({
                                ...baseEntity,
                                type: 'variable',
                                name: node.id.name,
                                fullName: `${relativeFilePath}::${node.id.name}`,
                                isExported: parent.type === AST_NODE_TYPES.VariableDeclaration && (parent.parent?.type === AST_NODE_TYPES.ExportNamedDeclaration || parent.parent?.type === AST_NODE_TYPES.ExportDefaultDeclaration),
                                // Add more details if needed, e.g., initial value, type annotation
                            });
                        }
                        break;

                    case AST_NODE_TYPES.IfStatement:
                    case AST_NODE_TYPES.ForStatement:
                    case AST_NODE_TYPES.ForInStatement:
                    case AST_NODE_TYPES.ForOfStatement:
                    case AST_NODE_TYPES.WhileStatement:
                    case AST_NODE_TYPES.DoWhileStatement:
                    case AST_NODE_TYPES.SwitchStatement:
                    case AST_NODE_TYPES.TryStatement:
                        entities.push({
                            ...baseEntity,
                            type: 'control_flow',
                            name: node.type.replace('Statement', ''), // e.g., 'If', 'For'
                            fullName: `${relativeFilePath}::${node.type.replace('Statement', '')}::${node.loc!.start.line}`,
                            // No export concept for control flow
                        });
                        break;
                }

                // Recursively traverse children
                for (const key in node) {
                    if (node.hasOwnProperty(key)) {
                        const child = node[key];
                        if (child && typeof child === 'object' && key !== 'parent') { // Avoid circular reference
                            if (Array.isArray(child)) {
                                child.forEach(item => traverseNode(item, node, newCurrentClassFullName));
                            } else {
                                traverseNode(child, node, newCurrentClassFullName);
                            }
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
