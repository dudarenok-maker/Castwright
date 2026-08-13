---
status: draft
---

# Attribution collapse visibility (#1984 Wave 1) — on-box acceptance run sheet

Discharges register row **E11**. Needs a checkout (or worktree with
`server/handoff/cache/` populated) whose cache holds the real library's
analyses, plus `cd server && npm run build`. No GPU needed.

Criteria: spec §On-box acceptance
(`docs/superpowers/specs/2026-08-06-attribution-collapse-visibility-design.md`),
restated here as a checklist.

---

## 1 · Run the script against the real library

```
cd server && npm run build
cd ..
WORKSPACE_DIR=C:\AudiobookWorkspace node scripts/measure-attribution.mjs
```

**`server/handoff/cache/` is per-checkout and git-ignored** (CLAUDE.md's
`CACHE_DIR` note) — run this from the checkout (or a worktree with its cache
populated from one) that actually holds the real library's analyses, or
every book reads `ok (not analysed)` regardless of its real state.

Record the full table verbatim below, plus the JSON report path.

**Result: PARTIAL, 2026-08-13, implementation worktree — RE-MEASURED after
the finding-1 fix.** Ran from `wt-1984-wave1` after `cd server && npm run
build`, with real books' `server/handoff/cache/*.json` copied in
**read-only** from the primary checkout and deleted from the worktree
afterward — nothing written to `C:\AudiobookWorkspace`, and the primary
checkout's cache was only ever read. This is **not** the full-checkout run
item 1 above actually asks for; it is the closest available proxy without
running from a concurrently-in-use checkout. **Re-run 2026-08-13 after the
#2328 review-gate fix to `orphanSpoken`** (it was counting one increment per
unresolvable model id sharing a split span, rather than once per span —
finding 1): across the real corpus this moved exactly **one** cell —
`Ночной дозор (Tetralogy)`'s `orphan` column, `30` → `29` (one split span in
that book carried two distinct bogus ids). Every other row's `orphan`
column, and every D13 percentage below, is numerically unchanged by the fix
— the bug was real but this corpus rarely hits the multiplicity case. Sorted-by-share table (23 books; unattributed
worst-chapter lines omitted here, present in the full console output and the
JSON report):

```
title                                                        lang  src       spoken tag  narrIdSpoken share  modelN demotedN unknownOriginN unattr split orphan tagNarr dashOnly cast state
Юный дрессировщик                                             ru  declared    279   58     193        88.5%     0      0        193           56     5      0      52       17    7  ok
Ночной дозор (Tetralogy)                                       ru  declared   1928  521     147         8.9%     0      0        147           12   250     29     443     1719   34  ok
Unraveled                                                       en  declared   2054  615      84         4.5%     0      0         84          168     2      0     527        0   11  ok
Everblaze                                                       en  declared   4265 1538     136         3.3%     0      0        136          155    11      0    1223        0   34  ok
Neverseen                                                       en  declared   5822 2584     180         3.2%     0      0        180          179     6      0    1790        0   53  ok
Exile                                                            en  declared   3634 1190      94         2.7%     0      0         94           92    13      0     898        0   35  ok
煤落的委托                                                        zh  declared    128   52       3         2.5%     0      0          3            6     0      3      39        0    9  ok
Keeper of the Lost Cities                                       en  declared   3795 1176      89         2.5%     0      0         89          177     4      0     861        0   35  ok
Playing with Fire                                                en  declared   2238  787      43         2.5%     0      0         43          210   275      6     713        0   32  ok
コールフォールの依頼                                              ja  declared    128   53       3         2.4%     0      0          3            2     0      0       5        0   10  ok
Stellarlune                                                      en  declared   5586 1773     101         2.2%     0      0        101         1028    13      0     925        0   39  ok
Bonus Keefe Story                                                en  declared    101   31       2         2.2%     0      0          2            8     0      0      29        0    3  ok
Scepter of the Ancients                                          en  declared   2744  827      48         1.9%     0      0         48          205     0      0     723        0   22  ok
The Lost Art of World Domination                                 en  declared    187   45       2         1.2%     0      0          2           20     3      0      43        0    3  ok
El Encargo de Coalfall                                            es  declared    127   53       1         1.1%     0      0          1            4     0     32      11        0   12  ok
La Commande de Coalfall                                            fr  declared    128   54       1         1.0%     0      0          1            2     0     23      18        0   12  ok
Der Auftrag von Coalfall                                            de  declared    128   49       0         0.0%     0      0          0            1     5      2      48        0   14  ok
The Coalfall Commission                                              en  declared    128   51       0         0.0%     0      0          0            2     0     62      51        0   12  ok
Заказ Коалфолла                                                       ru  declared    115   48       0         0.0%     0      0          0            4     2     18       9        0   12  ok
Unlocked                                                                en  declared   2057  678       0           —     0      0          0         2057     0      0       4        0   22  ok
Ночной дозор (C2 throwaway)                                              en  declared    220    1       0           —     0      0          0          220     0      0       0        0   37  ok
Ночной дозор (C2C3 run 2)                                                en  declared    220    1       0           —     0      0          0          220     0      0       0        0   19  ok (not analysed)
Ночной дозор (C2C3 run)                                                  en  declared    220    1       0           —     0      0          0          220     0      0       0        0   37  ok (not analysed)
```

Full JSON report generated at
`server/handoff/cache/attribution-measurement-report.json` (git-ignored,
local to the worktree that ran it — not attached to this doc).

## 2 · What the run must show

- [ ] A row for every live book, none blank.
- [ ] Both live CJK books (`煤落的委托`, `コールフォールの依頼`) at `spokenTotal > 0`.
- [ ] `dashOnlySpoken` non-zero on the two Russian books (`Юный дрессировщик`,
      `Ночной дозор`).
- [ ] `orphanSpoken` non-zero on the books carrying unresolvable ids, with the
      share unaffected (D9 — orphans reported, never summed into
      `narratorIdSpoken`).
- [ ] `unattributedSpeech`/`demotedNarrator` printed for every book (a zero is
      a value, not a blank).
- [ ] **`demotedNarrator: 0` on every book is a finding to investigate only if
      no book in the corpus has been re-analysed since `priorCharacterId`
      shipped — confirm which case this run is in** (see §3).

**Result: PASS on the partial run above.** [x] every book row present, none
blank. [x] both CJK books `spokenTotal > 0` (128 each). [x] `dashOnlySpoken`
non-zero on both Russian books (17, 1719). [x] `orphanSpoken` non-zero on
several books, all reported alongside the share and never summed into it —
concentrated in the *Coalfall Commission* family (0/23/32/2/62/18 across its
five language editions), matching D9's "reported, not summed" design; the
share stays a clean 0.0–2.5% on those same books despite the orphan counts.
[x] `unattributedSpeech` printed (as a real number, including 0) on every
row. `demotedNarrator: 0` on all 23 — this is the "no book re-analysed
since shipping" case, confirmed in §3, not the R-9C1 finding recurring.

## 3 · The D18-trap sanity check

Every cache written before `priorCharacterId` existed reads its narrator
population entirely into `unknownOriginNarrator`, never `modelNarrator` —
this is the documented, correct behaviour (spec D18), not a bug. Confirm:

- [ ] `unknownOriginNarrator` is non-zero on at least one book with real
      narrator-attributed dialogue.
- [ ] `modelNarrator` and `demotedNarrator` are both 0 on every book that has
      **not** been re-analysed since this PR merged.
- [ ] Re-analyse **one** real book after this PR is live, re-run the script,
      and confirm `modelNarrator`/`demotedNarrator` populate on that book
      specifically (proves site 1, `reconcileSentenceCharacterIds`, actually
      fires in production — the mutation-tested proof it fires in isolation
      lives in `server/src/routes/analysis.test.ts`, not here).

**Result: first two boxes PASS on the partial run above** —
`unknownOriginNarrator` is non-zero on multiple books (193 on `Юный
дрессировщик`, 147 on `Ночной дозор`, etc.) and `modelNarrator`/
`demotedNarrator` are both 0 across all 23, consistent with "no book
re-analysed since `priorCharacterId` shipped" rather than a missing-
instrumentation defect. **Third box STILL OWED** — needs a real re-analysis
run (GPU/analyzer time) after this PR merges; not exercised by this pass.

## 4 · Dash-stripped invariance (criterion 3, on-box)

Run the script twice: once as-is, once over scratch-path copies of each
cache with every sentence's leading dash stripped
(`s/^\s*[-–—]\s*//` on `text`). Diff the two JSON reports — **every field of
every row must be identical.**

**Result: NOT YET RUN.** The equivalent property is pinned in
`server/src/store/attribution-health.criteria.test.ts`'s two-tier
punctuation-invariance suite (Tier A/B, per-language-family fixtures) and
confirmed there; this is the real-corpus repeat of that same check, still
owed.

## 5 · D13 verdict — re-measure the orphan-share gap under the current unit

Compute, per book, `orphanSpoken / (spokenTotal - unattributedSpeech -
splitSpeech)` (spec §D13 re-gated's corrected denominator) and check whether
a separating gap survives D14's rebasing.

**Result: PARTIAL, from the §1 table above — RE-VERIFIED 2026-08-13 against
the finding-1-fixed `orphanSpoken`.** Non-zero orphan shares
(`orphanSpoken / (spokenTotal - unattributedSpeech - splitSpeech)`, sorted):
`The Coalfall Commission` 49.2%, `El Encargo de Coalfall` 26.0%, `La Commande
de Coalfall` 18.3%, `Заказ Коалфолла` 16.5% — then a gap down to `煤落的委托`
2.5%, `Ночной дозор (Tetralogy)` 1.7%, `Der Auftrag von Coalfall` 1.6%,
`Playing with Fire` 0.34%, then zero on the remaining 15 books (previously
this row named `The Lost Art of World Domination` instead of `Ночной дозор
(Tetralogy)` for the second book in that middle pair — that was always
wrong, `The Lost Art of World Domination`'s own `orphanSpoken` is 0; fixed
here alongside the finding-1 re-measurement). All four top-group
percentages, and the low-group max (`煤落的委托` 2.5%), are numerically
**unchanged** by the finding-1 fix — none of those five books' split spans
carried more than one bogus id, so the fix's only real-corpus effect landed
on `Ночной дозор (Tetralogy)` (1.80%→1.74%), which was never in the "high"
group. **The gap is real but roughly 6–7×, not the round-7 gate's claimed
order of magnitude (~10×), and — this is the more important caveat — the
entire "high" group is one book family** (*The Coalfall Commission*'s five language editions,
Castwright's own canonical e2e/regression fixture, which has been
re-analysed and re-cast repeatedly during development). A repeatedly-
retested fixture book is exactly the shape that would accumulate unusual
`cast-id-history.json` churn independent of anything a real reader's library
would produce, so this sample cannot distinguish "D13's bimodality survives
D14's rebasing" from "one heavily-churned test book dominates the top of a
23-book sample." **Verdict: inconclusive, not disqualifying.** The mechanism
(D13's design — orphan share as its own state, never summed into the
collapse share) still holds; nothing here contradicts it. But this sample is
not sufficient evidence to set `DRIFT_SHARE_THRESHOLD` from — Wave 2 needs at
minimum the Coalfall family excluded or re-weighted, and ideally a wider
non-fixture sample, before treating this gap as calibration rather than a
single suggestive data point.

## 6 · Owner question 4 — how far `tagTotal` moves against the case heuristic

The parser's D15 rule (a tag clause must carry a `speechVerbStems`/
`beatVerbStems` verb, else the whole dialogue text downgrades to one
unanchored speech span) is stricter than the case-based heuristic (a
Russian tag half continues the sentence, so it opens lowercase — no verb
check at all). Measured with a one-off diagnostic (not shipped; reimplements
only the dash-paragraph toggle-cut regex, unconditionally, and compares
against the parser's own tag-span count **restricted to dash paragraphs
only**, since the case heuristic has no equivalent for the quote-paragraph
tag spans the parser also finds):

| Book | parser tagTotal (dash paras only) | case-heuristic tagTotal (dash paras only) | delta |
|---|---|---|---|
| Юный дрессировщик | 3 | 4 | +1 (+33%, negligible in absolute terms — this book's dialogue is mostly quote-based, 55 of its 58 total tag spans come from quote paragraphs the case heuristic doesn't touch) |
| Ночной дозор | 389 | 598 | +209 (+54% relative to the dash-paragraph count; **+40% relative to the book's whole `tagTotal` of 521**) |

**The effect is real and highly book-dependent** — negligible on one Russian
book, substantial (~40% of book-wide `tagTotal`) on the other. This is the
number owed by Wave 1 per the owner's decision; it does not reopen the rule
(the parser stays the D15 rule), but Wave 2 should treat `tagTotal` as a
volatile column when comparing books analysed under different code
versions.
