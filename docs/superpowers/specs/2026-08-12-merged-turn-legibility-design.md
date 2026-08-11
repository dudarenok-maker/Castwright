# Merged-turn legibility — design of record (#2267)

**Status:** approved 2026-08-12. Revised the same day after an adversarial
review killed the first metric (§8 records what changed and why).

**Supersedes:** the target-1a definition in plan 247
(`docs/features/247-dialogue-structure-attribution.md`) and in
`docs/superpowers/specs/2026-08-11-dialogue-convention-invariant-design.md`
**§4 / §4.2** (not §6, which is that document's Testing section).

## 1. The problem

Plan 247's target **1a** ("legibility": share of a chapter's sentences with
`confidence < 0.75`, bar ≤ **44%**) exists to name paragraph-degraded chapters
— sources whose EPUB conversion destroyed paragraph structure (#2254) — and to
emit the signal *re-convert this source*. Measured, it does neither.

### 1.1 False negatives

No paragraph-degraded Ночной дозор chapter breaches 44%: ch4 23.2%, ch5 42.9%,
ch6 37.2%, ch7 26.7%, ch8 41.8%.

### 1.2 False positives

*Unlocked* (English) is structurally healthy — 1 victim in 1,430 quote-opening
sentences, 0.07%, against a 1b bar of ≤4% (#2264). Its per-chapter 1a share
across 56 adjudicated chapters runs **3.0% – 54.9%**, breaching 44% three
times: ch72 54.9% (n=266), ch61 53.0% (n=353), ch69 45.2% (n=299). A healthy
book breaches three times; a degraded book never breaches once.

### 1.3 Root cause — the calibration set was contaminated

44% was set from "the worst structurally-intact chapter (ch2, 38.9%)". **ch2 is
not structurally intact.** The "intact" label for ch1/2/3/9 came from those
chapters having zero *dash-invariant victims* — a fact about victims, silently
reused as a claim about paragraph structure. Direct measurement of the source
text (§2) contradicts it. Ночной дозор, **maximum merged dialogue turns found
inside a single paragraph**:

| chapter | plan-247 label | max merged turns in one paragraph |
|---|---|---|
| ch3 | intact | **6** |
| ch7 | degraded | 58 |
| ch9 | intact | **61** |
| ch2 | intact — **the calibration source** | **64** |
| ch4 | degraded | 76 |
| ch1 | intact | **87** |
| ch6 | degraded | 115 |
| ch5 | degraded | 116 |
| ch8 | degraded | 133 |

Verbatim from chapter **1**, inside the 87-turn paragraph:

```
Честно предупредил: - Водка не очень. - Здоровье дороже, - отрезал я.
...
- Не надо, - буркнул я. - То-то. Проснулся? - Да. - Ты сегодня как обычно.
```

and from chapter **2**, inside its 64-turn paragraph:

```
- Я не хочу! - Егор схватился за дверь... - Я им не верю!
```

**Degradation in this EPUB is a continuum across all nine chapters**, not a
ch4–8 property. ch3 is the only chapter that reads clean. Corroborating
evidence independent of this metric: ch1 contains **1,297 dashes, every one an
ASCII hyphen** — not a single em- or en-dash anywhere — which is itself a
signature of a lossy conversion.

The bar was calibrated from a degraded chapter. That is why it never fires.

### 1.4 Why the confidence share cannot be repaired by re-tuning

Plan 247 already rules out lowering the bar (it would flag intact chapters).
The deeper reason is that confidence share is a **downstream shadow**:
dominated by how much dialogue a chapter contains and whether it cleared the
alignment floor, neither of which tracks paragraph structure. Inputs that vary
independently of the defect are what produce error in both directions.

## 2. The metric

**Worst-paragraph merged-turn count.** In a language whose typography gives
every dialogue turn its own paragraph, a turn opener *inside* a non-dialogue
paragraph cannot occur in correctly-converted text. It is a merge artefact **by
construction**, not a correlate of one.

Given a chapter `body` and its `LanguageConventions`:

1. Split `body` on `\n`; drop blank lines. Each remaining line is a paragraph
   (`parser.ts:94` uses the same rule).
2. Skip any paragraph matching `conventions.dialogueOpen` — a properly-formed
   dialogue paragraph.
3. In every remaining paragraph, count matches of
   `([.!?…:])\s+DASH\s+(?=\p{Lu})`, where `DASH` is
   `(?:&mdash;|&ndash;|[-–—])`.
4. The chapter's reading is the **maximum** of those per-paragraph counts. The
   book's reading is the maximum over its chapters.

The uppercase lookahead is what excludes intra-word hyphens (`где-то`,
`серо-стальных`) and punctuation dashes followed by lowercase.

### 2.1 Why a maximum and not a rate

A per-character rate was specified first and **failed review**. Three
independent defects, all of which a maximum simply does not have:

- **The denominator is the defect.** Merging moves character mass *out of*
  dialogue paragraphs and *into* narration ones, inflating numerator and
  denominator together. Measured dialogue mass: Ночной дозор 16–33%, the clean
  controls 37–48% — the degraded book has the *larger* narration denominator.
  A rate is therefore systematically **lenient on exactly the books it
  targets**.
- **False positives set the clean ceiling.** Narration-then-quoted-speech
  inside one paragraph (`они разгорелись... «Мне не нужен меч, — сказал он.
  — Все хотят моей смерти»`) is standard Russian typography and matches the
  pattern. Every surviving match in the clean control was one of these, so the
  rate's clean ceiling was **entirely artefact**.
- **A rate needs arbitrary guards.** A minimum-length cutoff was required to
  stop short chapters producing meaningless ratios — and that cutoff turned out
  to be the only thing keeping a known-good control chapter under the bar.

A maximum is immune to all three because **false positives are sparse and
merges are dense**. The FP mechanism yields 1–2 matches in a paragraph; a
genuine merge yields dozens. That is an order-of-magnitude separation, and it
is the property the whole design now rests on.

It is also not the unsound shape plan 247 rejected in `flagged ≤ 500`. That bar
was an absolute count over a *chapter*, so a longer chapter failed for being
longer. This is a count within *one paragraph*: length does not make any
individual paragraph hold more dialogue turns unless that paragraph really is
merged.

### 2.2 Calibration

| source | max turns in one paragraph | note |
|---|---|---|
| El Encargo de Coalfall (es) | **0** | Castwright-owned, authored clean |
| La Commande de Coalfall (fr) | **0** | Castwright-owned, authored clean |
| Юный дрессировщик (ru) | **1** | real published EPUB, 208k chars, 15 chapters |
| Заказ Коалфолла (ru) | **2** | Castwright-owned, authored clean |
| Ночной дозор ch3 | 6 | see below — **not** a calibration source |
| Ночной дозор, other 8 chapters | **58 – 133** | 34 paragraphs hold ≥10 |

**Threshold: ≥ 10 merged turns in a single paragraph means the chapter is
paragraph-degraded.** Four independent clean sources occupy **0–2**; the lowest
degraded chapter is **58**. The bar sits 5× above the worst clean reading and
5.8× below the lowest degraded one, inside an empirically empty interval.

**ch3 is deliberately excluded from the calibration.** §1.3 concludes this
EPUB is degraded throughout, so using one of its chapters to define the clean
end would repeat precisely the error this document convicts plan 247 of. ch3
reads 6, passes the bar on its own, and needs no such assumption. The clean
band comes entirely from four books that are not this one.

### 2.3 Applicability

Defined only where `conventions.dialogueOpen !== null` — **ru, es, fr** today.
English is out of scope for a structural reason, not a numeric one: English has
**no paragraph-per-turn invariant** to violate, because
`"Hi," he said. "How are you?"` inside a single paragraph is correct English
typography. There is no defect for this probe to detect. (Run verbatim on
*Unlocked*, it reads 0 — the probe finds nothing because English does not use
paragraph dashes at all. That zero is an absence of signal, not evidence of
health, which is exactly why the metric must report **`undefined` rather than
`0`** for a null-`dialogueOpen` language: a reader must not be able to read
"English is clean" off a value the probe was never able to produce.)

No minimum chapter length. The first draft needed one to stabilise a ratio; a
maximum over paragraphs is meaningful at any length.

## 3. Target 1 after this change

- **1a — Review burden** (renamed from "Legibility"). Same `confidence < 0.75`
  share, **no structural claim, no bar**. It honestly measures how much of a
  chapter the review UI will highlight, which is useful on its own.
- **1b — Engine health.** Unchanged.
- **1c — Legibility (new).** `maxMergedTurnsInParagraph < 10`, ru/es/fr only.
  A breach means *re-convert this source*.

Plan 247's "What a 1a breach means" paragraph is **rewritten, not moved**. It
cannot transfer intact: it attributes the breach to the engine "correctly
refusing to guess" (a statement about `crossExamine` confidence, which 1c never
computes), it says the threshold is "set from structurally-intact chapters" (1c's
is set from four *other books*), and it carries the 44% bar and the 1a figures.
What survives, and must be restated under 1c: **a breach is a real failure with
a specific remedy — re-convert the source — and never grounds for widening the
threshold.**

## 4. Where it is computed

- New pure module `server/src/analyzer/dialogue-structure/legibility.ts`:
  `measureChapterLegibility(body, conventions) → number | undefined` — the
  chapter's worst-paragraph count, or `undefined` when `dialogueOpen` is null.
- `AnalysisProvenanceReport.maxMergedTurnsInParagraph?: number` — additive,
  **optional**, no `CURRENT_STATE_SCHEMA` bump. **Absent ≠ zero**; no reader
  may default it to 0 (§2.3).
- The per-chapter operator log line gains `merged=`, so a breaching chapter can
  be named rather than only the book.

**It must not be emitted through `aggregateStructureReports`.**  That function
(`server/src/routes/analysis.ts:2338`) takes a single `EngineReport[]` and
returns `undefined` when that array is empty — which is the case whenever the
structure engine did not run **or every chapter came back from the stage-2
cache**. This metric is pure manuscript text and needs neither, and its main
advantage over target 1a is precisely that it scores books that were never
analysed. Routing it through an engine-gated function would throw that away.

So: `analysis.ts` accumulates the per-chapter maximum independently, and merges
it into the provenance report **after** `aggregateStructureReports` returns —
including constructing a report that carries only this field when the aggregate
returned `undefined`. Aggregation is `Math.max`, so there is no weighting
subtlety.

`EngineReport` is deliberately **not** extended: it reports the
cross-examiner's decisions about sentences, and this is a property of the
manuscript.

## 5. Non-goals

- No UI surface. The signal reaches the operator log and the provenance report
  only. A user-facing warning is a separate decision.
- No enforcement. Nothing fails, aborts, or refuses to write on a breach.
- No repair. Splitting merged paragraphs back into turns is #2265.
- No English criterion (§2.3).
- No change to `crossExamine`, the alignment floor, or the #2253 invariant.

## 6. Testing

- Unit tests for `measureChapterLegibility`: a dash-opening paragraph is
  skipped; a paragraph with one legitimate narration-then-quoted-speech match
  reads 1 (the false-positive shape must stay far under the bar rather than be
  claimed absent); intra-word hyphens not counted; a lowercase-following dash
  not counted; a colon-introduced turn counted; the result is the **maximum**
  over paragraphs, not the sum — a chapter of twenty 1-match paragraphs must
  read 1, not 20.
- `undefined` (not `0`) for a null-`dialogueOpen` language, with a test that a
  consumer defaulting to `0` would fail.
- A test that the book figure is emitted **when no `EngineReport` exists at
  all** — the fully-cached case §4 exists to protect.
- Plan 247 updated in the same PR, plus the three documents in §7.

## 7. Documents carrying the disowned 44% claim

All must move in this PR or be explicitly deferred with a reason:

1. `docs/features/247-dialogue-structure-attribution.md` — target 1a itself.
2. `docs/superpowers/plans/2026-08-11-dialogue-convention-invariant.md`
   (~:1636) — re-derives 38.9% → 44% and calls it "re-checked… unaffected".
3. **`docs/testing/night-watch-reanalysis-onbox-acceptance.md` (:239, :250)** —
   hardcodes `≤ 44% per chapter` as the **C2 pass criterion for a still-open
   register row**. An open acceptance row currently grades on a bar this
   document declares meaningless. This is the one with operational consequence.

No committed test hardcodes 44%, so CI does not break.

## 8. What the adversarial review changed

Recorded so the reasoning is not re-litigated. The first draft specified a
`mergedTurnsPer10k` rate with a bar of ≤10 per 10k, a clean band of 0.0–5.5 and
a `<3000`-char cutoff. Review established that the clean band was entirely
false positives, that the denominator moves *with* the defect, that the cutoff
was load-bearing rather than hygienic, that the rate's bar fell inside the
labelled-intact range, and that calibrating from ch3 contradicted §1.3. The
metric was replaced rather than patched.

Two smaller corrections carried over: the supersession pointer said §6 where it
meant §4/§4.2, and the English exclusion was argued from a 5.1 reading that
came from a *different*, quote-based regex rather than from this probe.

## 9. Risks

1. **The degraded end of the calibration is one book.** The clean end now has
   four independent sources and the gap is 29×, but no second degraded source
   has been measured. A reported diagnostic, not a gate, so a false breach
   costs a look.
2. **No clean source is both large and dialogue-dense.** Юный дрессировщик is
   large but nearly dialogue-free; the three dialogue-dense controls are ~10k
   chars each. A maximum is far less sensitive to this than a rate was — a
   dialogue-dense clean book would need a single paragraph holding 10 merged
   turns to breach — but it is untested in that regime.
3. **The colon in the match set** is justified by Ночной дозор, where a colon
   introduces speech. Unverified for es/fr; both read 0 regardless.
4. **Three definitions of "dialogue paragraph" now coexist** in this
   subsystem: `parser.ts:94` (dash only), `parser.ts:258` (any paragraph
   *containing* a quote run — which is why Russian quoted place names get
   filed as dialogue), and this module (dash only, matching `parser.ts:94`).
   This design deliberately matches the first. The divergence at `:258` is
   pre-existing and out of scope here, but it is a live trap for anyone
   partitioning paragraphs by `ParagraphEvidence.kind`.
