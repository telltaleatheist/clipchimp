/**
 * Shared model/provider utilities for the AI analysis pipeline.
 *
 * Consolidates logic that was previously duplicated across ai-analysis.service,
 * analysis.service, media-operations.service and simple-analyze.controller:
 *  - provider-prefix parsing ("ollama:cogito:14b" -> provider 'ollama', model 'cogito:14b')
 *  - per-task sampling temperature
 *  - Ollama num_ctx sizing (bucketed + model-size-aware cap, ported from BookForge)
 *  - inline <think> stripping (belt-and-braces for thinking models)
 */

export type AIProvider = 'local' | 'ollama' | 'claude' | 'openai';

const KNOWN_PROVIDERS: AIProvider[] = ['local', 'ollama', 'claude', 'openai'];

export interface ParsedProviderModel {
  provider: AIProvider | undefined;
  model: string;
}

/**
 * Split a possibly provider-prefixed model string into its provider and bare
 * model name. Mirrors the historical behavior at all four call sites:
 *  - "ollama:cogito:14b"  -> { provider: 'ollama', model: 'cogito:14b' }
 *  - "local:cogito-8b"    -> { provider: 'local',  model: 'cogito-8b' }
 *  - "cogito:14b"         -> { provider: explicitProvider, model: 'cogito:14b' }
 *    (bare tag whose first segment is NOT a known provider is left untouched)
 *
 * The prefix is only stripped when there is no explicit provider or the prefix
 * matches it — a mismatched prefix (explicit 'claude' + "ollama:x") is left
 * intact so the explicit provider still wins, matching prior behavior.
 */
export function parseProviderModel(
  model: string,
  explicitProvider?: AIProvider | string,
): ParsedProviderModel {
  let provider = (explicitProvider as AIProvider | undefined) || undefined;

  if (typeof model === 'string') {
    const colonIndex = model.indexOf(':');
    if (colonIndex > 0) {
      const firstSegment = model.substring(0, colonIndex);
      if (KNOWN_PROVIDERS.includes(firstSegment as AIProvider)) {
        if (!provider || provider === firstSegment) {
          provider = firstSegment as AIProvider;
          return { provider, model: model.substring(colonIndex + 1) };
        }
      }
    }
  }

  return { provider, model };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-task sampling temperature
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The five analysis generation tasks. JSON-extraction tasks want near-greedy
 * decoding (low temperature) so the output parses; free-text tasks tolerate a
 * little variety.
 */
export type AITaskKind = 'boundary' | 'chapter' | 'flags' | 'tags' | 'description' | 'title';

/**
 * Sampling temperature per task.
 *  - boundary / chapter / tags produce STRICT JSON — 0.15 keeps decoding
 *    near-deterministic so the object parses cleanly (the old local path used
 *    0.7, which is far too hot for JSON extraction).
 *  - description / title are free text — 0.4 allows a little natural variation
 *    without drifting into meta-commentary.
 */
export function temperatureForTask(kind?: AITaskKind): number {
  switch (kind) {
    case 'boundary':
    case 'chapter':
    case 'flags':
    case 'tags':
      return 0.15;
    case 'description':
    case 'title':
      return 0.4;
    default:
      // Connection tests / unspecified — a neutral, low-variance default.
      return 0.2;
  }
}

/**
 * Whether a task should ask a thinking-capable model to reason before answering.
 *
 * Thinking is NOT free — measured on qwen3.8:27b, a thinking call emits roughly
 * 1,900-2,900 output tokens regardless of how small the real answer is, and
 * generation time is dominated by output tokens. It is therefore spent only
 * where deliberation changes the answer:
 *
 *  - flags:    the assert-vs-debunk test is a genuine judgment call and BOTH
 *              failure directions are expensive (a false accusation, or a missed
 *              quote). This is what chain-of-thought is actually for.
 *  - chapter:  working out what a chapter is about before summarizing it. Cheap
 *              in practice — measured at ~520 output tokens.
 *
 * Everything else is mechanical and pays the full thinking tax for nothing:
 *  - boundary: copies 3-8 word phrases and judges subject changes, but the
 *              downstream force-split at maxChapterSeconds bounds chapter length
 *              anyway, so ~1,900 tokens of deliberation buys very little.
 *  - tags / description / title: format transforms over already-summarized
 *              chapters. A prior run spent ~1,000 reasoning tokens writing a
 *              filename.
 */
export function thinkingForTask(_kind?: AITaskKind): boolean {
  // ALWAYS TRUE — thinking stays ENABLED. Do not switch this to `think: false`.
  //
  // Measured on Ollama 0.32.14 with qwen3-class models:
  //   think omitted -> thinking still happens (omission means "default" = on).
  //   think: false  -> the model does NOT stop reasoning, it RELOCATES the
  //                    reasoning into `response`, polluting it with prose and
  //                    breaking JSON parsing. eval_count went UP, not down.
  //
  // The lever that DOES work is the graded level below (think: "low"), which
  // keeps reasoning in the separate `thinking` field but spends less on it.
  return true;
}

/** Graded reasoning effort. Ollama accepts true/false or high/medium/low. */
export type ThinkLevel = 'low' | 'medium' | 'high';

/**
 * How much reasoning each task gets.
 *
 * Generation time is output tokens / tokens-per-second, and on a 27B this
 * machine runs ~15-18 tok/s. Thinking dominates that budget: a flag call
 * measured 3,433 output tokens for ~300 tokens of actual JSON, i.e. ~200s of
 * which ~185s was reasoning. Turning the level down is the only lever that
 * reduces reasoning WITHOUT pushing it into the answer.
 *
 * EVERYTHING starts at 'low', including flags. The intuition that flag
 * extraction needs deliberation for the assert-vs-debunk test is plausible but
 * UNVERIFIED, and flags are ~50% of total runtime — so it is the most expensive
 * place to hold an untested assumption. There is now a hand-built reference set
 * of flaggable moments for a known video, which makes this measurable: run at
 * 'low', score against the reference, and raise ONLY the task whose quality
 * actually drops.
 *
 * Raise flags to 'medium'/'high' first if recall regresses; leave the mechanical
 * tasks (boundary copying, chapter summarizing, metadata formatting) at 'low'
 * regardless — they were burning 1,500-7,400 reasoning tokens on work needing
 * almost none.
 *
 * Levels are advisory: models that do not implement them fall back to plain
 * `think: true` (see ollama-capabilities).
 */
export function thinkLevelForTask(_kind?: AITaskKind): ThinkLevel {
  return 'low';
}


// ─────────────────────────────────────────────────────────────────────────────
// Ollama num_ctx sizing (ported from BookForge electron/ai-bridge.ts)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive the num_ctx ceiling from the model's parameter count, sniffed from the
 * tag (e.g. 'cogito:14b', 'qwen3:32b', 'llama3.1:8b-instruct-q4_K_M'; MoE tags
 * like 'mixtral:8x7b' count experts × size).
 *
 * The ceiling keeps weights + KV cache on the GPU (spilling a layer to CPU
 * bottlenecks every token):
 *  - ≤15B: 16384 tokens.
 *  - Larger (32B-class) OR unrecognized size: 12288 (conservative — guessing
 *    low costs a rare clamp, guessing high cripples the whole job).
 *
 * The absurd 131072 cap the old code used would allocate a full 128K KV cache
 * and spill any real model to CPU.
 */
export function numCtxMaxForModel(model: string): number {
  const moe = /(\d+)x(\d+(?:\.\d+)?)b/i.exec(model);
  const dense = /(\d+(?:\.\d+)?)b/i.exec(model);
  const sizeB = moe
    ? parseInt(moe[1], 10) * parseFloat(moe[2])
    : dense
      ? parseFloat(dense[1])
      : null;
  if (sizeB !== null && sizeB <= 15) return 16384;
  return 12288;
}

/**
 * Estimate the num_ctx for an Ollama request.
 *
 * Two constraints, both from BookForge's hard-won experience:
 *  - Bucket to 4096: Ollama fully reloads the model on ANY num_ctx change, so
 *    per-request estimates that each land on a slightly different value cause
 *    relentless reload churn. Rounding up to coarse buckets makes similar-sized
 *    prompts reuse the already-loaded runner.
 *  - Cap at numCtxMaxForModel(model): keep KV cache on the GPU.
 *
 * `outputBudgetTokens` must cover the generation that has to fit ALONGSIDE the
 * prompt in the context window — for thinking models that includes the chain of
 * thought, so callers pass a larger budget when thinking is active.
 */
export function estimateNumCtx(
  promptChars: number,
  model: string,
  outputBudgetTokens: number,
): number {
  const CHARS_PER_TOKEN = 3;
  const NUM_CTX_BUCKET = 4096;
  const inputTokens = Math.ceil(promptChars / CHARS_PER_TOKEN);
  const raw = Math.ceil((inputTokens + outputBudgetTokens + 512) * 1.2);
  const bucketed = Math.max(NUM_CTX_BUCKET, Math.ceil(raw / NUM_CTX_BUCKET) * NUM_CTX_BUCKET);
  return Math.min(numCtxMaxForModel(model), bucketed);
}

// ─────────────────────────────────────────────────────────────────────────────
// Thinking-model output hygiene
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip inline <think>...</think> (and stray closing/opening tags) from a
 * response. Well-behaved Ollama thinking models put the chain of thought in the
 * separate `thinking` response field, but some model templates inline it into
 * the answer — this removes it before JSON extraction / free-text use so the
 * reasoning never leaks into a title or corrupts a JSON parse. It is a no-op for
 * clean responses.
 */
export function stripThinkTags(text: string): string {
  if (!text) return text;
  let out = text;
  // Complete <think>...</think> blocks (dotall).
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // An unterminated opening <think> (reasoning that ran into the token budget
  // with no closing tag and thus no answer after it) — drop it to end.
  out = out.replace(/<think>[\s\S]*$/i, '');
  // Any stray lone tags left over (e.g. a leading </think> with no opener).
  out = out.replace(/<\/?think>/gi, '');
  return out.trim();
}
