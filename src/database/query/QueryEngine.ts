import { JsonlStorageManager } from '../storage/JsonlStorageManager.js';
import path from 'path';

export class QueryEngine {
    private jsonlStorage: JsonlStorageManager;

    constructor(jsonlStorage: JsonlStorageManager) {
        this.jsonlStorage = jsonlStorage;
    }

    // Parse a query string or structured query object
    parseQuery(query: string | any): any {
        if (typeof query === 'string') {
            // Simple passthrough for string queries
            return { type: 'simple_search', query };
        }
        // If already structured, return as is
        return query;
    }

    // Execute a structured query AST
    async executeQuery(ast: any, agentId: string): Promise<any> {
        const allNodes = await this.jsonlStorage.readAllLines(path.join(agentId, 'nodes.jsonl'));
        if (ast.type === 'simple_search') {
            const lowerQuery = ast.query.toLowerCase();
            const filteredNodes = allNodes.filter((node: any) => {
                if (node.deleted) return false;
                const nameMatch = node.name.toLowerCase().includes(lowerQuery);
                const typeMatch = node.entityType.toLowerCase().includes(lowerQuery);
                let observationsMatch = false;
                if (node.observations && Array.isArray(node.observations)) {
                    observationsMatch = node.observations.some((obs: string) => obs.toLowerCase().includes(lowerQuery));
                }
                return nameMatch || typeMatch || observationsMatch;
            });
            return { nodes: filteredNodes };
        }
        // Structured query support
        let nodes = allNodes.filter((node: any) => !node.deleted);
        if (ast.entities && ast.entities.length > 0) {
            nodes = nodes.filter((node: any) => ast.entities.includes(node.name));
        }
        if (ast.entityTypes && ast.entityTypes.length > 0) {
            nodes = nodes.filter((node: any) => ast.entityTypes.includes(node.entityType));
        }
        if (ast.filters) {
            for (const [key, value] of Object.entries(ast.filters) as [string, any][]) {
                if (key === 'isTest' && value) {
                    nodes = nodes.filter((node: any) => node.name.includes('.test') || node.name.includes('.spec'));
                }
                if (key === 'entityType') {
                    nodes = nodes.filter((node: any) => node.entityType === value);
                }
                if (key === 'pattern') {
                    nodes = nodes.filter((node: any) => node.observations && node.observations.some((obs: string) => obs.toLowerCase().includes(value.toLowerCase())));
                }
            }
        }
        if (ast.limit && typeof ast.limit === 'number') {
            nodes = nodes.slice(0, ast.limit);
        }
        return { nodes };
    }

    // Optimize query AST (placeholder)
    optimizeQuery(ast: any): any {
        return ast;
    }
}
