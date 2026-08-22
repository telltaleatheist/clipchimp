/**
 * NLI sentence ranker — stage 1 of the measured flag pipeline.
 *
 * WHAT THIS REPLACES, AND WHY
 *
 * The old flag path asked an LLM to READ a chapter and DISCOVER every quote in
 * it that matches a category. That is open-ended discovery, and it fails the way
 * open-ended discovery always fails: the model returns the two or three most
 * obvious hits and stops, and the timestamps come from matching the quote's
 * words back to the transcript (a quote the model reworded lands nowhere).
 *
 * This path splits the job into the two halves each engine is actually good at:
 *
 *   1. RANK (this file, cheap, exhaustive)  Every sentence is scored against
 *      every enabled category's stance hypothesis by a zero-shot NLI model
 *      running in a resident Python subprocess. ~1,900 sentences of a 60-minute
 *      video score in ~40s on MPS. Nothing is skipped, so nothing is "missed
 *      because the model stopped early".
 *
 *   2. VERIFY (ai-analysis.service)  One tiny schema-constrained LLM call per
 *      surviving (sentence, category) candidate, answering exactly one question:
 *      is the speaker asserting this, or reporting/questioning/debunking it?
 *
 * Timestamps are the SENTENCE's timestamps — taken from the transcript segments
 * the sentence was assembled from. There is no phrase matching in this path and
 * no model ever emits a time.
 *
 * MEASURED PARAMETERS (proto_stage12.py / proto_verify.py / final-score.txt)
 *
 *   * Model MoritzLaurer/deberta-v3-base-zeroshot-v2.0, multi_label, MPS.
 *   * Threshold 0.7 kept 100% of the non-marginal hand-audit ground truth as
 *     candidates on both test videos.
 *   * A candidate is created for EVERY category above threshold, not the argmax.
 *     The argmax version measurably LOST real flags to category mislabeling —
 *     e.g. a dehumanization line whose top score was 'misinformation' was
 *     verified, flagged, and then scored as a miss because it carried the wrong
 *     category. Keeping all categories above threshold is what makes 10/10 and
 *     11/11 reachable at all.
 *
 * NEVER THROWS INTO AN ANALYSIS. Every failure mode — no worker directory, no
 * venv, spawn failure, model load error, protocol error — resolves to
 * "unavailable", and the caller runs the old discovery pass instead.
 */
import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { AnalysisCategory, normalizeSensitivity } from './prompts/analysis-prompts';

// =============================================================================
// TYPES
// =============================================================================

/** One transcript sentence with the times of the segments it spans. */
export interface RankedSentence {
  start: number;
  end: number;
  text: string;
}

/** One (sentence, category) pair that scored above threshold. */
export interface FlagCandidate {
  sentenceIndex: number;
  start: number;
  end: number;
  text: string;
  category: string;
  score: number;
  /** The stance proposition the verifier will test this candidate against. */
  proposition: string;
}

interface WorkerResponse {
  id?: number;
  ready?: boolean;
  device?: string;
  scores?: number[][];
  error?: string;
}

// =============================================================================
// HYPOTHESES
// =============================================================================

/**
 * Stance hypotheses, one per built-in category, tuned against the reference
 * videos (calibrate-nli.py). These are deliberately NOT the category
 * descriptions from analysis-categories.json: those are INSTRUCTIONS written for
 * an LLM ("ANY use of slurs — flag even if quoted", "NOTE: do NOT flag…"), and
 * an NLI model scores an instruction as a claim about the text, which is
 * meaningless. A hypothesis has to be a PROPOSITION the sentence can entail.
 *
 * `misinformation` IS ABSENT ON PURPOSE — see MISINFORMATION_EXCLUSION below.
 */
const HYPOTHESES: Record<string, string> = {
  'political-demonization':
    'The speaker asserts that political opponents are communists, Marxists, or enemies of the country.',
  hate: 'The speaker expresses hostility or mockery toward a group based on race, religion, or identity.',
  conspiracy: 'The speaker promotes a conspiracy theory as true.',
  dehumanization:
    'The speaker describes people as subhuman, as vermin, disease, or zombies, or as mentally ill because of their politics.',
  violence: 'The speaker calls for, threatens, or glorifies violence.',
  'false-prophecy': 'The speaker claims to receive communication or prophecy from God.',
  'christian-nationalism': 'The speaker argues that Christianity should control politics or government.',
  'prosperity-gospel': 'The speaker asks followers for money as a religious duty.',
  extremism: 'The speaker defends oppression, supremacy, or authoritarian rule.',
  'political-violence': 'The speaker defends or downplays political violence.',
};

/**
 * The propositions the VERIFIER tests, phrased as the thing the speaker would
 * be asserting. The ranker's hypotheses describe the SPEAKER ("the speaker
 * asserts…"), which is the right shape for entailment scoring; the verifier
 * needs the CLAIM itself so the prompt can ask whether the speaker is asserting
 * it or reporting someone else asserting it. Same categories, different job.
 */
const PROPOSITIONS: Record<string, string> = {
  hate: 'a group of people deserves hostility, contempt, or mockery because of their race, ethnicity, religion, national origin, immigration status, gender, or sexuality',
  conspiracy:
    'a conspiracy theory is true — a secret coordinated plot by a hidden group (election fraud, deep state, globalists, New World Order, and the like)',
  'false-prophecy':
    'God has spoken to the speaker or to someone they cite, or a divine revelation or prophecy has been received',
  violence: 'violence against people is justified, deserved, or something to look forward to',
  'christian-nationalism': 'Christianity should direct government, law, or politics',
  'prosperity-gospel':
    'followers should give money to a religious leader or ministry in order to receive blessing or wealth',
  extremism: 'oppression, supremacy, ethnic cleansing, or authoritarian rule is justified',
  'political-violence':
    'a political attack, riot, or insurrection was justified, was staged, or was not a serious wrong',
  'political-demonization':
    'political opponents are communists, Marxists, socialists, or enemies within — a label applied to the people themselves rather than a critique of a specific policy',
  dehumanization:
    "a group of people is vermin, disease, infestation, zombies, animals, or otherwise less than human — or that opponents' politics are the product of mental illness or personal damage rather than sincere belief",
};

/**
 * WHY `misinformation` IS NOT RANKED — measured, not a preference.
 *
 * Every stance hypothesis for this category degenerates to "the speaker makes a
 * factual assertion", because that is the only part of it an entailment model
 * can see. Whether an assertion is FALSE is a world-knowledge question, and NLI
 * has no world knowledge. The result on the reference runs (final-score.txt):
 *
 *   * long video (hank, 60 min): 169 of 205 candidates were misinformation, and
 *     19 of the 20 verified false positives were misinformation — ordinary true
 *     statements about ejection seats, oil production and engineering.
 *   * short video (watters, 12 min): 2 of the 3 extras were misinformation, and
 *     in the unconstrained arm misinformation ATE two real flags by outranking
 *     their true category on the same sentence.
 *
 * So ranking it costs a verifier call on most sentences in the video and buys
 * false positives. It is skipped here even when the user has it enabled, and
 * the skip is logged with the escape hatch: BRIEFCASE_FLAGS_DISCOVERY=1 runs the
 * old chapter-discovery pass, where an LLM reads the text and CAN bring world
 * knowledge to bear on factual claims.
 */
const MISINFORMATION_EXCLUSION =
  'misinformation is not rankable by entailment (it degenerates to "makes a factual assertion": ' +
  '169/205 candidates and 19/20 false positives on the 60-minute reference video). ' +
  'Set BRIEFCASE_FLAGS_DISCOVERY=1 to run the LLM discovery pass, which can judge factual claims.';

/**
 * Score above which a (sentence, category) pair becomes a candidate, per
 * sensitivity setting.
 *
 * THE DIAL IS NOW LITERAL. It used to be a paragraph of English appended to a
 * prompt ("be exhaustive", "when unsure, do not flag") whose effect on the
 * model was unmeasurable. Here it is the number that decides how far down the
 * ranked list the verifier reads:
 *
 *   1 (strong matches only)  0.9  — near-certain entailment only.
 *   2 (balanced, default)    0.7  — the calibrated value: kept 100% of the
 *                                   non-marginal hand-audit ground truth on both
 *                                   reference videos.
 *   3 (aggressive)           0.5  — reads deeper into the list, more verifier
 *                                   calls, recall over precision.
 *
 * Cost scales with this dial, because every candidate is one verifier call.
 */
const THRESHOLD_BY_SENSITIVITY: Record<1 | 2 | 3, number> = { 1: 0.9, 2: 0.7, 3: 0.5 };

/** How long to wait for the worker's ready line (model load) before giving up. */
const READY_TIMEOUT_MS = 180000;
/** How long to wait for one scoring response. A 60-minute video measured ~40s. */
const SCORE_TIMEOUT_MS = 600000;

// =============================================================================
// SENTENCE ASSEMBLY
// =============================================================================

/**
 * Merge transcript segments into sentences.
 *
 * Whisper segments are breath-length fragments, not sentences: scoring them
 * directly gives the NLI model half a clause and no stance. This concatenates
 * every segment into one character stream, splits it on terminal punctuation,
 * and maps each sentence back to the FIRST and LAST segment it overlaps — so
 * the sentence's timestamps are measured segment times, never interpolated.
 *
 * Ported verbatim in behavior from proto_stage12.py, which is what the 0.7
 * threshold was calibrated against.
 */
export function assembleSentences(
  segments: Array<{ start: number; end: number; text: string }>,
): RankedSentence[] {
  const spans: Array<{ lo: number; hi: number; start: number; end: number }> = [];
  const parts: string[] = [];
  let pos = 0;

  for (const seg of segments) {
    const text = (seg.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (parts.length > 0) {
      parts.push(' ');
      pos += 1;
    }
    parts.push(text);
    spans.push({ lo: pos, hi: pos + text.length, start: seg.start, end: seg.end });
    pos += text.length;
  }

  const full = parts.join('');
  if (!full) return [];

  // Sentence boundaries: . ! ? possibly followed by a closing quote/bracket,
  // then whitespace or end of stream.
  const bounds: number[] = [];
  const re = /[.!?]+["')\]]*(?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(full)) !== null) bounds.push(m.index + m[0].length);
  if (bounds.length === 0 || bounds[bounds.length - 1] < full.length) bounds.push(full.length);

  const out: RankedSentence[] = [];
  let cursor = 0;
  for (const bound of bounds) {
    const text = full.slice(cursor, bound).trim();
    if (text) {
      const hits = spans.filter((s) => s.lo < bound && s.hi > cursor);
      if (hits.length > 0) {
        out.push({ start: hits[0].start, end: hits[hits.length - 1].end, text });
      }
    }
    cursor = bound;
  }
  return out;
}

// =============================================================================
// SERVICE
// =============================================================================

@Injectable()
export class NliRankerService implements OnApplicationShutdown {
  private readonly logger = new Logger(NliRankerService.name);

  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<boolean> | null = null;
  private stdoutBuffer = '';
  private nextRequestId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (scores: number[][]) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  /** Set when the worker dies or fails to start, so we do not retry per call. */
  private unavailableReason: string | null = null;
  /** True while `stop()` is tearing the worker down, so its exit is not a fault. */
  private stopping = false;

  // ---------------------------------------------------------------- config

  /**
   * Worker directory, in precedence order: BRIEFCASE_NLI_DIR, then
   * `nliWorkerDir` in app-config.json, then the app-support default. Same config
   * file and same fall-through-on-unreadable behavior as `taskModels` and
   * `embeddingModel`.
   */
  resolveWorkerDir(): string {
    const fromEnv = process.env.BRIEFCASE_NLI_DIR?.trim();
    if (fromEnv) return fromEnv;

    const userDataPath =
      process.env.APPDATA ||
      (process.platform === 'darwin'
        ? path.join(process.env.HOME || '', 'Library', 'Application Support')
        : path.join(process.env.HOME || '', '.config'));

    try {
      const configPath = path.join(userDataPath, 'briefcase', 'app-config.json');
      if (fs.existsSync(configPath)) {
        const configured = JSON.parse(fs.readFileSync(configPath, 'utf8'))?.nliWorkerDir;
        if (typeof configured === 'string' && configured.trim()) return configured.trim();
      }
    } catch (error) {
      this.logger.warn(`[NLI] Ignoring unreadable nliWorkerDir config: ${(error as Error).message}`);
    }

    return path.join(userDataPath, 'briefcase', 'nli');
  }

  private pythonPath(dir: string): string {
    return process.platform === 'win32'
      ? path.join(dir, 'venv', 'Scripts', 'python.exe')
      : path.join(dir, 'venv', 'bin', 'python');
  }

  /**
   * Threshold for this run's sensitivity dial. Exposed so the caller can log the
   * number it is actually running at.
   */
  thresholdForSensitivity(sensitivity: number | undefined): number {
    return THRESHOLD_BY_SENSITIVITY[normalizeSensitivity(sensitivity)];
  }

  /**
   * The (category -> hypothesis, proposition) plan for this run.
   *
   * Disabled categories are dropped. `misinformation` is dropped even when
   * enabled (see MISINFORMATION_EXCLUSION). A category with no tuned hypothesis
   * — anything the user added themselves — falls back to its own description
   * wrapped as a proposition, and says so in the log, because an untuned
   * hypothesis has no calibrated threshold behind it.
   */
  buildPlan(categories: AnalysisCategory[]): Array<{
    category: string;
    hypothesis: string;
    proposition: string;
    tuned: boolean;
  }> {
    const plan: Array<{ category: string; hypothesis: string; proposition: string; tuned: boolean }> = [];

    for (const category of categories || []) {
      const name = (category?.name || '').trim();
      if (!name || category.enabled === false) continue;

      if (name === 'misinformation') {
        this.logger.log(`[NLI] Skipping category 'misinformation': ${MISINFORMATION_EXCLUSION}`);
        continue;
      }

      const tuned = HYPOTHESES[name];
      if (tuned) {
        plan.push({ category: name, hypothesis: tuned, proposition: PROPOSITIONS[name], tuned: true });
        continue;
      }

      const description = (category.description || '').replace(/\s+/g, ' ').trim();
      if (!description) {
        this.logger.warn(`[NLI] Skipping category '${name}': no tuned hypothesis and no description to fall back to`);
        continue;
      }
      this.logger.warn(
        `[NLI] Category '${name}' has no tuned hypothesis — running on its description. ` +
        `The 0.7 threshold was not calibrated for it, so its candidate count may be high or low.`,
      );
      plan.push({
        category: name,
        hypothesis: `The speaker's statement matches this description: ${description}`,
        proposition: description,
        tuned: false,
      });
    }

    return plan;
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * True when a worker is running and has loaded its model. Starts one if
   * needed. NEVER throws — every failure is a reason string and a `false`.
   */
  async isAvailable(): Promise<boolean> {
    if (this.child && !this.unavailableReason) return true;
    if (this.unavailableReason) return false;
    return this.start();
  }

  /** Why the ranker is unavailable, for the caller's one log line. */
  get unavailable(): string | null {
    return this.unavailableReason;
  }

  private async start(): Promise<boolean> {
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<boolean> {
    const dir = this.resolveWorkerDir();
    const python = this.pythonPath(dir);
    const worker = path.join(dir, 'worker.py');

    if (!fs.existsSync(dir)) return this.markUnavailable(`worker directory not found: ${dir}`);
    if (!fs.existsSync(worker)) return this.markUnavailable(`worker.py not found in ${dir}`);
    if (!fs.existsSync(python)) return this.markUnavailable(`venv python not found: ${python}`);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(python, ['-u', worker], {
        cwd: dir,
        env: {
          ...process.env,
          // HF_HOME lives inside the worker dir, holding the pre-downloaded
          // model, and OFFLINE guarantees an analysis never blocks on a network
          // fetch: a missing model fails fast into the discovery fallback.
          HF_HOME: path.join(dir, 'hf'),
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
          TOKENIZERS_PARALLELISM: 'false',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      return this.markUnavailable(`spawn failed: ${(error as Error).message}`);
    }

    this.child = child;
    this.stdoutBuffer = '';

    let stderrTail = '';
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-2000);
      // Progress bars and load chatter are not warnings; only surface at debug.
      this.logger.debug(`[NLI worker] ${text.trim()}`);
    });

    const ready = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        resolve(this.markUnavailable(`worker did not become ready within ${READY_TIMEOUT_MS / 1000}s`));
      }, READY_TIMEOUT_MS);

      const settle = (ok: boolean) => {
        clearTimeout(timer);
        resolve(ok);
      };

      child.stdout.on('data', (chunk: Buffer) => {
        this.stdoutBuffer += chunk.toString();
        for (;;) {
          const newline = this.stdoutBuffer.indexOf('\n');
          if (newline < 0) break;
          const line = this.stdoutBuffer.slice(0, newline).trim();
          this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
          if (!line) continue;

          let message: WorkerResponse;
          try {
            message = JSON.parse(line);
          } catch {
            this.logger.warn(`[NLI] Ignoring non-JSON line from worker: ${line.slice(0, 200)}`);
            continue;
          }

          if (message.ready) {
            this.logger.log(`[NLI] Ranker worker ready (device=${message.device}) from ${dir}`);
            settle(true);
            continue;
          }
          this.deliver(message);
        }
      });

      child.on('error', (error) => {
        settle(this.markUnavailable(`worker process error: ${error.message}`));
      });

      child.on('exit', (code, signal) => {
        this.child = null;
        const detail = stderrTail.trim().split('\n').slice(-3).join(' | ');
        const reason = `worker exited (code=${code}, signal=${signal})${detail ? `: ${detail}` : ''}`;
        // In-flight requests must fail rather than hang forever.
        for (const [id, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error(reason));
          this.pending.delete(id);
        }
        // A deliberate stop() is not a fault: leaving `unavailableReason` unset
        // is what lets the NEXT analysis start a fresh worker.
        if (this.stopping) {
          this.stopping = false;
          settle(false);
          return;
        }
        settle(this.markUnavailable(reason));
      });
    });

    return ready;
  }

  private markUnavailable(reason: string): false {
    if (!this.unavailableReason) {
      this.unavailableReason = reason;
      this.logger.warn(`[NLI] Ranker unavailable — ${reason}`);
    }
    return false;
  }

  private deliver(message: WorkerResponse): void {
    const entry = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(message.id as number);
    if (message.error) entry.reject(new Error(message.error));
    else entry.resolve(message.scores || []);
  }

  /**
   * Stop the worker. Called at the end of every analysis (the model has done its
   * job and there is no reason to hold ~1GB of Python resident between runs) and
   * again on application shutdown, so no orphan python survives the app.
   */
  stop(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.stopping = true;
    // Reset availability so the NEXT analysis starts a fresh worker rather than
    // inheriting "unavailable" from a deliberate stop.
    this.unavailableReason = null;
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }
    // EOF is the documented exit path; SIGKILL is only the backstop for a
    // wedged interpreter, and it must not outlive the app's shutdown budget.
    const killer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, 2000);
    killer.unref?.();
    child.once('exit', () => clearTimeout(killer));
  }

  onApplicationShutdown(): void {
    this.stop();
  }

  // ---------------------------------------------------------------- ranking

  /**
   * Score every sentence against every planned category and return each
   * (sentence, category) pair above `threshold`.
   *
   * ALL categories above threshold become candidates, deliberately — see the
   * file header. Returned in transcript order, then by descending score within a
   * sentence, so the verifier walks the video front to back.
   */
  async rankSentences(
    sentences: RankedSentence[],
    categories: AnalysisCategory[],
    sensitivity?: number,
  ): Promise<FlagCandidate[]> {
    const plan = this.buildPlan(categories);
    if (plan.length === 0 || sentences.length === 0) return [];

    const threshold = this.thresholdForSensitivity(sensitivity);
    const scores = await this.score(
      sentences.map((s) => s.text),
      plan.map((p) => p.hypothesis),
    );

    const candidates: FlagCandidate[] = [];
    for (let i = 0; i < sentences.length && i < scores.length; i++) {
      const row = scores[i];
      const hits: FlagCandidate[] = [];
      for (let c = 0; c < plan.length; c++) {
        const score = row[c] ?? 0;
        if (score < threshold) continue;
        hits.push({
          sentenceIndex: i,
          start: sentences[i].start,
          end: sentences[i].end,
          text: sentences[i].text,
          category: plan[c].category,
          score,
          proposition: plan[c].proposition,
        });
      }
      hits.sort((a, b) => b.score - a.score);
      candidates.push(...hits);
    }

    this.logger.log(
      `[NLI] Ranked ${sentences.length} sentences x ${plan.length} categories ` +
      `at threshold ${threshold} -> ${candidates.length} candidates`,
    );
    return candidates;
  }

  /** One request/response round trip against the resident worker. */
  private async score(texts: string[], hypotheses: string[]): Promise<number[][]> {
    if (!(await this.isAvailable()) || !this.child) {
      throw new Error(this.unavailableReason || 'NLI ranker is unavailable');
    }
    const child = this.child;
    const id = this.nextRequestId++;

    return new Promise<number[][]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`NLI scoring timed out after ${SCORE_TIMEOUT_MS / 1000}s`));
      }, SCORE_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, texts, hypotheses })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`could not write to NLI worker: ${(error as Error).message}`));
      }
    });
  }
}
