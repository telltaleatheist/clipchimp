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
 *   1. RANK (this file, cheap, exhaustive)  Every sentence, and every sliding
 *      3-sentence window, is scored against every enabled category's stance
 *      hypotheses by a zero-shot NLI model running in a resident Python
 *      subprocess. A 60-minute video scores in ~90s on MPS. Nothing is skipped,
 *      so nothing is "missed because the model stopped early".
 *
 *   2. WINDOW (this file, buildWindows)  Surviving sentences are expanded to the
 *      sentences around them and merged, category-blind, into paragraph-sized
 *      passages. Scoring stays per sentence; JUDGING moves up to the passage,
 *      because a viewer experiences one moment, not four consecutive sentences.
 *
 *   3. VERIFY (ai-analysis.service)  One tiny schema-constrained LLM call per
 *      (window, category), answering exactly one question about the whole
 *      passage: is the speaker asserting this, or reporting/questioning/
 *      debunking it?
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

/**
 * One (span, category) pair the ranker kept.
 *
 * A SENTENCE-level candidate spans one sentence (`spanFrom === spanTo ===
 * sentenceIndex`). A WINDOW-level candidate spans the sliding window that
 * scored — see scoreWindowLevel — and `sentenceIndex` is its best guess at a
 * representative sentence, used only for logging.
 */
export interface FlagCandidate {
  sentenceIndex: number;
  /** Inclusive sentence-index range this candidate covers. */
  spanFrom: number;
  spanTo: number;
  start: number;
  end: number;
  text: string;
  category: string;
  score: number;
  /** The stance proposition the verifier will test this candidate against. */
  proposition: string;
  /** Which pass produced it — sentence-level scoring or sliding-window scoring. */
  source: 'sentence' | 'window';
  /**
   * True when this pair never cleared the threshold on its own and exists only
   * because the sentence fired several categories just under it — see the
   * RESCUE rule below.
   */
  rescued: boolean;
}

/** One category's evidence inside a verification window. */
export interface WindowCategory {
  category: string;
  proposition: string;
  /** The window's BEST score for this category... */
  score: number;
  /** ...and the sentence that scored it. */
  sentenceIndex: number;
  text: string;
  start: number;
  end: number;
  /** Every sentence in the window that fired this category, in transcript order. */
  sentenceIndices: number[];
  /** True only when EVERY firing of this category in the window was a rescue. */
  rescued: boolean;
}

/**
 * A paragraph-sized passage of transcript that the verifier judges as a whole.
 *
 * Scoring stays at SENTENCE granularity (that is what fixed stretch-level
 * dilution and it is not changed here). A window is what happens AFTER
 * thresholding: each hot sentence is expanded to the sentences around it, and
 * overlapping or near-adjacent expansions are merged into one passage
 * regardless of category. The window then carries the UNION of its sentences'
 * fired categories, and one verification call is made per (window, category) —
 * so a passage where three categories fired costs three calls, not one per
 * (sentence, category) pair.
 */
export interface FlagWindow {
  /** Inclusive sentence-index range of the passage the verifier is shown. */
  contextFrom: number;
  contextTo: number;
  /** Inclusive sentence-index range of the sentences that actually fired. */
  firedFrom: number;
  firedTo: number;
  /** Union of the fired categories, strongest first. */
  categories: WindowCategory[];
  /** Noisy-OR over the per-category best scores — the ranking score. */
  score: number;
}

/** One category's scoring plan for a run: what to rank with, what to verify with. */
export interface RankPlan {
  category: string;
  /** One or more stance hypotheses; a category scores as the MAX across them. */
  hypotheses: string[];
  proposition: string;
  tuned: boolean;
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
const HYPOTHESES: Record<string, string | string[]> = {
  'political-demonization':
    'The speaker asserts that political opponents are communists, Marxists, or enemies of the country.',
  hate: 'The speaker expresses hostility or mockery toward a group based on race, religion, or identity.',
  conspiracy: 'The speaker promotes a conspiracy theory as true.',
  // MEASURED, dh-probe.js on both reference videos. The single hypothesis below
  // scored a MAXIMUM of 0.172 over the 12-minute political video and 0.016 over
  // the 60-minute one — including 0.150 on "With a whole army of commies,
  // zombies behind him", a sentence containing the literal word 'zombies'. It is
  // phrased as a DESCRIPTION OF THE ACT ("describes people as subhuman"), which
  // is what an analyst would write in a report; it is not how the thing is ever
  // said out loud. So, as with christian-nationalism, the category carries
  // several propositions and takes the max.
  //
  // WHAT WAS TRIED AND REJECTED, because a loose proposition here costs
  // precision on ordinary political insult:
  //
  //   'compares a group of people to zombies, animals, or insects'  — scored
  //     0.958 on "That's 323 death rattlers there here in San Diego" (a Marine
  //     squadron nickname) and 0.908 on "we need those wildcatters out there"
  //     (oil drilling). It matched animal NOUNS, not the dehumanizing move.
  //   'refers to a group as a horde, a swarm, or a mindless mass'  — scored
  //     0.999 on "They have pack of fools" and 0.780 on the neutral sentence
  //     "The communists have proven they can win in coastal cities".
  //   'attributes opponents' politics to psychological damage, guilt,
  //     resentment, or family problems'  — scored 0.973 on "Do you blame the
  //     parents?" in a passage about the fentanyl crisis. Naming POLITICAL
  //     BELIEF explicitly (the surviving form below) drops that to 0.062.
  //
  // All five kept propositions together score, on the video with no dehumanizing
  // content at all, ZERO sentences above 0.5 and ZERO windows above 0.7.
  dehumanization: [
    'The speaker describes people as subhuman, as vermin, disease, or zombies, or as mentally ill because of their politics.',
    'The speaker describes a group of people as an infestation, a plague, a fever, or something spreading through the country.',
    'The speaker calls a crowd of political supporters zombies or mindless followers.',
    "The speaker explains opponents' politics as mental illness, derangement, or personal damage rather than sincere belief.",
    'The speaker says opponents hold their political beliefs because of psychological damage, guilt, or resentment rather than reason.',
  ],
  violence: 'The speaker calls for, threatens, or glorifies violence.',
  'false-prophecy': 'The speaker claims to receive communication or prophecy from God.',
  // MEASURED, cn-probe.js on the 60-minute reference video: the single
  // hypothesis "Christianity should control politics or government" scored a
  // MAXIMUM of 0.457 over 801 sentences — zero candidates at any sensitivity —
  // on a video whose subject is prayer ministries operating inside the White
  // House and God-ordained regime change. It reads as a claim about doctrine,
  // and nobody says it that way out loud; what they say is "there are Christians
  // in the White House" and "God is determined to see this happen".
  //
  // A category may therefore carry SEVERAL hypotheses and takes the MAX across
  // them, because entailment is a per-proposition question and one category can
  // be argued in genuinely different propositions. These two were picked against
  // the reference videos: on the 60-minute video they lift the category from 0
  // to real candidates (0.961 sentence / 0.989 window), and on the 12-minute
  // political video, which has no Christian-nationalist content at all, they
  // score 0.025 and 0.089 max — so they do not leak into unrelated material.
  'christian-nationalism': [
    'The speaker argues that Christianity should control politics or government.',
    'The speaker says Christians or the church should take authority in government or public life.',
    'The speaker says God is directing the nation, its government, or its leaders.',
  ],
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
 *                                   calls, recall over precision. The verifier
 *                                   is also asked to lean toward "flag" at this
 *                                   setting (VERIFICATION_EMPHASIS in
 *                                   analysis-prompts.ts) — a longer candidate
 *                                   list answered by the same hard grader is
 *                                   only half a dial.
 *
 * Cost scales with this dial, because every candidate is one verifier call.
 */
const THRESHOLD_BY_SENSITIVITY: Record<1 | 2 | 3, number> = { 1: 0.9, 2: 0.7, 3: 0.5 };

/**
 * VERIFICATION WINDOWS — the parameters that turn hot sentences into passages.
 *
 * THE PROBLEM THEY SOLVE, from a real run: a speaker spends four sentences on
 * one bit, the ranker scores each sentence separately and each one clears the
 * threshold, and the timeline came back with four back-to-back single-sentence
 * flags for what a viewer experiences as ONE moment. Per-category merging after
 * verification could not fix that, because the four sentences were not all the
 * same category.
 *
 * So the unit of VERIFICATION (and therefore of the stored section) is the
 * passage, while the unit of SCORING stays the sentence.
 *
 *   WINDOW_CONTEXT_SENTENCES     +/-2 around the hot sentence, so an unmerged
 *                                window is up to 5 sentences — the same +/-2 the
 *                                measured verification runs already showed the
 *                                model as context, now the thing being judged.
 *   WINDOW_MAX_CONTEXT_SECONDS   A hard stop on that expansion. Sentences run
 *                                3-6s in these transcripts, so 5 of them is
 *                                normally 15-25s; the cap is what keeps a
 *                                window that lands next to a 40-second monologue
 *                                sentence from becoming a page.
 *   WINDOW_MERGE_GAP_*           Two windows join when at most one sentence or
 *                                5 seconds separates them. Merging is
 *                                deliberately CATEGORY-BLIND: the four-flag run
 *                                above was three different categories, and
 *                                merging per category would have left it split.
 *   WINDOW_MAX_MERGED_SECONDS    Chaining has to stop somewhere. Without a cap,
 *                                a dense five-minute rant merges into a single
 *                                section that is useless to scrub to and a
 *                                prompt that no longer fits the pinned num_ctx.
 *                                MEASURED: at 60s the verifier answered "skip"
 *                                for the SECOND category of two long merged
 *                                passages on the reference video and cost two
 *                                hand-audited category labels (the moments were
 *                                still flagged, under the other category); at
 *                                40s both came back and the four-back-to-back
 *                                run the operator reported still coalesces.
 *                                40s is roughly 100-130 spoken words: a
 *                                paragraph, which is what a passage judgment
 *                                can carry without diluting the weaker claim.
 */
const WINDOW_CONTEXT_SENTENCES = 2;
const WINDOW_MAX_CONTEXT_SECONDS = 25;
const WINDOW_MERGE_GAP_SENTENCES = 1;
const WINDOW_MERGE_GAP_SECONDS = 5;
const WINDOW_MAX_MERGED_SECONDS = 40;

/**
 * RESCUE — corroboration standing in for certainty.
 *
 * A single category at 0.68 is below threshold and stays below threshold. But a
 * sentence that scores 0.68 on dehumanization AND 0.66 on hate is not the same
 * evidence as a sentence that scores 0.68 on one thing and nothing on anything
 * else: two independent hypotheses both nearly entailing the same sentence is
 * itself a signal. Such a sentence becomes a candidate, and its rescue is
 * logged distinctly so a run's log shows exactly what the rule bought.
 *
 * The rule applies ONLY to sentences where nothing cleared the threshold.
 * Adding near-threshold categories to already-hot sentences would add
 * verification calls — the opposite of what this change is for — and would let
 * a weak category attach itself to a strong sentence.
 */
const RESCUE_MARGIN = 0.15;
const RESCUE_MIN_CATEGORIES = 2;

/**
 * SLIDING-WINDOW SCORING — the second ranking pass.
 *
 * Sentence-level scoring finds a sentence that entails a hypothesis on its own.
 * It cannot find DISTRIBUTED rhetoric: a passage where the premise is in one
 * sentence, the actor in the next and the conclusion in the third, and no single
 * sentence carries the whole proposition. Measured symptom — a 60-minute video
 * about prayer ministries operating inside the White House and God-ordained
 * regime change produced ZERO christian-nationalism flags, because the argument
 * is never in one sentence.
 *
 * So the same hypotheses are also scored against every SLIDING_WINDOW_SENTENCES
 * -sentence window, stride 1, and those hits are unioned with the sentence-level
 * ones. The NLI pass is local and cheap (both passes over a 60-minute video
 * measured ~90s on MPS), so roughly doubling its work is affordable in a way
 * that doubling verifier calls would not be — which is why the union is DEDUPED
 * by span overlap before it ever reaches the verifier.
 *
 * Stride 1 with size 3 means overlapping windows fire on the same rhetoric; the
 * dedupe keeps the highest-scoring window per category per overlapping run.
 */
const SLIDING_WINDOW_SENTENCES = 3;

/** How long to wait for the worker's ready line (model load) before giving up. */
const READY_TIMEOUT_MS = 180000;
/** How long to wait for one scoring response. One pass over 60 minutes: ~45s. */
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
// MULTI-HYPOTHESIS SCORING
// =============================================================================

/**
 * Flatten a plan into the hypothesis list the worker scores, remembering which
 * plan entry owns each column. A category with three hypotheses occupies three
 * columns and collapses back to one score by MAX — the strongest way the
 * category was argued wins, which is the right reduction for propositions that
 * are alternatives rather than parts of one claim.
 */
function flattenHypotheses(plan: RankPlan[]): { texts: string[]; owner: number[] } {
  const texts: string[] = [];
  const owner: number[] = [];
  for (let p = 0; p < plan.length; p++) {
    for (const hypothesis of plan[p].hypotheses) {
      texts.push(hypothesis);
      owner.push(p);
    }
  }
  return { texts, owner };
}

/** Collapse one row of raw hypothesis scores to one score per plan entry. */
function collapseRow(row: number[], owner: number[], planCount: number): number[] {
  const out = new Array<number>(planCount).fill(0);
  for (let column = 0; column < owner.length; column++) {
    const score = row?.[column] ?? 0;
    if (score > out[owner[column]]) out[owner[column]] = score;
  }
  return out;
}

// =============================================================================
// VERIFICATION WINDOWS
// =============================================================================

/** The per-category evidence one hot span contributes to a window. */
function categoriesFromSpan(candidates: FlagCandidate[]): WindowCategory[] {
  return candidates.map((candidate) => ({
    category: candidate.category,
    proposition: candidate.proposition,
    score: candidate.score,
    sentenceIndex: candidate.sentenceIndex,
    text: candidate.text,
    start: candidate.start,
    end: candidate.end,
    sentenceIndices: Array.from(
      { length: candidate.spanTo - candidate.spanFrom + 1 },
      (_unused, offset) => candidate.spanFrom + offset,
    ),
    rescued: candidate.rescued,
  }));
}

/**
 * Union two windows' category evidence. A category present in both keeps its
 * BEST-scoring sentence (that is the quote the verdict is really about) and the
 * union of every sentence that fired it (that is what the section's span is
 * measured from).
 */
function mergeWindowCategories(a: WindowCategory[], b: WindowCategory[]): WindowCategory[] {
  const out = new Map<string, WindowCategory>();
  for (const entry of [...a, ...b]) {
    const existing = out.get(entry.category);
    if (!existing) {
      out.set(entry.category, { ...entry, sentenceIndices: [...entry.sentenceIndices] });
      continue;
    }
    const best = entry.score > existing.score ? entry : existing;
    const indices = new Set([...existing.sentenceIndices, ...entry.sentenceIndices]);
    out.set(entry.category, {
      ...best,
      sentenceIndices: [...indices].sort((x, y) => x - y),
      // One threshold-clearing firing anywhere in the window means the category
      // is not resting on the rescue rule.
      rescued: existing.rescued && entry.rescued,
    });
  }
  return [...out.values()];
}

/**
 * Turn ranked (span, category) candidates into merged verification windows.
 *
 * Pure and exported so the shape can be exercised without a Python worker.
 * Candidates must be in transcript order (ascending spanFrom, then spanTo),
 * which is what `rankWindows` hands it.
 *
 * MULTI-CATEGORY BOOST. A window's ranking score is the noisy-OR of its
 * categories' best scores, 1 - PROD(1 - s_i). Two independent hypotheses at
 * 0.95 and 0.93 give 0.9965, which outranks any single 0.99 — which is the
 * point: a passage that is demonizing AND hateful is worse content than a
 * passage that is very confidently one thing, and the operator should see it
 * first. The score orders VERIFICATION, it does not gate it; every window and
 * every one of its categories is still verified.
 */
export function buildWindows(sentences: RankedSentence[], candidates: FlagCandidate[]): FlagWindow[] {
  if (candidates.length === 0 || sentences.length === 0) return [];

  const bySpan = new Map<string, FlagCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.spanFrom}:${candidate.spanTo}`;
    const list = bySpan.get(key);
    if (list) list.push(candidate);
    else bySpan.set(key, [candidate]);
  }
  const hot = [...bySpan.values()].sort(
    (a, b) => a[0].spanFrom - b[0].spanFrom || a[0].spanTo - b[0].spanTo,
  );

  // 1. Expand every hot span into a passage, alternating sides so a window at a
  //    hard time cap is still balanced around the span that fired.
  const expanded: FlagWindow[] = hot.map((group) => {
    let from = group[0].spanFrom;
    let to = group[0].spanTo;
    for (let step = 0; step < WINDOW_CONTEXT_SENTENCES; step++) {
      if (from > 0 && sentences[to].end - sentences[from - 1].start <= WINDOW_MAX_CONTEXT_SECONDS) from--;
      if (
        to + 1 < sentences.length &&
        sentences[to + 1].end - sentences[from].start <= WINDOW_MAX_CONTEXT_SECONDS
      ) {
        to++;
      }
    }
    return {
      contextFrom: from,
      contextTo: to,
      firedFrom: group[0].spanFrom,
      firedTo: group[0].spanTo,
      categories: categoriesFromSpan(group),
      score: 0,
    };
  });

  // 2. Merge overlapping / near-adjacent passages, category-blind.
  const merged: FlagWindow[] = [];
  for (const window of expanded) {
    const previous = merged[merged.length - 1];
    if (previous) {
      // Overlapping and nested windows give a negative gap, which both tests
      // accept — that is the intent, they are the same passage.
      const sentenceGap = window.contextFrom - previous.contextTo - 1;
      const secondsGap = sentences[window.contextFrom].start - sentences[previous.contextTo].end;
      const joinedFrom = Math.min(previous.contextFrom, window.contextFrom);
      const joinedTo = Math.max(previous.contextTo, window.contextTo);
      const joinedSpan = sentences[joinedTo].end - sentences[joinedFrom].start;
      const close = sentenceGap <= WINDOW_MERGE_GAP_SENTENCES || secondsGap <= WINDOW_MERGE_GAP_SECONDS;
      if (close && joinedSpan <= WINDOW_MAX_MERGED_SECONDS) {
        previous.contextFrom = joinedFrom;
        previous.contextTo = joinedTo;
        previous.firedFrom = Math.min(previous.firedFrom, window.firedFrom);
        previous.firedTo = Math.max(previous.firedTo, window.firedTo);
        previous.categories = mergeWindowCategories(previous.categories, window.categories);
        continue;
      }
    }
    merged.push({ ...window, categories: [...window.categories] });
  }

  // 3. Score and order the evidence inside each window.
  for (const window of merged) {
    window.categories.sort((x, y) => y.score - x.score);
    window.score = 1 - window.categories.reduce((product, c) => product * (1 - c.score), 1);
  }
  return merged;
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
   * The (category -> hypotheses, proposition) plan for this run.
   *
   * Disabled categories are dropped. `misinformation` is dropped even when
   * enabled (see MISINFORMATION_EXCLUSION). A category with no tuned hypothesis
   * — anything the user added themselves — falls back to its own description
   * wrapped as a proposition, and says so in the log, because an untuned
   * hypothesis has no calibrated threshold behind it.
   */
  buildPlan(categories: AnalysisCategory[]): RankPlan[] {
    const plan: RankPlan[] = [];

    for (const category of categories || []) {
      const name = (category?.name || '').trim();
      if (!name || category.enabled === false) continue;

      if (name === 'misinformation') {
        this.logger.log(`[NLI] Skipping category 'misinformation': ${MISINFORMATION_EXCLUSION}`);
        continue;
      }

      const tuned = HYPOTHESES[name];
      if (tuned) {
        plan.push({
          category: name,
          hypotheses: Array.isArray(tuned) ? tuned : [tuned],
          proposition: PROPOSITIONS[name],
          tuned: true,
        });
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
        hypotheses: [`The speaker's statement matches this description: ${description}`],
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
    return this.scoreSentenceLevel(sentences, plan, this.thresholdForSensitivity(sensitivity));
  }

  private async scoreSentenceLevel(
    sentences: RankedSentence[],
    plan: RankPlan[],
    threshold: number,
  ): Promise<FlagCandidate[]> {
    const { texts: hypotheses, owner } = flattenHypotheses(plan);
    const raw = await this.score(
      sentences.map((s) => s.text),
      hypotheses,
    );
    const scores = raw.map((row) => collapseRow(row, owner, plan.length));

    const candidates: FlagCandidate[] = [];
    let rescuedSentences = 0;
    const make = (i: number, c: number, score: number, rescued: boolean): FlagCandidate => ({
      sentenceIndex: i,
      spanFrom: i,
      spanTo: i,
      start: sentences[i].start,
      end: sentences[i].end,
      text: sentences[i].text,
      category: plan[c].category,
      score,
      proposition: plan[c].proposition,
      source: 'sentence',
      rescued,
    });

    for (let i = 0; i < sentences.length && i < scores.length; i++) {
      const row = scores[i];
      const hits: FlagCandidate[] = [];
      for (let c = 0; c < plan.length; c++) {
        const score = row[c] ?? 0;
        if (score >= threshold) hits.push(make(i, c, score, false));
      }

      // RESCUE (see RESCUE_MARGIN): nothing cleared the bar alone, but several
      // categories came close together. Only ever applied to a sentence with no
      // threshold-clearing category.
      if (hits.length === 0) {
        const near: FlagCandidate[] = [];
        for (let c = 0; c < plan.length; c++) {
          const score = row[c] ?? 0;
          if (score >= threshold - RESCUE_MARGIN) near.push(make(i, c, score, true));
        }
        if (near.length >= RESCUE_MIN_CATEGORIES) {
          near.sort((a, b) => b.score - a.score);
          hits.push(...near);
          rescuedSentences++;
          this.logger.log(
            `[NLI] RESCUED ${sentences[i].start.toFixed(1)}s on ${near.length} corroborating categories ` +
            `(${near.map((n) => `${n.category} ${n.score.toFixed(3)}`).join(', ')}) — ` +
            `none reached ${threshold}, all within ${RESCUE_MARGIN}: "${sentences[i].text.slice(0, 90)}"`,
          );
        }
      }

      hits.sort((a, b) => b.score - a.score);
      candidates.push(...hits);
    }

    this.logger.log(
      `[NLI] Sentence pass: ${sentences.length} sentences x ${plan.length} categories ` +
      `at threshold ${threshold} -> ${candidates.length} candidates ` +
      `(${rescuedSentences} sentence(s) rescued on 2+ near-threshold categories)`,
    );
    return candidates;
  }

  /**
   * Score every sliding SLIDING_WINDOW_SENTENCES-sentence window and return the
   * hits that add something the sentence pass did not already have.
   *
   * DEDUPE, in this order, both by span overlap:
   *   1. against the sentence pass — if that category already fired on a
   *      sentence inside this window, the window is the same finding restated
   *      and only costs a verifier call;
   *   2. against stronger windows of the same category — stride-1 windows
   *      overlap by construction, so a run of them is one finding and the
   *      highest-scoring window is the one that represents it.
   */
  private async scoreWindowLevel(
    sentences: RankedSentence[],
    plan: RankPlan[],
    threshold: number,
    sentenceLevel: FlagCandidate[],
  ): Promise<FlagCandidate[]> {
    const size = SLIDING_WINDOW_SENTENCES;
    if (sentences.length < size) return [];

    const texts: string[] = [];
    for (let i = 0; i + size <= sentences.length; i++) {
      texts.push(
        sentences
          .slice(i, i + size)
          .map((s) => s.text)
          .join(' '),
      );
    }

    const { texts: hypotheses, owner } = flattenHypotheses(plan);
    const scores = (await this.score(texts, hypotheses)).map((row) =>
      collapseRow(row, owner, plan.length),
    );

    const raw: FlagCandidate[] = [];
    for (let w = 0; w < texts.length && w < scores.length; w++) {
      const row = scores[w];
      for (let c = 0; c < plan.length; c++) {
        const score = row[c] ?? 0;
        if (score < threshold) continue;
        raw.push({
          // Representative sentence = the middle of the window; used for logs,
          // never for the span (which is the whole window).
          sentenceIndex: w + Math.floor(size / 2),
          spanFrom: w,
          spanTo: w + size - 1,
          start: sentences[w].start,
          end: sentences[w + size - 1].end,
          text: texts[w],
          category: plan[c].category,
          score,
          proposition: plan[c].proposition,
          source: 'window',
          rescued: false,
        });
      }
    }

    const alreadyHot = new Map<string, number[]>();
    for (const candidate of sentenceLevel) {
      const list = alreadyHot.get(candidate.category);
      if (list) list.push(candidate.sentenceIndex);
      else alreadyHot.set(candidate.category, [candidate.sentenceIndex]);
    }

    const keptSpans = new Map<string, Array<[number, number]>>();
    const kept: FlagCandidate[] = [];
    for (const candidate of [...raw].sort((a, b) => b.score - a.score)) {
      const hotHere = alreadyHot.get(candidate.category) || [];
      if (hotHere.some((i) => i >= candidate.spanFrom && i <= candidate.spanTo)) continue;

      const spans = keptSpans.get(candidate.category) || [];
      if (spans.some(([from, to]) => from <= candidate.spanTo && to >= candidate.spanFrom)) continue;
      spans.push([candidate.spanFrom, candidate.spanTo]);
      keptSpans.set(candidate.category, spans);
      kept.push(candidate);
    }

    kept.sort((a, b) => a.spanFrom - b.spanFrom);
    this.logger.log(
      `[NLI] Window pass: ${texts.length} sliding ${size}-sentence windows x ${plan.length} categories ` +
      `at threshold ${threshold} -> ${raw.length} raw hits, ${kept.length} new candidates ` +
      `(${raw.length - kept.length} deduped against the sentence pass or a stronger overlapping window)`,
    );
    for (const candidate of kept) {
      this.logger.log(
        `[NLI] DISTRIBUTED ${candidate.start.toFixed(1)}s ${candidate.category} ${candidate.score.toFixed(3)} ` +
        `— no single sentence fired: "${candidate.text.slice(0, 120)}"`,
      );
    }
    return kept;
  }

  /**
   * The stage-1 entry point the flag stage actually calls: rank sentences AND
   * sliding windows, union the two, then group the survivors into merged
   * verification windows, strongest first.
   *
   * Ordering is by the window's noisy-OR score so a run that is interrupted, or
   * watched live, surfaces the worst passages first. It does NOT gate anything:
   * the caller verifies every window and every category in it.
   */
  async rankWindows(
    sentences: RankedSentence[],
    categories: AnalysisCategory[],
    sensitivity?: number,
  ): Promise<FlagWindow[]> {
    const plan = this.buildPlan(categories);
    if (plan.length === 0 || sentences.length === 0) return [];
    const threshold = this.thresholdForSensitivity(sensitivity);

    const sentenceLevel = await this.scoreSentenceLevel(sentences, plan, threshold);
    const windowLevel = await this.scoreWindowLevel(sentences, plan, threshold, sentenceLevel);
    const candidates = [...sentenceLevel, ...windowLevel].sort(
      (a, b) => a.spanFrom - b.spanFrom || a.spanTo - b.spanTo,
    );

    const windows = buildWindows(sentences, candidates);
    // Sort on the LOG of the noisy-OR complement, not the noisy-OR itself:
    // measured on the reference videos, most windows carry several 0.9+
    // categories and `score` saturates at 1.0000 in float64, which would make
    // the order arbitrary. Sum of log(1 - s) is the same ranking with the
    // resolution intact (more negative = stronger).
    const strength = (window: FlagWindow) =>
      window.categories.reduce((sum, c) => sum + Math.log(Math.max(1 - c.score, Number.MIN_VALUE)), 0);
    windows.sort((a, b) => strength(a) - strength(b) || a.contextFrom - b.contextFrom);

    const calls = windows.reduce((total, window) => total + window.categories.length, 0);
    this.logger.log(
      `[NLI] ${candidates.length} candidates (${sentenceLevel.length} sentence + ${windowLevel.length} window) ` +
      `-> ${windows.length} verification windows, ${calls} (window, category) verify calls ` +
      `(one call per candidate would have been ${candidates.length})`,
    );
    return windows;
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
