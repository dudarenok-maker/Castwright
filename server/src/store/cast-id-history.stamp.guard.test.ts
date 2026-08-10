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
   reconciliation check). */

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
    // 9 raw regex matches: 8 real assignments plus one inside
    // restoreSupersededId's own doc comment ("CORRECT alias
    // `supersededBy['mayrin'] = 'mr-marrow'`") — deliberately not stripped
    // (this guard, unlike Guard 3, does not blank comments/strings; see the
    // "MATCHES INDEXED ASSIGNMENT ONLY" note above for why it stays a raw
    // text scan), and harmless here since that line lands inside a function
    // that already stamps for its own, real reasons.
    expect(SRC.match(ASSIGN_RE)?.length ?? 0).toBe(9);
  });

  it('pairs every writing function with a bumpSeqAndStamp before its write', () => {
    const unpaired = fns
      .filter((f) => new RegExp(WRITE_RE.source).test(f.body))
      .filter((f) => {
        const writeAt = f.body.search(new RegExp(WRITE_RE.source));
        const stampAt = f.body.search(new RegExp(STAMP_RE.source));
        return stampAt < 0 || stampAt > writeAt;
      })
      .map((f) => f.name);
    expect(unpaired).toEqual([]);
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

  it('matches an indexed ASSIGNMENT', () => {
    expect('history.supersededBy[from] = to;'.match(ASSIGN_RE)).toHaveLength(1);
    expect('h.supersededBy[key] = resolvedTo;'.match(ASSIGN_RE)).toHaveLength(1);
  });

  it('does NOT fire on a comparison — cast-reject-orphan.ts:359 is correct code', () => {
    expect('historyBeforeReject.supersededBy[orphanedId] === characterId'.match(ASSIGN_RE)).toBeNull();
    expect('if (history.supersededBy[to] === from) {'.match(ASSIGN_RE)).toBeNull();
  });
});
