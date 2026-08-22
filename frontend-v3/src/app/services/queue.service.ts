import { Injectable, inject, signal, computed, effect, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, Observable, of } from 'rxjs';
import { map, tap, catchError } from 'rxjs/operators';
import {
  QueueJob,
  QueueTask,
  QueueStats,
  JobState,
  TaskState,
  createQueueJob,
  createQueueTask,
  isJobDone,
  areAllTasksDone,
  hasFailedTask,
  calculateJobProgress
} from '../models/queue-job.model';
import { TaskType } from '../models/task.model';
import { WebsocketService, TaskStarted, TaskProgress, TaskCompleted, TaskFailed } from './websocket.service';
import { LibraryService, BackendJobRequest, BackendTask } from './library.service';
import { ErrorSurface } from '../core/error-surface.service';
import { getApiBase } from '../core/runtime-url';

const STORAGE_KEY = 'briefcase-queue-jobs';
const RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

@Injectable({
  providedIn: 'root'
})
export class QueueService implements OnDestroy {
  private readonly API_BASE = getApiBase();

  private http = inject(HttpClient);
  private websocketService = inject(WebsocketService);
  private libraryService = inject(LibraryService);
  private errorSurface = inject(ErrorSurface);

  // True while the last restoreFromBackend attempt failed — used to notify
  // once per outage (not once per poll) and to reconcile when it heals.
  private backendUnreachable = false;

  // Single source of truth for all jobs
  private jobs = signal<QueueJob[]>([]);

  // Map backend job IDs to frontend job IDs
  private backendToFrontendIdMap = new Map<string, string>();
  private frontendToBackendIdMap = new Map<string, string>();

  // Concurrency guard for restoreFromBackend. When a refresh is already in
  // flight and a second one is requested, we defer it until the current one
  // finishes so two parallel GETs can't each hit Pass 3 and create duplicate
  // frontend jobs for the same backend job.
  private restoreInFlight: Promise<void> | null = null;
  private restoreQueued = false;

  // WebSocket unsubscribe functions
  private wsUnsubscribes: (() => void)[] = [];

  // Public readonly computed views
  readonly allJobs = this.jobs.asReadonly();

  readonly pendingJobs = computed(() =>
    this.jobs().filter(j => j.state === 'pending')
  );

  readonly processingJobs = computed(() =>
    this.jobs().filter(j => j.state === 'processing')
  );

  readonly completedJobs = computed(() =>
    this.jobs().filter(j => j.state === 'completed' || j.state === 'failed')
  );

  readonly stats = computed<QueueStats>(() => {
    const all = this.jobs();
    return {
      pending: all.filter(j => j.state === 'pending').length,
      processing: all.filter(j => j.state === 'processing').length,
      completed: all.filter(j => j.state === 'completed').length,
      failed: all.filter(j => j.state === 'failed').length,
      total: all.length
    };
  });

  // True when running in a popout editor window. Popout windows must NOT
  // read/write localStorage or handle WebSocket queue events — only the main
  // window owns the persisted queue state. Without this, two QueueService
  // instances stomping on the same storage key create zombie pending jobs.
  private readonly isPopout =
    window.location.pathname.includes('/editor') &&
    window.location.search.includes('popout=true');

  constructor() {
    console.log('[QueueService] Constructor called (popout:', this.isPopout, ')');

    if (this.isPopout) {
      // Popout editors don't manage queue state — they just POST export jobs
      // to the backend and let the main window handle tracking/persistence.
      return;
    }

    // Load persisted jobs (with expiry filter)
    this.loadFromStorage();
    console.log('[QueueService] After loadFromStorage:', this.jobs().length, 'jobs');

    // Set up WebSocket handlers
    this.setupWebSocketHandlers();

    // Restore processing jobs from backend on init
    this.restoreFromBackend();

    // Reconcile queue state whenever the WebSocket RE-connects. socket.io does
    // not replay events emitted while disconnected, so a task.completed fired
    // during a transient drop (laptop sleep, wifi blip — the backend keeps
    // running) is lost and the job stays "processing" forever. We watch the
    // connected signal and, on a false->true transition AFTER the first connect,
    // refresh from the backend to pick up anything missed. The initial connect
    // is skipped (restoreFromBackend already ran above).
    let hasConnectedOnce = false;
    effect(() => {
      const isConnected = this.websocketService.connected();
      if (!isConnected) return;
      if (hasConnectedOnce) {
        console.log('[QueueService] WebSocket reconnected — reconciling queue state from backend');
        this.refreshFromBackend();
      }
      hasConnectedOnce = true;
    });

    // Persist on any change
    effect(() => {
      const currentJobs = this.jobs();
      this.saveToStorage(currentJobs);
    });
  }

  ngOnDestroy(): void {
    this.wsUnsubscribes.forEach(unsub => unsub());
  }

  // ==================== PUBLIC STATE MUTATIONS ====================

  /**
   * Add a new job to the queue
   */
  addJob(partial: Partial<QueueJob> & { title: string }): QueueJob {
    const job = createQueueJob(partial);
    console.log('[QueueService] addJob called:', job);
    console.log('[QueueService] Current jobs before add:', this.jobs().length);
    this.jobs.update(jobs => [...jobs, job]);
    console.log('[QueueService] Jobs after add:', this.jobs().length);
    console.log('[QueueService] Pending jobs after add:', this.pendingJobs().length);
    return job;
  }

  /**
   * Add multiple jobs at once
   */
  addJobs(partials: (Partial<QueueJob> & { title: string })[]): QueueJob[] {
    const newJobs = partials.map(p => createQueueJob(p));
    this.jobs.update(jobs => [...jobs, ...newJobs]);
    return newJobs;
  }

  /**
   * Update a job's state
   */
  updateJobState(jobId: string, newState: JobState): void {
    this.jobs.update(jobs =>
      jobs.map(job => {
        if (job.id !== jobId) return job;

        const updates: Partial<QueueJob> = { state: newState };

        if (newState === 'processing' && !job.startedAt) {
          updates.startedAt = Date.now();
        }

        if (newState === 'completed' || newState === 'failed') {
          updates.completedAt = Date.now();
        }

        return { ...job, ...updates };
      })
    );
  }

  /**
   * Update a job's error message
   */
  updateJobError(jobId: string, errorMessage: string): void {
    this.jobs.update(jobs =>
      jobs.map(job =>
        job.id === jobId ? { ...job, errorMessage } : job
      )
    );
  }

  /**
   * Update a task's state within a job
   */
  updateTaskState(jobId: string, taskType: TaskType, newState: TaskState, errorMessage?: string): void {
    this.jobs.update(jobs =>
      jobs.map(job => {
        if (job.id !== jobId) return job;

        const updatedTasks = job.tasks.map(task => {
          if (task.type !== taskType) return task;
          return {
            ...task,
            state: newState,
            progress: newState === 'completed' ? 100 : task.progress,
            errorMessage
          };
        });

        return { ...job, tasks: updatedTasks };
      })
    );
  }

  /**
   * Reset a job to its default pending state (clear errors, timestamps)
   * Used when stopping processing and moving jobs back to pending
   */
  resetJobToDefault(jobId: string): void {
    this.jobs.update(jobs =>
      jobs.map(job => {
        if (job.id !== jobId) return job;
        return {
          ...job,
          state: 'pending' as JobState,
          errorMessage: undefined,
          startedAt: undefined,
          completedAt: undefined
        };
      })
    );
  }

  /**
   * Reset a task to its default pending state (progress 0, no errors)
   * Used when stopping processing and moving jobs back to pending
   */
  resetTaskToDefault(jobId: string, taskType: TaskType): void {
    this.jobs.update(jobs =>
      jobs.map(job => {
        if (job.id !== jobId) return job;

        const updatedTasks = job.tasks.map(task => {
          if (task.type !== taskType) return task;
          return {
            ...task,
            state: 'pending' as TaskState,
            progress: 0,
            errorMessage: undefined
          };
        });

        return { ...job, tasks: updatedTasks };
      })
    );
  }

  /**
   * Update a task's progress within a job
   */
  updateTaskProgress(jobId: string, taskType: TaskType, progress: number, eta?: number, taskLabel?: string): void {
    this.jobs.update(jobs =>
      jobs.map(job => {
        if (job.id !== jobId) return job;

        const updatedTasks = job.tasks.map(task => {
          if (task.type !== taskType) return task;
          // Don't update completed tasks
          if (task.state === 'completed') return task;
          return {
            ...task,
            state: 'running' as TaskState,
            progress: Math.max(0, Math.min(100, progress)),
            // Preserve existing eta/taskLabel if new values are undefined
            eta: eta !== undefined ? eta : task.eta,
            taskLabel: taskLabel || task.taskLabel
          };
        });

        return { ...job, tasks: updatedTasks };
      })
    );
  }

  /**
   * Update job title (e.g., when metadata is resolved)
   */
  updateJobTitle(jobId: string, title: string, titleResolved = true): void {
    this.jobs.update(jobs =>
      jobs.map(job =>
        job.id === jobId ? { ...job, title, titleResolved } : job
      )
    );
  }

  /**
   * Update job by URL (for title resolution before job ID is assigned)
   */
  updateJobByUrl(url: string, updates: Partial<QueueJob>): void {
    this.jobs.update(jobs =>
      jobs.map(job =>
        job.url === url ? { ...job, ...updates } : job
      )
    );
  }

  /**
   * Update job's videoId (e.g., when video is imported and assigned a database ID)
   */
  updateJobVideoId(jobId: string, videoId: string): void {
    console.log(`[QueueService] Updating job ${jobId} with videoId: ${videoId}`);
    this.jobs.update(jobs =>
      jobs.map(job =>
        job.id === jobId ? { ...job, videoId } : job
      )
    );
  }

  /**
   * Update all tasks for a job (e.g., when reconfiguring from modal)
   */
  updateJobTasks(jobId: string, tasks: QueueTask[]): void {
    this.jobs.update(jobs =>
      jobs.map(job =>
        job.id === jobId ? { ...job, tasks } : job
      )
    );
  }

  /**
   * Update a job's trim start time (for trim opener feature)
   */
  updateJobTrimStartTime(jobId: string, trimStartTime: number | undefined): void {
    this.jobs.update(jobs =>
      jobs.map(job =>
        job.id === jobId ? { ...job, trimStartTime } : job
      )
    );
  }

  /**
   * Update a job's trim start AND end times (for trim opener feature).
   * trimStartTime = seconds to remove from the start, trimEndTime = seconds
   * to remove from the end. Pass undefined/0 to clear either side.
   */
  updateJobTrim(jobId: string, trimStartTime: number | undefined, trimEndTime: number | undefined): void {
    this.jobs.update(jobs =>
      jobs.map(job =>
        job.id === jobId ? { ...job, trimStartTime, trimEndTime } : job
      )
    );
  }

  /**
   * Set backend job ID mapping
   */
  setBackendJobId(frontendJobId: string, backendJobId: string): void {
    this.backendToFrontendIdMap.set(backendJobId, frontendJobId);
    this.frontendToBackendIdMap.set(frontendJobId, backendJobId);

    this.jobs.update(jobs =>
      jobs.map(job =>
        job.id === frontendJobId ? { ...job, backendJobId } : job
      )
    );
  }

  /**
   * Clear a job's backend job ID through the signal (so the persisted job
   * doesn't keep a stale backendJobId after updateJobState replaced it)
   */
  private clearBackendJobId(jobId: string): void {
    this.jobs.update(jobs =>
      jobs.map(job =>
        job.id === jobId ? { ...job, backendJobId: undefined } : job
      )
    );
  }

  /**
   * Get frontend job ID from backend job ID
   */
  getFrontendJobId(backendJobId: string): string | undefined {
    return this.backendToFrontendIdMap.get(backendJobId);
  }

  /**
   * Get backend job ID from frontend job ID
   */
  getBackendJobId(frontendJobId: string): string | undefined {
    return this.frontendToBackendIdMap.get(frontendJobId);
  }

  /**
   * Remove a job from the queue
   */
  removeJob(jobId: string): void {
    const backendId = this.frontendToBackendIdMap.get(jobId);
    if (backendId) {
      this.backendToFrontendIdMap.delete(backendId);
      this.frontendToBackendIdMap.delete(jobId);
    }
    this.jobs.update(jobs => jobs.filter(job => job.id !== jobId));
  }

  /**
   * Cancel and remove jobs from the queue.
   * Notifies backend to cancel running tasks, then removes from frontend state.
   * Always removes from frontend even if backend cancel fails (job may have already finished).
   */
  cancelJobs(frontendJobIds: string[]): void {
    // Collect backend IDs for jobs that have been submitted
    const backendJobIds = frontendJobIds
      .map(id => this.frontendToBackendIdMap.get(id))
      .filter((id): id is string => !!id);

    // Immediately remove from frontend state (user clicked cancel, honor it)
    frontendJobIds.forEach(id => this.removeJob(id));

    // Optimistic removal stands; the backend is told to cancel and any
    // failure to confirm is surfaced (job may still be running server-side).
    this.notifyBackendCancel(backendJobIds);
  }

  /**
   * Ask the backend to cancel jobs. Frontend state is already updated
   * optimistically by the callers (user clicked cancel — honor it instantly),
   * but a failed confirmation is surfaced: the job may still be consuming
   * CPU/disk and can reappear on the next queue restore.
   */
  private notifyBackendCancel(backendJobIds: string[]): void {
    if (backendJobIds.length === 0) {
      return;
    }
    this.http.post<{ success?: boolean }>(`${this.API_BASE}/queue/cancel-all`, { jobIds: backendJobIds }).pipe(
      tap(() => console.log(`[QueueService] Cancelled ${backendJobIds.length} backend job(s)`)),
      catchError(error => {
        this.errorSurface.surfaceError(
          "Backend didn't confirm cancel — job may still be running",
          error
        );
        return of(undefined);
      })
    ).subscribe();
  }

  /**
   * Clear all completed/failed jobs
   */
  clearCompleted(): void {
    const completedIds = this.jobs()
      .filter(j => j.state === 'completed' || j.state === 'failed')
      .map(j => j.id);

    // Clean up ID maps
    completedIds.forEach(id => {
      const backendId = this.frontendToBackendIdMap.get(id);
      if (backendId) {
        this.backendToFrontendIdMap.delete(backendId);
        this.frontendToBackendIdMap.delete(id);
      }
    });

    this.jobs.update(jobs =>
      jobs.filter(job => job.state !== 'completed' && job.state !== 'failed')
    );
  }

  /**
   * Clear all jobs (including processing ones)
   * This is a forceful operation - cancels backend jobs first
   */
  clearAll(): void {
    console.log('[QueueService] CLEAR ALL called');

    // Get all backend job IDs for processing jobs before clearing
    const processingJobs = this.processingJobs();
    const backendJobIds = processingJobs
      .map(job => this.frontendToBackendIdMap.get(job.id))
      .filter((id): id is string => !!id);

    // Clear all mappings
    this.backendToFrontendIdMap.clear();
    this.frontendToBackendIdMap.clear();

    // Clear all jobs immediately
    this.jobs.set([]);

    console.log('[QueueService] All jobs cleared from frontend');

    // Optimistic removal stands; failed confirmation is surfaced.
    this.notifyBackendCancel(backendJobIds);
  }

  /**
   * Clear pending and processing jobs (keeps completed/failed for review)
   * Useful for "Clear Queue" that removes waiting items but keeps history
   */
  clearPendingAndProcessing(): void {
    console.log('[QueueService] CLEAR PENDING AND PROCESSING called');

    // Get backend job IDs for all jobs we're about to clear
    const jobsToClear = this.jobs().filter(j => j.state === 'pending' || j.state === 'processing');
    const backendJobIds = jobsToClear
      .map(job => this.frontendToBackendIdMap.get(job.id))
      .filter((id): id is string => !!id);

    // Clean up ID maps for cleared jobs
    jobsToClear.forEach(job => {
      const backendId = this.frontendToBackendIdMap.get(job.id);
      if (backendId) {
        this.backendToFrontendIdMap.delete(backendId);
        this.frontendToBackendIdMap.delete(job.id);
      }
    });

    // Remove pending and processing jobs, keep completed/failed
    this.jobs.update(jobs =>
      jobs.filter(job => job.state !== 'pending' && job.state !== 'processing')
    );

    console.log(`[QueueService] Cleared ${jobsToClear.length} pending/processing jobs`);

    // Optimistic removal stands; failed confirmation is surfaced.
    this.notifyBackendCancel(backendJobIds);
  }

  /**
   * Clear all pending jobs
   */
  clearPending(): void {
    const pendingIds = this.jobs()
      .filter(j => j.state === 'pending')
      .map(j => j.id);

    // Clean up ID maps
    pendingIds.forEach(id => {
      const backendId = this.frontendToBackendIdMap.get(id);
      if (backendId) {
        this.backendToFrontendIdMap.delete(backendId);
        this.frontendToBackendIdMap.delete(id);
      }
    });

    this.jobs.update(jobs => jobs.filter(job => job.state !== 'pending'));
    console.log(`[QueueService] Cleared ${pendingIds.length} pending jobs`);
  }

  /**
   * Stop all processing IMMEDIATELY and move processing jobs back to pending
   * This is a forceful operation - it updates frontend state first, then notifies backend
   */
  stopProcessing(): Observable<void> {
    const processingJobs = this.processingJobs();
    console.log(`[QueueService] STOP PROCESSING called - ${processingJobs.length} processing jobs`);

    if (processingJobs.length === 0) {
      console.log('[QueueService] No processing jobs to stop');
      return of(undefined);
    }

    // Get backend job IDs BEFORE we modify jobs
    const backendJobIds = processingJobs
      .map(job => this.frontendToBackendIdMap.get(job.id))
      .filter((id): id is string => !!id);

    // IMMEDIATELY move all processing jobs back to pending state
    // This happens synchronously - no waiting for backend
    processingJobs.forEach(job => {
      console.log(`[QueueService] Resetting job ${job.id} to pending`);
      // Reset job state and clear any errors/timestamps
      this.resetJobToDefault(job.id);
      // Reset ALL task states and progress back to pending
      job.tasks.forEach(task => {
        this.resetTaskToDefault(job.id, task.type);
      });
      // Clear backend job ID mapping since we're resetting
      if (job.backendJobId) {
        this.backendToFrontendIdMap.delete(job.backendJobId);
        this.frontendToBackendIdMap.delete(job.id);
      }
    });

    // Clear the backendJobId from the job objects themselves
    this.jobs.update(jobs =>
      jobs.map(job => {
        if (job.state === 'pending' && job.backendJobId) {
          return { ...job, backendJobId: undefined };
        }
        return job;
      })
    );

    console.log(`[QueueService] All processing jobs reset to pending. Notifying backend...`);

    // Optimistic reset stands; failed confirmation is surfaced.
    this.notifyBackendCancel(backendJobIds);

    return of(undefined);
  }

  // ==================== BACKEND INTEGRATION ====================

  /**
   * Submit pending jobs to the backend for processing
   * Returns a map of frontend job ID -> backend job ID, plus any warnings about skipped tasks
   */
  submitPendingJobs(): Observable<{ jobIdMap: Map<string, string>; warnings: string[] }> {
    return this.submitJobs();
  }

  /**
   * Submit specific pending jobs to the backend (all pending jobs when ids
   * are omitted). Toolbar/inspector pipeline actions submit exactly the jobs
   * they just staged, so items a user deliberately parked in staging are
   * never swept along.
   */
  submitJobs(jobIds?: string[]): Observable<{ jobIdMap: Map<string, string>; warnings: string[] }> {
    const allPending = this.pendingJobs();
    const pendingJobs = jobIds ? allPending.filter(job => jobIds.includes(job.id)) : allPending;
    if (pendingJobs.length === 0) return of({ jobIdMap: new Map(), warnings: [] });

    // Get current library ID - REQUIRED for processing
    const currentLibrary = this.libraryService.currentLibrary();
    if (!currentLibrary?.id) {
      console.error('[QueueService] Cannot submit jobs: No library configured');

      // Mark all pending jobs as failed
      pendingJobs.forEach(job => {
        this.updateJobState(job.id, 'failed');
        this.updateJobError(job.id, 'No library configured. Please create a library first.');
      });

      return of({ jobIdMap: new Map(), warnings: [] });
    }
    const libraryId = currentLibrary.id;

    // Split jobs into two groups:
    // 1. Jobs that already have a backendJobId (e.g. paused export-clip jobs
    //    submitted by the export dialog) — these just need to be unpaused.
    // 2. Jobs without a backendJobId — these need new backend jobs created.
    const jobsToUnpause = pendingJobs.filter(job => !!job.backendJobId);
    const jobsToCreate = pendingJobs.filter(job => !job.backendJobId);

    // IMMEDIATELY move ALL jobs to 'processing' state
    // This prevents editing and shows them in the processing section right away
    const allJobIds = pendingJobs.map(job => job.id);
    allJobIds.forEach(id => this.updateJobState(id, 'processing'));
    console.log(`[QueueService] Moved ${allJobIds.length} jobs to processing state (${jobsToUnpause.length} to unpause, ${jobsToCreate.length} to create)`);

    // Handle unpausing existing backend jobs
    const unpausePromise: Promise<Map<string, string>> = jobsToUnpause.length > 0
      ? this.unpausePendingJobs(jobsToUnpause)
      : Promise.resolve(new Map<string, string>());

    // Handle creating new backend jobs
    const createPromise = jobsToCreate.length > 0
      ? this.createNewBackendJobs(jobsToCreate, libraryId)
      : Promise.resolve({ map: new Map<string, string>(), warnings: [] as string[] });

    return new Observable<{ jobIdMap: Map<string, string>; warnings: string[] }>(subscriber => {
      Promise.all([unpausePromise, createPromise]).then(([unpausedMap, createResult]) => {
        // Merge both maps
        const combined = new Map<string, string>();
        unpausedMap.forEach((v, k) => combined.set(k, v));
        createResult.map.forEach((v, k) => combined.set(k, v));
        subscriber.next({ jobIdMap: combined, warnings: createResult.warnings });
        subscriber.complete();
      }).catch(error => {
        subscriber.error(error);
      });
    });
  }

  /**
   * Unpause backend jobs that were submitted as paused (e.g. from export dialog's "Take Me There")
   */
  private async unpausePendingJobs(jobs: QueueJob[]): Promise<Map<string, string>> {
    const backendJobIds = jobs.map(job => job.backendJobId!);
    const frontendToBackend = new Map<string, string>();

    try {
      await firstValueFrom(
        this.http.post<any>(`${this.API_BASE}/queue/jobs/start`, { jobIds: backendJobIds })
      );

      jobs.forEach(job => {
        frontendToBackend.set(job.id, job.backendJobId!);
      });

      console.log(`[QueueService] Unpaused ${backendJobIds.length} existing backend jobs`);
    } catch (error: any) {
      console.error('[QueueService] Failed to unpause jobs:', error);
      // Revert jobs back to pending so user can try again
      jobs.forEach(job => {
        this.updateJobState(job.id, 'pending');
        this.updateJobError(job.id, error.message || 'Failed to start paused jobs');
      });
    }

    return frontendToBackend;
  }

  /**
   * Create new backend jobs for pending frontend jobs that don't have a backendJobId yet
   */
  private async createNewBackendJobs(jobs: QueueJob[], libraryId: string): Promise<{ map: Map<string, string>; warnings: string[] }> {
    const frontendToBackend = new Map<string, string>();
    const warnings: string[] = [];

    // Convert to backend format
    const backendJobs: BackendJobRequest[] = jobs.map(job => {
      const tasks = this.convertTasksToBackendFormat(job.tasks, !!job.url, job.trimStartTime, warnings, job.trimEndTime);

      if (job.url) {
        return {
          url: job.url,
          displayName: job.title,
          libraryId,
          tasks
        };
      } else {
        return {
          videoId: job.videoId || job.id,
          displayName: job.title,
          libraryId,
          tasks
        };
      }
    });

    try {
      const response = await firstValueFrom(
        this.libraryService.createBulkJobs(backendJobs)
      );

      if (response.success) {
        const jobIds = response.data.jobIds;

        jobs.forEach((job, index) => {
          if (index < jobIds.length) {
            const backendJobId = jobIds[index];
            this.setBackendJobId(job.id, backendJobId);
            frontendToBackend.set(job.id, backendJobId);
          } else {
            // Backend accepted fewer job IDs than we submitted. submitJobs()
            // already moved every job to 'processing', so a job left without a
            // backendJobId here can never be reconciled (no WS events, no ID to
            // match) and would stay stuck at processing/0% forever. Revert it to
            // pending with a clear error so it's visible and re-submittable.
            console.error(`[QueueService] Backend returned no job ID for job ${job.id} — reverting to pending`);
            this.updateJobState(job.id, 'pending');
            this.updateJobError(job.id, 'Backend did not accept this job. Please try again.');
          }
        });

        console.log(`[QueueService] ${jobIds.length} new jobs submitted to backend`);

        // Sync state from backend after a short delay to catch any WebSocket events
        // that may have been emitted before the ID mapping was established.
        // This handles the race condition where local-file tasks (transcribe, analyze)
        // start processing immediately and emit events before the HTTP response arrives.
        setTimeout(() => this.restoreFromBackend(), 500);
      } else {
        console.error('[QueueService] Failed to create jobs');
        // Revert jobs back to pending so user can try again
        jobs.forEach(job => {
          this.updateJobState(job.id, 'pending');
          this.updateJobError(job.id, 'Failed to submit job to backend');
        });
      }
    } catch (error: any) {
      console.error('[QueueService] Failed to submit jobs:', error);
      // Revert jobs back to pending so user can try again
      jobs.forEach(job => {
        this.updateJobState(job.id, 'pending');
        this.updateJobError(job.id, error.message || 'Unknown error');
      });
    }

    return { map: frontendToBackend, warnings };
  }

  /**
   * Restore processing jobs from backend on initialization.
   * Serialized via restoreInFlight to prevent parallel refreshes from each
   * running Pass 3 and creating duplicate frontend jobs for the same backend job.
   */
  private restoreFromBackend(): Promise<void> {
    if (this.restoreInFlight) {
      // A refresh is already running. Mark that we want another one to run
      // right after it finishes (coalesce multiple pending requests into one).
      this.restoreQueued = true;
      return this.restoreInFlight;
    }

    this.restoreInFlight = this.doRestoreFromBackend().finally(() => {
      this.restoreInFlight = null;
      if (this.restoreQueued) {
        this.restoreQueued = false;
        // Kick off the queued refresh — returns a new promise we don't await
        // from this finally (fire-and-forget is fine; callers who awaited the
        // original already got their result).
        this.restoreFromBackend();
      }
    });

    return this.restoreInFlight;
  }

  private async doRestoreFromBackend(): Promise<void> {
    console.log('[QueueService] Restoring jobs from backend...');
    try {
      const response = await firstValueFrom(
        this.http.get<any>(`${this.API_BASE}/queue/jobs`)
      );

      if (response.success && Array.isArray(response.jobs)) {
        const backendJobs = response.jobs;
        console.log(`[QueueService] Found ${backendJobs.length} backend jobs`);

        // Create a set of backend job IDs for quick lookup
        const backendJobIds = new Set(backendJobs.map((j: any) => j.id));

        // First: Mark orphaned pending/processing jobs as completed.
        // These are jobs whose backend ID no longer exists — the backend already
        // finished processing and cleaned them up. This catches two scenarios:
        //   a) Processing jobs whose backend task completed while the frontend
        //      was away (the normal orphan case).
        //   b) Pending jobs left behind by a popout editor window. The popout
        //      and main window share localStorage but have independent signal
        //      state, so a stale "pending" copy from the popout can persist
        //      even after the main window completed and cleaned up its own copy.
        const currentJobs = this.jobs();
        let orphanedCount = 0;
        currentJobs.forEach(job => {
          if ((job.state === 'processing' || job.state === 'pending') && job.backendJobId && !backendJobIds.has(job.backendJobId)) {
            console.log(`[QueueService] Marking orphaned ${job.state} job as completed: ${job.id} (backend: ${job.backendJobId})`);
            this.updateJobState(job.id, 'completed');
            // Clear the backend job ID since it no longer exists
            this.frontendToBackendIdMap.delete(job.id);
            this.backendToFrontendIdMap.delete(job.backendJobId);
            this.clearBackendJobId(job.id);
            // Mark running tasks as completed too
            job.tasks.forEach(task => {
              if (task.state === 'running') {
                this.updateTaskState(job.id, task.type, 'completed');
              }
            });
            orphanedCount++;
          }
        });
        if (orphanedCount > 0) {
          console.log(`[QueueService] Marked ${orphanedCount} orphaned jobs as completed`);
        }

        // Second: Sync with backend jobs
        // We match backend jobs to frontend jobs in three passes:
        //   1. By backendJobId (the normal case — job is already tracked)
        //   2. By identity (url or videoId) for jobs that are mid-submission.
        //      submitPendingJobs() marks jobs as 'processing' locally BEFORE the
        //      POST response assigns backendJobId. If refreshFromBackend() runs
        //      during that window (e.g. user adds another URL and we switch to
        //      the queue tab), we MUST NOT create a duplicate — we must attach
        //      the backend ID to the in-flight frontend job instead.
        //   3. Create a brand new frontend job (e.g. export-clip from a popout)
        //
        // We also track already-matched frontend IDs so two backend jobs can't
        // collide onto the same frontend job, and we reap any legacy duplicates
        // that share a backendJobId from earlier buggy sessions.
        const matchedFrontendIds = new Set<string>();
        const duplicateIdsToRemove: string[] = [];

        backendJobs.forEach((backendJob: any) => {
          // Pass 1: Match by backendJobId (and collect legacy duplicates)
          const matchesById = this.jobs().filter(j => j.backendJobId === backendJob.id);
          if (matchesById.length > 0) {
            const primary = matchesById[0];
            matchedFrontendIds.add(primary.id);

            // Any other jobs sharing this backendJobId are leftover duplicates
            // from the pre-fix race condition — reap them.
            for (let i = 1; i < matchesById.length; i++) {
              console.warn(`[QueueService] Removing legacy duplicate of backend job ${backendJob.id}: ${matchesById[i].id}`);
              duplicateIdsToRemove.push(matchesById[i].id);
            }

            const newState = this.mapBackendStatus(backendJob.status);
            if (primary.state !== newState) {
              this.updateJobState(primary.id, newState);
            }
            return;
          }

          // Pass 2: Match by identity (url or videoId) for in-flight submissions
          const byIdentity = this.jobs().find(j => {
            if (matchedFrontendIds.has(j.id)) return false;
            if (j.backendJobId) return false;
            if (j.state !== 'processing' && j.state !== 'pending') return false;
            if (backendJob.url && j.url && j.url === backendJob.url) return true;
            if (backendJob.videoId && j.videoId && j.videoId === backendJob.videoId) return true;
            return false;
          });

          if (byIdentity) {
            console.log(`[QueueService] Matched in-flight job ${byIdentity.id} to backend job ${backendJob.id} by identity (submit race guard)`);
            matchedFrontendIds.add(byIdentity.id);
            this.setBackendJobId(byIdentity.id, backendJob.id);
            const newState = this.mapBackendStatus(backendJob.status);
            if (byIdentity.state !== newState) {
              this.updateJobState(byIdentity.id, newState);
            }
            return;
          }

          // Pass 3: Create new job from backend data (genuinely new, e.g. from
          // a popout editor export-clip submission)
          const frontendJob = this.mapBackendToFrontendJob(backendJob);
          matchedFrontendIds.add(frontendJob.id);
          this.setBackendJobId(frontendJob.id, backendJob.id);
          this.jobs.update(jobs => [...jobs, frontendJob]);
        });

        // Reap any legacy duplicates we found during matching
        if (duplicateIdsToRemove.length > 0) {
          console.log(`[QueueService] Cleaning up ${duplicateIdsToRemove.length} legacy duplicate job(s)`);
          duplicateIdsToRemove.forEach(id => this.removeJob(id));
        }

        console.log(`[QueueService] Queue restored with ${this.jobs().length} total jobs`);
      } else {
        // Backend returned no jobs — mark any pending/processing jobs that
        // have a backendJobId as completed (the backend already finished and
        // cleaned them up). Jobs without a backendJobId are locally-queued
        // items that haven't been submitted yet, so leave them alone.
        const currentJobs = this.jobs();
        let completedCount = 0;
        currentJobs.forEach(job => {
          if ((job.state === 'processing' || job.state === 'pending') && job.backendJobId) {
            console.log(`[QueueService] No backend jobs - marking ${job.state} job as completed: ${job.id}`);
            this.updateJobState(job.id, 'completed');
            this.frontendToBackendIdMap.delete(job.id);
            this.backendToFrontendIdMap.delete(job.backendJobId);
            this.clearBackendJobId(job.id);
            job.tasks.forEach(task => {
              if (task.state === 'running') {
                this.updateTaskState(job.id, task.type, 'completed');
              }
            });
            completedCount++;
          }
        });
        if (completedCount > 0) {
          console.log(`[QueueService] Marked ${completedCount} orphaned jobs as completed (no backend jobs found)`);
        }
      }
    } catch (error) {
      // Do NOT touch job state here. Marking in-flight jobs "completed" on a
      // backend hiccup fakes success on running downloads/transcriptions
      // (fallback-audit critical #1). Keep everything as-is and reconcile on
      // the next successful restore — the matching logic above already does
      // that. Surface the outage once per episode, not once per poll.
      if (!this.backendUnreachable) {
        this.backendUnreachable = true;
        this.errorSurface.surfaceError(
          'Queue refresh failed — backend unreachable',
          error
        );
      } else {
        console.error('[QueueService] Restore still failing (already surfaced):', error);
      }
      return;
    }
    if (this.backendUnreachable) {
      this.backendUnreachable = false;
      console.log('[QueueService] Backend reachable again — queue reconciled');
    }
  }

  /**
   * Public method to refresh queue state from backend
   * Used when navigating to the queue tab to pick up export-clip jobs
   */
  refreshFromBackend(): Promise<void> {
    return this.restoreFromBackend();
  }

  // ==================== WEBSOCKET HANDLERS ====================

  private setupWebSocketHandlers(): void {
    this.websocketService.connect();

    this.wsUnsubscribes.push(
      this.websocketService.onTaskStarted(event => this.handleTaskStarted(event))
    );
    this.wsUnsubscribes.push(
      this.websocketService.onTaskProgress(event => this.handleTaskProgress(event))
    );
    this.wsUnsubscribes.push(
      this.websocketService.onTaskCompleted(event => this.handleTaskCompleted(event))
    );
    this.wsUnsubscribes.push(
      this.websocketService.onTaskFailed(event => this.handleTaskFailed(event))
    );
  }

  private handleTaskStarted(event: TaskStarted): void {
    const jobId = this.backendToFrontendIdMap.get(event.jobId);
    if (!jobId) {
      console.log('[QueueService] task.started for unknown job:', event.jobId);
      return;
    }

    const taskType = this.mapBackendToFrontendTaskType(event.type);
    console.log(`[QueueService] Task started: ${taskType} for job ${jobId}`);

    // Update job to processing state
    this.updateJobState(jobId, 'processing');

    // Update task state (unless it's a sub-task like get-info or import)
    if (!['get-info', 'import'].includes(event.type)) {
      this.updateTaskState(jobId, taskType, 'running');
    }
  }

  private handleTaskProgress(event: TaskProgress): void {
    const jobId = this.backendToFrontendIdMap.get(event.jobId);
    if (!jobId) return;

    const taskType = this.mapBackendToFrontendTaskType(event.type || '');
    const progress = event.progress === -1 ? 0 : event.progress;

    // Handle process-video which combines aspect-ratio and normalize-audio
    if (event.type === 'process-video') {
      this.updateTaskProgress(jobId, 'fix-aspect-ratio', progress, event.eta, event.taskLabel);
      this.updateTaskProgress(jobId, 'normalize-audio', progress, event.eta, event.taskLabel);
    } else {
      this.updateTaskProgress(jobId, taskType, progress, event.eta, event.taskLabel);
    }
  }

  private handleTaskCompleted(event: TaskCompleted): void {
    const jobId = this.backendToFrontendIdMap.get(event.jobId);
    if (!jobId) {
      console.log('[QueueService] task.completed for unknown job:', event.jobId);
      return;
    }

    const taskType = this.mapBackendToFrontendTaskType(event.type);
    console.log(`[QueueService] Task completed: ${taskType} for job ${jobId}`);

    // Capture videoId from the event if present (sent by backend after import)
    if (event.videoId) {
      this.updateJobVideoId(jobId, event.videoId);
    }

    // Handle process-video which combines aspect-ratio and normalize-audio
    if (event.type === 'process-video') {
      this.updateTaskState(jobId, 'fix-aspect-ratio', 'completed');
      this.updateTaskState(jobId, 'normalize-audio', 'completed');
    } else {
      this.updateTaskState(jobId, taskType, 'completed');
    }

    // Check if all tasks are completed
    const job = this.jobs().find(j => j.id === jobId);
    if (job && areAllTasksDone(job)) {
      const finalState = hasFailedTask(job) ? 'failed' : 'completed';
      this.updateJobState(jobId, finalState);
      console.log(`[QueueService] Job ${jobId} ${finalState}`);
    }
  }

  private handleTaskFailed(event: TaskFailed): void {
    const jobId = this.backendToFrontendIdMap.get(event.jobId);
    if (!jobId) {
      console.log('[QueueService] task.failed for unknown job:', event.jobId);
      return;
    }

    const taskType = this.mapBackendToFrontendTaskType(event.type);
    const errorMessage = event.error?.message || 'Unknown error';
    console.log(`[QueueService] Task failed: ${taskType} for job ${jobId}: ${errorMessage}`);

    // Handle process-video which combines aspect-ratio and normalize-audio
    if (event.type === 'process-video') {
      this.updateTaskState(jobId, 'fix-aspect-ratio', 'failed', errorMessage);
      this.updateTaskState(jobId, 'normalize-audio', 'failed', errorMessage);
    } else {
      this.updateTaskState(jobId, taskType, 'failed', errorMessage);
    }

    // Mark job as failed
    this.updateJobState(jobId, 'failed');
    this.updateJobError(jobId, errorMessage);
  }

  // ==================== PERSISTENCE ====================

  private loadFromStorage(): void {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return;

      const jobs: QueueJob[] = JSON.parse(saved);
      const now = Date.now();

      // Filter out expired completed jobs
      const validJobs = jobs.filter(job => {
        // Keep pending/processing jobs
        if (job.state === 'pending' || job.state === 'processing') {
          return true;
        }
        // Keep completed/failed jobs within retention period
        if (job.completedAt) {
          return now - job.completedAt < RETENTION_MS;
        }
        // If no completedAt, use createdAt as fallback
        return now - job.createdAt < RETENTION_MS;
      });

      // Restore ID mappings
      validJobs.forEach(job => {
        if (job.backendJobId) {
          this.backendToFrontendIdMap.set(job.backendJobId, job.id);
          this.frontendToBackendIdMap.set(job.id, job.backendJobId);
        }
      });

      this.jobs.set(validJobs);
      console.log(`[QueueService] Loaded ${validJobs.length} jobs from storage (${jobs.length - validJobs.length} expired)`);
    } catch (error) {
      console.error('[QueueService] Failed to load from storage:', error);
    }
  }

  private saveToStorage(jobs: QueueJob[]): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs));
    } catch (error) {
      console.error('[QueueService] Failed to save to storage:', error);
    }
  }

  // ==================== HELPERS ====================

  /**
   * Map backend task type to frontend TaskType
   */
  private mapBackendToFrontendTaskType(backendType: string): TaskType {
    const mapping: Record<string, TaskType> = {
      'download': 'download-import',
      'get-info': 'download-import',
      'import': 'download-import',
      'fix-aspect': 'fix-aspect-ratio',
      'fix-aspect-ratio': 'fix-aspect-ratio',
      'process-video': 'fix-aspect-ratio',
      'strip-black-bars': 'fix-aspect-ratio',
      'normalize': 'normalize-audio',
      'normalize-audio': 'normalize-audio',
      'transcribe': 'transcribe',
      'analyze': 'ai-analyze',
      'analyze-webpage': 'analyze-webpage',
      'export-clip': 'export-clip'
    };

    return mapping[backendType] || 'download-import';
  }

  /**
   * Map backend job status to frontend JobState
   */
  private mapBackendStatus(backendStatus: string): JobState {
    switch (backendStatus) {
      case 'pending':
        return 'pending';
      case 'processing':
        return 'processing';
      case 'completed':
        return 'completed';
      case 'failed':
      case 'cancelled':
        return 'failed';
      default:
        return 'pending';
    }
  }

  /**
   * Convert backend job to frontend QueueJob
   */
  private mapBackendToFrontendJob(backendJob: any): QueueJob {
    const tasks: QueueTask[] = this.mapBackendTasksToFrontend(
      backendJob.tasks || [],
      backendJob.currentTaskIndex
    );

    return createQueueJob({
      title: backendJob.displayName || 'Unknown',
      state: this.mapBackendStatus(backendJob.status),
      url: backendJob.url,
      videoId: backendJob.videoId,
      videoPath: backendJob.videoPath,
      backendJobId: backendJob.id,
      tasks,
      warnings: backendJob.warnings?.length ? [...backendJob.warnings] : undefined,
      createdAt: new Date(backendJob.createdAt).getTime(),
      startedAt: backendJob.startedAt ? new Date(backendJob.startedAt).getTime() : undefined,
      completedAt: backendJob.completedAt ? new Date(backendJob.completedAt).getTime() : undefined
    });
  }

  /**
   * Map backend tasks to frontend format
   */
  private mapBackendTasksToFrontend(backendTasks: any[], currentTaskIndex: number): QueueTask[] {
    const frontendTasks: QueueTask[] = [];
    const seenTypes = new Set<TaskType>();

    // Group download-related tasks into single task
    const downloadTaskTypes = ['get-info', 'download', 'import'];
    const hasDownloadTasks = backendTasks.some(t => downloadTaskTypes.includes(t.type));

    if (hasDownloadTasks) {
      let downloadState: TaskState = 'pending';
      let downloadProgress = 0;

      for (let i = 0; i < backendTasks.length; i++) {
        const task = backendTasks[i];
        if (!downloadTaskTypes.includes(task.type)) continue;

        if (i < currentTaskIndex) {
          downloadState = 'completed';
          downloadProgress = 100;
        } else if (i === currentTaskIndex) {
          downloadState = 'running';
          if (task.type === 'download') {
            downloadProgress = task.progress || 0;
          }
        }
      }

      frontendTasks.push({
        type: 'download-import',
        options: {},
        state: downloadState,
        progress: downloadProgress
      });
      seenTypes.add('download-import');
    }

    // Add other tasks
    for (let i = 0; i < backendTasks.length; i++) {
      const backendTask = backendTasks[i];
      if (downloadTaskTypes.includes(backendTask.type)) continue;

      const taskType = this.mapBackendToFrontendTaskType(backendTask.type);
      if (seenTypes.has(taskType)) continue;
      seenTypes.add(taskType);

      let state: TaskState = 'pending';
      if (i < currentTaskIndex) {
        state = 'completed';
      } else if (i === currentTaskIndex) {
        state = 'running';
      }

      frontendTasks.push({
        type: taskType,
        options: backendTask.options || {},
        state,
        progress: state === 'completed' ? 100 : (state === 'running' ? backendTask.progress || 0 : 0)
      });
    }

    return frontendTasks;
  }

  /**
   * Convert frontend tasks to backend format
   */
  private convertTasksToBackendFormat(tasks: QueueTask[], isUrl: boolean, trimStartTime?: number, warnings?: string[], trimEndTime?: number): BackendTask[] {
    const backendTasks: BackendTask[] = [];

    if (isUrl) {
      backendTasks.push({ type: 'get-info' });
      backendTasks.push({ type: 'download' });
      backendTasks.push({ type: 'import' });
    }

    // Inject trim (export-clip overwrite) after download/import but before
    // processing/transcribe/analyze. A single export-clip task handles both
    // ends: startTime removes the opener, trimEndSeconds removes the tail
    // (resolved against the file's real duration on the backend).
    const hasStartTrim = trimStartTime != null && trimStartTime > 0;
    const hasEndTrim = trimEndTime != null && trimEndTime > 0;
    if (hasStartTrim || hasEndTrim) {
      backendTasks.push({
        type: 'export-clip' as any,
        options: {
          startTime: hasStartTrim ? trimStartTime : 0,
          endTime: null,
          trimEndSeconds: hasEndTrim ? trimEndTime : 0,
          isOverwrite: true
        }
      });
    }

    const hasAspectRatio = tasks.some(t => t.type === 'fix-aspect-ratio');
    const hasNormalizeAudio = tasks.some(t => t.type === 'normalize-audio');

    // Combine aspect-ratio and normalize-audio into single process-video task
    if (hasAspectRatio && hasNormalizeAudio) {
      const aspectTask = tasks.find(t => t.type === 'fix-aspect-ratio');
      const audioTask = tasks.find(t => t.type === 'normalize-audio');
      backendTasks.push({
        type: 'process-video',
        options: {
          fixAspectRatio: true,
          normalizeAudio: true,
          level: audioTask?.options?.['targetLevel'] || -16
        }
      });
    } else if (hasAspectRatio) {
      const task = tasks.find(t => t.type === 'fix-aspect-ratio');
      backendTasks.push({
        type: 'fix-aspect-ratio',
        options: {
          aspectRatio: task?.options?.['targetRatio'] || '16:9'
        }
      });
    } else if (hasNormalizeAudio) {
      const task = tasks.find(t => t.type === 'normalize-audio');
      backendTasks.push({
        type: 'normalize-audio',
        options: {
          level: task?.options?.['targetLevel'] || -16
        }
      });
    }

    // Strip black bars is a sub-option of fix-aspect-ratio
    const aspectTask = tasks.find(t => t.type === 'fix-aspect-ratio');
    if (aspectTask?.options?.['stripBlackBars']) {
      backendTasks.push({ type: 'strip-black-bars' });
    }

    const transcribeTask = tasks.find(t => t.type === 'transcribe');
    if (transcribeTask) {
      backendTasks.push({
        type: 'transcribe',
        options: {
          model: transcribeTask.options?.['model'] || 'base',
          language: transcribeTask.options?.['language'],
          translate: transcribeTask.options?.['translate'] === true
        }
      });
    }

    const exportClipTask = tasks.find(t => t.type === 'export-clip');
    if (exportClipTask) {
      backendTasks.push({
        type: 'export-clip' as any,
        options: exportClipTask.options
      });
    }

    const analyzeTask = tasks.find(t => t.type === 'ai-analyze');
    if (analyzeTask) {
      if (!analyzeTask.options?.['aiModel']) {
        warnings?.push('AI analysis was skipped because no AI model is selected. Configure a model in the queue item settings.');
      } else {
        // Parse provider:model string
        const modelValue = analyzeTask.options['aiModel'];
        let aiProvider = 'ollama';
        let aiModel = modelValue;

        if (modelValue.includes(':')) {
          const firstColon = modelValue.indexOf(':');
          const possibleProvider = modelValue.substring(0, firstColon);
          if (['ollama', 'claude', 'openai', 'local'].includes(possibleProvider)) {
            aiProvider = possibleProvider;
            aiModel = modelValue.substring(firstColon + 1);
          }
        }

        backendTasks.push({
          type: 'analyze',
          options: {
            aiModel,
            aiProvider,
            customInstructions: analyzeTask.options?.['customInstructions'],
            analysisGranularity: analyzeTask.options?.['analysisGranularity'] ?? 2,
            analysisQuality: analyzeTask.options?.['analysisQuality'] || 'fast'
          }
        });
      }
    }

    const analyzeWebpageTask = tasks.find(t => t.type === 'analyze-webpage');
    if (analyzeWebpageTask) {
      if (!analyzeWebpageTask.options?.['aiModel']) {
        warnings?.push('Webpage analysis was skipped because no AI model is selected. Configure a model in the queue item settings.');
      } else {
        // Parse provider:model string
        const modelValue = analyzeWebpageTask.options['aiModel'];
        let aiProvider = 'ollama';
        let aiModel = modelValue;

        if (modelValue.includes(':')) {
          const firstColon = modelValue.indexOf(':');
          const possibleProvider = modelValue.substring(0, firstColon);
          if (['ollama', 'claude', 'openai', 'local'].includes(possibleProvider)) {
            aiProvider = possibleProvider;
            aiModel = modelValue.substring(firstColon + 1);
          }
        }

        backendTasks.push({
          type: 'analyze-webpage' as any,
          options: {
            aiModel,
            aiProvider,
          }
        });
      }
    }

    return backendTasks;
  }
}
