# Chapter Detection Pipeline — Portable Handoff Document

A method for finding chapter boundaries in long-form spoken video/audio from its
transcript, and turning them into genuinely descriptive chapters. Validated
August 2026 in Briefcase on real broadcast content; descended from the
AutoCutStudio staged chaptering method (label → rate → select → place), which
was validated on a real 4-hour livestream. This revision replaces that method's
two O(N) LLM stages with a single embedding pass, cutting an hour-long video
from ~170 LLM calls to ~10 with **better** boundary quality.

This document is self-contained: everything needed to implement the pipeline in
another application is here, including constants, prompts, measured model
guidance, and the failure modes that shaped each decision.

---

## 1. The core insight

The AutoCutStudio method was built around one hard-won law: **a mid-size LLM
cannot select K items from N** — asked for "all the boundaries in this
transcript," it returns a prefix (the first 1-3) and stops, regardless of
prompt engineering. Its answer was to never show the model a list: one call per
45-second stretch (label it), one call per junction (rate the change 0-3), then
select in pure code by ranking. Correct, but ~2 calls per 45 seconds of video.

The observation that collapses the cost: those O(N) calls only exist to answer
"how different is the content before this point from the content after it?" —
and the ratings were individually weak anyway (AUC ≈ 0.55; the design's power
came from *ranking* them, not from any single score). A text-embedding model
answers the same question in milliseconds, batched, with a *continuous* score
that ranks at least as well as a noisy integer 0-3.

So: **embeddings score every junction, code selects, and the LLM is kept only
for the one thing embeddings cannot do** — reading the junction window and
quoting the exact sentence where the topic turns.

Measured head-to-head on the same 63-minute broadcast (panel show with an ad
break): the old single-shot LLM approach missed the ad break entirely and took
~5 minutes; this pipeline found the ad break to the second and took ~1 minute
(~17s with a small placement model).

## 2. Pipeline overview

```
transcript segments (start, end, text)
        │
   [1] STRETCH        code       cut into 45s stretches
        │
   [2] SCORE          embeddings one batched embed call; depth score per junction
        │
   [3] SELECT         code       rank by depth, enforce min gap, take `wanted`
        │
   [4] PLACE          LLM        ~10 tiny calls: quote the turning sentence;
        │                        code maps quote → seconds
   [5] CONSOLIDATE    code       merge adjacent chapters that are about the
        │                        same thing (over-segment, then merge)
   [6] SUMMARIZE      LLM        per chapter, from RAW transcript + context
```

Stages 1-5 produce boundary times. Stage 6 is where descriptions become
valuable or worthless — see §8, it has its own law.

## 3. Stage specs

### 3.1 Stretch (code)

Cut the transcript into stretches of `STRETCH_SECONDS = 45`. Align each
stretch's window to a 45s grid (`floor(segStart / 45) * 45`), start a new
stretch when a segment starts at or past the current window's end, and never
split a transcript segment across stretches. Each stretch keeps its real
`start` (first segment's start) and concatenated text.

45 seconds is inherited from the validated AutoCutStudio method: long enough
that a stretch has a topic, short enough that boundary resolution before
placement is tolerable.

### 3.2 Score (embeddings)

Embed **all stretch texts in one batched call**. With Ollama:
`POST /api/embed` with `{ "model": "nomic-embed-text", "input": [ ...texts ],
"keep_alive": "10m" }`. Measured: 85 stretches (63 min of video) in ~2s on a
137M-parameter embedding model — small enough to coexist with any generation
model.

For each junction *i* (the boundary between stretch *i* and *i+1*):

- **Block comparison** (TextTiling-style, more stable than pairwise): compare
  the mean vector of up to `BLOCK = 2` stretches on the left against up to 2 on
  the right, by cosine similarity → `sim[i]`.
- **Depth score**: how deep a valley this junction is relative to its
  surroundings. Walk left from *i* while similarity is non-decreasing to find
  the nearest peak `L`; same to the right for `R`. Then
  `depth[i] = (L − sim[i]) + (R − sim[i])`.

Depth, not raw similarity, is the ranking signal: a monologue that drifts has
low similarity everywhere, but only true topic changes are *valleys*.

Useful side signal: the video's overall depth profile says how "chaptered" the
content even is. A panel show measured depths up to 0.87 at real transitions; a
single-topic monologue peaked at 0.30. A depth floor (below which fewer than
`wanted` chapters are returned) is a sensible extension — the old LLM methods
had no way to say "this video is one chapter."

### 3.3 Select (pure code — zero model calls)

Ported verbatim from AutoCutStudio (this stage carried its 4-hour-livestream
validation):

```
targetSecondsFor(dur):  dur < 600 → 132   (short videos: ~2min chapters)
                        dur < 1800 → 210
                        dur < 3600 → 336
                        else       → 360   (long form: ~6min chapters)

wanted = max(3, round(dur / target)) − 1
minGap = 0.6 × target
```

Iterate junctions strongest-depth-first; accept a junction if it is ≥ `minGap`
from every already-accepted one; stop at `wanted`. Sort accepted by time.
Deliberately over-segment slightly — consolidation (§3.5) merges the excess.
Boundary 0:00 is always implicit.

Known tradeoff: `minGap` suppresses genuinely close pairs. An ad break's start
and end 2m14s apart → only the stronger one survives, so the ad shares a
chapter with adjacent content. If isolated ad-chapters matter, add a paired-
junction exception for two very deep valleys closer than `minGap`.

### 3.4 Place (LLM — the only per-boundary generation calls)

For each selected junction, ONE call: show the model the transcript text ±45s
around the junction and ask it to quote, verbatim, the sentence where the
handover begins. **Code** maps the quote back to seconds with a fuzzy phrase
matcher (normalize case/punctuation; slide a window over the transcript's word
stream; accept ≥ ~65% similarity; take the matched position's timestamp).

The inherited call rules — each one is load-bearing:

- **The model NEVER emits a timestamp.** Models cannot do timestamp arithmetic
  reliably; quotes are ground truth because the transcript maps them exactly.
- **temperature 0** — a reworded quote points at the wrong moment.
- **Structured output** (`format: "json"` in Ollama) — constrains decoding to
  the JSON shape. Besides parse-safety this collapses output to ~15-35 tokens,
  which is what makes small models viable at this stage (§6).
- **`done_reason: "length"` is a hard failure** for that call — the text is a
  truncated fragment; never parse it.
- **One `num_ctx` for the whole run**, sized from the largest window: Ollama
  fully reloads the model on any num_ctx change.
- **`keep_alive: '10m'`** so the model stays resident across the run.
- **Graceful degradation**: if the call fails or the quote won't map, fall back
  to the raw junction time. A 45-second-resolution boundary is still a real
  boundary; a placement failure must never kill the job.

The prompt (validated; the multi-change rule exists because windows sometimes
contain several transitions — e.g. "we'll be right back" + ad #1 + ad #2 packed
into 45 seconds — and models otherwise pick one arbitrarily):

```
Below is one stretch of a video transcript. Somewhere inside it the speaker
moves from one subject to the next.
Video: {videoTitle}

TRANSCRIPT:
{windowText}

Find where the handover BEGINS — the first sentence a viewer would want to
land on if they clicked a chapter marker here.

That is the sentence where the speaker TURNS AWAY from the old subject, which
is usually a beat EARLIER than the sentence that first explains the new one.
If the speaker says "anyway, let's talk about X" and then explains X three
sentences later, the turn is "anyway, let's talk about X" — quote that, not
the explanation. A viewer dropped at the explanation has already missed the
start.

Prefer, in this order:
1. the sentence where the speaker announces, introduces or turns toward the
   new subject
2. the sentence where the speaker closes off the old subject, if the turn is
   not announced
3. the first sentence that is plainly about the new subject, if there is no
   turn at all

If the transcript contains MORE THAN ONE subject change, pick the one nearest
the MIDDLE of the excerpt — the excerpt is centered on the boundary being
placed, so changes near its edges belong to neighboring chapters, not this one.

Copy the sentence EXACTLY as it appears above, word for word, at least six
words, no timestamps and no tidying up. That quote is what fixes the chapter's
start time to the second, so a quote you reworded points at the wrong moment.

Output exactly this shape and nothing else:
{"quote": "<exact sentence from the transcript above>"}
```

### 3.5 Consolidate (code)

For each adjacent chapter pair, compare the mean embedding of each chapter's
stretches (centroid). If cosine similarity > `CONSOLIDATE_SIMILARITY = 0.80`,
merge — unless the merged chapter would exceed the app's maximum chapter
length. This is the release valve for select's deliberate over-segmentation;
on the validation video it merged 3-4 of 10 boundaries (centroid sims
0.86-0.90), leaving 7 chapters averaging ~8.5 minutes.

0.80 is calibrated for nomic-embed-text cosines and is the least-tuned constant
in the pipeline. If using the lexical fallback scorer (§5), TF-IDF cosines run
much lower and 0.80 effectively never merges — which fails in the safe
direction (too many chapters, not too few).

### 3.6 Summarize (LLM) — see §8; it is the difference between chapters worth
reading and "man yells about conspiracies."

## 4. LLM call budget

63-minute video, measured:

| | AutoCutStudio original | This pipeline |
|---|---|---|
| Label | ~84 calls | 0 |
| Rate | ~83 calls | 0 (one embed batch, ~2s) |
| Place | ~11 calls | ~10 calls |
| Boundary detection total | ~178 calls, tens of minutes | ~10 calls, 17-60s |

Placement calls with structured output emit 15-35 tokens each: ~5s per call on
a 27B, ~1.2s on a 4B.

## 5. Fallback scorer (no embedding model available)

If the embed call fails (no Ollama, model not pulled, endpoint down), score
junctions with **lexical block cosine**: TF-IDF vectors over the same
stretches, same block comparison, same depth scoring, same select/place/
consolidate. Zero model calls. Measurably weaker (matches words, not meaning)
but it still found the validation video's ad break. Always log which scorer
ran. Embeddings are a quality optimization, not a dependency — placement can
also route to any provider (cloud included), so nothing hard-requires a local
stack.

## 6. Model selection (measured, August 2026, Apple Silicon 64GB)

**Embedding**: `nomic-embed-text` (137M, 274MB). Any competent text-embedding
model works; recalibrate `CONSOLIDATE_SIMILARITY` if you change it.

**Placement** — the qwen3.5/3.8 ladder on identical inputs, scored against the
27B's boundaries:

| Model | Result |
|---|---|
| qwen3.8:27b | Reference. 10/10 placed, ~5s/call. |
| qwen3.5:9b | 10/10, ~1.7s/call. Two boundaries wobbled ±25-40s. |
| **qwen3.5:4b** | **Recommended floor.** 10/10, ~1.2s/call, Pass 1 in 17s. One boundary 24s early; elsewhere within seconds of the 27B. |
| qwen3.5:2b | Broken: echoes the task back as JSON (`{"task": "identify..."}`) instead of answering. 0/10. |
| qwen3.5:0.8b | Fast and wrong: quotes map to wrong places, boundaries drift, one lost entirely. |

4b vs 9b wobbles hit *different* junctions — the errors are prompt-ambiguity
noise, not a capability gap, which is why the multi-change prompt rule exists.
Below 4b the failure is instruction collapse, which no prompt fixes.

**Make the small tier zero-configuration.** Users should not have to know any
of the above. The reference implementation probes the local Ollama's installed
models once per run (`GET /api/tags`, 2s timeout) and routes placement to the
first model found from a preference list (`['qwen3.5:4b']`), falling back to
the app's main model — including cloud models — when Ollama or the model is
absent. A cloud-main user with local Ollama still gets fast local placement; a
cloud-only user still works (placement failures degrade to junction times).
Explicit per-task config, if your app has it, wins over auto-detection. The
combined auto tier — embedding model (274MB) + placement model (3.4GB) — fits
on essentially any machine the app runs on.

**Traps discovered the hard way** (Ollama, qwen3-class thinking models):

1. **`think: false` does not disable thinking** — it relocates the reasoning
   into `response`, breaking JSON and *increasing* tokens. Omitting `think`
   means default = ON. The working lever is graded levels (`think: "low"`).
2. **`format: "json"` + a thinking model**: the JSON grammar constrains the
   whole stream, so the answer arrives in the `thinking` field with `response`
   EMPTY. Handle it narrowly: if structured output was requested and
   `response` is empty, read the object from `thinking`. (Worth handling
   rather than avoiding: the constrained call is ~5x cheaper and is also what
   suppresses small-model over-reasoning — an unconstrained 4b burned its
   entire 8192-token budget reasoning and never answered. `format` also
   accepts a full JSON Schema, not just `"json"`, which pins the exact output
   shape.)
3. **Structured output suppresses judgment along with prose — only constrain
   MECHANICAL tasks.** The grammar prevents the model from reasoning before it
   answers, and on tasks where the reasoning was doing real work, quality
   drops measurably. A/B on qwen3.8:27b, same content-flagging call, 3 paired
   runs against a reference flag set: constrained was 5.5x faster (168s →
   30s/call, 3156 → 655 output tokens) but recall fell 7.3 → 5.7 of 11 and
   false positives rose 0.7 → 3.0 per run — and the extras were exactly the
   nuanced discrimination the prompt led with (quotes *reporting* a claim
   flagged as *asserting* it). Rule of thumb: constrain quote-copying,
   labeling, and format transforms (placement is ideal — it's also what makes
   the 4b viable there); never constrain calls whose prompt contains a
   judgment test, unless you have measured that the judgment survives. If you
   offer the fast mode anyway, make it an explicit opt-in, not the default.
4. **num_ctx changes reload the model.** Bucket estimates coarsely (e.g. to
   4096) and pin one value per run.
5. **Cap num_ctx by model size** so KV cache stays on-GPU: ≤15B → 16384,
   larger → 12288 (64GB Apple Silicon; scale for your hardware). One spilled
   layer bottlenecks every token.

## 7. Failure handling summary

| Failure | Response |
|---|---|
| Embed call fails | Lexical scorer, log it, continue |
| Place call fails / `done_reason: length` / unparseable | That boundary uses the junction time; continue |
| Quote doesn't fuzzy-match | Junction time; continue |
| Very short video (< ~2 stretches) | Single chapter `[0]`, zero calls |
| Empty transcript | `[0]` |

Nothing in boundary detection should ever abort an analysis job — every
failure has a usable degraded output.

## 8. Getting DESCRIPTIVE chapters (the part users actually see)

The original AutoCutStudio pipeline produced correct splits with worthless
descriptions ("man yells about conspiracies"). The cause was structural, not
model quality: it summarized chapters from its own 3-6 word stretch labels —
a summary of summaries. The fix is a law of its own:

**The summarizing model must read the chapter's RAW transcript, never
intermediate labels — plus real context:**

1. **The chapter's full transcript text** (the model that names the chapter
   reads what was actually said in it).
2. **Video-level context**: title and/or filename — e.g. a filename like
   "2026-08-19 jesse watters mocks democrat candidates…" tells the model who
   is speaking and why, grounding names and framing. A pre-existing video
   description helps too (only if it predates analysis — don't feed the model
   its own output).
3. **The previous chapter's summary**, threaded sequentially, so chapter N
   knows what "back to what we discussed" refers to and titles don't repeat.

With those three inputs a 27B produced titles like "Iran ceasefire breakdown,
Strait of Hormuz tensions, and the path to regime change" for the same class
of content that label-summarizing reduced to "man yells about conspiracies."

Ask for a one-sentence title (~15 words max) and a 2-3 sentence summary of
what the speaker actually says, JSON output. Use the big model here — this is
the stage where model quality visibly shows, and it is O(chapters), not
O(duration).

## 9. Constants reference

| Constant | Value | Notes |
|---|---|---|
| STRETCH_SECONDS | 45 | inherited, validated |
| BLOCK | 2 | stretches per side in block comparison |
| targetSecondsFor | 132/210/336/360 | by duration <10/<30/<60/60+ min |
| wanted | max(3, round(dur/target)) − 1 | |
| minGap | 0.6 × target | |
| CONSOLIDATE_SIMILARITY | 0.80 | nomic-embed-text cosines; least-tuned |
| Place window | junction ± 45s | |
| Fuzzy match threshold | ~65% | word-stream similarity |
| Place temperature | 0 | |
| Embed timeout | 60s | then lexical fallback |

## 10. Validation record

- **63-min panel broadcast** (the motivating case): old single-shot LLM
  boundary detection produced 11 chapters, several force-split artifacts,
  missed the 27:00 ad break; total job 23m51s. This pipeline: 7 chapters, every
  boundary a real transition, ad break placed to the second ("With that, we're
  going to take a break." → 26:55), total job 15m23s. Boundary stage alone:
  ~5min → ~1min (27B placement) → 17s (4B placement).
- **11.7-min single-topic monologue**: depth profile correctly near-flat
  (max 0.30 vs 0.87); selected the two best available pivots.
- **Production run reproduced the standalone harness almost exactly** (one
  boundary differed, inside a window with three packed transitions — the case
  the multi-change prompt rule now covers).
- Stage-3 selection logic carries AutoCutStudio's validation on a real 4-hour
  livestream with real segment breaks.

## 11. Reference implementation

Briefcase (Electron/NestJS), branch `analysis-pipeline-tuning`:

- `backend/src/analysis/chapter-detection.service.ts` — stages 1-5; the pure
  functions (`buildStretches`, `scoreJunctions`, `selectJunctions`,
  `targetSecondsFor`, `lexicalVectors`) are exported separately from the
  service for reuse and standalone testing.
- `backend/src/analysis/prompts/analysis-prompts.ts` —
  `buildBoundaryPlacementPrompt` (§3.4 prompt), `buildChapterAnalysisPrompt`
  (§8 summarize prompt).
- `backend/src/analysis/phrase-matcher.ts` — quote → timestamp fuzzy matcher.
- `backend/src/analysis/model-utils.ts` — num_ctx sizing, think-level logic,
  and inline comments documenting the traps in §6.
