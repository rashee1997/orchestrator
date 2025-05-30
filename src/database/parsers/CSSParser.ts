// CSS and Tailwind CSS parser module
import { BaseLanguageParser } from './ILanguageParser.js';
import { ExtractedImport, ExtractedCodeEntity } from '../services/CodebaseIntrospectionService.js';
import postcss from 'postcss';
import * as csstree from 'css-tree';

export class CSSParser extends BaseLanguageParser {
    getSupportedExtensions(): string[] {
        return ['.css', '.scss', '.less'];
    }
    getLanguageName(): string {
        return 'css';
    }

    async parseImports(filePath: string, fileContent: string): Promise<ExtractedImport[]> {
        // CSS @import rules
        const imports: ExtractedImport[] = [];
        try {
            const ast = csstree.parse(fileContent, { positions: true });
            csstree.walk(ast, (node: any) => {
                if (node.type === 'Atrule' && node.name === 'import' && node.prelude && node.prelude.value) {
                    imports.push({
                        type: 'file',
                        targetPath: node.prelude.value.replace(/['";]/g, ''),
                        originalImportString: fileContent.substring(node.loc.start.offset, node.loc.end.offset),
                        importedSymbols: [],
                        isDynamicImport: false,
                        isTypeOnlyImport: false,
                        startLine: node.loc.start.line,
                        endLine: node.loc.end.line,
                    });
                }
            });
        } catch (error) {
            console.error(`Error parsing CSS imports in ${filePath}:`, error);
        }
        return imports;
    }

    async parseCodeEntities(filePath: string, fileContent: string, projectRootPath: string): Promise<ExtractedCodeEntity[]> {
        // Extract CSS classes, ids, and Tailwind utility classes
        const entities: ExtractedCodeEntity[] = [];
        const relativeFilePath = this.getRelativeFilePath(filePath);
        try {
            const root = postcss.parse(fileContent);
            root.walkRules((rule: any) => {
                if (rule.selector) {
                    // Split selectors by comma
                    rule.selector.split(',').forEach((sel: string) => {
                        sel = sel.trim();
                        if (sel.startsWith('.')) {
                            // CSS class or Tailwind utility
                            entities.push({
                                type: 'property',
                                name: sel,
                                fullName: `${relativeFilePath}::${sel}`,
                                startLine: rule.source.start.line,
                                endLine: rule.source.end.line,
                                docstring: null,
                                filePath: relativeFilePath,
                                className: undefined,
                                isExported: false,
                            });
                        } else if (sel.startsWith('#')) {
                            // CSS id
                            entities.push({
                                type: 'property',
                                name: sel,
                                fullName: `${relativeFilePath}::${sel}`,
                                startLine: rule.source.start.line,
                                endLine: rule.source.end.line,
                                docstring: null,
                                filePath: relativeFilePath,
                                className: undefined,
                                isExported: false,
                            });
                        }
                    });
                }
            });
        } catch (error) {
            console.error(`Error parsing CSS code entities in ${filePath}:`, error);
        }
        return entities;
    }
}
