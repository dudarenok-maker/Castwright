---
status: active
shipped: null
owner: null
---

# Generation RTF telemetry

> Status: active
> Key files: `server/tts-sidecar/main.py` (batch log + `SynthBatchResult` genMs/audioMs + frame header), `server/src/tts/sidecar.ts` (parse perf header), `server/src/tts/generation-stats.ts` (chapter + live-batch windows + per-chapter history ring), `server/src/routes/generation-stats.ts`, `server/src/routes/generation.ts` (rollup + `onBatchComplete`), `server/src/tts/synthesise-chapter.ts` (`onBatchComplete`), `src/components/admin-pill.tsx`, `src/views/admin.tsx` (per-chapter throughput table), `src/lib/api.ts`
> URL surface: `GET /api/generation/stats`; top-bar Admin pill (all-users since [[172-admin-watch-console]]) + Admin-view throughput table
> OpenAPI ops: `GET /api/generation/stats` (full schema, added PR-2 2026-07-01 — see "QA-cost telemetry" below; was previously undocumented)

## Benefit / Rationale

A user watching a long book render had no way to see how fast it was going. The
slow per-sample voice-audition path (`/synthesize`, RTF ~8 on this box) logs a
per-call `rtf=`, but the FAST batched chapter path (`/synthesize-batch`, the one
that actually does generation, target RTF ~1) logged **nothing** — so the only
RTF in the log was misleadingly slow, and a long in-progress chapter (audio is
written only at chapter completion) looked stalled when it was fine.

- **User:** can self-monitor generation speed without grepping logs. The
  top-bar Admin pill shows a **live per-batch RTF** that moves every ~batch
  (updated as each Qwen batch lands) — the figure you can actually act on
  mid-chapter — falling back to the per-chapter rolling figure when no batch is
  recent. The server log also prints a per-chapter rollup (`rtf`, `Nx realtime`,
  `chapters/hr`) as a lagging summary. Clicking the pill opens the Admin watch
  console ([[172-admin-watch-console]]), which also renders a **per-chapter throughput table** (newest-first
  RTF history with a ▲/▼ deterioration cue + a run-summary strip) so the operator
  can see whether RTF is deteriorating or staying consistent across a run — the
  same answer that previously required grepping the `[generation] chapter N …
  rtf=` log lines.
- **Technical:** the batched forward now emits `qwen batch synth: … rtf=` AND
  reports its `genMs`/`audioMs` in the `/synthesize-batch` frame header, so the
  server can surface a live per-batch RTF — observable and comparable to the
  single-call line.
- **Architectural:** a single module-level throughput accumulator
  (`generation-stats.ts`) is the one source of truth, surfaced over one tiny GET
  endpoint; no new SSE event-type churn, no per-book plumbing.

## Architectural impact

- **New seams:** `recordChapterThroughput` / `getGenerationStats` in
  `server/src/tts/generation-stats.ts` (rolling window, resets after a 10-min
  idle gap so a stale run never dilutes the current one); `GET
  /api/generation/stats`; `api.getGenerationStats()` (real + mock); the
  `WorktreesRtfPill` component.
- **Per-chapter history ring (newest-first, capped at `MAX_HISTORY` = 200):** a
  third in-memory list in `generation-stats.ts`, populated by
  `recordChapterThroughput` with each finished chapter's own `{ rtf, audioSec,
  synthSec, title, bookId, modelKey, at }`. Surfaced as
  `GenerationStatsResponse.recentChapters` and rendered by the
  `GenerationThroughput` table in `src/views/worktrees.tsx`. In-memory only:
  survives a sidecar recycle (the Node process persists; only the Python sidecar
  restarts per-batch), resets on a full server restart.
- **Invariants preserved:** mock/real api split (mock returns the idle shape);
  the RTF readout keeps its `data-testid="topbar-rtf"` and the live/per-chapter
  fallback behaviour. Since [[172-admin-watch-console]] the pill is the all-users
  `AdminPill` (always rendered; testid `topbar-admin-link`, click → `#/admin`),
  not the old dev-gated `wt` pill. The sidecar batch path's audio output is
  byte-identical — only a log line was added.
- **RTF convention:** `synth-wall ÷ audio` everywhere (< 1 = faster than
  realtime), matching the existing sidecar single-call line and `bench-tts.py`.
  The sidecar `batch synth` line is pure-compute (`gen_ms ÷ Σ audio_ms`); the
  server rollup + pill are end-to-end (chapter synth wall ÷ audio), which is
  higher because it includes HTTP + queueing + cross-engine waits — by design.
  **Narrowed 2026-07-01 (PR-2):** "chapter synth wall" now excludes the
  post-synth loudnorm encode + disk write (captured right after
  `synthesiseChapter` returns, not after `finalizeChapterAudioWrite`) — RTF
  numbers (route log line, `recordChapterThroughput`'s `rtf`, and the fs-20
  `resource-telemetry.jsonl` `wallSec`) shift down at this deploy boundary.
  No version marker distinguishes pre/post records in the JSONL file — this
  was accepted rather than added: the file is a capped, best-effort
  observability ring (2000 lines, rotates), the field is advisory (a trend
  chart), and the step-change ages out of the window within one active book's
  worth of generation. See `server/src/tts/resource-telemetry.ts`'s `wallSec`
  doc comment.
- **QA-cost telemetry (PR-2, 2026-07-01):** `synthesiseChapter` also returns
  `rerecordMs`/`transcribeMs`/`embedMs` — the wall time its own QA re-record
  loop (signal-QA + ASR-QA) and speaker-embed pass spent, broken out of the
  narrowed synth wall above. `generation-stats.ts` derives two more per-chapter
  fields from these: `rerecordRtf` (rerecordMs ÷ audioSec) and `verifyRtf`
  ((transcribeMs + embedMs) ÷ audioSec) — both `number | null`. The admin
  throughput table (`GenerationThroughput` in `src/views/admin.tsx`) renders
  `rerecordRtf` as a new "QA" column; `verifyRtf` is plumbed end-to-end but not
  yet rendered. **Gated on ACTUAL concurrency, not a config read:** the split
  is only meaningful when this chapter's render never overlapped another job's
  wall-clock — summing per-block time under real interleaving over-counts. The
  gate is `RunningJob.hadSibling` in `server/src/routes/generation.ts`,
  flipped true in `registerJob` whenever `inFlightByChapter.size > 1` (global
  across all books, matching how the queue dispatcher's N workers map onto N
  concurrent chapter jobs) — NOT `getResolvedGenerationWorkers() === 1`, which
  can't see two single-worker books rendering simultaneously or a mid-run
  worker-count change and would mislabel genuinely contended data as clean.
- **Reversibility:** delete the endpoint mount + the pill swap; the accumulator
  is inert if nothing calls `recordChapterThroughput`.

## Invariants to preserve

- `AdminPill` is the ONLY renderer of the RTF readout; it must keep
  `data-testid="topbar-rtf"` for the RTF span and fire `onClick` (→ `#/admin`) so
  existing top-bar coverage and e2e stay green (`src/components/admin-pill.tsx`).
- The sidecar batch line uses the same `rtf=` token as the single line
  (`server/tts-sidecar/main.py`), so a grep for `rtf=` catches both; `batch
  synth` vs `synth` is the only distinguisher.
- `getGenerationStats()` returns the all-null idle shape when no chapter is in
  the rolling window (`server/src/tts/generation-stats.ts`) — the pill relies on
  `rtf === null` to render just "wt".
- The chapter window and the live-batch window are INDEPENDENT: batch fields
  (`liveBatchRtf` etc.) report while the first chapter is still rendering (chapter
  window still empty), and idle on their own `BATCH_IDLE_MS` (5 min) — so a
  chapter-window reset can't blank a live batch readout, and vice versa
  (`server/src/tts/generation-stats.ts`).
- `genMs`/`audioMs` are ADDITIVE frame-header keys; an older sidecar that omits
  them leaves `out.genMs` undefined and `synthBatch` simply skips
  `onBatchComplete` (`server/src/tts/sidecar.ts`, `synthesise-chapter.ts`).
- `recentChapters` is **newest-first**, capped at `MAX_HISTORY`, and **independent
  of the `RESET_MS` rolling-window reset** — an idle gap blanks the aggregate
  (`chapters`/`rtf` → null) but must NOT blank the history (its whole value is the
  cross-pause trend the throughput table draws). The view's deterioration cue
  relies on `recentChapters[0]` being newest and compares each row to the
  immediately-older entry (`server/src/tts/generation-stats.ts`,
  `src/views/worktrees.tsx`).
- The new `recordChapterThroughput` fields (`title`/`bookId`/`modelKey`) are
  OPTIONAL and default to `null` — a bare three-field call still records — so the
  history ring stays back-compatible with existing call sites and tests.
- Each history `rtf` is `null` (not `0`) when the chapter produced no audio, so
  the table renders a dash and skips the trend comparison (no `Infinity` row).
- `rerecordRtf`/`verifyRtf` are `null` whenever `RunningJob.hadSibling` is true
  for the completing job (real overlap detected) OR the QA sub-costs are
  absent (multi-worker path never populates them) — the gate must key off
  actual concurrency, never a static `generationWorkers` config read
  (`server/src/routes/generation.ts`).

## Test plan

### Automated coverage

- Pytest sidecar (`server/tts-sidecar/tests/test_batch_synthesis.py::test_synthesize_batch_logs_aggregate_rtf`)
  — asserts `synthesize_batch` emits exactly one `qwen batch synth: items=… voices=… text_len=… … rtf=…` line with the right item/voice/text-length counts and a parseable rtf.
- Pytest sidecar (`…::test_route_header_carries_batch_perf`) — the
  `/synthesize-batch` frame header carries `genMs`/`audioMs` (additive to
  `sampleRate`/`lengths`).
- Vitest server (`server/src/tts/generation-stats.test.ts`) — per-chapter rolling
  maths + window reset + idle shape, AND the live-batch window (single-batch rtf,
  multi-batch aggregate + latest, idle past `BATCH_IDLE_MS`, independence from the
  chapter window), AND the per-chapter history ring (records every field
  newest-first, caps at `MAX_HISTORY` keeping the most recent, **survives the
  rolling-window idle reset**, `rtf=null` on no-audio, back-compat 3-field call,
  cleared by the reset helper).
- Vitest server (`server/src/tts/synthesise-chapter.test.ts`) — `onBatchComplete`
  fires once per batch with the sidecar's `genMs`/`audioMs`, and does NOT fire
  when the sidecar omits them.
- Vitest server (`server/src/routes/generation-stats.test.ts`) — `GET
  /api/generation/stats` returns the idle shape, reflects a recorded chapter, and
  serialises the per-chapter history with `title`/`bookId`/`modelKey`.
- Vitest server (`server/src/tts/generation-stats.test.ts`, B1 cases) —
  `rerecordRtf`/`verifyRtf` derivation from the QA sub-costs, including
  either-sub-cost-alone and `audioSec===0` edge cases.
- Vitest server (`server/src/routes/generation.test.ts`, "B1 QA-cost telemetry
  passthrough") — a lone chapter render reports non-null `rerecordRtf`/
  `verifyRtf`; two chapters driven through GENUINE concurrent overlap (a gated
  synth mock, no `generationWorkers` config touched) both report `null` —
  pins the gate to actual concurrency, not the config value.
- Vitest frontend (`src/components/worktrees-rtf-pill.test.tsx`) — idle shows
  just "wt"; generating shows the live per-batch RTF; the live per-batch figure
  is preferred over the per-chapter rollup; falls back to per-chapter when no
  batch is recent; click still navigates; fetch failure degrades to no readout.
- Vitest frontend (`src/views/worktrees.test.tsx`) — the throughput table renders
  one row per chapter newest-first; a slower-than-previous chapter is tinted ▲ and
  a faster one ▼ (oldest row, with nothing to compare, has no glyph); a null-rtf
  row renders a dash with no trend; the empty-state copy shows when no chapters
  are recorded; the run-summary strip appears only when a summary figure is set.

Not adding an e2e spec: the pill and the Worktrees view are dev-only and the
readouts are polled numbers, not a router/redux/layout seam — unit coverage is
the right bar here. The mock `getGenerationStats` now ships a synthetic
rising-rtf history so any e2e visiting the dev view exercises the table without
crashing.

### Manual acceptance walkthrough

1. **Real backend, generation running** → `tail -f logs/server*.log` shows, per
   finished chapter: `[generation] chapter N "<title>" rendered: lines=… groups=…
   audio=…s synth=…s rtf=… (…x realtime); run: … ch, rtf=…, … ch/hr`.
2. **`tail -f logs/tts.err.log`** during a batched chapter → `qwen batch synth:
   items=8 voices=… … rtf=…` lines (the ~1 target), distinct from the slow
   `qwen synth:` audition lines.
3. **Frontend, top bar** → while a book renders, the Admin pill shows
   `Admin 1.1` (the LIVE per-batch RTF, magenta) updating every ~batch; once a
   chapter completes and no batch is mid-flight it shows the per-chapter figure;
   idle → just `Admin` + the health dot. Clicking opens the Admin watch console.
4. **Admin view, during/after a run** → in the **Generation throughput**
   section, the table fills newest-first as each chapter completes;
   its RTF column matches the `[generation] chapter N … rtf=` log lines, a
   chapter that ran slower than the one before shows a ▲ (rose), faster shows ▼
   (green); the run-summary strip mirrors the pill's figures. The history
   persists across a sidecar recycle and clears on a full server restart.

## Out of scope

- Per-sentence RTF (single-call `/synthesize` groups, e.g. a Kokoro narrator)
  feeding the live window — only Qwen batches report `genMs`/`audioMs` today;
  single calls log their own `rtf=` but don't drive the pill.
- The bouncing chapter progress counter (active-line pointer vs completed count)
  — owned by a separate change.

## Ship notes

(Filled when status flips to `stable`.)
