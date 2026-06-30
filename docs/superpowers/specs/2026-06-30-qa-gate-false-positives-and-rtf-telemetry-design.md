---
status: draft
---

# QA-gate short-sentence false positives + QA-cost RTF telemetry

> Revised after three adversarial reviews (code fact-check, data re-derivation,
> design critique). Corrections from that round are marked _[rev]_ inline.

## Context

A multi-chapter Qwen **1.7B** render (Scepter of the Ancients, 2026-06-28) showed
**bimodal per-chapter RTF with "no logic why" — some chapters ~0.8, others 2+**.
Investigation of the box's own logs (`logs/server.log`, `logs/tts.err.log`) and the
book's per-segment QA artifacts (`.../audio/*.segments.json`, independently
re-derived: **7,154 segments**) established the cause with hard numbers.

- **Batched 1.7B synthesis is healthy** — `items=32 … rtf=0.48–0.86`, on the 0.49
  baseline; 16 GB eGPU peaked ~7.2/17 GB (no OOM). The model is fine.
- **Per-chapter `synth ÷ audio` RTF is batch-RTF diluted by re-records that run on
  the slow single-synth path** (`qwen synth … rtf=5–7` vs batched ~0.7). A lone
  re-record routes to `kind:'single'` (`synthesise-chapter.ts:1377` —
  `slice.length === 1`), and produces correct-length audio at the dispatch-bound
  floor.
- **The re-records are overwhelmingly QA false positives.** Of **175 total flags**
  (121 ASR drift + 51 "suspiciously long" + 3 near-silent), **~96–98 % are false
  positives** (the 51 long-flags are 100 % FP — all WER 0.00; ~117/121 drifts are
  ASR artifacts). Breakdown:
  - **ASR content-QA** (`segment-asr-qa.ts`): **121 drift**. **95/121 fire on
    2-word references** — one ASR error on a 2-word ref = WER 0.5 > the 0.4 cap.
    **78/121 are word-split INSERTIONS** ("Skulduggery"→"Skull Duggery",
    "insubordinate"→"in subordinate", "straightforward"→"Straight forward") — pure
    ASR mis-segmentation, never a TTS defect. 14 are single substitutions
    (homophones / mangled names: "nodded"→"Notted", "Valkyrie"→"Volkery"), 29 are
    multi-edit (mostly real garble or genuine repetition). **0 deletions among
    single-edit drifts; 0 `longestDeletionRun ≥ 3` and 0 truncation flags in the
    entire book.**
  - **Signal duration-QA** (`segment-qa.ts`): **51 "Suspiciously long — possible
    runaway"**. **All 51 rendered 0.8–2.5 s** (normal short utterances) and were
    flagged only because `expectedSec = chars / 14` predicts an impossible
    0.21–0.64 s for a one-word line ("Oh." → 0.21 s; ratio up to 8.2). **0 real
    runaways.**
  - **Near-silent** _[rev — newly surfaced]_: **3** segments (RMS 0.0, 0.32 s, empty
    transcript). A third flag class neither original fix touched; likely intentional
    inter-line pads — see Open Question 4.

**Unified root cause:** the ASR drift verdict has **no minimum-reference-length
floor** and the duration gate has **no absolute-length floor**, so both
systematically false-positive on short sentences / dialogue tags. ~**172 wasted
re-records**, each a single-synth at RTF ~6 × up to 2 takes; the volume scales with
dialogue-tag density — which is exactly why per-chapter RTF is bimodal "with no
logic." Neither gate is catching anything real in these cases.

**Operator constraint (hard):** recover RTF **without removing the quality checks** —
they catch real truncation / runaway / wrong-words / repetition defects. Fix the
gate *logic* where it mis-fires; do **not** disable the gate.

## Goals

1. Eliminate the short-sentence QA false positives in both gates with **zero loss of
   real-defect detection** (a dropped word, a repetition, a multi-error garble, a
   genuine runaway all still caught).
2. Make QA cost **observable**: surface the re-record cost (the part the fix moves)
   next to RTF in the admin tables.

## Non-goals (deferred)

- The single-synth RTF-6 floor itself (anchors + lone re-records can't amortize).
- The host-memory leak / committed-ceiling recycles (`side-11`).
- `ASR_DEVICE` placement — stays `cuda` (CPU would feed the host-memory ceiling).
- The `SEG_SPK_*` gate — untouched (flag-only, `SEG_SPK_AUTO_REPAIR=0`; not a
  re-record source; provides unique voice-drift detection).

---

## PR-1 — Gate-logic fixes (the RTF win) _[rev: split into its own PR]_

Server/`tts`-scoped bug fix, regression tests only. Ship first. Pure-function
changes, unit-testable without a sidecar.

### A1 — Duration gate: absolute-length floor (floor ALONE) _[rev: dropped the overhead term]_

A render is a "runaway" only if long in **absolute** terms; a ratio over a
sub-second `expectedSec` is meaningless. **Single change:** gate the
`maxDurationRatio` branch behind an absolute floor — never flag "suspiciously long"
when `durationSec < MIN_RUNAWAY_SEC` (default ~3 s; all 51 FPs are < 2.5 s, every
real runaway is ≫ 3 s).

- _[rev — C1]_ Do **NOT** add a fixed-overhead term to `expectedSec`: it feeds the
  *same* expression both branches divide by (`segment-qa.ts:143`), so it would lower
  the truncation ratio and make the `minDurationRatio` branch false-trip on fast
  short lines. Floor-alone leaves the truncation branch genuinely untouched.
- New `SegmentQaThresholds.minRunawaySec` + registry knob `qa.seg.minRunawaySec`.
- Residual blind spot (note, don't fix): a *short-absolute* runaway (model loops
  "no no no" for 2.8 s on a 1-word line) slips under the floor; the **ASR gate
  backstops it**, and none occur in the corpus.

### A2 — ASR gate: fix word-split bridging + phonetic name tolerance _[rev: completely reshaped]_

The original A2 (Levenshtein-≤1 name tolerance + "≥2 errors on ≤6-word sentences")
is **dropped** — the blanket short-sentence floor would mask a single *deletion*
(negation flip "I did not see" → "I did see"; C2), and Lev≤1 misses the
"Valkyrie"→"Volkery Kane" family (data analyst). Replace with two root-cause changes,
both safe because they only neutralise provable ASR artifacts (a word-split or a
name mishearing is never a TTS content defect):

- **A2a — fuzzy `bridgeCompounds`** (`segment-asr-qa.ts:290`). Today it rejoins an
  adjacent transcript pair to a reference token only on **exact** concatenation
  match, so `skull`+`duggery` → `skullduggery` ≠ `skulduggery`. Extend it to bridge
  when the concatenation is within **edit-distance ≤ 1** of the aligned reference
  token. Clears the **78 word-split insertions** at the source — the single
  highest-leverage change, and `bridgeCompounds` exists for exactly this.
- **A2b — phonetic / fuzzy name-allowlist tolerance**. The `allow`-set match is
  exact (`:479`), so "Valkyrie"→"Volkery", "Scapegrace"→"Scape a grace" never
  tolerate. Match an allowlisted cast name by a phonetic key (e.g. metaphone) or a
  length-relative edit-distance, not exact. Clears the name-homophone subs.
- _[rev — C2]_ **No blanket single-error suppression.** A deletion of a non-name word
  ("not"), or a substitution that is neither a split nor a name-variant, still
  counts → a genuine short-line semantic defect still flags. Verified against the
  corpus: the real defects (repetition on 8-word ref, multi-error garbles) all
  survive A2a+A2b.
- _[rev]_ A `qa.asr.minRefWords` evidence floor is held as an **optional backstop
  only** (Open Question 2): if A2a+A2b leave a homophone-sub tail on 2-word refs,
  consider routing a *single residual substitution* on a ≤2-word ref to
  `inconclusive` — but **never** a deletion (preserves negation-flip detection).

### A1/A2 testing (TDD; cases from the real corpus)

- A1: 1.0 s render of "Oh." → `ok`; **a slightly-fast 0.25 s "Oh." stays `ok`**
  (C1 regression — truncation branch unmoved); 60 s render of a short line → still
  `runaway` (floor); 0.1 s render of a long line → still `truncated`.
- A2: `"Skulduggery froze"` heard `"Skull Duggery Froze"` → `ok` (A2a);
  `"Valkyrie Cain"` heard `"Volkery Kane"` → `ok` (A2b);
  **`"I did not see you"` heard `"I did see you"` → still `drift`** (C2 — deletion);
  `"Please be alright. Please be alright."` (repetition, 8-word ref) → still `drift`;
  a multi-error garble → still `drift`.

### Affected files (PR-1)

- `server/src/tts/segment-qa.ts` (A1) + `segment-qa.test.ts`
- `server/src/tts/segment-asr-qa.ts` (A2a/A2b) + `segment-asr-qa.test.ts`
- `server/src/config/registry.ts` (`qa.seg.minRunawaySec`, optional
  `qa.asr.minRefWords`) + `.env.example` via `npm run config:sync`

---

## PR-2 — QA-cost telemetry + admin UI _[rev: separate PR; reshaped]_

Feature: sidecar + server + OpenAPI + frontend + e2e. Ships after PR-1.

### B1 — Split the re-record cost out of chapter wall

`synthesiseChapter` runs QA in three distinct timeable blocks: signal-QA re-record
rounds (`:1510`), the ASR re-record loop (`:1604`), the SPK embed pass (`:1646`,
`await`ed inline). Track and **return** from `synthesiseChapter`:
- `rerecordMs` — wall in QA-driven re-record synth (signal + ASR). **This is the
  metric A1/A2 actually move.**
- `transcribeMs`, `embedMs` — the **always-on** verify costs (every sentence
  transcribed at `sampleEvery=1`; every group ECAPA-embedded). _[rev — C4]_ these do
  **not** fall after A1/A2; they're the floor.

`recordChapterThroughput` gains a `rerecordMs`/`transcribeMs`/`embedMs` input;
`GenerationStats` exposes per-chapter **`rerecordRtf = rerecordMs / audioSec`** (the
headline QA column) and the always-on `verifyRtf`. _[rev — C4]_ The admin column is
**`rerecordRtf`**, narrative "QA re-record cost drops to ~0 after the fix; the
always-on verify floor remains."

_[rev — C3] Concurrency:_ `generationWorkers` (default 1, **max 4**) interleaves
chapter N's QA with N+1's synth into one **module-level singleton**, so summing
per-block ms over-counts wall and `rerecordRtf` is not physically meaningful when
chapters overlap. **Gate the QA split to `generationWorkers === 1`**; emit the QA
fields as `null` (rendered "n/a") otherwise. State this assumption in the module doc.

_[rev — H1] `synthMs` scope:_ today `synthMs` is captured in the route
(`generation.ts:1229/1547`) **after** `finalizeChapterAudioWrite`, so it includes
loudnorm encode + disk despite the doc claiming otherwise, and `synthesiseChapter`
does **not** return it. Fix: thread the QA sub-fields out of `synthesiseChapter`'s
return and capture synth wall **immediately after it returns** (excluding encode) so
the split is over a single coherent scope. Assert no double-count: every re-record
synth → `rerecordMs`, every transcribe (initial + re-verify) → `transcribeMs`, no
overlap (M3).

### B2 — Sidecar reload observability _[rev — downgraded; Finding 1 corrected the premise]_

`gen_ms` does **NOT** fold a routine model reload — the *primary* `_ensure_*_loaded()`
runs **before** `gen_start` in every Qwen path (`main.py:2647/2678/2763/2830`), so a
cold reload lands in the primary ensure (or in `load_ms` for the 1.7B-batch path),
already outside `gen_ms`. What `gen_ms` folds from `gen_start` is only the
`_synth_lock` wait + a warm-path no-op re-ensure. So the original "reload pollutes
RTF" premise is **false**; B2 is not an RTF fix.

Reframed, optional: emit a **required** `reload_ms` in the batch frame for
observability (it correlates with the deferred `side-11` recycles) — _[rev — M2]_
required, not optional, else reloads become *less* visible than today (where a
reload spikes `liveBatchRtf`). Confirm no sidecar test asserts `gen_ms` includes a
reload. **Defer if it adds scope** — it is not load-bearing for the RTF win.

### B3 — Admin tables

- _[rev — H3]_ The admin surface reads a **local** `GenerationStatsResponse` /
  `RecentChapter` interface in `src/lib/api.ts` (+ a hand-built mock at `:7575`),
  **not** generated `api-types.ts`. So: extend `openapi.yaml` **and** reconcile the
  local type + mock, or this won't render. `src/components/admin-pill.tsx` also
  consumes the shape.
- `GenerationThroughput` (`admin.tsx:387`): add a **"QA"** column (`rerecordRtf`)
  next to RTF + a summary stat. `ResourceTrends` (`:476`) _[rev: correct line; it has
  **no** summary row — uses a sparkline]_: add the `rerecordRtf` column only.
- _[rev — M5]_ Both grids hide columns below `md` (phone shows Chapter + RTF only).
  Decide the QA column's responsive behaviour per the 3-viewport mobile protocol.

### Affected files (PR-2) _[rev — H2: added the missing five]_

- `server/src/tts/synthesise-chapter.ts` (B1 timing + return) + test
- `server/src/routes/generation.ts` (owns `synthStartMs`/`synthMs` + the
  `recordChapterThroughput` call `:1544`) + test
- `server/src/tts/generation-stats.ts` (B1 fields) + `generation-stats.test.ts` +
  `routes/generation-stats.test.ts`
- `server/tts-sidecar/main.py` (B2, if kept) + `tests/test_batch_synthesis.py`
- `openapi.yaml` + `src/lib/api-types.ts` (`npm run openapi:types`)
- `src/lib/api.ts` (local stats type + mock), `src/views/admin.tsx` +
  `admin.test.tsx`, `src/components/admin-pill.tsx`
- One e2e admin spec (router/redux seam).

---

## C. Operator config (the box; `server/.env`, gitignored)

No code. Gates **stay on**; `ASR_DEVICE=cuda` stays; `SEG_SPK_*` untouched. The
A1/A2 logic fixes remove the thrash, not a config rollback.

## Risks / mitigations

- **A2 over-tolerance.** A2a/A2b neutralise only word-splits and name-variants — both
  provably non-defects. Deletions, non-name subs, multi-error garble, compression
  /loop drift, and `looksLikeCalibrationBleed` all still flag. Verified no real
  defect in the corpus is masked.
- **A1 floor hiding a short runaway.** Defined-away by absolute length; ASR backstops
  the sub-3 s loop case; truncation branch untouched (floor-alone).
- **B1 attribution.** Gated to `workers===1`; per-block ms with asserted no-overlap;
  synth wall captured over a single scope (post-`synthesiseChapter`, pre-encode).

## Open questions

1. _[resolved]_ A1: floor alone, no overhead term (C1 + data).
2. A2 residual: do A2a+A2b alone clear enough, or add the `qa.asr.minRefWords`
   backstop (single *substitution* on ≤2-word ref → `inconclusive`, deletions exempt)?
   Decide after a corpus dry-run of A2a/A2b.
3. Name matching: metaphone/phonetic vs length-relative edit-distance for A2b — pick
   the lightest that clears the Valkyrie/Scapegrace family without a new dependency.
4. The 3 near-silent flags (0.32 s, RMS 0): intentional pads (exempt sub-0.5 s from
   the near-silent check) or a real defect to investigate? Out of PR-1 scope; confirm.
5. Per-language _[M4]_: `qa.asr.maxWer` already has per-language overrides; should
   `minRunawaySec` / any new ASR knob be per-language too? `QA_CHARS_PER_SEC=14` is
   English-calibrated — note but defer (floor-alone reduces its blast radius).

## Ship notes

_(to fill on ship: dates, SHAs, before/after per-chapter re-record counts + RTF on a
re-rendered chapter — per-chapter, not book-total, per L3.)_
