/**
 * YT-DLP Bridge - Process wrapper for yt-dlp binary
 * Supports video downloading with progress tracking and multiple concurrent downloads
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import * as readline from 'readline';
import { Logger } from '@nestjs/common';

export interface YtDlpProgress {
  processId: string;
  percent: number;
  totalSize: number;
  downloadedBytes: number;
  downloadSpeed: number;
  eta: number;
  phase: 'download' | 'postprocess' | 'complete';
}

export interface YtDlpProcessInfo {
  id: string;
  process: ChildProcess;
  url: string;
  args: string[];
  startTime: number;
  aborted: boolean;
  gracefullyStopped: boolean;
}

export interface YtDlpResult {
  processId: string;
  success: boolean;
  exitCode: number | null;
  duration: number;
  stdout: string;
  error?: string;
}

export interface YtDlpVideoInfo {
  id: string;
  title: string;
  description?: string;
  uploader?: string;
  uploader_id?: string;
  upload_date?: string;
  duration?: number;
  view_count?: number;
  like_count?: number;
  thumbnail?: string;
  webpage_url?: string;
  extractor?: string;
  format?: string;
  formats?: any[];
  [key: string]: any;
}

export interface YtDlpConfig {
  ffmpegPath?: string;  // Path to FFmpeg for post-processing
}

export class YtDlpBridge extends EventEmitter {
  private binaryPath: string;
  private config: YtDlpConfig;
  private activeProcesses = new Map<string, YtDlpProcessInfo>();
  private readonly logger = new Logger(YtDlpBridge.name);

  constructor(ytdlpPath: string, config: YtDlpConfig = {}) {
    super();
    this.binaryPath = ytdlpPath;
    this.config = config;
    this.logger.log(`Initialized with binary: ${ytdlpPath}`);
  }

  /**
   * Get platform-appropriate browser impersonation target
   * Uses Chrome with curl_cffi to bypass Cloudflare bot detection
   */
  private getImpersonateTarget(): string {
    switch (process.platform) {
      case 'win32':
        return 'chrome-116:windows-10';
      case 'darwin':
        return 'chrome-131:macos-14';
      default: // linux
        return 'chrome-131:macos-14'; // No linux targets, macOS works fine
    }
  }

  /**
   * Get the binary path
   */
  get path(): string {
    return this.binaryPath;
  }

  /**
   * Download a video
   */
  download(
    url: string,
    outputTemplate: string,
    options?: {
      format?: string;
      processId?: string;
      mergeOutputFormat?: string;
      extractAudio?: boolean;
      audioFormat?: string;
      audioQuality?: string;
      cookies?: string;
      cookiesFromBrowser?: string;
      noPlaylist?: boolean;
      playlistItems?: string;
      extractorArgs?: string;
      additionalArgs?: string[];
    }
  ): Promise<YtDlpResult> {
    const processId = options?.processId || crypto.randomBytes(8).toString('hex');

    return new Promise((resolve, reject) => {
      const args: string[] = [];

      // Output template
      args.push('-o', outputTemplate);

      // Progress template for parsing - includes fragment info for HLS downloads (Rumble, etc.)
      // Format: bytes/total speed eta eta_value [percent%] frag:current/total
      args.push('--progress-template', '%(progress.downloaded_bytes)s/%(progress.total_bytes)s %(progress.speed)s eta %(progress.eta)s [%(progress._percent_str)s] frag:%(progress.fragment_index)s/%(progress.fragment_count)s');

      // Impersonate Chrome to bypass anti-bot protection (Rumble, etc.)
      // This uses curl_cffi to fully impersonate Chrome's TLS fingerprint
      // Must specify exact target - generic "chrome" doesn't work reliably
      args.push('--impersonate', this.getImpersonateTarget());

      // Format selection
      if (options?.format) {
        args.push('-f', options.format);
      }

      // Merge output format
      if (options?.mergeOutputFormat) {
        args.push('--merge-output-format', options.mergeOutputFormat);
      }

      // Audio extraction
      if (options?.extractAudio) {
        args.push('-x');
        if (options.audioFormat) {
          args.push('--audio-format', options.audioFormat);
        }
        if (options.audioQuality) {
          args.push('--audio-quality', options.audioQuality);
        }
      }

      // Cookies
      if (options?.cookies) {
        args.push('--cookies', options.cookies);
      }
      if (options?.cookiesFromBrowser) {
        args.push('--cookies-from-browser', options.cookiesFromBrowser);
      }

      // Playlist options
      if (options?.noPlaylist) {
        args.push('--no-playlist');
      }
      if (options?.playlistItems) {
        args.push('--playlist-items', options.playlistItems);
      }

      // Extractor args
      if (options?.extractorArgs) {
        args.push('--extractor-args', options.extractorArgs);
      }

      // FFmpeg path for post-processing
      if (this.config.ffmpegPath) {
        args.push('--ffmpeg-location', this.config.ffmpegPath);
      }

      // Force overwrite
      args.push('--force-overwrites');

      // Additional custom args
      if (options?.additionalArgs) {
        args.push(...options.additionalArgs);
      }

      // URL last
      args.push(url);

      this.logger.log(`[${processId}] Starting download: ${url}`);
      this.logger.log(`[${processId}] Args: ${args.join(' ')}`);

      // On POSIX, put yt-dlp in its own process group (detached) so abort() can
      // signal the whole group and reap the ffmpeg merge child yt-dlp spawns
      // during post-processing. We deliberately do NOT unref() — the parent must
      // keep tracking the process. win32 is left unchanged (abort() there uses
      // taskkill /T for tree-kill).
      const proc = spawn(
        this.binaryPath,
        args,
        process.platform === 'win32' ? {} : { detached: true },
      );
      const startTime = Date.now();

      const processInfo: YtDlpProcessInfo = {
        id: processId,
        process: proc,
        url,
        args,
        startTime,
        aborted: false,
        gracefullyStopped: false,
      };

      this.activeProcesses.set(processId, processInfo);

      let stdoutBuffer = '';
      let stderrBuffer = '';
      let stdoutLineBuffer = '';

      // Process stdout for progress. yt-dlp terminates progress records with a
      // bare \r (so they overwrite in place on a TTY) and only uses \n for
      // status lines. Splitting on \n alone therefore never yields a single
      // progress record: the whole download's progress piles up in the partial
      // -line buffer and is dropped, leaving the queue watchdog convinced the
      // task is stuck at 0%. Split on \r and \n both. Carry the partial
      // trailing line across chunks so a record split mid-buffer isn't parsed
      // (and dropped) as two broken halves.
      proc.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdoutBuffer += chunk;

        stdoutLineBuffer += chunk;
        const lines = stdoutLineBuffer.split(/\r\n|[\r\n]/);
        stdoutLineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) {
            this.parseProgress(processId, line);
          }
        }
      });

      // Process stderr line by line for real-time progress
      if (proc.stderr) {
        const stderrReader = readline.createInterface({
          input: proc.stderr,
          terminal: false,
        });

        stderrReader.on('line', (line) => {
          stderrBuffer += line + '\n';
          this.parseProgress(processId, line);
        });
      }

      proc.on('close', (code) => {
        const duration = Date.now() - startTime;
        this.activeProcesses.delete(processId);

        if (processInfo.gracefullyStopped) {
          this.logger.log(`[${processId}] Gracefully stopped after ${duration}ms`);
          resolve({
            processId,
            success: true,
            exitCode: code,
            duration,
            stdout: stdoutBuffer,
          });
          return;
        }

        if (processInfo.aborted) {
          this.logger.log(`[${processId}] Aborted after ${duration}ms`);
          resolve({
            processId,
            success: false,
            exitCode: code,
            duration,
            stdout: stdoutBuffer,
            error: 'Download was cancelled',
          });
          return;
        }

        if (code === 0) {
          this.logger.log(`[${processId}] Completed successfully in ${duration}ms`);

          // Emit final progress
          this.emit('progress', {
            processId,
            percent: 100,
            totalSize: 0,
            downloadedBytes: 0,
            downloadSpeed: 0,
            eta: 0,
            phase: 'complete',
          } as YtDlpProgress);

          resolve({
            processId,
            success: true,
            exitCode: code,
            duration,
            stdout: stdoutBuffer,
          });
        } else {
          this.logger.error(`[${processId}] Failed with code ${code}`);
          this.logger.error(`[${processId}] stderr: ${stderrBuffer.slice(-500)}`);
          resolve({
            processId,
            success: false,
            exitCode: code,
            duration,
            stdout: stdoutBuffer,
            error: `yt-dlp exited with code ${code}: ${stderrBuffer.slice(-500)}`,
          });
        }
      });

      proc.on('error', (err) => {
        const duration = Date.now() - startTime;
        this.activeProcesses.delete(processId);

        this.logger.error(`[${processId}] Spawn error: ${err.message}`);

        if (err.message.includes('bad CPU type') || err.message.includes('ENOEXEC')) {
          reject(new Error(`yt-dlp binary has wrong architecture for this system (${process.arch})`));
        } else if (err.message.includes('ENOENT')) {
          reject(new Error(`yt-dlp binary not found at: ${this.binaryPath}`));
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * Get video information without downloading
   */
  async getVideoInfo(url: string, options?: { processId?: string }): Promise<YtDlpVideoInfo> {
    const processId = options?.processId || crypto.randomBytes(8).toString('hex');

    const args = [
      '--dump-json',
      '--no-playlist',
      '--flat-playlist',
      '--impersonate', this.getImpersonateTarget(),
      url,
    ];

    this.logger.log(`[${processId}] Getting video info: ${url}`);

    return new Promise((resolve, reject) => {
      const proc = spawn(this.binaryPath, args);
      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          try {
            const info = JSON.parse(stdout.trim());
            resolve(info);
          } catch (e) {
            reject(new Error(`Failed to parse video info: ${e}`));
          }
        } else {
          reject(new Error(`yt-dlp exited with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', (err) => {
        if (err.message.includes('ENOENT')) {
          reject(new Error(`yt-dlp binary not found at: ${this.binaryPath}`));
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * Check if a URL is supported
   */
  async checkUrl(url: string): Promise<boolean> {
    const args = [
      '--simulate',
      '--quiet',
      '--impersonate', this.getImpersonateTarget(),
      url,
    ];

    return new Promise((resolve) => {
      // stdio 'ignore' discards stdout/stderr at the OS level: we only care about
      // the exit code, and unread pipes could deadlock the child on a >64KB burst.
      const proc = spawn(this.binaryPath, args, { stdio: 'ignore' });

      proc.on('close', (code) => {
        resolve(code === 0);
      });

      proc.on('error', () => {
        resolve(false);
      });
    });
  }

  /**
   * Get yt-dlp version
   */
  async getVersion(): Promise<string> {
    const args = ['--version'];

    return new Promise((resolve, reject) => {
      const proc = spawn(this.binaryPath, args);
      let stdout = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      // Drain stderr so a warning burst can't fill the pipe and block the child.
      proc.stderr?.on('data', () => {});

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Failed to get version`));
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Update yt-dlp to latest version
   */
  async update(): Promise<boolean> {
    const args = ['--update'];

    return new Promise((resolve) => {
      const proc = spawn(this.binaryPath, args);
      let stdout = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      // Drain stderr so a warning burst can't fill the pipe and block the child.
      proc.stderr?.on('data', () => {});

      proc.on('close', (code) => {
        resolve(code === 0 || stdout.includes('Updated'));
      });

      proc.on('error', () => {
        resolve(false);
      });
    });
  }

  /**
   * Abort a running download
   */
  abort(processId: string): boolean {
    const processInfo = this.activeProcesses.get(processId);
    if (!processInfo) {
      this.logger.warn(`Cannot abort ${processId}: not found`);
      return false;
    }

    this.logger.log(`[${processId}] Aborting download`);
    processInfo.aborted = true;

    if (process.platform === 'win32') {
      try {
        const { execSync } = require('child_process');
        execSync(`taskkill /pid ${processInfo.process.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        processInfo.process.kill('SIGKILL');
      }
    } else {
      const proc = processInfo.process;
      const pid = proc.pid;
      // yt-dlp was spawned detached (its own process group), so signal the whole
      // group via -pid to also kill the ffmpeg merge child spawned during the
      // post-process phase — otherwise it's orphaned and keeps writing a partial
      // file. Fall back to signalling just the yt-dlp pid if the group send fails
      // (e.g. the group is already gone).
      const killGroup = (signal: NodeJS.Signals) => {
        if (typeof pid !== 'number') return;
        try {
          process.kill(-pid, signal);
        } catch {
          try { proc.kill(signal); } catch { /* already exited */ }
        }
      };

      killGroup('SIGTERM');
      // Escalate to SIGKILL if the process hasn't exited shortly after SIGTERM.
      // The 'close' handler removes it from activeProcesses on exit, so a still
      // present entry means it's hung.
      setTimeout(() => {
        if (this.activeProcesses.has(processId)) {
          this.logger.warn(`[${processId}] Still running after SIGTERM; sending SIGKILL`);
          killGroup('SIGKILL');
        }
      }, 5000).unref();
    }

    return true;
  }

  /**
   * Gracefully stop a running download by sending SIGINT
   * This allows yt-dlp to finish muxing and produce a valid file
   */
  gracefulStop(processId: string): boolean {
    const processInfo = this.activeProcesses.get(processId);
    if (!processInfo) {
      this.logger.warn(`Cannot graceful stop ${processId}: not found`);
      return false;
    }

    this.logger.log(`[${processId}] Gracefully stopping download (SIGINT)`);
    processInfo.gracefullyStopped = true;

    if (process.platform === 'win32') {
      // On Windows, send CTRL_C_EVENT via taskkill with /T (tree)
      try {
        const { execSync } = require('child_process');
        execSync(`taskkill /pid ${processInfo.process.pid} /T`, { stdio: 'ignore' });
      } catch {
        processInfo.process.kill('SIGINT');
      }
    } else {
      processInfo.process.kill('SIGINT');
    }

    return true;
  }

  /**
   * Download a livestream with automatic stop at live edge
   * Adds --live-from-start and monitors fragment timing to detect when
   * the download has caught up to the live edge, then gracefully stops.
   */
  downloadLivestream(
    url: string,
    outputTemplate: string,
    options?: {
      format?: string;
      processId?: string;
      mergeOutputFormat?: string;
      cookies?: string;
      cookiesFromBrowser?: string;
      additionalArgs?: string[];
    }
  ): Promise<YtDlpResult> {
    const processId = options?.processId || crypto.randomBytes(8).toString('hex');

    // Track fragment timing for live-edge detection
    // With --concurrent-fragments, events come in bursts so we need higher thresholds
    const fragmentTimestamps: number[] = [];
    const CONSECUTIVE_SLOW_THRESHOLD = 8; // Number of consecutive slow intervals to confirm live edge
    const SLOW_FRAGMENT_MS = 5000; // Fragment taking >5s indicates real-time pace
    const STALL_TIMEOUT_MS = 45000; // If no progress for 45s, graceful stop

    let stallTimer: NodeJS.Timeout | null = null;
    let liveEdgeDetected = false;

    const resetStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (!liveEdgeDetected) {
          this.logger.log(`[${processId}] No progress for ${STALL_TIMEOUT_MS / 1000}s, stopping livestream download`);
          liveEdgeDetected = true;
          this.gracefulStop(processId);
        }
      }, STALL_TIMEOUT_MS);
    };

    // Listen for progress events to track fragment timing
    const progressListener = (progress: YtDlpProgress) => {
      if (progress.processId !== processId || liveEdgeDetected) return;

      const now = Date.now();
      fragmentTimestamps.push(now);
      resetStallTimer();

      // Need at least CONSECUTIVE_SLOW_THRESHOLD + 1 timestamps to compute intervals
      if (fragmentTimestamps.length < CONSECUTIVE_SLOW_THRESHOLD + 1) return;

      // Check last N intervals
      const recentTimestamps = fragmentTimestamps.slice(-(CONSECUTIVE_SLOW_THRESHOLD + 1));
      const intervals: number[] = [];
      for (let i = 1; i < recentTimestamps.length; i++) {
        intervals.push(recentTimestamps[i] - recentTimestamps[i - 1]);
      }

      // If all recent intervals exceed threshold, we've caught up to live edge
      const allSlow = intervals.every(interval => interval > SLOW_FRAGMENT_MS);
      if (allSlow) {
        this.logger.log(
          `[${processId}] Live edge detected: last ${CONSECUTIVE_SLOW_THRESHOLD} fragment intervals ` +
          `all exceed ${SLOW_FRAGMENT_MS}ms (${intervals.map(i => `${i}ms`).join(', ')})`
        );
        liveEdgeDetected = true;
        if (stallTimer) clearTimeout(stallTimer);
        this.gracefulStop(processId);
      }
    };

    this.on('progress', progressListener);
    resetStallTimer();

    // Add --live-from-start to additional args
    const additionalArgs = [...(options?.additionalArgs || []), '--live-from-start'];

    return this.download(url, outputTemplate, {
      ...options,
      processId,
      additionalArgs,
    }).finally(() => {
      this.removeListener('progress', progressListener);
      if (stallTimer) clearTimeout(stallTimer);
    });
  }

  /**
   * Abort all running downloads
   */
  abortAll(): void {
    this.logger.log(`Aborting all ${this.activeProcesses.size} downloads`);
    for (const processId of this.activeProcesses.keys()) {
      this.abort(processId);
    }
  }

  /**
   * Get list of active process IDs
   */
  getActiveProcesses(): string[] {
    return Array.from(this.activeProcesses.keys());
  }

  /**
   * Check if a download is running
   */
  isRunning(processId: string): boolean {
    return this.activeProcesses.has(processId);
  }

  /**
   * Parse progress from yt-dlp output
   */
  private parseProgress(processId: string, line: string): void {
    // Try progress template format: bytes/total speed eta time [percent%] frag:current/total
    // For regular downloads, we have actual bytes and percent
    const templateMatch = line.match(/(\d+)\/(\d+)\s+([\d.]+)\s+eta\s+(\S+)\s+\[\s*([\d.]+)%\s*\]/);
    if (templateMatch) {
      const [, downloaded, total, speed, eta, percent] = templateMatch;

      this.emit('progress', {
        processId,
        percent: parseFloat(percent),
        totalSize: parseInt(total),
        downloadedBytes: parseInt(downloaded),
        downloadSpeed: parseFloat(speed),
        eta: eta !== 'NA' ? parseFloat(eta) : 0,
        phase: 'download',
      } as YtDlpProgress);
      return;
    }

    // Handle HLS progress template format where total_bytes is unknown (None/NA)
    // Format: downloaded_bytes/None speed eta NA [ NA%] frag:current/total
    // For HLS/livestream, we use fragment progress to calculate percent
    // yt-dlp outputs N/A (with slash) for unknown values in _percent_str
    const hlsTemplateMatch = line.match(/(\d+|None|NA)\/(None|NA)\s+([\d.]+|None|NA)\s+eta\s+(\S+)\s+\[\s*([\d.]+|N\/A|NA)%?\s*\]\s*frag:(\d+|None|NA)\/(\d+|None|NA)/i);
    if (hlsTemplateMatch) {
      const [, downloadedStr, , speedStr, , , fragCurrentStr, fragTotalStr] = hlsTemplateMatch;
      const downloadedBytes = downloadedStr !== 'None' && downloadedStr !== 'NA' ? parseInt(downloadedStr) : 0;
      const speed = speedStr !== 'None' && speedStr !== 'NA' ? parseFloat(speedStr) : 0;
      const fragCurrent = fragCurrentStr !== 'None' && fragCurrentStr !== 'NA' ? parseInt(fragCurrentStr) : 0;
      const fragTotal = fragTotalStr !== 'None' && fragTotalStr !== 'NA' ? parseInt(fragTotalStr) : 0;

      // Calculate percent from fragment progress
      const percent = fragTotal > 0 ? (fragCurrent / fragTotal) * 100 : 0;

      this.emit('progress', {
        processId,
        percent,
        totalSize: 0,
        downloadedBytes,
        downloadSpeed: speed,
        eta: 0,
        phase: 'download',
      } as YtDlpProgress);
      return;
    }

    // Fallback for HLS template without fragment info (older format)
    const hlsTemplateMatchSimple = line.match(/(\d+|None|NA)\/(None|NA)\s+([\d.]+|None|NA)\s+eta\s+(\S+)\s+\[\s*([\d.]+|N\/A|NA)%?\s*\]/i);
    if (hlsTemplateMatchSimple && !line.includes('frag:')) {
      const [, downloadedStr, , speedStr] = hlsTemplateMatchSimple;
      const downloadedBytes = downloadedStr !== 'None' && downloadedStr !== 'NA' ? parseInt(downloadedStr) : 0;
      const speed = speedStr !== 'None' && speedStr !== 'NA' ? parseFloat(speedStr) : 0;
      this.emit('progress', {
        processId,
        percent: 0,
        totalSize: 0,
        downloadedBytes,
        downloadSpeed: speed,
        eta: 0,
        phase: 'download',
      } as YtDlpProgress);
      return;
    }

    // Handle HLS fragment download messages: [download] Downloading fragment 123 of 456
    const fragDownloadMatch = line.match(/\[download\]\s+Downloading\s+fragment\s+(\d+)\s+of\s+(\d+)/i);
    if (fragDownloadMatch) {
      const [, current, total] = fragDownloadMatch;
      const totalFrags = parseInt(total);
      const fragPercent = totalFrags > 0 ? (parseInt(current) / totalFrags) * 100 : 0;

      this.emit('progress', {
        processId,
        percent: fragPercent,
        totalSize: 0,
        downloadedBytes: 0,
        downloadSpeed: 0,
        eta: 0,
        phase: 'download',
      } as YtDlpProgress);
      return;
    }

    // Try standard download format: [download] 32.5% of ~50.33MiB at 2.43MiB/s ETA 00:20
    // Also handles HLS format: [download]   0.1% of ~   3.26GiB at    4.04MiB/s ETA Unknown (frag 1/1371)
    const downloadMatch = line.match(/\[download\]\s+(\d+\.?\d*)%\s+of\s+~?\s*(\d+\.?\d*)\s*(\w+)\s+at\s+(\d+\.?\d*)\s*(\w+\/s)\s+ETA\s+(\S+)/);
    if (downloadMatch) {
      const [, percent, size, sizeUnit, speed, speedUnit, eta] = downloadMatch;

      let totalBytes = parseFloat(size);
      if (sizeUnit === 'KiB') totalBytes *= 1024;
      if (sizeUnit === 'MiB') totalBytes *= 1024 * 1024;
      if (sizeUnit === 'GiB') totalBytes *= 1024 * 1024 * 1024;

      let bytesPerSec = parseFloat(speed);
      if (speedUnit.startsWith('KiB')) bytesPerSec *= 1024;
      if (speedUnit.startsWith('MiB')) bytesPerSec *= 1024 * 1024;
      if (speedUnit.startsWith('GiB')) bytesPerSec *= 1024 * 1024 * 1024;

      const downloadedBytes = totalBytes * (parseFloat(percent) / 100);

      // Parse ETA - could be "00:20" or "Unknown"
      let etaSeconds = 0;
      if (eta !== 'Unknown' && eta.includes(':')) {
        const parts = eta.split(':').map(Number);
        if (parts.length === 2) {
          etaSeconds = parts[0] * 60 + parts[1];
        } else if (parts.length === 3) {
          etaSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
        }
      }

      this.emit('progress', {
        processId,
        percent: parseFloat(percent),
        totalSize: totalBytes,
        downloadedBytes,
        downloadSpeed: bytesPerSec,
        eta: etaSeconds,
        phase: 'download',
      } as YtDlpProgress);
      return;
    }

    // Try HLS fragment progress: (frag 123/1371) - extract percent from fragment ratio
    // Also handles concurrent-fragment stderr format: "N: [download] XMiB at Y (time) (frag X/Y)"
    const fragMatch = line.match(/\(frag\s+(\d+)\/(\d+)\)/);
    if (fragMatch) {
      const [, current, total] = fragMatch;
      const totalFrags = parseInt(total);
      const fragPercent = totalFrags > 0 ? (parseInt(current) / totalFrags) * 100 : 0;

      // Try to extract speed from the same line (e.g., "at  569.45KiB/s" or "at    2.00MiB/s")
      let speed = 0;
      const speedInLineMatch = line.match(/at\s+([\d.]+)\s*([KMG]i?B)\/s/i);
      if (speedInLineMatch) {
        speed = parseFloat(speedInLineMatch[1]);
        const unit = speedInLineMatch[2];
        if (unit.startsWith('K')) speed *= 1024;
        else if (unit.startsWith('M')) speed *= 1024 * 1024;
        else if (unit.startsWith('G')) speed *= 1024 * 1024 * 1024;
      }

      this.emit('progress', {
        processId,
        percent: fragPercent,
        totalSize: 0,
        downloadedBytes: 0,
        downloadSpeed: speed,
        eta: 0,
        phase: 'download',
      } as YtDlpProgress);
      return;
    }

    // Post-processing indicators
    if (line.includes('[Merger]') || line.includes('[ExtractAudio]') || line.includes('[ffmpeg]') || line.includes('Deleting original file')) {
      this.emit('progress', {
        processId,
        percent: 95,
        totalSize: 0,
        downloadedBytes: 0,
        downloadSpeed: 0,
        eta: 0,
        phase: 'postprocess',
      } as YtDlpProgress);
      return;
    }

    // Download started
    if (line.includes('[download] Destination:')) {
      this.emit('progress', {
        processId,
        percent: 0,
        totalSize: 0,
        downloadedBytes: 0,
        downloadSpeed: 0,
        eta: 0,
        phase: 'download',
      } as YtDlpProgress);
    }
  }
}
