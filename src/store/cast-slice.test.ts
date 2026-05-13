// Pairs with docs/features/09-voice-match-pipeline.md

import { describe, expect, it } from 'vitest';
import { castSlice, castActions } from './cast-slice';
import type { AnalyseResponse, Character, VoiceMatchResponse } from '../lib/types';

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

describe('castSlice — lockVoice', () => {
  it('flips the targeted character voiceState to locked', () => {
    const start = baseState([
      makeChar('halloran', { voiceState: 'tuned' }),
      makeChar('eliza',    { voiceState: 'generated' }),
    ]);
    const next = castSlice.reducer(start, castActions.lockVoice('halloran'));
    expect(next.characters.find(c => c.id === 'halloran')!.voiceState).toBe('locked');
    expect(next.characters.find(c => c.id === 'eliza')!.voiceState).toBe('generated');
  });

  it('is a no-op for an unknown characterId', () => {
    const start = baseState([makeChar('halloran', { voiceState: 'tuned' })]);
    const next = castSlice.reducer(start, castActions.lockVoice('not-a-character'));
    expect(next.characters[0].voiceState).toBe('tuned');
  });
});

describe('castSlice — hydrateFromAnalysis', () => {
  const baseAnalysis = (characters: Character[]): AnalyseResponse => ({
    bookId: 'ns', manuscriptId: 'ms', title: 'Test', phaseTimings: [],
    characters, chapters: [], sentences: [],
  });

  it('defaults missing voiceState to "generated" so the Cast Status column renders a pill', () => {
    /* Regression: AnalyseResponse leaves voiceState optional, and the
       file-drop analyser doesn't always fill it in. Without this default,
       freshly-analysed characters land in the Cast view with the Status
       column empty even though their voices were just generated. */
    const { voiceState: _omit, ...narratorNoState } = makeChar('narrator');
    const next = castSlice.reducer(
      baseState([]),
      castActions.hydrateFromAnalysis(baseAnalysis([
        narratorNoState as Character,
        makeChar('keefe', { voiceState: 'locked' }),
      ])),
    );
    expect(next.characters.find(c => c.id === 'narrator')!.voiceState).toBe('generated');
    expect(next.characters.find(c => c.id === 'keefe')!.voiceState).toBe('locked');
  });

  it('is a no-op when the response has no characters', () => {
    const start = baseState([makeChar('halloran', { voiceState: 'tuned' })]);
    const next = castSlice.reducer(start, castActions.hydrateFromAnalysis(baseAnalysis([])));
    expect(next.characters).toEqual(start.characters);
  });
});

describe('castSlice — initial state (mock-leak regression)', () => {
  it('starts with an empty characters array so the design fixture never renders for a real book', () => {
    /* Same mock-leak bug as chaptersSlice — opening a real book briefly
       showed fixture characters on Cast before hydrateFromAnalysis landed.
       Keep this empty; hydration is the only legitimate source. */
    expect(castSlice.getInitialState().characters).toEqual([]);
  });
});
