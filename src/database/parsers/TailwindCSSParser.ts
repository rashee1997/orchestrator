// src/database/parsers/TailwindCSSParser.ts
import { BaseLanguageParser } from './ILanguageParser.js';
import { ExtractedCodeEntity, ExtractedImport } from '../services/CodebaseIntrospectionService.js';
import path from 'path';

/**
 * A specialized parser for extracting Tailwind CSS utility classes from HTML/TSX/JSX class attributes.
 * This parser doesn't handle full CSS files but is designed to be called by other parsers.
 */
export class TailwindCSSParser extends BaseLanguageParser {
    constructor(projectRootPath: string = process.cwd()) {
        super(projectRootPath);
    }

    // This parser is not meant to handle standalone files, so these methods might not be used.
    getSupportedExtensions(): string[] {
        return []; // Not applicable for direct file parsing
    }

    getLanguageName(): string {
        return 'tailwindcss';
    }

    // We won't be parsing imports from class strings.
    async parseImports(filePath: string, fileContent: string): Promise<ExtractedImport[]> {
        return [];
    }
    
    /**
     * Parses a string of CSS classes and extracts Tailwind utility classes as code entities.
     * @param classString The full string from the 'class' attribute.
     * @param sourceFilePath The path of the file containing the class string.
     * @param startLine The line number where the owning element starts.
     * @returns A promise that resolves to an array of extracted code entities.
     */
    public async parseClassString(classString: string, sourceFilePath: string, startLine: number): Promise<ExtractedCodeEntity[]> {
        const entities: ExtractedCodeEntity[] = [];
        const classes = [...new Set(classString.split(/\s+/).filter(Boolean))];
        const projectRootPath = this.projectRootPath;
        const relativeFilePath = path.relative(projectRootPath, sourceFilePath).replace(/\\/g, '/');
        const containingDirectory = path.dirname(relativeFilePath).replace(/\\/g, '/');
        
        for (const cls of classes) {
            // Basic heuristic: We can expand this with a known list of Tailwind prefixes later.
            // For now, we'll assume any class could be a utility class.
            entities.push({
                type: 'tailwind_utility_class',
                name: cls,
                fullName: `${relativeFilePath}::class:${cls}:${startLine}`,
                startLine: startLine,
                endLine: startLine,
                filePath: sourceFilePath,
                containingDirectory,
                signature: cls,
                isExported: false,
                metadata: {
                    source: 'html_class_attribute'
                }
            });
        }
        
        return entities;
    }

    // This is the standard entry point, but for Tailwind, we'll primarily use parseClassString.
    async parseCodeEntities(filePath: string, fileContent: string): Promise<ExtractedCodeEntity[]> {
        // This method could be implemented to find all class="..." strings in a file,
        // but for now, we'll rely on other parsers (like HTMLParser) to feed us the class strings.
        console.warn('TailwindCSSParser.parseCodeEntities is not intended for direct use. Use parseClassString instead.');
        return [];
    }
}