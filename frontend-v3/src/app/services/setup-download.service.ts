import { Injectable, computed, signal } from '@angular/core';
import { ComponentService } from './component.service';
import { WebsocketService } from './websocket.service';
import { AiSetupService } from './ai-setup.service';

export type ItemStatus = 'idle' | 'queued' | 'downloading' | 'done' | 'failed';

interface ItemProgress {
  phase: string;
  pct: number;
  speed?: string;
  eta?: string;
}

/**
 * Coordinates download-on-demand component installs for the setup wizard and
 * the download dock. Selections are queued and drained sequentially; live
 * progress/completion comes from WebsocketService 'component.download.*' events.
 * Modeled on the Minutes setup-download store.
 */
@Injectable({ providedIn: 'root' })
export class SetupDownloadService {
  // Selection (checked component ids in the wizard)
  readonly selected = signal<Set<string>>(new Set());

  // Batch state
  readonly order = signal<string[]>([]);
  readonly currentId = signal<string | null>(null);
  readonly doneIds = signal<Set<string>>(new Set());
  readonly failed = signal<Record<string, string>>({});
  readonly progress = signal<Record<string, ItemProgress>>({});
  readonly dismissed = signal<boolean>(false);

  private draining = false;
  private resolveCurrent: (() => void) | null = null;
  /**
   * Ids queued as a REPAIR rather than a fresh install. Only meaningful for
   * locally-constructed components (the NLI Python environment), where the
   * backend would otherwise see a directory that already looks present and
   * no-op. Cleared as each item starts, so a later ordinary install of the same
   * id is not silently forced too.
   */
  private forceIds = new Set<string>();

  // Stall watchdog: if the in-flight item goes silent for this long (no progress
  // events and no terminal 'component.download.*' WS event, e.g. a backend crash
  // or a lost terminal event), fail it and move on so the queue can't hang
  // forever. It resets on every progress tick, so a legitimately slow large
  // download stays alive as long as bytes keep flowing.
  private static readonly WATCHDOG_MS = 10 * 60 * 1000; // 10 min of silence
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  readonly running = computed(() =>
    this.order().some((id) => !this.doneIds().has(id) && !this.failed()[id]),
  );

  readonly aggregatePct = computed(() => {
    const ids = this.order();
    if (ids.length === 0) return 0;
    const done = this.doneIds();
    const prog = this.progress();
    const sum = ids.reduce((acc, id) => acc + (done.has(id) ? 100 : prog[id]?.pct || 0), 0);
    return Math.round(sum / ids.length);
  });

  readonly visible = computed(() => !this.dismissed() && this.order().length > 0);

  constructor(
    private components: ComponentService,
    private ws: WebsocketService,
    private aiSetup: AiSetupService,
  ) {
    this.ws.onComponentDownloadProgress((e) => {
      this.progress.update((p) => ({
        ...p,
        [e.componentId]: { phase: e.phase, pct: e.progress, speed: e.speed, eta: e.eta },
      }));
      // Progress is flowing, so keep the stall watchdog from firing.
      if (this.currentId() === e.componentId) {
        this.armWatchdog(e.componentId);
      }
    });
    this.ws.onComponentDownloadComplete((e) => {
      this.doneIds.update((s) => new Set(s).add(e.componentId));
      this.components.listComponents().subscribe();
      // Tell model-listing surfaces (analysis config dialogs, settings) to
      // re-fetch so a freshly downloaded whisper/AI model shows up immediately,
      // without needing an app restart.
      this.aiSetup.notifyModelsChanged();
      this.finishCurrent(e.componentId);
    });
    this.ws.onComponentDownloadError((e) => {
      this.failed.update((f) => ({ ...f, [e.componentId]: e.error }));
      this.finishCurrent(e.componentId);
    });
    this.ws.onComponentDownloadCancelled((e) => {
      this.failed.update((f) => ({ ...f, [e.componentId]: 'Cancelled' }));
      this.finishCurrent(e.componentId);
    });
  }

  // ---------- selection ----------
  isSelected(id: string): boolean {
    return this.selected().has(id);
  }

  toggle(id: string): void {
    this.selected.update((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  select(ids: string[]): void {
    this.selected.update((s) => {
      const next = new Set(s);
      ids.forEach((id) => next.add(id));
      return next;
    });
  }

  // ---------- queue ----------
  /**
   * Queue the given ids (or the current selection) and start draining.
   * `force` marks them as repairs — see forceIds.
   */
  enqueue(ids?: string[], force = false): void {
    const toAdd = ids ?? Array.from(this.selected());
    if (force) {
      toAdd.forEach((id) => this.forceIds.add(id));
      // A repair is by definition a re-run of something that already finished
      // (or failed) in this session. Clear its terminal state first, otherwise
      // nextToRun() skips it and the button does nothing.
      this.doneIds.update((d) => new Set([...d].filter((id) => !toAdd.includes(id))));
      this.failed.update((f) => {
        const next = { ...f };
        toAdd.forEach((id) => delete next[id]);
        return next;
      });
      this.order.update((o) => o.filter((id) => !toAdd.includes(id)));
    }
    const existing = new Set(this.order());
    const additions = toAdd.filter((id) => !existing.has(id));
    if (additions.length > 0) {
      this.dismissed.set(false);
      this.order.update((o) => [...o, ...additions]);
    }
    void this.drain();
  }

  cancelCurrent(): void {
    this.components.cancelComponent().subscribe();
  }

  dismiss(): void {
    if (!this.running()) {
      this.dismissed.set(true);
      this.order.set([]);
      this.doneIds.set(new Set());
      this.failed.set({});
      this.progress.set({});
    }
  }

  statusOf(id: string): ItemStatus {
    if (this.doneIds().has(id)) return 'done';
    if (this.failed()[id]) return 'failed';
    if (this.currentId() === id) return 'downloading';
    // 'queued' only for ids actually in the queue — an id we were never asked
    // to download is 'idle' (callers show a Download affordance for it).
    return this.order().includes(id) ? 'queued' : 'idle';
  }

  pctOf(id: string): number {
    return this.doneIds().has(id) ? 100 : this.progress()[id]?.pct || 0;
  }

  private nextToRun(): string | null {
    const done = this.doneIds();
    const failed = this.failed();
    return this.order().find((id) => !done.has(id) && !failed[id]) || null;
  }

  private finishCurrent(componentId: string): void {
    if (this.currentId() === componentId && this.resolveCurrent) {
      this.clearWatchdog();
      const r = this.resolveCurrent;
      this.resolveCurrent = null;
      this.currentId.set(null);
      r();
    }
  }

  /** (Re)start the stall watchdog for the given in-flight item. */
  private armWatchdog(componentId: string): void {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      if (this.currentId() !== componentId) return;
      this.failed.update((f) => ({
        ...f,
        [componentId]: f[componentId] || 'Timed out waiting for download to finish',
      }));
      this.finishCurrent(componentId);
    }, SetupDownloadService.WATCHDOG_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      let id: string | null;
      while ((id = this.nextToRun()) !== null) {
        this.currentId.set(id);
        await new Promise<void>((resolve) => {
          this.resolveCurrent = resolve;
          // Guard against a terminal WS event that never arrives.
          this.armWatchdog(id as string);
          const force = this.forceIds.delete(id as string);
          this.components.installComponent(id as string, force).subscribe({
            next: (res) => {
              // HTTP 200 with success:false (unsupported platform, "already
              // downloading", backend refusal) is neither an HTTP error nor a
              // WS terminal event, so nothing else would ever resolve this item.
              // Fail it here so the queue keeps draining.
              if (!res?.success) {
                this.failed.update((f) => ({
                  ...f,
                  [id as string]: res?.message || 'Install failed',
                }));
                this.finishCurrent(id as string);
              }
            },
            error: (err) => {
              this.failed.update((f) => ({ ...f, [id as string]: err?.message || 'Install failed' }));
              this.finishCurrent(id as string);
            },
          });
        });
      }
    } finally {
      this.draining = false;
    }
  }
}
