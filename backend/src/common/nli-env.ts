/**
 * The NLI flag-ranking environment: where it lives, how to tell whether it is
 * really there, and how to build it.
 *
 * WHY THIS FILE IS IN `common/` AND NOT IN `analysis/` OR `components/`.
 * Two unrelated parts of the app need the SAME answer to "is the ranker
 * environment present, and where":
 *
 *   * NliRankerService (analysis) — decides whether to run the ranked flag
 *     path or degrade to chapter discovery.
 *   * ComponentManagerService (components) — reports the component's installed
 *     state to the setup wizard and builds the environment on request.
 *
 * If each kept its own copy they would drift, and the first symptom would be
 * the settings pane saying "Installed" while every analysis silently degrades.
 * So the check lives here, once. This module holds NO Nest DI — it is plain
 * functions over the filesystem and child processes — so both sides can import
 * it without either module depending on the other, and there is no cycle.
 *
 * WHAT THE ENVIRONMENT IS. A directory (default
 * <appSupport>/briefcase/nli) containing:
 *
 *   venv/        a Python virtualenv built from a SYSTEM interpreter, holding
 *                torch + transformers + the deberta tokenizer's sentencepiece.
 *   hf/          HF_HOME for the worker: hf/hub/models--MoritzLaurer--…/ with
 *                the model snapshot pre-downloaded, so an analysis never waits
 *                on (or silently performs) a 350MB fetch mid-run.
 *   worker.py    a copy of the committed worker (backend/python/nli-worker),
 *                placed beside the venv that can actually import transformers.
 *   install.json a marker written ONLY after the freshly built environment was
 *                proven to work end-to-end (see verifyNliWorker).
 *
 * WHAT IT IS NOT. It is not a manifest download and it never will be: there is
 * no artifact to fetch, because a virtualenv is not portable between machines
 * and a 1.2GB per-platform tarball of one is not something to publish. It is
 * CONSTRUCTED locally from a Python the user already has. Briefcase does not
 * bundle or download an interpreter.
 */

import { spawn, spawnSync, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// =============================================================================
// IDENTITY AND CALIBRATION CONSTANTS
// =============================================================================

/** Component id under which the environment is installed/reported/removed. */
export const NLI_COMPONENT_ID = 'nli-ranker';
export const NLI_COMPONENT_NAME = 'Flag ranking (NLI)';
export const NLI_COMPONENT_DESCRIPTION =
  'Ranks every transcript sentence against each flag category locally, then has the AI verify only the ' +
  'passages that scored. Without it, flag detection falls back to a per-chapter LLM pass — slower and lower recall. ' +
  'Needs Python 3.9+ already installed on this computer.';

/**
 * THE model. Changing this id invalidates the calibration in
 * nli-ranker.service.ts (CAPTURE_THRESHOLD 0.2, RESCUE_MIN_SCORE 0.15) and the
 * default hypothesis template in worker.py. It is a measured fact, not a
 * preference — see docs/nli-flag-ranking.md.
 */
export const NLI_MODEL_ID = 'MoritzLaurer/deberta-v3-base-zeroshot-v2.0';

/**
 * The only files the zero-shot pipeline actually loads. Fetching the whole
 * repository would drag in ONNX exports and duplicate weight formats for no
 * benefit; this set reproduces exactly what a working environment contains
 * (~362MB), and a missing optional entry is simply skipped by the hub client.
 */
export const NLI_MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'added_tokens.json',
  'spm.model',
  'model.safetensors',
];

/**
 * PIP PINS, and why they are ranges rather than the exact versions measured.
 *
 * The reference environment (the machine the pipeline was calibrated on) holds
 * torch 2.13.0, transformers 5.15.1, huggingface_hub 1.28.0, tokenizers 0.22.2,
 * safetensors 0.8.0, numpy 2.4.6, sentencepiece 0.2.2.
 *
 * Pinning those EXACTLY would be a portability bug, not rigor. torch publishes
 * per-(OS, arch, Python) wheels, and any single patch version is missing for
 * some combination somebody will have — a machine on a newer Python, or a
 * platform whose wheel for that patch was never built. An exact pin turns that
 * into "install failed, no matching distribution", with nothing the user can do.
 *
 * A major-version ceiling is what the calibration actually depends on:
 * transformers 5's zero-shot pipeline (labels/scores dict, multi_label,
 * hypothesis_template) is the API worker.py speaks, and torch 2.x is the ABI
 * those wheels are built against. Within that, a newer patch does not move a
 * score. So: floor at the oldest version known to carry the API, ceiling at the
 * next major.
 */
export const NLI_PIP_PACKAGES = [
  'torch>=2.6,<3',
  'transformers>=5.0,<6',
  'huggingface_hub>=1.0,<2',
  'tokenizers>=0.21,<1',
  'safetensors>=0.5,<1',
  'sentencepiece>=0.2,<0.3',
  'numpy>=2.0,<3',
];

/** Python packages that must be importable for the worker to run at all. */
export const NLI_REQUIRED_IMPORTS = ['torch', 'transformers', 'sentencepiece'];

/** Minimum interpreter. deberta + transformers 5 need 3.9 at the very least. */
export const NLI_MIN_PYTHON: [number, number] = [3, 9];

/**
 * Installed size, MEASURED on a clean provision (darwin/arm64, torch 2.x CPU +
 * MPS wheel): venv ≈ 867MB, hf ≈ 362MB. Reported to the wizard so the user sees
 * a real number before agreeing to it. Linux/CUDA wheels run larger; this is a
 * floor, not a promise, and it is labelled as approximate in the UI by being the
 * only size we can know before the fact.
 */
export const NLI_INSTALL_BYTES = 1_290_000_000;

export const NLI_MARKER_FILE = 'install.json';

/**
 * What the user is told when no interpreter can be found. Actionable by
 * construction: it names the thing to install and the command that installs it,
 * per platform, because "python not found" on its own is a dead end.
 */
export function noPythonMessage(): string {
  const perPlatform =
    process.platform === 'darwin'
      ? 'macOS: `brew install python@3.11`, or download an installer from python.org.'
      : process.platform === 'win32'
        ? 'Windows: install Python from python.org (tick "Add python.exe to PATH"), or run `winget install Python.Python.3.11`.'
        : 'Linux: install your distribution\'s python3 AND python3-venv packages (e.g. `sudo apt install python3 python3-venv`).';
  return (
    `No usable Python ${NLI_MIN_PYTHON[0]}.${NLI_MIN_PYTHON[1]}+ interpreter was found on PATH. ` +
    `Flag ranking runs in a Python environment that Briefcase builds from an interpreter you already have — ` +
    `it does not bundle or download one. ${perPlatform} ` +
    `Then install "${NLI_COMPONENT_NAME}" again. ` +
    `Until then, analysis still runs: flag detection uses the per-chapter LLM fallback instead.`
  );
}

// =============================================================================
// LAYOUT
// =============================================================================

function appSupportDir(): string {
  return (
    process.env.APPDATA ||
    (process.platform === 'darwin'
      ? path.join(process.env.HOME || os.homedir(), 'Library', 'Application Support')
      : path.join(process.env.HOME || os.homedir(), '.config'))
  );
}

/**
 * Worker directory, in precedence order: BRIEFCASE_NLI_DIR, then `nliWorkerDir`
 * in app-config.json, then the app-support default. Same config file and same
 * fall-through-on-unreadable behavior as `taskModels` and `embeddingModel`.
 *
 * BOTH the ranker and the installer call this, so an override points them at the
 * same directory. That is the whole reason it is one function: a provisioner
 * that built into a different directory than the ranker reads from would report
 * success and change nothing.
 */
export function resolveNliDir(onWarn?: (message: string) => void): string {
  const fromEnv = process.env.BRIEFCASE_NLI_DIR?.trim();
  if (fromEnv) return fromEnv;

  const userDataPath = appSupportDir();
  try {
    const configPath = path.join(userDataPath, 'briefcase', 'app-config.json');
    if (fs.existsSync(configPath)) {
      const configured = JSON.parse(fs.readFileSync(configPath, 'utf8'))?.nliWorkerDir;
      if (typeof configured === 'string' && configured.trim()) return configured.trim();
    }
  } catch (error) {
    onWarn?.(`Ignoring unreadable nliWorkerDir config: ${(error as Error).message}`);
  }

  return path.join(userDataPath, 'briefcase', 'nli');
}

export function nliVenvPython(dir: string): string {
  return process.platform === 'win32'
    ? path.join(dir, 'venv', 'Scripts', 'python.exe')
    : path.join(dir, 'venv', 'bin', 'python');
}

export function nliWorkerPath(dir: string): string {
  return path.join(dir, 'worker.py');
}

export function nliHfHome(dir: string): string {
  return path.join(dir, 'hf');
}

/** site-packages inside the venv, or null when the venv layout is not there. */
export function nliSitePackages(dir: string): string | null {
  if (process.platform === 'win32') {
    const p = path.join(dir, 'venv', 'Lib', 'site-packages');
    return fs.existsSync(p) ? p : null;
  }
  const lib = path.join(dir, 'venv', 'lib');
  try {
    for (const entry of fs.readdirSync(lib)) {
      const p = path.join(lib, entry, 'site-packages');
      if (fs.existsSync(p)) return p;
    }
  } catch {
    // absent venv — same as "no site-packages"
  }
  return null;
}

/** The model snapshot directory, if a complete-looking one exists. */
export function nliModelSnapshotDir(dir: string): string | null {
  const repoDir = path.join(
    nliHfHome(dir),
    'hub',
    `models--${NLI_MODEL_ID.replace('/', '--')}`,
    'snapshots',
  );
  let revisions: string[];
  try {
    revisions = fs.readdirSync(repoDir);
  } catch {
    return null;
  }
  for (const revision of revisions) {
    const snapshot = path.join(repoDir, revision);
    // The two files without which the pipeline cannot construct at all. Symlinks
    // into blobs/ are the normal layout, so existsSync (which follows them) is
    // also the dangling-blob check.
    if (
      fs.existsSync(path.join(snapshot, 'config.json')) &&
      fs.existsSync(path.join(snapshot, 'model.safetensors'))
    ) {
      return snapshot;
    }
  }
  return null;
}

/**
 * The committed worker.py this build carries, to be copied beside the venv.
 * Compiled layout: dist/common/nli-env.js -> dist/python/nli-worker/worker.py.
 * Source layout:   src/common/nli-env.ts  -> backend/python/nli-worker/worker.py.
 */
export function bundledWorkerPath(): string | null {
  const candidates = [
    path.join(__dirname, '..', 'python', 'nli-worker', 'worker.py'),
    path.join(__dirname, '..', '..', 'python', 'nli-worker', 'worker.py'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // unreadable is the same as absent here
    }
  }
  return null;
}

// =============================================================================
// STATUS
// =============================================================================

export interface NliEnvStatus {
  /** True only when every part below is present. */
  installed: boolean;
  /** Human-readable list of what is missing, in the order it is checked. */
  missing: string[];
  dir: string;
  /**
   * True when this environment carries a verification marker, i.e. Briefcase
   * built it and drove it end-to-end afterwards. FALSE IS NOT AN ERROR: an
   * environment built by hand (which is how the first one came to exist, and
   * what docs/nli-flag-ranking.md tells you to do when provisioning fails) works
   * perfectly and has no marker. Provenance, not permission.
   */
  verified: boolean;
  /** Package versions recorded when the environment was last verified. */
  recorded?: Record<string, unknown>;
}

/**
 * Is `pkg` importable from this site-packages, judged from the filesystem?
 *
 * ONLY THE MODULE COUNTS, NEVER THE METADATA. `torch-2.13.0.dist-info` survives
 * a deleted `torch/` directory, and an earlier version of this check accepted it
 * — so an environment with its package removed reported itself complete, which
 * is exactly the lie this whole file exists to prevent. Three real shapes are
 * accepted, and nothing else:
 *
 *   torch/__init__.py                    a package
 *   somemodule.py                        a plain module
 *   somemodule.cpython-311-darwin.so     a C extension (also .pyd on Windows)
 */
function pythonModulePresent(site: string, pkg: string): boolean {
  if (fs.existsSync(path.join(site, pkg, '__init__.py'))) return true;
  if (fs.existsSync(path.join(site, `${pkg}.py`))) return true;
  try {
    return fs
      .readdirSync(site)
      .some((entry) => entry.startsWith(`${pkg}.`) && (entry.endsWith('.so') || entry.endsWith('.pyd')));
  } catch {
    return false;
  }
}

/**
 * Is the environment there? FILESYSTEM ONLY — no interpreter is spawned.
 *
 * WHY NOT SPAWN. This is called by every listComponents(), which is every time
 * the settings pane or the wizard renders. Importing torch costs seconds; doing
 * it on a UI refresh would make the whole component list wait on it.
 *
 * WHY IT IS STILL HONEST. Every file the worker needs is checked individually
 * rather than inferred from one sentinel: the venv interpreter, each required
 * package in site-packages, a model snapshot with both a config and real
 * weights behind its symlinks, and worker.py itself. A half-finished install
 * fails at whichever piece it stopped before, which is the failure this whole
 * exercise exists to prevent — an environment that says "Installed" and
 * degrades every analysis.
 *
 * At INSTALL time the standard is higher: provisionNliEnv finishes by actually
 * driving the thing end-to-end — real interpreter, real imports, real model
 * load, a real scoring round-trip (verifyNliWorker) — and only then writes
 * install.json. That marker is read here for provenance and is NEVER required
 * (see NliEnvStatus.verified). The ranker's own spawn remains the final
 * arbiter: if it fails anyway, it reports unavailable and Repair rebuilds.
 */
export function checkNliEnv(dir: string): NliEnvStatus {
  const missing: string[] = [];

  const python = nliVenvPython(dir);
  if (!fs.existsSync(python)) missing.push(`venv interpreter (${python})`);

  const site = nliSitePackages(dir);
  if (!site) {
    missing.push('venv site-packages');
  } else {
    for (const pkg of NLI_REQUIRED_IMPORTS) {
      if (!pythonModulePresent(site, pkg)) missing.push(`python package ${pkg}`);
    }
  }

  if (!nliModelSnapshotDir(dir)) missing.push(`model snapshot ${NLI_MODEL_ID}`);
  if (!fs.existsSync(nliWorkerPath(dir))) missing.push('worker.py');

  // The marker is READ, never REQUIRED. Requiring it would report the very first
  // environment this feature ever ran on — hand-built, working, in daily use —
  // as "not installed", and would send an analysis down the fallback path over a
  // missing JSON file. What makes the environment usable is the venv, the
  // packages, the model and the worker, all checked above.
  let recorded: Record<string, unknown> | undefined;
  const marker = path.join(dir, NLI_MARKER_FILE);
  try {
    if (fs.existsSync(marker)) recorded = JSON.parse(fs.readFileSync(marker, 'utf8'));
  } catch {
    // an unreadable marker loses provenance, not usability
  }

  return { installed: missing.length === 0, missing, dir, verified: recorded !== undefined, recorded };
}

// =============================================================================
// INTERPRETER DISCOVERY
// =============================================================================

export interface SystemPython {
  command: string;
  args: string[];
  version: string;
}

/**
 * Find a system Python >= NLI_MIN_PYTHON. Candidates in preference order:
 * `python3`, `python`, and on Windows the launcher `py -3`.
 *
 * A candidate must both report a new-enough version AND carry the `venv` module;
 * on Debian-family Linux `python3` frequently exists while `python3-venv` does
 * not, and finding that out here produces a message the user can act on instead
 * of a venv creation failure three steps later.
 */
export function findSystemPython(log?: (message: string) => void): SystemPython | null {
  const candidates: Array<{ command: string; args: string[] }> = [
    { command: 'python3', args: [] },
    { command: 'python', args: [] },
  ];
  if (process.platform === 'win32') candidates.push({ command: 'py', args: ['-3'] });

  for (const candidate of candidates) {
    try {
      const probe = spawnSync(
        candidate.command,
        [...candidate.args, '-c', 'import sys, venv; print("%d.%d" % sys.version_info[:2])'],
        { encoding: 'utf8', timeout: 20000 },
      );
      if (probe.error || probe.status !== 0) {
        log?.(`Python candidate ${candidate.command} unusable: ${probe.error?.message || (probe.stderr || '').trim().split('\n').pop() || `exit ${probe.status}`}`);
        continue;
      }
      const version = (probe.stdout || '').trim();
      const [major, minor] = version.split('.').map((n) => parseInt(n, 10));
      if (!Number.isFinite(major) || !Number.isFinite(minor)) continue;
      if (major < NLI_MIN_PYTHON[0] || (major === NLI_MIN_PYTHON[0] && minor < NLI_MIN_PYTHON[1])) {
        log?.(`Python candidate ${candidate.command} is ${version}, older than ${NLI_MIN_PYTHON.join('.')}`);
        continue;
      }
      return { command: candidate.command, args: candidate.args, version };
    } catch (error) {
      log?.(`Python candidate ${candidate.command} failed to run: ${(error as Error).message}`);
    }
  }
  return null;
}

// =============================================================================
// PROVISIONING
// =============================================================================

export const NLI_STAGES = [
  'Finding a system Python',
  'Creating the Python environment',
  'Installing packages (torch, transformers)',
  `Downloading the ranking model`,
  'Installing and verifying the worker',
] as const;

export interface ProvisionOptions {
  dir: string;
  signal: AbortSignal;
  /**
   * Repair: tear the venv down and rebuild it rather than resuming. The model
   * cache is deliberately KEPT — see provisionNliEnv.
   */
  force?: boolean;
  /** Stage boundary: `stage` completed out of NLI_STAGES.length. */
  onStage: (stagesDone: number, totalStages: number, label: string) => void;
  /**
   * Called while a long child process is running, so a caller that watches for
   * silence (the download dock fails an item after 10 minutes without an event)
   * knows work is still happening. It carries NO new information — pip and the
   * hub client do not report a byte total we could honestly turn into a bar.
   */
  onHeartbeat: (stagesDone: number, totalStages: number, label: string) => void;
  log: (message: string) => void;
}

class AbortedError extends Error {
  constructor() {
    // install() recognises exactly this message as a cancellation.
    super('aborted');
    this.name = 'AbortError';
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AbortedError();
}

/** Run a child to completion, streaming its output to `log`. Killed on abort. */
function runChild(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; signal: AbortSignal; log: (line: string) => void },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    throwIfAborted(options.signal);
    // stdio 'ignore' on stdin: nothing here is interactive, and a pip that
    // decides to prompt must fail rather than block forever on a tty nobody is
    // watching (--no-input is belt to this braces).
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'] as const,
    });

    let tail = '';
    const absorb = (chunk: Buffer) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-4000);
      for (const line of text.split('\n')) {
        if (line.trim()) options.log(line.trim());
      }
    };
    child.stdout.on('data', absorb);
    child.stderr.on('data', absorb);

    const onAbort = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    };
    options.signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => {
      options.signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('exit', (code, sig) => {
      options.signal.removeEventListener('abort', onAbort);
      if (options.signal.aborted) {
        reject(new AbortedError());
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const detail = tail.trim().split('\n').slice(-6).join(' | ');
      reject(new Error(`${command} ${args[0] ?? ''} failed (code=${code}, signal=${sig})${detail ? `: ${detail}` : ''}`));
    });
  });
}

/**
 * Build (or finish building, or rebuild) the environment at `dir`.
 *
 * IDEMPOTENT. A complete, verified environment is detected up front and the
 * whole thing no-ops — no venv is touched and nothing is re-downloaded.
 *
 * RESUMABLE. Every stage checks its own output first, so a run interrupted
 * after the venv but before the model picks up at the model. That is why the
 * marker file is written LAST and only after verification: a half-built
 * environment must never report "installed", which is the failure mode that
 * would silently degrade every analysis afterwards.
 *
 * REPAIR (`force`). Deletes the venv and the marker and rebuilds them. It does
 * NOT delete hf/: the model cache is content-addressed, re-validated against
 * the hub on every fetch, and re-downloading 350MB to fix a broken venv is cost
 * with no benefit. A genuinely damaged model cache is caught by the snapshot
 * check and re-fetched by the model stage regardless of `force`.
 */
export async function provisionNliEnv(options: ProvisionOptions): Promise<NliEnvStatus> {
  const { dir, signal, log } = options;
  const total = NLI_STAGES.length;
  const marker = path.join(dir, NLI_MARKER_FILE);

  // ---- fast path: already complete -----------------------------------------
  if (!options.force) {
    const existing = checkNliEnv(dir);
    if (existing.installed) {
      log(`NLI environment at ${dir} is already complete — nothing to do.`);
      options.onStage(total, total, 'Already installed');
      return existing;
    }
    if (fs.existsSync(dir)) {
      log(`Resuming NLI environment at ${dir}; missing: ${existing.missing.join(', ')}`);
    }
  } else if (fs.existsSync(dir)) {
    log(`Repairing NLI environment at ${dir}: rebuilding the venv (the model cache is kept).`);
    fs.rmSync(path.join(dir, 'venv'), { recursive: true, force: true });
    fs.rmSync(marker, { force: true });
  }

  fs.mkdirSync(dir, { recursive: true });
  // A stale marker beside an incomplete environment would be a lie the moment
  // this run fails; drop it now and re-earn it at the end.
  fs.rmSync(marker, { force: true });

  // ---- stage 1: locate a system interpreter ---------------------------------
  throwIfAborted(signal);
  options.onStage(0, total, NLI_STAGES[0]);
  const python = findSystemPython(log);
  if (!python) throw new Error(noPythonMessage());
  log(`Using system Python ${python.version} (${[python.command, ...python.args].join(' ')})`);
  options.onStage(1, total, NLI_STAGES[1]);

  // ---- stage 2: create the venv ---------------------------------------------
  const venvPython = nliVenvPython(dir);
  if (!fs.existsSync(venvPython)) {
    log(`Creating virtualenv at ${path.join(dir, 'venv')}`);
    try {
      await runChild(python.command, [...python.args, '-m', 'venv', path.join(dir, 'venv')], {
        signal,
        log,
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      const hint =
        process.platform === 'linux'
          ? ' On Debian/Ubuntu this usually means the python3-venv package is not installed (`sudo apt install python3-venv`).'
          : '';
      throw new Error(`Could not create the Python environment: ${(error as Error).message}.${hint}`);
    }
    if (!fs.existsSync(venvPython)) {
      throw new Error(`Virtualenv creation reported success but ${venvPython} does not exist.`);
    }
  } else {
    log('Virtualenv already present — keeping it.');
  }
  options.onStage(2, total, NLI_STAGES[2]);

  // ---- stage 3: install packages --------------------------------------------
  // pip does not report a byte total we could turn into a bar, so this stage
  // reports itself as a STAGE and heartbeats while pip talks.
  // Same rule as checkNliEnv, deliberately: a stage that considered a package
  // present on evidence the status check rejects would skip the pip run and
  // then fail the final verification with nothing having changed.
  const packagesPresent = () => {
    const site = nliSitePackages(dir);
    return site !== null && NLI_REQUIRED_IMPORTS.every((pkg) => pythonModulePresent(site, pkg));
  };

  if (options.force || !packagesPresent()) {
    log(`Installing ${NLI_PIP_PACKAGES.join(' ')} — this is the slow part (roughly 1GB of wheels).`);
    const beat = setInterval(() => options.onHeartbeat(2, total, NLI_STAGES[2]), 15000);
    try {
      await runChild(
        venvPython,
        ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', ...NLI_PIP_PACKAGES],
        { signal, log, env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1' } },
      );
    } finally {
      clearInterval(beat);
    }
    if (!packagesPresent()) {
      throw new Error('pip reported success but torch/transformers are not in the environment.');
    }
  } else {
    log('Python packages already installed — keeping them.');
  }
  options.onStage(3, total, NLI_STAGES[3]);

  // ---- stage 4: pre-download the model --------------------------------------
  if (!nliModelSnapshotDir(dir)) {
    log(`Downloading ${NLI_MODEL_ID} into ${nliHfHome(dir)}`);
    const beat = setInterval(() => options.onHeartbeat(3, total, NLI_STAGES[3]), 15000);
    try {
      await runChild(
        venvPython,
        [
          '-c',
          // Arguments come through the environment, never through this string,
          // so nothing here is built by concatenating a path or a model id.
          'import json, os\n' +
            'from huggingface_hub import snapshot_download\n' +
            "print(snapshot_download(os.environ['BRIEFCASE_NLI_MODEL'], allow_patterns=json.loads(os.environ['BRIEFCASE_NLI_FILES'])))\n",
        ],
        {
          signal,
          log,
          env: {
            ...process.env,
            HF_HOME: nliHfHome(dir),
            HF_HUB_DISABLE_TELEMETRY: '1',
            BRIEFCASE_NLI_MODEL: NLI_MODEL_ID,
            BRIEFCASE_NLI_FILES: JSON.stringify(NLI_MODEL_FILES),
            // The fetch is the one step that MUST be allowed online.
            HF_HUB_OFFLINE: '0',
            TRANSFORMERS_OFFLINE: '0',
          },
        },
      );
    } finally {
      clearInterval(beat);
    }
    if (!nliModelSnapshotDir(dir)) {
      throw new Error(`The model download finished but no usable ${NLI_MODEL_ID} snapshot is present.`);
    }
  } else {
    log('Model snapshot already present — keeping it.');
  }
  options.onStage(4, total, NLI_STAGES[4]);

  // ---- stage 5: install worker.py and prove the whole thing runs -------------
  const source = bundledWorkerPath();
  if (!source) {
    throw new Error(
      'This build carries no copy of worker.py to install (expected dist/python/nli-worker/worker.py). ' +
      'The environment was built but has no worker to run.',
    );
  }
  fs.copyFileSync(source, nliWorkerPath(dir));
  log(`Installed worker.py from ${source}`);

  const beat = setInterval(() => options.onHeartbeat(4, total, NLI_STAGES[4]), 15000);
  let device: string;
  try {
    device = await verifyNliWorker(dir, log, signal);
  } finally {
    clearInterval(beat);
  }

  // The marker is the LAST thing written, and only now: everything above ran,
  // the model loaded, and a real request came back with a real score.
  const versions = readInstalledVersions(dir);
  fs.writeFileSync(
    marker,
    JSON.stringify(
      {
        component: NLI_COMPONENT_ID,
        model: NLI_MODEL_ID,
        device,
        systemPython: python.version,
        packages: versions,
        pins: NLI_PIP_PACKAGES,
        verifiedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );

  const status = checkNliEnv(dir);
  if (!status.installed) {
    throw new Error(`Provisioning finished but the environment still reports missing: ${status.missing.join(', ')}`);
  }
  options.onStage(total, total, 'Installed');
  return status;
}

/** Best-effort record of what pip actually resolved, for the marker file. */
function readInstalledVersions(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const site = nliSitePackages(dir);
  if (!site) return out;
  try {
    for (const entry of fs.readdirSync(site)) {
      const match = /^([A-Za-z0-9_.-]+)-([0-9][^-]*)\.dist-info$/.exec(entry);
      if (!match) continue;
      const name = match[1].replace(/_/g, '-').toLowerCase();
      if (['torch', 'transformers', 'huggingface-hub', 'tokenizers', 'safetensors', 'sentencepiece', 'numpy'].includes(name)) {
        out[name] = match[2];
      }
    }
  } catch {
    // a missing version record is not a reason to fail an otherwise good install
  }
  return out;
}

/**
 * Drive the freshly built environment exactly the way NliRankerService will:
 * spawn `venv/bin/python -u worker.py` with the same offline HF environment,
 * wait for the ready line, send one real scoring request, and require a numeric
 * score back. Then close stdin and expect a clean exit.
 *
 * This is what makes "installed" mean something. A venv that imports torch but
 * cannot load the model, or a model that is present but truncated, both pass a
 * file check and fail here.
 *
 * Returns the device the worker chose, for the record.
 */
export function verifyNliWorker(
  dir: string,
  log: (message: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const python = nliVenvPython(dir);
    const worker = nliWorkerPath(dir);
    log('Verifying: loading the model and scoring a test sentence…');

    const child: ChildProcessWithoutNullStreams = spawn(python, ['-u', worker], {
      cwd: dir,
      env: {
        ...process.env,
        HF_HOME: nliHfHome(dir),
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        TOKENIZERS_PARALLELISM: 'false',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buffer = '';
    let stderrTail = '';
    let device = 'unknown';
    let scored = false;
    let settled = false;

    const timer = setTimeout(() => {
      fail(new Error('Verification timed out after 5 minutes waiting for the worker.'));
    }, 300000);

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      reject(error);
    };
    const onAbort = () => fail(new AbortedError());
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-3000);
    });

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.ready) {
          device = String(message.device ?? 'unknown');
          log(`Worker ready on device ${device}; sending a test request.`);
          child.stdin.write(
            JSON.stringify({
              id: 1,
              texts: ['The election was stolen and the courts are compromised.'],
              hypotheses: ['This example is a conspiracy theory.'],
            }) + '\n',
          );
          continue;
        }
        if (message.error) {
          fail(new Error(`Worker rejected the verification request: ${message.error}`));
          return;
        }
        const score = message?.scores?.[0]?.[0];
        if (typeof score !== 'number' || !Number.isFinite(score)) {
          fail(new Error(`Worker returned no usable score (got ${JSON.stringify(message?.scores)}).`));
          return;
        }
        scored = true;
        log(`Verification round-trip OK (score ${score.toFixed(3)} on device ${device}).`);
        try {
          child.stdin.end();
        } catch {
          /* already closed */
        }
      }
    });

    child.on('error', (error) => fail(new Error(`Could not start the worker: ${error.message}`)));
    child.on('exit', (code, sig) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (scored && (code === 0 || code === null)) {
        resolve(device);
        return;
      }
      const detail = stderrTail.trim().split('\n').slice(-4).join(' | ');
      reject(
        new Error(
          `The worker exited before verification completed (code=${code}, signal=${sig})${detail ? `: ${detail}` : ''}`,
        ),
      );
    });
  });
}

/**
 * Delete the environment. Guarded: it only removes a directory that carries the
 * marker or the expected layout, because this path takes a directory from a
 * stored install record and `rm -rf` on a wrong one is unrecoverable.
 */
export function removeNliEnv(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  const looksLikeOurs =
    fs.existsSync(path.join(dir, NLI_MARKER_FILE)) ||
    fs.existsSync(path.join(dir, 'venv')) ||
    fs.existsSync(nliWorkerPath(dir));
  if (!looksLikeOurs) {
    throw new Error(`Refusing to delete ${dir}: it does not look like an NLI worker environment.`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
