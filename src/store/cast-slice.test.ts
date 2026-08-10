// Pairs with docs/features/archive/09-voice-match-pipeline.md

import { describe, expect, it } from 'vitest';
import { castSlice, castActions, selectCastTierByCharacterId } from './cast-slice';
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
            matchedFrom: { bookTitle: 'The Ebb', confidence: 0.88 },
          } as Character,
        ]),
      ),
    );
    const vane = next.characters.find((c) => c.id === 'lord-vane')!;
    expect(vane.voiceId).toBe('qwen-lord-vane');
    expect(vane.voiceState).toBe('reused');
    expect(vane.matchedFrom).toEqual({ bookTitle: 'The Tidewatcher’s Oath', confidence: 0.9 });
    const newcomer = next.characters.find((c) => c.id === 'newcomer')!;
    expect(newcomer.matchedFrom).toEqual({ bookTitle: 'The Ebb', confidence: 0.88 });
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

describe('castSlice — replaceLiveRoster (Phase 0a full-snapshot replace)', () => {
  it('drops locally-known characters the snapshot omits (verifier-dropped names do not resurrect)', () => {
    /* "Светлане" / "Как" were detected early then dropped by the verifier;
       a later full snapshot omits them and they must NOT linger in the pills. */
    const start = baseState([
      makeChar('svetlana', { name: 'Светлана' }),
      makeChar('svetlane', { name: 'Светлане' }),
      makeChar('kak', { name: 'Как' }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.replaceLiveRoster([makeChar('svetlana', { name: 'Светлана' })]),
    );
    expect(next.characters.map((c) => c.id)).toEqual(['svetlana']);
  });

  it('collapses a same-name id-flip to the single snapshot row', () => {
    /* The earlier singleton "Ольга" was emitted under a raw id; once a Tier-1
       group formed the server re-keyed the survivor to a canonical id. The
       stale singleton id must not survive as a duplicate pill. */
    const start = baseState([makeChar('ольга-2', { name: 'Ольга' })]);
    const next = castSlice.reducer(
      start,
      castActions.replaceLiveRoster([makeChar('ольга', { name: 'Ольга' })]),
    );
    expect(next.characters.map((c) => c.id)).toEqual(['ольга']);
    expect(next.characters.filter((c) => c.name === 'Ольга')).toHaveLength(1);
  });

  it('preserves locked voice / designed-Qwen fields by id-match on a surviving row (#518)', () => {
    const start = baseState([
      makeChar('wren', {
        voiceState: 'locked',
        voiceId: 'v_wren_from_book1',
        matchedFrom: { bookTitle: 'KOTC #1', confidence: 0.94 },
        overrideTtsVoices: { qwen: { name: 'qwen-wren' } },
      }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.replaceLiveRoster([
        { id: 'wren', name: 'Wren Sparrow', role: 'protagonist', color: 'orange', description: 'richer' },
      ]),
    );
    const wren = next.characters.find((c) => c.id === 'wren')!;
    expect(wren.voiceId).toBe('v_wren_from_book1');
    expect(wren.voiceState).toBe('locked');
    expect(wren.matchedFrom).toEqual({ bookTitle: 'KOTC #1', confidence: 0.94 });
    expect(wren.overrideTtsVoices).toEqual({ qwen: { name: 'qwen-wren' } });
    expect(wren.name).toBe('Wren Sparrow'); // fresh fields still flow through
  });

  it('mirrors the snapshot order and defaults voiceState for brand-new rows', () => {
    const start = baseState([makeChar('narrator')]);
    const next = castSlice.reducer(
      start,
      castActions.replaceLiveRoster([makeChar('narrator'), makeChar('wren'), makeChar('marlow')]),
    );
    expect(next.characters.map((c) => c.id)).toEqual(['narrator', 'wren', 'marlow']);
    expect(next.characters.find((c) => c.id === 'wren')!.voiceState).toBe('generated');
  });

  it('is a no-op for an empty snapshot (a stray empty event must not wipe the roster)', () => {
    const start = baseState([makeChar('wren')]);
    const next = castSlice.reducer(start, castActions.replaceLiveRoster([]));
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
      makeChar('hartwell-brennan-vale', { voiceState: 'generated' }),
      makeChar('wren', { voiceState: 'generated' }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyManualMatch({
        characterId: 'hartwell-brennan-vale',
        matchedFrom: {
          bookId: 'the Hollow Tide_1',
          characterId: 'hart',
          bookTitle: 'The Hollow Tide #1',
          confidence: 1,
        },
        voiceId: 'v_hart',
      }),
    );
    const hart = next.characters.find((c) => c.id === 'hartwell-brennan-vale')!;
    expect(hart.voiceId).toBe('v_hart');
    expect(hart.voiceState).toBe('reused');
    expect(hart.matchedFrom).toEqual({
      bookId: 'the Hollow Tide_1',
      characterId: 'hart',
      bookTitle: 'The Hollow Tide #1',
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
      makeChar('hartwell-brennan-vale', {
        voiceState: 'tuned',
        voiceId: 'v_hartwell_tuned',
      }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyManualMatch({
        characterId: 'hartwell-brennan-vale',
        matchedFrom: {
          bookId: 'the Hollow Tide_1',
          characterId: 'hart',
          bookTitle: 'The Hollow Tide #1',
          confidence: 1,
        },
        voiceId: 'v_hart_from_prior',
      }),
    );
    const hart = next.characters[0];
    expect(hart.voiceId).toBe('v_hartwell_tuned');
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
      makeChar('hartwell-brennan-vale', { voiceState: 'generated', attributes: ['original'] }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyManualMatch({
        characterId: 'hartwell-brennan-vale',
        matchedFrom: { bookId: 'the Hollow Tide_1', characterId: 'hart', bookTitle: 'The Hollow Tide #1', confidence: 1 },
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

describe('castSlice — applyRepointAlias (POST /cast/repoint-alias response)', () => {
  it('strips the alias off the source and appends it to the target', () => {
    const start = baseState([
      makeChar('egor', { name: 'Егор', aliases: ['Я', 'Sior'] }),
      makeChar('anton', { name: 'Антон', aliases: [] }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyRepointAlias({ sourceCharacterId: 'egor', aliasName: 'Я', targetCharacterId: 'anton' }),
    );
    expect(next.characters.find((c) => c.id === 'egor')!.aliases).toEqual(['Sior']);
    expect(next.characters.find((c) => c.id === 'anton')!.aliases).toEqual(['Я']);
  });

  it('dedups case-insensitively on the target (no double add)', () => {
    const start = baseState([
      makeChar('egor', { name: 'Егор', aliases: ['Я', 'Sior'] }),
      makeChar('anton', { name: 'Антон', aliases: ['я'] }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyRepointAlias({ sourceCharacterId: 'egor', aliasName: 'Я', targetCharacterId: 'anton' }),
    );
    expect(next.characters.find((c) => c.id === 'anton')!.aliases).toEqual(['я']);
    expect(next.characters.find((c) => c.id === 'egor')!.aliases).toEqual(['Sior']);
  });

  it('does not append when the alias equals the target primary name (still strips source)', () => {
    const start = baseState([
      makeChar('egor', { name: 'Егор', aliases: ['Антон', 'Sior'] }),
      makeChar('anton', { name: 'Антон', aliases: [] }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyRepointAlias({ sourceCharacterId: 'egor', aliasName: 'Антон', targetCharacterId: 'anton' }),
    );
    expect(next.characters.find((c) => c.id === 'anton')!.aliases).toEqual([]);
    expect(next.characters.find((c) => c.id === 'egor')!.aliases).toEqual(['Sior']);
  });

  it('is a no-op when the source or target is missing', () => {
    const start = baseState([
      makeChar('egor', { name: 'Егор', aliases: ['Я', 'Sior'] }),
      makeChar('anton', { name: 'Антон', aliases: [] }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyRepointAlias({ sourceCharacterId: 'ghost', aliasName: 'Я', targetCharacterId: 'anton' }),
    );
    expect(next.characters.find((c) => c.id === 'anton')!.aliases).toEqual([]);
  });

  it('no-ops for an empty/whitespace alias key', () => {
    const start = baseState([
      makeChar('egor', { name: 'Егор', aliases: ['Я', 'Sior'] }),
      makeChar('anton', { name: 'Антон', aliases: [] }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyRepointAlias({ sourceCharacterId: 'egor', aliasName: '   ', targetCharacterId: 'anton' }),
    );
    expect(next.characters.find((c) => c.id === 'egor')!.aliases).toEqual(['Я', 'Sior']);
    expect(next.characters.find((c) => c.id === 'anton')!.aliases).toEqual([]);
  });

  it('is a no-op when the target is missing (source keeps its alias)', () => {
    const start = baseState([
      makeChar('egor', { name: 'Егор', aliases: ['Я', 'Sior'] }),
      makeChar('anton', { name: 'Антон', aliases: [] }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyRepointAlias({ sourceCharacterId: 'egor', aliasName: 'Я', targetCharacterId: 'ghost' }),
    );
    expect(next.characters.find((c) => c.id === 'egor')!.aliases).toEqual(['Я', 'Sior']);
    expect(next.characters.some((c) => (c.aliases ?? []).includes('Я') && c.id !== 'egor')).toBe(false);
  });

  it('is a full no-op when source and target are the same character', () => {
    const start = baseState([
      makeChar('egor', { name: 'Егор', aliases: ['Я', 'Sior'] }),
      makeChar('anton', { name: 'Антон', aliases: [] }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyRepointAlias({ sourceCharacterId: 'egor', aliasName: 'Я', targetCharacterId: 'egor' }),
    );
    expect(next.characters.find((c) => c.id === 'egor')!.aliases).toEqual(['Я', 'Sior']);
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

describe('castSlice — setOverrideVoiceName (fs-38 Wave 3c Task 26)', () => {
  /* The load-bearing case: a qwen-routed character can't distinguish "always
     writes qwen" from "writes the routed engine" — engine and the
     hardcoded destination are the same value either way. Only a
     COQUI-routed write proves the reducer targets the ENGINE ARGUMENT
     rather than a hardcoded qwen slot. */
  it('writes a coqui-routed assignment into overrideTtsVoices.coqui, not qwen', () => {
    const start = baseState([makeChar('brann')]);
    const next = castSlice.reducer(
      start,
      castActions.setOverrideVoiceName({
        characterId: 'brann',
        engine: 'coqui',
        name: 'xtts-lib-clone-1',
        libraryUuid: 'lib-clone-1',
        provenance: 'cloned',
      }),
    );
    const brann = next.characters.find((c) => c.id === 'brann')!;
    expect(brann.overrideTtsVoices?.coqui).toEqual({
      name: 'xtts-lib-clone-1',
      libraryUuid: 'lib-clone-1',
      provenance: 'cloned',
    });
    /* Proves the fix, not just a passing shape: the qwen slot must stay
       untouched — a reducer that (bug-for-bug) still hardwired qwen would
       leave THIS assertion failing even though the coqui assertion above
       could coincidentally look right if the test only checked "a slot
       exists somewhere". */
    expect(brann.overrideTtsVoices?.qwen).toBeUndefined();
  });

  it('still writes qwen when routed to qwen (reducer handles both engines)', () => {
    const start = baseState([makeChar('brann')]);
    const next = castSlice.reducer(
      start,
      castActions.setOverrideVoiceName({
        characterId: 'brann',
        engine: 'qwen',
        name: 'qwen-lib-1',
        libraryUuid: 'lib-1',
        provenance: 'designed',
      }),
    );
    const brann = next.characters.find((c) => c.id === 'brann')!;
    expect(brann.overrideTtsVoices?.qwen).toEqual({
      name: 'qwen-lib-1',
      libraryUuid: 'lib-1',
      provenance: 'designed',
    });
    expect(brann.overrideTtsVoices?.coqui).toBeUndefined();
  });

  it('preserves an existing different-engine slot (engines coexist)', () => {
    const start = baseState([
      makeChar('brann', { overrideTtsVoices: { kokoro: { name: 'am_onyx' } } }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.setOverrideVoiceName({
        characterId: 'brann',
        engine: 'coqui',
        name: 'xtts-lib-clone-1',
        libraryUuid: 'lib-clone-1',
        provenance: 'cloned',
      }),
    );
    const brann = next.characters.find((c) => c.id === 'brann')!;
    expect(brann.overrideTtsVoices?.kokoro).toEqual({ name: 'am_onyx' });
    expect(brann.overrideTtsVoices?.coqui?.name).toBe('xtts-lib-clone-1');
  });

  it('no-ops when the character id is not in the slice', () => {
    const start = baseState([makeChar('wren')]);
    const next = castSlice.reducer(
      start,
      castActions.setOverrideVoiceName({
        characterId: 'ghost',
        engine: 'coqui',
        name: 'xtts-x',
      }),
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

describe('castSlice — setOrphanedCharacterFallbacks (#2023)', () => {
  it('overwrites the orphaned-fallback map from the book-state hydrate', () => {
    const start = { characters: [makeChar('narrator')], orphanedCharacterFallbacks: {} };
    const next = castSlice.reducer(
      start,
      castActions.setOrphanedCharacterFallbacks({
        mayrin: {
          characterId: 'narrator',
          voiceName: 'qwen-oduvan',
          resolution: 'unresolved',
          segments: 1,
          // #2129 — a plain pass-through field on this action; any valid
          // value round-trips unchanged, so the value itself carries no
          // meaning for this test.
          audioCurrent: 'true',
        },
      }),
    );
    expect(next.orphanedCharacterFallbacks).toEqual({
      mayrin: {
        characterId: 'narrator',
        voiceName: 'qwen-oduvan',
        resolution: 'unresolved',
        segments: 1,
        audioCurrent: 'true',
      },
    });
  });

  it('clears stale entries when the new map is empty (post-fix re-render)', () => {
    const start = {
      characters: [makeChar('narrator')],
      orphanedCharacterFallbacks: {
        mayrin: {
          characterId: 'narrator',
          resolution: 'unresolved' as const,
          segments: 1,
          audioCurrent: 'true' as const,
        },
      },
    };
    const next = castSlice.reducer(start, castActions.setOrphanedCharacterFallbacks({}));
    expect(next.orphanedCharacterFallbacks).toEqual({});
  });
});

describe('castSlice — applyOrphanRejection (#2040 Task 17, pair-scoped + response-driven by #2092/#2089)', () => {
  it('applies the server-returned resolution (null → unresolved) and pushes the target onto rejectedAgainst', () => {
    const start = {
      characters: [makeChar('mairin')],
      orphanedCharacterFallbacks: {
        mayrin: {
          resolution: 'alias' as const,
          resolvedCharacterId: 'mairin',
          segments: 6,
          audioCurrent: 'true' as const,
        },
      },
    };
    const next = castSlice.reducer(
      start,
      castActions.applyOrphanRejection({
        orphanedId: 'mayrin',
        characterId: 'mairin',
        resolution: null,
        resolvedCharacterId: undefined,
      }),
    );
    expect(next.orphanedCharacterFallbacks).toEqual({
      mayrin: {
        resolution: 'unresolved',
        resolvedCharacterId: undefined,
        segments: 6,
        // #2129 — the reducer cannot compute currency (no history/segments
        // here), so it always sets 'unknown' regardless of the prior value.
        audioCurrent: 'unknown',
        rejectedAgainst: ['mairin'],
      },
    });
  });

  it("doesn't guess unresolved — a non-null server resolution ('history' tier → 'alias') is applied as returned", () => {
    // Rejecting X against Y doesn't have to leave X unresolved: some OTHER,
    // unblocked tier can still resolve it onto a different live character —
    // this is what the response-driven design exists to reflect correctly.
    const start = {
      characters: [makeChar('mairin'), makeChar('other')],
      orphanedCharacterFallbacks: {
        mayrin: {
          resolution: 'alias' as const,
          resolvedCharacterId: 'mairin',
          segments: 6,
          audioCurrent: 'true' as const,
        },
      },
    };
    const next = castSlice.reducer(
      start,
      castActions.applyOrphanRejection({
        orphanedId: 'mayrin',
        characterId: 'mairin',
        resolution: 'history',
        resolvedCharacterId: 'other',
      }),
    );
    expect(next.orphanedCharacterFallbacks?.mayrin).toEqual({
      resolution: 'alias',
      resolvedCharacterId: 'other',
      segments: 6,
      audioCurrent: 'unknown',
      rejectedAgainst: ['mairin'],
    });
  });

  it("collapses the 'normalised-id' tier to 'normalised' (the same tier→taxonomy mapping the collector uses)", () => {
    const start = {
      characters: [makeChar('mairin')],
      orphanedCharacterFallbacks: {
        mayrin: { resolution: 'unresolved' as const, segments: 6, audioCurrent: 'true' as const },
      },
    };
    const next = castSlice.reducer(
      start,
      castActions.applyOrphanRejection({
        orphanedId: 'mayrin',
        characterId: 'wrong-target',
        resolution: 'normalised-id',
        resolvedCharacterId: 'mairin',
      }),
    );
    expect(next.orphanedCharacterFallbacks?.mayrin.resolution).toBe('normalised');
  });

  it('preserves the other fields on the entry (characterId, voiceName, segments)', () => {
    const start = {
      characters: [makeChar('mairin')],
      orphanedCharacterFallbacks: {
        mayrin: {
          characterId: 'narrator',
          voiceName: 'qwen-oduvan',
          resolution: 'normalised' as const,
          resolvedCharacterId: 'mairin',
          segments: 3,
          audioCurrent: 'true' as const,
        },
      },
    };
    const next = castSlice.reducer(
      start,
      castActions.applyOrphanRejection({
        orphanedId: 'mayrin',
        characterId: 'mairin',
        resolution: null,
        resolvedCharacterId: undefined,
      }),
    );
    expect(next.orphanedCharacterFallbacks?.mayrin).toEqual({
      characterId: 'narrator',
      voiceName: 'qwen-oduvan',
      resolution: 'unresolved',
      resolvedCharacterId: undefined,
      segments: 3,
      audioCurrent: 'unknown',
      rejectedAgainst: ['mairin'],
    });
  });

  it('dedupes — rejecting the same (orphanedId, characterId) pair twice does not duplicate the chip target', () => {
    const start = {
      characters: [makeChar('mairin')],
      orphanedCharacterFallbacks: {
        mayrin: {
          resolution: 'alias' as const,
          resolvedCharacterId: 'mairin',
          segments: 6,
          audioCurrent: 'true' as const,
        },
      },
    };
    const payload = {
      orphanedId: 'mayrin',
      characterId: 'mairin',
      resolution: null,
      resolvedCharacterId: undefined,
    };
    const once = castSlice.reducer(start, castActions.applyOrphanRejection(payload));
    const twice = castSlice.reducer(once, castActions.applyOrphanRejection(payload));
    expect(twice.orphanedCharacterFallbacks?.mayrin.rejectedAgainst).toEqual(['mairin']);
  });

  it('accumulates a second distinct rejected target alongside the first', () => {
    const start = {
      characters: [makeChar('mairin'), makeChar('other')],
      orphanedCharacterFallbacks: {
        mayrin: {
          resolution: 'unresolved' as const,
          segments: 6,
          rejectedAgainst: ['mairin'],
          audioCurrent: 'true' as const,
        },
      },
    };
    const next = castSlice.reducer(
      start,
      castActions.applyOrphanRejection({
        orphanedId: 'mayrin',
        characterId: 'other',
        resolution: null,
        resolvedCharacterId: undefined,
      }),
    );
    expect(next.orphanedCharacterFallbacks?.mayrin.rejectedAgainst).toEqual(['mairin', 'other']);
  });

  it('leaves an unrelated orphaned entry untouched', () => {
    const start = {
      characters: [],
      orphanedCharacterFallbacks: {
        mayrin: {
          resolution: 'alias' as const,
          resolvedCharacterId: 'mairin',
          segments: 1,
          audioCurrent: 'true' as const,
        },
        'the-torment': {
          resolution: 'unresolved' as const,
          segments: 67,
          audioCurrent: 'false' as const,
        },
      },
    };
    const next = castSlice.reducer(
      start,
      castActions.applyOrphanRejection({
        orphanedId: 'mayrin',
        characterId: 'mairin',
        resolution: null,
        resolvedCharacterId: undefined,
      }),
    );
    // 'the-torment' was never the target of this reject — every field,
    // including 'audioCurrent', is untouched.
    expect(next.orphanedCharacterFallbacks?.['the-torment']).toEqual({
      resolution: 'unresolved',
      segments: 67,
      audioCurrent: 'false',
    });
  });

  it("#2129 — always moves audioCurrent to 'unknown', even starting from 'true' (the reducer has no history/segments to compute a real verdict)", () => {
    const start = {
      characters: [makeChar('mairin')],
      orphanedCharacterFallbacks: {
        mayrin: {
          resolution: 'alias' as const,
          resolvedCharacterId: 'mairin',
          segments: 6,
          audioCurrent: 'true' as const,
        },
      },
    };
    const next = castSlice.reducer(
      start,
      castActions.applyOrphanRejection({
        orphanedId: 'mayrin',
        characterId: 'mairin',
        resolution: null,
        resolvedCharacterId: undefined,
      }),
    );
    expect(next.orphanedCharacterFallbacks?.mayrin.audioCurrent).toBe('unknown');
  });

  it('is a no-op for an orphaned id no longer in the map', () => {
    const start = { characters: [], orphanedCharacterFallbacks: {} };
    const next = castSlice.reducer(
      start,
      castActions.applyOrphanRejection({
        orphanedId: 'ghost',
        characterId: 'mairin',
        resolution: null,
        resolvedCharacterId: undefined,
      }),
    );
    expect(next).toEqual(start);
  });
});

describe('castSlice — undoOrphanRejection (#2092/#2089 D5)', () => {
  it('applies the server-returned resolution and drops the target out of rejectedAgainst, clearing the field when empty', () => {
    const start = {
      characters: [makeChar('mairin')],
      orphanedCharacterFallbacks: {
        mayrin: {
          resolution: 'unresolved' as const,
          segments: 6,
          rejectedAgainst: ['mairin'],
          audioCurrent: 'unknown' as const,
        },
      },
    };
    const next = castSlice.reducer(
      start,
      castActions.undoOrphanRejection({
        orphanedId: 'mayrin',
        characterId: 'mairin',
        resolution: 'history',
        resolvedCharacterId: 'mairin',
      }),
    );
    expect(next.orphanedCharacterFallbacks?.mayrin).toEqual({
      resolution: 'alias',
      resolvedCharacterId: 'mairin',
      segments: 6,
      // #2129 — the reducer cannot compute currency here either; per known
      // limit 2, `restoreSupersededId` stamps the CURRENT seq on an undo, so
      // the server's next real verdict is `false` — 'unknown' is the honest
      // fail-closed placeholder, never a stale 'true'.
      audioCurrent: 'unknown',
      rejectedAgainst: undefined,
    });
  });

  it('leaves other rejected targets in place when undoing only one', () => {
    const start = {
      characters: [makeChar('mairin'), makeChar('other')],
      orphanedCharacterFallbacks: {
        mayrin: {
          resolution: 'unresolved' as const,
          segments: 6,
          rejectedAgainst: ['mairin', 'other'],
          audioCurrent: 'unknown' as const,
        },
      },
    };
    const next = castSlice.reducer(
      start,
      castActions.undoOrphanRejection({
        orphanedId: 'mayrin',
        characterId: 'mairin',
        resolution: null,
        resolvedCharacterId: undefined,
      }),
    );
    expect(next.orphanedCharacterFallbacks?.mayrin.rejectedAgainst).toEqual(['other']);
  });

  it("resolution stays 'unresolved' when the undo's own resolution is null (nothing left to resolve onto)", () => {
    const start = {
      characters: [],
      orphanedCharacterFallbacks: {
        mayrin: {
          resolution: 'unresolved' as const,
          segments: 6,
          rejectedAgainst: ['mairin'],
          audioCurrent: 'unknown' as const,
        },
      },
    };
    const next = castSlice.reducer(
      start,
      castActions.undoOrphanRejection({
        orphanedId: 'mayrin',
        characterId: 'mairin',
        resolution: null,
        resolvedCharacterId: undefined,
      }),
    );
    expect(next.orphanedCharacterFallbacks?.mayrin).toEqual({
      resolution: 'unresolved',
      resolvedCharacterId: undefined,
      segments: 6,
      audioCurrent: 'unknown',
      rejectedAgainst: undefined,
    });
  });

  it("#2129 — always moves audioCurrent to 'unknown', even starting from 'true' (restoreSupersededId stamps the CURRENT seq, so the server's next verdict is 'false' — this reducer must not keep claiming 'true')", () => {
    const start = {
      characters: [makeChar('mairin')],
      orphanedCharacterFallbacks: {
        mayrin: {
          resolution: 'unresolved' as const,
          segments: 6,
          rejectedAgainst: ['mairin'],
          audioCurrent: 'true' as const,
        },
      },
    };
    const next = castSlice.reducer(
      start,
      castActions.undoOrphanRejection({
        orphanedId: 'mayrin',
        characterId: 'mairin',
        resolution: 'history',
        resolvedCharacterId: 'mairin',
      }),
    );
    expect(next.orphanedCharacterFallbacks?.mayrin.audioCurrent).toBe('unknown');
  });

  it('is a no-op for an orphaned id no longer in the map', () => {
    const start = { characters: [], orphanedCharacterFallbacks: {} };
    const next = castSlice.reducer(
      start,
      castActions.undoOrphanRejection({
        orphanedId: 'ghost',
        characterId: 'mairin',
        resolution: null,
        resolvedCharacterId: undefined,
      }),
    );
    expect(next).toEqual(start);
  });
});

describe('castSlice — applyOrphanLink (#2238, currency reset added at the #2128/#2129 merge)', () => {
  it('applies the server-returned resolution and resolvedCharacterId', () => {
    const start = {
      characters: [makeChar('mairin')],
      orphanedCharacterFallbacks: {
        coalfall: {
          resolution: 'unresolved' as const,
          segments: 13,
          audioCurrent: 'false' as const,
        },
      },
    };
    const next = castSlice.reducer(
      start,
      castActions.applyOrphanLink({
        orphanedId: 'coalfall',
        characterId: 'mairin',
        resolution: 'history',
        resolvedCharacterId: 'mairin',
      }),
    );
    expect(next.orphanedCharacterFallbacks?.coalfall).toEqual({
      resolution: 'alias',
      resolvedCharacterId: 'mairin',
      segments: 13,
      audioCurrent: 'unknown',
    });
  });

  it("moves audioCurrent to 'unknown', even starting from 'true' — a link changes what the id resolves onto, so a prior currency verdict is stale evidence, not current evidence (merge-reconciliation fix: this reducer used to leave audioCurrent untouched, unlike its applyOrphanRejection/undoOrphanRejection siblings)", () => {
    const start = {
      characters: [makeChar('mairin')],
      orphanedCharacterFallbacks: {
        coalfall: {
          resolution: 'unresolved' as const,
          segments: 13,
          audioCurrent: 'true' as const,
        },
      },
    };
    const next = castSlice.reducer(
      start,
      castActions.applyOrphanLink({
        orphanedId: 'coalfall',
        characterId: 'mairin',
        resolution: 'history',
        resolvedCharacterId: 'mairin',
      }),
    );
    expect(next.orphanedCharacterFallbacks?.coalfall.audioCurrent).toBe('unknown');
  });

  it('is a no-op for an orphaned id no longer in the map', () => {
    const start = { characters: [], orphanedCharacterFallbacks: {} };
    const next = castSlice.reducer(
      start,
      castActions.applyOrphanLink({
        orphanedId: 'ghost',
        characterId: 'mairin',
        resolution: null,
        resolvedCharacterId: undefined,
      }),
    );
    expect(next).toEqual(start);
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

describe('castSlice — clearCharacterEmotionVariants (redesign invalidation)', () => {
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

  it('drops the whole variants map, leaving the base name intact', () => {
    const next = castSlice.reducer(
      withVariants(),
      castActions.clearCharacterEmotionVariants({ characterId: 'maerin' }),
    );
    const qwen = next.characters[0].overrideTtsVoices!.qwen!;
    expect(qwen.variants).toBeUndefined();
    expect(qwen.name).toBe('qwen-v_maerin');
  });

  it('is a no-op for an unknown character or a character with no variants', () => {
    const unknown = castSlice.reducer(
      withVariants(),
      castActions.clearCharacterEmotionVariants({ characterId: 'ghost' }),
    );
    expect(Object.keys(unknown.characters[0].overrideTtsVoices!.qwen!.variants!)).toHaveLength(2);

    const noVariants = baseState([
      makeChar('solo', { overrideTtsVoices: { qwen: { name: 'qwen-v_solo' } } }),
    ]);
    const after = castSlice.reducer(
      noVariants,
      castActions.clearCharacterEmotionVariants({ characterId: 'solo' }),
    );
    expect(after.characters[0].overrideTtsVoices!.qwen!.name).toBe('qwen-v_solo');
  });
});

describe('selectCastTierByCharacterId (#1308)', () => {
  it('maps characterId to its pinned ttsModelKey', () => {
    const s = {
      cast: baseState([
        makeChar('marlow', { ttsModelKey: 'qwen3-tts-0.6b' } as Partial<Character>),
        makeChar('oduvan', { ttsModelKey: 'kokoro-v1' } as Partial<Character>),
      ]),
    };
    const tiers = selectCastTierByCharacterId(s);
    expect(tiers.get('marlow')).toBe('qwen3-tts-0.6b');
    expect(tiers.get('oduvan')).toBe('kokoro-v1');
  });

  it('returns a stable reference across calls with an unchanged characters array', () => {
    const s = { cast: baseState([makeChar('marlow')]) };
    expect(selectCastTierByCharacterId(s)).toBe(selectCastTierByCharacterId(s));
  });
});
