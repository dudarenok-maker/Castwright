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
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serverOwnerPath, writeServerOwner } from '../lib/server-owner.mjs';
import {
  resolveLaunchTarget,
  isOwnServerInstance,
  waitForOwnServer,
  scanForOwnServer,
  confirmOwnServerFromMarker,
  decideLaunchAction,
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
// launcher must confirm success by IDENTITY (the owner marker in this
// worktree's own runDir, #3264), not by a bare TCP-connect to an assumed port:
// per the srv-60 auto-rebind design doc, the actual bound port is the single
// source of truth every consumer must read. makeHealthServer is a real HTTP
// server (plain http, not TLS) for the bare-TCP maxPorts=1 cases.
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
// ordinary (no-foreign-occupant) boot path depends on nothing but the port
// answering. Identity confirmation is reserved for maxPorts>1, which main()
// only ever uses once it has independently established a rebind is genuinely
// possible.
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

// A real run dir for real owner markers.
function makeRunDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'start-app-prod-owner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A real listening socket that drops every connection: the TCP connect
// succeeds, and no HTTP(S) probe can ever read an answer from it.
async function listenSilently(t, port = 0) {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject); // an occupied port rejects instead of crashing the run
    server.listen(port, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((r) => server.close(r)));
  return server.address().port;
}

// Two silent listeners on adjacent ports, returning startPort. startPort + 1 is
// not ours to reserve, so when something else holds it, release startPort and
// retry on a fresh one. firstPort seeds only the first attempt.
async function listenSilentlyPair(t, firstPort = 0) {
  for (let attempt = 0; ; attempt++) {
    const first = net.createServer((socket) => socket.destroy());
    const startPort = await new Promise((resolve, reject) => {
      first.once('error', reject);
      first.listen(attempt === 0 ? firstPort : 0, '127.0.0.1', () => resolve(first.address().port));
    });
    try {
      await listenSilently(t, startPort + 1);
    } catch (err) {
      await new Promise((r) => first.close(r));
      if (err.code !== 'EADDRINUSE' || attempt >= 20) throw err;
      continue;
    }
    t.after(() => new Promise((r) => first.close(r)));
    return startPort;
  }
}

// A port that was free a moment ago and has nothing listening on it.
async function closedPort() {
  const probe = net.createServer();
  const port = await listenOnFreePort(probe);
  await new Promise((r) => probe.close(r));
  return port;
}

// scanForOwnServer is the identity-confirming primitive waitForOwnServer
// uses internally for maxPorts>1, and main() also uses it directly for the
// pre-spawn "is a stale copy of MY OWN server already rebound somewhere in
// this range" check (Castwright#3030 round 3, finding N1).

// #3264 — cert files exist (the server bound HTTPS) and mkcert is unreachable,
// so no network probe can read the healthy server. The marker must be enough.
test('scanForOwnServer: #3264 own server that no HTTP(S) probe can read is confirmed from its marker', async (t) => {
  const runDir = makeRunDir(t);
  const port = await listenSilently(t);
  writeServerOwner({ runDir, port, https: true, pid: process.pid });
  assert.equal(await scanForOwnServer(port, 1, true, runDir), port);
});

test('scanForOwnServer: a marker whose pid is dead is not confirmation, even with the port listening', async (t) => {
  const runDir = makeRunDir(t);
  const port = await listenSilently(t);
  const { pid } = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }); // has exited by now
  writeServerOwner({ runDir, port, https: false, pid });
  assert.equal(await scanForOwnServer(port, 1, false, runDir), null);
});

test('scanForOwnServer: a marker with nothing listening on its port is not confirmation', async (t) => {
  const runDir = makeRunDir(t);
  const port = await closedPort();
  writeServerOwner({ runDir, port, https: false, pid: process.pid });
  assert.equal(await scanForOwnServer(port, 1, false, runDir), null);
});

test('scanForOwnServer: a listening port whose marker is only in a SIBLING run dir is not confirmed', async (t) => {
  const runDir = makeRunDir(t);
  const siblingRunDir = makeRunDir(t);
  const port = await listenSilently(t);
  writeServerOwner({ runDir: siblingRunDir, port, https: false, pid: process.pid });
  assert.equal(await scanForOwnServer(port, 1, false, runDir), null);
});

test('scanForOwnServer: a marker for port P that records a different port is not confirmed', async (t) => {
  const runDir = makeRunDir(t);
  const port = await listenSilently(t);
  writeFileSync(
    serverOwnerPath(runDir, port),
    JSON.stringify({ pid: process.pid, port: port + 1, https: false, startedAt: '' }),
    'utf8',
  );
  assert.equal(await scanForOwnServer(port, 1, false, runDir), null);
});

// The retry helper itself: a neighbour somebody else holds must not crash the
// test (listenSilently rejects on EADDRINUSE; the pair helper moves on).
test('listenSilentlyPair: retries on a fresh startPort when startPort + 1 is already taken', async (t) => {
  let free;
  let blocker;
  for (;;) {
    free = await closedPort();
    try {
      blocker = await listenSilently(t, free + 1);
      break;
    } catch (err) {
      assert.equal(err.code, 'EADDRINUSE'); // the neighbour of this candidate was taken too: pick another
    }
  }
  assert.equal(blocker, free + 1);
  // Without the retry: startPort binds, its neighbour is held, and the bind rejects.
  await assert.rejects(listenSilently(t, free + 1), { code: 'EADDRINUSE' });
  const startPort = await listenSilentlyPair(t, free);
  assert.notEqual(startPort, free); // `free`'s neighbour is held, so the first attempt was abandoned
  for (const port of [startPort, startPort + 1]) {
    await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', resolve);
      socket.on('error', reject);
      socket.on('close', () => socket.destroy());
    });
  }
});

test('scanForOwnServer: finds OUR OWN server anywhere in the range on the first pass', async (t) => {
  const runDir = makeRunDir(t);
  const startPort = await listenSilentlyPair(t); // foreign: no marker in our run dir
  writeServerOwner({ runDir, port: startPort + 1, https: false, pid: process.pid });
  assert.equal(await scanForOwnServer(startPort, 3, false, runDir), startPort + 1);
});

test('scanForOwnServer: an already-elapsed deadline aborts before probing the next candidate', async (t) => {
  const runDir = makeRunDir(t);
  const port = await listenSilently(t);
  writeServerOwner({ runDir, port, https: false, pid: process.pid });
  // Deadline already in the past — the very first candidate must be skipped.
  assert.equal(await scanForOwnServer(port, 1, false, runDir, Date.now() - 1), null);
});

// The pre-spawn scan passes probeServed so a server started before the marker
// existed (no marker file) is still recognised from its /api/health runDir, and a
// confirming marker cannot outvote a body that names a different runDir.
test('scanForOwnServer: with a health probe, a listening port with NO marker whose /api/health names OUR runDir is confirmed', async (t) => {
  const runDir = makeRunDir(t);
  const port = await listenSilently(t);
  assert.equal(await scanForOwnServer(port, 1, false, runDir, Infinity, async () => served(runDir)), port);
});

test('scanForOwnServer: with a health probe, NO marker and a sibling runDir or no readable body is not confirmed', async (t) => {
  const runDir = makeRunDir(t);
  const port = await listenSilently(t);
  assert.equal(await scanForOwnServer(port, 1, false, runDir, Infinity, async () => served('/sibling/.run')), null);
  assert.equal(await scanForOwnServer(port, 1, false, runDir, Infinity, async () => null), null);
  assert.equal(
    await scanForOwnServer(port, 1, false, runDir, Infinity, async () => {
      throw new Error('boom');
    }),
    null,
  );
});

test('scanForOwnServer: with a health probe, a closed port is not probed or confirmed', async (t) => {
  const runDir = makeRunDir(t);
  const port = await closedPort();
  let probed = false;
  const probeServed = async () => {
    probed = true;
    return served(runDir);
  };
  assert.equal(await scanForOwnServer(port, 1, false, runDir, Infinity, probeServed), null);
  assert.equal(probed, false);
});

test('scanForOwnServer: with a health probe, a confirming marker is outvoted by a body naming a sibling runDir', async (t) => {
  const runDir = makeRunDir(t);
  const port = await listenSilently(t);
  writeServerOwner({ runDir, port, https: false, pid: process.pid });
  assert.equal(await scanForOwnServer(port, 1, false, runDir, Infinity, async () => served('/sibling/.run')), null);
});

test('scanForOwnServer: with a health probe, a confirming marker stands when the body is unreadable or names our runDir', async (t) => {
  const runDir = makeRunDir(t);
  const port = await listenSilently(t);
  writeServerOwner({ runDir, port, https: true, pid: process.pid });
  assert.equal(await scanForOwnServer(port, 1, true, runDir, Infinity, async () => null), port);
  assert.equal(await scanForOwnServer(port, 1, true, runDir, Infinity, async () => served(runDir)), port);
});

// #3264 review: a pre-marker own server rebound to :port+1 must still be found
// by the real pre-spawn scan, or the launcher starts a second server on the
// same workspace.
test('decideLaunchAction: #3264 a pre-marker OWN server rebound to :port+1 (no marker, /api/health names our runDir) → skip, not spawn', async (t) => {
  const runDir = makeRunDir(t);
  const rebound = await listenSilently(t);
  const port = rebound - 1;
  const decision = await decideLaunchAction({
    port,
    altPort: port,
    lanHttps: false,
    runDir,
    url: `http://localhost:${port}/`,
    probePort: async (p) => p === rebound,
    probeServed: async (p) => (p === rebound ? served(runDir) : null),
  });
  assert.equal(decision.kind, 'skip');
  assert.ok(decision.messageLines.some((l) => l.includes(`:${rebound}`)));
});

test('confirmOwnServerFromMarker: marker + live pid + answering port is confirmed; a dead pid is not', async () => {
  const probes = {
    readServerOwner: (_runDir, port) => ({ pid: 4242, port, https: true, startedAt: '' }),
    probePort: async () => true,
  };
  assert.equal(
    await confirmOwnServerFromMarker(8443, '/repo/.run', { ...probes, pidIsAlive: () => true }),
    true,
  );
  assert.equal(
    await confirmOwnServerFromMarker(8443, '/repo/.run', { ...probes, pidIsAlive: () => false }),
    false,
  );
});

test('waitForOwnServer: scans past a foreign occupant to find OUR OWN server on a rebound port', async (t) => {
  const runDir = makeRunDir(t);
  const startPort = await listenSilentlyPair(t); // foreign: no marker in our run dir
  writeServerOwner({ runDir, port: startPort + 1, https: false, pid: process.pid });
  const found = await waitForOwnServer({
    startPort,
    maxPorts: 3,
    timeoutMs: 2000,
    lanHttps: false,
    runDir,
  });
  assert.equal(found, startPort + 1);
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

// decideLaunchAction is main()'s entire pre-spawn decision sequence,
// extracted (Castwright#3030 round 4, finding R5) so it is exercised here
// directly, with injected fake probes — no real sockets needed (the #3264
// marker cases further down use real ones). This is also what pins finding R1:
// the stale-own-instance scan must run UNCONDITIONALLY, not only when the
// target port currently has a foreign occupant, because a stale rebound copy
// of this worktree's own server can outlive the very occupant that caused the
// rebind.
const OWN_RUN_DIR = '/repo/.run';
const served = (runDir, extra = {}) => ({ configLoad: { runDir, ...extra } });

// No owner marker on any port: identity falls back to the /api/health answer,
// as for a server started before #3264.
function fakeProbes({ listening = {}, healthByPort = {} } = {}) {
  return {
    probePort: async (port) => Boolean(listening[port]),
    probeServed: async (port) => healthByPort[port] ?? null,
    confirmOwnServerFromMarker: async () => false,
  };
}

test('decideLaunchAction: target port is our own instance → skip with READY', async () => {
  const decision = await decideLaunchAction({
    port: 8443,
    altPort: 8080,
    lanHttps: true,
    runDir: OWN_RUN_DIR,
    url: 'https://localhost:8443/',
    ...fakeProbes({ listening: { 8443: true }, healthByPort: { 8443: served(OWN_RUN_DIR) } }),
    scanForOwnServer: async () => null,
  });
  assert.equal(decision.kind, 'skip');
  assert.ok(decision.messageLines.some((l) => l.includes('[SKIP]')));
  assert.ok(decision.messageLines.some((l) => l.includes('[READY]')));
});

test('decideLaunchAction: target port occupied by an unresponsive process → fail', async () => {
  const decision = await decideLaunchAction({
    port: 8443,
    altPort: 8080,
    lanHttps: true,
    runDir: OWN_RUN_DIR,
    url: 'https://localhost:8443/',
    ...fakeProbes({ listening: { 8443: true }, healthByPort: {} }), // probeServed returns null
    scanForOwnServer: async () => null,
  });
  assert.equal(decision.kind, 'fail');
  assert.match(decision.message, /does not answer \/api\/health/);
});

test('decideLaunchAction: foreign occupant on target, nothing stale, nothing on altPort → proceed with mayHaveRebound', async () => {
  const decision = await decideLaunchAction({
    port: 8443,
    altPort: 8080,
    lanHttps: true,
    runDir: OWN_RUN_DIR,
    url: 'https://localhost:8443/',
    ...fakeProbes({
      listening: { 8443: true },
      healthByPort: { 8443: served('/other-worktree/.run', { cwd: '/other/server' }) },
    }),
    scanForOwnServer: async () => null,
  });
  assert.equal(decision.kind, 'proceed');
  assert.equal(decision.mayHaveRebound, true);
  assert.match(decision.infoMessage, /\[INFO\]/);
  assert.match(decision.infoMessage, /\/other\/server/);
});

// Castwright#3030 round 4, finding R1 — the exact regression: launch while a
// sibling holds the port (rebind to :N) -> sibling stops -> the target port
// is free again on the NEXT launch, but the rebound copy of THIS worktree's
// own server from the earlier launch is still running on :N. Scoping the
// stale-scan to only the "currently foreign" branch (round 3's shape) missed
// this exactly because alreadyUp is false here.
test('decideLaunchAction: R1 — target port now FREE, but a stale rebound copy of OUR OWN server lingers → skip, not spawn', async () => {
  const scanCalls = [];
  const decision = await decideLaunchAction({
    port: 8443,
    altPort: 8080,
    lanHttps: true,
    runDir: OWN_RUN_DIR,
    url: 'https://localhost:8443/',
    ...fakeProbes({ listening: { 8080: false, 8443: false } }), // target genuinely free now
    scanForOwnServer: async (startPort, maxPorts) => {
      scanCalls.push({ startPort, maxPorts });
      return 8444; // our own stale instance, rebound here on an earlier launch
    },
  });
  assert.equal(decision.kind, 'skip');
  assert.ok(decision.messageLines.some((l) => l.includes(':8444')));
  // The scan must have actually run even though the target port was free —
  // this is the exact placement bug R1 found in round 3's version.
  assert.equal(scanCalls.length, 1);
  assert.equal(scanCalls[0].startPort, 8444); // port + 1
  assert.equal(scanCalls[0].maxPorts, 19);
});

test('decideLaunchAction: foreign occupant AND a stale own instance elsewhere → skip at the stale instance, never spawn', async () => {
  const decision = await decideLaunchAction({
    port: 8443,
    altPort: 8080,
    lanHttps: true,
    runDir: OWN_RUN_DIR,
    url: 'https://localhost:8443/',
    ...fakeProbes({
      listening: { 8443: true },
      healthByPort: { 8443: served('/other-worktree/.run') },
    }),
    scanForOwnServer: async () => 8446,
  });
  assert.equal(decision.kind, 'skip');
  assert.ok(decision.messageLines.some((l) => l.includes(':8446')));
});

test('decideLaunchAction: target free, nothing stale, our own instance already on altPort → skip', async () => {
  const decision = await decideLaunchAction({
    port: 8443,
    altPort: 8080,
    lanHttps: true,
    runDir: OWN_RUN_DIR,
    url: 'https://localhost:8443/',
    ...fakeProbes({
      listening: { 8443: false, 8080: true },
      healthByPort: { 8080: served(OWN_RUN_DIR) },
    }),
    scanForOwnServer: async () => null,
  });
  assert.equal(decision.kind, 'skip');
  assert.ok(decision.messageLines.some((l) => l.includes(':8080')));
});

test('decideLaunchAction: target free, altPort held by a FOREIGN install → proceed, no rebind expected', async () => {
  const decision = await decideLaunchAction({
    port: 8443,
    altPort: 8080,
    lanHttps: true,
    runDir: OWN_RUN_DIR,
    url: 'https://localhost:8443/',
    ...fakeProbes({
      listening: { 8443: false, 8080: true },
      healthByPort: { 8080: served('/other-worktree/.run') },
    }),
    scanForOwnServer: async () => null,
  });
  assert.equal(decision.kind, 'proceed');
  assert.equal(decision.mayHaveRebound, false);
  assert.equal(decision.infoMessage, null);
});

test('decideLaunchAction: fully clean boot — nothing anywhere → proceed, no rebind, no info message', async () => {
  const decision = await decideLaunchAction({
    port: 8443,
    altPort: 8080,
    lanHttps: true,
    runDir: OWN_RUN_DIR,
    url: 'https://localhost:8443/',
    ...fakeProbes({ listening: { 8443: false, 8080: false } }),
    scanForOwnServer: async () => null,
  });
  assert.deepEqual(decision, { kind: 'proceed', mayHaveRebound: false, infoMessage: null });
});

// #3264 — our own healthy server on :port, bound HTTPS with mkcert unreachable:
// a real listening socket, a real owner marker, and the real marker and TCP
// probes. Only the /api/health answer is faked.
async function decideWithOwnMarkerOnTarget(t, probeServed) {
  const runDir = makeRunDir(t);
  const port = await listenSilently(t);
  writeServerOwner({ runDir, port, https: true, pid: process.pid });
  const url = `https://localhost:${port}/`;
  const decision = await decideLaunchAction({
    port,
    altPort: port, // no alternate port in play
    lanHttps: true,
    runDir,
    url,
    probeServed,
    scanForOwnServer: async () => null,
  });
  return { decision, port, url };
}

test('decideLaunchAction: #3264 own marker on the target port and no /api/health answer → skip, not fail', async (t) => {
  const { decision, port, url } = await decideWithOwnMarkerOnTarget(t, async () => null);
  assert.deepEqual(decision, {
    kind: 'skip',
    messageLines: [
      `[SKIP] server already listening on :${port} — leaving it alone`,
      `[READY] ${url}`,
    ],
  });
});

test('decideLaunchAction: #3264 own marker on the target port still warns when /api/health reports no server/.env', async (t) => {
  const { decision } = await decideWithOwnMarkerOnTarget(t, async () => ({
    configLoad: { envLoaded: false, cwd: '/repo/elsewhere' },
  }));
  assert.equal(decision.kind, 'skip');
  assert.match(decision.messageLines[0], /^\[WARN\] .* WITHOUT server\/\.env \(cwd=\/repo\/elsewhere\)/);
  assert.match(decision.messageLines[1], /^\[SKIP\] server already listening/);
  assert.match(decision.messageLines[2], /^\[READY\]/);
});

test('decideLaunchAction: #3264 own marker on the target port → a probe that throws never fails the skip', async (t) => {
  const { decision } = await decideWithOwnMarkerOnTarget(t, async () => {
    throw new Error('unreadable root CA');
  });
  assert.equal(decision.kind, 'skip');
  assert.equal(decision.messageLines.length, 2);
});

test('decideLaunchAction: #3264 own marker on altPort and no /api/health answer → skip there', async (t) => {
  const runDir = makeRunDir(t);
  const port = await closedPort();
  const altPort = await listenSilently(t);
  writeServerOwner({ runDir, port: altPort, https: false, pid: process.pid });
  const decision = await decideLaunchAction({
    port,
    altPort,
    lanHttps: true,
    runDir,
    url: `https://localhost:${port}/`,
    probeServed: async () => null,
    scanForOwnServer: async () => null,
  });
  assert.equal(decision.kind, 'skip');
  assert.equal(decision.messageLines.length, 1);
  assert.ok(
    decision.messageLines[0].startsWith(
      `[SKIP] a Castwright server is already listening on :${altPort} `,
    ),
  );
});

// A marker whose pid was reused (Windows never runs the server's release on a
// kill) must not outvote a readable /api/health that names a different runDir.
test('decideLaunchAction: #3264 own marker on the target port but /api/health names a sibling runDir → proceed, not skip', async (t) => {
  const { decision } = await decideWithOwnMarkerOnTarget(t, async () =>
    served('/sibling/.run', { cwd: '/sibling/server' }),
  );
  assert.equal(decision.kind, 'proceed');
  assert.equal(decision.mayHaveRebound, true);
  assert.match(decision.infoMessage, /\/sibling\/server/);
});

test('decideLaunchAction: #3264 own marker on altPort but /api/health names a sibling runDir → proceed, not skip', async (t) => {
  const runDir = makeRunDir(t);
  const port = await closedPort();
  const altPort = await listenSilently(t);
  writeServerOwner({ runDir, port: altPort, https: false, pid: process.pid });
  const decision = await decideLaunchAction({
    port,
    altPort,
    lanHttps: true,
    runDir,
    url: `https://localhost:${port}/`,
    probeServed: async () => served('/sibling/.run', { cwd: '/sibling/server' }),
    scanForOwnServer: async () => null,
  });
  assert.equal(decision.kind, 'proceed');
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

// #4054: the launcher resolves a relative APP_LOG_DIR / APP_RUN_DIR against the
// repo root, but the server child runs with cwd=server/ and would resolve the
// same string against server/ — splitting server.log from node-reports/.
import { serverChildEnv } from '../start-app-prod.mjs';

test('serverChildEnv hands the child the launcher-resolved absolute log and run dirs', () => {
  const env = serverChildEnv(
    { APP_LOG_DIR: 'rel/logs', APP_RUN_DIR: 'rel/run', KEEP: '1' },
    { logDir: '/abs/rel/logs', runDir: '/abs/rel/run' },
  );
  assert.equal(env.APP_LOG_DIR, '/abs/rel/logs');
  assert.equal(env.APP_RUN_DIR, '/abs/rel/run');
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.KEEP, '1');
});

// #4054 pass 4: a Worker parses NODE_OPTIONS, not the parent's command line, so
// the child also gets both flags there (appended, never clobbering the user's).
test('serverChildEnv appends the report-exclusion flags to NODE_OPTIONS', () => {
  const env = serverChildEnv({ NODE_OPTIONS: '--max-old-space-size=8192' }, { logDir: '/l', runDir: '/r' });
  assert.equal(env.NODE_OPTIONS, '--max-old-space-size=8192 --report-exclude-env --report-exclude-network');
  assert.equal(
    serverChildEnv({}, { logDir: '/l', runDir: '/r' }).NODE_OPTIONS,
    '--report-exclude-env --report-exclude-network',
  );
});

test('serverChildEnv sets the dirs even when the launcher env had neither', () => {
  const env = serverChildEnv({}, { logDir: '/r/logs', runDir: '/r/.run' });
  assert.equal(env.APP_LOG_DIR, '/r/logs');
  assert.equal(env.APP_RUN_DIR, '/r/.run');
});

// #4054: the two serverChildEnv cases above test the helper alone, so pin the
// spawn itself too: it must hand the child serverChildEnv's env and start node
// with both report-exclusion flags (the server leaves fatal reports off
// without them). Comments are stripped first so a commented-out call can't pass.
import { readFileSync } from 'node:fs';

test('the server spawn passes serverChildEnv and both report-exclusion flags', () => {
  const src = readFileSync(new URL('../start-app-prod.mjs', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.match(
    code,
    /^import \{ REPORT_EXCLUSION_FLAGS, withReportExclusionNodeOptions \} from '\.\/lib\/report-exclusion\.mjs';$/m,
  );
  assert.match(
    code,
    /const child = spawn\(process\.execPath, \[\.\.\.REPORT_EXCLUSION_FLAGS, 'dist\/index\.js'\], \{\s*cwd: serverDir,\s*env: serverChildEnv\(process\.env, \{ logDir, runDir \}\),/,
  );
  assert.equal(code.match(/\bspawn\(/g)?.length, 1, 'one server spawn, so the pin covers it');
});
