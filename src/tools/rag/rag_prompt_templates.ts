import { ContextRetrievalOptions } from '../../database/services/CodebaseContextRetrieverService.js';

/**
 * Template for the iterative RAG analysis prompt sent to Gemini.
 * This prompt orchestrates the decision-making process for iterative search.
 */
export class RagPromptTemplates {
    /**
     * Generates the analysis prompt for the iterative RAG orchestrator.
     * @param params The parameters for prompt generation
     * @returns The formatted analysis prompt string
     */
    static generateAnalysisPrompt(params: {
        originalQuery: string;
        currentTurn: number;
        maxIterations: string;
        accumulatedContext: string;
        focusString?: string;
        enableWebSearch: boolean;
    }): string {
        const { originalQuery, currentTurn, maxIterations, accumulatedContext, focusString = "", enableWebSearch } = params;
        return `
You are an intelligent search orchestrator. Your goal is to answer the user's original query by iteratively searching a codebase and, if necessary, the web.
Original Query: "${originalQuery}"
Current Search Turn: ${currentTurn} of ${maxIterations}
${focusString}---
Accumulated Context So Far:
${accumulatedContext}
---
Based on the accumulated context, please make a decision. Respond in this exact plain text format:
Decision: [ANSWER|SEARCH_AGAIN|SEARCH_WEB]
Reasoning: [Briefly explain your decision. If searching again, explain what is missing. If searching the web, explain why external info is needed.]
Next Codebase Search Query: [Only if decision is SEARCH_AGAIN, provide a query to find missing code info.]
Next Web Search Query: [Only if decision is SEARCH_WEB, provide a concise query for a web search engine.]
Confidence: [A number between 0 and 1 indicating your confidence in this decision]
---
Instructions:
- If the **accumulated context** (from codebase or web search) is sufficient to fully answer the original query, set "Decision" to "ANSWER".
- If more **codebase** information is needed, set "Decision" to "SEARCH_AGAIN".
- If the query requires **external, real-time, or third-party library information** not found in the code, set "Decision" to "SEARCH_WEB".
- Consider the **relevance and completeness** of the current context. If key information is missing, continue searching.
- Avoid repetitive queries. If you've already searched for similar information, try a different approach.
${enableWebSearch ? '- If you\'ve reached the last turn (' + maxIterations + '), you MUST set "Decision" to "ANSWER".' : '- If you\'ve reached the last turn (' + maxIterations + '), you MUST set "Decision" to "ANSWER".'}
`;
    }

    /**
     * Generates the system instruction for the analysis prompt.
     * @returns The system instruction string
     */
    static generateAnalysisSystemInstruction(): string {
        return `You are a highly precise AI. Your ONLY output must be in the exact plain text format specified in the user's prompt. Do NOT include any conversational text, markdown, or any other characters.`;
    }

    /**
     * Generates a prompt to verify a generated answer against the provided context.
     * @param params The parameters for the verification prompt
     * @returns The formatted verification prompt string
     */
    static generateVerificationPrompt(params: {
        originalQuery: string;
        contextString: string;
        generatedAnswer: string;
    }): string {
        const { originalQuery, contextString, generatedAnswer } = params;
        return `You are an adversarial fact-checker. Your task is to find any claims in the "Proposed Answer" that are NOT supported by the "Context".
                
Original Query: "${originalQuery}"

--- CONTEXT START ---
${contextString}
--- CONTEXT END ---

--- PROPOSED ANSWER START ---
${generatedAnswer}
--- PROPOSED ANSWER END ---

**Verification Steps:**
1.  **Component Check:** First, list all primary classes, services, or functions mentioned in the "Proposed Answer". For each one, verify if it is explicitly defined or mentioned in the "Context".
2.  **Logic Check:** Scrutinize every statement and description of logic in the "Proposed Answer". Verify that the described behavior is exactly what the code in the "Context" shows.

**Your Response:**
-   If all components and all logic in the answer are fully and directly supported by the context, respond ONLY with the word "VERIFIED".
-   If you find ANY component (class, method, etc.) or ANY piece of logic that is not explicitly present in the context, respond with "HALLUCINATION_DETECTED" followed by a list of the specific unsupported claims or invented components.`;
    }

    /**
     * Generates a prompt to generate an answer based on the provided context.
     * @param params The parameters for the answer prompt
     * @returns The formatted answer prompt string
     */
    static generateAnswerPrompt(params: {
        originalQuery: string;
        contextString: string;
        focusString?: string;
    }): string {
        const { originalQuery, contextString, focusString = "" } = params;
        return `Based on the following context, please provide a comprehensive answer to the original query: "${originalQuery}"
${focusString}
Context:
${contextString}
Original Query: "${originalQuery}"
Please provide your answer:`;
    }

    /**
     * Generates focus string based on focus area and analysis points.
     * @param focusArea The focus area for the response
     * @param analysisFocusPoints Specific aspects to focus on
     * @returns The formatted focus string
     */
    static generateFocusString(focusArea?: string, analysisFocusPoints?: string[]): string {
        let focusString = "";
        if (focusArea) {
            if (analysisFocusPoints && analysisFocusPoints.length > 0) {
                focusString = `Focus on the following aspects for your analysis and response:\n` + analysisFocusPoints.map((point: string, index: number) => `${index + 1}.  **${point}**`).join('\n');
            } else {
                switch (focusArea) {
                    case "code_review":
                        focusString = "Focus on all aspects including:\n1.  **Potential Bugs & Errors**\n2.  **Best Practices & Conventions**\n3.  **Performance**\n4.  **Security Vulnerabilities**\n5.  **Readability & Maintainability";
                        break;
                    case "code_explanation":
                        focusString = "Focus on explaining the code clearly and concisely.";
                        break;
                    case "enhancement_suggestions":
                        focusString = "Focus on suggesting improvements and enhancements.";
                        break;
                    case "bug_fixing":
                        focusString = "Focus on identifying and suggesting fixes for bugs.";
                        break;
                    case "refactoring":
                        focusString = "Focus on suggesting refactoring opportunities.";
                        break;
                    case "testing":
                        focusString = "Focus on testing strategies and test case generation.";
                        break;
                    case "documentation":
                        focusString = "Focus on generating or improving documentation.";
                        break;
                    case "code_modularization_orchestration":
                        focusString = "Focus on modularity, architecture, and orchestration patterns.";
                        break;
                    default:
                        focusString = "";
                        break;
                }
            }
            if (focusString) {
                focusString = `--- Focus Area ---\n${focusString}\n\n`;
            }
        }
        return focusString;
    }

    /**
     * Generates a prompt for an LLM to create diverse multi-queries.
     * @param originalQuery The user's original query.
     * @param numQueries The number of diverse queries to generate.
     * @returns A structured prompt string for the LLM.
     */
    static generateDiverseQueriesPrompt(originalQuery: string, numQueries: number = 3): string {
        const promptContent = `
You are an expert query rewriter for a codebase search system.
Your task is to generate ${numQueries} semantically diverse search queries based on the original user query.
These queries should explore different facets or interpretations of the original query to maximize relevant document retrieval.

Original Query: "${originalQuery}"

Generate ${numQueries} diverse queries. Each query should be concise and focused.
Provide the output as a JSON array of strings.
For example: ["query 1", "query 2", "query 3"]
`;
        return promptContent.trim();
    }
}
