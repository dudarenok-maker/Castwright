/* fs-21 — is Kokoro installed on disk? Single source of truth for the
   binary "both weight files present" check, reused by the install bootstrap
   and engine-presence. Also exposes a package-presence probe and a 3-state
   detector mirroring qwen-install-detect.ts / coqui-install-detect.ts. */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { kokoroWeightPaths, totalSizeBytes } from './model-paths.js';

export function detectKokoroInstalledOnDisk(repoRoot: string): boolean {
  return totalSizeBytes(kokoroWeightPaths(repoRoot)).fileCount > 0;
}

/** True if the `kokoro_onnx` package is present in the sidecar venv's
    site-packages (Windows `Lib\` + posix `lib\pythonX.Y\`). */
export function kokoroPackageInstalled(repoRoot: string): boolean {
  const venv = join(repoRoot, 'server', 'tts-sidecar', '.venv');
  const candidates = [join(venv, 'Lib', 'site-packages', 'kokoro_onnx')];
  const libDir = join(venv, 'lib');
  try {
    if (existsSync(libDir)) {
      for (const py of readdirSync(libDir)) {
        candidates.push(join(libDir, py, 'site-packages', 'kokoro_onnx'));
      }
    }
  } catch {
    /* no posix lib dir — Windows-only layout */
  }
  return candidates.some((p) => existsSync(p));
}

/** not-installed | weights-missing | ready. (Never 'loaded' — that's a runtime
    fact only the sidecar /health knows.) */
export function detectKokoroInstallStateOnDisk(
  repoRoot: string,
): 'not-installed' | 'weights-missing' | 'ready' {
  if (!kokoroPackageInstalled(repoRoot)) return 'not-installed';
  if (!detectKokoroInstalledOnDisk(repoRoot)) return 'weights-missing';
  return 'ready';
}
