import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envLoadState } from './load-env.js';
import { resolveRunDir } from './app-dirs.js';

/* repoRoot mirrors index.ts's own computation (resolve(__dirname, '..', '..')
   from server/dist) so resolveRunDir() here agrees with the value index.ts
   passes to app.listen()/lan-cert wiring — both derive from this compiled
   file's own location, not from process.cwd(), so this stays correct
   regardless of which directory the server was launched from. */
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');

/** Pure builder for the /api/health response body.
 *  Extracted so the test can import it directly without pulling in index.ts's
 *  top-level side effects (app.listen, sidecar spawn, upgrade coordinator). */
export function buildHealthPayload() {
  return {
    ok: true as const,
    ts: new Date().toISOString(),
    configLoad: {
      envLoaded: envLoadState.loaded,
      cwd: envLoadState.cwd,
      /* Identity signal for "is this the SAME install", not merely the same
         cwd (Castwright#3030): resolveRunDir honours APP_RUN_DIR, which a
         versioned-dir (fs-1) install sets IDENTICALLY across every release
         version (scripts/launch.mjs's planLaunch), so an in-progress upgrade
         restart still recognizes the old release's server as its own. A bare
         checkout/worktree has no APP_RUN_DIR override, so runDir defaults to
         <that worktree's own repoRoot>/.run — distinct per worktree, which is
         what lets the prod launcher tell a sibling worktree's own server
         apart from its own already-running instance. */
      runDir: resolveRunDir(repoRoot),
    },
  };
}
