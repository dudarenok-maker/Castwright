// #4443 — enforceNodeRuntime is the one entry both the server boot module and
// scripts/start-app-prod.mjs call. The pure helpers are pinned by
// server/src/node-runtime-guard.test.ts; this pins the refuse/continue seam.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { enforceNodeRuntime } from '../lib/node-runtime-guard.mjs';

const SCRATCH = mkdtempSync(join(tmpdir(), 'nrg-default-'));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

function run(over) {
  const out = { stderr: [], exits: [], warns: [] };
  enforceNodeRuntime({
    env: {},
    logDir: join(SCRATCH, 'logs'),
    execPath: 'C:/Program Files/nodejs/node.exe',
    stderr: (t) => out.stderr.push(t),
    exit: (c) => out.exits.push(c),
    warn: (t) => out.warns.push(t),
    ...over,
  });
  return out;
}

test('Windows Node 24.15.0 writes the refusal to stderr and exits 1', () => {
  const o = run({ version: 'v24.15.0', platform: 'win32' });
  assert.deepEqual(o.exits, [1]);
  assert.match(o.stderr.join(''), /Install Node v24\.16\.0 or newer/);
});

test('a fixed Node, or any non-Windows platform, starts', () => {
  assert.deepEqual(run({ version: 'v24.16.0', platform: 'win32' }).exits, []);
  assert.deepEqual(run({ version: 'v24.15.0', platform: 'linux' }).exits, []);
});

test('an unreadable range list warns and continues', () => {
  const o = run({ version: 'v24.15.0', platform: 'win32', env: null });
  assert.deepEqual(o.exits, []);
  assert.equal(o.warns.length, 1);
});

// The in-app Upgrade & restart path (restart-after-upgrade.mjs -> launch.mjs ->
// start-app-prod.mjs) runs the launcher with stdio ignored, so the stderr line
// reaches nobody and the refusal returns before logDir exists. The refusal must
// also land in a file under logs/.
test('a refusal also lands in logs/node-refused.log, creating the folder', () => {
  const logDir = join(mkdtempSync(join(tmpdir(), 'nrg-')), 'logs');
  try {
    const o = run({ version: 'v24.15.0', platform: 'win32', logDir });
    assert.deepEqual(o.exits, [1]);
    const text = readFileSync(join(logDir, 'node-refused.log'), 'utf8');
    assert.match(text, /Install Node v24\.16\.0 or newer/);
  } finally {
    rmSync(join(logDir, '..'), { recursive: true, force: true });
  }
});

test('a fixed Node writes no refusal file', () => {
  const logDir = join(mkdtempSync(join(tmpdir(), 'nrg-')), 'logs');
  try {
    run({ version: 'v24.16.0', platform: 'win32', logDir });
    assert.equal(existsSync(join(logDir, 'node-refused.log')), false);
  } finally {
    rmSync(join(logDir, '..'), { recursive: true, force: true });
  }
});

test('an unwritable log folder does not stop the refusal', () => {
  const root = mkdtempSync(join(tmpdir(), 'nrg-'));
  try {
    const blocker = join(root, 'file');
    writeFileSync(blocker, 'x');
    const o = run({ version: 'v24.15.0', platform: 'win32', logDir: join(blocker, 'logs') });
    assert.deepEqual(o.exits, [1]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a launcher with stdio ignored (the in-app upgrade) still leaves the refusal on disk', () => {
  const root = mkdtempSync(join(tmpdir(), 'nrg-'));
  try {
    const guard = pathToFileURL(fileURLToPath(new URL('../lib/node-runtime-guard.mjs', import.meta.url))).href;
    const r = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { enforceNodeRuntime } from ${JSON.stringify(guard)};` +
          `enforceNodeRuntime({ version: 'v24.15.0', platform: 'win32' });`,
      ],
      { env: { ...process.env, APP_LOG_DIR: join(root, 'logs') }, stdio: 'ignore' },
    );
    assert.equal(r.status, 1);
    assert.match(readFileSync(join(root, 'logs', 'node-refused.log'), 'utf8'), /Install Node v24\.16\.0 or newer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
