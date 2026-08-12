# Quote-delimiter validity in `findQuoteRuns` — design

Status: proposed · Issue: [#2288](https://github.com/dudarenok-maker/Castwright/issues/2288) · Blocks: [#2286](https://github.com/dudarenok-maker/Castwright/pull/2286) / [#2279](https://github.com/dudarenok-maker/Castwright/issues/2279)

## The problem, restated

`#2288` was filed as "the engine blocks widening the `quotePairs` tables."
That framing is too narrow, and it hid the more important half.

**The defect is live on `main`, in English, at default settings.** `en.ts`
already ships `['‘','’']`. British-convention books use `‘…’` for dialogue and
`’` as the apostrophe — the exact same-glyph hazard `en.ts:5-7` cites as its
reason for excluding the *straight* single pair, never applied to the smart
pair. Through the real `parseChapterStructure`:

```
‘I don’t know,’ she said.                → speech: ["I don"]
‘We can’t go back,’ said Mary. ‘It isn’t safe.’
                                         → speech: ["We can", "It isn"]
‘Hello,’ he said. ‘Goodbye,’ she said.   → speech: ["Hello,", "Goodbye,"]   ✓ control
“I don’t know,” she said.                → speech: ["I don’t know,"]        ✓ control
```

Every contraction truncates the turn. Reachability is not in question:
`analyzer.structure.enabled` defaults `true` (`server/src/config/registry.ts:1273`)
and `server/src/routes/analysis.ts:2177` calls `parseChapterStructure` on the
live path.

## Two mechanisms, not one

The ticket treats this as a single bug. Separating it is what makes the fix
tractable.

**M1 — an invalid delimiter is accepted.** An apostrophe is taken as a closing
quote. The evidence is entirely local to the glyph and its two neighbours.
This accounts for essentially all real-world damage and is live today.

**M2 — a gap-seeded run straddles the next turn.** A candidate seeded between
two turns runs to a closer at or past the next turn's opener; the genuine turn
is then discarded for overlapping it. This needs drifted or mixed glyph sets,
so in practice it is a *widening* problem, and it is what the ticket's
synthetic counter-examples exercise.

The ticket's stated crux — that a stray run *containing* a real turn and a
legitimate nest are the identical interval geometry — is true, but only for
rules local to a candidate *pair*. It dissolves at two other scales: character
neighbours (M1) and a shared closing delimiter (M2).

## The rule

Three clauses, all applied at **candidate construction**. Today's
leftmost-wins acceptance loop is left exactly as it is.

**D2 — an apostrophe-shaped closer inside a word is not a closer.**
A `’` (or `'`) is rejected as a closer when it has a cased letter on both
sides (`O’Brien`, `don’t`, `l’homme`), or when it is preceded by whitespace or
an opening bracket and followed by a cased letter (`’em`, `’cause`, `’tis`,
`’alf`). The second clause exists because a real closing quote is never
preceded by whitespace — it closes onto the last character of the speech it
terminates. Restricted to **cased** scripts: CJK has no inter-word spacing, so
`好’然` inside zh's legitimate `“他说‘你好’然后走了”` must stay a closer.

**G — a unit mark or possessive is not an opener.**
A `"` / `'` / `’` opener preceded by a digit or a cased letter is an inch mark
or a possessive (`5"`, `dogs’`), not an opening delimiter.

**H — a candidate that shares its closer with a nested candidate straddled.**
If candidate X fully contains candidate Y of a *different* opener class and
`X.end === Y.end`, then X did not close where it appears to: it ran past the
next turn's opener and borrowed that turn's closer. Drop X. Legitimate nesting
never shares a closer — in `“He said ‘hi’ to me,”` the inner `’` is strictly
interior to the outer `”`.

### Why acceptance is not touched

This is the load-bearing decision, and it is what separates this design from
both previously-prototyped options.

Every rule that changed *acceptance* destroyed nesting:

| rule | generated shapes | real paragraphs |
|---|---|---|
| role-based two-phase (option A) | −96 | 0 broken |
| shortest-first (option B) | −372 | −501 |
| per-paragraph convention election (option 2) | −254 | −161 |

The election rule fails for a reason worth recording, because it condemns the
whole family: an outer turn containing several inner quotations always loses,
since counting candidates inherently favours the inner class. `“ ‘Oh, ’im?’ she
says. ‘ ’E’s the cook’s brother,’ she says. …”` collapses from one turn into
five fragments. No count-based election survives this, which retires the
ticket's own recommended option 2.

`main`'s leftmost-wins loop already resolves nesting correctly — the outer run
starts first and wins. It only ever needed candidates that should not have
existed to stop existing.

## Invariants preserved

- **Runs stay disjoint.** `parseQuoteParagraph` (`parser.ts:223`) slices
  sequentially; the acceptance loop is unchanged, so this is structural.
- **Nesting resolves to the OUTER run**, in `en`, `zh` and `de`. Pinned by the
  sweep's `nest` family at both table sets.
- **#1601 stays fixed.** A `„` run still ends at the NEAREST of its closers;
  no clause reorders closers within an opener class.
- **`dialogueOpen` / `crossExamine` untouched.** This is `quotePairs`
  run-boundary work only.

## Evidence

### Corpus

331 public-domain books, two deliberately different arms:

- **100 Standard Ebooks** (English) — modern, carefully typeset, original
  dialogue convention preserved. The only arm that can exhibit the `‘…’`
  class at all. Ingested through the product's own `parseEpub`, so the text
  measured is the text a real ingest produces.
- **231 Project Gutenberg** across `de/en/es/fr/ja/ru/zh`. Broad language
  coverage; typography is uneven and often ASCII-normalised — which is itself
  the finding that made the Standard Ebooks arm necessary.

~725k paragraphs, 239k carrying at least one quote run.

### Control, before any result

The measurement harness reimplements `findQuoteRuns` so a rule can be swapped
without editing the parser. That reimplementation was verified against the
**real** `parseChapterStructure` first: **326,592 paragraphs, 0 mismatches**,
over the four languages whose `dialogueOpen` is `null` and paragraphs with no
dash-tag, where a run maps 1:1 to a speech span. The sample contained **27,661
damaged paragraphs**, so the equivalence was not proven over trivial text.

### Damage signature

Ground-truth-free: a run whose opening glyph is preceded by a cased letter, or
whose closing glyph is followed by one, has a delimiter inside a word and is
wrong regardless of what the right answer is. CJK is excluded from the test —
an ideograph after a closer is normal and would inflate it to meaninglessness.

### Results

| | repaired | broken | residual damaged paragraphs |
|---|---|---|---|
| `main` | — | — | 1,126 |
| D2 alone | 1,034 | 0 | 92 |
| **D2 + G + H** | **1,034** | **0** | **92** |

Identical on `main`'s tables and on #2286's widened tables. **Zero** paragraphs
where both `main` and the rule parse cleanly but the output differs — the rule
never alters correctly-parsed prose.

### Generated sweep

A corpus can only show shapes that happen to occur; a malformed-input class
needs shapes generated on purpose. **2,408 shapes across four families** —
`gap` (a stray delimiter between turns), `apostrophes` (contractions inside
turns), `nest` (an outer turn containing 1–3 inner quotes), `units` (an inch
mark before a turn) — at both table sets, each with intended turns known by
construction rather than inferred from `main`.

**D2+G+H: +253 repaired / −2 regressed.** Both regressions are in `wide/de`,
which is excluded permanently (below). **Zero regressions on the shipped
tables.**

> The first version of this sweep had only the `gap` family and therefore never
> generated an apostrophe inside a quoted turn. It scored D `+0/−0`, which
> reads as "safe" and actually meant "never exercised". The `apostrophes`,
> `nest` and `units` families exist to make each rule's known weakness
> reachable.

## Limits, stated

- **Residual 92 paragraphs** still carry an intra-word delimiter. They are a
  *different* class — same-glyph `"` parity drift, and editorial/footnote text
  mixing straight and curly quotes. Not addressed here; not made worse.
- **`en` gaining `['«','»']` still fails** its counter-example (`“Hi,” … the
  «Faust poster. “Bye,” … the «gallery».`). H does not catch it because the
  straddling candidate's closer is not shared. That specific widening stays
  blocked.
- **`de` gains no opener, permanently.** `de` already carries `['»','«']`;
  adding the Swiss `['«','»']` makes both glyphs bidirectionally ambiguous and
  `«Zu". »Und du?«` has no local reading. Mutually inverse conventions cannot
  coexist in one table.
- **The corpus cannot clear this class on its own.** Two earlier safety
  arguments for German were false and both passed a 0-changed-chapters replay
  over 747 real chapters with a control that moved 577. A corpus replay is
  silent on drifted glyphs by construction. The generated sweep is the gate;
  the corpus is the regression net.

## Scope and sequencing

**One engine PR, no table changes.** All three clauses land together. H has no
effect on today's tables (0 repaired, 0 broken) but is the answer to the
ticket's titular question and measures clean everywhere; shipping it now means
#2286 reduces to a pure table change reviewable on its own.

`#2288` stays the ticket for this work, with the live-defect framing added.

## Test plan

- Unit tests on the `parseChapterStructure` path — not only `isSpokenLine` —
  covering: each D2 sub-clause; G; H; and the nesting controls in `en`, `zh`,
  `de` at both table sets. The absence of engine-path coverage is what let the
  first widening bug through.
- A regression test per counter-example in #2288's evidence table.
- The `nest` family pinned explicitly: an outer turn containing three inner
  quotes must remain one turn.
- Salvage from PR #2286: its `parser.test.ts` closer-driven and multi-turn
  cases, and `lang/index.test.ts`'s duplicate-pair guard widened to `zh`/`ja`.
- Golden-audio and on-box acceptance: not applicable — no audio, sidecar or
  GPU surface is touched.
