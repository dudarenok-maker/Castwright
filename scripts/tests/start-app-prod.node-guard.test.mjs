// #4443 — `npm run start:prod` is the documented single command. Its launcher
// runs on the same Node as the server and its first act (probePort) is a
// 127.0.0.1 connect, the exact call that fail-fasts on an affected Windows
// Node. So the launcher must refuse BEFORE any socket opens, on the console,
// reading the same package.json list as the server guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const launcher = resolve(here, '..', 'start-app-prod.mjs');
const preload = pathToFileURL(resolve(here, 'fixtures-node-guard-preload.mjs')).href;

test('start-app-prod.mjs on Windows Node 24.15.0 prints the refusal and exits 1 before any socket opens', () => {
  const r = spawnSync(process.execPath, ['--import', preload, launcher], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, CONDA_PREFIX: '' },
  });
  assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`);
  assert.match(r.stderr, /Castwright can.t start on Node v24\.15\.0 on Windows/);
  assert.match(r.stderr, /Install Node v24\.16\.0 or newer/);
  assert.doesNotMatch(r.stderr, /SOCKET-OPENED/);
});
