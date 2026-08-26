import { TranscriptionSegment } from './video-info.model';

export interface VideoEditorState {
  currentTime: number; // seconds
  duration: number; // seconds
  isPlaying: boolean;
  volume: number; // 0-1
  playbackRate: number; // 0.5, 1, 1.5, 2, etc.
  zoomState: ZoomState; // timeline zoom level and offset
  selectedClip?: VideoClip;
  selectedSection?: TimelineSection;
  selection?: TimelineSelection;
}

export interface ZoomState {
  level: number; // 1 = 100%, 2 = 200%, etc.
  offset: number; // Offset in seconds for panning when zoomed
}

export interface TimelineSelection {
  startTime: number;
  endTime: number;
}

export interface TimelineSection {
  id: string;
  startTime: number;
  endTime: number;
  category: string;
  description: string;
  color: string;
  /**
   * The flag verifier's answer for this passage and category — 'flag' when it
   * judged the speaker to be asserting the claim, 'skip' when it judged them to
   * be reporting, quoting, questioning or opposing it.
   *
   * The analysis stores BOTH, so the display filter can show or hide the
   * rejections without a re-run. NULL on legacy rows, on custom markers and on
   * the discovery fallback path, and NULL is read as 'flag' everywhere — see
   * models/flag-filter.ts.
   */
  verdict?: 'flag' | 'skip' | null;
  /**
   * The NLI ranker's score for this section's category, 0-1 — the number the
   * STRICT (>= 0.9) and MODERATE (>= 0.7) filter positions threshold on. NULL
   * wherever there is no ranker score, and NULL passes every position.
   */
  nliScore?: number | null;
}

export interface TimelineChapter {
  id: string;
  videoId: string;
  sequence: number;
  startTime: number;
  endTime: number;
  title: string;
  description?: string;
  source: 'ai' | 'user';
}

export interface AnalysisSection {
  timeRange: string; // e.g., "00:09 - 00:12"
  startSeconds: number;
  endSeconds?: number;
  category: string;
  description: string;
}

export interface CategoryFilter {
  category: string;
  label: string;
  color: string;
  enabled: boolean;
}

export interface AnalysisData {
  id: string;
  title: string;
  summary?: string;
  sections: AnalysisSection[];
  quotes?: AnalysisQuote[];
}

export interface AnalysisQuote {
  timestamp: string;
  timestampSeconds: number;
  text: string;
  significance: string;
}

export interface VideoClip {
  id: string;
  name: string;
  url: string;
  thumbnailUrl?: string;
  duration: number;
  startTime: number; // position on timeline
  endTime: number;
  trimStart?: number; // trim from beginning
  trimEnd?: number; // trim from end
  track: number; // which track it's on
  volume: number;
  waveformData?: WaveformData;
}

export interface WaveformData {
  samples: number[]; // amplitude values 0-1
  sampleRate: number;
  duration: number;
}

export interface TimelineMarker {
  id: string;
  time: number;
  label: string;
  color?: string;
}

export interface CustomMarker {
  id: string;
  videoId: string;
  startTime: number;
  endTime?: number;
  message: string;
  createdAt: Date;
  category?: string;
}

export interface MuteSection {
  id: string;
  videoId: string;
  startSeconds: number;
  endSeconds: number;
  createdAt: string;
}

export interface VideoMetadata {
  filename: string;
  format: string;
  resolution: string;
  frameRate: number;
  bitrate: string;
  codec: string;
  fileSize: number;
  duration: number;
  createdDate: Date;
}

export interface EditorSettings {
  snapToGrid: boolean;
  gridSize: number; // seconds
  autoSave: boolean;
  waveformColor: string;
  timelineHeight: number;
  showThumbnails: boolean;
  audioMonitoring: boolean;
}

export interface TimelineZoom {
  level: number; // 1 = 1 second = 100px, 2 = 1 second = 200px, etc.
  min: number;
  max: number;
}

export interface PlayheadPosition {
  time: number;
  pixelPosition: number;
}

/**
 * Represents a single tab in the video editor.
 * Each tab maintains its own isolated state for a video.
 */
export interface EditorTab {
  id: string;                           // Unique tab identifier
  videoId: string;                      // Database video ID
  videoPath: string | null;             // Path to video file
  videoTitle: string;                   // Display title for tab
  videoUrl: string | undefined;         // Streaming URL

  // Editor state
  editorState: VideoEditorState;

  // Data loaded from backend
  sections: TimelineSection[];
  chapters: TimelineChapter[];
  customMarkers: CustomMarker[];
  muteSections: MuteSection[];
  waveformData: WaveformData;
  transcript: TranscriptionSegment[];
  analysisData: AnalysisData | null;

  // UI state
  highlightSelection: TimelineSelection | null;
  categoryFilters: CategoryFilter[];
  hasAnalysis: boolean;
  isLoaded: boolean;                    // Whether data has been loaded from backend

  // Video zoom/crop state
  videoScale: number;
  showBorder: boolean;
  borderAspectRatio: '16:9' | '4:3' | '9:16';
}

/**
 * Helper to create a new EditorTab with default values
 */
export function createEditorTab(
  videoId: string,
  videoPath: string | null,
  videoTitle: string,
  videoUrl: string | undefined
): EditorTab {
  return {
    id: `tab-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
    videoId,
    videoPath,
    videoTitle,
    videoUrl,
    editorState: {
      currentTime: 0,
      duration: 120,
      isPlaying: false,
      volume: 1,
      playbackRate: 1,
      zoomState: { level: 1, offset: 0 }
    },
    sections: [],
    chapters: [],
    customMarkers: [],
    muteSections: [],
    waveformData: {
      samples: [],
      sampleRate: 44100,
      duration: 0
    },
    transcript: [],
    analysisData: null,
    highlightSelection: null,
    categoryFilters: [],
    hasAnalysis: false,
    isLoaded: false,
    videoScale: 1.0,
    showBorder: false,
    borderAspectRatio: '16:9',
  };
}
