/* Side-effect-only module: load server/.env into process.env before any
   other module in the graph has a chance to read it.

   This file exists because ESM `import` declarations are HOISTED above the
   importing module's body — so a top-of-file `process.loadEnvFile('.env')`
   in index.ts actually runs AFTER every imported module has already
   evaluated. That means modules like workspace/paths.ts capture
   `process.env.WORKSPACE_DIR` while it's still undefined, then export a
   stale constant.

   Placing the call inside its own module and importing it FIRST in
   index.ts puts the env load at the correct point in the dependency
   evaluation order: ESM evaluates this module's body (the loadEnvFile
   side-effect) before any later import statement is reached. Subsequent
   imports then read the freshly populated process.env. */

/** Boot config-load state, surfaced on /api/health so a wrong-CWD launch
    (server/.env not found → silent defaults) is visible, not buried. */
export const envLoadState: { loaded: boolean; cwd: string } = {
  loaded: false,
  cwd: process.cwd(),
};

/** Pure, testable warning string for a missing .env. */
export function formatMissingEnvWarning(cwd: string): string {
  return (
    `[server] WARNING: no .env found at ${cwd}\\.env — running on DEFAULTS. ` +
    `GEN_WORKERS, GPU_VRAM_BUDGET, WORKSPACE_DIR and all other server/.env tuning ` +
    `are NOT applied. Launch the server with its working directory at server/ ` +
    `(the prod launcher does this) so server/.env loads.`
  );
}

try {
  process.loadEnvFile('.env');
  envLoadState.loaded = true;
} catch {
  // Missing .env is non-fatal (shell env still applies) but must be LOUD —
  // a silently-defaulted server is the 2026-06-08 stall incident.
  console.warn(formatMissingEnvWarning(envLoadState.cwd));
}
