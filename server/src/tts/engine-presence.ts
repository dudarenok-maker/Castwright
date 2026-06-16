/* fs-21 — is at least one TTS engine's weights present on disk? Reuses the
   exact detectors the Model Manager inventory uses, so "present" means the
   same thing in both places. Kokoro and Coqui now require 'ready'
   (package+weights), not weights alone, so a broken venv (weights present
   but package gone) correctly reports absent rather than a false pass. */
import { detectKokoroInstallStateOnDisk } from './kokoro-install-detect.js';
import { detectCoquiInstallStateOnDisk } from './coqui-install-detect.js';
import { detectQwenInstallStateOnDisk } from './qwen-install-detect.js';
import { engineTier } from './engine-health.js';
import type { EngineId, EngineHealthState } from './engine-health.js';

export function anyTtsEnginePresent(repoRoot: string): boolean {
  const kokoro = detectKokoroInstallStateOnDisk(repoRoot) === 'ready';
  const coqui = detectCoquiInstallStateOnDisk(repoRoot) === 'ready';
  const qwen = detectQwenInstallStateOnDisk(repoRoot) === 'ready';
  return kokoro || coqui || qwen;
}

export type ReadinessSeverity = 'ok' | 'info' | 'warn' | 'block';

/** Fail-open severity helper for the readiness / diagnostics surface.
    'package-missing' only becomes a hard 'block' once the sidecar's find_spec
    has confirmed the package is truly unimportable; otherwise it's a 'warn'
    (the disk probe may have a path miss on a non-standard venv layout). */
export function readinessSeverity(input: {
  engine: EngineId;
  state: EngineHealthState;
  sidecarConfirmed: boolean;
}): ReadinessSeverity {
  const { engine, state, sidecarConfirmed } = input;
  switch (state) {
    case 'ready':
    case 'loaded':
      return 'ok';
    case 'package-missing':
      return sidecarConfirmed ? 'block' : 'warn';
    case 'weights-missing':
      return 'warn';
    case 'not-installed':
      return engineTier(engine) === 'secondary' ? 'info' : 'warn';
  }
}
