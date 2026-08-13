---
status: draft
date: 2026-08-06
---

# Attribution collapse visibility: measure it first, then say what happened

Design work behind **#1984** — _"Attribution collapse is invisible: the
dropped-quotes panel shows the last batch only, in a transient view, and never
the effect."_

> **Revision 3.** Revision 1 went through the mandatory adversarial review gate
> and did not survive it: the headline fix was a **placebo**, the metric's
> numerator matched **one of two** narrator ids and missed the orphan class
> entirely, the threshold was **uncalibrated**, and the "shared module"
> safeguard for the library badge **did not exist**. Revision 3 then folded a
> finding from the repo owner that revision 2's own state model could not
> express: a book with a **47-member cast and zero attributed sentences**
> (_Ночной дозор_) rendered as perfectly healthy — the #1984 failure shape,
> inside the feature built to close #1984. Every finding below was re-verified
> against the tree or the live workspace before folding. §Review findings
> records both rounds.
>
> **Revision 4 (2026-08-09).** Measuring the live corpus — the very step
> revision 3 deferred to Wave 1 — found that revision 3's own state model
> **badges a healthy Chinese or Japanese book as damaged and gates its
> generation.** `isSpokenLine` has no CJK bracket support, so every zh/ja book
> scores `spokenTotal === 0`; with a real cast and a completed run's deleted
> snapshot, all three clauses of `missing` are satisfied by a book with nothing
> wrong with it. This is the mirror of R-O1: that finding was a damaged book
> reading as healthy, this is a healthy book reading as damaged, and both come
> from a denominator that cannot see the dialogue it is counting. Revision 4
> makes the denominator language-aware, fixes `isSpokenLine` at the source, and
> reports the gap between the two definitions as a standing regression signal.
> §Review findings round 3 records it.
>
> **Revision 5 (2026-08-10).** Revision 4 went through the adversarial gate and
> **did not survive it.** Its central empirical error: the reconnaissance behind
> it measured `server/handoff/cache/*.json`, **not the library.** The cache
> directory holds **76 files and the workspace holds 20 live books** (plus 2 in
> `_trash`), so **54 caches are orphans with no book at all** — and three of the
> orphans were headline rows of revision 4's acceptance table, including both
> "collapsed" CJK books. Those books are deleted. Revision 4 also closed the CJK
> *instance* of its own Critical while leaving the *class* open behind a
> provably unreachable escape hatch, and shipped a mutation control that its own
> other change disarmed. Revision 5 restated every empirical claim from the
> workspace, threaded a "language unknown" through the resolution chain, and
> fixed the placebo. §Review findings round 4 records all twelve findings.
>
> **Revision 6 (2026-08-11).** Revision 5 went through a scoped re-review and
> **also did not survive it**: 3 of its 12 fixes failed, 2 more failed on their
> numbers, 3 were partial, and folding introduced 6 new defects including an
> interface block that contradicted its own prose 27 lines above. Three changes
> answer all of it.
>
> 1. **The pre-computed distribution is deleted.** This document hand-computed
>    its own acceptance numbers three times and got three different wrong
>    answers, for three different reasons: the cache directory instead of the
>    library (revision 4); `.upgrade-backups/` copies instead of live books (a
>    draft of revision 5); and a numerator that silently dropped D9's orphan
>    half *and* skipped the excluded-chapter filter §Universe mandates (revision
>    5, as shipped). Each attempt re-implemented `isSpokenLine`, the cast
>    resolver and the universe filters by hand and got a different subset wrong.
>    **Producing that table is Wave 1's job, using the real modules.** No share
>    figure appears in this document any more.
> 2. **D9 is narrowed: unresolvable ids are reported *alongside* the collapse
>    figure, never summed into it** (owner's decision, 2026-08-10). See
>    §Numerator.
> 3. **The `unmeasurable` producer is rebuilt around the reachable failure.**
>    Revision 5's `fallback` flag fires only when detection runs, and detection
>    runs only when `state.language` is absent — which no current import path
>    produces. The real hole is a **declared-but-wrong** language, and revision 6
>    corroborates the declaration on the one path where being wrong is expensive.
>
> §Review findings round 5 records all eighteen items.
>
> **Revision 7 (2026-08-11).** The round-6 gate **confirmed revision 6's
> empirical work** — every figure it kept was independently re-derived and held —
> and found four Criticals in the *logic connecting* those figures, one in each
> headline change. Folded in §Review findings round 6. Two are worth naming here:
> the precedence rule and the corroboration step were **circularly ordered**, so
> §Failure modes is now a single explicit sequence rather than a precedence over
> predicates; and the corroboration step **exempted D11's own motivating book**
> (an abandoned run leaves no text to corroborate against), found in self-review
> and fixed before the gate reported.
>
> **The gate's headline finding was rejected on new evidence and then partly
> upheld by the owner.** It argued D9's narrowing reports a 50%-orphaned book as
> healthy; the book's segments files carry the **resolved** ids, so no rendered
> audio is affected and the owner's "inaudible" premise held. But the cache is
> what the *next* render reads, so the silence was real. **D13 adds a fifth
> state, `drifted`** — it badges, it gates, and its notice sends the user to the
> Cast orphan banner rather than to a re-analysis that cannot fix drift and would
> discard the book's audio.
>
> **D13 then went through its own scoped gate and did not survive its first
> draft** — three Criticals, folded here; §Review findings round 7. The sharpest
> turns on the same fact that rebutted round 6: the segments carry the *resolved*
> ids, which is why there is no present damage **and** why the Cast orphan
> banner — fed from rendered segments — has **zero rows on every book D13 fires
> on.** The notice pointed at an empty list. So the banner gains a cache-sourced
> tier, and the generation gate moves to `enqueueQueueEntries`, the chokepoint
> every re-synthesis path actually crosses — which closes the same bypass for
> `collapsed`. Two smaller consequences worth reading before approving: the
> dismissal key is over the measurement's **outputs**, not the resolver's inputs,
> and "Not the same character" now counts as an acknowledgement, because
> otherwise a book whose orphans name nobody is gated forever with no exit.
>
> **Revision 8 (2026-08-13) — rebaseline.** The document sat unmerged for a week
> while its branch fell **559 commits** behind `main`, and the tree moved under
> it in one specific direction: **#2245 made `isSpokenLine` conventions-driven**,
> #2253 landed the dialogue-convention invariant, #2289 added `&ndash;` to `es`/
> `fr` `dialogueOpen`, and #2288 M1 landed quote-delimiter validity in
> `findQuoteRuns`. Two of revision 7's headline changes are **already in the
> tree**, and its central measurement idea is now **known to be unsafe**.
> Revision 8 deletes what shipped elsewhere, moves the denominator from the
> model's returned text to the **source prose**, and splits the numerator two
> ways — speech vs. tag, and model-assigned vs. engine-demoted. §Revision 8
> rebaseline is the normative account; §Review findings round 8 records the
> adversarial pass on it.

## Revision 8 rebaseline

### What shipped elsewhere while this document sat

| Revision-7 change | Status today | Consequence |
|---|---|---|
| **`isSpokenLine` gains `「…」`/`『…』`** (§The CJK denominator defect, part 2) | **Shipped in #2245**, and more broadly than proposed: `isSpokenLine(text, conventions)` (`narrator-default.ts:34`) now reads the same `LanguageConventions` tables the structure engine uses, so CJK, German and every other language's marks come from `lang/*.ts` rather than a hardcoded bundle | The analyzer change is **withdrawn** from this spec. Wave 1 criterion 10 is discharged, not implemented |
| **`DetectionResult.fallback`** (§Language resolution, step 4) | **Shipped in #2246.** `detect-language.ts:44` declares it; both surrender branches set it — `:81` (`letters === 0`) and `:98` (`franc` miss / no match) — exactly the two-branch semantics R-6N1 specified | The second permitted analyzer change is **withdrawn**. The corroboration design that consumes it stands unchanged |
| **The German `»…«` gap** (§The gap column, R-5M2 / R-6C4) | **Closed by #2245**, whose own header names it: the old bundle "carried only one of German's four `quotePairs` forms and recognised no CJK quote glyphs at all" | The recorded known limitation is deleted, not carried forward |
| **`&ndash;` in `es`/`fr` `dialogueOpen`** | **Shipped in #2289.** Both tables read `/^\s*(?:&mdash;\|&ndash;\|[-–—])\s*/iu` | Nothing here depended on it; recorded so a reader does not re-derive it. **#2310 is open and adjacent** — the entity opens dialogue correctly but is still read aloud verbatim. Out of scope |

**So this spec once again changes no analyzer behaviour for the reasons revisions
4–7 gave.** It acquires exactly one new analyzer change, for a different reason —
D18.

### The revision-7 claims this rebaseline falsifies

Listed rather than overwritten, because "a stale claim survives into shipped
prose" has recurred four times in this strand.

| # | Revision-7 claim | Verdict |
|---|---|---|
| F1 | *"The denominator is sentences that are dialogue under the book's own language conventions"* — i.e. a predicate over **cached sentence text** | **FALSE AS A DESIGN.** Cached sentence text is the model's returned text, so the model chooses the denominator. Replaying the recorded Aug-6 stage-2 prompt (`handoff/inbox/mns_oyK7Po6BiT-stage2-ch1.md`) byte-for-byte through today's analyzer: **80** dash-opening lines then, **45** today, score 28.8% → 2.2%. Today's model returns the same lines with the leading dash stripped (`- сказал Егор.` → `сказал Егор.`), so 35 correctly-narrated lines silently left the denominator and the metric reported a 26-point recovery that did not happen. Superseded by D14 |
| F2 | *"`isDialogueLine(text, conventions)` … importing them rather than authoring an eighth definition of 'what is dialogue' is the point"* | **SUPERSEDED.** The eighth-definition problem is solved — by #2245, at the source, not here. `isDialogueLine` **is** `isSpokenLine` now, and this spec must not mint a second name for it |
| F3 | **`blindSpoken`** — *"conventions say dialogue, `isSpokenLine` does not"*, carried as "the permanent regression signal"; *"104 lines on the live `ja` book and 122 on the live `zh` book"* | **DEAD BY CONSTRUCTION.** The two definitions are now one function, so the column is 0 for every book in every language, forever. It cannot regress and cannot signal. Deleted |
| F4 | **`overcountSpoken`** — *"`isSpokenLine` says dialogue, conventions do not … the dash class; a substantial minority of books"* | **DEAD BY CONSTRUCTION**, same reason. Its motivating case — "`isSpokenLine` returns true for **any** sentence beginning `-`" — is gone: `en.dialogueOpen` and `de.dialogueOpen` are `null`, so a leading dash is not dialogue in those languages any more |
| F5 | **`pipelineSpoken`** — *"`isSpokenLine`'s count — the comparand"* | **DEAD.** Identical to the conventions count by construction. Deleted |
| F6 | *"`applyNarratorDefault`'s guard is a knob AND the table"* (R-7M3), quoted as `const conventions = configValue<boolean>('analyzer.structure.enabled') ? conventionsFor(...) : null; // analysis.ts:2214-2216` | **FALSE TODAY.** #2245 split them deliberately. `analysis.ts:2210` reads `const conventions = conventionsFor(opts.stageCall.language);` **outside** the knob; the branch is `if (configValue<boolean>('analyzer.structure.enabled') && conventions)`. The `else` branch now gets the right per-language rules with the engine off — which is exactly what the #2245 split was for |
| F7 | Wave 1 criterion 11 — *"`blindSpoken` drops to 0 on both live CJK books once criterion 10 lands, and no other book's value changes"*, with its on-box `isSpokenLine` corpus replay | **UNSATISFIABLE.** The before/after has no "before": #2245 is merged. The owed register row is discharged by #2245's own acceptance, not by this spec |
| F8 | *"Run `isSpokenLine` over every sentence of all 20 live books before and after, and assert the classification differs on **exactly** the two CJK books"* (R-5Mi1's fix) | **SPENT**, same reason as F7 |
| F9 | Fixture rows 5 and 6 and their mutation controls (*"denominator reverted to `isSpokenLine`"*; *"denominator reverted **and** part 2 reverted"*) | **INERT.** Reverting the denominator to `isSpokenLine` is now a no-op and there is no "part 2" to revert. Both rows survive as language-coverage fixtures, with new controls — §Testing |
| F10 | §Out of scope: *"Revision 5 permits exactly two [analyzer changes]"* | **FALSE.** It permits neither of those two; both shipped. It permits one different one (D18) |
| F11 | *"the run-dependent trigger behind the two historical 97–99% CJK collapses … the follow-up issue's first task is to check what `analyzer.structure.enabled` was set to for those runs"* | **STILL OPEN, LEADING HYPOTHESIS WEAKENED.** Under #2245 the `else` branch is no longer language-blind, so knob-off can no longer produce total attribution loss on a CJK book. The historical collapses predate #2245 and remain unexplained; the follow-up stands, its named first task does not |
| F13 | *"the stage-2 coverage guard"* was never leaned on explicitly, but the document nowhere says it **cannot** catch this | **GAP, now closed.** Measured on the real data: a run whose dash-opening population **halved** scores `coverageRatio 1.000, ok=true`. See §What the coverage guard cannot catch |
| F12 | Line citations: `buildCastResolver` `cast-resolve.ts:147`; `collectOrphanedCharacterFallbacks` `segments-io.ts:338`; `handleLinkOrphanMatch` `cast.tsx:583`; `persistDroppedQuotesBatch` `:3568`/`:4209`/`:6208`; `isSpokenLine` `narrator-default.ts:29` and its dash class `:32`; detection surrender branches `detect-language.ts:44`/`:60` | **ALL STALE.** Re-derived 2026-08-13 against `ee79fc7d`: **`:91`**, **`:371`**, **`:755`**, **`:3614`/`:4266`/`:6425`**, **`:34`** (the `:32` dash class no longer exists as a literal), **`:81`/`:98`**. Re-verified as still correct: `analysis.ts:2287`, `:5079`, `:6618`; `registry.ts:1267-1273`; `phase-card.tsx:252`; `narrator-identity.ts:26`; `analysis-state.ts:85`; `analysis-cache.ts:79`; `schemas.ts:135`; `scan.ts:77`; `stage2-coverage`'s `0.6`/`1.6`; `generation-stream-middleware.ts:72`; `library-status-ui.tsx:24`; `start-generation-flow.ts:83`/`:93` |

**Nothing about D9, D11 or the five-state machine is falsified here.** Those turn
on identity resolution and on `spokenTotal === 0`, neither of which the
punctuation strand touches. What changes for them is the **unit** the denominator
counts (D14) — and therefore their calibration, not their design.

## Problem

On 2026-07-14 a real book in the library — _Der Auftrag von Coalfall_ (de) —
lost **103 of its 144 quoted sentences to the narrator** during analysis.
Dialogue collapsed from 178 lines to 41; ten of thirteen cast members ended up
with almost nothing to say. The book then sat that way for **17 days**, found
only while chasing an unrelated bug. A library-wide sweep found one other
affected book (_Юный дрессировщик_, ru, 78%). Every other book measured ≤ 15%,
most 0–3%.

The signal was not absent. It could not have communicated the damage:

1. **Latest batch only.** `DroppedQuotesPanel`
   (`src/components/analysing/phase-card.tsx:252`) narrows to
   `batches[batches.length - 1]`. The book's ledger held 16 dropped
   attributions across 5 batches; the last held 1. The user was shown
   _"Verifier dropped 1 quote across 1 character."_
2. **Styled to recede.** A `<details>` at `text-[11px] text-ink/60`.
3. **Transient.** It exists only on the analysing screen. Once analysis
   finished there was no residue anywhere.
4. **It reports the cause, not the effect.** "N quotes dropped" is a
   verifier-internal statistic. The number that decides whether the book is
   usable is _"103 of 144 quoted sentences are now attributed to the narrator"_,
   and it is never computed anywhere.

Point 4 is the crux: **the two numbers are not proportional.** Dropping one
quote can re-attribute a long run of dialogue; dropping ten can be harmless.
Here, 16 drops produced a 72% collapse.

### What this is not

The corruption was produced by the pre-fix analyzer of
[#1598](https://github.com/dudarenok-maker/Castwright/issues/1598), which closed
11 minutes after this book's journal was written. It is about the fact that when
attribution collapses — for any reason, including future ones — the product does
not tell the user in terms they can act on.

**Revision 8 narrows one analyzer change into scope, and it is a different one
from revision 4's.** Revision 4 admitted the CJK bracket pair on `isSpokenLine`
and revision 5 added `DetectionResult.fallback`; **both shipped elsewhere**
(#2245, #2246), so neither is this spec's any more. What revision 8 admits is
the additive, optional `SentenceOutput.priorCharacterId` — the only way
acceptance criterion 5 is satisfiable (§D18). Everything else about the analyzer
remains untouched, and §Out of scope states the boundary normatively.

## Decisions taken

| # | Decision |
|---|---|
| D1 | **Warn everywhere; require an acknowledgement before generating; never permanently refuse.** |
| D2 | **Book-level share OR any single chapter crosses the line.** Revised in revision 2 — see R-M8. |
| D3 | **Badge on the library card AND a banner in the Cast view.** Auto-clears on a good re-analysis; an explicit per-book dismiss handles false positives. |
| D4 | **A dismissal re-arms whenever the attribution data changes.** |
| D5 | **Copy leads with the effect; the verifier's cause is secondary.** |
| D6 | **The analysing-view panel sums the whole ledger** and labels it honestly. Revised in revision 2 — see R-C1. |
| D7 | **Stamp for the library, live compute for the detail surfaces.** |
| D8 | **Ship in two waves: measure, then decide.** The threshold is set from the real library, not from a sweep whose method no longer exists. See R-C3. |
| D9 | **The collapse figure counts both members of `NARRATOR_CHARACTER_IDS`. Unresolvable ids are measured and reported alongside it, never summed into it.** Added in revision 2 (R-C2), narrowed in revision 6 (R-6C1). |
| D10 | **The Cast-view re-run confirms first when rendered audio exists.** |
| D11 | **"Cast built, nothing attributed" is its own alarm state**, not a quiet one. Added in revision 3 — see R-O1. |
| D13 | **Id drift is its own state — `drifted` — which badges and gates, and whose notice points at the Cast orphan banner, not at re-analysis.** Added in revision 7 — see R-7C4. **Re-gated in revision 8: the decision holds, its numbers do not** — see §D13 re-gated. |
| D14 | **The denominator is the SOURCE PROSE, and the unit is a `speech` span, not a sentence.** The model can no longer move it. Added in revision 8 — supersedes D12. |
| D15 | **Speech spans and tag spans are reported in separate columns.** Narration is a defect in one and correct in the other. Added in revision 8. |
| D16 | **The join from source span to model attribution is `alignSentences` — the engine's own normalised substring search — not a text predicate.** Added in revision 8. |
| D17 | **A speech span with no aligned sentence is reported as `unattributedSpeech`, never as a denominator that quietly shrank.** Added in revision 8. |
| D18 | **The narrator numerator splits into model-assigned, engine-demoted and unknown.** Requires one new persisted field. Added in revision 8. |

---

# Wave 1 — measure

Wave 1 ships **no threshold and no UI.** It ships the metric and a read-only
script that prints the figure for every book in the real library, so the
threshold in Wave 2 is set from data rather than from a sweep whose counting
method is not in the tree.

### Prerequisite: _Ночной дозор_ must be re-analysed before the threshold is set

Wave 1's *implementation* is not blocked. The **threshold decision it exists to
inform** is, and by one specific book.

_Ночной дозор_ (Night Watch, ru, `mns_oyK7Po6BiT`) is the book plan 247 built
the `the-coalfall-commission.ru-dash.md` fixture from, because it is
**dash-delimited Russian** — i.e. the single strongest stressor of the
`isSpokenLine` dash rule that R-C3 turns on. Measured in the live workspace on
2026-08-06:

| | |
|---|---|
| `state.json` chapters | 9 |
| `cast.json` members | 47 |
| Sentences in the analysis cache | **0** — `stage1` present, `chapters: {}`, 0.4 MB |
| Cache `updatedAt` | 2026-07-17 |
| dropped-quotes batches | 18 (**308** cumulative drops; **7** in the last) |

Every other book's cache holds its sentences normally (13,582 / 12,835 / 11,428
/ 10,849 / 10,475 / 10,198 in the six largest), so this is not a wrong
assumption about where sentences live — it is this book.

**Cause: none. The repo owner started a re-run and stopped it** (confirmed
2026-08-06). Phase 0 wrote the cast, Phase 1 never ran, and the 0-byte
`analysis-state.json` is the aborted snapshot write. Not a defect — which is
precisely why D11 matters: this is the **normal path**, not a corruption, so any
user who cancels an analysis leaves a book in a state the library rendered as
healthy.

**Consequence for Wave 1:** the book that most stresses the dash rule
contributes a blank row, so a threshold set without re-analysing it is set from
books that do not exercise the failure mode. Order of work: re-analyse →
run the script → set the threshold.

> **Discharged 2026-08-06 — this prerequisite is met.** The owner re-analysed the
> book; its cache is now 3.7 MB, 9 chapters and **15,069 sentences**. It is no
> longer an instance of `missing`, and it is a **real collapse** — which is what
> R-O2 wanted it for. The two denominators agree exactly (Δ 0.0) here, so D12
> does not disturb the calibration it unblocked. The `missing`-state discussion
> below is retained as the reasoning behind D11, not as a description of the
> book's current state.
>
> **Its share and its cast count are deliberately not stated here.** Revision 4
> said "58-member cast", from `stage1.characters` in the **analysis cache**;
> revision 5 corrected that to "27 non-narrator members" from `cast.json`, and
> **that was wrong too** — the file holds 35 characters, 34 of them non-narrator,
> and revision 5 got two other books' counts wrong in the same pass (R-6C3).
> `cast.json` is the identity of record
> per CLAUDE.md and `castCount` must be read from it, which is the durable
> lesson; the number itself is Wave 1's script's to print. Wave 2 acceptance
> criterion 8 previously carried the wrong figure and has been rewritten.

**Second consequence — a real-world confirmation of D6.** Night Watch's ledger
holds 308 drops across 18 batches with 7 in the last. Today's panel would read
_"dropped 7 quotes · latest batch."_ Summing the whole ledger yields **308
across 18 passes**; the `runId` grouping revision 1 proposed would have shown
**7**. A second book, at 20× Coalfall's scale, independently confirming both the
bug and the fix.

## The metric

New pure module `server/src/store/attribution-health.ts`. No I/O, no model call.

**Universe (revision 8).** Two inputs, joined — not one.

1. The book's **source prose**: `ChapterHint.body` (`server/src/store/manuscripts.ts:20`
   — _"Normalised plain text body, with paragraph breaks preserved as `\n\n`"_),
   for every chapter not marked `excluded` in `state.json`
   (`server/src/workspace/scan.ts:77`). This is what the denominator is built
   from, and it is the half the model cannot touch.
2. The book's **attribution**: sentences from the analysis cache
   (`cache.chapters: Record<number, SentenceOutput[]>`, `analysis-cache.ts:79`),
   minus sentences flagged `excludeFromSynthesis` (`schemas.ts:135`). This is
   what the numerator is built from.

**Revision 7 had only input 2, and that is F1.** A universe of cached sentences
is a universe the model writes. Excluding a chapter still excludes it from
**both** halves; `excludeFromSynthesis` now only removes an *attribution*, and a
speech span whose only sentence is excluded reads as `unattributedSpeech` (D17)
rather than vanishing — which is the correct answer, because that line is not
going to be spoken by anyone.

### Denominator (D14) — the source prose, and the unit is a span

**The denominator is the set of `speech` spans that `parseChapterStructure`
finds in `ch.body`.** Not sentences. Not a predicate over model text.

```ts
const conv  = conventionsFor(language)!;            // lang/index.ts:14
const index = buildNameIndex(roster, conv);         // name-matcher.ts:23
const paras = parseChapterStructure(ch.body, index); // parser.ts:89
// ParagraphEvidence[] — each { start, end, kind: 'dialogue' | 'narration',
//                             spans: SpanEvidence[] }
// SpanEvidence.kind is 'speech' | 'tag' | 'narration', with absolute
// offsets into ch.body (types.ts:3-16).
```

`spokenTotal` is the count of `speech` spans across those paragraphs.
`tagTotal` is the count of `tag` spans (D15). Both are properties of the
**text**, computed before any model output is read at all.

Three things make this the right structure rather than a heavier one:

- **The model cannot move it.** F1's whole mechanism was a punctuation change in
  the returned text redefining the denominator. There is no returned text in the
  denominator any more, so a model that strips every dash, adds every dash, or
  re-punctuates wholesale changes this number by exactly zero.
- **It is already in the tree, tested, and used in production.** `analysis.ts:2212`
  calls `parseChapterStructure` on every chapter of every book with the structure
  engine on. This spec imports it; it does not re-derive "what is dialogue" for
  the ninth time.
- **It gives D15 for free and correctly.** The speech/tag split is not a
  post-hoc heuristic here — the parser cuts a dash paragraph at its own
  dash-tag toggle points and validates that a tag span carries a
  `speechVerbStems`/`beatVerbStems` verb (`parser.ts`'s `parseDialogueSpans`).
  The reconnaissance instrument (`victim-metric-audit.mts`) approximated the
  same split by the case of the first letter after the dash, which works for
  Russian and is not a general rule. **Use the parser, not the case heuristic.**

**`spokenTotal` is not the same number revision 7's `spokenTotal` was**, and
that matters for calibration rather than for design: a dash paragraph
`— Ничего нет, — сказал Егор.` is **one** dialogue paragraph, **one** speech
span and **one** tag span, where revision 7 counted **two** dash-opening
sentences and put both in the denominator. Every threshold in this document is
therefore uncalibrated against the new unit, and Wave 1's run is what
re-calibrates it. See §D13 re-gated for the one place that was already
half-calibrated.

**What this costs: the metric now needs the manuscript body, and revision 7's
did not.** `ChapterHint.body` lives in the manuscript record, not in the
analysis cache, so `resolveBookLanguage`'s sibling — the impure caller of Wave 1
criterion 2 — gains a second read. That is I/O the pure module still never does;
the bodies are passed in with the sentences. It also means **a book whose
manuscript record is gone cannot be measured**, which is a new `unmeasurable`
producer and is specified as one below.

### The join (D16) — align, do not judge

The numerator needs to know which model sentence speaks each source speech span.
**Join with `alignSentences`, the function the engine already uses**, not with a
text predicate:

```ts
const { aligned } = alignSentences(sentences, paras, ch.body);  // aligner.ts:310
// AlignedSentence { sentence, spans: SpanEvidence[], lumped: boolean }
```

`alignSentences` normalises both sides — collapsing whitespace, `…`→`...`,
`&mdash;`→`-`, a run of ASCII hyphens → `-` — and locates each sentence by
**substring search over the normalised body** (`aligner.ts:174-178`, the
windowed-then-unbounded `findMatch`). A sentence whose leading dash has been
stripped is still a substring of its source span; the located span simply starts
after the dash. **That is criterion 1's dash-insensitive join, and it is already
written.**

`cross-examine.ts:18` and `:268-269` record why the engine abandoned the
`isSpokenLine` text heuristic for exactly this: _"the old `isSpokenLine` trap
this replaces"_, _"replicated here via structural evidence instead of the old
`isSpokenLine` text heuristic"_. The metric should join the way the aligner
joins, not the way `isSpokenLine` judges.

**`isSpokenLine` therefore has no role in this metric at all.** It remains the
right predicate for what it does — deciding whether the analyzer should demote a
sentence — and it is a **defect surface this metric measures** (D18), not a tool
it uses.

**A speech span may align to more than one sentence, and to zero.** Both are
real and both are reported:

- **More than one** — the sentence segmenter split a long turn. The span counts
  once; its attribution is the resolved id of its aligned sentences when they
  agree, and `split` when they do not. A `split` span is counted into the
  denominator and into neither narrator column; the count is reported so it can
  never quietly become a rounding difference.
- **Zero** — D17. The span is `unattributedSpeech`.

`AlignedSentence.lumped` (a sentence overlapping both a speech span and a
tag/narration span) is carried through as its own column too, for the same
reason: it is a real population that a naive join would silently assign to one
side.

### Speech halves and tag halves (D15)

A dash-convention paragraph produces two spans that revision 7 counted as two
dialogue sentences:

```
- Ничего нет, - сказал Егор.
    speech span   "Ничего нет,"     ->  a character.  Narration here is a BUG.
    tag    span   "сказал Егор."    ->  narrator.     Narration here is CORRECT.
```

Measured over ch1–4 of _Ночной дозор_ (`victim-metric-audit.mts`, 2026-08-13):

| run | speech halves — narration is a BUG | tag halves — narration is CORRECT | a combined figure would read |
|---|---|---|---|
| Aug-6 (healthy) | 411/1683 = **24.4%** | 169/232 = 72.8% | 580/1915 = 30.3% |
| Aug-13 (collapsed) | 1601/1702 = **94.1%** | 185/191 = 96.9% | 1786/1893 = 94.3% |

**Only the speech column is a defect, and the collapsed run scores *better* on
tag halves than the healthy one.** A combined figure mixes damage with correct
behaviour, and — since tag halves are ~12% of that denominator — its "correct"
value is not 0 but some book-specific number nobody can state. That is a
threshold set against a bar that was never right.

**So the headline share is over speech spans only.** `tagNarratorSpan` is
reported as a sibling column, because a *low* tag-narration rate is its own
signal — it means named characters are being credited with the narrator's
attribution verbs — but nothing badges on it in Wave 2 and Wave 1 sets no
threshold for it.

These figures are from cached sentences under the old unit, so they are
**motivating evidence, not calibration.** Wave 1's run over source spans is the
calibration, and the two numbers will not match.

### What the coverage guard cannot catch (F13)

`validateStage2Coverage` (`stage2-coverage.ts:164`,
`minCoverageRatio: 0.6` / `maxCoverageRatio: 1.6`) compares **word counts**.
Run against the real data:

```
recorded Aug-6 response   258 sents,  80 dash | coverageRatio 1.001 | ok=true
replay today (arm A)      234 sents,  45 dash | coverageRatio 1.000 | ok=true
replay today (arm B)      238 sents,  49 dash | coverageRatio 1.000 | ok=true
```

A run whose dash-opening population **halved** scores 1.000 and passes clean.
That is correct on its own terms — no words went missing — and it is why the
guard is structurally incapable of seeing a change in how dialogue is punctuated
or attributed. **It is a truncation/loop detector. It cannot be the thing that
catches attribution collapse, and no part of this spec may lean on it.**
Recorded here because the absence of such a statement is what let three
revisions treat coverage as ambient safety.

### Omission is latent, not observed (D17)

Worth recording precisely, and worth *not* overstating. A chapter's sentences
are **only** what stage-2 returned:

- `analysis.ts:5079` — `if (arr) allSentences.push(...arr);` stitches the
  per-chapter results. There is no independent segmentation of `ch.body` and no
  fill for anything absent. Same shape at `analysis.ts:6618` in
  `runSubsetAnalyzerJob`.
- `recover-tagged-lines.ts:130` — `recoverTaggedNarratorLines` does
  `const out = sentences.map((s) => ({ ...s }));`. It only *flips* ids; it
  cannot re-add a sentence.

So a genuinely omitted sentence does not become narrated — it leaves the book,
and no user-facing surface says so. **Measured: this did not happen in either
real run.** Word-multiset survival against the EPUB was 99.4–100% per chapter for
both Aug-6 and Aug-13 (`prose-loss.mts`); the dash-stripping in F1 preserves
every word, which is why coverage stays clean.

**This is exactly why the denominator must be source-anchored even though the
observed failure was punctuation.** Under a cached-sentence denominator an
omission is invisible by construction: the line is not in the numerator and not
in the denominator, and the share is unchanged. Under D14 the source speech span
exists whether or not a sentence came back for it, so an omission surfaces as
`unattributedSpeech` — the one column that can distinguish "the model got this
wrong" from "the model never answered". That is acceptance criterion 4, and it
is a property of the design rather than a test bolted onto it.

### Model-assigned vs. engine-demoted narrator (D18)

**A `characterId` of `narrator` has two producers with different fixes, and they
are indistinguishable in the final value.** Making collapse *actionable* — which
is what #1984 exists for — means saying which one produced it. A figure that
shows collapse without saying which tells the user something is wrong and
nothing about what to do.

**The demotion path is live and it is reachable.** `isSpokenLine` judges the
model's returned text (`narrator-default.ts:34`; both callers pass `s.text`, at
`:62` and `:84`), and `applyNarratorDefault` (`analysis.ts:2287`) forces every
non-spoken sentence to `narrator`. For a dash-convention book a returned line
whose leading dash has been stripped matches no `dialogueOpen`, starts with no
`quotePairs` opener and contains no embedded pair — so `isSpokenLine` returns
false and the line is demoted, **including a speech half, where narration is the
defect.** The same model behaviour that fooled the metric can, on this path,
manufacture the collapse the metric is being built to detect.

**Two bounds, stated plainly rather than borrowed as urgency:**

- **This is the opt-out path, not the default.** `analyzer.structure.enabled`
  defaults `true` (`registry.ts:1267-1273`) and the `applyNarratorDefault` call
  is the **`else`** of that branch (`analysis.ts:2210`/`:2280`/`:2287`). With the
  engine on, this code does not run.
- **It is NOT offered as #2306's cause.** #2306 places its cause upstream of the
  dialogue-structure engine — a different mechanism. Nothing here competes with
  that finding. (#2306's own step-1 conclusion is that the 2026-08-11 Ollama
  upgrade flipped stage-1 to Latin-transliterated names for a Cyrillic book; the
  dash-stripping documented here is a *second*, independent model-version
  change observed in the same replay.)

**The engine-on path has its own reassigning step**, and the spec must not
pretend otherwise: `crossExamine` (`analysis.ts:2217`) corrects attributions
against structural evidence, and a `corrected` decision can land on `narrator`
too. That is a *better-evidenced* reassignment than `applyNarratorDefault`'s,
but it is still not the model's answer, and a user debugging a collapsed book
needs to know which of the three they are looking at.

**Verified 2026-08-13: `crossExamine` has exactly one application site** —
`cross-examine.ts:393`, `sentences.push({ ...as.sentence, characterId:
decision.characterId, confidence: decision.confidence })`. Five `decide*`
helpers produce verdicts and all converge there, so instrumenting it is one
edit, not five. **The record is keyed on the id actually changing, not on the
`corrected` bucket:** `decideNarrationOnly` (`:274`) returns a `confirmed`
narrator verdict for a sentence that was already narrator, and a bucket test
would mislabel it as an overwrite.

**So the measurement carries three narrator populations, never one:**

| Column | Meaning | What the user does about it |
|---|---|---|
| `modelNarrator` | stage-2 returned `narrator` (or a narrator alias) for this span | a prompt/model problem — re-run analysis, or the book genuinely narrates here |
| `demotedNarrator` | stage-2 returned a character; a post-stage-2 step overwrote it with `narrator` | an analyzer problem — `isSpokenLine` or `crossExamine` acting on text it read wrongly. Re-running analysis reproduces it |
| `unknownOriginNarrator` | the sentence predates the record | **not** foldable into either. See below |

**This needs one new persisted field, and that is the only analyzer change
revision 8 permits.** The origin is knowable only at the moment of overwrite;
`analysis.ts:2287` runs after stage-2, so the pre-demotion assignment is
available *there* and nowhere afterwards. `SentenceOutput` gains an optional
`priorCharacterId?: string`, written at exactly the two sites that overwrite an
attribution — `applyNarratorDefault`'s demotion branch and `crossExamine`'s
correction branch — and absent on every sentence neither touched.

- **Optional, additive, and absent by default**, so no existing reader changes
  and no cache migration is needed.
- **`openapi.yaml` is edited first**, then `npm run openapi:types` — it is the
  type source of truth (`schemas.ts:117-142` mirrors it).
- **Every cache written before this field exists reads
  `unknownOriginNarrator`, and that value must be visibly distinct from
  `modelNarrator`.** Folding an absent field into "the model said so" is the
  metric-blind-to-its-own-blind-spot trap this document has hit in four
  different forms; the honest answer for an old cache is "I don't know", and it
  clears itself on the next analysis rather than needing a backfill.

**This is the one place revision 8 knowingly adds surface**, and the alternative
was considered and rejected: deriving the split at measure time by re-running
`isSpokenLine` over the cached text. That derivation is wrong in both directions
— it cannot see a `crossExamine` correction at all, and it cannot distinguish
"the model said `narrator` and the line is not spoken" from "the model said
Егор and got demoted", which is the entire distinction being drawn. **Deriving
it would rebuild the metric out of the model's returned text, which is F1.**

`LanguageConventions` and `conventionsFor` come from
`server/src/analyzer/dialogue-structure/lang/index.ts:14` — seven tested tables
(`ru`, `en`, `es`, `fr`, `de`, `zh`, `ja`) already carrying exactly the
open/close pairs and paragraph-dash markers `parseChapterStructure` consumes.
`buildNameIndex` (`name-matcher.ts:23`) wraps a table with the book's roster and
is what the parser actually takes.

> **Superseded — D12's framing, revisions 4–7 (F2, F3, F4, F5).** This section
> used to argue at length that the metric must use "the language's conventions"
> rather than `isSpokenLine`, and carried three columns (`pipelineSpoken`,
> `blindSpoken`, `overcountSpoken`) measuring the gap between the two. **#2245
> merged them: `isSpokenLine` now reads these same tables.** The gap is
> identically zero, in every language, forever, so all three columns are deleted
> — a column that cannot vary cannot signal.
>
> The reasoning that produced them survives and is worth keeping: *a detector
> that shares its subject's definition of dialogue can only ever report collapse
> its subject is capable of seeing.* Revision 8 satisfies it a level deeper than
> revision 4 did. The analyzer's blind spot is no longer *which marks* it
> recognises — it is *which text* it reads. `isSpokenLine` judges the model's
> output; D14's denominator reads the source. That independence is what F1
> proves is necessary and what D12 never had: revision 4 replaced one predicate
> over model text with another predicate over the same model text, and both
> would have reported F1's phantom 26-point recovery identically.

**Language resolution.** The denominator depends on knowing the language, so
resolution is its own tested function with an explicit chain:

1. `state.json`'s `language` field **read raw**, when present;
2. otherwise `detectManuscriptLanguage(sample)`
   (`server/src/tts/detect-language.ts` — pure, synchronous, script pre-pass
   for Cyrillic/CJK plus `franc` for the Latin set, restricted to the registry's
   Latin codes at `:94`) over the **source prose**, sampling its own
   `SAMPLE_CHARS` (`:23`, 20,000). **Revision 8 changes the input here** from
   cached sentence text to `ch.body`, for D14's reason and for a second one:
   `selectBodyChapters` (`:105`, added by #2263) drops front/back matter from
   the voting pool, and it keys on `{ title, body }` — which the cache does not
   carry. Use it;
3. **corroboration**, on the `missing` path only — see below;
4. detection **surrendering rather than matching** ⇒ `unmeasurable`;
5. `conventionsFor()` returning `null` ⇒ `unmeasurable`.

**Step 1 must read `state.language` raw, and this is a trap** (R-5M3). The
in-tree accessor is `bookStateLanguage` (`server/src/workspace/scan.ts:314`),
whose own header tells callers never to read `state.language` directly — but it
delegates to `normaliseBookLanguage` (`server/src/tts/language.ts:23`), which
returns `DEFAULT_LANGUAGE` for an absent value. An implementer following the
documented convention gets `'en'` for every book with no language, and **step 2
never runs at all.** Everywhere else in the codebase wants a usable default;
this module is the one place that needs the difference between "declared
English" and "nothing declared", so it reads the field raw and says why.

**Step 2 is load-bearing, not a nicety.** 7 of the 20 live books have no
`language` field — books analysed before the field existed — and they include
the largest in the corpus. Without detection they would all resolve
`unmeasurable`, which is the "feature turning itself off wholesale" failure this
spec already names in §Failure modes. (Revision 5 said these 7 hold "7.1k–13.6k
sentences each"; that was a hand-computed range and the low end is wrong by
26× — one of them is a short story. The count is not load-bearing and the range
is deleted rather than restated: R-6N3.)

**Step 3 is the one that closes the class, and revision 5's did not** (R-6C2).
Revision 5 made `unmeasurable` turn on detection surrendering — but **detection
only runs when `state.language` is absent, and no current import path leaves it
absent.** `import.ts:258` normalises the submitted language, hard-rejects
anything outside the seven-code registry (`:259-266`), and carries the
normalised value into the `state.json` literal at `:341`, written at `:343`;
staging returns `languageSupported: false` for anything else, so the only way
forward for an Italian, Portuguese or Polish manuscript is for the user to
**pick one of the seven.** That book therefore arrives with a *declared* language
that is confidently wrong, resolves at step 1, gets a conventions table, and
never reaches step 2 at all. Revision 5 replaced a guard over an empty set with
another guard over an empty set.

The reachable failure is **declared-but-wrong**, so the guard has to test the
declaration rather than only its absence:

> **When the measurement would otherwise return `missing`** — a real cast, and
> `spokenTotal === 0` under the declared language's conventions — **the declared
> language is corroborated** by running `detectManuscriptLanguage` over the same
> cached text. If detection **disagrees** with the declaration, or **surrenders**,
> the result is `unmeasurable`, not `missing`.
>
> **Corroboration is skipped outright when the cache holds no sentences at all**,
> and that carve-out is not an edge case — it is D11's own motivating book.

**The carve-out exists because without it this guard disarms the state it sits
in front of.** _Ночной дозор_ in its 2026-08-06 shape had `stage1` present and
`chapters: {}` — a full cast and **literally zero sentences.** Corroboration over
that book samples the empty string, `detect-language.ts:44` sees `letters === 0`,
surrenders, and by the rule above the book resolves `unmeasurable`: not badged,
not gated, a neutral "couldn't measure this" marker. **The canonical `missing`
case — the one R-O1 was raised on, the one the repo owner produced by cancelling
a re-run — would have been silently exempted by the guard added in the same
revision.**

That is this document's recurring failure shape, and it is worth naming rather
than quietly patching: a new guard whose detection envelope excludes its own
motivating case. Revision 4 shipped it (`unmeasurable`-first precedence over an
empty set), revision 5 shipped it (`fallback` on a branch no book reaches), and
revision 6 nearly shipped it a third time in the fix for the second.

The distinction the carve-out draws is real, not a patch:

| Cache | What it means | Verdict |
|---|---|---|
| **no sentences at all** | Phase 1 never ran. There is nothing to detect *from*, and the absence of text is itself the evidence of the abandoned run | `missing` — corroboration does not run |
| sentences present, detection **contradicts** the declaration | the book is probably not in the language it was imported as | `unmeasurable` |
| sentences present, detection **surrenders** (`letters === 0` over real sentences, or `franc` returns `und`) | there is text and it is unidentifiable | `unmeasurable` |

Three further properties make this the right shape rather than a wider one:

- **It runs on one path, and that path is already the expensive one.** A healthy
  book never reaches it, so the corroboration costs nothing on the hot path and
  cannot change any `ok` or `collapsed` verdict. It can only ever *downgrade* an
  accusation to "I can't tell", which is the direction a false positive needs.
- **It is exactly the contradiction that defines the state.** `missing` already
  fires on a contradiction — characters exist, nothing is theirs. "The text does
  not look like the language we are measuring it against" is a second, cheaper
  explanation for the same evidence, and preferring it is strictly safer than
  badging the book.
- **`unmeasurable` gets a live producer at last.** Steps 4 and 5 have none: all
  seven registry languages have conventions tables, and import admits nothing
  else. Without step 3 the only reachable producer is a corrupt cache, and the
  precedence machinery below would be decoration — the exact charge revision 5
  levelled at revision 4.

**Step 4's analyzer change already shipped — #2246 (revision 8).** Revisions 5–7
specified `DetectionResult.fallback` as an additive change this spec would make.
It is in the tree, and its semantics are exactly what R-6N1 required.
`detect-language.ts:44` declares it, with a docstring that states the reasoning
independently: _"`supported` cannot distinguish these cases because 'en' is
itself `supported: true`; callers that must 'never write a language they only
guessed' (#2246) need this field, not `supported`."_

```ts
// detect-language.ts:30-45, as shipped
interface DetectionResult {
  language: string;
  supported: boolean;   // registry `supported` — TRUE on the surrender path too
  fallback: boolean;    // true on EVERY surrender branch
}
```

**Both surrender branches set it**, verified 2026-08-13:

| Line | Branch | Meaning |
|---|---|---|
| `detect-language.ts:81` | `if (letters === 0) return resultFor('en', true)` | the sample has no letters at all — no evidence whatsoever |
| `detect-language.ts:98` | `return match ? resultFor(match.code, false) : resultFor('en', true)` | `franc` returned `und`, or matched nothing in the Latin registry |

So this spec **consumes** the field and changes nothing. Revision 5's "true ONLY
on the `: result('en')` branch" would have left a book of pure punctuation,
numerals or unhandled script answering `en` with `fallback: false` —
confidently, from zero evidence; the shipped implementation does not have that
hole, and the fixture rows that prove it (rows 7 and 8 below) are still owed
**here**, because nothing in #2246 tests the *corroboration* consumer.

The measurement carries `languageSource: 'declared' | 'detected' | 'unknown'`.
`'unknown'` is a real value with real producers — a surrender at step 4, or a
declaration contradicted at step 3. Revision 4's `| null` arm had no producer
and was dead type: the tell that its design had no representation for "I don't
know".

**What corroboration does not do.** It does not correct the language, re-measure
against the detected one, or touch the analyzer's own resolution. A book that
lands in `unmeasurable` this way is *reported*, not repaired — the fix is for
the user to re-import it under a language the product supports, or for the
registry to gain that language, and neither is this spec's to do.

**Numerator (D9, narrowed in revision 6; re-based on spans in revision 8).**
Of the source **speech spans**, those whose aligned sentence's resolved
`characterId` is a member of `NARRATOR_CHARACTER_IDS`
(`server/src/analyzer/narrator-identity.ts:26` — `['narrator', 'char-narrator']`,
centralised in #1895 precisely because it had been inline-copied across server
modules). Nothing else. **The unit changed from a sentence to a span; the rule
did not.** D18 then splits this count three ways by origin.

Resolution goes through `buildCastResolver` (`server/src/store/cast-resolve.ts:91`)
per the CLAUDE.md rule that an analyzer `characterId` is only an alias into
`cast.json`. That is what makes a **drifted-but-recorded** id resolve correctly
instead of counting as damage.

**Unresolvable ids are measured, reported, and deliberately excluded from the
share** (R-6C1). `buildCastResolver.resolve()` returning `undefined` is the
#2040 id-drift class, and it is a live condition: **8 of the 20 books in the
workspace carry ids their `cast.json` cannot resolve** — measured 2026-08-11
through `buildCastResolver` with each book's real `cast-id-history.json`, 1–5
distinct ids each. Revision 5 summed them in,
on the reasoning that at render time
`server/src/tts/synthesise-chapter.ts:2315-2326` substitutes the narrator for any
group whose `characterId` isn't in `cast` — _"falling back to the narrator voice
for this line"_ — so they are audibly narrator. **That reasoning conflates a
cached sentence with rendered audio, and the difference is the whole point of
the state:**

- The metric counts **sentences in the analysis cache**. Whether an unresolvable
  id was ever *heard* depends on whether the book has been rendered at all, and
  with what cast. `scripts/repair-cast-id-drift.mjs` declines to alias a
  never-rendered id for exactly this reason — _"no damage to repair"_.
- **The two conditions have different remedies.** Collapse is repaired by
  re-running analysis. Id drift is repaired by recording an alias — which is
  what the Cast view's orphan banner now does, since #2238 gave it the
  accept-a-match affordance it had been missing.
- **Summing them would gate generation on the wrong evidence.** The share badges
  a book and blocks its Generate button. A book whose ids drifted but whose
  attribution is intact would be blocked behind a "re-run analysis" prompt that
  cannot fix it, while the one control that can — the orphan banner — is not
  what the notice points at.

So `orphanSpoken` is a **sibling signal, reported on the same row and never
inside the same fraction.** Wave 1 prints both columns; Wave 2's collapse badge
reads the share only.

**It gets its own state rather than its own silence (D13, revision 7).** The
round-6 gate argued that excluding orphans from the share lets a badly drifted
book read as perfectly healthy, and it was right that the *silence* is
unacceptable even though it was wrong about the damage being audible today:

- **Rendered audio is unaffected.** _The Coalfall Commission_'s segments files
  carry `master-oduvan`, `coalfall-dragon`, `brann-weir`, `berrin-weir` — the
  **resolved** ids. Not one segment sits under an orphaned cache id, which is why
  `repair-cast-id-drift.mjs` reports 0 rendered segments for them and declines to
  act.
- **The next render is a different matter.** Synthesis reads the *cache*, so a
  Generate on that book today routes every orphaned line to the narrator
  (`synthesise-chapter.ts:2315-2326`) while the collapse figure reports a healthy
  share. The hazard is prospective, not historical — and "one click away" is not
  a reason to stay quiet.

So `drifted` badges and gates like `collapsed` does, and **its notice points at
the Cast orphan banner's Link control, not at "Re-run analysis"** — re-analysis
cannot reliably fix drift (it may re-mint the same ids), and on a generated book
it wipes chapter-bearing history and invalidates the audio (D10).

### The banner must be fed from the cache, and today it is not (R-8C1)

**This is the single defect that D13's first draft turned on, and it is a
consequence of the very fact used to justify D13's scope.** The Cast view's
orphan banner is populated by `collectOrphanedCharacterFallbacks`
(`server/src/audio/segments-io.ts:338`), whose first act is
`await loadSegmentsFiles(bookDir, chapters)` — **it enumerates rendered segment
files.** D13's `orphanSpoken` is measured from the **analysis cache**. Those are
different populations, and on this corpus they are close to disjoint:

- The books D13 fires on have **zero** unresolvable ids in their rendered
  segments — that is exactly what "rendered audio is unaffected" means, and it is
  the finding that rebutted the round-6 gate.
- Therefore the banner has **no rows** on precisely the books whose notice tells
  the user to go and use it. "Linking each one to the right character below fixes
  it" would scroll to an empty section.
- The books whose banner *does* have rows are ones D13 stays silent about,
  because their orphan share is near zero.

**The same fact has two consequences and revision 7 drew only one.** "The
segments carry the resolved ids" is why there is no present damage *and* why the
remedy points at nothing. Having used it to win one argument, the draft did not
ask what else it implied — which is the reasoning failure, not merely the spec
defect.

**So the banner gains a cache-sourced tier, and this is in scope.** The owner's
D13 decision is "the notice points at the orphan banner"; a banner that cannot
show these ids does not satisfy that decision, so making it show them is *inside*
the choice rather than beyond it. Concretely:

- `collectOrphanedCharacterFallbacks` gains a second source — the analysis
  cache's `characterId`s — resolved through the **same** `buildCastResolver` call
  it already builds, so there is no second resolution path to drift apart.
- Each banner row records **which source** it came from, because the two mean
  different things: a segment-sourced orphan is audible damage in existing audio,
  a cache-sourced one is damage the next render will produce. The copy differs
  accordingly, and the Link action is identical for both —
  `POST /:bookId/cast/:characterId/link-orphan-match` already validates only the
  ids and the reserved-bucket rules (`server/src/routes/cast-link-orphan.ts`),
  and never requires the orphan to appear in a segment file. **The route needs no
  change; only its supply does.**
- No second Link control is added anywhere. R-Mi1's rule stands: the notice
  jumps to the banner, it does not duplicate it.

**If the owner declines this scope, D13 must be dropped rather than shipped
without it** — a warning whose only stated remedy leads to an empty list is worse
than the silence it replaces, because it also spends the user's trust.

**Orphans leave the denominator too, and getting this wrong reopens the hole one
level down.** Taking them out of the numerator alone would leave them diluting
the fraction: a book whose dialogue is *entirely* orphaned would score
`0 / spokenTotal` = **0%, perfectly healthy**, which is #1984's own failure shape
for the third time in this document. The share is therefore over the lines the
metric could attribute at all:

```
attributableSpoken = spokenTotal - orphanSpoken
share              = narratorIdSpoken / attributableSpoken
```

`spokenTotal` stays as it is — it is a property of the *text*, it is what
`missing` turns on, and it is what the gap columns compare against.
`attributableSpoken` is a separate reported field, so a reader can see how much
of the book the share actually speaks for. When `attributableSpoken` falls under
`MIN_SPOKEN_FOR_VERDICT` the share is `null` and no verdict is given — the
honest answer for a book whose ids have drifted wholesale, and the orphan banner
is the surface that can act on it.

**This is the one place the spec knowingly under-reports.** A book can be both
drifted and collapsed, and a reader of the share alone will not see the drift.
That is why the column is mandatory in Wave 1's output rather than optional, and
why §Wave 1 acceptance criteria requires it to be visibly non-zero on the books
that have it.

**Shape (Wave 1):**

**Every count below is a count of SOURCE SPANS** (D14), not of model sentences.
That is the one sentence an implementer must carry into every field.

```ts
interface AttributionMeasurement {
  language: string | null;       // resolved BCP-47 primary subtag; null iff 'unknown'
  languageSource: 'declared' | 'detected' | 'unknown';

  // ---- denominator: parsed from ch.body, independent of the model (D14) ----
  spokenTotal: number;           // `speech` spans in dialogue paragraphs
  tagTotal: number;              // `tag` spans — the D15 sibling column

  // ---- how much of the denominator the model actually answered (D17) ----
  unattributedSpeech: number;    // speech spans NO aligned sentence covers.
                                 // The omission signal. NEVER a silent shrink.
  splitSpeech: number;           // >1 aligned sentence, disagreeing ids
  lumpedSpeech: number;          // aligned sentence straddles speech + tag/narration

  // ---- numerator, split by origin (D18) ----
  narratorIdSpoken: number;      // speech spans resolving to NARRATOR_CHARACTER_IDS
                                 // — THE numerator. = the three below, summed.
  modelNarrator: number;         // stage-2 returned narrator
  demotedNarrator: number;       // stage-2 returned a character; a post-stage-2
                                 // step overwrote it (priorCharacterId present)
  unknownOriginNarrator: number; // cache predates priorCharacterId. NOT foldable
                                 // into modelNarrator — see D18.

  // ---- id drift (D9/D13), unchanged in rule, re-based on spans ----
  orphanSpoken: number;          // unresolvable id; reported, NEVER summed in (D9)
  orphanIds: string[];           // the distinct unresolvable ids, for the drift surface
  attributableSpoken: number;    // spokenTotal - orphanSpoken - unattributedSpeech
                                 // - splitSpeech — the DENOMINATOR of the share.
                                 // NOT the same as spokenTotal; see below.

  // ---- sibling signals ----
  tagNarratorSpan: number;       // tag spans attributed to narrator — SHOULD be
                                 // near tagTotal. Reported, never alarmed on (D15)
  dashOnlySpoken: number;        // diagnostic — see below
  quietCastCount: number;        // non-narrator cast members with < 2 spoken spans
  castCount: number;             // non-narrator cast members, from cast.json

  chapters: {
    chapterId: number;
    spokenTotal: number;
    attributableSpoken: number;
    narratorIdSpoken: number;
    unattributedSpeech: number;
    orphanSpoken: number;
  }[];
}
```

**`unattributedSpeech` and `splitSpeech` leave `attributableSpoken` for the same
reason orphans do, and leaving them in would reopen D9's hole one level down.**
A span nobody attributed cannot be evidence that the narrator took it, and a
span whose sentences disagree cannot be evidence either way. Counting them in
the denominator would make a book whose stage-2 output went missing wholesale
read *healthier* the more it lost — which is #1984's own failure shape, for the
fourth time in this document. Counting them in the numerator would be worse: it
would report an omission as a collapse and send the user to a re-analysis for a
defect a re-analysis will not name.

**They are therefore mandatory columns, exactly as `orphanSpoken` is**, and the
share is `null` when `attributableSpoken` falls under `MIN_SPOKEN_FOR_VERDICT`.
A book whose speech spans are mostly unattributed has a metric that has nothing
to say about it, and saying so is the honest output.

**`unknownOriginNarrator` is not `modelNarrator`, and this is the D18 trap.**
Every cache written before `priorCharacterId` exists lands entirely in this
column. An implementation that defaults an absent field to "the model said so"
reports 100% model-assigned on every historical book — confidently, from no
evidence — which is the same shape as `supported` being unable to distinguish a
decision from a surrender (R-5C3). The column is separate, it is displayed, and
it clears itself on the next analysis.

**There is deliberately no `narratorSpoken` field.** Revision 5 had one, defined
as `narratorIdSpoken + orphanSpoken`, and it is what let the measurement backing
that revision quietly compute a *third* thing again. A field whose name says
"renders as the narrator" but whose value must exclude ids that render as the
narrator is a trap for the next implementer; the share is computed from
`narratorIdSpoken` and nothing is named ambiguously (R-6C1).

**`languageSource` has no `| null` arm.** Revision 5 wrote the prose for
`'unknown'` and left `| null` in the interface block 27 lines below it — the
block an implementer actually copies (R-6N2).

**On the contradiction path, `language` is the language the row was *measured
against*, not `null`** (R-7m3). Revision 6 wrote "`language` is `null` exactly
when `languageSource === 'unknown'`", which is incoherent for step 4b: reaching
that branch requires `spokenTotal` to have already been computed under the
*declared* language's conventions, so a row reading `language: null,
spokenTotal: 0` tells the reader nothing about what was measured against what.
The rule is therefore:

| Path | `language` | `languageSource` |
|---|---|---|
| declared, corroborated or never tested | the declared code | `'declared'` |
| detected (no declaration) | the detected code | `'detected'` |
| **declared, contradicted at 4b** | **the declared code** — what the numbers were computed against | `'unknown'` |
| detection surrendered, nothing declared | `null` — nothing was resolved | `'unknown'` |

`languageSource === 'unknown'` is the single signal that the measurement is not
to be trusted; `language` stays informative wherever there is anything to say.
The pairing asserted is the weaker, true one: **`language === null` implies
`languageSource === 'unknown'`**, not the converse.

There is no `languageCorroborated` field. It appears in §Failure modes' step 4
as a *branch*, computed and discarded there; putting it on
`AttributionMeasurement` would push I/O into the pure module, which is R-6M1.

**`dashOnlySpoken` is the calibration diagnostic, and revision 8 narrows both
its definition and its claim.** Revision 4 justified it by `isSpokenLine`'s
language-blind dash rule at `narrator-default.ts:32` — **that literal is gone**
(F4/F12): a leading dash is dialogue only where the language's own
`dialogueOpen` says so, i.e. in `ru`, `es` and `fr`, and never in `en`, `de`,
`zh` or `ja`.

What survives is the real hazard, and it is narrower and still live: **in a
dash-convention language the paragraph-opening dash is also ordinary
punctuation.** An EPUB whose conversion prefixes continuation lines with a dash,
or a Russian novel using the em-dash as an ordinary aside marker, produces
paragraphs `parseChapterStructure` reads as dialogue when they are narration.
Those become `speech` spans, land in the denominator, are correctly attributed to
`narrator`, and inflate the share.

`dashOnlySpoken` counts the speech spans in dash-opened paragraphs that carry no
quote mark at all. **It is the column that tells us whether any given threshold
is a sane line or a trap on the language that most stresses it** — which is
Russian, and is both known-damaged books' language.

**D14 does not remove this false positive; it moves it.** Under revision 7 a
dash-prefixed narration line was one dialogue sentence in the denominator; under
D14 it is one speech span in the denominator. The magnitude is the thing that
changed, and nobody has measured it. That is Wave 1's job, and the threshold is
still calibrated against this column.

## The CJK denominator defect — DISCHARGED by #2245

**Revision 8: this whole section is history.** It is retained in outline because
its reasoning is the reason D14 exists, and because deleting it would lose the
record of a defect this document found and did not itself fix.

**What it was.** Revision 4 found, by measuring the live corpus 2026-08-09, that
`isSpokenLine` carried a hardcoded opener bundle with **no CJK corner brackets**.
A Chinese or Japanese dialogue line — `「别管。」`, `「放っておけ」と、…` — returned
`false`. Seven CJK caches carried 28–122 bracket-quoted dialogue lines each and
every one scored `spokenTotal: 0`; of those seven, two had live books (the `ja`
and `zh` Coalfall translations, 104 and 122 dialogue lines, casts of 10 and 9),
and the other five were orphan caches whose books had been deleted (R-5C1).

**Why it mattered.** A healthy CJK book satisfied all three clauses of `missing`
— a real cast, `spokenTotal === 0`, and a completed run's deleted snapshot — so
the fix for #1984 would have **badged every Chinese and Japanese book as damaged
and blocked its generation.** The mirror of R-O1: that finding was a damaged book
reading as healthy, this was a healthy book reading as damaged, and both came
from a denominator that could not see the dialogue it was counting.

**Who fixed it.** #2245, merged into `main` while this document sat on its
branch. `isSpokenLine(text, conventions)` now reads the same `LanguageConventions`
tables the structure engine uses, so `zh`/`ja` corner brackets, all four German
`quotePairs` forms, and every other language's marks come from `lang/*.ts`. The
file's own header states the motive in the same terms this section used: _"the
old bundle carried only one of German's four `quotePairs` forms and recognised no
CJK quote glyphs at all."_

**What that discharges, and what it does not.**

| Revision-7 item | Status |
|---|---|
| Part 1 — language-aware denominator (D12) | **Superseded by D14**, which goes further: source-anchored, not merely conventions-aware. See F1/F2 |
| Part 2 — `isSpokenLine` gains `「」`/`『』` | **Shipped in #2245.** Withdrawn from this spec |
| The German `»…«` gap and its three-of-four table (R-5M2, R-6C4) | **Closed by #2245.** Deleted as a known limitation |
| `blindSpoken` / `overcountSpoken` / `pipelineSpoken` | **Deleted.** F3/F4/F5 — the two definitions are one function, so the gap is identically zero forever |
| Wave 1 criteria 10 and 11, the corpus replay, fixture-row mutation controls | **Discharged / respecified.** F7/F8/F9 |
| The two historical 97–99% CJK collapses | **STILL UNEXPLAINED.** Both predate #2245; their books are deleted, so no live evidence remains. The follow-up issue stands |

**The leading hypothesis for those two collapses is weaker than revision 7 said,
and this is F11.** R-7M3 named `analyzer.structure.enabled` — a user-settable
boolean defaulting `true` (`registry.ts:1267-1273`) — as a run-dependent
explanation: with the engine off, the `else` branch ran `applyNarratorDefault`,
which for a CJK book demoted *all* of its dialogue. **#2245 removed that
consequence.** The knob still selects the branch, but `analysis.ts:2210` now
resolves `conventions` outside the knob, so the `else` branch reads CJK dialogue
correctly and demotes nothing. Knob-off can no longer produce total attribution
loss on a CJK book, so it can no longer be the mechanism — for a run *today*.
Whether it was the mechanism in 2026-07 is unfalsifiable now that the books are
gone. The follow-up issue keeps its subject and loses its named first task.

**One claim from this section survives intact and is load-bearing for D14.**
A detector that shares its subject's definition of dialogue can only ever report
collapse its subject is capable of seeing. #2245 fixed the *marks*; it did not
fix the *text*. `isSpokenLine` still judges what the model returned, which is
precisely the blindness F1 measures. D14 is that argument applied one level
deeper, and the fact that revision 4's version of it was closed by someone else's
PR is not evidence the argument was wrong — it is evidence it was too shallow.


## The measurement script

`scripts/measure-attribution.mjs` — read-only, writes nothing to any book.
Walks the workspace, prints one row per book (title, `language`,
`languageSource`, `spokenTotal`, `tagTotal`, `narratorIdSpoken`, share,
`modelNarrator`, `demotedNarrator`, `unknownOriginNarrator`,
`unattributedSpeech`, `splitSpeech`, `orphanSpoken`, `tagNarratorSpan`,
`dashOnlySpoken`, `castCount`) sorted by share descending, plus the worst
chapter per book, and writes a JSON report to the scratch path for follow-up.
**The three revision-7 gap columns are gone** — `pipelineSpoken`, `blindSpoken`
and `overcountSpoken` are identically zero after #2245 (F3/F4/F5).

**This script is the only place the distribution exists.** Everything it prints
was, in some earlier revision, hand-computed into this document instead — and
every one of those attempts was wrong. Three properties follow from that history
and are requirements, not style:

- **It walks the library, never the cache directory.** The workspace is the list
  of books; a cache file is an artifact that may outlive its book. On the
  reference box 54 of 76 caches have no book at all, so the two starting points
  differ by more than a factor of three.
- **It skips `.upgrade-backups/`.** That directory holds whole copies of the
  books tree, so a naïve recursive walk finds each book several times over and
  dedupes by `manuscriptId` to *a* copy — not necessarily the live one. That is
  how a draft of revision 5 produced cast counts from a backup.
- **It calls `computeAttributionMeasurement`, and applies §Universe.** No
  re-implementation of the filters, the resolver, the parser or the aligner —
  the whole point is that the number in the report is the number the product
  computes. Revision 5's measurement skipped the excluded-chapter filter and
  changed two books' denominators by doing so.
- **It reads the manuscript record, not only the cache** (revision 8, D14). A
  book whose cache exists but whose manuscript record is gone has no source
  prose, so it has no denominator; the script reports it as `no manuscript`
  rather than as a blank row or a zero. That is a real corpus state — the
  workspace and the cache directory have already been shown to diverge by a
  factor of three — and it is the newest way this feature can turn itself off
  silently.

Four rows must be **visibly distinct from a healthy book and from each other**,
because each is a state an earlier revision could not express: a book with a
cast and nothing attributed; a book whose language could not be corroborated; a
book that has never been analysed; and a book whose source prose is gone. None
may render as a blank row.

Its output is the input to the Wave 2 threshold decision. Pure helpers
unit-tested in `scripts/tests/`, matching the `build-companion-apk.test.mjs`
pattern.

**Every threshold in this document is uncalibrated against D14's unit.** The
share is now over source speech spans, and revision 7's was over dash-opening
cached sentences; a Russian dash paragraph contributes **one** span where it
contributed **two** sentences. Wave 2's `COLLAPSE_SHARE_THRESHOLD`,
`DRIFT_SHARE_THRESHOLD` and all four floors are therefore set from this run and
from nothing earlier — including the round-7 gate's "an order-of-magnitude gap
separates the drifted books", which was measured under the old unit and is
**motivating evidence, not calibration** (see §D13 re-gated).

## Wave 1 acceptance criteria

### The five criteria, verbatim

These are the repo owner's own words from
[#1984#issuecomment-5275487278](https://github.com/dudarenok-maker/Castwright/issues/1984#issuecomment-5275487278)
and
[#1984#issuecomment-5275507915](https://github.com/dudarenok-maker/Castwright/issues/1984#issuecomment-5275507915).
They are reproduced unedited and they govern; everything else in this section is
subordinate to them.

> 1. Denominator comes from the **source prose**, never from the model's returned
>    text; the join to model output is dash-insensitive.
> 2. Speech halves and tag halves are reported **separately**, per the book's
>    language conventions.
> 3. A regression test that feeds the metric a run with leading dashes stripped
>    from tag halves and asserts the score **does not move** — that is the exact
>    false-recovery in §1, and without it the metric can be gamed by a
>    punctuation change.
> 4. A test that a sentence absent from stage-2's output is visible to the metric
>    as absent rather than as a denominator that quietly shrank.
> 5. **The panel distinguishes model-assigned `narrator` from engine-demoted
>    `narrator`.** These are different defects with different fixes — the first is
>    a prompt/model problem, the second is `applyNarratorDefault` firing on text
>    it cannot read — and they are indistinguishable in the final `characterId`
>    alone. #1984 exists to make collapse visible; a figure that shows collapse
>    without saying which of the two produced it tells the user something is
>    wrong and nothing about what to do. The demotion site already knows:
>    `analysis.ts:2287` runs after stage-2, so the pre-demotion assignment is
>    available at that point.

**Criterion 5's scope is widened here and the widening is declared, not
smuggled** (see D18): with the structure engine ON — the default —
`applyNarratorDefault` does not run, and the reassigning step is `crossExamine`.
Reporting only `applyNarratorDefault`'s demotions would report zero on every
default-configuration book, which is criterion 5 satisfied on paper and blind in
production. Both overwrite sites record `priorCharacterId`. Criterion 5's stated
mechanism is a floor, not a ceiling.

**Criterion 3's assertion is strengthened for free**, per the owner: feed the
metric a run with leading dashes stripped and assert **both** that the score does
not move **and** that the demoted lines are reported as engine-demoted rather
than model-assigned.

### The rest of Wave 1's criteria

Renumbered from 6 so the five above keep their numbers.

6. `computeAttributionMeasurement` is pure, has **no I/O**, and **imports** its
   building blocks rather than re-implementing any of them: `parseChapterStructure`
   + `buildNameIndex` + `conventionsFor` for the denominator, `alignSentences`
   for the join, and `NARRATOR_CHARACTER_IDS` + `buildCastResolver` for the
   numerator. No second copy of anything, and **no new "is this dialogue"
   predicate** — that is F2's whole lesson.
7. **The language, the snapshot, the sentences and the chapter bodies are
   resolved by an impure caller and passed in.** Revision 5 put the language
   chain inside the module criterion 6 requires to be pure (R-6M1); revision 8
   adds a second file read (`ChapterHint.body`) and must not repeat it. One
   impure resolver does the reads; the pure metric receives
   `{ language, languageSource }`, the sentence list, and the bodies.
8. **The share is `narratorIdSpoken / attributableSpoken`** (D9) — orphans,
   unattributed spans and split spans are out of the numerator *and* out of the
   denominator. Asserted by a fixture whose orphan count is large enough to move
   the share under either mistake; a fixture with zero orphans proves nothing
   here. **A book whose dialogue is entirely orphaned reports `share: null`,
   never `0%`.**
9. **`orphanSpoken` and `orphanIds` are non-zero and correct on the books that
   have unresolvable ids**, resolved through `buildCastResolver` with each book's
   real `cast-id-history.json`. A run reporting 0 everywhere means the resolver
   was bypassed, not that the corpus is clean.
10. **The orphan share is printed per book**, since D13's `DRIFT_SHARE_THRESHOLD`
    is set off this column exactly as the collapse threshold is set off the other.
    Wave 1 ships no threshold for either.
11. The script runs against the live workspace and prints a row for every book,
    reporting — never silently skipping — books with no cache, and books whose
    **manuscript record is gone** (the new `unmeasurable` producer D14 creates).
12. The script **flags a book with a cast and no attributed sentences
    distinctly** from a never-analysed one (D11), and prints whether an
    `analysis-state.json` snapshot exists, since that is what separates an
    abandoned run from a resumable one.
13. No threshold constant, no UI, no persisted state exists yet — **except
    `SentenceOutput.priorCharacterId`**, which is persisted by construction and is
    D18's single permitted analyzer change. `openapi.yaml` is edited first, then
    `npm run openapi:types`.
14. **Every book's language resolves**, and the row records `declared` /
    `detected` / `unknown`. A book that reaches `unknown` is reported distinctly
    from both a damaged book and a never-analysed one.
15. **`unmeasurable` is reachable from a real book shape**: a declared language
    contradicted by detection over the book's own text resolves there rather than
    to `missing`, proven by the fixture rows and their mutation controls.
16. **The measurement is invariant under a punctuation-only rewrite of the
    model's output.** This is criterion 3 stated as a property rather than as a
    test: strip every leading dash, add a leading dash to every line, or replace
    `—` with `-` throughout, and `spokenTotal`, `tagTotal`, `narratorIdSpoken`
    and the share must all be byte-identical. **Anything that varies under that
    transform is reading model text and is a defect.**

**Criteria 10 and 11 of revision 7 are gone** — `isSpokenLine`'s CJK brackets and
`blindSpoken`'s corpus replay. Both shipped in #2245; see F7/F8. Their on-box
register row is discharged with them and must not be carried into the shipping
PR as owed.

**No acceptance criterion here names a share figure, and that is deliberate**
(R-6C3, unchanged). Three revisions hand-computed a distribution into this
document and got three different wrong answers. Producing it is the script's job,
using the real modules.


---

# Wave 2 — warn

Built only after the Wave 1 numbers are read. Everything below is settled
**except** the numeric threshold, which Wave 1 sets.

## D13 re-gated (revision 8)

D13 — the `drifted` state — was added after the round-6 gate, went through its
own scoped gate as revision 7, and was then **reworked in the fold without being
re-reviewed.** Five things changed in that fold: the cache-sourced banner tier
(R-8C1), the gate's move to `enqueueQueueEntries` (R-8C2), `alsoCollapsed`
(R-8C3), `unacknowledgedOrphanSpoken` (R-8M1), and `attributionVerdictKey`
moving from the resolver's inputs to the measurement's outputs (R-8M2). None of
those five has been read by anyone but their author. This section is the
re-gating.

**Verdict: the decision holds; its numbers do not; one owner question is still
open and is now more expensive to answer late.**

**What holds, and why the rebaseline does not touch it.** D13 is about
**identity**, not punctuation. `buildCastResolver` resolves a `characterId`
against `cast.json` plus `cast-id-history.json`; nothing in #2245, #2253, #2289
or #2288 M1 touches that path, and nothing in F1's dash-stripping can create or
destroy an orphaned id. Every mechanism the fold introduced was verified against
today's tree:

| Mechanism | Verified 2026-08-13 | Verdict |
|---|---|---|
| The banner is fed from rendered segments, not the cache | `collectOrphanedCharacterFallbacks` at `segments-io.ts:371` (was `:338` — F12), still `await loadSegmentsFiles(...)`-first | **Holds.** R-8C1's premise is intact |
| `enqueueQueueEntries` is the real chokepoint | `ENQUEUE_TRIGGER_TYPES = new Set(['ui/requestStartGeneration'])` at `generation-stream-middleware.ts:72`, unchanged | **Holds.** R-8C2's bypass is still open |
| Linking does not refetch | `handleLinkOrphanMatch` at `cast.tsx:755` (was `:583` — F12), still no attribution refetch | **Holds.** R-8M4's gap is still there |
| The three files sit under three locking regimes | `cast.json` under `withCastLock`, `cast-id-history.json` under `withKeyLock`, cache unlocked — and #2260 has since bounded every acquisition at 10 s with a `LockAcquisitionTimeoutError` | **Holds, and is stronger than revision 7 knew.** Input-keying's torn-read hazard is now *also* a lock-timeout hazard. Output-keying still avoids both |

**What does not hold: D13's calibration.** The round-7 gate's one
could-have-been-fatal check was that a workable threshold pair exists —
_"the orphan share is strongly bimodal: a small group of badly-drifted books,
then an order-of-magnitude gap, then everything else at or near zero."_ That was
measured with `spokenTotal` as **dash-opening cached sentences.** Under D14
`spokenTotal` is **source speech spans**, roughly halving on a dash-convention
book and moving by an unmeasured amount elsewhere, while `orphanSpoken` — a
count of *attributions* — moves differently again. **The gap may still be there;
nobody has looked at it in the new unit.** The claim is downgraded from "checked,
and the answer was yes" to "checked under a unit this spec has since replaced".

Practically that means: **D13 cannot be approved on the round-7 evidence.** Wave
1's run re-establishes it or it does not, and if the bimodality does not survive
the re-basing, D13 is dropped rather than shipped with a threshold picked off a
book. That is the same bar §Trigger already sets for `COLLAPSE_SHARE_THRESHOLD`;
D13 was simply believed to have cleared it already.

**One further consequence the fold did not draw.** `unacknowledgedOrphanSpoken`
is now a fraction over `spokenTotal`, but three *other* populations have since
been carved out of `attributableSpoken` — `unattributedSpeech`, `splitSpeech`
and the orphans themselves. A book with heavy stage-2 omission would have a
large `spokenTotal`, a small attributable slice, and a drift share diluted by
spans nobody attributed at all. **The drift share must be over
`spokenTotal - unattributedSpeech`**, not over `spokenTotal`: an unattributed
span is not evidence the id drifted, and leaving it in the denominator lets an
omission suppress a drift warning. Recorded here because it is exactly the
shape of R-8C3 — a field whose definition was correct when written and stopped
being correct when a sibling changed.

**Still owed from the owner, unchanged and now more expensive.** R-8C1 put a
scope question to the owner: the `drifted` notice points at the Cast orphan
banner, but that banner has **zero rows on every book D13 fires on**, so D13
requires the banner to gain a cache-sourced tier — _"if the owner declines this
scope, D13 must be dropped rather than shipped without it."_ **That question is
still unanswered**, and Wave 2 has grown since it was asked: the answer now also
decides whether `alsoCollapsed`, the fifth library state, the fifth notice
variant and `attributionVerdictKey` are built at all. It is the first of the
four owner decisions listed in §Open questions.

## Trigger (D2, revised)

Revision 1 triggered on the book-level share alone. That leaves partial damage
silent: a 40-chapter book where two chapters collapse completely scores
`60/1200 = 5%` and shows nothing — two hours of audio in the wrong voice, which
is the exact expense the issue says this exists to prevent.

**A book is collapsed when the book-level share crosses the threshold, OR when
any single chapter with at least `MIN_SPOKEN_PER_CHAPTER_TRIGGER` spoken
sentences crosses it.**

```
COLLAPSE_SHARE_THRESHOLD        = <set by Wave 1>
DRIFT_SHARE_THRESHOLD           = <set by Wave 1>   // D13
MIN_SPOKEN_FOR_VERDICT          = 20   // book-level floor, on attributableSpoken
MIN_ORPHAN_FOR_VERDICT          = 20   // floor for the drifted verdict (D13)
MIN_SPOKEN_PER_CHAPTER_TRIGGER  = 20   // a chapter may only TRIGGER above this
MIN_SPOKEN_PER_CHAPTER_DISPLAY  = 5    // a chapter shows a % above this
```

**`drifted` has no per-chapter trigger, deliberately.** Drift is a property of
the *cast*, not of a chapter: an id that fails to resolve fails everywhere it
appears, so a chapter-level view would report the same defect once per chapter
and add nothing. The book-level share plus `orphanIds` is the whole signal.

`MIN_ORPHAN_FOR_VERDICT` exists for the same reason as its sibling: the corpus
carries books with a **single** orphaned id covering a handful of lines, and
badging those would train the warning into noise on books nothing is wrong with.

### "Not the same character" is the exit, and it has to count as one (R-8M1/M2)

Two findings meet in one fix. **There are orphaned ids no user can ever link**,
because they name no character: the corpus carries `unknown-male`,
`unknown-female`, `voix-inconnue`, `unbekannte-stimme`, `the-jogger`, `driver`,
`woman-in-taxi`. Link is impossible for these by construction. And **rejecting
one changes nothing about the verdict**, because `buildCastResolver` only ever
*blocks* on a rejection — an id that is already unresolvable stays unresolvable
after "Not the same character". With `drifted` gating generation, a book whose
residual orphans are all unlinkable would be **permanently badged and permanently
blocked, with no action available that clears it.** A gate with no exit is not a
gate, it is a wall.

So the drift verdict counts **unacknowledged** orphans only:

```
unacknowledgedOrphanSpoken = orphaned lines whose id is NOT in
                             cast-id-history's bare `rejected` set
```

- **Bare `rejected` counts as acknowledged; `rejectedPairs` does not.** The
  semantics already differ exactly this way: `rejected` blocks an id "against
  every candidate, forever" — a user saying *this is not any of my characters* —
  whereas a `rejectedPair` only rules out one target and leaves the id open to
  another. Reading the broad one as an acknowledgement is the meaning it already
  has, not a new one bolted on.
- **It makes rejection verdict-relevant**, which incidentally removes the
  re-arming defect: revision 7 hashed `rejected`/`rejectedPairs` into the
  dismissal key, so every "Not the same character" click re-armed a warning it
  could not affect. Now the click can lower the share, so re-evaluating is
  correct rather than noise.
- **`orphanSpoken` still reports every orphan**, acknowledged or not. Only the
  *verdict* narrows. A user who acknowledged an id has said "don't warn me", not
  "pretend it isn't there", and the Wave 1 column must not lose it.

**A separating threshold does exist — that was checked before committing to
D13**, because a fifth state that cannot be calibrated is worse than the silence
it replaces. Reconnaissance over the live corpus (2026-08-11, through the real
`buildCastResolver` with each book's own `cast-id-history.json`) found the orphan
share **strongly bimodal**: a small group of badly-drifted books, then an order-
of-magnitude gap, then everything else at or near zero. Any threshold inside that
gap separates them. The numbers themselves are Wave 1's to print (R-6C3) — the
claim recorded here is only that the question was asked and the answer was yes.

Two calibration hazards for Wave 1 to check explicitly, both of which a table
would hide:

- **The two floors exclude different books, and only their conjunction is
  right.** The share floor is what keeps a long novel with a few dozen stray
  lines quiet; the count floor is what keeps a *short* book with a couple of
  stray lines quiet. Either alone badges a book nothing is wrong with.
- **At least one live book sits exactly on the proposed `MIN_ORPHAN_FOR_VERDICT`
  of 20.** A floor placed on a corpus value is a coin-flip that will land
  differently on the next re-analysis, so the constant is set from the gap, not
  from a book — and Wave 1's output is what shows where the gap is.

**Known limitation, accepted: a share rule hides absolute damage on long books.**
The corpus contains a long novel carrying several dozen orphaned lines at a
fraction of a percent — more lines than some books that *do* badge — and D13 is
deliberately silent about it. The alternative, an absolute-count trigger, badges
every large book with a handful of stray ids, which is the noise `drifted` exists
to avoid. The lines are still reported in Wave 1's `orphanSpoken` column and in
the health response; they simply do not raise an alarm. Recorded here rather than
discovered later, alongside the dash and first-person false positives.

The display floor and the trigger floor are deliberately different, and
conflating them is the easy mistake: a 6-spoken-line chapter is worth showing a
number for and is not worth flagging a book over.

Hardcoded exported constants, **not** registry knobs — nobody asked for them to
be tunable, and a knob would owe an Advanced-Settings row and a config-sync
entry for no benefit.

## Storage and data flow

`GET /api/library` never reads the analysis cache and must not start: measured
on the reference box (2026-08-11), the cache is **76 files, 28.0 MiB total,
largest 3.5 MiB.** (Revision 5 carried 24.9 MB / 3.4 MB, measured earlier and
never refreshed; it also contradicted this document's own "3.7 MB" for Night
Watch's cache — the same file, in different units — R-7m2. Sizes are stated in
MiB here and decimal MB there; only the largest-file figure is load-bearing and
it has grown, not shrunk, so the argument holds a fortiori.)
Loading that to render a badge on every library navigation is not viable.

### `analysedAt` is a property of the data, not of who wrote it

`saveAnalysisCache` already stamps `updatedAt` on **every** write
(`server/src/store/analysis-cache.ts:146`). That is the identity used:

```
analysedAt = cache.updatedAt   (fallback: cache file mtime when the field is
                                absent, i.e. a cache written before the field
                                existed — `updatedAt?` is optional at :109)
```

This is load-bearing for three separate reasons:

- **It fixes the crashed-run hole (R-M6).** Phase 1 writes the cache per chapter.
  A run that dies mid-Phase-1 leaves a half-attributed cache but never reaches
  the success-path stamp write. Keyed on a write timestamp, a dismissal made
  before the crash would suppress the damage on every surface. Keyed on
  `cache.updatedAt`, the crash moved it, so the dismissal re-arms.
- **It removes the race revision 1 claimed to have removed (R-M2).** When
  `analysedAt` is a pure function of the cache, no write ordering between the
  backfill, the refresh, and the analysis routes can orphan a dismissal. Nothing
  needs a lock, because nothing is racing over a value anyone mints.
- **It survives a backup restore or a workspace move**, which file mtime does
  not (R-Mi4).

Consequence, accepted: a per-chapter retry moves `cache.updatedAt` and so
re-arms a dismissal for the whole book. With a per-chapter trigger now in play
that is the right behaviour — and if the retry fixed the chapter, the warning
auto-clears without the user doing anything.

### `drifted` breaks that identity, and the fix has to be in the same shape

**`cache.updatedAt` is not a sufficient identity for D13**, and this is the one
place the fifth state costs something structural rather than cosmetic. The
`drifted` verdict is a function of three inputs — the cache's `characterId`s,
`cast.json`, and `cast-id-history.json` — and **the user's remedy touches only
the last two.** Recording an alias through the orphan banner calls
`retireCharacterId`, which writes `cast-id-history.json`; the analysis cache is
untouched and `cache.updatedAt` does not move.

Keyed on `analysedAt` alone, the consequences are both wrong and in opposite
directions:

- **The badge would not clear.** A user links every orphan, fixes the book
  completely, and the library still says `drifted` until the next re-analysis —
  the "stamp catches up on the next read" circularity R-M4 already rejected once.
- **A dismissal would not re-arm.** Dismiss a drifted book, then let a
  re-analysis mint a *new* orphan class while the cache write happens to be the
  same one already dismissed against, and the new damage is suppressed.

Neither `cast.json` nor `cast-id-history.json` carries a timestamp of its own
(both verified — `cast.json` has a single `characters` key), and file mtime was
rejected in R-Mi4 for not surviving a restore or a workspace move. So the
identity becomes a **pure function of the data**, exactly as `analysedAt` is:

```
attributionVerdictKey = hash(
  narratorIdSpoken, attributableSpoken, spokenTotal,
  sorted [orphanId, lineCount] pairs,
  acknowledged orphan ids,
)
```

**The key is over the measurement's *outputs*, not its inputs, and revision 7
had it the other way round** (R-8M2). Input-keying was wrong in both directions:
it re-armed on changes that cannot alter the verdict — every verdict-neutral
rejection, and `saveAnalysisCache` unconditionally stamping `updatedAt` on
routine writes that change no `characterId` — while requiring the spec to
enumerate correctly which inputs matter, which it got wrong on its first attempt
by hashing `rejected`.

Output-keying is strictly better on all three counts: it changes **exactly**
when the verdict can change; it needs no claim about which files feed the
resolver; and it closes the torn-read hazard input-keying created. **Three files
under three different locking regimes** — the cache unlocked, `cast.json` under
`withCastLock`, `cast-id-history.json` under `withKeyLock` — cannot be hashed
consistently by an independent reader, and a dismissal storing a torn key would
never match again, leaving a book permanently un-dismissable *and*, under D13,
permanently gated. Keyed on outputs, the key is computed from **the same
measurement the response returns**, in one pass, so there is no second read to
tear against.

R-M2's property is preserved and is why the shape works at all: the key is still
a pure function of the data with nothing minted, so no write ordering between the
banner, the backfill, the refresh and the analysis routes can orphan a dismissal.

`.audiobook/attribution-dismissal.json` stores `{ dismissedForVerdictKey }`
instead of `{ dismissedForAnalysedAt }`. **R-M2's property is preserved and this
is the reason for the shape:** nothing mints a value, so no write ordering
between the banner, the backfill, the refresh and the analysis routes can orphan
a dismissal — there is still nothing to race over. `analysedAt` survives as a
displayed field ("last analysed"), it just stops being the cache key.

**The in-session clearing path does not already exist, and revision 7 claimed it
did** (R-8M4). The draft argued that "linking an orphan is a Cast-view action,
and R-M4's rule is that a detail-surface fetch patches that book's state in
`library-slice`", so clearing was free. It is not: `handleLinkOrphanMatch`
(`src/views/cast.tsx:583`) calls `api.linkOrphanMatch`, dispatches
`castActions.applyOrphanLink` and raises a toast — **there is no attribution
refetch and no library patch.** Nothing recomputes the verdict after a link, so
acceptance criterion 12 as written had no mechanism behind it.

So the wiring is scoped explicitly: **a successful link (or reject) re-fetches
`GET /api/books/:bookId/attribution-health` and patches `attributionState` in
`library-slice`**, which is the same path R-M4 already defined for a
detail-surface read — it simply has to be *called*. One request per repair, on an
endpoint the user is already looking at the results of.

### Two files

| File | Written by | Contains |
|---|---|---|
| `.audiobook/attribution-health.json` | analysis completion, any detail-surface read, the backfill script | the counts + `analysedAt`. **Pure derived cache — no user intent.** |
| `.audiobook/attribution-dismissal.json` | the dismiss endpoint only | `{ dismissedForVerdictKey: string }` — see the `drifted` note above |

Path constants join `droppedQuotesJsonPath` in `server/src/workspace/paths.ts`.
Neither touches `cast.json`, so no `withCastLock` involvement and no new lock
class. There is no `measuredAt`: revision 1 introduced it as "load-bearing" and
gave it no consumer.

### Write sites at analysis completion

`persistDroppedQuotesBatch`'s three call sites in `server/src/routes/analysis.ts`
— `:3568`, `:4209`, `:6208` — are where the stamp is refreshed too. The third,
`:6208`, is the `'analysis-chapters'` site: a **subset** re-run, which must
recompute over the **whole book**, not the chapters it just did. (Revision 5
corrected these three line numbers and then named `:5740` for
`analysis-chapters` in the next sentence — R-6N4.)

### API

`openapi.yaml` is edited first (it is the type source of truth), then
`npm run openapi:types`.

- `GET /api/books/:bookId/attribution-health` — computes live, rewrites the
  stamp, returns:

  ```ts
  type AttributionHealthResponse = AttributionMeasurement & {
    share: number | null;                             // null under the floor
    state: 'ok' | 'collapsed' | 'drifted' | 'missing' | 'unmeasurable';
    alsoCollapsed: boolean;                           // true when `drifted` won
                                                      // and the collapse test
                                                      // WOULD also have fired
    orphanShare: number | null;                       // null under the floor
    triggeredBy: 'book' | 'chapter' | null;
    worstChapterId: number | null;
    analysedAt: string;
    dismissed: boolean;
  };
  ```

- `POST /api/books/:bookId/attribution-health/dismiss` — **takes no body.** The
  server reads `analysedAt` from the cache itself and writes the dismissal. A
  client-supplied timestamp (revision 1) could go stale between the client's GET
  and its POST, making the dismiss button do nothing, silently (R-M7).
- `GET /api/library` — each book gains
  `attributionState: 'ok' | 'collapsed' | 'drifted' | 'missing' | 'unmeasurable'`. **Not a boolean:** a
  boolean cannot distinguish `unmeasurable` from `ok`, which is how revision 1
  reproduced the silence it was written to fix (R-M5).

### Keeping the badge and the banner honest

The badge reads the stamp; the detail surfaces compute live. They can disagree —
exclude some back-matter and the book becomes healthy while the badge persists.
Revision 1's answer, "the stamp catches up on the next read", is circular: the
next read *is* the detail surface, which the badge exists to drive you to.

So: **a detail-surface fetch also patches that book's `attributionState` in
`library-slice.ts`.** The badge updates in the same session, with no refetch and
no cache read on the library path.

### Backfill

`scripts/backfill-attribution-health.mjs` stamps every book that lacks one.
Because `analysedAt` comes from the cache, the backfill and the live path cannot
disagree about it. Books with no cache are skipped and reported.

## Surfaces and copy

One shared component, `src/components/attribution-collapse-notice.tsx`.

```
⚠  Most of this book's dialogue is being read by the narrator.

   72% of quoted lines (103 of 144) went to the narrator.
   10 of 13 cast members have almost nothing to say.

   The verifier dropped 16 quotes across 5 analysis passes,
   which is often the cause.

   [ Re-run analysis ]  [ Chapter breakdown ▾ ]
   [ Dropped quotes ▾ ] [ This book is fine — dismiss ]
```

**The `drifted` notice is a second variant, and its whole job is to send the
user somewhere else** (D13):

```
⚠  Some of this book's dialogue is assigned to characters that no longer exist.

   63 of 127 quoted lines (50%) name 4 character ids your cast doesn't have:
   oduvan, coalfall, brann, berrin.

   If you generate now, those lines will be read by the narrator.
   Linking each one to the right character below fixes it — re-analysing
   won't, and would discard this book's existing audio.

   [ Review character ids ↓ ]   [ This book is fine — dismiss ]
```

- **No "Re-run analysis" button, and the copy says why.** Re-analysis may re-mint
  the same ids, and on a generated book `onReanalyse` wipes chapter-bearing
  history and invalidates the audio (D10). Offering it here would be offering
  the destructive non-fix as the primary action.
- **"Review character ids" scrolls to the orphan banner** already rendered in the
  Cast view — #2238's "N character ids need your decision" section, whose Link
  control is the actual repair. It is a jump, not a duplicate: two controls doing
  the same thing is what R-Mi1 removed from the confirm step.
- **The ids are named, not just counted.** `orphanIds` exists for this: "4 ids"
  is not actionable, `oduvan, coalfall, brann, berrin` is — the user recognises
  the characters and can match them in seconds.
- **The future tense is deliberate.** "will be read by the narrator", not "is" —
  rendered audio already on disk carries the resolved ids and is unaffected. Any
  copy claiming present damage would be false on every book in the corpus.
- When a book is **both** drifted and collapsed, the Cast view renders both
  sections, drift first. The library shows one badge (the higher-precedence
  state) and the response's `alsoCollapsed` flag is what lets a surface know the
  other condition is masked.

- **"almost nothing to say"** is defined or it cannot be computed: non-narrator
  cast members with **fewer than 2** spoken sentences.
- When `triggeredBy === 'chapter'`, the heading names the chapter instead:
  _"Chapter 3's dialogue is being read by the narrator."_ A book-level 5% with a
  96% chapter must not open with "most of this book's dialogue".
- The cause line is **omitted entirely** when the ledger is empty. Collapse has
  other causes, and "dropped 0 quotes" would misdirect.
- Chapters under `MIN_SPOKEN_PER_CHAPTER_DISPLAY` show `—`.

### Placements

| Surface | Treatment |
|---|---|
| `src/views/confirm-cast.tsx` | Full notice above the cast list. **No `Re-run analysis` button** — `:240-244` already renders "Re-analyse manuscript"; a second identical button is noise. |
| `src/views/cast.tsx` | Full notice at the top, where the empty cast members are visibly the symptom. |
| `src/views/generation.tsx` / `src/store/start-generation-flow.ts` | The acknowledgement gate. |
| `src/components/library/library-grid.tsx` **and** `src/components/library/library-table.tsx` | The badge, in **both**. |

**The badge has no shared render path (R-M1).** `library-status-ui.tsx:24`
exports only `STATUS_UI: Record<LibraryBookStatus, StatusMeta>` — a map, no
component; the grid and the table each look the meta up (`library-grid.tsx:167`,
`library-table.tsx:266`) and each render their **own** `<Pill>` JSX
(`:344-347` and `:346-349` respectively — revision 6 cited the lookups as though
they were the render sites, R-7m5).
Attribution-collapse is orthogonal to `LibraryBookStatus` (a book can be
`complete` *and* collapsed), and `library-status-ui.test.ts` pins a hardcoded
status list, so a new key is not representable there. The badge is therefore a
**new small shared component** rendered from both files — and the test asserts
it in both, because "I put it in the shared module" is precisely the false
comfort revision 1 shipped.

`unmeasurable` renders a distinct neutral marker in the library, not nothing.

### The generation gate (R-M3)

`start-generation-flow.ts` is not the only entry: `requestStartGeneration` is
dispatched from `start-generation-flow.ts:83` and `:93`,
`src/components/layout.tsx:1823` (tier prompt), and
`src/modals/clone-readiness-gate.tsx:238` ("proceed anyway"), and
`generation-stream-middleware.ts:72` enqueues on the action type. (Both paths
were cited without their directories through revision 6, and the clone gate lives
under `modals/`, not `components/` — R-7m5.)

Therefore:

- The attribution gate is the **first** gate in the thunk, before voice-readiness
  (`:56`), clone-readiness (`:69`), and the tier prompt (`:96`). The other three
  dispatch sites are *continuations of gates that run after it*, so placing it
  first leaves them correct and unbypassable.
- "Generate anyway" **re-enters the thunk** with `attributionAcknowledged: true`.
  It must not dispatch `requestStartGeneration` directly — that pattern
  (`clone-readiness-gate.tsx:238`) is correct for the *last* gate and would, from
  the first, skip the voice-readiness, clone, and tier gates entirely.
- A test asserts gate composition: a Qwen book that is both attribution-collapsed
  and voice-unready must see **both** gates, in order.

**The thunk is the wrong chokepoint for a fully-rendered book, and this is a
hole in the *collapsed* gate too, not only D13's** (R-8C2). `startGenerationFlow`
has exactly two dispatch sites — `src/routes/index.tsx:775` ("Approve cast &
start generating") and `src/views/generation.tsx:1072` ("Resume generation",
shown only while work is queued and nothing is in flight). **Neither is reachable
on a book that has already finished rendering.** Every re-synthesis affordance
that *is* reachable on such a book — the Regenerate modal, per-character
regenerate, the drift-report regenerate, the stuck-row escape hatch — dispatches
`enqueueQueueEntries` (`src/store/queue-thunks.ts`) directly, and
`ENQUEUE_TRIGGER_TYPES` is `new Set(['ui/requestStartGeneration'])`
(`generation-stream-middleware.ts:72`), so none of them passes the gate.

This matters most for D13, whose entire hazard is "the **next** render", i.e. a
book that has already been rendered once. As specified, D13 would have delivered
a badge and called it a gate. But the same bypass means a **collapsed** book can
be wholly re-synthesised through the Regenerate modal without ever seeing its
acknowledgement, which R-M3 did not catch because it enumerated dispatchers of
`requestStartGeneration` rather than asking what else reaches the synthesiser.

**So the attribution gate moves to `enqueueQueueEntries`**, the one chokepoint
every synthesis path crosses, and the thunk keeps only its *ordering* role:

- `startGenerationFlow` still runs the attribution gate **first**, before
  voice-readiness, clone-readiness and the tier prompt, so the composition
  argument above is unchanged for the first-run path.
- `enqueueQueueEntries` gains the check as a backstop for every other path. It
  fires once per book per acknowledgement, not once per queued entry, or
  regenerating six characters would prompt six times.
- Server-side re-synthesis routes (`chapter-qa-repair.ts`, `chapter-splice.ts`)
  are **out of scope and explicitly so**: they are repair operations on existing
  audio, not a user asking for a fresh render, and they do not read the
  attribution the gate protects.

### The Cast-view re-run (D10, R-Mi1)

`confirm-cast.tsx`'s `onReanalyse` (wired at `:240-244`, labelled "Re-analyse
manuscript") resolves to a handler that dispatches
`changeLogActions.wipeBookShapeEvents()` (`src/routes/index.tsx:685`) then
`uiActions.reanalyse()`. Fired from the `ready`-stage Cast view on an
already-generated book, that wipes chapter-id-bearing history and invalidates
rendered audio.

So in the Cast view the button confirms first **when the book has rendered
audio**, naming what re-analysis will invalidate. On a book with no audio it
fires directly.

### The panel fix (D6, revised — R-C1)

Revision 1 proposed grouping batches by a new `runId`. **A run writes exactly
one batch.** `persistDroppedQuotesBatch` has three call sites, none in a loop;
`:3568` and `:4209` are mutually exclusive branches of `runMainAnalyzerJob` — the
Phase-0 cache-hit path and the Phase-0b consolidation path — and both tag their
batch `'analysis-stream'` (R-6N5: revision 5 still cited the pre-correction
`:3184`/`:3824` here, in the document that corrected them);
`server/src/store/dropped-quotes.ts:55` states it outright — _"Multiple batches
accumulate across **re-runs**."_ The incident's 5 batches were 5 separate runs.
Under `runId` grouping the panel would find one batch and render "dropped 1
quote across 1 character" — byte-identical to today. It was a placebo, and its
"fails before, passes after" test constructed a fixture no writer can produce.

**The fix is to sum the whole ledger and label it honestly:**

> Verifier dropped 16 quotes across 5 analysis passes

replacing today's `latest.totalDropped` and its `· latest batch` disclaimer
(`phase-card.tsx:264-266`). No `runId`, no schema change, no threading through
the routes. This reproduces exactly the number #1984 says the user should have
seen.

The cost is the one revision 1 used to justify `runId`: a re-analysed, healthy
book still shows its old failures. That is acceptable because the label says
"across 5 analysis passes" rather than implying they are current, and because
the collapse notice — which is what the user acts on — appears only when the
book is actually collapsed now.

## Failure modes

The computation **fails open**, but failing open is how a book goes silent, so
there are **five** states and the library shows all five:

| State | Rule | Library | Cast view | Gates generation |
|---|---|---|---|---|
| `ok` | — (including a book never analysed) | nothing | nothing | no |
| `collapsed` | `narratorIdSpoken / attributableSpoken` ≥ threshold, book or chapter | warning badge | full notice | yes |
| `drifted` | `unacknowledgedOrphanSpoken / spokenTotal` ≥ `DRIFT_SHARE_THRESHOLD`, with `unacknowledgedOrphanSpoken` ≥ `MIN_ORPHAN_FOR_VERDICT` (D13) | warning badge | full notice, pointing at the orphan banner | **yes** |
| `missing` | `castCount > 0 && spokenTotal === 0 && (await readAnalysisState(dir)) === null && languageCorroborated` | warning badge | full notice | **yes** |
| `unmeasurable` | the book **has been analysed** and the measurement still could not be made: cache corrupt, **the manuscript record absent so there is no source prose to measure against (revision 8, D14)**, the declared language contradicted by detection over the book's own text, detection surrendered, **or** the resolved language has no conventions table | neutral marker | _"Attribution health couldn't be measured for this book."_ | no |

**That `unmeasurable` cell is normative and revision 5's was not** (R-6M3).
Revision 5 fixed the rule in prose 80 lines below the table and left the table
itself reading "cache absent or corrupt, or the language has no conventions
table" — no analysed qualifier, no mention of the corroboration or the
surrender. An implementer coding from the table reproduces the exact defect the
prose fixed, and two further places said the old thing (§Edge cases and Wave 2
criterion 6, both corrected here). The rule lives in this cell; the prose below
explains it.

**The state derivation is a single sequence, not a precedence over
independently-computed predicates**, and revision 6's first draft got this wrong
in a way worth keeping visible (R-7C1). It wrote the rule two ways at once —
"`unmeasurable` is tested **first**, so a book whose language could not be
trusted never reaches the `missing` test", and, eighty lines earlier,
"corroboration runs **when the measurement would otherwise return `missing`**".
Those are circular: you cannot evaluate a state first whose producer needs the
next state's verdict. An implementer coding the precedence literally runs
corroboration on **every** book, which destroys all three safety properties the
corroboration design rests on.

The sequence, written once and normatively:

```
1. no analysis at all                          → ok        (no claim is made)
2. cache corrupt (loadAnalysisCache throws)    → unmeasurable
2b. manuscript record absent (no source prose) → unmeasurable   [revision 8]
3. conventionsFor(resolvedLanguage) === null   → unmeasurable
4. castCount > 0 && spokenTotal === 0
   && (await readAnalysisState(dir)) === null:
     a. sentences.length === 0                 → missing   (nothing to corroborate)
     b. detection contradicts or surrenders    → unmeasurable
     c. otherwise                              → missing
5. orphan share ≥ DRIFT_SHARE_THRESHOLD        → drifted
6. share ≥ threshold (book or chapter)         → collapsed
7. otherwise                                   → ok
```

**Step 2b is new in revision 8 and it is a consequence of D14, not an
afterthought.** The denominator is built from `ChapterHint.body`, so a book whose
manuscript record is gone has no denominator at all — and the wrong answer is
`spokenTotal: 0`, which with a real cast and a completed run's deleted snapshot
satisfies every clause of `missing` and badges a book nothing is wrong with.
**That is R-4C1's shape for the third time**, arriving through a new door, and it
is caught here rather than discovered later. It is also a real corpus state: the
workspace and the cache directory have already been shown to diverge by a factor
of three, so a cache outliving its manuscript is the ordinary case, not an
exotic one.

Steps 2, 2b and 3 are the only ones that are genuinely "`unmeasurable` first"; the
corroboration arm is **step 4b, inside the `missing` test**, which is what makes
it cheap and what makes it unable to touch an `ok` or `collapsed` verdict.
There is no separate precedence mechanism to delete, and revision 6's mutation
table wrongly billed one — see the note under §Testing.

**`drifted` is tested before `collapsed`, and the reason is not severity** — a
book can be badly both. It is that **drift degrades the collapse figure's own
coverage**: every orphaned line leaves `attributableSpoken`, so the further a
book has drifted the smaller the slice its share speaks for. Repairing drift is
also seconds of work through the banner, against minutes of re-analysis, and the
share is worth re-reading afterwards. Fix the cheap, certain thing; re-measure.

**Both can be true, and the surfaces differ in what they do about it.** The
library badge is one pill, so it shows the higher-precedence state. The Cast
notice renders **both sections** when both apply, because they have different
remedies and showing only one sends the user to the wrong control. The
generation gate is a single acknowledgement listing every condition that fired —
one gate, not two, so §The generation gate's ordering argument is unchanged.

**A sequence that returns cannot report what it skipped, and revision 7's flag
pointed the wrong way** (R-8C3). The draft carried `alsoDrifted: boolean`,
described as "true when `drifted` is masked by a higher state" — but `drifted` is
step 5 and `collapsed` is step 6, so **`collapsed` is the one that gets masked;
`drifted` is never masked by it.** (`missing` needs `spokenTotal === 0` and
`drifted` needs `orphanSpoken` over its floor, so those two are mutually
exclusive as well.) The flag as written could only ever have been set by
`unmeasurable`, and meanwhile the fixture table required the Cast view to render
both sections — which the sequence made impossible, because it returns at step 5
and never evaluates the collapse test at all.

So: the field is **`alsoCollapsed`**, and step 5 computes the collapse verdict
before returning rather than short-circuiting past it. The cost is one extra
comparison on a book already known to be drifted; the alternative is a UI
contract the state machine cannot satisfy.

**Revision 4 claimed this precedence is what stopped a healthy CJK book being
badged. That was wrong** (R-5M1). `zh` and `ja` both have conventions tables
(`lang/index.ts:10`), so a CJK book never resolves `unmeasurable` in the first
place — **D12 alone closes R-4C1**, by giving the book a non-zero denominator.
Worse, under revision 4 the precedence rule guarded a state nothing could enter:
import rejects any language outside the seven-code registry
(`import.ts` `isSupportedLanguage`), all seven have tables, and detection could
only ever return a registry code or `'en'`. It was a guard over an empty set,
and its fixture tested an unreachable state.

**Revision 5's replacement was a guard over an empty set too, and revision 6's
is not** (R-6C2). Revision 5 rested the precedence on detection surrendering —
unreachable, because detection only runs when `state.language` is absent and
import always writes it. The corroboration step of §Language resolution is what
gives `unmeasurable` a producer a real book can reach: **a declared language
contradicted by the book's own text.** Order and reachability are one mechanism,
not two — a precedence rule over a state nothing can enter is decoration, and
this document has now written that decoration twice.

Concretely, the failure the precedence prevents: an Italian manuscript imported
as `en` (the only way it can enter, since staging refuses anything outside the
seven and the user must pick one) is measured against `en` conventions —
`dialogueOpen: null`, pairs `“”` / `""` / `‘’` — scores a near-zero denominator
on its `«…»` dialogue, and with a real cast and a completed run's deleted
snapshot satisfies every clause of `missing`. **That is R-4C1 in another
alphabet.** Corroboration runs `franc` over the book's own text and it does not
come back `en`, so the declaration is contradicted and the book is reported as
unmeasurable rather than accused of damage.

**Be precise about what detection can return here, because it constrains the
test** (and revision 5 was not). `detect-language.ts:57` restricts `franc` to
`only:` the registry's **Latin** codes — `en`, `es`, `fr`, `de`. An Italian
sample therefore does not resolve to `it` and rarely surrenders; it is pushed
onto the nearest registry Romance language. That is exactly what corroboration
needs — **disagreement**, not a correct identification — and it is why the guard
tests "does detection agree with the declaration", never "what is the language
really". A fixture asserting the detected code equals `it` would fail for a
reason that has nothing to do with the defect.

**`missing` is D11, and it is not a rounding case.** Revision 2 gave a book with
a cast and no attributed sentences `share: null` → `ok`, so _Ночной дозор_ in its
2026-08-06 state — a full cast, nothing attributed to any of it — would have
rendered as perfectly healthy in the library. That is the #1984 failure shape
reproduced inside the feature written to close #1984. It is arguably worse than
a 72% collapse: at 72% something is still attributed.

Its copy cannot reuse the collapsed notice, which would read "0 of 0 quoted
lines". It reads:

> ⚠ Analysis never finished attributing this book.
> {castCount} cast members were identified, and no dialogue was found to assign
> to them. The analysis pass that builds the cast completed; the one that
> attributes the text did not.

**The copy says "no dialogue was found", not "not one line assigned", and the
difference is load-bearing** (R-7M2). Revision 6's wording — *"This book has a
cast but no dialogue attributed to it… not one line assigned"* — describes a
**different state from the one the rule detects.** The rule is `spokenTotal ===
0`: no dialogue *exists* in the text. "Nothing is assigned" is what a
100%-orphaned book looks like, and that book has `spokenTotal > 0`, so it never
reaches this notice at all — it reads `ok` (§Edge cases). Copy that describes a
state the rule cannot detect trains the reader to expect a warning that will not
come.

**`missing` is distinguished from legitimate pure narration by `castCount`, not
by `spokenTotal`.** A non-fiction book or a pure-narration text has no
non-narrator cast members, so `castCount === 0` and it stays `ok`. The alarm
fires only on the contradiction: characters exist, and nothing is theirs.

**It is distinguished from an interrupted run by the analysis snapshot** — and
this half is what keeps it from becoming noise. Starting an analysis and
stopping it is an ordinary user action, not a corruption: Phase 0 writes the
cast, Phase 1 never runs, and the book is left with exactly the
cast-and-no-sentences shape. That is how _Ночной дозор_ reached its state (the
repo owner started a re-run and stopped it, confirmed 2026-08-06) — so this is
a **reachable state on the normal path**, not an exotic one.

Badging every paused analysis as damaged would fire the alarm during routine
use, which is how a warning gets trained into background noise. So `missing`
requires `readAnalysisState(bookDir) === null` as well. While a snapshot exists
in any state — `running`, `paused` or `halted` — the book is not badged, because
the existing AnalysisPill already owns that surface and says something truer.

**`readAnalysisState` is `async`** (`analysis-state.ts:85` —
`Promise<AnalysisStateFile | null>`), so it must be awaited. Written literally
as `readAnalysisState() === null` the clause compares a Promise to `null`, is
never true, and **makes `missing` silently unreachable** while every test that
does not exercise it still passes (R-5M5).

That also settles module ownership, which revision 4 left unstated: the state
derivation **does I/O and therefore cannot live in the pure module** Wave 1
acceptance criterion 1 requires. `attribution-health.ts` stays pure and returns
`AttributionMeasurement`; a separate caller resolves the snapshot, applies the
precedence order, and produces the state. The pure module never reads a file.

**Revision 5 drew that line for the snapshot and not for the language, which is
the same class of defect half-closed** (R-6M1). Step 1 of §Language resolution
reads `state.json`; step 3 reads the cached text to corroborate. Both are I/O,
and revision 5's Wave 1 criterion 1 nonetheless listed `detectManuscriptLanguage`
among the pure module's own imports. The resolver is therefore **one impure
function** — `resolveBookLanguage(bookDir, sentences)` — returning
`{ language, languageSource }`, which the pure metric receives as an argument
alongside the sentence list. `detectManuscriptLanguage` is itself pure, so the
resolver is thin; what makes it impure is the `state.json` read, and that is
exactly the boundary.

`readAnalysisState` returns `null` for an absent **or unparseable** file
(`server/src/store/analysis-state.ts:85-93`), which is what makes the rule work
on the real case: Night Watch's `analysis-state.json` is 0 bytes, so it reads as
no rehydratable state and correctly badges. A book with a live or resumable
snapshot does not.

**A book never analysed is `ok`, and the `unmeasurable` rule is scoped so that
this is not a contradiction** (R-5M4). Revision 4 said `unmeasurable` covers
"cache absent", evaluated first, and two paragraphs later that a never-analysed
book is `ok` — under the stated precedence the first won, so **every freshly
imported book would have shown the neutral "couldn't be measured" marker until
analysis finished**, training the reader to ignore the one marker introduced so
that silence could not read as health. The rule is therefore:

> `unmeasurable` = the book **has been analysed** (`castConfirmed`, or a cache
> that exists) **and the measurement still could not be trusted** — cache
> corrupt, the declared language contradicted, detection surrendered, or the
> resolved language has no conventions table.

A book with no analysis has nothing to measure and no claim is made about it: no
badge, no marker, `ok`. The script reports it as `not analysed`, distinct from
both a damaged book and an unmeasurable one.

`assertCacheChaptersShape` throws **inside `loadAnalysisCache`**
(`analysis-cache.ts:124`), not at measure time, so the catch must wrap the
**load**, not the metric.

**The cache is gitignored and lives outside the workspace** (`.gitignore:94`,
`CACHE_DIR` in `analysis-cache.ts`). A server reinstall or workspace move makes
every book `unmeasurable` — the feature turning itself off wholesale. That is
why `unmeasurable` is visible in the library: the failure announces itself
instead of reading as a clean bill of health.

### Edge cases, decided

| Case | Behaviour |
|---|---|
| Zero spoken sentences, **no non-narrator cast** (non-fiction, pure narration) | `share: null`, state `ok`. Nothing is missing — there were never any characters. |
| Zero spoken sentences, **cast present**, no analysis snapshot, **language corroborated** | State `missing` (D11). The contradiction is the signal. |
| Zero spoken sentences, **cast present**, no snapshot, but detection **contradicts** the declared language | State `unmeasurable`. The likelier explanation is that the book is not in the language it was imported as. |
| **Unresolvable `characterId`s present, below `MIN_ORPHAN_FOR_VERDICT` or the drift threshold** | Counted into `orphanSpoken`/`orphanIds` and reported; removed from **both** halves of the collapse share (D9). No badge, no gate — a book with one stray id is not worth an alarm. |
| **Unresolvable ids above both floors** | State `drifted` (D13). Badges, gates, and points at the Cast orphan banner. |
| **Every dialogue line orphaned** (`attributableSpoken === 0`), above the count floor | Collapse `share: null` — never `0%`, which would read as healthy — and state `drifted` at a 100% orphan share. The one book shape where the collapse figure has nothing to say and the drift figure says everything. |
| **Every dialogue line orphaned, but *below* the count floor** (a 15-line novella) | `ok`, `share: null`, and the row shows the orphan count. **Accepted, and it is a genuine gap** — the same shape as the "novella with 19 spoken lines" gap above, for the same reason: below the floor the figure is noise. Revision 7's edge-case table claimed `drifted` here unconditionally, which contradicted its own rule (R-8m1). |
| Book never analysed | State `ok`, no badge, no marker. Reported by the script as `not analysed`. |
| **Cache present, manuscript record gone** (revision 8, D14) | State `unmeasurable`, reported by the script as `no manuscript`. **Never `missing`** — a book with a cast, no source prose, and a completed run's deleted snapshot satisfies every clause of `missing`, so without step 2b it would be badged and gated for having lost a file this feature depends on. |
| **A speech span with no aligned sentence** (D17) | Counted into `unattributedSpeech`, out of `attributableSpoken`, in **neither** narrator column. It cannot be evidence the narrator took the line. Never silently absent from the denominator — that is exactly criterion 4. |
| **A book whose `narrator` origins are all unknown** (cache predates `priorCharacterId`) | State and share are unaffected; `unknownOriginNarrator === narratorIdSpoken` and the other two read 0. The row is legible about it. **Not** reported as model-assigned (D18). Clears on the next analysis; no backfill. |
| Zero spoken sentences, **cast present**, snapshot `running`/`paused`/`halted` | State `ok`. An interrupted run is ordinary use; the AnalysisPill already says so, and badging it would train the warning into noise. |
| Under 20 **attributable** spoken sentences book-wide | `share: null`, no verdict. **Known gap:** a novella with 19 spoken lines, all narrator, is 100% collapsed and reports no verdict. Accepted — below 20 the figure is noise. The floor reads `attributableSpoken`, not `spokenTotal`, so a book pushed under it by id drift is silent rather than confidently wrong. |
| Chapter with 6 spoken lines, all narrator | Shows `100%` in the breakdown; does **not** trigger (under the 20-line trigger floor). |
| User excludes back-matter after analysis | Live compute picks it up; the library badge is patched in the same session. |
| First-person book | See below. |
| **CJK book, cast present, dialogue in `「」`** | Resolves at `zh`/`ja`, `spokenTotal > 0`, so `ok` or `collapsed` on its real share — **never `missing`**. This is R-4C1. |
| **Language absent from `state.json`** | `detectManuscriptLanguage` resolves it; `languageSource: 'detected'`. Applies to 7 of the 20 live books, including the largest. (Revision 5 said "7 of 22" here and "7 of 20" elsewhere in the same document — R-6N6.) |
| **Language resolves to one with no conventions table** | `unmeasurable`, evaluated before `missing`. Not badged, not gated, but visible. **No live producer today** — all seven registry languages have tables — so this arm is defensive, and the reachable producer is the contradiction row above. |

### Known false positives

- **Dash-prefixed narration.** The larger of the two, and unmentioned in
  revision 1. Quantified in Wave 1 via `dashOnlySpoken`; the threshold is set
  against it. Still deliberately **not** fixed by changing any dialogue rule —
  the analyzer acts on the same tables, so that is a much wider blast radius and
  its own piece of work. **Revision 8 note:** the rule now lives in the language
  tables (#2245), so the false positive is gone for `en`/`de`/`zh`/`ja`, whose
  `dialogueOpen` is `null` and for whom a leading dash is not dialogue. It
  remains for `ru`/`es`/`fr`, where `dialogueOpen` matches dashes by
  design — which is why `dashOnlySpoken` survives and why the threshold is still
  calibrated against it. The CJK change in §The CJK denominator defect is a
  different rule in the same function and carries no dash implications.
- **First-person narration.** The analyzer resolves a first-person speaker to a
  roster character (`dialogue-structure/evidence.ts:28`, `windows.ts:56`), so a
  healthy first-person book should not trip this. If that resolution fails, the
  protagonist's dialogue legitimately lands on `narrator`.

Both are why D3 keeps a manual dismiss. Documented limitations, not defects to
design away.

## Testing

**Wave 1 — pure metric (Vitest, server).** `narratorIdSpoken` counts **both**
`narrator` and `char-narrator` — the `char-narrator` case is asserted explicitly,
since matching only `'narrator'` is the exact regression #1895 centralised the
constant to prevent; excluded chapters removed from **both** halves of the
universe; a quoted `excludeFromSynthesis` sentence removes the *attribution*
without removing the source span, so its span reads `unattributedSpeech`; zero
spoken → `0/0` handled; `quietCastCount` at exactly 1 and 2 spans;
`dashOnlySpoken` counts a dash-opened paragraph with no quote mark and does not
count one that also contains one.

### Wave 1 — the five criteria, each with a test that can fail

**Criterion 1 — source-anchored denominator, dash-insensitive join.** One
fixture, two arms, built from a Russian dash paragraph:

```ts
// server/src/store/attribution-health.criteria.test.ts
const body = '— Ничего нет, — сказал Егор.\n— Значит, ищем дальше.\n';

const withDashes = [
  { text: '— Ничего нет,',      characterId: 'egor'     },
  { text: '— сказал Егор.',     characterId: 'narrator' },
  { text: '— Значит, ищем дальше.', characterId: 'anton' },
];
// The EXACT F1 transform: the model returns the same lines, dashes stripped.
const stripped = withDashes.map((s) => ({
  ...s,
  text: s.text.replace(/^\s*[-–—]\s*/u, ''),
}));

it('scores identically whether or not the model returned leading dashes', () => {
  const a = computeAttributionMeasurement({ body, sentences: withDashes, ...ctx });
  const b = computeAttributionMeasurement({ body, sentences: stripped,  ...ctx });
  expect(b.spokenTotal).toBe(a.spokenTotal);           // denominator unmoved
  expect(b.tagTotal).toBe(a.tagTotal);
  expect(b.narratorIdSpoken).toBe(a.narratorIdSpoken); // numerator unmoved
  expect(b.unattributedSpeech).toBe(0);                // and nothing fell out
});
```

**The `unattributedSpeech` assertion is what makes this test able to fail for
the right reason**, and without it the test is a placebo of a familiar shape: an
implementation that loses the join entirely scores `narratorIdSpoken: 0` on
*both* arms and passes the equality. The suite must distinguish "the score did
not move" from "there is no score".

**Criterion 2 — speech and tag reported separately.** The same fixture asserts
`spokenTotal === 2` and `tagTotal === 1`, and that the correctly-narrated tag
half is in `tagNarratorSpan` and **not** in `narratorIdSpoken`. **Mutation:**
fold tag spans into the denominator and this book's share moves from 0% to 33%
— the exact impurity §Speech halves and tag halves measured at 12% of a real
book's denominator. A per-language row is added for `en` (quote convention: a
tag clause is `narration`, not `tag`, so `tagTotal` is 0 and the assertion is
that the *rule is the parser's*, not a case heuristic ported from Russian).

**Criterion 3 — the score does not move under a punctuation-only rewrite**, and
the demoted lines are reported as engine-demoted rather than model-assigned.
Criterion 1's test above is half of it; the second half needs `priorCharacterId`:

```ts
it('reports a dash-stripped demotion as engine-demoted, not model-assigned', () => {
  // What applyNarratorDefault does to a stripped speech half:
  const demoted = [
    { text: 'Ничего нет,', characterId: 'narrator', priorCharacterId: 'egor' },
    { text: 'сказал Егор.', characterId: 'narrator' },
  ];
  const m = computeAttributionMeasurement({ body, sentences: demoted, ...ctx });
  expect(m.demotedNarrator).toBe(1);
  expect(m.modelNarrator).toBe(0);
  expect(m.unknownOriginNarrator).toBe(0);
});
```

**Mutation:** default an absent `priorCharacterId` to "model-assigned" and the
third assertion goes red. That mutation is the whole point of the column — see
D18 — and it is the one an implementer is most likely to make, because it reads
as a harmless default.

**Criterion 4 — an omitted sentence is visible AS absent.** The fixture is
criterion 1's, with one sentence deleted from the model's output:

```ts
it('reports a stage-2 omission as unattributed, not as a smaller denominator', () => {
  const missingOne = withDashes.filter((s) => s.characterId !== 'anton');
  const m = computeAttributionMeasurement({ body, sentences: missingOne, ...ctx });
  expect(m.spokenTotal).toBe(2);          // the source still has two speech spans
  expect(m.unattributedSpeech).toBe(1);   // and one of them nobody answered
  expect(m.attributableSpoken).toBe(1);   // so the share speaks for half the book
});
```

**Mutation:** build the denominator from the sentence list and `spokenTotal`
drops to 1 while `unattributedSpeech` reads 0 — the "denominator that quietly
shrank" the criterion names, reproduced exactly.

**Criterion 5 — the panel distinguishes the two narrators.** Wave 1's half is
the measurement (criterion 3's test above); Wave 2's half is the render, and it
asserts three distinct strings for the three columns, with the
`unknownOriginNarrator` case rendering a legible "analysed before this was
recorded" rather than a zero.

**Cross-cutting: criterion 16's invariance is a property test.** Over a small
generated corpus of dash and quote fixtures, apply each of three
punctuation-only transforms to the model output — strip every leading dash, add
one to every line, replace `—` with `-` — and assert every field of
`AttributionMeasurement` is unchanged. **The fixture set must include at least
one book per convention family** (`dialogueOpen`-bearing: `ru`/`es`/`fr`;
quote-only: `en`/`de`; CJK: `zh`/`ja`), because a property test locks only what
its fixture reaches, and a dash-only corpus proves nothing about the quote
languages the same transform is a no-op on.

### Wave 1 — the pre-existing suite, updated

**Wave 1 — D9's exclusion, and it needs a fixture built to fail** (R-6C1). The
assertion is that `orphanSpoken` is populated **and the share does not move**.
A fixture with one orphan among a hundred spans cannot distinguish the two
formulas at the precision anyone will read, so the fixture is built with the
orphan count comparable to the narrator-id count — summing them changes the
share by tens of points, and the test observably goes red when D9 is mutated
back to a sum. The paired assertion is that `orphanIds` lists the distinct
unresolvable ids, since a count alone cannot drive the drift surface.

**Revision 8 adds a third mistake this fixture must catch.** `attributableSpoken`
now subtracts three populations, not one, and each has its own way of being
forgotten: leave `unattributedSpeech` in and an omission-heavy book reads
healthier the more it lost; leave `splitSpeech` in and a segmenter change moves
the share. The fixture carries a non-trivial count of each, and each is mutated
on its own line.

The resolver half needs its own care: **the cast-resolver test passes with
`buildCastResolver` removed entirely unless the retired id is the narrator's
own.** The fixture therefore retires `char-narrator` → `narrator`, not an
ordinary character, so deleting the resolver changes the numerator rather than
merely the orphan column.

**Wave 1 — the denominator and the language chain.** `parseChapterStructure`
finds `speech` spans in each language's own convention (a `「」` line is dialogue
under `ja`, not under `en`); a declared `state.json` language wins over detection
and sets `languageSource: 'declared'`; a book with no declared language resolves
through `detectManuscriptLanguage` over its **bodies** and sets `'detected'`; a
language with no conventions table yields `unmeasurable` **and never `missing`**,
asserted with a `castCount > 0` fixture so the precedence is what the test is
actually proving. **A book with a cache and no manuscript record yields
`unmeasurable`** — D14's new producer.

**Wave 1 — corroboration.** `detectManuscriptLanguage`'s `fallback` is asserted
on **both** surrender branches — the `letters === 0` pre-pass
(`detect-language.ts:81`) and the `franc` miss (`:98`) — and `false` on a real
match, with the zero-letter case exercised by a sample of pure punctuation and
numerals. **These now pin behaviour #2246 already shipped**, which is the point:
this spec consumes the field, so a regression in it is a regression here.
Corroboration itself is asserted to run **only** on the `missing` path: a healthy
book with a wrongly declared language stays `ok`/`collapsed` on its measured
share and does not become `unmeasurable`, because the guard must not be able to
suppress a real verdict.

> **Deleted in revision 8 (F7, F8, F9).** *"Wave 1 — `isSpokenLine` CJK"* and
> *"The blast-radius control must be the corpus replay"* are gone: #2245 shipped
> the CJK brackets, so there is no "before" to replay and no change of this
> spec's to blast-radius. The on-box register row they were owed is discharged
> with them and must not appear in the shipping PR as owed acceptance.


**Wave 2 — trigger.** Book-level at threshold ±1 sentence; a chapter trigger
firing while the book-level share is far below it; a chapter at 100% with 19
spoken lines **not** triggering and the same chapter with 20 triggering;
`triggeredBy` and `worstChapterId` correct in both directions.

**Wave 2 — the `missing` state (D11).** Nine fixtures that must resolve to
three different states, because the whole point of D11 is that revision 2
collapsed them into one:

| # | Fixture | `castCount` | `spokenTotal` | `analysis-state.json` | Expected |
|---|---|---|---|---|---|
| 1 | Pure-narration non-fiction | 0 | 0 | absent | `ok` |
| 2 | Cast built, **narration sentences present**, no dialogue, run abandoned | > 0 | 0 | absent **or 0 bytes** | `missing` |
| 3 | Cast built, nothing attributed, run **paused** | > 0 | 0 | `state: 'paused'` | `ok` — the pill owns it |
| 4 | **Book never analysed, no cache** | — | — | — | `ok`, reported `not analysed` |
| 5 | **Healthy `ja` book, dialogue in `「」`** (R-4C1) | > 0 | **> 0** | absent (run completed) | `ok` |
| 6 | **Healthy `de` book, dialogue in bare `»…«`** (R-5C2) | > 0 | **> 0** | absent | `ok` |
| 7 | **`en`-declared book whose text is not English** (R-6C2) | > 0 | 0 | absent | `unmeasurable` |
| 8 | **Sentences present but unidentifiable** — pure punctuation/numerals, `letters === 0` | > 0 | 0 | absent | `unmeasurable` |
| 9 | **Cast built, cache holds ZERO sentences** — the real Night Watch shape | > 0 | 0 | absent **or 0 bytes** | `missing` — corroboration skipped |

Each row disproves a different way of writing the rule too loosely, and a test
that omits any of them lets that looseness ship:

- Omit row 1 → `spokenTotal === 0` alone passes, badging every non-fiction book.
- Omit row 3 → dropping the `readAnalysisState` clause passes, badging every
  paused analysis.
- Row 2's **0-byte** variant is the real Night Watch file; a fixture using only
  an absent file leaves the unparseable path unproven.
- **Row 4 changed expectation in revision 6.** Revision 5 fixed the
  never-analysed rule in prose and left this row reading `unmeasurable`
  (R-6M3) — the fixture would have *pinned* the defect the prose removed,
  turning the test suite into the thing defending it.
- Omit row 5 → a `spokenTotal` built on `isSpokenLine` passes, badging every
  CJK book and blocking its generation.
- Omit row 6 → the same defect in every language whose dialogue marks
  `isSpokenLine` misses; see below for why this row, not row 5, is the one that
  can prove it.
- Omit row 7 → the reachable form of that defect ships: an Italian or Polish
  book imported under one of the seven supported languages is badged as damaged
  and blocked from generating.
- Omit row 8 → `fallback` is implemented on one surrender branch only, and a
  book with no letters at all is answered `en` with full confidence.
- **Omit row 9 → the corroboration step disarms `missing` entirely.** An
  empty-cache book has no text to detect from, so detection surrenders and the
  guard downgrades the verdict — exempting the exact book D11 was raised on.
  Rows 2 and 9 look alike and are not: row 2 fixes `spokenTotal === 0` with
  narration sentences present, row 9 fixes it with **no sentences at all**, and
  only row 9 exercises the carve-out. A suite carrying row 2 alone passes with
  the carve-out deleted.

**Mutation controls. Revision 4's version of this table was itself a placebo**
(R-5C2), and the way it failed is worth keeping visible: it specified row 5's
control as "revert the denominator to `isSpokenLine`" — but part 2 of the same
revision teaches `isSpokenLine` to read `「…」`, so after both changes land the
reverted denominator still returns `spokenTotal > 0` and **row 5 does not move.**
One change in the revision disarmed the control of another.

**Revision 8 rewrites the first two rows of this table, and the reason is F9.**
Both were controls over the D12-vs-`isSpokenLine` distinction, and #2245 merged
the two sides: reverting the denominator to `isSpokenLine` is now a **no-op**,
and there is no "part 2" to revert. Left as written they would be the third
generation of placebo in the table added to stop placebos.

The replacement control is the one D14 actually turns on — **build the
denominator from the model's sentence list instead of from `ch.body`** — and it
is stronger than either it replaces, because it moves every row that has source
prose rather than only the two language rows.

| Mutation | Row 5 (`ja`) | Row 6 (`de`) | Row 7 (wrong lang) | Row 8 (no letters) | Row 9 (empty cache) |
|---|---|---|---|---|---|
| **Denominator built from the sentence list, not `ch.body`** (D14 reverted) | **flips to `missing`** if its sentences are dash-stripped; `spokenTotal` moves on **every** row with prose | flips on the same input | unchanged | unchanged | **unchanged** — no sentences either way, which is what makes row 9 still worth its own control |
| **The join uses a text predicate instead of `alignSentences`** (D16 reverted) | criterion 1's arms diverge; `unattributedSpeech` reads 0 where it should read the stripped count | same | unchanged | unchanged | unchanged |
| **`unattributedSpeech` folded back into `attributableSpoken`** (D17 reverted) | criterion 4's fixture reads `attributableSpoken: 2` instead of `1` and its share halves | same | unchanged | unchanged | unchanged |
| **Absent `priorCharacterId` defaulted to model-assigned** (D18's trap) | criterion 3's `unknownOriginNarrator` assertion goes red | same | unchanged | unchanged | unchanged |
| Corroboration arm (step 4b) deleted entirely | unchanged | unchanged | **flips to `missing`** | **flips to `missing`** | unchanged |
| **Only the *disagreement* half of 4b deleted**, `fallback` half kept | unchanged | unchanged | **flips to `missing`** | unchanged | unchanged |
| `fallback` set on `:98` only, not `:81` | unchanged | unchanged | unchanged | **flips to `missing`** | unchanged |
| **Empty-cache carve-out (step 4a) deleted** | unchanged | unchanged | unchanged | unchanged | **flips to `unmeasurable`** |

**The `fallback` row is now a mutation of shipped code, not of this spec's
code** (#2246). It stays in the table because this spec's `unmeasurable`
producer *consumes* it: an implementation of corroboration that reads
`supported` instead of `fallback` passes every other row, and that is the R-5C3
defect one level downstream. Mutating it means mutating `detect-language.ts` in
the test, which is what a stub is for.

**Two rows in this table were placebos in revision 6's first draft, and the way
they failed is the same way everything else in this document has failed**
(R-7C1, R-7M1):

- It listed *"`unmeasurable`-first precedence deleted"* and *"corroboration step
  deleted"* as separate mutations with identical claimed effects. They are one
  mechanism — corroboration **is** step 4b — so the first mutation has nothing to
  delete and rows 7 and 8 do not move. The document said so itself, 270 lines
  earlier, and then billed them as two.
- It had **no mutation isolating the disagreement half of 4b**. An implementation
  that keeps only `if (fallback) → unmeasurable` and never compares the detected
  language to the declared one passes every fixture row and every mutation —
  while omitting the entire content of the fix. That is row 4 of this table, and
  it only bites if row 7's fixture is built to *contradict* rather than to
  surrender (below).

Row 9's mutation is the one easiest to leave out, because deleting the carve-out
breaks **no other row** — every other fixture has text. That is precisely why it
needs its own row: a control nothing else can move is the only thing standing
between D11 and a guard that exempts it.

**Three fixture texts are constrained, because in each case the verdict turns on
the text and not on the language** (R-7M1, R-7m1):

| Row | Constraint | Why, measured |
|---|---|---|
| 2 | **narration sentences present**, none of them dialogue under the book's conventions | Otherwise it is row 9 wearing row 2's label, and the suite passes with step 4a deleted |
| 5 | `「」`-quoted dialogue, attributed to real cast members, and **kana-dominant** | `detectManuscriptLanguage` returns `kana > han ? 'ja' : 'zh'`; a kanji-heavy fixture detects `zh`, contradicts the declared `ja`, and the two-mutation control lands on `unmeasurable` instead of `missing` |
| 7 | **well over `franc`'s `minLength: 30`**, and verified to detect as something *other* than the declared language | A short sample surrenders instead of contradicting, so row 7 passes for row 8's reason and the disagreement check is never exercised |

**Row 6's German constraint is spent, and revision 8 says so rather than
carrying it** (F9). R-6C5 constrained row 6's text to exactly one `»…«` per
sentence with no mid-line attribution, because `isSpokenLine`'s embedded rule
`/«[^»]+»/` matched the attribution span *between two turns* and made the
idiomatic shapes read as spoken. **#2245 replaced that rule with the language's
own `quotePairs`, so `»…«` is no longer missed in any position** and the
constraint has nothing left to protect.

Row 6 survives as a **language-coverage** fixture — German dialogue in `»…«`
must score `spokenTotal > 0` and read `ok` — and its constraint is inverted:
**write it naturally, including a mid-line `sagte` and a two-turn sentence**,
because those are the shapes the old rule got wrong and the regression this row
now guards is a re-narrowing of `de.quotePairs`. Its control is the D14 row of
the mutation table above, which moves it; it no longer has a control of its own,
and pretending otherwise is what R-5C2 was.

Row 5's fixture text must still contain **real `「」`-quoted dialogue attributed
to real cast members** — not merely CJK prose — and must still be
**kana-dominant**, for R-7m1's reason (`kana > han ? 'ja' : 'zh'`, so a
kanji-heavy fixture detects `zh` and contradicts the declared `ja`). That
constraint is about *detection*, not about `isSpokenLine`, so #2245 does not
touch it.

**Wave 2 — the `drifted` state (D13).** Four fixtures and a mutation apiece:

| # | Fixture | Orphans / spoken | Expected |
|---|---|---|---|
| 1 | **Short** book, one stray id under the count floor | 3 / 12 — **share 25%, over the share threshold** | `ok`. Pins the *count* floor: the share test alone would badge this |
| 2 | **Long** book, many stray ids under the share threshold | 40 / 4000 — **count over the count floor** | `ok`. Pins the *share* threshold: the count test alone would badge this |
| 3 | Over both floors, attribution otherwise healthy | 63 / 127 | `drifted`, gated |
| 4 | **Drifted *and* collapsed** | over both, and the attributable share also over threshold | badge `drifted`, **`alsoCollapsed: true`**, both notice sections rendered |
| 5 | Drifted, then an alias recorded via `retireCharacterId` | 63 → 0 | `ok` **with no cache write between the two reads** |
| 6 | Drifted, then every orphan **rejected** (bare, unlinkable ids) | 63 → 0 unacknowledged | `ok` — the exit exists |
| 7 | Drifted, dismissed, then a **new** orphan class appears under the same `cache.updatedAt` | — | `drifted` again — the dismissal re-arms |

**Rows 1 and 2 are a matched pair and neither works alone** (R-8M3, R-8M4).
Revision 7 had a single "one stray id, `orphanSpoken` 3" row with no
`spokenTotal` constraint — so if the fixture were built long, the share test
already returns `ok` and deleting `MIN_ORPHAN_FOR_VERDICT` moves nothing; the
mutation proved only that *some* rule fired. Worse, **no fixture in that table
exercised the share threshold at all**, so an implementation reading
`orphanSpoken >= MIN_ORPHAN_FOR_VERDICT` and ignoring `DRIFT_SHARE_THRESHOLD`
entirely passed every row and every mutation — while badging, on the live corpus,
a long book with a few dozen stray lines that the design intends to stay silent
about. Each floor now has a fixture that **only that floor** can keep quiet.

**Row 7 is the second direction of the key change** (R-8M2). Revision 7 motivated
`attributionVerdictKey` with two failures — the badge not clearing, and a
dismissal not re-arming — and tested only the first. An implementation that keys
the *stamp* on the verdict but leaves the *dismissal* on `analysedAt` passes row
5 and fails only here.

| Mutation | Effect |
|---|---|
| `drifted` step (5) deleted | rows 2 and 3 flip to `ok` / `collapsed` — the R-7C4 silence returns |
| `MIN_ORPHAN_FOR_VERDICT` deleted | row 1 flips to `drifted` — every book with one stray id alarms |
| **Dismissal/stamp keyed on `cache.updatedAt` alone** | **row 4 fails** — the badge survives a complete repair |
| **Key computed over resolver *inputs* rather than the verdict** | the reject-only fixture below fails — a verdict-neutral rejection re-arms the warning |
| `DRIFT_SHARE_THRESHOLD` ignored, verdict on the count floor alone | the long-book fixture flips to `drifted` — a novel with a few dozen stray lines badges |
| `drifted` tested *after* `collapsed` | row 3 badges `collapsed` and sends the user to re-analysis, which cannot fix it |

**Row 5 is the one that justifies the `attributionVerdictKey` change**, and it is
the only test in this document that asserts something about a *write that does
not happen*: `retireCharacterId` touches `cast-id-history.json` and nothing else,
so a suite that re-analyses between the two assertions passes with the identity
left keyed on `cache.updatedAt` and proves nothing. The fixture must record the
alias and re-read **without any cache write in between**.

**Storage.** `analysedAt` reads from `cache.updatedAt`, falling back to mtime
only when the field is absent; the dismiss endpoint resolves the verdict key
server-side, from the same measurement it returns; a cache write between dismiss and read re-arms; **and so does an
alias recorded through the banner**, since both move the verdict.

**Routes.** GET computes and rewrites the stamp; a subset re-run recomputes the
whole book; corrupt cache → `unmeasurable`, not 500; `GET /api/library` carries
the five-state value, with a case for each of the five asserted.

**Gate composition.** A book that is attribution-collapsed **and** voice-unready
sees both gates in order; "Generate anyway" does not skip the later three.

**The named regression test.** The incident's real ledger shape — 5 batches, one
per run, the last holding 1 entry — asserting the panel reads "16 quotes across
5 analysis passes". **Fails on `main`, passes after**, and unlike revision 1's
version it is a shape the writers actually produce.

**Frontend.** Notice states; the chapter-triggered heading variant; cause line
omitted on an empty ledger; badge asserted in **both** `library-grid` and
`library-table`; `unmeasurable` marker present in the library; dismissal clears
all surfaces.

**E2E (Playwright).** One spec: a collapsed book badges in the library, banners
in Cast, gates generation, and dismissal clears all three. Crosses
router/redux/layout seams, so required.

**Neutralisation proof — every assertion, not only thresholds.** Revision 1
scoped this to "every threshold assertion", and the gate found two more placebos
under that scope:

- The `excludeFromSynthesis` test passes with the filter deleted, because import
  residue is not quoted and `isSpokenLine` already excludes it. The fixture must
  therefore contain an `excludeFromSynthesis` sentence that **is** quoted.
- The cast-resolver test passes with `buildCastResolver` removed entirely unless
  the retired id is **the narrator's own**. The fixture retires
  `char-narrator` → `narrator`, not an ordinary character.

Each assertion is mutated on its own line and observed to go red, and the proof
is recorded in the PR body.

## On-box acceptance — owed

Wave 1's script output **is** an acceptance artifact: it is the first honest
measurement of the real library. Register row for Wave 1 — run
`scripts/measure-attribution.mjs` and record the distribution.

**There is no expected distribution here, and that absence is the design**
(R-6C3). Revisions 4 and 5 each printed a per-book table of shares as the
"expected shape" of Wave 1's output. Both were wrong, in different ways:

| Revision | What it measured | Why it was wrong |
|---|---|---|
| 4 | `server/handoff/cache/*.json` | The cache directory is not the library. 54 of its 76 files have no book at all, and three orphans were headline rows — including both "collapsed" CJK books, which are deleted. The acceptance was unsatisfiable. |
| 5 (draft) | the books tree, walked naïvely | `.upgrade-backups/` holds whole copies of that tree, so dedupe-by-`manuscriptId` kept backup copies and reported their cast counts. |
| 5 (shipped) | the books tree, correctly | The **numerator** dropped D9's orphan half and skipped the excluded-chapter filter §Universe mandates. Three cast counts wrong, and one book's figure wrong by ~50 points. |

The pattern is one thing three times: **the table was hand-computed by a script
that re-implemented `isSpokenLine`, `buildCastResolver` and the universe filters
instead of calling them.** Each re-implementation got a different subset wrong,
and each wrong table was then quoted as an acceptance criterion — so a criterion
this spec could not satisfy, or worse could satisfy only by reproducing the bug.

**So the acceptance is the run, not the numbers.** Register row for Wave 1: run
`scripts/measure-attribution.mjs` against the live workspace and record its
output verbatim. That output — computed by the real modules, through the real
`computeAttributionMeasurement` — **is** the distribution, and it is the input to
the Wave 2 threshold decision.

What the run must show, all of it structural and none of it a share:

1. **A row for every live book, none blank.** That is all the corpus can prove
   here, and the wider claim revision 6 made — that `not analysed` / `missing` /
   `unmeasurable` render "visibly distinct from each other and from a healthy
   row" — **was vacuous on today's library** (R-7M4): all 20 books have a cache
   and `spokenTotal > 0`, so **no live book is in any of the three states.** An
   implementation rendering all three identically passed it. The distinctness
   claim moves to the fixture suite, where it can fail; what the on-box run
   checks is that every real book produces a row.
2. **~~`blindSpoken` non-zero on exactly the two live CJK books before the
   part-2 change~~ — DELETED in revision 8 (F7).** #2245 shipped the change, so
   there is no "before". Its register row is discharged and must not appear in
   the shipping PR as owed acceptance. **Replaced by:** the two live CJK books
   produce a non-blank row with `spokenTotal > 0` and state `ok` or `collapsed`
   on their real share — the same claim R-4C1 was raised on, stated in a form
   that is checkable after the fix rather than across it.
2b. **Criterion 16's invariance holds on the real corpus, not only on fixtures.**
   Run the script twice, the second time over a copy of each book's cache with
   every leading dash stripped from every sentence, and diff the two reports:
   **every field of every row must be identical.** This is the on-box form of
   the F1 defect, it is the only check that exercises the join against real
   segmentation, and it cannot pass vacuously — a corpus with no dash-convention
   book would make it trivial, and the corpus has two Russian books, one of them
   the one F1 was measured on. **The cache copies are written to the scratch
   path, never to the workspace.**
3. **`orphanSpoken` non-zero on the books that carry unresolvable ids** — 8 of
   the 20 as of 2026-08-11 — **and the share unaffected by it** (D9). A run
   reporting orphans everywhere-zero means the resolver was bypassed.
4. **~~`overcountSpoken` non-zero on _Unlocked_~~ — DELETED in revision 8
   (F4).** The column is identically zero after #2245 and no longer exists.
   **Replaced by:** `dashOnlySpoken` non-zero on the two Russian books at a
   magnitude that matters, and reported alongside their shares, since that is
   the false positive the collapse threshold has to survive and it is the one
   §Known false positives still admits. Revision 6's "non-zero on a substantial
   minority" phrasing is not reused — R-7m4 called it near-unfalsifiable and it
   was.
4b. **`unattributedSpeech` and `demotedNarrator` are printed for every book, and
   at least one is non-zero somewhere.** Both are new columns, and both have the
   same failure mode: an implementation that never populates them reports a clean
   corpus and is indistinguishable from a clean corpus. **A run that reports 0 in
   both columns on all 20 books is a finding to investigate, not a pass** — the
   Aug-13 replay says at least one Russian book's stage-2 output is dash-stripped
   today, so `demotedNarrator` should be visibly non-zero there unless that book
   ran with the structure engine on. Record which.
5. **The two historical CJK collapses do not appear**, because their books are
   deleted and the script walks the library. Their absence is the check that the
   script did not start from the cache directory.

**No live book has a one-character cast**, so revision 4's "cast-1 book at 96.2%
must not read as damaged" check is gone with the orphan it referred to. **That
check has no live proof and the D11 fixture row is its only evidence** — one more
reason not to drop it.

Wave 2 register row — run the backfill, confirm exactly the expected books badge
and no first-person or dash-heavy book false-positives. Register, run sheet, and
live view all move in the shipping PR.

## Out of scope

- **Any analyzer change beyond the ONE named one** (revision 8, F10). Revisions
  5–7 permitted two — the CJK bracket pair on `isSpokenLine`, and the additive
  `DetectionResult.fallback` field. **Both shipped elsewhere** (#2245, #2246), so
  this spec permits neither. It permits exactly one, argued in place: the
  additive, optional `SentenceOutput.priorCharacterId`, written at the two sites
  that overwrite a model attribution (D18). Nothing else. In particular:
  - **`isSpokenLine` is not changed**, and this spec does not use it. It is a
    surface the metric *measures* (D18), not a tool the metric *calls* (D16).
  - **The branch that runs `applyNarratorDefault` is not changed** — only
    instrumented. Whether `applyNarratorDefault` should be demoting a
    dash-stripped speech half at all is a real question with a real answer, and
    it is not this one; recording that it happened is what makes it askable.
  - **The run-dependent trigger behind the two historical 97–99% CJK collapses
    is not diagnosed here.** It gets its own issue. **Revision 8 withdraws that
    issue's named first task**: R-7M3 said "check what
    `analyzer.structure.enabled` was set to for those two runs", on the reasoning
    that knob-off sent a CJK book's whole dialogue to the narrator. #2245 removed
    that consequence — with the knob off, `analysis.ts:2210` still resolves
    conventions, so the `else` branch reads CJK correctly. The knob is no longer
    a sufficient explanation, and the books are deleted, so the issue keeps its
    subject and loses its lead. **`blindSpoken` was already withdrawn as its
    evidence (R-7M3) and is now deleted outright (F3).**
- **~~The German gap in `isSpokenLine`~~ — CLOSED by #2245** (revision 8).
  Revisions 5–7 recorded three of four `de.quotePairs` forms as a permanent known
  limitation and filed [#2245](https://github.com/dudarenok-maker/Castwright/issues/2245)
  for it, on the reasoning that `isSpokenLine` "takes no language, so the repair
  is a choice between global patterns with an unmeasured cross-language blast
  radius and a signature change that overlaps `conventionsFor`". **#2245 took the
  signature change**, and is closed. The limitation is deleted rather than carried
  — a stale limitation is as misleading as a stale claim, and it would have the
  reader accepting a cost that no longer exists.
- **#2310 — the `&ndash;` entity being read aloud verbatim.** Adjacent (#2289
  added the entity to `es`/`fr` `dialogueOpen`, and this spec's parser consumes
  those tables), open, and a design pass in its own right: which layer decodes
  is the decision owed. Nothing here depends on the answer, because the metric
  reads the entity the same way the parser does.
- **Repairing id drift automatically.** D13 badges, gates and *points at* the
  orphan banner; it does not link anything on the user's behalf. Auto-aliasing is
  `repair-cast-id-drift.mjs`'s territory and it declines the ambiguous cases
  deliberately. (Connecting the measurement to the banner was a filed follow-up
  through revision 6; the owner's D13 decision pulls the surface into scope and
  leaves the automation out.)
- **Automatic re-analysis.** The button is the only trigger.
- **Threshold configurability.** No registry knob.
- **Live mid-run collapse warning** — the figure swings wildly over a novel's
  opening chapters.

## Open questions — owner decisions owed before Wave 1 is dispatched

None of these is a detail an implementer can settle, and each has more than one
defensible answer. Listed in the order they block work.

1. **Does D18's `SentenceOutput.priorCharacterId` land?** It is the only analyzer
   change revision 8 permits, and it is the only way acceptance criterion 5 is
   satisfiable — the derivation alternative is F1 rebuilt (§D18). It is additive,
   optional and absent by default, so its blast radius is `openapi.yaml` plus two
   write sites. **If it is declined, criterion 5 is declined with it** and the
   panel reports one narrator column, not three. *Recommendation: land it.*
   *Benefit (user): the difference between "re-run analysis" and "your analyzer
   demoted these" is the difference between a warning and an instruction.*
2. **Does D13's banner scope land?** R-8C1's question, asked on 2026-08-11 and
   still open: the `drifted` notice points at a Cast orphan banner that has zero
   rows on every book D13 fires on, so D13 requires that banner to gain a
   cache-sourced tier. **The spec's own position is that D13 is dropped rather
   than shipped without it.** §D13 re-gated adds that the answer now also governs
   `alsoCollapsed`, the fifth library state and `attributionVerdictKey`.
   *Benefit (user): a book one Generate away from routing 63 lines to the wrong
   voice says so, and points at the control that fixes it.*
3. **Does Wave 2's surface still look right at this size?** It has grown every
   revision — five states, two notice variants, a badge in two library files, a
   gate at two chokepoints, a dismissal key, a backfill script and a banner tier.
   Wave 1 is now larger too. This is worth one look before Wave 2 is planned,
   because the cheapest moment to cut it is before Wave 1's plan assumes it.
   *Benefit (technical): a smaller Wave 2 is a Wave 2 that ships.*
4. **Is `parseChapterStructure`'s speech/tag split accepted as the D15 rule?**
   The alternative on the table is the case-based heuristic the reconnaissance
   instrument used (a Russian tag half continues the sentence, so it opens
   lowercase). The parser is the better answer — it is the engine's own rule, it
   is tested, and it generalises past Russian — but it is also **stricter**: it
   downgrades a whole dialogue text to one unanchored speech span when the tag
   clause carries no `speechVerbStems`/`beatVerbStems` verb, which will move
   `tagTotal` on books the heuristic would have split. Nobody has measured how
   often. *Recommendation: take the parser and let Wave 1 measure the difference.*
   *Benefit (technical): one definition of a tag clause in the product, not two.*

## Wave 2 acceptance criteria

1. A book crossing the threshold book-wide **or** in any chapter with ≥ 20 spoken
   lines badges in the library grid **and** table, and shows a notice in Cast and
   at the confirm step, with the heading matching `triggeredBy`.
2. Starting generation on such a book requires an acknowledgement, and that
   acknowledgement does not bypass the voice-readiness, clone, or tier gates.
3. Dismissing clears all surfaces; any subsequent change to the analysis cache
   re-arms the warning.
4. A re-analysis that drops the figure below the threshold clears the warning
   with no user action, including the library badge, in the same session.
5. The analysing-view panel reports the ledger's cumulative drops across all
   batches, labelled as analysis passes.
6. **A book with a corrupt cache neither 500s nor reads as healthy** — in the
   library as well as in the Cast view. A book with **no** cache at all is a
   different case and reads `ok`: it has never been analysed, so no claim is made
   about it (R-6M3 — revision 5 stated the rule correctly in prose and left this
   criterion, the states table and a fixture row all asserting the opposite).
7. The backfill stamps every existing book; the books Wave 1 identified as
   damaged badge, and books Wave 1 measured as healthy do not.
8. A book with a cast and no attributed sentences badges as `missing` and gates
   generation. **The named case is spent:** _Ночной дозор_ was re-analysed on
   2026-08-06 and is no longer an example of this state — it is a `collapsed`
   candidate. The state stays reachable on the normal path (cancelling an
   analysis is ordinary use), but it no longer has a live instance, so row 2 of
   the D11 fixture table is the only proof available and must not be dropped for
   lack of a real book. (Revision 5 quoted a cast count and a share here; both
   were wrong, and quoting them made this criterion load-bearing on a number
   nobody had re-derived — R-6C3.)
9. **A Chinese or Japanese book with attributed dialogue is neither badged nor
   gated** (R-4C1). Asserted against a `「」` fixture. **Its control changed in
   revision 8** (F9): "revert the denominator to `isSpokenLine`" is now a no-op,
   so the control is the D14 row of the mutation table — build the denominator
   from the sentence list instead of from `ch.body`.
10. **~~`blindSpoken` matches its recorded per-language baseline~~ — DELETED in
    revision 8 (F3).** The column does not exist; #2245 merged the two
    definitions it measured the gap between, so it is identically zero in every
    language forever. A criterion over a constant cannot fail. **Replaced by
    criterion 10′, which is the same intent one level deeper:** the measurement
    is **invariant under a punctuation-only rewrite of the model's output**
    (Wave 1 criterion 16). Strip every leading dash, add one to every line, or
    replace `—` with `-`, and every field must be byte-identical. Anything that
    varies under that transform is reading model text, which is F1. This is what
    `blindSpoken` was *for* — a standing signal that the metric's view of
    dialogue has drifted from the book's — stated over the axis that can still
    drift.
11. **An unresolvable `characterId` never moves the collapse share** (D9) —
    **and a book whose only anomaly is id drift badges as `drifted`, gates
    generation, and is sent to the orphan banner rather than to re-analysis**
    (D13). Revision 6 asserted the opposite here — that such a book shows
    nothing — which made the acceptance criterion endorse the silence R-7C4 was
    raised on.
12. **Linking an orphan through the Cast banner clears the `drifted` badge
    without a re-analysis**, in the same session, including in the library. This
    is the criterion that fails if the dismissal/stamp identity is left keyed on
    `cache.updatedAt` alone, since recording an alias does not move it.
13. **A `drifted` book's notice offers no "Re-run analysis" control**, and its
    copy states the consequence in the future tense. Asserted on the rendered
    component, because a well-meaning edit re-adding the button is exactly the
    regression D13 exists to prevent.

## Review findings

Revision 1 went through the Premium-tier adversarial gate. Findings, all
re-verified against the tree before folding:

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| R-C1 | Critical | A run writes **one** batch; the `runId` fix was a placebo and its regression test unproducible | D6 rewritten — sum the whole ledger, `runId` deleted |
| R-C2 | Critical | Numerator matched only `'narrator'`, missing `char-narrator` and the orphan class | D9 added |
| R-C3 | Critical | 40% was calibrated against a sweep method not in the tree; the dash rule inflates the share | D8 added — Wave 1 measures first |
| R-M1 | Major | `library-status-ui.tsx` exports a map, not a component; the "shared module" safeguard did not exist | New shared badge component, asserted in both files |
| R-M2 | Major | The two-file split converted a lost write into an orphaned key | `analysedAt` derived from `cache.updatedAt` — no minted value to race over |
| R-M3 | Major | Four `requestStartGeneration` dispatch sites; a fourth gate could skip three existing ones | Gate placed first; re-enters the thunk; composition test |
| R-M4 | Major | Badge (stamp) and banner (live) disagree with no invalidation path | Detail fetch patches `library-slice` |
| R-M5 | Major | `unmeasurable` rendered nothing in the library — #1984's silence, reproduced | Three-state value + a visible neutral marker |
| R-M6 | Major | A crashed mid-Phase-1 run left a stale `analysedAt`, so a dismissal suppressed real damage | Fixed by `cache.updatedAt` |
| R-M7 | Major | Client-supplied `analysedAt` could go stale, making dismiss silently no-op | Server resolves it; endpoint takes no body |
| R-M8 | Major | Book-level-only trigger left partial damage silent | D2 revised — per-chapter trigger added |
| R-Mi1 | Minor | Cast-view re-run is destructive on a generated book; confirm step already has the button | D10 added; button dropped from the confirm step |
| R-Mi2 | Minor | Two specified tests could not fail | Fixtures respecified; neutralisation proof widened to every assertion |
| R-Mi3 | Minor | A subset re-run re-arms the whole book's dismissal | Accepted and documented — correct under a per-chapter trigger |
| R-Mi4 | Minor | mtime is not a stable identity across restore/move | `cache.updatedAt` used; mtime only as a legacy fallback |

**Round 2 — repo owner, 2026-08-06.** Verified against the live workspace, not
the tree:

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| R-O1 | Critical | A book with a cast and **zero attributed sentences** scored `share: null` → `ok`. _Ночной дозор_ — 47 cast members, nothing attributed — would have rendered as perfectly healthy: #1984's failure shape inside the fix for #1984 | D11 added — `missing` is its own alarm state, badged and gating |
| R-O2 | Major | The threshold could not be calibrated against the one book that most stresses the dash rule, because that book has nothing to measure | Wave 1 prerequisite added: re-analyse _Ночной дозор_ before setting the threshold |

**Round 3 — 2026-08-09, found by measuring the live corpus** rather than by
reading the tree. R-O2's prerequisite had been discharged (Night Watch was
re-analysed 2026-08-06), which made the measurement possible; the measurement
then invalidated part of the design it was meant to calibrate:

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| R-4C1 | Critical | `isSpokenLine` has no CJK bracket support, so all 7 zh/ja books score `spokenTotal: 0`. With a real cast and a completed run's deleted snapshot, a **healthy** CJK book satisfies all three `missing` clauses — the feature would badge it damaged and **block its generation**. The mirror of R-O1 | D12: language-aware denominator; `unmeasurable`-first precedence; two D11 fixture rows with mutation controls |
| R-4M1 | Major | The denominator inherited the analyzer's blindness by design ("measure what the analyzer acts on"), so any future blind spot of this class is invisible in the headline number too | Denominator moved to the language conventions; `blindSpoken` added as a permanent regression signal |
| R-4M2 | Major | `applyNarratorDefault` demotes all CJK dialogue whenever `conventionsFor(language)` is null — two live books at **99.2%** and **97.8%**. A measurement-only fix would leave the cause in place | `isSpokenLine` gains `「」『』`; blast radius argued CJK-only; the null-conventions path itself left to its own issue |
| R-4M3 | Major | A conventions denominator needs a language label, and **7 live books have none** (the finding said "of 22"; the corpus is 20 — R-6N6) — including the largest in it. Naïvely applied it would render them all `unmeasurable` | `detectManuscriptLanguage` fallback specified as step 2, with `languageSource` recorded |
| R-4Mi1 | Minor | Acceptance criterion 8 named Night Watch's 2026-08-06 state as the proof case for `missing`; that state no longer exists | Criterion rewritten — the fixture row is now the only proof, and is marked not-droppable |
| R-4Mi2 | Minor | "This spec changes no analyzer behaviour" and §Out of scope's "any change to the analyzer, including `isSpokenLine`" both became false | Both amended, with the single permitted change named explicitly |
| R-4Mi3 | Minor | **Found in revision 4's own self-review.** The gap was first specified as a single signed field, `blindSpoken = spokenTotal - pipelineSpoken`. The two definitions diverge in both directions, so an English dash book reads **−58**, making the acceptance criterion "`blindSpoken` is 0 across the corpus" false on healthy books | Split into `blindSpoken` and `overcountSpoken`, with only the former alarmed on |

**Round 4 — Premium adversarial gate on revision 4, 2026-08-10. Verdict: not
safe to approve.** Twelve findings; every one re-verified against the tree or the
workspace before folding, and two of the reviewer's own claims corrected in the
process (noted below).

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| R-5C1 | Critical | **Revision 4's empirical basis was the cache directory, not the library.** (The reviewer said "9 of 31 caches are orphans" and revision 5 repeated it; re-derived independently in revision 6, it is **54 of 76** — the finding whose whole content is *get the empirical basis right* stated a wrong empirical basis.) Three orphans were headline rows of the on-box table — including both "collapsed" CJK books at 99.2%/97.8%, which are **deleted**. The live CJK books measure 2.9% and 1.6%. The acceptance "the two CJK books must appear at all" was unsatisfiable | §On-box acceptance rebuilt from a workspace-joined measurement of all 20 live books; R-4M2 restated as historical evidence |
| R-5C2 | Critical | **The new fixture's mutation control was a placebo.** "Revert the denominator to `isSpokenLine`" cannot move row 5, because part 2 of the same revision teaches `isSpokenLine` to read `「…」`. One change disarmed the other's control | Two-mutation control stated honestly for row 5; **German `»…«` row added** as the fixture a *single* mutation can move |
| R-5C3 | Critical | **The class stayed open behind an unreachable guard.** An unsupported language (it, pt, pl) resolves to `'en'` via `detect-language.ts:60`, is measured against `en` conventions, and lands in `missing` — R-4C1 in another alphabet. `supported` cannot catch it: English *is* supported, so the flag is `true` on the surrender branch | `DetectionResult.fallback` added (additive); `languageSource: 'unknown'`; `fallback` ⇒ `unmeasurable` |
| R-5M1 | Major | The claim that `unmeasurable`-first precedence is "precisely how a healthy CJK book stopped being badged" is **false** — `zh`/`ja` have tables, so CJK never reaches it. D12 alone closes R-4C1. The guarded state was itself unreachable (import rejects non-registry languages), so its fixture tested nothing | Claim corrected; precedence re-justified as load-bearing **only because** R-5C3 makes `unknown` reachable |
| R-5M2 | Major | `blindSpoken === 0` was made a universal invariant. German `»…«` is dialogue under `de.quotePairs` and invisible to `isSpokenLine` even after part 2, so the next `»…«` import alarms permanently | Criterion changed to a per-language baseline with the `»…«` gap recorded as a known limitation. **Reviewer said four German forms; two of the four are caught (`„` is already an opener) — verified, only `»…«` is missed** |
| R-5M3 | Major | The detection fallback would silently never run: the in-tree accessor `bookStateLanguage` (`scan.ts:314`) returns `DEFAULT_LANGUAGE` for an absent language, so an implementer following the documented convention gets `'en'` for all 7 no-language books | Step 1 specified to read `state.language` **raw**, with the reason stated |
| R-5M4 | Major | Three contradictory behaviours for a never-analysed book: `unmeasurable` (the rule, evaluated first), `ok` (the prose), "skipped" (the script). The rule won, so every freshly imported book would show the neutral marker | `unmeasurable` scoped to "analysed **and** still unmeasurable"; never-analysed is `ok` and reported as `not analysed` |
| R-5M5 | Major | `readAnalysisState` is `async`; the literal rule `readAnalysisState() === null` is never true and makes `missing` silently unreachable. Also I/O, so the state derivation cannot live in the pure module | Rule awaited; module ownership stated — pure metric vs. impure state derivation |
| R-5Mi1 | Minor | The blast-radius control could not fail — a Latin/Cyrillic fixture has no `「『` by construction | Replaced with a before/after replay over the real corpus asserting exactly two books change |
| R-5Mi2 | Minor | "±0.2 points on every large book" contradicted by _Unlocked_ (13.6% → 14.6%) and by the spec's own next sentence | Restated: no book crosses an obvious boundary; the columns are not interchangeable at the margin |
| R-5Mi3 | Minor | "58-member cast" for _Ночной дозор_ came from `stage1.characters` in the cache, not `cast.json` (**27** non-narrator). "cast 20" for the other book is **7** | Corrected; `castCount` specified to read `cast.json`, the identity of record |
| R-5Mi4 | Minor | Three `persistDroppedQuotesBatch` line numbers stale (`:3184/:3824/:5740` → `:3568/:4209/:6208`); `cast-resolve.ts:105` → `:147`; `synthesise-chapter.ts:1553` is the abort throw | Corrected. **Reviewer also claimed `phase-card.tsx:252` → `:262`; verified and the spec was right.** The narrator substitution is `:2315-2326`, not the reviewer's `:1531` either |

**Round 5 — scoped re-review of revision 5, 2026-08-10. Verdict: not safe to
approve.** Every round-4 fix was re-tested against the tree and the workspace:
**3 of 12 failed** (R-5C1, R-5C3, R-5M2), **2 more failed on their numbers**
(R-5Mi2, R-5Mi3), 3 were partial, 4 held, and the folding introduced **6 new
defects.** Every finding below was re-verified independently before folding, and
one of the reviewer's own figures was corrected in the process.

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| R-6C1 | Critical | **The measurement backing revision 5 was not the metric revision 5 defines.** Its shares reproduce only with the orphan half of D9 dropped and the excluded-chapter filter off — so the document carried two incompatible definitions of its own metric, and the acceptance used the one §Universe forbids. Under the spec's own rules one book moved by ~50 points | **D9 narrowed** (owner's decision): the share counts narrator ids only; `orphanSpoken`/`orphanIds` report alongside it and never inside it. `narratorSpoken` **deleted** as a field — an ambiguous name is what let a third formula in. Rationale written out in §Numerator |
| R-6C2 | Critical | **`unmeasurable` still had no live producer.** `fallback` fires only when detection runs, and detection runs only when `state.language` is absent — but `import.ts:258-266` normalises and hard-rejects, so every book has one. The reachable hole is **declared-but-wrong**: an Italian book must be imported as one of the seven, is measured against the wrong conventions, and lands in `missing`. R-4C1 in another alphabet, untouched | Step 3 rebuilt as **corroboration on the `missing` path**: when a `missing` verdict is imminent, detection is run over the book's own text and a contradiction (or a surrender) yields `unmeasurable`. Precedence re-justified on that producer; two fixture rows and a mutation added |
| R-6C3 | Critical | **The pre-computed distribution was wrong for the third time in three revisions**, and its figures had become load-bearing — quoted in Wave 2 criterion 8 and in §The metric. Three cast counts wrong (34/32/14 stated as 27/26/12); _Unlocked_'s "13.6% → 14.6%" was one denominator with and without a filter, and the real move is a **drop** | **The distribution is deleted.** §On-box acceptance now specifies the *run* and five structural checks, none of them a share. The one surviving figure — `blindSpoken` on the two CJK books — is the one two independent reviewers re-derived and agreed on |
| R-6C4 | Critical | **Revision 5 overruled the round-4 reviewer on the German gap and the overrule was wrong.** Measured: leading position catches 3 of 4 forms, embedded catches **1** of 4. `de.ts:7-9` records the two forms that fail when embedded as the ones real manuscripts routinely use | Corrected with the measured table in §The gap column; §Out of scope and Wave 2 criterion 10 widened from one form to three |
| R-6C5 | Critical | **Row 6's German fixture was unconstrained, so the control it exists to provide is a placebo again.** `/«[^»]+»/` matches the attribution span *between two turns*, so `»Lass das«, sagte er, »sofort.«` and `»Ja.« »Nein.«` are already spoken — the idiomatic shapes. Only a bare single turn is missed | Fixture text constrained to exactly one `»…«` per sentence with no mid-line attribution, plus a **precondition assertion** that `isSpokenLine` is false on each fixture line, so the fixture fails loudly if it is later made to read more naturally |
| R-6M1 | Major | The pure/impure split was drawn for `readAnalysisState` and not for the language chain: step 1 reads `state.json`, yet Wave 1 criterion 1 put `detectManuscriptLanguage` inside the module it requires to be pure | Same split applied: one impure `resolveBookLanguage(bookDir, sentences)` returns `{ language, languageSource }`; the pure metric receives it |
| R-6M2 | Major | The corpus replay (R-5Mi1's fix) was specified as a Wave 1 paired regression, but the corpus is gitignored and machine-local — on CI or a fresh clone it asserts over an empty set and **passes vacuously** | Moved to on-box acceptance with a register row; CI keeps the narrower fixture-level claim, mutating each new alternative in turn |
| R-6M3 | Major | R-5M4's fix landed in prose only. Three normative places still said the old thing — the states-table rule cell, the D11 fixture row "No cache at all → `unmeasurable`", and Wave 2 criterion 6. The fixture row would have **pinned** the defect the prose removed | All three corrected; the states-table cell is now the normative statement and the prose explains it |
| R-6N1 | Minor | `fallback` was defined as true "ONLY on the `: result('en')` branch" — there are **two** surrender branches; `detect-language.ts:44` returns `en` when the sample has no letters at all | Both branches set `fallback`; fixture row 8 and a dedicated mutation added |
| R-6N2 | Minor | The `AttributionMeasurement` block declared `languageSource: … \| null` 27 lines below prose calling that arm "dead type" — and the block is what an implementer copies | Interface corrected to `'declared' \| 'detected' \| 'unknown'`, with the `language === null` pairing asserted |
| R-6N3 | Minor | "7.1k–13.6k sentences each" for the no-language books is wrong at the low end by 26× — one is a short story | Range deleted; the claim it supported does not need it |
| R-6N4 | Minor | R-5Mi4 corrected the three `persistDroppedQuotesBatch` line numbers and then named `:5740` for `analysis-chapters` in the next sentence | Corrected to `:6208` |
| R-6N5 | Minor | §The panel fix still cited the pre-correction `:3184`/`:3824` | Corrected to `:3568`/`:4209`, with what makes them mutually exclusive named |
| R-6N6 | Minor | "7 of 22 live books" and "7 of 20 live books" both present | Both now 20 |

**Round 6 — Premium adversarial gate on revision 6, 2026-08-11. Verdict: not
safe to approve.** The reviewer independently re-derived and **confirmed** the
empirical work — the German 4×2 table, both surrender branches, the `franc`
restriction, "no import path leaves `state.language` absent", 8-of-20 orphaned,
7-of-20 undeclared, `blindSpoken` 104/122 and zero on the other eighteen, zero
CJK brackets in any non-CJK cache, and ~40 of ~44 line citations. **The defects
it found were all in the logic connecting those numbers**, and all four
Criticals landed in the three headline changes.

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| R-7C1 | Critical | **The precedence rule and the corroboration step were circularly ordered, and the mutation table billed one mechanism as two.** "`unmeasurable` is tested first" vs. "corroboration runs when the measurement would otherwise return `missing`" cannot both hold; and because `languageCorroborated` is a **conjunct of `missing`**, deleting the "precedence" moves neither row 7 nor row 8. A placebo, inside the table added to stop placebos | §Failure modes rewritten as **one explicit six-step sequence**; corroboration is step 4b, inside the `missing` test. The phantom precedence mutation deleted from the table |
| R-7C2 | Critical | **The corroboration step exempted D11's own motivating book.** An abandoned run leaves `chapters: {}`, so corroboration samples the empty string, hits the `letters === 0` surrender, and downgrades `missing` to `unmeasurable` — no badge, no gate, on the exact shape R-O1 was raised on | **Found independently in self-review and fixed before the gate reported** (`f533ebc1`): step 4a skips corroboration when the cache holds no sentences, with fixture row 9 and its own mutation |
| R-7C3 | Critical | **Fixture rows 2 and 8 were the same input with opposite expectations** — row 2's text was unconstrained, and the real row-2 book has zero letters. Giving row 2 prose makes the suite pass *and* hides R-7C2 | Row 2 constrained to "narration sentences present, none of them dialogue"; row 9 added for the zero-sentence case. Rows 5 and 7 constrained too (below) |
| R-7C4 | Critical | **D9's narrowing reports 63 unresolvable dialogue lines on _The Coalfall Commission_ as 0% collapsed**, and Wave 2 criterion 11 asserts that outcome is correct. Three more books move ≥16 points under the summed reading | **Partly rejected on new evidence, partly open — see the note below this table.** The rendered segments carry the *resolved* ids, so no current audio is affected; the hazard is prospective, at the next render |
| R-7M1 | Major | **The disagreement half of corroboration had no test and no mutation.** `franc`'s `minLength: 30` means a short non-English fixture *surrenders* rather than contradicting, so row 7 passed for row 8's reason. An implementation keeping only `if (fallback)` passed every row and every mutation — omitting the entire content of the fix | Mutation isolating the disagreement half added; row 7's fixture constrained to well over `minLength` and verified to detect as something other than the declared language |
| R-7M2 | Major | **D11's notice copy described a state its rule cannot detect** — "not one line assigned" is a 100%-orphaned book, which has `spokenTotal > 0` and reads `ok`. The rule is "no dialogue *exists*" | Copy rewritten to "no dialogue was found to assign", with the distinction stated |
| R-7M3 | Major | **`applyNarratorDefault`'s guard is a knob AND the table**, not `conventionsFor() === null` — `analyzer.structure.enabled` (`registry.ts:1267`, default true, user-settable). Three revisions built "nobody knows why that branch was reached" on the narrower reading. And `blindSpoken`, deputised as the trigger's evidence, is **invariant under the knob**: turning the engine off changes attribution and no sentence text | Guard restated with the knob; the knob named as the leading hypothesis for the follow-up issue; `blindSpoken` explicitly **withdrawn** as that issue's evidence in §Out of scope |
| R-7M4 | Major | **On-box check 1 was vacuous** — it required `not analysed` / `missing` / `unmeasurable` to render distinctly, and **no live book is in any of those states**. The check passed over an empty set. The very shape R-6M2 was raised on | Narrowed to what the corpus can prove; the distinctness claim moved to the fixture suite |
| R-7m1 | Minor | Row 5's `ja` fixture was unconstrained on kana ratio; `kana > han ? 'ja' : 'zh'` means a kanji-heavy fixture detects `zh`, contradicts the declared `ja`, and the two-mutation control lands on `unmeasurable` | Fixture constrained to kana-dominant |
| R-7m2 | Minor | §Storage's "24.9 MB / largest 3.4 MB" was stale and contradicted this document's own "3.7 MB" for the same file | Re-measured: 76 files, 28.0 MiB, largest 3.5 MiB; the unit mismatch named |
| R-7m3 | Minor | `language: null` on the contradiction path is incoherent — `spokenTotal` was necessarily computed under the declared conventions. `languageCorroborated` appeared in the rule and in no interface | Four-row table added: `language` carries what the row was measured against; only the weaker implication is asserted. `languageCorroborated` confirmed as a branch, not a field |
| R-7m4 | Minor | "`overcountSpoken` non-zero on a substantial minority" is near-unfalsifiable — nine of the ten are 1–6 sentences | Narrowed to the one book carrying a real dash population |
| R-7m5 | Minor | Path drift: `clone-readiness-gate.tsx` is under `src/modals/`; `layout.tsx` under `src/components/`; the library `:167`/`:266` citations are the `STATUS_UI` lookups, not the pill JSX | All corrected |
| R-7m6 | Minor | "28–125 bracket lines" across the seven CJK caches; the range is 28–122 | Corrected |

**On R-7C4, the reviewer's most serious finding, a direct check refutes the
consequence and leaves the concern standing.** The report reasons from two true
facts — the book has rendered audio, and `synthesise-chapter.ts:2315-2326`
substitutes the narrator for an unresolvable id — to the conclusion that 49.6% of
_The Coalfall Commission_ is audibly narrator today. **Its segments files say
otherwise:** `03-chapter-one-the-knock.segments.json` and
`04-chapter-two-the-pour.segments.json` carry `master-oduvan`,
`coalfall-dragon`, `brann-weir` and `berrin-weir` — the **resolved** ids — and
not one segment under the orphaned cache ids. The rendered audio is correct, and
`repair-cast-id-drift.mjs`'s "0 rendered segments" for those ids is confirmed.
The owner's 2026-08-10 premise — that these orphans are inaudible — **holds for
the audio that exists.**

What survives is narrower and still real: **the cache is what the next render
reads**, so a Generate on that book today would route those 63 lines to the
narrator, while the collapse figure reports 0%. That is a decision for the repo
owner, not a defect to fold silently, and it is recorded as an open question
below rather than resolved here.

**Round 7 — scoped adversarial gate on D13 alone, 2026-08-11. Verdict: not safe
to approve as written.** D13 was new design added after the round-6 gate, so it
got its own pass. The reviewer confirmed the notice copy's figures exactly, the
"rendered audio is unaffected" claim on every book D13 can fire on, the omission
of `displaced` from the hash, and — the one thing that could have been fatal and
unfixable — that a **workable threshold pair exists**, separating the drifted
books from the other sixteen with an order-of-magnitude gap, and surviving Wave
1's own `isSpokenLine` change. Three Criticals, all structural.

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| R-8C1 | Critical | **D13's notice pointed at a control with zero rows on every book D13 fires on.** The orphan banner is fed by `collectOrphanedCharacterFallbacks` (`segments-io.ts:338`), which enumerates **rendered segment files**; `orphanSpoken` is measured from the **analysis cache**. On this corpus the two populations are near-disjoint — and *because* the firing books' segments carry only resolved ids, their banner is empty. The books whose banner does have rows are ones D13 stays silent about | The banner gains a **cache-sourced tier**, resolved through the same `buildCastResolver` instance, with each row recording its source. The Link route needs no change — only its supply. Scoped in, because a notice whose remedy leads nowhere is worse than silence; **if that scope is declined, D13 is dropped rather than shipped without it** |
| R-8C2 | Critical | **The generation gate does not cover the hazard it was added for.** `startGenerationFlow` has two dispatch sites, neither reachable on a fully-rendered book — and D13's entire hazard is the *next* render. Every regenerate affordance goes through `enqueueQueueEntries`, which `ENQUEUE_TRIGGER_TYPES` does not include. **The same bypass lets a `collapsed` book be wholly re-synthesised without its acknowledgement**, which R-M3 missed by enumerating dispatchers rather than asking what else reaches the synthesiser | Gate moved to `enqueueQueueEntries`, the chokepoint every synthesis path crosses; the thunk keeps its ordering role so the composition argument stands. Server-side repair routes explicitly excluded |
| R-8C3 | Critical | **`alsoDrifted` pointed the wrong way and the sequence could not produce it.** `drifted` is step 5 and `collapsed` step 6, so `collapsed` is what gets masked; the flag could only ever have been set by `unmeasurable`. Meanwhile the fixture table required both notice sections to render — impossible, since the sequence returns at step 5 and never evaluates the collapse test | Field is **`alsoCollapsed`**; step 5 computes the collapse verdict before returning |
| R-8M1 | Major | **No exit from a gating state for an unlinkable orphan.** `unknown-male`, `voix-inconnue`, `driver`, `the-jogger` name no character, so Link is impossible — and rejecting changes nothing, because the resolver only ever *blocks* on a rejection. Badged and blocked forever. Revision 7 additionally hashed `rejected` into the dismissal key, so every "Not the same character" click re-armed a warning it could not affect | The verdict counts **unacknowledged** orphans: bare `rejected` reads as acknowledged (it already means "not any of my characters"), `rejectedPairs` does not. Rejection becomes the exit *and* becomes verdict-relevant, which removes the re-arming defect |
| R-8M2 | Major | **The dismissal key was over the resolver's inputs**, so it re-armed on verdict-neutral changes (every rejection; `saveAnalysisCache` stamping `updatedAt` on writes that change no `characterId`) and required the spec to enumerate correctly which inputs matter — which it got wrong. It also spanned **three files under three locking regimes**, so a torn read at dismiss time stored a key that could never match again: a permanently un-dismissable and, under D13, permanently gated book | Key moved to the measurement's **outputs** (`attributionVerdictKey`), computed from the same measurement the response returns. Changes exactly when the verdict can change; no second read to tear against; R-M2's no-minted-value property preserved |
| R-8M3 | Major | **No fixture exercised `DRIFT_SHARE_THRESHOLD`.** An implementation reading the count floor alone passed all four rows and all four mutations — and on the live corpus would badge a long book the design intends to stay silent about | Fixture rows 1 and 2 are now a matched pair, each kept quiet by **only one** of the two floors; two mutations added |
| R-8M4 | Major | **Acceptance criterion 12's mechanism did not exist.** `handleLinkOrphanMatch` (`cast.tsx:583`) links, dispatches `applyOrphanLink` and toasts — no refetch, no library patch. Nothing recomputed the verdict after a repair | The refetch-and-patch is scoped explicitly onto a successful link or reject |
| R-8m1 | Minor | The edge-case row "every dialogue line orphaned → `drifted`" contradicts the rule when the count is under the floor — a wholly-drifted novella resolves `ok`, the outcome that row rejects | Split into two rows; the sub-floor case is recorded as a genuine accepted gap, matching the existing novella gap |
| R-8m2 | Minor | The key change was motivated by two failure directions and tested in one | Fixture row 7 added for the re-arming direction |
| R-8m3 | Minor | A share rule hides absolute damage: a long book carries more orphaned lines than some books that badge, and stays silent | Accepted and recorded as a known limitation; the alternative badges every large book with a few stray ids |

**The reasoning failure behind R-8C1 is worth naming, because it is mine and it
is new in kind.** "The rendered segments carry the resolved ids" is the fact that
rebutted the round-6 gate's damage claim. It is *also* the fact that makes the
orphan banner empty on exactly those books. Having used the observation to win
one argument, I did not ask what else followed from it — a single fact with two
consequences, of which only the convenient one was drawn.

**Two corrections to the round-5 reviewer, verified before folding.** The
unresolvable-id count is **8 of 20 books**, not the six the report lists — it missed the `zh`
translation and one other, measured through `buildCastResolver` with each book's
real `cast-id-history.json`. And the orphan-cache arithmetic re-derived
independently is **76 caches / 20 live books / 2 trashed / 54 orphans**, which
matches the reviewer exactly and settles revision 5's "nine of the 31".
