/* The per-surface registry of INSTALLABLE VOICE engines the setup Models step
   and the Model Manager manage: kokoro, qwen, coqui. NOT a consolidation of the
   codebase's other engine lists (ALL_TTS_ENGINES, TRACKED_ENGINES, EngineId…) —
   deliberately scoped to "engines with an install card + disk detector."
   Excludes whisper (ASR), gemini (cloud), piper (no detector/card).

   Adding a future voice engine = one entry here. */
import {
  kokoroPackageInstalled,
  detectKokoroInstalledOnDisk,
} from './kokoro-install-detect.js';
import { qwenPackageInstalled, qwenWeightsPresent } from './qwen-install-detect.js';
import { coquiPackageInstalled, coquiWeightsPresent } from './coqui-install-detect.js';
import type { SidecarHealthResult } from '../routes/sidecar-health.js';

export type VoiceEngineId = 'kokoro' | 'qwen' | 'coqui';

export interface VoiceEngineEntry {
  id: VoiceEngineId;
  /** Default model key this engine maps to for the Defaults handoff (Part B). */
  defaultModelKey: 'kokoro-v1' | 'qwen3-tts-0.6b' | 'coqui-xtts-v2';
  /** Python package present in the venv site-packages (disk fact). */
  packageInstalledOnDisk: (repoRoot: string) => boolean;
  /** Model weights present on disk (disk fact). */
  weightsPresentOnDisk: (repoRoot: string) => boolean;
  /** Live: package importable in the running sidecar. undefined when the health
      field is absent (older sidecar / sidecar down) — caller treats undefined as
      "unknown", never as broken. */
  livePackageImportable: (h: Partial<SidecarHealthResult>) => boolean | undefined;
  /** Live: model resident in the sidecar now. */
  liveLoaded: (h: Partial<SidecarHealthResult>) => boolean;
}

export const VOICE_ENGINES: VoiceEngineEntry[] = [
  {
    id: 'kokoro',
    defaultModelKey: 'kokoro-v1',
    packageInstalledOnDisk: (root) => kokoroPackageInstalled(root),
    weightsPresentOnDisk: (root) => detectKokoroInstalledOnDisk(root),
    livePackageImportable: (h) => h.kokoroPackageInstalled,
    liveLoaded: (h) => h.kokoroLoaded === true,
  },
  {
    id: 'qwen',
    defaultModelKey: 'qwen3-tts-0.6b',
    packageInstalledOnDisk: (root) => qwenPackageInstalled(root),
    weightsPresentOnDisk: () => qwenWeightsPresent(),
    livePackageImportable: (h) => h.qwenPackageInstalled,
    liveLoaded: (h) => h.qwenLoaded === true,
  },
  {
    id: 'coqui',
    defaultModelKey: 'coqui-xtts-v2',
    packageInstalledOnDisk: (root) => coquiPackageInstalled(root),
    weightsPresentOnDisk: () => coquiWeightsPresent(),
    livePackageImportable: (h) => h.coquiPackageInstalled,
    liveLoaded: (h) => h.modelLoaded === true,
  },
];
