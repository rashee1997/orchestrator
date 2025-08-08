// @/src/database/ai/NLPQueryProcessor.ts
import { tokenize } from '../utils/string-similarity.js';
import { NlpStructuredQuery } from '../../types/query.js';
// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------
export interface ExtractedEntity {
    text: string;
    type: EntityType;
    confidence: number;
    qualifiers?: string[]; // e.g. "abstract", "deprecated", "async"
    context?: string; // Additional context about the entity
    position?: {
        start: number;
        end: number;
    }; // Position in the original query
}
export type EntityType = 'file' | 'class' | 'interface' | 'struct' | 'enum' | 'function' | 'method' | 'module' | 'package' | 'namespace' | 'variable' | 'constant' | 'unknown' | 'pattern' | 'concept';
export interface QueryIntent {
    type: IntentType;
    action?: string;
    modifiers?: string[];
    negations?: string[];
    confidence: number; // Confidence score for the detected intent
}
export type IntentType = 'search' | 'traverse' | 'filter' | 'aggregate' | 'relationship' | 'semantic' | 'unknown' | 'compare' | 'analyze' | 'transform' | 'nlp_structured_query';
export type StructuredQuery = {
    type: IntentType;
    entities?: string[];
    confidence?: number;
    entityTypes?: EntityType[];
    relationTypes?: string[];
    filters?: Record<string, any>;
    depth?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
    groupBy?: string;
    originalQuery?: string;
    context?: string; // Additional context about the query
    parameters?: Record<string, any>; // Additional parameters
};
// ------------------------------------------------------------------
// Main Class
// ------------------------------------------------------------------
export class NLPQueryProcessor {
    private patterns = {
        file: /\b([\w\-]+\.(ts|js|tsx|jsx|py|java|cpp|c|h|hpp|cs|go|rs|rb|php|swift|kt|scala|r|m|mm|sql|json|xml|yaml|yml|md|txt|css|scss|sass|less|html|htm))\b/gi,
        genericType: /\b(?:class|interface|struct|enum|trait|type|protocol)\s+(\w+)|(\w+)(?:Class|Interface|Struct|Enum|Trait|Type|Protocol)\b/gi,
        function: /\b(?:function|method|func|def|lambda|procedure)\s+(\w+)|(\w+)(?:Function|Method|Handler|Callback|Lambda|Procedure)\b/gi,
        module: /\b(?:module|package|namespace|library|crate)\s+([\w\/\-@]+)|(@?[\w\-]+\/[\w\-]+)\b/gi,
        variable: /\b(?:const|let|var|val|property)\s+(\w+)|(\$\w+|_\w+)\b/gi,
        constant: /\b[A-Z_][A-Z0-9_]+\b/g,
        pattern: /\b(singleton|factory|observer|strategy|adapter|decorator|facade|proxy|command|chain of responsibility|iterator|mediator|memento|observer|state|template method|visitor|composite|builder|dependency injection|injection|ioc)\b/gi
    };
    private intentLexicon = new Map<IntentType, string[]>([
        ['search', ['find', 'search', 'locate', 'show', 'list', 'give me', 'what', 'which', 'get', 'fetch']],
        ['traverse', ['from', 'to', 'between', 'path', 'connected', 'related', 'linked', 'depends', 'navigate', 'trace']],
        ['filter', ['with', 'having', 'containing', 'matching', 'like', 'of type', 'kind', 'where', 'filter']],
        ['aggregate', ['count', 'how many', 'total', 'sum', 'average', 'min', 'max', 'group', 'statistics', 'stats']],
        ['relationship', ['imports', 'exports', 'extends', 'implements', 'calls', 'uses', 'references', 'depends on', 'relates to']],
        ['semantic', ['explain', 'describe', 'usage', 'purpose', 'why', 'when to use', 'how does', 'what is']],
        ['compare', ['compare', 'difference', 'versus', 'vs', 'distinguish', 'contrast']],
        ['analyze', ['analyze', 'analysis', 'breakdown', 'examine', 'inspect', 'review']],
        ['transform', ['transform', 'convert', 'change', 'map', 'refactor', 'rewrite']]
    ]);
    private qualifiers = new Set(['abstract', 'async', 'deprecated', 'private', 'public', 'internal', 'static', 'final', 'override', 'test', 'spec', 'protected', 'readonly', 'const', 'virtual']);
    private contextWords = new Map<string, EntityType[]>([
        ['class', ['class', 'interface', 'struct']],
        ['function', ['function', 'method']],
        ['file', ['file']],
        ['variable', ['variable', 'constant']],
        ['pattern', ['pattern']],
        ['code', ['class', 'function', 'method', 'interface', 'struct']],
        ['import', ['module', 'package']],
        ['design', ['pattern']],
        ['api', ['interface', 'class', 'method']],
        ['data', ['variable', 'constant', 'struct']]
    ]);
    // ------------------------------------------------------------------
    // 1. Entity Extraction
    // ------------------------------------------------------------------
    extractEntities(query: string): ExtractedEntity[] {
        const entities: ExtractedEntity[] = [];
        const seen = new Set<string>();
        
        const add = (text: string, type: EntityType, confidence: number, qualifiers: string[], position?: {start: number, end: number}) => {
            const key = `${text}:${type}`.toLowerCase();
            if (!seen.has(key)) {
                // Extract context around the entity
                const context = this.extractContext(query, position?.start || 0, position?.end || 0);
                entities.push({ 
                    text, 
                    type, 
                    confidence: Math.min(1.0, confidence), 
                    qualifiers,
                    context,
                    position
                });
                seen.add(key);
            }
        };
        
        // Patterns
        for (const [type, regex] of Object.entries(this.patterns)) {
            let m;
            while ((m = regex.exec(query)) !== null) {
                const text = m[1] || m[2] || m[0];
                const position = {
                    start: m.index,
                    end: m.index + text.length
                };
                add(text, type as EntityType, 0.9, [], position);
            }
            regex.lastIndex = 0;
        }
        
        // Qualifiers
        const tokens = query.toLowerCase().split(/\s+/);
        const foundQualifiers = tokens.filter(t => this.qualifiers.has(t));
        
        // CamelCase / PascalCase
        const camelRegex = /\b[A-Z][a-z]+[A-Z]\w*\b/g;
        let m;
        while ((m = camelRegex.exec(query)) !== null) {
            const position = {
                start: m.index,
                end: m.index + m[0].length
            };
            add(m[0], 'unknown', 0.5, foundQualifiers, position);
        }
        
        // Snake_case
        const snakeRegex = /\b[a-z][a-z0-9]*(_[a-z0-9]+)+\b/g;
        while ((m = snakeRegex.exec(query)) !== null) {
            const position = {
                start: m.index,
                end: m.index + m[0].length
            };
            add(m[0], 'unknown', 0.4, foundQualifiers, position);
        }
        
        // kebab-case
        const kebabRegex = /\b[a-z][a-z0-9]*(-[a-z0-9]+)+\b/g;
        while ((m = kebabRegex.exec(query)) !== null) {
            const position = {
                start: m.index,
                end: m.index + m[0].length
            };
            add(m[0], 'unknown', 0.4, foundQualifiers, position);
        }
        
        // Adjust confidence based on context
        entities.forEach(e => {
            if (e.qualifiers?.length) e.confidence += 0.1;
            
            // Adjust confidence based on context words
            if (e.context) {
                const contextWords = e.context.toLowerCase().split(/\s+/);
                for (const word of contextWords) {
                    if (this.contextWords.has(word)) {
                        const possibleTypes = this.contextWords.get(word) || [];
                        if (possibleTypes.includes(e.type)) {
                            e.confidence += 0.15;
                        } else if (e.type === 'unknown') {
                            // If type is unknown but context suggests a type, update it
                            e.type = possibleTypes[0];
                            e.confidence += 0.1;
                        }
                    }
                }
            }
            
            // Adjust confidence based on position in query
            if (e.position) {
                const positionRatio = e.position.start / query.length;
                // Entities at the beginning or end of queries are often more important
                if (positionRatio < 0.2 || positionRatio > 0.8) {
                    e.confidence += 0.05;
                }
            }
        });
        
        return entities;
    }
    
    /**
     * Extract context around a position in the query
     */
    private extractContext(query: string, start: number, end: number, windowSize: number = 20): string {
        const contextStart = Math.max(0, start - windowSize);
        const contextEnd = Math.min(query.length, end + windowSize);
        return query.substring(contextStart, contextEnd);
    }
    // ------------------------------------------------------------------
    // 2. Intent Detection
    // ------------------------------------------------------------------
    identifyIntent(query: string): QueryIntent {
        const lower = query.toLowerCase();
        const tokens = tokenize(query);
        let best: QueryIntent = { type: 'unknown', confidence: 0 };
        let bestScore = 0;
        
        // Check for question marks (indicates semantic intent)
        const hasQuestionMark = query.includes('?');
        
        for (const [intent, keywords] of this.intentLexicon) {
            let score = 0;
            const matched: string[] = [];
            const negated: string[] = [];
            
            // Check for keyword matches
            for (const kw of keywords) {
                if (lower.includes(kw)) {
                    // Score based on keyword length (longer phrases are more specific)
                    score += 1 + (kw.length / 10);
                    matched.push(kw);
                }
            }
            
            // Negations
            const negationWords = ['no', 'not', 'without', 'exclude', 'except', "don't", "doesn't", "isn't"];
            for (const n of negationWords) {
                if (lower.includes(n)) {
                    negated.push(n);
                    score += 0.5; // Negations add context
                }
            }
            
            // Boost for question marks
            if (hasQuestionMark && intent === 'semantic') score += 2;
            
            // Check for specific patterns that indicate intent
            if (intent === 'compare' && lower.includes('vs')) score += 3;
            if (intent === 'aggregate' && lower.includes('how many')) score += 2;
            if (intent === 'transform' && lower.includes('convert')) score += 2;
            
            // Normalize score
            const normalizedScore = score / keywords.length;
            
            if (normalizedScore > bestScore) {
                bestScore = normalizedScore;
                best = { 
                    type: intent, 
                    action: matched[0], 
                    modifiers: matched.slice(1), 
                    negations: negated,
                    confidence: Math.min(1.0, normalizedScore)
                };
            }
        }
        
        // If no clear intent, check for other patterns
        if (bestScore < 0.3) {
            // Check for comparison patterns
            if (lower.includes('difference between') || lower.includes('compare')) {
                best = { 
                    type: 'compare', 
                    action: 'compare', 
                    confidence: 0.6
                };
            }
            // Check for analysis patterns
            else if (lower.includes('analyze') || lower.includes('breakdown')) {
                best = { 
                    type: 'analyze', 
                    action: 'analyze', 
                    confidence: 0.6
                };
            }
            // Check for transformation patterns
            else if (lower.includes('transform') || lower.includes('convert') || lower.includes('refactor')) {
                best = { 
                    type: 'transform', 
                    action: 'transform', 
                    confidence: 0.6
                };
            }
        }
        
        return best;
    }
    // ------------------------------------------------------------------
    // 3. Structured Query Generation
    // ------------------------------------------------------------------
    generateStructuredQuery(query: string): StructuredQuery {
        const intent = this.identifyIntent(query);
        const entities = this.extractEntities(query);
        const lower = query.toLowerCase();
        const sq: StructuredQuery = { 
            type: intent.type, 
            originalQuery: query,
            context: this.extractQueryContext(query)
        };
        
        // Entities & types
        if (entities.length) {
            // Filter entities by confidence threshold
            const highConfidenceEntities = entities.filter(e => e.confidence > 0.4);
            
            if (highConfidenceEntities.length) {
                sq.entities = highConfidenceEntities.map(e => e.text);
                sq.entityTypes = [...new Set(highConfidenceEntities.map(e => e.type).filter(t => t !== 'unknown'))];
                
                // Extract qualifiers
                const qualifiers = [...new Set(highConfidenceEntities.flatMap(e => e.qualifiers || []))];
                if (qualifiers.length) {
                    sq.filters = { ...(sq.filters || {}), qualifiers };
                }
                
                // Add entity positions as additional context
                if (!sq.parameters) sq.parameters = {};
                sq.parameters.entityPositions = highConfidenceEntities
                    .filter(e => e.position)
                    .map(e => ({ text: e.text, position: e.position }));
            }
        }
        
        // Relations
        const relations = ['imports', 'exports', 'extends', 'implements', 'calls', 'uses', 'depends', 'references', 'inherits', 'composes'];
        const found = relations.filter(r => lower.includes(r));
        if (found.length) sq.relationTypes = found;
        
        // Numeric parameters
        const depthMatch = query.match(/\b(?:depth|level)\s*(\d+)\b/i);
        if (depthMatch) sq.depth = parseInt(depthMatch[1]);
        
        const limitMatch = query.match(/\b(?:top|first|limit)\s*(\d+)\b/i);
        if (limitMatch) sq.limit = parseInt(limitMatch[1]);
        
        // Filters
        const filters: Record<string, any> = { ...(sq.filters || {}) };
        
        // Test-related filters
        if (lower.includes('test')) filters.isTest = true;
        if (lower.includes('not test') || lower.includes('non-test')) filters.isTest = false;
        
        // Type filters
        if (lower.includes('interface')) filters.entityType = 'interface';
        if (lower.includes('class')) filters.entityType = 'class';
        if (lower.includes('function') || lower.includes('method')) filters.entityType = 'function';
        if (lower.includes('pattern')) filters.pattern = true;
        
        // Modifier filters
        if (lower.includes('abstract')) filters.modifiers = [...(filters.modifiers || []), 'abstract'];
        if (lower.includes('async')) filters.modifiers = [...(filters.modifiers || []), 'async'];
        if (lower.includes('static')) filters.modifiers = [...(filters.modifiers || []), 'static'];
        if (lower.includes('public')) filters.modifiers = [...(filters.modifiers || []), 'public'];
        if (lower.includes('private')) filters.modifiers = [...(filters.modifiers || []), 'private'];
        
        // Apply negations from intent
        if (intent.negations?.includes('test')) filters.isTest = false;
        
        // Date filters
        const dateMatch = query.match(/\b(before|after|since|until)\s+([0-9]{4}-[0-9]{2}-[0-9]{2})\b/i);
        if (dateMatch) {
            const [, relation, dateStr] = dateMatch;
            filters.date = {
                [relation === 'before' || relation === 'until' ? '$lt' : '$gte']: new Date(dateStr)
            };
        }
        
        // Size filters
        const sizeMatch = query.match(/\b(larger|smaller|bigger|greater|less)\s+than\s+(\d+)\s*(lines|bytes|kb|mb)\b/i);
        if (sizeMatch) {
            const [, comparison, size, unit] = sizeMatch;
            const sizeNum = parseInt(size);
            let multiplier = 1;
            
            if (unit === 'kb') multiplier = 1024;
            if (unit === 'mb') multiplier = 1024 * 1024;
            if (unit === 'lines') multiplier = 1; // Assuming one line is roughly 100 bytes
            
            const actualSize = sizeNum * multiplier;
            
            if (!filters.size) filters.size = {};
            filters.size[comparison === 'larger' || comparison === 'bigger' || comparison === 'greater' ? '$gt' : '$lt'] = actualSize;
        }
        
        sq.filters = filters;
        
        // Sorting / grouping
        const sortMatch = query.match(/\bsort by (\w+)(?:\s+(asc|ascending|desc|descending))?\b/i);
        if (sortMatch) {
            sq.sortBy = sortMatch[1];
            if (sortMatch[2]) {
                sq.sortOrder = sortMatch[2].startsWith('asc') ? 'asc' : 'desc';
            }
        }
        
        const groupMatch = query.match(/\bgroup by (\w+)\b/i);
        if (groupMatch) sq.groupBy = groupMatch[1];
        
        // Additional parameters for specific intents
        if (intent.type === 'compare') {
            const compareTargets = this.extractComparisonTargets(query);
            if (compareTargets.length >= 2) {
                if (!sq.parameters) sq.parameters = {};
                sq.parameters.compareTargets = compareTargets;
            }
        }
        
        if (intent.type === 'transform') {
            const transformType = this.extractTransformType(query);
            if (transformType) {
                if (!sq.parameters) sq.parameters = {};
                sq.parameters.transformType = transformType;
            }
        }
        
        return sq;
    }
    
    /**
     * Extract overall context for the query
     */
    private extractQueryContext(query: string): string {
        // Simple heuristic: extract the first and last parts of the query
        const words = query.split(/\s+/);
        if (words.length <= 10) return query;
        
        const firstPart = words.slice(0, 5).join(' ');
        const lastPart = words.slice(-5).join(' ');
        
        return `${firstPart} ... ${lastPart}`;
    }
    
    /**
     * Extract targets for comparison queries
     */
    private extractComparisonTargets(query: string): string[] {
        // Simple pattern: "compare A and B" or "A vs B"
        const comparePattern = /compare\s+(.+?)\s+(?:and|vs|versus)\s+(.+?)(?:\s|$)/i;
        const match = query.match(comparePattern);
        
        if (match) {
            return [match[1].trim(), match[2].trim()];
        }
        
        // Alternative pattern: "difference between A and B"
        const diffPattern = /difference between\s+(.+?)\s+and\s+(.+?)(?:\s|$)/i;
        const diffMatch = query.match(diffPattern);
        
        if (diffMatch) {
            return [diffMatch[1].trim(), diffMatch[2].trim()];
        }
        
        return [];
    }
    
    /**
     * Extract transformation type for transformation queries
     */
    private extractTransformType(query: string): string | null {
        const transformTypes = [
            { pattern: /convert to (\w+)/i, group: 1 },
            { pattern: /transform into (\w+)/i, group: 1 },
            { pattern: /refactor to (\w+)/i, group: 1 },
            { pattern: /change to (\w+)/i, group: 1 }
        ];
        
        for (const { pattern, group } of transformTypes) {
            const match = query.match(pattern);
            if (match) {
                return match[group].trim();
            }
        }
        
        return null;
    }
    // ------------------------------------------------------------------
    // 4. Semantic / AI Fallback
    // ------------------------------------------------------------------
    async fallbackToAI(query: string): Promise<StructuredQuery> {
        const base = this.generateStructuredQuery(query);
        if (base.type === 'nlp_structured_query' && base.confidence !== undefined && base.confidence > 0.5) {
            return base;
        }
        
        // Pattern libraries
        const patterns = [
            { rx: /singleton pattern/i, cfg: { type: 'search', filters: { pattern: 'singleton' } } },
            { rx: /factory pattern/i, cfg: { type: 'search', filters: { pattern: 'factory' } } },
            { rx: /observer pattern/i, cfg: { type: 'search', filters: { pattern: 'observer' } } },
            { rx: /strategy pattern/i, cfg: { type: 'search', filters: { pattern: 'strategy' } } },
            { rx: /adapter pattern/i, cfg: { type: 'search', filters: { pattern: 'adapter' } } },
            { rx: /decorator pattern/i, cfg: { type: 'search', filters: { pattern: 'decorator' } } },
            { rx: /facade pattern/i, cfg: { type: 'search', filters: { pattern: 'facade' } } },
            { rx: /proxy pattern/i, cfg: { type: 'search', filters: { pattern: 'proxy' } } },
            { rx: /command pattern/i, cfg: { type: 'search', filters: { pattern: 'command' } } },
            { rx: /chain of responsibility/i, cfg: { type: 'search', filters: { pattern: 'chain_of_responsibility' } } },
            { rx: /iterator pattern/i, cfg: { type: 'search', filters: { pattern: 'iterator' } } },
            { rx: /mediator pattern/i, cfg: { type: 'search', filters: { pattern: 'mediator' } } },
            { rx: /memento pattern/i, cfg: { type: 'search', filters: { pattern: 'memento' } } },
            { rx: /state pattern/i, cfg: { type: 'search', filters: { pattern: 'state' } } },
            { rx: /template method pattern/i, cfg: { type: 'search', filters: { pattern: 'template_method' } } },
            { rx: /visitor pattern/i, cfg: { type: 'search', filters: { pattern: 'visitor' } } },
            { rx: /composite pattern/i, cfg: { type: 'search', filters: { pattern: 'composite' } } },
            { rx: /builder pattern/i, cfg: { type: 'search', filters: { pattern: 'builder' } } },
            { rx: /dependency injection/i, cfg: { type: 'search', filters: { pattern: 'dependency_injection' } } },
            { rx: /inversion of control/i, cfg: { type: 'search', filters: { pattern: 'inversion_of_control' } } },
            { rx: /explain (.*)/i, cfg: { type: 'semantic', entities: ['$1'] } },
            { rx: /what is (.*)/i, cfg: { type: 'semantic', entities: ['$1'] } },
            { rx: /how does (.*) work/i, cfg: { type: 'semantic', entities: ['$1'] } },
            { rx: /when to use (.*)/i, cfg: { type: 'semantic', entities: ['$1'] } },
            { rx: /why use (.*)/i, cfg: { type: 'semantic', entities: ['$1'] } },
            { rx: /compare (.*) and (.*)/i, cfg: { type: 'compare', entities: ['$1', '$2'] } },
            { rx: /difference between (.*) and (.*)/i, cfg: { type: 'compare', entities: ['$1', '$2'] } },
            { rx: /analyze (.*)/i, cfg: { type: 'analyze', entities: ['$1'] } },
            { rx: /convert (.*) to (.*)/i, cfg: { type: 'transform', entities: ['$1'], parameters: { transformType: '$2' } } },
            { rx: /transform (.*) into (.*)/i, cfg: { type: 'transform', entities: ['$1'], parameters: { transformType: '$2' } } },
            { rx: /refactor (.*) to (.*)/i, cfg: { type: 'transform', entities: ['$1'], parameters: { transformType: '$2' } } }
        ];
        
        for (const { rx, cfg } of patterns) {
            const m = query.match(rx);
            if (m) {
                const entities = cfg.entities?.map((e: string) => {
                    // Replace $1, $2, etc. with captured groups
                    return e.replace(/\$(\d+)/g, (_, i) => m[parseInt(i)] || '');
                });
                
                const parameters = cfg.parameters ? 
                    Object.entries(cfg.parameters).reduce((acc, [key, value]) => {
                        acc[key] = typeof value === 'string' ? 
                            value.replace(/\$(\d+)/g, (_, i) => m[parseInt(i)] || '') : 
                            value;
                        return acc;
                    }, {} as Record<string, any>) : 
                    undefined;
                
                return { 
                    ...base, 
                    ...cfg, 
                    type: cfg.type as IntentType, 
                    entities,
                    parameters
                };
            }
        }
        
        // If no pattern matches, try to extract meaningful entities and default to search
        if (base.entities && base.entities.length > 0) {
            return {
                ...base,
                type: 'search'
            };
        }
        
        // Last resort: return a generic search query
        return {
            ...base,
            type: 'search',
            entities: [query.trim()]
        };
    }
}