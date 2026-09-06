/* srv-15 — sidecar respawn supervision.
 *
 * Plan 43 moved TTS-sidecar ownership from start-app.ps1 to the Node server,
 * but the server only LOGGED the child's exit — it never respawned it. So any
 * sidecar death (crash, OS OOM-kill — see the 2026-05-30 host-RAM incident —
 * or the Python CUDA-poison self-exit with code 42) left generation permanently
 * stalled with no recovery. This supervisor owns the sidecar handle and
 * respawns a fresh process on unexpected exit, with backoff and a crash-loop
 * cap, while staying out of the way during intentional shutdown.
 *
 * The supervisor is the SOLE wirer of `spawnSidecar`'s `onExit` callback: each
 * (re)spawn registers a fresh exit handler, so supervision continues across
 * respawns. `buildOpts` is async + re-evaluated per respawn so a settings
 * change (eager-load prefs, model key) is picked up by the next process. */
import type { SidecarHandle, SidecarHealthProbe, SpawnSidecarOpts } from './spawn-sidecar.js';
import {
  spawnSidecar,
  probeListening,
  probeSidecarHealth,
  adoptCommittedCeilingMb,
} from './spawn-sidecar.js';
import { readRestartBreadcrumb } from './restart-breadcrumb.js';

async function defaultRecycleSidecar(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/recycle`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
const DEFAULT_DRAIN_WAIT_MS = 185_000;

/* Child-lifetime threshold, nothing more: the crash-loop cap counts only a
   child that died faster than this. One that lived longer is a fresh incident
   and resets the counter — a sidecar that runs fine for an hour and then dies
   once still gets respawned even if an earlier boot had flaked. The refusal
   path never consults this value: a slow spawn attempt is attempt latency,
   not child lifetime, and must not masquerade as a long-lived child
   (#2106 step 2). */
const QUICK_DEATH_MS = 30_000;
const DEFAULT_BACKOFFS_MS = [2_000, 5_000, 15_000];
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;
/* A code-43-SPECIFIC streak, independent of `consecutiveFailures` above: that
   counter resets whenever a child lives past QUICK_DEATH_MS, so a structurally
   -too-small device assignment that loads fine for 35s and then dies every
   time would never trip the give-up branch (it keeps resetting). This counter
   tracks code-43 self-exits ONLY, on a pure time-window basis, regardless of
   how long each child lived (§W2.5).

   Intentionally metric-agnostic: it counts EVERY code-43 exit — a per-card
   VRAM/floor breach (Wave 2 §W2.2), a host-RAM ceiling breach, or a manual
   POST /recycle — not just per-card structural breaches. A cluster of 3
   otherwise-healthy recycles in the 10-minute window trips the same hold-down
   as a genuinely undersized device pin. This is deliberate (see the plan's
   Task 9 on-box checklist, which exercises the non-card-specific trigger
   explicitly) and low-risk (3 legitimate recycles in 10 minutes is itself
   abnormal) — not a bug if a recycle-storm trips this. */
const RESTART43_STREAK_WINDOW_MS = 600_000; // 10 min
const RESTART43_STREAK_TRIP_COUNT = 3;
/* How often to poll an ADOPTED (already-listening, not-owned) sidecar for
   disappearance. Short enough that a self-recycle is detected and a fresh
   owned child respawned inside the generation path's ride-out window, but not
   so chatty that it spams the port during a normal multi-minute drain. */
const DEFAULT_ADOPTED_POLL_MS = 1_500;
/* How often to /health-poll an adopted sidecar for FITNESS (recycle_pending /
   committed over the adopt ceiling), on top of the cheap TCP disappearance
   probe. Slower cadence — a leak builds over minutes, and /health is heavier
   than a TCP connect. The 2026-06-02 incident left a fresh server bolted onto a
   leak-saturated adopted orphan with no replacement because the watchdog only
   watched for EXIT; this catches the alive-but-unfit case. */
const DEFAULT_ADOPTED_HEALTH_POLL_MS = 20_000;

export interface SidecarSupervisorOpts {
  /** Builds the base spawn opts for each (re)spawn. Async so it can re-read
      user settings each time. Any `onExit` it returns is overwritten — the
      supervisor owns that callback. */
  buildOpts: () => Promise<Omit<SpawnSidecarOpts, 'onExit'>>;
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  /* Test seams. */
  spawnFn?: (opts: SpawnSidecarOpts) => Promise<SidecarHandle | null>;
  delayFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
  backoffsMs?: number[];
  maxConsecutiveFailures?: number;
  /* Probe whether something still holds the adopted sidecar's port. */
  probeFn?: (host: string, port: number) => Promise<boolean>;
  /* /health probe used by the adopted-sidecar FITNESS watchdog. */
  healthProbeFn?: (host: string, port: number) => Promise<SidecarHealthProbe>;
  /* Poll interval for the adopted-sidecar disappearance watchdog. */
  adoptedPollMs?: number;
  /* Poll interval for the adopted-sidecar fitness (/health) watchdog. */
  adoptedHealthPollMs?: number;
  /** Graceful drain: POST /recycle so the sidecar drains in-flight synth and
      self-exits, instead of a hard kill. Resolves true on a 2xx, false otherwise. */
  recycleSidecarFn?: (host: string, port: number) => Promise<boolean>;
  /** Max ms to wait for the port to free after a graceful recycle before
      falling through to the hard-kill replace. Default 185_000 (180s drain + margin). */
  drainWaitMs?: number;
}

export interface SidecarSupervisor {
  /** Spawn the initial sidecar and begin supervising. */
  start: () => Promise<void>;
  /** Stop supervising and reap the current child. After this, an exit never
      triggers a respawn (so it's safe to call during server shutdown). */
  stop: () => Promise<void>;
  /** The current live handle, or null before first spawn / between respawns /
      when no spawn was needed (autoStart off, reuse). */
  current: () => SidecarHandle | null;
  /** True while a respawn or drain-wait is in progress (i.e. no sidecar is
      currently ready to accept requests). False once the initial spawn
      completes successfully — whether via an owned child or a healthy adopt.
      Use this to gate the queue dispatcher; do NOT use `current() == null`
      which is permanently true for adopted sidecars. */
  recycling: () => boolean;
  /** Non-null once 3+ code-43 self-exits happened within RESTART43_STREAK_
      WINDOW_MS — the assignment looks structurally too small. The supervisor
      stops respawning once this trips (TTS held down); Plan 2's auto-revert
      route (Task 16) reads this to rewrite the offending knob, then calls
      resetAndRespawn() to actually bring TTS back. */
  tripEvent: () => { card: unknown; residentEngines: string[] } | null;
  /** True once consecutiveFailures has exceeded maxConsecutiveFailures and the
      supervisor gave up respawning (the plain, non-code-43 give-up path).
      Computed live from consecutiveFailures — clears the instant
      resetAndRespawn() zeroes it, with no separate flag to forget to clear. */
  exhaustedEvent: () => boolean;
  /** The way back from EITHER give-up state (a code-43 trip or plain
      consecutive-failure exhaustion) — resets whichever streak/counter is
      set and spawns a fresh child. Has no internal guard against concurrent
      calls: safety for that comes from every CALLER re-checking
      exhaustedEvent()/tripEvent() synchronously, with no intervening await,
      immediately before calling (see the /restart route in
      sidecar-health.ts). Safe to call when nothing is tripped/exhausted —
      resets an empty streak and respawns as normal. */
  resetAndRespawn: () => Promise<void>;
}

/* Module-level registry so the POST /api/sidecar/restart route can reach the
   live supervisor without importing index.ts. Set once at boot via
   registerActiveSupervisor; cleared on stop. */
let _activeSupervisor: SidecarSupervisor | null = null;

/** Register (or clear) the active supervisor. Called by index.ts after
    createSidecarSupervisor + .start(). */
export function registerActiveSupervisor(s: SidecarSupervisor | null): void {
  _activeSupervisor = s;
}

/** Returns the active supervisor, or null when no sidecar is supervised
    (autoStart off, supervisor not yet started, or already stopped). */
export function getActiveSupervisor(): SidecarSupervisor | null {
  return _activeSupervisor;
}

/* Synchronous in-flight guard (module-level). Set before the first `await`
   below and cleared in `finally` — because JS has no preemption between
   awaits, this closes a race a `supervisor.recycling()`-only check would
   leave open (that flag flips inside the async onChildExit handler, AFTER
   kill() is called, not synchronously with it). */
let recycleInFlight = false;

/** Force-kill the current supervised sidecar child so the existing
    onChildExit → backoff → respawn path brings up a fresh process. Used when
    the caller has strong evidence the sidecar is wedged (not merely slow) —
    a readiness-poll exhausted its full budget, a chapter made zero progress
    for the full stall window, or in-loop recovery attempts were exhausted
    (RecycleStormError). Reuses the exact primitive `POST /api/sidecar/restart`
    already uses (`handle.kill()`), so the existing crash-loop cap applies
    automatically — this function adds no new cap logic. Returns false
    (no-op) when there's no active supervisor, a recycle is already in
    flight, or one is already known to be recovering — so concurrent callers
    don't pile up redundant kills on the same dying process. */
export async function forceSidecarRecycle(
  reason: string,
  warn: (...args: unknown[]) => void = console.warn,
): Promise<boolean> {
  if (recycleInFlight) return false;
  const supervisor = getActiveSupervisor();
  if (!supervisor || supervisor.recycling()) return false;
  const handle = supervisor.current();
  if (!handle) return false;
  recycleInFlight = true;
  try {
    warn(`[sidecar] forced recycle: ${reason}`);
    await handle.kill();
    return true;
  } finally {
    recycleInFlight = false;
  }
}

export function createSidecarSupervisor(opts: SidecarSupervisorOpts): SidecarSupervisor {
  const {
    buildOpts,
    log = console.log,
    warn = console.warn,
    spawnFn = spawnSidecar,
    delayFn = (ms) => new Promise((r) => setTimeout(r, ms)),
    nowFn = () => Date.now(),
    backoffsMs = DEFAULT_BACKOFFS_MS,
    maxConsecutiveFailures = DEFAULT_MAX_CONSECUTIVE_FAILURES,
    probeFn = probeListening,
    healthProbeFn = probeSidecarHealth,
    adoptedPollMs = DEFAULT_ADOPTED_POLL_MS,
    adoptedHealthPollMs = DEFAULT_ADOPTED_HEALTH_POLL_MS,
    recycleSidecarFn = defaultRecycleSidecar,
    drainWaitMs = DEFAULT_DRAIN_WAIT_MS,
  } = opts;

  let stopped = false;
  let handle: SidecarHandle | null = null;
  let consecutiveFailures = 0;
  let lastSpawnAt = 0;
  /* code-43-specific streak state — see RESTART43_STREAK_WINDOW_MS above. */
  let restart43Timestamps: number[] = [];
  let restart43Trip: { card: unknown; residentEngines: string[] } | null = null;
  /* True while a watchdog loop is polling an adopted sidecar's port. Guards
     against starting a second loop if the adopt callback fires again before
     the first loop has released. */
  let adoptedWatching = false;
  /* True until the first successful spawn/adopt completes, and again whenever
     a child exits or a drain-wait begins.  Set false once a sidecar is
     confirmed ready (owned child spawned OR healthy sidecar adopted).
     This is the authoritative "not ready" signal for the queue dispatcher —
     do NOT derive it from `handle == null` which is permanently true for
     adopted sidecars throughout their lifetime. */
  let isRecycling = true;

  /* Shared "increment → check cap → log → delay → respawn" tail — used both
     when an owned child EXITS (onChildExit) and when a spawn attempt is
     REFUSED (spawnOnce, below — srv-2037 / #2037). A refusal (a foreign-
     looking listener still on the port, an unidentifiable/unkillable stale
     PID, or the OS-level spawn itself failing) is a failure, not a benign
     no-spawn: it must feed the SAME consecutiveFailures budget an exit does
     (D1 — no new cap, no second unbounded retry loop), so exhaustion still
     surfaces through exhaustedEvent(). Callers must already have set
     handle = null and isRecycling = true before calling this. */
  function scheduleRespawnAttempt(
    attemptLabel: string,
    giveUpLabel: string,
    /* Whether this attempt follows a child that RAN A WHILE before dying — the
       caller's judgement, because only it knows which meaning `lived` has on
       its path. True resets the crash-loop counter (a child that died after a
       healthy life is a fresh incident, not part of the loop). False accretes
       it — a refused respawn is the same foreign process still holding the
       port, so a slow attempt (> QUICK_DEATH_MS) must never be read as a
       long-lived child and silently wipe the budget (#2106 step 2). */
    freshIncident: boolean,
    /* D2 (#2037) — the pid of our own owned child that just exited, if this
       retry chain started from an exit. Threaded through (not stored on the
       supervisor) so it only ever describes the SPECIFIC exit this chain is
       recovering from, and it lapses naturally the moment a fresh spawn
       succeeds — a later, unrelated exit starts its own chain with its own
       pid. Purely a hint for spawnSidecar's log message (D2); it never gates
       recovery, which is this function's own backoff/cap regardless. */
    expectedOwnedPid: number | null = null,
  ): void {
    if (freshIncident) consecutiveFailures = 0;
    consecutiveFailures += 1;
    if (consecutiveFailures > maxConsecutiveFailures) {
      warn(
        `[sidecar] supervisor: ${consecutiveFailures} rapid ${giveUpLabel} in a row — ` +
          `giving up respawn. TTS is DOWN; restart the server to recover.`,
      );
      return;
    }
    const delayMs = backoffsMs[Math.min(consecutiveFailures - 1, backoffsMs.length - 1)];
    log(
      `[sidecar] supervisor: ${attemptLabel}; respawning in ${delayMs}ms ` +
        `(attempt ${consecutiveFailures}/${maxConsecutiveFailures}).`,
    );
    void (async () => {
      await delayFn(delayMs);
      if (stopped) return; // stop() raced during the backoff window.
      try {
        await spawnOnce(expectedOwnedPid);
      } catch (err) {
        warn(`[sidecar] supervisor: respawn failed (${(err as Error).message}).`);
      }
    })();
  }

  async function spawnOnce(expectedOwnedPid: number | null = null): Promise<void> {
    if (stopped) return;
    const base = await buildOpts();
    /* spawnSidecar returns null for six distinct reasons. Two are BENIGN
       no-spawns: autoStart===false, and an already-listening HEALTHY sidecar
       we adopt (which invokes onAdoptExisting first, so the watchdog below
       can respawn an owned child once that process disappears) — for both, a
       fresh sidecar is either unwanted or already ready.
       The other four are REFUSALS (srv-2037 / #2037): a listening process
       that doesn't answer as ours, a stale sidecar whose PID couldn't be
       identified, a killed stale PID whose port is still bound, or the
       OS-level spawn itself failing. Those are failures, not "nothing to
       do" — spawnSidecar fires onSpawnRefused for them so this function can
       retry on the same backoff/cap onChildExit uses, instead of the old
       unconditional `isRecycling = false` that silently declared a
       nonexistent sidecar ready (the #2037 outage). */
    let refusedReason: string | null = null;
    handle = await spawnFn({
      ...base,
      onExit: onChildExit,
      onAdoptExisting: onAdopt,
      /* D2 (#2037) — lets spawnSidecar's not-ours warning tell "our own
         just-exited child, still tearing down" from "a genuinely foreign
         listener" (one extra findPidFn call, log-only). */
      lastOwnedPid: expectedOwnedPid,
      onSpawnRefused: (reason) => {
        refusedReason = reason;
      },
    });
    /* Stamp the spawn time only for successful OWNED spawns (handle !== null).
       This captures the child's actual lifetime later when onChildExit reads it.
       Refusal paths never read this value (they pass false for freshIncident),
       and adoption paths set it when a fresh owned child is spawned after the
       adopted process disappears. */
    if (handle !== null) {
      lastSpawnAt = nowFn();
    }
    if (refusedReason !== null) {
      /* stop() can race in while spawnFn was still in flight (awaited just
         above) — mirrors onChildExit's own stopped guard. Without this, a
         refusal that resolves AFTER shutdown still increments
         consecutiveFailures and logs a "respawning in …ms" line before the
         eventual respawn's own `if (stopped) return;` (further down, inside
         scheduleRespawnAttempt's delayed continuation) bails — i.e. the
         counter/log noise happens even though nothing will ever respawn. */
      if (stopped) return;
      isRecycling = true; // refused — no sidecar exists; keep dispatch held.
      scheduleRespawnAttempt(
        `spawn refused: ${refusedReason}`,
        `spawn refusals (${refusedReason})`,
        /* A refusal is never a fresh incident — it is the same foreign process
           still holding the port. Pass false so the attempt latency of a slow
           spawn (one that outlives QUICK_DEATH_MS, e.g. a hung teardown probe)
           can never masquerade as a long-lived child and reset the budget. */
        false,
        expectedOwnedPid,
      );
      return;
    }
    /* A sidecar is now ready: either an owned child (handle non-null) or a
       healthy adopt (handle null, onAdoptExisting fired).  Either way the
       queue can dispatch.  The autoStart-off null path also lands here — no
       sidecar is wanted, so isRecycling=false is the right signal there too.
       This supervisor IS registered via registerActiveSupervisor regardless
       of autoStart (index.ts calls start() then registerActiveSupervisor()
       unconditionally; only enforceSingleSidecarOwner is autoStart-gated) —
       so queue.ts:60 reads this flag straight off the real, active
       supervisor, not via some autoStart-off short-circuit. */
    isRecycling = false;
  }

  /* Watch an adopted (already-listening, not-owned) sidecar on two axes:
       1. DISAPPEARANCE (cheap TCP probe each tick) — e.g. the committed-memory
          soft-recycle self-exit (code 43); and
       2. FITNESS (a slower /health poll) — recycle_pending, or committed memory
          over the adopt ceiling. The 2026-06-02 "stuck after restart" left a
          fresh server bolted onto a leak-saturated adopted orphan that never
          EXITED, so a disappearance-only watch never replaced it.
     Either trigger brings up a fresh OWNED child via spawnOnce — whose
     spawnSidecar adopt-gate kills the unfit process and spawns clean, then
     re-establishes full onExit supervision (or re-arms this watch if it adopts
     a now-fit process). */
  function onAdopt(info: { host: string; port: number }): void {
    if (stopped || adoptedWatching) return;
    adoptedWatching = true;
    log(
      `[sidecar] supervisor: watching adopted sidecar on :${info.port} ` +
        `(not our child) — will respawn an owned process if it exits or becomes unfit.`,
    );
    void (async () => {
      const respawn = async (why: string): Promise<void> => {
        isRecycling = true; // adopted sidecar gone — hold dispatch until replacement is ready.
        /* Release the flag BEFORE respawning so a re-adopt inside spawnOnce can
           arm a fresh watch. */
        adoptedWatching = false;
        warn(`[sidecar] supervisor: adopted sidecar on :${info.port} ${why} — respawning a supervised child.`);
        try {
          await spawnOnce();
        } catch (err) {
          warn(`[sidecar] supervisor: respawn after adopted ${why} failed (${(err as Error).message}).`);
        }
      };
      /* Fitness-triggered replace: ask the sidecar to drain first via POST
         /recycle, poll until the port frees (self-exit), then bring up a
         replacement.  If drain fails or the port never frees within drainWaitMs,
         fall through to the hard-kill respawn so we never stall indefinitely. */
      const drainThenRespawn = async (why: string): Promise<void> => {
        isRecycling = true; // draining in-flight synth — hold dispatch until replacement is ready.
        warn(`[sidecar] supervisor: adopted sidecar on :${info.port} ${why} — requesting graceful drain before replacing.`);
        let drained = false;
        try {
          drained = await recycleSidecarFn(info.host, info.port);
        } catch (err) {
          warn(`[sidecar] graceful recycle threw (${(err as Error).message}) — hard-replacing.`);
        }
        if (drained) {
          /* Poll until the port frees (sidecar self-exited after drain) or the
             drain budget is exhausted. */
          let waited = 0;
          while (waited < drainWaitMs) {
            await delayFn(adoptedPollMs);
            waited += adoptedPollMs;
            if (!(await probeFn(info.host, info.port))) break; // port freed
          }
        }
        await respawn(why);
      };
      let sinceHealthMs = 0;
      while (!stopped) {
        await delayFn(adoptedPollMs);
        if (stopped) break;
        if (!(await probeFn(info.host, info.port))) {
          await respawn('disappeared (likely a self-recycle)');
          return;
        }
        sinceHealthMs += adoptedPollMs;
        if (sinceHealthMs < adoptedHealthPollMs) continue;
        sinceHealthMs = 0;
        const health = await healthProbeFn(info.host, info.port);
        if (!health.reachable || !health.looksLikeSidecar) continue; // transient /health miss — let TCP own liveness
        const ceiling = adoptCommittedCeilingMb();
        const overCeiling =
          ceiling > 0 && health.committedMb !== null && health.committedMb >= ceiling;
        if (health.recyclePending || overCeiling) {
          await drainThenRespawn(
            health.recyclePending
              ? 'reports recycle_pending'
              : `is leak-saturated (committed ${Math.round(health.committedMb ?? 0)}MB ≥ ${ceiling}MB)`,
          );
          return;
        }
      }
      adoptedWatching = false;
    })();
  }

  function onChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    /* D2 (#2037) — capture the exiting child's own pid before `handle` is
       nulled below, so the next spawn attempt can tell spawnSidecar "this is
       the pid you should expect to still see tearing down :port" (log-only,
       see spawnOnce/scheduleRespawnAttempt). */
    const exitedPid = handle?.pid ?? null;
    if (stopped) return; // we killed it on purpose (shutdown) — don't resurrect.
    if (restart43Trip !== null) {
      // Already tripped — hold TTS down. Ignore any further exit (nothing
      // should be running to exit, but a belt-and-suspenders guard here means
      // even a stray callback can never sneak in another respawn attempt).
      handle = null;
      isRecycling = true;
      return;
    }
    if (code === 43) {
      const now = nowFn();
      restart43Timestamps = restart43Timestamps.filter((t) => now - t <= RESTART43_STREAK_WINDOW_MS);
      restart43Timestamps.push(now);
      if (restart43Timestamps.length >= RESTART43_STREAK_TRIP_COUNT) {
        const breadcrumb = readRestartBreadcrumb();
        restart43Trip = { card: breadcrumb?.card ?? null, residentEngines: breadcrumb?.residentEngines ?? [] };
        handle = null;
        isRecycling = true;
        warn(
          `[sidecar] supervisor: ${restart43Timestamps.length} code-43 self-exits in ` +
            `${RESTART43_STREAK_WINDOW_MS / 60_000} minutes (card=${JSON.stringify(restart43Trip.card)}) — ` +
            `this device assignment looks structurally too small. Holding TTS down (no further ` +
            `respawn attempts) until the assignment changes and the server restarts.`,
        );
        return; // hold TTS down — no respawn.
      }
    }
    handle = null;
    isRecycling = true; // sidecar gone — hold dispatch until the respawn completes.
    /* EXIT path: lastSpawnAt was set when the handle was created in spawnOnce(),
       after spawnFn successfully returned, so `lived` here is child lifetime only
       (not attempt latency) — the only place QUICK_DEATH_MS still means that. A
       child that ran a while and then died is a fresh incident and resets the
       crash-loop counter; one that dies fast is part of the loop. */
    const freshIncident = nowFn() - lastSpawnAt >= QUICK_DEATH_MS;
    scheduleRespawnAttempt(
      `child exited (code=${code} signal=${signal})`,
      `sidecar exits (last code=${code} signal=${signal})`,
      freshIncident,
      exitedPid,
    );
  }

  function resetAndRespawn(): Promise<void> {
    restart43Trip = null;
    restart43Timestamps = [];
    consecutiveFailures = 0;
    return spawnOnce();
  }

  return {
    async start() {
      stopped = false;
      consecutiveFailures = 0;
      await spawnOnce();
    },
    async stop() {
      stopped = true;
      isRecycling = true; /* Signal to the queue dispatcher that no sidecar is
                             currently ready. This must be set BEFORE kill()
                             so the queue pauses immediately. */
      const h = handle;
      handle = null;
      await h?.kill();
    },
    current() {
      return handle;
    },
    recycling() {
      return isRecycling;
    },
    tripEvent() {
      return restart43Trip;
    },
    exhaustedEvent() {
      return consecutiveFailures > maxConsecutiveFailures;
    },
    resetAndRespawn,
  };
}
