// Pin the prod launcher's port/protocol selection so it can never again
// false-FAIL by health-checking :8080 while the server binds LAN HTTPS on
// :8443. resolveLaunchTarget must mirror server/src/index.ts's EFFECTIVE-LAN
// check: LAN is requested unless LAN_HTTPS=0 (production default, since the
// launcher always spawns NODE_ENV=production) AND takes effect only when certs
// are present (2nd arg); otherwise the server degrades to loopback HTTP :8080.
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).
//
// Importing start-app-prod.mjs must NOT spawn the server — the module guards
// main() behind an invoked-directly check, so importing only the pure helper
// is side-effect-free.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLaunchTarget } from '../start-app-prod.mjs';

test('prod default (certs present, no LAN_HTTPS) → https on :8443', () => {
  assert.deepEqual(resolveLaunchTarget({}, true), {
    lanHttps: true,
    port: 8443,
    protocol: 'https',
  });
});

test('LAN requested but certs MISSING → server falls back to http :8080, launcher follows', () => {
  assert.deepEqual(resolveLaunchTarget({}, false), {
    lanHttps: false,
    port: 8080,
    protocol: 'http',
  });
  // Even an explicit LAN_HTTPS=1 can't bind HTTPS without certs.
  assert.equal(resolveLaunchTarget({ LAN_HTTPS: '1' }, false).lanHttps, false);
});

test('LAN_HTTPS=1 + certs → https on :8443', () => {
  assert.deepEqual(resolveLaunchTarget({ LAN_HTTPS: '1' }, true), {
    lanHttps: true,
    port: 8443,
    protocol: 'https',
  });
});

test('explicit LAN_HTTPS=0 opts out → http :8080 even with certs present', () => {
  const t = resolveLaunchTarget({ LAN_HTTPS: '0' }, true);
  assert.equal(t.lanHttps, false);
  assert.equal(t.port, 8080);
  assert.equal(t.protocol, 'http');
});

test('PORT overrides the loopback HTTP port (LAN off)', () => {
  const t = resolveLaunchTarget({ LAN_HTTPS: '0', PORT: '9999' }, true);
  assert.equal(t.port, 9999);
  assert.equal(t.protocol, 'http');
});

test('LAN_HTTPS_PORT overrides the LAN HTTPS port; PORT is ignored in LAN mode', () => {
  const t = resolveLaunchTarget({ LAN_HTTPS: '1', LAN_HTTPS_PORT: '9443', PORT: '8080' }, true);
  assert.equal(t.port, 9443);
  assert.equal(t.protocol, 'https');
});

test('defaults to process.env + certsPresent=true when called with no argument', () => {
  const saved = { LAN_HTTPS: process.env.LAN_HTTPS, PORT: process.env.PORT };
  try {
    delete process.env.LAN_HTTPS;
    delete process.env.PORT;
    assert.equal(resolveLaunchTarget().port, 8443); // prod default + certs assumed present
    process.env.LAN_HTTPS = '0';
    assert.equal(resolveLaunchTarget().port, 8080);
  } finally {
    if (saved.LAN_HTTPS === undefined) delete process.env.LAN_HTTPS;
    else process.env.LAN_HTTPS = saved.LAN_HTTPS;
    if (saved.PORT === undefined) delete process.env.PORT;
    else process.env.PORT = saved.PORT;
  }
});

import { bannerLine, formatBuildManifestLine } from '../start-app-prod.mjs';

test('bannerLine renders the Castwright banner with the version', () => {
  assert.equal(
    bannerLine('1.6.0'),
    'Castwright v1.6.0 — Any book, performed by a full cast.',
  );
});

test('formatBuildManifestLine renders sha/branch/build-time from a clean manifest', () => {
  const iso = '2026-07-03T12:00:00.000Z';
  const line = formatBuildManifestLine({
    version: '1.9.0',
    sha: 'c6d058f2',
    branch: 'main',
    dirty: false,
    buildTime: iso,
  });
  assert.equal(line, `[BUILD] c6d058f2 (main) — built ${new Date(iso).toLocaleString()}`);
});

test('formatBuildManifestLine marks a dirty-tree build with a trailing *', () => {
  const line = formatBuildManifestLine({
    sha: 'c6d058f2',
    branch: 'main',
    dirty: true,
    buildTime: '2026-07-03T12:00:00.000Z',
  });
  assert.match(line, /^\[BUILD\] c6d058f2\*/);
});

test('formatBuildManifestLine falls back to a clear message when the manifest is missing', () => {
  assert.equal(
    formatBuildManifestLine(null),
    '[BUILD] unknown — build-manifest.json missing, run "npm run build" to populate it',
  );
});
