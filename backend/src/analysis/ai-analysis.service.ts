/**
 * AI Analysis Service - Two-Pass Chapter-Centric Analysis
 *
 * This service implements a two-pass approach to video analysis:
 *   Pass 1: Detect chapter boundaries (chapter-detection.service — embedding
 *           cohesion scoring, then one small LLM call per selected boundary)
 *   Pass 2: Analyze each chapter with full context (title, summary)
 *   Pass 2b: Extract category flags per chapter, as a dedicated call
 *
 * Metadata (description, tags, title) is generated from chapter summaries.
 */
import { Injectable, Logger } from '@nestjs/common';
import { AIProviderService, AIProviderConfig } from './ai-provider.service';
import { OllamaService } from './ollama.service';
import { estimateNumCtx, numCtxMaxForModel, parseProviderModel, AITaskKind } from './model-utils';
import { ChapterDetectionService } from './chapter-detection.service';
import {
  NliRankerService,
  assembleSentences,
  FlagWindow,
  RankedSentence,
  WindowCategory,
} from './nli-ranker.service';
import { findPhraseTimestamp } from './phrase-matcher';
import { safeJsonParse } from './json-utils';
import { ApiKeysService } from '../config/api-keys.service';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildChapterAnalysisPrompt,
  buildFlagExtractionPrompt,
  buildFlagVerificationPrompt,
  normalizeSensitivity,
  interpolatePrompt,
  HOOK_FROM_CHAPTERS_PROMPT,
  BODY_FROM_CHAPTERS_PROMPT,
  REGISTER_RESTATEMENT,
  TAGS_FROM_CHAPTERS_PROMPT,
  TITLE_FROM_CHAPTERS_PROMPT,
  TITLE_FROM_WEBPAGE_PROMPT,
  AnalysisCategory,
} from './prompts/analysis-prompts';
import {
  buildChapterLines,
  buildHashtags,
  composeDescription,
  detectNarratedActor,
  truncateAtWordBoundary,
  HOOK_MAX_CHARS,
} from './description-composer';

// =============================================================================
// INTERFACES
// =============================================================================

export interface Segment {
  start: number;
  end: number;
  text: string;
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
 * EVERY task is routable. The two that read long spans of raw transcript
 * (chapter, flags) are safe to route because the chapter caps are computed as
 * the MOST CONSERVATIVE limits across whichever models those tasks resolve to —
 * see `perTaskLimits` in analyzeTranscript. Sizing to one model while another
 * does the reading is what would silently truncate prompts, so the caps follow
 * the smallest context in play. 'boundary' now reads only a ~90-second window
 * per call (see chapter-detection.service), so no cap constrains it at all.
 *
 * Tasks are executed grouped by model (chaptering, then Pass 2b, then metadata
 * ordered main-model-first), so each routed model loads once rather than being
 * swapped in and out per call.
 */
const ROUTABLE_TASKS = ['boundary', 'chapter', 'flags', 'description', 'tags', 'title'] as const;

/**
 * Small local models that boundary PLACEMENT automatically prefers, best first.
 *
 * Placement is the one stage where a tiny model is not a compromise: it reads a
 * ~90-second window and copies out one sentence. Measured on identical inputs
 * (docs/chapter-pipeline-handoff.md §6), qwen3.5:4b placed 10/10 boundaries at
 * ~1.2s/call against the 27B's ~5s/call, taking Pass 1 from ~60s to ~17s.
 *
 * The floor is REAL and measured — do not extend this list downward. qwen3.5:2b
 * echoes the task back as JSON instead of answering (0/10) and qwen3.5:0.8b
 * quotes text that maps to the wrong places. Below 4b the failure is instruction
 * collapse, which no prompt fixes. Adding a NEW model here is fine once it has
 * been scored against a reference run the same way.
 */
const PREFERRED_PLACEMENT_MODELS = ['qwen3.5:4b'] as const;

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

/**
 * JSON Schema for the flag-extraction answer, handed to Ollama's `format`.
 *
 * WHY: a flag call on qwen3.8:27b measured ~3,400 output tokens for ~300 tokens
 * of actual JSON — roughly 3,100 tokens (~185s of the ~200s call) spent
 * reasoning. Placement showed the fix: constraining the grammar collapsed that
 * stage to ~25 tokens and ~5s, because the schema admits nothing but the answer.
 * Flags are the single most expensive stage in a run, so the same lever applies
 * here. NOTE the structured-output trap this implies — the answer then arrives
 * in Ollama's `thinking` field with `response` empty; ai-provider.service
 * handles that.
 *
 * Shape matches parseFlagExtractionResponse EXACTLY: an object with a `flags`
 * array, each item carrying category / description / quote.
 *
 * `category` is a plain string, NOT an enum of the enabled category names, on
 * purpose: the prompt explicitly allows the model to coin a new lowercase-dashed
 * category when nothing fits, and an enum would silently delete that affordance.
 * The one thing this change is allowed to alter is the decoding grammar.
 */
const FLAG_EXTRACTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    flags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          description: { type: 'string' },
          quote: { type: 'string' },
        },
        required: ['category', 'description', 'quote'],
      },
    },
  },
  required: ['flags'],
};

/**
 * Opt-in for the schema above: BRIEFCASE_FLAGS_CONSTRAINED=1 sends it as
 * Ollama's `format`, which suppresses the model's reasoning along with its
 * prose. Measured A/B on qwen3.8:27b over the same chapter (3 paired runs,
 * scored against a reference flag set): 5.5x faster (168s -> 30s/call) but
 * recall dropped 7.3 -> 5.7 of 11 and false positives rose 0.7 -> 3.0 per run
 * — the extras were reporting-not-asserting quotes, i.e. the assert-vs-debunk
 * judgment the suppressed reasoning was paying for. Flags are the point of
 * this product and a human reviews them, so quality is the default and speed
 * is the explicit trade.
 */
const FLAGS_CONSTRAINED = process.env.BRIEFCASE_FLAGS_CONSTRAINED === '1';

/**
 * JSON Schema for ONE flag-verification verdict: `{"verdict": "flag" | "skip"}`.
 *
 * THE CONSTRAINT INVERSION — read this before "fixing" it to match
 * FLAGS_CONSTRAINED above.
 *
 * FLAGS_CONSTRAINED documents that constraining the OLD flag call hurt: recall
 * 7.3 -> 5.7 of 11 and false positives 0.7 -> 3.0 per run, because the
 * suppressed reasoning was paying for the assert-vs-debunk judgment. That call
 * is open-ended DISCOVERY: read a whole chapter, decide what is in it, produce
 * a variable-length list of quotes and categories. Reasoning is the work there.
 *
 * This call is the opposite shape: the candidate is already chosen, the claim is
 * already stated, and the answer is one of two tokens. It is
 * mechanical-with-a-test, the same class as boundary placement — and the
 * measurement inverts with the shape (final-score.txt, qwen3.8:27b, same 70
 * candidates, same prompt):
 *
 *   constrained    9/10 recall vs the hand audit,  2.90s/call median, 204s total
 *   UNCONSTRAINED  6/10 recall vs the hand audit, 20.30s/call median, 3,091s
 *
 * Unconstrained was WORSE on quality AND ~7x slower: given room to reason about
 * one line, the model talks itself out of real flags and into "misinformation"
 * mislabels. So this stage is constrained by DEFAULT and there is no opt-out —
 * BRIEFCASE_FLAGS_DISCOVERY=1 switches to the whole other pipeline instead.
 */
const FLAG_VERIFICATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['flag', 'skip'] },
  },
  required: ['verdict'],
  additionalProperties: false,
};

/**
 * Force the OLD chapter-discovery flag pass instead of the ranker/verifier
 * pipeline. This is the documented degradation path, kept for two real cases:
 *
 *  - a machine with no NLI worker environment (no venv, no model) — that case
 *    selects itself automatically, this env var is not needed for it;
 *  - `misinformation`, which entailment cannot rank at all (see
 *    MISINFORMATION_EXCLUSION in nli-ranker.service.ts). A user whose flagging
 *    is mostly about factual claims wants the LLM reading the transcript.
 */
const FLAGS_DISCOVERY = process.env.BRIEFCASE_FLAGS_DISCOVERY === '1';

/**
 * Output budget for one verification call, used only to SIZE num_ctx.
 *
 * A verdict is ~10 tokens of JSON and the constrained decode measured 27-30
 * output tokens end to end; 2048 is headroom, not an expectation. It keeps the
 * bucketed num_ctx at its floor so the stage pins one small context for every
 * call instead of paying an Ollama model reload per call.
 */
const VERIFY_OUTPUT_BUDGET_TOKENS = 2048;

/**
 * JSON Schema for tag extraction — the SAME `{people, topics}` shape the parser
 * and every downstream consumer already expect. The schema pins the shape; the
 * prompt and its intent are unchanged.
 */
const TAGS_EXTRACTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    people: { type: 'array', items: { type: 'string' } },
    topics: { type: 'array', items: { type: 'string' } },
  },
  required: ['people', 'topics'],
};

/**
 * `{"hook": string}` — the ≤150-char search snippet (spec §5).
 *
 * Deliberately NO maxLength: measured on qwen3.5 4b/9b, Ollama enforces schema
 * maxLength by TRUNCATING the decode mid-word — the server silently rewrites
 * the search snippet. The 150-char cap is enforced in code (word-boundary
 * truncation after the re-ask path), where the cut is at least controlled.
 */
const HOOK_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { hook: { type: 'string' } },
  required: ['hook'],
};

/** `{"body": string}` — the 150-300 word paragraph (spec §5). */
const BODY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { body: { type: 'string' } },
  required: ['body'],
};

/**
 * Kill switches for the metadata schemas — note the polarity is the OPPOSITE of
 * FLAGS_CONSTRAINED, and deliberately so.
 *
 * Flags are a JUDGMENT task: the measured A/B showed structured output buys 5.5x
 * speed at the cost of recall, so there quality is the default and speed is the
 * explicit opt-in. Tags and description are MECHANICAL — extraction and format
 * transforms over summaries that were already the product of judgment upstream —
 * which is exactly the class where constraining is pure win (it collapses a
 * thinking model's output from thousands of reasoning tokens to the answer; a
 * prior run measured a 9b spending 7,369 tokens writing a filename). So they are
 * constrained by DEFAULT, with an env escape hatch for A/B-ing the trade back.
 */
const TAGS_UNCONSTRAINED = process.env.BRIEFCASE_TAGS_UNCONSTRAINED === '1';
const DESCRIPTION_UNCONSTRAINED = process.env.BRIEFCASE_DESCRIPTION_UNCONSTRAINED === '1';

// Job-level failure accounting. Any analysis step that cannot produce a real
// result — a chapter that exhausts its retries, a description/tags generation
// that fails — is recorded
// as an explicit failure instead of being papered over with fabricated data.
// Once this many steps have failed, the whole job aborts with TOO_MANY_FAILURES
// rather than shipping a mostly-empty analysis that looks successful.
const MAX_FAILURES = 10;

// =============================================================================
// JSON EXTRACTION AND VALIDATION HELPERS
// =============================================================================

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

// Model size limits - conservative estimates based on typical context windows
// These ensure a chapter fits comfortably with room for prompts and output
interface ModelLimits {
  maxChapterChars: number;     // Max chars per chapter for analysis
  maxChapterSeconds: number;   // Max chapter duration before splitting
}

/**
 * Compute per-chapter size limits that are guaranteed to FIT the context window
 * the model will actually run with, so the transcript is never silently
 * truncated:
 *  - time granularity (maxChapterSeconds) is tiered by model size (bigger models
 *    reason over longer spans well),
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

  // Time granularity tiers (independent of the char caps above).
  let maxChapterSeconds: number;
  if (paramBillions <= 3) {
    maxChapterSeconds = 180;
  } else if (paramBillions <= 7) {
    maxChapterSeconds = 360;
  } else if (paramBillions <= 14) {
    maxChapterSeconds = 540;
  } else if (paramBillions <= 32) {
    // 900s (15 min), raised from 600. Flag extraction is ~72% of a run and costs
    // a large FIXED thinking overhead per call, so fewer/longer chapters beat
    // more/shorter ones: a 40-min video goes from ~7 flag calls to ~4. Safe
    // against truncation — 900s of speech is ~13.5k chars against a 21.5k cap.
    maxChapterSeconds = 900;
  } else {
    maxChapterSeconds = 720;
  }

  return { maxChapterChars, maxChapterSeconds };
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
    private readonly chapterDetectionService: ChapterDetectionService,
    private readonly nliRanker: NliRankerService,
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

      // Anything outside ROUTABLE_TASKS is not a task this pipeline runs, so an
      // entry for it silently does nothing. Warn loudly instead of ignoring it.
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
   * List the model tags installed on an Ollama endpoint, or null if the endpoint
   * is not reachable. 2-second budget: this runs on the analysis hot path purely
   * to take an optimization, so an unreachable or wedged daemon must cost
   * ~nothing and simply mean "no small model available".
   */
  private async listOllamaTags(endpoint: string): Promise<string[] | null> {
    try {
      const response = await fetch(`${endpoint}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return null;
      const data = await response.json();
      const models = Array.isArray(data?.models) ? data.models : [];
      return models
        .map((m: { name?: unknown }) => (typeof m?.name === 'string' ? m.name : ''))
        .filter((name: string) => !!name);
    } catch {
      return null;
    }
  }

  /**
   * Automatically route boundary PLACEMENT to a small local model when one is
   * installed — no configuration required.
   *
   * Placement is per-boundary quote copying (~10 calls per hour of video) and a
   * 4B does it as accurately as a 27B at a quarter of the time, so the win is
   * free and worth taking by default rather than only for users who happen to
   * have written a `taskModels.boundary` line. Deliberately applies even when
   * the MAIN provider is claude/openai: a cloud user with Ollama installed still
   * gets fast local placement, and placement is the one task where nothing is
   * lost by it (a failed placement degrades to the junction time).
   *
   * Precedence: explicit `taskModels.boundary` > BRIEFCASE_PLACE_MODEL >
   * auto-detection > the job's main model.
   *
   * MUTATES `overrides` so every downstream `resolveTaskConfig(_, 'boundary')`
   * — including the context-limit survey — sees the same answer, and so the
   * /api/tags probe happens exactly ONCE per analysis run. It is deliberately
   * not cached process-wide: models get pulled and removed between runs.
   */
  private async applyAutoPlacementModel(
    overrides: Partial<Record<AITaskKind, string>>,
    ollamaEndpoint?: string,
  ): Promise<void> {
    if (overrides.boundary) {
      this.logger.log(
        `[Placement] boundary -> ${overrides.boundary} (explicit taskModels.boundary override)`,
      );
      return;
    }

    // Env override names a bare Ollama tag and is taken on faith — it exists to
    // test a model that may not be installed yet, so it skips the probe.
    const forced = (process.env.BRIEFCASE_PLACE_MODEL || '').trim();
    if (forced) {
      overrides.boundary = `ollama:${forced}`;
      this.logger.log(
        `[Placement] boundary -> ollama:${forced} (BRIEFCASE_PLACE_MODEL; availability not checked)`,
      );
      return;
    }

    const endpoint = ollamaEndpoint || 'http://localhost:11434';
    const installed = await this.listOllamaTags(endpoint);
    if (!installed) {
      this.logger.log(
        `[Placement] boundary -> main model (Ollama not reachable at ${endpoint}; ` +
        `placement stays on the job's model)`,
      );
      return;
    }

    const match = PREFERRED_PLACEMENT_MODELS.find((preferred) =>
      installed.some(
        (name) =>
          name === preferred ||
          name === `${preferred}:latest` ||
          name.startsWith(`${preferred}-`),
      ),
    );

    if (!match) {
      this.logger.log(
        `[Placement] boundary -> main model (none of ${PREFERRED_PLACEMENT_MODELS.join(', ')} ` +
        `installed on ${endpoint})`,
      );
      return;
    }

    overrides.boundary = `ollama:${match}`;
    this.logger.log(
      `[Placement] boundary -> ollama:${match} (auto-detected on ${endpoint}; ` +
      `small models place boundaries as accurately as large ones, ~4x faster)`,
    );
  }

  /**
   * Main entry point: Analyze transcript using AI
   * Uses two-pass chapter-centric analysis:
   *   Pass 1: Detect chapter boundaries (embedding-scored, then placed)
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

      // Boundary placement takes a small local model automatically when one is
      // installed (one /api/tags probe for the whole run). No-op when the user
      // configured 'boundary' explicitly, or when Ollama is not reachable.
      await this.applyAutoPlacementModel(taskModels, ollamaEndpoint);

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

      // 'boundary' is NOT in this list. Placement reads a fixed ~90-second
      // window it sizes itself (chapter-detection.service pins one num_ctx from
      // its own largest prompt), so no chapter cap constrains it — and now that
      // placement auto-routes to a small local model, including it here would
      // drag the shared char cap down to that model's context for a cloud job
      // whose chapter/flags tasks have a 128K window.
      const rawTranscriptTasks: AITaskKind[] = ['chapter', 'flags'];
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
        maxChapterChars: Math.min(...perTaskLimits.map((x) => x.limits.maxChapterChars)),
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
        `[Model Limits] effective ctx=${contextTokens}: ` +
        `maxChapterChars=${modelLimits.maxChapterChars}, ` +
        `maxChapterSeconds=${modelLimits.maxChapterSeconds}`,
      );

      // =========================================================================
      // PASS 1: Detect chapter boundaries
      // =========================================================================
      sendProgress('analysis', 5, 'Detecting chapter boundaries...');
      // Pass 1 is no longer an LLM reading the transcript for boundaries — that
      // prompt returned a PREFIX of the boundaries (1-3) and stopped, missing
      // e.g. a mid-video ad break entirely. Boundaries are now SCORED from
      // embeddings and only PLACED by the model (see chapter-detection.service).
      const pass1StartTime = Date.now();
      const detection = await this.chapterDetectionService.detectBoundaries({
        segments,
        boundaryConfig: this.resolveTaskConfig(aiConfig, 'boundary', taskModels),
        maxChapterSeconds: modelLimits.maxChapterSeconds,
        videoTitle,
        ollamaEndpoint,
        onTokens: trackTokens,
        // Pass 1 owns the 5%-25% band. Scoring is one early tick (it is seconds
        // of embedding, not minutes of generation); the rest of the band walks
        // with the per-boundary placement calls, so the queue sees steady
        // progress instead of a frozen 5% for the whole pass.
        onProgress: (current, total, label) => {
          const pct = 5 + Math.round((current / Math.max(1, total)) * 20);
          sendProgress('analysis', pct, label);
        },
      });
      const boundaries = detection.boundaries;
      sendProgress('analysis', 25, `Found ${boundaries.length} chapters (${detection.scorer} scoring)`);

      // Calculate total API calls for accurate progress reporting:
      // chapters + one flag-extraction call each + the FOUR metadata calls
      // (tags, description hook, description body, title), plus the
      // boundary-placement calls Pass 1 already made.
      //
      // The narrated-actor re-ask (at most one per viewer-facing field) is NOT
      // counted here, exactly as chapter and flag PARSE retries are not: this
      // number is the expected-work estimate the ETA divides by, and retries are
      // exceptions. Their real cost is still recorded — every attempt, retry
      // included, goes through trackTokens and lands in tokenStats.apiCalls.
      // Omitting the flag pass
      // here is what produced negative ETAs and a "4/4 API calls" counter on a
      // run that actually made seven; omitting Pass 1's calls would understate
      // the same way. The embedding call is NOT counted — it is one batch
      // request measured in seconds, not a generation call, and counting it
      // would poison the ETA's average-call-time.
      const pass1Calls = detection.placeCalls;
      let chapterCallCount = boundaries.length;
      // Flag calls are NO LONGER one per chapter. On the default ranked path
      // there is one call per (window, category) pair, a number nothing
      // knows until the ranker has run — so this starts at the old
      // one-per-chapter estimate and the flag stage corrects it the moment it
      // knows, exactly as the chapter loop corrects chapterCallCount after long
      // chapters are split.
      let flagCallCount = chapterCallCount;
      const recomputeTotalApiCalls = () => {
        totalApiCalls = chapterCallCount + flagCallCount + 4 + pass1Calls;
      };
      recomputeTotalApiCalls();
      completedApiCalls = pass1Calls;
      // ETA averages over every counted call, so the clock starts where the
      // first counted call did — the placement stage, not Pass 2.
      pass2StartTime = pass1Calls > 0 ? pass1StartTime : Date.now();

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
            // Until the flag stage reports its own count, one-per-chapter stays
            // the best available estimate for it.
            if (flagCallCount === chapterCallCount) flagCallCount = total;
            chapterCallCount = total;
            recomputeTotalApiCalls();
          }
          completedApiCalls = pass1Calls + current;
          const progress = calculateProgress();
          sendProgress('analysis', progress, `Analyzing chapter ${current}/${total} (${completedApiCalls}/${totalApiCalls} API calls)...`);
        },
        taskModels,
        (current, total) => {
          if (total !== flagCallCount) {
            flagCallCount = total;
            recomputeTotalApiCalls();
          }
          completedApiCalls = pass1Calls + chapterCallCount + current;
          const progress = calculateProgress();
          sendProgress('analysis', progress, `Finding flagged quotes ${current}/${total} (${completedApiCalls}/${totalApiCalls} API calls)...`);
        },
        // Ranking is one quick tick — seconds of local scoring, not a
        // generation call — so it reports a message at the CURRENT percentage
        // and is deliberately not counted in totalApiCalls (counting it would
        // poison the ETA's average-call-time, same as the embedding call).
        (message) => sendProgress('analysis', calculateProgress(), message),
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

      // TAGS RUNS FIRST, and the order in this array is load-bearing: grouping is
      // stable within a model group, and the description step CONSUMES the tags
      // result (people ground the body, topics feed the hook and the code-built
      // hashtag line). With every task on one model — the default — this array
      // order is the execution order, so tags always lands first. When tags is
      // routed to a different model, grouping may still run description first;
      // that degrades cleanly (the chapter summaries carry the same names) rather
      // than failing, which is why this is an ordering preference and not a
      // dependency the loop enforces.
      //
      // `calls` is what the ETA counter advances by: description is TWO calls
      // now (hook, then body), not one.
      const metadataSteps = (
        [
          { task: 'tags', label: 'Extracting tags', calls: 1 },
          { task: 'description', label: 'Generating description', calls: 2 },
          { task: 'title', label: 'Generating title', calls: 1 },
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
          completedApiCalls += step.calls;
          sendProgress(
            'analysis',
            calculateProgress(),
            `${step.label} (${completedApiCalls}/${totalApiCalls} API calls)...`,
          );
          switch (step.task) {
            case 'description':
              description = await this.generateDescriptionFromChapters(
                step.cfg, chapters, videoTitle, tags, recordFailure, trackTokens,
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
    } finally {
      // The ranker worker is per-analysis: it holds a loaded model and ~1GB of
      // Python, and there is no reason to keep that resident between runs. It
      // also joins the app's graceful-shutdown path (OnApplicationShutdown), so
      // a crash mid-run cannot leave an orphan python behind either.
      this.nliRanker.stop();
    }
  }

  // =============================================================================
  // TWO-PASS CHAPTER ANALYSIS METHODS
  // =============================================================================

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

    // Structured output is an Ollama-only lever (cloud providers ignore
    // overrides entirely) and an explicit speed-over-quality opt-in — see
    // FLAGS_CONSTRAINED for the measured trade. Nothing else about the call
    // changes: same model, same temperature, same think level, same prompt.
    const overrides =
      config.provider === 'ollama' && FLAGS_CONSTRAINED
        ? { format: FLAG_EXTRACTION_SCHEMA }
        : undefined;
    if (config.provider === 'ollama') {
      this.logger.debug(
        `[Pass 2b] Chapter ${chapterNumber} flag call: ${
          overrides ? 'schema-constrained (BRIEFCASE_FLAGS_CONSTRAINED=1)' : 'free-running (default)'
        }`,
      );
    }

    let lastError = '';
    for (let attempt = 0; attempt <= JSON_PARSE_RETRIES; attempt++) {
      try {
        const response = await this.aiProviderService.generateText(prompt, config, 'flags', overrides);
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

  // ===========================================================================
  // PASS 2b (DEFAULT): ranked-then-verified flag extraction
  // ===========================================================================

  /**
   * Read one verdict out of a verification response.
   *
   * The schema-constrained decode makes the JSON reliable, but this stays
   * tolerant on purpose: cloud providers get the same prompt with NO schema (see
   * ai-provider.service — `format` is an Ollama-only lever), so their answer is
   * whatever prose the model chose to wrap the verdict in.
   *
   * Returns null when the text carries no verdict at all; the caller treats that
   * as 'skip' plus a warning, never as a flag. An unreadable answer must not be
   * able to accuse anybody.
   */
  private parseVerificationVerdict(text: string): 'flag' | 'skip' | null {
    if (!text) return null;
    const json = /"verdict"\s*:\s*"(flag|skip)"/i.exec(text);
    if (json) return json[1].toLowerCase() as 'flag' | 'skip';

    const lower = text.trim().toLowerCase();
    const hasFlag = lower.includes('flag');
    const hasSkip = lower.includes('skip');
    if (hasFlag && !hasSkip) return 'flag';
    if (hasSkip && !hasFlag) return 'skip';
    return null;
  }

  /**
   * Turn verified windows into stored sections — ONE section per window.
   *
   * WHY ONE, when a window can have several verified categories. The operator's
   * complaint about the previous shape was over-splitting: four back-to-back
   * single-sentence flags for one moment. Emitting one section per verified
   * category on the same passage is the same complaint in a different costume —
   * three markers stacked on the same 20 seconds of timeline. So the section
   * carries the STRONGEST verified category, and the others are named in the
   * description after the quote as `[also: hate, extremism]`. Nothing is lost:
   * `description` is the field both section lists and the timeline tooltip
   * render, so the extra categories are on screen wherever the flag is.
   *
   * The SPAN is measured, never a fixed window: it runs from the first to the
   * last sentence that fired a VERIFIED category, and the quote is that span
   * read verbatim. Sentences that fired only a category the verifier rejected do
   * not stretch the span, and the surrounding context the model was shown is not
   * part of it — a viewer clicking the flag lands on the words that earned it.
   */
  private buildWindowSections(
    verified: Array<{ window: FlagWindow; categories: WindowCategory[] }>,
    sentences: RankedSentence[],
  ): AnalyzedSection[] {
    const sections: AnalyzedSection[] = [];

    for (const { categories } of verified) {
      if (categories.length === 0) continue;
      // Strongest first: `categories` arrives ordered by the ranker's per-
      // category best score, and the primary is simply the survivor at the top.
      const ranked = [...categories].sort((a, b) => b.score - a.score);
      const primary = ranked[0];
      const also = ranked.slice(1).map((c) => c.category);

      const fired = ranked.flatMap((c) => c.sentenceIndices);
      const from = Math.min(...fired);
      const to = Math.max(...fired);
      const text = sentences.slice(from, to + 1).map((sentence) => sentence.text).join(' ');

      sections.push({
        category: primary.category,
        // The verifier answers with a verdict and nothing else, so there is no
        // generated explanation to show — and inventing one would be a
        // fabrication. The flagged passage IS the finding.
        description: `"${text}"${also.length > 0 ? ` [also: ${also.join(', ')}]` : ''}`,
        start_time: this.formatDisplayTime(sentences[from].start),
        end_time: this.formatDisplayTime(sentences[to].end),
        quotes: [{ timestamp: this.formatDisplayTime(sentences[from].start), text }],
      });
    }

    return sections.sort(
      (a, b) => this.parseDisplayTime(a.start_time) - this.parseDisplayTime(b.start_time),
    );
  }

  /**
   * The DEFAULT flag path: rank every sentence, group the survivors into
   * paragraph-sized windows, then ask one question per (window, category).
   *
   * Returns null when the ranker is unavailable or its scoring call fails, which
   * is the caller's signal to run the old chapter-discovery pass instead. It
   * never throws for a per-call problem: a failed or unreadable
   * verification is that (window, category) degrading to 'skip' with a warning,
   * NOT a recordFailure — one bad HTTP call must not push a run toward
   * TOO_MANY_FAILURES when the pipeline is making hundreds of tiny calls. A
   * TOTAL failure (Ollama down, so every call throws) is reported to the caller
   * the same way chapter analysis reports total failure: the run's own
   * recordFailure, once, for the stage.
   */
  private async runRankedFlagStage(
    flagConfig: AIProviderConfig,
    segments: Segment[],
    categories: AnalysisCategory[],
    sensitivity: number | undefined,
    recordFailure: (what: string) => void,
    onTokens?: (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void,
    onFlagProgress?: (current: number, total: number) => void,
    onFlagStatus?: (message: string) => void,
  ): Promise<AnalyzedSection[] | null> {
    const sentences = assembleSentences(segments);
    if (sentences.length === 0) {
      this.logger.warn('[Pass 2b] No sentences could be assembled from the transcript');
      return [];
    }

    let windows: FlagWindow[];
    try {
      onFlagStatus?.(`Ranking ${sentences.length} sentences for flag candidates...`);
      windows = await this.nliRanker.rankWindows(sentences, categories, sensitivity);
    } catch (error) {
      this.logger.warn(`[Pass 2b] NLI ranking failed: ${(error as Error).message}`);
      return null;
    }

    // One call per (window, category) — a passage where three categories fired
    // costs three questions, not one per (sentence, category) pair.
    const jobs: Array<{ window: FlagWindow; category: WindowCategory; prompt: string }> = [];
    for (const window of windows) {
      const passage = sentences.slice(window.contextFrom, window.contextTo + 1).map((s) => s.text);
      for (const category of window.categories) {
        jobs.push({
          window,
          category,
          prompt: buildFlagVerificationPrompt(
            passage,
            category.category,
            category.proposition,
            sensitivity,
          ),
        });
      }
    }

    const threshold = this.nliRanker.thresholdForSensitivity(sensitivity);
    this.logger.log(
      `[Pass 2b] Ranked ${sentences.length} sentences at threshold ${threshold} ` +
      `(sensitivity ${normalizeSensitivity(sensitivity)}) -> ${windows.length} windows / ${jobs.length} ` +
      `verification calls on ${flagConfig.provider}:${flagConfig.model}`,
    );

    // The call count is only known NOW, so this is where the run's API-call
    // estimate gets corrected — the same mid-run recompute the chapter loop does
    // after long chapters are split.
    onFlagProgress?.(0, jobs.length);
    if (jobs.length === 0) return [];

    // ONE num_ctx for every verification call in the stage, sized from the
    // largest prompt. Ollama fully reloads the model on ANY num_ctx change, and
    // these prompts differ only by the length of their passage — per-call sizing
    // would buy reloads and nothing else.
    const numCtx = estimateNumCtx(
      jobs.reduce((max, job) => Math.max(max, job.prompt.length), 0),
      flagConfig.model,
      VERIFY_OUTPUT_BUDGET_TOKENS,
    );

    const overrides = {
      numCtx,
      temperature: 0,
      // Schema on Ollama only — cloud providers ignore overrides entirely and
      // get the same prompt as prose, parsed by parseVerificationVerdict.
      ...(flagConfig.provider === 'ollama' ? { format: FLAG_VERIFICATION_SCHEMA } : {}),
    };

    // Verified categories per window, keyed by the window object itself: jobs
    // are walked in noisy-OR order, so a window's categories can be answered
    // consecutively but a window is only finished when all of them are.
    const verifiedByWindow = new Map<FlagWindow, WindowCategory[]>();
    let flaggedCalls = 0;
    let skipped = 0;
    let degraded = 0;
    const startedAt = Date.now();

    for (let i = 0; i < jobs.length; i++) {
      const { window, category, prompt } = jobs[i];
      const where = `${this.formatDisplayTime(sentences[window.firedFrom].start)} (${category.category})`;
      try {
        const response = await this.aiProviderService.generateText(prompt, flagConfig, 'flags', overrides);
        onTokens?.(response);

        if (response.doneReason === 'length') {
          degraded++;
          this.logger.warn(
            `[Pass 2b] Verification hit the token ceiling at ${where} — skipping this category`,
          );
        } else {
          const verdict = this.parseVerificationVerdict(response.text);
          if (verdict === null) {
            degraded++;
            this.logger.warn(
              `[Pass 2b] No verdict in the verification answer at ${where} — skipping this category`,
            );
          } else if (verdict === 'flag') {
            flaggedCalls++;
            const list = verifiedByWindow.get(window);
            if (list) list.push(category);
            else verifiedByWindow.set(window, [category]);
          } else {
            skipped++;
          }
        }
      } catch (error) {
        degraded++;
        this.logger.warn(
          `[Pass 2b] Verification call failed at ${where}: ${(error as Error).message} — skipping this category`,
        );
      }
      onFlagProgress?.(i + 1, jobs.length);
    }

    const wallSeconds = (Date.now() - startedAt) / 1000;
    this.logger.log(
      `[Pass 2b] Verified ${jobs.length} (window, category) pairs across ${windows.length} windows in ` +
      `${wallSeconds.toFixed(1)}s (${(wallSeconds / jobs.length).toFixed(2)}s/call): ` +
      `${flaggedCalls} flag, ${skipped} skip, ${degraded} unusable`,
    );

    // Every single call failing is a broken stage, not a quiet result. Report it
    // ONCE — the same shape as a chapter's total failure — so the job's failure
    // accounting sees it without being flooded by hundreds of per-call entries.
    if (degraded === jobs.length) {
      recordFailure(
        `Pass 2b flag verification produced no usable verdicts across all ${jobs.length} calls`,
      );
    }

    // Windows in transcript order, so the sections are built in the order the
    // video plays rather than in noisy-OR order.
    const verified = windows
      .filter((window) => verifiedByWindow.has(window))
      .sort((a, b) => a.contextFrom - b.contextFrom)
      .map((window) => ({ window, categories: verifiedByWindow.get(window) as WindowCategory[] }));

    const sections = this.buildWindowSections(verified, sentences);
    this.logger.log(
      `[Pass 2b] ${flaggedCalls} verified (window, category) verdicts across ${verified.length} windows ` +
      `-> ${sections.length} flag sections`,
    );
    return sections;
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
    onFlagStatus?: (message: string) => void,
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
    const flagConfig = this.resolveTaskConfig(config, 'flags', taskModels);

    // -------------------------------------------------------------------------
    // FLAG PATH SELECTION. The ranked pipeline is the default; chapter discovery
    // is the degradation path, kept intact for machines with no NLI worker
    // environment and for `misinformation`, which entailment cannot rank.
    // Exactly one line of the log says which ran and why.
    // -------------------------------------------------------------------------
    if (pendingFlagWork.length > 0) {
      let unavailableReason: string | null = FLAGS_DISCOVERY
        ? 'BRIEFCASE_FLAGS_DISCOVERY=1'
        : (await this.nliRanker.isAvailable())
          ? null
          : this.nliRanker.unavailable || 'NLI ranker unavailable';

      if (!unavailableReason) {
        const ranked = await this.runRankedFlagStage(
          flagConfig,
          segments,
          categories,
          analysisGranularity,
          recordFailure,
          onTokens,
          onFlagProgress,
          onFlagStatus,
        );
        if (ranked) {
          this.logger.log(
            `[Pass 2b] FLAG PATH: ranked + verified (NLI sentence ranking, merged into passages, one ` +
            `verification call per (window, category)) — ${ranked.length} flag sections`,
          );
          // Returned WITHOUT the 5-second timestamp dedup below. That dedup
          // exists to clean up after a discovery model emitting several flags
          // for one moment; this path already emits exactly one section per
          // window, so there is nothing left for it to find and a real risk it
          // would delete a legitimately distinct neighbouring passage.
          return { chapters, flags: ranked };
        }
        unavailableReason = 'NLI ranking failed mid-run';
      }

      this.logger.log(
        `[Pass 2b] FLAG PATH: chapter discovery (${unavailableReason}) — ` +
        `extracting flags for ${pendingFlagWork.length} chapters on ${flagConfig.provider}:${flagConfig.model} ` +
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
              const foundTime = findPhraseTimestamp(flag.quote, chapterSegments, this.logger);
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
   * Reject an AI refusal masquerading as content. A refusal is a real failure,
   * never a description.
   */
  private isRefusal(text: string): boolean {
    return [/^i apologize/i, /^i'm sorry/i, /^i cannot/i, /^unfortunately/i, /^as an ai/i]
      .some((p) => p.test(text.trim()));
  }

  /**
   * One schema-constrained call for a VIEWER-FACING prose field (hook or body),
   * with the register check and its single re-ask.
   *
   * The re-ask exists because register and specificity fail independently: a
   * perfectly specific, entity-rich line can still be written in narration
   * register, and that is a real SEO/readability loss but not a broken result.
   * So detection is a DECLARED WARNING worth one more attempt — never a blocking
   * check, and never a silent code rewrite of the model's prose.
   *
   * The re-ask prompt is the original prompt plus a restatement of the POSITIVE
   * instruction. Per the spec's prompt-hygiene ruling it does not quote, echo or
   * describe the rejected text: a model shown the bad form sometimes reproduces
   * it, which is exactly the failure we are trying to clear.
   */
  private async generateViewerFacingField(
    field: 'hook' | 'body',
    basePrompt: string,
    schema: Record<string, unknown>,
    config: AIProviderConfig,
    temperature: number | undefined,
    onTokens?: (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void,
  ): Promise<string | null> {
    // Ollama-only lever; cloud providers ignore overrides entirely and simply
    // follow the same prompt's "output JSON only" instruction.
    const overrides =
      config.provider === 'ollama'
        ? {
            ...(DESCRIPTION_UNCONSTRAINED ? {} : { format: schema }),
            ...(temperature !== undefined ? { temperature } : {}),
          }
        : undefined;

    const runOnce = async (prompt: string): Promise<string | null> => {
      const response = await this.aiProviderService.generateText(prompt, config, 'description', overrides);
      onTokens?.(response);
      const raw = (response?.text || '').trim();
      if (!raw) return null;

      // Structured mode makes the parse a formality; the raw-text fallback is
      // for a cloud model that answered in prose despite being asked for JSON.
      const parsed = safeJsonParse<Record<string, unknown>>(raw, this.logger);
      const value = parsed && typeof parsed[field] === 'string' ? (parsed[field] as string) : null;
      if (value && value.trim()) return value.trim();
      if (!raw.startsWith('{') && !raw.startsWith('[')) return raw;
      return null;
    };

    let text = await runOnce(basePrompt);
    if (!text) return null;

    const finding = detectNarratedActor(text);
    if (finding.flagged) {
      // Declared warning: the offending fragment is logged for the operator and
      // goes nowhere near the model.
      this.logger.warn(
        `[Description] ${field}: narrated-actor register detected (${finding.rule}: "${finding.match}") — re-asking once`,
      );
      const retry = await runOnce(`${basePrompt}\n${REGISTER_RESTATEMENT}`);
      // The second result is ACCEPTED regardless. One re-ask, then we ship what
      // the model wrote; nothing here blocks or rewrites.
      if (retry) {
        const secondFinding = detectNarratedActor(retry);
        if (secondFinding.flagged) {
          this.logger.warn(
            `[Description] ${field}: still narrated after one re-ask (${secondFinding.rule}) — accepting as written`,
          );
        }
        text = retry;
      }
    }

    if (this.isRefusal(text)) return null;
    return text;
  }

  /**
   * Build the YouTube description: two model calls (hook, body) and a
   * code-composed template. Implements docs/youtube-metadata-spec.md §2-§3.
   *
   * The model writes prose and nothing else. The chapters block, the hashtag
   * line, the ordering and the character caps are all code, because they are the
   * parts with exact right answers — and because per §3 exactly one component
   * may own each element, so the model is never allowed to emit a hashtag line
   * that would then have to be reconciled with the one code builds.
   *
   * `tags` comes from the tags step, which runs first: its `people` list grounds
   * the body and its `topics` feed the hook and the hashtags. A null `tags`
   * (tags failed, or ran after this on a different routed model) degrades
   * cleanly — the chapter summaries already carry the names.
   */
  private async generateDescriptionFromChapters(
    config: AIProviderConfig,
    chapters: Chapter[],
    videoTitle: string,
    tags: Tags | null,
    recordFailure: (what: string) => void,
    onTokens?: (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void,
  ): Promise<string | null> {
    // Only describe chapters that actually succeeded.
    const validChapters = (chapters || []).filter((ch) => !ch.failed);
    if (validChapters.length === 0) {
      recordFailure('Description generation: no successfully-analyzed chapters to summarize');
      return null;
    }

    if (config.provider === 'ollama') {
      this.logger.debug(
        `[Description] hook + body calls: ${
          DESCRIPTION_UNCONSTRAINED
            ? 'free-running (BRIEFCASE_DESCRIPTION_UNCONSTRAINED=1)'
            : 'schema-constrained (default)'
        }`,
      );
    }

    try {
      const people = tags?.people?.length ? tags.people.join(', ') : 'none identified';
      const topics = tags?.topics?.length ? tags.topics.join(', ') : 'none identified';

      // ---- Call 1: the hook. Chapter TITLES only — the hook is one sentence and
      // the summaries would bury the searchable phrase in detail.
      const hookPrompt = interpolatePrompt(HOOK_FROM_CHAPTERS_PROMPT, {
        videoTitle: videoTitle || 'Untitled',
        chapterTitles: validChapters.map((ch) => `- ${ch.title}`).join('\n').substring(0, 2000),
        topics,
      });
      // Hook keeps the 'description' task temperature (0.4) — it needs a little
      // life, which is exactly what that default was chosen for.
      let hook = await this.generateViewerFacingField('hook', hookPrompt, HOOK_SCHEMA, config, undefined, onTokens);

      if (hook && hook.length > HOOK_MAX_CHARS) {
        // The ONLY length enforcement — the schema deliberately has no maxLength
        // (see HOOK_SCHEMA: Ollama enforces it by truncating mid-word). A hard
        // display limit is never left to a model or a serializer: the snippet is
        // truncated by YouTube either way, so we choose the cut point.
        this.logger.warn(
          `[Description] hook came back at ${hook.length} chars (cap ${HOOK_MAX_CHARS}) — trimming at a word boundary`,
        );
        hook = truncateAtWordBoundary(hook, HOOK_MAX_CHARS);
      }

      // ---- Call 2: the body. ALL chapter summaries. They narrate internally and
      // that is correct for internal data; the prompt's register instruction is
      // what keeps that register out of the published paragraph.
      const bodyPrompt = interpolatePrompt(BODY_FROM_CHAPTERS_PROMPT, {
        videoTitle: videoTitle || 'Untitled',
        people,
        chapterSummaries: validChapters
          .map((ch) => `${ch.title}${ch.summary ? `: ${ch.summary}` : ''}`)
          .join('\n')
          .substring(0, 6000),
      });
      const body = await this.generateViewerFacingField('body', bodyPrompt, BODY_SCHEMA, config, 0.2, onTokens);

      if (!hook && !body) {
        recordFailure('Description generation: neither the hook nor the body call produced text');
        return null;
      }
      if (!hook) recordFailure('Description generation: hook call produced no usable text');
      if (!body) recordFailure('Description generation: body call produced no usable text');

      // ---- Composition: pure code from here down.
      const description = composeDescription({
        hook: hook || '',
        chapterLines: buildChapterLines(validChapters),
        body: body || '',
        hashtags: buildHashtags(tags?.topics || [], tags?.people || [], videoTitle || ''),
      });

      if (!description.trim()) {
        recordFailure('Description generation produced an empty composition');
        return null;
      }
      return description;
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

      // Schema-constrained by DEFAULT (Ollama only). This is mechanical
      // extraction from summaries — the judgment already happened upstream in
      // chapter summarization — which is precisely the class where structured
      // output is pure win: it pins the exact `{people, topics}` shape the parser
      // below expects AND collapses a thinking model's output from thousands of
      // reasoning tokens to the answer itself. The prompt, its intent and the
      // output shape are UNCHANGED; only the decoding grammar is.
      // BRIEFCASE_TAGS_UNCONSTRAINED=1 restores free-running decoding.
      const overrides =
        config.provider === 'ollama' && !TAGS_UNCONSTRAINED
          ? { format: TAGS_EXTRACTION_SCHEMA }
          : undefined;

      const response = await this.aiProviderService.generateText(prompt, config, 'tags', overrides);
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
