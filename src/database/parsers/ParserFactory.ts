// File: src/database/parsers/ParserFactory.ts
import { ILanguageParser } from './ILanguageParser.js';

// Re-export ILanguageParser for other modules
export type { ILanguageParser };
import { EnhancedTypeScriptParser } from './EnhancedTypeScriptParser.js';
import { PythonParser } from './PythonParser.js';
import { HTMLParser } from './HTMLParser.js';
import { CSSParser } from './CSSParser.js';
import { EnhancedPHPParser } from './EnhancedPHPParser.js';
import { JSONLParser } from './JSONLParser.js';
import { MarkdownParser } from './MarkdownParser.js';
import { TailwindCSSParser } from './TailwindCSSParser.js';
import { SQLParser } from './SQLParser.js';

// Use a type-only import for CodebaseIntrospectionService to prevent a direct circular runtime dependency
// at the module level between ParserFactory and CodebaseIntrospectionService.
// The actual instance is passed at runtime when needed by JSONLParser.
import type { CodebaseIntrospectionService } from '../services/CodebaseIntrospectionService.js';

export class ParserFactory {
    private projectRootPath: string;

    constructor(projectRootPath: string) {
        this.projectRootPath = projectRootPath;
    }

    /**
     * Creates an ILanguageParser instance for a given parser type identifier.
     * @param type A string identifier for the parser (e.g., 'EnhancedTypeScript', 'Python', 'JSONL').
     * @param introspectionService (Optional) The CodebaseIntrospectionService instance, required for JSONLParser.
     * @returns An ILanguageParser instance or undefined if no parser is found for the given type.
     */
    createParser(type: string, introspectionService?: CodebaseIntrospectionService): ILanguageParser | undefined {
        switch (type.toLowerCase()) {
            case 'enhancedtypescript':
                return new EnhancedTypeScriptParser(this.projectRootPath);
            case 'python':
                return new PythonParser(this.projectRootPath);
            case 'html':
                return new HTMLParser(this.projectRootPath);
            case 'css':
                return new CSSParser(this.projectRootPath);
            case 'enhancedphp':
                return new EnhancedPHPParser(this.projectRootPath);
            case 'jsonl':
                // JSONLParser is unique as it depends on CodebaseIntrospectionService itself.
                // It must be provided at runtime.
                if (!introspectionService) {
                    throw new Error("CodebaseIntrospectionService instance is required for JSONLParser. Please pass it to createParser.");
                }
                return new JSONLParser(introspectionService);
            case 'markdown':
                return new MarkdownParser(this.projectRootPath);
            case 'tailwindcss':
                return new TailwindCSSParser(this.projectRootPath);
            case 'sql':
                return new SQLParser(this.projectRootPath);
            default:
                return undefined;
        }
    }

    /**
     * Retrieves all known parser instances.
     * This method is particularly useful for initial registration in services like CodebaseIntrospectionService.
     * @param introspectionService The CodebaseIntrospectionService instance, necessary for certain parser types like JSONLParser.
     * @returns An array of all supported ILanguageParser instances.
     */
    getAllParsers(introspectionService: CodebaseIntrospectionService): ILanguageParser[] {
        // Explicitly list all parser types that the factory can create
        const parserTypes = [
            'EnhancedTypeScript', 'Python', 'HTML', 'CSS', 'EnhancedPHP',
            'JSONL', 'Markdown', 'TailwindCSS', 'SQL'
        ];

        const parsers: ILanguageParser[] = [];
        for (const type of parserTypes) {
            const parser = this.createParser(type, introspectionService);
            if (parser) {
                parsers.push(parser);
            }
        }
        return parsers;
    }
}
