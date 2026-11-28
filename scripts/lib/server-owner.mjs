// scripts/lib/server-owner.mjs — the server's owner marker (#3264).
//
// `<runDir>/server.owner.<port>.json` records which process serves the port it
// actually bound, following the sidecar's `tts.owner.<port>.json`
// (server/src/tts/sidecar-owner.ts). The run dir is this checkout's own, so a
// marker there identifies our server without a network probe. Plain ESM so the
// launchers can import it as well as the server: the filename and format live
// in one place.
//
// Pure fs: no network, no sleep.

import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pidIsAlive } from './pid-alive.mjs';

const MARKER_NAME = /^server\.owner\.(\d+)\.json$/;

export function serverOwnerPath(runDir, port) {
  return join(runDir, `server.owner.${port}.json`);
}

export function writeServerOwner({
  runDir,
  port,
  https,
  pid = process.pid,
  now = () => new Date(),
}) {
  mkdirSync(runDir, { recursive: true });
  const note = { pid, port, https, startedAt: now().toISOString() };
  writeFileSync(serverOwnerPath(runDir, port), JSON.stringify(note), 'utf8');
}

/** The parsed marker, or null when it is absent, unreadable, malformed, has no
 *  positive integer pid, or records a different port. */
export function readServerOwner(runDir, port) {
  try {
    const note = JSON.parse(readFileSync(serverOwnerPath(runDir, port), 'utf8'));
    if (!Number.isInteger(note.pid) || note.pid <= 0 || note.port !== port) return null;
    return {
      pid: note.pid,
      port,
      https: note.https === true,
      startedAt: typeof note.startedAt === 'string' ? note.startedAt : '',
    };
  } catch {
    return null;
  }
}

function removeMarker(runDir, port) {
  try {
    unlinkSync(serverOwnerPath(runDir, port));
  } catch {
    /* already gone or inaccessible — best-effort */
  }
}

/** Delete the marker only while it still records `pid`. */
export function releaseServerOwner(runDir, port, pid = process.pid) {
  if (readServerOwner(runDir, port)?.pid === pid) removeMarker(runDir, port);
}

/** Delete the markers left behind by processes that are gone. An unreadable
 *  marker names no pid, so it is left alone. */
export function pruneDeadServerOwners(runDir, alive = pidIsAlive) {
  let names;
  try {
    names = readdirSync(runDir);
  } catch {
    return; // no run dir yet
  }
  for (const name of names) {
    const match = MARKER_NAME.exec(name);
    if (!match) continue;
    const port = Number(match[1]);
    const note = readServerOwner(runDir, port);
    if (note && !alive(note.pid)) removeMarker(runDir, port);
  }
}
