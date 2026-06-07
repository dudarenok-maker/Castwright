// Pin the prod launcher's port/protocol selection so it can never again
// false-FAIL by health-checking :8080 while the server binds LAN HTTPS on
// :8443. resolveLaunchTarget must mirror server/src/index.ts (PORT ?? 8080,
// LAN_HTTPS_PORT ?? 8443) + routes/export-lan.ts (LAN_HTTPS === '1').
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).
//
// Importing start-app-prod.mjs must NOT spawn the server — the module guards
// main() behind an invoked-directly check, so importing only the pure helper
// is side-effect-free.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLaunchTarget } from '../start-app-prod.mjs';

test('loopback prod: no LAN_HTTPS → http on :8080', () => {
  assert.deepEqual(resolveLaunchTarget({}), {
    lanHttps: false,
    port: 8080,
    protocol: 'http',
  });
});

test('LAN_HTTPS=1 → https on :8443 (the bug: launcher must wait here, not :8080)', () => {
  assert.deepEqual(resolveLaunchTarget({ LAN_HTTPS: '1' }), {
    lanHttps: true,
    port: 8443,
    protocol: 'https',
  });
});

test('only the exact string "1" enables LAN (matches isLanHttpsEnabled)', () => {
  for (const v of ['0', 'true', 'yes', '', 'TRUE']) {
    assert.equal(resolveLaunchTarget({ LAN_HTTPS: v }).lanHttps, false, `LAN_HTTPS=${v}`);
  }
});

test('PORT overrides the loopback HTTP port', () => {
  const t = resolveLaunchTarget({ PORT: '9999' });
  assert.equal(t.port, 9999);
  assert.equal(t.protocol, 'http');
});

test('LAN_HTTPS_PORT overrides the LAN HTTPS port; PORT is ignored in LAN mode', () => {
  const t = resolveLaunchTarget({ LAN_HTTPS: '1', LAN_HTTPS_PORT: '9443', PORT: '8080' });
  assert.equal(t.port, 9443);
  assert.equal(t.protocol, 'https');
});

test('defaults to process.env when called with no argument', () => {
  const saved = { LAN_HTTPS: process.env.LAN_HTTPS, PORT: process.env.PORT };
  try {
    delete process.env.LAN_HTTPS;
    delete process.env.PORT;
    assert.equal(resolveLaunchTarget().port, 8080);
    process.env.LAN_HTTPS = '1';
    assert.equal(resolveLaunchTarget().port, 8443);
  } finally {
    if (saved.LAN_HTTPS === undefined) delete process.env.LAN_HTTPS;
    else process.env.LAN_HTTPS = saved.LAN_HTTPS;
    if (saved.PORT === undefined) delete process.env.PORT;
    else process.env.PORT = saved.PORT;
  }
});
