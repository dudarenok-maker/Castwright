// scripts/tests/bounded-spawn.test.mjs — pins scripts/lib/bounded-spawn.mjs
// (#3699): a hung child must fail FAST, NAME the case, show what it printed,
// and leave no surviving grandchild.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundedSpawn, createHangBreaker } from '../lib/bounded-spawn.mjs';
import { pidIsAlive } from '../lib/pid-alive.mjs';

const BOUND_MS = 1_500;

// A child that prints, spawns a grandchild that records its pid, then both
// sleep forever — the shape of the hook (parent) + eslint (grandchild).
//
// The grandchild is `detached` on Windows: libuv puts every NON-detached child
// in a job object that dies with its parent's handle, so an attached grandchild
// is reaped no matter what killTree does and the assertion could not fail for
// the mechanism it claims (mutants `child.kill('SIGKILL')` / taskkill without
// /T stayed green). Detached escapes the job; on POSIX it stays in the child's
// process group, which is what the group kill must reach.
function hungChildSource(pidFile) {
  return `
    const { spawn } = require('node:child_process');
    const g = spawn(process.execPath, ['-e',
      "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)",
      ${JSON.stringify(pidFile)}], { stdio: 'ignore', detached: process.platform === 'win32' });
    process.stdout.write('before-the-hang\\n');
    process.stderr.write('stderr-before-the-hang\\n');
    setInterval(() => {}, 1000);
  `;
}

/** Kill the fixture grandchild a (possibly failed) test left behind. */
function reapPidFile(pidFile) {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8'));
    if (pid && pidIsAlive(pid)) process.kill(pid, 'SIGKILL');
  } catch {
    // never started, or already gone
  }
}

async function waitFor(pred, ms = 5_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

test('boundedSpawn: a hung child rejects within the bound, names the case, shows its output, and its grandchild is killed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bounded-spawn-'));
  const pidFile = join(dir, 'grandchild.pid');
  try {
    const started = Date.now();
    await assert.rejects(
      boundedSpawn('case: the hung one', process.execPath, ['-e', hungChildSource(pidFile)], {
        timeoutMs: BOUND_MS,
      }),
      (err) => {
        assert.match(err.message, /HUNG: "case: the hung one"/);
        assert.match(err.message, new RegExp(`${BOUND_MS}ms`));
        assert.match(err.message, /before-the-hang/);
        assert.match(err.message, /stderr-before-the-hang/);
        return true;
      },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < BOUND_MS + 3_000, `must fail near the bound, took ${elapsed}ms`);

    assert.ok(await waitFor(() => existsSync(pidFile)), 'fixture grandchild never started');
    const grandchildPid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(
      await waitFor(() => !pidIsAlive(grandchildPid)),
      `grandchild ${grandchildPid} survived the timeout kill`,
    );
  } finally {
    reapPidFile(pidFile);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('boundedSpawn: root exited but a descendant holds the pipes open — says so, does not claim the tree was killed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bounded-spawn-'));
  const pidFile = join(dir, 'escaped.pid');
  // Root spawns a DETACHED grandchild that inherits stdout/stderr, then exits.
  // The pipes stay open, so `close` never fires; `exit` does.
  const rootSource = `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e',
      "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)",
      ${JSON.stringify(pidFile)}], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref();
    process.stdout.write('root-output\\n');
  `;
  try {
    await assert.rejects(
      boundedSpawn('case: escaped descendant', process.execPath, ['-e', rootSource], { timeoutMs: BOUND_MS }),
      (err) => {
        assert.match(err.message, /HUNG: "case: escaped descendant"/);
        assert.match(err.message, /root exited, but its output pipes stayed open/);
        assert.doesNotMatch(err.message, /process tree was killed/);
        assert.match(err.message, /root-output/);
        // The tail reports what the kill actually did. Windows never signals a
        // dead root's pid (it may be reused); a taskkill on it would fail and
        // read differently. POSIX: the detached grandchild left the root's
        // group, so the group is empty and the message must NOT claim a kill.
        if (process.platform === 'win32') {
          assert.match(err.message, /and could NOT be killed/);
        } else {
          assert.match(err.message, /already empty — nothing was killed/);
          assert.doesNotMatch(err.message, /process group was killed/);
        }
        return true;
      },
    );
  } finally {
    reapPidFile(pidFile);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('boundedSpawn: a child that exits without draining a large input resolves with its own status (no unhandled stdin error)', async () => {
  const r = await boundedSpawn('case: undrained stdin', process.execPath, ['-e', 'process.exit(3)'], {
    timeoutMs: 20_000,
    input: 'x'.repeat(2_000_000),
  });
  assert.equal(r.status, 3);
});

test('boundedSpawn: after a HUNG rejection the host can exit (parent pipe ends released)', async () => {
  // Run in a fresh node process: the escaped descendant lives ~30s, the host
  // must exit well before that rather than wait on the pipes it still holds.
  const dir = mkdtempSync(join(tmpdir(), 'bounded-spawn-'));
  const pidFile = join(dir, 'escaped.pid');
  const libUrl = new URL('../lib/bounded-spawn.mjs', import.meta.url).href;
  const host = `
    import { boundedSpawn } from ${JSON.stringify(libUrl)};
    const root = \`
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e',
        "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 30000)",
        \${JSON.stringify(${JSON.stringify(pidFile)})}], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref();
    \`;
    await boundedSpawn('host', process.execPath, ['-e', root], { timeoutMs: 1000 }).catch(() => {});
  `;
  try {
    const started = Date.now();
    const r = await boundedSpawn('case: host exit', process.execPath, ['--input-type=module', '-e', host], {
      timeoutMs: 20_000,
    });
    const elapsed = Date.now() - started;
    assert.equal(r.status, 0, r.stderr);
    assert.ok(elapsed < 15_000, `host lingered ${elapsed}ms on the escaped descendant's pipes`);
  } finally {
    reapPidFile(pidFile);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('boundedSpawn: input is written to stdin', async () => {
  const r = await boundedSpawn('case: stdin', process.execPath, [
    '-e', "process.stdin.on('data', (d) => process.stdout.write(String(d).toUpperCase()))",
  ], { timeoutMs: 30_000, input: 'abc' });
  assert.deepEqual(r, { status: 0, stdout: 'ABC', stderr: '' });
});

test('createHangBreaker: after one HUNG rejection, later runs are refused naming the first culprit', async () => {
  const breaker = createHangBreaker();
  assert.equal(await breaker.run('a', async () => 'ok'), 'ok');
  // A non-HUNG failure must not trip it.
  await assert.rejects(breaker.run('b', async () => { throw new Error('ordinary'); }), /ordinary/);
  assert.equal(await breaker.run('c', async () => 'still ok'), 'still ok');
  await assert.rejects(breaker.run('d', async () => { throw new Error('HUNG: "d" did not exit'); }), /HUNG: "d"/);
  let ran = false;
  await assert.rejects(
    breaker.run('e', async () => { ran = true; }),
    /"e" not run: an earlier spawn already hung \("d"\)/,
  );
  assert.equal(ran, false);
});

test('boundedSpawn: a child that exits in time resolves status/stdout/stderr (control)', async () => {
  const r = await boundedSpawn('case: healthy', process.execPath, [
    '-e', "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)",
  ], { timeoutMs: 30_000 });
  assert.deepEqual(r, { status: 3, stdout: 'out', stderr: 'err' });
});
