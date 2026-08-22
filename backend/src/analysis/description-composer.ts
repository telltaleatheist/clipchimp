/**
 * YouTube description composition — the CODE half of the description pipeline.
 *
 * Implements docs/youtube-metadata-spec.md §2-§4 and §6.1/§6.3: the model writes
 * exactly two things (a hook line and a body paragraph); everything else about
 * the description is deterministic and testable here — the chapters block, the
 * hashtag line, the assembly order, and the register check that decides whether
 * a generated line earns one re-ask.
 *
 * Nothing in this file talks to a model. That is the point: the pieces a model
 * would only get wrong (timestamps, dedupe, ordering, character caps) are the
 * pieces we never ask it for.
 */

// =============================================================================
// TIMESTAMPS
// =============================================================================

/** Parse the pipeline's internal `HH:MM:SS` display time back to seconds. */
export function parseDisplayTimeToSeconds(timeStr: string): number {
  const parts = String(timeStr || '')
    .split(':')
    .map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

/**
 * Timestamp format for a YOUTUBE chapter line — deliberately NOT the app's
 * `HH:MM:SS` display convention.
 *
 * This string is outward-facing: it is pasted into a YouTube description, where
 * the house format is `MM:SS` below an hour and `H:MM:SS` at or above one, and
 * where the first chapter must read `00:00` for chapters to activate at all.
 * Briefcase's internal `HH:MM:SS` (always-padded hours) is a UI convention for
 * the app's own timeline and has no business in a published description.
 */
export function formatYouTubeTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = minutes.toString().padStart(2, '0');
  const ss = secs.toString().padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export interface ComposerChapter {
  start_time: string;
  title: string;
}

/**
 * The `MM:SS Title` lines of the chapters block, or [] when there is no block
 * to build.
 *
 * Two rules, both from the spec:
 *  - fewer than 2 chapters is not a chapters block (YouTube ignores it and it
 *    reads as noise), so it is omitted entirely;
 *  - the first line is forced to `00:00`. YouTube silently disables chapters
 *    for the whole video when the first timestamp is not zero, and the
 *    pipeline's chapter 1 always starts at 0 anyway — forcing it means a
 *    rounding artifact can never cost the video its key-moments surfacing.
 */
export function buildChapterLines(chapters: ComposerChapter[]): string[] {
  const usable = (chapters || []).filter((ch) => ch && ch.title && ch.title.trim());
  if (usable.length < 2) return [];

  return usable.map((ch, index) => {
    const seconds = index === 0 ? 0 : parseDisplayTimeToSeconds(ch.start_time);
    return `${formatYouTubeTimestamp(seconds)} ${ch.title.trim()}`;
  });
}

// =============================================================================
// HASHTAGS (code-owned — §3 ownership ruling, §6.3 selection logic)
// =============================================================================

/** Words too common to count as a title collision when deduping hashtags. */
const HASHTAG_STOPWORDS = new Set([
  'a', 'an', 'and', 'the', 'of', 'on', 'in', 'to', 'for', 'with', 'at', 'by',
  'from', 'is', 'it', 'as', 'or', 'that', 'this', 'his', 'her', 'their',
]);

function titleWordSet(videoTitle: string): Set<string> {
  return new Set(
    String(videoTitle || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((w) => w && !HASHTAG_STOPWORDS.has(w)),
  );
}

/** "Election Fraud" -> "ElectionFraud"; "Luke 19:13" -> "Luke1913". */
function camelCase(phrase: string): string {
  return String(phrase || '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

/**
 * 3-5 hashtags from the tags step's topics + people.
 *
 * Per §6.3: mix 1-2 entity hashtags with topic hashtags, camel-case the
 * multiword ones, and drop any candidate whose content words are ALL already in
 * the video title — a hashtag that only repeats the title catches nothing new.
 * Model-emitted hashtags are never accepted; this is the only producer.
 */
export function buildHashtags(
  topics: string[] = [],
  people: string[] = [],
  videoTitle = '',
  max = 5,
): string[] {
  const titleWords = titleWordSet(videoTitle);
  const seen = new Set<string>();
  const out: string[] = [];

  const consider = (phrase: string): void => {
    if (out.length >= max) return;
    const tag = camelCase(phrase);
    if (tag.length < 3 || tag.length > 30) return;
    if (seen.has(tag.toLowerCase())) return;

    const contentWords = String(phrase)
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((w) => w && !HASHTAG_STOPWORDS.has(w));
    if (contentWords.length === 0) return;
    // Already fully present in the title -> adds no new surface.
    if (contentWords.every((w) => titleWords.has(w))) return;

    seen.add(tag.toLowerCase());
    out.push(`#${tag}`);
  };

  // Headline entities first (up to 2), then topics, then any remaining people.
  (people || []).slice(0, 2).forEach(consider);
  (topics || []).forEach(consider);
  (people || []).slice(2).forEach(consider);

  return out;
}

// =============================================================================
// ASSEMBLY (§3 template, operator-ruled order)
// =============================================================================

export interface ComposeDescriptionInput {
  hook: string;
  chapterLines: string[];
  body: string;
  hashtags: string[];
}

/**
 * Assemble the final description string.
 *
 * Ruled order (§3): hook, chapters, body, hashtags. There is no boilerplate /
 * links / CTA section — Briefcase has no per-channel config that owns one, and
 * the spec's ruling is that the section is config-owned or absent, never
 * invented. Every section is omitted cleanly when empty, so a missing chapters
 * block cannot leave a stray heading or a double blank line behind.
 */
export function composeDescription(input: ComposeDescriptionInput): string {
  const blocks: string[] = [];

  const hook = (input.hook || '').trim();
  if (hook) blocks.push(hook);

  if (input.chapterLines && input.chapterLines.length > 0) {
    blocks.push(['Chapters:', ...input.chapterLines].join('\n'));
  }

  const body = (input.body || '').trim();
  if (body) blocks.push(body);

  if (input.hashtags && input.hashtags.length > 0) {
    blocks.push(input.hashtags.join(' '));
  }

  return blocks.join('\n\n');
}

/** Hard cap for the hook, applied in code — never trust a display limit to a model. */
export const HOOK_MAX_CHARS = 150;

/**
 * Last-resort trim to `max` characters at a word boundary.
 *
 * Only called after the model has had its re-ask: the schema's maxLength and the
 * prompt are the real enforcement, and a truncated sentence is a worse hook than
 * a slightly-clumsy complete one.
 */
export function truncateAtWordBoundary(text: string, max: number): string {
  const trimmed = (text || '').trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  const kept = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return kept.replace(/[\s,;:.\-–—]+$/, '').trim();
}

// =============================================================================
// NARRATED-ACTOR DETECTOR (§6.1 metric 3)
// =============================================================================

/**
 * Nouns that name an INVENTED ACTOR — someone who exists only as the narrator of
 * the video rather than as a subject inside it.
 *
 * The failure this guards against is narration-as-subject: text whose
 * grammatical subject is the act of covering the content instead of the content.
 * Banning the single phrase "the speaker" is too narrow — the measured failures
 * were entity-rich ("Pastor Brad Wells shares…"), so the check is structural.
 *
 * THIS LIST IS CODE-ONLY. Per the spec's prompt-hygiene ruling, no wrong form
 * ever appears in anything a model reads: prompts carry correct examples only,
 * because a model shown the bad form sometimes reproduces it.
 */
const ACTOR_NOUNS = [
  'speaker', 'speakers', 'host', 'hosts', 'narrator', 'video', 'clip', 'footage',
  'panel', 'panelist', 'panelists', 'pastor', 'preacher', 'minister', 'priest',
  'youtuber', 'vlogger', 'streamer', 'podcaster', 'channel', 'creator',
  'commentator', 'pundit', 'presenter', 'anchor', 'interviewer', 'guest',
  'guests', 'author', 'show', 'episode', 'segment', 'broadcast',
];

/** Pronouns count as invented actors only where no antecedent can exist yet. */
const ACTOR_PRONOUNS = ['he', 'she', 'they', 'it'];

/**
 * Verbs that narrate the act of covering content rather than assert content.
 *
 * Deliberately EXCLUDES "reports (on)": "Paul Petit reports on Trump's refusal to
 * extend the Iran ceasefire MOU" is the spec's own worked example of GOOD body
 * prose — a named person as the subject of what they actually did. The pattern
 * only fires when a narration verb is paired with an ACTOR NOUN subject, which
 * is why a proper name plus a verb never trips it.
 */
const NARRATION_VERBS = [
  'discusses', 'discuss', 'covers', 'cover', 'critiques', 'critique',
  'reacts', 'react', 'debunks', 'debunk', 'explains', 'explain',
  'describes', 'describe', 'shares', 'share', 'talks', 'talk',
  'argues', 'argue', 'examines', 'examine', 'analyzes', 'analyze',
  'reviews', 'review', 'addresses', 'address', 'explores', 'explore',
  'recounts', 'recount', 'mentions', 'mention', 'unpacks', 'unpack',
  'highlights', 'highlight', 'summarizes', 'summarize', 'questions',
  'debates', 'debate', 'weighs', 'dives', 'walks', 'breaks',
];

const ACTOR_ALTERNATION = ACTOR_NOUNS.join('|');
const VERB_ALTERNATION = NARRATION_VERBS.join('|');

/**
 * Article + actor noun in subject position, plus whatever word follows (the
 * caller checks that word is verb-shaped).
 *
 * No proper-name continuation here on purpose — "the pastor Brad Wells says…" is
 * caught by the actor-noun + narration-verb rule below, and trying to match
 * capitalised name words under the /i flag would match ANY word and silently
 * neuter this rule.
 */
const SUBJECT_ACTOR_RE = new RegExp(
  `^(?:the|a|an)\\s+(${ACTOR_ALTERNATION})\\s+([\\w'’-]+)`,
  'i',
);

/** Bare pronoun subject, first sentence only. */
const SUBJECT_PRONOUN_RE = new RegExp(
  `^(${ACTOR_PRONOUNS.join('|')})\\s+([\\w'’-]+)`,
  'i',
);

/**
 * Actor noun anywhere in the subject phrase, followed by a narration verb.
 * The negative lookahead excludes possessives: "the panel's debate over X" is
 * a noun phrase — the target register — while "the panel debates X" narrates.
 * Without it, the detector flagged the exact form the register ruling asks for
 * (observed live: "panel's debate" tripped actor-narration-verb).
 */
const ACTOR_PLUS_VERB_RE = new RegExp(
  `\\b(${ACTOR_ALTERNATION})\\b(?!['’]s\\b)[^.]{0,40}?\\b(${VERB_ALTERNATION})\\b`,
  'i',
);

/**
 * Does this token look like a finite verb rather than the continuation of a noun
 * phrase? Keeps "The man behind the lawsuit" (a legitimate topic phrase) from
 * reading as "The man <verbs>".
 */
function looksLikeVerb(token: string): boolean {
  const word = (token || '').toLowerCase();
  if (!word) return false;
  if (['is', 'are', 'was', 'were', 'has', 'have', 'had', 'does', 'do', 'did', 'will', 'can', 'says', 'said'].includes(word)) {
    return true;
  }
  return /(?:es|s|ed)$/.test(word) && word.length > 3;
}

export interface NarratedActorFinding {
  flagged: boolean;
  /** Which structural rule fired: subject-position actor, or actor + narration verb. */
  rule?: 'subject-actor' | 'actor-narration-verb';
  /** The offending fragment, for the log line only — never fed back to a model. */
  match?: string;
}

/**
 * Deterministic narrated-actor check (spec §6.1, metric 3).
 *
 * Runs on VIEWER-FACING text only — the hook and the body. Internal per-chapter
 * summaries are allowed (and expected) to narrate: that register is correct for
 * data that feeds later calls, it simply must never leak into published fields.
 *
 * Two structural rules, evaluated per sentence over the sentence's FIRST CLAUSE
 * (the spec scopes the check to the grammatical subject, so a mid-sentence
 * mention like "…, before the panel turns to…" is not a subject and is left
 * alone):
 *
 *   A. subject position is an article + actor noun (or, in the first sentence
 *      only, a bare pronoun) followed by something verb-shaped. A possessive
 *      ("the panel's debate over…") is a noun phrase, i.e. the target form, and
 *      does not fire.
 *   B. an actor noun appears in the subject phrase and is followed by a
 *      narration verb — the entity-rich variant, where a real person's name is
 *      wrapped in a role noun and made the subject of "covering" something.
 *
 * A detection is a declared warning worth exactly one re-ask; it is never a
 * blocking check and never triggers a silent rewrite.
 */
export function detectNarratedActor(text: string): NarratedActorFinding {
  const input = (text || '').trim();
  if (!input) return { flagged: false };

  const sentences = input
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (let i = 0; i < sentences.length; i++) {
    // First clause only — that is where the grammatical subject lives.
    const clause = sentences[i].split(/[,;:—–]/)[0].trim();
    if (!clause) continue;

    // A possessive ("the panel's debate over …") cannot match: the pattern
    // requires whitespace after the actor noun, and "'s" is not whitespace. That
    // is deliberate — the possessive form is a noun phrase, i.e. the target.
    const actorMatch = SUBJECT_ACTOR_RE.exec(clause);
    if (actorMatch && looksLikeVerb(actorMatch[2])) {
      return { flagged: true, rule: 'subject-actor', match: actorMatch[0] };
    }

    if (i === 0) {
      const pronounMatch = SUBJECT_PRONOUN_RE.exec(clause);
      if (pronounMatch && looksLikeVerb(pronounMatch[2])) {
        return { flagged: true, rule: 'subject-actor', match: pronounMatch[0] };
      }
    }

    const pairMatch = ACTOR_PLUS_VERB_RE.exec(clause);
    if (pairMatch) {
      return { flagged: true, rule: 'actor-narration-verb', match: pairMatch[0] };
    }
  }

  return { flagged: false };
}
