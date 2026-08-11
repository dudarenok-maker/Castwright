# Design — the dialogue-convention invariant, and a sound acceptance metric
# (#2253, #2254)

Design pass for plan [247](../../features/247-dialogue-structure-attribution.md).
No code ships from this thread; the prototype below was written, measured, and reverted.

**Verdict: one change to the cross-examiner fixes the quality defect. Not four.**

An earlier revision of this spec proposed intra-paragraph turn segmentation in the
parser, a tag-span length bound, structure-quality reporting, and a metric re-spec. Two
of those four were **measured and refuted** (§7). What remains is a single convention
invariant applied at two call sites, plus the metric work that was always independent.

**The defect being fixed:** the engine rewrites **879 lines** of character dialogue to
the narrator, unflagged, and books each as a `corrected` success.

---

## 1. Evidence

All figures come from offline replay over the committed 2026-08-06 analysis cache for
*Ночной дозор* (`mns_oyK7Po6BiT.json`) plus a re-parse of the source EPUB. The replay
reruns the real `alignSentences` → `crossExamine` path in minutes with no LLM and no GPU.

### 1.1 The harm

A **victim** is a sentence that opens with the language's dialogue marker, where the
model assigned a real character and the engine output `narrator`. Denominator throughout
is **dash-opening sentences**, not chapter sentences.

| ch | dash-opening sentences | victims | victim rate | model → narrator | engine → narrator |
|---|---|---|---|---|---|
| 1 | 777 | **0** | 0.0% | 37.8% | 37.8% |
| 2 | 649 | **0** | 0.0% | 20.2% | 20.2% |
| 3 | 246 | **0** | 0.0% | 15.4% | 15.4% |
| 9 | 428 | **0** | 0.0% | 26.2% | 26.2% |
| 4 | 243 | 10 | 4.1% | 48.1% | 52.3% |
| 7 | 590 | 105 | 17.8% | 34.9% | 52.7% |
| 8 | 546 | 113 | 20.7% | 36.4% | 57.1% |
| 6 | 551 | 242 | 43.9% | 11.8% | 55.7% |
| 5 | 702 | **409** | **58.3%** | 11.4% | **69.7%** |

**Total: 879.** Zero on every structurally-intact chapter; positive on every damaged one.

**This is a disagreement count, not a proven-error count** — see §5, which treats closing
that gap as a precondition, not a footnote.

### 1.2 The mechanism

`decideSentence` (`cross-examine.ts:244-277`) is an ordered cascade:

```
unaligned → lumped → speechSpan? → some(kind==='tag') → decideNarrationOnly
```

A sentence reaches the speech path only if **at least one aligned span is `speech`**
(`:265`). With no speech span it falls to `decideTagSpanOnly` (`:210`) —

```ts
{ characterId: NARRATOR_ID, confidence: 0.9, reason: 'tag-span-narrator',
  bucket: 'corrected', flagged: false }
```

— which is **unconditional**: it never looks at what the model said. Failing that, it
falls to `decideNarrationOnly` (`:222`), which **also** demotes to narrator, at the same
0.9, `flagged: false` for all but the first of a contiguous run.

So the operative rule is **"no speech span ⇒ narrator, silently"**, and there are two
independent routes to it. This is why bounding tag-span length cannot work (§7.1).

### 1.3 Why those sentences have no speech span

`parseChapterStructure:99` selects the dash path or the quote path on whether the
paragraph's **first character** is a dialogue dash — `dialogueOpen` is `^`-anchored
(`lang/ru.ts:9`). ch5's largest paragraph (13,068 chars) begins `Я знал, что у Ольги…` —
narration — so it routes to `parseQuoteParagraph`, which:

- finds two incidental ASCII-quoted fragments → two `speech` spans of **10 and 8 chars**
  (`parser.ts:232`);
- emits the gaps between them as `narration` (`:229`, `:235`);
- **reclassifies any gap to `tag` if it contains one speech/beat verb stem, with no
  length bound** (`:242-254`).

Observed layout, confirming the quote path (a `tag` span first is near-unreachable on
the dash path, which initialises `state = 'speech'` at `:126`):

```
tag[3775] | speech[10]->shef/tag-name | tag[2563] | speech[8]->semen/tag-name | tag[158]
```

The path selection is **deliberate**, not drift: `parser.ts:7-8` states the assumption —
*"Paragraph = a body line (the EPUB/MD parsers emit one paragraph per line)"*, i.e. one
paragraph is one turn. Original implementation, `d2e0e042` (2026-07-09). That assumption
is false for this book. Note `8e247d4d` already patched this same reclassification once
for over-firing ("stop mislabeling quote-free narration as tag"); this is its second.

### 1.4 Corpus prevalence

Tag-span length across all 17 workspace EPUBs, roster-free: **12 of 17 never exceed 503
chars**; four reach 503–723; *Юный дрессировщик* 704; **KotLC *Unlocked* (English)
2,765** with 49.6% of tag text oversized; **Ночной дозор 12,389** with 92.9%.

This measures **exposure** — how much tag text sits in oversized spans. It does **not**
measure harm, and the same run proves the two come apart: ch1 (0 victims) has a 6,968-char
tag span, ch2 (0 victims) 4,767, ch9 (0 victims) 5,631. **Span size predicts nothing on
its own.**

**Correction.** An earlier revision read this table as "the defect is cross-language, and
the second affected book is English." That overstates it. What is established for
*Unlocked* is oversized tag spans; whether any of its lines are mis-voiced is
**unmeasured**, and by this table's own logic exposure does not imply harm. See §3.

### 1.5 Corrections to the record

Published before being checked, and superseded here:

- *"ch5's attribution quality is unaffected — 11.4% narrator."* That is the **model's**
  column; the engine's is 69.7%. Corrected in
  [#2253](https://github.com/dudarenok-maker/Castwright/issues/2253#issuecomment-5249260163).
- *"#2254 costs engine visibility, not output quality."* It costs output quality.
  Corrected in [#2254](https://github.com/dudarenok-maker/Castwright/issues/2254#issuecomment-5249262228).
- The run sheet §2A records *"REFUTED, do not re-propose: paragraph degradation causes
  the narrator collapse"* (`corr = −0.073`), computed on the same wrong column. **That
  refutation is withdrawn**; the run sheet is corrected in the same change.

---

## 2. The change — the dialogue-convention invariant

> **A sentence that opens with the language's dialogue marker is speech by that
> language's own convention. Structural evidence to the contrary is the parser having
> failed to segment, not proof the line is narration. Keep the model's speaker and flag;
> never demote to narrator.**

This is deliberately *not* a length heuristic. It does not ask how big the tag span is —
§1.4 shows size predicts nothing. It asks whether the text itself declares its type.

### 2.1 Two call sites, not one

The `flagOnly` path bypasses `decideSentence` entirely, calling `decideNarrationOnly`
directly (`cross-examine.ts:315-316`) for any `isPureNarrationAligned` sentence — which a
tag-only sentence satisfies (`:283-285`). **Patching only `decideSentence` leaves the
defect fully intact below the alignment floor**, verified by forcing the floor to 100:
victims returned to 879.

No chapter of this book is below the floor post-#2187, so no measurement on this corpus
would have caught it. Both sites are required.

### 2.2 Prototype (written, measured, reverted)

`CrossExamineOpts` gains `dialogueOpen?: RegExp | null`, supplied from the conventions
already resolved at `analysis.ts:2214`. In `decideSentence`, after the speech-span branch
and before the tag branch:

```ts
if (opts.dialogueOpen?.test(as.sentence.text ?? '') && !isNarratorOrUnknown(modelId, opts)) {
  block.active = false;
  return {
    characterId: modelId,
    confidence: CONFIDENCE.TAG_WEAK_KEEP_FLAG,   // 0.6
    reason: `dash-line-keep-flag:${modelId}`,
    bucket: 'flagged',
    flagged: true,
  };
}
```

and in the `flagOnly` branch, one added conjunct:

```ts
if (isPureNarrationAligned(as) && as.sentence.characterId !== NARRATOR_ID &&
    !opts.dialogueOpen?.test(as.sentence.text ?? '')) {
```

**23 insertions, 1 deletion, one file.**

### 2.3 Measured result

| | baseline | with the change |
|---|---|---|
| victims (floor 80) | **879** | **0** |
| victims (floor forced to 100 → `flagOnly`) | 879 | **0** |
| controls ch1 / ch2 / ch3 / ch9 | 0 | **0** |
| `flagged` | 4,051 | 4,930 (+879 exactly) |
| structure hash, all 17 books | — | **unchanged** |
| `server/src/analyzer/` + structure route tests | 978 pass | **978 pass** |

The 17-book gate is unchanged **by construction**: the parser is not touched, so no
book's parse can move. That is a materially stronger guarantee than the previous
revision's empirical byte-identical gate, which §7.2 explains was close to tautological.

Confidence `0.6` sits below the review UI's `< 0.75` highlight threshold
(`src/views/manuscript.tsx:415`, `:526-529`, `:1919`), so the 879 recovered lines
actually surface to the user rather than only moving a counter.

### 2.4 What this buys, stated honestly

It **flags**; it does not **attribute**. Each recovered line keeps the model's speaker,
which may still be wrong, and is surfaced as uncertain. It converts a silent, confident
error into a visible uncertainty. That is the correct direction and the whole of the
quality fix — it is not recovery of the lost structure.

---

## 3. Why this does not fix *Unlocked*

**Two independent reasons**, which need separating because only one is a gap in the fix.

### 3.1 We never established *Unlocked* is harmed at all

Every harm number here comes from comparing two columns — what the model assigned, and
what the engine output. That needs a committed analysis cache. ***Unlocked* has never
been analysed**, so there is no model column, and its victim count is not merely unknown,
it is **unmeasurable from what is on disk**.

What *is* measured is exposure: 49.6% of its tag text in spans over 500 chars, max 2,765.
§1.4 shows exposure does not imply harm — three chapters of *Ночной дозор* carry tag spans
of 4,767–6,968 chars and produce **zero** victims. *Unlocked* is a **candidate, not a
casualty**.

### 3.2 English marks its turns differently, and the marker is weaker

`dialogueOpen` is `null` for **en, de, ja, zh** (`lang/en.ts:5`, `de.ts:5`, `ja.ts:9`,
`zh.ts:9`); non-null only for ru, es, fr. So §2's trigger does not exist for English.

The obvious analogue — a sentence beginning with a `quotePairs` opener is speech — is the
same idea but a **weaker signal**, for a reason worth stating:

- In Russian dash convention the marker sits at the **head of the turn**. `— Не стоит.`
  identifies itself as speech even after the paragraph around it is destroyed. **The
  signal survives the damage that causes the bug.**
- In English, quotes **wrap** the speech. A leading `"` catches `"Not worth it," he said.`
  but misses `He said, "Not worth it."`, where the sentence opens with narration and the
  speech is embedded. Sentence-initial position is a less reliable turn marker.
- So a long inter-quote gap in English is frequently *genuine* narration, whereas a
  mid-paragraph dash line in Russian is almost always a lost turn. Same rule shape, much
  less confidence.

**What the plan must do:** analyse *Unlocked* and run the two-column comparison **before**
designing an English arm. Zero victims → the arm is unnecessary and must not be built on
an exposure statistic. Victims → their shape decides whether a leading-quote test suffices.
**Until then, do not describe this fix as cross-language.** It is verified for one Russian
book.

## 4. Retained — the metric re-spec

Independent of §2, and now more necessary, since §2 raises `flagged` from 4,051 to 4,930.

### 4.1 The bucket split

Full reason tally across every flagged sentence in the book, at baseline:

| reason | count | share |
|---|---|---|
| `unanchored-named` | 2,442 | 60.3% |
| `unanchored-narrator` | 1,007 | 24.9% |
| `unaligned` | 597 | 14.7% |
| `pronoun-keep-flag` | **5** | **0.1%** |

`unanchored-*` is 85.1%; with `unaligned`, **99.9% is "no evidence either way"**. The
entire book contains **5 genuine conflicts**. A bucket that composition cannot carry a
pass/fail bar.

`EngineReport` splits it:

- **`flagged`** — a genuine conflict: model contradicts strong structural evidence, an
  alternation conflict, or §2's `dash-line-keep-flag` (convention contradicts structure —
  a real disagreement, so it belongs here, not in `unresolved`).
- **`unresolved`** — no verdict: aligned with no evidence, or not aligned at all.
  `unaligned` folds in; it stays separately visible through `alignedPct`.

Post-change that is 5 + 879 = **884 conflicts**, ~98/chapter, against ~4,046 unresolved.

### 4.2 Target 1a — legibility, defined over confidence

**1a is the share of chapter sentences with `confidence < 0.75`** — the set the UI
actually highlights — **not** the share in the `flagged` bucket.

This corrects a real defect in the previous revision. The navigator and highlight key on
confidence, and nothing in `src/` or `openapi.yaml` reads `structureReport`,
`analysisProvenance`, `alignedPct` or `DecisionBucket` at all. Defining 1a over the
bucket would have let it report ~0.03% while the UI still coloured ~27% of the chapter —
recreating precisely the metric/reality gap #2253 was filed about. Note today's
highlighted set already isn't the flagged set: `ALT_CORRECT_FLAG` (0.7) and
`narration-demote:first` (0.5) are bucket `corrected` yet below the threshold.

Threshold calibrated on post-change replay. **Its baseline has not been measured yet** —
that is plan step 1.

### 4.3 Target 1b — engine health

1. **Victim rate ≈ 0** — dash/quote-opening sentences the engine demoted to narrator
   against the model, as a share of dash/quote-opening sentences (§1.1's denominator).
   Today 0.0% on four chapters, 58.3% worst.
2. **`unresolved` share**, as the coverage disclosure that distinguishes "few conflicts
   because attribution is confident" from "few conflicts because nothing was examined" —
   #2253's stated acceptance requirement.

**A previous revision proposed "narrator delta ≈ 0" as an invariant that could not be
passed by degrading input. That is false and is dropped.** Below the alignment floor,
`flagOnly` passes the model's id through verbatim on every sentence with a speech span,
so the engine column equals the model column and the delta is 0 by construction;
disabling `analyzer.structure.enabled` gives 0 as well. It reproduced the exact flaw it
was meant to close. Reading 1 above is stated as a *rate with a named denominator* for
that reason, and 1b is only meaningful read together with `alignedPct` and `flagOnly`.

### 4.4 Known consumers to update

- `cross-examine-reasons.test.ts:40` — bucket enum `['confirmed','corrected','flagged','lumped']`.
- `analysis.structure-fixture.test.ts:227` — `flagged > 0`; the fixture's 2 flags are
  `unanchored-narrator`, which become `unresolved`, so this asserts 0 unless updated.
  The `toMatchObject` tally at `:228-235` also moves.
- `aggregateStructureReports` (`analysis.ts:2334-2366`) and the log line at `:2272-2274`,
  which prints `flagged=` and is the only operator-visible surface.
- `AnalysisProvenanceReport` (`scan.ts:287-298`) — `unresolved?` must be an **additive
  optional** field per the documented policy at `scan.ts:245-247`, so
  `CURRENT_STATE_SCHEMA` does not bump. Old `state.json` files simply lack the key, and
  nothing reads it back — **migration risk is low**.
- `attribution-eval` `familyBreakdown` (`run-eval.ts:64-82`) keys on reason strings;
  `dash-line-keep-flag` needs a family or it lands in `other`.
- `escalation.ts:72-74` — `isFillEligible` accepts only `unanchored-narrator`, so
  `dash-line-keep-flag` lines are flagged and never escalated. **Accepted deliberately:**
  escalation fills unresolved placeholders, and these are conflicts, not gaps.

---

## 5. Precondition — the 879 is a disagreement count

§1.1 counts where the model and engine disagree, then §2 resolves every disagreement in
the model's favour. But the engine exists *because* the model's attribution is
untrustworthy, and in a merged paragraph the model's own sentence segmentation is
degraded too — so some fraction of the 409 ch5 "sentences" may be model artefacts.

**Hand-label a random sample of 30 victims** (correct / wrong / unclear) before the
threshold work in §4.2. If a material share are cases where the narrator was right, §2 is
still the correct change — flagging beats a silent confident error either way — but 1b
reading 1's target is not "≈ 0" and must be restated.

This is cheap, it is the only claim in this spec with no measurement behind it, and it
gates nothing else.

## 6. Testing

- **Unit** — the invariant at both call sites: a dash-opening sentence with tag-only
  spans keeps the model id and flags; same below the floor; a *narrator*-attributed
  dash-opening sentence is untouched; a non-dash sentence still demotes as today.
- **Regression, fails before / passes after** — ch5's paragraph from §1.3 as a fixture:
  409 victims → 0.
- **Controls** — ch1 and ch9 have 0 victims and must still have 0. They are controls
  because §2 should not reach them, chosen before the results were known.
- **Fixture** — `server/src/__fixtures__/the-coalfall-commission.ru-dash.md` (the
  structure fixture, per `analysis.structure-fixture.test.ts:47`) gains a merged
  multi-turn paragraph. **Not `the-coalfall-commission.ru.md`**, which is the existing
  language-detection fixture and must not be touched.
- **Corpus** — all 17 structure hashes unchanged. Guaranteed by construction, asserted
  anyway, since a future parser change would break it.

## 7. Refuted — do not re-propose without new evidence

### 7.1 A tag-span length bound, at any layer

Prototyped as a mint-site bound (skip narration→tag reclassification above 800 chars,
`parser.ts:249`). Result: **victims 879 → 879, unchanged.** `corrected` collapsed (ch1
1,097→131) and max tag spans fell to ≤800 as designed, and exactly 2 of 17 book hashes
moved — well-targeted and completely ineffective.

Un-tagging a span leaves it `narration`, and `decideNarrationOnly` demotes to narrator
too (§1.2). The bound relabels the mechanism. This also refutes the consumer-side variant
(`tag-span-narrator` skips oversized spans), which lands in the same place.

### 7.2 Intra-paragraph turn segmentation in the parser

This was the previous revision's central proposal, so dropping it needs an argument, not
a risk list. Five reasons, in order of weight.

**i. The parser is not wrong.** It behaves correctly under an assumption it states
explicitly (`parser.ts:7-8`): one line is one paragraph is one turn. That holds for 16 of
17 books on disk. What violates it is a single malformed input. Changing a component
correct for the whole corpus to accommodate one damaged file is the wrong trade before
anything else is weighed.

**ii. The blast radius is every book; §2's is one condition.** §2 fires only where a
sentence opens with a dialogue marker — false for narration everywhere, which is why all
17 structure hashes are untouched. Segmentation alters span boundaries in *every paragraph
of every ru/es/fr book*. Measured, not feared: candidate A was a far narrower parser change
— one length condition — and still moved 2 of 17 hashes.

**iii. A segmentation mistake produces a wrong voice, not a flag.** The decisive one.
`windows.ts:92-101` assigns speakers across a window by **index parity** (A/B/A/B). Insert
or drop one boundary and every subsequent speaker in that window flips. A parser error
therefore does not surface as reviewable uncertainty — it silently mis-voices a run of
dialogue, which is exactly the defect class this spec exists to remove.

**iv. The information is not recoverable from the text.** The proposed rule already exists
as `SPEECH_RESUME` (`parser.ts:14`). The reason it does not open turns is that the sequence
is genuinely ambiguous: it introduces both a new speaker and a continuation by the same
one. `anchorSpansFromTags` phase 2 (`:73-77`) exists specifically for continuation, and the
previous revision's own worked example — `— Не стоит, — сказал я. — Света, не стоит.` — *is*
that shape. No positional rule separates them; it needs meaning.

**v. The existing safety valve amplifies rather than contains.** `parser.ts:148-152`
collapses an *entire* text to one unanchored speech span if any tag span lacks a verb stem.
On a 13,000-char multi-turn paragraph that is one span over thousands of characters, then
eligible for alternation fill — a single fabricated speaker across the passage.

**Deferred, not forbidden.** Segmentation is the *only* route to **recovering** the correct
speaker for those 879 lines; §2 flags them, it does not repair them. So the work has real
value — it is a different goal (recovery vs. not asserting a wrong answer), it carries
corpus-wide risk, and it needs its own evidence and its own regression gate.

### 7.3 Reusing `strength: 'weak'` for alternation-assigned speakers

`strength` is read in exactly one place — `cross-examine.ts:129`, inside
`case 'tag-name'`. `case 'alternation'` (`:155-168`) and `case 'tag-pronoun'`
(`:140-153`) never read it, and `windows.ts:57,64` constructs a fresh speaker object that
discards it. Stamping `weak` on those paths is a silent no-op. Recorded here because the
previous revision's safety argument rested on it.

## 8. Out of scope

- No parser changes at all. §2 is confined to `cross-examine.ts` plus threading
  conventions in from the existing call site.
- No manuscript text rewriting, at ingest or elsewhere.
- No changes to escalation (see §4.4), the 80% alignment floor, or UI rendering.
- No re-run of the full analysis; the replay is the harness.

## 9. Decisions taken

| Decision | Chosen | Why |
|---|---|---|
| Where the fix lives | Cross-examiner, two call sites | Measured: fixes the harm with zero parser risk and no book's parse moving |
| What triggers it | Text opens with the language's dialogue marker | Size predicts nothing (§1.4); the text declares its own type |
| What it does | Keep model speaker, flag at 0.6 | Below the UI's 0.75 threshold, so the user sees it; never fabricates a speaker |
| Tag-span bound | **Dropped** | Measured ineffective (§7.1) |
| Parser segmentation | **Dropped from this spec** | Unnecessary for the fix, and materially risky (§7.2) |
| Target 1a denominator | `confidence < 0.75`, not the bucket | It is what the UI highlights; a bucket-based 1a would report ~0.03% against a ~27% coloured chapter |
| Narrator-delta invariant | **Dropped** | Gameable by dropping below the alignment floor (§4.3) |
| `dash-line-keep-flag` bucket | `flagged` | Convention contradicting structure is a conflict, not an absence |

## 10. Open questions for the plan

1. **Baseline `confidence < 0.75` share per chapter** — 1a's threshold cannot be set
   without it. Plan step 1; the replay already computes it.
2. **Is *Unlocked* actually harmed?** (§3) — analyse it and run the two-column
   comparison. This decides whether an English arm is needed at all; today only its
   *exposure* is known, and exposure does not imply harm.
3. **The hand-labelled sample** (§5) — 30 victims, to convert a disagreement count into
   an error rate and settle 1b reading 1's target.
