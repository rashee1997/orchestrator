// src/database/services/gemini-integration-modules/GeminiResponseParsers.ts
/**
 * Robustly extracts a JSON object/array from Gemini's raw text.
 * Handles:
 *   • Markdown fences (` ```json ` or plain ``` )
 *   • Unescaped back‑slashes (Windows paths, stray `\` characters)
 *   • New‑lines inside string values
 *   • Trailing commas
 *   • Control characters
 *
 * Returns the parsed object or throws a descriptive error.
 */
export function parseGeminiJsonResponse(textResponse: string): any {
    try {
        // -----------------------------------------------------------------
        // 1️⃣  Trim & strip any markdown code fences
        // -----------------------------------------------------------------
        let jsonString = textResponse.trim();

        // Detect a markdown block (```json … ``` or just ``` … ```)
        const markdownMatch = jsonString.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (markdownMatch && markdownMatch[1]) {
            jsonString = markdownMatch[1].trim();
        }

        // -----------------------------------------------------------------
        // 2️⃣  Locate the outermost { … } or [ … ] (ignore any leading text)
        // -----------------------------------------------------------------
        const firstBrace = jsonString.indexOf('{');
        const firstBracket = jsonString.indexOf('[');
        let startIdx = -1;
        let endChar = '}';

        if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
            startIdx = firstBrace;
        } else if (firstBracket !== -1) {
            startIdx = firstBracket;
            endChar = ']';
        }

        if (startIdx === -1) {
            throw new Error('No opening brace or bracket found in Gemini response.');
        }

        const lastIdx = jsonString.lastIndexOf(endChar);
        if (lastIdx <= startIdx) {
            throw new Error('Mismatched JSON delimiters in Gemini response.');
        }

        let extracted = jsonString.substring(startIdx, lastIdx + 1);

        // -----------------------------------------------------------------
        // 3️⃣  Clean up problematic characters
        // -----------------------------------------------------------------
        // a) Remove invisible control characters (U+0000‑U+001F, U+007F‑U+009F)
        extracted = extracted.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');

        // b) Escape stray back‑slashes that are NOT part of a valid JSON escape
        //    Valid escapes: \", \\, \/ , \b , \f , \n , \r , \t , \uXXXX
        extracted = extracted.replace(
            /(?<!\\)\\(?!["\\/bfnrtu])/g,
            '\\\\'
        );

        // c) Ensure all internal new‑lines are escaped (JSON strings cannot contain raw \n)
        //    This is safe because we already escaped stray back‑slashes above.
        extracted = extracted.replace(/\n/g, '\\n').replace(/\r/g, '\\r');

        // d) Remove trailing commas (e.g. {"a":1,} or [1,2,])
        let prev: string;
        do {
            prev = extracted;
            extracted = extracted.replace(/,\s*([}\]])/g, '$1');
        } while (extracted !== prev);

        // -----------------------------------------------------------------
        // 4️⃣  Parse
        // -----------------------------------------------------------------
        return JSON.parse(extracted);
    } catch (parseError: any) {
        console.error(
            `⚠️  Gemini JSON parsing failed. Raw response (first 500 chars):\n`,
            textResponse.slice(0, 500)
        );
        throw new Error(
            `Failed to parse Gemini API response. ${parseError.message}`
        );
    }
}