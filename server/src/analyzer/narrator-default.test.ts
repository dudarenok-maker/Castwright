import { describe, it, expect } from 'vitest';
import type { SentenceOutput } from '../handoff/schemas.js';
import {
  isSpokenLine,
  forceNarratorOnNonSpokenLines,
  applyNonEnglishNarratorDefault,
} from './narrator-default.js';
import { foldMinorCast } from './fold-minor-cast.js';

const s = (id: number, characterId: string, text: string): SentenceOutput =>
  ({ id, chapterId: 1, characterId, text, confidence: 0.9 }) as SentenceOutput;

describe('isSpokenLine', () => {
  it('treats leading em-dash / en-dash / hyphen as spoken', () => {
    expect(isSpokenLine('— Иди сюда')).toBe(true);
    expect(isSpokenLine('– Иди сюда')).toBe(true);
    expect(isSpokenLine('- Иди сюда')).toBe(true);
    expect(isSpokenLine('   — с ведущими пробелами')).toBe(true);
  });
  it('treats leading or embedded quote spans as spoken', () => {
    expect(isSpokenLine('«Привет»')).toBe(true);
    expect(isSpokenLine('Он сказал «привет» громко')).toBe(true);
    expect(isSpokenLine('"Hard to starboard"')).toBe(true);
    expect(isSpokenLine('“smart quotes”')).toBe(true);
  });
  it('treats plain third-person narration as NOT spoken', () => {
    expect(isSpokenLine('Егор засунул руки в карманы, покосился назад.')).toBe(false);
    expect(isSpokenLine('Мальчик шёл по переходу.')).toBe(false);
    expect(isSpokenLine('')).toBe(false);
    // mid-sentence dash is punctuation, not a dialogue marker (anchored ^)
    expect(isSpokenLine('Ветер толкнул Егора последний раз и стих - будто смирился.')).toBe(false);
  });
  it('matches named HTML dash entities at the start (stripHtml may leave them)', () => {
    expect(isSpokenLine('&mdash; Иди сюда')).toBe(true);
    expect(isSpokenLine('&ndash; Стой')).toBe(true);
  });
  it('a bare dash line is spoken (no text after the marker)', () => {
    expect(isSpokenLine('—')).toBe(true);
    expect(isSpokenLine('- ')).toBe(true);
  });
  it('KNOWN false-positive: narration quoting a sign/title reads as spoken (documented limitation)', () => {
    // The embedded-quoted-span branch can't tell a spoken line from narration
    // that quotes an inscription. Acceptable: it only means such a line is LEFT
    // to the model rather than forced to narrator — never the reverse.
    expect(isSpokenLine('На двери висела табличка «Закрыто».')).toBe(true);
  });
  it('treats smart single-quote dialogue as spoken (UK/Irish typeset convention)', () => {
    expect(isSpokenLine('‘I’m lost,’ she said.')).toBe(true); // leading U+2018
    expect(isSpokenLine('She said ‘this way’ firmly.')).toBe(true); // embedded U+2018…U+2019
  });
  it('treats straight single-quote dialogue as spoken (leading + boundary-anchored embedded)', () => {
    expect(isSpokenLine("'I'm lost,' she said.")).toBe(true); // leading straight '
    expect(isSpokenLine("She said 'go away' angrily.")).toBe(true); // embedded, boundary-anchored
    expect(isSpokenLine("'Aye, Captain,'")).toBe(true); // leading-only spoken split
  });
  it('a single quote used as an apostrophe does NOT make narration spoken', () => {
    expect(isSpokenLine('She didn’t know where she was.')).toBe(false); // smart apostrophe (lone U+2019)
    expect(isSpokenLine("She didn't know where she'd been.")).toBe(false); // straight apostrophes, word-internal
    expect(isSpokenLine("The dogs' bones lay by the cats' bowls.")).toBe(false); // possessive apostrophes
    expect(isSpokenLine("O'Brien walked past the corner.")).toBe(false); // name apostrophe
  });
  it('narration quoting a sign with straight double quotes still reads as spoken (documented false-negative)', () => {
    expect(isSpokenLine('She read the sign that said "Exit".')).toBe(true);
  });
});

describe('forceNarratorOnNonSpokenLines', () => {
  it('rewrites non-spoken sentences to narrator, leaves spoken lines untouched', () => {
    const input = [
      s(1, 'egor', 'Егор засунул руки в карманы, покосился назад.'),
      s(2, 'woman', '— Иди сюда.., иди ко мне...'),
      s(3, 'egor', 'Мальчик шёл по переходу.'),
    ];
    const out = forceNarratorOnNonSpokenLines(input);
    expect(out.map((x) => x.characterId)).toEqual(['narrator', 'woman', 'narrator']);
  });
  it('does not mutate the input array or its elements', () => {
    const input = [s(1, 'egor', 'Егор побежал.')];
    const out = forceNarratorOnNonSpokenLines(input);
    expect(input[0].characterId).toBe('egor');
    expect(out[0]).not.toBe(input[0]);
  });
  it('preserves all other fields', () => {
    const input = [{ id: 7, chapterId: 2, characterId: 'egor', text: 'Он обернулся.', confidence: 0.55, emotion: 'sad' } as SentenceOutput];
    const out = forceNarratorOnNonSpokenLines(input);
    expect(out[0]).toMatchObject({ id: 7, chapterId: 2, characterId: 'narrator', text: 'Он обернулся.', confidence: 0.55, emotion: 'sad' });
  });
});

describe('applyNonEnglishNarratorDefault', () => {
  const input = [s(1, 'egor', 'Егор побежал.'), s(2, 'woman', '— Стой!')];
  it('applies the heuristic for non-English languages', () => {
    expect(applyNonEnglishNarratorDefault(input, 'ru').map((x) => x.characterId)).toEqual(['narrator', 'woman']);
    expect(applyNonEnglishNarratorDefault(input, 'ru-RU').map((x) => x.characterId)).toEqual(['narrator', 'woman']);
  });
  it('is a no-op for English and for missing language (returns the same array reference)', () => {
    expect(applyNonEnglishNarratorDefault(input, 'en')).toBe(input);
    expect(applyNonEnglishNarratorDefault(input, undefined)).toBe(input);
  });
  it('leaves English characterIds unchanged in VALUE, not just reference (guards a gate regression)', () => {
    const en = [s(1, 'halloran', 'The wind had turned.'), s(2, 'halloran', '"Hard to starboard,"')];
    const out = applyNonEnglishNarratorDefault(en, 'en');
    expect(out.map((x) => x.characterId)).toEqual(['halloran', 'halloran']);
  });
});

describe('narrator-default + foldMinorCast interaction', () => {
  it('a speaker with >= minLines real (dashed) dialogue lines survives the fold', () => {
    // egor: 4 narration lines (model mislabeled as egor) + 3 real dashed lines
    const sentences = [
      s(1, 'egor', 'Егор засунул руки в карманы.'),
      s(2, 'egor', 'Мальчик посмотрел вверх.'),
      s(3, 'egor', 'Егор побежал.'),
      s(4, 'egor', 'Он обернулся.'),
      s(5, 'egor', '— Хорошо.'),
      s(6, 'egor', '— Иду.'),
      s(7, 'egor', '— Сейчас.'),
    ];
    const chars = [
      { id: 'narrator', name: 'Narrator', role: 'narrator', gender: 'neutral' },
      { id: 'egor', name: 'Егор', role: 'Boy', gender: 'male' },
    ] as any;
    const fixed = forceNarratorOnNonSpokenLines(sentences); // 4 narration -> narrator, 3 dashed stay egor
    const folded = foldMinorCast(chars, fixed, { minLines: 3 });
    expect(folded.characters.some((c) => c.id === 'egor')).toBe(true); // survived (3 dialogue lines)
    expect(folded.rewrites['egor']).toBeUndefined(); // not folded into a bucket
  });

  it('a speaker with < minLines real dialogue lines folds — intended (count is now accurate)', () => {
    const sentences = [
      s(1, 'extra', 'Прохожий шёл мимо.'),
      s(2, 'extra', 'Он остановился.'),
      s(3, 'extra', '— Что?'),
    ];
    const chars = [
      { id: 'narrator', name: 'Narrator', role: 'narrator', gender: 'neutral' },
      { id: 'extra', name: 'Прохожий', role: 'Passerby', gender: 'male' },
    ] as any;
    const fixed = forceNarratorOnNonSpokenLines(sentences); // 2 narration -> narrator, 1 dashed stays
    const folded = foldMinorCast(chars, fixed, { minLines: 3 });
    expect(folded.rewrites['extra']).toBe('unknown-male'); // 1 dialogue line < 3 -> folded (correct)
  });
});
