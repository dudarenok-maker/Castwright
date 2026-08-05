import { describe, it, expect } from 'vitest';
import { buildCastResolver } from './cast-resolve.js';
// @ts-expect-error — scripts/repair-cast-id-drift.mjs is a plain, untyped
// ESM script (no server/dist build, no .d.ts) — see this file's own header
// comment for why importing it from here, rather than from the script's own
// node:test file, is the fix for #2130.
import { buildOrphansFromSegments } from '../../../scripts/repair-cast-id-drift.mjs';

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
 *  reverted. See the PR description for the transcript. */
describe('buildOrphansFromSegments against the REAL buildCastResolver (#2130)', () => {
  it("a live id resolves via the REAL resolver's 'exact' tier and is NOT an orphan; a genuine miss still is", () => {
    const liveCast = [{ id: 'live-id', name: 'Live' }];
    const resolver = buildCastResolver(liveCast, { supersededBy: {}, rejected: [] });
    const segs = [
      {
        chapterId: 1,
        chapterTitle: 'One',
        segments: [{ characterId: 'live-id' }, { characterId: 'live-id' }, { characterId: 'ghost' }],
      },
    ];
    const { orphans } = buildOrphansFromSegments(segs, resolver);
    expect(orphans.has('live-id')).toBe(false);
    expect(orphans.get('ghost')?.segments).toBe(1);
  });

  it("a case/separator-drifted id resolves via the REAL resolver's 'normalised-id' tier and IS an orphan (#2107's widening)", () => {
    const liveCast = [{ id: 'the_torment', name: 'The Torment' }];
    const resolver = buildCastResolver(liveCast, { supersededBy: {}, rejected: [] });
    const segs = [{ chapterId: 19, chapterTitle: 'Nineteen', segments: [{ characterId: 'the-torment' }] }];
    const { orphans } = buildOrphansFromSegments(segs, resolver);
    expect(orphans.get('the-torment')?.segments).toBe(1);
  });

  it("a history alias resolves via the REAL resolver's 'history' tier and is STILL an orphan (audio predates the alias)", () => {
    const liveCast = [{ id: 'mairin', name: 'Мэйрин' }];
    const resolver = buildCastResolver(liveCast, { supersededBy: { mayrin: 'mairin' }, rejected: [] });
    const segs = [{ chapterId: 2, chapterTitle: 'Two', segments: [{ characterId: 'mayrin' }, { characterId: 'mayrin' }] }];
    const { orphans } = buildOrphansFromSegments(segs, resolver);
    expect(orphans.get('mayrin')?.segments).toBe(2);
  });
});
