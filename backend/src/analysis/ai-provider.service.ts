// backend/src/analysis/ai-provider.service.ts
import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { LlamaManager } from '../bridges';
import {
  AITaskKind,
  temperatureForTask,
  estimateNumCtx,
  stripThinkTags,
} from './model-utils';
import { negotiateOllamaThink, markGradedThinkUnsupported } from './ollama-capabilities';

export interface AIProviderConfig {
  provider: 'local' | 'ollama' | 'claude' | 'openai';
  model: string;
  apiKey?: string;
  ollamaEndpoint?: string;
}

export interface AIResponse {
  text: string;
  tokensUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: number;
  provider: string;
  model: string;
  /**
   * Ollama's `done_reason`. 'length' means the generation was CUT OFF at the
   * num_predict ceiling, so the text is a fragment — callers that need a
   * complete answer (a verbatim quote, a JSON object) must treat it as a failed
   * call rather than parse the fragment. Absent for non-Ollama providers.
   */
  doneReason?: string;
}

/**
 * Per-call overrides for the Ollama path. Both exist for stages that make a RUN
 * of near-identical calls and need them to behave identically; other providers
 * ignore them.
 */
export interface AIGenerateOverrides {
  /**
   * Fixed num_ctx for the whole run, instead of per-call estimation. Ollama
   * fully reloads the model on any num_ctx change, so a stage whose prompts vary
   * slightly in size sizes ONCE from its largest prompt and passes it here.
   */
  numCtx?: number;
  /**
   * Ollama structured-output mode — constrains decoding to valid JSON.
   *
   * `'json'` is free-form JSON. An OBJECT is a full JSON Schema, passed through
   * verbatim as Ollama's `format` field, which constrains decoding to exactly
   * that shape (keys, types, required fields). The schema form is strictly
   * stronger: besides guaranteeing the parse, it collapses a thinking model's
   * output from thousands of reasoning tokens to the answer itself, because the
   * grammar admits nothing else.
   */
  format?: 'json' | Record<string, unknown>;
  /**
   * Sampling temperature for THIS call, overriding the per-task default.
   *
   * `temperatureForTask` is per TASK, but one task can contain calls that want
   * different settling: the description task makes a hook call that wants a
   * little life (the task default, 0.4) and a body call that wants near-greedy
   * prose (0.2) — see docs/youtube-metadata-spec.md §5. Rather than splitting the
   * task kind in two (which would fragment `taskModels` routing users already
   * configure), the odd call out passes its own value.
   *
   * Applies to the ollama and local paths. Cloud providers deliberately send NO
   * sampling params at all (newer Claude/OpenAI models 400 on them), so this is
   * ignored there — same as `format`.
   */
  temperature?: number;
}

@Injectable()
export class AIProviderService {
  private readonly logger = new Logger(AIProviderService.name);
  private anthropic: Anthropic | null = null;
  private openai: OpenAI | null = null;

  /**
   * Ollama models THIS app has asked to load, as `${endpoint}::${model}`.
   *
   * Ollama is a shared daemon: other apps on this machine may have their own
   * models resident. Releasing on shutdown must therefore be surgical — we
   * unload only what Briefcase itself loaded, never "everything that is loaded".
   */
  private readonly ollamaModelsInUse = new Set<string>();

  /** In-flight Ollama generations, so shutdown can cancel them. */
  private readonly inFlightOllama = new Set<AbortController>();

  /** True once shutdown has begun, so cancelled calls aren't logged as errors. */
  private releasingOllama = false;

  constructor(private readonly llamaManager: LlamaManager) {}

  // Pricing per 1M tokens (as of May 2025)
  private readonly PRICING: Record<'claude' | 'openai', Record<string, { input: number; output: number }>> = {
    claude: {
      'claude-sonnet-4': { input: 3.00, output: 15.00 },
      'claude-haiku-4': { input: 0.80, output: 4.00 },
      'claude-opus-4': { input: 15.00, output: 75.00 },
      'claude-3-7-sonnet': { input: 3.00, output: 15.00 },
      'claude-3-5-sonnet': { input: 3.00, output: 15.00 },
      'claude-3-5-haiku': { input: 0.80, output: 4.00 },
      'claude-3-opus': { input: 15.00, output: 75.00 },
      'claude-3-sonnet': { input: 3.00, output: 15.00 },
      'claude-3-haiku': { input: 0.25, output: 1.25 },
    },
    openai: {
      'gpt-4o': { input: 2.50, output: 10.00 },
      'gpt-4o-mini': { input: 0.15, output: 0.60 },
      'gpt-4.1': { input: 2.00, output: 8.00 },
      'gpt-4.1-mini': { input: 0.40, output: 1.60 },
      'gpt-4.1-nano': { input: 0.10, output: 0.40 },
      'gpt-4-turbo': { input: 10.00, output: 30.00 },
      'gpt-4': { input: 30.00, output: 60.00 },
      'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
      'o3-mini': { input: 1.10, output: 4.40 },
    },
  };

  /**
   * Calculate estimated cost based on token usage
   * Uses prefix matching so date-suffixed models (e.g. claude-sonnet-4-20250514) still match
   */
  private calculateCost(
    provider: 'claude' | 'openai',
    model: string,
    inputTokens: number,
    outputTokens: number,
  ): number {
    const providerPricing = this.PRICING[provider];
    if (!providerPricing) return 0;

    // Try exact match first
    let pricing = providerPricing[model];

    // Fallback: find a key that the model starts with (handles date suffixes like -20250514)
    if (!pricing) {
      const matchingKey = Object.keys(providerPricing)
        .sort((a, b) => b.length - a.length) // Longest match first
        .find(key => model.startsWith(key));
      if (matchingKey) {
        pricing = providerPricing[matchingKey];
      }
    }

    // Fallback: find a key that starts with the same base (handles -latest suffix)
    if (!pricing) {
      const modelBase = model.replace(/-latest$/, '').replace(/-\d{8}$/, '');
      const matchingKey = Object.keys(providerPricing)
        .find(key => key === modelBase || modelBase.startsWith(key));
      if (matchingKey) {
        pricing = providerPricing[matchingKey];
      }
    }

    if (!pricing) {
      this.logger.warn(`No pricing data for ${provider}:${model}`);
      return 0;
    }

    // Cost per 1M tokens, so divide by 1,000,000
    const inputCost = (inputTokens / 1_000_000) * pricing.input;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;

    return inputCost + outputCost;
  }

  /**
   * Generate text using the specified AI provider
   */
  async generateText(
    prompt: string,
    config: AIProviderConfig,
    task?: AITaskKind,
    overrides?: AIGenerateOverrides,
  ): Promise<AIResponse> {
    this.logger.log(`Generating text with provider: ${config.provider}, model: ${config.model}, task: ${task ?? 'unspecified'}`);

    // Per-task default, unless this particular call asked for its own.
    const temperature = overrides?.temperature ?? temperatureForTask(task);

    switch (config.provider) {
      case 'local':
        return this.generateWithLocal(prompt, temperature);
      case 'claude':
        // Cloud providers get NO sampling params (see generateWithClaude).
        return this.generateWithClaude(prompt, config);
      case 'openai':
        // Cloud providers get NO sampling params (see generateWithOpenAI).
        return this.generateWithOpenAI(prompt, config);
      case 'ollama':
        return this.generateWithOllama(prompt, config, temperature, task, overrides);
      default:
        throw new Error(`Unsupported AI provider: ${config.provider}`);
    }
  }

  /**
   * Generate text using Claude API
   *
   * NOTE: We deliberately send NO sampling parameters (temperature/top_p/top_k)
   * on Claude requests. Newer Claude model families (e.g. claude-sonnet-5,
   * claude-opus-4-7/4-8, claude-fable-*, claude-mythos-*) REMOVE these params —
   * sending a non-default value returns 400 invalid_request_error
   * ("`temperature` is deprecated for this model."). Older models accept
   * temperature but don't require it, so omitting it everywhere is the single
   * behavior that works across all Claude models. Prompting is the intended
   * steering mechanism. Do not reintroduce temperature here.
   */
  private async generateWithClaude(
    prompt: string,
    config: AIProviderConfig,
  ): Promise<AIResponse> {
    if (!config.apiKey) {
      throw new Error('Claude API key is required');
    }

    // Initialize Anthropic client if needed
    if (!this.anthropic || this.anthropic.apiKey !== config.apiKey) {
      this.anthropic = new Anthropic({
        apiKey: config.apiKey,
      });
    }

    try {
      const message = await this.anthropic.messages.create({
        model: config.model,
        max_tokens: 4096,
        // No temperature / top_p / top_k — removed on newer Claude models (400).
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const textContent = message.content.find((block) => block.type === 'text');
      const text = stripThinkTags(textContent && 'text' in textContent ? textContent.text : '');

      const inputTokens = message.usage.input_tokens;
      const outputTokens = message.usage.output_tokens;
      const estimatedCost = this.calculateCost('claude', config.model, inputTokens, outputTokens);

      this.logger.log(
        `Claude tokens: ${inputTokens} input + ${outputTokens} output = ${inputTokens + outputTokens} total (≈$${estimatedCost.toFixed(4)})`,
      );

      return {
        text,
        tokensUsed: inputTokens + outputTokens,
        inputTokens,
        outputTokens,
        estimatedCost,
        provider: 'claude',
        model: config.model,
      };
    } catch (error) {
      this.logger.error(`Claude API error: ${(error as Error).message}`);
      throw new Error(`Claude API error: ${(error as Error).message}`);
    }
  }

  /**
   * Generate text using OpenAI API
   *
   * NOTE: No sampling parameters (temperature) are sent — newer OpenAI models
   * likewise reject non-default sampling params, and omitting it keeps this
   * path uniform with the Claude path. Do not reintroduce temperature here.
   */
  private async generateWithOpenAI(
    prompt: string,
    config: AIProviderConfig,
  ): Promise<AIResponse> {
    if (!config.apiKey) {
      throw new Error('OpenAI API key is required');
    }

    // Initialize OpenAI client if needed
    if (!this.openai || this.openai.apiKey !== config.apiKey) {
      this.openai = new OpenAI({
        apiKey: config.apiKey,
      });
    }

    // OpenAI reasoning models (o1/o3/o4/…) reject `max_tokens` (400) and require
    // `max_completion_tokens`. Match the whole `o<digit>` family, not just o1.
    // gpt-* models are unaffected and keep using `max_tokens`.
    const isReasoningModel = /^o\d/.test(config.model);

    try {
      const completion = await this.openai.chat.completions.create({
        model: config.model,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        ...(isReasoningModel ? { max_completion_tokens: 4096 } : { max_tokens: 4096 }),
        // No temperature — omitted for all cloud providers.
      });

      const text = stripThinkTags(completion.choices[0]?.message?.content || '');

      const inputTokens = completion.usage?.prompt_tokens || 0;
      const outputTokens = completion.usage?.completion_tokens || 0;
      const tokensUsed = inputTokens + outputTokens;
      const estimatedCost = this.calculateCost('openai', config.model, inputTokens, outputTokens);

      this.logger.log(
        `OpenAI tokens: ${inputTokens} input + ${outputTokens} output = ${tokensUsed} total (≈$${estimatedCost.toFixed(4)})`,
      );

      return {
        text,
        tokensUsed,
        inputTokens,
        outputTokens,
        estimatedCost,
        provider: 'openai',
        model: config.model,
      };
    } catch (error) {
      this.logger.error(`OpenAI API error: ${(error as Error).message}`);
      throw new Error(`OpenAI API error: ${(error as Error).message}`);
    }
  }

  /**
   * Generate text using Ollama (existing implementation)
   */
  private async generateWithOllama(
    prompt: string,
    config: AIProviderConfig,
    temperature: number,
    task?: AITaskKind,
    overrides?: AIGenerateOverrides,
  ): Promise<AIResponse> {
    const ollamaEndpoint = config.ollamaEndpoint || 'http://localhost:11434';

    // Negotiate thinking PER TASK: only judgment-heavy tasks (flags, chapter)
    // ask a capable model to reason, because a thinking call costs ~1,900+
    // output tokens and generation time tracks output tokens. Capable models on
    // those tasks get { think: true } and their chain-of-thought lands in the
    // separate `thinking` response field (verified empirically); every other
    // task, and every non-thinking model, gets no think field.
    const { fields: thinkFields, thinking, level } = await negotiateOllamaThink(ollamaEndpoint, config.model, task);

    // num_predict must cover the generation that shares the context window with
    // the prompt. Thinking burns tokens on reasoning we discard, so budget
    // generously when active; otherwise these outputs are small JSON/text.
    const numPredict = thinking ? 8192 : 2048;

    // Bucketed, model-size-capped num_ctx: the old 131072 cap would allocate a
    // full 128K KV cache and spill any real model to CPU. Bucketing avoids the
    // full-model reload Ollama does on every num_ctx change.
    // A caller running a batch of same-shaped calls may pin num_ctx for the whole
    // batch (it sizes from its largest prompt), which avoids the reload Ollama
    // does whenever num_ctx changes.
    const numCtx = overrides?.numCtx ?? estimateNumCtx(prompt.length, config.model, numPredict);

    this.logger.debug(
      `Ollama request: model=${config.model}, num_ctx=${numCtx}, num_predict=${numPredict}, ` +
      `temperature=${temperature}, thinking=${thinking}${level ? ` (${level})` : ''}`,
    );

    // Remember what we loaded so shutdown can release exactly this and no more.
    this.ollamaModelsInUse.add(`${ollamaEndpoint}::${config.model}`);

    // Own the AbortController rather than using AbortSignal.timeout, so shutdown
    // can cancel a generation in progress. Ollama serializes requests per model,
    // so an unload queued behind a running 2-minute call would never land inside
    // the shutdown budget — cancelling first is what makes release possible.
    // 10 minutes, not 5. This clock starts when the request is ISSUED, but Ollama
    // queues requests it cannot serve concurrently — so a queued call spends most
    // of its budget waiting, not generating. A measured flag call already takes
    // ~230s of pure generation; at the old 300s a single queued request was
    // aborted after 69s of real work and retried from scratch, costing more time
    // than it saved.
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), 600000);
    this.inFlightOllama.add(controller);

    try {
      const post = (fields: Record<string, unknown>) =>
        fetch(`${ollamaEndpoint}/api/generate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          // A wedged Ollama must not block the serialized pipeline forever.
          signal: controller.signal,
          body: JSON.stringify({
            model: config.model,
            prompt: prompt,
            stream: false,
            // Per-call keep_alive keeps the model resident across the whole job
            // without needing an out-of-band ping timer.
            keep_alive: '5m',
            // Structured output, when the caller needs the answer to parse.
            ...(overrides?.format ? { format: overrides.format } : {}),
            ...fields,
            options: {
              num_ctx: numCtx,
              num_predict: numPredict,
              temperature,
            },
          }),
        });

      let response = await post(thinkFields);

      // Graded think levels are only honored "for supported models" and there is
      // no capability flag for it. A 4xx while sending one means this model does
      // not take levels — remember that and retry once with plain think:true,
      // rather than failing a task over a performance optimization.
      if (!response.ok && level && response.status >= 400 && response.status < 500) {
        markGradedThinkUnsupported(ollamaEndpoint, config.model);
        response = await post({ think: true });
      }

      if (!response.ok) {
        throw new Error(`Ollama API returned status ${response.status}`);
      }

      const data = await response.json();

      // Read ONLY the `response` field — never concatenate `thinking`. Defensively
      // strip any inline <think>…</think> for models whose template inlines it.
      let text = stripThinkTags(typeof data.response === 'string' ? data.response : '');

      // STRUCTURED-OUTPUT TRAP, measured on Ollama with qwen3.8:27b:
      // when `format: 'json'` is sent to a THINKING model, the JSON grammar
      // constrains the whole output stream from the first token, so the model
      // never opens an answer channel — the object it emits is classified as
      // reasoning and arrives in `thinking` with `response` EMPTY:
      //   format+think:low -> eval_count 29,  response "",  thinking '{"quote": ...}'
      //   think:low alone  -> eval_count 261, response '{"quote": ...}'
      // The constrained call is both correct and ~5x cheaper, so it is worth
      // keeping: when structured output was REQUESTED and `response` came back
      // empty, the object in `thinking` is the answer. This is deliberately
      // narrow — no format, or a non-empty `response`, and `thinking` is still
      // never read, because then it really is reasoning prose.
      // A JSON SCHEMA in `format` constrains the stream even harder than
      // `'json'` does, so this fallback matters MORE there, not less.
      if (!text && overrides?.format && typeof data.thinking === 'string' && data.thinking.trim()) {
        text = stripThinkTags(data.thinking);
        this.logger.debug(
          `Ollama returned the structured (${
            typeof overrides.format === 'string' ? overrides.format : 'schema'
          }) answer in the thinking field (empty response) — using it`,
        );
      }

      // Ollama returns token counts: prompt_eval_count (input), eval_count (output)
      const inputTokens = data.prompt_eval_count || 0;
      const outputTokens = data.eval_count || 0;
      const tokensUsed = inputTokens + outputTokens;

      this.logger.log(
        `Ollama tokens: ${inputTokens} input + ${outputTokens} output = ${tokensUsed} total (local, $0.00)`,
      );

      return {
        text,
        tokensUsed,
        inputTokens,
        outputTokens,
        estimatedCost: 0, // Local models are free
        provider: 'ollama',
        model: config.model,
        // Surfaced so callers can reject a truncated answer instead of parsing
        // a fragment of one (done_reason === 'length').
        doneReason: typeof data.done_reason === 'string' ? data.done_reason : undefined,
      };
    } catch (error) {
      // A cancelled generation during shutdown is expected, not a fault.
      if (this.releasingOllama) {
        throw new Error('Ollama request cancelled: application is shutting down');
      }
      this.logger.error(`Ollama API error: ${(error as Error).message}`);
      throw new Error(`Ollama API error: ${(error as Error).message}`);
    } finally {
      clearTimeout(timeoutHandle);
      this.inFlightOllama.delete(controller);
    }
  }

  /**
   * Release every Ollama model THIS app loaded, so quitting Briefcase frees the
   * VRAM instead of leaving 17-25GB resident until Ollama's keep_alive expires.
   *
   * Ollama is a shared daemon and other apps may have their own models loaded,
   * so this unloads only the models tracked in `ollamaModelsInUse` — never a
   * blanket unload. `keep_alive: 0` with no prompt is Ollama's unload request.
   *
   * Never throws: shutdown must proceed even if Ollama is already gone.
   */
  async releaseOllamaModels(): Promise<void> {
    if (this.ollamaModelsInUse.size === 0) return;
    this.releasingOllama = true;

    // Cancel in-flight generations FIRST. Ollama serializes per model, so an
    // unload sent while a long call is running would sit in the queue until it
    // finished — long past the point the process gets killed.
    for (const controller of this.inFlightOllama) {
      try { controller.abort(); } catch { /* already settled */ }
    }
    this.inFlightOllama.clear();

    const targets = [...this.ollamaModelsInUse];
    this.ollamaModelsInUse.clear();

    await Promise.all(
      targets.map(async (key) => {
        const sep = key.indexOf('::');
        const endpoint = key.slice(0, sep);
        const model = key.slice(sep + 2);
        try {
          await fetch(`${endpoint}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // Must fit inside the parent's shutdown grace period.
            signal: AbortSignal.timeout(2000),
            body: JSON.stringify({ model, keep_alive: 0 }),
          });
          this.logger.log(`[Shutdown] Released Ollama model: ${model}`);
        } catch (error) {
          this.logger.warn(`[Shutdown] Could not release ${model}: ${(error as Error).message}`);
        }
      }),
    );
  }

  /**
   * Generate text using bundled local AI (Cogito 8B via llama.cpp)
   */
  private async generateWithLocal(prompt: string, temperature: number): Promise<AIResponse> {
    if (!this.llamaManager.isAvailable()) {
      throw new Error('Local AI model not available. Please reinstall the application.');
    }

    try {
      const result = await this.llamaManager.generateText(prompt, { temperature });

      this.logger.log(
        `Local AI tokens: ${result.inputTokens} input + ${result.outputTokens} output = ${result.totalTokens} total (local, $0.00)`,
      );

      return {
        text: stripThinkTags(result.text),
        tokensUsed: result.totalTokens,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        estimatedCost: 0, // Local model is free
        provider: 'local',
        model: result.model,
      };
    } catch (error) {
      this.logger.error(`Local AI error: ${(error as Error).message}`);
      throw new Error(`Local AI error: ${(error as Error).message}`);
    }
  }

  /**
   * Test if an AI provider is accessible and configured correctly
   */
  async testProvider(config: AIProviderConfig): Promise<{ success: boolean; error?: string }> {
    try {
      await this.generateText('Test connection. Respond with "OK".', config);
      return { success: true };
    } catch (error) {
      this.logger.error(`Provider test failed: ${(error as Error).message}`);
      return { success: false, error: (error as Error).message };
    }
  }
}
