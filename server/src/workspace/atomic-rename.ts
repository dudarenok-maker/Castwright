/* Atomic rename with cloud-sync-friendly retry. Extracted from state-io.ts
   so the export writers can share the same backoff.

   The retry is load-bearing on this repo's Windows host whenever the
   destination lives inside a cloud-sync mount:
   - OneDrive: a `rename(2)` landing inside the change-detection window
     briefly sees the destination locked (EPERM/EBUSY) or, for ENOENT,
     the just-written tmp file moved into OneDrive's own staging dir for
     scanning and dropped back milliseconds later.
   - Google Drive for Desktop (Drive File Stream): the virtual FS
     intermittently surfaces EACCES while sync metadata flushes, and
     EIO if the local cache snapshot is mid-rotation.
   Anything outside this allow-list is a real fault — surface immediately
   so the caller can wrap it with a destination-specific hint. */

import { rename } from 'node:fs/promises';

/* Base backoff schedule. The tail was extended (added 1000ms) for the case the
   budget proved too small for: many `writeJsonAtomic` calls racing the SAME
   target (Phase 0 + Phase 1 both save `state.json`). 20-way contention on a
   loaded Windows CI runner exhausted the prior ~800ms budget (#915). */
const RENAME_RETRY_DELAYS_MS = [25, 75, 200, 500, 1000];

/* Add up to 100% randomised jitter to each backoff so N writers retrying the
   SAME target do not retry in lockstep. Without jitter, concurrent retriers
   wake on the identical schedule and re-collide on the rename every round
   (thundering herd) — the real driver of #915's intermittent EPERM, more than
   the budget size. Pure + injectable RNG so the jitter stays unit-testable. */
export function jitteredDelayMs(baseMs: number, rand: () => number = Math.random): number {
  return baseMs + Math.floor(rand() * baseMs);
}

/* Codes worth retrying. Per the comment above this is intentionally broad
   for cloud-sync mounts; the cost of an extra retry on a transient failure
   is much smaller than the cost of surfacing a misleading hard error to
   the user. */
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'EPERM',
  'EBUSY',
  'ENOENT',
  'EACCES',
  'EIO',
]);

export async function renameWithRetry(src: string, dest: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt++) {
    try {
      await rename(src, dest);
      return;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (!code || !RETRYABLE_CODES.has(code)) throw e;
      lastErr = e;
      if (attempt === RENAME_RETRY_DELAYS_MS.length) break;
      await new Promise((r) => setTimeout(r, jitteredDelayMs(RENAME_RETRY_DELAYS_MS[attempt])));
    }
  }
  throw lastErr;
}
