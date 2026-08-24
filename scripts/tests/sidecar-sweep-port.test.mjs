// #2632 N27 — stop-app.ps1/.mjs used to hardcode :9000 in their orphan-sweep
// port list, which is now wrong for a worktree running its sidecar on a
// different LOCAL_TTS_PORT: the sweep (a force-kill in stop-app.ps1, a warn
// in stop-app.mjs) targeted the PRIMARY checkout's sidecar instead of this
// checkout's own. Fix: read the actual owned port from .run/tts.owner.json
// (server/src/tts/sidecar-owner.ts's SidecarOwnerNote), falling back to the
// factory default 9000 only when no note is present/readable.
//
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSidecarSweepPort } from '../lib/sidecar-sweep-port.mjs';

function withTempRunDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-port-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('resolveSidecarSweepPort returns the per-checkout port recorded in tts.owner.json', () => {
  withTempRunDir((dir) => {
    writeFileSync(
      join(dir, 'tts.owner.json'),
      JSON.stringify({ pid: 1234, ppid: 1, port: 9010, startedAt: '2026-08-25T00:00:00.000Z' }),
    );
    assert.equal(resolveSidecarSweepPort(dir), 9010);
  });
});

test('resolveSidecarSweepPort falls back to 9000 when tts.owner.json is absent', () => {
  withTempRunDir((dir) => {
    assert.equal(resolveSidecarSweepPort(dir), 9000);
  });
});

test('resolveSidecarSweepPort falls back to 9000 when tts.owner.json is corrupt JSON', () => {
  withTempRunDir((dir) => {
    writeFileSync(join(dir, 'tts.owner.json'), 'not valid json {{{');
    assert.equal(resolveSidecarSweepPort(dir), 9000);
  });
});

test('resolveSidecarSweepPort falls back to 9000 when the recorded port is out of range', () => {
  withTempRunDir((dir) => {
    writeFileSync(
      join(dir, 'tts.owner.json'),
      JSON.stringify({ pid: 1234, ppid: 1, port: 99999, startedAt: '2026-08-25T00:00:00.000Z' }),
    );
    assert.equal(resolveSidecarSweepPort(dir), 9000);
  });
});
