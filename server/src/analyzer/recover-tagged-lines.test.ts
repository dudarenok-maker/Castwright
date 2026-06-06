/* Post-stage-2 recovery of dialogue lines stage-2 left on the narrator. Pins the
   conservative tag-flip (the quote immediately before a `<Name> <speech-verb>`
   tag, only when currently narrator, only when Name resolves to one rostered
   character) and the prose-tag detection the fold uses to keep a 0-line tagged
   speaker. Regression for Stellarlune ch16 Behnam. */

import { describe, it, expect } from 'vitest';
import { recoverTaggedNarratorLines, taggedSpeakerIds } from './recover-tagged-lines.js';

const roster = [
  { id: 'behnam', name: 'Behnam Aria' },
  { id: 'sophie-foster', name: 'Sophie Foster' },
  { id: 'kenric', name: 'Kenric' },
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

  it('matches by first name ("Sophie said" → sophie-foster)', () => {
    const sentences = [s(1, 1, 'narrator', '“Hi,”'), s(2, 1, 'narrator', 'Sophie said.')];
    expect(recoverTaggedNarratorLines(sentences, roster).sentences[0].characterId).toBe('sophie-foster');
  });

  it('does not overwrite a non-narrator quote', () => {
    const sentences = [s(1, 1, 'kenric', '“Hi,”'), s(2, 1, 'narrator', 'Behnam noted.')];
    expect(recoverTaggedNarratorLines(sentences, roster).sentences[0].characterId).toBe('kenric');
  });

  it('does not flip across a chapter boundary', () => {
    const sentences = [s(99, 15, 'narrator', '“End of ch15,”'), s(1, 16, 'narrator', 'Behnam noted.')];
    expect(recoverTaggedNarratorLines(sentences, roster).flipped).toBe(0);
  });

  it('skips an unknown name (not in roster)', () => {
    const sentences = [s(1, 1, 'narrator', '“Who?,”'), s(2, 1, 'narrator', 'Vespera hissed.')];
    expect(recoverTaggedNarratorLines(sentences, roster).flipped).toBe(0);
  });

  it('skips an ambiguous first name shared by two characters', () => {
    const dup = [
      { id: 'sophie-foster', name: 'Sophie Foster' },
      { id: 'sophie-elwin', name: 'Sophie Elwin' },
    ];
    const sentences = [s(1, 1, 'narrator', '“Hi,”'), s(2, 1, 'narrator', 'Sophie said.')];
    expect(recoverTaggedNarratorLines(sentences, dup).flipped).toBe(0); // "sophie" → ambiguous
  });

  it('skips pronoun openers ("she said")', () => {
    const sentences = [s(1, 1, 'narrator', '“Hi,”'), s(2, 1, 'narrator', 'she said.')];
    expect(recoverTaggedNarratorLines(sentences, roster).flipped).toBe(0);
  });

  it('is a no-op on a correctly-attributed book', () => {
    const sentences = [s(1, 1, 'sophie-foster', '“Hi,”'), s(2, 1, 'narrator', 'Sophie said.')];
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
      s(2, 1, 'narrator', 'Vespera hissed.'), // not rostered → excluded
      s(3, 1, 'narrator', 'plain narration with no tag'),
    ];
    const ids = taggedSpeakerIds(sentences, roster);
    expect(ids.has('behnam')).toBe(true);
    expect(ids.has('sophie-foster')).toBe(false);
    expect([...ids]).toEqual(['behnam']);
  });
});
