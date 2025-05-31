interface IndexedNode {
    id: string;
    name: string;
    type: string;
    observations?: string[];
}

interface SearchResult {
    id: string;
    score: number;
    node: IndexedNode;
}

export class FuzzySearchEngine {
    private nodes: Map<string, IndexedNode>;
    private tokenIndex: Map<string, Set<string>>;
    private bigramIndex: Map<string, Set<string>>;
    private trigramIndex: Map<string, Set<string>>;

    constructor() {
        this.nodes = new Map();
        this.tokenIndex = new Map();
        this.bigramIndex = new Map();
        this.trigramIndex = new Map();
    }

    /**
     * Index nodes for fuzzy search
     */
    indexForFuzzySearch(nodes: any[]): void {
        // Clear existing indexes
        this.nodes.clear();
        this.tokenIndex.clear();
        this.bigramIndex.clear();
        this.trigramIndex.clear();

        // Index each node
        for (const node of nodes) {
            const indexedNode: IndexedNode = {
                id: node.id,
                name: node.name,
                type: node.entityType || node.type || 'unknown',
                observations: node.observations || []
            };
            
            this.nodes.set(node.id, indexedNode);
            
            // Index the node name
            this.indexText(node.id, node.name);
            
            // Index observations if present
            if (node.observations && Array.isArray(node.observations)) {
                for (const observation of node.observations) {
                    this.indexText(node.id, observation);
                }
            }
            
            // Index entity type
            if (node.entityType || node.type) {
                this.indexText(node.id, node.entityType || node.type);
            }
        }
    }

    /**
     * Index text for a specific node ID
     */
    private indexText(nodeId: string, text: string): void {
        if (!text || typeof text !== 'string') return;
        
        const normalizedText = this.normalizeText(text);
        
        // Token-based indexing
        const tokens = this.tokenize(normalizedText);
        for (const token of tokens) {
            if (!this.tokenIndex.has(token)) {
                this.tokenIndex.set(token, new Set());
            }
            this.tokenIndex.get(token)!.add(nodeId);
        }
        
        // N-gram indexing for fuzzy matching
        const bigrams = this.generateNGrams(normalizedText, 2);
        for (const bigram of bigrams) {
            if (!this.bigramIndex.has(bigram)) {
                this.bigramIndex.set(bigram, new Set());
            }
            this.bigramIndex.get(bigram)!.add(nodeId);
        }
        
        const trigrams = this.generateNGrams(normalizedText, 3);
        for (const trigram of trigrams) {
            if (!this.trigramIndex.has(trigram)) {
                this.trigramIndex.set(trigram, new Set());
            }
            this.trigramIndex.get(trigram)!.add(nodeId);
        }
    }

    /**
     * Perform fuzzy search
     */
    search(query: string, threshold: number = 0.3): string[] {
        if (!query || typeof query !== 'string') return [];
        
        const normalizedQuery = this.normalizeText(query);
        const queryTokens = this.tokenize(normalizedQuery);
        const queryBigrams = this.generateNGrams(normalizedQuery, 2);
        const queryTrigrams = this.generateNGrams(normalizedQuery, 3);
        
        const candidateScores = new Map<string, number>();
        
        // Score based on exact token matches
        for (const token of queryTokens) {
            const exactMatches = this.tokenIndex.get(token);
            if (exactMatches) {
                for (const nodeId of exactMatches) {
                    candidateScores.set(nodeId, (candidateScores.get(nodeId) || 0) + 1.0);
                }
            }
            
            // Partial token matches
            for (const [indexedToken, nodeIds] of this.tokenIndex) {
                if (indexedToken.includes(token) || token.includes(indexedToken)) {
                    const similarity = this.calculateStringSimilarity(token, indexedToken);
                    if (similarity > 0.5) {
                        for (const nodeId of nodeIds) {
                            candidateScores.set(nodeId, (candidateScores.get(nodeId) || 0) + similarity * 0.8);
                        }
                    }
                }
            }
        }
        
        // Score based on bigram matches
        for (const bigram of queryBigrams) {
            const matches = this.bigramIndex.get(bigram);
            if (matches) {
                for (const nodeId of matches) {
                    candidateScores.set(nodeId, (candidateScores.get(nodeId) || 0) + 0.3);
                }
            }
        }
        
        // Score based on trigram matches
        for (const trigram of queryTrigrams) {
            const matches = this.trigramIndex.get(trigram);
            if (matches) {
                for (const nodeId of matches) {
                    candidateScores.set(nodeId, (candidateScores.get(nodeId) || 0) + 0.4);
                }
            }
        }
        
        // Calculate final scores and filter by threshold
        const results: SearchResult[] = [];
        for (const [nodeId, rawScore] of candidateScores) {
            const node = this.nodes.get(nodeId);
            if (!node) continue;
            
            // Calculate normalized score based on query complexity
            const maxPossibleScore = queryTokens.length + (queryBigrams.length * 0.3) + (queryTrigrams.length * 0.4);
            const normalizedScore = maxPossibleScore > 0 ? rawScore / maxPossibleScore : 0;
            
            // Apply additional scoring based on full text similarity
            const fullTextScore = this.calculateStringSimilarity(normalizedQuery, this.normalizeText(node.name));
            const finalScore = (normalizedScore * 0.7) + (fullTextScore * 0.3);
            
            if (finalScore >= threshold) {
                results.push({ id: nodeId, score: finalScore, node });
            }
        }
        
        // Sort by score and return IDs
        results.sort((a, b) => b.score - a.score);
        return results.map(r => r.id);
    }

    /**
     * Suggest corrections for misspelled queries
     */
    suggestCorrections(query: string): string[] {
        if (!query || typeof query !== 'string') return [];
        
        const normalizedQuery = this.normalizeText(query);
        const suggestions = new Set<string>();
        
        // Find similar tokens
        const queryTokens = this.tokenize(normalizedQuery);
        for (const queryToken of queryTokens) {
            const similarTokens: Array<{token: string, score: number}> = [];
            
            for (const indexedToken of this.tokenIndex.keys()) {
                const similarity = this.calculateStringSimilarity(queryToken, indexedToken);
                if (similarity > 0.6 && similarity < 1.0) {
                    similarTokens.push({ token: indexedToken, score: similarity });
                }
            }
            
            // Get top 3 similar tokens
            similarTokens.sort((a, b) => b.score - a.score);
            similarTokens.slice(0, 3).forEach(item => {
                // Replace the token in the original query
                const suggestion = normalizedQuery.replace(queryToken, item.token);
                suggestions.add(suggestion);
            });
        }
        
        // Also suggest based on common node names
        const nodeNameSuggestions: Array<{name: string, score: number}> = [];
        for (const node of this.nodes.values()) {
            const similarity = this.calculateStringSimilarity(normalizedQuery, this.normalizeText(node.name));
            if (similarity > 0.5 && similarity < 0.9) {
                nodeNameSuggestions.push({ name: node.name, score: similarity });
            }
        }
        
        nodeNameSuggestions.sort((a, b) => b.score - a.score);
        nodeNameSuggestions.slice(0, 3).forEach(item => suggestions.add(item.name));
        
        return Array.from(suggestions).slice(0, 5);
    }

    /**
     * Normalize text for indexing and searching
     */
    private normalizeText(text: string): string {
        return text
            .toLowerCase()
            .replace(/[^a-z0-9\s_\-\.]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Tokenize text into words
     */
    private tokenize(text: string): string[] {
        return text
            .split(/[\s_\-\.]+/)
            .filter(token => token.length > 0);
    }

    /**
     * Generate n-grams from text
     */
    private generateNGrams(text: string, n: number): string[] {
        const ngrams: string[] = [];
        const cleanText = text.replace(/\s/g, '');
        
        if (cleanText.length < n) {
            return [cleanText];
        }
        
        for (let i = 0; i <= cleanText.length - n; i++) {
            ngrams.push(cleanText.substring(i, i + n));
        }
        
        return ngrams;
    }

    /**
     * Calculate string similarity using Levenshtein distance
     */
    private calculateStringSimilarity(str1: string, str2: string): number {
        const len1 = str1.length;
        const len2 = str2.length;
        
        if (len1 === 0 || len2 === 0) {
            return 0;
        }
        
        // Create a 2D array for dynamic programming
        const dp: number[][] = Array(len1 + 1)
            .fill(null)
            .map(() => Array(len2 + 1).fill(0));
        
        // Initialize base cases
        for (let i = 0; i <= len1; i++) {
            dp[i][0] = i;
        }
        for (let j = 0; j <= len2; j++) {
            dp[0][j] = j;
        }
        
        // Fill the dp table
        for (let i = 1; i <= len1; i++) {
            for (let j = 1; j <= len2; j++) {
                const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
                dp[i][j] = Math.min(
                    dp[i - 1][j] + 1,      // deletion
                    dp[i][j - 1] + 1,      // insertion
                    dp[i - 1][j - 1] + cost // substitution
                );
            }
        }
        
        // Calculate similarity score (1 - normalized distance)
        const maxLen = Math.max(len1, len2);
        const distance = dp[len1][len2];
        return 1 - (distance / maxLen);
    }

    /**
     * Get statistics about the index
     */
    getIndexStats(): {
        totalNodes: number;
        totalTokens: number;
        totalBigrams: number;
        totalTrigrams: number;
    } {
        return {
            totalNodes: this.nodes.size,
            totalTokens: this.tokenIndex.size,
            totalBigrams: this.bigramIndex.size,
            totalTrigrams: this.trigramIndex.size
        };
    }

    /**
     * Clear all indexes
     */
    clear(): void {
        this.nodes.clear();
        this.tokenIndex.clear();
        this.bigramIndex.clear();
        this.trigramIndex.clear();
    }
}
