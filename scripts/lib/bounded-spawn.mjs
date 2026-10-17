// scripts/lib/bounded-spawn.mjs — spawn a child with a hard wall-clock bound
// that FAILS LOUD AND NAMED instead of hanging silently (#3699).
//
// WHY NOT `spawnSync({ timeout })`. It signals only the immediate child. The
// pre-commit hook the e2e test drives spawns eslint as a grandchild; on a
// timeout that grandchild is orphaned (POSIX) or left running (a descendant
// that escaped libuv's job object, e.g. a `detached` one), still holding the
// test runner's stdio pipes open. And a bare `ETIMEDOUT` names neither the case
// that hung nor anything the child printed first — on a CI log whose output
// simply stops, that is the whole diagnostic gap #3699 recorded (macOS
// cross-os, 18 min of silence). A blocking `spawnSync` also freezes the event
// loop, so no timer — this one or node:test's — can fire while it waits.
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
 *  captured so far if the run outlives `timeoutMs`. If the root is still alive
 *  its whole tree has been killed by the time the rejection is observed; if the
 *  root already exited but a descendant kept the output pipes open, the message
 *  says so (on Windows the dead root's pid is NOT signalled — it may have been
 *  reused). A spawn error (ENOENT etc.) rejects with that error unchanged.
 *
 *  `options` are passed through to `spawn` (cwd, env). `input`, if given, is
 *  written to the child's stdin; otherwise stdin is closed. `windowsHide` is
 *  always set — a literal below, because spawn-windows-hide.test.ts is
 *  syntactic and cannot see it arriving through `...options`. */
export function boundedSpawn(label, command, args, { timeoutMs, input, ...options }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      ...options,
      windowsHide: true,
      detached: !isWindows,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let rootExited = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    if (input !== undefined) child.stdin.end(input);

    child.on('exit', () => { rootExited = true; });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // POSIX: the group id outlives the root while any member does, so the
      // group kill is safe either way. Windows: a dead root's pid may be reused.
      const canKill = !rootExited || !isWindows;
      if (canKill) killTree(child.pid);
      const what = rootExited
        ? 'the root exited, but its output pipes stayed open — a descendant escaped'
          + (canKill ? ' (its process group was killed)' : ' and could NOT be killed')
        : 'its process tree was killed';
      reject(new Error(
        `HUNG: "${label}" did not exit within ${timeoutMs}ms — ${what}.\n`
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

/** Circuit breaker over `boundedSpawn` calls: once one run has HUNG, every later
 *  `run` is refused up front naming the first culprit, so one hang costs one
 *  bound rather than one per remaining case (#3699: 7 x 300s outran the job
 *  cap). `run(label, fn)` awaits `fn()` and trips on a `HUNG: ` rejection. */
export function createHangBreaker() {
  let hungLabel = null;
  return {
    async run(label, fn) {
      if (hungLabel) {
        throw new Error(`"${label}" not run: an earlier spawn already hung ("${hungLabel}")`);
      }
      try {
        return await fn();
      } catch (err) {
        if (/^HUNG: /.test(err.message)) hungLabel = label;
        throw err;
      }
    },
  };
}
