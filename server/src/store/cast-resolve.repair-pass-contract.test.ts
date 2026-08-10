import { describe, it, expect } from 'vitest';
import { buildCastResolver } from './cast-resolve.js';
import { isAudioCurrent } from './cast-audio-currency.js';
// @ts-expect-error — scripts/repair-cast-id-drift.mjs is a plain, untyped
// ESM script (no server/dist build, no .d.ts) — see this file's own header
// comment for why importing it from here, rather than from the script's own
// node:test file, is the fix for #2130.
import { buildOrphansFromSegments, resolveTierBId } from '../../../scripts/repair-cast-id-drift.mjs';

/** #2130: `scripts/repair-cast-id-drift.mjs`'s `buildOrphansFromSegments`
 *  branches on this module's own tier-name strings (`resolution.via ===
 *  'exact'`) — but every resolver in the script's OWN test file
 *  (`scripts/tests/repair-cast-id-drift.test.mjs`) is a hand-written fake
 *  that hard-codes a COPY of those same literals. Nothing there imports the
 *  real `buildCastResolver`, and `.mjs` is not typechecked — so a tier
 *  rename here (`cast-resolve.ts`), even one whose author dutifully updates
 *  `cast-resolve.test.ts` to match, leaves the repair script's comparison
 *  silently broken: every rendered segment becomes an orphan, and (after
 *  #2107's widening) the entire workspace lands on the re-render list, with
 *  the script's own suite staying green throughout.
 *
 *  This file is the fix, and — as important as the assertions themselves —
 *  WHERE it lives. Two independent reasons ruled out adding this coverage
 *  to the script's own `scripts/tests/repair-cast-id-drift.test.mjs`
 *  instead (found by review, simulated against the CI job, not merely
 *  reasoned about):
 *
 *    1. `test:hooks` (the job that runs the script's test file) executes in
 *       `verify.yml`'s `lint-and-checks` job, which never runs `npm run
 *       build` — a check against `server/dist/store/cast-resolve.js` would
 *       have to `skip` there, exactly as this file's sibling attempt did
 *       before this fix, silently rendering it uncovered in CI.
 *    2. Independently fatal even with (1) solved: the `Hooks tests` step's
 *       own `if:` condition is `hooks || scripts || shared` — a PR that
 *       renames a tier touches only `server/src/`, which sets the `server`
 *       scope flag alone. The step would not run AT ALL, dist or no dist.
 *
 *  This file sidesteps both: it lives under `server/src/`, which the
 *  `detect` job's scope regex already matches (`^server/src/`) — no scope
 *  regex change needed — and vitest transpiles `cast-resolve.ts` straight
 *  from source, so no `server/dist` build is needed either. A rename here
 *  is caught by the SAME `Server tests` CI job that already runs on every
 *  `server/src/` change.
 *
 *  Proven, not merely asserted: renamed `'exact'` -> `'exact-id'` in
 *  `cast-resolve.ts` (both the `via` union and the `resolve()` return),
 *  re-ran this file under vitest with no rebuild step (confirming the
 *  no-dist-needed claim above), watched the first test below go red, then
 *  reverted. See the PR description for the transcript.
 *
 *  Round 4 review (2026-08-05) found the two `'normalised-id'`/`'history'`
 *  tests below (added for this file's original #2130 fix) name those tiers
 *  but cannot actually FAIL on a rename of them: `buildOrphansFromSegments`
 *  (`scripts/repair-cast-id-drift.mjs:2019`) branches only on `via ===
 *  'exact'` — every OTHER tier, whatever its string happens to be, falls
 *  through to "still an orphan" by construction, so renaming
 *  `'normalised-id'` to anything still passes those two tests. Proven:
 *  renaming `'normalised-id'` -> `'normalized-id'` (both sites in
 *  `cast-resolve.ts`) left this file's ORIGINAL three tests at 3/3 green.
 *  Two real production consumers of that exact literal go untested by any
 *  of the three: `resolveTierBId` (`scripts/repair-cast-id-drift.mjs:404`,
 *  the whole Tier B id-shape matcher) and guard 5
 *  (`scripts/repair-cast-id-drift.mjs:966`, the live-resolution conflict
 *  check inside `planBookRepairs`). The test below closes the
 *  `resolveTierBId` gap by calling it directly against the real resolver —
 *  proven the same way: it goes red under the identical rename, reverted
 *  after confirming. */
describe('buildOrphansFromSegments against the REAL buildCastResolver (#2130)', () => {
  it("a live id resolves via the REAL resolver's 'exact' tier and is NOT an orphan; a genuine miss still is", () => {
    const liveCast = [{ id: 'live-id', name: 'Live' }];
    const history = { schema: 1 as const, supersededBy: {}, rejected: [] };
    const resolver = buildCastResolver(liveCast, history);
    const segs = [
      {
        chapterId: 1,
        chapterTitle: 'One',
        segments: [{ characterId: 'live-id' }, { characterId: 'live-id' }, { characterId: 'ghost' }],
      },
    ];
    // #2128 — buildOrphansFromSegments now calls the REAL isAudioCurrent
    // (the same comparator the Cast banner calls, Global Constraint 3)
    // rather than checking `resolution.via === 'exact'` itself. Neither
    // fixture segments-file below carries a `castHistorySeq` stamp, so
    // 'exact' is still unconditionally current (no stamp needed) and a
    // genuine miss ('ghost') is still `false` — this test's outcome is
    // unchanged by the widening, it now just proves it through the real
    // predicate instead of the old inline check.
    const { orphans } = buildOrphansFromSegments(segs, resolver, history, isAudioCurrent);
    expect(orphans.has('live-id')).toBe(false);
    expect(orphans.get('ghost')?.segments).toBe(1);
  });

  it("a case/separator-drifted id resolves via the REAL resolver's 'normalised-id' tier and IS an orphan (#2107's widening)", () => {
    const liveCast = [{ id: 'the_torment', name: 'The Torment' }];
    const history = { schema: 1 as const, supersededBy: {}, rejected: [] };
    const resolver = buildCastResolver(liveCast, history);
    const segs = [{ chapterId: 19, chapterTitle: 'Nineteen', segments: [{ characterId: 'the-torment' }] }];
    // #2128 — no `castHistorySeq` on this segments-file fixture, so
    // isAudioCurrent reads 'unknown' for this normalised-id match (it can't
    // even reach the tier-specific branch without a stamp) — 'unknown' is
    // damage exactly like `false`, so the id is still listed either way.
    const { orphans } = buildOrphansFromSegments(segs, resolver, history, isAudioCurrent);
    expect(orphans.get('the-torment')?.segments).toBe(1);
  });

  it("a history alias resolves via the REAL resolver's 'history' tier and is STILL an orphan (audio predates the alias)", () => {
    const liveCast = [{ id: 'mairin', name: 'Мэйрин' }];
    const history = { schema: 1 as const, supersededBy: { mayrin: 'mairin' }, rejected: [] };
    const resolver = buildCastResolver(liveCast, history);
    const segs = [{ chapterId: 2, chapterTitle: 'Two', segments: [{ characterId: 'mayrin' }, { characterId: 'mayrin' }] }];
    // #2128 — no `castHistorySeq` stamp on this fixture either, so
    // isAudioCurrent reads 'unknown' for the 'history' match — damage, same
    // as this test's pre-#2128 assertion (the alias resolving live says
    // nothing about whether the RENDERED bytes predate it).
    const { orphans } = buildOrphansFromSegments(segs, resolver, history, isAudioCurrent);
    expect(orphans.get('mayrin')?.segments).toBe(2);
  });

  it("#2128 (review round 1, I1) — the currency comparison itself, against the REAL resolver AND the REAL isAudioCurrent: a render stamped AT the marker clears, one stamped BELOW it stays", () => {
    // The three tests above all omit `castHistorySeq`, so every one resolves
    // at 'exact' -> `true` or `!finite(stamp)` -> `'unknown'` before ever
    // reaching the marker comparison inside isAudioCurrent — none of them
    // discriminate on the currency decision itself. This one does: same
    // 'history'-tier resolution as the test above ('mayrin' -> 'mairin'),
    // but with a real recordedAtSeq marker and two segments-files whose
    // castHistorySeq stamp sits on either side of it.
    const liveCast = [{ id: 'mairin', name: 'Мэйрин' }];
    const history = { schema: 1 as const, supersededBy: { mayrin: 'mairin' }, seq: 5, recordedAtSeq: { mayrin: 3 } };
    const resolver = buildCastResolver(liveCast, history);
    const rerenderedSeg = { chapterId: 3, chapterTitle: 'Three', castHistorySeq: 5, segments: [{ characterId: 'mayrin' }] };
    const staleSeg = { chapterId: 4, chapterTitle: 'Four', castHistorySeq: 1, segments: [{ characterId: 'mayrin' }] };
    const { orphans: clearedOrphans } = buildOrphansFromSegments([rerenderedSeg], resolver, history, isAudioCurrent);
    expect(clearedOrphans.has('mayrin')).toBe(false); // stamp (5) >= marker (3) -> current, clears
    const { orphans: staleOrphans } = buildOrphansFromSegments([staleSeg], resolver, history, isAudioCurrent);
    expect(staleOrphans.get('mayrin')?.segments).toBe(1); // stamp (1) < marker (3) -> stale, stays listed
  });
});

describe("resolveTierBId against the REAL buildCastResolver (round 4 review, #2130) — a consumer buildOrphansFromSegments's own tests above cannot stand in for, since it branches on the literal string returned by resolution.via ('normalised-id'), not merely on whether SOME tier other than 'exact' matched", () => {
  it("an id-shape-drifted orphan resolves to the live cast id via the REAL resolver's 'normalised-id' tier", () => {
    const liveCast = [{ id: 'the_torment', name: 'The Torment' }];
    const resolver = buildCastResolver(liveCast, { supersededBy: {}, rejected: [] });
    expect(resolveTierBId('the-torment', resolver)).toBe('the_torment');
  });

  it('a genuinely unrelated id does not match', () => {
    const liveCast = [{ id: 'the_torment', name: 'The Torment' }];
    const resolver = buildCastResolver(liveCast, { supersededBy: {}, rejected: [] });
    expect(resolveTierBId('a-completely-different-id', resolver)).toBeUndefined();
  });
});
