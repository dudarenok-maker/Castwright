// #4443 — `npm run start:prod` is the documented single command. Its launcher
// runs on the same Node as the server and its first act (probePort) is a
// 127.0.0.1 connect, the exact call that fail-fasts on an affected Windows
// Node. So the launcher must refuse BEFORE any socket opens, on the console,
// reading the same package.json list as the server guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const launcher = resolve(here, '..', 'start-app-prod.mjs');
const realRefusalLog = resolve(here, '..', '..', 'logs', 'node-refused.log');
const preload = pathToFileURL(resolve(here, 'fixtures-node-guard-preload.mjs')).href;

const snapshotRealLog = () => (existsSync(realRefusalLog) ? readFileSync(realRefusalLog, 'utf8') : null);

test('start-app-prod.mjs on Windows Node 24.15.0 prints the refusal and exits 1 before any socket opens', () => {
  // APP_LOG_DIR keeps the refusal file out of the checkout's real logs/ (and out
  // of any APP_LOG_DIR the shell exports), where it would read as a real refusal.
  const logDir = mkdtempSync(join(tmpdir(), 'castwright-node-guard-'));
  const before = snapshotRealLog();
  try {
    const r = spawnSync(process.execPath, ['--import', preload, launcher], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      env: { ...process.env, CONDA_PREFIX: '', APP_LOG_DIR: logDir },
    });
    assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stderr, /Castwright can.t start on Node v24\.15\.0 on Windows/);
    assert.match(r.stderr, /Install Node v24\.16\.0 or newer/);
    assert.doesNotMatch(r.stderr, /SOCKET-OPENED/);
    assert.match(readFileSync(join(logDir, 'node-refused.log'), 'utf8'), /Install Node v24\.16\.0 or newer/);
    assert.equal(snapshotRealLog(), before, 'the refusal must not land in the checkout logs/');
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});
