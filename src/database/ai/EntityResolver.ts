import { levenshteinDistance } from '../utils/string-similarity.js';
import { cosineSimilarity } from '../services/gemini-integration-modules/GeminiUtilityFunctions.js';

export interface Entity {
    id: string;
    name: string;
    entityType: string;
    observations?: string[];
    embedding?: number[]; // Vector embedding for the entity
    aliases?: string[]; // Alternative names / synonyms
    metadata?: Record<string, any>; // Flexible metadata map
}

export interface SimilarityResult {
    entity: Entity;
    similarity: number;
}

export interface ResolutionContext {
    surroundingText?: string;
    entityType?: string;
    relatedEntities?: string[];
    queryEmbedding?: number[];
    candidates?: Entity[];
    threshold?: number;
    includePartial?: boolean;
}

export class EntityResolver {
    private embeddingDimension: number = 384;
    private typeHierarchy: Record<string, string[]> = {
        'class': ['interface', 'struct', 'enum', 'type'],
        'function': ['method', 'procedure', 'lambda', 'callback'],
        'module': ['package', 'namespace', 'library', 'component'],
        'file': ['document', 'asset', 'resource']
    };

    // ------------------------------------------------------------
    // 1. Core Resolution
    // ------------------------------------------------------------
    async resolveAmbiguousEntity(name: string, ctx: ResolutionContext): Promise<Entity | null> {
        if (!ctx.candidates?.length) return null;

        const candidates = ctx.includePartial
            ? await this.expandCandidates(ctx.candidates, name)
            : ctx.candidates;

        const scores = candidates.map(candidate => ({
            candidate,
            score: this.computeResolutionScore(name, candidate, ctx)
        }));

        scores.sort((a, b) => b.score - a.score);

        const best = scores[0];
        const threshold = ctx.threshold ?? 50; // Updated default threshold to 50
        return best && best.score >= threshold ? best.candidate : null;
    }

    private computeResolutionScore(name: string, entity: Entity, ctx: ResolutionContext): number {
        let score = 0;
        const normName = name.toLowerCase();

        // Helper: Jaccard similarity for sets of characters
        function jaccardSimilarity(a: string, b: string): number {
            const setA = new Set(a);
            const setB = new Set(b);
            const intersection = new Set([...setA].filter(x => setB.has(x)));
            const union = new Set([...setA, ...setB]);
            return union.size > 0 ? intersection.size / union.size : 0;
        }

        // 1. Name Matching Score (up to 100 for exact, ~45 for fuzzy)
        const allNames = [entity.name, ...(entity.aliases || [])].map(n => n.toLowerCase());
        if (allNames.includes(normName)) {
            score += 100;
        } else {
            const levenshteinSim = Math.max(...allNames.map(n => 1 - levenshteinDistance(n, normName) / Math.max(n.length, normName.length)));
            const jaccardSim = Math.max(...allNames.map(n => jaccardSimilarity(n, normName)));
            const startsWithBonus = Math.max(...allNames.map(n => n.startsWith(normName) ? 0.2 : 0));

            // Smoother length penalty for short strings
            const minLen = Math.min(normName.length, ...allNames.map(n => n.length));
            const lengthPenalty = minLen < 3 ? 0.4 : (minLen < 5 ? 0.7 : 1.0);

            // Combine metrics (weighted average), with bonus
            const combinedSim = (levenshteinSim * 0.7 + jaccardSim * 0.3 + startsWithBonus) * lengthPenalty;

            score += Math.min(1.0, combinedSim) * 45; // Max 45 points from fuzzy match
        }

        // 2. Type Match Score (up to 30 points)
        if (ctx.entityType) {
            const wanted = ctx.entityType.toLowerCase();
            const actual = entity.entityType.toLowerCase();
            if (actual === wanted) score += 30;
            else if (this.typeHierarchy[actual]?.includes(wanted)) score += 15;
            else if (this.typeHierarchy[wanted]?.includes(actual)) score += 10;
        }

        // 3. Contextual Clues Score (up to 25 points)
        const clues = [ctx.surroundingText, ...ctx.relatedEntities ?? []]
            .filter(Boolean)
            .flatMap(s => s!.toLowerCase().split(/\s+/).filter(w => w.length > 2));

        if (clues.length > 0) {
            const obsText = (entity.observations || []).join(' ').toLowerCase();
            let contextMatches = 0;
            for (const clue of new Set(clues)) { // Use Set for unique clues
                if (obsText.includes(clue)) {
                    contextMatches++;
                }
            }
            // 5 points per match, capped at 25.
            score += Math.min(contextMatches * 5, 25);
        }

        // 4. Vector Similarity Score (up to 50 points)
        if (entity.embedding && ctx.queryEmbedding) {
            const sim = cosineSimilarity(entity.embedding, ctx.queryEmbedding);
            score += sim * 50;
        }

        // 5. Metadata Boosters/Penalties
        if (entity.metadata?.popular) score += 20;
        if (entity.metadata?.deprecated) score -= 30; // Increased penalty
        if (entity.metadata?.partialMatch && score < 40) score += 10; // Bonus if it's a weak match otherwise

        return score;
    }

    // Expand partial matches using n-grams and synonyms
    private async expandCandidates(candidates: Entity[], name: string): Promise<Entity[]> {
        const n = 3;
        const grams = new Set<string>();
        for (let i = 0; i <= name.length - n; i++) grams.add(name.slice(i, i + n).toLowerCase());

        const expanded: Entity[] = [];
        for (const c of candidates) {
            expanded.push(c);
            const hay = c.name.toLowerCase();
            for (const g of grams) {
                if (hay.includes(g)) {
                    expanded.push({ ...c, metadata: { ...c.metadata, partialMatch: true } });
                    break;
                }
            }
        }
        return [...new Map(expanded.map(e => [e.id, e])).values()];
    }

    // ------------------------------------------------------------
    // 2. Similarity Search
    // ------------------------------------------------------------
    async findSimilarEntities(
        entity: Entity,
        threshold = 0.7,
        opts: { useVectorOnly?: boolean; max?: number } = {}
    ): Promise<SimilarityResult[]> {
        const allEntities = (entity as any).allEntities || [];
        if (!allEntities.length) return [];

        const results: SimilarityResult[] = [];
        for (const candidate of allEntities) {
            if (candidate.id === entity.id) continue;
            const sim = opts.useVectorOnly
                ? cosineSimilarity(entity.embedding || [], candidate.embedding || [])
                : this.hybridSimilarity(entity, candidate);
            if (sim >= threshold) results.push({ entity: candidate, similarity: sim });
        }
        results.sort((a, b) => b.similarity - a.similarity);
        return opts.max ? results.slice(0, opts.max) : results;
    }

    private hybridSimilarity(a: Entity, b: Entity): number {
        let score = 0;
        let weight = 0;

        // Vector
        if (a.embedding && b.embedding) {
            score += cosineSimilarity(a.embedding, b.embedding) * 0.4;
            weight += 0.4;
        }

        // Name
        const nameSim = 1 - levenshteinDistance(a.name, b.name) / Math.max(a.name.length, b.name.length);
        score += nameSim * 0.25;
        weight += 0.25;

        // Type
        if (a.entityType === b.entityType) {
            score += 0.15;
            weight += 0.15;
        }

        // Observations Jaccard
        const obsA = new Set((a.observations || []).map(o => o.toLowerCase()));
        const obsB = new Set((b.observations || []).map(o => o.toLowerCase()));
        const union = new Set([...obsA, ...obsB]);
        if (union.size) {
            const inter = new Set([...obsA].filter(x => obsB.has(x)));
            score += (inter.size / union.size) * 0.2;
            weight += 0.2;
        }

        return weight ? score / weight : 0;
    }

    // ------------------------------------------------------------
    // 3. Embeddings
    // ------------------------------------------------------------
    async generateEmbedding(text: string): Promise<number[]> {
        // In real life call out to a model service
        const vec = new Array(this.embeddingDimension).fill(0);
        let hash = 0;
        for (let i = 0; i < text.length; i++) {
            const chr = text.charCodeAt(i);
            hash = ((hash << 5) - hash + chr) & 0xffffffff;
        }
        for (let i = 0; i < vec.length; i++) {
            vec[i] = Math.sin(i * hash) % 1;
        }
        return vec;
    }

    // ------------------------------------------------------------
    // 4. Merging
    // ------------------------------------------------------------
    async mergeEntities(entities: Entity[]): Promise<Entity> {
        if (!entities.length) throw new Error('No entities to merge');
        if (entities.length === 1) return entities[0];

        // Pick the richest entity as base
        const base = entities.reduce((best, cur) => {
            const score = (cur.observations?.length || 0) + (cur.aliases?.length || 0);
            return score > ((best.observations?.length || 0) + (best.aliases?.length || 0)) ? cur : best;
        });

        const merged: Entity = {
            id: base.id,
            name: base.name,
            entityType: this.mostCommon(entities.map(e => e.entityType)),
            aliases: [...new Set([base.name, ...(base.aliases || []), ...entities.flatMap(e => [e.name, ...(e.aliases || [])])])],
            observations: [...new Set(entities.flatMap(e => e.observations || []))],
            metadata: { mergedFrom: entities.map(e => e.id) }
        };

        // Average embeddings
        const validEmbeddings = entities.filter(e => e.embedding && e.embedding.length === this.embeddingDimension);
        if (validEmbeddings.length) {
            const avg = new Array(this.embeddingDimension).fill(0);
            for (const emb of validEmbeddings) {
                for (let i = 0; i < this.embeddingDimension; i++) avg[i] += emb.embedding![i];
            }
            for (let i = 0; i < this.embeddingDimension; i++) avg[i] /= validEmbeddings.length;
            merged.embedding = avg;
        }

        return merged;
    }

    private mostCommon(arr: string[]): string {
        const freq: Record<string, number> = {};
        for (const item of arr) freq[item] = (freq[item] || 0) + 1;
        return Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0] || arr[0];
    }
}