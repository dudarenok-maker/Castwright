/* fs-21 — is the TTS sidecar's Python venv bootstrapped? The venv is
   upstream of every TTS engine (start.{sh,ps1} error out without it).
   Checks both the Windows (Scripts\python.exe) and POSIX (bin/python)
   layouts, honouring SIDECAR_VENV_DIR (versioned-install override). */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function sidecarVenvPresent(repoRoot: string): boolean {
  const base =
    process.env.SIDECAR_VENV_DIR ?? join(repoRoot, 'server', 'tts-sidecar', '.venv');
  return (
    existsSync(join(base, 'bin', 'python')) ||
    existsSync(join(base, 'Scripts', 'python.exe'))
  );
}
