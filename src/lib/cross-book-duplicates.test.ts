/* Unit tests for the cross-book duplicate detector (plan 101).

   The predicate is conservative — these tests pin the cases that MUST
   flag (same-series, same-base-voice, dedup-name hit) and the cases that
   MUST NOT flag (alias already present, notLinkedTo recorded, cross-
   series, standalone, narrator/bucket id). */

import { describe, it, expect } from 'vitest';
import {
  detectDuplicateCandidates,
  detectIgnoredDuplicatePairs,
  looksLikeSameName,
  normaliseDuplicateToken,
  sameCharacterByNameAlias,
  appendAliasToCachedCharacter,
  appendNotLinkedToCachedCharacter,
  removeNotLinkedToCachedCharacter,
  type BookSeriesInfo,
  type CharacterIdentity,
} from './cross-book-duplicates';
import type { Character, Voice } from './types';

function makeVoice(opts: {
  id: string;
  character: string;
  bookId: string;
  bookTitle: string;
  voiceName: string;
  aliases?: string[];
  notLinkedTo?: Array<{ bookId: string; characterId: string }>;
}): Voice {
  return {
    id: opts.id,
    character: opts.character,
    bookTitle: opts.bookTitle,
    bookId: opts.bookId,
    attributes: [],
    usedIn: 1,
    source: 'current',
    gradient: ['#000', '#fff'],
    ttsVoice: { provider: 'gemini', name: opts.voiceName, description: '' },
    aliases: opts.aliases,
    notLinkedTo: opts.notLinkedTo,
  } as Voice;
}

function makeCharacter(id: string, name: string, extra: Partial<Character> = {}): Character {
  return {
    id,
    name,
    role: 'character',
    color: 'unset',
    ...extra,
  } as Character;
}

const SERIES_NCT: BookSeriesInfo = {
  author: 'Marin Vale',
  series: 'Northern Coast Trilogy',
  isStandalone: false,
};

const SERIES_OTHER: BookSeriesInfo = {
  author: 'Marin Vale',
  series: 'Other Series',
  isStandalone: false,
};

const STANDALONE: BookSeriesInfo = {
  author: 'Marin Vale',
  series: 'Solo Book',
  isStandalone: true,
};

describe('normaliseDuplicateToken', () => {
  it('lowercases and strips non-alphanumerics', () => {
    expect(normaliseDuplicateToken('Wren Sparrow')).toBe('wrensparrow');
    expect(normaliseDuplicateToken("O'Brien")).toBe('obrien');
    expect(normaliseDuplicateToken('  Eliza-Gray  ')).toBe('elizagray');
    expect(normaliseDuplicateToken('')).toBe('');
    expect(normaliseDuplicateToken(undefined)).toBe('');
  });
});

describe('looksLikeSameName', () => {
  it('matches identical normalised tokens', () => {
    expect(looksLikeSameName('wren', 'wren')).toBe(true);
  });
  it('matches when one is a strict substring of the other', () => {
    expect(looksLikeSameName('wren', 'wrensparrow')).toBe(true);
    expect(looksLikeSameName('elizagray', 'eliza')).toBe(true);
  });
  it('does not match unrelated names', () => {
    expect(looksLikeSameName('halloran', 'eliza')).toBe(false);
  });
  it('does not match short substrings to avoid noise', () => {
    /* "el" is a substring of "eliza" but is too short to be reliable. */
    expect(looksLikeSameName('el', 'eliza')).toBe(false);
  });
  it('does not match empty', () => {
    expect(looksLikeSameName('', 'wren')).toBe(false);
    expect(looksLikeSameName('wren', '')).toBe(false);
  });
});

describe('detectDuplicateCandidates', () => {
  const elizaNs = makeVoice({
    id: 'v_eliza',
    character: 'Eliza Gray',
    bookId: 'ns',
    bookTitle: 'The Northern Star',
    voiceName: 'Kore',
  });
  const elizaSb = makeVoice({
    id: 'v_eliza_sb',
    character: 'Eliza',
    bookId: 'sb',
    bookTitle: 'Solway Bay',
    voiceName: 'Kore',
  });

  const seriesByBookId = new Map<string, BookSeriesInfo>([
    ['ns', SERIES_NCT],
    ['sb', SERIES_NCT],
  ]);

  it('flags a same-series same-base-voice substring-name pair', () => {
    const result = detectDuplicateCandidates({
      library: [elizaNs, elizaSb],
      seriesByBookId,
      charactersByBookId: new Map(),
    });
    expect(result).toHaveLength(1);
    expect(result[0].voiceKey).toBe('gemini|Kore');
    expect(result[0].a.voice.bookId).toBe('ns');
    expect(result[0].b.voice.bookId).toBe('sb');
  });

  it('does not flag a cross-series pair', () => {
    const otherSeriesMap = new Map(seriesByBookId);
    otherSeriesMap.set('sb', SERIES_OTHER);
    const result = detectDuplicateCandidates({
      library: [elizaNs, elizaSb],
      seriesByBookId: otherSeriesMap,
      charactersByBookId: new Map(),
    });
    expect(result).toHaveLength(0);
  });

  it('does not flag when either side is a standalone book', () => {
    const standaloneMap = new Map(seriesByBookId);
    standaloneMap.set('sb', STANDALONE);
    const result = detectDuplicateCandidates({
      library: [elizaNs, elizaSb],
      seriesByBookId: standaloneMap,
      charactersByBookId: new Map(),
    });
    expect(result).toHaveLength(0);
  });

  it('does not flag a different-base-voice pair even within series', () => {
    const elizaSbDifferent = makeVoice({
      id: 'v_eliza_sb',
      character: 'Eliza',
      bookId: 'sb',
      bookTitle: 'Solway Bay',
      voiceName: 'Sulafat', // different base voice
    });
    const result = detectDuplicateCandidates({
      library: [elizaNs, elizaSbDifferent],
      seriesByBookId,
      charactersByBookId: new Map(),
    });
    expect(result).toHaveLength(0);
  });

  it('does not flag a same-book pair', () => {
    const elizaTwin = makeVoice({
      id: 'v_eliza_twin',
      character: 'Eliza',
      bookId: 'ns',
      bookTitle: 'The Northern Star',
      voiceName: 'Kore',
    });
    const result = detectDuplicateCandidates({
      library: [elizaNs, elizaTwin],
      seriesByBookId,
      charactersByBookId: new Map(),
    });
    expect(result).toHaveLength(0);
  });

  it('does not flag when one side already lists the other as an alias', () => {
    const elizaWithAlias = makeCharacter('v_eliza', 'Eliza Gray', { aliases: ['Eliza'] });
    const result = detectDuplicateCandidates({
      library: [elizaNs, elizaSb],
      seriesByBookId,
      charactersByBookId: new Map([['ns', [elizaWithAlias]]]),
    });
    expect(result).toHaveLength(0);
  });

  it('does not flag when notLinkedTo records the pair', () => {
    const elizaMarkedVariant = makeCharacter('v_eliza', 'Eliza Gray', {
      notLinkedTo: [{ bookId: 'sb', characterId: 'v_eliza_sb' }],
    });
    const elizaSbCharacter = makeCharacter('v_eliza_sb', 'Eliza');
    const result = detectDuplicateCandidates({
      library: [elizaNs, elizaSb],
      seriesByBookId,
      charactersByBookId: new Map([
        ['ns', [elizaMarkedVariant]],
        ['sb', [elizaSbCharacter]],
      ]),
    });
    expect(result).toHaveLength(0);
  });

  it('does not flag a narrator id even with name dedup hit', () => {
    const narratorNs = makeVoice({
      id: 'narrator',
      character: 'Narrator',
      bookId: 'ns',
      bookTitle: 'The Northern Star',
      voiceName: 'Sulafat',
    });
    const narratorSb = makeVoice({
      id: 'narrator',
      character: 'Narrator',
      bookId: 'sb',
      bookTitle: 'Solway Bay',
      voiceName: 'Sulafat',
    });
    const result = detectDuplicateCandidates({
      library: [narratorNs, narratorSb],
      seriesByBookId,
      charactersByBookId: new Map([
        ['ns', [makeCharacter('narrator', 'Narrator')]],
        ['sb', [makeCharacter('narrator', 'Narrator')]],
      ]),
    });
    expect(result).toHaveLength(0);
  });

  it('skips voices missing a ttsVoice', () => {
    const noTts = { ...elizaSb, ttsVoice: undefined } as unknown as Voice;
    const result = detectDuplicateCandidates({
      library: [elizaNs, noTts],
      seriesByBookId,
      charactersByBookId: new Map(),
    });
    expect(result).toHaveLength(0);
  });
});

/* Regression for the "duplicate pill reappears on reload" bug (plan 101
   fix 2026-05-26). On the global `#/voices` tab no book cast is hydrated,
   so `charactersByBookId` is empty and the resolved-Character suppression
   filters never ran — an already-linked / variant-marked pair re-surfaced
   on every load. The detector now falls back to the library Voice's own
   `aliases` / `notLinkedTo` (carried by the server) so suppression works
   WITHOUT a cast hydrate. */
describe('detectDuplicateCandidates — voice-carried suppression (no cast hydrated)', () => {
  const seriesByBookId = new Map<string, BookSeriesInfo>([
    ['ns', SERIES_NCT],
    ['sb', SERIES_NCT],
  ]);
  const elizaSb = makeVoice({
    id: 'v_eliza_sb',
    character: 'Eliza',
    bookId: 'sb',
    bookTitle: 'Solway Bay',
    voiceName: 'Kore',
  });

  it('flags the pair when neither voice carries the alias (the case the pill exists for)', () => {
    const elizaNs = makeVoice({
      id: 'v_eliza',
      character: 'Eliza Gray',
      bookId: 'ns',
      bookTitle: 'The Northern Star',
      voiceName: 'Kore',
    });
    const result = detectDuplicateCandidates({
      library: [elizaNs, elizaSb],
      seriesByBookId,
      charactersByBookId: new Map(), // nothing hydrated — mirrors the global tab
    });
    expect(result).toHaveLength(1);
  });

  it('suppresses via the winner voice.aliases even with no cast hydrated (reload case)', () => {
    const elizaNsAliased = makeVoice({
      id: 'v_eliza',
      character: 'Eliza Gray',
      bookId: 'ns',
      bookTitle: 'The Northern Star',
      voiceName: 'Kore',
      aliases: ['Eliza'], // the loser's name, persisted on disk
    });
    const result = detectDuplicateCandidates({
      library: [elizaNsAliased, elizaSb],
      seriesByBookId,
      charactersByBookId: new Map(), // empty — the bug's exact condition
    });
    expect(result).toHaveLength(0);
  });

  it('suppresses via voice.notLinkedTo even with no cast hydrated', () => {
    const elizaNsVariant = makeVoice({
      id: 'v_eliza',
      character: 'Eliza Gray',
      bookId: 'ns',
      bookTitle: 'The Northern Star',
      voiceName: 'Kore',
      notLinkedTo: [{ bookId: 'sb', characterId: 'v_eliza_sb' }],
    });
    const result = detectDuplicateCandidates({
      library: [elizaNsVariant, elizaSb],
      seriesByBookId,
      charactersByBookId: new Map(),
    });
    expect(result).toHaveLength(0);
  });

  it('prefers the hydrated Character over a stale voice (resolved-empty wins → still flagged)', () => {
    /* In-session a freshly-hydrated cast is authoritative: if its character
       carries no alias the pair stays flagged, even if a stale library
       Voice happened to carry one. */
    const elizaNsStaleAlias = makeVoice({
      id: 'v_eliza',
      character: 'Eliza Gray',
      bookId: 'ns',
      bookTitle: 'The Northern Star',
      voiceName: 'Kore',
      aliases: ['Eliza'],
    });
    const result = detectDuplicateCandidates({
      library: [elizaNsStaleAlias, elizaSb],
      seriesByBookId,
      charactersByBookId: new Map([['ns', [makeCharacter('v_eliza', 'Eliza Gray')]]]),
    });
    expect(result).toHaveLength(1);
  });
});

describe('appendAliasToCachedCharacter', () => {
  const baseCache = () =>
    new Map<string, Character[]>([['ns', [makeCharacter('v_eliza', 'Eliza Gray')]]]);

  it('appends the alias to the matching cached character', () => {
    const next = appendAliasToCachedCharacter(baseCache(), 'ns', 'v_eliza', 'Eliza');
    expect(next.get('ns')?.[0].aliases).toEqual(['Eliza']);
  });

  it('returns a new Map (immutable) and leaves the source untouched', () => {
    const cache = baseCache();
    const next = appendAliasToCachedCharacter(cache, 'ns', 'v_eliza', 'Eliza');
    expect(next).not.toBe(cache);
    expect(cache.get('ns')?.[0].aliases).toBeUndefined();
  });

  it('is a no-op (same Map reference) when the book is not cached', () => {
    const cache = baseCache();
    expect(appendAliasToCachedCharacter(cache, 'unknown', 'v_eliza', 'Eliza')).toBe(cache);
  });

  it('is a no-op when the character is not in the cached book', () => {
    const cache = baseCache();
    expect(appendAliasToCachedCharacter(cache, 'ns', 'nobody', 'Eliza')).toBe(cache);
  });

  it('dedups case-insensitively against existing aliases', () => {
    const cache = new Map<string, Character[]>([
      ['ns', [makeCharacter('v_eliza', 'Eliza Gray', { aliases: ['Eliza'] })]],
    ]);
    expect(appendAliasToCachedCharacter(cache, 'ns', 'v_eliza', 'ELIZA')).toBe(cache);
  });

  it('drops a self-alias (alias equals the character name)', () => {
    const cache = baseCache();
    expect(appendAliasToCachedCharacter(cache, 'ns', 'v_eliza', 'eliza gray')).toBe(cache);
  });

  it('is a no-op on a blank alias', () => {
    const cache = baseCache();
    expect(appendAliasToCachedCharacter(cache, 'ns', 'v_eliza', '   ')).toBe(cache);
  });
});

describe('appendNotLinkedToCachedCharacter', () => {
  const baseCache = () =>
    new Map<string, Character[]>([['ns', [makeCharacter('v_eliza', 'Eliza Gray')]]]);

  it('appends the notLinkedTo pair to the matching cached character', () => {
    const next = appendNotLinkedToCachedCharacter(baseCache(), 'ns', 'v_eliza', 'sb', 'v_eliza_sb');
    expect(next.get('ns')?.[0].notLinkedTo).toEqual([{ bookId: 'sb', characterId: 'v_eliza_sb' }]);
  });

  it('returns a new Map (immutable) and leaves the source untouched', () => {
    const cache = baseCache();
    const next = appendNotLinkedToCachedCharacter(cache, 'ns', 'v_eliza', 'sb', 'v_eliza_sb');
    expect(next).not.toBe(cache);
    expect(cache.get('ns')?.[0].notLinkedTo).toBeUndefined();
  });

  it('is a no-op (same Map reference) when the book is not cached', () => {
    const cache = baseCache();
    expect(appendNotLinkedToCachedCharacter(cache, 'unknown', 'v_eliza', 'sb', 'x')).toBe(cache);
  });

  it('dedups on the (bookId, characterId) pair', () => {
    const cache = new Map<string, Character[]>([
      [
        'ns',
        [
          makeCharacter('v_eliza', 'Eliza Gray', {
            notLinkedTo: [{ bookId: 'sb', characterId: 'v_eliza_sb' }],
          }),
        ],
      ],
    ]);
    expect(appendNotLinkedToCachedCharacter(cache, 'ns', 'v_eliza', 'sb', 'v_eliza_sb')).toBe(cache);
  });

  it('is a no-op on missing other-side ids', () => {
    const cache = baseCache();
    expect(appendNotLinkedToCachedCharacter(cache, 'ns', 'v_eliza', '', '')).toBe(cache);
  });
});

describe('removeNotLinkedToCachedCharacter (fs-11)', () => {
  const markedCache = () =>
    new Map<string, Character[]>([
      [
        'ns',
        [
          makeCharacter('v_eliza', 'Eliza Gray', {
            notLinkedTo: [{ bookId: 'sb', characterId: 'v_eliza_sb' }],
          }),
        ],
      ],
    ]);

  it('removes the notLinkedTo pair from the matching cached character', () => {
    const next = removeNotLinkedToCachedCharacter(markedCache(), 'ns', 'v_eliza', 'sb', 'v_eliza_sb');
    expect(next.get('ns')?.[0].notLinkedTo).toEqual([]);
  });

  it('returns a new Map (immutable) and leaves the source untouched', () => {
    const cache = markedCache();
    const next = removeNotLinkedToCachedCharacter(cache, 'ns', 'v_eliza', 'sb', 'v_eliza_sb');
    expect(next).not.toBe(cache);
    expect(cache.get('ns')?.[0].notLinkedTo).toEqual([{ bookId: 'sb', characterId: 'v_eliza_sb' }]);
  });

  it('is a no-op (same Map reference) when the pair is already absent', () => {
    const cache = new Map<string, Character[]>([['ns', [makeCharacter('v_eliza', 'Eliza Gray')]]]);
    expect(removeNotLinkedToCachedCharacter(cache, 'ns', 'v_eliza', 'sb', 'v_eliza_sb')).toBe(cache);
  });

  it('is a no-op when the book is not cached or ids are missing', () => {
    const cache = markedCache();
    expect(removeNotLinkedToCachedCharacter(cache, 'unknown', 'v_eliza', 'sb', 'x')).toBe(cache);
    expect(removeNotLinkedToCachedCharacter(cache, 'ns', 'v_eliza', '', '')).toBe(cache);
  });
});

describe('detectIgnoredDuplicatePairs (fs-11)', () => {
  const seriesByBookId = new Map<string, BookSeriesInfo>([
    ['ns', SERIES_NCT],
    ['sb', SERIES_NCT],
  ]);

  const elizaNs = makeVoice({
    id: 'v_eliza',
    character: 'Eliza Gray',
    bookId: 'ns',
    bookTitle: 'Northern Star',
    voiceName: 'Kore',
  });
  const elizaSb = makeVoice({
    id: 'v_eliza_sb',
    character: 'Eliza',
    bookId: 'sb',
    bookTitle: 'Solway Bay',
    voiceName: 'Kore',
  });

  it('returns the pair when one side carries the other in notLinkedTo', () => {
    const charactersByBookId = new Map<string, Character[]>([
      [
        'ns',
        [makeCharacter('v_eliza', 'Eliza Gray', {
          notLinkedTo: [{ bookId: 'sb', characterId: 'v_eliza_sb' }],
        })],
      ],
      ['sb', [makeCharacter('v_eliza_sb', 'Eliza')]],
    ]);
    const out = detectIgnoredDuplicatePairs({
      library: [elizaNs, elizaSb],
      seriesByBookId,
      charactersByBookId,
    });
    expect(out).toHaveLength(1);
    expect(out[0].seriesKey).toBe(`${SERIES_NCT.author}|${SERIES_NCT.series}`);
  });

  it('returns nothing when the pair is NOT marked notLinkedTo (it is a live candidate, not ignored)', () => {
    const charactersByBookId = new Map<string, Character[]>([
      ['ns', [makeCharacter('v_eliza', 'Eliza Gray')]],
      ['sb', [makeCharacter('v_eliza_sb', 'Eliza')]],
    ]);
    expect(
      detectIgnoredDuplicatePairs({
        library: [elizaNs, elizaSb],
        seriesByBookId,
        charactersByBookId,
      }),
    ).toHaveLength(0);
  });

  it('reads notLinkedTo off the Voice fallback when no cast is hydrated', () => {
    const elizaNsMarked = makeVoice({
      id: 'v_eliza',
      character: 'Eliza Gray',
      bookId: 'ns',
      bookTitle: 'Northern Star',
      voiceName: 'Kore',
      notLinkedTo: [{ bookId: 'sb', characterId: 'v_eliza_sb' }],
    });
    expect(
      detectIgnoredDuplicatePairs({
        library: [elizaNsMarked, elizaSb],
        seriesByBookId,
        charactersByBookId: new Map(),
      }),
    ).toHaveLength(1);
  });
});

describe('sameCharacterByNameAlias', () => {
  const id = (over: Partial<CharacterIdentity> & { bookId: string; characterId: string }): CharacterIdentity => ({
    name: over.characterId,
    ...over,
  });

  it('matches identical names across books', () => {
    const a = id({ bookId: 'b1', characterId: 'wren', name: 'Wren' });
    const b = id({ bookId: 'b2', characterId: 'wren', name: 'Wren' });
    expect(sameCharacterByNameAlias(a, b)).toBe(true);
  });

  it('matches via a strict substring (Wren ⊂ Wren Sparrow)', () => {
    const a = id({ bookId: 'b1', characterId: 'wren', name: 'Wren' });
    const b = id({ bookId: 'b2', characterId: 'wren-sparrow', name: 'Wren Sparrow' });
    expect(sameCharacterByNameAlias(a, b)).toBe(true);
  });

  it('matches punctuation/case variants of the id-name (Castor ≡ bron-te)', () => {
    const a = id({ bookId: 'b1', characterId: 'Castor', name: 'Castor' });
    const b = id({ bookId: 'b2', characterId: 'bron-te', name: 'Bron-te' });
    expect(sameCharacterByNameAlias(a, b)).toBe(true);
  });

  it('matches through an alias bridge', () => {
    const a = id({ bookId: 'b1', characterId: 'wren', name: 'Wren', aliases: ['Wren Sparrow'] });
    const b = id({ bookId: 'b2', characterId: 'foster', name: 'Foster', aliases: ['Wren Sparrow'] });
    expect(sameCharacterByNameAlias(a, b)).toBe(true);
  });

  it('does NOT match unrelated names (typo variants with no shared token)', () => {
    const a = id({ bookId: 'b1', characterId: 'aldan', name: 'Aldan' });
    const b = id({ bookId: 'b2', characterId: 'Maelor', name: 'Maelor' });
    expect(sameCharacterByNameAlias(a, b)).toBe(false);
  });

  it('is blocked by notLinkedTo in either direction', () => {
    const a = id({
      bookId: 'b1',
      characterId: 'wren',
      name: 'Wren',
      notLinkedTo: [{ bookId: 'b2', characterId: 'wren' }],
    });
    const b = id({ bookId: 'b2', characterId: 'wren', name: 'Wren' });
    expect(sameCharacterByNameAlias(a, b)).toBe(false);
    expect(sameCharacterByNameAlias(b, a)).toBe(false);
  });

  it('never matches a fold-bucket id', () => {
    const a = id({ bookId: 'b1', characterId: 'unknown-male', name: 'Lord Vane' });
    const b = id({ bookId: 'b2', characterId: 'lord-vane', name: 'Lord Vane' });
    expect(sameCharacterByNameAlias(a, b)).toBe(false);
  });

  it('does not match the same (book, character) row against itself', () => {
    const a = id({ bookId: 'b1', characterId: 'wren', name: 'Wren' });
    expect(sameCharacterByNameAlias(a, { ...a })).toBe(false);
  });
});
