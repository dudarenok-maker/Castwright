/* #4443 — Windows refuses to start under a Node release that carries the
   libuv loopback-connect crash (libuv#5106). Pure logic + a loader for the
   range list, shared by the server (server/src/node-runtime-guard*.ts) and the
   launchers (scripts/start-app-prod.mjs), which make their own 127.0.0.1
   connect on the same Node before the server exists. The list itself lives
   ONLY in the repo-root package.json (`castwright.node.windowsLoopbackCrash`)
   — never hardcode it here. The version a refused user is told to install is
   the `engines.node` floor, one minimum that works, never a range's own upper
   bound (that bound can itself be a refused version).
   Unknown is not refused: an unparseable version or a non-Windows platform
   always starts. Types: node-runtime-guard.d.mts. */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/* scripts/lib -> scripts -> repo root. The server reaches this file at
   ../../scripts/lib from both server/src and server/dist, so it is the same
   file (and the same root) from every caller. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Accepts `v24.15.0` or `24.15.0`; null for anything else. */
export function parseNodeVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(typeof v === 'string' ? v.trim() : '');
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** The range containing `version` (from inclusive, toExclusive exclusive), or
 *  null. Always null off Windows and for an unparseable version. */
export function findCrashRange(version, platform, ranges) {
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

function normalizePath(p) {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** True when `execPath` lives inside the conda env named by `CONDA_PREFIX`
 *  (Pinokio's env at <app>/env). Installing from nodejs.org cannot fix that
 *  Node: the env's copy shadows PATH. */
export function isCondaEnvNode(env, execPath) {
  const prefix = normalizePath(env.CONDA_PREFIX ?? '');
  if (!prefix) return false;
  return normalizePath(execPath).startsWith(`${prefix}/`);
}

/** The user-facing refusal message, or null when the version may start.
 *  `env` and `execPath` let it tell a Pinokio (conda env) Node to run Update
 *  again instead of pointing at nodejs.org. */
export function nodeRuntimeRefusal(version, platform, ranges, minimum, env = {}, execPath = '') {
  const range = findCrashRange(version, platform, ranges);
  if (!range) return null;
  const running = version.trim().replace(/^v?/, 'v');
  const head = `Castwright can't start on Node ${running} on Windows: that Node release has a known networking crash (libuv#5106). `;
  if (isCondaEnvNode(env, execPath)) {
    return (
      head +
      `This Node comes from Pinokio's environment. Run Update in Pinokio again: it installs Node v${minimum} or newer into that environment. Then start Castwright again.`
    );
  }
  return head + `Install Node v${minimum} or newer from https://nodejs.org and start Castwright again.`;
}

/** Reads the range list from the repo-root package.json. Throws if the file or
 *  the `castwright.node.windowsLoopbackCrash` array cannot be read. */
export function loadCrashRanges() {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const list = pkg.castwright?.node?.windowsLoopbackCrash;
  if (!Array.isArray(list)) throw new Error('castwright.node.windowsLoopbackCrash missing');
  return list.filter((r) => !!r && typeof r.from === 'string' && typeof r.toExclusive === 'string');
}

/** The minimum Node that works: the plain `>=X.Y.Z` floor of the repo-root
 *  package.json `engines.node`. Throws if it is absent or not a plain floor. */
export function loadNodeMinimum() {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const m = /^>=\s*(\d+\.\d+\.\d+)$/.exec(typeof pkg.engines?.node === 'string' ? pkg.engines.node.trim() : '');
  if (!m) throw new Error('engines.node is not a plain >=X.Y.Z floor');
  return m[1];
}

/** Refuses a known-bad Node: writes the message to stderr AND to
 *  <logDir>/node-refused.log, then exits 1. The file is for the in-app
 *  "Upgrade & restart" path, whose restarter and launcher run with stdio
 *  ignored, so stderr reaches nobody; logDir honours APP_LOG_DIR like the
 *  launcher's own. A file that cannot be written never stops the refusal. A
 *  missing or unreadable package.json must never stop the app, so a load
 *  failure only warns and the caller continues. No override switch (owner
 *  decision 2026-11-20). Every dependency is injectable for tests. */
export function enforceNodeRuntime({
  version = process.version,
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
  logDir = env?.APP_LOG_DIR ? resolve(env.APP_LOG_DIR) : join(REPO_ROOT, 'logs'),
  stderr = (text) => process.stderr.write(text),
  exit = (code) => process.exit(code),
  warn = (text) => console.warn(text),
} = {}) {
  try {
    const message = nodeRuntimeRefusal(version, platform, loadCrashRanges(), loadNodeMinimum(), env, execPath);
    if (message) {
      try {
        mkdirSync(logDir, { recursive: true });
        writeFileSync(join(logDir, 'node-refused.log'), `${new Date().toISOString()} ${message}\n`);
      } catch {
        /* best effort: the refusal itself must still happen */
      }
      stderr(`${message}\n`);
      exit(1);
    }
  } catch (err) {
    warn(
      `[node-runtime-guard] could not read the Node range list, continuing: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
