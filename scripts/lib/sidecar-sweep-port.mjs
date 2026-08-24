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

function parseLocalTtsPortFromServerEnv(serverEnvPath) {
  // #2632 N36 — process.loadEnvFile (server/src/load-env.ts) does NOT
  // overwrite an already-present process.env entry, so a shell-exported
  // LOCAL_TTS_PORT wins over server/.env for the real server process too.
  // Mirror that precedence here: if THIS shell has LOCAL_TTS_PORT set, that
  // is the value the server would also resolve to (same shell, same
  // load-env semantics) — prefer it over the file rather than naming a
  // configured-but-overridden port.
  if (process.env.LOCAL_TTS_PORT) {
    return parseLocalTtsPortValue(process.env.LOCAL_TTS_PORT);
  }
  try {
    const raw = readFileSync(serverEnvPath, 'utf8');
    const match = raw.match(/^\s*LOCAL_TTS_PORT\s*=\s*(\S+)\s*$/m);
    if (!match) return null;
    return parseLocalTtsPortValue(match[1]);
  } catch {
    // Missing/unreadable server/.env — no fallback available from here.
  }
  return null;
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
