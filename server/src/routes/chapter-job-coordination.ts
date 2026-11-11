/* Cross-route mutual exclusion between a full chapter regen (generation.ts)
   and an fs-26 splice (chapter-splice.ts) of the SAME chapter. Both write the
   same `<slug>.mp3` + `.segments.json` pair, so they must never run together —
   the loser would interleave its atomic writes with the winner's and leave a
   mismatched mp3/segments pair.

   This module owns ONLY the splice side of the registry so the two routes
   stay acyclic: generation.ts imports `abortInFlightSplice` (no import of the
   splice route); chapter-splice.ts imports `registerSplice` here AND
   `abortInFlightChapterJob` from generation.ts. generation.ts never imports the
   splice route. */

import { setInFlightSpliceCounter, setSpliceEpochReader } from '../gpu/active-generation-gate.js';

const inFlightSplices = new Map<string, AbortController>();

/* #4066 — a splice and a QA repair hold the GPU but are invisible to
   generation's `inFlightByBook`; hand the leaf gate this registry's count so
   `isAnyGenerationActive()` sees them (the gate imports nothing, so this edge
   cannot close a cycle). */
setInFlightSpliceCounter(() => inFlightSplices.size);

/* #4075 — monotonic count of registrations, so the gate's quiet-poll rule can
   see a splice that registered and released between two polls. */
let spliceEpoch = 0;
setSpliceEpochReader(() => spliceEpoch);

function key(bookId: string, chapterId: number): string {
  return `${bookId}::${chapterId}`;
}

/** Register a splice as the in-flight holder for `(bookId, chapterId)`. A
    second splice for the same chapter displaces (aborts) the first. Returns a
    cleanup that removes this controller iff it's still the registered holder. */
export function registerSplice(
  bookId: string,
  chapterId: number,
  controller: AbortController,
): () => void {
  spliceEpoch += 1;
  const k = key(bookId, chapterId);
  const prev = inFlightSplices.get(k);
  if (prev) prev.abort();
  inFlightSplices.set(k, controller);
  return () => {
    if (inFlightSplices.get(k) === controller) inFlightSplices.delete(k);
  };
}

/** Abort any in-flight splice for `(bookId, chapterId)`. Called by the
    generation route when it starts a job for that chapter so a fresh regen
    displaces a concurrent splice. No-op when nothing is in flight. */
export function abortInFlightSplice(bookId: string, chapterId: number | null): void {
  if (chapterId == null) return; // back-compat '*' job spans many chapters; nothing to key on
  inFlightSplices.get(key(bookId, chapterId))?.abort();
}

/** Test-only: is a splice currently registered for this chapter? */
export function _hasInFlightSplice(bookId: string, chapterId: number): boolean {
  return inFlightSplices.has(key(bookId, chapterId));
}
