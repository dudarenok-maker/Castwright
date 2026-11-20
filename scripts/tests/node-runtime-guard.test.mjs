// #4443 — enforceNodeRuntime is the one entry both the server boot module and
// scripts/start-app-prod.mjs call. The pure helpers are pinned by
// server/src/node-runtime-guard.test.ts; this pins the refuse/continue seam.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceNodeRuntime } from '../lib/node-runtime-guard.mjs';

function run(over) {
  const out = { stderr: [], exits: [], warns: [] };
  enforceNodeRuntime({
    env: {},
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
