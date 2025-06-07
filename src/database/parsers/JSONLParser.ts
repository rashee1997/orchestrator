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

    async parseCodeEntities(filePath: string, fileContent: string, projectRootPath?: string): Promise<ExtractedCodeEntity[]> {
        const entities: ExtractedCodeEntity[] = [];
        const lines = fileContent.split('\n').filter(line => line.trim());
        
        lines.forEach((line, index) => {
            try {
                const jsonObj = JSON.parse(line);
                const lineNum = index + 1;
                
                // Extract code entities from knowledge graph nodes
                if (jsonObj.entityType && ['class', 'function', 'method', 'interface', 'variable'].includes(jsonObj.entityType)) {
                entities.push({
                    type: jsonObj.entityType as any,
                    name: jsonObj.name || `entity_${lineNum}`,
                    fullName: jsonObj.fullName || jsonObj.name || `${filePath}:${lineNum}`,
                    signature: jsonObj.signature || JSON.stringify(jsonObj).substring(0, 100),
                    startLine: lineNum,
                    endLine: lineNum,
                    filePath,
                    containingDirectory: path.dirname(filePath),
                    isExported: true
                });

                }
                
                // Extract from observations if they contain code entity info
                if (jsonObj.observations && Array.isArray(jsonObj.observations)) {
                    for (const obs of jsonObj.observations) {
                        if (typeof obs === 'string' && obs.includes('type:')) {
                            const typeMatch = obs.match(/type:\s*(\w+)/);
                            if (typeMatch && ['class', 'function', 'method', 'interface'].includes(typeMatch[1])) {
                                entities.push({
                                    type: typeMatch[1] as any,
                                    name: jsonObj.name || `entity_${lineNum}`,
                                    fullName: jsonObj.name || `${filePath}:${lineNum}`,
                                    signature: obs,
                                    startLine: lineNum,
                                    endLine: lineNum,
                                    filePath,
                                    containingDirectory: path.dirname(filePath),
                                    isExported: true
                                });
                            }
                        }
                    }
                }
            } catch (e) {
                // Skip invalid JSON lines
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
