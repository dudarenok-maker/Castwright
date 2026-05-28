---
status: active
shipped: null
owner: null
---

# Generation RTF telemetry

> Status: active
> Key files: `server/tts-sidecar/main.py` (batch log), `server/src/tts/generation-stats.ts`, `server/src/routes/generation-stats.ts`, `server/src/routes/generation.ts` (rollup), `src/components/worktrees-rtf-pill.tsx`, `src/lib/api.ts`
> URL surface: `GET /api/generation/stats`; dev-only top-bar pill
> OpenAPI ops: none (dev/observability endpoint, not part of the public contract)

## Benefit / Rationale

A user watching a long book render had no way to see how fast it was going. The
slow per-sample voice-audition path (`/synthesize`, RTF ~8 on this box) logs a
per-call `rtf=`, but the FAST batched chapter path (`/synthesize-batch`, the one
that actually does generation, target RTF ~1) logged **nothing** — so the only
RTF in the log was misleadingly slow, and a long in-progress chapter (audio is
written only at chapter completion) looked stalled when it was fine.

- **User:** can self-monitor generation speed two ways — the server log prints a
  per-chapter rollup (`rtf`, `Nx realtime`, `chapters/hr`), and the dev top-bar
  `wt` pill shows a live rolling RTF — without asking an agent to grep logs.
- **Technical:** the batched forward now emits `qwen batch synth: … rtf=`, so
  batch throughput is finally observable and comparable to the single-call line.
- **Architectural:** a single module-level throughput accumulator
  (`generation-stats.ts`) is the one source of truth, surfaced over one tiny GET
  endpoint; no new SSE event-type churn, no per-book plumbing.

## Architectural impact

- **New seams:** `recordChapterThroughput` / `getGenerationStats` in
  `server/src/tts/generation-stats.ts` (rolling window, resets after a 10-min
  idle gap so a stale run never dilutes the current one); `GET
  /api/generation/stats`; `api.getGenerationStats()` (real + mock); the
  `WorktreesRtfPill` component.
- **Invariants preserved:** mock/real api split (mock returns the idle shape);
  the `wt` pill stays dev-only (rendered only when `onOpenWorktrees` is wired,
  which is `import.meta.env.DEV`-gated in `layout.tsx`) and keeps its
  `data-testid="topbar-worktrees-link"` + click-to-worktrees behaviour. The
  sidecar batch path's audio output is byte-identical — only a log line was
  added.
- **RTF convention:** `synth-wall ÷ audio` everywhere (< 1 = faster than
  realtime), matching the existing sidecar single-call line and `bench-tts.py`.
  The sidecar `batch synth` line is pure-compute (`gen_ms ÷ Σ audio_ms`); the
  server rollup + pill are end-to-end (chapter synth wall ÷ audio), which is
  higher because it includes HTTP + queueing + cross-engine waits — by design.
- **Reversibility:** delete the endpoint mount + the pill swap; the accumulator
  is inert if nothing calls `recordChapterThroughput`.

## Invariants to preserve

- `WorktreesRtfPill` is the ONLY renderer of the dev pill; it must keep
  `data-testid="topbar-worktrees-link"` and fire `onClick` (worktrees nav) so
  existing top-bar coverage and e2e stay green (`src/components/worktrees-rtf-pill.tsx`).
- The sidecar batch line uses the same `rtf=` token as the single line
  (`server/tts-sidecar/main.py`), so a grep for `rtf=` catches both; `batch
  synth` vs `synth` is the only distinguisher.
- `getGenerationStats()` returns the all-null idle shape when no chapter is in
  the rolling window (`server/src/tts/generation-stats.ts`) — the pill relies on
  `rtf === null` to render just "wt".

## Test plan

### Automated coverage

- Pytest sidecar (`server/tts-sidecar/tests/test_batch_synthesis.py::test_synthesize_batch_logs_aggregate_rtf`)
  — asserts `synthesize_batch` emits exactly one `qwen batch synth: items=… voices=… text_len=… … rtf=…` line with the right item/voice/text-length counts and a parseable rtf.
- Vitest server (`server/src/tts/generation-stats.test.ts`) — rolling rtf /
  xRealtime / chapters-per-hour maths, window reset after the idle gap, idle
  shape.
- Vitest server (`server/src/routes/generation-stats.test.ts`) — `GET
  /api/generation/stats` returns the idle shape, then reflects a recorded chapter.
- Vitest frontend (`src/components/worktrees-rtf-pill.test.tsx`) — idle shows
  just "wt", generating shows the live RTF, click still navigates, fetch failure
  degrades to no readout.

Not adding an e2e spec: the pill is dev-only and the readout is a polled number,
not a router/redux/layout seam — unit coverage is the right bar here.

### Manual acceptance walkthrough

1. **Real backend, generation running** → `tail -f logs/server*.log` shows, per
   finished chapter: `[generation] chapter N "<title>" rendered: lines=… groups=…
   audio=…s synth=…s rtf=… (…x realtime); run: … ch, rtf=…, … ch/hr`.
2. **`tail -f logs/tts.err.log`** during a batched chapter → `qwen batch synth:
   items=8 voices=… … rtf=…` lines (the ~1 target), distinct from the slow
   `qwen synth:` audition lines.
3. **Dev frontend, top bar** → while a book renders, the `wt` pill shows
   `wt 2.3` (the rolling RTF, magenta); idle → just `wt`. Clicking still opens
   the worktrees dashboard.

## Out of scope

- Per-sentence / live per-batch RTF over the wire to the pill (the pill polls a
  rolling per-chapter aggregate, updated as chapters finish — good enough for
  eyeballing speed; a live per-batch feed would need new SSE plumbing).
- The bouncing chapter progress counter (active-line pointer vs completed count)
  — owned by a separate change.

## Ship notes

(Filled when status flips to `stable`.)
