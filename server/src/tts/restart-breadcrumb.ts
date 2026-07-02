/* Reads the breadcrumb the sidecar persists (server/tts-sidecar/main.py,
   _write_restart_breadcrumb) right before a code-43 self-exit — the ONLY way
   the Node supervisor can learn which card triggered a restart, since
   onChildExit(code, signal) carries neither (Wave 2 §W2.5). */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* This file lives at server/src/tts/restart-breadcrumb.ts (dev, via tsx) or
   compiles to server/dist/tts/restart-breadcrumb.js (prod, via tsc — rootDir
   src/, outDir dist/, so the two trees mirror each other). Either way it's
   two levels below server/, matching the sibling `../../tts-sidecar/...`
   relative import already used in spawn-sidecar.ts — NOT three, which would
   escape past the server/ dir entirely. */
const BREADCRUMB_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'tts-sidecar', '.run', 'last-restart-trip.json',
);

export interface RestartBreadcrumb {
  card: unknown;
  reason: string;
  residentEngines: string[];
}

/** Best-effort read of the sidecar's last-restart-trip breadcrumb. Returns
    null on any failure (missing file, malformed JSON) — the caller treats a
    trip with no card info as a degraded-but-still-valid trip. */
export function readRestartBreadcrumb(): RestartBreadcrumb | null {
  try {
    const body = JSON.parse(readFileSync(BREADCRUMB_PATH, 'utf-8')) as Record<string, unknown>;
    return {
      card: body.card ?? null,
      reason: typeof body.reason === 'string' ? body.reason : 'unknown',
      residentEngines: Array.isArray(body.residentEngines) ? (body.residentEngines as string[]) : [],
    };
  } catch {
    return null;
  }
}
