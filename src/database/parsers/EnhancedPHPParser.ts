import { BaseLanguageParser } from './ILanguageParser.js';
import { ExtractedImport, ExtractedCodeEntity } from '../services/CodebaseIntrospectionService.js';
import { HTMLParser } from './HTMLParser.js';
import phpParser from 'php-parser';
import path from 'path';

// Enhanced type system for PHP 8+
interface EnhancedTypeInfo {
    name: string;
    nullable: boolean;
    unionTypes?: string[];
    intersectionTypes?: string[];
    genericTypes?: string[];
    isBuiltin: boolean;
    isNullable: boolean;
    isUnion: boolean;
    isIntersection: boolean;
    isGeneric: boolean;
}

interface EnhancedParameterInfo {
    name: string;
    type?: EnhancedTypeInfo;
    optional: boolean;
    defaultValue?: string;
    byReference: boolean;
    isVariadic: boolean;
    promotedProperty?: {
        visibility: 'public' | 'private' | 'protected';
        isReadonly: boolean;
    };
}

interface EnhancedReturnType {
    type: EnhancedTypeInfo;
    isVoid: boolean;
    isNever: boolean;
    isMixed: boolean;
}

interface EnhancedCodeEntity extends ExtractedCodeEntity {
    // Enhanced metadata
    enhancedTypeInfo?: EnhancedTypeInfo;
    enhancedParameters?: EnhancedParameterInfo[];
    enhancedReturnType?: EnhancedReturnType;
    attributes?: string[];
    visibility?: 'public' | 'private' | 'protected';
    isStatic?: boolean;
    isFinal?: boolean;
    isAbstract?: boolean;
    isReadonly?: boolean;
    isEnum?: boolean;
    isBackedEnum?: boolean;
    enumType?: string;
    enumCases?: Array<{
        name: string;
        value?: string | number;
    }>;
    traits?: string[];
    interfaces?: string[];
    docBlock?: {
        summary?: string;
        description?: string;
        tags: Array<{
            name: string;
            value: string;
            description?: string;
        }>;
        params?: Array<{
            name: string;
            type?: string;
            description?: string;
        }>;
        return?: {
            type?: string;
            description?: string;
        };
    };
    namespace?: string;
    fullyQualifiedName?: string;
    fileNamespace?: string;
}

// Advanced namespace resolution system
class AdvancedNamespaceResolver {
    private namespace = '';
    private uses: Map<string, string> = new Map();
    private groupUses: Map<string, Map<'class' | 'function' | 'const', Map<string, string>>> = new Map();
    private aliases: Map<string, string> = new Map();
    private functionUses: Map<string, string> = new Map();
    private constantUses: Map<string, string> = new Map();

    setNamespace(namespace: string): void {
        this.namespace = namespace;
    }

    addUse(fullPath: string, alias?: string, type: 'class' | 'function' | 'const' = 'class'): void {
        const key = alias || fullPath.split('\\').pop() || fullPath;

        switch (type) {
            case 'function':
                this.functionUses.set(key, fullPath);
                break;
            case 'const':
                this.constantUses.set(key, fullPath);
                break;
            default:
                this.uses.set(key, fullPath);
                break;
        }
    }

    addGroupUse(prefix: string, items: Array<{ name: string; alias?: string }>, type: 'class' | 'function' | 'const' = 'class'): void {
        if (!this.groupUses.has(prefix)) {
            this.groupUses.set(prefix, new Map([
                ['class', new Map()],
                ['function', new Map()],
                ['const', new Map()]
            ]));
        }

        const typeMaps = this.groupUses.get(prefix)!;
        const targetMap = typeMaps.get(type)!;

        items.forEach(item => {
            const key = item.alias || item.name;
            const fullPath = `${prefix}\\${item.name}`;
            targetMap.set(key, fullPath);
        });
    }

    resolve(name: string, type: 'class' | 'function' | 'const' = 'class'): string {
        if (name.startsWith('\\')) {
            return name.substring(1);
        }

        let resolved: string | undefined;

        switch (type) {
            case 'function':
                resolved = this.functionUses.get(name);
                if (!resolved) {
                    for (const [prefix, typeMaps] of this.groupUses) {
                        const functionMap = typeMaps.get('function');
                        if (functionMap && functionMap.has(name)) {
                            resolved = functionMap.get(name);
                            break;
                        }
                    }
                }
                break;
            case 'const':
                resolved = this.constantUses.get(name);
                if (!resolved) {
                    for (const [prefix, typeMaps] of this.groupUses) {
                        const constMap = typeMaps.get('const');
                        if (constMap && constMap.has(name)) {
                            resolved = constMap.get(name);
                            break;
                        }
                    }
                }
                break;
            default: // 'class'
                resolved = this.uses.get(name);
                if (!resolved) {
                    for (const [prefix, typeMaps] of this.groupUses) {
                        const classMap = typeMaps.get('class');
                        if (classMap && classMap.has(name)) {
                            resolved = classMap.get(name);
                            break;
                        }
                    }
                }
                break;
        }

        if (resolved) {
            return resolved;
        }

        if (this.namespace) {
            return `${this.namespace}\\${name}`;
        }

        return name;
    }

    getCurrentNamespace(): string {
        return this.namespace;
    }

    getFullyQualifiedName(name: string, type: 'class' | 'function' | 'const' = 'class'): string {
        return this.resolve(name, type);
    }
}

// Enhanced PHP parser with PHP 8+ support
export class EnhancedPHPParser extends BaseLanguageParser {
    private parser: phpParser.Engine;
private getIdentifierName(node: any): string {
        return node?.name?.name || node?.name || '';
    }
    private htmlParser: HTMLParser;
    private typeCache: Map<string, EnhancedTypeInfo> = new Map();
    private namespaceResolver: AdvancedNamespaceResolver;

    constructor(projectRootPath: string = process.cwd()) {
        super(projectRootPath);
        this.htmlParser = new HTMLParser(projectRootPath);
        this.namespaceResolver = new AdvancedNamespaceResolver();

        // Enhanced parser configuration for PHP 8+
        this.parser = new phpParser.Engine({
            parser: {
                extractDoc: true,
                php7: true,
                php8: true,
                suppressErrors: false,
                debug: false,
            },
            ast: {
                withPositions: true,
                withSource: true,
            },
            lexer: {
                short_tags: true,
                asp_tags: false,
                comments: true,
                doc_comments: true,
            },
        });
    }

    getSupportedExtensions(): string[] {
        return ['.php', '.phtml', '.php3', '.php4', '.php5', '.php7', '.phps', '.php8'];
    }

    getLanguageName(): string {
        return 'php';
    }

    // Enhanced DocBlock parsing with full tag support
    private parseDocBlock(docBlock: string): EnhancedCodeEntity['docBlock'] {
        if (!docBlock) return undefined;

        const cleanDocBlock = docBlock
            .replace(/^\/\*\*|\*\/$/g, '')
            .replace(/^\*\s?/gm, '')
            .trim();

        const lines = cleanDocBlock.split('\n').map(line => line.trim());

        // Extract summary and description
        let summary = '';
        let description = '';
        let inDescription = false;

        for (const line of lines) {
            if (line.startsWith('@')) {
                break;
            }

            if (!summary && line) {
                summary = line;
            } else if (summary && line) {
                description += (description ? ' ' : '') + line;
                inDescription = true;
            }
        }

        // Parse tags
        const tags: Array<{
            name: string;
            value: string;
            description?: string;
        }> = [];

        const paramTags: Array<{
            name: string;
            type?: string;
            description?: string;
        }> = [];

        let returnTag: {
            type?: string;
            description?: string;
        } = {};

        const tagRegex = /@(\w+)\s+(.+?)(?=@|$)/gs;
        let match;

        while ((match = tagRegex.exec(cleanDocBlock)) !== null) {
            const tagName = match[1];
            const tagValue = match[2].trim();

            tags.push({
                name: tagName,
                value: tagValue,
            });

            // Parse specific tags
            if (tagName === 'param') {
                const paramMatch = tagValue.match(/^(?:(\S+)\s+)?\$(\w+)(?:\s+(.+))?$/);
                if (paramMatch) {
                    paramTags.push({
                        type: paramMatch[1],
                        name: paramMatch[2],
                        description: paramMatch[3],
                    });
                }
            } else if (tagName === 'return') {
                const returnMatch = tagValue.match(/^(\S+)(?:\s+(.+))?$/);
                if (returnMatch) {
                    returnTag = {
                        type: returnMatch[1],
                        description: returnMatch[2],
                    };
                }
            }
        }

        return {
            summary,
            description,
            tags,
            params: paramTags,
            return: returnTag,
        };
    }

    // Enhanced type parsing for PHP 8+
    private parseTypeFromString(typeStr: string): EnhancedTypeInfo {
        if (!typeStr || typeStr === 'mixed') {
            return {
                name: 'mixed',
                nullable: false,
                isBuiltin: true,
                isNullable: false,
                isUnion: false,
                isIntersection: false,
                isGeneric: false,
            };
        }

        const originalTypeStr = typeStr;
        let nullable = false;
        let isUnion = false;
        let isIntersection = false;
        let genericTypes: string[] | undefined;

        // Handle nullable types
        if (typeStr.startsWith('?')) {
            nullable = true;
            typeStr = typeStr.substring(1);
        }

        // Handle union types (PHP 8.0+)
        if (typeStr.includes('|')) {
            isUnion = true;
            const unionTypes = typeStr.split('|').map(t => t.trim());
            const filteredTypes = unionTypes.filter(t => t !== 'null');

            if (unionTypes.includes('null')) {
                nullable = true;
            }

            return {
                name: filteredTypes.join('|'),
                nullable,
                unionTypes: filteredTypes,
                isBuiltin: this.isBuiltinType(filteredTypes[0]),
                isNullable: nullable,
                isUnion: true,
                isIntersection: false,
                isGeneric: false,
            };
        }

        // Handle intersection types (PHP 8.1+)
        if (typeStr.includes('&')) {
            isIntersection = true;
            const intersectionTypes = typeStr.split('&').map(t => t.trim());

            return {
                name: intersectionTypes.join('&'),
                nullable,
                intersectionTypes,
                isBuiltin: this.isBuiltinType(intersectionTypes[0]),
                isNullable: nullable,
                isUnion: false,
                isIntersection: true,
                isGeneric: false,
            };
        }

        // Handle generic types
        const genericMatch = typeStr.match(/^(.+)<(.+)>$/);
        if (genericMatch) {
            const baseType = genericMatch[1];
            genericTypes = genericMatch[2].split(',').map(t => t.trim());

            return {
                name: baseType,
                nullable,
                genericTypes,
                isBuiltin: this.isBuiltinType(baseType),
                isNullable: nullable,
                isUnion: false,
                isIntersection: false,
                isGeneric: true,
            };
        }

        const builtinTypes = [
            'int', 'float', 'string', 'bool', 'array', 'object', 'callable',
            'iterable', 'void', 'never', 'mixed', 'null', 'false', 'true',
            'self', 'parent', 'static'
        ];

        return {
            name: typeStr,
            nullable,
            isBuiltin: builtinTypes.includes(typeStr.toLowerCase()),
            isNullable: nullable,
            isUnion: false,
            isIntersection: false,
            isGeneric: false,
        };
    }

    private isBuiltinType(type: string): boolean {
        const builtinTypes = [
            'int', 'float', 'string', 'bool', 'array', 'object', 'callable',
            'iterable', 'void', 'never', 'mixed', 'null', 'false', 'true',
            'self', 'parent', 'static'
        ];
        return builtinTypes.includes(type.toLowerCase());
    }

    // Parse type from AST node
    private parseTypeFromNode(node: any): EnhancedTypeInfo | undefined {
        if (!node) return undefined;

        // Handle return type
        if (node.type) {
            return this.parseTypeFromString(node.type.name || String(node.type));
        }

        // Handle union types
        if (node.unionTypes) {
            const typeStrings = node.unionTypes.map((t: any) => t.name || String(t));
            return this.parseTypeFromString(typeStrings.join('|'));
        }

        // Handle nullable types
        if (node.nullable && node.type) {
            const type = this.parseTypeFromString(String(node.type));
            type.nullable = true;
            return type;
        }

        return undefined;
    }

    // Enhanced attribute extraction for PHP 8+
    private extractAttributes(node: any): string[] {
        const attributes: string[] = [];

        if (node.attrGroups) {
            node.attrGroups.forEach((group: any) => {
                if (group.attrs) {
                    group.attrs.forEach((attr: any) => {
                        let attrName = '';

                        if (attr.name) {
                            if (typeof attr.name === 'string') {
                                attrName = attr.name;
                            } else if (attr.name.name) {
                                attrName = attr.name.name;
                            } else if (attr.name.resolution) {
                                attrName = String(attr.name.resolution);
                            }
                        }

                        if (attrName) {
                            // Include attribute arguments if present
                            if (attr.args && attr.args.length > 0) {
                                const args = attr.args.map((arg: any) => {
                                    if (arg.value && arg.value.kind === 'string') {
                                        return `"${arg.value.value}"`;
                                    }
                                    return String(arg.value || arg);
                                });
                                attrName += `(${args.join(', ')})`;
                            }
                            attributes.push(attrName);
                        }
                    });
                }
            });
        }

        return attributes;
    }

    // Enhanced import parsing with namespace support
    async parseImports(filePath: string, fileContent: string): Promise<ExtractedImport[]> {
        const imports: ExtractedImport[] = [];

        try {
            const ast = this.parser.parseCode(fileContent, filePath);

            const traverse = (node: any) => {
                if (!node) return;

                // Namespace declarations
                if (node.kind === 'namespace') {
                    const namespaceName = node.name?.name || '';
                    imports.push({
                        type: 'module',
                        targetPath: namespaceName,
                        originalImportString: `namespace ${namespaceName};`,
                        importedSymbols: [namespaceName],
                        isDynamicImport: false,
                        isTypeOnlyImport: false,
                        startLine: node.loc?.start?.line || 0,
                        endLine: node.loc?.end?.line || 0,
                    });

                    if (node.children) {
                        node.children.forEach(traverse);
                    }
                }

                // Use statements
                if (node.kind === 'usegroup') {
                    const prefix = node.name?.name || '';

                    if (node.items) {
                        node.items.forEach((item: any) => {
                            const fullPath = prefix ? `${prefix}\\${this.getIdentifierName(item.name)}` : this.getIdentifierName(item.name);
                            const alias = this.getIdentifierName(item.alias) || this.getIdentifierName(item.name).split('\\').pop();

                            imports.push({
                                type: 'module',
                                targetPath: fullPath,
                                originalImportString: `use ${fullPath}` + (item.alias ? ` as ${item.alias.name}` : ''),
                                importedSymbols: [alias || item.name],
                                isDynamicImport: false,
                                isTypeOnlyImport: false,
                                startLine: node.loc?.start?.line || 0,
                                endLine: node.loc?.end?.line || 0,
                            });
                        });
                    }
                }

                // Individual use items
                if (node.kind === 'useitem') {
                    const useType = node.type || 'class';
                    const fullPath = node.name;
                    const alias = node.alias?.name || node.name.split('\\').pop();

                    imports.push({
                        type: 'module',
                        targetPath: fullPath,
                        originalImportString: `use ${useType} ${fullPath}` + (node.alias ? ` as ${node.alias.name}` : ''),
                        importedSymbols: [alias || node.name],
                        isDynamicImport: false,
                        isTypeOnlyImport: false,
                        startLine: node.loc?.start?.line || 0,
                        endLine: node.loc?.end?.line || 0,
                    });
                }

                // Include/require statements
                if (['include', 'require', 'include_once', 'require_once'].includes(node.kind)) {
                    if (node.target && node.target.kind === 'string') {
                        const targetValue = node.target.value as string;
                        const targetPath = path.resolve(path.dirname(filePath), targetValue);

                        imports.push({
                            type: 'file',
                            targetPath: targetPath,
                            originalImportString: `${node.kind} '${targetValue}';`,
                            isDynamicImport: true,
                            isTypeOnlyImport: false,
                            startLine: node.loc?.start?.line || 0,
                            endLine: node.loc?.end?.line || 0,
                        });
                    }
                }

                // Recursive traversal
                if (Array.isArray(node.children)) {
                    node.children.forEach(traverse);
                }
                if (Array.isArray(node.body)) {
                    node.body.forEach(traverse);
                }
            };

            ast.children.forEach(traverse);
        } catch (error) {
            console.error(`Error parsing PHP imports in ${filePath}:`, error);
        }

        return imports;
    }

    // Enhanced signature formatting
    private formatEnhancedSignature(node: any, fileContent: string): string {
        if (!node.loc) return node.name?.name || '';

        try {
            const start = node.loc.start.offset;
            let end = node.loc.end.offset;

            // Find the opening brace for classes/functions
            if ((node.kind === 'class' || node.kind === 'interface' || node.kind === 'trait' ||
                node.kind === 'enum' || node.kind === 'function' || node.kind === 'method') && node.body) {
                end = node.body.loc.start.offset;
            }

            // Handle constructor property promotion
            if (node.kind === 'method' && node.name?.name === '__construct') {
                const signature = fileContent.substring(start, end);
                return signature.replace(/\s*{.*$/, '').trim();
            }

            return fileContent.substring(start, end).replace(/\s*{.*$/, '').trim();
        } catch (error) {
            return node.name?.name || '';
        }
    }

    // Enhanced method call extraction
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

            // Function calls
            if (currentNode.kind === 'call' && currentNode.what) {
                let callName = '';
                let callType: 'function' | 'method' | 'unknown' = 'unknown';

                if (currentNode.what.kind === 'name') {
                    callName = currentNode.what.name;
                    callType = 'function';
                } else if (currentNode.what.kind === 'variable') {
                    callName = currentNode.what.name;
                    callType = 'function';
                } else if (currentNode.what.kind === 'staticlookup') {
                    // Static method calls: Class::method()
                    const className = this.extractName(currentNode.what.what);
                    const methodName = this.extractName(currentNode.what.offset);
                    callName = `${className}::${methodName}`;
                    callType = 'method';
                } else if (currentNode.what.kind === 'propertylookup') {
                    // Instance method calls: $object->method()
                    const objectName = this.extractName(currentNode.what.what);
                    const methodName = this.extractName(currentNode.what.offset);
                    callName = `${objectName}->${methodName}`;
                    callType = 'method';
                } else if (currentNode.what.kind === 'offsetlookup') {
                    // Array access calls
                    callName = this.extractName(currentNode.what.what);
                    callType = 'unknown';
                }

                if (callName) {
                    calls.push({ name: callName, type: callType });
                }
            }

            // New expressions
            if (currentNode.kind === 'new' && currentNode.what) {
                const className = this.extractName(currentNode.what);
                if (className) {
                    calls.push({ name: className, type: 'unknown' });
                }
            }

            // Recursive traversal
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

    private extractName(node: any): string {
        if (!node) return '';

        if (typeof node === 'string') return node;
        if (node.name) return node.name;
        if (node.value) return String(node.value);

        return '';
    }

    // Enhanced code entity parsing with PHP 8+ support
    async parseCodeEntities(filePath: string, fileContent: string, projectRootPath: string): Promise<EnhancedCodeEntity[]> {
        const entities: EnhancedCodeEntity[] = [];
        const absoluteFilePath = path.resolve(filePath).replace(/\\/g, '/');
        const relativeFilePath = path.relative(projectRootPath, absoluteFilePath).replace(/\\/g, '/');
        const containingDirectory = path.dirname(relativeFilePath).replace(/\\/g, '/');

        try {
            const ast = this.parser.parseCode(fileContent, filePath);
            this.namespaceResolver = new AdvancedNamespaceResolver();

            // Pre-scan for namespace and use statements
            const preScan = (node: any) => {
                if (!node) return;

                if (node.kind === 'namespace') {
                    this.namespaceResolver.setNamespace(node.name?.name || '');
                    if (node.children) node.children.forEach(preScan);
                } else if (node.kind === 'usegroup') {
                    const prefix = node.name?.name || '';
                    node.items.forEach((item: any) => {
                        const fullPath = prefix ? `${prefix}\\${item.name}` : item.name;
                        this.namespaceResolver.addUse(fullPath, item.alias?.name);
                    });
                } else if (node.kind === 'useitem') {
                    const useType = node.type || 'class';
                    this.namespaceResolver.addUse(node.name, node.alias?.name, useType);
                } else if (Array.isArray(node.children)) {
                    node.children.forEach(preScan);
                }
            };

            preScan(ast);

            let currentNamespace = '';
            let currentClass: string | null = null;
            let currentClassFullName: string | null = null;

            const getFullyQualifiedName = (name: string, type: 'class' | 'function' | 'const' = 'class'): string => {
                return this.namespaceResolver.getFullyQualifiedName(name, type);
            };

            const traverse = (node: any, parentContext: any = {}): void => {
                if (!node || !node.kind) return;

            const baseEntity: EnhancedCodeEntity = {
                startLine: node.loc?.start?.line || 0,
                endLine: node.loc?.end?.line || 0,
                filePath: absoluteFilePath,
                containingDirectory: containingDirectory,
                signature: this.formatEnhancedSignature(node, fileContent),
                docstring: this.extractDocstring(fileContent, node.loc?.start?.offset || 0) || undefined,
                namespace: this.namespaceResolver.getCurrentNamespace(),
                fullyQualifiedName: '',
                type: 'function' as EnhancedCodeEntity['type'], // Will be overridden by specific entity types
                name: '',
                fullName: '',
                isExported: false
            };

                // Enhanced docBlock parsing
                if (node.leadingComments && node.leadingComments.length > 0) {
                    const docBlock = node.leadingComments
                        .filter((c: any) => c.kind === 'commentblock')
                        .map((c: any) => c.value)
                        .join('\n');

                    if (docBlock) {
                        baseEntity.docBlock = this.parseDocBlock(docBlock);
                    }
                }

                switch (node.kind) {
                    case 'namespace':
                        currentNamespace = node.name?.name || '';
                        if (Array.isArray(node.children)) {
                            node.children.forEach((child: any) => traverse(child, { ...parentContext, namespace: currentNamespace }));
                        }
                        break;

                    case 'class':
                    case 'interface':
                    case 'trait':
                        currentClass = node.name?.name ?? '';
                        currentClassFullName = getFullyQualifiedName(currentClass ?? '');

                        const classEntity: EnhancedCodeEntity = {
                            ...baseEntity,
                            type: (node.kind as EnhancedCodeEntity['type']),
                            name: currentClass || '',
                            fullName: currentClassFullName || '',
                            isExported: true,
                            parentClass: node.extends ? getFullyQualifiedName(node.extends.name) : undefined,
                            implementedInterfaces: (node.implements || []).map((i: any) => getFullyQualifiedName(i.name)),
                            attributes: this.extractAttributes(node),
                            isFinal: node.isFinal || false,
                            isAbstract: node.isAbstract || false,
                            isReadonly: node.isReadonly || false,
                        };

                        entities.push(classEntity);

                        // Process class body
                        if (Array.isArray(node.body)) {
                            node.body.forEach((child: any) => traverse(child, { ...parentContext, className: currentClass, classFullName: currentClassFullName }));
                        }
                        break;

                    case 'enum':
                        const enumName = node.name?.name || '';
                        const enumFullName = getFullyQualifiedName(enumName);

                        const enumEntity: EnhancedCodeEntity = {
                            ...baseEntity,
                            type: 'class', // Map enum to class for compatibility
                            name: enumName,
                            fullName: enumFullName,
                            isExported: true,
                            isEnum: true,
                            isBackedEnum: node.type !== null,
                            enumType: node.type?.name || undefined,
                            enumCases: (node.body || [])
                                .filter((item: any) => item.kind === 'enumcase')
                                .map((caseNode: any) => ({
                                    name: caseNode.name?.name || '',
                                    value: caseNode.value ? this.extractValue(caseNode.value) : undefined,
                                })),
                        };

                        entities.push(enumEntity);
                        break;

                    case 'function':
                    case 'closure':
                        const functionName = node.name?.name || `closure_${node.loc?.start?.line || 0}`;
                        const functionFullName = getFullyQualifiedName(functionName, 'function');

                        const functionParams = (node.arguments || []).map((p: any) => {
                            const param: EnhancedParameterInfo = {
                                name: p.name?.name || '',
                                type: p.type ? this.parseTypeFromString(p.type.name) : undefined,
                                optional: !!p.value,
                                defaultValue: p.value ? this.extractValue(p.value) : undefined,
                                byReference: p.byref || false,
                                isVariadic: p.variadic || false,
                            };

                            // Handle constructor property promotion
                            if (p.visibility) {
                                param.promotedProperty = {
                                    visibility: p.visibility,
                                    isReadonly: p.readonly || false,
                                };
                            }

                            return param;
                        });

                        const functionEntity: EnhancedCodeEntity = {
                            ...baseEntity,
                            type: 'function',
                            name: functionName,
                            fullName: functionFullName,
                            isExported: true,
                            isAsync: false,
                            parameters: functionParams.map((p: EnhancedParameterInfo) => ({
                                name: p.name,
                                type: p.type?.name,
                                optional: p.optional,
                                rest: p.isVariadic,
                                defaultValue: p.defaultValue || null,
                            })),
                            returnType: this.parseReturnType(node),
                            calls: this.extractMethodCalls(node.body || {}, fileContent),
                            enhancedParameters: functionParams,
                            enhancedReturnType: {
                                type: this.parseTypeFromString(this.parseReturnType(node) || 'mixed'),
                                isVoid: this.parseReturnType(node) === 'void',
                                isNever: this.parseReturnType(node) === 'never',
                                isMixed: this.parseReturnType(node) === 'mixed',
                            },
                        };

                        entities.push(functionEntity);
                        break;

                    case 'method':
                        const methodName = node.name?.name || '';
                            const methodFullName = `${currentClassFullName || ''}::${methodName || ''}`;

                        const methodParams = (node.arguments || []).map((p: any) => {
                            const param: EnhancedParameterInfo = {
                                name: p.name?.name || '',
                                type: p.type ? this.parseTypeFromString(p.type.name) : undefined,
                                optional: !!p.value,
                                defaultValue: p.value ? this.extractValue(p.value) : undefined,
                                byReference: p.byref || false,
                                isVariadic: p.variadic || false,
                            };

                            if (p.visibility) {
                                param.promotedProperty = {
                                    visibility: p.visibility,
                                    isReadonly: p.readonly || false,
                                };
                            }

                            return param;
                        });

                        let accessibility: 'public' | 'private' | 'protected' = 'public';
                        if (node.isPrivate) accessibility = 'private';
                        else if (node.isProtected) accessibility = 'protected';

                        const methodEntity: EnhancedCodeEntity = {
                            ...baseEntity,
                            type: 'method',
                            name: methodName,
                            fullName: methodFullName,
                            parentClass: parentContext.className || '',
                            isExported: node.isPublic || false,
                            isAsync: false,
                            parameters: methodParams.map((p: EnhancedParameterInfo) => ({
                                name: p.name,
                                type: p.type?.name,
                                optional: p.optional,
                                rest: p.isVariadic,
                                defaultValue: p.defaultValue || null,
                            })),
                            returnType: this.parseReturnType(node),
                            calls: this.extractMethodCalls(node.body || {}, fileContent),
                            accessibility,
                            isStatic: node.isStatic || false,
                            isFinal: node.isFinal || false,
                            isAbstract: node.isAbstract || false,
                            enhancedParameters: methodParams,
                            enhancedReturnType: {
                                type: this.parseTypeFromString(this.parseReturnType(node) || 'mixed'),
                                isVoid: this.parseReturnType(node) === 'void',
                                isNever: this.parseReturnType(node) === 'never',
                                isMixed: this.parseReturnType(node) === 'mixed',
                            },
                        };

                        entities.push(methodEntity);
                        break;

                    case 'property':
                        const propertyName = node.name?.name || '';
                        const propertyFullName = `${currentClassFullName || ''}::${propertyName || ''}`;

                        let propertyAccessibility: 'public' | 'private' | 'protected' = 'public';
                        if (node.isPrivate) propertyAccessibility = 'private';
                        else if (node.isProtected) propertyAccessibility = 'protected';

                        const propertyEntity: EnhancedCodeEntity = {
                            ...baseEntity,
                            type: 'property',
                            name: propertyName,
                            fullName: propertyFullName,
                            parentClass: parentContext.className || '',
                            isExported: node.isPublic || false,
                            accessibility: propertyAccessibility,
                            isStatic: node.isStatic || false,
                            isReadonly: node.readonly || false,
                        };

                        entities.push(propertyEntity);
                        break;

                    case 'constant':
                        const constantName = node.name?.name || '';
                        const constantFullName = getFullyQualifiedName(constantName || '', 'const');

                        const constantEntity: EnhancedCodeEntity = {
                            ...baseEntity,
                            type: 'variable',
                            name: constantName,
                            fullName: constantFullName,
                            parentClass: parentContext.className || '',
                            isExported: true,
                        };

                        entities.push(constantEntity);
                        break;
                }

                // Generic traversal for nested structures
                if (Array.isArray(node.body)) {
                    node.body.forEach((child: any) => traverse(child, parentContext));
                }
                if (Array.isArray(node.children)) {
                    node.children.forEach((child: any) => traverse(child, parentContext));
                }
            };

            traverse(ast);
        } catch (error) {
            console.warn(`PHP parsing failed for ${filePath}, attempting HTML parsing:`, error);
        }

        // Parse inline HTML content
        try {
            const htmlEntities = await this.htmlParser.parseCodeEntities(filePath, fileContent, projectRootPath);
            entities.push(...htmlEntities);
        } catch (error) {
            console.error(`Error parsing inline HTML in ${filePath}:`, error);
        }

        return entities;
    }

    protected extractDocstring(fileContent: string, startOffset: number): string | null {
        const lines = fileContent.substring(0, startOffset).split('\n');
        const commentLines: string[] = [];

        // Look backwards for comment lines
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (line.startsWith('#') || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) {
                commentLines.unshift(line);
            } else if (line.length > 0) {
                break;
            }
        }

        return commentLines.length > 0 ? commentLines.join('\n') : null;
    }

    private extractValue(node: any): string {
        if (!node) return '';

        switch (node.kind) {
            case 'string':
                return `"${node.value}"`;
            case 'number':
                return String(node.value);
            case 'boolean':
                return String(node.value);
            case 'array':
                return '[]';
            case 'nullkeyword':
                return 'null';
            default:
                return String(node.value || '');
        }
    }

    private parseReturnType(node: any): string {
        if (node.type) {
            return this.extractName(node.type);
        }

        if (node.returnType) {
            return this.extractName(node.returnType);
        }

        return 'mixed';
    }
}