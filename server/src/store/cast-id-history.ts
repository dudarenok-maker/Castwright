/* Per-book character id history side-table.

   Tracks which character ids have been superseded and what they were
   replaced with. Stored as a separate JSON file under .audiobook/
   so no schema change is needed on Character or openapi.yaml.

   The supersededBy map is transitive: if a→b then b→c, both a and b
   map to c for O(1) resolution without chasing — regardless of which of
   the two retirements is recorded first. */

import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { withKeyLock } from '../workspace/file-lock.js';

export interface CastIdHistory {
  schema: 1;
  supersededBy: Record<string, string>;
  /** #2040 Task 14 review item 2b — ids `dropSupersededIdsReclaimedByLiveCast`
   *  dropped from `supersededBy` because a fresh roster reclaimed the key as a
   *  live cast id, keyed the same way `supersededBy` was before the drop
   *  (id -> what it used to resolve to). This is the only surviving record of
   *  that pair once the drop runs — losing it would mean every book that
   *  re-analyses before Wave 3's banner ships loses the pair for good.
   *  Additive and backwards-compatible: optional, never bumps `schema`. An
   *  old reader that doesn't know this key still works — it only ever reads
   *  `supersededBy`, which is unaffected. A file written before this change
   *  simply has no `displaced` key; `loadCastIdHistory` tolerates its
   *  absence. */
  displaced?: Record<string, string>;
}

export function castIdHistoryPath(bookDir: string): string {
  return join(bookDir, '.audiobook', 'cast-id-history.json');
}

/** Load the cast id history from disk. Returns empty history if missing or malformed.
 *  Never throws — a lookup side-table must not be able to break a book's render.
 *  `displaced` is optional (#2040 Task 14 review item 2b) — absent entirely
 *  on a file written before that change, and validated the same way as
 *  `supersededBy` when present so a malformed `displaced` can't sneak a
 *  throw past a caller that only reads `supersededBy`. */
export async function loadCastIdHistory(bookDir: string): Promise<CastIdHistory> {
  try {
    const raw = await readJson<CastIdHistory>(castIdHistoryPath(bookDir));
    if (
      raw &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      raw.schema === 1 &&
      typeof raw.supersededBy === 'object' &&
      !Array.isArray(raw.supersededBy) &&
      raw.supersededBy !== null &&
      (raw.displaced === undefined ||
        (typeof raw.displaced === 'object' &&
          !Array.isArray(raw.displaced) &&
          raw.displaced !== null))
    ) {
      return raw;
    }
  } catch {
    // Malformed JSON or other read error — return empty
  }
  return { schema: 1, supersededBy: {} };
}

/** Record that characterId `from` has been retired and replaced by `to`.
 *  Updates transitive mappings: whether a→b then b→c is recorded, or b→c
 *  then a→b, both a and b end up pointing to c in the final map (O(1)
 *  resolution). */
export async function retireCharacterId(
  bookDir: string,
  from: string,
  to: string,
): Promise<void> {
  // No-op if from === to
  if (from === to) {
    return;
  }

  // Serialize writes per-book
  const bookId = bookDir; // Use bookDir as the lock key
  return withKeyLock(`cast-id-history:${bookId}`, async () => {
    const history = await loadCastIdHistory(bookDir);

    /* Direct reversal (#2040 Task 8 fix round 1, item 3): `to` is itself
       recorded as having been retired in favour of `from` — an earlier call
       said `to -> from`, and this call says the opposite, `from -> to`. Both
       can't be true; the newer call reflects the newer roster and wins.
       Falling through to the forward-dereference below would instead
       resolve `to` through the stale chain back to `from` and write a dead
       self-loop (`from -> from`), while leaving the stale `to -> from`
       entry live — orphaning BOTH ids, since neither's target is a live
       row. Repro (review round 1): dedupe records "антон"->"anton", a later
       remap records the reverse "anton"->"антон"; without this branch the
       history ends up `{"антон":"anton","anton":"anton"}` and
       buildCastResolver drops both. Invert instead: drop the stale entry,
       repoint anything that targeted `from` at `to`, and write `from -> to`. */
    if (history.supersededBy[to] === from) {
      delete history.supersededBy[to];
      for (const [key, value] of Object.entries(history.supersededBy)) {
        if (value === from) {
          history.supersededBy[key] = to;
        }
      }
      history.supersededBy[from] = to;
      await writeJsonAtomic(castIdHistoryPath(bookDir), history);
      return;
    }

    // Dereference 'to' through any existing chain first, so the repoint
    // below is order-independent — retiring INTO an already-superseded id
    // must land on its live target, not the stale intermediate.
    const resolvedTo = history.supersededBy[to] ?? to;

    // Never write a self-entry — it would resolve nowhere. The reversal
    // branch above already covers the only way resolvedTo can equal `from`,
    // but keep this as a defensive guard against future changes here.
    if (from === resolvedTo) {
      return;
    }

    // Find all keys that currently point to 'from' and update them to 'to'
    for (const [key, value] of Object.entries(history.supersededBy)) {
      if (value === from) {
        history.supersededBy[key] = resolvedTo;
      }
    }

    // Add/update the new mapping
    history.supersededBy[from] = resolvedTo;

    // Write back
    await writeJsonAtomic(castIdHistoryPath(bookDir), history);
  });
}

/** Split a batch of retirements into the ones that may be recorded and the
 *  ones that must not, given the roster that is actually live.
 *
 *  Wave 2 final-review finding 1(b), defence in depth for the Critical the
 *  same review found in `remapFreshToPriorIds`. `retireCharacterId` repoints
 *  every entry whose VALUE is `from` (:123-127) — sound only when `from` is
 *  genuinely dead, which is what the history entry asserts. A retirement whose
 *  `from` is a LIVE cast id is therefore bogus by definition, and recording it
 *  does damage that `dropSupersededIdsReclaimedByLiveCast` cannot undo: that
 *  function removes the reclaimed KEY at the end of the run, after the
 *  collateral repoint has already rewritten unrelated chains onto the wrong
 *  character.
 *
 *  Judged on `from` only. `to` being live is the normal, required case — a
 *  guard that tested `to` would refuse every legitimate retirement and let the
 *  dangerous one through.
 *
 *  Pure and synchronous, like the retirement producers themselves; the caller
 *  (`analysis.ts`'s `recordRetirements`) holds both the persisted roster and
 *  the run log, and is responsible for surfacing anything refused. */
export function refuseRetirementsOfLiveIds<T extends { from: string; to: string }>(
  retirements: ReadonlyArray<T>,
  liveIds: ReadonlyArray<string>,
): { keep: T[]; refused: T[] } {
  const live = new Set(liveIds);
  const keep: T[] = [];
  const refused: T[] = [];
  for (const entry of retirements) {
    if (live.has(entry.from)) refused.push(entry);
    else keep.push(entry);
  }
  return { keep, refused };
}

/** A history entry dropped because a fresh roster reintroduced its key as a
 *  live cast id. `id` is the (formerly-superseded) history key; `supersededBy`
 *  is what it used to resolve to before the live row reclaimed it. */
export interface DisplacedHistoryEntry {
  id: string;
  supersededBy: string;
}

/** §4.4's closing paragraph: resolution is exact-id-first, so a fresh
 *  roster's live row always wins over a history entry keyed to the same id —
 *  silently, with no tie and no warning. Once that happens the entry no
 *  longer protects anything (a segment still carrying the old id resolves
 *  straight to the live row, never through history), so it must be dropped
 *  rather than left to rot and mislead the next read. Called once per
 *  analysis write, after the roster that will be persisted is final.
 *
 *  The dropped pairs are moved into `displaced` (#2040 Task 14 review item
 *  2b), not discarded — once dropped, `supersededBy` is the ONLY place they
 *  lived, and losing them means every book that re-analyses before Wave 3's
 *  banner ships permanently loses the pair (the segments become genuinely
 *  unattributable, not just unreported). `displaced` accumulates across
 *  calls/runs KEY BY KEY: a later drop merges its pairs into the existing map
 *  rather than replacing it, so a key dropped by an earlier run survives a
 *  later drop that does not mention it. It is NOT append-only per key —
 *  dropping the same id twice overwrites the first pair with the second,
 *  keeping only the most recent target. Deliberate: `displaced` records what
 *  an id last resolved to, not its full lineage.
 *
 *  Returns the dropped entries so the caller can also log them immediately
 *  (operator-visible, #2040 Task 14 review item 2a) and so a future banner
 *  can surface what needs review (§4.6, Wave 3); this function only drops,
 *  persists, and reports — it does not decide what happens next.
 *
 *  Always writes, even when nothing was dropped (#2040 Task 14 review item
 *  3) — a prior version skipped the write when `dropped` was empty, which
 *  made "does not write" an untested claim. Never throws on read
 *  (loadCastIdHistory's own guarantee); a throw can still come from the
 *  write — same as retireCharacterId, callers must guard it. */
export async function dropSupersededIdsReclaimedByLiveCast(
  bookDir: string,
  liveIds: ReadonlyArray<string>,
): Promise<DisplacedHistoryEntry[]> {
  const live = new Set(liveIds);
  return withKeyLock(`cast-id-history:${bookDir}`, async () => {
    const history = await loadCastIdHistory(bookDir);
    const dropped: DisplacedHistoryEntry[] = [];
    for (const [key, target] of Object.entries(history.supersededBy)) {
      if (live.has(key)) {
        dropped.push({ id: key, supersededBy: target });
        delete history.supersededBy[key];
      }
    }
    if (dropped.length) {
      const displaced = { ...(history.displaced ?? {}) };
      for (const entry of dropped) {
        displaced[entry.id] = entry.supersededBy;
      }
      history.displaced = displaced;
    }
    await writeJsonAtomic(castIdHistoryPath(bookDir), history);
    return dropped;
  });
}
