# Script-review eval harness + baseline — design

> Status: draft (design thread)
> Parent: plan [265](../../features/265-attribution-eval-tuning.md) §2 non-goal — "Tuning the
> **LLM script-review** pass … Explicit **next phase**, layered on the *improved* attribution
> baseline." That baseline is now raised (deterministic-first #1752, Target C #1761, addressee-tag
> #1764 all merged), so this is that next phase.
> Sibling precedent: `docs/superpowers/specs/2026-07-20-attribution-eval-tuning-design.md` (the
> attribution eval this extends).
> **Revision note:** an assumption-checker pass killed the first design (reuse the line-level
> attribution scorer for a 4th stage) — it structurally scores a *correct* `split`/`strip_tag` as a
> regression and can't pair lines across segmentation change. This version uses a
> **segmentation-invariant char-level scorer** instead (user decision, option B).

## 1. Problem

The LLM **script-review** pass (`skills/audiobook-script-review.md`, driven by
`server/src/routes/script-review.ts`) is a per-chapter QA pass over *already-attributed*
sentences. It emits surgical edit ops in eight classes — `strip_tag`, `split`,
`extract_dialogue`, `merge`, `fix_emotion`, `validate_instruct`, `reattribute`,
`flag_nonstory` — applied through the manual-edit reducers.

Unlike attribution, **script-review has no eval harness**. Every attribution win this quarter rode
a number; script-review has only eyeball spot-checks. We cannot answer the question that decides
whether — and how — to tune it: **now that attribution is good, does the QA pass net-improve a
chapter, or fight the now-correct engine?** This is a measurement problem first; tuning direction
is unknown until the baseline number exists (§7).

## 2. Goals / non-goals

**Goals**

- Score the *real* script-review pass end-to-end against the golden fixtures with a
  **segmentation-invariant char-level attribution metric** that is sound across the ops the pass
  actually makes (`reattribute`, `split`, `extract_dialogue`).
- Produce a per-fixture **`final(char) → reviewed(char)`** delta plus a **helped / harmed** char
  breakdown (harmed = chars right before review, wrong after — the regression axis).
- **Eyeball coverage** of the attribution-neutral / un-scoreable classes (`merge`, `strip_tag`,
  `fix_emotion`, `validate_instruct`, `flag_nonstory`) via a by-class count + op dump.
- **Widen the corpus** with "silver" fixtures — untuned chapters of the same book, labelled by an
  independent stronger pass — for more fixture *coverage* (directional, not variance-reducing — see
  §3.6) and an end-to-end "improvement on a never-tuned chapter" demo.
- **Capture the baseline** (gold + silver, both engines, `--runs 3`) as the starting number and
  gate for the §7 tuning follow-up.

**Non-goals (this spec)**

- The actual tuning edits (§7) — designed once the baseline exists; tuning blind violates
  measure-first.
- Hard-scoring `fix_emotion` / `validate_instruct` / `vocalization` — no ground truth in the corpus
  (`LabelledChapter` = `{text, speakerId}` only). Counted + dumped, never scored.
- Retro-changing the existing **line-level** raw/det/final metric — the shipped attribution
  baselines are line-recall; those columns stay as-is for comparability. The char metric is a new,
  parallel track for the review comparison (§3.3).
- Promoting silver into the hard gate. Gate = gold ch43–46 + Coalfall; silver = directional only
  (§3.6).
- Any end-user runtime change. The harness *calls* production code; adds nothing to the default
  path.
- A CI job — same local-only, opt-in, triple-gated posture as attribution-eval / golden-audio.

## 3. Design

### 3.1 Faithful-to-production review invocation (fixes assumption-checker #3, #4, #6)

The eval must run the pass **the way production runs it**, or it measures a different pass. The
analyzer method `runScriptReviewChapter` is a *single LLM call over the prompt it is handed*; all
of the following live in the **route** (`runScriptReviewJob`/`reviewCore`, `script-review.ts`) and
must be mirrored by the harness:

- **Chunking.** `chunkSentencesByBudget` + `chapterChunkBudget(engine, …)` + cross-chunk
  `ownsOp`/`primarySentenceId` de-dup + the force-split-on-truncation recursion. For the cloud
  engines the baseline requires, budgets are finite/small — ch44 (328 sentences) chunks into
  several calls in production; a whole-chapter call would skip this entirely. **These four are
  already standalone exported pure functions** (`chapter-chunker.ts`) — the harness imports and
  calls them directly; nothing to extract.
- **Appliability gating.** Production applies only the ops `planApply`
  (`src/lib/script-review-apply.ts`) *accepts*: it rejects an anchor that doesn't resolve uniquely,
  a second structural op on the same sentence, a non-adjacent / mixed-speaker `merge`, an
  `extract_dialogue` with `end<=start`, and a `reattribute` to an id not on the roster; a
  `strip_tag` deterministically wins a same-id text collision. The eval must apply exactly this
  accepted set, or its op set is a superset of production's.
- **Prior-chapter exchange (fs-64).** Production feeds the prior chapter's final two-speaker
  exchange into chunk 0 so the model can resolve a tagless chapter-opening line. Each fixture
  therefore **captures that boundary exchange** (the prior chapter's attributed tail, read-only) so
  chunk 0 is production-faithful. Absent it, opening-line corrections are systematically
  under-measured.
- **Config.** Set `analyzer.structure.enabled` so the inbox carries the same `[structure: …]`
  hints production renders; otherwise the eval measures a different prompt.

**Reuse the pure pieces; do not extract the streaming orchestration.** The route's `reviewCore`
closes over ~10 pieces of live state (`AbortController`, SSE `send`, `heartbeat`, the
fallback-mutable `activeSelection`, `withPassEval`, ledger checkpointing, quota/block/abort
handling) — extracting it as a shared "driver" would be surgery on the most safety-critical route,
not measurement tooling. So the split is:

- **Reuse directly:** the already-pure `chunkSentencesByBudget` / `ownsOp` / `primarySentenceId` /
  `chapterChunkBudget` (above), and the `planApply` acceptance + `resolveAnchorOffset` /
  `normalizeForMatch` machinery from `script-review-apply.ts` (made server-importable — O-1).
- **Re-implement thin, in the harness:** only the **force-split review-core loop** (call the
  analyzer per chunk, `ownsOp`-filter, halve-and-retry on `AnalyzerTruncatedError`) — a small
  non-streaming function over the eval's own analyzer calls, with **no** SSE / ledger / fallback /
  pacing. It shares the *pure* budgeting/ownership/apply functions with production, so the op set
  it produces matches; the streaming choreography is legitimately route-only and is **not**
  duplicated. A `review-driver.test.ts` pins that the harness loop's owned op set equals the
  route's for a multi-chunk chapter (drift guard).

### 3.2 The char→speaker projection (the metric's foundation)

Both truth and a predicted sentence set are projected onto the chapter body:

```
projectToChars(chapterText, units: Array<{text, speakerId}>):
  { speakerByChar: (id|null)[]; spans: Array<{start, end, speakerId}> }
```

Walk `chapterText` once; for each unit in order, locate its text from the running cursor and assign
that original-text char span the unit's speaker. **Positional matching primitive:** use
`normalizeForMatch` + its `origEndForNormLen` index map from `script-review-apply.ts` (the same
primitive `resolveAnchorOffset` uses) — **not** the scorer's `normalise()`, which collapses
whitespace / strips brackets / deletes apostrophes and therefore has *no* positional correspondence
to `chapterText` (you cannot recover an original char offset from it). `normalizeForMatch`
deliberately preserves positions ("No whitespace collapse — it would desync positions") and its
index map translates a normalized offset back to an original one. The function emits **both** the
flat `speakerByChar` array **and** each unit's `{start, end}` span (the applier §3.4 needs per-unit
chapter-char boundaries to place a split/extract). Chars in no unit's span carry no speaker
(excluded from the denominator). Computed for:

- **truth** (`chapterText` + `lines`) → `truthSpeakerByChar`
- **`final`** predicted sentences → `finalSpeakerByChar`
- **`reviewed`** = `final` with the accepted attribution-changing ops applied (§3.4) →
  `reviewedSpeakerByChar`

Because it is keyed on **chapter-body character position**, segmentation is irrelevant: whether the
predicted side splits or merges a span, a char scores correct iff its predicted speaker matches
truth's. This is what makes `split`/`extract` scoreable (assumption-checker #1) and gives a stable
final↔reviewed pairing (assumption-checker #2) — the two char maps are the same length and directly
diffable.

### 3.3 Char-level metric + helped/harmed

- **`charRecall`** = (chars where predicted speaker == truth speaker, via the `canonicalId`
  aliasMap) / (chars with a truth speaker). Reported for `final` and `reviewed`; the headline is the
  **`final→reviewed` delta**.
- **Denominator + weighting (must be pinned).** The corpus truth `lines` cover the **whole
  chapter** (narration + dialogue — a fully-attributed chapter labels every sentence), so raw
  char-recall is char-weighted: one wrongly-reattributed 1500-char narration paragraph outweighs
  ten correctly-fixed 60-char dialogue lines. To keep the number aligned with *perceived* quality
  (a listener hears per-utterance, not per-char), the runner **also** reports a **per-truth-line
  char-recall** variant — average each truth line's own char-correctness, so a long narration span
  and a short dialogue line count once each. Both are segmentation-invariant (both key off the char
  projection); the per-line-averaged variant is the perceived-quality headline, raw char-recall the
  volume view. (Plan-time O-5: whether to weight by line or report both un-blended.)
- **helped** = chars wrong in `final`, right in `reviewed`. **harmed** = right in `final`, wrong in
  `reviewed` — **the regression axis** the §7 tuning drives down; the direct analog of the
  frozen-raw "changed lines" gate from #1764.
- **Expected shape of the number (set expectations up front).** Because the attribution baseline is
  now good, **most review ops are char-neutral** — `strip_tag`, `merge`, `fix_emotion`,
  `validate_instruct`, `flag_nonstory`, and same-speaker `split`s (the default
  `pieceCharacterIds ?? [char, char]`) change no span→speaker mapping and are unscored. So on the
  gold fixtures `helped ≈ harmed ≈ 0` is the **expected good outcome**: it means the QA pass is
  *not fighting the improved engine*. The char metric is therefore primarily a **regression guard**
  (keep `harmed` at 0), and the pass's real value (TTS-quality edits) lives in the **op-dump**
  (§3.5), which is counted and eyeballed, not scored. A large positive `final→reviewed` delta is
  *not* the target and would more likely signal the attribution baseline regressed than that review
  got better.
- The existing **line-level** raw→det→final columns are unchanged (§2 non-goal). The char track is
  reported alongside for the review comparison. `final` is scored **both** ways so the char metric
  has its own baseline point.
- **No family breakdown on `reviewed`** (assumption-checker #8): the `reasons` array is indexed to
  the `final` line stream and resegmentation breaks the 1:1 mapping. Reviewed reports char-recall +
  helped/harmed only.

### 3.4 The char-array applier (small, three ops)

At char granularity only three op classes change span→speaker. `reviewedSpeakerByChar` is a **copy
of `finalSpeakerByChar` mutated in place** by the accepted ops (§3.1) — it is **never** produced by
re-running `projectToChars` on post-op sentences (which could shift spans and break the equal-length
diff). Same length as `final` by construction, so §3.3's helped/harmed diff is a direct index-wise
comparison. The three mutating ops:

| op | char-array effect |
|---|---|
| `reattribute` | set the target sentence's whole span to the new speaker (roster id) |
| `split` | partition the span at the resolved piece boundaries; assign each sub-span its `pieceCharacterIds[i]` |
| `extract_dialogue` | the resolved `anchor…anchorEnd` sub-span → speaker; the remainder stays narrator |

`merge` (same-speaker → no char change), `strip_tag` (edits sentence text, not span ownership),
`fix_emotion` / `validate_instruct` / `flag_nonstory` → **not applied**; they go to the op-dump
(§3.5). Anchor→offset resolution reuses production's `resolveAnchorOffset`; an op whose anchor
doesn't resolve was already rejected by `planApply` acceptance (§3.1) and never reaches here.
Unit-pinned against hand-built cases.

**Off-roster `reattribute`** (assumption-checker #5): an op carrying `proposed` (speaker not on the
roster) can't be given a truth-matching id by a pure applier and the `rosterAliasMap` seam only
covers on-roster ids. v1 **dumps** off-roster reattributes (counted, not char-scored) with a stated
limitation, rather than scoring them wrong. (Plan-time O-2: optional per-fixture alias entry to
promote a known off-roster speaker into scoring.)

### 3.5 Op-dump (un-scoreable / attribution-neutral classes)

Per fixture: a by-class count + a dump `{id, op, rationale, anchor}` of every op not char-scored
(`merge`, `strip_tag`, `fix_emotion`, `validate_instruct`, `vocalization`, `flag_nonstory`, plus
dumped off-roster reattributes). Eyeball-triage surface for the classes with no ground truth —
counted and inspectable, never scored.

### 3.6 Silver corpus (widen the data)

- **Selection:** a profile scan over the book's untuned chapters recommends a small set (2–4); user
  confirms which/how many before labelling. Scan at capture time.
- **Labelling:** an **independent, stronger full-chapter pass** (whole chapter in context —
  deliberately *not* the chunked small-model production path) writes a `LabelledChapter` (+ captured
  prior-exchange, §3.1) into the git-ignored corpus, tagged silver.
- **Tagging:** filename/manifest marks silver so the runner reports it in a **separate block** and
  **excludes it from the hard gate**.
- **Confidence posture (user decision — silver, reported separately):** no per-line user
  spot-check. **Stronger caveat (assumption-checker #7):** the labeller and the pass are both LLMs
  over the same dialogue conventions and share systematic biases (last-speaker default, FID,
  quote-collision). "Reviewed moves toward silver" can therefore reward *shared error*, and
  correlated data does **not** reduce variance like independent data — so silver is **directional
  only**, never a gate, and a silver `helped`/`harmed` is read as "agrees/disagrees with a stronger
  model," not "correct/incorrect." Stated on every silver report line.

### 3.7 Run conventions & baseline capture

Opt-in, triple-gated (SKIP + exit 0), local-only corpus, `qwen36-cw-iq4-32k` local + cloud
(`gemma-4-31b-it` / `gemini-3.1-flash-lite`), `--runs 3` mean±range, Coalfall guardrail every run
(**note: now fires a real review LLM call per run — added latency/quota**, assumption-checker #9).
After the harness lands: capture the baseline on gold + silver, both engines, record in ship notes
+ memory. That number is what §7 is designed against.

## 4. Invariants to preserve

1. **Gold-only gate.** Hard no-regression gate = gold ch43–46 + Coalfall (char metric). Silver
   never blocks; reported separately, labelled directional.
2. **Same op set as production, without duplicating the route's orchestration.** The harness
   reuses the *pure* budgeting/ownership/apply functions (`chunkSentencesByBudget`, `ownsOp`,
   `primarySentenceId`, `chapterChunkBudget`, `planApply` acceptance, `resolveAnchorOffset`,
   `normalizeForMatch`) and re-implements only the thin non-streaming force-split review-core loop;
   the SSE / ledger / fallback / pacing orchestration is legitimately route-only and is **not**
   extracted. `review-driver.test.ts` pins the harness loop's owned op set == the route's for a
   multi-chunk chapter (§3.1).
3. **Shared apply/match logic, not re-hosted.** `planApply` acceptance, `resolveAnchorOffset`, and
   `normalizeForMatch` are reused from one source (made server-importable — O-1); a divergent copy
   is a measurement bug.
4. **Line-level raw/det/final unchanged.** Backward-compatible with shipped attribution baselines;
   the char metric is additive.
5. **Corpus local-only.** Silver fixtures are copyrighted → git-ignored, same as gold. Only Coalfall
   committed.
6. **Opt-in + triple-gated.** No model-touching command in `test:all` / `verify`.

## 5. Test plan (automated)

- `project-to-chars.test.ts` — `projectToChars` span mapping: contiguous lines, smart-quote /
  spacing tolerance, a dropped line (gap), repeated identical lines by different speakers.
- `char-score.test.ts` — `charRecall` + helped/harmed from hand-built truth/final/reviewed maps;
  aliasMap resolution; a `split` that assigns two speakers to two sub-spans scores as a lift (the
  case the old line scorer got wrong).
- `apply-review-ops-chars.test.ts` — the three-op char applier per class incl. anchor resolution;
  a rejected op (bad anchor / second structural op / off-roster reattribute) is a no-op on the map.
- `review-driver.test.ts` — the shared chunk-loop driver emits the same owned op set as the route
  for a multi-chunk chapter (guards against eval/prod drift).
- `run-eval.test.ts` — four stages scored; reviewed carries char-recall + helped/harmed, no
  byFamily; omitting review leaves line raw/det/final byte-identical.
- Gating unit — `runEval` returns `{skipped}` (never throws) with no corpus / engine down, review
  stage included.
- Live `npm run eval:attribution -- --review` runs are the opt-in runner itself, not gated.

## 6. Net-new / touched code

- New: `projectToChars` + `charRecall`/helped-harmed scorer (+ tests) — the segmentation-invariant
  metric.
- New: char-array applier for reattribute/split/extract (+ tests).
- Import-surface change (**no** route-behaviour refactor): make `planApply` acceptance +
  `resolveAnchorOffset` + `normalizeForMatch` server-importable from one source (O-1 — lift
  `src/lib/script-review-apply.ts`'s pure core to a shared module, or a `server` port validated
  equal by a shared test vector). The route is untouched; the eval re-implements only the thin
  non-streaming force-split loop and reuses the already-exported pure chunker functions directly.
- New: `review-driver.test.ts` — the harness loop's owned op set == the route's for a multi-chunk
  chapter (eval/prod drift guard).
- New: silver-labelling capture path (extend `capture-cli.ts` or a sibling; label *content*
  produced by the labelling agent, git-ignored, not committed).
- Touched: `run-eval.ts`/`run-eval-cli.ts` — reviewed stage, char track, helped/harmed, op-dump,
  silver partition, `--review` flag + columns; `export buildScriptReviewChapterInbox` if needed.
- No production runtime behaviour change (the route's extracted driver is behaviour-preserving).

## 7. Sequenced follow-up (out of this thread)

Once the baseline is captured, a separate design/plan tunes the pass against the number — candidate
levers informed by what the baseline shows (tighten `reattribute` to defer to the now-good engine
and drive `harmed` down; sharpen structural-op precision; adjust op-gates). Ships as its own
reviewed diff, gated by the `harmed` / `final→reviewed(char)` numbers — exactly how the attribution
tuning (#1752/#1761/#1764) rode the attribution-eval this extends.

## 8. Open questions (resolve at plan time)

- **O-1** where the shared review driver lives (a `server/src/analyzer/` module the route imports)
  and how `planApply`/`resolveAnchorOffset` become server-importable (lift `src/lib` → shared, vs
  a `server`-side port validated equal by a shared test vector).
- **O-2** off-roster `reattribute` — dump-only (v1) vs an optional per-fixture alias to score a
  known off-roster speaker.
- **O-3** silver fixture tagging mechanism — filename convention vs manifest flag.
- **O-4** char-projection of a predicted line whose text doesn't occur in `chapterText` at the
  expected cursor (analyzer paraphrase / segmentation drift) — skip (unmapped, excluded) vs
  best-effort fuzzy locate; must not silently mis-assign a span.
- **O-5** char-recall aggregation — report both raw (char-weighted) and per-truth-line-averaged
  (perceived-quality) headline, or pick one; and whether `harmed`/`helped` mirror the same split.
