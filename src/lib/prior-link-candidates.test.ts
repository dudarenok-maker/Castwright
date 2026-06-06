import { describe, it, expect } from 'vitest';
import { filterLinkablePriorCandidates } from './prior-link-candidates';
import type { SeriesRosterEntry } from './api';
import type { Character } from './types';

/* A recurring character appears once per prior book (The Tidewatcher's Oath/Exile/Keeper
   each carry a "Dame Linnet", Saltgrave a "Councillor Linnet") — all sharing the
   canonical voiceId 'dame-Linnet'. */
const LinnetRoster: SeriesRosterEntry[] = [
  { id: 'dame-Linnet', name: 'Dame Linnet', bookId: 'the Hollow Tide__The Tidewatcher's Oath', bookTitle: 'The Tidewatcher's Oath', voiceId: 'dame-Linnet' },
  { id: 'dame-Linnet', name: 'Dame Linnet', bookId: 'the Hollow Tide__exile', bookTitle: 'Exile', voiceId: 'dame-Linnet' },
  { id: 'Linnet', name: 'Councillor Linnet', bookId: 'the Hollow Tide__Saltgrave', bookTitle: 'Saltgrave', voiceId: 'dame-Linnet' },
  { id: 'Marlow', name: 'Marlow', bookId: 'the Hollow Tide__The Tidewatcher's Oath', bookTitle: 'The Tidewatcher's Oath', voiceId: 'Marlow' },
];

function char(partial: Partial<Character>): Character {
  return { id: 'x', name: 'X', role: 'character', color: 'unset', ...partial } as Character;
}

describe('filterLinkablePriorCandidates', () => {
  it('keeps every candidate when no local character is linked', () => {
    const local = [char({ id: 'dame-Linnet_local', name: 'Dame Linnet', voiceId: 'dame-Linnet_local' })];
    expect(filterLinkablePriorCandidates(local, LinnetRoster)).toHaveLength(4);
  });

  it('collapses ALL of a person’s prior-book copies once the local row shares their voiceId', () => {
    /* The screenshot case: Unlocked’s "Dame Linnet" is already reused with
       voiceId 'dame-Linnet'. Every Linnet candidate (across 3 books) must drop
       out, while unrelated candidates (Marlow) stay. */
    const local = [char({ id: 'dame-Linnet_from', name: 'Dame Linnet', voiceId: 'dame-Linnet', voiceState: 'reused' })];
    const out = filterLinkablePriorCandidates(local, LinnetRoster);
    expect(out.map((p) => p.name)).toEqual(['Marlow']);
  });

  it('also suppresses the exact matchedFrom target even if voiceId is absent', () => {
    const noVoiceRoster: SeriesRosterEntry[] = [
      { id: 'Linnet', name: 'Councillor Linnet', bookId: 'the Hollow Tide__Saltgrave', bookTitle: 'Saltgrave' },
      { id: 'dame-Linnet', name: 'Dame Linnet', bookId: 'the Hollow Tide__exile', bookTitle: 'Exile' },
    ];
    const local = [
      char({
        id: 'a',
        matchedFrom: { bookId: 'the Hollow Tide__Saltgrave', characterId: 'Linnet', bookTitle: 'Saltgrave', confidence: 1 },
      }),
    ];
    const out = filterLinkablePriorCandidates(local, noVoiceRoster);
    expect(out.map((p) => p.bookId)).toEqual(['the Hollow Tide__exile']);
  });

  it('does not suppress a different person who happens to be unlinked', () => {
    const local = [char({ id: 'Wren', name: 'Wren', voiceId: 'Wren' })];
    expect(filterLinkablePriorCandidates(local, LinnetRoster)).toHaveLength(4);
  });
});
