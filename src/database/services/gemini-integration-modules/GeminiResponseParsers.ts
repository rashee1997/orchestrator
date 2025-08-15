export function parseGeminiJsonResponse(textResponse: string): any {
    try {
        let jsonString = textResponse;
        const jsonMatch = textResponse.match(/```json\n([\s\S]*?)\n```/);
        if (jsonMatch && jsonMatch[1]) {
            jsonString = jsonMatch[1];
        } else if (!(jsonString.startsWith("{") && jsonString.endsWith("}"))) {
            const firstBrace = jsonString.indexOf('{');
            const lastBrace = jsonString.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                jsonString = jsonString.substring(firstBrace, lastBrace + 1);
            } else {
                throw new Error("Response from Gemini was not in a recognizable JSON format.");
            }
        }
        // Remove single-line comments (// ...) that might be present in the JSON string
        jsonString = jsonString.replace(/\/\/.*$/gm, '');

        // Attempt to fix common JSON parsing issues: unescaped newlines, tabs, etc. within string literals
        // This is a heuristic and might not cover all cases, but targets common LLM output issues.
        // It looks for unescaped newlines or tabs within double-quoted strings and escapes them.
        jsonString = jsonString.replace(/\"([^\"\\]*(?:\\.[^\"\\]*)*)\"/g, (match, p1) => {
            // p1 is the content inside the quotes
        return '"' + p1.replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r') + '"';
        });

        // Remove any remaining invalid control characters that JSON.parse would reject
        // (ASCII 0-31, excluding tab \t, newline \n, carriage return \r which are handled by JSON.parse when escaped)
        jsonString = jsonString.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

        return JSON.parse(jsonString);
    } catch (parseError: any) {
        console.error(`Error parsing Gemini API JSON response. Raw response: "${textResponse}". Parse error:`, parseError);
        throw new Error(`Failed to parse Gemini API response. Raw response: "${textResponse.substring(0,200)}...". Error: ${parseError.message}`);
    }
}
