import { envLoadState } from './load-env.js';

/** Pure builder for the /api/health response body.
 *  Extracted so the test can import it directly without pulling in index.ts's
 *  top-level side effects (app.listen, sidecar spawn, upgrade coordinator). */
export function buildHealthPayload() {
  return {
    ok: true as const,
    ts: new Date().toISOString(),
    configLoad: { envLoaded: envLoadState.loaded, cwd: envLoadState.cwd },
  };
}
