#!/usr/bin/env node
// Cross-platform stop for the production launcher. Reads .run/server.pid +
// .run/tts.pid (sidecar — written by the Node server itself per plan 43),
// terminates the process tree, then sweeps any orphans on :8080 / :9000.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { buildPortsToSweep } from './lib/sidecar-sweep-port.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
// Mirror server/src/app-dirs.ts's resolveRunDir(): honour APP_RUN_DIR (the
// versioned-install layout, fs-1) so this sweep looks in the SAME .run/ the
// server actually wrote its owner note to, rather than always <repoRoot>/.run
// (#2632 N29).
const runDir = process.env.APP_RUN_DIR ? resolve(process.env.APP_RUN_DIR) : resolve(repoRoot, '.run');
const serverEnvPath = resolve(repoRoot, 'server', '.env');

const isWindows = process.platform === 'win32';

function info(msg) {
  process.stdout.write(`${msg}\n`);
}

function killTree(pid) {
  try {
    if (isWindows) {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      // Negative pid = process group on POSIX. start-app-prod.mjs runs the
      // child detached so it gets its own group.
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        process.kill(pid, 'SIGTERM');
      }
    }
    return true;
  } catch {
    return false;
  }
}

let killedAny = false;
for (const name of ['server', 'tts']) {
  const pidPath = resolve(runDir, `${name}.pid`);
  if (!existsSync(pidPath)) continue;
  const raw = readFileSync(pidPath, 'utf8').trim();
  rmSync(pidPath, { force: true });
  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 0) continue;
  if (killTree(pid)) {
    info(`[STOP] ${name} pid=${pid}`);
    killedAny = true;
  } else {
    info(`[GONE] ${name} pid=${pid} (already exited)`);
  }
}

// Belt-and-braces: sweep listeners on our prod ports. (No 5173 here — prod
// doesn't run Vite.) :8443 is the LAN HTTPS port (start:lan / LAN_HTTPS=1 in
// server/.env) — sweep it too so a LAN server with no surviving PID file is
// still reaped.
async function probeAndSweep(port) {
  return new Promise((resolveProbe) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    sock.once('connect', () => {
      sock.destroy();
      resolveProbe(true);
    });
    sock.once('error', () => {
      sock.destroy();
      resolveProbe(false);
    });
    sock.setTimeout(300, () => {
      sock.destroy();
      resolveProbe(false);
    });
  });
}

// The TTS port is per-checkout since #2632 (LOCAL_TTS_PORT); read the actual
// owned port from .run/tts.owner.json, falling back to this checkout's own
// server/.env, rather than assuming 9000 — a hardcoded 9000 here would warn
// about (and stop-app.ps1's sibling would force-kill) a DIFFERENT checkout's
// sidecar from a worktree (#2632 N27/N29). When neither source yields a
// port, skip sweeping the TTS port entirely rather than guessing 9000.
const stillListening = [];
const portsToSweep = buildPortsToSweep([8080, 8443], runDir, serverEnvPath);
for (const port of portsToSweep) {
  if (await probeAndSweep(port)) stillListening.push(port);
}

if (stillListening.length > 0) {
  info(
    `[WARN] still listening on :${stillListening.join(', :')} — no PID file recorded. ` +
      `Use platform tools (Windows: "netstat -ano | findstr :${stillListening[0]}", ` +
      `POSIX: "lsof -i:${stillListening[0]}") to identify + kill manually.`,
  );
}

if (!killedAny && stillListening.length === 0) {
  info('[OK] nothing to stop');
}
process.exit(0);
