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
        return JSON.parse(jsonString);
    } catch (parseError: any) {
        console.error(`Error parsing Gemini API JSON response. Raw response: "${textResponse}". Parse error:`, parseError);
        throw new Error(`Failed to parse Gemini API response. Raw response: "${textResponse.substring(0,200)}...". Error: ${parseError.message}`);
    }
}
