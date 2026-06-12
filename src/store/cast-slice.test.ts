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
        baseAnalysis([narratorNoState as Character, makeChar('marlow', { voiceState: 'locked' })]),
      ),
    );
    expect(next.characters.find((c) => c.id === 'narrator')!.voiceState).toBe('generated');
    expect(next.characters.find((c) => c.id === 'marlow')!.voiceState).toBe('locked');
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
      makeChar('berrin', {
        voiceState: 'generated',
        overrideTtsVoices: { qwen: { name: 'qwen-berrin' } },
        ttsEngine: 'qwen',
        voiceStyle: 'a bright, eager teenage girl, quick and clear.',
      }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.hydrateFromAnalysis(
        baseAnalysis([
          {
            id: 'berrin',
            name: 'Berrin',
            role: 'Peer',
            color: 'slot-18',
            description: 'Re-attributed.',
          } as Character,
        ]),
      ),
    );
    const berrin = next.characters.find((c) => c.id === 'berrin')!;
    expect(berrin.overrideTtsVoices).toEqual({ qwen: { name: 'qwen-berrin' } });
    expect(berrin.ttsEngine).toBe('qwen');
    expect(berrin.voiceStyle).toBe('a bright, eager teenage girl, quick and clear.');
    expect(berrin.voiceState).toBe('generated');
    /* Fresh analyzer-owned fields still flow through. */
    expect(berrin.description).toBe('Re-attributed.');
  });

  it('preserves a reused/linked voice but lets a fresh series-reuse link flow through', () => {
    /* Existing reused link must survive a voiceless re-analysis; a NEWLY stamped
       matchedFrom on a previously-voiceless character (the analyzer's series-reuse
       pass) must still flow through (existing-wins only when existing has it). */
    const start = baseState([
      makeChar('lord-vane', {
        voiceState: 'reused',
        voiceId: 'qwen-lord-vane',
        matchedFrom: { bookTitle: 'The Tidewatcher’s Oath', confidence: 0.9 },
      }),
      makeChar('newcomer', { voiceState: 'generated' }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.hydrateFromAnalysis(
        baseAnalysis([
          {
            id: 'lord-vane',
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
    const vane = next.characters.find((c) => c.id === 'lord-vane')!;
    expect(vane.voiceId).toBe('qwen-lord-vane');
    expect(vane.voiceState).toBe('reused');
    expect(vane.matchedFrom).toEqual({ bookTitle: 'The Tidewatcher’s Oath', confidence: 0.9 });
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
      castActions.mergeCharacters([makeChar('narrator'), makeChar('wren')]),
    );
    expect(next.characters.map((c) => c.id)).toEqual(['narrator', 'wren']);
    expect(next.characters[0].voiceState).toBe('generated');
  });

  it('upserts by id and preserves locked voiceId / matchedFrom on the existing entry', () => {
    /* User had matched Wren to a previous-book voice + locked it; a
       later cast-update snapshot from the analyzer must NOT clobber
       voiceId / matchedFrom / voiceState='locked'. */
    const start = baseState([
      makeChar('wren', {
        voiceState: 'locked',
        voiceId: 'v_wren_from_book1',
        matchedFrom: { bookTitle: 'KOTC #1', confidence: 0.94 },
      }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.mergeCharacters([
        /* Snapshot from a later chapter — analyzer doesn't know about the lock. */
        {
          id: 'wren',
          name: 'Wren Sparrow',
          role: 'protagonist',
          color: 'orange',
          description: 'Updated richer description.',
        },
      ]),
    );
    const wren = next.characters.find((c) => c.id === 'wren')!;
    expect(wren.voiceId).toBe('v_wren_from_book1');
    expect(wren.voiceState).toBe('locked');
    expect(wren.matchedFrom).toEqual({ bookTitle: 'KOTC #1', confidence: 0.94 });
    /* New fields from the snapshot still flow through. */
    expect(wren.name).toBe('Wren Sparrow');
    expect(wren.description).toBe('Updated richer description.');
  });

  it('preserves a designed Qwen voice (overrideTtsVoices) through a voiceless cast-update (#518)', () => {
    /* Re-analysis streams a voiceless snapshot (analyzer doesn't produce voice
       design). mergeCharacters must NOT drop overrideTtsVoices — the designed
       Qwen voice lives there for generated characters with no voiceId. Dropping
       it then persisting cast.json is what stripped Berrin/Sela/Quill. */
    const start = baseState([
      makeChar('berrin', {
        voiceState: 'generated',
        overrideTtsVoices: { qwen: { name: 'qwen-berrin' } },
      }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.mergeCharacters([
        {
          id: 'berrin',
          name: 'Berrin',
          role: 'Peer',
          color: 'slot-18',
          description: 'Re-attributed.',
        },
      ]),
    );
    const berrin = next.characters.find((c) => c.id === 'berrin')!;
    expect(berrin.overrideTtsVoices).toEqual({ qwen: { name: 'qwen-berrin' } });
    expect(berrin.voiceState).toBe('generated');
    expect(berrin.description).toBe('Re-attributed.'); // fresh fields still flow
  });

  it('appends new characters from a later snapshot at the end (preserves discovery order)', () => {
    const start = baseState([makeChar('wren'), makeChar('marlow')]);
    const next = castSlice.reducer(
      start,
      castActions.mergeCharacters([
        makeChar('wren'),
        makeChar('marlow'),
        makeChar('maerin') /* New in chapter 5 */,
      ]),
    );
    expect(next.characters.map((c) => c.id)).toEqual(['wren', 'marlow', 'maerin']);
  });

  it('preserves locally-known characters the snapshot omitted (defensive — full snapshots in practice)', () => {
    const start = baseState([makeChar('wren', { voiceState: 'locked' }), makeChar('marlow')]);
    /* Snapshot only has 'wren' — 'marlow' should still be present. */
    const next = castSlice.reducer(
      start,
      castActions.mergeCharacters([makeChar('wren', { description: 'updated' })]),
    );
    expect(next.characters.map((c) => c.id).sort()).toEqual(['marlow', 'wren']);
    expect(next.characters.find((c) => c.id === 'wren')!.voiceState).toBe('locked');
  });

  it('is a no-op for an empty incoming list', () => {
    const start = baseState([makeChar('wren')]);
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
      makeChar('wren', { voiceState: 'generated' }),
      makeChar('wren-sparrow', {
        voiceState: 'locked',
        voiceId: 'v_wren_from_book1',
        matchedFrom: { bookTitle: 'KOTC #1', confidence: 0.94 },
      }),
      makeChar('marlow', { voiceState: 'tuned', voiceId: 'v_marlow' }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyMerge({
        characters: [
          {
            id: 'wren-sparrow',
            name: 'Wren Sparrow',
            role: 'protagonist',
            color: 'orange',
            lines: 17,
            scenes: 6,
            aliases: ['Wren'],
            voiceState: undefined as unknown as Character['voiceState'],
          },
          {
            id: 'marlow',
            name: 'Marlow Halden',
            role: 'sidekick',
            color: 'halloran',
            lines: 7,
            scenes: 3,
          } as Character,
        ],
      }),
    );
    expect(next.characters.map((c) => c.id)).toEqual(['wren-sparrow', 'marlow']);
    const survivor = next.characters.find((c) => c.id === 'wren-sparrow')!;
    /* Server-authoritative fields flow through. */
    expect(survivor.aliases).toEqual(['Wren']);
    expect(survivor.lines).toBe(17);
    expect(survivor.scenes).toBe(6);
    /* Local-only fields preserved on the survivor. */
    expect(survivor.voiceState).toBe('locked');
    expect(survivor.voiceId).toBe('v_wren_from_book1');
    expect(survivor.matchedFrom).toEqual({ bookTitle: 'KOTC #1', confidence: 0.94 });
    /* Untouched characters keep their local voice state too. */
    expect(next.characters.find((c) => c.id === 'marlow')!.voiceId).toBe('v_marlow');
    expect(next.characters.find((c) => c.id === 'marlow')!.voiceState).toBe('tuned');
  });

  it('is a no-op when the payload is missing characters', () => {
    const start = baseState([makeChar('wren')]);
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
    const start = baseState([makeChar('narrator'), makeChar('wren')]);
    const incoming: Character = {
      id: 'councillor-linnet_from_the Hollow Tide',
      name: 'Councillor Linnet',
      role: 'character',
      color: 'unset',
      gender: 'female',
      ageRange: 'adult',
      voiceId: 'v_linnet',
      voiceState: 'reused',
      matchedFrom: {
        bookId: 'the Hollow Tide-1',
        characterId: 'councillor-linnet',
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
      id: 'linnet_local',
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
      makeChar('wren', { voiceState: 'generated' }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyManualMatch({
        characterId: 'Hartwell-alvin-Vale',
        matchedFrom: {
          bookId: 'the Hollow Tide_1',
          characterId: 'hart',
          bookTitle: 'Keeper #1',
          confidence: 1,
        },
        voiceId: 'v_hart',
      }),
    );
    const hart = next.characters.find((c) => c.id === 'Hartwell-alvin-Vale')!;
    expect(hart.voiceId).toBe('v_hart');
    expect(hart.voiceState).toBe('reused');
    expect(hart.matchedFrom).toEqual({
      bookId: 'the Hollow Tide_1',
      characterId: 'hart',
      bookTitle: 'Keeper #1',
      confidence: 1,
    });
    /* Untouched character is untouched. */
    expect(next.characters.find((c) => c.id === 'wren')!.voiceState).toBe('generated');
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
          characterId: 'hart',
          bookTitle: 'Keeper #1',
          confidence: 1,
        },
        voiceId: 'v_hart_from_prior',
      }),
    );
    const hart = next.characters[0];
    expect(hart.voiceId).toBe('v_Hartwell_tuned');
    expect(hart.voiceState).toBe('tuned');
    expect(hart.matchedFrom?.characterId).toBe('hart');
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
    const start = baseState([makeChar('dame-linnet_from', { voiceState: 'reused' })]);
    const next = castSlice.reducer(
      start,
      castActions.applyManualMatch({
        characterId: 'dame-linnet_from',
        matchedFrom: { bookId: 'the Hollow Tide_1', characterId: 'linnet', bookTitle: 'Saltgrave', confidence: 1 },
        voiceId: 'dame-linnet',
        profile: {
          evidence: [{ quote: 'The Council has spoken.', note: 'imperious' }],
          attributes: ['imperious', 'vain'],
          description: 'A vain Councillor.',
          gender: 'female',
          ageRange: 'adult',
        },
      }),
    );
    const linnet = next.characters.find((c) => c.id === 'dame-linnet_from')!;
    expect(linnet.evidence).toHaveLength(1);
    expect(linnet.attributes).toEqual(['imperious', 'vain']);
    expect(linnet.description).toBe('A vain Councillor.');
    expect(linnet.gender).toBe('female');
    expect(linnet.ageRange).toBe('adult');
  });

  it('leaves the profile untouched when the response carries none', () => {
    const start = baseState([
      makeChar('Hartwell-alvin-Vale', { voiceState: 'generated', attributes: ['original'] }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyManualMatch({
        characterId: 'Hartwell-alvin-Vale',
        matchedFrom: { bookId: 'the Hollow Tide_1', characterId: 'hart', bookTitle: 'Keeper #1', confidence: 1 },
        voiceId: 'v_hart',
      }),
    );
    expect(next.characters[0].attributes).toEqual(['original']);
  });
});

describe('castSlice — applyUnlinkAlias (POST /cast/unlink-alias response)', () => {
  it('strips the alias from the source and appends the new standalone character', () => {
    const start = baseState([
      makeChar('saltgrave-figure', {
        aliases: ['Sior', 'Jurek', 'Garrow', 'Shopkeeper'],
        gender: 'male',
        ageRange: 'adult',
      }),
      makeChar('wren'),
    ]);
    const newCharacter: Character = {
      id: 'garrow',
      name: 'Garrow',
      role: 'character',
      color: 'narrator',
      gender: 'male',
      ageRange: 'adult',
    } as Character;
    const next = castSlice.reducer(
      start,
      castActions.applyUnlinkAlias({
        sourceCharacterId: 'saltgrave-figure',
        aliasName: 'Garrow',
        newCharacter,
      }),
    );
    const source = next.characters.find((c) => c.id === 'saltgrave-figure')!;
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
    const start = baseState([makeChar('saltgrave-figure', { aliases: ['  Garrow  ', 'Jurek'] })]);
    const next = castSlice.reducer(
      start,
      castActions.applyUnlinkAlias({
        sourceCharacterId: 'saltgrave-figure',
        aliasName: 'garrow',
        newCharacter: {
          id: 'garrow',
          name: 'Garrow',
          role: 'character',
          color: 'narrator',
        } as Character,
      }),
    );
    expect(next.characters.find((c) => c.id === 'saltgrave-figure')!.aliases).toEqual(['Jurek']);
  });

  it('is idempotent when the new character already exists (network retry safety)', () => {
    const existing = makeChar('garrow', { voiceState: 'tuned', voiceId: 'v_garrow' });
    const start = baseState([makeChar('saltgrave-figure', { aliases: ['Garrow'] }), existing]);
    const next = castSlice.reducer(
      start,
      castActions.applyUnlinkAlias({
        sourceCharacterId: 'saltgrave-figure',
        aliasName: 'Garrow',
        newCharacter: {
          id: 'garrow',
          name: 'Garrow',
          role: 'character',
          color: 'narrator',
        } as Character,
      }),
    );
    /* Existing tuned voice is preserved. */
    expect(next.characters).toHaveLength(2);
    expect(next.characters.find((c) => c.id === 'garrow')).toEqual(existing);
    expect(next.characters.find((c) => c.id === 'saltgrave-figure')!.aliases).toEqual([]);
  });
});

describe('castSlice — applyAddAlias (POST /cast/add-alias response)', () => {
  it('appends a new alias to the target character', () => {
    const start = baseState([makeChar('wren', { aliases: ['Foster'], name: 'Wren Sparrow' })]);
    const next = castSlice.reducer(
      start,
      castActions.applyAddAlias({ characterId: 'wren', aliasName: 'Sofi' }),
    );
    expect(next.characters[0].aliases).toEqual(['Foster', 'Sofi']);
  });

  it('dedupes case-insensitively and trim-tolerantly', () => {
    const start = baseState([makeChar('wren', { aliases: ['Foster'], name: 'Wren Sparrow' })]);
    const next = castSlice.reducer(
      start,
      castActions.applyAddAlias({ characterId: 'wren', aliasName: '  foster  ' }),
    );
    /* Same alias just with different casing/whitespace → no change. */
    expect(next.characters[0].aliases).toEqual(['Foster']);
  });

  it("refuses to add the character's own name as an alias", () => {
    const start = baseState([makeChar('wren', { name: 'Wren Sparrow' })]);
    const next = castSlice.reducer(
      start,
      castActions.applyAddAlias({ characterId: 'wren', aliasName: 'Wren Sparrow' }),
    );
    expect(next.characters[0].aliases).toBeUndefined();
  });

  it('no-ops for an unknown characterId or empty alias', () => {
    const start = baseState([makeChar('wren', { aliases: ['Foster'], name: 'Wren Sparrow' })]);
    const r1 = castSlice.reducer(
      start,
      castActions.applyAddAlias({ characterId: 'ghost', aliasName: 'Foo' }),
    );
    expect(r1).toEqual(start);
    const r2 = castSlice.reducer(
      start,
      castActions.applyAddAlias({ characterId: 'wren', aliasName: '   ' }),
    );
    expect(r2.characters[0].aliases).toEqual(['Foster']);
  });
});

describe('castSlice — setVoiceStyle (plan 108)', () => {
  it('sets the voice-design persona on the matching character', () => {
    const start = baseState([makeChar('wren'), makeChar('marlow')]);
    const next = castSlice.reducer(
      start,
      castActions.setVoiceStyle({
        characterId: 'wren',
        voiceStyle: 'a poised, confident teenage girl, warm and mid-paced',
      }),
    );
    expect(next.characters.find((c) => c.id === 'wren')!.voiceStyle).toBe(
      'a poised, confident teenage girl, warm and mid-paced',
    );
    /* Other characters untouched. */
    expect(next.characters.find((c) => c.id === 'marlow')!.voiceStyle).toBeUndefined();
  });

  it('overwrites an existing persona (re-generate)', () => {
    const start = baseState([makeChar('wren', { voiceStyle: 'old persona' })]);
    const next = castSlice.reducer(
      start,
      castActions.setVoiceStyle({ characterId: 'wren', voiceStyle: 'new persona' }),
    );
    expect(next.characters[0].voiceStyle).toBe('new persona');
  });

  it('no-ops when the character id is not in the slice', () => {
    const start = baseState([makeChar('wren')]);
    const next = castSlice.reducer(
      start,
      castActions.setVoiceStyle({ characterId: 'ghost', voiceStyle: 'whatever' }),
    );
    expect(next).toEqual(start);
  });
});

describe('castSlice — renameCharacter (rename + promote alias)', () => {
  it('renames to a brand-new name and demotes the old name into aliases', () => {
    const start = baseState([makeChar('linnet', { name: 'Dame Linnet' })]);
    const next = castSlice.reducer(
      start,
      castActions.renameCharacter({ characterId: 'linnet', name: 'Councilor Linnet' }),
    );
    const c = next.characters[0];
    expect(c.name).toBe('Councilor Linnet');
    expect(c.aliases).toEqual(['Dame Linnet']);
  });

  it('promotes an existing alias to the primary name and swaps the old name in', () => {
    const start = baseState([
      makeChar('hart', { name: 'Hart', aliases: ['Hartwell Brennan Vale', 'Hartie'] }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.renameCharacter({ characterId: 'hart', name: 'Hartwell Brennan Vale' }),
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
      makeChar('linnet', { name: 'Dame Linnet', aliases: ['councilor linnet', 'dame linnet'] }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.renameCharacter({ characterId: 'linnet', name: 'Councilor Linnet' }),
    );
    const c = next.characters[0];
    expect(c.name).toBe('Councilor Linnet');
    /* 'councilor linnet' stripped (it's now the name); 'dame linnet' kept, and
       the demoted 'Dame Linnet' not re-added because it already matches. */
    expect(c.aliases).toEqual(['dame linnet']);
  });

  it('no-ops on an empty / whitespace-only name', () => {
    const start = baseState([makeChar('linnet', { name: 'Dame Linnet' })]);
    const next = castSlice.reducer(
      start,
      castActions.renameCharacter({ characterId: 'linnet', name: '   ' }),
    );
    expect(next).toEqual(start);
  });

  it('no-ops for an unknown characterId', () => {
    const start = baseState([makeChar('linnet', { name: 'Dame Linnet' })]);
    const next = castSlice.reducer(
      start,
      castActions.renameCharacter({ characterId: 'ghost', name: 'Whoever' }),
    );
    expect(next).toEqual(start);
  });

  it('no-ops when the name is unchanged apart from casing/whitespace', () => {
    const start = baseState([makeChar('linnet', { name: 'Dame Linnet', aliases: ['Linnet'] })]);
    const next = castSlice.reducer(
      start,
      castActions.renameCharacter({ characterId: 'linnet', name: '  dame linnet  ' }),
    );
    /* Same name → aliases untouched, no self-demotion. */
    expect(next).toEqual(start);
  });
});

describe('castSlice — setRenderedFallback (fe-16)', () => {
  it('overwrites the fallback map from the book-state hydrate', () => {
    const start = { characters: [makeChar('marrow')], renderedFallbackByCharacter: {} };
    const next = castSlice.reducer(start, castActions.setRenderedFallback({ marrow: 'kokoro' }));
    expect(next.renderedFallbackByCharacter).toEqual({ marrow: 'kokoro' });
  });

  it('clears stale entries when the new map is empty (post-redesign render)', () => {
    const start = {
      characters: [makeChar('marrow')],
      renderedFallbackByCharacter: { marrow: 'kokoro' },
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
      makeChar('marlow', {
        voiceState: 'reused',
        voiceId: 'marlow',
        matchedFrom: { bookId: 'b0', characterId: 'marlow', confidence: 0.9 },
        overrideTtsVoices: { qwen: { name: 'qwen-marlow' } },
        ttsEngine: 'qwen',
        voiceStyle: 'witty',
        notLinkedTo: [{ bookId: 'b1', characterId: 'marlow-young' }],
        aliases: ['Marlow', 'Sir Singe'],
      }),
    ]);
    // Analyzer snapshot: same id, fresh attribution, NO voice/link fields,
    // a sparser alias set.
    const next = castSlice.reducer(
      start,
      castActions.mergeCharacters([makeChar('marlow', { aliases: ['Marlow', 'Mr. Halden'] })]),
    );
    const marlow = next.characters[0];
    expect(marlow.voiceId).toBe('marlow');
    expect(marlow.voiceState).toBe('reused');
    expect(marlow.matchedFrom).toEqual({ bookId: 'b0', characterId: 'marlow', confidence: 0.9 });
    expect(marlow.overrideTtsVoices).toEqual({ qwen: { name: 'qwen-marlow' } });
    expect(marlow.ttsEngine).toBe('qwen');
    expect(marlow.voiceStyle).toBe('witty');
    expect(marlow.notLinkedTo).toEqual([{ bookId: 'b1', characterId: 'marlow-young' }]);
    expect(marlow.aliases).toEqual(['Marlow', 'Sir Singe', 'Mr. Halden']);
  });
});

describe('castSlice — applyMerge (srv-13 preservation)', () => {
  it('preserves designed voice, persona, notLinkedTo and unions aliases (server omits them)', () => {
    const start = baseState([
      makeChar('wren', {
        voiceState: 'reused',
        voiceId: 'wren',
        matchedFrom: { bookId: 'b0', characterId: 'wren', confidence: 0.92 },
        overrideTtsVoices: { qwen: { name: 'qwen-wren' } },
        ttsEngine: 'qwen',
        voiceStyle: 'earnest',
        notLinkedTo: [{ bookId: 'b1', characterId: 'wren-teen' }],
        aliases: ['Wren Sparrow'],
      }),
    ]);
    // Server merge response: authoritative roster but no voice fields, sparse aliases.
    const next = castSlice.reducer(
      start,
      castActions.applyMerge({ characters: [makeChar('wren', { aliases: ['Soph'] })] }),
    );
    const wren = next.characters[0];
    expect(wren.voiceId).toBe('wren');
    expect(wren.voiceState).toBe('reused');
    expect(wren.overrideTtsVoices).toEqual({ qwen: { name: 'qwen-wren' } });
    expect(wren.ttsEngine).toBe('qwen');
    expect(wren.voiceStyle).toBe('earnest');
    expect(wren.notLinkedTo).toEqual([{ bookId: 'b1', characterId: 'wren-teen' }]);
    expect(wren.aliases).toEqual(['Wren Sparrow', 'Soph']);
  });
});

describe('castSlice — removeCharacterEmotionVariant (fs-34)', () => {
  const withVariants = () =>
    baseState([
      makeChar('maerin', {
        overrideTtsVoices: {
          qwen: {
            name: 'qwen-v_maerin',
            variants: {
              angry: { name: 'qwen-v_maerin__angry' },
              sad: { name: 'qwen-v_maerin__sad' },
            },
          },
        },
      }),
    ]);

  it('drops one variant, leaving base + siblings intact', () => {
    const next = castSlice.reducer(
      withVariants(),
      castActions.removeCharacterEmotionVariant({ characterId: 'maerin', emotion: 'angry' }),
    );
    const qwen = next.characters[0].overrideTtsVoices!.qwen!;
    expect(qwen.variants).toEqual({ sad: { name: 'qwen-v_maerin__sad' } });
    expect(qwen.name).toBe('qwen-v_maerin');
  });

  it('clears the variants map when the last variant is removed', () => {
    const single = baseState([
      makeChar('maerin', {
        overrideTtsVoices: { qwen: { name: 'qwen-v_maerin', variants: { angry: { name: 'x' } } } },
      }),
    ]);
    const next = castSlice.reducer(
      single,
      castActions.removeCharacterEmotionVariant({ characterId: 'maerin', emotion: 'angry' }),
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
      angry: { name: 'qwen-v_maerin__angry' },
      sad: { name: 'qwen-v_maerin__sad' },
    });
    const absent = castSlice.reducer(
      start,
      castActions.removeCharacterEmotionVariant({ characterId: 'maerin', emotion: 'excited' }),
    );
    expect(Object.keys(absent.characters[0].overrideTtsVoices!.qwen!.variants!)).toHaveLength(2);
  });
});
