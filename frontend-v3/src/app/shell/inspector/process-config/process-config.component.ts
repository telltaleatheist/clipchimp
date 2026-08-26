import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import { getApiBase } from '../../../core/runtime-url';
import { ErrorSurface } from '../../../core/error-surface.service';
import { LibraryService } from '../../../services/library.service';
import { AiSetupService } from '../../../services/ai-setup.service';
import {
  PIPELINE_STEPS,
  PipelinePreset,
  PipelinePresetsService,
  PipelineStep,
  PipelineStepType,
  sortPipelineSteps,
} from '../../../core/stores/pipeline-presets.service';

/** An installed whisper model as reported by GET /media/whisper-models. */
interface WhisperModelOption {
  id: string;
  name: string;
  description?: string;
}

type AiProvider = 'local' | 'ollama' | 'claude' | 'openai';

/** A selectable AI model, grouped by provider in the picker. */
interface AiModelOption {
  value: string; // "provider:model"
  label: string;
  provider: AiProvider;
}

/** One row from GET /database/custom-instructions-history. */
interface InstructionHistoryItem {
  id: number;
  instruction_text: string;
  used_at: string;
}

/**
 * The Process configuration panel — compose a pipeline of job steps (in run
 * order) for the selected videos, save combinations as named presets, queue
 * with one click. Lives in the right inspector (single- and multi-select
 * alike); it replaced the toolbar's Process popover.
 *
 * Dumb component: selection counts + AI readiness in via inputs, intents out
 * via outputs. Sticky last-used state restores from PipelinePresetsService.
 */
@Component({
  selector: 'app-process-config',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './process-config.component.html',
  styleUrls: ['./process-config.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProcessConfigComponent {
  private presetsService = inject(PipelinePresetsService);
  private http = inject(HttpClient);
  private destroyRef = inject(DestroyRef);
  private library = inject(LibraryService);
  private aiSetup = inject(AiSetupService);
  private errorSurface = inject(ErrorSurface);

  selectionCount = input(0);
  /** Selected videos lacking a transcript / analysis (from InspectorStore). */
  withoutTranscript = input(0);
  notAnalyzed = input(0);
  aiReady = input(false);
  /** AI readiness unknown — the availability probe failed (retry, don't lie). */
  aiCheckFailed = input(false);

  /**
   * Per-job mode. When non-null, this panel edits ONE already-staged job's
   * pipeline rather than composing a fresh one: enabled steps + configs are
   * seeded from these steps (merged over defaults), and every global side
   * effect (sticky persistence, enableSteps channel) is suppressed so editing
   * one pending job never mutates shared defaults.
   * Null = the normal compose mode (library selection).
   */
  initialSteps = input<PipelineStep[] | null>(null);
  /**
   * Whether toggles/option changes persist to the sticky last-used state and
   * global defaults. False in per-job mode. Also gates submit's rememberSteps().
   */
  persistSticky = input(true);
  /** Submit button label. "Add to Queue" (compose) vs "Save to N pending". */
  submitLabel = input('Add to Queue');
  /**
   * Chrome toggles for host embedding. The Add popover hides both: it supplies
   * its own "Add media" context (no "Process / N selected" header) and its own
   * full-width Download button (no summary+submit footer), reading the composed
   * steps via composedSteps() at its own submit. Inspector usages leave both on.
   */
  showHeader = input(true);
  showFooter = input(true);
  /**
   * An external reason to block submit (shown in the footer, disables the
   * button). The queue-page trim block sets this when a trim time is invalid.
   */
  submitBlockedReason = input<string | null>(null);

  submitSteps = output<PipelineStep[]>();
  setupAi = output<void>();
  retryAi = output<void>();
  /** No whisper models installed — take the user to Settings → Components. */
  openComponents = output<void>();

  readonly stepDefs = PIPELINE_STEPS;
  presets = this.presetsService.presets;

  /** Enabled state per step type. */
  private enabled = signal<Record<PipelineStepType, boolean>>(this.restoreEnabled());
  /** Per-step config (createQueueTask options). */
  private configs = signal<Record<PipelineStepType, Record<string, unknown>>>(this.restoreConfigs());

  /** Per-step options accordion — each enabled step expands independently. */
  private expandedSteps = signal<Partial<Record<PipelineStepType, boolean>>>({});

  /** Inline save-as-preset mode. */
  savingPreset = signal(false);
  presetName = signal('');

  /** Last enableSteps() token this instance handled (see PipelinePresetsService). */
  private lastSeenEnableToken = this.presetsService.enableStepsRequest().token;

  constructor() {
    // Installed models gate the transcribe step (submit stays blocked until we
    // know one is installed), so fetch as soon as transcribe is on — not only
    // when its options happen to be expanded.
    if (this.enabled()['transcribe']) {
      this.loadWhisperModels();
    }

    // Per-job mode: (re)seed enabled/configs from the selected job's steps
    // whenever the input changes (selection moving to a different job re-seeds
    // in place, no component recreation). Merged over defaults so a job saved
    // before a step gained new option fields never surfaces undefined.
    effect(() => {
      const steps = this.initialSteps();
      if (steps === null) return;
      untracked(() => this.seedFromSteps(steps));
    }, { allowSignalWrites: true });

    // Live-enable steps requested from elsewhere (e.g. the cascade's Run
    // Analysis / View Transcript). A freshly-mounted instance instead picks the
    // steps up from the already-updated sticky lastSteps, so it treats the
    // construction-time token as already seen and only reacts to later bumps.
    // Ignored entirely in per-job mode — enableSteps is a compose-mode concept.
    effect(() => {
      const req = this.presetsService.enableStepsRequest();
      if (req.token === this.lastSeenEnableToken) return;
      this.lastSeenEnableToken = req.token;
      if (this.initialSteps() !== null) return;
      untracked(() => this.applyEnableSteps(req.types));
    }, { allowSignalWrites: true });

    // AI-analyze options (sensitivity default, model list, instruction history)
    // load once the step is both enabled and AI is ready — mirrors how the
    // transcribe step gates on installed whisper models.
    effect(() => {
      if (this.isEnabled('ai-analyze')) {
        untracked(() => this.ensureAiData());
      }
    }, { allowSignalWrites: true });

    // A preset apply or stale sticky state can leave ai-analyze without a
    // model; once the available models are known, seed the empty picker in
    // preference order — last chosen, then the configured default. A non-empty
    // value short-circuits, so the user's own pick / a job's saved model wins.
    effect(() => {
      const seed = this.preferredSeedModel();
      if (!seed || !this.isEnabled('ai-analyze')) return;
      if (String(this.configs()['ai-analyze']['aiModel'] ?? '')) return;
      untracked(() => this.setOption('ai-analyze', 'aiModel', seed));
    }, { allowSignalWrites: true });
  }

  private applyEnableSteps(types: PipelineStepType[]): void {
    if (types.length === 0) return;
    this.enabled.update(state => {
      const next = { ...state };
      for (const type of types) next[type] = true;
      return next;
    });
    if (types.includes('transcribe')) {
      this.ensureWhisperModels();
    }
    this.persistStickyState();
  }

  /**
   * Per-job mode seeding: turn on exactly the steps present in `steps` and merge
   * each one's config over the step defaults (task types outside the four
   * pipeline steps are ignored — they're preserved separately on save). No
   * sticky/global writes: editing one pending job must not mutate defaults.
   */
  private seedFromSteps(steps: PipelineStep[]): void {
    const enabled = { ...this.blankEnabled() };
    const configs = { ...this.defaultConfigs() };
    for (const step of steps) {
      if (!(step.type in enabled)) continue;
      enabled[step.type] = true;
      configs[step.type] = { ...configs[step.type], ...step.config };
    }
    this.enabled.set(enabled);
    this.configs.set(configs);
    this.expandedSteps.set({});
    if (enabled['transcribe']) {
      this.ensureWhisperModels();
    }
  }

  isExpanded(type: PipelineStepType): boolean {
    return this.expandedSteps()[type] === true;
  }

  isEnabled(type: PipelineStepType): boolean {
    return this.enabled()[type] && (type !== 'ai-analyze' || this.aiReady());
  }

  config(type: PipelineStepType): Record<string, unknown> {
    return this.configs()[type];
  }

  /** The composed pipeline, in canonical run order. */
  steps = computed<PipelineStep[]>(() => {
    const enabled = this.enabled();
    const configs = this.configs();
    return this.stepDefs
      .filter(def => enabled[def.type] && (def.type !== 'ai-analyze' || this.aiReady()))
      .map(def => ({ type: def.type, config: { ...configs[def.type] } }));
  });

  /**
   * Host-facing read of the composed pipeline, sorted into canonical run order
   * — for embedders (the Add popover) that own their own submit button and read
   * the steps directly via a viewChild reference instead of the submitSteps
   * output. Mirrors what submit() emits.
   */
  composedSteps(): PipelineStep[] {
    return sortPipelineSteps(this.steps());
  }

  /** "3 of 5 already transcribed"-style hint per step, when relevant. */
  doneHint(type: PipelineStepType): string | null {
    const total = this.selectionCount();
    if (total === 0) return null;
    if (type === 'transcribe') {
      const done = total - this.withoutTranscript();
      return done > 0 ? `${done} of ${total} already transcribed` : null;
    }
    if (type === 'ai-analyze') {
      const done = total - this.notAnalyzed();
      return done > 0 ? `${done} of ${total} already analyzed` : null;
    }
    return null;
  }

  // ── Installed whisper models (fetched when transcribe is enabled) ──────────

  /** null = not fetched yet; [] = fetched, none installed. */
  whisperModels = signal<WhisperModelOption[] | null>(null);
  whisperModelsLoading = signal(false);
  whisperModelsError = signal(false);

  /** Fetched and nothing is installed — transcribe cannot run. */
  whisperModelsEmpty = computed(() => {
    const models = this.whisperModels();
    return models !== null && models.length === 0;
  });

  /**
   * The persisted model value when it isn't among the installed models — shown
   * as a "(not installed)" option rather than silently dropped. Only when other
   * models exist; with nothing installed we show install guidance instead.
   */
  missingModelValue = computed<string | null>(() => {
    const models = this.whisperModels();
    if (models === null || models.length === 0) return null;
    const current = String(this.config('transcribe')['model'] ?? '');
    if (!current) return null;
    return models.some(m => m.id === current) ? null : current;
  });

  loadWhisperModels(): void {
    this.whisperModelsLoading.set(true);
    this.whisperModelsError.set(false);
    this.http
      .get<{ success: boolean; models: WhisperModelOption[] }>(`${getApiBase()}/media/whisper-models`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: response => {
          this.whisperModels.set(response?.models ?? []);
          this.whisperModelsLoading.set(false);
        },
        error: () => {
          // Surfaced inline (with a retry) and blocks submit — never silently
          // fall back to a model that might not be installed.
          this.whisperModelsError.set(true);
          this.whisperModelsLoading.set(false);
        },
      });
  }

  private ensureWhisperModels(): void {
    if (this.whisperModels() === null && !this.whisperModelsLoading()) {
      this.loadWhisperModels();
    }
  }

  /**
   * transcribe is enabled but no installed model is verified/selected — Start
   * must stay disabled so we never queue a transcribe that fails at runtime.
   */
  transcribeBlocked = computed(() => {
    if (!this.isEnabled('transcribe')) return false;
    if (this.whisperModelsLoading() || this.whisperModelsError()) return true;
    const models = this.whisperModels();
    if (models === null) return true; // never fetched — can't verify
    const current = String(this.config('transcribe')['model'] ?? '');
    return !models.some(m => m.id === current);
  });

  // ── AI analyze options: custom instructions, model picker ─────────────────
  // Loaded lazily (once) when the analyze step is enabled and AI is ready.

  private aiDataLoaded = false;

  private ensureAiData(): void {
    if (this.aiDataLoaded) return;
    this.aiDataLoaded = true;
    void this.loadAiModels();
    void this.loadInstructionsHistory();
  }

  // THE DETECTION-SENSITIVITY SLIDER USED TO BE HERE, AND IS GONE ON PURPOSE.
  //
  // It was a 1-5 dial that changed what an analysis DID. Under the operator's
  // 2026-08-25 ruling the analysis always captures everything and stores every
  // verdict, and the dial became a display filter in the video editor's analysis
  // panel. The operator then removed the run-side control outright: "not sure we
  // need the 1-5 run slider anymore after we've turned it into a filter."
  //
  // So this surface no longer sets `analysisGranularity` at all — it is not sent
  // with the job, and the field survives in the request models only as an
  // optional one for API compatibility. The stored `defaultGranularity` in
  // app-config.json is now config-file-only: the DISCOVERY fallback flag path
  // (a machine with no NLI worker environment) still reads it as a real run
  // input, because it asks one open-ended question per chapter and has no scored
  // candidate list to filter afterwards. There is no UI in front of it anywhere.

  // Custom instructions + history --------------------------------------------

  instructionsHistory = signal<InstructionHistoryItem[]>([]);
  instructionsHistoryLoading = signal(false);
  instructionsHistoryError = signal(false);
  showInstructionsDropdown = signal(false);

  async loadInstructionsHistory(): Promise<void> {
    this.instructionsHistoryLoading.set(true);
    this.instructionsHistoryError.set(false);
    try {
      const response = await firstValueFrom(this.library.getCustomInstructionsHistory());
      this.instructionsHistory.set(response.success ? response.history : []);
    } catch {
      this.instructionsHistoryError.set(true);
    } finally {
      this.instructionsHistoryLoading.set(false);
    }
  }

  toggleInstructionsDropdown(): void {
    this.showInstructionsDropdown.update(v => !v);
  }

  selectHistoryItem(text: string): void {
    this.setOption('ai-analyze', 'customInstructions', text);
    this.showInstructionsDropdown.set(false);
  }

  truncateInstruction(text: string, maxLength = 60): string {
    return text.length <= maxLength ? text : text.substring(0, maxLength) + '…';
  }

  onTextOption(type: PipelineStepType, key: string, event: Event): void {
    this.setOption(type, key, (event.target as HTMLTextAreaElement).value);
  }

  // AI model picker ----------------------------------------------------------

  aiModels = signal<AiModelOption[]>([]);
  aiModelsLoading = signal(false);
  aiModelsError = signal(false);
  /** The configured default ("provider:model"), when it is an installed model. */
  defaultAiModel = signal('');

  private readonly providerLabels: Record<AiProvider, string> = {
    local: 'Local',
    ollama: 'Ollama',
    claude: 'Claude',
    openai: 'OpenAI',
  };

  /** Installed models grouped by provider, in a stable provider order. */
  modelGroups = computed(() => {
    const models = this.aiModels();
    const order: AiProvider[] = ['local', 'ollama', 'claude', 'openai'];
    return order
      .map(provider => ({
        provider,
        label: this.providerLabels[provider],
        models: models.filter(m => m.provider === provider),
      }))
      .filter(group => group.models.length > 0);
  });

  /** The chosen model isn't in the installed list — shown "(unavailable)". */
  missingAiModel = computed<string | null>(() => {
    if (this.aiModelsLoading() || this.aiModelsError()) return null;
    const current = String(this.config('ai-analyze')['aiModel'] ?? '');
    if (!current) return null;
    return this.aiModels().some(m => m.value === current) ? null : current;
  });

  isCurrentModelDefault = computed(() => {
    const current = String(this.config('ai-analyze')['aiModel'] ?? '');
    return current.length > 0 && current === this.defaultAiModel();
  });

  async loadAiModels(): Promise<void> {
    this.aiModelsLoading.set(true);
    this.aiModelsError.set(false);
    try {
      const models: AiModelOption[] = [];

      // Downloaded local (bundled) models — getLocalModels never throws.
      const local = await firstValueFrom(this.aiSetup.getLocalModels());
      for (const model of local.models.filter(m => m.downloaded)) {
        models.push({ value: `local:${model.id}`, label: `${model.name} (Local)`, provider: 'local' });
      }

      const availability = await this.aiSetup.checkAIAvailability();

      if (availability.hasOllama) {
        for (const model of availability.ollamaModels) {
          models.push({ value: `ollama:${model}`, label: model, provider: 'ollama' });
        }
      }

      if (availability.hasClaudeKey) {
        const claude = await firstValueFrom(
          this.http.get<{ success: boolean; models: { value: string; label: string }[] }>(
            `${getApiBase()}/config/claude-models`
          )
        );
        if (claude.success) {
          for (const m of claude.models) models.push({ value: m.value, label: m.label, provider: 'claude' });
        }
      }

      if (availability.hasOpenAIKey) {
        const openai = await firstValueFrom(
          this.http.get<{ success: boolean; models: { value: string; label: string }[] }>(
            `${getApiBase()}/config/openai-models`
          )
        );
        if (openai.success) {
          for (const m of openai.models) models.push({ value: m.value, label: m.label, provider: 'openai' });
        }
      }

      this.aiModels.set(models);

      // Resolve the configured server-side default — it drives the "This is your
      // default model" note and Save-as-default, separately from what seeds the
      // picker.
      const saved = await firstValueFrom(this.library.getDefaultAI());
      if (saved.success && saved.defaultAI) {
        const value = `${saved.defaultAI.provider}:${saved.defaultAI.model}`;
        if (models.some(m => m.value === value)) {
          this.defaultAiModel.set(value);
        }
      }

      // When the step has no explicit model yet, seed it (last chosen, then the
      // configured default) so submit sends an explicit model — which then wins
      // over library-page's downstream default injection.
      this.seedAiModelIfEmpty();
    } catch {
      this.aiModelsError.set(true);
    } finally {
      this.aiModelsLoading.set(false);
    }
  }

  /** Persist the currently-chosen model as the global default (POST). */
  saveAiAsDefault(): void {
    const value = String(this.config('ai-analyze')['aiModel'] ?? '');
    const firstColon = value.indexOf(':');
    if (firstColon < 0) return;
    const provider = value.slice(0, firstColon);
    const model = value.slice(firstColon + 1);
    this.library
      .saveDefaultAI(provider, model)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.defaultAiModel.set(value),
        error: error => this.errorSurface.surfaceError("Couldn't save default AI model", error),
      });
  }

  /**
   * The AI model picker's change handler. Applies the pick like any option, and
   * ALSO records it as the user's remembered last model — a personal preference,
   * so it's written in every host including per-job mode (the other per-job
   * suppressions stand; this isn't job config). Seeding never routes through
   * here, so only real user picks are remembered.
   */
  onAiModelValue(value: string): void {
    this.setOption('ai-analyze', 'aiModel', value);
    this.presetsService.rememberAiModel(value);
  }

  /**
   * Preferred value to seed an EMPTY ai-analyze picker, in order: the last model
   * the user chose (if still available) → the configured server-side default →
   * none. Reads signals, so effects that call it re-run as models/defaults load.
   */
  private preferredSeedModel(): string {
    const models = this.aiModels();
    const remembered = this.presetsService.lastChosenAiModel();
    if (remembered && models.some(m => m.value === remembered)) return remembered;
    const configured = this.defaultAiModel();
    if (configured && models.some(m => m.value === configured)) return configured;
    return '';
  }

  /**
   * Fill ai-analyze's model only when it has none — a fresh compose state or a
   * preset without a model. An explicit value (a job's saved model in per-job
   * mode, sticky config) always wins because we short-circuit on non-empty.
   */
  private seedAiModelIfEmpty(): void {
    if (String(this.config('ai-analyze')['aiModel'] ?? '')) return;
    const seed = this.preferredSeedModel();
    if (seed) this.setOption('ai-analyze', 'aiModel', seed);
  }

  // Normalize-audio target loudness ------------------------------------------

  audioLevelValue = computed(() => Number(this.config('normalize-audio')['targetLevel'] ?? -16));
  audioLevelDescription = computed(() => this.getAudioLevelDescription(this.audioLevelValue()));

  getAudioLevelDescription(level: number): string {
    if (level <= -22) return 'Very quiet - suitable for background music or ambient content';
    if (level <= -19) return 'Quiet - similar to traditional broadcast standards (EBU R128)';
    if (level <= -17) return 'Moderate - good for podcasts and general web content';
    if (level <= -15) return 'Standard - typical for YouTube and streaming platforms';
    return 'Loud - maximizes perceived volume, may reduce dynamic range';
  }

  summary = computed(() => {
    const stepCount = this.steps().length;
    const videos = this.selectionCount();
    if (stepCount === 0) return 'Pick at least one step';
    const stepsText = `${stepCount} step${stepCount === 1 ? '' : 's'}`;
    const videosText = `${videos} video${videos === 1 ? '' : 's'}`;
    return `${stepsText} → ${videosText}`;
  });

  /** Why Start is disabled, when it is (honest and actionable). */
  blockReason = computed<string | null>(() => {
    const external = this.submitBlockedReason();
    if (external) return external;
    if (this.selectionCount() === 0) return 'Select at least one video';
    if (this.steps().length === 0) return 'Pick at least one step';
    if (this.isEnabled('transcribe')) {
      if (this.whisperModelsLoading()) return 'Checking installed models…';
      if (this.whisperModelsError()) return "Couldn't verify installed models";
      if (this.whisperModelsEmpty()) return 'No transcription models installed';
      if (this.missingModelValue()) return "Chosen model isn't installed";
    }
    return null;
  });

  canSubmit = computed(
    () =>
      this.steps().length > 0 &&
      this.selectionCount() > 0 &&
      !this.transcribeBlocked() &&
      !this.submitBlockedReason()
  );

  /** A preset chip highlights when it matches the current composition. */
  isPresetActive(preset: PipelinePreset): boolean {
    const current = this.steps();
    if (current.length !== preset.steps.length) return false;
    return preset.steps.every(ps => {
      const step = current.find(s => s.type === ps.type);
      return !!step && JSON.stringify(step.config) === JSON.stringify(ps.config);
    });
  }

  toggleStep(type: PipelineStepType): void {
    this.enabled.update(state => ({ ...state, [type]: !state[type] }));
    if (!this.enabled()[type]) {
      this.expandedSteps.update(state => ({ ...state, [type]: false }));
    } else if (type === 'transcribe') {
      this.ensureWhisperModels();
    }
    this.persistStickyState();
  }

  toggleExpanded(type: PipelineStepType): void {
    this.expandedSteps.update(state => ({ ...state, [type]: !state[type] }));
    if (type === 'transcribe') {
      this.ensureWhisperModels();
    }
  }

  setOption(type: PipelineStepType, key: string, value: unknown): void {
    this.configs.update(state => ({
      ...state,
      [type]: { ...state[type], [key]: value },
    }));
    this.persistStickyState();
  }

  /**
   * Options are sticky: every toggle/option change persists the current
   * composition immediately (not just on submit). Persisted from the raw
   * enabled set — a temporarily AI-unready analyze step is remembered, not
   * silently dropped. No-op in per-job mode (persistSticky = false), so
   * editing one staged job never rewrites the shared last-used state.
   */
  private persistStickyState(): void {
    if (!this.persistSticky()) return;
    const enabled = this.enabled();
    const configs = this.configs();
    const raw = this.stepDefs
      .filter(def => enabled[def.type])
      .map(def => ({ type: def.type, config: { ...configs[def.type] } }));
    this.presetsService.rememberSteps(raw);
  }

  onSelectOption(type: PipelineStepType, key: string, event: Event): void {
    this.setOption(type, key, (event.target as HTMLSelectElement).value);
  }

  onNumberOption(type: PipelineStepType, key: string, event: Event): void {
    this.setOption(type, key, Number((event.target as HTMLSelectElement).value));
  }

  onCheckboxOption(type: PipelineStepType, key: string, event: Event): void {
    this.setOption(type, key, (event.target as HTMLInputElement).checked);
  }

  applyPreset(preset: PipelinePreset): void {
    const enabled = { ...this.blankEnabled() };
    const configs = { ...this.defaultConfigs() };
    for (const step of preset.steps) {
      enabled[step.type] = true;
      // Merge over defaults — presets saved before a step gained new option
      // fields would otherwise resurface those fields as undefined.
      configs[step.type] = { ...configs[step.type], ...step.config };
    }
    this.enabled.set(enabled);
    this.configs.set(configs);
    this.expandedSteps.set({});
    if (enabled['transcribe']) {
      this.ensureWhisperModels();
    }
    this.persistStickyState();
  }

  deletePreset(id: string): void {
    this.presetsService.deletePreset(id);
  }

  startSavePreset(): void {
    this.savingPreset.set(true);
    this.presetName.set('');
  }

  confirmSavePreset(): void {
    const name = this.presetName().trim();
    if (!name || this.steps().length === 0) return;
    this.presetsService.savePreset(name, this.steps());
    this.savingPreset.set(false);
  }

  cancelSavePreset(): void {
    this.savingPreset.set(false);
  }

  onPresetNameInput(event: Event): void {
    this.presetName.set((event.target as HTMLInputElement).value);
  }

  submit(): void {
    if (!this.canSubmit()) return;
    const steps = sortPipelineSteps(this.steps());
    if (steps.length === 0) return;
    if (this.persistSticky()) {
      this.presetsService.rememberSteps(steps);
    }
    this.submitSteps.emit(steps);
  }

  // ── Initial state: restore the last-used combination ──────────────────────

  private blankEnabled(): Record<PipelineStepType, boolean> {
    return {
      'fix-aspect-ratio': false,
      'normalize-audio': false,
      transcribe: false,
      'ai-analyze': false,
    };
  }

  private defaultConfigs(): Record<PipelineStepType, Record<string, unknown>> {
    const configs = {} as Record<PipelineStepType, Record<string, unknown>>;
    for (const def of this.stepDefs) {
      configs[def.type] = { ...def.defaultConfig };
    }
    return configs;
  }

  private restoreEnabled(): Record<PipelineStepType, boolean> {
    const enabled = this.blankEnabled();
    const last = this.presetsService.lastSteps();
    if (last.length === 0) {
      // Sensible first-run default: the user's daily double.
      enabled.transcribe = true;
      enabled['ai-analyze'] = true;
      return enabled;
    }
    for (const step of last) {
      enabled[step.type] = true;
    }
    return enabled;
  }

  private restoreConfigs(): Record<PipelineStepType, Record<string, unknown>> {
    const configs = this.defaultConfigs();
    for (const step of this.presetsService.lastSteps()) {
      configs[step.type] = { ...configs[step.type], ...step.config };
    }
    return configs;
  }
}
