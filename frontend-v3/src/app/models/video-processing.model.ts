// Video Processing Models

export interface VideoJob {
  id: string;
  videoId?: string; // Actual video ID from library (different from job id)
  videoUrl?: string;
  videoPath?: string;
  videoName: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'paused';
  addedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  settings: VideoJobSettings;
  tasks: VideoTask[];
  progress: number; // Overall progress 0-100
  thumbnail?: string;
  duration?: number; // in seconds
  fileSize?: number; // in bytes
}

export interface VideoJobSettings {
  fixAspectRatio: boolean;
  aspectRatio?: '16:9' | '4:3' | '1:1' | '9:16';
  normalizeAudio: boolean;
  audioLevel?: number; // Target loudness in LUFS (-24 quiet to -14 loud, default -16)
  transcribe: boolean;
  whisperModel?: 'tiny' | 'base' | 'small' | 'medium' | 'large';
  whisperLanguage?: string;
  whisperTranslate?: boolean; // Translate to English
  aiAnalysis: boolean;
  aiModel?: string; // Full model ID from available models
  customInstructions?: string;
  /**
   * 1-5 sensitivity. OPTIONAL AND NO LONGER SET BY ANY UI — the slider was
   * removed from every run-config surface when the dial became a display filter
   * (see models/flag-filter.ts). It survives on the request model for API
   * compatibility: the backend still accepts it, and the DISCOVERY fallback flag
   * path still honors it. When absent, that path falls back to the config file's
   * `defaultGranularity` and then to its own default of 2.
   */
  analysisGranularity?: number;
  analysisQuality?: 'fast' | 'thorough'; // fast = single-pass (cheaper), thorough = multi-pass (better)
  outputFormat?: 'mp4' | 'webm' | 'mov' | 'avi';
  outputQuality?: 'low' | 'medium' | 'high' | 'ultra';
  /**
   * Max download resolution passed to yt-dlp as a height cap
   * (bestvideo[height<=N]+bestaudio per-site). 'best' (or absent) omits the
   * cap and keeps the site default behavior.
   */
  downloadQuality?: '480' | '720' | '1080' | 'best';
}

export interface VideoTask {
  id: string;
  type: 'download' | 'import' | 'aspect-ratio' | 'normalize-audio' | 'transcribe' | 'ai-analysis';
  name: string;
  status: 'pending' | 'in-progress' | 'completed' | 'failed' | 'skipped';
  progress: number; // 0-100
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
  result?: any;
  estimatedTime?: number; // in seconds
}

export interface BatchSettings {
  applyToAll: boolean;
  selectedJobs: string[];
  settings: Partial<VideoJobSettings>;
}

export interface QueueStats {
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  processingJobs: number;
  queuedJobs: number;
  averageProcessingTime: number;
  estimatedTimeRemaining: number;
}

export interface ProcessingWebSocketMessage {
  jobId: string;
  taskId?: string;
  type: 'progress' | 'status' | 'error' | 'complete';
  data: {
    progress?: number;
    status?: string;
    error?: string;
    result?: any;
  };
}