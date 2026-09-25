#!/usr/bin/env node
// Cross-platform stop for the production launcher. Reads .run/server.pid +
// .run/tts.pid (sidecar — written by the Node server itself per plan 43),
// terminates the process tree, then sweeps any orphans on this checkout's
// own configured server + TTS ports (#2632 N39) — never a hardcoded
// :8080/:9000 that could belong to a different checkout.
//
// Importing this module must NOT stop or sweep anything — main() is guarded
// behind an invoked-directly check (mirrors start-app-prod.mjs), so
// importing killTree() alone for testing is side-effect-free.

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
import { isDirectlyInvoked } from './lib/is-main-module.mjs';
import { pidIsAlive } from './lib/pid-alive.mjs';
import { waitForExit } from './restart-after-upgrade.mjs';

// PR #3404 review pass 2 — a kill request only asks the target to exit; it
// doesn't confirm it. On POSIX, SIGTERM to the server triggers an ASYNC
// shutdown (server/src/index.ts's runShutdownSequence awaits the sidecar
// reap before process.exit), so a liveness probe taken the instant after
// kill() returns reads a stop that IS succeeding as 'failed'. Give it a
// bounded grace period to actually exit before judging it — short enough
// that a genuinely stuck process still reports 'failed' promptly.
const STOP_GRACE_MS = 5000;
const STOP_POLL_INTERVAL_MS = 100;

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

/** Kill one pid's process tree and classify the outcome by LIVENESS, never
 *  by taskkill's own exit code (E104: `taskkill /T` reports failure — exit
 *  128 on Windows — when a child had already exited mid-walk, even though
 *  the whole tree is actually gone; the reverse also happens, PR #3404
 *  review pass 1: a nonzero exit when the root itself was never found
 *  leaves the tree entirely untouched). Probing liveness BEFORE the kill
 *  attempt runs, not just after, is what lets this tell "already exited"
 *  apart from "we killed it" apart from "still running" — three distinct
 *  outcomes the old exit-code-trusting version collapsed into two.
 *
 *  Returns:
 *    - `'gone'`   — `pid` was already dead before this call ran; no kill
 *                   was attempted.
 *    - `'killed'` — `pid` was alive beforehand and is confirmed dead now.
 *    - `'failed'` — `pid` was alive beforehand and is STILL alive after the
 *                   grace period.
 *
 *  The post-kill liveness check is not an instant re-probe: a POSIX SIGTERM
 *  only asks the target to exit, and the server's own shutdown is
 *  asynchronous, so this polls (via the shared restart-after-upgrade.mjs
 *  waitForExit) for up to `graceMs` before judging the kill failed. Windows
 *  goes through the same wait — a `taskkill /F` that already succeeded
 *  resolves on its first liveness check with no extra delay, so a genuinely
 *  dead tree still reports 'killed' immediately.
 *
 *  `kill`/`isAlive`/`wait`/`sleep`/`now` are injectable purely for testing;
 *  nothing in production passes them. `isAlive` defaults to the shared
 *  fail-safe scripts/lib/pid-alive.mjs probe (also used by
 *  scripts/reap-stale-batteries.mjs and scripts/restart-after-upgrade.mjs). */
export async function killTree(
  pid,
  {
    kill = defaultKillAttempt,
    isAlive = pidIsAlive,
    wait = waitForExit,
    graceMs = STOP_GRACE_MS,
    pollIntervalMs = STOP_POLL_INTERVAL_MS,
    sleep,
    now,
  } = {},
) {
  if (!isAlive(pid)) return 'gone';
  try {
    kill(pid);
  } catch {
    // taskkill's own exit code is not trusted (E104) — the outcome is
    // judged by the liveness re-check below regardless of whether the kill
    // attempt itself threw.
  }
  const exited = await wait({ pid, timeoutMs: graceMs, intervalMs: pollIntervalMs, isAlive, sleep, now });
  return exited ? 'killed' : 'failed';
}

/** Whether the '[OK] nothing to stop' summary line must be suppressed —
 *  true when any pid's kill outcome was 'failed', or when a port is still
 *  listening with no PID file recorded. Pure so it's directly unit-testable
 *  without spawning main()'s real process/exit path (#2632 N53's contract:
 *  a stop that is NOT clean must never co-print OK). */
export function isStopSummarySuppressed(failedAny, stillListeningCount) {
  return failedAny || stillListeningCount > 0;
}

function defaultKillAttempt(pid) {
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
function probeAndSweep(port) {
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

async function main() {
  let killedAny = false;
  let failedAny = false;
  for (const name of ['server', 'tts']) {
    const pidPath = resolve(runDir, `${name}.pid`);
    if (!existsSync(pidPath)) continue;
    const raw = readFileSync(pidPath, 'utf8').trim();
    rmSync(pidPath, { force: true });
    const pid = Number.parseInt(raw, 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const outcome = await killTree(pid);
    if (outcome === 'killed') {
      info(`[STOP] ${name} pid=${pid}`);
      killedAny = true;
    } else if (outcome === 'gone') {
      info(`[GONE] ${name} pid=${pid} (already exited)`);
    } else {
      info(`[WARN] ${name} pid=${pid} could not be stopped (still running)`);
      failedAny = true;
    }
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
  // See getStopSummaryMessage's own comment. PR #3404 review pass 2 widens
  // this: a 'failed' kill (see isStopSummarySuppressed) must suppress OK too
  // — a stop that did NOT succeed is not "nothing to stop".
  const summary = getStopSummaryMessage(
    killedAny,
    isStopSummarySuppressed(failedAny, stillListening.length),
    portsToSweep,
  );
  if (summary) info(summary);
  process.exit(0);
}

if (isDirectlyInvoked(import.meta.url)) {
  main();
}
