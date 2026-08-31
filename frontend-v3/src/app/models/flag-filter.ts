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
 * The analysis captures at its widest setting every time (NLI threshold 0.2,
 * rescue floor 0.15), asks the verifier about every candidate it captured, and
 * stores BOTH answers — accepted and rejected — with the ranker score behind
 * each one. So what a user sees is a pure function of stored data, and moving
 * this control is a client-side array filter: instant, free, reversible, and
 * incapable of losing a finding, because nothing was thrown away to make it.
 *
 * ── WHY THE POSITIONS CHANGED (operator, 2026-08-31) ────────────────────────
 *
 * The first version thresholded on the NLI score at every position: STRICT was
 * flag >= 0.9, MODERATE flag >= 0.7, LOOSE everything. Measured on four real
 * analyses, that produced 7 / 10 / 184 — two nearly identical positions and a
 * cliff — because the score is BIMODAL. It answers "is this passage on-topic
 * for this category", and among passages the verifier already accepted it sits
 * at the top of its range almost every time. Slicing accepted flags by it moved
 * three rows.
 *
 * Worse, it was slicing the wrong quantity. In this pipeline the ranker is a
 * CANDIDATE GENERATOR and the verifier is the JUDGMENT SEAT: the score says
 * "worth asking about", the verdict says "yes, the speaker is asserting this".
 * So the old MODERATE default was hiding rows the verifier had confirmed
 * because the ranker's topical score was low — 3 on one reference video, 5 on
 * another, including a conspiracy quote the verifier accepted at score 0.45.
 * Overruling the judgment seat with the candidate generator's confidence
 * inverts the architecture, and it hid real findings by default.
 *
 * So the ladder now moves along the axis that actually has structure — the
 * verdict — and uses the score only where it discriminates: ordering the
 * REJECTED candidates, where it spreads across the full range.
 *
 * THE THREE POSITIONS:
 *
 *   CONFIRMED  Every passage the verifier accepted. No score floor: if the
 *              verifier said the speaker is asserting it, it is a finding, and
 *              no position hides it. This is the default.
 *   REVIEW     Confirmed, plus the rejected candidates the ranker was most
 *              certain about topically (score >= NEAR_MISS_SCORE). These are
 *              exactly the passages where the verifier is most worth
 *              second-guessing: the topic match was unambiguous and the call
 *              turned on stance alone. Rejections render ghosted and labelled.
 *   ALL        Everything captured, down to the widest rescue floor.
 *
 * Measured tier sizes on four real analyses (confirmed / review / all):
 *   13 / 79 / 184 · 16 / 37 / 129 · 2 / 32 / 109 · 6 / 20 / 45
 * Each position is a superset of the one before it, and each adds a
 * meaningfully different KIND of row rather than a few more of the same kind.
 * The control shows live counts so the size of a position is never a surprise.
 *
 * LEGACY AND DISCOVERY ROWS ALWAYS PASS. A row written before verdicts were
 * stored, or by the discovery fallback path (which has no per-candidate score
 * and produces no rejected candidates), carries a null verdict and a null score.
 * Every position treats null as an accepted flag, so an old library renders
 * exactly as it did before this filter existed. Hiding somebody's existing flags
 * behind a new control they have never touched would be the one unacceptable
 * outcome here.
 */
export type FlagFilter = 'confirmed' | 'review' | 'all';

export const FLAG_FILTERS: FlagFilter[] = ['confirmed', 'review', 'all'];

/**
 * The score at or above which a REJECTED candidate is shown at REVIEW.
 *
 * 0.9 is where the ranker's bimodal distribution puts its high mode, so this
 * selects rejections whose topical match was not in doubt — the ones whose fate
 * was decided purely by the asserting-vs-reporting test, which is the judgment
 * a human is best placed to check. It is NEVER applied to accepted flags.
 */
export const NEAR_MISS_SCORE = 0.9;

export const FLAG_FILTER_LABEL: Record<FlagFilter, string> = {
  confirmed: 'Confirmed',
  review: 'Review',
  all: 'All',
};

export const FLAG_FILTER_DESCRIPTION: Record<FlagFilter, string> = {
  confirmed: 'Everything the verifier confirmed as asserted by the speaker.',
  review: 'Confirmed, plus rejected passages the ranker was most sure about — the verifier’s closest calls.',
  all: 'Every passage the analysis captured, including everything the verifier rejected.',
};

/**
 * The caption shown on a rejected row, in the verifier's own terms.
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
  // ALL shows everything, rejections included — that is the whole point of it.
  if (filter === 'all') return true;

  // Null verdict = legacy/discovery. Treated as an accepted flag.
  const verdict = section.verdict ?? 'flag';

  // An accepted flag is a finding at EVERY position. The score never overrules
  // the verifier — see the note at the top of this file.
  if (verdict === 'flag') return true;

  // Rejected: shown only at REVIEW, and only when the ranker was highly certain
  // the passage was on-topic, so the rejection turned on stance alone.
  if (filter !== 'review') return false;

  const score = section.nliScore;
  if (score === null || score === undefined || !Number.isFinite(score)) return false;

  return score >= NEAR_MISS_SCORE;
}

/** True when this section should be rendered as a verifier rejection. */
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
 * FIRST USE IS CONFIRMED: the verifier's own answer, nothing hidden and nothing
 * speculative added. A stored value from the previous three-position scheme
 * ('strict' | 'moderate' | 'loose') maps forward rather than being discarded, so
 * nobody's saved preference silently resets.
 *
 * `defaultGranularity` in app-config.json still exists and is NOT read here. It
 * survives for the DISCOVERY fallback flag path only — a machine with no NLI
 * worker environment, which asks one open-ended question per chapter and has no
 * scored candidate list to filter afterwards, so the setting is still a real run
 * input there. It is now config-file-only, with no UI in front of it.
 */
const FLAG_FILTER_STORAGE_KEY = 'briefcase-flag-filter';

/** Positions from the superseded scheme, mapped to their closest equivalent. */
const LEGACY_FILTER_ALIASES: Record<string, FlagFilter> = {
  strict: 'confirmed',
  moderate: 'confirmed',
  loose: 'all',
};

export function loadFlagFilter(): FlagFilter {
  try {
    if (typeof localStorage === 'undefined') return 'confirmed';
    const stored = localStorage.getItem(FLAG_FILTER_STORAGE_KEY);
    if (stored && FLAG_FILTERS.includes(stored as FlagFilter)) return stored as FlagFilter;
    if (stored && LEGACY_FILTER_ALIASES[stored]) return LEGACY_FILTER_ALIASES[stored];
    return 'confirmed';
  } catch {
    // A blocked or full localStorage must never decide what flags a user sees.
    return 'confirmed';
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
