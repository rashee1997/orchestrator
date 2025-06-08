// src/database/parsers/JSONLParser.ts
import { ILanguageParser, ExtractedImport, ExtractedCodeEntity } from './ILanguageParser.js';
import { CodebaseIntrospectionService } from '../services/CodebaseIntrospectionService.js';
import fs from 'fs/promises';
import readline from 'readline';
import { createReadStream } from 'fs';
import path from 'path';

// Internal types for JSONL parsing
interface ParsedEntity {
    name: string;
    type: string;
    startLine: number;
    endLine: number;
    signature: string;
    fullName: string;
    exported: boolean;
}

interface ImportInfo {
    moduleName: string;
    importedNames: string[];
    isDefault: boolean;
    isNamespace: boolean;
    lineNumber: number;
}

export class JSONLParser implements ILanguageParser {
    private introspectionService: CodebaseIntrospectionService;

    constructor(introspectionService: CodebaseIntrospectionService) {
        this.introspectionService = introspectionService;
    }

    getLanguageName(): string {
        return 'jsonl';
    }

    getSupportedExtensions(): string[] {
        return ['.jsonl', '.ndjson'];
    }

    async parseFile(filePath: string, fileContent: string): Promise<ParsedEntity[]> {
        const entities: ParsedEntity[] = [];
        const lines = fileContent.split('\n').filter(line => line.trim());
        
        // Create a file-level entity
        entities.push({
            name: filePath.split('/').pop() || 'jsonl_file',
            type: 'file',
            startLine: 1,
            endLine: lines.length,
            signature: `JSONL file with ${lines.length} records`,
            fullName: filePath,
            exported: true
        });

        // Parse each line as a potential JSON object
        lines.forEach((line, index) => {
            try {
                const jsonObj = JSON.parse(line);
                const lineNum = index + 1;
                
                // Extract meaningful entity information from common JSONL patterns
                if (jsonObj.name && jsonObj.entityType) {
                    // Knowledge graph node format
                    entities.push({
                        name: jsonObj.name,
                        type: jsonObj.entityType || 'json_object',
                        startLine: lineNum,
                        endLine: lineNum,
                        signature: jsonObj.observations ? jsonObj.observations.join(', ') : JSON.stringify(jsonObj).substring(0, 100),
                        fullName: `${filePath}:line${lineNum}:${jsonObj.name}`,
                        exported: true
                    });
                } else if (jsonObj.id && jsonObj.type) {
                    // Event or generic typed object format
                    entities.push({
                        name: jsonObj.id,
                        type: jsonObj.type || 'json_event',
                        startLine: lineNum,
                        endLine: lineNum,
                        signature: JSON.stringify(jsonObj).substring(0, 100),
                        fullName: `${filePath}:line${lineNum}:${jsonObj.id}`,
                        exported: true
                    });
                } else {
                    // Generic JSON object
                    const objName = jsonObj.id || jsonObj.name || `object_${lineNum}`;
                    entities.push({
                        name: objName,
                        type: 'json_object',
                        startLine: lineNum,
                        endLine: lineNum,
                        signature: JSON.stringify(jsonObj).substring(0, 100),
                        fullName: `${filePath}:line${lineNum}:${objName}`,
                        exported: true
                    });
                }
            } catch (e) {
                // Skip invalid JSON lines
                console.warn(`Skipping invalid JSON at line ${index + 1} in ${filePath}`);
            }
        });

        return entities;
    }

    extractImports(fileContent: string): ImportInfo[] {
        // JSONL files don't have traditional imports, but we can extract references
        const imports: ImportInfo[] = [];
        const lines = fileContent.split('\n').filter(line => line.trim());
        
        lines.forEach((line, index) => {
            try {
                const jsonObj = JSON.parse(line);
                
                // Look for references in knowledge graph relations
                if (jsonObj.fromNodeId && jsonObj.toNodeId && jsonObj.relationType) {
                    imports.push({
                        moduleName: jsonObj.toNodeId,
                        importedNames: [jsonObj.relationType],
                        isDefault: false,
                        isNamespace: false,
                        lineNumber: index + 1
                    });
                }
                
                // Look for file path references
                const filePathPattern = /(?:file_path|path|filePath|absolute_path)["']?\s*:\s*["']([^"']+)["']/g;
                let match;
                while ((match = filePathPattern.exec(line)) !== null) {
                    imports.push({
                        moduleName: match[1],
                        importedNames: ['file_reference'],
                        isDefault: false,
                        isNamespace: false,
                        lineNumber: index + 1
                    });
                }
            } catch (e) {
                // Skip invalid JSON lines
            }
        });

        return imports;
    }

    async parseImports(filePath: string, fileContent: string): Promise<ExtractedImport[]> {
        const imports: ExtractedImport[] = [];
        const lines = fileContent.split('\n').filter(line => line.trim());
        
        lines.forEach((line, index) => {
            try {
                const jsonObj = JSON.parse(line);
                const lineNum = index + 1;
                
                // Look for file path references
                if (jsonObj.file_path || jsonObj.filePath || jsonObj.path || jsonObj.absolute_path) {
                    const targetPath = jsonObj.file_path || jsonObj.filePath || jsonObj.path || jsonObj.absolute_path;
                    imports.push({
                        type: 'file',
                        targetPath,
                        originalImportString: line.substring(0, 100),
                        startLine: lineNum,
                        endLine: lineNum
                    });
                }
                
                // Look for module references
                if (jsonObj.module || jsonObj.moduleName) {
                    imports.push({
                        type: 'module',
                        targetPath: jsonObj.module || jsonObj.moduleName,
                        originalImportString: line.substring(0, 100),
                        startLine: lineNum,
                        endLine: lineNum
                    });
                }
            } catch (e) {
                // Skip invalid JSON lines
            }
        });

        return imports;
    }

    async parseCodeEntities(filePath: string, fileContent: string, projectRootPath: string): Promise<ExtractedCodeEntity[]> {
        const entities: ExtractedCodeEntity[] = [];
        const absoluteFilePath = path.resolve(filePath).replace(/\\/g, '/');
        const relativeFilePath = path.relative(projectRootPath, absoluteFilePath).replace(/\\/g, '/');
        const containingDirectory = path.dirname(relativeFilePath).replace(/\\/g, '/');
        
        const lines = fileContent.split('\n').filter(line => line.trim());
        
        lines.forEach((line, index) => {
            try {
                const jsonObj = JSON.parse(line);
                const lineNum = index + 1;
                
                let entityType: ExtractedCodeEntity['type'] = 'unknown';
                let entityName: string = `json_object_line_${lineNum}`;
                let signature: string = JSON.stringify(jsonObj).substring(0, 100);
                let fullName: string = `${relativeFilePath}::line_${lineNum}`;
                let metadata: Record<string, any> = { originalJson: jsonObj };

                // Attempt to infer more specific types and names
                if (jsonObj.entityType && ['class', 'function', 'method', 'interface', 'variable', 'control_flow', 'call_signature'].includes(jsonObj.entityType)) {
                    entityType = jsonObj.entityType;
                    entityName = jsonObj.name || entityName;
                    signature = jsonObj.signature || signature;
                    fullName = jsonObj.fullName || fullName;
                } else if (jsonObj.type && ['event', 'log', 'record'].includes(jsonObj.type)) {
                    entityType = 'unknown'; // Or a new 'event' type if ExtractedCodeEntity is extended
                    entityName = jsonObj.id || jsonObj.name || entityName;
                    signature = jsonObj.message || JSON.stringify(jsonObj).substring(0, 100);
                    fullName = `${relativeFilePath}::${entityName}`;
                } else if (jsonObj.name && typeof jsonObj.value !== 'undefined') {
                    entityType = 'variable';
                    entityName = jsonObj.name;
                    signature = `${jsonObj.name}: ${JSON.stringify(jsonObj.value)}`;
                    fullName = `${relativeFilePath}::${entityName}`;
                } else if (jsonObj.action && jsonObj.target) {
                    entityType = 'control_flow'; // Represents a step or action
                    entityName = jsonObj.action;
                    signature = `${jsonObj.action} ${jsonObj.target}`;
                    fullName = `${relativeFilePath}::${entityName}`;
                }

                // Add all top-level properties to metadata
                for (const key in jsonObj) {
                    if (jsonObj.hasOwnProperty(key)) {
                        metadata[key] = jsonObj[key];
                    }
                }

                entities.push({
                    type: entityType,
                    name: entityName,
                    fullName: fullName,
                    signature: signature,
                    startLine: lineNum,
                    endLine: lineNum,
                    filePath: absoluteFilePath,
                    containingDirectory: containingDirectory,
                    isExported: true, // Consider all top-level JSON objects as "exported"
                    metadata: metadata
                });

            } catch (e) {
                // Skip invalid JSON lines
                console.warn(`Skipping invalid JSON at line ${index + 1} in ${filePath}:`, e);
            }
        });

        return entities;
    }

    /**
     * Stream parse large JSONL files for better memory efficiency
     */
    async *parseFileStream(filePath: string): AsyncGenerator<ParsedEntity, void, unknown> {
        const fileStream = createReadStream(filePath);
        const rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity
        });

        let lineNum = 0;
        for await (const line of rl) {
            lineNum++;
            if (!line.trim()) continue;
            
            try {
                const jsonObj = JSON.parse(line);
                
                if (jsonObj.name && jsonObj.entityType) {
                    yield {
                        name: jsonObj.name,
                        type: jsonObj.entityType || 'json_object',
                        startLine: lineNum,
                        endLine: lineNum,
                        signature: jsonObj.observations ? jsonObj.observations.join(', ') : JSON.stringify(jsonObj).substring(0, 100),
                        fullName: `${filePath}:line${lineNum}:${jsonObj.name}`,
                        exported: true
                    };
                }
            } catch (e) {
                // Skip invalid JSON lines
            }
        }
    }

    /**
     * Extract structured data from JSONL for embeddings
     */
    async extractStructuredData(fileContent: string): Promise<Array<{
        text: string;
        metadata: Record<string, any>;
    }>> {
        const structuredData: Array<{ text: string; metadata: Record<string, any> }> = [];
        const lines = fileContent.split('\n').filter(line => line.trim());
        
        for (const [index, line] of lines.entries()) {
            try {
                const jsonObj = JSON.parse(line);
                
                // Extract meaningful text content based on the object structure
                let textContent = '';
                const metadata: Record<string, any> = {
                    lineNumber: index + 1,
                    objectType: jsonObj.type || jsonObj.entityType || 'unknown'
                };

                // Knowledge graph node
                if (jsonObj.name && jsonObj.observations) {
                    textContent = `${jsonObj.name}: ${jsonObj.observations.join('. ')}`;
                    metadata.nodeId = jsonObj.id;
                    metadata.entityType = jsonObj.entityType;
                }
                // Event
                else if (jsonObj.eventType && jsonObj.payload) {
                    textContent = `Event ${jsonObj.eventType}: ${JSON.stringify(jsonObj.payload)}`;
                    metadata.eventId = jsonObj.id;
                    metadata.timestamp = jsonObj.timestamp;
                }
                // Generic object with description or content
                else if (jsonObj.description || jsonObj.content || jsonObj.text) {
                    textContent = jsonObj.description || jsonObj.content || jsonObj.text;
                    metadata.id = jsonObj.id || jsonObj.name;
                }
                // Fallback to stringified object
                else {
                    textContent = JSON.stringify(jsonObj);
                }

                if (textContent) {
                    structuredData.push({
                        text: textContent,
                        metadata
                    });
                }
            } catch (e) {
                // Skip invalid JSON lines
            }
        }

        return structuredData;
    }
}
