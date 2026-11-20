/* #4443 — Windows refuses to start under a Node release that carries the
   libuv loopback-connect crash (libuv#5106). Pure logic + a loader for the
   range list. The list itself lives ONLY in the repo-root package.json
   (`castwright.node.windowsLoopbackCrash`) — never hardcode it here. The
   version a refused user is told to install is the `engines.node` floor, one
   minimum that works, never a range's own upper bound (that bound can itself
   be a refused version).
   Unknown is not refused: an unparseable version or a non-Windows platform
   always starts. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/* server/src -> server -> repo root. The same depth holds from server/dist
   after tsc. Mirrors REPO_ROOT in diagnostics/ffmpeg.ts. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface NodeCrashRange {
  from: string;
  toExclusive: string;
}

type Triple = [number, number, number];

/** Accepts `v24.15.0` or `24.15.0`; null for anything else. */
export function parseNodeVersion(v: string): Triple | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(typeof v === 'string' ? v.trim() : '');
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compare(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** The range containing `version` (from inclusive, toExclusive exclusive), or
 *  null. Always null off Windows and for an unparseable version. */
export function findCrashRange(
  version: string,
  platform: string,
  ranges: readonly NodeCrashRange[],
): NodeCrashRange | null {
  if (platform !== 'win32') return null;
  const v = parseNodeVersion(version);
  if (!v) return null;
  for (const r of ranges) {
    const from = parseNodeVersion(r.from);
    const to = parseNodeVersion(r.toExclusive);
    if (!from || !to) continue;
    if (compare(v, from) >= 0 && compare(v, to) < 0) return r;
  }
  return null;
}

/** The user-facing refusal message, or null when the version may start. */
export function nodeRuntimeRefusal(
  version: string,
  platform: string,
  ranges: readonly NodeCrashRange[],
  minimum: string,
): string | null {
  const range = findCrashRange(version, platform, ranges);
  if (!range) return null;
  const running = version.trim().replace(/^v?/, 'v');
  return (
    `Castwright can't start on Node ${running} on Windows: that Node release has a known networking crash (libuv#5106). ` +
    `Install Node v${minimum} or newer from https://nodejs.org and start Castwright again.`
  );
}

/** Reads the range list from the repo-root package.json. Throws if the file or
 *  the `castwright.node.windowsLoopbackCrash` array cannot be read. */
export function loadCrashRanges(): NodeCrashRange[] {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    castwright?: { node?: { windowsLoopbackCrash?: unknown } };
  };
  const list = pkg.castwright?.node?.windowsLoopbackCrash;
  if (!Array.isArray(list)) throw new Error('castwright.node.windowsLoopbackCrash missing');
  return list.filter(
    (r): r is NodeCrashRange =>
      !!r && typeof r.from === 'string' && typeof r.toExclusive === 'string',
  );
}

/** The minimum Node that works: the plain `>=X.Y.Z` floor of the repo-root
 *  package.json `engines.node`. Throws if it is absent or not a plain floor. */
export function loadNodeMinimum(): string {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    engines?: { node?: unknown };
  };
  const m = /^>=\s*(\d+\.\d+\.\d+)$/.exec(typeof pkg.engines?.node === 'string' ? pkg.engines.node.trim() : '');
  if (!m) throw new Error('engines.node is not a plain >=X.Y.Z floor');
  return m[1];
}
