/* Server-side manuscript language detection (fs-41/fs-50 seam 2).
   Script pre-pass is authoritative; franc disambiguates Latin; front-matter
   stripped before detecting; es/fr/de detected but not yet `supported`. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectManuscriptLanguage, detectManuscriptLanguageFromChapters, prepareSample } from './detect-language.js';
import { getLanguageEntry } from './language-registry.js';
import { countWords, FRONT_MATTER_WORD_THRESHOLD } from '../parsers/front-matter.js';
import {
  countProseUnits,
  PROSE_UNIT_FLOOR,
  guiraudR,
  LEXICAL_RICHNESS_FLOOR,
  digitTokenShare,
  DIGIT_TOKEN_SHARE_CEILING,
  joinSamplesForGates,
} from './prose-units.js';

describe('detectManuscriptLanguage', () => {
  it('detects Russian via the Cyrillic pre-pass (supported)', () => {
    const ru =
      'Горн остыл до цвета подёрнутого пеплом заката, и Рен выскребала последнюю окалину, когда раздался стук в дверь её мастерской.';
    expect(detectManuscriptLanguage(ru)).toEqual({ language: 'ru', supported: true, fallback: false });
  });

  it('detects Spanish (present in the registry, supported — canary-validated)', () => {
    const es =
      'El horno se había enfriado hasta el color de un atardecer cubierto de ceniza, y Wren raspaba la última escoria cuando alguien llamó a la puerta de su taller.';
    expect(detectManuscriptLanguage(es)).toEqual({ language: 'es', supported: true, fallback: false });
  });

  it('detects French (supported, plan 229)', () => {
    const fr =
      "Le four avait refroidi jusqu'à la couleur d'un coucher de soleil couvert de cendre, et Wren raclait la dernière scorie lorsque l'on frappa à la porte de son atelier.";
    expect(detectManuscriptLanguage(fr)).toEqual({ language: 'fr', supported: true, fallback: false });
  });

  it('detects German (supported, plan 229)', () => {
    const de =
      'Der Ofen war bis zur Farbe eines aschbedeckten Sonnenuntergangs abgekühlt, und Wren kratzte die letzte Schlacke ab, als es an der Tür ihrer Werkstatt klopfte.';
    expect(detectManuscriptLanguage(de)).toEqual({ language: 'de', supported: true, fallback: false });
  });

  it('keeps an English manuscript English even when dense with French proper nouns', () => {
    const en =
      'Marcel Beaumont and Geneviève Dubois walked along the Champs-Élysées toward the Café de Flore, where Henri Toussaint waited beneath the awning with the morning papers.';
    // A real franc match on 'en' is a decision, not a surrender: fallback must be false
    // even though the language happens to be the same value the surrender paths guess.
    expect(detectManuscriptLanguage(en)).toEqual({ language: 'en', supported: true, fallback: false });
  });

  it('returns English for empty / letter-less input, flagged as a fallback guess', () => {
    // Surrender branch 1 (detect-language.ts): letters === 0. `language`/`supported`
    // are identical to a genuine English decision — only `fallback` distinguishes them.
    expect(detectManuscriptLanguage('')).toEqual({ language: 'en', supported: true, fallback: true });
    expect(detectManuscriptLanguage('1234 — ... !!!')).toEqual({
      language: 'en',
      supported: true,
      fallback: true,
    });
  });

  it('flags English as a fallback guess when franc finds no Latin match', () => {
    // Surrender branch 2 (detect-language.ts): the terminal `match ? … : result('en')`
    // when franc returns 'und' or a code outside the registry's Latin set. Short,
    // ambiguous, punctuation-heavy text starves franc below its confidence floor.
    const r = detectManuscriptLanguage('. . . ? ! -- ok yes no');
    expect(r).toEqual({ language: 'en', supported: true, fallback: true });
  });

  it('strips an English front-matter page before detecting the Spanish body', () => {
    const text =
      'Copyright © 2026 Some Publisher. All rights reserved.\nFirst published as an ebook.\nhttps://example.com/book\n\n' +
      'El horno se había enfriado hasta el color de un atardecer cubierto de ceniza, y Wren raspaba la última escoria cuando alguien llamó a la puerta de su taller, una y otra vez, hasta que abrió.';
    // stripFrontMatterBoilerplate drops the bare-URL + copyright lines; the Spanish
    // body dominates the sample, so franc must return Spanish, not English.
    expect(detectManuscriptLanguage(text)).toEqual({ language: 'es', supported: true, fallback: false });
  });

  it('flags a CJK manuscript with `supported` read THROUGH the registry (fs-59 W2 mechanism; W5 flips zh to supported:true) rather than hardcoded', () => {
    const zh = '熔炉已经冷却到被灰烬覆盖的落日的颜色，当有人敲响她作坊的门时，雷恩正在刮掉最后的炉渣。';
    const r = detectManuscriptLanguage(zh);
    // read-through, not a literal: mirrors whatever the registry says
    // (true since fs-59 W5 flipped zh.supported = true).
    expect(r.supported).toBe(getLanguageEntry('zh')?.supported ?? false);
    expect(['zh', 'ja']).toContain(r.language);
    expect(r.fallback).toBe(false); // script pre-pass match — a decision, not a guess
  });

  it('detects Japanese via the CJK pre-pass, supported reads through the registry (true since fs-59 W5)', () => {
    const ja = '彼は歩いた。彼女は走った。'.repeat(50);
    const r = detectManuscriptLanguage(ja);
    expect(r.language).toBe('ja');
    expect(r.supported).toBe(getLanguageEntry('ja')?.supported ?? false);
    expect(r.fallback).toBe(false); // script pre-pass match — a decision, not a guess
  });
});

describe('detectManuscriptLanguage — CJK read-through proof (fs-59 W2, independent-review CRITICAL finding)', () => {
  /* Each test must: vi.resetModules() → vi.doMock() → dynamic import, so the
     dynamic `import('./detect-language.js')` inside the test picks up the
     stubbed registry rather than the module cache (see ensure-sidecar-loaded.test.ts
     for the same pattern). This is the load-bearing test: it does NOT rely on
     the real registry's current zh.supported value (true since fs-59 W5) — it
     stubs the registry to zh.supported=true independently and proves detection
     propagates that stub, which only happens if the CJK branch calls the
     `result()` helper instead of returning a hardcoded `{ supported: false }`
     literal (the original independent-review CRITICAL finding). */
  afterEach(() => {
    vi.doUnmock('./language-registry.js');
    vi.resetModules();
  });

  it('propagates a stubbed zh.supported=true through to the detection result', async () => {
    vi.resetModules();
    vi.doMock('./language-registry.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./language-registry.js')>();
      return {
        ...actual,
        allLanguageEntries: () =>
          actual.allLanguageEntries().map((e) => (e.code === 'zh' ? { ...e, supported: true } : e)),
      };
    });
    const { detectManuscriptLanguage: detectWithStub } = await import('./detect-language.js');
    const zh = '熔炉已经冷却到被灰烬覆盖的落日的颜色，当有人敲响她作坊的门时，雷恩正在刮掉最后的炉渣。';
    const r = detectWithStub(zh);
    expect(r.language).toBe('zh');
    expect(r.supported).toBe(true); // only true if the CJK branch reads THROUGH the registry
    expect(r.fallback).toBe(false); // script pre-pass match — a decision, not a guess
  });
});

/* #2263 — chapter-aware entry point (POST /api/import calls this instead of
   detectManuscriptLanguage). Fixtures repeat a single real sentence enough
   times to clear BOTH thresholds a body chapter needs to enter the vote:
   FRONT_MATTER_WORD_THRESHOLD (150 words) and, for the single-chapter path,
   PROSE_UNIT_FLOOR (20 sentence-terminal units) — each repeat is one unit. */
describe('detectManuscriptLanguageFromChapters (#2263)', () => {
  const EN_SENTENCE =
    'Marcel Beaumont and Geneviève Dubois walked along the Champs-Élysées toward the Café de Flore, where Henri Toussaint waited beneath the awning with the morning papers.';
  const RU_SENTENCE =
    'Горн остыл до цвета подёрнутого пеплом заката, и Рен выскребала последнюю окалину, когда раздался стук в дверь её мастерской.';
  const ZH_SENTENCE =
    '熔炉已经冷却到被灰烬覆盖的落日的颜色，当有人敲响她作坊的门时，雷恩正在刮掉最后的炉渣。';
  const repeat = (sentence: string, times = 25) => Array(times).fill(sentence).join(' ');

  it('votes over multiple body chapters and returns the unanimous language', () => {
    const r = detectManuscriptLanguageFromChapters([
      { title: 'Chapter One', body: repeat(EN_SENTENCE) },
      { title: 'Chapter Two', body: repeat(EN_SENTENCE) },
    ]);
    expect(r).toEqual({ language: 'en', supported: true, fallback: false });
  });

  it('drops a front-matter-titled chapter from the vote, not just outvotes it', () => {
    // Without the title filter this would be a 1-en/1-ru split (no strict
    // majority) and surrender. With it, "Copyright" never enters the vote,
    // leaving a single English candidate that clears the floor on its own.
    const r = detectManuscriptLanguageFromChapters([
      { title: 'Copyright', body: repeat(RU_SENTENCE) },
      { title: 'Chapter One', body: repeat(EN_SENTENCE) },
    ]);
    expect(r).toEqual({ language: 'en', supported: true, fallback: false });
  });

  it('drops SEVERAL short, non-front-matter-titled chapters by WORD COUNT — their COMBINED mass would otherwise outvote the real body (#2276 mass-vote isolation)', () => {
    // Under mass-weighted voting, a literal 1-vs-1 (one short lookalike vs
    // one real body chapter) can NEVER isolate the word-count filter: a
    // chapter that clears FRONT_MATTER_WORD_THRESHOLD to remain a candidate
    // always has >= as much mass as one that was dropped for falling short
    // of it, so removing the filter can't flip a clean two-way contest — see
    // the retitled 煤落的委托 test below, which this test's comment explains.
    // FIVE short lookalike chapters, each individually under the threshold,
    // combine to out-mass the real body if the word-count filter doesn't
    // drop them — that's what actually exercises the mechanism.
    const shortWrongChapters = Array.from({ length: 5 }, (_, i) => ({
      title: `Aside ${i + 1}`, // not a front-matter title
      body: repeat(RU_SENTENCE, 7), // 133 words — under the 150-word threshold
    }));
    const realBody = { title: 'Chapter One', body: repeat(EN_SENTENCE) }; // 625 words

    // Fixture sanity: each short chapter is confidently 'ru' alone, and five
    // of them together outweigh the real body's word count — the premise
    // this test needs to be a genuine (not vacuous) mass-flip.
    const shortDetection = detectManuscriptLanguage(shortWrongChapters[0].body);
    expect(shortDetection).toEqual({ language: 'ru', supported: true, fallback: false });
    const shortTotalMass = shortWrongChapters.reduce((sum, c) => sum + countWords(c.body), 0);
    expect(shortTotalMass).toBeGreaterThan(countWords(realBody.body));
    expect(countWords(shortWrongChapters[0].body)).toBeLessThan(FRONT_MATTER_WORD_THRESHOLD);

    const r = detectManuscriptLanguageFromChapters([...shortWrongChapters, realBody]);
    expect(r).toEqual({ language: 'en', supported: true, fallback: false });
  });

  it('drops a short, non-front-matter-titled first chapter by WORD COUNT alone (the 煤落的委托 shape) — real-world repro; this fixture alone is too mass-lopsided to prove the filter is NECESSARY under mass-weighted voting (see the mass-flip test above for that proof)', () => {
    // Real repro against the live corpus book: this exact chapter body,
    // detected alone, is a confident (fallback:false) WRONG 'en' vote.
    // #2276 — under mass-weighted voting, this fixture's single 6-word
    // lookalike chapter is too tiny to ever outweigh two real ~660-word zh
    // chapters, filtered or not — deleting the word-count clause of
    // selectBodyChapters does NOT redden this test (verified). It still
    // documents the real-world shape and confirms the filter doesn't
    // (harmlessly) mis-fire on it; the test above is the one that locks the
    // filter's necessity.
    const lookalike = detectManuscriptLanguage('[emphatic] Castwright 原创作品。\n\n---');
    expect(lookalike).toEqual({ language: 'en', supported: true, fallback: false });

    const r = detectManuscriptLanguageFromChapters([
      { title: 'Chapter 1', body: '[emphatic] Castwright 原创作品。\n\n---' }, // not a front-matter TITLE, but far under FRONT_MATTER_WORD_THRESHOLD
      { title: '第一章', body: repeat(ZH_SENTENCE) },
      { title: '第二章', body: repeat(ZH_SENTENCE) },
    ]);
    expect(r.language).toBe('zh');
    expect(r.fallback).toBe(false);
  });

  it('2-vs-2 split (en/ru), no strict majority → surrenders', () => {
    // #2276 — mass-weighted, so a genuine tie needs equal MASS, not equal
    // chapter count: EN_SENTENCE (25 words) and RU_SENTENCE (19 words) are
    // different lengths, so repeat() at the same count no longer balances.
    // repeat(EN, 19) x repeat(RU, 25) both land on 475 words/chapter — a
    // real 950-vs-950 tie — verified via the sanity assertion below rather
    // than trusted by eye.
    const enChapterBody = repeat(EN_SENTENCE, 19);
    const ruChapterBody = repeat(RU_SENTENCE, 25);
    expect(countWords(enChapterBody)).toBe(countWords(ruChapterBody));

    const r = detectManuscriptLanguageFromChapters([
      { title: 'Chapter One', body: enChapterBody },
      { title: 'Chapter Two', body: enChapterBody },
      { title: 'Глава первая', body: ruChapterBody },
      { title: 'Глава вторая', body: ruChapterBody },
    ]);
    expect(r).toEqual({ language: 'en', supported: true, fallback: true });
  });

  it('a single body chapter ABOVE the prose-unit floor backfills (the floor is not a blanket single-chapter refusal)', () => {
    const r = detectManuscriptLanguageFromChapters([{ title: 'Chapter One', body: repeat(EN_SENTENCE) }]);
    expect(r).toEqual({ language: 'en', supported: true, fallback: false });
  });

  it('a single body chapter BELOW the prose-unit floor surrenders — it cannot corroborate itself', () => {
    // Genuine, confidently-detected English prose on its own (fallback would
    // be false via detectManuscriptLanguage directly) — but only one
    // sentence, far under PROSE_UNIT_FLOOR.
    const solo = detectManuscriptLanguage(EN_SENTENCE);
    expect(solo.fallback).toBe(false);

    const r = detectManuscriptLanguageFromChapters([{ title: 'Chapter One', body: EN_SENTENCE }]);
    expect(r).toEqual({ language: 'en', supported: true, fallback: true });
  });

  it('falls back to considering ALL chapters when every one is front-matter-titled, rather than refusing outright', () => {
    const r = detectManuscriptLanguageFromChapters([
      { title: 'Dedication', body: repeat(EN_SENTENCE) },
      { title: 'Copyright', body: repeat(EN_SENTENCE) },
    ]);
    expect(r).toEqual({ language: 'en', supported: true, fallback: false });
  });

  it('an empty chapter list surrenders rather than throwing', () => {
    expect(detectManuscriptLanguageFromChapters([])).toEqual({ language: 'en', supported: true, fallback: true });
  });
});

/* #2276 — regressions for the three symptoms of the ONE root cause: the old
   per-CHAPTER vote (and its candidates.length === 1 floor keying) made the
   answer depend on how the book happens to be split into chapters. Each
   test below reproduces the exact shape from the bug report and proves the
   fixed (mass-weighted, uniformly-floored) vote no longer depends on the
   split. */
describe('detectManuscriptLanguageFromChapters — #2276 chapter-count-dependence regressions', () => {
  const EN_SENTENCE =
    'Marcel Beaumont and Geneviève Dubois walked along the Champs-Élysées toward the Café de Flore, where Henri Toussaint waited beneath the awning with the morning papers.';
  const DE_SENTENCE =
    'Der Ofen war bis zur Farbe eines aschbedeckten Sonnenuntergangs abgekühlt, und Wren kratzte die letzte Schlacke ab, als es an der Tür ihrer Werkstatt klopfte.';
  const repeat = (sentence: string, times: number) => Array(times).fill(sentence).join(' ');

  it('symptom 1 — a handful of short English chapters no longer outvotes a much larger German body (was: 2 short EN chapters beat 1 long DE chapter on CHAPTER COUNT)', () => {
    // Two English "translator's note"-shaped chapters (titled generically, so
    // neither the front-matter-title filter nor the word-count filter drops
    // them — real books ship notes under a plain chapter heading) against one
    // much larger German body chapter. Under the old per-chapter vote this
    // was 2 EN vs 1 DE — a 66.7% EN "majority" that had nothing to do with
    // how much of the book was actually German.
    const enNoteA = { title: 'Chapter 1', body: repeat(EN_SENTENCE, 8) }; // 200 words
    const enNoteB = { title: 'Chapter 2', body: repeat(EN_SENTENCE, 8) }; // 200 words
    const deBody = { title: 'Chapter 3', body: repeat(DE_SENTENCE, 300) }; // 7,500 words

    const enMass = countWords(enNoteA.body) + countWords(enNoteB.body);
    const deMass = countWords(deBody.body);
    expect(deMass).toBeGreaterThan(enMass * 10); // fixture sanity: body dwarfs the notes by mass

    const r = detectManuscriptLanguageFromChapters([enNoteA, enNoteB, deBody]);
    expect(r).toEqual({ language: 'de', supported: true, fallback: false });
  });

  it('symptom 2 — the SAME junk sample refuses identically whether it is 1 chapter or split into 3', () => {
    // #2246 C1's exact repro: a genuinely-English table of contents that
    // franc mis-disambiguates to a fluent, WRONG, non-fallback language.
    // Pre-fix, splitting this into 3 chapters defeated the single-chapter
    // PROSE_UNIT_FLOOR entirely (it only applied when candidates.length===1)
    // and let franc's per-fragment noise win a spurious "majority". The
    // floor is now keyed to the WINNING mass regardless of split count, so
    // both shapes must refuse.
    const junk = 'Prologue 1 Kaz 2 Inej 3 Kaz 4 Jesper 5 Nina 6 Matthias 7 Inej 8 Wylan 9 Kaz 10 Nina';
    const words = junk.split(' ');
    const asOneChapter = [{ title: 'Chapter 1', body: junk }];
    const asThreeChapters = [
      { title: 'Chapter 1', body: words.slice(0, 7).join(' ') },
      { title: 'Chapter 2', body: words.slice(7, 14).join(' ') },
      { title: 'Chapter 3', body: words.slice(14).join(' ') },
    ];

    const oneResult = detectManuscriptLanguageFromChapters(asOneChapter);
    const threeResult = detectManuscriptLanguageFromChapters(asThreeChapters);
    expect(oneResult.fallback).toBe(true);
    expect(threeResult).toEqual(oneResult);
  });

  it('symptom 3 — the SAME thin German sample refuses identically whether it is 1 chapter or split into 2 (was: split defeated the floor and backfilled a confident WRONG-shaped guess)', () => {
    // ~216 words of real German prose — genuine, confidently-detected German
    // (script isn't the issue), but only ~9 sentence-terminal units, well
    // under PROSE_UNIT_FLOOR (20). Pre-fix, a single chapter correctly
    // surrendered (the candidates.length===1 floor caught it) but splitting
    // it into 2 chapters bypassed the floor altogether (no single-chapter
    // path anymore) and backfilled on an unweighted 2-chapter "unanimous"
    // vote. The floor now sums the winning mass regardless of chapter count,
    // so both shapes must surrender identically.
    const deText = repeat(DE_SENTENCE, 9); // ~225 words, 9 prose units — under the 20-unit floor
    const asOneChapter = [{ title: 'Chapter 1', body: deText }];
    const sentences = Array(9).fill(DE_SENTENCE);
    const asTwoChapters = [
      { title: 'Chapter 1', body: sentences.slice(0, 5).join(' ') },
      { title: 'Chapter 2', body: sentences.slice(5).join(' ') },
    ];

    const oneResult = detectManuscriptLanguageFromChapters(asOneChapter);
    const twoResult = detectManuscriptLanguageFromChapters(asTwoChapters);
    expect(oneResult).toEqual({ language: 'en', supported: true, fallback: true });
    expect(twoResult).toEqual(oneResult);
  });

  it('a surrendered chapter\'s own mass does not dilute the vote\'s denominator — a huge numerals-only chapter cannot drag a real, unanimous winner below a strict majority', () => {
    // voteLanguage's totalMass accumulates over nonSurrendered ballots only
    // (detect-language.ts's own vote loop). A book with one real German
    // chapter and one much larger chapter that is pure space-separated
    // numerals (no letters at all, so it surrenders via the letters === 0
    // script pre-pass gate) must resolve on the German chapter's mass alone
    // — the numerals chapter cleared FRONT_MATTER_WORD_THRESHOLD and its
    // title ("Statistical Tables") isn't front-matter-shaped, so it stays a
    // vote candidate, but its OWN surrendered detection must not count
    // toward the denominator any winner's share is measured against.
    const deChapter = { title: 'Chapter One', body: repeat(DE_SENTENCE, 200) }; // 5,000 words, real German
    const numeralsChapter = {
      title: 'Statistical Tables',
      body: Array.from({ length: 8000 }, (_, i) => i + 1).join(' '), // 8,000 words, zero letters
    };
    expect(countWords(deChapter.body)).toBe(5000);
    expect(countWords(numeralsChapter.body)).toBe(8000);
    const numeralsDetection = detectManuscriptLanguage(numeralsChapter.body);
    expect(numeralsDetection.fallback).toBe(true); // fixture sanity: surrenders on its own, via letters === 0

    const result = detectManuscriptLanguageFromChapters([deChapter, numeralsChapter]);
    expect(result).toEqual({ language: 'de', supported: true, fallback: false });
  });

  it("a surrendered chapter's own prose units do not corroborate the winning language's floor — only reachable with an 'en' winner, since a surrender's guessed language is always 'en'", () => {
    // voteLanguage's winningProseUnits sums nonSurrendered ballots only
    // (detect-language.ts's own vote loop, the winningProseUnits filter
    // right after totalMass/winner are computed). This is the numerator
    // sibling of the denominator test above, but it CANNOT reuse that
    // test's 'de'-winner fixture: a surrender always guesses 'en'
    // (resultFor('en', true)), so the numerals chapter's own
    // `detection.language` is 'en' regardless of winner — it only lands in
    // `winningProseUnits`'s filter (`language === winner`) when the winner
    // IS 'en'. A book with one real, thin English chapter (well under
    // PROSE_UNIT_FLOOR alone) and one much larger all-numerals chapter must
    // still surrender on the English chapter's own prose units alone — the
    // numerals chapter's units must not backfill the floor just because its
    // surrendered guess happens to coincide with the real winner.
    const enChapter = { title: 'Chapter One', body: repeat(EN_SENTENCE, 6) }; // 150 words, 6 prose units — clears FRONT_MATTER_WORD_THRESHOLD, well under PROSE_UNIT_FLOOR (20)
    const numeralsChapter = {
      title: 'Statistical Tables',
      body: Array.from({ length: 400 }, (_, i) => `${i + 1}.`).join(' '), // 400 words, 400 prose units, zero letters
    };
    expect(countWords(enChapter.body)).toBe(150);
    expect(countProseUnits(enChapter.body)).toBe(6);
    expect(countWords(numeralsChapter.body)).toBe(400);
    const numeralsDetection = detectManuscriptLanguage(numeralsChapter.body);
    // fixture sanity: surrenders on its own, via letters === 0 — and its
    // guessed language is 'en', the SAME language the real chapter wins
    // with, which is exactly the coincidence this test is pinning.
    expect(numeralsDetection).toEqual({ language: 'en', supported: true, fallback: true });

    const result = detectManuscriptLanguageFromChapters([enChapter, numeralsChapter]);
    // Correct surrender: the real English chapter's own 6 prose units never
    // clear PROSE_UNIT_FLOOR (20) on their own.
    expect(result).toEqual({ language: 'en', supported: true, fallback: true });
  });
});

/* #2276 — the mandatory invariant: detection must not depend on how a book
   happens to be split into chapters. Re-chapters the SAME underlying text
   (an English front-matter passage + a large German body) six different
   ways — all-in-one, split in two, split in five, front matter as its own
   excluded chapter, front matter merged into chapter 1 (both with the body
   further split), and front matter split across several surviving chapters
   against a single body chapter — and asserts every shape agrees on both
   `language` and `fallback`. This is the test that would have caught all
   three #2276 symptoms above — see the last shape's own comment for why the
   first five alone are insufficient to lock mass-weighting itself. */
describe('detectManuscriptLanguageFromChapters — #2276 chapter-count invariance (property test)', () => {
  const EN_SENTENCE =
    'Marcel Beaumont and Geneviève Dubois walked along the Champs-Élysées toward the Café de Flore, where Henri Toussaint waited beneath the awning with the morning papers.';
  const DE_SENTENCE =
    'Der Ofen war bis zur Farbe eines aschbedeckten Sonnenuntergangs abgekühlt, und Wren kratzte die letzte Schlacke ab, als es an der Tür ihrer Werkstatt klopfte.';

  const FRONT_MATTER_TEXT = Array(2).fill(EN_SENTENCE).join(' '); // ~50 words — small, real front matter

  // #2276-followup — deliberately a SEPARATE, larger fixture from FRONT_MATTER_TEXT
  // above, used only by the discriminating shape below. FRONT_MATTER_TEXT can't
  // simply be enlarged in place: configs 1-3 merge it INTO the same chapter/sample
  // as the German body, and franc's own confidence margin over that mixed sample
  // flips from 'deu' to 'eng' once the English share climbs past ~10 sentences
  // (verified empirically by probing franc directly — the flip point sits between
  // 10 and 12 of these ~25-word sentences mixed into the body sample) — well below
  // the >=2x150-word split this shape needs to survive selectBodyChapters. This
  // fixture avoids that entirely by never mixing: each chapter below is either
  // pure English or pure German, so franc sees a clean, un-mixed sample every
  // time and only the MASS-vs-COUNT arithmetic in voteLanguage is under test.
  const noteSentences = Array(16).fill(EN_SENTENCE); // ~400 words, split 2 ways below (~200/chunk)

  function chunk(sentences: string[], n: number): string[] {
    const size = Math.ceil(sentences.length / n);
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const part = sentences.slice(i * size, (i + 1) * size).join(' ');
      if (part.length > 0) out.push(part);
    }
    return out;
  }

  /* Builds the same six re-chaptering shapes over any body — reused below for
     both the thick corpus-stand-in body and the thin below-PROSE_UNIT_FLOOR
     body, so the two fixtures run through IDENTICAL shape-construction logic
     rather than two hand-copies that could quietly drift apart. */
  function buildConfigs(
    bodySentences: string[],
  ): Array<{ label: string; chapters: Array<{ title: string; body: string }> }> {
    const wholeBody = bodySentences.join(' ');
    return [
      {
        label: 'all in one chapter, front matter merged in',
        chapters: [{ title: 'Chapter 1', body: `${FRONT_MATTER_TEXT} ${wholeBody}` }],
      },
      {
        label: 'split in two, front matter merged into chapter 1',
        chapters: chunk(bodySentences, 2).map((body, i) => ({
          title: `Chapter ${i + 1}`,
          body: i === 0 ? `${FRONT_MATTER_TEXT} ${body}` : body,
        })),
      },
      {
        label: 'split in five, front matter merged into chapter 1',
        chapters: chunk(bodySentences, 5).map((body, i) => ({
          title: `Chapter ${i + 1}`,
          body: i === 0 ? `${FRONT_MATTER_TEXT} ${body}` : body,
        })),
      },
      {
        label: 'front matter as its own excluded chapter, body in one chapter',
        chapters: [
          { title: 'Copyright', body: FRONT_MATTER_TEXT },
          { title: 'Chapter One', body: wholeBody },
        ],
      },
      {
        label: 'front matter as its own excluded chapter, body split in five',
        chapters: [
          { title: 'Copyright', body: FRONT_MATTER_TEXT },
          ...chunk(bodySentences, 5).map((body, i) => ({ title: `Chapter ${i + 1}`, body })),
        ],
      },
      {
        // The five shapes above all split the BODY, which can never flip a
        // count-vote: many German body chapters (or one) against zero-or-one
        // excluded/merged front-matter chapters always leaves German on top by
        // chapter count too, so counting and weighing by mass agree by
        // construction — this is why the five shapes above stay green even
        // under a `voteLanguage` mutated back to one-ballot-per-chapter
        // (`const mass = 1`, i.e. the pre-#2276 counting bug this whole
        // property test exists to lock out). The shape that actually
        // separates the two: split the FRONT MATTER (a
        // pure-English chapter of its own, never mixed with the body — see
        // `noteSentences` above) across several chapters, each retitled so it
        // survives selectBodyChapters ('A Note on the Translation' doesn't
        // match isLikelyFrontMatterTitle, and each ~200-word chunk clears
        // FRONT_MATTER_WORD_THRESHOLD), while the body stays a single chapter.
        label: 'front matter split into two surviving chapters, body in one chapter',
        chapters: [
          ...chunk(noteSentences, 2).map((body, i) => ({
            title: `A Note on the Translation, part ${i + 1}`,
            body,
          })),
          { title: 'Chapter One', body: wholeBody },
        ],
      },
    ];
  }

  const bodySentences = Array(200).fill(DE_SENTENCE); // ~5,000 words — a stand-in book body
  const configs = buildConfigs(bodySentences);

  it.each(configs)('resolves to the same language and fallback — $label', ({ chapters }) => {
    const result = detectManuscriptLanguageFromChapters(chapters);
    expect(result).toEqual({ language: 'de', supported: true, fallback: false });
  });

  it('every re-chaptering shape agrees with every other (not just with a fixed expectation)', () => {
    const results = configs.map((c) => detectManuscriptLanguageFromChapters(c.chapters));
    const [first, ...rest] = results;
    for (const r of rest) expect(r).toEqual(first);
  });

  /* #2276-followup — the property above is vacuous against mechanism (B), the
     prose-unit floor's KEYING (winning mass vs. `candidates.length === 1`):
     the thick body's ~5,000 words sit far above PROSE_UNIT_FLOOR in every
     partitioning, so the floor never fires and how it's keyed can't change
     the outcome. This second property case reruns the SAME six shapes (via
     buildConfigs) over a body sized, from the real PROSE_UNIT_FLOOR
     constant, to land just BELOW the floor — so the floor fires in every
     shape, and a thin book must surrender IDENTICALLY across all of them.
     Under mutation B, the single-candidate shapes still surrender (floor
     applies at candidates.length === 1) but a multi-candidate split shape
     bypasses the floor and backfills a confident wrong answer instead — the
     exact bug #2276 fixed, now caught by this fixture where it wasn't by
     the thick one. */
  describe('thin body below PROSE_UNIT_FLOOR', () => {
    // One long German "sentence" (three clauses joined, single terminal
    // period) so a handful of repeats stays under PROSE_UNIT_FLOOR by prose
    // UNIT count while still clearing FRONT_MATTER_WORD_THRESHOLD per chunk
    // once split five ways (the tightest shape below) — a body built from
    // plain ~25-word DE_SENTENCE repeats can't do both at once.
    const DE_CLAUSE = DE_SENTENCE.slice(0, -1); // drop the trailing '.'
    const deClauseLower = DE_CLAUSE.charAt(0).toLowerCase() + DE_CLAUSE.slice(1);
    const DE_LONG_SENTENCE = `${DE_CLAUSE}, während ${deClauseLower}, und während ${deClauseLower}.`; // one prose unit, ~78 words

    // Shapes 1-3 merge FRONT_MATTER_TEXT into the same chapter as the body,
    // so its own prose units land in the winning language's total too —
    // read the real count rather than assuming it, so this fixture keeps
    // working if FRONT_MATTER_TEXT above ever changes shape.
    const frontMatterUnits = countProseUnits(FRONT_MATTER_TEXT);

    // One sentence = one prose unit. 15 repeats divides evenly into the
    // five-way split below (3 sentences/chunk, ~234 words — well over
    // FRONT_MATTER_WORD_THRESHOLD), and stays under PROSE_UNIT_FLOOR even in
    // the shapes that fold `frontMatterUnits` on top (15 + 2 = 17 < 20).
    const thinRepeats = 15;
    const thinBodySentences = Array(thinRepeats).fill(DE_LONG_SENTENCE);
    const thinConfigs = buildConfigs(thinBodySentences);

    it('fixture sanity: every shape’s winning prose-unit count stays under PROSE_UNIT_FLOOR, even merged with the front matter’s own units', () => {
      expect(thinRepeats).toBeLessThan(PROSE_UNIT_FLOOR);
      expect(thinRepeats + frontMatterUnits).toBeLessThan(PROSE_UNIT_FLOOR);
    });

    it.each(thinConfigs)('surrenders identically — $label', ({ chapters }) => {
      const result = detectManuscriptLanguageFromChapters(chapters);
      expect(result).toEqual({ language: 'en', supported: true, fallback: true });
    });

    it('every re-chaptering shape agrees with every other (not just with a fixed expectation)', () => {
      const results = thinConfigs.map((c) => detectManuscriptLanguageFromChapters(c.chapters));
      const [first, ...rest] = results;
      for (const r of rest) expect(r).toEqual(first);
    });
  });
});

/* #2256 — PROSE_UNIT_FLOOR alone lets PUNCTUATED junk through: a long
   numbered TOC or a periods-and-page-numbers index racks up enough
   terminators to clear it purely by having many short, repetitive entries.
   See prose-units.ts's own header for the corpus this was measured against
   and the stated margins on both sides. */
describe('guiraudR / digitTokenShare (#2256 pure helpers)', () => {
  it('guiraudR is 0 for a token-less sample', () => {
    expect(guiraudR('12345 000 --- !!! ???')).toBe(0);
  });

  it('guiraudR rewards a wide vocabulary and punishes verbatim repetition, at the same unit count', () => {
    const repeated = Array(20).fill('Chapter One.').join(' '); // dedupes to 1 unit, 2 types / 2 tokens
    const distinctWords = [
      'apple', 'bridge', 'candle', 'desert', 'ember', 'forest', 'granite', 'harbor', 'island', 'jungle',
      'kettle', 'lantern', 'meadow', 'nebula', 'orchard', 'pepper', 'quarry', 'river', 'summit', 'tundra',
    ];
    const varied = distinctWords.map((w) => `${w} Word.`).join(' '); // 20 distinct units, no dedup collapse
    expect(guiraudR(varied)).toBeGreaterThan(guiraudR(repeated));
  });

  it('digitTokenShare ignores punctuation-only tokens and counts a token as "digit" when it is a pure digit run (the scanner splits digits from adjacent letters into separate tokens)', () => {
    expect(digitTokenShare('Chapter 12. See page 45, note 3.')).toBeGreaterThan(0);
    expect(digitTokenShare('Chapter Twelve. See the note.')).toBe(0);
  });

  it('digitTokenShare is 0 for an empty sample', () => {
    expect(digitTokenShare('')).toBe(0);
  });
});

describe('detectManuscriptLanguageFromChapters — #2256 punctuated-junk residual (PROSE_UNIT_FLOOR alone is not enough)', () => {
  // A numbered TOC — "N. Name." per entry, six cycling character names — is
  // the exact shape #2251's own review comment measured (1200 units at
  // scale). Sized here to comfortably clear PROSE_UNIT_FLOOR (80 units, 4x
  // the floor) so this fixture exercises the NEW gate, not the old one —
  // the un-punctuated version of this exact TOC (no periods at all, 0 prose
  // units) already has its own regression above ("symptom 2").
  function numberedToc(entries: number): string {
    const names = ['Kaz', 'Inej', 'Nina', 'Matthias', 'Wylan', 'Jesper'];
    const parts: string[] = [];
    for (let i = 1; i <= entries; i++) parts.push(`${i}. ${names[i % names.length]}.`);
    return parts.join(' ');
  }

  // Periods-and-page-numbers index — "Term, N." per entry, ten distinct head
  // terms — the second punctuated shape from the same review comment.
  function periodIndex(entries: number): string {
    const terms = ['Aardvark', 'Abacus', 'Abandon', 'Abbey', 'Abbot', 'Abdicate', 'Abduct', 'Abeyance', 'Abhor', 'Abide'];
    const parts: string[] = [];
    for (let i = 1; i <= entries; i++) parts.push(`${terms[i % terms.length]}, ${i * 3}.`);
    return parts.join(' ');
  }

  const repeatedHeadings = (entries: number) => Array(entries).fill('Chapter One.').join(' ');

  it('fixture sanity: all three junk shapes clear PROSE_UNIT_FLOOR on their own — the OLD gate alone would have backfilled every one of them', () => {
    expect(countProseUnits(numberedToc(40))).toBeGreaterThanOrEqual(PROSE_UNIT_FLOOR);
    expect(countProseUnits(periodIndex(50))).toBeGreaterThanOrEqual(PROSE_UNIT_FLOOR);
    expect(countProseUnits(repeatedHeadings(30))).toBeGreaterThanOrEqual(PROSE_UNIT_FLOOR);
    // And all three clear the NEW gate's own PROSE_UNIT_FLOOR-adjacent input by
    // enough margin that a passing test here is about the richness/digit
    // gates, not an accidental floor miss.
    expect(guiraudR(numberedToc(40))).toBeLessThan(LEXICAL_RICHNESS_FLOOR);
    expect(guiraudR(periodIndex(50))).toBeLessThan(LEXICAL_RICHNESS_FLOOR);
    expect(guiraudR(repeatedHeadings(30))).toBeLessThan(LEXICAL_RICHNESS_FLOOR);
  });

  it('a numbered TOC that franc mis-disambiguates with fallback:false (a repro of the "backfilled \'de\'" residual) still surrenders — never writes the wrong non-English language', () => {
    const toc = numberedToc(40); // 80 prose units — 4x PROSE_UNIT_FLOOR
    // Fixture sanity: franc is genuinely fooled here (fallback:false), so a
    // gate keyed on fallback alone — or on PROSE_UNIT_FLOOR alone — would
    // have backfilled this book with the WRONG non-English language.
    const soloDetection = detectManuscriptLanguage(toc);
    expect(soloDetection.fallback).toBe(false);
    expect(soloDetection.language).not.toBe('en');

    const r = detectManuscriptLanguageFromChapters([{ title: 'Chapter One', body: toc }]);
    expect(r).toEqual({ language: 'en', supported: true, fallback: true });
  });

  it('a periods-and-page-numbers index (50 entries, digit-dense) surrenders via the digit-token-share ceiling', () => {
    const idx = periodIndex(50);
    expect(digitTokenShare(idx)).toBeGreaterThan(DIGIT_TOKEN_SHARE_CEILING);

    const r = detectManuscriptLanguageFromChapters([{ title: 'Chapter One', body: idx }]);
    expect(r).toEqual({ language: 'en', supported: true, fallback: true });
  });

  it('repeated "Chapter One." headings (no digits at all) still surrenders via lexical richness alone', () => {
    const headings = repeatedHeadings(30);
    expect(digitTokenShare(headings)).toBe(0); // proves this shape needs the RICHNESS gate, not the digit one
    expect(guiraudR(headings)).toBeLessThan(LEXICAL_RICHNESS_FLOOR);

    const r = detectManuscriptLanguageFromChapters([{ title: 'Chapter One', body: headings }]);
    expect(r).toEqual({ language: 'en', supported: true, fallback: true });
  });

  it('the SAME numbered-TOC junk surrenders identically whether it is 1 chapter or split across many (chapter-count invariance, #2276\'s own guarantee extended to the new gate)', () => {
    const toc = numberedToc(40);
    const words = toc.split(' ');
    const third = Math.ceil(words.length / 3);
    const asOneChapter = [{ title: 'Chapter One', body: toc }];
    const asThreeChapters = [
      { title: 'Chapter One', body: words.slice(0, third).join(' ') },
      { title: 'Chapter Two', body: words.slice(third, third * 2).join(' ') },
      { title: 'Chapter Three', body: words.slice(third * 2).join(' ') },
    ];
    const oneResult = detectManuscriptLanguageFromChapters(asOneChapter);
    const threeResult = detectManuscriptLanguageFromChapters(asThreeChapters);
    expect(oneResult.fallback).toBe(true);
    expect(threeResult).toEqual(oneResult);
  });

  /* #2256 independent review round 2, finding 5 — the test this replaces
     was `Array(25).fill(oneSentence)`, which dedupeProseUnits collapses to
     ONE sentence: it pinned a constant (does this one sentence's own R clear
     a fixed floor?), not a metric SHAPE, so it could not go red for a
     length-dependence, tokenization, or script-asymmetry regression — see
     this file's own describe block below for the mutation proof. Replaced
     with a lock parameterised across scripts (en, zh, ja, an all-kana ja
     variant) AND across two genuinely different sample lengths (not one
     sentence repeated) built from hand-authored, non-repeating real-shaped
     sentences — dedup cannot collapse these to a single unit, so the
     richness/digit gates actually see the SHAPE (script, length) they're
     meant to guard, not a frozen number. */
});

/* #2256 independent review round 2 — regression locks for findings 1-5.
   Each fixture below is hand-authored, non-repeating prose (dedup cannot
   collapse it to fewer units the way `Array(N).fill(oneSentence)` can), so
   these tests exercise the actual SHAPE each finding is about rather than a
   frozen constant — every one is mutation-verified (see the PR/commit
   history for the exact reverted line and the resulting real failure
   message for each). */
describe('detectManuscriptLanguageFromChapters — #2256 review round 2 regression locks', () => {
  // 30 distinct sentences per script — real-shaped narrative prose, no two
  // sentences alike, so dedupeProseUnits cannot reduce this to a handful of
  // units regardless of how many are used. "short" below takes the first 22
  // (just above PROSE_UNIT_FLOOR=20); "long" takes all 30 — two genuinely
  // different lengths of genuinely varied content, not a repeat count.
  const EN_POOL = [
    'Marcel watched the harbor lights flicker as the last fishing boats came in against the tide.',
    'Wren scraped the final ribbon of slag from the crucible and set the tongs down to cool.',
    'Inej counted the rooftops between the belfry and the river before choosing her route down.',
    'Henri folded the letter twice, unwilling to read the closing line again until he had steadied his hands.',
    'Rosalind pressed her palm against the cold glass and watched the rain streak sideways across the square.',
    'Otto measured the beam twice before he trusted the chalk line enough to cut.',
    'Ilya remembered the smell of the foundry long after he had left the trade behind.',
    'Beatrix traced the old survey marks on the map until the ink gave out near the ridge.',
    'Andrzej rebuilt the fence post by post, arguing with himself about the angle each time.',
    'Suki listened to the kettle climb toward a boil and did not move to take it off.',
    'Tobias abandoned the draft halfway through the third page and started again from a different year.',
    'Naledi carried the lantern low so the wind along the causeway would not find the flame.',
    'Wilhelm questioned the surveyor about the boundary stone and got no answer worth repeating.',
    'Ingrid trusted the old ferryman more than she trusted the printed schedule nailed to the post.',
    'Casimir doubted the weather would hold, but he loaded the cart before dawn regardless.',
    'The orchard smelled of windfall apples fermenting quietly in grass no one had cut that autumn.',
    'A gull wheeled over the harbor while the fishing boats dragged sideways against their moorings.',
    'The clocktower struck eleven as the last tram rattled past with fogged, empty windows.',
    'Rain needled the tin roof all night, and by morning the lane had become a shallow river.',
    'He counted the coins twice, set them in two unequal piles, and pushed the smaller one across.',
    'The archive smelled of dust and river damp, and nobody had signed the ledger in a decade.',
    'A stranger paused at the workshop door, read the sign twice, and walked on without knocking.',
    'The quarry had been abandoned so long that saplings grew crooked out of the spoil heaps.',
    'She kept the compass in her coat pocket though it had not pointed true since the crossing.',
    'The stairwell creaked under weight it had not carried since the old tenants moved out.',
    'A single ember held in the grate long after the rest of the fire had gone to ash.',
    'The signal lamp on the point blinked twice, paused, and blinked twice again through the fog.',
    'Someone had left the courtyard gate open, and the geese had wandered halfway to the well.',
    'The current pulled harder near the old pilings than the ferryman ever let on to passengers.',
    'A vessel with no name painted on its bow sat low in the water past the breakwater.',
  ];
  const ZH_POOL = [
    '马塞尔望着港口的灯火在最后几艘渔船归来时轻轻闪烁。',
    '雷恩刮下坩埚里最后一丝炉渣然后放下钳子让它冷却。',
    '伊内伊数着钟楼与河流之间的屋顶才选定下去的路线。',
    '亨利把信折了两次直到用茶稳住双手才敢再读最后一行。',
    '罗莎琳把手掌贴在冰冷的玻璃上看雨水斜斜地划过广场。',
    '奥托把横梁量了两遍才敢相信粉线足够准确去下刀。',
    '伊利亚离开这行很久之后仍然记得铸造厂的气味。',
    '比阿特丽克斯沿着旧测量标记描摹地图直到墨迹在山脊附近用尽。',
    '安杰伊一根一根地重建篱笆每次都在角度上和自己争论。',
    '纪子听着水壶渐渐煮沸却没有伸手把它端离炉火。',
    '托拜厄斯写到第三页中途放弃又换了一个年份重新开始。',
    '娜莱迪把灯笼提得很低好让堤道上的风找不到火苗。',
    '威廉向测量员追问界石的事却没得到一个像样的答案。',
    '英格丽比起钉在柱子上的时刻表更信任那位老船夫。',
    '卡西米尔怀疑天气撑不了多久但天不亮就把车装好了。',
    '果园里弥漫着无人收割的落果在草丛中悄悄发酵的气味。',
    '海鸥在港口上空盘旋而渔船正被潮水拖向一边的系缆桩。',
    '钟楼敲响了十一点最后一班电车摇晃着驶过雾蒙蒙的车窗。',
    '雨水整夜敲打着铁皮屋顶到了早晨小巷已成一条浅浅的河。',
    '他把硬币数了两遍分成两堆大小不等把较小的那堆推了过去。',
    '档案室里满是灰尘与河潮的气味账本已经十年没人签过字。',
    '一个陌生人在作坊门口停下把招牌读了两遍便转身离开。',
    '采石场荒废太久幼树已从废石堆里歪歪扭扭地长了出来。',
    '她把罗盘揣在大衣口袋里尽管自那次渡河后它就没再指对过方向。',
    '楼梯间的木板发出吱呀声承受着旧租户搬走后久未有过的重量。',
    '炉膛里一块余烬在其余炭火燃尽很久之后依然亮着。',
    '海角上的信号灯闪了两下停顿一下又在雾中闪了两下。',
    '有人把庭院的大门开着鹅群已经摇摇摆摆走到了井边。',
    '老桩附近的水流比船夫愿意告诉乘客的要湍急得多。',
    '一艘船首没有写名字的船在防波堤外吃水很深地停着。',
  ];
  const JA_POOL = [
    'マルセルは最後の漁船が戻る頃港の灯りが揺れるのを見つめていた。',
    'レンはるつぼの最後の滓を削り取り火箸を置いて冷ますに任せた。',
    'イネジは鐘楼と川の間の屋根を数えてから下りる道を選んだ。',
    'アンリは手紙を二度折りたたみ茶で手を落ち着けるまで最後の一行を読まなかった。',
    'ロザリンドは冷たい窓ガラスに手のひらを当てて雨が広場を斜めに走るのを見た。',
    'オットーは梁を二度測ってからようやく墨線を信じて切り始めた。',
    'イリヤはその仕事を離れて久しくなっても鋳造所の匂いを覚えていた。',
    'ベアトリクスは古い測量印を地図でたどり尾根近くでインクが尽きるまで続けた。',
    'アンジェイは杭を一本ずつ立て直しながら毎回角度について自分と言い争った。',
    '紀子は薬缶が沸くのを聞きながら火から下ろそうとはしなかった。',
    'トビアスは三ページ目の途中で下書きを諦め別の年から書き直した。',
    'ナレディは堤道の風に炎を見つけられぬよう灯りを低く掲げた。',
    'ヴィルヘルムは測量士に境界石のことを尋ねたが答えらしい答えは得られなかった。',
    'イングリッドは柱に打ち付けられた時刻表よりも老いた渡し守を信じていた。',
    'カジミールは天気が持たないと疑いながらも夜明け前に荷車へ積み込んだ。',
    '果樹園には誰も刈らなかった落ち果実が静かに発酵する匂いが漂っていた。',
    'かもめが港の上を旋回し漁船は潮に流されて係留杭に斜めに引かれていた。',
    '鐘楼が十一時を打ち最後の路面電車が霧に曇った窓のまま走り去った。',
    '雨は一晩中トタン屋根を叩き朝には小道が浅い川になっていた。',
    '彼は硬貨を二度数え大小二つの山に分けて小さい方を押しやった。',
    '記録室には埃と川の湿気が満ち帳簿には十年も署名がなかった。',
    '見知らぬ男が工房の戸口で立ち止まり看板を二度読んでから立ち去った。',
    '採石場は久しく放棄され捨て石の山から若木が曲がりながら伸びていた。',
    '彼女は渡航以来一度も正しく指したことのない羅針盤を上着の中に入れていた。',
    '階段室は旧住人が去って以来受けたことのない重みにきしんだ。',
    'かまどの残り火は他の炭がすべて灰になった後も長く燃えていた。',
    '岬の信号灯は二度瞬き一拍おいて霧の中でまた二度瞬いた。',
    '誰かが中庭の門を開けたままにし鵞鳥はよろよろと井戸のそばまで歩いていた。',
    '古い杭の近くの流れは渡し守が乗客に語る以上に速かった。',
    '舳先に名のない船が防波堤の外で深く沈み込んで停まっていた。',
  ];
  // All-hiragana, no kanji at all — the degenerate shape finding 3 reported
  // (a children's book, or any furigana-only text). 30 distinct sentences,
  // real hiragana words/particles.
  const KANA_POOL = [
    'あさひがまどからさしこんでねこはまだねむっていた。',
    'かぜがそよそよとふいてきてことりがちいさくないた。',
    'おんなのこはにわにでてはなをながめそらをみあげた。',
    'そらはあおくてくもひとつなかったあさだった。',
    'おとうさんがげんかんでくつをはいているところだった。',
    'おかあさんはだいどころでおちゃをいれているところだった。',
    'いえのなかはとてもしずかであたたかかったゆうがた。',
    'ゆうがたになるととりたちがうたいはじめていた。',
    'ちいさなかわがさらさらとおとをたててながれていた。',
    'みちのわきにたんぽぽがいくつもさいていた。',
    'かぜにゆれるはなをみておんなのこはわらった。',
    'よるになるとほしがきらきらとひかりはじめた。',
    'あさになるとみんながゆっくりとおきてきた。',
    'いぬがにわのすみでくるりとまるくなってねむった。',
    'おばあちゃんがえんがわでせんすをつかっていた。',
    'こどもたちはひろばでたこをあげてあそんでいた。',
    'せんせいがこくばんにおおきなえをかいてみせた。',
    'あめがふるとかえるがげんきにうたいだした。',
    'ゆきがふるとまちじゅうがまっしろになった。',
    'なつになるとせみがいっせいになきはじめた。',
    'ふゆのあさはいきがしろくみえるほどさむかった。',
    'はるになるとさくらのはながひらひらとまいおちた。',
    'あきになるといちょうのはがきいろにそまった。',
    'とりがすにかえってくるまでははをひろげてまっていた。',
    'つきがたかくのぼるころみんなはねむりについた。',
    'かわのむこうでこどもがてをふっているのがみえた。',
    'もりのなかでふくろうがしずかにめをひらいていた。',
    'はたけでおじいさんがくわをふるっていた。',
    'えきまえのひろばでがっしょうだんがうたっていた。',
    'ちいさなふねがみずうみをゆっくりとすすんでいった。',
  ];

  /* Han numerals for the numbered-TOC / dated-chronicle fixtures below.
     ONE copy (#2256 review round 4, nit N7 — this was pasted into three
     separate tests, and a fourth pair of near-identical `chronicleChapter`
     helpers disagreed on their own EVENTS array). Covers 1-99, which is all
     any fixture here needs. */
  function toHanNumeral(n: number): string {
    const digits = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    if (n < 10) return digits[n];
    if (n < 20) return '十' + (n % 10 === 0 ? '' : digits[n % 10]);
    const tens = Math.floor(n / 10),
      ones = n % 10;
    return digits[tens] + '十' + (ones === 0 ? '' : digits[ones]);
  }

  const cases = [
    { label: 'en', join: ' ', pool: EN_POOL, expectLanguage: 'en' },
    { label: 'zh', join: '', pool: ZH_POOL, expectLanguage: 'zh' },
    { label: 'ja (mixed kanji+kana)', join: '', pool: JA_POOL, expectLanguage: 'ja' },
    { label: 'ja (all-kana, no kanji)', join: '', pool: KANA_POOL, expectLanguage: 'ja' },
  ];
  /* #2256 review round 3, finding N5 (nit) — "short"/"long" here (22 vs 30,
     the full authored pools) is a general real-content regression net, NOT
     a length-decay test: finding 3(a)'s windowing mechanism (the reason a
     bigger length gap would have mattered) was retracted in round 3 (see
     finding C1 above), so there is no longer a length-dependent code path
     for this property lock to exercise. The margins here (R comfortably
     above the floor, digit share comfortably below the ceiling) are
     intentionally loose — this locks "real content passes with real room
     to spare", not "real content sits at the edge"; the edge cases live in
     the dedicated finding-1/2/4/C2 tests above, which use short, digit- or
     ceiling-adjacent content on purpose. */
  const lengths = [
    { label: 'short (22, just above PROSE_UNIT_FLOOR)', count: 22 },
    { label: 'long (all 30)', count: 30 },
  ];

  describe.each(cases)('$label', ({ join, pool, expectLanguage }) => {
    it.each(lengths)('clears the richness/digit gates and resolves confidently — $label', ({ count }) => {
      const sample = pool.slice(0, count).join(join);
      expect(guiraudR(sample)).toBeGreaterThanOrEqual(LEXICAL_RICHNESS_FLOOR);
      expect(digitTokenShare(sample)).toBeLessThanOrEqual(DIGIT_TOKEN_SHARE_CEILING);

      const r = detectManuscriptLanguageFromChapters([{ title: 'Chapter One', body: sample }]);
      expect(r.language).toBe(expectLanguage);
      expect(r.fallback).toBe(false);
    });
  });

  /* Finding 1 — digitTokenShare used to split on WHITESPACE, so an
     identical single injected digit (e.g. a dated year in one sentence of
     several) scored far higher for whitespace-less CJK than for equivalent
     English, because the whole CJK sentence containing it counted as ONE
     token instead of the ~10-20 word-equivalent tokens the same content
     produces in English. Repro: a "dated novel" shape — 1 sentence in 4 (of
     21 total, well above PROSE_UNIT_FLOOR) carries an injected year — dense
     enough that the OLD whitespace-based tokenizer's per-sentence digit
     share (6/21 ≈ 0.286) would exceed even the recalibrated
     DIGIT_TOKEN_SHARE_CEILING (0.2), while the new script-aware tokenizer's
     share stays well under it. Neither script should be pushed into
     surrendering by an isolated digit. */
  it('finding 1 — an isolated injected digit does not disproportionately punish CJK vs EN (dated-novel repro)', () => {
    const injectEvery = 4;
    const enSample = EN_POOL.slice(0, 21)
      .map((s, i) => (i % injectEvery === 0 ? s.replace('watched', 'watched, in 1985,') : s))
      .join(' ');
    const zhSample = ZH_POOL.slice(0, 21)
      .map((s, i) => (i % injectEvery === 0 ? '1985年，' + s : s))
      .join('');

    const enResult = detectManuscriptLanguageFromChapters([{ title: 'Chapter One', body: enSample }]);
    const zhResult = detectManuscriptLanguageFromChapters([{ title: '第一章', body: zhSample }]);
    expect(enResult).toEqual({ language: 'en', supported: true, fallback: false });
    expect(zhResult.language).toBe('zh');
    expect(zhResult.fallback).toBe(false);
  });

  /* Finding 2 — `/\d/` matches neither fullwidth digits (U+FF10-FF19) nor
     Han numeral characters (一二三...百千万), so a Han-numeral or
     fullwidth-digit numbered Chinese TOC scored digitTokenShare=0 and could
     backfill 'zh' with fallback:false — the exact "never write a language
     it only guessed" failure #2246 exists to prevent, now for CJK
     numbering specifically. 60 entries, real Chinese TOC punctuation
     ("N、Title。"), distinct two-character titles (comfortably above
     LEXICAL_RICHNESS_FLOOR on richness alone — this must be the DIGIT gate
     catching it, not the richness one). */
  it('finding 2 — a Han-numeral OR fullwidth-digit numbered Chinese TOC surrenders, never backfills zh', () => {
    const titles = [
      '卷首语','引子','初遇','离别','归途','夜话','旧梦','新生','远行','告白',
      '暗涌','浮光','孤舟','长夜','清晨','余音','迷雾','归鸿','惊蛰','立秋',
      '寒露','霜降','小雪','大雪','冬至','小寒','大寒','立春','雨水','惊雷',
      '春分','清明','谷雨','立夏','小满','芒种','夏至','小暑','大暑','处暑',
      '白露','秋分','寒露二','霜降二','立冬','小雪二','大雪二','冬至二','小寒二','大寒二',
      '尾声','后记','附录','番外','终章','别篇','外传','余话','跋','附言',
    ];
    const fullwidth = (n: number) =>
      String(n)
        .split('')
        .map((d) => String.fromCharCode(0xff10 + Number(d)))
        .join('');
    const hanToc = titles.map((t, i) => `${toHanNumeral(i + 1)}、${t}。`).join('');
    const fullwidthToc = titles.map((t, i) => `${fullwidth(i + 1)}、${t}。`).join('');

    // Fixture sanity: richness alone clears the floor (60 distinct 2-char
    // titles) — this test is about the DIGIT gate, confirmed below.
    expect(guiraudR(hanToc)).toBeGreaterThan(LEXICAL_RICHNESS_FLOOR);
    expect(digitTokenShare(hanToc)).toBeGreaterThan(DIGIT_TOKEN_SHARE_CEILING);
    expect(digitTokenShare(fullwidthToc)).toBeGreaterThan(DIGIT_TOKEN_SHARE_CEILING);

    const hanResult = detectManuscriptLanguageFromChapters([{ title: 'Chapter One', body: hanToc }]);
    const fullwidthResult = detectManuscriptLanguageFromChapters([{ title: 'Chapter One', body: fullwidthToc }]);
    expect(hanResult).toEqual({ language: 'en', supported: true, fallback: true });
    expect(fullwidthResult).toEqual({ language: 'en', supported: true, fallback: true });
  });

  /* #2256 independent review round 3, finding C2 (HIGH, NOT CLOSED — see
     prose-units.ts's own header and
     https://github.com/dudarenok-maker/Castwright/issues/2341 for the
     owner decision owed). The finding-2 test above uses "N、<title>。"
     numbering; the standard real Chinese TOC/chapter-heading layout is
     "第N章<title>" ("Chapter N: Title") — "第"/"章" tokenize as ordinary
     (non-numeral) Han word tokens, diluting digitTokenShare below
     DIGIT_TOKEN_SHARE_CEILING regardless of entry count. This test PINS
     the current, imperfect behavior (it backfills) rather than asserting
     the desired-but-unimplemented behavior, so the gap stays visible in
     the test suite instead of silently reading as "closed" — flip the
     expectation once #2341 lands a fix, don't delete this test. */
  it('finding C2 (KNOWN, TRACKED GAP — issue #2341) — a "第N章<title>" numbered Chinese TOC still backfills zh, not caught by either gate', () => {
    const titles2 = [
      '卷首语', '引子', '初遇', '离别', '归途', '夜话', '旧梦', '新生', '远行', '告白',
      '暗涌', '浮光', '孤舟', '长夜', '清晨', '余音', '迷雾', '归鸿', '惊蛰', '立秋',
      '寒露', '霜降', '小雪', '大雪', '冬至', '小寒', '大寒', '立春', '雨水', '惊雷',
      '春分', '清明', '谷雨', '立夏', '小满', '芒种', '夏至', '小暑', '大暑', '处暑',
      '白露', '秋分', '寒露二', '霜降二', '立冬', '小雪二', '大雪二', '冬至二', '小寒二', '大寒二',
      '尾声', '后记', '附录', '番外', '终章', '别篇', '外传', '余话', '跋', '附言',
    ];
    // 60 distinct titles, MOSTLY 4 characters (pairing adjacent 2-char
    // titles: 43 are 4 chars, 14 are 5, 2 are 3, 1 is 6 — #2256 review
    // round 4, nit N3: this used to claim a uniform 4-character length,
    // which the mechanism argument in prose-units.ts was then stated
    // against). Roughly the standard Chinese chapter-title length; the
    // finding-2 fixture's 2-char titles alone do NOT reproduce this gap
    // (their digit share stays above the ceiling even with "第...章"
    // markers).
    const titles4 = titles2.map((t, i) => t + titles2[(i + 7) % titles2.length]);
    const toc = titles4.map((t, i) => `第${toHanNumeral(i + 1)}章${t}。`).join('');

    // Fixture sanity: neither gate fires. Richness is unremarkable (the
    // titles are all distinct, so R clears the floor easily) and the digit
    // share lands at ~0.17 — under the 0.2 ceiling, and well under the
    // 0.36+ range finding 4 called "evidenced junk". THAT is the gap: this
    // shape reads as junk to a human and as prose to both gates.
    expect(digitTokenShare(toc)).toBeLessThanOrEqual(DIGIT_TOKEN_SHARE_CEILING);
    expect(guiraudR(toc)).toBeGreaterThan(LEXICAL_RICHNESS_FLOOR);

    const result = detectManuscriptLanguageFromChapters([{ title: 'Chapter One', body: toc }]);
    // KNOWN GAP, tracked by #2341 -- this is the CURRENT (imperfect)
    // behavior, not the desired one. It backfills instead of surrendering.
    expect(result).toEqual({ language: 'zh', supported: true, fallback: false });
  });

  /* #2256 independent review round 3, finding C1 — round 2's
     RICHNESS_SAMPLE_CHARS prefix cap made the lexical gates see only the
     FIRST ~20,000 characters of the joined winning sample, which is
     chapter-ORDER-dependent: a single numeral-dense opening chapter (a
     dated chronicle, an epistolary frame, a real front-matter-surviving
     大事记/Zeittafel) could refuse a whole book that reads fine once every
     chapter is counted, and the SAME chapter set in a DIFFERENT order could
     reach a DIFFERENT verdict. Retracted — see prose-units.ts's own
     finding-3(a) retraction. The test below is the real-content-scale
     regression lock for that: the numeral-dense chapter must not poison the
     book in EITHER position. The SEPARATE, deeper order dependence round 3
     missed (dedup glue at the join seam) is locked by the "finding B1" test
     that follows it. */
  it('finding C1 (real-content scale) — a legitimate numeral-dense chapter (a dated chronicle) does not poison the whole book, in either chapter order', () => {
    // A "大事记"-shaped chronicle chapter: real Han-numeral dates, high
    // digit density (~0.43 alone, well over DIGIT_TOKEN_SHARE_CEILING) --
    // exactly the shape finding C1 named. 25 entries clears
    // FRONT_MATTER_WORD_THRESHOLD on its own.
    const EVENTS = ['筑', '修', '通', '建', '毁', '成', '迁', '并', '立', '废'];
    const chronicle = Array.from(
      { length: 25 },
      (_, k) =>
        `${toHanNumeral(1 + ((k + 1) % 99))}年${toHanNumeral(1 + ((k + 1) % 12))}月${toHanNumeral(1 + ((k + 1) % 28))}日，${EVENTS[(k + 1) % EVENTS.length]}。`,
    ).join('');
    expect(digitTokenShare(chronicle)).toBeGreaterThan(DIGIT_TOKEN_SHARE_CEILING); // fixture sanity: genuinely digit-dense alone
    const narrative1 = ZH_POOL.slice(0, 15).join('');
    const narrative2 = ZH_POOL.slice(15, 30).join('');

    const chronicleFirst = detectManuscriptLanguageFromChapters([
      { title: 'Chapter One', body: chronicle },
      { title: 'Chapter Two', body: narrative1 },
      { title: 'Chapter Three', body: narrative2 },
    ]);
    const chronicleLast = detectManuscriptLanguageFromChapters([
      { title: 'Chapter One', body: narrative1 },
      { title: 'Chapter Two', body: narrative2 },
      { title: 'Chapter Three', body: chronicle },
    ]);
    expect(chronicleFirst).toEqual({ language: 'zh', supported: true, fallback: false });
    expect(chronicleLast).toEqual(chronicleFirst);
  });

  /* #2256 independent review round 4, finding B1 (HIGH) — round 3 removed
     the RICHNESS_SAMPLE_CHARS prefix (finding C1 above) and asserted, in a
     comment, a release note AND a test, that the resulting
     `winningSamples.join('\n')` was "mathematically ORDER-INVARIANT". It
     was not. Neither gate tokenizes the join directly: both go through
     dedupeProseUnits, which segments on SENTENCE_TERMINAL_RE, and '\n' is
     not a terminator — so a chapter whose prepared sample does not END at a
     terminal mark GLUES its trailing residue onto the next chapter's first
     unit, changing that unit's dedup key and therefore which units collapse.
     The verdict then depends on chapter order, which is the exact defect
     finding C1 was filed for.

     The round-3 test that replaced the windowing lock could not see this:
     both its chapters ended in '。' and shared no units, so the glue never
     fired, and its ONLY assertion was that two results are equal — which two
     surrenders satisfy just as well as two correct answers (and it WAS two
     surrenders). This replaces it on both counts: the fixture triggers the
     glue (asserted below, not assumed) and the assertion names an ACCEPTED
     verdict, not just agreement.

     Fixture: a chronicle chapter that ends mid-entry (no terminator — the
     shape prepareSample also produces whenever it cuts a chapter at
     SAMPLE_CHARS, and that a chapter closing on `…。”` produces in
     miniature) whose trailing entry is repeated as the opening SENTENCE of
     the narrative chapter. Chronicle-first, the residue glues onto that
     opening sentence, so the entry's digit-dense tokens are counted TWICE
     and digitTokenShare crosses DIGIT_TOKEN_SHARE_CEILING (0.2059);
     narrative-first, the residue dedupes against the same sentence and the
     share stays under it (0.1915). Both chapters are real zh prose, and the
     correct answer in either order is zh. */
  it('finding B1 (mutation-sensitive) — a chapter whose sample does not end at a sentence terminal cannot change the verdict by its position', () => {
    const CHRONICLE = [
      '一八九三年七月十四日筑港。',
      '一八九四年三月二十日修桥。',
      '一八九五年十一月五日通渠。',
      '一八九六年九月八日建仓。',
      '一八九七年五月十七日毁堤。',
    ];
    // The seam: the chronicle's last entry, left UNTERMINATED at the end of
    // its chapter and repeated as the narrative chapter's opening sentence.
    const SEAM = '一八九九年六月十二日迁窑';
    const NARRATIVE = [
      '海鸥在码头上空盘旋。',
      '雨点敲打着铁皮屋顶。',
      '雷恩刮掉了最后的炉渣。',
      '她再次折起了那封信。',
      '电车摇晃着驶过广场。',
    ];
    // Repeated to clear FRONT_MATTER_WORD_THRESHOLD (150 words) per chapter;
    // dedup collapses the repeats, which is why the deduped token total
    // stays small enough for one extra copy of SEAM to matter.
    const chronicleBody = CHRONICLE.join('').repeat(6) + SEAM;
    const narrativeBody = SEAM + '。' + NARRATIVE.join('').repeat(6);

    /* Fixture sanity — these are the assertions that keep this test from
       quietly becoming a no-op the way its predecessor did. (1) The
       chronicle's prepared sample really does end mid-unit, so the glue
       path is live; (2) the seam unit really is shared by both chapters, so
       dedup has something to collapse; and (3) a BARE '\n' join really does
       give the two orders different digit shares, straddling the ceiling —
       i.e. the mechanism under test is present in this fixture, not merely
       hoped for. If a future edit terminates the chronicle or breaks the
       seam, (1)-(3) fail loudly rather than leaving a green test that
       proves nothing. */
    const preparedChronicle = prepareSample(chronicleBody, {});
    const preparedNarrative = prepareSample(narrativeBody, {});
    expect(/[.!?…。！？]$/u.test(preparedChronicle)).toBe(false);
    expect(preparedNarrative.startsWith(SEAM + '。')).toBe(true);
    const bareChronicleFirst = digitTokenShare([preparedChronicle, preparedNarrative].join('\n'));
    const bareNarrativeFirst = digitTokenShare([preparedNarrative, preparedChronicle].join('\n'));
    expect(bareChronicleFirst).toBeGreaterThan(DIGIT_TOKEN_SHARE_CEILING);
    expect(bareNarrativeFirst).toBeLessThanOrEqual(DIGIT_TOKEN_SHARE_CEILING);

    /* The property under test, through the real entry point FIRST: both
       orders must reach the SAME, ACCEPTED verdict. Two surrenders would
       satisfy an equality-only assertion, which is exactly how the round-3
       version of this test stayed green while the defect was live — so the
       expectation names the verdict rather than comparing the two results
       to each other. */
    const chronicleFirst = detectManuscriptLanguageFromChapters([
      { title: 'Chapter One', body: chronicleBody },
      { title: 'Chapter Two', body: narrativeBody },
    ]);
    const chronicleLast = detectManuscriptLanguageFromChapters([
      { title: 'Chapter One', body: narrativeBody },
      { title: 'Chapter Two', body: chronicleBody },
    ]);
    expect(chronicleFirst).toEqual({ language: 'zh', supported: true, fallback: false });
    expect(chronicleLast).toEqual({ language: 'zh', supported: true, fallback: false });

    // Same property one level down, so a regression says WHY: the sample
    // joinSamplesForGates builds is the same token population either way,
    // so both gates read identically off it.
    expect(digitTokenShare(joinSamplesForGates([preparedChronicle, preparedNarrative]))).toBe(
      digitTokenShare(joinSamplesForGates([preparedNarrative, preparedChronicle])),
    );
    expect(guiraudR(joinSamplesForGates([preparedChronicle, preparedNarrative]))).toBe(
      guiraudR(joinSamplesForGates([preparedNarrative, preparedChronicle])),
    );
  });

  /* #2256 review round 2, finding 3(b) — Hiragana/Katakana are a ~90-glyph
     syllabary; per-CHARACTER tokenisation caps a kana-only sample's whole
     vocabulary at that inventory, so Guiraud's R falls below any fixed
     floor once N passes roughly (floor/90)^2 characters — a few hundred to
     low thousands, well inside a single real chapter. Fixed by kana
     trigrams (see prose-units.ts).

     #2256 review round 3, finding C5 — this test's fixture used to claim
     (falsely) to reuse KANA_POOL above; it actually used a SEPARATE
     word-level list, and its 6-slot same-modulus index decomposition
     pinned 4 of 6 word slots constant for every i < 900 (words.length^2),
     making ~67% of the 36,610-char sample the single repeated word
     あさひが — the fixture was accidentally testing "does trigram
     tokenization survive heavy repetition" (yes, uninterestingly, since
     dedup already handles verbatim runs) rather than "does trigram
     tokenization sustain genuine variety at length" (the actual finding).
     Fixed: 3 word-slots (30^3 = 27,000 comfortably exceeds any n used
     here, so decomposition stays genuinely bijective — see prose-units.ts
     for why 6 slots over a 30-word pool couldn't). Round 4 (finding B4)
     then restored the LENGTH the fix had traded away — see the comment on
     the fixture itself. */
  it('finding 3(b) (fixed fixture) — a long all-kana (no kanji) chapter with genuinely varied content still resolves to ja', () => {
    const words = [
      'あさひが', 'まどから', 'さしこんで', 'いた', 'ねこは', 'まだ', 'ねむって', 'かぜが', 'そよそよと', 'ふいて',
      'きた', 'ことりが', 'ちいさく', 'ないた', 'おんなのこは', 'にわに', 'でて', 'はなを', 'ながめた', 'そらは',
      'あおくて', 'くもひとつ', 'なかった', 'おとうさんが', 'げんかんで', 'くつを', 'はいて', 'いる', 'おかあさんは', 'だいどころで',
    ];
    function makeSentence(i: number): string {
      let idx = i;
      const picked: string[] = [];
      for (let j = 0; j < 3; j++) {
        picked.push(words[idx % words.length]);
        idx = Math.floor(idx / words.length);
      }
      return picked.join('') + '。';
    }
    /* #2256 review round 4, finding B4 — round 3 shortened this fixture
       from 1,500 units to 500 while fixing its index decomposition, and in
       doing so DELETED the regression lock the test exists to be. Measured
       by re-running this fixture's own tokenization with KANA_NGRAM_SIZE
       varied, R at 500 units (6,127 chars) is 0.560 / 3.715 / 9.615 for
       n = 1 / 2 / 3 — so at that size BIGRAMS clear LEXICAL_RICHNESS_FLOOR
       too, and changing prose-units.ts's `KANA_NGRAM_SIZE` from 3 to 2 left
       the whole file green. R = V/sqrt(N) decays as N grows once a
       tokenization's vocabulary saturates, and bigrams saturate far sooner
       than trigrams, so the separation only appears at length: at 1,500
       units (18,610 chars, still under prepareSample's 20,000-char cut so
       the number below IS the number the gate sees) the same fixture
       measures 0.321 / 2.553 / 7.871. n=2 is now genuinely under the floor
       and n=3 genuinely over it, which is what makes reverting the trigram
       fix a RED test rather than a silent no-op. */
    const units = Array.from({ length: 1500 }, (_, i) => makeSentence(i));
    // Fixture sanity: 30^3 = 27,000 combinations, so a 3-slot mixed-radix
    // decomposition of i is injective over this range -- asserted, not
    // argued, because an aliasing period in exactly this kind of index is
    // what made two earlier versions of this fixture measure nothing (see
    // prose-units.ts's own note, and round 4's finding B3).
    expect(new Set(units).size).toBe(units.length);
    const sample = units.join('');
    expect(sample.length).toBeLessThan(20_000); // prepareSample must not truncate: the assertion below measures the gate's real input
    expect(guiraudR(sample)).toBeGreaterThan(LEXICAL_RICHNESS_FLOOR); // fixture sanity: genuinely clears the floor, not just non-empty

    const result = detectManuscriptLanguageFromChapters([{ title: '第一章', body: sample }]);
    expect(result.language).toBe('ja');
    expect(result.fallback).toBe(false);
  });

  /* #2256 review round 3, finding C5 (residual, stated plainly rather than
     implied away) — trigram tokenization is close to INERT for kana beyond
     what dedupeProseUnits already catches: a repetitive-but-NOT-exact-
     duplicate kana junk shape (an ordinal-prefixed heading list, cycling
     through a small set of headings) clears LEXICAL_RICHNESS_FLOOR easily
     and is NOT refused, while only an EXACT-duplicate heading — which
     dedup collapses to one occurrence regardless of tokenizer — is
     refused. This does not produce a wrong-LANGUAGE outcome (the script
     pre-pass returns 'ja' for all-kana input independent of the richness
     gate), but the richness gate itself contributes nothing extra for kana
     beyond dedup. Pinned here rather than left as a comment-only claim. */
  it('finding C5 (residual) — a repetitive, non-exact-duplicate kana heading list is NOT refused by the richness gate (dedup is the only real backstop for kana)', () => {
    const HEADINGS = ['だいいっしょう', 'だいにしょう', 'だいさんしょう', 'だいよんしょう', 'だいごしょう', 'だいろくしょう', 'だいななしょう', 'だいはっしょう'];
    const headingJunk = Array.from({ length: 2000 }, (_, i) => `${HEADINGS[i % HEADINGS.length]}。`).join('');
    // Fixture sanity: NOT an exact duplicate (8 distinct headings cycling),
    // so dedupeProseUnits does not collapse it away on its own.
    expect(new Set(HEADINGS).size).toBeGreaterThan(1);
    expect(guiraudR(headingJunk)).toBeGreaterThan(LEXICAL_RICHNESS_FLOOR); // NOT refused -- the residual

    /* #2256 review round 4, finding B5 — this control used to be
       `Array(2000).fill(HEADINGS[0]).join('') + '。'`, with NO terminator
       between the copies: one 14,000-character prose unit that
       dedupeProseUnits leaves entirely untouched, refused at R=0.0592 by
       the RICHNESS gate. So the control for "dedup is the only real
       backstop for kana" was demonstrating the opposite of its own claim.
       Terminating each copy is what makes dedup the mechanism: 2,000 units
       collapse to ONE 7-character unit, R=2.2361 — the number
       prose-units.ts cites. The unit count is asserted so a future edit
       that drops the terminator again fails here instead of silently
       swapping the mechanism back. */
    const exactDuplicateJunk = Array(2000).fill(HEADINGS[0] + '。').join('');
    expect(countProseUnits(exactDuplicateJunk)).toBe(2000);
    expect(guiraudR(exactDuplicateJunk)).toBeLessThan(LEXICAL_RICHNESS_FLOOR); // IS refused -- dedup alone does this
  });

  /* Finding 4 — the digit ceiling's claimed margin was fiction: a real,
     genuinely short-sentence book (this repo's corpus has one at ~6.8
     tokens/unit) with verse-style numbering (one digit token per unit)
     scored close to or above the OLD 0.1 ceiling under the new tokenizer.
     Both EN and ZH verse-numbered real-shaped short sentences must NOT be
     refused. */
  it('finding 4 — verse-numbered real-shaped short sentences (1 digit token per unit) are not wrongly refused', () => {
    // 25 distinct short sentences per script (not 8 — a small pool would
    // fail on RICHNESS once verse numbers defeat dedup, which is a
    // different gate than the one this test is about; sized so richness
    // clears comfortably and the DIGIT ceiling margin is what's exercised).
    const shortEn = [
      'The horn had cooled by dawn.', 'Wren scraped the last slag away.', 'Someone knocked hard at the door.',
      'The gull wheeled over the pier.', 'Rain drummed on the tin roof.', 'He counted the coins twice more.',
      'She folded the letter once again.', 'The tram rattled past the square.', 'The kettle hissed on the stove.',
      'A dog barked twice in the yard.', 'The candle guttered in the draft.', 'She swept the ash from the hearth.',
      'The gate creaked shut behind him.', 'A crow landed on the fence post.', 'The bread rose slow in the pan.',
      'He tied the rope in a knot.', 'The lamp flickered and then held.', 'She pinned the note to the door.',
      'The cart wheel struck a stone.', 'He lit the lantern by the well.', 'The fog rolled in off the marsh.',
      'She hung the coat by the fire.', 'The bell tolled once at noon.', 'A moth circled the open flame.',
      'He shut the ledger with a snap.',
    ];
    const shortZh = [
      '号角在黎明前已经冷却', '雷恩刮掉了最后的炉渣', '有人用力敲响了门', '海鸥在码头上盘旋',
      '雨点敲打着铁皮屋顶', '他又数了两遍硬币', '她再次折起了那封信', '电车摇晃着驶过广场',
      '水壶在炉子上嘶嘶作响', '院子里的狗叫了两声', '蜡烛在风中摇曳不定', '她把炉灰扫了出去',
      '大门在他身后吱呀关上', '一只乌鸦落在篱笆上', '面包在锅里慢慢发起', '他把绳子打了个结',
      '油灯闪了一下又稳住', '她把纸条钉在门上', '车轮压到了一块石头', '他在井边点亮了灯笼',
      '雾气从沼泽地涌了进来', '她把外套挂在炉火边', '钟声在正午敲了一下', '一只飞蛾绕着火焰打转',
      '他啪地合上了账本',
    ];
    const enVerse = Array.from({ length: 100 }, (_, i) => `${i + 1} ${shortEn[i % shortEn.length]}`).join(' ');
    const zhVerse = Array.from({ length: 100 }, (_, i) => `${i + 1}、${shortZh[i % shortZh.length]}。`).join('');

    // Fixture sanity: richness clears the floor on its own, so a failure
    // here would be about the digit ceiling, not an underpowered pool.
    expect(guiraudR(enVerse)).toBeGreaterThan(LEXICAL_RICHNESS_FLOOR);
    expect(guiraudR(zhVerse)).toBeGreaterThan(LEXICAL_RICHNESS_FLOOR);
    expect(digitTokenShare(enVerse)).toBeLessThanOrEqual(DIGIT_TOKEN_SHARE_CEILING);
    expect(digitTokenShare(zhVerse)).toBeLessThanOrEqual(DIGIT_TOKEN_SHARE_CEILING);

    const enResult = detectManuscriptLanguageFromChapters([{ title: 'Chapter One', body: enVerse }]);
    const zhResult = detectManuscriptLanguageFromChapters([{ title: '第一章', body: zhVerse }]);
    expect(enResult.fallback).toBe(false);
    expect(zhResult.fallback).toBe(false);
  });
});
