---
status: draft
shipped: null
owner: null
---

# Analyzer per-phase model selection with attribution warm-up

> Status: draft
> Key files: `server/src/analyzer/index.ts:106-210`, `server/src/analyzer/select-analyzer.ts`, `server/src/routes/analysis.ts:1323-1328`, `server/src/analyzer/rate-limit.ts:122`, `server/.env.example`, `docs/features/06-analyzer-gemini.md`
> URL surface: indirect — `#/books/<id>/analysing`; SSE stream emitted by `POST /api/books/:bookId/analyse`
> OpenAPI ops: none — env-var driven

## Benefit / Rationale

- **User:** improves attribution accuracy on the harder reasoning task (Phase 1 — speaker attribution per sentence) by using a smarter model (`gemini-3.1-flash-lite`) for the bulk of the book, while keeping the first W chapters of Phase 1 anchored to the same model that built the roster (`gemma-4-31b-it`). This cuts the worst-case **cross-model attribution drift** — early-book misattributions that compound — without eliminating it. Per [feedback_warmup_window_for_model_splits], the warm-up window is a MUST when swapping models mid-book.
- **Technical:** quota effectively doubled. Phase 0 (`gemma-4-31b-it`, 1,500 RPD bucket, no TPM cap) and Phase 1 (`gemini-3.1-flash-lite`, 500 RPD bucket) run against independent rate-limit buckets that `server/src/analyzer/rate-limit.ts:122` already supports. Phase 0's load can't starve Phase 1 (and vice versa). Phase 1 is `STAGE2_STRETCH = 5.0` × the wall-clock of Phase 0 (`server/src/routes/analysis.ts:453`) per chapter, so optimising the smarter model on attribution is the bigger lever.
- **Architectural:** introduces a per-phase analyzer selection seam (`selectAnalyzerForPhase`). The seam is the prerequisite for both BACKLOG Could #23 (speculative per-chapter Phase 1 / B2) and BACKLOG Could #24 (per-call local→Gemini overflow / B4).

## Architectural impact

- **New seam:** `selectAnalyzerForPhase(phase, chapterIndex, opts)` returning the chosen `Analyzer` instance per three env knobs:
  - `ANALYZER_PHASE0_MODEL` — default `gemma-4-31b-it`.
  - `ANALYZER_PHASE1_MODEL` — default `gemini-3.1-flash-lite` (used only after the warm-up window).
  - `ANALYZER_PHASE1_WARMUP_CHAPTERS` — default `10`. Set to `0` to force-split from chapter 1.
- **Threading:** chapter index flows from the Phase 1 worker into the analyzer selection so each chapter's dispatch picks the right model. Phase 0a workers always use the Phase-0 model; Phase 1 workers with `chapterIndex < W` use the Phase-0 model (warm-up); Phase 1 workers with `chapterIndex >= W` use the Phase-1 model.
- **Rate-limit buckets** at `server/src/analyzer/rate-limit.ts:122` are already keyed per model — no changes needed; concurrent warm-up + post-warm-up calls don't compete.
- **Migration:** legacy single-model `ANALYZER=<engine>` env keeps working when none of the three new vars are set. Fall-through resolution: if `ANALYZER_PHASE{0,1}_MODEL` unset, both phases use today's `ANALYZER`-selected analyzer (Gemini / local / manual / fallback).
- **Reversibility:** unset the three new env vars to revert to today's single-model behaviour.

## Invariants to preserve

- Plan 04 SSE event shape unchanged (analysing-view consumer doesn't care which model produced a chunk).
- Plan 06 manual handoff flow at `server/src/routes/analysis.ts:2031-2055` (Phase 0 → Phase 1 phase gate) UNTOUCHED — this plan only changes which analyzer Phase 1 dispatches to, not when Phase 1 starts.
- Plan 29 local-Ollama analyzer + fallback path unchanged. When `ANALYZER=local` is set, `selectAnalyzerForPhase` returns the Ollama analyzer for both phases unless a phase-model override is set. The `FallbackAnalyzer` Gemini-on-`LocalUnreachableError` route at `server/src/analyzer/index.ts:159-210` continues to wrap the selected analyzer.
- Per [feedback_warmup_window_for_model_splits]: the 10-chapter warm-up is the default — anchors attribution to the roster-author model first. Without it, the first 10 chapters' attribution may drift from the roster's interpretive baseline.

## Test plan

### Automated coverage

- Vitest server (`server/src/analyzer/select-analyzer.test.ts`):
  - (a) Phase 0a always returns the Phase-0 analyzer regardless of chapterIndex.
  - (b) Phase 1 chapter 0 returns the Phase-0 analyzer (warm-up window active).
  - (c) Phase 1 chapter `W` (default 10) returns the Phase-1 analyzer (boundary case).
  - (d) `ANALYZER_PHASE1_WARMUP_CHAPTERS=0` makes Phase 1 chapter 0 already pick the Phase-1 model.
  - (e) Limiter counters split correctly when both models are in flight simultaneously (Phase 0a on gemma + Phase 1 chapter 20 on gemini-3.1-flash-lite); two independent buckets advance without cross-decrement.
  - (f) Legacy single-model `ANALYZER=…` env keeps working when none of the new vars are set (regression).
- Vitest server (`server/src/routes/analysis.test.ts`) — threads chapterIndex into the Phase 1 dispatch and asserts the right analyzer is invoked per chapter.

### Manual acceptance walkthrough

1. **Pre-reboot baseline** per [feedback_reboot_before_perf_baselines]: reboot; record telemetry for a `ANALYZER=gemini` single-model run on `C:\Users\dudar\Downloads\Bonus Keefe Story.txt` (chapter count, per-phase wall-clock, RPM/TPM usage).
2. **Default-split run:** unset `ANALYZER_PHASE0_MODEL` / `ANALYZER_PHASE1_MODEL` / `ANALYZER_PHASE1_WARMUP_CHAPTERS` → all defaults apply. Re-run analysis. Verify telemetry shows:
   - Phase 0a uses gemma only.
   - Phase 1 chapters 0–9 use gemma (warm-up).
   - Phase 1 chapter 10+ uses gemini-3.1-flash-lite.
   - Quota counters in `rate-limit.ts` split correctly across the two model buckets (no cross-decrement).
3. **Attribution spot-check:** sample chapters 1, 10, and 25 attribution against the prior single-model baseline; verify chapter-10 attribution remains coherent across the W-boundary (no abrupt name-resolution shift).
4. **Force-split:** set `ANALYZER_PHASE1_WARMUP_CHAPTERS=0`; verify chapter 0 of Phase 1 already on gemini-3.1-flash-lite.
5. **Legacy fallback:** unset all three new vars; `ANALYZER=gemini`; verify behaviour identical to today's single-model run.

## Out of scope

- **B2 — speculative per-chapter Phase 1** (drop the global roster gate) → BACKLOG Could #23. High regression surface; depends on this plan shipping first.
- **B4 — per-call local→Gemini overflow** (route partial load when local is slow, not just unreachable) → BACKLOG Could #24. Different from this plan: per-call not per-phase.
- **B3 — bump `STAGE2_CONCURRENCY`** — env-var tweak only; not a structural change. May be folded into this plan during implementation if the limiter handles the burst cleanly, otherwise punted to a follow-up.
- **A1 — parallel chapter synthesis** → plan 87 (parallel branch).
- **C2/C3/C5 — frontend perf bundle** → plan 89 (parallel branch).

## Ship notes

_(filled when status flips to `stable` — shipped date, commit SHA, observed quota / attribution delta on the canonical manuscript)_
