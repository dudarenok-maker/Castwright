// Pairs with docs/features/archive/09-voice-match-pipeline.md

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
       analyzer doesn't always fill it in. Without this default,
       freshly-analysed characters land in the Cast view with the Status
       column empty even though their voices were just generated. */
    const { voiceState: _omit, ...narratorNoState } = makeChar('narrator');
    const next = castSlice.reducer(
      baseState([]),
      castActions.hydrateFromAnalysis(
        baseAnalysis([narratorNoState as Character, makeChar('Marlow', { voiceState: 'locked' })]),
      ),
    );
    expect(next.characters.find((c) => c.id === 'narrator')!.voiceState).toBe('generated');
    expect(next.characters.find((c) => c.id === 'Marlow')!.voiceState).toBe('locked');
  });

  it('is a no-op when the response has no characters', () => {
    const start = baseState([makeChar('halloran', { voiceState: 'tuned' })]);
    const next = castSlice.reducer(start, castActions.hydrateFromAnalysis(baseAnalysis([])));
    expect(next.characters).toEqual(start.characters);
  });

  it('preserves a designed-in-this-book Qwen voice when the analysis payload returns it voiceless (confirm-screen strip)', () => {
    /* The /confirm payload (AnalysingView onComplete → hydrateFromAnalysis) carries
       voice continuity only for characters matched against OTHER books in the series.
       A character DESIGNED IN THIS BOOK (overrideTtsVoices.qwen, no matchedFrom) finds
       no series match and arrives voiceless, so a flat replace stripped it on the
       confirm screen — rendering "No voice designed yet" for Berrin/Sela/Quill even
       though cast.json on disk still held the voice. Mirror the mergeCharacters #518
       overlay: preserve voice-design fields by id from the existing slice. */
    const start = baseState([
      makeChar('Berrin', {
        voiceState: 'generated',
        overrideTtsVoices: { qwen: { name: 'qwen-Berrin' } },
        ttsEngine: 'qwen',
        voiceStyle: 'a bright, eager teenage girl, quick and clear.',
      }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.hydrateFromAnalysis(
        baseAnalysis([
          {
            id: 'Berrin',
            name: 'Berrin',
            role: 'Peer',
            color: 'slot-18',
            description: 'Re-attributed.',
          } as Character,
        ]),
      ),
    );
    const Berrin = next.characters.find((c) => c.id === 'Berrin')!;
    expect(Berrin.overrideTtsVoices).toEqual({ qwen: { name: 'qwen-Berrin' } });
    expect(Berrin.ttsEngine).toBe('qwen');
    expect(Berrin.voiceStyle).toBe('a bright, eager teenage girl, quick and clear.');
    expect(Berrin.voiceState).toBe('generated');
    /* Fresh analyzer-owned fields still flow through. */
    expect(Berrin.description).toBe('Re-attributed.');
  });

  it('preserves a reused/linked voice but lets a fresh series-reuse link flow through', () => {
    /* Existing reused link must survive a voiceless re-analysis; a NEWLY stamped
       matchedFrom on a previously-voiceless character (the analyzer's series-reuse
       pass) must still flow through (existing-wins only when existing has it). */
    const start = baseState([
      makeChar('lord-Vane', {
        voiceState: 'reused',
        voiceId: 'qwen-lord-Vane',
        matchedFrom: { bookTitle: 'The Tidewatcher's Oath', confidence: 0.9 },
      }),
      makeChar('newcomer', { voiceState: 'generated' }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.hydrateFromAnalysis(
        baseAnalysis([
          {
            id: 'lord-Vane',
            name: 'Lord Vane',
            role: 'Antagonist',
            color: 'slot-2',
          } as Character,
          {
            id: 'newcomer',
            name: 'Newcomer',
            role: 'Peer',
            color: 'slot-9',
            matchedFrom: { bookTitle: 'Exile', confidence: 0.88 },
          } as Character,
        ]),
      ),
    );
    const Vane = next.characters.find((c) => c.id === 'lord-Vane')!;
    expect(Vane.voiceId).toBe('qwen-lord-Vane');
    expect(Vane.voiceState).toBe('reused');
    expect(Vane.matchedFrom).toEqual({ bookTitle: 'The Tidewatcher's Oath', confidence: 0.9 });
    const newcomer = next.characters.find((c) => c.id === 'newcomer')!;
    expect(newcomer.matchedFrom).toEqual({ bookTitle: 'Exile', confidence: 0.88 });
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
      castActions.mergeCharacters([makeChar('narrator'), makeChar('Wren')]),
    );
    expect(next.characters.map((c) => c.id)).toEqual(['narrator', 'Wren']);
    expect(next.characters[0].voiceState).toBe('generated');
  });

  it('upserts by id and preserves locked voiceId / matchedFrom on the existing entry', () => {
    /* User had matched Wren to a previous-book voice + locked it; a
       later cast-update snapshot from the analyzer must NOT clobber
       voiceId / matchedFrom / voiceState='locked'. */
    const start = baseState([
      makeChar('Wren', {
        voiceState: 'locked',
        voiceId: 'v_Wren_from_book1',
        matchedFrom: { bookTitle: 'KOTC #1', confidence: 0.94 },
      }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.mergeCharacters([
        /* Snapshot from a later chapter — analyzer doesn't know about the lock. */
        {
          id: 'Wren',
          name: 'Wren Sparrow',
          role: 'protagonist',
          color: 'orange',
          description: 'Updated richer description.',
        },
      ]),
    );
    const Wren = next.characters.find((c) => c.id === 'Wren')!;
    expect(Wren.voiceId).toBe('v_Wren_from_book1');
    expect(Wren.voiceState).toBe('locked');
    expect(Wren.matchedFrom).toEqual({ bookTitle: 'KOTC #1', confidence: 0.94 });
    /* New fields from the snapshot still flow through. */
    expect(Wren.name).toBe('Wren Sparrow');
    expect(Wren.description).toBe('Updated richer description.');
  });

  it('preserves a designed Qwen voice (overrideTtsVoices) through a voiceless cast-update (#518)', () => {
    /* Re-analysis streams a voiceless snapshot (analyzer doesn't produce voice
       design). mergeCharacters must NOT drop overrideTtsVoices — the designed
       Qwen voice lives there for generated characters with no voiceId. Dropping
       it then persisting cast.json is what stripped Berrin/Sela/Quill. */
    const start = baseState([
      makeChar('Berrin', {
        voiceState: 'generated',
        overrideTtsVoices: { qwen: { name: 'qwen-Berrin' } },
      }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.mergeCharacters([
        {
          id: 'Berrin',
          name: 'Berrin',
          role: 'Peer',
          color: 'slot-18',
          description: 'Re-attributed.',
        },
      ]),
    );
    const Berrin = next.characters.find((c) => c.id === 'Berrin')!;
    expect(Berrin.overrideTtsVoices).toEqual({ qwen: { name: 'qwen-Berrin' } });
    expect(Berrin.voiceState).toBe('generated');
    expect(Berrin.description).toBe('Re-attributed.'); // fresh fields still flow
  });

  it('appends new characters from a later snapshot at the end (preserves discovery order)', () => {
    const start = baseState([makeChar('Wren'), makeChar('Marlow')]);
    const next = castSlice.reducer(
      start,
      castActions.mergeCharacters([
        makeChar('Wren'),
        makeChar('Marlow'),
        makeChar('Maerin') /* New in chapter 5 */,
      ]),
    );
    expect(next.characters.map((c) => c.id)).toEqual(['Wren', 'Marlow', 'Maerin']);
  });

  it('preserves locally-known characters the snapshot omitted (defensive — full snapshots in practice)', () => {
    const start = baseState([makeChar('Wren', { voiceState: 'locked' }), makeChar('Marlow')]);
    /* Snapshot only has 'Wren' — 'Marlow' should still be present. */
    const next = castSlice.reducer(
      start,
      castActions.mergeCharacters([makeChar('Wren', { description: 'updated' })]),
    );
    expect(next.characters.map((c) => c.id).sort()).toEqual(['Marlow', 'Wren']);
    expect(next.characters.find((c) => c.id === 'Wren')!.voiceState).toBe('locked');
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
      makeChar('Wren', { voiceState: 'generated' }),
      makeChar('Wren-foster', {
        voiceState: 'locked',
        voiceId: 'v_Wren_from_book1',
        matchedFrom: { bookTitle: 'KOTC #1', confidence: 0.94 },
      }),
      makeChar('Marlow', { voiceState: 'tuned', voiceId: 'v_Marlow' }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyMerge({
        characters: [
          {
            id: 'Wren-foster',
            name: 'Wren Sparrow',
            role: 'protagonist',
            color: 'orange',
            lines: 17,
            scenes: 6,
            aliases: ['Wren'],
            voiceState: undefined as unknown as Character['voiceState'],
          },
          {
            id: 'Marlow',
            name: 'Marlow Halden',
            role: 'sidekick',
            color: 'halloran',
            lines: 7,
            scenes: 3,
          } as Character,
        ],
      }),
    );
    expect(next.characters.map((c) => c.id)).toEqual(['Wren-foster', 'Marlow']);
    const survivor = next.characters.find((c) => c.id === 'Wren-foster')!;
    /* Server-authoritative fields flow through. */
    expect(survivor.aliases).toEqual(['Wren']);
    expect(survivor.lines).toBe(17);
    expect(survivor.scenes).toBe(6);
    /* Local-only fields preserved on the survivor. */
    expect(survivor.voiceState).toBe('locked');
    expect(survivor.voiceId).toBe('v_Wren_from_book1');
    expect(survivor.matchedFrom).toEqual({ bookTitle: 'KOTC #1', confidence: 0.94 });
    /* Untouched characters keep their local voice state too. */
    expect(next.characters.find((c) => c.id === 'Marlow')!.voiceId).toBe('v_Marlow');
    expect(next.characters.find((c) => c.id === 'Marlow')!.voiceState).toBe('tuned');
  });

  it('is a no-op when the payload is missing characters', () => {
    const start = baseState([makeChar('Wren')]);
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
    const start = baseState([makeChar('narrator'), makeChar('Wren')]);
    const incoming: Character = {
      id: 'councillor-Linnet_from_the Hollow Tide',
      name: 'Councillor Linnet',
      role: 'character',
      color: 'unset',
      gender: 'female',
      ageRange: 'adult',
      voiceId: 'v_Linnet',
      voiceState: 'reused',
      matchedFrom: {
        bookId: 'the Hollow Tide-1',
        characterId: 'councillor-Linnet',
        bookTitle: 'The Hollow Tide',
        confidence: 1,
      },
    };
    const next = castSlice.reducer(start, castActions.addCharacter(incoming));
    expect(next.characters).toHaveLength(3);
    expect(next.characters[2]).toEqual(incoming);
  });

  it('is idempotent when an entry with the same id already exists', () => {
    const existing: Character = {
      id: 'Linnet_local',
      name: 'Councillor Linnet',
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
      makeChar('Hartwell-alvin-Vale', { voiceState: 'generated' }),
      makeChar('Wren', { voiceState: 'generated' }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyManualMatch({
        characterId: 'Hartwell-alvin-Vale',
        matchedFrom: {
          bookId: 'the Hollow Tide_1',
          characterId: 'Hart',
          bookTitle: 'Keeper #1',
          confidence: 1,
        },
        voiceId: 'v_Hart',
      }),
    );
    const Hart = next.characters.find((c) => c.id === 'Hartwell-alvin-Vale')!;
    expect(Hart.voiceId).toBe('v_Hart');
    expect(Hart.voiceState).toBe('reused');
    expect(Hart.matchedFrom).toEqual({
      bookId: 'the Hollow Tide_1',
      characterId: 'Hart',
      bookTitle: 'Keeper #1',
      confidence: 1,
    });
    /* Untouched character is untouched. */
    expect(next.characters.find((c) => c.id === 'Wren')!.voiceState).toBe('generated');
  });

  it('preserves a locked or tuned voice — only matchedFrom is updated', () => {
    /* User already invested in tuning Hartwell's voice; manually linking
       to the prior should record the continuity link without overwriting
       the tuned voiceId or downgrading voiceState. */
    const start = baseState([
      makeChar('Hartwell-alvin-Vale', {
        voiceState: 'tuned',
        voiceId: 'v_Hartwell_tuned',
      }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyManualMatch({
        characterId: 'Hartwell-alvin-Vale',
        matchedFrom: {
          bookId: 'the Hollow Tide_1',
          characterId: 'Hart',
          bookTitle: 'Keeper #1',
          confidence: 1,
        },
        voiceId: 'v_Hart_from_prior',
      }),
    );
    const Hart = next.characters[0];
    expect(Hart.voiceId).toBe('v_Hartwell_tuned');
    expect(Hart.voiceState).toBe('tuned');
    expect(Hart.matchedFrom?.characterId).toBe('Hart');
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

  it('applies the merged profile the server carried over (quotes/attributes/etc.)', () => {
    /* The carry-over fix: the link-prior response now echoes the prior
       character's representative quotes + descriptors so the open drawer
       reflects them without a reload. */
    const start = baseState([makeChar('dame-Linnet_from', { voiceState: 'reused' })]);
    const next = castSlice.reducer(
      start,
      castActions.applyManualMatch({
        characterId: 'dame-Linnet_from',
        matchedFrom: { bookId: 'the Hollow Tide_1', characterId: 'Linnet', bookTitle: 'Saltgrave', confidence: 1 },
        voiceId: 'dame-Linnet',
        profile: {
          evidence: [{ quote: 'The Council has spoken.', note: 'imperious' }],
          attributes: ['imperious', 'vain'],
          description: 'A vain Councillor.',
          gender: 'female',
          ageRange: 'adult',
        },
      }),
    );
    const Linnet = next.characters.find((c) => c.id === 'dame-Linnet_from')!;
    expect(Linnet.evidence).toHaveLength(1);
    expect(Linnet.attributes).toEqual(['imperious', 'vain']);
    expect(Linnet.description).toBe('A vain Councillor.');
    expect(Linnet.gender).toBe('female');
    expect(Linnet.ageRange).toBe('adult');
  });

  it('leaves the profile untouched when the response carries none', () => {
    const start = baseState([
      makeChar('Hartwell-alvin-Vale', { voiceState: 'generated', attributes: ['original'] }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyManualMatch({
        characterId: 'Hartwell-alvin-Vale',
        matchedFrom: { bookId: 'the Hollow Tide_1', characterId: 'Hart', bookTitle: 'Keeper #1', confidence: 1 },
        voiceId: 'v_Hart',
      }),
    );
    expect(next.characters[0].attributes).toEqual(['original']);
  });
});

describe('castSlice — applyUnlinkAlias (POST /cast/unlink-alias response)', () => {
  it('strips the alias from the source and appends the new standalone character', () => {
    const start = baseState([
      makeChar('Saltgrave-figure', {
        aliases: ['Sior', 'Jurek', 'Garrow', 'Shopkeeper'],
        gender: 'male',
        ageRange: 'adult',
      }),
      makeChar('Wren'),
    ]);
    const newCharacter: Character = {
      id: 'Garrow',
      name: 'Garrow',
      role: 'character',
      color: 'narrator',
      gender: 'male',
      ageRange: 'adult',
    } as Character;
    const next = castSlice.reducer(
      start,
      castActions.applyUnlinkAlias({
        sourceCharacterId: 'Saltgrave-figure',
        aliasName: 'Garrow',
        newCharacter,
      }),
    );
    const source = next.characters.find((c) => c.id === 'Saltgrave-figure')!;
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
    const start = baseState([makeChar('Saltgrave-figure', { aliases: ['  Garrow  ', 'Jurek'] })]);
    const next = castSlice.reducer(
      start,
      castActions.applyUnlinkAlias({
        sourceCharacterId: 'Saltgrave-figure',
        aliasName: 'Garrow',
        newCharacter: {
          id: 'Garrow',
          name: 'Garrow',
          role: 'character',
          color: 'narrator',
        } as Character,
      }),
    );
    expect(next.characters.find((c) => c.id === 'Saltgrave-figure')!.aliases).toEqual(['Jurek']);
  });

  it('is idempotent when the new character already exists (network retry safety)', () => {
    const existing = makeChar('Garrow', { voiceState: 'tuned', voiceId: 'v_Garrow' });
    const start = baseState([makeChar('Saltgrave-figure', { aliases: ['Garrow'] }), existing]);
    const next = castSlice.reducer(
      start,
      castActions.applyUnlinkAlias({
        sourceCharacterId: 'Saltgrave-figure',
        aliasName: 'Garrow',
        newCharacter: {
          id: 'Garrow',
          name: 'Garrow',
          role: 'character',
          color: 'narrator',
        } as Character,
      }),
    );
    /* Existing tuned voice is preserved. */
    expect(next.characters).toHaveLength(2);
    expect(next.characters.find((c) => c.id === 'Garrow')).toEqual(existing);
    expect(next.characters.find((c) => c.id === 'Saltgrave-figure')!.aliases).toEqual([]);
  });
});

describe('castSlice — applyAddAlias (POST /cast/add-alias response)', () => {
  it('appends a new alias to the target character', () => {
    const start = baseState([makeChar('Wren', { aliases: ['Foster'], name: 'Wren Sparrow' })]);
    const next = castSlice.reducer(
      start,
      castActions.applyAddAlias({ characterId: 'Wren', aliasName: 'Sofi' }),
    );
    expect(next.characters[0].aliases).toEqual(['Foster', 'Sofi']);
  });

  it('dedupes case-insensitively and trim-tolerantly', () => {
    const start = baseState([makeChar('Wren', { aliases: ['Foster'], name: 'Wren Sparrow' })]);
    const next = castSlice.reducer(
      start,
      castActions.applyAddAlias({ characterId: 'Wren', aliasName: '  foster  ' }),
    );
    /* Same alias just with different casing/whitespace → no change. */
    expect(next.characters[0].aliases).toEqual(['Foster']);
  });

  it("refuses to add the character's own name as an alias", () => {
    const start = baseState([makeChar('Wren', { name: 'Wren Sparrow' })]);
    const next = castSlice.reducer(
      start,
      castActions.applyAddAlias({ characterId: 'Wren', aliasName: 'Wren Sparrow' }),
    );
    expect(next.characters[0].aliases).toBeUndefined();
  });

  it('no-ops for an unknown characterId or empty alias', () => {
    const start = baseState([makeChar('Wren', { aliases: ['Foster'], name: 'Wren Sparrow' })]);
    const r1 = castSlice.reducer(
      start,
      castActions.applyAddAlias({ characterId: 'ghost', aliasName: 'Foo' }),
    );
    expect(r1).toEqual(start);
    const r2 = castSlice.reducer(
      start,
      castActions.applyAddAlias({ characterId: 'Wren', aliasName: '   ' }),
    );
    expect(r2.characters[0].aliases).toEqual(['Foster']);
  });
});

describe('castSlice — setVoiceStyle (plan 108)', () => {
  it('sets the voice-design persona on the matching character', () => {
    const start = baseState([makeChar('Wren'), makeChar('Marlow')]);
    const next = castSlice.reducer(
      start,
      castActions.setVoiceStyle({
        characterId: 'Wren',
        voiceStyle: 'a poised, confident teenage girl, warm and mid-paced',
      }),
    );
    expect(next.characters.find((c) => c.id === 'Wren')!.voiceStyle).toBe(
      'a poised, confident teenage girl, warm and mid-paced',
    );
    /* Other characters untouched. */
    expect(next.characters.find((c) => c.id === 'Marlow')!.voiceStyle).toBeUndefined();
  });

  it('overwrites an existing persona (re-generate)', () => {
    const start = baseState([makeChar('Wren', { voiceStyle: 'old persona' })]);
    const next = castSlice.reducer(
      start,
      castActions.setVoiceStyle({ characterId: 'Wren', voiceStyle: 'new persona' }),
    );
    expect(next.characters[0].voiceStyle).toBe('new persona');
  });

  it('no-ops when the character id is not in the slice', () => {
    const start = baseState([makeChar('Wren')]);
    const next = castSlice.reducer(
      start,
      castActions.setVoiceStyle({ characterId: 'ghost', voiceStyle: 'whatever' }),
    );
    expect(next).toEqual(start);
  });
});

describe('castSlice — renameCharacter (rename + promote alias)', () => {
  it('renames to a brand-new name and demotes the old name into aliases', () => {
    const start = baseState([makeChar('Linnet', { name: 'Dame Linnet' })]);
    const next = castSlice.reducer(
      start,
      castActions.renameCharacter({ characterId: 'Linnet', name: 'Councilor Linnet' }),
    );
    const c = next.characters[0];
    expect(c.name).toBe('Councilor Linnet');
    expect(c.aliases).toEqual(['Dame Linnet']);
  });

  it('promotes an existing alias to the primary name and swaps the old name in', () => {
    const start = baseState([
      makeChar('Hart', { name: 'Hart', aliases: ['Hartwell Brennan Vale', 'Hartie'] }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.renameCharacter({ characterId: 'Hart', name: 'Hartwell Brennan Vale' }),
    );
    const c = next.characters[0];
    /* Promoted alias becomes the name and leaves the alias list; old primary
       takes its place — a lossless swap. */
    expect(c.name).toBe('Hartwell Brennan Vale');
    expect(c.aliases).toEqual(['Hartie', 'Hart']);
  });

  it('dedupes case-insensitively — no double-add of the demoted old name', () => {
    /* New name matches an existing alias only by casing; old name already
       present in aliases (different casing). Neither should duplicate. */
    const start = baseState([
      makeChar('Linnet', { name: 'Dame Linnet', aliases: ['councilor Linnet', 'Dame Linnet'] }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.renameCharacter({ characterId: 'Linnet', name: 'Councilor Linnet' }),
    );
    const c = next.characters[0];
    expect(c.name).toBe('Councilor Linnet');
    /* 'councilor Linnet' stripped (it's now the name); 'Dame Linnet' kept, and
       the demoted 'Dame Linnet' not re-added because it already matches. */
    expect(c.aliases).toEqual(['Dame Linnet']);
  });

  it('no-ops on an empty / whitespace-only name', () => {
    const start = baseState([makeChar('Linnet', { name: 'Dame Linnet' })]);
    const next = castSlice.reducer(
      start,
      castActions.renameCharacter({ characterId: 'Linnet', name: '   ' }),
    );
    expect(next).toEqual(start);
  });

  it('no-ops for an unknown characterId', () => {
    const start = baseState([makeChar('Linnet', { name: 'Dame Linnet' })]);
    const next = castSlice.reducer(
      start,
      castActions.renameCharacter({ characterId: 'ghost', name: 'Whoever' }),
    );
    expect(next).toEqual(start);
  });

  it('no-ops when the name is unchanged apart from casing/whitespace', () => {
    const start = baseState([makeChar('Linnet', { name: 'Dame Linnet', aliases: ['Linnet'] })]);
    const next = castSlice.reducer(
      start,
      castActions.renameCharacter({ characterId: 'Linnet', name: '  Dame Linnet  ' }),
    );
    /* Same name → aliases untouched, no self-demotion. */
    expect(next).toEqual(start);
  });
});

describe('castSlice — setRenderedFallback (fe-16)', () => {
  it('overwrites the fallback map from the book-state hydrate', () => {
    const start = { characters: [makeChar('Marrow')], renderedFallbackByCharacter: {} };
    const next = castSlice.reducer(start, castActions.setRenderedFallback({ Marrow: 'kokoro' }));
    expect(next.renderedFallbackByCharacter).toEqual({ Marrow: 'kokoro' });
  });

  it('clears stale entries when the new map is empty (post-redesign render)', () => {
    const start = {
      characters: [makeChar('Marrow')],
      renderedFallbackByCharacter: { Marrow: 'kokoro' },
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

describe('castSlice — mergeCharacters (srv-13 preservation)', () => {
  it('preserves voice fields, notLinkedTo and unions aliases on a surviving character', () => {
    const start = baseState([
      makeChar('Marlow', {
        voiceState: 'reused',
        voiceId: 'Marlow',
        matchedFrom: { bookId: 'b0', characterId: 'Marlow', confidence: 0.9 },
        overrideTtsVoices: { qwen: { name: 'qwen-Marlow' } },
        ttsEngine: 'qwen',
        voiceStyle: 'witty',
        notLinkedTo: [{ bookId: 'b1', characterId: 'Marlow-young' }],
        aliases: ['Marlow', 'Sir Singe'],
      }),
    ]);
    // Analyzer snapshot: same id, fresh attribution, NO voice/link fields,
    // a sparser alias set.
    const next = castSlice.reducer(
      start,
      castActions.mergeCharacters([makeChar('Marlow', { aliases: ['Marlow', 'Mr. Halden'] })]),
    );
    const Marlow = next.characters[0];
    expect(Marlow.voiceId).toBe('Marlow');
    expect(Marlow.voiceState).toBe('reused');
    expect(Marlow.matchedFrom).toEqual({ bookId: 'b0', characterId: 'Marlow', confidence: 0.9 });
    expect(Marlow.overrideTtsVoices).toEqual({ qwen: { name: 'qwen-Marlow' } });
    expect(Marlow.ttsEngine).toBe('qwen');
    expect(Marlow.voiceStyle).toBe('witty');
    expect(Marlow.notLinkedTo).toEqual([{ bookId: 'b1', characterId: 'Marlow-young' }]);
    expect(Marlow.aliases).toEqual(['Marlow', 'Sir Singe', 'Mr. Halden']);
  });
});

describe('castSlice — applyMerge (srv-13 preservation)', () => {
  it('preserves designed voice, persona, notLinkedTo and unions aliases (server omits them)', () => {
    const start = baseState([
      makeChar('Wren', {
        voiceState: 'reused',
        voiceId: 'Wren',
        matchedFrom: { bookId: 'b0', characterId: 'Wren', confidence: 0.92 },
        overrideTtsVoices: { qwen: { name: 'qwen-Wren' } },
        ttsEngine: 'qwen',
        voiceStyle: 'earnest',
        notLinkedTo: [{ bookId: 'b1', characterId: 'Wren-teen' }],
        aliases: ['Wren Sparrow'],
      }),
    ]);
    // Server merge response: authoritative roster but no voice fields, sparse aliases.
    const next = castSlice.reducer(
      start,
      castActions.applyMerge({ characters: [makeChar('Wren', { aliases: ['Soph'] })] }),
    );
    const Wren = next.characters[0];
    expect(Wren.voiceId).toBe('Wren');
    expect(Wren.voiceState).toBe('reused');
    expect(Wren.overrideTtsVoices).toEqual({ qwen: { name: 'qwen-Wren' } });
    expect(Wren.ttsEngine).toBe('qwen');
    expect(Wren.voiceStyle).toBe('earnest');
    expect(Wren.notLinkedTo).toEqual([{ bookId: 'b1', characterId: 'Wren-teen' }]);
    expect(Wren.aliases).toEqual(['Wren Sparrow', 'Soph']);
  });
});

describe('castSlice — removeCharacterEmotionVariant (fs-34)', () => {
  const withVariants = () =>
    baseState([
      makeChar('Maerin', {
        overrideTtsVoices: {
          qwen: {
            name: 'qwen-v_Maerin',
            variants: {
              angry: { name: 'qwen-v_Maerin__angry' },
              sad: { name: 'qwen-v_Maerin__sad' },
            },
          },
        },
      }),
    ]);

  it('drops one variant, leaving base + siblings intact', () => {
    const next = castSlice.reducer(
      withVariants(),
      castActions.removeCharacterEmotionVariant({ characterId: 'Maerin', emotion: 'angry' }),
    );
    const qwen = next.characters[0].overrideTtsVoices!.qwen!;
    expect(qwen.variants).toEqual({ sad: { name: 'qwen-v_Maerin__sad' } });
    expect(qwen.name).toBe('qwen-v_Maerin');
  });

  it('clears the variants map when the last variant is removed', () => {
    const single = baseState([
      makeChar('Maerin', {
        overrideTtsVoices: { qwen: { name: 'qwen-v_Maerin', variants: { angry: { name: 'x' } } } },
      }),
    ]);
    const next = castSlice.reducer(
      single,
      castActions.removeCharacterEmotionVariant({ characterId: 'Maerin', emotion: 'angry' }),
    );
    expect(next.characters[0].overrideTtsVoices!.qwen!.variants).toBeUndefined();
  });

  it('is a no-op for an unknown character or absent variant', () => {
    const start = withVariants();
    const unknown = castSlice.reducer(
      start,
      castActions.removeCharacterEmotionVariant({ characterId: 'ghost', emotion: 'angry' }),
    );
    expect(unknown.characters[0].overrideTtsVoices!.qwen!.variants).toEqual({
      angry: { name: 'qwen-v_Maerin__angry' },
      sad: { name: 'qwen-v_Maerin__sad' },
    });
    const absent = castSlice.reducer(
      start,
      castActions.removeCharacterEmotionVariant({ characterId: 'Maerin', emotion: 'excited' }),
    );
    expect(Object.keys(absent.characters[0].overrideTtsVoices!.qwen!.variants!)).toHaveLength(2);
  });
});
