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
  /** #2040 Task 17 — orphaned character ids the user has explicitly said are
   *  NOT the same character as whatever they'd otherwise resolve onto (the
   *  banner's "not the same character" action, spec §4.6). Checked by
   *  `buildCastResolver` AFTER the `exact` tier but ahead of the other
   *  three (history / normalised-id / normalised-history) — fix round 1: an
   *  earlier version of this checked `rejected` before `exact` too, which
   *  reintroduced #2040's original bug for any rejected id a LATER analysis
   *  reclaims as a genuine live cast row (a real risk — an orphaned id is
   *  very often the character's own name, so a re-analysis minting that
   *  exact id again is the expected case, not an edge case). A live exact
   *  match always wins over a stale rejection, mirroring the same principle
   *  `dropSupersededIdsReclaimedByLiveCast` established for `supersededBy`:
   *  liveness beats history. The alias/normalised tiers stay suppressed by
   *  rejection because a plain reject that only deleted a `supersededBy`
   *  entry would be a no-op for the two normalised tiers, which have no
   *  history entry to remove at all (see the controller ruling in
   *  `.superpowers/sdd/2026-08-01-cast-character-identity/progress.md`), so
   *  `rejected` is the only mechanism that stops read-side resolution
   *  through those three. Additive and backwards-compatible, same
   *  shape/strictness as `displaced`: optional, never bumps `schema`. An old
   *  reader that doesn't know this key still works — it only ever reads
   *  `supersededBy`/`displaced`, which are unaffected. */
  rejected?: string[];
  /** #2092/#2089 (design settled 2026-08-05, D1) — the pair-scoped successor
   *  to `rejected`. `rejected` blocks an orphaned id against EVERY tier-2/3/4
   *  candidate; that turned out to cost more than it bought on the auto-
   *  reconciled path (the button's most common correct use), because
   *  `repair-cast-id-drift.mjs` pushes a rejected id to `skipped` before any
   *  candidate is computed — permanently, for every future analysis, even
   *  once a later roster mints the RIGHT target. A pair only blocks the
   *  specific `(from, to)` reconciliation the user actually saw and said no
   *  to; a different, later target for the same `from` id is unaffected.
   *
   *  `rejected` (above) is kept as a LEGACY, READ-ONLY field: still honoured
   *  by `buildCastResolver` for back-compat with any file written before this
   *  change, but no code path writes to it anymore — every new reject goes
   *  through `rejectedPairs` via `rejectOrphanedPair`.
   *
   *  `forgotSupersededTo`, when present, is the `supersededBy[from]` target
   *  `forgetSupersededId` removed at the moment this pair was recorded (D6).
   *  Stashing it here is what makes the undo (`unrejectOrphanedPair`,
   *  #2089) lossless: `forgetSupersededId` returns `Promise<void>` and
   *  nothing else on disk retains the removed mapping, so without this the
   *  alias would be unreconstructible once forgotten. Simply not calling
   *  `forgetSupersededId` at reject time was considered and rejected:
   *  `retireCharacterId`'s repoint loop rewrites every entry whose VALUE is
   *  a retired id, so a shadowed `supersededBy[from]=to` left behind could
   *  silently become `supersededBy[from]=someOtherId` later — the pair no
   *  longer matches what the resolver would actually do, and `from` would
   *  resolve onto a character the user never approved.
   *
   *  Additive and backwards-compatible, same shape/strictness discipline as
   *  `displaced`/`rejected`: optional, never bumps `schema`, validated
   *  INDEPENDENTLY of `rejected` (its own `Array.isArray` check) so a
   *  malformed `rejectedPairs` can't discard a well-formed legacy `rejected`
   *  list or vice versa — validation elsewhere in this file is all-or-
   *  nothing for the WHOLE file, so retyping `rejected` in place instead of
   *  adding a new field would have meant one malformed shape silently
   *  dropping `supersededBy` too. An old reader that doesn't know this key
   *  still works — it only ever reads `supersededBy`/`rejected`, which are
   *  unaffected. */
  rejectedPairs?: RejectedPair[];
}

/** One pair-scoped rejection: `from` (an orphaned id) is NOT the same
 *  character as `to` (a live cast id) — see `rejectedPairs`'s doc comment on
 *  `CastIdHistory` above for why this replaced the id-wide `rejected` list. */
export interface RejectedPair {
  from: string;
  to: string;
  /** The `supersededBy[from]` target `forgetSupersededId` removed at reject
   *  time, if any. Absent when there was nothing to forget (e.g. `from` only
   *  ever matched through a normalised tier, which has no `supersededBy`
   *  entry to begin with). */
  forgotSupersededTo?: string;
}

export function castIdHistoryPath(bookDir: string): string {
  return join(bookDir, '.audiobook', 'cast-id-history.json');
}

/** Load the cast id history from disk. Returns empty history if missing or malformed.
 *  Never throws — a lookup side-table must not be able to break a book's render.
 *  `displaced` is optional (#2040 Task 14 review item 2b) — absent entirely
 *  on a file written before that change, and validated the same way as
 *  `supersededBy` when present so a malformed `displaced` can't sneak a
 *  throw past a caller that only reads `supersededBy`. `rejected` (#2040
 *  Task 17) is validated the same way — absent entirely on a file written
 *  before this change, and required to be an array when present, so a
 *  malformed value falls back to the whole-file empty-history default
 *  instead of reaching a caller as a bad shape. `rejectedPairs` (#2092/#2089,
 *  D1) gets its OWN independent `Array.isArray` check, deliberately not
 *  folded into the `rejected` check above — the two fields are validated
 *  separately so a malformed `rejectedPairs` on an otherwise-fine file can't
 *  collapse the whole file to empty (discarding a well-formed `supersededBy`
 *  along with it) any more than a malformed `rejected` already can, and vice
 *  versa. Neither check bumps `schema`: an old reader that has never heard of
 *  `rejectedPairs` still works, since it only ever reads `supersededBy`/
 *  `rejected`.
 *
 *  A missing file is the common, expected case (most books never retire an
 *  id) and returns the empty default silently. A file that EXISTS but is
 *  unreadable or the wrong shape is different — every caller (including
 *  `buildCastResolver` at render time, srv-86) silently loses history-based
 *  protection when this happens, which must not read as "no protection
 *  needed". That case logs one `console.warn` naming the path and cause, so
 *  the degraded-protection state is operator-visible instead of silent. */
export async function loadCastIdHistory(bookDir: string): Promise<CastIdHistory> {
  const path = castIdHistoryPath(bookDir);
  try {
    const raw = await readJson<CastIdHistory>(path);
    if (raw === null) {
      // No file on disk — nothing has ever been retired for this book.
      return { schema: 1, supersededBy: {} };
    }
    if (
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      raw.schema === 1 &&
      typeof raw.supersededBy === 'object' &&
      !Array.isArray(raw.supersededBy) &&
      raw.supersededBy !== null &&
      (raw.displaced === undefined ||
        (typeof raw.displaced === 'object' &&
          !Array.isArray(raw.displaced) &&
          raw.displaced !== null)) &&
      (raw.rejected === undefined || Array.isArray(raw.rejected)) &&
      (raw.rejectedPairs === undefined || Array.isArray(raw.rejectedPairs))
    ) {
      return raw;
    }
    console.warn(
      `[cast-id-history] ${path} exists but has an unexpected shape — id-history protection disabled until it is fixed or removed.`,
    );
  } catch (err) {
    console.warn(
      `[cast-id-history] ${path} is unreadable (${(err as Error)?.message ?? err}) — id-history protection disabled until it is fixed or removed.`,
    );
  }
  return { schema: 1, supersededBy: {} };
}

/** Record that characterId `from` has been retired and replaced by `to`.
 *  Updates transitive mappings: whether a→b then b→c is recorded, or b→c
 *  then a→b, both a and b end up pointing to c in the final map (O(1)
 *  resolution). */
/** #2092/#2089 Task 10 — when `retireCharacterId` repoints a `supersededBy`
 *  entry whose VALUE is the id being retired (`from`) onto its live
 *  replacement (`newTarget`), do the same to a `rejectedPairs` entry whose
 *  `to` is that same id. Reasoning: `retireCharacterId` is only ever called
 *  when `from` and `newTarget` (after dereferencing) are the SAME real
 *  character under two ids — that is the invariant the whole
 *  `supersededBy`-repoint loop above already relies on (a rename, a
 *  dedupe, a merge — never two different people). A rejected pair
 *  `{ from: X, to: Y }` records a decision about a PERSON, not a string:
 *  "the orphaned id X is not the character currently addressable as Y."
 *  When Y retires into Y', Y' is still that same person, so "X is not Y"
 *  must keep meaning "X is not [that person]" — i.e. become "X is not Y'"
 *  — or the rejection silently stops applying the moment the character it
 *  was about gets a new id, and the auto-repair pass (or a future banner
 *  render) could re-offer the exact pairing the user already said no to.
 *  Dropping the pair instead was considered and rejected: it would forget
 *  a genuine user decision for no reason tied to that decision itself,
 *  purely because of bookkeeping happening on the OTHER id it references.
 *
 *  Degenerate case (M2, review round 1): if `newTarget === pair.from` (the
 *  retiring id's live replacement is itself the pair's `from` id — a
 *  person's canonical id became the very id that was rejected as "not
 *  them"), the entry is dropped rather than written as a self-referencing
 *  `{from: X, to: X}` pair — mirroring `retireCharacterId`'s own "never
 *  write a self-entry" guard below for `supersededBy`. It would never fire
 *  at read time anyway (`buildCastResolver` checks `exact` before any
 *  rejected pair), but leaving a nonsensical pair on disk serves nothing.
 *  Dropped entries are RETURNED, not merely discarded: this module never
 *  touches `cast.json`, so it cannot itself remove the one-sided
 *  `notLinkedTo` edge the original reject wrote there — a caller with
 *  `cast.json` access is what would need to act on this, if one ever needs
 *  to (no current caller of `retireCharacterId` does).
 *
 *  M1 (review round 1): repointing can make two PREVIOUSLY-distinct pairs
 *  collide onto the same `(from, to)` — reject X against both Y and Y'
 *  (two separate pairs), then retire Y into Y': the first pair's `to`
 *  repoints from Y onto Y', colliding with the second, already-existing
 *  `{from: X, to: Y'}` pair. Deduped by `(from, to)` after repointing,
 *  keeping the first-encountered entry — the same "first write wins"
 *  idempotence `rejectOrphanedPair` itself already applies to a literal
 *  double-reject. Without this, the banner would render two identical
 *  chips (a React duplicate-key warning, since the chip list keys on
 *  `targetId`) and `unrejectOrphanedPair`'s `findIndex`+splice would only
 *  ever remove one, making a second Undo click look like it did nothing.
 *
 *  M3 (review round 1): `forgotSupersededTo` is just another stored id
 *  reference — independent of `pair.to`, but equally capable of pointing
 *  at the id currently retiring (e.g. `from` was rejected against `to`,
 *  but `from` ALSO used to alias via `supersededBy` to the very id that is
 *  now retiring elsewhere). Repointed the same way `to` is, using the same
 *  `from -> newTarget` substitution, so a later Undo restores the CURRENT
 *  live alias rather than a dead intermediate id. */
function repointRejectedPairs(history: CastIdHistory, from: string, newTarget: string): RejectedPair[] {
  if (!history.rejectedPairs?.length) return [];
  const droppedSelfLoops: RejectedPair[] = [];
  const seen = new Set<string>();
  const next: RejectedPair[] = [];
  for (const pair of history.rejectedPairs) {
    const to = pair.to === from ? newTarget : pair.to;
    const forgotSupersededTo = pair.forgotSupersededTo === from ? newTarget : pair.forgotSupersededTo;
    const repointed: RejectedPair =
      forgotSupersededTo === undefined ? { from: pair.from, to } : { from: pair.from, to, forgotSupersededTo };
    if (repointed.from === repointed.to) {
      droppedSelfLoops.push(repointed);
      continue;
    }
    const key = JSON.stringify([repointed.from, repointed.to]);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(repointed);
  }
  history.rejectedPairs = next;
  return droppedSelfLoops;
}

/** #2092/#2089 M2 (review round 1) — self-loop `rejectedPairs` entries
 *  `repointRejectedPairs` had to drop during this call, if any (see its own
 *  doc comment). Every current caller ignores this (a purely additive
 *  return, replacing the prior `Promise<void>`) — none of them manage
 *  `cast.json`'s `notLinkedTo` edges, which is what a dropped pair's
 *  original reject also wrote and this module has no access to clean up
 *  itself. A future caller that DOES care can consume it; today this is
 *  reported, not acted on further. */
export interface RetireCharacterIdResult {
  droppedSelfLoopRejections: RejectedPair[];
}

export async function retireCharacterId(
  bookDir: string,
  from: string,
  to: string,
): Promise<RetireCharacterIdResult> {
  // No-op if from === to
  if (from === to) {
    return { droppedSelfLoopRejections: [] };
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
      const droppedSelfLoopRejections = repointRejectedPairs(history, from, to);
      await writeJsonAtomic(castIdHistoryPath(bookDir), history);
      return { droppedSelfLoopRejections };
    }

    // Dereference 'to' through any existing chain first, so the repoint
    // below is order-independent — retiring INTO an already-superseded id
    // must land on its live target, not the stale intermediate.
    const resolvedTo = history.supersededBy[to] ?? to;

    // Never write a self-entry — it would resolve nowhere. The reversal
    // branch above already covers the only way resolvedTo can equal `from`,
    // but keep this as a defensive guard against future changes here.
    if (from === resolvedTo) {
      return { droppedSelfLoopRejections: [] };
    }

    // Find all keys that currently point to 'from' and update them to 'to'
    for (const [key, value] of Object.entries(history.supersededBy)) {
      if (value === from) {
        history.supersededBy[key] = resolvedTo;
      }
    }

    // Add/update the new mapping
    history.supersededBy[from] = resolvedTo;

    const droppedSelfLoopRejections = repointRejectedPairs(history, from, resolvedTo);

    // Write back
    await writeJsonAtomic(castIdHistoryPath(bookDir), history);
    return { droppedSelfLoopRejections };
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

/** Remove a single named entry from `supersededBy` — the "forget one alias"
 *  primitive the banner's "not the same character" action needs. Unlike
 *  `retireCharacterId`, this does NOT repoint every entry whose VALUE is
 *  `id` onto anything — that repoint is only sound when `id` is genuinely
 *  dead (`retireCharacterId`'s own documented hazard, above), and this
 *  primitive has no basis for that claim: it only knows the caller wants
 *  this one entry gone, not that `id` itself is retired. It forgets exactly
 *  the key it's asked to and leaves every other entry (including ones that
 *  point AT `id`) untouched.
 *
 *  Returns the removed target (`supersededBy[id]`), or `undefined` when there
 *  was nothing to remove (#2092/#2089 D6) — the caller (the reject-orphan
 *  route) stashes this on the new pair-scoped `rejectedPairs` entry as
 *  `forgotSupersededTo` so a later undo (`unrejectOrphanedPair`) can restore
 *  it. Before D6 this returned `Promise<void>`: once forgotten, the mapping
 *  was unreconstructible and any undo could only ever be partial.
 *
 *  No-op (and no write) when the key isn't present, mirroring the rest of
 *  this module's idempotent-write discipline. Pair with `rejectOrphanedPair`
 *  when the caller also wants to stop the id resolving through the
 *  normalised tiers, which don't have a `supersededBy` entry to remove in
 *  the first place — this primitive alone is not durable against those.
 *
 *  `expectedTarget` (#2092/#2089, review round 2 "Also fix") — when given,
 *  the delete is a no-op unless `supersededBy[id]` still equals it. The
 *  reject-undo route's POST handler reads `supersededBy[orphanedId]` once
 *  (to compute the stash it bakes into `rejectOrphanedPair`), then calls
 *  this function afterwards as a best-effort tidy-up (#2089 fix round 1,
 *  I1's reorder). Between those two steps a CONCURRENT `retireCharacterId`
 *  could repoint `supersededBy[orphanedId]` onto a different, unrelated
 *  target — deleting unconditionally would then discard that fresh entry
 *  instead of the stale one the read actually saw, reproducing C1's own
 *  overwrite-class damage one primitive over, on the POST side instead of
 *  DELETE's. Passing the value the caller already read as `expectedTarget`
 *  closes that window: a mismatch means someone else already changed this
 *  key since the read, so there is nothing of the caller's own to forget. */
export async function forgetSupersededId(
  bookDir: string,
  id: string,
  expectedTarget?: string,
): Promise<string | undefined> {
  return withKeyLock(`cast-id-history:${bookDir}`, async () => {
    const history = await loadCastIdHistory(bookDir);
    const removed = history.supersededBy[id];
    if (removed === undefined) return undefined;
    if (expectedTarget !== undefined && removed !== expectedTarget) {
      /* Round 3 (M-8) — this branch used to fail closed silently: correct
         (someone else's concurrent write must not be discarded), but
         indistinguishable from "forgotten" in the log with nothing printed
         either way. Named so an operator can tell "someone else moved this
         key since the read" from "nothing needed forgetting" after the
         fact. */
      console.warn(
        `[cast-id-history] forgetSupersededId("${id}") skipped — expected supersededBy["${id}"] to still be ` +
          `"${expectedTarget}" but found "${removed}"; someone else changed this key since the read, so it was ` +
          `left alone rather than discarding their write.`,
      );
      return undefined;
    }
    delete history.supersededBy[id];
    await writeJsonAtomic(castIdHistoryPath(bookDir), history);
    return removed;
  });
}

/** Restore a single `supersededBy[id] = target` entry — the "undo forget"
 *  primitive the reject-undo route needs (#2092/#2089, C1 fix round 1).
 *  Unlike `retireCharacterId`, this does NOT repoint every entry whose
 *  VALUE is `id` onto `target`, and — the defect this primitive exists to
 *  close — it does NOT overwrite an existing `supersededBy[id]` entry that
 *  already points somewhere else. Both of those are sound in
 *  `retireCharacterId` only when `id` is genuinely dead, which an Undo can
 *  no longer assume once a rejection is pair-scoped rather than id-wide.
 *
 *  Failure scenario this closes (C1): reject "mayrin is not Mairin" (the
 *  pair stashes `forgotSupersededTo: 'mairin'`, the removed
 *  `supersededBy['mayrin']`); a LATER, unrelated re-analysis records the
 *  CORRECT alias `supersededBy['mayrin'] = 'mr-marrow'`; the user then
 *  clicks the now-stale "Not Mairin" chip's Undo. Restoring with
 *  `retireCharacterId(bookDir, 'mayrin', 'mairin')` would write
 *  unconditionally, silently overwriting the correct `'mr-marrow'` alias
 *  back to the stale `'mairin'` one, AND repoint anything that targeted
 *  `'mayrin'` — reproducing #2040's own failure mode (a character's lines
 *  ending up in someone else's voice) via the button labelled "Undo". This
 *  primitive instead writes only when the key is absent — the ordinary
 *  case, nothing has re-recorded an alias for `id` since the reject — and
 *  otherwise leaves the newer entry alone and reports that it did, so the
 *  caller can tell the user the alias was superseded rather than silently
 *  restoring nothing (or the wrong thing).
 *
 *  Idempotent: if `supersededBy[id]` already equals `target` (a retried
 *  DELETE after a prior successful restore), no write happens and
 *  `restored: true` is still returned — the desired end state already
 *  holds. */
export async function restoreSupersededId(
  bookDir: string,
  id: string,
  target: string,
): Promise<{ restored: boolean; supersededByOther?: string }> {
  return withKeyLock(`cast-id-history:${bookDir}`, async () => {
    const history = await loadCastIdHistory(bookDir);
    const existing = history.supersededBy[id];
    if (existing === target) {
      return { restored: true };
    }
    if (existing !== undefined) {
      return { restored: false, supersededByOther: existing };
    }
    history.supersededBy[id] = target;
    await writeJsonAtomic(castIdHistoryPath(bookDir), history);
    return { restored: true };
  });
}

/** LEGACY (#2040 Task 17) — id-wide reject. Superseded by `rejectOrphanedPair`
 *  (#2092/#2089, D1): this blocks `id` against EVERY tier-2/3/4 candidate
 *  forever, which costs more than it buys on the auto-reconciled path (see
 *  `rejectedPairs`'s doc comment on `CastIdHistory`). No production code path
 *  calls this anymore — `rejected` is now read-only, honoured by
 *  `buildCastResolver` purely for back-compat with a file written before this
 *  change. Kept (rather than deleted) because it's still the primitive that
 *  produces the on-disk shape the back-compat tests exercise. Do not add a
 *  new caller; use `rejectOrphanedPair` instead.
 *
 *  Record that `id` must never again resolve through the history /
 *  normalised-id / normalised-history tiers — NOT the `exact` tier (fix
 *  round 1: a live cast row with this exact id always wins over a stale
 *  rejection; see the `rejected` field's own doc comment on `CastIdHistory`
 *  for the corrected precedence and why). Idempotent: rejecting an id
 *  already in the list is a no-op, no re-write. Does not touch
 *  `supersededBy` itself. */
export async function rejectOrphanedId(bookDir: string, id: string): Promise<void> {
  return withKeyLock(`cast-id-history:${bookDir}`, async () => {
    const history = await loadCastIdHistory(bookDir);
    const rejected = history.rejected ?? [];
    if (rejected.includes(id)) return;
    history.rejected = [...rejected, id];
    await writeJsonAtomic(castIdHistoryPath(bookDir), history);
  });
}

/** Record that `from` (an orphaned id) is NOT the same character as `to` (a
 *  live cast id) — the pair-scoped successor to `rejectOrphanedId`
 *  (#2092/#2089, D1; see `rejectedPairs`'s doc comment on `CastIdHistory`).
 *  Blocks resolution of `from` onto `to` SPECIFICALLY, through the history /
 *  normalised-id / normalised-history tiers (never `exact` — same
 *  live-always-wins precedence as the legacy field, enforced in
 *  `buildCastResolver`). A different, later target for the same `from` is
 *  unaffected — that's the whole point of the pair scope.
 *
 *  `forgotSupersededTo`, when provided, is stashed on the pair (D6) so
 *  `unrejectOrphanedPair` can restore it later. This primitive does NOT call
 *  `forgetSupersededId` itself — the caller (the reject-orphan route) calls
 *  it first and passes through whatever it removed, so the route keeps its
 *  own fatal/non-fatal split across the two writes rather than this
 *  primitive making that call for it.
 *
 *  `withKeyLock`-serialised. Idempotent: rejecting the same `(from, to)`
 *  pair again is a no-op — mirrors this module's idempotent-write
 *  discipline elsewhere (`retireCharacterId`, `rejectOrphanedId`). A repeat
 *  call's `forgetSupersededId` will itself be a no-op by then (the entry is
 *  already gone from the first call), so there is nothing new to stash. */
export async function rejectOrphanedPair(
  bookDir: string,
  from: string,
  to: string,
  forgotSupersededTo?: string,
): Promise<void> {
  return withKeyLock(`cast-id-history:${bookDir}`, async () => {
    const history = await loadCastIdHistory(bookDir);
    const pairs = history.rejectedPairs ?? [];
    if (pairs.some((p) => p.from === from && p.to === to)) return;
    const entry: RejectedPair =
      forgotSupersededTo === undefined ? { from, to } : { from, to, forgotSupersededTo };
    history.rejectedPairs = [...pairs, entry];
    await writeJsonAtomic(castIdHistoryPath(bookDir), history);
  });
}

/** Undo `rejectOrphanedPair` (#2092/#2089, D5/D6) — removes the `(from, to)`
 *  pair from `rejectedPairs` and returns the removed entry's
 *  `forgotSupersededTo`, if any, so the caller can restore it (e.g. via
 *  `retireCharacterId(bookDir, from, forgotSupersededTo)`) and make the undo
 *  lossless. Returns `undefined` both when the pair was absent (nothing to
 *  undo) and when it was present but had no `forgotSupersededTo` (nothing to
 *  restore) — the route treats both cases identically (no further alias
 *  write needed either way), so collapsing them costs nothing.
 *
 *  No-op (and no write) when the pair isn't present, mirroring this module's
 *  idempotent-write discipline — a repeat undo of an already-undone pair is
 *  safe. */
export async function unrejectOrphanedPair(
  bookDir: string,
  from: string,
  to: string,
): Promise<string | undefined> {
  return withKeyLock(`cast-id-history:${bookDir}`, async () => {
    const history = await loadCastIdHistory(bookDir);
    const pairs = history.rejectedPairs ?? [];
    const idx = pairs.findIndex((p) => p.from === from && p.to === to);
    if (idx < 0) return undefined;
    const removed = pairs[idx];
    history.rejectedPairs = [...pairs.slice(0, idx), ...pairs.slice(idx + 1)];
    await writeJsonAtomic(castIdHistoryPath(bookDir), history);
    return removed.forgotSupersededTo;
  });
}
