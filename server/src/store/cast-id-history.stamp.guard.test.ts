/* Guard 5 (#2128) — every write to `cast-id-history.json` goes through
   `bumpSeqAndStamp`, so `seq` and the markers can never drift from
   `supersededBy`.

   MATCHES INDEXED ASSIGNMENT ONLY. A naive `supersededBy\[[^\]]+\]\s*=` also
   matches `historyBeforeReject.supersededBy[orphanedId] === characterId`
   (cast-reject-orphan.ts) — a COMPARISON, correct code, which a guard reddening
   on it would send an implementer to "fix". The `=` must not be followed by
   another `=`.

   Task-5-brief's floor assertions (`toBeGreaterThanOrEqual(9)` for the write
   count, `toBeGreaterThanOrEqual(3)` for the assignment count) predate two
   #2128 tasks landing on top of the nine-write-site tree the brief was
   written against: Task 2 added `stampRecordedAtSeqIfAbsent`'s write (the
   tenth) and the #2198 batch-undo work already on `main` added
   `undoRejectedPairs`'s (the eleventh). A floor of 9 against a reality of 11
   passes just as green if two write sites are deleted tomorrow — it only
   proves "at least 9", never "still all of them". Both counts below are
   asserted EXACTLY, matching what this file's real text contains today, so a
   write site (or a `supersededBy[...] =` assignment) quietly vanishing is a
   test failure, not something the floor silently absorbs. This is a stronger
   guard than the brief's own floor, not merely a different number.

   BLIND SPOT: call-graph blind and single-file. It asserts that
   cast-id-history.ts's own writes are paired; a future writer in another module
   that imports `writeJsonAtomic` and `castIdHistoryPath` directly is not seen.

   A SECOND, function-shape blind spot found while wiring this guard (not
   present in the brief): `applyRestoreSupersededId` is an in-memory-only
   "applier" — it mutates `history.supersededBy[id] = target` but deliberately
   never calls `bumpSeqAndStamp` or writes itself. That split is intentional
   (#2198): it is shared by `restoreSupersededId` (stamps once, right before
   its own write) and `undoRejectedPairs` (accumulates `touchedKeys` across a
   WHOLE BATCH of appliers and stamps ONCE for the batch, so N restores cost
   one `seq` bump, not N) — see both functions' own doc comments. Per-function
   pairing (guard 5's whole design, so a file-wide count can't hide nine
   stamps in one writer and none in the other eight) cannot see across that
   one deliberate split: the assignment and its stamp are correctly paired
   ONE CALL FRAME UP, in `applyRestoreSupersededId`'s two callers, both of
   which the "write paired with a stamp" test above already covers. Allowlisted
   below by function name, not by widening the assertion generically, and
   re-verified every run (an entry whose function no longer has the shape it
   was allowlisted for would still show up as an unstamped mismatch if the
   assignment moved back into a stamping function — see the trailing
   reconciliation check). Bounded to its exact two known callers by a
   dedicated test (round-1 review, M3), each independently confirmed to
   stamp.

   A THIRD blind spot existed here (round-1 review, M4) and is now CLOSED
   (fold-in fix): "pairs every writing function with a stamp" used to compare
   only the FIRST `bumpSeqAndStamp(` match against the FIRST `await
   writeJsonAtomic(castIdHistoryPath` match in a function's body — a
   first-write-only check, not a per-write one. `retireCharacterId` genuinely
   has two writes (its early-reversal branch and its main branch, each
   preceded by its own stamp), and the old test would not have noticed a
   SECOND write added to an already-stamping function that itself skipped its
   own stamp — it only ever looked at the first occurrence of each. The exact
   `toBe(11)` write-count assertion above helped (it forces a human to
   re-justify the new number whenever a write site is added or removed) but
   was only a floor on the COUNT, never detection of a specific unpaired
   write.

   The fix (`hasUnpairedWrite`, below): walk every `bumpSeqAndStamp(` and
   `writeJsonAtomic(castIdHistoryPath` occurrence in a function body IN
   SOURCE ORDER as one merged event stream, and require that every write
   consumes its own not-yet-spent preceding stamp (a running counter,
   incremented on each stamp and decremented on each write; a write seen with
   the counter at 0 has no stamp left to pair with and fails the function). A
   function with N writes now needs N stamps positioned so each write has one
   available — one stamp covering two writes no longer passes. See the
   synthetic-fixture test below ("catches a SECOND write…") for the case this
   closes, proven directly against the old first-occurrence algorithm. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'cast-id-history.ts'), 'utf8');

/** Indexed assignment, never comparison. */
export const ASSIGN_RE = /supersededBy\[[^\]]+\]\s*=(?!=)/g;
const WRITE_RE = /await writeJsonAtomic\(castIdHistoryPath/g;
const STAMP_RE = /bumpSeqAndStamp\(/g;

/** Split the module at top-level `function`/`export ... function` boundaries,
 *  so "this write is paired with a stamp" is asked PER FUNCTION rather than
 *  over the whole file — a file-wide count is satisfied by eleven stamps in
 *  one writer and none in the other ten. */
export function topLevelFunctions(src: string): Array<{ name: string; body: string }> {
  const starts: Array<{ name: string; at: number }> = [];
  const re = /^(?:export )?(?:async )?function (\w+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) starts.push({ name: m[1], at: m.index });
  return starts.map((s, i) => ({
    name: s.name,
    body: src.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : src.length),
  }));
}

/* `applyRestoreSupersededId` is the one deliberate exception to "an assignment
   without a stamp in the same function is a bug" — see the file-header note
   above. Keyed on function name (there is exactly one top-level function of
   that name), with the reason recorded inline per Guard 3's own convention
   for allowlist entries. */
/** Per-write pairing (fold-in fix, closes the file header's documented THIRD
 *  blind spot, M4). Walks a function body's `bumpSeqAndStamp(` and
 *  `writeJsonAtomic(castIdHistoryPath` occurrences as one merged event stream
 *  in SOURCE ORDER, keeping a running count of stamps seen but not yet
 *  "spent" by a write. A write encountered with nothing pending has no stamp
 *  of its own — the exact shape a bare first-occurrence comparison cannot
 *  see once a function has more than one write. Returns `true` (unpaired)
 *  the moment that happens; unused trailing stamps are fine. */
export function hasUnpairedWrite(body: string): boolean {
  const events: Array<{ at: number; kind: 'stamp' | 'write' }> = [];
  for (const m of body.matchAll(new RegExp(STAMP_RE.source, 'g'))) {
    events.push({ at: m.index, kind: 'stamp' });
  }
  for (const m of body.matchAll(new RegExp(WRITE_RE.source, 'g'))) {
    events.push({ at: m.index, kind: 'write' });
  }
  events.sort((a, b) => a.at - b.at);
  let pendingStamps = 0;
  for (const e of events) {
    if (e.kind === 'stamp') {
      pendingStamps++;
    } else if (pendingStamps > 0) {
      pendingStamps--;
    } else {
      return true;
    }
  }
  return false;
}

const ASSIGN_WITHOUT_STAMP_ALLOWLIST: ReadonlyArray<{ name: string; reason: string }> = [
  {
    name: 'applyRestoreSupersededId',
    reason:
      'Lock-free applier shared by restoreSupersededId (stamps once, immediately before its own ' +
      'write) and undoRejectedPairs (#2198 — stamps once for a WHOLE BATCH of appliers, so N ' +
      'restores cost one seq bump, not N). The assignment and its stamp are paired one call frame ' +
      "up, in both callers, which the 'pairs every writing function with a stamp' test above already " +
      'covers for each of them.',
  },
];

describe('guard 5 — the stamp pairing (#2128)', () => {
  const fns = topLevelFunctions(SRC);

  /* Round 1 (C2): the first version of this guard applied ASSIGN_RE only to
     synthetic strings and asserted two file-wide integers, so it checked
     nothing it claimed and was red as written. These three assertions run
     against the real module. */

  it('finds the write sites at all — a scan matching nothing must not pass green', () => {
    // Exact, not a floor — see file header for why a floor is too weak to
    // trust here. 11 write sites: retireCharacterId (x2, two branches),
    // dropSupersededIdsReclaimedByLiveCast, dropSupersededTargetsNoLongerLive,
    // forgetSupersededId, restoreSupersededId, rejectOrphanedId,
    // rejectOrphanedPair, unrejectOrphanedPair, undoRejectedPairs,
    // stampRecordedAtSeqIfAbsent.
    expect(SRC.match(WRITE_RE)?.length ?? 0).toBe(11);
    // 9 raw regex matches, verified line-by-line (round-1 review, M5 —
    // corrects an earlier version of this comment that miscounted the
    // split): 5 REAL assignments, all inside retireCharacterId or
    // applyRestoreSupersededId (cast-id-history.ts:515, :519, :562, :567,
    // :938), plus 4 doc-comment matches (this guard, unlike Guard 3, does
    // not blank comments/strings before matching — see the "MATCHES INDEXED
    // ASSIGNMENT ONLY" note above for why it stays a raw text scan):
    // `:842`/`:854` sit inside restoreSupersededId's own doc comment
    // ("CORRECT alias `supersededBy['mayrin'] = 'mr-marrow'`") and land
    // inside forgetSupersededId's body slice per `topLevelFunctions`'
    // boundary-splitting — harmless, since that function already stamps for
    // its own, real reasons; `:78`/`:79` sit in this file's very top,
    // module-level doc comment on the `supersededBy` field, BEFORE the
    // first top-level function declaration — `topLevelFunctions` only
    // slices from the first function's start index onward, so these two
    // are dropped from every function's body entirely and are invisible to
    // both the "pairs" and "leaves no ... unstamped" tests below, not
    // merely harmless inside one.
    expect(SRC.match(ASSIGN_RE)?.length ?? 0).toBe(9);
  });

  it('pairs every writing function with a bumpSeqAndStamp before its write — per write, not merely per first occurrence', () => {
    const unpaired = fns
      .filter((f) => new RegExp(WRITE_RE.source).test(f.body))
      .filter((f) => hasUnpairedWrite(f.body))
      .map((f) => f.name);
    expect(unpaired).toEqual([]);
  });

  // Fold-in fix, closes the file header's documented THIRD blind spot (M4).
  // Proves the strengthened, per-write check catches a bug the OLD
  // first-occurrence check would have missed — a synthetic function shaped
  // exactly like the blind spot: one stamp, then TWO writes, the second with
  // no stamp of its own.
  it('catches a SECOND write in an already-stamping function that skips its own stamp', () => {
    const synthetic = `function fakeWriter() {
  bumpSeqAndStamp(history, []);
  await writeJsonAtomic(castIdHistoryPath, history);
  await writeJsonAtomic(castIdHistoryPath, history);
}`;
    const body = topLevelFunctions(synthetic)[0].body;

    // The OLD algorithm — first occurrence of each, exactly what the
    // "pairs every writing function" test used to run before this fold-in
    // fix — finds a stamp before the FIRST write and calls the function
    // paired without ever looking at the second write. This is the blind
    // spot: the old check finds nothing wrong here.
    const oldWriteAt = body.search(new RegExp(WRITE_RE.source));
    const oldStampAt = body.search(new RegExp(STAMP_RE.source));
    const oldWouldFlagAsUnpaired = oldStampAt < 0 || oldStampAt > oldWriteAt;
    expect(oldWouldFlagAsUnpaired).toBe(false);

    // The strengthened, per-write algorithm this suite now uses DOES catch
    // it — the second write has no stamp of its own left to pair with.
    expect(hasUnpairedWrite(body)).toBe(true);
  });

  it('leaves no supersededBy ASSIGNMENT in a function that never stamps, except the documented split-applier allowlist', () => {
    const allowedNames = new Set(ASSIGN_WITHOUT_STAMP_ALLOWLIST.map((a) => a.name));
    const unstamped = fns
      .filter((f) => new RegExp(ASSIGN_RE.source).test(f.body))
      .filter((f) => !new RegExp(STAMP_RE.source).test(f.body))
      .map((f) => f.name);
    // `bumpSeqAndStamp` itself assigns into its own maps, not `supersededBy`.
    expect(unstamped.filter((n) => !allowedNames.has(n))).toEqual([]);
    // The reverse direction: every allowlisted name must actually be present
    // in `unstamped` today. A stale entry (the assignment moved into a
    // stamping function, or the function was deleted) would otherwise sit
    // here unnoticed, silently widening what the guard accepts.
    for (const allowed of ASSIGN_WITHOUT_STAMP_ALLOWLIST) {
      expect(unstamped, `${allowed.name} is allowlisted but the scan no longer finds it unstamped`).toContain(
        allowed.name,
      );
    }
  });

  /* Round-1 review (M3): the split-applier exemption above has no caller-count
     analog to Guard 3's file+count keying, leaving one real residual — a
     future THIRD caller of `applyRestoreSupersededId` that doesn't itself
     stamp would be invisible to both the exemption (which only asks "does
     the mutator stamp", never "do all its callers") and to the "pairs every
     writing function with a stamp" test (which only checks functions that
     themselves WRITE, not every function that merely calls the applier).
     Bounds the exemption to its two known-sound callers, both proven correct
     above: `restoreSupersededId` (stamps once, before its own write) and
     `undoRejectedPairs` (stamps once for a whole batch). */
  it('bounds the applyRestoreSupersededId exemption to its exact known callers, each of which stamps', () => {
    const CALLS_APPLY_RE = /applyRestoreSupersededId\(/g;
    const callers = fns
      .filter((f) => f.name !== 'applyRestoreSupersededId')
      .filter((f) => new RegExp(CALLS_APPLY_RE.source).test(f.body))
      .map((f) => f.name);
    for (const name of callers) {
      const fn = fns.find((f) => f.name === name)!;
      expect(
        new RegExp(STAMP_RE.source).test(fn.body),
        `${name} calls applyRestoreSupersededId but never stamps`,
      ).toBe(true);
    }
    expect([...callers].sort()).toEqual(['restoreSupersededId', 'undoRejectedPairs']);
  });

  it('matches an indexed ASSIGNMENT', () => {
    expect('history.supersededBy[from] = to;'.match(ASSIGN_RE)).toHaveLength(1);
    expect('h.supersededBy[key] = resolvedTo;'.match(ASSIGN_RE)).toHaveLength(1);
  });

  it('does NOT fire on a comparison — cast-reject-orphan.ts:359 is correct code', () => {
    expect('historyBeforeReject.supersededBy[orphanedId] === characterId'.match(ASSIGN_RE)).toBeNull();
    expect('if (history.supersededBy[to] === from) {'.match(ASSIGN_RE)).toBeNull();
  });
});
