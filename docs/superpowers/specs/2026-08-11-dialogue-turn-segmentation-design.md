# Design — intra-paragraph turn segmentation, tag-span trust bound, and a sound
# acceptance metric (#2253, #2254)

Design pass for plan [247](../../features/247-dialogue-structure-attribution.md).
No code written; this document is the spec the implementation thread is briefed from.

**Verdict: this is a quality defect, not a metrics defect.** #2253 was filed as
"target 1 is unsound" and #2254 as "the EPUB lost paragraph structure". Both are true,
but measurement during this design pass found the thing sitting between them: the engine
is **rewriting roughly 880 lines of character dialogue to the narrator, unflagged, and
counting each one as a success**. The metric is unsound *because* it counts the harm as
a win. Fixing the metric without fixing the engine would produce a better-calibrated
gate over a pipeline that still mis-voices the audiobook.

Four changes, one spec: intra-paragraph turn segmentation (A), a tag-span trust bound
(B), structure-quality reporting (C), and the metric re-spec (D).

---

## 1. Evidence

Everything below was measured by offline replay over the committed 2026-08-06 analysis
cache for *Ночной дозор* (`mns_oyK7Po6BiT.json`) plus a re-parse of the source EPUB. The
replay reruns the real `alignSentences` → `crossExamine` path in minutes with no LLM and
no GPU; escalation is not reproducible offline but never mutates any bucket
(`analysis.ts:2214-2275` assigns only `escalated` / `escalationAccepted`).

### 1.1 The harm

Joining `CrossExamineResult.reasons[]` (index-aligned to `sentences[]`) against a
`conventions.dialogueOpen` test, over sentences that **open with a dialogue dash**:

| ch | dash-opening sentences | model → narrator | engine → narrator | delta | landed in `flagged` |
|---|---|---|---|---|---|
| 1 | 777 | 37.8% | 37.8% | **0.0** | 60.2% |
| 2 | 649 | 20.2% | 20.2% | **0.0** | 75.7% |
| 3 | 246 | 15.4% | 15.4% | **0.0** | 82.1% |
| 9 | 428 | 26.2% | 26.2% | **0.0** | 68.9% |
| 4 | 243 | 48.1% | 52.3% | +4.2 | 35.8% |
| 7 | 590 | 34.9% | 52.7% | +17.8 | 46.1% |
| 8 | 546 | 36.4% | 57.1% | +20.7 | 44.1% |
| 6 | 551 | 11.8% | 55.7% | +43.9 | 42.6% |
| 5 | 702 | 11.4% | **69.7%** | **+58.3** | 27.6% |

Counting victims exactly — dash-opening, model assigned a real character, engine output
`narrator`:

- ch1 **0 / 2,777**
- ch9 **0 / 1,611**
- ch5 **409 / 1,736**

Across ch4–8 that is **~880 lines** that would be performed in the narrator voice.
**The delta is exactly 0.0 on every structurally-intact chapter and positive on every
damaged one.** That separation is the strongest invariant this design rests on, and §5
turns it into an acceptance signal.

### 1.2 The mechanism

Dominant decision reason on ch5's dash lines: `tag-span-narrator`, **459 of 702**
(`cross-examine.ts:211`), which returns
`{ characterId: NARRATOR_ID, reason: 'tag-span-narrator', bucket: 'corrected', flagged: false }`.

Why it fires — a real ch5 paragraph, 6,518 chars:

```
layout: tag[3775] | speech[10]->shef/tag-name | tag[2563] | speech[8]->semen/tag-name | tag[158]
```

Two speech spans of **10 and 8 characters**, and **6,338 characters labelled `tag`**. A
tag clause is an attribution — *«— сказал Антон»*, a handful of words. There is no upper
bound on tag-span length, so a paragraph the parser cannot segment becomes mostly one
giant "tag", and every sentence aligning into it is force-narratored.

Two properties matter for the fix:

- **Alignment does not catch it.** ch5 aligns at **94.6%**, comfortably over the 80%
  floor. The sentences *do* align — to the wrong *kind* of span. The floor added by
  #2187 is therefore not a defence here.
- **The parser does not misfire on well-formed paragraphs.** Of ch5's 409 victims,
  **0 sit in a paragraph ≤500 chars**; the median containing paragraph is **10,598**.
  ch1 and ch9, whose paragraphs are intact, have zero victims.

### 1.3 Why the parser produces the giant tag span

ch5's largest paragraphs are 13,068 / 11,023 / 10,598 / 8,654 / 6,518 chars. Inside the
13,068-char one:

```
…Они были свободны. - Оля, мне нужно дождаться Антона. - Светлана взяла меня за руку.
…прочат великое будущее. - Не стоит, - сказал я. - Света, не стоит.
```

This is ordinary Russian dialogue typography — `— speech, — tag. — continued speech` —
and **the parser already understands that grammar within a paragraph**; tag spans exist
precisely to model it. Its one limitation is that a dash opens a *turn* only at paragraph
start. A paragraph holding twelve turns therefore yields one turn and thousands of
characters of "tag".

The boundary signal is measurable. Of **134 dash characters** in that paragraph:

- **72** are preceded by sentence-ending punctuation + whitespace — turn-like;
- **42** are preceded by a letter — `точь-в-точь`, `кое-чему`, `что-то`, and the internal
  dash in `— Так я и говорю - поедем на машине?`.

Requiring punctuation-then-whitespace separates them without a new lexicon.

### 1.4 Corpus prevalence

Tag-span length across all **17** workspace EPUBs, roster-free (span *kind* segmentation
is convention-driven; names only decide attribution):

| | tag spans | max tag span | >500 | >2000 | share of tag text in oversized spans |
|---|---|---|---|---|---|
| **12 of 17 books** | 45–1,538 | **147–503** | **0** | 0 | **0.0%** |
| Exile / Neverseen / Stellarlune / Unraveled (en) | 616–2,626 | 503–723 | 1–2 | 0 | 0.6–1.7% |
| Юный дрессировщик (ru) | 58 | 704 | 4 | 0 | 20.2% |
| **KotLC *Unlocked*** (en) | 687 | **2,765** | 41 | 2 | **49.6%** |
| **Ночной дозор** (ru) | 521 | **12,389** | 100 | 60 | **92.9%** |

Two conclusions:

1. **The defect is cross-language and not unique to this book.** The second affected
   book is English, with a completely different dialogue convention.
2. **Healthy books never exceed 503; affected books start at 2,765.** No overlap. That
   gap is where §3's threshold comes from — a corpus-derived bound, which is exactly what
   #2253 asked for in place of a round number.

Separately, only **1 of 17** EPUBs is Calibre `txt_input_to_html`-converted (the
Ночной дозор book), with a max paragraph of 14,202 chars against 4,212 for the next-worst
book. So the *ingestion* shape of #2254 is rare; the *downstream* defect it triggers is
not confined to it.

### 1.5 Corrections to the record

Two claims made earlier in this investigation were wrong and are superseded here. Both
are recorded because they were published to the issues before being checked.

- **"ch5's attribution quality is unaffected — 11.4% narrator vs ch1's 37.8%."** That
  compared the *model's* column. The *engine's* column for ch5 is **69.7%**. Corrected in
  [#2253](https://github.com/dudarenok-maker/Castwright/issues/2253#issuecomment-5249260163)
  and [#2254](https://github.com/dudarenok-maker/Castwright/issues/2254#issuecomment-5249262228).
- **"#2254 costs engine *visibility*, not output quality."** It costs output quality;
  see §1.1.

A third, recorded in the run sheet's §2A as *"REFUTED, do not re-propose: paragraph
degradation causes the narrator collapse"* (`corr = −0.073`), was refuted using the same
wrong column. The relationship is present in the engine's column and is the subject of
this spec. **That refutation is withdrawn**, and the run sheet is corrected in the same
change.

---

## 2. Change A — intra-paragraph turn segmentation

**The fix belongs where the information is lost: the paragraph boundary.** Repairing
inside a tag span patches a symptom several layers downstream; segmenting turn-like units
inside a paragraph means windows, alternation and the aligner all receive a correct
picture with **no changes of their own**.

In `parseChapterStructure` (`dialogue-structure/parser.ts`): within a paragraph, a
`conventions.dialogueOpen` match preceded by **sentence-ending punctuation followed by
whitespace** opens a candidate segment, in addition to the existing paragraph-start case.
Each segment is then classified speech vs tag/beat by the **existing
`speechVerbStems` / `beatVerbStems`** — no new language data, and it generalises to the
quote-convention languages through `quotePairs` on the same rule shape.

No text is mutated. Spans continue to carry absolute offsets into the real chapter body;
only the set of boundaries changes.

**Accuracy, hand-checked against the first 18 boundaries of ch5's largest paragraph:**
17 correct. The single miss is `— Удивление в глазах Светланы…` — narration with no verb
stem, classified as speech. Its cost is a spurious *speech* span, which reaches the
unanchored path and is **flagged**, not mis-voiced. The failure direction is correct by
construction: segmentation decides *where* turns start, never *who* speaks.

Speakers that alternation assigns inside a segment recovered this way are stamped
`speaker.strength: 'weak'`, reusing the Wave 3 mechanism already in the codebase, so a
disagreeing model keeps its own id and flags (`tag-weak-keep-flag`) rather than being
force-corrected. A false boundary therefore costs a flag, never a wrong voice.

---

## 3. Change B — tag-span trust bound (backstop)

Segmentation will not repair everything, so the trust bound stays — demoted from the
mechanism to the safety net.

- `SpanEvidence` gains `oversized?: true`, set when a `tag` span exceeds
  **`TAG_SPAN_TRUST_MAX = 800` characters**.
- `tag-span-narrator` skips oversized spans. Those sentences fall through to the
  unanchored path: **the model's speaker is preserved and the line is flagged.**
- A *speech* span whose anchoring tag clause is oversized has its speaker stamped
  `strength: 'weak'` — same reuse as §2, so an oversized clause cannot silently mint a
  strong `tag-name` either.

**Threshold justification:** healthy books top out at 503 chars (§1.4); affected books
start at 2,765. 800 gives ~60% headroom over the observed healthy maximum and sits 3.4×
below the lowest affected maximum. A plain exported constant, not a registry knob —
nothing user-facing to tune, and no env var, so CLAUDE.md's knob rule does not apply.

---

## 4. Change C — catch it early, and make it visible

The two acceptance runs that preceded this design both reported healthy-looking numbers
while this was happening. The parser therefore reports what it repaired and what it could
not:

- paragraphs found to contain more than one turn (i.e. segmented by §2);
- residual oversized tag spans after segmentation (§3);
- both as per-chapter counters, aggregated to the book in `aggregateStructureReports`
  (`analysis.ts:~2334`) and persisted in `analysisProvenance.report`.

This is the signal that would have surfaced *Ночной дозор* — and *Unlocked* — on ingest
rather than after two multi-hour runs.

---

## 5. Change D — the acceptance metric

### 5.1 The bucket split

Full reason tally over every flagged sentence in the book (not only dialogue lines):

| reason | count | share of `flagged` |
|---|---|---|
| `unanchored-named` | 2,442 | 60.3% |
| `unanchored-narrator` | 1,007 | 24.9% |
| `unaligned` | 597 | 14.7% |
| `pronoun-keep-flag` | **5** | **0.1%** |

`unanchored-*` is **85.1%**, and `unanchored-*` plus `unaligned` is **99.9%**. Both mean
"I have no evidence either way" — absence of evidence, not suspicion. **The whole book
contains 5 genuine conflicts.**

That is why even the *intact* chapters flag a quarter to a third of their sentences —
ch1 24.7%, ch2 38.5% (812/2,111), ch3 36.2%, ch9 29.2%; book-wide 4,051 / 15,069 =
**26.9%**. A confidence signal that highlights a third of the chapter is not a signal,
and today it is highlighting almost nothing that a human could act on.

`EngineReport` therefore splits the bucket:

- **`flagged`** — a genuine conflict: the model contradicts strong structural evidence,
  an alternation conflict, or a §3 oversized-span fallback.
- **`unresolved`** — no verdict: aligned with no structural evidence, or not aligned at
  all. `unaligned` sentences fold in here; they remain separately visible through
  `alignedPct`, which already tracks exactly that.

Book-wide this moves 4,046 of 4,051 into `unresolved`. The residue is **5**.

Two consequences follow, and they are the reason D belongs in this spec rather than after
it. First, plan 247's `≤ ~500` was closer to right in spirit than in measurement — it was
being read against a bucket that is 99.9% non-conflicts. Second, `flagged` only becomes a
meaningful quantity **after** changes A–C: the ~880 lines currently rewritten to narrator
in silence (§1.1) are precisely the conflicts that ought to be in it, and change B is
what puts them there.

`DecisionBucket` gains `'unresolved'`; `aggregateStructureReports` sums it; the
`alignedPct` weight becomes `confirmed + corrected + flagged + unresolved + lumped` so
the weighting is unchanged in meaning.

### 5.2 Target 1a — legibility

`flagged` as a **share of chapter sentences**. Flags are advisory colouring inside a
chapter and must never gate progress, so the question 1a answers is "is the uncertain set
small enough to be guidance rather than noise?"

**Threshold calibrated on post-fix replay, not chosen now.** Changes A–C move the
numbers in both directions — §2 restores structure (fewer unanchored), §3 converts silent
narrator rewrites into conflicts (more flags) — so any number picked today would be
calibrated against the defect.

The order of magnitude to expect, stated here so the plan has something to falsify: today
`flagged` is 5 book-wide; after A–C it should be roughly `5 + the ~880 fallback lines`,
i.e. **~100 per chapter**, minus whatever §2 repairs outright. If the post-fix figure
lands far outside that, the model of the defect in §1 is wrong and the threshold work
stops until that is explained.

### 5.3 Target 1b — engine health

Three readings, each with a corpus-grounded bar:

1. **Narrator delta ≈ 0** on dialogue-opening sentences (§1.1). Today 0.0 on all four
   intact chapters and up to +58.3 on damaged ones. This is the criterion that cannot be
   passed by giving the engine less to see — degrading the input *raises* it.
2. **Oversized-span fallback rate** (§3/§4) — how often the backstop fired.
3. **`unresolved` share** as a coverage disclosure, so "few conflicts because attribution
   is confident" is distinguishable from "few conflicts because nothing was examined".

Reading 3 is the direct answer to #2253's stated acceptance: *"a companion signal that
distinguishes 'few flags because attribution is confident' from 'few flags because the
parser saw nothing'."*

### 5.4 Register

The C2 row's criteria in
[`docs/testing/onbox-acceptance-register.md`](../../testing/onbox-acceptance-register.md)
and the run sheet
[`night-watch-reanalysis-onbox-acceptance.md`](../../testing/night-watch-reanalysis-onbox-acceptance.md)
are restated against 1a/1b. C2's remaining genuine debt is unchanged and small —
`escalated` / `escalationAccepted` and wall-clock — because everything else is
replay-computable.

---

## 6. Blast radius

**Changes B, C and D are gated or additive.** B fires only above 800 chars, which 12 of
17 books never reach. C only counts. D adds a bucket and splits an existing one.

**Change A applies to every book, and that is the one real risk in this spec.** The
acceptance bar is therefore empirical, not argued:

> **The 12 clean books must produce byte-identical structure output.**

The replay harness already walks all 17 in minutes. If any clean book moves, A is gated
behind the oversized-paragraph condition instead of applying universally — a worse fix,
but the measurement decides, not the argument.

---

## 7. Testing

- **Unit** — segmentation boundary rule (punctuation-then-whitespace accepted;
  letter-adjacent dashes in `точь-в-точь` / `кое-чему` / `что-то` rejected); speech vs
  tag/beat classification of segments; the 800-char bound; `tag-span-narrator` skipping
  oversized spans; the `weak` stamp on both recovered-segment speakers and
  oversized-anchored speech spans; `unresolved` bucketing and its aggregation.
- **Regression, fails before / passes after** — the ch5 paragraph from §1.3 as a fixture:
  409 victims → near-zero, and the narrator delta → ~0.
- **Controls that must not move** — ch1 and ch9 have 0 victims today and must still have
  0. They are the controls because §2 and §3 should not reach them at all, not because
  they happen to agree; pick controls before seeing results, on that basis.
- **Corpus gate** — byte-identical structure output on the 12 clean books (§6).
- **Fixture** — the Russian Coalfall variant
  (`server/src/__fixtures__/the-coalfall-commission.ru.md`) gains a multi-turn paragraph
  case, so the repo owns a permanent reproduction independent of a copyrighted book.
- **Existing** — `analysis.structure-fixture.test.ts`'s bucket tally assertion
  (`confirmed: 5, corrected: 7, flagged: 2, lumped: 0, alignedPct: 100`) must be updated
  for the new bucket rather than deleted.

---

## 8. Sequencing

A → B → C → D, one branch, one PR. D depends on A–C landing first only for its
*threshold calibration* (§5.2); its shape is independent.

**#2254's ingestion-side pre-split is superseded.** §2 solves the same problem at the
parser without mutating manuscript text, and works on books whose long paragraphs did not
come from Calibre. #2254 remains open only for the ingestion-quality *signal* in §4.

## 9. Out of scope

- No manuscript text rewriting, at ingest or elsewhere. Segmentation changes boundaries,
  not bytes.
- No new language conventions or verb lexicons — §2 reuses `speechVerbStems` /
  `beatVerbStems` / `quotePairs` as they stand.
- No changes to escalation, to the 80% alignment floor, or to the low-confidence UI's
  layout. D changes what the UI is *given*, not how it renders it.
- No re-run of the full analysis to obtain these numbers; the replay is the harness.

## 10. Decisions taken

| Decision | Chosen | Why |
|---|---|---|
| What target 1 measures | Split into 1a operational / 1b health | One number was standing in for both, and ch5 passed one while failing the other completely |
| Queue unit for 1a | Share of chapter sentences | Flags are advisory colouring within a chapter and must never block progress |
| Low participation | Not a separate verdict — folded into 1b reading 3 | The narrator-delta invariant (5.3.1) already cannot be passed by degrading input, so a separate exclusion rule is unnecessary |
| Oversized tag span | Recover first, fall back to no-evidence | Recovery restores the dialogue; the fallback makes the ambiguous split safe to attempt |
| Where recovery lives | Parser, not cross-examiner | The information is lost at the paragraph boundary; fixing it there needs no downstream changes |
| Bucket split (D) | In this spec | Without it 1a measures how much dialogue lacks tags — a property of the prose, not of the engine or the queue |
