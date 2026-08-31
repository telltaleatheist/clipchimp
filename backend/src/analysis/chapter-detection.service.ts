/**
 * Chapter boundary detection — Pass 1 of the analysis pipeline.
 *
 * REPLACES the old single-shot prompt ("list every place the subject changes in
 * this 15-minute chunk"). That prompt is a documented failure mode: models
 * return a PREFIX of the boundaries — typically 1-3 — and stop, no matter how
 * much reasoning they are given. On a 63-minute test video it missed the ad
 * break at 27:00 entirely, and the downstream force-split then manufactured
 * chapters at arbitrary times so the miss looked like a result.
 *
 * The replacement asks the model only questions it is good at, and computes
 * everything else:
 *
 *   1. STRETCH   (code)       cut the transcript into 45s stretches.
 *   2. SCORE     (embeddings) ONE batched /api/embed call, then compare the mean
 *                             vector of the 2 stretches before each junction
 *                             against the 2 after it. A topic change is a VALLEY
 *                             in that similarity curve; depth is measured against
 *                             the nearest higher peak on each side.
 *   3. SELECT    (code)       take the deepest valleys, strongest first, keeping
 *                             a minimum gap. Zero model calls, so nothing here
 *                             can truncate, hallucinate or return a prefix.
 *   4. PLACE     (LLM)        one small call per selected junction: read the ~90s
 *                             around it and quote the sentence the new subject
 *                             starts on. The model NEVER emits a timestamp — it
 *                             quotes, and findPhraseTimestamp measures where that
 *                             quote lands. An invented timestamp is a guess; a
 *                             mapped quote is a measurement.
 *   5. CONSOLIDATE (code)     merge adjacent chapters whose centroids are still
 *                             near-identical, bounded by maxChapterSeconds.
 *
 * Validated on the same 63-minute video the old path failed: 85 stretches
 * embedded in 2.1s, and the top-ranked junctions included 27:02 ("we're going to
 * take a break") and 29:16 ("Welcome back") — the exact ad break that was missed.
 *
 * NOTHING here hard-requires Ollama. If the embed call fails (no Ollama, model
 * not pulled, remote endpoint down) the scorer falls back to lexical cosine over
 * the same stretches and the remaining stages are identical; placement runs on
 * whatever provider `taskModels` routes 'boundary' to, Ollama or not.
 */
import { Injectable, Logger } from '@nestjs/common';
import { AIProviderService, AIProviderConfig } from './ai-provider.service';
import { estimateNumCtx } from './model-utils';
import { findPhraseTimestamp, TranscriptSegment } from './phrase-matcher';
import { safeJsonParse } from './json-utils';
import { ensureNotCancelled, isCancellation } from './cancellation';
import { buildBoundaryPlacementPrompt } from './prompts/analysis-prompts';
import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Stretch length. 45s is short enough that a boundary is located to within one
 * stretch (the placement call then resolves it to the sentence) and long enough
 * that a stretch carries a topic rather than a sentence fragment.
 */
const STRETCH_SECONDS = 45;

/**
 * Stretches per side in the block comparison. Comparing single stretches scores
 * every rhetorical pause as a topic change; averaging two a side (~90s) measures
 * the subject rather than the sentence.
 */
const BLOCK = 2;

/** Embedding model. Small, fast, and already pulled on this machine. */
const DEFAULT_EMBED_MODEL = 'nomic-embed-text';

/**
 * The embed call is ONE batched request that completed in 2.1s for 85 stretches,
 * so a minute is a generous ceiling. It is aborted rather than left hanging: a
 * wedged embed must degrade to the lexical scorer, not stall the whole job.
 */
const EMBED_TIMEOUT_MS = 60000;

/**
 * Ollama is a SHARED daemon (BookForge uses the same instance), so this keeps
 * the embedding model resident for the run without ever unloading anything else.
 */
const EMBED_KEEP_ALIVE = '10m';

/**
 * Adjacent chapters whose centroid vectors are this similar are the same
 * subject, and the junction between them was the least-bad valley rather than a
 * real change. 0.80 on nomic-embed-text cosine.
 */
const CONSOLIDATE_SIMILARITY = 0.8;

/**
 * Output budget used to size num_ctx for placement calls. A placement answer is
 * one sentence of JSON, but a thinking model spends its budget reasoning first
 * (~1,900+ tokens is normal), and num_predict has to share the context window
 * with the prompt — so this matches what ai-provider requests when thinking is
 * on rather than the size of the answer.
 */
const PLACE_OUTPUT_BUDGET_TOKENS = 8192;

// =============================================================================
// TYPES
// =============================================================================

/** One 45-second span of transcript. */
export interface Stretch {
  start: number;
  end: number;
  text: string;
}

/** A candidate boundary: the gap between stretch `index` and `index + 1`. */
export interface Junction {
  index: number;
  /** Start of the stretch AFTER the junction — the candidate chapter start. */
  time: number;
  /** Block cosine similarity across the junction (low = subject changed). */
  sim: number;
  /** Valley depth against the nearest higher peak on each side. */
  depth: number;
}

export interface ChapterDetectionOptions {
  segments: TranscriptSegment[];
  /** Provider config for the 'boundary' task (already routed via taskModels). */
  boundaryConfig: AIProviderConfig;
  /** Cap from getModelLimits — consolidation must never exceed it. */
  maxChapterSeconds: number;
  videoTitle?: string;
  ollamaEndpoint?: string;
  onTokens?: (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void;
  /** Called with (current, total, message) so the caller can drive its own band. */
  onProgress?: (current: number, total: number, label: string) => void;
  /**
   * Cancellation for the whole run. Pass 1 is a LOOP of placement calls, so
   * aborting the open call is not enough — the loop checks this before each
   * iteration and throws AnalysisCancelledError rather than starting call N+1.
   */
  signal?: AbortSignal;
}

export interface ChapterDetectionResult {
  /** Chapter start times in seconds, ascending, always beginning at 0. */
  boundaries: number[];
  /** Which scorer produced them — embeddings, or the lexical fallback. */
  scorer: 'embedding' | 'lexical';
  /** Generation calls made (the placement calls), for API-call accounting. */
  placeCalls: number;
  /** Boundaries that kept their raw 45s junction time because placement failed. */
  unplacedCount: number;
}

// =============================================================================
// PURE ALGORITHM (no model, no I/O — exported so it can be tested standalone)
// =============================================================================

/**
 * Cut segments into fixed 45-second stretches.
 *
 * Stretch starts snap to the segment that opens them rather than to the grid, so
 * a stretch always begins on a real spoken word — the times fed forward as
 * candidate boundaries are times something was actually said.
 */
export function buildStretches(segments: TranscriptSegment[]): Stretch[] {
  const open: Array<{ start: number; end: number; windowEnd: number; texts: string[] }> = [];
  let cur: (typeof open)[number] | null = null;

  for (const seg of segments) {
    if (!cur || seg.start >= cur.windowEnd) {
      const windowStart = Math.floor(seg.start / STRETCH_SECONDS) * STRETCH_SECONDS;
      cur = { start: seg.start, end: seg.end, windowEnd: windowStart + STRETCH_SECONDS, texts: [] };
      open.push(cur);
    }
    cur.texts.push(seg.text.trim());
    cur.end = seg.end;
  }

  return open.map((s) => ({ start: s.start, end: s.end, text: s.texts.join(' ') }));
}

const dot = (a: number[], b: number[]): number => a.reduce((sum, v, i) => sum + v * b[i], 0);

/** Cosine similarity. Returns 0 for a zero vector rather than NaN. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const denom = Math.sqrt(dot(a, a)) * Math.sqrt(dot(b, b));
  return denom === 0 ? 0 : dot(a, b) / denom;
}

/** Element-wise mean of vectors (all assumed the same length). */
export function meanVector(vectors: number[][]): number[] {
  const out = new Array<number>(vectors[0].length).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < v.length; i++) out[i] += v[i];
  }
  return out.map((x) => x / vectors.length);
}

/**
 * Score every junction by how deep a valley it is in the cohesion curve.
 *
 * Raw similarity is not usable on its own: a talky passage sits at a uniformly
 * low similarity without any topic change in it. Depth compares each dip against
 * the nearest HIGHER points on both sides, so what is measured is "how much of a
 * drop is this, locally" rather than an absolute number.
 */
export function scoreJunctions(stretches: Stretch[], vectors: number[][]): Junction[] {
  const sims: number[] = [];
  for (let i = 0; i + 1 < stretches.length; i++) {
    const left = vectors.slice(Math.max(0, i - BLOCK + 1), i + 1);
    const right = vectors.slice(i + 1, i + 1 + BLOCK);
    sims.push(cosineSimilarity(meanVector(left), meanVector(right)));
  }

  const junctions: Junction[] = [];
  for (let i = 0; i < sims.length; i++) {
    // Walk outward while the curve keeps falling; stop at the first higher point.
    let leftPeak = sims[i];
    for (let j = i - 1; j >= 0 && sims[j] >= leftPeak; j--) leftPeak = sims[j];
    let rightPeak = sims[i];
    for (let j = i + 1; j < sims.length && sims[j] >= rightPeak; j++) rightPeak = sims[j];

    junctions.push({
      index: i,
      time: stretches[i + 1].start,
      sim: sims[i],
      depth: leftPeak - sims[i] + (rightPeak - sims[i]),
    });
  }

  return junctions;
}

/**
 * Target chapter length by video duration. A 5-minute video wants chapters
 * around 2 minutes; an hour-long one wants 6. Ported unchanged from the
 * validated implementation.
 */
export function targetSecondsFor(durationSeconds: number): number {
  if (durationSeconds < 600) return 132;
  if (durationSeconds < 1800) return 210;
  if (durationSeconds < 3600) return 336;
  return 360;
}

/**
 * Choose boundaries: deepest valley first, each at least `minGap` from every
 * boundary already taken, until `wanted` are held.
 *
 * Greedy-by-strength (rather than left-to-right) is what makes this robust: the
 * strongest evidence in the video is spent first, so a run of mediocre junctions
 * early on can never crowd out the real change later. Being pure code, it also
 * cannot return a prefix and stop — which is exactly the failure that motivated
 * the rewrite.
 */
export function selectJunctions(junctions: Junction[], durationSeconds: number): Junction[] {
  const target = targetSecondsFor(durationSeconds);
  const wanted = Math.max(3, Math.round(durationSeconds / target)) - 1;
  const minGap = 0.6 * target;

  const ranked = [...junctions].sort((a, b) => b.depth - a.depth);
  const chosen: Junction[] = [];
  for (const j of ranked) {
    if (chosen.length >= wanted) break;
    if (chosen.every((c) => Math.abs(c.time - j.time) >= minGap)) chosen.push(j);
  }

  chosen.sort((a, b) => a.time - b.time);
  return chosen;
}

/**
 * Lexical fallback vectors: L2-normalized TF-IDF over the stretches themselves.
 *
 * Used when the embed call fails. It is a genuinely weaker signal — it sees
 * shared WORDS, not shared meaning, so a subject change phrased in synonyms
 * scores as continuity — but it is the same shape of number, so score/select/
 * consolidate run unchanged and the pipeline still produces chapters without
 * Ollama. Which scorer ran is always logged.
 */
export function lexicalVectors(stretches: Stretch[]): number[][] {
  const tokenize = (text: string): string[] =>
    text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);

  const docs = stretches.map((s) => tokenize(s.text));
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc)) df.set(term, (df.get(term) || 0) + 1);
  }

  const vocab = [...df.keys()];
  const index = new Map(vocab.map((t, i) => [t, i]));
  const n = docs.length;

  return docs.map((doc) => {
    const vec = new Array<number>(vocab.length).fill(0);
    for (const term of doc) vec[index.get(term)!] += 1;
    for (let i = 0; i < vec.length; i++) {
      if (vec[i] === 0) continue;
      vec[i] = (vec[i] / doc.length) * Math.log(n / (df.get(vocab[i])! + 1));
    }
    return vec;
  });
}

/** Format seconds as HH:MM:SS (project-wide convention). */
function formatDisplayTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// =============================================================================
// SERVICE
// =============================================================================

@Injectable()
export class ChapterDetectionService {
  private readonly logger = new Logger(ChapterDetectionService.name);

  constructor(private readonly aiProviderService: AIProviderService) {}

  /**
   * Detect chapter boundaries. Always returns at least [0]; never throws for a
   * transcript it cannot chapter, because a video with one subject is a real
   * answer, not a failure.
   *
   * A failed PLACEMENT call is likewise not a job failure and is deliberately
   * NOT reported to the caller's failure accounting: the junction time is still
   * a boundary, just at 45s resolution instead of sentence resolution. Only the
   * precision degrades, and the validated run showed most junctions already land
   * on the right sentence.
   */
  async detectBoundaries(options: ChapterDetectionOptions): Promise<ChapterDetectionResult> {
    const { segments, maxChapterSeconds, onProgress } = options;

    if (!segments || segments.length === 0) {
      this.logger.warn('[Pass 1] No segments available for boundary detection');
      return { boundaries: [0], scorer: 'lexical', placeCalls: 0, unplacedCount: 0 };
    }

    const durationSeconds = segments[segments.length - 1].end;
    const stretches = buildStretches(segments);

    // Two stretches per side is the smallest block the scorer can compare, so
    // below ~4 stretches (3 minutes) there is nothing to measure.
    if (stretches.length < 4) {
      this.logger.log(
        `[Pass 1] ${formatDisplayTime(durationSeconds)} of transcript is ${stretches.length} stretches — ` +
        `too short to score, treating it as one chapter`,
      );
      onProgress?.(1, 1, 'Detecting chapter boundaries...');
      return { boundaries: [0], scorer: 'lexical', placeCalls: 0, unplacedCount: 0 };
    }

    // ---- stages 1-2: stretch and score --------------------------------------
    const scoreStart = Date.now();
    let vectors = await this.embedStretches(stretches, options.ollamaEndpoint, options.signal);
    const scorer: 'embedding' | 'lexical' = vectors ? 'embedding' : 'lexical';
    if (!vectors) vectors = lexicalVectors(stretches);

    const junctions = scoreJunctions(stretches, vectors);
    const chosen = selectJunctions(junctions, durationSeconds);
    this.logger.log(
      `[Pass 1] ${scorer} scorer: ${stretches.length} stretches, ${junctions.length} junctions, ` +
      `${chosen.length} selected in ${((Date.now() - scoreStart) / 1000).toFixed(1)}s ` +
      `(duration ${formatDisplayTime(durationSeconds)}, target ${targetSecondsFor(durationSeconds)}s/chapter)`,
    );
    for (const c of chosen) {
      this.logger.debug(
        `[Pass 1] candidate ${formatDisplayTime(c.time)} depth=${c.depth.toFixed(3)} sim=${c.sim.toFixed(3)}`,
      );
    }

    // Scoring is one early tick — it is seconds of work against minutes of
    // placement calls, so giving it a proportional share of the band would
    // freeze the progress bar exactly where the old pass did.
    const totalTicks = chosen.length + 1;
    onProgress?.(1, totalTicks, 'Detecting chapter boundaries (scored)...');

    // ---- stage 4: place ------------------------------------------------------
    const placement = await this.placeBoundaries(chosen, stretches, segments, options, totalTicks);

    // ---- stage 5: consolidate ------------------------------------------------
    const boundaries = this.consolidate(
      [0, ...placement.times],
      stretches,
      vectors,
      durationSeconds,
      maxChapterSeconds,
    );

    this.logger.log(
      `[Pass 1] ${boundaries.length} chapters: ${boundaries.map((b) => formatDisplayTime(b)).join(', ')}`,
    );

    return {
      boundaries,
      scorer,
      placeCalls: placement.calls,
      unplacedCount: placement.unplaced,
    };
  }

  // ---------------------------------------------------------------- stage 2

  /**
   * Embed every stretch in ONE batched /api/embed call.
   *
   * Returns null (rather than throwing) on any failure, which is what selects
   * the lexical scorer. Embeddings are an optimization of QUALITY, not a
   * dependency: a machine with no Ollama still gets chapters.
   */
  private async embedStretches(
    stretches: Stretch[],
    ollamaEndpoint?: string,
    signal?: AbortSignal,
  ): Promise<number[][] | null> {
    const endpoint = ollamaEndpoint || 'http://localhost:11434';
    const model = this.resolveEmbeddingModel();

    // This is not a generation call — it is a single sub-second-per-item batch —
    // so it does not go through AIProviderService (which owns generation retry,
    // think negotiation and num_ctx sizing, none of which apply). It does own its
    // abort, so a wedged Ollama cannot hang the pass.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
    // A cancelled job must not sit out the 60s embed timeout before unwinding.
    const onCancel = () => controller.abort();
    signal?.addEventListener('abort', onCancel, { once: true });
    const started = Date.now();

    try {
      const response = await fetch(`${endpoint}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          input: stretches.map((s) => s.text),
          keep_alive: EMBED_KEEP_ALIVE,
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama /api/embed returned HTTP ${response.status}`);
      }

      const data = (await response.json()) as { embeddings?: unknown };
      const embeddings = data.embeddings;
      if (
        !Array.isArray(embeddings) ||
        embeddings.length !== stretches.length ||
        !embeddings.every((v) => Array.isArray(v) && v.length > 0)
      ) {
        throw new Error(
          `Ollama /api/embed returned ${Array.isArray(embeddings) ? embeddings.length : 'no'} ` +
          `usable vectors for ${stretches.length} stretches`,
        );
      }

      this.logger.log(
        `[Pass 1] Embedded ${embeddings.length} stretches with ${model} in ` +
        `${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
      return embeddings as number[][];
    } catch (error) {
      // Cancelling is not "embeddings unavailable" — degrading to the lexical
      // scorer here would carry a cancelled run on into Pass 1 placement.
      ensureNotCancelled(signal, 'the embedding scorer');
      this.logger.warn(
        `[Pass 1] Embedding scorer unavailable (${(error as Error).message}) — ` +
        `falling back to the LEXICAL scorer. Boundaries will be weaker: it matches ` +
        `words, not meaning. Pull '${model}' or set embeddingModel in app-config.json.`,
      );
      return null;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onCancel);
    }
  }

  /**
   * Embedding model, in precedence order: BRIEFCASE_EMBED_MODEL, then
   * `embeddingModel` in app-config.json, then the default. Read from the same
   * config file as `taskModels` (see loadTaskModelOverrides), and unreadable
   * config falls through to the default rather than failing the pass.
   */
  private resolveEmbeddingModel(): string {
    const fromEnv = process.env.BRIEFCASE_EMBED_MODEL?.trim();
    if (fromEnv) return fromEnv;

    try {
      const userDataPath =
        process.env.APPDATA ||
        (process.platform === 'darwin'
          ? path.join(process.env.HOME || '', 'Library', 'Application Support')
          : path.join(process.env.HOME || '', '.config'));
      const configPath = path.join(userDataPath, 'briefcase', 'app-config.json');
      if (fs.existsSync(configPath)) {
        const configured = JSON.parse(fs.readFileSync(configPath, 'utf8'))?.embeddingModel;
        if (typeof configured === 'string' && configured.trim()) return configured.trim();
      }
    } catch (error) {
      this.logger.warn(
        `[Pass 1] Ignoring unreadable embeddingModel config: ${(error as Error).message}`,
      );
    }

    return DEFAULT_EMBED_MODEL;
  }

  // ---------------------------------------------------------------- stage 4

  /**
   * Resolve each selected junction to a sentence, one small LLM call each.
   *
   * Every call asks ONE local question about ~90 seconds of text — the two
   * stretches either side of the junction — and never sees the rest of the
   * video. That is the whole point: there is no list to truncate and no global
   * judgment to get wrong, so the "returns a prefix and stops" failure has no
   * way to occur.
   *
   * A call that fails, refuses to parse, hits the token ceiling, or quotes
   * something that cannot be found keeps the raw junction time. That floor is
   * 45s-accurate, which is why placement failures are degradations rather than
   * errors.
   */
  private async placeBoundaries(
    chosen: Junction[],
    stretches: Stretch[],
    segments: TranscriptSegment[],
    options: ChapterDetectionOptions,
    totalTicks: number,
  ): Promise<{ times: number[]; calls: number; unplaced: number }> {
    const { boundaryConfig, videoTitle, onTokens, onProgress, signal } = options;
    const times: number[] = [];
    let calls = 0;
    let unplaced = 0;

    // ONE num_ctx for every placement call in the run. Ollama fully reloads the
    // model on ANY num_ctx change, so per-call sizing over near-identical
    // prompts would pay for reloads that buy nothing; sizing from the LARGEST
    // window means no call is ever clamped.
    const windows = chosen.map((j) => `${stretches[j.index].text} ${stretches[j.index + 1].text}`);
    const largestPrompt = windows.reduce(
      (max, w) => Math.max(max, buildBoundaryPlacementPrompt(w, videoTitle).length),
      0,
    );
    const numCtx = estimateNumCtx(largestPrompt, boundaryConfig.model, PLACE_OUTPUT_BUDGET_TOKENS);

    for (let i = 0; i < chosen.length; i++) {
      // Refuse to start the next placement call on a cancelled run. Without
      // this the loop would abort call i and immediately issue call i+1.
      ensureNotCancelled(signal, `boundary placement ${i + 1}/${chosen.length}`);

      const junction = chosen[i];
      const before = stretches[junction.index];
      const after = stretches[junction.index + 1];
      const previous = times.length > 0 ? times[times.length - 1] : 0;
      let placed: number | null = null;

      try {
        calls++;
        const response = await this.aiProviderService.generateText(
          buildBoundaryPlacementPrompt(windows[i], videoTitle),
          boundaryConfig,
          'boundary',
          // format:'json' constrains the answer to the object we asked for; the
          // fixed num_ctx keeps the runner loaded across the whole stage.
          { numCtx, format: 'json', signal },
        );
        onTokens?.(response);

        // Hitting the token ceiling means the answer was CUT OFF, so whatever
        // came back is a fragment of a quote. Treat it as a failed call rather
        // than mapping half a sentence to a time.
        if (response.doneReason === 'length') {
          throw new Error('response hit the num_predict ceiling (done_reason=length)');
        }

        const parsed = safeJsonParse<{ quote?: unknown }>(response.text, this.logger);
        const quote = typeof parsed?.quote === 'string' ? parsed.quote.trim() : '';
        if (!quote) throw new Error('response contained no "quote" string');

        // Search ONLY the window the model was shown. A quote matched against
        // the whole transcript could land minutes away on a repeated phrase.
        const windowSegments = segments.filter((s) => s.start >= before.start && s.start < after.end);
        const mapped = findPhraseTimestamp(quote, windowSegments, this.logger);

        if (mapped === null) {
          throw new Error(`quote not found in the window: "${quote.substring(0, 60)}"`);
        }
        // Boundaries must advance. An out-of-order placement means the quote
        // matched the wrong sentence, so the junction time is the safer answer.
        if (mapped <= previous) {
          throw new Error(
            `placement ${formatDisplayTime(mapped)} does not follow ${formatDisplayTime(previous)}`,
          );
        }
        placed = mapped;
        this.logger.debug(
          `[Pass 1] Placed ${formatDisplayTime(junction.time)} -> ${formatDisplayTime(mapped)}: ` +
          `"${quote.substring(0, 60)}"`,
        );
      } catch (error) {
        // A cancelled call is NOT a placement degradation. This catch exists to
        // keep a bad quote from failing the run; swallowing a cancellation here
        // would let the loop continue straight into the next call.
        if (isCancellation(error)) throw error;
        this.logger.warn(
          `[Pass 1] Placement failed at ${formatDisplayTime(junction.time)} ` +
          `(${(error as Error).message}) — keeping the junction time (45s resolution)`,
        );
      }

      if (placed === null && junction.time > previous) {
        placed = junction.time;
        unplaced++;
      }
      if (placed !== null) times.push(placed);

      onProgress?.(
        i + 2,
        totalTicks,
        `Placing chapter boundaries (${i + 1}/${chosen.length})...`,
      );
    }

    return { times, calls, unplaced };
  }

  // ---------------------------------------------------------------- stage 5

  /**
   * Merge adjacent chapters that turned out to be the same subject.
   *
   * Selection takes a fixed count of the deepest valleys, so on a video that
   * genuinely has fewer subjects than that it necessarily accepts some shallow
   * ones. Comparing the CENTROID of each finished chapter (not the junction it
   * was cut at) is what catches those: two chapters about the same thing have
   * near-identical centroids however plausible the dip between them looked.
   *
   * The maxChapterSeconds cap always wins — a merge that would produce a chapter
   * longer than the cap is refused, because Pass 2's force-split would only cut
   * it back apart at an arbitrary time.
   */
  private consolidate(
    boundaries: number[],
    stretches: Stretch[],
    vectors: number[][],
    durationSeconds: number,
    maxChapterSeconds: number,
  ): number[] {
    if (boundaries.length < 2) return boundaries;

    // Centroid of the stretches inside each chapter. A chapter shorter than one
    // stretch gets no centroid and is never merged (null propagates).
    const centroidFor = (start: number, end: number): number[] | null => {
      const members = vectors.filter((_, i) => stretches[i].start >= start && stretches[i].start < end);
      return members.length > 0 ? meanVector(members) : null;
    };

    const result = [...boundaries];
    let i = 0;
    while (i + 1 < result.length) {
      const start = result[i];
      const middle = result[i + 1];
      const end = i + 2 < result.length ? result[i + 2] : durationSeconds;

      if (end - start > maxChapterSeconds) {
        i++;
        continue;
      }

      const a = centroidFor(start, middle);
      const b = centroidFor(middle, end);
      const similarity = a && b ? cosineSimilarity(a, b) : 0;

      if (similarity > CONSOLIDATE_SIMILARITY) {
        this.logger.log(
          `[Pass 1] Merging chapter at ${formatDisplayTime(middle)} into ${formatDisplayTime(start)} ` +
          `(centroid similarity ${similarity.toFixed(3)} > ${CONSOLIDATE_SIMILARITY})`,
        );
        result.splice(i + 1, 1);
        continue; // re-test the same chapter against its new neighbour
      }
      i++;
    }

    return result;
  }
}
