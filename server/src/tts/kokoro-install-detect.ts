/* fs-21 — is Kokoro installed on disk? Single source of truth for the
   binary "both weight files present" check, reused by the install bootstrap
   and engine-presence. */
import { kokoroWeightPaths, totalSizeBytes } from './model-paths.js';

export function detectKokoroInstalledOnDisk(repoRoot: string): boolean {
  return totalSizeBytes(kokoroWeightPaths(repoRoot)).fileCount > 0;
}
