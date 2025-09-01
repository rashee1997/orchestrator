/**
 * Manages rate limiting for API requests to prevent exceeding provider limits.
 */
export class RateLimiter {
    private rateLimits: Map<string, { count: number; resetTime: number }>;
    private maxRequestsPerMinute: number;

    constructor(maxRequestsPerMinute: number = 60) {
        this.rateLimits = new Map();
        this.maxRequestsPerMinute = maxRequestsPerMinute;
    }

    /**
     * Checks if the request for the given identifier is within rate limits.
     * @param identifier Unique identifier for the rate limit (e.g., 'embedding_generation')
     * @throws Error if rate limit is exceeded
     */
    public async checkRateLimit(identifier: string): Promise<void> {
        const now = Date.now();
        const limit = this.rateLimits.get(identifier);

        if (!limit || now > limit.resetTime) {
            // Reset the rate limit
            this.rateLimits.set(identifier, { count: 1, resetTime: now + 60 * 1000 });
            return;
        }

        if (limit.count >= this.maxRequestsPerMinute) {
            const waitTime = limit.resetTime - now;
            throw new Error(`Rate limit exceeded for ${identifier}. Please wait ${Math.ceil(waitTime / 1000)} seconds.`);
        }

        limit.count++;
    }
}
