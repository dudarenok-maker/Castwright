// #2632 N27 — the sidecar port stop-app.mjs's belt-and-braces listener sweep
// probes is per-checkout since #2632 (LOCAL_TTS_PORT), not always the
// factory default :9000. A hardcoded 9000 in the sweep list warns about
// (stop-app.ps1's sibling force-kills) whatever is listening there from a
// worktree whose own sidecar lives on a different port — typically the
// PRIMARY checkout's sidecar, mid-generation.
//
// The Node server already records the port it actually owns in
// .run/tts.owner.json (SidecarOwnerNote, server/src/tts/sidecar-owner.ts) the
// moment it claims ownership, so read THAT instead of assuming 9000. Absent
// or unreadable — no sidecar ever claimed ownership this run, or the note is
// corrupt — falls back to the factory default 9000, the prior behaviour.
//
// Pure + side-effect-free (only reads a file) so it's directly unit-testable
// without executing stop-app.mjs's real taskkill/probe flow.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Resolve the sidecar port this checkout's `.run/` directory recorded
    ownership of, falling back to the factory default 9000 when the note is
    absent, unreadable, corrupt, or carries an out-of-range port. */
export function resolveSidecarSweepPort(runDir) {
  const notePath = resolve(runDir, 'tts.owner.json');
  try {
    const raw = readFileSync(notePath, 'utf8');
    const note = JSON.parse(raw);
    const port = Number(note?.port);
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      return port;
    }
  } catch {
    // Absent, unreadable, or corrupt — fall through to the default.
  }
  return 9000;
}
