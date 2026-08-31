import { Component, signal, computed, effect, ViewChild, ElementRef, OnInit, OnDestroy, inject, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Router, ActivatedRoute } from '@angular/router';
import { firstValueFrom, timer, Subscription } from 'rxjs';
import { ExportDialogComponent, ExportDialogData } from '../export-dialog/export-dialog.component';
import { NavigationService } from '../../services/navigation.service';
import { LibraryService, LibraryAnalysis, AnalysisSection as LibAnalysisSection } from '../../services/library.service';
import { WebsocketService } from '../../services/websocket.service';
import { TourService } from '../../services/tour.service';
import {
  VideoEditorState,
  VideoClip,
  VideoMetadata,
  EditorSettings,
  TimelineSection,
  TimelineChapter,
  CategoryFilter,
  ZoomState,
  AnalysisData,
  WaveformData,
  TimelineSelection,
  CustomMarker,
  MuteSection,
  EditorTab,
  createEditorTab
} from '../../models/video-editor.model';
import {
  FlagFilter,
  FLAG_FILTERS,
  loadFlagFilter,
  passesFlagFilter,
  saveFlagFilter,
} from '../../models/flag-filter';
import { TranscriptionSegment } from '../../models/video-info.model';

// Sub-components
import { MediaDisplayComponent } from './media-display/media-display.component';
import { AnalysisPanelComponent } from './analysis-panel/analysis-panel.component';
import { TimelineRulerComponent } from './timeline/timeline-ruler/timeline-ruler.component';
import { TimelinePlayheadComponent } from './timeline/timeline-playhead/timeline-playhead.component';
import { TimelineTrackComponent } from './timeline/timeline-track/timeline-track.component';
import { MuteResizeEvent } from './timeline/timeline-mute-layer/timeline-mute-layer.component';
import { TimelineZoomBarComponent } from './timeline/timeline-zoom-bar/timeline-zoom-bar.component';
import { TimelineWaveformComponent } from './timeline/timeline-waveform/timeline-waveform.component';
import { ContextMenuComponent, ContextMenuAction, ContextMenuPosition } from './context-menu/context-menu.component';
import { MarkerDialogComponent, MarkerDialogData } from './marker-dialog/marker-dialog.component';
import { KeyboardShortcutsDialogComponent } from './keyboard-shortcuts-dialog/keyboard-shortcuts-dialog.component';
import { TabBarComponent } from './tab-bar/tab-bar.component';
import { getApiBase } from '../../core/runtime-url';

// Tool types for editor
export enum EditorTool {
  CURSOR = 'cursor',
  HIGHLIGHT = 'highlight'
}

// Category colors for different analysis types
const CATEGORY_COLORS: Record<string, string> = {
  'shocking': '#f59e0b',          // Amber
  'political-violence': '#b91c1c', // Dark Red
  'hate': '#dc2626',              // Red
  'violence': '#ef4444',          // Red
  'extremism': '#f97316',         // Orange
  'misinformation': '#eab308',    // Yellow
  'conspiracy': '#a855f7',        // Purple
  'christian-nationalism': '#ec4899', // Pink
  'false-prophecy': '#8b5cf6',    // Violet
  // Legacy categories
  'hate speech': '#dc2626',
  'harmful content': '#f97316',
  'political': '#0d6efd',
  'educational': '#198754',
  'entertainment': '#6610f2',
  'news': '#0dcaf0',
  'false prophecy': '#8b5cf6',
  'prophecy': '#8b5cf6',
  'spiritual': '#20c997',
  'testimony': '#0dcaf0',
  'teaching': '#198754',
  'worship': '#6610f2',
  'prayer': '#ec4899',
  'christian nationalism': '#ec4899',
  'nationalism': '#ec4899',
  'political violence': '#b91c1c',
  'rhetoric': '#fd7e14',
  'propaganda': '#ffc107',
  'fear-mongering': '#e83e8c',
  'apocalyptic': '#6f42c1',
  'end times': '#6f42c1',
  'biblical': '#0d6efd',
  'scripture': '#0dcaf0',
  'sermon': '#198754',
  'commentary': '#17a2b8',
  'interview': '#6610f2',
  'discussion': '#20c997',
  'introduction': '#adb5bd',
  'conclusion': '#adb5bd',
  'music': '#e83e8c',
  'advertisement': '#ffc107',
  'promotion': '#fd7e14',
  'default': '#6c757d'
};

@Component({
  selector: 'app-video-player',
  standalone: true,
  imports: [
    CommonModule,
    MediaDisplayComponent,
    AnalysisPanelComponent,
    TimelineRulerComponent,
    TimelinePlayheadComponent,
    TimelineTrackComponent,
    TimelineZoomBarComponent,
    TimelineWaveformComponent,
    ContextMenuComponent,
    MarkerDialogComponent,
    ExportDialogComponent,
    KeyboardShortcutsDialogComponent,
    TabBarComponent
  ],
  templateUrl: './video-player.component.html',
  styleUrls: ['./video-player.component.scss']
})
export class VideoPlayerComponent implements OnInit, OnDestroy {
  // Expose Math for template use
  Math = Math;

  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private navService = inject(NavigationService);
  private libraryService = inject(LibraryService);
  private http = inject(HttpClient);
  private tourService = inject(TourService);
  private websocketService = inject(WebsocketService);

  private readonly API_BASE = getApiBase();
  private readonly MAX_TABS = 15;

  // Tab management
  tabs = signal<EditorTab[]>([]);
  activeTabId = signal<string | null>(null);
  currentGroupNumber = signal<number | null>(null);
  private isRestoringTab = false; // Flag to ignore time updates during tab restore
  private pendingSeekTime: number | null = null; // Time to seek to after video loads
  private restoreTabTimeout?: ReturnType<typeof setTimeout>; // Fallback to clear isRestoringTab if the video never reports a duration (e.g. media error)
  private waveformPollInterval?: ReturnType<typeof setInterval>; // Server waveform progress poller, cleared on destroy

  // Computed active tab - derives current state from tabs array
  activeTab = computed(() => {
    const tabId = this.activeTabId();
    if (!tabId) return null;
    return this.tabs().find(t => t.id === tabId) || null;
  });

  @ViewChild(MediaDisplayComponent) videoPlayer?: MediaDisplayComponent;
  @ViewChild('videoPlayerArea', { static: false }) videoPlayerArea?: ElementRef<HTMLDivElement>;

  // Keyboard shortcuts
  @HostListener('document:keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent) {
    // Don't trigger if user is typing in a text-entry field.
    // We deliberately allow range sliders, checkboxes, radios, selects, etc.
    // to pass through — those elements retain focus after interaction (e.g.
    // scale slider, border checkbox) but shouldn't block shortcuts like Cmd+E.
    const target = event.target;
    if (target instanceof HTMLTextAreaElement) {
      return;
    }
    if (target instanceof HTMLInputElement) {
      const textEntryTypes = new Set([
        'text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date',
        'datetime-local', 'month', 'week', 'time'
      ]);
      if (textEntryTypes.has(target.type)) {
        return;
      }
    }
    if (target instanceof HTMLElement && target.isContentEditable) {
      return;
    }

    if (event.code === 'Space') {
      event.preventDefault();
      this.togglePlayPause();
    }

    // Arrow keys to seek
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.skipBackward(5);
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.skipForward(5);
    }

    // Fullscreen with F key
    if ((event.key === 'f' || event.key === 'F') && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      this.toggleFullscreen();
    }

    // Zoom in/out with Cmd+Plus/Minus (or Ctrl on Windows)
    // Cmd+E for export dialog
    // Tab shortcuts
    if (event.metaKey || event.ctrlKey) {
      if (event.key === '=' || event.key === '+') {
        event.preventDefault();
        this.zoomIn();
      } else if (event.key === '-') {
        event.preventDefault();
        this.zoomOut();
      } else if (event.key === '0') {
        event.preventDefault();
        this.resetZoom();
      } else if (event.key === 'e' || event.key === 'E') {
        event.preventDefault();
        console.log('Cmd+E pressed, opening export dialog');
        this.openExportDialog();
      } else if (event.key === 'w' || event.key === 'W') {
        // Cmd+W: Close current tab
        event.preventDefault();
        const tabId = this.activeTabId();
        if (tabId) {
          this.closeTab(tabId);
        }
      } else if (event.shiftKey && event.key === '[') {
        // Cmd+Shift+[: Previous tab
        event.preventDefault();
        this.switchToPreviousTab();
      } else if (event.shiftKey && event.key === ']') {
        // Cmd+Shift+]: Next tab
        event.preventDefault();
        this.switchToNextTab();
      } else if (event.key >= '1' && event.key <= '9') {
        // Cmd+1-9: Switch to tab by number
        event.preventDefault();
        const tabIndex = parseInt(event.key) - 1;
        const tabs = this.tabs();
        if (tabIndex < tabs.length) {
          this.switchTab(tabs[tabIndex].id);
        }
      }
    }

    // L to increase speed (and start playing if stopped)
    if ((event.key === 'l' || event.key === 'L') && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      this.increasePlaybackSpeed();
    }

    // J to decrease speed
    if ((event.key === 'j' || event.key === 'J') && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      this.decreasePlaybackSpeed();
    }

    // A for cursor tool
    if ((event.key === 'a' || event.key === 'A') && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      this.setTool(EditorTool.CURSOR);
    }

    // R for highlight/range tool
    if ((event.key === 'r' || event.key === 'R') && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      this.setTool(EditorTool.HIGHLIGHT);
    }

    // M for marker at playhead, Shift+M for marker on selection
    if ((event.key === 'm' || event.key === 'M') && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      if (event.shiftKey && this.highlightSelection()) {
        // Shift+M: Add marker for current selection
        const selection = this.highlightSelection()!;
        this.openMarkerDialog(selection.startTime, selection.endTime);
      } else {
        // M: Add marker at playhead
        this.addMarker();
      }
    }

    // U for mute selection (Shift+U)
    if ((event.key === 'u' || event.key === 'U') && event.shiftKey) {
      event.preventDefault();
      if (this.highlightSelection()) {
        this.addMuteSection();
      }
    }

    // Escape to close dialogs
    if (event.key === 'Escape') {
      if (this.showKeyboardShortcuts()) {
        this.showKeyboardShortcuts.set(false);
      }
      if (this.showContextMenu$()) {
        this.showContextMenu$.set(false);
      }
      if (this.showMarkerDialog()) {
        this.showMarkerDialog.set(false);
      }
    }

    // ? to show keyboard shortcuts (Shift+/)
    if (event.key === '?' || (event.shiftKey && event.code === 'Slash')) {
      event.preventDefault();
      this.showKeyboardShortcuts.update(v => !v);
    }
  }

  // Bound wheel handler for proper cleanup
  private wheelHandler = (event: WheelEvent) => {
    // Check if over timeline area
    const timeline = (event.target as HTMLElement).closest('.timeline-area');

    if (event.metaKey || event.ctrlKey) {
      // Zoom with Ctrl/Cmd + wheel
      event.preventDefault();
      event.stopPropagation();

      if (timeline) {
        const rect = timeline.getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mousePercent = mouseX / rect.width;

        if (event.deltaY < 0) {
          this.zoomIn(mousePercent);
        } else if (event.deltaY > 0) {
          this.zoomOut(mousePercent);
        }
      } else {
        // Not over timeline, zoom on playhead
        if (event.deltaY < 0) {
          this.zoomIn();
        } else if (event.deltaY > 0) {
          this.zoomOut();
        }
      }
    } else if (timeline) {
      // Horizontal scroll/pan over timeline without modifiers
      const state = this.editorState();
      const visibleDuration = state.duration / state.zoomState.level;
      const maxOffset = state.duration - visibleDuration;

      if (maxOffset > 0) {
        event.preventDefault();

        // Use deltaX for horizontal scroll, deltaY for vertical wheel
        const delta = event.deltaX !== 0 ? event.deltaX : event.deltaY;

        // Scroll by a percentage of visible duration
        const scrollAmount = (delta / 100) * visibleDuration * 0.5;
        const newOffset = Math.max(0, Math.min(maxOffset, state.zoomState.offset + scrollAmount));

        this.onZoomChange({
          ...state.zoomState,
          offset: newOffset
        });
      }
    }
  };

  zoomIn(targetPercent?: number) {
    const currentZoom = this.editorState().zoomState;
    const currentTime = this.editorState().currentTime;
    const duration = this.editorState().duration;

    // Calculate max zoom: should be able to fit 5 seconds on screen
    // This scales with video duration
    const maxZoom = duration / 5; // e.g., 60s video = 12x max, 104s video = 20.8x max
    const newLevel = Math.min(currentZoom.level * 1.25, maxZoom);

    // Calculate the time we want to keep centered
    let centerTime: number;
    if (targetPercent !== undefined) {
      // Mouse position in timeline
      const currentVisibleDuration = duration / currentZoom.level;
      centerTime = currentZoom.offset + (targetPercent * currentVisibleDuration);
    } else {
      // Use playhead position
      centerTime = currentTime;
    }

    // Calculate new offset to keep centerTime at the same position
    const newVisibleDuration = duration / newLevel;
    let newOffset: number;
    if (targetPercent !== undefined) {
      newOffset = centerTime - (targetPercent * newVisibleDuration);
    } else {
      // Center on playhead (middle of screen)
      newOffset = centerTime - (newVisibleDuration / 2);
    }

    // Clamp offset to valid range
    const maxOffset = Math.max(0, duration - newVisibleDuration);
    newOffset = Math.max(0, Math.min(newOffset, maxOffset));

    this.onZoomChange({
      level: newLevel,
      offset: newOffset
    });
  }

  zoomOut(targetPercent?: number) {
    const currentZoom = this.editorState().zoomState;
    const currentTime = this.editorState().currentTime;
    const duration = this.editorState().duration;

    // Min zoom is always 1x (full video visible)
    const newLevel = Math.max(currentZoom.level / 1.25, 1);

    // Calculate the time we want to keep centered
    let centerTime: number;
    if (targetPercent !== undefined) {
      // Mouse position in timeline
      const currentVisibleDuration = duration / currentZoom.level;
      centerTime = currentZoom.offset + (targetPercent * currentVisibleDuration);
    } else {
      // Use playhead position
      centerTime = currentTime;
    }

    // Calculate new offset to keep centerTime at the same position
    const newVisibleDuration = duration / newLevel;
    let newOffset: number;
    if (targetPercent !== undefined) {
      newOffset = centerTime - (targetPercent * newVisibleDuration);
    } else {
      // Center on playhead (middle of screen)
      newOffset = centerTime - (newVisibleDuration / 2);
    }

    // Clamp offset to valid range
    const maxOffset = Math.max(0, duration - newVisibleDuration);
    newOffset = Math.max(0, Math.min(newOffset, maxOffset));

    this.onZoomChange({
      level: newLevel,
      offset: newOffset
    });
  }

  resetZoom() {
    this.onZoomChange({
      level: 1,
      offset: 0
    });
  }

  getFullscreenZoomPercent(): number {
    const level = this.editorState().zoomState.level;
    const duration = this.editorState().duration;
    const maxZoom = duration / 5;
    if (maxZoom <= 1) return 0;
    return (Math.log(level) / Math.log(maxZoom)) * 100;
  }

  // Video data from route state
  videoId = signal<string | null>(null);
  private videoPath = signal<string | null>(null);
  private videoTitle = signal<string>('Untitled Video');

  // True when opened in a separate popout window
  isPopoutMode = false;

  // Track if video has analysis
  hasAnalysis = signal(false);

  // Loading state
  isLoading = signal(true);
  errorMessage = signal<string | null>(null);

  // Editor state
  editorState = signal<VideoEditorState>({
    currentTime: 0,
    duration: 120,
    isPlaying: false,
    volume: 1,
    playbackRate: 1,
    zoomState: { level: 1, offset: 0 }
  });

  // Current active tool
  currentTool = signal<EditorTool>(EditorTool.CURSOR);

  // Video scale/zoom
  videoScale = signal<number>(1.0); // 1.0 = normal, 2.0 = 2x zoom

  // 16:9 border overlay dimensions (calculated by ResizeObserver)
  borderWidth = signal<number>(0);
  borderHeight = signal<number>(0);
  showBorder = signal<boolean>(false);
  borderAspectRatio = signal<'16:9' | '4:3' | '9:16'>('16:9');
  private resizeObserver?: ResizeObserver;

  // True once the video has played through to its final frame. Drives the
  // glowing/pulsing "finished" border. Cleared as soon as playback resumes,
  // the user seeks, or a different video is loaded.
  videoCompleted = signal<boolean>(false);

  // Selection state for highlighting
  highlightSelection = signal<TimelineSelection | null>(null);
  isSelecting = signal(false);
  selectionStart = signal<number | null>(null);

  // Mute sections for audio censoring
  muteSections = signal<MuteSection[]>([]);
  selectedMuteSection = signal<MuteSection | undefined>(undefined);
  // Track if we're in muted state due to mute section (not user manually muting)
  private isAutoMuted = false;

  // Context menu state
  showContextMenu$ = signal(false);
  contextMenuPosition = signal<ContextMenuPosition>({ x: 0, y: 0 });
  contextMenuActions = signal<ContextMenuAction[]>([]);

  // Marker dialog state
  showMarkerDialog = signal(false);
  markerDialogData = signal<MarkerDialogData | null>(null);

  /**
   * In-editor error toast (fallback-audit critical #7): the popout editor has
   * no notification surface — marker/chapter/mute save failures were console
   * only, silently losing the user's on-air marks. Cleared by timer or click.
   */
  editorErrorToast = signal<string | null>(null);
  private editorToastSub?: Subscription;

  /** Show an error toast inside the editor window and log the full error. */
  private showEditorError(message: string, error: unknown): void {
    console.error(`[Editor] ${message}:`, error);
    this.editorErrorToast.set(message);
    this.editorToastSub?.unsubscribe();
    this.editorToastSub = timer(6000).subscribe(() => this.editorErrorToast.set(null));
  }

  dismissEditorError(): void {
    this.editorToastSub?.unsubscribe();
    this.editorErrorToast.set(null);
  }

  /**
   * Dismissible chip: AI analysis/sections failed to load — the timeline is
   * rendering without them (progressive render stands, silence doesn't).
   */
  analysisLoadFailed = signal(false);

  // Export dialog
  showExportDialog = signal(false);
  exportDialogData = signal<ExportDialogData | null>(null);

  // Keyboard shortcuts dialog
  showKeyboardShortcuts = signal(false);

  // Video URL
  videoUrl = signal<string | undefined>(undefined);

  // Timeline sections from analysis
  sections = signal<TimelineSection[]>([]);

  // Timeline chapters from analysis
  chapters = signal<TimelineChapter[]>([]);
  selectedChapterId = signal<string | undefined>(undefined);

  // Transcript for video
  transcript = signal<TranscriptionSegment[]>([]);

  // Category filters
  categoryFilters = signal<CategoryFilter[]>([]);

  /**
   * THE FLAG FILTER — display-side, client-side, instant.
   *
   * The analysis captures everything and stores every verdict, so moving this
   * re-filters an array already in memory: no HTTP call, no re-run, nothing
   * recomputed on the backend, and nothing lost by moving it back. See
   * models/flag-filter.ts for the ruling and the thresholds.
   *
   * Its position is a VIEW PREFERENCE and lives with the filter — there is no
   * run-config control feeding it any more. It is read from localStorage on
   * construction and written back on every change, defaulting to MODERATE, the
   * calibrated position. See models/flag-filter.ts.
   */
  flagFilter = signal<FlagFilter>(loadFlagFilter());
  readonly flagFilterPositions = FLAG_FILTERS;

  // Analysis data
  analysisData = signal<AnalysisData | undefined>(undefined);

  // Waveform data
  waveformData = signal<WaveformData>({
    samples: [],
    sampleRate: 44100,
    duration: 0
  });

  // Video metadata
  metadata = signal<VideoMetadata>({
    filename: 'Loading...',
    format: '',
    resolution: '',
    frameRate: 0,
    bitrate: '',
    codec: '',
    fileSize: 0,
    duration: 0,
    createdDate: new Date()
  });

  // Editor settings
  settings = signal<EditorSettings>({
    snapToGrid: true,
    gridSize: 1,
    autoSave: true,
    waveformColor: '#ff6b35',
    timelineHeight: 150,
    showThumbnails: true,
    audioMonitoring: false
  });

  // Computed values
  formattedCurrentTime = computed(() => this.formatTime(this.editorState().currentTime));
  formattedDuration = computed(() => this.formatTime(this.editorState().duration));
  timelineProgress = computed(() => {
    const state = this.editorState();
    return (state.currentTime / state.duration) * 100;
  });

  // Selection duration formatted as HH:MM:SS
  formattedSelectionDuration = computed(() => {
    const selection = this.highlightSelection();
    if (!selection) return null;

    const durationSeconds = selection.endTime - selection.startTime;
    if (durationSeconds < 0.1) return null; // Too small to display

    const hrs = Math.floor(durationSeconds / 3600);
    const mins = Math.floor((durationSeconds % 3600) / 60);
    const secs = Math.floor(durationSeconds % 60);

    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  });

  /**
   * The one list both the section panel and the timeline marker layer render.
   *
   * TWO INDEPENDENT FILTERS, applied in this order:
   *   1. the per-category chips (which kinds of finding am I looking at);
   *   2. the flag filter (how strong a finding has to be to be shown, and
   *      whether the verifier's rejections are shown ghosted).
   *
   * Ghosted rows are NOT removed here. At LOOSE they pass the filter and travel
   * down to the renderers, which style them from `verdict` — hiding them would
   * defeat the point of the position.
   */
  filteredSections = computed(() => {
    const filters = this.categoryFilters();
    const flagFilter = this.flagFilter();
    const allSections = this.sections();

    const byFlagFilter = allSections.filter(s => passesFlagFilter(s, flagFilter));
    if (filters.length === 0) return byFlagFilter;

    const enabledCategories = new Set(
      filters.filter(f => f.enabled).map(f => f.category)
    );

    return byFlagFilter.filter(s =>
      enabledCategories.has(s.category.toLowerCase())
    );
  });

  /**
   * Per-position counts for the filter control, computed over the CATEGORY-
   * filtered set so the numbers on the control match what pressing it produces.
   */
  flagFilterCounts = computed(() => {
    const filters = this.categoryFilters();
    const enabled = new Set(filters.filter(f => f.enabled).map(f => f.category));
    const scoped = filters.length === 0
      ? this.sections()
      : this.sections().filter(s => enabled.has(s.category.toLowerCase()));
    return {
      confirmed: scoped.filter(s => passesFlagFilter(s, 'confirmed')).length,
      review: scoped.filter(s => passesFlagFilter(s, 'review')).length,
      all: scoped.length,
    };
  });

  // Sidebar visibility
  showAnalysisSidebar = signal(true);
  // Tracks a manual sidebar toggle so the "collapse when empty" default
  // doesn't override the user's explicit choice.
  private sidebarUserOverride = false;

  // Timeline resizing
  timelineHeight = signal(150); // Compact default to match the slimmer waveform track
  isResizing = signal(false);

  // Fullscreen mode
  isFullscreen = signal(false);
  showTimelineInFullscreen = signal(true);
  private fullscreenTimeout?: any;

  private playbackInterval?: any;
  private unsubVideoPathUpdated?: () => void;
  private unsubVideoRenamed?: () => void;

  // Track playing state separately to avoid effect re-triggering
  private wasPlaying = false;

  constructor() {
    // Initialize category filters from sections with error handling
    effect(() => {
      try {
        const sections = this.sections();
        this.updateCategoryFilters(sections);
      } catch (error) {
        console.error('Error updating category filters:', error);
      }
    }, { allowSignalWrites: true });

    // Set up playback effect - only react to isPlaying changes
    effect(() => {
      try {
        const isPlaying = this.editorState().isPlaying;
        if (isPlaying !== this.wasPlaying) {
          this.wasPlaying = isPlaying;
          if (isPlaying) {
            // Starting playback clears the "finished" glow.
            this.videoCompleted.set(false);
            this.startPlayback();
            // Hide timeline immediately in fullscreen when playing starts
            if (this.isFullscreen()) {
              this.clearFullscreenTimeout();
              this.showTimelineInFullscreen.set(false);
            }
          } else {
            this.stopPlayback();
            // Show timeline briefly when paused, then hide after delay
            if (this.isFullscreen()) {
              this.showTimelineInFullscreen.set(true);
              this.hideTimelineAfterDelay();
            }
          }
        }
      } catch (error) {
        console.error('Error in playback effect:', error);
        this.stopPlayback();
      }
    }, { allowSignalWrites: true });
  }

  ngOnInit() {
    // Hide the side navigation when entering the editor
    this.navService.hideNav();


    // Add wheel listener with passive: false to allow preventDefault
    window.addEventListener('wheel', this.wheelHandler, { passive: false });

    // Add fullscreen event listeners
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', this.onFullscreenChange);
    document.addEventListener('mousemove', this.onMouseMoveInFullscreen);

    // Set up ResizeObserver for 16:9 border calculation
    this.setupResizeObserver();

    // Get video data from route state or query params (for popout window)
    const navigation = this.router.getCurrentNavigation();
    const state = navigation?.extras?.state || history.state;
    let videoEditorData = state?.videoEditorData;

    // Check query params if no route state (popout window case)
    if (!videoEditorData) {
      const queryParams = this.route.snapshot.queryParams;
      if (queryParams['videoId']) {
        videoEditorData = {
          videoId: queryParams['videoId'],
          videoPath: queryParams['videoPath'] || null,
          videoTitle: queryParams['videoTitle'] ? decodeURIComponent(queryParams['videoTitle']) : 'Untitled Video'
        };
        // Mark as popout mode for potential UI adjustments
        this.isPopoutMode = queryParams['popout'] === 'true';
      }
    }

    if (videoEditorData) {
      // Open video in a new tab
      this.openTab(
        videoEditorData.videoId,
        videoEditorData.videoPath || null,
        videoEditorData.videoTitle || 'Untitled Video'
      );
    } else {
      this.isLoading.set(false);
      this.errorMessage.set('No video data provided. Please select a video from the library.');
      this.hasAnalysis.set(false);
    }

    // Listen for video-path-updated events so replaced videos reload automatically.
    // This fires after an overwrite export, where the new file already has scale
    // and border baked in — so we reset those per-tab settings to defaults to
    // avoid double-applying the zoom on top of the already-zoomed content.
    this.unsubVideoPathUpdated = this.websocketService.onVideoPathUpdated((event) => {
      const tabs = this.tabs();
      const matchingTab = tabs.find(t => t.videoId === event.videoId);
      if (!matchingTab) return;

      // Update the tab's videoUrl with a cache-busting param to force reload
      const freshUrl = `${this.API_BASE}/database/videos/${event.videoId}/stream?t=${Date.now()}`;
      this.tabs.update(allTabs => allTabs.map(t =>
        t.videoId === event.videoId
          ? {
              ...t,
              videoUrl: freshUrl,
              videoPath: event.newPath,
              videoScale: 1.0,
              showBorder: false,
              borderAspectRatio: '16:9',
            }
          : t
      ));

      // If this is the active tab, update the live signals so the video element
      // reloads and the scale/border controls reflect the defaults.
      if (this.activeTabId() === matchingTab.id) {
        this.videoUrl.set(freshUrl);
        this.videoPath.set(event.newPath);
        this.videoScale.set(1.0);
        this.showBorder.set(false);
        this.borderAspectRatio.set('16:9');
      }
    });

    // Listen for video-renamed events so the editor's cached videoPath stays
    // in sync when a file is renamed (manually or via AI suggestion). Without
    // this, exporting after a rename would send a stale path to the backend
    // and fail with "Video file not found".
    this.unsubVideoRenamed = this.websocketService.onVideoRenamed((event) => {
      const tabs = this.tabs();
      const matchingTab = tabs.find(t => t.videoId === event.videoId);
      if (!matchingTab) return;

      this.tabs.update(allTabs => allTabs.map(t =>
        t.videoId === event.videoId
          ? { ...t, videoPath: event.newPath, videoTitle: event.newFilename }
          : t
      ));

      if (this.activeTabId() === matchingTab.id) {
        this.videoPath.set(event.newPath);
      }
    });

    // Try to start the video editor tour (basic tour first, then advanced)
    setTimeout(() => {
      if (this.tourService.tryAutoStartTour('video-editor', 1000)) {
        // Queue the advanced tour to run after basic tour completes
        this.tourService.queueTour('video-editor-advanced');
      } else if (!this.tourService.isTourCompleted('video-editor-advanced')) {
        // If basic tour was already completed, try the advanced tour
        this.tourService.tryAutoStartTour('video-editor-advanced', 1000);
      }
    }, 1500);

    // Listen for IPC events to add new tabs (when opening videos from library while editor is already open)
    window.addEventListener('electron-add-editor-tab', this.handleAddEditorTabEvent);

    // Listen for IPC events for group operations
    window.addEventListener('electron-receive-tab', this.handleReceiveTabEvent);
    window.addEventListener('electron-request-all-tabs', this.handleRequestAllTabsEvent);
    window.addEventListener('electron-restore-tab-state', this.handleRestoreTabStateEvent);

    // Fetch current group number
    this.fetchCurrentGroupNumber();
  }

  private async fetchCurrentGroupNumber(): Promise<void> {
    try {
      if ((window as any).electron?.getCurrentGroupNumber) {
        const groupNumber = await (window as any).electron.getCurrentGroupNumber();
        this.currentGroupNumber.set(groupNumber);
        console.log('Current group number:', groupNumber);
      }
    } catch (error) {
      console.error('Error fetching current group number:', error);
    }
  }

  // Handler for add-editor-tab events from Electron
  private handleAddEditorTabEvent = (event: Event) => {
    const customEvent = event as CustomEvent<{ videoId: string; videoPath?: string; videoTitle: string }>;
    const videoData = customEvent.detail;
    if (videoData) {
      console.log('Received add-editor-tab event:', videoData);
      this.openTab(videoData.videoId, videoData.videoPath || null, videoData.videoTitle || 'Untitled Video');
    }
  };

  // Handler for receive-tab events (when a tab is moved from another window)
  private handleReceiveTabEvent = (event: Event) => {
    const customEvent = event as CustomEvent<any>;
    const tabData = customEvent.detail;
    if (tabData) {
      console.log('Received tab from another window:', tabData.videoId);
      this.receiveTabFromOtherWindow(tabData);
    }
  };

  // Handler for request-all-tabs events (for consolidation)
  private handleRequestAllTabsEvent = (event: Event) => {
    const customEvent = event as CustomEvent<{ targetGroupNumber: number }>;
    const { targetGroupNumber } = customEvent.detail;
    console.log('Request to send all tabs to group:', targetGroupNumber);
    this.sendAllTabsToGroup(targetGroupNumber);
  };

  // Handler for restore-tab-state events (when a new window receives full tab state)
  private handleRestoreTabStateEvent = (event: Event) => {
    const customEvent = event as CustomEvent<any>;
    const tabData = customEvent.detail;
    if (tabData) {
      console.log('Restoring tab state:', tabData.videoId);
      this.restoreIncomingTabState(tabData);
    }
  };

  private async loadVideoData(videoId: string) {
    try {
      this.isLoading.set(true);
      this.errorMessage.set(null);
      this.sidebarUserOverride = false; // new video → re-evaluate sidebar default

      // Load video details with timeout protection
      const timeoutId = setTimeout(() => {
        console.error('Video loading timed out');
        this.errorMessage.set('Video loading timed out. Please try again.');
        this.isLoading.set(false);
      }, 30000); // 30 second timeout

      // Load video details
      this.libraryService.getVideo(videoId).subscribe({
        next: (response) => {
          clearTimeout(timeoutId);
          if (response.success && response.data) {
            const video = response.data;
            this.metadata.update(m => ({
              ...m,
              filename: video.name,
              fileSize: video.size || 0
            }));

            // Load transcript separately (non-blocking)
            this.loadTranscriptForVideo(videoId).catch(err => {
              console.warn('Transcript loading failed, continuing without it:', err);
            }).finally(() => this.applySidebarDefault());

            // Always load sections (includes both AI sections and custom markers)
            // loadAnalysisForVideo now handles both cases properly.
            // Progressive render stands, but the failure is no longer silent —
            // the timeline missing its AI sections gets a visible chip
            // (fallback-audit discuss #19).
            this.loadAnalysisForVideo(videoId).catch(err => {
              console.warn('Section/analysis loading failed, continuing without it:', err);
              this.hasAnalysis.set(false);
              this.analysisLoadFailed.set(true);
            }).finally(() => this.applySidebarDefault());

            // Load mute sections for audio censoring
            this.loadMuteSections(videoId).catch(err => {
              console.warn('Mute sections loading failed, continuing without it:', err);
            });

            // Set initial hasAnalysis state based on video metadata
            if (!video.hasAnalysis) {
              this.hasAnalysis.set(false);
            }

            // Mark tab as loaded and save state
            this.markTabLoaded();
          } else {
            this.hasAnalysis.set(false);
          }
          this.isLoading.set(false);
        },
        error: (error) => {
          clearTimeout(timeoutId);
          console.error('Failed to load video details:', error);
          this.hasAnalysis.set(false);
          this.isLoading.set(false);
        }
      });

    } catch (error) {
      console.error('Failed to load video data:', error);
      this.errorMessage.set('Failed to load video data. Please try again.');
      this.isLoading.set(false);
    }
  }

  private async loadTranscriptForVideo(videoId: string) {
    try {
      const data = await firstValueFrom(
        this.http.get<any>(`${this.API_BASE}/database/videos/${videoId}/transcript`)
      );

      if (data && data.transcript && Array.isArray(data.transcript)) {
        this.transcript.set(data.transcript);
      } else if (data && Array.isArray(data)) {
        this.transcript.set(data);
      } else if (data && data.srt_format) {
        // Parse SRT format into segments
        const segments = this.parseSrtToSegments(data.srt_format);
        this.transcript.set(segments);
      } else {
        this.transcript.set([]);
      }
    } catch (error) {
      console.log('Failed to load transcript:', error);
      this.transcript.set([]);
    }
  }

  private parseSrtToSegments(srtContent: string): TranscriptionSegment[] {
    const segments: TranscriptionSegment[] = [];
    const blocks = srtContent.trim().split(/\n\n+/);

    for (const block of blocks) {
      const lines = block.split('\n');
      if (lines.length < 3) continue;

      // Parse timestamp line (e.g., "00:00:00,000 --> 00:00:05,000")
      const timestampLine = lines[1];
      const timestampMatch = timestampLine.match(
        /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/
      );

      if (!timestampMatch) continue;

      const startTime =
        parseInt(timestampMatch[1]) * 3600 +
        parseInt(timestampMatch[2]) * 60 +
        parseInt(timestampMatch[3]) +
        parseInt(timestampMatch[4]) / 1000;

      const endTime =
        parseInt(timestampMatch[5]) * 3600 +
        parseInt(timestampMatch[6]) * 60 +
        parseInt(timestampMatch[7]) +
        parseInt(timestampMatch[8]) / 1000;

      // Text is everything after the timestamp line
      const text = lines.slice(2).join(' ').trim();

      segments.push({
        id: `segment-${segments.length}`,
        startTime,
        endTime,
        text
      });
    }

    return segments;
  }

  /**
   * Load mute sections for a video
   */
  private async loadMuteSections(videoId: string) {
    try {
      const response = await firstValueFrom(
        this.libraryService.getMuteSections(videoId)
      );
      if (response.success && response.data) {
        this.muteSections.set(response.data);
      } else {
        // success:false = load FAILED (mutes may exist) — warn so the user
        // doesn't edit mutes against an incomplete layer (fallback-audit #21).
        this.muteSections.set([]);
        this.showEditorError("Couldn't load mute sections — existing mutes may not show", response);
      }
    } catch (error) {
      this.muteSections.set([]);
      this.showEditorError("Couldn't load mute sections — existing mutes may not show", error);
    }
  }

  /**
   * Add a mute section for the current selection
   */
  async addMuteSection() {
    const selection = this.highlightSelection();
    if (!selection) return;

    const videoId = this.activeTab()?.videoId;
    if (!videoId) return;

    try {
      const response = await firstValueFrom(
        this.libraryService.addMuteSection(videoId, selection.startTime, selection.endTime)
      );

      if (response.success) {
        // Reload mute sections to get the new one
        await this.loadMuteSections(videoId);
        // Clear selection after adding mute
        this.highlightSelection.set(null);
      } else {
        this.showEditorError("Mute didn't save — try again", response);
      }
    } catch (error) {
      this.showEditorError("Mute didn't save — try again", error);
    }
  }

  /**
   * Delete a mute section
   */
  async deleteMuteSection(section: MuteSection) {
    try {
      const response = await firstValueFrom(
        this.libraryService.deleteMuteSection(section.id)
      );

      if (response.success) {
        // Remove from local state
        this.muteSections.update(sections =>
          sections.filter(s => s.id !== section.id)
        );
        this.selectedMuteSection.set(undefined);
      } else {
        this.showEditorError("Mute didn't delete — try again", response);
      }
    } catch (error) {
      this.showEditorError("Mute didn't delete — try again", error);
    }
  }

  /**
   * Handle mute section click from timeline
   */
  onMuteSectionClick(section: MuteSection) {
    this.selectedMuteSection.set(section);
    // Seek to the start of the mute section
    this.seekTo(section.startSeconds);
  }

  /**
   * Handle mute section delete from timeline
   */
  onMuteSectionDelete(section: MuteSection) {
    this.deleteMuteSection(section);
  }

  // Track which mute section is being resized
  private resizingMuteSection: MuteSection | null = null;
  private resizingMuteHandle: 'left' | 'right' | null = null;

  /**
   * Handle mute section resize start from timeline
   */
  onMuteSectionResizeStart(event: MuteResizeEvent) {
    event.event.preventDefault();
    event.event.stopPropagation();

    this.resizingMuteSection = event.section;
    this.resizingMuteHandle = event.handle;
    document.body.style.cursor = 'ew-resize';

    const onMouseMove = (e: MouseEvent) => {
      const time = this.getTimeFromMousePositionDocument(e);
      if (time === null || !this.resizingMuteSection) return;

      const section = this.resizingMuteSection;

      if (this.resizingMuteHandle === 'left') {
        // Dragging left handle - update start time
        const newStart = Math.max(0, Math.min(time, section.endSeconds - 0.1));
        // Update local state immediately for smooth feedback
        this.muteSections.update(sections =>
          sections.map(s => s.id === section.id ? { ...s, startSeconds: newStart } : s)
        );
        this.resizingMuteSection = { ...section, startSeconds: newStart };
      } else if (this.resizingMuteHandle === 'right') {
        // Dragging right handle - update end time
        const newEnd = Math.min(this.editorState().duration, Math.max(time, section.startSeconds + 0.1));
        // Update local state immediately for smooth feedback
        this.muteSections.update(sections =>
          sections.map(s => s.id === section.id ? { ...s, endSeconds: newEnd } : s)
        );
        this.resizingMuteSection = { ...section, endSeconds: newEnd };
      }
    };

    const onMouseUp = async () => {
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      // Save the final position to the database
      if (this.resizingMuteSection) {
        const section = this.resizingMuteSection;
        try {
          const response = await firstValueFrom(
            this.libraryService.updateMuteSection(section.id, section.startSeconds, section.endSeconds)
          );
          if (!response.success) {
            // Revert-worthy: the DB still has the old bounds — reload so the
            // timeline shows the truth instead of an unsaved resize.
            this.showEditorError("Mute resize didn't save — reverting", response.error);
            await this.loadMuteSections(section.videoId);
          }
        } catch (error) {
          this.showEditorError("Mute resize didn't save — reverting", error);
          const vid = this.activeTab()?.videoId;
          if (vid) {
            await this.loadMuteSections(vid);
          }
        }
      }

      this.resizingMuteSection = null;
      this.resizingMuteHandle = null;
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  private async loadAnalysisForVideo(videoId: string) {
    this.analysisLoadFailed.set(false);
    try {
      // Always fetch sections (both AI and custom markers)
      const sectionsData = await firstValueFrom(
        this.http.get<any>(`${this.API_BASE}/database/videos/${videoId}/sections`)
      );
      const sections = sectionsData?.sections || [];

      // Fetch chapters
      let chaptersData: any[] = [];
      try {
        const chaptersResponse = await firstValueFrom(
          this.http.get<any>(`${this.API_BASE}/database/videos/${videoId}/chapters`)
        );
        chaptersData = chaptersResponse?.chapters || [];
      } catch {
        // Chapters don't exist, that's fine
      }

      // Process chapters
      if (chaptersData.length > 0) {
        const timelineChapters: TimelineChapter[] = chaptersData.map((chapter: any) => ({
          id: chapter.id,
          videoId: chapter.video_id,
          sequence: chapter.sequence,
          startTime: chapter.start_seconds || 0,
          endTime: chapter.end_seconds || chapter.start_seconds + 60,
          title: chapter.title || `Chapter ${chapter.sequence}`,
          description: chapter.description,
          source: chapter.source || 'ai'
        }));
        this.chapters.set(timelineChapters);
      } else {
        this.chapters.set([]);
      }

      // Try to fetch analysis data (may not exist)
      let analysisData: any = null;
      try {
        analysisData = await firstValueFrom(
          this.http.get<any>(`${this.API_BASE}/database/videos/${videoId}/analysis`)
        );
      } catch {
        // Analysis doesn't exist, that's fine
      }

      if (analysisData && !analysisData.error) {
        this.processAnalysisFromDatabase(analysisData, sections);
      } else {
        // No analysis, but still process sections (custom markers)
        this.processSectionsOnly(sections);
      }
    } catch (error: any) {
      // Surface the failure so the caller's dismissible chip appears — this
      // inner catch used to swallow it, leaving analysisLoadFailed dead code.
      console.error('Failed to load sections/analysis:', error);
      this.hasAnalysis.set(false);
      this.analysisLoadFailed.set(true);
    }
  }

  /**
   * Process sections without analysis data (for custom markers only)
   */
  private processSectionsOnly(sections: any[]) {
    const timelineSections: TimelineSection[] = sections.map((section: any, index: number) => ({
      id: section.id || `section-${index}`,
      startTime: section.start_seconds || 0,
      endTime: section.end_seconds || section.start_seconds + 10,
      category: section.category || 'marker',
      description: section.description || section.title || '',
      color: CATEGORY_COLORS[section.category?.toLowerCase()] || CATEGORY_COLORS['default'],
      // NULL on legacy rows, custom markers and discovery-path flags. The
      // filter reads NULL as "an accepted flag with no score", so those render
      // exactly as they always have — see models/flag-filter.ts.
      verdict: section.verdict ?? null,
      nliScore: typeof section.nli_score === 'number' ? section.nli_score : null
    }));

    this.sections.set(timelineSections);
  }

  private processAnalysisFromDatabase(analysis: any, sections: any[]) {
    // Convert database sections to timeline sections
    const timelineSections: TimelineSection[] = sections.map((section: any, index: number) => ({
      id: section.id || `section-${index}`,
      startTime: section.start_seconds || 0,
      endTime: section.end_seconds || section.start_seconds + 10,
      category: section.category || 'unknown',
      description: section.description || section.content || '',
      color: CATEGORY_COLORS[section.category?.toLowerCase()] || CATEGORY_COLORS['default'],
      // See processSectionsOnly: NULL means legacy/discovery and passes every
      // filter position.
      verdict: section.verdict ?? null,
      nliScore: typeof section.nli_score === 'number' ? section.nli_score : null
    }));

    this.sections.set(timelineSections);
    this.hasAnalysis.set(true);

    // Set analysis data for sidebar
    this.analysisData.set({
      id: analysis.id || 'analysis',
      title: analysis.suggested_title || analysis.title || this.videoTitle(),
      summary: analysis.description || analysis.summary || '',
      sections: timelineSections.map(s => ({
        timeRange: `${this.formatTime(s.startTime)} - ${this.formatTime(s.endTime)}`,
        startSeconds: s.startTime,
        endSeconds: s.endTime,
        category: s.category,
        description: s.description
      })),
      quotes: analysis.quotes || []
    });

    // Update metadata
    if (analysis.suggested_title) {
      this.metadata.update(m => ({
        ...m,
        filename: analysis.suggested_title
      }));
    }
  }

  private setDemoSections() {
    // Set demo sections for visualization
    const demoSections: TimelineSection[] = [
      {
        id: '1',
        startTime: 5,
        endTime: 15,
        category: 'violence',
        description: 'Scene contains violent imagery',
        color: CATEGORY_COLORS['violence']
      },
      {
        id: '2',
        startTime: 30,
        endTime: 45,
        category: 'misinformation',
        description: 'Claims without factual basis',
        color: CATEGORY_COLORS['misinformation']
      },
      {
        id: '3',
        startTime: 60,
        endTime: 80,
        category: 'educational',
        description: 'Educational content',
        color: CATEGORY_COLORS['educational']
      }
    ];
    this.sections.set(demoSections);

    // Set demo analysis data
    this.analysisData.set({
      id: 'demo',
      title: 'Demo Analysis',
      summary: 'This is demo data. Run analysis to see actual results.',
      sections: demoSections.map(s => ({
        timeRange: `${this.formatTime(s.startTime)} - ${this.formatTime(s.endTime)}`,
        startSeconds: s.startTime,
        endSeconds: s.endTime,
        category: s.category,
        description: s.description
      })),
      quotes: []
    });
  }

  private processAnalysisData(analysis: LibraryAnalysis) {
    // Parse the analysis file if it exists
    if (analysis.files?.analysis) {
      // The analysis file path needs to be fetched and parsed
      this.fetchAndParseAnalysis(analysis);
    }

    // Set metadata
    this.metadata.update(m => ({
      ...m,
      filename: analysis.title || m.filename,
      duration: analysis.video?.durationSeconds || m.duration
    }));

    // Update duration in editor state
    if (analysis.video?.durationSeconds) {
      this.editorState.update(state => ({
        ...state,
        duration: analysis.video.durationSeconds!
      }));

      // Waveform will be generated when video loads via onVideoDurationChange
    }
  }

  private async fetchAndParseAnalysis(analysis: LibraryAnalysis) {
    try {
      // Fetch the analysis JSON file
      const analysisUrl = `${this.API_BASE}/library/analyses/${analysis.id}/analysis`;
      const analysisJson = await firstValueFrom(
        this.http.get<any>(analysisUrl)
      );

      // Convert to timeline sections
      const timelineSections: TimelineSection[] = [];

      if (analysisJson.analysis?.sections) {
        analysisJson.analysis.sections.forEach((section: any, index: number) => {
          const startSeconds = this.parseTimeToSeconds(section.timeRange?.split(' - ')[0] || '0:00');
          const endSeconds = this.parseTimeToSeconds(section.timeRange?.split(' - ')[1] || '0:00') || startSeconds + 10;

          timelineSections.push({
            id: `section-${index}`,
            startTime: startSeconds,
            endTime: endSeconds,
            category: section.category || 'unknown',
            description: section.description || '',
            color: CATEGORY_COLORS[section.category?.toLowerCase()] || CATEGORY_COLORS['default']
          });
        });
      }

      this.sections.set(timelineSections);

      // Set analysis data for sidebar
      this.analysisData.set({
        id: analysis.id,
        title: analysisJson.analysis?.title || analysis.title,
        summary: analysisJson.analysis?.summary,
        sections: analysisJson.analysis?.sections || [],
        quotes: analysisJson.analysis?.quotes || []
      });
    } catch (error) {
      console.error('Failed to fetch analysis:', error);
    }
  }

  private parseTimeToSeconds(timeStr: string): number {
    if (!timeStr) return 0;
    const parts = timeStr.split(':').map(p => parseInt(p, 10));
    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    } else if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    return 0;
  }

  ngOnDestroy() {
    // Show the side navigation when leaving the editor
    this.navService.showNav();
    this.stopPlayback();

    // Clean up websocket subscriptions
    this.unsubVideoPathUpdated?.();
    this.unsubVideoRenamed?.();

    // Remove event listeners
    window.removeEventListener('wheel', this.wheelHandler);
    window.removeEventListener('electron-add-editor-tab', this.handleAddEditorTabEvent);
    window.removeEventListener('electron-receive-tab', this.handleReceiveTabEvent);
    window.removeEventListener('electron-request-all-tabs', this.handleRequestAllTabsEvent);
    window.removeEventListener('electron-restore-tab-state', this.handleRestoreTabStateEvent);
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', this.onFullscreenChange);
    document.removeEventListener('mousemove', this.onMouseMoveInFullscreen);

    // Clean up timeline dragging listeners
    document.removeEventListener('mousemove', this.onDocumentMouseMove);
    document.removeEventListener('mouseup', this.onDocumentMouseUp);

    this.clearFullscreenTimeout();

    // Stop any in-flight waveform progress poller
    if (this.waveformPollInterval) {
      clearInterval(this.waveformPollInterval);
      this.waveformPollInterval = undefined;
    }

    // Clear the tab-restore fallback timeout
    if (this.restoreTabTimeout) {
      clearTimeout(this.restoreTabTimeout);
      this.restoreTabTimeout = undefined;
    }

    // Clean up ResizeObserver
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
  }

  // Set up ResizeObserver to calculate 16:9 border dimensions
  private setupResizeObserver() {
    // Use requestAnimationFrame to wait for the view to be ready
    requestAnimationFrame(() => {
      const element = document.querySelector('.video-player-area') as HTMLElement;
      if (!element) {
        // Retry after a short delay
        setTimeout(() => this.setupResizeObserver(), 100);
        return;
      }

      this.resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          this.updateBorderDimensions(entry.contentRect.width, entry.contentRect.height);
        }
      });

      this.resizeObserver.observe(element);

      // Initial calculation
      const rect = element.getBoundingClientRect();
      this.updateBorderDimensions(rect.width, rect.height);
    });
  }

  // Calculate the largest rectangle of the selected aspect ratio that fits within the container
  private updateBorderDimensions(containerWidth: number, containerHeight: number) {
    const aspectRatio = this.borderAspectRatio();
    const targetAspectRatio = aspectRatio === '16:9' ? 16 / 9 : aspectRatio === '9:16' ? 9 / 16 : 4 / 3;
    const containerAspectRatio = containerWidth / containerHeight;

    let width: number;
    let height: number;

    if (containerAspectRatio > targetAspectRatio) {
      // Container is wider than target - height is the limiting factor
      height = containerHeight;
      width = height * targetAspectRatio;
    } else {
      // Container is taller than target - width is the limiting factor
      width = containerWidth;
      height = width / targetAspectRatio;
    }

    this.borderWidth.set(width);
    this.borderHeight.set(height);
  }

  // Toggle border visibility
  toggleBorder() {
    this.showBorder.update(v => !v);
  }

  // Change border aspect ratio
  onAspectRatioChange(ratio: '16:9' | '4:3' | '9:16') {
    this.borderAspectRatio.set(ratio);
    // Recalculate border dimensions
    const element = document.querySelector('.video-player-area') as HTMLElement;
    if (element) {
      const rect = element.getBoundingClientRect();
      this.updateBorderDimensions(rect.width, rect.height);
    }
  }

  // Navigate back to library or close window in popout mode
  goBack() {
    if (this.isPopoutMode) {
      window.close();
    } else {
      this.router.navigate(['/']);
    }
  }

  private updateCategoryFilters(sections: TimelineSection[]): void {
    const categories = new Map<string, CategoryFilter>();

    sections.forEach(section => {
      const category = section.category.toLowerCase();
      if (!categories.has(category)) {
        categories.set(category, {
          category,
          label: section.category,
          color: section.color,
          enabled: true
        });
      }
    });

    const filters = Array.from(categories.values())
      .sort((a, b) => a.label.localeCompare(b.label));

    this.categoryFilters.set(filters);
  }

  private startPlayback() {
    this.stopPlayback();
    // Add safety check to prevent runaway intervals
    let intervalCount = 0;
    this.playbackInterval = setInterval(() => {
      intervalCount++;

      // Safety: stop after 1 hour of continuous playback
      if (intervalCount > 36000) {
        console.warn('Playback interval safety limit reached, stopping');
        this.stopPlayback();
        this.togglePlayPause();
        return;
      }

      const state = this.editorState();
      let newTime = state.currentTime + (0.1 * state.playbackRate);

      if (newTime >= state.duration) {
        newTime = state.duration;
        this.togglePlayPause();
        // Reached the final frame — light up the "finished" glowing border.
        this.videoCompleted.set(true);
      }

      this.updateCurrentTime(newTime);
    }, 100);
  }

  private stopPlayback() {
    if (this.playbackInterval) {
      clearInterval(this.playbackInterval);
      this.playbackInterval = undefined;
    }
  }

  // Playback controls
  togglePlayPause() {
    this.editorState.update(state => ({
      ...state,
      isPlaying: !state.isPlaying
    }));
  }

  updateCurrentTime(time: number) {
    this.editorState.update(state => ({
      ...state,
      currentTime: Math.max(0, Math.min(time, state.duration))
    }));
  }

  seekTo(time: number) {
    this.videoCompleted.set(false);
    this.updateCurrentTime(time);
    if (this.videoPlayer) {
      this.videoPlayer.seekTo(time);
    }
  }

  skipBackward(seconds: number = 5) {
    const state = this.editorState();
    this.seekTo(state.currentTime - seconds);
  }

  skipForward(seconds: number = 5) {
    const state = this.editorState();
    this.seekTo(state.currentTime + seconds);
  }

  setPlaybackRate(rate: number) {
    this.editorState.update(state => ({
      ...state,
      playbackRate: rate
    }));
  }

  // Increase playback speed with L key
  increasePlaybackSpeed() {
    const currentRate = this.editorState().playbackRate;
    const speeds = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

    // If not playing, start playing first
    if (!this.editorState().isPlaying) {
      this.togglePlayPause();
      return;
    }

    // Find next higher speed
    let nextSpeed = currentRate;
    for (const speed of speeds) {
      if (speed > currentRate) {
        nextSpeed = speed;
        break;
      }
    }

    // Max out at 4x
    if (currentRate >= 4) {
      nextSpeed = 4;
    }

    this.setPlaybackRate(nextSpeed);
  }

  // Decrease playback speed with J key
  decreasePlaybackSpeed() {
    const currentRate = this.editorState().playbackRate;
    const speeds = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

    // Find next lower speed
    let nextSpeed = currentRate;
    for (let i = speeds.length - 1; i >= 0; i--) {
      if (speeds[i] < currentRate) {
        nextSpeed = speeds[i];
        break;
      }
    }

    // Min out at 0.25x
    if (currentRate <= 0.25) {
      nextSpeed = 0.25;
    }

    this.setPlaybackRate(nextSpeed);
  }

  setVolume(volume: number) {
    // Allow volume up to 10 (1000%) for amplification
    const clampedVolume = Math.max(0, Math.min(10, volume));

    this.editorState.update(state => ({
      ...state,
      volume: clampedVolume
    }));

    // Initialize audio context on user interaction (needed for amplification)
    if (clampedVolume > 1 && this.videoPlayer) {
      this.videoPlayer.ensureAudioContext();
    }
  }

  // Tool management
  setTool(tool: EditorTool) {
    this.currentTool.set(tool);
    console.log('Switched to tool:', tool);
  }

  setToolCursor() {
    this.setTool(EditorTool.CURSOR);
  }

  setToolHighlight() {
    this.setTool(EditorTool.HIGHLIGHT);
  }

  onScaleChange(value: string) {
    const scale = parseFloat(value);
    this.videoScale.set(scale);
    if (scale > 1.0) {
      this.showBorder.set(true);
    }
  }

  // Get time from mouse position on timeline
  private getTimeFromMousePosition(event: MouseEvent): number | null {
    const target = event.currentTarget as HTMLElement;
    // Look for the timeline track container which has the margins
    const trackContainer = target.querySelector('.timeline-track-container') ||
                          target.querySelector('app-timeline-track');
    if (!trackContainer) return null;

    const containerRect = trackContainer.getBoundingClientRect();
    const clickX = event.clientX - containerRect.left;
    const trackWidth = containerRect.width;

    if (clickX < 0 || clickX > trackWidth || trackWidth <= 0) return null;

    const state = this.editorState();
    const visibleDuration = state.duration / state.zoomState.level;
    const percentage = clickX / trackWidth;

    return state.zoomState.offset + (percentage * visibleDuration);
  }

  // Get time from mouse position for document-level events
  private getTimeFromMousePositionDocument(event: MouseEvent): number | null {
    const timelineElement = document.querySelector('.track-content') as HTMLElement;
    if (!timelineElement) return null;

    // Look for the timeline track container which has the margins
    const trackContainer = timelineElement.querySelector('.timeline-track-container') ||
                          timelineElement.querySelector('app-timeline-track');
    if (!trackContainer) return null;

    const containerRect = trackContainer.getBoundingClientRect();
    const clickX = event.clientX - containerRect.left;
    const trackWidth = containerRect.width;

    const state = this.editorState();
    const visibleDuration = state.duration / state.zoomState.level;
    const percentage = Math.max(0, Math.min(1, clickX / trackWidth));

    return state.zoomState.offset + (percentage * visibleDuration);
  }

  // Show context menu for highlighted selection
  private showContextMenu(event: MouseEvent) {
    const actions: ContextMenuAction[] = [
      {
        id: 'export',
        label: 'Export Selection',
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>'
      },
      {
        id: 'add-marker',
        label: 'Add Marker',
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L12 22"/><path d="M17 7L12 2 7 7"/></svg>'
      },
      {
        id: 'mute-selection',
        label: 'Mute Selection',
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>'
      },
      { id: 'divider', label: '', divider: true },
      {
        id: 'clear',
        label: 'Clear Selection',
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>'
      }
    ];

    this.contextMenuActions.set(actions);
    this.contextMenuPosition.set({ x: event.clientX, y: event.clientY });
    this.showContextMenu$.set(true);
  }

  // Handle context menu action
  onContextMenuAction(actionId: string) {
    this.showContextMenu$.set(false);

    switch (actionId) {
      case 'export':
        this.openExportDialog();
        break;
      case 'add-marker':
        this.addMarker();
        break;
      case 'mute-selection':
        this.addMuteSection();
        break;
      case 'clear':
        this.clearSelection();
        break;
    }
  }

  // Close context menu
  onContextMenuClose() {
    this.showContextMenu$.set(false);
  }

  // Set in-point at current playhead position
  setInPoint() {
    const currentTime = this.editorState().currentTime;
    const selection = this.highlightSelection();

    if (selection) {
      // Update existing selection start
      this.highlightSelection.set({
        startTime: currentTime,
        endTime: Math.max(currentTime, selection.endTime)
      });
    } else {
      // Create new selection starting at current time
      this.highlightSelection.set({
        startTime: currentTime,
        endTime: currentTime
      });
    }
  }

  // Set out-point at current playhead position
  setOutPoint() {
    const currentTime = this.editorState().currentTime;
    const selection = this.highlightSelection();

    if (selection) {
      // Update existing selection end
      this.highlightSelection.set({
        startTime: Math.min(selection.startTime, currentTime),
        endTime: currentTime
      });
    } else {
      // Create new selection ending at current time
      this.highlightSelection.set({
        startTime: currentTime,
        endTime: currentTime
      });
    }
  }

  // Clear current selection
  clearSelection() {
    this.highlightSelection.set(null);
    this.selectionStart.set(null);
    this.isSelecting.set(false);
  }

  // Track which selection handle is being dragged
  private draggingHandle: 'left' | 'right' | null = null;

  // Start dragging a selection handle
  onSelectionHandleStart(event: MouseEvent, handle: 'left' | 'right') {
    event.preventDefault();
    event.stopPropagation();

    this.draggingHandle = handle;
    document.body.style.cursor = 'ew-resize';

    const onMouseMove = (e: MouseEvent) => {
      const time = this.getTimeFromMousePositionDocument(e);
      if (time === null) return;

      const selection = this.highlightSelection();
      if (!selection) return;

      if (this.draggingHandle === 'left') {
        // Dragging left handle - update start time
        const newStart = Math.min(time, selection.endTime - 0.1);
        this.highlightSelection.set({
          startTime: Math.max(0, newStart),
          endTime: selection.endTime
        });
        // Make playhead follow the handle
        this.seekTo(Math.max(0, newStart));
      } else if (this.draggingHandle === 'right') {
        // Dragging right handle - update end time
        const newEnd = Math.max(time, selection.startTime + 0.1);
        this.highlightSelection.set({
          startTime: selection.startTime,
          endTime: Math.min(this.editorState().duration, newEnd)
        });
        // Make playhead follow the handle
        this.seekTo(Math.min(this.editorState().duration, newEnd));
      }
    };

    const onMouseUp = () => {
      this.draggingHandle = null;
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  // Handle dragging the entire selection to move it
  onSelectionDragStart(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();

    const selection = this.highlightSelection();
    if (!selection) return;

    const startTime = this.getTimeFromMousePositionDocument(event);
    if (startTime === null) return;

    const selectionDuration = selection.endTime - selection.startTime;
    const initialOffset = startTime - selection.startTime;

    document.body.style.cursor = 'move';

    const onMouseMove = (e: MouseEvent) => {
      const time = this.getTimeFromMousePositionDocument(e);
      if (time === null) return;

      // Calculate new position based on where we grabbed
      const newStart = time - initialOffset;
      const clampedStart = Math.max(0, Math.min(this.editorState().duration - selectionDuration, newStart));
      const clampedEnd = clampedStart + selectionDuration;

      this.highlightSelection.set({
        startTime: clampedStart,
        endTime: clampedEnd
      });
    };

    const onMouseUp = () => {
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  // Add a marker to the current selection or current time
  addMarker() {
    const selection = this.highlightSelection();
    const videoId = this.videoId();

    if (!videoId) {
      console.error('No video ID available');
      return;
    }

    if (selection) {
      // Add marker for selected range
      this.openMarkerDialog(selection.startTime, selection.endTime);
    } else {
      // Add marker at current playhead position
      const currentTime = this.editorState().currentTime;
      this.openMarkerDialog(currentTime);
    }
  }

  // Open the marker dialog
  private openMarkerDialog(startTime: number, endTime?: number) {
    const videoId = this.videoId();
    if (!videoId) return;

    this.markerDialogData.set({
      videoId,
      startTime,
      endTime
    });
    this.showMarkerDialog.set(true);
  }

  // Handle marker dialog save
  async onMarkerSave(marker: Partial<CustomMarker>) {
    this.showMarkerDialog.set(false);

    try {
      const result = await firstValueFrom(
        this.http.post<any>(`${this.API_BASE}/database/analysis-sections`, {
          videoId: marker.videoId,
          startSeconds: marker.startTime,
          endSeconds: marker.endTime || marker.startTime,
          title: marker.message,
          description: marker.message,
          category: marker.category || 'marker'
        })
      );

      if (result.success) {
        // Refresh sections to include new marker
        await this.loadAnalysisForVideo(this.videoId()!);
        // Clear selection after adding marker
        this.clearSelection();
      } else {
        this.showEditorError("Marker didn't save — try again", result.error);
      }
    } catch (error) {
      this.showEditorError("Marker didn't save — try again", error);
    }
  }

  // Handle marker dialog cancel
  onMarkerCancel() {
    this.showMarkerDialog.set(false);
  }

  // Handle chapter save from marker dialog
  async onChapterSave(chapter: Partial<TimelineChapter>) {
    this.showMarkerDialog.set(false);

    try {
      const result = await firstValueFrom(
        this.http.post<any>(`${this.API_BASE}/database/chapters`, {
          videoId: chapter.videoId,
          startSeconds: chapter.startTime,
          endSeconds: chapter.endTime,
          title: chapter.title,
          description: chapter.description,
          sequence: chapter.sequence
        })
      );

      if (result.success) {
        // Refresh chapters to include new chapter
        await this.loadAnalysisForVideo(this.videoId()!);
        // Clear selection after adding chapter
        this.clearSelection();
      } else {
        this.showEditorError("Chapter didn't save — try again", result.error);
      }
    } catch (error) {
      this.showEditorError("Chapter didn't save — try again", error);
    }
  }

  // Handle marker delete
  async onMarkerDelete(markerId: string) {
    this.showMarkerDialog.set(false);

    const videoId = this.videoId();
    if (!videoId) return;

    try {
      const result = await firstValueFrom(
        this.http.delete<any>(`${this.API_BASE}/database/videos/${videoId}/sections/${markerId}`)
      );

      if (result.success) {
        // Refresh sections
        await this.loadAnalysisForVideo(this.videoId()!);
      } else {
        this.showEditorError("Marker didn't delete — try again", result.error);
      }
    } catch (error) {
      console.error('Error deleting marker:', error);
    }
  }

  // Open export dialog
  openExportDialog() {
    const videoId = this.videoId();
    const videoPath = this.videoPath();
    const videoTitle = this.metadata().filename;

    console.log('openExportDialog called:', { videoId, videoPath, videoTitle });

    if (!videoId) {
      console.error('Cannot open export dialog: missing video ID');
      return;
    }

    // videoPath might be null if opened from certain routes - that's ok, backend can look it up
    if (!videoPath) {
      console.warn('videoPath is null, export dialog may need to fetch it');
    }

    // Custom markers are NOT a second list to merge in. A saved marker is a
    // custom_markers row, and GET /videos/:id/sections returns those alongside
    // the AI sections, so markers are already in filteredSections() with their
    // own category. The customMarkers signal this used to merge was never
    // written to, so it contributed an empty array and made the marker path look
    // like it lived somewhere it doesn't.
    const sections = this.filteredSections().map(section => ({
      id: section.id,
      category: section.category,
      description: section.description,
      startSeconds: section.startTime,
      endSeconds: section.endTime,
      timeRange: `${this.formatTime(section.startTime)} - ${this.formatTime(section.endTime)}`
    }));

    // Get current selection if any
    const selection = this.highlightSelection();

    // Convert mute sections for export dialog
    const muteSectionsForExport = this.muteSections().map(ms => ({
      id: ms.id,
      startSeconds: ms.startSeconds,
      endSeconds: ms.endSeconds
    }));

    this.exportDialogData.set({
      sections,
      muteSections: muteSectionsForExport,
      selectionStart: selection?.startTime,
      selectionEnd: selection?.endTime,
      videoId,
      videoPath,
      videoTitle,
      videoScale: this.videoScale(),
      cropAspectRatio: (this.showBorder() && this.videoScale() > 1.0) ? this.borderAspectRatio() : undefined,
    });
    this.showExportDialog.set(true);
  }

  onExportDialogClose(event: { exported: boolean; navigateToQueue?: boolean }) {
    this.showExportDialog.set(false);
    this.exportDialogData.set(null);

    if (event.navigateToQueue) {
      this.navigateToQueue();
    }
  }

  private navigateToQueue() {
    const electron = (window as any).electron;
    if (electron?.navigateToQueue) {
      // Popout window — tell main window to switch to queue tab
      electron.navigateToQueue();
    }
    // Also dispatch for same-window usage
    window.dispatchEvent(new CustomEvent('navigate-to-queue'));
  }

  // Calculate selection overlay left position
  getSelectionLeft(): number {
    const selection = this.highlightSelection();
    if (!selection) return 0;

    const state = this.editorState();
    const visibleStart = state.zoomState.offset;
    const visibleDuration = state.duration / state.zoomState.level;

    const relativeStart = selection.startTime - visibleStart;
    return (relativeStart / visibleDuration) * 100;
  }

  // Calculate selection overlay width
  getSelectionWidth(): number {
    const selection = this.highlightSelection();
    if (!selection) return 0;

    const state = this.editorState();
    const visibleDuration = state.duration / state.zoomState.level;

    const duration = selection.endTime - selection.startTime;
    return (duration / visibleDuration) * 100;
  }

  // Get playhead position as percentage for fullscreen timeline
  getPlayheadPosition(): number {
    const state = this.editorState();
    const visibleStart = state.zoomState.offset;
    const visibleDuration = state.duration / state.zoomState.level;

    const relativeTime = state.currentTime - visibleStart;
    return (relativeTime / visibleDuration) * 100;
  }

  // Handle mousedown on fullscreen timeline to seek with drag support
  private isDraggingFullscreenTimeline = false;
  private fullscreenTimelineContainer: HTMLElement | null = null;

  onFullscreenTimelineMouseDown(event: MouseEvent) {
    event.preventDefault();
    this.isDraggingFullscreenTimeline = true;
    this.fullscreenTimelineContainer = event.currentTarget as HTMLElement;

    // Seek to initial position
    this.seekToFullscreenTimelinePosition(event);

    // Add document listeners for drag
    document.addEventListener('mousemove', this.onFullscreenTimelineMouseMove);
    document.addEventListener('mouseup', this.onFullscreenTimelineMouseUp);
  }

  private onFullscreenTimelineMouseMove = (event: MouseEvent) => {
    if (!this.isDraggingFullscreenTimeline || !this.fullscreenTimelineContainer) return;
    this.seekToFullscreenTimelinePosition(event);
  };

  private onFullscreenTimelineMouseUp = () => {
    this.isDraggingFullscreenTimeline = false;
    this.fullscreenTimelineContainer = null;
    document.removeEventListener('mousemove', this.onFullscreenTimelineMouseMove);
    document.removeEventListener('mouseup', this.onFullscreenTimelineMouseUp);
  };

  private seekToFullscreenTimelinePosition(event: MouseEvent) {
    if (!this.fullscreenTimelineContainer) return;

    const rect = this.fullscreenTimelineContainer.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, clickX / rect.width));

    const state = this.editorState();
    const visibleDuration = state.duration / state.zoomState.level;
    const time = state.zoomState.offset + (percentage * visibleDuration);

    this.seekTo(Math.max(0, Math.min(state.duration, time)));
  }

  // Zoom controls
  onZoomChange(zoomState: ZoomState) {
    this.editorState.update(state => ({
      ...state,
      zoomState
    }));
  }

  // Section interaction
  onSectionClick(section: TimelineSection) {
    this.editorState.update(state => ({
      ...state,
      selectedSection: section
    }));
    // Seek to section start
    this.seekTo(section.startTime);
  }

  onSectionHover(section: TimelineSection | null) {
    // Could show tooltip or highlight
  }

  // Chapter interaction
  onChapterClick(chapter: TimelineChapter) {
    this.selectedChapterId.set(chapter.id);
    // Seek to chapter start
    this.seekTo(chapter.startTime);
  }

  onChapterHover(chapter: TimelineChapter | null) {
    // Could show tooltip or highlight
  }

  // Delete chapter from analysis panel
  async onChapterDelete(chapterId: string) {
    const videoId = this.videoId();
    if (!videoId) return;

    try {
      await firstValueFrom(
        this.http.delete(`${this.API_BASE}/database/videos/${videoId}/chapters/${chapterId}`)
      );
      // Remove from local state
      this.chapters.update(chapters => chapters.filter(c => c.id !== chapterId));
      // Clear selection if deleted chapter was selected
      if (this.selectedChapterId() === chapterId) {
        this.selectedChapterId.set(undefined);
      }
    } catch (error) {
      console.error('Failed to delete chapter:', error);
    }
  }

  // Delete section from analysis panel
  onSectionDeleteFromPanel(sectionId: string) {
    this.onMarkerDelete(sectionId);
  }

  /**
   * Move the flag filter. Purely local: `filteredSections` is a computed over
   * this signal, so the section list and the timeline both re-render on the next
   * change-detection pass with no work done anywhere else.
   */
  onFlagFilterChange(filter: FlagFilter) {
    this.flagFilter.set(filter);
    saveFlagFilter(filter);
  }

  // Category filter toggle
  onFilterToggle(category: string) {
    this.categoryFilters.update(filters =>
      filters.map(f =>
        f.category === category
          ? { ...f, enabled: !f.enabled }
          : f
      )
    );
  }

  // Select all category filters
  onFilterSelectAll() {
    this.categoryFilters.update(filters =>
      filters.map(f => ({ ...f, enabled: true }))
    );
  }

  // Deselect all category filters
  onFilterDeselectAll() {
    this.categoryFilters.update(filters =>
      filters.map(f => ({ ...f, enabled: false }))
    );
  }

  // Select only marker category filters
  onFilterSelectMarkers() {
    this.categoryFilters.update(filters =>
      filters.map(f => ({ ...f, enabled: f.category.toLowerCase() === 'marker' }))
    );
  }

  // Sidebar toggle
  toggleAnalysisSidebar() {
    this.sidebarUserOverride = true;
    this.showAnalysisSidebar.update(v => !v);
  }

  // Collapse the sidebar by default when the video has no analysis or
  // transcript. Skipped once the user manually toggles it for this video.
  private applySidebarDefault() {
    if (this.sidebarUserOverride) return;
    const hasContent = this.sections().length > 0
      || this.chapters().length > 0
      || this.transcript().length > 0
      || this.hasAnalysis();
    this.showAnalysisSidebar.set(hasContent);
  }

  // Fullscreen toggle
  async toggleFullscreen() {
    const element = document.documentElement;

    if (!this.isFullscreen()) {
      try {
        if (element.requestFullscreen) {
          await element.requestFullscreen();
        } else if ((element as any).webkitRequestFullscreen) {
          await (element as any).webkitRequestFullscreen();
        }
      } catch (err) {
        console.error('Failed to enter fullscreen:', err);
      }
    } else {
      try {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if ((document as any).webkitExitFullscreen) {
          await (document as any).webkitExitFullscreen();
        }
      } catch (err) {
        console.error('Failed to exit fullscreen:', err);
      }
    }
  }

  // Handle fullscreen change events
  private onFullscreenChange = () => {
    const isFs = !!(document.fullscreenElement || (document as any).webkitFullscreenElement);
    this.isFullscreen.set(isFs);

    if (isFs) {
      // In fullscreen, show controls initially then hide after delay
      this.showTimelineInFullscreen.set(true);
      this.hideTimelineAfterDelay();
    } else {
      // Exiting fullscreen, always show timeline
      this.showTimelineInFullscreen.set(true);
      this.clearFullscreenTimeout();
    }
  };

  // Handle mouse movement in fullscreen to show timeline
  private onMouseMoveInFullscreen = () => {
    if (!this.isFullscreen()) return;

    this.showTimelineInFullscreen.set(true);

    // Always hide after delay in fullscreen (whether playing or paused)
    this.hideTimelineAfterDelay();
  };

  private hideTimelineAfterDelay() {
    this.clearFullscreenTimeout();
    this.fullscreenTimeout = setTimeout(() => {
      // Hide controls in fullscreen after mouse is idle (regardless of play state)
      if (this.isFullscreen()) {
        this.showTimelineInFullscreen.set(false);
      }
    }, 2000);
  }

  private clearFullscreenTimeout() {
    if (this.fullscreenTimeout) {
      clearTimeout(this.fullscreenTimeout);
      this.fullscreenTimeout = undefined;
    }
  }

  // Dragging state
  private isDraggingTimeline = false;

  // Timeline mouse down to start seeking or selection
  onTimelineMouseDown(event: MouseEvent) {
    event.preventDefault(); // Prevent text selection

    if (this.currentTool() === EditorTool.HIGHLIGHT) {
      // Start selection for highlight tool
      const time = this.getTimeFromMousePosition(event);
      if (time !== null) {
        this.selectionStart.set(time);
        this.isSelecting.set(true);
        this.highlightSelection.set({ startTime: time, endTime: time });

        document.body.style.cursor = 'crosshair';
        document.addEventListener('mousemove', this.onDocumentMouseMove);
        document.addEventListener('mouseup', this.onDocumentMouseUp);
      }
    } else {
      // Cursor tool - seek to position
      this.isDraggingTimeline = true;
      this.seekToMousePosition(event);

      document.body.style.cursor = 'ew-resize';
      document.addEventListener('mousemove', this.onDocumentMouseMove);
      document.addEventListener('mouseup', this.onDocumentMouseUp);
    }
  }

  // Document mouse move while dragging
  private onDocumentMouseMove = (event: MouseEvent) => {
    if (this.isSelecting()) {
      // Update selection for highlight tool
      const time = this.getTimeFromMousePositionDocument(event);
      if (time !== null && this.selectionStart() !== null) {
        const startTime = Math.min(this.selectionStart()!, time);
        const endTime = Math.max(this.selectionStart()!, time);
        this.highlightSelection.set({ startTime, endTime });
      }
    } else if (this.isDraggingTimeline) {
      // Find the timeline element
      const timelineElement = document.querySelector('.track-content') as HTMLElement;
      if (timelineElement) {
        this.seekToMousePosition(event, timelineElement);
      }
    }
  }

  // Document mouse up to stop dragging
  private onDocumentMouseUp = () => {
    if (this.isSelecting()) {
      this.isSelecting.set(false);

      // If selection is too small, clear it
      const selection = this.highlightSelection();
      if (selection && Math.abs(selection.endTime - selection.startTime) < 0.1) {
        this.highlightSelection.set(null);
      }
    }

    this.isDraggingTimeline = false;
    document.body.style.cursor = ''; // Reset cursor
    document.removeEventListener('mousemove', this.onDocumentMouseMove);
    document.removeEventListener('mouseup', this.onDocumentMouseUp);
  }

  // Timeline click to seek (now calls the common seek method)
  onTimelineClick(event: MouseEvent) {
    // Handle right-click for context menu
    if (event.button === 2 && this.highlightSelection()) {
      event.preventDefault();
      this.showContextMenu(event);
      return;
    }

    // Only seek if not dragging and using cursor tool
    if (!this.isDraggingTimeline && this.currentTool() === EditorTool.CURSOR) {
      this.seekToMousePosition(event);
    }
  }

  // Common method to seek based on mouse position
  private seekToMousePosition(event: MouseEvent, element?: HTMLElement) {
    const target = element || event.currentTarget as HTMLElement;

    // Look for the timeline track container which has the actual margins
    const trackContainer = target.querySelector('.timeline-track-container') ||
                          target.querySelector('app-timeline-track');
    if (!trackContainer) return;

    const containerRect = trackContainer.getBoundingClientRect();
    const clickX = event.clientX - containerRect.left;
    const trackWidth = containerRect.width;

    if (clickX < 0 || clickX > trackWidth || trackWidth <= 0) return;

    const percentage = clickX / trackWidth;
    const zoomState = this.editorState().zoomState;
    const visibleDuration = this.editorState().duration / zoomState.level;
    const time = zoomState.offset + (percentage * visibleDuration);

    this.seekTo(Math.max(0, Math.min(time, this.editorState().duration)));
  }

  // Timeline resize
  onResizeStart(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isResizing.set(true);

    // Add visual feedback
    document.body.style.cursor = 'ns-resize';

    const startY = event.clientY;
    const startHeight = this.timelineHeight();

    const onMouseMove = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const deltaY = startY - e.clientY;
      const newHeight = Math.max(150, Math.min(600, startHeight + deltaY));
      this.timelineHeight.set(newHeight);
    };

    const onMouseUp = () => {
      this.isResizing.set(false);
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  // Video player events
  onVideoTimeUpdate(time: number) {
    // Ignore time updates during tab restoration (video resets to 0 when source changes)
    if (this.isRestoringTab) {
      return;
    }
    this.updateCurrentTime(time);

    // Auto-scroll timeline to follow playhead in fullscreen mode
    if (this.isFullscreen()) {
      this.autoScrollToPlayhead(time);
    }

    // Real-time muting: Check if current time is within any mute section
    this.handleAutoMute(time);
  }

  /**
   * Auto-scroll the timeline to keep the playhead visible in fullscreen mode
   */
  private autoScrollToPlayhead(currentTime: number) {
    const state = this.editorState();
    const zoomState = state.zoomState;
    const visibleDuration = state.duration / zoomState.level;
    const visibleStart = zoomState.offset;
    const visibleEnd = visibleStart + visibleDuration;

    // Check if playhead is outside the visible range (with some margin)
    const margin = visibleDuration * 0.1; // 10% margin
    if (currentTime < visibleStart + margin || currentTime > visibleEnd - margin) {
      // Center the view on the playhead
      const newOffset = Math.max(0, Math.min(
        state.duration - visibleDuration,
        currentTime - (visibleDuration / 2)
      ));

      this.editorState.update(s => ({
        ...s,
        zoomState: {
          ...s.zoomState,
          offset: newOffset
        }
      }));
    }
  }

  /**
   * Handle automatic muting based on mute sections
   */
  private handleAutoMute(currentTime: number) {
    const sections = this.muteSections();
    if (sections.length === 0) {
      // No mute sections, ensure we're not auto-muted
      if (this.isAutoMuted) {
        this.isAutoMuted = false;
        // Only unmute if the video element exists and user hasn't manually set volume to 0
        if (this.videoPlayer && this.editorState().volume > 0) {
          this.videoPlayer.setMuted(false);
        }
      }
      return;
    }

    // Check if current time is within any mute section
    const inMutedSection = sections.some(s =>
      currentTime >= s.startSeconds && currentTime <= s.endSeconds
    );

    if (inMutedSection && !this.isAutoMuted) {
      // Enter muted section
      this.isAutoMuted = true;
      if (this.videoPlayer) {
        this.videoPlayer.setMuted(true);
      }
    } else if (!inMutedSection && this.isAutoMuted) {
      // Exit muted section
      this.isAutoMuted = false;
      if (this.videoPlayer && this.editorState().volume > 0) {
        this.videoPlayer.setMuted(false);
      }
    }
  }

  async onVideoDurationChange(duration: number) {
    // Don't set duration to 0 - keep default if video fails to load
    if (duration <= 0) return;

    this.editorState.update(state => ({
      ...state,
      duration
    }));
    this.metadata.update(m => ({
      ...m,
      duration
    }));

    // If we were restoring a tab, seek to the saved position now that video is loaded
    if (this.isRestoringTab && this.pendingSeekTime !== null) {
      // Restore completed normally — cancel the media-error fallback timeout
      if (this.restoreTabTimeout) {
        clearTimeout(this.restoreTabTimeout);
        this.restoreTabTimeout = undefined;
      }
      // Use setTimeout to ensure video element is ready
      setTimeout(() => {
        if (this.videoPlayer && this.pendingSeekTime !== null) {
          this.videoPlayer.seekTo(this.pendingSeekTime);
        }
        this.isRestoringTab = false;
        this.pendingSeekTime = null;
      }, 50);
    }

    // Phase 1: Show demo waveform immediately for instant feedback
    this.waveformData.set({
      samples: this.generateDemoWaveform(duration),
      sampleRate: 44100,
      duration
    });

    // Phase 2: Generate quick low-res waveform from client-side (real audio data)
    const url = this.videoUrl();
    if (url) {
      this.generateQuickClientWaveform(url, duration);
    }

    // Phase 3: Load high-quality waveform from server in background
    const videoId = this.videoId();
    if (videoId) {
      this.loadWaveformFromServer(videoId, duration);
    }
  }

  onVideoPlayStateChange(isPlaying: boolean) {
    this.editorState.update(state => ({
      ...state,
      isPlaying
    }));
  }

  onVideoEnded() {
    this.editorState.update(state => ({
      ...state,
      isPlaying: false,
      currentTime: 0
    }));
  }

  // Media failed to load — clear any in-flight tab-restore state so time updates
  // aren't dropped for later tabs. (Wire via (error) on <app-media-display>.)
  onVideoError(_message?: string) {
    if (this.restoreTabTimeout) {
      clearTimeout(this.restoreTabTimeout);
      this.restoreTabTimeout = undefined;
    }
    this.isRestoringTab = false;
    this.pendingSeekTime = null;
  }

  // Utilities
  formatTime(seconds: number): string {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);

    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  }

  formatFileSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  // Phase 2: Generate quick low-resolution waveform from client-side
  // Only samples every N seconds to avoid memory issues
  private async generateQuickClientWaveform(videoUrl: string, duration: number): Promise<void> {
    // Capture the video this load is for; bail on completion if the tab switched
    const startVideoId = this.videoId();
    try {
      // Skip client-side generation for very large files (>3 hours)
      if (duration > 10800) { // > 3 hours
        console.log('Skipping client-side waveform for long video, waiting for server...');
        return;
      }

      console.log('Generating quick client-side waveform...');

      // Fetch only the first 3MB of the video to generate initial waveform
      const response = await fetch(videoUrl, {
        headers: {
          'Range': `bytes=0-${3 * 1024 * 1024}` // First 3MB
        }
      });

      if (!response.ok || response.status === 416) {
        console.log('Range requests not supported, skipping client-side waveform');
        return;
      }

      const arrayBuffer = await response.arrayBuffer();
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();

      try {
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        const rawData = audioBuffer.getChannelData(0);

        // Generate initial waveform - much higher resolution than before
        // Aim for ~10 samples per second for good initial detail
        const targetSamples = Math.min(Math.floor(duration * 10), 5000); // Up to 5000 samples
        const blockSize = Math.floor(rawData.length / targetSamples);

        const samples: number[] = [];
        for (let i = 0; i < targetSamples; i++) {
          const blockStart = blockSize * i;
          let sum = 0;
          const actualBlockSize = Math.min(blockSize, rawData.length - blockStart);

          for (let j = 0; j < actualBlockSize; j++) {
            sum += Math.abs(rawData[blockStart + j]);
          }
          samples.push(sum / actualBlockSize);
        }

        // Normalize
        const max = Math.max(...samples, 0.01);
        const normalizedSamples = samples.map(s => s / max);

        console.log(`✓ Generated ${normalizedSamples.length} client-side samples from partial audio`);

        // Update waveform with real (but low-res) data — only if still on this video
        if (this.videoId() === startVideoId) {
          this.waveformData.set({
            samples: normalizedSamples,
            sampleRate: 44100,
            duration
          });
        }

        await audioContext.close();
      } catch (decodeError) {
        // Expected for formats that don't support partial decoding
        console.log('Partial decode not supported for this format, waiting for server waveform...');
        await audioContext.close();
      }
    } catch (error) {
      // Silently fail - server waveform will handle it
      console.log('Client-side waveform skipped, using server waveform');
    }
  }

  // Phase 3: Load high-quality waveform from server with progressive updates
  private async loadWaveformFromServer(videoId: string, duration: number): Promise<void> {
    try {
      console.log(`🎵 Starting progressive waveform generation...`);

      // Start generation with progressive mode - request samples based on duration
      // Use more samples for longer videos to maintain detail when zoomed
      // Short videos (<10 min): 3000 samples per minute (~50/sec)
      // Long videos (10+ min): 6000 samples per minute (~100/sec)
      const isLongVideo = duration >= 600; // 10 minutes
      const samplesPerMinute = isLongVideo ? 6000 : 3000;
      const targetSamples = Math.max(1000, Math.ceil((duration / 60) * samplesPerMinute));
      console.log(`Requesting ${targetSamples} samples (${samplesPerMinute} per minute for ${duration.toFixed(1)}s ${isLongVideo ? 'long' : 'short'} video)`);

      const generationPromise = firstValueFrom(
        this.http.get<any>(`${this.API_BASE}/database/videos/${videoId}/waveform?samples=${targetSamples}&progressive=true`)
      );

      // Poll for progress updates every 1 second
      const pollInterval = setInterval(async () => {
        try {
          const progressResponse = await firstValueFrom(
            this.http.get<any>(`${this.API_BASE}/database/videos/${videoId}/waveform/progress`)
          );

          if (progressResponse.success && progressResponse.data) {
            const { progress, status, partial } = progressResponse.data;
            console.log(`📊 Waveform progress: ${progress}% - ${status}`);

            // Update with partial waveform if available — but only if this video
            // is still active (tab may have switched mid-load)
            if (partial && partial.samples && partial.samples.length > 0 && this.videoId() === videoId) {
              console.log(`✓ Updating with ${partial.samples.length} samples (${progress}%)`);
              // Create a completely new object to trigger change detection
              // Always use the video element duration for accurate alignment
              this.waveformData.set({
                samples: [...partial.samples], // Create new array
                sampleRate: partial.sampleRate || 44100,
                duration: duration // Use video element duration, not FFprobe duration
              });
            }

            // Stop polling when complete
            if (progress >= 100) {
              clearInterval(pollInterval);
              this.waveformPollInterval = undefined;
            }
          }
        } catch (err) {
          // Progress endpoint might not be ready yet, continue polling
        }
      }, 1000);
      this.waveformPollInterval = pollInterval;

      // Wait for final result
      const response = await generationPromise;
      clearInterval(pollInterval);
      this.waveformPollInterval = undefined;

      console.log('Server waveform response:', response);

      if (response.success && response.data && response.data.samples && response.data.samples.length > 0 && this.videoId() === videoId) {
        console.log(`✅ Final waveform: ${response.data.samples.length} samples`);

        // Replace with final high-quality waveform
        // IMPORTANT: Always use the video player's duration to ensure waveform alignment
        // FFprobe may report a slightly different duration than the video element
        this.waveformData.set({
          samples: response.data.samples,
          sampleRate: response.data.sampleRate || 44100,
          duration: duration // Use video element duration for accurate alignment
        });
      } else {
        console.warn('Server waveform not available, keeping current version');
      }
    } catch (error) {
      console.warn('Server waveform loading failed, keeping current version:', error);
    }
  }

  // Generate demo waveform data (fallback)
  private generateDemoWaveform(duration: number): number[] {
    const samples: number[] = [];
    const sampleCount = Math.max(100, duration * 10);

    for (let i = 0; i < sampleCount; i++) {
      const baseAmplitude = 0.3 + Math.random() * 0.4;
      const variation = Math.sin(i / 10) * 0.2;
      samples.push(Math.max(0, Math.min(1, baseAmplitude + variation)));
    }

    return samples;
  }

  // Get category color
  getCategoryColor(category: string): string {
    return CATEGORY_COLORS[category.toLowerCase()] || CATEGORY_COLORS['default'];
  }

  // Handle generate analysis button click
  onGenerateAnalysis(videoId: string) {
    // Navigate to library page with state to trigger analysis
    this.router.navigate(['/'], {
      state: {
        triggerAnalysis: true,
        videoId: videoId,
        videoName: this.metadata().filename
      }
    });
  }

  // ========== TAB MANAGEMENT ==========

  /**
   * Open a video in a new tab or focus existing tab
   */
  openTab(videoId: string, videoPath: string | null, videoTitle: string): void {
    // Check if video is already open in a tab
    const existingTab = this.tabs().find(t => t.videoId === videoId);
    if (existingTab) {
      this.switchTab(existingTab.id);
      return;
    }

    // Check tab limit
    if (this.tabs().length >= this.MAX_TABS) {
      console.warn(`Maximum tabs (${this.MAX_TABS}) reached`);
      return;
    }

    // Save current tab state before opening new one
    this.saveCurrentTabState();

    // Create new tab
    const videoUrl = `${this.API_BASE}/database/videos/${videoId}/stream`;
    const newTab = createEditorTab(videoId, videoPath, videoTitle, videoUrl);

    // Add tab and make it active
    this.tabs.update(tabs => [...tabs, newTab]);
    this.activeTabId.set(newTab.id);

    // Restore new tab state to signals
    this.restoreTabState(newTab);

    // Load video data for the new tab
    this.loadVideoData(videoId);
  }

  /**
   * Switch to a different tab
   */
  switchTab(tabId: string): void {
    if (this.activeTabId() === tabId) return;

    const tab = this.tabs().find(t => t.id === tabId);
    if (!tab) return;

    // Pause playback before switching
    if (this.editorState().isPlaying) {
      this.togglePlayPause();
    }

    // Save current tab state
    this.saveCurrentTabState();

    // Switch to new tab
    this.activeTabId.set(tabId);

    // Restore new tab's state
    this.restoreTabState(tab);

    // If tab data isn't loaded yet, load it
    if (!tab.isLoaded) {
      this.loadVideoData(tab.videoId);
    }
  }

  /**
   * Close a tab
   */
  closeTab(tabId: string): void {
    const tabs = this.tabs();
    const tabIndex = tabs.findIndex(t => t.id === tabId);
    if (tabIndex === -1) return;

    // Pause playback if closing active tab
    if (this.activeTabId() === tabId && this.editorState().isPlaying) {
      this.togglePlayPause();
    }

    // Remove the tab
    this.tabs.update(tabs => tabs.filter(t => t.id !== tabId));

    // If we closed the active tab, switch to another
    if (this.activeTabId() === tabId) {
      const remainingTabs = this.tabs();
      if (remainingTabs.length > 0) {
        // Switch to adjacent tab (prefer right, then left)
        const newIndex = Math.min(tabIndex, remainingTabs.length - 1);
        this.switchTab(remainingTabs[newIndex].id);
      } else {
        // No tabs left, go back to library
        this.activeTabId.set(null);
        this.goBack();
      }
    }
  }

  /**
   * Close all tabs except the specified one
   */
  closeOtherTabs(keepTabId: string): void {
    const tabToKeep = this.tabs().find(t => t.id === keepTabId);
    if (!tabToKeep) return;

    // Pause playback if needed
    if (this.editorState().isPlaying) {
      this.togglePlayPause();
    }

    this.tabs.set([tabToKeep]);
    this.switchTab(keepTabId);
  }

  /**
   * Close all tabs
   */
  closeAllTabs(): void {
    // Pause playback if needed
    if (this.editorState().isPlaying) {
      this.togglePlayPause();
    }

    this.tabs.set([]);
    this.activeTabId.set(null);
    this.goBack();
  }

  /**
   * Switch to the previous tab
   */
  switchToPreviousTab(): void {
    const tabs = this.tabs();
    if (tabs.length <= 1) return;

    const currentIndex = tabs.findIndex(t => t.id === this.activeTabId());
    if (currentIndex === -1) return;

    const previousIndex = currentIndex === 0 ? tabs.length - 1 : currentIndex - 1;
    this.switchTab(tabs[previousIndex].id);
  }

  /**
   * Switch to the next tab
   */
  switchToNextTab(): void {
    const tabs = this.tabs();
    if (tabs.length <= 1) return;

    const currentIndex = tabs.findIndex(t => t.id === this.activeTabId());
    if (currentIndex === -1) return;

    const nextIndex = currentIndex === tabs.length - 1 ? 0 : currentIndex + 1;
    this.switchTab(tabs[nextIndex].id);
  }

  /**
   * Save current signal state to the active tab
   */
  private saveCurrentTabState(): void {
    const tabId = this.activeTabId();
    if (!tabId) return;

    this.tabs.update(tabs => tabs.map(tab => {
      if (tab.id !== tabId) return tab;

      return {
        ...tab,
        editorState: this.editorState(),
        sections: this.sections(),
        chapters: this.chapters(),
        muteSections: this.muteSections(),
        transcript: this.transcript(),
        analysisData: this.analysisData() || null,
        waveformData: this.waveformData(),
        categoryFilters: this.categoryFilters(),
        highlightSelection: this.highlightSelection(),
        hasAnalysis: this.hasAnalysis(),
        videoScale: this.videoScale(),
        showBorder: this.showBorder(),
        borderAspectRatio: this.borderAspectRatio(),
      };
    }));
  }

  /**
   * Restore a tab's state to the component signals
   */
  private restoreTabState(tab: EditorTab): void {
    const currentUrl = this.videoUrl();
    const isVideoChanging = currentUrl !== tab.videoUrl;

    // If video URL is changing, set up restoration to preserve playhead position
    if (isVideoChanging && tab.editorState.currentTime > 0) {
      this.isRestoringTab = true;
      this.pendingSeekTime = tab.editorState.currentTime;
      // Fallback: if the video never reports a duration (e.g. media error),
      // clear the restore flag so time updates aren't dropped for later tabs.
      if (this.restoreTabTimeout) clearTimeout(this.restoreTabTimeout);
      this.restoreTabTimeout = setTimeout(() => {
        this.isRestoringTab = false;
        this.pendingSeekTime = null;
        this.restoreTabTimeout = undefined;
      }, 5000);
    }

    this.videoId.set(tab.videoId);
    this.videoPath.set(tab.videoPath);
    this.videoTitle.set(tab.videoTitle);
    this.videoUrl.set(tab.videoUrl);
    this.editorState.set(tab.editorState);
    this.sections.set(tab.sections);
    this.chapters.set(tab.chapters);
    this.muteSections.set(tab.muteSections ?? []);
    this.transcript.set(tab.transcript);
    this.analysisData.set(tab.analysisData || undefined);
    this.waveformData.set(tab.waveformData);
    this.categoryFilters.set(tab.categoryFilters);
    this.highlightSelection.set(tab.highlightSelection);
    this.hasAnalysis.set(tab.hasAnalysis);
    this.videoScale.set(tab.videoScale ?? 1.0);
    this.showBorder.set(tab.showBorder ?? false);
    this.borderAspectRatio.set(tab.borderAspectRatio ?? '16:9');
    this.videoCompleted.set(false);
    this.sidebarUserOverride = false;
    this.applySidebarDefault();

    // Update metadata
    this.metadata.update(m => ({
      ...m,
      filename: tab.videoTitle
    }));

    // If video URL didn't change but position did, seek directly
    if (!isVideoChanging && tab.editorState.currentTime > 0 && this.videoPlayer) {
      this.videoPlayer.seekTo(tab.editorState.currentTime);
    }
  }

  /**
   * Mark the current tab as loaded and save its state
   */
  private markTabLoaded(): void {
    const tabId = this.activeTabId();
    if (!tabId) return;

    this.tabs.update(tabs => tabs.map(tab => {
      if (tab.id !== tabId) return tab;
      return { ...tab, isLoaded: true };
    }));

    this.saveCurrentTabState();
  }

  /**
   * Handle tab selection from tab bar
   */
  onTabSelect(tabId: string): void {
    this.switchTab(tabId);
  }

  /**
   * Handle tab close from tab bar
   */
  onTabClose(tabId: string): void {
    this.closeTab(tabId);
  }

  /**
   * Handle close other tabs from tab bar
   */
  onTabCloseOthers(tabId: string): void {
    this.closeOtherTabs(tabId);
  }

  /**
   * Handle close all tabs from tab bar
   */
  onTabCloseAll(): void {
    this.closeAllTabs();
  }

  // ===== Group Management Methods =====

  /**
   * Handle moving a tab to another group
   */
  async onMoveTabToGroup(event: { tabId: string; targetGroupNumber: number }): Promise<void> {
    const tab = this.tabs().find(t => t.id === event.tabId);
    if (!tab) return;

    // Prepare tab data for transfer
    const tabData = this.prepareTabDataForTransfer(tab);

    try {
      // Send to target group
      const success = await (window as any).electron.moveTabToGroup(tabData, event.targetGroupNumber);
      if (success) {
        // Remove from this window
        this.closeTab(event.tabId);
        console.log(`Moved tab ${tab.videoTitle} to Group ${event.targetGroupNumber}`);
      }
    } catch (error) {
      console.error('Error moving tab to group:', error);
    }
  }

  /**
   * Handle moving a tab to a new group (new window)
   */
  async onMoveTabToNewGroup(tabId: string): Promise<void> {
    const tab = this.tabs().find(t => t.id === tabId);
    if (!tab) return;

    // Prepare tab data for transfer
    const tabData = this.prepareTabDataForTransfer(tab);

    try {
      // Create new group with this tab
      const newGroupNumber = await (window as any).electron.createGroupWithTab(tabData);
      if (newGroupNumber) {
        // Remove from this window
        this.closeTab(tabId);
        console.log(`Moved tab ${tab.videoTitle} to new Group ${newGroupNumber}`);
      }
    } catch (error) {
      console.error('Error creating new group with tab:', error);
    }
  }

  /**
   * Handle consolidating all groups
   */
  async onConsolidateGroups(): Promise<void> {
    try {
      await (window as any).electron.consolidateGroups();
      console.log('Consolidate groups request sent');
    } catch (error) {
      console.error('Error consolidating groups:', error);
    }
  }

  /**
   * Handle renaming a tab
   */
  onTabRename(tabId: string): void {
    const tab = this.tabs().find(t => t.id === tabId);
    if (!tab) return;

    const newTitle = prompt('Enter new tab title:', tab.videoTitle);
    if (newTitle && newTitle.trim() !== '') {
      this.tabs.update(tabs => tabs.map(t => {
        if (t.id !== tabId) return t;
        return { ...t, videoTitle: newTitle.trim() };
      }));
    }
  }

  /**
   * Handle tab reorder from drag and drop
   */
  onTabReorder({ fromIndex, toIndex }: { fromIndex: number; toIndex: number }): void {
    this.tabs.update(tabs => {
      const newTabs = [...tabs];
      const [movedTab] = newTabs.splice(fromIndex, 1);
      newTabs.splice(toIndex, 0, movedTab);
      return newTabs;
    });
  }

  /**
   * Prepare tab data for transfer to another window
   */
  private prepareTabDataForTransfer(tab: EditorTab): any {
    return {
      videoId: tab.videoId,
      videoPath: tab.videoPath,
      videoTitle: tab.videoTitle,
      videoUrl: tab.videoUrl,
      editorState: tab.editorState,
      sections: tab.sections,
      chapters: tab.chapters,
      muteSections: tab.muteSections,
      waveformData: tab.waveformData,
      transcript: tab.transcript,
      analysisData: tab.analysisData,
      highlightSelection: tab.highlightSelection,
      categoryFilters: tab.categoryFilters,
      hasAnalysis: tab.hasAnalysis,
      videoScale: tab.videoScale,
      showBorder: tab.showBorder,
      borderAspectRatio: tab.borderAspectRatio,
    };
  }

  /**
   * Receive a tab from another window
   */
  private receiveTabFromOtherWindow(tabData: any): void {
    // Check if we already have this video open
    const existingTab = this.tabs().find(t => t.videoId === tabData.videoId);
    if (existingTab) {
      // Just switch to the existing tab
      this.switchTab(existingTab.id);
      return;
    }

    // Check max tabs
    if (this.tabs().length >= this.MAX_TABS) {
      console.warn('Cannot receive tab: at max tabs limit');
      return;
    }

    // Create new tab with the transferred data
    const newTab = createEditorTab(
      tabData.videoId,
      tabData.videoPath,
      tabData.videoTitle,
      tabData.videoUrl
    );

    // Restore the full state
    const restoredTab: EditorTab = {
      ...newTab,
      editorState: tabData.editorState || newTab.editorState,
      sections: tabData.sections || [],
      chapters: tabData.chapters || [],
      muteSections: tabData.muteSections || [],
      waveformData: tabData.waveformData || newTab.waveformData,
      transcript: tabData.transcript || [],
      analysisData: tabData.analysisData,
      highlightSelection: tabData.highlightSelection,
      categoryFilters: tabData.categoryFilters || [],
      hasAnalysis: tabData.hasAnalysis || false,
      isLoaded: true, // Mark as loaded since we already have the data
      videoScale: tabData.videoScale ?? 1.0,
      showBorder: tabData.showBorder ?? false,
      borderAspectRatio: tabData.borderAspectRatio ?? '16:9',
    };

    this.tabs.update(tabs => [...tabs, restoredTab]);
    this.activeTabId.set(restoredTab.id);
  }

  /**
   * Send all tabs to another group (for consolidation)
   */
  private async sendAllTabsToGroup(targetGroupNumber: number): Promise<void> {
    const allTabs = this.tabs();

    for (const tab of allTabs) {
      const tabData = this.prepareTabDataForTransfer(tab);
      try {
        await (window as any).electron.moveTabToGroup(tabData, targetGroupNumber);
      } catch (error) {
        console.error('Error sending tab to group:', error);
      }
    }

    // Close this window after sending all tabs
    window.close();
  }

  /**
   * Restore incoming tab state (when window is created with tab data from another window)
   */
  private restoreIncomingTabState(tabData: any): void {
    const currentTab = this.tabs().find(t => t.videoId === tabData.videoId);
    if (currentTab) {
      // Update the existing tab with the full state
      this.tabs.update(tabs => tabs.map(t => {
        if (t.videoId !== tabData.videoId) return t;
        return {
          ...t,
          editorState: tabData.editorState || t.editorState,
          sections: tabData.sections || t.sections,
          chapters: tabData.chapters || t.chapters,
          muteSections: tabData.muteSections || t.muteSections,
          waveformData: tabData.waveformData || t.waveformData,
          transcript: tabData.transcript || t.transcript,
          analysisData: tabData.analysisData ?? t.analysisData,
          highlightSelection: tabData.highlightSelection ?? t.highlightSelection,
          categoryFilters: tabData.categoryFilters || t.categoryFilters,
          hasAnalysis: tabData.hasAnalysis ?? t.hasAnalysis,
          isLoaded: true
        };
      }));
    }
  }
}
