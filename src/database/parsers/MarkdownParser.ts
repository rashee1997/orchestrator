import path from 'path';
import { marked } from 'marked';
import { BaseLanguageParser, ExtractedImport, ExtractedCodeEntity } from './ILanguageParser.js';

export class MarkdownParser extends BaseLanguageParser {
    constructor(projectRootPath?: string) {
        super(projectRootPath);
    }

    getSupportedExtensions(): string[] {
        return ['.md'];
    }

    getLanguageName(): string {
        return 'markdown';
    }

    async parseImports(filePath: string, fileContent: string): Promise<ExtractedImport[]> {
        const imports: ExtractedImport[] = [];
        const relativeLinkRegex = /\[.*?\]\((?!https?:\/\/)(.*?)\)/g; // Matches relative links
        let match;
        let lineNum = 1;
        for (const line of fileContent.split('\n')) {
            while ((match = relativeLinkRegex.exec(line)) !== null) {
                imports.push({
                    type: 'file', // Assuming relative links are to other files
                    targetPath: this.getRelativeFilePath(path.resolve(path.dirname(filePath), match[1])),
                    originalImportString: match[0],
                    startLine: lineNum,
                    endLine: lineNum,
                });
            }
            lineNum++;
        }
        return imports;
    }

    async parseCodeEntities(filePath: string, fileContent: string, projectRootPath: string): Promise<ExtractedCodeEntity[]> {
        const entities: ExtractedCodeEntity[] = [];
        const tokens = marked.lexer(fileContent); // Use lexer to get tokens with line numbers

        let currentLine = 1;
        for (const token of tokens) {
            const startLine = currentLine;
            const endLine = currentLine + (token.raw ? token.raw.split('\n').length - 1 : 0);

            if (token.type === 'heading') {
                entities.push({
                    type: 'function', // Treat headings as logical "sections" or "functions" for introspection
                    name: token.text,
                    fullName: token.text,
                    signature: `Heading ${token.depth}: ${token.text}`,
                    startLine: startLine,
                    endLine: endLine,
                    docstring: null, // Markdown headings don't have docstrings in the code sense
                    filePath: this.getRelativeFilePath(filePath),
                    containingDirectory: this.getRelativeFilePath(path.dirname(filePath)),
                    metadata: {
                        level: token.depth,
                    },
                });
            } else if (token.type === 'code') {
                entities.push({
                    type: 'code_block',
                    name: `Code Block (${token.lang || 'unknown'})`,
                    fullName: `Code Block (${token.lang || 'unknown'})`,
                    signature: `\`\`\`${token.lang || ''}\n${token.text.substring(0, 50)}...\n\`\`\``,
                    startLine: startLine,
                    endLine: endLine,
                    docstring: null,
                    filePath: this.getRelativeFilePath(filePath),
                    containingDirectory: this.getRelativeFilePath(path.dirname(filePath)),
                    metadata: {
                        language: token.lang,
                        codeSnippet: token.text,
                    },
                });
            }
            currentLine = endLine + 1; // Move to the next line after this token
        }
        return entities;
    }
}
