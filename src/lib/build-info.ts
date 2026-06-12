// Plan 124 — build-version footer.
//
// `buildInfo` reads the compile-time constants injected by vite.config.ts
// (`define`). Vitest runs with its own config and NO `define`, so each global
// is read behind a `typeof` guard and falls back to a sentinel — without the
// guard, importing this module under Vitest would ReferenceError at load.
//
// `formatBuildStamp` is intentionally pure (no `import.meta`, no globals) so the
// display logic is unit-testable with plain fixtures.

import { BRAND_NAME } from './brand';

export interface BuildInfo {
  version: string;
  sha: string;
  branch: string;
  dirty: boolean;
  buildTime: string;
}

export const buildInfo: BuildInfo = {
  version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0-dev',
  sha: typeof __GIT_SHA__ !== 'undefined' ? __GIT_SHA__ : 'unknown',
  branch: typeof __GIT_BRANCH__ !== 'undefined' ? __GIT_BRANCH__ : 'local',
  dirty: typeof __GIT_DIRTY__ !== 'undefined' ? __GIT_DIRTY__ : false,
  buildTime: typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '',
};

/**
 * Build the footer stamp string.
 *
 * Dev (verbose): `v1.4.0 · a1b2c3d* · fix/foo · 14:32`
 *   — version · short-SHA (`*` = dirty working tree) · branch · build time.
 * Prod (minimal): `v1.4.0 (a1b2c3d)` — version + short SHA only.
 */
export function formatBuildStamp(info: BuildInfo, opts: { dev: boolean }): string {
  const prefix = BRAND_NAME;
  if (!opts.dev) return `${prefix} · v${info.version} (${info.sha})`;
  const sha = info.dirty ? `${info.sha}*` : info.sha;
  const parts = [prefix, `v${info.version}`, sha, info.branch];
  if (info.buildTime) parts.push(info.buildTime);
  return parts.join(' · ');
}
