export interface Entity {
    id: string;
    name: string;
    entityType: string;
    observations?: string[];
}

export interface SimilarityResult {
    entity: Entity;
    similarity: number;
}

export class EntityResolver {
    // Resolve ambiguous entities by finding the best match based on context
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
        
        // Score based on context matching
        let bestMatch: Entity | null = null;
        let bestScore = 0;
        
        if (context.candidates && Array.isArray(context.candidates)) {
            for (const candidate of context.candidates) {
                let score = 0;
                
                // Exact name match gets high score
                if (candidate.name.toLowerCase() === name.toLowerCase()) {
                    score += 10;
                }
                
                // Partial name match
                if (candidate.name.toLowerCase().includes(name.toLowerCase()) || 
                    name.toLowerCase().includes(candidate.name.toLowerCase())) {
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
                
                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = candidate;
                }
            }
        }
        
        return bestMatch;
    }

    // Find similar entities using string similarity and structural matching
    async findSimilarEntities(entity: Entity, threshold: number = 0.7): Promise<SimilarityResult[]> {
        const results: SimilarityResult[] = [];
        
        // This would normally query from a database or index
        // For now, we'll implement a basic similarity algorithm
        
        // If we have a list of entities to compare against (passed via entity.observations)
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
        
        // Sort by similarity descending
        results.sort((a, b) => b.similarity - a.similarity);
        
        return results;
    }

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

    // Merge multiple entities into a single entity
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
        
        // Use the most common entity type or the base entity's type
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
            id: baseEntity.id, // Keep the base entity's ID
            name: baseEntity.name, // Keep the base entity's name
            entityType: mergedType,
            observations: Array.from(allObservations)
        };
    }
}

// Utility function for string similarity
function levenshteinDistance(str1: string, str2: string): number {
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
