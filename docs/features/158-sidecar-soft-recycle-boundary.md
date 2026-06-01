---
status: active
shipped: null
owner: null
---

# 158 — Soft recycle at the chapter boundary (side-11 item 2)

> Status: active — code + tests landed; the soft threshold is set on this box's
> `server/.env` (`SIDECAR_RECYCLE_SOFT_MB=30000`, hard backstop `SIDECAR_RESTART_MB=35000`)
> and awaits a full-book live-GPU acceptance run before flipping `stable`.
> Key files: `server/tts-sidecar/main.py`, `server/src/routes/generation.ts`, `server/src/routes/sidecar-health.ts`, `server/src/tts/ensure-sidecar-loaded.ts`
> URL surface: none (sidecar runtime + server generation worker)
> OpenAPI ops: none (sidecar-internal `POST /recycle`, `GET /health` additive fields)

## Benefit / Rationale

- **User:** on a long Qwen book the leak-forced recycle (plan 143) currently fires
  at the HARD ceiling — late, after RTF has already degraded (1.0 → 2.4 as committed
  climbed 5 → 45 GB on the 2026-05-31 run) — and can drain mid-chapter. The soft
  recycle fires *earlier* (sustained RTF) and *between* chapters (no mid-chapter
  cut, no wasted partial re-render). Goal: a full book on one warm sidecar with no
  disruptive recycles and zero dropped chapters.
- **Technical:** decouples *when* the recycle happens (server picks a chapter
  boundary) from *the metric that demands it* (committed-private crossing a soft
  threshold). The sidecar raises an advisory `recycle_pending` flag; the server
  triggers the actual recycle via a new `POST /recycle` that reuses the hard
  watchdog's drain→exit path verbatim.
- **Architectural:** the hard watchdog (`SIDECAR_RESTART_MB` → `os._exit(43)`) stays
  the **untouched backstop**. The soft path is purely additive and opt-in (default
  off), so production is a no-op until `SIDECAR_RECYCLE_SOFT_MB` is set.

## Architectural impact

- **New seams / extension points:**
  - Sidecar env `SIDECAR_RECYCLE_SOFT_MB` (default 0 = OFF) parsed by
    `_mem_recycle_soft_threshold_mb()`; pure decision `_should_soft_recycle()`.
  - Sidecar module flag `_recycle_pending` (advisory; never exits) set by the
    watchdog's new soft branch.
  - `/health` gains `recycle_pending: bool` + `committed_mb: float|None` (additive).
  - Sidecar `POST /recycle` — server-triggered clean recycle, delegates to the
    existing `_schedule_restart_exit()` (idempotent via `_restart_scheduled`).
  - Server: `getSidecarRecyclePending()` + `triggerSidecarRecycle()` helpers in
    `generation.ts`; the chapter-loop boundary check; `SIDECAR_ENGINES` is now
    exported from `ensure-sidecar-loaded.ts`.
  - The `/api/sidecar/health` proxy forwards `recyclePending` / `committedMb`.
- **Invariants preserved:** the watchdog hard branch is unchanged;
  `_should_soft_recycle` returns False at/above the hard ceiling so the two
  thresholds never race. The drain fence + `_inflight_synth` + readiness gate
  (plan 152, `READINESS_TIMEOUT_MS=210_000`) are reused, not modified.
- **Reversibility:** unset `SIDECAR_RECYCLE_SOFT_MB` (or set 0) → the soft path is
  inert; behaviour reverts to the plan-143 hard recycle exactly.
- **Migration story:** none — no on-disk shape change. Old sidecars omit the new
  `/health` fields → the proxy defaults them to `false` / `null`.

## Invariants to preserve

- `_should_soft_recycle(commit, soft, hard)` (`main.py`) = `soft>0 && commit>=soft &&
  !_should_restart(commit, hard)` — soft never fires at/above the hard ceiling.
- The watchdog's hard branch (`if _should_restart(...): _schedule_restart_exit(...); continue`)
  is evaluated **before** the soft branch and `continue`s, so a committed value over
  the hard ceiling can never also set `_recycle_pending`.
- `POST /recycle` delegates to `_schedule_restart_exit`, guarded by
  `_restart_scheduled` → at most one self-exit regardless of repeat POSTs or a
  concurrent hard tick.
- The boundary check in `generation.ts` runs only for `SIDECAR_ENGINES`
  (`{qwen,kokoro,coqui}`), is skipped on abort, and is best-effort (a failing
  `/health` read or `/recycle` POST never throws into the generation path).
- Awaiting the `/recycle` POST before the chapter loop exits guarantees the 503
  drain fence is up before the job's SSE closes → the next chapter's dispatcher
  POST opens afterwards and its `ensureSidecarEngineReady` gate polls cleanly
  through the respawn (no race, clean at the single-worker default).

## Test plan

### Automated coverage

- Pytest sidecar (`server/tts-sidecar/tests/test_memory.py`):
  - `test_recycle_soft_threshold_parsing` — default 0 / override / 0 / garbage → 0.
  - `test_should_soft_recycle` — soft≤commit<hard True; below soft / at-or-above hard
    / soft=0 all False.
  - `test_watchdog_sets_recycle_pending_below_hard` — one tick sets `_recycle_pending`,
    schedules no exit.
  - `test_watchdog_hard_ceiling_still_exits_when_soft_set` — over the hard ceiling the
    exit is scheduled and the soft flag is NOT also set (hard branch `continue`s).
  - `test_health_reports_recycle_pending` — `/health` carries `recycle_pending` +
    `committed_mb`; flipping the flag is reflected next poll.
  - `test_recycle_endpoint_schedules_clean_exit` — `POST /recycle` → 202 `recycling`,
    flips `_restart_pending`, fires exactly one exit, second POST is a no-op.
  - `test_recycle_endpoint_drains_inflight_before_exit` — holds the exit until
    `_inflight_synth` reaches 0.
- Vitest server (`server/src/routes/sidecar-health.test.ts`) — `/health` proxy
  forwards `recyclePending` / `committedMb`; defaults `false` / `null` for an older
  sidecar.
- Vitest server (`server/src/routes/generation-boundary-recycle.test.ts`) — fake
  sidecar: recycle_pending:true → `POST /recycle` fires after `chapter_complete`;
  false → probed but no recycle; cloud engine → neither probed nor recycled;
  failing `/health` → generation still completes, no recycle (best-effort).

### Manual acceptance walkthrough (USER-RUN, live GPU)

1. Clean reboot; start the sidecar warm on `:9000` with `SIDECAR_RECYCLE_SOFT_MB=30000`
   + `SIDECAR_RESTART_MB=35000`.
2. `GET :9000/health` → `recycle_pending:false`, `committed_mb` present.
3. Run a full Qwen book through the queue (single worker, `GEN_WORKERS=1`). Watch
   `tts.log` `sidecar memory:` + `/debug/memory`: committed climbs, crosses 30 GB →
   `recycle_pending` flips → at the next chapter boundary the server POSTs `/recycle`;
   the sidecar exits (code 43), respawns, the next chapter's readiness gate rides it out.
4. **Pass bar:** the book completes with the soft recycle firing **between** chapters
   (committed never reaches the 35 GB hard ceiling on a normal chapter), **zero
   dropped / re-rendered chapters**, no `chapter_failed`. The hard `code 43` watchdog
   is a no-show (backstop only).

## Out of scope

- **Eliminating the leak** (side-11 candidate 2 — fixed-shape batch padding). This
  plan is blast-radius mitigation; the leak itself stays open under `side-11`.
- **N≥2 workers:** at >1 worker a sibling chapter mid-synth gets drain-cut and
  re-rendered by srv-17c (recoverable, not dropped). The operative config is
  `GEN_WORKERS=1` (best for Qwen), where there is no sibling. A documented future
  upgrade gates the boundary recycle on global idle via the `inFlightByBook` map.
- **Frontend "recycling soon" indicator** — the additive `/health` fields make it
  cheap later, but no UI is shipped here.

## Ship notes

(Filled in when status flips to `stable` — pending the full-book live-GPU acceptance
run above. On a pass, note "recycle now a safety net, not load-bearing" per the
side-11 close condition and move this file to `docs/features/archive/`.)
