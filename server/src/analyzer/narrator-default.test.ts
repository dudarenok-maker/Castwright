import { describe, it, expect } from 'vitest';
import type { SentenceOutput } from '../handoff/schemas.js';
import {
  isSpokenLine,
  forceNarratorOnNonSpokenLines,
  applyNarratorDefault,
} from './narrator-default.js';
import { foldMinorCast } from './fold-minor-cast.js';
import { conventionsFor } from './dialogue-structure/lang/index.js';

// #2245 — isSpokenLine is now driven by the same LanguageConventions tables
// the structure engine uses, not a separate language-blind regex bundle.
const RU = conventionsFor('ru')!;
const EN = conventionsFor('en')!;
const DE = conventionsFor('de')!;
const ES = conventionsFor('es')!;
const FR = conventionsFor('fr')!;
const ZH = conventionsFor('zh')!;
const JA = conventionsFor('ja')!;

const s = (id: number, characterId: string, text: string): SentenceOutput =>
  ({ id, chapterId: 1, characterId, text, confidence: 0.9 }) as SentenceOutput;

describe('isSpokenLine', () => {
  it('treats leading em-dash / en-dash / hyphen as spoken (ru dialogueOpen)', () => {
    expect(isSpokenLine('— Иди сюда', RU)).toBe(true);
    expect(isSpokenLine('– Иди сюда', RU)).toBe(true);
    expect(isSpokenLine('- Иди сюда', RU)).toBe(true);
    expect(isSpokenLine('   — с ведущими пробелами', RU)).toBe(true);
  });
  it('rule 1: es/fr leading dash also reads as spoken (same dialogueOpen mechanism as ru)', () => {
    expect(isSpokenLine('—Un momento', ES)).toBe(true);
    expect(isSpokenLine('—Un instant', FR)).toBe(true);
  });
  it('matches named HTML dash entities at the start (stripHtml may leave them)', () => {
    expect(isSpokenLine('&mdash; Иди сюда', RU)).toBe(true);
    expect(isSpokenLine('&ndash; Стой', RU)).toBe(true);
  });
  it('a bare dash line is spoken (no text after the marker)', () => {
    expect(isSpokenLine('—', RU)).toBe(true);
    expect(isSpokenLine('- ', RU)).toBe(true);
  });
  it('treats leading or embedded quote spans as spoken (ru guillemets)', () => {
    expect(isSpokenLine('«Привет»', RU)).toBe(true);
    expect(isSpokenLine('Он сказал «привет» громко', RU)).toBe(true);
  });
  it('treats leading or embedded quote spans as spoken (en straight/smart double)', () => {
    expect(isSpokenLine('"Hard to starboard"', EN)).toBe(true);
    expect(isSpokenLine('“smart quotes”', EN)).toBe(true);
  });
  it('treats plain third-person narration as NOT spoken', () => {
    expect(isSpokenLine('Егор засунул руки в карманы, покосился назад.', RU)).toBe(false);
    expect(isSpokenLine('Мальчик шёл по переходу.', RU)).toBe(false);
    expect(isSpokenLine('', RU)).toBe(false);
    // mid-sentence dash is punctuation, not a dialogue marker (dialogueOpen is ^-anchored)
    expect(isSpokenLine('Ветер толкнул Егора последний раз и стих - будто смирился.', RU)).toBe(false);
  });
  it('KNOWN false-positive: narration quoting a sign/title reads as spoken (documented limitation)', () => {
    // The embedded-quoted-span branch can't tell a spoken line from narration
    // that quotes an inscription. Acceptable: it only means such a line is LEFT
    // to the model rather than forced to narrator — never the reverse.
    expect(isSpokenLine('На двери висела табличка «Закрыто».', RU)).toBe(true);
  });
  it('treats smart single-quote dialogue as spoken (UK/Irish typeset convention)', () => {
    expect(isSpokenLine('‘I’m lost,’ she said.', EN)).toBe(true); // leading U+2018
    expect(isSpokenLine('She said ‘this way’ firmly.', EN)).toBe(true); // embedded U+2018…U+2019
  });
  it('rule 2: an opening quote with no companion close in the fragment is spoken via the opener check alone', () => {
    // #2245 review follow-up to the pre-existing "leading-only spoken split"
    // shape: previously exercised with a straight single quote, which no
    // longer applies (see the apostrophe test below) — a smart single quote
    // is the real-world equivalent en.quotePairs actually recognises.
    expect(isSpokenLine('„Schnell!', DE)).toBe(true); // German leading „, no close in this fragment
    expect(isSpokenLine('«Привет', RU)).toBe(true); // Russian leading «, no close in this fragment
    expect(isSpokenLine('‘Aye, Captain,', EN)).toBe(true); // English smart-single leading-only spoken split
  });
  it(`#2245: straight single-quote dialogue no longer reads as spoken — en.quotePairs carries no ["'","'"] pair`, () => {
    // Measured on the live 20-book corpus (issue #2245): the -83/+226 replay
    // shows this shape occurs ZERO times in 90,566 English sentences — all 83
    // lost lines lead with a dash, none with a straight single quote. Adding
    // a same-glyph ["'","'"] pair was deliberately rejected: it also feeds
    // findQuoteRuns in the structure engine (unmeasured blast radius there),
    // and a same-glyph ' pair would read every apostrophe (don't, she'd) as
    // a quote run.
    expect(isSpokenLine("'I'm lost,' she said.", EN)).toBe(false); // was leading straight '
    expect(isSpokenLine("She said 'go away' angrily.", EN)).toBe(false); // was embedded, boundary-anchored
    expect(isSpokenLine("'Aye, Captain,'", EN)).toBe(false); // was leading-only spoken split
  });
  /* #2279 — THE DECLARED NARROWING. The condition, not a list of examples:
     `isSpokenLine` is now exactly the language's own table, so any convention
     the table does not carry reads as narration — including several the old
     language-blind bundle caught. Two structural consequences are broad enough
     to name, and the two `it()` blocks below are one per consequence:

       (a) `dialogueOpen: null` in en, de, zh AND ja — a leading dash is not
           dialogue in any of the four. The old bundle treated a leading dash
           as dialogue in EVERY language.
       (b) A quote pair absent from `quotePairs` is not dialogue — including
           the zh/ja asymmetry, where `zh` carries `“”` and `ja` does not, so
           the same line splits by language.

     This is the SAME gap the structure engine has (it reads the same tables),
     so the default path is unchanged and the gap is pre-existing there. With
     `analyzer.structure.enabled` OFF these lines now go to the narrator. Zero
     occurrences in the live 20-book corpus — which holds ONE book each of
     de/es/fr/zh/ja and therefore cannot produce a counter-example either way,
     so that zero is not evidence of safety. #2279 carries the row-by-row
     enumeration and the measurement it needs; blocks (a) and (b) below are its
     executable copy, so a row added to either belongs in the other and in
     #2279's table. */
  it('#2279 (a): a leading dash is not dialogue where dialogueOpen is null — en, de, zh, ja', () => {
    expect(EN.dialogueOpen).toBeNull(); // the four below are a consequence of the tables,
    expect(DE.dialogueOpen).toBeNull(); // not four independent facts — if a table ever
    expect(ZH.dialogueOpen).toBeNull(); // gains a dialogueOpen, the matching row must go.
    expect(JA.dialogueOpen).toBeNull();
    expect(isSpokenLine('—Dame Alina', EN)).toBe(false); // the corpus -83, all of them narration
    expect(isSpokenLine('— Komm her, sagte er.', DE)).toBe(false);
    expect(isSpokenLine('&mdash; Komm her', DE)).toBe(false); // entity form too — de has no dialogueOpen at all
    expect(isSpokenLine('——你好', ZH)).toBe(false);
    expect(isSpokenLine('— こんにちは', JA)).toBe(false);
  });
  it('#2279 (b): a quote pair absent from the language table is not dialogue', () => {
    expect(isSpokenLine('"Hallo", sagte er.', DE)).toBe(false); // fully-ASCII; de carries „…" but not "…"
    expect(isSpokenLine('“Hallo”, sagte er.', DE)).toBe(false); // “ is German's CLOSER, never an opener
    expect(isSpokenLine('«Lass das.»', DE)).toBe(false); // Swiss order; de carries »…« only
    expect(isSpokenLine('"Hola", dijo.', ES)).toBe(false); // es carries «» and “” only
    expect(isSpokenLine('"Bonjour", dit-il.', FR)).toBe(false); // fr.quotePairs is «» only
    expect(isSpokenLine('“Bonjour”, dit-il.', FR)).toBe(false);
    expect(isSpokenLine('‘Привет’', RU)).toBe(false); // ru carries «», „“, “”, "" — not ‘’
    expect(isSpokenLine('«Bonjour»', EN)).toBe(false); // en carries no guillemets
    // The zh/ja asymmetry: same line, opposite answers, because zh.quotePairs
    // carries ['“','”'] and ja.quotePairs does not.
    expect(isSpokenLine('“你好”', ZH)).toBe(true);
    expect(isSpokenLine('“おはよう”', JA)).toBe(false);
    // es/fr dialogueOpen carry &mdash; but not &ndash; (ru carries both).
    expect(isSpokenLine('&ndash; Un momento', ES)).toBe(false);
    expect(isSpokenLine('&ndash; Un instant', FR)).toBe(false);
    expect(isSpokenLine('&mdash; Un momento', ES)).toBe(true); // the entity that IS carried, as the control
  });
  it('a single quote used as an apostrophe does NOT make narration spoken', () => {
    expect(isSpokenLine('She didn’t know where she was.', EN)).toBe(false); // smart apostrophe (lone U+2019)
    expect(isSpokenLine("She didn't know where she'd been.", EN)).toBe(false); // straight apostrophes, word-internal
    expect(isSpokenLine("The dogs' bones lay by the cats' bowls.", EN)).toBe(false); // possessive apostrophes
    expect(isSpokenLine("O'Brien walked past the corner.", EN)).toBe(false); // name apostrophe
  });
  it('narration quoting a sign with straight double quotes still reads as spoken (documented false-positive)', () => {
    expect(isSpokenLine('She read the sign that said "Exit".', EN)).toBe(true);
  });
  it('#2245: English leading dashes stop being dialogue — en.dialogueOpen is null', () => {
    // Measured on the live corpus: this is the -83, all of them narration
    // (name credits, stage directions, headings, split-sentence continuations)
    // — not one is a line of dialogue. See issue #2245's "Acceptance
    // criterion 2 is now measured" comment for the full census.
    expect(isSpokenLine('—Dame Alina', EN)).toBe(false);
  });
  it('treats German „…“ dialogue as spoken (leading and embedded)', () => {
    expect(isSpokenLine('„Schnell!“', DE)).toBe(true);                 // leading German open-quote
    expect(isSpokenLine('Er sagte „komm her“ leise.', DE)).toBe(true); // embedded German span
  });
  it('#2245: all four de.quotePairs forms are spoken in BOTH leading and embedded position', () => {
    // The 8-cell table from issue #2245's body. Before the fix, only »…«
    // was missed in leading position (the other three „-opening forms
    // matched); in embedded position only „…“ matched and the other three
    // were missed — the old regex bundle carried one German quote form of
    // the four in de.quotePairs.
    // Leading:
    expect(isSpokenLine('„Lass das.“', DE)).toBe(true);
    expect(isSpokenLine('„Lass das.”', DE)).toBe(true);
    expect(isSpokenLine('„Lass das."', DE)).toBe(true);
    expect(isSpokenLine('»Lass das.«', DE)).toBe(true);
    // Embedded:
    expect(isSpokenLine('Er sagte „Lass das.“ und ging.', DE)).toBe(true);
    expect(isSpokenLine('Er sagte „Lass das.” und ging.', DE)).toBe(true);
    expect(isSpokenLine('Er sagte „Lass das." und ging.', DE)).toBe(true);
    expect(isSpokenLine('Er sagte »Lass das.« und ging.', DE)).toBe(true);
  });
  it('treats CJK quote-only dialogue as spoken (leading and embedded, zh/ja) — the +226 in the corpus replay', () => {
    expect(isSpokenLine('「你好」', ZH)).toBe(true);
    expect(isSpokenLine('他说「你好」很大声', ZH)).toBe(true);
    expect(isSpokenLine('「おはよう」', JA)).toBe(true);
    expect(isSpokenLine('彼は「おはよう」と言った。', JA)).toBe(true);
  });
});

describe('forceNarratorOnNonSpokenLines', () => {
  it('rewrites non-spoken sentences to narrator, leaves spoken lines untouched', () => {
    const input = [
      s(1, 'egor', 'Егор засунул руки в карманы, покосился назад.'),
      s(2, 'woman', '— Иди сюда.., иди ко мне...'),
      s(3, 'egor', 'Мальчик шёл по переходу.'),
    ];
    const out = forceNarratorOnNonSpokenLines(input, RU);
    expect(out.map((x) => x.characterId)).toEqual(['narrator', 'woman', 'narrator']);
  });
  it('does not mutate the input array or its elements', () => {
    const input = [s(1, 'egor', 'Егор побежал.')];
    const out = forceNarratorOnNonSpokenLines(input, RU);
    expect(input[0].characterId).toBe('egor');
    expect(out[0]).not.toBe(input[0]);
  });
  it('preserves all other fields', () => {
    const input = [{ id: 7, chapterId: 2, characterId: 'egor', text: 'Он обернулся.', confidence: 0.55, emotion: 'sad' } as SentenceOutput];
    const out = forceNarratorOnNonSpokenLines(input, RU);
    expect(out[0]).toMatchObject({ id: 7, chapterId: 2, characterId: 'narrator', text: 'Он обернулся.', confidence: 0.55, emotion: 'sad' });
  });
  it('returns the array by reference, untouched, when conventions is null (no table)', () => {
    const input = [s(1, 'egor', 'Егор побежал.')];
    const out = forceNarratorOnNonSpokenLines(input, null);
    expect(out).toBe(input);
  });
});

describe('applyNarratorDefault', () => {
  it('runs for English: demotes non-spoken character lines to narrator, leaves spoken lines', () => {
    const en = [s(1, 'stephanie', 'She was lost.'), s(2, 'stephanie', '"Hard to starboard,"')];
    expect(applyNarratorDefault(en, EN).map((x) => x.characterId)).toEqual(['narrator', 'stephanie']);
  });

  it('clamps only the FIRST override in a contiguous demoted run to 0.5', () => {
    const run = [
      s(1, 'stephanie', 'She was lost.'),
      s(2, 'stephanie', 'She turned away from the dead end.'),
      s(3, 'stephanie', 'She tried to remember the way.'),
    ];
    const out = applyNarratorDefault(run, EN);
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
    const out = applyNarratorDefault(seq, EN);
    expect(out.map((x) => x.characterId)).toEqual(['narrator', 'narrator', 'stephanie', 'narrator']);
    expect(out.map((x) => x.confidence)).toEqual([0.5, 0.9, 0.9, 0.5]);
  });

  it('leaves pre-existing narrator lines untouched and they do not consume the clamp slot', () => {
    const seq = [
      s(1, 'narrator', 'The hall was dark.'),  // already narrator
      s(2, 'stephanie', 'She was lost.'),       // first override of the run -> 0.5
    ];
    const out = applyNarratorDefault(seq, EN);
    expect(out[0]).toBe(seq[0]); // unchanged reference
    expect(out[1].characterId).toBe('narrator');
    expect(out[1].confidence).toBe(0.5);
  });

  it('clamp is min, not overwrite: a model confidence already below 0.5 stays', () => {
    const low = [
      { id: 1, chapterId: 1, characterId: 'stephanie', text: 'She was lost.', confidence: 0.3 } as SentenceOutput,
    ];
    expect(applyNarratorDefault(low, EN)[0].confidence).toBe(0.3);
  });

  it('demotes non-English narration too AND now flags it (both-language flag)', () => {
    const ru = [s(1, 'egor', 'Егор побежал.'), s(2, 'woman', '— Стой!')];
    const out = applyNarratorDefault(ru, RU);
    expect(out.map((x) => x.characterId)).toEqual(['narrator', 'woman']);
    expect(out[0].confidence).toBe(0.5); // previously silent, now flagged
  });

  it('#2245: conventions === null (no table) returns the array by reference, untouched — no demotion', () => {
    // "No basis to judge" is deliberately milder than demoting the whole
    // book to narrator (the pre-#2245 behaviour for an unsupported language).
    const input = [s(1, 'stephanie', 'She was lost.'), s(2, 'egor', 'Он побежал.')];
    const out = applyNarratorDefault(input, null);
    expect(out).toBe(input);
    expect(out.map((x) => x.characterId)).toEqual(['stephanie', 'egor']);
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
    const fixed = forceNarratorOnNonSpokenLines(sentences, RU); // 4 narration -> narrator, 3 dashed stay egor
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
    const fixed = forceNarratorOnNonSpokenLines(sentences, RU); // 2 narration -> narrator, 1 dashed stays
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
    const fixed = applyNarratorDefault(sentences, EN); // 2 narration -> narrator, 1 quoted stays
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
    const fixed = applyNarratorDefault(sentences, EN); // 2 narration -> narrator, 3 quoted stay
    const folded = foldMinorCast(chars, fixed, { minLines: 3 });
    expect(folded.characters.some((c) => c.id === 'stephanie')).toBe(true); // survived (3 quoted lines)
    expect(folded.rewrites['stephanie']).toBeUndefined();
  });
});
