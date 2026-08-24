// #2632 N27/N29 — the sidecar port stop-app.mjs's belt-and-braces listener
// sweep probes is per-checkout since #2632 (LOCAL_TTS_PORT), not always the
// factory default :9000. A hardcoded 9000 in the sweep list warns about
// (stop-app.ps1's sibling force-kills) whatever is listening there from a
// worktree whose own sidecar lives on a different port — typically the
// PRIMARY checkout's sidecar, mid-generation.
//
// The Node server already records the port it actually owns in
// .run/tts.owner.json (SidecarOwnerNote, server/src/tts/sidecar-owner.ts) the
// moment it claims ownership, so read THAT first. But the note is absent in
// three routine states (N29): after a clean shutdown (releaseSidecarOwnership
// unlinks it), with autoStartSidecar off (the note is never written), or when
// this checkout's own server/.env sets LOCAL_TTS_PORT to something a stale
// note doesn't reflect yet. Falling back to the factory default 9000 there
// is the one dangerous value — it is guaranteed to belong to a DIFFERENT
// checkout in exactly those states, and stop-app.ps1's sibling force-kills
// whatever answers on it. So the fallback instead reads LOCAL_TTS_PORT out of
// THIS checkout's own server/.env (server/src/load-env.ts's source, and the
// same file wt-new.mjs:166 writes per-worktree) — the port this checkout is
// actually configured for, whether or not a sidecar has claimed it yet. Only
// when neither source yields a port does this return null, meaning "don't
// sweep the TTS port at all" — never blind-kill 9000.
//
// Pure + side-effect-free (only reads files) so it's directly unit-testable
// without executing stop-app.mjs's real taskkill/probe flow.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Single validity rule for a LOCAL_TTS_PORT spelling, shared with the
    server's own resolveSidecarPort() (server/src/tts/sidecar-owner.ts,
    hardened at #2632 N28): a plain decimal-integer spelling only, 1-65535.
    `Number()` alone silently accepts "+9010", "1e4", "0x2386", "9010.0" —
    spellings the server's `/^\d+$/` gate rejects (logs "Invalid
    LOCAL_TTS_PORT" and falls back to 9000). This helper must reject exactly
    what the server rejects (#2632 N36), or the sweep can target a port the
    server never actually bound to. */
function parseLocalTtsPortValue(raw) {
  if (!/^\d+$/.test(raw)) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/** Resolve a single `KEY=value` env line's port value out of an env-style
    file, mirroring process.loadEnvFile's own precedence and parsing rules —
    shared by LOCAL_TTS_PORT (server/.env), PORT (server/.env), and VITE_PORT
    (.env.local), the three env-sourced ports stop-app.mjs sweeps (#2632 N39).

    Two things this MUST match about process.loadEnvFile, both measured
    directly against the real function rather than assumed:
    - #2632 N36: a shell-exported value wins over the file — loadEnvFile
      never overwrites an already-present process.env entry, so if THIS
      shell already has `key` set, that's the value the server would also
      resolve to.
    - #2632 N42: on a DUPLICATE key, loadEnvFile takes the LAST assignment
      (later `process.env[key] = value` calls simply overwrite earlier
      ones) — so this reader must take the last matching line too, not the
      first, or it can target a port the server never actually bound to. */
function resolvePortFromEnvFile(envPath, key) {
  if (process.env[key]) {
    return parseLocalTtsPortValue(process.env[key]);
  }
  try {
    const raw = readFileSync(envPath, 'utf8');
    // #2632 N48 — 'i' flag: process.env is case-insensitive on Windows, so
    // process.loadEnvFile setting process.env.PORT from a `port=`/`Port=`
    // line there is real behaviour, not a spelling this reader may ignore.
    const re = new RegExp(`^\\s*${key}\\s*=\\s*(\\S+)\\s*$`, 'gmi');
    let match;
    let lastValue = null;
    while ((match = re.exec(raw)) !== null) {
      lastValue = match[1];
    }
    if (lastValue === null) return null;
    return parseLocalTtsPortValue(lastValue);
  } catch {
    // Missing/unreadable env file — no fallback available from here.
  }
  return null;
}

function parseLocalTtsPortFromServerEnv(serverEnvPath) {
  return resolvePortFromEnvFile(serverEnvPath, 'LOCAL_TTS_PORT');
}

/** Resolve this checkout's own configured `PORT` (server/.env) — the same
    per-checkout, never-guess-the-primary's-value discipline as the TTS
    port, extended to the class of hardcoded base ports (#2632 N39): a
    worktree's `server/.env` always carries an explicit PORT (wt-new.mjs
    writes one per slot), so this resolves for every worktree; a
    hand-edited primary checkout with no PORT line returns null, meaning
    "don't sweep the server port" rather than guessing :8080 — the same
    trade `resolveSidecarSweepPort` already makes for LOCAL_TTS_PORT. */
export function resolveConfiguredServerPort(serverEnvPath) {
  return serverEnvPath ? resolvePortFromEnvFile(serverEnvPath, 'PORT') : null;
}

/** Resolve this checkout's own configured `VITE_PORT` (.env.local) — the
    Vite-side sibling of resolveConfiguredServerPort (#2632 N39). Only
    stop-app.ps1 sweeps a Vite port; stop-app.mjs is the prod launcher and
    never runs Vite. */
export function resolveConfiguredVitePort(envLocalPath) {
  return envLocalPath ? resolvePortFromEnvFile(envLocalPath, 'VITE_PORT') : null;
}

/** Resolve the sidecar port to sweep: the port this checkout's `.run/`
    directory recorded ownership of, or — when that note is absent,
    unreadable, corrupt, or out-of-range — the LOCAL_TTS_PORT this checkout's
    own `server/.env` is configured for. Returns `null` (meaning: sweep
    nothing for TTS) only when neither source yields a usable port; it never
    falls back to the factory default 9000, which risks sweeping a different
    checkout's sidecar (#2632 N29). */
export function resolveSidecarSweepPort(runDir, serverEnvPath) {
  const notePath = resolve(runDir, 'tts.owner.json');
  try {
    const raw = readFileSync(notePath, 'utf8');
    const note = JSON.parse(raw);
    const port = Number(note?.port);
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      return port;
    }
  } catch {
    // Absent, unreadable, or corrupt — fall through to the server/.env fallback.
  }
  return serverEnvPath ? parseLocalTtsPortFromServerEnv(serverEnvPath) : null;
}

/** Build the full list of ports stop-app.mjs should probe/sweep: the base
    ports (frontend/server/LAN-HTTPS) plus the resolved sidecar port, when
    one resolves. This is the ENTIRE call-site computation, not just the
    port-resolution step — pulled out so the exact list stop-app.mjs sweeps
    is itself unit-testable, rather than only resolveSidecarSweepPort() in
    isolation. #2632 N34: a call site that stops USING the resolved port
    (while still calling the resolver) must redden a test — that requires
    testing the assembled list, not the resolver alone. */
export function buildPortsToSweep(basePorts, runDir, serverEnvPath) {
  const ttsPort = resolveSidecarSweepPort(runDir, serverEnvPath);
  return ttsPort ? [...basePorts, ttsPort] : [...basePorts];
}
