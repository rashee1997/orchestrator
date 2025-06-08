// Python parser module
import { BaseLanguageParser } from './ILanguageParser.js';
import { ExtractedImport, ExtractedCodeEntity } from '../services/CodebaseIntrospectionService.js';
import filbert from 'filbert';
import path from 'path';

export class PythonParser extends BaseLanguageParser {
    getSupportedExtensions(): string[] {
        return ['.py'];
    }
    getLanguageName(): string {
        return 'python';
    }

    async parseImports(filePath: string, fileContent: string): Promise<ExtractedImport[]> {
        const imports: ExtractedImport[] = [];
        try {
            // filbert's 'locations' option provides line numbers
            const ast = filbert.parse(fileContent, { locations: true });
            const traverse = (node: any) => {
                if (!node) return;
                
                if (node.type === 'Import') { // Corresponds to `import foo, bar as b`
                    node.names.forEach((alias: any) => {
                         imports.push({
                            type: 'module',
                            targetPath: alias.name,
                            originalImportString: fileContent.substring(node.start, node.end),
                            importedSymbols: [alias.asname || alias.name],
                            isDynamicImport: false,
                            isTypeOnlyImport: false,
                            startLine: node.loc.start.line,
                            endLine: node.loc.end.line,
                        });
                    });
                } else if (node.type === 'ImportFrom') { // Corresponds to `from foo import bar, baz as c`
                    const modulePath = node.module || '';
                    node.names.forEach((alias: any) => {
                         imports.push({
                            type: 'module',
                            targetPath: modulePath,
                            originalImportString: fileContent.substring(node.start, node.end),
                            importedSymbols: [alias.asname || alias.name],
                            isDynamicImport: false,
                            isTypeOnlyImport: false,
                            startLine: node.loc.start.line,
                            endLine: node.loc.end.line,
                        });
                    });
                }

                // Generic traversal for other node types
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

    private formatSignature(node: any, fileContent: string): string {
        if (!node.start || !node.end) return node.name || '';
        // For functions/methods, capture up to the colon before the body
        if (node.type === 'FunctionDef' || node.type === 'AsyncFunctionDef') {
            const endOfSignature = node.body?.[0]?.start ?? node.end;
            let signature = fileContent.substring(node.start, endOfSignature).trim();
            if (signature.endsWith(':')) {
                signature = signature.slice(0, -1).trim();
            }
            return signature.replace(/\s+/g, ' ');
        }
        // For classes, just the class definition line
        if (node.type === 'ClassDef') {
            const endOfSignature = node.body?.[0]?.start ?? node.end;
            let signature = fileContent.substring(node.start, endOfSignature).trim();
            if (signature.endsWith(':')) {
                signature = signature.slice(0, -1).trim();
            }
            return signature.replace(/\s+/g, ' ');
        }
        // For variables, just the assignment part
        if (node.type === 'Assign' && node.targets && node.targets.length > 0) {
            return fileContent.substring(node.targets[0].start, node.end).trim().replace(/\s+/g, ' ');
        }
        return node.name || '';
    }

    private extractCalls(node: any, fileContent: string): Array<{ name: string; type: 'function' | 'method' | 'unknown'; }> {
        const calls: Array<{ name: string; type: 'function' | 'method' | 'unknown'; }> = [];
        const traverse = (currentNode: any) => {
            if (!currentNode) return;

            if (currentNode.type === 'CallExpression' && currentNode.callee) {
                let callName: string | null = null;
                let callType: 'function' | 'method' | 'unknown' = 'unknown';

                if (currentNode.callee.type === 'Name') {
                    callName = currentNode.callee.id;
                    callType = 'function';
                } else if (currentNode.callee.type === 'MemberExpression' && currentNode.callee.property) {
                    callName = currentNode.callee.property.id;
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
            
            const traverse = (node: any, parentClass: any = null): void => {
                if (!node || !node.type) return;

                const baseEntity = {
                    startLine: node.loc.start.line,
                    endLine: node.loc.end.line,
                    filePath: absoluteFilePath,
                    containingDirectory: containingDirectory,
                    docstring: this.extractDocstring(fileContent, node.range[0]),
                };
                
                const getFullName = (name: string, parentName?: string) => {
                    let fullName = relativeFilePath.replace(/\//g, '.').replace(/\.py$/, '');
                    if (parentName) {
                        fullName += `.${parentName}`;
                    }
                    return `${fullName}.${name}`;
                };

                switch (node.type) {
                    case 'FunctionDef':
                    case 'AsyncFunctionDef':
                        const functionName = node.name;
                        const parentName = parentClass?.name;
                        entities.push({
                            ...baseEntity,
                            type: parentClass ? 'method' : 'function',
                            name: functionName,
                            fullName: getFullName(functionName, parentName),
                            signature: this.formatSignature(node, fileContent),
                            parentClass: parentName || null,
                            isExported: !functionName.startsWith('_'), // Python convention for "private"
                            isAsync: node.type === 'AsyncFunctionDef',
                            parameters: node.args.args.map((arg: any) => ({
                                name: arg.arg,
                                type: arg.annotation ? fileContent.substring(arg.annotation.start, arg.annotation.end) : null,
                                defaultValue: arg.value ? fileContent.substring(arg.value.start, arg.value.end) : null,
                            })),
                            returnType: node.returns ? fileContent.substring(node.returns.start, node.returns.end) : null,
                            calls: this.extractCalls(node.body, fileContent),
                        });
                        // Recursively traverse function body for nested entities or calls
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
                            parentClass: node.bases.length > 0 ? node.bases[0].id : null, // Simplified to first base
                            implementedInterfaces: node.bases.map((b:any) => b.id), // Python doesn't have interfaces, but can use this for inheritance
                        });
                        // Traverse methods and properties inside the class
                        if (Array.isArray(node.body)) {
                            node.body.forEach((child: any) => traverse(child, node));
                        }
                        break;
                    
                    case 'Assign': // For variable definitions
                        if (node.targets && node.targets.length > 0 && node.targets[0].type === 'Name') {
                            const varName = node.targets[0].id;
                            entities.push({
                                ...baseEntity,
                                type: 'variable',
                                name: varName,
                                fullName: getFullName(varName, parentClass?.name),
                                signature: this.formatSignature(node, fileContent),
                                isExported: !varName.startsWith('_'),
                            });
                        }
                        break;

                    case 'If':
                    case 'For':
                    case 'While':
                    case 'Try':
                    case 'With':
                        entities.push({
                            ...baseEntity,
                            type: 'control_flow',
                            name: node.type, // e.g., "If", "For"
                            fullName: getFullName(node.type, parentClass?.name),
                            signature: this.formatSignature(node, fileContent),
                        });
                        // Continue traversal into control flow bodies
                        if (Array.isArray(node.body)) {
                            node.body.forEach((child: any) => traverse(child, parentClass));
                        }
                        if (node.orelse && Array.isArray(node.orelse)) { // For 'else' or 'elif' in If, or 'else' in For/While
                            node.orelse.forEach((child: any) => traverse(child, parentClass));
                        }
                        if (node.handlers && Array.isArray(node.handlers)) { // For 'except' in Try
                            node.handlers.forEach((child: any) => traverse(child, parentClass));
                        }
                        if (node.finalbody && Array.isArray(node.finalbody)) { // For 'finally' in Try
                            node.finalbody.forEach((child: any) => traverse(child, parentClass));
                        }
                        break;
                    
                    case 'Expr': // Often used for docstrings or standalone expressions
                        if (node.value && node.value.type === 'Str') {
                            // This is likely a docstring if it's the first statement in a function/class body
                            // We already handle docstrings via extractDocstring, so this might be redundant or need refinement
                        }
                        break;
                }
                
                // Generic traversal for all child nodes, unless handled specifically above
                for (const key in node) {
                    if (node.hasOwnProperty(key)) {
                        const child = node[key];
                        if (child && typeof child === 'object' && key !== 'body' && key !== 'orelse' && key !== 'handlers' && key !== 'finalbody') {
                            if (Array.isArray(child)) {
                                child.forEach(traverse);
                            } else {
                                traverse(child, parentClass);
                            }
                        }
                    }
                }
            };
            
            traverse(ast);

        } catch (error) {
            console.error(`Error parsing Python code entities in ${filePath}:`, error);
        }
        return entities;
    }
}
