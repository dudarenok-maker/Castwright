// Unit tests for scripts/repair-cast-id-drift.mjs's pure helpers (#2040 Wave
// 3 Task 18). Imports ONLY this script's own exports — never `server/dist` —
// so these tests run under `npm run test:hooks` with no build step, even
// though the script's own `main()` needs one (see the script's module doc
// comment). Run directly: `node --test scripts/tests/repair-cast-id-drift.test.mjs`.

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
// decisions (ambiguity handling, tier precedence, the snapshot-consistency
// downgrade); production always wires in the real ones (see main()).
const lc = (s) => String(s).trim().toLowerCase();
const idKey = (s) => String(s).toLowerCase().replace(/[-_\s]+/g, '-');

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

  test('empty candidate -> undefined', () => {
    assert.equal(resolveTierAName('', liveCast, lc), undefined);
    assert.equal(resolveTierAName(undefined, liveCast, lc), undefined);
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
  const liveCast = [{ id: 'the_torment', name: 'The Torment' }];

  test('encoding-equivalent id matches', () => {
    assert.equal(resolveTierBId('the-torment', liveCast, idKey), 'the_torment');
  });

  test('a genuinely different id does not match', () => {
    assert.equal(resolveTierBId('pool-player-2', liveCast, idKey), undefined);
  });

  test('tie on the live side -> undefined', () => {
    const tied = [
      { id: 'foo-bar', name: 'A' },
      { id: 'foo_bar', name: 'B' },
    ];
    assert.equal(resolveTierBId('foo bar', tied, idKey), undefined);
  });
});

describe('snapshotsConsistent', () => {
  test('vacuously true for zero or one snapshot', () => {
    assert.equal(snapshotsConsistent([]), true);
    assert.equal(snapshotsConsistent([{ gender: 'male' }]), true);
    assert.equal(snapshotsConsistent([undefined]), true);
  });

  test('true when every defined field agrees across chapters (Exile unknown-male shape)', () => {
    const snap = { gender: 'male', ageRange: 'adult', voiceEngine: 'kokoro' };
    assert.equal(snapshotsConsistent([snap, { ...snap }, { ...snap }]), true);
  });

  test('false on a gender conflict', () => {
    assert.equal(
      snapshotsConsistent([{ gender: 'male' }, { gender: 'female' }]),
      false,
    );
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
    assert.equal(
      snapshotsConsistent([{ gender: 'male' }, { gender: 'male', ageRange: 'adult' }]),
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

  test('respects topN', () => {
    const ranked = rankSnapshotCandidates({ gender: 'male' }, liveCast, reserved, 1);
    assert.equal(ranked.length, 1);
  });
});

describe('planBookRepairs', () => {
  const deps = { normaliseForMatch: lc, normaliseIdKey: idKey, reservedIds: new Set(['narrator', 'unknown-male', 'unknown-female']) };
  const liveCast = [
    { id: 'narrator', name: 'Narrator' },
    { id: 'mairin', name: 'Мэйрин' },
    { id: 'timkin', name: 'Timkin', gender: 'male', ageRange: 'adult' },
  ];

  test('Tier A auto-record via an unambiguous cache name', () => {
    const cacheNameIndex = buildNameIndex([{ id: 'mayrin', name: 'Мэйрин' }], lc);
    const plan = planBookRepairs(
      { liveCast, history: {}, cacheNameIndex, bakNameIndex: new Map(), orphans: new Map() },
      deps,
    );
    assert.equal(plan.autoRecord.length, 1);
    assert.equal(plan.autoRecord[0].id, 'mayrin');
    assert.equal(plan.autoRecord[0].to, 'mairin');
    assert.equal(plan.autoRecord[0].tier, 'A');
    assert.equal(plan.reportOnly.length, 0);
  });

  test('bak-file name is preferred over a DIFFERENT cache name', () => {
    const cacheNameIndex = buildNameIndex([{ id: 'unknown-male', name: 'Someone Else' }], lc);
    const bakNameIndex = buildNameIndex([{ id: 'unknown-male', name: 'Timkin' }], lc);
    // target must not be reserved for the auto-record path to fire — use a
    // liveCast that has a plain 'timkin' row (already present above).
    const plan = planBookRepairs(
      { liveCast, history: {}, cacheNameIndex, bakNameIndex, orphans: new Map() },
      deps,
    );
    assert.equal(plan.autoRecord.length, 1);
    assert.equal(plan.autoRecord[0].to, 'timkin');
    assert.match(plan.autoRecord[0].evidence, /cast\.json\.bak/);
  });

  test('an id the cache names differently across chapters is ambiguous -> reported, not auto-recorded', () => {
    const cacheNameIndex = buildNameIndex(
      [
        { id: 'unknown-male', name: 'Timkin' },
        { id: 'unknown-male', name: 'Rex' },
      ],
      lc,
    );
    const plan = planBookRepairs(
      { liveCast, history: {}, cacheNameIndex, bakNameIndex: new Map(), orphans: new Map() },
      deps,
    );
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.reportOnly.length, 1);
    assert.match(plan.reportOnly[0].reason, /different things/);
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

  test('inconsistent characterSnapshots across chapters downgrade a name match to report-only', () => {
    const bakNameIndex = buildNameIndex([{ id: 'unknown-male', name: 'Timkin' }], lc);
    const orphans = new Map([
      [
        'unknown-male',
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
      { liveCast, history: {}, cacheNameIndex: new Map(), bakNameIndex, orphans },
      deps,
    );
    assert.equal(plan.autoRecord.length, 0);
    assert.equal(plan.reportOnly.length, 1);
    assert.match(plan.reportOnly[0].reason, /disagree across chapters/);
  });

  test('consistent characterSnapshots across chapters DO auto-record (the real Exile shape)', () => {
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
    const plan = planBookRepairs(
      { liveCast, history: {}, cacheNameIndex: new Map(), bakNameIndex, orphans },
      deps,
    );
    assert.equal(plan.autoRecord.length, 1);
    assert.equal(plan.autoRecord[0].to, 'timkin');
    assert.equal(plan.autoRecord[0].segments, 21);
  });

  test('a Tier A match onto a reserved id is refused (falls through, not auto-recorded)', () => {
    const cacheNameIndex = buildNameIndex([{ id: 'weird-alias', name: 'Narrator' }], lc);
    const plan = planBookRepairs(
      { liveCast, history: {}, cacheNameIndex, bakNameIndex: new Map(), orphans: new Map() },
      deps,
    );
    assert.equal(plan.autoRecord.length, 0);
    assert.ok(!plan.autoRecord.some((a) => a.to === 'narrator'));
  });

  test('Tier B (id-shape) auto-records a cache-only orphan with no name signal', () => {
    // 'TIMKIN' normalises (case-fold) to the same key as live 'timkin' — no
    // name index entries at all, purely an id-shape match.
    const plan = planBookRepairs(
      { liveCast, history: {}, cacheNameIndex: new Map(), bakNameIndex: new Map(), orphans: new Map([['TIMKIN', { segments: 0, chapters: [], snapshots: [] }]]) },
      deps,
    );
    assert.equal(plan.autoRecord.length, 1);
    assert.equal(plan.autoRecord[0].tier, 'B');
    assert.equal(plan.autoRecord[0].to, 'timkin');
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
    const plan = planBookRepairs(
      { liveCast, history: {}, cacheNameIndex: new Map(), bakNameIndex: new Map(), orphans },
      deps,
    );
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
