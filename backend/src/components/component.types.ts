/**
 * Types for the download-on-demand component system.
 *
 * The manifest is the catalog published alongside the GitHub binaries release
 * (manifest.json). It lists binary components (ffmpeg, whisper, yt-dlp, llama)
 * and, optionally, whisper models (single-file downloads from a Hugging Face
 * mirror). Each component has per-(platform, arch) artifacts.
 */

/**
 * 'python-env' is the odd one out and deliberately so: it is not downloaded
 * from anywhere. It is a Python virtualenv plus a pre-seeded Hugging Face model
 * that the app CONSTRUCTS locally from an interpreter the user already has,
 * because a virtualenv is not portable between machines and there is no
 * artifact to publish. It travels through the same component surface (list,
 * install, progress, remove) so the user meets it in the same place as
 * everything else. See backend/src/common/nli-env.ts.
 */
export type ComponentKind = 'binary' | 'whisper-model' | 'llama-model' | 'python-env';

export interface ComponentArtifact {
  platform: 'darwin' | 'win32' | 'linux';
  arch: 'arm64' | 'x64' | 'universal';
  url: string;
  file?: string;
  sha256: string;
  bytes: number;
  /** Executable/file to invoke, relative to the extracted component dir. */
  entry: string;
}

export interface ManifestComponent {
  id: string;
  name: string;
  kind: ComponentKind;
  required: boolean;
  description?: string;
  artifacts: ComponentArtifact[];
}

export interface Manifest {
  schemaVersion: number;
  releaseTag?: string;
  repo?: string;
  baseUrl?: string;
  note?: string;
  components: ManifestComponent[];
  /** Optional model entries (whisper ggml-*). Normalized into components at load. */
  models?: ManifestComponent[];
}

/** A record written to components/installed.json after a successful install. */
export interface InstalledRecord {
  id: string;
  kind: ComponentKind;
  /** Absolute directory the component was installed into. */
  dir: string;
  /** Executable/file relative to dir. */
  entry: string;
  sha256: string;
  bytes: number;
  installedAt: string;
}

export interface InstalledManifest {
  components: Record<string, InstalledRecord>;
}

/** Shape returned to the frontend by listComponents(). */
export interface ComponentStatus {
  id: string;
  name: string;
  kind: ComponentKind;
  required: boolean;
  description?: string;
  /** True if a (platform, arch) artifact exists for the current machine. */
  supported: boolean;
  installed: boolean;
  sizeBytes: number;
  installedAt?: string;
}
