// Unit tests for the pure diff helpers in scripts/diff-analysis-ab.mjs.
// Runs under plain `node --test` (npm run test:hooks) — so the helpers must
// stay free of any top-level TS import. We pin roster-diff + agreement-rate on
// two tiny in-memory snapshots, no live analyzer / GPU / API key needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  diffRosters,
  speakerAgreement,
  emotionAgreement,
  normEmotion,
  quoteCount,
  newlyNarrator,
  classifySnapshotFile,
} from '../diff-analysis-ab.mjs';

test('diffRosters: identical rosters report no changes', () => {
  const chars = [
    { id: 'narrator', name: 'Narrator' },
    { id: 'wren', name: 'Wren', aliases: ['Foster'] },
  ];
  const d = diffRosters(chars, structuredClone(chars));
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.renamed, []);
  assert.deepEqual(d.fieldDeltas, []);
  assert.equal(d.baseCount, 2);
  assert.equal(d.candCount, 2);
});

test('diffRosters: detects add / remove / rename / field deltas', () => {
  const base = [
    { id: 'narrator', name: 'Narrator' },
    { id: 'wren', name: 'Wren', aliases: ['Foster'] },
    { id: 'marlow', name: 'Marlow' },
  ];
  const cand = [
    { id: 'narrator', name: 'Narrator' },
    { id: 'wren', name: 'Wren Sparrow', aliases: ['Foster', 'Wren E. Foster'] },
    { id: 'hart', name: 'Hart' },
  ];
  const d = diffRosters(base, cand);
  assert.deepEqual(d.added, ['hart']);
  assert.deepEqual(d.removed, ['marlow']);
  assert.deepEqual(d.renamed, [{ id: 'wren', from: 'Wren', to: 'Wren Sparrow' }]);
  assert.ok(d.fieldDeltas.some((x) => x.id === 'wren' && x.field === 'aliases'));
});

test('diffRosters: alias order does not count as a delta', () => {
  const base = [{ id: 'a', name: 'A', aliases: ['x', 'y'] }];
  const cand = [{ id: 'a', name: 'A', aliases: ['y', 'x'] }];
  const d = diffRosters(base, cand);
  assert.deepEqual(d.fieldDeltas, []);
});

test('speakerAgreement: position-aligned within a chapter, rollup + per-chapter', () => {
  const base = [
    { id: 1, chapterId: 1, characterId: 'narrator' },
    { id: 2, chapterId: 1, characterId: 'wren' },
    { id: 3, chapterId: 2, characterId: 'marlow' },
  ];
  const cand = [
    { id: 1, chapterId: 1, characterId: 'narrator' },
    { id: 2, chapterId: 1, characterId: 'marlow' }, // disagree
    { id: 3, chapterId: 2, characterId: 'marlow' },
  ];
  const a = speakerAgreement(base, cand);
  assert.equal(a.total, 3);
  assert.equal(a.agreed, 2);
  assert.ok(Math.abs(a.rate - 2 / 3) < 1e-9);
  assert.equal(a.perChapter[1].rate, 0.5);
  assert.equal(a.perChapter[2].rate, 1);
});

test('speakerAgreement: aligns by ordinal up to the shorter chapter side', () => {
  const base = [
    { id: 1, chapterId: 1, characterId: 'narrator' },
    { id: 2, chapterId: 1, characterId: 'wren' },
  ];
  const cand = [{ id: 1, chapterId: 1, characterId: 'narrator' }];
  const a = speakerAgreement(base, cand);
  assert.equal(a.total, 1); // only the overlapping position is compared
  assert.equal(a.rate, 1);
});

test('emotionAgreement: absent emotion equals neutral', () => {
  assert.equal(normEmotion(undefined), 'neutral');
  assert.equal(normEmotion(null), 'neutral');
  assert.equal(normEmotion('angry'), 'angry');
  const base = [{ id: 1, chapterId: 1, characterId: 'x' }]; // no emotion
  const cand = [{ id: 1, chapterId: 1, characterId: 'x', emotion: 'neutral' }];
  assert.equal(emotionAgreement(base, cand).rate, 1);
});

test('newlyNarrator: counts speech collapsed onto the narrator', () => {
  const base = [
    { id: 1, chapterId: 1, characterId: 'wren' },
    { id: 2, chapterId: 1, characterId: 'narrator' },
  ];
  const cand = [
    { id: 1, chapterId: 1, characterId: 'narrator' }, // collapsed
    { id: 2, chapterId: 1, characterId: 'narrator' },
  ];
  assert.equal(newlyNarrator(base, cand), 1);
});

test('quoteCount: sums evidence quotes across the roster', () => {
  const chars = [
    { id: 'a', evidence: [{ quote: 'q1' }, { quote: 'q2' }] },
    { id: 'b', evidence: [{ quote: 'q3' }] },
    { id: 'c' },
  ];
  assert.equal(quoteCount(chars), 3);
});

test('classifySnapshotFile: routes filenames to the right schema', () => {
  assert.deepEqual(classifySnapshotFile('cast.json'), { role: 'cast', schema: 'cast' });
  assert.deepEqual(classifySnapshotFile('mns_x-stage1-ch12.json'), {
    role: 'stage1',
    schema: 'stage1ChapterSchema',
  });
  assert.deepEqual(classifySnapshotFile('mns_x-stage2-ch3.json'), {
    role: 'stage2',
    schema: 'stage2ChapterSchema',
  });
  assert.equal(classifySnapshotFile('readme.txt'), null);
});
