import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { OllamaService } from './ollama.service';
import { AIProviderService } from './ai-provider.service';
import { AIAnalysisService } from './ai-analysis.service';
import { WhisperService } from '../media/whisper.service';
import { FfmpegService } from '../ffmpeg/ffmpeg.service';
import { DownloaderService } from '../downloader/downloader.service';
import { PathService } from '../path/path.service';
import { SharedConfigService } from '../config/shared-config.service';
import { LibraryService } from '../library/library.service';
import { LibraryManagerService } from '../database/library-manager.service';
import { FileScannerService } from '../database/file-scanner.service';
import { DatabaseService } from '../database/database.service';
import { MediaEventService } from '../media/media-event.service';
import { MediaProcessingService } from '../media/media-processing.service';
import { QueueManagerService } from '../queue/queue-manager.service';
import { ApiKeysService } from '../config/api-keys.service';
import { Task } from '../common/interfaces/task.interface';
import { DEFAULT_CATEGORIES } from './prompts/analysis-prompts';
import { parseProviderModel, numCtxMaxForModel } from './model-utils';
import { v4 as uuidv4 } from 'uuid';

export interface AnalysisJob {
  id: string;
  status: 'pending' | 'downloading' | 'extracting' | 'transcribing' | 'analyzing' | 'processing' | 'normalizing' | 'completed' | 'failed';
  progress: number;
  currentPhase: string;
  title?: string; // Video title/filename for display
  mode?: 'full' | 'transcribe-only' | 'analysis-only' | 'process-only' | 'normalize-audio' | 'download-and-process'; // Processing mode
  error?: string;
  videoId?: string; // Library video ID for progress tracking
  videoPath?: string;
  audioPath?: string;
  transcriptPath?: string;
  analysisPath?: string;
  tags?: { people: string[]; topics: string[] }; // Extracted tags from analysis
  createdAt: Date;
  completedAt?: Date;
  timing?: {
    downloadStart?: Date;
    downloadEnd?: Date;
    extractionStart?: Date;
    extractionEnd?: Date;
    transcriptionStart?: Date;
    transcriptionEnd?: Date;
    analysisStart?: Date;
    analysisEnd?: Date;
    totalDuration?: number; // in seconds
  };
}

export interface AnalysisRequest {
  input: string; // URL or file path
  inputType: 'url' | 'file';
  mode?: 'full' | 'transcribe-only' | 'analysis-only' | 'process-only' | 'normalize-audio' | 'download-and-process'; // Analysis mode: full, transcription only, analysis only (using existing transcript), process only (fix aspect ratio), normalize audio, or download and process (download + import + fix aspect ratio)
  aiModel: string;
  aiProvider?: 'local' | 'ollama' | 'claude' | 'openai'; // AI provider to use
  apiKey?: string; // API key for Claude/OpenAI
  ollamaEndpoint: string;
  whisperModel?: string;
  language?: string;
  outputPath?: string;
  customReportName?: string; // Custom name for the report file
  customInstructions?: string; // Custom instructions for AI analysis
  existingTranscriptText?: string; // For 'analysis-only' mode: plain text transcript
  existingTranscriptSrt?: string; // For 'analysis-only' mode: SRT format transcript
  videoId?: string; // Video ID if analyzing an existing library video (skips import/search)
}

// Extended request interface to track job state
interface AnalysisRequestWithState extends AnalysisRequest {
  transcriptText?: string;
  transcriptSrt?: string;
  videoPath?: string;
  videoTitle?: string;
  audioPath?: string;
  phase?: 'download' | 'transcribe' | 'analyze' | 'process' | 'normalize-audio' | 'finalize';
}

@Injectable()
export class AnalysisService implements OnModuleInit {
  private readonly logger = new Logger(AnalysisService.name);
  private jobs = new Map<string, AnalysisJob>();

  // Queue management for concurrency control
  private pendingQueue: Array<{ jobId: string; request: AnalysisRequestWithState }> = [];
  private activeJobs = 0; // Total active jobs (transcription + analysis)
  private readonly MAX_CONCURRENT_JOBS = 1; // Only 1 job at a time, period
  private isProcessing = false; // Prevent concurrent processNextInQueue calls

  /**
   * Load analysis categories from config file
   * Throws error if categories are not configured - NO FALLBACKS
   */
  private loadCategories(): any[] {
    // Analysis without categories is broken by definition (nothing gets flagged),
    // so a missing/empty/unreadable categories file is a hard error — NO FALLBACKS.
    // onModuleInit seeds this file with DEFAULT_CATEGORIES, so absence means the
    // config dir is genuinely wrong, not a first-run.
    const categoriesPath = path.join(this.configService.getConfigDir(), 'analysis-categories.json');

    if (!fsSync.existsSync(categoriesPath)) {
      throw new Error(
        `Analysis categories file not found at ${categoriesPath}. Analysis cannot run without categories.`,
      );
    }

    const parsed = JSON.parse(fsSync.readFileSync(categoriesPath, 'utf8'));
    // Tolerate both the correct { categories: [...] } shape and a legacy
    // bare-array file so existing installs don't break.
    const categories = Array.isArray(parsed) ? parsed : parsed?.categories;
    if (!categories || categories.length === 0) {
      throw new Error(
        `No analysis categories configured in ${categoriesPath}. Configure categories before analyzing.`,
      );
    }

    return categories;
  }

  constructor(
    private ollama: OllamaService,
    private aiProvider: AIProviderService,
    private aiAnalysis: AIAnalysisService,
    private whisperService: WhisperService,
    private ffmpeg: FfmpegService,
    private downloader: DownloaderService,
    private pathService: PathService,
    private eventEmitter: EventEmitter2,
    private configService: SharedConfigService,
    private libraryService: LibraryService,
    private libraryManagerService: LibraryManagerService,
    private fileScannerService: FileScannerService,
    private databaseService: DatabaseService,
    private mediaEventService: MediaEventService,
    private mediaProcessingService: MediaProcessingService,
    @Inject(forwardRef(() => QueueManagerService))
    private queueManager: QueueManagerService,
    private apiKeysService: ApiKeysService,
  ) {}

  /**
   * Initialize event listeners on module initialization
   */
  onModuleInit() {
    // Initialize categories file if it doesn't exist
    this.initializeCategoriesFile();

    // Listen for FFmpeg processing progress events
    this.eventEmitter.on('processing-progress', (data: { jobId: string; progress: number; task: string }) => {
      this.logger.log(`[FFmpeg Progress] Job ${data.jobId}: ${data.progress}% - ${data.task}`);

      // Update the job progress
      const job = this.jobs.get(data.jobId);
      // Handle both 'processing' (aspect ratio) and 'normalizing' (audio) statuses
      if (job && (job.status === 'processing' || job.status === 'normalizing')) {
        this.updateJob(data.jobId, {
          progress: data.progress,
          currentPhase: data.task,
        });

        // Emit WebSocket event so frontend receives progress updates
        this.mediaEventService.emitProcessingProgress(
          data.progress,
          data.task,
          data.jobId
        );
      }
    });

    this.logger.log('Analysis service event listeners initialized');
  }

  /**
   * Start a new analysis job (adds to queue)
   */
  async startAnalysis(request: AnalysisRequest, customJobId?: string): Promise<string> {
    const jobId = customJobId || uuidv4();

    // Determine title from input - use customReportName or extract from file path
    let title: string;
    if (request.customReportName) {
      title = request.customReportName;
    } else if (request.inputType === 'file') {
      const pathModule = require('path');
      title = pathModule.basename(request.input, pathModule.extname(request.input));
    } else {
      // For URL inputs, extract something useful from the URL
      const url = new URL(request.input);
      title = url.pathname.split('/').pop() || url.hostname;
    }

    // Determine mode
    const mode = request.mode || 'full';

    const job: AnalysisJob = {
      id: jobId,
      status: 'pending',
      progress: 0,
      currentPhase: 'Waiting in queue...',
      title,
      mode: mode, // Store mode for frontend to determine which stages to show
      videoId: request.videoId, // Include videoId for library progress tracking
      createdAt: new Date(),
      timing: {},
    };

    this.jobs.set(jobId, job);

    // Determine initial phase based on mode and input type
    let initialPhase: 'download' | 'transcribe' | 'analyze' | 'process' | 'normalize-audio' | 'finalize';

    if (mode === 'process-only') {
      initialPhase = 'process';
    } else if (mode === 'normalize-audio') {
      initialPhase = 'normalize-audio';
    } else if (mode === 'analysis-only') {
      initialPhase = 'analyze';
    } else if (mode === 'download-and-process') {
      // Download and process mode: download first (will skip transcribe and go to process)
      initialPhase = 'download';
    } else if (request.inputType === 'file') {
      // Local files skip download and go straight to transcribe
      initialPhase = 'transcribe';
    } else {
      // URLs need download first
      initialPhase = 'download';
    }

    // Add to pending queue with phase tracking
    const requestWithState: AnalysisRequestWithState = {
      ...request,
      phase: initialPhase,
    };

    this.pendingQueue.push({ jobId, request: requestWithState });
    this.logger.log(`Job ${jobId} added to queue at phase '${initialPhase}'. Queue length: ${this.pendingQueue.length}`);

    // Try to process next job in queue (use setImmediate to allow synchronous code to complete first)
    setImmediate(() => this.processNextInQueue());

    return jobId;
  }

  /**
   * Process the next job in queue if resources are available
   * Jobs are processed phase by phase, re-entering the queue between phases
   * Priority: finalize > analyze > transcribe (complete jobs before starting new ones)
   */
  private processNextInQueue(): void {
    if (this.pendingQueue.length === 0) {
      return;
    }

    // Priority 1: Finalize jobs (quick, no resources needed)
    for (let i = 0; i < this.pendingQueue.length; i++) {
      const { jobId, request } = this.pendingQueue[i];
      if ((request.phase || 'download') === 'finalize') {
        this.pendingQueue.splice(i, 1);
        this.logger.log(`Starting job ${jobId} at phase 'finalize'`);
        this.processJobPhase(jobId, request).catch((error) => {
          this.logger.error(`Job ${jobId} failed at phase 'finalize': ${(error as Error).message}`);
          this.updateJob(jobId, { status: 'failed', error: (error as Error).message });
          setImmediate(() => this.processNextInQueue());
        });
        return;
      }
    }

    // Only start jobs if we have capacity (1 job max at a time)
    if (this.activeJobs >= this.MAX_CONCURRENT_JOBS) {
      this.logger.debug(`No jobs can start. Active: ${this.activeJobs}/${this.MAX_CONCURRENT_JOBS}. Queue: ${this.pendingQueue.length}`);
      return;
    }

    // Priority 1: Analyze jobs (jobs that finished transcribing)
    for (let i = 0; i < this.pendingQueue.length; i++) {
      const { jobId, request } = this.pendingQueue[i];
      if ((request.phase || 'download') === 'analyze') {
        this.activeJobs++;
        this.pendingQueue.splice(i, 1);
        this.logger.log(`Starting job ${jobId} at phase 'analyze'. Active jobs: ${this.activeJobs}/${this.MAX_CONCURRENT_JOBS}`);
        this.processJobPhase(jobId, request).catch((error) => {
          this.logger.error(`Job ${jobId} failed at phase 'analyze': ${(error as Error).message}`);
          this.updateJob(jobId, { status: 'failed', error: (error as Error).message });
          this.activeJobs--;
          setImmediate(() => this.processNextInQueue());
        });
        return;
      }
    }

    // Priority 2: Transcribe/Download/Process/Normalize jobs (start new jobs)
    for (let i = 0; i < this.pendingQueue.length; i++) {
      const { jobId, request } = this.pendingQueue[i];
      const phase = request.phase || 'download';
      if (phase === 'download' || phase === 'transcribe' || phase === 'process' || phase === 'normalize-audio') {
        this.activeJobs++;
        this.pendingQueue.splice(i, 1);
        this.logger.log(`Starting job ${jobId} at phase '${phase}'. Active jobs: ${this.activeJobs}/${this.MAX_CONCURRENT_JOBS}`);
        this.processJobPhase(jobId, request).catch((error) => {
          this.logger.error(`Job ${jobId} failed at phase '${phase}': ${(error as Error).message}`);
          this.updateJob(jobId, { status: 'failed', error: (error as Error).message });
          this.activeJobs--;
          setImmediate(() => this.processNextInQueue());
        });
        return;
      }
    }

    // No jobs in queue
    this.logger.debug(`Queue empty. Active jobs: ${this.activeJobs}/${this.MAX_CONCURRENT_JOBS}`);
  }

  /**
   * Get job status
   */
  getJob(jobId: string): AnalysisJob | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Get all jobs
   */
  getAllJobs(): AnalysisJob[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Delete a job
   */
  async deleteJob(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    // Clean up temporary files
    try {
      if (job.audioPath) await fs.unlink(job.audioPath).catch(() => {});
    } catch (error: any) {
      this.logger.warn(`Error cleaning up job ${jobId}: ${(error as Error).message || 'Unknown error'}`);
    }

    this.jobs.delete(jobId);
    return true;
  }

  /**
   * Re-add job to queue at the next phase
   */
  private requeueJobForNextPhase(jobId: string, request: AnalysisRequestWithState, nextPhase: 'download' | 'transcribe' | 'analyze' | 'process' | 'finalize'): void {
    request.phase = nextPhase;
    this.pendingQueue.push({ jobId, request });
    this.logger.log(`Job ${jobId} re-queued for phase '${nextPhase}'. Queue length: ${this.pendingQueue.length}`);
    setImmediate(() => this.processNextInQueue());
  }

  /**
   * Process a single phase of a job
   */
  private async processJobPhase(
    jobId: string,
    request: AnalysisRequestWithState,
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('Job not found');

    const phase = request.phase || 'download';
    const mode = request.mode || 'full';

    this.logger.log(`Processing job ${jobId} at phase '${phase}'`);

    try {
      if (phase === 'download') {
        // Phase 1: Download/prepare video
        await this.processDownloadPhase(jobId, request);

        // Check mode to determine next phase
        if (mode === 'download-and-process') {
          // For download-and-process mode: skip transcribe/analyze, go straight to process
          // DON'T release the slot - continue directly to processing
          this.logger.log(`Download phase complete for job ${jobId}, continuing to process...`);

          // Process immediately without re-queuing to maintain sequential order
          await this.processProcessPhase(jobId, request);

          // NOW release job slot after processing is done
          this.activeJobs--;
          this.logger.log(`Processing complete for job ${jobId}. Active jobs: ${this.activeJobs}/${this.MAX_CONCURRENT_JOBS}`);

          // Move to finalize
          this.requeueJobForNextPhase(jobId, request, 'finalize');
        } else {
          // For full/transcribe-only modes: continue to transcribe
          this.logger.log(`Download phase complete for job ${jobId}, moving to transcribe...`);

          // Continue directly to transcribe phase without releasing the slot
          await this.processTranscribePhase(jobId, request);

          // NOW release job slot after both download and transcribe are done
          this.activeJobs--;
          this.logger.log(`Transcription phase complete for job ${jobId}. Active jobs: ${this.activeJobs}/${this.MAX_CONCURRENT_JOBS}`);

          // Move to appropriate next phase based on mode
          if (mode === 'transcribe-only') {
            this.requeueJobForNextPhase(jobId, request, 'finalize');
          } else {
            this.requeueJobForNextPhase(jobId, request, 'analyze');
          }
        }
      } else if (phase === 'transcribe') {
        // This is for local files that start directly at transcribe (skipping download)
        // Set up videoPath and videoTitle if not already set
        if (!request.videoPath) {
          request.videoPath = request.input;
          request.videoTitle = path.basename(request.input, path.extname(request.input));
        }

        await this.processTranscribePhase(jobId, request);

        // Release job slot
        this.activeJobs--;
        this.logger.log(`Transcription phase complete for job ${jobId}. Active jobs: ${this.activeJobs}/${this.MAX_CONCURRENT_JOBS}`);

        // Move to appropriate next phase based on mode
        if (mode === 'transcribe-only') {
          this.requeueJobForNextPhase(jobId, request, 'finalize');
        } else {
          this.requeueJobForNextPhase(jobId, request, 'analyze');
        }
      } else if (phase === 'analyze') {
        // Phase 3: AI Analysis
        await this.processAnalyzePhase(jobId, request);

        // Release job slot
        this.activeJobs--;
        this.logger.log(`Analysis phase complete for job ${jobId}. Active jobs: ${this.activeJobs}/${this.MAX_CONCURRENT_JOBS}`);

        // Move to finalize
        this.requeueJobForNextPhase(jobId, request, 'finalize');
      } else if (phase === 'process') {
        // Process-only mode: Fix aspect ratio for vertical videos
        await this.processProcessPhase(jobId, request);

        // Release job slot
        this.activeJobs--;
        this.logger.log(`Processing phase complete for job ${jobId}. Active jobs: ${this.activeJobs}/${this.MAX_CONCURRENT_JOBS}`);

        // Move to finalize
        this.requeueJobForNextPhase(jobId, request, 'finalize');
      } else if (phase === 'normalize-audio') {
        // Normalize-audio mode: Normalize audio levels using EBU R128
        await this.processNormalizeAudioPhase(jobId, request);

        // Release job slot
        this.activeJobs--;
        this.logger.log(`Audio normalization phase complete for job ${jobId}. Active jobs: ${this.activeJobs}/${this.MAX_CONCURRENT_JOBS}`);

        // Move to finalize
        this.requeueJobForNextPhase(jobId, request, 'finalize');
      } else if (phase === 'finalize') {
        // Phase 4: Finalize
        await this.processFinalizePhase(jobId, request);

        this.logger.log(`Job ${jobId} completed successfully`);

        // Process next job in queue
        setImmediate(() => this.processNextInQueue());
      }
    } catch (error: any) {
      // Do NOT decrement activeJobs here — the caller's `.catch` in
      // processNextInQueue owns the slot release on failure, so decrementing in
      // both places would double-decrement and break the concurrency invariant.
      // (The success paths above decrement inline exactly once.)
      this.logger.error(`Job ${jobId} failed at phase '${phase}': ${(error as Error).message || 'Unknown error'}`);
      throw error;
    }
  }

  /**
   * Process download phase
   */
  private async processDownloadPhase(jobId: string, request: AnalysisRequestWithState): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('Job not found');

    // Determine output paths - use library clips folder for videos only
    let videosPath: string;
    const activeLibrary = this.libraryManagerService.getActiveLibrary();

    if (activeLibrary) {
      videosPath = activeLibrary.clipsFolderPath;
    } else {
      const baseOutputPath = request.outputPath || this.getDefaultOutputPath();
      videosPath = path.join(baseOutputPath, 'videos');
    }

    await fs.mkdir(videosPath, { recursive: true });

    if (request.inputType === 'url') {
      this.updateJob(jobId, {
        status: 'downloading',
        progress: 5,
        currentPhase: 'Downloading video (fast mode)...',
        timing: { ...job.timing, downloadStart: new Date() },
      });

      const downloadResult = await this.downloadVideo(request.input, videosPath, jobId);
      request.videoPath = downloadResult.path;
      request.videoTitle = downloadResult.title;

      this.updateJob(jobId, {
        progress: 15,
        videoPath: downloadResult.path,
        timing: { ...job.timing, downloadEnd: new Date() },
      });

      // Import video to database immediately so it shows up in library
      this.updateJob(jobId, {
        progress: 18,
        currentPhase: 'Importing to library...',
      });

      try {
        const duplicateHandling = new Map<string, 'skip' | 'replace' | 'keep-both'>();
        duplicateHandling.set(request.videoPath, 'keep-both');

        const importResult = await this.fileScannerService.importVideos([request.videoPath], duplicateHandling);
        if (importResult.imported.length > 0) {
          const importedVideoId = importResult.imported[0];
          request.videoId = importedVideoId; // Store videoId for later use
          this.updateJob(jobId, { videoId: importedVideoId });

          this.logger.log(`Video imported to library with ID: ${importedVideoId}`);

          // Emit WebSocket event so frontend refreshes immediately
          this.mediaEventService.emitVideoImported(
            importedVideoId,
            path.basename(request.videoPath),
            request.videoPath
          );

          this.updateJob(jobId, {
            progress: 20,
            currentPhase: 'Import complete, preparing for transcription...',
          });
        } else {
          // Fallback audit #10: continuing would produce a transcript with no
          // library video to attach to (orphaned work, invisible in the app).
          throw new Error(
            `Video at ${request.videoPath} could not be imported into the library ` +
            `(import returned no video ID${importResult.errors.length ? `: ${importResult.errors.join('; ')}` : ''}). ` +
            `Transcription was not started — the file is intact on disk.`,
          );
        }
      } catch (error: any) {
        if ((error as Error).message?.includes('Transcription was not started')) {
          throw error; // already our loud error from above
        }
        throw new Error(
          `Video at ${request.videoPath} could not be imported into the library ` +
          `(${(error as Error).message}). Transcription was not started — the file is intact on disk.`,
        );
      }
    } else {
      // Local file - already imported, just set the path
      request.videoPath = request.input;
      request.videoTitle = path.basename(request.input, path.extname(request.input));

      this.updateJob(jobId, {
        progress: 5,
        videoPath: request.input,
      });
    }
  }

  /**
   * Process transcribe phase
   */
  private async processTranscribePhase(jobId: string, request: AnalysisRequestWithState): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('Job not found');

    const mode = request.mode || 'full';

    if (mode === 'analysis-only') {
      // Use existing transcript
      request.transcriptText = request.existingTranscriptText!;
      request.transcriptSrt = request.existingTranscriptSrt!;

      this.updateJob(jobId, {
        progress: 60,
        currentPhase: 'Using existing transcript...',
      });
      return;
    }

    // Clear existing transcript if re-transcribing
    if (request.videoId) {
      const existingTranscript = this.databaseService.getTranscript(request.videoId);
      if (existingTranscript) {
        this.logger.log(`Clearing existing transcript for video ${request.videoId} before re-transcribing`);
        this.databaseService.deleteTranscript(request.videoId);
      }
    }

    // Transcribe using native whisper.cpp (handles audio extraction internally)
    this.updateJob(jobId, {
      status: 'transcribing',
      progress: 5,
      currentPhase: 'Starting transcription (this may take a few minutes)...',
      timing: { ...job.timing, transcriptionStart: new Date() },
    });

    this.logger.log(`Transcription started for job ${jobId} using whisper.cpp`);

    // Use WhisperService which handles audio extraction and whisper.cpp transcription
    const srtFilePath = await this.whisperService.transcribeVideo(
      request.videoPath!,
      jobId,
      request.whisperModel || 'base',
    );

    if (!srtFilePath) {
      throw new Error('Transcription failed - whisper.cpp did not produce output');
    }

    // Read the SRT file content
    const srtContent = await fs.readFile(srtFilePath, 'utf-8');

    // Parse SRT to get plain text (segments are parsed later in processAnalyzePhase)
    const segments = this.parseSrtToSegments(srtContent);
    const plainText = segments.map((seg: any) => seg.text).join(' ');

    request.transcriptText = plainText;
    request.transcriptSrt = srtContent;

    this.updateJob(jobId, {
      progress: 60,
      timing: { ...job.timing, transcriptionEnd: new Date() },
    });

    // Clean up the SRT temp file (we've read its content)
    await fs.unlink(srtFilePath).catch(() => {});
  }

  /**
   * Process analyze phase
   */
  private async processAnalyzePhase(jobId: string, request: AnalysisRequestWithState): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('Job not found');

    // Load video metadata from database if videoTitle is missing
    if (request.videoId && !request.videoTitle) {
      const video = this.databaseService.getVideoById(request.videoId);
      if (video) {
        request.videoTitle = video.filename;
        this.logger.log(`Loaded video title from database: ${request.videoTitle}`);
      }
    }

    // Handle analysis-only mode: use existing transcript
    const mode = request.mode || 'full';
    if (mode === 'analysis-only') {
      request.transcriptText = request.existingTranscriptText!;
      request.transcriptSrt = request.existingTranscriptSrt!;
      this.logger.log(`Using existing transcript for analysis-only mode (length: ${request.transcriptText?.length || 0} chars)`);

      this.updateJob(jobId, {
        progress: 60,
        currentPhase: 'Using existing transcript...',
      });
    }

    // Clear existing analysis data if re-analyzing
    if (request.videoId) {
      const existingAnalysis = this.databaseService.getAnalysis(request.videoId);
      if (existingAnalysis) {
        this.logger.log(`Clearing existing analysis data for video ${request.videoId} before re-analyzing`);

        // Delete analysis record and AI-generated sections
        this.databaseService.deleteAnalysis(request.videoId);

        // Delete AI-generated tags only (preserve user-created tags)
        this.databaseService.deleteAITagsForVideo(request.videoId);

        // Clear AI description and suggested title
        this.databaseService.updateVideoDescription(request.videoId, null);
        this.databaseService.updateVideoSuggestedTitle(request.videoId, null);
      }
    }

    // Strip provider prefix from model name for display and usage (e.g., "ollama:cogito:14b" -> "cogito:14b")
    let modelName = request.aiModel || 'default-model';
    this.logger.log(`[processAnalyzePhase] Original aiModel: ${request.aiModel}, aiProvider: ${request.aiProvider}`);

    // Extract provider from model string if prefixed (shared parser).
    {
      const parsed = parseProviderModel(modelName, request.aiProvider);
      if (parsed.provider && parsed.provider !== request.aiProvider) {
        request.aiProvider = parsed.provider;
        this.logger.log(`[processAnalyzePhase] Extracted provider from model string: ${parsed.provider}`);
      }
      if (parsed.model !== modelName) {
        modelName = parsed.model;
        this.logger.log(`[processAnalyzePhase] Stripped model name: ${modelName}`);
      }
    }

    this.updateJob(jobId, {
      status: 'analyzing',
      progress: 60,
      currentPhase: `Analyzing with ${modelName}...`,
      timing: { ...job.timing, analysisStart: new Date() },
    });

    this.logger.log(`Analysis started for job ${jobId}`);

    // Prepare AI model (preload if not loaded, unload others if different model)
    // Only for Ollama - local, claude, and openai providers handle their own model loading
    if (request.aiProvider === 'ollama') {
      // If the model can't be loaded, analysis WILL fail — fail loudly now
      // rather than swallowing it and limping into a doomed run. NO FALLBACKS.
      // Warm at the same num_ctx ceiling generation caps at, so the preload
      // doesn't load the model at Ollama's 128K default (a ~50GB KV spike).
      await this.ollama.prepareModel(
        modelName,
        request.ollamaEndpoint,
        numCtxMaxForModel(modelName),
      );
    }

    // Validate that transcript exists before proceeding
    if (!request.transcriptText || !request.transcriptSrt) {
      throw new Error(`Video must be transcribed before analysis. Missing: ${!request.transcriptText ? 'transcriptText' : 'transcriptSrt'}`);
    }

    // Create temp directory for analysis output
    const os = require('os');
    const tmpDir = os.tmpdir();
    const sanitizedTitle = this.sanitizeFilename(request.videoTitle || 'untitled');
    const reportFileName = request.customReportName || `${sanitizedTitle}.txt`;
    const analysisOutputPath = path.join(tmpDir, `${jobId}_${reportFileName}`);

    // Parse SRT to get segments
    const segments = this.parseSrtToSegments(request.transcriptSrt);

    // Determine provider and get API key if needed - no fallbacks
    if (!request.aiProvider) {
      throw new Error('AI provider is required for analysis');
    }
    const provider = request.aiProvider;
    let apiKey = request.apiKey;

    // Fetch API key from stored config if not provided and not using Ollama or local
    if (!apiKey && provider !== 'ollama' && provider !== 'local') {
      if (provider === 'openai') {
        apiKey = this.apiKeysService.getOpenAiApiKey();
        this.logger.log(`[${jobId}] Using stored OpenAI API key`);
      } else if (provider === 'claude') {
        apiKey = this.apiKeysService.getClaudeApiKey();
        this.logger.log(`[${jobId}] Using stored Claude API key`);
      }

      if (!apiKey) {
        throw new Error(`No API key found for ${provider}. Please configure your ${provider === 'openai' ? 'OpenAI' : 'Claude'} API key in settings.`);
      }
    }

    this.logger.log(`[${jobId}] Starting analysis with provider=${provider}, model=${modelName}`);

    // Load user's categories from config
    const categories = this.loadCategories();

    // Use native AIAnalysisService (replaces Python bridge)
    const analysisResult = await this.aiAnalysis.analyzeTranscript({
      provider: provider as 'local' | 'ollama' | 'openai' | 'claude',
      model: modelName,
      transcript: request.transcriptText!,
      segments,
      outputFile: analysisOutputPath,
      customInstructions: request.customInstructions,
      videoTitle: request.videoTitle,
      categories,
      apiKey,
      ollamaEndpoint: request.ollamaEndpoint,
      onProgress: (progress) => {
        // Handle indeterminate progress (single-chunk videos)
        if (progress.progress === -1) {
          this.updateJob(jobId, {
            progress: -1,  // Frontend should show indeterminate/spinner
            currentPhase: progress.message,
          });
        } else {
          // Map chunk completion progress (0-100%) to overall job progress (60-95%)
          const mappedProgress = Math.round(60 + (progress.progress / 100) * 35);
          this.updateJob(jobId, {
            progress: Math.min(Math.max(mappedProgress, 60), 95),
            currentPhase: progress.message,
          });
        }
      },
    });

    // Read and save analysis
    const analysisText = await fs.readFile(analysisOutputPath, 'utf-8');

    // Save to request for finalize phase
    (request as any).analysisText = analysisText;
    (request as any).analysisResult = analysisResult;
    (request as any).analysisOutputPath = analysisOutputPath;

    // Debug: confirm chapters are in analysisResult before passing to finalize
    console.log(`[processAnalyzePhase] Storing analysisResult for finalize. Keys: ${Object.keys(analysisResult).join(', ')}`);
    console.log(`[processAnalyzePhase] chapters in result: ${analysisResult.chapters?.length || 0}`);

    this.updateJob(jobId, {
      progress: 95,
      tags: (analysisResult as any)?.tags || { people: [], topics: [] },
      timing: { ...job.timing, analysisEnd: new Date() },
    });

    // Per-call keep_alive ('5m' on every generate) keeps the model resident for
    // the next job in the queue.
    this.logger.log(`Analysis complete for job ${jobId}. Model ${modelName} will stay loaded (~5 min keep_alive).`);
  }

  /**
   * Process video aspect ratio (process-only mode)
   */
  private async processProcessPhase(jobId: string, request: AnalysisRequestWithState): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('Job not found');

    // Use videoPath from request (set during download phase) or fall back to input for process-only mode
    const videoPath = request.videoPath || request.input;
    if (!videoPath) {
      throw new Error('No video path provided for processing');
    }

    // Get video ID from request
    const videoId = request.videoId;
    if (!videoId) {
      throw new Error('Video ID is required for process-only mode');
    }

    this.updateJob(jobId, {
      status: 'processing',
      progress: 5,
      currentPhase: 'Analyzing video dimensions...',
      timing: { ...job.timing },
    });

    this.logger.log(`Processing video aspect ratio for job ${jobId}: ${videoPath}`);

    // Process the video with fixAspectRatio option
    const processingOptions = {
      fixAspectRatio: true,
    };

    try {
      const processingResult = await this.mediaProcessingService.processMedia(
        videoPath,
        processingOptions,
        jobId
      );

      if (processingResult.success && processingResult.outputFile) {
        this.updateJob(jobId, {
          progress: 80,
          currentPhase: 'Video processing complete',
        });

        // Update the video record with the new path
        if (processingResult.outputFile !== videoPath) {
          this.logger.log(`Updating video ${videoId} path from ${videoPath} to ${processingResult.outputFile}`);

          // Update database with new path and filename
          const newFilename = path.basename(processingResult.outputFile);
          this.databaseService.updateVideoPath(videoId, processingResult.outputFile);
          this.databaseService.updateVideoFilename(videoId, newFilename);

          // Delete original file if different from output
          try {
            await fs.unlink(videoPath);
            this.logger.log(`Deleted original file: ${videoPath}`);
          } catch (error: any) {
            this.logger.warn(`Failed to delete original file: ${error.message}`);
          }

          // Emit event for UI update
          this.mediaEventService.emitVideoRenamed(
            videoId,
            path.basename(videoPath),
            newFilename,
            processingResult.outputFile
          );
        }

        this.updateJob(jobId, {
          progress: 95,
          currentPhase: 'Processing complete',
        });
      } else {
        throw new Error(processingResult.error || 'Video processing failed');
      }
    } catch (error: any) {
      this.logger.error(`Failed to process video: ${error.message}`);
      throw error;
    }
  }

  /**
   * Process audio normalization (normalize-audio mode)
   */
  private async processNormalizeAudioPhase(jobId: string, request: AnalysisRequestWithState): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('Job not found');

    // For normalize-audio mode, input should be a file path
    const videoPath = request.input;
    if (!videoPath) {
      throw new Error('No video path provided for audio normalization');
    }

    // Get video ID from request
    const videoId = request.videoId;
    if (!videoId) {
      throw new Error('Video ID is required for normalize-audio mode');
    }

    this.updateJob(jobId, {
      status: 'normalizing',
      progress: 5,
      currentPhase: 'Analyzing audio levels...',
      timing: { ...job.timing },
    });

    this.logger.log(`Normalizing audio for job ${jobId}: ${videoPath}`);

    try {
      // Normalize audio using EBU R128 standard (target: -14 LUFS, YouTube standard)
      const normalizedPath = await this.ffmpeg.normalizeAudio(videoPath, -14, jobId);

      if (normalizedPath) {
        this.updateJob(jobId, {
          progress: 100,
          currentPhase: 'Audio normalization complete',
        });

        this.logger.log(`Audio normalization complete for job ${jobId}`);
      } else {
        throw new Error('Audio normalization failed - no output file returned');
      }
    } catch (error: any) {
      this.logger.error(`Failed to normalize audio: ${error.message}`);
      throw error;
    }
  }

  /**
   * Process finalize phase
   */
  private async processFinalizePhase(jobId: string, request: AnalysisRequestWithState): Promise<void> {
    console.log(`[processFinalizePhase] STARTING finalize phase for job ${jobId}`);
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('Job not found');

    const mode = request.mode || 'full';
    console.log(`[processFinalizePhase] mode=${mode}, request has analysisResult=${!!(request as any).analysisResult}`);

    this.updateJob(jobId, {
      progress: 98,
      currentPhase: mode === 'transcribe-only' ? 'Finalizing transcription...' : 'Finalizing analysis...',
    });

    // Calculate timing
    const timing = job.timing || {};
    const totalDuration = (new Date().getTime() - job.createdAt.getTime()) / 1000;

    // Get video ID - if provided in request, use it directly (library videos)
    let videoId: string | undefined = request.videoId;
    const activeLibrary = this.libraryManagerService.getActiveLibrary();

    // Only search/import if videoId not provided (for batch downloader videos)
    if (!videoId && activeLibrary && request.videoPath) {
      this.logger.log(`No videoId provided, searching for video by path: ${request.videoPath}`);

      // First, try to find existing video in database by path
      try {
        const videos = await this.databaseService.getAllVideos();
        const video = videos.find((v: any) => v.current_path === request.videoPath || v.file_path === request.videoPath);
        if (video) {
          videoId = video.id;
          this.logger.log(`Found existing video in database with ID: ${videoId}`);
        }
      } catch (findError) {
        this.logger.warn(`Could not find video in database: ${(findError as Error).message}`);
      }

      // If not found by path, try to import (for videos downloaded via batch downloader)
      if (!videoId) {
        this.logger.log(`Video not found in database, attempting import...`);
        try {
          const duplicateHandling = new Map<string, 'skip' | 'replace' | 'keep-both'>();
          duplicateHandling.set(request.videoPath, 'keep-both');

          const importResult = await this.fileScannerService.importVideos([request.videoPath], duplicateHandling);
          if (importResult.imported.length > 0) {
            videoId = importResult.imported[0];
            this.logger.log(`Video imported to library with ID: ${videoId}`);
          }
        } catch (error) {
          this.logger.error(`Error during auto-import: ${(error as Error).message}`);
        }
      }

      // SAFETY CHECK: If no videoId found after import, create a video record manually
      // This should ONLY happen for videos that failed import but still need analysis saved
      if (!videoId) {
        this.logger.warn(`No videoId after import attempt, creating manual record (this should be rare)`);
        try {
          const path = require('path');
          const fs = require('fs');

          // Generate video ID
          const newVideoId = require('uuid').v4();
          videoId = newVideoId;

          // Get file stats
          const stats = fs.statSync(request.videoPath);
          const filename = path.basename(request.videoPath);

          // Calculate file hash (simple approach - use file size + mtime as pseudo-hash)
          const crypto = require('crypto');
          const hash = crypto.createHash('sha256')
            .update(filename + stats.size + stats.mtime)
            .digest('hex');

          // Determine upload date from filename or path
          let uploadDate: string | undefined;

          // Try to extract from filename first (format: YYYY-MM-DD Title.ext)
          const filenameDateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})\s/);
          if (filenameDateMatch) {
            uploadDate = filenameDateMatch[1];
          } else {
            // Fallback: extract from path
            const dateMatch = request.videoPath.match(/\/(\d{4}-\d{2}-\d{2})\//);
            if (dateMatch) {
              uploadDate = dateMatch[1];
            }
          }

          // Get download date from file creation time
          const fileCreationDate = stats.birthtime < stats.mtime ? stats.birthtime : stats.mtime;
          const downloadDate = fileCreationDate.toISOString();

          // Extract video metadata using ffprobe
          let durationSeconds: number | undefined;
          let width: number | undefined;
          let height: number | undefined;
          let fps: number | undefined;
          try {
            const metadata = await this.ffmpeg.getVideoMetadata(request.videoPath);
            durationSeconds = metadata.duration;
            width = metadata.width;
            height = metadata.height;
            fps = metadata.fps;
            this.logger.log(`Extracted metadata for ${filename}: ${durationSeconds}s, ${width}x${height}, ${fps}fps`);
          } catch (metadataError: any) {
            this.logger.warn(`Could not extract metadata for ${filename}: ${metadataError.message}`);
          }

          // Insert video record
          this.databaseService.insertVideo({
            id: newVideoId,
            filename,
            fileHash: hash,
            currentPath: request.videoPath,
            uploadDate,
            downloadDate,
            fileSizeBytes: stats.size,
            durationSeconds,
            width,
            height,
            fps,
          });

          this.logger.log(`Created new video record with ID: ${newVideoId} for ${filename}`);

          // Emit WebSocket event so frontend refreshes immediately
          this.mediaEventService.emitVideoImported(
            newVideoId,
            filename,
            request.videoPath
          );
        } catch (error) {
          this.logger.error(`Failed to create video record: ${(error as Error).message}`);
        }
      }
    } else if (videoId) {
      this.logger.log(`Using provided videoId: ${videoId} (skipping import/search)`);
    }

    // Save to database if video found or created
    if (videoId) {
      if (mode !== 'analysis-only' && request.transcriptText && request.transcriptSrt) {
        this.databaseService.insertTranscript({
          videoId,
          plainText: request.transcriptText,
          srtFormat: request.transcriptSrt,
          whisperModel: request.whisperModel || 'base',
          language: request.language || 'en',
        });
      }

      // Get analysisResult first so it's accessible for description/tags even if analysis insert fails
      const analysisResult = (request as any).analysisResult;
      console.log(`[processFinalizePhase] analysisResult keys: ${analysisResult ? Object.keys(analysisResult).join(', ') : 'null'}`);
      console.log(`[processFinalizePhase] analysisResult.chapters: ${analysisResult?.chapters ? `array of ${analysisResult.chapters.length}` : 'undefined'}`);


      if (mode !== 'transcribe-only' && (request as any).analysisText) {
        if (!request.aiProvider) {
          throw new Error('AI provider is required when saving analysis');
        }
        const tokenStats = analysisResult?.tokenStats;
        this.databaseService.insertAnalysis({
          videoId,
          aiAnalysis: (request as any).analysisText,
          sectionsCount: analysisResult?.sections_count || 0,
          aiModel: request.aiModel,
          aiProvider: request.aiProvider,
          inputTokens: tokenStats?.inputTokens,
          outputTokens: tokenStats?.outputTokens,
          totalTokens: tokenStats?.totalTokens,
          estimatedCost: tokenStats?.estimatedCost,
          apiCalls: tokenStats?.apiCalls,
        });

        // Save analysis sections to database
        if (analysisResult && analysisResult.sections && Array.isArray(analysisResult.sections)) {
          this.logger.log(`Saving ${analysisResult.sections.length} sections to database for video ${videoId}`);

          // Parse a "M:SS" / "H:MM:SS" time string to seconds. Returns null for
          // anything unparseable so callers can tell "absent" from "zero".
          const parseSectionTime = (value: string | null | undefined): number | null => {
            if (!value) return null;
            const parts = value.split(':').map((p: string) => parseInt(p, 10));
            if (parts.some((n) => !Number.isFinite(n))) return null;
            if (parts.length === 2) return parts[0] * 60 + parts[1];
            if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
            return null;
          };

          for (const section of analysisResult.sections) {
            const startSeconds = parseSectionTime(section.start_time) ?? 0;

            // Honor the section's OWN end time when it has one. The ranked flag
            // path merges a run of flagged sentences into one section and its end
            // is measured (the last sentence's end), so overwriting it with a
            // fixed 10-second window would throw away the real span. The 10s
            // default remains for sections that carry no usable end.
            const parsedEnd = parseSectionTime(section.end_time);
            const endSeconds =
              parsedEnd !== null && parsedEnd > startSeconds ? parsedEnd : startSeconds + 10;

            // Only insert sections that have a valid category (skip uncategorized)
            if (section.category) {
              this.databaseService.insertAnalysisSection({
                id: require('uuid').v4(),
                videoId,
                startSeconds,
                endSeconds,
                timestampText: section.start_time,
                title: section.description ? section.description.substring(0, 100) : undefined,
                description: section.description,
                category: section.category,
                source: 'ai',
              });
            }
          }

          this.logger.log(`Successfully saved ${analysisResult.sections.length} sections for video ${videoId}`);
          console.log(`[processFinalizePhase] SECTIONS SAVED SUCCESSFULLY - now checking chapters`);
        } else {
          this.logger.warn(`No sections found in analysisResult for video ${videoId}`);
          console.log(`[processFinalizePhase] NO SECTIONS - analysisResult keys: ${analysisResult ? Object.keys(analysisResult).join(', ') : 'null'}`);
        }

        // Save chapters (topic-based segments)
        console.log(`[processFinalizePhase] About to check chapters. analysisResult type: ${typeof analysisResult}`);
        console.log(`[processFinalizePhase] analysisResult keys: ${analysisResult ? Object.keys(analysisResult).join(', ') : 'NULL'}`);
        console.log(`[processFinalizePhase] Checking chapters: exists=${!!analysisResult.chapters}, isArray=${Array.isArray(analysisResult.chapters)}, length=${analysisResult.chapters?.length || 0}`);
        if (analysisResult.chapters && analysisResult.chapters.length > 0) {
          console.log(`[processFinalizePhase] Chapters data: ${JSON.stringify(analysisResult.chapters)}`);
        }
        // Never persist chapters that FAILED analysis — they carry no real
        // title/summary and must not masquerade as successful content.
        const persistableChapters = (analysisResult.chapters || []).filter((c: any) => !c.failed);
        const failedChapterCount = (analysisResult.chapters || []).length - persistableChapters.length;
        if (failedChapterCount > 0) {
          this.logger.warn(`${failedChapterCount} chapter(s) failed analysis and will not be saved for video ${videoId}`);
        }
        if (persistableChapters.length > 0) {
          this.logger.log(`Saving ${persistableChapters.length} chapters for video ${videoId}`);
          console.log(`[processFinalizePhase] SAVING ${persistableChapters.length} CHAPTERS`);

          try {
            // Delete existing chapters first
            this.databaseService.deleteChapters(videoId);
            console.log(`[processFinalizePhase] Deleted existing chapters for video ${videoId}`);

            for (const chapter of persistableChapters) {
              console.log(`[processFinalizePhase] Processing chapter: ${JSON.stringify(chapter)}`);

              // Parse start time to seconds
              let startSeconds = 0;
              if (chapter.start_time) {
                const parts = chapter.start_time.split(':').map((p: string) => parseInt(p));
                if (parts.length === 2) {
                  startSeconds = parts[0] * 60 + parts[1];
                } else if (parts.length === 3) {
                  startSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
                }
              }

              // Parse end time to seconds
              let endSeconds = startSeconds + 60; // Default 1 minute duration
              if (chapter.end_time) {
                const parts = chapter.end_time.split(':').map((p: string) => parseInt(p));
                if (parts.length === 2) {
                  endSeconds = parts[0] * 60 + parts[1];
                } else if (parts.length === 3) {
                  endSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
                }
              }

              console.log(`[processFinalizePhase] Inserting chapter: seq=${chapter.sequence}, start=${startSeconds}, end=${endSeconds}, title=${chapter.title}`);

              this.databaseService.insertChapter({
                id: require('uuid').v4(),
                videoId,
                sequence: chapter.sequence,
                startSeconds,
                endSeconds,
                title: chapter.title,
                description: chapter.summary,
                source: 'ai',
              });

              console.log(`[processFinalizePhase] Chapter inserted successfully`);
            }
            // Verify chapters were saved
            const savedChapters = this.databaseService.getChapters(videoId);
            console.log(`[processFinalizePhase] VERIFICATION: ${savedChapters.length} chapters now in database for video ${videoId}`);
          } catch (chapterError) {
            console.error(`[processFinalizePhase] ERROR SAVING CHAPTERS: ${(chapterError as Error).message}`);
            console.error((chapterError as Error).stack);
          }

          this.logger.log(`Successfully saved ${persistableChapters.length} chapters for video ${videoId}`);
        } else {
          this.logger.warn(`No persistable chapters in analysisResult for video ${videoId}`);
        }

        // Save suggested title if available (MOVED INSIDE analysis block)
        // This ensures suggested_title is only saved when analysis record exists
        if (analysisResult && analysisResult.suggested_title) {
          this.logger.log(`Saving suggested title for video ${videoId}: ${analysisResult.suggested_title}`);
          this.databaseService.updateVideoSuggestedTitle(videoId, analysisResult.suggested_title);
        }
      }

      // Save AI description to video if available (MOVED OUTSIDE analysis block)
      // This ensures description is always saved when analysisResult exists
      this.logger.log(`[AI Description Debug] analysisResult exists: ${!!analysisResult}`);
      this.logger.log(`[AI Description Debug] analysisResult.description exists: ${!!(analysisResult && analysisResult.description)}`);
      if (analysisResult && analysisResult.description) {
        this.logger.log(`[AI Description Debug] Description value: ${analysisResult.description.substring(0, 100)}...`);
        this.logger.log(`Saving AI description for video ${videoId}`);
        this.databaseService.updateVideoDescription(videoId, analysisResult.description);
      } else {
        this.logger.warn(`[AI Description Debug] No description in analysisResult for video ${videoId}. Keys: ${analysisResult ? Object.keys(analysisResult).join(', ') : 'null'}`);
      }

      // Save tags (people and topics) if available (MOVED OUTSIDE analysis block)
      if (analysisResult && analysisResult.tags) {
        this.logger.log(`Saving tags for video ${videoId}: ${JSON.stringify(analysisResult.tags)}`);

        // Save people tags
        if (analysisResult.tags.people && Array.isArray(analysisResult.tags.people)) {
          for (const person of analysisResult.tags.people) {
            if (person && typeof person === 'string' && person.trim()) {
              this.databaseService.insertTag({
                id: require('uuid').v4(),
                videoId,
                tagName: person.trim(),
                tagType: 'person',
                source: 'ai',
                confidence: 0.8, // Default confidence for AI-generated tags
              });
            }
          }
        }

        // Save topic tags
        if (analysisResult.tags.topics && Array.isArray(analysisResult.tags.topics)) {
          for (const topic of analysisResult.tags.topics) {
            if (topic && typeof topic === 'string' && topic.trim()) {
              this.databaseService.insertTag({
                id: require('uuid').v4(),
                videoId,
                tagName: topic.trim(),
                tagType: 'topic',
                source: 'ai',
                confidence: 0.8, // Default confidence for AI-generated tags
              });
            }
          }
        }

        this.logger.log(`Successfully saved tags for video ${videoId}`);
      }
    }

    // Clean up temp files
    if ((request as any).analysisOutputPath) {
      await fs.unlink((request as any).analysisOutputPath).catch(() => {});
    }

    // Complete
    const completionMessage = mode === 'transcribe-only'
      ? 'Transcription complete!'
      : mode === 'download-and-process'
      ? 'Download and processing complete!'
      : `Analysis complete! Found ${(request as any).analysisResult?.sections_count || 0} interesting sections.`;

    this.updateJob(jobId, {
      status: 'completed',
      progress: 100,
      currentPhase: completionMessage,
      completedAt: new Date(),
      timing: { ...timing, totalDuration },
    });
  }

  /**
   * Download video using existing downloader service
   */
  private async downloadVideo(
    url: string,
    outputDir: string,
    jobId: string,
  ): Promise<{ path: string; title: string }> {
    // Fetch metadata first to get proper title for filename
    let displayName: string | undefined;
    try {
      this.logger.log(`Fetching metadata for URL: ${url}`);
      const videoInfo = await this.downloader.getVideoInfo(url);

      // Create display name with upload date if available (matches batch downloader format)
      if (videoInfo.uploadDate && videoInfo.title) {
        displayName = `${videoInfo.uploadDate} ${videoInfo.title}`;
      } else if (videoInfo.title) {
        displayName = videoInfo.title;
      }

      // Truncate if too long (max 200 chars to prevent filesystem issues)
      if (displayName && displayName.length > 200) {
        displayName = displayName.substring(0, 197) + '...';
      }

      this.logger.log(`Fetched metadata - title: ${videoInfo.title}, displayName: ${displayName}`);
    } catch (error: any) {
      this.logger.warn(`Failed to fetch metadata for ${url}: ${(error as Error).message || 'Unknown error'}. Will use default naming.`);
      // Continue without metadata - yt-dlp will use its own title extraction during download
    }

    // Use fast download settings - lowest quality for speed
    const result = await this.downloader.downloadVideo({
      url,
      quality: '360',
      convertToMp4: false, // Skip conversion for speed
      fixAspectRatio: false, // Skip processing for speed
      useCookies: false,
      browser: 'auto',
      outputDir,
      displayName, // Pass the fetched title to use for the filename
    });

    // Handle the DownloadResult return type
    if (!result.success || !result.outputFile) {
      throw new Error(result.error || 'Download failed');
    }

    const outputPath = result.outputFile;
    const title = path.basename(outputPath, path.extname(outputPath));

    return { path: outputPath, title };
  }

  /**
   * Get default output path
   */
  private getDefaultOutputPath(): string {
    // Try to get from config first
    const configOutputDir = this.configService.getOutputDir();
    if (configOutputDir) {
      return configOutputDir;
    }

    // Fallback to default location
    const homeDir = require('os').homedir();
    return path.join(homeDir, 'Downloads', 'Briefcase');
  }

  /**
   * Generate timing footer for analysis report
   */
  private generateTimingFooter(
    transcriptionDuration: number,
    analysisDuration: number,
    totalDuration: number,
    whisperModel: string,
    aiModel: string,
  ): string {
    const formatDuration = (seconds: number): string => {
      if (seconds < 60) {
        return `${seconds.toFixed(1)}s`;
      }
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = seconds % 60;
      return `${minutes}m ${remainingSeconds.toFixed(0)}s`;
    };

    return `\n${'='.repeat(80)}\n` +
           `PERFORMANCE METRICS\n` +
           `${'='.repeat(80)}\n\n` +
           `Transcription (${whisperModel} model):\n` +
           `  Duration: ${formatDuration(transcriptionDuration)}\n\n` +
           `AI Analysis (${aiModel}):\n` +
           `  Duration: ${formatDuration(analysisDuration)}\n\n` +
           `Total Processing Time: ${formatDuration(totalDuration)}\n` +
           `${'='.repeat(80)}\n`;
  }

  /**
   * Sanitize filename for safe file system usage
   * Preserves original case and spaces, only removes truly invalid characters
   */
  private sanitizeFilename(filename: string): string {
    // Only remove or replace characters that are invalid on filesystems
    // Invalid chars: < > : " / \ | ? * and control characters (0-31)
    let sanitized = filename
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')  // Replace invalid chars with underscore
      .replace(/_{2,}/g, '_')                    // Replace multiple underscores with single
      .trim();                                   // Remove leading/trailing whitespace

    // Limit total length to 200 chars to avoid "filename too long" errors
    // This is well within the 255 char limit for most filesystems
    if (sanitized.length > 200) {
      sanitized = sanitized.substring(0, 200).trim();
    }

    // Remove trailing dots or underscores (Windows doesn't like these)
    sanitized = sanitized.replace(/[_\.]+$/, '');

    // If somehow the filename is empty after sanitization, use a default
    if (!sanitized) {
      sanitized = 'untitled';
    }

    return sanitized;
  }

  /**
   * Parse SRT format to segments array (for AI analysis timestamp correlation)
   */
  private parseSrtToSegments(srtContent: string): any[] {
    const segments: any[] = [];

    if (!srtContent || typeof srtContent !== 'string') {
      this.logger.warn('[parseSrtToSegments] SRT content is undefined or not a string');
      return segments;
    }

    // Debug: Log raw SRT content info
    this.logger.log(`[parseSrtToSegments] Raw SRT length: ${srtContent.length}`);
    this.logger.log(`[parseSrtToSegments] First 200 chars: ${JSON.stringify(srtContent.substring(0, 200))}`);
    this.logger.log(`[parseSrtToSegments] Contains \\r\\n: ${srtContent.includes('\r\n')}, Contains \\r: ${srtContent.includes('\r')}, Contains \\n: ${srtContent.includes('\n')}`);

    // Normalize line endings: convert \r\n (Windows) to \n (Unix)
    const normalizedContent = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const blocks = normalizedContent.split('\n\n').filter(b => b.trim());

    this.logger.log(`[parseSrtToSegments] After normalization, found ${blocks.length} blocks`);
    if (blocks.length > 0) {
      this.logger.log(`[parseSrtToSegments] First block: ${JSON.stringify(blocks[0].substring(0, 150))}`);
    }

    for (const block of blocks) {
      const lines = block.split('\n');
      if (lines.length < 3) continue;

      // Line 0: sequence number
      // Line 1: timestamp (00:00:01,500 --> 00:00:04,200)
      // Line 2+: text
      const timestampLine = lines[1];
      const textLines = lines.slice(2);

      const match = timestampLine.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
      if (match) {
        const startHours = parseInt(match[1]);
        const startMinutes = parseInt(match[2]);
        const startSeconds = parseInt(match[3]);
        const startMs = parseInt(match[4]);

        const endHours = parseInt(match[5]);
        const endMinutes = parseInt(match[6]);
        const endSeconds = parseInt(match[7]);
        const endMs = parseInt(match[8]);

        const start = startHours * 3600 + startMinutes * 60 + startSeconds + startMs / 1000;
        const end = endHours * 3600 + endMinutes * 60 + endSeconds + endMs / 1000;

        segments.push({
          start,
          end,
          text: textLines.join(' ')
        });
      }
    }

    this.logger.log(`[parseSrtToSegments] Parsed ${segments.length} segments`);
    if (segments.length > 0) {
      this.logger.log(`[parseSrtToSegments] First segment: start=${segments[0].start}, end=${segments[0].end}, text="${segments[0].text.substring(0, 50)}..."`);
      if (segments.length > 1) {
        this.logger.log(`[parseSrtToSegments] Second segment: start=${segments[1].start}, end=${segments[1].end}`);
      }
    }

    return segments;
  }

  /**
   * Update job and emit event
   */
  private updateJob(jobId: string, updates: Partial<AnalysisJob>): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      this.logger.warn(`[updateJob] Job ${jobId} not found, cannot update`);
      return;
    }

    Object.assign(job, updates);

    // Emit WebSocket event with both jobId and id for frontend compatibility
    this.logger.log(`[updateJob] Emitting progress for job ${jobId}: ${JSON.stringify(updates)}`);
    this.eventEmitter.emit('analysis.progress', {
      id: jobId,  // Frontend expects 'id' field
      jobId,      // Keep jobId for backwards compatibility
      videoId: job.videoId,  // Include videoId so frontend can identify which video to update
      ...updates,
    });
  }

  /**
   * Start batch analysis for multiple videos
   * Returns a batch ID that can be used to track overall progress
   */
  async startBatchAnalysis(options: {
    videoIds?: string[]; // Specific video IDs to process
    aiModel?: string;
    aiProvider?: 'ollama' | 'claude' | 'openai';
    whisperModel?: string;
    ollamaEndpoint?: string;
    transcribeOnly?: boolean;
    forceReanalyze?: boolean;
    forceRetranscribe?: boolean;
    claudeApiKey?: string;
    openaiApiKey?: string;
    limit?: number; // Process only first N videos (for testing)
    customJobId?: string; // Custom job ID from frontend (for single-video analysis in processing queue)
  }): Promise<{ batchId: string; jobIds: string[] }> {
    const batchId = uuidv4();

    // Get config
    const config = await this.configService.getConfig();
    const transcribeOnly = options?.transcribeOnly || false;
    const forceReanalyze = options?.forceReanalyze || false;
    const forceRetranscribe = options?.forceRetranscribe !== undefined ? options.forceRetranscribe : true; // Default true for batch operations

    // NO DEFAULT - user must explicitly select an AI model for analysis
    const aiModel = options?.aiModel || config.aiModel;
    const aiProvider = options?.aiProvider;
    const whisperModel = options?.whisperModel || 'base';

    // Validate AI model is configured if not transcribe-only
    if (!transcribeOnly && !aiModel) {
      throw new Error('AI analysis requires an AI model to be configured. Please select a model in settings.');
    }
    if (!transcribeOnly && !aiProvider) {
      throw new Error('AI analysis requires an AI provider to be configured. Please select a provider in settings.');
    }
    const ollamaEndpoint = options?.ollamaEndpoint || config.ollamaEndpoint || 'http://localhost:11434';
    const apiKey = aiProvider === 'claude' ? options?.claudeApiKey : aiProvider === 'openai' ? options?.openaiApiKey : undefined;

    // Get videos to process
    let videosToProcess: Array<{ id: string; filename: string; current_path: string }>;

    if (options?.videoIds && options.videoIds.length > 0) {
      // Process specific videos by ID
      const dbVideos = options.videoIds
        .map(id => this.databaseService.getVideoById(id))
        .filter(video => video !== null);

      if (dbVideos.length === 0) {
        throw new Error('None of the specified videos were found in the database');
      }

      videosToProcess = dbVideos.map(video => ({
        id: video.id as string,
        filename: video.filename as string,
        current_path: video.current_path as string,
      }));
    } else {
      // Get all videos that need analysis
      const videosNeedingAnalysis = this.fileScannerService.getNeedsAnalysis();

      // Apply limit if specified
      videosToProcess = options?.limit
        ? videosNeedingAnalysis.slice(0, options.limit)
        : videosNeedingAnalysis;

      if (videosToProcess.length === 0) {
        throw new Error('No videos need analysis');
      }
    }


    // Submit all videos to the new queue system
    const jobIds: string[] = [];

    for (const video of videosToProcess) {
      try {
        // Check if transcript and analysis already exist
        const existingTranscript = this.databaseService.getTranscript(video.id);
        const existingAnalysis = this.databaseService.getAnalysis(video.id);
        const hasTranscript = !!existingTranscript;
        const hasAnalysis = !!existingAnalysis;

        // Build task list based on what needs to be done
        const tasks: Task[] = [];

        if (transcribeOnly) {
          // If user explicitly selected transcribe, always re-transcribe (don't skip)
          tasks.push({ type: 'transcribe', options: { model: whisperModel } });
        } else {
          // User requested full analysis — always allow re-analysis.
          // Old analysis will be cleared by processAnalyzePhase before re-running.

          // Determine which tasks to add based on existing transcript and user preferences
          if (hasTranscript && !forceRetranscribe) {
            // Use existing transcript, only run analysis
          } else {
            // Need to transcribe (either no transcript exists, or forceRetranscribe is true)
            tasks.push({ type: 'transcribe', options: { model: whisperModel } });
          }

          // Always add analyze task for full analysis
          tasks.push({
            type: 'analyze',
            options: {
              aiModel,
              aiProvider,
              ollamaEndpoint,
              apiKey, // Single apiKey field for all providers
            },
          });
        }

        // Create queue job with videoId and tasks
        const createdJobId = this.queueManager.addJob({
          videoId: video.id,
          displayName: video.filename,
          tasks,
        });

        jobIds.push(createdJobId);

      } catch (error) {
        this.logger.error(`Failed to queue video ${video.filename}: ${(error as Error).message}`);
      }
    }

    // Emit batch started event
    this.eventEmitter.emit('batch.started', {
      batchId,
      totalJobs: jobIds.length,
      jobIds,
    });

    // If no jobs were queued (all skipped), no need to track batch job
    if (jobIds.length === 0) {
      this.logger.log(`Batch ${batchId}: No jobs to process (all videos skipped)`);
      // Don't call updateJob - batch job was never created since no processing needed
    }

    return { batchId, jobIds };
  }

  /**
   * Get batch progress by checking status of all jobs in the batch
   */
  getBatchProgress(jobIds: string[]): {
    total: number;
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    progress: number;
  } {
    const stats = {
      total: jobIds.length,
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      progress: 0,
    };

    for (const jobId of jobIds) {
      const job = this.jobs.get(jobId);
      if (!job) continue;

      if (job.status === 'pending') stats.pending++;
      else if (job.status === 'completed') stats.completed++;
      else if (job.status === 'failed') stats.failed++;
      else stats.processing++;
    }

    stats.progress = stats.total > 0 ? Math.round(((stats.completed + stats.failed) / stats.total) * 100) : 0;

    return stats;
  }

  /**
   * Initialize categories file with defaults if it doesn't exist
   * Called on module init to ensure categories are always available
   */
  private initializeCategoriesFile(): void {
    try {
      const configDir = this.configService.getConfigDir();
      const categoriesPath = path.join(configDir, 'analysis-categories.json');

      if (!fsSync.existsSync(categoriesPath)) {
        this.logger.log('Categories file not found, initializing with defaults');

        // Ensure directory exists
        if (!fsSync.existsSync(configDir)) {
          fsSync.mkdirSync(configDir, { recursive: true });
        }

        // Write default categories in the { categories: [...] } shape that
        // loadCategories() and config.controller expect.
        fsSync.writeFileSync(
          categoriesPath,
          JSON.stringify({ categories: DEFAULT_CATEGORIES }, null, 2),
          'utf-8'
        );

        this.logger.log(`Created categories file at: ${categoriesPath}`);
      } else {
        this.logger.log(`Categories file exists at: ${categoriesPath}`);
      }
    } catch (error) {
      this.logger.error(`Failed to initialize categories file: ${(error as Error).message}`);
    }
  }
}
