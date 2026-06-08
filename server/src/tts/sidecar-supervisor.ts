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

/* A child that dies faster than this counts toward the crash-loop cap; one
   that lived longer is treated as a fresh incident and resets the counter, so
   a sidecar that runs fine for an hour and then dies once still gets respawned
   even if an earlier boot had flaked. */
const QUICK_DEATH_MS = 30_000;
const DEFAULT_BACKOFFS_MS = [2_000, 5_000, 15_000];
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;
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
  } = opts;

  let stopped = false;
  let handle: SidecarHandle | null = null;
  let consecutiveFailures = 0;
  let lastSpawnAt = 0;
  /* True while a watchdog loop is polling an adopted sidecar's port. Guards
     against starting a second loop if the adopt callback fires again before
     the first loop has released. */
  let adoptedWatching = false;

  async function spawnOnce(): Promise<void> {
    if (stopped) return;
    lastSpawnAt = nowFn();
    const base = await buildOpts();
    /* spawnSidecar returns null for benign no-spawn (autoStart off, a spawn
       error, or an already-listening healthy sidecar we adopt). For the adopt
       case it invokes onAdoptExisting first, so the watchdog below can respawn
       an owned child once that process disappears; the other null paths fire no
       callback and leave supervision dormant — matching the pre-supervisor
       contract (don't resurrect a disabled or deliberately-untouched sidecar). */
    handle = await spawnFn({ ...base, onExit: onChildExit, onAdoptExisting: onAdopt });
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
          await respawn(
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
    if (stopped) return; // we killed it on purpose (shutdown) — don't resurrect.
    handle = null;
    const lived = nowFn() - lastSpawnAt;
    if (lived >= QUICK_DEATH_MS) consecutiveFailures = 0; // ran a while → fresh incident.
    consecutiveFailures += 1;
    if (consecutiveFailures > maxConsecutiveFailures) {
      warn(
        `[sidecar] supervisor: ${consecutiveFailures} rapid sidecar exits in a row ` +
          `(last code=${code} signal=${signal}) — giving up respawn. TTS is DOWN; ` +
          `restart the server to recover.`,
      );
      return;
    }
    const delayMs = backoffsMs[Math.min(consecutiveFailures - 1, backoffsMs.length - 1)];
    log(
      `[sidecar] supervisor: child exited (code=${code} signal=${signal}); ` +
        `respawning in ${delayMs}ms (attempt ${consecutiveFailures}/${maxConsecutiveFailures}).`,
    );
    void (async () => {
      await delayFn(delayMs);
      if (stopped) return; // stop() raced during the backoff window.
      try {
        await spawnOnce();
      } catch (err) {
        warn(`[sidecar] supervisor: respawn failed (${(err as Error).message}).`);
      }
    })();
  }

  return {
    async start() {
      stopped = false;
      consecutiveFailures = 0;
      await spawnOnce();
    },
    async stop() {
      stopped = true;
      const h = handle;
      handle = null;
      await h?.kill();
    },
    current() {
      return handle;
    },
  };
}
