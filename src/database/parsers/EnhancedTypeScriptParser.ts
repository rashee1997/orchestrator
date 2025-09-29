// Enhanced TypeScript/JavaScript parser module with improved performance and features
import { parse } from '@typescript-eslint/typescript-estree';
import { AST_NODE_TYPES, TSESTree } from '@typescript-eslint/types';
import { BaseLanguageParser } from './ILanguageParser.js'; // Assuming these base interfaces exist
import { ExtractedImport, ExtractedCodeEntity } from '../services/CodebaseIntrospectionService.js';
import path from 'path';

// --- START: Interfaces (unchanged) ---

interface DocBlockTag { tagName: string; paramName?: string; type?: string; description: string; }
interface DocBlock { summary: string; description:string; tags: DocBlockTag[]; }
interface EnhancedTypeInfo { name: string; isNullable: boolean; isOptional: boolean; isArray: boolean; isFunction: boolean; isPromise: boolean; unionTypes?: EnhancedTypeInfo[]; intersectionTypes?: EnhancedTypeInfo[]; genericArgs?: EnhancedTypeInfo[]; functionSignature?: { params: EnhancedParameterInfo[]; returnType: EnhancedTypeInfo; }; raw: string; }
interface EnhancedParameterInfo { name: string; typeInfo?: EnhancedTypeInfo; isOptional: boolean; isRest: boolean; defaultValue?: string; }
interface CallInfo { name: string; callee: string; isNew: boolean; }
interface EnhancedGenericTypeInfo {
  name: string;
  constraint?: string;
  default?: string;
}

interface EnhancedExtractedCodeEntity extends ExtractedCodeEntity {
  complexityScore?: number;
  decorators?: string[];
  genericTypes?: EnhancedGenericTypeInfo[];
  accessModifier?: 'public' | 'private' | 'protected';
  extendedClasses?: string[];
  isStatic?: boolean;
  implementedInterfaces?: string[];
  extendedInterfaces?: string[];
  members?: string[];
  isConst?: boolean;
  isReadonly?: boolean;
  docBlock?: DocBlock;
  parameters?: EnhancedParameterInfo[];
  returnTypeInfo?: EnhancedTypeInfo;
  typeInfo?: EnhancedTypeInfo;
  calls?: CallInfo[];
}
interface EnhancedExtractedImport extends ExtractedImport { originalSpecifier?: string; resolvedPath?: string; importKind?: 'value' | 'type' | 'typeof'; isNamespaceImport?: boolean; }

// --- END: Interfaces ---

interface ParseOptions {
  includeDecorators?: boolean;
  calculateComplexity?: boolean;
}

type FullParseResult = {
  imports: EnhancedExtractedImport[];
  entities: EnhancedExtractedCodeEntity[];
};

type VisitorContext = {
  parent?: TSESTree.Node;
  grandParent?: TSESTree.Node;
  fullNamePrefix: string;
  className?: string;
  isExported: boolean;
  // Tracks the root node of the current function/method scope for associating calls and complexity
  currentFunctionScopeNode?: TSESTree.Node;
  filePath: string;
};

export class ParserError extends Error {
  constructor(message: string, public readonly originalError?: Error) {
    super(message);
    this.name = 'ParserError';
  }
}

export class EnhancedTypeScriptParser extends BaseLanguageParser {
  private readonly astCache = new Map<string, TSESTree.Program>();
  private readonly fullParseCache = new Map<string, FullParseResult>();

  // --- State for a single parse operation ---
  private _currentFileContent = '';
  private _currentFilePath = '';
  private _currentProjectRoot?: string;
  private _imports: EnhancedExtractedImport[] = [];
  private _entities: EnhancedExtractedCodeEntity[] = [];
  private _entityNodeMap = new Map<TSESTree.Node, EnhancedExtractedCodeEntity>();
  private _complexityMap = new Map<TSESTree.Node, number>();
  private _callMap = new Map<TSESTree.Node, CallInfo[]>();
  // ---

  getSupportedExtensions(): string[] {
    return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cts'];
  }

  getLanguageName(): string {
    return 'typescript';
  }

  async parseImports(filePath: string, fileContent: string): Promise<EnhancedExtractedImport[]> {
    const { imports } = await this._performFullParse(filePath, fileContent, '', {});
    return imports;
  }

  async parseCodeEntities(filePath: string, fileContent: string, projectRootPath: string, options: ParseOptions = {}): Promise<EnhancedExtractedCodeEntity[]> {
    const { entities } = await this._performFullParse(filePath, fileContent, projectRootPath, options);
    return entities;
  }

  private async _performFullParse(filePath: string, fileContent: string, projectRootPath: string, options: ParseOptions): Promise<FullParseResult> {
    const cacheKey = this._getCacheKey(filePath, fileContent, projectRootPath, options);
    if (this.fullParseCache.has(cacheKey)) {
      return this.fullParseCache.get(cacheKey)!;
    }

    this._resetState(fileContent);

    try {
      const ast = this._parseWithCache(fileContent, filePath);
      const absoluteFilePath = path.resolve(filePath).replace(/\\/g, '/');
      const relativeFilePath = projectRootPath ? path.relative(projectRootPath, absoluteFilePath).replace(/\\/g, '/') : filePath;
      this._currentFilePath = absoluteFilePath;
      this._currentProjectRoot = projectRootPath ? path.resolve(projectRootPath) : undefined;
      const initialContext: VisitorContext = {
        fullNamePrefix: relativeFilePath,
        isExported: false,
        filePath: absoluteFilePath,
      };

      this._visit(ast, initialContext, options);
      this._assembleFinalEntities(options);

      const result: FullParseResult = { imports: this._imports, entities: this._entities };
      this.fullParseCache.set(cacheKey, result);
      return result;
    } catch (error: unknown) {
      const originalError = error instanceof Error ? error : new Error(String(error));
      throw new ParserError(`Failed to parse file: ${filePath}`, originalError);
    }
  }

  private _resetState(fileContent: string): void {
    this._currentFileContent = fileContent;
    this._currentFilePath = '';
    this._currentProjectRoot = undefined;
    this._imports = [];
    this._entities = [];
    this._entityNodeMap.clear();
    this._complexityMap.clear();
    this._callMap.clear();
  }

  private _getCacheKey(filePath: string, fileContent: string, projectRootPath: string, options: ParseOptions): string {
    const contentHash = this._hashContent(fileContent);
    const optionsString = JSON.stringify(options);
    return `${filePath}:${contentHash}:${projectRootPath}:${optionsString}`;
  }

  private _parseWithCache(fileContent: string, filePath: string): TSESTree.Program {
    const contentHash = this._hashContent(fileContent);
    const cacheKey = `${filePath}:${contentHash}`;
    if (this.astCache.has(cacheKey)) { return this.astCache.get(cacheKey)!; }

    const ast = parse(fileContent, {
      ecmaVersion: 2022, sourceType: 'module',
      jsx: filePath.endsWith('.tsx') || filePath.endsWith('.jsx'),
      loc: true, range: true, comment: true,
    });
    this.astCache.set(cacheKey, ast);
    return ast;
  }

  private _hashContent(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i += 1) {
      hash = (hash << 5) - hash + content.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  // --- START: True Single-Pass Visitor ---

  private _visit(node: TSESTree.Node | null | undefined, context: VisitorContext, options: ParseOptions): void {
    if (!node) return;

    let newContext = { ...context };
    const isFunctionScopeNode = this._isFunctionScopeNode(node.type);
    if (isFunctionScopeNode) {
      newContext.currentFunctionScopeNode = node;
    }

    if (options.calculateComplexity) {
      this._collectComplexity(node, newContext);
    }
    this._collectCalls(node, newContext);

    const handler = this.nodeHandlers[node.type as AST_NODE_TYPES];
    if (handler) {
      try {
        newContext = handler.call(this, node, newContext, options) || newContext;
      } catch (handlerError) {
        const errorMessage = handlerError instanceof Error ? handlerError.message : String(handlerError);
        console.warn(`EnhancedTypeScriptParser: failed to handle node ${node.type}: ${errorMessage}`);
      }
    }

    for (const key in node) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
      const child = (node as any)[key];
      if (child && typeof child === 'object') {
        if (Array.isArray(child)) {
          child.forEach(subChild =>
            this._visit(subChild, { ...newContext, parent: node, grandParent: context.parent }, options)
          );
        } else {
          this._visit(child, { ...newContext, parent: node, grandParent: context.parent }, options);
        }
      }
    }
  }
  
  // --- START: Node Handlers Map ---

  private readonly nodeHandlers: Partial<Record<AST_NODE_TYPES, (node: any, context: VisitorContext, options: ParseOptions) => VisitorContext | void>> = {
    [AST_NODE_TYPES.ImportDeclaration]: node => {
      this._imports.push(...this._processImportDeclaration(node));
    },
    [AST_NODE_TYPES.ExportNamedDeclaration]: (node, ctx) => this._processExportNamedDeclaration(node, ctx),
    [AST_NODE_TYPES.ExportAllDeclaration]: (node, ctx) => {
      if (node.source) {
        this._imports.push(this._processReExport(node, ctx));
      }
    },
    [AST_NODE_TYPES.ExportDefaultDeclaration]: (node, ctx) => ({ ...ctx, isExported: true }),
    [AST_NODE_TYPES.ImportExpression]: node => {
      this._processDynamicImport(node);
    },
    [AST_NODE_TYPES.ClassDeclaration]: (node, ctx, opts) => this._processClassDeclaration(node, ctx, opts),
    [AST_NODE_TYPES.FunctionDeclaration]: (node, ctx, opts) => this._processFunctionDeclaration(node, ctx, opts),
    [AST_NODE_TYPES.ArrowFunctionExpression]: (node, ctx, opts) => this._processArrowFunctionExpression(node, ctx, opts),
    [AST_NODE_TYPES.MethodDefinition]: (node, ctx, opts) => this._processMethodDefinition(node, ctx, opts),
    [AST_NODE_TYPES.TSInterfaceDeclaration]: (node, ctx, opts) => this._processInterfaceDeclaration(node, ctx, opts),
    [AST_NODE_TYPES.TSTypeAliasDeclaration]: (node, ctx, opts) => this._processTypeAliasDeclaration(node, ctx, opts),
    [AST_NODE_TYPES.TSEnumDeclaration]: (node, ctx, opts) => this._processEnumDeclaration(node, ctx, opts),
    [AST_NODE_TYPES.VariableDeclarator]: (node, ctx, opts) => this._processVariableDeclarator(node, ctx, opts),
    [AST_NODE_TYPES.PropertyDefinition]: (node, ctx, opts) => this._processPropertyDefinition(node, ctx, opts),
  };

  // --- START: Data Collection and Assembly ---

  private _isFunctionScopeNode(type: AST_NODE_TYPES): boolean { return [AST_NODE_TYPES.FunctionDeclaration, AST_NODE_TYPES.FunctionExpression, AST_NODE_TYPES.ArrowFunctionExpression, AST_NODE_TYPES.MethodDefinition].includes(type); }
  private _isComplexityNode(type: AST_NODE_TYPES): boolean { return [AST_NODE_TYPES.IfStatement, AST_NODE_TYPES.ConditionalExpression, AST_NODE_TYPES.SwitchCase, AST_NODE_TYPES.ForStatement, AST_NODE_TYPES.ForInStatement, AST_NODE_TYPES.ForOfStatement, AST_NODE_TYPES.WhileStatement, AST_NODE_TYPES.DoWhileStatement, AST_NODE_TYPES.CatchClause].includes(type); }
  
  private _collectComplexity(node: TSESTree.Node, context: VisitorContext): void {
    const scopeNode = context.currentFunctionScopeNode;
    if (!scopeNode) return;
    let complexityIncrease = 0;
    if (this._isComplexityNode(node.type)) { complexityIncrease = 1; }
    else if (node.type === AST_NODE_TYPES.LogicalExpression && ['&&', '||', '??'].includes(node.operator)) { complexityIncrease = 1; }
    if (complexityIncrease > 0) { this._complexityMap.set(scopeNode, (this._complexityMap.get(scopeNode) || 1) + complexityIncrease); }
  }

  private _collectCalls(node: TSESTree.Node, context: VisitorContext): void {
    const scopeNode = context.currentFunctionScopeNode;
    if (!scopeNode) return;
    let callInfo: CallInfo | null = null;
    if (node.type === AST_NODE_TYPES.CallExpression) {
      const calleeName = this._getIdentifierName(node.callee);
      if (calleeName) callInfo = { name: calleeName.split('.').pop() || calleeName, callee: calleeName, isNew: false };
    } else if (node.type === AST_NODE_TYPES.NewExpression) {
      const calleeName = this._getIdentifierName(node.callee);
      if (calleeName) callInfo = { name: calleeName, callee: calleeName, isNew: true };
    }
    if (callInfo) {
      const calls = this._callMap.get(scopeNode) || [];
      calls.push(callInfo);
      this._callMap.set(scopeNode, calls);
    }
  }

  private _assembleFinalEntities(options: ParseOptions): void {
    this._entities = [];
    for (const [node, entity] of this._entityNodeMap.entries()) {
      if (options.calculateComplexity) entity.complexityScore = this._complexityMap.get(node) || 1;
      entity.calls = this._callMap.get(node) || [];
      this._entities.push(entity);
    }
  }

  private _createAndStoreEntity(node: TSESTree.Node, context: VisitorContext, options: ParseOptions, type: EnhancedExtractedCodeEntity['type'], name: string, extra: Partial<EnhancedExtractedCodeEntity> = {}): void {
    const fullName = `${context.fullNamePrefix}${context.className ? `::${context.className}` : ''}::${name}`;
    const entity: EnhancedExtractedCodeEntity = {
      type, name, fullName,
      startLine: node.loc.start.line, endLine: node.loc.end.line,
      filePath: context.fullNamePrefix, containingDirectory: path.dirname(context.fullNamePrefix),
      signature: this._formatEnhancedSignature(node), docBlock: this._parseJSDoc(node),
      decorators: options.includeDecorators ? this._extractDecorators(node as any) : undefined, ...extra,
    };
    this._entityNodeMap.set(node, entity);
  }

  // --- START: Handler Implementations ---

  private _processImportDeclaration(node: TSESTree.ImportDeclaration): EnhancedExtractedImport[] {
    const source = node.source.value;
    const originalImportString = this._typeNodeToString(node);
    if (node.specifiers.length === 0) { return [{ type: 'file', targetPath: source, originalImportString, importedSymbols: [], isDynamicImport: false, isTypeOnlyImport: node.importKind === 'type', startLine: node.loc.start.line, endLine: node.loc.end.line, originalSpecifier: source }]; }
    return node.specifiers.map(specifier => ({
      type: 'file', targetPath: source, originalImportString,
      importedSymbols: this._extractImportedSymbols(specifier), isDynamicImport: false,
      isTypeOnlyImport: node.importKind === 'type' || (specifier.type === AST_NODE_TYPES.ImportSpecifier && specifier.importKind === 'type'),
      isNamespaceImport: specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier, startLine: node.loc.start.line, endLine: node.loc.end.line, originalSpecifier: source,
    }));
  }

  private _processExportNamedDeclaration(node: TSESTree.ExportNamedDeclaration, context: VisitorContext): VisitorContext {
    if (node.source) this._imports.push(this._processReExport(node, context));
    return { ...context, isExported: true };
  }
  
  private _processReExport(
    node: TSESTree.ExportNamedDeclaration | TSESTree.ExportAllDeclaration,
    context: VisitorContext
  ): EnhancedExtractedImport {
    const source = node.source!.value;
    const baseFilePath = context.filePath || this._currentFilePath;
    const importKind = this._determineReExportKind(node);
    const importedSymbols =
      node.type === AST_NODE_TYPES.ExportAllDeclaration
        ? ['*']
        : node.specifiers
            .map(specifier => this._getIdentifierName(specifier.exported ?? specifier.local))
            .filter((name): name is string => !!name);

    return {
      type: this._determineImportType(source, context.fullNamePrefix),
      targetPath: baseFilePath ? this._resolveImportPath(source, baseFilePath) : source,
      originalImportString: this._typeNodeToString(node),
      importedSymbols,
      isDynamicImport: false,
      isTypeOnlyImport: importKind === 'type',
      importKind,
      startLine: node.loc.start.line,
      endLine: node.loc.end.line,
      originalSpecifier: source,
    };
  }
  
  private _processDynamicImport(node: TSESTree.ImportExpression): void {
    if (node.source.type === AST_NODE_TYPES.Literal) {
      const source = String(node.source.value);
      this._imports.push({ type: 'file', targetPath: source, originalImportString: this._typeNodeToString(node), importedSymbols: [], isDynamicImport: true, isTypeOnlyImport: false, startLine: node.loc.start.line, endLine: node.loc.end.line, originalSpecifier: source });
    }
  }

  private _processClassDeclaration(node: TSESTree.ClassDeclaration, context: VisitorContext, options: ParseOptions): VisitorContext {
    let name: string;
    if (node.id?.name) {
      name = node.id.name;
    } else if (node.loc) {
      const { start, end } = node.loc;
      name = `AnonymousClass_${start.line}_${start.column}_${end.line}_${end.column}`;
    } else {
      name = `AnonymousClass_${node.range?.[0] ?? 0}`;
    }
    this._createAndStoreEntity(node, context, options, 'class', name, {
      isExported: context.isExported,
      implementedInterfaces: (node.implements || []).map(impl => this._typeNodeToString(impl)),
      extendedClasses: node.superClass ? [this._typeNodeToString(node.superClass)] : [],
      genericTypes: this._extractGenericTypes(node.typeParameters),
    });
    return { ...context, className: name };
  }
  
  private _processFunctionDeclaration(node: TSESTree.FunctionDeclaration, context: VisitorContext, options: ParseOptions): void {
    if (node.id) {
      this._createAndStoreEntity(node, context, options, 'function', node.id.name, {
        isExported: context.isExported, isAsync: node.async, parameters: this._extractParameters(node.params),
        returnTypeInfo: this._parseTypeFromNode(node.returnType?.typeAnnotation), genericTypes: this._extractGenericTypes(node.typeParameters),
      });
    }
  }

  private _processArrowFunctionExpression(
    node: TSESTree.ArrowFunctionExpression,
    context: VisitorContext,
    options: ParseOptions
  ): void {
    let entityName: string | undefined;
    const parent = context.parent;

    if (parent?.type === AST_NODE_TYPES.VariableDeclarator && parent.id.type === AST_NODE_TYPES.Identifier) {
      entityName = parent.id.name;
    } else if (parent?.type === AST_NODE_TYPES.Property) {
      entityName = this._getIdentifierName(parent.key as unknown as TSESTree.Node);
      if (!entityName && parent.key.type === AST_NODE_TYPES.Literal && typeof parent.key.value === 'string') {
        entityName = parent.key.value;
      }
    } else if (parent?.type === AST_NODE_TYPES.PropertyDefinition) {
      entityName = this._getIdentifierName(parent.key);
    } else if (parent?.type === AST_NODE_TYPES.ArrayExpression) {
      const grandParent = context.grandParent;
      if (grandParent?.type === AST_NODE_TYPES.VariableDeclarator && grandParent.id.type === AST_NODE_TYPES.Identifier) {
        const index = parent.elements.indexOf(node);
        const resolvedIndex = index >= 0 ? index : parent.elements.findIndex(element => element === node);
        entityName = `${grandParent.id.name}[${resolvedIndex >= 0 ? resolvedIndex : 0}]`;
      }
    } else if (parent?.type === AST_NODE_TYPES.CallExpression) {
      const calleeName = this._getIdentifierName(parent.callee) || 'anonymous';
      const argIndex = parent.arguments.indexOf(node);
      const resolvedIndex = argIndex >= 0 ? argIndex : parent.arguments.findIndex(argument => argument === node);
      entityName = `${calleeName}_arg${resolvedIndex >= 0 ? resolvedIndex : 0}`;
    } else if (parent?.type === AST_NODE_TYPES.AssignmentExpression && parent.left.type === AST_NODE_TYPES.Identifier) {
      entityName = parent.left.name;
    }

    if (entityName) {
      this._createAndStoreEntity(node, context, options, 'function', entityName, {
        isExported: context.isExported,
        isAsync: node.async,
        parameters: this._extractParameters(node.params),
        returnTypeInfo: this._parseTypeFromNode(node.returnType?.typeAnnotation),
        genericTypes: this._extractGenericTypes(node.typeParameters),
      });
    }
  }
  
  private _processMethodDefinition(node: TSESTree.MethodDefinition, context: VisitorContext, options: ParseOptions): void {
    const name = this._getIdentifierName(node.key);
    if (name) {
      this._createAndStoreEntity(node, context, options, 'method', name, {
        parentClass: context.className, isStatic: node.static, isAsync: node.value.async,
        parameters: this._extractParameters(node.value.params),
        returnTypeInfo: this._parseTypeFromNode(node.value.returnType?.typeAnnotation), accessModifier: node.accessibility,
      });
    }
  }

  private _processInterfaceDeclaration(node: TSESTree.TSInterfaceDeclaration, context: VisitorContext, options: ParseOptions): void {
    this._createAndStoreEntity(node, context, options, 'interface', node.id.name, { isExported: context.isExported, extendedInterfaces: (node.extends || []).map(ext => this._typeNodeToString(ext)), genericTypes: this._extractGenericTypes(node.typeParameters) });
  }

  private _processTypeAliasDeclaration(node: TSESTree.TSTypeAliasDeclaration, context: VisitorContext, options: ParseOptions): void {
    this._createAndStoreEntity(node, context, options, 'type_alias', node.id.name, { isExported: context.isExported, genericTypes: this._extractGenericTypes(node.typeParameters), typeInfo: this._parseTypeFromNode(node.typeAnnotation) });
  }

  private _processEnumDeclaration(node: TSESTree.TSEnumDeclaration, context: VisitorContext, options: ParseOptions): void {
    this._createAndStoreEntity(node, context, options, 'enum', node.id.name, { isExported: context.isExported, members: node.members.map(member => this._getIdentifierName(member.id)), isConst: node.const || false });
  }

  private _processVariableDeclarator(
    node: TSESTree.VariableDeclarator,
    context: VisitorContext,
    options: ParseOptions
  ): void {
    if (context.parent?.type !== AST_NODE_TYPES.VariableDeclaration) return;

    const declaration = context.parent;
    const registerVariable = (name: string, typeAnnotation?: TSESTree.TypeNode) => {
      this._createAndStoreEntity(node, context, options, 'variable', name, {
        isExported: context.isExported,
        isConst: declaration.kind === 'const',
        typeInfo: this._parseTypeFromNode(typeAnnotation),
      });
    };

    if (node.id.type === AST_NODE_TYPES.Identifier) {
      const typeAnnotationNode =
        'typeAnnotation' in node.id && node.id.typeAnnotation
          ? node.id.typeAnnotation.typeAnnotation
          : undefined;
      registerVariable(node.id.name, typeAnnotationNode);
      return;
    }

    if (node.id.type === AST_NODE_TYPES.ArrayPattern || node.id.type === AST_NODE_TYPES.ObjectPattern) {
      const typeAnnotation = node.id.typeAnnotation?.typeAnnotation;
      const identifiers = this._extractIdentifiersFromPattern(node.id, typeAnnotation);
      identifiers.forEach(identifier => registerVariable(identifier.name, identifier.typeAnnotation));
    }
  }

  private _processPropertyDefinition(node: TSESTree.PropertyDefinition, context: VisitorContext, options: ParseOptions): void {
    let name = this._getIdentifierName(node.key);
    if (!name && node.computed && node.key && 'range' in node.key && node.key.range) {
      name = `[${this._currentFileContent.substring(node.key.range[0], node.key.range[1])}]`;
    }
    if (!name && node.loc) {
      const { start, end } = node.loc;
      name = `computed_${start.line}_${start.column}_${end.line}_${end.column}`;
    }
    if (!name) return;

    const typeAnnotationNode = node.typeAnnotation ? node.typeAnnotation.typeAnnotation : undefined;
    this._createAndStoreEntity(node, context, options, 'property', name, {
      parentClass: context.className,
      isStatic: node.static,
      isReadonly: node.readonly || false,
      accessModifier: node.accessibility,
      typeInfo: this._parseTypeFromNode(typeAnnotationNode),
    });
  }

  // --- START: Helper Methods ---

  private _typeNodeToString(node: TSESTree.Node | null | undefined): string {
    if (!node || !node.range) return '';
    return this._currentFileContent.substring(node.range[0], node.range[1]);
  }

  private _createBaseTypeInfo(): Omit<EnhancedTypeInfo, 'name' | 'raw'> {
    return {
      isNullable: false,
      isOptional: false,
      isArray: false,
      isFunction: false,
      isPromise: false,
    };
  }

  private _parseTypeFromNode(typeNode: TSESTree.TypeNode | null | undefined): EnhancedTypeInfo | undefined {
    if (!typeNode) return undefined;
    const raw = this._typeNodeToString(typeNode);
    const baseInfo = this._createBaseTypeInfo();

    switch (typeNode.type) {
      case AST_NODE_TYPES.TSUnionType:
        return this._parseUnionType(typeNode, raw, baseInfo);
      case AST_NODE_TYPES.TSIntersectionType:
        return this._parseIntersectionType(typeNode, raw, baseInfo);
      case AST_NODE_TYPES.TSArrayType:
        return this._parseArrayType(typeNode, raw, baseInfo);
      case AST_NODE_TYPES.TSFunctionType:
        return this._parseFunctionType(typeNode, raw, baseInfo);
      case AST_NODE_TYPES.TSTypeReference:
        return this._parseTypeReference(typeNode, raw, baseInfo);
      case AST_NODE_TYPES.TSAnyKeyword:
        return { raw, name: 'any', ...baseInfo };
      case AST_NODE_TYPES.TSStringKeyword:
        return { raw, name: 'string', ...baseInfo };
      case AST_NODE_TYPES.TSNumberKeyword:
        return { raw, name: 'number', ...baseInfo };
      case AST_NODE_TYPES.TSBooleanKeyword:
        return { raw, name: 'boolean', ...baseInfo };
      case AST_NODE_TYPES.TSVoidKeyword:
        return { raw, name: 'void', ...baseInfo };
      case AST_NODE_TYPES.TSNullKeyword:
        return { raw, name: 'null', ...baseInfo, isNullable: true };
      case AST_NODE_TYPES.TSUndefinedKeyword:
        return { raw, name: 'undefined', ...baseInfo, isNullable: true };
      case AST_NODE_TYPES.TSNeverKeyword:
        return { raw, name: 'never', ...baseInfo };
      case AST_NODE_TYPES.TSUnknownKeyword:
        return { raw, name: 'unknown', ...baseInfo };
      default:
        return { raw, name: raw, ...baseInfo };
    }
  }

  private _parseUnionType(
    typeNode: TSESTree.TSUnionType,
    raw: string,
    baseInfo: Omit<EnhancedTypeInfo, 'name' | 'raw'>
  ): EnhancedTypeInfo {
    const types = typeNode.types
      .map(t => this._parseTypeFromNode(t))
      .filter((t): t is EnhancedTypeInfo => !!t);
    return {
      raw,
      name: 'union',
      ...baseInfo,
      unionTypes: types,
      isNullable: types.some(t => t.name === 'null' || t.name === 'undefined'),
    };
  }

  private _parseIntersectionType(
    typeNode: TSESTree.TSIntersectionType,
    raw: string,
    baseInfo: Omit<EnhancedTypeInfo, 'name' | 'raw'>
  ): EnhancedTypeInfo {
    return {
      raw,
      name: 'intersection',
      ...baseInfo,
      intersectionTypes: typeNode.types
        .map(t => this._parseTypeFromNode(t))
        .filter((t): t is EnhancedTypeInfo => !!t),
    };
  }

  private _parseArrayType(
    typeNode: TSESTree.TSArrayType,
    raw: string,
    baseInfo: Omit<EnhancedTypeInfo, 'name' | 'raw'>
  ): EnhancedTypeInfo {
    const elementType = this._parseTypeFromNode(typeNode.elementType);
    return {
      raw,
      name: elementType?.name || 'any',
      ...baseInfo,
      isArray: true,
      genericArgs: elementType ? [elementType] : [],
    };
  }

  private _parseFunctionType(
    typeNode: TSESTree.TSFunctionType,
    raw: string,
    baseInfo: Omit<EnhancedTypeInfo, 'name' | 'raw'>
  ): EnhancedTypeInfo {
    const params = this._extractParameters(typeNode.params as unknown as TSESTree.Parameter[]);
    const returnType = this._parseTypeFromNode(typeNode.returnType?.typeAnnotation);
    return {
      raw,
      name: 'function',
      ...baseInfo,
      isFunction: true,
      functionSignature: returnType
        ? {
            params,
            returnType,
          }
        : undefined,
    };
  }

  private _parseTypeReference(
    typeNode: TSESTree.TSTypeReference,
    raw: string,
    baseInfo: Omit<EnhancedTypeInfo, 'name' | 'raw'>
  ): EnhancedTypeInfo {
    const name = this._getIdentifierName(typeNode.typeName);
    const typeArguments = typeNode.typeArguments?.params ?? [];
    const args = typeArguments
      .map((typeArg: TSESTree.TypeNode) => this._parseTypeFromNode(typeArg))
      .filter((typeArg): typeArg is EnhancedTypeInfo => !!typeArg);
    return {
      raw,
      name,
      ...baseInfo,
      isPromise: name === 'Promise',
      genericArgs: args,
    };
  }
  private _extractParameters(params: TSESTree.Parameter[]): EnhancedParameterInfo[] {
    return params.map(p => {
      let name = '', typeAnnotation, optional = false, isRest = false, defaultValue;
      if (p.type === AST_NODE_TYPES.Identifier) { name = p.name; typeAnnotation = p.typeAnnotation?.typeAnnotation; optional = p.optional || false; }
      else if (p.type === AST_NODE_TYPES.AssignmentPattern && p.left.type === AST_NODE_TYPES.Identifier) { name = p.left.name; typeAnnotation = p.left.typeAnnotation?.typeAnnotation; optional = true; defaultValue = this._typeNodeToString(p.right); }
      else if (p.type === AST_NODE_TYPES.RestElement && p.argument.type === AST_NODE_TYPES.Identifier) { name = p.argument.name; typeAnnotation = p.argument.typeAnnotation?.typeAnnotation; isRest = true; }
      return { name, typeInfo: this._parseTypeFromNode(typeAnnotation), isOptional: optional, isRest, defaultValue };
    });
  }

  private _extractIdentifiersFromPattern(
    pattern:
      | TSESTree.BindingName
      | TSESTree.AssignmentPattern
      | TSESTree.RestElement,
    inheritedTypeAnnotation?: TSESTree.TypeNode
  ): Array<{ name: string; typeAnnotation?: TSESTree.TypeNode }> {
    if (!pattern) return [];
    switch (pattern.type) {
      case AST_NODE_TYPES.Identifier:
        return [
          {
            name: pattern.name,
            typeAnnotation: pattern.typeAnnotation?.typeAnnotation ?? inheritedTypeAnnotation,
          },
        ];
      case AST_NODE_TYPES.AssignmentPattern:
        return this._extractIdentifiersFromPattern(
          pattern.left as any,
          inheritedTypeAnnotation
        );
      case AST_NODE_TYPES.ObjectPattern: {
        const nestedType = pattern.typeAnnotation?.typeAnnotation ?? inheritedTypeAnnotation;
        return pattern.properties.flatMap(property => {
          if (property.type === AST_NODE_TYPES.Property) {
            return this._extractIdentifiersFromPattern(property.value as any, nestedType);
          }
          if (property.type === AST_NODE_TYPES.RestElement) {
            return this._extractIdentifiersFromPattern(property.argument as any, nestedType);
          }
          return [];
        });
      }
      case AST_NODE_TYPES.ArrayPattern: {
        const nestedType = pattern.typeAnnotation?.typeAnnotation ?? inheritedTypeAnnotation;
        return pattern.elements.flatMap(element =>
          element ? this._extractIdentifiersFromPattern(element as any, nestedType) : []
        );
      }
      case AST_NODE_TYPES.RestElement:
        return this._extractIdentifiersFromPattern(pattern.argument as any, inheritedTypeAnnotation);
      default:
        return [];
    }
  }
  private _parseJSDoc(node: TSESTree.Node): DocBlock | undefined {
    const comments = 'leadingComments' in node ? (node as { leadingComments: TSESTree.Comment[] }).leadingComments : undefined;
    const jsdocComment = comments?.find(c => c.value.startsWith('*'));
    if (!jsdocComment) return undefined;
    const lines = `/*${jsdocComment.value}*/`.replace('/**', '').replace('*/', '').split('\n').map(l => l.replace(/^\s*\*\s?/, '').trim());
    let summary = '', description = '', isDescription = false; const tags: DocBlockTag[] = [];
    for (const line of lines) {
      if (line.startsWith('@')) {
        isDescription = false;
        // Captures: 1:tagName, 2:type, 3:paramName, 4:description
        const match = line.match(/^@(\w+)\s*(?:\{([^}]+)\})?\s*([$\w]+)?\s*(.*)/);
        if (match) tags.push({ tagName: match[1], type: match[2], paramName: match[3], description: match[4].trim() });
      } else if (!summary && line) { summary = line; isDescription = true; } else if (isDescription) { description += ` ${line}`; }
    }
    return { summary, description: description.trim(), tags };
  }
  private _getIdentifierName(node: TSESTree.Node | null | undefined): string {
    if (!node) return '';
    switch (node.type) {
      case AST_NODE_TYPES.Identifier:
        return node.name;
      case AST_NODE_TYPES.Literal:
        return typeof node.value === 'string' || typeof node.value === 'number'
          ? String(node.value)
          : '';
      case AST_NODE_TYPES.MemberExpression:
        return `${this._getIdentifierName(node.object)}.${this._getIdentifierName(node.property)}`;
      case AST_NODE_TYPES.ThisExpression:
        return 'this';
      case AST_NODE_TYPES.Super:
        return 'super';
      case AST_NODE_TYPES.CallExpression:
        return this._getIdentifierName(node.callee);
      case AST_NODE_TYPES.TSQualifiedName:
        return `${this._getIdentifierName(node.left)}.${this._getIdentifierName(node.right)}`;
      default:
        return '';
    }
  }
  private _extractDecorators(node: TSESTree.ClassDeclaration | TSESTree.MethodDefinition | TSESTree.PropertyDefinition): string[] {
    if (!('decorators' in node) || !node.decorators) return [];
    return node.decorators.map(d => d.expression.type === AST_NODE_TYPES.CallExpression ? this._getIdentifierName(d.expression.callee) : this._getIdentifierName(d.expression));
  }
  private _extractGenericTypes(
    node: TSESTree.TSTypeParameterDeclaration | undefined
  ): EnhancedGenericTypeInfo[] {
    if (!node) return [];
    return node.params.map(param => {
      const baseName =
        typeof (param as any).name === 'string'
          ? ((param as any).name as string)
          : ((param.name as TSESTree.Identifier | undefined)?.name ?? '');
      const constraint = param.constraint ? this._typeNodeToString(param.constraint) : undefined;
      const defaultValue = param.default ? this._typeNodeToString(param.default) : undefined;
      return { name: baseName, constraint, default: defaultValue };
    });
  }
  private _formatEnhancedSignature(node: TSESTree.Node): string {
    if (!node.range) return this._getIdentifierName(node as any) || '';
    try {
      const start = node.range[0]; let end = node.range[1];
      if (node.type === AST_NODE_TYPES.ArrowFunctionExpression) { const idx = this._currentFileContent.indexOf('=>', node.body.range![0] - 3); if (idx !== -1) end = idx + 2; }
      else if ('body' in node && node.body && (node.body as TSESTree.Node).range) { end = (node.body as TSESTree.Node).range![0]; }
      return this._currentFileContent.substring(start, end).replace(/\s*{?$/, '').trim();
    } catch { return this._getIdentifierName(node as any) || ''; }
  }
  private _extractImportedSymbols(specifier: TSESTree.ImportClause): string[] {
    if (specifier.type === AST_NODE_TYPES.ImportSpecifier) {
      const importedName = this._getIdentifierName(specifier.imported) || this._getIdentifierName(specifier.local);
      return importedName ? [importedName] : [];
    }
    if (specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier) return [`* as ${specifier.local.name}`];
    if (specifier.type === AST_NODE_TYPES.ImportDefaultSpecifier) return ['default'];
    return [];
  }
  private _determineImportType(source: string, filePath: string): 'module' | 'file' {
    return source.startsWith('.') || path.isAbsolute(source) ? 'file' : 'module';
  }

  private _determineReExportKind(
    node: TSESTree.ExportNamedDeclaration | TSESTree.ExportAllDeclaration
  ): EnhancedExtractedImport['importKind'] | undefined {
    if (node.type === AST_NODE_TYPES.ExportAllDeclaration) {
      return node.exportKind === 'type' ? 'type' : 'value';
    }

    if (node.exportKind === 'type') {
      return 'type';
    }

    if (!node.specifiers.length) {
      return node.declaration ? 'value' : undefined;
    }

    const hasTypeSpecifiers = node.specifiers.some(specifier => specifier.exportKind === 'type');
    const hasValueSpecifiers = node.specifiers.some(specifier => specifier.exportKind !== 'type');

    if (hasTypeSpecifiers && !hasValueSpecifiers) {
      return 'type';
    }
    if (!hasTypeSpecifiers && hasValueSpecifiers) {
      return 'value';
    }
    return undefined;
  }

  private _resolveImportPath(source: string, filePath: string): string {
    if (!source.startsWith('.')) return source;

    if (/\0/.test(source)) {
      throw new ParserError(`Invalid import path: ${source}`);
    }

    const normalizedSource = path.normalize(source);
    const baseDirectory = path.resolve(path.dirname(filePath));
    const resolved = path.resolve(baseDirectory, normalizedSource);

    if (this._currentProjectRoot) {
      const normalizedRoot = this._currentProjectRoot.endsWith(path.sep)
        ? this._currentProjectRoot
        : `${this._currentProjectRoot}${path.sep}`;
      if (resolved !== this._currentProjectRoot && !resolved.startsWith(normalizedRoot)) {
        throw new ParserError(`Import path escapes project root: ${source}`);
      }
    }

    return resolved;
  }

  public clearCache(): void { this.astCache.clear(); this.fullParseCache.clear(); }
  public getCacheStats(): { astCacheSize: number; fullParseCacheSize: number } { return { astCacheSize: this.astCache.size, fullParseCacheSize: this.fullParseCache.size }; }
}
