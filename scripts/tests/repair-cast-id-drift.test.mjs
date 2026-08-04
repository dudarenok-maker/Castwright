// Unit tests for scripts/repair-cast-id-drift.mjs's pure helpers (#2040 Wave
// 3 Task 18). Imports ONLY this script's own exports — never `server/dist` —
// so these tests run under `npm run test:hooks` with no build step, even
// though the script's own `main()` needs one (see the script's module doc
// comment). Run directly: `node --test scripts/tests/repair-cast-id-drift.test.mjs`.
//
// Review round 1 (two Criticals, three Importants) landed on top of the
// original 40 tests — see the `CRITICAL`/`IMPORTANT` prefixed test names
// below for the ones added or inverted in response. Full account in
// .superpowers/sdd/2026-08-01-cast-character-identity/task-18-report.md.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  formatDuration,
  buildNameIndex,
  resolveTierAName,
  resolveTierBId,
  snapshotsConsistent,
  rankSnapshotCandidates,
  planBookRepairs,
  buildRerenderRows,
} from '../repair-cast-id-drift.mjs';

// Simple stand-ins for the real server normalisers — deliberately NOT a
// byte-for-byte reimplementation of normaliseForMatch/normaliseIdKey (that
// would be exactly the "two independent matchers" hazard this task exists
// to avoid). These only need to exercise this script's OWN algorithmic
// decisions (ambiguity handling, tier precedence, the four auto-record
// guards); production always wires in the real ones (see main()).
const lc = (s) => String(s).trim().toLowerCase();
const idKey = (s) => String(s).toLowerCase().replace(/[-_\s]+/g, '-');

/** Minimal stand-in for the server's real `buildCastResolver` — NOT a
 *  byte-for-byte reimplementation of its full four-tier precedence (that
 *  would itself be a second matcher; production always wires in the real
 *  one, dynamically imported in main()). Implements only what these tests
 *  need: exact-id lookup and the normalised-id tier, INCLUDING the real
 *  resolver's "the same id appearing twice is not a collision" rule
 *  (`cast-resolve.ts:74`'s `put()`: `m.get(k)?.id !== c.id`) — the exact
 *  distinction whose absence in the ORIGINAL `resolveTierBId` (a
 *  hand-rolled `.filter(...).length === 1` over liveCast) was review round
 *  1's Minor finding. Always a builder function `(cast, history) =>
 *  { resolve(id) }`, matching production's signature, so
 *  `deps.buildCastResolver` is swappable for the real one with no
 *  call-site changes. */
function makeFakeResolver(idKeyFn) {
  return function buildFakeResolver(cast) {
    const byId = new Map();
    const byNormId = new Map();
    for (const c of cast) {
      if (!byId.has(c.id)) byId.set(c.id, c);
      const key = idKeyFn(c.id);
      if (byNormId.has(key)) {
        if (byNormId.get(key)?.id !== c.id) byNormId.set(key, null);
      } else {
        byNormId.set(key, c);
      }
    }
    return {
      resolve(id) {
        const exact = byId.get(id);
        if (exact) return { character: exact, via: 'exact' };
        const key = idKeyFn(id);
        if (byNormId.has(key)) {
          const match = byNormId.get(key);
          return match ? { character: match, via: 'normalised-id' } : undefined;
        }
        return undefined;
      },
    };
  };
}

describe('parseArgs', () => {
  test('no args -> apply false', () => {
    assert.deepEqual(parseArgs([]), { apply: false });
  });
  test('--apply -> apply true', () => {
    assert.deepEqual(parseArgs(['--apply']), { apply: true });
  });
  test('unrelated args do not set apply', () => {
    assert.deepEqual(parseArgs(['--foo', 'bar']), { apply: false });
  });
});

describe('formatDuration', () => {
  test('under a minute', () => {
    assert.equal(formatDuration(42), '42s');
  });
  test('over a minute', () => {
    assert.equal(formatDuration(125), '2m 5s');
  });
  test('rounds and floors negative to 0', () => {
    assert.equal(formatDuration(-5), '0s');
  });
});

describe('buildNameIndex', () => {
  test('single consistent name -> unambiguous', () => {
    const idx = buildNameIndex(
      [
        { id: 'mayrin', name: 'Мэйрин' },
        { id: 'mayrin', name: 'Мэйрин' },
      ],
      lc,
    );
    assert.deepEqual(idx.get('mayrin'), { name: 'Мэйрин', ambiguous: false, distinctNames: [lc('Мэйрин')] });
  });

  test('two distinct normalised names for the same id -> ambiguous, name undefined', () => {
    const idx = buildNameIndex(
      [
        { id: 'unknown-male', name: 'Timkin' },
        { id: 'unknown-male', name: 'Rex' },
      ],
      lc,
    );
    const entry = idx.get('unknown-male');
    assert.equal(entry.ambiguous, true);
    assert.equal(entry.name, undefined);
    assert.deepEqual(entry.distinctNames.sort(), ['rex', 'timkin']);
  });

  test('same name repeated across many entries stays unambiguous (five chapters, one name)', () => {
    const entries = Array.from({ length: 5 }, () => ({ id: 'timkin', name: 'Timkin' }));
    const idx = buildNameIndex(entries, lc);
    assert.equal(idx.get('timkin').ambiguous, false);
  });

  test('ignores entries missing id or name', () => {
    const idx = buildNameIndex([{ id: 'x' }, { name: 'y' }, { id: '', name: 'z' }], lc);
    assert.equal(idx.size, 0);
  });
});

describe('resolveTierAName', () => {
  const liveCast = [
    { id: 'mairin', name: 'Мэйрин' },
    { id: 'coalfall-dragon', name: 'Коалфолл' },
  ];

  test('exact single match', () => {
    assert.equal(resolveTierAName('Мэйрин', liveCast, lc), 'mairin');
  });

  test('no match -> undefined', () => {
    assert.equal(resolveTierAName('Nobody', liveCast, lc), undefined);
  });

  test('empty candidate -> undefined (first guard)', () => {
    assert.equal(resolveTierAName('', liveCast, lc), undefined);
    assert.equal(resolveTierAName(undefined, liveCast, lc), undefined);
  });

  test('an undefined candidate never coerces into an accidental match (proves the first guard is load-bearing, not just cosmetic)', () => {
    // String(undefined) is the literal string "undefined", which normalises
    // (via `lc`) to the same "undefined" a live character named "Undefined"
    // would. Without the `!candidateName` guard firing FIRST, `undefined`
    // would fall through to `normaliseFn(candidateName)` and could
    // genuinely match this row — the two tests above only check the
    // FINAL return value, which happens to stay `undefined` for OTHER
    // reasons (no live row named "Undefined") even if the guard itself
    // were deleted; this one fails specifically if that happens.
    const trapCast = [{ id: 'trap', name: 'Undefined' }];
    assert.equal(resolveTierAName(undefined, trapCast, lc), undefined);
  });

  test('whitespace-only candidate normalises to empty -> undefined (second guard, distinct from the first)', () => {
    // '   ' is truthy as a string (passes the `!candidateName` guard) but
    // `lc('   ')` trims to '' — this exercises the SEPARATE `!target`
    // guard, not the empty-string-input guard above.
    assert.equal(resolveTierAName('   ', liveCast, lc), undefined);
  });

  test('a whitespace-only candidate never coerces into an accidental match on a live row with a blank name (proves the second guard is load-bearing, not just cosmetic)', () => {
    // A live row with an all-whitespace name also normalises to '' — the
    // test above only checks the FINAL return value, which stays
    // `undefined` for a DIFFERENT reason (no live row normalises to '' in
    // that fixture) even if the `!target` guard itself were deleted; this
    // one fails specifically if that happens.
    const trapCast = [{ id: 'trap', name: '   ' }];
    assert.equal(resolveTierAName('   ', trapCast, lc), undefined);
  });

  test('tie on the live side -> undefined (never guess)', () => {
    const tied = [
      { id: 'a1', name: 'Pool Player' },
      { id: 'a2', name: 'pool player' },
    ];
    assert.equal(resolveTierAName('Pool Player', tied, lc), undefined);
  });
});

describe('resolveTierBId', () => {
  const buildResolver = makeFakeResolver(idKey);

  test('encoding-equivalent id matches', () => {
    const resolver = buildResolver([{ id: 'the_torment', name: 'The Torment' }]);
    assert.equal(resolveTierBId('the-torment', resolver), 'the_torment');
  });

  test('a genuinely different id does not match', () => {
    const resolver = buildResolver([{ id: 'the_torment', name: 'The Torment' }]);
    assert.equal(resolveTierBId('pool-player-2', resolver), undefined);
  });

  test('two DIFFERENT live ids sharing a normalised key is a real tie -> undefined', () => {
    const resolver = buildResolver([
      { id: 'foo-bar', name: 'A' },
      { id: 'foo_bar', name: 'B' },
    ]);
    assert.equal(resolveTierBId('foo bar', resolver), undefined);
  });

  test('MINOR (review round 1): the SAME live id appearing twice in the cast array is NOT a tie', () => {
    // A cast.json with a duplicate row (same id twice — a malformed merge,
    // say) is not two different characters colliding. cast-resolve.ts's
    // own `put()` explicitly does not null the slot when the id matches
    // (`m.get(k)?.id !== c.id`). The ORIGINAL resolveTierBId (a hand-rolled
    // `.filter(...).length === 1` over liveCast) could not make this
    // distinction and would have wrongly refused this match — a second
    // matcher with a tie rule that diverged from the real resolver.
    const resolver = buildResolver([
      { id: 'timkin', name: 'Timkin' },
      { id: 'timkin', name: 'Timkin' },
    ]);
    assert.equal(resolveTierBId('TIMKIN', resolver), 'timkin');
  });

  test('an id that already matches a live id EXACTLY is not reported as a Tier B match — Tier B is id-shape only', () => {
    // Caught while mutation-testing round 1's fixes: `resolveTierBId` only
    // trusts `resolution.via === 'normalised-id'`, not "any truthy
    // resolution". Nothing in `planBookRepairs` should ever call this with
    // an id that resolves 'exact' (the caller already filtered live ids
    // out), but the function's OWN contract — Tier B is id-SHAPE evidence,
    // not "resolves somehow" — is real and worth pinning directly rather
    // than relying on an upstream caller invariant to make it unreachable.
    const resolver = buildResolver([{ id: 'timkin', name: 'Timkin' }]);
    assert.equal(resolveTierBId('timkin', resolver), undefined);
  });
});

describe('snapshotsConsistent', () => {
  test('vacuously true for zero or one snapshot', () => {
    assert.equal(snapshotsConsistent([]), true);
    assert.equal(snapshotsConsistent([{ gender: 'male' }]), true);
    assert.equal(snapshotsConsistent([undefined]), true);
  });

  test('true when every defined field agrees across chapters', () => {
    const snap = { gender: 'male', ageRange: 'adult', voiceEngine: 'kokoro' };
    assert.equal(snapshotsConsistent([snap, { ...snap }, { ...snap }]), true);
  });

  test('false on a gender conflict', () => {
    assert.equal(snapshotsConsistent([{ gender: 'male' }, { gender: 'female' }]), false);
  });

  test('false on a voiceId conflict even when gender agrees', () => {
    assert.equal(
      snapshotsConsistent([
        { gender: 'female', voiceId: 'vika' },
        { gender: 'female', voiceId: 'bex' },
      ]),
      false,
    );
  });

  test('undefined fields do not count as a conflict', () => {
    assert.equal(snapshotsConsistent([{ gender: 'male' }, { gender: 'male', ageRange: 'adult' }]), true);
  });

  test('a single defined value among otherwise-undefined snapshots is not a conflict (the undefined/null filter this guard depends on)', () => {
    // If the undefined/null filter were removed, comparing raw values
    // would put {'vika', undefined, undefined} into the Set (size 2) and
    // this would wrongly read as a conflict. This is exactly the shape
    // that made snapshotsConsistent pass vacuously on the real Exile
    // unknown-male/unknown-female data (review round 1, Critical 1) — the
    // function's OWN behaviour here is correct (no information, no
    // conflict); the bug was relying on it as a SOLE guard against a
    // reserved-bucket reuse, fixed separately by the reserved-source /
    // cross-source-ambiguity guards in planBookRepairs.
    assert.equal(
      snapshotsConsistent([{ gender: 'female', voiceId: 'vika' }, { gender: 'female' }, { gender: 'female' }]),
      true,
    );
  });
});

describe('rankSnapshotCandidates', () => {
  const liveCast = [
    { id: 'narrator', name: 'Narrator', gender: 'neutral' },
    { id: 'timkin', name: 'Timkin', gender: 'male', ageRange: 'adult', attributes: ['gruff', 'arrogant'] },
    { id: 'vika', name: 'Vika', gender: 'female', ageRange: 'adult', attributes: ['curious'] },
  ];
  const reserved = new Set(['narrator']);

  test('empty snapshot -> empty candidates', () => {
    assert.deepEqual(rankSnapshotCandidates(undefined, liveCast, reserved), []);
  });

  test('gender match outranks gender mismatch', () => {
    const ranked = rankSnapshotCandidates({ gender: 'male', ageRange: 'adult' }, liveCast, reserved);
    assert.equal(ranked[0].liveId, 'timkin');
    const timkinScore = ranked.find((r) => r.liveId === 'timkin').score;
    const vikaScore = ranked.find((r) => r.liveId === 'vika').score;
    assert.ok(timkinScore > vikaScore, `expected timkin (${timkinScore}) > vika (${vikaScore})`);
  });

  test('reserved ids are never suggested', () => {
    const ranked = rankSnapshotCandidates({ gender: 'neutral' }, liveCast, reserved);
    assert.ok(!ranked.some((r) => r.liveId === 'narrator'));
  });

  test('attribute overlap increases score', () => {
    const withOverlap = rankSnapshotCandidates({ gender: 'male', attributes: ['gruff', 'arrogant'] }, liveCast, reserved);
    const withoutOverlap = rankSnapshotCandidates({ gender: 'male', attributes: ['bubbly'] }, liveCast, reserved);
    const scoreWith = withOverlap.find((r) => r.liveId === 'timkin').score;
    const scoreWithout = withoutOverlap.find((r) => r.liveId === 'timkin').score;
    assert.ok(scoreWith > scoreWithout);
  });

  test('attribute overlap score is exactly Jaccard x 20', () => {
    // snapshot ['a','b','d'] vs live ['a','b','c'] -> intersection 2, union
    // 4 -> jaccard 0.5 -> +10. Isolated from gender/ageRange/tone (no
    // shared/overlapping fields defined) so this is an exact check, not
    // just a "more is better" comparison.
    const liveAttrsOnly = [{ id: 'e', name: 'E', attributes: ['a', 'b', 'c'] }];
    const ranked = rankSnapshotCandidates({ attributes: ['a', 'b', 'd'] }, liveAttrsOnly, new Set());
    assert.ok(Math.abs(ranked[0].score - 10) < 1e-9, `expected score 10 (0.5 x 20), got ${ranked[0].score}`);
  });

  test('IMPORTANT 3: tone similarity increases score, and the "tone similar" label appears above the 0.5 similarity threshold', () => {
    const liveWithTone = [
      { id: 'a', name: 'A', tone: { warmth: 50, pace: 50, authority: 50, emotion: 50 } },
      { id: 'b', name: 'B', tone: { warmth: 0, pace: 0, authority: 0, emotion: 0 } },
    ];
    const ranked = rankSnapshotCandidates({ tone: { warmth: 50, pace: 50, authority: 50, emotion: 50 } }, liveWithTone, new Set());
    const scoreA = ranked.find((r) => r.liveId === 'a').score; // exact match: dist=0, sim=1 -> +20
    const scoreB = ranked.find((r) => r.liveId === 'b').score; // dist=50, sim=0.5 -> +10
    assert.ok(scoreA > scoreB, `expected exact tone match (${scoreA}) > distant tone (${scoreB})`);
    assert.ok(ranked.find((r) => r.liveId === 'a').why.includes('tone similar'));
    assert.ok(Math.abs(scoreA - 20) < 1e-9);
    assert.ok(Math.abs(scoreB - 10) < 1e-9);
  });

  test('IMPORTANT 3: tone dissimilarity below the 0.5 threshold does not get the "tone similar" label', () => {
    const liveFarTone = [{ id: 'c', name: 'C', tone: { warmth: 100, pace: 100, authority: 100, emotion: 100 } }];
    const ranked = rankSnapshotCandidates({ tone: { warmth: 0, pace: 0, authority: 0, emotion: 0 } }, liveFarTone, new Set());
    assert.ok(!ranked[0].why.includes('tone similar'));
  });

  test('IMPORTANT 3: tone is only scored on fields both sides define', () => {
    const liveMissingTone = [{ id: 'd', name: 'D' }]; // no tone, no gender, no ageRange, no attributes
    const ranked = rankSnapshotCandidates({ tone: { warmth: 50 } }, liveMissingTone, new Set());
    assert.equal(ranked[0].score, 0);
  });

  test('respects topN', () => {
    const ranked = rankSnapshotCandidates({ gender: 'male' }, liveCast, reserved, 1);
    assert.equal(ranked.length, 1);
  });
});

describe('planBookRepairs', () => {
  const buildResolver = makeFakeResolver(idKey);
  const deps = {
    normaliseForMatch: lc,
    buildCastResolver: buildResolver,
    reservedIds: new Set(['narrator', 'unknown-male', 'unknown-female']),
    normaliseIdKey: idKey,
  };
  const liveCast = [
    { id: 'narrator', name: 'Narrator' },
    { id: 'mairin', name: 'Мэйрин' },
    { id: 'timkin', name: 'Timkin', gender: 'male', ageRange: 'adult' },
  ];

  /** A single-chapter rendered orphan with real segments — IMPORTANT 2
   *  means every auto-record test below needs actual on-disk damage, not
   *  an empty `orphans` map, or the zero-segment guard now (correctly)
   *  downgrades it to report-only. */
  const renderedOrphan = (segments, chapters) => ({
    segments,
    chapters: chapters ?? [{ chapterId: 1, chapterTitle: 'One', segments, durationSec: segments * 2 }],
    snapshots: [],
  });

  test('Tier A auto-record via an unambiguous cache name, when the id has real rendered damage', () => {
    const cacheNameIndex = buildNameIndex([{ id: 'mayrin', name: 'Мэйрин' }], lc);
    const orphans = new Map([['mayrin', renderedOrphan(8)]]);
    const plan = planBookRepairs({ liveCast, history: {}, cacheNameIndex, bakNameIndex: new Map(), orphans }, deps);
    assert.equal(plan.autoRecord.length, 1);
    assert.equal(plan.autoRecord[0].id, 'mayrin');
    assert.equal(plan.autoRecord[0].to, 'mairin');
    assert.equal(plan.autoRecord[0].tier, 'A');
    assert.equal(plan.autoRecord[0].segments, 8);
    assert.equal(plan.reportOnly.length, 0);
  });

  test('bak-file name is preferred over a DIFFERENT cache name (non-reserved id, real rendered damage)', () => {
    const cacheNameIndex = buildNameIndex([{ id: 'old-timkin-alias', name: 'Someone Else' }], lc);
    const bakNameIndex = buildNameIndex([{ id: 'old-timkin-alias', name: 'Timkin' }], lc);
    const orphans = new Map([['old-timkin-alias', renderedOrphan(5)]]);
    const plan = planBookRepairs({ liveCast, history: {}, cacheNameIndex, bakNameIndex, orphans }, deps);
    assert.equal(plan.autoRecord.length, 1);
    assert.equal(plan.autoRecord[0].to, 'timkin');
    assert.match(plan.autoRecord[0].evidence, /cast\.json\.bak/);
  });

  test('an id the cache names differently across chapters is ambiguous -> reported, not auto-recorded (non-reserved id)', () => {
    const cacheNameIndex = buildNameIndex(
      [
        { id: 'mystery-guy', name: 'Timkin' },
        { id: 'mystery-guy', name: 'Rex' },
      ],
      lc,
    );
    const orphans = new Map([['mystery-guy', renderedOrphan(3)]]);
    const plan = planBookRepairs({ liveCast, history: {}, cacheNameIndex, bakNameIndex: new Map(), orphans }, deps);
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.reportOnly.length, 1);
    assert.match(plan.reportOnly[0].reason, /different things/);
  });

  test('CRITICAL 2 combination: an unambiguous bak name does NOT override an ambiguous cache for the same id (cross-source ambiguity veto)', () => {
    const cacheNameIndex = buildNameIndex(
      [
        { id: 'reused-slot', name: 'Timkin' },
        { id: 'reused-slot', name: 'Rex' },
      ],
      lc,
    );
    const bakNameIndex = buildNameIndex([{ id: 'reused-slot', name: 'Timkin' }], lc); // unambiguous ON ITS OWN
    const orphans = new Map([['reused-slot', renderedOrphan(4)]]);
    const plan = planBookRepairs({ liveCast, history: {}, cacheNameIndex, bakNameIndex, orphans }, deps);
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.reportOnly.length, 1);
    assert.match(plan.reportOnly[0].reason, /analysis cache names this id 2 different things/);
    assert.match(plan.reportOnly[0].reason, /vetoes an auto-record from EITHER source/);
  });

  test('an id already in supersededBy is skipped, not re-recorded', () => {
    const cacheNameIndex = buildNameIndex([{ id: 'mayrin', name: 'Мэйрин' }], lc);
    const plan = planBookRepairs(
      { liveCast, history: { supersededBy: { mayrin: 'mairin' } }, cacheNameIndex, bakNameIndex: new Map(), orphans: new Map() },
      deps,
    );
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.skipped.length, 1);
    assert.equal(plan.skipped[0].reason, 'already-recorded');
  });

  test('a rejected id is skipped even though a name match exists', () => {
    const cacheNameIndex = buildNameIndex([{ id: 'mayrin', name: 'Мэйрин' }], lc);
    const plan = planBookRepairs(
      { liveCast, history: { rejected: ['mayrin'] }, cacheNameIndex, bakNameIndex: new Map(), orphans: new Map() },
      deps,
    );
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.skipped.length, 1);
    assert.equal(plan.skipped[0].reason, 'rejected');
  });

  test('inconsistent characterSnapshots across chapters downgrade a name match to report-only (non-reserved id)', () => {
    const bakNameIndex = buildNameIndex([{ id: 'unstable-guy', name: 'Timkin' }], lc);
    const orphans = new Map([
      [
        'unstable-guy',
        {
          segments: 2,
          chapters: [
            { chapterId: 7, chapterTitle: 'Five', segments: 1, durationSec: 3 },
            { chapterId: 33, chapterTitle: 'Thirty-One', segments: 1, durationSec: 2 },
          ],
          snapshots: [
            { gender: 'male', ageRange: 'adult' },
            { gender: 'female', ageRange: 'adult' }, // conflict
          ],
        },
      ],
    ]);
    const plan = planBookRepairs({ liveCast, history: {}, cacheNameIndex: new Map(), bakNameIndex, orphans }, deps);
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.reportOnly.length, 1);
    assert.match(plan.reportOnly[0].reason, /disagree across chapters/);
  });

  test('CRITICAL 2 (inverted): a reserved fold-bucket SOURCE id is refused even with unambiguous bak evidence and consistent characterSnapshots (the real Exile shape)', () => {
    // This test used to assert the OPPOSITE — that this exact shape
    // auto-records. That assertion WAS the bug review round 1 found:
    // Exile's cache separately shows `unknown-male` also rendered as Rex
    // (ch33) and an unnamed third chapter (ch60) — the single bak snapshot
    // "Timkin" is real evidence for ONE occurrence, not license to alias
    // the whole book-wide id. Inverted per the review's explicit
    // instruction, not deleted.
    const bakNameIndex = buildNameIndex([{ id: 'unknown-male', name: 'Timkin' }], lc);
    const snap = { gender: 'male', ageRange: 'adult', voiceEngine: 'kokoro' };
    const orphans = new Map([
      [
        'unknown-male',
        {
          segments: 21,
          chapters: [
            { chapterId: 7, chapterTitle: 'Five', segments: 13, durationSec: 40 },
            { chapterId: 33, chapterTitle: 'Thirty-One', segments: 4, durationSec: 10 },
            { chapterId: 60, chapterTitle: 'Fifty-Eight', segments: 4, durationSec: 8 },
          ],
          snapshots: [snap, { ...snap }, { ...snap }],
        },
      ],
    ]);
    const plan = planBookRepairs({ liveCast, history: {}, cacheNameIndex: new Map(), bakNameIndex, orphans }, deps);
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.reportOnly.length, 1);
    assert.equal(plan.reportOnly[0].id, 'unknown-male');
    assert.equal(plan.reportOnly[0].segments, 21);
    assert.match(plan.reportOnly[0].reason, /reserved fold-bucket\/narrator id/);
    assert.match(plan.reportOnly[0].reason, /names one occurrence "Timkin"/);
  });

  test('MINOR (round 2): a case/separator-drifted spelling of a reserved bucket id is still refused (guard 1 normalises the membership test)', () => {
    // 'Unknown_Male' is exactly the drift class #2040 exists to catch — a
    // raw `reservedIds.has(id)` string check would miss it (the constant is
    // the canonical 'unknown-male'), letting a clean Tier A bak-name match
    // auto-record the bucket alias guard 1 exists to forbid. This is a
    // SINGLE, unambiguous occurrence (unlike the multi-chapter Exile shape
    // above) specifically so only guard 1 — not guard 2's ambiguity veto —
    // can be responsible for catching it.
    const bakNameIndex = buildNameIndex([{ id: 'Unknown_Male', name: 'Timkin' }], lc);
    const orphans = new Map([['Unknown_Male', renderedOrphan(6)]]);
    const plan = planBookRepairs({ liveCast, history: {}, cacheNameIndex: new Map(), bakNameIndex, orphans }, deps);
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.reportOnly.length, 1);
    assert.equal(plan.reportOnly[0].id, 'Unknown_Male');
    assert.match(plan.reportOnly[0].reason, /reserved fold-bucket\/narrator id/);
  });

  test('a Tier A match onto a reserved TARGET id is refused (falls through, not auto-recorded)', () => {
    const cacheNameIndex = buildNameIndex([{ id: 'weird-alias', name: 'Narrator' }], lc);
    const orphans = new Map([['weird-alias', renderedOrphan(2)]]);
    const plan = planBookRepairs({ liveCast, history: {}, cacheNameIndex, bakNameIndex: new Map(), orphans }, deps);
    assert.equal(plan.autoRecord.length, 0);
    assert.ok(!plan.autoRecord.some((a) => a.to === 'narrator'));
  });

  test('IMPORTANT 2 (inverted): a Tier B id-shape match on a cache-only orphan (zero rendered segments) is report-only, never auto-recorded', () => {
    // 'TIMKIN' normalises (case-fold) to the same key as live 'timkin' —
    // purely an id-shape match, no name signal anywhere. Used to
    // auto-record; round 1 scoped auto-record to actual on-disk damage.
    const plan = planBookRepairs(
      { liveCast, history: {}, cacheNameIndex: new Map(), bakNameIndex: new Map(), orphans: new Map([['TIMKIN', { segments: 0, chapters: [], snapshots: [] }]]) },
      deps,
    );
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.reportOnly.length, 1);
    assert.equal(plan.reportOnly[0].id, 'TIMKIN');
    assert.match(plan.reportOnly[0].reason, /zero rendered segments/);
  });

  test('IMPORTANT 2: a Tier A NAME match on a cache-only orphan (zero rendered segments) is also report-only', () => {
    const cacheNameIndex = buildNameIndex([{ id: 'never-rendered-guy', name: 'Timkin' }], lc);
    // No entry in `orphans` at all -> falls back to segments: 0 inside planBookRepairs.
    const plan = planBookRepairs({ liveCast, history: {}, cacheNameIndex, bakNameIndex: new Map(), orphans: new Map() }, deps);
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.reportOnly.length, 1);
    assert.equal(plan.reportOnly[0].id, 'never-rendered-guy');
    assert.match(plan.reportOnly[0].reason, /zero rendered segments/);
  });

  test('MINOR (round 2, finding 4): a name match on an id that already auto-reconciles via the normalised-id tier gets an accurate reason, not the misleading "zero rendered segments" one', () => {
    // 'The_Torment' is never added to `orphans` (collectSegmentOrphans only
    // records ids the resolver FAILS on) because it already resolves live
    // through the normalised-id tier — exactly what the Cast banner shows
    // under "auto-reconciled", with real rendered segments behind it. The
    // OLD code fell back to `orphans.get(id) ?? { segments: 0, ... }` here
    // and reported "zero rendered segments — no damage to repair", which is
    // FALSE (it has 9) and contradicts the banner. `autoReconciled` (built
    // alongside `orphans` in the real collectSegmentOrphans) carries the
    // true count and target for this case.
    const cacheNameIndex = buildNameIndex([{ id: 'The_Torment', name: 'Timkin' }], lc);
    const autoReconciled = new Map([['The_Torment', { segments: 9, resolvedTo: 'timkin' }]]);
    const plan = planBookRepairs(
      { liveCast, history: {}, cacheNameIndex, bakNameIndex: new Map(), orphans: new Map(), autoReconciled },
      deps,
    );
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.reportOnly.length, 1);
    assert.equal(plan.reportOnly[0].id, 'The_Torment');
    assert.equal(plan.reportOnly[0].segments, 9);
    assert.match(plan.reportOnly[0].reason, /already auto-reconciles to "timkin"/);
    assert.doesNotMatch(plan.reportOnly[0].reason, /zero rendered segments/);
  });

  test('MINOR (round 2, finding 4): a genuinely never-rendered id (absent from BOTH orphans and autoReconciled) still gets the original "zero rendered segments" reason', () => {
    const cacheNameIndex = buildNameIndex([{ id: 'never-rendered-guy', name: 'Timkin' }], lc);
    const plan = planBookRepairs(
      { liveCast, history: {}, cacheNameIndex, bakNameIndex: new Map(), orphans: new Map(), autoReconciled: new Map() },
      deps,
    );
    assert.equal(plan.reportOnly[0].segments, 0);
    assert.match(plan.reportOnly[0].reason, /zero rendered segments/);
  });

  test('IMPORTANT (round 2, finding 1): cacheAvailable=false withholds an otherwise-clean Tier A auto-record, since the cross-source ambiguity veto cannot see cache evidence for this book', () => {
    // Realistic shape: bakNameIndex has a clean, unambiguous match (as it
    // would from a real cast.json.bak.*); cacheNameIndex is empty, exactly
    // as it would be from a missing cache FILE (not "cache present but this
    // id absent from it", which also produces an empty entry but is a
    // different, safe case — this test isolates the `cacheAvailable` flag
    // itself, which main() sets from whether the file exists at all).
    const bakNameIndex = buildNameIndex([{ id: 'mayrin', name: 'Мэйрин' }], lc);
    const orphans = new Map([['mayrin', renderedOrphan(8)]]);
    const plan = planBookRepairs(
      { liveCast, history: {}, cacheNameIndex: new Map(), bakNameIndex, orphans, cacheAvailable: false },
      deps,
    );
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.reportOnly.length, 1);
    assert.equal(plan.reportOnly[0].id, 'mayrin');
    assert.equal(plan.reportOnly[0].segments, 8);
    assert.match(plan.reportOnly[0].reason, /analysis-cache file was not found/);
  });

  test('IMPORTANT (round 2, finding 1): cacheAvailable defaults to true when omitted, so every pre-existing auto-record test above is unaffected', () => {
    const cacheNameIndex = buildNameIndex([{ id: 'mayrin', name: 'Мэйрин' }], lc);
    const orphans = new Map([['mayrin', renderedOrphan(8)]]);
    // `input` deliberately omits `cacheAvailable` entirely.
    const plan = planBookRepairs({ liveCast, history: {}, cacheNameIndex, bakNameIndex: new Map(), orphans }, deps);
    assert.equal(plan.autoRecord.length, 1);
    assert.equal(plan.autoRecord[0].id, 'mayrin');
  });

  test('no name and no id-shape match -> reported with ranked snapshot candidates', () => {
    const orphans = new Map([
      [
        'silveny',
        {
          segments: 17,
          chapters: [{ chapterId: 50, chapterTitle: 'Forty-Eight', segments: 6, durationSec: 12 }],
          snapshots: [],
        },
      ],
    ]);
    const plan = planBookRepairs({ liveCast, history: {}, cacheNameIndex: new Map(), bakNameIndex: new Map(), orphans }, deps);
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.reportOnly.length, 1);
    assert.equal(plan.reportOnly[0].id, 'silveny');
    assert.match(plan.reportOnly[0].reason, /no display name found/);
  });
});

describe('buildRerenderRows', () => {
  test('flattens an id -> chapters map into one row per chapter', () => {
    const orphans = new Map([
      [
        'coalfall',
        {
          segments: 13,
          chapters: [{ chapterId: 2, chapterTitle: 'One', segments: 13, durationSec: 45.5 }],
          snapshots: [],
        },
      ],
      [
        'mayrin',
        {
          segments: 8,
          chapters: [{ chapterId: 2, chapterTitle: 'One', segments: 8, durationSec: 20 }],
          snapshots: [],
        },
      ],
    ]);
    const rows = buildRerenderRows('Заказ Коалфолла', orphans);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { book: 'Заказ Коалфолла', chapterId: 2, chapterTitle: 'One', id: 'coalfall', segments: 13, durationSec: 45.5 });
  });

  test('an id with no rendered chapters contributes no rows', () => {
    const orphans = new Map([['cache-only-id', { segments: 0, chapters: [], snapshots: [] }]]);
    assert.deepEqual(buildRerenderRows('Book', orphans), []);
  });

  test('an id spanning multiple chapters produces multiple rows', () => {
    const orphans = new Map([
      [
        'unknown-male',
        {
          segments: 21,
          chapters: [
            { chapterId: 7, chapterTitle: 'Five', segments: 13, durationSec: 40 },
            { chapterId: 33, chapterTitle: 'Thirty-One', segments: 4, durationSec: 10 },
            { chapterId: 60, chapterTitle: 'Fifty-Eight', segments: 4, durationSec: 8 },
          ],
          snapshots: [],
        },
      ],
    ]);
    const rows = buildRerenderRows('Exile', orphans);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.chapterId), [7, 33, 60]);
  });
});
