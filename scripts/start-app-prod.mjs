#!/usr/bin/env node
// Production launcher: starts the Node server with NODE_ENV=production so it
// serves the built frontend (dist/) at :8080. The TTS sidecar is spawned by
// the server itself (plan 43, gated on autoStartSidecar). Cross-platform —
// runs on Windows, macOS, Linux. Logs to logs/server.log + .err.log, PID at
// .run/server.pid (forward slashes — Node's fs handles both).

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const runDir = resolve(repoRoot, '.run');
const logDir = resolve(repoRoot, 'logs');
const distIndex = resolve(repoRoot, 'dist', 'index.html');
const serverEntry = resolve(repoRoot, 'server', 'dist', 'index.js');

mkdirSync(runDir, { recursive: true });
mkdirSync(logDir, { recursive: true });

const SERVER_PORT = Number(process.env.PORT ?? 8080);
const HEALTH_TIMEOUT_MS = 60_000;

function info(msg) {
  process.stdout.write(`${msg}\n`);
}
function fail(msg) {
  process.stderr.write(`[FAIL] ${msg}\n`);
  process.exit(1);
}

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

const alreadyUp = await probePort(SERVER_PORT);
if (alreadyUp) {
  info(`[SKIP] something already listening on :${SERVER_PORT} — leaving it alone`);
  info(`[READY] http://localhost:${SERVER_PORT}/`);
  process.exit(0);
}

const outLog = openSync(resolve(logDir, 'server.log'), 'a');
const errLog = openSync(resolve(logDir, 'server.err.log'), 'a');

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

const child = spawn(npmCmd, ['--prefix', 'server', 'run', 'start'], {
  cwd: repoRoot,
  env: { ...process.env, NODE_ENV: 'production' },
  stdio: ['ignore', outLog, errLog],
  detached: !isWindows,
  windowsHide: true,
});

if (typeof child.pid !== 'number') {
  fail('Failed to spawn server process.');
}

writeFileSync(resolve(runDir, 'server.pid'), String(child.pid), 'utf8');
info(`[START] server pid=${child.pid} -> logs/server.log (NODE_ENV=production)`);

if (!isWindows) child.unref();

const ready = await waitForListen(SERVER_PORT, HEALTH_TIMEOUT_MS);
if (!ready) {
  fail(
    `Server did not start listening on :${SERVER_PORT} within ${HEALTH_TIMEOUT_MS / 1000}s. ` +
      `Tail logs/server.err.log for details.`,
  );
}

info(`[OK] server on :${SERVER_PORT}`);
info(`[READY] http://localhost:${SERVER_PORT}/  (stop with "npm run stop:prod")`);
process.exit(0);
