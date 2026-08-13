# Pair tiering in `findQuoteRuns` (#2288 M2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> ## ✅ Task 0 — ANSWERED by the repo owner, 2026-08-13: **rule B (gap tier)**.
>
> The reading of record is **"no destroyed turns"**. Implement B, as this plan
> already does; Tasks 1–9 stand as written and the A variant below is now
> historical context only. **Do not re-impose acceptance items 1–2** (0 of
> 51,608 / 0 of 9 pairs): the same pass that measured them proved they contain
> zero destroyed turns, so they are passable without fixing the ticket and the
> design formally supersedes them. Bind instead to the turns-destroyed columns
> across all three families, the suppression class (0 of 21), the corpus result,
> nesting, and the 270-test suite.
>
> *Original framing, retained because it is why the plan is shaped this way:*
>
> The design pass produced **two** rules. Both pass the ticket's five stated
> acceptance items or fail them in ways the items cannot see, and they differ on
> an axis the items never measured. Which one this plan implements is not an
> implementation choice.
>
> | | **A — paragraph tier** | **B — gap tier** (this plan) |
> |---|---:|---:|
> | six-language sweep (F1) | **0** of 51,608 | 284 |
> | straddle family (F2) | **0** | 796 |
> | `gap × nest` cross-product (F3) | **0** | 6,084 |
> | shapes with a turn destroyed (F2 / F3) | **0 / 0** | **0 / 0** |
> | dialogue suppressed by a quoted title in narration | **21 of 21, both turns** | **0 of 21** |
> | widening benefit retained (F1 GAIN) | 212 (20%) | **1,043 (100%)** |
>
> **The question:** does "drifted input must not corrupt a correct reading"
> (#1601, extended to all seven languages) mean *no spurious speech spans*, or
> *no destroyed turns*? A satisfies the first reading; B satisfies the second.
> Full framing and every number: the design's "The owner decision, and what it
> now costs".
>
> **This plan implements B**, the design's recommendation. If the owner chooses
> A, Tasks 1, 2, 4–9 stand unchanged and only Task 3's rule body and Task 6's
> residual pins differ — the design gives A's exact expression. **Do not
> implement A without also pinning the suppression class**, which is what nearly
> shipped it.

**Goal:** Unblock PR [#2286](https://github.com/dudarenok-maker/Castwright/pull/2286) / [#2279](https://github.com/dudarenok-maker/Castwright/issues/2279) by making it safe to *add* a quote pair to a language table.

**Architecture:** One new field on `LanguageConventions` (`secondaryQuotePairs`, empty for all seven languages) and one change inside `findQuoteRuns` (`server/src/analyzer/dialogue-structure/parser.ts:341`): accept primary-pair runs first, then let secondary-pair candidates fill the remaining gaps, declining any whose interior contains a primary opener glyph. The candidate scan is copied through verbatim. No table gains a pair in this plan.

**Tech Stack:** TypeScript (Node, ESM), Vitest. Server suite only.

**Design of record:** [`docs/superpowers/specs/2026-08-13-gap-seeded-straddle-design.md`](../specs/2026-08-13-gap-seeded-straddle-design.md). **Read it before Task 3** — "Candidate rules evaluated" records why every acceptance-order rule was rejected, "The suppression class" records what disqualified rule A, and "Residuals" records what this does *not* fix, which Task 6 pins as tests.

**Predecessor:** M1, [`2026-08-12-quote-delimiter-validity.md`](2026-08-12-quote-delimiter-validity.md), shipped `e839a939`. Its invariants are inherited whole.

---

## Global Constraints

The five acceptance items, verbatim from the M2 brief
([#2288#issuecomment-5275015405](https://github.com/dudarenok-maker/Castwright/issues/2288#issuecomment-5275015405)):

1. `2286-percandidate.mts` reads **0 for all nine added pairs**.
2. `sweep-six-langs.mts` reads **0 of 51,608**.
3. M1's corpus result does not regress: **938 clean repairs / 0 merged / 0 lost / 0 gained / 0 split** over the 140-English-book set, scored with `2288-metric.mts`.
4. The shipped 270-test `dialogue-structure` + `narrator-default` suite stays green (`cd server && npx vitest run src/analyzer/dialogue-structure src/analyzer/narrator-default.test.ts`).
5. The nesting cases (`“He said ‘hi’ to me,”` in `en`, `“他说‘你好’然后走了”` in `zh`) still resolve to the **OUTER** run.

**Rule B meets 3, 4 and 5 and deliberately does NOT meet 1 and 2** (284 of
51,608; 9 of 9 pairs still flagged, but with **0 destroyed turns** in every
row, versus 339 today). That is the owner decision above, not a defect to fix
during implementation — **do not "improve" the rule to reach 0 on items 1–2.**
Every rule measured that reaches 0 there either carries the suppression class or
deletes real English runs.

Additional constraints the design establishes:

- **Three sweep families, not one.** F1 (`m2-sweep.mts`) contains **zero**
  destroyed turns and cannot express the ticket's defect. F2 (`m2-sweep2.mts`)
  supplies the straddle geometry. F3 (`m2-sweep3.mts`) supplies the `gap × nest`
  cross-product neither of the others has. **Task 5 commits F2 and F3.**
- **The suppression class is a first-class test, not a residual note.** A quoted
  title in narration must not suppress dialogue. Task 4 pins it.
- **A rule may move a run boundary; it may never delete a run.** M1's
  never-delete fallback is untouched. Rule B cannot delete a primary run by
  construction — keep it that way.
- **The acceptance loop for primary runs does not change.** Every rule that
  reordered acceptance destroyed nesting or split real turns.
- **No table gains a pair here.** `lang/*.ts` gain `secondaryQuotePairs: []`.
  #2286 lands the nine pairs *into that field* afterwards.
- **Every zero reported needs a control that moves**, and every figure names the
  rule it was measured under. The design's harness silently no-opped once, and
  an unreproducible control number survived into revision 1 of the spec.
- **Commit convention:** `<type>(<scope>): <subject>`, ≤ 100 chars. Scope
  `server` for code, `docs` for docs.
- **Branch:** fresh worktree + branch `fix/server-2288-pair-tiering` off latest
  `origin/main`. `wt-2288-m2-straddle` is the docs-only design tree, not this.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `server/src/analyzer/dialogue-structure/types.ts` | `LanguageConventions` | Add `secondaryQuotePairs: Array<[string, string]>` + doc comment |
| `server/src/analyzer/dialogue-structure/lang/{en,de,es,fr,ru,zh,ja}.ts` | tables | Add `secondaryQuotePairs: []` to each |
| `server/src/analyzer/dialogue-structure/parser.ts` | run-boundary detection | Extract `scanQuoteRuns`; `findQuoteRuns` gains the gap tier; `parseQuoteParagraph` (:460) passes the second list |
| `server/src/analyzer/dialogue-structure/parser.test.ts` | engine-path regression | Add four `describe` blocks (Tasks 2–4, 6) |
| `server/src/analyzer/dialogue-structure/lang/index.test.ts` | table guards | Tier-disjointness + tier-crossing-opener guards |
| `server/src/analyzer/dialogue-structure/tier-sweep.test.ts` | generated regression | New file (Task 5): F2 + F3 |
| `server/src/analyzer/narrator-default.ts` / `.test.ts` | `isSpokenLine` | Read BOTH tiers (Task 7) + fix its doc comment |
| `docs/release-notes-next.md`, `RELEASE_NOTES.md` | release register | Append one entry each |

---

### Task 1: Add `secondaryQuotePairs` to the conventions type and all seven tables

Pure data. No behaviour change; the suite must stay green with no test edited.

- [ ] Add to `LanguageConventions` in `types.ts`, immediately under `quotePairs`:

```ts
  /** Conventions this language TOLERATES but does not typeset dialogue in.
      Primary-pair runs are found first; these fill the gaps BETWEEN them, and a
      secondary run whose interior contains a primary opener is declined — it
      straddled into a primary turn rather than sitting beside it. Empty for
      every language today; #2286's added pairs land here, not in `quotePairs`.
      NOTE `isSpokenLine` (analyzer/narrator-default.ts) reads BOTH lists with
      no tier — it computes no run boundary, so it cannot straddle, and a tier
      there would hide these pairs from the narrator-default demotion entirely.
      See docs/superpowers/specs/2026-08-13-gap-seeded-straddle-design.md. */
  secondaryQuotePairs: Array<[string, string]>;
```

- [ ] Add `secondaryQuotePairs: [],` to each of the seven tables, after `quotePairs`.
- [ ] **Verify:** `cd server && npx tsc --noEmit` clean; `npx vitest run src/analyzer/dialogue-structure` green with no test edited. A red typecheck means a table was missed — the field is required deliberately.

---

### Task 2: Extract the scan, changing nothing (characterisation first)

- [ ] Add a characterisation test **before** touching `parser.ts`:

```ts
describe('parser — #2288 M2 Task 2: extracting the scan changes nothing', () => {
  const idx = buildNameIndex([{ id: 'mary', name: 'Mary' }], conventionsFor('en')!);
  const speechOf = (body: string) =>
    parseChapterStructure(body, idx)
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));

  it('keeps every shape the shipped scan produces', () => {
    expect(speechOf('“He said ‘hi’ to me,” she reported.')).toEqual(['He said ‘hi’ to me,']);
    expect(speechOf('‘I don’t know,’ she said.')).toEqual(['I don’t know,']);
    expect(speechOf('“First turn,” he said. “Second turn,” she said.')).toEqual([
      'First turn,',
      'Second turn,',
    ]);
    expect(
      speechOf('Tom said the ‘phone wasn’t working. “I agree,” said Mary. It was the boys’ fault.'),
    ).toContain('I agree,');
  });
});
```

- [ ] Rename the existing `findQuoteRuns` body to `scanQuoteRuns(line, pairs)` — **cut and paste, no edits** — and make `findQuoteRuns` a one-line delegation.
- [ ] **Verify:** suite green; `git diff -w` on `parser.ts` shows only the rename plus a two-line wrapper.

---

### Task 3: The gap tier

- [ ] Replace the delegation:

```ts
/** Two-tier scan (#2288 M2, rule B). Primary-pair runs are found first and
    always win; secondary-pair candidates then fill the gaps BETWEEN them,
    except one whose interior contains a primary OPENER glyph.

    Why a gap and not a paragraph verdict: the earlier design deferred to the
    primary tier for the whole paragraph whenever it produced ANY run. A
    primary scan is not a convention detector, it is an any-run detector — so a
    primary-convention title quoted in NARRATION (`Leía «Fausto» en la portada.
    "Hola", dijo él.`) suppressed every genuine dialogue turn in the paragraph.
    Measured: 21 of 21 such shapes lost BOTH turns. Gap scope loses none.

    Why the primary-opener test: a stray `‘…’` containing a genuine `«Пока»`
    turn and a legitimate nest `“He said ‘hi’ to me,”` are the same interval
    geometry, so no rule local to a candidate PAIR can separate them — but a
    SECONDARY candidate that swallowed a PRIMARY opener has straddled into that
    turn, while one sitting in narration contains no primary opener. That is a
    tier fact, not a geometry fact, which is why it works where the geometry
    rules measured in the design all failed.

    This cannot delete a primary run and cannot alter a table with an empty
    tier — M1's never-delete invariant and the 270-test suite hold by
    construction, not by measurement. */
function findQuoteRuns(
  line: string,
  pairs: Array<[string, string]>,
  secondary: Array<[string, string]>,
): QuoteRun[] {
  const primaryRuns = scanQuoteRuns(line, pairs);
  if (!secondary.length) return primaryRuns;

  const primaryOpeners = new Set(pairs.map(([open]) => open));
  const all = scanQuoteRuns(line, [...pairs, ...secondary]);
  const out = [...primaryRuns];
  let cursor = -1;
  for (const c of all) {
    if (c.start < cursor) continue;
    if (out.some((r) => c.start < r.end && r.start < c.end)) continue;
    let straddles = false;
    for (const open of primaryOpeners) {
      const at = line.indexOf(open, c.start + c.openLen);
      if (at >= 0 && at < c.end - c.closeLen) {
        straddles = true;
        break;
      }
    }
    if (straddles) continue;
    out.push(c);
    cursor = c.end;
  }
  return out.sort((a, b) => a.start - b.start);
}
```

- [ ] Update the single call site, `parseQuoteParagraph` (`parser.ts:460`):

```ts
  const runs = findQuoteRuns(line, conv.quotePairs, conv.secondaryQuotePairs);
```

> **Import note:** `parser.test.ts` imports only `type { SpanEvidence }` from
> `./types.js`. Tasks 3, 4 and 6 annotate fixtures as `LanguageConventions`, so
> widen it to
> `import type { LanguageConventions, SpanEvidence } from './types.js';`.
> `npm run typecheck`, not the Vitest run, is what will tell you.

- [ ] Add the behaviour tests. No shipped table has a non-empty tier, so build the fixture from a real table — the test is live today rather than dormant until #2286:

```ts
describe('parser — #2288 M2: a secondary pair fills gaps but never straddles a primary turn', () => {
  const ru = conventionsFor('ru')!;
  const tiered: LanguageConventions = { ...ru, secondaryQuotePairs: [['‘', '’']] };
  const flat: LanguageConventions = {
    ...ru, quotePairs: [...ru.quotePairs, ['‘', '’']], secondaryQuotePairs: [],
  };
  const speechOf = (body: string, conv: LanguageConventions) =>
    parseChapterStructure(body, buildNameIndex([], conv))
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));

  const straddle = '«Привет», сказал он, глядя на ‘Фауста. «Пока», сказала она О’Брайену.';

  it('RED WITHOUT THE TIER: the pair as a PRIMARY destroys the second turn', () => {
    /* asserts the BUG, so the case below cannot pass vacuously */
    expect(speechOf(straddle, flat)).toEqual(['Привет', 'Фауста. «Пока», сказала она О']);
  });

  it('declared SECONDARY, both turns survive', () => {
    expect(speechOf(straddle, tiered)).toEqual(['Привет', 'Пока']);
  });

  it('a paragraph written WHOLLY in the secondary convention still parses', () => {
    expect(speechOf('‘Привет,’ сказал он. ‘Пока,’ сказала она.', tiered)).toEqual([
      'Привет,', 'Пока,',
    ]);
  });

  it('a secondary turn BESIDE a primary turn is kept — the gap tier’s whole point', () => {
    expect(speechOf('«Привет», сказал он. ‘Пока,’ сказала она.', tiered)).toEqual([
      'Привет', 'Пока,',
    ]);
  });

  it('an empty tier leaves the shipped table exactly as it reads today', () => {
    /* NOT expect(x).toEqual(x) — the right-hand side is the literal shipped
       reading, so this asserts that adding the field changed nothing. */
    expect(ru.secondaryQuotePairs).toEqual([]);
    expect(speechOf(straddle, ru)).toEqual(['Привет', 'Пока']);
  });
});
```

- [ ] **Verify:** run the RED case with Task 3 reverted and confirm it fails **by swallowing the second turn** — check the received value, not just the redness.

---

### Task 4: Invariants and the suppression class, pinned under a declared tier

- [ ] Add:

```ts
describe('parser — #2288 M2: invariants hold with a tier declared', () => {
  const enTier: LanguageConventions = {
    ...conventionsFor('en')!, secondaryQuotePairs: [['«', '»']],
  };
  const zhTier: LanguageConventions = {
    ...conventionsFor('zh')!, secondaryQuotePairs: [['‘', '’'], ['"', '"']],
  };
  const speechOf = (body: string, conv: LanguageConventions) =>
    parseChapterStructure(body, buildNameIndex([{ id: 'mary', name: 'Mary' }], conv))
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));

  it('en: nesting resolves to the OUTER run (acceptance item 5)', () => {
    expect(speechOf('“He said ‘hi’ to me,” she reported.', enTier)).toEqual(['He said ‘hi’ to me,']);
  });
  it('zh: nesting resolves to the OUTER run (acceptance item 5)', () => {
    expect(speechOf('“他说‘你好’然后走了”', zhTier)).toEqual(['他说‘你好’然后走了']);
  });
  it('en: M1’s apostrophe repair survives', () => {
    expect(speechOf('‘I don’t know,’ she said.', enTier)).toEqual(['I don’t know,']);
  });
  it('en: M1’s rejection bound survives — Mary’s turn is not swallowed', () => {
    expect(
      speechOf('Tom said the ‘phone wasn’t working. “I agree,” said Mary. It was the boys’ fault.', enTier),
    ).toContain('I agree,');
  });
  it('en: the ticket’s « straddle counter-example keeps both turns', () => {
    expect(
      speechOf('“Hi,” he said, passing the «Faust poster. “Bye,” she said, near the «gallery».', enTier),
    ).toEqual(['Hi,', 'Bye,']);
  });
  it('de: #1601 nearest-closer split is untouched', () => {
    expect(speechOf('„Guten Tag“, sagte er. „Und du?", fragte sie.', conventionsFor('de')!)).toEqual([
      'Guten Tag', 'Und du?',
    ]);
  });
  it('runs stay disjoint under the tier', () => {
    const spans = parseChapterStructure(
      '«Привет», сказал он, глядя на ‘Фауста. «Пока», сказала она О’Брайену.',
      buildNameIndex([], { ...conventionsFor('ru')!, secondaryQuotePairs: [['‘', '’']] }),
    ).flatMap((p) => p.spans).sort((a, b) => a.start - b.start);
    for (let i = 1; i < spans.length; i++) expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
  });
});

describe('parser — #2288 M2: a quoted TITLE in narration must not suppress dialogue', () => {
  /* THE case that disqualified the paragraph-scoped tier. A primary scan is an
     any-run detector, not a convention detector: under a paragraph verdict this
     paragraph lost BOTH turns, 21 of 21 such shapes across six languages.
     Guillemet and corner-bracket titles are routine in exactly the books
     typeset in the secondary convention. */
  const speechOf = (body: string, conv: LanguageConventions) =>
    parseChapterStructure(body, buildNameIndex([], conv))
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));

  it('es: a «title» in narration leaves both "…" turns intact', () => {
    const es: LanguageConventions = { ...conventionsFor('es')!, secondaryQuotePairs: [['"', '"']] };
    expect(speechOf('Leía «Fausto» en la portada. "Hola", dijo él. "Adiós", dijo ella.', es)).toEqual([
      'Fausto', 'Hola', 'Adiós',
    ]);
  });
  it('ja: a 「title」 in narration leaves both “…” turns intact', () => {
    const ja: LanguageConventions = { ...conventionsFor('ja')!, secondaryQuotePairs: [['“', '”']] };
    expect(
      speechOf('彼は表紙の「ファウスト」を読んだ。“おはよう”と彼は言った。“さようなら”と彼女は言った。', ja),
    ).toEqual(['ファウスト', 'おはよう', 'さようなら']);
  });
});
```

- [ ] Add the two table guards to `lang/index.test.ts`:

```ts
  it('no language declares a pair in BOTH tiers', () => {
    for (const lang of ['ru', 'en', 'es', 'fr', 'de', 'zh', 'ja']) {
      const c = conventionsFor(lang)!;
      const inPrimary = (o: string, x: string) => c.quotePairs.some(([a, b]) => a === o && b === x);
      for (const [o, x] of c.secondaryQuotePairs) {
        expect(inPrimary(o, x), `${lang} declares ${o}${x} in both tiers`).toBe(false);
      }
    }
  });

  /* The gap tier's straddle test keys on the primary OPENER SET, so a secondary
     pair sharing an opener with a primary pair would decline itself. None of
     #2286's nine additions does — verified per language in the design. Loosen
     this only together with a re-measurement. */
  it('no secondary pair shares an opener glyph with a primary pair', () => {
    for (const lang of ['ru', 'en', 'es', 'fr', 'de', 'zh', 'ja']) {
      const c = conventionsFor(lang)!;
      const primaryOpeners = new Set(c.quotePairs.map(([o]) => o));
      for (const [o] of c.secondaryQuotePairs) {
        expect(primaryOpeners.has(o), `${lang}: secondary opener ${o} is also a primary opener`).toBe(false);
      }
    }
  });
```

- [ ] **Verify:** suite green. Then **mutate**: delete the `straddles` check and confirm the `ru` straddle case goes red; delete the `out.some(...overlap...)` guard and confirm the disjointness case goes red. If either survives, the suite is not pinning the rule.

---

### Task 5: Commit families F2 and F3 as generated regression tests

The brief's five items are all satisfiable by a rule that never fixes a straddle — F1 contains zero destroyed turns. These are what close that, and F3 closes the `gap × nest` cross-product neither F1 nor F2 has.

- [ ] New file `server/src/analyzer/dialogue-structure/tier-sweep.test.ts`, generating both families from the tables so a future table change re-derives its own coverage. Port `m2-sweep2.mts` (straddle) and `m2-sweep3.mts` (`gap × nest`) — scoring `ref` = the shipped table (which no tier can move), asserting **zero shapes with a destroyed turn** and **zero broken nests**, with a **control** that declares the same pair PRIMARY and must be non-zero.
- [ ] Keep it to three languages (`es`, `ru`, `en`) and time it. If it exceeds ~2s, drop a language — **never thin a cross-product**, which is the coverage gap these files exist to close.
- [ ] **Verify the control is real:** make `findQuoteRuns` ignore `secondary` and confirm the destroyed-turn assertions go red in both families.

---

### Task 6: Pin what this does NOT fix, at current behaviour

- [ ] Pin, each with a comment naming the design's residual:
  - **Residual 1** — the straddle inside a language's PRIMARY pairs is untouched: `«Hola, dijo él. «Adiós», dijo ella.` (`es`, no tier) still reads as one run.
  - **Residual 2** — a spurious secondary run over narration on drifted input survives, with **no** turn destroyed. Use a shape from F1's remaining 284 so the pin is real behaviour, not a guess.
- [ ] **Verify:** none passes for a different reason than stated — e.g. by producing no runs at all. A limit test that passes vacuously is worse than none.

---

### Task 7: `isSpokenLine` reads BOTH tiers

Getting this wrong makes #2286 a silent half-delivery. See the design's "The second consumer".

- [ ] In `server/src/analyzer/narrator-default.ts`, iterate both lists — one binding so the two loops cannot drift:

```ts
  const pairs = [...conventions.quotePairs, ...conventions.secondaryQuotePairs];
```

- [ ] Update its doc comment (`:26-33`), which says `conventions.quotePairs` three times and would be false.
- [ ] Add to `narrator-default.test.ts` (it imports `conventionsFor` but not the type — add `import type { LanguageConventions } from './dialogue-structure/types.js';`):

```ts
describe('#2288 M2: isSpokenLine reads BOTH quote-pair tiers', () => {
  /* The tier stops a run STRADDLING; isSpokenLine computes no run boundary, so
     it cannot straddle and must not inherit the restriction — otherwise #2286's
     pairs land in a field it never reads and real dialogue is demoted to
     narrator. Its failure direction here is a false POSITIVE ("do not demote"),
     the safe one for a demote-only heuristic. */
  const ruTier: LanguageConventions = {
    ...conventionsFor('ru')!, secondaryQuotePairs: [['‘', '’']],
  };
  it('a line in the SECONDARY convention still reads as spoken', () => {
    expect(isSpokenLine('‘Привет,’ сказал он.', ruTier)).toBe(true);
  });
  it('CONTROL: the same line is NOT spoken with the pair in neither tier', () => {
    expect(isSpokenLine('‘Привет,’ сказал он.', conventionsFor('ru')!)).toBe(false);
  });
  it('an unrelated line is still not spoken', () => {
    expect(isSpokenLine('Он молча вышел из комнаты.', ruTier)).toBe(false);
  });
});
```

- [ ] **Verify:** `npx vitest run src/analyzer/narrator-default.test.ts` green, including the existing #2245 cases (`fr` rejecting `"Bonjour"`, the zh/ja asymmetry). Those assert on tables with an empty tier and must not move.

---

### Task 8: Re-run the design's measurements against the shipped code

The design measured a prototype. This confirms the implementation reproduces it.

- [ ] Point the scratchpad instruments at the implementation branch (`SRC.base` in `m2-setup.mjs`), `node m2-setup.mjs`, then run each **with its control**:

```
tsx m2-sweep.mts        T_gapSecondary            # F1  — expect 284, REGR 0, GAIN 1043
tsx m2-sweep.mts        T_gapSecondary --no-tier  #     control — expect 437 / 1043
METRIC_LIB=1 tsx m2-sweep2.mts T_gapSecondary     # F2  — expect 796 hits, 0 destroy
METRIC_LIB=1 tsx m2-sweep3.mts T_gapSecondary     # F3  — expect 6084 hits, 0 destroy, 0 nest broken
METRIC_LIB=1 tsx m2-suppress.mts T_gapSecondary   #     — expect 0 of 21
METRIC_LIB=1 tsx m2-corpus.mts   T_gapSecondary   # item 3 — 938 / 0 / 0 / 0 / 0 (MOVED 950)
METRIC_LIB=1 tsx m2-identity.mts T_gapSecondary   # item 4 — 0 differing, control 14
METRIC_LIB=1 tsx m2-percandidate.mts T_gapSecondary  # 9 flagged, 0 DESTROY in every row
```

- [ ] Run acceptance item 4 for real: `cd server && npx vitest run src/analyzer/dialogue-structure src/analyzer/narrator-default.test.ts`.
- [ ] **Do not use `m2-classify437.mts` to score this rule** — it takes a `RULE` argument and ignores it (known instrument defect, recorded in the design).
- [ ] **Verify:** every figure matches. A divergence means the implementation is not the rule that was measured — investigate; do not re-baseline the design to the code.

---

### Task 9: Release notes, and ship

- [ ] `docs/release-notes-next.md`: one technical entry naming the new field and that #2286 is unblocked.
- [ ] `RELEASE_NOTES.md`: one user-facing brand-voice line in the in-progress section — the visible delta arrives when #2286 lands, so keep it forward-looking and modest.
- [ ] **On-box acceptance: none owed** — nothing here needs a GPU, sidecar, analyzer, or real book. Say so explicitly in the PR body rather than omitting it.
- [ ] `npm run verify:fast:branch`.
- [ ] PR title `fix(server): find primary quote-pair runs before secondary ones`; body with `## Summary` / `## Test plan`; `Refs #2288` (**not** `Closes` — residual 1 leaves the primary-pair straddle live) and `Refs #2286`. State the owner's Task 0 answer in the body.
- [ ] Mandatory `pr-review-gate` pass (Premium tier, `medium` — single-scope `fix`).

---

## Self-review

- **Why not the rule that scores 0?** Because scoring 0 on those instruments is
  not the same as being correct: the paragraph tier reaches 0 by deferring to
  the primary tier whenever the paragraph contains *any* primary run, which
  destroys all dialogue in a paragraph whose narration quotes a title. That is
  Task 0's decision and the design prices both sides.
- **What would falsify this?** Task 8's re-measurement disagreeing with the
  design, or Task 4/5's mutation checks failing to go red. Both are checked.
- **What is deliberately absent?** German (out of scope), import-time
  normalisation (rejected), any acceptance-order change (rejected with
  measurements), and any attempt to drive items 1–2 to 0 (that is rule A).
