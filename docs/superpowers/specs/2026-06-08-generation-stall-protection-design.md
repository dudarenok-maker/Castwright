# Generation Stall Protection — defense-in-depth

**Date:** 2026-06-08
**Status:** approved (design)
**Area:** server + sidecar + launcher scripts (full-stack, ops-heavy)
**Related:** side-11 (#399, the underlying host-memory leak — parallel track, NOT this work) · plan [148](../../features/148-recycle-inflight-recovery.md) (recycle in-flight recovery) · plan [143](../../features/archive/143-sidecar-process-recycle.md) (process recycle)

## Problem

On a real long-book Qwen run (*The Riptide*, The Hollow Tide), generation
appeared to stall. Live forensics (2026-06-08) found it was not frozen but
**degrading 3×** (RTF 1.04 early → 2.82 late, 0.96× → 0.35× realtime) and
periodically wedging. The causal chain:

1. **Host-memory leak (side-11):** the sidecar's committed memory grows
   unbounded with synthesis (observed 7.5 GB → 12 GB in minutes; a prior adopted
   sidecar reached ~21 GB). The leak itself is tracked separately as #399.
2. **Unsafe config ran silently:** the process actually serving the user was a
   stale `tsx watch` **dev server from a git worktree**
   (`.claude/worktrees/config-advanced-settings/`) with **no `.env`** at its CWD.
   `load-env.ts` swallows a missing `.env` and falls back to defaults — so
   `GEN_WORKERS=1` and `GPU_VRAM_BUDGET=2` from the *real* `server/.env` never
   loaded. The server ran **2 generation workers** (default) → two chapters
   synthesised concurrently ("run: 2 ch").
3. **Stale-process adoption:** because a leftover sidecar was already on :9000,
   the server **adopted** it instead of spawning its own. Adopted sidecars are
   policed by the strict **20,000 MB adopt ceiling**
   (`SIDECAR_ADOPT_MAX_COMMITTED_MB`, default in `spawn-sidecar.ts`) with an
   **ungraceful force-replace** — *not* the owned-sidecar graceful path
   (`SIDECAR_RECYCLE_SOFT_MB=37000` / `SIDECAR_RESTART_MB=48500`). So the user's
   carefully tuned soft/hard thresholds never even applied.
4. **The collision:** when the leak crossed 20,000 MB the supervisor
   force-replaced the sidecar **mid-synth**, killing it while **both** in-flight
   chapters were rendering. Both "rode out the respawn" and **re-rendered the
   whole chapter from scratch** (plan-148 recovery) — the wasted re-work behind
   the RTF collapse. Audio QA also flagged "runaway synthesis" sentences.

The port-idempotent launchers (`start-app.ps1`, `start-app-prod.mjs`) then
`[SKIP]`ped because :8443 was already bound, so the user's prod launch never
replaced the stale worktree server — the misconfiguration persisted invisibly.

**This spec is the defense-in-depth *protection*.** Eliminating the leak itself
stays #399.

## Decisions (confirmed with user)

Three layers, all four/three sub-items each selected by the user, plus an
adoption-policy decision:

- **Layer A** (concurrency & config safety): A1 + A2 + A3 + A4.
- **Layer B** (safe recycle barrier): prod-fresh-sidecar policy + B1 + B2.
- **Layer C** (resumable/visible/bounded recovery): C1 + C2 + C3.
- **Adoption policy:** *prod = always spawn fresh on boot (never adopt); dev
  (`tsx watch`) = adopt only a healthy, same-build sidecar* so HMR stays fast.

## Changes

### Layer A — concurrency & config can't silently go unsafe

- **A1 — Default generation workers → 1.** Change the effective default from 2
  to 1 at every default site (`workspace/user-settings.ts`
  `DEFAULT_USER_SETTINGS.generationWorkers`; the `tts.gen.workers` registry
  default in `config/registry.ts`). A missing/unloaded `.env` can no longer
  silently produce cross-chapter contention. Explicit opt-in to 2+ is preserved
  (`GEN_WORKERS` env → `tts.gen.workers` override → setting → default).
- **A2 — Loud config-load failure.** `load-env.ts` currently logs a single
  easy-to-miss `[server] no .env file` line on a missing `.env`. Promote this to
  a first-class warning: record a `configLoad: { envLoaded: false, cwd }` flag
  surfaced on `GET /api/health` and rendered as an in-app warning banner
  ("Running on defaults — `server/.env` was not loaded from this working
  directory"). The CWD is included so a wrong-CWD launch is self-diagnosing.
- **A3 — Per-engine in-flight clamp.** Mirror the sidecar's per-engine
  `_synth_lock` on the Node dispatch side: at most **one in-flight synth per
  engine** (Qwen and Kokoro independently). Qwen+Kokoro still overlap
  (cross-engine, the documented `GPU_VRAM_BUDGET=2` benefit), but two Qwen
  groups never co-dispatch — removing the false parallelism that doubles
  transient memory while the sidecar lock serialises them anyway. Implemented as
  a per-engine gate alongside the existing weighted `gpuSemaphore`
  (`gpu/semaphore.ts`, acquired in `tts/sidecar.ts`).
- **A4 — Port-collision guard at launch.** When `start-app.ps1` /
  `start-app-prod.mjs` find a port already listening, probe `/api/health` for a
  build/version match before honoring it. On mismatch (or unreachable): warn
  loudly and refuse-or-replace instead of silently `[SKIP]`ping a stale server.

### Layer B — recycles never kill mid-synth

- **Prod-fresh-sidecar policy.** In prod, the boot path always spawns a fresh
  owned sidecar; if one is already listening that this server did not spawn,
  drain (if busy) and replace it. In dev (`tsx watch`), keep adopt-if-healthy +
  same-build so HMR stays fast. Seam: `tts/spawn-sidecar.ts` (the adopt-vs-spawn
  decision) gated by an `isProd` / `NODE_ENV` check. This collapses the 20,000
  adopt-ceiling force-replace path in prod and hands governance to the graceful
  owned-sidecar thresholds (37,000 / 48,500). **Must pair with A4** so two
  servers never coexist and war over :9000.
- **B1 — Drain all remaining replace paths.** Any force-replace that can still
  fire (dev adopt-of-unfit, or an owned replace) drains in-flight synth first —
  extend the plan-148 `SIDECAR_DRAIN_GRACE_MS` drain from the sidecar's own
  watchdog to the server-side supervisor / `spawn-sidecar` replace path
  (`tts/sidecar-supervisor.ts`).
- **B2 — Pause dispatch during recycle.** Add a server-side barrier: while a
  recycle/respawn is in progress, hold the queue — no new chapter or group
  dispatch until the sidecar is back and `/health` is green. Prevents fresh work
  piling into a dying/reloading process. Seam: the generation dispatch path
  (`routes/generation.ts` / `routes/queue.ts`) consults a "recycle in progress"
  signal from the supervisor.

### Layer C — recovery is resumable, visible, bounded

- **C1 — Resume from completed groups.** The **server process survives a
  *sidecar* recycle** (only the sidecar respawns), so the in-memory per-group
  PCM already accumulated in `synthesiseChapter` is intact. Make the recovery
  retry the **failed group and continue the loop**, instead of re-invoking
  `synthesiseChapter` from the top and discarding completed groups. Kills the
  wasted re-work behind RTF 1.9→2.8. Seam: move the transient-retry boundary
  from *around the whole chapter* (`routes/generation.ts` `processOneChapter`)
  to *inside the per-group loop* (`tts/synthesise-chapter.ts`).
  - *Out of scope for v1:* disk checkpointing to survive a full **server**
    restart mid-chapter — the queue already re-renders that chapter from
    scratch, and server-restart-mid-chapter is far rarer than a sidecar recycle.
- **C2 — Visible "recovering" state.** During a recycle ride-out, emit a
  `chapter_recovering` (or reuse the `chapter_verifying` shape) SSE tick + a
  heartbeat so the stream is never silent. Fixes the perception half — it never
  *looks* stalled.
- **C3 — Escalate on recycle storms.** If a single chapter triggers recovery
  more than `MAX_RECYCLE_RECOVERIES` (existing bound, plan-148) — i.e. repeated
  recycles on the same chapter — stop grinding: pause the run and surface a
  clear alert naming the cause (likely the leak / undersized headroom) instead
  of burning hours. Builds on the existing `MAX_RECYCLE_RECOVERIES` fall-through.
  *As shipped:* `synthesiseChapter` throws a named `RecycleStormError` on budget
  exhaustion → `generation.ts` maps it to a `recycle-storm` failure code +
  remediation AND **pauses the queue** (`setPaused` on the queue file) on the
  queue path so the dispatcher halts. (The original "rely on the `recordNonFatal`
  cascade" idea was dropped: the cascade is per-POST and the queue dispatches one
  chapter per POST, so it never escalates on the queue path — the explicit
  queue-pause is what delivers "pause the run." The back-compat `*` job, many
  chapters per POST, still uses the cascade.)

## Delivery (3 waves, each independently valuable)

> **Wave 1 landed 2026-06-08** on `feat/server-generation-stall-protection`
> (PR #673, draft): A1 `55e25d8b`, A2 `d92c84a7`, prod-fresh `906cafa0`,
> A4 `43e86162`. Typecheck + frontend + server (2362 tests) green. Plan:
> `docs/superpowers/plans/2026-06-08-generation-stall-protection-wave1.md`.
>
> **Wave 2 landed 2026-06-09** (same PR): B1 `d09cb0cb` (drain in-flight synth
> via the sidecar's existing `POST /recycle` before any force-replace),
> A3 `c8cfbff0` (per-engine `GpuSemaphore(1)` mirroring the sidecar lock),
> B2 `411899c0` + fix `4c202265` (queue `recycling` flag from an explicit
> supervisor respawn-state — NOT handle-ownership, which would have wedged the
> dispatcher for adopted sidecars). Typecheck + server (2376 tests) green. Plan:
> `docs/superpowers/plans/2026-06-08-generation-stall-protection-wave2.md`.
>
> **Wave 3 landed 2026-06-09** on `feat/server-generation-stall-protection-wave3`
> (internal order C1 → C2 → C3, since C2/C3 build on C1's `onRecoverRecycle`
> seam): **C1** `3da94091` (in-loop recovery — completed groups preserved; the
> recovery boundary moved from a whole-chapter re-invoke into `synthesiseChapter`'s
> per-group loop via an injected `onRecoverRecycle` hook + `withRecycleRecovery`
> passthrough helper + `RecycleStormError`; the old whole-chapter recovery test
> was relocated to a unit-level resume-preservation proof). **C2** `35abcea9` +
> `0aa8e4f1` (`chapter_recovering` SSE tick + 10s heartbeat from the hook +
> `phase: 'recovering'` mirroring `chapter_verifying`; the fix holds the progress
> bar rather than regressing it). **C3** `f122b0cd` + `253beec5` (named
> `recycle-storm` taxonomy entry ordered before `vram-spill` to beat its "VRAM"
> substring match, + **queue-pause** on a storm so the run actually stops — the
> per-POST cascade can't escalate on the queue path). Typecheck + server (2384
> tests) + frontend green. Plan:
> `docs/superpowers/plans/2026-06-08-generation-stall-protection-wave3.md`.

1. **Wave 1 — config safety (ships first; prevents *this* incident):** A1, A2,
   A4 + prod-fresh-sidecar policy.
2. **Wave 2 — safe recycles:** A3, B1, B2.
3. **Wave 3 — better recovery:** C2 (cheap) → C1 (the big one) → C3.

## Test plan

- **Server Vitest:**
  - A1 — `getResolvedGenerationWorkers` defaults to 1 with no env/setting.
  - A2 — health payload exposes `envLoaded:false` + cwd when `.env` is absent.
  - A3 — two same-engine (Qwen) acquires serialise; Qwen+Kokoro overlap.
  - B2 — dispatch is held while a recycle signal is set, resumes when cleared.
  - C1 — a transient sidecar error after group K resumes at group K (completed
    groups not re-rendered); only the failed group re-attempts.
  - C3 — recovery past `MAX_RECYCLE_RECOVERIES` on one chapter pauses the run
    with a named alert (no infinite grind).
- **Sidecar pytest:** B1 — the supervisor/`spawn-sidecar` replace path drains
  in-flight synth before kill (mirror `test_memory.py` drain coverage).
- **e2e / health:** A2 warning banner surfaces; A4 mismatch path warns.
- **Adoption policy:** unit test in `spawn-sidecar.test.ts` — prod boot replaces
  an existing sidecar; dev boot adopts a healthy same-build one, replaces an
  unfit/wrong-build one.

## Scope guards

- This is the **protection**, not the leak fix. side-11 (#399) stays the
  parallel track; do not attempt to eliminate the host leak here.
- Preserve the documented `GPU_VRAM_BUDGET=2` cross-engine overlap (plan 113) —
  A3 clamps *same-engine*, not cross-engine.
- Preserve plan-148 invariants: poison stays non-transient/non-recoverable;
  `MAX_RECYCLE_RECOVERIES` still bounds re-attempts; recovery trigger remains
  `isTransient(e)`.
- Preserve the dev `tsx watch` HMR fast-path (adopt healthy same-build) — only
  prod goes always-fresh.

## Out of scope

- Eliminating the host-memory leak (side-11 / #399).
- Disk-checkpoint resume across a full server restart (C1 covers sidecar-recycle
  resume only).
- Changing recycle *thresholds* (soft/hard/adopt values) — the user keeps their
  tuned `SIDECAR_RECYCLE_SOFT_MB` / `SIDECAR_RESTART_MB`; this work changes
  *behavior around* recycles, not when they fire.
