import {
    ILanguageParser,
    BaseLanguageParser,
    ExtractedImport,
    ExtractedCodeEntity,
} from './ILanguageParser.js';
import pkg, { AST } from 'node-sql-parser';
const { Parser } = pkg;
import path from 'path';

// ---------- Enhanced Type Interfaces ----------
interface EnhancedTypeInfo {
    name: string;
    nullable: boolean;
    isArray: boolean;
    isBuiltin: boolean;
    raw: string;
}

interface ParameterInfo {
    name: string;
    typeInfo?: EnhancedTypeInfo;
    optional: boolean;
    defaultValue?: string;
}

interface SQLCodeEntity extends ExtractedCodeEntity {
    parameters?: ParameterInfo[];
    returnTypeInfo?: EnhancedTypeInfo;
    dependencies?: string[];
    sqlDialect?: string;
}

// ---------- Main Parser ----------
export class SQLParser extends BaseLanguageParser implements ILanguageParser {
    private parser: pkg.Parser;

    constructor(projectRootPath: string) {
        super(projectRootPath);
        this.parser = new Parser();
    }

    getLanguageName(): string {
        return 'SQL';
    }

    getSupportedExtensions(): string[] {
        return ['.sql'];
    }

    async parseImports(_filePath: string, _fileContent: string): Promise<ExtractedImport[]> {
        // SQL has no traditional import syntax; return empty
        return [];
    }

    async parseCodeEntities(
        filePath: string,
        fileContent: string
    ): Promise<SQLCodeEntity[]> {
        const entities: SQLCodeEntity[] = [];
        const relativePath = this.getRelativeFilePath(filePath);
        const containingDir = path.dirname(relativePath);

        // Split lines for accurate line mapping
        const lines = fileContent.split('\n');

        // Parse all statements (MySQL dialect by default; extend as needed)
        let ast: any[];
        try {
            const parseResult = this.parser.astify(fileContent, { database: 'sqlite' });
            ast = Array.isArray(parseResult) ? parseResult : [parseResult];
        } catch (err) {
            console.warn('SQL parse error:', err);
            return [];
        }

        for (const stmt of ast) {
            if (!stmt) continue;

            switch (stmt.type) {
                case 'create': {
                    await this._handleCreate(stmt, entities, lines, relativePath, containingDir);
                    break;
                }
                case 'alter': {
                    await this._handleAlter(stmt, entities, lines, relativePath, containingDir);
                    break;
                }
                case 'drop': {
                    await this._handleDrop(stmt, entities, lines, relativePath, containingDir);
                    break;
                }
                case 'insert':
                case 'update':
                case 'delete':
                case 'select': {
                    await this._handleDML(stmt, entities, lines, relativePath, containingDir);
                    break;
                }
                default:
                    // Generic fallback for unknown statements
                    entities.push({
                        type: 'unknown',
                        name: stmt.type,
                        fullName: `${relativePath}::${stmt.type}`,
                        signature: fileContent.substring(stmt.start?.index || 0, stmt.end?.index || 0),
                        startLine: stmt.start?.line || 0,
                        endLine: stmt.end?.line || 0,
                        filePath: relativePath,
                        containingDirectory: containingDir,
                        isExported: true,
                        metadata: { rawStatement: stmt },
                    });
            }
        }

        return entities;
    }

    // ---------- Helpers ----------
    private _findLine(lines: string[], pattern: string, start = 0): number {
        const re = new RegExp(pattern, 'i');
        for (let i = start; i < lines.length; i++) {
            if (re.test(lines[i])) return i + 1;
        }
        return -1;
    }

    private _parseColumns(columns: any[]): ParameterInfo[] {
        return columns.map((col: any) => {
            const typeInfo: EnhancedTypeInfo = {
                name: col.definition?.dataType || 'unknown',
                nullable: !col.definition?.nullable === false,
                isArray: false,
                isBuiltin: true,
                raw: col.definition?.type || 'unknown',
            };
            return {
                name: col.column?.column || col.name || '',
                typeInfo,
                optional: typeInfo.nullable,
                defaultValue: col.definition?.defaultVal,
            };
        });
    }

    private async _handleCreate(
        stmt: any,
        entities: SQLCodeEntity[],
        lines: string[],
        relativePath: string,
        containingDir: string
    ) {
        const keyword = stmt.keyword?.toLowerCase();
        const name = this._extractName(stmt);

        let type: SQLCodeEntity['type'] = 'unknown';
        let signature = '';

        switch (keyword) {
            case 'table': {
                type = 'table';
                signature = `CREATE TABLE ${name} (...)`;
                entities.push({
                    type,
                    name,
                    fullName: `${relativePath}::${name}`,
                    signature,
                    startLine: this._findLine(lines, `create\\s+table\\s+${name}`),
                    endLine: this._findLine(lines, ';', this._findLine(lines, `create\\s+table\\s+${name}`)),
                    filePath: relativePath,
                    containingDirectory: containingDir,
                    isExported: true,
                    parameters: this._parseColumns(stmt.create_definitions || []),
                    sqlDialect: 'MySQL',
                    metadata: {
                        columns: stmt.create_definitions?.filter((d: any) => d.resource === 'column') || [],
                        constraints: stmt.create_definitions?.filter((d: any) => d.resource === 'constraint') || [],
                        indexes: stmt.create_definitions?.filter((d: any) => d.resource === 'index') || [],
                    },
                });
                break;
            }
            case 'index': {
                type = 'index';
                signature = `CREATE INDEX ${name} ON ...`;
                entities.push({
                    type,
                    name,
                    fullName: `${relativePath}::${name}`,
                    signature,
                    startLine: this._findLine(lines, `create\\s+index\\s+${name}`),
                    endLine: this._findLine(lines, ';', this._findLine(lines, `create\\s+index\\s+${name}`)),
                    filePath: relativePath,
                    containingDirectory: containingDir,
                    isExported: true,
                    metadata: {
                        table: stmt.table?.[0]?.table,
                        indexType: stmt.index_type,
                        columns: stmt.index_columns,
                    },
                });
                break;
            }
            case 'view': {
                type = 'view';
                signature = `CREATE VIEW ${name} AS ...`;
                entities.push({
                    type,
                    name,
                    fullName: `${relativePath}::${name}`,
                    signature,
                    startLine: this._findLine(lines, `create\\s+(or\\s+replace\\s+)?view\\s+${name}`),
                    endLine: this._findLine(lines, ';', this._findLine(lines, `create\\s+(or\\s+replace\\s+)?view\\s+${name}`)),
                    filePath: relativePath,
                    containingDirectory: containingDir,
                    isExported: true,
                    dependencies: this._extractTableRefs(stmt.definition),
                    metadata: { definition: stmt.definition, columns: stmt.columns },
                });
                break;
            }
            case 'procedure': {
                type = 'function';
                signature = `CREATE PROCEDURE ${name} (...)`;
                entities.push({
                    type,
                    name,
                    fullName: `${relativePath}::${name}`,
                    signature,
                    startLine: this._findLine(lines, `create\\s+procedure\\s+${name}`),
                    endLine: this._findLine(lines, 'end', this._findLine(lines, `create\\s+procedure\\s+${name}`)),
                    filePath: relativePath,
                    containingDirectory: containingDir,
                    isExported: true,
                    parameters: (stmt.parameters || []).map((p: any) => ({
                        name: p.name,
                        typeInfo: { name: p.dataType, nullable: true, isArray: false, isBuiltin: true, raw: p.dataType },
                        optional: false,
                    })),
                    dependencies: this._extractTableRefs(stmt.body),
                    metadata: { body: stmt.body },
                });
                break;
            }
            case 'function': {
                type = 'function';
                signature = `CREATE FUNCTION ${name} (...) RETURNS ...`;
                entities.push({
                    type,
                    name,
                    fullName: `${relativePath}::${name}`,
                    signature,
                    startLine: this._findLine(lines, `create\\s+function\\s+${name}`),
                    endLine: this._findLine(lines, 'end', this._findLine(lines, `create\\s+function\\s+${name}`)),
                    filePath: relativePath,
                    containingDirectory: containingDir,
                    isExported: true,
                    parameters: (stmt.parameters || []).map((p: any) => ({
                        name: p.name,
                        typeInfo: { name: p.dataType, nullable: true, isArray: false, isBuiltin: true, raw: p.dataType },
                        optional: false,
                    })),
                    returnTypeInfo: { name: stmt.returnType, nullable: true, isArray: false, isBuiltin: true, raw: stmt.returnType },
                    dependencies: this._extractTableRefs(stmt.body),
                    metadata: { body: stmt.body },
                });
                break;
            }
            case 'trigger': {
                type = 'trigger';
                signature = `CREATE TRIGGER ${name} ...`;
                entities.push({
                    type,
                    name,
                    fullName: `${relativePath}::${name}`,
                    signature,
                    startLine: this._findLine(lines, `create\\s+trigger\\s+${name}`),
                    endLine: this._findLine(lines, 'end', this._findLine(lines, `create\\s+trigger\\s+${name}`)),
                    filePath: relativePath,
                    containingDirectory: containingDir,
                    isExported: true,
                    dependencies: this._extractTableRefs(stmt.trigger_body),
                    metadata: {
                        timing: stmt.timing,
                        event: stmt.event,
                        table: stmt.table?.[0]?.table,
                        body: stmt.trigger_body,
                    },
                });
                break;
            }
        }
    }

    private async _handleAlter(
        stmt: any,
        entities: SQLCodeEntity[],
        lines: string[],
        relativePath: string,
        containingDir: string
    ) {
        const table = stmt.table?.[0]?.table;
        const name = `ALTER_${table}`;
        entities.push({
            type: 'table',
            name,
            fullName: `${relativePath}::${name}`,
            signature: `ALTER TABLE ${table} ...`,
            startLine: this._findLine(lines, `alter\\s+table\\s+${table}`),
            endLine: this._findLine(lines, ';', this._findLine(lines, `alter\\s+table\\s+${table}`)),
            filePath: relativePath,
            containingDirectory: containingDir,
            isExported: true,
            dependencies: [table],
            metadata: { operations: stmt.alter_actions },
        });
    }

    private async _handleDrop(
        stmt: any,
        entities: SQLCodeEntity[],
        lines: string[],
        relativePath: string,
        containingDir: string
    ) {
        const name = this._extractName(stmt);
        const type = stmt.keyword?.toLowerCase() as SQLCodeEntity['type'];
        entities.push({
            type,
            name,
            fullName: `${relativePath}::${name}`,
            signature: `DROP ${stmt.keyword} ${name}`,
            startLine: this._findLine(lines, `drop\\s+${stmt.keyword}\\s+${name}`),
            endLine: this._findLine(lines, ';', this._findLine(lines, `drop\\s+${stmt.keyword}\\s+${name}`)),
            filePath: relativePath,
            containingDirectory: containingDir,
            isExported: true,
            metadata: { ifExists: stmt.if_exists },
        });
    }

    private async _handleDML(
        stmt: any,
        entities: SQLCodeEntity[],
        lines: string[],
        relativePath: string,
        containingDir: string
    ) {
        const type = stmt.type.toLowerCase() as SQLCodeEntity['type'];
        const name = `${type}_${Date.now()}`;
        entities.push({
            type,
            name,
            fullName: `${relativePath}::${name}`,
            signature: `${stmt.type.toUpperCase()} statement`,
            startLine: stmt.start?.line || 1,
            endLine: stmt.end?.line || 1,
            filePath: relativePath,
            containingDirectory: containingDir,
            isExported: true,
            dependencies: this._extractTableRefs(stmt),
            metadata: { rawStatement: stmt },
        });
    }

    private _extractName(stmt: any): string {
        if (Array.isArray(stmt.table) && stmt.table.length > 0) {
            return stmt.table[0].table;
        }
        if (stmt.index) return stmt.index;
        if (stmt.view) return Array.isArray(stmt.view) ? stmt.view[0].table : stmt.view;
        if (stmt.name) return stmt.name;
        return 'unnamed';
    }

    private _extractTableRefs(stmt: any): string[] {
        const refs = new Set<string>();
        const walk = (node: any) => {
            if (!node || typeof node !== 'object') return;
            if (node.table) {
                if (Array.isArray(node.table)) {
                    node.table.forEach((t: any) => t.table && refs.add(t.table));
                } else if (node.table.table) refs.add(node.table.table);
            }
            Object.values(node).forEach(walk);
        };
        walk(stmt);
        return Array.from(refs);
    }
}