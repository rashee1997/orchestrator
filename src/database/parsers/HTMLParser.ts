// HTML parser module
import { BaseLanguageParser } from './ILanguageParser.js';
import { ExtractedImport, ExtractedCodeEntity } from '../services/CodebaseIntrospectionService.js';
import { parseDocument } from 'htmlparser2';

export class HTMLParser extends BaseLanguageParser {
    getSupportedExtensions(): string[] {
        return ['.html'];
    }
    getLanguageName(): string {
        return 'html';
    }

    async parseImports(filePath: string, fileContent: string): Promise<ExtractedImport[]> {
        // HTML does not have traditional imports, but we can extract <script src="..."> and <link href="...">
        const imports: ExtractedImport[] = [];
        try {
            const doc = parseDocument(fileContent);
            const traverse = (node: any) => {
                if (!node) return;
                if (node.type === 'tag') {
                    if (node.name === 'script' && node.attribs && node.attribs.src) {
                        imports.push({
                            type: 'file',
                            targetPath: node.attribs.src,
                            originalImportString: `<script src=\"${node.attribs.src}\">`,
                            importedSymbols: [],
                            isDynamicImport: false,
                            isTypeOnlyImport: false,
                            startLine: node.startIndex || 0,
                            endLine: node.endIndex || 0,
                        });
                    } else if (node.name === 'link' && node.attribs && node.attribs.href) {
                        imports.push({
                            type: 'file',
                            targetPath: node.attribs.href,
                            originalImportString: `<link href=\"${node.attribs.href}\">`,
                            importedSymbols: [],
                            isDynamicImport: false,
                            isTypeOnlyImport: false,
                            startLine: node.startIndex || 0,
                            endLine: node.endIndex || 0,
                        });
                    }
                }
                if (node.children) {
                    node.children.forEach(traverse);
                }
            };
            traverse(doc);
        } catch (error) {
            console.error(`Error parsing HTML imports in ${filePath}:`, error);
        }
        return imports;
    }

    async parseCodeEntities(filePath: string, fileContent: string, projectRootPath: string): Promise<ExtractedCodeEntity[]> {
        // For HTML, treat each tag as an entity, and extract id/class as name
        const entities: ExtractedCodeEntity[] = [];
        const relativeFilePath = this.getRelativeFilePath(filePath);
        try {
            const doc = parseDocument(fileContent);
            const traverse = (node: any, parent: any = null) => {
                if (!node) return;
                if (node.type === 'tag') {
                    const name = node.attribs && node.attribs.id ? node.attribs.id : (node.attribs && node.attribs.class ? node.attribs.class : node.name);
                    entities.push({
                        type: 'property',
                        name: name,
                        fullName: `${relativeFilePath}::${name}`,
                        startLine: node.startIndex || 0,
                        endLine: node.endIndex || 0,
                        docstring: null,
                        filePath: relativeFilePath,
                        className: node.name,
                        isExported: false,
                    });
                }
                if (node.children) {
                    node.children.forEach((child: any) => traverse(child, node));
                }
            };
            traverse(doc);
        } catch (error) {
            console.error(`Error parsing HTML code entities in ${filePath}:`, error);
        }
        return entities;
    }
}
