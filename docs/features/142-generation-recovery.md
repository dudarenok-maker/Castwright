---
status: active
shipped: null
owner: null
---

# 142 — Generation recovery: sidecar respawn (srv-15) + server-authoritative queue completion (srv-16)

> Status: active — code + tests landed; real-run acceptance (kill the sidecar mid-book → run self-heals) pending.
> Key files: `server/src/tts/sidecar-supervisor.ts`, `server/src/tts/spawn-sidecar.ts`, `server/src/index.ts`, `server/src/routes/generation.ts`
> URL surface: indirect (generation SSE + sidecar lifecycle)
> OpenAPI ops: none

## Benefit / Rationale

- **User:** an overnight render survives a sidecar death — the server respawns the sidecar and the queue carries on, instead of silently stalling until someone notices and restarts. And a completed chapter is never needlessly re-rendered after a crash (hours of Qwen compute saved).
- **Technical:** completion becomes server-authoritative (the server knows when a chapter rendered) instead of depending solely on a frontend reconciler that a crash/closed-tab bypasses; the sidecar gains the respawn supervision plan 43 removed.
- **Architectural:** restores the "supervised sidecar" property under `npm start`, and adds a serialized server-side queue-mutation seam that's correct for N>1 workers.

## Context — the 2026-05-30 incident

A sidecar host-RAM leak (plan 141) OOM-killed the Node server mid-run. Two latent gaps turned that into a hard stall:

- **srv-15:** plan 43 moved sidecar ownership to the Node server, but `spawn-sidecar.ts` only *logged* the child's exit and `start-app.ps1` no longer supervised it. So the sidecar's own CUDA-poison self-exit (code 42) — and any crash/OOM — had no respawner. The poison-exit's "start.ps1 restarts me" docstring was stale.
- **srv-16:** queue-entry completion was driven solely by the frontend dispatcher POSTing `/complete` on SSE stream-close. A hard server kill (or a closed tab) bypasses it, so rendered chapters were left `in_progress` on disk. (`completeEntry(…, 'done')` *removes* the entry, which is why `done` never showed — done = pruned.) On reboot those looked like orphans to re-dispatch.

## srv-15 — sidecar respawn supervision

- New `server/src/tts/sidecar-supervisor.ts`: `createSidecarSupervisor({ buildOpts, … })` → `{ start, stop, current }`. It owns the handle and is the sole wirer of `spawnSidecar`'s new `onExit` callback, so supervision continues across respawns. `buildOpts` is async + re-evaluated per respawn (picks up a mid-session eager-load / model-key change).
- Respawn policy: backoff `[2s, 5s, 15s]` (last repeats); a crash-loop cap (`maxConsecutiveFailures`, default 5) gives up with a loud warning rather than hammering; a child that lived ≥ `QUICK_DEATH_MS` (30s) resets the counter so a long-healthy sidecar that dies once still respawns.
- `spawn-sidecar.ts`: added optional `onExit?(code, signal)` to `SpawnSidecarOpts`, invoked in the existing `child.once('exit')` handler AFTER the log line. Spawning is unchanged; `null` returns (autoStart off / healthy sidecar already listening / spawn error) never produce an `onExit`, so supervision stays dormant when nothing was spawned.
- `index.ts`: replaced the one-shot `spawnSidecar` + module `sidecarHandle` with `sidecarSupervisor`; `start()` on boot, `stop()` in the SIGINT/SIGTERM handler (stop sets the stopped flag BEFORE reaping, so the teardown kill can't trigger a respawn race).
- **Scope note (closed by plan 148 / srv-17c):** an in-flight chapter at the moment of sidecar death still fails its synth (the existing `withTtsRetry` window is shorter than a Qwen cold reload) and is recovered by the queue re-dispatch + srv-16's audio-exists skip — i.e. the *run* self-heals, not necessarily the exact in-flight chapter without a blip. **[148-recycle-inflight-recovery.md](148-recycle-inflight-recovery.md) now closes this**: the worker rides out the respawn (srv-17b gate) and re-renders the in-flight chapter in place, and the sidecar drains in-flight synth before the recycle exit — so the exact in-flight chapter no longer blips to `failed`.

## srv-16 — server-authoritative queue completion

- `generation.ts` Hook 1: right after the `chapter_complete` broadcast (chapter rendered + persisted), the server marks the queue entry done for a genuine single-chapter queue job (`job.queueEntryId != null && job.chapterId === chapter.id`). No longer depends on the frontend `/complete`.
- Hook 2: when a non-force, single-chapter queue POST targets a chapter whose audio already exists on disk (so nothing renders and Hook 1 can't fire — the restart-after-crash case), the entry is completed at the route. Without this it loops `in_progress`↔`queued` across boots.
- Both go through a new module-level `serializeQueueMutation()` promise-chain, and the existing srv-12 orphan-recovery reset was routed through it too — there's no file lock, and the server now mutates `.queue.json` from concurrent contexts, so serializing prevents a lost-removal race for N>1 workers. The frontend `/complete` remains a backstop, so a race only falls back to prior behaviour.
- `markQueueEntryDoneOnDisk` is idempotent: it skips when the entry is already gone (frontend won the race), so double-complete is a no-op.

## Architectural impact

- **New seams:** `onExit` on `SpawnSidecarOpts`; the supervisor module (start/stop/current); `serializeQueueMutation` + `markQueueEntryDoneOnDisk` in `generation.ts`.
- **Invariants preserved:** `spawnSidecar`'s null-return contract; the stale-sidecar handshake; the frontend-owned queue lifecycle still works (server completion is additive + idempotent); the srv-12 orphan-recovery guards (last-subscriber + registration check) are unchanged beyond routing through the serializer.
- **Reversibility:** revert the four files; no schema/data migration (queue + state shapes unchanged).

## Invariants to preserve

- The supervisor is the ONLY wirer of `onExit`; each (re)spawn registers it afresh.
- `stop()` MUST set `stopped` before reaping, so a shutdown kill never respawns.
- Server-side queue completion MUST be idempotent (skip-if-absent) and serialized, so it can't double-prune or race the frontend `/complete` / orphan-recovery.
- Hook 1 fires only for single-chapter queue jobs (`chapterId === chapter.id`), never the back-compat `*` walker (chapterId null).

## Test plan

Automated (`npm run test:server`):

- `server/src/tts/sidecar-supervisor.test.ts` (6): start spawns once; respawn on exit; respawn on poison code 42; crash-loop cap warns + stops; long-lived child resets the counter; `stop()` reaps + blocks respawn. All timing injected (delayFn/nowFn) — deterministic.
- `server/src/tts/spawn-sidecar.test.ts`: added a case asserting `onExit(42, null)` fires on child exit.
- `server/src/routes/generation-orphan-recovery.test.ts`: updated the completed-run case to assert srv-16 server-side done-pruning (entry gone, never reset to queued); added a Hook 2 case (chapter audio already on disk + non-force → entry done-pruned, synth never called).

Manual acceptance (pending): start a multi-chapter Qwen run, `taskkill` the sidecar mid-chapter → the server respawns it (backoff) and the queue finishes the book; verify a completed chapter is not re-rendered after a restart.

## Ship notes

_Pending._ Branch `fix/server-sidecar-respawn-and-queue-recovery` (stacked on `fix/sidecar-memory-leak`). Fill shipped date + SHA on merge; flip → `stable` after the manual kill-mid-run acceptance.
