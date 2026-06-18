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
import { existsSync, mkdirSync, openSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

function printBanner() {
  info(`\n${bannerLine(pkgVersion)}\n`);
}

const HEALTH_TIMEOUT_MS = 60_000;

/* Pure: which port/protocol will the server actually bind? Mirrors
   server/src/index.ts (PORT ?? 8080, LAN_HTTPS_PORT ?? 8443) and
   routes/export-lan.ts isLanHttpsEnabled() (LAN_HTTPS === '1'). Exported so
   scripts/tests/start-app-prod.test.mjs can pin the contract without spawning. */
export function resolveLaunchTarget(env = process.env) {
  const lanHttps = env.LAN_HTTPS === '1';
  const httpPort = Number(env.PORT ?? 8080);
  const lanPort = Number(env.LAN_HTTPS_PORT ?? 8443);
  return {
    lanHttps,
    port: lanHttps ? lanPort : httpPort,
    protocol: lanHttps ? 'https' : 'http',
  };
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

async function waitForListen(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probePort(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
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

async function main() {
  mkdirSync(runDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  loadServerEnv();
  const { lanHttps, port, protocol } = resolveLaunchTarget(process.env);
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

  const alreadyUp = await probePort(port);
  if (alreadyUp) {
    const served = await probeServed(port, lanHttps);
    if (!served) {
      fail(
        `Port :${port} is occupied by a process that does not answer /api/health — ` +
          `likely a stale or foreign server. Run "npm run stop" and retry.`,
      );
    }
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

  const ready = await waitForListen(port, HEALTH_TIMEOUT_MS);
  if (!ready) {
    fail(
      `Server did not start listening on :${port} within ${HEALTH_TIMEOUT_MS / 1000}s. ` +
        `Tail logs/server.err.log for details.`,
    );
  }

  info(`[OK] server on :${port}${lanHttps ? ' (LAN HTTPS)' : ''}`);
  info(`[READY] ${url}  (stop with "npm run stop:prod")`);
  process.exit(0);
}

// CLI guard — only run main() when invoked directly, not when imported by tests.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) await main();
