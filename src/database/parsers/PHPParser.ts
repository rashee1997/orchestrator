// PHP parser module
import { BaseLanguageParser } from './ILanguageParser.js';
import { ExtractedImport, ExtractedCodeEntity } from '../services/CodebaseIntrospectionService.js';
import phpParser from 'php-parser';

export class PHPParser extends BaseLanguageParser {
    getSupportedExtensions(): string[] {
        return ['.php'];
    }
    getLanguageName(): string {
        return 'php';
    }

    async parseImports(filePath: string, fileContent: string): Promise<ExtractedImport[]> {
        const imports: ExtractedImport[] = [];
        try {
            const parser = new phpParser.Engine({ parser: { extractDoc: true }, ast: { withPositions: true } });
            const ast = parser.parseCode(fileContent, filePath);
            const traverse = (node: any) => {
                if (!node) return;
                if (node.kind === 'usegroup' || node.kind === 'useitem') {
                    imports.push({
                        type: 'module',
                        targetPath: node.name ? node.name : '',
                        originalImportString: fileContent.substring(node.loc.start.offset, node.loc.end.offset),
                        importedSymbols: node.alias ? [node.alias] : [],
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
                        } else if (node[key].kind) {
                            traverse(node[key]);
                        }
                    }
                }
            };
            traverse(ast);
        } catch (error) {
            console.error(`Error parsing PHP imports in ${filePath}:`, error);
        }
        return imports;
    }

    async parseCodeEntities(filePath: string, fileContent: string, projectRootPath: string): Promise<ExtractedCodeEntity[]> {
        const entities: ExtractedCodeEntity[] = [];
        const relativeFilePath = this.getRelativeFilePath(filePath);
        try {
            const parser = new phpParser.Engine({ parser: { extractDoc: true }, ast: { withPositions: true } });
            const ast = parser.parseCode(fileContent, filePath);
            const traverse = (node: any, parent: any = null) => {
                if (!node) return;
                if (node.kind === 'function') {
                    entities.push({
                        type: 'function',
                        name: node.name.name,
                        fullName: `${relativeFilePath}::${node.name.name}`,
                        startLine: node.loc.start.line,
                        endLine: node.loc.end.line,
                        docstring: node.leadingComments ? node.leadingComments.map((c: any) => c.value).join('\n') : null,
                        filePath: relativeFilePath,
                        parameters: node.arguments ? node.arguments.map((p: any) => ({ name: p.name })) : [],
                        isAsync: false,
                        isExported: false,
                    });
                } else if (node.kind === 'class') {
                    entities.push({
                        type: 'class',
                        name: node.name.name,
                        fullName: `${relativeFilePath}::${node.name.name}`,
                        startLine: node.loc.start.line,
                        endLine: node.loc.end.line,
                        docstring: node.leadingComments ? node.leadingComments.map((c: any) => c.value).join('\n') : null,
                        filePath: relativeFilePath,
                        parentClass: node.extends ? node.extends.name : null,
                        isExported: false,
                    });
                }
                for (const key in node) {
                    if (node[key] && typeof node[key] === 'object') {
                        if (Array.isArray(node[key])) {
                            node[key].forEach((child: any) => traverse(child, node));
                        } else if (node[key].kind) {
                            traverse(node[key], node);
                        }
                    }
                }
            };
            traverse(ast);
        } catch (error) {
            console.error(`Error parsing PHP code entities in ${filePath}:`, error);
        }
        return entities;
    }
}
