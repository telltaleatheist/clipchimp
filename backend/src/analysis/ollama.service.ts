import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

export interface OllamaModel {
  name: string;
  size: number;
  digest: string;
  modified_at: string;
}

export interface OllamaModelList {
  models: OllamaModel[];
}

@Injectable()
export class OllamaService {
  private readonly logger = new Logger(OllamaService.name);
  private defaultEndpoint = 'http://localhost:11434';

  // NOTE: model residency is governed entirely by the per-call `keep_alive: '5m'`
  // that every analysis generate request now sends (ai-provider.service). There is
  // deliberately NO in-process keep-alive timer map here anymore: it duplicated
  // Ollama's own idle-unload and, on drift, could unload a model mid-job. The only
  // thing prepareModel still does out-of-band is free VRAM by unloading OTHER
  // models before a job (queried live from Ollama's /api/ps).

  /**
   * Check if Ollama is running and accessible
   * On Windows, localhost may not resolve properly, so we try 127.0.0.1 as fallback
   */
  async checkConnection(endpoint?: string): Promise<boolean> {
    const url = endpoint || this.defaultEndpoint;
    try {
      const response = await axios.get(`${url}/api/tags`, { timeout: 5000 });
      return response.status === 200;
    } catch (error: any) {
      this.logger.warn(`Cannot connect to Ollama at ${url}: ${(error as Error).message || 'Unknown error'}`);

      // On Windows, try 127.0.0.1 if localhost fails
      if (!endpoint && url.includes('localhost')) {
        const fallbackUrl = url.replace('localhost', '127.0.0.1');
        try {
          this.logger.log(`Trying fallback: ${fallbackUrl}`);
          const fallbackResponse = await axios.get(`${fallbackUrl}/api/tags`, { timeout: 5000 });
          if (fallbackResponse.status === 200) {
            // Update default endpoint to use 127.0.0.1
            this.defaultEndpoint = fallbackUrl;
            this.logger.log(`Ollama responding at ${fallbackUrl}, updated default endpoint`);
            return true;
          }
        } catch (fallbackError: any) {
          this.logger.warn(`Fallback also failed: ${(fallbackError as Error).message || 'Unknown error'}`);
        }
      }

      return false;
    }
  }

  /**
   * List all available models
   */
  async listModels(endpoint?: string): Promise<OllamaModel[]> {
    const url = endpoint || this.defaultEndpoint;
    try {
      const response = await axios.get<OllamaModelList>(`${url}/api/tags`, {
        timeout: 5000,
      });
      return response.data.models || [];
    } catch (error: any) {
      this.logger.error(`Failed to list Ollama models: ${(error as Error).message || 'Unknown error'}`);
      throw new Error(`Cannot connect to Ollama at ${url}`);
    }
  }

  /**
   * Check if a specific model is available
   * Uses ContentStudio's approach: actually test the model with a simple request
   */
  async isModelAvailable(
    modelName: string,
    endpoint?: string,
  ): Promise<boolean> {
    const url = endpoint || this.defaultEndpoint;
    const startTime = Date.now();

    try {
      this.logger.log(`[Model Check] Testing availability for: ${modelName}`);
      this.logger.log(`[Model Check] Ollama endpoint: ${url}`);
      this.logger.log(`[Model Check] Timeout: 300 seconds (5 minutes)`);

      // First check if Ollama server is reachable
      try {
        this.logger.log(`[Model Check] Step 1: Checking Ollama server connection...`);
        const tagsResponse = await axios.get(`${url}/api/tags`, { timeout: 5000 });
        this.logger.log(`[Model Check] ✓ Ollama server is reachable (HTTP ${tagsResponse.status})`);

        // List available models for debugging
        const models = tagsResponse.data.models || [];
        const modelNames = models.map((m: any) => m.name);
        this.logger.log(`[Model Check] Available models in Ollama: ${modelNames.join(', ')}`);

        // Check if model name exists in list
        const modelExists = modelNames.includes(modelName) || modelNames.includes(`${modelName}:latest`);
        if (!modelExists) {
          this.logger.error(`[Model Check] ✗ Model "${modelName}" not found in Ollama model list`);
          this.logger.error(`[Model Check] Please run: ollama pull ${modelName}`);
          return false;
        }
        this.logger.log(`[Model Check] ✓ Model "${modelName}" found in Ollama model list`);

      } catch (serverError: any) {
        this.logger.error(`[Model Check] ✗ Cannot connect to Ollama server at ${url}`);
        this.logger.error(`[Model Check] Error: ${serverError.message}`);
        this.logger.error(`[Model Check] Make sure Ollama is running (try: ollama serve)`);
        return false;
      }

      // Test model with simple prompt (ContentStudio's approach)
      this.logger.log(`[Model Check] Step 2: Testing model response with generate request...`);
      const response = await axios.post(
        `${url}/api/generate`,
        {
          model: modelName,
          prompt: 'Ready.',
          stream: false,
          keep_alive: '5m',  // Keep model loaded for 5 minutes after check
          options: { num_predict: 5 }
        },
        { timeout: 300000 } // 300 second (5 minute) timeout to allow large model loading
      );

      const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);

      if (response.status === 200) {
        this.logger.log(`[Model Check] ✓ Model ${modelName} is available and responding (took ${elapsedTime}s)`);
        this.logger.log(`[Model Check] Response: ${JSON.stringify(response.data).substring(0, 100)}...`);
        return true;
      } else {
        this.logger.error(`[Model Check] ✗ Model ${modelName} returned unexpected status ${response.status}`);
        return false;
      }
    } catch (error: any) {
      const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);

      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        this.logger.error(`[Model Check] ✗ Model ${modelName} loading timed out after ${elapsedTime}s`);
        this.logger.error(`[Model Check] This model may be too large or Ollama may be busy`);
        this.logger.error(`[Model Check] Try a smaller model like qwen2.5:7b or llama3.2:3b`);
      } else if (error.code === 'ECONNREFUSED') {
        this.logger.error(`[Model Check] ✗ Connection refused to Ollama at ${url}`);
        this.logger.error(`[Model Check] Make sure Ollama is running`);
      } else if (error.response) {
        this.logger.error(`[Model Check] ✗ Ollama returned error: HTTP ${error.response.status}`);
        this.logger.error(`[Model Check] Response: ${JSON.stringify(error.response.data)}`);
      } else {
        this.logger.error(`[Model Check] ✗ Error checking model ${modelName}: ${(error as Error).message}`);
        this.logger.error(`[Model Check] Error code: ${error.code || 'unknown'}`);
      }

      return false;
    }
  }

  /**
   * Get installation instructions for a model
   */
  getInstallInstructions(modelName: string): string {
    return `
To install the ${modelName} model:

1. Make sure Ollama is installed and running
   - Download from: https://ollama.ai

2. Open a terminal and run:
   ollama pull ${modelName}

3. Wait for the download to complete

4. Return to Briefcase and the model will be available

Current model status: Not installed
    `.trim();
  }

  /**
   * Get recommended models based on system resources
   */
  getRecommendedModels(): Array<{ name: string; size: string; description: string }> {
    return [
      {
        name: 'qwen3.5:4b',
        size: '~3.4 GB',
        description: 'Fast and lightweight - for modest GPUs or CPU-only machines',
      },
      {
        name: 'qwen3.5:9b',
        size: '~6.6 GB',
        description: 'Balanced performance and quality',
      },
      {
        name: 'qwen3.8:27b',
        size: '~18 GB',
        description: 'Recommended default. Best quality that still fits 24GB+ of VRAM or unified memory',
      },
    ];
  }

  /**
   * Preload (warm) a model so the first real request doesn't pay load time.
   * The per-call keep_alive of 5m keeps it resident afterwards — there is NO
   * in-process idle timer (Ollama's own keep_alive is the single source of truth).
   *
   * Pass `numCtx` (the ceiling generation will use, via numCtxMaxForModel) so the
   * warm-up loads the runner at that bounded size. Without it Ollama warms at the
   * model's DEFAULT context (e.g. 128K), allocating a huge KV cache (~50GB for a
   * 32B) that the first real request then has to reload away — the exact spike
   * this warm-up is meant to avoid.
   */
  async preloadModel(modelName: string, endpoint?: string, numCtx?: number): Promise<void> {
    const url = endpoint || this.defaultEndpoint;
    this.logger.log(`[Keep-Alive] Preloading model: ${modelName} at ${url}${numCtx ? ` (num_ctx=${numCtx})` : ''}`);
    await axios.post(
      `${url}/api/generate`,
      {
        model: modelName,
        prompt: 'Ready.',
        stream: false,
        keep_alive: '5m',
        options: { num_predict: 1, ...(numCtx ? { num_ctx: numCtx } : {}) },
      },
      { timeout: 300000 }, // 5 minute timeout for large models
    );
    this.logger.log(`[Keep-Alive] Model ${modelName} preloaded successfully`);
  }

  /**
   * List the models currently resident in Ollama's memory at an endpoint, via
   * the live /api/ps endpoint. This replaces the old in-process tracking map,
   * so it reflects Ollama's REAL state (survives app restarts and external
   * `ollama run` sessions).
   */
  async getLoadedModels(endpoint?: string): Promise<string[]> {
    const url = endpoint || this.defaultEndpoint;
    try {
      const response = await axios.get(`${url}/api/ps`, { timeout: 5000 });
      const models = response.data?.models || [];
      return models.map((m: any) => m.name || m.model).filter(Boolean);
    } catch (error: any) {
      this.logger.warn(`[Keep-Alive] Could not query loaded models via /api/ps: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Unload a model from Ollama's memory immediately (keep_alive: 0). Best-effort.
   */
  async unloadModel(modelName: string, endpoint?: string): Promise<void> {
    const url = endpoint || this.defaultEndpoint;
    this.logger.log(`[Keep-Alive] Unloading model: ${modelName}`);
    try {
      await axios.post(
        `${url}/api/generate`,
        { model: modelName, prompt: '', keep_alive: 0 },
        { timeout: 10000 },
      );
      this.logger.log(`[Keep-Alive] Model ${modelName} unloaded successfully`);
    } catch (error: any) {
      this.logger.warn(`[Keep-Alive] Error unloading model ${modelName}: ${(error as Error).message}`);
      // Don't throw - unloading is best-effort
    }
  }

  /**
   * Prepare to use a model before a job: unload any OTHER models resident at the
   * endpoint (frees VRAM so the target loads fully onto the GPU), then warm the
   * target. Uses Ollama's live /api/ps rather than an in-process map; per-call
   * keep_alive on every subsequent generate keeps the target resident.
   */
  async prepareModel(modelName: string, endpoint?: string, numCtx?: number): Promise<void> {
    const url = endpoint || this.defaultEndpoint;
    const normalized = (name: string) => (name.includes(':') ? name : `${name}:latest`);
    const target = normalized(modelName);

    const loaded = await this.getLoadedModels(url);
    const others = loaded.filter((m) => normalized(m) !== target);
    if (others.length > 0) {
      this.logger.log(`[Keep-Alive] Unloading ${others.length} other model(s) to free VRAM for ${modelName}: ${others.join(', ')}`);
      await Promise.all(others.map((m) => this.unloadModel(m, endpoint)));
    }

    // Warm the target at the bounded num_ctx ceiling (cheap if already loaded —
    // keep_alive just refreshes it).
    await this.preloadModel(modelName, endpoint, numCtx);
  }

  /**
   * Pull/download a model from Ollama registry
   * Returns a stream of progress updates
   */
  async pullModel(
    modelName: string,
    endpoint?: string,
    onProgress?: (data: { status: string; completed?: number; total?: number; digest?: string }) => void
  ): Promise<void> {
    const url = endpoint || this.defaultEndpoint;
    this.logger.log(`[Ollama Pull] Starting download of model: ${modelName}`);

    try {
      const response = await axios.post(
        `${url}/api/pull`,
        { name: modelName },
        {
          responseType: 'stream',
          timeout: 3600000 // 1 hour timeout for large models
        }
      );

      return new Promise((resolve, reject) => {
        let buffer = '';

        response.data.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (!line.trim()) continue;

            try {
              const data = JSON.parse(line);
              this.logger.log(`[Ollama Pull] ${data.status} ${data.completed && data.total ? `(${Math.round(data.completed / data.total * 100)}%)` : ''}`);

              if (onProgress) {
                onProgress(data);
              }

              // Check for completion or error
              if (data.status === 'success') {
                resolve();
              } else if (data.error) {
                reject(new Error(data.error));
              }
            } catch (parseError) {
              this.logger.warn(`[Ollama Pull] Failed to parse progress: ${line}`);
            }
          }
        });

        response.data.on('end', () => {
          this.logger.log(`[Ollama Pull] Model ${modelName} downloaded successfully`);
          resolve();
        });

        response.data.on('error', (error: Error) => {
          this.logger.error(`[Ollama Pull] Download failed: ${error.message}`);
          reject(error);
        });
      });
    } catch (error: any) {
      this.logger.error(`[Ollama Pull] Failed to pull model ${modelName}: ${(error as Error).message}`);
      throw new Error(`Failed to download model: ${(error as Error).message}`);
    }
  }

}
