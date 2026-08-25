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

    Four things this MUST match about process.loadEnvFile, all measured
    directly against the real function rather than assumed:
    - #2632 N36: a shell-exported value wins over the file — loadEnvFile
      never overwrites an already-present process.env entry, so if THIS
      shell already has `key` set, that's the value the server would also
      resolve to.
    - #2632 N42: on a DUPLICATE key, loadEnvFile takes the LAST assignment
      (later `process.env[key] = value` calls simply overwrite earlier
      ones) — so this reader must take the last matching line too, not the
      first, or it can target a port the server never actually bound to.
    - #2632 N52 — BOM: a leading UTF-8 BOM (EF BB BF) decodes to U+FEFF, and
      JS regex `\s` treats U+FEFF as whitespace — but process.loadEnvFile
      does NOT strip a leading BOM before parsing keys, so a BOM-prefixed
      first line's key is literally "<BOM>LOCAL_TTS_PORT", which never
      matches plain "LOCAL_TTS_PORT" (measured: process.env.LOCAL_TTS_PORT
      stays undefined). A reader whose leading `\s*` swallows the BOM
      matches a key the server never actually sees. Use an explicit
      space/tab class instead so the BOM byte blocks the match here exactly
      like it blocks the server's own key lookup.
    - #2632 N52 — inline comments: process.loadEnvFile strips an unquoted
      value's trailing `#...` comment (measured: `PORT=9011 # x` and even
      `PORT=9011#x` both resolve process.env.PORT to "9011", trimmed). A
      regex that requires the captured token to run all the way to
      end-of-line with no trailing comment simply fails to match a
      commented duplicate's LAST line — silently reverting to an EARLIER
      line's value the server has already overwritten. This reader must
      strip the same comment and trim the same way before validating. */
function resolvePortFromEnvFile(envPath, key) {
  if (process.env[key]) {
    return parseLocalTtsPortValue(process.env[key]);
  }
  try {
    const raw = readFileSync(envPath, 'utf8');
    // #2632 N48 — 'i' flag: process.env is case-insensitive on Windows, so
    // process.loadEnvFile setting process.env.PORT from a `port=`/`Port=`
    // line there is real behaviour, not a spelling this reader may ignore.
    // #2632 N52 — leading/trailing class is `[ \t]`/`[ \t\r]`, NOT `\s`:
    // `\s` matches U+FEFF (BOM), which would let a BOM-prefixed key match
    // here when the server's own parser never sees it as that key. `.*`
    // captures the rest of the line (comment included) so it can be
    // stripped below, rather than requiring the value to run to EOL.
    const re = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(.*)$`, 'gmi');
    let match;
    let lastValue = null;
    while ((match = re.exec(raw)) !== null) {
      let value = match[1].replace(/\r$/, '');
      const hashIndex = value.indexOf('#');
      if (hashIndex !== -1) value = value.slice(0, hashIndex);
      lastValue = value.trim();
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
    Vite-side sibling of resolveConfiguredServerPort (#2632 N39), sharing
    ITS OWN reader's process.loadEnvFile-mirroring contract. That contract
    is THIS reader's only, not Vite's: `vite.config.ts` reads VITE_PORT
    itself via Vite's `loadEnv` (dotenv-based) plus a bare `Number()` — a
    different parser with different rules (no BOM handling, no digit-only
    gate, silently coerces spellings `parseLocalTtsPortValue` rejects). Any
    divergence between the two readers fails safe (this one only decides
    what stop-app.ps1 sweeps, never what Vite actually binds to), so no
    behaviour change follows from this being two separate parsers — it's
    noted here only so this reader isn't mistaken for Vite's own. Only
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

/** Decide the final stop-summary line (or none), so stop-app.mjs/.ps1 stop
    unconditionally claiming "[OK] nothing to stop" (#2632 N53). Three
    distinct outcomes were being collapsed into one message:
    - a PID kill actually happened (killedAny) — the per-item [STOP] lines
      already said so, no summary needed;
    - the sweep found something it could not resolve/clear (sweepIncomplete:
      stop-app.ps1's Stop-Process was denied; stop-app.mjs's probe still
      found a listener) — claiming "nothing to stop" here is false
      reassurance, and the [SWEEP]/[WARN] line above already reported it;
    - zero ports resolved for this checkout at all (portsToSweep is empty) —
      this means "nothing was CHECKED", not "checked and found clear", and
      must read differently from the confirmed-clear case.
    Pulled out (mirrors buildPortsToSweep) so this decision is itself
    unit-testable without spinning up real listeners/PIDs. */
export function getStopSummaryMessage(killedAny, sweepIncomplete, portsToSweep) {
  if (killedAny) return null;
  if (sweepIncomplete) return null;
  if (portsToSweep.length === 0) {
    return '[OK] nothing to stop (no ports resolved for this checkout)';
  }
  return '[OK] nothing to stop';
}
