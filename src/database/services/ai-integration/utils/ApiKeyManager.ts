/**
 * Manages API keys for embedding providers, including loading from environment variables,
 * key rotation, and current key retrieval.
 */
export class ApiKeyManager {
    private apiKeys: string[];
    private currentIndex: number;

    constructor() {
        this.apiKeys = this.loadApiKeys();
        this.currentIndex = 0;
    }

    /**
     * Loads API keys from environment variables.
     * Supports multiple keys with GEMINI_API_KEY, GEMINI_API_KEY2, etc.
     * Also checks GOOGLE_API_KEY variants.
     */
    private loadApiKeys(): string[] {
        const keys: string[] = [];
        let i = 1;

        while (true) {
            const geminiKeyName = `GEMINI_API_KEY${i > 1 ? i : ''}`;
            const googleKeyName = `GOOGLE_API_KEY${i > 1 ? i : ''}`;
            const geminiKey = process.env[geminiKeyName];
            const googleKey = process.env[googleKeyName];

            if (geminiKey) keys.push(geminiKey);
            if (googleKey) keys.push(googleKey);

            if (!geminiKey && !googleKey) break;
            i++;
        }

        if (keys.length === 0) {
            console.warn('No Gemini API keys found. Embedding provider will not be functional.');
        }

        return keys;
    }

    /**
     * Rotates to the next available API key.
     */
    public rotateKey(): void {
        if (this.apiKeys.length > 1) {
            this.currentIndex = (this.currentIndex + 1) % this.apiKeys.length;
        }
    }

    /**
     * Gets the current API key.
     * @throws Error if no keys are available
     */
    public getCurrentKey(): string {
        if (this.apiKeys.length === 0) {
            throw new Error('No API keys available');
        }
        return this.apiKeys[this.currentIndex];
    }

    /**
     * Checks if any API keys are available.
     */
    public hasKeys(): boolean {
        return this.apiKeys.length > 0;
    }
}