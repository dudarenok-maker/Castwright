/* #2133/#2239 — a reject's two writes (the `rejectedPairs` entry on
   cast-id-history.json and the one-sided `notLinkedTo` edge on cast.json)
   are created together and must be destroyed together (see
   `docs/features/278-cast-character-identity.md`'s invariant of the same
   name). `retireCharacterId` reports a dropped self-loop pair
   (`droppedSelfLoopRejections`) but never touches cast.json itself — this
   module is the caller-side half: a fresh read-through-write on cast.json.

   MODULE CONTRACT (#2239 Acceptance 2): `clearNotLinkedEdgesForDroppedRejections`
   takes its OWN `withCastLock` for `bookDir` and MUST NOT be called by
   anything that already holds the cast lock for that book — per CLAUDE.md's
   cast-lock rule 1 ("a locked function must not call another locked function
   on the same book"), doing so deadlocks — since #2260 surfacing as a
   `LockAcquisitionTimeoutError` after 10s (workspace/file-lock.ts) rather than
   hanging forever, but the call still fails and the rule stands. This
   supersedes the file-scoped reasoning this helper carried
   while it lived in `routes/analysis.ts` ("none of `recordRetirements`'
   callers *in this file* hold one for this book already") — that claim
   stopped covering every caller the moment #2238 exported the helper into a
   second route module, which is exactly why it is stated here as a module
   contract instead: it binds every caller, not just the ones that existed
   when it was written.

   A caller that ALREADY holds the cast lock for `bookDir` (`cast-merge.ts`,
   which folds this cleanup into the SAME lock span as its cast.json write —
   see #2239's "Why" item 3) uses the lock-free
   `clearNotLinkedEdgesForDroppedRejectionsLocked` instead. Deliberately PURE
   — no fs, no locking — so it mutates the caller's already-in-memory roster
   in place rather than issuing a second, redundant read inside a lock span
   whose whole point is one atomic read-through-write. NOT the same motive as
   `reject-edge-reconcile.ts`'s purity, despite the surface similarity: that
   module is pure AND immutable (`{ ...c, notLinkedTo: kept }`, returns
   `next`) specifically because a `writeJsonAtomic(castJsonPath(` living in
   that file would scan as unlocked under `cast-lock.guard.test.ts`'s
   per-file textual scan — it has no locked/lock-free pair and no fs at all.
   This module's own write IS textually locked, in this same file, so that
   motive doesn't transfer here; the purity above is only about avoiding a
   redundant read. This departs from the `applyToBook` /
   `applyToBookLocked` precedent's implementation shape (there, the `Locked`
   half does its own read AND write, just without taking the lock itself);
   the `Foo` / `FooLocked` naming is kept because it makes the "caller must
   already hold the lock" contract visible at every call site, which is the
   part of that precedent this module is following.

   Best-effort: a failure in the locked variant must not fail the retirement
   itself, mirroring every other id-history write in this area — the
   side-table is never authoritative for identity, and a surviving stale edge
   merely re-suppresses one future §4.4 name-match rather than corrupting
   anything already on disk. */

import type { CharacterOutput } from '../handoff/schemas.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { withCastLock } from '../workspace/cast-lock.js';
import { isLockAcquisitionTimeout } from '../workspace/file-lock.js';

/** Lock-free half — the caller must already hold `withCastLock(bookDir, …)`.
 *  Mutates `characters` in place (matching the locked variant's own
 *  mutate-in-place semantics) and returns whether anything changed, so the
 *  caller decides whether a write is owed. No fs, no locking — see the file
 *  header's MODULE CONTRACT. */
export function clearNotLinkedEdgesForDroppedRejectionsLocked(
  characters: CharacterOutput[],
  bookId: string,
  dropped: ReadonlyArray<{ from: string; to: string }>,
): boolean {
  const deadIds = new Set(dropped.map((p) => p.from));
  let changed = false;
  for (const character of characters) {
    const existing = character.notLinkedTo ?? [];
    if (!existing.length) continue;
    const next = existing.filter((p) => !(p.bookId === bookId && deadIds.has(p.characterId)));
    if (next.length !== existing.length) {
      character.notLinkedTo = next;
      changed = true;
    }
  }
  return changed;
}

/** Locked half — takes its own `withCastLock` for `bookDir`. See the file
 *  header's MODULE CONTRACT for the precondition this exists to satisfy: the
 *  caller must NOT already hold the cast lock for `bookDir`.
 *
 *  #2694 — returns the payload actually written (so the caller can advance
 *  its `CastMergeBase` via `noteExternalWrite`), or `null` when nothing was
 *  written (unchanged, or the empty-cast early return). This is a FRESH-READ
 *  read-through-write — see the `#2694 residual` comment on the read below —
 *  so the returned payload is this call's own view of the file, not
 *  necessarily a merge of every write since the run started; the caller
 *  advances its baseline to match exactly what landed on disk here. */
export async function clearNotLinkedEdgesForDroppedRejections(
  bookDir: string,
  bookId: string,
  dropped: ReadonlyArray<{ from: string; to: string }>,
): Promise<{ characters: CharacterOutput[] } | null> {
  try {
    return await withCastLock(bookDir, async () => {
      /* #2694 residual — this is a FRESH read, not a continuation of any
         earlier read in this run. A genuine foreign write landing after this
         run's last `noteExternalWrite`/`writeChecked` advance but BEFORE this
         read is absorbed into the read rather than detected: no data is
         lost (the fresh read preserves whatever that write left), but that
         one foreign write goes unreported. This is a NEW gap introduced by
         #2694 — pre-fix, such a write was detected (accidentally via the stale
         baseline advancing only at `writeChecked` sites), but it fired on the
         run's OWN writes too and could not distinguish them from real foreign
         writes, so the pre-fix advisory was noise. Post-fix, the run's own
         writes trigger `noteExternalWrite` to advance the baseline, the phantom
         vanishes, and a detection gap opens for this narrow window. Still the
         right trade: a foreign write this fresh (mid-run, mid-lock, undetected
         by any `writeChecked` site's compare) is much less likely than the
         phantom-on-every-multi-chapter-book cost of the old design. Not worth
         widening scope to close — the benefit is asymmetric. */
      const cast = await readJson<{ characters?: CharacterOutput[] }>(castJsonPath(bookDir));
      if (!cast?.characters?.length) return null;
      const changed = clearNotLinkedEdgesForDroppedRejectionsLocked(cast.characters, bookId, dropped);
      if (!changed) return null;
      const payload = { ...cast, characters: cast.characters };
      await writeJsonAtomic(castJsonPath(bookDir), payload);
      return payload;
    });
  } catch (err) {
    /* #2260 round 2 — the file header's "best-effort" contract is scoped to a
       disk fault (EPERM/ENOSPC/AV-lock), where a surviving stale edge merely
       re-suppresses one future §4.4 name-match. A withKeyLock ACQUISITION
       timeout on `cast:<bookDir>` is a different animal: it is the shape a
       rule-1/rule-4 violation OR ordinary contention produces, and swallowing
       it hands the caller a silent success on work that never happened. Let
       exactly that one class through — the callers above
       (`recordRetirements`, cast-link-orphan.ts) decide what it means. */
    if (isLockAcquisitionTimeout(err)) throw err;
    console.warn(
      '[not-linked-edges] failed to clear a dropped-rejection notLinkedTo edge (non-fatal)',
      err,
    );
    return null;
  }
}
