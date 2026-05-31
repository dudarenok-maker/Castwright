---
status: active
shipped: null
owner: null
---

# 152 — Recycle-drain readiness: /load honors the drain fence (no queued-chapter cascade)

> Status: active — code + tests landed; live recycle-drill acceptance (cross a recycle with queued chapters, none fail) pending.
> Key files: `server/tts-sidecar/main.py` (`/load` drain fence + `_max_text_length`), `server/src/tts/ensure-sidecar-loaded.ts` (readiness budget), `server/src/tts/synthesise-chapter.ts` (empty-text filter + timeout-offender log)
> URL surface: indirect (sidecar lifecycle + generation queue)
> OpenAPI ops: none

## Benefit / Rationale

- **User:** a sidecar recycle on a long Qwen book no longer cascade-fails a pile of queued chapters. On 2026-05-31 a single recycle dropped **12 chapters (17–28)** to `failed` in a ~2-minute window; after this fix the run rides out the recycle and only the in-flight chapter re-renders (srv-17c), as designed.
- **Technical:** closes a split-brain between the sidecar's two health signals — `/synthesize` honored the srv-17c drain fence (503 while recycling) but `/load` did not, so the server's readiness gate saw `ready` and marched queued chapters straight into a 503. Also hardens two degenerate-input failure modes from the same run.
- **Architectural:** makes `/load` the single honest readiness signal the gate already trusts — no new seam, the existing poll-through-respawn logic now also rides out the drain.

## Root cause (2026-05-31 cascade)

The variable-shape host-memory leak (plan 143 / `side-11`) forced a process-recycle at the committed ceiling at 14:19:32. A recycle is **not instant**: srv-17c (plan 148) **drains** in-flight synth (`SIDECAR_DRAIN_GRACE_MS`, default 180 s) → self-exits (code 43) → the supervisor respawns + reloads — a **~2 min 15 s** window. During it:

- `/synthesize` correctly fast-failed `503 "recycling to free memory"` (the `_restart_pending` drain fence, `main.py`).
- but **`/load` returned `{"status":"ready"}` instantly**, because each engine branch checked only "is the model resident" (`qwen._base is not None`) and never consulted `_restart_pending`.

So `ensureSidecarEngineReady` (`ensure-sidecar-loaded.ts`) — which both the per-chapter **preload gate** (`generation.ts:950`) and the srv-17c **ride-out loop** (`generation.ts:1075`) funnel through — was satisfied immediately and provided no wait. Each free worker that picked up a queued chapter during the drain passed the gate, fired synth, got 503, burned its 2 ride-out attempts in ~5 s (re-checking a `/load` that stayed green), and failed the chapter. srv-17c only ever protected the single **in-flight** chapter; it never anticipated **queued** chapters entering during the drain.

(The leak itself — the recycle frequency and the inter-recycle RTF degradation from ~1.0 to ~2.4 as committed RAM climbed 5 → 45 GB — is **`side-11`**, owned separately. This plan only makes a recycle *recover cleanly*.)

## The fix

**A — `/load` honors the drain fence (`server/tts-sidecar/main.py`).** At the top of the `/load` handler (before the per-engine branches), if `_restart_pending` is set, return the same non-poisoned `503 "recycling to free memory"` the `/synthesize` fence uses. `tryLoadOnce` already maps any non-ok / non-`ready` response to `{ready:false}`, so the gate now POLLS through the drain+respawn instead of trusting a model that won't accept synth yet. The preload gate at `generation.ts:950` therefore BLOCKS a newly-started chapter until the respawned sidecar is truly ready — the worker waits instead of failing.

**A2 — readiness budget exceeds the drain grace (`ensure-sidecar-loaded.ts`).** `READINESS_TIMEOUT_MS` 120 s → **210 s**, comfortably above the 180 s drain grace, so a SINGLE preload-gate wait rides out a worst-case full-grace drain without timing out mid-drain and falling through to a spurious lazy-load synth.

**B1 — drop empty-text sentences before batching (`synthesise-chapter.ts`, `buildSentenceGroups`).** A blank/whitespace sentence used to become a synth item with empty `text`, which the sidecar rejects with `400 "item N: text is required"`, failing the whole chapter (the ch14 failure). Now filtered with the SAME `normaliseForTts` the synth path applies, so the guard matches exactly what would be sent; `index` is re-sequenced over the kept groups (it's the scatter-back slot key for the index-order concat).

**B2 — cap synth input length + log the offender (`main.py` + `synthesise-chapter.ts`) — `side-13`.** A new `MAX_TEXT_LENGTH` guard (default 8000, `0` disables, env-overridable) on `/synthesize`, `/synthesize-batch`, and `/qwen/design-voice` (`instruct` + `calibrationText`) returns `400` (carrying the offending length) past the cap, so a pathological over-length item fails FAST instead of hanging the synth call for the full 600 s server timeout (the ch29 `ChapterSynthTimeoutError`). On a timeout the server now logs the offending group (`sentenceIds`, speaker, longest length, truncated text) so the actual degenerate input is identifiable.

> Honest caveat: the length cap fixes ch29 **iff** that input was over-length. If the hang came from repetitive-but-short content driving runaway generation, the 600 s timeout remains the only guard — the new offender log will confirm which on the next occurrence.

## Architectural impact

- **New seams / env flags:** `MAX_TEXT_LENGTH` (sidecar, default 8000, `0` disables) via `_max_text_length()`; `/load` now branches on `_restart_pending`. `READINESS_TIMEOUT_MS` bumped to 210 s.
- **Invariants preserved:** the `/synthesize` + `/synthesize-batch` drain fence and 503 shape (unchanged); the index-order scatter-back concat in `synthesiseChapter` (B1 re-sequences `index` to keep `results[group.index]` hole-free); `totalLines` (display) stays derived from the full sentence count in `generation.ts`, and the final tick forces 100%, so dropping an empty sentence's group does not strand progress.
- **Reversibility:** revert the `/load` fence to restore the prior instant-`ready`; `MAX_TEXT_LENGTH=0` disables the cap; the empty-text filter is a pure pre-flight prune.

## Invariants to preserve

- `/load` returns the non-poisoned recycling 503 (NOT `{"status":"ready"}`) whenever `main._restart_pending` is True — mirrors the `/synthesize` fence so the readiness gate keeps polling.
- `READINESS_TIMEOUT_MS` (`ensure-sidecar-loaded.ts`) stays **above** `SIDECAR_DRAIN_GRACE_MS` (default 180 000) so one preload-gate wait spans a full-grace drain.
- `buildSentenceGroups` emits contiguous `index` (0..n-1) over the KEPT groups — never a gap, or the index-order PCM concat strands a slot.
- `MAX_TEXT_LENGTH` default is generous (8000) — well above any real per-sentence payload; the cap must never reject a normal chapter batch.

## Test plan

### Automated coverage

- Pytest sidecar (`server/tts-sidecar/tests/test_memory.py`) — `test_load_reports_not_ready_while_recycling` (the cascade fix: `/load` 503s while `_restart_pending`); `test_max_text_length_parsing` (default/override/garbage/0).
- Pytest sidecar (`server/tts-sidecar/tests/test_synthesize.py`) — `test_synthesize_rejects_over_cap_text` (fast 400 + length in detail), `test_synthesize_accepts_under_cap_text`, `test_synthesize_cap_disabled_with_zero`.
- Vitest server (`server/src/tts/ensure-sidecar-loaded.test.ts`) — `polls through a recycle drain (recycling 503) then resolves once respawned`.
- Vitest server (`server/src/tts/synthesise-chapter.test.ts`) — `drops sentences whose text is empty/whitespace after normalisation` (kept text/ids + re-sequenced index). The existing plan-148 timeout test now also exercises the offender-log path.

### Manual acceptance walkthrough

Real sidecar (not mock mode):

1. Run a Qwen book with a deliberately low `SIDECAR_RESTART_MB` so it recycles within a few chapters, with **>1 chapter queued**.
2. When the recycle fires (`tts.err.log`: "draining … self-exiting (code 43)"), watch `server.err.log`: during the drain window **no queued chapter** fails with `503 "recycling"` — workers wait on the gate. Only the in-flight chapter re-renders (srv-17c). The queue resumes once the fresh sidecar is ready.
3. B1: queue a chapter containing a blank/whitespace sentence → renders with no `400 "text is required"`.
4. B2: `POST /synthesize` with text longer than `MAX_TEXT_LENGTH` → fast `400 "text too long (N > cap)"`; a normal chapter is unchanged.

## Out of scope

- **`side-11`** — eliminating the variable-shape leak (so recycles aren't needed at all, and the inter-recycle RTF degradation goes away). Owned separately (mkldnn-flag-first). This plan only makes a recycle recover cleanly.
- The 2026-05-31 14:55 `EADDRINUSE` — a `tsx watch` hot-reload racing the old `:8080` listener; a dev-mode artifact, no action.
- srv-11 breaker tuning — once `/load` rides out the drain, the breaker is no longer reached for this failure mode.

## Ship notes

_Pending._ Branch `fix/server-recycle-drain-recovery` (off main). Fill shipped date + SHA on merge; flip → `stable` after the live recycle-drill acceptance. `side-13` (cap input length) shipped here — removed from `docs/BACKLOG.md`.
