// CSS and Tailwind CSS parser module
import { BaseLanguageParser } from './ILanguageParser.js';
import { ExtractedImport, ExtractedCodeEntity } from '../services/CodebaseIntrospectionService.js';
import postcss, { AtRule, Rule } from 'postcss';
import path from 'path';


export class CSSParser extends BaseLanguageParser {
    getSupportedExtensions(): string[] {
        return ['.css', '.scss', '.less'];
    }
    getLanguageName(): string {
        return 'css';
    }

    async parseImports(filePath: string, fileContent: string): Promise<ExtractedImport[]> {
        const imports: ExtractedImport[] = [];
        const fileDir = path.dirname(filePath);
        try {
            const root = postcss.parse(fileContent, { from: filePath });
            root.walkAtRules('import', (rule: AtRule) => {
                const rawValue = rule.params.trim();
                let targetPath = rawValue.replace(/url\(|\)|'|"/g, '').trim();
                
                // Resolve the path relative to the current file
                const resolvedPath = path.resolve(fileDir, targetPath);

                imports.push({
                    type: 'file',
                    targetPath: resolvedPath,
                    originalImportString: rule.toString(),
                    importedSymbols: [],
                    isDynamicImport: true,
                    isTypeOnlyImport: false,
                    startLine: rule.source?.start?.line || 0,
                    endLine: rule.source?.end?.line || 0,
                });
            });
        } catch (error) {
            console.error(`Error parsing CSS imports in ${filePath}:`, error);
        }
        return imports;
    }

    async parseCodeEntities(filePath: string, fileContent: string, projectRootPath: string): Promise<ExtractedCodeEntity[]> {
        const entities: ExtractedCodeEntity[] = [];
        const absoluteFilePath = path.resolve(filePath).replace(/\\/g, '/');
        const relativeFilePath = path.relative(projectRootPath, filePath).replace(/\\/g, '/');
        const containingDirectory = path.dirname(relativeFilePath).replace(/\\/g, '/');

        try {
            const root = postcss.parse(fileContent, { from: filePath });

            root.walkRules((rule: Rule) => {
                if (rule.selector) {
                    const properties: { [key: string]: string } = {};
                    rule.walkDecls(decl => {
                        properties[decl.prop] = decl.value;
                    });

                    rule.selectors.forEach((selectorString: string) => {
                        const trimmedSelector = selectorString.trim();
                        if (!trimmedSelector) return;
                        
                        const entityType = trimmedSelector.startsWith('#') ? 'variable' : 'property';

                        entities.push({
                            type: entityType,
                            name: trimmedSelector,
                            fullName: `${relativeFilePath}::${trimmedSelector}`,
                            startLine: rule.source?.start?.line || 0,
                            endLine: rule.source?.end?.line || 0,
                            filePath: absoluteFilePath,
                            containingDirectory,
                            signature: `${trimmedSelector} { ... }`,
                            isExported: true,
                            metadata: {
                                properties: properties,
                                parent: rule.parent?.type === 'atrule' ? (rule.parent as AtRule).name : 'root'
                            }
                        });
                    });
                }
            });

            root.walkAtRules(/keyframes|media|supports$/, (rule: AtRule) => {
                 entities.push({
                    type: 'function',
                    name: `@${rule.name} ${rule.params}`,
                    fullName: `${relativeFilePath}::@${rule.name}::${rule.params}`,
                    startLine: rule.source?.start?.line || 0,
                    endLine: rule.source?.end?.line || 0,
                    filePath: absoluteFilePath,
                    containingDirectory,
                    signature: `@${rule.name} ${rule.params} { ... }`,
                    isExported: true,
                    metadata: {
                        params: rule.params
                    }
                });
            });

        } catch (error) {
            console.error(`Error parsing CSS code entities in ${filePath}:`, error);
        }
        return entities;
    }
}
