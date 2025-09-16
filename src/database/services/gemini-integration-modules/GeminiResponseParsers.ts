// src/database/services/gemini-integration-modules/GeminiResponseParsers.ts

import { JSONRepairAgent } from '../JSONRepairAgent.js';
import { MemoryManager } from '../../memory_manager.js';
import { GeminiIntegrationService } from '../GeminiIntegrationService.js';
import { jsonrepair } from 'jsonrepair'; // Add the jsonrepair library
import { LLMJSONParser } from 'ai-json-fixer';

// Global instances for JSON repair (initialized on first use)
let jsonRepairAgent: JSONRepairAgent | null = null;
let memoryManager: MemoryManager | null = null;
let geminiService: GeminiIntegrationService | null = null;

/**
 * Initialize JSON repair agent (called lazily)
 */
function initializeJSONRepairAgent(mm?: MemoryManager, gs?: GeminiIntegrationService): JSONRepairAgent {
  if (!jsonRepairAgent) {
    if (mm && gs) {
      memoryManager = mm;
      geminiService = gs;
    } else if (memoryManager && geminiService) {
      // Use existing instances
    } else {
      console.warn('[JSON Parser] JSON Repair Agent not available - MemoryManager or GeminiService not provided');
      throw new Error('MemoryManager and GeminiIntegrationService required for JSON repair');
    }
    jsonRepairAgent = new JSONRepairAgent(memoryManager!, geminiService!);
  }
  return jsonRepairAgent;
}

/**
 * Quick jsonrepair-based recovery strategy
 */
function attemptJsonRepair(jsonText: string): { success: boolean; data?: any; error?: string } {
  try {
    // Remove code block markers first
    let cleaned = jsonText
      .replace(/```/g, '')
      .trim();

    // Fix HTML entities (common in Gemini responses)
    cleaned = cleaned
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/"/g, '"');

    // Use jsonrepair to fix the JSON
    const repaired = jsonrepair(cleaned);
    const parsed = JSON.parse(repaired);
    
    console.log('[JSON Parser] ✅ jsonrepair recovery successful');
    return { success: true, data: parsed };
  } catch (error: any) {
    console.warn('[JSON Parser] jsonrepair recovery failed:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * AI JSON Fixer recovery strategy using ai-json-fixer library
 */
function attemptAiJsonFixerRepair(jsonText: string): { success: boolean; data?: any; error?: string } {
  try {
    // Remove code block markers first
    let cleaned = jsonText
      .replace(/```/g, '')
      .trim();

    // Fix HTML entities (common in Gemini responses)
    cleaned = cleaned
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/"/g, '"');

    // Use ai-json-fixer to fix the JSON
    const parser = new LLMJSONParser();
    const result = parser.parse(cleaned);
    
    console.log('[JSON Parser] ✅ ai-json-fixer recovery successful');
    return { success: true, data: result };
  } catch (error: any) {
    console.warn('[JSON Parser] ai-json-fixer recovery failed:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Robustly extracts a JSON object/array from Gemini's raw text.
 * Handles:
 * • Markdown fences (```
 * -  Unescaped back‑slashes (Windows paths, stray `\` characters)
 * -  New‑lines inside string values
 * -  Trailing commas
 * -  Control characters
 * -  AI-powered JSON repair for complex cases
 * -  jsonrepair library for automated fixing
 * -  ai-json-fixer library for LLM-specific repairs
 *
 * Returns the parsed object or throws a descriptive error.
 */

/**
 * Pre-sanitizes JSON response text to fix common code content issues
 */
function preSanitizeCodeContent(jsonText: string): string {
  let sanitized = jsonText;
  let sanitizedCount = 0;

  // Phase 1: Fix markdown code blocks in any string field
  // Find all string fields that contain code blocks and fix them
  const stringFieldPattern = /"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  sanitized = sanitized.replace(stringFieldPattern, (match, fieldName, content) => {
    if (content.includes('```')) {
      let cleanedContent = content;
      // Remove markdown code fences
      cleanedContent = cleanedContent
        .replace(/```/g, '');
      
      // Escape JSON special characters properly
      cleanedContent = cleanedContent
        .replace(/\\/g, '\\\\') // Escape backslashes first
        .replace(/"/g, '\\"') // Escape quotes
        .replace(/\n/g, '\\n') // Escape newlines
        .replace(/\r/g, '\\r') // Escape carriage returns
        .replace(/\t/g, '\\t'); // Escape tabs

      sanitizedCount++;
      console.log(`[JSON Parser] Pre-sanitized field "${fieldName}" with code blocks (${content.length} → ${cleanedContent.length} chars)`);
      return `"${fieldName}": "${cleanedContent}"`;
    }
    return match;
  });

  // Phase 2: Fix common JSON escape sequence problems
  // Fix malformed escape sequences that commonly break JSON parsing
  let fixes = 0;

  // Fix unescaped quotes within strings (but not the field delimiters)
  const quoteFixes = (sanitized.match(/"([^"]*[^\\])"([^"]*[^\\])"(?!\s*[,}])/g) || []).length;
  if (quoteFixes > 0) {
    sanitized = sanitized.replace(/"([^"]*[^\\])"([^"]*[^\\])"(?!\s*[,}])/g, '"$1\\"$2"');
    fixes += quoteFixes;
  }

  // Fix malformed backslash sequences
  const backslashPattern = /"([^"]*?)\\(?!["\\nrtbf/u])/g;
  let backslashMatch;
  const backslashMatches: string[] = [];
  while ((backslashMatch = backslashPattern.exec(sanitized)) !== null) {
    backslashMatches.push(backslashMatch[0]);
  }
  if (backslashMatches.length > 0) {
    sanitized = sanitized.replace(backslashPattern, '"$1\\\\');
    fixes += backslashMatches.length;
  }

  // Phase 3: Fix unterminated strings (add missing closing quotes)
  const unterminatedStringPattern = /"[^"]*\n[^"]*/g;
  const unterminatedMatches = sanitized.match(unterminatedStringPattern) || [];
  if (unterminatedMatches.length > 0) {
    sanitized = sanitized.replace(unterminatedStringPattern, match => match + '"');
    fixes += unterminatedMatches.length;
  }

  if (sanitizedCount > 0 || fixes > 0) {
    console.log(`[JSON Parser] Pre-sanitization completed: fixed ${sanitizedCount} code blocks, ${fixes} JSON syntax issues`);
  }

  return sanitized;
}

/**
 * Chunked repair approach for very large JSON responses
 * Breaks the JSON into logical chunks and repairs each chunk incrementally
 */
function attemptChunkedRepair(jsonText: string): { success: boolean; data?: any; error?: string } {
  try {
    const CHUNK_SIZE = 10000; // Process in 10KB chunks
    const OVERLAP_SIZE = 500; // Overlap between chunks to handle split strings
    
    console.log(`[JSON Parser] Attempting chunked repair on ${jsonText.length} character response`);

    // First, try to identify the main structure
    const structureMatch = jsonText.match(/^\s*{\s*"([^"]+)"\s*:/); // Find first field
    if (!structureMatch) {
      return { success: false, error: 'No JSON structure detected' };
    }

    // If it's small enough, don't chunk
    if (jsonText.length < CHUNK_SIZE) {
      return attemptJsonRepair(jsonText);
    }

    // For large responses, try to reconstruct by identifying key sections
    const chunks: string[] = [];
    let currentPos = 0;
    let reconstructed = '';

    // Separate processing: Extract tasks separately from other fields
    console.log(`[JSON Parser] Separating tasks from other fields for specialized processing`);

    // First, extract the tasks array specifically
    const tasksMatch = jsonText.match(/"tasks"\s*:\s*(\[[\s\S]*?)(?=,\s*"\w+"\s*:|\s*}\s*$)/s);
    let tasksArray: any[] = [];
    let tasksProcessed = false;

    if (tasksMatch) {
      const tasksContent = tasksMatch[1];
      console.log(`[JSON Parser] Found tasks section (${tasksContent.length} chars), processing separately...`);
      
      try {
        // Method 1: Try to parse the entire tasks array
        const tasksRepairResult = attemptJsonRepair(tasksContent);
        if (tasksRepairResult.success && Array.isArray(tasksRepairResult.data)) {
          tasksArray = tasksRepairResult.data;
          tasksProcessed = true;
          console.log(`[JSON Parser] ✅ Tasks array parsed successfully: ${tasksArray.length} tasks`);
        } else {
          // Try ai-json-fixer for tasks array
          const aiFixerTasksResult = attemptAiJsonFixerRepair(tasksContent);
          if (aiFixerTasksResult.success && Array.isArray(aiFixerTasksResult.data)) {
            tasksArray = aiFixerTasksResult.data;
            tasksProcessed = true;
            console.log(`[JSON Parser] ✅ Tasks array parsed with ai-json-fixer: ${tasksArray.length} tasks`);
          } else {
            console.log(`[JSON Parser] Full tasks array parsing failed, trying individual task extraction...`);
            // Method 2: Extract individual task objects
            const taskObjectRegex = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
            const taskMatches = tasksContent.match(taskObjectRegex);
            
            if (taskMatches && taskMatches.length > 0) {
              console.log(`[JSON Parser] Found ${taskMatches.length} individual task objects`);
              for (let i = 0; i < taskMatches.length; i++) {
                const taskStr = taskMatches[i];
                try {
                  // Try to parse each task individually
                  const taskRepair = attemptJsonRepair(taskStr);
                  if (taskRepair.success) {
                    tasksArray.push(taskRepair.data);
                  } else {
                    // Try ai-json-fixer for individual task
                    const taskAiFixerResult = attemptAiJsonFixerRepair(taskStr);
                    if (taskAiFixerResult.success) {
                      tasksArray.push(taskAiFixerResult.data);
                    } else {
                      // Manual field extraction for this task
                      const task: any = {
                        task_number: i + 1,
                        title: `Task ${i + 1}`,
                        description: 'Extracted from chunked repair',
                        status: 'PLANNED',
                        estimated_duration_days: 1,
                        estimated_effort_hours: 8
                      };

                      // Try to extract common fields
                      const titleMatch = taskStr.match(/"title"\s*:\s*"([^"]*)"/i);
                      if (titleMatch) task.title = titleMatch[1];
                      
                      const descMatch = taskStr.match(/"description"\s*:\s*"([^"]*)"/i);
                      if (descMatch) task.description = descMatch[1];
                      
                      const taskNumMatch = taskStr.match(/"task_number"\s*:\s*(\d+)/i);
                      if (taskNumMatch) task.task_number = parseInt(taskNumMatch[1]);
                      
                      const durationMatch = taskStr.match(/"estimated_duration_days"\s*:\s*(\d+(?:\.\d+)?)/i);
                      if (durationMatch) task.estimated_duration_days = parseFloat(durationMatch[1]);
                      
                      const effortMatch = taskStr.match(/"estimated_effort_hours"\s*:\s*(\d+(?:\.\d+)?)/i);
                      if (effortMatch) task.estimated_effort_hours = parseFloat(effortMatch[1]);
                      
                      const assignedMatch = taskStr.match(/"assigned_to"\s*:\s*"([^"]*)"/i);
                      if (assignedMatch) task.assigned_to = assignedMatch[1];
                      
                      const codeMatch = taskStr.match(/"code_content"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/i);
                      if (codeMatch) task.code_content = codeMatch[1];

                      tasksArray.push(task);
                    }
                  }
                } catch (taskError) {
                  console.warn(`[JSON Parser] Failed to process task ${i + 1}:`, taskError);
                  // Add a minimal task to maintain structure
                  tasksArray.push({
                    task_number: i + 1,
                    title: `Task ${i + 1} (Recovery)`,
                    description: 'Task recovered via chunked repair',
                    status: 'PLANNED',
                    estimated_duration_days: 1,
                    estimated_effort_hours: 8
                  });
                }
              }
              tasksProcessed = true;
              console.log(`[JSON Parser] ✅ Individual task extraction completed: ${tasksArray.length} tasks`);
            } else {
              console.warn(`[JSON Parser] No individual task objects found in tasks section`);
            }
          }
        }
      } catch (tasksError) {
        console.error(`[JSON Parser] Tasks processing failed:`, tasksError);
      }
    } else {
      console.warn(`[JSON Parser] No tasks section found in response`);
    }

    // Now process other fields (excluding tasks)
    const otherFields = ['plan_title', 'estimated_duration_days', 'target_start_date', 'target_end_date', 'kpis', 'dependency_analysis', 'plan_risks_and_mitigations'];
    const fieldPositions: Array<{ field: string; start: number; end: number }> = [];

    // Locate each non-task field
    for (const field of otherFields) {
      const pattern = new RegExp(`"${field}"\\s*:\\s*`, 'g');
      const match = pattern.exec(jsonText);
      if (match) {
        fieldPositions.push({ field, start: match.index, end: -1 });
      }
    }

    // Sort by position and calculate end positions
    fieldPositions.sort((a, b) => a.start - b.start);
    for (let i = 0; i < fieldPositions.length; i++) {
      if (i < fieldPositions.length - 1) {
        fieldPositions[i].end = fieldPositions[i + 1].start - 1;
      } else {
        // For the last field, find the end before tasks or end of object
        const tasksStart = jsonText.indexOf('"tasks"');
        if (tasksStart > fieldPositions[i].start) {
          fieldPositions[i].end = tasksStart - 1;
        } else {
          fieldPositions[i].end = jsonText.length - 1;
        }
      }
    }

    console.log(`[JSON Parser] Found ${fieldPositions.length} non-task fields for processing`);

    // Initialize with tasks if processed
    const repairedFields: { [key: string]: any } = {};
    if (tasksProcessed) {
      repairedFields.tasks = tasksArray;
      console.log(`[JSON Parser] ✅ Added ${tasksArray.length} tasks to repaired fields`);
    }

    for (const { field, start, end } of fieldPositions) {
      const fieldContent = jsonText.substring(start, Math.min(end, jsonText.length));
      try {
        console.log(`[JSON Parser] Processing field: ${field} (${start}-${end}, content: ${fieldContent.length} chars)`);
        
        // More robust field extraction patterns
        let fieldMatch;
        // For non-task fields, use flexible patterns
        const patterns = [
          // Pattern 1: Field with value until next field or end
          new RegExp(`"${field}"\\s*:\\s*(.+?)(?=,\\s*"\\w+"\\s*:|\\s*}\\s*$)`, 's'),
          // Pattern 2: Field with value until comma or end of object
          new RegExp(`"${field}"\\s*:\\s*([^,}]+)(?=,|})`, 's'),
          // Pattern 3: Simple field extraction
          new RegExp(`"${field}"\\s*:\\s*(.+)`, 's')
        ];

        for (const pattern of patterns) {
          fieldMatch = fieldContent.match(pattern);
          if (fieldMatch) break;
        }

        if (fieldMatch) {
          let fieldValueStr = fieldMatch[1].trim();
          // Clean up the field value
          fieldValueStr = fieldValueStr.replace(/,$/, ''); // Remove trailing comma
          
          console.log(`[JSON Parser] Extracted ${field} value: ${fieldValueStr.substring(0, 100)}${fieldValueStr.length > 100 ? '...' : ''}`);

          // Parse different value types
          if (fieldValueStr.startsWith('"') && fieldValueStr.endsWith('"')) {
            // String value - fix escaping
            try {
              const sanitized = preSanitizeCodeContent(fieldValueStr);
              repairedFields[field] = JSON.parse(sanitized);
            } catch {
              // Fallback: just remove quotes and basic cleanup
              repairedFields[field] = fieldValueStr.slice(1, -1).replace(/\\"/g, '"');
            }
          } else if (fieldValueStr.match(/^\d+(\.\d+)?$/)) {
            // Number value
            repairedFields[field] = parseFloat(fieldValueStr);
          } else if (fieldValueStr === 'true' || fieldValueStr === 'false') {
            // Boolean value
            repairedFields[field] = fieldValueStr === 'true';
          } else if (fieldValueStr.startsWith('[')) {
            // Array value - try to parse with repair
            const arrayRepair = attemptJsonRepair(fieldValueStr);
            if (arrayRepair.success) {
              repairedFields[field] = arrayRepair.data;
            } else {
              // Try ai-json-fixer for array
              const arrayAiFixerResult = attemptAiJsonFixerRepair(fieldValueStr);
              if (arrayAiFixerResult.success) {
                repairedFields[field] = arrayAiFixerResult.data;
              } else {
                // Manual array parsing for string arrays
                try {
                  const arrayContent = fieldValueStr.slice(1, -1); // Remove [ and ]
                  const items = [];
                  let currentItem = '';
                  let inQuotes = false;
                  let escaped = false;

                  for (let i = 0; i < arrayContent.length; i++) {
                    const char = arrayContent[i];
                    if (escaped) {
                      currentItem += char;
                      escaped = false;
                    } else if (char === '\\') {
                      escaped = true;
                      currentItem += char;
                    } else if (char === '"') {
                      inQuotes = !inQuotes;
                      currentItem += char;
                    } else if (char === ',' && !inQuotes) {
                      if (currentItem.trim()) {
                        let item = currentItem.trim();
                        if (item.startsWith('"') && item.endsWith('"')) {
                          item = item.slice(1, -1);
                        }
                        items.push(item);
                      }
                      currentItem = '';
                    } else {
                      currentItem += char;
                    }
                  }

                  // Add last item
                  if (currentItem.trim()) {
                    let item = currentItem.trim();
                    if (item.startsWith('"') && item.endsWith('"')) {
                      item = item.slice(1, -1);
                    }
                    items.push(item);
                  }

                  repairedFields[field] = items;
                } catch {
                  repairedFields[field] = [];
                }
              }
            }
          } else if (fieldValueStr.startsWith('{')) {
            // Object value - try to parse with repair
            const objRepair = attemptJsonRepair(fieldValueStr);
            if (objRepair.success) {
              repairedFields[field] = objRepair.data;
            } else {
              // Try ai-json-fixer for object
              const objAiFixerResult = attemptAiJsonFixerRepair(fieldValueStr);
              if (objAiFixerResult.success) {
                repairedFields[field] = objAiFixerResult.data;
              } else {
                repairedFields[field] = {};
                console.warn(`[JSON Parser] Failed to parse ${field} object, using empty object`);
              }
            }
          } else {
            // Fallback: treat as string
            repairedFields[field] = fieldValueStr;
          }

          console.log(`[JSON Parser] Successfully extracted field: ${field}`);
        } else {
          console.warn(`[JSON Parser] No match found for field: ${field}`);
        }
      } catch (fieldError) {
        console.warn(`[JSON Parser] Failed to process field ${field}:`, fieldError);
        // Will be handled by fallback logic below
      }
    }

    // Ensure all required fields exist (but don't override processed tasks)
    const requiredFields = {
      plan_title: 'Refactored Plan (Chunked Repair)',
      estimated_duration_days: 30,
      target_start_date: '2025-09-15',
      target_end_date: '2025-10-15',
      kpis: [],
      dependency_analysis: 'Analysis recovered via chunked repair',
      plan_risks_and_mitigations: [],
      tasks: [] // Will only be used if tasks weren't processed above
    };

    for (const [field, fallback] of Object.entries(requiredFields)) {
      if (!(field in repairedFields)) {
        // Special handling for tasks - only add fallback if not processed
        if (field === 'tasks' && tasksProcessed) {
          console.log(`[JSON Parser] Tasks already processed (${repairedFields.tasks?.length || 0} tasks), skipping fallback`);
          continue;
        }
        repairedFields[field] = fallback;
        console.log(`[JSON Parser] Added fallback for missing field: ${field}`);
      }
    }

    console.log(`[JSON Parser] ✅ Chunked repair successful with ${Object.keys(repairedFields).length} fields`);
    return { success: true, data: repairedFields };
  } catch (error: any) {
    console.warn('[JSON Parser] Chunked repair failed:', error.message);
    return { success: false, error: error.message };
  }
}

export async function parseGeminiJsonResponse(
  textResponse: string,
  context?: {
    expectedStructure?: string;
    contextDescription?: string;
    memoryManager?: MemoryManager;
    geminiService?: GeminiIntegrationService;
    enableAIRepair?: boolean;
  }
): Promise<any> {
  const enableAIRepair = context?.enableAIRepair !== false; // Default to true

  // Pre-sanitize the response to fix code content issues
  const sanitizedResponse = preSanitizeCodeContent(textResponse);

  // First try quick repair without AI (using sanitized version)
  const quickRepairResult = JSONRepairAgent.quickRepair(sanitizedResponse);
  if (quickRepairResult.success) {
    console.log('[JSON Parser] ✅ Quick repair successful after pre-sanitization');
    return quickRepairResult.data;
  }

  try {
    // -----------------------------------------------------------------
    // 1️⃣ Trim & strip any markdown code fences (using sanitized response)
    // -----------------------------------------------------------------
    let jsonString = sanitizedResponse.trim();

    // Detect a markdown block (````````)
    const markdownMatch = jsonString.match(/``````/);
    if (markdownMatch && markdownMatch[1]) {
      jsonString = markdownMatch[1].trim();
    }

    // -----------------------------------------------------------------
    // 2️⃣ Locate the outermost { … } or [ … ] with better boundary detection
    // -----------------------------------------------------------------
    const firstBrace = jsonString.indexOf('{');
    const firstBracket = jsonString.indexOf('[');
    let startIdx = -1;
    let endChar = '}';
    let startChar = '{';

    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
      startIdx = firstBrace;
      endChar = '}';
      startChar = '{';
    } else if (firstBracket !== -1) {
      startIdx = firstBracket;
      endChar = ']';
      startChar = '[';
    }

    if (startIdx === -1) {
      throw new Error('No opening brace or bracket found in Gemini response.');
    }

    // Enhanced boundary detection with bracket counting
    let extracted = '';
    let bracketCount = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = startIdx; i < jsonString.length; i++) {
      const char = jsonString[i];
      extracted += char;

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === '\\') {
        escapeNext = true;
        continue;
      }

      if (char === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === startChar) {
          bracketCount++;
        } else if (char === endChar) {
          bracketCount--;
          if (bracketCount === 0) {
            break; // Found complete JSON structure
          }
        }
      }
    }

    // If we couldn't find a complete structure, try the old method as fallback
    if (bracketCount !== 0) {
      console.warn('[JSON Parser] Bracket counting failed, trying alternative extraction...');
      // Try to find the last meaningful closing brace by looking for patterns
      // that indicate the end of a complete JSON structure
      let lastMeaningfulIdx = -1;

      // Look for patterns like: }\n]\n} or }\n] or }] that indicate end of large structures
      const endPatterns = [
        new RegExp('\\}\\s*\\]\\s*\\}\\s*$'), // object containing arrays ending
        new RegExp('\\}\\s*\\]\\s*$'), // array of objects ending
        new RegExp('\\}\\s*$'), // simple object ending
        new RegExp('\\]\\s*$') // simple array ending
      ];

      for (const pattern of endPatterns) {
        const match = jsonString.match(pattern);
        if (match && match.index !== undefined) {
          const potentialEnd = match.index + match[0].length;
          if (potentialEnd > startIdx) {
            lastMeaningfulIdx = potentialEnd;
            break;
          }
        }
      }

      // If we found a meaningful end, use it; otherwise use the entire remaining string
      if (lastMeaningfulIdx > startIdx) {
        extracted = jsonString.substring(startIdx, lastMeaningfulIdx);
        console.log('[JSON Parser] Using pattern-based extraction, length:', extracted.length);
      } else {
        // Last resort: take everything from start to end, assuming the JSON might be complete
        extracted = jsonString.substring(startIdx);
        console.log('[JSON Parser] Using full remaining string, length:', extracted.length);

        // If we're using the full string, try to find a better end point by counting braces
        let braceCount = 0;
        let inString = false;
        let escaped = false;
        let bestEndIdx = extracted.length;

        for (let i = 0; i < extracted.length; i++) {
          const char = extracted[i];
          if (escaped) {
            escaped = false;
            continue;
          }

          if (char === '\\') {
            escaped = true;
            continue;
          }

          if (char === '"' && !escaped) {
            inString = !inString;
            continue;
          }

          if (!inString) {
            if (char === '{' || char === '[') {
              braceCount++;
            } else if (char === '}' || char === ']') {
              braceCount--;
              if (braceCount === 0) {
                bestEndIdx = i + 1;
                break;
              }
            }
          }
        }

        if (bestEndIdx < extracted.length) {
          extracted = extracted.substring(0, bestEndIdx);
          console.log('[JSON Parser] Trimmed to better end point, new length:', extracted.length);
        }
      }
    }

    // -----------------------------------------------------------------
    // 3️⃣ Clean up problematic characters
    // -----------------------------------------------------------------
    // a) Remove invisible control characters (U+0000‑U+001F, U+007F‑U+009F)
    extracted = extracted.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');

    // b) Escape stray back‑slashes that are NOT part of a valid JSON escape
    // Valid escapes: \", \\, \/ , \b , \f , \n , \r , \t , \uXXXX
    // Using a more compatible approach without negative lookbehind
    extracted = extracted.replace(/\\(?!["\\/bfnrtu]|\\$)/gm, '\\\\');

    // c) Ensure all internal new‑lines are escaped (JSON strings cannot contain raw \n)
    // This is safe because we already escaped stray back‑slashes above.
    extracted = extracted.replace(/\n/g, '\\n').replace(/\r/g, '\\r');

    // d) Remove trailing commas (e.g. {"a":1,} or [1,2,])
    let prev: string;
    do {
      prev = extracted;
      extracted = extracted.replace(/,\s*([}\]])/g, '$1');
    } while (extracted !== prev);

    // -----------------------------------------------------------------
    // 4️⃣ Parse with recovery strategies for incomplete JSON
    // -----------------------------------------------------------------
    // First attempt: Direct parsing
    try {
      return JSON.parse(extracted);
    } catch (firstParseError) {
      console.warn('[JSON Parser] First parse attempt failed, trying recovery strategies...');

      // Recovery Strategy 1: Try chunked repair for large responses
      if (sanitizedResponse.length > 15000) {
        console.warn('[JSON Parser] Large response detected, attempting chunked repair...');
        const chunkedResult = attemptChunkedRepair(sanitizedResponse);
        if (chunkedResult.success) {
          return chunkedResult.data;
        }
      }

      // Recovery Strategy 2: Try jsonrepair library
      console.warn('[JSON Parser] Attempting jsonrepair library recovery...');
      const jsonrepairResult = attemptJsonRepair(sanitizedResponse);
      if (jsonrepairResult.success) {
        return jsonrepairResult.data;
      }

      // Recovery Strategy 2b: Try ai-json-fixer library
      console.warn('[JSON Parser] Attempting ai-json-fixer recovery...');
      const aiFixerResult = attemptAiJsonFixerRepair(sanitizedResponse);
      if (aiFixerResult.success) {
        return aiFixerResult.data;
      }

      // Recovery Strategy 3: Try to complete incomplete JSON objects
      let recoveredJson = extracted;
      // Check if it ends abruptly and try to close it
      if (startChar === '{' && !recoveredJson.endsWith('}')) {
        // Count unclosed braces and strings
        let openBraces = 0;
        let inStr = false;
        let lastWasEscape = false;

        for (let i = 0; i < recoveredJson.length; i++) {
          const c = recoveredJson[i];
          if (lastWasEscape) {
            lastWasEscape = false;
            continue;
          }

          if (c === '\\') {
            lastWasEscape = true;
            continue;
          }

          if (c === '"') {
            inStr = !inStr;
          } else if (!inStr) {
            if (c === '{') openBraces++;
            else if (c === '}') openBraces--;
          }
        }

        // Close any unclosed strings
        if (inStr) {
          recoveredJson += '"';
        }

        // Close any unclosed braces
        while (openBraces > 0) {
          recoveredJson += '}';
          openBraces--;
        }

        console.log('[JSON Parser] Attempting recovery with completed JSON:', recoveredJson.substring(0, 200) + '...');
        try {
          return JSON.parse(recoveredJson);
        } catch (recoveryError: any) {
          console.warn('[JSON Parser] Recovery strategy 3 failed:', recoveryError.message);
        }
      }

      // Recovery Strategy 4: Try AI repair before manual extraction for complex responses
      if (enableAIRepair && context?.memoryManager && context?.geminiService) {
        // Check if this looks like a complex response that AI repair should handle
        const hasComplexStructure = extracted.includes('tasks') ||
          extracted.includes('plan_title') ||
          extracted.includes('executive_summary') ||
          extracted.length > 5000; // Large responses

        if (hasComplexStructure) {
          console.warn('[JSON Parser] Complex structure detected, trying AI repair before manual extraction...');
          try {
            const repairAgent = initializeJSONRepairAgent(context.memoryManager, context.geminiService);
            const repairResult = await repairAgent.repairJSON(
              sanitizedResponse,
              context.expectedStructure,
              context.contextDescription
            );

            if (repairResult.success && repairResult.confidence > 0.7) {
              console.log(`[JSON Parser] ✅ AI repair successful using ${repairResult.model} with ${repairResult.repairStrategy} strategy (${repairResult.attempts} attempts, confidence: ${repairResult.confidence.toFixed(2)})`);
              if (repairResult.warnings && repairResult.warnings.length > 0) {
                console.log(`[JSON Parser] ⚠️ Repair warnings: ${repairResult.warnings.join(', ')}`);
              }
              return repairResult.data;
            } else {
              const reason = repairResult.success ? `low confidence (${repairResult.confidence.toFixed(2)})` : `failed after ${repairResult.attempts} attempts`;
              console.warn(`[JSON Parser] AI repair ${reason}, falling back to manual extraction`);
            }
          } catch (repairError: any) {
            console.warn('[JSON Parser] AI repair threw an error, falling back:', repairError.message);
          }
        }
      }

      // Recovery Strategy 5: Extract key-value pairs manually for simple RAG structures only (as last resort)
      // Only use manual extraction for simple RAG analysis responses, NOT for complex plan generation
      const isSimpleRagResponse = (extracted.includes('decision') || extracted.includes('reasoning') || extracted.includes('query')) &&
        !extracted.includes('tasks') &&
        !extracted.includes('plan_title') &&
        !extracted.includes('executive_summary') &&
        extracted.length < 10000; // Only for smaller responses

      if (isSimpleRagResponse) {
        console.warn('[JSON Parser] Attempting manual key-value extraction for simple RAG response...');
        const manualExtract: any = {};

        // Common patterns in RAG responses
        const patterns = [
          { key: 'decision', regex: /["']?decision["']?\s*:\s*["']([^"']*)["']?/i },
          { key: 'reasoning', regex: /["']?reasoning["']?\s*:\s*["']([^"']*)["']?/i },
          { key: 'qualityScore', regex: /["']?qualityScore["']?\s*:\s*([0-9.]+)/i },
          { key: 'nextCodebaseQuery', regex: /["']?nextCodebaseQuery["']?\s*:\s*["']([^"']*)["']?/i },
          { key: 'nextWebQuery', regex: /["']?nextWebQuery["']?\s*:\s*["']([^"']*)["']?/i }
        ];

        let extractedSomething = false;
        patterns.forEach(({ key, regex }) => {
          const match = extracted.match(regex);
          if (match) {
            const value = match[1];
            manualExtract[key] = key === 'qualityScore' ? parseFloat(value) || 0.5 : value;
            extractedSomething = true;
          }
        });

        if (extractedSomething) {
          console.log('[JSON Parser] Manual extraction successful for simple RAG response:', manualExtract);
          return manualExtract;
        }
      }

      // If all recovery attempts fail, try AI repair if enabled (second attempt)
      if (enableAIRepair && context?.memoryManager && context?.geminiService) {
        console.warn('[JSON Parser] Attempting AI-powered JSON repair...');
        try {
          const repairAgent = initializeJSONRepairAgent(context.memoryManager, context.geminiService);
          const repairResult = await repairAgent.repairJSON(
            sanitizedResponse,
            context.expectedStructure,
            context.contextDescription
          );

          if (repairResult.success && repairResult.confidence > 0.7) {
            console.log(`[JSON Parser] ✅ AI repair successful using ${repairResult.model} with ${repairResult.repairStrategy} strategy (${repairResult.attempts} attempts, confidence: ${repairResult.confidence.toFixed(2)})`);
            if (repairResult.warnings && repairResult.warnings.length > 0) {
              console.log(`[JSON Parser] ⚠️ Repair warnings: ${repairResult.warnings.join(', ')}`);
            }
            return repairResult.data;
          } else {
            const reason = repairResult.success ? `low confidence (${repairResult.confidence.toFixed(2)})` : `failed after ${repairResult.attempts} attempts`;
            console.error(`[JSON Parser] ❌ AI repair ${reason}`);
          }
        } catch (repairError: any) {
          console.error('[JSON Parser] AI repair threw an error:', repairError.message);
        }
      }

      // If all recovery attempts fail, throw the original error
      throw firstParseError;
    }
  } catch (parseError: any) {
    console.error(
      `⚠️ All Gemini JSON parsing strategies failed. Raw response (first 500 chars):\n`,
      textResponse.slice(0, 500)
    );
    console.error('Full raw response:', textResponse);
    console.error('Final parse error details:', parseError);

    // Final fallback - return a structure based on response type
    console.warn('Using final fallback structure based on response analysis...');

    // Detect response type and return appropriate fallback
    const lowerText = textResponse.toLowerCase();

    if (lowerText.includes('decision') || lowerText.includes('answer') || lowerText.includes('search') || lowerText.includes('reasoning')) {
      // RAG analysis response fallback
      return {
        decision: 'ANSWER',
        reasoning: 'JSON parsing completely failed - all recovery strategies exhausted',
        qualityScore: 0.3, // Low quality due to parsing failure
        nextCodebaseQuery: null,
        nextWebQuery: null,
        _parsing_failed: true,
        _error_message: parseError.message
      };
    }

    if (lowerText.includes('strategy') || lowerText.includes('plan') || lowerText.includes('action')) {
      // Agentic planning response fallback
      return {
        recommended_strategy: { primary_modality: 'vector_search' },
        execution_plan: {
          immediate_actions: ['fallback search due to parsing failure'],
          query_formulation: 'recovery search'
        },
        contingency_planning: { fallback_strategy: 'hybrid_search' },
        _parsing_failed: true,
        _error_message: parseError.message
      };
    }

    // Generic fallback
    return {
      error: 'Complete JSON parsing failure',
      message: parseError.message,
      raw_response_preview: textResponse.slice(0, 300),
      _parsing_failed: true,
      _recovery_attempted: true
    };
  }
}

/**
 * Synchronous version of parseGeminiJsonResponse (without AI repair)
 * For backwards compatibility with existing code
 */
export function parseGeminiJsonResponseSync(textResponse: string): any {
  // Pre-sanitize first
  const sanitizedResponse = preSanitizeCodeContent(textResponse);

  // Try chunked repair for large responses first
  if (sanitizedResponse.length > 15000) {
    const chunkedResult = attemptChunkedRepair(sanitizedResponse);
    if (chunkedResult.success) {
      return chunkedResult.data;
    }
  }

  // Try jsonrepair
  const jsonrepairResult = attemptJsonRepair(sanitizedResponse);
  if (jsonrepairResult.success) {
    return jsonrepairResult.data;
  }

  // Try ai-json-fixer
  const aiFixerResult = attemptAiJsonFixerRepair(sanitizedResponse);
  if (aiFixerResult.success) {
    return aiFixerResult.data;
  }

  // Try quick repair
  const quickRepairResult = JSONRepairAgent.quickRepair(sanitizedResponse);
  if (quickRepairResult.success) {
    return quickRepairResult.data;
  }

  // Fall back to original parsing logic
  return parseGeminiJsonResponseOriginal(sanitizedResponse);
}

/**
 * Original synchronous parsing logic (extracted for reuse)
 */
function parseGeminiJsonResponseOriginal(textResponse: string): any {
  try {
    // -----------------------------------------------------------------
    // 1️⃣ Trim & strip any markdown code fences
    // -----------------------------------------------------------------
    let jsonString = textResponse.trim();

    // Detect a markdown block (````````)
    const markdownMatch = jsonString.match(/``````/);
    if (markdownMatch && markdownMatch[1]) {
      jsonString = markdownMatch[1].trim();
    }

    // -----------------------------------------------------------------
    // 2️⃣ Locate the outermost { … } or [ … ] with better boundary detection
    // -----------------------------------------------------------------
    const firstBrace = jsonString.indexOf('{');
    const firstBracket = jsonString.indexOf('[');
    let startIdx = -1;
    let endChar = '}';
    let startChar = '{';

    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
      startIdx = firstBrace;
      endChar = '}';
      startChar = '{';
    } else if (firstBracket !== -1) {
      startIdx = firstBracket;
      endChar = ']';
      startChar = '[';
    }

    if (startIdx === -1) {
      throw new Error('No opening brace or bracket found in Gemini response.');
    }

    // Enhanced boundary detection with bracket counting
    let extracted = '';
    let bracketCount = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = startIdx; i < jsonString.length; i++) {
      const char = jsonString[i];
      extracted += char;

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === '\\') {
        escapeNext = true;
        continue;
      }

      if (char === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === startChar) {
          bracketCount++;
        } else if (char === endChar) {
          bracketCount--;
          if (bracketCount === 0) {
            break; // Found complete JSON structure
          }
        }
      }
    }

    // If we couldn't find a complete structure, try the old method as fallback
    if (bracketCount !== 0) {
      console.warn('[JSON Parser] Bracket counting failed, trying alternative extraction...');
      // Try to find the last meaningful closing brace by looking for patterns
      // that indicate the end of a complete JSON structure
      let lastMeaningfulIdx = -1;

      // Look for patterns like: }\n]\n} or }\n] or }] that indicate end of large structures
      const endPatterns = [
        new RegExp('\\}\\s*\\]\\s*\\}\\s*$'), // object containing arrays ending
        new RegExp('\\}\\s*\\]\\s*$'), // array of objects ending
        new RegExp('\\}\\s*$'), // simple object ending
        new RegExp('\\]\\s*$') // simple array ending
      ];

      for (const pattern of endPatterns) {
        const match = jsonString.match(pattern);
        if (match && match.index !== undefined) {
          const potentialEnd = match.index + match[0].length;
          if (potentialEnd > startIdx) {
            lastMeaningfulIdx = potentialEnd;
            break;
          }
        }
      }

      // If we found a meaningful end, use it; otherwise use the entire remaining string
      if (lastMeaningfulIdx > startIdx) {
        extracted = jsonString.substring(startIdx, lastMeaningfulIdx);
        console.log('[JSON Parser] Using pattern-based extraction, length:', extracted.length);
      } else {
        // Last resort: take everything from start to end, assuming the JSON might be complete
        extracted = jsonString.substring(startIdx);
        console.log('[JSON Parser] Using full remaining string, length:', extracted.length);

        // If we're using the full string, try to find a better end point by counting braces
        let braceCount = 0;
        let inString = false;
        let escaped = false;
        let bestEndIdx = extracted.length;

        for (let i = 0; i < extracted.length; i++) {
          const char = extracted[i];
          if (escaped) {
            escaped = false;
            continue;
          }

          if (char === '\\') {
            escaped = true;
            continue;
          }

          if (char === '"' && !escaped) {
            inString = !inString;
            continue;
          }

          if (!inString) {
            if (char === '{' || char === '[') {
              braceCount++;
            } else if (char === '}' || char === ']') {
              braceCount--;
              if (braceCount === 0) {
                bestEndIdx = i + 1;
                break;
              }
            }
          }
        }

        if (bestEndIdx < extracted.length) {
          extracted = extracted.substring(0, bestEndIdx);
          console.log('[JSON Parser] Trimmed to better end point, new length:', extracted.length);
        }
      }
    }

    // -----------------------------------------------------------------
    // 3️⃣ Clean up problematic characters
    // -----------------------------------------------------------------
    // a) Remove invisible control characters (U+0000‑U+001F, U+007F‑U+009F)
    extracted = extracted.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');

    // b) Escape stray back‑slashes that are NOT part of a valid JSON escape
    // Valid escapes: \", \\, \/ , \b , \f , \n , \r , \t , \uXXXX
    // Using a more compatible approach without negative lookbehind
    extracted = extracted.replace(/\\(?!["\\/bfnrtu]|\\$)/gm, '\\\\');

    // c) Ensure all internal new‑lines are escaped (JSON strings cannot contain raw \n)
    // This is safe because we already escaped stray back‑slashes above.
    extracted = extracted.replace(/\n/g, '\\n').replace(/\r/g, '\\r');

    // d) Remove trailing commas (e.g. {"a":1,} or [1,2,])
    let prev: string;
    do {
      prev = extracted;
      extracted = extracted.replace(/,\s*([}\]])/g, '$1');
    } while (extracted !== prev);

    // -----------------------------------------------------------------
    // 4️⃣ Parse with recovery strategies for incomplete JSON
    // -----------------------------------------------------------------
    // First attempt: Direct parsing
    try {
      return JSON.parse(extracted);
    } catch (firstParseError) {
      console.warn('[JSON Parser] First parse attempt failed, trying recovery strategies...');

      // Recovery Strategy 1: Try to complete incomplete JSON objects
      let recoveredJson = extracted;
      // Check if it ends abruptly and try to close it
      if (startChar === '{' && !recoveredJson.endsWith('}')) {
        // Count unclosed braces and strings
        let openBraces = 0;
        let inStr = false;
        let lastWasEscape = false;

        for (let i = 0; i < recoveredJson.length; i++) {
          const c = recoveredJson[i];
          if (lastWasEscape) {
            lastWasEscape = false;
            continue;
          }

          if (c === '\\') {
            lastWasEscape = true;
            continue;
          }

          if (c === '"') {
            inStr = !inStr;
          } else if (!inStr) {
            if (c === '{') openBraces++;
            else if (c === '}') openBraces--;
          }
        }

        // Close any unclosed strings
        if (inStr) {
          recoveredJson += '"';
        }

        // Close any unclosed braces
        while (openBraces > 0) {
          recoveredJson += '}';
          openBraces--;
        }

        try {
          return JSON.parse(recoveredJson);
        } catch (recoveryError: any) {
          console.warn('[JSON Parser] Recovery strategy 1 failed:', recoveryError.message);
        }
      }

      // Recovery Strategy 2: Extract key-value pairs manually for common structures
      if (extracted.includes('decision') || extracted.includes('reasoning') || extracted.includes('query')) {
        console.warn('[JSON Parser] Attempting manual key-value extraction...');
        const manualExtract: any = {};

        // Common patterns in RAG responses
        const patterns = [
          { key: 'decision', regex: /["']?decision["']?\s*:\s*["']([^"']*)["']?/i },
          { key: 'reasoning', regex: /["']?reasoning["']?\s*:\s*["']([^"']*)["']?/i },
          { key: 'qualityScore', regex: /["']?qualityScore["']?\s*:\s*([0-9.]+)/i },
          { key: 'nextCodebaseQuery', regex: /["']?nextCodebaseQuery["']?\s*:\s*["']([^"']*)["']?/i },
          { key: 'nextWebQuery', regex: /["']?nextWebQuery["']?\s*:\s*["']([^"']*)["']?/i }
        ];

        let extractedSomething = false;
        patterns.forEach(({ key, regex }) => {
          const match = extracted.match(regex);
          if (match) {
            const value = match[1];
            manualExtract[key] = key === 'qualityScore' ? parseFloat(value) || 0.5 : value;
            extractedSomething = true;
          }
        });

        if (extractedSomething) {
          console.log('[JSON Parser] Manual extraction successful:', manualExtract);
          return manualExtract;
        }
      }

      // If all recovery attempts fail, throw the original error
      throw firstParseError;
    }
  } catch (parseError: any) {
    // Final fallback - return a structure based on response type
    console.warn('Using final fallback structure based on response analysis...');

    // Detect response type and return appropriate fallback
    const lowerText = textResponse.toLowerCase();

    if (lowerText.includes('decision') || lowerText.includes('answer') || lowerText.includes('search') || lowerText.includes('reasoning')) {
      // RAG analysis response fallback
      return {
        decision: 'ANSWER',
        reasoning: 'JSON parsing completely failed - all recovery strategies exhausted',
        qualityScore: 0.3, // Low quality due to parsing failure
        nextCodebaseQuery: null,
        nextWebQuery: null,
        _parsing_failed: true,
        _error_message: parseError.message
      };
    }

    if (lowerText.includes('strategy') || lowerText.includes('plan') || lowerText.includes('action')) {
      // Agentic planning response fallback
      return {
        recommended_strategy: { primary_modality: 'vector_search' },
        execution_plan: {
          immediate_actions: ['fallback search due to parsing failure'],
          query_formulation: 'recovery search'
        },
        contingency_planning: { fallback_strategy: 'hybrid_search' },
        _parsing_failed: true,
        _error_message: parseError.message
      };
    }

    // Generic fallback
    return {
      error: 'Complete JSON parsing failure',
      message: parseError.message,
      raw_response_preview: textResponse.slice(0, 300),
      _parsing_failed: true,
      _recovery_attempted: true
    };
  }
}
