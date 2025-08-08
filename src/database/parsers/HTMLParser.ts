// HTML parser module
import { BaseLanguageParser } from './ILanguageParser.js';
import { ExtractedImport, ExtractedCodeEntity } from '../services/CodebaseIntrospectionService.js';
import { parseDocument } from 'htmlparser2';
import * as DomHandler from 'domhandler';
import * as DomUtils from 'domutils';
import path from 'path';
import { EnhancedTypeScriptParser } from './EnhancedTypeScriptParser.js';
import { CSSParser } from './CSSParser.js'; // Import CSSParser

export class HTMLParser extends BaseLanguageParser {
    private tsParser: EnhancedTypeScriptParser;
    private cssParser: CSSParser;

    constructor(projectRootPath: string = process.cwd()) {
        super(projectRootPath);
    this.tsParser = new EnhancedTypeScriptParser(projectRootPath);
        this.cssParser = new CSSParser(projectRootPath);
    }

    getSupportedExtensions(): string[] {
        return ['.html', '.htm'];
    }
    getLanguageName(): string {
        return 'html';
    }

    private getLineAndColumn(content: string, index: number): { line: number, column: number } {
        const textUpToIndex = content.substring(0, index);
        const lines = textUpToIndex.split('\n');
        const line = lines.length;
        const column = lines[lines.length - 1].length + 1;
        return { line, column };
    }

    async parseImports(filePath: string, fileContent: string): Promise<ExtractedImport[]> {
        const imports: ExtractedImport[] = [];
        const fileDir = path.dirname(filePath);
        try {
            const dom = parseDocument(fileContent, { withStartIndices: true, withEndIndices: true });
            const links = DomUtils.filter(elem => elem.type === 'tag' && elem.tagName === 'link' && !!elem.attribs.href, dom.children);
            const scripts = DomUtils.filter(elem => elem.type === 'tag' && elem.tagName === 'script' && !!elem.attribs.src, dom.children);

            for (const link of links) {
                const node = link as DomHandler.Element;
                const start = this.getLineAndColumn(fileContent, node.startIndex!);
                const end = this.getLineAndColumn(fileContent, node.endIndex!);
                imports.push({
                    type: 'file',
                    targetPath: path.resolve(fileDir, node.attribs.href),
                    originalImportString: fileContent.substring(node.startIndex!, node.endIndex! + 1),
                    importedSymbols: [node.attribs.rel || 'stylesheet'],
                    isDynamicImport: false,
                    isTypeOnlyImport: false,
                    startLine: start.line,
                    endLine: end.line,
                });
            }

            for (const script of scripts) {
                const node = script as DomHandler.Element;
                const start = this.getLineAndColumn(fileContent, node.startIndex!);
                const end = this.getLineAndColumn(fileContent, node.endIndex!);
                imports.push({
                    type: 'file',
                    targetPath: path.resolve(fileDir, node.attribs.src),
                    originalImportString: fileContent.substring(node.startIndex!, node.endIndex! + 1),
                    importedSymbols: [],
                    isDynamicImport: !!node.attribs.async || !!node.attribs.defer,
                    isTypeOnlyImport: false,
                    startLine: start.line,
                    endLine: end.line,
                });
            }

        } catch (error) {
            console.error(`Error parsing HTML imports in ${filePath}:`, error);
        }
        return imports;
    }

    private getElementSignature(node: DomHandler.Element): string {
        let signature = `<${node.tagName}`;
        for (const [key, value] of Object.entries(node.attribs)) {
            signature += ` ${key}="${value}"`;
        }
        return signature + '>';
    }

    async parseCodeEntities(filePath: string, fileContent: string, projectRootPath: string): Promise<ExtractedCodeEntity[]> {
        const entities: ExtractedCodeEntity[] = [];
        const absoluteFilePath = path.resolve(filePath).replace(/\\/g, '/');
        const relativeFilePath = path.relative(projectRootPath, filePath).replace(/\\/g, '/');
        const containingDirectory = path.dirname(relativeFilePath).replace(/\\/g, '/');
        
        try {
            const dom = parseDocument(fileContent, { withStartIndices: true, withEndIndices: true });

            const traverse = async (nodes: DomHandler.Node[], parent: DomHandler.Element | null = null) => { // Added async here
                for (const node of nodes) {
                    if (node.type === 'tag') {
                        const element = node as DomHandler.Element;
                        const start = this.getLineAndColumn(fileContent, element.startIndex!);
                        const end = this.getLineAndColumn(fileContent, element.endIndex!);

                        // Create an entity for any tag that has an ID, class, or name
                        if (element.attribs.id || element.attribs.class || element.attribs.name) {
                            const name = element.attribs.id || element.attribs.name || element.attribs.class.split(' ')[0];
                            const entityType = element.attribs.id ? 'variable' : (element.attribs.name ? 'variable' : 'property');
                            
                            entities.push({
                                type: entityType,
                                name: name,
                                fullName: `${relativeFilePath}#${element.attribs.id || element.attribs.name || '.' + element.attribs.class.split(' ')[0]}`,
                                startLine: start.line,
                                endLine: end.line,
                                filePath: absoluteFilePath,
                                containingDirectory,
                                signature: this.getElementSignature(element),
                                isExported: false,
                                parentClass: parent ? parent.tagName : null,
                                metadata: {
                                    attributes: element.attribs
                                }
                            });
                        }
                        
                        // Recursively traverse children
                        if (element.children && Array.isArray(element.children)) {
                            await traverse(element.children, element); // Await recursive call
                        }
                    } else if (node.type === 'script') {
                        const element = node as DomHandler.Element;
                        const start = this.getLineAndColumn(fileContent, element.startIndex!);
                        const end = this.getLineAndColumn(fileContent, element.endIndex!);
                        if (element.children && element.children.length > 0) {
                            const scriptContent = (element.children[0] as DomHandler.Text).data;
                            if (scriptContent.trim()) {
                                // Parse inline JavaScript using TypeScriptParser
                                const jsEntities = await this.tsParser.parseCodeEntities(filePath, scriptContent, projectRootPath);
                                jsEntities.forEach(jsEntity => {
                                    // Adjust line numbers to be relative to the HTML file
                                    jsEntity.startLine += start.line - 1;
                                    jsEntity.endLine += start.line - 1;
                                    entities.push(jsEntity);
                                });
                            }
                        }
                    } else if (node.type === 'style') {
                        const element = node as DomHandler.Element;
                        const start = this.getLineAndColumn(fileContent, element.startIndex!);
                        const end = this.getLineAndColumn(fileContent, element.endIndex!);
                        if (element.children && element.children.length > 0) {
                            const styleContent = (element.children[0] as DomHandler.Text).data;
                            if (styleContent.trim()) {
                                // Parse inline CSS using CSSParser
                                const cssEntities = await this.cssParser.parseCodeEntities(filePath, styleContent, projectRootPath);
                                cssEntities.forEach(cssEntity => {
                                    // Adjust line numbers to be relative to the HTML file
                                    cssEntity.startLine += start.line - 1;
                                    cssEntity.endLine += start.line - 1;
                                    entities.push(cssEntity);
                                });
                            }
                        }
                    } else if (node.type === 'text' || node.type === 'comment') {
                        // Ignore text and comment nodes for now, or handle as 'unknown' if needed
                    } else {
                        // Handle other unknown node types if necessary
                        const unknownNode = node as DomHandler.Node;
                        if (unknownNode.startIndex !== undefined && unknownNode.endIndex !== undefined) {
                            const start = this.getLineAndColumn(fileContent, unknownNode.startIndex!);
                            const end = this.getLineAndColumn(fileContent, unknownNode.endIndex!);
                            entities.push({
                                type: 'unknown',
                                name: `html_node_at_line_${start.line}`,
                                fullName: `${relativeFilePath}::html_node_at_line_${start.line}`,
                                startLine: start.line,
                                endLine: end.line,
                                filePath: absoluteFilePath,
                                containingDirectory,
                                signature: fileContent.substring(unknownNode.startIndex!, unknownNode.endIndex! + 1).split('\n')[0],
                                isExported: false,
                                metadata: {
                                    nodeType: unknownNode.type
                                }
                            });
                        }
                    }
                }
            };
            await traverse(dom.children); // Await the initial call to traverse
        } catch (error) {
            console.error(`Error parsing HTML code entities in ${filePath}:`, error);
        }
        return entities;
    }
}
