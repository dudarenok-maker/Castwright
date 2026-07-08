/* srv-36 hardening — persists the retry-attempt counter for characters whose
   audition-centroid fallback synthesis transiently failed (auditionCentroid
   returned null — a real synth/embed throw, "sidecar unavailable, bail
   entirely"). Deliberately a SEPARATE artifact from centroids.json: a row in
   centroids.json is always a fully-resolved CharacterCentroid (see that
   module's doc comment and every existing reader's all-required-fields
   assumption, e.g. the repair route's unconditional `cleanMean` read) — this
   file exists so the retry count never has to live inside that contract.

   File: `<bookDir>/audio/render-integrity.pending-attempts.json`
   Shape: Record<characterId, number> — a character with no entry has never
   had a transient failure (or already resolved/degraded past one). */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from '../../workspace/state-io.js';
import { audioDir } from '../../workspace/paths.js';

const PENDING_ATTEMPTS_FILENAME = 'render-integrity.pending-attempts.json';

function pendingAttemptsPath(bookDir: string): string {
  return join(audioDir(bookDir), PENDING_ATTEMPTS_FILENAME);
}

/** Write the full counts map atomically — overwrites any prior file. */
export async function writePendingAttempts(
  bookDir: string,
  counts: Record<string, number>,
): Promise<void> {
  await writeJsonAtomic(pendingAttemptsPath(bookDir), counts);
}

/** Read the counts map. Returns null on ENOENT (no transient failures yet). */
export async function readPendingAttempts(
  bookDir: string,
): Promise<Record<string, number> | null> {
  let raw: string;
  try {
    raw = await readFile(pendingAttemptsPath(bookDir), 'utf8');
  } catch (e) {
    if (e && (e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  return JSON.parse(raw) as Record<string, number>;
}
