// Claude Code model configuration based on kilocode implementation

export interface ClaudeCodeModelInfo {
    maxTokens: number;
    contextWindow: number;
    supportsImages: boolean;
    supportsPromptCache: boolean;
    supportsReasoningEffort: boolean;
    supportsReasoningBudget: boolean;
    requiredReasoningBudget: boolean;
    inputPrice: number;  // Per million tokens (0 for subscribers)
    outputPrice: number; // Per million tokens (0 for subscribers)
    description: string;
}

export type ClaudeCodeModelId = keyof typeof claudeCodeModels;

export const claudeCodeDefaultModelId: ClaudeCodeModelId = "claude-sonnet-4-20250514";

export const claudeCodeModels = {
    "claude-sonnet-4-20250514": {
        maxTokens: 8192,
        contextWindow: 200000,
        supportsImages: false, // Claude Code doesn't support images
        supportsPromptCache: true,
        supportsReasoningEffort: false,
        supportsReasoningBudget: false,
        requiredReasoningBudget: false,
        inputPrice: 3.0,  // $3 per million tokens (API users)
        outputPrice: 15.0, // $15 per million tokens (API users)
        description: "Claude Sonnet 4 - Balanced intelligence and speed"
    },
    "claude-opus-4-1-20250805": {
        maxTokens: 8192,
        contextWindow: 200000,
        supportsImages: false,
        supportsPromptCache: true,
        supportsReasoningEffort: false,
        supportsReasoningBudget: false,
        requiredReasoningBudget: false,
        inputPrice: 15.0,  // $15 per million tokens
        outputPrice: 75.0, // $75 per million tokens
        description: "Claude Opus 4.1 - Most capable model for complex tasks"
    },
    "claude-opus-4-20250514": {
        maxTokens: 8192,
        contextWindow: 200000,
        supportsImages: false,
        supportsPromptCache: true,
        supportsReasoningEffort: false,
        supportsReasoningBudget: false,
        requiredReasoningBudget: false,
        inputPrice: 15.0,  // $15 per million tokens
        outputPrice: 75.0, // $75 per million tokens
        description: "Claude Opus 4 - Maximum intelligence for complex reasoning"
    },
    "claude-3-7-sonnet-20250219": {
        maxTokens: 8192,
        contextWindow: 200000,
        supportsImages: false,
        supportsPromptCache: true,
        supportsReasoningEffort: false,
        supportsReasoningBudget: false,
        requiredReasoningBudget: false,
        inputPrice: 3.0,  // $3 per million tokens
        outputPrice: 15.0, // $15 per million tokens
        description: "Claude 3.7 Sonnet - Enhanced reasoning capabilities"
    },
    "claude-3-5-sonnet-20241022": {
        maxTokens: 8192,
        contextWindow: 200000,
        supportsImages: false,
        supportsPromptCache: true,
        supportsReasoningEffort: false,
        supportsReasoningBudget: false,
        requiredReasoningBudget: false,
        inputPrice: 3.0,  // $3 per million tokens
        outputPrice: 15.0, // $15 per million tokens
        description: "Claude 3.5 Sonnet - Versatile model for most tasks"
    },
    "claude-3-5-haiku-20241022": {
        maxTokens: 8192,
        contextWindow: 200000,
        supportsImages: false,
        supportsPromptCache: true,
        supportsReasoningEffort: false,
        supportsReasoningBudget: false,
        requiredReasoningBudget: false,
        inputPrice: 0.25, // $0.25 per million tokens
        outputPrice: 1.25, // $1.25 per million tokens
        description: "Claude 3.5 Haiku - Fast and efficient for simple tasks"
    }
} as const satisfies Record<string, ClaudeCodeModelInfo>;

/**
 * Convert model name for Vertex AI if needed
 */
export function getClaudeCodeModelId(baseModelId: ClaudeCodeModelId, useVertex = false): string {
    if (!useVertex) return baseModelId;

    const VERTEX_DATE_PATTERN = /-(\d{8})$/;
    return baseModelId.replace(VERTEX_DATE_PATTERN, "@$1");
}

/**
 * Get model information
 */
export function getModelInfo(modelId: ClaudeCodeModelId): ClaudeCodeModelInfo {
    return claudeCodeModels[modelId];
}

/**
 * Get available models
 */
export function getAvailableModels(): ClaudeCodeModelId[] {
    return Object.keys(claudeCodeModels) as ClaudeCodeModelId[];
}

/**
 * Check if model exists
 */
export function isValidModel(modelId: string): modelId is ClaudeCodeModelId {
    return modelId in claudeCodeModels;
}

/**
 * Get default configuration
 */
export const CLAUDE_CODE_CONFIG = {
    defaultModel: claudeCodeDefaultModelId,
    defaultMaxOutputTokens: 16000,
    timeout: 600000, // 10 minutes

    // Model categories by use case
    categories: {
        fast: ["claude-3-5-haiku-20241022"] as ClaudeCodeModelId[],
        balanced: ["claude-sonnet-4-20250514", "claude-3-5-sonnet-20241022", "claude-3-7-sonnet-20250219"] as ClaudeCodeModelId[],
        complex: ["claude-opus-4-1-20250805", "claude-opus-4-20250514"] as ClaudeCodeModelId[],
    },

    // Authentication types
    authTypes: {
        subscriber: "Subscription (free usage)",
        api: "API Key (paid usage)",
    }
} as const;

/**
 * Get optimal model for task complexity
 */
export function getOptimalClaudeModel(complexity: 'simple' | 'medium' | 'complex'): ClaudeCodeModelId {
    switch (complexity) {
        case 'simple':
            return CLAUDE_CODE_CONFIG.categories.fast[0];
        case 'medium':
            return CLAUDE_CODE_CONFIG.categories.balanced[0];
        case 'complex':
            return CLAUDE_CODE_CONFIG.categories.complex[0];
        default:
            return claudeCodeDefaultModelId;
    }
}

/**
 * Calculate cost for API users (subscribers get free usage)
 */
export function calculateCost(
    modelId: ClaudeCodeModelId,
    inputTokens: number,
    outputTokens: number,
    isSubscriber: boolean = false
): number {
    if (isSubscriber) return 0;

    const model = claudeCodeModels[modelId];
    const inputCost = (inputTokens / 1_000_000) * model.inputPrice;
    const outputCost = (outputTokens / 1_000_000) * model.outputPrice;

    return inputCost + outputCost;
}

/**
 * Get setup instructions
 */
export function getClaudeCodeSetupInstructions(): string {
    return `
🤖 Claude Code Setup Instructions:

1. Install Claude Code CLI:
   Visit: https://docs.anthropic.com/en/docs/claude-code/setup

2. Authentication Options:

   📱 Subscription Users (Free):
   - Sign up for Claude Pro/Team subscription
   - Run: claude auth
   - Free usage with subscription

   🔑 API Users (Paid):
   - Get API key from: https://console.anthropic.com
   - Set: export ANTHROPIC_API_KEY="your-key"
   - Pay per token usage

3. Vertex AI (Optional):
   - Set: export CLAUDE_CODE_USE_VERTEX=1
   - Requires Google Cloud setup

4. Verify Installation:
   Run: claude --version

Benefits:
• Advanced reasoning capabilities
• Tool integration support
• Prompt caching for efficiency
• Streaming responses
• Both free (subscription) and paid (API) options
    `.trim();
}