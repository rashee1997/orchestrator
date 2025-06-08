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
                        const targetValue = (node.target.value ?? '') as string;
                        const targetPath = path.resolve(path.dirname(filePath), targetValue);
                        imports.push({
                            type: 'file',
                            targetPath: targetPath,
                            originalImportString: `${node.kind} '${targetValue}';`,
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
        if ((node.kind === 'function' || node.kind === 'method' || node.kind === 'closure') && node.body) {
            const end = node.body.loc.start.offset;
            return fileContent.substring(node.loc.start.offset, end).replace(/{\s*$/, '').trim();
        }
    
        // For classes and interfaces, extract up to the opening brace '{'
        if ((node.kind === 'class' || node.kind === 'interface' || node.kind === 'trait') && node.body) {
            const end = node.body.loc.start.offset;
            return fileContent.substring(node.loc.start.offset, end).replace(/{\s*$/, '').trim();
        }

        // For calls, extract the function/method name and arguments
        if (node.kind === 'call' && node.what) {
            let callName = '';
            if (node.what.kind === 'name') {
                callName = node.what.name;
            } else if (node.what.kind === 'staticlookup' && node.what.what && node.what.what.kind === 'name' && node.what.offset && node.what.offset.kind === 'constref') {
                callName = `${node.what.what.name}::${node.what.offset.name}`;
            } else if (node.what.kind === 'propertylookup' && node.what.offset && node.what.offset.kind === 'constref') {
                callName = `->${node.what.offset.name}`;
            }
            const args = node.arguments.map((arg: any) => fileContent.substring(arg.loc.start.offset, arg.loc.end.offset)).join(', ');
            return `${callName}(${args})`;
        }
    
        // Fallback for properties or other kinds
        return source.trim();
    }

    private extractCalls(node: any, fileContent: string): Array<{ name: string; type: 'function' | 'method' | 'unknown'; }> {
        const calls: Array<{ name: string; type: 'function' | 'method' | 'unknown'; }> = [];
        const traverse = (currentNode: any) => {
            if (!currentNode) return;

            if (currentNode.kind === 'call' && currentNode.what) {
                let callName: string | null = null;
                let callType: 'function' | 'method' | 'unknown' = 'unknown';

                if (currentNode.what.kind === 'name') {
                    callName = currentNode.what.name;
                    callType = 'function';
                } else if (currentNode.what.kind === 'staticlookup' && currentNode.what.offset && currentNode.what.offset.kind === 'constref') {
                    callName = `${currentNode.what.what.name}::${currentNode.what.offset.name}`;
                    callType = 'method';
                } else if (currentNode.what.kind === 'propertylookup' && currentNode.what.offset && currentNode.what.offset.kind === 'constref') {
                    callName = `->${currentNode.what.offset.name}`;
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
        const relativeFilePath = path.relative(projectRootPath, absoluteFilePath).replace(/\\/g, '/');
        const containingDirectory = path.dirname(relativeFilePath).replace(/\\/g, '/');

        // First, parse for PHP entities
        try {
            const ast = this.parser.parseCode(fileContent, filePath);
            const traverse = (node: any, namespace: string = '', currentClassFullName: string | null = null, currentClassName: string | null = null): void => {
                if (!node || !node.kind) return;

                const baseEntity = {
                    startLine: node.loc.start.line,
                    endLine: node.loc.end.line,
                    filePath: absoluteFilePath,
                    containingDirectory: containingDirectory,
                    signature: this.formatSignature(node, fileContent),
                    docstring: Array.isArray(node.leadingComments) ? node.leadingComments.map((c: any) => c.value).join('\n') : null
                };

                let newCurrentNamespace: string = namespace;
                let newCurrentClassFullName: string | null = currentClassFullName;
                let newCurrentClassName: string | null = currentClassName;

                if (node.kind === 'namespace') {
                    newCurrentNamespace = String(node.name || ''); // Explicitly convert to string
                    if (Array.isArray(node.children)) {
                        node.children.forEach((child: any) => traverse(child, newCurrentNamespace, newCurrentClassFullName, newCurrentClassName));
                    }
                    return;
                }
                
                const getFullName = (name: string, parentName?: string | null) => {
                let fullName = (newCurrentNamespace ? `${newCurrentNamespace}\\` : '');
                if (parentName) fullName += `${parentName ?? ''}::`;
                return fullName + (name ?? '');
                };

                switch (node.kind) {
                    case 'class':
                    case 'interface':
                    case 'trait':
                        newCurrentClassName = node.name.name;
                        entities.push({
                            ...baseEntity,
                            type: node.kind,
                            name: newCurrentClassName || '',
                            isExported: node.isFinal || node.isAbstract,
                            parentClass: (node.extends?.name!) ?? "", // Use non-null assertion and coalesce
                            implementedInterfaces: (node.implements || []).map((i: any) => i.name)
                        });
                        if (Array.isArray(node.body)) {
                            node.body.forEach((child: any) => traverse(child, newCurrentNamespace, newCurrentClassFullName, newCurrentClassName));
                        }
                        break;
                    case 'function':
                    case 'closure': // Handle anonymous functions/closures
                        const functionName = node.name?.name || `anonymous_function_at_line_${node.loc.start.line}`;
                        entities.push({ 
                            ...baseEntity, 
                            type: 'function', 
                            name: functionName ?? '', 
                            fullName: getFullName(functionName), 
                            isExported: true, // Global functions are effectively exported
                            isAsync: false, // PHP functions are not inherently async in the JS sense
                            parameters: node.arguments.map((p: any) => ({ name: p.name.name, type: p.type ? p.type.name : null, optional: !!p.value })), 
                            returnType: node.returnType?.name ?? undefined, // Explicitly convert null to undefined
                            calls: this.extractCalls(node.body ?? {}, fileContent), // Extract calls within function body
                            parentClass: null, // Global functions have no parent class
                        });
                        // Recursively traverse function body for nested entities or calls
                        if (Array.isArray(node.body?.children)) {
                            node.body.children.forEach((child: any) => traverse(child, newCurrentNamespace, newCurrentClassFullName, newCurrentClassName));
                        }
                        break;
                    case 'method':
                        const methodName = node.name.name;
                        let accessibility: ExtractedCodeEntity['accessibility'] = 'public'; // Default to public
                        if (node.isPrivate) accessibility = 'private';
                        else if (node.isProtected) accessibility = 'protected';

                        entities.push({ 
                            ...baseEntity, 
                            type: 'method', 
                            name: methodName, 
                            fullName: `${newCurrentClassFullName || ''}::${methodName}`, 
                            parentClass: newCurrentClassName || '', // Always a string
                            isExported: node.isPublic, // PHP methods are public/private/protected
                            isAsync: false, // PHP methods are not inherently async
                            parameters: node.arguments.map((p: any) => ({ name: p.name.name, type: p.type ? p.type.name : null, optional: !!p.value })), 
                            returnType: node.returnType?.name ?? null, // Convert undefined to null
                            calls: this.extractCalls(node.body ?? {}, fileContent), // Extract calls within method body
                            accessibility: accessibility, // Add accessibility
                        });
                        // Recursively traverse method body for nested entities or calls
                        if (Array.isArray(node.body?.children)) {
                            node.body.children.forEach((child: any) => traverse(child, newCurrentNamespace, newCurrentClassFullName, newCurrentClassName));
                        }
                        break;
                    case 'property':
                        const propertyName = node.name.name;
                        let propertyAccessibility: ExtractedCodeEntity['accessibility'] = 'public'; // Default to public
                        if (node.isPrivate) propertyAccessibility = 'private';
                        else if (node.isProtected) propertyAccessibility = 'protected';
                        entities.push({
                            ...baseEntity,
                            type: 'property',
                            name: propertyName,
                            fullName: `${newCurrentClassFullName || ''}::${propertyName}`,
                            parentClass: newCurrentClassName ?? '', // Always a string
                            isExported: node.isPublic, // PHP properties are public/private/protected
                            accessibility: propertyAccessibility, // Add accessibility
                        });
                        break;
                    case 'constant':
                        const constantName = node.name.name;
                        entities.push({
                            ...baseEntity,
                            type: 'variable', // Constants can be treated as variables
                            name: constantName,
                            fullName: getFullName(constantName), // No parent class for global constants
                            parentClass: null, // Global constants have no parent class
                            isExported: true, // Constants are generally accessible
                        });
                        break;
                    
                    // Control flow statements
                    case 'if':
                    case 'for':
                    case 'foreach':
                    case 'while':
                    case 'do':
                    case 'switch':
                    case 'try':
                        entities.push({
                            ...baseEntity,
                            type: 'control_flow',
                            name: node.kind,
                            fullName: getFullName(node.kind), // No parent class for global control flow
                            signature: this.formatSignature(node, fileContent),
                            parentClass: null, // Control flow has no parent class
                        });
                        // Recursively traverse children of control flow statements
                        if (Array.isArray(node.body?.children)) {
                            node.body.children.forEach((child: any) => traverse(child, newCurrentNamespace, newCurrentClassFullName, newCurrentClassName));
                        }
                        if (Array.isArray(node.alternate?.children)) { // For 'else' or 'elseif'
                            node.alternate.children.forEach((child: any) => traverse(child, newCurrentNamespace, newCurrentClassFullName, newCurrentClassName));
                        }
                        if (Array.isArray(node.catches)) { // For 'catch' in try
                            node.catches.forEach((catchNode: any) => {
                                if (Array.isArray(catchNode.body?.children)) {
                                    catchNode.body.children.forEach((child: any) => traverse(child, newCurrentNamespace, newCurrentClassFullName, newCurrentClassName));
                                }
                            });
                        }
                        if (Array.isArray(node.finally?.children)) { // For 'finally' in try
                            node.finally.children.forEach((child: any) => traverse(child, newCurrentNamespace, newCurrentClassFullName, newCurrentClassName));
                        }
                        break;
                    
                    case 'call': // Handle standalone calls that are not part of a function/method body
                        entities.push({
                            ...baseEntity,
                            type: 'call_signature',
                            name: this.formatSignature(node, fileContent),
                            fullName: getFullName(this.formatSignature(node, fileContent)), // No parent class for global calls
                            calls: this.extractCalls(node ?? {}, fileContent),
                            parentClass: null, // Calls have no parent class
                        });
                        break;
                }

                // Generic traversal for all child nodes, unless handled specifically above
                if (Array.isArray(node.children)) {
                    node.children.forEach((child: any) => {
                        // Avoid re-traversing bodies already handled by specific cases
                        if (node.kind === 'class' || node.kind === 'interface' || node.kind === 'trait' ||
                            node.kind === 'function' || node.kind === 'method' || node.kind === 'closure' ||
                            node.kind === 'if' || node.kind === 'for' || node.kind === 'foreach' ||
                            node.kind === 'while' || node.kind === 'do' || node.kind === 'switch' || node.kind === 'try') {
                            // If the child is part of a body that was already traversed, skip
                            if (node.body && node.body.children && node.body.children.includes(child)) return;
                            if (node.alternate && node.alternate.children && node.alternate.children.includes(child)) return;
                            if (node.catches && node.catches.some((c:any) => c.body?.children?.includes(child))) return;
                            if (node.finally && node.finally.children && node.finally.children.includes(child)) return;
                        }
                        traverse(child, newCurrentNamespace, newCurrentClassFullName, newCurrentClassName);
                    });
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
