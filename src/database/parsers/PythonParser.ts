// Python parser module
import { BaseLanguageParser } from './ILanguageParser.js';
import { ExtractedImport, ExtractedCodeEntity } from '../services/CodebaseIntrospectionService.js';
import filbert from 'filbert';

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
            const ast = filbert.parse(fileContent, { locations: true });
            const traverse = (node: any) => {
                if (!node) return;
                if (node.type === 'ImportDeclaration' || node.type === 'ImportFromDeclaration') {
                    imports.push({
                        type: 'module',
                        targetPath: node.module || node.from || '',
                        originalImportString: fileContent.substring(node.range[0], node.range[1]),
                        importedSymbols: node.specifiers ? node.specifiers.map((s: any) => s.local.name) : [],
                        isDynamicImport: false,
                        isTypeOnlyImport: false,
                        startLine: node.loc.start.line,
                        endLine: node.loc.end.line,
                    });
                }
                for (const key in node) {
                    if (node[key] && typeof node[key] === 'object') {
                        if (Array.isArray(node[key])) {
                            node[key].forEach(traverse);
                        } else if (node[key].type) {
                            traverse(node[key]);
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

    async parseCodeEntities(filePath: string, fileContent: string, projectRootPath: string): Promise<ExtractedCodeEntity[]> {
        const entities: ExtractedCodeEntity[] = [];
        const relativeFilePath = this.getRelativeFilePath(filePath);
        try {
            const ast = filbert.parse(fileContent, { locations: true });
            const traverse = (node: any, parent: any = null) => {
                if (!node) return;
                if (node.type === 'FunctionDeclaration') {
                    entities.push({
                        type: 'function',
                        name: node.id?.name ?? 'unknown',
                        fullName: `${relativeFilePath}::${node.id?.name ?? 'unknown'}`,
                        startLine: node.loc?.start?.line ?? 0,
                        endLine: node.loc?.end?.line ?? 0,
                        docstring: this.extractDocstring(fileContent, node.range ? node.range[0] : 0),
                        filePath: relativeFilePath,
                        parameters: node.params ? node.params.map((p: any) => ({ name: p.name })) : [],
                        isAsync: false,
                        isExported: false,
                    });
                } else if (node.type === 'ClassDeclaration') {
                    entities.push({
                        type: 'class',
                        name: node.id?.name ?? 'unknown',
                        fullName: `${relativeFilePath}::${node.id?.name ?? 'unknown'}`,
                        startLine: node.loc?.start?.line ?? 0,
                        endLine: node.loc?.end?.line ?? 0,
                        docstring: this.extractDocstring(fileContent, node.range ? node.range[0] : 0),
                        filePath: relativeFilePath,
                        parentClass: node.superClass ? node.superClass.name : null,
                        isExported: false,
                    });
                }
                for (const key in node) {
                    if (node[key] && typeof node[key] === 'object') {
                        if (Array.isArray(node[key])) {
                            node[key].forEach((child: any) => traverse(child, node));
                        } else if (node[key].type) {
                            traverse(node[key], node);
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
