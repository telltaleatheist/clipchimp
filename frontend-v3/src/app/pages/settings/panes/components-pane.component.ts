import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ComponentService, ComponentStatus } from '../../../services/component.service';
import { ErrorSurface } from '../../../core/error-surface.service';
import { SetupDownloadService } from '../../../services/setup-download.service';
import { SetupWizardComponent } from '../../../components/setup-wizard/setup-wizard.component';
import { UiButtonComponent } from '../../../ui';

/**
 * Settings → Components: download-on-demand tools and models
 * (ffmpeg / yt-dlp / whisper models / local AI models), previously only
 * reachable through the "Models & Tools" wizard. The flat list here is the
 * primary surface; the paginated wizard stays available as a guided installer.
 * Downloads run through SetupDownloadService and show in the download dock.
 */
@Component({
  selector: 'app-components-pane',
  standalone: true,
  imports: [SetupWizardComponent, UiButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./panes-shared.scss'],
  templateUrl: './components-pane.component.html'
})
export class ComponentsPaneComponent {
  private componentService = inject(ComponentService);
  private destroyRef = inject(DestroyRef);
  private errorSurface = inject(ErrorSurface);
  dl = inject(SetupDownloadService);

  all = signal<ComponentStatus[]>([]);
  wizardOpen = signal(false);

  tools = computed(() => this.all().filter(c => c.kind === 'binary' && c.supported));
  whisperModels = computed(() => this.all().filter(c => c.kind === 'whisper-model' && c.supported));
  llamaModels = computed(() => this.all().filter(c => c.kind === 'llama-model' && c.supported));
  /**
   * Locally-built Python environments (currently only the NLI flag ranker).
   * Listed apart from the downloads because it is not one: it is constructed
   * from a Python already on the machine, so its failure modes ("no interpreter
   * found") and its fix ("Repair") are different from a download's.
   */
  pythonEnvs = computed(() => this.all().filter(c => c.kind === 'python-env' && c.supported));

  constructor() {
    this.reload();
  }

  private reload(): void {
    this.componentService.listComponents()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(components => this.all.set(components));
  }

  statusOf(id: string): string {
    return this.dl.statusOf(id);
  }

  pctOf(id: string): number {
    return this.dl.pctOf(id);
  }

  isBusy(component: ComponentStatus): boolean {
    const status = this.dl.statusOf(component.id);
    return status === 'queued' || status === 'downloading';
  }

  download(component: ComponentStatus): void {
    if (component.installed || this.isBusy(component)) return;
    const ids = [component.id];
    // A local AI model needs the llama engine binary alongside it.
    if (component.kind === 'llama-model') {
      const llama = this.all().find(c => c.id === 'llama' && !c.installed);
      if (llama && !this.isBusy(llama)) ids.unshift('llama');
    }
    this.dl.select(ids);
    this.dl.enqueue(ids);
  }

  /** Id of the component awaiting removal confirmation (two-click remove). */
  confirmingRemoveId = signal<string | null>(null);
  removingId = signal<string | null>(null);

  canRemove(component: ComponentStatus): boolean {
    return component.installed && !component.required && this.removingId() === null;
  }

  remove(component: ComponentStatus): void {
    if (!this.canRemove(component)) return;
    if (this.confirmingRemoveId() !== component.id) {
      // First click arms the confirmation; the button relabels to "Confirm".
      this.confirmingRemoveId.set(component.id);
      return;
    }
    this.confirmingRemoveId.set(null);
    this.removingId.set(component.id);
    this.componentService.removeComponent(component.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.removingId.set(null);
          this.reload();
        },
        error: error => {
          // Keep the item visible; tell the user the removal failed
          // (this code originally reset silently — fallback-audit #17).
          this.removingId.set(null);
          this.errorSurface.surfaceError("Couldn't remove the component", error);
        },
      });
  }

  cancelRemove(): void {
    this.confirmingRemoveId.set(null);
  }

  /**
   * Rebuild an already-present environment. Uses the same queue and the same
   * dock as an install — it IS an install, with force set, so a broken venv is
   * torn down and remade instead of being detected as "already there".
   */
  repair(component: ComponentStatus): void {
    if (this.isBusy(component)) return;
    this.dl.select([component.id]);
    this.dl.enqueue([component.id], true);
  }

  openWizard(): void {
    this.wizardOpen.set(true);
  }

  closeWizard(): void {
    this.wizardOpen.set(false);
    this.reload();
  }

  fmtSize(bytes: number): string {
    if (!bytes) return '—';
    const mb = bytes / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
  }
}
