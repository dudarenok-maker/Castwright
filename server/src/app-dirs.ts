/* fs-1 — shared app-runtime directories (logs + .run).

   Default to <repoRoot>/logs and <repoRoot>/.run (the single-checkout layout
   every install uses today), but honour APP_LOG_DIR / APP_RUN_DIR so the
   versioned-directory install (fs-1) can point them at a shared sibling
   OUTSIDE the per-release tree. Without this, a `releases/vX.Y.Z/logs` and
   `releases/vX.Y.Z/.run/tts.pid` would be orphaned on every upgrade — and the
   server.pid the restarter waits on would live inside the dir being swapped.

   An explicit env value wins outright (matching every other env knob here);
   when unset, resolution is byte-identical to before. */

import { resolve } from 'node:path';

export function resolveLogDir(repoRoot: string): string {
  return process.env.APP_LOG_DIR ? resolve(process.env.APP_LOG_DIR) : resolve(repoRoot, 'logs');
}

export function resolveRunDir(repoRoot: string): string {
  return process.env.APP_RUN_DIR ? resolve(process.env.APP_RUN_DIR) : resolve(repoRoot, '.run');
}
