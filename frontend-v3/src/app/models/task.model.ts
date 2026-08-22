export type TaskType = 'download-import' | 'fix-aspect-ratio' | 'normalize-audio' | 'transcribe' | 'ai-analyze' | 'analyze-webpage' | 'export-clip';

export interface Task {
  type: TaskType;
  label: string;
  description: string;
  icon: string;
  requiresUrl: boolean;  // Only available for URL inputs
  requiresFile: boolean;  // Only available for file inputs
}

export interface TaskSelection {
  task: Task;
  selected: boolean;
  config?: TaskConfig;
}

export interface TaskConfig {
  [key: string]: any;
}

// Task-specific configuration options
export interface DownloadImportConfig {
  quality?: '2160' | '1440' | '1080' | '720' | '480' | 'best';
  format?: 'mp4' | 'webm' | 'mkv';
}

export interface TranscribeConfig {
  model?: 'tiny' | 'base' | 'small' | 'medium' | 'large';
  language?: string;
  translate?: boolean;
}

export type AnalysisQuality = 'fast' | 'thorough';

export interface AIAnalyzeConfig {
  aiModel?: string; // Dynamic model string like "ollama:qwen2.5:7b" or "claude:claude-3-sonnet"
  customInstructions?: string;
  analysisGranularity?: number; // 1-3: 1 = strong matches only, 3 = aggressive
  generateSummary?: boolean;
  extractKeyPoints?: boolean;
  analysisQuality?: AnalysisQuality; // 'fast' = single-pass (cheaper), 'thorough' = multi-pass (better quotes)
}

export interface FixAspectRatioConfig {
  targetRatio?: '16:9' | '4:3' | '1:1' | '9:16' | 'auto';
  cropMode?: 'center' | 'smart' | 'letterbox';
  stripBlackBars?: boolean;
}

export interface NormalizeAudioConfig {
  targetLevel?: number; // dB, typically -16 to -23
  peakLevel?: number;
}

export interface JobRequest {
  inputType: 'url' | 'files';
  url?: string;
  fileIds?: string[];
  tasks: TaskType[];
}

export const AVAILABLE_TASKS: Task[] = [
  {
    type: 'download-import',
    label: 'Download and Import',
    description: 'Download video from URL and add to library',
    icon: '⬇️',
    requiresUrl: true,
    requiresFile: false
  },
  {
    type: 'fix-aspect-ratio',
    label: 'Fix Aspect Ratio',
    description: 'Correct video aspect ratio issues',
    icon: '📐',
    requiresUrl: false,
    requiresFile: true
  },
  {
    type: 'normalize-audio',
    label: 'Normalize Audio',
    description: 'Normalize audio levels to standard volume',
    icon: '🔊',
    requiresUrl: false,
    requiresFile: true
  },
  {
    type: 'transcribe',
    label: 'Transcribe',
    description: 'Generate transcript using Whisper',
    icon: '📝',
    requiresUrl: false,
    requiresFile: true
  },
  {
    type: 'ai-analyze',
    label: 'AI Analyze',
    description: 'Analyze content with AI (GPT-4/Claude)',
    icon: '🤖',
    requiresUrl: false,
    requiresFile: true
  }
];
