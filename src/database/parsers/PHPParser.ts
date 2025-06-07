// PHP parser module
import { BaseLanguageParser } from './ILanguageParser.js';
import { ExtractedImport, ExtractedCodeEntity } from '../services/CodebaseIntrospectionService.js';
import { HTMLParser } from './HTMLParser.js'; // Import HTMLParser
import phpParser from 'php-parser';
import path from 'path';

export class PHPParser extends BaseLanguageParser {
    private parser: phpParser.Engine;
    private htmlParser: HTMLParser; // Add instance of HTMLParser

    constructor(projectRootPath: string = process.cwd()) {
        super(projectRootPath);
        this.htmlParser = new HTMLParser(projectRootPath); // Initialize HTMLParser
        this.parser = new phpParser.Engine({
            parser: {
                extractDoc: true,
                php7: true,
            },
            ast: {
                withPositions: true,
                withSource: true,
            },
        });
    }

    getSupportedExtensions(): string[] {
        return ['.php'];
    }
    getLanguageName(): string {
        return 'php';
    }

    async parseImports(filePath: string, fileContent: string): Promise<ExtractedImport[]> {
        const imports: ExtractedImport[] = [];
        try {
            const ast = this.parser.parseCode(fileContent, filePath);

            const traverse = (node: any) => {
                if (!node) return;

                if (node.kind === 'usegroup') {
                    const prefix = node.name;
                    node.items.forEach((item: any) => {
                        const fullPath = prefix + '\\' + item.name;
                        imports.push({
                            type: 'module', // PHP 'use' is for modules/namespaces
                            targetPath: fullPath,
                            originalImportString: `use ${fullPath}` + (item.alias ? ` as ${item.alias.name}` : ''),
                            importedSymbols: [item.alias ? item.alias.name : item.name.split('\\').pop()],
                            isDynamicImport: false,
                            isTypeOnlyImport: false, // PHP doesn't have this concept
                            startLine: node.loc.start.line,
                            endLine: node.loc.end.line,
                        });
                    });
                } else if (node.kind === 'useitem') {
                     imports.push({
                        type: 'module',
                        targetPath: node.name,
                        originalImportString: `use ${node.name}` + (node.alias ? ` as ${node.alias.name}` : ''),
                        importedSymbols: [node.alias ? node.alias.name : node.name.split('\\').pop()],
                        isDynamicImport: false,
                        isTypeOnlyImport: false,
                        startLine: node.loc.start.line,
                        endLine: node.loc.end.line,
                    });
                } else if (node.kind === 'include' || node.kind === 'require') {
                    // Handle include/require for file-level dependencies
                    if(node.target && node.target.kind === 'string') {
                        const targetPath = path.resolve(path.dirname(filePath), node.target.value);
                        imports.push({
                            type: 'file',
                            targetPath: targetPath,
                            originalImportString: `${node.kind} '${node.target.value}';`,
                            isDynamicImport: true, // these are runtime inclusions
                            isTypeOnlyImport: false,
                            startLine: node.loc.start.line,
                            endLine: node.loc.end.line,
                        });
                    }
                }


                // Recursively traverse children
                 if (Array.isArray(node.children)) {
                    node.children.forEach(traverse);
                }
                 if (Array.isArray(node.items)) {
                    node.items.forEach(traverse);
                }
            };
            ast.children.forEach(traverse);
        } catch (error) {
            console.error(`Error parsing PHP imports in ${filePath}:`, error);
        }
        return imports;
    }
    
    private formatSignature(node: any, fileContent: string): string {
        if (!node.loc) return node.name?.name || '';
        
        const source = node.loc.source;
        if (!source) return node.name?.name || '';
    
        // For functions and methods, extract up to the opening brace '{' or semicolon ';'
        if ((node.kind === 'function' || node.kind === 'method') && node.body) {
            const end = node.body.loc.start.offset;
            return fileContent.substring(node.loc.start.offset, end).replace(/{\s*$/, '').trim();
        }
    
        // For classes and interfaces, extract up to the opening brace '{'
        if ((node.kind === 'class' || node.kind === 'interface' || node.kind === 'trait') && node.body) {
            const end = node.body.loc.start.offset;
            return fileContent.substring(node.loc.start.offset, end).replace(/{\s*$/, '').trim();
        }
    
        // Fallback for properties or other kinds
        return source.trim();
    }


    async parseCodeEntities(filePath: string, fileContent: string, projectRootPath: string): Promise<ExtractedCodeEntity[]> {
        const entities: ExtractedCodeEntity[] = [];
        const absoluteFilePath = path.resolve(filePath).replace(/\\/g, '/');
        const relativeFilePath = path.relative(projectRootPath, absoluteFilePath).replace(/\\/g, '/');
        const containingDirectory = path.dirname(relativeFilePath).replace(/\\/g, '/');

        // First, parse for PHP entities
        try {
            const ast = this.parser.parseCode(fileContent, filePath);
            const traverse = (node: any, namespace: string = '', parentClass: any = null): void => {
                if (!node || !node.kind) return;

                const baseEntity = {
                    startLine: node.loc.start.line,
                    endLine: node.loc.end.line,
                    filePath: absoluteFilePath,
                    containingDirectory: containingDirectory,
                    signature: this.formatSignature(node, fileContent),
                    docstring: Array.isArray(node.leadingComments) ? node.leadingComments.map((c: any) => c.value).join('\n') : null
                };

                let currentNamespace = namespace;

                if (node.kind === 'namespace') {
                    currentNamespace = node.name;
                    if (Array.isArray(node.children)) {
                        node.children.forEach((child: any) => traverse(child, currentNamespace, parentClass));
                    }
                    return;
                }
                
                const getFullName = (name: string, parentName?: string) => {
                    let fullName = currentNamespace ? `${currentNamespace}\\` : '';
                    if (parentName) fullName += `${parentName}::`;
                    return fullName + name;
                };

                switch (node.kind) {
                    case 'class':
                    case 'interface':
                    case 'trait':
                        const className = node.name.name;
                        entities.push({ ...baseEntity, type: node.kind, name: className, fullName: getFullName(className), isExported: node.isFinal || node.isAbstract, parentClass: node.extends ? node.extends.name : null, implementedInterfaces: (node.implements || []).map((i: any) => i.name) });
                        if (Array.isArray(node.body)) {
                            node.body.forEach((child: any) => traverse(child, currentNamespace, node));
                        }
                        break;
                    case 'function':
                        entities.push({ ...baseEntity, type: 'function', name: node.name.name, fullName: getFullName(node.name.name), isExported: true, isAsync: false, parameters: node.arguments.map((p: any) => ({ name: p.name.name, type: p.type ? p.type.name : null, optional: !!p.value })), returnType: node.returnType ? node.returnType.name : null });
                        break;
                    case 'method':
                        const parentName = parentClass?.name?.name || 'anonymous_class';
                        entities.push({ ...baseEntity, type: 'method', name: node.name.name, fullName: getFullName(node.name.name, parentName), parentClass: parentName, isExported: node.isPublic, isAsync: node.isAsync, parameters: node.arguments.map((p: any) => ({ name: p.name.name, type: p.type ? p.type.name : null, optional: !!p.value })), returnType: node.returnType ? node.returnType.name : null });
                        break;
                    case 'property':
                        entities.push({ ...baseEntity, type: 'property', name: node.name.name, fullName: getFullName(node.name.name, parentClass?.name?.name || 'anonymous_class'), parentClass: parentClass?.name?.name || null, isExported: node.isPublic });
                        break;
                    case 'constant':
                        entities.push({ ...baseEntity, type: 'variable', name: node.name.name, fullName: getFullName(node.name.name, parentClass?.name?.name || 'anonymous_class'), parentClass: parentClass?.name?.name || null, isExported: true });
                        break;
                }

                if (Array.isArray(node.children)) {
                    node.children.forEach((child: any) => traverse(child, currentNamespace, parentClass));
                }
            };
            traverse(ast);
        } catch (error) {
            // If PHP parsing fails, it might be an HTML file with PHP tags.
            // We can still try to parse it for HTML entities.
            console.warn(`PHP parsing failed for ${filePath}, proceeding with HTML parsing. Error: ${error}`);
        }

        // Second, parse for inline HTML entities
        try {
            const htmlEntities = await this.htmlParser.parseCodeEntities(filePath, fileContent, projectRootPath);
            entities.push(...htmlEntities);
        } catch (error) {
            console.error(`Error parsing inline HTML in ${filePath}:`, error);
        }

        return entities;
    }
}
