// Queue Manager Service - Executes task-based jobs with configurable concurrency

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { MediaEventService } from '../media/media-event.service';
import { MediaOperationsService } from '../media/media-operations.service';
import { LibraryManagerService } from '../database/library-manager.service';
import { DatabaseService } from '../database/database.service';
import { FileScannerService } from '../database/file-scanner.service';
import { ClipExtractorService } from '../library/clip-extractor.service';
import { LibraryService } from '../library/library.service';
import {
  QueueJob,
  QueueStatus,
  Task,
  TaskResult,
} from '../common/interfaces/task.interface';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { atomicReplaceFile } from '../common/utils/temp-file.util';

// Active task tracking
export interface ActiveTask {
  taskId: string;
  jobId: string;
  taskIndex: number;
  type: string;
  pool: 'main' | 'ai';
  libraryId?: string;    // Resolved library this task operates on. The scheduler
                         // refuses to start a task for a different library while
                         // any task is in flight, so the shared DB connection is
                         // never switched out from under a running task.
  progress: number;
  message: string;
  startedAt: Date;
  lastProgressAt: Date;  // Track when we last received progress update
  abandoned?: boolean;   // Set when the watchdog force-fails a stuck task so the
                         // original executeTask promise won't double-finalize if it
                         // eventually settles.
}

@Injectable()
export class QueueManagerService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(QueueManagerService.name);

  // Unified job queue (no more separate batch/analysis queues)
  private jobQueue = new Map<string, QueueJob>();

  // Track cancelled job IDs for in-flight task cancellation
  private cancelledJobs = new Set<string>();

  // Task pools - tracks actively running tasks
  private mainPool = new Map<string, ActiveTask>();  // Max 5 concurrent
  private aiPool: ActiveTask | null = null;           // Max 1 concurrent

  // Queue processing state (kept for API compatibility, no longer used as a lock)
  private processing = false;

  // Watchdog timer for detecting stuck tasks
  private watchdogInterval: NodeJS.Timeout | null = null;
  private readonly WATCHDOG_INTERVAL_MS = 60000;  // Check every minute
  // 90 minutes. Sized from measured qwen3.8:27b rates (~220s per flag-extraction
  // call, ~40s per chapter): a 60-minute video projects to ~57min, leaving almost
  // no margin at 60. The asymmetry justifies the headroom — a run that finishes
  // early costs nothing, while a premature kill destroys the whole analysis,
  // since results are only persisted at finalize.
  private readonly AI_TASK_TIMEOUT_MS = 90 * 60 * 1000;  // 90 minutes for AI tasks
  // Main-pool tasks are killed on a STALL, not on total runtime. A wall-clock
  // cap can't distinguish a wedged task from a healthy slow one, and legitimate
  // work routinely runs past any cap worth setting: a 2.5-hour broadcast is a
  // multi-GB HLS download, and transcode/transcribe scale with duration too.
  // As long as a task keeps reporting progress it is making headway and is left
  // alone; 10 minutes of total silence is the stuck signal.
  private readonly MAIN_TASK_STALL_MS = 10 * 60 * 1000;  // 10 minutes with no progress

  // Concurrency limits (5+1 model)
  private readonly MAX_MAIN_CONCURRENT = 5;  // 5 general tasks
  private readonly MAX_AI_CONCURRENT = 1;     // 1 AI task

  constructor(
    private readonly mediaOps: MediaOperationsService,
    private readonly eventService: MediaEventService,
    private readonly libraryManager: LibraryManagerService,
    private readonly databaseService: DatabaseService,
    private readonly eventEmitter: EventEmitter2,
    private readonly clipExtractor: ClipExtractorService,
    private readonly fileScannerService: FileScannerService,
    private readonly libraryService: LibraryService,
  ) {}

  /**
   * Lifecycle hook - called when the module is initialized
   * Starts the watchdog timer to detect stuck tasks
   */
  onModuleInit() {

    this.startWatchdog();
  }

  /**
   * Start the watchdog timer
   */
  private startWatchdog() {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
    }

    this.watchdogInterval = setInterval(() => {
      this.checkForStuckTasks();
    }, this.WATCHDOG_INTERVAL_MS);

    this.logger.log('Watchdog started - will check for stuck tasks every minute');
  }

  /**
   * Check for tasks that have been running too long
   */
  private checkForStuckTasks() {
    const now = new Date();

    // Check AI pool. The AI pool has exactly ONE slot, so a hung AI task wedges
    // ALL analysis forever unless we actively reclaim the slot. On hard timeout,
    // fail the task and free the slot instead of only logging.
    if (this.aiPool) {
      const active = this.aiPool;
      const runningMs = now.getTime() - active.startedAt.getTime();
      const lastProgressMs = now.getTime() - active.lastProgressAt.getTime();

      if (runningMs > this.AI_TASK_TIMEOUT_MS) {
        this.logger.error(
          `⏱️ AI task ${active.taskId} exceeded the ${Math.round(this.AI_TASK_TIMEOUT_MS / 60000)}-minute timeout ` +
          `(running ${Math.round(runningMs / 60000)}m, last progress ${Math.round(lastProgressMs / 1000)}s ago at ${active.progress}%). ` +
          `Failing it and freeing the AI slot.`
        );
        this.failStuckTask(active, 'ai', `AI task timed out after ${Math.round(runningMs / 60000)} minutes without completing`);
      } else if (lastProgressMs > 5 * 60 * 1000) {  // 5 minutes without progress
        this.logger.warn(
          `⚠️ AI task ${active.taskId} hasn't reported progress in ${Math.round(lastProgressMs / 60000)} minutes ` +
          `(stuck at ${active.progress}%)`
        );
      }
    }

    // Check main pool
    for (const [taskId, task] of this.mainPool.entries()) {
      const runningMs = now.getTime() - task.startedAt.getTime();
      const lastProgressMs = now.getTime() - task.lastProgressAt.getTime();

      if (lastProgressMs > this.MAIN_TASK_STALL_MS) {
        this.logger.error(
          `⏱️ Main task ${taskId} (${task.type}) stalled: no progress for ` +
          `${Math.round(lastProgressMs / 60000)}m (running ${Math.round(runningMs / 60000)}m, stuck at ${task.progress}%). ` +
          `Failing it and freeing the slot.`
        );
        this.failStuckTask(task, 'main', `Task stalled — no progress for ${Math.round(lastProgressMs / 60000)} minutes`);
      }
    }
  }

  /**
   * Abort the running child process behind an active task. Routed by jobId via
   * the 'job.cancel-requested' event: the downloader, ffmpeg and whisper
   * services each own their processes and ignore the signal unless they hold one
   * for this jobId. Aborting is idempotent and safe if the process already
   * finished (each service no-ops on an unknown jobId/processId).
   */
  private abortActiveTask(active: ActiveTask): void {
    try {
      this.eventEmitter.emit('job.cancel-requested', {
        jobId: active.jobId,
        type: active.type,
      });
    } catch (err) {
      this.logger.warn(`Failed to signal abort for job ${active.jobId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Force-fail a task the watchdog has determined is stuck. Mirrors the failure
   * path in executeTask: kill the child, mark the job failed, free the pool slot,
   * emit task.failed on both buses, schedule removal, and kick the queue so
   * waiting work proceeds. `abandoned` guards executeTask from double-emitting if
   * its promise ever settles later.
   */
  private failStuckTask(active: ActiveTask, pool: 'main' | 'ai', reason: string): void {
    active.abandoned = true;

    // Kill the stuck child so it stops consuming CPU/network instead of only
    // freeing the slot and letting it run on orphaned.
    this.abortActiveTask(active);

    const job = this.jobQueue.get(active.jobId);
    if (job && job.status !== 'completed' && job.status !== 'failed' && job.status !== 'cancelled') {
      job.status = 'failed';
      job.error = reason;
      job.completedAt = new Date();
    }

    // Free the pool slot (identity-checked so we never clobber a different task).
    if (pool === 'main') {
      if (this.mainPool.get(active.taskId) === active) {
        this.mainPool.delete(active.taskId);
      }
    } else if (this.aiPool === active) {
      this.aiPool = null;
    }

    this.emitTaskFailed({
      taskId: active.taskId,
      jobId: active.jobId,
      videoId: job?.videoId,
      type: active.type,
      message: reason,
    });

    // Remove the failed job from the queue after a delay (matches executeTask).
    setTimeout(() => {
      this.jobQueue.delete(active.jobId);
      this.logger.log(`Removed timed-out job ${active.jobId} from queue`);
    }, 5000);

    // Dispatch the next waiting task into the freed slot.
    this.processQueue();
  }

  /**
   * Emit a task.failed event on BOTH event buses:
   *  - MediaEventService (Socket.IO) for live frontend updates.
   *  - EventEmitter2 for in-process listeners.
   */
  private emitTaskFailed(payload: {
    taskId: string;
    jobId: string;
    videoId?: string;
    type: string;
    message: string;
    canRetry?: boolean;
  }): void {
    const event = {
      taskId: payload.taskId,
      jobId: payload.jobId,
      videoId: payload.videoId,
      type: payload.type,
      error: {
        code: 'TASK_FAILED',
        message: payload.message,
      },
      canRetry: payload.canRetry ?? false,
      timestamp: new Date().toISOString(),
    };

    this.eventService.emit('task.failed', event);
    this.eventEmitter.emit('task.failed', event);
  }

  /**
   * Heartbeat from the services that own long-running child processes
   * (download, transcode, transcribe). MediaEventService mirrors every
   * 'task-progress' it emits onto this bus. Without it the watchdog only ever
   * saw a task's starting progress and reaped healthy long work as stalled.
   */
  @OnEvent('task.progress')
  handleTaskProgress(payload: { jobId?: string; progress?: number; message?: string }): void {
    if (!payload?.jobId || typeof payload.progress !== 'number') {
      return;
    }
    this.updateTaskProgress(payload.jobId, payload.progress, payload.message);
  }

  /**
   * Update progress for an active task (called by event handlers)
   */
  updateTaskProgress(jobId: string, progress: number, message?: string): void {
    // Update AI pool if matching
    if (this.aiPool?.jobId === jobId) {
      this.aiPool.progress = progress;
      this.aiPool.lastProgressAt = new Date();
      if (message) this.aiPool.message = message;
    }

    // Update main pool if matching
    const mainTask = this.mainPool.get(jobId);
    if (mainTask) {
      mainTask.progress = progress;
      mainTask.lastProgressAt = new Date();
      if (message) mainTask.message = message;
    }
  }

  /**
   * Calculate the nearest Sunday date folder name
   * Mon-Wed go back to previous Sunday, Thu-Sat go forward to next Sunday.
   * Returns date in YYYY-MM-DD format
   */
  private getNearestSunday(date: Date = new Date()): string {
    const d = new Date(date);
    const dayOfWeek = d.getDay(); // 0 = Sunday
    const sundayDate = new Date(d);

    if (dayOfWeek === 0) {
      // Already Sunday, use current day
    } else if (dayOfWeek <= 3) {
      // Monday-Wednesday: go back to previous Sunday
      sundayDate.setDate(d.getDate() - dayOfWeek);
    } else {
      // Thursday-Saturday: go forward to next Sunday
      sundayDate.setDate(d.getDate() + (7 - dayOfWeek));
    }

    const year = sundayDate.getFullYear();
    const month = String(sundayDate.getMonth() + 1).padStart(2, '0');
    const day = String(sundayDate.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
  }

  /**
   * Get the output directory for a download job
   * If libraryId is specified, uses that library's clips folder
   * Otherwise uses active library or falls back to default
   * Note: The downloader service already adds a Sunday subfolder
   */
  private getDownloadOutputDir(libraryId?: string): string | undefined {
    // Get the target library
    let library;
    if (libraryId) {
      const allLibraries = this.libraryManager.getAllLibraries();
      library = allLibraries.find(lib => lib.id === libraryId);
    } else {
      library = this.libraryManager.getActiveLibrary();
    }

    if (!library) {
      this.logger.warn('No library found for download output directory');
      return undefined;
    }

    // Return the library's clips folder path
    // The downloader service will add the Sunday subfolder automatically
    return library.clipsFolderPath;
  }

  /**
   * Lifecycle hook - called when the module is being destroyed
   * Clears all queues on application shutdown
   */
  onModuleDestroy() {
    // Stop the watchdog
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }

    // Mark all pending and processing jobs as failed
    for (const job of this.jobQueue.values()) {
      if (job.status === 'pending' || job.status === 'processing') {
        job.status = 'failed';
        job.error = 'Application shutdown - job cancelled';
      }
    }

    // Clear the queue and pools
    this.jobQueue.clear();
    this.mainPool.clear();
    this.aiPool = null;

    // Reset processing flag
    this.processing = false;
  }

  /**
   * Add a job to the queue
   */
  addJob(job: Omit<QueueJob, 'id' | 'createdAt' | 'status' | 'progress' | 'currentPhase' | 'currentTaskIndex'>, options?: { paused?: boolean }): string {
    const jobId = uuidv4();
    const paused = options?.paused ?? false;

    const fullJob: QueueJob = {
      ...job,
      id: jobId,
      status: paused ? 'paused' : 'pending',
      progress: 0,
      currentPhase: paused ? 'Paused — waiting to start' : 'Waiting in queue...',
      currentTaskIndex: 0,
      createdAt: new Date(),
    };

    // Add to unified queue
    this.jobQueue.set(jobId, fullJob);

    this.logger.log(`Added job ${jobId} with ${job.tasks.length} tasks${paused ? ' (paused)' : ''}`);

    // Kick the queue (skip if paused)
    if (!paused) {
      setImmediate(() => this.processQueue());
    }

    return jobId;
  }

  /**
   * Start one or more paused jobs — sets status to 'pending' and kicks the queue
   */
  startJobs(jobIds: string[]): number {
    let startedCount = 0;
    for (const jobId of jobIds) {
      const job = this.jobQueue.get(jobId);
      if (job && job.status === 'paused') {
        job.status = 'pending';
        job.currentPhase = 'Waiting in queue...';
        startedCount++;
        this.logger.log(`Started paused job ${jobId}`);
      }
    }
    if (startedCount > 0) {
      setImmediate(() => this.processQueue());
    }
    return startedCount;
  }

  /**
   * Get job by ID
   */
  getJob(jobId: string): QueueJob | undefined {
    return this.jobQueue.get(jobId);
  }

  /**
   * Get all jobs in the queue
   */
  getAllJobs(): QueueJob[] {
    return Array.from(this.jobQueue.values());
  }

  /**
   * Get main pool status (for API/monitoring)
   */
  getMainPool(): Map<string, ActiveTask> {
    return this.mainPool;
  }

  /**
   * Get AI pool status (for API/monitoring)
   */
  getAIPool(): ActiveTask | null {
    return this.aiPool;
  }

  /**
   * True when any task is currently running in either pool. Used to block
   * external library switch/transfer while a task could be mid-await (which
   * would swap the shared DB connection out from under it).
   */
  hasActiveTasks(): boolean {
    return this.mainPool.size > 0 || !!this.aiPool;
  }

  /**
   * Delete a job
   */
  deleteJob(jobId: string): boolean {
    const deleted = this.jobQueue.delete(jobId);
    if (deleted) {
      this.logger.log(`Deleted job ${jobId}`);
    }
    return deleted;
  }

  /**
   * Cancel a job
   */
  cancelJob(jobId: string): boolean {
    const job = this.getJob(jobId);
    if (!job || job.status === 'completed' || job.status === 'failed') {
      return false;
    }

    // Add to cancelled set so running tasks can check
    this.cancelledJobs.add(jobId);

    // Abort the running child process (download/transcode/transcription) so it
    // stops immediately instead of running to completion. Look the active task
    // up BEFORE freeing the slot below so we still know it's ours to abort.
    const active = this.mainPool.get(jobId) ?? (this.aiPool?.jobId === jobId ? this.aiPool : undefined);
    if (active) {
      this.abortActiveTask(active);
    }

    job.status = 'cancelled';
    job.error = 'Cancelled by user';
    job.completedAt = new Date();

    // Remove from pools if active
    this.mainPool.delete(jobId);
    if (this.aiPool?.jobId === jobId) {
      this.aiPool = null;
    }

    this.logger.log(`Cancelled job ${jobId}`);

    // Emit cancellation event
    this.eventService.emit('job.cancelled', {
      jobId,
      videoId: job.videoId,
      timestamp: new Date().toISOString(),
    });

    return true;
  }

  /**
   * Check if a job has been cancelled
   */
  isJobCancelled(jobId: string): boolean {
    return this.cancelledJobs.has(jobId);
  }

  /**
   * Clear completed/failed jobs
   */
  clearCompletedJobs(): void {
    for (const [jobId, job] of this.jobQueue.entries()) {
      if (job.status === 'completed' || job.status === 'failed') {
        this.jobQueue.delete(jobId);
      }
    }

    this.logger.log('Cleared completed/failed jobs');
  }

  /**
   * Get unified queue status
   */
  getQueueStatus() {
    const jobs = Array.from(this.jobQueue.values());

    return {
      mainPool: {
        active: this.mainPool.size,
        maxConcurrent: this.MAX_MAIN_CONCURRENT,
        tasks: Array.from(this.mainPool.values()),
      },
      aiPool: {
        active: this.aiPool ? 1 : 0,
        maxConcurrent: this.MAX_AI_CONCURRENT,
        task: this.aiPool,
      },
      queue: {
        total: jobs.length,
        paused: jobs.filter(j => j.status === 'paused').length,
        pending: jobs.filter(j => j.status === 'pending').length,
        processing: jobs.filter(j => j.status === 'processing').length,
        completed: jobs.filter(j => j.status === 'completed').length,
        failed: jobs.filter(j => j.status === 'failed').length,
      },
    };
  }


  /**
   * Unified queue processing with 5+1 pool model.
   * Event-driven: called when jobs are added or tasks complete.
   * Each call fills available pool slots with the next eligible tasks.
   * No polling loop — executeTask's finally block re-triggers this.
   */
  private processQueue(): void {
    // Fill main pool (up to 5 concurrent tasks)
    let dispatched = 0;
    while (this.mainPool.size < this.MAX_MAIN_CONCURRENT) {
      const nextTask = this.getNextMainTask();
      if (!nextTask) break;

      this.executeTask(nextTask, 'main').catch(err => {
        this.logger.error(`Main pool task failed: ${err?.message || err}`);
      });
      dispatched++;
    }

    // Fill AI pool (up to 1 concurrent task)
    if (!this.aiPool) {
      const nextTask = this.getNextAITask();
      if (nextTask) {
        this.executeTask(nextTask, 'ai').catch(err => {
          this.logger.error(`AI pool task failed: ${err?.message || err}`);
        });
        dispatched++;
      }
    }

  }

  /**
   * The library all in-flight tasks (both pools) currently operate on, or
   * undefined when nothing is running. Every in-flight task shares one library
   * because canStartJobLibrary refuses to start a task for a different one.
   */
  private getInFlightLibraryId(): string | undefined {
    const first = this.mainPool.values().next().value as ActiveTask | undefined;
    if (first) return first.libraryId;
    return this.aiPool?.libraryId;
  }

  /**
   * Whether a job may start now without switching the shared DB connection out
   * from under a task already running against a different library. When nothing
   * is running, any library is safe to switch to. Otherwise the job must target
   * the in-flight library (the common single-library case always passes); a job
   * for another library waits until both pools drain.
   */
  private canStartJobLibrary(job: QueueJob): boolean {
    if (this.mainPool.size === 0 && !this.aiPool) {
      return true;
    }
    const target = job.libraryId ?? this.libraryManager.getActiveLibrary()?.id;
    return target === this.getInFlightLibraryId();
  }

  /**
   * Get next non-AI task from any job
   */
  private getNextMainTask(): { task: Task; job: QueueJob } | null {
    for (const job of this.jobQueue.values()) {
      if (job.status !== 'pending' && job.status !== 'processing') continue;

      // Don't start a task that would switch the shared DB connection out from
      // under a task already running against a different library.
      if (!this.canStartJobLibrary(job)) continue;

      const currentTask = job.tasks[job.currentTaskIndex];
      if (!currentTask) {
        this.logger.warn(`getNextMainTask: job ${job.id} has no task at index ${job.currentTaskIndex} (tasks length: ${job.tasks.length})`);
        continue;
      }

      // Skip if this task is already running
      if (this.isTaskRunning(job.id, job.currentTaskIndex)) continue;

      // Check if any previous task in this job is still running
      // Tasks must be sequential within a job
      let previousTaskRunning = false;
      for (let i = 0; i < job.currentTaskIndex; i++) {
        if (this.isTaskRunning(job.id, i)) {
          previousTaskRunning = true;
          break;
        }
      }
      if (previousTaskRunning) {
        continue; // Wait for previous tasks to complete
      }

      // Only return non-AI tasks
      if (currentTask.type !== 'analyze' && currentTask.type !== 'analyze-webpage') {
        return { task: currentTask, job };
      }
    }
    return null;
  }

  /**
   * Get next AI task from any job
   */
  private getNextAITask(): { task: Task; job: QueueJob } | null {
    this.logger.debug(`getNextAITask: Checking ${this.jobQueue.size} jobs`);
    for (const job of this.jobQueue.values()) {
      if (job.status !== 'pending' && job.status !== 'processing') continue;

      // Don't start a task that would switch the shared DB connection out from
      // under a task already running against a different library.
      if (!this.canStartJobLibrary(job)) continue;

      const currentTask = job.tasks[job.currentTaskIndex];
      this.logger.debug(`getNextAITask: Job ${job.id} currentTaskIndex=${job.currentTaskIndex}, task=${currentTask?.type}`);
      if (!currentTask) continue;

      if (this.isTaskRunning(job.id, job.currentTaskIndex)) continue;

      // Only return AI tasks
      if (currentTask.type === 'analyze' || currentTask.type === 'analyze-webpage') {
        this.logger.log(`getNextAITask: Found ${currentTask.type} task for job ${job.id}`);
        // Check if any previous task in this job is still running
        // Tasks must be sequential within a job
        let previousTaskRunning = false;
        for (let i = 0; i < job.currentTaskIndex; i++) {
          if (this.isTaskRunning(job.id, i)) {
            previousTaskRunning = true;
            break;
          }
        }

        if (previousTaskRunning) {
          continue; // Wait for previous tasks to complete
        }

        return { task: currentTask, job };
      }
    }
    return null;
  }

  /**
   * Check if a specific task is already running
   */
  private isTaskRunning(jobId: string, taskIndex: number): boolean {
    // Check main pool
    for (const activeTask of this.mainPool.values()) {
      if (activeTask.jobId === jobId && activeTask.taskIndex === taskIndex) {
        return true;
      }
    }

    // Check AI pool
    if (this.aiPool?.jobId === jobId && this.aiPool.taskIndex === taskIndex) {
      return true;
    }

    return false;
  }

  /**
   * Execute a task in the appropriate pool
   */
  private async executeTask(
    { task, job }: { task: Task; job: QueueJob },
    pool: 'main' | 'ai',
  ): Promise<void> {
    // Check if job was cancelled before starting
    if (this.isJobCancelled(job.id)) {
      this.logger.log(`Job ${job.id} was cancelled, skipping task ${task.type}`);
      // Clean up cancelled job from set after acknowledging
      this.cancelledJobs.delete(job.id);
      this.processQueue();
      return;
    }

    // Use job.id for progress tracking so frontend can map it correctly
    const taskId = job.id;
    const now = new Date();
    const activeTask: ActiveTask = {
      taskId,
      jobId: job.id,
      taskIndex: job.currentTaskIndex,
      type: task.type,
      pool,
      libraryId: job.libraryId ?? this.libraryManager.getActiveLibrary()?.id,
      progress: 0,
      message: 'Starting...',
      startedAt: now,
      lastProgressAt: now,
    };

    // IMPORTANT: Register in pool SYNCHRONOUSLY before any async work.
    // This prevents processQueue's inner while loop from dispatching the
    // same task again while we await the library switch below.
    if (pool === 'main') {
      this.mainPool.set(taskId, activeTask);
    } else {
      this.aiPool = activeTask;
    }

    // Update job status
    if (job.status === 'pending') {
      job.status = 'processing';
      job.startedAt = new Date();
    }

    try {
      // Ensure correct library is active for this job (all tasks need the right DB context)
      if (job.libraryId) {
        const currentLibrary = this.libraryManager.getActiveLibrary();
        if (!currentLibrary || currentLibrary.id !== job.libraryId) {
          this.logger.log(`[${job.id}] Switching to target library: ${job.libraryId} for task ${task.type}`);
          await this.libraryManager.switchLibrary(job.libraryId);
        }
      }

      job.currentPhase = `${task.type} (${job.currentTaskIndex + 1}/${job.tasks.length})`;

      this.logger.log(
        `[${pool.toUpperCase()} POOL] Starting task ${taskId}: ${task.type} for job ${job.id}`,
      );

      // Emit task started event
      this.eventService.emit('task.started', {
        taskId,
        jobId: job.id,
        videoId: job.videoId,
        type: task.type,
        pool,
        timestamp: new Date().toISOString(),
      });

      // Execute the task
      const result = await this.executeTaskLogic(job, task, taskId);

      // If the watchdog force-failed this task while we were awaiting, it has
      // already finalized the job and freed the slot. Don't double-finalize.
      if (activeTask.abandoned) {
        this.logger.warn(`Task ${taskId} completed after being abandoned by the watchdog; ignoring late result`);
        return;
      }

      // Check if job was cancelled during execution
      if (this.isJobCancelled(job.id)) {
        this.logger.log(`Job ${job.id} was cancelled during ${task.type} execution`);
        this.cancelledJobs.delete(job.id);
        // Don't process results - just clean up and return
        return;
      }

      if (!result.success) {
        throw new Error(result.error || 'Task failed');
      }

      // Collect non-fatal degradations onto the job so the UI can surface them.
      if (result.warnings && result.warnings.length > 0) {
        job.warnings = [...(job.warnings ?? []), ...result.warnings];
        for (const warning of result.warnings) {
          this.logger.warn(`[${taskId}] Task warning: ${warning}`);
        }
      }

      // Update last_processed_date for tasks that process the video
      // (not for get-info or download which don't have a video ID yet)
      const processingTasks = ['import', 'transcribe', 'analyze', 'analyze-webpage', 'fix-aspect-ratio', 'strip-black-bars', 'normalize-audio', 'process-video'];
      if (job.videoId && processingTasks.includes(task.type)) {
        try {
          this.databaseService.updateLastProcessedDate(job.videoId);
        } catch (err) {
          this.logger.warn(`Failed to update last_processed_date for video ${job.videoId}: ${err}`);
        }
      }

      // Regenerate thumbnail after file-modifying tasks
      const thumbnailRegenTasks = ['fix-aspect-ratio', 'strip-black-bars', 'normalize-audio', 'process-video'];
      if (job.videoId && thumbnailRegenTasks.includes(task.type) && job.videoPath) {
        await this.mediaOps.regenerateThumbnail(job.videoId, job.videoPath);
        // Re-probe and update stored width/height/fps after a file-modifying task.
        // fix-aspect-ratio / strip-black-bars change the dimensions; without this
        // the DB keeps the pre-processing geometry and the geometry-based
        // aspect-ratio skip would re-process a genuinely-fixed video every time.
        try {
          await this.mediaOps.refreshVideoDimensions(job.videoId, job.videoPath, taskId);
        } catch (err) {
          this.logger.warn(`[${taskId}] Failed to refresh video dimensions after ${task.type}: ${err}`);
        }
      }

      // Emit task completed event
      this.eventService.emit('task.completed', {
        taskId,
        jobId: job.id,
        videoId: job.videoId,
        type: task.type,
        result: result.data,
        duration: (Date.now() - activeTask.startedAt.getTime()) / 1000,
        timestamp: new Date().toISOString(),
      });

      // Move to next task in job
      job.currentTaskIndex++;
      job.progress = Math.round((job.currentTaskIndex / job.tasks.length) * 100);

      // Check if job is complete
      if (job.currentTaskIndex >= job.tasks.length) {
        job.status = 'completed';
        job.progress = 100;
        job.currentPhase = 'Completed';
        job.completedAt = new Date();

        this.logger.log(`Job ${job.id} completed successfully`);

        // Emit job completed event for in-process listeners (via EventEmitter2)
        const eventData = {
          jobId: job.id,
          status: 'completed',
          downloadedPath: job.videoPath,
        };
        this.logger.log(`Emitting job.completed event: ${JSON.stringify(eventData)}`);
        this.eventEmitter.emit('job.completed', eventData);

        // Remove from queue after a delay
        setTimeout(() => this.jobQueue.delete(job.id), 5000);
      }
    } catch (error) {
      // If the throw was caused by a user cancellation (the abort makes the
      // media op reject), don't report it as a failure. cancelJob already set
      // status='cancelled' and emitted job.cancelled; just clean up the
      // cancelled-set entry (avoid a Set leak) and fall through to the finally.
      if (this.isJobCancelled(job.id)) {
        this.logger.log(`Job ${job.id} was cancelled during ${task.type} execution (caught abort)`);
        this.cancelledJobs.delete(job.id);
        return;
      }

      // If the watchdog already force-failed and finalized this task, don't emit
      // a second failure or clobber state — just fall through to the finally.
      if (activeTask.abandoned) {
        this.logger.warn(`Task ${taskId} threw after being abandoned by the watchdog; suppressing duplicate failure`);
      } else {
        // Task failed
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : 'Unknown error';
        job.completedAt = new Date();

        this.logger.error(`Task ${taskId} failed: ${job.error}`);

        // Emit task failed event on both buses (Socket.IO + EventEmitter2)
        this.emitTaskFailed({
          taskId,
          jobId: job.id,
          videoId: job.videoId,
          type: task.type,
          message: job.error,
        });

        // Remove failed job from queue after a delay (like completed jobs)
        // This ensures the UI can show the failure state before removal
        setTimeout(() => {
          this.jobQueue.delete(job.id);
          this.logger.log(`Removed failed job ${job.id} from queue`);
        }, 5000);
      }
    } finally {
      // Remove from pool, but only if THIS task still owns the slot. The watchdog
      // may have already reclaimed it and started a different task there; clearing
      // unconditionally would clobber that newer task's slot tracking.
      if (pool === 'main') {
        if (this.mainPool.get(taskId) === activeTask) {
          this.mainPool.delete(taskId);
        }
      } else if (this.aiPool === activeTask) {
        this.aiPool = null;
      }

      // Dispatch next tasks
      this.processQueue();
    }
  }

  /**
   * Execute task logic and update database flags
   */
  private async executeTaskLogic(
    job: QueueJob,
    task: Task,
    taskId: string,
  ): Promise<TaskResult> {
    let result: TaskResult;

    switch (task.type) {
      case 'get-info':
        if (!job.url) {
          return { success: false, error: 'No URL provided for get-info task' };
        }
        result = await this.mediaOps.getVideoInfo(job.url, taskId);
        if (result.success && result.data) {
          job.videoInfo = result.data;
          job.displayName = job.displayName || result.data.title;
        }
        break;

      case 'download':
        if (!job.url) {
          return { success: false, error: 'No URL provided for download task' };
        }

        // Check for duplicate: does a video with this source URL already exist?
        const existingVideo = this.databaseService.findVideoByUrl(job.url);
        if (existingVideo && existingVideo.current_path) {
          const existingPath = existingVideo.current_path;
          const fileExists = fs.existsSync(existingPath);

          if (fileExists) {
            this.logger.log(`[${taskId}] Duplicate detected: video with URL "${job.url}" already exists at "${existingPath}" (id: ${existingVideo.id})`);

            // Use existing file path and video ID - skip actual download
            job.videoPath = existingPath;
            job.videoId = existingVideo.id;
            job.displayName = job.displayName || existingVideo.filename;

            // Update download_date to current so it appears recent
            this.databaseService.updateVideoMetadata(
              existingVideo.id,
              undefined,  // uploadDate
              new Date().toISOString(),  // downloadDate
            );

            // Mark remaining tasks that already have results as skippable
            // by setting videoId so import task can be skipped
            result = {
              success: true,
              data: {
                videoPath: existingPath,
                title: existingVideo.filename,
                duplicate: true,
                existingVideoId: existingVideo.id,
              },
            };
            break;
          } else {
            this.logger.log(`[${taskId}] Found DB entry for URL "${job.url}" but file missing at "${existingPath}" - proceeding with download`);
          }
        }

        // Determine output directory based on library
        const outputDir = this.getDownloadOutputDir(job.libraryId);
        if (outputDir) {
          this.logger.log(`[${taskId}] Download output directory: ${outputDir}`);
        }

        result = await this.mediaOps.downloadVideo(
          job.url,
          {
            ...task.options,
            displayName: job.displayName,
            outputDir: outputDir,
          },
          taskId,
        );
        if (result.success && result.data) {
          job.videoPath = result.data.videoPath;
          job.displayName = job.displayName || result.data.title;
        }
        break;

      case 'import':
        // If videoId is already set (e.g., from duplicate detection), skip import
        if (job.videoId) {
          this.logger.log(`[${taskId}] Skipping import - video already exists in library (id: ${job.videoId})`);
          result = { success: true, data: { videoId: job.videoId, skipped: true } };
          break;
        }

        if (!job.videoPath) {
          return { success: false, error: 'No video path available for import task' };
        }

        result = await this.mediaOps.importToLibrary(job.videoPath, task.options, taskId);
        if (result.success && result.data) {
          job.videoId = result.data.videoId;

          // Persist the source URL for downloaded videos so future downloads of
          // the same URL are deduped by findVideoByUrl (the import chain never
          // sets source_url, so URL-based dedup would otherwise never match).
          if (job.url && job.videoId) {
            try {
              this.databaseService.updateVideoSourceUrl(job.videoId, job.url);
            } catch (err) {
              this.logger.warn(`[${taskId}] Failed to persist source_url for video ${job.videoId}: ${err}`);
            }
          }
        }
        break;

      case 'fix-aspect-ratio':
        if (!job.videoId && !job.videoPath) {
          return {
            success: false,
            error: 'No video ID or path available for fix-aspect-ratio task',
          };
        }
        // Skip ONLY when the video is already ~16:9 by its actual dimensions.
        // The aspect_ratio_fixed flag alone is NOT trustworthy: videos were found
        // flagged=1 while still vertical (a past run set the flag without the file
        // being converted, or the file was later re-downloaded). Trusting the flag
        // permanently blocked the fix ("instantly finished, no change"). Decide by
        // geometry, matching the HTTP /fix-aspect-ratio endpoint. Stored dimensions
        // are refreshed after every file-modifying task (see post-task hook), so a
        // genuinely fixed video reads as 16:9 here and is correctly skipped.
        if (job.videoId) {
          const videoForAR = this.databaseService.findVideoById(job.videoId) as any;
          if (videoForAR) {
            const w = Number(videoForAR.width);
            const h = Number(videoForAR.height);
            const isSixteenNine = w > 0 && h > 0 && Math.abs(w / h - 16 / 9) <= 0.01;
            if (isSixteenNine) {
              this.logger.log(`[${taskId}] Skipping fix-aspect-ratio - already 16:9 (${w}x${h}, id: ${job.videoId})`);
              result = { success: true, data: { skipped: true } };
              break;
            }
            if (videoForAR.aspect_ratio_fixed) {
              this.logger.warn(`[${taskId}] aspect_ratio_fixed=1 but dimensions are ${w}x${h} (not 16:9) — stale flag, re-processing (id: ${job.videoId})`);
            }
          }
        }
        result = await this.mediaOps.fixAspectRatio(
          job.videoId || job.videoPath!,
          task.options,
          taskId,
        );
        if (result.success && result.data && result.data.outputPath) {
          job.videoPath = result.data.outputPath;
        }
        // UPDATE DATABASE FLAG — a failed flag write fails the task: the video
        // was re-encoded but skip-detection would re-encode it again on every
        // future run (fallback audit #5).
        if (result.success && job.videoId) {
          try {
            await this.mediaOps.setVideoFlag(job.videoId, 'aspect_ratio_fixed', 1);
          } catch (error) {
            return {
              success: false,
              error: `Aspect ratio was fixed, but recording that on video ${job.videoId} failed (${error instanceof Error ? error.message : 'Unknown error'}). Without the flag the video would be re-encoded on every future run — fix the database issue and re-run.`,
            };
          }
        }
        break;

      case 'strip-black-bars':
        if (!job.videoId && !job.videoPath) {
          return {
            success: false,
            error: 'No video ID or path available for strip-black-bars task',
          };
        }
        result = await this.executeStripBlackBars(job, taskId);
        break;

      case 'normalize-audio':
        if (!job.videoId && !job.videoPath) {
          return {
            success: false,
            error: 'No video ID or path available for normalize-audio task',
          };
        }
        // Skip if already normalized (duplicate detection)
        if (job.videoId) {
          const videoForAN = this.databaseService.findVideoById(job.videoId);
          if (videoForAN && videoForAN.audio_normalized) {
            this.logger.log(`[${taskId}] Skipping normalize-audio - already normalized (id: ${job.videoId})`);
            result = { success: true, data: { skipped: true } };
            break;
          }
        }
        result = await this.mediaOps.normalizeAudio(
          job.videoId || job.videoPath!,
          task.options,
          taskId,
        );
        if (result.success && result.data && result.data.outputPath) {
          job.videoPath = result.data.outputPath;
        }
        // UPDATE DATABASE FLAG — failure fails the task (see aspect-ratio note).
        if (result.success && job.videoId) {
          try {
            await this.mediaOps.setVideoFlag(job.videoId, 'audio_normalized', 1);
          } catch (error) {
            return {
              success: false,
              error: `Audio was normalized, but recording that on video ${job.videoId} failed (${error instanceof Error ? error.message : 'Unknown error'}). Without the flag the video would be re-processed on every future run — fix the database issue and re-run.`,
            };
          }
        }
        break;

      case 'process-video':
        if (!job.videoId && !job.videoPath) {
          return {
            success: false,
            error: 'No video ID or path available for process-video task',
          };
        }
        result = await this.mediaOps.processVideo(
          job.videoId || job.videoPath!,
          task.options,
          taskId,
        );
        if (result.success && result.data && result.data.outputPath) {
          job.videoPath = result.data.outputPath;
        }
        // UPDATE DATABASE FLAGS based on what was processed — failure fails
        // the task (see aspect-ratio note).
        if (result.success && job.videoId && task.options) {
          try {
            if (task.options.fixAspectRatio) {
              await this.mediaOps.setVideoFlag(job.videoId, 'aspect_ratio_fixed', 1);
            }
            if (task.options.normalizeAudio) {
              await this.mediaOps.setVideoFlag(job.videoId, 'audio_normalized', 1);
            }
          } catch (error) {
            return {
              success: false,
              error: `Video was processed, but recording the done-flags on video ${job.videoId} failed (${error instanceof Error ? error.message : 'Unknown error'}). Without them the video would be re-encoded on every future run — fix the database issue and re-run.`,
            };
          }
        }
        break;

      case 'transcribe':
        if (!job.videoId && !job.videoPath) {
          return { success: false, error: 'No video ID or path available for transcribe task' };
        }

        // Clear existing transcript if one exists (user explicitly queued a new transcription)
        if (job.videoId) {
          const existingTranscript = this.databaseService.getTranscript(job.videoId);
          if (existingTranscript) {
            this.logger.log(`[${taskId}] Clearing existing transcript before re-transcribing (id: ${job.videoId})`);
            this.databaseService.deleteTranscript(job.videoId);
          }
        }

        result = await this.mediaOps.transcribeVideo(
          job.videoId || job.videoPath!,
          task.options,
          taskId,
        );
        if (result.success && result.data) {
          job.transcriptPath = result.data.transcriptPath;
        }
        // Note: has_transcript flag is automatically set by database trigger
        break;

      case 'analyze':
        if (!job.videoId) {
          return { success: false, error: 'No video ID available for analyze task' };
        }
        if (!task.options || !task.options.aiModel) {
          return { success: false, error: 'AI model is required for analyze task' };
        }

        // Always run analysis — if the video already has one, mediaOps.analyzeVideo
        // will clear it before re-running (via processAnalyzePhase cleanup logic)
        result = await this.mediaOps.analyzeVideo(job.videoId, task.options as any, taskId);
        if (result.success && result.data) {
          job.analysisPath = result.data.analysisPath;
        }
        // Note: has_analysis flag is automatically set by database trigger
        break;

      case 'analyze-webpage':
        if (!job.videoId) {
          return { success: false, error: 'No video ID available for analyze-webpage task' };
        }
        if (!task.options || !task.options.aiModel) {
          return { success: false, error: 'AI model is required for analyze-webpage task' };
        }
        result = await this.mediaOps.analyzeWebpage(job.videoId, task.options as any, taskId);
        break;

      case 'export-clip':
        result = await this.executeExportClip(job, task, taskId);
        break;

      default:
        return { success: false, error: `Unknown task type: ${(task as any).type}` };
    }

    return result;
  }

  /**
   * Execute strip-black-bars: crop center 9:16 portrait, blur-fill to 16:9, overwrite original
   */
  private async executeStripBlackBars(
    job: QueueJob,
    taskId: string,
  ): Promise<TaskResult> {
    try {
      const videoId = job.videoId;
      if (!videoId) {
        return { success: false, error: 'No video ID for strip-black-bars' };
      }

      const video = this.databaseService.getVideoById(videoId);
      if (!video) {
        return { success: false, error: `Video not found: ${videoId}` };
      }

      const videoPath = video.current_path as string;
      if (!videoPath || !fs.existsSync(videoPath)) {
        return { success: false, error: `Video file not found: ${videoPath}` };
      }

      this.logger.log(`[STRIP-BARS] Processing: ${videoPath}`);
      this.eventService.emitTaskProgress(taskId, 'strip-black-bars', 0, 'Starting strip bars...');
      this.updateTaskProgress(taskId, 0, 'Starting strip bars...');

      // Extract to temp file with strip-black-bars filter
      const tempDir = os.tmpdir();
      const originalExt = path.extname(videoPath);
      const tempPath = path.join(tempDir, `briefcase_strip_${Date.now()}${originalExt}`);

      const extractionResult = await this.clipExtractor.extractClip({
        videoPath,
        startTime: null,
        endTime: null,
        outputPath: tempPath,
        reEncode: true,
        quality: 'high',
        stripBlackBars: true,
        onProgress: (progress: number) => {
          const scaled = Math.round(progress * 0.8);
          this.eventService.emitTaskProgress(taskId, 'strip-black-bars', scaled, `Processing... ${progress}%`);
          this.updateTaskProgress(taskId, scaled, `Processing... ${progress}%`);
        },
      });

      if (!extractionResult.success) {
        try { fs.unlinkSync(tempPath); } catch (_) {}
        return { success: false, error: extractionResult.error || 'Strip bars failed' };
      }

      // Replace original file atomically. NEVER unlink the original before the
      // replacement is safely in place — a crash between unlink and copy would
      // destroy irreplaceable media. atomicReplaceFile copies the temp into a
      // sibling in the destination dir, then renames over the original.
      this.eventService.emitTaskProgress(taskId, 'strip-black-bars', 85, 'Replacing original...');
      this.updateTaskProgress(taskId, 85, 'Replacing original...');
      atomicReplaceFile(tempPath, videoPath);

      // Update file size and hash in database
      this.eventService.emitTaskProgress(taskId, 'strip-black-bars', 90, 'Updating metadata...');
      this.updateTaskProgress(taskId, 90, 'Updating metadata...');
      // Recompute the identity metadata from the NEW file and write it. The
      // on-disk file has already been atomically swapped above, so the DB row
      // MUST be updated to describe the new file: file_hash is the app's
      // dedup/identity key and a stale hash silently corrupts dedup. We do NOT
      // swallow a failure here (the old behavior only warned, leaving the row
      // describing the OLD file while the bytes on disk are the NEW file) — the
      // swap itself succeeded and is correct, but an un-reconciled row is a real
      // integrity error, so we surface it as a failed task. Never fall back to
      // leaving the old identity in place.
      try {
        const stats = fs.statSync(videoPath);
        const newHash = await this.fileScannerService.quickHashFile(videoPath, stats.size);
        const newDuration = extractionResult.duration || 0;
        const db = this.databaseService.getDatabase();
        db.prepare(
          `UPDATE videos SET duration_seconds = ?, file_size_bytes = ?, file_hash = ?, last_processed_date = ? WHERE id = ?`
        ).run(newDuration, stats.size, newHash, new Date().toISOString(), videoId);
      } catch (err) {
        throw new Error(
          `Strip-black-bars swapped the file but FAILED to update its identity metadata ` +
          `(file_hash/size/duration) for video ${videoId}: ${(err as Error).message}. The ` +
          `on-disk file is the new stripped file; the DB row still describes the OLD file and ` +
          `must be re-scanned/re-hashed.`,
        );
      }

      // Regenerate thumbnail
      this.eventService.emitTaskProgress(taskId, 'strip-black-bars', 95, 'Regenerating thumbnail...');
      this.updateTaskProgress(taskId, 95, 'Regenerating thumbnail...');
      try {
        await this.mediaOps.regenerateThumbnail(videoId, videoPath);
      } catch (err) {
        this.logger.warn(`[STRIP-BARS] Thumbnail regen failed (non-fatal): ${(err as Error).message}`);
      }

      // Notify frontends
      this.eventService.emitVideoPathUpdated(videoId, videoPath, videoPath);

      this.eventService.emitTaskProgress(taskId, 'strip-black-bars', 100, 'Strip bars complete');
      this.updateTaskProgress(taskId, 100, 'Strip bars complete');
      this.logger.log(`[STRIP-BARS] Complete: ${videoPath}`);

      return { success: true, data: { outputPath: videoPath } };
    } catch (error) {
      this.logger.error(`[STRIP-BARS] Error: ${(error as Error).message}`);
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Execute export-clip task logic
   * Replicates the flow from LibraryController.extractClipFromPath() / overwriteVideoWithClip()
   */
  private async executeExportClip(
    job: QueueJob,
    task: Task,
    taskId: string,
  ): Promise<TaskResult> {
    const opts = task.options as any;

    // Non-fatal degradations surfaced on the job (task still succeeds).
    const exportWarnings: string[] = [];

    // Fallback: resolve videoPath/videoId from the job context if not in task options
    // (e.g., trim-opener injects export-clip before videoPath is known at queue time)
    if (!opts.videoPath && job.videoPath) opts.videoPath = job.videoPath;
    if (!opts.videoId && job.videoId) opts.videoId = job.videoId;

    this.logger.log(`[EXPORT-CLIP] ========== Starting export-clip task ==========`);
    this.logger.log(`[EXPORT-CLIP] Job ID: ${job.id}`);
    this.logger.log(`[EXPORT-CLIP] Video path: ${opts?.videoPath}`);
    this.logger.log(`[EXPORT-CLIP] Time range: ${opts?.startTime} - ${opts?.endTime}`);
    this.logger.log(`[EXPORT-CLIP] Re-encode: ${opts?.reEncode}`);
    this.logger.log(`[EXPORT-CLIP] Quality: ${opts?.quality || 'medium'}`);
    this.logger.log(`[EXPORT-CLIP] Title: ${opts?.title || opts?.description || '(none)'}`);
    this.logger.log(`[EXPORT-CLIP] Category: ${opts?.category || '(none)'}`);
    this.logger.log(`[EXPORT-CLIP] Custom directory: ${opts?.customDirectory || '(default)'}`);
    this.logger.log(`[EXPORT-CLIP] Scale: ${opts?.scale || '1.0 (none)'}`);
    this.logger.log(`[EXPORT-CLIP] Mute sections: ${opts?.muteSections?.length || 0}`);
    this.logger.log(`[EXPORT-CLIP] Crop aspect ratio: ${opts?.cropAspectRatio || '(none)'}`);
    this.logger.log(`[EXPORT-CLIP] Output suffix: ${opts?.outputSuffix || '(none)'}`);
    this.logger.log(`[EXPORT-CLIP] Overwrite mode: ${opts?.isOverwrite || false}`);

    if (!opts || !opts.videoPath) {
      this.logger.error(`[EXPORT-CLIP] FAILED: No videoPath provided`);
      return { success: false, error: 'No videoPath provided for export-clip task' };
    }

    if (!fs.existsSync(opts.videoPath)) {
      this.logger.error(`[EXPORT-CLIP] FAILED: Video file not found at ${opts.videoPath}`);
      return { success: false, error: `Video file not found: ${opts.videoPath}` };
    }

    // Overwrite mode: extract to temp, replace original, clear metadata
    if (opts.isOverwrite && opts.videoId) {
      this.logger.log(`[EXPORT-CLIP] Using OVERWRITE mode for video ${opts.videoId}`);
      return this.executeExportClipOverwrite(opts, taskId);
    }

    // Regular export mode
    this.logger.log(`[EXPORT-CLIP] Using regular export mode`);
    try {
      // Find parent video for linking
      let parentVideoId: string | undefined;
      try {
        const allVideos = this.databaseService.getAllVideos({ includeChildren: true });
        const clipsRoot = this.libraryService.getLibraryPaths().clipsDir;
        const normalizedVideoPath = path.normalize(opts.videoPath);

        const sourceVideo = allVideos.find((v: any) => {
          if (!v.current_path) return false;
          const dbAbsolutePath = this.databaseService.toAbsolutePath(String(v.current_path), clipsRoot);
          return path.normalize(dbAbsolutePath) === normalizedVideoPath;
        });

        if (sourceVideo && sourceVideo.id) {
          if (sourceVideo.parent_id) {
            // Source is already a child clip — don't create nested children
            this.logger.log(`[EXPORT-CLIP] Source video is a child clip — skipping parent linking`);
          } else {
            parentVideoId = String(sourceVideo.id);
            this.logger.log(`[EXPORT-CLIP] Source video found — will link as child of: ${parentVideoId}`);
          }
        } else {
          this.logger.log(`[EXPORT-CLIP] No source video found in library for path`);
        }
      } catch (err) {
        // Non-fatal, but surfaced: the clip will export without its
        // connection edge to the source video.
        const warning = `Clip exported without a link to its source video — the source lookup failed (${(err as Error).message}). You can connect them manually from the inspector.`;
        this.logger.warn(`[EXPORT-CLIP] ${warning}`);
        exportWarnings.push(warning);
      }

      // Generate clip filename
      const originalFilename = path.basename(opts.videoPath);
      const parentVideo = parentVideoId
        ? this.databaseService.getVideoById(parentVideoId)
        : null;

      const clipFilename = this.clipExtractor.generateClipFilename(
        originalFilename,
        opts.startTime,
        opts.endTime,
        opts.category,
        opts.description || opts.title,
        parentVideo?.upload_date ?? undefined,
      );
      this.logger.log(`[EXPORT-CLIP] Generated filename: ${clipFilename}`);

      // Determine output directory
      let outputDir: string;
      if (opts.customDirectory) {
        outputDir = opts.customDirectory.replace(/[\\/]+$/, '');
        this.logger.log(`[EXPORT-CLIP] Using custom output directory: ${outputDir}`);
      } else {
        const activeLibrary = this.libraryManager.getActiveLibrary();
        if (!activeLibrary) {
          this.logger.error(`[EXPORT-CLIP] FAILED: No active library`);
          return { success: false, error: 'No active library' };
        }
        const weekFolder = this.getNearestSunday(new Date());
        outputDir = path.join(activeLibrary.clipsFolderPath, weekFolder);
        this.logger.log(`[EXPORT-CLIP] Using weekly folder: ${outputDir}`);
      }

      // Ensure output directory exists
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
        this.logger.log(`[EXPORT-CLIP] Created output directory`);
      }

      const outputPath = path.join(outputDir, clipFilename);
      this.logger.log(`[EXPORT-CLIP] Full output path: ${outputPath}`);

      // Emit initial progress
      this.eventService.emitTaskProgress(taskId, 'export-clip', 0, 'Starting export...');
      this.updateTaskProgress(job.id, 0, 'Starting export...');
      this.logger.log(`[EXPORT-CLIP] Starting FFmpeg extraction (reEncode=${opts.reEncode})...`);

      // Extract the clip with progress
      const extractionResult = await this.clipExtractor.extractClip({
        videoPath: opts.videoPath,
        startTime: opts.startTime,
        endTime: opts.endTime,
        trimEndSeconds: opts.trimEndSeconds,
        outputPath,
        reEncode: opts.reEncode,
        quality: opts.quality || 'medium',
        scale: opts.scale,
        cropAspectRatio: opts.cropAspectRatio,
        muteSections: opts.muteSections,
        outputSuffix: opts.outputSuffix,
        metadata: {
          title: opts.title,
          description: opts.description,
          category: opts.category,
        },
        onProgress: (progress: number) => {
          const message = `Exporting... ${progress}%`;
          this.eventService.emitTaskProgress(taskId, 'export-clip', progress, message);
          this.updateTaskProgress(job.id, progress, message);
        },
      });

      if (!extractionResult.success) {
        this.logger.error(`[EXPORT-CLIP] FFmpeg extraction FAILED: ${extractionResult.error}`);
        return { success: false, error: extractionResult.error || 'Failed to extract clip' };
      }

      const finalOutputPath = extractionResult.outputPath || outputPath;
      const fileSizeMB = extractionResult.fileSize ? (extractionResult.fileSize / 1024 / 1024).toFixed(2) : '?';
      this.logger.log(`[EXPORT-CLIP] Extraction complete: ${finalOutputPath}`);
      this.logger.log(`[EXPORT-CLIP] Duration: ${extractionResult.duration}s, Size: ${fileSizeMB} MB`);

      // Auto-import the clip into the library. Import failure fails the task:
      // reporting "Export complete" for a clip that never appears in the app
      // is a lie (fallback audit #4). The extracted file stays on disk either
      // way — the error names its path so nothing is lost.
      try {
        this.logger.log(`[EXPORT-CLIP] Auto-importing clip to library...`);
        const importResult = await this.fileScannerService.importVideos(
          [finalOutputPath],
          undefined,
          parentVideoId,
        );

        if (importResult.imported.length > 0) {
          const videoId = importResult.imported[0];
          this.databaseService.updateLastProcessedDate(videoId);
          this.logger.log(`[EXPORT-CLIP] Imported to library as video ID: ${videoId}${parentVideoId ? ` (child of ${parentVideoId})` : ''}`);
        } else if (importResult.skipped.length > 0) {
          // Already in the library (e.g. re-export of an identical clip) — not a failure.
          this.logger.log(`[EXPORT-CLIP] Clip already present in library (skipped by import)`);
        } else {
          const importErrors = importResult.errors.join('; ');
          throw new Error(importErrors || 'import returned no video ID');
        }
      } catch (importError) {
        const message =
          `Clip was extracted to ${finalOutputPath} but could not be imported into the library: ` +
          `${(importError as Error).message}. The file is intact on disk — fix the issue and import it manually.`;
        this.logger.error(`[EXPORT-CLIP] ${message}`);
        return { success: false, error: message };
      }

      this.eventService.emitTaskProgress(taskId, 'export-clip', 100, 'Export complete');
      this.updateTaskProgress(job.id, 100, 'Export complete');
      this.logger.log(`[EXPORT-CLIP] ========== Export complete ==========`);

      return {
        success: true,
        data: {
          outputPath: finalOutputPath,
          duration: extractionResult.duration,
          fileSize: extractionResult.fileSize,
        },
        warnings: exportWarnings.length > 0 ? exportWarnings : undefined,
      };
    } catch (error) {
      this.logger.error(`[EXPORT-CLIP] Unexpected error: ${(error as Error).message}`);
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Handle overwrite mode for export-clip: extract to temp, replace original, clear metadata
   */
  private async executeExportClipOverwrite(
    opts: any,
    taskId: string,
  ): Promise<TaskResult> {
    try {
      this.logger.log(`[EXPORT-CLIP] [OVERWRITE] Looking up video ${opts.videoId}...`);
      const video = this.databaseService.getVideoById(opts.videoId);
      if (!video) {
        this.logger.error(`[EXPORT-CLIP] [OVERWRITE] Video not found in database: ${opts.videoId}`);
        return { success: false, error: 'Video not found in database' };
      }

      this.logger.log(`[EXPORT-CLIP] [OVERWRITE] Preserving original metadata`);
      // Store original metadata to preserve after overwrite
      const originalMetadata = {
        uploadDate: video.upload_date,
        downloadDate: video.download_date,
        addedAt: video.added_at,
        sourceUrl: video.source_url,
        aiDescription: video.ai_description,
        suggestedTitle: video.suggested_title,
      };

      this.eventService.emitTaskProgress(taskId, 'export-clip', 0, 'Extracting to temp file...');
      this.updateTaskProgress(taskId, 0, 'Extracting to temp file...');

      // Create temp file
      const tempDir = os.tmpdir();
      const originalExt = path.extname(opts.videoPath);
      const tempFilename = `briefcase_temp_${Date.now()}${originalExt}`;
      const tempPath = path.join(tempDir, tempFilename);
      this.logger.log(`[EXPORT-CLIP] [OVERWRITE] Extracting to temp: ${tempPath}`);

      // Extract clip to temp
      const extractionResult = await this.clipExtractor.extractClip({
        videoPath: opts.videoPath,
        startTime: opts.startTime,
        endTime: opts.endTime,
        trimEndSeconds: opts.trimEndSeconds,
        outputPath: tempPath,
        reEncode: opts.reEncode || false,
        quality: opts.quality || 'medium',
        scale: opts.scale,
        cropAspectRatio: opts.cropAspectRatio,
        muteSections: opts.muteSections,
        onProgress: (progress: number) => {
          // Scale to 0-80% for extraction phase
          const scaledProgress = Math.round(progress * 0.8);
          const message = `Extracting... ${progress}%`;
          this.eventService.emitTaskProgress(taskId, 'export-clip', scaledProgress, message);
          this.updateTaskProgress(taskId, scaledProgress, message);
        },
      });

      if (!extractionResult.success) {
        this.logger.error(`[EXPORT-CLIP] [OVERWRITE] Extraction FAILED: ${extractionResult.error}`);
        try { fs.unlinkSync(tempPath); } catch (_) {}
        return { success: false, error: extractionResult.error || 'Failed to extract clip' };
      }

      this.logger.log(`[EXPORT-CLIP] [OVERWRITE] Extraction complete, replacing original...`);
      this.eventService.emitTaskProgress(taskId, 'export-clip', 85, 'Replacing original file...');
      this.updateTaskProgress(taskId, 85, 'Replacing original file...');

      // Replace the original atomically. NEVER unlink the original before the
      // replacement is in place — a crash mid-swap would destroy the source video.
      atomicReplaceFile(tempPath, opts.videoPath);
      this.logger.log(`[EXPORT-CLIP] [OVERWRITE] Original replaced`);

      this.logger.log(`[EXPORT-CLIP] [OVERWRITE] Clearing metadata...`);
      this.eventService.emitTaskProgress(taskId, 'export-clip', 90, 'Clearing metadata...');
      this.updateTaskProgress(taskId, 90, 'Clearing metadata...');

      // Recalculate the file hash from the NEW contents BEFORE the DB transaction
      // (hashing is async and cannot run inside a better-sqlite3 transaction).
      // file_hash is the app's dedup/identity key: the file has already been
      // swapped, so the row MUST carry the new hash. We do NOT fall back to
      // leaving the old hash in place (the old behavior swallowed a hashing
      // failure and then silently omitted file_hash from the UPDATE, leaving the
      // row describing the OLD file). The swap itself is correct and intact, but
      // an un-reconciled identity is a real integrity error, so we surface it as
      // a failed task instead.
      let newFileHash: string;
      try {
        const stats = fs.statSync(opts.videoPath);
        newFileHash = await this.fileScannerService.quickHashFile(opts.videoPath, stats.size);
      } catch (err) {
        throw new Error(
          `Export-clip overwrite swapped the file but FAILED to recompute its identity hash ` +
          `for video ${opts.videoId}: ${(err as Error).message}. The on-disk file is the new ` +
          `clip; the DB row still describes the OLD file and must be re-scanned/re-hashed.`,
        );
      }

      // Clear all stale metadata AND update the video record in ONE transaction so
      // we can never leave the row half-cleared (e.g. transcript deleted but the
      // record still flagged has_transcript, or vice-versa).
      const newDuration = extractionResult.duration || 0;
      const db = this.databaseService.getDatabase();
      const nowIso = new Date().toISOString();
      const clearAndUpdate = db.transaction(() => {
        // These helpers each open their own prepared statements against the same
        // connection and participate in this transaction.
        this.databaseService.deleteTranscript(opts.videoId);
        this.databaseService.deleteAnalysisSections(opts.videoId);
        this.databaseService.deleteCustomMarkers(opts.videoId);
        this.databaseService.deleteAnalysis(opts.videoId);
        db.prepare(
          `UPDATE videos SET duration_seconds = ?, file_size_bytes = ?, file_hash = ?, has_transcript = 0, has_analysis = 0, last_processed_date = ?, upload_date = ?, download_date = ?, added_at = ?, source_url = ?, ai_description = ?, suggested_title = ? WHERE id = ?`
        ).run(
          newDuration,
          extractionResult.fileSize || 0,
          newFileHash,
          nowIso,
          originalMetadata.uploadDate,
          originalMetadata.downloadDate,
          originalMetadata.addedAt,
          originalMetadata.sourceUrl,
          originalMetadata.aiDescription,
          originalMetadata.suggestedTitle,
          opts.videoId,
        );
      });
      clearAndUpdate();

      // Regenerate the thumbnail from the new file contents. Without this,
      // the library keeps showing the pre-overwrite thumbnail forever.
      this.eventService.emitTaskProgress(taskId, 'export-clip', 95, 'Regenerating thumbnail...');
      this.updateTaskProgress(taskId, 95, 'Regenerating thumbnail...');
      try {
        await this.mediaOps.regenerateThumbnail(opts.videoId, opts.videoPath);
      } catch (thumbErr) {
        this.logger.warn(`[EXPORT-CLIP] [OVERWRITE] Thumbnail regeneration failed (non-fatal): ${(thumbErr as Error).message}`);
      }

      // Notify all frontends (library view + any open Scout editor) that the
      // file at this path has changed so they can cache-bust their video URL
      // and refetch thumbnails. The path itself is unchanged, but reusing the
      // existing video-path-updated event gives us the refresh behavior Scout
      // already implements for replaced videos.
      this.eventService.emitVideoPathUpdated(opts.videoId, opts.videoPath, opts.videoPath);

      this.eventService.emitTaskProgress(taskId, 'export-clip', 100, 'Overwrite complete');
      this.updateTaskProgress(taskId, 100, 'Overwrite complete');
      this.logger.log(`[EXPORT-CLIP] [OVERWRITE] ========== Overwrite complete ==========`);

      return {
        success: true,
        data: { outputPath: opts.videoPath, duration: newDuration, overwritten: true },
      };
    } catch (error) {
      this.logger.error(`[EXPORT-CLIP] [OVERWRITE] Unexpected error: ${(error as Error).message}`);
      return { success: false, error: (error as Error).message };
    }
  }
}
