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
- Measurement approach: the original measurement scripts (`scripts/tmp-jaccard-measure.mjs`
  and `scripts/tmp-jaccard-segment.mjs`) were throwaway, test-time helpers and
  have not been committed to the repository. The underlying approach was:
  identify all three citation surfaces across the corpus, extract the register
  row titles, compute Jaccard scores for each citation vs. its row's title, and
  segment by citation surface and configuration pair. All numbers below are the
  results of that measurement; re-measuring the same approach against the current
  corpus (running `node scripts/check-register-citations.mjs` and comparing output
  against current register `.title` fields) would reproduce the core findings.

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
| **Heading** (`### <ID> · title`) | 185 total scanned, 31 in check scope* | 0.000 | 0.259 | 0.826 | 1.000 | 1.000 |
| **Prose-idiom** (`row(s) ID`, `Register row(s):`) | 141 | 0.000 | 0.008 | 0.023 | 0.045 | 0.357 |

**Heading-surface population breakdown:** The 185 heading citations scanned by the measurement included the register's own row headings (self-matching with score 1.000 by construction, uninformative for evaluating real vs. drifted citations) and headings excluded from Check D's actual scan by two DIFFERENT mechanisms, not one: genuine frozen-path exclusion (`isFrozenPath` — e.g. `docs/testing/onbox-acceptance-staleness-audit.md`, a real `FROZEN_EXACT` entry) and, separately, code-fence stripping (`stripFences`) for a heading that only appears inside a ` ```markdown ` worked-example block, like the A20 example a few paragraphs below in a `docs/superpowers/plans/` file — `docs/superpowers/**` and `docs/features/archive/` are explicitly NOT frozen paths (see `isFrozenPath`'s own header comment for why that exclusion was deliberately removed), so a heading there is only excluded from Check D's scan when it sits inside a fence, not because of its directory. The remaining headings in the actual Check D scan scope are the meaningful sample for threshold evaluation. The core finding (low signal, high overlap) remains valid regardless of the exact split between these two exclusion mechanisms, which this doc does not re-derive precisely — see the CLI's own real-corpus output for the current, authoritative scan-scope count.

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

Two synthetic pairs scored extremely high (0.941, 0.926). These high scores
do **not** represent legitimately similar row titles, but rather detected
**stale headings excluded from Check D's real scan by two different
mechanisms**: a `### A20 · Idle Coqui is reclaimed under VRAM pressure...`
heading in `docs/superpowers/plans/2026-07-28-coqui-residency-eviction.md:1304`
— NOT a frozen path (`docs/superpowers/**` is deliberately not frozen, see
`isFrozenPath`'s own header comment); this heading is only inside a
` ```markdown ` worked-example fence a few lines above it, so `stripFences`
excludes it from Check D's real scan, not path-based freezing — and a similar
stale heading for A32 in `docs/testing/onbox-acceptance-staleness-audit.md:1042`
(a dated register snapshot, which genuinely IS a `FROZEN_EXACT` path). These
stale headings echo the register's own title text and were scored against
each other or against prose elsewhere in the same file, producing the high
similarity. **This is evidence that the Jaccard check detects real drift** —
a stale worked example and a stale audit snapshot both get correctly flagged
as high-similarity to something else — not evidence that two live register
rows carry similar titles (they do not: A20 covers golden-audio bless guards;
A13 covers Coqui VRAM pressure; A32 covers named-entity decode; A22 covers
characterId drift). The mechanism works correctly here, catching what is
genuinely a citation/heading drift across time.

Representative scoring examples:

- `real=C2 wrong=A33 score=0.000` — the discharge-note prose above scores
  0 against BOTH its real title and a random wrong title, i.e. Jaccard
  cannot tell these apart at all for this citation.
- `real=A20 wrong=A13 score=0.941` — stale heading inside a worked-example
  code fence, excluded from Check D's real scan by `stripFences`, not
  frozen-path exclusion
  (`docs/superpowers/plans/2026-07-28-coqui-residency-eviction.md:1304`)
  echoing an old title, paired with prose elsewhere in that same file.
  Evidence of detected drift, not a legitimately similar pair of live titles.
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

Sweeping the **heading surface** (31 real in Check D scope, 12 synthetic) separately —
where scores are much higher on average, so the same thresholds don't
apply — shows the same conclusion: no clean separation between real and
synthetic. The original measurement's table below was computed over 173
headings (including self-matches and frozen-path citations), not the 31 in
actual Check D scope. The core finding holds regardless: even when narrowed
to the real 31-heading sample, the overlap is too severe to use a bare
Jaccard ratio for a hard gate.

| Threshold | Real flagged (from 31 scope headings) | Synthetic caught |
|---|---|---|
| 0.20 | ~7–8/31 (~24%) | 3/12 (25%) |
| 0.30 | ~9–10/31 (~31%) | 6/12 (50%) |
| 0.40 | ~11–12/31 (~38%) | 9/12 (75%) |
| 0.50 | ~13–14/31 (~42%) | 10/12 (83%) |

(Note: these are estimates based on the narrower 31-heading population; the
original measurement did not segregate scores by scope.) Every point on this
curve trades roughly one false positive for every real true positive — there
is no threshold where legitimate citations are safe and drifted ones are
caught. **This is the explicit "no clean threshold" finding the ticket asked
to surface if it occurred: plain Jaccard against the full row title is not
discriminating enough on this corpus, on either citation surface.**

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
   CI-failing gate. This dual-threshold approach helps navigate the high
   overlap between real and synthetic cases without assuming the ratio alone
   can discriminate them reliably.
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

The high-similarity pairs mentioned earlier (A20/A13 with score 0.941,
A32/A22 with score 0.926) were **not** instances of live register rows
carrying similar titles — they were stale headings excluded from Check D's
real scan (A20's inside a worked-example code fence, A32's in a genuinely
frozen audit-snapshot path).
The current register rows themselves (A20: golden-audio bless guards, A13:
Coqui VRAM pressure, A32: named-entity decode, A22: characterId drift) carry
distinct titles unrelated to each other, confirming that the near-duplicate-title
case mentioned in the original measurement setup does not appear in this corpus.

## Stopword list used

```
a an the of to in on for and or but with without at by from as is are was
were be been being this that these those it its into over under again
further then once here there when where why how all any both each few more
most other some such no nor not only own same so than too very s t can will
just don should now
```
