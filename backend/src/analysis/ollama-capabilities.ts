/**
 * Ollama model-capability negotiation for the analysis pipeline.
 *
 * Analysis is judgment-heavy with small outputs, so we WANT thinking-capable
 * models (qwen3-class) to think. Ollama's /api/generate accepts a top-level
 * `think` field, but only models whose /api/show capabilities include
 * 'thinking' honor it — so we probe once per (baseUrl, model) and cache.
 *
 * Empirically verified against the live Ollama at localhost:11434 (2026-07-09):
 *  - qwen3:32b reports ['completion','tools','thinking']. Sending `think:true`
 *    makes it reason in the SEPARATE `thinking` response field while `response`
 *    contains ONLY clean JSON (no inline <think>), which parses directly.
 *  - cogito:8b/14b/32b report ['completion','tools'] — NO 'thinking' — so they
 *    get no `think` field at all (sending it to a non-thinking model is
 *    unnecessary and we omit it).
 *
 * This is explicit negotiation (probe + log + cache), not a silent fallback:
 * a failed probe (Ollama unreachable / unknown model) throws so the caller
 * fails loudly rather than silently guessing.
 */

import { AITaskKind, ThinkLevel, thinkingForTask, thinkLevelForTask } from './model-utils';

/**
 * Models that rejected a graded think level ("low"/"medium"/"high") and must be
 * sent plain `think: true` instead. Populated at first failure by the caller —
 * Ollama's `--think` help says levels apply only "for supported models", and
 * there is no capability flag advertising which.
 */
const gradedThinkUnsupported = new Set<string>();

/** Record that `model` cannot take graded levels, so we stop sending them. */
export function markGradedThinkUnsupported(baseUrl: string, model: string): void {
  if (!gradedThinkUnsupported.has(`${baseUrl}::${model}`)) {
    console.log(`[OLLAMA-CAPS] ${model} rejected a graded think level — falling back to think:true`);
  }
  gradedThinkUnsupported.add(`${baseUrl}::${model}`);
}

// Cache successful probes; a failed probe is dropped so the next call retries.
const thinkingCapabilityCache = new Map<string, Promise<boolean>>();

async function probeThinkingCapability(baseUrl: string, model: string): Promise<boolean> {
  const response = await fetch(`${baseUrl}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  if (!response.ok) {
    throw new Error(`Ollama /api/show for '${model}' returned HTTP ${response.status}`);
  }
  const data = (await response.json()) as { capabilities?: unknown };
  const capabilities = Array.isArray(data.capabilities) ? (data.capabilities as string[]) : [];
  const supportsThinking = capabilities.includes('thinking');
  console.log(
    `[OLLAMA-CAPS] ${model} capabilities: [${capabilities.join(', ')}] — ` +
      (supportsThinking
        ? 'thinking model, enabling think:true (reasoning lands in separate field)'
        : 'no thinking capability, omitting think field'),
  );
  return supportsThinking;
}

/**
 * Whether the model reports the 'thinking' capability. Probes /api/show once
 * per (baseUrl, model) and caches for the process lifetime.
 */
export async function ollamaModelSupportsThinking(baseUrl: string, model: string): Promise<boolean> {
  const key = `${baseUrl}::${model}`;
  let cached = thinkingCapabilityCache.get(key);
  if (!cached) {
    cached = probeThinkingCapability(baseUrl, model);
    cached.catch(() => thinkingCapabilityCache.delete(key));
    thinkingCapabilityCache.set(key, cached);
  }
  return cached;
}

export interface OllamaThinkNegotiation {
  /** Top-level fields to merge into the /api/generate body. */
  fields: { think?: boolean | ThinkLevel };
  /** True when the model is thinking-capable (caller sizes num_predict up). */
  thinking: boolean;
  /** The graded level requested, or null when sending plain `think: true`. */
  level: ThinkLevel | null;
}

/**
 * Negotiate the `think` request field for one task.
 *
 * Two gates, both of which must pass before a model is asked to reason:
 *   1. the TASK must benefit from it (thinkingForTask) — thinking costs ~1,900+
 *      output tokens a call and generation time tracks output tokens, so
 *      mechanical tasks skip it outright and never even probe;
 *   2. the MODEL must report the 'thinking' capability, since sending `think`
 *      to a model without it does nothing.
 *
 * Also returns the `thinking` flag so the caller can size num_predict and
 * num_ctx to leave room for the chain of thought.
 */
export async function negotiateOllamaThink(
  baseUrl: string,
  model: string,
  task?: AITaskKind,
): Promise<OllamaThinkNegotiation> {
  if (!thinkingForTask(task)) {
    return { fields: {}, thinking: false, level: null };
  }

  const thinking = await ollamaModelSupportsThinking(baseUrl, model);
  if (!thinking) {
    return { fields: {}, thinking: false, level: null };
  }

  // Graded levels cut reasoning tokens (the dominant cost) WITHOUT relocating
  // the reasoning into `response` the way `think: false` does. Fall back to
  // plain `think: true` for models known to reject them.
  if (gradedThinkUnsupported.has(`${baseUrl}::${model}`)) {
    return { fields: { think: true }, thinking: true, level: null };
  }

  const level = thinkLevelForTask(task);
  return { fields: { think: level }, thinking: true, level };
}

