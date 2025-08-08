// HTML parser module
import { BaseLanguageParser } from './ILanguageParser.js';
import { ExtractedImport, ExtractedCodeEntity } from '../services/CodebaseIntrospectionService.js';
import { parseDocument } from 'htmlparser2';
import * as DomHandler from 'domhandler';
import * as DomUtils from 'domutils';
import path from 'path';
import { EnhancedTypeScriptParser } from './EnhancedTypeScriptParser.js';
import { CSSParser } from './CSSParser.js';
import { TailwindCSSParser } from './TailwindCSSParser.js';

export class HTMLParser extends BaseLanguageParser {
    private tsParser: EnhancedTypeScriptParser;
    private cssParser: CSSParser;
    private tailwindParser: TailwindCSSParser;

    constructor(projectRootPath: string = process.cwd()) {
        super(projectRootPath);
    this.tsParser = new EnhancedTypeScriptParser(projectRootPath);
        this.cssParser = new CSSParser(projectRootPath);
        this.tailwindParser = new TailwindCSSParser(projectRootPath);
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

            const traverse = async (nodes: DomHandler.Node[], parent: DomHandler.Element | null = null) => {
                for (const node of nodes) {
                    if (node.type === 'tag') {
                        const element = node as DomHandler.Element;
                        const start = this.getLineAndColumn(fileContent, element.startIndex!);
                        const end = this.getLineAndColumn(fileContent, element.endIndex!);

                        const isIdentified = !!(element.attribs.id || element.attribs.class || element.attribs.name);
                        const semanticTags = ['title', 'meta', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'main', 'nav', 'article', 'section', 'header', 'footer', 'form', 'button', 'input', 'textarea', 'select', 'label'];
                        const isSemantic = semanticTags.includes(element.tagName);

                        if (isIdentified || isSemantic) {
                            let name: string;
                            let entityType: ExtractedCodeEntity['type'] = 'html_element';

                            if (element.attribs.id) {
                                name = `#${element.attribs.id}`;
                                entityType = 'html_id_selector';
                            } else if (element.attribs.name) {
                                name = `[name=${element.attribs.name}]`;
                                entityType = 'html_attribute_selector';
                            } else if (element.attribs.class) {
                                name = `.${element.attribs.class.split(' ')[0]}`;
                                entityType = 'html_class_selector';
                            } else {
                                name = element.tagName;
                            }

                            const fullName = `${relativeFilePath}::${element.tagName}_at_${start.line}:${start.column}`;

                            entities.push({
                                type: entityType,
                                name: name,
                                fullName: fullName,
                                startLine: start.line,
                                endLine: end.line,
                                filePath: absoluteFilePath,
                                containingDirectory,
                                signature: this.getElementSignature(element),
                                isExported: false,
                                parentClass: parent ? parent.tagName : null,
                                metadata: {
                                    tagName: element.tagName,
                                    attributes: element.attribs
                                }
                            });
                        }

                        // If the element has a class attribute, parse it for Tailwind classes
                        if (element.attribs.class) {
                            const tailwindEntities = await this.tailwindParser.parseClassString(element.attribs.class, absoluteFilePath, start.line);
                            entities.push(...tailwindEntities);
                        }

                        if (element.children && Array.isArray(element.children)) {
                            await traverse(element.children, element);
                        }
                    } else if (node.type === 'script') {
                        const element = node as DomHandler.Element;
                        if (element.children && element.children.length > 0 && element.children[0].type === 'text') {
                            const scriptContent = (element.children[0] as DomHandler.Text).data;
                            if (scriptContent.trim()) {
                                const start = this.getLineAndColumn(fileContent, element.startIndex!);
                                const jsEntities = await this.tsParser.parseCodeEntities(filePath, scriptContent, projectRootPath);
                                jsEntities.forEach(jsEntity => {
                                    jsEntity.startLine += start.line - 1;
                                    jsEntity.endLine += start.line - 1;
                                    entities.push(jsEntity);
                                });
                            }
                        }
                    } else if (node.type === 'style') {
                        const element = node as DomHandler.Element;
                        if (element.children && element.children.length > 0 && element.children[0].type === 'text') {
                            const styleContent = (element.children[0] as DomHandler.Text).data;
                            if (styleContent.trim()) {
                                const start = this.getLineAndColumn(fileContent, element.startIndex!);
                                const cssEntities = await this.cssParser.parseCodeEntities(filePath, styleContent, projectRootPath);
                                cssEntities.forEach(cssEntity => {
                                    cssEntity.startLine += start.line - 1;
                                    cssEntity.endLine += start.line - 1;
                                    entities.push(cssEntity);
                                });
                            }
                        }
                    } else if (node.type === 'text') {
                        const textNode = node as DomHandler.Text;
                        const textContent = textNode.data.trim();
                        if (textContent && parent) {
                            const start = this.getLineAndColumn(fileContent, textNode.startIndex!);
                            const end = this.getLineAndColumn(fileContent, textNode.endIndex!);
                            entities.push({
                                type: 'html_text_content',
                                name: `text_in_<${parent.tagName}>`,
                                fullName: `${relativeFilePath}::text_at_${start.line}:${start.column}`,
                                startLine: start.line,
                                endLine: end.line,
                                filePath: absoluteFilePath,
                                containingDirectory,
                                signature: textContent.length > 100 ? textContent.substring(0, 97) + '...' : textContent,
                                isExported: false,
                                parentClass: parent.tagName,
                                metadata: {
                                    content: textContent,
                                    parentTag: parent.tagName
                                }
                            });
                        }
                    } else if (node.type === 'comment') {
                        const commentNode = node as DomHandler.Comment;
                        const commentContent = commentNode.data.trim();
                        if (commentContent) {
                            const start = this.getLineAndColumn(fileContent, commentNode.startIndex!);
                            const end = this.getLineAndColumn(fileContent, commentNode.endIndex!);
                            entities.push({
                                type: 'comment',
                                name: `html_comment_at_line_${start.line}`,
                                fullName: `${relativeFilePath}::comment_at_${start.line}:${start.column}`,
                                startLine: start.line,
                                endLine: end.line,
                                filePath: absoluteFilePath,
                                containingDirectory,
                                signature: `<!-- ${commentContent.length > 80 ? commentContent.substring(0, 77) + '...' : commentContent} -->`,
                                isExported: false,
                                parentClass: parent ? parent.tagName : null,
                                metadata: {
                                    content: commentContent
                                }
                            });
                        }
                    }
                }
            };

            await traverse(dom.children);
        } catch (error) {
            console.error(`Error parsing HTML code entities in ${filePath}:`, error);
        }
        return entities;
    }
}
