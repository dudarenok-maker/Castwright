---
status: active
shipped: null
owner: null
---

# Sidecar-readiness gate — ride out a respawn instead of failing chapters (srv-17b)

> Status: active
> Key files: `server/src/tts/ensure-sidecar-loaded.ts`
> URL surface: none (server-internal generation gate)
> OpenAPI ops: none

## Benefit / Rationale

- **User:** a full-book run survives the host-RAM recycle unattended. Before this, every recycle (~every 8 chapters) respawned the sidecar, the workers fired synth into the ~10–30 s respawn window, a burst of "sidecar not reachable" failures tripped the queue's consecutive-failure breaker, and the whole queue paused needing a manual Resume.
- **Technical:** `ensureSidecarEngineReady` becomes a *real* gate — it polls through a respawn (sidecar unreachable OR model still loading) up to a budget that covers the supervisor's backoff `[2s,5s,15s]` + a fresh model load, instead of bailing on the first connection-refused and letting the worker proceed into a doomed synth.
- **Architectural:** locks in "no worker dispatches synth while the sidecar is down". Pairs with srv-15 (the supervisor that respawns) + plan 143 (the recycle that triggers the respawn): the recycle reclaims host RAM, the supervisor respawns, and now the gate makes generation *wait* for the respawn rather than fail into it.

## Architectural impact

- **Changed seam:** `ensureSidecarEngineReady(engine, signal?, opts?)` gains an optional 3rd `opts` param (`{ timeoutMs?, pollIntervalMs? }`) for test injection; the 2-arg call sites in `generation.ts` are unchanged. The body changes from a single `/load` POST (fail-fast → lazy fallback) to a poll loop:
  - reachable + `status: 'ready'` → return.
  - reachable + non-ready / non-ok → keep waiting.
  - unreachable (connection refused — respawn in flight) → keep waiting.
  - past `READINESS_TIMEOUT_MS` (120 s) → log + return best-effort (lazy load under the sidecar's `_base_load_lock` is still a correct fallback).
  - run-level abort → throw `AbortError` promptly (the inter-poll sleep is abort-aware).
- **Invariants preserved:**
  - Best-effort contract: the gate STILL never turns a would-proceed run into a failure — it only ever helps. The terminal fallback-to-lazy path is retained; it's just now reached after a full respawn budget instead of on the first failure.
  - The srv-11 consecutive-failure breaker is UNTOUCHED — the fix removes the *spurious* burst of failures at its source rather than weakening the breaker (a genuinely dead sidecar, past the budget, still surfaces).
  - Abort semantics unchanged: an already-aborted signal throws before any fetch; an abort mid-wait rejects promptly.
- **Reversibility:** revert the file to the single-shot fetch → back to fail-fast. No data/schema/contract changes.

## Invariants to preserve

- `ensureSidecarEngineReady` returns (does not throw) on a not-ready sidecar after the budget — only a run-level abort throws (`AbortError`). (`ensure-sidecar-loaded.ts`)
- `READINESS_TIMEOUT_MS` (120 s) ≥ supervisor worst-case backoff (15 s) + a cold model load, so a single respawn is always ridden out.
- The inter-poll `sleep` is abort-aware (rejects on signal) so a Stop/pause doesn't wait out the full poll gap.

## Test plan

### Automated coverage

- Vitest server (`server/src/tts/ensure-sidecar-loaded.test.ts`):
  - **polls through a transient unreachable sidecar then resolves once ready** — the srv-17 core (fetch rejects ×2 then ready → resolves, 3 calls, no throw).
  - polls through a still-loading model then resolves.
  - gives up best-effort (no throw) after the budget when the sidecar stays down / `/load` stays non-ok — and proves it POLLED (>1 call), didn't bail on the first failure.
  - cloud engine is a no-op; already-aborted signal throws before fetch; abort mid-poll rejects promptly.

Tests inject tiny `timeoutMs`/`pollIntervalMs` so the loop is fast + deterministic.

### Manual acceptance walkthrough

Real backend + sidecar, a long all-Qwen run that crosses a host-RAM recycle:

1. Queue many chapters; let the run cross the plan-143 recycle (~45 GB host RAM).
2. At the recycle: sidecar self-exits → supervisor respawns → **the next chapter's worker WAITS at the gate** (server log: `preload qwen: not ready … ` only if the budget is exceeded; normally it just proceeds after the respawn) instead of logging "falling back to lazy load" + a `chapter failed: sidecar not reachable`.
3. The queue does NOT pause; no breaker trip; the run continues through the recycle unattended.

## Out of scope

- The chapter already **mid-synth** when a recycle exits — this gate protects only the NEXT (queued) chapter. Closed by [148-recycle-inflight-recovery.md](148-recycle-inflight-recovery.md) (srv-17c): the worker re-renders it via this same gate, and the sidecar drains in-flight synth before exiting.
- The OTHER half of srv-17 — root-causing the *silent server-child death* (the `:8080` process dying with no stack trace) — stays open in `docs/BACKLOG.md`; plan 145's crash handlers will name it on the next occurrence.
- Emitting an SSE heartbeat during a long gate wait (a multi-second respawn wait is silent on the chapter's stream; the frontend's 30 s "worker quiet" banner is cosmetic and a respawn is usually faster). Follow-up if it proves noisy.
- Eliminating the host-RAM leak itself (side-11) so recycles stop happening.

## Ship notes

(Filled when status → stable.)
