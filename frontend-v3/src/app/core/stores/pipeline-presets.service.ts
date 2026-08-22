import { Injectable, inject, signal } from '@angular/core';
import { TaskType } from '../../models/task.model';
import { ErrorSurface } from '../error-surface.service';

/**
 * Job steps the Process pipeline can queue for library videos.
 * Subset of TaskType: every entry here is verified end-to-end in the backend
 * queue-manager (fix-aspect-ratio / normalize-audio / transcribe / analyze).
 * Run order is fixed by QueueService.convertTasksToBackendFormat:
 * video processing first (aspect + audio combine into one process-video
 * pass), then transcribe, then AI analysis.
 */
export type PipelineStepType = Extract<
  TaskType,
  'fix-aspect-ratio' | 'normalize-audio' | 'transcribe' | 'ai-analyze'
>;

/** One enabled step with its task config (createQueueTask options shape). */
export interface PipelineStep {
  type: PipelineStepType;
  config: Record<string, unknown>;
}

/** A named, reusable step combination. */
export interface PipelinePreset {
  id: string;
  name: string;
  steps: PipelineStep[];
}

/** Display/default metadata per step, in pipeline run order. */
export const PIPELINE_STEPS: {
  type: PipelineStepType;
  label: string;
  description: string;
  defaultConfig: Record<string, unknown>;
}[] = [
  {
    type: 'fix-aspect-ratio',
    label: 'Fix Aspect Ratio',
    description: 'Crop or letterbox to a target ratio',
    defaultConfig: { targetRatio: '16:9', stripBlackBars: false },
  },
  {
    type: 'normalize-audio',
    label: 'Normalize Loudness',
    description: 'Even out audio levels',
    defaultConfig: { targetLevel: -16 },
  },
  {
    type: 'transcribe',
    label: 'Transcribe',
    description: 'Whisper transcript — no AI setup needed',
    defaultConfig: { model: 'base', language: 'en', translate: false },
  },
  {
    type: 'ai-analyze',
    label: 'AI Analyze',
    description: 'Sections & flags via your default AI model',
    defaultConfig: { analysisGranularity: 2, customInstructions: '', aiModel: '' },
  },
];

const STORAGE_KEY = 'briefcase-pipeline-presets';
/** The AI model the user last explicitly chose in the Process picker. */
const LAST_AI_MODEL_KEY = 'briefcase-last-ai-model';

interface StoredState {
  presets: PipelinePreset[];
  /** Last-used combination, restored when the popover opens. */
  lastSteps: PipelineStep[];
}

const STARTER_PRESETS: PipelinePreset[] = [
  {
    id: 'starter-transcribe-analyze',
    name: 'Transcribe + Analyze',
    steps: [
      { type: 'transcribe', config: { model: 'base', language: 'en', translate: false } },
      { type: 'ai-analyze', config: { analysisGranularity: 2, customInstructions: '', aiModel: '' } },
    ],
  },
  {
    id: 'starter-fix-normalize',
    name: 'Fix + Normalize',
    steps: [
      { type: 'fix-aspect-ratio', config: { targetRatio: '16:9', stripBlackBars: false } },
      { type: 'normalize-audio', config: { targetLevel: -16 } },
    ],
  },
];

const STEP_ORDER: PipelineStepType[] = PIPELINE_STEPS.map(s => s.type);

/** Sort steps into canonical pipeline run order. */
export function sortPipelineSteps(steps: PipelineStep[]): PipelineStep[] {
  return [...steps].sort((a, b) => STEP_ORDER.indexOf(a.type) - STEP_ORDER.indexOf(b.type));
}

/**
 * Named pipeline presets + last-used steps for the Process popover.
 * Follows the AddDefaultsService pattern: signal state, localStorage
 * persistence, resilient restore. Starter presets seed first run only.
 */
@Injectable({ providedIn: 'root' })
export class PipelinePresetsService {
  readonly presets = signal<PipelinePreset[]>([]);
  readonly lastSteps = signal<PipelineStep[]>([]);

  /**
   * The AI model the user last explicitly picked in the Process model picker
   * ("provider:model"). A personal preference, not job config — recorded even
   * in per-job mode — and used to seed an empty picker ahead of the configured
   * server-side default. Persisted under its own key.
   */
  readonly lastChosenAiModel = signal<string>('');

  constructor() {
    const restored = this.restore();
    this.presets.set(restored.presets);
    this.lastSteps.set(restored.lastSteps);
    this.lastChosenAiModel.set(this.restoreLastAiModel());
  }

  savePreset(name: string, steps: PipelineStep[]): PipelinePreset {
    const preset: PipelinePreset = {
      id: crypto.randomUUID(),
      name: name.trim(),
      steps: sortPipelineSteps(steps),
    };
    this.presets.update(list => [...list, preset]);
    this.persist();
    return preset;
  }

  deletePreset(id: string): void {
    this.presets.update(list => list.filter(p => p.id !== id));
    this.persist();
  }

  rememberSteps(steps: PipelineStep[]): void {
    this.lastSteps.set(sortPipelineSteps(steps));
    this.persist();
  }

  /**
   * Record the model the user just chose in the Process picker as their
   * remembered last model. A user preference (persisted even from per-job
   * mode); seeds an empty picker ahead of the configured default. Ignores
   * empties so clearing the picker never wipes the remembered value.
   */
  rememberAiModel(value: string): void {
    if (!value) return;
    this.lastChosenAiModel.set(value);
    try {
      localStorage.setItem(LAST_AI_MODEL_KEY, value);
    } catch (error) {
      this.errorSurface.surfaceError("Couldn't remember your last AI model", error);
    }
  }

  /**
   * Reactive request for a live ProcessConfigComponent to enable specific steps.
   * Monotonic token so an already-mounted component reacts exactly once per call;
   * a freshly-mounted component reads the (already-updated) sticky lastSteps and
   * treats the current token as "already seen".
   */
  readonly enableStepsRequest = signal<{ types: PipelineStepType[]; token: number }>({
    types: [],
    token: 0,
  });
  private enableStepsToken = 0;

  /**
   * Turn the given steps on: merge them into the sticky last-used composition
   * (keeping each already-remembered step's config, seeding new ones from their
   * defaults) and signal a live process-config to reflect it. The reveal itself
   * is a separate concern (WorkspaceActionsService.revealProcessConfig).
   *
   * An empty list is a no-op — it means "respect the sticky steps, just reveal".
   */
  enableSteps(types: PipelineStepType[]): void {
    if (types.length === 0) return;
    this.lastSteps.update(steps => {
      const present = new Set(steps.map(s => s.type));
      const additions: PipelineStep[] = [];
      for (const type of types) {
        if (present.has(type)) continue;
        const def = PIPELINE_STEPS.find(d => d.type === type);
        additions.push({ type, config: { ...(def?.defaultConfig ?? {}) } });
      }
      return additions.length ? sortPipelineSteps([...steps, ...additions]) : steps;
    });
    this.persist();
    this.enableStepsRequest.set({ types: [...types], token: ++this.enableStepsToken });
  }

  private errorSurface = inject(ErrorSurface);

  private persist(): void {
    try {
      const state: StoredState = { presets: this.presets(), lastSteps: this.lastSteps() };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      // Presets are user-created, named artifacts — a failed save means the
      // preset will silently vanish on restart. Say so.
      this.errorSurface.surfaceError("Preset didn't save — it will be lost on restart", error);
    }
  }

  private restoreLastAiModel(): string {
    try {
      return localStorage.getItem(LAST_AI_MODEL_KEY) ?? '';
    } catch {
      return '';
    }
  }

  private restore(): StoredState {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return { presets: [...STARTER_PRESETS], lastSteps: [] };
      }
      const saved = JSON.parse(raw) as Partial<StoredState>;
      return {
        presets: Array.isArray(saved.presets) ? saved.presets.filter(isValidPreset) : [],
        lastSteps: Array.isArray(saved.lastSteps) ? saved.lastSteps.filter(isValidStep) : [],
      };
    } catch (error) {
      console.warn('[PipelinePresets] Failed to restore', error);
      return { presets: [...STARTER_PRESETS], lastSteps: [] };
    }
  }
}

function isValidStep(step: unknown): step is PipelineStep {
  return (
    !!step &&
    typeof step === 'object' &&
    STEP_ORDER.includes((step as PipelineStep).type) &&
    typeof (step as PipelineStep).config === 'object'
  );
}

function isValidPreset(preset: unknown): preset is PipelinePreset {
  const p = preset as PipelinePreset;
  return (
    !!p &&
    typeof p === 'object' &&
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    Array.isArray(p.steps) &&
    p.steps.every(isValidStep)
  );
}
