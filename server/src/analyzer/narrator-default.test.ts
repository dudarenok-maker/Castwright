import { describe, it, expect } from 'vitest';
import type { SentenceOutput } from '../handoff/schemas.js';
import {
  isSpokenLine,
  forceNarratorOnNonSpokenLines,
  applyNarratorDefault,
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
  it('treats German „…“ dialogue as spoken (leading and embedded)', () => {
    expect(isSpokenLine('„Schnell!“')).toBe(true);                 // leading German open-quote
    expect(isSpokenLine('Er sagte „komm her“ leise.')).toBe(true); // embedded German span
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

describe('applyNarratorDefault', () => {
  it('runs for English: demotes non-spoken character lines to narrator, leaves spoken lines', () => {
    const en = [s(1, 'stephanie', 'She was lost.'), s(2, 'stephanie', '"Hard to starboard,"')];
    expect(applyNarratorDefault(en).map((x) => x.characterId)).toEqual(['narrator', 'stephanie']);
  });

  it('clamps only the FIRST override in a contiguous demoted run to 0.5', () => {
    const run = [
      s(1, 'stephanie', 'She was lost.'),
      s(2, 'stephanie', 'She turned away from the dead end.'),
      s(3, 'stephanie', 'She tried to remember the way.'),
    ];
    const out = applyNarratorDefault(run);
    expect(out.map((x) => x.characterId)).toEqual(['narrator', 'narrator', 'narrator']);
    expect(out.map((x) => x.confidence)).toEqual([0.5, 0.9, 0.9]);
  });

  it('a spoken line resets the run so each demoted block gets its own single flag', () => {
    const seq = [
      s(1, 'stephanie', 'She was lost.'),       // override -> clamp 0.5
      s(2, 'stephanie', 'She turned away.'),     // override -> 0.9
      s(3, 'stephanie', '"This way,"'),          // spoken -> reset
      s(4, 'stephanie', 'She walked on.'),       // override -> clamp 0.5 (new run)
    ];
    const out = applyNarratorDefault(seq);
    expect(out.map((x) => x.characterId)).toEqual(['narrator', 'narrator', 'stephanie', 'narrator']);
    expect(out.map((x) => x.confidence)).toEqual([0.5, 0.9, 0.9, 0.5]);
  });

  it('leaves pre-existing narrator lines untouched and they do not consume the clamp slot', () => {
    const seq = [
      s(1, 'narrator', 'The hall was dark.'),  // already narrator
      s(2, 'stephanie', 'She was lost.'),       // first override of the run -> 0.5
    ];
    const out = applyNarratorDefault(seq);
    expect(out[0]).toBe(seq[0]); // unchanged reference
    expect(out[1].characterId).toBe('narrator');
    expect(out[1].confidence).toBe(0.5);
  });

  it('clamp is min, not overwrite: a model confidence already below 0.5 stays', () => {
    const low = [
      { id: 1, chapterId: 1, characterId: 'stephanie', text: 'She was lost.', confidence: 0.3 } as SentenceOutput,
    ];
    expect(applyNarratorDefault(low)[0].confidence).toBe(0.3);
  });

  it('demotes non-English narration too AND now flags it (both-language flag)', () => {
    const ru = [s(1, 'egor', 'Егор побежал.'), s(2, 'woman', '— Стой!')];
    const out = applyNarratorDefault(ru);
    expect(out.map((x) => x.characterId)).toEqual(['narrator', 'woman']);
    expect(out[0].confidence).toBe(0.5); // previously silent, now flagged
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

  it('English: a character whose only lines are demoted narration folds out (intended)', () => {
    const sentences = [
      s(1, 'extra', 'A passer-by walked past.'),
      s(2, 'extra', 'He paused at the corner.'),
      s(3, 'extra', '"What?"'), // one real quoted line
    ];
    const chars = [
      { id: 'narrator', name: 'Narrator', role: 'narrator', gender: 'neutral' },
      { id: 'extra', name: 'Passer-by', role: 'Passerby', gender: 'male' },
    ] as any;
    const fixed = applyNarratorDefault(sentences); // 2 narration -> narrator, 1 quoted stays
    const folded = foldMinorCast(chars, fixed, { minLines: 3 });
    expect(folded.rewrites['extra']).toBe('unknown-male'); // 1 dialogue line < 3 -> folded (correct)
  });

  it('English: a character with >= minLines real quoted lines survives the fold', () => {
    const sentences = [
      s(1, 'stephanie', 'She was lost.'),
      s(2, 'stephanie', 'She turned away.'),
      s(3, 'stephanie', '"This way,"'),
      s(4, 'stephanie', '"No, wait,"'),
      s(5, 'stephanie', '"Here."'),
    ];
    const chars = [
      { id: 'narrator', name: 'Narrator', role: 'narrator', gender: 'neutral' },
      { id: 'stephanie', name: 'Stephanie', role: 'Protagonist', gender: 'female' },
    ] as any;
    const fixed = applyNarratorDefault(sentences); // 2 narration -> narrator, 3 quoted stay
    const folded = foldMinorCast(chars, fixed, { minLines: 3 });
    expect(folded.characters.some((c) => c.id === 'stephanie')).toBe(true); // survived (3 quoted lines)
    expect(folded.rewrites['stephanie']).toBeUndefined();
  });
});
