// Enhanced TypeScript/JavaScript parser module with improved performance and features
import { parse } from '@typescript-eslint/typescript-estree';
import { AST_NODE_TYPES, TSESTree } from '@typescript-eslint/types';
import { BaseLanguageParser } from './ILanguageParser.js';
import { ExtractedImport, ExtractedCodeEntity } from '../services/CodebaseIntrospectionService.js';
import path from 'path';

// --- START: Enhanced Interfaces for Rich Entity Parsing ---

interface DocBlockTag {
  tagName: string;
  paramName?: string;
  type?: string;
  description: string;
}

interface DocBlock {
  summary: string;
  description: string;
  tags: DocBlockTag[];
}

interface EnhancedTypeInfo {
  name: string;
  isNullable: boolean;
  isOptional: boolean;
  isArray: boolean;
  isFunction: boolean;
  isPromise: boolean;
  unionTypes?: EnhancedTypeInfo[];
  intersectionTypes?: EnhancedTypeInfo[];
  genericArgs?: EnhancedTypeInfo[];
  functionSignature?: {
    params: EnhancedParameterInfo[];
    returnType: EnhancedTypeInfo;
  };
  raw: string; // The raw type string from source
}

interface EnhancedParameterInfo {
  name: string;
  typeInfo?: EnhancedTypeInfo;
  isOptional: boolean;
  isRest: boolean;
  defaultValue?: string;
}

interface CallInfo {
  name: string;
  callee: string; // e.g., 'myObj.myFunc' or 'myFunc'
  isNew: boolean; // true for `new MyClass()`
}

interface EnhancedExtractedCodeEntity extends ExtractedCodeEntity {
  complexityScore?: number;
  decorators?: string[];
  genericTypes?: string[];
  accessModifier?: 'public' | 'private' | 'protected';
  extendedClasses?: string[];
  isStatic?: boolean;
  implementedInterfaces?: string[];
  extendedInterfaces?: string[]; // For interface extension
  members?: string[]; // For enums
  isConst?: boolean;
  isReadonly?: boolean;
  docBlock?: DocBlock;
  parameters?: EnhancedParameterInfo[];
  returnTypeInfo?: EnhancedTypeInfo;
  typeInfo?: EnhancedTypeInfo; // For variables/properties
  calls?: CallInfo[];
}

interface EnhancedExtractedImport extends ExtractedImport {
  originalSpecifier?: string;
  resolvedPath?: string;
  importKind?: 'value' | 'type' | 'typeof';
  isNamespaceImport?: boolean;
}

// --- END: Enhanced Interfaces ---

interface ParseOptions {
  includeComments?: boolean;
  includeDecorators?: boolean;
  includeTypeAnnotations?: boolean;
  includeGenericTypes?: boolean;
  calculateComplexity?: boolean;
}

export class EnhancedTypeScriptParser extends BaseLanguageParser {
  private readonly cache = new Map<string, any>();
  private readonly importCache = new Map<string, ExtractedImport[]>();

  getSupportedExtensions(): string[] {
    return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cts'];
  }

  getLanguageName(): string {
    return 'typescript';
  }

  private parseWithCache(fileContent: string, filePath: string, options: any) {
    const cacheKey = `${filePath}:${Buffer.from(fileContent).toString('base64').slice(0, 32)}`;

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    const ast = parse(fileContent, {
      ...options,
      ecmaVersion: 2022,
      sourceType: 'module',
      jsx: filePath.endsWith('.tsx') || filePath.endsWith('.jsx'),
      loc: true,
      range: true,
      comment: true,
      attachComment: true,
    });

    this.cache.set(cacheKey, ast);
    return ast;
  }

  async parseImports(filePath: string, fileContent: string): Promise<EnhancedExtractedImport[]> {
    const cacheKey = `${filePath}:${Buffer.from(fileContent).toString('base64').slice(0, 32)}`;

    if (this.importCache.has(cacheKey)) {
      return this.importCache.get(cacheKey)!;
    }

    const imports: EnhancedExtractedImport[] = [];

    try {
      const ast = this.parseWithCache(fileContent, filePath, {});

      const nodesToVisit = [ast];
      while (nodesToVisit.length > 0) {
        const current = nodesToVisit.pop();
        if (!current) continue;

        if (current.type === AST_NODE_TYPES.ImportDeclaration) {
          imports.push(...this.processImportDeclaration(current, filePath, fileContent));
        } else if (current.type === AST_NODE_TYPES.ExportNamedDeclaration && current.source) {
          imports.push(...this.processExportDeclaration(current, filePath, fileContent));
        } else if (current.type === AST_NODE_TYPES.ExportAllDeclaration && current.source) {
          imports.push(...this.processExportDeclaration(current, filePath, fileContent));
        } else if (current.type === AST_NODE_TYPES.ImportExpression) {
          imports.push(...this.processDynamicImport(current, filePath, fileContent));
        }

        for (const key in current) {
          if (Object.prototype.hasOwnProperty.call(current, key) && typeof current[key] === 'object') {
            if (Array.isArray(current[key])) {
              nodesToVisit.push(...current[key]);
            } else if (current[key] !== null) {
              nodesToVisit.push(current[key]);
            }
          }
        }
      }

      this.importCache.set(cacheKey, imports);
    } catch (error) {
      console.error(`Enhanced import parser error in ${filePath}:`, error);
    }

    return imports;
  }

  private processImportDeclaration(node: TSESTree.ImportDeclaration, filePath: string, fileContent: string): EnhancedExtractedImport[] {
    const imports: EnhancedExtractedImport[] = [];
    const source = node.source.value;
    const originalImportString = fileContent.substring(node.range[0], node.range[1]);

    if (!node.specifiers || node.specifiers.length === 0) {
      // For side-effect imports like `import 'reflect-metadata';`
      imports.push({
        type: this.determineImportType(source, filePath),
        targetPath: this.resolveImportPath(source, filePath),
        originalImportString,
        importedSymbols: [],
        isDynamicImport: false,
        isTypeOnlyImport: node.importKind === 'type',
        startLine: node.loc.start.line,
        endLine: node.loc.end.line,
        originalSpecifier: source,
        resolvedPath: this.resolveImportPath(source, filePath)
      });
      return imports;
    }

    for (const specifier of node.specifiers) {
      const isNamespace = specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier;
      const importKind = node.importKind === 'type' || (specifier.type === AST_NODE_TYPES.ImportSpecifier && specifier.importKind === 'type') ? 'type' : 'value';

      imports.push({
        type: this.determineImportType(source, filePath),
        targetPath: this.resolveImportPath(source, filePath),
        originalImportString,
        importedSymbols: this.extractImportedSymbols(specifier),
        isDynamicImport: false,
        isTypeOnlyImport: importKind === 'type',
        isNamespaceImport: isNamespace,
        importKind,
        originalSpecifier: source,
        resolvedPath: this.resolveImportPath(source, filePath),
        startLine: node.loc.start.line,
        endLine: node.loc.end.line,
      });
    }

    return imports;
  }

  private processExportDeclaration(node: TSESTree.ExportNamedDeclaration | TSESTree.ExportAllDeclaration, filePath: string, fileContent: string): EnhancedExtractedImport[] {
    if (!node.source) return [];

    return [{
      type: this.determineImportType(node.source.value, filePath),
      targetPath: this.resolveImportPath(node.source.value, filePath),
      originalImportString: fileContent.substring(node.range[0], node.range[1]),
      importedSymbols: node.type === AST_NODE_TYPES.ExportNamedDeclaration ? this.extractExportedSymbols(node) : ['*'],
      isDynamicImport: false,
      isTypeOnlyImport: node.exportKind === 'type',
      originalSpecifier: node.source.value,
      resolvedPath: this.resolveImportPath(node.source.value, filePath),
      startLine: node.loc.start.line,
      endLine: node.loc.end.line,
    }];
  }

  private processDynamicImport(node: TSESTree.ImportExpression, filePath: string, fileContent: string): EnhancedExtractedImport[] {
    if (!node.source || node.source.type !== AST_NODE_TYPES.Literal) return [];

    const source = String(node.source.value);
    return [{
      type: this.determineImportType(source, filePath),
      targetPath: this.resolveImportPath(source, filePath),
      originalImportString: fileContent.substring(node.range[0], node.range[1]),
      importedSymbols: [],
      isDynamicImport: true,
      isTypeOnlyImport: false,
      originalSpecifier: source,
      resolvedPath: this.resolveImportPath(source, filePath),
      startLine: node.loc.start.line,
      endLine: node.loc.end.line,
    }];
  }

  private extractImportedSymbols(specifier: TSESTree.ImportClause): string[] {
    if (specifier.type === AST_NODE_TYPES.ImportSpecifier) {
        if (specifier.imported.type === AST_NODE_TYPES.Identifier) {
            return [specifier.imported.name];
        }
    } else if (specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier) {
      return [`* as ${specifier.local.name}`];
    } else if (specifier.type === AST_NODE_TYPES.ImportDefaultSpecifier) {
      return ['default'];
    }
    return [];
  }

  private extractExportedSymbols(node: TSESTree.ExportNamedDeclaration): string[] {
    return node.specifiers.map((spec) => {
        if (spec.local.type === AST_NODE_TYPES.Identifier) {
            return spec.local.name;
        }
        return '';
    }) || ['*'];
  }

  async parseCodeEntities(
    filePath: string,
    fileContent: string,
    projectRootPath: string,
    options: ParseOptions = {}
  ): Promise<EnhancedExtractedCodeEntity[]> {
    const entities: EnhancedExtractedCodeEntity[] = [];
    const absoluteFilePath = path.resolve(filePath).replace(/\\/g, '/');
    const relativeFilePath = path.relative(projectRootPath, absoluteFilePath).replace(/\\/g, '/');
    const containingDirectory = path.dirname(relativeFilePath).replace(/\\/g, '/');

    type VisitorContext = {
      parent?: TSESTree.Node;
      fullNamePrefix: string;
      className?: string;
    };

    try {
      const ast = this.parseWithCache(fileContent, filePath, {});

      const visit = (node: TSESTree.Node, context: VisitorContext) => {
        if (!node || !node.type) return;

        let entity: EnhancedExtractedCodeEntity | null = null;
        const docBlock = this.parseJSDoc(node);

        const baseEntity = {
          startLine: node.loc.start.line,
          endLine: node.loc.end.line,
          filePath: absoluteFilePath,
          containingDirectory: containingDirectory,
          signature: this.formatEnhancedSignature(node, fileContent),
          docBlock: docBlock,
          decorators: options.includeDecorators ? this.extractDecorators(node as TSESTree.ClassDeclaration | TSESTree.MethodDefinition) : undefined,
          complexityScore: options.calculateComplexity ? this.calculateComplexity(node) : undefined,
        };

        const processEntity = (type: EnhancedExtractedCodeEntity['type'], name: string, extra: Partial<EnhancedExtractedCodeEntity> = {}) => {
          const fullName = `${context.fullNamePrefix}::${name}`;
          entity = {
            ...baseEntity,
            type,
            name,
            fullName,
            ...extra
          } as EnhancedExtractedCodeEntity;
        };

        const isNodeExported = (node: TSESTree.Node, parent?: TSESTree.Node) => {
          if (!parent) return false;
          return parent.type === AST_NODE_TYPES.ExportNamedDeclaration ||
            parent.type === AST_NODE_TYPES.ExportDefaultDeclaration;
        };

        switch (node.type) {
          case AST_NODE_TYPES.ClassDeclaration:
            processEntity('class', node.id?.name || 'AnonymousClass', {
              isExported: isNodeExported(node, context.parent),
              implementedInterfaces: (node.implements || []).map(impl => this.typeNodeToString(impl, fileContent)),
              extendedClasses: node.superClass ? [this.typeNodeToString(node.superClass, fileContent)] : [],
              genericTypes: this.extractGenericTypes(node.typeParameters, fileContent),
              accessModifier: 'public',
              isStatic: false,
              isReadonly: false,
              calls: this.extractCalls(node.body),
            });
            break;

          case AST_NODE_TYPES.FunctionDeclaration:
          case AST_NODE_TYPES.FunctionExpression:
            if (node.id) {
              processEntity('function', node.id.name, {
                isExported: isNodeExported(node, context.parent),
                isAsync: node.async,
                parameters: this.extractParameters(node.params, fileContent),
                returnTypeInfo: this.parseTypeFromNode(node.returnType?.typeAnnotation, fileContent),
                genericTypes: this.extractGenericTypes(node.typeParameters, fileContent),
                calls: this.extractCalls(node.body),
              });
            }
            break;

          case AST_NODE_TYPES.ArrowFunctionExpression:
            if (context.parent?.type === AST_NODE_TYPES.VariableDeclarator && context.parent.id.type === AST_NODE_TYPES.Identifier) {
              processEntity('function', context.parent.id.name, {
                isExported: isNodeExported(context.parent, context.parent?.parent),
                isAsync: node.async,
                parameters: this.extractParameters(node.params, fileContent),
                returnTypeInfo: this.parseTypeFromNode(node.returnType?.typeAnnotation, fileContent),
                genericTypes: this.extractGenericTypes(node.typeParameters, fileContent),
                calls: this.extractCalls(node.body),
              });
            }
            break;

          case AST_NODE_TYPES.MethodDefinition:
            processEntity('method', this.getIdentifierName(node.key), {
              parentClass: context.className,
              isStatic: node.static,
              isAsync: node.value.async,
              parameters: this.extractParameters(node.value.params, fileContent),
              returnTypeInfo: this.parseTypeFromNode(node.value.returnType?.typeAnnotation, fileContent),
              accessModifier: node.accessibility,
              calls: this.extractCalls(node.value.body),
            });
            break;

          case AST_NODE_TYPES.TSInterfaceDeclaration:
            processEntity('interface', node.id.name, {
              isExported: isNodeExported(node, context.parent),
              extendedInterfaces: (node.extends || []).map(ext => this.typeNodeToString(ext, fileContent)),
              genericTypes: this.extractGenericTypes(node.typeParameters, fileContent),
            });
            break;

          case AST_NODE_TYPES.TSTypeAliasDeclaration:
            processEntity('type_alias', node.id.name, {
              isExported: isNodeExported(node, context.parent),
              genericTypes: this.extractGenericTypes(node.typeParameters, fileContent),
              typeInfo: this.parseTypeFromNode(node.typeAnnotation, fileContent),
            });
            break;

          case AST_NODE_TYPES.TSEnumDeclaration:
            processEntity('enum', node.id.name, {
              isExported: isNodeExported(node, context.parent),
              members: node.members.map(member => this.getIdentifierName(member.id)),
              isConst: node.const || false,
            });
            break;

          case AST_NODE_TYPES.VariableDeclarator:
            if (node.id.type === AST_NODE_TYPES.Identifier) {
              const parentDeclaration = context.parent as TSESTree.VariableDeclaration | undefined;
              if (parentDeclaration) {
                processEntity('variable', node.id.name, {
                  isExported: isNodeExported(parentDeclaration, context.parent?.parent),
                  isConst: parentDeclaration?.kind === 'const',
                  isReadonly: node.id.typeAnnotation ? this.typeNodeToString(node.id.typeAnnotation, fileContent).includes('readonly') : false,
                  typeInfo: node.id.typeAnnotation ? this.parseTypeFromNode(node.id.typeAnnotation.typeAnnotation, fileContent) : undefined,
                });
              }
            }
            break;

          case AST_NODE_TYPES.PropertyDefinition:
            processEntity('property', this.getIdentifierName(node.key), {
              parentClass: context.className,
              isStatic: node.static,
              isReadonly: node.readonly || false,
              accessModifier: node.accessibility,
              typeInfo: node.typeAnnotation ? this.parseTypeFromNode(node.typeAnnotation.typeAnnotation, fileContent) : undefined,
            });
            break;
        }

        if (entity) {
          entities.push(entity);
        }

        // --- CONTEXT UPDATE & RECURSION ---
        const childContext = { ...context, parent: node };
        if (entity) {
          const e = entity as EnhancedExtractedCodeEntity;
          if (['class', 'interface', 'enum', 'function', 'method'].includes(e.type as string)) {
            childContext.fullNamePrefix = e.fullName || context.fullNamePrefix;
          }
          if (e.type === 'class') {
            childContext.className = e.name;
          }
        }

        for (const key in node) {
          if (Object.prototype.hasOwnProperty.call(node, key)) {
            const child = (node as any)[key];
            if (child && typeof child === 'object') {
              if (Array.isArray(child)) {
                child.forEach(subChild => visit(subChild, childContext));
              } else {
                visit(child, childContext);
              }
            }
          }
        }
      };

      visit(ast, { fullNamePrefix: relativeFilePath });

    } catch (error) {
      console.error(`Enhanced parser entity extraction error in ${filePath}:`, error);
    }

    return entities;
  }

  // --- START: New and Enhanced Helper Methods ---

  private typeNodeToString(node: TSESTree.Node | null | undefined, fileContent: string): string {
    if (!node || !node.range) return '';
    return fileContent.substring(node.range[0], node.range[1]);
  }

  private parseTypeFromNode(typeNode: TSESTree.TypeNode | null | undefined, fileContent: string): EnhancedTypeInfo | undefined {
    if (!typeNode) return undefined;

    const raw = this.typeNodeToString(typeNode, fileContent);
    let name = raw;
    const baseInfo = {
      raw,
      name,
      isNullable: false,
      isOptional: false,
      isArray: false,
      isFunction: false,
      isPromise: false,
    };

    if (typeNode.type === AST_NODE_TYPES.TSUnionType) {
      const unionTypes = typeNode.types.map(t => this.parseTypeFromNode(t, fileContent)).filter((t): t is EnhancedTypeInfo => !!t);
      const isNullable = unionTypes.some(t => t.name === 'null' || t.name === 'undefined');
      return { ...baseInfo, name: 'union', unionTypes, isNullable };
    }
    if (typeNode.type === AST_NODE_TYPES.TSIntersectionType) {
      const intersectionTypes = typeNode.types.map(t => this.parseTypeFromNode(t, fileContent)).filter((t): t is EnhancedTypeInfo => !!t);
      return { ...baseInfo, name: 'intersection', intersectionTypes };
    }
    if (typeNode.type === AST_NODE_TYPES.TSArrayType) {
      const elementType = this.parseTypeFromNode(typeNode.elementType, fileContent);
      return { ...baseInfo, name: elementType?.name || 'any', isArray: true, genericArgs: elementType ? [elementType] : [] };
    }
    if (typeNode.type === AST_NODE_TYPES.TSFunctionType) {
      const params = this.extractParameters(typeNode.params, fileContent);
      const returnType = this.parseTypeFromNode(typeNode.returnType?.typeAnnotation, fileContent);
      return { ...baseInfo, name: 'function', isFunction: true, functionSignature: { params, returnType: returnType! } };
    }
    if (typeNode.type === AST_NODE_TYPES.TSTypeReference) {
      name = this.getIdentifierName(typeNode.typeName);
      const genericArgs = (typeNode as any).typeParameters ? (typeNode as any).typeParameters.params.map((p: any) => this.parseTypeFromNode(p, fileContent)).filter((p: any): p is EnhancedTypeInfo => !!p) : undefined;
      return { ...baseInfo, name, isPromise: name === 'Promise', genericArgs };
    }

    // Handle keyword types
    switch (typeNode.type) {
      case AST_NODE_TYPES.TSAnyKeyword: return { ...baseInfo, name: 'any' };
      case AST_NODE_TYPES.TSStringKeyword: return { ...baseInfo, name: 'string' };
      case AST_NODE_TYPES.TSNumberKeyword: return { ...baseInfo, name: 'number' };
      case AST_NODE_TYPES.TSBooleanKeyword: return { ...baseInfo, name: 'boolean' };
      case AST_NODE_TYPES.TSVoidKeyword: return { ...baseInfo, name: 'void' };
      case AST_NODE_TYPES.TSNullKeyword: return { ...baseInfo, name: 'null', isNullable: true };
      case AST_NODE_TYPES.TSUndefinedKeyword: return { ...baseInfo, name: 'undefined', isNullable: true };
      case AST_NODE_TYPES.TSNeverKeyword: return { ...baseInfo, name: 'never' };
      case AST_NODE_TYPES.TSUnknownKeyword: return { ...baseInfo, name: 'unknown' };
      case AST_NODE_TYPES.TSSymbolKeyword: return { ...baseInfo, name: 'symbol' };
      case AST_NODE_TYPES.TSObjectKeyword: return { ...baseInfo, name: 'object' };
    }

    return { ...baseInfo, name: this.typeNodeToString(typeNode, fileContent) };
  }

  private extractParameters(params: TSESTree.Parameter[], fileContent: string): EnhancedParameterInfo[] {
    return params.map(param => {
      let name = '';
      let typeAnnotation: TSESTree.TypeNode | undefined;
      let optional = false;
      let isRest = false;
      let defaultValue: string | undefined;

      if (param.type === AST_NODE_TYPES.Identifier) {
        name = param.name;
        typeAnnotation = param.typeAnnotation?.typeAnnotation;
        optional = param.optional || false;
      } else if (param.type === AST_NODE_TYPES.AssignmentPattern) {
        if (param.left.type === AST_NODE_TYPES.Identifier) {
          name = param.left.name;
          typeAnnotation = param.left.typeAnnotation?.typeAnnotation;
          optional = true;
          defaultValue = this.typeNodeToString(param.right, fileContent);
        }
      } else if (param.type === AST_NODE_TYPES.RestElement) {
        if (param.argument.type === AST_NODE_TYPES.Identifier) {
          name = param.argument.name;
          typeAnnotation = param.argument.typeAnnotation?.typeAnnotation;
          isRest = true;
        }
      }

      return {
        name,
        typeInfo: this.parseTypeFromNode(typeAnnotation, fileContent),
        isOptional: optional,
        isRest: isRest,
        defaultValue,
      };
    });
  }

  private parseJSDoc(node: TSESTree.Node): DocBlock | undefined {
    const comments = (node as any).leadingComments;
    if (!comments || comments.length === 0) return undefined;

    const jsdocComment = comments.find((c: TSESTree.Comment) => c.value.startsWith('*'));
    if (!jsdocComment) return undefined;

    const text = `/*${jsdocComment.value}*/`;
    const lines = text.replace('/**', '').replace('*/', '').split('\n').map(l => l.replace(/^\s*\*\s?/, '').trim());

    let summary = '';
    let description = '';
    const tags: DocBlockTag[] = [];

    let isDescription = false;
    for (const line of lines) {
      if (line.startsWith('@')) {
        isDescription = false;
        const match = line.match(/^@(\w+)\s*(?:\{([^}]+)\})?\s*([$\w]+)?\s*(.*)/);
        if (match) {
          tags.push({
            tagName: match[1],
            type: match[2],
            paramName: match[3],
            description: match[4].trim(),
          });
        }
      } else if (!summary && line) {
        summary = line;
        isDescription = true;
      } else if (isDescription) {
        description += ` ${line}`;
      }
    }

    return { summary, description: description.trim(), tags };
  }

  private extractCalls(node: TSESTree.Node | null | undefined): CallInfo[] {
    const calls: CallInfo[] = [];
    if (!node) return calls;

    const visitor = (currentNode: TSESTree.Node) => {
      if (!currentNode) return;
      if (currentNode.type === AST_NODE_TYPES.CallExpression) {
        const calleeName = this.getIdentifierName(currentNode.callee);
        if (calleeName) {
          calls.push({
            name: calleeName.split('.').pop() || calleeName,
            callee: calleeName,
            isNew: false
          });
        }
      } else if (currentNode.type === AST_NODE_TYPES.NewExpression) {
        const calleeName = this.getIdentifierName(currentNode.callee);
        if (calleeName) {
          calls.push({
            name: calleeName,
            callee: calleeName,
            isNew: true
          });
        }
      }
      for (const key in currentNode) {
        if (Object.prototype.hasOwnProperty.call(currentNode, key)) {
          const child = (currentNode as any)[key];
          if (child && typeof child === 'object') {
            if (Array.isArray(child)) child.forEach(visitor);
            else visitor(child);
          }
        }
      }
    };

    visitor(node);
    return calls;
  }

  private getIdentifierName(node: TSESTree.Node | null | undefined): string {
    if (!node) return '';
    switch (node.type) {
      case AST_NODE_TYPES.Identifier: return node.name;
      case AST_NODE_TYPES.MemberExpression: 
        return `${this.getIdentifierName(node.object)}.${this.getIdentifierName(node.property)}`;
      case AST_NODE_TYPES.ThisExpression: return 'this';
      case AST_NODE_TYPES.Super: return 'super';
      case AST_NODE_TYPES.CallExpression: return this.getIdentifierName(node.callee);
      case AST_NODE_TYPES.TSQualifiedName: 
        return `${this.getIdentifierName(node.left)}.${this.getIdentifierName(node.right)}`;
      default: return '';
    }
  }

  private calculateComplexity(node: any): number {
    let complexity = 1;
    const visitor = (n: any) => {
      if (!n || typeof n !== 'object') return;
      switch (n.type) {
        case AST_NODE_TYPES.IfStatement:
        case AST_NODE_TYPES.ConditionalExpression:
        case AST_NODE_TYPES.SwitchCase:
        case AST_NODE_TYPES.ForStatement:
        case AST_NODE_TYPES.ForInStatement:
        case AST_NODE_TYPES.ForOfStatement:
        case AST_NODE_TYPES.WhileStatement:
        case AST_NODE_TYPES.DoWhileStatement:
        case AST_NODE_TYPES.CatchClause:
          complexity++;
          break;
        case AST_NODE_TYPES.LogicalExpression:
          if (n.operator === '&&' || n.operator === '||' || n.operator === '??') {
            complexity++;
          }
          break;
      }
      for (const key in n) {
        if (Object.prototype.hasOwnProperty.call(n, key)) {
          const child = n[key];
          if (child && typeof child === 'object') {
            if (Array.isArray(child)) child.forEach(visitor);
            else visitor(child);
          }
        }
      }
    };
    visitor(node);
    return complexity;
  }

  private extractDecorators(node: TSESTree.ClassDeclaration | TSESTree.MethodDefinition): string[] {
    return node.decorators?.map((decorator) => {
      if (decorator.expression.type === AST_NODE_TYPES.CallExpression) {
        return this.getIdentifierName(decorator.expression.callee);
      }
      return this.getIdentifierName(decorator.expression);
    }) || [];
  }

  private extractGenericTypes(node: TSESTree.TSTypeParameterDeclaration | undefined, fileContent: string): string[] {
    if (!node) return [];
    return node.params.map(p => this.typeNodeToString(p, fileContent));
  }

  private extractAccessModifier(node: TSESTree.MethodDefinition | TSESTree.PropertyDefinition): 'public' | 'private' | 'protected' {
    return node.accessibility || 'public';
  }

  private formatEnhancedSignature(node: TSESTree.Node, fileContent: string): string {
    if (!node.range) return this.getIdentifierName(node as any) || '';

    try {
      const start = node.range[0];
      let end = node.range[1];

      const bodyNode = (node as any).body;
      if (bodyNode) {
        // Get signature up to the opening brace of the body
        end = bodyNode.range[0];
      }

      return fileContent.substring(start, end).replace(/\s*{?$/, '').trim();
    } catch (e) {
      return this.getIdentifierName(node as any) || '';
    }
  }

  clearCache(): void {
    this.cache.clear();
    this.importCache.clear();
  }

  getCacheStats(): { cacheSize: number; importCacheSize: number } {
    return {
      cacheSize: this.cache.size,
      importCacheSize: this.importCache.size,
    };
  }

  private determineImportType(source: string, filePath: string): 'module' | 'file' {
    if (source.startsWith('.') || path.isAbsolute(source)) {
      return 'file';
    }
    return 'module';
  }

  private resolveImportPath(source: string, filePath: string): string {
    if (source.startsWith('.')) {
      const dir = path.dirname(filePath);
      return path.resolve(dir, source);
    }
    return source;
  }
}
