import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregateAudioCurrency, isAudioCurrent } from './cast-audio-currency.js';
import {
  forgetSupersededId,
  loadCastIdHistory,
  restoreSupersededId,
  retireCharacterId,
} from './cast-id-history.js';
import type { CastIdHistory } from './cast-id-history.js';
import type { CastResolution } from './cast-resolve.js';

const CHAR = { id: 'mairin' };
const res = (
  via: CastResolution['via'],
  matchedHistoryKeys?: string[],
): CastResolution<{ id: string }> => ({ character: CHAR, via, matchedHistoryKeys });

const history = (over: Partial<CastIdHistory> = {}): CastIdHistory => ({
  schema: 1,
  supersededBy: { mayrin: 'mairin' },
  seq: 5,
  recordedAtSeq: { mayrin: 3 },
  recordedAtIso: { mayrin: '2026-08-06T00:00:00.000Z' },
  ...over,
});

describe('isAudioCurrent (#2128 / #2129)', () => {
  it('exact is always current, stamp or no stamp', () => {
    expect(isAudioCurrent(res('exact'), { castHistorySeq: 0 }, history())).toBe(true);
    expect(isAudioCurrent(res('exact'), {}, history())).toBe(true);
    expect(isAudioCurrent(res('exact'), undefined, history())).toBe(true);
  });

  describe('the hoisted substitution check now also covers `exact` (round 3 review gate — F1/round 2 stopped one tier short)', () => {
    /* Round 3 finding: the check sat above the tier dispatch but BELOW the
       `'exact'` early return, on the false premise that `'exact'` never
       reaches this function in practice. The repair pass
       (`repair-cast-id-drift.mjs`) resolves every string `characterId` with
       no exact-tier filter ahead of it, so a chapter rendered against an
       absent-then-recreated `the_torment` id — narrator-voiced,
       `renderedFallbackCharacterId: 'narrator'` — resolves `'exact'` once
       the analyzer re-mints the SAME id, and the unguarded `'exact'` branch
       silently cleared it. */
    it('exact + substitution is STALE, not vacuously current', () => {
      expect(isAudioCurrent(res('exact'), { castHistorySeq: 5 }, history(), 'narrator')).toBe(
        false,
      );
    });
    it('control — exact with no substitution still clears (no over-correction)', () => {
      expect(isAudioCurrent(res('exact'), { castHistorySeq: 5 }, history())).toBe(true);
    });
    it('exact + substitution + no stamp is STALE too, not unknown (round 3 decision: a substitution is affirmative evidence and needs no stamp to be meaningful)', () => {
      expect(isAudioCurrent(res('exact'), {}, history(), 'narrator')).toBe(false);
      expect(isAudioCurrent(res('exact'), undefined, history(), 'narrator')).toBe(false);
    });
  });

  it('a genuine miss is damage', () => {
    expect(isAudioCurrent(undefined, { castHistorySeq: 9 }, history())).toBe(false);
  });

  describe('normalised-id — the tier with no history entry', () => {
    it('is current once the render proves the resolver existed', () => {
      expect(isAudioCurrent(res('normalised-id'), { castHistorySeq: 0 }, history())).toBe(true);
    });
    it('is UNKNOWN on a render that predates the stamp', () => {
      expect(isAudioCurrent(res('normalised-id'), {}, history())).toBe('unknown');
    });
    it('is current EVEN with a stamp above the file seq — the counter-reset guard does not apply here (M3)', () => {
      // Deliberate tier ordering: `normalised-id` returns before the
      // counter-reset guard runs, because this tier reads no `recordedAtSeq`
      // marker at all — stamp presence alone is its affirmative evidence.
      // The alias tiers ('history' / 'normalised-history') DO consult that
      // guard and would read 'unknown' for the identical castHistorySeq/seq
      // combination (see "counter reset" above, same seq: 5 default vs.
      // castHistorySeq: 9). Moving this tier's early return below the guard
      // would silently flip this assertion to 'unknown' with the rest of the
      // suite still green.
      expect(isAudioCurrent(res('normalised-id'), { castHistorySeq: 9 }, history())).toBe(true);
    });

    /* F1 (PR #2244 review gate, HIGH) — `castHistorySeq` presence proves the
       resolver RAN, not that THIS id resolved to THIS character: nothing
       bumps `seq` when the live roster changes underneath a tier-3 match, so
       a stamped chapter that actually rendered under a render-time narrator
       substitution (`resolveGroup` had no live row to normalise onto, so it
       fell back to the narrator and stamped `renderedFallbackCharacterId` on
       the segment) must NOT clear just because a stamp exists — register row
       A32's own shape (`the-torment`, 67 segments). The per-segment
       `renderedFallbackCharacterId` is the affirmative evidence this tier was
       missing; `== null` (not truthiness) because the field is `string |
       null | undefined` and an empty string would BE a substitution record. */
    it('F1 — is STALE when the segment recorded a render-time narrator substitution', () => {
      expect(
        isAudioCurrent(res('normalised-id'), { castHistorySeq: 0 }, history(), 'narrator'),
      ).toBe(false);
    });
    it('F1 — is current when renderedFallbackCharacterId is explicitly null (no substitution)', () => {
      expect(
        isAudioCurrent(res('normalised-id'), { castHistorySeq: 0 }, history(), null),
      ).toBe(true);
    });
    it('F1 — is current when renderedFallbackCharacterId is absent (pre-#2023 render, no 4th arg)', () => {
      expect(isAudioCurrent(res('normalised-id'), { castHistorySeq: 0 }, history())).toBe(true);
    });
  });

  describe('the hoisted substitution check — a substituted segment is damage in EVERY tier, not just normalised-id (round 2 review gate)', () => {
    /* The review gate found the identical fail-open one tier over from F1:
       nothing bumps `history.seq` when the live roster changes under a
       tier-3 match, so a marker comparison cannot see a render-time
       narrator substitution either. `renderedFallbackCharacterId` is now
       consulted BEFORE the tier dispatch, not just inside 'normalised-id'. */
    it('is STALE on the alias tier even though the marker comparison alone would clear it', () => {
      // Same shape as the review gate's own example: seq 5, marker
      // mayrin@3, castHistorySeq 5 -> 5 >= 3 is true via the marker
      // comparison alone. The hoisted substitution check must override
      // that verdict.
      expect(
        isAudioCurrent(res('history', ['mayrin']), { castHistorySeq: 5 }, history(), 'narrator'),
      ).toBe(false);
    });
    it('control — the identical fixture without the substitution field still clears via the marker comparison', () => {
      expect(
        isAudioCurrent(res('history', ['mayrin']), { castHistorySeq: 5 }, history()),
      ).toBe(true);
    });
    it('no stamp + substitution is STALE, not UNKNOWN — round 3 hoisted the check above the !finite(stamp) guard too, since a recorded substitution is affirmative evidence and needs no stamp to be meaningful', () => {
      expect(isAudioCurrent(res('history', ['mayrin']), {}, history(), 'narrator')).toBe(false);
    });
  });

  describe('the alias tiers', () => {
    it('is current when the render is at or above the marker', () => {
      expect(isAudioCurrent(res('history', ['mayrin']), { castHistorySeq: 3 }, history())).toBe(
        true,
      );
      expect(isAudioCurrent(res('history', ['mayrin']), { castHistorySeq: 4 }, history())).toBe(
        true,
      );
    });
    it('is STALE when the render predates the marker', () => {
      expect(isAudioCurrent(res('history', ['mayrin']), { castHistorySeq: 2 }, history())).toBe(
        false,
      );
    });
    it('takes the MAX over every matched key (fail-closed)', () => {
      /* `seq: 9` is NOT decoration — the helper defaults to 5, and a
         `castHistorySeq` of 7 against a file seq of 5 trips the counter-reset
         guard and returns 'unknown' before the max is ever computed. Review
         round 1 (I7) caught the second assertion passing for that reason. */
      const h = history({
        seq: 9,
        recordedAtSeq: { a: 2, b: 7 },
        supersededBy: { a: 'mairin', b: 'mairin' },
      });
      expect(isAudioCurrent(res('normalised-history', ['a', 'b']), { castHistorySeq: 4 }, h)).toBe(
        false,
      );
      expect(isAudioCurrent(res('normalised-history', ['a', 'b']), { castHistorySeq: 7 }, h)).toBe(
        true,
      );
    });
    it('treats a key absent from a PRESENT field as UNKNOWN, never as 0 (I2, owner-ruled)', () => {
      /* `cast-id-history.ts`'s `recordedAtSeq` doc comment was corrected
         (#2128 review round 1, I2) from "contributes 0" to "must read
         'unknown', never contribute 0" — `bumpSeqAndStamp`'s reconcile loops
         guarantee every `supersededBy` key has a marker after every write, so
         a key missing here despite the field being present means the file
         itself is suspect, not merely old. Treating it as 0 would satisfy
         `stamp >= 0` for ANY finite render stamp and silently reopen #2107 —
         this is trap 3 from the task brief, corrected in the predicate to
         match the corrected doc comment it consumes. */
      const h = history({ recordedAtSeq: {} });
      expect(isAudioCurrent(res('history', ['mayrin']), { castHistorySeq: 0 }, h)).toBe('unknown');
    });
    it('an EMPTY matchedHistoryKeys is UNKNOWN, never vacuously current (trap 1)', () => {
      /* The type permits `matchedHistoryKeys: []` even though the sole
         producer (`buildCastResolver`) never emits it for the 'history' /
         'normalised-history' tiers today (tier 2 always carries exactly one
         key, tier 4's `normHistoryKeys` and `byNormHistory` are populated in
         lockstep so a resolved tier-4 hit always has >= 1). A seed-0 reduce
         over an empty list is the exact fail-open shape the task brief's
         trap 1 warns about: `stamp >= 0` is true for any non-negative render
         stamp, vacuously clearing a row that was never actually verified
         against a marker. */
      expect(isAudioCurrent(res('history', []), { castHistorySeq: 0 }, history())).toBe('unknown');
    });
  });

  describe('every unknown source LISTS — getting this backwards re-opens #2107', () => {
    it('no castHistorySeq', () => {
      expect(isAudioCurrent(res('history', ['mayrin']), {}, history())).toBe('unknown');
      expect(isAudioCurrent(res('history', ['mayrin']), undefined, history())).toBe('unknown');
    });
    it('no recordedAtSeq FIELD — never been through the lane', () => {
      expect(
        isAudioCurrent(
          res('history', ['mayrin']),
          { castHistorySeq: 4 },
          history({ recordedAtSeq: undefined }),
        ),
      ).toBe('unknown');
    });
    it('counter reset — the file counter is below a render stamp', () => {
      // helper default seq is 5; the render claims 9, which it cannot have read.
      expect(isAudioCurrent(res('history', ['mayrin']), { castHistorySeq: 9 }, history())).toBe(
        'unknown',
      );
    });
    it('NO seq at all — the conjunctive form of the guard fails open (round 1, C1)', () => {
      /* `recordedAtSeq` present, `seq` dropped in transit. Under
         `finite(history.seq) && …` this returned `true` and cleared the row. */
      const h = history({ seq: undefined, recordedAtSeq: { mayrin: 3 } });
      expect(isAudioCurrent(res('history', ['mayrin']), { castHistorySeq: 9 }, h)).toBe('unknown');
    });
    it('a non-finite marker', () => {
      /* `castHistorySeq: 4` (not 9) so this reaches the marker loop instead of
         being short-circuited by the counter-reset guard — round 1 (I8) caught
         it passing for the wrong reason, which made its Step 5 mutant inert. */
      const h = history({ recordedAtSeq: { mayrin: Number.NaN } });
      expect(isAudioCurrent(res('history', ['mayrin']), { castHistorySeq: 4 }, h)).toBe('unknown');
    });
    it('a non-finite castHistorySeq', () => {
      expect(
        isAudioCurrent(res('history', ['mayrin']), { castHistorySeq: Number.NaN }, history()),
      ).toBe('unknown');
    });
  });

  it('treats castHistorySeq === 0 as PRESENT, never as absent', () => {
    // An `if (!castHistorySeq)` check ships #2128 dead: every legacy case
    // routes to 'unknown' and no row ever clears.
    const h = history({ recordedAtSeq: { mayrin: 0 } });
    expect(isAudioCurrent(res('history', ['mayrin']), { castHistorySeq: 0 }, h)).toBe(true);
  });

  it('treats history.seq === 0 as a REAL file counter, never as absent (trap 2)', () => {
    // An `if (!history.seq)` counter-reset guard is the truthiness twin of the
    // castHistorySeq bug above: seq 0 is a genuine (if minimal) file counter —
    // e.g. a well-formed but never-written-through-the-lane file with no marks
    // at all, per `repairSeq`'s own `Math.max(..., 0)` floor — and must not be
    // conflated with `seq` being absent, which is a DIFFERENT, already-covered
    // 'unknown' source ("NO seq at all", above). `Number.isFinite(0)` is
    // `true`; `!0` is also `true` — only `finite()` tells them apart.
    const h = history({ seq: 0, recordedAtSeq: { mayrin: 0 } });
    expect(isAudioCurrent(res('history', ['mayrin']), { castHistorySeq: 0 }, h)).toBe(true);
  });
});

/* The two regressions revisions 2 and 3 of the spec were written to close. They
   are stated as END-TO-END scenarios, not unit cases, because both are about a
   SEQUENCE of writes producing a marker the predicate then reads — a unit test
   of either half alone passes while the pair is broken. */
describe('#2128 — the two hazard scenarios', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cac-'));
  });

  it('forget -> re-render -> restore: the Undo must NOT clear a narrator render', async () => {
    /* Revision 3's Critical. `retireCharacterId` writes seq 1:
       supersededBy['mayrin']='mairin', marker mayrin@1. The operator rejects
       the pairing, so `forgetSupersededId` removes the entry (seq 2, no more
       marker for 'mayrin'). The chapter is re-rendered with NO alias, so
       those segments render as the NARRATOR, stamped castHistorySeq 2. The
       operator clicks Undo, and `restoreSupersededId` writes seq 3:
       supersededBy['mayrin']='mairin' again, marker mayrin@3.

       Revision 3 had `restoreSupersededId` REPLAY the stashed marker (1,
       i.e. the marker from BEFORE the forget), making the narrator render's
       castHistorySeq 2 >= 1 true and clearing a row whose audio is the
       narrator's, not mayrin's. It stamps the CURRENT seq (3) instead, so
       2 >= 3 is false and the row correctly stays listed. */
    // `dir` is declared in this describe block's own `beforeEach` above,
    // fresh per test — not a module-level fixture.
    await retireCharacterId(dir, 'mayrin', 'mairin'); // seq 1, mayrin@1
    await forgetSupersededId(dir, 'mayrin'); // seq 2
    const renderedWithNoAlias = { castHistorySeq: 2 }; // narrator bytes
    await restoreSupersededId(dir, 'mayrin', 'mairin', ['mairin']); // seq 3, mayrin@3
    const h = await loadCastIdHistory(dir);

    expect(isAudioCurrent(res('history', ['mayrin']), renderedWithNoAlias, h)).toBe(false);
  });

  it('merge-repoint: an alias moved onto a different cast row re-lists', async () => {
    /* `routes/cast-merge.ts:230` retires `sourceId` into `targetId` after
       merging, and the repoint loop rewrites every entry whose VALUE was
       `sourceId`. Same person, different cast ROW — `targetId`'s voice is
       whichever row won. A render made while the alias pointed at `sourceId`
       used `sourceId`'s voice, so its bytes are stale even though the KEY never
       changed. This is what "recordedAtSeq tracks the CURRENT target" buys. */
    // `dir` is declared in this describe block's own `beforeEach` above,
    // fresh per test — not a module-level fixture.
    await retireCharacterId(dir, 'mayrin', 'mairin'); // seq 1, mayrin@1
    const renderedAgainstMairin = { castHistorySeq: 1 };
    await retireCharacterId(dir, 'mairin', 'dame-alina'); // seq 2, mayrin repointed@2
    const h = await loadCastIdHistory(dir);

    expect(isAudioCurrent(res('history', ['mayrin']), renderedAgainstMairin, h)).toBe(false);
  });
});

describe('aggregateAudioCurrency — one verdict per orphaned id across chapters', () => {
  it('any false wins', () => {
    expect(aggregateAudioCurrency([true, 'unknown', false])).toBe(false);
  });
  it('else any unknown wins', () => {
    expect(aggregateAudioCurrency([true, 'unknown', true])).toBe('unknown');
  });
  it('all true is true', () => {
    expect(aggregateAudioCurrency([true, true])).toBe(true);
  });
  it('an id current in ch2 and stale in ch5 is NOT current', () => {
    // The "any-current => true" direction re-opens #2107 on the banner side.
    expect(aggregateAudioCurrency([true, false])).toBe(false);
  });
  it('an EMPTY list is UNKNOWN, never vacuously true (I1, owner-ruled)', () => {
    // No evidence is not evidence of currency. A consumer that builds its
    // per-chapter list with a filter (e.g. chapters that actually have a
    // segments file) can hand this an empty array; reading that as `true`
    // is #2107's shape on the banner side, on zero evidence.
    expect(aggregateAudioCurrency([])).toBe('unknown');
  });
});
