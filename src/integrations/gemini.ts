// Gemini summarization utility for correction logs
// This is a stub. Replace with actual Gemini API integration as needed.

export async function summarize_with_gemini({ input, instruction }: { input: string, instruction: string }): Promise<string> {
    // In production, call Gemini API here.
    // For now, just return a mock summary.
    return `SUMMARY (Gemini):\n${instruction}\n${input.substring(0, 500)}...`;
}
