import path from 'path';
// Base interface for all language parsers
import { ExtractedImport, ExtractedCodeEntity } from '../services/CodebaseIntrospectionService.js';

export type { ExtractedImport, ExtractedCodeEntity };

export interface ILanguageParser {
    /**
     * Parse a file for import statements
     */
    parseImports(filePath: string, fileContent: string): Promise<ExtractedImport[]>;
    
    /**
     * Parse a file for code entities (functions, classes, etc.)
     */
    parseCodeEntities(filePath: string, fileContent: string, projectRootPath: string): Promise<ExtractedCodeEntity[]>;
    
    /**
     * Get supported file extensions for this parser
     */
    getSupportedExtensions(): string[];
    
    /**
     * Get the language name
     */
    getLanguageName(): string;
}

export abstract class BaseLanguageParser implements ILanguageParser {
    protected projectRootPath: string;

    constructor(projectRootPath: string = process.cwd()) {
        this.projectRootPath = projectRootPath;
    }

    abstract parseImports(filePath: string, fileContent: string): Promise<ExtractedImport[]>;
    abstract parseCodeEntities(filePath: string, fileContent: string, projectRootPath: string): Promise<ExtractedCodeEntity[]>;
    abstract getSupportedExtensions(): string[];
    abstract getLanguageName(): string;

    /**
     * Helper to get relative file path
     */
    protected getRelativeFilePath(filePath: string): string {
        // Use ES module import for path
        // Import path at top level instead of require here
        // So we will import path at the top and use it here
        return path.relative(this.projectRootPath, filePath).replace(/\\/g, '/');
    }

    /**
     * Helper to extract docstring/comments before a node
     */
    protected extractDocstring(fileContent: string, startOffset: number): string | null {
        const lines = fileContent.substring(0, startOffset).split('\n');
        const commentLines: string[] = [];
        
        // Look backwards for comment lines
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (line.startsWith('#') || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) {
                commentLines.unshift(line);
            } else if (line.length > 0) {
                break;
            }
        }
        
        return commentLines.length > 0 ? commentLines.join('\n') : null;
    }
}