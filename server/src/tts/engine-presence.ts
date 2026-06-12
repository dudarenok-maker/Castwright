/* fs-21 — is at least one TTS engine's weights present on disk? Reuses the
   exact detectors the Model Manager inventory uses, so "present" means the
   same thing in both places. */
import { detectKokoroInstalledOnDisk } from './kokoro-install-detect.js';
import { coquiWeightsPresent } from './coqui-install-detect.js';
import { detectQwenInstallStateOnDisk } from './qwen-install-detect.js';

export function anyTtsEnginePresent(repoRoot: string): boolean {
  const kokoro = detectKokoroInstalledOnDisk(repoRoot);
  const coqui = coquiWeightsPresent();
  const qwen = detectQwenInstallStateOnDisk(repoRoot) === 'ready';
  return kokoro || coqui || qwen;
}
