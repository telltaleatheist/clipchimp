/**
 * JSON extraction/repair for AI responses, shared by every analysis stage.
 *
 * Models emit JSON wrapped in prose, fenced in markdown, or truncated mid-string.
 * These helpers recover the object when it is recoverable and return null when it
 * is not — a failure is reported, never papered over with fabricated fields (see
 * the notes inside attemptJsonRepair and safeJsonParse).
 *
 * Moved out of ai-analysis.service so chapter-detection.service can parse its
 * boundary-placement responses with the same code instead of a second, subtly
 * different parser. Behavior is unchanged.
 */
import { Logger } from '@nestjs/common';
import { stripThinkTags } from './model-utils';

/**
 * Extract JSON from AI response text, handling various formats
 * Tries multiple strategies to find valid JSON in the response
 */
export function extractJsonFromResponse(response: string): string | null {
  if (!response || typeof response !== 'string') {
    return null;
  }

  let text = response.trim();

  // Strategy 1: Remove markdown code blocks
  if (text.includes('```')) {
    // Try to extract content between ```json and ``` or just ``` and ```
    const jsonBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonBlockMatch) {
      text = jsonBlockMatch[1].trim();
    } else {
      // Fallback: remove all ``` lines
      text = text.split('\n').filter(l => !l.trim().startsWith('```')).join('\n').trim();
    }
  }

  // Strategy 2: Find JSON object with balanced braces
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    // Extract the portion that looks like JSON
    let jsonCandidate = text.substring(firstBrace, lastBrace + 1);

    // Try to balance braces if needed — ignore braces that appear inside quoted
    // string values (tracking string/escape state) so a `{`/`}` in the text
    // can't truncate otherwise-valid JSON.
    let braceCount = 0;
    let endIndex = -1;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < jsonCandidate.length; i++) {
      const ch = jsonCandidate[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') braceCount++;
      if (ch === '}') braceCount--;
      if (braceCount === 0) {
        endIndex = i;
        break;
      }
    }

    if (endIndex !== -1) {
      jsonCandidate = jsonCandidate.substring(0, endIndex + 1);
    }

    return jsonCandidate;
  }

  return null;
}

/**
 * Attempt to fix common JSON issues from AI responses
 */
function attemptJsonRepair(jsonStr: string): string {
  let fixed = jsonStr;

  // Fix trailing commas before closing braces/brackets
  fixed = fixed.replace(/,\s*([\]}])/g, '$1');

  // NO unquoted-key quoting: the naive /([{,]\s*)(\w+)(\s*:)/ regex also matches
  // `word:` sequences INSIDE string values (e.g. a summary containing
  // ", note: see above"), rewriting them and producing JSON that parses into
  // semantically WRONG data — fabricated-but-passable content, which violates
  // this file's "fail, don't fabricate" policy. A genuinely unquoted key is rare
  // from cloud models; let such a response fall through to retry / recordFailure.

  // Fix single quotes to double quotes (careful with apostrophes in text)
  // Only do this for key-value patterns
  fixed = fixed.replace(/'(\w+)'(\s*:)/g, '"$1"$2');

  // Remove control characters that break JSON
  fixed = fixed.replace(/[\x00-\x1F\x7F]/g, (match) => {
    if (match === '\n' || match === '\r' || match === '\t') {
      return match; // Keep these
    }
    return ''; // Remove others
  });

  // Fix truncated strings - if we have an unclosed quote, try to close it
  const quoteCount = (fixed.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    // Odd number of quotes - likely truncated
    // Try to close the last open string and the object
    if (!fixed.endsWith('"')) {
      fixed = fixed + '"';
    }
    // Count braces
    const openBraces = (fixed.match(/{/g) || []).length;
    const closeBraces = (fixed.match(/}/g) || []).length;
    for (let i = 0; i < openBraces - closeBraces; i++) {
      fixed = fixed + '}';
    }
  }

  return fixed;
}

/**
 * Safely parse JSON with multiple fallback strategies
 * Returns parsed object or null if all strategies fail
 */
export function safeJsonParse<T>(response: string, logger?: Logger): T | null {
  if (!response) {
    return null;
  }

  // Belt-and-braces: drop any inline <think>…</think> before extraction, in case
  // a thinking model's template inlined its reasoning into the response text.
  const cleaned = stripThinkTags(response);

  // Step 1: Extract JSON from response
  const jsonStr = extractJsonFromResponse(cleaned);
  if (!jsonStr) {
    logger?.warn('[JSON Parse] No JSON object found in response');
    return null;
  }

  // Step 2: Try direct parse
  try {
    return JSON.parse(jsonStr) as T;
  } catch (e) {
    logger?.debug(`[JSON Parse] Direct parse failed: ${(e as Error).message}`);
  }

  // Step 3: Try with repairs (markdown already stripped, braces balanced above).
  try {
    const repaired = attemptJsonRepair(jsonStr);
    return JSON.parse(repaired) as T;
  } catch (e) {
    logger?.debug(`[JSON Parse] Repaired parse failed: ${(e as Error).message}`);
  }

  // NO regex field-scrape last resort: it could fabricate a passable object
  // (e.g. title:"Unknown") that masks a real parse failure. If markdown-strip +
  // brace-balance + repair all fail, this IS a failure — return null so the
  // caller retries or records it explicitly.
  logger?.warn(`[JSON Parse] All parse strategies failed for: ${jsonStr.substring(0, 200)}...`);
  return null;
}
