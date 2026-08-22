# YouTube Description & Tags Generation — Portable Spec (small-model tier)

How to generate YouTube-SEO-optimized descriptions and tags from an analyzed
video using small local models, cheaply and automatically. Written for Content
Studio first; Briefcase adopts the description portion later. Companion to
`chapter-pipeline-handoff.md` (same repo) — this spec assumes chapters with
timestamps and per-chapter summaries already exist, and reuses its measured
model guidance.

Status: design + measured model facts. The template and tier mapping are
settled; the two model prompts need one calibration pass against real videos.

---

## 1. What actually moves YouTube search (leverage order)

1. **First ~150 characters of the description** — the search-results snippet
   and above-the-fold on mobile. Needs the exact phrase a searcher would type,
   front-loaded, phrased as a hook.
2. **A 150-300 word body that names real things.** Long-tail wins come from
   specificity: actual people, places, claims, events. "Panel discusses
   politics" is SEO-dead; the names catch every long-tail query containing
   them. YouTube already has the transcript via auto-captions — the
   description concentrates and confirms the signal.
3. **Chapters block with timestamps** (must start at 00:00). Unlocks "key
   moments" in YouTube and Google search; chapter titles are indexed. The
   chaptering pipeline already produces this to the second.
4. **3-5 hashtags** (first 3 display above the title when the title has none).
5. **Tags** — near-deprecated (YouTube's own docs: "minimal role"; mainly
   misspellings/variants). Generate them because they're free, not because
   they matter.

Honest framing: description SEO is third-order leverage — CTR (title/
thumbnail) and watch time dominate ranking. This layer is worth automating
precisely because it can be nearly free; it is never worth a big model's
judgment budget.

## 2. Decomposition — who does what

The key design fact: **none of this needs to read the raw transcript.** Every
input is already extracted or summarized upstream (chapter summaries, entity
lists, key phrases). That makes the whole layer mechanical in the sense of the
chaptering handoff's trap #3 — safe to run schema-constrained on a small
model, which is also what makes a small model viable at all.

| Piece | Engine | Why |
|---|---|---|
| Chapters block | code | already produced by the chaptering pipeline; format `MM:SS Title` per line, first line `00:00` |
| Entity list (people/orgs/places) | NER model (~100M, BERT-class) | deterministic extraction beats an LLM remembering to mention names; also feeds tags and Whisper `initial_prompt` seeding |
| Content source for extraction | the app's content-source resolution | run NER/key-phrase extraction on the app's CONTENT text (in Content Studio: `contentTextOf(item)` — the ad-free editor transcript when a link exists, the final export's transcript otherwise; linking is optional, so never assume the ad-free source). Chapters/timestamps always come from the final export |
| Key phrases | embedding ranking (KeyBERT-style, reuse nomic-embed-text) | extract candidate noun phrases from transcript, embed candidates + document, rank by cosine; zero generation |
| Hook line (≤150 chars) | small LLM, schema-constrained | the one genuinely compositional piece; inputs: video title, top key phrases, chapter titles |
| Body paragraph (150-300 words) | small LLM, schema-constrained | weave chapter summaries + entity list into prose; format transform over clean structured input |
| Hashtags | code | top 3-5 key phrases, camel-cased, deduped against title words |
| Tags | code (+ optional tiny-model variant expansion) | rules in §4 |
| Assembly | code | template in §3; deterministic, testable |

## 3. Description template

```
{hook_line}                                   <- ≤150 chars, primary phrase front-loaded

Chapters:
00:00 {chapter 1 title}
{MM:SS} {chapter 2 title}
...

{body_paragraph}                              <- 150-300 words, entities woven in

{#hashtag1} {#hashtag2} {#hashtag3}

{channel boilerplate / links / CTA}
```

Order is an operator ruling (2026-08-22): hook leads so the search snippet
does its job; chapters follow; body under the chapters; hashtags before the
link block.

Ownership (one owner per element, decided here so no app double-generates):

- **Hashtag line: code-owned.** Built from top key phrases + entities
  (camel-cased, deduped against title words), never emitted by the
  description model. Rationale: deterministic, testable, and identical in an
  app with no trained adapter. Content Studio migrates off its
  model-emits-final-line convention when it adopts this spec.
- **Boilerplate/links/CTA: per-channel config is the target owner.** Interim:
  Content Studio's marker-based positioning (the composer detects the link
  block by marker and inserts hashtags above it) is a valid implementation
  while existing report texts carry embedded boilerplate; new implementations
  should start config-owned.

Placement rules (per operator direction, 2026-08-22):

- When chapters exist, the description is generated FROM the chapters and the
  body sits as a single paragraph — under the chapters block when the user
  includes chapters in the description, standing alone when they disable that
  (Content Studio: the `chaptersInDescription` checkbox; the composed/plain
  split already exists at one merge point).
- When there are no chapters (text-only subjects with no video), description
  generation from the subject line is a separate legacy path and stays out of
  this spec's scope.

## 4. Tags rules (code)

- Order most-specific → most-general; the exact primary phrase first.
- Include: primary phrase, entity names (people first), key phrases, common
  misspellings of distinctive names, 1-2 broad category terms, channel/brand
  tag.
- Cap ~400 characters total (hard API limit 500 including commas); stop
  adding, never truncate mid-tag.
- Variant/misspelling expansion may be a one-shot small-model call, or a
  static rules table; marginal either way because tags are marginal.

## 5. Model guidance (measured, from the chaptering work — same machine class)

- **Schema-constrain both LLM calls** (Ollama `format` accepts a full JSON
  Schema). On mechanical tasks this is pure win: it suppressed small-model
  over-reasoning that otherwise burned entire token budgets (a 9b once spent
  7,369 tokens writing a filename; an unconstrained 4b burned 8,192 and never
  answered). Metadata-from-summaries is mechanical — the judgment already
  happened upstream in chapter summarization.
- **Do NOT reuse this pattern for judgment tasks** (content flagging, chapter
  summarization): measured A/B showed constrained = 5.5x faster but recall
  7.3→5.7/11 and false positives 0.7→3.0 — the suppressed reasoning was doing
  real work there. See chaptering handoff traps #2-3 for the full mechanics,
  including the answer-arrives-in-`thinking` trap you must handle.
- **Candidate models**: qwen3.5:4b is the measured floor for constrained
  mechanical work (validated on boundary placement: 10/10, ~1.2s/call);
  qwen3.5:2b failed instruction-following even constrained (echoed the task
  back as JSON) — do not assume it works here without testing. 9b is the
  step-up if 4b prose quality disappoints.
- **Schemas**: `{"hook": string(maxLength 150)}` and `{"body": string}`.
  Enforce the 150-char cap in code too — schema maxLength constrains decoding
  but verify server-side behavior; never trust a model with a hard display
  limit.
- **Cloud fallback**: both calls are tiny (inputs are summaries); routing them
  to the app's main cloud model when no local Ollama exists costs fractions
  of a cent. Same auto-detect pattern as the chaptering handoff §6
  (probe-and-prefer, explicit config wins).
- **Temperature**: hook 0.4 (needs a little life), body 0.2. Never send
  sampling params to Claude/OpenAI cloud APIs (400s on newer models).
- **Prose register (operator rule, 2026-08-22)**: generated prose must never
  say "the speaker …" (or "the host", "the video"). Write hook and body in
  topic/noun-phrase register from the viewer's perspective — phrase it as a
  POSITIVE grammar instruction in the prompt ("write about the topics and the
  named people directly"), not as an output filter.
- **Current baseline for comparison**: Content Studio's routed per-field path
  defaults these fields to qwen3.5:9b unconstrained; this spec's proposal is
  stepping the two mechanical calls down to schema-constrained 4b. The A/B in
  §6 is against that 9b baseline there, and against qwen3.8:27b in Briefcase.

## 6. Quality playbook (the reasoning behind the template)

Everything here came out of the design discussion with the operator; the
operator's taste is the spec.

### 6.1 Chapter-title specificity — the bar and how to hit it

The bar: **never generic.** "Man yells about conspiracies" fails; "Kent
Christmas's 2021 death-angel prophecy" passes. Specific about what is
happening, preferably with proper nouns. For SEO this is what makes chapter
titles catch long-tail queries and key-moment surfacing; for library search
it is what makes chapters findable.

Levers, in measured order of impact:

1. **Summarize from RAW chapter transcript, never from labels** (the §8 law
   of the chaptering handoff). This single change is the difference between
   "man yells about conspiracies" and "Iran ceasefire breakdown, Strait of
   Hormuz tensions, and the path to regime change" — same content class,
   same model class.
2. **Context seeding** — the Whisper-`initial_prompt` analogy: give the
   model whatever real context exists (title/filename minimum; channel name;
   a pre-existing human description if one predates analysis — never the
   model's own earlier output). Proper nouns in beat proper nouns out.
3. **Entity scaffold**: extract entities from each chapter's OWN transcript
   slice (per-chapter, not whole-video — whole-video lists invite
   cross-chapter name bleed) and pass the list into the summarize call with
   the instruction to build the title around the specific people/claims/
   events present. Grounding rule: a proper noun in the title must appear in
   that chapter's transcript; a mismatch is a declared warning or one
   re-ask, never a silent rewrite and never a blocking check.
4. **Positive register instruction — no invented actor as grammatical
   subject.** The general rule: title the CONTENT, not the act of covering
   it; target form is a bare noun phrase or gerund built around the specific
   people/claims/events.

   **Prompt-hygiene ruling (operator, 2026-08-22): prompts carry CORRECT
   examples only — no incorrect examples and no ban lists, ever.** Incorrect
   examples leak: a model that sees the bad form sometimes reproduces it.
   The prompt states the style positively and shows a few correct examples,
   e.g.:
   - "Gene Bailey's chapter on Christian nationalist action and the David
     and Goliath framing"
   - "Debunking Gene Bailey's misreading of Luke 19:13 and his call to
     occupy territory"
   - "Kent Christmas's 2021 death-angel prophecy"
   The WRONG forms live exclusively in code (the narrated-actor detector
   below) and in this document's prose — never in anything a model reads.
   Re-asks follow the same rule: restate the positive instruction; never
   echo the rejected output or describe what was wrong about it.

   For the record (documentation only — never in prompts): the failure this
   guards against is narration as subject — "The speaker debunks…", "A
   YouTuber critiques…", "The panel discusses…" — including entity-rich
   variants; banning "the speaker" alone is too narrow.

   Scope: this governs VIEWER-FACING text (titles, hook, body, hashtags).
   Internal per-chapter summaries that feed later calls may narrate ("the
   speaker argues…") — that register is correct for internal data and must
   simply never leak into output fields; the detector runs on viewer-facing
   fields only.
5. **Keep it a judgment task**: unconstrained big model. Schema-constraining
   measurably destroys exactly this quality (see §5 and the chaptering
   handoff trap #3).

Metric (shared across apps), three numbers, scored over known videos
before/after changes:
1. proper-noun count per chapter title;
2. generic-title rate (titles with zero entities);
3. **narrated-actor rate** — titles whose grammatical subject is an invented
   actor. Deterministically checkable: flag a title that begins with (or
   whose first clause's subject is) an article + actor noun or bare actor
   noun from the ban list ("the speaker", "a YouTuber", "the host", "the
   panel", "the pastor", "he/she/they"), or an actor noun + narration verb
   ("critiques", "reacts to", "discusses", "covers"). Register and
   specificity fail independently — the failed examples above were
   entity-rich — so both must be measured.
Baseline measured on Briefcase's 63-min validation video (27b, levers 1-2
only): 1/7 titles generic, ~1.6 entities/title; narrated-actor rate 3/7
("Panel discusses…", "Panel debates…", "Pastor Brad Wells shares…" — the
third is borderline: real person as subject, but narration-verb form).

### 6.2 Tags — full reasoning

Tags are near-deprecated (YouTube's own documentation: "minimal role"; they
mainly catch misspellings and variants). Generate them because they cost
nothing, never at the price of a model call that costs real time. What is
actually worth including, in order: the exact primary search phrase; entity
names (people first — they are the misspelling-prone, long-tail-rich part);
key phrases; deliberate common misspellings of distinctive names; 1-2 broad
category terms; the channel/brand tag. Skip: single generic words ("news",
"politics" alone), anything not present in the content (YouTube treats
irrelevant tags as spam signal), and past ~400 chars stop — never truncate
mid-tag. Channel and creator names are appended by code, never generated.

### 6.3 Hashtags — selection logic

3-5 total; the first 3 display above the title when the title itself has
none. Mix entity hashtags (1-2: the headline person/org) with topic hashtags
(1-2: the subject people browse), plus the channel brand tag if the channel
uses one. Derive from the same entity/key-phrase pools as tags; dedupe
against words already in the title (a hashtag repeating the title adds
nothing). Camel-case multiword ones for readability.

### 6.4 Description hook/body — working patterns

- Hook: the exact phrase a searcher would type, front-loaded, phrased as a
  promise of what they'll see — not clickbait, a precise promise. One
  sentence, ≤150 chars, entities included when they're the draw.
- Body: weave the chapter summaries into one paragraph in TOPIC FORM — the
  same register as titles, just longer (operator ruling, 2026-08-22: no
  narrating subjects even with real names; "the panel debates X" and "Paul
  Petit reports on X" both reframe). Names stay — they are the SEO — but as
  noun-phrase constituents: possessives and objects ("Trump's refusal",
  "Paul Petit's report on the ceasefire", "Gene Bailey's misreading of Luke
  19:13"). Every entity mentioned is a long-tail query caught; every generic
  phrase is one missed.
- Worked example (real 63-min panel video, from its 7 chapter summaries):
  - Hook: `Iran ceasefire collapse, Byron Donalds projected to win Florida,
    and the 29-state lawsuit against Meta — Flashpoint's full panel
    breakdown.` (141 chars)
  - Body opens: `Debate about Trump's refusal to extend the Iran ceasefire
    MOU and rising tensions in the Strait of Hormuz, then …` — topic form,
    names as constituents.

### 6.5 The road not taken (and when to revisit)

- Dedicated small summarizer models (BART/Pegasus-class ~400M) were
  considered and rejected: trained on news prose, poor on spoken
  transcripts, and their output is precisely the generic register this spec
  forbids. Summarization has no non-generative shortcut.
- Fine-tuned adapters (LoRA on a 4b/9b) remain the escape hatch if generic
  small-model prose quality disappoints even with clean inputs: a small
  model fine-tuned on the target format replaces general judgment with
  learned format. The operator has prior art (headline-14b adapters) and
  plans 4b/9b retraining; hot-swappable adapters make per-field specialists
  cheap at runtime.
- The general tier philosophy, validated by the chaptering work: run a tiny
  specialist over the whole timeline, spend the big model only where the
  specialist points — never ask a big model to reason about everything.

## 7. Validation plan

1. Generate for 3-5 known videos; operator eyeballs hook + body against what
   they'd write (the calibration pass).
2. Check the mechanical invariants in code: 00:00 first chapter line, char
   caps, hashtag count, tag total length, no entity in tags that isn't in the
   transcript.
3. A/B the 4b vs the main model on the same inputs; adopt 4b only if the
   operator can't reliably tell which is which.
