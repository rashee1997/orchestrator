import { BaseLanguageParser } from './ILanguageParser.js';
import { ExtractedImport, ExtractedCodeEntity } from '../services/CodebaseIntrospectionService.js';
import { HTMLParser } from './HTMLParser.js';
import phpParser from 'php-parser';
import path from 'path';

interface TypeInfo {
    name: string;
    nullable: boolean;
    unionTypes?: string[];
    genericTypes?: string[];
    isBuiltin: boolean;
}

interface ParameterInfo {
    name: string;
    type?: TypeInfo;
    optional: boolean;
    defaultValue?: string;
    byReference: boolean;
}

// Helper to downcast enhanced params to the base ExtractedCodeEntity param shape
function toBaseParamShape(p: ParameterInfo): { name: string; type?: string; optional?: boolean; rest?: boolean; defaultValue?: string | null } {
    return {
        name: p.name,
        type: p.type ? p.type.name : undefined,
        optional: p.optional,
        rest: false,
        defaultValue: p.defaultValue ?? null,
    };
}

interface EnhancedCodeEntity extends ExtractedCodeEntity {
    // Keep all base fields structurally compatible. Store richer info in enhanced* fields.
    enhancedTypeInfo?: TypeInfo;
    enhancedParameters?: ParameterInfo[];
    enhancedReturnType?: TypeInfo;
    attributes?: string[];
    visibility?: 'public' | 'private' | 'protected';
    isStatic?: boolean;
    isFinal?: boolean;
    isAbstract?: boolean;
    docBlock?: {
        summary?: string;
        description?: string;
        tags: Array<{
            name: string;
            value: string;
        }>;
    };
}

export class PHPParser extends BaseLanguageParser {
    private parser: phpParser.Engine;
    private htmlParser: HTMLParser;
    private typeCache: Map<string, TypeInfo> = new Map();

    constructor(projectRootPath: string = process.cwd()) {
        super(projectRootPath);
        this.htmlParser = new HTMLParser(projectRootPath);
        this.parser = new phpParser.Engine({
            parser: {
                extractDoc: true,
                php7: true,
                suppressErrors: true,
            },
            ast: {
                withPositions: true,
                withSource: true,
            },
        });
    }

    getSupportedExtensions(): string[] {
        return ['.php', '.phtml', '.php3', '.php4', '.php5', '.php7', '.phps'];
    }

    getLanguageName(): string {
        return 'php';
    }

    private parseDocBlock(docBlock: string): EnhancedCodeEntity['docBlock'] {
        if (!docBlock) return undefined;

        const lines = docBlock.split('\n').map(line => line.trim().replace(/^\/\*\*|\*\/$/g, '').replace(/^\*\s?/, ''));
        const summary = lines.find(line => line && !line.startsWith('@')) || '';
        const descriptionLines = lines.filter(line => line && !line.startsWith('@') && line !== summary);
        const description = descriptionLines.join(' ').trim();

        const tags: Array<{ name: string; value: string }> = [];
        const tagRegex = /@(\w+)\s+(.+)/g;
        let match;
        while ((match = tagRegex.exec(docBlock)) !== null) {
            tags.push({ name: match[1], value: match[2].trim() });
        }

        return { summary, description, tags };
    }

    private parseTypeFromString(typeStr: string): TypeInfo {
        if (!typeStr) return { name: 'mixed', nullable: false, isBuiltin: true };

        const nullable = typeStr.startsWith('?') || typeStr.includes('|null') || typeStr.includes('null|');
        let cleanType = typeStr.replace('?', '').replace('|null', '').replace('null|', '');

        // Handle union types
        const unionTypes = cleanType.includes('|') ? cleanType.split('|').map(t => t.trim()) : undefined;
        
        // Handle generic types
        const genericMatch = cleanType.match(/^(.+)<(.+)>$/);
        let genericTypes: string[] | undefined;
        let baseType = cleanType;
        
        if (genericMatch) {
            baseType = genericMatch[1];
            genericTypes = genericMatch[2].split(',').map(t => t.trim());
        }

        const builtinTypes = ['int', 'float', 'string', 'bool', 'array', 'object', 'callable', 'iterable', 'void', 'mixed', 'never'];
        
        return {
            name: baseType,
            nullable,
            unionTypes,
            genericTypes,
            isBuiltin: builtinTypes.includes(baseType.toLowerCase()),
        };
    }

    private parseTypeFromNode(node: any): TypeInfo | undefined {
        if (!node) return undefined;

        if (node.type) {
            return this.parseTypeFromString(node.type.name || node.type);
        }

        if (node.returnType) {
            return this.parseTypeFromString(node.returnType.name || node.returnType);
        }

        return undefined;
    }

    private extractAttributes(node: any): string[] {
        const attributes: string[] = [];
        
        if (node.attrGroups) {
            node.attrGroups.forEach((group: any) => {
                if (group.attrs) {
                    group.attrs.forEach((attr: any) => {
                        if (attr.name) {
                            attributes.push(attr.name.name || attr.name);
                        }
                    });
                }
            });
        }

        return attributes;
    }

    async parseImports(filePath: string, fileContent: string): Promise<ExtractedImport[]> {
        const imports: ExtractedImport[] = [];
        try {
            const ast = this.parser.parseCode(fileContent, filePath);

            const traverse = (node: any) => {
                if (!node) return;

                if (node.kind === 'namespace') {
                    // Handle namespace declarations as "module" to match ExtractedImport type union
                    imports.push({
                        type: 'module',
                        targetPath: String(node.name ?? ''),
                        originalImportString: `namespace ${String(node.name ?? '')};`,
                        importedSymbols: [String(node.name ?? '')],
                        isDynamicImport: false,
                        isTypeOnlyImport: false,
                        startLine: node.loc.start.line,
                        endLine: node.loc.end.line,
                    });
                }

                if (node.kind === 'usegroup') {
                    const prefix = node.name || '';
                    if (node.items) {
                        node.items.forEach((item: any) => {
                            const fullPath = prefix ? `${prefix}\\${item.name}` : item.name;
                            imports.push({
                                type: 'module',
                                targetPath: fullPath,
                                originalImportString: `use ${fullPath}` + (item.alias ? ` as ${item.alias.name}` : ''),
                                importedSymbols: [item.alias ? item.alias.name : item.name.split('\\').pop()],
                                isDynamicImport: false,
                                isTypeOnlyImport: false,
                                startLine: node.loc.start.line,
                                endLine: node.loc.end.line,
                            });
                        });
                    }
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
                } else if (node.kind === 'include' || node.kind === 'require' || 
                           node.kind === 'include_once' || node.kind === 'require_once') {
                    if (node.target && node.target.kind === 'string') {
                        const targetValue = (node.target.value ?? '') as string;
                        const targetPath = path.resolve(path.dirname(filePath), targetValue);
                        imports.push({
                            type: 'file',
                            targetPath: targetPath,
                            originalImportString: `${node.kind} '${targetValue}';`,
                            isDynamicImport: true,
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

    private formatEnhancedSignature(node: any, fileContent: string): string {
        if (!node.loc) return node.name?.name || '';

        const source = node.loc.source;
        if (!source) return node.name?.name || '';

        try {
            if ((node.kind === 'function' || node.kind === 'method' || node.kind === 'closure') && node.body) {
                const end = node.body.loc.start.offset;
                return fileContent.substring(node.loc.start.offset, end).replace(/{\s*$/, '').trim();
            }

            if ((node.kind === 'class' || node.kind === 'interface' || node.kind === 'trait') && node.body) {
                const end = node.body.loc.start.offset;
                return fileContent.substring(node.loc.start.offset, end).replace(/{\s*$/, '').trim();
            }

            return source.trim();
        } catch (error) {
            return node.name?.name || '';
        }
    }

    private extractMethodCalls(node: any, fileContent: string): Array<{
        name: string;
        type: 'function' | 'method' | 'unknown';
    }> {
        const calls: Array<{
            name: string;
            type: 'function' | 'method' | 'unknown';
        }> = [];

        const traverse = (currentNode: any) => {
            if (!currentNode) return;

            if (currentNode.kind === 'call' && currentNode.what) {
                let callName: string = '';
                let callType: 'function' | 'method' | 'unknown' = 'unknown';
                // const args: string[] = [];

                if (currentNode.arguments) {
                    // We ignore arguments for the base 'calls' shape to match ExtractedCodeEntity
                    currentNode.arguments.forEach((_arg: any) => { /* noop */ });
                }

                if (currentNode.what.kind === 'name') {
                    callName = currentNode.what.name;
                    callType = 'function';
                } else if (currentNode.what.kind === 'staticlookup' && 
                          currentNode.what.what && 
                          currentNode.what.offset && 
                          currentNode.what.offset.kind === 'constref') {
                    const className = currentNode.what.what.name || '';
                    const methodName = currentNode.what.offset.name || '';
                    callName = `${className}::${methodName}`;
                    // Treat static lookups as 'method' for the base union type
                    callType = 'method';
                } else if (currentNode.what.kind === 'propertylookup' && 
                          currentNode.what.offset && 
                          currentNode.what.offset.kind === 'constref') {
                    const methodName = currentNode.what.offset.name || '';
                    callName = `->${methodName}`;
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

        try {
            const ast = this.parser.parseCode(fileContent, filePath);
            let currentNamespace = '';
            let currentClass: string | null = null;
            let currentClassFullName: string | null = null;

            const traverse = (node: any): void => {
                if (!node || !node.kind) return;

                const baseEntity: Partial<ExtractedCodeEntity> & {
                    startLine: number;
                    endLine: number;
                    filePath: string;
                    containingDirectory: string;
                    signature?: string;
                    docstring?: string | null;
                } = {
                    startLine: node.loc?.start?.line || 0,
                    endLine: node.loc?.end?.line || 0,
                    filePath: absoluteFilePath,
                    containingDirectory: containingDirectory,
                    signature: this.formatEnhancedSignature(node, fileContent),
                    docstring: Array.isArray(node.leadingComments) ? 
                        node.leadingComments.map((c: any) => c.value).join('\n') : null,
                    // Store docBlock only in enhanced metadata if needed; keep base entity compatible
                    // @ts-expect-error - docBlock is not part of ExtractedCodeEntity; preserved separately when needed
                    docBlock: node.leadingComments ? 
                        this.parseDocBlock(node.leadingComments.map((c: any) => c.value).join('\n')) : undefined,
                };

                if (node.kind === 'namespace') {
                    currentNamespace = node.name || '';
                    if (Array.isArray(node.children)) {
                        node.children.forEach(traverse);
                    }
                    return;
                }

                const getFullName = (name: string | null | undefined, parentName?: string | null): string => {
                    const safeName = name ?? '';
                    let fullName = currentNamespace ? `${currentNamespace}\\` : '';
                    if (parentName) fullName += `${parentName}::`;
                    return fullName + safeName;
                };

                switch (node.kind) {
                    case 'class':
                    case 'interface':
                    case 'trait':
                        currentClass = node.name?.name || '';
                        currentClassFullName = getFullName(currentClass);
                        
                        entities.push({
                            ...baseEntity,
                            type: (node.kind as ExtractedCodeEntity['type']),
                            name: currentClass || '',
                            fullName: currentClassFullName || '',
                            isExported: true,
                            parentClass: node.extends?.name || '',
                            implementedInterfaces: (node.implements || []).map((i: any) => i.name),
                            // Enhanced-only info retained on the object under non-conflicting keys
                            // @ts-ignore
                            attributes: this.extractAttributes(node),
                            // @ts-ignore
                            isFinal: node.isFinal || false,
                            // @ts-ignore
                            isAbstract: node.isAbstract || false,
                        } as ExtractedCodeEntity);

                        if (Array.isArray(node.body)) {
                            node.body.forEach(traverse);
                        }
                        break;

                    case 'function':
                    case 'closure':
                        const functionName = node.name?.name || `closure_${node.loc?.start?.line || 0}`;
                        const functionParamsEnhanced = (node.arguments || []).map((p: any) => ({
                            name: p.name?.name || '',
                            type: this.parseTypeFromNode(p),
                            optional: !!p.value,
                            defaultValue: p.value ? fileContent.substring(p.value.loc?.start?.offset || 0, p.value.loc?.end?.offset || 0) : undefined,
                            byReference: p.byref || false,
                        } as ParameterInfo));
                        const functionParamsBase = functionParamsEnhanced.map(toBaseParamShape);

                        entities.push({
                            ...baseEntity,
                            type: 'function',
                            name: functionName,
                            fullName: getFullName(functionName || ''),
                            isExported: true,
                            isAsync: false,
                            parameters: functionParamsBase,
                            returnType: this.parseTypeFromNode(node)?.name ?? null,
                            calls: this.extractMethodCalls(node.body || {}, fileContent),
                            // @ts-ignore
                            enhancedParameters: functionParamsEnhanced,
                            // @ts-ignore
                            enhancedReturnType: this.parseTypeFromNode(node),
                            parentClass: null,
                            attributes: this.extractAttributes(node),
                        });

                        if (Array.isArray(node.body?.children)) {
                            node.body.children.forEach(traverse);
                        }
                        break;

                    case 'method':
                        const methodName = (node.name?.name as string) || ''
                        const methodParamsEnhanced = (node.arguments || []).map((p: any) => ({
                            name: p.name?.name || '',
                            type: this.parseTypeFromNode(p),
                            optional: !!p.value,
                            defaultValue: p.value ? fileContent.substring(p.value.loc?.start?.offset || 0, p.value.loc?.end?.offset || 0) : undefined,
                            byReference: p.byref || false,
                        } as ParameterInfo));
                        const methodParamsBase = methodParamsEnhanced.map(toBaseParamShape);

                        let accessibility: 'public' | 'private' | 'protected' = 'public';
                        if (node.isPrivate) accessibility = 'private';
                        else if (node.isProtected) accessibility = 'protected';

                        entities.push({
                            ...baseEntity,
                            type: 'method',
                            name: methodName,
                            fullName: `${currentClassFullName || ''}::${methodName || ''}`,
                            parentClass: currentClass || '',
                            isExported: node.isPublic || false,
                            isAsync: false,
                            parameters: methodParamsBase,
                            returnType: this.parseTypeFromNode(node)?.name ?? null,
                            calls: this.extractMethodCalls(node.body || {}, fileContent),
                            accessibility,
                            // Enhanced-only fields preserved under non-conflicting keys
                            // @ts-ignore
                            isStatic: node.isStatic || false,
                            // @ts-ignore
                            isFinal: node.isFinal || false,
                            // @ts-ignore
                            isAbstract: node.isAbstract || false,
                            // @ts-ignore
                            attributes: this.extractAttributes(node),
                        });

                        if (Array.isArray(node.body?.children)) {
                            node.body.children.forEach(traverse);
                        }
                        break;

                    case 'property':
                        const propertyName = node.name?.name || '';
                        let propertyAccessibility: 'public' | 'private' | 'protected' = 'public';
                        if (node.isPrivate) propertyAccessibility = 'private';
                        else if (node.isProtected) propertyAccessibility = 'protected';

                        entities.push({
                            ...baseEntity,
                            type: 'property',
                            name: propertyName,
                            fullName: `${currentClassFullName || ''}::${propertyName}`,
                            parentClass: currentClass || '',
                            isExported: node.isPublic || false,
                            accessibility: propertyAccessibility,
                            // Enhanced-only flag; not part of ExtractedCodeEntity
                            // @ts-ignore
                            isStatic: node.isStatic || false,
                            // 'type' is already used for entity kind; do not override with TypeInfo
                            // Preserve enhanced info separately
                            // @ts-ignore
                            enhancedTypeInfo: this.parseTypeFromNode(node),
                            // @ts-ignore
                            attributes: this.extractAttributes(node),
                        });
                        break;

                    case 'constant':
                        const constantName = node.name?.name || '';
                        entities.push({
                            ...baseEntity,
                            type: 'variable',
                            name: constantName,
                            fullName: getFullName(constantName),
                            parentClass: currentClass,
                            isExported: true,
                            // Place enhanced type info under a non-conflicting key
                            // @ts-ignore
                            enhancedTypeInfo: this.parseTypeFromNode(node),
                            // @ts-ignore
                            attributes: this.extractAttributes(node),
                        });
                        break;
                }

                // Generic traversal
                if (Array.isArray(node.children)) {
                    node.children.forEach(traverse);
                }
                if (Array.isArray(node.body)) {
                    node.body.forEach(traverse);
                }
            };

            traverse(ast);
        } catch (error) {
            console.warn(`PHP parsing failed for ${filePath}, attempting HTML parsing:`, error);
        }

        // Parse inline HTML
        try {
            const htmlEntities = await this.htmlParser.parseCodeEntities(filePath, fileContent, projectRootPath);
            entities.push(...htmlEntities);
        } catch (error) {
            console.error(`Error parsing inline HTML in ${filePath}:`, error);
        }

        return entities;
    }
}
