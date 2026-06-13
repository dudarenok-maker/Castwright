---
status: active
shipped: null
owner: null
---

# 169 — Defense-in-depth for silent generation stalls + leak-saturated sidecar adoption

> Status: active
> Key files: `server/src/routes/generation.ts`, `server/src/tts/synthesise-chapter.ts`, `server/src/tts/spawn-sidecar.ts`, `server/src/tts/sidecar-supervisor.ts`, `server/tts-sidecar/main.py`, `server/.env.example`
> URL surface: none (server + sidecar runtime)
> OpenAPI ops: none

## Benefit / Rationale

On 2026-06-02 a long Qwen run (book `the drowning bell`) silently stalled mid-chapter and a restart got stuck. Forensics: the server cleanly rendered ch46→ch51, began ch52 (a real story chapter), fed 5 synth batches to the sidecar, then made **no further progress** — with **no `generationError`, no crash trace, and no watchdog**. The restart then **adopted the leaked orphan sidecar** (committed ~26 GB; a fresh load is ~10 GB) and wedged. Underneath was the known variable-shape host-memory leak (committed oscillating ~8→39 GB/batch), which peaked ~900 MB below the soft recycle ceiling and never tripped a clean recycle.

- **User:** a stalled chapter now fails loudly and the queue advances, instead of hanging forever; a restart spins up a clean sidecar instead of inheriting a dying one.
- **Technical:** three independent layers — a whole-chapter no-progress watchdog (covers the previously-uncovered assembly phase), adopt-fitness gating + supervisor liveness, and finer leak sampling + safer recycle tuning.
- **Architectural:** establishes that a chapter that makes no progress is a *recorded, recoverable failure* (breadcrumb), and that sidecar adoption is *fitness-gated*, not presence-gated.

## Architectural impact

- **New seams / env flags:** `CHAPTER_NO_PROGRESS_MS` (default 720000), `SIDECAR_ADOPT_MAX_COMMITTED_MB` (default 20000), `SIDECAR_ADOPTED_HEALTH_POLL_MS` (default 20000); sidecar `_MEM_WATCHDOG_SAMPLE_INTERVAL` (15s). `SidecarHealthProbe` gains `committedMb` + `recyclePending`.
- **Invariants preserved:** the discriminated-union queue/job model is untouched; the srv-17c recovery loop, srv-16 done-flip, and the hard `SIDECAR_RESTART_MB` self-exit backstop are unchanged. `controller.abort()` on a fatal cascade still aborts the whole job; the new chapter-scoped controller only *narrows* an abort to one chapter for the watchdog.
- **Migration story:** none — no on-disk shape change. `.env` is local/gitignored; the recommended values live in `.env.example`.
- **Reversibility:** each layer is env-gated — `CHAPTER_NO_PROGRESS_MS=0` disables the watchdog, `SIDECAR_ADOPT_MAX_COMMITTED_MB=0` disables the committed adopt check; reverting the watchdog sample interval is a one-line constant.

## Invariants to preserve

1. `processOneChapter` (`server/src/routes/generation.ts`) runs its body under a chapter-scoped `AbortController` chained to the job `controller`, raced against a stall guard; a pause/displacement abort still propagates (AbortError → silent return), while a watchdog stall is a `ChapterStallError` → recorded `generationError`.
2. Progress is bumped on **completions** (`onGroupComplete`, `onBatchComplete`) + `onTitleStart` + assembly milestones — **never** on `onGroupStart` (it re-fires every ~10s via `withHeartbeat` and would mask a wedged synth).
3. `spawnSidecar` adopts an already-listening sidecar **only** when protocol-fresh **and** fit (`!recycle_pending` and `committed_mb < SIDECAR_ADOPT_MAX_COMMITTED_MB`); otherwise it kills + respawns via the existing stale-sidecar path.
4. The sidecar memory watchdog evaluates the soft/hard ceilings **per sample** (every `_MEM_WATCHDOG_SAMPLE_INTERVAL`), while the log line + gc-reclaim stay throttled to `_MEM_WATCHDOG_INTERVAL`.

## Test plan

### Automated coverage

- Vitest server (`server/src/routes/generation-stall-watchdog.test.ts`) — synthesis-phase hang → `chapter_failed` + persisted `generationState:'failed'`/`generationError` naming "synthesis"; assembly-phase hang (encode never returns) → failure naming "assembly"; a normally-ticking chapter is NOT aborted.
- Vitest server (`server/src/tts/spawn-sidecar.test.ts`) — adopt refused for an over-ceiling target and a `recycle_pending` target (kill+respawn, `onAdoptExisting` not called); a healthy below-ceiling sidecar is still honoured.
- Vitest server (`server/src/tts/sidecar-supervisor.test.ts`) — the adopted-sidecar fitness watchdog replaces a sidecar that crosses the committed ceiling while staying TCP-up.
- Pytest sidecar (`server/tts-sidecar/tests/test_memory.py::test_watchdog_finer_sampling_catches_transient_committed_spike`) — a trough→spike→trough committed sequence flips `recycle_pending` on the spike sample without crossing the hard ceiling.

### Manual acceptance walkthrough

Real sidecar (Qwen), `WORKSPACE_DIR` pointing at a real book.

1. **Layer 1** — set `CHAPTER_NO_PROGRESS_MS=20000`, point synth at a paused/wedged sidecar → the chapter aborts after ~20 s, the book `state.json` chapter shows `generationState:'failed'` + a "no progress" `generationError`, and it rehydrates as **Failed** (not Queued).
2. **Layer 2** — start the server while a deliberately bloated sidecar (committed > 20 GB) listens on :9000 → boot log shows a fresh `spawned pid=…`, NOT "current sidecar honoured". Then let a healthy sidecar be adopted and force it over the ceiling mid-run → the supervisor logs a replace + respawn.
3. **Layer 3** — run a multi-chapter Qwen generation; confirm the periodic memory log shows `committed=…MB (peak …MB)`, and a clean `/recycle` fires at a chapter boundary once a batch peak crosses `SIDECAR_RECYCLE_SOFT_MB` — well before committed reaches `SIDECAR_RESTART_MB`.

## Out of scope

- Eliminating the underlying variable-shape leak (side-11) — these layers *contain* it; the root leak fix is tracked separately.
- Replacing a hard-wedged adopted sidecar whose `/health` is unresponsive (TCP-up but not answering) — the fitness watchdog acts only on a *successful* `/health` reporting `recycle_pending`/over-ceiling. Deferred (false-kill risk); the per-chapter watchdog (Layer 1) still bounds the resulting chapter stall.

## Ship notes

(Filled in when status flips to `stable`.)
