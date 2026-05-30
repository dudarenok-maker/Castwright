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

const matchResponse = (matches: VoiceMatchResponse['matches']): VoiceMatchResponse => ({
  bookId: 'ns',
  matches,
});

describe('castSlice — applyVoiceMatches', () => {
  it('assigns the top candidate to the matching character and flips voiceState to reused', () => {
    const start = baseState([
      makeChar('halloran', { voiceState: 'generated' }),
      makeChar('eliza', { voiceState: 'generated' }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyVoiceMatches(
        matchResponse([
          {
            characterId: 'halloran',
            candidates: [
              {
                voiceId: 'v_authority',
                fromBookId: 'solway_bay_book',
                fromBookTitle: 'Solway Bay',
                fromCharacterId: 'halloran_lib',
                score: 0.91,
                factors: [{ id: 'register', label: 'Register', score: 0.9 }],
              },
              {
                voiceId: 'v_runner-up',
                fromBookId: 'other_book',
                fromBookTitle: 'Other',
                fromCharacterId: 'halloran_lib_alt',
                score: 0.6,
              },
            ],
          },
        ]),
      ),
    );
    const halloran = next.characters.find((c) => c.id === 'halloran')!;
    expect(halloran.voiceId).toBe('v_authority');
    expect(halloran.voiceState).toBe('reused');
    /* matchedFrom carries the cross-book identifiers needed by the
       library-cast override flow on the confirm page. */
    expect(halloran.matchedFrom).toEqual({
      bookId: 'solway_bay_book',
      characterId: 'halloran_lib',
      bookTitle: 'Solway Bay',
      confidence: 0.91,
    });
    expect(halloran.matchFactors).toEqual([{ id: 'register', label: 'Register', score: 0.9 }]);
  });

  it('leaves characters with no candidates untouched', () => {
    const start = baseState([
      makeChar('halloran', { voiceState: 'generated', voiceId: 'v_old' }),
      makeChar('eliza', { voiceState: 'tuned', voiceId: 'v_eliza' }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyVoiceMatches(matchResponse([{ characterId: 'halloran', candidates: [] }])),
    );
    const halloran = next.characters.find((c) => c.id === 'halloran')!;
    const eliza = next.characters.find((c) => c.id === 'eliza')!;
    expect(halloran.voiceId).toBe('v_old');
    expect(halloran.voiceState).toBe('generated');
    expect(eliza.voiceState).toBe('tuned');
  });

  it('leaves characters not present in the matches response untouched', () => {
    const start = baseState([makeChar('halloran', { voiceState: 'generated', voiceId: 'v_old' })]);
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
      makeChar('eliza', { voiceState: 'generated' }),
    ]);
    const next = castSlice.reducer(start, castActions.lockVoice('halloran'));
    expect(next.characters.find((c) => c.id === 'halloran')!.voiceState).toBe('locked');
    expect(next.characters.find((c) => c.id === 'eliza')!.voiceState).toBe('generated');
  });

  it('is a no-op for an unknown characterId', () => {
    const start = baseState([makeChar('halloran', { voiceState: 'tuned' })]);
    const next = castSlice.reducer(start, castActions.lockVoice('not-a-character'));
    expect(next.characters[0].voiceState).toBe('tuned');
  });
});

describe('castSlice — hydrateFromAnalysis', () => {
  const baseAnalysis = (characters: Character[]): AnalyseResponse => ({
    bookId: 'ns',
    manuscriptId: 'ms',
    title: 'Test',
    phaseTimings: [],
    characters,
    chapters: [],
    sentences: [],
  });

  it('defaults missing voiceState to "generated" so the Cast Status column renders a pill', () => {
    /* Regression: AnalyseResponse leaves voiceState optional, and the
       file-drop analyser doesn't always fill it in. Without this default,
       freshly-analysed characters land in the Cast view with the Status
       column empty even though their voices were just generated. */
    const { voiceState: _omit, ...narratorNoState } = makeChar('narrator');
    const next = castSlice.reducer(
      baseState([]),
      castActions.hydrateFromAnalysis(
        baseAnalysis([narratorNoState as Character, makeChar('keefe', { voiceState: 'locked' })]),
      ),
    );
    expect(next.characters.find((c) => c.id === 'narrator')!.voiceState).toBe('generated');
    expect(next.characters.find((c) => c.id === 'keefe')!.voiceState).toBe('locked');
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
    const next = castSlice.reducer(
      start,
      castActions.mergeCharacters([makeChar('narrator'), makeChar('sophie')]),
    );
    expect(next.characters.map((c) => c.id)).toEqual(['narrator', 'sophie']);
    expect(next.characters[0].voiceState).toBe('generated');
  });

  it('upserts by id and preserves locked voiceId / matchedFrom on the existing entry', () => {
    /* User had matched Sophie to a previous-book voice + locked it; a
       later cast-update snapshot from the analyzer must NOT clobber
       voiceId / matchedFrom / voiceState='locked'. */
    const start = baseState([
      makeChar('sophie', {
        voiceState: 'locked',
        voiceId: 'v_sophie_from_book1',
        matchedFrom: { bookTitle: 'KOTC #1', confidence: 0.94 },
      }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.mergeCharacters([
        /* Snapshot from a later chapter — analyzer doesn't know about the lock. */
        {
          id: 'sophie',
          name: 'Sophie Foster',
          role: 'protagonist',
          color: 'orange',
          description: 'Updated richer description.',
        },
      ]),
    );
    const sophie = next.characters.find((c) => c.id === 'sophie')!;
    expect(sophie.voiceId).toBe('v_sophie_from_book1');
    expect(sophie.voiceState).toBe('locked');
    expect(sophie.matchedFrom).toEqual({ bookTitle: 'KOTC #1', confidence: 0.94 });
    /* New fields from the snapshot still flow through. */
    expect(sophie.name).toBe('Sophie Foster');
    expect(sophie.description).toBe('Updated richer description.');
  });

  it('appends new characters from a later snapshot at the end (preserves discovery order)', () => {
    const start = baseState([makeChar('sophie'), makeChar('keefe')]);
    const next = castSlice.reducer(
      start,
      castActions.mergeCharacters([
        makeChar('sophie'),
        makeChar('keefe'),
        makeChar('biana') /* New in chapter 5 */,
      ]),
    );
    expect(next.characters.map((c) => c.id)).toEqual(['sophie', 'keefe', 'biana']);
  });

  it('preserves locally-known characters the snapshot omitted (defensive — full snapshots in practice)', () => {
    const start = baseState([makeChar('sophie', { voiceState: 'locked' }), makeChar('keefe')]);
    /* Snapshot only has 'sophie' — 'keefe' should still be present. */
    const next = castSlice.reducer(
      start,
      castActions.mergeCharacters([makeChar('sophie', { description: 'updated' })]),
    );
    expect(next.characters.map((c) => c.id).sort()).toEqual(['keefe', 'sophie']);
    expect(next.characters.find((c) => c.id === 'sophie')!.voiceState).toBe('locked');
  });

  it('is a no-op for an empty incoming list', () => {
    const start = baseState([makeChar('sophie')]);
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
      makeChar('sophie', { voiceState: 'generated' }),
      makeChar('sophie-foster', {
        voiceState: 'locked',
        voiceId: 'v_sophie_from_book1',
        matchedFrom: { bookTitle: 'KOTC #1', confidence: 0.94 },
      }),
      makeChar('keefe', { voiceState: 'tuned', voiceId: 'v_keefe' }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyMerge({
        characters: [
          {
            id: 'sophie-foster',
            name: 'Sophie Foster',
            role: 'protagonist',
            color: 'orange',
            lines: 17,
            scenes: 6,
            aliases: ['Sophie'],
            voiceState: undefined as unknown as Character['voiceState'],
          },
          {
            id: 'keefe',
            name: 'Keefe Sencen',
            role: 'sidekick',
            color: 'halloran',
            lines: 7,
            scenes: 3,
          } as Character,
        ],
      }),
    );
    expect(next.characters.map((c) => c.id)).toEqual(['sophie-foster', 'keefe']);
    const survivor = next.characters.find((c) => c.id === 'sophie-foster')!;
    /* Server-authoritative fields flow through. */
    expect(survivor.aliases).toEqual(['Sophie']);
    expect(survivor.lines).toBe(17);
    expect(survivor.scenes).toBe(6);
    /* Local-only fields preserved on the survivor. */
    expect(survivor.voiceState).toBe('locked');
    expect(survivor.voiceId).toBe('v_sophie_from_book1');
    expect(survivor.matchedFrom).toEqual({ bookTitle: 'KOTC #1', confidence: 0.94 });
    /* Untouched characters keep their local voice state too. */
    expect(next.characters.find((c) => c.id === 'keefe')!.voiceId).toBe('v_keefe');
    expect(next.characters.find((c) => c.id === 'keefe')!.voiceState).toBe('tuned');
  });

  it('is a no-op when the payload is missing characters', () => {
    const start = baseState([makeChar('sophie')]);
    const next = castSlice.reducer(
      start,
      castActions.applyMerge({
        characters: undefined as unknown as Character[],
      }),
    );
    expect(next.characters).toEqual(start.characters);
  });
});

describe('castSlice — addCharacter (POST /cast/add-from-roster response)', () => {
  it('appends a new character to the slice with matchedFrom + voiceId preserved', () => {
    const start = baseState([makeChar('narrator'), makeChar('sophie')]);
    const incoming: Character = {
      id: 'councillor-alina_from_kotlc',
      name: 'Councillor Alina',
      role: 'character',
      color: 'unset',
      gender: 'female',
      ageRange: 'adult',
      voiceId: 'v_alina',
      voiceState: 'reused',
      matchedFrom: {
        bookId: 'kotlc-1',
        characterId: 'councillor-alina',
        bookTitle: 'Keeper of the Lost Cities',
        confidence: 1,
      },
    };
    const next = castSlice.reducer(start, castActions.addCharacter(incoming));
    expect(next.characters).toHaveLength(3);
    expect(next.characters[2]).toEqual(incoming);
  });

  it('is idempotent when an entry with the same id already exists', () => {
    const existing: Character = {
      id: 'alina_local',
      name: 'Councillor Alina',
      role: 'character',
      color: 'unset',
      voiceState: 'reused',
    };
    const start = baseState([makeChar('narrator'), existing]);
    const next = castSlice.reducer(start, castActions.addCharacter(existing));
    expect(next.characters).toHaveLength(2);
    expect(next.characters[1]).toEqual(existing);
  });
});

describe('castSlice — applyManualMatch (POST /cast/link-prior response)', () => {
  it('writes matchedFrom + voiceId + reused state on the targeted character', () => {
    const start = baseState([
      makeChar('dexter-alvin-diznee', { voiceState: 'generated' }),
      makeChar('sophie', { voiceState: 'generated' }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyManualMatch({
        characterId: 'dexter-alvin-diznee',
        matchedFrom: {
          bookId: 'kotlc_1',
          characterId: 'dex',
          bookTitle: 'Keeper #1',
          confidence: 1,
        },
        voiceId: 'v_dex',
      }),
    );
    const dex = next.characters.find((c) => c.id === 'dexter-alvin-diznee')!;
    expect(dex.voiceId).toBe('v_dex');
    expect(dex.voiceState).toBe('reused');
    expect(dex.matchedFrom).toEqual({
      bookId: 'kotlc_1',
      characterId: 'dex',
      bookTitle: 'Keeper #1',
      confidence: 1,
    });
    /* Untouched character is untouched. */
    expect(next.characters.find((c) => c.id === 'sophie')!.voiceState).toBe('generated');
  });

  it('preserves a locked or tuned voice — only matchedFrom is updated', () => {
    /* User already invested in tuning Dexter's voice; manually linking
       to the prior should record the continuity link without overwriting
       the tuned voiceId or downgrading voiceState. */
    const start = baseState([
      makeChar('dexter-alvin-diznee', {
        voiceState: 'tuned',
        voiceId: 'v_dexter_tuned',
      }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyManualMatch({
        characterId: 'dexter-alvin-diznee',
        matchedFrom: {
          bookId: 'kotlc_1',
          characterId: 'dex',
          bookTitle: 'Keeper #1',
          confidence: 1,
        },
        voiceId: 'v_dex_from_prior',
      }),
    );
    const dex = next.characters[0];
    expect(dex.voiceId).toBe('v_dexter_tuned');
    expect(dex.voiceState).toBe('tuned');
    expect(dex.matchedFrom?.characterId).toBe('dex');
  });

  it('is a no-op for an unknown characterId', () => {
    const start = baseState([makeChar('halloran')]);
    const next = castSlice.reducer(
      start,
      castActions.applyManualMatch({
        characterId: 'not-a-character',
        matchedFrom: { bookId: 'b', characterId: 'c', bookTitle: 't', confidence: 1 },
      }),
    );
    expect(next.characters).toEqual(start.characters);
  });
});

describe('castSlice — applyUnlinkAlias (POST /cast/unlink-alias response)', () => {
  it('strips the alias from the source and appends the new standalone character', () => {
    const start = baseState([
      makeChar('neverseen-figure', {
        aliases: ['Sior', 'Jurek', 'Sandor', 'Shopkeeper'],
        gender: 'male',
        ageRange: 'adult',
      }),
      makeChar('sophie'),
    ]);
    const newCharacter: Character = {
      id: 'sandor',
      name: 'Sandor',
      role: 'character',
      color: 'narrator',
      gender: 'male',
      ageRange: 'adult',
    } as Character;
    const next = castSlice.reducer(
      start,
      castActions.applyUnlinkAlias({
        sourceCharacterId: 'neverseen-figure',
        aliasName: 'Sandor',
        newCharacter,
      }),
    );
    const source = next.characters.find((c) => c.id === 'neverseen-figure')!;
    expect(source.aliases).toEqual(['Sior', 'Jurek', 'Shopkeeper']);
    /* New character lands at the end of the array, defaults to
       voiceState='generated' so the Cast view's Status column renders
       a pill rather than blank. */
    expect(next.characters[next.characters.length - 1]).toEqual({
      ...newCharacter,
      voiceState: 'generated',
    });
  });

  it('is case-insensitive and trim-tolerant when matching the alias to strip', () => {
    const start = baseState([
      makeChar('neverseen-figure', { aliases: ['  Sandor  ', 'Jurek'] }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyUnlinkAlias({
        sourceCharacterId: 'neverseen-figure',
        aliasName: 'sandor',
        newCharacter: {
          id: 'sandor',
          name: 'Sandor',
          role: 'character',
          color: 'narrator',
        } as Character,
      }),
    );
    expect(next.characters.find((c) => c.id === 'neverseen-figure')!.aliases).toEqual(['Jurek']);
  });

  it('is idempotent when the new character already exists (network retry safety)', () => {
    const existing = makeChar('sandor', { voiceState: 'tuned', voiceId: 'v_sandor' });
    const start = baseState([
      makeChar('neverseen-figure', { aliases: ['Sandor'] }),
      existing,
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyUnlinkAlias({
        sourceCharacterId: 'neverseen-figure',
        aliasName: 'Sandor',
        newCharacter: {
          id: 'sandor',
          name: 'Sandor',
          role: 'character',
          color: 'narrator',
        } as Character,
      }),
    );
    /* Existing tuned voice is preserved. */
    expect(next.characters).toHaveLength(2);
    expect(next.characters.find((c) => c.id === 'sandor')).toEqual(existing);
    expect(next.characters.find((c) => c.id === 'neverseen-figure')!.aliases).toEqual([]);
  });
});

describe('castSlice — applyAddAlias (POST /cast/add-alias response)', () => {
  it('appends a new alias to the target character', () => {
    const start = baseState([
      makeChar('sophie', { aliases: ['Foster'], name: 'Sophie Foster' }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyAddAlias({ characterId: 'sophie', aliasName: 'Sofi' }),
    );
    expect(next.characters[0].aliases).toEqual(['Foster', 'Sofi']);
  });

  it('dedupes case-insensitively and trim-tolerantly', () => {
    const start = baseState([
      makeChar('sophie', { aliases: ['Foster'], name: 'Sophie Foster' }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyAddAlias({ characterId: 'sophie', aliasName: '  foster  ' }),
    );
    /* Same alias just with different casing/whitespace → no change. */
    expect(next.characters[0].aliases).toEqual(['Foster']);
  });

  it('refuses to add the character\'s own name as an alias', () => {
    const start = baseState([makeChar('sophie', { name: 'Sophie Foster' })]);
    const next = castSlice.reducer(
      start,
      castActions.applyAddAlias({ characterId: 'sophie', aliasName: 'Sophie Foster' }),
    );
    expect(next.characters[0].aliases).toBeUndefined();
  });

  it('no-ops for an unknown characterId or empty alias', () => {
    const start = baseState([
      makeChar('sophie', { aliases: ['Foster'], name: 'Sophie Foster' }),
    ]);
    const r1 = castSlice.reducer(
      start,
      castActions.applyAddAlias({ characterId: 'ghost', aliasName: 'Foo' }),
    );
    expect(r1).toEqual(start);
    const r2 = castSlice.reducer(
      start,
      castActions.applyAddAlias({ characterId: 'sophie', aliasName: '   ' }),
    );
    expect(r2.characters[0].aliases).toEqual(['Foster']);
  });
});

describe('castSlice — setVoiceStyle (plan 108)', () => {
  it('sets the voice-design persona on the matching character', () => {
    const start = baseState([makeChar('sophie'), makeChar('keefe')]);
    const next = castSlice.reducer(
      start,
      castActions.setVoiceStyle({
        characterId: 'sophie',
        voiceStyle: 'a poised, confident teenage girl, warm and mid-paced',
      }),
    );
    expect(next.characters.find((c) => c.id === 'sophie')!.voiceStyle).toBe(
      'a poised, confident teenage girl, warm and mid-paced',
    );
    /* Other characters untouched. */
    expect(next.characters.find((c) => c.id === 'keefe')!.voiceStyle).toBeUndefined();
  });

  it('overwrites an existing persona (re-generate)', () => {
    const start = baseState([makeChar('sophie', { voiceStyle: 'old persona' })]);
    const next = castSlice.reducer(
      start,
      castActions.setVoiceStyle({ characterId: 'sophie', voiceStyle: 'new persona' }),
    );
    expect(next.characters[0].voiceStyle).toBe('new persona');
  });

  it('no-ops when the character id is not in the slice', () => {
    const start = baseState([makeChar('sophie')]);
    const next = castSlice.reducer(
      start,
      castActions.setVoiceStyle({ characterId: 'ghost', voiceStyle: 'whatever' }),
    );
    expect(next).toEqual(start);
  });
});

describe('castSlice — renameCharacter (rename + promote alias)', () => {
  it('renames to a brand-new name and demotes the old name into aliases', () => {
    const start = baseState([makeChar('alina', { name: 'Dame Alina' })]);
    const next = castSlice.reducer(
      start,
      castActions.renameCharacter({ characterId: 'alina', name: 'Councilor Alina' }),
    );
    const c = next.characters[0];
    expect(c.name).toBe('Councilor Alina');
    expect(c.aliases).toEqual(['Dame Alina']);
  });

  it('promotes an existing alias to the primary name and swaps the old name in', () => {
    const start = baseState([
      makeChar('dex', { name: 'Dex', aliases: ['Dexter Alvin Diznee', 'Dexy'] }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.renameCharacter({ characterId: 'dex', name: 'Dexter Alvin Diznee' }),
    );
    const c = next.characters[0];
    /* Promoted alias becomes the name and leaves the alias list; old primary
       takes its place — a lossless swap. */
    expect(c.name).toBe('Dexter Alvin Diznee');
    expect(c.aliases).toEqual(['Dexy', 'Dex']);
  });

  it('dedupes case-insensitively — no double-add of the demoted old name', () => {
    /* New name matches an existing alias only by casing; old name already
       present in aliases (different casing). Neither should duplicate. */
    const start = baseState([
      makeChar('alina', { name: 'Dame Alina', aliases: ['councilor alina', 'dame alina'] }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.renameCharacter({ characterId: 'alina', name: 'Councilor Alina' }),
    );
    const c = next.characters[0];
    expect(c.name).toBe('Councilor Alina');
    /* 'councilor alina' stripped (it's now the name); 'dame alina' kept, and
       the demoted 'Dame Alina' not re-added because it already matches. */
    expect(c.aliases).toEqual(['dame alina']);
  });

  it('no-ops on an empty / whitespace-only name', () => {
    const start = baseState([makeChar('alina', { name: 'Dame Alina' })]);
    const next = castSlice.reducer(
      start,
      castActions.renameCharacter({ characterId: 'alina', name: '   ' }),
    );
    expect(next).toEqual(start);
  });

  it('no-ops for an unknown characterId', () => {
    const start = baseState([makeChar('alina', { name: 'Dame Alina' })]);
    const next = castSlice.reducer(
      start,
      castActions.renameCharacter({ characterId: 'ghost', name: 'Whoever' }),
    );
    expect(next).toEqual(start);
  });

  it('no-ops when the name is unchanged apart from casing/whitespace', () => {
    const start = baseState([makeChar('alina', { name: 'Dame Alina', aliases: ['Alina'] })]);
    const next = castSlice.reducer(
      start,
      castActions.renameCharacter({ characterId: 'alina', name: '  dame alina  ' }),
    );
    /* Same name → aliases untouched, no self-demotion. */
    expect(next).toEqual(start);
  });
});

describe('castSlice — setRenderedFallback (fe-16)', () => {
  it('overwrites the fallback map from the book-state hydrate', () => {
    const start = { characters: [makeChar('sweeney')], renderedFallbackByCharacter: {} };
    const next = castSlice.reducer(
      start,
      castActions.setRenderedFallback({ sweeney: 'kokoro' }),
    );
    expect(next.renderedFallbackByCharacter).toEqual({ sweeney: 'kokoro' });
  });

  it('clears stale entries when the new map is empty (post-redesign render)', () => {
    const start = {
      characters: [makeChar('sweeney')],
      renderedFallbackByCharacter: { sweeney: 'kokoro' },
    };
    const next = castSlice.reducer(start, castActions.setRenderedFallback({}));
    expect(next.renderedFallbackByCharacter).toEqual({});
  });
});

describe('castSlice — applyNotLinked / removeNotLinked (cross-book variant, plan 101 + fs-11)', () => {
  it('applyNotLinked appends the symmetric entry; dedups on repeat', () => {
    const start = baseState([makeChar('eliza')]);
    const once = castSlice.reducer(
      start,
      castActions.applyNotLinked({
        characterId: 'eliza',
        otherBookId: 'sb',
        otherCharacterId: 'eliza_sb',
      }),
    );
    expect(once.characters[0].notLinkedTo).toEqual([{ bookId: 'sb', characterId: 'eliza_sb' }]);
    const twice = castSlice.reducer(
      once,
      castActions.applyNotLinked({
        characterId: 'eliza',
        otherBookId: 'sb',
        otherCharacterId: 'eliza_sb',
      }),
    );
    expect(twice.characters[0].notLinkedTo).toEqual([{ bookId: 'sb', characterId: 'eliza_sb' }]);
  });

  it('removeNotLinked strips the matching pair, leaving any others intact', () => {
    const start = baseState([
      makeChar('eliza', {
        notLinkedTo: [
          { bookId: 'sb', characterId: 'eliza_sb' },
          { bookId: 'tb', characterId: 'eliza_tb' },
        ],
      }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.removeNotLinked({
        characterId: 'eliza',
        otherBookId: 'sb',
        otherCharacterId: 'eliza_sb',
      }),
    );
    expect(next.characters[0].notLinkedTo).toEqual([{ bookId: 'tb', characterId: 'eliza_tb' }]);
  });

  it('removeNotLinked is a no-op for an absent pair or missing character', () => {
    const start = baseState([makeChar('eliza', { notLinkedTo: [] })]);
    const sameAbsent = castSlice.reducer(
      start,
      castActions.removeNotLinked({
        characterId: 'eliza',
        otherBookId: 'sb',
        otherCharacterId: 'eliza_sb',
      }),
    );
    expect(sameAbsent.characters[0].notLinkedTo).toEqual([]);
    const ghost = castSlice.reducer(
      start,
      castActions.removeNotLinked({
        characterId: 'ghost',
        otherBookId: 'sb',
        otherCharacterId: 'eliza_sb',
      }),
    );
    expect(ghost).toEqual(start);
  });
});

