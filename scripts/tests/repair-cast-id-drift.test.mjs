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
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
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
  shouldRefuseApplyForWithheldAutoRecord,
  planApplyRefusal,
  formatReportRowSummary,
  readAnalysisCache,
  isCacheAvailable,
  cacheAvailableFromParsed,
  probePortRangeRefused,
  buildOrphansFromSegments,
  AUTO_REBIND_RANGE,
  shouldRefuseApplyForEmptyScan,
  formatBooksScannedLine,
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

/** A SEPARATE, history-aware resolver builder — used ONLY by the two I-A
 *  regression tests below (independent review, 2026-08-05). `makeFakeResolver`
 *  above deliberately ignores its `history` argument (see its own doc
 *  comment: "exact-id lookup and the normalised-id tier" only), which means
 *  it cannot demonstrate `planBookRepairs`'s fail-closed `historyResolver`
 *  default on its own — with it, an omitted resolver and a REAL history-
 *  aware one are indistinguishable in every OTHER test in this file, simply
 *  because `deps.buildCastResolver` here never reads `history` regardless.
 *  This one does (`'exact'`, `'history'`, `'normalised-id'` — the three
 *  tiers those two tests need; `'normalised-history'` omitted, unneeded by
 *  either probe). Not a general-purpose fourth resolver stand-in: scoped
 *  narrowly to prove the default itself, not to replace `makeFakeResolver`
 *  anywhere else. */
function makeHistoryAwareFakeResolver(idKeyFn) {
  return function buildHistoryAwareFakeResolver(cast, history = {}) {
    const byId = new Map(cast.map((c) => [c.id, c]));
    const byNormId = new Map(cast.map((c) => [idKeyFn(c.id), c]));
    const supersededBy = history.supersededBy ?? {};
    return {
      resolve(id) {
        if (byId.has(id)) return { character: byId.get(id), via: 'exact' };
        if (id in supersededBy) {
          const target = byId.get(supersededBy[id]);
          if (target) return { character: target, viaAlias: id, via: 'history' };
        }
        const normId = byNormId.get(idKeyFn(id));
        if (normId) return { character: normId, viaAlias: id, via: 'normalised-id' };
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
    const plan = planBookRepairs({ liveCast, history: {}, cacheNameIndex, bakNameIndex: new Map(), orphans, cacheAvailable: true }, deps);
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
    const plan = planBookRepairs({ liveCast, history: {}, cacheNameIndex, bakNameIndex, orphans, cacheAvailable: true }, deps);
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

  test('an id already in supersededBy is skipped, not re-recorded — driven through historyResolver, not a hand-built map', () => {
    const cacheNameIndex = buildNameIndex([{ id: 'mayrin', name: 'Мэйрин' }], lc);
    const historyResolver = { resolve: (id) => (id === 'mayrin' ? { character: { id: 'mairin' }, viaAlias: 'mayrin', via: 'history' } : undefined) };
    const plan = planBookRepairs(
      { liveCast, history: { supersededBy: { mayrin: 'mairin' } }, cacheNameIndex, bakNameIndex: new Map(), orphans: new Map(), historyResolver },
      deps,
    );
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.skipped.length, 1);
    assert.equal(plan.skipped[0].reason, 'already-recorded');
  });

  test('I-A (independent review, 2026-08-05): omitting historyResolver is fail-CLOSED — the default catches a Tier A / live-id-shape conflict, not "nothing resolves"', () => {
    // The exact regression probe from the finding: live `the_torment` +
    // `timkin`, orphan `the-torment` (67 real segments), cache names it
    // "Timkin". `historyResolver` is deliberately OMITTED from `input`.
    // Before I-A, the default was `{ resolve: () => undefined }` — this
    // would have silently auto-recorded a 67-segment durable repoint onto
    // "timkin". A fully history-aware `deps.buildCastResolver` is injected
    // for THIS test only (`makeHistoryAwareFakeResolver` — the shared
    // `makeFakeResolver`/`deps` ignore `history` entirely, so they can't
    // demonstrate this on their own).
    const localLiveCast = [...liveCast, { id: 'the_torment', name: 'The Torment' }];
    const localDeps = { ...deps, buildCastResolver: makeHistoryAwareFakeResolver(idKey) };
    const cacheNameIndex = buildNameIndex([{ id: 'the-torment', name: 'Timkin' }], lc);
    const orphans = new Map([['the-torment', renderedOrphan(67)]]);
    const plan = planBookRepairs(
      { liveCast: localLiveCast, history: {}, cacheNameIndex, bakNameIndex: new Map(), orphans, cacheAvailable: true },
      localDeps,
    );
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.skipped.length, 0);
    assert.equal(plan.reportOnly.length, 1);
    assert.equal(plan.reportOnly[0].id, 'the-torment');
  });

  test('I-A: omitting historyResolver with a POPULATED history still catches an already-recorded id — fail-closed, not "nothing resolves"', () => {
    // Second probe from the finding: omit the resolver, but populate
    // `history.supersededBy` — the already-recorded skip must not go
    // silently dead. Same history-aware `deps.buildCastResolver` injected
    // for the same reason as the test above.
    const localDeps = { ...deps, buildCastResolver: makeHistoryAwareFakeResolver(idKey) };
    const cacheNameIndex = buildNameIndex([{ id: 'mayrin', name: 'Мэйрин' }], lc);
    const plan = planBookRepairs(
      { liveCast, history: { supersededBy: { mayrin: 'mairin' } }, cacheNameIndex, bakNameIndex: new Map(), orphans: new Map() },
      localDeps,
    );
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.skipped.length, 1);
    assert.equal(plan.skipped[0].reason, 'already-recorded');
  });

  test('an id whose NORMALISED form matches a supersededBy key — not an exact key — is ALSO skipped as already-recorded, not auto-recorded', () => {
    // #2107's widened fix (only 'exact' skips the orphan bucket) means an id
    // resolving via the resolver's 'normalised-history' tier now reaches
    // this loop with real rendered segments, so the already-recorded guard
    // must recognise it. `historyResolver` here simulates exactly what
    // cast-resolve.ts's 'normalised-history' tier would return for
    // 'mayrin-old' against a recorded `Mayrin_Old` key.
    const orphans = new Map([['mayrin-old', renderedOrphan(3)]]);
    const historyResolver = {
      resolve: (id) => (id === 'mayrin-old' ? { character: { id: 'mairin' }, viaAlias: 'mayrin-old', via: 'normalised-history' } : undefined),
    };
    const plan = planBookRepairs(
      {
        liveCast,
        history: { supersededBy: { Mayrin_Old: 'mairin' } },
        cacheNameIndex: new Map(),
        bakNameIndex: new Map(),
        orphans,
        cacheAvailable: true,
        historyResolver,
      },
      deps,
    );
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.skipped.length, 1);
    assert.equal(plan.skipped[0].id, 'mayrin-old');
    assert.equal(plan.skipped[0].reason, 'already-recorded');
    assert.match(plan.skipped[0].detail, /normalised-spelling match/);
  });

  test("Important 1 probe (b), isolated: an id resolving via 'normalised-id' is NOT treated as already-recorded, even though its raw spelling also normalises the same as a supersededBy key", () => {
    // Precedence: cast-resolve.ts checks 'normalised-id' (tier 3, against
    // the LIVE cast) before 'normalised-history' (tier 4, against the alias
    // table) — a supersededBy entry that shares a normalised spelling with
    // a genuinely live id never gets consulted. A hand-built normalised map
    // over supersededBy alone has no such precedence and would wrongly
    // treat this as already-recorded. No name/id evidence is supplied here
    // on purpose, to isolate this guard from guard 5's conflict check
    // (pinned separately below) — it falls through to the generic
    // "no display name found" report instead of a skip.
    const orphans = new Map([['The_Torment', renderedOrphan(67)]]);
    const historyResolver = {
      resolve: (id) => (id === 'The_Torment' ? { character: { id: 'the_torment' }, viaAlias: 'The_Torment', via: 'normalised-id' } : undefined),
    };
    const plan = planBookRepairs(
      { liveCast, history: { supersededBy: { 'the-torment': 'timkin' } }, cacheNameIndex: new Map(), bakNameIndex: new Map(), orphans, historyResolver },
      deps,
    );
    assert.equal(plan.skipped.length, 0);
    assert.equal(plan.reportOnly.length, 1);
    assert.equal(plan.reportOnly[0].id, 'The_Torment');
  });

  test('Important 1 probe (a): a normalised COLLISION in supersededBy must not read as already-recorded — the real resolver refuses to guess, so the id is reported, not skipped', () => {
    // Real resolver shape: two different supersededBy `from` keys normalise
    // the same ('a-b' and 'a_b') but point at DIFFERENT targets —
    // cast-resolve.ts's `put()` nulls that normalised slot rather than
    // guessing, so `resolve()` returns undefined for a raw id that only
    // matches via the collision. A hand-built last-wins map would instead
    // guess one of the two targets and silently skip the id — the false
    // skip this guard exists to prevent.
    const orphans = new Map([['A_B', renderedOrphan(4)]]);
    const historyResolver = { resolve: () => undefined }; // the tie: the real resolver refuses to guess
    const plan = planBookRepairs(
      { liveCast, history: { supersededBy: { 'a-b': 'timkin', a_b: 'mairin' } }, cacheNameIndex: new Map(), bakNameIndex: new Map(), orphans, historyResolver },
      deps,
    );
    assert.equal(plan.skipped.length, 0);
    assert.equal(plan.reportOnly.length, 1);
    assert.equal(plan.reportOnly[0].id, 'A_B');
  });

  test('Important 1 probe (c): a supersededBy target that is no longer a live cast id must not read as already-recorded — the real resolver drops it at construction', () => {
    const orphans = new Map([['Old_X', renderedOrphan(12)]]);
    const historyResolver = { resolve: () => undefined }; // dead target: the real resolver never resolves through it
    const plan = planBookRepairs(
      { liveCast, history: { supersededBy: { 'old-x': 'deleted-char' } }, cacheNameIndex: new Map(), bakNameIndex: new Map(), orphans, historyResolver },
      deps,
    );
    assert.equal(plan.skipped.length, 0);
    assert.equal(plan.reportOnly.length, 1);
    assert.equal(plan.reportOnly[0].id, 'Old_X');
  });

  test('Important 2 (independent review, 2026-08-05): a Tier A name match that disagrees with what the id already resolves to live is a conflict, reported not auto-recorded', () => {
    // The exact probe from the finding: 'the-torment' is 67 real segments,
    // resolves live via 'normalised-id' to 'the_torment' today — but the
    // analysis cache names it "Timkin", an unambiguous Tier A match onto a
    // DIFFERENT live character. Before guard 5, Tier A ran unchecked and
    // this would auto-record 'the-torment' -> 'timkin', repointing 67
    // segments' attribution onto the wrong character at every join site.
    const cacheNameIndex = buildNameIndex([{ id: 'The_Torment', name: 'Timkin' }], lc);
    const orphans = new Map([['The_Torment', renderedOrphan(67)]]);
    const historyResolver = {
      resolve: (id) => (id === 'The_Torment' ? { character: { id: 'the_torment' }, viaAlias: 'The_Torment', via: 'normalised-id' } : undefined),
    };
    const plan = planBookRepairs(
      { liveCast, history: {}, cacheNameIndex, bakNameIndex: new Map(), orphans, cacheAvailable: true, historyResolver },
      deps,
    );
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.skipped.length, 0);
    assert.equal(plan.reportOnly.length, 1);
    assert.equal(plan.reportOnly[0].id, 'The_Torment');
    assert.match(plan.reportOnly[0].reason, /already resolves via id-shape to a DIFFERENT live character, "the_torment"/);
  });

  test('Important 2: a Tier B match can never trip the conflict guard — it is the identical id-shape computation historyResolver also makes', () => {
    // Sanity/negative control: 'lightning-dave' has no name evidence, so it
    // reaches Tier B, which finds 'lightning_dave' via the SAME id-shape
    // computation `historyResolver` would report — they can never disagree
    // by construction. This is what the real workspace's two actual
    // auto-records look like today (neither trips guard 5).
    const orphans = new Map([['lightning-dave', renderedOrphan(1)]]);
    const historyResolver = {
      resolve: (id) => (id === 'lightning-dave' ? { character: { id: 'lightning_dave' }, viaAlias: 'lightning-dave', via: 'normalised-id' } : undefined),
    };
    const localLiveCast = [...liveCast, { id: 'lightning_dave', name: 'Lightning Dave' }];
    const plan = planBookRepairs(
      { liveCast: localLiveCast, history: {}, cacheNameIndex: new Map(), bakNameIndex: new Map(), orphans, cacheAvailable: true, historyResolver },
      deps,
    );
    assert.equal(plan.autoRecord.length, 1);
    assert.equal(plan.autoRecord[0].id, 'lightning-dave');
    assert.equal(plan.autoRecord[0].to, 'lightning_dave');
    assert.equal(plan.autoRecord[0].tier, 'B');
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
    const plan = planBookRepairs({ liveCast, history: {}, cacheNameIndex: new Map(), bakNameIndex, orphans, cacheAvailable: true }, deps);
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
    // I2 (independent review): this test omitted `cacheAvailable` before the
    // #2093 residual 3 default flip (true -> false) and stayed green
    // vacuously — with the new `false` default, `autoRecord` is empty for
    // ANY input, so this assertion no longer discriminates the guard it's
    // named for (proven by mutation: deleting the Tier A target-side
    // reserved-id check entirely left this test green). `cacheAvailable:
    // true` restores the guard this test actually exercises.
    const cacheNameIndex = buildNameIndex([{ id: 'weird-alias', name: 'Narrator' }], lc);
    const orphans = new Map([['weird-alias', renderedOrphan(2)]]);
    const plan = planBookRepairs({ liveCast, history: {}, cacheNameIndex, bakNameIndex: new Map(), orphans, cacheAvailable: true }, deps);
    assert.equal(plan.autoRecord.length, 0);
    assert.ok(!plan.autoRecord.some((a) => a.to === 'narrator'));
  });

  test('RESIDUAL 4 (#2093): a Tier A match onto a case/separator-drifted reserved TARGET id is refused (target-side check normalises too)', () => {
    // A live cast row whose id drifted to a case/separator variant of the
    // reserved male fold-bucket id ('Unknown_Male' vs canonical
    // 'unknown-male') — the mirror-side drift class of the MINOR (round 2)
    // test above, which only covered the SOURCE-side check. Before this
    // fix, the target-side guard was a raw `reservedIds.has(tierAMatch)`,
    // which would MISS this spelling and wrongly auto-record onto it.
    const driftedLiveCast = [...liveCast, { id: 'Unknown_Male', name: 'Bucket' }];
    const cacheNameIndex = buildNameIndex([{ id: 'weird-alias-2', name: 'Bucket' }], lc);
    const orphans = new Map([['weird-alias-2', renderedOrphan(3)]]);
    const plan = planBookRepairs(
      { liveCast: driftedLiveCast, history: {}, cacheNameIndex, bakNameIndex: new Map(), orphans, cacheAvailable: true },
      deps,
    );
    assert.equal(plan.autoRecord.length, 0);
    assert.ok(!plan.autoRecord.some((a) => a.to === 'Unknown_Male'));
  });

  test('IMPORTANT 2 (inverted): a Tier B id-shape match on a cache-only orphan (zero rendered segments) is report-only, never auto-recorded', () => {
    // 'TIMKIN' normalises (case-fold) to the same key as live 'timkin' —
    // purely an id-shape match, no name signal anywhere. Used to
    // auto-record; round 1 scoped auto-record to actual on-disk damage.
    const plan = planBookRepairs(
      { liveCast, history: {}, cacheNameIndex: new Map(), bakNameIndex: new Map(), orphans: new Map([['TIMKIN', { segments: 0, chapters: [], snapshots: [] }]]), cacheAvailable: true },
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
    const plan = planBookRepairs({ liveCast, history: {}, cacheNameIndex, bakNameIndex: new Map(), orphans: new Map(), cacheAvailable: true }, deps);
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.reportOnly.length, 1);
    assert.equal(plan.reportOnly[0].id, 'never-rendered-guy');
    assert.match(plan.reportOnly[0].reason, /zero rendered segments/);
  });

  test('a name match on a genuine-miss id carrying real orphaned segments reaches autoRecord — the #2107-widened write-set path', () => {
    // CORRECTED (M-1, independent review, 2026-08-05): this test's title
    // and comment used to claim "'The_Torment' resolves live through the
    // resolver's 'normalised-id' tier" and "guard 5 passes — the id has no
    // pre-existing supersededBy entry". Both were false for this fixture:
    // `liveCast` (shared across this describe block) is
    // `[narrator, mairin, timkin]` — there is no `the_torment` in it, so
    // `The_Torment` is a GENUINE MISS (no id-shape match at all), not a
    // normalised-id match, and guard 5 never even considers it (it only
    // acts on a LIVE `'normalised-id'` resolution, which doesn't exist
    // here). What this test actually pins: even a plain genuine-miss id now
    // carries its real rendered segment count in `orphans` (#2107's
    // widening — before it, `collectSegmentOrphans` only ever added an id
    // to `orphans` on a genuine miss anyway, so this specific case was
    // already correct pre-widening too) and a Tier A name match against it
    // reaches `autoRecord` normally. The genuinely NEW write-set case this
    // wave's `'normalised-id'` widening opens — an id that resolves LIVE
    // and still reaches Tier A/B matching — is pinned by the Tier B control
    // below ("Important 2: a Tier B match can never trip the conflict
    // guard"), whose `localLiveCast` actually includes the matching live
    // id.
    //
    // CORRECTED (Minor 5, independent review, 2026-08-05): this test hand-
    // injects `orphans` directly — it does NOT call
    // `buildOrphansFromSegments`, so it does not, on its own, prove the
    // `autoReconciled` consumer branch this replaced is actually GONE from
    // `planBookRepairs` (that branch only ever fired when `orphan.segments
    // === 0`, which never happens here). See the dedicated structural-
    // removal test immediately below for that.
    const cacheNameIndex = buildNameIndex([{ id: 'The_Torment', name: 'Timkin' }], lc);
    const orphans = new Map([['The_Torment', renderedOrphan(9)]]);
    const plan = planBookRepairs({ liveCast, history: {}, cacheNameIndex, bakNameIndex: new Map(), orphans, cacheAvailable: true }, deps);
    assert.equal(plan.reportOnly.length, 0);
    assert.equal(plan.autoRecord.length, 1);
    assert.equal(plan.autoRecord[0].id, 'The_Torment');
    assert.equal(plan.autoRecord[0].to, 'timkin');
    assert.equal(plan.autoRecord[0].segments, 9);
  });

  test("Minor 5 (independent review, 2026-08-05): planBookRepairs does not consume an 'autoReconciled'-shaped input at all — C1's removal is structural, not merely unreached today", () => {
    // The prior test above can't prove the removed autoReconciled consumer
    // branch is actually gone (it never lands an orphan with segments===0).
    // This test does: it hands planBookRepairs something shaped exactly
    // like the OLD autoReconciled map on a matched, zero-segment id — the
    // one input shape the old branch specifically special-cased — and
    // asserts the PLAIN "zero rendered segments" reason, never the removed
    // "already auto-reconciles" one. Nothing in this file's real contract
    // produces an `autoReconciled` value any more (collectSegmentOrphans/
    // buildOrphansFromSegments/main() don't build one), so this also proves
    // planBookRepairs ignores it even if a caller still passed one.
    const cacheNameIndex = buildNameIndex([{ id: 'never-rendered-guy', name: 'Timkin' }], lc);
    const legacyAutoReconciled = new Map([['never-rendered-guy', { segments: 9, resolvedTo: 'timkin' }]]);
    const plan = planBookRepairs(
      {
        liveCast,
        history: {},
        cacheNameIndex,
        bakNameIndex: new Map(),
        orphans: new Map(),
        cacheAvailable: true,
        autoReconciled: legacyAutoReconciled,
      },
      deps,
    );
    assert.equal(plan.reportOnly.length, 1);
    assert.equal(plan.reportOnly[0].segments, 0);
    assert.match(plan.reportOnly[0].reason, /zero rendered segments/);
    assert.doesNotMatch(plan.reportOnly[0].reason, /already auto-reconciles/);
  });

  test('MINOR (round 2, finding 4): a genuinely never-rendered id (absent from orphans) still gets the "zero rendered segments" reason', () => {
    const cacheNameIndex = buildNameIndex([{ id: 'never-rendered-guy', name: 'Timkin' }], lc);
    const plan = planBookRepairs({ liveCast, history: {}, cacheNameIndex, bakNameIndex: new Map(), orphans: new Map(), cacheAvailable: true }, deps);
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
    // Owner-decided policy, review round 2: this is the "≥1 withheld
    // candidate" shape shouldRefuseApplyForWithheldAutoRecord gates on.
    assert.equal(plan.withheldForMissingCache, 1);
  });

  test('OWNER-DECIDED POLICY (review round 2, 2026-08-05): a book with cacheAvailable=false but NO Tier A/B candidate withholds NOTHING — withheldForMissingCache stays 0', () => {
    // A book whose cache is unusable (cacheAvailable: false) but which has
    // an orphaned id with no name/id signal at all — 'silveny' matches
    // neither Tier A name nor Tier B id-shape against any live cast row
    // here — never even reaches the cacheAvailable gate, so it has NOTHING
    // at stake and must not count toward the signal that blocks --apply for
    // the WHOLE workspace. (NOTE: this is NOT *Unlocked*'s real shape — a
    // live scan found *Unlocked* actually has one orphaned id,
    // `unknown-male`/34 segments, refused by guard 1 as a reserved
    // fold-bucket SOURCE — see the dedicated guard-1 test below, which
    // mirrors the real book. This test pins the OTHER way
    // withheldForMissingCache can legitimately stay 0: no match at all,
    // not guard 1 refusing a match.)
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
    const plan = planBookRepairs(
      { liveCast, history: {}, cacheNameIndex: new Map(), bakNameIndex: new Map(), orphans, cacheAvailable: false },
      deps,
    );
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.reportOnly.length, 1);
    assert.equal(plan.reportOnly[0].id, 'silveny');
    assert.match(plan.reportOnly[0].reason, /no display name found/); // NOT the cacheAvailable reason — never reached it
    assert.equal(plan.withheldForMissingCache, 0);
  });

  test('I5 correction (pre-merge review, 2026-08-05): the REAL *Unlocked* shape — a reserved SOURCE id refused by guard 1 withholds NOTHING, even with cacheAvailable=false and real bak evidence', () => {
    // A live re-scan (pre-merge review) found *Unlocked* is NOT a
    // no-orphaned-ids book — it has one, `unknown-male` (34 segments across
    // 2 chapters), and it's guard 1 (reserved fold-bucket source refusal),
    // firing BEFORE the cacheAvailable gate is ever reached, that keeps its
    // blind ambiguity veto from ever standing between the pass and a real
    // candidate — not an absence of orphans. This test pins that mechanism
    // directly: unambiguous bak evidence naming one occurrence, cache
    // unavailable, and STILL withheldForMissingCache stays 0 because guard
    // 1 refuses first.
    const bakNameIndex = buildNameIndex([{ id: 'unknown-male', name: 'Lord Cassius' }], lc);
    const orphans = new Map([['unknown-male', renderedOrphan(34, [{ chapterId: 63, chapterTitle: 'Sophie', segments: 34, durationSec: 90 }])]]);
    const plan = planBookRepairs(
      { liveCast, history: {}, cacheNameIndex: new Map(), bakNameIndex, orphans, cacheAvailable: false },
      deps,
    );
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.reportOnly.length, 1);
    assert.equal(plan.reportOnly[0].id, 'unknown-male');
    assert.match(plan.reportOnly[0].reason, /reserved fold-bucket\/narrator id/); // guard 1's reason, NOT the cacheAvailable one
    assert.equal(plan.withheldForMissingCache, 0);
  });

  test('I2 (pre-merge review, 2026-08-05): a Tier A match with ZERO rendered segments and cacheAvailable=false withholds NOTHING — guard 3 refuses first', () => {
    // Before I2, the cacheAvailable gate sat AHEAD of guard 3 (the
    // zero-segment scope guard), so an id like this one — matched, but with
    // nothing rendered — would have incremented withheldForMissingCache
    // even though guard 3 was always going to refuse it regardless of cache
    // evidence. A single such id in an otherwise-fine book could have
    // falsely blocked --apply for the WHOLE workspace. The cacheAvailable
    // gate now sits AFTER guard 3, so this case reaches guard 3's own
    // "zero rendered segments" reason and withholds nothing.
    const cacheNameIndex = buildNameIndex([{ id: 'never-rendered-guy', name: 'Timkin' }], lc);
    const plan = planBookRepairs(
      { liveCast, history: {}, cacheNameIndex, bakNameIndex: new Map(), orphans: new Map(), cacheAvailable: false },
      deps,
    );
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.reportOnly.length, 1);
    assert.equal(plan.reportOnly[0].id, 'never-rendered-guy');
    assert.match(plan.reportOnly[0].reason, /zero rendered segments/); // guard 3's reason, NOT the cacheAvailable one
    assert.equal(plan.withheldForMissingCache, 0);
  });

  test('I2 (missing case, pre-merge review, 2026-08-05): a Tier A match with INCONSISTENT characterSnapshots and cacheAvailable=false withholds NOTHING — guard 4 refuses first', () => {
    // The sibling case to the guard-3 test above, for guard 4
    // (snapshotsConsistent) — the planBookRepairs doc comment claims BOTH
    // guard 3 and guard 4 sit ahead of the cacheAvailable gate ("was
    // refused SOLELY because cacheAvailable was false... AND guard 3...
    // AND guard 4"), but until now only guard 3 had a test pinning it in
    // combination with cacheAvailable=false. A book whose cache is entirely
    // unavailable but whose orphan's own rendered snapshots already
    // disagree across chapters has nothing at stake for the cache gate
    // either — guard 4 was always going to refuse it, cache evidence or
    // not — so withheldForMissingCache must stay 0 here too.
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
    const plan = planBookRepairs(
      { liveCast, history: {}, cacheNameIndex: new Map(), bakNameIndex, orphans, cacheAvailable: false },
      deps,
    );
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.reportOnly.length, 1);
    assert.match(plan.reportOnly[0].reason, /disagree across chapters/); // guard 4's reason, NOT the cacheAvailable one
    assert.equal(plan.withheldForMissingCache, 0);
  });

  test('RESIDUAL 3 (#2093, inverted): cacheAvailable now defaults to FALSE when omitted — the safe default for an otherwise fail-closed guard', () => {
    // This test used to assert the OPPOSITE — that an omitted `cacheAvailable`
    // defaults to `true` and lets an otherwise-clean auto-record through.
    // #2093 residual 3 flipped the default: an omitted flag now reads as
    // "unknown, refuse" (matching guard 1/2's own posture), not "confirmed
    // available". The one production caller (main()) always passes it
    // explicitly, so this default is a safety net for any future caller
    // that forgets to — inverted per the review's explicit instruction, not
    // deleted.
    const cacheNameIndex = buildNameIndex([{ id: 'mayrin', name: 'Мэйрин' }], lc);
    const orphans = new Map([['mayrin', renderedOrphan(8)]]);
    // `input` deliberately omits `cacheAvailable` entirely.
    const plan = planBookRepairs({ liveCast, history: {}, cacheNameIndex, bakNameIndex: new Map(), orphans }, deps);
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.reportOnly.length, 1);
    assert.equal(plan.reportOnly[0].id, 'mayrin');
    assert.match(plan.reportOnly[0].reason, /analysis-cache file was not found/);
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

describe('shouldRefuseApplyForWithheldAutoRecord (#2093 residual 2, re-scoped by owner-decided policy, review round 2)', () => {
  // Renamed from shouldRefuseApplyForMissingCache: the predicate now reads
  // booksWithheldForMissingCache (a book with a REAL auto-record candidate
  // actually withheld), not booksMissingCache (any book with unusable cache
  // evidence, whether or not it had anything to repair) — a book with no
  // cache evidence and nothing that would have auto-recorded anyway must
  // not veto every other book's --apply run.
  test('dry run never refuses, whatever booksWithheldForMissingCache is', () => {
    assert.equal(shouldRefuseApplyForWithheldAutoRecord(false, 0), false);
    assert.equal(shouldRefuseApplyForWithheldAutoRecord(false, 5), false);
  });

  test('--apply with 0 books withheld does not refuse', () => {
    assert.equal(shouldRefuseApplyForWithheldAutoRecord(true, 0), false);
  });

  test('--apply with >=1 book withheld refuses', () => {
    assert.equal(shouldRefuseApplyForWithheldAutoRecord(true, 1), true);
    assert.equal(shouldRefuseApplyForWithheldAutoRecord(true, 20), true);
  });
});

describe("planApplyRefusal (#2111 — main()'s per-workspace --apply refusal, driven through the seam main() itself calls)", () => {
  // This covers the ACCUMULATION main()'s loop-tail used to hand-roll
  // inline (only a book with withheldForMissingCache > 0 counts; the label
  // text; the threshold crossing) — driven through the exact function
  // main() calls, not a second computation of the same fact hand-rolled in
  // the test. What it does NOT cover is named in planApplyRefusal's own doc
  // comment: that main()'s loop actually pushes the real per-book value in,
  // and that main() actually acts on `.refuse` by setting process.exitCode
  // and returning — both need apply === true, which routes through a live
  // port probe and a server/dist import this harness doesn't have.
  test('apply=false never refuses, regardless of withheld books', () => {
    const result = planApplyRefusal(false, [{ label: 'Book A', withheldForMissingCache: 3 }]);
    assert.equal(result.refuse, false);
    assert.equal(result.booksWithheldForMissingCache, 1);
  });

  test('apply=true with no withheld books does not refuse', () => {
    const result = planApplyRefusal(true, [
      { label: 'Book A', withheldForMissingCache: 0 },
      { label: 'Book B', withheldForMissingCache: 0 },
    ]);
    assert.equal(result.refuse, false);
    assert.equal(result.booksWithheldForMissingCache, 0);
    assert.deepEqual(result.withheldBookLabels, []);
  });

  test('CRITICAL (#2111): apply=true with one withheld book refuses and names it — the last workspace-level rail', () => {
    const result = planApplyRefusal(true, [
      { label: 'Book A', withheldForMissingCache: 0 },
      { label: 'Book B', withheldForMissingCache: 2 },
    ]);
    assert.equal(result.refuse, true);
    assert.equal(result.booksWithheldForMissingCache, 1);
    assert.deepEqual(result.withheldBookLabels, ['Book B (2 id(s))']);
  });

  test('accumulates across multiple withheld books, not just the first', () => {
    const result = planApplyRefusal(true, [
      { label: 'Book A', withheldForMissingCache: 1 },
      { label: 'Book B', withheldForMissingCache: 0 },
      { label: 'Book C', withheldForMissingCache: 5 },
    ]);
    assert.equal(result.booksWithheldForMissingCache, 2);
    assert.deepEqual(result.withheldBookLabels, ['Book A (1 id(s))', 'Book C (5 id(s))']);
    assert.equal(result.refuse, true);
  });

  test('an empty bookWithholds list refuses nothing (matches an empty workspace scan, not "unknown")', () => {
    const result = planApplyRefusal(true, []);
    assert.equal(result.refuse, false);
    assert.equal(result.booksWithheldForMissingCache, 0);
    assert.deepEqual(result.withheldBookLabels, []);
  });
});

describe('formatReportRowSummary (#2093 residual 5, cosmetic)', () => {
  test('normal report row includes the chapter count', () => {
    assert.equal(
      formatReportRowSummary({ id: 'silveny', segments: 17, chapters: [{ chapterId: 50 }] }),
      'silveny (17 segment(s) across 1 chapter(s))',
    );
  });

  test('NO LIVE PRODUCER TODAY (Minor 6, independent review, 2026-08-05) — pure-function-only pin: {segments > 0, chapters: []} still omits the "0 chapter(s)" clause', () => {
    // *** This input shape ({segments > 0, chapters: []}) has NO real
    // *** producer any more. It used to come from planBookRepairs's
    // *** autoReconciled-report branch, deleted by #2107's C1 fix — see
    // *** that fix's own doc comments. This test exercises
    // *** formatReportRowSummary directly, as a pure function, NOT through
    // *** planBookRepairs or any pipeline that could hit this shape today.
    // *** Do not read this as live coverage of a real code path.
    //
    // Kept anyway because formatReportRowSummary is a small, generic,
    // exported pure formatter with no other reason to assume this input
    // shape can never recur (a future producer could reintroduce it) — the
    // OLD unconditional suffix would have printed the self-contradicting
    // "silveny (17 segment(s) across 0 chapter(s))" for it; a real segment
    // count can never span zero chapters.
    assert.equal(formatReportRowSummary({ id: 'silveny', segments: 17, chapters: [] }), 'silveny (17 segment(s))');
  });

  test('zero segments and zero chapters (a genuinely never-rendered id) also omits the chapter clause', () => {
    assert.equal(formatReportRowSummary({ id: 'never-rendered-guy', segments: 0, chapters: [] }), 'never-rendered-guy (0 segment(s))');
  });
});

describe('readAnalysisCache / isCacheAvailable (#2093 residual 1)', () => {
  function withTempCacheDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-cache-'));
    try {
      return fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test('missing manuscriptId -> null / unavailable', () => {
    withTempCacheDir((dir) => {
      assert.equal(readAnalysisCache(dir, undefined), null);
      assert.equal(isCacheAvailable(dir, undefined, lc), false);
    });
  });

  test('no file at that path -> null / unavailable', () => {
    withTempCacheDir((dir) => {
      assert.equal(readAnalysisCache(dir, 'nonexistent-book'), null);
      assert.equal(isCacheAvailable(dir, 'nonexistent-book', lc), false);
    });
  });

  test('a valid cache file naming at least one character -> parses / available', () => {
    withTempCacheDir((dir) => {
      const contents = { stage1: { characters: [{ id: 'mairin', name: 'Мэйрин' }] } };
      fs.writeFileSync(path.join(dir, 'good-book.json'), JSON.stringify(contents));
      assert.deepEqual(readAnalysisCache(dir, 'good-book'), contents);
      assert.equal(isCacheAvailable(dir, 'good-book', lc), true);
    });
  });

  test('CRITICAL (#2093 residual 1): a present-but-corrupt (truncated/invalid-JSON) cache file reads as unavailable, NOT as available', () => {
    // This is the exact regression the fix closes: the OLD gate
    // (`analysisCacheFileExists`) checked path existence only, so a
    // present-but-corrupt file would have read `cacheAvailable === true`
    // even though `readAnalysisCache` already swallowed the parse failure
    // to `null` — an empty `cacheNameIndex` built from that `null` then
    // looked "confirmed unambiguous" to the cross-source ambiguity veto
    // instead of "unknown". Deliberately writes genuinely truncated JSON
    // (an unterminated object), not merely empty content, to prove this is
    // a real parse-failure path, not a vacuous check.
    withTempCacheDir((dir) => {
      const p = path.join(dir, 'corrupt-book.json');
      fs.writeFileSync(p, '{ "stage1": { "characters": [ { "id": "mayrin", "name": "Мэйрин"');
      // The file DOES exist on disk...
      assert.equal(fs.existsSync(p), true);
      // ...but the pass must refuse to trust it.
      assert.equal(readAnalysisCache(dir, 'corrupt-book'), null);
      assert.equal(isCacheAvailable(dir, 'corrupt-book', lc), false);
    });
  });

  test('CRITICAL C1 (independent review, 2026-08-05): a validly-parsing cache file that names ZERO characters reads as unavailable, not merely "it parsed"', () => {
    // This is the residual 1 fix's own blind spot, found by independent
    // review: guard 2 (the cross-source ambiguity veto) doesn't consume
    // "did the file parse" — it consumes `cacheEntriesOf(cache)`, and BOTH
    // `stage1.characters` and `chapterCast` are OPTIONAL per the schema
    // (server/src/store/analysis-cache.ts:69-77). A bare `{}` parses fine —
    // `readAnalysisCache` returns a real object, not `null` — but supplies
    // zero name/id entries, which is exactly as blind to guard 2 as a
    // missing file, yet the narrower "exists and parses" gate would have
    // read it as available. Measured for real: 10 of the real workspace's
    // 80 cache files parse but name zero characters (one of them a real
    // book, *Unlocked*, with bak-only evidence this gate must withhold from
    // guard 2's view too).
    withTempCacheDir((dir) => {
      const p = path.join(dir, 'empty-book.json');
      fs.writeFileSync(p, '{}');
      const parsed = readAnalysisCache(dir, 'empty-book');
      assert.notEqual(parsed, null); // it DID parse...
      assert.deepEqual(parsed, {});
      assert.equal(isCacheAvailable(dir, 'empty-book', lc), false); // ...but is not usable evidence
    });
  });

  test('CRITICAL C1 (independent review): a cache file with a present but entirely-empty chapterCast also reads as unavailable', () => {
    // A second real shape of "parses but names nobody" — chapterCast keyed
    // by chapter, present, but every chapter's array is empty (no
    // stage1.characters at all). Distinct fixture from the bare `{}` case
    // above so both of C1's named shapes are directly covered.
    withTempCacheDir((dir) => {
      const p = path.join(dir, 'empty-chapters-book.json');
      fs.writeFileSync(p, JSON.stringify({ chapterCast: { 1: [] } }));
      const parsed = readAnalysisCache(dir, 'empty-chapters-book');
      assert.notEqual(parsed, null);
      assert.equal(isCacheAvailable(dir, 'empty-chapters-book', lc), false);
    });
  });

  test('I1 (pre-merge review, 2026-08-05): a cache whose only character has an EMPTY-STRING name reads as unavailable — cacheEntriesOf alone would have said "available"', () => {
    // This is the gap I1 found one field deeper than C1: `cacheEntriesOf`
    // only checks `typeof === 'string'`, so `{id:"sandor", name:""}` — a
    // shape a truncated analyzer write could plausibly produce — passes it
    // and used to make `isCacheAvailable` return `true`. But guard 2 (the
    // cross-source ambiguity veto) doesn't consume `cacheEntriesOf`'s raw
    // output — it consumes `cacheNameIndex`, built by `buildNameIndex`,
    // which drops this SAME entry (falsy name). So the gate and the guard
    // it protects were measuring two different quantities: `cacheAvailable
    // === true` while `cacheNameIndex` is empty — guard 2 exactly as blind
    // as with a missing file. `isCacheAvailable` now builds the real
    // `cacheNameIndex` (via the same `buildNameIndex`) and checks THAT.
    withTempCacheDir((dir) => {
      const contents = { stage1: { characters: [{ id: 'sandor', name: '' }] } };
      fs.writeFileSync(path.join(dir, 'empty-name-book.json'), JSON.stringify(contents));
      const parsed = readAnalysisCache(dir, 'empty-name-book');
      assert.notEqual(parsed, null); // it DID parse, and cacheEntriesOf sees a "string" name...
      assert.equal(isCacheAvailable(dir, 'empty-name-book', lc), false); // ...but it is not usable evidence
    });
  });

  test('I1: a cache whose only character has an EMPTY-STRING id also reads as unavailable', () => {
    withTempCacheDir((dir) => {
      const contents = { stage1: { characters: [{ id: '', name: 'Timkin' }] } };
      fs.writeFileSync(path.join(dir, 'empty-id-book.json'), JSON.stringify(contents));
      assert.equal(isCacheAvailable(dir, 'empty-id-book', lc), false);
    });
  });
});

describe('cacheAvailableFromParsed (minor, pre-merge review, 2026-08-05 — the pure core main() now calls to avoid reading the cache file twice per book)', () => {
  test('null (missing/unparseable cache) is unavailable, same as isCacheAvailable', () => {
    assert.equal(cacheAvailableFromParsed(null, lc), false);
  });

  test('a parsed object naming at least one usable character is available', () => {
    const parsed = { stage1: { characters: [{ id: 'mairin', name: 'Мэйрин' }] } };
    assert.equal(cacheAvailableFromParsed(parsed, lc), true);
  });

  test('a parsed object naming zero characters is unavailable', () => {
    assert.equal(cacheAvailableFromParsed({}, lc), false);
  });

  test('isCacheAvailable(dir, id, fn) and cacheAvailableFromParsed(readAnalysisCache(dir, id), fn) agree — the split is a pure refactor, not a behaviour change', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-cache-split-'));
    try {
      const contents = { stage1: { characters: [{ id: 'mairin', name: 'Мэйрин' }] } };
      fs.writeFileSync(path.join(dir, 'good-book.json'), JSON.stringify(contents));
      assert.equal(
        isCacheAvailable(dir, 'good-book', lc),
        cacheAvailableFromParsed(readAnalysisCache(dir, 'good-book'), lc),
      );
      assert.equal(
        isCacheAvailable(dir, 'nonexistent-book', lc),
        cacheAvailableFromParsed(readAnalysisCache(dir, 'nonexistent-book'), lc),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** M5 (independent review, 2026-08-05): a hardcoded "high, unusual" base
 *  port is a guess, not a guarantee — some other process on a CI/dev box
 *  could genuinely be listening anywhere in that window, which would fail
 *  this test for a reason that has nothing to do with the code under
 *  test. This instead PROVES a `rangeSize`-port CONSECUTIVE window is free
 *  by actually binding a real listener on every port in it (an OS refuses
 *  a bind on an occupied port, so a successful bind is real evidence, not
 *  an assumption), then releases them immediately before the probe under
 *  test runs. Retries with a fresh random base on a bind collision rather
 *  than asserting anything about the failed candidate. There remains a
 *  short residual race between releasing the verified-free ports and the
 *  probe connecting to them — inherent to testing a TCP liveness probe at
 *  all — but it is now bounded to that narrow window instead of "was this
 *  static number ever free on this box in the first place".
 *
 *  Module-scope (Ie, pre-merge review, 2026-08-05) — was local to the
 *  `probePortRangeRefused` describe block, relocated so the `main() wiring`
 *  describe block below can reuse it for the same collision-avoidance
 *  purpose against PORT/LAN_HTTPS_PORT, rather than a second, duplicated
 *  copy. */
async function findVerifiedFreeRange(rangeSize, host = '127.0.0.1') {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const base = 40000 + Math.floor(Math.random() * 20000);
    const servers = [];
    try {
      for (let i = 0; i < rangeSize; i += 1) {
        const s = net.createServer();
        // Sequential (not Promise.all) deliberately — binding must prove
        // each port individually so a collision on port N doesn't leave
        // ports > N bound-but-unrecorded.
        await new Promise((resolve, reject) => {
          s.once('error', reject);
          s.listen(base + i, host, resolve);
        });
        servers.push(s);
      }
      await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
      return base;
    } catch {
      await Promise.all(servers.map((s) => new Promise((resolve) => s.close(() => resolve()))));
      // retry with a fresh random base
    }
  }
  throw new Error(`could not find ${rangeSize} consecutive free ports after 25 attempts`);
}

describe('probePortRangeRefused (#2090)', () => {
  function listenOnEphemeralPort() {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  test('I3 (pre-merge review, 2026-08-05): AUTO_REBIND_RANGE is exactly 20 — matches listenWithAutoRebind\'s own maxAttempts default (server/src/crash-logging.ts)', () => {
    // Deliberately a hardcoded literal, not derived from anything else: this
    // is the one place the constant's actual VALUE gets pinned. The two
    // boundary tests below import AUTO_REBIND_RANGE (correctly, to avoid a
    // driftable copy of their OWN fixture sizing — see M5's rationale) —
    // but that means a change to the constant's value moves both the
    // production code AND those tests' expectations in lockstep, so they
    // can only catch a LOOP bug (e.g. an off-by-one in how the constant is
    // used), never a change to the constant itself. Confirmed by mutation:
    // AUTO_REBIND_RANGE 20 -> 19 left both boundary tests green. This test
    // is what actually catches that mutation.
    assert.equal(AUTO_REBIND_RANGE, 20);
  });

  test('every port in the range gives a clean ECONNREFUSED when nothing is listening', async () => {
    const base = await findVerifiedFreeRange(AUTO_REBIND_RANGE, '127.0.0.1');
    const notRefused = await probePortRangeRefused(base, '127.0.0.1');
    assert.deepEqual(notRefused, []);
  });

  test('I3 (pre-merge review, 2026-08-05): a listener at the EXACT configured port is caught — pins that the range starts at i=0, not i=1', async () => {
    // Mutation-tested by pre-merge review: changing `startPort + i` to
    // `startPort + i + 1` inside probePortRangeRefused — which stops
    // probing the configured port ITSELF, reopening the pre-#2090 bug in a
    // worse form — passed all 79 existing tests, because none of them put
    // a listener on the exact configured port; the CRITICAL (#2090) test
    // above only covers configuredPort+5. This test closes that hole
    // directly: a listener on the configured port itself must be caught.
    const configuredPort = await findVerifiedFreeRange(1, '127.0.0.1');
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(configuredPort, '127.0.0.1', resolve);
    });
    try {
      const notRefused = await probePortRangeRefused(configuredPort, '127.0.0.1');
      assert.ok(notRefused.includes(configuredPort), `expected ${configuredPort} to be in ${JSON.stringify(notRefused)}`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('I3 (pre-merge review, 2026-08-05): the LAST port in the range is caught, but the port just past it is NOT — pins both AUTO_REBIND_RANGE and the loop bound together', async () => {
    // Mutation-tested by pre-merge review: shrinking AUTO_REBIND_RANGE from
    // 20 to 19 also passed all 79 existing tests, because none of them
    // pinned the range's own size. This test binds a listener at exactly
    // `configuredPort + AUTO_REBIND_RANGE - 1` (the last port the range
    // SHOULD cover) and another at `configuredPort + AUTO_REBIND_RANGE`
    // (the first port it should NOT) — a range-size mutation in either
    // direction moves which one the probe actually reaches, so either
    // assertion below catches it.
    const configuredPort = await findVerifiedFreeRange(AUTO_REBIND_RANGE + 1, '127.0.0.1');
    const lastInRangePort = configuredPort + AUTO_REBIND_RANGE - 1;
    const justPastRangePort = configuredPort + AUTO_REBIND_RANGE;
    const lastServer = net.createServer();
    const pastServer = net.createServer();
    await new Promise((resolve, reject) => {
      lastServer.once('error', reject);
      lastServer.listen(lastInRangePort, '127.0.0.1', resolve);
    });
    await new Promise((resolve, reject) => {
      pastServer.once('error', reject);
      pastServer.listen(justPastRangePort, '127.0.0.1', resolve);
    });
    try {
      const notRefused = await probePortRangeRefused(configuredPort, '127.0.0.1');
      assert.ok(
        notRefused.includes(lastInRangePort),
        `expected the last in-range port ${lastInRangePort} to be in ${JSON.stringify(notRefused)}`,
      );
      assert.ok(
        !notRefused.includes(justPastRangePort),
        `expected the just-past-range port ${justPastRangePort} to NOT be in ${JSON.stringify(notRefused)}`,
      );
    } finally {
      await new Promise((resolve) => lastServer.close(resolve));
      await new Promise((resolve) => pastServer.close(resolve));
    }
  });

  test('CRITICAL (#2090): refuses when a server occupies a port INSIDE the auto-rebind range but NOT the exact configured port', async () => {
    // Simulates the exact #2090 scenario: a listenWithAutoRebind server
    // rebound off the configured port onto configuredPort+N after an
    // EADDRINUSE. A probe that only checked the exact configured port would
    // see ECONNREFUSED there and wrongly conclude "safe" — the widened
    // range probe must still catch the live server sitting inside the
    // rebind window.
    const server = await listenOnEphemeralPort();
    try {
      const boundPort = server.address().port;
      const configuredPort = boundPort - 5; // pretend this was the configured port
      const notRefused = await probePortRangeRefused(configuredPort, '127.0.0.1');
      assert.ok(notRefused.includes(boundPort), `expected ${boundPort} to be in ${JSON.stringify(notRefused)}`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('M6 (independent review, 2026-08-05): the DEFAULT host reaches an IPv4-loopback-only listener, not only when 127.0.0.1 is passed explicitly', async () => {
    // Every other test in this describe block passes '127.0.0.1' explicitly
    // and so never exercises probePortRangeRefused's own default host
    // value — this one omits it entirely, pinning the default itself. The
    // bug this closes (`net.connect({ host: 'localhost' })` can resolve
    // `::1` before `127.0.0.1` on Windows, missing an IPv4-only server) is
    // resolver-order-dependent and not guaranteed to reproduce identically
    // on every CI box, but the fix — default to '127.0.0.1' outright,
    // sidestepping hostname resolution altogether — is correct on every box
    // regardless, and this test pins that default directly rather than
    // relying on the mutation happening to manifest.
    const server = await listenOnEphemeralPort(); // binds 127.0.0.1 only, no ::1
    try {
      const boundPort = server.address().port;
      const configuredPort = boundPort - 5;
      const notRefused = await probePortRangeRefused(configuredPort); // host omitted -> exercises the default
      assert.ok(notRefused.includes(boundPort), `expected ${boundPort} to be in ${JSON.stringify(notRefused)}`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('minor (pre-merge review, 2026-08-05): a configured port near the top of the 16-bit range does not throw — clamps at 65535 instead of overflowing', async () => {
    // Before the clamp, PORT=65530 + AUTO_REBIND_RANGE (20) walks the
    // candidate list up to 65549 — past the valid TCP port ceiling — and
    // `net.connect` throws SYNCHRONOUSLY on an out-of-range port number,
    // so the operator would see a raw stack trace instead of this script's
    // own refusal message. This must resolve cleanly, not throw or reject.
    await assert.doesNotReject(probePortRangeRefused(65530, '127.0.0.1'));
    const notRefused = await probePortRangeRefused(65530, '127.0.0.1');
    // Every candidate probed (65530-65535) should read as refused (nothing
    // listening there in a test environment) — the clamp excludes
    // 65536-65549 from the probed set entirely rather than crashing on them.
    assert.deepEqual(notRefused, []);
  });

  test('C1 (pre-merge review, 2026-08-05): a non-numeric startPort (NaN) refuses instead of silently probing nothing', async () => {
    // Before this fix: `NaN <= 65535` is false for every candidate the old
    // `.filter()` produced, so `ports` was emptied to `[]`, `Promise.all([])`
    // resolved `[]`, and main() read that as "every port definitively
    // refused" — the same shape a genuinely clean 20-port scan produces.
    // `Number('abc')` is exactly what `Number(process.env.PORT ?? 8080)`
    // yields for a malformed PORT env var. The fix must return a NON-EMPTY
    // array so main() refuses --apply and names the bad value.
    const notRefused = await probePortRangeRefused(Number('abc'), '127.0.0.1');
    assert.ok(notRefused.length > 0, `expected a non-empty refusal, got ${JSON.stringify(notRefused)}`);
    assert.ok(Number.isNaN(notRefused[0]));
  });

  test('C1: an out-of-range startPort (65536, one past the valid ceiling) refuses instead of probing nothing', async () => {
    const notRefused = await probePortRangeRefused(65536, '127.0.0.1');
    assert.deepEqual(notRefused, [65536]);
  });

  test('C1: a negative startPort (-1) refuses instead of reaching net.connect uncaught', async () => {
    const notRefused = await probePortRangeRefused(-1, '127.0.0.1');
    assert.deepEqual(notRefused, [-1]);
  });

  test('C1: a valid startPort is unaffected by the new guard — still probes the full range', async () => {
    const base = await findVerifiedFreeRange(AUTO_REBIND_RANGE, '127.0.0.1');
    const notRefused = await probePortRangeRefused(base, '127.0.0.1');
    // A verified-free range should read as fully refused (empty array) —
    // same as before this fix. Pins that the new guard doesn't over-refuse
    // a legitimate, in-range startPort.
    assert.deepEqual(notRefused, []);
  });
});

describe("buildOrphansFromSegments (#2093 residual 6; #2107 widened by owner decision, 2026-08-05, to list every non-'exact' tier as an orphan)", () => {
  const seg = (chapterId, chapterTitle, segments, characterSnapshots) => ({ chapterId, chapterTitle, segments, characterSnapshots });

  test('an id the resolver misses entirely becomes an orphan carrying segment count, per-chapter breakdown, duration, and snapshots', () => {
    const resolver = { resolve: () => undefined };
    const segs = [
      seg(
        1,
        'One',
        [
          { characterId: 'ghost', startSec: 0, endSec: 2 },
          { characterId: 'ghost', startSec: 2, endSec: 5 },
        ],
        { ghost: { gender: 'male' } },
      ),
    ];
    const { orphans } = buildOrphansFromSegments(segs, resolver);
    const entry = orphans.get('ghost');
    assert.equal(entry.segments, 2);
    assert.equal(entry.chapters.length, 1);
    assert.equal(entry.chapters[0].segments, 2);
    assert.ok(Math.abs(entry.chapters[0].durationSec - 5) < 1e-9);
    assert.deepEqual(entry.snapshots, [{ gender: 'male' }]);
  });

  test("an id resolving via 'exact' is the ONLY tier that skips — no alias table involved, always fine", () => {
    const resolver = {
      resolve(id) {
        if (id === 'live-id') return { character: { id: 'live-id' }, via: 'exact' };
        return undefined;
      },
    };
    const segs = [seg(1, 'One', [{ characterId: 'live-id' }])];
    const { orphans } = buildOrphansFromSegments(segs, resolver);
    assert.equal(orphans.size, 0);
  });

  test("CRITICAL (#2107, widened by owner decision): an id resolving via 'normalised-id' is now an orphan too — register row A32's the-torment/lightning-dave real-workspace counter-example", () => {
    // A narrower first version of this fix kept 'normalised-id' out of
    // orphans, reasoning it can't depend on the mutable supersededBy table
    // so it can't post-date the render. Independent review found that
    // proves only that no RENAME happened, not that the rendered bytes are
    // correct — register row A32 records a real case where a
    // 'normalised-id' match was rendered BEFORE Wave 1's resolver existed
    // at all, substituting the narrator regardless of tier. The owner
    // decided: over-reporting is the safe failure direction for a one-shot
    // repair tool, so ONLY 'exact' counts as "audio is fine" now.
    const resolver = { resolve: (id) => (id === 'drifted' ? { character: { id: 'live' }, via: 'normalised-id' } : undefined) };
    const segs = [seg(1, 'One', [{ characterId: 'drifted' }, { characterId: 'drifted' }])];
    const { orphans } = buildOrphansFromSegments(segs, resolver);
    assert.equal(orphans.get('drifted')?.segments, 2);
  });

  test("an id resolving via 'normalised-history' is an orphan (unchanged from the #2107 fix's first round)", () => {
    const resolver = { resolve: (id) => (id === 'old-alias' ? { character: { id: 'live' }, via: 'normalised-history' } : undefined) };
    const segs = [seg(1, 'One', [{ characterId: 'old-alias' }, { characterId: 'old-alias' }, { characterId: 'old-alias' }])];
    const { orphans } = buildOrphansFromSegments(segs, resolver);
    assert.equal(orphans.get('old-alias')?.segments, 3);
  });

  test("CRITICAL (#2107): an id resolving via 'history' is an orphan, NOT silently dropped as already-live", () => {
    // The root-cause shape: `mayrin` was aliased to `mairin` by a PRIOR
    // --apply run. The alias makes `resolver.resolve('mayrin')` succeed via
    // the 'history' tier today, but that says nothing about whether the
    // rendered audio on disk predates the alias — it does not (#2107's
    // real-workspace incident). Before this fix, ANY successful resolution
    // hit a blanket `continue` and this id vanished from `orphans` entirely
    // — genuinely rendered damage silently disappeared from the collector's
    // output.
    const resolver = {
      resolve(id) {
        if (id === 'aliased') return { character: { id: 'live-id' }, viaAlias: 'aliased', via: 'history' };
        return undefined;
      },
    };
    const segs = [seg(2, 'Two', [{ characterId: 'aliased', startSec: 0, endSec: 4 }, { characterId: 'aliased', startSec: 4, endSec: 6 }])];
    const { orphans } = buildOrphansFromSegments(segs, resolver);
    const entry = orphans.get('aliased');
    assert.equal(entry.segments, 2);
    assert.equal(entry.chapters[0].chapterId, 2);
  });

  test('CRITICAL (#2107): the cross-run case — an id auto-recorded on run 1 still lands on the re-render list on run 2, even though run 2 resolves it via history', () => {
    // CORRECTED (Important 3, independent review, 2026-08-05): this used to
    // claim the same-run 'history' test above "would still pass today,
    // since 'history' genuinely isn't an orphan WITHIN one run either way"
    // — that is false. Restoring the ORIGINAL blanket `if (resolution)
    // continue;` (the bug this whole file's `'history'`/`'normalised-*'`
    // tests exist to catch) fails FOUR tests, including that same-run
    // 'history' test — it is not, and was never, exempt. What "already
    // passed" before this fix actually refers to is the PRE-EXISTING test
    // that ENCODED the bug (a resolver stub whose contract was "any
    // successful resolution is not-an-orphan," full stop) and had to be
    // REWRITTEN, not left alongside a new one — a different and more
    // damning fact than "no test covered the same-run case."
    //
    // This test's own, real point: it pins the SPECIFIC two-run incident
    // shape — an id whose alias is recorded by run N is still narrator-
    // substituted on disk and must still appear on run N+1's re-render
    // list — which the same-run tests do not exercise at all (a same-run
    // resolver never sees its own pass's pending alias: pendingWrites are
    // only written to cast-id-history.json AFTER segmentOrphans is
    // computed). That is a regression-DOCUMENTATION value, not an
    // exclusive-detection one. This drives two independent
    // buildOrphansFromSegments calls with hand-written fake resolvers over
    // the SAME fixture to pin that specific before/after-alias sequence —
    // it does NOT call collectSegmentOrphans, build a real
    // buildCastResolver, or read a cast-id-history.json, so the actual
    // cross-run coupling (collectSegmentOrphans threading
    // history.supersededBy into the resolver on each call) remains
    // untested by this file; verified only by the on-box acceptance dry
    // run. Numbers mirror A33's real `--apply` run: `mayrin` ch2, 8
    // rendered segments, still narrator-substituted on disk after the
    // alias was recorded.
    const mayrinSegs = [
      seg(
        2,
        'Chapter Two',
        Array.from({ length: 8 }, (_, i) => ({ characterId: 'mayrin', startSec: i, endSec: i + 1 })),
      ),
    ];

    // Run 1: no alias recorded yet (a genuine miss) — becomes an orphan,
    // and the re-render list names it.
    const run1Resolver = { resolve: () => undefined };
    const run1 = buildOrphansFromSegments(mayrinSegs, run1Resolver);
    assert.equal(run1.orphans.get('mayrin')?.segments, 8);
    const run1Rows = buildRerenderRows('Coalfall', run1.orphans);
    assert.equal(run1Rows.length, 1);
    assert.equal(run1Rows[0].id, 'mayrin');

    // Run 2: same fixture, but cast-id-history.json now carries
    // `mayrin -> mairin` (written by run 1's own --apply, or an earlier
    // one) — the resolver's 'history' tier now succeeds for 'mayrin'. The
    // audio on disk is unchanged; it must still appear on the re-render
    // list.
    const run2Resolver = {
      resolve: (id) => (id === 'mayrin' ? { character: { id: 'mairin' }, viaAlias: 'mayrin', via: 'history' } : undefined),
    };
    const run2 = buildOrphansFromSegments(mayrinSegs, run2Resolver);
    assert.equal(
      run2.orphans.get('mayrin')?.segments,
      8,
      'the audio on disk is still narrator-substituted — recording the alias must not drop it off the re-render list',
    );
    const run2Rows = buildRerenderRows('Coalfall', run2.orphans);
    assert.equal(run2Rows.length, 1);
    assert.equal(run2Rows[0].id, 'mayrin');
    assert.equal(run2Rows[0].segments, 8);
  });

  test('non-string characterIds are ignored', () => {
    const resolver = { resolve: () => undefined };
    const segs = [seg(1, 'One', [{ characterId: 42 }, { characterId: null }, { characterId: undefined }])];
    const { orphans } = buildOrphansFromSegments(segs, resolver);
    assert.equal(orphans.size, 0);
  });
});

// Ie (pre-merge review, 2026-08-05): a subprocess test spawning the real
// script against an empty WORKSPACE_DIR was considered, to cover main()'s
// WIRING of this decision (that it's called with the right arguments and
// that main() actually exits 1) rather than only the decision itself below.
// Deliberately NOT added, for two reasons: (1) this repair pass is under an
// explicit instruction to never invoke `--apply`, and
// shouldRefuseApplyForEmptyScan only ever returns true when apply === true —
// a DRY run against zero books does not exercise this refusal at all, it
// falls through to loadServerModules() the same as any other dry run; (2)
// that fallthrough means such a subprocess test would need `server/dist`
// built to complete, which is not true in the `test:hooks` CI job this file
// runs in (see this file's own header comment) — so even a dry-run-only
// subprocess test would be environment-dependent in a way none of this
// file's other tests are. main()'s production wiring of this decision
// remains verified only by the live dry run against the real workspace (see
// the module doc comment's Tests section), same as
// shouldRefuseApplyForWithheldAutoRecord's own documented caveat above.
describe('shouldRefuseApplyForEmptyScan (#2108)', () => {
  test('dry run never refuses, whatever booksScanned is', () => {
    assert.equal(shouldRefuseApplyForEmptyScan(false, 0), false);
    assert.equal(shouldRefuseApplyForEmptyScan(false, 20), false);
  });

  test('--apply with a nonzero scan does not refuse', () => {
    assert.equal(shouldRefuseApplyForEmptyScan(true, 1), false);
    assert.equal(shouldRefuseApplyForEmptyScan(true, 20), false);
  });

  test('CRITICAL (#2108): --apply with a ZERO-book scan refuses — a wrong WORKSPACE_DIR must not exit 0 having examined nothing', () => {
    // Before this fix, a zero-book scan (a wrong WORKSPACE_DIR — the script
    // does not read server/.env) sailed through --apply: booksMissingCache
    // stays 0 because there is nothing to be missing evidence when nothing
    // was scanned, so the round-2 fail-closed guard could never fire, and
    // the script exited 0 having written nothing — reporting an empty tree
    // as a clean, healthy workspace on the exact line A33's precondition
    // tells an operator to trust.
    assert.equal(shouldRefuseApplyForEmptyScan(true, 0), true);
  });
});

describe('formatBooksScannedLine (#2108)', () => {
  test('a normal nonzero scan prints a plain count, no warning', () => {
    assert.equal(formatBooksScannedLine(20), 'books scanned: 20');
  });

  test('CRITICAL (#2108): a ZERO-book scan gets an explicit warning, not a bare "books scanned: 0" indistinguishable from a healthy summary', () => {
    // Every OTHER line in the --- Summary --- block also reads 0 for a
    // zero-book scan (0 auto-recordable, 0 reported, 0 re-render rows, 0
    // books missing cache evidence) — exactly what a genuinely clean,
    // fully-examined workspace would also print. Without a distinguishing
    // callout on THIS line, an operator has no way to tell "nothing needed
    // fixing" apart from "nothing was examined" by reading the summary
    // alone.
    const line = formatBooksScannedLine(0);
    assert.match(line, /^books scanned: 0 — WARNING:/);
    assert.match(line, /nothing was examined/i);
    assert.match(line, /WORKSPACE_DIR/);
  });
});
