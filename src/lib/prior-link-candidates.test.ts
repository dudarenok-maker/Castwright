import { describe, it, expect } from 'vitest';
import { filterLinkablePriorCandidates } from './prior-link-candidates';
import type { SeriesRosterEntry } from './api';
import type { Character } from './types';

/* A recurring character appears once per prior book (The Tidewatcher’s Oath/The Ebb/The Hollow Tide
   each carry a "Dame Linnet", Saltgrave a "Councillor Linnet") — all sharing the
   canonical voiceId 'dame-linnet'. */
const alinaRoster: SeriesRosterEntry[] = [
  { id: 'dame-linnet', name: 'Dame Linnet', bookId: 'the Hollow Tide__the-tidewatchers-oath', bookTitle: 'The Tidewatcher’s Oath', voiceId: 'dame-linnet' },
  { id: 'dame-linnet', name: 'Dame Linnet', bookId: 'the Hollow Tide__exile', bookTitle: 'The Ebb', voiceId: 'dame-linnet' },
  { id: 'linnet', name: 'Councillor Linnet', bookId: 'the Hollow Tide__saltgrave', bookTitle: 'Saltgrave', voiceId: 'dame-linnet' },
  { id: 'marlow', name: 'Marlow', bookId: 'the Hollow Tide__the-tidewatchers-oath', bookTitle: 'The Tidewatcher’s Oath', voiceId: 'marlow' },
];

function char(partial: Partial<Character>): Character {
  return { id: 'x', name: 'X', role: 'character', color: 'unset', ...partial } as Character;
}

describe('filterLinkablePriorCandidates', () => {
  it('keeps every candidate when no local character is linked', () => {
    const local = [char({ id: 'dame-linnet_local', name: 'Dame Linnet', voiceId: 'dame-linnet_local' })];
    expect(filterLinkablePriorCandidates(local, alinaRoster)).toHaveLength(4);
  });

  it('collapses ALL of a person’s prior-book copies once the local row shares their voiceId', () => {
    /* The screenshot case: The Floodmark’s "Dame Linnet" is already reused with
       voiceId 'dame-linnet'. Every Linnet candidate (across 3 books) must drop
       out, while unrelated candidates (Marlow) stay. */
    const local = [char({ id: 'dame-linnet_from', name: 'Dame Linnet', voiceId: 'dame-linnet', voiceState: 'reused' })];
    const out = filterLinkablePriorCandidates(local, alinaRoster);
    expect(out.map((p) => p.name)).toEqual(['Marlow']);
  });

  it('also suppresses the exact matchedFrom target even if voiceId is absent', () => {
    const noVoiceRoster: SeriesRosterEntry[] = [
      { id: 'linnet', name: 'Councillor Linnet', bookId: 'the Hollow Tide__saltgrave', bookTitle: 'Saltgrave' },
      { id: 'dame-linnet', name: 'Dame Linnet', bookId: 'the Hollow Tide__exile', bookTitle: 'The Ebb' },
    ];
    const local = [
      char({
        id: 'a',
        matchedFrom: { bookId: 'the Hollow Tide__saltgrave', characterId: 'linnet', bookTitle: 'Saltgrave', confidence: 1 },
      }),
    ];
    const out = filterLinkablePriorCandidates(local, noVoiceRoster);
    expect(out.map((p) => p.bookId)).toEqual(['the Hollow Tide__exile']);
  });

  it('does not suppress a different person who happens to be unlinked', () => {
    const local = [char({ id: 'wren', name: 'Wren', voiceId: 'wren' })];
    expect(filterLinkablePriorCandidates(local, alinaRoster)).toHaveLength(4);
  });
});
