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

**Result: COMPLETE, 2026-08-14, primary checkout at `df49a261`.** The
full-checkout run this item actually asks for. Run from
`C:\Claude\Projects\Audiobook-Generator` after `npm --prefix server run
build`, against `WORKSPACE_DIR=C:\AudiobookWorkspace`, read-only throughout —
no copied caches, so every book's `hasCacheFile`/`state` reflects its real
analysis history rather than a worktree's subset. A row for every one of the
23 books, none blank; 21 measurable, and the two `ok (not analysed)` rows are
genuinely un-analysed C2/C3 throwaways rather than the worktree artifact that
forced the 2026-08-13 caveat.

**Twenty of the 23 books are numerically identical in every column to the
table above.** Diffed column-by-column against it, exactly three moved:

| Book | What changed |
|---|---|
| Everblaze | `spoken` 4265 → 4266 |
| Keeper of the Lost Cities | `spoken` 3795 → 3796 |
| Ночной дозор (Tetralogy) | `spoken` 1928 → **2122**, `tag` 521 → 605, `narrIdSpoken` 147 → 229, `unattr` 12 → 9, `split` 250 → 337, `orphan` 29 → **32**, `tagNarr` 443 → 544, `dashOnly` 1719 → 1940 |

That is the parser work merged between the two runs finding ~194 more speech
spans in the one dash-convention Russian book. **It is not #2286**: the same
corpus was measured on both sides of that merge and every cell of every row
was identical, so the twelve added `secondaryQuotePairs` moved nothing here.
Treat `tagTotal` and `spokenTotal` as volatile across analyzer versions —
this is the second time that has been demonstrated on this corpus.

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

**Result: COMPLETE, 2026-08-14, primary checkout at `df49a261`.** The
2026-08-13 partial run below is kept for provenance; the re-gate proper is
the section that follows it, and it answers the question that run left open.

<details>
<summary>2026-08-13 partial run (superseded — kept for provenance)</summary>

Non-zero orphan shares, sorted: `The Coalfall Commission` 49.2%, `El Encargo
de Coalfall` 26.0%, `La Commande de Coalfall` 18.3%, `Заказ Коалфолла` 16.5%
— then a gap down to `煤落的委托` 2.5%, `Ночной дозор (Tetralogy)` 1.7%, `Der
Auftrag von Coalfall` 1.6%, `Playing with Fire` 0.34%, then zero on the
remaining 15 books. **The gap is real but roughly 6–7×, not the round-7
gate's claimed order of magnitude (~10×), and the entire "high" group is one
book family.** That run could not distinguish "D13's bimodality survives
D14's rebasing" from "one heavily-churned test book dominates the top of a
23-book sample," and recorded **inconclusive, not disqualifying**, asking for
the Coalfall family excluded or re-weighted before the gap was treated as
calibration.

</details>

### 5a · The shares, re-measured at `df49a261`

Same formula, same corpus, run from the **primary checkout** (so this is also
the full-checkout run E11 item 1 asks for — see §1). Twenty of the 23 books
are **numerically identical in every column** to the 2026-08-13 table; the
three that moved are named in §1. Sorted, non-zero only:

| Book | orphan / denominator | share | family |
|---|---|---|---|
| The Coalfall Commission | 62 / 126 | **49.21%** | fixture |
| El Encargo de Coalfall | 32 / 123 | **26.02%** | fixture |
| La Commande de Coalfall | 23 / 126 | **18.25%** | fixture |
| Заказ Коалфолла | 18 / 109 | **16.51%** | fixture |
| 煤落的委托 | 3 / 122 | 2.46% | fixture |
| Ночной дозор (Tetralogy) | 32 / 1776 | 1.80% | real |
| Der Auftrag von Coalfall | 2 / 122 | 1.64% | fixture |
| Playing with Fire | 6 / 1753 | 0.34% | real |

The remaining 15 books are at exactly **zero**. So the raw gap reproduces:
16.5–49.2% against ≤2.5%, a 6.7× step.

**Excluding the *Coalfall Commission* family, the corpus's maximum orphan
share is 1.80%, and 15 of its 16 non-fixture books are at zero.** There is no
high group among real books at all — which is the question the 2026-08-13 run
asked and could not answer.

### 5b · Why the fixture family is high — measured, not hypothesised

The prior run *hypothesised* `cast-id-history.json` churn. That hypothesis is
now testable and turns out to be the wrong mechanism with the right instinct:
these books' orphans do not come from recorded id history, they come from
**hand-edited `cast.json` renames that never went through `retireCharacterId`
at all.**

Per book, each orphan id was classified against three sources on disk — the
live `cast.json`, every `cast.json.bak.*` beside it, and
`cast-id-history.json`:

| Book | orphan ids | present in a `cast.json` **backup**, absent live, never retired |
|---|---|---|
| The Coalfall Commission | `berrin`, `brann`, `coalfall`, `oduvan` | `coalfall`, `oduvan` — both in `cast.json.bak.prewipe-20260714` |
| El Encargo de Coalfall | 5 ids | **all five** |
| La Commande de Coalfall | `berrin`, `brann`, `pell-hollis`, `voix-inconnue` | first three |
| Заказ Коалфолла | `berrin`, `brann`, `lessom`, `unknown-male` | first three, plus `unknown-male` |

The live casts carry the renamed forms (`master-oduvan`, `coalfall-dragon`,
`brann-weir`, `berrin-weir`); the caches still carry the pre-rename ids. Split
through the production resolver, `coalfall` (28 spans) and `oduvan` (22)
account for **50 of The Coalfall Commission's 62 orphan spans** on their own.

**The natural experiment settles it.** `Заказ Коалфолла` records exactly the
same rename — `"coalfall": "coalfall-dragon"` in its `cast-id-history.json` —
and consequently carries **zero** orphan spans for `coalfall`. The English
edition, where the identical rename was applied by hand, carries **28**. Same
rename, one edition recorded it, the other did not, and only the unrecorded
one produces a drift signal.

**A corollary worth stating plainly: `retireCharacterId` works.** Fourteen
retirements exist across five books, and **not one retired id appears as an
orphan anywhere in the corpus.** Every orphan measured here arose from a path
that bypassed the mechanism — which, for a hand-edited fixture, is exactly
what one would expect and is not reachable through the UI.

### 5c · The real-book residual is unlinkable by construction

`Ночной дозор (Tetralogy)` is the only non-fixture book that clears
`MIN_ORPHAN_FOR_VERDICT = 20`. Splitting its 32 spans per id, through the
production resolver:

| orphan id | spans | share | linkable? |
|---|---|---|---|
| `driver` | 22 | 1.24% | no — names no character |
| `boris-igoryevich` | 5 | 0.28% | **yes** |
| `woman-in-taxi` | 4 | 0.23% | no |
| `vampire-boy` | 1 | 0.06% | no |
| `vampire-girl` | 1 | 0.06% | no |

**28 of 32 spans (87.5%) belong to ids no user can ever link** — the exact
class §"Not the same character" names (`unknown-male`, `voix-inconnue`,
`the-jogger`, `driver`, `woman-in-taxi`). The only linkable id accounts for
0.28%. `Playing with Fire`'s sole orphan id is `pool-player-2` (6 spans,
0.34%), also unlinkable, and below the floor regardless.

### 5d · D13's only exit has never been exercised

R-8M1 added the bare-`rejected` acknowledgement specifically so a book whose
residual orphans are unlinkable is not permanently badged and blocked. **No
book in this corpus has a `rejected` entry — the key is absent from all five
`cast-id-history.json` files.** So `unacknowledgedOrphanSpoken ===
orphanSpoken` on all 23 books, and the exit has zero real-data support.

### 5e · Verdict

**The bimodality does not survive.** A separating gap exists, but every book
above it is a development fixture whose orphans were produced by an operation
a user cannot perform. That leaves no threshold that badges a real problem:

- **≥ 2.5%** — badges only the *Coalfall Commission* family, i.e. nothing a
  reader's library would contain.
- **≤ 1.8%** — badges `Ночной дозор`, where 87.5% of the orphan mass is
  unlinkable and the only exit is untested. That is R-8M1's "gate with no
  exit," arriving on the very first real book D13 fires on.

Against the spec's own bar — *"if the bimodality does not survive the
re-basing, D13 is dropped rather than shipped with a threshold picked off a
book"* — **this re-gate fails, and the bar says drop.**

**What is not in question:** the measurement itself is useful. `orphanSpoken`
and `orphanIds` correctly found four books with stale caches behind
hand-edited casts, which is a real (developer-facing) defect the column
surfaced on its first real run. The finding is about the fifth *state*, not
the column.

**This is an owner decision, and it is recorded in the spec** (§D13 re-gated
→ *Re-gate outcome*) rather than settled here. The options and the
recommendation live there.

### 5f · Reproducing this

```
cd server && npm run build && cd ..
WORKSPACE_DIR=C:\AudiobookWorkspace node scripts/measure-attribution.mjs
```

for §5a. §5b–§5c were measured with two throwaway harnesses that import the
**compiled** `attribution-health-io.js` / `attribution-health.js` and
re-implement nothing: one classifying each orphan id against the live cast,
the `cast.json.bak.*` files and `cast-id-history.json`; one splitting spans
per id by doctoring `history.supersededBy` so that every orphan id *except*
the target resolves, leaving the recomputed `orphanSpoken` as that id's own
count. Both carried positive controls that can fail — notably "redirect
**every** orphan id and `orphanSpoken` must reach 0", without which an inert
doctoring would print a plausible table of noise. All controls passed. The
harnesses are scratch, not shipped; the method above is the record.

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
