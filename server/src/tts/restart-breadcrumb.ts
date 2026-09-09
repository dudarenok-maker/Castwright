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

/** One card's discovery row, matching main.py's `_sample_card()` shape. */
export interface RestartBreadcrumbDevice {
  uuid: string;
  idx: number;
  name: string;
  total_mb: number;
  free_mb: number;
}

export interface RestartBreadcrumb {
  card: unknown;
  reason: string;
  residentEngines: string[];
  /** Full per-card free-VRAM enumeration, captured by the sidecar a moment
      BEFORE it exits (main.py's `_write_restart_breadcrumb`) — added PR
      #3113 pass 3. This is the only source of "which OTHER card has room"
      data available to a downstream auto-revert: by the time anything reads
      this breadcrumb, the process that could answer a live `/devices` query
      is the one that just crashed. Empty array (not missing) when CUDA is
      unavailable or enumeration failed on the sidecar side; absent
      (undefined) only when reading an OLDER breadcrumb written before this
      field existed. */
  devices?: RestartBreadcrumbDevice[];
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
      devices: Array.isArray(body.devices) ? (body.devices as RestartBreadcrumbDevice[]) : undefined,
    };
  } catch {
    return null;
  }
}
