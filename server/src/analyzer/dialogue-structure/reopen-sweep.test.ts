import { describe, expect, it } from 'vitest';
import { conventionsFor } from './lang/index.js';
import { buildNameIndex } from './name-matcher.js';
import { parseChapterStructure } from './parser.js';
import type { LanguageConventions } from './types.js';

/* #2315 Task 10 — the design pass's generated sweeps
   (docs/superpowers/specs/2026-08-13-primary-pair-straddle-design.md),
   ported into a committed test through the REAL production parser — no env
   vars, no patched module copies, no reimplementation of `findQuoteRuns`.
   Every count below is a direct re-measurement against this repo's shipped
   `parser.ts`, not copied from the design doc (whose figures came from a
   separate hand-written port, `scratchpad/s2315/engine.mjs` — proven
   byte-identical to the shipped code over the full 1,190,634-paragraph
   corpus by `scratchpad/s2315/equivalence.mts`, Task 11).

   WHY A GENERATED SWEEP AND NOT JUST THE HAND-WRITTEN ANCHORS ABOVE. M2's own
   committed sweep (tier-sweep.test.ts) passed under three separate mutations
   of the rule it existed to pin, and `sweep-six-langs`'s "0 destroyed of
   51,608" is a CONSTANT — it reads 0 with both tier guards deleted. A count
   with no control that can go RED proves nothing. Every assertion below has
   one: a no-stray control (clean input must destroy 0), a positive
   attribution control (the metric must be able to read a speaker at all),
   and the firing control for defect 2's guard is exercised as mutation (d) in
   the PR body's mutation table rather than committed here — there is no
   production toggle to bypass the guard with, only removing the code (see
   that mutation's own comment below). */

const speechOf = (body: string, conv: LanguageConventions) =>
  parseChapterStructure(body, buildNameIndex([], conv))
    .flatMap((p) => p.spans)
    .filter((s) => s.kind === 'speech')
    .map((s) => body.slice(s.start, s.end));

/* ------------------------------------------------------------------ */
/* The 805-shape family (design § "The ticket's number", `family.mts`) —   */
/* restricted to de/ru/en per the plan ("if the whole set exceeds ~2s...    */
/* never thin the cross-product WITHIN a language"): these three carry     */
/* 104+54+150 = 308 of the pre-fix 396, the bulk of the family, and the    */
/* full 7-language, 805-shape set runs in well under 2s through the real   */
/* parser regardless — restricting is not load-bearing here, only faithful */
/* to the plan's stated fallback. */
/* ------------------------------------------------------------------ */

const FAMILY_LANGS = ['de', 'en', 'ru'] as const;
const DESTROYED_MEASURED: Record<string, number> = { de: 24, en: 30, ru: 92 };
/* PR #2340 review nit 4: the shape count is the family's own denominator —
   the one number a language-table change would move silently if only
   `toBeGreaterThan(0)` pinned it. */
const SHAPE_COUNT: Record<string, number> = { de: 176, en: 117, ru: 336 };

const FAMILY_TEXT: Record<
  string,
  { t1: string; tag1: string; gapPost: string; t2: string; tag2: string; tailWord: string; tailPost: string }
> = {
  de: {
    t1: 'Hallo', tag1: ', sagt er, betrachtet das ', gapPost: 'Faust-Plakat.',
    t2: 'Und du', tag2: ', fragt sie, nahe der ', tailWord: 'Galerie', tailPost: '.',
  },
  en: {
    t1: 'Hi', tag1: ', he said, passing the ', gapPost: 'Faust poster.',
    t2: 'Bye', tag2: ', she said, near the ', tailWord: 'gallery', tailPost: '.',
  },
  ru: {
    t1: 'Привет', tag1: ', сказал он, глядя на ', gapPost: 'Фауста.',
    t2: 'Пока', tag2: ', сказала она, около ', tailWord: 'галереи', tailPost: '.',
  },
};

interface FamilyShape {
  body: string;
  /** '' for the no-stray control row */
  stray: string;
}

/** Every shape whose both turns are well-formed under the language's own
    table, crossed with every (stray opener in the gap, late closer in the
    tail) combination drawn from that same table — plus the no-stray control
    row. Ground truth is the CONSTRUCTION: `t1`/`t2` are the bodies the
    parser must recover, not a parser reading. */
function familyShapes(lang: string): FamilyShape[] {
  const t = FAMILY_TEXT[lang];
  const pairs = conventionsFor(lang)!.quotePairs as Array<[string, string]>;
  const OPEN = [...new Set(pairs.map(([o]) => o))];
  const CLOSE = [...new Set(pairs.map(([, c]) => c))];
  const wellFormed = (o: string, c: string) => pairs.some(([a, b]) => a === o && b === c);
  const strays: Array<[string, string]> = [['', '']];
  for (const stray of OPEN) {
    for (const late of CLOSE) strays.push([stray, late]);
    strays.push([stray, '']);
  }
  const out: FamilyShape[] = [];
  for (const [o1, c1] of pairs) {
    for (const [o2, c2] of pairs) {
      if (!wellFormed(o1, c1) || !wellFormed(o2, c2)) continue;
      for (const [stray, late] of strays) {
        out.push({
          stray,
          body:
            `${o1}${t.t1}${c1}${t.tag1}${stray}${t.gapPost} ` +
            `${o2}${t.t2}${c2}${t.tag2}${t.tailWord}${late}${t.tailPost}`,
        });
      }
    }
  }
  return out;
}

describe('parser — #2315 Task 10: the primary-pair straddle family (generated, real parser)', () => {
  for (const lang of FAMILY_LANGS) {
    const conv = conventionsFor(lang)!;
    const t = FAMILY_TEXT[lang];
    const shapes = familyShapes(lang);

    it(`${lang}: generates the measured shape set (${shapes.length} shapes)`, () => {
      expect(shapes.length).toBe(SHAPE_COUNT[lang]);
    });

    it(`${lang}: destroyed count matches the measured figure (mutation (a)/(c) target)`, () => {
      let destroyed = 0;
      for (const s of shapes) {
        const spoken = speechOf(s.body, conv);
        if (!spoken.includes(t.t1) || !spoken.includes(t.t2)) destroyed++;
      }
      expect(destroyed).toBe(DESTROYED_MEASURED[lang]);
    });

    /* NO-STRAY CONTROL. Clean input — no stray opener anywhere in the gap or
       tail — must destroy 0: proves the family does not cry wolf on
       well-formed input. `ru`'s no-stray control caught a real defect
       (design case 3, the closer-as-opener collision) before the fix; it
       must read 0 now. */
    it(`${lang}: no-stray control destroys 0 (does not cry wolf on clean input)`, () => {
      let destroyed = 0;
      for (const s of shapes.filter((x) => x.stray === '')) {
        const spoken = speechOf(s.body, conv);
        if (!spoken.includes(t.t1) || !spoken.includes(t.t2)) destroyed++;
      }
      expect(destroyed).toBe(0);
    });
  }
});

/* ------------------------------------------------------------------ */
/* The attribution-aware family (design § "Defect 2", `attrib.mts`) — the   */
/* gate for defect 2: the roster is real, and the `speaker` field is        */
/* actually read, unlike every geometry-only instrument in this strand.    */
/* ------------------------------------------------------------------ */

const ATTRIB_LANGS = ['es', 'fr', 'ru', 'en', 'zh', 'ja'] as const;

/* The secondary pair each language would gain from #2286 (the widening this
   guard exists to make safe) — mirrors `scratchpad/s2315/wide/lang/*.ts`
   (the post-M2 state #2286 lands). Hand-carried here rather than imported,
   because #2286 has not landed on `main` yet and this test must run against
   today's shipped tables (`secondaryQuotePairs: []`) plus a locally-declared
   tier, exactly like the existing "#2315 defect 2" describe block above. */
const WIDE_SECONDARY: Record<string, Array<[string, string]>> = {
  es: [['"', '"']],
  fr: [['“', '”'], ['"', '"']],
  ru: [['‘', '’']],
  en: [['«', '»']],
  zh: [['‘', '’'], ['"', '"']],
  ja: [['“', '”'], ['"', '"']],
};

const ATTRIB_TEXT: Record<string, { t1: string; verb: string; name: string; tail: string; second: string }> = {
  es: { t1: 'Hola', verb: ', dijo ', name: 'Antonio', tail: '.', second: 'Adiós' },
  fr: { t1: 'Bonjour', verb: ', dit ', name: 'Antoine', tail: '.', second: 'Au revoir' },
  ru: { t1: 'Привет', verb: ', сказал ', name: 'Антон', tail: '.', second: 'Пока' },
  en: { t1: 'Hi', verb: ', said ', name: 'Anton', tail: '.', second: 'Bye' },
  zh: { t1: '你好', verb: '，说道', name: '安东', tail: '。', second: '再见' },
  ja: { t1: 'おはよう', verb: 'と言った', name: 'アントン', tail: '。', second: 'さようなら' },
};

interface AttribCase {
  lang: string;
  body: string;
}

/** The defect's shape: primary turn, then a tag clause quoting the cast name
    in the SECONDARY convention. Plus the shape that must NOT be broken by any
    fix: a genuine secondary-convention SECOND TURN after a completed tag
    sentence. */
function attribCases(lang: string): AttribCase[] {
  const t = ATTRIB_TEXT[lang];
  const prim = conventionsFor(lang)!.quotePairs as Array<[string, string]>;
  const sec = WIDE_SECONDARY[lang];
  const out: AttribCase[] = [];
  for (const [po, pc] of prim) {
    for (const [so, sc] of sec) {
      out.push({ lang, body: `${po}${t.t1}${pc}${t.verb}${so}${t.name}${sc}${t.tail}` });
      out.push({
        lang,
        body: `${po}${t.t1}${pc}${t.verb}${t.name}${t.tail} ${so}${t.second}${sc}${t.verb}${t.name}${t.tail}`,
      });
    }
  }
  return out;
}

function attribResult(c: AttribCase, conv: LanguageConventions) {
  const index = buildNameIndex([{ id: 'anton', name: ATTRIB_TEXT[c.lang].name }] as never, conv);
  const spans = parseChapterStructure(c.body, index).flatMap((p) => p.spans);
  const speech = spans.filter((s) => s.kind === 'speech');
  return {
    spoken: speech.map((s) => c.body.slice(s.start, s.end)),
    speakers: speech.map((s) => s.speaker?.characterId ?? null),
  };
}

describe('parser — #2315 Task 10: the attribution-aware family (generated, real parser)', () => {
  const cases = ATTRIB_LANGS.flatMap((l) => attribCases(l));

  it('generates the 42-case family', () => {
    expect(cases.length).toBe(42);
  });

  /* POSITIVE CONTROL, and it comes first: without it a zero below could mean
     "the metric cannot read a speaker at all" rather than "the guard works". */
  it('POSITIVE CONTROL: with no secondary pair declared (shipped tables), every case is attributed (42 of 42)', () => {
    let attributed = 0;
    for (const c of cases) {
      const conv = conventionsFor(c.lang)!; // shipped: secondaryQuotePairs: []
      const r = attribResult(c, conv);
      const first = r.spoken.indexOf(ATTRIB_TEXT[c.lang].t1);
      if (first >= 0 && r.speakers[first] === 'anton') attributed++;
    }
    expect(attributed).toBe(42);
  });

  it('the shipped tag-clause guard: 0 of 42 cases lose their speaker', () => {
    let speakersLost = 0;
    for (const c of cases) {
      const wide: LanguageConventions = { ...conventionsFor(c.lang)!, secondaryQuotePairs: WIDE_SECONDARY[c.lang] };
      const r = attribResult(c, wide);
      const first = r.spoken.indexOf(ATTRIB_TEXT[c.lang].t1);
      if (first < 0 || r.speakers[first] !== 'anton') speakersLost++;
    }
    expect(speakersLost).toBe(0);
  });

  it('MUST STILL WORK: the genuine secondary-convention second turn in every case keeps its own speaker too', () => {
    for (const c of cases) {
      if (!c.body.includes(ATTRIB_TEXT[c.lang].second)) continue; // the tag-cut-only case has no second turn
      const wide: LanguageConventions = { ...conventionsFor(c.lang)!, secondaryQuotePairs: WIDE_SECONDARY[c.lang] };
      const r = attribResult(c, wide);
      const second = r.spoken.indexOf(ATTRIB_TEXT[c.lang].second);
      expect(second, `${c.lang}: ${c.body}`).toBeGreaterThanOrEqual(0);
      expect(r.speakers[second], `${c.lang}: ${c.body}`).toBe('anton');
    }
  });

  /* FIRING CONTROL — "the same family with the guard bypassed must lose 21"
     (plan Task 10). There is no production toggle for this: the guard is
     unconditionally wired into `findQuoteRuns`. Bypassing it without editing
     `parser.ts` (e.g. zeroing `speechVerbStems`/`beatVerbStems` on the `conv`
     passed in) would ALSO defeat the narration->tag reclassification a few
     lines below the guard in `parseQuoteParagraph`, which is a DIFFERENT
     mechanism — that is a reimplementation-by-proxy, not a faithful bypass,
     and the plan requires "no reimplementation". The faithful bypass is
     mutation (d) below: physically remove the `cutsATagClause` call and
     re-run this describe block. Verified by hand for this report (see the
     PR body's mutation table) — RED, attribution 21 of 42 lost, matching the
     design's measured firing control exactly — then reverted. Not committed
     as a standing assertion because there is nothing in shipped code for it
     to assert against without that removal. */
});

/* ------------------------------------------------------------------ */
/* PR #2340 review finding 1 — the verb-BEFORE-quote (CJK leading-tag)      */
/* family. The attribution family above only exercises the Latin           */
/* TRAILING-tag shape (turn, verb, NAME) even in CJK glyphs. Real zh/ja     */
/* dialogue is dominated by the MIRROR shape — a verb introduces the turn, */
/* "他说，'你好'" — and zh/ja's single-character verb stems also match as    */
/* SUBSTRINGS inside unrelated words with no word-boundary to stop them:   */
/* 道 inside 道路 ("road") and 知道 ("know"), 息 inside 息子 ("son"), 笑     */
/* inside 微笑/苦笑い ("smile"). None of this is a review nit — it is the   */
/* MAJOR finding (93.7% of one real Chinese book's speech spans falsely    */
/* declined) and this is the generated, at-scale regression for it. */
/* ------------------------------------------------------------------ */

const LEADING_TAG_LANGS = ['zh', 'ja'] as const;
const LEADING_TAG_SECONDARY: Record<string, Array<[string, string]>> = {
  zh: [['‘', '’'], ['"', '"']],
  ja: [['"', '"']],
};
/* NARRATION prefixes before the leading tag: a mix of genuine FALSE-COGNATE
   substring matches (a verb stem inside an unrelated word), a genuine BEAT
   verb describing narrative action before the quote (not a name-tag), and
   one clean no-match control per language. None of these prefixes is itself
   a tag naming who is about to speak — the only real tag in each generated
   body is the "NAME verb，" clause immediately before the candidate. */
const NARRATION_PREFIX: Record<string, string[]> = {
  zh: ['他走在道路上，', '他不知道，', '她微笑着，', '他走在马路上，'],
  ja: ['彼は道を渡って、', '彼の息子が立って、', '彼女は苦笑いして、'],
};
const LEADING_TEXT: Record<string, { name: string; verb: string; turn: string }> = {
  zh: { name: '安东', verb: '说，', turn: '你好' },
  ja: { name: 'アントン', verb: 'は言った、', turn: 'こんにちは' },
};

interface LeadingCase { lang: string; body: string; prefix: string }
function leadingCases(lang: string): LeadingCase[] {
  const t = LEADING_TEXT[lang];
  const out: LeadingCase[] = [];
  for (const prefix of NARRATION_PREFIX[lang]) {
    for (const [so, sc] of LEADING_TAG_SECONDARY[lang]) {
      out.push({ lang, prefix, body: `${prefix}${t.name}${t.verb}${so}${t.turn}${sc}。` });
    }
  }
  return out;
}

describe('parser — #2315 PR #2340 review finding 1: the verb-before-quote (CJK leading-tag) family', () => {
  const cases = LEADING_TAG_LANGS.flatMap((l) => leadingCases(l));

  it('generates a non-trivial shape set', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  /* CONTROL, comes first: proves the family actually contains a verb-stem
     match in the narration prefix for BOTH languages — a family with no
     stem hit anywhere would pass the assertion below vacuously. */
  it('control: every language has at least one narration prefix carrying a verb-stem substring', () => {
    for (const lang of LEADING_TAG_LANGS) {
      const conv = conventionsFor(lang)!;
      const stems = [...conv.speechVerbStems, ...conv.beatVerbStems];
      const hit = NARRATION_PREFIX[lang].some((p) => stems.some((s) => p.includes(s)));
      expect(hit, lang).toBe(true);
    }
  });

  it('every genuine turn survives, regardless of a verb-stem substring in the narration before it', () => {
    const failures: string[] = [];
    for (const c of cases) {
      const conv: LanguageConventions = { ...conventionsFor(c.lang)!, secondaryQuotePairs: LEADING_TAG_SECONDARY[c.lang] };
      const spoken = speechOf(c.body, conv);
      if (!spoken.includes(LEADING_TEXT[c.lang].turn)) failures.push(c.body);
    }
    expect(failures, failures.join('\n')).toHaveLength(0);
  });

  it('every genuine turn is also correctly attributed to the name in the leading tag', () => {
    const failures: string[] = [];
    for (const c of cases) {
      const conv: LanguageConventions = { ...conventionsFor(c.lang)!, secondaryQuotePairs: LEADING_TAG_SECONDARY[c.lang] };
      const index = buildNameIndex([{ id: 'anton', name: LEADING_TEXT[c.lang].name }] as never, conv);
      const speech = parseChapterStructure(c.body, index)
        .flatMap((p) => p.spans)
        .filter((s) => s.kind === 'speech');
      const turnSpan = speech.find((s) => c.body.slice(s.start, s.end) === LEADING_TEXT[c.lang].turn);
      if (!turnSpan || turnSpan.speaker?.characterId !== 'anton') failures.push(c.body);
    }
    expect(failures, failures.join('\n')).toHaveLength(0);
  });
});
