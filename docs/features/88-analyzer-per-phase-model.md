---
status: active
shipped: null
owner: null
---

# Pipelined two-model analyzer (Gemma cast + Gemini attribution, 10-chapter lag)

> Status: draft
> Key files: `server/src/analyzer/index.ts:106-210`, `server/src/analyzer/select-analyzer.ts`, `server/src/routes/analysis.ts:1323-1328`, `server/src/routes/analysis.ts:2031-2055`, `server/src/analyzer/rate-limit.ts:122`, new `server/src/analyzer/phase-watermark.ts`, `server/.env.example`, `docs/features/06-analyzer-gemini.md`
> URL surface: indirect — `#/books/<id>/analysing`; SSE stream emitted by `POST /api/books/:bookId/analyse`
> OpenAPI ops: none — env-var driven

## Benefit / Rationale

- **User (throughput):** Phase 1 attribution overlaps with Phase 0 cast detection instead of waiting for it. Today Phase 0 → Phase 1 is a hard wall (`analysis.ts:2031-2055`); a 30-chapter book waits for all 30 Phase-0 chapters to complete + the Phase 0b roster merge before any Phase 1 attribution begins. Pipelined, Gemini starts attribution on chapter 0 as soon as Gemma has finished chapter 9 (10-chapter lag satisfied) and the two run in parallel from then on. Because Phase 1 is `STAGE2_STRETCH = 5.0` × the wall-clock of Phase 0 per chapter, Gemini keeps churning long after Gemma finishes — so the wall-clock saved is roughly "Gemma's full Phase 0 time minus the 10-chapter lag."
- **User (quality):** Gemma's cast roster anchors the attribution. The 10-chapter MINIMUM lag ensures Gemini never attributes against a roster snapshot that lags Gemma's current view by less than 10 chapters of context. If Gemini catches up (e.g. Gemma is rate-limited or Gemini is unexpectedly fast), Gemini pauses on a back-pressure semaphore until Gemma pulls ahead again. Most major characters appear in the first 10 chapters of typical books, so by the time Gemini starts chapter 0 it's working against a ~10-chapter-thick roster — near-final for character coverage. Cast-matching drift is bounded, not eliminated.
- **Technical:** quota effectively doubled — gemma-4-31b-it's 1,500 RPD bucket and gemini-3.1-flash-lite's 500 RPD bucket are independent (`server/src/analyzer/rate-limit.ts:122` is already per-model). The pipeline lets both buckets advance simultaneously.
- **Architectural:** introduces a phase-watermark + back-pressure seam (`server/src/analyzer/phase-watermark.ts`) that future work can extend (per-character regen against partial roster, multi-tier model fan-out, etc.).

## Architectural impact

### Three env knobs

- `ANALYZER_PHASE0_MODEL` — default **`gemma-4-31b-it`**. Drives Phase 0a (cast detection) on every chapter.
- `ANALYZER_PHASE1_MODEL` — default **`gemini-3.1-flash-lite`**. Drives Phase 1 (attribution) on every chapter.
- `ANALYZER_PHASE1_MIN_LAG_CHAPTERS` — default **`10`**. Gemini's chapter K is dispatchable only when Gemma has *completed* chapter `K + LAG - 1` (i.e. Gemma's watermark `>= K + LAG`). The lag is a MINIMUM — if Gemini catches up, the back-pressure semaphore makes Gemini wait. Set `0` to release the lag constraint (pipelining still happens; Gemini just dispatches as soon as the per-chapter roster snapshot exists for its chapter).

Fall-through: if none of the three env vars are set → falls back to today's single-model `ANALYZER=…` resolution AND today's sequential phase-gate behaviour. This is the regression case the test suite pins.

### Phase watermark + back-pressure semaphore

New module `server/src/analyzer/phase-watermark.ts` exposes:

- `markPhase0ChapterComplete(chapterIndex)` — Gemma's Phase 0 workers call this on each chapter completion. Monotonic increment of the watermark.
- `markPhase0AllDone()` — called after Phase 0b roster consolidation finishes; releases the lag constraint entirely so any remaining Gemini chapters can dispatch immediately against the final roster.
- `awaitPhase1Dispatch(chapterIndex)` — Gemini's Phase 1 workers `await` this before dispatching their chapter; resolves when `watermark >= chapterIndex + LAG` OR `phase0Done === true`. If the condition isn't satisfied at call time, the worker parks on an internal `EventEmitter` / promise-resolver; new watermark events re-evaluate all waiters.

The watermark is monotonic; the back-pressure check fires every time the watermark advances. **If Gemini catches up** (e.g. Gemma stalled on rate limit; Gemini's already-dispatched workers complete fast; the next Gemini chapter's lag constraint is no longer satisfied), `awaitPhase1Dispatch` blocks until Gemma's next chapter completes. This is the "keep 10 chapters between them" semantic the user asked for.

### Roster shape change

Today: Phase 0b runs once at the end of Phase 0, producing the final roster. Phase 1 reads this final roster.

Pipelined: Phase 0b merging happens incrementally — each Gemma chapter's character detections are folded into a *rolling roster* on completion. Each Gemini worker takes a snapshot of the rolling roster at dispatch time and attributes against that snapshot.

After Gemma finishes its last chapter, Phase 0b runs once more for the final consolidation (resolves any cross-chapter aliases that the rolling merge missed — e.g. "Mom" vs "Mother" disambiguation). The final roster supersedes the rolling roster; any Gemini chapters dispatched *after* `markPhase0AllDone()` use the final roster.

### Late-character drift handling (v1: pragmatic)

If Gemma identifies a character first in chapter 20, Gemini's chapter 5 (dispatched against a rolling-roster snapshot taken when Gemma's watermark was 15) won't have that character in its candidate set — some sentences spoken by that character may be attributed to `narrator` / unknown.

**v1 is pragmatic:** the 10-chapter lag covers the typical case (major characters appear early in the book). Residual drift for late-introduced characters is documented as a known limitation. The phase-watermark seam already knows which chapters dispatched against which roster snapshot, so a future reconciliation pass can rewrite them — that's deferred as out-of-scope here.

### Migration / reversibility

- Removing the new env vars entirely reverts to today's sequential behaviour (single-model `ANALYZER=…`, hard phase gate).
- Setting `ANALYZER_PHASE1_MODEL` equal to `ANALYZER_PHASE0_MODEL` is valid — pipelines on a single model; still gains throughput from running Phase 1 chapter K while Phase 0 chapter K+10 is in flight.
- The phase gate at `analysis.ts:2031-2055` is **replaced** by the watermark seam, not preserved.

## Invariants to preserve

- Plan 04 SSE event shape unchanged. Analysing-view consumer doesn't care that Phase 0 and Phase 1 are now interleaved on the wire — events still carry chapter id + phase id, so the per-phase progress bars stay coherent.
- Plan 06 manual handoff flow (`ANALYZER=manual`, `server/handoff/`) — when manual, the pipeline collapses to today's sequential behaviour. The manual cowork loop fundamentally can't pipeline (waits for human input between phases). Detect this case and short-circuit the watermark seam.
- Plan 29 local Ollama analyzer + fallback path unchanged. `FallbackAnalyzer` (`server/src/analyzer/index.ts:159-210`) keeps wrapping whichever analyzer is selected; local-unreachable → Gemini fallback continues to work per phase.
- Rate-limit buckets at `server/src/analyzer/rate-limit.ts:122` already per-model — concurrent two-model traffic gets independent buckets.
- Per [feedback_warmup_window_for_model_splits]: the 10-chapter constraint anchors attribution to the roster-author model's interpretive baseline. Reframed: the lag *is* the warm-up, but expressed as a runtime back-pressure rather than a per-chapter model selection.

## Test plan

### Automated coverage

- Vitest server (`server/src/analyzer/phase-watermark.test.ts`, new):
  - (a) `awaitPhase1Dispatch(0)` resolves once `markPhase0ChapterComplete` is called 10 times (default LAG).
  - (b) `awaitPhase1Dispatch(5)` resolves once watermark reaches 15.
  - (c) `markPhase0AllDone()` releases all pending waiters immediately, regardless of watermark.
  - (d) **Back-pressure (the user's "if Gemini catches up, slow it down" case):** simulate Gemma's watermark stalling at 12; dispatch Gemini chapters 0, 1, 2 (all satisfied because watermark=12 >= chapter+10); Gemini chapter 3 must wait (12 < 3+10=13); when `markPhase0ChapterComplete(13)` fires, chapter 3 dispatches; chapter 4 stays pending until watermark=14.
  - (e) `MIN_LAG_CHAPTERS=0` makes chapter K dispatchable as soon as Phase 0 chapter K is marked complete.
  - (f) Watermark is monotonic — `markPhase0ChapterComplete(5)` followed by `markPhase0ChapterComplete(3)` keeps watermark at 5 (out-of-order completion is tolerated; never regresses).
- Vitest server (`server/src/analyzer/select-analyzer.test.ts`, new):
  - Phase 0 work always returns the Phase-0 analyzer.
  - Phase 1 work always returns the Phase-1 analyzer.
  - Legacy single-model `ANALYZER=…` env keeps working when none of the new vars are set (regression).
- Vitest server (`server/src/routes/analysis.test.ts`, extend):
  - End-to-end pipelined flow on a mock book — Phase 0 watermark advances, Phase 1 workers fire as their lag is satisfied, final consolidation runs, all Phase 1 chapters complete.
  - Rolling roster snapshot: Gemini worker for chapter 5 reads a snapshot containing Gemma's chapters 0–14 (snapshot taken at dispatch time when watermark=15).
  - Manual handoff regression: `ANALYZER=manual` collapses to sequential phase gate (watermark seam short-circuited).
- Vitest server (`server/src/analyzer/rate-limit.test.ts`, extend if needed): limiter counters split correctly when both models are in flight simultaneously (Gemma + Gemini concurrent calls); two independent buckets advance without cross-decrement.

### Manual acceptance walkthrough

1. **Reboot** for clean GPU/process state per [feedback_reboot_before_perf_baselines].
2. **Default-run on the canonical manuscript** (`C:\Users\dudar\Downloads\Bonus Keefe Story.txt`): all three env knobs at defaults. Watch telemetry:
   - Gemma chapter 9 completes (`gemma.phase0.chapter=9 watermark=10`); within ~50 ms Gemini chapter 0 dispatches (`gemini.phase1.chapter=0 roster_snapshot_size=10`).
   - Gemma and Gemini chapters interleave in the SSE stream from that point on.
   - Gemma finishes its last chapter + Phase 0b consolidation; Gemini still has N - lag_release_point chapters left.
   - Gemini continues solo; each remaining chapter logs `roster_snapshot=final`.
   - Quota counters: gemma's bucket and gemini's bucket advance independently; no cross-decrement.
3. **Back-pressure observable test:** rate-limit Gemma artificially (e.g. via a `GEMINI_RPM=2` style env override on the Gemma model) so Gemma stalls mid-book. Gemini should NEVER catch up within 9 chapters of Gemma's watermark. Telemetry should show occasional `gemini.phase1.chapter=K backpressure_wait_ms=…` log lines when Gemini hits the semaphore.
4. **Attribution spot-check vs prior single-model baseline:** chapters 1, 10, 25, last-3. Quality should be at least as good as today's single-Gemini run; ideally better in early chapters because the roster is anchored to Gemma's interpretive baseline.
5. **Lag-zero force-pipeline:** `ANALYZER_PHASE1_MIN_LAG_CHAPTERS=0` — Gemini's chapter K dispatches as soon as Gemma's chapter K is marked complete (1-chapter rolling lead). Use only for empirical comparison; expect more cast-matching drift in early chapters.
6. **Legacy regression:** unset all three new vars + set `ANALYZER=gemini` → identical to today's single-model sequential run (no telemetry split, no watermark seam engaged).
7. **Manual handoff regression:** `ANALYZER=manual` → pipeline collapses to today's sequential phase-gate behaviour (the file-drop cowork loop can't pipeline). Verify by walking through the `server/handoff/inbox/` → `server/handoff/outbox/` exchange.

## Out of scope

- **Full reconciliation pass** for characters first discovered in late Phase 0 chapters — pragmatic v1 accepts residual drift; spin off to a fresh BACKLOG entry if empirical testing shows the residual bites.
- **B4 — per-call local→Gemini overflow** (route partial load when local is slow) → stays at BACKLOG Could (renumbers after this re-scope removes the now-superseded B2 entry).
- **Multi-tier model fan-out** (e.g. three models, three phases) — single-axis pipeline only in v1.
- **A1 — parallel chapter synthesis** → plan 87 (parallel branch).
- **C2/C3/C5 — frontend perf bundle** → plan 89 (parallel branch).

## v1 status note (2026-05-21)

The watermark + per-phase analyzer modules land here with the route layer fully wired to call `markPhase0ChapterComplete(K)` on every cast completion, `markPhase0AllDone()` after Phase 0b consolidation, and `await watermark.awaitPhase1Dispatch(K)` before every Phase 1 chapter dispatch. The Phase 1 worker pool also uses a SEPARATE analyzer instance keyed to `ANALYZER_PHASE1_MODEL` when set — so the quota split (Gemma 1,500 RPD bucket for Phase 0, Gemini 500 RPD bucket for Phase 1) is real and active today.

The route layer still runs Phase 0 → Phase 0b → Phase 1 serially at the code-flow level; the `awaitPhase1Dispatch` waiters all resolve trivially as Phase 0b completes (the watermark already passed every chapter's lag horizon before Phase 1 dispatches begin). The seam is in place to launch the two pools concurrently — a follow-up PR can wrap the Phase 0 cast pool in a Promise and dispatch Phase 1's pool in parallel, at which point the back-pressure semaphore activates end-to-end and Phase 1 starts attributing chapter 0 ~10 chapters into Phase 0's run.

Track the follow-up under `docs/BACKLOG.md` "Pipelined Phase 0+1 concurrent execution" (Could bucket).

## Ship notes

_(filled when status flips to `stable` — shipped date, commit SHA, observed wall-clock and quota delta on the canonical manuscript; especially the Gemma-finish-to-Gemini-finish gap which is the headline pipelining win)_
