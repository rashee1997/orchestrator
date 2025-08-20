export function parseGeminiJsonResponse(textResponse: string): any {
    try {
        let jsonString = textResponse.trim();

        // 1. Extract content from markdown block if present. Handles variations like ```json{...}
        const markdownMatch = jsonString.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (markdownMatch && markdownMatch[1]) {
            jsonString = markdownMatch[1].trim();
        }

        // 2. Isolate the main JSON object/array to handle extraneous text and truncation.
        const firstBrace = jsonString.indexOf('{');
        const firstBracket = jsonString.indexOf('[');
        let startIndex = -1;

        if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
            startIndex = firstBrace;
        } else if (firstBracket !== -1) {
            startIndex = firstBracket;
        }

        if (startIndex === -1) {
            throw new Error("Could not find start of JSON object or array in response.");
        }

        const endChar = jsonString.charAt(startIndex) === '{' ? '}' : ']';
        const lastIndex = jsonString.lastIndexOf(endChar);

        if (lastIndex <= startIndex) {
            throw new Error("Mismatched JSON delimiters; response may be truncated.");
        }

        let dirtyJson = jsonString.substring(startIndex, lastIndex + 1);

        // 3. Clean unescaped control characters within string literals.
        let cleanedJson = '';
        let inString = false;
        let isEscaped = false;
        for (const char of dirtyJson) {
            if (isEscaped) {
                cleanedJson += char;
                isEscaped = false;
                continue;
            }

            if (char === '\\') {
                cleanedJson += char;
                isEscaped = true;
                continue;
            }

            if (char === '"') {
                inString = !inString;
            }

            if (inString) {
                if (char === '\n') cleanedJson += '\\n';
                else if (char === '\r') cleanedJson += '\\r';
                else if (char === '\t') cleanedJson += '\\t';
                else if (char === '\b') cleanedJson += '\\b';
                else if (char === '\f') cleanedJson += '\\f';
                else cleanedJson += char;
            } else {
                cleanedJson += char;
            }
        }

        // 4. Remove trailing commas. This is another common LLM error.
        const finalJson = cleanedJson.replace(/,\s*([}\]])/g, '$1');

        return JSON.parse(finalJson);

    } catch (parseError: any) {
        console.error(`Error parsing Gemini API JSON response. Raw response: "${textResponse}". Parse error:`, parseError);
        throw new Error(`Failed to parse Gemini API response. Raw response: "${textResponse.substring(0, 200)}...". Error: ${parseError.message}`);
    }
}
