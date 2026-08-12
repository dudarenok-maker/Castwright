# Quote-delimiter validity in `findQuoteRuns` — design

Status: proposed · Issue: [#2288](https://github.com/dudarenok-maker/Castwright/issues/2288) · Blocks: [#2286](https://github.com/dudarenok-maker/Castwright/pull/2286) / [#2279](https://github.com/dudarenok-maker/Castwright/issues/2279)

> **Revision 2.** Revision 1 proposed three clauses and claimed "1,034
> repaired / 0 broken". An independent assumption-checker pass showed that
> metric counted **turn deletions as repairs**: 90 paragraphs came out with
> fewer speech turns than `main`, 74 of them with none at all. It also showed
> two of the three clauses had no measured benefit at all. What survives is one
> clause plus a safety invariant. The rejected material is kept below, because
> the reasons it failed are the load-bearing part of this design.

## The problem

`#2288` was filed as "the engine blocks widening the `quotePairs` tables."
That framing hid the more important half.

**The defect is live on `main`, in English, at default settings.** `en.ts`
already ships `['‘','’']`, and single-quoted material is closed by the first
`’` — which in English is usually an apostrophe. Through the real
`parseChapterStructure`:

```
‘I don’t know,’ she said.                → speech: ["I don"]
‘We can’t go back,’ said Mary. ‘It isn’t safe.’
                                         → speech: ["We can", "It isn"]
‘Hello,’ he said. ‘Goodbye,’ she said.   → speech: ["Hello,", "Goodbye,"]   ✓ control
“I don’t know,” she said.                → speech: ["I don’t know,"]        ✓ control
```

`en.ts` excludes the *straight* single pair `['\'','\'']` for exactly this
reason; the rationale is recorded in
`docs/features/162-fs2-multilanguage.md:117`. It was never applied to the
smart pair. Reachability is not in question:
`analyzer.structure.enabled` defaults `true`
(`server/src/config/registry.ts:1273`) and `server/src/routes/analysis.ts:2177`
calls `parseChapterStructure` on the live path.

**Measured prevalence:** across 331 real books, `main` places a run delimiter
inside a word in **1,126 paragraphs** — 1,066 of them English. In the wild the
shape is single-quoted quotation *inside narration* (`… said, ‘Shan’t be a
minute.’`), not whole-book British convention; see "What the corpus cannot
say" below.

## Two mechanisms, not one

**M1 — an invalid delimiter is accepted.** An apostrophe is taken as a closing
quote. The evidence is local to the glyph and its neighbours. This is all
measured real-world damage, and it is live today.

**M2 — a gap-seeded run straddles the next turn.** A candidate seeded between
two turns runs to a closer at or past the next turn's opener; the genuine turn
is discarded for overlapping it. This needs drifted or mixed glyph sets, so in
practice it is a *widening* problem. **It is not addressed here** — see
"Rejected".

## The rule

**One clause, plus one invariant, applied at candidate construction. The
leftmost-wins acceptance loop is not touched.**

**D — an apostrophe-shaped glyph inside a word is not a closer.** A `’` or `'`
is rejected as a closer when any of:

1. it has a cased letter on both sides — `O’Brien`, `don’t`, `l’homme`;
2. it is preceded by whitespace, `(`, `[` or `{` and followed by a cased
   letter — `’em`, `’cause`, `’tis`, `’alf`. A real closing quote is never
   preceded by whitespace: it closes onto the last character of the speech it
   terminates;
3. it is preceded by an **opener glyph of the same table** and followed by a
   cased letter — `‘’Tis nothing,’`, the turn-initial dialect elision.
   Accepting it closes the run on an empty interior, which produces no speech
   span at all: the turn is destroyed rather than truncated.

"Cased" means `\p{L}` minus `Han`, `Hiragana`, `Katakana`, `Hangul`, `Thai`.
The exclusion is required: CJK has no inter-word spacing, so `好’然` inside
zh's legitimate `“他说‘你好’然后走了”` has letters on both sides and must stay a
closer. The list is exhaustive for the seven tables that exist; scripts with no
case and no table (Arabic, Hebrew, Devanagari) are unreachable today and the
implementation must not silently assume otherwise.

**The invariant — a rule may move a run boundary, never delete a run.** If
rejecting closers leaves an opener with *no* valid closer at all, fall back to
the nearest closer of any kind, i.e. exactly what `main` would have chosen.

This invariant is not a refinement; it is what makes the clause safe. Without
it, D deletes **90 paragraphs' worth of speech** on the corpus, 74 of them
losing every turn — turning dialogue into narration, which is the same harm
class #2288 exists to fix.

```
“ ‘In my youth,’ said the Hermit, ‘I was a shoemaker, and fastidious.’ ”
   main        ["In my youth,", "I was a shoemaker, and fastidious."]
   D, no fallback  ["In my youth,"]              ← second turn deleted
   D + fallback    ["In my youth,", "I was a shoemaker, and fastidious."]
```

### Why acceptance is not touched

Every rule that changed *acceptance* destroyed nesting:

| rule | generated shapes | real paragraphs |
|---|---|---|
| role-based two-phase (option A) | −96 | 0 |
| shortest-first (option B) | −374 | −501 |
| per-paragraph convention election (option 2) | −254 | −161 |

The election rule fails for a reason that condemns the variant broadly: an
outer turn containing several inner quotations always loses, because counting
candidates favours the inner class. `“ ‘Oh, ’im?’ she says. ‘ ’E’s the cook’s
brother,’ she says. …”` collapses from one turn into five fragments.

**Note what this does *not* retire.** The evidence kills *count-based*
election. A length-weighted election returns the correct reading on that same
example and on the nesting family. It is untested at scale and is not proposed
here, but "option 2 is dead" would be an overclaim.

### Nesting is preserved, but it is NOT structural

Revision 1 asserted "leftmost-wins resolves nesting, therefore nesting is
structurally safe." That is false, and worth stating explicitly so no future
change re-derives it wrongly: leftmost-wins picks the outer run **only if the
outer candidate exists**. Deleting a candidate at construction time promotes
the inner run to top level:

```
‘He said “hi” to O’Brien.     main ["He said “hi” to O"]   D without fallback ["hi"]
X"He said “hi” to me."        main ["He said “hi” to me."] with opener rejection ["hi"]
```

Nesting survives **because of** the never-delete-a-run invariant, not because
the acceptance loop is untouched. Disjointness *is* structural; outer-wins is
not.

## Invariants preserved

- **Runs stay disjoint** — acceptance unchanged (`parser.ts:223` slices
  sequentially).
- **Nesting resolves to the OUTER run** in `en`, `zh`, `de` — contingent, per
  above; pinned by the sweep's `nest` family at both table sets.
- **#1601 stays fixed.** A `„` run still ends at the NEAREST of its closers.
  No clause can fire on `de`'s table at all (its closers `“ ” " «` are not
  apostrophe-shaped), so this is untouched by construction.
- **`dialogueOpen` / `crossExamine` untouched.**

## Evidence

### Corpus

331 public-domain books: **100 Standard Ebooks** (English, modern typesetting,
ingested through the product's own `parseEpub`) + **231 Project Gutenberg**
across `de/en/es/fr/ja/ru/zh`. 725,066 paragraphs, 238,601 carrying a quote
run.

### Control, before any result

The harness reimplements `findQuoteRuns` so a rule can be swapped without
editing the parser. It was verified against the **real** `parseChapterStructure`
first — **499,113 paragraphs, 0 mismatches** — over the four languages whose
`dialogueOpen` is `null`, on dash-free paragraphs, where a run maps 1:1 to a
speech span. Independently re-run with the restrictions relaxed: removing the
length cap gives 502,411 / 0; *including* dash paragraphs gives 544,711 / 239,
and all 239 are `parseDialogueSpans` splitting a run interior at an interior
dash-tag — the run→span mapping, not `findQuoteRuns`. The restriction is
necessary and hides no divergence.

Positive control: the sample contains **364 damaged paragraphs** under the
metric used in the results below (315 English), so the equivalence is not
proven over trivial text.

> Revision 1 quoted 27,661 here. That figure omitted the CJK subtraction the
> results table applies, so 27,037 zh and 267 ja paragraphs were counted as
> damaged for having an ideograph after a closer — normal spacing. Both
> numbers are real; only one is the document's metric. One definition is used
> throughout revision 2.

### Metric

Ground truth does not exist for real books, so each changed paragraph is
classified against `main`'s own output:

- **LOST** — a run `main` found has no counterpart: its text is contained in no
  run the rule produced. Speech became narration. Checked **first**, and it
  dominates: a paragraph that repairs one turn and deletes another is a
  regression.
- **REPAIRED** — `main` had an intra-word delimiter, the rule has none, and
  nothing was lost. (`main`'s truncated `Shan` is a prefix of the repaired
  `Shan’t be a minute.`, so containment is the right test.)
- **MOVED** — changed, neither of the above.

**Known blind spot, stated because it bounds every number here:** the
intra-word signature fires only on a cased letter *immediately outside* a
delimiter. A truncation whose bogus closer is followed by a space — the
possessive-plural class, `‘It was the boys’ fault,’` → `["It was the boys"]` —
is invisible to it, and lands in no bucket. It is undercounted in the 1,126 and
in the residual alike. `main` and the proposed rule fail it identically.

### Result

| | changed | REPAIRED | LOST | of which all speech gone | MOVED |
|---|---|---|---|---|---|
| D without the invariant | 1,036 | 949 | **86** | 74 | 1 |
| revision 1's three clauses | 1,040 | 949 | **90** | 74 | 1 |
| **D + never-delete invariant** | **950** | **949** | **0** | **0** | **1** |

Identical on `main`'s tables and on #2286's widened tables. Residual damaged
paragraphs **1,126 → 177**.

| lang | paragraphs | with runs | `main` damaged | after D | changed |
|---|---|---|---|---|---|
| en | 388,789 | 174,089 | 1,066 | 117 | 950 |
| de | 63,688 | 23,480 | 44 | 44 | 0 |
| zh | 92,598 | 29,901 | 1 | 1 | 0 |
| es/fr/ja/ru | 179,991 | 11,131 | 15 | 15 | 0 |

**The rule repairs English and touches nothing else.** German's 44 are the
largest remaining slice and no clause here can reach them: they are `»…«`
emphasis glued to words (`Woher aber der Name »Frühstücks«schiff?`). The
zh/ja residuals are fullwidth-Latin and title-marker artifacts. Revision 1
characterised the residual as "same-glyph `"` parity drift", which fits only
part of the English 117.

### Generated sweep

**2,170 distinct shapes (2,408 scorings — `de` and `ru` duplicate because
several pairs share an opener), six families**, at both table sets, each with
intended turns known by construction:

`gap` (a stray delimiter between turns) · `apostrophes` (contractions inside
turns) · `nest` (an outer turn containing 1–3 inner quotes) · `units` (an inch
mark) · **`british`** (single-quote dialogue with contractions, elisions,
possessives, apostrophe names, turn-initial `‘’Tis`).

**D + invariant: +161 repaired / −0 regressed.** Zero regressions in every
family at both table sets, including all six `nest` arms.

> Two families exist because earlier revisions of this sweep could not test the
> rule they were meant to gate. v1 had only `gap`, so it never generated an
> apostrophe inside a quoted turn and scored the apostrophe rule `+0/−0` —
> which reads as "safe" and meant "never exercised". v2 added `apostrophes`
> but still never generated a whitespace-preceded apostrophe, so the elision
> clause was equally unexercised. `british` closes both, and is the only
> coverage the target convention has at all.

### What the corpus cannot say

**Zero of the 140 English books use single-quote dialogue as their convention.**
Standard Ebooks normalises to the American convention; Gutenberg plain text is
largely ASCII (the French arm carries 165,061 straight `'` against 71,172
curly `’`). Every one of the 949 repairs is a *nested or narration-embedded*
single-quoted passage inside a double-quoted book.

So the corpus bounds the regression rate for double-quote-convention books —
which is the overwhelming majority of what users will feed the product — and
says **nothing** about the regression rate for a whole-book single-quote
manuscript. That class is covered only by the `british` sweep family, which is
hand-authored and therefore weaker evidence. This is the largest remaining gap
in this design and is stated rather than closed.

Related: two earlier safety arguments for German were false and *both* passed a
0-changed-chapters replay over 747 real chapters with a control that moved 577.
A corpus replay is silent on a malformed-input class by construction.

## Rejected

**`G` — a unit mark or possessive is not an opener.** Rejected outright.
On the shipped tables it changes 4 paragraphs, repairs **0**, and loses 4:
`he said"hello" and left.` → no speech; `он сказал"Привет" и ушёл.` → no
speech. A missing space after a speech verb is a routine OCR artifact. Narrowed
to digit-preceded openers only, it changes **0** paragraphs on the shipped
tables. Its only real benefit is French arc-second marks (`55' 30"`) on tables
#2286 would add, so it can be reconsidered with the widening.

**`H` — drop a candidate that shares its closer with a nested candidate.**
Rejected as unreachable. Two candidates can share an `end` only if they share a
closer *position*; all closers are one code unit, so that means the same glyph
— i.e. one closer glyph belonging to two opener classes. Enumerated over both
table sets, the only table with a shared closer glyph is `wide/de`, which is
excluded permanently. **H changes 0 of 725,066 corpus paragraphs on both table
sets.** Revision 1 claimed it "measures clean everywhere and reduces #2286 to a
pure table change"; 0/0 on the shipped tables is a theorem, not a measurement,
and it does not fix the `en`+`«»` case either.

**M2 generally.** No rule proposed here addresses the gap-seeded straddle, so
**#2286 stays blocked** and this design does not unblock it. `de` gains no
opener regardless: it already carries `['»','«']`, and adding the Swiss
`['«','»']` makes both glyphs bidirectionally ambiguous.

## Scope

**One clause, one PR, no table changes.** `#2288` stays the ticket for this
work, reframed around the live defect.

The owner previously approved a three-clause PR on revision 1's evidence. That
evidence was wrong: `G` is a regression on the shipped tables and `H` is
unreachable code. Shipping either would add untested surface with no measured
benefit, so both are dropped and this is reported rather than re-asked.

## Test plan

Unit tests on the `parseChapterStructure` path — not `isSpokenLine` — because
the absence of engine-path coverage is what let the first widening bug through.

- **Run *count* is asserted in every case.** Revision 1's test plan pinned only
  content, so a suite built from it would have passed on all 74 turn-loss
  paragraphs.
- One case per D sub-clause: both-sides (`O’Brien`, `don’t`), whitespace-then-
  letter (`’em`, `’cause`), opener-then-letter (`‘’Tis`).
- **The never-delete invariant, directly:** a paragraph whose only closers are
  apostrophes must still produce its runs, unchanged from `main`.
- **British single-quote convention**, the whole `british` sweep family — the
  convention the problem statement is about and the corpus has no example of.
- **Nesting, at both table sets**, in `en`, `zh` and `de`, including an outer
  turn containing three inner quotes; plus the three promotion cases above,
  which are the ones that break if a future change deletes a candidate.
- CJK exemption: zh's `“他说‘你好’然后走了”` stays one run.
- Regression cases for the two shapes this does **not** fix — possessive-plural
  (`‘It was the boys’ fault,’`) — asserted at `main`'s current output, so a
  future fix has a failing test to flip rather than a silent gap.
- Salvage from PR #2286: its `parser.test.ts` closer-driven and multi-turn
  cases, and `lang/index.test.ts`'s duplicate-pair guard widened to `zh`/`ja`.
- Not applicable: golden-audio and on-box acceptance — no audio, sidecar or GPU
  surface is touched.
