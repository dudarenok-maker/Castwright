# The re-open bound and the tag-clause guard (#2315) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> ## ✅ Task 0 — ANSWERED by the repo owner, 2026-08-13. All three as recommended.
>
> **A — text-preserving splits are ACCEPTED.** Tasks 1–7 proceed. **B — 172 is
> accepted as a partial fix** (396 → 172, at the cost of 20 `ru` regressions in
> M2's families); the 2.20 % residual is pinned, not chased. **C — the tag-cut
> criterion binds to the ATTRIBUTION-AWARE family** (0 of 42 speakers lost,
> positive control 42/42, firing control 21 lost); the corpus proxy is reported
> as scale and adjudicated residual, **never as a gate**.
>
> **Task 0 is closed. Every task below is dispatchable.** Three things to carry
> rather than re-derive:
>
> 1. **Do not re-impose "the 579 goes to 0" or "265/92 → 0."** Both were written
>    by the coordinating thread before this pass measured them; A's and C's
>    answers supersede them. `579` has no referent (it is a corruption count on a
>    **widened**-table shape set, whose destroyed count is 1,704). The corpus
>    proxy **cannot decide 257 of its own 265** cases because CJK has no case
>    distinction.
> 2. **Do not chase below 172.** The only measured rule that gets there while
>    keeping nesting is `R4`, whose price is the suppression class; below that is
>    `R2`, which loses 601,392 characters of real speech. Both prices are
>    invariants the owner has already protected.
> 3. **`SPLIT` is not a failure signal for Tasks 1–7.** Un-swallowing a turn *is*
>    a split to an overlap classifier, so `0 SPLIT` against the pre-#2288 baseline
>    is unachievable by any correct rule. Bind to **text preservation** (0
>    characters, 0 mid-word) plus the adjudication that 85 % of fresh spans sit
>    next to a speech tag. Note the withdrawn `TEXT-LOSING` restatement: the
>    adversarial pass showed a truncate-and-resume rule cannot fail it, so it is
>    not a substitute criterion.
>
> *Original framing, retained because it is why the plan is shaped this way:*
>
> ## ⛔ (superseded) Task 0 — THREE OWNER DECISIONS ARE OWED BEFORE ANY CODE IS WRITTEN
>
> This plan does **not** start at Task 1. The design pass reached two rules it
> recommends and, in reaching them, found that **three stated acceptance items
> cannot be met as written** — one because its number does not refer to what it
> says it refers to, one because the criterion contradicts the fix, and one
> because its instrument counts legitimate gains. None is an implementation
> judgement call. All three are answered here and recorded in the design doc
> before Task 1 begins.
>
> **Decision A — text-preserving splits.** `0 SPLIT` against the pre-#2288
> baseline is unachievable by any rule that stops a container run swallowing the
> turn inside it, because un-swallowing *is* a split to an overlap classifier.
> **No substitute criterion is offered** — an earlier revision proposed
> `TEXT-LOSING` and the adversarial pass showed a truncate-and-resume rule
> cannot fail it. The question is the real one:
>
> > Is a split that loses no speech text, where **85 % of the new spans sit next
> > to a speech tag** (4,003 of 4,732) and 15 % are quoted words promoted to
> > their own span, an acceptable price for 1,231 paragraphs across seven
> > languages parsing turn-by-turn where they merged?
>
> *Refusing means Tasks 1–7 do not happen and #2315 closes as answer 3 in full.*
> **Tasks 8–9 (the tag-clause guard) are unaffected and should ship regardless.**
>
> **Decision B — the 396, not the 579.** "The 579 goes to 0" has no referent:
> `579` is a **corruption** count on a shape set defined by the **widened**
> table (the destroyed count there is 1,704). Measured as the ticket describes —
> each language's own `quotePairs` — the figure is **396 of 805**. The re-open
> bound takes it to **172**, at the cost of 20 `ru` regressions in M2's
> families. Accept a partial fix, or hold out for zero? *The only measured rule
> below 172 that keeps nesting is `R4`, whose price is the suppression class;
> below that is `R2`, whose price is 601,392 characters of real speech.*
>
> **Decision C — how the tag-cut criterion is stated.** The brief asks for "0
> gained runs truncating a tag span over the corpus, and the 265/92 re-measured
> to 0". That figure is **reproduced exactly** (265 across 92 paragraphs) and the
> guard takes it to 156 — but the residual is quoted titles and foreign phrases
> inside verb-bearing narration, not tag clauses naming a speaker, and the proxy
> **cannot decide 257 of its own 265** because CJK has no case distinction. Bind
> instead to the attribution-aware family — **0 of 42 speakers lost, positive
> control 42/42, firing control 21 lost** — and report the corpus proxy as scale
> and adjudicated residual rather than as a gate?
>
> Full framing, every number, and the price of each answer: the design's
> **"The decisions for the owner, and their price"**.
>
> - [ ] Put all three decisions to the repo owner with the tables above.
> - [ ] Record the answers in a `### Decided, <date>` subsection of the design
>       doc, in the shape M2's spec uses, and say what they supersede.
> - [ ] If Decision A is refused: skip Tasks 1–7, keep Task 7's residual pins as
>       the whole #2315 deliverable, and go straight to Task 8.

**Goal:** Fix two defects in the same acceptance loop.

- **Defect 1 (#2315)** — `scanQuoteRuns` destroys a turn when a paragraph
  re-opens a quote glyph it never closed. Live on `main` today, on correctly
  typeset input, using only a language's own `quotePairs`. **396 of 805 shapes.**
- **Defect 2 (found by the review gate on PR #2286)** — a run *gained* by the
  widening lands inside a **tag clause**, truncates it, and the adjacent real
  turn **loses its speaker**, so it is read in the wrong voice. The turn
  survives, so every turns-destroyed instrument reads 0. **21 of 42 constructed
  cases; 265 corpus opportunities.**

**Architecture:** Two independent changes, one in each half of `findQuoteRuns`
(`server/src/analyzer/dialogue-structure/parser.ts`), plus one small helper each.
No new field, no table change, no new source file.

- The **re-open bound** lives in `scanQuoteRuns` (`:390`) and changes behaviour
  on today's tables.
- The **tag-clause guard** lives in `findQuoteRuns`'s secondary-admission loop
  (`:363`) and is a **measured no-op** until #2286 lands, because every shipped
  `secondaryQuotePairs` is empty.

The guard needs the language's verb stems, which `findQuoteRuns`'s current
signature does not carry — it gains a `conv` parameter from its single call site
in `parseQuoteParagraph`, where `conv` is already in scope.

**Tech Stack:** TypeScript (Node, ESM), Vitest. Server suite only.

**Design of record:**
[`docs/superpowers/specs/2026-08-13-primary-pair-straddle-design.md`](../specs/2026-08-13-primary-pair-straddle-design.md).
**Read it before Task 2** — "Defect 1 — the mechanism" records why every
acceptance-order rule is structurally incapable of fixing 65 % of it,
"Candidate rules evaluated" records what each rejected rule costs, and
"Residuals" records what this does *not* fix, which Task 7 pins as tests.

**Consumer waiting on this:** PR
[#2286](https://github.com/dudarenok-maker/Castwright/pull/2286) is **held in
draft** until this lands. It moves nine pairs into `secondaryQuotePairs`; the
tag-clause guard is what makes that safe for attribution.

**Predecessors:** M1
[`2026-08-12-quote-delimiter-validity.md`](2026-08-12-quote-delimiter-validity.md)
(`e839a939`) and M2
[`2026-08-13-gap-seeded-straddle.md`](2026-08-13-gap-seeded-straddle.md)
(`69ced6c5`). Their invariants are inherited whole.

---

## Global Constraints

The acceptance items, **verbatim from the two briefs**:

1. The 579 goes to **0**, or answer 3 is chosen explicitly with a measured
   prevalence figure.
2. **Nesting still resolves to the OUTER run** in `en` and `zh`. Every prior
   candidate rule in this strand died on this invariant.
3. **M1's corpus result does not regress:** 938 clean repairs / 0 merged / 0 lost
   / 0 gained / 0 split, scored with `2288-metric.mts`'s overlap classifier.
4. **M2's criteria still hold:** 0 turns destroyed across all three sweep
   families, 0 of 21 on the suppression class.
5. Runs stay **disjoint**. #1601 stays fixed. `crossExamine`'s `dialogueOpen`
   contract untouched.
6. The **307-test** `dialogue-structure` + `narrator-default` suite stays green.
7. **0 gained runs truncating a tag span**, measured with an **attribution-aware**
   metric over the corpus — and the 265/92 figure re-measured to 0. The
   instrument must show it can *see* the class with a control that fires.

| item | status | where |
|---|---|---|
| 1 | **restated by Decision B** — 396 → 172; answer 3 for the residual, prevalence 5,267 of 239,725 (2.20 %) | Task 0, Task 7 |
| 2 | **met, and extended to depth 3** — nesting is cross-glyph *at depth 2*; depth 3 re-uses depth 1's glyph and the proviso is what refuses to fragment it | Tasks 3, 6 |
| 3 | **restated by Decision A** — 938 / 0 / 0 / 0 holds; `SPLIT` is 34 (English), all text-preserving | Task 0, Task 10 |
| 4 | **met** — pairwise: +1,762 / −20, **0 nesting regressions**, suppression **0 of 21** | Task 9 |
| 5 | **met** — half-open intervals; the truncated run ends where the next begins | Task 6 |
| 6 | **7 tests fail and must be re-baselined**, one of which exists to pin defect 1 | Task 5 |
| 7 | **restated by Decision C** — attribution family **21 → 0 of 42** with both controls firing; corpus proxy 265 → 156, residual adjudicated as legitimate gains | Task 0, Tasks 8–9 |

Three things the implementation must NOT do, all of which have been tried:

- **Do not reach for the cross-glyph case.** Every rule that bounds a run at an
  interior opener of a *different* class either breaks nesting outright (`R2`:
  601,392 characters of real speech lost, all four depth-3 anchors fail) or
  reintroduces the suppression class (`R4`: a quoted word in narration changes
  how a later turn parses).
- **Do not delete the truncated run.** It is emitted with `closeLen: 0` and its
  text is read as speech even when that text is narration — the reading of
  record. Deleting it loses 367,436 characters of real speech (mutant `dropRun`).
- **Do not make the tag-clause guard roster-aware.** Declining a secondary
  candidate whose interior is a cast name would need `findQuoteRuns` to take the
  `NameIndex`, and it fails on a turn that is a bare name
  (`«Антон!», сказала она.`). The sentence-boundary discriminator needs no roster.

---

## Task 1 — RED: the same-glyph re-open destroys a turn

**Files:** `server/src/analyzer/dialogue-structure/parser.test.ts`

- [ ] Add `describe('parser — #2315: the re-open bound')` with the three
      sub-mechanisms. All three FAIL before Task 2.

```ts
describe('parser — #2315: the re-open bound', () => {
  /* Case 1 — same-glyph re-open. `fr` has a single quote pair, so turn 2's
     opener is the same glyph as the stray. The per-opener scan resumes at the
     END of the accepted run, so turn 2 produces NO CANDIDATE AT ALL: no
     acceptance-order rule can reach this, which is why the fix is in the scan.
     Design § "Defect 1 — the mechanism", case 1. */
  it('fr: an unterminated « does not swallow the next turn', () => {
    expect(
      speechOf('«Bonjour», dit-il, regardant le «panneau de Faust. «Et toi», demanda-t-elle.', conventionsFor('fr')!),
    ).toEqual(['Bonjour', 'panneau de Faust. ', 'Et toi']);
  });
  it('es: the design’s worked example keeps both turns', () => {
    expect(speechOf('«Hola, dijo él. «Adiós», dijo ella.', conventionsFor('es')!)).toEqual([
      'Hola, dijo él. ', 'Adiós',
    ]);
  });
  /* The shape a real book produces when a CLOSING quote is typed as an OPENING
     one. `toEqual`, not `toContain`: a superset assertion cannot see a rule
     that ADDS a span, which is how an earlier candidate rule passed every
     anchor while inventing a spurious speech span. */
  it('en: a closing quote typed as an opening one keeps both turns', () => {
    expect(speechOf('“Hello,“ he said. “Goodbye,” she said.', conventionsFor('en')!)).toEqual([
      'Hello,', ' he said. ', 'Goodbye,',
    ]);
  });
});
```

- [ ] **Verify:** `cd server && npx vitest run src/analyzer/dialogue-structure/parser.test.ts -t '#2315'` — all three RED, and **check each failure message**: the `got` must be the merged single run the design quotes, not an empty list or a crash.

---

## Task 2 — GREEN: the re-open bound, plain form

**Files:** `server/src/analyzer/dialogue-structure/parser.ts`

Task 2 ships the **plain** form deliberately, so Task 3's test can go red
against it.

```ts
/** #2315. A quotation run may not contain a further occurrence of its OWN
    opening glyph: a quotation cannot re-open without having closed.

    Why this is not an acceptance rule. The per-opener scan resumes at the end
    of an accepted run (`pos = end.at + end.glyph.length` below), so a re-opened
    glyph inside that range never becomes a candidate at all — there is nothing
    for any ordering, election, or tiering rule to choose. 258 of the 396 shapes
    in the design's family are this case, and `fr`, whose table has one pair, is
    entirely this case. */
function reopenCut(line: string, interiorStart: number, endAt: number, open: string): number | null {
  const at = line.indexOf(open, interiorStart);
  return at >= 0 && at < endAt ? at : null;
}
```

```ts
      /* #2315: end the run at a re-open rather than letting it swallow the next
         turn. The run is still EMITTED, with no closing delimiter — deleting it
         destroys a turn, the harm this strand refuses; the spurious speech span
         it can produce is the accepted lesser harm. Resuming at `cut` is what
         lets the next turn be seen at all. */
      const cut = reopenCut(line, interiorStart, end.at, open);
      if (cut !== null && cut > interiorStart && cut < end.at) {
        candidates.push({ start, end: cut, openLen: open.length, closeLen: 0 });
        pos = cut;
        continue;
      }
```

- [ ] **Verify:** Task 1's three tests GREEN.
- [ ] **Verify the depth-2 nesting invariant did not move**, before going on:
      `speechOf('“He said ‘hi’ to me,” she explained.', en)` is
      `['He said ‘hi’ to me,']` and `「他说『你好』然后走了」` resolves to the outer run.

---

## Task 3 — RED then GREEN: the plain-prefix proviso (depth ≥ 3)

**Files:** `parser.test.ts`, then `parser.ts`

**This is the task the first revision of the design got wrong.** No language
nests a pair inside itself; they alternate by depth, so **depth 3 re-uses depth
1's glyph**. Task 2's form fragments every such turn.

- [ ] Add the RED tests. `main` is *already* wrong on these (it truncates at the
      depth-3 closer) — these do not ask for the right answer, they ask that the
      turn is not **fragmented into a one-word speech span**, which is a
      different and worse harm class.

```ts
  /* DEPTH 3 — the proviso's reason to exist. `main` already mis-parses these;
     the requirement is only that the fix does not make it worse by promoting a
     depth-3 quoted word to its own speech span, which the render then
     attributes and voices separately. Design § "Depth ≥ 3". */
  it.each([
    ['en', '“He told me, ‘She said “no” to him,’ and walked off,” Mary explained.', 'no'],
    ['zh', '「他说『她说「不」了』然后走了」她解释说。', '不'],
    ['ru', '«Он сказал „она сказала «нет» ему“ мне», объяснил он.', 'нет'],
    /* straight from the corpus: se/charlotte-perkins-gilman_moving-the-mountain */
    ['en', '“Mother had an old storybook,” Nellie remarked, “where somebody said, ‘You can’t always have your “druthers” ’—like home.”', 'druthers'],
  ])('%s: depth-3 nesting is not fragmented into a one-word span', (lang, body, fragment) => {
    expect(speechOf(body, conventionsFor(lang)!)).not.toContain(fragment);
  });
```

- [ ] **Verify:** all four RED against Task 2's form, and the `got` shows the
      container plus the one-word span. If it is anything else, stop.
- [ ] Add the proviso:

```ts
function reopenCut(
  line: string,
  interiorStart: number,
  endAt: number,
  open: string,
  openers: Set<string>,
): number | null {
  const at = line.indexOf(open, interiorStart);
  if (at < 0 || at >= endAt) return null;
  /* No language nests a pair inside itself — conventions alternate BY DEPTH, so
     depth 3 re-uses depth 1's glyph. An opener of any class between this run's
     own opener and the re-occurrence means a nest is in play, and the
     re-occurrence is a nesting delimiter rather than a re-open. Refusing to act
     whenever nesting is anywhere in play costs family shapes (164 -> 172) and
     no real turns. */
  for (const o of openers) {
    const k = line.indexOf(o, interiorStart);
    if (k >= 0 && k < at) return null;
  }
  return at;
}
```

- [ ] **Verify:** Tasks 1 and 3 all GREEN.
- [ ] **Verify the cost:** the design measured `+10–13 %` on `findQuoteRuns` over
      726,385 paragraphs. Re-run `scratchpad/s2315/perf.mts` and record it in the
      PR body; if it exceeds `+50 %`, stop and report rather than optimising.

---

## Task 4 — RED then GREEN: the closer-as-opener collision

**Files:** `parser.test.ts`

The sub-mechanism the ticket does not describe: **no stray glyph, no drift, both
turns well-formed**, and a turn still disappears.

```ts
  /* Case 3 — `ru`'s `“` closes turn 1 AND opens a pair, so the scan seeds a run
     there, that run is discarded for overlapping turn 1, and the cursor has by
     then passed turn 2's genuine `“`. Surfaced by the family instrument's own
     no-stray control, which exists to prove it does not cry wolf. */
  it('ru: turn 1’s own closing „…“ does not consume turn 2’s opener', () => {
    expect(speechOf('„Привет“, сказал он. “Пока”, сказала она.', conventionsFor('ru')!)).toEqual([
      'Привет', 'Пока',
    ]);
  });
```

- [ ] **Verify:** RED before Task 2 (`got` is `['Привет']`), GREEN after.

---

## Task 5 — re-baseline the seven tests this changes

**Files:** `parser.test.ts`, `tier-sweep.test.ts`

Measured by running the suite against a prototype patch. **Each edit carries its
reason in a comment**; a re-baselined number with no reason is indistinguishable
from a number bent to fit.

- [ ] `parser.test.ts` › `residual 1: the straddle inside a language's own PRIMARY pairs is untouched (design residual 1)` — **invert it.** This test exists to pin #2315; it is now the fix's own regression test. Keep the M2 cross-reference, add the #2315 one, do **not** delete it.
- [ ] `tier-sweep.test.ts` — six `tiered differs from ref on N scored shapes` counts: `F2 es 88→96`, `F2 ru 225→261`, `F2 en 114→133`, `F3 es 116→124`, `F3 ru 618→662`, `F3 en 258→277`. **Re-measure each rather than copying these numbers**, and record that the purpose (proving the tier is engaged) is unchanged.
- [ ] **Verify:** `cd server && npx vitest run src/analyzer/dialogue-structure src/analyzer/narrator-default.test.ts` — all green, total is 308 + the tests this plan adds, nothing skipped or deleted.

---

## Task 6 — the inherited invariants, asserted not assumed

**Files:** `parser.test.ts`

```ts
  it('runs stay disjoint when a run is truncated at a re-open', () => {
    const body = '«Hola, dijo él. «Adiós», dijo ella.';
    const spans = parseChapterStructure(body, buildNameIndex([], conventionsFor('es')!))
      .flatMap((p) => p.spans)
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < spans.length; i++) expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
  });

  it('a truncated run never produces an empty speech span', () => {
    /* `cut > interiorStart` guarantees this; the degenerate `««` input falls
       through to the shipped behaviour instead. */
    expect(speechOf('««Hola», dijo él.', conventionsFor('es')!).every((s) => s.length > 0)).toBe(true);
  });
```

- [ ] **Verify:** the existing M1 and #1601 tests still pass untouched —
      `-t 'M1'` and `-t '1601'`. Do not edit them.

---

## Task 7 — pin the residual AS a residual

**Files:** `parser.test.ts`

The cross-glyph and symmetric-delimiter straddles are **not** fixed and that is
the recommendation, not an oversight. Pin them so a later change cannot silently
alter them in either direction.

```ts
describe('parser — #2315 residuals, accepted (design § Residuals)', () => {
  /* 1a — the CROSS-GLYPH straddle. This interval geometry is byte-for-byte a
     legitimate nest, and it occurs in 5,267 of 239,725 real corpus paragraphs
     where it is overwhelmingly correct. Every rule that acts on it was
     measured: `R2` removes 601,392 characters of real speech; `R4` lets a
     quoted word in narration change how a later turn parses. */
  it('residual 1a: a cross-glyph straddle still swallows the next turn', () => {
    expect(
      speechOf('«Hola», dijo él, mirando el “cartel de Fausto. «Y tú», preguntó ella, cerca de la galería”.', conventionsFor('es')!),
    ).toEqual(['Hola', 'cartel de Fausto. «Y tú», preguntó ella, cerca de la galería']);
  });
  /* 1b — the SYMMETRIC delimiter. With `"` the opener and the closer are the
     same character, so an odd count means one is unpaired and nothing local can
     say which. Irreducible: even `R2`, the ceiling, leaves this class. */
  it('residual 1b: a stray ASCII " still swallows the next turn', () => {
    expect(
      speechOf('“Hi”, he said, passing the "Faust poster. "Bye", she said, near the gallery".', conventionsFor('en')!),
    ).toEqual(['Hi', 'Faust poster. ', ', she said, near the gallery']);
  });
  /* 3 — depth >= 3 nesting is STILL mis-parsed; `main` truncates at the
     depth-3 closer and this change leaves that untouched. Pinned so the
     pre-existing defect is visible rather than assumed fixed. */
  it('residual 3: depth-3 nesting is still truncated at the depth-3 closer', () => {
    expect(speechOf('“He told me, ‘She said “no” to him,’ and walked off,” Mary explained.', conventionsFor('en')!))
      .toEqual(['He told me, ‘She said “no']);
  });
});
```

- [ ] **Verify:** all GREEN, and **re-measure every expectation from the real
      parser** rather than trusting the strings above — they came from the
      design's prototype, not from shipped code.

---

## Task 8 — RED: a gained secondary run cuts a tag clause and costs a speaker

**Files:** `server/src/analyzer/dialogue-structure/parser.test.ts`

**Defect 2.** This is the first test in this strand that reads the `speaker`
field. Every existing instrument builds `buildNameIndex([], conv)` — an empty
roster — so `speaker` is never populated and never compared; "0 lost / 0 merged /
0 split" is silent about attribution **by construction**.

```ts
describe('parser — #2315 defect 2: a gained secondary run must not cut a tag clause', () => {
  const ru = conventionsFor('ru')!;
  const tiered = { ...ru, secondaryQuotePairs: [['‘', '’']] as Array<[string, string]> };
  const roster = [{ id: 'anton', name: 'Антон' }];
  const speakersOf = (body: string, conv: typeof ru) =>
    parseChapterStructure(body, buildNameIndex(roster as never, conv))
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => [body.slice(s.start, s.end), s.speaker?.characterId ?? null]);

  /* POSITIVE CONTROL, and it must come first: without it a zero below could
     mean "the metric cannot read a speaker at all". */
  it('control: with no secondary pair the turn is attributed', () => {
    expect(speakersOf('«Привет», сказал ‘Антон’.', ru)).toEqual([['Привет', 'anton']]);
  });

  it('the tag keeps its name when the tier is declared', () => {
    expect(speakersOf('«Привет», сказал ‘Антон’.', tiered)).toEqual([['Привет', 'anton']]);
  });

  /* MUST STILL WORK: a genuine secondary-convention SECOND TURN, which the
     guard must admit. The discriminator is the sentence boundary after the
     tag, not the verb. */
  it('a genuine secondary-convention second turn is still recovered', () => {
    expect(speakersOf('«Привет», сказал Антон. ‘Пока’, сказал Антон.', tiered)).toEqual([
      ['Привет', 'anton'], ['Пока', 'anton'],
    ]);
  });
});
```

- [ ] **Verify:** the control and the third test pass on unmodified `main`; the
      second is RED, and its `got` shows `[['Привет', null], ['Антон', null]]` —
      the tag truncated and the speaker gone. Any other `got` means the fixture
      is wrong.

---

## Task 9 — GREEN: the tag-clause guard

**Files:** `server/src/analyzer/dialogue-structure/parser.ts`

`findQuoteRuns` gains a `conv` parameter from its single call site in
`parseQuoteParagraph`, where `conv` is already in scope.

```ts
/** Sentence-final punctuation, including the CJK full-width forms — without
    them `zh`/`ja` read every tag as one unbroken clause. */
const SENTENCE_END = /[.!?…。！？；;]/u;

/** #2315 defect 2. A gained SECONDARY run that lands INSIDE a tag clause
    truncates it, `findRosterName` never reaches the name, and the adjacent real
    turn loses its speaker — so it is read in the wrong voice. The turn
    survives, so every turns-destroyed instrument in this strand reads 0.

    The discriminator is a SENTENCE BOUNDARY, not a verb alone:
      `, сказал `      verb, no sentence end -> inside the tag clause -> decline
      `, сказал он. `  verb, sentence end    -> a new sentence, a turn -> admit
      ` en la portada. ` no verb             -> narration; M2's suppression
                                                class                  -> admit

    The window is the CLAUSE, not the whole gap: scoping it to the gap was
    measured and only moved the corpus figure 265 -> 165, because a long
    paragraph's gap contains earlier sentence-final punctuation. Secondary-tier
    only, so it is a measured no-op on every shipped table. */
function cutsATagClause(line: string, cand: QuoteRun, primaryRuns: QuoteRun[], conv: LanguageConventions): boolean {
  const stems = [...conv.speechVerbStems, ...conv.beatVerbStems];
  let from = 0;
  for (const r of primaryRuns) if (r.end <= cand.start && r.end > from) from = r.end;
  for (let i = cand.start - 1; i >= from; i--) {
    if (SENTENCE_END.test(line[i])) { from = i + 1; break; }
  }
  const clause = line.slice(from, cand.start).toLowerCase();
  return stems.some((s) => clause.includes(s.toLowerCase()));
}
```

…and one line in the secondary-admission loop, after the straddle test:

```ts
    if (cutsATagClause(line, c, primaryRuns, conv)) continue;
```

- [ ] **Verify:** Task 8's second test GREEN, the other two still GREEN.
- [ ] **Verify the no-op claim rather than asserting it.** With every shipped
      table (all `secondaryQuotePairs` empty) the guard must change nothing:
      re-run `s2315/family.mts`, `s2315/anchors.mts` and
      `s2315/corpus.mts … A` with and without it and require **identical**
      output (172, 19/22, `938 / 0 / 0 / 0 / 0` + SPLIT 34).
- [ ] **Verify M2's suppression class is untouched:** `s2315/m2check.mts` must
      still read `SUPP 21 shapes, 0 destroyed, 0 regressed`.

---

## Task 10 — the generated sweeps, with controls that can go red

**Files:** `server/src/analyzer/dialogue-structure/reopen-sweep.test.ts` (new)

M2's committed sweep passed under three separate mutations of the rule it existed
to pin, and `sweep-six-langs`'s "0 destroyed of 51,608" is a **constant** — it
reads 0 with both tier guards deleted. **Do not reuse that family as a gate.**

- [ ] Port the design's 805-shape family (`scratchpad/s2315/family.mts`) into a
      committed test through the **real** parser — no env vars, no patched module
      copies, no reimplementation. Restrict to `de`/`ru`/`en` (104 + 150 + 54 of
      the 396) if the whole set exceeds ~2 s; **never thin the cross-product
      within a language.**
- [ ] Port the **attribution family** (`scratchpad/s2315/attrib.mts`) with its
      two controls. This is the gate for defect 2.
- [ ] Assertions, and the controls are what make the first one mean anything:
  - `expect(destroyed).toBe(<measured>)` per language, and
    `expect(speakersLost).toBe(0)`.
  - **positive control:** the attribution family with no secondary pair must
    attribute every case (42 of 42).
  - **firing control:** the same family with the guard bypassed must lose 21.
  - **no-stray control:** family shapes with no stray opener must destroy 0.
- [ ] **Verify by mutation, and record the output in the PR body.** Make each
      change, confirm RED, revert:
      (a) `pos = cut` → `pos = end.at + end.glyph.length` (family → 396);
      (b) drop the truncated run instead of pushing it;
      (c) remove the proviso loop in `reopenCut` (depth-3 tests fail);
      (d) remove the `cutsATagClause` call (attribution → 21 lost);
      (e) scope the guard's window to the gap instead of the clause.
      **A mutation that leaves the suite green is a defect in this task.**

---

## Task 11 — corpus re-verification, docs, ship

- [ ] Re-run the design's corpus instruments against the **shipped** code, not
      the prototype: `METRIC_LIB=1 tsx s2315/corpus.mts <rule> both`,
      `METRIC_LIB=1 tsx s2315/adjudicate.mts <rule>`, `tsx s2315/tagcut.mts <rule>`,
      `tsx s2315/attrib.mts <rule>`. Expect ARM A `938 / 0 / 0 / 0 / 0` with
      `SPLIT 34`; `1,231 changed / 1,231 text-preserving / 0 characters lost / 0
      mid-word`; tag-cut proxy `265 → 156`; attribution `0 of 42`. **If any
      figure differs from the design, stop and report** — the prototype and the
      shipped code have diverged.
- [ ] `npm run test:server` and `npm run verify:fast:branch`.
- [ ] Design doc → `status: stable`; fill this plan's Ship notes.
- [ ] `docs/release-notes-next.md` (technical, PR-refed) **and** `RELEASE_NOTES.md`
      (brand voice, in-progress section). The user-visible delta is real and
      twofold: turns that were read as part of the previous speaker's line are now
      their own turn in seven languages, and a line whose tag quotes a character's
      name keeps that character's voice.
- [ ] **On-box acceptance:** a row is owed. The change alters run boundaries on
      real books in seven languages, and whether a truncated narration span
      *sounds* acceptable when voiced is not something any test here answers. Add
      the row to `docs/testing/onbox-acceptance-register.md`, the live view, and
      this plan, per CLAUDE.md's before-shipping step 3. Say what to observe:
      generate a chapter of a `zh` or `ja` book containing a continuation
      paragraph (the design quotes two) and confirm the recovered inner turn is
      voiced as its own turn with its own cast voice.
- [ ] **Unblock the consumer:** comment on PR
      [#2286](https://github.com/dudarenok-maker/Castwright/pull/2286) that the
      tag-clause guard has landed, and take it out of draft.
- [ ] PR body: `Closes #2315`, the measured tables from the design's Summary, the
      mutation outputs from Task 10, and an explicit line naming the accepted
      residuals and the three Task 0 decisions.

---

## Ship notes

Implemented Tasks 1–11 in the `fix/server-2315-reopen-bound` worktree, off
`main` at `090168a5`. All measured figures reproduced against the shipped
code exactly, confirmed by an over-and-above equivalence check
(`scratchpad/s2315/equivalence.mts`, re-pointed at this worktree): the
engine.mjs prototype of `R1c_plainPrefix+G` is byte-identical to the shipped
`parser.ts` over all 1,190,634 corpus paragraphs (`DIFFERING 0`), so every
figure below is a genuine measurement of the shipped code, not the prototype.

- Family: **172 of 805** (de 24, en 30, es 4, fr 0, ja 4, ru 92, zh 18;
  no-stray control 0 destroyed everywhere).
- Anchors: **19/22** (the three residual cross-glyph/symmetric-delimiter
  failures, as designed).
- Arm A (140-book English, M1's tuple): **938 / 0 MERGED / 0 LOST / 0
  GAINED**, SPLIT 34 — `NOT MET` on the literal `0 SPLIT` bar per Decision A,
  met on every other clause.
- Arm B (7 languages, own tables): **1,231 changed / 1,231 text-preserving /
  0 characters lost / 0 mid-word**.
- Attribution family: positive control 42/42, shipped guard **0/42** lost,
  firing control (mutation (d)) **21/42** lost — matches the design exactly.
- M2 pairwise (F1/F2/F3/SUPP): **+1,762 repaired / −20 regressed**, 0 nesting
  regressions, suppression 0 of 21 — matches the design exactly.
- **Tag-cut corpus proxy — DIVERGES from the design doc, and this is not a
  bug.** The design's cited "156 across 71" is `RULE=shipped+G` — the
  tag-clause guard measured **in isolation**, without the re-open bound.
  What's actually shipped is both rules together
  (`R1c_plainPrefix+G`), which measures **162 across 76**: combining the
  two rules shifts primary-run boundaries in the `main`-table baseline the
  proxy diffs against, which moves where a handful of tag spans fall. Both
  numbers reproduced directly (`s2315/tagcut.mts shipped+G` → 156/71 exactly;
  `s2315/tagcut.mts R1c_plainPrefix+G` → 162/76). Doesn't change the
  criterion this residual is measured against — Decision C already binds
  acceptance to the attribution-aware family (0 of 42), not this proxy — so
  no re-decision is owed, only the correction that 162/76, not 156/71, is
  the number that describes what shipped.
- Task 10 mutations (a)–(e): all five went RED for the predicted reason, all
  five reverted; full detail in the PR body and the implementation report.
- On-box acceptance: row **D3** added to
  [`docs/testing/onbox-acceptance-register.md`](../../testing/onbox-acceptance-register.md)
  (generate a `zh`/`ja` chapter with a continuation paragraph; confirm the
  recovered inner turn voices as its own turn in its own cast voice). The
  live view is **not** updated by this PR — owed to the coordinating/shipping
  thread, which owns the pre-publish comparator run.
- Design doc moved to `status: stable` in the same diff.

Ship date / merge SHA: *(filled by the coordinating thread at merge)*.
