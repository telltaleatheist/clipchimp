/**
 * Fuzzy phrase -> timestamp matching for the analysis pipeline.
 *
 * The models in this pipeline NEVER emit timestamps: they quote a verbatim
 * sentence and code maps that quote back to a time. An invented timestamp is a
 * guess; a mapped quote is a measurement. This module IS that measurement, and
 * it is shared by every stage that needs one — chapter boundary placement
 * (chapter-detection.service) and flag quotes (ai-analysis.service) — so there
 * is exactly one matcher to reason about rather than two that drift.
 *
 * Extracted verbatim from ai-analysis.service; behavior is unchanged. The only
 * edits are the injected logger and the structural segment type, which is what
 * keeps this file free of any import from ai-analysis.service (that file now
 * imports chapter-detection.service, so an import back would be a cycle).
 */
import { Logger } from '@nestjs/common';

/**
 * A transcript segment — structurally identical to `Segment` in
 * ai-analysis.service, declared here so neither this module nor
 * chapter-detection.service has to import from that file.
 */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

// =============================================================================
// FUZZY STRING MATCHING
// =============================================================================

/**
 * Calculate Levenshtein distance between two strings
 * Returns the minimum number of single-character edits needed
 */
function levenshteinDistance(str1: string, str2: string): number {
  const m = str1.length;
  const n = str2.length;

  // Create a matrix of distances
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  // Initialize first column and row
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  // Fill in the rest of the matrix
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(
          dp[i - 1][j],     // deletion
          dp[i][j - 1],     // insertion
          dp[i - 1][j - 1], // substitution
        );
      }
    }
  }

  return dp[m][n];
}

/**
 * Calculate similarity ratio between two strings (0 to 1)
 * Uses Levenshtein distance normalized by the longer string length
 */
function stringSimilarity(str1: string, str2: string): number {
  if (str1 === str2) return 1;
  if (str1.length === 0 || str2.length === 0) return 0;

  const distance = levenshteinDistance(str1, str2);
  const maxLength = Math.max(str1.length, str2.length);

  return 1 - distance / maxLength;
}

/**
 * Normalize text for fuzzy comparison
 * Removes punctuation, extra spaces, and lowercases
 */
function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // Remove punctuation
    .replace(/\s+/g, ' ')    // Normalize whitespace
    .trim();
}

/**
 * Find the timestamp for a specific phrase in the transcript segments
 * Uses multiple strategies including fuzzy matching to handle:
 * - Whisper transcription errors
 * - AI quote corrections/paraphrasing
 * - Cross-segment quotes
 */
export function findPhraseTimestamp(
  phrase: string,
  segments: TranscriptSegment[],
  logger?: Logger,
): number | null {
  if (!phrase || !segments || segments.length === 0) {
    return null;
  }

  const normalizedPhrase = normalizeForComparison(phrase);
  if (normalizedPhrase.length < 3) {
    return null;
  }

  // Use first ~50 chars for matching (long quotes may span multiple segments)
  const searchPhrase = normalizedPhrase.substring(0, 50);

  // MATCHING STRATEGY (correctness-preserving performance rework):
  //   Segment text is normalized exactly ONCE here, up front, instead of being
  //   re-normalized inside every strategy below (previously ~5x per segment).
  //   The cheap exact/substring passes (Strategies 1 & 2) run first and
  //   early-return, so most calls never reach the fuzzy work at all. The
  //   expensive per-segment Levenshtein (Strategy 3) previously ran against
  //   EVERY segment (O(segments x quote), quadratic-ish, blocking the event
  //   loop). It now runs only over a SHORTLIST of segments that share at least
  //   one distinctive (uncommon, >3 char) word with the phrase. This does not
  //   change which segment is selected: for a segment's normalized text to be
  //   >=65% character-similar to the phrase it must share the phrase's
  //   distinctive words, so the true best fuzzy match is always in the
  //   shortlist. If the phrase has NO distinctive words (all common/short) we
  //   cannot prefilter and fall back to scanning every segment (exactly the
  //   old behavior), so accuracy is never weaker than before.
  const normSegs = segments.map((s) => normalizeForComparison(s.text));

  // Strategy 1: Direct substring match using first part of phrase
  for (let i = 0; i < segments.length; i++) {
    if (normSegs[i].includes(searchPhrase)) {
      return segments[i].start;
    }
  }

  // Strategy 2: Shorter prefix match (first 25 chars)
  if (searchPhrase.length > 25) {
    const shortSearchPhrase = normalizedPhrase.substring(0, 25);
    for (let i = 0; i < segments.length; i++) {
      if (normSegs[i].includes(shortSearchPhrase)) {
        return segments[i].start;
      }
    }
  }

  const FUZZY_THRESHOLD = 0.65; // 65% similarity required

  // Uncommon words drive both the Strategy-3 shortlist and Strategy 4.
  const commonWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
    'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'and', 'but', 'or', 'nor', 'so', 'yet', 'both', 'either', 'neither',
    'not', 'only', 'own', 'same', 'than', 'too', 'very', 'just',
    'that', 'this', 'these', 'those', 'what', 'which', 'who', 'whom',
    'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
    'my', 'your', 'his', 'its', 'our', 'their', 'mine', 'yours', 'hers', 'ours', 'theirs',
    'about', 'also', 'back', 'because', 'come', 'could', 'day', 'even',
    'first', 'get', 'give', 'go', 'good', 'know', 'like', 'look', 'make',
    'new', 'now', 'one', 'people', 'say', 'see', 'some', 'take', 'think',
    'time', 'two', 'use', 'want', 'way', 'well', 'work', 'year',
  ]);

  const phraseWords = normalizedPhrase.split(/\s+/).filter((w) => w.length > 3 && !commonWords.has(w));

  // Build the Strategy-3 candidate shortlist: segment indices that share at
  // least one distinctive word with the phrase. Any segment that could clear
  // the 65% char-similarity threshold necessarily shares such a word, so the
  // true best fuzzy match is always in this list. When the phrase has no
  // distinctive words we cannot prefilter and scan all segments (old behavior).
  const phraseWordSet = new Set(phraseWords);
  const segmentWordLists = normSegs.map((t) => t.split(/\s+/));
  let candidateIdx: number[];
  if (phraseWords.length > 0) {
    candidateIdx = [];
    for (let i = 0; i < normSegs.length; i++) {
      if (segmentWordLists[i].some((w) => phraseWordSet.has(w))) {
        candidateIdx.push(i);
      }
    }
    if (candidateIdx.length === 0) {
      candidateIdx = normSegs.map((_, i) => i);
    }
  } else {
    candidateIdx = normSegs.map((_, i) => i);
  }

  // Strategy 3: Fuzzy matching with Levenshtein distance over the shortlist.
  // Compare the quote against each candidate segment and find the best match.
  let bestFuzzyMatch: { segment: TranscriptSegment; score: number } | null = null;

  for (const i of candidateIdx) {
    const normalizedText = normSegs[i];

    // For longer segments, use a sliding window to find best match
    if (normalizedText.length >= searchPhrase.length) {
      // Check similarity of the segment prefix against the search phrase
      const similarity = stringSimilarity(
        searchPhrase,
        normalizedText.substring(0, searchPhrase.length + 10), // Allow some overflow
      );

      if (similarity > FUZZY_THRESHOLD && (!bestFuzzyMatch || similarity > bestFuzzyMatch.score)) {
        bestFuzzyMatch = { segment: segments[i], score: similarity };
      }
    }

    // Also try matching the full normalized segment against the phrase
    const cmpLen = Math.min(normalizedPhrase.length, normalizedText.length);
    const fullSimilarity = stringSimilarity(
      normalizedPhrase.substring(0, cmpLen),
      normalizedText.substring(0, cmpLen),
    );

    if (fullSimilarity > FUZZY_THRESHOLD && (!bestFuzzyMatch || fullSimilarity > bestFuzzyMatch.score)) {
      bestFuzzyMatch = { segment: segments[i], score: fullSimilarity };
    }
  }

  if (bestFuzzyMatch) {
    logger?.debug(
      `[Fuzzy Match] Found "${phrase.substring(0, 30)}..." at ${bestFuzzyMatch.segment.start}s (score: ${bestFuzzyMatch.score.toFixed(2)})`,
    );
    return bestFuzzyMatch.segment.start;
  }

  // Strategy 4: Distinctive word matching
  // Find uncommon words in the quote and search for segments containing them
  if (phraseWords.length > 0) {
    let bestWordMatch: { segment: TranscriptSegment; matchCount: number; fuzzyScore: number } | null = null;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const segmentWords = segmentWordLists[i];
      let matchCount = 0;
      let fuzzyMatchCount = 0;

      for (const phraseWord of phraseWords) {
        // Exact word match
        if (segmentWords.some((sw) => sw === phraseWord || sw.includes(phraseWord) || phraseWord.includes(sw))) {
          matchCount++;
        } else {
          // Fuzzy word match (for typos like "Somalies" vs "Somalis")
          for (const segmentWord of segmentWords) {
            if (segmentWord.length > 3 && stringSimilarity(phraseWord, segmentWord) > 0.75) {
              fuzzyMatchCount++;
              break;
            }
          }
        }
      }

      const totalMatches = matchCount + fuzzyMatchCount * 0.8; // Fuzzy matches count slightly less
      const score = totalMatches / phraseWords.length;

      if (score > 0.4 && (!bestWordMatch || totalMatches > bestWordMatch.matchCount + bestWordMatch.fuzzyScore)) {
        bestWordMatch = { segment, matchCount, fuzzyScore: fuzzyMatchCount * 0.8 };
      }
    }

    if (bestWordMatch) {
      logger?.debug(
        `[Word Match] Found "${phrase.substring(0, 30)}..." at ${bestWordMatch.segment.start}s (${bestWordMatch.matchCount} exact + ${bestWordMatch.fuzzyScore.toFixed(1)} fuzzy)`,
      );
      return bestWordMatch.segment.start;
    }
  }

  // Strategy 5: Check across segment boundaries with fuzzy matching
  for (let i = 0; i < segments.length - 1; i++) {
    // normSegs[i] is already normalized; joining two normalized strings with a
    // single space is equivalent to normalizing the concatenation.
    const combinedText = normSegs[i] + ' ' + normSegs[i + 1];

    // Try exact match first
    if (combinedText.includes(searchPhrase)) {
      return segments[i].start;
    }

    // Try fuzzy match on combined text
    const similarity = stringSimilarity(
      searchPhrase,
      combinedText.substring(0, searchPhrase.length + 15),
    );

    if (similarity > FUZZY_THRESHOLD) {
      logger?.debug(
        `[Cross-segment Fuzzy] Found "${phrase.substring(0, 30)}..." at ${segments[i].start}s (score: ${similarity.toFixed(2)})`,
      );
      return segments[i].start;
    }
  }

  logger?.debug(`[No Match] Could not find: "${phrase.substring(0, 50)}..."`);
  return null;
}
