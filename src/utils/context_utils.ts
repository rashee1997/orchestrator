import { RetrievedCodeContext } from '../database/services/CodebaseContextRetrieverService.js';

/**
 * De-duplicates an array of RetrievedCodeContext objects based on sourcePath and startLine.
 * Assumes sourcePath and startLine uniquely identify a context snippet within a file.
 * @param contexts Array of RetrievedCodeContext to de-duplicate.
 * @returns Array of unique RetrievedCodeContext objects.
 */
export function deduplicateContexts(contexts: RetrievedCodeContext[]): RetrievedCodeContext[] {
    const seenIdentifiers = new Set<string>();
    const uniqueContexts: RetrievedCodeContext[] = [];

    for (const context of contexts) {
        // A more robust deduplication might involve content hashing or range checking,
        // but for now, sourcePath and startLine provide a reasonable identifier for code snippets.
        const identifier = `${context.sourcePath}::${context.metadata?.startLine || 0}`;
        if (!seenIdentifiers.has(identifier)) {
            uniqueContexts.push(context);
            seenIdentifiers.add(identifier);
        }
    }
    return uniqueContexts;
}
