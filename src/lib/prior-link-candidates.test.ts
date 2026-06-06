import { describe, it, expect } from 'vitest';
import { filterLinkablePriorCandidates } from './prior-link-candidates';
import type { SeriesRosterEntry } from './api';
import type { Character } from './types';

/* A recurring character appears once per prior book (Everblaze/Exile/Keeper
   each carry a "Dame Alina", Neverseen a "Councillor Alina") — all sharing the
   canonical voiceId 'dame-alina'. */
const alinaRoster: SeriesRosterEntry[] = [
  { id: 'dame-alina', name: 'Dame Alina', bookId: 'kotlc__everblaze', bookTitle: 'Everblaze', voiceId: 'dame-alina' },
  { id: 'dame-alina', name: 'Dame Alina', bookId: 'kotlc__exile', bookTitle: 'Exile', voiceId: 'dame-alina' },
  { id: 'alina', name: 'Councillor Alina', bookId: 'kotlc__neverseen', bookTitle: 'Neverseen', voiceId: 'dame-alina' },
  { id: 'keefe', name: 'Keefe', bookId: 'kotlc__everblaze', bookTitle: 'Everblaze', voiceId: 'keefe' },
];

function char(partial: Partial<Character>): Character {
  return { id: 'x', name: 'X', role: 'character', color: 'unset', ...partial } as Character;
}

describe('filterLinkablePriorCandidates', () => {
  it('keeps every candidate when no local character is linked', () => {
    const local = [char({ id: 'dame-alina_local', name: 'Dame Alina', voiceId: 'dame-alina_local' })];
    expect(filterLinkablePriorCandidates(local, alinaRoster)).toHaveLength(4);
  });

  it('collapses ALL of a person’s prior-book copies once the local row shares their voiceId', () => {
    /* The screenshot case: Unlocked’s "Dame Alina" is already reused with
       voiceId 'dame-alina'. Every Alina candidate (across 3 books) must drop
       out, while unrelated candidates (Keefe) stay. */
    const local = [char({ id: 'dame-alina_from', name: 'Dame Alina', voiceId: 'dame-alina', voiceState: 'reused' })];
    const out = filterLinkablePriorCandidates(local, alinaRoster);
    expect(out.map((p) => p.name)).toEqual(['Keefe']);
  });

  it('also suppresses the exact matchedFrom target even if voiceId is absent', () => {
    const noVoiceRoster: SeriesRosterEntry[] = [
      { id: 'alina', name: 'Councillor Alina', bookId: 'kotlc__neverseen', bookTitle: 'Neverseen' },
      { id: 'dame-alina', name: 'Dame Alina', bookId: 'kotlc__exile', bookTitle: 'Exile' },
    ];
    const local = [
      char({
        id: 'a',
        matchedFrom: { bookId: 'kotlc__neverseen', characterId: 'alina', bookTitle: 'Neverseen', confidence: 1 },
      }),
    ];
    const out = filterLinkablePriorCandidates(local, noVoiceRoster);
    expect(out.map((p) => p.bookId)).toEqual(['kotlc__exile']);
  });

  it('does not suppress a different person who happens to be unlinked', () => {
    const local = [char({ id: 'sophie', name: 'Sophie', voiceId: 'sophie' })];
    expect(filterLinkablePriorCandidates(local, alinaRoster)).toHaveLength(4);
  });
});
