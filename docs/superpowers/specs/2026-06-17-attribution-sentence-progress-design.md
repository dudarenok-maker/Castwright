# Attribution per-chapter progress: sentence count + honest ETA

**Date:** 2026-06-17
**Area:** G. Generation (analysis) — Stage 1 "Parsing and attribution"
**Updates regression plan:** `docs/features/216-analysing-local-analyzer-honesty.md`
**Revision:** v2 — rewritten after an adversarial review (three code-grounded
probes) overturned the v1 single-stream assumption and the reload diagnosis. The
changed sections are marked **[v2]**.

## Problem

During Stage 1 ("Parsing and attribution") on the **local Ollama** path, a long
chapter is many minutes of model work. The per-chapter row gives the user no
sense of how far along it is — it just emits a wall-clock silence-watchdog line:

```
Chapter 1/9 — 5m 0s elapsed, still waiting on the model.
```

On top of the missing progress, the per-chapter **time estimate is flaky**.
Across consecutive ticks on the *same* chapter the user has observed:

- `3:09 of ~15:13` (correct — per-chapter estimate)
- `2:28 of ~` (the estimate went missing — a bare `~` is rendered)
- a jump from ~15 min to ~3 hr and back (the **whole-stage** estimate leaking
  into the **per-chapter** row)
- elapsed time appearing to reset on page reload

The "still waiting" elapsed rows give "no indication of actual progress," and the
estimate is too unstable to trust.

## Goals

1. **A — Real content progress (headline).** Show how many sentences have been
   attributed in the running chapter: `Attributed ~247 of ~900 sentences` with a
   fraction bar that tracks it as the model streams.
2. **B — Honest, stable per-chapter ETA (backing).** Fix the estimate bugs so the
   time line is trustworthy underneath the count.
3. **Keep the throughput pulse.** `24 chars/s · last chunk 0s ago` stays in the
   row — it is the model's **speed** indicator and the liveness signal, and is
   explicitly required to remain visible in the new design.

## Non-goals (follow-ups, not this change)

- Phase 0 cast detection — already has section-level progress; untouched.
- The subset re-analyse path (banded progress, plan 184) — same idea could apply
  later; different code path, filed as a follow-up, not widened into this change.
- Smoothing the **whole-book** stage bar with the in-progress chapter's fraction
  — deferred (keeps the change surgical). Revisit if desired.
- Gemini-specific work — Gemini rides the same `onChunk` contract, so it benefits
  for free; the headline win is the slow local path.

## Key implementation facts established by review

- **Schema** (`server/src/handoff/schemas.ts:117`): each sentence object is
  `{ id, chapterId, characterId, text, confidence?, emotion? }`, `.strict()`.
  `characterId` is required and appears exactly once per sentence as a key.
- **Chunking** (`server/src/analyzer/stage2-chunk.ts:41`): a chapter over the
  Stage-2 char budget (**~9,000 chars**, smaller per local context window) is
  split into **multiple sections, each a separate model call**. The 112k-char
  motivating chapter is ~12+ sections, *not* one stream.
- **Per-section buffer reset** (`ollama.ts:565`, `gemini.ts:524`): `buf` is
  re-initialised to `''` at the start of **each** section's `generate()`. So
  `onChunk.receivedText` only ever holds the **current section**, never the whole
  chapter.
- **Completed sections carry exact counts**: the chunker stitches per-section
  `sentences[]` arrays and renumbers ids (`stage2-chunk.ts:245`), so each finished
  section yields an exact `sentences.length`.
- **Sticky job** (`analysis.ts:1627`, reattach at `:2003`): analysis runs
  detached in a background job keyed by manuscript id; a page reload re-POSTs,
  hits the *subscribe* path, and **the analyzer keeps running** — it is never
  aborted on disconnect. The server already computes `elapsedMs = now -
  startedAt` from a persisted `startedAt` (`:894`).

## Approach

### Numerator — section-accumulated sentence count **[v2]**

The v1 plan ("count `"characterId"` in the cumulative chapter buffer") is wrong:
the buffer resets per section, so a single counter would climb then snap to zero
~12 times. Instead the numerator is **committed + in-flight**:

```
sentencesDone = committedSentences + inflightSentences
```

- `committedSentences` — running sum of **completed sections' exact
  `sentences.length`**. Free: the chunker already parses each section.
- `inflightSentences` — marker count in the **current section's** buffer only
  (bounded to ≤ ~9k chars ≈ ≤ ~150 sentences).

This requires Stage-2 to track section completion, which it does **not** today
(Phase-0 cast detection does, at `analysis.ts:2717`). The chunker
(`runChunks`/`attributeSpan` in `stage2-chunk.ts`) gains an `onSectionDone(index,
sentenceCount)` hook so `analysis.ts` can accumulate, plus `sectionsDone` /
`sectionsTotal` on the in-flight slot (mirroring Phase 0).

Because completed sections are exact, the fragile marker count only ever applies
to one bounded in-flight section — its worst case is off-by-a-few within a single
section, invisible against a chapter total.

**Interface deltas (the plumbing the review flagged as unspecified) [v2].**
The chunker pre-splits a chapter into `chunks` before any streaming
(`stage2-chunk.ts:250`), so `sectionsTotal` and each section's char length are
known up front. Concretely:
- The Stage-2 chunk run options gain `onSectionDone(index: number,
  sentenceCount: number)`, invoked right after each `attributeSpan` returns its
  parsed `SentenceOutput[]` (the seam exists — the caller already holds
  `result.length`).
- The pre-split per-section char lengths are handed to `analysis.ts` when the
  in-flight slot is built (so `remainingChars` = sum of not-yet-completed
  sections is derivable locally — no need to thread it through every `onChunk`).
- The Phase-1 `InFlight` slot (`analysis.ts:3335`) gains: `committedSentences`,
  `inflightSentences`, `sectionsDone`, `sectionsTotal`, `sectionCharLengths`,
  and `inSentenceMode` (see hysteresis, below).

### Marker robustness **[v2]**

`inflightSentences = countStreamedSentences(currentSectionBuffer)` counts the
full key token **`"characterId":`** (with colon), not the bare substring.
- **Key-order instability is a non-issue for a count** — order changes *when* the
  token streams, not *how many* appear; a count is order-invariant.
- **Value contamination** (a `text` value literally containing `"characterId":`)
  is real but negligible: bounded to one section, against an already-approximate
  denominator. If on-box testing shows it matters, the escape hatch is
  depth-aware object counting (count `}` closes at array depth) — more code, held
  in reserve, not in v1.

### Denominator — self-calibrating **[v2]**

`countSentencesHeuristic(body)` (reuse the paragraph→sentence splitter) seeds the
denominator, shown with a leading `~`. But a static heuristic can undershoot
(bar caps below 100%, then snaps to done) or overshoot. Once ≥1 section has
completed we have **observed sentences-per-char**, so the denominator refines to
`committedSentences + observedRate × remainingChars` — matching the codebase's
existing self-calibration ethos (`currentOutputRatio`). The displayed total is
always `max(refinedTotal, sentencesDone)` so the count never exceeds its own
denominator. On chapter completion the real total is authoritative.

**Graceful degradation [v2].** Denominator *refinement* is an enhancement, not a
dependency: if `sectionCharLengths` / `remainingChars` are unavailable (e.g. a
single-section chapter, or the plumbing lands in a later wave), the static
`countSentencesHeuristic` denominator is used unchanged. The headline count still
works; it is just less self-correcting.

### ETA (B layer)

`projectChapterEstMsFromSentences(elapsedMs, done, total): number | null` —
**new function** (none exists today; Phase-1 currently estimates only via
`projectChapterEstMsFromOutput` at `analysis.ts:3426`). Projects the chapter ETA
from the **sentence fraction** once meaningful; returns `null` when too early.
Guard thresholds reuse `projectChapterEstMsFromOutput`'s constants
(`MIN_REFINE_ELAPSED_MS` = 8 s) plus a **meaningful-fraction floor** (`done/total
≥ ~0.02`, matching the byte projector's 2% guard) and `done ≥ 1`. The
estimate-selection precedence per tick:

1. `projectChapterEstMsFromSentences` (semantic — preferred),
2. else `projectChapterEstMsFromOutput` (byte fallback — existing),
3. else the **last good** per-chapter estimate (never blank),
4. else the start-of-chapter estimate.

**Estimate band [v2].** Whatever the source, the result is clamped to a
*per-chapter* band: a floor that always sits just above `elapsed` (so it never
reads "over budget"; reuse the `refineCastChapterEstMs` floor idiom) and a
ceiling that is **never the whole-stage `stage2EstMs`**. The overage-growth
behaviour is preserved — the estimate may grow when a chapter runs long; it just
may not blank, may not collapse below the floor, and may not jump to the stage
total. This reconciles "hold last good" with the existing overage machinery
rather than replacing it.

### Data flow

- Per chunk: update `slot.inflightSentences` from the current buffer;
  `slot.sentencesDone = committedSentences + inflightSentences`.
- Per section completion: `committedSentences += section.sentences.length`;
  `slot.sectionsDone += 1`; reset in-flight for the next section.
- The Phase-1 `live` SSE payload (`analysis.ts:~3360`) gains `sentencesDone`,
  `sentencesTotal`, `sectionsDone`, `sectionsTotal` on each running chapter,
  alongside the existing `elapsedMs` / `estMs`.

### The estimate / reload bugs **[v2 — #3 re-diagnosed]**

Each root-caused via systematic-debugging with a fail-before/pass-after test.

1. **Empty estimate (`of ~` with no number).** `estMs` is null/undefined at
   render time. Fix is the precedence + band above: the server never emits a
   null per-chapter estimate, and the renderer hides the `of ~X` clause entirely
   if one is ever absent rather than printing a bare `~`.
2. **15 min ↔ 3 hr flip.** The whole-stage estimate is leaking into the
   per-chapter row. Fix: the band's ceiling forbids the stage value in the
   chapter row; the whole-stage estimate lives only on the stage header. *(The
   exact leak site is to be pinned during implementation — the fix is enforced
   structurally by the band regardless.)*
3. **Reload elapsed — re-diagnosed.** The v1 cause ("frontend loses `startedAt`,
   resets to zero") is **contradicted by the code**: the job is sticky and the
   server keeps sending correct `elapsedMs`. The probable real cause is that
   **`replayCatchUp`'s reconnect snapshot omits the in-flight chapter's live
   rows**, so the row is blank/zero until the next phase tick lands. Fix:
   **reproduce the reload first**; if confirmed, include the current in-flight
   chapter rows (with their server-side elapsed) in the replay snapshot. Do not
   ship the v1 "frontend timer" fix.

## Display (`src/components/analysing/phase-card.tsx`, `LiveChapterTicker`)

New composed row:

```
Chapter 1/9 · Chapter 1
Attributed ~247 of ~900 sentences      [████████░░░░░░]
24 chars/s · last chunk 0s ago · 3:09 of ~15:13
```

**Display-mode threshold [v2].** The row shows the sentence headline once the
sentence signal is trustworthy — defined as **≥1 completed section OR
≥ N in-flight markers** (N small, e.g. 5). Before that it shows the byte-based
fallback. The switch is **one-way per chapter** (hysteresis): once a chapter is
in sentence mode it never reverts, so the display cannot flip-flop.

**Hysteresis state lives server-side [v2].** The `inSentenceMode` flag is set on
the Phase-1 `InFlight` slot (not in React state) the first time the threshold is
crossed, and is included in the live payload + the reconnect replay snapshot.
This is deliberate: a frontend-only flag would reset on reload and re-introduce
the byte-%↔sentence flip-flop — coupling it to the same server-side slot that
fixes bug #3 keeps the mode stable across a reattach.

Fallback (pre-threshold, or denominator unavailable) — keeps the throughput
pulse:

```
Receiving response · 38% · 24 chars/s · last chunk 0s ago
```

- The bare **"still waiting on the model"** stops being the primary per-chapter
  line. The silence watchdog stays but only surfaces on a real stall (no chunk
  for N seconds → "waiting on the model — no output for 45s").
- `24 chars/s` and `last chunk Xs ago` are **always** present whenever output is
  streaming — required, not optional.
- For a chunked chapter, `section 3/12` may also be surfaced as a coarse
  secondary signal (honest, exact).

## Testing

**Server** (`analysis.test.ts` + colocated pure-fn tests):
- `countSentencesHeuristic` — known body → expected count; empty/whitespace → 0.
- `countStreamedSentences` — partial mid-token buffer returns a stable count;
  counts the `"characterId":` token once per sentence; a `text` value containing
  the literal token is a known, documented off-by-one (assert the bound, not
  perfection); empty → 0.
- **Section accumulation [v2]** — a 3-section chapter: after section 1 completes,
  `committedSentences` = section-1 exact count; mid-section-2 the displayed count
  = committed + in-flight, and it **never decreases** across the section
  boundary (the anti-snap-back regression — the core v1 bug this revision fixes).
- `projectChapterEstMsFromSentences` — `null` when too early; sensible projection
  once meaningful.
- **Denominator refinement [v2]** — after a section completes, the denominator
  reflects observed sentences-per-char; `sentencesDone` never exceeds the shown
  total.
- **Estimate band [v2]** (regression, bugs 1 & 2): a tick sequence where the
  refine signal drops out keeps the last good per-chapter estimate; the emitted
  estimate is never `null`, never below the floor, never equal to `stage2EstMs`.
- **Reload replay [v2]** (regression, bug 3): a fresh subscription to a running
  job replays the in-flight chapter rows with server-side elapsed (write this
  test against the *reproduced* behaviour, not the assumed one).

**Frontend** (`phase-card.test.tsx`):
- Renders `Attributed ~247 of ~900 sentences` + fraction bar once in sentence
  mode (≥1 section or ≥N markers).
- Shows the byte `Receiving response · X% · …` fallback pre-threshold — chars/s
  still shown — and **does not revert** to it after entering sentence mode.
- **Never renders a bare `of ~`** (regression, bug 1).
- Chapter row never shows a whole-stage-range value (regression, bug 2).

**Testable estimate invariants [v2]** (replaces the vague "monotonic enough"):
across any tick sequence the per-chapter estimate (a) is never null/blank,
(b) never decreases by more than a set fraction tick-to-tick, (c) stays within
`[chapterFloor, chapterCeiling]`, (d) never equals the stage total.

**E2E** (`e2e/`): one analysing-view spec — the mock SSE simulation emits the new
sentence + section fields (including a section boundary), and the spec asserts
the sentence line appears, chars/s is present, the count does not snap backward
across the section boundary, and the per-chapter estimate stays within a
per-chapter band across ticks (locks the fixes at the redux/SSE/layout seam per
CLAUDE.md testing discipline).

## Scope boundary

Stage 1 "Parsing and attribution", multi-chapter local Ollama path. Gemini
benefits via the shared `onChunk`. Regression plan 216 updated in the same diff
(these are honesty/estimate fixes squarely in its territory); no new plan doc.

## Open item carried into implementation

Bug #3 (reload) ships **only after** the reload is reproduced on the box. If the
in-flight rows turn out to already be in the replay snapshot, the real cause is
elsewhere and #3 is re-scoped or dropped — it does not block the A/B work.
