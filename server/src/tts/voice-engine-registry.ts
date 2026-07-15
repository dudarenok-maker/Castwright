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
  /** Authored: the engine produces expressive/emotive speech (no code source —
      a curated fact). Kokoro is flat/fast; Qwen + Coqui are expressive. Read by
      the recommendation's capable-set filter (expressive || multilingual). */
  expressive: boolean;
  /** Authored estimate: comfortable VRAM (MB) for the GENERATION path. The
      recommendation reads the capable LEAD's floor to decide whether to attach a
      caveat. Not measured — refine on-box if contradicted. */
  genVramFloorMb: number;
  /** Authored: lead preference within the capable (expressive||multilingual) set.
      Lower wins. Only meaningful for capable engines (Qwen 0, Coqui 1); a
      non-capable engine (Kokoro) never enters the set, so its rank is a high
      sentinel (99). */
  capablePreferenceRank: number;
}

export const VOICE_ENGINES: VoiceEngineEntry[] = [
  {
    id: 'kokoro',
    defaultModelKey: 'kokoro-v1',
    packageInstalledOnDisk: (root) => kokoroPackageInstalled(root),
    weightsPresentOnDisk: (root) => detectKokoroInstalledOnDisk(root),
    livePackageImportable: (h) => h.kokoroPackageInstalled,
    liveLoaded: (h) => h.kokoroLoaded === true,
    expressive: false,
    genVramFloorMb: 1024,
    capablePreferenceRank: 99,
  },
  {
    id: 'qwen',
    defaultModelKey: 'qwen3-tts-0.6b',
    packageInstalledOnDisk: (root) => qwenPackageInstalled(root),
    weightsPresentOnDisk: () => qwenWeightsPresent(),
    livePackageImportable: (h) => h.qwenPackageInstalled,
    liveLoaded: (h) => h.qwenLoaded === true,
    expressive: true,
    genVramFloorMb: 6144,
    capablePreferenceRank: 0,
  },
  {
    id: 'coqui',
    defaultModelKey: 'coqui-xtts-v2',
    packageInstalledOnDisk: (root) => coquiPackageInstalled(root),
    weightsPresentOnDisk: () => coquiWeightsPresent(),
    livePackageImportable: (h) => h.coquiPackageInstalled,
    liveLoaded: (h) => h.modelLoaded === true,
    expressive: true,
    genVramFloorMb: 4096,
    capablePreferenceRank: 1,
  },
];
