// src/utils/CommitMessageAI.ts
import { GeminiIntegrationService } from '../database/services/GeminiIntegrationService.js';

export interface CommitMessageOptions {
    differentFromPrevious?: string;  // Previous commit message to generate different from
    customInstructions?: string;     // Additional custom instructions
    conventionalCommits?: boolean;   // Use conventional commits format
    maxLength?: number;              // Maximum commit message length
    verbose?: boolean;               // Generate detailed multi-line commit messages
}

export class CommitMessageAI {
    private geminiService: GeminiIntegrationService;

    constructor(geminiService: GeminiIntegrationService) {
        this.geminiService = geminiService;
    }

    public async generateCommitMessage(
        gitContext: string,
        options: CommitMessageOptions = {}
    ): Promise<string> {
        const prompt = this.buildCommitMessagePrompt(gitContext, options);

        try {
            const response = await this.geminiService.askGemini(prompt);
            // Extract text content from the response
            const textContent = response.content
                .filter(part => part.text)
                .map(part => part.text)
                .join('\n');
            return this.extractCommitMessage(textContent);
        } catch (error) {
            throw new Error(`Failed to generate commit message: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /** Build the final prompt sent to Gemini. Handles verbose mode, custom instructions,
     *  “different‑from‑previous” logic and optional diff‑size limiting. */
    private buildCommitMessagePrompt(gitContext: string, options: CommitMessageOptions): string {
        const {
            differentFromPrevious,
            customInstructions = '',
            conventionalCommits = true,
            maxLength = 1500,
            verbose = false
        } = options;

        let basePrompt = this.getBaseCommitPrompt(conventionalCommits, maxLength);

        // --------------------------------------------------------------------
        // Verbose mode
        // --------------------------------------------------------------------
        if (verbose) {
            basePrompt += `\n\n## VERBOSE MODE ENABLED\nGenerate a detailed multi‑line commit message. It **MUST** contain:\n1. **A concise summary line** (≤ ${maxLength} characters).\n2. **A body** (after a blank line) that explains the motivation, problem solved, implementation highlights and any impact.\nUse professional language and keep the body wrapped at ~72 chars per line.`;
        }

        // --------------------------------------------------------------------
        // “Different from previous” enforcement
        // --------------------------------------------------------------------
        if (differentFromPrevious) {
            const diffPrefix = [
                '# CRITICAL INSTRUCTION: GENERATE A COMPLETELY DIFFERENT COMMIT MESSAGE',
                `The user supplied a previous message: "${differentFromPrevious}"`,
                'You MUST produce a new message that differs in wording, focus, and structure.',
                'Consider alternative scopes, types, or a different angle on the change.'
            ].join('\n');
            basePrompt = `${diffPrefix}\n\n${basePrompt}\n\nFINAL REMINDER: The new message must be **completely different** from the previous one.`;
        }

        // --------------------------------------------------------------------
        // Custom user instructions
        // --------------------------------------------------------------------
        if (customInstructions) {
            basePrompt += `\n\n## Custom Instructions:\n${customInstructions}`;
        }

        // --------------------------------------------------------------------
        // Git context (already formatted by GitService)
        // --------------------------------------------------------------------
        basePrompt += `\n\n## Git Context:\n${gitContext}\n\nPlease generate a commit message that satisfies the above constraints.`;

        return basePrompt;
    }

    private getBaseCommitPrompt(conventionalCommits: boolean, maxLength: number): string {
        if (conventionalCommits) {
            return `# Conventional Commit Message Generator
## System Instructions
You are an expert Git commit message generator that creates conventional commit messages based on staged changes. Analyze the provided git diff output and generate appropriate conventional commit messages following the specification.

## CRITICAL: Commit Message Output Rules
- DO NOT include any memory bank status indicators like "[Memory Bank: Active]" or "[Memory Bank: Missing]"
- DO NOT include any task-specific formatting or artifacts from other rules
- ONLY Generate a clean conventional commit message as specified below

## Conventional Commits Format
Generate commit messages following this exact structure:
\`\`\`
<type>[optional scope]: <description>
[optional body]
[optional footer(s)]
\`\`\`

### Core Types (Required)
- **feat**: New feature or functionality (MINOR version bump)
- **fix**: Bug fix or error correction (PATCH version bump)

### Additional Types (Extended)
- **docs**: Documentation changes only
- **style**: Code style changes (whitespace, formatting, semicolons, etc.)
- **refactor**: Code refactoring without feature changes or bug fixes
- **perf**: Performance improvements
- **test**: Adding or fixing tests
- **build**: Build system or external dependency changes
- **ci**: CI/CD configuration changes
- **chore**: Maintenance tasks, tooling changes
- **revert**: Reverting previous commits

### Scope Guidelines
- Use parentheses: \`feat(api):\`, \`fix(ui):\`
- Common scopes: \`api\`, \`ui\`, \`auth\`, \`db\`, \`config\`, \`deps\`, \`docs\`
- For monorepos: package or module names
- Keep scope concise and lowercase

### Description Rules
- Imperative mood, lowercase start, no period at end.
- Max ${maxLength} characters. Concise and descriptive.

### Body Guidelines (Optional)
- Start one blank line after description
- Explain the "what" and "why", not the "how"
- Wrap at 72 characters per line
- Use for complex changes requiring explanation

### Footer Guidelines (Optional)
- Start one blank line after body
- **Breaking Changes**: \`BREAKING CHANGE: description\`

## Analysis Instructions
When analyzing staged changes:
1. Determine Primary Type based on the nature of changes
2. Identify Scope from modified directories or modules
3. Craft Description focusing on the most significant change
4. Determine if there are Breaking Changes
5. For complex changes, include a detailed body explaining what and why
6. Add appropriate footers for issue references or breaking changes

For significant changes, include a detailed body explaining the changes.

**Multi-line Format for Complex Changes (if verbose):**
For substantial changes, use this format:
\`\`\`
<type>[optional scope]: <summary>

<detailed body explaining what and why>
\`\`\`

- Summary line: concise, max ${maxLength} chars.
- Body: detailed explanation (what & why) after blank line, wrapped at 72 chars.

Return ONLY the commit message in the conventional format, nothing else.`;
        } else {
            return `# Git Commit Message Generator
## System Instructions
You are an expert software engineer tasked with generating high-quality git commit messages based on code changes.

## Guidelines:
1. **Keep the message under ${maxLength} characters**
2. **Use present tense, imperative mood** (e.g., "Add" not "Added" or "Adds")
3. **Start with a capital letter**
4. **Be specific and descriptive**
5. **Focus on WHAT and WHY, not HOW**
6. **Summarize the most significant changes**

## Analysis Instructions
When analyzing changes:
1. Identify the primary purpose of the changes
2. Focus on the most impactful modifications
3. Consider the user-facing impact
4. Craft a clear, concise message

## Good Examples:
- \`Add user authentication system\`
- \`Fix memory leak in image processing\`
- \`Update API documentation for v2.0\`
- \`Refactor database connection handling\`
- \`Remove deprecated utility functions\`

Return ONLY the commit message, nothing else.`;
        }
    }

    private extractCommitMessage(response: string): string {
        // Clean up the response by removing any extra whitespace or formatting
        let cleaned = response.trim();

        // Remove any code block markers
        cleaned = cleaned.replace(/```[a-z]*\n|```/g, '');

        // Remove any prefixes like "Commit message:" or similar, but only if they are at the very beginning
        cleaned = cleaned.replace(/^(commit message:|message:|commit:)\s*/i, '');

        // Remove any quotes or backticks that might wrap the entire message
        // This is done carefully to avoid removing quotes/backticks within the message body
        if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
            cleaned = cleaned.substring(1, cleaned.length - 1);
        } else if (cleaned.startsWith('`') && cleaned.endsWith('`')) {
            cleaned = cleaned.substring(1, cleaned.length - 1);
        }

        return cleaned.trim();
    }

    public async generateMultipleOptions(
        gitContext: string,
        options: CommitMessageOptions = {},
        count: number = 3
    ): Promise<string[]> {
        const messages: string[] = [];

        for (let i = 0; i < count; i++) {
            try {
                const currentOptions = { ...options };

                // For subsequent generations, make them different from previous ones
                if (messages.length > 0) {
                    currentOptions.differentFromPrevious = messages[messages.length - 1];
                }

                const message = await this.generateCommitMessage(gitContext, currentOptions);

                // Avoid duplicates
                if (!messages.includes(message)) {
                    messages.push(message);
                }
            } catch (error) {
                console.warn(`Failed to generate commit message option ${i + 1}:`, error);
            }
        }

        return messages;
    }

    public validateCommitMessage(message: string, options: CommitMessageOptions = {}): {
        isValid: boolean;
        issues: string[];
    } {
        const issues: string[] = [];
        const maxLength = options.maxLength || 1500;

        if (!message || message.trim().length === 0) {
            issues.push('Commit message cannot be empty');
        }

        if (message.length > maxLength) {
            issues.push(`Commit message is too long (${message.length} > ${maxLength} characters)`);
        }

        if (options.conventionalCommits) {
            const conventionalPattern = /^(feat|fix|docs|style|refactor|test|chore|perf|ci|build|revert)(\([^)]+\))?: .+/;
            if (!conventionalPattern.test(message)) {
                issues.push('Message does not follow Conventional Commits format');
            }
        }

        // Check for common anti-patterns
        if (message.startsWith('Merge')) {
            issues.push('Commit message appears to be a merge commit message');
        }

        if (message.includes('WIP') || message.includes('TODO')) {
            issues.push('Commit message contains WIP or TODO indicators');
        }

        return {
            isValid: issues.length === 0,
            issues
        };
    }
}
