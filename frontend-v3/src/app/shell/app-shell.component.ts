import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationStore, ShellSection } from '../core/stores/navigation.store';
import { SelectionStore } from '../core/stores/selection.store';
import { WorkspaceActionsService, WorkspaceAction, AddDownloadsPayload } from '../core/stores/workspace-actions.service';
import { SystemEventsService } from '../core/stores/system-events.service';
import { AiSetupService } from '../services/ai-setup.service';
import { LibraryService } from '../services/library.service';
import { QueueService } from '../services/queue.service';
import { TabsService, VideoTab } from '../services/tabs.service';
import { ThemeService } from '../services/theme.service';
import { TourService } from '../services/tour.service';
import { LoggerService } from '../services/logger.service';
import { SidebarComponent } from './sidebar/sidebar.component';
import { ToolbarComponent } from './toolbar/toolbar.component';
import { ToolbarActionsComponent } from './toolbar/toolbar-actions.component';
import { InspectorPanelComponent } from './inspector/inspector-panel.component';
import { InspectorResizeDirective } from './inspector/inspector-resize.directive';
import { ContextMenuComponent } from '../components/context-menu/context-menu.component';
import { NewTabDialogComponent } from '../components/new-tab-dialog/new-tab-dialog.component';
import { ContextMenuAction, ContextMenuPosition } from '../models/file.model';

const SECTION_TITLES: Record<ShellSection, string> = {
  library: 'Library',
  queue: 'Queue',
  collections: 'Collections',
  settings: 'Settings',
  archives: 'Web Archives',
  other: '',
};

/**
 * App shell — owns the four layout regions (sidebar / toolbar / content /
 * inspector) and nothing else. All state lives in stores/services; the
 * sidebar and toolbar are dumb components wired here.
 *
 * Chrome (sidebar/toolbar/inspector) hides entirely when
 * NavigationService.navVisible() is false — the editor's full-bleed mode.
 */
@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [RouterOutlet, SidebarComponent, ToolbarComponent, ToolbarActionsComponent, InspectorPanelComponent, InspectorResizeDirective, ContextMenuComponent, NewTabDialogComponent],
  templateUrl: './app-shell.component.html',
  styleUrls: ['./app-shell.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AppShellComponent {
  nav = inject(NavigationStore);
  selection = inject(SelectionStore);
  private router = inject(Router);
  private libraryService = inject(LibraryService);
  private queueService = inject(QueueService);
  private tabsService = inject(TabsService);
  private themeService = inject(ThemeService);
  private tourService = inject(TourService);
  private loggerService = inject(LoggerService);
  private aiSetupService = inject(AiSetupService);
  private workspaceActions = inject(WorkspaceActionsService);

  /** Sections hosted by the persistent workspace (LibraryPageComponent). */
  private static readonly WORKSPACE_SECTIONS: ShellSection[] = [
    'library', 'queue', 'collections', 'archives'
  ];

  constructor() {
    // The sidebar shows collections; the shell owns loading them.
    // (loadTabs also refreshes tabbedVideoIds, which the workspace consumes.)
    this.tabsService.loadTabs().pipe(takeUntilDestroyed()).subscribe();

    // Populate the current-library signal for the sidebar switcher. The
    // workspace also does this, but when the app loads directly on /settings
    // (or any non-workspace route) nothing else would — the switcher showed
    // "No library" until the user visited the Library.
    this.libraryService.getCurrentLibrary().pipe(takeUntilDestroyed()).subscribe();

    // Backend crash/restart + auto-update lifecycle notifications
    // (fallback-audit: these events previously had no renderer listeners).
    inject(SystemEventsService).start();
  }

  // ── Read-only projections of the real service state (never library-page copies)
  currentLibraryName = computed(() => this.libraryService.currentLibrary()?.name ?? '');
  queueCount = computed(
    () => this.queueService.pendingJobs().length + this.queueService.processingJobs().length
  );
  collections = computed(() => this.tabsService.tabs());
  isDarkTheme = computed(() => this.themeService.isDarkMode());
  sectionTitle = computed(() => SECTION_TITLES[this.nav.activeSection()]);
  hasTour = computed(() => this.tourService.hasTourForRoute(this.router.url));
  /** Reactive: getSetupStatus() reads the availability signal internally. */
  aiReady = computed(() => this.aiSetupService.getSetupStatus().isReady);
  /** Readiness UNKNOWN (probe failed) — show retry, not "Set up AI…". */
  aiCheckFailed = computed(() => this.aiSetupService.getSetupStatus().checkFailed);

  onWorkspace = computed(() => AppShellComponent.WORKSPACE_SECTIONS.includes(this.nav.activeSection()));

  /** Toolbar ⚡ Process → reveal & highlight the inspector's config section. */
  onRevealProcess(): void {
    this.workspaceActions.revealProcessConfig();
  }

  /** Add popover's embedded config asked to re-run the AI availability probe. */
  onRetryAi(): void {
    void this.aiSetupService.checkAIAvailability();
  }

  /** Add popover's embedded config: no whisper models → Settings → Components. */
  onOpenComponents(): void {
    this.router.navigate(['/settings/components']);
  }

  onSelectSection(section: Exclude<ShellSection, 'other'>): void {
    this.nav.goTo(section);
  }

  onSelectCollection(id: string): void {
    this.nav.goToCollection(id);
  }

  // ── Collection right-click menu ───────────────────────────────────────
  collectionMenuVisible = signal(false);
  collectionMenuPosition = signal<ContextMenuPosition>({ x: 0, y: 0 });
  private collectionMenuTarget = signal<VideoTab | null>(null);
  collectionMenuActions: ContextMenuAction[] = [
    { label: 'Delete Collection', icon: '🗑️', action: 'delete' }
  ];

  onCollectionContextMenu(payload: { collection: VideoTab; x: number; y: number }): void {
    this.collectionMenuTarget.set(payload.collection);
    this.collectionMenuPosition.set({ x: payload.x, y: payload.y });
    this.collectionMenuVisible.set(true);
  }

  onCollectionMenuAction(action: string): void {
    const target = this.collectionMenuTarget();
    this.collectionMenuVisible.set(false);
    if (action === 'delete' && target) {
      this.deleteCollection(target);
    }
  }

  private deleteCollection(collection: VideoTab): void {
    if (!confirm(`Delete the collection "${collection.name}"? This won't delete the videos in it.`)) {
      return;
    }
    this.tabsService.deleteTab(collection.id).subscribe({
      error: (err) => console.error('Failed to delete collection:', err)
    });
    // If we were viewing the collection we just deleted, leave its (now empty) view.
    if (this.nav.activeCollectionId() === collection.id) {
      this.nav.goTo('library');
    }
  }

  // ── New collection naming dialog ──────────────────────────────────────
  newCollectionDialogOpen = signal(false);

  onNewCollection(): void {
    this.newCollectionDialogOpen.set(true);
  }

  onCollectionCreated(name: string): void {
    this.newCollectionDialogOpen.set(false);
    this.tabsService.createTab(name).subscribe({
      error: (err) => console.error('Failed to create collection:', err)
    });
  }

  onOpenLibrarySwitcher(): void {
    // Libraries now live in Settings → Libraries (the modal remains only for
    // the first-run "no libraries" flow inside the workspace).
    this.nav.closeDrawer();
    this.router.navigate(['/settings/libraries']);
  }

  onToggleTheme(): void {
    this.themeService.toggleTheme();
  }

  // ── Toolbar actions → workspace dispatch ──────────────────────────────
  // Selection actions can only fire while the workspace is routed in (the
  // selection lives there); Add/import actions ensure it first.

  dispatchToWorkspace(action: WorkspaceAction): void {
    if (this.onWorkspace()) {
      this.workspaceActions.dispatch(action);
    } else {
      this.router.navigate(['/library']).then(() => this.workspaceActions.dispatch(action));
    }
  }

  onSubmitAdd(payload: AddDownloadsPayload): void {
    this.dispatchToWorkspace({ type: 'submitDownloads', payload });
  }

  onStartTour(): void {
    const tour = this.tourService.getTourForRoute(this.router.url);
    if (tour) {
      this.tourService.startTour(tour.id);
    }
  }

  onDownloadLogs(): void {
    this.loggerService.downloadLogs();
  }
}
