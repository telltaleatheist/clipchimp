// Atomic media operations service - each operation is standalone and emits progress

import { Injectable, Logger } from '@nestjs/common';
import { MediaEventService } from './media-event.service';
import { MediaProcessingService } from './media-processing.service';
import { WhisperService } from './whisper.service';
import { DownloaderService } from '../downloader/downloader.service';
import { FileScannerService } from '../database/file-scanner.service';
import { DatabaseService } from '../database/database.service';
import { AIAnalysisService } from '../analysis/ai-analysis.service';
import { parseProviderModel } from '../analysis/model-utils';
import { ApiKeysService } from '../config/api-keys.service';
import { SharedConfigService } from '../config/shared-config.service';
import { FfmpegService } from '../ffmpeg/ffmpeg.service';
import { ThumbnailService } from '../database/thumbnail.service';
import { WebArchiveService } from '../web-archive/web-archive.service';
import {
  GetInfoResult,
  DownloadResult,
  ImportResult,
  FixAspectRatioResult,
  NormalizeAudioResult,
  ProcessVideoResult,
  TranscribeResult,
  AnalyzeResult,
} from '../common/interfaces/task.interface';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class MediaOperationsService {
  private readonly logger = new Logger(MediaOperationsService.name);

  constructor(
    private readonly downloaderService: DownloaderService,
    private readonly fileScannerService: FileScannerService,
    private readonly databaseService: DatabaseService,
    private readonly mediaProcessingService: MediaProcessingService,
    private readonly whisperService: WhisperService,
    private readonly aiAnalysisService: AIAnalysisService,
    private readonly eventService: MediaEventService,
    private readonly apiKeysService: ApiKeysService,
    private readonly ffmpegService: FfmpegService,
    private readonly thumbnailService: ThumbnailService,
    private readonly webArchiveService: WebArchiveService,
    private readonly configService: SharedConfigService,
  ) {}

  /**
   * Get video info/metadata without downloading
   */
  async getVideoInfo(url: string, jobId?: string): Promise<GetInfoResult> {
    try {
      this.logger.log(`[${jobId || 'standalone'}] Getting video info for: ${url}`);

      this.eventService.emitTaskProgress(jobId || '', 'get-info', 10, 'Fetching video metadata...');

      const info = await this.downloaderService.getVideoInfo(url);

      this.eventService.emitTaskProgress(jobId || '', 'get-info', 100, 'Metadata retrieved');

      return {
        success: true,
        data: {
          title: info.title,
          uploader: info.uploader,
          duration: info.duration,
          uploadDate: info.uploadDate,
          thumbnail: info.thumbnail,
          isLive: info.isLive || false,
        },
      };
    } catch (error) {
      this.logger.error(`Failed to get video info: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get video info',
      };
    }
  }

  /**
   * Download video only (no import, no processing)
   */
  async downloadVideo(
    url: string,
    options: {
      quality?: string;
      convertToMp4?: boolean;
      useCookies?: boolean;
      browser?: string;
      displayName?: string;
      outputDir?: string;
    },
    jobId?: string,
  ): Promise<DownloadResult> {
    try {
      this.logger.log(`[${jobId || 'standalone'}] Downloading video: ${url}`);

      this.eventService.emitTaskProgress(jobId || '', 'download', 0, 'Starting download...');

      const result = await this.downloaderService.downloadVideo(
        {
          url,
          // No coercion: absent/'best' means best available; the downloader
          // honors an explicit height cap. (Fallback audit: '|| 720' here
          // silently capped "Best available" for every site.)
          quality: options.quality,
          convertToMp4: options.convertToMp4 !== false,
          useCookies: options.useCookies !== false,
          browser: options.browser || 'auto',
          displayName: options.displayName,
          outputDir: options.outputDir,
          fixAspectRatio: false, // Never process during download
          useRmsNormalization: false,
          useCompression: false,
        },
        jobId,
      );

      if (!result.success || !result.outputFile) {
        throw new Error(result.error || 'Download failed');
      }

      this.eventService.emitTaskProgress(jobId || '', 'download', 100, 'Download complete');

      // Extract title from the actual output filename - no fallbacks
      const path = require('path');
      const filename = path.basename(result.outputFile, path.extname(result.outputFile));

      return {
        success: true,
        data: {
          videoPath: result.outputFile,
          title: filename,
        },
        warnings: result.warnings,
      };
    } catch (error) {
      this.logger.error(`Download failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Download failed',
      };
    }
  }

  /**
   * Import video to library database
   */
  async importToLibrary(
    videoPath: string,
    options: {
      duplicateHandling?: 'skip' | 'replace' | 'keep-both';
    } = {},
    jobId?: string,
  ): Promise<ImportResult> {
    try {
      this.logger.log(`[${jobId || 'standalone'}] Importing video: ${videoPath}`);

      this.eventService.emitTaskProgress(jobId || '', 'import', 10, 'Checking for duplicates...');

      const duplicateHandling = new Map<string, 'skip' | 'replace' | 'keep-both'>();
      duplicateHandling.set(videoPath, options.duplicateHandling || 'keep-both');

      this.eventService.emitTaskProgress(jobId || '', 'import', 30, 'Calculating file hash...');

      const importResult = await this.fileScannerService.importVideos([videoPath], duplicateHandling);

      this.eventService.emitTaskProgress(jobId || '', 'import', 70, 'Extracting metadata...');

      let videoId: string | undefined;
      let wasAlreadyImported = false;

      if (importResult.imported.length > 0) {
        videoId = importResult.imported[0];
        this.logger.log(`[${jobId || 'standalone'}] Video imported with ID: ${videoId}`);
      } else if (importResult.errors.some(err => err.includes('Already imported'))) {
        // Video already exists - find it by hash
        const fileHash = await this.databaseService.hashFile(videoPath);
        const existingVideo = this.databaseService.findVideoByHash(fileHash);

        if (existingVideo) {
          videoId = existingVideo.id as string;
          wasAlreadyImported = true;
          this.logger.log(`[${jobId || 'standalone'}] Video already in library with ID: ${videoId}`);

          // Update download date
          this.databaseService.updateVideoDownloadDate(videoId, new Date().toISOString());

          // Only delete the freshly-downloaded duplicate once we've CONFIRMED the
          // existing library copy is still on disk. Otherwise we'd destroy the only
          // remaining copy of the file. If the existing copy is missing, adopt the
          // new download by relinking the record to it.
          const existingPath = existingVideo.current_path as string | undefined;
          const existingOnDisk = !!existingPath && fs.existsSync(existingPath);
          const sameFile = !!existingPath && path.resolve(existingPath) === path.resolve(videoPath);

          if (existingOnDisk) {
            if (fs.existsSync(videoPath) && !sameFile) {
              fs.unlinkSync(videoPath);
              this.logger.log(`[${jobId || 'standalone'}] Deleted duplicate file: ${videoPath}`);
            }
          } else if (fs.existsSync(videoPath)) {
            // Existing library file is gone — keep the new download and relink.
            this.logger.warn(
              `[${jobId || 'standalone'}] Existing library file missing (${existingPath}); relinking record ${videoId} to new download: ${videoPath}`,
            );
            this.databaseService.updateVideoPath(videoId, videoPath);
          }
        }
      }

      if (!videoId) {
        throw new Error('Failed to import video: ' + importResult.errors.join(', '));
      }

      this.eventService.emitTaskProgress(jobId || '', 'import', 100, 'Import complete');

      // Emit video-imported event so frontend refreshes
      this.eventService.emitVideoImported(videoId, path.basename(videoPath), videoPath);

      return {
        success: true,
        data: {
          videoId,
          wasAlreadyImported,
        },
      };
    } catch (error) {
      this.logger.error(`Import failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Import failed',
      };
    }
  }

  /**
   * Fix aspect ratio for vertical videos
   */
  async fixAspectRatio(
    videoIdOrPath: string,
    options: {} = {},
    jobId?: string,
  ): Promise<FixAspectRatioResult> {
    try {
      this.logger.log(`[${jobId || 'standalone'}] Fixing aspect ratio for: ${videoIdOrPath}`);

      // Determine if this is a video ID or file path
      // UUIDs follow pattern: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      let videoPath: string;
      let videoId: string | undefined;

      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const isUUID = uuidPattern.test(videoIdOrPath);

      if (isUUID || !fs.existsSync(videoIdOrPath)) {
        // It's a video ID - get path from database
        const video = this.databaseService.getVideoById(videoIdOrPath);
        if (!video) {
          throw new Error(`Video not found: ${videoIdOrPath}`);
        }
        videoPath = video.current_path as string;
        videoId = videoIdOrPath;
      } else {
        // It's a file path
        videoPath = videoIdOrPath;
      }

      this.logger.log(`[${jobId || 'standalone'}] Fix aspect ratio using path: ${videoPath}`);
      this.eventService.emitTaskProgress(jobId || '', 'fix-aspect-ratio', 5, 'Analyzing video dimensions...');

      const result = await this.mediaProcessingService.processMedia(
        videoPath,
        { fixAspectRatio: true },
        jobId,
        'fix-aspect-ratio'  // Pass task type for progress relay
      );

      if (!result.success) {
        throw new Error(result.error || 'Aspect ratio fix failed');
      }

      this.eventService.emitTaskProgress(jobId || '', 'fix-aspect-ratio', 100, 'Aspect ratio fixed');

      return {
        success: true,
        data: {
          outputPath: result.outputFile || videoPath,
          wasProcessed: result.outputFile !== videoPath, // False if video didn't need processing
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Fix aspect ratio failed';
      this.logger.error(`Fix aspect ratio failed: ${errorMsg}`);
      // Emit failure progress so UI updates immediately
      this.eventService.emitTaskProgress(jobId || '', 'fix-aspect-ratio', -1, `Failed: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Normalize audio levels
   */
  async normalizeAudio(
    videoIdOrPath: string,
    options: {
      level?: number;
      method?: 'rms' | 'ebu-r128';
    } = {},
    jobId?: string,
  ): Promise<NormalizeAudioResult> {
    try {
      console.log('=== MediaOperationsService.normalizeAudio CALLED ===');
      console.log(`VideoIdOrPath: ${videoIdOrPath}, Options: ${JSON.stringify(options)}, JobId: ${jobId}`);
      this.logger.log(`[${jobId || 'standalone'}] Normalizing audio for: ${videoIdOrPath}`);

      // Determine if this is a video ID or file path
      // UUIDs follow pattern: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      let videoPath: string;
      let videoId: string | undefined;

      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const isUUID = uuidPattern.test(videoIdOrPath);

      if (isUUID || !fs.existsSync(videoIdOrPath)) {
        // It's a video ID - get path from database
        const video = this.databaseService.getVideoById(videoIdOrPath);
        if (!video) {
          throw new Error(`Video not found: ${videoIdOrPath}`);
        }
        videoPath = video.current_path as string;
        videoId = videoIdOrPath;
      } else {
        // It's a file path
        videoPath = videoIdOrPath;
      }

      this.eventService.emitTaskProgress(jobId || '', 'normalize-audio', 5, 'Analyzing audio levels...');

      // Use loudnorm filter for proper audio normalization (EBU R128 standard)
      // This normalizes to target integrated loudness (LUFS) so all videos have consistent perceived volume
      const targetLoudness = options.level || -16;  // Default to -16 LUFS (standard web/podcast level)
      const normalizedPath = await this.ffmpegService.normalizeAudio(videoPath, targetLoudness, jobId);

      if (!normalizedPath) {
        throw new Error('Audio normalization failed');
      }

      this.eventService.emitTaskProgress(jobId || '', 'normalize-audio', 100, 'Audio normalized');

      return {
        success: true,
        data: {
          outputPath: normalizedPath,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Audio normalization failed';
      this.logger.error(`Normalize audio failed: ${errorMsg}`);
      // Emit failure progress so UI updates immediately
      this.eventService.emitTaskProgress(jobId || '', 'normalize-audio', -1, `Failed: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Process video with combined operations (aspect ratio + audio normalization)
   * This does both in a single FFmpeg pass to avoid double re-encoding
   */
  async processVideo(
    videoIdOrPath: string,
    options: {
      fixAspectRatio?: boolean;
      normalizeAudio?: boolean;
      level?: number;
      method?: 'rms' | 'ebu-r128';
    } = {},
    jobId?: string,
  ): Promise<ProcessVideoResult> {
    try {
      this.logger.log(`[${jobId || 'standalone'}] Processing video: ${videoIdOrPath}`);

      // Determine if this is a video ID or file path
      // UUIDs follow pattern: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      let videoPath: string;
      let videoId: string | undefined;

      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const isUUID = uuidPattern.test(videoIdOrPath);

      if (isUUID || !fs.existsSync(videoIdOrPath)) {
        // It's a video ID - get path from database
        const video = this.databaseService.getVideoById(videoIdOrPath);
        if (!video) {
          throw new Error(`Video not found: ${videoIdOrPath}`);
        }
        videoPath = video.current_path as string;
        videoId = videoIdOrPath;
      } else {
        // It's a file path
        videoPath = videoIdOrPath;
      }

      this.eventService.emitTaskProgress(jobId || '', 'process-video', 5, 'Analyzing video...');

      // Single re-encode with both aspect ratio and audio normalization
      const result = await this.mediaProcessingService.processMedia(
        videoPath,
        {
          fixAspectRatio: options.fixAspectRatio || false,
          useRmsNormalization: options.normalizeAudio && (options.method === 'rms' || !options.method),
          rmsNormalizationLevel: options.level || -16,
        },
        jobId,
        'process-video'  // Pass task type for progress relay
      );

      if (!result.success) {
        throw new Error(result.error || 'Video processing failed');
      }

      this.eventService.emitTaskProgress(jobId || '', 'process-video', 100, 'Video processed');

      return {
        success: true,
        data: {
          outputPath: result.outputFile || videoPath,
          aspectRatioFixed: options.fixAspectRatio || false,
          audioNormalized: options.normalizeAudio || false,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Video processing failed';
      this.logger.error(`Process video failed: ${errorMsg}`);
      // Emit failure progress so UI updates immediately
      this.eventService.emitTaskProgress(jobId || '', 'process-video', -1, `Failed: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Transcribe video using Whisper
   */
  async transcribeVideo(
    videoIdOrPath: string,
    options: {
      model?: string;
      language?: string;
      translate?: boolean;
    } = {},
    jobId?: string,
  ): Promise<TranscribeResult> {
    try {
      this.logger.log(`[${jobId || 'standalone'}] Transcribing video: ${videoIdOrPath}`);

      // Determine if this is a video ID or file path
      // UUIDs follow pattern: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      let videoPath: string;
      let videoId: string | undefined;

      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const isUUID = uuidPattern.test(videoIdOrPath);

      if (isUUID || !fs.existsSync(videoIdOrPath)) {
        // It's a video ID - get path from database
        const video = this.databaseService.getVideoById(videoIdOrPath);
        if (!video) {
          throw new Error(`Video not found: ${videoIdOrPath}`);
        }
        videoPath = video.current_path as string;
        videoId = videoIdOrPath;
      } else {
        // It's a file path
        videoPath = videoIdOrPath;
      }

      this.eventService.emitTaskProgress(jobId || '', 'transcribe', 0, 'Starting transcription...');

      const transcriptFile = await this.whisperService.transcribeVideo(videoPath, jobId, options.model, options.translate);

      if (!transcriptFile) {
        throw new Error('Transcription failed');
      }

      this.eventService.emitTaskProgress(jobId || '', 'transcribe', 95, 'Saving transcript...');

      // Read transcript files
      const transcriptSrt = fs.readFileSync(transcriptFile, 'utf8');
      const transcriptTxtFile = transcriptFile.replace(/\.srt$/i, '.txt');
      const transcriptText = fs.existsSync(transcriptTxtFile)
        ? fs.readFileSync(transcriptTxtFile, 'utf8')
        : transcriptSrt;

      // If we have a videoId, save to database
      if (videoId) {
        this.databaseService.insertTranscript({
          videoId,
          plainText: transcriptText,
          srtFormat: transcriptSrt,
          whisperModel: options.model || 'base',
          language: options.language || 'en',
        });
        this.logger.log(`[${jobId || 'standalone'}] Transcript saved to database for video ${videoId}`);

        // Clean up temp files
        if (fs.existsSync(transcriptFile)) fs.unlinkSync(transcriptFile);
        if (fs.existsSync(transcriptTxtFile)) fs.unlinkSync(transcriptTxtFile);
      }

      this.eventService.emitTaskProgress(jobId || '', 'transcribe', 100, 'Transcription complete');

      return {
        success: true,
        data: {
          transcriptPath: videoId ? undefined : transcriptFile, // Only return path if not saved to DB
        },
      };
    } catch (error) {
      this.logger.error(`Transcription failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Transcription failed',
      };
    }
  }

  /**
   * AI analysis of video transcript
   */
  async analyzeVideo(
    videoId: string,
    options: {
      aiModel: string;
      aiProvider?: 'ollama' | 'claude' | 'openai';
      apiKey?: string;
      ollamaEndpoint?: string;
      customInstructions?: string;
      analysisGranularity?: number;
    },
    jobId?: string,
  ): Promise<AnalyzeResult> {
    console.log('=== MediaOperationsService.analyzeVideo CALLED ===');
    console.log(`VideoId: ${videoId}, Options: ${JSON.stringify(options)}, JobId: ${jobId}`);

    try {
      this.logger.log(`[${jobId || 'standalone'}] Analyzing video: ${videoId}`);

      // Get video and transcript from database
      const video = this.databaseService.getVideoById(videoId);
      if (!video) {
        throw new Error('Video not found');
      }

      // Verify and update video metadata using ffprobe
      await this.verifyVideoMetadata(videoId, video.current_path, video, jobId);

      const transcript = this.databaseService.getTranscript(videoId);
      if (!transcript) {
        throw new Error('Transcript not found - transcribe video first');
      }

      // Clear existing analysis data before re-running (preserves user markers)
      const existingAnalysis = this.databaseService.getAnalysis(videoId);
      if (existingAnalysis) {
        this.logger.log(`[${jobId || 'standalone'}] Clearing existing analysis for video ${videoId} before re-analyzing`);
        this.databaseService.deleteAnalysis(videoId);
        this.databaseService.deleteAITagsForVideo(videoId);
        this.databaseService.updateVideoDescription(videoId, null);
        this.databaseService.updateVideoSuggestedTitle(videoId, null);
      }

      this.eventService.emitTaskProgress(jobId || '', 'analyze', 0, 'Starting AI analysis...');

      const transcriptText = transcript.plain_text as string;
      const transcriptSrt = transcript.srt_format as string;

      // Parse SRT to segments
      const segments = this.parseSrtToSegments(transcriptSrt);

      // Create temp file for analysis output
      const os = require('os');
      const tmpDir = os.tmpdir();
      const analysisOutputPath = path.join(tmpDir, `${jobId || 'analysis'}_analysis.txt`);

      // Extract provider from model name prefix if present (shared parser).
      // Model format: "provider:model" (e.g. "openai:gpt-4o", "ollama:qwen2.5:7b").
      const parsedModel = parseProviderModel(options.aiModel, options.aiProvider);
      const cleanModelName = parsedModel.model;
      const provider = parsedModel.provider;
      if (cleanModelName !== options.aiModel) {
        this.logger.log(`[${jobId || 'standalone'}] Stripped provider prefix: ${options.aiModel} -> ${cleanModelName}`);
      }

      // Require explicit provider - no fallbacks
      if (!provider) {
        throw new Error('AI provider is required for analysis. No provider specified and none could be extracted from model name.');
      }

      // Get API key from options or from stored config
      let apiKey = options.apiKey;
      if (!apiKey && provider !== 'ollama' && provider !== 'local') {
        // Get API key from the API keys service
        if (provider === 'openai') {
          apiKey = this.apiKeysService.getOpenAiApiKey();
          this.logger.log(`[${jobId || 'standalone'}] Using stored OpenAI API key`);
        } else if (provider === 'claude') {
          apiKey = this.apiKeysService.getClaudeApiKey();
          this.logger.log(`[${jobId || 'standalone'}] Using stored Claude API key`);
        }

        if (!apiKey) {
          throw new Error(`No API key found for ${provider}. Please configure your ${provider === 'openai' ? 'OpenAI' : 'Claude'} API key in settings.`);
        }
      }

      // Use filename (always present) - strip extension for display
      const videoTitle = video.filename.replace(/\.[^/.]+$/, '');

      // Load categories from config
      const categories = this.loadCategories();

      // Use native AIAnalysisService (replaces Python bridge)
      const analysisResult = await this.aiAnalysisService.analyzeTranscript({
        provider,
        model: cleanModelName,
        transcript: transcriptText,
        segments,
        outputFile: analysisOutputPath,
        customInstructions: options.customInstructions,
        analysisGranularity: options.analysisGranularity,
        videoTitle,
        categories,
        apiKey,
        ollamaEndpoint: options.ollamaEndpoint || 'http://localhost:11434',
        onProgress: (progress) => {
          this.eventService.emitTaskProgress(jobId || '', 'analyze', progress.progress, progress.message, {
            eta: progress.eta,
            elapsedMs: progress.elapsedMs,
          });
        },
      });

      // Log analysis result
      this.logger.log(`[${jobId || 'standalone'}] Analysis result:`, JSON.stringify({
        sections_count: analysisResult.sections_count,
        has_sections: !!analysisResult.sections,
        sections_length: analysisResult.sections?.length || 0,
        has_tags: !!analysisResult.tags,
        has_description: !!analysisResult.description,
        description_preview: analysisResult.description?.substring(0, 50),
        has_suggested_title: !!analysisResult.suggested_title,
        suggested_title: analysisResult.suggested_title,
      }));

      // Read analysis file
      const analysisText = fs.readFileSync(analysisOutputPath, 'utf8');

      // Save analysis to database (including title suggestion in summary field)
      this.databaseService.insertAnalysis({
        videoId,
        aiAnalysis: analysisText,
        summary: analysisResult.suggested_title || undefined,  // Save title suggestion as summary
        sectionsCount: analysisResult.sections_count || 0,
        aiModel: cleanModelName,
        aiProvider: provider,
      });

      this.logger.log(`[${jobId || 'standalone'}] Analysis saved to database (${analysisResult.sections_count} sections, title: ${analysisResult.suggested_title || 'none'})`);

      // Extract and save tags from analysis result
      if (analysisResult.tags) {
        // Delete existing AI tags first
        this.databaseService.deleteAITagsForVideo(videoId);

        // Add new AI-generated tags from people and topics
        const allTags: string[] = [];
        if (analysisResult.tags.people) {
          allTags.push(...analysisResult.tags.people);
        }
        if (analysisResult.tags.topics) {
          allTags.push(...analysisResult.tags.topics);
        }

        for (const tagName of allTags) {
          const tagId = `ai-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          this.databaseService.insertTag({
            id: tagId,
            videoId,
            tagName: tagName,
            source: 'ai',
            confidence: 0.8,
          });
        }
        this.logger.log(`[${jobId || 'standalone'}] Saved ${allTags.length} AI tags`);
      }

      // Save AI description
      if (analysisResult.description) {
        this.databaseService.updateVideoDescription(videoId, analysisResult.description);
        this.logger.log(`[${jobId || 'standalone'}] Saved AI description`);
      }

      // Save suggested title
      if (analysisResult.suggested_title) {
        this.databaseService.updateVideoSuggestedTitle(videoId, analysisResult.suggested_title);
        this.logger.log(`[${jobId || 'standalone'}] Saved suggested title: ${analysisResult.suggested_title}`);
      }

      // Save analysis sections (delete existing AI sections first to avoid duplicates)
      this.databaseService.deleteAIAnalysisSections(videoId);
      if (analysisResult.sections && Array.isArray(analysisResult.sections)) {
        for (const section of analysisResult.sections) {
          const sectionId = `section-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          const startSeconds = this.parseTimeToSeconds(section.start_time);
          const endSeconds = section.end_time ? this.parseTimeToSeconds(section.end_time) : startSeconds + 30;
          this.databaseService.insertAnalysisSection({
            id: sectionId,
            videoId,
            startSeconds,
            endSeconds,
            timestampText: `${section.start_time}${section.end_time ? ' - ' + section.end_time : ''}`,
            title: section.category,
            description: section.description,
            category: section.category,
            source: 'ai',
            // See analysis.service's copy of this insert: the ranked flag path
            // stores accepted AND rejected verdicts with their ranker scores;
            // every other path leaves both undefined, which writes NULL and
            // reads back as a legacy flag.
            verdict: section.verdict,
            nliScore: section.nli_score,
          });
        }
        this.logger.log(`[${jobId || 'standalone'}] Saved ${analysisResult.sections.length} analysis sections`);
      }

      // Save chapters (delete existing to avoid duplicates)
      if (analysisResult.chapters && Array.isArray(analysisResult.chapters) && analysisResult.chapters.length > 0) {
        this.logger.log(`[${jobId || 'standalone'}] Saving ${analysisResult.chapters.length} chapters...`);
        this.databaseService.deleteChapters(videoId);

        for (const chapter of analysisResult.chapters) {
          const chapterId = `chapter-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          const startSeconds = this.parseTimeToSeconds(chapter.start_time);
          const endSeconds = chapter.end_time ? this.parseTimeToSeconds(chapter.end_time) : startSeconds + 60;

          this.databaseService.insertChapter({
            id: chapterId,
            videoId,
            sequence: chapter.sequence,
            startSeconds,
            endSeconds,
            title: chapter.title,
            description: chapter.summary || '',
            source: 'ai',
          });
        }
        this.logger.log(`[${jobId || 'standalone'}] Saved ${analysisResult.chapters.length} chapters`);
      } else {
        this.logger.log(`[${jobId || 'standalone'}] No chapters to save (chapters: ${analysisResult.chapters?.length || 0})`);
      }

      // Emit finalizing progress before completing
      this.eventService.emitTaskProgress(jobId || '', 'analyze', 95, 'Finalizing and saving results...');

      // Clean up temp file
      if (fs.existsSync(analysisOutputPath)) fs.unlinkSync(analysisOutputPath);

      this.eventService.emitTaskProgress(jobId || '', 'analyze', 100, 'Analysis complete');

      // Emit analysis-completed event AFTER all data is saved
      // This ensures the frontend can reload and get ALL the data at once
      this.eventService.emitAnalysisCompleted(
        videoId,
        analysisResult.suggested_title || '',
        analysisResult.description || ''
      );

      this.logger.log(`[${jobId || 'standalone'}] Emitted analysis-completed event for video ${videoId}`);

      return {
        success: true,
        data: {
          sectionsCount: analysisResult.sections_count || 0,
        },
      };
    } catch (error) {
      this.logger.error(`Analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Analysis failed',
      };
    }
  }

  /**
   * AI analysis of a captured webpage (MHTML). Uses the extracted text from
   * the text_content table to generate a suggested filename via LLM.
   */
  async analyzeWebpage(
    videoId: string,
    options: {
      aiModel: string;
      aiProvider?: 'local' | 'ollama' | 'claude' | 'openai';
      apiKey?: string;
      ollamaEndpoint?: string;
    },
    jobId?: string,
  ): Promise<AnalyzeResult> {
    try {
      this.logger.log(`[${jobId || 'standalone'}] Analyzing webpage: ${videoId}`);

      const video = this.databaseService.getVideoById(videoId);
      if (!video) {
        throw new Error('Webpage not found');
      }
      if (video.media_type !== 'webpage') {
        throw new Error(`Cannot analyze as webpage: media_type is '${video.media_type}'`);
      }

      let textContent = this.databaseService.getTextContent(videoId);
      if (!textContent || !textContent.extracted_text || textContent.extracted_text.trim().length === 0) {
        // Backfill text_content on demand. This covers MHTMLs imported before
        // the webpage.imported event handler existed, or cases where the
        // initial backfill silently failed.
        this.logger.log(
          `[${jobId || 'standalone'}] text_content missing for ${videoId}, extracting from MHTML...`,
        );
        this.eventService.emitTaskProgress(jobId || '', 'analyze', 5, 'Extracting page text...');

        const absolutePath = video.current_path as string;
        if (!absolutePath || !fs.existsSync(absolutePath)) {
          throw new Error(`Webpage file not found on disk: ${absolutePath}`);
        }

        let extractedText = '';
        try {
          extractedText = this.webArchiveService.extractTextFromMhtml(absolutePath);
        } catch (err: any) {
          throw new Error(
            `Failed to extract text from MHTML: ${err?.message || 'unknown error'}`,
          );
        }

        if (!extractedText || extractedText.trim().length === 0) {
          throw new Error(
            'No readable text could be extracted from this MHTML file. The archive may be empty or corrupted.',
          );
        }

        this.databaseService.insertTextContent({
          mediaId: videoId,
          extractedText,
          extractionMethod: 'mhtml-parse',
        });
        textContent = this.databaseService.getTextContent(videoId);
        if (!textContent || !textContent.extracted_text) {
          throw new Error('Failed to persist extracted text to database.');
        }
        this.logger.log(
          `[${jobId || 'standalone'}] Backfilled text_content for ${videoId} (${extractedText.length} chars)`,
        );
      }

      this.eventService.emitTaskProgress(jobId || '', 'analyze', 10, 'Loading page text...');

      // Resolve provider from model name prefix when possible (shared parser).
      const parsedModel = parseProviderModel(options.aiModel, options.aiProvider);
      const cleanModelName = parsedModel.model;
      const provider = parsedModel.provider;

      if (!provider) {
        throw new Error('AI provider is required for analysis.');
      }

      let apiKey = options.apiKey;
      if (!apiKey && provider !== 'ollama' && provider !== 'local') {
        if (provider === 'openai') {
          apiKey = this.apiKeysService.getOpenAiApiKey();
        } else if (provider === 'claude') {
          apiKey = this.apiKeysService.getClaudeApiKey();
        }
        if (!apiKey) {
          throw new Error(`No API key found for ${provider}. Please configure it in settings.`);
        }
      }

      // Clear previous suggested title so the UI shows the new one
      this.databaseService.updateVideoSuggestedTitle(videoId, null);

      this.eventService.emitTaskProgress(jobId || '', 'analyze', 30, 'Generating title with AI...');

      const currentTitle = video.filename.replace(/\.[^/.]+$/, '');

      const suggestedTitle = await this.aiAnalysisService.generateTitleFromWebpageText(
        {
          provider,
          model: cleanModelName,
          apiKey,
          ollamaEndpoint: options.ollamaEndpoint || 'http://localhost:11434',
        },
        textContent.extracted_text,
        currentTitle,
      );

      if (suggestedTitle) {
        this.databaseService.updateVideoSuggestedTitle(videoId, suggestedTitle);
        this.logger.log(`[${jobId || 'standalone'}] Saved suggested title for webpage: ${suggestedTitle}`);
      } else {
        this.logger.warn(`[${jobId || 'standalone'}] AI did not return a valid title for webpage ${videoId}`);
      }

      this.eventService.emitTaskProgress(jobId || '', 'analyze', 100, 'Analysis complete');
      this.eventService.emitAnalysisCompleted(videoId, suggestedTitle || '', '');

      return {
        success: true,
        data: {
          sectionsCount: 0,
        },
      };
    } catch (error) {
      this.logger.error(`Webpage analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Webpage analysis failed',
      };
    }
  }

  /**
   * Verify and update video metadata using ffprobe
   * Called during analysis to ensure metadata is accurate
   */
  private async verifyVideoMetadata(
    videoId: string,
    videoPath: string,
    currentVideo: { duration_seconds: number | null; width?: number | null; height?: number | null; fps?: number | null },
    jobId?: string
  ): Promise<void> {
    try {
      this.logger.log(`[${jobId || 'standalone'}] Verifying video metadata for: ${videoPath}`);

      const metadata = await this.ffmpegService.getVideoMetadata(videoPath);

      // Check if any metadata needs updating
      const updates: { durationSeconds?: number; width?: number; height?: number; fps?: number } = {};
      let needsUpdate = false;

      // Check duration (allow small tolerance of 0.5 seconds)
      if (metadata.duration !== undefined && metadata.duration > 0) {
        const currentDuration = currentVideo.duration_seconds || 0;
        if (Math.abs(currentDuration - metadata.duration) > 0.5) {
          updates.durationSeconds = metadata.duration;
          needsUpdate = true;
          this.logger.log(`[${jobId || 'standalone'}] Duration mismatch: stored=${currentDuration}s, actual=${metadata.duration}s`);
        }
      }

      // Check width
      if (metadata.width !== undefined && metadata.width > 0) {
        if (currentVideo.width !== metadata.width) {
          updates.width = metadata.width;
          needsUpdate = true;
          this.logger.log(`[${jobId || 'standalone'}] Width mismatch: stored=${currentVideo.width}, actual=${metadata.width}`);
        }
      }

      // Check height
      if (metadata.height !== undefined && metadata.height > 0) {
        if (currentVideo.height !== metadata.height) {
          updates.height = metadata.height;
          needsUpdate = true;
          this.logger.log(`[${jobId || 'standalone'}] Height mismatch: stored=${currentVideo.height}, actual=${metadata.height}`);
        }
      }

      // Check fps (allow small tolerance)
      if (metadata.fps !== undefined && metadata.fps > 0) {
        const currentFps = currentVideo.fps || 0;
        if (Math.abs(currentFps - metadata.fps) > 0.1) {
          updates.fps = metadata.fps;
          needsUpdate = true;
          this.logger.log(`[${jobId || 'standalone'}] FPS mismatch: stored=${currentFps}, actual=${metadata.fps}`);
        }
      }

      // Update database if needed
      if (needsUpdate) {
        this.databaseService.updateVideoTechnicalMetadata(videoId, updates);
        this.logger.log(`[${jobId || 'standalone'}] Video metadata updated: ${JSON.stringify(updates)}`);
      } else {
        this.logger.log(`[${jobId || 'standalone'}] Video metadata verified - no updates needed`);
      }
    } catch (error: any) {
      // Log but don't fail the analysis if metadata verification fails
      this.logger.warn(`[${jobId || 'standalone'}] Failed to verify video metadata: ${error.message}`);
    }
  }

  /**
   * Re-probe the file and update the stored width/height/fps/duration to match
   * the actual media. Call after any file-modifying task (fix-aspect-ratio,
   * strip-black-bars, ...) so the DB geometry reflects reality — otherwise
   * dimension-based logic (e.g. the aspect-ratio skip) acts on stale
   * pre-processing values and would either re-process a fixed video forever or
   * skip an unfixed one. Never throws (verifyVideoMetadata swallows probe errors).
   */
  async refreshVideoDimensions(videoId: string, videoPath: string, jobId?: string): Promise<void> {
    const current = this.databaseService.getVideoById(videoId) as
      | { duration_seconds: number | null; width?: number | null; height?: number | null; fps?: number | null }
      | undefined;
    if (!current) return;
    await this.verifyVideoMetadata(videoId, videoPath, current, jobId);
  }

  /**
   * Parse SRT content into segments for AI analysis
   */
  private parseSrtToSegments(srtContent: string): any[] {
    console.log(`[parseSrtToSegments] SRT content length: ${srtContent?.length || 0}`);
    console.log(`[parseSrtToSegments] SRT preview: ${srtContent?.substring(0, 300)}`);

    const segments: any[] = [];

    // Normalize line endings: convert \r\n (Windows) to \n (Unix)
    // This is critical on Windows where SRT files may have \r\n line endings
    const normalizedContent = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const blocks = normalizedContent.split('\n\n').filter(b => b.trim());
    console.log(`[parseSrtToSegments] Found ${blocks.length} blocks (after line ending normalization)`);

    for (const block of blocks) {
      const lines = block.split('\n');
      if (lines.length < 3) {
        console.log(`[parseSrtToSegments] Skipping block with ${lines.length} lines`);
        continue;
      }

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
          text: textLines.join(' '),
        });
      } else {
        console.log(`[parseSrtToSegments] No timestamp match for line: "${timestampLine}"`);
      }
    }

    console.log(`[parseSrtToSegments] Parsed ${segments.length} segments`);
    if (segments.length > 0) {
      console.log(`[parseSrtToSegments] First segment: start=${segments[0].start}, end=${segments[0].end}, text="${segments[0].text.substring(0, 50)}"`);
      console.log(`[parseSrtToSegments] Last segment: start=${segments[segments.length-1].start}, end=${segments[segments.length-1].end}`);
    }

    return segments;
  }

  /**
   * Parse time string (HH:MM:SS or MM:SS) to seconds
   */
  private parseTimeToSeconds(timeStr: string): number {
    if (!timeStr) return 0;

    const parts = timeStr.trim().split(':');
    let seconds = 0;

    if (parts.length === 3) {
      // HH:MM:SS
      seconds = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
    } else if (parts.length === 2) {
      // MM:SS
      seconds = parseInt(parts[0]) * 60 + parseInt(parts[1]);
    } else if (parts.length === 1) {
      // Just seconds
      seconds = parseInt(parts[0]);
    }

    return seconds;
  }

  /**
   * Regenerate thumbnail for a video after file-modifying operations
   * Deletes the old thumbnail and generates a new one from the updated file
   * Non-fatal: if it fails, the thumbnail will be lazily regenerated on next request
   */
  async regenerateThumbnail(videoId: string, videoPath: string): Promise<void> {
    try {
      this.logger.log(`Regenerating thumbnail for video ${videoId}`);
      this.thumbnailService.deleteThumbnail(videoId);
      await this.ffmpegService.createThumbnail(videoPath, undefined, videoId);
      this.logger.log(`Thumbnail regenerated for video ${videoId}`);
    } catch (error) {
      this.logger.warn(`Failed to regenerate thumbnail for video ${videoId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Set a video flag in the database
   * Used to track processing state (aspect_ratio_fixed, audio_normalized, etc.)
   */
  async setVideoFlag(
    videoId: string,
    flagName: 'aspect_ratio_fixed' | 'audio_normalized',
    value: 0 | 1,
  ): Promise<void> {
    const db = this.databaseService.getDatabase();
    db.prepare(`UPDATE videos SET ${flagName} = ? WHERE id = ?`).run(value, videoId);
    this.logger.log(`Set ${flagName} = ${value} for video ${videoId}`);
  }

  /**
   * Load analysis categories from config file
   * Throws error if categories not configured - forces proper initialization via Settings
   */
  private loadCategories(): any[] {
    // Analysis without categories is broken by definition — a missing/empty file
    // is a hard error, NO FALLBACKS.
    const categoriesPath = path.join(this.configService.getConfigDir(), 'analysis-categories.json');

    if (!fs.existsSync(categoriesPath)) {
      throw new Error(
        `Analysis categories file not found at ${categoriesPath}. Analysis cannot run without categories.`,
      );
    }

    const parsed = JSON.parse(fs.readFileSync(categoriesPath, 'utf8'));

    // Handle both formats: array directly or { categories: [...] }
    const categories = Array.isArray(parsed) ? parsed : parsed.categories;

    if (!categories || categories.length === 0) {
      throw new Error(
        `No analysis categories configured in ${categoriesPath}. Configure categories before analyzing.`,
      );
    }

    return categories;
  }
}
