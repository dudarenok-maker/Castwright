/* fs-21 wave 4 — is the venv's package set actually complete, not just the
   interpreter present? A pip install interrupted after `python -m venv`
   succeeds leaves python.exe present but packages incomplete —
   sidecarVenvPresent() alone can't see that. Checks for fastapi: every
   accelerator profile (nvidia-cuda/cpu/amd-rocm) depends on it transitively
   via base.txt, since it's what main.py's server needs to start at all.
   Mirrors the exact existsSync-based pattern qwen-install-detect.ts's
   qwenPackageInstalled already uses. */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function venvCorePackageInstalled(repoRoot: string): boolean {
  const venv = join(repoRoot, 'server', 'tts-sidecar', '.venv');
  const candidates = [join(venv, 'Lib', 'site-packages', 'fastapi')];
  const libDir = join(venv, 'lib');
  try {
    if (existsSync(libDir)) {
      for (const py of readdirSync(libDir)) {
        candidates.push(join(libDir, py, 'site-packages', 'fastapi'));
      }
    }
  } catch {
    /* no posix lib dir — Windows-only layout */
  }
  return candidates.some((p) => existsSync(p));
}
