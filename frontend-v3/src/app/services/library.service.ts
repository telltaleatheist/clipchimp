import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of, firstValueFrom } from 'rxjs';
import { map, catchError } from 'rxjs/operators';
import { VideoWeek, VideoItem } from '../models/video.model';
import { JobRequest } from '../models/task.model';
import { Library, NewLibrary } from '../models/library.model';
import { getApiBase } from '../core/runtime-url';

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}

export interface JobResponse {
  id: string;
  status: string;
  tasks: any[];
}

// Backend task types (different from frontend TaskType)
export type BackendTaskType =
  | 'get-info'
  | 'download'
  | 'import'
  | 'fix-aspect-ratio'
  | 'strip-black-bars'
  | 'normalize-audio'
  | 'process-video'
  | 'transcribe'
  | 'analyze'
  | 'analyze-webpage'
  | 'export-clip';

export interface BackendTask {
  type: BackendTaskType;
  options?: any;
}

export interface BackendJobRequest {
  url?: string;
  videoId?: string;
  videoPath?: string;
  displayName?: string;
  libraryId?: string;
  tasks: BackendTask[];
}

export interface BulkJobRequest {
  jobs: BackendJobRequest[];
}

// Video editor types (from legacy frontend)
export interface VideoInfo {
  originalPath: string;
  currentPath: string;
  clipsWeekFolder?: string;
  filename: string;
  durationSeconds?: number;
  isLinked: boolean;
  lastVerified: string;
}

export interface AnalysisFiles {
  analysis: string;
  analysisMetadata: string;
  transcriptSrt: string;
  transcriptTxt: string;
}

export interface AnalysisMetadata {
  analysisModel: string;
  transcriptionModel: string;
  categories: string[];
}

export interface AnalysisQuote {
  timestamp: string;
  timestampSeconds: number;
  text: string;
  significance: string;
}

export interface AnalysisSection {
  timeRange: string;
  startSeconds: number;
  endSeconds?: number;
  category: string;
  description: string;
  quotes: AnalysisQuote[];
}

export interface MuteSection {
  id: string;
  videoId: string;
  startSeconds: number;
  endSeconds: number;
  createdAt: string;
}

export interface ParsedAnalysisMetadata {
  id: string;
  title: string;
  createdAt: string;
  durationSeconds?: number;
  sections: AnalysisSection[];
}

export interface LibraryAnalysis {
  id: string;
  title: string;
  createdAt: string;
  archived: boolean;
  video: VideoInfo;
  files: AnalysisFiles;
  metadata: AnalysisMetadata;
  clips: string[];
}

export interface LibraryClip {
  id: string;
  analysisId: string;
  name: string;
  startSeconds: number;
  endSeconds: number;
  outputPath: string;
  createdAt: string;
  notes?: string;
}

@Injectable({
  providedIn: 'root'
})
export class LibraryService {
  private readonly API_BASE = getApiBase();

  // State management
  videos = signal<VideoItem[]>([]);
  selectedIds = signal<Set<string>>(new Set());
  loading = signal<boolean>(false);
  error = signal<string | null>(null);

  // Library management
  currentLibrary = signal<Library | null>(null);
  libraries = signal<Library[]>([]);

  // Library manager request - increment to trigger opening the library manager
  libraryManagerRequested = signal<number>(0);

  constructor(private http: HttpClient) {
    // Don't load here - let components control when to load
  }

  /**
   * Request to open the library manager (for use by child components)
   * Parent components should watch libraryManagerRequested signal and respond
   */
  requestLibraryManager(): void {
    this.libraryManagerRequested.update(n => n + 1);
  }

  /**
   * Load all videos from library
   * GET /api/database/videos
   */
  loadVideos(): Observable<ApiResponse<VideoItem[]>> {
    return this.http.get<any>(`${this.API_BASE}/database/videos`).pipe(
      map(response => ({
        success: true,
        data: this.transformVideos(response.videos || [])
      }))
    );
  }

  /**
   * Get videos organized by week
   * @param processingQueueIds - IDs of videos currently in the processing queue (to exclude from "Past 24 Hours")
   */
  getVideosByWeek(processingQueueIds: string[] = []): Observable<ApiResponse<VideoWeek[]>> {
    return this.http.get<any>(`${this.API_BASE}/database/videos`, {
      params: { includeRelationships: 'true' }
    }).pipe(
      map(response => {
        console.log('Raw API response:', response);
        const videos = this.transformVideos(response.videos || []);
        console.log('Transformed videos:', videos.length);
        const weeks = this.groupVideosByWeek(videos, processingQueueIds);
        console.log('Grouped into weeks:', weeks.length);
        return {
          success: true,
          data: weeks
        };
      })
    );
  }

  /**
   * Search videos
   * GET /api/database/search?q=query&searchIn=filename,transcript,analysis&useSoundex=true&usePhraseSearch=true
   */
  searchVideos(
    query: string,
    searchIn?: { filename: boolean; transcript: boolean; analysis: boolean },
    searchOptions?: { useSoundex: boolean; usePhraseSearch: boolean }
  ): Observable<ApiResponse<VideoItem[]>> {
    const params: any = { q: query };

    // Build comma-separated list of selected fields
    if (searchIn) {
      const fields: string[] = [];
      if (searchIn.filename) fields.push('filename');
      if (searchIn.transcript) fields.push('transcript');
      if (searchIn.analysis) fields.push('analysis');

      console.log('[searchVideos] searchIn received:', searchIn, 'fields:', fields);

      // Only pass searchIn if not all fields are selected
      if (fields.length > 0 && fields.length < 3) {
        params.searchIn = fields.join(',');
      }
    } else {
      console.log('[searchVideos] searchIn is undefined, searching all fields');
    }

    // Add search options
    if (searchOptions) {
      if (searchOptions.useSoundex) {
        params.useSoundex = 'true';
      }
      if (searchOptions.usePhraseSearch) {
        params.usePhraseSearch = 'true';
      }
    }

    console.log('[searchVideos] Final params:', params);

    return this.http.get<any>(
      `${this.API_BASE}/database/search`,
      { params }
    ).pipe(
      map(response => ({
        success: true,
        data: this.transformVideos(response.results || [])
      }))
    );
  }

  /**
   * Get single video with details
   * GET /api/database/videos/:id
   */
  getVideo(id: string): Observable<ApiResponse<VideoItem>> {
    return this.http.get<any>(`${this.API_BASE}/database/videos/${id}`).pipe(
      map(response => ({
        success: true,
        data: this.transformVideo(response.video || response)
      }))
    );
  }

  /**
   * Delete video from library
   * DELETE /api/database/videos/:id
   * @param mode - 'database-only' (keep file), 'file-only' (keep db entry), 'everything' (delete both)
   */
  deleteVideo(id: string, mode: 'database-only' | 'file-only' | 'everything' = 'everything'): Observable<ApiResponse<void>> {
    return this.http.delete<any>(`${this.API_BASE}/database/videos/${id}`, {
      body: { mode }
    }).pipe(
      map(response => ({
        success: response.success !== false,
        data: undefined
      }))
    );
  }

  /**
   * Transform backend video to frontend VideoItem format
   */
  private transformVideo(video: any): VideoItem {
    // Use poster for actual videos. For webpages, leave thumbnailUrl undefined
    // so the cascade renders the uniform 🌐 placeholder - all web archives
    // should look identical at a glance. Audio/document/image also have no
    // thumbnail because ffmpeg can't produce one.
    let thumbnailUrl: string | undefined;
    if (video.id && (!video.media_type || video.media_type === 'video')) {
      thumbnailUrl = `${this.API_BASE}/database/videos/${video.id}/stream?poster=1&t=${video.last_processed_date || video.added_at || '0'}`;
    }

    return {
      id: video.id,
      name: video.filename || video.name || 'Untitled',
      suggestedFilename: video.suggested_title || undefined,
      duration: this.formatDuration(video.duration || video.duration_seconds || 0),
      size: video.file_size || video.file_size_bytes,
      uploadDate: video.upload_date ? this.parseLocalDate(video.upload_date) : undefined,
      downloadDate: video.download_date ? this.parseLocalDate(video.download_date) : undefined,
      addedAt: video.added_at ? this.parseLocalDate(video.added_at) : undefined,
      lastProcessedDate: video.last_processed_date ? this.parseLocalDate(video.last_processed_date) : undefined,
      thumbnailUrl,
      // Additional fields for context menu actions
      filePath: video.file_path || video.filepath || video.current_path,
      // suggestedTitle is ONLY the AI-generated title suggestion. The MHTML
      // page title is exposed separately as webPageTitle so the cascade can
      // differentiate between "AI suggestion (editable)" and "page title
      // fallback (display only)" for web archive items.
      suggestedTitle: video.suggested_title || undefined,
      webPageTitle: video.wa_page_title || undefined,
      hasTranscript: video.has_transcript === 1 || video.has_transcript === true,
      hasAnalysis: video.has_analysis === 1 || video.has_analysis === true,
      hasConnections: video.has_connections === 1 || video.has_connections === true,
      // Searchable fields
      aiDescription: video.ai_description,
      sourceUrl: video.wa_original_url || video.source_url,
      tags: video.tags || [],
      // Media type info
      mediaType: video.media_type,
      fileExtension: video.file_extension,
      // Video metadata from ffprobe
      width: video.width,
      height: video.height,
      fps: video.fps,
      // Parent-child relationships (legacy model; video-info-page still reads
      // these — the cascade UI uses connections instead)
      parentIds: video.parent_ids || [],
      childIds: video.child_ids || [],
      children: video.children ? video.children.map((c: any) => this.transformVideo(c)) : [],
      parents: video.parents ? video.parents.map((p: any) => this.transformVideo(p)) : []
    };
  }

  /**
   * Transform array of backend videos
   */
  private transformVideos(videos: any[]): VideoItem[] {
    return videos.map(v => this.transformVideo(v));
  }

  /**
   * Parse date string as local time to avoid timezone shift
   * "2025-11-17" should display as Nov 17, not Nov 16
   */
  private parseLocalDate(dateStr: string): Date {
    // If it's an ISO string with time (e.g., "2025-11-17T12:00:00Z"), parse normally
    if (dateStr.includes('T')) {
      return new Date(dateStr);
    }
    // For date-only strings (e.g., "2025-11-17"), parse as local time
    const [year, month, day] = dateStr.split('-').map(Number);
    return new Date(year, month - 1, day);
  }

  /**
   * Format duration from seconds to hh:mm:ss
   */
  private formatDuration(seconds: number): string {
    if (!seconds || seconds <= 0) return '00:00:00';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    // Always show hh:mm:ss format
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Group videos by date (folder format) with special "Past 24 hours" section
   * Videos appear in "Past 24 Hours" based on lastProcessedDate (or downloadDate as fallback)
   * Excludes videos that are in the processing queue
   */
  private groupVideosByWeek(videos: VideoItem[], processingQueueIds: string[] = []): VideoWeek[] {
    const dateMap = new Map<string, VideoItem[]>();
    const now = new Date();
    const past24Hours: VideoItem[] = [];

    // Sort videos by most recent activity (lastProcessedDate or downloadDate)
    const sortedVideos = [...videos].sort((a, b) => {
      const dateA = (a.lastProcessedDate || a.downloadDate) ? new Date(a.lastProcessedDate || a.downloadDate!).getTime() : 0;
      const dateB = (b.lastProcessedDate || b.downloadDate) ? new Date(b.lastProcessedDate || b.downloadDate!).getTime() : 0;
      return dateB - dateA;
    });

    for (const video of sortedVideos) {
      if (!video.downloadDate) {
        const key = 'Unknown';
        if (!dateMap.has(key)) {
          dateMap.set(key, []);
        }
        dateMap.get(key)!.push(video);
        continue;
      }

      // Check if video should be in "New" section based on:
      // 1. Recently processed (lastProcessedDate within 24 hours), OR
      // 2. Recently added to library (addedAt within 24 hours)
      const isInProcessingQueue = processingQueueIds.includes(video.id);

      // Check if recently processed
      const processedDate = video.lastProcessedDate ? new Date(video.lastProcessedDate) : null;
      const processedHoursDiff = processedDate ? (now.getTime() - processedDate.getTime()) / (1000 * 60 * 60) : Infinity;
      const recentlyProcessed = processedHoursDiff <= 24;

      // Check if recently added to library (addedAt is when video was inserted into database)
      // This is more accurate than downloadDate for saved links imports
      const addedDate = video.addedAt ? new Date(video.addedAt) : null;
      const addedHoursDiff = addedDate ? (now.getTime() - addedDate.getTime()) / (1000 * 60 * 60) : Infinity;
      const recentlyAdded = addedHoursDiff <= 24;

      // Video is in "New" section if recently processed OR recently added (and not in queue)
      const isInNewSection = !isInProcessingQueue && (recentlyProcessed || recentlyAdded);

      if (isInNewSection) {
        past24Hours.push(video);
        // Don't also add to date group - video should only appear in one section
        continue;
      }

      // Add to date group based on download date (only if not in "New" section)
      const dateKey = this.getDateKey(new Date(video.downloadDate));
      if (!dateMap.has(dateKey)) {
        dateMap.set(dateKey, []);
      }
      dateMap.get(dateKey)!.push(video);
    }

    // Build result array
    const result: VideoWeek[] = [];

    // Add "New" section first if it has items
    if (past24Hours.length > 0) {
      result.push({
        weekLabel: 'New',
        videos: past24Hours
      });
    }

    // Convert date groups to array and sort by date (newest first)
    const dateGroups = Array.from(dateMap.entries())
      .map(([dateKey, dateVideos]) => ({
        weekLabel: dateKey,
        videos: dateVideos
      }))
      .sort((a, b) => {
        // Sort "Unknown" to the end
        if (a.weekLabel === 'Unknown') return 1;
        if (b.weekLabel === 'Unknown') return -1;
        // Sort dates descending (newest first)
        return b.weekLabel.localeCompare(a.weekLabel);
      });

    result.push(...dateGroups);

    return result;
  }

  /**
   * Get date key for the nearest Sunday to this date (YYYY-MM-DD format)
   * Mon-Wed go back to previous Sunday, Thu-Sat go forward to next Sunday
   * This groups all videos from the same week under one section header
   */
  private getDateKey(date: Date): string {
    const d = new Date(date);
    const dayOfWeek = d.getDay(); // 0 = Sunday, 1 = Monday, etc.

    if (dayOfWeek === 0) {
      // Already Sunday, use current day
    } else if (dayOfWeek <= 3) {
      // Monday-Wednesday: go back to previous Sunday
      d.setDate(d.getDate() - dayOfWeek);
    } else {
      // Thursday-Saturday: go forward to next Sunday
      d.setDate(d.getDate() + (7 - dayOfWeek));
    }

    const year = d.getFullYear();
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const day = d.getDate().toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * Get week key for grouping (format: YYYY-WW)
   */
  private getWeekKey(date?: Date): string {
    if (!date) return 'Unknown';
    const d = new Date(date);
    const year = d.getFullYear();
    const startOfYear = new Date(year, 0, 1);
    const days = Math.floor((d.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000));
    const weekNum = Math.ceil((days + startOfYear.getDay() + 1) / 7);
    return `${year}-${weekNum.toString().padStart(2, '0')}`;
  }

  /**
   * Format week key to readable label
   */
  private formatWeekLabel(weekKey: string): string {
    if (weekKey === 'Unknown') return 'Unknown Date';

    const [year, weekStr] = weekKey.split('-');
    const weekNum = parseInt(weekStr, 10);

    // Calculate the start date of the week
    const startOfYear = new Date(parseInt(year, 10), 0, 1);
    const daysOffset = (weekNum - 1) * 7 - startOfYear.getDay();
    const weekStart = new Date(startOfYear);
    weekStart.setDate(startOfYear.getDate() + daysOffset);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);

    const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
    const startStr = weekStart.toLocaleDateString('en-US', options);
    const endStr = weekEnd.toLocaleDateString('en-US', { ...options, year: 'numeric' });

    return `Week of ${startStr}-${endStr}`;
  }

  /**
   * Create a new job with tasks
   * POST /api/queue/jobs
   */
  createJob(request: BackendJobRequest): Observable<ApiResponse<JobResponse>> {
    return this.http.post<any>(
      `${this.API_BASE}/queue/jobs`,
      request
    ).pipe(
      map(response => ({
        success: response.success,
        data: {
          id: response.jobId,
          status: 'pending',
          tasks: request.tasks
        }
      }))
    );
  }

  /**
   * Create multiple jobs in bulk
   * POST /api/queue/jobs/bulk
   */
  createBulkJobs(jobs: BackendJobRequest[]): Observable<ApiResponse<{ jobIds: string[] }>> {
    return this.http.post<any>(
      `${this.API_BASE}/queue/jobs/bulk`,
      { jobs }
    ).pipe(
      map(response => ({
        success: response.success,
        data: {
          jobIds: response.jobIds || []
        }
      }))
    );
  }

  /**
   * Convert frontend task type to backend tasks
   * e.g., 'download-import' → ['get-info', 'download', 'import']
   */
  convertToBackendTasks(frontendTaskType: string, config?: any): BackendTask[] {
    switch (frontendTaskType) {
      case 'download-import':
        return [
          { type: 'get-info' },
          { type: 'download', options: config?.download || {} },
          { type: 'import', options: config?.import || {} }
        ];

      case 'fix-aspect-ratio':
        return [{ type: 'fix-aspect-ratio', options: config || {} }];

      case 'normalize-audio':
        return [{
          type: 'normalize-audio',
          options: {
            level: config?.targetLevel || -16,
            method: config?.method || 'ebu-r128'
          }
        }];

      case 'transcribe':
        return [{
          type: 'transcribe',
          options: {
            model: config?.model || 'base',
            language: config?.language || 'en'
          }
        }];

      case 'ai-analyze':
        // Parse model value in format "provider:model" (e.g., "ollama:qwen2.5:7b", "openai:gpt-4o")
        // NO DEFAULT - user must explicitly select an AI model
        if (!config?.aiModel) {
          throw new Error('AI analysis requires an AI model to be selected. Please select a model in the configuration.');
        }
        const modelValue = config.aiModel;
        let aiProvider = 'ollama';
        let aiModel = modelValue;

        if (modelValue.includes(':')) {
          const colonIndex = modelValue.indexOf(':');
          aiProvider = modelValue.substring(0, colonIndex);
          aiModel = modelValue.substring(colonIndex + 1);
        }

        return [{
          type: 'analyze',
          options: {
            aiModel,
            aiProvider,
            customInstructions: config?.customInstructions || '',
            // Forwarded ONLY when a caller explicitly set it — see queue.service's
            // copy of this comment. Nothing in the UI sets it any more.
            analysisGranularity: config?.analysisGranularity,
            analysisQuality: config?.analysisQuality || 'fast'
          }
        }];

      case 'analyze-webpage':
        if (!config?.aiModel) {
          throw new Error('Webpage analysis requires an AI model to be selected. Please select a model in the configuration.');
        }
        const webModelValue = config.aiModel;
        let webProvider = 'ollama';
        let webModel = webModelValue;
        if (webModelValue.includes(':')) {
          const colonIndex = webModelValue.indexOf(':');
          webProvider = webModelValue.substring(0, colonIndex);
          webModel = webModelValue.substring(colonIndex + 1);
        }
        return [{
          type: 'analyze-webpage',
          options: {
            aiModel: webModel,
            aiProvider: webProvider,
          }
        }];

      default:
        console.warn(`Unknown task type: ${frontendTaskType}`);
        return [];
    }
  }

  /**
   * Quick add from URL (uses default task preset)
   * POST /api/queue/quick-add
   */
  quickAddUrl(url: string, pageTitle?: string): Observable<ApiResponse<JobResponse>> {
    return this.http.post<ApiResponse<JobResponse>>(
      `${this.API_BASE}/queue/quick-add`,
      { url, pageTitle }
    );
  }

  /**
   * Get queue status
   * GET /api/queue/status
   */
  getQueueStatus(): Observable<ApiResponse<any>> {
    return this.http.get<any>(`${this.API_BASE}/queue/status`).pipe(
      map(response => ({
        success: response.success,
        data: response.status
      }))
    );
  }

  /**
   * Get all jobs in queue
   * GET /api/queue/jobs
   */
  getQueueJobs(): Observable<ApiResponse<any[]>> {
    return this.http.get<any>(`${this.API_BASE}/queue/jobs`).pipe(
      map(response => ({
        success: response.success,
        data: response.jobs || []
      }))
    );
  }

  /**
   * Get a specific job
   * GET /api/queue/job/:jobId
   */
  getJob(jobId: string): Observable<ApiResponse<any>> {
    return this.http.get<any>(`${this.API_BASE}/queue/job/${jobId}`).pipe(
      map(response => ({
        success: response.success,
        data: response.job
      }))
    );
  }

  /**
   * Update filename for a video
   * PATCH /api/library/videos/:id
   */
  updateVideoFilename(id: string, filename: string): Observable<ApiResponse<VideoItem>> {
    return this.http.patch<ApiResponse<VideoItem>>(
      `${this.API_BASE}/library/videos/${id}`,
      { filename }
    );
  }

  /**
   * Update suggested title for a video
   * PATCH /api/database/videos/:id/suggested-title
   */
  updateSuggestedTitle(id: string, suggestedTitle: string): Observable<ApiResponse<any>> {
    return this.http.patch<ApiResponse<any>>(
      `${this.API_BASE}/database/videos/${id}/suggested-title`,
      { suggestedTitle }
    );
  }

  /**
   * Rename video file (renames both database record AND physical file)
   * PATCH /api/database/videos/:id/filename
   */
  renameVideoFile(id: string, filename: string): Observable<ApiResponse<any>> {
    return this.http.patch<ApiResponse<any>>(
      `${this.API_BASE}/database/videos/${id}/filename`,
      { filename }
    );
  }

  /**
   * Accept suggested title - renames file and clears suggested title
   * POST /api/database/videos/:id/accept-suggested-title
   */
  acceptSuggestedTitle(id: string, customFilename: string): Observable<ApiResponse<any>> {
    return this.http.post<ApiResponse<any>>(
      `${this.API_BASE}/database/videos/${id}/accept-suggested-title`,
      { customFilename }
    );
  }

  /**
   * Clear/reject the AI-suggested title from the database
   * POST /api/database/videos/:id/reject-suggested-title
   */
  clearSuggestedTitle(id: string): Observable<ApiResponse<any>> {
    return this.http.post<ApiResponse<any>>(
      `${this.API_BASE}/database/videos/${id}/reject-suggested-title`,
      {}
    );
  }

  /**
   * Remove parent-child relationship between two videos
   * POST /api/database/videos/:parentId/remove-child/:childId
   */
  removeParentChildRelationship(parentId: string, childId: string): Observable<ApiResponse<any>> {
    return this.http.post<ApiResponse<any>>(
      `${this.API_BASE}/database/videos/${parentId}/remove-child/${childId}`,
      {}
    );
  }

  /**
   * Get the .briefcaseignore file content
   * GET /api/database/ignore
   */
  getIgnoreFile(): Observable<ApiResponse<{ content: string; filePath: string; patterns: string[] }>> {
    return this.http.get<ApiResponse<{ content: string; filePath: string; patterns: string[] }>>(
      `${this.API_BASE}/database/ignore`
    );
  }

  /**
   * Update the .briefcaseignore file content
   * POST /api/database/ignore
   */
  updateIgnoreFile(content: string): Observable<ApiResponse<any>> {
    return this.http.post<ApiResponse<any>>(
      `${this.API_BASE}/database/ignore`,
      { content }
    );
  }

  /**
   * Add a pattern to the .briefcaseignore file
   * POST /api/database/ignore/add
   */
  addIgnorePattern(pattern: string): Observable<ApiResponse<any>> {
    return this.http.post<ApiResponse<any>>(
      `${this.API_BASE}/database/ignore/add`,
      { pattern }
    );
  }

  /**
   * Scan database for ignored entries and remove them
   * POST /api/database/scan-ignored
   */
  scanAndRemoveIgnored(): Observable<ApiResponse<{ removed: string[]; message: string }>> {
    return this.http.post<ApiResponse<{ removed: string[]; message: string }>>(
      `${this.API_BASE}/database/scan-ignored`,
      {}
    );
  }

  // Local state management helpers
  selectVideo(id: string) {
    const selected = new Set(this.selectedIds());
    selected.add(id);
    this.selectedIds.set(selected);
  }

  deselectVideo(id: string) {
    const selected = new Set(this.selectedIds());
    selected.delete(id);
    this.selectedIds.set(selected);
  }

  toggleVideoSelection(id: string) {
    if (this.selectedIds().has(id)) {
      this.deselectVideo(id);
    } else {
      this.selectVideo(id);
    }
  }

  clearSelection() {
    this.selectedIds.set(new Set());
  }

  isVideoSelected(id: string): boolean {
    return this.selectedIds().has(id);
  }

  // Library management methods
  // Note: Library management endpoints are on /api/database, not /api/library

  /**
   * Get all libraries
   * GET /api/database/libraries
   */
  getLibraries(): Observable<ApiResponse<Library[]>> {
    return this.http.get<any>(`${this.API_BASE}/database/libraries`).pipe(
      map(response => ({
        success: true,
        data: response.libraries || []
      }))
    );
  }

  /**
   * Get current active library
   * GET /api/database/libraries/active
   */
  getCurrentLibrary(): Observable<ApiResponse<Library>> {
    return this.http.get<any>(`${this.API_BASE}/database/libraries/active`).pipe(
      map(response => {
        // Update the signal when we get the current library
        if (response.library) {
          this.currentLibrary.set(response.library);
        }
        return {
          success: !!response.library,
          data: response.library
        };
      })
    );
  }

  /**
   * Switch to a different library
   * POST /api/database/libraries/:id/switch
   */
  switchLibrary(libraryId: string): Observable<ApiResponse<Library>> {
    return this.http.post<any>(`${this.API_BASE}/database/libraries/${libraryId}/switch`, {}).pipe(
      map(response => {
        // Update the signal when switching libraries
        if (response.success && response.library) {
          this.currentLibrary.set(response.library);
        }
        return {
          success: response.success,
          data: response.library
        };
      })
    );
  }

  /**
   * Create a new library
   * POST /api/database/libraries
   */
  createLibrary(library: NewLibrary): Observable<ApiResponse<Library>> {
    return this.http.post<any>(`${this.API_BASE}/database/libraries`, {
      name: library.name,
      clipsFolderPath: library.path
    }).pipe(
      map(response => {
        // Update the signal when creating a new library (it becomes active)
        if (response.success && response.library) {
          this.currentLibrary.set(response.library);
        }
        return {
          success: response.success,
          data: response.library
        };
      })
    );
  }

  /**
   * Open an existing library from a path containing .library.db
   * POST /api/database/libraries/open
   */
  openLibrary(path: string): Observable<ApiResponse<Library>> {
    return this.http.post<any>(
      `${this.API_BASE}/database/libraries/open`,
      { clipsFolderPath: path }
    ).pipe(
      map(response => {
        if (!response.success) {
          throw new Error(response.error || 'Failed to open library');
        }
        return {
          success: true,
          data: response.library
        };
      })
    );
  }

  /**
   * @deprecated Use openLibrary instead
   */
  importLibrary(path: string): Observable<ApiResponse<Library>> {
    return this.openLibrary(path);
  }

  /**
   * Update a library's name and path
   * PUT /api/database/libraries/:id
   */
  updateLibrary(libraryId: string, name: string, path: string): Observable<ApiResponse<Library>> {
    return this.http.put<any>(`${this.API_BASE}/database/libraries/${libraryId}`, { name, path }).pipe(
      map(response => ({
        success: response.success,
        data: response.library
      }))
    );
  }

  /**
   * Delete a library
   * DELETE /api/database/libraries/:id
   */
  deleteLibrary(libraryId: string): Observable<ApiResponse<void>> {
    return this.http.delete<any>(`${this.API_BASE}/database/libraries/${libraryId}`).pipe(
      map(response => ({
        success: response.success,
        data: undefined
      }))
    );
  }

  /**
   * Load current library from backend
   */
  private loadCurrentLibrary(): void {
    this.getCurrentLibrary().subscribe({
      next: (response) => {
        if (response.success) {
          this.currentLibrary.set(response.data);
        }
      },
      error: (error) => {
        console.error('Failed to load current library:', error);
      }
    });
  }

  /**
   * Refresh libraries list
   */
  refreshLibraries(): void {
    this.getLibraries().subscribe({
      next: (response) => {
        if (response.success) {
          this.libraries.set(response.data);
        }
      },
      error: (error) => {
        console.error('Failed to load libraries:', error);
      }
    });
  }

  // Video editor methods

  /**
   * Extract a clip from video
   */
  extractClip(analysisId: string, clipData: any): Promise<any> {
    return firstValueFrom(
      this.http.post(`${this.API_BASE}/library/analyses/${analysisId}/clips`, clipData)
    );
  }

  /**
   * Auto-relink video to find new path
   */
  autoRelinkVideo(analysisId: string): Promise<any> {
    return firstValueFrom(
      this.http.post(`${this.API_BASE}/library/analyses/${analysisId}/relink/auto`, {})
    );
  }

  /**
   * Manually relink video to new path
   */
  manualRelinkVideo(analysisId: string, newPath: string): Promise<any> {
    return firstValueFrom(
      this.http.post(`${this.API_BASE}/library/analyses/${analysisId}/relink/manual`, { newPath })
    );
  }

  /**
   * Get analysis by ID
   */
  getAnalysis(id: string): Promise<LibraryAnalysis> {
    return firstValueFrom(
      this.http.get<LibraryAnalysis>(`${this.API_BASE}/library/analyses/${id}`)
    );
  }

  /**
   * Get all analyses
   */
  async getAnalyses(archived?: boolean): Promise<LibraryAnalysis[]> {
    const params: Record<string, string> = {};
    if (archived !== undefined) {
      params['archived'] = archived.toString();
    }
    return firstValueFrom(
      this.http.get<LibraryAnalysis[]>(`${this.API_BASE}/library/analyses`, { params })
    );
  }

  /**
   * Get video transcript by video ID
   * GET /api/database/videos/:id/transcript
   */
  getVideoTranscript(videoId: string): Observable<ApiResponse<any>> {
    return this.http.get<any>(`${this.API_BASE}/database/videos/${videoId}/transcript`).pipe(
      map(response => ({
        success: true,
        data: response.transcript || response
      })),
      catchError(error => {
        if (error.status === 404) {
          return of({ success: true, data: null });
        }
        throw error;
      })
    );
  }

  /**
   * Get video analysis by video ID
   * GET /api/database/videos/:id/analysis
   */
  getVideoAnalysis(videoId: string): Observable<ApiResponse<any>> {
    return this.http.get<any>(`${this.API_BASE}/database/videos/${videoId}/analysis`).pipe(
      map(response => ({
        success: true,
        data: response.analysis || response
      })),
      catchError(error => {
        if (error.status === 404) {
          return of({ success: true, data: null });
        }
        throw error;
      })
    );
  }

  /**
   * Get video tags by video ID
   * GET /api/database/videos/:id/tags
   */
  getVideoTags(videoId: string): Observable<ApiResponse<string[]>> {
    return this.http.get<any>(`${this.API_BASE}/database/videos/${videoId}/tags`).pipe(
      map(response => ({
        success: true,
        data: response.tags || []
      }))
    );
  }

  /**
   * Get video analysis sections by video ID
   * GET /api/database/videos/:id/sections
   */
  getVideoSections(videoId: string): Observable<ApiResponse<any[]>> {
    return this.http.get<any>(`${this.API_BASE}/database/videos/${videoId}/sections`).pipe(
      map(response => ({
        success: true,
        data: response.sections || []
      }))
    );
  }

  // =====================================================
  // MUTE SECTIONS
  // =====================================================

  /**
   * Get mute sections for a video
   * GET /api/database/videos/:id/mute-sections
   */
  getMuteSections(videoId: string): Observable<ApiResponse<MuteSection[]>> {
    return this.http.get<{ sections: any[]; count: number }>(
      `${this.API_BASE}/database/videos/${videoId}/mute-sections`
    ).pipe(
      map(response => ({
        success: true,
        data: (response.sections || []).map((s: any) => ({
          id: s.id,
          videoId: s.video_id,
          startSeconds: s.start_seconds,
          endSeconds: s.end_seconds,
          createdAt: s.created_at
        }))
      })),
      catchError(error => {
        console.error('Failed to get mute sections:', error);
        return of({ success: false, data: [] });
      })
    );
  }

  /**
   * Add a mute section to a video
   * POST /api/database/videos/:id/mute-sections
   */
  addMuteSection(videoId: string, startSeconds: number, endSeconds: number): Observable<ApiResponse<{ id: string }>> {
    return this.http.post<{ success: boolean; id?: string; error?: string }>(
      `${this.API_BASE}/database/videos/${videoId}/mute-sections`,
      { startSeconds, endSeconds }
    ).pipe(
      map(response => ({
        success: response.success,
        data: { id: response.id || '' },
        error: response.error
      })),
      catchError(error => {
        console.error('Failed to add mute section:', error);
        return of({ success: false, data: { id: '' }, error: error.message });
      })
    );
  }

  /**
   * Delete a mute section
   * DELETE /api/database/mute-sections/:id
   */
  deleteMuteSection(sectionId: string): Observable<ApiResponse<void>> {
    return this.http.delete<{ success: boolean; error?: string }>(
      `${this.API_BASE}/database/mute-sections/${sectionId}`
    ).pipe(
      map(response => ({
        success: response.success,
        data: undefined,
        error: response.error
      })),
      catchError(error => {
        console.error('Failed to delete mute section:', error);
        return of({ success: false, data: undefined, error: error.message });
      })
    );
  }

  /**
   * Update a mute section's start/end times
   * PATCH /api/database/mute-sections/:id
   */
  updateMuteSection(sectionId: string, startSeconds: number, endSeconds: number): Observable<ApiResponse<MuteSection>> {
    return this.http.patch<{ success: boolean; section?: any; error?: string }>(
      `${this.API_BASE}/database/mute-sections/${sectionId}`,
      { startSeconds, endSeconds }
    ).pipe(
      map(response => ({
        success: response.success,
        data: response.section ? {
          id: response.section.id,
          videoId: '',
          startSeconds: response.section.startSeconds,
          endSeconds: response.section.endSeconds,
          createdAt: ''
        } : {} as MuteSection,
        error: response.error
      })),
      catchError(error => {
        console.error('Failed to update mute section:', error);
        return of({ success: false, data: {} as MuteSection, error: error.message });
      })
    );
  }

  /**
   * Get video info from URL (title, duration, etc.)
   * GET /api/downloader/info?url=...
   *
   * Honest semantics (fallback-audit #14): a failed lookup propagates as an
   * error — it never fabricates a "Unknown Video" title that then gets
   * displayed (or persisted) as if it were real data. Callers should show
   * the URL and surface the failure.
   */
  getVideoInfo(url: string): Observable<ApiResponse<{ title: string; duration?: number; thumbnail?: string }>> {
    return this.http.get<any>(`${this.API_BASE}/downloader/info`, {
      params: { url }
    }).pipe(
      map(response => {
        if (response.error || !response.title) {
          throw new Error(response.error || `No title returned for ${url}`);
        }
        return {
          success: true,
          data: {
            title: response.title as string,
            duration: response.duration,
            thumbnail: response.thumbnail
          }
        };
      })
    );
  }

  /**
   * Get default AI settings
   * GET /api/config/default-ai
   */
  getDefaultAI(): Observable<{ success: boolean; defaultAI: { provider: string; model: string } | null }> {
    return this.http.get<{ success: boolean; defaultAI: { provider: string; model: string } | null }>(
      `${this.API_BASE}/config/default-ai`
    );
  }

  /**
   * Save default AI settings
   * POST /api/config/default-ai
   */
  saveDefaultAI(provider: string, model: string): Observable<{ success: boolean; message: string; defaultAI: { provider: string; model: string } }> {
    return this.http.post<{ success: boolean; message: string; defaultAI: { provider: string; model: string } }>(
      `${this.API_BASE}/config/default-ai`,
      { provider, model }
    );
  }

  /*
   * getDefaultGranularity / saveDefaultGranularity USED TO LIVE HERE and were
   * removed when the sensitivity slider came out of the three run-config
   * surfaces (operator, 2026-08-25: "not sure we need the 1-5 run slider anymore
   * after we've turned it into a filter").
   *
   * `defaultGranularity` still exists in app-config.json and the backend still
   * exposes GET/POST /config/default-granularity, because the DISCOVERY fallback
   * flag path still reads it as a real run input. It is now a config-file-only
   * setting with no UI in front of it. The flag filter that replaced the slider
   * is a display control and persists its own position locally — see
   * models/flag-filter.ts.
   */

  // =====================================================
  // CUSTOM INSTRUCTIONS HISTORY
  // =====================================================

  /**
   * Get custom instructions history (last 25)
   * GET /api/database/custom-instructions-history
   */
  getCustomInstructionsHistory(): Observable<{ success: boolean; history: Array<{ id: number; instruction_text: string; used_at: string; use_count: number }> }> {
    return this.http.get<{ success: boolean; history: any[] }>(
      `${this.API_BASE}/database/custom-instructions-history`
    );
  }

  /**
   * Save custom instruction to history
   * POST /api/database/custom-instructions-history
   */
  saveCustomInstruction(instruction: string): Observable<{ success: boolean; message: string }> {
    return this.http.post<{ success: boolean; message: string }>(
      `${this.API_BASE}/database/custom-instructions-history`,
      { instruction }
    );
  }

  /**
   * Clear custom instructions history
   * DELETE /api/database/custom-instructions-history
   */
  clearCustomInstructionsHistory(): Observable<{ success: boolean; message: string }> {
    return this.http.delete<{ success: boolean; message: string }>(
      `${this.API_BASE}/database/custom-instructions-history`
    );
  }
}
