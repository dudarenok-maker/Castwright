import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLUMNS,
  buildRow,
  sortRowsByShareDescending,
  worstChapter,
  formatShare,
  formatStateCell,
} from '../measure-attribution.mjs';

/* #1984 Wave 1 Task 8. Pure helpers only — no server/dist build needed.
   The io-level plumbing (resolveAttributionState, attributionShare) is
   Task 7's own, unit tested in server/src/store/attribution-health-io.test.ts;
   this file only pins the script's own formatting/sorting/row-shaping
   logic. */

function fakeMeasurement(overrides = {}) {
  return {
    language: 'ru',
    languageSource: 'declared',
    spokenTotal: 10,
    tagTotal: 2,
    unattributedSpeech: 0,
    splitSpeech: 0,
    lumpedSpeech: 0,
    narratorIdSpoken: 3,
    modelNarrator: 2,
    demotedNarrator: 1,
    unknownOriginNarrator: 0,
    orphanSpoken: 0,
    orphanIds: [],
    attributableSpoken: 10,
    tagNarratorSpan: 1,
    dashOnlySpoken: 5,
    castCount: 4,
    chapters: [],
    ...overrides,
  };
}

test('COLUMNS excludes the three revision-7 gap columns (F3/F4/F5)', () => {
  assert.equal(COLUMNS.includes('pipelineSpoken'), false);
  assert.equal(COLUMNS.includes('blindSpoken'), false);
  assert.equal(COLUMNS.includes('overcountSpoken'), false);
});

test('buildRow pulls every measurement field through, plus the state/reason', () => {
  const row = buildRow('Author / Series / Title', { state: 'ok', reason: 'healthy', measurement: fakeMeasurement() }, 0.3);
  assert.equal(row.title, 'Author / Series / Title');
  assert.equal(row.spokenTotal, 10);
  assert.equal(row.narratorIdSpoken, 3);
  assert.equal(row.share, 0.3);
  assert.equal(row.state, 'ok');
});

test('buildRow defaults every numeric field to 0 (not undefined/NaN) when measurement is null', () => {
  const row = buildRow('Never Analysed', { state: 'ok', reason: 'not analysed', measurement: null }, null);
  assert.equal(row.spokenTotal, 0);
  assert.equal(row.narratorIdSpoken, 0);
  assert.equal(row.castCount, 0);
  assert.equal(row.share, null);
  assert.equal(row.language, null);
});

test('formatShare: null renders as the literal "—", never 0 or 0%', () => {
  assert.equal(formatShare(null), '—');
  assert.equal(formatShare(0), '0.0%'); // a REAL 0% is still a real number
  assert.equal(formatShare(0.5), '50.0%');
});

test('sortRowsByShareDescending: highest share first, null share sorts LAST', () => {
  const rows = [
    { title: 'B', share: 0.2 },
    { title: 'A', share: 0.9 },
    { title: 'C', share: null },
    { title: 'D', share: 0.5 },
  ];
  const sorted = sortRowsByShareDescending(rows).map((r) => r.title);
  assert.deepEqual(sorted, ['A', 'D', 'B', 'C']);
});

test('sortRowsByShareDescending: a null share never sorts as if it were 0', () => {
  // MUTATION CONTROL for the "share ?? 0" trap: input order deliberately
  // puts the null-share row FIRST, ahead of the exact-0% row. A naive
  // `(b.share ?? 0) - (a.share ?? 0)` comparator treats the two as TIED
  // (both coerce to 0) and Array.prototype.sort's STABILITY then preserves
  // their original (wrong) relative order — so this fixture is the one
  // that actually distinguishes the two implementations; a fixture with the
  // rows already in the correct final order would pass under the mutant too
  // (verified: it does, by stability alone — the placebo this comment warns
  // against).
  const rows = [
    { title: 'nothing-to-say', share: null },
    { title: 'zero-percent', share: 0 },
  ];
  const sorted = sortRowsByShareDescending(rows).map((r) => r.title);
  assert.deepEqual(sorted, ['zero-percent', 'nothing-to-say']);
});

test('worstChapter: picks the chapter with the highest narrator share, ignoring chapters with spokenTotal 0', () => {
  const row = {
    chapters: [
      { chapterId: 1, spokenTotal: 0, narratorIdSpoken: 0 },
      { chapterId: 2, spokenTotal: 10, narratorIdSpoken: 2 },
      { chapterId: 3, spokenTotal: 5, narratorIdSpoken: 4 }, // 80% — worst
    ],
  };
  assert.equal(worstChapter(row).chapterId, 3);
});

test('worstChapter: null when there are no chapters with any spoken span', () => {
  assert.equal(worstChapter({ chapters: [{ chapterId: 1, spokenTotal: 0, narratorIdSpoken: 0 }] }), null);
  assert.equal(worstChapter({ chapters: [] }), null);
});

/* R-7M4 — four rows must be visibly distinct from a healthy book and from
   each other. Unit-tested at the formatter since no live book is in any of
   these states, so an on-box check of it would pass vacuously. */
test('formatStateCell: the four non-blank-row states are each visibly distinct', () => {
  const cast = formatStateCell({ state: 'missing', reason: 'cast built, nothing attributed' });
  const lang = formatStateCell({ state: 'unmeasurable', reason: 'language not corroborated' });
  const never = formatStateCell({ state: 'ok', reason: 'not analysed' });
  const noManuscript = formatStateCell({ state: 'unmeasurable', reason: 'no manuscript' });
  const healthy = formatStateCell({ state: 'ok', reason: 'healthy' });

  const cells = [cast, lang, never, noManuscript, healthy];
  assert.equal(new Set(cells).size, cells.length, 'all five cells must be textually distinct');
  for (const cell of cells) {
    assert.notEqual(cell.trim(), '', 'no cell may render blank');
  }
  assert.equal(healthy, 'ok'); // the one case allowed to render as the bare word
});
