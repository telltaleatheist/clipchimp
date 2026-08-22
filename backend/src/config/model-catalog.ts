/**
 * Self-contained model catalogs (whisper + local AI / GGUF).
 *
 * These download directly from Hugging Face at runtime, independent of the
 * GitHub binaries manifest. This is the single source of truth shared by:
 *   - ModelManagerService (local GGUF management for the analysis pipeline)
 *   - ComponentManagerService (download-on-demand for the setup wizard / dock)
 *
 * Keeping the catalog here (not in the published manifest) means new sizes can
 * be added without republishing a release asset.
 */

import { ComponentArtifact, ManifestComponent } from '../components/component.types';

const HF_WHISPER = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

// ---------------- Local AI (llama.cpp GGUF) ----------------

export interface CogitoModelDef {
  id: string;
  name: string;
  filename: string;
  url: string;
  sizeGB: number;
  /** Minimum VRAM (GPU) or RAM (CPU) needed to run the model. */
  minRAM: number;
  /** Transformer block count — used to compute partial GPU offload (-ngl). */
  layers: number;
  description: string;
}

/**
 * Bundled llama.cpp models — intentionally EMPTY.
 *
 * Briefcase no longer ships or downloads its own GGUF weights. Local inference
 * is served entirely by Ollama, which the user manages themselves; cloud work
 * goes to Claude or OpenAI. The llama.cpp plumbing (LlamaBridge / LlamaManager /
 * ModelManagerService) is left intact and simply has nothing to offer, so the
 * 'local' provider reports unavailable and the setup wizard lists no local
 * models. Re-populating this array is all that's needed to revive it.
 */
export const COGITO_MODELS: CogitoModelDef[] = [];

// ---------------- Whisper (speech-to-text) ----------------

export interface WhisperModelDef {
  /** Component id used by the download system. */
  id: string;
  /** Short model name as it appears on disk (ggml-<model>.bin). */
  model: string;
  name: string;
  description: string;
  filename: string;
  url: string;
  bytes: number;
  /** Optional — verification is skipped when absent. */
  sha256?: string;
}

export const WHISPER_MODELS: WhisperModelDef[] = [
  {
    id: 'whisper-model-tiny',
    model: 'tiny',
    name: 'Whisper Tiny (fastest)',
    description: 'Smallest and fastest, lowest accuracy. Good for quick drafts.',
    filename: 'ggml-tiny.bin',
    url: `${HF_WHISPER}/ggml-tiny.bin`,
    bytes: 77691713,
    sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21',
  },
  {
    id: 'whisper-model-base',
    model: 'base',
    name: 'Whisper Base (recommended)',
    description: 'Balanced speed and accuracy. Recommended default.',
    filename: 'ggml-base.bin',
    url: `${HF_WHISPER}/ggml-base.bin`,
    bytes: 147951465,
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
  },
  {
    id: 'whisper-model-small',
    model: 'small',
    name: 'Whisper Small',
    description: 'Better accuracy, slower and larger.',
    filename: 'ggml-small.bin',
    url: `${HF_WHISPER}/ggml-small.bin`,
    bytes: 487601967,
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
  },
  {
    id: 'whisper-model-medium',
    model: 'medium',
    name: 'Whisper Medium',
    description: 'High accuracy for tougher audio. Slower, ~1.5 GB.',
    filename: 'ggml-medium.bin',
    url: `${HF_WHISPER}/ggml-medium.bin`,
    bytes: 1533763059,
  },
  {
    id: 'whisper-model-large-v3-turbo',
    model: 'large-v3-turbo',
    name: 'Whisper Large v3 Turbo',
    description: 'Near-large accuracy, much faster. ~1.5 GB.',
    filename: 'ggml-large-v3-turbo.bin',
    url: `${HF_WHISPER}/ggml-large-v3-turbo.bin`,
    bytes: 1624555275,
  },
  {
    id: 'whisper-model-large-v3',
    model: 'large-v3',
    name: 'Whisper Large v3 (most accurate)',
    description: 'Best accuracy, slowest and largest. ~3 GB.',
    filename: 'ggml-large-v3.bin',
    url: `${HF_WHISPER}/ggml-large-v3.bin`,
    bytes: 3095033483,
  },
];

// ---------------- Catalog → ManifestComponent adapters ----------------

const PLATFORMS: ComponentArtifact['platform'][] = ['darwin', 'win32', 'linux'];

/** Models are platform-agnostic single files; expand to one artifact per platform. */
function universalArtifacts(
  url: string,
  file: string,
  bytes: number,
  entry: string,
  sha256?: string,
): ComponentArtifact[] {
  return PLATFORMS.map((platform) => ({
    platform,
    arch: 'universal',
    url,
    file,
    sha256: sha256 ?? '',
    bytes,
    entry,
  }));
}

export function whisperModelComponents(): ManifestComponent[] {
  return WHISPER_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    kind: 'whisper-model',
    required: false,
    description: m.description,
    artifacts: universalArtifacts(m.url, m.filename, m.bytes, m.filename, m.sha256),
  }));
}

export function llamaModelComponents(): ManifestComponent[] {
  return COGITO_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    kind: 'llama-model',
    required: false,
    description: m.description,
    artifacts: universalArtifacts(
      m.url,
      m.filename,
      Math.round(m.sizeGB * 1024 * 1024 * 1024),
      m.filename,
    ),
  }));
}
