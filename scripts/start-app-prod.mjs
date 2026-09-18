#!/usr/bin/env node
// Production launcher: starts the Node server with NODE_ENV=production so it
// serves the built frontend (dist/) at :8080. The TTS sidecar is spawned by
// the server itself (plan 43, gated on autoStartSidecar). Cross-platform —
// runs on Windows, macOS, Linux. Logs to logs/server.log + .err.log, PID at
// .run/server.pid (forward slashes — Node's fs handles both).
//
// LAN mode (companion app, plan 188): when server/.env has LAN_HTTPS=1 (or
// `npm run start:lan` injects it via cross-env), the server flips to HTTPS on
// :8443 bound to 0.0.0.0 (see server/src/index.ts + bind-host.ts). The
// launcher must therefore health-check the SAME port/protocol the server will
// actually bind, or it false-FAILs waiting on :8080 while the server is up on
// :8443. resolveLaunchTarget() mirrors the server's selection so the two agree.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const serverDir = resolve(repoRoot, 'server');
/* runDir / logDir default to repoRoot but honour APP_RUN_DIR / APP_LOG_DIR so a
   versioned-dir install (fs-1) parks server.pid + logs in a shared sibling
   OUTSIDE releases/vX.Y.Z/ — the restarter waits on this server.pid across the
   swap, so it must NOT live inside the dir being replaced. Mirror of the
   resolveRunDir/resolveLogDir helper in server/src/app-dirs.ts (this script is
   plain ESM and can't import the compiled server module). */
const runDir = process.env.APP_RUN_DIR ? resolve(process.env.APP_RUN_DIR) : resolve(repoRoot, '.run');
const logDir = process.env.APP_LOG_DIR ? resolve(process.env.APP_LOG_DIR) : resolve(repoRoot, 'logs');
const distIndex = resolve(repoRoot, 'dist', 'index.html');
const serverEntry = resolve(serverDir, 'dist', 'index.js');
const pkgVersion = JSON.parse(
  readFileSync(resolve(repoRoot, 'package.json'), 'utf8'),
).version;

/** The one-line Castwright startup banner. Exported for unit testing. */
export function bannerLine(version) {
  return `Castwright v${version} — Any book, performed by a full cast.`;
}

/* Written by vite.config.ts's buildManifestPlugin (`vite build` only) to the
   repo root — deliberately NOT inside dist/, which express.static serves
   verbatim in prod (would leak the git branch + dirty-tree flag beyond what
   the app footer shows). Missing/unparsable (e.g. a build from before this
   file existed) degrades to null rather than throwing. */
function readBuildManifest() {
  const manifestPath = resolve(repoRoot, 'build-manifest.json');
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

/** Format the build-manifest.json provenance line. Exported for unit testing. */
export function formatBuildManifestLine(manifest) {
  if (!manifest) {
    return '[BUILD] unknown — build-manifest.json missing, run "npm run build" to populate it';
  }
  const sha = manifest.dirty ? `${manifest.sha}*` : manifest.sha;
  const built = manifest.buildTime ? new Date(manifest.buildTime).toLocaleString() : 'unknown time';
  return `[BUILD] ${sha} (${manifest.branch}) — built ${built}`;
}

function printBanner() {
  info(`\n${bannerLine(pkgVersion)}`);
  info(formatBuildManifestLine(readBuildManifest()));
  info('');
}

const HEALTH_TIMEOUT_MS = 60_000;

/* Pure: which port/protocol will the server actually bind? Mirrors
   server/src/index.ts (PORT ?? 8080, LAN_HTTPS_PORT ?? 8443) and
   routes/export-lan.ts isLanHttpsEnabled() (LAN_HTTPS === '1'). Exported so
   scripts/tests/start-app-prod.test.mjs can pin the contract without spawning. */
export function resolveLaunchTarget(env = process.env, certsPresent = true) {
  /* The launcher always spawns the server with NODE_ENV=production, so LAN HTTPS is
     REQUESTED unless explicitly disabled (LAN_HTTPS=0) — mirroring the server's
     isLanHttpsEnabled() production default. It only takes EFFECT when the mkcert
     certs exist; otherwise the server degrades to loopback HTTP (index.ts), so the
     launcher must health-check :8080, not :8443. */
  // Unset → prod default on (the launcher always spawns NODE_ENV=production); an
  // explicit value must be exactly '1' (mirrors the server's isLanHttpsEnabled, so
  // LAN_HTTPS=false disables rather than being read as ON).
  const lanRequested = env.LAN_HTTPS === undefined || env.LAN_HTTPS === '1';
  const lanHttps = lanRequested && certsPresent;
  const httpPort = Number(env.PORT ?? 8080);
  const lanPort = Number(env.LAN_HTTPS_PORT ?? 8443);
  return {
    lanHttps,
    port: lanHttps ? lanPort : httpPort,
    protocol: lanHttps ? 'https' : 'http',
  };
}

/* Best-effort mkcert cert provisioning for the production LAN-HTTPS default. Runs
   on first launch of any install path that uses this launcher; no-op when LAN is
   explicitly disabled or certs already exist. Never throws — a missing mkcert
   degrades to loopback HTTP, it does not block startup. */
async function maybeProvisionLanCerts(certPath, keyPath) {
  // Skip when LAN is not requested — unset means the prod default (provision), but any
  // EXPLICIT value other than '1' (0/false/off) is an opt-out, so don't run mkcert
  // (which would modify the system trust store) for a feature the operator disabled.
  if (process.env.LAN_HTTPS !== undefined && process.env.LAN_HTTPS !== '1') return;
  if (existsSync(certPath) && existsSync(keyPath)) return; // already provisioned
  try {
    const { setupLanCerts } = await import('./setup-lan-certs.mjs');
    const res = await setupLanCerts({ silent: false });
    info(
      res
        ? '[cert] LAN certs provisioned via mkcert — serving HTTPS for phone/tablet access.'
        : '[cert] LAN certs not provisioned (mkcert unavailable) — serving loopback HTTP. ' +
            'Install mkcert + run "npm run install:cert-mobile" to enable phone/tablet access.',
    );
  } catch (err) {
    info(`[cert] LAN cert provisioning skipped: ${err?.message ?? err}`);
  }
}

/* Load server/.env into process.env so the launcher sees the SAME LAN_HTTPS /
   PORT / LAN_HTTPS_PORT the server will read on boot. The server re-loads it
   itself (cwd-relative process.loadEnvFile), so this is purely to keep the
   launcher's health-check port in sync. A value injected on the CLI (start:lan
   does `cross-env LAN_HTTPS=1`) takes precedence over the file. */
function loadServerEnv() {
  const cliLanHttps = process.env.LAN_HTTPS; // start:lan's cross-env injection, if any
  const envPath = resolve(serverDir, '.env');
  if (existsSync(envPath)) {
    try {
      process.loadEnvFile(envPath);
    } catch {
      /* unreadable/malformed .env — fall back to whatever is already in env */
    }
  }
  if (cliLanHttps !== undefined) process.env.LAN_HTTPS = cliLanHttps;
}

function info(msg) {
  process.stdout.write(`${msg}\n`);
}
function fail(msg) {
  process.stderr.write(`[FAIL] ${msg}\n`);
  process.exit(1);
}

function probePort(port) {
  return new Promise((resolveProbe) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (ok) => {
      sock.destroy();
      resolveProbe(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(500, () => done(false));
  });
}

// Inline mirror of server resolveRootCaPath() (the script is plain ESM and can't
// import the compiled server module): env MKCERT_CAROOT -> `mkcert -CAROOT` ->
// per-OS default (honoring LOCALAPPDATA / XDG_DATA_HOME). Returns the rootCA.pem
// path or null when mkcert isn't installed.
function findRootCa() {
  const tryDir = (dir) => (dir && existsSync(join(dir, 'rootCA.pem')) ? join(dir, 'rootCA.pem') : null);
  if (process.env.MKCERT_CAROOT) {
    const p = tryDir(process.env.MKCERT_CAROOT);
    if (p) return p;
  }
  try {
    const out = execFileSync('mkcert', ['-CAROOT'], { encoding: 'utf8', windowsHide: true }).trim();
    const p = tryDir(out);
    if (p) return p;
  } catch {
    /* mkcert absent */
  }
  let def;
  if (process.platform === 'win32')
    def = join(process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local'), 'mkcert');
  else if (process.platform === 'darwin')
    def = join(os.homedir(), 'Library', 'Application Support', 'mkcert');
  else def = join(process.env.XDG_DATA_HOME || join(os.homedir(), '.local', 'share'), 'mkcert');
  return tryDir(def);
}

function getJson(scheme, port, agent) {
  const lib = scheme === 'https' ? https : http;
  return new Promise((resolveP) => {
    const req = lib.get(
      { host: 'localhost', port, path: '/api/health', agent, timeout: 4000, servername: 'localhost' },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolveP(JSON.parse(body));
          } catch {
            resolveP(null);
          }
        });
      },
    );
    req.on('error', () => resolveP(null));
    req.on('timeout', () => {
      req.destroy();
      resolveP(null);
    });
  });
}

// Probe /api/health and return the parsed JSON, or null on failure. For the LAN
// HTTPS flow we validate the self-signed cert properly against the mkcert root CA
// (NO TLS bypass); if mkcert isn't installed, fall back to a plain-HTTP loopback
// probe rather than disabling verification.
async function probeServed(port, useHttps) {
  if (!useHttps) return getJson('http', port);
  const ca = findRootCa();
  if (!ca) return getJson('http', port); // mkcert absent -> plain HTTP loopback, never TLS-disable
  const agent = new https.Agent({ ca: readFileSync(ca), rejectUnauthorized: true });
  return getJson('https', port, agent);
}

function realpathWithFallback(p) {
  try {
    return realpathSync(p);
  } catch {
    return p; // path doesn't exist (yet) or isn't resolvable — fall back to the raw string
  }
}

/* Windows filesystems are case-insensitive but case-PRESERVING, so the same
   directory can come back spelled two different ways: this launcher derives
   its own runDir off a realpathed import.meta.url (always canonical drive
   letter), while a server started via Pinokio's `cd server && node
   dist/index.js`, or the manual `node dist/index.js` workaround #3030's own
   body describes, inherits whatever case the invoking shell happened to type.
   A raw string compare would then treat a server's OWN already-running
   instance as foreign and spawn a duplicate onto the same workspace — the
   same class of bug as #2291 (see scripts/lib/is-main-module.mjs), just for
   directory identity instead of module identity. Real path first (also
   collapses a worktree junction to its target), THEN lowercase on win32 —
   exported so tests can inject a stub and pin the behaviour without touching
   the real filesystem. */
export function defaultNormalizePathForCompare(p) {
  const real = realpathWithFallback(p);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/* Whether an /api/health response describes THIS worktree's own server
   instance rather than some other Castwright install (e.g. a sibling
   worktree's server, or a foreign box) that happens to answer on a port we
   probed. Compares runDir, NOT cwd (Castwright#3030 round 2): resolveRunDir
   honours APP_RUN_DIR, which a versioned-dir (fs-1) install sets IDENTICALLY
   across every release version (root `launch.mjs`'s planLaunch) — so an
   in-progress upgrade restart (restart-after-upgrade.mjs launching the NEW
   release while the OLD release's server may still be shutting down) still
   recognizes the old release's server as its own, even though the two
   releases' server/ cwd differ. A bare checkout/worktree has no APP_RUN_DIR
   override, so runDir defaults to <that worktree's own repoRoot>/.run —
   distinct per worktree, which is what lets this launcher tell a sibling
   worktree's own server apart from its own already-running instance.
   Exported for scripts/tests/start-app-prod.test.mjs. */
export function isOwnServerInstance(served, ownRunDir, { normalize = defaultNormalizePathForCompare } = {}) {
  const servedRunDir = served?.configLoad?.runDir;
  if (typeof servedRunDir !== 'string') return false;
  return normalize(servedRunDir) === normalize(ownRunDir);
}

/* Single pass over [startPort, startPort + maxPorts) looking for THIS
   worktree's own server, confirmed by IDENTITY (runDir via /api/health), not
   merely a socket accepting a connection — a listening socket at a candidate
   port could belong to a completely different process. `deadline`, when
   given, additionally aborts the scan (returning null) before starting a new
   candidate once time is up, so a caller's overall timeout budget can't be
   blown open-ended by a slow multi-candidate pass (Castwright#3030 round 3,
   finding N8). Exported for scripts/tests/start-app-prod.test.mjs. */
export async function scanForOwnServer(startPort, maxPorts, lanHttps, runDir, deadline = Infinity) {
  for (let i = 0; i < maxPorts; i += 1) {
    if (Date.now() >= deadline) return null;
    const candidate = startPort + i;
    if (await probePort(candidate)) {
      const served = await probeServed(candidate, lanHttps);
      if (isOwnServerInstance(served, runDir)) return candidate;
    }
  }
  return null;
}

/* Wait for THIS worktree's OWN server to become reachable at `startPort`
   (maxPorts=1, the ordinary case) or somewhere in
   [startPort, startPort + maxPorts) (maxPorts>1, only reachable when a
   rebind is genuinely possible — see main()'s mayHaveRebound).

   The ordinary (maxPorts=1) case deliberately stays a BARE TCP-connect,
   exactly matching this launcher's pre-#3030 behaviour: nothing else could
   plausibly have taken the one port this launcher itself confirmed free a
   moment ago (short of the same vanishingly rare race this file has always
   tolerated), so identity confirmation buys nothing there and only adds a
   dependency this path never needed before — going through probeServed's
   TLS-cert resolution (findRootCa()) for every ordinary boot, on hardware
   where cert FILES exist but the mkcert CA is not independently
   discoverable, timed out for a server that was actually healthy
   (Castwright#3030 round 3, finding N2: this is exactly the regression the
   round-2 fix introduced by routing the ordinary path through identity
   confirmation too).

   Only the maxPorts>1 (rebind-possible) case needs identity confirmation —
   there, multiple candidates are plausible and a bare "something is
   listening" can't tell this worktree's own child apart from a different
   process that happens to occupy one of the scanned ports. Per the
   auto-rebind design of record
   (docs/superpowers/specs/2026-07-14-srv60-auto-rebind-port-design.md), "the
   ACTUAL bound port... becomes the single source of truth" every consumer
   must read — not a port a consumer merely asked for or guessed
   (Castwright#3030 round 2, finding F1). Exported for
   scripts/tests/start-app-prod.test.mjs. */
export async function waitForOwnServer({ startPort, maxPorts = 1, timeoutMs, lanHttps, runDir }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (maxPorts === 1) {
      if (await probePort(startPort)) return startPort;
    } else {
      const found = await scanForOwnServer(startPort, maxPorts, lanHttps, runDir, deadline);
      if (found !== null) return found;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function main() {
  mkdirSync(runDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  loadServerEnv();
  /* Mirror the server's effective-LAN check (index.ts): certs live at
     <runDir>/certs/lan-{cert,key}.pem (app-dirs.ts resolveLanCertPaths). If LAN is
     requested but they're missing, the server serves loopback HTTP, so health-check
     the port that will actually bind. */
  const certsDir = resolve(runDir, 'certs');
  const certPath = resolve(certsDir, 'lan-cert.pem');
  const keyPath = resolve(certsDir, 'lan-key.pem');
  /* LAN HTTPS is the production default, so auto-provision mkcert certs on first
     launch — this is the UNIVERSAL hook every non-Pinokio prod start goes through
     (native installer, manual `npm run start:prod`, versioned-install restart), so
     phone/tablet listening + pairing work out of the box, not just under Pinokio.
     Best-effort + non-fatal: mkcert missing → setupLanCerts() returns null and the
     server serves loopback HTTP with a one-command fix hint. */
  await maybeProvisionLanCerts(certPath, keyPath);
  const certsPresent = existsSync(certPath) && existsSync(keyPath);
  const { lanHttps, port, protocol } = resolveLaunchTarget(process.env, certsPresent);
  const url = `${protocol}://localhost:${port}/`;

  if (!existsSync(distIndex)) {
    fail(
      `Frontend bundle missing at dist/index.html. Run "npm run build" before "npm run start:prod".`,
    );
  }
  if (!existsSync(serverEntry)) {
    fail(
      `Server bundle missing at server/dist/index.js. Run "npm run build" before "npm run start:prod".`,
    );
  }

  printBanner();

  // Set below when the target port turns out to be held by a DIFFERENT
  // Castwright install (Castwright#3030 round 2) — widens the post-spawn
  // readiness wait into a scan, since the child may land on a rebound port
  // in that case (see waitForOwnServer). The [INFO] announcing this is
  // deferred until AFTER the altPort check below, which can still itself
  // decide to [SKIP] — printing "starting anyway" only to skip moments later
  // would misreport what actually happened (Castwright#3030 round 3, N7).
  let mayHaveRebound = false;
  let foreignOccupantCwd = null;

  const alreadyUp = await probePort(port);
  if (alreadyUp) {
    const served = await probeServed(port, lanHttps);
    if (!served) {
      fail(
        `Port :${port} is occupied by a process that does not answer /api/health — ` +
          `likely a stale or foreign server. Run "npm run stop" and retry.`,
      );
    }
    if (isOwnServerInstance(served, runDir)) {
      if (served.configLoad && served.configLoad.envLoaded === false) {
        info(
          `[WARN] server on :${port} is running WITHOUT server/.env ` +
            `(cwd=${served.configLoad.cwd}) — on DEFAULTS. Stop it and relaunch from server/.`,
        );
      }
      info(`[SKIP] server already listening on :${port} — leaving it alone`);
      info(`[READY] ${url}`);
      process.exit(0);
    }
    /* A DIFFERENT Castwright install (e.g. a sibling worktree's own server)
       answers on our target port — not a duplicate of this worktree's own
       instance, so don't refuse to start outright. But before spawning,
       check whether THIS worktree's own server is already sitting somewhere
       ELSE in the rebind window listenWithAutoRebind would walk — a stale
       instance left over from an earlier launch that also hit a foreign
       occupant here. Skipping that check would let this launcher spawn a
       genuine SECOND copy of its own server against one WORKSPACE_DIR (with
       no cross-process lock — server/src/workspace/file-lock.ts's mutex is
       in-process only) while the post-spawn wait below reports the OLD
       instance ready instead of the one just spawned (Castwright#3030
       round 3, finding N1). */
    const stalePort = await scanForOwnServer(port + 1, 19, lanHttps, runDir);
    if (stalePort !== null) {
      info(
        `[SKIP] this worktree's own server is already listening on :${stalePort} ` +
          `(rebound off :${port}, held by a different Castwright install) — leaving it alone. ` +
          `Run "npm run stop:prod" first to relaunch cleanly.`,
      );
      process.exit(0);
    }
    mayHaveRebound = true;
    foreignOccupantCwd = served.configLoad?.cwd ?? 'unknown';
  }

  /* A prior launch of THIS worktree's own server may have bound the OTHER
     port — e.g. it started loopback HTTP :8080 because certs were absent,
     and now certs exist so our target is :8443. Probing only the target
     would miss that running server and spawn a duplicate (two servers, one
     stale pid file). Detect a live instance of THIS worktree's own server on
     the alternate port and leave it alone — a sibling worktree's (or any
     other install's) own server answering there is not a reason to skip. */
  const altPort = port === Number(process.env.LAN_HTTPS_PORT ?? 8443)
    ? Number(process.env.PORT ?? 8080)
    : Number(process.env.LAN_HTTPS_PORT ?? 8443);
  if (altPort !== port && (await probePort(altPort))) {
    const servedAlt = await probeServed(altPort, altPort === Number(process.env.LAN_HTTPS_PORT ?? 8443));
    if (isOwnServerInstance(servedAlt, runDir)) {
      info(
        `[SKIP] a Castwright server is already listening on :${altPort} — leaving it alone. ` +
          `Run "npm run stop:prod" first to relaunch on :${port}.`,
      );
      process.exit(0);
    }
  }

  if (mayHaveRebound) {
    info(
      `[INFO] a different Castwright server (cwd=${foreignOccupantCwd}) is already listening on ` +
        `:${port} — not this worktree's own instance. Starting anyway; this worktree's server will ` +
        `bind the next free port.`,
    );
  }

  const outLog = openSync(resolve(logDir, 'server.log'), 'a');
  const errLog = openSync(resolve(logDir, 'server.err.log'), 'a');

  /* Spawn the built server directly with the current Node binary instead of going
     through `npm.cmd` — on Node >=20.6 spawning a `.cmd` without `shell: true`
     throws EINVAL on Windows (the CVE-2024-27980 mitigation), which broke
     `npm run start:prod`. Running `node dist/index.js` with cwd=server is simpler
     and ALSO guarantees `process.loadEnvFile('.env')` resolves server/.env
     (it's cwd-relative) — so prod gets the same WORKSPACE_DIR / analyzer / GPU
     tuning the dev server reads. detached + unref so the server outlives this
     launcher and the console window that double-clicked the .bat. */
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: serverDir,
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: ['ignore', outLog, errLog],
    detached: true,
    windowsHide: true,
  });

  if (typeof child.pid !== 'number') {
    fail('Failed to spawn server process.');
  }

  writeFileSync(resolve(runDir, 'server.pid'), String(child.pid), 'utf8');
  info(
    `[START] server pid=${child.pid} -> logs/server.log ` +
      `(NODE_ENV=production${lanHttps ? ', LAN_HTTPS=1' : ''})`,
  );

  child.unref();

  // Mirrors listenWithAutoRebind's own 20-port window (server/src/crash-logging.ts)
  // ONLY when a rebind is actually possible (mayHaveRebound) — the ordinary
  // case still confirms the single port we asked for, unchanged.
  const boundPort = await waitForOwnServer({
    startPort: port,
    maxPorts: mayHaveRebound ? 20 : 1,
    timeoutMs: HEALTH_TIMEOUT_MS,
    lanHttps,
    runDir,
  });
  if (boundPort === null) {
    fail(
      mayHaveRebound
        ? `This worktree's server did not become reachable on :${port}–:${port + 19} within ` +
            `${HEALTH_TIMEOUT_MS / 1000}s. Tail logs/server.err.log for details.`
        : `Server did not start listening on :${port} within ${HEALTH_TIMEOUT_MS / 1000}s. ` +
            `Tail logs/server.err.log for details.`,
    );
  }

  const boundUrl = `${protocol}://localhost:${boundPort}/`;
  info(`[OK] server on :${boundPort}${lanHttps ? ' (LAN HTTPS)' : ''}`);
  info(`[READY] ${boundUrl}  (stop with "npm run stop:prod")`);
  process.exit(0);
}

// CLI guard — only run main() when invoked directly, not when imported by
// tests. See scripts/lib/is-main-module.mjs — an un-realpathed comparison
// misses when the invocation crosses a symlink/junction (#2291).
const invokedDirectly = isDirectlyInvoked(import.meta.url);
if (invokedDirectly) await main();
