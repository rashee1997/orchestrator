import { tokenize } from '../utils/string-similarity.js';

export interface ExtractedEntity {
    text: string;
    type: 'file' | 'class' | 'function' | 'module' | 'variable' | 'unknown';
    confidence: number;
}

export interface QueryIntent {
    type: 'search' | 'traverse' | 'filter' | 'aggregate' | 'relationship' | 'unknown';
    action?: string;
    modifiers?: string[];
}

export interface StructuredQuery {
    type: string;
    entities?: string[];
    entityTypes?: string[];
    relationTypes?: string[];
    filters?: Record<string, any>;
    depth?: number;
    limit?: number;
    originalQuery?: string;
}

export class NLPQueryProcessor {
    private entityPatterns = {
        file: /\b(\w+\.(ts|js|tsx|jsx|py|java|cpp|c|h|hpp|cs|go|rs|rb|php|swift|kt|scala|r|m|mm|sql|json|xml|yaml|yml|md|txt|css|scss|sass|less|html|htm))\b/gi,
        class: /\b(class|interface|struct|enum)\s+(\w+)|(\w+)(Class|Interface|Struct|Enum)\b/gi,
        function: /\b(function|method|func|def)\s+(\w+)|(\w+)(Function|Method|Handler|Callback)\b/gi,
        module: /\b(module|package|namespace)\s+(\w+)|(@\w+\/\w+|\w+\/\w+)\b/gi,
        variable: /\b(const|let|var|val)\s+(\w+)|(\$\w+|_\w+)\b/gi
    };

    private intentKeywords = {
        search: ['find', 'search', 'look for', 'locate', 'where', 'which', 'what', 'show'],
        traverse: ['from', 'to', 'connected', 'related', 'linked', 'path', 'between', 'traverse'],
        filter: ['with', 'having', 'containing', 'matching', 'like', 'type', 'kind'],
        aggregate: ['count', 'how many', 'total', 'sum', 'average', 'group', 'statistics'],
        relationship: ['imports', 'exports', 'uses', 'calls', 'extends', 'implements', 'depends', 'references']
    };

    // Extract entities from a natural language query
    extractEntities(query: string): ExtractedEntity[] {
        const entities: ExtractedEntity[] = [];
        const processedTexts = new Set<string>();

        // Check for file patterns
        let match;
        while ((match = this.entityPatterns.file.exec(query)) !== null) {
            const text = match[1];
            if (!processedTexts.has(text.toLowerCase())) {
                entities.push({ text, type: 'file', confidence: 0.9 });
                processedTexts.add(text.toLowerCase());
            }
        }
        this.entityPatterns.file.lastIndex = 0;

        // Check for class patterns
        const classRegex = /\b(?:class|interface|struct|enum)\s+(\w+)|(\w+)(?:Class|Interface|Struct|Enum)\b/gi;
        while ((match = classRegex.exec(query)) !== null) {
            const text = match[1] || match[2];
            if (text && !processedTexts.has(text.toLowerCase())) {
                entities.push({ text, type: 'class', confidence: 0.8 });
                processedTexts.add(text.toLowerCase());
            }
        }

        // Check for function patterns
        const funcRegex = /\b(?:function|method|func|def)\s+(\w+)|(\w+)(?:Function|Method|Handler|Callback)\b/gi;
        while ((match = funcRegex.exec(query)) !== null) {
            const text = match[1] || match[2];
            if (text && !processedTexts.has(text.toLowerCase())) {
                entities.push({ text, type: 'function', confidence: 0.8 });
                processedTexts.add(text.toLowerCase());
            }
        }

        // Check for module patterns
        const moduleRegex = /\b(?:module|package|namespace)\s+(\w+)|(@?\w+\/\w+)\b/gi;
        while ((match = moduleRegex.exec(query)) !== null) {
            const text = match[1] || match[2];
            if (text && !processedTexts.has(text.toLowerCase())) {
                entities.push({ text, type: 'module', confidence: 0.7 });
                processedTexts.add(text.toLowerCase());
            }
        }

        // Extract potential entity names (capitalized words or camelCase)
        const potentialEntities = query.match(/\b[A-Z]\w+\b|\b[a-z]+(?:[A-Z]\w+)+\b/g) || [];
        for (const text of potentialEntities) {
            if (!processedTexts.has(text.toLowerCase())) {
                entities.push({ text, type: 'unknown', confidence: 0.5 });
                processedTexts.add(text.toLowerCase());
            }
        }

        return entities;
    }

    // Identify the intent of a query
    identifyIntent(query: string): QueryIntent {
        const lowerQuery = query.toLowerCase();
        const tokens = tokenize(query);
        
        let bestIntent: QueryIntent = { type: 'unknown' };
        let bestScore = 0;

        for (const [intentType, keywords] of Object.entries(this.intentKeywords)) {
            let score = 0;
            const matchedKeywords: string[] = [];
            
            for (const keyword of keywords) {
                if (lowerQuery.includes(keyword)) {
                    score += 2;
                    matchedKeywords.push(keyword);
                }
                
                // Check tokens for partial matches
                for (const token of tokens) {
                    if (token.includes(keyword) || keyword.includes(token)) {
                        score += 1;
                    }
                }
            }
            
            if (score > bestScore) {
                bestScore = score;
                bestIntent = {
                    type: intentType as any,
                    action: matchedKeywords[0],
                    modifiers: matchedKeywords.slice(1)
                };
            }
        }

        // Additional intent detection based on query structure
        if (lowerQuery.includes('?')) {
            bestIntent.modifiers = bestIntent.modifiers || [];
            bestIntent.modifiers.push('question');
        }

        if (lowerQuery.includes(' all ')) {
            bestIntent.modifiers = bestIntent.modifiers || [];
            bestIntent.modifiers.push('all');
        }

        return bestIntent;
    }

    // Generate a structured query from natural language
    generateStructuredQuery(query: string): StructuredQuery {
        const intent = this.identifyIntent(query);
        const entities = this.extractEntities(query);
        const lowerQuery = query.toLowerCase();

        const structuredQuery: StructuredQuery = {
            type: intent.type
        };

        // Extract entity names and types
        if (entities.length > 0) {
            structuredQuery.entities = entities.map(e => e.text);
            const uniqueTypes = [...new Set(entities.map(e => e.type).filter(t => t !== 'unknown'))];
            if (uniqueTypes.length > 0) {
                structuredQuery.entityTypes = uniqueTypes;
            }
        }

        // Extract relationship types
        const relationKeywords = ['imports', 'exports', 'extends', 'implements', 'calls', 'uses', 'depends on', 'references'];
        const foundRelations = relationKeywords.filter(rel => lowerQuery.includes(rel));
        if (foundRelations.length > 0) {
            structuredQuery.relationTypes = foundRelations.map(rel => rel.replace(' ', '_'));
        }

        // Extract depth for traversal queries
        const depthMatch = query.match(/\b(?:depth|level|deep)\s*(?:of\s*)?(\d+)\b/i);
        if (depthMatch) {
            structuredQuery.depth = parseInt(depthMatch[1]);
        }

        // Extract limit
        const limitMatch = query.match(/\b(?:top|first|limit)\s*(\d+)\b/i);
        if (limitMatch) {
            structuredQuery.limit = parseInt(limitMatch[1]);
        }

        // Build filters based on query modifiers
        const filters: Record<string, any> = {};
        
        if (lowerQuery.includes('test') || lowerQuery.includes('spec')) {
            filters.isTest = true;
        }
        
        if (lowerQuery.includes('interface')) {
            filters.entityType = 'interface';
        }
        
        if (lowerQuery.includes('class')) {
            filters.entityType = 'class';
        }
        
        if (Object.keys(filters).length > 0) {
            structuredQuery.filters = filters;
        }

        // If we couldn't determine a specific structure, return unstructured
        if (structuredQuery.type === 'unknown' && !structuredQuery.entities && !structuredQuery.relationTypes) {
            return { type: 'unstructured', originalQuery: query };
        }

        return structuredQuery;
    }

    // Fallback to AI for complex queries
    async fallbackToAI(query: string): Promise<StructuredQuery> {
        // In a real implementation, this would call an AI service
        // For now, we'll try to extract as much as we can
        const basicStructure = this.generateStructuredQuery(query);
        
        if (basicStructure.type === 'unstructured') {
            // Try to at least identify if it's asking about specific code patterns
            const codePatterns = [
                { pattern: /singleton\s+pattern/i, suggestion: { type: 'search', filters: { pattern: 'singleton' } } },
                { pattern: /factory\s+pattern/i, suggestion: { type: 'search', filters: { pattern: 'factory' } } },
                { pattern: /observer\s+pattern/i, suggestion: { type: 'search', filters: { pattern: 'observer' } } },
                { pattern: /dependency\s+injection/i, suggestion: { type: 'search', filters: { pattern: 'dependency_injection' } } }
            ];
            
            for (const { pattern, suggestion } of codePatterns) {
                if (pattern.test(query)) {
                    return { ...basicStructure, ...suggestion };
                }
            }
        }
        
        return basicStructure;
    }
}
