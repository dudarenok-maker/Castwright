// Unit tests for scripts/repair-cast-id-drift.mjs's pure helpers (#2040 Wave
// 3 Task 18). Imports ONLY this script's own exports — never `server/dist` —
// so these tests run under `npm run test:hooks` with no build step, even
// though the script's own `main()` needs one (see the script's module doc
// comment). Run directly: `node --test scripts/tests/repair-cast-id-drift.test.mjs`.
//
// #2130's "drive buildOrphansFromSegments against the REAL
// buildCastResolver" coverage lives in
// server/src/store/cast-resolve.repair-pass-contract.test.ts, NOT here —
// see that file's own doc comment for why (this file's own CI job never
// builds the server, and — independently fatal — never even runs on a
// server/src-only diff). Every test in THIS file stays build-free.
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
  classifySnapshotEvidence,
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
  collectSegmentOrphans,
  formatNotYetAnalysedLine,
  collectBooks,
  collectBakNameEntries,
  shouldRefuseApplyForUnreadableBooks,
  stampScannedBooks,
} from '../repair-cast-id-drift.mjs';

// Simple stand-ins for the real server normalisers — deliberately NOT a
// byte-for-byte reimplementation of normaliseForMatch/normaliseIdKey (that
// would be exactly the "two independent matchers" hazard this task exists
// to avoid). These only need to exercise this script's OWN algorithmic
// decisions (ambiguity handling, tier precedence, the five auto-record
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

/** #2128 — test-local stand-in for the real `isAudioCurrent`
 *  (`server/src/store/cast-audio-currency.ts`), which this file cannot
 *  import directly: the module doc comment at the top of this file commits
 *  to importing ONLY this script's own exports, never `server/dist`, so
 *  `npm run test:hooks` never needs a server build — the exact same reason
 *  every resolver fake above is hand-rolled rather than the real
 *  `buildCastResolver`. This reimplements the SAME seven fail-closed rules
 *  the real predicate's own doc comment enumerates, so the fixtures below
 *  (which encode real seq/stamp/marker values) exercise the actual decision
 *  shape rather than a hard-coded stand-in. The cross-check against the
 *  REAL production `isAudioCurrent` lives in
 *  `server/src/store/cast-resolve.repair-pass-contract.test.ts` (#2130's
 *  same split, extended to this predicate by #2128) — this fake exists to
 *  drive `buildOrphansFromSegments`'s OWN wiring (call it, gate on `===
 *  true`, track `currentNonExact`, subtract at the end), not to re-prove
 *  the predicate's own correctness, which is Task 4's own suite
 *  (`cast-audio-currency.test.ts`). */
function fakeIsAudioCurrent(resolution, segmentsFile, history) {
  if (!resolution) return false;
  if (resolution.via === 'exact') return true;
  const finite = (n) => typeof n === 'number' && Number.isFinite(n);
  const stamp = segmentsFile?.castHistorySeq;
  if (!finite(stamp)) return 'unknown';
  if (resolution.via === 'normalised-id') return true;
  const markers = history.recordedAtSeq;
  if (markers === undefined) return 'unknown';
  if (!finite(history.seq) || history.seq < stamp) return 'unknown';
  if (!resolution.matchedHistoryKeys?.length) return 'unknown';
  let highest = 0;
  for (const key of resolution.matchedHistoryKeys) {
    const marker = markers[key];
    if (marker === undefined || !finite(marker)) return 'unknown';
    if (marker > highest) highest = marker;
  }
  return stamp >= highest;
}

/** #2128 — fake resolver for the `buildOrphansFromSegments`/`isAudioCurrent`
 *  wiring tests below. Reports the two fields `isAudioCurrent` actually
 *  reads (`via`, `matchedHistoryKeys`) — none of the resolver fakes above
 *  do, because `isAudioCurrent` didn't exist when they were written. NOT a
 *  byte-for-byte reimplementation of the real four-tier resolver (the same
 *  "two independent matchers" hazard every other fake in this file already
 *  avoids) — implements only what these tests need: a direct
 *  `history.supersededBy` lookup (the `'history'` tier) and an id-shape
 *  match against any extra live cast rows passed in (the `'normalised-id'`
 *  tier). */
function resolverFor(history, extraLiveCast = []) {
  const supersededBy = history.supersededBy ?? {};
  const byNormId = new Map(extraLiveCast.map((c) => [idKey(c.id), c]));
  return {
    resolve(id) {
      if (id in supersededBy) {
        return { character: { id: supersededBy[id] }, via: 'history', matchedHistoryKeys: [id] };
      }
      const norm = byNormId.get(idKey(id));
      if (norm) return { character: norm, via: 'normalised-id' };
      return undefined;
    },
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

describe('classifySnapshotEvidence (#2134)', () => {
  test("'no-evidence': real rendered segments, zero snapshot entries — the exact register-row-A32 the-torment/lightning-dave shape", () => {
    assert.equal(classifySnapshotEvidence({ segments: 67, snapshots: [] }), 'no-evidence');
  });

  test("mutation control: segments === 0 with zero snapshots is NOT 'no-evidence' — guard 3 (zero-segment scoping) owns that case, not guard 4", () => {
    // Pins the `orphan.segments > 0 &&` half of the condition specifically:
    // deleting it would make a genuinely never-rendered id (which legitimately
    // has no snapshots) read as 'no-evidence' too, which is guard 3's job.
    assert.equal(classifySnapshotEvidence({ segments: 0, snapshots: [] }), 'consistent');
  });

  test("mutation control: real segments with a NON-EMPTY (even single, field-less) snapshot array is NOT 'no-evidence'", () => {
    // Pins the `snapshots.length === 0` half specifically: deleting it (or
    // loosening it to e.g. `.length < 2`) would misclassify a genuinely
    // single-snapshot orphan — 0 or 1 snapshots is exactly what
    // snapshotsConsistent treats as vacuously consistent — as 'no-evidence'.
    assert.equal(classifySnapshotEvidence({ segments: 5, snapshots: [{}] }), 'consistent');
  });

  test("'conflict': real segments, snapshots present but disagree — delegates to snapshotsConsistent, unaffected by the no-evidence split", () => {
    assert.equal(
      classifySnapshotEvidence({ segments: 2, snapshots: [{ gender: 'male' }, { gender: 'female' }] }),
      'conflict',
    );
  });

  test("'consistent': real segments, snapshots present and agree", () => {
    const snap = { gender: 'male', ageRange: 'adult' };
    assert.equal(classifySnapshotEvidence({ segments: 3, snapshots: [snap, { ...snap }] }), 'consistent');
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
   *  downgrades it to report-only.
   *
   *  #2134: defaults `snapshots` to a single neutral (empty-fields) entry,
   *  not `[]` — `classifySnapshotEvidence` now reads a real
   *  `segments > 0, snapshots: []` orphan as 'no-evidence' and withholds
   *  it, so a bare `[]` default would silently downgrade every OTHER
   *  guard's test in this describe block (ambiguity veto, reserved-id,
   *  Tier A/B precedence, etc. — none of which are testing guard 4) to
   *  report-only too. One neutral snapshot means "evidence was found under
   *  this id's own key, and there's nothing in it to disagree with" —
   *  `classifySnapshotEvidence` reads that as 'consistent', matching this
   *  helper's pre-#2134 behaviour for every caller that doesn't override
   *  it. Tests that actually exercise guard 4's three-way split (conflict /
   *  no-evidence / consistent) pass `snapshots` explicitly instead — see
   *  the dedicated `classifySnapshotEvidence` guard-4 tests below. */
  const renderedOrphan = (segments, chapters, snapshots) => ({
    segments,
    chapters: chapters ?? [{ chapterId: 1, chapterTitle: 'One', segments, durationSec: segments * 2 }],
    snapshots: snapshots ?? [{}],
  });

  test('Tier A auto-record via an unambiguous cache name, when the id has real rendered damage', () => {
    const cacheNameIndex = buildNameIndex([{ id: 'mayrin', name: 'Мэйрин' }], lc);
    const orphans = new Map([['mayrin', renderedOrphan(8)]]);
    const plan = planBookRepairs({ liveCast, history: {}, cacheNameIndex, bakNameIndex: new Map(), orphans, cacheAvailable: true, bakAvailable: true }, deps);
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
    const plan = planBookRepairs({ liveCast, history: {}, cacheNameIndex, bakNameIndex, orphans, cacheAvailable: true, bakAvailable: true }, deps);
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

  test('Round 4, MUST 2 (independent review, 2026-08-05): the historyResolver fallback threads rejectedPairs through — a pair-rejected alias must NOT read as already-recorded', () => {
    // The bug this pins: the fallback (`planBookRepairs`'s `historyResolver`
    // default, when `input.historyResolver` is omitted) built
    // `{ supersededBy, rejected }` without `rejectedPairs` — correct on
    // `main`, where the field didn't exist yet, and wrong the moment
    // #2092/#2089 merged, since the real `buildCastResolver` now also
    // reads it. A resolver missing `rejectedPairs` resolves 'mayrin' via
    // the 'history' tier despite the pair reject below, which trips the
    // already-recorded skip a few lines down (`aliasHit.via === 'history'
    // | 'normalised-history'`) and hides the id from BOTH `autoRecord` AND
    // `reportOnly` — a false skip, the exact under-report class the #2107
    // widening exists to prevent, reintroduced one guard over.
    //
    // A PARTIAL history — `rejected` omitted entirely, exercising the same
    // "planBookRepairs supports a partial history" contract the sibling
    // test below pins — carrying `rejectedPairs` and no `historyResolver`.
    // `makeRejectedPairsAwareFakeResolver` (unlike the shared
    // `makeHistoryAwareFakeResolver`, which ignores `rejectedPairs`
    // entirely — see its own doc comment) actually consults it, so
    // whether the fallback threads the field through is observable here.
    const makeRejectedPairsAwareFakeResolver = (idKeyFn) =>
      function buildRejectedPairsAwareFakeResolver(cast, history = {}) {
        const byId = new Map(cast.map((c) => [c.id, c]));
        const byNormId = new Map(cast.map((c) => [idKeyFn(c.id), c]));
        const supersededBy = history.supersededBy ?? {};
        const rejectedPairs = history.rejectedPairs ?? [];
        return {
          resolve(id) {
            if (byId.has(id)) return { character: byId.get(id), via: 'exact' };
            if (id in supersededBy) {
              const targetId = supersededBy[id];
              const rejected = rejectedPairs.some((p) => p.from === id && p.to === targetId);
              if (rejected) return undefined; // D2: pair-rejected, no fall-through
              const target = byId.get(targetId);
              if (target) return { character: target, viaAlias: id, via: 'history' };
            }
            const normId = byNormId.get(idKeyFn(id));
            if (normId) return { character: normId, viaAlias: id, via: 'normalised-id' };
            return undefined;
          },
        };
      };
    const localDeps = { ...deps, buildCastResolver: makeRejectedPairsAwareFakeResolver(idKey) };
    const cacheNameIndex = buildNameIndex([{ id: 'mayrin', name: 'Мэйрин' }], lc);
    const orphans = new Map([['mayrin', renderedOrphan(4)]]);
    const plan = planBookRepairs(
      {
        liveCast,
        history: { supersededBy: { mayrin: 'mairin' }, rejectedPairs: [{ from: 'mayrin', to: 'mairin' }] },
        cacheNameIndex,
        bakNameIndex: new Map(),
        orphans,
        cacheAvailable: true,
        bakAvailable: true,
      },
      localDeps,
    );
    // NOT already-recorded — the pair reject correctly blocks the stale
    // alias, so the id reaches Tier A/B matching instead of being silently
    // hidden from both `autoRecord` and `reportOnly`.
    assert.equal(
      plan.skipped.some((s) => s.id === 'mayrin' && s.reason === 'already-recorded'),
      false,
    );
    // It DOES reach Tier A (the cache name "Мэйрин" unambiguously matches
    // live 'mairin'), and is THEN correctly declined by the pair-reject
    // guard specifically — proving the false skip's damage concretely
    // (with the fallback fix REMOVED, this whole scenario collapses to the
    // single 'already-recorded' skip asserted absent above, and neither
    // this specific reason nor the Tier A match is ever reached) rather
    // than merely asserting an absence.
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.reportOnly.length, 0);
    assert.equal(plan.skipped.length, 1);
    assert.equal(plan.skipped[0].id, 'mayrin');
    assert.equal(plan.skipped[0].reason, 'rejected-pair');
  });

  test('Round 4 (independent review, 2026-08-05): a PARTIAL history (no supersededBy field), no historyResolver, and a real-shaped buildCastResolver dep does not throw', () => {
    // planBookRepairs itself treats a partial history as a supported input
    // shape — it defends `history.rejected ?? []` a few lines up, and
    // `history: {}` appears 25 times across this file's 32 calls to
    // `planBookRepairs`. The real
    // `buildCastResolver` (cast-resolve.ts) does
    // `Object.entries(history.supersededBy)` with NO internal defense —
    // TypeError on `undefined`. `planBookRepairs`'s own fallback
    // construction (when `historyResolver` is omitted) used to pass
    // `history` straight through, which would crash against a real
    // resolver and a partial history — latent only because every test that
    // passes a partial history also uses the fake `deps.buildCastResolver`
    // (`makeFakeResolver`), which never reads `history` at all, and every
    // test that uses a REAL-history-reading fake
    // (`makeHistoryAwareFakeResolver`) defends `supersededBy` internally,
    // so neither existing test double could have caught this.
    // `buildRealShapedResolver` below is neither — it mirrors the real
    // resolver's actual (undefended) construction line, so it genuinely
    // throws if planBookRepairs ever hands it an `undefined`
    // `supersededBy`.
    const buildRealShapedResolver = (cast, hist) => {
      const byId = new Map(cast.map((c) => [c.id, c]));
      // The exact real-resolver line this mirrors (cast-resolve.ts): no
      // `?? {}` defense — throws on a partial history if the caller didn't
      // already normalise it.
      for (const [, to] of Object.entries(hist.supersededBy)) void to;
      return { resolve: (id) => (byId.has(id) ? { character: byId.get(id), via: 'exact' } : undefined) };
    };
    const localDeps = { ...deps, buildCastResolver: buildRealShapedResolver };
    const cacheNameIndex = buildNameIndex([{ id: 'mayrin', name: 'Мэйрин' }], lc);
    const orphans = new Map([['mayrin', renderedOrphan(8)]]);
    assert.doesNotThrow(() => {
      const plan = planBookRepairs(
        { liveCast, history: { rejected: [] }, cacheNameIndex, bakNameIndex: new Map(), orphans, cacheAvailable: true, bakAvailable: true },
        localDeps,
      );
      assert.equal(plan.autoRecord.length, 1);
      assert.equal(plan.autoRecord[0].id, 'mayrin');
    });
  });

  test('I1 (independent review, round 1, 2026-08-10): the historyResolver fallback threads the WHOLE history object through — not an enumerated subset', () => {
    // Guard 3 (`cast-history-threading.guard.test.ts`) is a SYNTACTIC scan —
    // it can only see a literal object AT the call site, and
    // `historyForResolver` is a variable one line above the call, which is
    // exactly the blind spot the guard's own header documents. Nothing
    // syntactic can prove what actually reaches `buildCastResolver` through
    // that local, and the closest existing pin (the "Round 4, MUST 2"
    // test above) only asserts one ENUMERATED field (`rejectedPairs`) — the
    // precise shape that went stale the moment #2092/#2089 landed a field
    // this fallback's earlier, subset-built version didn't know about. This
    // test is the behavioural half: capture the real second argument
    // `buildCastResolver` receives and assert every key `history` carries —
    // including a field #2128 never named — survives untouched. Mutate the
    // fallback back to an enumerated subset (e.g. `{ supersededBy: {},
    // rejected: history.rejected }`) to see this redden.
    const captures = [];
    const localDeps = {
      ...deps,
      buildCastResolver: (cast, hist) => {
        captures.push(hist);
        return { resolve: () => undefined };
      },
    };
    const history = {
      supersededBy: {},
      rejected: [],
      seq: 7,
      recordedAtSeq: { a: 1 },
      futureField: 'x',
    };
    planBookRepairs(
      { liveCast, history, cacheNameIndex: new Map(), bakNameIndex: new Map(), orphans: new Map() },
      localDeps,
    );
    // `idOnlyResolver` also calls `buildCastResolver`, with its own
    // deliberately-empty-history literal — identify the fallback's OWN call
    // by the one marker no other call site could produce: `futureField`.
    const captured = captures.find((c) => 'futureField' in c);
    assert.ok(captured, 'buildCastResolver was never called with the historyResolver fallback\'s object');
    for (const key of Object.keys(history)) {
      assert.ok(key in captured, `historyForResolver dropped '${key}'`);
    }
  });

  test('M7 (independent review, round 1, 2026-08-10): an explicit `supersededBy: undefined` key does not throw', () => {
    // A trailing-spread-only fallback (`{ supersededBy: {}, ...history }`) is
    // defeated by this exact shape: `history` OWNS a `supersededBy` key, so
    // the spread copies its `undefined` value straight over the leading
    // default, and the real (undefended) `buildCastResolver` throws on
    // `Object.entries(undefined)`. Distinct from the "Round 4" test above,
    // which only exercises `history` OMITTING the key entirely — a spread
    // does not override on a merely-absent key, so that test could not have
    // caught this. `buildRealShapedResolver` mirrors the real resolver's
    // undefended construction line, same as the Round 4 test.
    const buildRealShapedResolver = (cast, hist) => {
      const byId = new Map(cast.map((c) => [c.id, c]));
      for (const [, to] of Object.entries(hist.supersededBy)) void to;
      return { resolve: (id) => (byId.has(id) ? { character: byId.get(id), via: 'exact' } : undefined) };
    };
    const localDeps = { ...deps, buildCastResolver: buildRealShapedResolver };
    assert.doesNotThrow(() => {
      planBookRepairs(
        {
          liveCast,
          history: { supersededBy: undefined, rejected: [] },
          cacheNameIndex: new Map(),
          bakNameIndex: new Map(),
          orphans: new Map(),
        },
        localDeps,
      );
    });
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
      { liveCast: localLiveCast, history: {}, cacheNameIndex: new Map(), bakNameIndex: new Map(), orphans, cacheAvailable: true, bakAvailable: true, historyResolver },
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

  // #2092/#2089 Task 9 — pair-scoped `rejectedPairs`, replacing the old
  // id-wide skip for NEW rejects (the legacy `rejected` list above stays
  // id-wide on purpose — see planBookRepairs's own doc comment). These two
  // are the brief's stated minimum: the SAME orphaned id ("mayrin") rejected
  // against ONE target ("mairin") must still auto-record against a DIFFERENT
  // target ("timkin") it separately matches, and must still be blocked
  // against the rejected target itself. A test only covering the second
  // half would pass against the old unconditional id-wide skip too.
  test('a pair-rejected id is skipped when it matches the REJECTED target', () => {
    const cacheNameIndex = buildNameIndex([{ id: 'mayrin', name: 'Мэйрин' }], lc); // matches live 'mairin'
    const orphans = new Map([['mayrin', renderedOrphan(8)]]);
    const plan = planBookRepairs(
      {
        liveCast,
        history: { rejectedPairs: [{ from: 'mayrin', to: 'mairin' }] },
        cacheNameIndex,
        bakNameIndex: new Map(),
        orphans,
        cacheAvailable: true,
        bakAvailable: true,
      },
      deps,
    );
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.skipped.length, 1);
    assert.equal(plan.skipped[0].reason, 'rejected-pair');
    assert.match(plan.skipped[0].detail, /"mayrin" -> "mairin"/);
  });

  test('a pair-rejected id is STILL auto-recorded when it matches a DIFFERENT target', () => {
    const cacheNameIndex = buildNameIndex([{ id: 'mayrin', name: 'Timkin' }], lc); // matches live 'timkin', not 'mairin'
    const orphans = new Map([['mayrin', renderedOrphan(5)]]);
    const plan = planBookRepairs(
      {
        liveCast,
        history: { rejectedPairs: [{ from: 'mayrin', to: 'mairin' }] }, // rejection is against a DIFFERENT target
        cacheNameIndex,
        bakNameIndex: new Map(),
        orphans,
        cacheAvailable: true,
        bakAvailable: true,
      },
      deps,
    );
    assert.equal(plan.skipped.length, 0);
    assert.equal(plan.autoRecord.length, 1);
    assert.equal(plan.autoRecord[0].id, 'mayrin');
    assert.equal(plan.autoRecord[0].to, 'timkin');
  });

  // I2 (review round 1) — the repair pass's own real drift shape:
  // `the_torment`/`The-Torment` both normalise to the same key. Rejecting
  // one raw spelling must still block a DIFFERENT raw spelling's Tier B
  // (normalised-id) match onto the same target — the guard has to mirror
  // the SAME keyspace the tier it protects actually matches on.
  test('I2: rejecting one raw spelling blocks a DIFFERENT raw spelling that normalises the same (Tier B match)', () => {
    const liveCastWithTorment = [...liveCast, { id: 'the-torment', name: 'The Torment' }];
    // No name evidence anywhere — forces Tier B (id-shape) rather than Tier A.
    const orphans = new Map([['the_torment', renderedOrphan(4)]]);
    const plan = planBookRepairs(
      {
        liveCast: liveCastWithTorment,
        history: { rejectedPairs: [{ from: 'The-Torment', to: 'the-torment' }] },
        cacheNameIndex: new Map(),
        bakNameIndex: new Map(),
        orphans,
        cacheAvailable: true,
        bakAvailable: true,
      },
      deps,
    );
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.skipped.length, 1);
    assert.equal(plan.skipped[0].id, 'the_torment');
    assert.equal(plan.skipped[0].reason, 'rejected-pair');
  });

  test('I2: an id that normalises DIFFERENTLY from the rejected pair still auto-records (the fix is not over-broad)', () => {
    const liveCastWithTorment = [...liveCast, { id: 'the-torment', name: 'The Torment' }];
    const orphans = new Map([['the_torment', renderedOrphan(4)]]);
    const plan = planBookRepairs(
      {
        liveCast: liveCastWithTorment,
        // Rejection names an unrelated `from` that does NOT normalise the
        // same as 'the_torment' — must not block it.
        history: { rejectedPairs: [{ from: 'unrelated-id', to: 'timkin' }] },
        cacheNameIndex: new Map(),
        bakNameIndex: new Map(),
        orphans,
        cacheAvailable: true,
        bakAvailable: true,
      },
      deps,
    );
    assert.equal(plan.skipped.length, 0);
    assert.equal(plan.autoRecord.length, 1);
    assert.equal(plan.autoRecord[0].id, 'the_torment');
    assert.equal(plan.autoRecord[0].to, 'the-torment');
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

  test("#2134 round 2: a Tier B (id-shape) match with real rendered segments but NO characterSnapshots evidence under its own key STILL auto-records, annotated 'no-evidence' — the register-row-A32 the-torment shape", () => {
    // 'the-torment' normalises the same as live 'the_torment' and carries
    // NO name evidence anywhere (no cacheNameIndex/bakNameIndex entry) —
    // this is the real workspace's actual the-torment shape: Tier B only
    // (dry-run evidence string: `id "the-torment" normalises the same as
    // live id "the_torment"`), not Tier A as an earlier draft of this test
    // wrongly assumed. Guard 5's default historyResolver (built from
    // deps.buildCastResolver) resolves 'the-torment' via 'normalised-id' to
    // the SAME character the Tier B match finds, so guard 5 does not trip
    // and this reaches guard 4. Real workspace shape: characterSnapshots is
    // keyed by the pre-drift id ('the_torment'), never the orphaned
    // spelling, so this id's own segments carry zero snapshot entries
    // despite 67 real rendered segments — snapshots: [] here, NOT via
    // renderedOrphan's now-neutral default.
    //
    // Round 2 (independent review, 2026-08-05): 'no-evidence' is no longer
    // a veto — characterSnapshots is written only for a LIVE id at render
    // time, so its ABSENCE here means the narrator was substituted at
    // render time (the actual A32 damage this pass exists to fix), not a
    // reason to distrust the alias. This id — real workspace evidence —
    // is one of the two aliases (with coalfall) that a round-1 veto would
    // have wrongly blocked, per the owner-accepted register row A33 write.
    const localLiveCast = [...liveCast, { id: 'the_torment', name: 'The Torment' }];
    const orphans = new Map([
      [
        'the-torment',
        { segments: 67, chapters: [{ chapterId: 19, chapterTitle: 'Nineteen', segments: 67, durationSec: 400 }], snapshots: [] },
      ],
    ]);
    const plan = planBookRepairs(
      { liveCast: localLiveCast, history: {}, cacheNameIndex: new Map(), bakNameIndex: new Map(), orphans, cacheAvailable: true, bakAvailable: true },
      deps,
    );
    assert.equal(plan.reportOnly.length, 0);
    assert.equal(plan.autoRecord.length, 1);
    assert.equal(plan.autoRecord[0].id, 'the-torment');
    assert.equal(plan.autoRecord[0].to, 'the_torment');
    assert.equal(plan.autoRecord[0].tier, 'B');
    assert.equal(plan.autoRecord[0].snapshotEvidence, 'no-evidence');
  });

  test("#2134 round 2: a Tier A (name) match with real rendered segments but no characterSnapshots evidence ALSO auto-records, annotated 'no-evidence' — the register-row-A32 lightning-dave shape", () => {
    // 'lightning-dave' matches via an unambiguous CACHE name ("Lightning
    // Dave" == live "Lightning Dave") — the real workspace's actual
    // lightning-dave shape is Tier A (dry-run evidence string: `analysis
    // cache name "Lightning Dave" == live "Lightning Dave"`), not Tier B as
    // an earlier draft of this test wrongly assumed.
    const localLiveCast = [...liveCast, { id: 'lightning_dave', name: 'Lightning Dave' }];
    const cacheNameIndex = buildNameIndex([{ id: 'lightning-dave', name: 'Lightning Dave' }], lc);
    const orphans = new Map([
      ['lightning-dave', { segments: 1, chapters: [{ chapterId: 3, chapterTitle: 'Three', segments: 1, durationSec: 4 }], snapshots: [] }],
    ]);
    const plan = planBookRepairs(
      { liveCast: localLiveCast, history: {}, cacheNameIndex, bakNameIndex: new Map(), orphans, cacheAvailable: true, bakAvailable: true },
      deps,
    );
    assert.equal(plan.reportOnly.length, 0);
    assert.equal(plan.autoRecord.length, 1);
    assert.equal(plan.autoRecord[0].id, 'lightning-dave');
    assert.equal(plan.autoRecord[0].to, 'lightning_dave');
    assert.equal(plan.autoRecord[0].tier, 'A');
    assert.equal(plan.autoRecord[0].snapshotEvidence, 'no-evidence');
  });

  test("#2134 round 2, CRITICAL (the real-data proof): the register-row-A32 mayrin shape — a Tier A match with NO snapshot evidence — auto-records; a round-1 veto would have wrongly blocked exactly this alias", () => {
    // The decisive real-data replay from independent review: 'mayrin' (8
    // segments, *Заказ Коалфолла* ch2) has no characterSnapshots entry
    // under its own key (the file's snapshot keys are narrator/oduvan/ren/
    // pell-hollis — 'mayrin' isn't among them), yet this alias is one of
    // the three the owner already applied and accepted on the real
    // workspace (register row A33, 2026-08-05). A round-1 'no-evidence'
    // veto would have blocked it.
    const cacheNameIndex = buildNameIndex([{ id: 'mayrin', name: 'Мэйрин' }], lc);
    const orphans = new Map([
      ['mayrin', { segments: 8, chapters: [{ chapterId: 2, chapterTitle: 'Chapter Two', segments: 8, durationSec: 18 }], snapshots: [] }],
    ]);
    const plan = planBookRepairs(
      { liveCast, history: {}, cacheNameIndex, bakNameIndex: new Map(), orphans, cacheAvailable: true, bakAvailable: true },
      deps,
    );
    assert.equal(plan.reportOnly.length, 0);
    assert.equal(plan.autoRecord.length, 1);
    assert.equal(plan.autoRecord[0].id, 'mayrin');
    assert.equal(plan.autoRecord[0].to, 'mairin');
    assert.equal(plan.autoRecord[0].snapshotEvidence, 'no-evidence');
  });

  test('#2134 round 2, mutation control: the SAME the-torment shape WITH real (even minimal) snapshot evidence auto-records annotated \'consistent\', not \'no-evidence\' — pins that the annotation tracks the real classification, not a hardcoded string', () => {
    const localLiveCast = [...liveCast, { id: 'the_torment', name: 'The Torment' }];
    const orphans = new Map([
      [
        'the-torment',
        {
          segments: 67,
          chapters: [{ chapterId: 19, chapterTitle: 'Nineteen', segments: 67, durationSec: 400 }],
          snapshots: [{ gender: 'male' }], // real evidence this time, unlike the test above
        },
      ],
    ]);
    const plan = planBookRepairs(
      { liveCast: localLiveCast, history: {}, cacheNameIndex: new Map(), bakNameIndex: new Map(), orphans, cacheAvailable: true, bakAvailable: true },
      deps,
    );
    assert.equal(plan.reportOnly.length, 0);
    assert.equal(plan.autoRecord.length, 1);
    assert.equal(plan.autoRecord[0].id, 'the-torment');
    assert.equal(plan.autoRecord[0].to, 'the_torment');
    assert.equal(plan.autoRecord[0].snapshotEvidence, 'consistent');
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
    const plan = planBookRepairs({ liveCast, history: {}, cacheNameIndex, bakNameIndex: new Map(), orphans, cacheAvailable: true, bakAvailable: true }, deps);
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
      { liveCast, history: {}, cacheNameIndex: new Map(), bakNameIndex, orphans, cacheAvailable: false, bakAvailable: true },
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
    assert.equal(plan.withheldForMissingBak, 0);
  });

  test('#2135: bakAvailable=false withholds an otherwise-clean Tier A auto-record, since the cross-source ambiguity veto cannot see this book\'s full bak evidence — mirrors the cache test above', () => {
    // Realistic shape: cacheNameIndex has a clean, unambiguous match;
    // bakAvailable is false (a cast.json.bak.* for this book existed but
    // failed to parse — main() computes this from collectBakNameEntries).
    // Isolates the bak gate the same way the cache test above isolates it.
    const cacheNameIndex = buildNameIndex([{ id: 'mayrin', name: 'Мэйрин' }], lc);
    const orphans = new Map([['mayrin', renderedOrphan(8)]]);
    const plan = planBookRepairs(
      { liveCast, history: {}, cacheNameIndex, bakNameIndex: new Map(), orphans, cacheAvailable: true, bakAvailable: false },
      deps,
    );
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.reportOnly.length, 1);
    assert.equal(plan.reportOnly[0].id, 'mayrin');
    assert.match(plan.reportOnly[0].reason, /cast\.json\.bak\.\* files could not be read or parsed/);
    assert.equal(plan.withheldForMissingBak, 1);
    assert.equal(plan.withheldForMissingCache, 0); // bak gate is checked first and consumes the id — cache is never reached
  });

  test('#2135: bakAvailable defaults to FALSE when omitted — the same fail-closed posture as cacheAvailable (RESIDUAL 3\'s sibling)', () => {
    const cacheNameIndex = buildNameIndex([{ id: 'mayrin', name: 'Мэйрин' }], lc);
    const orphans = new Map([['mayrin', renderedOrphan(8)]]);
    // `input` deliberately omits `bakAvailable` entirely; `cacheAvailable:
    // true` isolates it from the cache gate.
    const plan = planBookRepairs({ liveCast, history: {}, cacheNameIndex, bakNameIndex: new Map(), orphans, cacheAvailable: true }, deps);
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.reportOnly.length, 1);
    assert.match(plan.reportOnly[0].reason, /cast\.json\.bak\.\* files could not be read or parsed/);
  });

  test('#2135: a book with bakAvailable=false but NO Tier A/B candidate withholds NOTHING — the bak-side sibling of the cache "nothing at stake" policy', () => {
    const orphans = new Map([
      ['silveny', { segments: 17, chapters: [{ chapterId: 50, chapterTitle: 'Forty-Eight', segments: 6, durationSec: 12 }], snapshots: [] }],
    ]);
    const plan = planBookRepairs(
      { liveCast, history: {}, cacheNameIndex: new Map(), bakNameIndex: new Map(), orphans, bakAvailable: false, cacheAvailable: true },
      deps,
    );
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.reportOnly.length, 1);
    assert.match(plan.reportOnly[0].reason, /no display name found/);
    assert.equal(plan.withheldForMissingBak, 0);
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
    // `input` deliberately omits `cacheAvailable` entirely — `bakAvailable:
    // true` isolates that default from the (also fail-closed-by-default,
    // #2135) bak gate, which would otherwise fire first and mask this test's
    // actual assertion.
    const plan = planBookRepairs({ liveCast, history: {}, cacheNameIndex, bakNameIndex: new Map(), orphans, bakAvailable: true }, deps);
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

  test('#2128: distinguishes a current non-exact id from a never-rendered one, and auto-records neither', () => {
    // No `candidateIds` field on `input` — the ids come from the name
    // indexes, so both 'The_Torment' and 'never-spoke' are seeded into
    // cacheNameIndex, matching every other auto-record test in this
    // describe block. Both individually name "Timkin" unambiguously (this
    // guard only checks per-id ambiguity, not cross-id collisions), so both
    // Tier-A-match onto the live 'timkin' and reach the zero-segment branch
    // (neither appears in `orphans`).
    const cacheNameIndex = buildNameIndex(
      [
        { id: 'The_Torment', name: 'Timkin' },
        { id: 'never-spoke', name: 'Timkin' },
      ],
      lc,
    );
    const plan = planBookRepairs(
      {
        liveCast,
        history: {},
        cacheNameIndex,
        bakNameIndex: new Map(),
        orphans: new Map(),
        cacheAvailable: true,
        bakAvailable: true,
        currentNonExact: new Set(['The_Torment']),
      },
      deps,
    );
    assert.deepEqual(plan.autoRecord, []);
    assert.match(plan.reportOnly.find((r) => r.id === 'The_Torment').reason, /is already current/);
    assert.match(plan.reportOnly.find((r) => r.id === 'never-spoke').reason, /zero rendered segments/);
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
    const result = planApplyRefusal(false, [{ label: 'Book A', withheldForMissingCache: 3, withheldForMissingBak: 0 }]);
    assert.equal(result.refuse, false);
    assert.equal(result.booksWithheldForMissingCache, 1);
    assert.equal(result.booksWithheldTotal, 1);
  });

  test('apply=true with no withheld books does not refuse', () => {
    const result = planApplyRefusal(true, [
      { label: 'Book A', withheldForMissingCache: 0, withheldForMissingBak: 0 },
      { label: 'Book B', withheldForMissingCache: 0, withheldForMissingBak: 0 },
    ]);
    assert.equal(result.refuse, false);
    assert.equal(result.booksWithheldForMissingCache, 0);
    assert.equal(result.booksWithheldTotal, 0);
    assert.deepEqual(result.withheldBookLabels, []);
  });

  test('CRITICAL (#2111): apply=true with one withheld book refuses and names it — the last workspace-level rail', () => {
    const result = planApplyRefusal(true, [
      { label: 'Book A', withheldForMissingCache: 0, withheldForMissingBak: 0 },
      { label: 'Book B', withheldForMissingCache: 2, withheldForMissingBak: 0 },
    ]);
    assert.equal(result.refuse, true);
    assert.equal(result.booksWithheldForMissingCache, 1);
    assert.deepEqual(result.withheldBookLabels, ['Book B (2 id(s) missing cache evidence)']);
  });

  test('accumulates across multiple withheld books, not just the first', () => {
    const result = planApplyRefusal(true, [
      { label: 'Book A', withheldForMissingCache: 1, withheldForMissingBak: 0 },
      { label: 'Book B', withheldForMissingCache: 0, withheldForMissingBak: 0 },
      { label: 'Book C', withheldForMissingCache: 5, withheldForMissingBak: 0 },
    ]);
    assert.equal(result.booksWithheldForMissingCache, 2);
    assert.deepEqual(result.withheldBookLabels, ['Book A (1 id(s) missing cache evidence)', 'Book C (5 id(s) missing cache evidence)']);
    assert.equal(result.refuse, true);
  });

  test('an empty bookWithholds list refuses nothing (matches an empty workspace scan, not "unknown")', () => {
    const result = planApplyRefusal(true, []);
    assert.equal(result.refuse, false);
    assert.equal(result.booksWithheldForMissingCache, 0);
    assert.deepEqual(result.withheldBookLabels, []);
  });

  test('#2135: a book withheld for BAK evidence alone (no cache withholding) also refuses and is counted under booksWithheldForMissingBak, not cache', () => {
    const result = planApplyRefusal(true, [{ label: 'Book A', withheldForMissingCache: 0, withheldForMissingBak: 4 }]);
    assert.equal(result.refuse, true);
    assert.equal(result.booksWithheldForMissingCache, 0);
    assert.equal(result.booksWithheldForMissingBak, 1);
    assert.equal(result.booksWithheldTotal, 1);
    assert.deepEqual(result.withheldBookLabels, ['Book A (4 id(s) missing bak evidence)']);
  });

  test('#2135: a book withheld for BOTH bak and cache evidence names both reasons in one label and counts once toward the total', () => {
    const result = planApplyRefusal(true, [{ label: 'Book A', withheldForMissingCache: 2, withheldForMissingBak: 3 }]);
    assert.equal(result.booksWithheldForMissingCache, 1);
    assert.equal(result.booksWithheldForMissingBak, 1);
    assert.equal(result.booksWithheldTotal, 1);
    assert.deepEqual(result.withheldBookLabels, ['Book A (3 id(s) missing bak evidence; 2 id(s) missing cache evidence)']);
  });

  test('#2135: withheldForMissingBak omitted (older-shaped input) alongside a real nonzero cache count does not crash, and the bak sub-count stays 0 (no phantom count invented)', () => {
    const result = planApplyRefusal(true, [{ label: 'Book A', withheldForMissingCache: 1 }]);
    assert.equal(result.booksWithheldForMissingBak, 0);
    assert.equal(result.booksWithheldForMissingCache, 1);
    assert.equal(result.booksWithheldTotal, 1);
  });

  test("CRITICAL, round 2 (defect 7, independent review, 2026-08-05): a book whose withheldForMissingBak field is GENUINELY ABSENT — both counts otherwise 0 — still refuses. An absent field must not read as a confirmed zero, the same fail-closed posture cacheAvailable/bakAvailable/historyResolver already take", () => {
    // Before this fix, `b.withheldForMissingBak ?? 0` made "the caller
    // never told us" indistinguishable from "the caller told us zero" —
    // this book would have withheld nothing, refused nothing, silently.
    const result = planApplyRefusal(true, [{ label: 'Book A', withheldForMissingCache: 0 }]);
    assert.equal(result.booksWithheldForMissingCache, 0);
    assert.equal(result.booksWithheldForMissingBak, 0);
    assert.equal(result.booksWithheldTotal, 1, 'an absent field must force this book into the refusing set, not read as clean');
    assert.equal(result.refuse, true);
    assert.match(result.withheldBookLabels[0], /bak-withheld count missing from caller/);
  });

  test('mutation control: a book with BOTH fields present and BOTH zero withholds nothing — proves the absent-field fix does not over-trigger on a genuinely clean, fully-reported book', () => {
    const result = planApplyRefusal(true, [{ label: 'Book A', withheldForMissingCache: 0, withheldForMissingBak: 0 }]);
    assert.equal(result.booksWithheldTotal, 0);
    assert.equal(result.refuse, false);
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

describe('collectBakNameEntries (#2135) — real fs fixtures, no server/dist needed', () => {
  test('zero bak files at all -> bakAvailable TRUE (the normal case) and zero entries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-bak-'));
    try {
      const result = collectBakNameEntries(dir);
      assert.deepEqual(result.entries, []);
      assert.equal(result.bakAvailable, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the directory does not exist at all -> bakAvailable FALSE (unknown, not "zero files") — readdir failure', () => {
    const dir = path.join(os.tmpdir(), 'repair-bak-does-not-exist-' + Date.now());
    const result = collectBakNameEntries(dir);
    assert.deepEqual(result.entries, []);
    assert.equal(result.bakAvailable, false);
  });

  test('one valid cast.json.bak.* -> bakAvailable TRUE, its characters collected', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-bak-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'cast.json.bak.2026-08-01'),
        JSON.stringify({ characters: [{ id: 'timkin', name: 'Timkin' }] }),
      );
      const result = collectBakNameEntries(dir);
      assert.deepEqual(result.entries, [{ id: 'timkin', name: 'Timkin' }]);
      assert.equal(result.bakAvailable, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CRITICAL (#2135): a cast.json.bak.* that exists but fails to PARSE -> bakAvailable FALSE, not silently contributing zero entries as 'clean'", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-bak-'));
    try {
      fs.writeFileSync(path.join(dir, 'cast.json.bak.corrupt'), '{ this is not valid json');
      const result = collectBakNameEntries(dir);
      assert.deepEqual(result.entries, []);
      assert.equal(result.bakAvailable, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('one corrupt bak file AND one valid bak file -> bakAvailable FALSE overall, but the valid file\'s entries are still collected', () => {
    // Book-level, not per-id: one unreadable file taints the whole book's
    // bak evidence (an unread file could have named ANY id ambiguous), but
    // this function still surfaces what it COULD read for ranking/display.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-bak-'));
    try {
      fs.writeFileSync(path.join(dir, 'cast.json.bak.1'), JSON.stringify({ characters: [{ id: 'rex', name: 'Rex' }] }));
      fs.writeFileSync(path.join(dir, 'cast.json.bak.2'), 'not json at all {{{');
      const result = collectBakNameEntries(dir);
      assert.deepEqual(result.entries, [{ id: 'rex', name: 'Rex' }]);
      assert.equal(result.bakAvailable, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('mutation control: a bak file that parses fine but has NO characters array is NOT flagged unavailable (a legitimate shape, per #2135\'s own real-workspace scan finding 0 such cases as corruption)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-bak-'));
    try {
      fs.writeFileSync(path.join(dir, 'cast.json.bak.empty'), JSON.stringify({}));
      const result = collectBakNameEntries(dir);
      assert.deepEqual(result.entries, []);
      assert.equal(result.bakAvailable, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a non-bak file in the same directory is ignored, whether or not it is valid JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-bak-'));
    try {
      fs.writeFileSync(path.join(dir, 'cast.json'), 'not valid json {{{'); // NOT a .bak file — must not affect bakAvailable
      fs.writeFileSync(path.join(dir, 'cast.json.bak.1'), JSON.stringify({ characters: [{ id: 'rex', name: 'Rex' }] }));
      const result = collectBakNameEntries(dir);
      assert.deepEqual(result.entries, [{ id: 'rex', name: 'Rex' }]);
      assert.equal(result.bakAvailable, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('CRITICAL, round 2 (defect 6, independent review, 2026-08-05): a characters field that is a STRING does not silently iterate to zero entries — flagged unavailable, not tolerated', () => {
    // Before this fix, `bak?.characters ?? []` let a string slip through:
    // strings are iterable in JS, so `for (const c of "oops")` silently
    // walks its individual characters, none of which have an `.id`/`.name`,
    // yielding zero entries and (wrongly) bakAvailable: true — the exact
    // "fail-open one level deeper" shape #2135 exists to close.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-bak-'));
    try {
      fs.writeFileSync(path.join(dir, 'cast.json.bak.1'), JSON.stringify({ characters: 'oops' }));
      const result = collectBakNameEntries(dir);
      assert.deepEqual(result.entries, []);
      assert.equal(result.bakAvailable, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('CRITICAL, round 2 (defect 6): a characters field that is a plain OBJECT does not throw — flagged unavailable instead of aborting the run', () => {
    // Before this fix, `for (const c of {...})` threw an uncaught
    // `TypeError: object is not iterable`, aborting the whole 20-book run.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-bak-'));
    try {
      fs.writeFileSync(path.join(dir, 'cast.json.bak.1'), JSON.stringify({ characters: { notAnArray: true } }));
      assert.doesNotThrow(() => collectBakNameEntries(dir));
      const result = collectBakNameEntries(dir);
      assert.deepEqual(result.entries, []);
      assert.equal(result.bakAvailable, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('one bak file with a wrong-shaped characters field AND one genuinely good bak file — the good file\'s entries still surface, bakAvailable is false overall', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-bak-'));
    try {
      fs.writeFileSync(path.join(dir, 'cast.json.bak.1'), JSON.stringify({ characters: [{ id: 'rex', name: 'Rex' }] }));
      fs.writeFileSync(path.join(dir, 'cast.json.bak.2'), JSON.stringify({ characters: 'oops' }));
      const result = collectBakNameEntries(dir);
      assert.deepEqual(result.entries, [{ id: 'rex', name: 'Rex' }]);
      assert.equal(result.bakAvailable, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('collectBooks (#2097) — real fs fixtures, no server/dist needed', () => {
  const writeBook = (booksRoot, author, series, title, { cast, state } = {}) => {
    const audiobookDir = path.join(booksRoot, author, series, title, '.audiobook');
    fs.mkdirSync(audiobookDir, { recursive: true });
    if (cast !== undefined) fs.writeFileSync(path.join(audiobookDir, 'cast.json'), typeof cast === 'string' ? cast : JSON.stringify(cast));
    if (state !== undefined) fs.writeFileSync(path.join(audiobookDir, 'state.json'), typeof state === 'string' ? state : JSON.stringify(state));
  };

  test('workspace with no books/ dir at all -> empty books, empty droppedBooks (not a crash)', () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-books-'));
    try {
      const result = collectBooks(workspaceDir);
      assert.deepEqual(result.books, []);
      assert.deepEqual(result.droppedBooks, []);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test('a well-formed book is collected, with its label built from author/series/state.title', () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-books-'));
    try {
      writeBook(path.join(workspaceDir, 'books'), 'Author', 'Series', 'title-dir', {
        cast: { characters: [{ id: 'timkin', name: 'Timkin' }] },
        state: { chapters: [{ id: 1, slug: 'one', title: 'One' }], title: 'The Real Title' },
      });
      const result = collectBooks(workspaceDir);
      assert.equal(result.books.length, 1);
      assert.equal(result.books[0].label, 'Author / Series / The Real Title');
      assert.deepEqual(result.droppedBooks, []);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("#2097: a book with NEITHER cast.json nor state.json is 'not-yet-analysed' — legitimate absence, counted and named, not vanished", () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-books-'));
    try {
      // audiobookDir exists but is otherwise empty — mid-import shape.
      fs.mkdirSync(path.join(workspaceDir, 'books', 'Author', 'Series', 'NewBook', '.audiobook'), { recursive: true });
      const result = collectBooks(workspaceDir);
      assert.deepEqual(result.books, []);
      assert.equal(result.droppedBooks.length, 1);
      assert.equal(result.droppedBooks[0].reason, 'not-yet-analysed');
      assert.match(result.droppedBooks[0].label, /Author \/ Series \/ NewBook/);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("CRITICAL (finding 1, round 3 review, 2026-08-05): a book whose state.json exists and is VALID but cast.json is genuinely missing — the exact shape import.ts writes, before analysis stage 1 first creates cast.json — is 'not-yet-analysed', not 'unreadable', and does not refuse --apply", () => {
    // Reproduces the ordinary mid-import shape byte-for-byte: import.ts
    // (server/src/routes/import.ts) writes state.json (with a real
    // `chapters` array) at import time and writes no cast.json at all;
    // cast.json is first created during analysis stage 1
    // (server/src/routes/analysis.ts). Reparse re-creates the identical
    // shape (server/src/routes/book-state.ts rm's cast.json, keeps
    // state.json). An earlier discriminator (`castExists || stateExists`,
    // cleared by round 1's own review as "sound") required BOTH files to be
    // missing before granting 'not-yet-analysed' — this exact fixture
    // classified as 'unreadable' under that logic and refused --apply for
    // the whole workspace over one freshly-imported, otherwise-healthy book.
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-books-'));
    try {
      writeBook(path.join(workspaceDir, 'books'), 'Author', 'Series', 'FreshlyImported', {
        state: { chapters: [{ id: 1, title: 'One', slug: '01-one' }], title: 'FreshlyImported' },
        // cast deliberately omitted — cast.json does not exist yet.
      });
      const result = collectBooks(workspaceDir);
      assert.deepEqual(result.books, []);
      assert.equal(result.droppedBooks.length, 1);
      assert.equal(result.droppedBooks[0].reason, 'not-yet-analysed');
      const unreadableCount = result.droppedBooks.filter((b) => b.reason === 'unreadable').length;
      assert.equal(
        shouldRefuseApplyForUnreadableBooks(true, unreadableCount),
        false,
        '--apply must not refuse over an ordinary freshly-imported book',
      );
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("finding 1 symmetry: a book whose cast.json exists and is VALID but state.json is genuinely missing is ALSO 'not-yet-analysed' — the fix is per-file, not special-cased to cast.json alone", () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-books-'));
    try {
      writeBook(path.join(workspaceDir, 'books'), 'Author', 'Series', 'StateMissing', {
        cast: { characters: [{ id: 'timkin', name: 'Timkin' }] },
        // state deliberately omitted entirely.
      });
      const result = collectBooks(workspaceDir);
      assert.deepEqual(result.books, []);
      assert.equal(result.droppedBooks.length, 1);
      assert.equal(result.droppedBooks[0].reason, 'not-yet-analysed');
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("CRITICAL (#2097): a book whose cast.json exists but fails to PARSE is 'unreadable' — evidence LOST, not absent, counted and named", () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-books-'));
    try {
      writeBook(path.join(workspaceDir, 'books'), 'Author', 'Series', 'Corrupt', {
        cast: '{ not valid json',
        state: { chapters: [{ id: 1 }] },
      });
      const result = collectBooks(workspaceDir);
      assert.deepEqual(result.books, []);
      assert.equal(result.droppedBooks.length, 1);
      assert.equal(result.droppedBooks[0].reason, 'unreadable');
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("#2097: a book whose state.json exists and parses but lacks a chapters array is 'unreadable' (present evidence that fails to validate), even though cast.json is entirely absent", () => {
    // Mixed shape: state.json present (wrong-shaped), cast.json missing —
    // "either file present" is enough to mean evidence exists and was lost,
    // not "neither file present at all" (the only legitimate-absence case).
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-books-'));
    try {
      writeBook(path.join(workspaceDir, 'books'), 'Author', 'Series', 'Mixed', {
        state: { title: 'Mixed' }, // no chapters field — wrong-shaped
      });
      const result = collectBooks(workspaceDir);
      assert.deepEqual(result.books, []);
      assert.equal(result.droppedBooks.length, 1);
      assert.equal(result.droppedBooks[0].reason, 'unreadable');
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test('a mix of one good book, one not-yet-analysed, and one unreadable book — all three are accounted for, nothing vanishes', () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-books-'));
    try {
      const booksRoot = path.join(workspaceDir, 'books');
      writeBook(booksRoot, 'Author', 'Series', 'Good', {
        cast: { characters: [{ id: 'timkin', name: 'Timkin' }] },
        state: { chapters: [{ id: 1 }], title: 'Good' },
      });
      fs.mkdirSync(path.join(booksRoot, 'Author', 'Series', 'NotYet', '.audiobook'), { recursive: true });
      writeBook(booksRoot, 'Author', 'Series', 'Broken', { cast: 'not json', state: { chapters: [] } });
      const result = collectBooks(workspaceDir);
      assert.equal(result.books.length, 1);
      assert.equal(result.droppedBooks.length, 2);
      assert.equal(result.droppedBooks.find((b) => b.label.includes('NotYet'))?.reason, 'not-yet-analysed');
      assert.equal(result.droppedBooks.find((b) => b.label.includes('Broken'))?.reason, 'unreadable');
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("CRITICAL, round 2 (defect 4, independent review, 2026-08-05): a cast.json whose 'characters' field is a truthy NON-array ({\"characters\":\"notanarray\"}) is 'unreadable', not silently kept as a valid book", () => {
    // Before this fix, `!cast?.characters` accepted ANY truthy value — this
    // book would have been KEPT, and planBookRepairs would later crash on
    // `liveCast.map(...)` over a string, aborting the whole 20-book run
    // with an unclassified stack trace instead of this one file being
    // counted and named.
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-books-'));
    try {
      writeBook(path.join(workspaceDir, 'books'), 'Author', 'Series', 'WrongShape', {
        cast: { characters: 'notanarray' },
        state: { chapters: [{ id: 1 }] },
      });
      const result = collectBooks(workspaceDir);
      assert.deepEqual(result.books, [], 'a truthy non-array characters field must not be accepted as a valid book');
      assert.equal(result.droppedBooks.length, 1);
      assert.equal(result.droppedBooks[0].reason, 'unreadable');
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test('mutation control: a cast.json whose characters field is a genuine (even empty) array is accepted — proves the Array.isArray fix does not over-reject a legitimately thin cast', () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-books-'));
    try {
      writeBook(path.join(workspaceDir, 'books'), 'Author', 'Series', 'EmptyCast', {
        cast: { characters: [] },
        state: { chapters: [{ id: 1 }], title: 'EmptyCast' },
      });
      const result = collectBooks(workspaceDir);
      assert.equal(result.books.length, 1);
      assert.deepEqual(result.droppedBooks, []);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test('CRITICAL, round 2 (defect 5, independent review, 2026-08-05): an unreadable books/ root (readdir throws — simulated by making the path a FILE, not a directory) is counted and named, not thrown out of main() uncaught', () => {
    // Portable, reliable repro of the "readdirSync throws" shape (ENOTDIR)
    // without relying on OS-specific permission bits (chmod is a no-op for
    // directories on Windows, where this box runs). The `dirs()` helper is
    // the SAME function reused at all three walk levels (author/series/
    // title), so this one repro proves the try/catch mechanism for the
    // books/ root call site. The author- and series-level call sites are
    // independently pinned by the two `node:test` mock-based tests directly
    // below this one (finding 3, round 3 review) — a real directory can't
    // portably be made to throw ENOTDIR/EACCES on this box while its parent
    // listing still reports it as a directory, so those two mock
    // `fs.readdirSync` for one specific path instead of relying on OS state.
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-books-'));
    try {
      // 'books' exists but is a FILE — fs.existsSync passes, but
      // readdirSync on it throws ENOTDIR, exactly like a permission
      // failure would (a different errno, same "can't enumerate" shape).
      fs.writeFileSync(path.join(workspaceDir, 'books'), 'not a directory');
      assert.doesNotThrow(() => collectBooks(workspaceDir));
      const result = collectBooks(workspaceDir);
      assert.deepEqual(result.books, []);
      assert.equal(result.droppedBooks.length, 1);
      assert.equal(result.droppedBooks[0].reason, 'unreadable');
      assert.match(result.droppedBooks[0].label, /unreadable directory/);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test('finding 3 (round 3 review, 2026-08-05): an unreadable AUTHOR-level directory is counted and named, not thrown out of main() uncaught, and its sibling author is still scanned', (t) => {
    // Round 2 review's own defect-5 fix guarded all three `dirs()` call
    // sites with the same try/catch, but the only pinned repro was the
    // books/ root — the author- and series-level branches (collectBooks
    // ~:1500-1511) could regress to a bare, unguarded readdirSync (or have
    // their `if (… === null)` check silently dropped to `?? []`, which
    // reddens ZERO tests without this one — see this file's module doc
    // comment) with the suite staying green. `fs.readdirSync` is mocked for
    // exactly the poisoned author path; every other call (including the
    // books/ root listing and the good author's own walk) goes through the
    // real implementation, so this is a targeted fault injection, not a
    // blanket fs stub.
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-books-'));
    try {
      const booksRoot = path.join(workspaceDir, 'books');
      writeBook(booksRoot, 'GoodAuthor', 'Series', 'Title', {
        cast: { characters: [{ id: 'timkin', name: 'Timkin' }] },
        state: { chapters: [{ id: 1 }], title: 'Title' },
      });
      const poisonedPath = path.resolve(path.join(booksRoot, 'BadAuthor'));
      fs.mkdirSync(poisonedPath, { recursive: true });
      const realReaddirSync = fs.readdirSync;
      t.mock.method(fs, 'readdirSync', (p, opts) => {
        if (path.resolve(String(p)) === poisonedPath) {
          throw Object.assign(new Error('simulated EACCES'), { code: 'EACCES' });
        }
        return realReaddirSync(p, opts);
      });
      assert.doesNotThrow(() => collectBooks(workspaceDir));
      const result = collectBooks(workspaceDir);
      assert.equal(result.books.length, 1, 'GoodAuthor must still be scanned despite BadAuthor throwing');
      assert.match(result.books[0].label, /GoodAuthor/);
      assert.equal(result.droppedBooks.length, 1);
      assert.equal(result.droppedBooks[0].reason, 'unreadable');
      assert.match(result.droppedBooks[0].label, /BadAuthor \(unreadable directory\)/);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test('finding 3 (round 3 review, 2026-08-05): an unreadable SERIES-level directory is counted and named, not thrown out of main() uncaught, and its sibling series is still scanned', (t) => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-books-'));
    try {
      const booksRoot = path.join(workspaceDir, 'books');
      writeBook(booksRoot, 'Author', 'GoodSeries', 'Title', {
        cast: { characters: [{ id: 'timkin', name: 'Timkin' }] },
        state: { chapters: [{ id: 1 }], title: 'Title' },
      });
      const poisonedPath = path.resolve(path.join(booksRoot, 'Author', 'BadSeries'));
      fs.mkdirSync(poisonedPath, { recursive: true });
      const realReaddirSync = fs.readdirSync;
      t.mock.method(fs, 'readdirSync', (p, opts) => {
        if (path.resolve(String(p)) === poisonedPath) {
          throw Object.assign(new Error('simulated EACCES'), { code: 'EACCES' });
        }
        return realReaddirSync(p, opts);
      });
      assert.doesNotThrow(() => collectBooks(workspaceDir));
      const result = collectBooks(workspaceDir);
      assert.equal(result.books.length, 1, 'GoodSeries must still be scanned despite BadSeries throwing');
      assert.match(result.books[0].label, /GoodSeries/);
      assert.equal(result.droppedBooks.length, 1);
      assert.equal(result.droppedBooks[0].reason, 'unreadable');
      assert.match(result.droppedBooks[0].label, /Author \/ BadSeries \(unreadable directory\)/);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("defect 10 (round 2 review, suspected — fixed defensively, not reproduced on this box): a book whose cast.json exists but fails to PARSE alongside a genuinely-missing state.json is 'unreadable', not 'not-yet-analysed'", () => {
    // A book present-but-corrupt on one side (a parse failure) must still
    // classify as evidence loss even when the other file is genuinely
    // absent. NOTE: this exercises readJsonTriState's JSON.parse-failure
    // catch (line ~1415-1419), which round 1's plain `readJsonSync` +
    // `existsSync` already handled identically — it does NOT distinguish
    // readJsonTriState's 'missing' (ENOENT) vs 'unreadable' (any other
    // readFileSync error, e.g. EACCES) split; the test directly below this
    // one does that (finding 2, round 3 review).
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-books-'));
    try {
      writeBook(path.join(workspaceDir, 'books'), 'Author', 'Series', 'HalfMissing', {
        cast: '{ not valid json',
        // state deliberately omitted entirely
      });
      const result = collectBooks(workspaceDir);
      assert.deepEqual(result.books, []);
      assert.equal(result.droppedBooks.length, 1);
      assert.equal(result.droppedBooks[0].reason, 'unreadable');
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("finding 2 (round 3 review, 2026-08-05): a book whose cast.json is a DIRECTORY (not a file) is 'unreadable' — a portable repro of readFileSync failing with something OTHER than ENOENT and OTHER than a JSON.parse failure, genuinely distinguishing readJsonTriState's 'missing' branch from its 'unreadable' branch", () => {
    // Unlike the parse-failure test above (cast.json IS a real file, its
    // bytes just aren't valid JSON — readFileSync succeeds, only
    // JSON.parse fails), this fixture never reaches JSON.parse at all:
    // fs.readFileSync throws EISDIR on a directory, the same "present but
    // unreadable" shape an EACCES permission failure takes (an error whose
    // `code` is neither ENOENT nor a parse SyntaxError). Mutation-verified:
    // collapsing readJsonTriState's read-error catch to unconditionally
    // `return { status: 'missing' }` (deleting the ENOENT-vs-everything-else
    // split this function exists for) turns this book's reason from
    // 'unreadable' into 'not-yet-analysed' — this assertion catches that.
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-books-'));
    try {
      const audiobookDir = path.join(workspaceDir, 'books', 'Author', 'Series', 'CastIsADir', '.audiobook');
      // cast.json is itself a DIRECTORY, not a file.
      fs.mkdirSync(path.join(audiobookDir, 'cast.json'), { recursive: true });
      fs.writeFileSync(path.join(audiobookDir, 'state.json'), JSON.stringify({ chapters: [{ id: 1 }] }));
      const result = collectBooks(workspaceDir);
      assert.deepEqual(result.books, []);
      assert.equal(result.droppedBooks.length, 1);
      assert.equal(result.droppedBooks[0].reason, 'unreadable');
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});

describe('shouldRefuseApplyForUnreadableBooks (#2097)', () => {
  test('dry run never refuses, whatever the unreadable count', () => {
    assert.equal(shouldRefuseApplyForUnreadableBooks(false, 0), false);
    assert.equal(shouldRefuseApplyForUnreadableBooks(false, 3), false);
  });

  test('--apply with zero unreadable books does not refuse', () => {
    assert.equal(shouldRefuseApplyForUnreadableBooks(true, 0), false);
  });

  test('CRITICAL: --apply with even ONE unreadable book refuses — unconditional, unlike the withheld-evidence refusals', () => {
    assert.equal(shouldRefuseApplyForUnreadableBooks(true, 1), true);
    assert.equal(shouldRefuseApplyForUnreadableBooks(true, 5), true);
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
    const { orphans } = buildOrphansFromSegments(segs, resolver, {}, fakeIsAudioCurrent);
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
    const { orphans } = buildOrphansFromSegments(segs, resolver, {}, fakeIsAudioCurrent);
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
    const { orphans } = buildOrphansFromSegments(segs, resolver, {}, fakeIsAudioCurrent);
    assert.equal(orphans.get('drifted')?.segments, 2);
  });

  test("an id resolving via 'normalised-history' is an orphan (unchanged from the #2107 fix's first round)", () => {
    const resolver = { resolve: (id) => (id === 'old-alias' ? { character: { id: 'live' }, via: 'normalised-history' } : undefined) };
    const segs = [seg(1, 'One', [{ characterId: 'old-alias' }, { characterId: 'old-alias' }, { characterId: 'old-alias' }])];
    const { orphans } = buildOrphansFromSegments(segs, resolver, {}, fakeIsAudioCurrent);
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
    const { orphans } = buildOrphansFromSegments(segs, resolver, {}, fakeIsAudioCurrent);
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
    const run1 = buildOrphansFromSegments(mayrinSegs, run1Resolver, {}, fakeIsAudioCurrent);
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
    const run2 = buildOrphansFromSegments(mayrinSegs, run2Resolver, {}, fakeIsAudioCurrent);
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
    const { orphans } = buildOrphansFromSegments(segs, resolver, {}, fakeIsAudioCurrent);
    assert.equal(orphans.size, 0);
  });
});

describe('#2128 — a re-rendered chapter drops off the repair list', () => {
  test('drops an alias id whose every chapter was re-rendered above its marker', () => {
    // The issue's own acceptance criterion, post-dating half: a render whose
    // castHistorySeq stamp is AT/ABOVE the marker recordedAtSeq set for the
    // alias it resolves through reads current and clears the row.
    const history = { schema: 1, supersededBy: { mayrin: 'mairin' }, seq: 5, recordedAtSeq: { mayrin: 3 } };
    const segs = [{ chapterId: 1, castHistorySeq: 5, segments: [{ characterId: 'mayrin' }] }];
    const { orphans } = buildOrphansFromSegments(segs, resolverFor(history), history, fakeIsAudioCurrent);
    assert.equal(orphans.has('mayrin'), false);
  });

  test('KEEPS an id whose chapter was not re-rendered', () => {
    // The acceptance criterion's pre-dating half: a render stamp BELOW the
    // marker is stale and stays listed.
    const history = { schema: 1, supersededBy: { mayrin: 'mairin' }, seq: 5, recordedAtSeq: { mayrin: 3 } };
    const segs = [{ chapterId: 1, castHistorySeq: 1, segments: [{ characterId: 'mayrin' }] }];
    const { orphans } = buildOrphansFromSegments(segs, resolverFor(history), history, fakeIsAudioCurrent);
    assert.equal(orphans.get('mayrin').segments, 1);
  });

  test("KEEPS every id in a book whose history has no recordedAtSeq field", () => {
    const history = { schema: 1, supersededBy: { mayrin: 'mairin' }, seq: 99 };
    const segs = [{ chapterId: 1, castHistorySeq: 99, segments: [{ characterId: 'mayrin' }] }];
    const { orphans } = buildOrphansFromSegments(segs, resolverFor(history), history, fakeIsAudioCurrent);
    assert.equal(orphans.has('mayrin'), true); // 'unknown' LISTS
  });

  test("KEEPS an id when the file counter is below a render's stamp", () => {
    const history = { schema: 1, supersededBy: { mayrin: 'mairin' }, seq: 2, recordedAtSeq: { mayrin: 1 } };
    const segs = [{ chapterId: 1, castHistorySeq: 99, segments: [{ characterId: 'mayrin' }] }];
    const { orphans } = buildOrphansFromSegments(segs, resolverFor(history), history, fakeIsAudioCurrent);
    assert.equal(orphans.has('mayrin'), true);
  });

  test('KEEPS an id when the history object has recordedAtSeq but no seq', () => {
    // Round 1 (C1) — the fail-open shape, pinned on the consumer side too.
    const history = { schema: 1, supersededBy: { mayrin: 'mairin' }, recordedAtSeq: { mayrin: 1 } };
    const segs = [{ chapterId: 1, castHistorySeq: 9, segments: [{ characterId: 'mayrin' }] }];
    const { orphans } = buildOrphansFromSegments(segs, resolverFor(history), history, fakeIsAudioCurrent);
    assert.equal(orphans.has('mayrin'), true);
  });

  test('reports a current non-exact id as such, not as never-rendered', () => {
    // A 'normalised-id'-tier id, re-rendered: skips `orphans`, but it DID render.
    const history = { schema: 1, supersededBy: {}, seq: 1, recordedAtSeq: {} };
    const segs = [{ chapterId: 1, castHistorySeq: 1, segments: [{ characterId: 'The_Torment' }] }];
    const { orphans, currentNonExact } = buildOrphansFromSegments(
      segs, resolverFor(history, [{ id: 'the-torment' }]), history, fakeIsAudioCurrent,
    );
    assert.equal(orphans.has('The_Torment'), false);
    assert.equal(currentNonExact.has('The_Torment'), true);
  });

  test('orphans membership WINS over currentNonExact across chapters', () => {
    // Current in ch1, stale in ch2 (no castHistorySeq at all on that
    // chapter's segments file -> isAudioCurrent reads 'unknown' before it
    // even looks at `via`). Without the subtraction at the end of
    // buildOrphansFromSegments the id lands in BOTH, and planBookRepairs
    // then reads the wrong one — the "any-current => clean" direction that
    // re-opens #2107.
    const history = { schema: 1, supersededBy: {}, seq: 4, recordedAtSeq: {} };
    const segs = [
      { chapterId: 1, castHistorySeq: 4, segments: [{ characterId: 'The_Torment' }] },
      { chapterId: 2, segments: [{ characterId: 'The_Torment' }] }, // no stamp -> 'unknown'
    ];
    const { orphans, currentNonExact } = buildOrphansFromSegments(
      segs, resolverFor(history, [{ id: 'the-torment' }]), history, fakeIsAudioCurrent,
    );
    assert.equal(orphans.has('The_Torment'), true);
    assert.equal(currentNonExact.has('The_Torment'), false);
  });
});

describe('stampScannedBooks (#2128 — the --apply one-shot recordedAtSeq back-fill main() calls for every scanned book)', () => {
  // Deliberately does NOT invoke main()/`--apply` itself: this file's test
  // architecture (see the module doc comment and the "Ie" note further
  // down, near probePortRangeRefused) already establishes that main()'s own
  // wiring is exercised only by the live dry run against the real
  // workspace, never by a subprocess in this suite — this repair pass is
  // under an explicit instruction to never invoke --apply from its own
  // test file, and this CI job (test:hooks) never builds server/dist, which
  // main() needs. stampScannedBooks is pulled out of main() specifically so
  // the one-shot-stamp WIRING (call it for every scanned dir, count how many
  // actually wrote, AND never touch disk on a dry run) has direct coverage
  // without either constraint — the same pattern every other main()-adjacent
  // decision in this file already uses (shouldRefuseApplyForEmptyScan,
  // planApplyRefusal, etc.).
  test('apply=true calls stampRecordedAtSeqIfAbsent for every scanned book dir and counts how many actually wrote', async () => {
    const calls = [];
    const stampFn = async (bookDir) => {
      calls.push(bookDir);
      return bookDir !== '/book-2'; // pretend book-2's history already had the field
    };
    const stamped = await stampScannedBooks(true, ['/book-1', '/book-2', '/book-3'], stampFn);
    assert.deepEqual(calls, ['/book-1', '/book-2', '/book-3']);
    assert.equal(stamped, 2);
  });

  test('apply=true with an empty scan stamps nothing and calls nothing', async () => {
    let calls = 0;
    const stamped = await stampScannedBooks(true, [], async () => {
      calls += 1;
      return true;
    });
    assert.equal(stamped, 0);
    assert.equal(calls, 0);
  });

  test('#2128 (review round 1, I2) — apply=false is a genuine dry run: stampRecordedAtSeqIfAbsent is never called, whatever the scan found', async () => {
    // The safety-critical direction: main()'s prior shape wrapped this call
    // in an `if (apply)` block that nothing in this suite asserted either
    // side of. Folding the gate INTO this function (rather than leaving it
    // as an untested wrapper around the call) means this test can assert
    // the dry-run half directly — a real book dir list, a stamp function
    // that would fail the test if invoked at all.
    let calls = 0;
    const stampFn = async () => {
      calls += 1;
      return true;
    };
    const stamped = await stampScannedBooks(false, ['/book-1', '/book-2'], stampFn);
    assert.equal(calls, 0);
    assert.equal(stamped, 0);
  });

  test('F3 (PR #2244 review gate) — a write failure on one book (e.g. an AV-scanner EPERM) does not abort the rest of the run', async () => {
    // stampRecordedAtSeqIfAbsent's own READ failures are already caught and
    // warned (cast-id-history.ts:1211-1217) — but its writeJsonAtomic call
    // is NOT, so an unguarded per-book loop here propagates that throw
    // straight to main()'s top-level .catch, and every book after the
    // failing one silently never gets stamped, with no
    // "stamped ... (#2128 one-shot)" line and a bare stack trace instead.
    const calls = [];
    const stampFn = async (bookDir) => {
      calls.push(bookDir);
      if (bookDir === '/book-2') throw new Error('EPERM: operation not permitted, open cast-id-history.json');
      return true;
    };
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    let stamped;
    try {
      stamped = await stampScannedBooks(true, ['/book-1', '/book-2', '/book-3'], stampFn);
    } finally {
      console.warn = originalWarn;
    }
    // Every book is still attempted — book-3 is not skipped just because
    // book-2 threw.
    assert.deepEqual(calls, ['/book-1', '/book-2', '/book-3']);
    // book-1 and book-3 stamped successfully; book-2's failure does not
    // count, but also does not stop the count for the others.
    assert.equal(stamped, 2);
    // The failure is surfaced, not silently swallowed.
    assert.ok(
      warnings.some((w) => w.includes('/book-2') && w.includes('EPERM')),
      `expected a warning naming the failing book and the error; got: ${JSON.stringify(warnings)}`,
    );
  });
});

describe('collectSegmentOrphans (#2092/#2089 Task 9 — threads the loaded history object, not a hand-built subset)', () => {
  // Guards exactly the trap the task 9 brief named: a hand-built
  // `{ supersededBy, rejected }` object silently drops `rejectedPairs`, so
  // this resolver would disagree with the real render-time resolver (which
  // DOES see rejected pairs) about whether a pair-rejected id counts as an
  // orphan. Asserted by capturing what `collectSegmentOrphans` actually
  // hands to `buildCastResolver`, since a mutation reintroducing the old
  // `{ supersededBy: history.supersededBy ?? {}, rejected: history.rejected ?? [] }`
  // subset would make this go red (no `rejectedPairs` key reaches the fake).
  test('passes the whole history object — including rejectedPairs — to buildCastResolver, not a stripped subset', async () => {
    let receivedHistory;
    const mods = {
      buildCastResolver(cast, history) {
        receivedHistory = history;
        return { resolve: () => undefined };
      },
      async loadSegmentsFiles() {
        return [];
      },
    };
    const history = {
      schema: 1,
      supersededBy: { a: 'b' },
      rejected: ['legacy-id'],
      rejectedPairs: [{ from: 'mayrin', to: 'mairin' }],
    };
    await collectSegmentOrphans('/book', [], { characters: [] }, history, mods);
    assert.equal(receivedHistory, history); // the SAME object, not a rebuilt copy
    assert.deepEqual(receivedHistory.rejectedPairs, [{ from: 'mayrin', to: 'mairin' }]);
  });

  test('a segment whose id is pair-rejected against its only resolvable target is reported as an orphan, not silently reconciled', async () => {
    // Simulates the real buildCastResolver's D2 rule (cast-resolve.ts): a
    // rejected pair returns undefined instead of resolving. Review round 3
    // (#2092/#2089) update: `collectSegmentOrphans` no longer returns a
    // separate `autoReconciled` bucket at all — #2107's independent-review
    // widening (landed on origin/main, merged into this branch) folded that
    // concept away, since only the `'exact'` tier means the rendered bytes
    // are fine (see `buildOrphansFromSegments`'s own doc comment). The fake
    // resolver below reports `'exact'` on the NOT-rejected branch instead of
    // the original `'normalised-history'` so this test still discriminates
    // under the widened rule: if `collectSegmentOrphans` dropped
    // `rejectedPairs` (the bug this test guards), the fake would take the
    // not-rejected branch and report `'exact'`, which the widened
    // `buildOrphansFromSegments` treats as NOT an orphan — this assertion
    // would then fail. The real production resolver honours `rejectedPairs`,
    // so this pins the contract `collectSegmentOrphans` must uphold: pass
    // history through whole, so whatever the real resolver decides is what
    // gets counted.
    const mods = {
      buildCastResolver(cast, history) {
        return {
          resolve(id) {
            if (id !== 'mayrin') return undefined;
            const rejected = (history.rejectedPairs ?? []).some((p) => p.from === 'mayrin' && p.to === 'mairin');
            if (rejected) return undefined; // D2: pair-rejected, no fall-through
            return { character: { id: 'mairin' }, via: 'exact' };
          },
        };
      },
      async loadSegmentsFiles() {
        return [{ chapterId: 1, chapterTitle: 'One', segments: [{ characterId: 'mayrin', startSec: 0, endSec: 1 }] }];
      },
      // #2128 — collectSegmentOrphans now threads mods.isAudioCurrent
      // through to buildOrphansFromSegments; this fake mirrors the
      // pre-#2128 "only 'exact' is fine" contract this test exists to pin
      // (see fakeIsAudioCurrent's own doc comment above for why this file
      // hand-rolls a stand-in rather than importing the real predicate).
      isAudioCurrent: fakeIsAudioCurrent,
    };
    const history = { schema: 1, supersededBy: {}, rejectedPairs: [{ from: 'mayrin', to: 'mairin' }] };
    const { orphans } = await collectSegmentOrphans('/book', [], { characters: [] }, history, mods);
    assert.equal(orphans.get('mayrin')?.segments, 1);
  });
});

// #2130: the "drive buildOrphansFromSegments against the REAL
// buildCastResolver, not a hand-written fake" coverage used to live here,
// gated behind a runtime `fs.existsSync(server/dist/...)` skip. Round 2
// review found that gate meant it never actually ran in CI: `test:hooks`
// executes in `lint-and-checks`, which never builds the server, AND that
// step's own `if:` only fires on `hooks`/`scripts`/`shared` scope — a PR
// that renames a tier touches only `server/src/`, so the step doesn't even
// run. Relocated to `server/src/store/cast-resolve.repair-pass-contract.
// test.ts`, which needs no server/dist build (vitest transpiles
// cast-resolve.ts from source) and lives under a path the CI scope
// detector already matches on any server/src change — see that file's own
// doc comment for the full account and the rename-and-revert proof.

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

describe("formatNotYetAnalysedLine (round 4 review, 2026-08-05) — pins the operator-facing label so it can't silently drift back to describing the OLD bucket", () => {
  test('prints the count and does NOT claim BOTH files are missing — the old text ("no cast.json or state.json at all") described a bucket this fix widened past', () => {
    const line = formatNotYetAnalysedLine(3);
    assert.match(line, /: 3$/);
    assert.doesNotMatch(
      line,
      /no cast\.json or state\.json at all/,
      'the label must not claim BOTH files are missing — a book with a perfectly good state.json (or cast.json) can land in this bucket too',
    );
  });

  test('names cast.json AND state.json, "per file", and calls out that a present-but-unreadable file is counted elsewhere', () => {
    const line = formatNotYetAnalysedLine(1);
    assert.match(line, /cast\.json/);
    assert.match(line, /state\.json/);
    assert.match(line, /per\s+file/i);
    assert.match(line, /PRESENT but unreadable/);
  });

  test('a zero count still renders (defensive — main() only calls this when notYetAnalysedBooks.length is truthy, but the formatter itself makes no such assumption)', () => {
    assert.match(formatNotYetAnalysedLine(0), /: 0$/);
  });
});
