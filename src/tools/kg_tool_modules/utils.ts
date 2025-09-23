import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { MemoryManager } from '../../database/memory_manager.js';
import { GraphTraversalNode } from '../../types/query.js';

/**
 * Creates a canonical absolute path key by normalizing path separators and converting to lowercase.
 * @param absPath - The absolute path to normalize
 * @returns A canonical path key
 */
export function createCanonicalAbsPathKey(absPath: string): string {
    // Normalize to POSIX separators first, then toLowerCase.
    return absPath.replace(/\\/g, '/').toLowerCase();
}

/**
 * Finds the actual file path on disk, considering common extensions.
 * @param basePath - The base path to check
 * @returns The actual file path if found, null otherwise
 */
export async function findActualFilePath(basePath: string): Promise<string | null> {
    // First, try the basePath as is (could have an explicit extension or be extensionless)
    try {
        await fs.access(basePath);
        const stats = await fs.stat(basePath);
        if (stats.isFile()) {
            return basePath.replace(/\\/g, '/');
        }
    } catch (e) {
        /* ignore if exact path doesn't exist or is not a file */
    }

    // If basePath had a common JS/TS extension, strip it to get the base for probing other extensions
    const pathWithoutKnownJsOrTsExtensions = basePath.replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i, '');
    const possibleExtensions = [
        '.ts', '.tsx', '.mts', '.cts', // Prioritize TypeScript family
        '.js', '.jsx', '.mjs', '.cjs', // Then JavaScript family
        '' // Finally, if the original path was extensionless and didn't match above
    ];

    // Probe with common extensions using the (potentially stripped) base name
    for (const ext of possibleExtensions) {
        const fullPath = pathWithoutKnownJsOrTsExtensions + ext;
        try {
            await fs.access(fullPath);
            const stats = await fs.stat(fullPath);
            if (stats.isFile()) {
                return fullPath.replace(/\\/g, '/');
            }
        } catch (e) {
            /* ignore */
        }
    }

    return null;
}

/**
 * Compares observation arrays to determine if they have changed.
 * Simplified for better performance and lower complexity.
 * @param oldObs - The old observations array
 * @param newObs - The new observations array
 * @returns True if observations have changed, false otherwise
 */
export function haveObservationsChanged(oldObs: string[] | undefined, newObs: string[]): boolean {
    const oldEffective = oldObs || [];
    if (oldEffective.length !== newObs.length) {
        return true;
    }

    const oldSet = new Set(oldEffective);
    for (const item of newObs) {
        if (!oldSet.has(item)) {
            return true;
        }
    }

    return false;
}


/**
 * Type guard to check if an entity has required name and entityType as strings
 */
export function isValidEntity(entity: any): entity is { name: string; entityType: string; observations?: string[] } {
    return entity && typeof entity.name === 'string' && typeof entity.entityType === 'string';
}

/**
 * Normalises the result payloads returned by knowledge graph manager operations so callers can
 * consistently count successful entries regardless of the backend implementation (Kuzu vs legacy).
 */
export function countSuccessfulOperations(result: any): number {
    if (Array.isArray(result)) {
        return result.filter(item => item && item.success !== false).length;
    }
    if (result && Array.isArray(result.details)) {
        return result.details.filter((item: any) => item && item.success !== false).length;
    }
    return 0;
}

export interface CachedGraphNode extends GraphTraversalNode {}

export type NodeCache = Map<string, CachedGraphNode[]>;

export function getCachedNode(cache: NodeCache, name: string, entityType: string): CachedGraphNode | undefined {
    const nodes = cache.get(name);
    return nodes?.find(node => node.entityType === entityType);
}

export function upsertCacheNode(cache: NodeCache, node: CachedGraphNode): void {
    if (!cache.has(node.name)) {
        cache.set(node.name, []);
    }
    const list = cache.get(node.name)!;
    const existingIndex = list.findIndex(existing => existing.entityType === node.entityType);
    if (existingIndex >= 0) {
        list[existingIndex] = node;
    } else {
        list.push(node);
    }
}

export async function preloadExistingNodes(agentId: string, names: string[], memoryManager: MemoryManager): Promise<NodeCache> {
    const uniqueNames = Array.from(new Set(names.filter(Boolean)));
    const cache: NodeCache = new Map();
    const chunkSize = 200;

    for (let i = 0; i < uniqueNames.length; i += chunkSize) {
        const chunk = uniqueNames.slice(i, i + chunkSize);
        if (chunk.length === 0) continue;
        try {
            const existingNodes = await memoryManager.knowledgeGraphManager.openNodes(agentId, chunk);
            for (const node of existingNodes) {
                upsertCacheNode(cache, node);
            }
        } catch (error) {
            console.warn(`[preloadExistingNodes] Failed to preload chunk: ${chunk.join(', ')}`, error);
        }
    }

    return cache;
}

export async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
    const executing: Promise<void>[] = [];

    for (const item of items) {
        const p = worker(item).finally(() => {
            const index = executing.indexOf(p);
            if (index !== -1) {
                executing.splice(index, 1);
            }
        });
        executing.push(p);
        if (executing.length >= limit) {
            await Promise.race(executing);
        }
    }

    await Promise.all(executing);
}

export async function computeFileContentHash(filePath: string): Promise<string> {
    const fileBuffer = await fs.readFile(filePath);
    return createHash('sha1').update(fileBuffer).digest('hex');
}