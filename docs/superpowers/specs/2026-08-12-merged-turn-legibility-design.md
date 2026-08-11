# Merged-turn legibility — design of record (#2267)

**Status:** approved 2026-08-12. Supersedes the target-1a definition in
`docs/superpowers/specs/2026-08-11-dialogue-convention-invariant-design.md` §6
and in plan 247.

## 1. The problem

Plan 247's target **1a** ("legibility": share of a chapter's sentences with
`confidence < 0.75`, bar ≤ **44%**) exists to name paragraph-degraded chapters
— sources whose EPUB conversion destroyed paragraph structure (#2254) — and to
emit the signal *re-convert this source*. Measured, it does neither.

### 1.1 False negatives

No paragraph-degraded Ночной дозор chapter breaches 44%: ch4 23.2%, ch5 42.9%,
ch6 37.2%, ch7 26.7%, ch8 41.8%.

### 1.2 False positives (new, #2264's replay)

*Unlocked* (English) is structurally healthy — 1 victim in 1,430 quote-opening
sentences, 0.07%, against a 1b bar of ≤4%. Its per-chapter 1a share across 56
adjudicated chapters runs **3.0% – 54.9%**, breaching 44% three times:

| chapter | 1a share | sentences | alignedPct |
|---|---|---|---|
| ch72 | 54.9% | 266 | 95% |
| ch61 | 53.0% | 353 | 88% |
| ch69 | 45.2% | 299 | 90% |

A healthy book breaches three times; a degraded book never breaches once.

### 1.3 Root cause — the calibration set was contaminated

44% was set from "the worst structurally-intact chapter (ch2, 38.9%)". **ch2 is
not structurally intact.** Measuring merged dialogue turns directly on the
source text (§2) gives, for Ночной дозор:

| chapter | plan-247 label | merged turns / 10k narration chars | worst single paragraph |
|---|---|---|---|
| ch3 | intact | **3.3** | 6 turns in 1,622 chars |
| ch9 | intact | 16.1 | 61 turns in 8,565 chars |
| ch2 | intact — **the calibration source** | **20.8** | **64 turns in 8,604 chars** |
| ch1 | intact | **23.3** | **87 turns in 10,651 chars** |
| ch4 | degraded | 26.1 | 76 turns in 11,762 chars |
| ch7 | degraded | 27.9 | 58 turns in 9,838 chars |
| ch6 | degraded | 42.0 | 115 turns in 13,487 chars |
| ch8 | degraded | 57.3 | 133 turns in 12,720 chars |
| ch5 | degraded | 65.2 | 116 turns in 11,023 chars |

Verbatim from chapter **1**, inside the 87-turn paragraph:

```
Честно предупредил: - Водка не очень. - Здоровье дороже, - отрезал я.
...
- Не надо, - буркнул я. - То-то. Проснулся? - Да. - Ты сегодня как обычно.
```

Degradation in this EPUB is a **continuum across all nine chapters**, not a
ch4–8 property. ch3 is the only near-clean chapter. The bar was calibrated from
a degraded chapter, which is why it sits too high to fire.

"ch1/2/3/9 have zero dash-invariant victims" remains true. That is a statement
about victims, not about structure; the two are independent, and why heavily
merged ch1 yields no victims is **not established here and must not be
assumed**.

### 1.4 Why the confidence share cannot be repaired by re-tuning

Plan 247 already rules out lowering the bar (it would flag intact chapters).
The deeper reason is that confidence share is a **downstream shadow**: it is
dominated by how much dialogue a chapter contains and whether the chapter
cleared the alignment floor, not by paragraph structure. Those inputs vary
independently of the defect, which is what produces error in both directions.

## 2. The metric

**Merged-turn density.** In a language whose typography gives every dialogue
turn its own paragraph, a turn opener *inside* a non-dialogue paragraph cannot
occur in correctly-converted text. It is a merge artefact **by construction**,
not a correlate of one.

Given a chapter `body` and its `LanguageConventions`:

1. Split `body` on `\n`; drop blank lines. Each remaining line is a paragraph
   (`parser.ts:94` uses the same rule).
2. A paragraph is a **dialogue paragraph** if it matches
   `^\s*(?:DASH|[<quote openers>])`, where `DASH` is
   `(?:&mdash;|&ndash;|[-–—])` and the quote openers are the distinct first
   elements of `conventions.quotePairs`. Everything else is a **narration
   paragraph**; its length accumulates into `narrationChars`.
3. Inside narration paragraphs only, count matches of
   `([.!?…:])\s+DASH\s+(?=\p{Lu})` into `mergedTurns`.
4. `mergedTurnsPer10k = mergedTurns / narrationChars * 10000`.

### 2.1 Why the quote-opener exclusion is load-bearing

Russian uses **both** the dash convention and the guillemet convention.
`«Нет, — сказала Рен. — Воробушек занят».` is correct typography, and its
interior `. — Uppercase` is a same-speaker tag-then-resume, not a merge.
Excluding only dash-opening paragraphs scores every guillemet-convention book
as heavily degraded: Заказ Коалфолла measured **14.6** that way and **5.5**
with the exclusion, and all 22 of its original matches were verified false
positives of exactly this shape.

The uppercase requirement is what excludes intra-word hyphens (`где-то`,
`серо-стальных`) and punctuation dashes followed by lowercase.

### 2.2 Calibration

| source | per 10k | note |
|---|---|---|
| Юный дрессировщик (ru, 208,032 narration chars) | **0.0** | real published EPUB; 1 match in the whole book |
| El Encargo de Coalfall (es) | **0.0** | Castwright-owned, authored clean |
| La Commande de Coalfall (fr) | **0.0** | Castwright-owned, authored clean |
| Заказ Коалфолла (ru) | **5.5** | Castwright-owned, authored clean |
| Ночной дозор ch3 | 3.3 | the one near-clean chapter |
| Ночной дозор — every other chapter | **16.1 – 65.2** | |

Four independent clean sources occupy **0.0 – 5.5**; every degraded chapter is
**≥ 16.1**, ~3× the worst clean reading.

**Threshold: ≤ 10 merged turns per 10,000 narration characters.** 2× headroom
above the worst clean reading, 1.6× margin below the lowest degraded one.

### 2.3 Applicability

Defined only where `conventions.dialogueOpen !== null` — **ru, es, fr** today.
For English the same probe measures something else entirely, because
`"Hi," he said. "How are you?"` inside one paragraph is legitimate English
typography (*Unlocked* reads 5.1 per 10k and is healthy). English is **out of
scope**: the metric reports `undefined`, not `0`.

A chapter with `narrationChars < 3000` also reports `undefined` — a ratio over
a few hundred characters of front matter is noise, not a measurement.

## 3. Target 1 after this change

- **1a — Review burden** (renamed from "Legibility"). Same `confidence < 0.75`
  share, **no structural claim**. It honestly measures how much of a chapter
  the review UI will highlight, which is useful on its own. It carries no bar
  and no "re-convert" meaning.
- **1b — Engine health.** Unchanged.
- **1c — Legibility (new).** `mergedTurnsPer10k ≤ 10`, ru/es/fr only. A breach
  means *re-convert this source*. Plan 247's existing "What a 1a breach means"
  policy paragraph moves here intact — including that a breach is never grounds
  for widening the threshold.

## 4. Where it is computed

Server-side, into the existing provenance report — the same additive-optional
shape #2253 used for `unresolved`.

- New pure module `server/src/analyzer/dialogue-structure/legibility.ts`:
  `measureChapterLegibility(body, conventions) → { narrationChars, mergedTurns }`.
  Raw **counts**, not a ratio, so the book-level figure is computed from summed
  counts rather than by averaging per-chapter ratios.
- `server/src/routes/analysis.ts` accumulates the per-chapter counts and passes
  the book totals to `aggregateStructureReports`, which emits
  `mergedTurnsPer10k`.
- `AnalysisProvenanceReport.mergedTurnsPer10k?: number` — additive, **optional**,
  no `CURRENT_STATE_SCHEMA` bump. **Absent ≠ zero**; no reader may default it
  to 0.
- The per-chapter operator log line gains `merged=`, so a breaching chapter can
  be named rather than only the book.

`EngineReport` is deliberately **not** extended: it reports the
cross-examiner's decisions about sentences, and this is a property of the
manuscript. Keeping it out avoids implying `crossExamine` computed it.

## 5. Non-goals

- No UI surface. The "re-convert this source" signal reaches the operator log
  and the provenance report only. A user-facing warning is a separate decision.
- No enforcement. Nothing fails, aborts, or refuses to write on a breach.
- No repair. Splitting merged paragraphs back into turns is #2265.
- No English criterion. §2.3.
- No change to `crossExamine`, the alignment floor, or the #2253 invariant.

## 6. Testing

- Unit tests for `measureChapterLegibility`: dash-opening paragraph excluded;
  quote-opening paragraph excluded (the §2.1 regression — a guillemet dialogue
  paragraph must contribute **zero**); intra-word hyphen not counted;
  lowercase-following dash not counted; colon-introduced turn counted;
  `narrationChars` accumulating only narration.
- A fixture test pinning the aggregation: two chapters with known counts
  produce the ratio from **summed counts**, not the mean of two ratios.
- `undefined` (not `0`) for a null-`dialogueOpen` language and for a
  sub-3000-char chapter, with a test that a consumer defaulting to 0 would fail.
- Plan 247's regression doc updated in the same PR.

## 7. Risks

1. **Single degraded book.** The degraded end of the calibration is Ночной
   дозор alone. The clean end has four independent sources, so the *floor* is
   well established; the 10 bar could still prove low for some other
   correctly-converted Russian book. It is a reported diagnostic, not a gate,
   so a false breach costs a look, not a failed run.
2. **es/fr clean readings come from one short Castwright-owned text each**
   (~10k chars). Their 0.0 is consistent with ru but thin.
3. **The colon in the match set** is justified by Ночной дозор, where a colon
   introduces speech. It is unverified for es/fr.
