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
        return true;
      },
    );
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
