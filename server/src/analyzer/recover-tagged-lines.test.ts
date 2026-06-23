/* Post-stage-2 recovery of dialogue lines stage-2 left on the narrator. Pins the
   conservative tag-flip (the quote immediately before a `<Name> <speech-verb>`
   tag, only when currently narrator, only when Name resolves to one rostered
   character) and the prose-tag detection the fold uses to keep a 0-line tagged
   speaker. Regression for The Drowning Bell ch16 Behnam. */

import { describe, it, expect } from 'vitest';
import { recoverTaggedNarratorLines, taggedSpeakerIds } from './recover-tagged-lines.js';

const roster = [
  { id: 'behnam', name: 'Behnam Aria' },
  { id: 'wren-sparrow', name: 'Wren Sparrow' },
  { id: 'aldous', name: 'Aldous' },
];

function s(id: number, chapterId: number, characterId: string, text: string) {
  return { id, chapterId, characterId, text };
}

describe('recoverTaggedNarratorLines', () => {
  it('flips the narrator quote before a "<Name> <verb>" tag onto the speaker (Behnam/ch16 regression)', () => {
    const sentences = [
      s(313, 16, 'narrator', '“That would be easier to believe if you weren’t wearing your circlet,”'),
      s(314, 16, 'narrator', 'Behnam noted.'),
    ];
    const { sentences: out, flipped, byId } = recoverTaggedNarratorLines(sentences, roster);
    expect(out[0].characterId).toBe('behnam'); // the quote
    expect(out[1].characterId).toBe('narrator'); // the tag/action beat stays narrator
    expect(flipped).toBe(1);
    expect(byId.get('behnam')).toBe(1);
  });

  it('matches by first name ("Wren said" → wren-sparrow)', () => {
    const sentences = [s(1, 1, 'narrator', '“Hi,”'), s(2, 1, 'narrator', 'Wren said.')];
    expect(recoverTaggedNarratorLines(sentences, roster).sentences[0].characterId).toBe('wren-sparrow');
  });

  it('does not overwrite a non-narrator quote', () => {
    const sentences = [s(1, 1, 'aldous', '“Hi,”'), s(2, 1, 'narrator', 'Behnam noted.')];
    expect(recoverTaggedNarratorLines(sentences, roster).sentences[0].characterId).toBe('aldous');
  });

  it('does not flip across a chapter boundary', () => {
    const sentences = [s(99, 15, 'narrator', '“End of ch15,”'), s(1, 16, 'narrator', 'Behnam noted.')];
    expect(recoverTaggedNarratorLines(sentences, roster).flipped).toBe(0);
  });

  it('skips an unknown name (not in roster)', () => {
    const sentences = [s(1, 1, 'narrator', '“Who?,”'), s(2, 1, 'narrator', 'Wraythe hissed.')];
    expect(recoverTaggedNarratorLines(sentences, roster).flipped).toBe(0);
  });

  it('skips an ambiguous first name shared by two characters', () => {
    const dup = [
      { id: 'wren-sparrow', name: 'Wren Sparrow' },
      { id: 'wren-oduvan', name: 'Wren Oduvan' },
    ];
    const sentences = [s(1, 1, 'narrator', '“Hi,”'), s(2, 1, 'narrator', 'Wren said.')];
    expect(recoverTaggedNarratorLines(sentences, dup).flipped).toBe(0); // "wren" → ambiguous
  });

  it('skips pronoun openers ("she said")', () => {
    const sentences = [s(1, 1, 'narrator', '“Hi,”'), s(2, 1, 'narrator', 'she said.')];
    expect(recoverTaggedNarratorLines(sentences, roster).flipped).toBe(0);
  });

  it('is a no-op on a correctly-attributed book', () => {
    const sentences = [s(1, 1, 'wren-sparrow', '“Hi,”'), s(2, 1, 'narrator', 'Wren said.')];
    expect(recoverTaggedNarratorLines(sentences, roster).flipped).toBe(0);
  });

  it('does not mutate the input array', () => {
    const sentences = [s(1, 1, 'narrator', '“Hi,”'), s(2, 1, 'narrator', 'Behnam noted.')];
    recoverTaggedNarratorLines(sentences, roster);
    expect(sentences[0].characterId).toBe('narrator');
  });
});

describe('taggedSpeakerIds', () => {
  it('returns ids of rostered characters the prose tags', () => {
    const sentences = [
      s(1, 1, 'narrator', 'Behnam noted.'),
      s(2, 1, 'narrator', 'Wraythe hissed.'), // not rostered → excluded
      s(3, 1, 'narrator', 'plain narration with no tag'),
    ];
    const ids = taggedSpeakerIds(sentences, roster);
    expect(ids.has('behnam')).toBe(true);
    expect(ids.has('wren-sparrow')).toBe(false);
    expect([...ids]).toEqual(['behnam']);
  });
});

describe('recover-tagged-lines — non-English gate (seam 3d)', () => {
  it('does not flip narrator lines for a German book (avoids false re-attribution)', () => {
    // A German book with a narrator quote + a prose tag that the English
    // [A-Z]+verb heuristic would mis-attribute — must be a no-op for 'de'.
    const sentences = [
      s(313, 16, 'narrator', '"Das wäre leichter zu glauben, wenn du dein Diadem nicht trügest,"'),
      s(314, 16, 'narrator', 'Behnam noted.'),
    ];
    const out = recoverTaggedNarratorLines(sentences, roster, 'de');
    expect(out.flipped).toBe(0);
    expect(out.sentences[0].characterId).toBe('narrator'); // quote unchanged
    expect([...out.byId.entries()]).toHaveLength(0);
  });

  it('returns no tagged speakers for a non-English book', () => {
    const sentences = [
      s(1, 1, 'narrator', 'Behnam noted.'),
      s(2, 1, 'narrator', 'Wren said.'),
    ];
    expect(taggedSpeakerIds(sentences, roster, 'de').size).toBe(0);
  });
});

describe('taggedSpeakerIds — localized (es/ru, #1028)', () => {
  const esRoster = [{ id: 'berrin', name: 'Berrin Weir' }, { id: 'brann', name: 'Brann Weir' }];
  const ruRoster = [{ id: 'oduvan', name: 'Одуван' }, { id: 'wren', name: 'Рен' }];

  it('resolves a Spanish verb-before-name tag', () => {
    const ids = taggedSpeakerIds([s(1, 1, 'narrator', '«Está bien», dijo Berrin.')], esRoster, 'es');
    expect([...ids]).toEqual(['berrin']);
  });
  it('resolves a Russian verb-before-name tag (gendered + role noun)', () => {
    const ids = taggedSpeakerIds(
      [s(1, 1, 'narrator', '«Оставь, — сказал мастер Одуван, не поднимая глаз».')],
      ruRoster, 'ru',
    );
    expect([...ids]).toEqual(['oduvan']);
  });
  it('still returns ∅ for an unmapped non-English language (de stays gated)', () => {
    expect(taggedSpeakerIds([s(1, 1, 'narrator', 'dijo Berrin.')], esRoster, 'de').size).toBe(0);
  });
});
