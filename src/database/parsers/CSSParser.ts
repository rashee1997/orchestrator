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
                    rule.selectors.forEach((selectorString: string) => {
                        const trimmedSelector = selectorString.trim();
                        if (!trimmedSelector) return;
                        
                        // Main selector entity
                        entities.push({
                            type: 'unknown', // More generic type for CSS selectors
                            name: trimmedSelector,
                            fullName: `${relativeFilePath}::${trimmedSelector}`,
                            startLine: rule.source?.start?.line || 0,
                            endLine: rule.source?.end?.line || 0,
                            filePath: absoluteFilePath,
                            containingDirectory,
                            signature: `${trimmedSelector} { ... }`,
                            isExported: true, // Consider selectors as "exported" in a CSS context
                            metadata: {
                                parent: rule.parent?.type === 'atrule' ? (rule.parent as AtRule).name : 'root',
                                type: 'css_selector'
                            }
                        });

                        // Extract individual properties as entities
                        rule.walkDecls(decl => {
                            entities.push({
                                type: 'property',
                                name: decl.prop,
                                fullName: `${relativeFilePath}::${trimmedSelector}::${decl.prop}`,
                                startLine: decl.source?.start?.line || 0,
                                endLine: decl.source?.end?.line || 0,
                                filePath: absoluteFilePath,
                                containingDirectory,
                                signature: `${decl.prop}: ${decl.value}`,
                                parentClass: trimmedSelector, // Parent is the selector
                                metadata: {
                                    value: decl.value,
                                    important: decl.important
                                }
                            });
                        });
                    });
                }
            });

            // Extract CSS variables
            root.walkDecls(decl => {
                if (decl.prop.startsWith('--')) {
                    entities.push({
                        type: 'variable',
                        name: decl.prop,
                        fullName: `${relativeFilePath}::${decl.prop}`,
                        startLine: decl.source?.start?.line || 0,
                        endLine: decl.source?.end?.line || 0,
                        filePath: absoluteFilePath,
                        containingDirectory,
                        signature: `${decl.prop}: ${decl.value}`,
                        isExported: true,
                        metadata: {
                            value: decl.value
                        }
                    });
                }
            });

            root.walkAtRules(/keyframes|media|supports$/, (rule: AtRule) => {
                 entities.push({
                    type: 'control_flow', // Changed to control_flow
                    name: `@${rule.name} ${rule.params}`,
                    fullName: `${relativeFilePath}::@${rule.name}::${rule.params}`,
                    startLine: rule.source?.start?.line || 0,
                    endLine: rule.source?.end?.line || 0,
                    filePath: absoluteFilePath,
                    containingDirectory,
                    signature: `@${rule.name} ${rule.params} { ... }`,
                    isExported: true,
                    metadata: {
                        params: rule.params,
                        type: 'css_at_rule'
                    }
                });
            });

        } catch (error) {
            console.error(`Error parsing CSS code entities in ${filePath}:`, error);
        }
        return entities;
    }
}
