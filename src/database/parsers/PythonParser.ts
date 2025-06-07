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
        const endOfSignature = node.body?.[0]?.start ?? node.end;
        let signature = fileContent.substring(node.start, endOfSignature).trim();
        if (signature.endsWith(':')) {
            signature = signature.slice(0, -1).trim();
        }
        return signature.replace(/\s+/g, ' ');
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
                    signature: this.formatSignature(node, fileContent),
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
                            parentClass: parentName || null,
                            isExported: !functionName.startsWith('_'),
                            isAsync: node.type === 'AsyncFunctionDef',
                            parameters: node.args.args.map((arg: any) => ({
                                name: arg.arg,
                                type: arg.annotation ? fileContent.substring(arg.annotation.start, arg.annotation.end) : null,
                            })),
                            returnType: node.returns ? fileContent.substring(node.returns.start, node.returns.end) : null,
                        });
                        break;

                    case 'ClassDef':
                        const className = node.name;
                        entities.push({
                            ...baseEntity,
                            type: 'class',
                            name: className,
                            fullName: getFullName(className),
                            isExported: !className.startsWith('_'),
                            parentClass: node.bases.length > 0 ? node.bases[0].id : null, // Simplified to first base
                            implementedInterfaces: node.bases.map((b:any) => b.id),
                        });
                        // Traverse methods and properties inside the class
                        if (Array.isArray(node.body)) {
                            node.body.forEach((child: any) => traverse(child, node));
                        }
                        break;
                }
                
                // Generic traversal for top-level nodes
                if (!parentClass && Array.isArray(node.body)) {
                     node.body.forEach((child: any) => traverse(child, null));
                }
            };
            
            traverse(ast);

        } catch (error) {
            console.error(`Error parsing Python code entities in ${filePath}:`, error);
        }
        return entities;
    }
}
