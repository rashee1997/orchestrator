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

        let extractedJsonString = jsonString.substring(startIndex, lastIndex + 1);

        // Aggressively remove common non-JSON friendly characters/sequences
        // This includes BOM, zero-width spaces, and other non-printable characters.
        // Also ensure consistent newline escaping.
        let cleanedJson = extractedJsonString
            .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // Remove non-printable ASCII and Latin-1 Supplement characters
            .replace(/\\n/g, '\\n') // Ensure newlines are correctly escaped
            .replace(/\\r/g, '\\r') // Ensure carriage returns are correctly escaped
            .replace(/\\t/g, '\\t') // Ensure tabs are correctly escaped
            .replace(/\\b/g, '\\b') // Ensure backspaces are correctly escaped
            .replace(/\\f/g, '\\f'); // Ensure form feeds are correctly escaped

        // This regex attempts to escape unescaped backslashes outside of already valid escape sequences.
        // It's crucial for file paths and other code content that might contain single backslashes.
        // It specifically targets backslashes that are NOT part of a valid JSON escape sequence (e.g., \\", \\n, \\t, etc.)
        // or a unicode escape sequence (\\uXXXX).
        cleanedJson = cleanedJson.replace(/(?<!\\)\\(?!["\\/bfnrtu])/g, '\\\\');

        // Remove trailing commas before parsing - common LLM issue.
        const finalJson = cleanedJson.replace(/,\s*([}\]])/g, '$1');

        return JSON.parse(finalJson);

    } catch (parseError: any) {
        console.error(`Error parsing Gemini API JSON response. Raw response: "${textResponse}". Parse error:`, parseError);
        throw new Error(`Failed to parse Gemini API response. Raw response: "${textResponse.substring(0, 200)}...". Error: ${parseError.message}`);
    }
}
