/* fs-21 — is at least one TTS engine's weights present on disk? Reuses the
   exact detectors the Model Manager inventory uses, so "present" means the
   same thing in both places. */
import { kokoroWeightPaths, totalSizeBytes } from './model-paths.js';
import { coquiWeightsPresent } from './coqui-install-detect.js';
import { detectQwenInstallStateOnDisk } from './qwen-install-detect.js';

export function anyTtsEnginePresent(repoRoot: string): boolean {
  const kokoro = totalSizeBytes(kokoroWeightPaths(repoRoot)).fileCount > 0;
  const coqui = coquiWeightsPresent();
  const qwen = detectQwenInstallStateOnDisk(repoRoot) === 'ready';
  return kokoro || coqui || qwen;
}
