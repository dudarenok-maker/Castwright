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
  live view was mirrored by the coordinating thread in `520bc81f`, which owns
  the pre-publish comparator run: comparator green against the live page
  (68 owed / group D 2 rows) before publishing, then published to the
  register's recorded artifact URL at **69 owed / group D 3 rows**.
- Design doc moved to `status: stable` in the same diff.

### Round 2 — PR #2340 Premium review gate, 3 correctness fixes + 4 nits

The mandatory review gate found the interval arithmetic, the mutation
sensitivity, and the 162/76-vs-156/71 correction above all sound, but found
the tag-clause guard itself **polarity-inverted for verb-before-quote
languages (zh/ja)** — the half of this PR that exists to unblock #2286 — plus
one robustness gap and one perf regression it introduced. All fixed in the
same branch/commit history (not a new PR), TDD throughout: every new test
below reproduced the reviewer's exact failure shape RED before the fix.

1. **MAJOR — `cutsATagClause` was polarity-inverted for zh/ja, declining
   93.7% of one real Chinese book's (`pg/zh/23835.txt`) speech spans.** The
   guard's clause-before-candidate model assumes a tag ATTRIBUTES an
   already-captured turn (Latin trailing-tag: `"Hi," said Anton`) — correct
   for that shape, backwards for zh/ja's canonical VERB-then-quote order
   (`他说，"你好"`), where the verb INTRODUCES the turn rather than naming an
   already-parsed one. Compounded by zh/ja's single-character verb stems
   matching as substrings inside unrelated words with no word boundary (道
   inside 道路/知道, 息 inside 息子, 笑 inside 微笑/苦笑い). **Fix, not a
   per-language property**: `cutsATagClause` now requires a PRIMARY run to
   actually precede the candidate before it even evaluates a verb — the
   guard's own docstring always claimed this ("the adjacent real turn loses
   its speaker"), the original implementation never checked it.
   **CORRECTED, PR #2340 round 2 (was stated wrong here — see "Round 2,
   continued" below for the measurement and the two things this claim got
   wrong):** does not change behaviour on the CONSTRUCTED Latin defect-2
   family (a primary run always precedes by construction there, so the
   family stays at 0/42 lost), fixes every zh/ja case in the corpus because
   the affected book's dialogue paragraphs carry no primary-tier quote at
   all — **but it is not fully language-agnostic and it is not a complete
   fix**: on real es/fr corpus paragraphs it measurably changes 271 spans
   across 203 paragraphs (reduced over-suppression, not lost speakers), and
   it leaves a real, measured gap — any paragraph typed WHOLLY in a
   secondary-tier convention, in any language including Latin ones, still
   has no primary run for the guard to check against, so defect 2 stays live
   there. New committed regression: a generated CJK leading-tag/false-cognate
   family (`reopen-sweep.test.ts`) plus 6 unit tests (`parser.test.ts`),
   including one confirming a genuine leading-tag turn is BOTH admitted and
   correctly attributed end-to-end via the existing narration→tag mechanism,
   unmodified.
2. **MEDIUM — the `SENTENCE_END` backward scan was defeated by any
   non-terminal `.`, `;` or `…`, re-opening defect 2 itself.** A decimal
   point (`3.30`), an abbreviation period (`Mr.`), a semicolon, or a
   mid-clause ellipsis reset the clause boundary past the verb, un-declining
   a candidate that should have stayed declined. Original fix:
   `isGuardSentenceEnd`
   excludes a `.` with digits on both sides (decimal) or a short
   UPPERCASE-led run of letters before it (abbreviation-shaped — keyed on
   capitalisation specifically, so an ordinary short lowercase word like
   `он.`/`it.` still counts, which the existing "second turn recovered" test
   already pinned and still passes); `;`/`；` are dropped entirely (a
   semicolon joins one sentence's clauses, it doesn't end one); `…` is
   dropped entirely too (indistinguishable from a mid-clause pause right
   before this guard's own candidate — errs toward extending the clause, the
   same "never delete, extend instead" bias as the rest of this file). 4 new
   unit tests, all RED before, GREEN after. **The abbreviation-shaped
   exclusion above was ITSELF removed one review pass later — see finding F1
   under "Round 2, continued" below; the decimal-point exclusion and the
   `;`/`…` removals described here are unaffected and still stand as
   written.**
3. **MEDIUM — `pos = cut` made `scanQuoteRuns` quadratic in paragraph length
   on the synchronous analyzer path.** A truncated run resumes only 2 chars
   past the re-open, so N consecutive same-glyph re-opens each pay a full
   O(remaining-length) closer scan: O(n²). Measured pre-fix,
   `'“a'.repeat(N)+'”'`: len 64,001 → 4,625ms (×10,381 over pre-#2315).
   Fix: `REOPEN_CHAIN_LIMIT = 200` caps consecutive re-open cuts per opener
   class before falling back to the pre-#2315 accept-and-resume behaviour —
   converts the adversarial case to bounded-linear without touching the
   closer-search machinery. Real quote density (~1/75 chars, per the
   review's own representative-damage measurement) never approaches the cap.
   New committed perf regression test at the same 4 lengths, threshold 750ms
   (generous, to avoid CI flakiness — the point is bounding catastrophic
   growth, not a specific figure).
4. **4 nits, all applied**: `cutsATagClause` now calls the existing
   `hasStem()` helper instead of re-implementing it with a redundant
   per-stem `.toLowerCase()`; the M2 `findQuoteRuns` JSDoc (which had been
   pushed off its function by the `SENTENCE_END`/`cutsATagClause` insertion)
   moved back directly above `findQuoteRuns`; the duplicate "es worked
   example" test removed from the `#2315: the re-open bound` describe block
   (the M2-era "residual 1" test the plan required keeping already pins the
   identical input/output); `reopen-sweep.test.ts`'s "generates a non-trivial
   shape set" now pins the exact measured count (de 176 / en 117 / ru 336)
   instead of `toBeGreaterThan(0)`.

**Mutation verification (red before, green after), each fix reverted
individually and reconfirmed on the FULL suite before moving to the next:**

| fix | reverted to | result |
|---|---|---|
| 1 (polarity) | `precededByPrimaryRun` gate removed | RED — 7 tests fail (PR #2340 round 2 nit 2 corrected the split: the finding-1 describe block holds 7 `it` cases and 5 of them fail — its control and "a trailing name-tag … is still declined" case are *designed* to stay green under this mutation, and do — plus 2 tests in the generated CJK family, `every genuine turn survives`/`…is also correctly attributed`) |
| 2 (clause boundary) | `isGuardSentenceEnd` → naive `/[.!?…。！？；;]/u.test` | RED — all 4 new unit tests fail, each showing the candidate re-admitted as its own null-speaker span |
| 3 (perf) | `REOPEN_CHAIN_LIMIT` cap removed | RED — len 32,001/64,001 perf tests fail at ~1,000–4,450ms vs the 750ms bound (reproducing the review's own ~4,625ms figure at len 64,001) |

**Corpus re-pricing against #2286's actual tables (not the proxy), the
review's own explicit request.** New instrument
`scratchpad/s2315/reprice-tagcut.mts` (not `tagcut.mts`, which counts a
different population — gained runs overlapping a `main` tag span, not
genuine guard declines) compares `wide/` (this worktree's fixed code +
#2286's real `secondaryQuotePairs`) against `wide-noguard/` (byte-identical,
guard call removed) over all 726,385 wide-table corpus paragraphs:

```
DECLINED SECONDARY SPANS (guard on vs guard off): 101 across 48 paragraphs
lang   paras   declined-paras   declined-spans
de     63941                0                0
en    389020                0                0
es     89854                0                0
fr     85206                0                0
ja      3187                1                1
ru      2073                0                0
zh     93104               47              100
```

Down from the review's measured **7,438 across 1,489** (pre-fix). The
review's own flagged book, `pg/zh/23835.txt` (7,090 of 7,570 spans falsely
declined pre-fix, 93.7%), now measures **0 declined of 7,570** — guard-on and
guard-off produce byte-identical output. The 101-span residual is
concentrated in one classical-Chinese novel (`pg/zh/24264.txt`, 紅樓夢) whose
dialogue paragraphs DO carry primary-tier quotes elsewhere in the same
paragraph — the one shape this fix does not fully resolve (a second genuine
turn, introduced by a colon after an EARLIER primary run in the same
paragraph, can still trip the verb check) — named here as a known,
much-smaller residual rather than claimed away. Family/anchors/Arm A
re-confirmed unmoved by these three fixes (172/805, 19/22, both re-measured
against the real code after the round-2 changes) — expected, since the guard
is inert on `main`-only tables and the perf cap never fires below hundreds of
consecutive re-opens.

**New perf numbers** (`'“a'.repeat(N)+'”'`, same four lengths):

```
len    8001 : 8.9ms   (was 79ms)
len   16001 : 16.2ms  (was 279ms)
len   32001 : 26.2ms  (was 1051ms)
len   64001 : 53.7ms  (was 4625ms)
```

Linear, not quadratic (roughly doubling per doubling of N, not
quadrupling) — an 86× improvement at the largest measured length, and the
corpus's own longest real paragraph (165,173 chars) now extrapolates to
~140ms rather than ~30s.

### Round 2, continued — a second review pass on PR #2340: 1 fix (F1), 1 filed decision (F2), 4 nits

**F1 — MEDIUM, fixed.** The abbreviation-shaped exclusion added above (item
2) is a NAME filter, not a title filter: a short capitalised name (`Ana.`,
`Jean.`, `Иван.`) matches the identical `\p{Lu}\p{L}{0,3}` shape as `Mr.`/
`Dr.`, so it ALSO stopped a genuine period from ending a clause — and unlike
the title-abbreviation case, this one loses a SECOND TURN entirely rather
than merely over-declining. Reproduced exactly: `«Hola», dijo Ana. "Adiós",
dijo Ana.` (and the `fr`/`ru` equivalents) lost `Adiós`/`Au revoir`/`Пока` as
a speech span altogether. Measured with a new short-name replica of the
42-case attribution family (`es`/`fr`/`ru`/`en`, 22 cases, 11 carrying a
genuine second turn): **11 of 11** second-turn shapes lost, before the fix.
Corpus prevalence of the abbreviation shape itself: **0 of 726,385**
paragraphs. **Fix: removed the abbreviation exclusion outright**, keeping
only the decimal-point one — the corpus cost of removing it is zero
(nothing measured depends on it) and the family cost of keeping it was 11 of
21 real second-turn losses. `“Hi,” said Mr. «Anton».` (`parser.test.ts`) is
re-pinned as a known, accepted residual instead of silently reworked to keep
passing. **The metric itself was also fixed**, not just the heuristic: the
existing "0 of 42" test only ever checked the FIRST turn's speaker, which is
a primary run this bug structurally can't touch either way — it read 0
whether or not the second turn survived, which is exactly why it didn't
catch this. It's now "0 turns lost … 63 turn-checks: 42 first-turn +
21 second-turn", checking both.

Mutation (abbreviation exclusion reinstated): **RED**, 2 tests fail — the
`"Mr."` residual test (now expecting the OLD "both attributed" shape, which
no longer holds) and the short-name family's comprehensive check, with
exactly **11** second-turn failures listed by name — es ×2, fr ×2, ru ×4,
en ×3, matching the measured figure precisely. Reverted, full suite green
(383 tests before this fix → 386 after, +3 for the new short-name family's
2 tests and the "generates the 22-case family" count pin).

**F2 — MEDIUM, NOT fixed — filed as
[#2346](https://github.com/dudarenok-maker/Castwright/issues/2346).** The
`precededByPrimaryRun` precondition (F1 of round 1, the MAJOR fix) turns the
guard off entirely for a paragraph with no primary-tier run ANYWHERE — which
is exactly the population a book typed wholly in a secondary-tier convention
produces, i.e. exactly what #2286 exists to support:

```
‘Привет’, сказал ‘Антон’.        (ru, secondary ‘’)  shipped: Привет=NULL | Антон=NULL
«Hi», said «Anton».               (en, secondary «»)  shipped: Hi=NULL | Anton=NULL
Said «Anton», "Hi there."         (en, leading tag)   shipped: Anton=NULL | Hi there.=NULL
```

**Two claims above were false as stated, corrected in place (item 1):** "does
not change behaviour on any Latin defect-2 shape" is true only of the
CONSTRUCTED family (a primary run always precedes there by construction);
measured against #2286's real tables it changes **271 non-CJK spans across
203 real paragraphs (es 264, fr 7)** — quoted phrases in narration the guard
used to suppress and now admits, reduced over-suppression rather than lost
speakers, but a real behaviour change nonetheless. And "language-agnostic" is
true of the MECHANISM, not of the residual it leaves: the residual this
decision is about is not CJK-specific either — it hits any language whose
dialogue happens to be typed wholly in a secondary pair.

**Not fixed, because the obvious repair reintroduces round 1's MAJOR
finding.** Passing `out` (primary + already-accepted secondary runs) instead
of `primaryRuns` fixes all three rows above and keeps every round-1 CJK unit
case green — but at corpus scale it **re-declines 5,892 spans in
`pg/zh/23835.txt`**, the same book round 1 fixed. The real discriminator has
to separate "the verb belongs to the PRECEDING turn's trailing tag" (Latin —
decline) from "the verb introduces the FOLLOWING turn" (CJK, and the `ru`
row above — admit), which is word-order typology with more than one
defensible encoding (a per-language tag-position property on
`LanguageConventions`; the punctuation immediately before the candidate —
`：`/`、` vs `,`; something else) — not guessed here, filed as #2346 instead.

**Condition, stated correctly (PR #2340 round 3 finding C2 — this doc, the
design doc, `parser.test.ts` and #2346 all understated it before this
correction):** `precededByPrimaryRun` is set only for a primary run whose
`end <= cand.start` — the real condition is **"no primary run ENDS BEFORE
this candidate"**, not "no primary run anywhere in the paragraph". A
paragraph can carry a primary run and still be fully inert for a candidate
that happens to sit before it — `Said «Anton», "Hi there."` (the third pinned
case below: `"…"` **is** an `en` primary pair, so this paragraph does have a
primary run, just one that comes after «Anton» rather than before it).
Measured at the RUN level over the same corpus (new instrument
`scratchpad/s2315/reprice-f2-runlevel.mts`, cross-referencing `wide` speech
spans against `main` primary-run boundaries directly, rather than the
paragraph-level "main finds zero speech" proxy `reprice-f2-exposed.mts`
used): **2,221 inert paragraphs, 8,802 inert secondary runs** — of which the
paragraph-level definition catches only **2,202**, an under-count (paragraphs
where a primary run exists but sits AFTER an inert candidate aren't counted
paragraph-level, but ARE run-level). The direction is conservative — it
doesn't argue against merging — but "typed wholly in a secondary-tier
convention" is the wrong description of the population; corrected everywhere
it appeared to "no primary run precedes the candidate".

Measured exposed population against #2286's actual tables (instrument
`scratchpad/s2315/reprice-f2-exposed.mts`, reusing the `wide`/`wide-noguard`
trees, paragraph-level as above): **2,202** real corpus paragraphs carry a
secondary-tier-only turn with no primary run before it; a raw proxy (two
secondary speech spans with a verb-bearing gap directly between them) fires
on **1,164** of them:

```
lang    paras   exposed   proxy-fires
de      63941         0            0
en     389020         0            0
es      89854       787           69
fr      85206        14            1
ja       3187         1            0
ru       2073         0            0
zh      93104      1400         1094
```

**PR #2340 round 3 finding C1 (BLOCKING, corrected here) — the raw 1,164 is
not the harm figure and overstates it by ~100×.** `speech → tag → speech`
fires on the harmful shape (a NAME inside the secondary quotes) **and** on an
ordinary correct two-turn paragraph where each turn carries its own leading
tag — the proxy cannot tell them apart, and for 94% of its mass it fires on
the SECOND kind. Classifying the second span of each firing (generous upper
bound: short, unpunctuated, ≤3 words / ≤5 CJK characters counts as
NAME-shaped) gives **≤21 of 1,164 (1.8%)** — es 12/69, fr 1/1, zh 8/1094 —
and manual inspection narrows that further: the flagged CJK "names" read as
`怪物` ("monster"), `官球台`, `光照天下` — quoted terms, not speaker names, and
the concrete `pg/zh/23835.txt` paragraph this proxy counts as "would lose a
speaker" is `…高颎道："…"不肯发遣。高德弘道："…"` — **two correctly-parsed turns,
each with its own leading tag, nothing loses a speaker.** Making the guard
fire there is exactly the 5,892-span regression the naive `out`-based repair
above was rejected for — this paragraph is evidence AGAINST that repair, not
for the harm of leaving it unfixed. **Do not target the raw 1,164 for
reduction; #2346 says this explicitly.** The corrected, classified figure —
≤21 of 1,164, generously — is what to cite as F2's measured cost, not the raw
proxy count.

**94% (1,094 of 1,164) is one book, `pg/zh/23835.txt`** — round 1's own
flagship example — but per the classification above, only ≤8 of that
book's 1,094 firings are plausibly the harmful shape; the other 1,086+ are
correctly-declined-nothing false positives of the proxy. **The `es` figure's
"sampled and confirmed genuinely Spanish" claim was also wrong (same PR
finding C1)**: two of the ~10 contributing books — `pg/es/16119.txt` and
`pg/es/23206.txt`, together 8 of the 69 `es` firings — are English-language
Gutenberg works *about* Spanish literature, not Spanish-language books; their
own printed corpus excerpts read in English ("The accounts of the printing
of two Doctrinas…", "As has been already observed, the dramas of Juan del
Encina…"). Small in magnitude, but the claim was stated as verified and
wasn't. Full detail, the discriminator question, and the candidate
encodings: issue #2346, corrected to carry the classified figure and an
explicit "do not target the raw proxy" note.

**Pinned as a known, tracked gap** (`parser.test.ts`, describe block
re-titled "#2315 / #2346 known gap: the tag-clause guard is inert when no
primary run precedes the candidate" — PR #2340 round 3 finding C2 corrected
the title too): the three rows above, asserted against their CURRENT (buggy)
output, labelled to fail loudly and be deleted — not adjusted — the moment
#2346 lands a fix.

**4 nits (round 2), all applied:** `REOPEN_CHAIN_LIMIT` moved from inside the
per-opener loop body to module level, alongside the file's other tunables;
the mutation-table row above corrected (5 unit + 2 family, not "6 unit +
family"); `reopenChain` now resets on the `end === null` continue path too,
consistent with the accept path; the release note's and this doc's own
"decimal point, an abbreviation period, and a semicolon" summaries corrected
for both F1's removal and the missing `…` mention.

### Round 3 — a third review pass on PR #2340: docs-and-issue-only, no code change

The code was found sound (F1's removal confirmed corpus-neutral — 0
paragraphs change on #2286's tables with the exclusion reinstated and
diffed against shipped span signatures over all 726,385 paragraphs — and
both new gates confirmed genuinely discriminating). Three corrections, all
documentation/issue text: **C1 (blocking)** — the F2 "would-lose-a-speaker:
1,164" figure overstated the harm by ~100×, corrected above and in #2346 to
the classified ≤21-of-1,164 figure with an explicit "do not target the raw
proxy" note, and the `es` "sampled and confirmed genuinely Spanish" claim
corrected (2 of ~10 contributing books, 8 of 69 firings, are English-language
works *about* Spanish literature). **C2 (disclose)** — F2's condition was
mis-stated as "no primary run anywhere in the paragraph"; corrected
everywhere (this doc, the design doc, `parser.test.ts`'s describe-block
title, #2346) to "no primary run precedes the candidate", with the run-level
measurement (2,221 paragraphs / 8,802 runs, vs. the paragraph-level 2,202)
disclosing the paragraph-level figure as a conservative under-count. **C3
(disclose)** — `RELEASE_NOTES.md`'s brand-voice line made an unconditional
promise F2 falsifies; qualified in place, and `docs/release-notes-next.md`
now names #2346. **N1** — "11 of 21" corrected to "all 11 of 11" (the
short-name family's own second-turn count) in `parser.ts` and
`parser.test.ts`; the 21 was the 42-case family's second-turn count, wrongly
carried over. **N2** — the `scratchpad/s2315/{main,wide,wide-noguard}`
copies used for every corpus measurement in this document predate the
`reopenChain = 0` reset on the `end === null` path (a round-2 nit fix,
provably behaviour-neutral: once an opener class hits `end === null`, no
later occurrence of that class can take an accept-or-cut path, so the
counter is dead from there) — no re-measurement owed, noted here as
provenance only. The PR body's residuals section is owned by the
coordinating/reviewing thread, not this plan.

Ship date / merge SHA: *(filled by the coordinating thread at merge)*.
