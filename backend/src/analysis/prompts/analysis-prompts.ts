/**
 * AI Analysis Prompts and Categories for Briefcase Video Analysis
 *
 * This file contains all prompts and default categories used by the AI analysis system.
 * Edit this file to modify prompts or default categories.
 *
 * Categories are saved to user's config file on first run and can be edited in Settings.
 * Prompts are code-only and require rebuilding to change.
 */

// =============================================================================
// TYPES
// =============================================================================

export interface AnalysisCategory {
  name: string;
  description?: string;
  enabled?: boolean;
}

// =============================================================================
// DEFAULT ANALYSIS CATEGORIES
// =============================================================================
// These are written to the user's config file on first run.
// Users can customize them in Settings > Analysis Categories.

export const DEFAULT_CATEGORIES: AnalysisCategory[] = [
  {
    name: 'hate',
    description: 'ANY use of slurs (f-slur, n-word, etc.) - flag even if "quoted", attributed to others, or presented as etymology/translation. Discrimination, dehumanization, or hostility toward minority groups (LGBTQ+, racial, religious, ethnic, immigrants). Anti-gay or anti-minority rhetoric regardless of "biblical", "historical", or "educational" framing.',
  },
  {
    name: 'conspiracy',
    description: 'Content that PROMOTES conspiracy theories as true (election fraud, deep state, QAnon, globalists, voter fraud, "stolen election", New World Order, Illuminati, Freemasons, Soros conspiracies, alien/UFO claims presented as fact). NOTE: Do NOT flag content that REPORTS ON, ANALYZES, or DEBUNKS conspiracy theories - only flag content that promotes them as true.',
  },
  {
    name: 'false-prophecy',
    description: 'ANY claims of divine communication or prophecy (God speaking to them, prophetic declarations, divine revelations, "God told me", supernatural knowledge claims, prophecies about political/world events)',
  },
  {
    name: 'misinformation',
    description: 'Factually incorrect claims PROMOTED as true about science, medicine, history, language, or current events. Fabricated biblical scholarship, made-up Greek/Hebrew translations, invented etymology. Vaccine conspiracies, COVID denialism, climate denial. NOTE: Do NOT flag skeptical statements that QUESTION or DEBUNK false claims - only flag content that PROMOTES misinformation.',
  },
  {
    name: 'violence',
    description: 'Calls for violence, glorification of violence, citing biblical violence (temple cleansing, holy wars, etc.) as justification for modern aggression, revolutionary rhetoric, threats, Second Amendment intimidation, civil war talk.',
  },
  {
    name: 'christian-nationalism',
    description: 'Using Jesus or Christianity to justify political involvement/aggression, claims Christians should be political "like Jesus was", theocracy advocacy, anti-separation of church/state, demanding "biblical law"',
  },
  {
    name: 'prosperity-gospel',
    description: 'Religious leaders demanding money from followers, "seed faith" offerings, wealth justifications, private jets/luxury defense, "sow to receive" theology',
  },
  {
    name: 'extremism',
    description: 'Defense of oppression/genocide/slavery, white supremacy/nationalism, ethnic cleansing justifications, authoritarian/fascist advocacy, calls for execution/persecution of groups',
  },
  {
    name: 'political-violence',
    description: 'References to political violence events (Capitol riot, insurrections, political attacks), defending/downplaying political violence, false flag claims about violence',
  },
];

// =============================================================================
// VIDEO SUMMARY PROMPT
// =============================================================================
// Used to generate a 2-3 sentence overview of the video content
// This is called AFTER analysis is complete, using the analyzed sections

export const DEFAULT_DESCRIPTION_PROMPT = `Describe what is said in 2-3 sentences.{titleContext}

Sections:
{sectionsSummary}

Description:`;

export const VIDEO_SUMMARY_PROMPT = DEFAULT_DESCRIPTION_PROMPT;

// =============================================================================
// TAG EXTRACTION PROMPT
// =============================================================================
// Used to extract people names and topics from the video

export const DEFAULT_TAG_PROMPT = `Extract people and topics from this transcript.

Return JSON: {"people": ["Name"], "topics": ["Topic"]}

Rules:
- People: proper names only
- Topics: 3-8 themes, 1-3 words each
- Title case

Context: {sectionsContext}

Transcript: {excerpt}

JSON:`;

export const TAG_EXTRACTION_PROMPT = DEFAULT_TAG_PROMPT;

// =============================================================================
// SUGGESTED TITLE PROMPT
// =============================================================================
// Used to generate a suggested filename based on analysis results

export const DEFAULT_TITLE_PROMPT = `Generate a concise, descriptive filename for this video.

Current filename: {currentTitle}
Summary: {description}
People mentioned: {peopleTags}
Topics: {topicTags}

Transcript excerpt:
{transcriptExcerpt}

Rules:
- Lowercase, spaces allowed, max 80 chars
- Format: "[speaker name] - [key quote or action]" or "[speaker] on [topic] - [notable statement]"
- Lead with the main speaker's name if identifiable FROM THE TRANSCRIPT
- If speaker cannot be identified, use descriptive title without a name (e.g., "pastor claims voting democrat is sinful")
- NEVER use names from these examples as defaults - only use names actually found in the transcript
- Include the most notable/quotable phrase in the title
- Add source/show name at end in parentheses if known (e.g., "howard stern", "fox news")
- Be specific about what was SAID, not just the topic
- No dates, extensions, special chars
- Don't invent content not in transcript

Good examples (DO NOT copy these names - identify speakers from the actual transcript):
- "trump on howard stern - i walk into changing rooms because im the owner"
- "pastor claims democrats are demonic and voting for them is sinful"
- "lauren witzke - god must destroy civilization over trans healthcare"
- "fox news host defends border policy with dehumanizing rhetoric"

Output ONLY the filename, nothing else:`;

export const SUGGESTED_TITLE_PROMPT = DEFAULT_TITLE_PROMPT;

// =============================================================================
// QUOTE EXTRACTION PROMPT
// =============================================================================
// Used to extract specific quotes from flagged sections

export const DEFAULT_QUOTE_PROMPT = `Extract 2-4 notable quotes from this transcript.

Category: {category}
Description: {description}

Return JSON: {"quotes": [{"timestamp": "MM:SS", "text": "exact words", "significance": "why notable"}]}

Transcript:
{timestampedText}

JSON:`;

export const QUOTE_EXTRACTION_PROMPT = DEFAULT_QUOTE_PROMPT;


// =============================================================================
// TWO-PASS CHAPTER ANALYSIS PROMPTS
// =============================================================================

// -----------------------------------------------------------------------------
// PASS 1: Boundary Placement Prompt
// -----------------------------------------------------------------------------
// Pass 1 no longer asks a model WHERE the chapters are — that prompt is gone.
// Asking for "all the boundaries in this 15-minute chunk" reliably returned a
// PREFIX of them (1-3) and stopped, which is how a 27:00 ad break went missing
// on a 63-minute video. Boundaries are now SCORED from embedding cohesion
// (chapter-detection.service), and the model's only job is the one thing code
// cannot do: read the ~90 seconds around an already-chosen junction and say
// which sentence the new subject starts on.
//
// The model NEVER emits a timestamp. It quotes a verbatim sentence and
// findPhraseTimestamp maps that quote to seconds — an invented timestamp is a
// guess, a mapped quote is a measurement.

/**
 * Ask for the first sentence of the NEW subject inside one ~90s window.
 *
 * The "turn, not arrival" ordering is load-bearing: an earlier version of this
 * prompt that rejected the sentence which merely hints at what is coming placed
 * boundaries ~12s LATE, because the hint IS where a human puts the mark.
 */
export function buildBoundaryPlacementPrompt(
  windowText: string,
  videoTitle?: string,
): string {
  const titleContext = videoTitle ? `Video: ${videoTitle}\n` : '';

  return `Below is one stretch of a video transcript. Somewhere inside it the speaker moves from one subject to the next.
${titleContext}
TRANSCRIPT:
${windowText}

Find where the handover BEGINS — the first sentence a viewer would want to land on if they clicked a chapter marker here.

That is the sentence where the speaker TURNS AWAY from the old subject, which is usually a beat EARLIER than the sentence that first explains the new one. If the speaker says "anyway, let's talk about X" and then explains X three sentences later, the turn is "anyway, let's talk about X" — quote that, not the explanation. A viewer dropped at the explanation has already missed the start.

Prefer, in this order:
1. the sentence where the speaker announces, introduces or turns toward the new subject
2. the sentence where the speaker closes off the old subject, if the turn is not announced
3. the first sentence that is plainly about the new subject, if there is no turn at all

If the transcript contains MORE THAN ONE subject change, pick the one nearest the MIDDLE of the excerpt — the excerpt is centered on the boundary being placed, so changes near its edges belong to neighboring chapters, not this one.

Copy the sentence EXACTLY as it appears above, word for word, at least six words, no timestamps and no tidying up. That quote is what fixes the chapter's start time to the second, so a quote you reworded points at the wrong moment.

Output exactly this shape and nothing else:
{"quote": "<exact sentence from the transcript above>"}`;
}

// -----------------------------------------------------------------------------
// PASS 2: Chapter Analysis Prompt
// -----------------------------------------------------------------------------
// Full analysis prompt for a single chapter. Generates title, summary, and
// optionally detects category flags within the chapter's content.

/**
 * Coerce a stored sensitivity value onto the 1-3 scale.
 *
 * The dial used to be 1-10 (<=3 strict, <=7 balanced, >7 broad). A value above
 * 3 can only have come from that old scale, so it is mapped onto the bucket it
 * used to select. Values of 1-3 are ambiguous between the two scales and are
 * read as the NEW scale — the practical cost is that a legacy "3" (strict) now
 * reads as "aggressive", which surfaces extra flags for review rather than
 * silently hiding any. Erring toward recall is the right failure direction here.
 */
export function normalizeSensitivity(value: number | undefined | null): 1 | 2 | 3 {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 2;
  if (value > 3) return value <= 7 ? 2 : 3; // legacy 1-10 value
  const rounded = Math.round(value);
  return (rounded < 1 ? 1 : rounded > 3 ? 3 : rounded) as 1 | 2 | 3;
}

/**
 * Map the 1-3 sensitivity dial onto a flagging-threshold block.
 *
 * The PROMOTING-vs-DEBUNKING guard is deliberately NOT part of this scale — it
 * lives in the flag rulebook and applies identically at every level, because a
 * speaker who debunks a claim must never be flagged for it no matter how far up
 * the dial goes. What this scale moves is the confidence bar and how exhaustive
 * the model is told to be.
 *
 *   1 - strong matches only: explicit and unmistakable. Precision over recall.
 *   2 - balanced (default): clear matches plus reasonably likely ones.
 *   3 - aggressive: everything that could match, including implication and
 *       euphemism, with an explicit instruction to be exhaustive rather than
 *       selective. Recall over precision, on the assumption that a human
 *       reviews every flag and would rather discard a few than miss one.
 */
function getSensitivityLine(sensitivity: number): string {
  switch (normalizeSensitivity(sensitivity)) {
    case 1:
      return 'Sensitivity: strong matches only. Flag a quote only when it is an explicit, unmistakable instance of the category. When unsure, do not flag.';
    case 3:
      return `Sensitivity: AGGRESSIVE. Find everything that could match a category.
- Be exhaustive, not selective. List every qualifying quote in the chapter even if there are many; do not stop at the most obvious two or three, and never merge several separate moments into one flag.
- Include borderline cases, euphemism, coded language, and claims advanced by implication rather than stated outright. If a reviewer would plausibly want to see it, flag it.
- Recall matters more than precision at this setting. A human reviews every flag and can discard the weak ones; a missed quote is the expensive error.
- This does NOT relax the test above. The speaker must still be advancing the claim rather than debunking it, and the quote must still be verbatim.`;
    default:
      return 'Sensitivity: balanced. Flag clear matches and reasonably likely ones; skip vague or tangential cases.';
  }
}

/**
 * Chapter titling and summarization ONLY.
 *
 * Category flagging deliberately does NOT live here. It used to be a third
 * field on this prompt's JSON, which meant the model split its budget three
 * ways and treated `flags` as an afterthought — it reliably returned two or
 * three obvious quotes per chapter and stopped. Flagging now gets its own
 * dedicated call (buildFlagExtractionPrompt) whose only job is extraction.
 */
export function buildChapterAnalysisPrompt(
  videoTitle: string,
  chapterText: string,
  chapterNumber: number,
  previousChapterSummary?: string,
  customInstructions?: string,
): string {
  const prevContext = previousChapterSummary
    ? `Previous chapter: "${previousChapterSummary}"\n`
    : '';

  const customContext = customInstructions
    ? `Viewer context: ${customInstructions}\n`
    : '';

  return `Label chapter ${chapterNumber} of a video transcript. Output JSON only.
Video: ${videoTitle}
${prevContext}${customContext}
Produce:
- title: one sentence (max ~15 words) naming what this chapter is about.
- summary: 2-3 sentences on what the speaker actually says.

Output exactly this shape and nothing else:
{
  "title": "...",
  "summary": "..."
}

TRANSCRIPT:
${chapterText}`;
}

/**
 * Dedicated category-flag extraction for a single chapter.
 *
 * This is a separate call from chapter titling so the model's whole attention
 * goes to finding matches. The debunking-vs-promoting guard leads the prompt
 * because it is the #1 correctness axis for this counter-apologetics use case:
 * the operator's own commentary must never flag itself for quoting the thing
 * it is criticizing.
 */
export function buildFlagExtractionPrompt(
  videoTitle: string,
  chapterText: string,
  categories: AnalysisCategory[],
  chapterNumber: number,
  sensitivity?: number,
  customInstructions?: string,
): string {
  const enabledCategories = categories?.filter((c) => c.enabled !== false) || [];

  const categoryList = enabledCategories
    .map((c) => `- ${c.name}: ${c.description}`)
    .join('\n');

  const firstCategory = enabledCategories[0]?.name ?? 'hate';

  const customContext = customInstructions
    ? `Viewer context: ${customInstructions}\n`
    : '';

  const sensitivityLine = getSensitivityLine(sensitivity ?? 2);

  return `Find every quote in chapter ${chapterNumber} of this transcript that matches one of the categories below. Output JSON only.
Video: ${videoTitle}
${customContext}
Output exactly this shape and nothing else:
{
  "flags": [{"category": "${firstCategory}", "description": "why the quote matches", "quote": "exact words from the transcript"}]
}
Use {"flags": []} when nothing matches.

THE TEST FOR EVERY FLAG — is the speaker SAYING THIS IS TRUE, or SAYING IT IS FALSE?
Flag ONLY when the speaker asserts, promotes, defends, or urges the claim.
Never flag a speaker who debunks, fact-checks, doubts, mocks, or reports a claim — even when they repeat the claim's words in order to knock it down. Skepticism ("that's a hoax", "there's no evidence", "the courts threw it out") is never a flag.
Judge the whole chapter's stance, not one sentence: if the speaker's point is that the claim is FALSE, flag nothing from it, including the sentence where they state the claim they are about to refute.

Worked examples:
- "The election was stolen, they cheated and everyone knows it." -> FLAG {conspiracy} (asserts it as true)
- "People keep claiming the election was stolen, but every court threw it out for lack of evidence." -> NO FLAG (refutes it)

CATEGORIES:
${categoryList}

Flagging rules:
- quote = exact words copied from the TRANSCRIPT. Never paraphrase, translate, or invent one.
- One quote, one flag, one category. Choose the single best fit; never merge two names (not "hate-conspiracy"). If nothing fits but it clearly qualifies, coin a new lowercase-dashed name.
- description = one sentence on why it matches, and it must describe the speaker ENDORSING the claim.

${sensitivityLine}

TRANSCRIPT:
${chapterText}`;
}

/**
 * Verify ONE ranked candidate: does the marked sentence ASSERT the category's
 * proposition, or merely report/question/argue against it?
 *
 * This is the second half of the measured flag pipeline (see
 * nli-ranker.service.ts). The NLI ranker cannot tell stance apart — "these
 * candidates are communists" and "Republicans have been eager to paint them as
 * communists" both score ~0.98 on the same hypothesis — so every candidate it
 * produces gets exactly one question asked about it here.
 *
 * WHAT THIS PROMPT DELIBERATELY DOES NOT CONTAIN, per the hygiene ruling in
 * docs/youtube-metadata-spec.md §6.1: no incorrect examples, no ban lists.
 * Both verdicts are DEFINED positively — what earns "flag", what earns "skip" —
 * rather than illustrated with a wrong answer the model might copy.
 *
 * It keeps the spirit of buildFlagExtractionPrompt's promoting-vs-debunking
 * guard, which is the #1 correctness axis for this counter-apologetics use case
 * (the operator's own commentary must never flag itself for quoting the thing
 * it criticizes) — but scoped to ONE sentence with its neighbours as context,
 * instead of a whole chapter's stance.
 */
export function buildFlagVerificationPrompt(
  candidateText: string,
  contextBefore: string[],
  contextAfter: string[],
  categoryName: string,
  stanceProposition: string,
): string {
  const lines = [
    ...contextBefore.map((t) => `    ${t}`),
    `>>> ${candidateText}`,
    ...contextAfter.map((t) => `    ${t}`),
  ].join('\n');

  return `Transcript excerpt. Judge ONLY the line marked >>>; the other lines are context.

${lines}

CLAIM (${categoryName}): ${stanceProposition}

Question: in the line marked >>>, is the speaker asserting or promoting that claim as their own position?
Answer "flag" if the speaker asserts it, endorses it, or repeats it approvingly as true.
Answer "skip" if the speaker is reporting that other people make that claim, quoting it neutrally, asking about it, arguing against it, or if the line does not make that claim at all.

Respond with JSON only: {"verdict":"flag"} or {"verdict":"skip"}`;
}

// -----------------------------------------------------------------------------
// Metadata from Chapters Prompts
// -----------------------------------------------------------------------------

/**
 * PROMPT-HYGIENE RULING (docs/youtube-metadata-spec.md §6.1, operator,
 * 2026-08-22) — binding on everything in this section:
 *
 *   Prompts carry CORRECT examples only. No incorrect examples, no ban lists,
 *   ever. A model shown the bad form sometimes reproduces it, so the wrong forms
 *   live exclusively in code (the narrated-actor detector in
 *   description-composer.ts) and in the spec's own prose — never in anything a
 *   model reads. Re-asks follow the same rule: restate the positive instruction,
 *   never echo the rejected output or describe what was wrong with it.
 *
 * The register instruction below is therefore phrased as grammar to USE, not
 * grammar to avoid.
 */

/**
 * The hook line: the first ~150 characters of the description, which is the
 * search-results snippet and everything a mobile viewer sees above the fold.
 * Schema-constrained ({"hook": string}) on Ollama — see spec §5.
 */
export const HOOK_FROM_CHAPTERS_PROMPT = `Write the opening line of the YouTube description for this video. Output JSON only.

One sentence, 150 characters maximum. Open with the exact phrase a viewer would type into search, at the very front of the line. Make it a precise promise of what the video actually shows. Include the specific people, places, claims and events when they are the draw.

Write about the topics and the named people directly, in topic form — bare noun phrases or gerunds as sentence subjects.

Lines in this style:
- "Gene Bailey's chapter on Christian nationalist action and the David and Goliath framing"
- "Debunking Gene Bailey's misreading of Luke 19:13 and his call to occupy territory"
- "Kent Christmas's 2021 death-angel prophecy"

Video: {videoTitle}
Chapter titles:
{chapterTitles}
Topics: {topics}

Output exactly this shape and nothing else:
{"hook": "your one sentence here"}`;

/**
 * The body paragraph: 150-300 words woven from ALL chapter summaries. The
 * summaries narrate internally ("the speaker argues…") and that is correct for
 * internal data — the register instruction here is what keeps that register from
 * reaching the published field. Schema-constrained ({"body": string}) on Ollama.
 */
export const BODY_FROM_CHAPTERS_PROMPT = `Write the body paragraph of the YouTube description for this video. Output JSON only.

One paragraph, between 150 and 300 words. Weave the chapters into a single continuous paragraph covering what happens and who says what. Name the real people, places, claims and events — every specific name is a search a viewer might run.

Write in topic form throughout — bare noun phrases or gerunds as sentence subjects. Keep every real name, as possessives and objects: "Trump's refusal", "Paul Petit's report on the ceasefire", "Gene Bailey's misreading of Luke 19:13". The whole paragraph reads like the example lines below, only longer.

Phrasing in this style:
- "Debate about Trump's refusal to extend the Iran ceasefire MOU and rising tensions in the Strait of Hormuz"
- "Gene Bailey's chapter on Christian nationalist action and the David and Goliath framing"
- "Debunking Gene Bailey's misreading of Luke 19:13 and his call to occupy territory"
- "Kent Christmas's 2021 death-angel prophecy and the fallout among charismatic prophets"

Video: {videoTitle}
People in this video: {people}
Chapters:
{chapterSummaries}

Output exactly this shape and nothing else:
{"body": "your paragraph here"}`;

/**
 * Appended verbatim for the ONE re-ask the narrated-actor detector is allowed to
 * trigger. It restates the positive instruction and shows correct forms again;
 * it does not quote, echo, paraphrase or characterise the rejected output, per
 * the hygiene ruling above.
 */
export const REGISTER_RESTATEMENT = `
Write in topic form throughout — bare noun phrases or gerunds as sentence subjects. Keep every real name, as possessives and objects.

Phrasing in this style:
- "Kent Christmas's 2021 death-angel prophecy"
- "Debate about Trump's refusal to extend the Iran ceasefire MOU"
- "Debunking Gene Bailey's misreading of Luke 19:13 and his call to occupy territory"`;

export const TAGS_FROM_CHAPTERS_PROMPT = `List the people and topics in these video chapters. Output JSON only.
- people: proper names of people mentioned in the chapters, Title Case.
- topics: 3-8 subjects, 1-3 words each, Title Case.

Output exactly this shape and nothing else:
{"people": ["Jane Doe"], "topics": ["Election Fraud", "Immigration"]}

Chapters:
{chaptersList}`;

export const TITLE_FROM_CHAPTERS_PROMPT = `Write a filename describing this video, from its chapters. Output only the filename.

Chapters:
{chaptersList}
Current filename (reference only): {currentTitle}

Rules:
- lowercase; separate words with spaces (not hyphens or underscores); max 80 chars; no dates, file extension, parentheses, or special characters
- if the chapters name the main speaker, lead with them: "speaker name - the striking thing they said"
- if no speaker is identifiable, describe what was said: "pastor claims voting democrat is sinful"
- capture the single most notable or quotable point, using a short verbatim phrase when one stands out
- use only names and facts that appear in these chapters

The two lines below show the SHAPE only — do not reuse their names or wording, take everything from the chapters above:
- "<speaker> - <their most striking quote>"
- "<role> claims <specific claim>"

Filename:`;

export const TITLE_FROM_WEBPAGE_PROMPT = `Write a filename for this saved webpage from its content. Output only the filename.

Current filename (reference only): {currentTitle}
Page content:
{pageText}

Rules:
- lowercase; separate words with spaces (not hyphens or underscores); max 80 chars; no dates, file extension, parentheses, or special characters
- if a person or source is clearly the subject, lead with them; otherwise use a specific topical title, e.g. "senate passes surveillance bill extending section 702"
- lead with the single most notable point; use only what appears in the content

The two lines below show the SHAPE only — do not reuse their names or wording:
- "<source> - <specific development>"
- "<person> on <topic>"

Filename:`;

// =============================================================================
// DEFAULT PROMPTS EXPORT
// =============================================================================
// All default prompts in one object for easy access by config system

export const DEFAULT_PROMPTS = {
  description: DEFAULT_DESCRIPTION_PROMPT,
  title: DEFAULT_TITLE_PROMPT,
  tags: DEFAULT_TAG_PROMPT,
  quotes: DEFAULT_QUOTE_PROMPT,
};

// =============================================================================
// PROMPT INTERPOLATION HELPER
// =============================================================================
// Replaces {placeholder} tokens in prompt templates with actual values

export function interpolatePrompt(
  template: string,
  values: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }
  return result;
}
