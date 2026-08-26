/**
 * Component Manager Service
 *
 * Download-on-demand for binaries (ffmpeg, whisper, yt-dlp, llama) and whisper
 * models. Modeled on ModelManagerService — same resumable/retrying/abortable
 * axios-stream download core — but driven by the published manifest.json catalog
 * and storing into <configDir>/components/<id>/ (binaries) and
 * <configDir>/models/whisper/ (whisper models).
 *
 * Progress is emitted via EventEmitter2 ('component.download.*') and relayed to
 * the frontend by AppGateway → WebsocketService.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import axios from 'axios';
import {
  Manifest,
  ManifestComponent,
  ComponentArtifact,
  ComponentStatus,
  InstalledManifest,
  InstalledRecord,
} from './component.types';
import { whisperModelComponents, llamaModelComponents, nliEnvComponents } from '../config/model-catalog';
import {
  NLI_COMPONENT_ID,
  NLI_STAGES,
  checkNliEnv,
  provisionNliEnv,
  removeNliEnv,
  resolveNliDir,
} from '../common/nli-env';

const MANIFEST_URL =
  'https://github.com/telltaleatheist/briefcase/releases/download/binaries-v1/manifest.json';

@Injectable()
export class ComponentManagerService implements OnModuleInit {
  private readonly logger = new Logger(ComponentManagerService.name);

  private readonly configDir: string;
  private readonly componentsDir: string;
  private readonly whisperModelsDir: string;
  private readonly llamaModelsDir: string;
  private readonly installedPath: string;
  private readonly manifestCachePath: string;
  private readonly tmpDir: string;

  private activeDownload: { componentId: string; controller: AbortController } | null = null;

  constructor(private readonly eventEmitter: EventEmitter2) {
    const userDataPath =
      process.env.APPDATA ||
      (process.platform === 'darwin'
        ? path.join(process.env.HOME || os.homedir(), 'Library', 'Application Support')
        : path.join(process.env.HOME || os.homedir(), '.config'));

    this.configDir = path.join(userDataPath, 'briefcase');
    this.componentsDir = path.join(this.configDir, 'components');
    this.whisperModelsDir = path.join(this.configDir, 'models', 'whisper');
    // Local AI (GGUF) models live flat in <configDir>/models — the same dir
    // ModelManagerService and LlamaManager read from, so all three agree.
    this.llamaModelsDir = path.join(this.configDir, 'models');
    this.installedPath = path.join(this.componentsDir, 'installed.json');
    this.manifestCachePath = path.join(this.componentsDir, 'manifest-cache.json');
    this.tmpDir = path.join(this.componentsDir, '.tmp');
  }

  onModuleInit() {
    for (const dir of [this.componentsDir, this.whisperModelsDir, this.llamaModelsDir, this.tmpDir]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    this.logger.log(`Components directory: ${this.componentsDir}`);
  }

  getComponentsDir(): string {
    return this.componentsDir;
  }

  getWhisperModelsDir(): string {
    return this.whisperModelsDir;
  }

  /**
   * Full component catalog: binaries from the published manifest, plus the
   * self-contained whisper + local-AI model catalogs (downloaded directly from
   * Hugging Face). Models are intentionally NOT sourced from the manifest so new
   * sizes can be added without republishing a release asset.
   */
  private async getAllComponents(): Promise<ManifestComponent[]> {
    const manifest = await this.getManifest();
    const binaries = manifest.components.filter((c) => c.kind === 'binary');
    return [...binaries, ...whisperModelComponents(), ...llamaModelComponents(), ...nliEnvComponents()];
  }

  // ---------- manifest ----------

  /** Live-fetch the manifest, fall back to cache, then to a bundled copy. */
  async getManifest(): Promise<Manifest> {
    // 1. Live fetch
    try {
      const res = await axios.get(MANIFEST_URL, {
        timeout: 8000,
        headers: { 'User-Agent': 'Briefcase/1.0' },
        responseType: 'json',
      });
      const manifest = this.normalize(res.data);
      try {
        fs.writeFileSync(this.manifestCachePath, JSON.stringify(res.data, null, 2), 'utf8');
      } catch {
        // cache write is best-effort
      }
      return manifest;
    } catch (err: any) {
      this.logger.warn(`Live manifest fetch failed (${err.message}); using cache/bundled`);
    }

    // 2. Cache
    if (fs.existsSync(this.manifestCachePath)) {
      try {
        return this.normalize(JSON.parse(fs.readFileSync(this.manifestCachePath, 'utf8')));
      } catch {
        // fall through
      }
    }

    // 3. Bundled fallback
    for (const p of this.bundledManifestCandidates()) {
      if (fs.existsSync(p)) {
        try {
          return this.normalize(JSON.parse(fs.readFileSync(p, 'utf8')));
        } catch {
          // try next
        }
      }
    }

    throw new Error('No component manifest available (live fetch, cache, and bundled copy all failed)');
  }

  private bundledManifestCandidates(): string[] {
    const out: string[] = [];
    if (process.env.RESOURCES_PATH) out.push(path.join(process.env.RESOURCES_PATH, 'assets', 'manifest.json'));
    if (process.env.BRIEFCASE_PROJECT_ROOT) out.push(path.join(process.env.BRIEFCASE_PROJECT_ROOT, 'assets', 'manifest.json'));
    return out;
  }

  /** Merge manifest.models into manifest.components and tag kinds. */
  private normalize(raw: any): Manifest {
    const components: ManifestComponent[] = Array.isArray(raw?.components) ? raw.components : [];
    const models: ManifestComponent[] = Array.isArray(raw?.models)
      ? raw.models.map((m: ManifestComponent) => ({ ...m, kind: 'whisper-model' as const }))
      : [];
    return {
      schemaVersion: raw?.schemaVersion ?? 1,
      releaseTag: raw?.releaseTag,
      repo: raw?.repo,
      baseUrl: raw?.baseUrl,
      note: raw?.note,
      components: [...components, ...models],
    };
  }

  private pickArtifact(component: ManifestComponent): ComponentArtifact | null {
    const platform = process.platform;
    const arch = process.arch;
    return (
      component.artifacts.find(
        (a) => a.platform === platform && (a.arch === arch || a.arch === 'universal'),
      ) || null
    );
  }

  // ---------- installed state ----------

  private loadInstalled(): InstalledManifest {
    if (!fs.existsSync(this.installedPath)) {
      // Genuinely absent (fresh install) — empty manifest is the truth.
      return { components: {} };
    }
    const raw = fs.readFileSync(this.installedPath, 'utf8');
    try {
      return JSON.parse(raw);
    } catch (error) {
      // Corrupt manifest. Returning {} here would report every installed
      // component (gigabytes of models) as uninstalled and let the next
      // recordInstalled() overwrite the recoverable file. Preserve it and
      // fail loudly (same pattern as api-keys.service).
      const corruptPath = `${this.installedPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try {
        fs.renameSync(this.installedPath, corruptPath);
        this.logger.error(`installed.json is corrupt; backed it up to ${corruptPath}`);
      } catch (backupError) {
        this.logger.error(`installed.json is corrupt and could not be backed up: ${(backupError as Error).message}`);
      }
      throw new Error(
        `Component manifest at ${this.installedPath} is corrupt (${(error as Error).message}). ` +
        `It was backed up alongside the original; restore or delete it, then restart.`,
      );
    }
  }

  private saveInstalled(manifest: InstalledManifest): void {
    fs.writeFileSync(this.installedPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  private recordInstalled(record: InstalledRecord): void {
    const installed = this.loadInstalled();
    installed.components[record.id] = record;
    this.saveInstalled(installed);
  }

  isInstalled(id: string): boolean {
    // The Python environment is not a file we downloaded, so "the entry exists"
    // is not a strong enough claim for it: worker.py can be sitting next to a
    // venv with no torch in it. Its own check is the authority, and it is the
    // SAME function the ranker uses to decide whether to run — see nli-env.ts.
    if (id === NLI_COMPONENT_ID) {
      return checkNliEnv(resolveNliDir((m) => this.logger.warn(`[NLI] ${m}`))).installed;
    }
    const installed = this.loadInstalled();
    const rec = installed.components[id];
    if (!rec) return false;
    const entryPath = path.join(rec.dir, rec.entry);
    return fs.existsSync(entryPath);
  }

  // ---------- public API ----------

  async listComponents(): Promise<ComponentStatus[]> {
    const components = await this.getAllComponents();
    return components.map((c) => {
      const art = this.pickArtifact(c);
      return {
        id: c.id,
        name: c.name,
        kind: c.kind,
        required: c.required,
        description: c.description,
        supported: art !== null,
        installed: this.isInstalled(c.id),
        sizeBytes: art?.bytes ?? 0,
        // A hand-built NLI environment has no install record, so fall back to
        // the date its own verification marker records.
        installedAt:
          this.loadInstalled().components[c.id]?.installedAt ??
          (c.id === NLI_COMPONENT_ID
            ? (checkNliEnv(resolveNliDir()).recorded?.verifiedAt as string | undefined)
            : undefined),
      };
    });
  }

  /**
   * Install a component. `force` is the repair path: it is only meaningful for
   * locally-constructed components (python-env), where "already installed" is a
   * judgement about a directory rather than a file we can re-download.
   */
  async install(id: string, force = false): Promise<void> {
    const components = await this.getAllComponents();
    const component = components.find((c) => c.id === id);
    if (!component) throw new Error(`Unknown component: ${id}`);

    const artifact = this.pickArtifact(component);
    if (!artifact) throw new Error(`Component ${id} is not available for ${process.platform}/${process.arch}`);

    // Reject if ANY download is active, including the same id — a double-click
    // would otherwise open a second concurrent stream to the same file and
    // corrupt it. A python-env build is held to the same rule: two pips writing
    // one venv is the same corruption with a different filename.
    if (this.activeDownload) {
      throw new Error(`Download already in progress: ${this.activeDownload.componentId}`);
    }

    const controller = new AbortController();
    this.activeDownload = { componentId: id, controller };
    // A python-env has no bytes arriving over a socket, so it opens on the
    // 'install' phase at stage 0 rather than claiming a download of 1.2GB.
    if (component.kind === 'python-env') {
      this.emitProgress(id, 'install', 0, NLI_STAGES.length);
    } else {
      this.emitProgress(id, 'download', 0, artifact.bytes);
    }

    try {
      if (component.kind === 'python-env') {
        await this.installPythonEnv(id, artifact, controller.signal, force);
      } else if (component.kind === 'whisper-model') {
        await this.installModel(id, artifact, controller.signal);
      } else if (component.kind === 'llama-model') {
        await this.installLlamaModel(id, artifact, controller.signal);
      } else {
        await this.installBinary(id, artifact, controller.signal);
      }

      this.logger.log(`Component installed: ${id}`);
      this.eventEmitter.emit('component.download.complete', { componentId: id });
      this.activeDownload = null;
    } catch (error: any) {
      const isCancelled =
        axios.isCancel(error) ||
        error.name === 'AbortError' ||
        error.name === 'CanceledError' ||
        error.message === 'aborted' ||
        error.code === 'ERR_CANCELED';

      if (isCancelled) {
        this.logger.log(`Component download cancelled: ${id}`);
        this.eventEmitter.emit('component.download.cancelled', { componentId: id });
      } else {
        this.logger.error(`Component install failed for ${id}: ${error.message}`);
        this.eventEmitter.emit('component.download.error', {
          componentId: id,
          error: error.message || 'Install failed unexpectedly',
        });
      }
      this.activeDownload = null;
      throw error;
    }
  }

  cancel(): boolean {
    if (this.activeDownload) {
      this.activeDownload.controller.abort();
      return true;
    }
    return false;
  }

  async remove(id: string): Promise<void> {
    const installed = this.loadInstalled();

    // The Python environment can exist without an install record (built by hand,
    // or by a build that crashed before recording), so removal is driven by the
    // resolved directory rather than the record — otherwise "Remove" would look
    // like it worked and leave 1.2GB behind.
    if (id === NLI_COMPONENT_ID) {
      const dir = resolveNliDir((m) => this.logger.warn(`[NLI] ${m}`));
      const deleted = removeNliEnv(dir);
      this.logger.log(deleted ? `Removed NLI environment at ${dir}` : `No NLI environment at ${dir} to remove`);
      if (installed.components[id]) {
        delete installed.components[id];
        this.saveInstalled(installed);
      }
      return;
    }

    const rec = installed.components[id];
    if (!rec) return;

    if (rec.kind === 'binary') {
      if (fs.existsSync(rec.dir)) fs.rmSync(rec.dir, { recursive: true, force: true });
    } else {
      // Model kinds (whisper-model, llama-model) are single files in a shared dir.
      const file = path.join(rec.dir, rec.entry);
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    }
    delete installed.components[id];
    this.saveInstalled(installed);
    this.logger.log(`Removed component: ${id}`);
  }

  // ---------- install helpers ----------

  private async installBinary(id: string, artifact: ComponentArtifact, signal: AbortSignal): Promise<void> {
    if (!fs.existsSync(this.tmpDir)) fs.mkdirSync(this.tmpDir, { recursive: true });
    const archivePath = path.join(this.tmpDir, artifact.file || `${id}.archive`);

    await this.downloadToFile(artifact.url, archivePath, id, signal);

    this.emitProgress(id, 'verify', artifact.bytes, artifact.bytes);
    await this.verifySha256(archivePath, artifact.sha256);

    this.emitProgress(id, 'extract', artifact.bytes, artifact.bytes);
    const extractDir = path.join(this.tmpDir, `${id}-extract`);
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    // bsdtar (macOS/Windows) and gnu tar (Linux) both auto-detect gzip; bsdtar also reads .zip.
    // Our (platform, archive) pairs are always tar.gz on darwin/linux and .zip on win32.
    // execFileSync (argv array) — never a shell string — so a hostile manifest
    // filename can't inject shell commands.
    execFileSync('tar', ['-xf', archivePath, '-C', extractDir], { stdio: 'pipe' });

    this.emitProgress(id, 'install', artifact.bytes, artifact.bytes);
    const finalDir = path.join(this.componentsDir, id);
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(extractDir, finalDir);

    if (process.platform !== 'win32') {
      this.chmodRecursive(finalDir);
      if (process.platform === 'darwin') {
        try {
          execFileSync('xattr', ['-cr', finalDir], { stdio: 'pipe' });
        } catch {
          // best-effort quarantine clear
        }
      }
    }

    fs.rmSync(archivePath, { force: true });
    this.recordInstalled({
      id,
      kind: 'binary',
      dir: finalDir,
      entry: artifact.entry,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      installedAt: new Date().toISOString(),
    });
  }

  /**
   * Build the NLI flag-ranking Python environment.
   *
   * PROGRESS IS BY STAGE, NOT BY BYTE, ON PURPOSE. pip and the Hugging Face hub
   * client do not report a total this process can see, and a bar synthesised
   * from nothing is worse than no bar: it would sit at a fake 40% through a
   * ten-minute torch download. So the five stages in NLI_STAGES are the unit,
   * `done` is the number completed, and a heartbeat re-emits the current stage
   * every 15s while a child process is working — silence is what the download
   * dock's watchdog treats as a hang, and this work is legitimately silent for
   * minutes at a time.
   *
   * The install record is written for consistency with the other kinds, but it
   * is NOT what isInstalled() reads for this component: see isInstalled.
   */
  private async installPythonEnv(
    id: string,
    artifact: ComponentArtifact,
    signal: AbortSignal,
    force: boolean,
  ): Promise<void> {
    const dir = resolveNliDir((m) => this.logger.warn(`[NLI] ${m}`));
    const total = NLI_STAGES.length;

    await provisionNliEnv({
      dir,
      signal,
      force,
      onStage: (done, stages, label) => {
        this.logger.log(`[${id}] stage ${done}/${stages}: ${label}`);
        this.emitProgress(id, 'install', done, stages);
      },
      onHeartbeat: (done, stages) => this.emitProgress(id, 'install', done, stages),
      log: (message) => this.logger.log(`[${id}] ${message}`),
    });

    this.recordInstalled({
      id,
      kind: 'python-env',
      dir,
      entry: 'worker.py',
      sha256: '',
      bytes: artifact.bytes,
      installedAt: new Date().toISOString(),
    });
    this.logger.log(`[${id}] NLI flag-ranking environment ready at ${dir} (${total} stages complete)`);
  }

  private async installModel(id: string, artifact: ComponentArtifact, signal: AbortSignal): Promise<void> {
    if (!fs.existsSync(this.whisperModelsDir)) fs.mkdirSync(this.whisperModelsDir, { recursive: true });
    const fileName = artifact.entry || artifact.file || `${id}.bin`;
    const destPath = path.join(this.whisperModelsDir, fileName);
    const tempPath = `${destPath}.download`;

    await this.downloadToFile(artifact.url, tempPath, id, signal);

    if (artifact.sha256) {
      this.emitProgress(id, 'verify', artifact.bytes, artifact.bytes);
      await this.verifySha256(tempPath, artifact.sha256);
    }

    fs.renameSync(tempPath, destPath);
    this.recordInstalled({
      id,
      kind: 'whisper-model',
      dir: this.whisperModelsDir,
      entry: fileName,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      installedAt: new Date().toISOString(),
    });
  }

  /**
   * Download a local AI (GGUF) model into <configDir>/models — the same flat dir
   * ModelManagerService and LlamaManager read from. After a successful install we
   * adopt it as the default local model if none is set yet, so it's usable
   * without an app restart.
   */
  private async installLlamaModel(id: string, artifact: ComponentArtifact, signal: AbortSignal): Promise<void> {
    if (!fs.existsSync(this.llamaModelsDir)) fs.mkdirSync(this.llamaModelsDir, { recursive: true });
    const fileName = artifact.entry || artifact.file || `${id}.gguf`;
    const destPath = path.join(this.llamaModelsDir, fileName);
    const tempPath = `${destPath}.download`;

    await this.downloadToFile(artifact.url, tempPath, id, signal);

    if (artifact.sha256) {
      this.emitProgress(id, 'verify', artifact.bytes, artifact.bytes);
      await this.verifySha256(tempPath, artifact.sha256);
    }

    fs.renameSync(tempPath, destPath);
    this.recordInstalled({
      id,
      kind: 'llama-model',
      dir: this.llamaModelsDir,
      entry: fileName,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      installedAt: new Date().toISOString(),
    });
    this.setDefaultLocalModelIfUnset(id);
  }

  /** Write defaultLocalModel to app-config.json when one isn't already chosen. */
  private setDefaultLocalModelIfUnset(modelId: string): void {
    try {
      const configPath = path.join(this.configDir, 'app-config.json');
      let config: any = {};
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      }
      if (!config.defaultLocalModel) {
        config.defaultLocalModel = modelId;
        config.lastUpdated = new Date().toISOString();
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        this.logger.log(`Set default local model to ${modelId}`);
      }
    } catch (err: any) {
      this.logger.warn(`Could not set default local model: ${err.message}`);
    }
  }

  private chmodRecursive(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.chmodRecursive(full);
      } else {
        try {
          fs.chmodSync(full, 0o755);
        } catch {
          // ignore
        }
      }
    }
  }

  private async verifySha256(filePath: string, expected: string): Promise<void> {
    if (!expected) return;
    const actual = await new Promise<string>((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (d) => hash.update(d));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      fs.rmSync(filePath, { force: true });
      throw new Error(`Checksum mismatch (expected ${expected}, got ${actual})`);
    }
  }

  /**
   * Resumable, retrying, abortable streamed download. Adapted from
   * ModelManagerService.downloadModel — emits 'component.download.progress'
   * (phase 'download') as bytes arrive.
   */
  private async downloadToFile(
    url: string,
    destPath: string,
    componentId: string,
    signal: AbortSignal,
    retryCount = 0,
  ): Promise<void> {
    const MAX_RETRIES = 3;

    let resumeFromByte = 0;
    if (fs.existsSync(destPath) && retryCount > 0) {
      resumeFromByte = fs.statSync(destPath).size;
      this.logger.log(`Resuming ${componentId} from byte ${resumeFromByte}`);
    }

    try {
      const headers: Record<string, string> = { 'User-Agent': 'Briefcase/1.0' };
      if (resumeFromByte > 0) headers['Range'] = `bytes=${resumeFromByte}-`;

      const response = await axios.get(url, {
        responseType: 'stream',
        signal,
        timeout: 30000,
        maxRedirects: 5,
        headers,
      });

      // If we asked to resume (Range) but the server replied 200 (full body,
      // not 206 Partial Content), appending would corrupt the file. Restart from
      // byte 0 and truncate.
      if (resumeFromByte > 0 && response.status !== 206) {
        this.logger.warn(`${componentId}: server ignored Range (status ${response.status}); restarting from 0`);
        resumeFromByte = 0;
      }

      const contentLength = parseInt(response.headers['content-length'] || '0', 10);
      const totalBytes = resumeFromByte + contentLength;
      let downloadedBytes = resumeFromByte;
      let lastTime = Date.now();
      let lastBytes = resumeFromByte;

      const writeStream = fs.createWriteStream(destPath, {
        highWaterMark: 16 * 1024 * 1024,
        flags: resumeFromByte > 0 ? 'a' : 'w',
      });

      response.data.on('data', (chunk: Buffer) => {
        downloadedBytes += chunk.length;
        const now = Date.now();
        const elapsed = now - lastTime;
        let speed: string | undefined;
        let eta: string | undefined;
        if (elapsed >= 1000) {
          const bps = ((downloadedBytes - lastBytes) / elapsed) * 1000;
          speed = `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
          // Only compute an ETA when we know the total and are making progress,
          // otherwise a missing content-length / stalled second yields "Infinityh".
          if (totalBytes > 0 && bps > 0) {
            const remaining = (totalBytes - downloadedBytes) / bps;
            eta = remaining < 60 ? `${Math.ceil(remaining)}s` : remaining < 3600 ? `${Math.ceil(remaining / 60)}m` : `${Math.ceil(remaining / 3600)}h`;
          }
          lastTime = now;
          lastBytes = downloadedBytes;
        }
        this.emitProgress(componentId, 'download', downloadedBytes, totalBytes, speed, eta);
      });

      response.data.pipe(writeStream);

      await new Promise<void>((resolve, reject) => {
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
        };
        writeStream.on('finish', () => { done(); resolve(); });
        writeStream.on('error', (err) => { done(); reject(err); });
        response.data.on('error', (err: Error) => { done(); writeStream.destroy(); reject(err); });
        signal.addEventListener('abort', () => {
          done();
          response.data.destroy();
          writeStream.destroy();
          reject(new Error('aborted'));
        });
      });

      // Reject a truncated/short download instead of accepting it as success.
      if (totalBytes > 0) {
        const finalSize = fs.statSync(destPath).size;
        if (finalSize !== totalBytes) {
          throw new Error(`${componentId}: downloaded ${finalSize} bytes but expected ${totalBytes}`);
        }
      }
    } catch (error: any) {
      const isCancelled =
        axios.isCancel(error) ||
        error.name === 'AbortError' ||
        error.name === 'CanceledError' ||
        error.message === 'aborted' ||
        error.code === 'ERR_CANCELED';
      if (isCancelled) {
        if (fs.existsSync(destPath)) fs.rmSync(destPath, { force: true });
        throw error;
      }

      const isRetryable =
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ECONNREFUSED' ||
        error.code === 'ENOTFOUND' ||
        error.code === 'EAI_AGAIN' ||
        error.response?.status >= 500 ||
        error.message?.includes('socket hang up') ||
        error.message?.includes('network');

      if (isRetryable && retryCount < MAX_RETRIES) {
        this.logger.log(`Retrying ${componentId} download in 5s (attempt ${retryCount + 1}/${MAX_RETRIES})`);
        await new Promise((r) => setTimeout(r, 5000));
        return this.downloadToFile(url, destPath, componentId, signal, retryCount + 1);
      }

      if (fs.existsSync(destPath)) fs.rmSync(destPath, { force: true });
      throw error;
    }
  }

  private emitProgress(
    componentId: string,
    phase: 'download' | 'verify' | 'extract' | 'install',
    downloadedBytes: number,
    totalBytes: number,
    speed?: string,
    eta?: string,
  ): void {
    const MB = 1024 * 1024;
    this.eventEmitter.emit('component.download.progress', {
      componentId,
      phase,
      progress: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 1000) / 10 : 0,
      downloadedMB: Math.round((downloadedBytes / MB) * 10) / 10,
      totalMB: Math.round((totalBytes / MB) * 10) / 10,
      speed,
      eta,
    });
  }
}
