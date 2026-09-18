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
import http from 'node:http';
import {
  resolveLaunchTarget,
  isOwnServerInstance,
  waitForOwnServer,
  scanForOwnServer,
  defaultNormalizePathForCompare,
} from '../start-app-prod.mjs';

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

// Castwright#3030 — the launcher's "already running" liveness check must
// distinguish THIS worktree's own server from a sibling worktree's (or any
// other install's) server that happens to answer on a probed port, using the
// /api/health configLoad.runDir field the server stamps at boot. Comparison
// is injectable (`normalize`) so these pin behaviour without touching the
// real filesystem — see defaultNormalizePathForCompare's own tests below for
// the real realpath+case-fold implementation.
const identity = (p) => p; // no-op normalize for tests that don't care about path folding

test('isOwnServerInstance: matching runDir is this worktree\'s own server', () => {
  assert.equal(
    isOwnServerInstance({ configLoad: { runDir: '/repo/.run' } }, '/repo/.run', { normalize: identity }),
    true,
  );
});

test('isOwnServerInstance: a sibling worktree\'s server (different runDir) is NOT this instance', () => {
  assert.equal(
    isOwnServerInstance({ configLoad: { runDir: '/other-worktree/.run' } }, '/repo/.run', { normalize: identity }),
    false,
  );
});

test('isOwnServerInstance: missing configLoad (unexpected /api/health shape) is NOT this instance', () => {
  assert.equal(isOwnServerInstance({}, '/repo/.run', { normalize: identity }), false);
  assert.equal(isOwnServerInstance(null, '/repo/.run', { normalize: identity }), false);
});

// Castwright#3030 round 2 (finding F2) — an fs-1 upgrade restart launches the
// NEW release while the OLD release's server may still be shutting down. The
// two releases have DIFFERENT server/ cwd but the SAME runDir (APP_RUN_DIR is
// set identically across every release of one install), so the old server
// must still be recognized as this install's own.
test('isOwnServerInstance: same runDir across different release directories (upgrade restart) IS this install', () => {
  assert.equal(
    isOwnServerInstance(
      { configLoad: { cwd: '/srv/audiobook/releases/v1.14.0/server', runDir: '/srv/audiobook/.run' } },
      '/srv/audiobook/.run',
      { normalize: identity },
    ),
    true,
  );
});

test('isOwnServerInstance: uses the injected normalize on BOTH sides (case-insensitive win32 stand-in)', () => {
  const foldCase = (p) => p.toLowerCase();
  assert.equal(
    isOwnServerInstance({ configLoad: { runDir: 'C:\\Repo\\.run' } }, 'c:\\repo\\.run', { normalize: foldCase }),
    true,
  );
});

test('defaultNormalizePathForCompare: on win32, folds case; elsewhere, exact', () => {
  const a = defaultNormalizePathForCompare('C:\\Nonexistent\\Path\\.run');
  const b = defaultNormalizePathForCompare('c:\\nonexistent\\path\\.run');
  if (process.platform === 'win32') {
    assert.equal(a, b);
  } else {
    assert.notEqual(a, b);
  }
});

// Castwright#3030 round 2 (finding F1) — once a rebind is possible, the
// launcher must confirm success by IDENTITY (this worktree's own runDir
// answering /api/health), not by a bare TCP-connect to an assumed port: per
// the srv-60 auto-rebind design doc, the actual bound port is the single
// source of truth every consumer must read. These spin up real HTTP servers
// (plain http, not TLS) answering /api/health with a controllable
// configLoad.runDir, exactly the shape probeServed()/getJson() parse.
function makeHealthServer(runDir) {
  return http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, configLoad: { runDir } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

async function listenOnFreePort(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server.address().port;
}

test('waitForOwnServer: resolves immediately when OUR OWN server already answers on startPort', async () => {
  const server = makeHealthServer('/repo/.run');
  const port = await listenOnFreePort(server);
  try {
    const found = await waitForOwnServer({
      startPort: port,
      maxPorts: 1,
      timeoutMs: 2000,
      lanHttps: false,
      runDir: '/repo/.run',
    });
    assert.equal(found, port);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// Castwright#3030 round 3 (finding N2) — maxPorts=1 is a DELIBERATE bare
// TCP-connect, exactly matching this launcher's pre-#3030 behaviour, so the
// ordinary (no-foreign-occupant) boot path never depends on probeServed's
// TLS-cert resolution (findRootCa()). Identity confirmation is reserved for
// maxPorts>1, which main() only ever uses once it has independently
// established a rebind is genuinely possible.
test('waitForOwnServer: maxPorts=1 resolves on ANY listener, even a foreign one (deliberate — see N2)', async () => {
  const server = makeHealthServer('/other-worktree/.run');
  const port = await listenOnFreePort(server);
  try {
    const found = await waitForOwnServer({
      startPort: port,
      maxPorts: 1,
      timeoutMs: 300,
      lanHttps: false,
      runDir: '/repo/.run',
    });
    assert.equal(found, port);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// scanForOwnServer is the identity-confirming primitive waitForOwnServer
// uses internally for maxPorts>1, and main() also uses it directly for the
// pre-spawn "is a stale copy of MY OWN server already rebound somewhere in
// this range" check (Castwright#3030 round 3, finding N1).
test('scanForOwnServer: a single pass over a FOREIGN-only range finds nothing (no polling, no false positive)', async () => {
  const server = makeHealthServer('/other-worktree/.run');
  const port = await listenOnFreePort(server);
  try {
    const found = await scanForOwnServer(port, 1, false, '/repo/.run');
    assert.equal(found, null);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('scanForOwnServer: finds OUR OWN server anywhere in the range on the first pass', async () => {
  const foreign = makeHealthServer('/other-worktree/.run');
  const startPort = await listenOnFreePort(foreign);
  const own = makeHealthServer('/repo/.run');
  await new Promise((r) => own.listen(startPort + 1, '127.0.0.1', r));
  try {
    const found = await scanForOwnServer(startPort, 3, false, '/repo/.run');
    assert.equal(found, startPort + 1);
  } finally {
    await Promise.all([
      new Promise((r) => foreign.close(r)),
      new Promise((r) => own.close(r)),
    ]);
  }
});

test('scanForOwnServer: an already-elapsed deadline aborts before probing the next candidate', async () => {
  const own = makeHealthServer('/repo/.run');
  const port = await listenOnFreePort(own);
  try {
    // Deadline already in the past — the very first candidate must be skipped.
    const found = await scanForOwnServer(port, 1, false, '/repo/.run', Date.now() - 1);
    assert.equal(found, null);
  } finally {
    await new Promise((r) => own.close(r));
  }
});

test('waitForOwnServer: scans past a foreign occupant to find OUR OWN server on a rebound port', async () => {
  const foreign = makeHealthServer('/other-worktree/.run');
  const startPort = await listenOnFreePort(foreign);
  const own = makeHealthServer('/repo/.run');
  await new Promise((r) => own.listen(startPort + 1, '127.0.0.1', r));
  try {
    const found = await waitForOwnServer({
      startPort,
      maxPorts: 3,
      timeoutMs: 2000,
      lanHttps: false,
      runDir: '/repo/.run',
    });
    assert.equal(found, startPort + 1);
  } finally {
    await Promise.all([
      new Promise((r) => foreign.close(r)),
      new Promise((r) => own.close(r)),
    ]);
  }
});

test('waitForOwnServer: maxPorts=1 times out when nothing listens at startPort', async () => {
  const probe = http.createServer();
  const port = await listenOnFreePort(probe);
  await new Promise((r) => probe.close(r));
  const found = await waitForOwnServer({
    startPort: port,
    maxPorts: 1,
    timeoutMs: 300,
    lanHttps: false,
    runDir: '/repo/.run',
  });
  assert.equal(found, null);
});

test('waitForOwnServer: returns null when nothing answers anywhere in range', async () => {
  // Bind + immediately release a port so we know a moment ago it was free;
  // nothing listens there for the whole test, so every candidate refuses.
  const probe = http.createServer();
  const startPort = await listenOnFreePort(probe);
  await new Promise((r) => probe.close(r));
  const found = await waitForOwnServer({
    startPort,
    maxPorts: 2,
    timeoutMs: 300,
    lanHttps: false,
    runDir: '/repo/.run',
  });
  assert.equal(found, null);
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
