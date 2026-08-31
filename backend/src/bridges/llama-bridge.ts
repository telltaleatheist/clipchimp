/**
 * Llama Bridge - Process wrapper for llama-server binary
 * Manages a persistent llama-server process for local AI inference
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '@nestjs/common';

export interface LlamaConfig {
  binaryPath: string;
  modelsDir: string;
  libraryPath?: string; // DYLD_LIBRARY_PATH for macOS
  port?: number;
  modelPath?: string; // Optional: specific model file path (overrides modelsDir scan)
}

export interface LlamaProgress {
  phase: 'starting' | 'loading' | 'ready' | 'generating' | 'stopping' | 'error';
  percent: number;
  message: string;
}

export interface LlamaServerStatus {
  running: boolean;
  ready: boolean;
  port: number;
  modelLoaded: boolean;
  uptime?: number;
}

export interface LlamaGenerateResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** The actual local model that served the request (derived from the loaded file). */
  model: string;
}

export interface LlamaGenerateOptions {
  /** Sampling temperature. JSON tasks want ~0.15; free text a little higher. */
  temperature?: number;
  /**
   * Caller cancellation (a cancelled analysis job). Aborts the request in
   * addition to the built-in REQUEST_TIMEOUT_MS abort, so cancelling a job
   * running on the bundled local model stops it as promptly as it stops Ollama.
   */
  signal?: AbortSignal;
}

export class LlamaBridge extends EventEmitter {
  private config: LlamaConfig;
  private serverProcess: ChildProcess | null = null;
  private isReady = false;
  private startTime: number | null = null;
  private readonly logger = new Logger(LlamaBridge.name);
  private currentModelPath: string | null = null;
  /** GPU layers to offload (-ngl). null → default (full offload, 99). */
  private currentNgl: number | null = null;

  // Configuration
  private readonly DEFAULT_PORT = 8081;
  private readonly STARTUP_TIMEOUT_MS = 120000; // 2 minutes for model loading
  private readonly REQUEST_TIMEOUT_MS = 300000; // 5 minutes for generation

  // Idle timeout management
  private idleTimeout: NodeJS.Timeout | null = null;
  private readonly IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  constructor(config: LlamaConfig) {
    super();
    this.config = {
      ...config,
      port: config.port || this.DEFAULT_PORT,
    };
    this.currentModelPath = config.modelPath || null;
    this.logger.log(`Initialized with binary: ${config.binaryPath}`);
    this.logger.log(`Models directory: ${config.modelsDir}`);
    if (config.modelPath) {
      this.logger.log(`Model path: ${config.modelPath}`);
    }
  }

  /**
   * Set the model path to use
   */
  setModelPath(modelPath: string): void {
    if (this.serverProcess) {
      this.logger.warn('Cannot change model while server is running. Stop the server first.');
      return;
    }
    this.currentModelPath = modelPath;
    this.logger.log(`Model path set to: ${modelPath}`);
  }

  /**
   * Get the path to the model file
   */
  getModelPath(): string | null {
    return this.currentModelPath;
  }

  /**
   * Set the number of GPU layers to offload (-ngl). Takes effect on next start.
   * 99 = full offload (default), 0 = CPU only, partial = N layers on GPU.
   */
  setGpuLayers(ngl: number): void {
    this.currentNgl = ngl;
  }

  /**
   * Check if the model file exists and is valid
   */
  isModelAvailable(): boolean {
    const modelPath = this.currentModelPath;
    if (!modelPath) {
      return false;
    }
    if (!fs.existsSync(modelPath)) {
      return false;
    }
    // Verify it's a GGUF file with reasonable size (> 100MB)
    try {
      const stats = fs.statSync(modelPath);
      return stats.size > 100 * 1024 * 1024;
    } catch {
      return false;
    }
  }

  /**
   * Scan the models directory for available GGUF files
   */
  getAvailableModels(): string[] {
    if (!fs.existsSync(this.config.modelsDir)) {
      return [];
    }
    try {
      return fs.readdirSync(this.config.modelsDir).filter((f) => f.endsWith('.gguf'));
    } catch {
      return [];
    }
  }

  /**
   * Check if the server is running and ready
   */
  isServerReady(): boolean {
    return this.serverProcess !== null && this.isReady;
  }

  /**
   * Get server status
   */
  getStatus(): LlamaServerStatus {
    return {
      running: this.serverProcess !== null,
      ready: this.isReady,
      port: this.config.port!,
      modelLoaded: this.isReady,
      uptime: this.startTime ? Date.now() - this.startTime : undefined,
    };
  }

  /**
   * Start the llama-server
   */
  async startServer(): Promise<void> {
    if (this.serverProcess && this.isReady) {
      this.logger.log('Server already running and ready');
      return;
    }

    // Kill any existing process first
    if (this.serverProcess) {
      this.logger.log('Killing existing server process');
      this.stopServer();
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const modelPath = this.currentModelPath;
    if (!modelPath) {
      throw new Error('No model configured. Please download a model first.');
    }
    if (!fs.existsSync(modelPath)) {
      throw new Error(`Model not found: ${modelPath}`);
    }

    this.emitProgress('starting', 0, 'Starting local AI server...');

    const ngl = this.currentNgl ?? 99; // default: full offload (e.g. Metal)
    const args = [
      '-m',
      modelPath,
      '--port',
      String(this.config.port),
      '-c',
      '8192', // Context size
      '-ngl',
      String(ngl), // GPU layers to offload (VRAM-aware; 99 = all)
      '--threads',
      '4', // CPU threads
      '-fa',
      'on', // Flash attention for better memory usage (newer llama.cpp requires value)
    ];
    this.logger.log(`GPU layer offload (-ngl): ${ngl}`);

    const env = { ...process.env };
    if (this.config.libraryPath) {
      env.DYLD_LIBRARY_PATH = `${this.config.libraryPath}:${env.DYLD_LIBRARY_PATH || ''}`;
    }

    // On Windows, set cwd to the binary directory so DLLs can be found
    const binaryDir = path.dirname(this.config.binaryPath);
    const spawnOptions: any = {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    };

    // Windows needs cwd set to find DLLs in the same directory as the exe
    if (process.platform === 'win32') {
      spawnOptions.cwd = binaryDir;
      this.logger.log(`Setting cwd for Windows DLL loading: ${binaryDir}`);
    }

    this.logger.log(`Starting llama-server: ${this.config.binaryPath}`);
    this.logger.log(`Args: ${args.join(' ')}`);

    const proc = spawn(this.config.binaryPath, args, spawnOptions);
    this.serverProcess = proc;

    this.startTime = Date.now();

    return new Promise((resolve, reject) => {
      let startupBuffer = '';
      let resolved = false;

      const onData = (data: Buffer) => {
        const text = data.toString();
        startupBuffer += text;

        // Log for debugging
        if (text.trim()) {
          this.logger.debug(`[llama-server] ${text.trim().substring(0, 200)}`);
        }

        // Parse loading progress
        if (text.includes('loading model')) {
          this.emitProgress('loading', 20, 'Loading AI model into memory...');
        }

        // Look for "server is listening" or ready indicator. Match against the
        // ACCUMULATED buffer, not just this chunk, so a marker split across two
        // reads still triggers instead of hanging to the startup timeout.
        if (
          startupBuffer.includes('server is listening') ||
          startupBuffer.includes('HTTP server listening') ||
          startupBuffer.includes('llama server listening')
        ) {
          if (!resolved) {
            resolved = true;
            this.isReady = true;
            this.emitProgress('ready', 100, 'Local AI ready');
            this.resetIdleTimer();
            resolve();
          }
        }

        // Check for errors
        if (text.includes('error:') || text.includes('Error:')) {
          this.logger.error(`[llama-server] ${text}`);
        }
      };

      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);

      proc.on('error', (err) => {
        this.logger.error(`Server spawn error: ${err.message}`);
        this.serverProcess = null;
        this.isReady = false;
        if (!resolved) {
          resolved = true;
          this.emitProgress('error', 0, `Failed to start: ${err.message}`);
          reject(err);
        }
      });

      proc.on('close', (code) => {
        this.logger.log(`Server exited with code ${code}`);
        const wasReady = this.isReady;
        this.serverProcess = null;
        this.isReady = false;
        this.startTime = null;

        if (!resolved) {
          resolved = true;
          reject(new Error(`Server exited during startup with code ${code}`));
        } else if (wasReady) {
          this.emitProgress('stopping', 0, 'Server stopped');
        }
      });

      // Startup timeout
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.logger.error('Server startup timeout');
          this.logger.error(`Last output: ${startupBuffer.slice(-500)}`);
          this.stopServer();
          reject(new Error('Server startup timeout - model may be too large for available memory'));
        }
      }, this.STARTUP_TIMEOUT_MS);
    });
  }

  /**
   * Stop the llama-server
   */
  stopServer(): void {
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = null;
    }

    if (this.serverProcess) {
      this.logger.log('Stopping llama-server');
      this.emitProgress('stopping', 0, 'Stopping local AI server...');

      if (process.platform === 'win32') {
        try {
          const { execSync } = require('child_process');
          execSync(`taskkill /pid ${this.serverProcess.pid} /T /F`, { stdio: 'ignore' });
        } catch {
          this.serverProcess.kill('SIGKILL');
        }
      } else {
        // Capture the process locally: this.serverProcess is nulled synchronously
        // below (and may point at a freshly respawned server by the time the timer
        // fires), so the fallback SIGKILL must target THIS process, and the timer
        // must be cancelled once it exits.
        const proc = this.serverProcess;
        proc.kill('SIGTERM');
        const killTimer = setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) {
            proc.kill('SIGKILL');
          }
        }, 5000);
        proc.once('exit', () => clearTimeout(killTimer));
      }

      this.serverProcess = null;
      this.isReady = false;
      this.startTime = null;
    }
  }

  /**
   * Reset idle timer - server shuts down after inactivity
   */
  private resetIdleTimer(): void {
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
    }
    this.idleTimeout = setTimeout(() => {
      this.logger.log('Idle timeout reached - shutting down llama-server to free memory');
      this.stopServer();
    }, this.IDLE_TIMEOUT_MS);
  }

  /**
   * Suspend the idle timer while a request is in flight. The idle timeout equals
   * the request timeout, so without this the idle timer could fire mid-generation
   * and tear the server down underneath an active request. Re-armed on completion.
   */
  private suspendIdleTimer(): void {
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = null;
    }
  }

  /**
   * Generate text using the server's OpenAI-compatible API
   */
  async generateText(prompt: string, options?: LlamaGenerateOptions): Promise<LlamaGenerateResult> {
    // Ensure server is running
    if (!this.isServerReady()) {
      await this.startServer();
    }

    // Suspend the idle shutdown for the duration of the request (re-armed in the
    // finally below) so it can't fire mid-generation.
    this.suspendIdleTimer();
    this.emitProgress('generating', 50, 'Generating response...');

    // Report the model actually loaded, not a hardcoded name. The OpenAI-compat
    // `model` field is informational (llama-server serves whatever -m loaded).
    const modelName = this.currentModelPath
      ? path.basename(this.currentModelPath).replace(/\.gguf$/i, '')
      : 'local-model';
    // Per-task temperature (default low: this path is used for JSON extraction).
    const temperature = options?.temperature ?? 0.2;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT_MS);
    // Caller cancellation shares the timeout's controller; the caller
    // distinguishes the two by checking its own signal (see ai-provider).
    const onCallerAbort = () => controller.abort();
    options?.signal?.addEventListener('abort', onCallerAbort, { once: true });

    try {
      const response = await fetch(`http://localhost:${this.config.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 4096,
          temperature,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Llama server error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      const text = data.choices?.[0]?.message?.content || '';
      const inputTokens = data.usage?.prompt_tokens || 0;
      const outputTokens = data.usage?.completion_tokens || 0;

      this.emitProgress('ready', 100, 'Generation complete');

      return {
        text,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        model: modelName,
      };
    } catch (error: any) {
      clearTimeout(timeout);

      if (error.name === 'AbortError') {
        // Rethrow the raw abort when the CALLER asked for it, so ai-provider can
        // report it as a cancellation instead of a timeout.
        if (options?.signal?.aborted) throw error;
        throw new Error('Request timeout - generation took too long');
      }

      // If fetch failed, server might have crashed
      if (error.code === 'ECONNREFUSED' || error.message?.includes('fetch failed')) {
        this.isReady = false;
        throw new Error('Server connection failed - it may have crashed due to memory pressure');
      }

      throw error;
    } finally {
      clearTimeout(timeout);
      options?.signal?.removeEventListener('abort', onCallerAbort);
      // Re-arm the idle shutdown now that the request has finished.
      this.resetIdleTimer();
    }
  }

  /**
   * Emit a progress event
   */
  private emitProgress(phase: LlamaProgress['phase'], percent: number, message: string): void {
    this.emit('progress', { phase, percent, message } as LlamaProgress);
  }
}
