/**
 * AI Analysis Service - Two-Pass Chapter-Centric Analysis
 *
 * This service implements a two-pass approach to video analysis:
 *   Pass 1: Detect chapter boundaries (chunked, lightweight)
 *   Pass 2: Analyze each chapter with full context (title, summary)
 *   Pass 2b: Extract category flags per chapter, as a dedicated call
 *
 * Metadata (description, tags, title) is generated from chapter summaries.
 */
import { Injectable, Logger } from '@nestjs/common';
import { AIProviderService, AIProviderConfig } from './ai-provider.service';
import { OllamaService } from './ollama.service';
import { numCtxMaxForModel, stripThinkTags, parseProviderModel, AITaskKind } from './model-utils';
import { ApiKeysService } from '../config/api-keys.service';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildBoundaryDetectionPrompt,
  buildChapterAnalysisPrompt,
  buildFlagExtractionPrompt,
  interpolatePrompt,
  DESCRIPTION_FROM_CHAPTERS_PROMPT,
  TAGS_FROM_CHAPTERS_PROMPT,
  TITLE_FROM_CHAPTERS_PROMPT,
  TITLE_FROM_WEBPAGE_PROMPT,
  AnalysisCategory,
} from './prompts/analysis-prompts';

// =============================================================================
// INTERFACES
// =============================================================================

export interface Segment {
  start: number;
  end: number;
  text: string;
}

interface Chunk {
  number: number;
  startTime: number;
  endTime: number;
  text: string;
  segments: Segment[];
}

export interface Quote {
  timestamp: string;
  text: string;
  significance?: string;
}

export interface AnalyzedSection {
  category: string;
  description: string;
  start_time: string;
  end_time: string | null;
  quotes: Quote[];
}

export interface Chapter {
  sequence: number;
  start_time: string;
  end_time: string;
  title: string;
  summary?: string;
  /**
   * True when analysis of this chapter failed after retries. Failed chapters are
   * NEVER persisted as content (see finalize) — they carry no fabricated title —
   * and are excluded from description/tags/title generation. They exist in the
   * in-memory result only so the failure is counted and visible, never silently
   * dropped or written to the DB as a fake successful chapter.
   */
  failed?: boolean;
}

// Interface for category flags detected within chapters
export interface ChapterFlag {
  category: string;
  description: string;
  quote: string;
}

// Interface for boundary detection response
interface BoundaryDetectionResult {
  boundaries: string[];
  end_topic: string;
}

// Interface for chapter analysis response
interface ChapterAnalysisResult {
  title: string;
  summary: string;
  flags?: ChapterFlag[];
}

export interface Tags {
  people: string[];
  topics: string[];
}

export interface AnalysisProgress {
  phase: string;
  progress: number;
  message: string;
  eta?: number;           // Estimated seconds remaining
  elapsedMs?: number;     // Milliseconds elapsed since start
}

export interface AnalysisOptions {
  provider: 'local' | 'ollama' | 'openai' | 'claude';
  model: string;
  transcript: string;
  segments: Segment[];
  outputFile: string;
  customInstructions?: string;
  analysisGranularity?: number; // 1-3: 1 = strong matches only, 3 = aggressive
  videoTitle?: string;
  categories?: AnalysisCategory[];
  apiKey?: string;
  ollamaEndpoint?: string;
  onProgress?: (progress: AnalysisProgress) => void;
}

export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  apiCalls: number;
}

export interface AnalysisResult {
  sections_count: number;
  sections: AnalyzedSection[];
  chapters: Chapter[];
  // null = generation explicitly failed (recorded, not fabricated). undefined =
  // not attempted. A placeholder string is never synthesized on failure.
  tags?: Tags | null;
  description?: string | null;
  suggested_title?: string;
  tokenStats?: TokenStats;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const MAX_RETRIES = 3;
const JSON_PARSE_RETRIES = 2;

/**
 * Tasks whose model may be overridden via `taskModels` in app-config.json.
 *
 * EVERY task is routable. The three that read raw transcript (boundary, chapter,
 * flags) are safe to route because the chunk/chapter caps are computed as the
 * MOST CONSERVATIVE limits across whichever models those tasks resolve to — see
 * `perTaskLimits` in analyzeTranscript. Sizing to one model while another does
 * the reading is what would silently truncate prompts, so the caps follow the
 * smallest context in play.
 *
 * Tasks are executed grouped by model (chaptering, then Pass 2b, then metadata
 * ordered main-model-first), so each routed model loads once rather than being
 * swapped in and out per call.
 */
const ROUTABLE_TASKS = ['boundary', 'chapter', 'flags', 'description', 'tags', 'title'] as const;

/**
 * How many chapters have their flags extracted at once (Pass 2b).
 *
 * Flag extraction is the only embarrassingly parallel step in the pipeline: each
 * chapter's extraction reads only that chapter's text and threads no state
 * forward. (Chapter analysis cannot be parallelized — it carries
 * previousChapterSummary.) Since LLM generation is memory-bandwidth-bound,
 * concurrent requests against one resident model raise total throughput rather
 * than just splitting it.
 *
 * DEFAULTS TO 1, because concurrency here is only safe once Ollama is allowed to
 * serve the requests in parallel. With OLLAMA_NUM_PARALLEL unset, Ollama QUEUES
 * the extra request — it is not merely a no-op, it is actively harmful: the
 * queued call burns its client-side timeout waiting its turn and gets aborted
 * and retried, which cost ~5 minutes in a measured run.
 *
 * To actually enable it: set OLLAMA_NUM_PARALLEL >= N on the Ollama server AND
 * BRIEFCASE_FLAG_CONCURRENCY=N here. Both, or neither.
 */
const FLAG_EXTRACTION_CONCURRENCY = Math.max(
  1,
  Number(process.env.BRIEFCASE_FLAG_CONCURRENCY) || 1,
);

// Job-level failure accounting. Any analysis step that cannot produce a real
// result — a boundary chunk that won't parse after a retry, a chapter that
// exhausts its retries, a description/tags generation that fails — is recorded
// as an explicit failure instead of being papered over with fabricated data.
// Once this many steps have failed, the whole job aborts with TOO_MANY_FAILURES
// rather than shipping a mostly-empty analysis that looks successful.
const MAX_FAILURES = 10;

// =============================================================================
// JSON EXTRACTION AND VALIDATION HELPERS
// =============================================================================

/**
 * Extract JSON from AI response text, handling various formats
 * Tries multiple strategies to find valid JSON in the response
 */
function extractJsonFromResponse(response: string): string | null {
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
function safeJsonParse<T>(response: string, logger?: Logger): T | null {
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

/**
 * Validate chapter analysis result has required fields
 */
function validateChapterAnalysisResult(data: unknown): ChapterAnalysisResult | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const obj = data as Record<string, unknown>;

  // Must have a title (string)
  if (typeof obj.title !== 'string' || obj.title.trim() === '') {
    return null;
  }

  // Summary should be string (can be empty)
  const summary = typeof obj.summary === 'string' ? obj.summary : '';

  // Flags should be array if present
  let flags: ChapterFlag[] = [];
  if (Array.isArray(obj.flags)) {
    flags = obj.flags.filter((f): f is ChapterFlag => {
      return (
        f &&
        typeof f === 'object' &&
        typeof (f as ChapterFlag).category === 'string' &&
        (typeof (f as ChapterFlag).description === 'string' ||
          typeof (f as ChapterFlag).quote === 'string')
      );
    });
  }

  return {
    title: obj.title.trim(),
    summary: summary.trim(),
    flags,
  };
}

/**
 * Validate boundary detection result has required fields
 */
function validateBoundaryResult(data: unknown): BoundaryDetectionResult | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const obj = data as Record<string, unknown>;

  // Boundaries should be array of strings
  let boundaries: string[] = [];
  if (Array.isArray(obj.boundaries)) {
    boundaries = obj.boundaries.filter(
      (b): b is string => typeof b === 'string' && b.trim().length > 0,
    );
  }

  // end_topic should be string
  const endTopic = typeof obj.end_topic === 'string' ? obj.end_topic : '';

  return {
    boundaries,
    end_topic: endTopic,
  };
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

// Model size limits - conservative estimates based on typical context windows
// These ensure chunks fit comfortably with room for prompts and output
interface ModelLimits {
  maxChunkChars: number;       // Max chars per chunk for boundary detection
  maxChapterChars: number;     // Max chars per chapter for analysis
  chunkMinutes: number;        // Target chunk duration for boundary detection
  maxChapterSeconds: number;   // Max chapter duration before splitting
}

/**
 * Compute per-chunk/per-chapter size limits that are guaranteed to FIT the
 * context window the model will actually run with, so the transcript is never
 * silently truncated:
 *  - time granularity (chunkMinutes / maxChapterSeconds) is tiered by model size
 *    (bigger models reason over longer spans well),
 *  - but the CHARACTER caps are derived from `contextTokens` — the real ceiling.
 *
 * `contextTokens` is the effective context window:
 *  - local llama.cpp: the pinned server context (8192, the `-c` value),
 *  - ollama: numCtxMaxForModel(model) (what we actually request as num_ctx),
 *  - claude/openai: a large value (their windows are big).
 *
 * This is the fix for the historical mismatch where the char caps assumed a huge
 * context but the runner (pinned 8K local, or a VRAM-capped Ollama num_ctx) had
 * far less, silently dropping the tail of every long chapter.
 */
function getModelLimits(modelName: string, contextTokens: number): ModelLimits {
  // Extract parameter count from model name (e.g., "qwen2.5:7b" -> 7)
  const match = modelName.toLowerCase().match(/(\d+(?:\.\d+)?)\s*b/);
  const paramBillions = match ? parseFloat(match[1]) : 7; // Default to 7b if unknown

  // Reserve context for generation + prompt scaffolding (template + categories),
  // then convert the remaining input budget to chars. The reserve is >= the
  // local llama.cpp max_tokens (4096) so that, on the FIXED-context local path,
  // a maximum-size chapter prompt plus a full-length completion still fit inside
  // the pinned 8192-token window (input + output <= ctx). On the Ollama path
  // num_ctx is sized dynamically to fit prompt + output, so this is just the
  // chapter-size cap there. Thinking models use the leftover generation headroom
  // for their chain of thought (typically ~1-2K tokens; num_predict is a ceiling).
  const OUTPUT_RESERVE_TOKENS = 4096;
  const SCAFFOLD_TOKENS = 1024;
  const CHARS_PER_TOKEN = 3;
  const usableInputTokens = Math.max(1024, contextTokens - OUTPUT_RESERVE_TOKENS - SCAFFOLD_TOKENS);
  const maxChapterChars = usableInputTokens * CHARS_PER_TOKEN;
  // Boundary chunks carry a lighter prompt; the same input budget is safe.
  const maxChunkChars = maxChapterChars;

  // Time granularity tiers (independent of the char caps above).
  let chunkMinutes: number;
  let maxChapterSeconds: number;
  if (paramBillions <= 3) {
    chunkMinutes = 3;
    maxChapterSeconds = 180;
  } else if (paramBillions <= 7) {
    chunkMinutes = 7;
    maxChapterSeconds = 360;
  } else if (paramBillions <= 14) {
    chunkMinutes = 12;
    maxChapterSeconds = 540;
  } else if (paramBillions <= 32) {
    chunkMinutes = 15;
    maxChapterSeconds = 600;
  } else {
    chunkMinutes = 20;
    maxChapterSeconds = 720;
  }

  return { maxChunkChars, maxChapterChars, chunkMinutes, maxChapterSeconds };
}

// =============================================================================
// SERVICE
// =============================================================================

@Injectable()
export class AIAnalysisService {
  private readonly logger = new Logger(AIAnalysisService.name);

  constructor(
    private readonly aiProviderService: AIProviderService,
    private readonly ollamaService: OllamaService,
    private readonly apiKeysService: ApiKeysService,
  ) {}

  /**
   * Per-task model routing, read from `taskModels` in app-config.json:
   *
   *   "taskModels": { "tags": "ollama:qwen3.5:9b", "description": "ollama:qwen3.5:9b" }
   *
   * Values are "provider:model" strings; a task with no entry uses the job's
   * main model. The point is to let cheap, narrow tasks (metadata generation)
   * run on a small fast model while chapter analysis keeps the big one.
   *
   * Returns {} on any read/parse failure — routing is an optimization, and a
   * malformed config must not take the whole analysis down.
   */
  private loadTaskModelOverrides(): Partial<Record<AITaskKind, string>> {
    try {
      const userDataPath =
        process.env.APPDATA ||
        (process.platform === 'darwin'
          ? path.join(process.env.HOME || '', 'Library', 'Application Support')
          : path.join(process.env.HOME || '', '.config'));
      const configPath = path.join(userDataPath, 'briefcase', 'app-config.json');
      if (!fs.existsSync(configPath)) return {};

      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))?.taskModels;
      if (!raw || typeof raw !== 'object') return {};

      const out: Partial<Record<AITaskKind, string>> = {};
      for (const task of ROUTABLE_TASKS) {
        if (typeof raw[task] === 'string' && raw[task].trim()) out[task] = raw[task].trim();
      }

      // The transcript-facing tasks are deliberately NOT routable: chunk and
      // chapter character caps are derived from the main model's context window
      // (see getModelLimits), so pointing them at a differently-sized model would
      // silently mis-size every prompt. Warn loudly instead of ignoring quietly.
      const rejected = Object.keys(raw).filter(
        (k) => !ROUTABLE_TASKS.includes(k as (typeof ROUTABLE_TASKS)[number]),
      );
      if (rejected.length) {
        this.logger.warn(
          `[TaskModels] Ignoring non-routable task override(s): ${rejected.join(', ')}. ` +
          `Only ${ROUTABLE_TASKS.join(', ')} can be routed — the others drive context sizing.`,
        );
      }
      return out;
    } catch (error) {
      this.logger.warn(`[TaskModels] Ignoring unreadable taskModels config: ${(error as Error).message}`);
      return {};
    }
  }

  /**
   * Resolve the provider config for one task, applying any `taskModels` override.
   *
   * The API key is re-resolved for the override's provider — routing a task to
   * Claude while the base job runs on Ollama must not send Ollama's (absent) key.
   * An override naming a cloud provider with no configured key is ignored rather
   * than allowed to fail the task.
   */
  private resolveTaskConfig(
    base: AIProviderConfig,
    task: AITaskKind,
    overrides: Partial<Record<AITaskKind, string>>,
  ): AIProviderConfig {
    const spec = overrides[task];
    if (!spec) return base;

    const parsed = parseProviderModel(spec);
    const provider = parsed.provider ?? base.provider;
    const model = parsed.model;
    if (!model || (provider === base.provider && model === base.model)) return base;

    let apiKey = base.apiKey;
    if (provider !== base.provider) {
      if (provider === 'claude') apiKey = this.apiKeysService.getClaudeApiKey();
      else if (provider === 'openai') apiKey = this.apiKeysService.getOpenAiApiKey();
      else apiKey = undefined; // ollama / local need none

      if ((provider === 'claude' || provider === 'openai') && !apiKey) {
        this.logger.warn(
          `[TaskModels] Ignoring '${task}' -> ${spec}: no ${provider} API key configured.`,
        );
        return base;
      }
    }

    this.logger.log(`[TaskModels] ${task} -> ${provider}:${model}`);
    return { ...base, provider, model, apiKey };
  }

  /**
   * Main entry point: Analyze transcript using AI
   * Uses two-pass chapter-centric analysis:
   *   Pass 1: Detect chapter boundaries (chunked, lightweight)
   *   Pass 2: Analyze each chapter with full context (title, summary)
   *   Pass 2b: Extract category flags per chapter, as a dedicated call
   */
  async analyzeTranscript(options: AnalysisOptions): Promise<AnalysisResult> {
    console.log('=== AIAnalysisService.analyzeTranscript CALLED (Two-Pass) ===');
    console.log(`Provider: ${options.provider}, Model: ${options.model}`);
    console.log(`[analyzeTranscript] SEGMENTS RECEIVED: ${options.segments?.length || 0}`);
    if (options.segments && options.segments.length > 0) {
      console.log(`[analyzeTranscript] First segment: start=${options.segments[0].start}, end=${options.segments[0].end}, text="${options.segments[0].text?.substring(0, 50)}"`);
      console.log(`[analyzeTranscript] Last segment: start=${options.segments[options.segments.length - 1].start}, end=${options.segments[options.segments.length - 1].end}`);
    } else {
      console.log(`[analyzeTranscript] WARNING: No segments or empty segments array!`);
    }
    this.logger.log('=== AIAnalysisService.analyzeTranscript CALLED (Two-Pass) ===');
    this.logger.log(`Provider: ${options.provider}, Model: ${options.model}`);

    let {
      provider,
      model,
      segments,
      outputFile,
      videoTitle = '',
      categories,
      customInstructions,
      analysisGranularity,
      apiKey,
      ollamaEndpoint,
      onProgress,
    } = options;

    // Strip provider prefix from model if present (shared parser, one source of
    // truth across all entry points), e.g. "local:cogito-8b" -> "cogito-8b".
    {
      const parsed = parseProviderModel(model, provider);
      if (parsed.provider && parsed.provider !== provider) {
        this.logger.log(`[analyzeTranscript] Correcting provider: ${provider} -> ${parsed.provider}`);
        provider = parsed.provider;
      }
      if (parsed.model !== model) {
        model = parsed.model;
        this.logger.log(`[analyzeTranscript] Stripped model prefix: ${model}`);
      }
    }

    // Job-level failure accounting: record explicit failures and abort loudly
    // rather than fabricating success once too many steps fail.
    let failureCount = 0;
    // Remember the most recent failure so an all-failed run can report the real
    // reason (e.g. the underlying Claude API error) instead of an opaque message.
    let lastFailureReason = '';
    const recordFailure = (what: string): void => {
      failureCount++;
      lastFailureReason = what;
      this.logger.error(`[Analysis Failure ${failureCount}/${MAX_FAILURES}] ${what}`);
      if (failureCount >= MAX_FAILURES) {
        throw new Error(
          `TOO_MANY_FAILURES: ${failureCount} analysis steps failed (threshold ${MAX_FAILURES}). ` +
          `Aborting to avoid shipping an incomplete analysis that looks successful.`,
        );
      }
    };

    // Track timing for ETA calculation
    const analysisStartTime = Date.now();
    let pass2StartTime = 0;  // Set after Pass 1 completes
    let totalApiCalls = 0;   // Will be set after Pass 1
    let completedApiCalls = 0;

    const sendProgress = (phase: string, progress: number, message: string) => {
      const elapsedMs = Date.now() - analysisStartTime;
      let eta: number | undefined;

      // Calculate ETA based on Pass 2 timing only (excludes slower Pass 1)
      if (completedApiCalls > 0 && totalApiCalls > 0 && pass2StartTime > 0) {
        const pass2ElapsedMs = Date.now() - pass2StartTime;
        const avgCallTimeMs = pass2ElapsedMs / completedApiCalls;
        const remainingCalls = totalApiCalls - completedApiCalls;
        eta = Math.round((remainingCalls * avgCallTimeMs) / 1000);
      }

      console.log(`[AI Analysis] ${progress}% - ${message} (ETA: ${eta !== undefined ? eta + 's' : 'calculating...'})`);

      if (onProgress) {
        onProgress({ phase, progress, message, eta, elapsedMs });
      }
    };

    // Token tracking for API calls
    const tokenStats: TokenStats = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
      apiCalls: 0,
    };

    const trackTokens = (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => {
      console.log(`[trackTokens] Received: inputTokens=${response.inputTokens}, outputTokens=${response.outputTokens}, cost=${response.estimatedCost}`);
      if (response.inputTokens) tokenStats.inputTokens += response.inputTokens;
      if (response.outputTokens) tokenStats.outputTokens += response.outputTokens;
      tokenStats.totalTokens = tokenStats.inputTokens + tokenStats.outputTokens;
      if (response.estimatedCost) tokenStats.estimatedCost += response.estimatedCost;
      tokenStats.apiCalls++;
      console.log(`[trackTokens] Running total: apiCalls=${tokenStats.apiCalls}, totalTokens=${tokenStats.totalTokens}`);
    };

    try {
      sendProgress('analysis', 0, `Starting AI analysis with ${model}...`);

      // Check model availability (only for Ollama)
      if (provider === 'ollama') {
        const available = await this.ollamaService.isModelAvailable(
          model,
          ollamaEndpoint,
        );
        if (!available) {
          throw new Error(
            `Model '${model}' not found in Ollama. Please install it first.`,
          );
        }
      }

      // Write header to file
      fs.writeFileSync(
        outputFile,
        '='.repeat(80) +
          '\n' +
          'VIDEO ANALYSIS RESULTS\n' +
          '='.repeat(80) +
          '\n\n',
        'utf-8',
      );

      const aiConfig: AIProviderConfig = {
        provider,
        model,
        apiKey,
        ollamaEndpoint,
      };

      // Per-task model routing. Metadata tasks are narrow and cheap, so they can
      // run on a small fast model while chapter work keeps the big one. The three
      // metadata calls run consecutively at the end of the job, so routing all of
      // them to the same model costs exactly ONE model swap, not three.
      const taskModels = this.loadTaskModelOverrides();

      // Effective context window each raw-transcript task will actually use.
      //
      // boundary / chapter / flags all read raw transcript, and each may now be
      // routed to a DIFFERENT model. One shared set of caps therefore has to be
      // safe for all of them, so every limit is the most CONSERVATIVE across the
      // resolved models: sizing to the main model alone would overflow a smaller
      // routed model's context and silently truncate its prompt.
      const contextFor = (cfg: AIProviderConfig): number =>
        cfg.provider === 'local'
          ? 8192 // pinned llama.cpp server context (-c 8192)
          : cfg.provider === 'ollama'
            ? numCtxMaxForModel(cfg.model) // what we request as num_ctx
            : 128000; // claude/openai have large windows

      const rawTranscriptTasks: AITaskKind[] = ['boundary', 'chapter', 'flags'];
      const perTaskLimits = rawTranscriptTasks.map((t) => {
        const cfg = this.resolveTaskConfig(aiConfig, t, taskModels);
        const ctx = contextFor(cfg);
        return { task: t, model: cfg.model, ctx, limits: getModelLimits(cfg.model, ctx) };
      });

      // Two different rules, deliberately:
      //
      //  - CHARACTER caps are a CORRECTNESS guarantee and take the minimum. A
      //    model reading text sized for a larger model's context would silently
      //    truncate its prompt, losing transcript with no error.
      //
      //  - TIME granularity is a QUALITY heuristic (getModelLimits tiers span by
      //    model size) and follows the MAIN model. Taking the minimum here would
      //    shrink chapters whenever chaptering is routed to a small model, which
      //    creates MORE chapters and therefore more calls for whatever expensive
      //    model does flag extraction — the opposite of why routing exists.
      const mainLimits = getModelLimits(model, contextFor(aiConfig));
      const contextTokens = Math.min(...perTaskLimits.map((x) => x.ctx));
      const modelLimits: ModelLimits = {
        maxChunkChars: Math.min(...perTaskLimits.map((x) => x.limits.maxChunkChars)),
        maxChapterChars: Math.min(...perTaskLimits.map((x) => x.limits.maxChapterChars)),
        chunkMinutes: mainLimits.chunkMinutes,
        maxChapterSeconds: mainLimits.maxChapterSeconds,
      };

      const distinct = [...new Set(perTaskLimits.map((x) => x.model))];
      if (distinct.length > 1) {
        this.logger.log(
          `[Model Limits] raw-transcript tasks span ${distinct.length} models (${perTaskLimits
            .map((x) => `${x.task}=${x.model}@${x.ctx}`)
            .join(', ')}) — using the most conservative limits`,
        );
      }
      this.logger.log(
        `[Model Limits] effective ctx=${contextTokens}: chunkMinutes=${modelLimits.chunkMinutes}, ` +
        `maxChunkChars=${modelLimits.maxChunkChars}, maxChapterChars=${modelLimits.maxChapterChars}, ` +
        `maxChapterSeconds=${modelLimits.maxChapterSeconds}`,
      );

      // =========================================================================
      // PASS 1: Detect chapter boundaries
      // =========================================================================
      sendProgress('analysis', 5, 'Detecting chapter boundaries...');
      const boundaries = await this.detectChapterBoundaries(
        this.resolveTaskConfig(aiConfig, 'boundary', taskModels),
        segments,
        videoTitle,
        modelLimits,
        recordFailure,
        trackTokens,
        // Pass 1 owns the 5%-25% band; walk it as chunks complete so the queue
        // sees steady progress instead of a frozen 5% for the whole pass.
        (current, total) => {
          const pct = 5 + Math.round((current / Math.max(1, total)) * 20);
          sendProgress('analysis', pct, `Detecting chapter boundaries (${current}/${total} chunks)...`);
        },
      );
      sendProgress('analysis', 25, `Found ${boundaries.length} chapters`);

      // Calculate total API calls for accurate progress reporting
      // Pass 2 = 1 call per chapter, plus 3 more for description, tags, title
      // chapters + one flag-extraction call each + description/tags/title.
      // Omitting the flag pass here is what produced negative ETAs and a
      // "4/4 API calls" counter on a run that actually made seven.
      let chapterCallCount = boundaries.length;
      totalApiCalls = chapterCallCount * 2 + 3;
      completedApiCalls = 0;
      pass2StartTime = Date.now();  // Start timing from Pass 2 for accurate ETA

      // Progress callback that calculates percentage based on API calls
      // Range: 25% to 95% (70% total for all API calls)
      const calculateProgress = () => {
        return Math.round(25 + (completedApiCalls / totalApiCalls) * 70);
      };

      // =========================================================================
      // PASS 2: Analyze each chapter (title, summary), then extract flags (2b)
      // =========================================================================
      sendProgress('analysis', 26, `Analyzing ${boundaries.length} chapters (0/${totalApiCalls} API calls)...`);
      const { chapters, flags } = await this.analyzeChaptersPass2(
        aiConfig,
        segments,
        boundaries,
        videoTitle,
        categories || [],
        modelLimits,
        recordFailure,
        customInstructions,
        analysisGranularity,
        trackTokens,
        (current, total) => {
          // Post-split chapter count is only known here; correct the estimate so
          // the ETA stops drifting when Pass 2 splits long chapters.
          if (total !== chapterCallCount) {
            chapterCallCount = total;
            totalApiCalls = chapterCallCount * 2 + 3;
          }
          completedApiCalls = current;
          const progress = calculateProgress();
          sendProgress('analysis', progress, `Analyzing chapter ${current}/${total} (${completedApiCalls}/${totalApiCalls} API calls)...`);
        },
        taskModels,
        (current, total) => {
          completedApiCalls = chapterCallCount + current;
          const progress = calculateProgress();
          sendProgress('analysis', progress, `Finding flagged quotes ${current}/${total} (${completedApiCalls}/${totalApiCalls} API calls)...`);
        },
      );
      sendProgress('analysis', calculateProgress(), `Analyzed ${chapters.length} chapters, found ${flags.length} flags`);

      // Honest-failure gate: if NOT ONE chapter was successfully analyzed, the
      // run produced nothing real (every API call failed). Fail loudly with the
      // real reason instead of returning an empty analysis that looks successful
      // — stale/no data beats a lie. A partial run (some chapters analyzed, some
      // failed) still completes below with whatever succeeded.
      const successfulChapters = chapters.filter((ch) => !ch.failed).length;
      if (successfulChapters === 0) {
        throw new Error(
          lastFailureReason
            ? `no chapters could be analyzed — every analysis call failed. Last failure: ${lastFailureReason}`
            : 'no chapters could be analyzed — every analysis call failed.',
        );
      }

      // Write chapter flags to file
      for (const flag of flags) {
        this.writeSectionToFile(outputFile, flag);
      }

      // =========================================================================
      // Generate metadata FROM chapters
      // =========================================================================
      // These three are independent functions of `chapters` — none reads another's
      // result — so they may run in any order. They are therefore ORDERED BY
      // MODEL, not by name: everything still on the main model runs first (it is
      // already resident from Pass 2), then each override model in turn. Each
      // model is loaded exactly once and we never swap back to one we've left.
      //
      // This matters because a swap-back is the expensive case: reloading a 27B
      // costs far more than the metadata calls it would be interleaved with, so
      // grouping is what makes routing a win instead of a wash. Ordering here
      // rather than relying on the config's task order means any taskModels
      // combination gets the minimum number of loads automatically.
      let description: string | null = null;
      let tags: Tags | null = null;
      let suggestedTitle: string | null = null;

      const metadataSteps = (
        [
          { task: 'description', label: 'Generating description' },
          { task: 'tags', label: 'Extracting tags' },
          { task: 'title', label: 'Generating title' },
        ] as const
      ).map((step) => {
        const cfg = this.resolveTaskConfig(aiConfig, step.task, taskModels);
        return { ...step, cfg, key: `${cfg.provider}:${cfg.model}` };
      });

      const mainKey = `${aiConfig.provider}:${aiConfig.model}`;
      // Main model first (already loaded), then each other model in first-appearance
      // order. Stable within a group, so same-model tasks keep their relative order.
      const orderedKeys = [
        ...(metadataSteps.some((s) => s.key === mainKey) ? [mainKey] : []),
        ...metadataSteps
          .map((s) => s.key)
          .filter((k, i, arr) => k !== mainKey && arr.indexOf(k) === i),
      ];
      if (orderedKeys.length > 1) {
        this.logger.log(
          `[TaskModels] Metadata runs grouped by model, one load each: ${orderedKeys.join(' -> ')}`,
        );
      }

      for (const key of orderedKeys) {
        for (const step of metadataSteps.filter((s) => s.key === key)) {
          completedApiCalls++;
          sendProgress(
            'analysis',
            calculateProgress(),
            `${step.label} (${completedApiCalls}/${totalApiCalls} API calls)...`,
          );
          switch (step.task) {
            case 'description':
              description = await this.generateDescriptionFromChapters(
                step.cfg, chapters, videoTitle, recordFailure, trackTokens,
              );
              break;
            case 'tags':
              tags = await this.generateTagsFromChapters(
                step.cfg, chapters, recordFailure, trackTokens,
              );
              break;
            case 'title':
              suggestedTitle = await this.generateTitleFromChapters(
                step.cfg, chapters, videoTitle, recordFailure, trackTokens,
              );
              break;
          }
        }
      }

      // Prepend summary to file (only when a real description was produced;
      // a failed description is null and must not become a placeholder).
      if (description) {
        this.prependSummaryToFile(outputFile, description);
      }

      // Log token usage summary
      console.log('');
      console.log('='.repeat(60));
      console.log('AI ANALYSIS TOKEN USAGE SUMMARY (Two-Pass)');
      console.log('='.repeat(60));
      console.log(`Provider: ${provider}`);
      console.log(`Model: ${model}`);
      console.log(`API Calls: ${tokenStats.apiCalls}`);
      console.log(`Input Tokens: ${tokenStats.inputTokens.toLocaleString()}`);
      console.log(`Output Tokens: ${tokenStats.outputTokens.toLocaleString()}`);
      console.log(`Total Tokens: ${tokenStats.totalTokens.toLocaleString()}`);
      console.log('='.repeat(60));
      console.log('');

      this.logger.log('AI ANALYSIS TOKEN SUMMARY: ' +
        `apiCalls=${tokenStats.apiCalls}, ` +
        `inputTokens=${tokenStats.inputTokens}, ` +
        `outputTokens=${tokenStats.outputTokens}, ` +
        `totalTokens=${tokenStats.totalTokens}`
      );

      sendProgress('analysis', 100, 'Analysis complete!');

      // Debug: Log what we're returning
      console.log(`[analyzeTranscript] RETURNING: sections=${flags.length}, chapters=${chapters.length}, tags=${JSON.stringify(tags)}`);
      if (chapters.length > 0) {
        console.log(`[analyzeTranscript] Chapters being returned: ${JSON.stringify(chapters)}`);
      }

      return {
        sections_count: flags.length,
        sections: flags,           // Category flags from chapter analysis
        chapters: chapters,        // Chapter list with titles/summaries
        tags,
        description,
        suggested_title: suggestedTitle || undefined,
        tokenStats: tokenStats.apiCalls > 0 ? tokenStats : undefined,
      };
    } catch (error) {
      const message = `AI analysis failed: ${(error as Error).message}`;
      this.logger.error(message);
      throw new Error(message);
    }
  }

  /**
   * Split transcript into time-based chunks
   */
  private chunkTranscript(
    segments: Segment[],
    chunkMinutes: number = 15,
  ): Chunk[] {
    console.log(`[chunkTranscript] Input segments: ${segments?.length || 0}, chunkMinutes: ${chunkMinutes}`);
    const chunks: Chunk[] = [];

    if (!segments || segments.length === 0) {
      console.log(`[chunkTranscript] WARNING: No segments to chunk!`);
      return [];
    }

    const chunkDuration = chunkMinutes * 60;
    const totalDuration = segments[segments.length - 1].end;
    console.log(`[chunkTranscript] Total duration: ${totalDuration}s, chunk duration: ${chunkDuration}s`);

    let currentStart = 0;
    let chunkNum = 1;

    while (currentStart < totalDuration) {
      const chunkEnd = currentStart + chunkDuration;

      const chunkSegments = segments.filter(
        (seg) => seg.start >= currentStart && seg.start < chunkEnd,
      );

      if (chunkSegments.length > 0) {
        const chunkText = chunkSegments.map((seg) => seg.text.trim()).join(' ');
        chunks.push({
          number: chunkNum,
          startTime: currentStart,
          endTime: Math.min(chunkEnd, totalDuration),
          text: chunkText,
          segments: chunkSegments,
        });
        console.log(`[chunkTranscript] Chunk ${chunkNum}: ${chunkSegments.length} segments, time ${currentStart}-${Math.min(chunkEnd, totalDuration)}`);
        chunkNum++;
      }

      currentStart = chunkEnd;
    }

    console.log(`[chunkTranscript] Created ${chunks.length} chunks total`);
    return chunks;
  }

  /**
   * Find the timestamp for a specific phrase in the transcript segments
   * Uses multiple strategies including fuzzy matching to handle:
   * - Whisper transcription errors
   * - AI quote corrections/paraphrasing
   * - Cross-segment quotes
   */
  private findPhraseTimestamp(
    phrase: string,
    segments: Segment[],
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
    let bestFuzzyMatch: { segment: Segment; score: number } | null = null;

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
      this.logger.debug(
        `[Fuzzy Match] Found "${phrase.substring(0, 30)}..." at ${bestFuzzyMatch.segment.start}s (score: ${bestFuzzyMatch.score.toFixed(2)})`,
      );
      return bestFuzzyMatch.segment.start;
    }

    // Strategy 4: Distinctive word matching
    // Find uncommon words in the quote and search for segments containing them
    if (phraseWords.length > 0) {
      let bestWordMatch: { segment: Segment; matchCount: number; fuzzyScore: number } | null = null;

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
        this.logger.debug(
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
        this.logger.debug(
          `[Cross-segment Fuzzy] Found "${phrase.substring(0, 30)}..." at ${segments[i].start}s (score: ${similarity.toFixed(2)})`,
        );
        return segments[i].start;
      }
    }

    this.logger.debug(`[No Match] Could not find: "${phrase.substring(0, 50)}..."`);
    return null;
  }

  // =============================================================================
  // TWO-PASS CHAPTER ANALYSIS METHODS
  // =============================================================================

  /**
   * PASS 1: Detect chapter boundaries using chunked processing
   * Processes transcript in time-based chunks to find topic change points
   */
  private async detectChapterBoundaries(
    config: AIProviderConfig,
    segments: Segment[],
    videoTitle: string,
    limits: ModelLimits,
    recordFailure: (what: string) => void,
    onTokens?: (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void,
    onChunkProgress?: (current: number, total: number) => void,
  ): Promise<number[]> {
    const boundaries: number[] = [0]; // First chapter always starts at 0
    let previousTopic = '';

    if (!segments || segments.length === 0) {
      this.logger.warn('No segments available for boundary detection');
      return boundaries;
    }

    // Calculate total video duration from segments
    const lastSegment = segments[segments.length - 1];
    const videoDurationSeconds = lastSegment?.end || lastSegment?.start || 0;

    const chunks = this.chunkTranscript(segments, limits.chunkMinutes);
    this.logger.log(`[Pass 1] Detecting boundaries in ${chunks.length} chunks (${limits.chunkMinutes} min each), video duration: ${Math.round(videoDurationSeconds)}s`);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const isFirst = i === 0;

      const prompt = buildBoundaryDetectionPrompt(
        videoTitle,
        chunk.text.substring(0, limits.maxChunkChars),
        previousTopic,
        isFirst,
        videoDurationSeconds,
      );

      // Try once, then retry once. A chunk that still won't produce a parseable
      // result is a recorded failure — NOT silently dropped (its boundaries are
      // lost, which is why it must be counted against the abort threshold).
      let result: BoundaryDetectionResult | null = null;
      // Capture the underlying error so a recorded failure carries the real
      // reason (e.g. a Claude 400) rather than a generic message.
      let lastError = '';
      for (let attempt = 0; attempt <= 1; attempt++) {
        try {
          const response = await this.aiProviderService.generateText(prompt, config, 'boundary');
          onTokens?.(response);
          if (response && response.text) {
            result = this.parseBoundaryResponse(response.text);
            if (result) break;
            this.logger.warn(`[Pass 1] Chunk ${i + 1} unparseable (attempt ${attempt + 1})`);
          } else {
            this.logger.warn(`[Pass 1] No response for chunk ${i + 1} (attempt ${attempt + 1})`);
          }
        } catch (error) {
          lastError = (error as Error).message;
          this.logger.warn(`[Pass 1] Error processing chunk ${i + 1} (attempt ${attempt + 1}): ${lastError}`);
        }
        if (attempt < 1) await this.delay(1000);
      }

      // Report after every chunk, INCLUDING failed ones. This is what keeps
      // lastProgressAt moving during Pass 1: without it the whole pass (plus the
      // model load in front of it) elapses at a frozen 5%, which trips the
      // queue's stall warning on any slow model and hides a genuinely wedged
      // Ollama behind a false positive.
      onChunkProgress?.(i + 1, chunks.length);

      if (!result) {
        recordFailure(
          `Pass 1 boundary detection failed for chunk ${i + 1}/${chunks.length} after retry` +
          (lastError ? `: ${lastError}` : ''),
        );
        continue;
      }

      // Map phrases to timestamps
      for (const phrase of result.boundaries) {
        const time = this.findPhraseTimestamp(phrase, chunk.segments);
        if (time !== null && !boundaries.includes(time)) {
          boundaries.push(time);
          this.logger.debug(`[Pass 1] Found boundary at ${this.formatDisplayTime(time)}: "${phrase.substring(0, 30)}..."`);
        }
      }

      previousTopic = result.end_topic;
      this.logger.debug(`[Pass 1] Chunk ${i + 1} end topic: "${previousTopic}"`);
    }

    // Sort boundaries by time
    boundaries.sort((a, b) => a - b);
    this.logger.log(`[Pass 1] Found ${boundaries.length} chapter boundaries`);

    return boundaries;
  }

  /**
   * Parse boundary detection response with robust JSON handling
   */
  private parseBoundaryResponse(response: string): BoundaryDetectionResult | null {
    // Use safe JSON parsing with multiple strategies. Returns null on failure —
    // the caller retries then records an explicit failure. A successfully parsed
    // result with an empty boundaries array is a VALID "no topic change here"
    // answer, not a failure.
    const parsed = safeJsonParse<Record<string, unknown>>(response, this.logger);

    if (!parsed) {
      this.logger.warn('[Pass 1] Failed to parse boundary response - all strategies failed');
      this.logger.debug(`[Pass 1] Raw response was: ${response.substring(0, 500)}...`);
      return null;
    }

    // Validate the parsed result
    const validated = validateBoundaryResult(parsed);

    if (!validated) {
      this.logger.warn('[Pass 1] Boundary response failed validation');
      return null;
    }

    return validated;
  }

  /**
   * Split boundaries to ensure no chapter exceeds the model's max chapter duration
   * This prevents very long chapters that might cause truncation or model issues
   */
  private splitLongChapters(
    boundaries: number[],
    videoDuration: number,
    limits: ModelLimits,
  ): number[] {
    const result: number[] = [];
    const maxDuration = limits.maxChapterSeconds;

    this.logger.log(
      `[Pass 2] Max chapter duration for this model: ${maxDuration}s (${Math.round(maxDuration / 60)} min)`,
    );

    for (let i = 0; i < boundaries.length; i++) {
      const startTime = boundaries[i];
      const endTime = i < boundaries.length - 1 ? boundaries[i + 1] : videoDuration;
      const duration = endTime - startTime;

      result.push(startTime);

      // If chapter is too long, split it into smaller chunks
      if (duration > maxDuration) {
        const numSplits = Math.ceil(duration / maxDuration);
        const splitDuration = duration / numSplits;

        this.logger.log(
          `[Pass 2] Splitting long chapter (${Math.round(duration)}s) at ${this.formatDisplayTime(startTime)} into ${numSplits} parts (max ${maxDuration}s each)`,
        );

        for (let j = 1; j < numSplits; j++) {
          const splitTime = startTime + j * splitDuration;
          result.push(splitTime);
        }
      }
    }

    // Sort and deduplicate
    return Array.from(new Set(result)).sort((a, b) => a - b);
  }

  /**
   * Analyze a single chapter with retry logic
   * Returns the analysis result or a fallback on failure
   */
  private async analyzeChapterWithRetry(
    config: AIProviderConfig,
    chapterText: string,
    videoTitle: string,
    chapterNumber: number,
    previousChapterSummary: string,
    customInstructions: string | undefined,
    onTokens?: (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void,
  ): Promise<ChapterAnalysisResult> {
    const maxRetries = JSON_PARSE_RETRIES;
    // Capture the underlying error so the final throw carries the real reason
    // (e.g. a Claude 400) rather than an opaque "failed after N attempts".
    let lastError = '';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const prompt = buildChapterAnalysisPrompt(
          videoTitle,
          chapterText,
          chapterNumber,
          previousChapterSummary,
          customInstructions,
        );

        const response = await this.aiProviderService.generateText(prompt, config, 'chapter');
        onTokens?.(response);

        if (!response || !response.text) {
          this.logger.warn(`[Pass 2] No response for chapter ${chapterNumber} (attempt ${attempt + 1})`);
          if (attempt < maxRetries) {
            await this.delay(1000 * (attempt + 1)); // Exponential backoff
            continue;
          }
          break;
        }

        // Returns null on parse/validation failure (no fabricated "Unknown").
        const result = this.parseChapterAnalysisResponse(response.text);
        if (result) {
          return result;
        }

        if (attempt < maxRetries) {
          this.logger.warn(`[Pass 2] Chapter ${chapterNumber} unparseable, retrying (attempt ${attempt + 1})`);
          await this.delay(1000 * (attempt + 1));
          continue;
        }
      } catch (error) {
        lastError = (error as Error).message;
        this.logger.warn(`[Pass 2] Error analyzing chapter ${chapterNumber} (attempt ${attempt + 1}): ${lastError}`);
        if (attempt < maxRetries) {
          await this.delay(1000 * (attempt + 1));
          continue;
        }
      }
    }

    // All retries exhausted — fail loudly. The caller records this as an explicit
    // failure and marks the chapter failed; it is NEVER written to the DB as a
    // fabricated "Chapter N (analysis failed)" success row.
    throw new Error(
      `Chapter ${chapterNumber} analysis failed after ${maxRetries + 1} attempts` +
      (lastError ? `: ${lastError}` : ''),
    );
  }

  /**
   * PASS 2b: Extract category flags for one chapter, as a DEDICATED call.
   *
   * Split out from chapter titling so the model spends its whole budget looking
   * for matches instead of treating `flags` as a third field to fill in after
   * the title and summary.
   *
   * Unlike chapter analysis this NEVER throws: flags are additive findings, so a
   * chapter whose extraction fails still keeps its title and summary rather than
   * failing the whole chapter. A failure returns [] and is logged — the caller
   * counts it via `onFailure` so a systematically broken extraction is still
   * visible rather than silently producing an unflagged video.
   */
  private async extractChapterFlags(
    config: AIProviderConfig,
    chapterText: string,
    videoTitle: string,
    categories: AnalysisCategory[],
    chapterNumber: number,
    sensitivity: number | undefined,
    customInstructions: string | undefined,
    onTokens?: (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void,
    onFailure?: (message: string) => void,
  ): Promise<ChapterFlag[]> {
    const enabled = categories?.filter((c) => c.enabled !== false) || [];
    if (enabled.length === 0) return [];

    const prompt = buildFlagExtractionPrompt(
      videoTitle,
      chapterText,
      categories,
      chapterNumber,
      sensitivity,
      customInstructions,
    );

    let lastError = '';
    for (let attempt = 0; attempt <= JSON_PARSE_RETRIES; attempt++) {
      try {
        const response = await this.aiProviderService.generateText(prompt, config, 'flags');
        onTokens?.(response);

        if (response?.text) {
          const parsed = this.parseFlagExtractionResponse(response.text);
          if (parsed) return parsed;
          this.logger.warn(
            `[Pass 2b] Chapter ${chapterNumber} flag response unparseable (attempt ${attempt + 1})`,
          );
        } else {
          this.logger.warn(`[Pass 2b] No flag response for chapter ${chapterNumber} (attempt ${attempt + 1})`);
        }
      } catch (error) {
        lastError = (error as Error).message;
        this.logger.warn(
          `[Pass 2b] Error extracting flags for chapter ${chapterNumber} (attempt ${attempt + 1}): ${lastError}`,
        );
      }
      if (attempt < JSON_PARSE_RETRIES) await this.delay(1000 * (attempt + 1));
    }

    onFailure?.(
      `Pass 2b chapter ${chapterNumber} flag extraction failed` + (lastError ? `: ${lastError}` : ''),
    );
    return [];
  }

  /**
   * Parse the dedicated flag-extraction response. Returns null when the payload
   * is not usable at all (so the caller can retry) and [] when the model
   * legitimately reported no matches.
   */
  private parseFlagExtractionResponse(text: string): ChapterFlag[] | null {
    // Same multi-strategy parser the chapter path uses, so a thinking model's
    // stray prose around the JSON is salvaged identically.
    const parsed = safeJsonParse<Record<string, unknown>>(text, this.logger);
    if (!parsed || typeof parsed !== 'object') return null;

    const raw = parsed.flags;
    if (!Array.isArray(raw)) return null;

    return raw.filter((f): f is ChapterFlag => {
      return (
        !!f &&
        typeof f === 'object' &&
        typeof (f as ChapterFlag).category === 'string' &&
        (typeof (f as ChapterFlag).description === 'string' ||
          typeof (f as ChapterFlag).quote === 'string')
      );
    });
  }

  /**
   * Simple delay helper for retry backoff
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * PASS 2: Analyze each chapter with full context
   * Generates title and summary per chapter, then runs the dedicated flag pass
   */
  private async analyzeChaptersPass2(
    config: AIProviderConfig,
    segments: Segment[],
    boundaries: number[],
    videoTitle: string,
    categories: AnalysisCategory[],
    limits: ModelLimits,
    recordFailure: (what: string) => void,
    customInstructions?: string,
    analysisGranularity?: number,
    onTokens?: (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void,
    onChapterProgress?: (current: number, total: number) => void,
    taskModels: Partial<Record<AITaskKind, string>> = {},
    onFlagProgress?: (current: number, total: number) => void,
  ): Promise<{ chapters: Chapter[]; flags: AnalyzedSection[] }> {
    const chapters: Chapter[] = [];
    const allFlags: AnalyzedSection[] = [];

    if (!segments || segments.length === 0) {
      this.logger.warn('[Pass 2] No segments available for chapter analysis');
      return { chapters, flags: allFlags };
    }

    const videoDuration = segments[segments.length - 1].end;

    // Split any chapters that are too long to prevent truncation issues
    const adjustedBoundaries = this.splitLongChapters(boundaries, videoDuration, limits);
    if (adjustedBoundaries.length > boundaries.length) {
      this.logger.log(
        `[Pass 2] Split long chapters: ${boundaries.length} -> ${adjustedBoundaries.length} chapters`,
      );
    }

    let previousChapterSummary = '';

    this.logger.log(`[Pass 2] Analyzing ${adjustedBoundaries.length} chapters (max ${limits.maxChapterChars} chars each)`);

    // Chapter analysis may be routed to its own (typically smaller) model. All
    // chapter calls run consecutively, so this model loads once.
    const chapterConfig = this.resolveTaskConfig(config, 'chapter', taskModels);
    if (chapterConfig.model !== config.model) {
      this.logger.log(`[Pass 2] Analyzing chapters on ${chapterConfig.provider}:${chapterConfig.model}`);
    }

    // Chapters that succeeded and still need flag extraction (Pass 2b).
    const pendingFlagWork: Array<{
      index: number;
      chapterNumber: number;
      truncatedText: string;
      chapterSegments: Segment[];
      startTime: number;
      endTime: number;
    }> = [];

    for (let i = 0; i < adjustedBoundaries.length; i++) {
      const startTime = adjustedBoundaries[i];
      const endTime = i < adjustedBoundaries.length - 1 ? adjustedBoundaries[i + 1] : videoDuration;

      // Extract chapter transcript
      const chapterSegments = segments.filter(
        (s) => s.start >= startTime && s.start < endTime,
      );

      if (chapterSegments.length === 0) {
        this.logger.debug(`[Pass 2] No segments for chapter ${i + 1}, skipping`);
        continue;
      }

      const chapterText = chapterSegments.map((s) => s.text).join(' ');
      const chapterDuration = endTime - startTime;

      // Log if we're still truncating (shouldn't happen often after splitting)
      if (chapterText.length > limits.maxChapterChars) {
        this.logger.warn(
          `[Pass 2] Chapter ${i + 1} (${Math.round(chapterDuration)}s) still exceeds limit: ` +
          `${chapterText.length} chars -> truncating to ${limits.maxChapterChars}`,
        );
      }

      // Truncate if needed
      const truncatedText = chapterText.substring(0, limits.maxChapterChars);

      // Use retry-enabled analysis. On exhaustion it THROWS — we record the
      // failure and push a chapter explicitly marked failed (no title/summary,
      // no fabricated content). Finalize excludes failed chapters from the DB.
      let result: ChapterAnalysisResult;
      try {
        result = await this.analyzeChapterWithRetry(
          chapterConfig,
          truncatedText,
          videoTitle,
          i + 1,
          previousChapterSummary,
          customInstructions,
          onTokens,
        );
      } catch (error) {
        recordFailure(`Pass 2 chapter ${i + 1}/${adjustedBoundaries.length} analysis failed: ${(error as Error).message}`);
        chapters.push({
          sequence: i + 1,
          start_time: this.formatDisplayTime(startTime),
          end_time: this.formatDisplayTime(endTime),
          title: '',
          summary: '',
          failed: true,
        });
        if (onChapterProgress) {
          onChapterProgress(i + 1, adjustedBoundaries.length);
        }
        // Do not carry a failed chapter's (empty) summary into the next chapter.
        continue;
      }

      // Flag extraction deliberately does NOT happen here — see the Pass 2b loop
      // below. Running it inline would alternate chapter/flags per iteration,
      // which reloads an 18GB model between every call the moment the two tasks
      // are routed to different models.
      pendingFlagWork.push({
        index: i,
        chapterNumber: i + 1,
        truncatedText,
        chapterSegments,
        startTime,
        endTime,
      });

      // Create chapter entry
      chapters.push({
        sequence: i + 1,
        start_time: this.formatDisplayTime(startTime),
        end_time: this.formatDisplayTime(endTime),
        title: result.title,
        summary: result.summary,
      });

      // Report progress after each chapter
      if (onChapterProgress) {
        onChapterProgress(i + 1, adjustedBoundaries.length);
      }

      // Save summary for next chapter's context
      previousChapterSummary = result.summary;

      this.logger.debug(`[Pass 2] Chapter ${i + 1}: "${result.title.substring(0, 50)}..."`);
    }


    // =========================================================================
    // PASS 2b: flag extraction for every chapter, as its own phase.
    //
    // Kept separate from the chapter loop so all chapter work finishes before
    // any flag work starts. Flag extraction reads the same truncated chapter
    // text and never the chapter's title/summary, so the two are independent and
    // safe to separate — and separating them means each model loads once even
    // when 'flags' is routed to a different model than 'chapter'.
    // =========================================================================
    if (pendingFlagWork.length > 0) {
      const flagConfig = this.resolveTaskConfig(config, 'flags', taskModels);
      this.logger.log(
        `[Pass 2b] Extracting flags for ${pendingFlagWork.length} chapters on ${flagConfig.provider}:${flagConfig.model} ` +
        `(concurrency ${Math.min(FLAG_EXTRACTION_CONCURRENCY, pendingFlagWork.length)})`,
      );

      // Extract concurrently, but WRITE results in chapter order below: flags are
      // rendered on a timeline, so interleaving them by completion order would
      // scramble the output for no benefit.
      const extracted: ChapterFlag[][] = new Array(pendingFlagWork.length);
      let nextWorkIndex = 0;
      let completedFlagChapters = 0;

      const runWorker = async (): Promise<void> => {
        for (;;) {
          const slot = nextWorkIndex++;
          if (slot >= pendingFlagWork.length) return;
          const work = pendingFlagWork[slot];
          // extractChapterFlags never throws — a failed chapter yields [] and is
          // counted via recordFailure — so one bad chapter cannot abort the pool.
          extracted[slot] = await this.extractChapterFlags(
            flagConfig,
            work.truncatedText,
            videoTitle,
            categories,
            work.chapterNumber,
            analysisGranularity,
            customInstructions,
            onTokens,
            recordFailure,
          );
          completedFlagChapters++;
          onFlagProgress?.(completedFlagChapters, pendingFlagWork.length);
        }
      };

      await Promise.all(
        Array.from(
          { length: Math.min(FLAG_EXTRACTION_CONCURRENCY, pendingFlagWork.length) },
          () => runWorker(),
        ),
      );

      for (let slot = 0; slot < pendingFlagWork.length; slot++) {
        const work = pendingFlagWork[slot];
        const { chapterNumber, chapterSegments, startTime, endTime } = work;
        const flags = extracted[slot] ?? [];

        // Convert flags to AnalyzedSection format - pass through without filtering
        if (flags.length > 0) {
          for (const flag of flags) {
            // Try to find the actual timestamp of the quote in the transcript
            let flagStartTime = startTime;
            if (flag.quote) {
              const foundTime = this.findPhraseTimestamp(flag.quote, chapterSegments);
              if (foundTime !== null) {
                flagStartTime = foundTime;
              } else {
                // Quote not found - log for debugging
                this.logger.debug(`[Pass 2b] Quote not found in transcript: "${flag.quote.substring(0, 80)}..."`);
              }
            } else {
              this.logger.debug(`[Pass 2b] Flag has no quote field: ${JSON.stringify(flag)}`);
            }

            // Build description: prefer quote (verbatim text), fall back to description
            // If both exist, show quote first with reason after
            let displayDescription = flag.description || '';
            if (flag.quote) {
              if (flag.description) {
                displayDescription = `"${flag.quote}" — ${flag.description}`;
              } else {
                displayDescription = `"${flag.quote}"`;
              }
            }

            allFlags.push({
              category: flag.category,
              description: displayDescription,
              start_time: this.formatDisplayTime(flagStartTime),
              end_time: this.formatDisplayTime(Math.min(flagStartTime + 30, endTime)), // ~30 sec duration
              quotes: flag.quote
                ? [
                    {
                      timestamp: this.formatDisplayTime(flagStartTime),
                      text: flag.quote,
                      significance: flag.description,
                    },
                  ]
                : [],
            });
          }
        }
        this.logger.debug(`[Pass 2b] Chapter ${chapterNumber}: ${flags.length} flags`);
      }
    }

    // Deduplicate flags with the same or very close timestamps (within 5 seconds)
    // This handles cases where less capable models create multiple flags for the same content
    const deduplicatedFlags: AnalyzedSection[] = [];
    for (const flag of allFlags) {
      // Check if we already have a flag at a similar time
      const existingIndex = deduplicatedFlags.findIndex((f) => {
        const startA = this.parseDisplayTime(f.start_time);
        const startB = this.parseDisplayTime(flag.start_time);
        return Math.abs(startA - startB) < 5; // Within 5 seconds
      });

      if (existingIndex === -1) {
        // No duplicate, add it
        deduplicatedFlags.push(flag);
      } else {
        // Duplicate found - log it but don't add
        this.logger.debug(
          `[Pass 2] Skipping duplicate flag at ${flag.start_time} (category: ${flag.category}) - similar to existing flag at ${deduplicatedFlags[existingIndex].start_time}`,
        );
      }
    }

    if (deduplicatedFlags.length < allFlags.length) {
      this.logger.log(
        `[Pass 2] Deduplicated flags: ${allFlags.length} -> ${deduplicatedFlags.length}`,
      );
    }

    this.logger.log(`[Pass 2] Analyzed ${chapters.length} chapters, found ${deduplicatedFlags.length} category flags`);
    return { chapters, flags: deduplicatedFlags };
  }

  /**
   * Parse chapter analysis response with robust JSON handling
   */
  private parseChapterAnalysisResponse(response: string): ChapterAnalysisResult | null {
    // Use safe JSON parsing with multiple strategies. Returns null on failure —
    // the caller retries, then records an explicit failure. No fabricated
    // "Unknown"/salvage object that would masquerade as a real chapter.
    const parsed = safeJsonParse<Record<string, unknown>>(response, this.logger);

    if (!parsed) {
      this.logger.warn('[Pass 2] Failed to parse chapter analysis response - all strategies failed');
      this.logger.debug(`[Pass 2] Raw response was: ${response.substring(0, 500)}...`);
      return null;
    }

    // Validate the parsed result
    const validated = validateChapterAnalysisResult(parsed);

    if (!validated) {
      this.logger.warn('[Pass 2] Chapter analysis response failed validation');
      this.logger.debug(`[Pass 2] Parsed data was: ${JSON.stringify(parsed).substring(0, 500)}`);
      return null;
    }

    // Debug: Log what the AI returned for flags
    if (validated.flags && validated.flags.length > 0) {
      this.logger.debug(`[Pass 2] Raw flags from AI: ${JSON.stringify(validated.flags, null, 2)}`);
    }

    return validated;
  }

  /**
   * Generate video description from chapter summaries
   */
  private async generateDescriptionFromChapters(
    config: AIProviderConfig,
    chapters: Chapter[],
    videoTitle: string,
    recordFailure: (what: string) => void,
    onTokens?: (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void,
  ): Promise<string | null> {
    // Only summarize chapters that actually succeeded.
    const validChapters = (chapters || []).filter((ch) => !ch.failed);
    if (validChapters.length === 0) {
      recordFailure('Description generation: no successfully-analyzed chapters to summarize');
      return null;
    }

    try {
      const chaptersList = validChapters
        .map((ch) => `${ch.sequence}. [${ch.start_time}] ${ch.title}${ch.summary ? ` - ${ch.summary}` : ''}`)
        .join('\n');

      const prompt = interpolatePrompt(DESCRIPTION_FROM_CHAPTERS_PROMPT, {
        videoTitle: videoTitle || 'Untitled',
        chaptersList: chaptersList.substring(0, 4000),
      });

      const response = await this.aiProviderService.generateText(prompt, config, 'description');
      onTokens?.(response);

      if (response && response.text) {
        const description = response.text.trim();

        // Reject AI refusals — a refusal is a real failure, not a description.
        const invalidPatterns = [
          /^i apologize/i,
          /^i'm sorry/i,
          /^i cannot/i,
          /^unfortunately/i,
          /^as an ai/i,
        ];
        if (invalidPatterns.some((p) => p.test(description))) {
          recordFailure(`Description generation returned an AI refusal: "${description.substring(0, 50)}..."`);
          return null;
        }

        if (description) {
          return description;
        }
      }

      // Empty/no text — an explicit failure, NOT a synthesized placeholder.
      recordFailure('Description generation returned empty text');
      return null;
    } catch (error) {
      recordFailure(`Description generation failed: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Extract tags from chapter content
   */
  private async generateTagsFromChapters(
    config: AIProviderConfig,
    chapters: Chapter[],
    recordFailure: (what: string) => void,
    onTokens?: (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void,
  ): Promise<Tags | null> {
    // Only tag chapters that actually succeeded.
    const validChapters = (chapters || []).filter((ch) => !ch.failed);
    if (validChapters.length === 0) {
      recordFailure('Tags extraction: no successfully-analyzed chapters to tag');
      return null;
    }

    try {
      const chaptersList = validChapters
        .map((ch) => `${ch.title}${ch.summary ? `: ${ch.summary}` : ''}`)
        .join('\n');

      const prompt = interpolatePrompt(TAGS_FROM_CHAPTERS_PROMPT, {
        chaptersList: chaptersList.substring(0, 4000),
      });

      const response = await this.aiProviderService.generateText(prompt, config, 'tags');
      onTokens?.(response);

      if (response && response.text) {
        // Use the shared parser (markdown-strip + brace-balance + repair, plus
        // think-tag stripping). A successful parse with no tags is a valid empty
        // result; only a genuine PARSE failure is recorded as a failure.
        const tagsData = safeJsonParse<{ people?: unknown; topics?: unknown }>(response.text, this.logger);
        if (tagsData) {
          return {
            people: Array.isArray(tagsData.people) ? (tagsData.people as string[]).slice(0, 20) : [],
            topics: Array.isArray(tagsData.topics) ? (tagsData.topics as string[]).slice(0, 15) : [],
          };
        }
        recordFailure('Tags extraction: response could not be parsed as JSON');
        return null;
      }

      recordFailure('Tags extraction returned empty text');
      return null;
    } catch (error) {
      recordFailure(`Tags extraction failed: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Generate suggested title from chapter content
   */
  private async generateTitleFromChapters(
    config: AIProviderConfig,
    chapters: Chapter[],
    currentTitle: string,
    recordFailure: (what: string) => void,
    onTokens?: (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void,
  ): Promise<string | null> {
    // Only title from chapters that actually succeeded. A null title is a
    // legitimate "keep the original filename" outcome, so an empty/rejected
    // title is not counted as a failure; only a hard error is.
    const validChapters = (chapters || []).filter((ch) => !ch.failed);
    if (validChapters.length === 0) {
      return null;
    }

    try {
      const chaptersList = validChapters
        .map((ch) => `${ch.title}${ch.summary ? `: ${ch.summary}` : ''}`)
        .join('\n');

      const prompt = interpolatePrompt(TITLE_FROM_CHAPTERS_PROMPT, {
        currentTitle: currentTitle || 'untitled',
        chaptersList: chaptersList.substring(0, 4000),
      });

      const response = await this.aiProviderService.generateText(prompt, config, 'title');
      onTokens?.(response);

      if (response && response.text) {
        let suggestedTitle = response.text.trim();

        // Remove quotes
        if (suggestedTitle.startsWith('"') && suggestedTitle.endsWith('"')) {
          suggestedTitle = suggestedTitle.slice(1, -1);
        }

        // Strip only a trailing file extension (e.g. ".mp4"), not mid-title dots
        // like "$3.5 million".
        suggestedTitle = suggestedTitle.replace(/\.[A-Za-z0-9]{1,5}$/, '');

        // Remove date prefix
        suggestedTitle = suggestedTitle.replace(/^\d{4}-\d{2}-\d{2}[-\s]*/, '');

        // Lowercase and clean
        suggestedTitle = suggestedTitle.toLowerCase().trim();

        // Remove invalid filesystem characters
        suggestedTitle = suggestedTitle.replace(/[/\\:*?"<>|]/g, '');

        // Remove parentheses and their contents at the end (e.g., "(source name)")
        suggestedTitle = suggestedTitle.replace(/\s*\([^)]*\)\s*$/, '');

        // Remove periods
        suggestedTitle = suggestedTitle.replace(/\.(?!\s|$)/g, '');
        suggestedTitle = suggestedTitle.replace(/\.$/, '');

        // Clean up multiple spaces
        suggestedTitle = suggestedTitle.replace(/\s+/g, ' ').trim();

        // Reject AI meta-commentary
        const invalidPatterns = [
          /^based on/i,
          /^the transcript/i,
          /^this video/i,
          /^i would/i,
          /^i suggest/i,
          /^here is/i,
          /^the suggested/i,
        ];

        for (const pattern of invalidPatterns) {
          if (pattern.test(suggestedTitle)) {
            this.logger.warn(`Rejected invalid AI title: "${suggestedTitle}"`);
            return null;
          }
        }

        // Length limit
        if (suggestedTitle.length > 200) {
          suggestedTitle = suggestedTitle.substring(0, 200).split(',').slice(0, -1).join(',');
        }

        // Reject if too short
        if (suggestedTitle.length < 10) {
          this.logger.warn(`Rejected too-short AI title: "${suggestedTitle}"`);
          return null;
        }

        return suggestedTitle || null;
      }

      return null;
    } catch (error) {
      // A hard error (not just a rejected title) is a real failure.
      recordFailure(`Title generation failed: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Generate a suggested filename for a webpage from its extracted text.
   * Public entry point used by webpage analysis (no chapters/transcript needed).
   */
  async generateTitleFromWebpageText(
    config: AIProviderConfig,
    pageText: string,
    currentTitle: string,
  ): Promise<string | null> {
    try {
      if (!pageText || pageText.trim().length === 0) {
        return null;
      }

      // Truncate to stay within reasonable context; ~8000 chars ≈ 2k tokens
      const truncated = pageText.substring(0, 8000);

      const prompt = interpolatePrompt(TITLE_FROM_WEBPAGE_PROMPT, {
        currentTitle: currentTitle || 'untitled',
        pageText: truncated,
      });

      const response = await this.aiProviderService.generateText(prompt, config, 'title');

      if (!response || !response.text) {
        return null;
      }

      let suggestedTitle = response.text.trim();

      // Remove quotes
      if (suggestedTitle.startsWith('"') && suggestedTitle.endsWith('"')) {
        suggestedTitle = suggestedTitle.slice(1, -1);
      }

      // Strip only a trailing file extension (e.g. ".mp4"), not mid-title dots
      // like "$3.5 million".
      suggestedTitle = suggestedTitle.replace(/\.[A-Za-z0-9]{1,5}$/, '');

      // Remove leading date prefix
      suggestedTitle = suggestedTitle.replace(/^\d{4}-\d{2}-\d{2}[-\s]*/, '');

      suggestedTitle = suggestedTitle.toLowerCase().trim();
      suggestedTitle = suggestedTitle.replace(/[/\\:*?"<>|]/g, '');
      suggestedTitle = suggestedTitle.replace(/\s*\([^)]*\)\s*$/, '');
      suggestedTitle = suggestedTitle.replace(/\.(?!\s|$)/g, '');
      suggestedTitle = suggestedTitle.replace(/\.$/, '');
      suggestedTitle = suggestedTitle.replace(/\s+/g, ' ').trim();

      const invalidPatterns = [
        /^based on/i,
        /^the page/i,
        /^this page/i,
        /^this article/i,
        /^i would/i,
        /^i suggest/i,
        /^here is/i,
        /^the suggested/i,
      ];
      for (const pattern of invalidPatterns) {
        if (pattern.test(suggestedTitle)) {
          this.logger.warn(`Rejected invalid webpage AI title: "${suggestedTitle}"`);
          return null;
        }
      }

      if (suggestedTitle.length > 200) {
        suggestedTitle = suggestedTitle.substring(0, 200).split(',').slice(0, -1).join(',');
      }

      if (suggestedTitle.length < 10) {
        this.logger.warn(`Rejected too-short webpage AI title: "${suggestedTitle}"`);
        return null;
      }

      return suggestedTitle || null;
    } catch (error) {
      this.logger.warn(`Webpage title generation failed: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Write a section to the output file
   */
  private writeSectionToFile(
    outputFile: string,
    section: AnalyzedSection,
  ): void {
    try {
      let content = '';

      const endTime = section.end_time ? section.end_time : '';
      if (endTime) {
        content = `**${section.start_time} - ${endTime} - ${section.description} [${section.category}]**\n\n`;
      } else {
        content = `**${section.start_time} - ${section.description} [${section.category}]**\n\n`;
      }

      for (const quote of section.quotes || []) {
        content += `${quote.timestamp} - "${quote.text}"\n`;
        if (quote.significance) {
          content += `   → ${quote.significance}\n`;
        }
        content += '\n';
      }

      content += '-'.repeat(80) + '\n\n';
      fs.appendFileSync(outputFile, content, 'utf-8');
    } catch (error) {
      this.logger.error(
        `Error writing to file: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Prepend the video overview section to the analysis file
   */
  private prependSummaryToFile(outputFile: string, summary: string): void {
    try {
      const existingContent = fs.readFileSync(outputFile, 'utf-8');

      const headerEnd = existingContent.indexOf('\n\n');
      if (headerEnd !== -1) {
        const header = existingContent.substring(0, headerEnd + 2);
        const rest = existingContent.substring(headerEnd + 2);

        const newContent =
          header +
          '**VIDEO OVERVIEW**\n\n' +
          summary +
          '\n\n' +
          '-'.repeat(80) +
          '\n\n' +
          rest;

        fs.writeFileSync(outputFile, newContent, 'utf-8');
      } else {
        const newContent =
          '**VIDEO OVERVIEW**\n\n' +
          summary +
          '\n\n' +
          '-'.repeat(80) +
          '\n\n' +
          existingContent;

        fs.writeFileSync(outputFile, newContent, 'utf-8');
      }
    } catch (error) {
      this.logger.warn(
        `Could not prepend summary to file: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Format time for display (HH:MM:SS)
   */
  private formatDisplayTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Parse display time (HH:MM:SS) back to seconds
   */
  private parseDisplayTime(timeStr: string): number {
    const parts = timeStr.split(':').map(Number);
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    return 0;
  }
}
