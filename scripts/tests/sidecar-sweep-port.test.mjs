// #2632 N27/N29 — stop-app.ps1/.mjs used to hardcode :9000 in their
// orphan-sweep port list, which is wrong for a worktree running its sidecar
// on a different LOCAL_TTS_PORT: the sweep (a force-kill in stop-app.ps1, a
// warn in stop-app.mjs) targeted the PRIMARY checkout's sidecar instead of
// this checkout's own. Fix: read the actual owned port from
// .run/tts.owner.json (server/src/tts/sidecar-owner.ts's SidecarOwnerNote).
//
// N29: the note is absent in three routine states (after a clean shutdown,
// with autoStartSidecar off, or before a sidecar has ever claimed ownership
// this run) — falling back to the factory default 9000 there is itself the
// hazard, since 9000 is exactly the port a DIFFERENT checkout's sidecar is
// likely to own. So the fallback instead reads LOCAL_TTS_PORT out of this
// checkout's own server/.env, and only sweeps nothing (returns null) when
// that is unavailable too.
//
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSidecarSweepPort } from '../lib/sidecar-sweep-port.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function withTempRunDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-port-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withTempServerEnv(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-port-env-'));
  const envPath = join(dir, '.env');
  try {
    if (contents !== null) writeFileSync(envPath, contents);
    return fn(envPath);
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
    withTempServerEnv('LOCAL_TTS_PORT=9020\n', (envPath) => {
      // The live owner note wins over server/.env when both are present.
      assert.equal(resolveSidecarSweepPort(dir, envPath), 9010);
    });
  });
});

test('resolveSidecarSweepPort falls back to server/.env LOCAL_TTS_PORT when tts.owner.json is absent', () => {
  withTempRunDir((dir) => {
    withTempServerEnv('PORT=8080\nLOCAL_TTS_PORT=9030\n', (envPath) => {
      assert.equal(resolveSidecarSweepPort(dir, envPath), 9030);
    });
  });
});

test('resolveSidecarSweepPort falls back to server/.env LOCAL_TTS_PORT when tts.owner.json is corrupt JSON', () => {
  withTempRunDir((dir) => {
    writeFileSync(join(dir, 'tts.owner.json'), 'not valid json {{{');
    withTempServerEnv('LOCAL_TTS_PORT=9040\n', (envPath) => {
      assert.equal(resolveSidecarSweepPort(dir, envPath), 9040);
    });
  });
});

test('resolveSidecarSweepPort falls back to server/.env LOCAL_TTS_PORT when the recorded port is out of range', () => {
  withTempRunDir((dir) => {
    writeFileSync(
      join(dir, 'tts.owner.json'),
      JSON.stringify({ pid: 1234, ppid: 1, port: 99999, startedAt: '2026-08-25T00:00:00.000Z' }),
    );
    withTempServerEnv('LOCAL_TTS_PORT=9050\n', (envPath) => {
      assert.equal(resolveSidecarSweepPort(dir, envPath), 9050);
    });
  });
});

test('resolveSidecarSweepPort returns null (sweep nothing) when neither the note nor server/.env yield a port', () => {
  withTempRunDir((dir) => {
    withTempServerEnv(null, (envPath) => {
      assert.equal(resolveSidecarSweepPort(dir, envPath), null);
    });
  });
});

test('resolveSidecarSweepPort returns null when server/.env has no LOCAL_TTS_PORT line', () => {
  withTempRunDir((dir) => {
    withTempServerEnv('PORT=8080\nWORKSPACE_DIR=../workspace\n', (envPath) => {
      assert.equal(resolveSidecarSweepPort(dir, envPath), null);
    });
  });
});

test('resolveSidecarSweepPort never returns the factory-default 9000 as a guess', () => {
  // #2632 N29: 9000 is exactly the value most likely to belong to a
  // DIFFERENT checkout's sidecar, so it must never come back as a blind
  // fallback — only as an explicit, sourced value.
  withTempRunDir((dir) => {
    withTempServerEnv(null, (envPath) => {
      assert.notEqual(resolveSidecarSweepPort(dir, envPath), 9000);
    });
    assert.notEqual(resolveSidecarSweepPort(dir), 9000);
  });
});

// #2632 N29 — call-site coverage. Pass 6 noted that reverting stop-app.mjs's
// `ttsPort` back to a literal 9000 leaves the helper-level tests above green,
// because none of them exercise the call site. Read the real source text so
// this fails if that call site regresses.
test('stop-app.mjs computes ttsPort via resolveSidecarSweepPort, not a literal 9000', () => {
  const source = readFileSync(resolve(__dirname, '..', 'stop-app.mjs'), 'utf8');
  assert.match(
    source,
    /const ttsPort = resolveSidecarSweepPort\(runDir, serverEnvPath\);/,
    'stop-app.mjs must derive ttsPort from resolveSidecarSweepPort(runDir, serverEnvPath)',
  );
  assert.doesNotMatch(
    source,
    /const ttsPort = 9000;/,
    'stop-app.mjs must not hardcode ttsPort to the factory default 9000',
  );
});
