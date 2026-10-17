// scripts/tests/bounded-spawn.test.mjs — pins scripts/lib/bounded-spawn.mjs
// (#3699): a hung child must fail FAST, NAME the case, show what it printed,
// and leave no surviving grandchild.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundedSpawn } from '../lib/bounded-spawn.mjs';
import { pidIsAlive } from '../lib/pid-alive.mjs';

const BOUND_MS = 1_500;

// A child that prints, spawns a grandchild that records its pid, then both
// sleep forever — the shape of the hook (parent) + eslint (grandchild).
function hungChildSource(pidFile) {
  return `
    const { spawn } = require('node:child_process');
    const g = spawn(process.execPath, ['-e',
      "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)",
      ${JSON.stringify(pidFile)}], { stdio: 'ignore' });
    process.stdout.write('before-the-hang\\n');
    process.stderr.write('stderr-before-the-hang\\n');
    setInterval(() => {}, 1000);
  `;
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
    rmSync(dir, { recursive: true, force: true });
  }
});

test('boundedSpawn: a child that exits in time resolves status/stdout/stderr (control)', async () => {
  const r = await boundedSpawn('case: healthy', process.execPath, [
    '-e', "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)",
  ], { timeoutMs: 30_000 });
  assert.deepEqual(r, { status: 3, stdout: 'out', stderr: 'err' });
});
