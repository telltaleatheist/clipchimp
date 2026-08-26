import { Injectable, Logger } from '@nestjs/common';
import * as Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { ThumbnailService } from './thumbnail.service';

// Type definitions for database records
export interface VideoRecord {
  id: string;
  filename: string;
  file_hash: string;
  current_path: string;
  upload_date: string | null;
  download_date: string;
  duration_seconds: number | null;
  file_size_bytes: number | null;
  ai_description: string | null;
  source_url: string | null;
  last_verified: string;
  added_at: string;
  is_linked: number;
  media_type: string;
  file_extension: string | null;
  last_processed_date: string | null;
  parent_id: string | null;
  aspect_ratio_fixed: number;
  audio_normalized: number;
  suggested_title?: string | null;
  date_folder?: string | null;
  title?: string | null;
  // Video metadata
  width?: number | null;
  height?: number | null;
  fps?: number | null;
}

export interface VideoRecordWithFlags extends VideoRecord {
  has_transcript: number;
  has_analysis: number;
  has_children: number;
  has_connections: number;
}

export interface TranscriptRecord {
  video_id: string;
  plain_text: string;
  srt_format: string | null;
  whisper_model: string | null;
  language: string | null;
  transcribed_at: string;
  transcription_time_seconds: number | null;
}

export interface AnalysisRecord {
  video_id: string;
  ai_analysis: string;
  summary: string | null;
  sections_count: number | null;
  ai_model: string;
  ai_provider: string | null;
  analyzed_at: string;
  analysis_time_seconds: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  estimated_cost: number | null;
  api_calls: number | null;
}

export interface AnalysisSectionRecord {
  id: string;
  video_id: string;
  start_seconds: number;
  end_seconds: number;
  timestamp_text: string | null;
  title: string | null;
  description: string | null;
  category: string | null;
  source: string;
  /**
   * The flag verifier's answer for this (passage, category): 'flag' when it
   * judged the speaker to be asserting the claim, 'skip' when it judged them to
   * be reporting, quoting, questioning or opposing it.
   *
   * NULL means LEGACY — a row written before verdicts were stored, or by the
   * discovery fallback path, which produces no rejected candidates. Readers
   * treat NULL as 'flag'.
   */
  verdict: 'flag' | 'skip' | null;
  /**
   * The NLI ranker's score for the category this row carries, 0-1. NULL on
   * legacy and discovery rows; readers treat NULL as passing every filter
   * threshold so old data renders unchanged.
   */
  nli_score: number | null;
}

/**
 * One cached answer from the flag verifier, keyed by the QUESTION it answers.
 * See the flag_verdict_cache DDL for why the key is shaped this way.
 */
export interface FlagVerdictCacheRecord {
  question_hash: string;
  category: string;
  verifier_model: string;
  prompt_version: string;
  verdict: 'flag' | 'skip';
  created_at: string;
  last_hit_at: string | null;
  hit_count: number;
}

export interface CustomMarkerRecord {
  id: string;
  video_id: string;
  start_seconds: number;
  end_seconds: number;
  timestamp_text: string | null;
  title: string | null;
  description: string | null;
  category: string | null;
  created_at: string;
  source?: string;
}

export interface MuteSectionRecord {
  id: string;
  video_id: string;
  start_seconds: number;
  end_seconds: number;
  created_at: string;
}

export interface ChapterRecord {
  id: string;
  video_id: string;
  sequence: number;
  start_seconds: number;
  end_seconds: number;
  title: string;
  description: string | null;
  source: string;
  created_at: string;
}

export interface TagRecord {
  id: string;
  video_id: string;
  tag_name: string;
  tag_type: string | null;
  confidence: number | null;
  source: string | null;
  created_at: string;
}

export interface MediaRelationshipRecord {
  id: string;
  primary_media_id: string;
  related_media_id: string;
  relationship_type: string;
  created_at: string;
  filename?: string;
  current_path?: string;
  media_type?: string;
  file_extension?: string;
}

/**
 * One OTHER member of a media item's connected group. `id` is the member's
 * video id (there is no single relationship id or direction for a member that
 * may be reachable only transitively). Shaped to match the video columns the
 * inspector's ConnectionsStore already maps (filename / media_type /
 * file_extension).
 */
export interface ConnectedGroupMember {
  id: string;
  filename?: string;
  media_type?: string;
  file_extension?: string;
}

export interface TextContentRecord {
  media_id: string;
  extracted_text: string;
  extraction_method: string | null;
  extracted_at: string;
}

export interface WebArchiveRecord {
  video_id: string;
  original_url: string | null;
  domain: string | null;
  favicon_path: string | null;
  page_title: string | null;
  capture_date: string | null;
  publish_date: string | null;
  capture_method: string | null;
  capture_status: string;
  error_message: string | null;
  text_extracted: number;
}

export interface LibraryAnalyticsRecord {
  id: string;
  library_id: string;
  generated_at: string;
  videos_analyzed_count: number;
  ai_insights: string;
  ai_model: string;
  generation_time_seconds: number | null;
}

export interface SearchResultRecord {
  id: string;
  score: number;
  matchType: string;
}

export interface TranscriptSearchRecord {
  video_id: string;
  snippet: string;
}

export interface AnalysisSearchRecord {
  video_id: string;
  snippet: string;
}

export interface TagWithCountRecord {
  tag_name: string;
  tag_type: string;
  count: number;
}

export interface TextContentSearchRecord {
  media_id: string;
  extracted_text: string;
  filename: string;
  media_type: string;
}

export interface StatsRecord {
  totalVideos: number;
  linkedVideos: number;
  unlinkedVideos: number;
  withTranscripts: number;
  withAnalyses: number;
  totalTags: number;
}

export interface PruneResult {
  deletedCount: number;
  deletedVideos: Array<{ id: string; filename: string }>;
}

/**
 * DatabaseService - Manages SQLite database for the Bulk Analysis Library system
 *
 * This service provides:
 * - Database initialization and schema management
 * - CRUD operations for videos, transcripts, analyses, tags
 * - File hashing for video identification
 * - Full-text search capabilities with FTS5
 *
 * Using better-sqlite3 for full SQLite support including FTS5
 */
@Injectable()
export class DatabaseService {
  private readonly logger = new Logger(DatabaseService.name);
  private db: Database.Database | null = null;
  private dbPath: string | null = null;
  private readonly appDataPath: string;

  constructor(private readonly thumbnailService: ThumbnailService) {
    // Base directory - cross-platform app data location
    // Mac: ~/Library/Application Support/briefcase
    // Windows: %APPDATA%/briefcase
    // Linux: ~/.config/briefcase
    this.appDataPath = this.getAppDataPath();

    // Ensure directories exist
    if (!fs.existsSync(this.appDataPath)) {
      fs.mkdirSync(this.appDataPath, { recursive: true });
    }

    this.logger.log('DatabaseService created (not initialized)');
  }

  /**
   * Get cross-platform app data directory
   * Mac: ~/Library/Application Support/briefcase
   * Windows: %APPDATA%/briefcase
   * Linux: ~/.config/briefcase
   *
   * Must match Electron's app.getPath('userData') which comes from
   * package.json name = "briefcase" (lowercase).
   */
  private getAppDataPath(): string {
    const platform = process.platform;
    const appName = 'briefcase';

    if (platform === 'darwin') {
      // macOS
      return path.join(os.homedir(), 'Library', 'Application Support', appName);
    } else if (platform === 'win32') {
      // Windows - use APPDATA environment variable
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      return path.join(appData, appName);
    } else {
      // Linux and others - use XDG_CONFIG_HOME or fallback to ~/.config
      const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
      return path.join(configHome, appName);
    }
  }

  /**
   * Initialize database connection with a specific database file
   * @param dbPath - Path to the database file (optional, uses default if not provided)
   */
  initializeDatabase(dbPath?: string) {
    // Use provided path or default to .briefcase.db in app data directory
    this.dbPath = dbPath || path.join(this.appDataPath, '.briefcase.db');

    this.logger.log(`Initializing database at: ${this.dbPath}`);

    // Refuse to auto-create a library into an unmounted external volume.
    // On macOS external volumes live under /Volumes/<name>; if that mount root
    // is absent the volume is not mounted and mkdir would silently recreate the
    // tree on the boot disk and open an empty database.
    const volumesMatch = this.dbPath.match(/^(\/Volumes\/[^/]+)(?:\/|$)/);
    if (volumesMatch && !fs.existsSync(volumesMatch[1])) {
      throw new Error(`Library volume not mounted: ${volumesMatch[1]}`);
    }

    // Ensure parent directory exists
    const parentDir = path.dirname(this.dbPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // Create or open database (better-sqlite3 handles this automatically)
    const isNew = !fs.existsSync(this.dbPath);
    if (this.db) {
      try {
        this.db.close();
      } catch {}
    }
    this.db = new Database(this.dbPath);

    if (isNew) {
      this.logger.log('Created new database');
    } else {
      this.logger.log('Loaded existing database');
    }

    this.initializeSchema();
    this.logger.log('Database initialized successfully');

    // Set the library path for thumbnail service
    this.thumbnailService.setLibraryPath(this.dbPath);

    // After initialization is complete, check if FTS5 needs population
    this.checkAndPopulateFTS5();
  }

  /**
   * Close database connection
   */
  closeDatabase(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.logger.log('Database connection closed');
    }
  }

  /**
   * Check if database is initialized
   */
  isInitialized(): boolean {
    return this.db !== null;
  }

  /**
   * Get the current database path
   */
  getCurrentDbPath(): string | null {
    return this.dbPath;
  }

  /**
   * Ensure database is initialized (throws error if not)
   */
  private ensureInitialized(): Database.Database {
    if (!this.db) {
      throw new Error('Database not initialized. Call initializeDatabase() first or create a library.');
    }
    return this.db;
  }

  /**
   * Convert absolute path to relative path (relative to clips folder)
   * Stores paths relative to enable cross-platform library sharing
   * @param absolutePath - Full absolute path to video file
   * @param clipsFolderPath - Root clips folder path
   * @returns Relative path from clips folder, or absolute path if outside clips folder
   */
  toRelativePath(absolutePath: string, clipsFolderPath: string): string {
    // Check if path is already relative (doesn't start with / or drive letter on Windows)
    if (!path.isAbsolute(absolutePath)) {
      // Already relative - just normalize slashes and return
      return absolutePath.replace(/\\/g, '/');
    }

    // Normalize both paths for comparison
    const normalizedAbsolute = path.normalize(absolutePath);
    const normalizedClipsFolder = path.normalize(clipsFolderPath);

    // Check if path is inside clips folder
    if (normalizedAbsolute.startsWith(normalizedClipsFolder)) {
      // Get relative path from clips folder
      let relativePath = path.relative(normalizedClipsFolder, normalizedAbsolute);

      // CRITICAL: Always use forward slashes for cross-platform compatibility
      // This ensures paths work on both Windows and Unix systems
      // Windows accepts forward slashes, but Unix doesn't accept backslashes
      relativePath = relativePath.replace(/\\/g, '/');

      return relativePath;
    }

    // If outside clips folder, keep absolute (shouldn't happen in normal operation)
    this.logger.warn(`Path outside clips folder: ${absolutePath}`);
    // Still normalize the absolute path to use forward slashes
    return absolutePath.replace(/\\/g, '/');
  }

  /**
   * Convert relative path to absolute path (resolved from clips folder)
   * @param relativePath - Relative path from database
   * @param clipsFolderPath - Root clips folder path
   * @returns Absolute path to video file
   */
  toAbsolutePath(relativePath: string, clipsFolderPath: string): string {
    // If already absolute, return as-is (backward compatibility)
    if (path.isAbsolute(relativePath)) {
      return relativePath;
    }

    // Resolve relative path from clips folder
    return path.join(clipsFolderPath, relativePath);
  }

  /**
   * Get the clips folder path for the current database
   * Looks for .library.db location as the clips folder
   * @returns Clips folder path or null if database not initialized
   */
  getClipsFolderPath(): string | null {
    if (!this.dbPath) {
      return null;
    }

    // Database is stored as .library.db in the clips folder
    // So the clips folder is the parent directory of the database file
    return path.dirname(this.dbPath);
  }

  /**
   * Resolve video paths from relative to absolute
   * Modifies the video record in place
   * @param video - Video record to resolve paths for
   */
  private resolveVideoPaths<T extends VideoRecord>(video: T): T {
    const clipsFolder = this.getClipsFolderPath();
    if (!clipsFolder) {
      return video;
    }

    // Resolve current_path from relative to absolute
    if (video.current_path) {
      video.current_path = this.toAbsolutePath(video.current_path, clipsFolder);

      // Normalize path separators: replace backslashes with forward slashes
      // This fixes cross-platform compatibility issues where paths may have been
      // imported from Windows systems or stored with incorrect separators
      video.current_path = video.current_path.replace(/\\/g, '/');
    }

    return video;
  }

  /**
   * Resolve paths for an array of videos
   * @param videos - Array of video records
   */
  private resolveVideoPathsArray<T extends VideoRecord>(videos: T[]): T[] {
    return videos.map(video => this.resolveVideoPaths(video));
  }

  /**
   * Initialize database schema with all tables and indexes
   */
  private initializeSchema() {
    const db = this.ensureInitialized();

    // First, create all tables WITHOUT indexes (in case they exist with old schema)
    const tableSchema = `
      -- Videos table: Core metadata for each video file
      CREATE TABLE IF NOT EXISTS videos (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        file_hash TEXT,
        current_path TEXT NOT NULL,
        upload_date TEXT,
        download_date TEXT NOT NULL,
        duration_seconds REAL,
        file_size_bytes INTEGER,
        ai_description TEXT,
        source_url TEXT,
        last_verified TEXT NOT NULL,
        added_at TEXT NOT NULL,
        is_linked INTEGER DEFAULT 1,
        media_type TEXT DEFAULT 'video',
        file_extension TEXT,
        parent_id TEXT,
        aspect_ratio_fixed INTEGER DEFAULT 0,
        audio_normalized INTEGER DEFAULT 0,
        last_processed_date TEXT,
        width INTEGER,
        height INTEGER,
        fps REAL,
        FOREIGN KEY (parent_id) REFERENCES videos(id) ON DELETE CASCADE,
        CHECK (is_linked IN (0, 1)),
        CHECK (aspect_ratio_fixed IN (0, 1)),
        CHECK (audio_normalized IN (0, 1))
      );

      -- Transcripts table: Stores both plain text and SRT format transcripts
      CREATE TABLE IF NOT EXISTS transcripts (
        video_id TEXT PRIMARY KEY,
        plain_text TEXT NOT NULL,
        srt_format TEXT,
        whisper_model TEXT,
        language TEXT,
        transcribed_at TEXT NOT NULL,
        transcription_time_seconds REAL,
        soundex_content TEXT,
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
      );

      -- Analyses table: Analysis reports (AI-generated and user notes)
      CREATE TABLE IF NOT EXISTS analyses (
        video_id TEXT PRIMARY KEY,
        ai_analysis TEXT NOT NULL,
        summary TEXT,
        sections_count INTEGER,
        ai_model TEXT NOT NULL,
        ai_provider TEXT,
        analyzed_at TEXT NOT NULL,
        analysis_time_seconds REAL,
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
      );

      -- Analysis sections: Interesting moments (AI-identified)
      --
      -- verdict / nli_score carry the FLAG PIPELINE's full record, not just its
      -- accepted findings. The ranked path captures every candidate at its
      -- widest setting and asks the verifier about all of them, then stores BOTH
      -- answers: 'flag' for a passage the verifier accepted, 'skip' for one it
      -- rejected (reported / opposed / questioned rather than asserted).
      -- nli_score is the ranker's score for the category the row carries, and it
      -- is what the display filter thresholds on (STRICT >= 0.9, MODERATE >= 0.7,
      -- LOOSE everything including the skips).
      --
      -- BOTH ARE NULLABLE AND NULL MEANS "LEGACY". Rows written before this
      -- change, and rows written by the discovery fallback path (which has no
      -- per-candidate score and no rejected-candidate list), carry NULL in both.
      -- Every reader treats NULL verdict as 'flag' and NULL score as
      -- "passes every threshold", so old libraries render exactly as they did.
      CREATE TABLE IF NOT EXISTS analysis_sections (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL,
        start_seconds REAL NOT NULL,
        end_seconds REAL NOT NULL,
        timestamp_text TEXT,
        title TEXT,
        description TEXT,
        category TEXT,
        source TEXT DEFAULT 'ai',
        verdict TEXT,
        nli_score REAL,
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
      );

      -- Flag verdict cache: one row per QUESTION the flag verifier has answered.
      --
      -- The question is (passage text, category, stance proposition, verifier
      -- model, prompt identity), hashed into question_hash. The verifier is a
      -- deterministic grader (temperature 0, schema-constrained) asked the same
      -- question over and over across re-runs of the same video, re-analyses
      -- after an interrupted run, and different videos that happen to contain the
      -- same passage. Answering it twice costs ~3s on the 27b and buys nothing.
      --
      -- WHY IT IS KEYED ON THE QUESTION AND NOT ON THE VIDEO. A cache keyed by
      -- (video, window index) is invalidated by anything that shifts window
      -- boundaries — a re-transcribe, a category toggled on, a threshold change —
      -- which is exactly when a re-run happens. Keying on the text of the
      -- question means only the questions that actually CHANGED are re-asked;
      -- the ones whose passage and claim are unchanged are free. It also means
      -- the cache survives a widened capture: the new candidates are new
      -- questions, and every question the previous run already answered is a hit.
      --
      -- The model and the prompt identity are IN the key, not columns checked
      -- afterwards, so switching verifier models or editing the prompt template
      -- (bump FLAG_VERIFICATION_PROMPT_VERSION) produces different keys rather
      -- than silently reusing another grader's answers. They are ALSO stored as
      -- plain columns so a human can read the table and so a stale-model sweep is
      -- a DELETE ... WHERE rather than a full wipe.
      CREATE TABLE IF NOT EXISTS flag_verdict_cache (
        question_hash TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        verifier_model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        verdict TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_hit_at TEXT,
        hit_count INTEGER NOT NULL DEFAULT 0
      );

      -- Chapters: Topic/subject-based segments covering entire video timeline
      CREATE TABLE IF NOT EXISTS chapters (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        start_seconds REAL NOT NULL,
        end_seconds REAL NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        source TEXT DEFAULT 'ai',
        created_at TEXT NOT NULL,
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
      );

      -- Custom markers: User-created markers (separate from AI analysis)
      CREATE TABLE IF NOT EXISTS custom_markers (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL,
        start_seconds REAL NOT NULL,
        end_seconds REAL NOT NULL,
        timestamp_text TEXT,
        title TEXT,
        description TEXT,
        category TEXT DEFAULT 'custom',
        created_at TEXT NOT NULL,
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
      );

      -- Mute sections: Ranges of audio to mute for censoring
      CREATE TABLE IF NOT EXISTS mute_sections (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL,
        start_seconds REAL NOT NULL,
        end_seconds REAL NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
      );

      -- Tags: AI-generated and manual tags
      CREATE TABLE IF NOT EXISTS tags (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL,
        tag_name TEXT NOT NULL,
        tag_type TEXT,
        confidence REAL,
        source TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
      );

      -- Saved links: Links saved from mobile/web for later processing
      CREATE TABLE IF NOT EXISTS saved_links (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        title TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        date_added TEXT NOT NULL,
        date_completed TEXT,
        download_path TEXT,
        thumbnail_path TEXT,
        video_id TEXT,
        error_message TEXT,
        metadata TEXT,
        CHECK (status IN ('pending', 'downloading', 'completed', 'failed')),
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE SET NULL
      );

      -- Full-text search virtual tables using FTS5 for fast search
      CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts USING fts5(
        video_id UNINDEXED,
        content,
        tokenize='porter unicode61'
      );

      -- Soundex FTS for phonetic search (catches transcription errors like "Somalies" vs "Somalis")
      CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_soundex_fts USING fts5(
        video_id UNINDEXED,
        soundex_content,
        tokenize='unicode61'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS analyses_fts USING fts5(
        video_id UNINDEXED,
        content,
        tokenize='porter unicode61'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS videos_fts USING fts5(
        video_id UNINDEXED,
        filename,
        current_path,
        ai_description,
        tokenize='porter unicode61'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS tags_fts USING fts5(
        video_id UNINDEXED,
        tag_name,
        tokenize='porter unicode61'
      );

      -- Media relationships: Link multiple files together (e.g. PDF + audiobook)
      CREATE TABLE IF NOT EXISTS media_relationships (
        id TEXT PRIMARY KEY,
        primary_media_id TEXT NOT NULL,
        related_media_id TEXT NOT NULL,
        relationship_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (primary_media_id) REFERENCES videos(id) ON DELETE CASCADE,
        FOREIGN KEY (related_media_id) REFERENCES videos(id) ON DELETE CASCADE,
        UNIQUE(primary_media_id, related_media_id)
      );

      -- Web archives: Metadata for archived web pages (MHTML files)
      CREATE TABLE IF NOT EXISTS web_archives (
        video_id TEXT PRIMARY KEY,
        original_url TEXT,
        domain TEXT,
        favicon_path TEXT,
        page_title TEXT,
        capture_date TEXT,
        publish_date TEXT,
        capture_method TEXT,
        capture_status TEXT NOT NULL DEFAULT 'completed',
        error_message TEXT,
        text_extracted INTEGER DEFAULT 0,
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
        CHECK (capture_status IN ('pending', 'capturing', 'completed', 'failed')),
        CHECK (text_extracted IN (0, 1))
      );

      -- Text content: Extracted text from documents (PDFs, EPUBs, etc.) for searching
      CREATE TABLE IF NOT EXISTS text_content (
        media_id TEXT PRIMARY KEY,
        extracted_text TEXT NOT NULL,
        extraction_method TEXT,
        extracted_at TEXT NOT NULL,
        FOREIGN KEY (media_id) REFERENCES videos(id) ON DELETE CASCADE
      );

      -- Library analytics: Cached AI-generated insights about the entire library
      CREATE TABLE IF NOT EXISTS library_analytics (
        id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        videos_analyzed_count INTEGER NOT NULL,
        ai_insights TEXT NOT NULL,
        ai_model TEXT NOT NULL,
        generation_time_seconds REAL
      );

      -- Video tabs: Named groups/collections for organizing videos (e.g. streaming playlists)
      CREATE TABLE IF NOT EXISTS video_tabs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        display_order INTEGER DEFAULT 0
      );

      -- Video tab items: Junction table for items in tabs (videos, links, etc.)
      CREATE TABLE IF NOT EXISTS video_tab_items (
        id TEXT PRIMARY KEY,
        tab_id TEXT NOT NULL,
        video_id TEXT,
        saved_link_id TEXT,
        url TEXT,
        title TEXT,
        item_type TEXT DEFAULT 'video',
        added_at TEXT NOT NULL,
        display_order INTEGER DEFAULT 0,
        FOREIGN KEY (tab_id) REFERENCES video_tabs(id) ON DELETE CASCADE,
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
        FOREIGN KEY (saved_link_id) REFERENCES saved_links(id) ON DELETE CASCADE
      );
    `;

    // Execute table creation
    db.exec(tableSchema);
    this.logger.log('Database tables created');

    // Run schema migrations for existing databases BEFORE creating indexes
    this.runSchemaMigrations();

    // Now create indexes (after migrations have run)
    const indexSchema = `
      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_videos_hash ON videos(file_hash);
      CREATE INDEX IF NOT EXISTS idx_videos_upload_date ON videos(upload_date);
      CREATE INDEX IF NOT EXISTS idx_videos_download_date ON videos(download_date);
      CREATE INDEX IF NOT EXISTS idx_videos_is_linked ON videos(is_linked);
      CREATE INDEX IF NOT EXISTS idx_videos_parent_id ON videos(parent_id);
      CREATE INDEX IF NOT EXISTS idx_tags_video ON tags(video_id);
      CREATE INDEX IF NOT EXISTS idx_sections_video ON analysis_sections(video_id);
      CREATE INDEX IF NOT EXISTS idx_flag_verdict_cache_model ON flag_verdict_cache(verifier_model, prompt_version);
      CREATE INDEX IF NOT EXISTS idx_custom_markers_video ON custom_markers(video_id);
      CREATE INDEX IF NOT EXISTS idx_mute_sections_video ON mute_sections(video_id);
      CREATE INDEX IF NOT EXISTS idx_saved_links_status ON saved_links(status);
      CREATE INDEX IF NOT EXISTS idx_saved_links_date_added ON saved_links(date_added);
      CREATE INDEX IF NOT EXISTS idx_saved_links_url ON saved_links(url);
      CREATE INDEX IF NOT EXISTS idx_media_relationships_primary ON media_relationships(primary_media_id);
      CREATE INDEX IF NOT EXISTS idx_media_relationships_related ON media_relationships(related_media_id);
      CREATE INDEX IF NOT EXISTS idx_text_content_media ON text_content(media_id);
      CREATE INDEX IF NOT EXISTS idx_web_archives_domain ON web_archives(domain);
      CREATE INDEX IF NOT EXISTS idx_web_archives_capture_date ON web_archives(capture_date);
      CREATE INDEX IF NOT EXISTS idx_web_archives_original_url ON web_archives(original_url);
      CREATE INDEX IF NOT EXISTS idx_library_analytics_library ON library_analytics(library_id);
      CREATE INDEX IF NOT EXISTS idx_library_analytics_generated ON library_analytics(generated_at);
      CREATE INDEX IF NOT EXISTS idx_video_tabs_display_order ON video_tabs(display_order);
      CREATE INDEX IF NOT EXISTS idx_video_tab_items_tab ON video_tab_items(tab_id);
      CREATE INDEX IF NOT EXISTS idx_video_tab_items_video ON video_tab_items(video_id);
      CREATE INDEX IF NOT EXISTS idx_video_tab_items_saved_link ON video_tab_items(saved_link_id);
      CREATE INDEX IF NOT EXISTS idx_video_tab_items_display_order ON video_tab_items(display_order);
    `;

    db.exec(indexSchema);
    this.logger.log('Database schema initialized');
  }

  /**
   * Run schema migrations to update existing databases
   */
  private runSchemaMigrations() {
    const db = this.ensureInitialized();

    try {
      // Migration 1: Add added_at column to videos table if it doesn't exist
      db.exec("SELECT added_at FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: added_at')) {
        this.logger.log('Running migration: Adding added_at column to videos table');
        try {
          // Add the column with a default value (use created_at as default for existing records)
          db.exec(`
            ALTER TABLE videos ADD COLUMN added_at TEXT;
            UPDATE videos SET added_at = created_at WHERE added_at IS NULL;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: added_at column added');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 2: Add ai_description column to videos table if it doesn't exist
      db.exec("SELECT ai_description FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: ai_description')) {
        this.logger.log('Running migration: Adding ai_description column to videos table');
        try {
          db.exec(`
            ALTER TABLE videos ADD COLUMN ai_description TEXT;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: ai_description column added');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 3: Add source_url column to videos table if it doesn't exist
      db.exec("SELECT source_url FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: source_url')) {
        this.logger.log('Running migration: Adding source_url column to videos table');
        try {
          db.exec(`
            ALTER TABLE videos ADD COLUMN source_url TEXT;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: source_url column added');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 4: Add source column to analysis_sections table if it doesn't exist
      db.exec("SELECT source FROM analysis_sections LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: source')) {
        this.logger.log('Running migration: Adding source column to analysis_sections table');
        try {
          db.exec(`
            ALTER TABLE analysis_sections ADD COLUMN source TEXT DEFAULT 'ai';
            UPDATE analysis_sections SET source = 'ai' WHERE source IS NULL;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: source column added to analysis_sections');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 5: Move custom markers from analysis_sections to custom_markers table
      // Check if custom_markers table exists by querying it
      const stmt = db.prepare("SELECT COUNT(*) as count FROM custom_markers");
      const result = stmt.get() as any;

      // If table exists and is empty, check for custom markers in analysis_sections
      if (result.count === 0) {
        const checkStmt = db.prepare("SELECT COUNT(*) as count FROM analysis_sections WHERE source = 'user' OR category = 'custom'");
        const checkResult = checkStmt.get() as any;

        if (checkResult.count > 0) {
          this.logger.log(`Running migration: Moving ${checkResult.count} custom markers from analysis_sections to custom_markers table`);
          try {
            db.exec(`
              INSERT INTO custom_markers (id, video_id, start_seconds, end_seconds, timestamp_text, title, description, category, created_at)
              SELECT id, video_id, start_seconds, end_seconds, timestamp_text, title, description,
                     COALESCE(category, 'custom') as category,
                     COALESCE((SELECT created_at FROM videos WHERE id = video_id), datetime('now')) as created_at
              FROM analysis_sections
              WHERE source = 'user' OR category = 'custom';

              DELETE FROM analysis_sections WHERE source = 'user' OR category = 'custom';
            `);
            this.saveDatabase();
            this.logger.log(`Migration complete: Moved ${checkResult.count} custom markers to custom_markers table`);
          } catch (migrationError: any) {
            // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
          }
        }
      }
    } catch (error: any) {
      // Table might not exist yet (new installation) - silently ignore.
      // Any other error (including an aborted migration re-thrown above) must
      // propagate so startup fails loudly instead of running on a broken schema.
      if (!error.message || !error.message.includes('no such table')) {
        throw error;
      }
    }

    try {
      // Migration 6: Add media_type column to videos table if it doesn't exist
      db.exec("SELECT media_type FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: media_type')) {
        this.logger.log('Running migration: Adding media_type column to videos table');
        try {
          // Add the column with default value 'video' for existing records
          db.exec(`
            ALTER TABLE videos ADD COLUMN media_type TEXT DEFAULT 'video';
            UPDATE videos SET media_type = 'video' WHERE media_type IS NULL;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: media_type column added');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 7: Add file_extension column to videos table if it doesn't exist
      db.exec("SELECT file_extension FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: file_extension')) {
        this.logger.log('Running migration: Adding file_extension column to videos table');
        try {
          // Add the column and populate from filename
          db.exec(`
            ALTER TABLE videos ADD COLUMN file_extension TEXT;
          `);
          // Update existing records to extract extension from filename
          const stmt = db.prepare('SELECT id, filename FROM videos');
          const rows = stmt.all() as any[];

          // Apply updates
          const updateStmt = db.prepare('UPDATE videos SET file_extension = ? WHERE id = ?');
          for (const row of rows) {
            const dotIndex = row.filename.lastIndexOf('.');
            const ext = dotIndex === -1 ? null : row.filename.substring(dotIndex).toLowerCase();
            updateStmt.run(ext, row.id);
          }

          this.saveDatabase();
          this.logger.log('Migration complete: file_extension column added');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 8: Add parent_id column to videos table if it doesn't exist
      db.exec("SELECT parent_id FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: parent_id')) {
        this.logger.log('Running migration: Adding parent_id column to videos table');
        try {
          db.exec(`
            ALTER TABLE videos ADD COLUMN parent_id TEXT;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: parent_id column added');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    // Migration 9: Check if we need to add created_at column (old databases might have this instead of upload_date)
    // Check table schema to see which columns exist
    let hasCreatedAt = false;
    let hasUploadDate = false;
    let hasDownloadDate = false;

    try {
      const stmt = db.prepare("PRAGMA table_info(videos)");
      const rows = stmt.all() as any[];
      const columns = rows.map(row => row.name);

      hasCreatedAt = columns.includes('created_at');
      hasUploadDate = columns.includes('upload_date');
      hasDownloadDate = columns.includes('download_date');

      this.logger.log(`Migration check: hasCreatedAt=${hasCreatedAt}, hasUploadDate=${hasUploadDate}, hasDownloadDate=${hasDownloadDate}`);
    } catch (error: any) {
      this.logger.warn(`Could not check table schema: ${error?.message || 'Unknown error'}`);
    }

    // If we have created_at but not upload_date/download_date, we need to migrate
    if (hasCreatedAt && (!hasUploadDate || !hasDownloadDate)) {
      this.logger.log('Running migration: Renaming created_at to upload_date and adding download_date');
      try {
        // SQLite doesn't support column renaming directly, so we need to recreate the table.
        // This is DESTRUCTIVE (it DROPs the videos table partway through), so it MUST be
        // atomic: run it inside a transaction. If any statement fails, better-sqlite3 rolls
        // the whole thing back, leaving the original videos table fully intact.
        const rebuildVideosTable = db.transaction(() => {
          db.exec(`
          -- Create new table with updated schema
          CREATE TABLE videos_new (
            id TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            file_hash TEXT,
            current_path TEXT NOT NULL,
            upload_date TEXT,
            download_date TEXT NOT NULL,
            duration_seconds REAL,
            file_size_bytes INTEGER,
            ai_description TEXT,
            source_url TEXT,
            last_verified TEXT NOT NULL,
            added_at TEXT NOT NULL,
            is_linked INTEGER DEFAULT 1,
            media_type TEXT DEFAULT 'video',
            file_extension TEXT,
            parent_id TEXT,
            FOREIGN KEY (parent_id) REFERENCES videos(id) ON DELETE CASCADE,
            CHECK (is_linked IN (0, 1))
          );

          -- Copy data from old table to new table
          INSERT INTO videos_new (
            id, filename, file_hash, current_path, upload_date, download_date,
            duration_seconds, file_size_bytes, ai_description, source_url,
            last_verified, added_at, is_linked, media_type, file_extension, parent_id
          )
          SELECT
            id, filename, file_hash, current_path,
            created_at as upload_date,
            added_at as download_date,
            duration_seconds, file_size_bytes, ai_description, source_url,
            last_verified, added_at, is_linked, media_type, file_extension, NULL as parent_id
          FROM videos;

          -- Drop old table
          DROP TABLE videos;

          -- Rename new table to videos
          ALTER TABLE videos_new RENAME TO videos;
        `);
        });
        rebuildVideosTable();

        this.saveDatabase();
        this.logger.log('Migration complete: Renamed created_at to upload_date and added download_date');
      } catch (migrationError: any) {
        // A failure here means the videos table may have been dropped/half-rebuilt.
        // The transaction has already rolled back, so the DB is intact — but we must
        // NOT swallow this and continue running against a schema we couldn't migrate.
        // Fail loudly so startup aborts and the problem is visible.
        this.logger.error(`Destructive videos-table migration failed and was rolled back: ${migrationError?.message || 'Unknown error'}`);
        throw migrationError;
      }
    }

    try {
      // Migration 10: Add suggested_title column to videos table if it doesn't exist
      db.exec("SELECT suggested_title FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: suggested_title')) {
        this.logger.log('Running migration: Adding suggested_title column to videos table');
        try {
          db.exec(`
            ALTER TABLE videos ADD COLUMN suggested_title TEXT;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: suggested_title column added');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 11: Add transcription_time_seconds column to transcripts table if it doesn't exist
      db.exec("SELECT transcription_time_seconds FROM transcripts LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: transcription_time_seconds')) {
        this.logger.log('Running migration: Adding transcription_time_seconds column to transcripts table');
        try {
          db.exec(`
            ALTER TABLE transcripts ADD COLUMN transcription_time_seconds REAL;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: transcription_time_seconds column added');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 12: Add analysis_time_seconds column to analyses table if it doesn't exist
      db.exec("SELECT analysis_time_seconds FROM analyses LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: analysis_time_seconds')) {
        this.logger.log('Running migration: Adding analysis_time_seconds column to analyses table');
        try {
          db.exec(`
            ALTER TABLE analyses ADD COLUMN analysis_time_seconds REAL;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: analysis_time_seconds column added');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 13: Add has_transcript column to videos table if it doesn't exist
      db.exec("SELECT has_transcript FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: has_transcript')) {
        this.logger.log('Running migration: Adding has_transcript column to videos table');
        try {
          db.exec(`
            ALTER TABLE videos ADD COLUMN has_transcript INTEGER DEFAULT 0;
          `);
          // Update existing rows based on whether they have transcripts
          db.exec(`
            UPDATE videos
            SET has_transcript = CASE
              WHEN EXISTS (SELECT 1 FROM transcripts WHERE video_id = videos.id) THEN 1
              ELSE 0
            END;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: has_transcript column added and populated');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 14: Add has_analysis column to videos table if it doesn't exist
      db.exec("SELECT has_analysis FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: has_analysis')) {
        this.logger.log('Running migration: Adding has_analysis column to videos table');
        try {
          db.exec(`
            ALTER TABLE videos ADD COLUMN has_analysis INTEGER DEFAULT 0;
          `);
          // Update existing rows based on whether they have analyses
          db.exec(`
            UPDATE videos
            SET has_analysis = CASE
              WHEN EXISTS (SELECT 1 FROM analyses WHERE video_id = videos.id) THEN 1
              ELSE 0
            END;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: has_analysis column added and populated');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 15: Add aspect_ratio_fixed column to videos table if it doesn't exist
      db.exec("SELECT aspect_ratio_fixed FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: aspect_ratio_fixed')) {
        this.logger.log('Running migration: Adding aspect_ratio_fixed column to videos table');
        try {
          db.exec(`
            ALTER TABLE videos ADD COLUMN aspect_ratio_fixed INTEGER DEFAULT 0;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: aspect_ratio_fixed column added');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 16: Add audio_normalized column to videos table if it doesn't exist
      db.exec("SELECT audio_normalized FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: audio_normalized')) {
        this.logger.log('Running migration: Adding audio_normalized column to videos table');
        try {
          db.exec(`
            ALTER TABLE videos ADD COLUMN audio_normalized INTEGER DEFAULT 0;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: audio_normalized column added');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 17: Add last_processed_date column to videos table if it doesn't exist
      db.exec("SELECT last_processed_date FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: last_processed_date')) {
        this.logger.log('Running migration: Adding last_processed_date column to videos table');
        try {
          db.exec(`
            ALTER TABLE videos ADD COLUMN last_processed_date TEXT;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: last_processed_date column added');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 18: Create video_relationships junction table for many-to-many parent-child relationships
      db.exec("SELECT * FROM video_relationships LIMIT 1");
      // If we get here without error, table exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such table: video_relationships')) {
        this.logger.log('Running migration: Creating video_relationships junction table');
        try {
          db.exec(`
            CREATE TABLE IF NOT EXISTS video_relationships (
              id TEXT PRIMARY KEY,
              parent_id TEXT NOT NULL,
              child_id TEXT NOT NULL,
              created_at TEXT NOT NULL,
              FOREIGN KEY (parent_id) REFERENCES videos(id) ON DELETE CASCADE,
              FOREIGN KEY (child_id) REFERENCES videos(id) ON DELETE CASCADE,
              UNIQUE (parent_id, child_id)
            );

            CREATE INDEX IF NOT EXISTS idx_video_relationships_parent ON video_relationships(parent_id);
            CREATE INDEX IF NOT EXISTS idx_video_relationships_child ON video_relationships(child_id);
          `);

          // Migrate existing parent_id data to the junction table
          const existingRelationships = db.prepare(`
            SELECT id, parent_id FROM videos WHERE parent_id IS NOT NULL
          `).all() as any[];

          if (existingRelationships.length > 0) {
            this.logger.log(`Migrating ${existingRelationships.length} existing parent-child relationships`);
            const insertStmt = db.prepare(`
              INSERT INTO video_relationships (id, parent_id, child_id, created_at)
              VALUES (?, ?, ?, ?)
            `);

            const { v4: uuidv4 } = require('uuid');
            for (const rel of existingRelationships) {
              insertStmt.run(
                uuidv4(),
                rel.parent_id,
                rel.id,
                new Date().toISOString()
              );
            }
          }

          this.saveDatabase();
          this.logger.log('Migration complete: video_relationships table created and existing data migrated');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    // Migration 19: Backfill undirected connections (media_relationships) from
    // parent/child pairs (video_relationships). Idempotent — the NOT EXISTS
    // guard checks both directions, so this is safe to run on every startup.
    try {
      const result = db.prepare(`
        INSERT INTO media_relationships (id, primary_media_id, related_media_id, relationship_type, created_at)
        SELECT lower(hex(randomblob(16))), vr.parent_id, vr.child_id, 'connected', vr.created_at
        FROM video_relationships vr
        WHERE NOT EXISTS (
          SELECT 1 FROM media_relationships mr
          WHERE (mr.primary_media_id = vr.parent_id AND mr.related_media_id = vr.child_id)
             OR (mr.primary_media_id = vr.child_id AND mr.related_media_id = vr.parent_id)
        )
      `).run();
      if (result.changes > 0) {
        this.saveDatabase();
        this.logger.log(`Migration: backfilled ${result.changes} connections from parent/child relationships`);
      }
    } catch (migrationError: any) {
      this.logger.error(`Connections backfill migration failed: ${migrationError?.message || 'Unknown error'}`);
    }

    // Migration: Recreate video_tab_items to allow nullable video_id and add new columns
    // This is needed because SQLite doesn't allow changing NOT NULL constraints
    try {
      // Check if video_id is nullable by trying to insert a NULL and rolling back
      const testStmt = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='video_tab_items'");
      const tableInfo = testStmt.get() as { sql: string } | undefined;

      if (tableInfo && tableInfo.sql && tableInfo.sql.includes('video_id TEXT NOT NULL')) {
        this.logger.log('Running migration: Recreating video_tab_items to support multiple item types');
        try {
          // Destructive (DROPs video_tab_items partway through), so it must be
          // atomic: on any failure better-sqlite3 rolls back and leaves the
          // original table intact.
          const rebuildTabItemsTable = db.transaction(() => {
            db.exec(`
            -- Create new table with correct schema
            CREATE TABLE video_tab_items_new (
              id TEXT PRIMARY KEY,
              tab_id TEXT NOT NULL,
              video_id TEXT,
              saved_link_id TEXT,
              url TEXT,
              title TEXT,
              item_type TEXT DEFAULT 'video',
              added_at TEXT NOT NULL,
              display_order INTEGER DEFAULT 0,
              FOREIGN KEY (tab_id) REFERENCES video_tabs(id) ON DELETE CASCADE,
              FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
              FOREIGN KEY (saved_link_id) REFERENCES saved_links(id) ON DELETE CASCADE
            );

            -- Copy existing data
            INSERT INTO video_tab_items_new (id, tab_id, video_id, added_at, display_order, item_type)
            SELECT id, tab_id, video_id, added_at, display_order, 'video'
            FROM video_tab_items;

            -- Drop old table
            DROP TABLE video_tab_items;

            -- Rename new table
            ALTER TABLE video_tab_items_new RENAME TO video_tab_items;

            -- Recreate indexes
            CREATE INDEX IF NOT EXISTS idx_video_tab_items_tab ON video_tab_items(tab_id);
            CREATE INDEX IF NOT EXISTS idx_video_tab_items_video ON video_tab_items(video_id);
            CREATE INDEX IF NOT EXISTS idx_video_tab_items_saved_link ON video_tab_items(saved_link_id);
            CREATE INDEX IF NOT EXISTS idx_video_tab_items_display_order ON video_tab_items(display_order);
          `);
          });
          rebuildTabItemsTable();
          this.saveDatabase();
          this.logger.log('Migration complete: video_tab_items now supports multiple item types');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      } else if (tableInfo && tableInfo.sql && !tableInfo.sql.includes('item_type')) {
        // Table exists with nullable video_id but missing new columns
        this.logger.log('Running migration: Adding flexible item type columns to video_tab_items');
        try {
          db.exec(`
            ALTER TABLE video_tab_items ADD COLUMN item_type TEXT DEFAULT 'video';
            ALTER TABLE video_tab_items ADD COLUMN saved_link_id TEXT;
            ALTER TABLE video_tab_items ADD COLUMN url TEXT;
            ALTER TABLE video_tab_items ADD COLUMN title TEXT;
            UPDATE video_tab_items SET item_type = 'video' WHERE item_type IS NULL;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: Added item_type columns');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    } catch (error: any) {
      // A brand-new library without the table yet is benign; anything else
      // (including an aborted migration re-thrown above) must propagate.
      if (error.message && error.message.includes('no such table')) {
        this.logger.error(`Error checking video_tab_items schema: ${error?.message}`);
      } else {
        throw error;
      }
    }

    // Migration: Enforce one row per (tab_id, video_id) so addVideoToTab's
    // UNIQUE-constraint dedup actually fires. Dedup any pre-existing rows first,
    // then create the partial unique index (video_id is NULL for link items).
    try {
      const dedupeTabItems = db.transaction(() => {
        db.exec(`
          DELETE FROM video_tab_items
          WHERE video_id IS NOT NULL
            AND rowid NOT IN (
              SELECT MIN(rowid) FROM video_tab_items
              WHERE video_id IS NOT NULL
              GROUP BY tab_id, video_id
            );
          CREATE UNIQUE INDEX IF NOT EXISTS idx_video_tab_items_unique
            ON video_tab_items(tab_id, video_id)
            WHERE video_id IS NOT NULL;
        `);
      });
      dedupeTabItems();
    } catch (error: any) {
      if (!error.message || !error.message.includes('no such table')) {
        throw error;
      }
    }

    // Migration 20: Add width, height, fps columns to videos table
    try {
      db.exec("SELECT width FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: width')) {
        this.logger.log('Running migration: Adding video metadata columns (width, height, fps) to videos table');
        try {
          db.exec(`
            ALTER TABLE videos ADD COLUMN width INTEGER;
            ALTER TABLE videos ADD COLUMN height INTEGER;
            ALTER TABLE videos ADD COLUMN fps REAL;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: width, height, fps columns added');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    // Migration 20b: Add needs_metadata flag to videos table.
    // Set when ffprobe failed during import (fallback audit #12) so
    // half-populated records are identifiable and retryable instead of
    // silently carrying NULL duration/width/height forever.
    try {
      db.exec("SELECT needs_metadata FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: needs_metadata')) {
        this.logger.log('Running migration: Adding needs_metadata column to videos table');
        try {
          db.exec(`
            ALTER TABLE videos ADD COLUMN needs_metadata INTEGER DEFAULT 0;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: needs_metadata column added');
        } catch (migrationError: any) {
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    // Migration 21: Create custom_instructions_history table
    try {
      db.exec("SELECT 1 FROM custom_instructions_history LIMIT 1");
      // Table exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such table')) {
        this.logger.log('Running migration: Creating custom_instructions_history table');
        try {
          db.exec(`
            CREATE TABLE IF NOT EXISTS custom_instructions_history (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              instruction_text TEXT NOT NULL,
              used_at TEXT NOT NULL,
              use_count INTEGER DEFAULT 1
            );
            CREATE INDEX IF NOT EXISTS idx_instructions_used_at ON custom_instructions_history(used_at DESC);
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: custom_instructions_history table created');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    // Migration 22: Add token stats columns to analyses table
    try {
      db.exec("SELECT input_tokens FROM analyses LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: input_tokens')) {
        this.logger.log('Running migration: Adding token stats columns to analyses table');
        try {
          db.exec(`
            ALTER TABLE analyses ADD COLUMN input_tokens INTEGER;
            ALTER TABLE analyses ADD COLUMN output_tokens INTEGER;
            ALTER TABLE analyses ADD COLUMN total_tokens INTEGER;
            ALTER TABLE analyses ADD COLUMN estimated_cost REAL;
            ALTER TABLE analyses ADD COLUMN api_calls INTEGER;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: token stats columns added to analyses table');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    // Migration: Add soundex_content column to transcripts for phonetic search
    try {
      db.prepare('SELECT soundex_content FROM transcripts LIMIT 1').get();
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: soundex_content')) {
        this.logger.log('Running migration: Adding soundex_content column to transcripts table');
        try {
          db.exec(`
            ALTER TABLE transcripts ADD COLUMN soundex_content TEXT;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: soundex_content column added to transcripts table');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    // Migration 23: Create web_archives table for archived web pages
    try {
      const waCheck = db.prepare(`
        SELECT COUNT(*) as count FROM sqlite_master
        WHERE type='table' AND name='web_archives'
      `).get() as { count: number };

      if (waCheck.count === 0) {
        this.logger.log('Running migration: Creating web_archives table');
        try {
          db.exec(`
            CREATE TABLE IF NOT EXISTS web_archives (
              video_id TEXT PRIMARY KEY,
              original_url TEXT,
              domain TEXT,
              favicon_path TEXT,
              page_title TEXT,
              capture_date TEXT,
              publish_date TEXT,
              capture_method TEXT,
              capture_status TEXT NOT NULL DEFAULT 'completed',
              error_message TEXT,
              text_extracted INTEGER DEFAULT 0,
              FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
              CHECK (capture_status IN ('pending', 'capturing', 'completed', 'failed')),
              CHECK (text_extracted IN (0, 1))
            );
            CREATE INDEX IF NOT EXISTS idx_web_archives_domain ON web_archives(domain);
            CREATE INDEX IF NOT EXISTS idx_web_archives_capture_date ON web_archives(capture_date);
            CREATE INDEX IF NOT EXISTS idx_web_archives_original_url ON web_archives(original_url);
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: web_archives table created');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    } catch (error: any) {
      this.logger.error(`Error checking web_archives table: ${error?.message || 'Unknown error'}`);
    }

    // Migration 24: Add verdict + nli_score to analysis_sections.
    //
    // The flag pipeline now stores EVERY verifier verdict, not only the accepted
    // ones, so a section row has to say which it is and what the ranker scored.
    //
    // BOTH COLUMNS ARE DELIBERATELY LEFT NULL FOR EXISTING ROWS — no backfill,
    // no DEFAULT. A legacy row was written by a pipeline that only ever stored
    // accepted findings, so its verdict IS 'flag'; but writing that in would be
    // asserting a score it never had, and every reader already reads NULL as
    // "legacy: treat as flag, passes every filter". Backfilling would buy
    // nothing and would make it impossible to tell a real 'flag' verdict from an
    // inferred one. Migration 4 above is the pattern this follows: probe the
    // column with a SELECT, ALTER on 'no such column'.
    for (const column of ['verdict TEXT', 'nli_score REAL']) {
      const name = column.split(' ')[0];
      try {
        db.exec(`SELECT ${name} FROM analysis_sections LIMIT 1`);
      } catch (error: any) {
        if (error?.message && error.message.includes(`no such column: ${name}`)) {
          this.logger.log(`Running migration: Adding ${name} column to analysis_sections table`);
          try {
            db.exec(`ALTER TABLE analysis_sections ADD COLUMN ${column};`);
            this.saveDatabase();
            this.logger.log(`Migration complete: ${name} column added to analysis_sections`);
          } catch (migrationError: any) {
            // Fallback audit #6: a half-migrated schema corrupts every later
            // write to the missing column. Abort the library load loudly —
            // the log line above names the migration that failed.
            throw new Error(
              `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
              `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
              `Check that the library volume is mounted and writable, then reopen the library.`,
            );
          }
        } else {
          // 'no such table' on a brand-new database, which initializeSchema has
          // already created with both columns present. Anything else propagates.
          if (!error?.message || !error.message.includes('no such table')) throw error;
        }
      }
    }

    // Migration 25: Create flag_verdict_cache.
    //
    // No probe/ALTER pair here because there is nothing to migrate: the table is
    // created unconditionally by initializeSchema's CREATE TABLE IF NOT EXISTS,
    // which runs on every open, so an existing library picks it up empty on the
    // next load. This comment exists so the next person looking for "where does
    // flag_verdict_cache get created for old libraries" stops here.

    // Migration: Create transcripts_soundex_fts FTS5 table for phonetic search
    try {
      const ftsCheck = db.prepare(`
        SELECT COUNT(*) as count FROM sqlite_master
        WHERE type='table' AND name='transcripts_soundex_fts'
      `).get() as { count: number };

      if (ftsCheck.count === 0) {
        this.logger.log('Running migration: Creating transcripts_soundex_fts FTS5 table');
        try {
          db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_soundex_fts USING fts5(
              video_id UNINDEXED,
              soundex_content,
              tokenize='unicode61'
            );
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: transcripts_soundex_fts FTS5 table created');

          // Backfill soundex data for existing transcripts
          this.backfillSoundexData();
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    } catch (error: any) {
      this.logger.error(`Error checking transcripts_soundex_fts: ${error?.message || 'Unknown error'}`);
    }

  }

  /**
   * Backfill soundex data for existing transcripts
   * Called during migration when soundex FTS table is created
   */
  private backfillSoundexData(): void {
    const db = this.ensureInitialized();

    try {
      // Get all transcripts that need soundex data
      const transcripts = db.prepare(`
        SELECT video_id, plain_text FROM transcripts
      `).all() as Array<{ video_id: string; plain_text: string }>;

      if (transcripts.length === 0) {
        this.logger.log('[Soundex Backfill] No transcripts to process');
        return;
      }

      this.logger.log(`[Soundex Backfill] Processing ${transcripts.length} transcripts...`);

      const updateStmt = db.prepare(`
        UPDATE transcripts SET soundex_content = ? WHERE video_id = ?
      `);
      const insertFtsStmt = db.prepare(`
        INSERT INTO transcripts_soundex_fts (video_id, soundex_content) VALUES (?, ?)
      `);

      let processed = 0;
      for (const transcript of transcripts) {
        const soundexContent = this.textToSoundex(transcript.plain_text);

        // Update the transcripts table
        updateStmt.run(soundexContent, transcript.video_id);

        // Insert into FTS table
        insertFtsStmt.run(transcript.video_id, soundexContent);

        processed++;
        if (processed % 100 === 0) {
          this.logger.log(`[Soundex Backfill] Processed ${processed}/${transcripts.length} transcripts`);
        }
      }

      this.saveDatabase();
      this.logger.log(`[Soundex Backfill] Complete: ${processed} transcripts processed`);
    } catch (error: any) {
      this.logger.error(`[Soundex Backfill] Error: ${error?.message || 'Unknown error'}`);
    }
  }

  /**
   * Check if FTS5 tables need population and populate them if needed
   * Called after database initialization is complete
   */
  private checkAndPopulateFTS5(): void {
    try {
      const db = this.ensureInitialized();

      // First, check if FTS5 tables exist by querying sqlite_master
      const tableCheckStmt = db.prepare(`
        SELECT COUNT(*) as count
        FROM sqlite_master
        WHERE type='table' AND name IN ('videos_fts', 'transcripts_fts', 'analyses_fts', 'tags_fts')
      `);
      const tableCheck = tableCheckStmt.get() as any;

      // If not all 4 FTS5 tables exist, create them
      if (tableCheck.count < 4) {
        this.logger.log('[Migration] Creating missing FTS5 search tables...');
        this.createFTS5Tables();
        this.logger.log('[Migration] FTS5 tables created');
      }

      // Check if FTS5 tables need to be populated by checking if they're empty
      const stmt = db.prepare("SELECT COUNT(*) as count FROM videos_fts");
      const result = stmt.get() as any;

      if (result.count === 0) {
        // Count total videos to populate
        const countStmt = db.prepare("SELECT COUNT(*) as count FROM videos");
        const countResult = countStmt.get() as any;

        if (countResult.count > 0) {
          this.logger.log(`[Migration] Populating FTS5 search indexes for ${countResult.count} existing videos...`);
          this.rebuildFTS5Indexes();
          this.logger.log('[Migration] FTS5 search indexes populated successfully');
        }
      }
    } catch (error: any) {
      this.logger.error(`[Migration] FTS5 setup failed: ${error?.message || 'Unknown error'}`);
      this.logger.error(error?.stack || error);
    }
  }

  /**
   * Create FTS5 virtual tables
   */
  private createFTS5Tables(): void {
    const db = this.ensureInitialized();

    const fts5Schema = `
      -- Drop existing FTS5 tables if they exist (in case of corruption)
      DROP TABLE IF EXISTS transcripts_fts;
      DROP TABLE IF EXISTS analyses_fts;
      DROP TABLE IF EXISTS videos_fts;
      DROP TABLE IF EXISTS tags_fts;

      -- Full-text search virtual tables using FTS5 for fast search
      CREATE VIRTUAL TABLE transcripts_fts USING fts5(
        video_id UNINDEXED,
        content,
        tokenize='porter unicode61'
      );

      CREATE VIRTUAL TABLE analyses_fts USING fts5(
        video_id UNINDEXED,
        content,
        tokenize='porter unicode61'
      );

      CREATE VIRTUAL TABLE videos_fts USING fts5(
        video_id UNINDEXED,
        filename,
        current_path,
        ai_description,
        tokenize='porter unicode61'
      );

      CREATE VIRTUAL TABLE tags_fts USING fts5(
        video_id UNINDEXED,
        tag_name,
        tokenize='porter unicode61'
      );
    `;

    db.exec(fts5Schema);
    this.saveDatabase();
  }

  /**
   * Rebuild FTS5 full-text search indexes from existing data
   * Call this after importing data or if search isn't working properly
   */
  rebuildFTS5Indexes(): void {
    const db = this.ensureInitialized();

    this.logger.log('[FTS5 Rebuild] Starting rebuild of FTS5 search indexes...');
    const startTime = Date.now();

    try {
      // Clear existing FTS5 data
      this.logger.log('[FTS5 Rebuild] Clearing existing FTS5 tables...');
      db.prepare('DELETE FROM videos_fts').run();
      db.prepare('DELETE FROM transcripts_fts').run();
      db.prepare('DELETE FROM analyses_fts').run();
      db.prepare('DELETE FROM tags_fts').run();

      // Populate videos_fts
      this.logger.log('[FTS5 Rebuild] Populating videos_fts...');
      const videosStmt = db.prepare('SELECT id, filename, current_path, ai_description FROM videos');
      const videos = videosStmt.all() as any[];

      const videoInsertStmt = db.prepare('INSERT INTO videos_fts (video_id, filename, current_path, ai_description) VALUES (?, ?, ?, ?)');
      for (const row of videos) {
        videoInsertStmt.run(row.id, row.filename, row.current_path || '', row.ai_description || '');
      }
      this.logger.log(`[FTS5 Rebuild] Populated ${videos.length} videos`);

      // Populate transcripts_fts
      this.logger.log('[FTS5 Rebuild] Populating transcripts_fts...');
      const transcriptsStmt = db.prepare('SELECT video_id, plain_text FROM transcripts');
      const transcripts = transcriptsStmt.all() as any[];

      const transcriptInsertStmt = db.prepare('INSERT INTO transcripts_fts (video_id, content) VALUES (?, ?)');
      for (const row of transcripts) {
        transcriptInsertStmt.run(row.video_id, row.plain_text);
      }
      this.logger.log(`[FTS5 Rebuild] Populated ${transcripts.length} transcripts`);

      // Populate analyses_fts
      this.logger.log('[FTS5 Rebuild] Populating analyses_fts...');
      const analysesStmt = db.prepare('SELECT video_id, ai_analysis, summary FROM analyses');
      const analyses = analysesStmt.all() as any[];

      const analysisInsertStmt = db.prepare('INSERT INTO analyses_fts (video_id, content) VALUES (?, ?)');
      for (const row of analyses) {
        const contentForSearch = [row.ai_analysis, row.summary].filter(Boolean).join(' ');
        analysisInsertStmt.run(row.video_id, contentForSearch);
      }
      this.logger.log(`[FTS5 Rebuild] Populated ${analyses.length} analyses`);

      // Populate tags_fts
      this.logger.log('[FTS5 Rebuild] Populating tags_fts...');
      const tagsStmt = db.prepare('SELECT video_id, tag_name FROM tags');
      const tags = tagsStmt.all() as any[];

      const tagInsertStmt = db.prepare('INSERT INTO tags_fts (video_id, tag_name) VALUES (?, ?)');
      for (const row of tags) {
        tagInsertStmt.run(row.video_id, row.tag_name);
      }
      this.logger.log(`[FTS5 Rebuild] Populated ${tags.length} tags`);

      this.saveDatabase();

      const duration = Date.now() - startTime;
      this.logger.log(`[FTS5 Rebuild] Rebuild complete in ${duration}ms (${videos.length} videos, ${transcripts.length} transcripts, ${analyses.length} analyses, ${tags.length} tags)`);
    } catch (error: any) {
      this.logger.error(`[FTS5 Rebuild] Failed to rebuild FTS5 indexes: ${error?.message || 'Unknown error'}`);
      throw error;
    }
  }

  /**
   * Full-text search across all content using FTS5
   * Searches: filenames, transcripts, analyses, tags, descriptions
   *
   * Search features:
   * - Multiple words: ALL words must match (AND logic), but can be in different fields
   *   e.g., "foo bar" matches if "foo" is in filename and "bar" is in transcript
   * - Wildcards: * for prefix matching (e.g., "test*" matches "testing", "tests")
   *              ? for single character (converted to * for FTS5)
   * - Quoted phrases: "exact phrase" for consecutive word matching
   * - Special operators: OR, NOT (must be uppercase)
   *
   * @param query - Search query
   * @param limit - Maximum results to return
   * @param searchIn - Filter which fields to search: 'all' (default), 'filename', 'transcript', 'analysis'
   * @param options - Search options: useSoundex (phonetic matching), usePhraseSearch (AND logic for consecutive words)
   * @returns Array of video IDs with match info, sorted by relevance
   */
  searchFTS(
    query: string,
    limit: number = 100,
    searchIn?: string,
    options?: { useSoundex?: boolean; usePhraseSearch?: boolean }
  ): { videoId: string; score: number; matches: string[] }[] {
    const db = this.ensureInitialized();


    if (!query || query.trim().length === 0) {
      return [];
    }

    const trimmedQuery = query.trim();

    // Check if transcript/analysis search needs phrase matching
    // Transcript uses phonetic phrase matching (catches transcription errors)
    // Analysis uses exact phrase matching (AI-written text is accurate)
    const searchInFields = searchIn ? searchIn.split(',').map(s => s.trim()) : [];
    const searchAll = !searchIn || searchInFields.length === 0;
    const searchingTranscript = searchAll || searchInFields.includes('transcript');
    const searchingAnalysis = searchAll || searchInFields.includes('analysis');
    const hasQuotes = trimmedQuery.includes('"');
    const hasBooleanOps = /\s+(AND|OR|NOT)\s+/i.test(trimmedQuery);
    const usePhoneticMatching = searchingTranscript && !hasQuotes && !hasBooleanOps;
    const useAnalysisPhraseMatching = searchingAnalysis && !hasQuotes && !hasBooleanOps;

    this.logger.log(`[searchFTS] query="${trimmedQuery}", searchIn="${searchIn}", searchingTranscript=${searchingTranscript}, usePhoneticMatching=${usePhoneticMatching}`);

    // Parse the query into tokens (words, phrases, operators)
    const tokens = this.parseSearchQuery(trimmedQuery);

    if (tokens.length === 0) {
      return [];
    }

    // Separate positive and exclusion tokens
    const positiveTokens: string[] = [];
    const exclusionTokens: string[] = [];

    for (const token of tokens) {
      const cleanToken = token.endsWith(' OR') ? token.slice(0, -3) : token;
      if (cleanToken.startsWith('-') && cleanToken.length > 1) {
        exclusionTokens.push(cleanToken.substring(1)); // Remove the - prefix
      } else {
        positiveTokens.push(token);
      }
    }


    // If there are only exclusion tokens, return empty results
    // (FTS5 can't search for "everything except X" without a positive term)
    if (positiveTokens.length === 0) {
      return [];
    }

    // Group tokens by OR connectivity
    // Tokens ending with " OR" are connected to the next token
    // Example: "trans OR woke communist" -> [["trans", "woke"], ["communist"]]
    const tokenGroups: string[][] = [];
    let currentGroup: string[] = [];

    for (const token of positiveTokens) {
      const hasOr = token.endsWith(' OR');
      const cleanToken = hasOr ? token.slice(0, -3) : token;

      // Skip reserved keywords that would return null from FTS5 query
      // (AND, NOT, NEAR when uppercase - these are operators, not search terms)
      if (DatabaseService.FTS5_OPERATORS.has(cleanToken)) {
        continue;
      }

      currentGroup.push(cleanToken);

      if (!hasOr) {
        // End of OR chain, start new group
        if (currentGroup.length > 0) {
          tokenGroups.push(currentGroup);
        }
        currentGroup = [];
      }
    }

    // Don't forget trailing group if last token had OR
    if (currentGroup.length > 0) {
      tokenGroups.push(currentGroup);
    }


    // For each group, search and UNION results within group
    // Then INTERSECT across groups
    const groupResults: Map<string, { score: number; matches: Set<string> }>[] = [];

    for (const group of tokenGroups) {
      // Union all tokens in the group
      const groupMap = new Map<string, { score: number; matches: Set<string> }>();

      for (const token of group) {
        const tokenResults = this.searchSingleToken(db, token, limit * 3, searchIn, options);

        // Union: add all results, combining scores if already present
        for (const [videoId, data] of tokenResults) {
          if (groupMap.has(videoId)) {
            const existing = groupMap.get(videoId)!;
            existing.score += data.score;
            for (const m of data.matches) {
              existing.matches.add(m);
            }
          } else {
            groupMap.set(videoId, {
              score: data.score,
              matches: new Set(data.matches)
            });
          }
        }
      }

      groupResults.push(groupMap);
    }

    // Combine group results: UNION (OR) by default, INTERSECT (AND) if usePhraseSearch is enabled
    let finalResults: Map<string, { score: number; matches: Set<string> }>;
    const usePhraseSearch = options?.usePhraseSearch ?? false;

    if (groupResults.length === 0) {
      finalResults = new Map();
    } else if (groupResults.length === 1) {
      finalResults = groupResults[0];
    } else if (usePhraseSearch) {
      // INTERSECT: all words must match (AND logic - phrase search)
      // Start with first group's results
      finalResults = new Map(groupResults[0]);

      // Intersect with each subsequent group
      for (let i = 1; i < groupResults.length; i++) {
        const currentGroup = groupResults[i];
        const newResults = new Map<string, { score: number; matches: Set<string> }>();

        // Only keep videos that exist in both sets
        for (const [videoId, data] of finalResults) {
          if (currentGroup.has(videoId)) {
            const otherData = currentGroup.get(videoId)!;
            // Combine scores and matches
            newResults.set(videoId, {
              score: data.score + otherData.score,
              matches: new Set([...data.matches, ...otherData.matches])
            });
          }
        }

        finalResults = newResults;

        // Early exit if no matches
        if (finalResults.size === 0) {
          break;
        }
      }
    } else {
      // UNION: any word matches (OR logic - default word search)
      finalResults = new Map();
      for (const groupMap of groupResults) {
        for (const [videoId, data] of groupMap) {
          if (finalResults.has(videoId)) {
            const existing = finalResults.get(videoId)!;
            existing.score += data.score;
            for (const m of data.matches) {
              existing.matches.add(m);
            }
          } else {
            finalResults.set(videoId, {
              score: data.score,
              matches: new Set(data.matches)
            });
          }
        }
      }
    }

    // Apply exclusion filtering - remove videos that match any exclusion term
    if (exclusionTokens.length > 0 && finalResults.size > 0) {
      for (const exclusionTerm of exclusionTokens) {
        // Find videos matching the exclusion term
        const excludedVideos = this.searchSingleTokenForExclusion(db, exclusionTerm, limit * 3, searchIn);

        // Remove excluded videos from results
        for (const videoId of excludedVideos) {
          finalResults.delete(videoId);
        }
      }
    }

    // For searches that include transcript, apply phonetic phrase matching
    // This filters out false positive transcript matches where words appear separately
    if (usePhoneticMatching && finalResults.size > 0) {
      this.logger.log(`[searchFTS] Applying phonetic matching to ${finalResults.size} results`);
      const videosToRemove: string[] = [];

      for (const [videoId, data] of finalResults.entries()) {
        // Only check videos that matched on transcript
        if (!data.matches.has('transcript')) {
          continue;
        }

        // Fetch the actual transcript text
        try {
          const transcriptRow = db.prepare(
            'SELECT plain_text FROM transcripts WHERE video_id = ?'
          ).get(videoId) as { plain_text: string } | undefined;

          let passesPhoneticMatch = false;
          if (transcriptRow && transcriptRow.plain_text) {
            passesPhoneticMatch = this.matchesPhonetically(trimmedQuery, transcriptRow.plain_text);
          }

          if (!passesPhoneticMatch) {
            // Remove 'transcript' from match types since it's a false positive
            data.matches.delete('transcript');

            // If no other match types remain, remove the video entirely
            if (data.matches.size === 0) {
              videosToRemove.push(videoId);
            }
          }
        } catch (error) {
          this.logger.error(`Error fetching transcript for video ${videoId}:`, error);
          // On error, remove transcript match type but keep video if other matches exist
          data.matches.delete('transcript');
          if (data.matches.size === 0) {
            videosToRemove.push(videoId);
          }
        }
      }

      // Remove videos that have no remaining match types
      this.logger.log(`[searchFTS] Removing ${videosToRemove.length} videos with no valid matches`);
      for (const videoId of videosToRemove) {
        finalResults.delete(videoId);
      }
    }

    // For searches that include analysis, apply exact phrase matching
    // This filters out false positive analysis matches where words appear separately
    if (useAnalysisPhraseMatching && finalResults.size > 0) {
      this.logger.log(`[searchFTS] Applying analysis phrase matching to ${finalResults.size} results`);
      const videosToRemove: string[] = [];
      const phraseToMatch = trimmedQuery.toLowerCase();

      for (const [videoId, data] of finalResults.entries()) {
        // Only check videos that matched on analysis
        if (!data.matches.has('analysis')) {
          continue;
        }

        // Fetch the actual analysis text
        try {
          const analysisRow = db.prepare(
            'SELECT ai_analysis, summary FROM analyses WHERE video_id = ?'
          ).get(videoId) as { ai_analysis: string; summary: string } | undefined;

          let passesExactPhraseMatch = false;
          if (analysisRow) {
            const analysisText = ((analysisRow.ai_analysis || '') + ' ' + (analysisRow.summary || '')).toLowerCase();
            passesExactPhraseMatch = analysisText.includes(phraseToMatch);
          }

          if (!passesExactPhraseMatch) {
            // Remove 'analysis' from match types since it's a false positive
            data.matches.delete('analysis');

            // If no other match types remain, remove the video entirely
            if (data.matches.size === 0) {
              videosToRemove.push(videoId);
            }
          }
        } catch (error) {
          this.logger.error(`Error fetching analysis for video ${videoId}:`, error);
          data.matches.delete('analysis');
          if (data.matches.size === 0) {
            videosToRemove.push(videoId);
          }
        }
      }

      // Remove videos that have no remaining match types
      this.logger.log(`[searchFTS] Removing ${videosToRemove.length} videos with no valid analysis matches`);
      for (const videoId of videosToRemove) {
        finalResults.delete(videoId);
      }
    }

    // Convert to array and sort by score
    const sortedResults = Array.from(finalResults.entries())
      .map(([videoId, data]) => ({
        videoId,
        score: data.score,
        matches: Array.from(data.matches)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return sortedResults;
  }

  /**
   * Parse search query into tokens
   * Handles: quoted phrases, wildcards, operators
   */
  private parseSearchQuery(query: string): string[] {
    const tokens: string[] = [];

    // Match quoted phrases or individual words
    const regex = /"([^"]+)"|(\S+)/g;
    let match;

    while ((match = regex.exec(query)) !== null) {
      const token = match[1] || match[2]; // match[1] is quoted content, match[2] is word

      // Only UPPERCASE "OR" is treated as operator
      // Lowercase "or" is a regular search term
      if (token === 'OR') {
        // If previous token exists, mark it for OR logic
        if (tokens.length > 0) {
          tokens[tokens.length - 1] += ' OR';
        }
        continue;
      }

      if (token && token.trim().length > 0) {
        tokens.push(token.trim());
      }
    }

    return tokens;
  }

  /**
   * Search for a single token across FTS tables
   * @param searchIn - Filter which fields to search: 'all' (default), 'filename', 'transcript', 'analysis'
   * @param options - Search options: useSoundex (phonetic matching), usePhraseSearch (AND logic)
   */
  private searchSingleToken(
    db: any,
    token: string,
    limit: number,
    searchIn?: string,
    options?: { useSoundex?: boolean; usePhraseSearch?: boolean }
  ): Map<string, { score: number; matches: Set<string> }> {
    const results = new Map<string, { score: number; matches: Set<string> }>();

    // Check if token has OR suffix (from parseSearchQuery)
    const hasOr = token.endsWith(' OR');
    const cleanToken = hasOr ? token.slice(0, -3) : token;

    // Check if this is an exclusion term (starts with -)
    // If so, we can't use FTS5 for exclusion-only queries
    // Return empty results - exclusion will be handled at a higher level
    if (cleanToken.startsWith('-') && cleanToken.length > 1) {
      // Return empty map - the searchFTS method will handle exclusion filtering
      return results;
    }

    // Convert token to FTS5 query
    let ftsQuery = this.tokenToFTS5Query(cleanToken);

    // If tokenToFTS5Query returns null (e.g., for exclusion terms), skip FTS search
    if (!ftsQuery) {
      return results;
    }

    // Determine which tables to search based on searchIn filter
    // searchIn can be comma-separated like "filename,transcript" or a single value
    const searchInFields = searchIn ? searchIn.split(',').map(s => s.trim()) : [];
    const searchAll = !searchIn || searchInFields.length === 0;
    const searchFilename = searchAll || searchInFields.includes('filename');
    const searchTranscript = searchAll || searchInFields.includes('transcript');
    const searchAnalysis = searchAll || searchInFields.includes('analysis');


    // Search videos_fts (filename, path, and optionally ai_description)
    if (searchFilename) {
      // When searching filename only, restrict to filename and path columns
      // ai_description is analysis data, not filename data
      // FTS5 column filter syntax: {column1 column2}: term
      let videoFtsQuery = ftsQuery;
      if (!searchAll && !searchAnalysis) {
        // Only search filename and path, not ai_description
        videoFtsQuery = `{filename current_path}: ${ftsQuery}`;
      }

      try {
        const videosResults = db.prepare(`
          SELECT video_id, rank
          FROM videos_fts
          WHERE videos_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `).all(videoFtsQuery, limit) as any[];

        for (const row of videosResults) {
          if (!results.has(row.video_id)) {
            results.set(row.video_id, { score: 0, matches: new Set() });
          }
          const entry = results.get(row.video_id)!;
          entry.score += Math.abs(row.rank) * 2; // Videos weighted higher
          entry.matches.add('filename');
        }
      } catch (e) {
        this.logger.error(`FTS5 videos search error for "${videoFtsQuery}":`, e);
        throw e;
      }
    }

    // Search transcripts_fts
    if (searchTranscript) {
      // Track which videos matched via exact FTS
      const exactFtsMatches = new Set<string>();

      const transcriptResults = db.prepare(`
        SELECT video_id, rank
        FROM transcripts_fts
        WHERE transcripts_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, limit) as any[];

      for (const row of transcriptResults) {
        exactFtsMatches.add(row.video_id);
        if (!results.has(row.video_id)) {
          results.set(row.video_id, { score: 0, matches: new Set() });
        }
        const entry = results.get(row.video_id)!;
        entry.score += Math.abs(row.rank);
        entry.matches.add('transcript');
      }

      // Soundex (phonetic) search - only enabled when user opts in
      // This catches transcription errors like "Somalies" vs "Somalis"
      // but can also match unrelated words that share a soundex code (e.g., "hovind" matches "haven't")
      if (options?.useSoundex) {
        try {
          const cleanWord = cleanToken.replace(/\*/g, '');
          const soundexCode = this.soundex(cleanWord);

          if (soundexCode && soundexCode !== '0000') {
            const soundexResults = db.prepare(`
              SELECT video_id, rank
              FROM transcripts_soundex_fts
              WHERE transcripts_soundex_fts MATCH ?
              ORDER BY rank
              LIMIT ?
            `).all(soundexCode, limit) as any[];

            for (const row of soundexResults) {
              // Skip if this video already matched via exact FTS
              if (exactFtsMatches.has(row.video_id)) {
                continue;
              }

              if (!results.has(row.video_id)) {
                results.set(row.video_id, { score: 0, matches: new Set() });
              }
              const entry = results.get(row.video_id)!;
              // Lower score for phonetic matches (0.5x)
              entry.score += Math.abs(row.rank) * 0.5;
              entry.matches.add('transcript-phonetic');
            }
          }
        } catch (e) {
          // Soundex table might not exist yet, ignore
        }
      }
    }

    // Search analyses_fts
    if (searchAnalysis) {
      const analysesResults = db.prepare(`
        SELECT video_id, rank
        FROM analyses_fts
        WHERE analyses_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, limit) as any[];

      for (const row of analysesResults) {
        if (!results.has(row.video_id)) {
          results.set(row.video_id, { score: 0, matches: new Set() });
        }
        const entry = results.get(row.video_id)!;
        entry.score += Math.abs(row.rank) * 1.5; // Analysis weighted medium
        entry.matches.add('analysis');
      }
    }

    // Search tags_fts (only when searching all fields)
    if (searchAll) {
      const tagsResults = db.prepare(`
        SELECT video_id, rank
        FROM tags_fts
        WHERE tags_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, limit) as any[];

      for (const row of tagsResults) {
        if (!results.has(row.video_id)) {
          results.set(row.video_id, { score: 0, matches: new Set() });
        }
        const entry = results.get(row.video_id)!;
        entry.score += Math.abs(row.rank) * 3; // Tags weighted highest
        entry.matches.add('tags');
      }
    }

    return results;
  }

  /**
   * Search for a single token to find videos to exclude
   * Returns a Set of video IDs that match the exclusion term
   */
  private searchSingleTokenForExclusion(
    db: any,
    term: string,
    limit: number,
    searchIn?: string
  ): Set<string> {
    const excludedVideoIds = new Set<string>();

    // Convert term to FTS5 query - use the same logic as positive searches
    let ftsQuery = term;

    // Add wildcard for prefix matching if not already present
    if (!ftsQuery.includes('*') && ftsQuery.length >= 2) {
      ftsQuery = ftsQuery + '*';
    }

    // Determine which tables to search based on searchIn filter
    const searchInFields = searchIn ? searchIn.split(',').map(s => s.trim()) : [];
    const searchAll = !searchIn || searchInFields.length === 0;
    const searchFilename = searchAll || searchInFields.includes('filename');
    const searchTranscript = searchAll || searchInFields.includes('transcript');
    const searchAnalysis = searchAll || searchInFields.includes('analysis');

    // Search videos_fts
    if (searchFilename) {
      try {
        let videoFtsQuery = ftsQuery;
        if (!searchAll && !searchAnalysis) {
          videoFtsQuery = `{filename current_path}: ${ftsQuery}`;
        }
        const results = db.prepare(`
          SELECT video_id FROM videos_fts WHERE videos_fts MATCH ? LIMIT ?
        `).all(videoFtsQuery, limit) as any[];
        for (const row of results) {
          excludedVideoIds.add(row.video_id);
        }
      } catch (e) {
        this.logger.debug(`FTS5 exclusion search error for "${ftsQuery}":`, e);
      }
    }

    // Search transcripts_fts
    if (searchTranscript) {
      try {
        const results = db.prepare(`
          SELECT video_id FROM transcripts_fts WHERE transcripts_fts MATCH ? LIMIT ?
        `).all(ftsQuery, limit) as any[];
        for (const row of results) {
          excludedVideoIds.add(row.video_id);
        }
      } catch (e) {
        this.logger.debug(`FTS5 exclusion search error for "${ftsQuery}":`, e);
      }
    }

    // Search analyses_fts
    if (searchAnalysis) {
      try {
        const results = db.prepare(`
          SELECT video_id FROM analyses_fts WHERE analyses_fts MATCH ? LIMIT ?
        `).all(ftsQuery, limit) as any[];
        for (const row of results) {
          excludedVideoIds.add(row.video_id);
        }
      } catch (e) {
        this.logger.debug(`FTS5 exclusion search error for "${ftsQuery}":`, e);
      }
    }

    // Search tags_fts (only when searching all)
    if (searchAll) {
      try {
        const results = db.prepare(`
          SELECT video_id FROM tags_fts WHERE tags_fts MATCH ? LIMIT ?
        `).all(ftsQuery, limit) as any[];
        for (const row of results) {
          excludedVideoIds.add(row.video_id);
        }
      } catch (e) {
        this.logger.debug(`FTS5 exclusion search error for "${ftsQuery}":`, e);
      }
    }

    return excludedVideoIds;
  }

  // FTS5 reserved keywords - only UPPERCASE versions are treated as operators
  // Lowercase versions (and, or, not) are treated as regular search terms
  private static readonly FTS5_OPERATORS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

  /**
   * Convert a token to FTS5 query syntax
   * Returns null for exclusion-only terms (these must be filtered in post-processing)
   */
  private tokenToFTS5Query(token: string): string | null {
    // Skip empty or invalid tokens (just special chars, single dash, etc.)
    const alphanumericContent = token.replace(/[^a-zA-Z0-9]/g, '');
    if (!alphanumericContent || alphanumericContent.length === 0) {
      return null;
    }

    // Check if it's a phrase (contains spaces, originally was quoted)
    if (token.includes(' ')) {
      // Phrase query - must match consecutively
      return `"${token}"`;
    }

    // Handle NOT prefix (explicit, only uppercase)
    if (token.startsWith('NOT ')) {
      const term = token.slice(4);
      const subQuery = this.tokenToFTS5Query(term);
      if (!subQuery) return null;
      return `NOT ${subQuery}`;
    }

    // Handle - prefix for exclusion
    // FTS5 can't handle "NOT x" alone - it needs "positive_term NOT x"
    // So we convert "-word" to a special marker that the caller must handle
    if (token.startsWith('-') && token.length > 1) {
      // Return null to indicate this is an exclusion-only term
      // The caller should handle exclusions differently (post-filter results)
      return null;
    }

    // Only UPPERCASE reserved keywords are operators
    // Lowercase "and", "or", "not" are treated as regular search terms
    if (DatabaseService.FTS5_OPERATORS.has(token)) {
      // This shouldn't happen often since OR is handled in parseSearchQuery
      // but if it does, skip it as it's an operator without operands
      return null;
    }

    // Handle wildcards
    // * is already FTS5 compatible for prefix matching
    // ? is converted to * (FTS5 doesn't support single-char wildcards)
    let processed = token.replace(/\?/g, '*');

    // If no wildcard at end, add * for prefix matching (more forgiving search)
    // But not if it already has special characters or is very short
    if (!processed.includes('*') && processed.length >= 2) {
      processed = processed + '*';
    }

    return processed;
  }

  /**
   * Get the database instance for raw queries
   */
  getDatabase(): Database.Database {
    return this.ensureInitialized();
  }

  /**
   * Save the database to disk
   * Note: better-sqlite3 is synchronous and auto-commits, so this is a no-op
   * Kept for API compatibility with sql.js version
   */
  private saveDatabase() {
    // No-op: better-sqlite3 is synchronous and auto-commits
    // All changes are immediately persisted to disk
  }

  /**
   * Save the database to disk
   * Expose this publicly for services that need to save after raw queries
   */
  saveDatabaseToDisk() {
    this.saveDatabase();
  }

  /**
   * Flush any pending WAL frames into the main database file so an external
   * file-copy backup captures a consistent, fully-checkpointed database.
   * No-op when the DB is closed or not in WAL journal mode.
   */
  checkpointWal(): void {
    if (!this.db) {
      return;
    }
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (error: any) {
      this.logger.warn(`WAL checkpoint failed: ${error?.message || 'Unknown error'}`);
    }
  }

  /**
   * Canonical file_hash: SHA-256 of the file size plus 1MB samples taken from
   * the beginning, middle, and end (whole file when it is small). This is the
   * single algorithm used everywhere file_hash is written or compared —
   * FileScannerService.quickHashFile and RelinkingService.quickHashFile
   * delegate here so scan-added and import-added videos share one identity.
   *
   * @param filePath - Absolute path to the media file
   * @param fileSize - Optional pre-computed size; stat'd from disk when omitted
   * @returns SHA-256 hash string
   */
  async hashFile(filePath: string, fileSize?: number): Promise<string> {
    const size = fileSize ?? fs.statSync(filePath).size;
    const SAMPLE_SIZE = 1024 * 1024; // 1MB sample
    const hash = crypto.createHash('sha256');

    hash.update(size.toString());

    if (size <= SAMPLE_SIZE * 3) {
      // Small file - hash the whole thing
      hash.update(fs.readFileSync(filePath));
    } else {
      // Large file - sample beginning, middle, and end
      const sampleSize = Math.min(SAMPLE_SIZE, Math.floor(size / 3));
      const fd = fs.openSync(filePath, 'r');
      try {
        const buffer = Buffer.allocUnsafe(sampleSize);
        fs.readSync(fd, buffer, 0, sampleSize, 0);
        hash.update(buffer);
        fs.readSync(fd, buffer, 0, sampleSize, Math.floor(size / 2) - Math.floor(sampleSize / 2));
        hash.update(buffer);
        fs.readSync(fd, buffer, 0, sampleSize, size - sampleSize);
        hash.update(buffer);
      } finally {
        fs.closeSync(fd);
      }
    }

    return hash.digest('hex');
  }

  /**
   * Insert a new video/media record
   */
  insertVideo(video: {
    id: string;
    filename: string;
    fileHash: string;
    currentPath: string;
    uploadDate?: string; // Date from filename - when content was created/filmed
    durationSeconds?: number;
    fileSizeBytes?: number;
    sourceUrl?: string;
    mediaType?: string;
    fileExtension?: string;
    downloadDate?: string; // File's creation timestamp (when you downloaded it)
    width?: number;
    height?: number;
    fps?: number;
    /** True when ffprobe failed at import time — record is half-populated and retryable. */
    needsMetadata?: boolean;
  }): { inserted: boolean; existingId?: string } {
    const db = this.ensureInitialized();
    const now = new Date().toISOString();
    const downloadDate = video.downloadDate || now;

    // Convert to relative path for cross-platform compatibility
    const clipsFolder = this.getClipsFolderPath();
    const pathToStore = clipsFolder ? this.toRelativePath(video.currentPath, clipsFolder) : video.currentPath;

    // Determine media type from file extension if not provided
    let mediaType = video.mediaType;
    let fileExtension = video.fileExtension;

    if (!fileExtension && video.filename) {
      const dotIndex = video.filename.lastIndexOf('.');
      fileExtension = dotIndex === -1 ? undefined : video.filename.substring(dotIndex).toLowerCase();
    }

    if (!mediaType && fileExtension) {
      mediaType = this.getMediaTypeFromExtension(fileExtension);
    }

    // The dedup check and the insert run inside one synchronous transaction so
    // concurrent imports of the same file can never both pass the "not in DB"
    // check and double-insert.
    const insertVideoTxn = db.transaction((): { inserted: boolean; existingId?: string } => {
      // Check for existing video by hash (most reliable - same content)
      if (video.fileHash) {
        const existingByHash = db.prepare(
          `SELECT id FROM videos WHERE file_hash = ? LIMIT 1`
        ).get(video.fileHash) as { id: string } | undefined;

        if (existingByHash) {
          this.logger.warn(`Duplicate detected by hash: ${video.filename} matches existing ${existingByHash.id}`);
          return { inserted: false, existingId: existingByHash.id };
        }
      }

      // Check for existing video by filename (fallback)
      const existingByFilename = db.prepare(
        `SELECT id FROM videos WHERE filename = ? LIMIT 1`
      ).get(video.filename) as { id: string } | undefined;

      if (existingByFilename) {
        this.logger.warn(`Duplicate detected by filename: ${video.filename} matches existing ${existingByFilename.id}`);
        return { inserted: false, existingId: existingByFilename.id };
      }

      db.prepare(
        `INSERT OR REPLACE INTO videos (
          id, filename, file_hash, current_path, upload_date,
          duration_seconds, file_size_bytes, source_url, media_type, file_extension,
          download_date, last_verified, added_at, is_linked, width, height, fps,
          needs_metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
      ).run(
        video.id,
        video.filename,
        video.fileHash,
        pathToStore,
        video.uploadDate || null,
        video.durationSeconds || null,
        video.fileSizeBytes || null,
        video.sourceUrl || null,
        mediaType || 'video',
        fileExtension || null,
        downloadDate, // File's creation timestamp (when you downloaded it)
        now, // last_verified
        now, // added_at (when database entry was created)
        video.width || null,
        video.height || null,
        video.fps || null,
        video.needsMetadata ? 1 : 0
      );

      // Insert/update FTS5 table for video search
      // Delete existing entry first (if any)
      db.prepare(`DELETE FROM videos_fts WHERE video_id = ?`).run(video.id);
      // Insert new entry
      db.prepare(
        `INSERT INTO videos_fts (video_id, filename, current_path, ai_description) VALUES (?, ?, ?, ?)`
      ).run(video.id, video.filename, video.currentPath || '', ''); // ai_description is empty initially, updated later

      return { inserted: true };
    });
    const result = insertVideoTxn();

    this.saveDatabase();
    return result;
  }

  /**
   * Helper to determine media type from file extension
   */
  private getMediaTypeFromExtension(extension: string): string {
    const ext = extension.toLowerCase();

    // Video extensions
    if (['.mov', '.mp4', '.avi', '.mkv', '.webm', '.m4v', '.flv'].includes(ext)) {
      return 'video';
    }

    // Audio extensions
    if (['.mp3', '.m4a', '.m4b', '.aac', '.flac', '.wav', '.ogg'].includes(ext)) {
      return 'audio';
    }

    // Document extensions
    if (['.pdf', '.epub', '.mobi', '.txt', '.md'].includes(ext)) {
      return 'document';
    }

    // Image extensions
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) {
      return 'image';
    }

    // Web archive extensions
    if (['.html', '.htm', '.mhtml'].includes(ext)) {
      return 'webpage';
    }

    return 'video'; // default to video for unknown types
  }

  /**
   * Find video by filename
   */
  findVideoByFilename(filename: string): VideoRecord | null {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM videos WHERE filename = ?');
    const result = stmt.get(filename) as VideoRecord | undefined;
    return result ? this.resolveVideoPaths(result) : null;
  }

  /**
   * Find video by file hash
   */
  findVideoByHash(hash: string): VideoRecord | null {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM videos WHERE file_hash = ?');
    const result = stmt.get(hash) as VideoRecord | undefined;
    return result ? this.resolveVideoPaths(result) : null;
  }

  /**
   * Find video by source URL
   */
  findVideoByUrl(url: string): VideoRecord | null {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM videos WHERE source_url = ?');
    const result = stmt.get(url) as VideoRecord | undefined;
    return result ? this.resolveVideoPaths(result) : null;
  }

  /**
   * Find video by ID
   */
  findVideoById(id: string): VideoRecord | null {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM videos WHERE id = ?');
    const result = stmt.get(id) as VideoRecord | undefined;
    return result ? this.resolveVideoPaths(result) : null;
  }

  /**
   * Update video path (for relinking moved files)
   */
  updateVideoPath(id: string, newPath: string, uploadDate?: string) {
    const db = this.ensureInitialized();

    // Convert to relative path for cross-platform compatibility
    const clipsFolder = this.getClipsFolderPath();
    const relativePath = clipsFolder ? this.toRelativePath(newPath, clipsFolder) : newPath;

    db.prepare(
      `UPDATE videos
       SET current_path = ?,
           upload_date = COALESCE(?, upload_date),
           last_verified = ?,
           is_linked = 1
       WHERE id = ?`
    ).run(relativePath, uploadDate ?? null, new Date().toISOString(), id);

    this.saveDatabase();
  }

  /**
   * Update video metadata (upload_date, download_date, added_at, ai_description)
   */
  updateVideoMetadata(
    id: string,
    uploadDate?: string | null,
    downloadDate?: string,
    addedAt?: string,
    aiDescription?: string | null
  ) {
    const db = this.ensureInitialized();

    // Build dynamic UPDATE query based on provided fields
    const updates: string[] = [];
    const values: any[] = [];

    if (uploadDate !== undefined) {
      updates.push('upload_date = ?');
      values.push(uploadDate);
    }
    if (downloadDate !== undefined) {
      updates.push('download_date = ?');
      values.push(downloadDate);
    }
    if (addedAt !== undefined) {
      updates.push('added_at = ?');
      values.push(addedAt);
    }
    if (aiDescription !== undefined) {
      updates.push('ai_description = ?');
      values.push(aiDescription);
    }

    if (updates.length > 0) {
      values.push(id);
      db.prepare(`UPDATE videos SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      this.saveDatabase();
    }
  }

  /**
   * Update video technical metadata (duration, width, height, fps)
   * Used to verify/correct metadata during analysis
   */
  updateVideoTechnicalMetadata(
    id: string,
    metadata: {
      durationSeconds?: number;
      width?: number;
      height?: number;
      fps?: number;
    }
  ) {
    const db = this.ensureInitialized();

    const updates: string[] = [];
    const values: any[] = [];

    if (metadata.durationSeconds !== undefined) {
      updates.push('duration_seconds = ?');
      values.push(metadata.durationSeconds);
    }
    if (metadata.width !== undefined) {
      updates.push('width = ?');
      values.push(metadata.width);
    }
    if (metadata.height !== undefined) {
      updates.push('height = ?');
      values.push(metadata.height);
    }
    if (metadata.fps !== undefined) {
      updates.push('fps = ?');
      values.push(metadata.fps);
    }

    if (updates.length > 0) {
      values.push(id);
      db.prepare(`UPDATE videos SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      this.saveDatabase();
      this.logger.log(`[Technical Metadata] Updated video ${id}: ${JSON.stringify(metadata)}`);
    }
  }

  /**
   * Update video's source URL
   */
  updateVideoSourceUrl(id: string, sourceUrl: string | null) {
    const db = this.ensureInitialized();

    try {
      db.prepare(
        `UPDATE videos
         SET source_url = ?
         WHERE id = ?`
      ).run(sourceUrl, id);

      this.saveDatabase();
    } catch (error) {
      this.logger.error(`Failed to update source URL for video ${id}:`, error);
      throw error;
    }
  }

  /**
   * Update video's AI-generated description
   */
  updateVideoDescription(id: string, description: string | null) {
    const db = this.ensureInitialized();

    this.logger.log(`[AI Description] Updating description for video ${id}: ${description ? description.substring(0, 100) + '...' : 'null'}`);

    try {
      db.prepare(
        `UPDATE videos
         SET ai_description = ?
         WHERE id = ?`
      ).run(description, id);

      // Update FTS5 table for video search
      // Get filename and current_path for the FTS5 update
      const stmt = db.prepare('SELECT filename, current_path FROM videos WHERE id = ?');
      const row = stmt.get(id) as { filename: string; current_path: string } | undefined;
      if (row) {
        db.prepare(`DELETE FROM videos_fts WHERE video_id = ?`).run(id);
        db.prepare(
          `INSERT INTO videos_fts (video_id, filename, current_path, ai_description) VALUES (?, ?, ?, ?)`
        ).run(id, row.filename, row.current_path, description || '');
      }

      this.saveDatabase();
      this.logger.log(`[AI Description] Successfully updated description for video ${id}`);
    } catch (error: any) {
      // If column doesn't exist yet (pre-migration), just log and continue
      if (error.message && error.message.includes('no such column: ai_description')) {
        this.logger.warn('ai_description column does not exist yet - skipping description update');
      } else {
        this.logger.error(`[AI Description] Failed to update description: ${error.message}`);
        throw error;
      }
    }
  }

  updateVideoSuggestedTitle(id: string, suggestedTitle: string | null) {
    const db = this.ensureInitialized();

    this.logger.log(`[Suggested Title] Updating suggested title for video ${id}: ${suggestedTitle || 'null'}`);

    try {
      db.prepare(
        `UPDATE videos
         SET suggested_title = ?
         WHERE id = ?`
      ).run(suggestedTitle, id);

      this.saveDatabase();
      this.logger.log(`[Suggested Title] Successfully updated suggested title for video ${id}`);
    } catch (error: any) {
      // If column doesn't exist yet (pre-migration), just log and continue
      if (error.message && error.message.includes('no such column: suggested_title')) {
        this.logger.warn('suggested_title column does not exist yet - skipping suggested title update');
      } else {
        this.logger.error(`[Suggested Title] Failed to update suggested title: ${error.message}`);
        throw error;
      }
    }
  }

  /**
   * Update video's filename
   */
  updateVideoFilename(id: string, filename: string) {
    const db = this.ensureInitialized();

    try {
      db.prepare(
        `UPDATE videos
         SET filename = ?
         WHERE id = ?`
      ).run(filename, id);

      // Update FTS5 table for video search
      // Get current_path and ai_description for the FTS5 update
      const stmt = db.prepare('SELECT current_path, ai_description FROM videos WHERE id = ?');
      const row = stmt.get(id) as { current_path: string; ai_description: string | null } | undefined;
      if (row) {
        db.prepare(`DELETE FROM videos_fts WHERE video_id = ?`).run(id);
        db.prepare(
          `INSERT INTO videos_fts (video_id, filename, current_path, ai_description) VALUES (?, ?, ?, ?)`
        ).run(id, filename, row.current_path, row.ai_description || '');
      }

      this.saveDatabase();
    } catch (error) {
      this.logger.error(`Failed to update filename for video ${id}:`, error);
      throw error;
    }
  }

  /**
   * Update video's download date
   */
  updateVideoDownloadDate(id: string, downloadDate: string) {
    const db = this.ensureInitialized();

    try {
      db.prepare(
        `UPDATE videos
         SET download_date = ?
         WHERE id = ?`
      ).run(downloadDate, id);

      this.saveDatabase();
    } catch (error) {
      this.logger.error(`Failed to update download date for video ${id}:`, error);
      throw error;
    }
  }

  /**
   * Update video's upload date
   */
  updateVideoUploadDate(id: string, uploadDate: string | null) {
    const db = this.ensureInitialized();

    try {
      db.prepare(
        `UPDATE videos
         SET upload_date = ?
         WHERE id = ?`
      ).run(uploadDate, id);

      this.saveDatabase();
    } catch (error) {
      this.logger.error(`Failed to update upload date for video ${id}:`, error);
      throw error;
    }
  }

  /**
   * Update video's last processed date (set when any task completes on this video)
   */
  updateLastProcessedDate(id: string, date?: string) {
    const db = this.ensureInitialized();
    const processedDate = date || new Date().toISOString();

    try {
      db.prepare(
        `UPDATE videos
         SET last_processed_date = ?
         WHERE id = ?`
      ).run(processedDate, id);

      this.saveDatabase();
      this.logger.log(`Updated last_processed_date for video ${id}: ${processedDate}`);
    } catch (error) {
      this.logger.error(`Failed to update last_processed_date for video ${id}:`, error);
      throw error;
    }
  }

  /**
   * Get video by ID with computed flags
   */
  getVideoById(id: string): VideoRecordWithFlags | null {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT
        v.*,
        CASE WHEN EXISTS (SELECT 1 FROM videos WHERE parent_id = v.id) THEN 1 ELSE 0 END as has_children,
        CASE WHEN EXISTS (SELECT 1 FROM media_relationships mr WHERE mr.primary_media_id = v.id OR mr.related_media_id = v.id) THEN 1 ELSE 0 END as has_connections
      FROM videos v
      WHERE v.id = ?
    `);
    const result = stmt.get(id) as VideoRecordWithFlags | undefined;
    return result ? this.resolveVideoPaths(result) : null;
  }

  /**
   * Mark video as unlinked (file not found)
   */
  markVideoUnlinked(id: string) {
    const db = this.ensureInitialized();
    db.prepare('UPDATE videos SET is_linked = 0 WHERE id = ?').run(id);
    this.saveDatabase();
  }

  /**
   * Delete a video from the database
   * This will cascade delete all related records (transcripts, analyses, tags, sections)
   * Also deletes the associated thumbnail file
   * Returns the video record before deletion so caller can delete physical file
   */
  deleteVideo(id: string): VideoRecord {
    const db = this.ensureInitialized();

    // Get video info before deleting (for file path)
    const video = this.getVideoById(id);
    if (!video) {
      throw new Error('Video not found');
    }

    this.logger.log(`Deleting video ${id} and all related data`);

    // Deleting the video row cascades to transcripts/analyses/tags/sections via
    // FK ON DELETE CASCADE, but the FTS5 mirror tables are hand-maintained (no
    // triggers) so their rows would be left orphaned. Delete every FTS row this
    // video fed, then the video row, all in one transaction so we can never end
    // up with a half-cleaned index.
    const deleteVideoTxn = db.transaction((videoId: string) => {
      db.prepare('DELETE FROM videos_fts WHERE video_id = ?').run(videoId);
      db.prepare('DELETE FROM transcripts_fts WHERE video_id = ?').run(videoId);
      db.prepare('DELETE FROM transcripts_soundex_fts WHERE video_id = ?').run(videoId);
      db.prepare('DELETE FROM analyses_fts WHERE video_id = ?').run(videoId);
      db.prepare('DELETE FROM tags_fts WHERE video_id = ?').run(videoId);
      db.prepare('DELETE FROM videos WHERE id = ?').run(videoId);
    });
    deleteVideoTxn(id);

    this.saveDatabase();

    // Delete associated thumbnail only after the row delete has committed, so a
    // rolled-back transaction never leaves a live row with a missing thumbnail.
    this.thumbnailService.deleteThumbnail(id);

    return video;
  }

  /**
   * Prune/cleanup orphaned videos (videos marked as unlinked)
   * Deletes all database records for videos where is_linked = 0
   * Also deletes associated thumbnails
   * Returns count of deleted videos
   */
  pruneOrphanedVideos(): PruneResult {
    const db = this.ensureInitialized();

    // Get list of unlinked videos before deleting
    const stmt = db.prepare('SELECT id, filename FROM videos WHERE is_linked = 0');
    const unlinkedVideos = stmt.all() as Array<{ id: string; filename: string }>;

    if (unlinkedVideos.length === 0) {
      this.logger.log('No orphaned videos to prune');
      return { deletedCount: 0, deletedVideos: [] };
    }

    this.logger.log(`Pruning ${unlinkedVideos.length} orphaned videos from database`);

    const videoIds = unlinkedVideos.map(v => v.id);

    // Delete all unlinked videos (CASCADE will handle related base-table records)
    // plus their hand-maintained FTS5 mirror rows, in one transaction so the
    // index can never drift from the videos table.
    const pruneTxn = db.transaction((ids: string[]) => {
      const ftsDeletes = [
        db.prepare('DELETE FROM videos_fts WHERE video_id = ?'),
        db.prepare('DELETE FROM transcripts_fts WHERE video_id = ?'),
        db.prepare('DELETE FROM transcripts_soundex_fts WHERE video_id = ?'),
        db.prepare('DELETE FROM analyses_fts WHERE video_id = ?'),
        db.prepare('DELETE FROM tags_fts WHERE video_id = ?'),
      ];
      for (const id of ids) {
        for (const stmt of ftsDeletes) {
          stmt.run(id);
        }
      }
      db.prepare('DELETE FROM videos WHERE is_linked = 0').run();
    });
    pruneTxn(videoIds);

    this.saveDatabase();

    // Delete thumbnails only after the row deletes have committed.
    this.thumbnailService.deleteThumbnails(videoIds);

    return {
      deletedCount: unlinkedVideos.length,
      deletedVideos: unlinkedVideos
    };
  }

  /**
   * Clean up orphaned thumbnails
   * Finds and deletes thumbnails that don't have corresponding video records
   * Returns count of deleted orphaned thumbnails
   */
  cleanupOrphanedThumbnails(): { deletedCount: number; orphanedThumbnails: string[] } {
    const db = this.ensureInitialized();

    // Get all valid video IDs from database
    const videos = db.prepare('SELECT id FROM videos').all() as Array<{ id: string }>;
    const validVideoIds = new Set(videos.map(v => v.id));

    // Use ThumbnailService to find orphaned thumbnails
    const orphanedPaths = this.thumbnailService.findOrphanedThumbnails(validVideoIds);

    // Clean up orphaned thumbnails
    const deletedCount = this.thumbnailService.cleanupOrphanedThumbnails(validVideoIds);

    // Extract just the filenames from the paths
    const orphaned = orphanedPaths.map(p => path.basename(p));

    return {
      deletedCount,
      orphanedThumbnails: orphaned
    };
  }

  /**
   * Clean up duplicate video entries where filename doesn't match current_path basename
   * This fixes data integrity issues from improper file renames
   */
  cleanupDuplicateEntries(): { deletedCount: number; deletedEntries: Array<{ id: string; filename: string; current_path: string }> } {
    const db = this.ensureInitialized();

    // Find all videos where the filename doesn't match the current_path basename
    const mismatchedStmt = db.prepare(`
      SELECT id, filename, current_path
      FROM videos
      WHERE filename != REPLACE(current_path, RTRIM(current_path, REPLACE(current_path, '/', '')), '')
    `);
    const mismatched = mismatchedStmt.all() as Array<{ id: string; filename: string; current_path: string }>;

    // Filter to only entries where basename(current_path) != filename
    const toDelete = mismatched.filter(v => {
      const basename = path.basename(v.current_path);
      return basename !== v.filename;
    });

    if (toDelete.length === 0) {
      this.logger.log('[Cleanup] No mismatched duplicate entries found');
      return { deletedCount: 0, deletedEntries: [] };
    }

    this.logger.log(`[Cleanup] Found ${toDelete.length} entries with mismatched filename/path`);

    // Delete the mismatched entries
    const deleteStmt = db.prepare('DELETE FROM videos WHERE id = ?');
    let deletedCount = 0;

    for (const entry of toDelete) {
      try {
        deleteStmt.run(entry.id);
        deletedCount++;
        this.logger.log(`[Cleanup] Deleted entry: id=${entry.id}, filename=${entry.filename}, path=${entry.current_path}`);
      } catch (error: any) {
        this.logger.error(`[Cleanup] Failed to delete entry ${entry.id}: ${error.message}`);
      }
    }

    this.saveDatabase();
    this.logger.log(`[Cleanup] Successfully deleted ${deletedCount} mismatched duplicate entries`);

    return {
      deletedCount,
      deletedEntries: toDelete
    };
  }

  /**
   * Get all videos (excluding children - they are fetched separately via getChildVideos)
   */
  getAllVideos(options?: { linkedOnly?: boolean; limit?: number; offset?: number; includeChildren?: boolean }): VideoRecordWithFlags[] {
    const db = this.ensureInitialized();
    // has_transcript and has_analysis are now actual columns (maintained by triggers/updates)
    // suggested_title comes from the videos table itself, not from analyses
    let query = `
      SELECT
        v.*,
        CASE WHEN EXISTS (SELECT 1 FROM videos WHERE parent_id = v.id) THEN 1 ELSE 0 END as has_children,
        CASE WHEN EXISTS (SELECT 1 FROM media_relationships mr WHERE mr.primary_media_id = v.id OR mr.related_media_id = v.id) THEN 1 ELSE 0 END as has_connections,
        wa.domain as wa_domain,
        wa.favicon_path as wa_favicon_path,
        wa.original_url as wa_original_url,
        wa.page_title as wa_page_title
      FROM videos v
      LEFT JOIN web_archives wa ON wa.video_id = v.id
    `;
    const params: any[] = [];

    const conditions: string[] = [];

    if (options?.linkedOnly) {
      conditions.push('v.is_linked = 1');
    }

    // By default, only show parent/root videos (not children)
    // Children will be fetched separately via getChildVideos()
    if (!options?.includeChildren) {
      conditions.push('v.parent_id IS NULL');
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY v.download_date DESC';

    if (options?.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    } else if (options?.offset) {
      // SQLite requires a LIMIT when OFFSET is present; -1 means "no limit".
      query += ' LIMIT -1';
    }

    if (options?.offset) {
      query += ' OFFSET ?';
      params.push(options.offset);
    }

    const stmt = db.prepare(query);
    const results = params.length > 0 ? stmt.all(...params) : stmt.all();
    this.logger.debug(`[getAllVideos] SQL returned ${results.length} rows`);

    return this.resolveVideoPathsArray(results as VideoRecordWithFlags[]);
  }

  /**
   * Get all videos in hierarchical structure (parents with their children)
   * Returns a flat array with children immediately following their parent
   */
  getAllVideosHierarchical(options?: { linkedOnly?: boolean }): Array<VideoRecordWithFlags & { isParent: boolean; isChild: boolean }> {
    // Get all parent/root videos
    const parents = this.getAllVideos({
      linkedOnly: options?.linkedOnly,
      includeChildren: false
    });

    const results: Array<VideoRecordWithFlags & { isParent: boolean; isChild: boolean }> = [];

    // For each parent, add it and then its children
    for (const parent of parents) {
      results.push({
        ...parent,
        isParent: true,
        isChild: false
      });

      // Get children for this parent
      const children = this.getChildVideos(parent.id);
      for (const child of children) {
        results.push({
          ...child,
          has_transcript: (child as any).has_transcript ?? 0,
          has_analysis: (child as any).has_analysis ?? 0,
          has_children: 0,
          has_connections: 0,
          isParent: false,
          isChild: true,
          parent_id: parent.id
        });
      }
    }

    return results;
  }

  /**
   * Insert transcript for a video
   */
  insertTranscript(transcript: {
    videoId: string;
    plainText: string;
    srtFormat: string;
    whisperModel?: string;
    language?: string;
    transcriptionTimeSeconds?: number;
  }) {
    const db = this.ensureInitialized();

    // Compute soundex content for phonetic search
    const soundexContent = this.textToSoundex(transcript.plainText);

    const insertTranscriptTxn = db.transaction(() => {
      db.prepare(
        `INSERT OR REPLACE INTO transcripts (
          video_id, plain_text, srt_format, whisper_model, language, transcribed_at, transcription_time_seconds, soundex_content
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        transcript.videoId,
        transcript.plainText,
        transcript.srtFormat,
        transcript.whisperModel || null,
        transcript.language || null,
        new Date().toISOString(),
        transcript.transcriptionTimeSeconds || null,
        soundexContent,
      );

      // Update FTS5 table for transcript search
      // Delete existing entry first (if any)
      db.prepare(`DELETE FROM transcripts_fts WHERE video_id = ?`).run(transcript.videoId);
      // Insert new entry
      db.prepare(
        `INSERT INTO transcripts_fts (video_id, content) VALUES (?, ?)`
      ).run(transcript.videoId, transcript.plainText);

      // Update soundex FTS5 table for phonetic search
      db.prepare(`DELETE FROM transcripts_soundex_fts WHERE video_id = ?`).run(transcript.videoId);
      db.prepare(
        `INSERT INTO transcripts_soundex_fts (video_id, soundex_content) VALUES (?, ?)`
      ).run(transcript.videoId, soundexContent);

      // Update has_transcript flag in videos table
      db.prepare(
        `UPDATE videos SET has_transcript = 1 WHERE id = ?`
      ).run(transcript.videoId);
    });
    insertTranscriptTxn();

    this.saveDatabase();
    this.logger.log(`Set has_transcript flag for video ${transcript.videoId}`);
  }

  /**
   * Get transcript for a video
   */
  getTranscript(videoId: string): TranscriptRecord | null {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM transcripts WHERE video_id = ?');
    const result = stmt.get(videoId) as TranscriptRecord | undefined;
    return result || null;
  }

  /**
   * Insert analysis for a video
   */
  insertAnalysis(analysis: {
    videoId: string;
    aiAnalysis: string;
    summary?: string;
    sectionsCount?: number;
    aiModel: string;
    aiProvider?: string;
    analysisTimeSeconds?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    estimatedCost?: number;
    apiCalls?: number;
  }) {
    const db = this.ensureInitialized();

    // Combine analysis and summary for better search
    const contentForSearch = [analysis.aiAnalysis, analysis.summary].filter(Boolean).join(' ');

    const insertAnalysisTxn = db.transaction(() => {
      db.prepare(
        `INSERT OR REPLACE INTO analyses (
          video_id, ai_analysis, summary, sections_count, ai_model, ai_provider, analyzed_at, analysis_time_seconds,
          input_tokens, output_tokens, total_tokens, estimated_cost, api_calls
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        analysis.videoId,
        analysis.aiAnalysis,
        analysis.summary || null,
        analysis.sectionsCount || null,
        analysis.aiModel,
        analysis.aiProvider || null,
        new Date().toISOString(),
        analysis.analysisTimeSeconds || null,
        analysis.inputTokens || null,
        analysis.outputTokens || null,
        analysis.totalTokens || null,
        analysis.estimatedCost || null,
        analysis.apiCalls || null,
      );

      // Update FTS5 table for analysis search
      // Delete existing entry first (if any)
      db.prepare(`DELETE FROM analyses_fts WHERE video_id = ?`).run(analysis.videoId);
      // Insert new entry
      db.prepare(
        `INSERT INTO analyses_fts (video_id, content) VALUES (?, ?)`
      ).run(analysis.videoId, contentForSearch);

      // Update has_analysis flag in videos table
      db.prepare(
        `UPDATE videos SET has_analysis = 1 WHERE id = ?`
      ).run(analysis.videoId);
    });
    insertAnalysisTxn();

    this.saveDatabase();
    this.logger.log(`Set has_analysis flag for video ${analysis.videoId}`);
  }

  /**
   * Get analysis for a video
   */
  getAnalysis(videoId: string): AnalysisRecord | null {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM analyses WHERE video_id = ?');
    const result = stmt.get(videoId) as AnalysisRecord | undefined;
    return result || null;
  }

  /**
   * Delete analysis for a video (only deletes AI-generated sections, preserves user markers)
   */
  deleteAnalysis(videoId: string) {
    const db = this.ensureInitialized();
    const txn = db.transaction((id: string) => {
      // Delete only AI-generated sections (preserve user-created custom markers)
      this.deleteAIAnalysisSections(id);
      // Then delete the analysis record
      db.prepare('DELETE FROM analyses WHERE video_id = ?').run(id);
      // Remove the hand-maintained FTS mirror row (no trigger keeps it in sync)
      db.prepare('DELETE FROM analyses_fts WHERE video_id = ?').run(id);
      // Clear the denormalized flag so the videos table stays consistent
      db.prepare('UPDATE videos SET has_analysis = 0 WHERE id = ?').run(id);
    });
    txn(videoId);
    this.logger.log(`Deleted AI analysis for video ${videoId}`);
  }

  /**
   * Delete only AI-generated analysis sections for a video (preserves user markers)
   */
  deleteAIAnalysisSections(videoId: string) {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM analysis_sections WHERE video_id = ? AND source = ?').run(videoId, 'ai');
    this.logger.log(`Deleted AI analysis sections for video ${videoId} (preserving user markers)`);
  }

  /**
   * Delete all analysis sections for a video (including user markers)
   * WARNING: This deletes everything. Use deleteAIAnalysisSections to preserve user markers.
   */
  deleteAnalysisSections(videoId: string) {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM analysis_sections WHERE video_id = ?').run(videoId);
    this.logger.log(`Deleted ALL analysis sections for video ${videoId}`);
  }

  /**
   * Delete a specific analysis section by ID
   */
  deleteAnalysisSection(sectionId: string) {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM analysis_sections WHERE id = ?').run(sectionId);
    this.logger.log(`Deleted analysis section ${sectionId}`);
  }

  /**
   * Delete all tags for a video
   */
  deleteTagsForVideo(videoId: string) {
    const db = this.ensureInitialized();
    const txn = db.transaction((id: string) => {
      db.prepare('DELETE FROM tags WHERE video_id = ?').run(id);
      // This removes ALL of the video's tags, so its whole tags_fts mirror goes too
      db.prepare('DELETE FROM tags_fts WHERE video_id = ?').run(id);
    });
    txn(videoId);
    this.logger.log(`Deleted tags for video ${videoId}`);
  }

  /**
   * Rebuild a single video's tags_fts mirror from its remaining tags rows.
   *
   * tags_fts is a hand-maintained FTS5 table keyed only on (video_id, tag_name)
   * — it has no tag id or source column, so a partial tag delete (one tag, or
   * only AI tags) cannot be mirrored by a targeted `DELETE ... WHERE`. Instead we
   * clear this video's mirror rows and re-insert one per surviving tag. Must be
   * called inside a transaction alongside the tags-table delete so search can
   * never observe a torn state. Caller holds the connection.
   */
  private rebuildTagsFtsForVideo(db: Database.Database, videoId: string): void {
    db.prepare('DELETE FROM tags_fts WHERE video_id = ?').run(videoId);
    const remaining = db
      .prepare('SELECT tag_name FROM tags WHERE video_id = ?')
      .all(videoId) as Array<{ tag_name: string }>;
    const insert = db.prepare('INSERT INTO tags_fts (video_id, tag_name) VALUES (?, ?)');
    for (const row of remaining) {
      insert.run(videoId, row.tag_name);
    }
  }

  /**
   * Delete only AI-generated tags for a video (preserves user-created tags)
   */
  deleteAITagsForVideo(videoId: string) {
    const db = this.ensureInitialized();
    const txn = db.transaction((id: string) => {
      db.prepare('DELETE FROM tags WHERE video_id = ? AND source = ?').run(id, 'ai');
      // Partial delete → rebuild the FTS mirror from the surviving (user) tags so
      // deleted AI tags don't linger as orphaned search hits.
      this.rebuildTagsFtsForVideo(db, id);
    });
    txn(videoId);
    this.saveDatabase();
    this.logger.log(`Deleted AI-generated tags for video ${videoId}`);
  }

  /**
   * Delete a specific tag by ID
   */
  deleteTag(tagId: string) {
    const db = this.ensureInitialized();
    const txn = db.transaction((id: string) => {
      // Capture the owning video BEFORE deleting so we know whose mirror to rebuild.
      const row = db
        .prepare('SELECT video_id FROM tags WHERE id = ?')
        .get(id) as { video_id: string } | undefined;
      db.prepare('DELETE FROM tags WHERE id = ?').run(id);
      if (row) {
        this.rebuildTagsFtsForVideo(db, row.video_id);
      }
    });
    txn(tagId);
    this.saveDatabase();
    this.logger.log(`Deleted tag ${tagId}`);
  }

  /**
   * Delete transcript for a video
   */
  deleteTranscript(videoId: string) {
    const db = this.ensureInitialized();
    const txn = db.transaction((id: string) => {
      db.prepare('DELETE FROM transcripts WHERE video_id = ?').run(id);
      // Remove the hand-maintained FTS mirror rows this transcript fed
      db.prepare('DELETE FROM transcripts_fts WHERE video_id = ?').run(id);
      db.prepare('DELETE FROM transcripts_soundex_fts WHERE video_id = ?').run(id);
      // Clear the denormalized flag so the videos table stays consistent
      db.prepare('UPDATE videos SET has_transcript = 0 WHERE id = ?').run(id);
    });
    txn(videoId);
    this.logger.log(`Deleted transcript for video ${videoId}`);
  }

  /**
   * Insert an analysis section
   */
  insertAnalysisSection(section: {
    id: string;
    videoId: string;
    startSeconds: number;
    endSeconds: number;
    timestampText?: string;
    title?: string;
    description?: string;
    category?: string;
    source?: string;
    /**
     * The verifier's verdict for this row. OMITTED means legacy/discovery — the
     * column is written NULL and every reader treats it as 'flag'. Callers on
     * the ranked path always pass one, including 'skip'.
     */
    verdict?: 'flag' | 'skip';
    /** The ranker's score for this row's category. Omitted on paths with no score. */
    nliScore?: number;
  }) {
    const db = this.ensureInitialized();

    db.prepare(
      `INSERT INTO analysis_sections (
        id, video_id, start_seconds, end_seconds, timestamp_text, title, description, category, source,
        verdict, nli_score
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      section.id,
      section.videoId,
      section.startSeconds,
      section.endSeconds,
      section.timestampText || null,
      section.title || null,
      section.description || null,
      section.category || null,
      section.source || 'ai',
      section.verdict ?? null,
      typeof section.nliScore === 'number' && Number.isFinite(section.nliScore)
        ? section.nliScore
        : null,
    );

    this.saveDatabase();
  }

  // ---------------------------------------------------------------- flag verdict cache

  /**
   * Look up a previously answered verification question. Returns null on a miss
   * and on any error — the cache is an optimization and must never be able to
   * take an analysis down, so a broken or missing table degrades to "ask the
   * model", which is exactly the behavior before the cache existed.
   */
  getFlagVerdict(questionHash: string): FlagVerdictCacheRecord | null {
    try {
      const db = this.ensureInitialized();
      const row = db
        .prepare('SELECT * FROM flag_verdict_cache WHERE question_hash = ?')
        .get(questionHash) as FlagVerdictCacheRecord | undefined;
      return row || null;
    } catch (error: any) {
      this.logger.debug(`Flag verdict cache lookup failed: ${error?.message || 'unknown error'}`);
      return null;
    }
  }

  /**
   * Record an answer. INSERT OR REPLACE, because the only way the same hash is
   * written twice with a different verdict is a non-deterministic grader, and in
   * that case the newest answer is the one to keep.
   *
   * Deliberately does NOT call saveDatabase(): a flag run writes hundreds of
   * these and the cache is disposable. The rows are committed by better-sqlite3
   * the moment they are written; saveDatabase() is the library's own bookkeeping
   * hook and running it per verdict would cost more than the cache saves.
   */
  putFlagVerdict(entry: {
    questionHash: string;
    category: string;
    verifierModel: string;
    promptVersion: string;
    verdict: 'flag' | 'skip';
  }): void {
    try {
      const db = this.ensureInitialized();
      db.prepare(
        `INSERT OR REPLACE INTO flag_verdict_cache (
          question_hash, category, verifier_model, prompt_version, verdict, created_at, last_hit_at, hit_count
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0)`
      ).run(
        entry.questionHash,
        entry.category,
        entry.verifierModel,
        entry.promptVersion,
        entry.verdict,
        new Date().toISOString(),
      );
    } catch (error: any) {
      this.logger.debug(`Flag verdict cache write failed: ${error?.message || 'unknown error'}`);
    }
  }

  /** Count a hit, so the table itself shows which questions keep coming back. */
  recordFlagVerdictHit(questionHash: string): void {
    try {
      const db = this.ensureInitialized();
      db.prepare(
        'UPDATE flag_verdict_cache SET hit_count = hit_count + 1, last_hit_at = ? WHERE question_hash = ?'
      ).run(new Date().toISOString(), questionHash);
    } catch (error: any) {
      this.logger.debug(`Flag verdict cache hit bump failed: ${error?.message || 'unknown error'}`);
    }
  }

  /** Row count, for logging a run's cache state. Returns 0 when unavailable. */
  countFlagVerdicts(): number {
    try {
      const db = this.ensureInitialized();
      const row = db.prepare('SELECT COUNT(*) as count FROM flag_verdict_cache').get() as
        | { count: number }
        | undefined;
      return row?.count ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Get all sections for a video (both AI and custom markers)
   */
  getAnalysisSections(videoId: string): Array<AnalysisSectionRecord | CustomMarkerRecord> {
    const db = this.ensureInitialized();

    // Get AI-generated sections
    const aiStmt = db.prepare(
      'SELECT *, \'ai\' as source FROM analysis_sections WHERE video_id = ? ORDER BY start_seconds'
    );
    const aiResults = aiStmt.all(videoId) as AnalysisSectionRecord[];

    // Get custom markers
    const customStmt = db.prepare(
      'SELECT *, \'user\' as source FROM custom_markers WHERE video_id = ? ORDER BY start_seconds'
    );
    const customResults = customStmt.all(videoId) as CustomMarkerRecord[];

    // Merge and sort by start time
    const allSections: Array<AnalysisSectionRecord | CustomMarkerRecord> = [...aiResults, ...customResults];
    allSections.sort((a, b) => a.start_seconds - b.start_seconds);

    return allSections;
  }

  /**
   * Insert a custom marker
   */
  insertCustomMarker(marker: {
    id: string;
    videoId: string;
    startSeconds: number;
    endSeconds: number;
    timestampText?: string;
    title?: string;
    description?: string;
    category?: string;
  }) {
    const db = this.ensureInitialized();

    db.prepare(
      `INSERT INTO custom_markers (
        id, video_id, start_seconds, end_seconds, timestamp_text, title, description, category, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      marker.id,
      marker.videoId,
      marker.startSeconds,
      marker.endSeconds,
      marker.timestampText || null,
      marker.title || null,
      marker.description || null,
      marker.category || 'custom',
      new Date().toISOString(),
    );

    this.saveDatabase();
  }

  /**
   * Get all custom markers for a video
   */
  getCustomMarkers(videoId: string): CustomMarkerRecord[] {
    const db = this.ensureInitialized();
    const stmt = db.prepare(
      'SELECT * FROM custom_markers WHERE video_id = ? ORDER BY start_seconds'
    );
    const results = stmt.all(videoId) as CustomMarkerRecord[];
    return results;
  }

  /**
   * Delete a specific custom marker by ID
   */
  deleteCustomMarker(markerId: string) {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM custom_markers WHERE id = ?').run(markerId);
    this.saveDatabase();
    this.logger.log(`Deleted custom marker ${markerId}`);
  }

  /**
   * Delete all custom markers for a video
   */
  deleteCustomMarkers(videoId: string) {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM custom_markers WHERE video_id = ?').run(videoId);
    this.saveDatabase();
    this.logger.log(`Deleted all custom markers for video ${videoId}`);
  }

  /**
   * Update a custom marker
   */
  updateCustomMarker(marker: {
    id: string;
    startSeconds?: number;
    endSeconds?: number;
    timestampText?: string;
    title?: string;
    description?: string;
    category?: string;
  }) {
    const db = this.ensureInitialized();

    const updates: string[] = [];
    const values: any[] = [];

    if (marker.startSeconds !== undefined) {
      updates.push('start_seconds = ?');
      values.push(marker.startSeconds);
    }
    if (marker.endSeconds !== undefined) {
      updates.push('end_seconds = ?');
      values.push(marker.endSeconds);
    }
    if (marker.timestampText !== undefined) {
      updates.push('timestamp_text = ?');
      values.push(marker.timestampText);
    }
    if (marker.title !== undefined) {
      updates.push('title = ?');
      values.push(marker.title);
    }
    if (marker.description !== undefined) {
      updates.push('description = ?');
      values.push(marker.description);
    }
    if (marker.category !== undefined) {
      updates.push('category = ?');
      values.push(marker.category);
    }

    if (updates.length === 0) return;

    values.push(marker.id);
    const sql = `UPDATE custom_markers SET ${updates.join(', ')} WHERE id = ?`;
    db.prepare(sql).run(...values);
    this.saveDatabase();
    this.logger.log(`Updated custom marker ${marker.id}`);
  }

  // ==================== MUTE SECTIONS ====================

  /**
   * Insert a mute section
   */
  insertMuteSection(section: {
    id: string;
    videoId: string;
    startSeconds: number;
    endSeconds: number;
  }) {
    const db = this.ensureInitialized();

    db.prepare(
      `INSERT INTO mute_sections (
        id, video_id, start_seconds, end_seconds, created_at
      ) VALUES (?, ?, ?, ?, ?)`
    ).run(
      section.id,
      section.videoId,
      section.startSeconds,
      section.endSeconds,
      new Date().toISOString(),
    );

    this.saveDatabase();
    this.logger.log(`Inserted mute section ${section.id} for video ${section.videoId}`);
  }

  /**
   * Get all mute sections for a video
   */
  getMuteSections(videoId: string): MuteSectionRecord[] {
    const db = this.ensureInitialized();
    const stmt = db.prepare(
      'SELECT * FROM mute_sections WHERE video_id = ? ORDER BY start_seconds'
    );
    return stmt.all(videoId) as MuteSectionRecord[];
  }

  /**
   * Delete a specific mute section by ID
   */
  deleteMuteSection(sectionId: string) {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM mute_sections WHERE id = ?').run(sectionId);
    this.saveDatabase();
    this.logger.log(`Deleted mute section ${sectionId}`);
  }

  /**
   * Update a mute section's start/end times
   */
  updateMuteSection(sectionId: string, startSeconds: number, endSeconds: number) {
    const db = this.ensureInitialized();
    db.prepare('UPDATE mute_sections SET start_seconds = ?, end_seconds = ? WHERE id = ?')
      .run(startSeconds, endSeconds, sectionId);
    this.saveDatabase();
    this.logger.log(`Updated mute section ${sectionId}: ${startSeconds}s - ${endSeconds}s`);
  }

  /**
   * Delete all mute sections for a video
   */
  deleteMuteSections(videoId: string) {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM mute_sections WHERE video_id = ?').run(videoId);
    this.saveDatabase();
    this.logger.log(`Deleted all mute sections for video ${videoId}`);
  }

  // ==================== CHAPTERS ====================

  /**
   * Insert a chapter
   */
  insertChapter(chapter: {
    id: string;
    videoId: string;
    sequence: number;
    startSeconds: number;
    endSeconds: number;
    title: string;
    description?: string;
    source?: string;
  }) {
    const db = this.ensureInitialized();

    db.prepare(
      `INSERT INTO chapters (
        id, video_id, sequence, start_seconds, end_seconds, title, description, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      chapter.id,
      chapter.videoId,
      chapter.sequence,
      chapter.startSeconds,
      chapter.endSeconds,
      chapter.title,
      chapter.description || null,
      chapter.source || 'ai',
      new Date().toISOString(),
    );

    this.saveDatabase();
  }

  /**
   * Get all chapters for a video, ordered by sequence
   */
  getChapters(videoId: string): ChapterRecord[] {
    const db = this.ensureInitialized();
    const stmt = db.prepare(
      'SELECT * FROM chapters WHERE video_id = ? ORDER BY sequence'
    );
    return stmt.all(videoId) as ChapterRecord[];
  }

  /**
   * Delete a specific chapter by ID
   */
  deleteChapter(chapterId: string) {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM chapters WHERE id = ?').run(chapterId);
    this.saveDatabase();
    this.logger.log(`Deleted chapter ${chapterId}`);
  }

  /**
   * Delete all chapters for a video
   */
  deleteChapters(videoId: string) {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM chapters WHERE video_id = ?').run(videoId);
    this.saveDatabase();
    this.logger.log(`Deleted all chapters for video ${videoId}`);
  }

  /**
   * Update a chapter
   */
  updateChapter(chapter: {
    id: string;
    sequence?: number;
    startSeconds?: number;
    endSeconds?: number;
    title?: string;
    description?: string;
  }) {
    const db = this.ensureInitialized();

    const updates: string[] = [];
    const values: any[] = [];

    if (chapter.sequence !== undefined) {
      updates.push('sequence = ?');
      values.push(chapter.sequence);
    }
    if (chapter.startSeconds !== undefined) {
      updates.push('start_seconds = ?');
      values.push(chapter.startSeconds);
    }
    if (chapter.endSeconds !== undefined) {
      updates.push('end_seconds = ?');
      values.push(chapter.endSeconds);
    }
    if (chapter.title !== undefined) {
      updates.push('title = ?');
      values.push(chapter.title);
    }
    if (chapter.description !== undefined) {
      updates.push('description = ?');
      values.push(chapter.description);
    }

    if (updates.length === 0) return;

    values.push(chapter.id);
    const sql = `UPDATE chapters SET ${updates.join(', ')} WHERE id = ?`;
    db.prepare(sql).run(...values);
    this.saveDatabase();
    this.logger.log(`Updated chapter ${chapter.id}`);
  }

  /**
   * Insert a tag
   */
  insertTag(
    videoIdOrTag: string | {
      id: string;
      videoId: string;
      tagName: string;
      tagType?: string;
      confidence?: number;
      source?: string;
    },
    tagName?: string,
    tagType?: string,
    confidence?: number,
    source?: string
  ): string {
    const db = this.ensureInitialized();

    let tag: {
      id: string;
      videoId: string;
      tagName: string;
      tagType?: string;
      confidence?: number;
      source?: string;
    };

    // Support both object and individual parameters
    if (typeof videoIdOrTag === 'string') {
      const { v4: uuidv4 } = require('uuid');
      tag = {
        id: uuidv4(),
        videoId: videoIdOrTag,
        tagName: tagName!,
        tagType,
        confidence,
        source
      };
    } else {
      tag = videoIdOrTag;
    }

    db.prepare(
      `INSERT INTO tags (id, video_id, tag_name, tag_type, confidence, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      tag.id,
      tag.videoId,
      tag.tagName,
      tag.tagType || null,
      tag.confidence || null,
      tag.source || null,
      new Date().toISOString(),
    );

    // Update FTS5 table for tag search
    // Insert into tags_fts (don't delete first since multiple tags per video)
    db.prepare(
      `INSERT INTO tags_fts (video_id, tag_name) VALUES (?, ?)`
    ).run(tag.videoId, tag.tagName);

    this.saveDatabase();
    return tag.id;
  }

  /**
   * Get all tags for a video
   */
  getTags(videoId: string): TagRecord[] {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM tags WHERE video_id = ?');
    const results = stmt.all(videoId) as TagRecord[];
    return results;
  }

  /**
   * Get all tags across all videos
   */
  getAllTags(): TagRecord[] {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM tags');
    const results = stmt.all() as TagRecord[];
    return results;
  }

  /**
   * Get all tags with counts, grouped by type
   */
  getAllTagsWithCounts(): Record<string, Array<{ name: string; count: number }>> {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT tag_name, tag_type, COUNT(*) as count
      FROM tags
      GROUP BY tag_name, tag_type
      ORDER BY count DESC, tag_name ASC
    `);

    const tags = stmt.all() as TagWithCountRecord[];

    // Group by type
    const grouped: Record<string, Array<{ name: string; count: number }>> = {
      people: [],
      topic: [],
      other: [],
    };

    for (const tag of tags) {
      const type = tag.tag_type || 'other';
      const group = grouped[type] || grouped.other;
      group.push({ name: tag.tag_name, count: tag.count });
    }

    return grouped;
  }

  /**
   * Get video IDs that have all of the specified tags
   */
  getVideoIdsByTags(tagNames: string[]): string[] {
    if (tagNames.length === 0) {
      return [];
    }

    // Build a query that finds videos with ANY of the specified tags (case-insensitive)
    const placeholders = tagNames.map(() => '?').join(',');
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT DISTINCT video_id
      FROM tags
      WHERE LOWER(tag_name) IN (${placeholders})
    `);
    // Convert tag names to lowercase for case-insensitive matching
    const rows = stmt.all(...tagNames.map(t => t.toLowerCase())) as any[];
    const results = rows.map(row => row.video_id);

    console.log(`[getVideoIdsByTags] Searching for tags:`, tagNames, `Found ${results.length} videos`);

    // Debug: Let's see what tags exist in the database
    const allTagsStmt = db.prepare(`SELECT DISTINCT tag_name FROM tags LIMIT 20`);
    const sampleTagRows = allTagsStmt.all() as any[];
    const sampleTags = sampleTagRows.map(row => row.tag_name);
    console.log(`[getVideoIdsByTags] Sample tags in database:`, sampleTags);

    return results;
  }

  /**
   * Full-text search in transcripts
   */
  searchTranscripts(query: string, limit = 50): TranscriptSearchRecord[] {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT video_id, snippet(transcripts_fts, 1, '<mark>', '</mark>', '...', 32) as snippet
      FROM transcripts_fts
      WHERE content MATCH ?
      LIMIT ?
    `);
    const results = stmt.all(query, limit) as TranscriptSearchRecord[];
    return results;
  }

  /**
   * Full-text search in analyses
   */
  searchAnalyses(query: string, limit = 50): AnalysisSearchRecord[] {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT video_id, snippet(analyses_fts, 1, '<mark>', '</mark>', '...', 32) as snippet
      FROM analyses_fts
      WHERE content MATCH ?
      LIMIT ?
    `);
    const results = stmt.all(query, limit) as AnalysisSearchRecord[];
    return results;
  }

  /**
   * Get database statistics
   */
  getStats(): StatsRecord {
    const db = this.ensureInitialized();

    const getCount = (query: string): number => {
      const stmt = db.prepare(query);
      const result = stmt.get() as { count: number };
      return result.count;
    };

    const totalVideos = getCount('SELECT COUNT(*) as count FROM videos');
    const linkedVideos = getCount('SELECT COUNT(*) as count FROM videos WHERE is_linked = 1');
    const withTranscripts = getCount('SELECT COUNT(*) as count FROM transcripts');
    const withAnalyses = getCount('SELECT COUNT(*) as count FROM analyses');
    const totalTags = getCount('SELECT COUNT(*) as count FROM tags');

    return {
      totalVideos,
      linkedVideos,
      unlinkedVideos: totalVideos - linkedVideos,
      withTranscripts,
      withAnalyses,
      totalTags,
    };
  }

  /**
   * Compute Soundex code for a word (phonetic encoding)
   * Returns a 4-character code: first letter + 3 digits
   * Words that sound similar produce the same code
   */
  private soundex(word: string): string {
    if (!word || word.length === 0) return '0000';

    const clean = word.toUpperCase().replace(/[^A-Z]/g, '');
    if (clean.length === 0) return '0000';

    const firstLetter = clean[0];

    // Soundex encoding map - groups letters by similar sounds
    const codes: { [key: string]: string } = {
      'B': '1', 'F': '1', 'P': '1', 'V': '1',
      'C': '2', 'G': '2', 'J': '2', 'K': '2', 'Q': '2', 'S': '2', 'X': '2', 'Z': '2',
      'D': '3', 'T': '3',
      'L': '4',
      'M': '5', 'N': '5',
      'R': '6',
      // A, E, I, O, U, H, W, Y are not coded (vowels/semivowels)
    };

    let result = firstLetter;
    let prevCode = codes[firstLetter] || '';

    for (let i = 1; i < clean.length && result.length < 4; i++) {
      const code = codes[clean[i]];
      if (code && code !== prevCode) {
        result += code;
        prevCode = code;
      } else if (!code) {
        prevCode = ''; // Vowels reset the previous code
      }
    }

    // Pad with zeros to ensure 4 characters
    return (result + '000').substring(0, 4);
  }

  /**
   * Convert text to soundex-encoded version (each word becomes its soundex code)
   * Used for phonetic search in transcripts
   */
  private textToSoundex(text: string): string {
    if (!text) return '';

    return text
      .split(/\s+/)
      .map(word => {
        // Clean word of punctuation
        const clean = word.replace(/[^\w]/g, '');
        if (clean.length < 2) return ''; // Skip very short words
        return this.soundex(clean);
      })
      .filter(code => code && code !== '0000')
      .join(' ');
  }

  /**
   * Levenshtein distance - minimum edits to transform one string to another
   */
  private levenshteinDistance(str1: string, str2: string): number {
    const m = str1.length;
    const n = str2.length;

    if (m === 0) return n;
    if (n === 0) return m;

    let prevRow = Array(n + 1).fill(0).map((_, i) => i);
    let currRow = Array(n + 1).fill(0);

    for (let i = 1; i <= m; i++) {
      currRow[0] = i;

      for (let j = 1; j <= n; j++) {
        const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
        currRow[j] = Math.min(
          prevRow[j] + 1,      // deletion
          currRow[j - 1] + 1,  // insertion
          prevRow[j - 1] + cost // substitution
        );
      }

      [prevRow, currRow] = [currRow, prevRow];
    }

    return prevRow[n];
  }

  /**
   * Check if two words match phonetically
   */
  private wordsMatchPhonetically(search: string, text: string): boolean {
    // Exact match
    if (text === search) return true;

    // Very short words (1-2 chars) - require exact match only
    if (search.length <= 2) {
      return text === search;
    }

    // Substring match (only if search is 3+ chars to avoid false positives)
    if (search.length >= 3 && (text.includes(search) || search.includes(text))) return true;

    // Soundex match (only for 3+ char words)
    if (search.length >= 3) {
      const searchSoundex = this.soundex(search);
      const textSoundex = this.soundex(text);
      if (searchSoundex && textSoundex && searchSoundex === textSoundex && searchSoundex !== '0000') return true;
    }

    // Levenshtein distance scaled by word length
    const maxDistance = Math.max(1, Math.floor(search.length / 3));
    if (this.levenshteinDistance(search, text) <= maxDistance) return true;

    return false;
  }

  /**
   * Phonetic phrase matching - words must appear consecutively in order
   * - Unquoted: phonetic phrase match (each word matched phonetically)
   * - Double quotes: exact phrase match
   */
  private matchesPhonetically(query: string, text: string): boolean {
    const textLower = text.toLowerCase();
    const textWords = textLower.split(/\s+/).filter(w => w.length > 0);

    // Check for exact phrase (double quotes)
    const exactPhraseMatch = query.match(/^"([^"]+)"$/);
    if (exactPhraseMatch) {
      return textLower.includes(exactPhraseMatch[1].toLowerCase());
    }

    // Unquoted: phonetic phrase match - find words in order
    const searchWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    if (searchWords.length === 0) return false;

    // Find starting positions where all search words match consecutively
    for (let startIdx = 0; startIdx <= textWords.length - searchWords.length; startIdx++) {
      let allMatch = true;
      let textIdx = startIdx;

      for (const searchWord of searchWords) {
        if (textIdx >= textWords.length) {
          allMatch = false;
          break;
        }

        const textWord = textWords[textIdx];
        if (!this.wordsMatchPhonetically(searchWord, textWord)) {
          allMatch = false;
          break;
        }
        textIdx++;
      }

      if (allMatch) return true;
    }

    return false;
  }

  /**
   * Build FTS5 query from user input with improved search logic
   *
   * Features:
   * - AND by default: "dad vax bribe" → matches videos with ALL terms
   * - Exclusion: "-full" → excludes videos containing "full"
   * - Quoted phrases: "exact phrase" → matches exact phrase
   * - Wildcards: dad* → matches dad, dads, daddy, etc.
   * - Explicit OR: dad OR vax → matches either term
   * - Prefix matching: partial terms automatically get * suffix
   *
   * Examples:
   * - "dad vax bribe" → dad AND vax AND bribe
   * - "vax -full" → vax AND NOT full (has vax, excludes full)
   * - '"anti vax"' → exact phrase "anti vax"
   * - "dad* vax*" → dad* AND vax* (prefix matching)
   * - "dad OR vax" → dad OR vax (explicit OR)
   * - "vax -full -complete" → vax AND NOT full AND NOT complete
   *
   * @param useOrLogic - If true, use OR between terms (for filename search). Default is AND.
   */
  private buildFTS5Query(query: string, useOrLogic: boolean = false): string {
    query = query.trim();

    // Handle quoted phrases first (preserve them)
    const phrases: string[] = [];
    let processedQuery = query.replace(/"([^"]+)"/g, (match, phrase) => {
      const placeholder = `__PHRASE_${phrases.length}__`;
      phrases.push(`"${phrase}"`);
      return placeholder;
    });

    // Check if user explicitly used OR (case insensitive)
    const hasExplicitOr = /\s+OR\s+/i.test(processedQuery);

    // Split by whitespace and filter empty strings
    const terms = processedQuery.split(/\s+/).filter(t => t.length > 0);

    // Separate positive and negative terms
    const positiveTerms: string[] = [];
    const negativeTerms: string[] = [];

    // Process each term
    for (let term of terms) {
      // Restore phrases
      if (term.startsWith('__PHRASE_')) {
        const index = parseInt(term.replace('__PHRASE_', '').replace('__', ''));
        positiveTerms.push(phrases[index]);
        continue;
      }

      // Skip OR operator
      if (term.toUpperCase() === 'OR') {
        positiveTerms.push('OR');
        continue;
      }

      // Handle exclusion (NOT) with - prefix
      const isExclusion = term.startsWith('-');
      if (isExclusion) {
        term = term.substring(1); // Remove the - prefix
      }

      // Remove special characters except wildcards
      term = term.replace(/[^\w*]/g, '');

      // Skip empty terms
      if (!term) {
        continue;
      }

      // Add prefix wildcard if term doesn't already have one and is longer than 2 chars
      // This allows partial matching: "vax" matches "vaccine", "vax", "vaxxed", etc.
      if (!term.includes('*') && term.length > 2) {
        term = term + '*';
      }

      // Add to appropriate array
      if (isExclusion) {
        negativeTerms.push(term);
      } else {
        positiveTerms.push(term);
      }
    }

    // FTS5 requires at least one positive term before using NOT
    // If only negative terms exist, add a wildcard to match everything
    if (positiveTerms.length === 0 && negativeTerms.length > 0) {
      positiveTerms.push('*');
    }

    // Build the query
    let result = '';

    if (hasExplicitOr || useOrLogic) {
      // Use OR between terms (explicit OR or filename search)
      result = positiveTerms.join(' OR ');
    } else {
      // Default to implicit AND (space-separated)
      result = positiveTerms.join(' ');
    }

    // Add NOT terms (FTS5 syntax: "positive_term NOT negative_term")
    for (const negTerm of negativeTerms) {
      result += ` NOT ${negTerm}`;
    }

    return result;
  }

  /**
   * Build soundex-based FTS5 query for phonetic search
   * Converts search words to their soundex codes
   */
  private buildSoundexSearchQuery(query: string): string {
    query = query.trim();

    // Remove quoted phrases (soundex doesn't work well with phrases)
    query = query.replace(/"[^"]+"/g, '');

    // Split into words and filter
    const words = query.split(/\s+/).filter(w => w.length > 0);

    const soundexTerms: string[] = [];

    for (let word of words) {
      // Skip OR operator
      if (word.toUpperCase() === 'OR') continue;

      // Skip exclusion terms (they start with -)
      if (word.startsWith('-')) continue;

      // Remove wildcards for soundex
      word = word.replace(/\*/g, '');

      // Clean word of special characters
      word = word.replace(/[^\w]/g, '');

      // Skip very short words
      if (word.length < 2) continue;

      // Convert to soundex
      const code = this.soundex(word);
      if (code && code !== '0000') {
        soundexTerms.push(code);
      }
    }

    // Return empty if no valid terms
    if (soundexTerms.length === 0) return '';

    // FTS5 query with all soundex codes (AND logic)
    return soundexTerms.join(' ');
  }

  /**
   * Search videos with full-text search across filename, AI description, transcripts, analyses, and tags
   * Uses FTS5 for high-performance full-text search
   * Returns video IDs that match the search query
   */
  searchVideos(
    query: string,
    limit: number = 1000,
    filters?: {
      filename?: boolean;
      aiDescription?: boolean;
      transcript?: boolean;
      analysis?: boolean;
      tags?: boolean;
    }
  ): SearchResultRecord[] {
    const db = this.ensureInitialized();

    if (!query || query.trim() === '') {
      return [];
    }

    // Prepare FTS5 queries - OR logic for filename (word search), AND for others (phrase search)
    const filenameSearchTerm = this.buildFTS5Query(query, true);  // OR logic for filenames
    const transcriptSearchTerm = this.buildFTS5Query(query, false); // AND logic for transcripts
    const results = new Map<string, { id: string; score: number; matchType: string }>();

    // Default all filters to true if not specified
    const searchFilters = {
      filename: filters?.filename !== false,
      aiDescription: filters?.aiDescription !== false,
      transcript: filters?.transcript !== false,
      analysis: filters?.analysis !== false,
      tags: filters?.tags !== false,
    };

    // Helper to add or update result
    const addResult = (videoId: string, score: number, matchType: string) => {
      const existing = results.get(videoId);
      if (!existing || existing.score < score) {
        results.set(videoId, { id: videoId, score, matchType });
      }
    };

    // 1. Search in video filename and AI description using FTS5 (highest priority)
    // Uses OR logic - any word match counts (more intuitive for filename search)
    if (searchFilters.filename || searchFilters.aiDescription) {
      try {
        const stmt = db.prepare(`
          SELECT video_id, bm25(videos_fts) as score
          FROM videos_fts
          WHERE videos_fts MATCH ?
          ORDER BY bm25(videos_fts)
          LIMIT ?
        `);
        const rows = stmt.all(filenameSearchTerm, limit) as Array<{ video_id: string; score: number }>;

        for (const row of rows) {
          // FTS5 bm25 scores are negative, more negative = better match
          // Convert to positive score (100 = best, lower = worse)
          const score = 100 + Math.min(0, row.score);
          addResult(row.video_id, score, 'filename');
        }
      } catch (error) {
        this.logger.error('Error searching videos FTS5 table:', error);
        throw error;
      }
    }

    // 2. Search in transcripts using FTS5 (high priority)
    // Uses AND logic - all words must be present (phrase search)
    if (searchFilters.transcript) {
      const stmt = db.prepare(`
        SELECT video_id, bm25(transcripts_fts) as score
        FROM transcripts_fts
        WHERE transcripts_fts MATCH ?
        ORDER BY bm25(transcripts_fts)
        LIMIT ?
      `);
      const rows = stmt.all(transcriptSearchTerm, limit) as Array<{ video_id: string; score: number }>;

      for (const row of rows) {
        const score = 80 + Math.min(0, row.score);
        addResult(row.video_id, score, 'transcript');
      }

      // 2b. Also search soundex FTS for phonetic matches (catches transcription errors)
      // Convert search terms to soundex and search the phonetic index
      try {
        const soundexSearchTerm = this.buildSoundexSearchQuery(query);
        if (soundexSearchTerm) {
          const soundexStmt = db.prepare(`
            SELECT video_id, bm25(transcripts_soundex_fts) as score
            FROM transcripts_soundex_fts
            WHERE transcripts_soundex_fts MATCH ?
            ORDER BY bm25(transcripts_soundex_fts)
            LIMIT ?
          `);
          const soundexRows = soundexStmt.all(soundexSearchTerm, limit) as Array<{ video_id: string; score: number }>;

          for (const row of soundexRows) {
            // Phonetic matches get slightly lower priority than exact matches
            const score = 75 + Math.min(0, row.score);
            addResult(row.video_id, score, 'transcript-phonetic');
          }
        }
      } catch (error) {
        // Soundex FTS table might not exist yet (pre-migration) - silently skip
        this.logger.debug('Soundex search skipped (table may not exist yet)');
      }
    }

    // 3. Search in analyses using FTS5 (medium priority)
    // Uses AND logic - all words must be present (phrase search)
    if (searchFilters.analysis) {
      const stmt = db.prepare(`
        SELECT video_id, bm25(analyses_fts) as score
        FROM analyses_fts
        WHERE analyses_fts MATCH ?
        ORDER BY bm25(analyses_fts)
        LIMIT ?
      `);
      const rows = stmt.all(transcriptSearchTerm, limit) as Array<{ video_id: string; score: number }>;

      for (const row of rows) {
        const score = 70 + Math.min(0, row.score);
        addResult(row.video_id, score, 'analysis');
      }

      // Also search in analysis sections (no FTS5 table for sections, LIKE is required here)
      const searchLike = `%${query.toLowerCase().trim()}%`;
      const sectionsStmt = db.prepare(`
        SELECT DISTINCT video_id
        FROM analysis_sections
        WHERE lower(title) LIKE ? OR lower(description) LIKE ?
        LIMIT ?
      `);
      const sectionRows = sectionsStmt.all(searchLike, searchLike, limit) as Array<{ video_id: string }>;

      for (const row of sectionRows) {
        addResult(row.video_id, 65, 'section');
      }
    }

    // 4. Search in tags using FTS5 (lower priority)
    // Uses OR logic - any word match counts (tags are short like filenames)
    if (searchFilters.tags) {
      const stmt = db.prepare(`
        SELECT video_id, bm25(tags_fts) as score
        FROM tags_fts
        WHERE tags_fts MATCH ?
        ORDER BY bm25(tags_fts)
        LIMIT ?
      `);
      const rows = stmt.all(filenameSearchTerm, limit) as Array<{ video_id: string; score: number }>;

      for (const row of rows) {
        const score = 60 + Math.min(0, row.score);
        addResult(row.video_id, score, 'tag');
      }
    }

    // Convert map to array and sort by score (descending)
    const sortedResults = Array.from(results.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return sortedResults;
  }

  // ============================================================================
  // MEDIA RELATIONSHIPS OPERATIONS
  // ============================================================================

  /**
   * Create a media relationship (link two media items together)
   */
  insertMediaRelationship(relationship: {
    id: string;
    primaryMediaId: string;
    relatedMediaId: string;
    relationshipType: string;
  }) {
    const db = this.ensureInitialized();

    if (relationship.primaryMediaId === relationship.relatedMediaId) {
      throw new Error('An item cannot be connected to itself');
    }

    // Connections are undirected: enforce symmetric uniqueness (a↔b equals b↔a).
    const existing = db.prepare(
      `SELECT id FROM media_relationships
       WHERE (primary_media_id = ? AND related_media_id = ?)
          OR (primary_media_id = ? AND related_media_id = ?)`
    ).get(
      relationship.primaryMediaId, relationship.relatedMediaId,
      relationship.relatedMediaId, relationship.primaryMediaId,
    );
    if (existing) {
      this.logger.log(`Media relationship already exists between ${relationship.primaryMediaId} and ${relationship.relatedMediaId}`);
      return;
    }

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO media_relationships (
        id, primary_media_id, related_media_id, relationship_type, created_at
      ) VALUES (?, ?, ?, ?, ?)`
    ).run(
      relationship.id,
      relationship.primaryMediaId,
      relationship.relatedMediaId,
      relationship.relationshipType,
      now,
    );

    this.saveDatabase();
  }

  /**
   * Delete the connection between two items regardless of direction.
   */
  deleteConnectionBetween(mediaIdA: string, mediaIdB: string) {
    const db = this.ensureInitialized();
    db.prepare(
      `DELETE FROM media_relationships
       WHERE (primary_media_id = ? AND related_media_id = ?)
          OR (primary_media_id = ? AND related_media_id = ?)`
    ).run(mediaIdA, mediaIdB, mediaIdB, mediaIdA);
    this.saveDatabase();
  }

  /**
   * Get all related media for a given media item
   */
  getRelatedMedia(mediaId: string): MediaRelationshipRecord[] {
    const db = this.ensureInitialized();

    // Get relationships where this item is primary
    const primaryStmt = db.prepare(`
      SELECT r.*, v.filename, v.current_path, v.media_type, v.file_extension
      FROM media_relationships r
      JOIN videos v ON r.related_media_id = v.id
      WHERE r.primary_media_id = ?
    `);
    const primaryResults = primaryStmt.all(mediaId) as MediaRelationshipRecord[];

    // Get relationships where this item is related
    const relatedStmt = db.prepare(`
      SELECT r.*, v.filename, v.current_path, v.media_type, v.file_extension
      FROM media_relationships r
      JOIN videos v ON r.primary_media_id = v.id
      WHERE r.related_media_id = ?
    `);
    const relatedResults = relatedStmt.all(mediaId) as MediaRelationshipRecord[];

    return [...primaryResults, ...relatedResults];
  }

  /**
   * Get every OTHER member of a media item's connected group (its whole
   * relationship component), treating media_relationships as undirected edges.
   *
   * A recursive CTE walks outward from `mediaId`: at each hop it follows an
   * edge in either direction (CASE picks the neighbor), incrementing a depth
   * counter. UNION dedups the frontier so cycles terminate; the depth < 100
   * guard caps runaway walks on pathological data (real components are tiny).
   * The self node is excluded from the result.
   */
  getConnectedGroup(mediaId: string): ConnectedGroupMember[] {
    const db = this.ensureInitialized();

    return db.prepare(`
      WITH RECURSIVE component(node, depth) AS (
        SELECT ?, 0
        UNION
        SELECT
          CASE WHEN r.primary_media_id = c.node THEN r.related_media_id
               ELSE r.primary_media_id END,
          c.depth + 1
        FROM media_relationships r
        JOIN component c
          ON (r.primary_media_id = c.node OR r.related_media_id = c.node)
        WHERE c.depth < 100
      )
      SELECT DISTINCT v.id, v.filename, v.media_type, v.file_extension
      FROM component
      JOIN videos v ON v.id = component.node
      WHERE component.node != ?
      LIMIT 500
    `).all(mediaId, mediaId) as ConnectedGroupMember[];
  }

  /**
   * Delete a media relationship
   */
  deleteMediaRelationship(relationshipId: string) {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM media_relationships WHERE id = ?').run(relationshipId);
    this.saveDatabase();
    this.logger.log(`Deleted media relationship ${relationshipId}`);
  }

  /**
   * Delete all relationships for a media item
   */
  deleteAllMediaRelationships(mediaId: string) {
    const db = this.ensureInitialized();
    db.prepare(
      'DELETE FROM media_relationships WHERE primary_media_id = ? OR related_media_id = ?'
    ).run(mediaId, mediaId);
    this.saveDatabase();
    this.logger.log(`Deleted all media relationships for ${mediaId}`);
  }

  /**
   * Remove a media item from its connected group entirely. Every edge of an
   * item is by definition within its own component, so deleting all of the
   * item's edges cleanly detaches it (and splits the component wherever it was
   * the only bridge). Equivalent to deleteAllMediaRelationships, exposed under
   * the group vocabulary the connections rework speaks in.
   */
  removeFromGroup(mediaId: string) {
    this.deleteAllMediaRelationships(mediaId);
  }

  // ============================================================================
  // PARENT-CHILD OPERATIONS
  // ============================================================================

  /**
   * Set a video as a child of another video (parent-child relationship)
   * Now uses many-to-many junction table
   * @param childId - ID of the child video
   * @param parentId - ID of the parent video (null to remove ALL parents)
   */
  setVideoParent(childId: string, parentId: string | null) {
    const db = this.ensureInitialized();

    // Validate that the child exists
    const child = this.getVideoById(childId);
    if (!child) {
      throw new Error(`Child video not found: ${childId}`);
    }

    // If parentId is null, remove all parent relationships for this child
    if (parentId === null) {
      // Mirror the removal into the connections model (dual-write transition)
      const parents = this.getParentVideos(childId);
      for (const p of parents) {
        this.deleteConnectionBetween(p.id, childId);
      }

      db.prepare(
        'DELETE FROM video_relationships WHERE child_id = ?'
      ).run(childId);

      // Also clear the deprecated parent_id column for backwards compatibility
      db.prepare(
        'UPDATE videos SET parent_id = NULL WHERE id = ?'
      ).run(childId);

      this.saveDatabase();
      this.logger.log(`Removed all parents from video ${childId}`);
      return;
    }

    // Validate that the parent exists
    const parent = this.getVideoById(parentId);
    if (!parent) {
      throw new Error(`Parent video not found: ${parentId}`);
    }

    // Prevent child from being its own parent
    if (childId === parentId) {
      throw new Error('A video cannot be its own parent');
    }

    // Check if relationship already exists
    const existing = db.prepare(
      'SELECT id FROM video_relationships WHERE parent_id = ? AND child_id = ?'
    ).get(parentId, childId);

    if (existing) {
      this.logger.warn(`Child ${childId} is already linked to parent ${parentId}`);
      return;
    }

    // Create the relationship
    const { v4: uuidv4 } = require('uuid');
    db.prepare(`
      INSERT INTO video_relationships (id, parent_id, child_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(
      uuidv4(),
      parentId,
      childId,
      new Date().toISOString()
    );

    // Dual-write into the connections model (transition: connections are the
    // UI's source of truth; parent/child stays for legacy flows)
    this.insertMediaRelationship({
      id: uuidv4(),
      primaryMediaId: parentId,
      relatedMediaId: childId,
      relationshipType: 'connected',
    });

    this.saveDatabase();
    this.logger.log(`Linked video ${childId} as child of ${parentId}`);
  }

  /**
   * Get all children of a parent video
   * Now uses many-to-many junction table
   * @param parentId - ID of the parent video
   * @returns Array of child videos
   */
  getChildVideos(parentId: string): VideoRecord[] {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT v.* FROM videos v
      INNER JOIN video_relationships vr ON v.id = vr.child_id
      WHERE vr.parent_id = ?
      ORDER BY vr.created_at ASC
    `);
    const results = stmt.all(parentId) as VideoRecord[];
    return this.resolveVideoPathsArray(results);
  }

  /**
   * Get all parents of a video (now supports multiple parents)
   * @param videoId - ID of the video
   * @returns Array of parent videos
   */
  getParentVideos(videoId: string): VideoRecord[] {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT v.* FROM videos v
      INNER JOIN video_relationships vr ON v.id = vr.parent_id
      WHERE vr.child_id = ?
      ORDER BY vr.created_at ASC
    `);
    const results = stmt.all(videoId) as VideoRecord[];
    return this.resolveVideoPathsArray(results);
  }

  /**
   * Get the parent of a video (if it has one)
   * @deprecated Use getParentVideos() instead for multiple parents support
   * @param videoId - ID of the video
   * @returns First parent video or null
   */
  getParentVideo(videoId: string): VideoRecord | null {
    const parents = this.getParentVideos(videoId);
    return parents.length > 0 ? parents[0] : null;
  }

  /**
   * Check if a video has any children
   * Now uses many-to-many junction table
   * @param videoId - ID of the video
   * @returns True if video has children
   */
  hasChildren(videoId: string): boolean {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT COUNT(*) as count FROM video_relationships WHERE parent_id = ?');
    const result = stmt.get(videoId) as any;
    return result.count > 0;
  }

  /**
   * Remove all children from a parent
   * @param parentId - ID of the parent video
   */
  removeAllChildren(parentId: string) {
    const db = this.ensureInitialized();

    // Mirror the removal into the connections model (dual-write transition)
    const children = this.getChildVideos(parentId);
    for (const c of children) {
      this.deleteConnectionBetween(parentId, c.id);
    }

    db.prepare('DELETE FROM video_relationships WHERE parent_id = ?').run(parentId);

    // Also clear deprecated parent_id column for backwards compatibility
    db.prepare('UPDATE videos SET parent_id = NULL WHERE parent_id = ?').run(parentId);

    this.saveDatabase();
    this.logger.log(`Removed all children from parent ${parentId}`);
  }

  /**
   * Remove a specific parent-child relationship
   * @param parentId - ID of the parent video
   * @param childId - ID of the child video
   */
  removeParentChildRelationship(parentId: string, childId: string) {
    const db = this.ensureInitialized();

    // Mirror the removal into the connections model (dual-write transition)
    this.deleteConnectionBetween(parentId, childId);

    db.prepare('DELETE FROM video_relationships WHERE parent_id = ? AND child_id = ?').run(parentId, childId);

    // Also clear deprecated parent_id column if this was the only relationship
    const remainingParents = this.getParentVideos(childId);
    if (remainingParents.length === 0) {
      db.prepare('UPDATE videos SET parent_id = NULL WHERE id = ?').run(childId);
    }

    this.saveDatabase();
    this.logger.log(`Removed parent-child relationship: ${parentId} -> ${childId}`);
  }

  // ============================================================================
  // TEXT CONTENT OPERATIONS (for documents)
  // ============================================================================

  /**
   * Insert extracted text content for a document
   */
  insertTextContent(textContent: {
    mediaId: string;
    extractedText: string;
    extractionMethod?: string;
  }) {
    const db = this.ensureInitialized();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT OR REPLACE INTO text_content (
        media_id, extracted_text, extraction_method, extracted_at
      ) VALUES (?, ?, ?, ?)`
    ).run(
      textContent.mediaId,
      textContent.extractedText,
      textContent.extractionMethod || null,
      now,
    );

    this.saveDatabase();
  }

  /**
   * Get extracted text content for a document
   */
  getTextContent(mediaId: string): TextContentRecord | null {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM text_content WHERE media_id = ?');
    const result = stmt.get(mediaId) as TextContentRecord | undefined;
    return result || null;
  }

  /**
   * Delete text content for a document
   */
  deleteTextContent(mediaId: string) {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM text_content WHERE media_id = ?').run(mediaId);
    this.saveDatabase();
    this.logger.log(`Deleted text content for ${mediaId}`);
  }

  /**
   * Search text content (for documents)
   */
  searchTextContent(query: string, limit = 50): TextContentSearchRecord[] {
    const db = this.ensureInitialized();
    const searchTerm = query.toLowerCase().trim();

    const stmt = db.prepare(`
      SELECT tc.media_id, tc.extracted_text, v.filename, v.media_type
      FROM text_content tc
      JOIN videos v ON tc.media_id = v.id
      WHERE lower(tc.extracted_text) LIKE ?
      LIMIT ?
    `);
    const results = stmt.all(`%${searchTerm}%`, limit) as TextContentSearchRecord[];
    return results;
  }

  // ========================================
  // Web Archives CRUD
  // ========================================

  insertWebArchive(archive: {
    videoId: string;
    originalUrl?: string;
    domain?: string;
    faviconPath?: string;
    pageTitle?: string;
    captureDate?: string;
    publishDate?: string;
    captureMethod?: string;
    captureStatus?: string;
    errorMessage?: string;
    textExtracted?: boolean;
  }) {
    const db = this.ensureInitialized();
    db.prepare(
      `INSERT OR REPLACE INTO web_archives (
        video_id, original_url, domain, favicon_path, page_title,
        capture_date, publish_date, capture_method, capture_status,
        error_message, text_extracted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      archive.videoId,
      archive.originalUrl || null,
      archive.domain || null,
      archive.faviconPath || null,
      archive.pageTitle || null,
      archive.captureDate || new Date().toISOString(),
      archive.publishDate || null,
      archive.captureMethod || null,
      archive.captureStatus || 'completed',
      archive.errorMessage || null,
      archive.textExtracted ? 1 : 0,
    );
    this.saveDatabase();
  }

  getWebArchive(videoId: string): WebArchiveRecord | null {
    const db = this.ensureInitialized();
    const result = db.prepare('SELECT * FROM web_archives WHERE video_id = ?').get(videoId) as WebArchiveRecord | undefined;
    return result || null;
  }

  getWebArchiveByUrl(url: string): (WebArchiveRecord & { filename: string; current_path: string }) | null {
    const db = this.ensureInitialized();
    const result = db.prepare(`
      SELECT wa.*, v.filename, v.current_path
      FROM web_archives wa
      JOIN videos v ON wa.video_id = v.id
      WHERE wa.original_url = ?
      LIMIT 1
    `).get(url) as (WebArchiveRecord & { filename: string; current_path: string }) | undefined;
    return result || null;
  }

  getAllWebArchives(domain?: string): (WebArchiveRecord & { filename: string; current_path: string; file_size_bytes: number; upload_date: string | null; download_date: string; suggested_title: string | null })[] {
    const db = this.ensureInitialized();
    let query = `
      SELECT wa.*, v.filename, v.current_path, v.file_size_bytes, v.upload_date, v.download_date, v.suggested_title
      FROM web_archives wa
      JOIN videos v ON wa.video_id = v.id
      WHERE v.is_linked = 1
    `;
    const params: any[] = [];
    if (domain) {
      query += ' AND wa.domain = ?';
      params.push(domain);
    }
    query += ' ORDER BY wa.capture_date DESC';
    const rows = db.prepare(query).all(...params) as any[];

    // Resolve current_path from relative (as stored) to absolute, so the
    // frontend can pass it to electronService.showInFolder / openInBrowser etc.
    const clipsFolder = this.getClipsFolderPath();
    if (clipsFolder) {
      for (const row of rows) {
        if (row.current_path) {
          row.current_path = this.toAbsolutePath(row.current_path, clipsFolder).replace(/\\/g, '/');
        }
      }
    }

    return rows;
  }

  getWebArchiveDomains(): { domain: string; count: number; favicon_path: string | null }[] {
    const db = this.ensureInitialized();
    return db.prepare(`
      SELECT wa.domain, COUNT(*) as count, MAX(wa.favicon_path) as favicon_path
      FROM web_archives wa
      JOIN videos v ON wa.video_id = v.id
      WHERE v.is_linked = 1 AND wa.domain IS NOT NULL
      GROUP BY wa.domain
      ORDER BY wa.domain ASC
    `).all() as any[];
  }

  updateWebArchiveStatus(videoId: string, status: string, errorMessage?: string) {
    const db = this.ensureInitialized();
    db.prepare(`
      UPDATE web_archives SET capture_status = ?, error_message = ? WHERE video_id = ?
    `).run(status, errorMessage || null, videoId);
    this.saveDatabase();
  }

  deleteWebArchive(videoId: string) {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM web_archives WHERE video_id = ?').run(videoId);
    this.saveDatabase();
  }

  /**
   * Get the latest library analytics for a library
   */
  getLatestLibraryAnalytics(libraryId: string): LibraryAnalyticsRecord | null {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT * FROM library_analytics
      WHERE library_id = ?
      ORDER BY generated_at DESC
      LIMIT 1
    `);
    const result = stmt.get(libraryId) as LibraryAnalyticsRecord | undefined;
    return result || null;
  }

  /**
   * Save library analytics
   */
  saveLibraryAnalytics(analytics: {
    libraryId: string;
    videosAnalyzedCount: number;
    aiInsights: string;
    aiModel: string;
    generationTimeSeconds?: number;
  }) {
    const db = this.ensureInitialized();
    const id = `analytics_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    db.prepare(
      `INSERT INTO library_analytics (
        id, library_id, generated_at, videos_analyzed_count,
        ai_insights, ai_model, generation_time_seconds
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      analytics.libraryId,
      new Date().toISOString(),
      analytics.videosAnalyzedCount,
      analytics.aiInsights,
      analytics.aiModel,
      analytics.generationTimeSeconds || null,
    );

    this.saveDatabase();
    return id;
  }

  /**
   * Delete old library analytics (keep only the most recent N)
   */
  cleanupOldAnalytics(libraryId: string, keepCount: number = 5) {
    const db = this.ensureInitialized();

    // Delete all but the most recent N entries
    db.prepare(`
      DELETE FROM library_analytics
      WHERE library_id = ?
      AND id NOT IN (
        SELECT id FROM library_analytics
        WHERE library_id = ?
        ORDER BY generated_at DESC
        LIMIT ?
      )
    `).run(libraryId, libraryId, keepCount);

    this.saveDatabase();
  }

  // ========================
  // VIDEO TABS MANAGEMENT
  // ========================

  /**
   * Get all video tabs
   */
  getAllTabs(): Array<{ id: string; name: string; created_at: string; updated_at: string; display_order: number; video_count: number }> {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT
        vt.*,
        (SELECT COUNT(*) FROM video_tab_items WHERE tab_id = vt.id) as video_count
      FROM video_tabs vt
      ORDER BY vt.display_order ASC, vt.created_at DESC
    `);
    return stmt.all() as any[];
  }

  /**
   * Get a single tab by ID
   */
  getTabById(tabId: string): { id: string; name: string; created_at: string; updated_at: string; display_order: number } | null {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM video_tabs WHERE id = ?');
    return stmt.get(tabId) as any || null;
  }

  /**
   * Create a new video tab
   */
  createTab(name: string): string {
    const db = this.ensureInitialized();
    const id = require('crypto').randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO video_tabs (id, name, created_at, updated_at, display_order)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, name, now, now, 0);

    this.saveDatabase();
    return id;
  }

  /**
   * Update tab name
   */
  updateTab(tabId: string, name: string): void {
    const db = this.ensureInitialized();
    const now = new Date().toISOString();

    db.prepare('UPDATE video_tabs SET name = ?, updated_at = ? WHERE id = ?')
      .run(name, now, tabId);

    this.saveDatabase();
  }

  /**
   * Delete a tab (cascade will remove all tab items)
   */
  deleteTab(tabId: string): void {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM video_tabs WHERE id = ?').run(tabId);
    this.saveDatabase();
  }

  /**
   * Get all videos in a tab
   */
  getTabVideos(tabId: string): VideoRecordWithFlags[] {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT
        v.*,
        CASE WHEN EXISTS (SELECT 1 FROM transcripts WHERE video_id = v.id) THEN 1 ELSE 0 END as has_transcript,
        CASE WHEN EXISTS (SELECT 1 FROM analyses WHERE video_id = v.id) OR v.suggested_title IS NOT NULL THEN 1 ELSE 0 END as has_analysis,
        CASE WHEN EXISTS (SELECT 1 FROM videos WHERE parent_id = v.id) THEN 1 ELSE 0 END as has_children,
        vti.added_at as tab_added_at,
        vti.display_order as tab_display_order
      FROM video_tab_items vti
      JOIN videos v ON vti.video_id = v.id
      WHERE vti.tab_id = ?
      ORDER BY vti.display_order ASC, vti.added_at DESC
    `);
    return this.resolveVideoPathsArray(stmt.all(tabId) as VideoRecordWithFlags[]);
  }

  /**
   * Add a video to a tab
   */
  addVideoToTab(tabId: string, videoId: string): string {
    const db = this.ensureInitialized();
    const id = require('crypto').randomUUID();
    const now = new Date().toISOString();

    try {
      db.prepare(`
        INSERT INTO video_tab_items (id, tab_id, video_id, added_at, display_order, item_type)
        VALUES (?, ?, ?, ?, ?, 'video')
      `).run(id, tabId, videoId, now, 0);

      // Update tab's updated_at timestamp
      db.prepare('UPDATE video_tabs SET updated_at = ? WHERE id = ?')
        .run(now, tabId);

      this.saveDatabase();
      return id;
    } catch (error: any) {
      if (error.message && error.message.includes('UNIQUE constraint failed')) {
        throw new Error('Video is already in this tab');
      }
      throw error;
    }
  }

  /**
   * Add a URL directly to a tab (for external links)
   */
  addUrlToTab(tabId: string, url: string, title?: string): string {
    const db = this.ensureInitialized();
    const id = require('crypto').randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO video_tab_items (id, tab_id, url, added_at, display_order, item_type, title)
      VALUES (?, ?, ?, ?, ?, 'link', ?)
    `).run(id, tabId, url, now, 0, title || null);

    // Update tab's updated_at timestamp
    db.prepare('UPDATE video_tabs SET updated_at = ? WHERE id = ?')
      .run(now, tabId);

    this.saveDatabase();
    return id;
  }

  /**
   * Get all items in a tab (videos, links, etc.)
   */
  getTabItems(tabId: string): any[] {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT
        vti.id,
        vti.tab_id,
        vti.video_id,
        vti.saved_link_id,
        vti.url,
        vti.title as item_title,
        vti.item_type,
        vti.added_at,
        vti.display_order,
        -- Video fields (if item_type = 'video')
        v.filename,
        v.current_path,
        v.duration_seconds,
        v.file_size_bytes,
        v.suggested_title,
        v.ai_description,
        v.source_url as video_source_url,
        v.media_type,
        v.file_extension,
        v.has_transcript,
        v.has_analysis,
        v.upload_date,
        -- Saved link fields (if item_type = 'link')
        sl.url as saved_link_url,
        sl.title as saved_link_title,
        sl.status as saved_link_status,
        sl.thumbnail_path as saved_link_thumbnail
      FROM video_tab_items vti
      LEFT JOIN videos v ON vti.video_id = v.id AND vti.item_type = 'video'
      LEFT JOIN saved_links sl ON vti.saved_link_id = sl.id AND vti.item_type = 'link'
      WHERE vti.tab_id = ?
      ORDER BY vti.display_order ASC, vti.added_at DESC
    `);
    return stmt.all(tabId) as any[];
  }

  /**
   * Remove a video from a tab
   */
  removeVideoFromTab(tabId: string, videoId: string): void {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM video_tab_items WHERE tab_id = ? AND video_id = ?')
      .run(tabId, videoId);

    // Update tab's updated_at timestamp
    const now = new Date().toISOString();
    db.prepare('UPDATE video_tabs SET updated_at = ? WHERE id = ?')
      .run(now, tabId);

    this.saveDatabase();
  }

  /**
   * Get all tabs that contain a specific video
   */
  getTabsForVideo(videoId: string): Array<{ id: string; name: string; created_at: string; updated_at: string }> {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT vt.id, vt.name, vt.created_at, vt.updated_at
      FROM video_tabs vt
      JOIN video_tab_items vti ON vt.id = vti.tab_id
      WHERE vti.video_id = ?
      ORDER BY vt.name ASC
    `);
    return stmt.all(videoId) as any[];
  }

  /**
   * Get all video IDs that are in at least one tab
   */
  getAllTabbedVideoIds(): string[] {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT DISTINCT video_id FROM video_tab_items WHERE video_id IS NOT NULL
    `);
    return (stmt.all() as any[]).map(row => row.video_id);
  }

  // =====================================================
  // CUSTOM INSTRUCTIONS HISTORY
  // =====================================================

  /**
   * Save custom instruction to history (upsert - update if exists, insert if new)
   */
  saveCustomInstruction(instructionText: string): void {
    if (!instructionText || instructionText.trim().length === 0) {
      return;
    }

    const db = this.ensureInitialized();
    const trimmedText = instructionText.trim();
    const now = new Date().toISOString();

    // Check if this instruction already exists
    const existing = db.prepare(
      'SELECT id, use_count FROM custom_instructions_history WHERE instruction_text = ?'
    ).get(trimmedText) as { id: number; use_count: number } | undefined;

    if (existing) {
      // Update existing entry
      db.prepare(
        'UPDATE custom_instructions_history SET used_at = ?, use_count = ? WHERE id = ?'
      ).run(now, existing.use_count + 1, existing.id);
    } else {
      // Insert new entry
      db.prepare(
        'INSERT INTO custom_instructions_history (instruction_text, used_at, use_count) VALUES (?, ?, 1)'
      ).run(trimmedText, now);

      // Keep only the most recent 25 entries
      db.prepare(`
        DELETE FROM custom_instructions_history
        WHERE id NOT IN (
          SELECT id FROM custom_instructions_history
          ORDER BY used_at DESC
          LIMIT 25
        )
      `).run();
    }

    this.saveDatabase();
  }

  /**
   * Get recent custom instructions (last 25, most recent first)
   */
  getCustomInstructionsHistory(): Array<{ id: number; instruction_text: string; used_at: string; use_count: number }> {
    const db = this.ensureInitialized();
    return db.prepare(`
      SELECT id, instruction_text, used_at, use_count
      FROM custom_instructions_history
      ORDER BY used_at DESC
      LIMIT 25
    `).all() as any[];
  }

  /**
   * Clear custom instructions history
   */
  clearCustomInstructionsHistory(): void {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM custom_instructions_history').run();
    this.saveDatabase();
  }

  /**
   * Close database connection
   */
  onModuleDestroy() {
    if (this.db) {
      // better-sqlite3 automatically saves all changes, no need to call saveDatabase()
      this.db.close();
      this.logger.log('Database connection closed');
    }
  }
}
