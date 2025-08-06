export interface Entity {
    id: string;
    name: string;
    entityType: string;
    observations?: string[];
    embedding?: number[]; // Vector embedding for the entity
}

export interface SimilarityResult {
    entity: Entity;
    similarity: number;
}

export class EntityResolver {
    private embeddingDimension: number = 384; // Default dimension for models like sentence-transformers/all-MiniLM-L6-v2

    // Resolve ambiguous entities by finding the best match based on context and vector similarity
    async resolveAmbiguousEntity(name: string, context: any): Promise<Entity | null> {
        // Extract context clues
        const contextClues: string[] = [];
        if (context.surroundingText) {
            contextClues.push(context.surroundingText.toLowerCase());
        }
        if (context.entityType) {
            contextClues.push(context.entityType.toLowerCase());
        }
        if (context.relatedEntities && Array.isArray(context.relatedEntities)) {
            contextClues.push(...context.relatedEntities.map((e: any) => e.toLowerCase()));
        }

        // Score based on context matching and vector similarity
        let bestMatch: Entity | null = null;
        let bestScore = 0;

        if (context.candidates && Array.isArray(context.candidates)) {
            for (const candidate of context.candidates) {
                let score = 0;
                const candidateEmbedding = candidate.embedding;

                // Exact name match gets high score
                if (candidate.name.toLowerCase() === name.toLowerCase()) {
                    score += 10;
                }
                // Partial name match
                if (
                    candidate.name.toLowerCase().includes(name.toLowerCase()) ||
                    name.toLowerCase().includes(candidate.name.toLowerCase())
                ) {
                    score += 5;
                }
                // Entity type match
                if (context.entityType && candidate.entityType === context.entityType) {
                    score += 3;
                }

                // Check observations for context clues
                if (candidate.observations && Array.isArray(candidate.observations)) {
                    for (const obs of candidate.observations) {
                        const obsLower = obs.toLowerCase();
                        for (const clue of contextClues) {
                            if (obsLower.includes(clue) || clue.includes(obsLower)) {
                                score += 1;
                            }
                        }
                    }
                }

                // Vector similarity if embeddings are available
                if (candidateEmbedding && context.queryEmbedding) {
                    const vectorSim = this.cosineSimilarity(candidateEmbedding, context.queryEmbedding);
                    score += vectorSim * 10; // Scale vector similarity contribution (0–10)
                }

                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = candidate;
                }
            }
        }

        return bestMatch;
    }

    // Find similar entities using vector search and structural matching
    async findSimilarEntities(
        entity: Entity,
        threshold: number = 0.7,
        useVectorOnly: boolean = false
    ): Promise<SimilarityResult[]> {
        const results: SimilarityResult[] = [];
        const targetEmbedding = entity.embedding;

        if (!targetEmbedding) {
            // Fall back to traditional method if no embedding
            return this.findSimilarEntitiesLegacy(entity, threshold);
        }

        // This would normally query a vector database
        // For now, we assume allEntities with embeddings are passed via context
        const allEntities = (entity as any).allEntities || [];

        for (const candidate of allEntities) {
            if (candidate.id === entity.id) continue;
            if (!candidate.embedding) continue;

            let similarity = 0;

            if (useVectorOnly) {
                // Only use vector similarity
                similarity = this.cosineSimilarity(targetEmbedding, candidate.embedding);
            } else {
                // Hybrid similarity: vector + structural
                const vectorSim = this.cosineSimilarity(targetEmbedding, candidate.embedding);
                similarity += vectorSim * 0.5;

                // Name similarity using Levenshtein
                const nameSim = 1 - this.levenshteinDistance(entity.name, candidate.name) / Math.max(entity.name.length, candidate.name.length);
                similarity += nameSim * 0.2;

                // Entity type match
                if (entity.entityType === candidate.entityType) {
                    similarity += 0.15;
                }

                // Observation overlap (Jaccard)
                if (entity.observations && candidate.observations) {
                    const entityObs = new Set(entity.observations.map((o: string) => o.toLowerCase()));
                    const candidateObs = new Set(candidate.observations.map((o: string) => o.toLowerCase()));
                    const intersection = new Set([...entityObs].filter(x => candidateObs.has(x)));
                    const union = new Set([...entityObs, ...candidateObs]);
                    if (union.size > 0) {
                        const jaccardIndex = intersection.size / union.size;
                        similarity += jaccardIndex * 0.15;
                    }
                }
            }

            if (similarity >= threshold) {
                results.push({ entity: candidate, similarity });
            }
        }

        // Sort by similarity descending
        results.sort((a, b) => b.similarity - a.similarity);
        return results;
    }

    // Legacy method for non-vector fallback
    private async findSimilarEntitiesLegacy(entity: Entity, threshold: number = 0.7): Promise<SimilarityResult[]> {
        const results: SimilarityResult[] = [];
        const allEntities = (entity as any).allEntities || [];

        for (const candidate of allEntities) {
            if (candidate.id === entity.id) continue;
            let similarity = 0;
            let factors = 0;

            // Name similarity using Levenshtein distance
            const nameSim = 1 - (this.levenshteinDistance(entity.name, candidate.name) /
                Math.max(entity.name.length, candidate.name.length));
            similarity += nameSim * 0.4;
            factors += 0.4;

            // Entity type match
            if (entity.entityType === candidate.entityType) {
                similarity += 0.3;
            }
            factors += 0.3;

            // Observation overlap
            if (entity.observations && candidate.observations) {
                const entityObs = new Set(entity.observations.map((o: string) => o.toLowerCase()));
                const candidateObs = new Set(candidate.observations.map((o: string) => o.toLowerCase()));
                const intersection = new Set([...entityObs].filter(x => candidateObs.has(x)));
                const union = new Set([...entityObs, ...candidateObs]);
                if (union.size > 0) {
                    const jaccardIndex = intersection.size / union.size;
                    similarity += jaccardIndex * 0.3;
                }
            }
            factors += 0.3;

            // Normalize similarity
            similarity = similarity / factors;

            if (similarity >= threshold) {
                results.push({ entity: candidate, similarity });
            }
        }

        results.sort((a, b) => b.similarity - a.similarity);
        return results;
    }

    // Cosine similarity between two vectors
    private cosineSimilarity(vecA: number[], vecB: number[]): number {
        if (vecA.length !== vecB.length) {
            throw new Error('Vector dimensions must match');
        }

        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }

        const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
        if (magnitude === 0) return 0;

        return dotProduct / magnitude;
    }

    // Compute embedding (mock function - in practice, call an embedding model API)
    async generateEmbedding(text: string): Promise<number[]> {
        // This is a placeholder. In real use, call a model like:
        // return await fetchEmbeddingFromAPI(text);
        // For now, return a dummy fixed-length vector
        const dummyEmbedding: number[] = [];
        for (let i = 0; i < this.embeddingDimension; i++) {
            // Simple hash-based pseudo-embedding
            const charCode = text
                .split('')
                .reduce((acc, char) => acc + char.charCodeAt(0), 0);
            dummyEmbedding.push(
                Math.sin(i * charCode) % 1 // deterministic pseudo-random
            );
        }
        return dummyEmbedding;
    }

    // Enhanced merge with vector consideration
    async mergeEntities(entities: Entity[]): Promise<Entity> {
        if (entities.length === 0) {
            throw new Error('No entities to merge');
        }
        if (entities.length === 1) {
            return entities[0];
        }

        // Find the most complete entity as base
        let baseEntity = entities[0];
        let maxObservations = baseEntity.observations?.length || 0;
        for (const entity of entities) {
            const obsCount = entity.observations?.length || 0;
            if (obsCount > maxObservations) {
                maxObservations = obsCount;
                baseEntity = entity;
            }
        }

        // Merge observations from all entities
        const allObservations = new Set<string>();
        const nameVariants = new Set<string>();
        const types = new Set<string>();

        let avgEmbedding: number[] | null = null;
        const validEmbeddings = entities.filter(e => e.embedding && e.embedding.length === this.embeddingDimension);

        if (validEmbeddings.length > 0) {
            avgEmbedding = new Array(this.embeddingDimension).fill(0);
            for (const emb of validEmbeddings) {
                for (let i = 0; i < this.embeddingDimension; i++) {
                    avgEmbedding![i] += emb.embedding![i];
                }
            }
            for (let i = 0; i < this.embeddingDimension; i++) {
                avgEmbedding[i] /= validEmbeddings.length;
            }
        }

        for (const entity of entities) {
            nameVariants.add(entity.name);
            types.add(entity.entityType);
            if (entity.observations) {
                entity.observations.forEach(obs => allObservations.add(obs));
            }
        }

        // Add merge metadata
        allObservations.add(`merged_from: ${entities.map(e => e.id).join(', ')}`);
        allObservations.add(`name_variants: ${Array.from(nameVariants).join(', ')}`);

        // Use the most common entity type
        const typeFrequency = new Map<string, number>();
        types.forEach(type => {
            typeFrequency.set(type, (typeFrequency.get(type) || 0) + 1);
        });
        let mergedType = baseEntity.entityType;
        let maxFreq = 0;
        typeFrequency.forEach((freq, type) => {
            if (freq > maxFreq) {
                maxFreq = freq;
                mergedType = type;
            }
        });

        return {
            id: baseEntity.id,
            name: baseEntity.name,
            entityType: mergedType,
            observations: Array.from(allObservations),
            embedding: avgEmbedding || baseEntity.embedding
        };
    }

    // Levenshtein distance for string similarity
    private levenshteinDistance(str1: string, str2: string): number {
        const matrix: number[][] = [];
        for (let i = 0; i <= str2.length; i++) {
            matrix[i] = [i];
        }
        for (let j = 0; j <= str1.length; j++) {
            matrix[0][j] = j;
        }
        for (let i = 1; i <= str2.length; i++) {
            for (let j = 1; j <= str1.length; j++) {
                if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    );
                }
            }
        }
        return matrix[str2.length][str1.length];
    }
}