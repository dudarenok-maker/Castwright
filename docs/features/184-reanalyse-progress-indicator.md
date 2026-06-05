---
status: active
shipped: null
owner: null
---

# Meaningful progress for single-chapter re-analysis

> Status: active
> Key files: `src/lib/reanalyse-progress.ts`, `src/views/generation.tsx`
> URL surface: Generate view — the per-chapter Re-analyse / un-exclude row
> OpenAPI ops: none (frontend-only; consumes existing analysis SSE events)

## Benefit / Rationale

The per-chapter **Re-analyse** row (plan 183) and the un-exclude flow reuse the
whole-book progress value, which the server computes as
`0.02 + 0.93·(chaptersDone / totalChapters)`. For a **single-chapter** subset
`total = 1`, so the bar pins at **2%** for the entire stage-1 call and then jumps
— users watched it sit at "2%" and assumed it had hung (observed live, The Drowning Bell
ch16 re-analyse).

- **User:** the bar actually moves during a single-chapter re-analysis, with a
  live *elapsed · chars/s* readout and the existing "waiting on rate limit"
  note — so a slow free-tier run reads as *working*, not *stuck*.
- **Technical:** consumes the `heartbeat` SSE event the subset client already
  parsed but the row ignored — no server or analyzer change, no slowdown.
- **Architectural:** the mapping is a pure, unit-tested function, reusable by the
  whole-book bar later.

## Architectural impact

- **New pure module** `src/lib/reanalyse-progress.ts`:
  - `computeReanalyseProgress({ phaseId, serverProgress, phaseElapsedMs })` →
    0..1. Two phase **bands** (detect `[2%,40%]`, attribution `[40%,97%]`); within
    a phase an asymptotic ease `1−e^(−t/τ)` on the heartbeat's per-call elapsed
    creeps toward the band top; `serverProgress ≥ 0.9` snaps to the top (phase
    complete). Monotonic by construction (bands ascend, `phaseId` only advances).
  - `formatElapsed(ms)` → `"M:SS"`.
- **`generation.tsx`**: `SubsetProgress` gains `serverProgress`, `phaseElapsedMs`,
  `charsPerSec`; a new `applySubsetTick(chapterId, raw)` merges a phase/heartbeat
  tick and recomputes the mapped `progress` (clamped non-decreasing, elapsed reset
  on phase change). Both subset handlers (`handleReanalyse`, `handleToggleExcluded`
  include branch) now pass `onHeartbeat` and route `onPhase` through the tick. The
  row renders the mapped bar + a `· 0:08 · 512 chars/s` readout; the existing
  throttle ("waiting on rate limit") indicator is unchanged.
- **No schema / API change** — `runAnalysisForChapters` already supported
  `onHeartbeat` (`src/lib/api.ts`); only the caller is new.
- **Reversibility:** delete the module + revert the handler wiring; the row falls
  back to the raw server value.

## Invariants to preserve

1. The mapped `progress` stays within `[0,1]` and never decreases across a run
   (`reanalyse-progress.test.ts`).
2. The global sticky AnalysisPill still receives the server's raw `phaseProgress`
   via `applyAnalysisSnapshotTick` — this plan changes only the per-chapter row.
   (Mapping the pill too is a follow-up.)

## Test plan

### Automated coverage

- Vitest unit (`src/lib/reanalyse-progress.test.ts`, 8 cases) — 2% floor before a
  heartbeat; climbs through the detect band on elapsed; snap-to-top on phase done;
  attribution starts at 40% and climbs to <97%; monotonic across a full
  single-chapter run; clamped `[0,1]`; `formatElapsed`.
- Vitest component (`src/views/generation.test.tsx`) — re-analyse row floors at 2%
  on a phase tick, then a heartbeat moves it to ~30% and shows `0:08` + `512
  chars/s` (replaces the old test that asserted the raw server `%`).

### Manual acceptance walkthrough

1. Generate view → an excluded/done chapter → **Re-analyse**. The bar starts ~2%,
   then climbs smoothly through "Detecting characters" → "Parsing and attribution"
   with a live `elapsed · chars/s` readout, and shows "waiting on rate limit"
   during free-tier throttles. It no longer sits frozen at 2%.

## Out of scope

- Mapping the whole-book bar / sticky AnalysisPill (follow-up; they aggregate
  multiple chapters so `done/total` is already meaningful there).
- A true byte-accurate stage-2 estimate from the chapter's sentence count
  (time-ease is honest and dependency-free; byte estimate is a possible refinement).

## Ship notes

(Filled when status flips to `stable`.)
