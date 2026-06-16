/* Node-side faster-whisper (Whisper ASR) install detection — a filesystem
   probe that works at server BOOT, before the sidecar is spawned. Mirrors
   coqui-install-detect.ts / kokoro-install-detect.ts but for the ASR engine.

     - The `faster_whisper` package is a BASE sidecar requirement for ASR
       (requirements.txt when SEG_ASR_ENABLED), so package-missing means a
       broken or ASR-less venv — 'not-installed' really means "faster-whisper
       was never pip-installed."
     - The CTranslate2 weights are fetched on first ASR load from the HF hub
       (default model "base" → Systran/faster-whisper-base). They live in the
       HF hub cache; whisperRepoDir() from model-paths.ts resolves the path
       the same way the sidecar runtime does (env-overridable via ASR_MODEL /
       HF_HUB_CACHE / HF_HOME).

   Kept deliberately conservative: any uncertainty resolves "downward"
   (not-installed / weights-missing). */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { whisperRepoDir, dirSizeBytes } from './model-paths.js';

export type WhisperInstallState = 'not-installed' | 'weights-missing' | 'ready';

/** True if the `faster_whisper` package is present in the sidecar venv's
    site-packages (Windows `Lib\` + posix `lib\pythonX.Y\`). */
export function whisperPackageInstalled(repoRoot: string): boolean {
  const venv = join(repoRoot, 'server', 'tts-sidecar', '.venv');
  const candidates = [join(venv, 'Lib', 'site-packages', 'faster_whisper')];
  const libDir = join(venv, 'lib');
  try {
    if (existsSync(libDir)) {
      for (const py of readdirSync(libDir)) {
        candidates.push(join(libDir, py, 'site-packages', 'faster_whisper'));
      }
    }
  } catch {
    /* no posix lib dir — Windows-only layout */
  }
  return candidates.some((p) => existsSync(p));
}

/** True if the Whisper CTranslate2 weight repo has any bytes on disk.
    Uses dirSizeBytes(whisperRepoDir()) > 0 — the same predicate the Model
    Manager inventory row uses so the probe and the inventory agree. */
export function whisperWeightsPresent(): boolean {
  return dirSizeBytes(whisperRepoDir()).bytes > 0;
}

/** not-installed | weights-missing | ready. (Never 'loaded' — that's a runtime
    fact only the sidecar /health knows.) */
export function detectWhisperInstallStateOnDisk(repoRoot: string): WhisperInstallState {
  if (!whisperPackageInstalled(repoRoot)) return 'not-installed';
  if (!whisperWeightsPresent()) return 'weights-missing';
  return 'ready';
}
