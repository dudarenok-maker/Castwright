/* Server-side manuscript language detection (fs-41/fs-50 seam 2).
   Script pre-pass is authoritative; franc disambiguates Latin; front-matter
   stripped before detecting; es/fr/de detected but not yet `supported`. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectManuscriptLanguage, detectManuscriptLanguageFromChapters } from './detect-language.js';
import { getLanguageEntry } from './language-registry.js';
import { countWords, FRONT_MATTER_WORD_THRESHOLD } from '../parsers/front-matter.js';
import { countProseUnits, PROSE_UNIT_FLOOR } from './prose-units.js';

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
