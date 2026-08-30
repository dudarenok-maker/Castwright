#!/usr/bin/env node
// Cross-platform stop for the production launcher. Reads .run/server.pid +
// .run/tts.pid (sidecar — written by the Node server itself per plan 43),
// terminates the process tree, then sweeps any orphans on this checkout's
// own configured server + TTS ports (#2632 N39) — never a hardcoded
// :8080/:9000 that could belong to a different checkout.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import {
  buildPortsToSweep,
  getStopSummaryMessage,
  resolveConfiguredServerPort,
} from './lib/sidecar-sweep-port.mjs';

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
// doesn't run Vite.)
//
// #2632 N39 — :8443 (the LAN HTTPS port) is deliberately NOT in this list.
// It used to be a blind literal, same class of hazard as the old hardcoded
// :8080/:9000: LAN_HTTPS_PORT is not per-checkout offset by wt-new.mjs, so
// a hardcoded 8443 here could warn about a DIFFERENT checkout's LAN server.
// Unlike PORT/LOCAL_TTS_PORT, there is no way to resolve it safely: this
// launcher (start-app-prod.mjs) always spawns NODE_ENV=production, and
// index.ts's listenWithAutoRebind auto-rebinds on EADDRINUSE in production
// — LAN_HTTPS_PORT is only a *startPort*, so the process may actually be
// listening on 8444, 8445, … instead. Reading server/.env's configured
// value would still only be a guess at what THIS checkout is bound to, not
// a fact — and start-app-prod.mjs's launcher also defaults LAN_HTTPS ON in
// production (isLanHttpsEnabled(), export-lan.ts) unless explicitly turned
// off, so guessing would apply to nearly every prod run. There is no
// owner-note file for the main server's bound port (unlike
// .run/tts.owner.<port>.json for the sidecar) to settle which port is really this
// checkout's — the only authoritative source is the PID the 'server' loop
// above already reaped by tree-kill, which needs no port sweep at all.
// Sweep nothing here rather than warn about a port that might be someone
// else's.
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
// owned port from .run/tts.owner.<port>.json, falling back to this checkout's own
// server/.env, rather than assuming 9000 — a hardcoded 9000 here would warn
// about (and stop-app.ps1's sibling would force-kill) a DIFFERENT checkout's
// sidecar from a worktree (#2632 N27/N29). When neither source yields a
// port, skip sweeping the TTS port entirely rather than guessing 9000.
//
// #2632 N39 — the SAME per-checkout discipline applies to the server port:
// :8080 is only a safe base port for the checkout that's actually configured
// for it. A worktree's server/.env always carries its own PORT (wt-new.mjs
// writes one per slot), so resolveConfiguredServerPort resolves it there; a
// hand-edited primary checkout with no PORT line yields null, and this warns
// about nothing for that slot rather than warning about a different
// checkout's :8080. (See the comment above probeAndSweep for why :8443 is
// NOT resolved the same way and is dropped from the sweep entirely.)
const serverPort = resolveConfiguredServerPort(serverEnvPath);
const basePorts = serverPort ? [serverPort] : [];
const stillListening = [];
const portsToSweep = buildPortsToSweep(basePorts, runDir, serverEnvPath);
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

// #2632 N53 — a still-listening port, or zero ports resolved for this
// checkout, must not both read as the same "[OK] nothing to stop" claim.
// See getStopSummaryMessage's own comment.
const summary = getStopSummaryMessage(killedAny, stillListening.length > 0, portsToSweep);
if (summary) info(summary);
process.exit(0);
