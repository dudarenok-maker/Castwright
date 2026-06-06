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
     UPGRADE_TIMEOUT_MS    max wait for the old PID to exit (default 60000) */

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** True while `pid` is still alive. `process.kill(pid, 0)` throws ESRCH once
    it's gone (EPERM means alive-but-not-ours → still alive). */
export function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

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

async function main() {
  const oldPid = Number(process.env.UPGRADE_OLD_PID);
  const installRoot = process.env.UPGRADE_INSTALL_ROOT
    ? resolve(process.env.UPGRADE_INSTALL_ROOT)
    : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const timeoutMs = Number(process.env.UPGRADE_TIMEOUT_MS ?? 60000);
  const launcher = join(installRoot, 'launch.mjs');

  if (Number.isFinite(oldPid)) {
    process.stdout.write(`[restart] waiting for old server pid=${oldPid} to exit (<=${timeoutMs}ms)\n`);
    const exited = await waitForExit({ pid: oldPid, timeoutMs });
    if (!exited) {
      process.stderr.write(`[restart] old server pid=${oldPid} still alive after ${timeoutMs}ms — launching anyway (start-app-prod will skip if the port is held)\n`);
    }
  }

  process.stdout.write(`[restart] launching ${launcher}\n`);
  const child = spawn(process.execPath, [launcher], {
    cwd: installRoot,
    env: process.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  process.exit(0);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main();
