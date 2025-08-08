import { tokenize } from '../utils/string-similarity.js';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------
export interface ExtractedEntity {
    text: string;
    type: EntityType;
    confidence: number;
    qualifiers?: string[]; // e.g. "abstract", "deprecated", "async"
}

export type EntityType = 'file' | 'class' | 'interface' | 'struct' | 'enum' | 'function' | 'method' | 'module' | 'package' | 'namespace' | 'variable' | 'constant' | 'unknown';

export interface QueryIntent {
    type: IntentType;
    action?: string;
    modifiers?: string[];
    negations?: string[];
}

export type IntentType = 'search' | 'traverse' | 'filter' | 'aggregate' | 'relationship' | 'semantic' | 'unknown';

export interface StructuredQuery {
    type: IntentType;
    entities?: string[];
    entityTypes?: EntityType[];
    relationTypes?: string[];
    filters?: Record<string, any>;
    depth?: number;
    limit?: number;
    sortBy?: string;
    groupBy?: string;
    originalQuery?: string;
}

// ------------------------------------------------------------------
// Main Class
// ------------------------------------------------------------------
export class NLPQueryProcessor {
    private patterns = {
        file: /\b([\w\-]+\.(ts|js|tsx|jsx|py|java|cpp|c|h|hpp|cs|go|rs|rb|php|swift|kt|scala|r|m|mm|sql|json|xml|yaml|yml|md|txt|css|scss|sass|less|html|htm))\b/gi,
        genericType: /\b(?:class|interface|struct|enum|trait|type)\s+(\w+)|(\w+)(?:Class|Interface|Struct|Enum|Trait|Type)\b/gi,
        function: /\b(?:function|method|func|def|lambda)\s+(\w+)|(\w+)(?:Function|Method|Handler|Callback|Lambda)\b/gi,
        module: /\b(?:module|package|namespace|library)\s+([\w\/\-@]+)|(@?[\w\-]+\/[\w\-]+)\b/gi,
        variable: /\b(?:const|let|var|val)\s+(\w+)|(\$\w+|_\w+)\b/gi,
        constant: /\b[A-Z_][A-Z0-9_]+\b/g
    };

    private intentLexicon = new Map<IntentType, string[]>([
        ['search', ['find', 'search', 'locate', 'show', 'list', 'give me', 'what', 'which']],
        ['traverse', ['from', 'to', 'between', 'path', 'connected', 'related', 'linked', 'depends']],
        ['filter', ['with', 'having', 'containing', 'matching', 'like', 'of type', 'kind']],
        ['aggregate', ['count', 'how many', 'total', 'sum', 'average', 'min', 'max', 'group']],
        ['relationship', ['imports', 'exports', 'extends', 'implements', 'calls', 'uses', 'references']],
        ['semantic', ['explain', 'describe', 'usage', 'purpose', 'why', 'when to use']]
    ]);

    private qualifiers = new Set(['abstract', 'async', 'deprecated', 'private', 'public', 'internal', 'static', 'final', 'override', 'test', 'spec']);

    // ------------------------------------------------------------------
    // 1. Entity Extraction
    // ------------------------------------------------------------------
    extractEntities(query: string): ExtractedEntity[] {
        const entities: ExtractedEntity[] = [];
        const seen = new Set<string>();

        const add = (text: string, type: EntityType, confidence: number, qualifiers: string[]) => {
            const key = `${text}:${type}`.toLowerCase();
            if (!seen.has(key)) {
                entities.push({ text, type, confidence, qualifiers });
                seen.add(key);
            }
        };

        // Patterns
        for (const [type, regex] of Object.entries(this.patterns)) {
            let m;
            while ((m = regex.exec(query)) !== null) {
                const text = m[1] || m[2] || m[0];
                add(text, type as EntityType, 0.9, []);
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
            add(m[0], 'unknown', 0.5, foundQualifiers);
        }

        // Adjust confidence for qualifiers
        entities.forEach(e => {
            if (e.qualifiers?.length) e.confidence += 0.1;
        });

        return entities;
    }

    // ------------------------------------------------------------------
    // 2. Intent Detection
    // ------------------------------------------------------------------
    identifyIntent(query: string): QueryIntent {
        const lower = query.toLowerCase();
        const tokens = tokenize(query);
        let best: QueryIntent = { type: 'unknown' };
        let bestScore = 0;

        for (const [intent, keywords] of this.intentLexicon) {
            let score = 0;
            const matched: string[] = [];
            const negated: string[] = [];

            for (const kw of keywords) {
                if (lower.includes(kw)) {
                    score += 2;
                    matched.push(kw);
                }
            }

            // Negations
            const negationWords = ['no', 'not', 'without', 'exclude', 'except'];
            for (const n of negationWords) {
                if (lower.includes(n)) negated.push(n);
            }

            // Boost for question marks
            if (query.includes('?')) score += 1;

            if (score > bestScore) {
                bestScore = score;
                best = { type: intent, action: matched[0], modifiers: matched.slice(1), negations: negated };
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
        const sq: StructuredQuery = { type: intent.type, originalQuery: query };

        // Entities & types
        if (entities.length) {
            sq.entities = entities.map(e => e.text);
            sq.entityTypes = [...new Set(entities.map(e => e.type).filter(t => t !== 'unknown'))];
            const qualifiers = [...new Set(entities.flatMap(e => e.qualifiers || []))];
            if (qualifiers.length) sq.filters = { qualifiers };
        }

        // Relations
        const relations = ['imports', 'exports', 'extends', 'implements', 'calls', 'uses', 'depends', 'references'];
        const found = relations.filter(r => lower.includes(r));
        if (found.length) sq.relationTypes = found;

        // Numeric parameters
        const depthMatch = query.match(/\b(?:depth|level)\s*(\d+)\b/i);
        if (depthMatch) sq.depth = parseInt(depthMatch[1]);

        const limitMatch = query.match(/\b(?:top|first|limit)\s*(\d+)\b/i);
        if (limitMatch) sq.limit = parseInt(limitMatch[1]);

        // Filters
        const filters: Record<string, any> = { ...(sq.filters || {}) };
        if (lower.includes('test')) filters.isTest = true;
        if (lower.includes('interface')) filters.entityType = 'interface';
        if (lower.includes('abstract')) filters.modifiers = [...(filters.modifiers || []), 'abstract'];
        if (intent.negations?.includes('test')) filters.isTest = false;
        sq.filters = filters;

        // Sorting / grouping
        const sortMatch = query.match(/\bsort by (\w+)\b/i);
        if (sortMatch) sq.sortBy = sortMatch[1];
        const groupMatch = query.match(/\bgroup by (\w+)\b/i);
        if (groupMatch) sq.groupBy = groupMatch[1];

        return sq;
    }

    // ------------------------------------------------------------------
    // 4. Semantic / AI Fallback
    // ------------------------------------------------------------------
    async fallbackToAI(query: string): Promise<StructuredQuery> {
        const base = this.generateStructuredQuery(query);
        if (base.type !== 'unknown') return base;

        // Pattern libraries
        const patterns = [
            { rx: /singleton pattern/i, cfg: { type: 'search', filters: { pattern: 'singleton' } } },
            { rx: /factory pattern/i, cfg: { type: 'search', filters: { pattern: 'factory' } } },
            { rx: /observer pattern/i, cfg: { type: 'search', filters: { pattern: 'observer' } } },
            { rx: /dependency injection/i, cfg: { type: 'search', filters: { pattern: 'dependency_injection' } } },
            { rx: /explain (.*)/i, cfg: { type: 'semantic', entities: ['$1'] } }
        ];

        for (const { rx, cfg } of patterns) {
            const m = query.match(rx);
            if (m) {
                const entities = cfg.entities?.map((e: string) => e === '$1' ? m[1] : e);
                return { ...base, ...cfg, type: cfg.type as IntentType, entities };
            }
        }

        return base;
    }
}