/**
 * Model Manager Service
 * Handles downloading, listing, and deleting local AI models (GGUF files)
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import axios from 'axios';
import { COGITO_MODELS } from './model-catalog';
import { detectGpuVram } from '../bridges/gpu-info';

export interface ModelInfo {
  id: string;
  name: string;
  filename: string;
  url: string;
  sizeGB: number;
  minRAM: number;
  description: string;
  downloaded: boolean;
  isDefault: boolean;
  downloadedAt?: string;
  filePath?: string;
}

export interface GpuInfo {
  name: string;
  vramGB: number;
  driver?: string;
}

export interface SystemInfo {
  totalMemoryGB: number;
  freeMemoryGB: number;
  cpuCores: number;
  platform: string;
  recommendedModel: string;
  gpu: GpuInfo | null;
  useGpu: boolean;
  effectiveMemoryGB: number; // GPU VRAM if available, otherwise system RAM
}

export interface DownloadProgress {
  modelId: string;
  progress: number;
  downloadedGB: number;
  totalGB: number;
  speed?: string;
  eta?: string;
}

// Cogito model catalog lives in ./model-catalog (shared with ComponentManagerService).

@Injectable()
export class ModelManagerService implements OnModuleInit {
  private readonly logger = new Logger(ModelManagerService.name);
  private modelsDir: string;
  private configPath: string;
  private activeDownload: {
    modelId: string;
    controller: AbortController;
  } | null = null;
  private cachedGpuInfo: GpuInfo | null | undefined = undefined; // undefined = not detected yet

  constructor(private readonly eventEmitter: EventEmitter2) {
    // Set up paths based on platform
    const userDataPath =
      process.env.APPDATA ||
      (process.platform === 'darwin'
        ? path.join(process.env.HOME || '', 'Library', 'Application Support')
        : path.join(process.env.HOME || '', '.config'));

    this.modelsDir = path.join(userDataPath, 'briefcase', 'models');
    this.configPath = path.join(userDataPath, 'briefcase', 'app-config.json');
  }

  onModuleInit() {
    // Ensure models directory exists
    if (!fs.existsSync(this.modelsDir)) {
      fs.mkdirSync(this.modelsDir, { recursive: true });
      this.logger.log(`Created models directory: ${this.modelsDir}`);
    }
    this.logger.log(`Models directory: ${this.modelsDir}`);

    // Detect GPU on startup
    this.detectGpu();
  }

  /**
   * Detect GPU and VRAM
   */
  private detectGpu(): GpuInfo | null {
    if (this.cachedGpuInfo !== undefined) {
      return this.cachedGpuInfo;
    }

    const gpu = detectGpuVram();
    this.cachedGpuInfo = gpu;
    if (gpu) {
      this.logger.log(`Detected GPU: ${gpu.name} with ${gpu.vramGB}GB VRAM`);
    } else {
      this.logger.log('No suitable GPU detected, will use CPU for inference');
    }
    return this.cachedGpuInfo;
  }

  /**
   * Get system information and recommended model
   */
  getSystemInfo(): SystemInfo {
    const totalMemoryBytes = os.totalmem();
    const freeMemoryBytes = os.freemem();
    const totalMemoryGB = Math.round((totalMemoryBytes / (1024 ** 3)) * 10) / 10;
    const freeMemoryGB = Math.round((freeMemoryBytes / (1024 ** 3)) * 10) / 10;
    const cpuCores = os.cpus().length;

    // Get GPU info
    const gpu = this.detectGpu();
    const useGpu = gpu !== null && gpu.vramGB >= 4; // Use GPU if at least 4GB VRAM

    // Use GPU VRAM for recommendations if available, otherwise fall back to system RAM
    const effectiveMemoryGB = useGpu && gpu ? gpu.vramGB : totalMemoryGB;

    // Recommend the largest catalog model that fits in effective memory (GPU
    // VRAM or system RAM). COGITO_MODELS is currently empty — Briefcase ships no
    // bundled GGUFs — so this yields '' and callers show no local recommendation.
    const recommendedModel =
      [...COGITO_MODELS]
        .sort((a, b) => b.minRAM - a.minRAM)
        .find((m) => effectiveMemoryGB >= m.minRAM)?.id ?? '';

    return {
      totalMemoryGB,
      freeMemoryGB,
      cpuCores,
      platform: process.platform,
      recommendedModel,
      gpu,
      useGpu,
      effectiveMemoryGB,
    };
  }

  /**
   * Get the models directory path
   */
  getModelsDir(): string {
    return this.modelsDir;
  }

  /**
   * List all available and downloaded models
   */
  async listModels(): Promise<ModelInfo[]> {
    const defaultModel = await this.getDefaultModel();

    return COGITO_MODELS.map((model) => {
      const filePath = path.join(this.modelsDir, model.filename);
      const downloaded = fs.existsSync(filePath);
      let downloadedAt: string | undefined;

      if (downloaded) {
        try {
          const stats = fs.statSync(filePath);
          downloadedAt = stats.mtime.toISOString();
        } catch {
          // Ignore stat errors
        }
      }

      return {
        ...model,
        downloaded,
        isDefault: defaultModel === model.id,
        downloadedAt,
        filePath: downloaded ? filePath : undefined,
      };
    });
  }

  /**
   * Get a specific model by ID
   */
  async getModel(modelId: string): Promise<ModelInfo | null> {
    const models = await this.listModels();
    return models.find((m) => m.id === modelId) || null;
  }

  /**
   * Get the default model ID
   */
  async getDefaultModel(): Promise<string | null> {
    try {
      if (fs.existsSync(this.configPath)) {
        const config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        return config.defaultLocalModel || null;
      }
    } catch {
      // Ignore read errors
    }
    return null;
  }

  /**
   * Set the default model
   */
  async setDefaultModel(modelId: string): Promise<void> {
    const model = COGITO_MODELS.find((m) => m.id === modelId);
    if (!model) {
      throw new Error(`Unknown model: ${modelId}`);
    }

    const filePath = path.join(this.modelsDir, model.filename);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Model not downloaded: ${modelId}`);
    }

    // Read existing config
    let config: any = {};
    if (fs.existsSync(this.configPath)) {
      config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    }

    // Update default model
    config.defaultLocalModel = modelId;
    config.lastUpdated = new Date().toISOString();

    // Save config
    const configDir = path.dirname(this.configPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');

    this.logger.log(`Set default model to: ${modelId}`);
  }

  /**
   * Get the path to the default model file
   * Returns null if no model is downloaded
   */
  async getDefaultModelPath(): Promise<string | null> {
    const defaultModelId = await this.getDefaultModel();

    if (defaultModelId) {
      const model = COGITO_MODELS.find((m) => m.id === defaultModelId);
      if (model) {
        const filePath = path.join(this.modelsDir, model.filename);
        if (fs.existsSync(filePath)) {
          return filePath;
        }
      }
    }

    // Fall back to first available model
    for (const model of COGITO_MODELS) {
      const filePath = path.join(this.modelsDir, model.filename);
      if (fs.existsSync(filePath)) {
        return filePath;
      }
    }

    return null;
  }

  /**
   * Download a model from Hugging Face with retry logic
   */
  async downloadModel(modelId: string, retryCount = 0): Promise<void> {
    const MAX_RETRIES = 3;
    const model = COGITO_MODELS.find((m) => m.id === modelId);
    if (!model) {
      throw new Error(`Unknown model: ${modelId}`);
    }

    // Only the initial (external) call enforces the single-download guard, and it
    // rejects if ANY download is active — including the same id — so a
    // double-click can't open a second concurrent stream to the same file.
    // Retries (retryCount > 0) reuse the same activeDownload slot, kept marked
    // active across the retry sleep below.
    if (retryCount === 0 && this.activeDownload) {
      throw new Error(`Download already in progress: ${this.activeDownload.modelId}`);
    }

    const destPath = path.join(this.modelsDir, model.filename);
    const tempPath = `${destPath}.download`;

    // Check if we can resume from a partial download
    let resumeFromByte = 0;
    if (fs.existsSync(tempPath) && retryCount > 0) {
      const stats = fs.statSync(tempPath);
      resumeFromByte = stats.size;
      this.logger.log(`Resuming download from byte ${resumeFromByte}`);
    }

    // Create abort controller for cancellation
    const controller = new AbortController();
    this.activeDownload = { modelId, controller };

    this.logger.log(`Starting download: ${model.name} from ${model.url}${retryCount > 0 ? ` (retry ${retryCount}/${MAX_RETRIES})` : ''}`);
    this.emitProgress(modelId, 0, 0, model.sizeGB);

    try {
      const headers: Record<string, string> = {
        'User-Agent': 'Briefcase/1.0',
      };

      // Add range header for resume support
      if (resumeFromByte > 0) {
        headers['Range'] = `bytes=${resumeFromByte}-`;
      }

      const response = await axios.get(model.url, {
        responseType: 'stream',
        signal: controller.signal,
        timeout: 30000, // 30 second timeout for initial connection
        maxRedirects: 5,
        headers,
      });

      // If we asked to resume (Range) but the server sent a full 200 body (not
      // 206 Partial Content), appending would corrupt the file — restart from
      // byte 0 and truncate.
      if (resumeFromByte > 0 && response.status !== 206) {
        this.logger.warn(`Server ignored Range (status ${response.status}); restarting download from 0`);
        resumeFromByte = 0;
      }

      // Handle content-length for both full and partial responses
      const contentLength = parseInt(response.headers['content-length'] || '0', 10);
      const totalBytes = resumeFromByte + contentLength;
      const totalGB = totalBytes / (1024 ** 3);
      let downloadedBytes = resumeFromByte;
      let lastProgressTime = Date.now();
      let lastDownloadedBytes = resumeFromByte;

      // Create write stream - append if resuming, otherwise create new
      const writeStream = fs.createWriteStream(tempPath, {
        highWaterMark: 16 * 1024 * 1024, // 16MB buffer
        flags: resumeFromByte > 0 ? 'a' : 'w', // Append if resuming
      });

      // Log download info
      this.logger.log(`Download info: ${contentLength} bytes to download, ${totalBytes} total bytes expected`);

      // Track download progress
      response.data.on('data', (chunk: Buffer) => {
        downloadedBytes += chunk.length;
        const downloadedGB = downloadedBytes / (1024 ** 3);
        const progress = totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0;

        // Calculate speed every second
        const now = Date.now();
        const elapsed = now - lastProgressTime;
        let speed: string | undefined;
        let eta: string | undefined;

        if (elapsed >= 1000) {
          const bytesPerSecond = ((downloadedBytes - lastDownloadedBytes) / elapsed) * 1000;
          const mbPerSecond = bytesPerSecond / (1024 * 1024);
          speed = `${mbPerSecond.toFixed(1)} MB/s`;

          const remainingBytes = totalBytes - downloadedBytes;
          const remainingSeconds = remainingBytes / bytesPerSecond;
          if (remainingSeconds < 60) {
            eta = `${Math.ceil(remainingSeconds)}s`;
          } else if (remainingSeconds < 3600) {
            eta = `${Math.ceil(remainingSeconds / 60)}m`;
          } else {
            eta = `${Math.ceil(remainingSeconds / 3600)}h`;
          }

          lastProgressTime = now;
          lastDownloadedBytes = downloadedBytes;
        }

        this.emitProgress(modelId, progress, downloadedGB, totalGB, speed, eta);
      });

      // Pipe to file with proper error handling
      response.data.pipe(writeStream);

      await new Promise<void>((resolve, reject) => {
        let finished = false;

        const cleanup = () => {
          if (finished) return;
          finished = true;
        };

        writeStream.on('finish', () => {
          cleanup();
          resolve();
        });

        writeStream.on('error', (err) => {
          cleanup();
          this.logger.error(`Write stream error: ${err.message}`);
          reject(err);
        });

        response.data.on('error', (err: Error) => {
          cleanup();
          this.logger.error(`Read stream error: ${err.message}`);
          // Destroy write stream to clean up
          writeStream.destroy();
          reject(err);
        });

        // Handle abort signal
        controller.signal.addEventListener('abort', () => {
          cleanup();
          response.data.destroy();
          writeStream.destroy();
          reject(new Error('aborted'));
        });
      });

      // Reject a truncated/short download instead of accepting it as success.
      if (totalBytes > 0) {
        const finalSize = fs.statSync(tempPath).size;
        if (finalSize !== totalBytes) {
          throw new Error(`Downloaded ${finalSize} bytes but expected ${totalBytes} for ${model.name}`);
        }
      }

      // Rename temp file to final name
      fs.renameSync(tempPath, destPath);

      this.logger.log(`Download complete: ${model.name}`);
      this.eventEmitter.emit('model.download.complete', { modelId });

      // Set as default if it's the first model
      const models = await this.listModels();
      const downloadedModels = models.filter((m) => m.downloaded);
      if (downloadedModels.length === 1) {
        await this.setDefaultModel(modelId);
      }

      // Clear active download on success
      this.activeDownload = null;
    } catch (error: any) {
      // Check if this was a cancellation (user-initiated or abort signal)
      const isCancelled = axios.isCancel(error) ||
                          error.name === 'AbortError' ||
                          error.name === 'CanceledError' ||
                          error.message === 'aborted' ||
                          error.code === 'ERR_CANCELED';

      if (isCancelled) {
        // User cancelled - clean up temp file and don't retry
        if (fs.existsSync(tempPath)) {
          try {
            fs.unlinkSync(tempPath);
          } catch (cleanupErr) {
            this.logger.warn(`Failed to clean up temp file: ${cleanupErr}`);
          }
        }
        this.logger.log(`Download cancelled: ${model.name}`);
        this.eventEmitter.emit('model.download.cancelled', { modelId });
        this.activeDownload = null;
        throw error;
      }

      // Log error details
      this.logger.error(`Download failed for ${model.name}:`, {
        message: error.message,
        code: error.code,
        name: error.name,
        response: error.response?.status,
        retry: retryCount,
      });

      // Check if we should retry (for network errors, not for user cancellation)
      const isRetryable = error.code === 'ECONNRESET' ||
                          error.code === 'ETIMEDOUT' ||
                          error.code === 'ECONNREFUSED' ||
                          error.code === 'ENOTFOUND' ||
                          error.code === 'EAI_AGAIN' ||
                          error.response?.status >= 500 ||
                          error.message?.includes('socket hang up') ||
                          error.message?.includes('network');

      if (isRetryable && retryCount < MAX_RETRIES) {
        this.logger.log(`Retrying download in 5 seconds... (attempt ${retryCount + 1}/${MAX_RETRIES})`);
        // Keep activeDownload marked active across the retry sleep so a concurrent
        // double-click can't start a second stream to the same file. The recursive
        // call re-assigns the slot with a fresh controller.

        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Retry the download (will resume from partial file)
        return this.downloadModel(modelId, retryCount + 1);
      }

      // No more retries - clean up and emit error
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch (cleanupErr) {
          this.logger.warn(`Failed to clean up temp file: ${cleanupErr}`);
        }
      }

      this.eventEmitter.emit('model.download.error', {
        modelId,
        error: error.message || 'Download failed unexpectedly'
      });
      this.activeDownload = null;
      throw error;
    }
  }

  /**
   * Cancel an active download
   */
  cancelDownload(): boolean {
    if (this.activeDownload) {
      this.activeDownload.controller.abort();
      return true;
    }
    return false;
  }

  /**
   * Delete a downloaded model
   */
  async deleteModel(modelId: string): Promise<void> {
    const model = COGITO_MODELS.find((m) => m.id === modelId);
    if (!model) {
      throw new Error(`Unknown model: ${modelId}`);
    }

    const filePath = path.join(this.modelsDir, model.filename);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Model not downloaded: ${modelId}`);
    }

    // Delete the file
    fs.unlinkSync(filePath);
    this.logger.log(`Deleted model: ${model.name}`);

    // If this was the default model, clear it or set another
    const defaultModel = await this.getDefaultModel();
    if (defaultModel === modelId) {
      // Find another downloaded model to set as default
      const models = await this.listModels();
      const anotherModel = models.find((m) => m.downloaded && m.id !== modelId);

      if (anotherModel) {
        await this.setDefaultModel(anotherModel.id);
      } else {
        // Clear default model
        let config: any = {};
        if (fs.existsSync(this.configPath)) {
          config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        }
        delete config.defaultLocalModel;
        fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');
      }
    }
  }

  /**
   * Check if any model is downloaded
   */
  async hasAnyModel(): Promise<boolean> {
    const models = await this.listModels();
    return models.some((m) => m.downloaded);
  }

  /**
   * Emit download progress event
   */
  private emitProgress(
    modelId: string,
    progress: number,
    downloadedGB: number,
    totalGB: number,
    speed?: string,
    eta?: string,
  ): void {
    const event: DownloadProgress = {
      modelId,
      progress: Math.round(progress * 10) / 10,
      downloadedGB: Math.round(downloadedGB * 100) / 100,
      totalGB: Math.round(totalGB * 100) / 100,
      speed,
      eta,
    };
    this.eventEmitter.emit('model.download.progress', event);
  }
}
