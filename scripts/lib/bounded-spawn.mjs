// scripts/lib/bounded-spawn.mjs — spawn a child with a hard wall-clock bound
// that FAILS LOUD AND NAMED instead of hanging silently (#3699).
//
// WHY NOT `spawnSync({ timeout })`. It signals only the immediate child. The
// pre-commit hook the e2e test drives spawns eslint as a grandchild; on a
// timeout that grandchild is orphaned (POSIX) or survives outright (Windows,
// where there is no process group to signal), still holding the test runner's
// stdio pipes open. And a bare `ETIMEDOUT` names neither the case that hung nor
// anything the child printed first — on a CI log whose output simply stops, that
// is the whole diagnostic gap #3699 recorded (macOS cross-os, 18 min of silence).
//
// So: async `spawn`, the child on its own process GROUP (POSIX `detached`),
// output accumulated as it arrives, and on the deadline the whole tree is
// killed (`taskkill /T /F` on Windows, SIGKILL to the negative pid elsewhere)
// before rejecting with the label and whatever stdout/stderr was captured.

import { spawn, spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';

/** Kill the whole tree rooted at `pid`. Best-effort: the child may already be
 *  gone, and a failed kill must not mask the timeout error being raised. */
function killTree(pid) {
  try {
    if (isWindows) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Already exited.
  }
}

/** Run `command args` and resolve `{ status, stdout, stderr }`.
 *
 *  Rejects with an Error naming `label`, the bound, and the stdout/stderr
 *  captured so far if the child outlives `timeoutMs`; the child's whole tree
 *  has been killed by the time the rejection is observed. A spawn error
 *  (ENOENT etc.) rejects with that error unchanged.
 *
 *  `options` are passed through to `spawn` (cwd, env, windowsHide). */
export function boundedSpawn(label, command, args, { timeoutMs, ...options }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      ...options,
      detached: !isWindows,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree(child.pid);
      reject(new Error(
        `HUNG: "${label}" did not exit within ${timeoutMs}ms — its process tree was killed.\n`
          + `stdout so far:\n${stdout}\nstderr so far:\n${stderr}`,
      ));
    }, timeoutMs);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ status, stdout, stderr });
    });
  });
}
