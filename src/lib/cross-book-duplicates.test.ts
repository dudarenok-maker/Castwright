/* Unit tests for the cross-book duplicate detector (plan 101).

   The predicate is conservative — these tests pin the cases that MUST
   flag (same-series, same-base-voice, dedup-name hit) and the cases that
   MUST NOT flag (alias already present, notLinkedTo recorded, cross-
   series, standalone, narrator/bucket id). */

import { describe, it, expect } from 'vitest';
import {
  detectDuplicateCandidates,
  looksLikeSameName,
  normaliseDuplicateToken,
  type BookSeriesInfo,
} from './cross-book-duplicates';
import type { Character, Voice } from './types';

function makeVoice(opts: {
  id: string;
  character: string;
  bookId: string;
  bookTitle: string;
  voiceName: string;
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
  author: 'Mike Dudarenok',
  series: 'Northern Coast Trilogy',
  isStandalone: false,
};

const SERIES_OTHER: BookSeriesInfo = {
  author: 'Mike Dudarenok',
  series: 'Other Series',
  isStandalone: false,
};

const STANDALONE: BookSeriesInfo = {
  author: 'Mike Dudarenok',
  series: 'Solo Book',
  isStandalone: true,
};

describe('normaliseDuplicateToken', () => {
  it('lowercases and strips non-alphanumerics', () => {
    expect(normaliseDuplicateToken('Wren Sparrow')).toBe('Wrenfoster');
    expect(normaliseDuplicateToken("O'Brien")).toBe('obrien');
    expect(normaliseDuplicateToken('  Eliza-Gray  ')).toBe('elizagray');
    expect(normaliseDuplicateToken('')).toBe('');
    expect(normaliseDuplicateToken(undefined)).toBe('');
  });
});

describe('looksLikeSameName', () => {
  it('matches identical normalised tokens', () => {
    expect(looksLikeSameName('Wren', 'Wren')).toBe(true);
  });
  it('matches when one is a strict substring of the other', () => {
    expect(looksLikeSameName('Wren', 'Wrenfoster')).toBe(true);
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
    expect(looksLikeSameName('', 'Wren')).toBe(false);
    expect(looksLikeSameName('Wren', '')).toBe(false);
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
