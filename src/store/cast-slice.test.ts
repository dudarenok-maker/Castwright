// Pairs with docs/features/09-voice-match-pipeline.md

import { describe, expect, it } from 'vitest';
import { castSlice, castActions } from './cast-slice';
import type { Character, VoiceMatchResponse } from '../lib/types';

const makeChar = (id: string, overrides: Partial<Character> = {}): Character => ({
  id,
  name: id,
  role: 'role',
  color: id,
  voiceState: 'generated',
  ...overrides,
});

const baseState = (characters: Character[]) => ({ characters });

const matchResponse = (matches: VoiceMatchResponse['matches']): VoiceMatchResponse =>
  ({ bookId: 'ns', matches });

describe('castSlice — applyVoiceMatches', () => {
  it('assigns the top candidate to the matching character and flips voiceState to reused', () => {
    const start = baseState([
      makeChar('halloran', { voiceState: 'generated' }),
      makeChar('eliza',    { voiceState: 'generated' }),
    ]);
    const next = castSlice.reducer(start, castActions.applyVoiceMatches(matchResponse([
      {
        characterId: 'halloran',
        candidates: [
          { voiceId: 'v_authority', fromBookTitle: 'Solway Bay', score: 0.91,
            factors: [{ id: 'register', label: 'Register', score: 0.9 }] },
          { voiceId: 'v_runner-up', fromBookTitle: 'Other', score: 0.6 },
        ],
      },
    ])));
    const halloran = next.characters.find(c => c.id === 'halloran')!;
    expect(halloran.voiceId).toBe('v_authority');
    expect(halloran.voiceState).toBe('reused');
    expect(halloran.matchedFrom).toEqual({ bookTitle: 'Solway Bay', confidence: 0.91 });
    expect(halloran.matchFactors).toEqual([{ id: 'register', label: 'Register', score: 0.9 }]);
  });

  it('leaves characters with no candidates untouched', () => {
    const start = baseState([
      makeChar('halloran', { voiceState: 'generated', voiceId: 'v_old' }),
      makeChar('eliza',    { voiceState: 'tuned',     voiceId: 'v_eliza' }),
    ]);
    const next = castSlice.reducer(start, castActions.applyVoiceMatches(matchResponse([
      { characterId: 'halloran', candidates: [] },
    ])));
    const halloran = next.characters.find(c => c.id === 'halloran')!;
    const eliza    = next.characters.find(c => c.id === 'eliza')!;
    expect(halloran.voiceId).toBe('v_old');
    expect(halloran.voiceState).toBe('generated');
    expect(eliza.voiceState).toBe('tuned');
  });

  it('leaves characters not present in the matches response untouched', () => {
    const start = baseState([
      makeChar('halloran', { voiceState: 'generated', voiceId: 'v_old' }),
    ]);
    const next = castSlice.reducer(start, castActions.applyVoiceMatches(matchResponse([])));
    expect(next.characters[0].voiceId).toBe('v_old');
    expect(next.characters[0].voiceState).toBe('generated');
  });
});

describe('castSlice — declineMatch', () => {
  it('clears matchedFrom and reverts voiceState to generated', () => {
    const start = baseState([
      makeChar('halloran', {
        voiceState: 'reused',
        matchedFrom: { bookTitle: 'Solway Bay', confidence: 0.91 },
      }),
    ]);
    const next = castSlice.reducer(start, castActions.declineMatch('halloran'));
    const halloran = next.characters[0];
    expect(halloran.matchedFrom).toBeUndefined();
    expect(halloran.voiceState).toBe('generated');
  });

  it('is a no-op for an unknown characterId', () => {
    const start = baseState([makeChar('halloran')]);
    const next = castSlice.reducer(start, castActions.declineMatch('not-a-character'));
    expect(next.characters).toEqual(start.characters);
  });
});
