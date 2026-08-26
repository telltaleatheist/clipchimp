/**
 * THE FLAG FILTER — the dial, after it stopped being a run parameter.
 *
 * THE RULING (operator, 2026-08-25):
 *
 *   "really, we should find all the loose flags and organize them, and the knob
 *    can be a filter afterward that filters out loosely paired ones, moderate,
 *    or strictly paired ones... all the work will be done anyway, and itll be a
 *    UI component that filters out loose pairings rather than defining what the
 *    actual run does before it runs."
 *
 * The analysis now captures at its widest setting every time (NLI threshold 0.2,
 * rescue floor 0.15), asks the verifier about every candidate it captured, and
 * stores BOTH answers — accepted and rejected — with the ranker score behind
 * each one. So what a user sees is a pure function of stored data, and moving
 * this control is a client-side array filter: instant, free, reversible, and
 * incapable of losing a finding, because nothing was thrown away to make it.
 *
 * THE THREE POSITIONS, and why they threshold where they do:
 *
 *   STRICT    verdict 'flag' AND score >= 0.9. 0.9 was the old dial's top
 *             position, "near-certain entailment only".
 *   MODERATE  verdict 'flag' AND score >= 0.7. 0.7 is THE CALIBRATED VALUE: it
 *             kept 100% of the non-marginal hand-audit ground truth on both
 *             reference videos, and a default run before this change captured at
 *             exactly this threshold. MODERATE is therefore the position that
 *             reproduces what the product used to do.
 *   LOOSE     everything captured, INCLUDING the verifier's rejections, which
 *             render ghosted and labelled rather than hidden. This is the
 *             position that makes the pipeline auditable: "what did the machine
 *             decide not to show me, and why" becomes a question with an answer
 *             on screen.
 *
 * LEGACY AND DISCOVERY ROWS ALWAYS PASS. A row written before verdicts were
 * stored, or by the discovery fallback path (which has no per-candidate score
 * and produces no rejected candidates), carries a null verdict and a null score.
 * Every position treats null as "a flag that passes every threshold", so an old
 * library renders exactly as it did before this filter existed. Hiding somebody's
 * existing flags behind a new control they have never touched would be the one
 * unacceptable outcome here.
 */
export type FlagFilter = 'strict' | 'moderate' | 'loose';

export const FLAG_FILTERS: FlagFilter[] = ['strict', 'moderate', 'loose'];

/** Minimum NLI score a 'flag' row needs at each position. LOOSE has no floor. */
export const FLAG_FILTER_MIN_SCORE: Record<FlagFilter, number> = {
  strict: 0.9,
  moderate: 0.7,
  loose: 0,
};

export const FLAG_FILTER_LABEL: Record<FlagFilter, string> = {
  strict: 'Strict',
  moderate: 'Moderate',
  loose: 'Loose',
};

export const FLAG_FILTER_DESCRIPTION: Record<FlagFilter, string> = {
  strict: 'Only the strongest matches (score 0.90 and above).',
  moderate: 'The calibrated default: confirmed matches at 0.70 and above.',
  loose: 'Everything the analysis captured, including passages the verifier rejected (shown ghosted).',
};

/**
 * The caption shown on a ghosted row, in the verifier's own terms.
 *
 * It says what the verifier DECIDED, not that the row is unimportant: the
 * verifier's one question is "is the speaker asserting this claim, or reporting
 * / quoting / questioning / opposing it", and a 'skip' is the second answer.
 * That is the #1 correctness axis for this product — the operator's own
 * counter-apologetics commentary must never flag itself for quoting the thing it
 * criticizes — so the label names the distinction rather than hiding behind
 * "low confidence".
 */
export const VERIFIER_REJECTION_LABEL = 'verifier: reported/opposed, not asserted';

/**
 * The shape this filter needs from a section. Deliberately structural, so both
 * the section list and the timeline marker layer can filter the same way without
 * either importing the other's model.
 */
export interface FlagFilterable {
  /** 'flag' | 'skip', or null/undefined on legacy and discovery rows. */
  verdict?: 'flag' | 'skip' | null;
  /** 0-1, or null/undefined where there is no ranker score. */
  nliScore?: number | null;
}

/** True when this section should be visible at this filter position. */
export function passesFlagFilter(section: FlagFilterable, filter: FlagFilter): boolean {
  // LOOSE shows everything, rejections included — that is the whole point of it.
  if (filter === 'loose') return true;

  // Null verdict = legacy/discovery. Treated as an accepted flag.
  if ((section.verdict ?? 'flag') === 'skip') return false;

  // Null score = no ranker score to threshold on. Passes, for the same reason.
  const score = section.nliScore;
  if (score === null || score === undefined || !Number.isFinite(score)) return true;

  return score >= FLAG_FILTER_MIN_SCORE[filter];
}

/** True when this section should be rendered ghosted rather than solid. */
export function isGhosted(section: FlagFilterable): boolean {
  return section.verdict === 'skip';
}

/**
 * WHERE THE POSITION LIVES.
 *
 * With the filter, and nowhere else. There is no run-config control feeding it:
 * the 1-5 sensitivity slider was removed from all three run-config surfaces
 * when the dial stopped being a run input (operator, 2026-08-25: "not sure we
 * need the 1-5 run slider anymore after we've turned it into a filter"). So the
 * position is a VIEW PREFERENCE, and it persists the way this app's other view
 * preferences do — localStorage, read on construction, written on change, same
 * as the analysis panel's "follow cursor" toggle right next to it.
 *
 * FIRST USE IS MODERATE. That is the calibrated position: >= 0.7 is the
 * threshold that kept 100% of the non-marginal hand-audit ground truth on both
 * reference videos, and it is what a default run produced before any of this
 * changed. Somebody opening the editor for the first time sees what the product
 * has always shown them.
 *
 * `defaultGranularity` in app-config.json still exists and is NOT read here. It
 * survives for the DISCOVERY fallback flag path only — a machine with no NLI
 * worker environment, which asks one open-ended question per chapter and has no
 * scored candidate list to filter afterwards, so the setting is still a real run
 * input there. It is now config-file-only, with no UI in front of it.
 */
const FLAG_FILTER_STORAGE_KEY = 'briefcase-flag-filter';

export function loadFlagFilter(): FlagFilter {
  try {
    if (typeof localStorage === 'undefined') return 'moderate';
    const stored = localStorage.getItem(FLAG_FILTER_STORAGE_KEY);
    return FLAG_FILTERS.includes(stored as FlagFilter) ? (stored as FlagFilter) : 'moderate';
  } catch {
    // A blocked or full localStorage must never decide what flags a user sees.
    return 'moderate';
  }
}

export function saveFlagFilter(filter: FlagFilter): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(FLAG_FILTER_STORAGE_KEY, filter);
  } catch {
    // Persisting a view preference is best-effort; failing to is not an error
    // worth surfacing, and the filter still works for this session.
  }
}
