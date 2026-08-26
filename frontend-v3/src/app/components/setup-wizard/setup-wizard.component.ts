import { ChangeDetectionStrategy, Component, EventEmitter, Input, OnInit, Output, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ComponentService, ComponentStatus } from '../../services/component.service';
import { SetupDownloadService } from '../../services/setup-download.service';
import { AiSetupService, SystemInfo } from '../../services/ai-setup.service';
import { ElectronService } from '../../services/electron.service';

type Step = 'welcome' | 'tools' | 'models' | 'ai' | 'review' | 'finishing';

/**
 * Minutes-style paginated setup wizard for download-on-demand components
 * (binaries + whisper models). Selections are queued through SetupDownloadService,
 * which also drives the bottom-right download dock. The existing AI-provider
 * wizard (app-ai-setup-wizard) remains separate for engine/API-key config.
 */
@Component({
  selector: 'app-setup-wizard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="setup-overlay">
      <div class="setup-card">
        <div class="setup-card-head">
          <h2>{{ mode === 'config' ? 'Manage components' : 'Set up Briefcase' }}</h2>
          @if (mode === 'config') {
            <button class="ghost-icon" (click)="closed.emit()" title="Close">✕</button>
          }
        </div>

        <div class="steps-indicator">
          <span class="step-count">{{ step() === 'finishing' ? 'Finishing up' : 'Step ' + (stepIndex() + 1) + ' of ' + NUMBERED }}</span>
          <div class="step-dots">
            @for (i of dotIndexes; track i) {
              <span class="step-dot" [class.active]="i === stepIndex()" [class.done]="i < stepIndex()"></span>
            }
          </div>
        </div>

        <div class="setup-card-body">
          @switch (step()) {
            @case ('welcome') {
              <div class="step-head">
                <h3>Welcome to Briefcase</h3>
                <p class="sub">Briefcase downloads the tools and models it needs on demand. Pick what to install — you can add more later from Settings.</p>
              </div>
              @if (system(); as sys) {
                <div class="system-info">
                  <span class="chip">{{ sys.platform }}</span>
                  <span class="chip">{{ sys.totalMemoryGB }} GB RAM</span>
                  <span class="chip">{{ sys.cpuCores }} cores</span>
                  @if (sys.gpu) { <span class="chip chip-accent">{{ sys.gpu.name }}</span> }
                </div>
              }
            }

            @case ('tools') {
              <div class="step-head">
                <h3>Required tools</h3>
                <p class="sub">These power downloading, transcoding, and transcription. Required tools are selected automatically.</p>
              </div>
              <div class="select-list">
                @for (c of requiredTools(); track c.id) {
                  <ng-container *ngTemplateOutlet="card; context: { $implicit: c, locked: true }"></ng-container>
                }
                @if (optionalTools().length) {
                  <div class="group-label">Optional</div>
                  @for (c of optionalTools(); track c.id) {
                    <ng-container *ngTemplateOutlet="card; context: { $implicit: c, locked: false }"></ng-container>
                  }
                }
                @if (pythonEnvs().length) {
                  <div class="group-label">Flag detection — recommended</div>
                  @for (c of pythonEnvs(); track c.id) {
                    <ng-container *ngTemplateOutlet="card; context: { $implicit: c, locked: false, recommended: true }"></ng-container>
                  }
                  <p class="hint">Skip it and flag detection still works — it falls back to a per-chapter AI pass, which is slower and finds fewer flags. You can add it later from Settings.</p>
                }
              </div>
            }

            @case ('models') {
              <div class="step-head">
                <h3>Transcription model</h3>
                <p class="sub">Whisper models power speech-to-text. Larger models are more accurate but slower and bigger.</p>
              </div>
              @if (models().length) {
                <div class="select-list">
                  @for (c of models(); track c.id) {
                    <ng-container *ngTemplateOutlet="card; context: { $implicit: c, locked: false }"></ng-container>
                  }
                </div>
              } @else {
                <p class="sub">No downloadable models are listed in the manifest yet.</p>
              }
            }

            @case ('ai') {
              <div class="step-head">
                <h3>AI for video analysis</h3>
                <p class="sub">Briefcase can analyse video with a local model through <a class="linklike" href="#" (click)="open('https://ollama.com'); $event.preventDefault()">Ollama</a> — private, offline, and free — or with Claude or OpenAI. Install Ollama and pull a model, or add a cloud API key below.</p>
              </div>

              @if (llamaModels().length) {
                <div class="group-label">Local models — recommended</div>
                <div class="select-list">
                  @for (c of llamaModels(); track c.id) {
                    <label class="select-card"
                           [class.checked]="isChecked(c)"
                           [class.installed]="c.installed">
                      <input type="checkbox" [checked]="isChecked(c)" [disabled]="c.installed" (change)="toggleModel(c)">
                      <div class="select-info">
                        <div class="select-name">{{ c.name }}
                          @if (isRecommended(c)) { <span class="badge badge-accent">Recommended</span> }
                        </div>
                        @if (c.description) { <div class="select-desc">{{ c.description }}</div> }
                      </div>
                      <div class="select-meta">
                        @if (c.installed) { <span class="badge badge-ok">Installed</span> }
                        @else { <span class="select-size">{{ fmtSize(c.sizeBytes) }}</span> }
                      </div>
                    </label>
                  }
                </div>
                <p class="hint">Not sure? {{ recommendedName() }} is the best fit for this computer. The local AI engine (≈5 MB) installs automatically with your first model.</p>
              } @else {
                <div class="group-label">Local models</div>
                <p class="sub">Briefcase no longer bundles its own local models. For offline analysis, install <a class="linklike" href="#" (click)="open('https://ollama.com'); $event.preventDefault()">Ollama</a> and pull a model (<code>ollama pull qwen3.8:27b</code>) — Briefcase picks it up automatically.</p>
              }

              <div class="group-label">Or use a cloud provider</div>
              <div class="provider-list">
                <div class="provider-row">
                  <div class="provider-head">
                    <span class="provider-name">Claude (Anthropic)</span>
                    @if (claudeSaved()) { <span class="badge badge-ok">Key saved</span> }
                    <button type="button" class="linklike" (click)="open('https://console.anthropic.com/settings/keys')">Get a key ↗</button>
                  </div>
                  <div class="provider-input">
                    <input type="password" placeholder="sk-ant-…" [(ngModel)]="claudeKey" />
                    <button class="btn btn-secondary btn-sm" [disabled]="!claudeKey || savingKey()" (click)="saveClaude()">Save</button>
                  </div>
                </div>

                <div class="provider-row">
                  <div class="provider-head">
                    <span class="provider-name">ChatGPT (OpenAI)</span>
                    @if (openaiSaved()) { <span class="badge badge-ok">Key saved</span> }
                    <button type="button" class="linklike" (click)="open('https://platform.openai.com/api-keys')">Get a key ↗</button>
                  </div>
                  <div class="provider-input">
                    <input type="password" placeholder="sk-…" [(ngModel)]="openaiKey" />
                    <button class="btn btn-secondary btn-sm" [disabled]="!openaiKey || savingKey()" (click)="saveOpenAI()">Save</button>
                  </div>
                </div>

                <div class="provider-row">
                  <div class="provider-head">
                    <span class="provider-name">Ollama</span>
                    <span class="select-desc">Run other open models via a separate Ollama install.</span>
                    <button type="button" class="linklike" (click)="open('https://ollama.com/download')">Install Ollama ↗</button>
                  </div>
                </div>
              </div>
            }

            @case ('review') {
              <div class="step-head">
                <h3>Review & download</h3>
                <p class="sub">Everything you picked. Downloads run in the background — you can keep using the app.</p>
              </div>
              <div class="review-list">
                @for (c of reviewItems(); track c.id) {
                  <div class="review-row">
                    <span>{{ c.name }} @if (c.required) { <span class="badge badge-rec">Required</span> }</span>
                    <span class="select-size">{{ fmtSize(c.sizeBytes) }}</span>
                  </div>
                }
                <div class="review-total">
                  <span>Total download</span>
                  <span>{{ fmtSize(totalBytes()) }}</span>
                </div>
              </div>
              @if (reviewItems().length === 0) {
                <p class="sub">Nothing selected — everything needed is already installed.</p>
              }
            }

            @case ('finishing') {
              <div class="finishing">
                @if (essentialFailed()) {
                  <div class="done-check error">!</div>
                  <h3>Something went wrong</h3>
                  <p class="finishing-sub">An essential tool couldn't be downloaded, so Briefcase can't start yet. Check your internet connection and try again.</p>
                  <button class="btn btn-secondary" (click)="retryEssentials()">Retry</button>
                } @else if (dl.running()) {
                  <div class="engine-spinner"></div>
                  @if (essentialPending()) {
                    <h3>Setting things up…</h3>
                    <p class="finishing-sub">Installing the essential tools Briefcase needs to run.</p>
                  } @else {
                    <div class="done-check">✓</div>
                    <h3>You're ready to go</h3>
                    <p class="finishing-sub">Essential tools are installed. Models keep downloading in the background — feel free to keep working.</p>
                  }
                  <div class="finish-bar"><div class="finish-bar-fill" [style.width.%]="dl.aggregatePct()"></div></div>
                } @else {
                  <div class="done-check">✓</div>
                  <h3>All set</h3>
                  <p class="finishing-sub">Your components are installed and ready.</p>
                }
              </div>
            }
          }
        </div>

        <div class="setup-card-foot">
          @if (step() !== 'welcome' && step() !== 'finishing') {
            <button class="btn btn-secondary" (click)="back()">Back</button>
          }
          <span class="spacer"></span>
          @if (step() === 'finishing') {
            <button class="btn btn-primary" [disabled]="essentialPending() || essentialFailed()" (click)="finish()">
              {{ mode === 'config' ? 'Done' : 'Open Briefcase' }}
            </button>
          } @else if (step() === 'review') {
            <button class="btn btn-primary" (click)="startDownload()">
              {{ reviewItems().length ? 'Download' : 'Continue' }}
            </button>
          } @else {
            <button class="btn btn-primary" (click)="next()">Next</button>
          }
        </div>
      </div>
    </div>

    <!-- select card template -->
    <ng-template #card let-c let-locked="locked" let-recommended="recommended">
      <label class="select-card"
             [class.checked]="isChecked(c)"
             [class.installed]="c.installed">
        <input type="checkbox" [checked]="isChecked(c)" [disabled]="locked || c.installed" (change)="toggle(c)">
        <div class="select-info">
          <div class="select-name">{{ c.name }}
            @if (locked) { <span class="badge badge-rec">Required</span> }
            @else if (recommended) { <span class="badge badge-accent">Recommended</span> }
          </div>
          @if (c.description) { <div class="select-desc">{{ c.description }}</div> }
        </div>
        <div class="select-meta">
          @if (c.installed) { <span class="badge badge-ok">Installed</span> }
          @else { <span class="select-size">{{ fmtSize(c.sizeBytes) }}</span> }
        </div>
      </label>
    </ng-template>
  `,
  styleUrls: ['./setup-wizard.component.scss'],
})
export class SetupWizardComponent implements OnInit {
  @Input() mode: 'setup' | 'config' = 'setup';
  @Output() closed = new EventEmitter<void>();
  @Output() completed = new EventEmitter<void>();

  private componentService = inject(ComponentService);
  private aiSetup = inject(AiSetupService);
  private electron = inject(ElectronService);
  dl = inject(SetupDownloadService);

  readonly NUMBERED = 5; // welcome, tools, models, ai, review
  readonly dotIndexes = [0, 1, 2, 3, 4];

  readonly step = signal<Step>('welcome');
  readonly all = signal<ComponentStatus[]>([]);
  readonly system = signal<SystemInfo | null>(null);

  // AI step state (cloud providers)
  claudeKey = '';
  openaiKey = '';
  readonly claudeSaved = signal(false);
  readonly openaiSaved = signal(false);
  readonly savingKey = signal(false);

  private order: Step[] = ['welcome', 'tools', 'models', 'ai', 'review', 'finishing'];

  readonly stepIndex = computed(() => Math.min(this.order.indexOf(this.step()), this.NUMBERED - 1));
  readonly requiredTools = computed(() => this.all().filter((c) => c.kind === 'binary' && c.required && c.supported));
  readonly optionalTools = computed(() =>
    this.all().filter((c) => c.kind === 'binary' && !c.required && c.supported && c.id !== 'llama'),
  );
  /**
   * Locally-built Python environments (the NLI flag ranker). Offered on the
   * tools step because that is what it is — a tool — and NOT pre-selected,
   * unlike the required binaries and the default whisper model: it needs a
   * system Python 3.9+, and silently queueing a 1.2GB build that fails on every
   * machine without one is worse than an unticked box with a "Recommended"
   * badge and a line saying what skipping it costs.
   */
  readonly pythonEnvs = computed(() => this.all().filter((c) => c.kind === 'python-env' && c.supported));
  readonly models = computed(() => this.all().filter((c) => c.kind === 'whisper-model' && c.supported));
  readonly llamaModels = computed(() => this.all().filter((c) => c.kind === 'llama-model' && c.supported));
  readonly reviewItems = computed(() => this.all().filter((c) => this.dl.isSelected(c.id) && !c.installed));
  readonly totalBytes = computed(() => this.reviewItems().reduce((s, c) => s + (c.sizeBytes || 0), 0));

  /**
   * True while an essential tool (ffmpeg/ffprobe, yt-dlp) is still queued or
   * downloading. We block "Open Briefcase" only on these — models are allowed to
   * keep downloading in the background once the essentials are in place.
   */
  readonly essentialPending = computed(() =>
    this.dl.order().some(
      (id) =>
        this.componentService.isEssential(id) &&
        (this.dl.statusOf(id) === 'queued' || this.dl.statusOf(id) === 'downloading'),
    ),
  );

  /**
   * True when an essential tool failed to download. Briefcase can't run without
   * these, so a failure must block "Open Briefcase" and surface an error +
   * retry — never fall through to the success screen (FC-2).
   */
  readonly essentialFailed = computed(() =>
    this.dl.order().some(
      (id) => this.componentService.isEssential(id) && this.dl.statusOf(id) === 'failed',
    ),
  );

  readonly recommendedName = computed(() => {
    const id = this.system()?.recommendedModel;
    // Only rendered inside the @if (llamaModels().length) branch, so the first
    // entry is a real fallback rather than a name for a model that isn't offered.
    return this.llamaModels().find((m) => m.id === id)?.name
      ?? this.llamaModels()[0]?.name
      ?? '';
  });

  async ngOnInit() {
    this.componentService.listComponents().subscribe((components) => {
      this.all.set(components);
      // Pre-select required, not-yet-installed tools.
      const presel = components.filter((c) => c.required && c.supported && !c.installed).map((c) => c.id);
      // Pre-select a default whisper model (base) if none installed.
      const models = components.filter((c) => c.kind === 'whisper-model');
      if (models.length && !models.some((m) => m.installed)) {
        const base = models.find((m) => /base/i.test(m.id) || /base/i.test(m.name)) || models[0];
        if (base) presel.push(base.id);
      }
      this.dl.select(presel);
    });
    this.aiSetup.getSystemInfo().subscribe((s) => this.system.set(s));
    // Reflect any already-configured cloud keys.
    this.aiSetup.checkAIAvailability().then((a) => {
      this.claudeSaved.set(a.hasClaudeKey);
      this.openaiSaved.set(a.hasOpenAIKey);
    });
  }

  isChecked(c: ComponentStatus): boolean {
    return c.installed || this.dl.isSelected(c.id);
  }

  toggle(c: ComponentStatus): void {
    if (c.installed || (c.required && c.kind === 'binary')) return;
    this.dl.toggle(c.id);
  }

  isRecommended(c: ComponentStatus): boolean {
    return c.id === this.system()?.recommendedModel;
  }

  /** Toggle a local AI model; selecting one also queues the llama engine binary. */
  toggleModel(c: ComponentStatus): void {
    if (c.installed) return;
    const willSelect = !this.dl.isSelected(c.id);
    this.dl.toggle(c.id);
    if (willSelect) {
      // Ensure the llama-server binary is installed too (skipped automatically if already present).
      const llama = this.all().find((x) => x.id === 'llama' && !x.installed);
      if (llama) this.dl.select(['llama']);
    }
  }

  async saveClaude(): Promise<void> {
    if (!this.claudeKey || this.savingKey()) return;
    this.savingKey.set(true);
    try {
      await this.aiSetup.saveClaudeKey(this.claudeKey).toPromise();
      this.claudeSaved.set(true);
      this.claudeKey = '';
      this.aiSetup.notifyModelsChanged();
    } catch {
      // error surfaced to console by the service
    } finally {
      this.savingKey.set(false);
    }
  }

  async saveOpenAI(): Promise<void> {
    if (!this.openaiKey || this.savingKey()) return;
    this.savingKey.set(true);
    try {
      await this.aiSetup.saveOpenAIKey(this.openaiKey).toPromise();
      this.openaiSaved.set(true);
      this.openaiKey = '';
      this.aiSetup.notifyModelsChanged();
    } catch {
      // error surfaced to console by the service
    } finally {
      this.savingKey.set(false);
    }
  }

  open(url: string): void {
    if (this.electron.isElectron) {
      this.electron.openExternal(url);
    } else {
      window.open(url, '_blank');
    }
  }

  next(): void {
    const i = this.order.indexOf(this.step());
    this.step.set(this.order[Math.min(i + 1, this.order.length - 1)]);
  }

  back(): void {
    const i = this.order.indexOf(this.step());
    this.step.set(this.order[Math.max(i - 1, 0)]);
  }

  startDownload(): void {
    const ids = this.reviewItems().map((c) => c.id);
    if (ids.length) this.dl.enqueue(ids);
    this.step.set('finishing');
  }

  /** Re-attempt any essential downloads that failed, from the finishing screen. */
  retryEssentials(): void {
    const failedEssentials = this.dl
      .order()
      .filter((id) => this.componentService.isEssential(id) && this.dl.statusOf(id) === 'failed');
    if (failedEssentials.length === 0) return;
    // Clear the failed flag so the queue drain picks them back up.
    this.dl.failed.update((f) => {
      const next = { ...f };
      failedEssentials.forEach((id) => delete next[id]);
      return next;
    });
    this.dl.enqueue(failedEssentials);
  }

  finish(): void {
    this.completed.emit();
  }

  fmtSize(bytes: number): string {
    if (!bytes) return '—';
    const mb = bytes / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
  }
}
