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
        makeChar('Marlow', { voiceState: 'locked' }),
      ])),
    );
    expect(next.characters.find(c => c.id === 'narrator')!.voiceState).toBe('generated');
    expect(next.characters.find(c => c.id === 'Marlow')!.voiceState).toBe('locked');
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

describe('castSlice — mergeCharacters (Phase 0a live cast snapshots)', () => {
  it('appends new characters in incoming order on an empty slice, defaulting voiceState', () => {
    const start = baseState([]);
    const next = castSlice.reducer(start, castActions.mergeCharacters([
      makeChar('narrator'),
      makeChar('Wren'),
    ]));
    expect(next.characters.map(c => c.id)).toEqual(['narrator', 'Wren']);
    expect(next.characters[0].voiceState).toBe('generated');
  });

  it('upserts by id and preserves locked voiceId / matchedFrom on the existing entry', () => {
    /* User had matched Wren to a previous-book voice + locked it; a
       later cast-update snapshot from the analyzer must NOT clobber
       voiceId / matchedFrom / voiceState='locked'. */
    const start = baseState([makeChar('Wren', {
      voiceState: 'locked',
      voiceId: 'v_Wren_from_book1',
      matchedFrom: { bookTitle: 'KOTC #1', confidence: 0.94 },
    })]);
    const next = castSlice.reducer(start, castActions.mergeCharacters([
      /* Snapshot from a later chapter — analyzer doesn't know about the lock. */
      { id: 'Wren', name: 'Wren Sparrow', role: 'protagonist', color: 'orange',
        description: 'Updated richer description.' },
    ]));
    const Wren = next.characters.find(c => c.id === 'Wren')!;
    expect(Wren.voiceId).toBe('v_Wren_from_book1');
    expect(Wren.voiceState).toBe('locked');
    expect(Wren.matchedFrom).toEqual({ bookTitle: 'KOTC #1', confidence: 0.94 });
    /* New fields from the snapshot still flow through. */
    expect(Wren.name).toBe('Wren Sparrow');
    expect(Wren.description).toBe('Updated richer description.');
  });

  it('appends new characters from a later snapshot at the end (preserves discovery order)', () => {
    const start = baseState([makeChar('Wren'), makeChar('Marlow')]);
    const next = castSlice.reducer(start, castActions.mergeCharacters([
      makeChar('Wren'),
      makeChar('Marlow'),
      makeChar('Maerin'), /* New in chapter 5 */
    ]));
    expect(next.characters.map(c => c.id)).toEqual(['Wren', 'Marlow', 'Maerin']);
  });

  it('preserves locally-known characters the snapshot omitted (defensive — full snapshots in practice)', () => {
    const start = baseState([
      makeChar('Wren', { voiceState: 'locked' }),
      makeChar('Marlow'),
    ]);
    /* Snapshot only has 'Wren' — 'Marlow' should still be present. */
    const next = castSlice.reducer(start, castActions.mergeCharacters([
      makeChar('Wren', { description: 'updated' }),
    ]));
    expect(next.characters.map(c => c.id).sort()).toEqual(['Marlow', 'Wren']);
    expect(next.characters.find(c => c.id === 'Wren')!.voiceState).toBe('locked');
  });

  it('is a no-op for an empty incoming list', () => {
    const start = baseState([makeChar('Wren')]);
    const next = castSlice.reducer(start, castActions.mergeCharacters([]));
    expect(next.characters).toEqual(start.characters);
  });
});

describe('castSlice — applyMerge (manual character merge response)', () => {
  it('replaces the local cast with the server payload while preserving local voice state on survivors', () => {
    /* User had locked the target's voice in a prior session. The server's
       merge response is the authoritative character list (with aliases set,
       lines/scenes recomputed), but it doesn't carry voiceId / voiceState
       — those are local / library-derived and the reducer must keep them. */
    const start = baseState([
      makeChar('Wren',        { voiceState: 'generated' }),
      makeChar('Wren-foster', {
        voiceState: 'locked',
        voiceId: 'v_Wren_from_book1',
        matchedFrom: { bookTitle: 'KOTC #1', confidence: 0.94 },
      }),
      makeChar('Marlow',         { voiceState: 'tuned', voiceId: 'v_Marlow' }),
    ]);
    const next = castSlice.reducer(start, castActions.applyMerge({
      characters: [
        { id: 'Wren-foster', name: 'Wren Sparrow', role: 'protagonist',
          color: 'orange', lines: 17, scenes: 6,
          aliases: ['Wren'], voiceState: undefined as unknown as Character['voiceState'] },
        { id: 'Marlow', name: 'Marlow Halden', role: 'sidekick', color: 'halloran',
          lines: 7, scenes: 3 } as Character,
      ],
    }));
    expect(next.characters.map(c => c.id)).toEqual(['Wren-foster', 'Marlow']);
    const survivor = next.characters.find(c => c.id === 'Wren-foster')!;
    /* Server-authoritative fields flow through. */
    expect(survivor.aliases).toEqual(['Wren']);
    expect(survivor.lines).toBe(17);
    expect(survivor.scenes).toBe(6);
    /* Local-only fields preserved on the survivor. */
    expect(survivor.voiceState).toBe('locked');
    expect(survivor.voiceId).toBe('v_Wren_from_book1');
    expect(survivor.matchedFrom).toEqual({ bookTitle: 'KOTC #1', confidence: 0.94 });
    /* Untouched characters keep their local voice state too. */
    expect(next.characters.find(c => c.id === 'Marlow')!.voiceId).toBe('v_Marlow');
    expect(next.characters.find(c => c.id === 'Marlow')!.voiceState).toBe('tuned');
  });

  it('is a no-op when the payload is missing characters', () => {
    const start = baseState([makeChar('Wren')]);
    const next = castSlice.reducer(start, castActions.applyMerge({
      characters: undefined as unknown as Character[],
    }));
    expect(next.characters).toEqual(start.characters);
  });
});
