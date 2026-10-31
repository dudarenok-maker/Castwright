/* Plan 290 (#3837, round 10) — the pure stale-evidence predicate shared by the
   bundle overwrite and the backup restore. Every arm: edits kind × chapter
   comparison × current marker × current state absent/unreadable (null). */

import { describe, it, expect } from 'vitest';
import { chaptersMatchForEvidence, swapLeavesStaleEvidence } from './stale-evidence.js';
import type { EditsForCheck } from './hints-proof-io.js';

const CH = [
  { id: 1, title: 'One', slug: '01-one' },
  { id: 2, title: 'Two', slug: '02-two' },
  { id: 3, title: 'Three', slug: '03-three' },
];
const BY_ID = CH.map((c) => (c.id === 3 ? { ...c, id: 4 } : c));
const BY_TITLE = CH.map((c) => (c.id === 2 ? { ...c, title: 'Two (merged)' } : c));
const BY_COUNT = CH.slice(0, 2);

const EDITS: Record<string, EditsForCheck> = {
  absent: { kind: 'absent' },
  empty: { kind: 'ok', value: { sentences: [] }, sha256: 'x' },
  noArray: { kind: 'ok', value: {}, sha256: 'x' },
  ok: { kind: 'ok', value: { sentences: [{ chapterId: 1, text: 'A saved sentence.' }] }, sha256: 'x' },
  corrupt: { kind: 'corrupt', error: new SyntaxError('bad') },
  unreadable: { kind: 'unreadable', error: new Error('EACCES') },
};
const holdsSentences = new Set(['ok', 'corrupt', 'unreadable']);

const INCOMING: Record<string, typeof CH> = { same: CH, byId: BY_ID, byTitle: BY_TITLE, byCount: BY_COUNT };

describe('chaptersMatchForEvidence', () => {
  it('matches the same ids and titles in the same order', () => {
    expect(chaptersMatchForEvidence(CH, CH.map((c) => ({ ...c })))).toBe(true);
  });
  it.each([
    ['an id', BY_ID],
    ['a title', BY_TITLE],
    ['the count', BY_COUNT],
    ['the order', [CH[1]!, CH[0]!, CH[2]!]],
  ])('differs by %s', (_l, other) => {
    expect(chaptersMatchForEvidence(CH, other)).toBe(false);
    expect(chaptersMatchForEvidence(other, CH)).toBe(false);
  });
  it('ignores fields other than id and title', () => {
    expect(chaptersMatchForEvidence(CH, CH.map((c) => ({ ...c, slug: 'zz', excluded: true })))).toBe(true);
  });
  it('a missing list matches nothing', () => {
    expect(chaptersMatchForEvidence(CH, undefined as never)).toBe(false);
    expect(chaptersMatchForEvidence(undefined as never, CH)).toBe(false);
  });
});

describe('swapLeavesStaleEvidence', () => {
  for (const [editsKey, edits] of Object.entries(EDITS)) {
    for (const [incomingKey, incoming] of Object.entries(INCOMING)) {
      for (const marked of [false, true]) {
        const differs = incomingKey !== 'same';
        const expected = holdsSentences.has(editsKey) && (differs || marked);
        it(`edits ${editsKey}, chapters ${incomingKey}, current ${marked ? 'marked' : 'unmarked'} -> ${expected}`, () => {
          const current = { chapters: CH, ...(marked ? { sentencesPredateChapters: true as const } : {}) };
          expect(swapLeavesStaleEvidence(edits, incoming, current)).toBe(expected);
        });
      }
      /* An absent or unreadable current state counts as a different list. */
      const expectedNull = holdsSentences.has(editsKey);
      it(`edits ${editsKey}, chapters ${incomingKey}, current state null -> ${expectedNull}`, () => {
        expect(swapLeavesStaleEvidence(edits, incoming, null)).toBe(expectedNull);
      });
    }
  }
});
