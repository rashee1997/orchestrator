import { RetrievedCodeContext } from '../database/services/CodebaseContextRetrieverService.js';
import { createHash } from 'crypto';

/**
 * Enhanced de-duplication with semantic similarity and content hashing.
 * Uses multiple strategies to identify and remove duplicate context items.
 */
export function deduplicateContexts(contexts: RetrievedCodeContext[]): RetrievedCodeContext[] {
    if (contexts.length === 0) return contexts;

    const seenIdentifiers = new Set<string>();
    const uniqueContexts: RetrievedCodeContext[] = [];
    const contentHashes = new Map<string, RetrievedCodeContext>();

    for (const context of contexts) {
        // Strategy 1: Source path + entity name + content hash (most specific)
        const contentHash = createHash('md5').update(context.content).digest('hex').substring(0, 8);
        const primaryKey = `${context.sourcePath}::${context.entityName || 'N/A'}::${contentHash}`;

        if (!seenIdentifiers.has(primaryKey)) {
            seenIdentifiers.add(primaryKey);
            uniqueContexts.push(context);
            contentHashes.set(contentHash, context);
            continue;
        }

        // Strategy 2: Semantic similarity check for near-duplicates
        const existingContext = contentHashes.get(contentHash);
        if (existingContext) {
            // Keep the one with higher relevance score
            const existingScore = existingContext.relevanceScore || 0;
            const currentScore = context.relevanceScore || 0;

            if (currentScore > existingScore) {
                // Replace existing with current (higher score)
                const existingIndex = uniqueContexts.findIndex(c => c === existingContext);
                if (existingIndex !== -1) {
                    uniqueContexts[existingIndex] = context;
                }
            }
            // Skip adding current if existing has higher or equal score
            continue;
        }

        // Strategy 3: Fallback to source path + start line (original logic)
        const fallbackKey = `${context.sourcePath}::${context.metadata?.startLine || 0}`;
        if (!seenIdentifiers.has(fallbackKey)) {
            seenIdentifiers.add(fallbackKey);
            uniqueContexts.push(context);
        }
    }

    return uniqueContexts;
}

/**
 * Advanced deduplication with configurable similarity threshold.
 * Uses Jaccard similarity for content comparison.
 */
export function deduplicateContextsAdvanced(
    contexts: RetrievedCodeContext[],
    similarityThreshold: number = 0.85
): RetrievedCodeContext[] {
    if (contexts.length === 0) return contexts;

    const uniqueContexts: RetrievedCodeContext[] = [];
    const processedContents = new Set<string>();

    // Sort by relevance score descending to prioritize high-quality contexts
    const sortedContexts = [...contexts].sort((a, b) =>
        (b.relevanceScore || 0) - (a.relevanceScore || 0)
    );

    for (const context of sortedContexts) {
        const content = context.content.toLowerCase();
        let isDuplicate = false;

        // Check against already processed contents
        for (const processedContent of processedContents) {
            const similarity = calculateJaccardSimilarity(content, processedContent);
            if (similarity >= similarityThreshold) {
                isDuplicate = true;
                break;
            }
        }

        if (!isDuplicate) {
            uniqueContexts.push(context);
            processedContents.add(content);
        }
    }

    return uniqueContexts;
}

/**
 * Calculate Jaccard similarity between two strings.
 * Used for semantic deduplication.
 */
function calculateJaccardSimilarity(text1: string, text2: string): number {
    const words1 = new Set(text1.split(/\s+/).filter(w => w.length > 2));
    const words2 = new Set(text2.split(/\s+/).filter(w => w.length > 2));

    const intersection = new Set([...words1].filter(w => words2.has(w)));
    const union = new Set([...words1, ...words2]);

    return intersection.size / union.size;
}

/**
 * Batch deduplication for large context arrays.
 * Processes contexts in chunks to avoid memory issues.
 */
export function deduplicateContextsBatch(
    contexts: RetrievedCodeContext[],
    batchSize: number = 1000
): RetrievedCodeContext[] {
    if (contexts.length <= batchSize) {
        return deduplicateContexts(contexts);
    }

    const result: RetrievedCodeContext[] = [];
    const seenKeys = new Set<string>();

    for (let i = 0; i < contexts.length; i += batchSize) {
        const batch = contexts.slice(i, i + batchSize);
        const deduplicatedBatch = deduplicateContexts(batch);

        // Cross-batch deduplication
        const filteredBatch = deduplicatedBatch.filter(context => {
            const key = `${context.sourcePath}::${context.entityName || 'N/A'}`;
            if (seenKeys.has(key)) {
                return false;
            }
            seenKeys.add(key);
            return true;
        });

        result.push(...filteredBatch);
    }

    return result;
}
