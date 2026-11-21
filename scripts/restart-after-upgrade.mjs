#!/usr/bin/env node
/* fs-1 — detached restarter, spawned by POST /api/upgrade/apply AFTER the
   .current-version pointer is flipped to the new release.

   The applying server is about to shut down (drain + sidecar taskkill). This
   process is detached + unref'd so it OUTLIVES that shutdown, waits for the old
   server PID to actually exit (freeing the port and stopping the old release),
   then runs the stable <install>/launch.mjs — which reads the now-flipped
   pointer and boots the NEW release. Because the pointer is the commit point, a
   crash here just means the next manual launch already starts the new version;
   nothing is half-applied.

   Inputs (env, set by apply):
     UPGRADE_OLD_PID       PID of the server that's shutting down (required)
     UPGRADE_INSTALL_ROOT  install root holding launch.mjs (default: this script's ../..)
     UPGRADE_TIMEOUT_MS    max wait for the old PID to exit (default 60000)

   #4443 — before it launches, it runs the Node runtime guard against the NEW
   release (this script ships inside it, so the guard reads that release's own
   range list). A Node the new release would refuse to start on gets the
   pointer put back on the previous release, which is relaunched instead, and
   the reason lands in the upgrade state file the app serves at
   /api/upgrade/state. An upgrade never leaves nothing running. */

import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';
import { pidIsAlive } from './lib/pid-alive.mjs';
import { findCrashRange, loadCrashRanges, loadNodeMinimum, nodeRuntimeRefusal, parseNodeVersion } from './lib/node-runtime-guard.mjs';

/* Where the server keeps its upgrade state: server/src/upgrade/paths.ts
   (stagingDir + stateFile); a test pins the two together. */
export const UPGRADE_STATE_PATH = ['.upgrade-staging', 'state.json'];

// Re-exported for any existing caller importing pidIsAlive from this module
// directly — the fail-safe implementation itself now lives in
// scripts/lib/pid-alive.mjs, shared with scripts/reap-stale-batteries.mjs and
// scripts/stop-app.mjs rather than duplicated per-file.
export { pidIsAlive };

/**
 * Poll until `pid` exits or `timeoutMs` elapses. Pure-ish: `isAlive` and
 * `sleep` are injectable so the unit test drives it without real processes or
 * wall-clock waits. Resolves true if the process exited, false on timeout.
 */
export async function waitForExit({ pid, timeoutMs = 60000, intervalMs = 250, isAlive = pidIsAlive, sleep, now }) {
  const clock = now ?? (() => Date.now());
  const nap = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = clock() + timeoutMs;
  while (clock() < deadline) {
    if (!isAlive(pid)) return true;
    await nap(intervalMs);
  }
  return !isAlive(pid);
}

/** Whether a release left on disk can be relaunched on this Node: it is
 *  complete (its launch entry, a package.json and both npm installs, root and
 *  server/, which apply runs AFTER extracting, so a failed `npm ci` can leave
 *  a folder with the first two but no dependencies) and its OWN crash-range list
 *  does not refuse `version`. A missing list is a pre-guard release, which
 *  starts. A held-back release or a partial dir from a failed apply stays on
 *  disk, so choosing by directory name alone could pick one that cannot run. */
export function releaseCanStart(installRoot, release, version, platform) {
  const dir = join(installRoot, 'releases', `v${release}`);
  try {
    if (!existsSync(join(dir, 'scripts', 'start-app-prod.mjs'))) return false;
    // npm writes its hidden lockfile only when an install completes.
    for (const d of [dir, join(dir, 'server')]) {
      if (!existsSync(join(d, 'node_modules', '.package-lock.json'))) return false;
    }
    const list = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).castwright?.node?.windowsLoopbackCrash;
    if (list === undefined) return true;
    if (!Array.isArray(list)) return false;
    const ranges = list.filter((r) => !!r && typeof r.from === 'string' && typeof r.toExclusive === 'string');
    return !findCrashRange(version, platform, ranges);
  } catch {
    return false;
  }
}

/** The highest release dir under <installRoot>/releases other than `current`
 *  that `canStart` accepts, preferring one numerically below it (the one the
 *  user upgraded FROM). Returns the bare version ("1.15.0") or null. */
export function findPreviousRelease(installRoot, current, list = (d) => readdirSync(d), canStart = () => true) {
  let names;
  try {
    names = list(join(installRoot, 'releases'));
  } catch {
    return null;
  }
  const cur = parseNodeVersion(current);
  const found = [];
  for (const n of names) {
    const m = /^v(\d+\.\d+\.\d+)$/.exec(n);
    if (!m || m[1] === current || !canStart(m[1])) continue;
    found.push({ version: m[1], parts: parseNodeVersion(m[1]) });
  }
  const cmp = (a, b) => a.parts[0] - b.parts[0] || a.parts[1] - b.parts[1] || a.parts[2] - b.parts[2];
  found.sort(cmp);
  const below = cur ? found.filter((f) => cmp(f, { parts: cur }) < 0) : [];
  const pick = (below.length ? below : found).at(-1);
  return pick ? pick.version : null;
}

function writePointer(installRoot, version) {
  const pointer = join(installRoot, '.current-version');
  const tmp = `${pointer}.tmp`;
  writeFileSync(tmp, version, 'utf8');
  // renameSync replaces an existing file (Windows and POSIX), so the pointer
  // is never absent between the two calls. On Windows it fails with
  // EPERM/EACCES/EBUSY while the pointer is read-only or held open elsewhere:
  // clear the read-only bit and retry for about a second. Never delete first.
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, pointer);
      return;
    } catch (err) {
      if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(err?.code)) throw err;
      try {
        chmodSync(pointer, 0o666);
      } catch {
        /* retry regardless */
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

function writeUpgradeError(installRoot, candidateVersion, message) {
  const stateFile = join(installRoot, ...UPGRADE_STATE_PATH);
  mkdirSync(dirname(stateFile), { recursive: true });
  // The message names no host path, so the LAN twin is the same sentence.
  writeFileSync(stateFile, JSON.stringify({ phase: 'error', candidateVersion, error: message, errorLan: message }), 'utf8');
}

/**
 * Run the Node runtime guard against the release the pointer now names. On a
 * Node it would refuse (or when the check itself cannot run) switch the pointer
 * back to the previous release and record why in the upgrade state file.
 * Returns { action: 'proceed' | 'rolled-back' | 'no-fallback', reason?, to? }.
 * 'no-fallback' (no other release exists) still launches: the new release's own
 * launcher then refuses and logs it, which beats starting nothing at all.
 */
export function guardNewRelease({
  installRoot,
  version = process.version,
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
  loadRanges = loadCrashRanges,
  loadMinimum = loadNodeMinimum,
  log = () => {},
}) {
  // Off Windows neither this release nor its launcher can refuse, so a failed
  // list read must not hold the upgrade back there.
  if (platform !== 'win32') return { action: 'proceed' };
  let heldBack;
  try {
    const refusal = nodeRuntimeRefusal(version, platform, loadRanges(), loadMinimum(), env, execPath);
    if (!refusal) return { action: 'proceed' };
    heldBack = refusal;
  } catch (err) {
    // A fixed sentence: an fs error names a host path, and the state file is
    // served to LAN clients. The raw detail goes to the log only.
    log(`[restart] the Node check failed: ${err instanceof Error ? err.message : String(err)}\n`);
    heldBack = 'Castwright could not check that your Node can run the new release.';
  }
  let candidate;
  try {
    candidate = readFileSync(join(installRoot, '.current-version'), 'utf8').trim().replace(/^v/, '');
  } catch {
    return { action: 'no-fallback', reason: heldBack };
  }
  const previous = findPreviousRelease(installRoot, candidate, undefined, (r) => releaseCanStart(installRoot, r, version, platform));
  if (!previous) return { action: 'no-fallback', reason: heldBack };
  const reason = `Upgrade to v${candidate} was held back and you are still running v${previous}. ${heldBack}`;
  try {
    writePointer(installRoot, previous);
  } catch (err) {
    // Nothing was switched, so the launcher boots whatever the pointer names.
    log(`[restart] could not switch back to v${previous}, launching what the pointer names: ${err instanceof Error ? err.message : String(err)}\n`);
    return { action: 'no-fallback', reason: heldBack };
  }
  try {
    writeUpgradeError(installRoot, candidate, reason);
  } catch (err) {
    // The rollback itself stands; only the card's explanation is lost.
    log(`[restart] could not record the held-back upgrade: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  log(`[restart] ${reason}\n`);
  return { action: 'rolled-back', reason, to: previous };
}

/** Everything main() does, with its edges injectable for the unit test. */
export async function runRestart({
  env = process.env,
  version,
  platform,
  execPath,
  loadRanges,
  loadMinimum,
  guard = guardNewRelease,
  wait = waitForExit,
  spawnLauncher = (opts) => {
    const child = spawn(process.execPath, [opts.launcher], {
      cwd: opts.installRoot,
      env: process.env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  },
  stdout = (t) => process.stdout.write(t),
  stderr = (t) => process.stderr.write(t),
} = {}) {
  const oldPid = Number(env.UPGRADE_OLD_PID);
  const installRoot = env.UPGRADE_INSTALL_ROOT
    ? resolve(env.UPGRADE_INSTALL_ROOT)
    : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const timeoutMs = Number(env.UPGRADE_TIMEOUT_MS ?? 60000);
  const launcher = join(installRoot, 'launch.mjs');

  if (Number.isFinite(oldPid)) {
    stdout(`[restart] waiting for old server pid=${oldPid} to exit (<=${timeoutMs}ms)\n`);
    const exited = await wait({ pid: oldPid, timeoutMs });
    if (!exited) {
      stderr(`[restart] old server pid=${oldPid} still alive after ${timeoutMs}ms — launching anyway (start-app-prod will skip if the port is held)\n`);
    }
  }

  // The launcher ALWAYS spawns: an upgrade must never leave nothing running.
  let result;
  try {
    result = guard({ installRoot, version, platform, env, execPath, loadRanges, loadMinimum, log: stderr });
  } catch (err) {
    stderr(`[restart] the Node check failed, launching anyway: ${err instanceof Error ? err.message : String(err)}\n`);
    result = { action: 'proceed' };
  }

  stdout(`[restart] launching ${launcher}\n`);
  spawnLauncher({ launcher, installRoot });
  return result;
}

async function main() {
  await runRestart();
  process.exit(0);
}

// See scripts/lib/is-main-module.mjs — an un-realpathed comparison misses
// when the invocation crosses a symlink/junction (#2291).
const invokedDirectly = isDirectlyInvoked(import.meta.url);
if (invokedDirectly) main();
