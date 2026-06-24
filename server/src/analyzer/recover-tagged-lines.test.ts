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

  it('strips a straight-apostrophe possessive before resolving (regression)', () => {
    // "Behnam's said." → capture "Behnam's" → stripPossessive → "behnam".
    const ids = taggedSpeakerIds([s(1, 1, 'narrator', "Behnam's said.")], roster);
    expect(ids.has('behnam')).toBe(true);
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

describe('recoverTaggedNarratorLines — fr/de (activated by #1051 rows)', () => {
  it('flips a German narrator quote onto the inversion-tagged speaker', () => {
    const roster = [{ id: 'anna', name: 'Anna' }];
    const sentences = [
      { id: 1, chapterId: 1, characterId: 'narrator', text: '„Ich komme mit.“' },
      { id: 2, chapterId: 1, characterId: 'narrator', text: 'sagte Anna entschlossen.' },
    ];
    const { sentences: out, flipped } = recoverTaggedNarratorLines(sentences, roster, 'de');
    expect(flipped).toBe(1);
    expect(out[0].characterId).toBe('anna');
  });
  it('keeps a 0-line French tagged speaker via taggedSpeakerIds', () => {
    const roster = [{ id: 'marie', name: 'Marie' }];
    const ids = taggedSpeakerIds(
      [{ id: 1, chapterId: 1, characterId: 'narrator', text: '— Bonjour, dit Marie.' }],
      roster,
      'fr',
    );
    expect(ids.has('marie')).toBe(true);
  });
});

describe('recoverTaggedNarratorLines — localized adjacency (es/ru)', () => {
  const ruRoster = [{ id: 'oduvan', name: 'Одуван' }, { id: 'wren', name: 'Рен' }];

  it('flips a stranded preceding quote onto the speaker (ru «…», — сказала Рен)', () => {
    const sentences = [
      s(1, 1, 'narrator', '«Я никогда не вздыхаю»,'),
      s(2, 1, 'narrator', '— сказала Рен.'),
    ];
    const out = recoverTaggedNarratorLines(sentences, ruRoster, 'ru');
    expect(out.sentences[0].characterId).toBe('wren');
    expect(out.flipped).toBe(1);
  });

  it('flips BOTH sides of an interrupted quote (preceding + following)', () => {
    const sentences = [
      s(1, 1, 'narrator', '«Если я залью огонь,'),
      s(2, 1, 'narrator', '— сказал Одуван, —'),
      s(3, 1, 'narrator', 'то потеряю сварку».'),
    ];
    const out = recoverTaggedNarratorLines(sentences, ruRoster, 'ru');
    expect(out.sentences[0].characterId).toBe('oduvan');
    expect(out.sentences[2].characterId).toBe('oduvan');
    expect(out.flipped).toBe(2);
  });

  it('does NOT steal the next speaker\'s quote in a rapid exchange (R23)', () => {
    const sentences = [
      s(1, 1, 'narrator', '«Первый».'),
      s(2, 1, 'narrator', '— сказал Одуван.'),
      s(3, 1, 'narrator', '«Второй».'),     // belongs to Рен — its own tag is next
      s(4, 1, 'narrator', '— сказала Рен.'),
    ];
    const out = recoverTaggedNarratorLines(sentences, ruRoster, 'ru');
    expect(out.sentences[0].characterId).toBe('oduvan'); // preceding of S2 → Одуван
    expect(out.sentences[2].characterId).toBe('wren');   // NOT stolen by Одуван; flipped by S4
  });

  it('does NOT flip an inline quote+tag+narration sentence (no re-voiced narration)', () => {
    const sentences = [
      s(1, 1, 'narrator', '«Está bien», dijo Berrin, plano como un estante.'),
    ];
    const esRoster = [{ id: 'berrin', name: 'Berrin' }];
    const out = recoverTaggedNarratorLines(sentences, esRoster, 'es');
    expect(out.sentences[0].characterId).toBe('narrator'); // S itself never flips
    expect(out.flipped).toBe(0);
  });

  it('stays a no-op for an unmapped language (de)', () => {
    const sentences = [s(1, 1, 'narrator', '«…»,'), s(2, 1, 'narrator', '— сказала Рен.')];
    expect(recoverTaggedNarratorLines(sentences, ruRoster, 'de').flipped).toBe(0);
  });
});
