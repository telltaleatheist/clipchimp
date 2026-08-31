import { ChangeDetectionStrategy, Component, DestroyRef, Input, Output, EventEmitter, inject, signal, computed, effect, untracked } from '@angular/core';
import { OverlayModule } from '@angular/cdk/overlay';
import { CascadeComponent } from '../cascade/cascade.component';
import { VideoWeek, VideoItem, ItemProgress, ChildrenConfig } from '../../models/video.model';
import { QueueService } from '../../services/queue.service';
import { QueueJob } from '../../models/queue-job.model';
import { QueueSelectionStore } from '../../core/stores/queue-selection.store';
import { ErrorSurface } from '../../core/error-surface.service';

/** Which Clear-menu option is awaiting its confirming second click. */
type ClearOption = 'completed' | 'selected' | 'all';

@Component({
  selector: 'app-queue-tab',
  standalone: true,
  imports: [OverlayModule, CascadeComponent],
  templateUrl: './queue-tab.component.html',
  styleUrls: ['./queue-tab.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class QueueTabComponent {
  private queueService = inject(QueueService);
  private queueSelection = inject(QueueSelectionStore);
  private errorSurface = inject(ErrorSurface);

  constructor() {
    // Reconcile the shared queue selection against the live pending set: a job
    // that gets started or removed leaves the pending list, so drop it from both
    // the local badge set and the inspector's QueueSelectionStore (never point
    // the inspector at a job that no longer exists). Reacts to pending changes;
    // user selection changes are pushed synchronously by onStagingSelectionChanged.
    effect(() => {
      const pendingIds = new Set(this.queueService.pendingJobs().map(j => j.id));
      untracked(() => {
        const live = new Set(
          Array.from(this.selectedStagingIds()).filter(id =>
            pendingIds.has(this.stripStagingId(id))
          )
        );
        if (live.size !== this.selectedStagingIds().size) {
          this.selectedStagingIds.set(live);
        }
        this.syncQueueSelection();
      });
    });

    // Leaving the queue page destroys this component — clear the shared
    // selection so the inspector reverts to the library branch.
    inject(DestroyRef).onDestroy(() => this.queueSelection.clear());
  }

  /** Strip the cascade row prefix ("[week|]staging-<jobId>") → raw job id. */
  private stripStagingId(id: string): string {
    return id.replace(/^.*staging-/, '');
  }

  /** Push the current staging selection (pending-only) to the shared store. */
  private syncQueueSelection(): void {
    const pendingIds = new Set(this.queueService.pendingJobs().map(j => j.id));
    const rawIds = Array.from(this.selectedStagingIds())
      .map(id => this.stripStagingId(id))
      .filter(id => pendingIds.has(id));
    this.queueSelection.set(rawIds);
  }

  // Keep inputs for backward compatibility during migration
  // These are now optional - if not provided, we use QueueService directly
  @Input() progressMapper?: (video: VideoItem) => ItemProgress | null;
  @Input() childrenConfig?: ChildrenConfig;
  @Input() aiProcessingVideoId?: string | null;

  @Output() processAll = new EventEmitter<void>();
  @Output() processSelected = new EventEmitter<string[]>();
  @Output() configureSelected = new EventEmitter<string[]>();
  @Output() removeSelected = new EventEmitter<string[]>();
  @Output() cancelProcessing = new EventEmitter<string[]>();
  @Output() viewInLibrary = new EventEmitter<string>();
  @Output() configureItem = new EventEmitter<VideoItem>();
  @Output() previewRequested = new EventEmitter<VideoItem>();
  @Output() viewAnalysis = new EventEmitter<string>();
  @Output() addToTab = new EventEmitter<{ tabId: string; videoIds: string[] }>();
  @Output() addToNewTab = new EventEmitter<string[]>();
  @Output() clearCompleted = new EventEmitter<void>();
  @Output() trimOpenerRequested = new EventEmitter<VideoItem>();

  selectedStagingIds = signal<Set<string>>(new Set());

  // Computed counts for template
  pendingCount = computed(() => this.queueService.pendingJobs().length);
  processingCount = computed(() => this.queueService.processingJobs().length);
  completedCount = computed(() => this.queueService.completedJobs().length);

  // ── Clear ▾ menu (two-click confirmed per option) ──────────────────────────
  clearMenuOpen = signal(false);
  armedClear = signal<ClearOption | null>(null);

  anythingClearable = computed(
    () => this.completedCount() > 0 || this.pendingCount() > 0 || this.processingCount() > 0
  );

  startTitle = computed(() =>
    this.selectedStagingIds().size > 0
      ? `Start the ${this.selectedStagingIds().size} selected pending item(s)`
      : `Start all ${this.pendingCount()} pending item(s)`
  );

  toggleClearMenu(): void {
    this.armedClear.set(null);
    this.clearMenuOpen.update(open => !open);
  }

  closeClearMenu(): void {
    this.clearMenuOpen.set(false);
    this.armedClear.set(null);
  }

  /**
   * Destructive options arm on the first click and execute on the second.
   *
   * 'completed' is NOT destructive and is therefore NOT armed: those rows are
   * finished work, and removing them from a list deletes no video, no analysis
   * and no file — the only thing lost is the row itself, which the next run
   * recreates. Making it confirm cost three clicks (open menu, arm, confirm) to
   * tidy a list, so it fires immediately.
   */
  onClearOption(option: ClearOption): void {
    if (option !== 'completed' && this.armedClear() !== option) {
      this.armedClear.set(option);
      return;
    }
    this.closeClearMenu();
    switch (option) {
      case 'completed':
        this.onClearCompleted();
        break;
      case 'selected':
        this.onRemoveSelected();
        this.selectedStagingIds.set(new Set());
        this.syncQueueSelection();
        break;
      case 'all':
        this.onClearAll();
        break;
    }
  }

  /** Start (primary): acts on the selection when there is one, else on all pending. */
  onStart(): void {
    if (this.selectedStagingIds().size > 0) {
      this.onProcessSelected();
    } else {
      this.onProcessAll();
    }
  }

  // Combine staging, processing, and completed queues into a single weeks array for cascade
  // Now uses QueueService directly as source of truth
  allQueueWeeks = computed(() => {
    const weeks: VideoWeek[] = [];

    // Add staging section (pending jobs)
    const allJobs = this.queueService.allJobs();
    const pendingJobs = this.queueService.pendingJobs();
    if (pendingJobs.length > 0) {
      const stagingVideos: VideoItem[] = pendingJobs.map(job => ({
        id: `staging-${job.id}`,
        name: job.title,
        duration: job.duration,
        thumbnailUrl: job.thumbnail,
        sourceUrl: job.url,
        tags: [
          `staging:${job.id}`,
          ...(job.trimStartTime ? [`trim:${job.trimStartTime}`] : []),
          ...(job.trimEndTime ? [`trimend:${job.trimEndTime}`] : []),
        ],
        titleLoading: job.titleResolved === false
      }));

      weeks.push({
        weekLabel: '⏸️ Pending',
        videos: stagingVideos
      });
    }

    // Add processing section
    const processingJobs = this.queueService.processingJobs();
    if (processingJobs.length > 0) {
      const processingVideos: VideoItem[] = processingJobs.map(job => {
        const failedTask = job.tasks?.find(t => t.state === 'failed' && t.errorMessage);
        const errorMessage = failedTask?.errorMessage;

        return {
          id: `processing-${job.id}`,
          name: job.title,
          duration: job.duration,
          thumbnailUrl: job.thumbnail,
          sourceUrl: job.url,
          tags: [`processing:${job.id}`, `status:${job.state}`],
          titleLoading: job.titleResolved === false,
          errorMessage: errorMessage,
          warnings: job.warnings
        };
      });

      weeks.push({
        weekLabel: '⚡ Processing',
        videos: processingVideos
      });
    }

    // Add completed section
    const completedJobs = this.queueService.completedJobs();
    if (completedJobs.length > 0) {
      const completedVideos: VideoItem[] = completedJobs.map(job => {
        const hasFailed = job.tasks?.some(t => t.state === 'failed');
        const failedTask = job.tasks?.find(t => t.state === 'failed' && t.errorMessage);
        const errorMessage = failedTask?.errorMessage;

        // Derive hasTranscript/hasAnalysis from completed tasks
        const hasTranscript = job.tasks?.some(t => t.type === 'transcribe' && t.state === 'completed');
        const hasAnalysis = job.tasks?.some(
          t => (t.type === 'ai-analyze' || t.type === 'analyze-webpage') && t.state === 'completed'
        );

        return {
          id: `completed-${job.id}`,
          name: job.title,
          duration: job.duration,
          thumbnailUrl: job.thumbnail,
          sourceUrl: job.url,
          tags: [`completed:${job.id}`, hasFailed ? 'status:failed' : 'status:completed'],
          errorMessage: errorMessage,
          warnings: job.warnings,
          hasTranscript,
          hasAnalysis,
          // Store actual video ID for navigation to video info page
          videoId: job.videoId
        };
      });

      weeks.push({
        weekLabel: '✅ Completed',
        videos: completedVideos
      });
    }

    return weeks;
  });

  // Computed property for AI processing queue item ID
  aiProcessingQueueItemId = computed(() => {
    const processingJobs = this.queueService.processingJobs();
    const processingItem = processingJobs.find(job => {
      if (job.state !== 'processing') return false;
      return job.tasks.some(task =>
        (task.type === 'transcribe' || task.type === 'ai-analyze') &&
        task.state === 'running'
      );
    });
    return processingItem ? `processing-${processingItem.id}` : null;
  });

  onStagingSelectionChanged(event: { count: number; ids: Set<string> }) {
    // The consolidated cascade lists Pending/Processing/Completed together and
    // every row is selectable, but only staging (pending) rows can be started
    // or removed from staging. Keep just those so the Start badge, the Clear ▾
    // "Selected (N)" count, and the acted-on set never overstate what happens.
    const stagingIds = new Set(
      Array.from(event.ids).filter(id => id.includes('staging-'))
    );
    this.selectedStagingIds.set(stagingIds);
    this.syncQueueSelection();
  }

  onVideoAction(event: any) {
    console.log('Video action:', event);

    const { action, videos } = event;

    // Extract IDs from video items, handling staging, processing, and completed prefixes
    const videoIds = videos.map((v: VideoItem) => {
      if (v.id.startsWith('staging-')) {
        return v.id.replace('staging-', '');
      } else if (v.id.startsWith('processing-')) {
        return v.id.replace('processing-', '');
      } else if (v.id.startsWith('completed-')) {
        return v.id.replace('completed-', '');
      }
      return v.id;
    });

    switch (action) {
      case 'processing':
        // Processing config action for staging items
        const configIds = videos
          .filter((v: VideoItem) => v.id.startsWith('staging-'))
          .map((v: VideoItem) => v.id.replace('staging-', ''));
        if (configIds.length > 0) {
          this.configureSelected.emit(configIds);
        }
        break;
      case 'cancel':
        this.cancelProcessing.emit(videoIds);
        break;
      case 'view-in-library':
        if (videoIds.length === 1) {
          this.viewInLibrary.emit(videoIds[0]);
        }
        break;
      case 'view-analysis':
      case 'openInEditor':
        // For completed items, open in the video editor (Scout)
        const completedIds = videos
          .filter((v: VideoItem) => v.id.startsWith('completed-'))
          .map((v: VideoItem) => v.id.replace('completed-', ''));
        if (completedIds.length === 1) {
          this.viewAnalysis.emit(completedIds[0]);
        }
        break;
      case 'addToNewTab':
        // For completed items with a videoId, emit addToNewTab with real video IDs
        const newTabVideoIds = videos
          .filter((v: VideoItem) => v.videoId)
          .map((v: VideoItem) => v.videoId!);
        if (newTabVideoIds.length > 0) {
          this.addToNewTab.emit(newTabVideoIds);
        }
        break;

      case 'viewTranscript':
        // For completed items, emit viewAnalysis with the stripped JOB id
        // (parent looks the item up by job id, not videoId).
        const transcriptIds = videos
          .filter((v: VideoItem) => v.id.startsWith('completed-'))
          .map((v: VideoItem) => v.id.replace('completed-', ''));
        if (transcriptIds.length === 1) {
          // Emit as a videoAction to parent so it can navigate
          this.viewAnalysis.emit(transcriptIds[0]);
        }
        break;

      case 'retry':
        // Re-add completed/failed jobs back to the staging queue with same config
        const retryIds = videos
          .filter((v: VideoItem) => v.id.startsWith('completed-'))
          .map((v: VideoItem) => v.id.replace('completed-', ''));
        for (const jobId of retryIds) {
          const job = this.queueService.allJobs().find(j => j.id === jobId);
          if (job) {
            // Create a new pending job with the same tasks (reset state)
            this.queueService.addJob({
              title: job.title,
              url: job.url,
              videoId: job.videoId,
              videoPath: job.videoPath,
              titleResolved: true,
              tasks: job.tasks.map(t => ({
                ...t,
                state: 'pending' as const,
                progress: 0,
                errorMessage: undefined,
              })),
            });
            // Remove the old completed job
            this.queueService.removeJob(jobId);
          }
        }
        break;

      case 'trimOpener':
        if (videos.length === 1) {
          this.trimOpenerRequested.emit(videos[0]);
        }
        break;

      case 'delete':
      case 'remove':
      case 'removeFromQueue':
        // For staging items, remove them directly via QueueService
        const stagingIds = videos
          .filter((v: VideoItem) => v.id.startsWith('staging-'))
          .map((v: VideoItem) => v.id.replace('staging-', ''));
        if (stagingIds.length > 0) {
          // Can remove directly via QueueService, or emit for parent to handle
          this.removeSelected.emit(stagingIds);
        }

        // For processing items, cancel and remove via QueueService
        const processingIdsToRemove = videos
          .filter((v: VideoItem) => v.id.startsWith('processing-'))
          .map((v: VideoItem) => v.id.replace('processing-', ''));
        if (processingIdsToRemove.length > 0) {
          this.cancelProcessing.emit(processingIdsToRemove);
        }

        // For completed items, remove them from the queue
        const completedIdsToRemove = videos
          .filter((v: VideoItem) => v.id.startsWith('completed-'))
          .map((v: VideoItem) => v.id.replace('completed-', ''));
        for (const id of completedIdsToRemove) {
          this.queueService.removeJob(id);
        }
        break;

      default:
        // Handle addToTab:tabId pattern from completed items
        if (action.startsWith('addToTab:')) {
          const tabId = action.replace('addToTab:', '');
          const tabVideoIds = videos
            .filter((v: VideoItem) => v.videoId)
            .map((v: VideoItem) => v.videoId!);
          if (tabVideoIds.length > 0) {
            this.addToTab.emit({ tabId, videoIds: tabVideoIds });
          }
        }
        break;
    }
  }

  onProcessAll() {
    this.processAll.emit();
  }

  onProcessSelected() {
    const stagingIds = Array.from(this.selectedStagingIds()).map(id => {
      return id.replace(/^.*staging-/, '');
    });
    this.processSelected.emit(stagingIds);
  }

  onRemoveSelected() {
    const stagingIds = Array.from(this.selectedStagingIds()).map(id => {
      return id.replace(/^.*staging-/, '');
    });
    this.removeSelected.emit(stagingIds);
  }

  onClearCompleted() {
    // Emit only — the parent (library-page) owns the clear so it runs once.
    this.clearCompleted.emit();
  }

  onClearPending() {
    // Clear all pending jobs directly via QueueService
    this.queueService.clearPending();
    // Clear any selection
    this.selectedStagingIds.set(new Set());
    this.syncQueueSelection();
  }

  /**
   * Clear All - removes pending and processing items
   * This is the "nuke" option - clears everything except completed history
   */
  onClearAll() {
    console.log('[QueueTab] Clear All requested');
    // Clear pending and processing jobs
    this.queueService.clearPendingAndProcessing();
    // Clear any selection
    this.selectedStagingIds.set(new Set());
    this.syncQueueSelection();
  }

  onStopProcessing() {
    // Stop all processing IMMEDIATELY - this moves processing jobs to pending
    this.queueService.stopProcessing().subscribe({
      next: () => {
        console.log('[QueueTab] Processing stopped');
      },
      error: (err) => {
        this.errorSurface.surfaceError('Stop processing', err);
      }
    });
  }
}
