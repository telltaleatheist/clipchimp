// Briefcase/electron/services/backend-service.ts
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as log from 'electron-log';
import { spawn, ChildProcess } from 'child_process';
import * as lockfile from 'proper-lockfile';
import { AppConfig } from '../config/app-config';
import { ServerConfig } from '../config/server-config';
import { PortUtil } from '../utilities/port-util';

/**
 * Backend server management service
 * Handles starting, stopping, and communicating with the NestJS backend
 */
export class BackendService {
  private backendProcess: ChildProcess | null = null;
  private backendStarted: boolean = false;
  private lockFilePath: string;
  private pidFilePath: string;
  private lockRelease: (() => Promise<void>) | null = null;
  private actualBackendPort: number = 3000;
  // True while WE are stopping the backend (cleanup/shutdown), so the process
  // 'exit' handler can distinguish an expected exit from a mid-session crash.
  private shuttingDown: boolean = false;
  // Registered by main.ts: called exactly when the backend dies unexpectedly.
  private unexpectedExitHandler:
    | ((info: { code: number | null; signal: NodeJS.Signals | null }) => void)
    | null = null;

  /**
   * Register a handler invoked when the backend process exits without us
   * having asked it to (i.e. a mid-session crash). The handler owns user
   * notification and any restart policy.
   */
  setUnexpectedExitHandler(
    handler: (info: { code: number | null; signal: NodeJS.Signals | null }) => void
  ): void {
    this.unexpectedExitHandler = handler;
  }

  constructor() {
    this.lockFilePath = path.join(app.getPath('userData'), 'backend.lock');
    this.pidFilePath = path.join(app.getPath('userData'), 'backend.pid');
  }

  /**
   * Kill a process and its child tree by PID, platform-appropriately.
   * The backend runs as the Electron binary with ELECTRON_RUN_AS_NODE=1, so it
   * has no window title and cannot be matched by image name — we must target
   * the exact PID we spawned.
   */
  private async killProcessTree(pid: number): Promise<void> {
    if (!Number.isInteger(pid) || pid <= 0) {
      return;
    }
    if (process.platform === 'win32') {
      // A6: taskkill tree-kills the PID and all its descendants. POSIX
      // process.kill(-pid) group semantics do not apply on Windows.
      const { exec } = require('child_process');
      const util = require('util');
      const execPromise = util.promisify(exec);
      try {
        await execPromise(`taskkill /pid ${pid} /T /F`);
      } catch (err) {
        // Process may already be gone — that's fine.
      }
    } else {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (err) {
        // Process may already be dead — that's fine.
      }
    }
  }

  /**
   * Kill any stale backend process left over from a previous run.
   * A5: we track the spawned PID in a pidfile rather than guessing by image
   * name / window title (which never matched the real Electron-as-node process).
   */
  private async killStaleBackends(): Promise<void> {
    try {
      if (!fs.existsSync(this.pidFilePath)) {
        return;
      }

      const raw = fs.readFileSync(this.pidFilePath, 'utf-8').trim();
      const pid = parseInt(raw, 10);

      if (Number.isInteger(pid) && pid > 0) {
        log.info(`Found stale backend pidfile (pid ${pid}); killing it`);
        await this.killProcessTree(pid);
      }

      try {
        fs.unlinkSync(this.pidFilePath);
      } catch (err) {
        // Already gone — fine.
      }

      log.info('Cleaned up any stale backend processes');
    } catch (err) {
      log.warn(`Error cleaning up stale backends: ${err}`);
    }
  }

  /**
   * Start the backend server and HTTP server
   */
  async startBackendServer(): Promise<boolean> {

    // If backend already started, return true
    if (this.backendStarted) {
      return true;
    }

    // A fresh start (or restart after a crash) is not a shutdown.
    this.shuttingDown = false;

    // Kill any stale backend processes from previous runs
    await this.killStaleBackends();

    // Try to acquire lock using proper-lockfile
    try {
      // Check if lock file exists and try to break stale locks
      if (fs.existsSync(this.lockFilePath)) {
        try {
          const isLocked = await lockfile.check(this.lockFilePath);
          if (isLocked) {
            log.warn('Lock file is held, attempting to clean up stale processes...');
            // Try to free the port instead of failing
            const backendPortFreed = await PortUtil.attemptToFreePort(ServerConfig.config.nestBackend.port);
            const frontendPortFreed = await PortUtil.attemptToFreePort(ServerConfig.config.electronServer.port);

            if (backendPortFreed && frontendPortFreed) {
              log.info('Successfully freed ports, breaking stale lock');
              // Release the stale lock
              await lockfile.unlock(this.lockFilePath).catch(() => {
                // If unlock fails, remove the lock file manually
                try {
                  fs.unlinkSync(this.lockFilePath);
                } catch (err) {
                  log.warn('Could not remove lock file:', err);
                }
              });
            }
          }
        } catch (err) {
          log.warn('Error checking lock file:', err);
        }
      }
    } catch (err) {
      log.warn('Error during lock acquisition setup:', err);
    }

    // Find available port for backend
    const backendPort = await PortUtil.findAvailablePort(ServerConfig.config.nestBackend.port, 10);

    if (!backendPort) {
      log.error('Could not find available port for backend server');
      return false;
    }

    this.actualBackendPort = backendPort;

    if (backendPort !== ServerConfig.config.nestBackend.port) {
      log.info(`Using alternative backend port: ${backendPort} (default ${ServerConfig.config.nestBackend.port} was in use)`);
    }

    // Acquire lock file atomically
    try {
      // Ensure the lock file exists before locking
      if (!fs.existsSync(this.lockFilePath)) {
        fs.writeFileSync(this.lockFilePath, '');
      }

      this.lockRelease = await lockfile.lock(this.lockFilePath, {
        retries: {
          retries: 3,
          minTimeout: 100,
          maxTimeout: 1000
        },
        stale: 10000, // Consider lock stale after 10 seconds
        update: 2000  // Update lock every 2 seconds
      });
      log.info('Successfully acquired backend lock');
    } catch (err) {
      log.error(`Could not acquire lock file: ${err}`);
      return false;
    }

    try {
      await this.startNodeBackend();

      // Wait for backend ready signal with exponential backoff
      const isRunning = await this.waitForBackendReady();

      if (isRunning) {
        log.info(`✓ Backend successfully started on port ${this.actualBackendPort}`);
        log.info(`✓ Frontend is served directly from backend`);
        this.backendStarted = true;
      } else {
        log.error('Backend failed to start - cleaning up processes');
        await this.cleanup();
      }

      return isRunning;

    } catch (error) {
      log.error('Error starting backend servers:', error);
      await this.cleanup();
      return false;
    }
  }

  /**
   * Wait for backend to be ready using HTTP health checks with exponential backoff
   * This is the standard approach for Electron apps with HTTP backends
   */
  private async waitForBackendReady(): Promise<boolean> {
    const maxAttempts = 40; // Max 40 attempts (~25 seconds total)
    let delay = 100; // Start with 100ms
    const maxDelay = 1000; // Cap at 1 second per attempt

    log.info('Waiting for backend to be ready...');

    // Track whether the HTTP server ever responded, even if the active library
    // wasn't loaded. The library can live on an external volume that mounts
    // late; in that case the backend comes up healthy with no active library
    // and loads it in the background. We must still open the window rather than
    // show the fatal "Backend Server Error" dialog. Only a backend whose HTTP
    // server never responds at all is a genuine startup failure.
    let httpEverResponded = false;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Check immediately on first attempt, then wait
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(delay * 1.5, maxDelay); // Exponential backoff
      }

      // HTTP health check - standard approach
      const { ready, httpUp } = await this.checkBackendRunning();
      if (httpUp) {
        httpEverResponded = true;
      }

      if (ready) {
        log.info(`✓ Backend ready after ${attempt + 1} attempt(s)`);
        return true;
      }

      // Log progress every 5 attempts
      if (attempt > 0 && attempt % 5 === 0) {
        log.info(`Still waiting for backend (attempt ${attempt + 1}/${maxAttempts})...`);
      }
    }

    if (httpEverResponded) {
      log.warn('Backend HTTP is up but the active library is not loaded yet ' +
        '(likely on a volume that is still mounting). Opening the app anyway; ' +
        'the library will load in the background once its volume is available.');
      return true;
    }

    log.error('Backend failed to respond after maximum attempts');
    return false;
  }

  /**
   * Check if backend is running and library is ready
   * Waits for both the HTTP server AND the library database to be initialized
   */
  private async checkBackendRunning(): Promise<{ ready: boolean; httpUp: boolean }> {
    // A7: 0.0.0.0 is a bind address, not a connect address. Map it to localhost
    // for the health check (mirrors getBackendUrl / server-config.backendUrl).
    const configuredHost = ServerConfig.config.nestBackend.host;
    const connectHost = configuredHost === '0.0.0.0' ? 'localhost' : configuredHost;

    return new Promise((resolve) => {
      const req = http.request({
        hostname: connectHost,
        port: this.actualBackendPort,
        path: '/api',
        method: 'GET',
        timeout: 5000
      }, (res) => {
        if (res.statusCode !== 200) {
          resolve({ ready: false, httpUp: false });
          return;
        }

        // Parse response to check library readiness
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const health = JSON.parse(data);
            const httpUp = health.status === 'ok';
            // Fully ready when HTTP responds AND the library is loaded (or none
            // is configured). When a library IS configured but not loaded yet,
            // httpUp is still true so the caller can fall back to opening the
            // window after the wait window instead of failing.
            const ready = httpUp && (health.libraryReady || health.activeLibrary === null);
            resolve({ ready, httpUp });
          } catch {
            // 200 but not our health-check JSON: some OTHER process is
            // answering on this port. Declaring it "ready" here would point
            // the app at a stranger. Not ready, not our backend.
            log.warn(
              `Port ${this.actualBackendPort} responded 200 but the body is not ` +
              `Briefcase's health JSON — another process may be squatting on the port`
            );
            resolve({ ready: false, httpUp: false });
          }
        });
      });

      req.on('error', () => {
        // Expected during startup - silently fail
        resolve({ ready: false, httpUp: false });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ ready: false, httpUp: false });
      });

      req.end();
    });
  }

  /**
   * Get the actual backend port being used
   */
  getBackendPort(): number {
    return this.actualBackendPort;
  }

  /**
   * Get the full backend URL with the actual port
   * Note: Uses localhost if host is 0.0.0.0 since that's for binding, not connecting
   */
  getBackendUrl(): string {
    const host = ServerConfig.config.nestBackend.host;
    const connectHost = host === '0.0.0.0' ? 'localhost' : host;
    return `http://${connectHost}:${this.actualBackendPort}`;
  }
  
  /**
   * Start the Node.js backend (NestJS)
   */
  private async startNodeBackend(): Promise<boolean> {
    try {
      // Get backend path
      const backendPath = AppConfig.backendPath;
      
      // If backend doesn't exist, return false
      if (!fs.existsSync(backendPath)) {
        log.error(`Backend server not found at: ${backendPath}`);
        return false;
      }
      
      const nodePath = process.execPath;
      const frontendPath = AppConfig.frontendPath;

      // Use environment variable if already set (for test mode), otherwise use process.resourcesPath
      const resourcesPath = process.env.RESOURCES_PATH || process.resourcesPath;

      // Get the backend node_modules path - handle both development and production
      const backendDir = path.dirname(path.dirname(backendPath)); // Go up from dist/main.js to backend/
      const backendNodeModules = path.join(backendDir, 'node_modules');

      log.info(`Backend path: ${backendPath}`);
      log.info(`Backend directory: ${backendDir}`);
      log.info(`Backend node_modules: ${backendNodeModules}`);
      log.info(`Node modules exists: ${fs.existsSync(backendNodeModules)}`);

      // Backend will use getRuntimePaths() directly to find bundled binaries
      // We only pass RESOURCES_PATH so the backend can locate the runtime-paths module
      // NO binary paths are passed via env vars to prevent using system binaries

      // In development, we need to pass the project root so the backend can find binaries
      // In packaged mode, RESOURCES_PATH is sufficient
      // __dirname in compiled code is dist-electron/electron/services/, so go up 3 levels
      const projectRoot = app.isPackaged ? resourcesPath : path.resolve(__dirname, '..', '..', '..');
      log.info(`Project root for binaries: ${projectRoot}`);
      log.info(`app.isPackaged: ${app.isPackaged}`);
      log.info(`__dirname: ${__dirname}`);

      const backendEnv = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        BRIEFCASE_BACKEND: 'true',
        FRONTEND_PATH: frontendPath,
        NODE_PATH: backendNodeModules,
        RESOURCES_PATH: resourcesPath,
        BRIEFCASE_PROJECT_ROOT: projectRoot, // Critical for development mode
        PORT: this.actualBackendPort.toString(),
        NODE_ENV: process.env.NODE_ENV || 'production',
        APP_ROOT: resourcesPath,
        VERBOSE: 'true',
        // Remove any user-set binary paths to prevent using system binaries
        FFMPEG_PATH: undefined,
        FFPROBE_PATH: undefined,
        YT_DLP_PATH: undefined,
        WHISPER_CPP_PATH: undefined,
        WHISPER_MODEL_PATH: undefined,
      };
      
      // Set the working directory to the backend directory for proper module resolution
      const workingDir = backendDir;
      log.info(`Starting backend with working directory: ${workingDir}`);

      this.backendProcess = spawn(nodePath, [backendPath], {
        env: backendEnv,
        stdio: 'pipe',
        cwd: workingDir
      });

      // A5: persist the real spawned PID so a future run (or a crash-orphaned
      // process) can be found and killed by exact PID.
      if (this.backendProcess.pid) {
        try {
          fs.writeFileSync(this.pidFilePath, String(this.backendProcess.pid));
        } catch (err) {
          log.warn(`Could not write backend pidfile: ${err}`);
        }
      }

      this.setupProcessEventHandlers();

      return true;
      
    } catch (error) {
      log.error('Error starting Node.js backend:', error);
      return false;
    }
  }

  /**
   * Set up event handlers for the backend process
   */
  private setupProcessEventHandlers(): void {
    if (!this.backendProcess) return;
    
    // Handle stdout - only log important messages, skip verbose progress updates
    if (this.backendProcess.stdout) {
      this.backendProcess.stdout.on('data', (data: Buffer) => {
        const output = data.toString().trim();

        // Skip routine progress logging (only log errors, warnings, or important info)
        // Suppress "Python progress:" messages unless they're important milestones
        if (output.includes('Python progress:')) {
          // Only log major phase changes or important milestones
          if (output.includes('Starting') ||
              output.includes('complete') ||
              output.includes('Failed') ||
              output.includes('Error')) {
            log.info(`[Backend]: ${output}`);
          }
          // Skip routine "Analyzing chunk X/Y" messages
        } else {
          // Log all non-progress messages
          log.info(`[Backend]: ${output}`);
        }
      });
    } else {
      log.warn('Backend stdout stream is not available');
    }
  
    // Handle stderr
    if (this.backendProcess.stderr) {
      this.backendProcess.stderr.on('data', (data: Buffer) => {
        log.error(`[Backend stderr]: ${data.toString().trim()}`);
      });
    } else {
      log.warn('Backend stderr stream is not available');
    }
  
    // Handle process errors
    this.backendProcess.on('error', (err: Error) => {
      log.error(`[Backend process error]: ${err.message}`);
    });

    // Handle process exit — distinguish expected shutdown from a crash.
    this.backendProcess.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.shuttingDown) {
        log.info(`[Backend process exited during shutdown] code: ${code}, signal: ${signal}`);
        return;
      }
      log.error(
        `[Backend process DIED unexpectedly] code: ${code}, signal: ${signal} — ` +
        `invoking unexpected-exit handler`
      );
      this.backendStarted = false;
      if (this.unexpectedExitHandler) {
        this.unexpectedExitHandler({ code, signal });
      } else {
        log.error('No unexpected-exit handler registered — app is running against a dead backend');
      }
    });

    // Handle process close (log only; 'exit' owns crash handling)
    this.backendProcess.on('close', (code: number | null) => {
      log.info(`[Backend process closed] code: ${code}`);
    });
  }
  
  /**
   * Check if the backend is running
   */
  isRunning(): boolean {
    return this.backendStarted;
  }

  /**
   * Clean up backend resources (processes, servers, lock files)
   */
  private async cleanup(): Promise<void> {
    log.info('Cleaning up backend resources...');

    // Mark that any backend exit from here on is intentional.
    this.shuttingDown = true;

    // Release lock file properly using proper-lockfile
    if (this.lockRelease) {
      try {
        await this.lockRelease();
        log.info('Released backend lock during cleanup');
      } catch (err) {
        log.warn('Error releasing lock during cleanup:', err);
        // Fallback: try to delete the lock file manually
        if (fs.existsSync(this.lockFilePath)) {
          try {
            fs.unlinkSync(this.lockFilePath);
          } catch (unlinkErr) {
            log.warn(`Error removing lock file: ${unlinkErr}`);
          }
        }
      }
      this.lockRelease = null;
    } else if (fs.existsSync(this.lockFilePath)) {
      // No release function available, try manual delete
      try {
        fs.unlinkSync(this.lockFilePath);
      } catch (err) {
        log.warn(`Error removing lock file: ${err}`);
      }
    }

    // Kill backend process
    if (this.backendProcess && !this.backendProcess.killed) {
      try {
        // Try graceful shutdown first
        this.backendProcess.kill('SIGTERM');

        // Wait for graceful shutdown (up to 6 seconds).
        //
        // Raised from 2s: the backend now uses SIGTERM to cancel in-flight
        // Ollama generations and unload the models it loaded, which frees
        // 17-25GB of VRAM on quit. That needs more than 2s of headroom, and the
        // process still exits as soon as it is done — this is only a ceiling,
        // not a delay. The SIGKILL fallback still guarantees we exit.
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            if (this.backendProcess && !this.backendProcess.killed) {
              log.warn('Backend process did not exit gracefully, forcing kill...');
              this.backendProcess.kill('SIGKILL');
            }
            resolve();
          }, 6000);

          if (this.backendProcess) {
            this.backendProcess.once('exit', () => {
              clearTimeout(timeout);
              resolve();
            });
          }
        });
      } catch (err) {
        log.warn(`Error killing backend process: ${err}`);
      }
    }

    // Remove the pidfile now that the process is stopped, so the next run
    // doesn't treat a dead PID as stale.
    if (fs.existsSync(this.pidFilePath)) {
      try {
        fs.unlinkSync(this.pidFilePath);
      } catch (err) {
        log.warn(`Error removing backend pidfile: ${err}`);
      }
    }

    this.backendStarted = false;
  }
  
  /**
   * Shutdown the backend server
   */
  async shutdown(): Promise<void> {
    log.info('Shutting down backend service...');

    // Save PID before cleanup clears it
    const pid = this.backendProcess?.pid;

    await this.cleanup();

    // Additional force kill for the specific PID (and its child tree) if
    // cleanup didn't fully terminate it. A6: use a platform-correct tree kill
    // instead of POSIX negative-PID group semantics (which throw on Windows).
    if (pid) {
      await this.killProcessTree(pid);
    }

    this.backendProcess = null;
  }
}