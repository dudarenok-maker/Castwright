# Attribution per-chapter progress: sentence count + honest ETA

**Date:** 2026-06-17
**Area:** G. Generation (analysis) — Stage 1 "Parsing and attribution"
**Updates regression plan:** `docs/features/216-analysing-local-analyzer-honesty.md`

## Problem

During Stage 1 ("Parsing and attribution") on the **local Ollama** path, a long
chapter is one ~9-minute model call. The per-chapter row gives the user no sense
of how far along that call is — it just emits a wall-clock silence-watchdog line:

```
Chapter 1/9 — 5m 0s elapsed, still waiting on the model.
```

On top of the missing progress, the per-chapter **time estimate is flaky**.
Across consecutive ticks on the *same* chapter the user has observed:

- `3:09 of ~15:13` (correct — per-chapter estimate)
- `2:28 of ~` (the estimate went missing — a bare `~` is rendered)
- a jump from ~15 min to ~3 hr and back (the **whole-stage** estimate leaking
  into the **per-chapter** row)
- elapsed time resetting to zero on page reload

The "still waiting" elapsed rows give "no indication of actual progress," and the
estimate is too unstable to trust.

## Goals

1. **A — Real content progress (headline).** Show how many sentences have been
   attributed in the running chapter: `Attributed ~247 of ~900 sentences` with a
   fraction bar that tracks it as the model streams.
2. **B — Honest, stable per-chapter ETA (backing).** Fix the three estimate bugs
   so the time line is trustworthy underneath the count.
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

## Approach

The Stage-2 response is one JSON object per chapter,
`{ chapterId, sentences: [ { id, characterId, text, emotion }, … ] }`, streamed
token-by-token. The existing Phase-1 `onChunk`
(`server/src/routes/analysis.ts:~3490`) already receives the cumulative text +
byte count; today nothing inspects it until the chapter finishes. We count
sentences *inside* that stream — no full JSON parse, no new model call.

### Three new pure functions (match existing `analysis.ts` style)

These mirror the existing `projectChapterEstMsFromOutput` /
`refineCastChapterEstMs` exported-pure-fn pattern, so each is unit-testable in
isolation:

1. `countSentencesHeuristic(body): number` — **denominator**. Reuses the existing
   paragraph→sentence splitter to pre-count a chapter's sentences when its
   `inFlight` slot is created. Approximate by nature (the model may merge/split),
   so it is always displayed with a leading `~`.
2. `countStreamedSentences(buffer): number` — **numerator**. Counts
   `"characterId"` occurrences in the cumulative streamed text (one per sentence
   object). Cheap incremental substring count. Edge: a literal `"characterId"`
   inside narrative text could miscount by a hair — acceptable because the
   denominator is already approximate.
3. `projectChapterEstMsFromSentences(elapsedMs, done, total): number | null` —
   **B layer**. Projects the chapter ETA from the *sentence* fraction once it is
   meaningful; returns `null` (keep prior estimate) when too early. The existing
   byte-based projection becomes the fallback; the start-of-chapter estimate the
   last resort.

### Data flow

- On each chunk: `slot.sentencesDone = countStreamedSentences(receivedText)`,
  clamped so the displayed total is `max(heuristicTotal, sentencesDone)` — the
  user never sees `247 of ~240`.
- The Phase-1 `live` SSE payload (`analysis.ts:~3360`) gains `sentencesDone` and
  `sentencesTotal` on each running chapter, alongside the existing
  `elapsedMs`/`estMs` (Phase 0's `sectionsDone/Total` proves the shape extends
  cleanly).
- On chapter completion the *actual* parsed sentence count is authoritative — no
  lingering estimate.

### The three B-layer bug fixes (each root-caused via systematic-debugging, fail-before/pass-after test)

1. **Empty estimate (`of ~` with no number).** `estMs` is null/undefined at
   render time (reconnect gap / between-chapters handoff). Fix: **hold the last
   good per-chapter estimate**; never emit `null`/blank. The renderer hides the
   `of ~X` clause entirely when no estimate exists rather than printing a bare
   `~`.
2. **15 min ↔ 3 hr flip.** A fallback path substitutes the whole-stage estimate
   (`stage2EstMs`) when the per-chapter estimate is briefly absent. Fix: the
   per-chapter ticker only ever shows a *per-chapter* number, clamped to the
   per-chapter band; the whole-stage estimate lives on the stage header only.
3. **Loses elapsed on reload.** On reload the SSE reconnects and elapsed resets
   instead of resuming from the running job's real `startedAt`. Fix: a fresh
   subscription to an already-running job reports elapsed from the original
   `startedAt`, not from reconnect time.

The estimate-stability fixes (1 & 2) are the same root cause the jitter exposes:
recomputing the estimate every tick and sometimes getting `null`/the wrong
fallback. Stabilising it — last-good-held, per-chapter-banded — is the fix.

## Display (`src/components/analysing/phase-card.tsx`, `LiveChapterTicker`)

New composed row:

```
Chapter 1/9 · Chapter 1
Attributed ~247 of ~900 sentences      [████████░░░░░░]
24 chars/s · last chunk 0s ago · 3:09 of ~15:13
```

Fallback before enough sentences have streamed (or denominator unavailable) —
keeps the throughput pulse:

```
Receiving response · 38% · 24 chars/s · last chunk 0s ago
```

- The bare **"still waiting on the model"** stops being the primary per-chapter
  line. The silence watchdog stays but only surfaces on a real stall (no chunk
  for N seconds → "waiting on the model — no output for 45s"), so it carries
  meaning when shown.
- `24 chars/s` and `last chunk Xs ago` are **always** present whenever output is
  streaming — required, not optional.

## Testing

**Server** (`analysis.test.ts` + colocated pure-fn tests):
- `countSentencesHeuristic` — known body → expected count; empty/whitespace → 0.
- `countStreamedSentences` — partial mid-token buffer returns a stable count; one
  per sentence object; empty → 0.
- `projectChapterEstMsFromSentences` — `null` when too early; sensible projection
  once meaningful; does not jitter.
- **Estimate stability** (regression, bugs 1 & 2): a tick sequence where the
  refine signal drops out keeps the last good per-chapter estimate — never blank,
  never a whole-stage-range value.
- **Reconnect** (regression, bug 3): a fresh subscription to a running job
  reports elapsed from the original `startedAt`.

**Frontend** (`phase-card.test.tsx`):
- Renders `Attributed ~247 of ~900 sentences` + fraction bar when fields present.
- Falls back to the byte `Receiving response · X% · …` line when sentence fields
  absent — chars/s still shown.
- **Never renders a bare `of ~`** (regression, bug 1).
- Chapter row never shows a whole-stage-range value (regression, bug 2).

**E2E** (`e2e/`): one analysing-view spec — the mock SSE simulation emits the new
sentence fields; the spec asserts the sentence line appears, chars/s is present,
and the per-chapter estimate stays within a per-chapter band across ticks (locks
the jitter fix at the redux/SSE/layout seam per CLAUDE.md testing discipline).

## Scope boundary

Stage 1 "Parsing and attribution", multi-chapter local Ollama path. Gemini
benefits via the shared `onChunk`. Regression plan 216 updated in the same diff
(these are honesty/estimate fixes squarely in its territory); no new plan doc.
