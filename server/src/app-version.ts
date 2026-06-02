/* fs-1 — the running server's own version, read once from its package.json.

   Lockstep-guaranteed equal to the root package.json by bump-version.mjs, so
   either is authoritative; we read server/package.json because it's the file
   that ships next to the compiled server. Used by the upgrade coordinator (to
   detect a version change since last boot) and GET /api/info. */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let cached: string | null = null;

export function getAppVersion(): string {
  if (cached) return cached;
  try {
    const pkg = JSON.parse(readFileSync(join(SERVER_ROOT, 'package.json'), 'utf8')) as { version?: unknown };
    cached = typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}

/** Compare two dotted versions. Returns <0 if a<b, 0 if equal, >0 if a>b.
    Non-numeric / malformed segments compare as 0 so a junk value can't be
    mistaken for an upgrade. Pure — exported for the coordinator + its tests. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Test-only: drop the cached version so a test can re-read a patched file. */
export function _resetAppVersionCache(): void {
  cached = null;
}
