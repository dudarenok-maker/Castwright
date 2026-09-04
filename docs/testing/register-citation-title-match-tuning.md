# Register-row title-drift threshold tuning (v2 of `check:register-row-citations`)

> Measurement task for [#2870](https://github.com/dudarenok-maker/Castwright/issues/2870),
> feeding the second task child of [#2838](https://github.com/dudarenok-maker/Castwright/issues/2838).
> This ticket is measurement only — no production check is implemented here.

## Bottom line

**Plain Jaccard token-overlap between a register row's `.title` and the prose
that cites it does NOT cleanly separate real citations from genuine
title-drift mismatches in this corpus, on either citation surface.** The two
distributions overlap enough that no single threshold gets acceptable
precision and recall together — see the numbers below. Section
["No clean threshold — recommendation"](#no-clean-threshold--recommendation)
gives the concrete alternative for the second task child.

## Method

- Corpus: every git-tracked `.md` file under `docs/testing/**` and
  `docs/features/**` (48 files carried at least one citation), scanned with
  the same three citation surfaces `checkNonexistentIds` (Check A) already
  recognizes — reimplemented read-only in the throwaway script below, not
  imported, since the production file doesn't export them:
  1. the `row(s) [:]? ID[, ID ...]` prose idiom (`ROW_CITATION_REGEX`);
  2. a `Register row(s):` label line, with en-dash range expansion
     (`extractIdTokensWithRanges`);
  3. an anchored `### <ID> · …` section heading (`HEADING_ID_REGEX`).
- For each citation, the row's canonical `.title` (via `parseRegisterRows`)
  was compared against the **paragraph containing the citation** (the
  blank-line-delimited block around the citing line, taken from the same
  fence-stripped/de-bolded/code-span-stripped text Check A itself scans, so
  line numbers line up).
- Score: Jaccard = `|intersection| / |union|` of lowercased,
  punctuation-stripped token sets, computed under **four configurations** to
  decide the two open questions from the ticket body:
  - `excludeId` (false/true): whether the register-row-ID token itself (e.g.
    `A18`) is stripped from both sides before scoring.
  - `stripStopwords` (false/true): whether a small English stopword list is
    removed from both sides first.
- Script: `scripts/tmp-jaccard-measure.mjs` (throwaway, not committed to
  production — reads `docs/testing/**`/`docs/features/**`, writes
  `tmp-jaccard-results.json`) and `scripts/tmp-jaccard-segment.mjs`
  (throwaway follow-up that segments the results by citation surface). Both
  are left in the worktree for reference but are **not part of this commit's
  intended shipped output** — only this `.md` file is.

**Decision on the two open questions:**
- **ID-token exclusion barely moves the numbers** (real-corpus median moves
  from 0.100 to 0.103 across all citations) — the ID token is a single word
  out of dozens in a title/paragraph, so it rarely swings the ratio. Exclude
  it anyway: it is free and removes one degenerate case (an ID-only overlap
  inflating an otherwise-unrelated pair).
- **Stopword stripping also barely moves the numbers** (median 0.100 →
  0.100) but very slightly *tightens* the real-corpus tail (q3 0.923 →
  0.909). Keep it: it is the theoretically correct choice (stopwords are
  never meaningful content signal) even though this corpus's titles/prose
  are short enough that it rarely matters in practice.
- All numbers below use `excludeId=true, stripStopwords=true` unless stated
  otherwise.

## Real-corpus distribution

**314 total citations** scored across 48 files. The two citation surfaces
behave very differently and must be reported separately — pooling them
hides the real signal:

| Surface | n | min | q1 | median | q3 | max |
|---|---|---|---|---|---|---|
| **Heading** (`### <ID> · title`) | 173 | 0.000 | 0.259 | 0.826 | 1.000 | 1.000 |
| **Prose-idiom** (`row(s) ID`, `Register row(s):`) | 141 | 0.000 | 0.008 | 0.023 | 0.045 | 0.357 |

**Why they differ so much:** a heading citation's surrounding text is
literally `### <ID> · <the row's own title text>` — it tautologically
repeats the title (that's what a heading *is*), so its score is near 1.0
whenever nothing has drifted. A prose-idiom citation ("register row A21
recorded in...", "mark rows E1, E2... discharged") almost never restates the
row's title — it references the row *by ID* while talking about something
else (a discharge note, a cross-reference, a sitting-pack index) — so its
real-corpus floor is near 0 by design, not because anything is wrong.

**Lowest 10 real (prose-idiom-dominated) examples**, illustrating that a
near-zero score is normal, not suspicious:

| Row | Score | Location |
|---|---|---|
| C2 | 0.000 | `docs/features/247-dialogue-structure-attribution.md:460` |
| C1 | 0.000 | `docs/features/261-manuscript-scene-separator.md:301` |
| A16 | 0.000 | `docs/features/275-clone-voice-language.md:405` |
| A17 | 0.000 | `docs/features/archive/273-sidecar-lock-event-loop.md:1054` |
| A21 | 0.000 | `docs/features/archive/274-loudness-measurement-provenance.md:994` |
| A14 | 0.000 | `docs/features/archive/274-loudness-measurement-provenance.md:997` |
| A15 | 0.000 | `docs/features/archive/274-loudness-measurement-provenance.md:997` |
| A22 | 0.000 | `docs/features/archive/280-cast-identity-followups.md:2697` |
| E10 | 0.000 | `docs/features/archive/283-castwright-local-rebind.md:9` |
| E10 | 0.000 | `docs/features/archive/283-castwright-local-rebind.md:193` |

Example (C2): title is *"Dialogue-convention invariant end to end
(#2253)"*; the citing prose is *"This discharged register row C2 as numbered
before 2026-08-06. Note that 'C2' was reused..."* — a completely legitimate
citation (a discharge note explaining ID reuse) that shares almost no
vocabulary with the title, because it isn't describing the row's content at
all.

## Synthetic mismatches

20 pairs (double the required 10), constructed **data-drivenly rather than
by hand-picking easy negatives**: for each of 20 sampled real citations, the
citing prose was scored against *every other row's title in the register*
and paired with whichever wrong row scored **highest** — i.e. each synthetic
pair is the *hardest available* mismatch for that piece of prose, which is
what actually stress-tests a threshold (an easy, unrelated mismatch proves
nothing about discriminating power).

| Surface | n | min | q1 | median | q3 | max |
|---|---|---|---|---|---|---|
| Heading-surface synthetic | 12 | 0.060 | 0.207 | 0.333 | 0.375 | 0.941 |
| Prose-idiom synthetic | 8 | 0.000 | 0.016 | 0.030 | 0.050 | 0.179 |
| All 20 | 20 | 0.000 | 0.050 | 0.179 | 0.333 | 0.941 |

Two synthetic pairs scored extremely high (0.941, 0.926) not because Jaccard
failed, but because they exposed a **real data property**: rows `A20`/`A13`
and `A32`/`A22` carry near-identical titles for different rows (e.g. A20's
title *"Idle Coqui is reclaimed under VRAM pressure (#1894) · single 8 GB
card"* is nearly word-for-word A13's title). A citation that *should* say
A20 but was mistyped as A13 would be genuinely undetectable by any
text-similarity metric here, because the two rows' titles are themselves
near-duplicates. This is itself worth flagging to a human independently of
this ticket's scope — see "Also worth noting" below.

The full pair list (all 20, with scores and locations) is in
`tmp-jaccard-results.json`; representative examples:

- `real=C2 wrong=A33 score=0.000` — the discharge-note prose above scores
  0 against BOTH its real title and a random wrong title, i.e. Jaccard
  cannot tell these apart at all for this citation.
- `real=A20 wrong=A13 score=0.941` — near-duplicate real titles (see above).
- `real=E1 wrong=E7 score=0.333` — plausible confusion (`E1`/`E7` are both
  Pinokio-installer-adjacent rows explicitly cross-referenced as "group with
  E1" in each other's titles).

## No clean threshold — recommendation

Sweeping candidate thresholds against **prose-idiom citations** (141 real,
8 synthetic) shows the real-vs-synthetic overlap is too severe to use:

| Threshold | Real flagged (false positives) | Synthetic caught (true positives) |
|---|---|---|
| 0.05 | 112/141 (79%) | 6/20* |
| 0.10 | 131/141 (93%) | 9/20* |
| 0.20 | 139/141 (99%) | 11/20* |
| 0.30 | 140/141 (99%) | 14/20* |

*(caught-count is out of all 20 synthetic pairs, since the low real-prose
floor means even a low threshold already flags nearly every legitimate
prose-idiom citation)*

Sweeping the **heading surface** (173 real, 12 synthetic) separately —
where scores are much higher on average, so the same thresholds don't
apply — still shows no clean separation:

| Threshold | Real flagged | Synthetic caught |
|---|---|---|
| 0.20 | 36/173 (21%) | 3/12 (25%) |
| 0.30 | 51/173 (29%) | 6/12 (50%) |
| 0.40 | 62/173 (36%) | 9/12 (75%) |
| 0.50 | 67/173 (39%) | 10/12 (83%) |

Every point on this curve trades roughly one false positive for every real
true positive — there is no threshold where legitimate citations are safe
and drifted ones are caught. **This is the explicit "no clean threshold"
finding the ticket asked to surface if it occurred: plain Jaccard against
the full row title is not discriminating enough on this corpus, on either
citation surface.**

### Recommendation for the second task child

Do **not** implement a whole-title Jaccard-ratio gate as originally scoped.
Instead:

1. **Skip prose-idiom citations entirely.** Their real-corpus floor (median
   0.023) is indistinguishable from a genuine mismatch's floor (median
   0.030) — there is no signal here at all with this metric family. A
   prose-idiom citation only names an ID; it was never meant to restate the
   row's title, so title-similarity is the wrong question for this surface.
   ID-existence (Check A, already shipped) is the correct and sufficient
   check for prose-idiom citations.
2. **For heading citations only**, if a check is still wanted, don't use a
   bare ratio — require **both** a ratio floor (informational, e.g. flag
   below ~0.3 as "review this") **and** a minimum shared-content-token count
   (e.g. at least 2 non-stopword, non-ID tokens in common) before treating
   it as a hard failure, and treat the whole thing as advisory rather than a
   CI-failing gate. The near-duplicate-title cases above (A20/A13, A32/A22)
   mean even a well-tuned ratio will sometimes be structurally blind to a
   real ID swap, and a hard CI failure on a metric known to have this blind
   spot would train contributors to distrust or route around the gate.
3. If a hard, CI-appropriate gate is still desired despite (1) and (2), the
   next-best alternative flagged by this data is **not** a different
   similarity family (that's out of scope per the ticket, and also not
   obviously better — the *problem* is that citing prose legitimately
   doesn't restate titles, which no single-document similarity metric
   fixes) but a **structural** check instead: verify that a heading's
   `### <ID> · <text>` suffix, when a NEW heading is added or an existing
   one is edited, is close to the register's own title FOR THAT ID **at
   commit time** (a diff-aware check, not a whole-corpus scan) — this at
   least avoids re-litigating the entire existing, presumed-correct corpus
   on every run, and narrows the false-positive surface to only what
   actually changed.

## Also worth noting (out of this ticket's scope, flagging for a human)

Rows `A20`/`A13` and `A32`/`A22` have near-duplicate titles for different
IDs. Whether that's intentional (two rounds of the same acceptance
criterion, tracked as separate rows) or an unnoticed duplication is a
content question for a human to look at — this ticket only measured the
downstream effect (it makes title-similarity structurally unable to catch a
swap between those specific pairs), it does not resolve the "why."

## Stopword list used

```
a an the of to in on for and or but with without at by from as is are was
were be been being this that these those it its into over under again
further then once here there when where why how all any both each few more
most other some such no nor not only own same so than too very s t can will
just don should now
```
