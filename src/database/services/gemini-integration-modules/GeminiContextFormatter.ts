import { Part } from "@google/genai";
import { RetrievedCodeContext } from "../CodebaseContextRetrieverService.js";

export function formatRetrievedContextForPrompt(contexts: RetrievedCodeContext[]): Part[] {
    if (!contexts || contexts.length === 0) {
        return [{ text: "No specific codebase context was retrieved for this prompt. The system searched for relevant code snippets, documentation, and knowledge graph entries but found no matches for the current query." }];
    }
    let formatted = "Relevant Codebase Context:\n";
    contexts.forEach((ctx, index) => {
        formatted += `\n--- Context Item ${index + 1} ---\n`;
        formatted += `Type: ${ctx.type}\n`;
        formatted += `Source Path: ${ctx.sourcePath}\n`;
        if (ctx.entityName) {
            formatted += `Entity Name: ${ctx.entityName}\n`;
        }
        if (ctx.relevanceScore) {
            formatted += `Relevance Score: ${ctx.relevanceScore.toFixed(4)}\n`;
        }
        if (ctx.metadata) {
            if (ctx.metadata.startLine && ctx.metadata.endLine) {
                formatted += `Lines: ${ctx.metadata.startLine}-${ctx.metadata.endLine}\n`;
            }
            if (ctx.metadata.language) {
                formatted += `Language: ${ctx.metadata.language}\n`;
            }
            if (ctx.metadata.kgNodeType) {
                formatted += `KG Node Type: ${ctx.metadata.kgNodeType}\n`;
            }
        }
        formatted += `Content:\n\`\`\`${ctx.metadata?.language || 'text'}\n${ctx.content}\n\`\`\`\n`;
    });
    return [{ text: formatted }];
}
