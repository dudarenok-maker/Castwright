---
status: active
shipped: null
owner: null
---

# 148 — Recycle no longer drops the single in-flight chapter (drain + in-worker recovery, srv-17c)

> Status: active — code + tests landed; live recycle-mid-chapter acceptance (in-flight chapter survives without a `failed` blip) pending.
> Key files: `server/src/routes/generation.ts` (in-worker recovery), `server/tts-sidecar/main.py` (drain-before-recycle)
> URL surface: indirect (generation SSE + sidecar lifecycle)
> OpenAPI ops: none
> Extended by [[154-false-gemini-rate-limit-misclassify]] — the recovery trigger now also covers `ChapterSynthTimeoutError` (a synth that stalls into the 600 s ceiling while the respawned sidecar is still loading), not just transient sidecar-down; and that timeout, once recovery is exhausted, is non-fatal (skip & advance) instead of a mislabeled "Gemini rate-limited" run-stop.

## Benefit / Rationale

- **User:** a host-RAM recycle (plan 143) mid-chapter is now seamless — the chapter that was rendering finishes (or transparently re-renders) instead of flipping to `failed` and needing a manual Retry. Overnight Qwen runs cross a recycle without losing the in-flight chapter (the ch36/ch46 drops on 2026-05-30).
- **Technical:** closes the gap plan 142 explicitly scoped out (`142-generation-recovery.md` "Scope note") — recovery now covers the EXACT in-flight chapter, not just "the run self-heals eventually." Covers all mid-synth sidecar deaths (recycle, crash, OOM), not only the planned recycle.
- **Architectural:** reuses the srv-17b readiness gate as the respawn-ride-out primitive and the existing `transient` annotation as the recovery trigger — no new error taxonomy, no new SSE event, no frontend change.

## The two halves

The srv-17b readiness gate (plan 147) makes a *queued* chapter wait out a respawn before it dispatches synth. But the chapter already **mid-synth** at the moment of the recycle exit is past the gate: its `/synthesize` fetch dies on the connection drop, `withTtsRetry`'s ~2.5 s budget is far shorter than a respawn + cold model load (~5–30 s), and the server classifies "sidecar not reachable" as `fatal: true` → `chapter_failed` + run abort. srv-17c closes that with two complementary layers:

### A. Server-side in-worker recovery (the backstop — covers ALL mid-synth deaths)

`server/src/routes/generation.ts`, `processOneChapter`. The synth call is wrapped in a bounded recovery loop. The trigger is simply `isTransient(e)` (from `server/src/tts/retry.ts`), because both failure shapes are already transient-annotated and both exclude poison:

- a connection drop → `sidecar.ts:post()` annotates `{ transient: true, cause: 'network' }`;
- the recycling drain-503 (half B) → `throwForResponse` marks a non-poisoned 5xx `transient: true`;
- CUDA-poison carries `poisoned: true` → `transient: false`, so it is NOT recovered (only a restart fixes a poisoned context) and still surfaces immediately.

On a transient throw, while the run is live and `recovery < MAX_RECYCLE_RECOVERIES` (2), the worker logs, polls out the respawn via `ensureSidecarEngineReady(engine, signal)` (srv-17b, 120 s budget), and re-renders the chapter on its own worker. After the budget is exhausted — or for any non-transient / aborted error — it re-throws to the unchanged failure path, so a genuinely-dead sidecar still surfaces loudly and the loop can never run forever. No new SSE event: during the wait the stream simply goes quiet then re-emits progress, exactly like the silent gap srv-17b already produces for the next chapter.

### B. Sidecar drain-before-recycle (the polish — makes the planned recycle seamless)

`server/tts-sidecar/main.py`. A module-level `_inflight_synth` counter is incremented on the event loop around each `asyncio.to_thread(engine.synthesize…)` offload (single-threaded inc/dec, no lock) in both `/synthesize` and `/synthesize-batch`, decremented in `finally`. When the memory watchdog decides to recycle, `_schedule_restart_exit` now flips `_restart_pending = True` and hands off to a daemon-thread `_drain_then_restart(grace_ms)` that polls `_inflight_synth == 0` (bounded by `SIDECAR_DRAIN_GRACE_MS`, default 180000; `0` disables draining → the pre-srv-17c immediate exit) before arming the flush-delayed `_restart_now()`. While `_restart_pending` is set, `/synthesize` + `/synthesize-batch` fast-fail with a **non-poisoned** 503 ("recycling to free memory; retry shortly"), so no new chapter enters the dying process and half A rides out the respawn. If the grace expires with a synth still running, the sidecar exits anyway — half A backstops that chapter.

## Architectural impact

- **New seams:** `MAX_RECYCLE_RECOVERIES` (generation.ts); `_restart_pending` / `_inflight_synth` / `_drain_grace_ms()` / `_drain_then_restart()` + the `SIDECAR_DRAIN_GRACE_MS` env (main.py).
- **Invariants preserved:** the readiness gate's abort contract (a paused/displaced run throws AbortError out of the recovery wait → the existing AbortError branch → clean stop); the poison fence + CUDA-poison fatal classification (poison stays non-transient, non-recoverable); srv-16 server-authoritative completion (a recovered chapter completes through the unchanged Hook 1 path); the watchdog's idempotent single-exit (`_restart_scheduled`) and flush-delay.
- **Reversibility:** `SIDECAR_DRAIN_GRACE_MS=0` disables half B (immediate recycle). Half A is reverted by removing the loop; both are independent.

## Invariants to preserve

- `MAX_RECYCLE_RECOVERIES` in `server/src/routes/generation.ts` bounds the in-worker re-attempts — a transient error past the budget MUST fall through to the existing `describeSynthesisError` → `chapter_failed` → cascade/fatal path unchanged.
- The recovery trigger is `isTransient(e)` ONLY — a `poisoned`/non-transient error must never enter the loop (it re-throws immediately).
- The drain-503 in `main.py` MUST NOT carry a `poisoned` key — the server reads a poisoned body as fatal; the recycling 503 must classify as transient.
- `_inflight_synth` is incremented before the `to_thread` offload and decremented in `finally` in BOTH `/synthesize` and `/synthesize-batch`, so the drain counter can't leak on an error path.
- `_schedule_restart_exit` stays idempotent (`_restart_scheduled`) and still flush-delays the hard exit.

## Test plan

### Automated coverage

- Vitest server (`server/src/routes/generation-recycle-recovery.test.ts`) — transient-then-success completes with no `chapter_failed` and the gate polled between attempts; transient-every-attempt falls through to `chapter_failed` after `MAX_RECYCLE_RECOVERIES`; a non-transient error skips the loop (one synth call); an abort mid-wait is a clean stop (no failure tick).
- Pytest sidecar (`server/tts-sidecar/tests/test_memory.py`) — `_drain_grace_ms` parsing (default/override/garbage/0); drain waits while `_inflight_synth>0` then exits at 0; grace-expiry exits anyway; `grace=0` exits immediately; `_restart_pending` makes `/synthesize` return a non-poisoned 503; `_schedule_restart_exit` idempotency carried through the drain path.

### Manual acceptance walkthrough

1. Run a Qwen book (canonical `server/src/__fixtures__/the-coalfall-commission.md`) with a deliberately low `SIDECAR_RESTART_MB` to force a recycle mid-chapter.
2. The sidecar log shows `recycling: draining N in-flight synth …` then the code-43 exit; the srv-15 supervisor respawns it.
3. The in-flight chapter does NOT flip to `failed` in the queue and finishes after the respawn with no manual Retry; `/debug/memory` drops post-respawn.
4. Set `SIDECAR_DRAIN_GRACE_MS=0` and repeat — half A alone still recovers the chapter (drain disabled → connection drop → in-worker recovery).

## Out of scope

- Root-causing the *silent server-child death* (the `:8080` process dying with no stack trace) — stays open as `srv-17` in `docs/BACKLOG.md`; plan 145's crash handlers will name it on the next occurrence.
- Eliminating the host-memory leak itself (MKLDNN-disable / shape-bucketing / upstream) — `side-11`.

## Ship notes

_Pending._ Branch `fix/server-sidecar-recycle-inflight-recovery` (off main). Fill shipped date + SHA on merge; flip → `stable` after the live recycle-mid-chapter acceptance.
