import { describe, expect, it } from 'vitest';
import { conventionsFor } from './lang/index.js';
import { buildNameIndex } from './name-matcher.js';
import { parseChapterStructure } from './parser.js';
import type { LanguageConventions } from './types.js';

/* #2288 M2 Task 5 — generated regression sweeps proving the gap-tier rule
   (Tasks 1-4, findQuoteRuns) destroys zero real dialogue turns on two
   geometry classes the shipped acceptance-criterion sweep (docs/superpowers/
   plans/2026-08-13-gap-seeded-straddle.md) cannot express by itself:

     F2 (straddle)  — a stray secondary-convention opener sits in the gap
       between two real turns, and its nearest same-glyph closer lands AFTER
       the second turn, so a naive leftmost-accept scan (no tiering at all)
       swallows turn 2 whole.
     F3 (gap x nest) — the same straddle geometry, but the FIRST turn is
       itself a legitimate nested quotation. No other sweep family covers
       this cross-product.

   Restricted to es/ru/en per the plan ("keep it to three languages... if it
   exceeds ~2s, drop a language — never thin the cross-product"); ru's
   quotePairs table (4 pairs) is the largest of the three so it sets the pace.

   Every shape is driven through the REAL production parser — no env vars, no
   patched module copies, no reimplementation of findQuoteRuns. `tiered` adds
   the candidate pair as SECONDARY (the rule under test); `flat` is the
   control — same pair added as PRIMARY instead, i.e. "what happens without
   tiering"; `ref` is the untouched table (fixed reference reading, no
   widening at all). */

const speechOf = (body: string, conv: LanguageConventions): string[] =>
  parseChapterStructure(body, buildNameIndex([], conv))
    .flatMap((p) => p.spans)
    .filter((s) => s.kind === 'speech')
    .map((s) => body.slice(s.start, s.end));

function variants(lang: string, addedPair: [string, string]) {
  /* #2286 shipped `addedPair` into the REAL table's `secondaryQuotePairs` for
     es/ru/en — the exact pair this sweep adds synthetically to prove the tier
     is engaged. `ref` must stay the pre-widening baseline (no `addedPair` in
     either tier) or the "tiered differs from ref" checks below go vacuously
     to 0 by construction: `tiered` and `ref` would just be the same shipped
     table twice, which passes even if the tier were deleted outright — the
     exact trap this file's own comments warn about. Filtering `addedPair`
     back out of the shipped `secondaryQuotePairs` restores the pre-#2286
     baseline the pinned counts (88/225/114, 116/618/258) were measured
     against, so those values are unchanged by this. */
  const shipped = conventionsFor(lang)!;
  const ref: LanguageConventions = {
    ...shipped,
    secondaryQuotePairs: shipped.secondaryQuotePairs.filter(
      ([o, c]) => !(o === addedPair[0] && c === addedPair[1]),
    ),
  };
  const tiered: LanguageConventions = { ...ref, secondaryQuotePairs: [addedPair] };
  const flat: LanguageConventions = {
    ...ref,
    quotePairs: [...ref.quotePairs, addedPair],
    secondaryQuotePairs: [],
  };
  return { ref, tiered, flat };
}

function openersClosers(allPairs: Array<[string, string]>, lang: string): { OPEN: string[]; CLOSE: string[] } {
  const OPEN = [...new Set(allPairs.map(([o]) => o))];
  const CLOSE0 = [...new Set(allPairs.map(([, c]) => c))];
  if (lang === 'ru') CLOSE0.push('’');
  const CLOSE = [...new Set(CLOSE0)];
  return { OPEN, CLOSE };
}

function strayList(OPEN: string[], CLOSE: string[]): Array<[string, string] | null> {
  const strays: Array<[string, string] | null> = [null];
  for (const so of OPEN) {
    for (const lc of CLOSE) strays.push([so, lc]);
    strays.push([so, '']);
  }
  return strays;
}

// ---------------------------------------------------------------------------
// Family F2 — straddle geometry
// ---------------------------------------------------------------------------

interface StraddleText {
  t1: string;
  tag1: string;
  gapPost: string;
  t2: string;
  tag2: string;
  tailWord: string;
  tailPost: string;
}

const F2_TEXT: Record<string, StraddleText> = {
  es: {
    t1: 'Hola',
    tag1: ', dijo él, mirando el ',
    gapPost: 'cartel de Fausto.',
    t2: 'Y tú',
    tag2: ', preguntó ella, cerca de la ',
    tailWord: 'galería',
    tailPost: '.',
  },
  ru: {
    t1: 'Привет',
    tag1: ', сказал он, глядя на ',
    gapPost: 'Фауста.',
    t2: 'Пока',
    tag2: ', сказала она, около ',
    tailWord: 'галереи',
    tailPost: '.',
  },
  en: {
    t1: 'Hi',
    tag1: ', he said, passing the ',
    gapPost: 'Faust poster.',
    t2: 'Bye',
    tag2: ', she said, near the ',
    tailWord: 'gallery',
    tailPost: '.',
  },
};

function straddleShapes(t: StraddleText, allPairs: Array<[string, string]>, lang: string): string[] {
  const { OPEN, CLOSE } = openersClosers(allPairs, lang);
  const strays = strayList(OPEN, CLOSE);
  const out: string[] = [];
  for (const o1 of OPEN)
    for (const c1 of CLOSE)
      for (const o2 of OPEN)
        for (const c2 of CLOSE)
          for (const sg of strays) {
            const stray = sg ? sg[0] : '';
            const late = sg ? sg[1] : '';
            out.push(
              `${o1}${t.t1}${c1}${t.tag1}${stray}${t.gapPost} ` +
                `${o2}${t.t2}${c2}${t.tag2}${t.tailWord}${late}${t.tailPost}`,
            );
          }
  return out;
}

// ---------------------------------------------------------------------------
// Family F3 — gap x nest cross-product
// ---------------------------------------------------------------------------

interface CrossText {
  pre: string;
  nestWord: string;
  post: string;
  tag1: string;
  gap: string;
  t2: string;
  tag2: string;
  tail: string;
}

const F3_TEXT: Record<string, CrossText> = {
  es: {
    pre: 'Él dijo ',
    nestWord: 'hola',
    post: ' a mí',
    tag1: ', explicó él, mirando el ',
    gap: 'cartel de Fausto.',
    t2: 'Adiós',
    tag2: ', dijo ella, cerca de la ',
    tail: 'galería',
  },
  ru: {
    pre: 'Он сказал ',
    nestWord: 'привет',
    post: ' мне',
    tag1: ', объяснил он, глядя на ',
    gap: 'Фауста.',
    t2: 'Пока',
    tag2: ', сказала она, около ',
    tail: 'галереи',
  },
  en: {
    pre: 'He said ',
    nestWord: 'hi',
    post: ' to me',
    tag1: ', she explained, passing the ',
    gap: 'Faust poster.',
    t2: 'Bye',
    tag2: ', she said, near the ',
    tail: 'gallery',
  },
};

function crossShapes(
  t: CrossText,
  allPairs: Array<[string, string]>,
  lang: string,
): Array<{ body: string; outer: string }> {
  const { OPEN, CLOSE } = openersClosers(allPairs, lang);
  const strays = strayList(OPEN, CLOSE);
  const out: Array<{ body: string; outer: string }> = [];
  for (const [o1, c1] of allPairs)
    for (const [no, nc] of allPairs)
      for (const o2 of OPEN)
        for (const c2 of CLOSE)
          for (const sg of strays) {
            const stray = sg ? sg[0] : '';
            const late = sg ? sg[1] : '';
            const outer = `${t.pre}${no}${t.nestWord}${nc}${t.post}`;
            const body = `${o1}${outer}${c1}${t.tag1}${stray}${t.gap} ${o2}${t.t2}${c2}${t.tag2}${t.tail}${late}.`;
            out.push({ body, outer });
          }
  return out;
}

// ---------------------------------------------------------------------------

const LANGS: Record<string, [string, string]> = {
  es: ['"', '"'],
  ru: ['‘', '’'],
  en: ['«', '»'],
};

describe('gap-tier straddle sweeps (#2288 M2 Task 5)', () => {
  for (const [lang, addedPair] of Object.entries(LANGS)) {
    describe(`F2 straddle — ${lang}`, () => {
      const { ref, tiered, flat } = variants(lang, addedPair);
      const allPairs: Array<[string, string]> = [...ref.quotePairs, addedPair];
      const t = F2_TEXT[lang];
      const shapes = straddleShapes(t, allPairs, lang);

      it(`generates a non-trivial shape set (${shapes.length} shapes)`, () => {
        expect(shapes.length).toBeGreaterThan(0);
      });

      it('tiered: destroys zero real turns', () => {
        let destroyed = 0;
        for (const body of shapes) {
          const r = speechOf(body, ref);
          const ok = r.includes(t.t1) || r.includes(t.t2);
          if (!ok) continue;
          const cand = speechOf(body, tiered);
          const lost = (r.includes(t.t1) && !cand.includes(t.t1)) || (r.includes(t.t2) && !cand.includes(t.t2));
          if (lost) destroyed++;
        }
        expect(destroyed).toBe(0);
      });

      it('control (flat, no tiering) destroys at least one real turn — proves the shape family bites', () => {
        let destroyed = 0;
        for (const body of shapes) {
          const r = speechOf(body, ref);
          const ok = r.includes(t.t1) || r.includes(t.t2);
          if (!ok) continue;
          const ctl = speechOf(body, flat);
          const lost = (r.includes(t.t1) && !ctl.includes(t.t1)) || (r.includes(t.t2) && !ctl.includes(t.t2));
          if (lost) destroyed++;
        }
        expect(destroyed).toBeGreaterThan(0);
      });

      /* The two assertions above both pass on a `findQuoteRuns` that ignores
         `secondary` outright: with the tier never applied, `tiered` parses
         identically to `ref`, so `destroyed` is trivially 0 for every shape —
         the step cannot go red no matter how thoroughly the rule has been
         gutted. This assertion controls for exactly that: it requires
         `tiered` to actually produce a DIFFERENT parse than the untouched
         `ref` table on a measured number of scored shapes, so a no-op
         (secondary ignored, `tiered === ref` everywhere) reads as 0 and
         fails outright. Value pinned by direct measurement against this
         file's own shapes, not copied from any other report. */
      /* #2315: re-measured against the shipped re-open bound + tag-clause
         guard (docs/superpowers/plans/2026-08-13-primary-pair-straddle.md
         Task 5) — the bound lives inside `scan`, which this tier calls twice,
         so it reaches these shapes too. Values are a direct re-measurement,
         not copied from the design doc's prototype figures. */
      it(`tiered differs from ref on ${lang === 'es' ? 74 : lang === 'ru' ? 253 : 130} scored shapes (proves the tier is actually engaged)`, () => {
        let differs = 0;
        for (const body of shapes) {
          const r = speechOf(body, ref);
          const ok = r.includes(t.t1) || r.includes(t.t2);
          if (!ok) continue;
          const cand = speechOf(body, tiered);
          if (JSON.stringify(r) !== JSON.stringify(cand)) differs++;
        }
        expect(differs).toBe(lang === 'es' ? 74 : lang === 'ru' ? 253 : 130);
      });
    });

    describe(`F3 gap x nest — ${lang}`, () => {
      const { ref, tiered, flat } = variants(lang, addedPair);
      const allPairs: Array<[string, string]> = [...ref.quotePairs, addedPair];
      const t = F3_TEXT[lang];
      const shapes = crossShapes(t, allPairs, lang);

      it(`generates a non-trivial shape set (${shapes.length} shapes)`, () => {
        expect(shapes.length).toBeGreaterThan(0);
      });

      it('tiered: destroys zero real turns and breaks zero nests', () => {
        let destroyed = 0;
        let nestBrokenCount = 0;
        for (const { body, outer } of shapes) {
          const r = speechOf(body, ref);
          const refNestOK = r.includes(outer);
          if (!(refNestOK || r.includes(t.t2))) continue;
          const cand = speechOf(body, tiered);
          const lost =
            (refNestOK && !cand.includes(outer)) || (r.includes(t.t2) && !cand.includes(t.t2));
          if (lost) destroyed++;
          if (refNestOK && !cand.includes(outer)) nestBrokenCount++;
        }
        expect(destroyed).toBe(0);
        expect(nestBrokenCount).toBe(0);
      });

      it('control (flat, no tiering) destroys at least one real turn — proves the cross-product bites', () => {
        let destroyed = 0;
        for (const { body, outer } of shapes) {
          const r = speechOf(body, ref);
          const refNestOK = r.includes(outer);
          if (!(refNestOK || r.includes(t.t2))) continue;
          const ctl = speechOf(body, flat);
          const lost = (refNestOK && !ctl.includes(outer)) || (r.includes(t.t2) && !ctl.includes(t.t2));
          if (lost) destroyed++;
        }
        expect(destroyed).toBeGreaterThan(0);
      });

      /* Same control as F2's (see its comment): a `findQuoteRuns` that ignores
         `secondary` entirely makes `tiered` parse identically to `ref`, so
         `destroyed`/`nestBrokenCount` are trivially 0 above and cannot go red.
         This requires `tiered` to actually differ from `ref` on a measured
         number of scored shapes. Value pinned by direct measurement against
         this file's own shapes. */
      /* #2315: re-measured, same rationale as F2's comment above. */
      it(`tiered differs from ref on ${lang === 'es' ? 124 : lang === 'ru' ? 632 : 277} scored shapes (proves the tier is actually engaged)`, () => {
        let differs = 0;
        for (const { body, outer } of shapes) {
          const r = speechOf(body, ref);
          const refNestOK = r.includes(outer);
          if (!(refNestOK || r.includes(t.t2))) continue;
          const cand = speechOf(body, tiered);
          if (JSON.stringify(r) !== JSON.stringify(cand)) differs++;
        }
        expect(differs).toBe(lang === 'es' ? 124 : lang === 'ru' ? 632 : 277);
      });
    });
  }
});
